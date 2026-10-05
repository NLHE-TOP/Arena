/**
 * Focused acceptance-pacing regressions.
 *
 * The human seat driver must sweep at a human-plausible cadence, bound 429
 * retries with the server's advised delay, never retry earlier than advised,
 * keep one stable action identity across a 429 retry, re-check the
 * authoritative turn before resubmitting, and never swallow auth/429 failures
 * while still tolerating documented terminal races. The independent platform
 * /metrics 429 reader is covered too, because the SDK retries 429s internally
 * and a driver counter alone cannot prove zero.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SeatObservation } from '@pokertools/types';
import {
  driveHumanSeats,
  parseRetryAfterMs,
  HumanRateLimitError,
  HUMAN_DRIVER_PACING,
  type HumanDriverStats,
} from '../integration/acceptance/product-room.js';
import { installPlatformTrace } from '../integration/infra/trace-platform.js';
import { parseRetryAfterHeader, ProductClient } from '../integration/acceptance/product-client.js';
import { readPlatform429Total } from '../integration/acceptance/platform-metrics.js';
import type { WalletSession } from '../integration/infra/wallet.js';
import { seatObservationFixture } from './fixtures.js';

interface FakeActionRequest {
  requestId: string;
  turnId: string;
  expectedVersion: number;
  actionId: string;
  amount?: number;
}

function rateLimitError(options: { retryAfterMs?: number; message?: string } = {}): Error {
  const error = new Error(options.message ?? 'Rate limit exceeded, retry in 1 second');
  return Object.assign(error, {
    statusCode: 429,
    code: 'RATE_LIMIT_EXCEEDED',
    ...(options.retryAfterMs !== undefined ? { details: { retryAfterMs: options.retryAfterMs } } : {}),
  });
}

function fakeHuman(client: { getObservation: () => Promise<SeatObservation>; action: (request: FakeActionRequest) => Promise<unknown> }): WalletSession {
  return { client: { getObservation: (_tableId: string) => client.getObservation(), action: (_tableId: string, request: FakeActionRequest) => client.action(request) } } as unknown as WalletSession;
}

const EMPTY_HUMAN = seatObservationFixture({ legalActions: [] });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('human seat driver pacing', () => {
  it('keeps the acceptance default sweep cadence at 2.5s for one human', () => {
    expect(HUMAN_DRIVER_PACING).toEqual({
      pollIntervalMs: 2_500,
      actionDelayMs: 200,
      rateLimitMaxRetries: 3,
      rateLimitMaxDelayMs: 15_000,
    });
  });

  it('paces idle sweeps instead of busy-polling observations', async () => {
    const pollIntervalMs = 120;
    let observations = 0;
    let terminal = false;
    const session = fakeHuman({
      getObservation: async () => {
        observations += 1;
        if (observations >= 2) terminal = true;
        return EMPTY_HUMAN;
      },
      action: async () => {
        throw new Error('no action may be submitted for an empty legal menu');
      },
    });
    const startedAt = Date.now();
    const stats = await driveHumanSeats({
      humans: [session],
      tableId: 'table-1',
      isTerminal: () => terminal,
      pacing: { pollIntervalMs },
    });
    const elapsed = Date.now() - startedAt;
    expect(stats.observations).toBe(2);
    expect(stats.actions).toBe(0);
    // One paced idle wait between the two sweeps, never the old 100ms loop.
    expect(elapsed).toBeGreaterThanOrEqual(pollIntervalMs - 10);
  });

  it('pauses a plausible think time before submitting an issued action', async () => {
    const actionDelayMs = 120;
    let actions = 0;
    let terminal = false;
    const session = fakeHuman({
      getObservation: async () => seatObservationFixture(),
      action: async () => {
        actions += 1;
        terminal = true;
        return {};
      },
    });
    const startedAt = Date.now();
    const stats = await driveHumanSeats({
      humans: [session],
      tableId: 'table-1',
      isTerminal: () => terminal,
      pacing: { actionDelayMs, pollIntervalMs: 5 },
    });
    expect(stats.actions).toBe(1);
    expect(actions).toBe(1);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(actionDelayMs - 10);
  });

  it('enforces the cadence after rapid successful actions (no active busy loop)', async () => {
    const pollIntervalMs = 80;
    const observationTimes: number[] = [];
    let terminal = false;
    let actions = 0;
    const session = fakeHuman({
      getObservation: async () => {
        observationTimes.push(Date.now());
        return seatObservationFixture();
      },
      action: async () => {
        actions += 1;
        if (actions >= 3) terminal = true;
        return {};
      },
    });
    const startedAt = Date.now();
    const stats = await driveHumanSeats({
      humans: [session],
      tableId: 'table-1',
      isTerminal: () => terminal,
      pacing: { actionDelayMs: 0, pollIntervalMs },
    });
    expect(stats.observations).toBe(3);
    expect(stats.actions).toBe(3);
    // Two full cadence windows between the three successful sweeps; before the
    // sweep cadence the loop re-observed/re-acted as fast as the SDK answered.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(2 * pollIntervalMs - 15);
    for (let index = 1; index < observationTimes.length; index += 1) {
      expect(observationTimes[index]! - observationTimes[index - 1]!).toBeGreaterThanOrEqual(
        pollIntervalMs - 15
      );
    }
  });
});

describe('human seat driver bounded 429 backoff', () => {
  it('retries the identical action request after the advised wait and re-checks the turn', async () => {
    const requests: FakeActionRequest[] = [];
    let terminal = false;
    const session = fakeHuman({
      getObservation: async () => seatObservationFixture(),
      action: async (request) => {
        requests.push(request);
        if (requests.length === 1) throw rateLimitError({ retryAfterMs: 60 });
        terminal = true;
        return {};
      },
    });
    const stats = await driveHumanSeats({
      humans: [session],
      tableId: 'table-1',
      isTerminal: () => terminal,
      pacing: { actionDelayMs: 0, pollIntervalMs: 5, rateLimitMaxDelayMs: 5_000 },
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]!.requestId).toBe(requests[0]!.requestId);
    expect(requests[1]!.actionId).toBe(requests[0]!.actionId);
    expect(requests[1]!.turnId).toBe(requests[0]!.turnId);
    expect(stats.actions).toBe(1);
    expect(stats.rateLimitResponses).toBe(1);
    expect(stats.rateLimitRetries).toBe(1);
  });

  it('fails explicitly when the advised wait exceeds the bound, never retrying early', async () => {
    let actionCalls = 0;
    let terminal = false;
    const session = fakeHuman({
      getObservation: async () => seatObservationFixture(),
      action: async () => {
        actionCalls += 1;
        throw rateLimitError({ retryAfterMs: 60_000 });
      },
    });
    let caught: unknown = null;
    try {
      await driveHumanSeats({
        humans: [session],
        tableId: 'table-1',
        isTerminal: () => terminal,
        pacing: { actionDelayMs: 0, pollIntervalMs: 5, rateLimitMaxDelayMs: 50 },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HumanRateLimitError);
    expect((caught as Error).message).toMatch(/above the 50ms bound/);
    // The action was attempted exactly once: no early retry below the advice.
    expect(actionCalls).toBe(1);
    terminal = true;
  });

  it('reports a superseded action instead of resubmitting when the turn moved on', async () => {
    const requests: FakeActionRequest[] = [];
    let rechecks = 0;
    let terminal = false;
    const session = fakeHuman({
      getObservation: async () => {
        rechecks += 1;
        return rechecks === 1 ? seatObservationFixture() : seatObservationFixture({ version: 999 });
      },
      action: async (request) => {
        requests.push(request);
        throw rateLimitError({ retryAfterMs: 10 });
      },
    });
    const stats: HumanDriverStats = await driveHumanSeats({
      humans: [session],
      tableId: 'table-1',
      isTerminal: () => terminal || rechecks > 1,
      pacing: { actionDelayMs: 0, pollIntervalMs: 5, rateLimitMaxDelayMs: 1_000 },
    });
    expect(requests).toHaveLength(1);
    expect(stats.actions).toBe(0);
    expect(stats.rateLimitResponses).toBe(1);
    expect(stats.rateLimitRetries).toBe(1);
    terminal = true;
  });

  it('exhausts the bounded retry budget as a visible failure', async () => {
    let actionCalls = 0;
    let terminal = false;
    const session = fakeHuman({
      getObservation: async () => seatObservationFixture(),
      action: async () => {
        actionCalls += 1;
        throw rateLimitError({ retryAfterMs: 5 });
      },
    });
    let caught: unknown = null;
    try {
      await driveHumanSeats({
        humans: [session],
        tableId: 'table-1',
        isTerminal: () => terminal,
        pacing: { actionDelayMs: 0, pollIntervalMs: 5, rateLimitMaxRetries: 2, rateLimitMaxDelayMs: 100 },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HumanRateLimitError);
    expect(actionCalls).toBe(3);
    terminal = true;
  });

  it('includes the traced endpoint label in a bounded 429 failure without ids', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('', { status: 429 });
    const trace = installPlatformTrace();
    try {
      await fetch('http://127.0.0.1:1234/tables/cmutrsghu000501mkesarswy2/action', { method: 'POST' });
      let caught: unknown = null;
      const session = fakeHuman({
        getObservation: async () => seatObservationFixture(),
        action: async () => {
          throw rateLimitError({ retryAfterMs: 60_000 });
        },
      });
      try {
        await driveHumanSeats({
          humans: [session],
          tableId: 'table-1',
          isTerminal: () => false,
          pacing: { actionDelayMs: 0, pollIntervalMs: 5, rateLimitMaxDelayMs: 50 },
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(HumanRateLimitError);
      const message = (caught as Error).message;
      expect(message).toContain('above the 50ms bound');
      expect(message).toContain('POST /tables/:id/action');
      expect(message).not.toContain('cmutrsghu000501mkesarswy2');
    } finally {
      trace.restore();
      globalThis.fetch = originalFetch;
    }
  });
});

describe('human seat driver race handling', () => {
  it('tolerates a terminal 404 observation race', async () => {
    let terminal = false;
    const session = fakeHuman({
      getObservation: async () => {
        terminal = true;
        const error = new Error('Not Found');
        throw Object.assign(error, { statusCode: 404, code: 'NOT_FOUND' });
      },
      action: async () => {
        throw new Error('no action may be submitted');
      },
    });
    const stats = await driveHumanSeats({
      humans: [session],
      tableId: 'table-1',
      isTerminal: () => terminal,
      pacing: { actionDelayMs: 0, pollIntervalMs: 5 },
    });
    expect(stats.observations).toBe(0);
  });

  it('never swallows an auth failure', async () => {
    const session = fakeHuman({
      getObservation: async () => {
        const error = new Error('Unauthorized');
        throw Object.assign(error, { statusCode: 401, code: 'UNAUTHORIZED' });
      },
      action: async () => ({}) as never,
    });
    await expect(
      driveHumanSeats({
        humans: [session],
        tableId: 'table-1',
        isTerminal: () => false,
        pacing: { actionDelayMs: 0, pollIntervalMs: 5 },
      })
    ).rejects.toMatchObject({ statusCode: 401 });
  });
});

describe('server-advised 429 delay parsing', () => {
  it('reads milliseconds and seconds fields distinctly', () => {
    expect(parseRetryAfterMs({ statusCode: 429, details: { retryAfterMs: 20 } })).toBe(20);
    expect(parseRetryAfterMs({ statusCode: 429, details: { retryAfter: 2 } })).toBe(2_000);
    expect(parseRetryAfterMs({ statusCode: 429, details: { retryAfter: '3' } })).toBe(3_000);
  });

  it('parses the platform limiter message', () => {
    expect(parseRetryAfterMs({ statusCode: 429, message: 'Rate limit exceeded, retry in 1 minute' })).toBe(60_000);
    expect(parseRetryAfterMs({ statusCode: 429, message: 'Rate limit exceeded, retry in 30 seconds' })).toBe(30_000);
    expect(parseRetryAfterMs({ statusCode: 429, message: 'too many requests' })).toBeNull();
    expect(parseRetryAfterMs(new Error('plain'))).toBeNull();
  });

  it('parses HTTP retry-after headers in seconds and date form', () => {
    expect(parseRetryAfterHeader('7')).toBe(7_000);
    expect(parseRetryAfterHeader(null)).toBeNull();
    expect(parseRetryAfterHeader('soon')).toBeNull();
    const date = new Date(Date.now() + 5_000).toUTCString();
    const parsed = parseRetryAfterHeader(date);
    expect(parsed).not.toBeNull();
    expect(parsed!).toBeGreaterThan(3_000);
    expect(parsed!).toBeLessThanOrEqual(6_000);
  });
});

describe('ProductClient 429 metadata', () => {
  it('surfaces status and retry-after on the acceptance error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ error: 'INTERNAL_ERROR', message: 'Rate limit exceeded, retry in 1 minute' }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '9' },
        })
      )
    );
    const client = new ProductClient('http://product.test');
    await expect(client.getRoom('room-1')).rejects.toMatchObject({ status: 429, retryAfterMs: 9_000 });
  });
});

describe('independent platform /metrics 429 counter', () => {
  const metrics = [
    '# HELP pokertools_http_requests_total HTTP requests observed by the API',
    'pokertools_http_requests_total 0',
    'pokertools_http_requests_total{method="GET",route="/tables/:id/observation",status="200"} 96',
    'pokertools_http_requests_total{method="GET",route="/tables/:id/observation",status="429"} 51',
    'pokertools_http_requests_total{method="POST",route="/tables/:id/action",status="429"} 6',
    '',
  ].join('\n');

  it('sums only status="429" counters', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(metrics, { status: 200 })));
    await expect(readPlatform429Total({ url: 'http://platform.test' })).resolves.toBe(57);
  });

  it('fails when metrics are unavailable or lack the counter family', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })));
    await expect(readPlatform429Total({ url: 'http://platform.test' })).rejects.toThrow(/HTTP 401/);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('# nothing here\n', { status: 200 })));
    await expect(readPlatform429Total({ url: 'http://platform.test' })).rejects.toThrow(/did not expose/);
  });
});
