/**
 * Focused safety/contract regressions for the acceptance HTTP trace.
 *
 * The trace must never carry headers, bodies, query strings, userinfo or raw
 * unknown paths; only loopback API/product routes are recorded, with provider
 * completions, JSON-RPC and every non-loopback URL ignored. The latest 429
 * endpoint label feeds rate-limit backoff errors without leaking identifiers.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PLATFORM_TRACE_ARTIFACT,
  classifyTraceUrl,
  formatTraceContext,
  installPlatformTrace,
  normalizeTraceRoute,
  rateLimitContextLabel,
  type PlatformTraceHandle,
} from '../integration/infra/trace-platform.js';

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

async function withTrace(
  baseFetch: typeof fetch,
  run: (handle: PlatformTraceHandle) => Promise<void> | void
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = baseFetch;
  const trace = installPlatformTrace();
  try {
    await run(trace);
  } finally {
    trace.restore();
    globalThis.fetch = original;
  }
}

const UUID = '5f7ad1a2-3c4b-4e5d-8f90-0123456789ab';
const TABLE_ID = 'cmutrsghu000501mkesarswy2';

describe('route normalization', () => {
  it('labels canonical routes and never emits raw segments', () => {
    expect(normalizeTraceRoute(new URL(`http://127.0.0.1:1/tables/${TABLE_ID}/observation`))).toBe(
      '/tables/:id/observation'
    );
    expect(normalizeTraceRoute(new URL(`http://127.0.0.1:1/api/rooms/${UUID}`))).toBe('/api/rooms/:id');
    expect(normalizeTraceRoute(new URL(`http://127.0.0.1:1/api/rooms/${UUID}/join`))).toBe(
      '/api/rooms/:id/join'
    );
    expect(normalizeTraceRoute(new URL('http://127.0.0.1:1/v1/tables/anything/action'))).toBe(
      '/tables/:id/action'
    );
    expect(normalizeTraceRoute(new URL('http://127.0.0.1:1/webhooks/sekret-path'))).toBe('unrecognized');
    expect(normalizeTraceRoute(new URL('http://127.0.0.1:1/webhooks/sekret-path'))).not.toContain('sekret');
  });

  it('traces only loopback API/product routes; ignores provider, RPC and non-loopback', () => {
    expect(classifyTraceUrl(new URL('https://openrouter.ai/api/v1/chat/completions'))).toBeNull();
    expect(classifyTraceUrl(new URL('http://127.0.0.1:9/v1/chat/completions'))).toBeNull();
    expect(classifyTraceUrl(new URL('http://127.0.0.1:8545/'))).toBeNull();
    expect(classifyTraceUrl(new URL('http://127.0.0.1:8545/rpc'))).toBeNull();
    expect(classifyTraceUrl(new URL('https://example.com/api/rooms/x'))).toBeNull();
    expect(classifyTraceUrl(new URL('http://127.0.0.1:9/api/rooms'))).toBe('/api/rooms');
  });
});

describe('installer safety', () => {
  it('never records headers, query, userinfo, bodies or unknown paths', async () => {
    await withTrace(
      async () => new Response('', { status: 429, headers: { 'retry-after': '44' } }),
      async (trace) => {
        await fetch(`http://user:sekret@127.0.0.1:1234/api/rooms/${UUID}?token=sekret&x=1`, {
          method: 'POST',
          headers: { authorization: 'Bearer top-sekret' },
          body: JSON.stringify({ secret: 'body-sekret' }),
        });
        await fetch('http://127.0.0.1:1234/hook/sekret-path?key=sekret', { method: 'GET' });
        expect(trace.entries).toHaveLength(2);
        expect(trace.entries[0]).toEqual({
          at: expect.any(Number),
          method: 'POST',
          origin: 'http://127.0.0.1:1234',
          route: '/api/rooms/:id',
          status: 429,
          durationMs: expect.any(Number),
        });
        expect(trace.entries[1]!.route).toBe('unrecognized');
        const serialized = JSON.stringify(trace.entries);
        for (const forbidden of ['sekret', 'authorization', 'token', 'retry-after', 'body-sekret']) {
          expect(serialized).not.toContain(forbidden);
        }
      }
    );
  });

  it('records methods only from the closed verb set', async () => {
    await withTrace(
      async () => new Response('', { status: 200 }),
      async (trace) => {
        await fetch('http://127.0.0.1:9/api/rooms');
        await fetch('http://127.0.0.1:9/api/rooms', { method: 'post' });
        await fetch(new Request('http://127.0.0.1:9/api/rooms', { method: 'DELETE' }));
        await fetch('http://127.0.0.1:9/api/rooms', { method: 'WEIRD-SECRET-VERB' });
        expect(trace.entries.map((entry) => entry.method)).toEqual(['GET', 'POST', 'DELETE', 'OTHER']);
      }
    );
  });

  it('records a rejected request as status 0 and refuses nested installation', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error('network down');
    };
    const trace = installPlatformTrace();
    try {
      expect(() => installPlatformTrace()).toThrow(/already installed/);
      await expect(fetch('http://127.0.0.1:9/api/rooms')).rejects.toThrow(/network down/);
      expect(trace.entries).toHaveLength(1);
      expect(trace.entries[0]!.status).toBe(0);
      trace.restore();
      trace.restore();
      expect(rateLimitContextLabel()).toBeNull();
    } finally {
      globalThis.fetch = original;
    }
  });

  it('writes a mode-0600 JSONL artifact with only the safe fields', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nlhe-trace-test-'));
    try {
      await withTrace(
        async () => new Response('', { status: 200 }),
        async (trace) => {
          await fetch('http://127.0.0.1:9/api/config');
          const path = join(directory, PLATFORM_TRACE_ARTIFACT);
          trace.writeJsonl(path);
          const lines = readFileSync(path, 'utf8').trim().split('\n');
          expect(lines).toHaveLength(1);
          const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
          expect(Object.keys(parsed).sort()).toEqual(['at', 'durationMs', 'method', 'origin', 'route', 'status']);
          expect(parsed.route).toBe('/api/config');
          expect(statSync(path).mode & 0o777).toBe(0o600);
        }
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('429 endpoint context', () => {
  it('exposes the latest 429 label for backoff errors without leaking ids', async () => {
    await withTrace(
      async () => new Response('', { status: 429 }),
      async (trace) => {
        expect(rateLimitContextLabel()).toBeNull();
        await fetch(`http://127.0.0.1:9/tables/${TABLE_ID}/action`, { method: 'POST' });
        const label = rateLimitContextLabel();
        expect(label).toContain('POST /tables/:id/action');
        expect(label).toContain('http://127.0.0.1:9');
        expect(label).not.toContain(TABLE_ID);
        expect(formatTraceContext(trace.entries[0]!)).toBe(label);
        trace.restore();
        expect(rateLimitContextLabel()).toBeNull();
      }
    );
  });
});
