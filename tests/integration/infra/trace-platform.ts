/**
 * Safe acceptance HTTP trace for harness/human-SDK calls.
 *
 * A global `fetch` wrapper records ONLY: timestamp, method (from a closed
 * verb set), URL origin, a normalized route label, response status and request
 * duration. Headers, bodies, query strings, userinfo, cookies, tokens and any
 * other private payload are never read or written. Non-loopback URLs, provider
 * chat-completion calls and JSON-RPC are ignored; an unknown loopback route is
 * recorded as `unrecognized` WITHOUT its path, so a token that ever appeared in
 * a path can never reach an artifact.
 *
 * The trace exists for diagnosing acceptance 429 sources (which endpoint and
 * when) and for putting the precise endpoint label into rate-limit backoff
 * errors. It never changes retry policy, bounds or pacing.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Host trace artifact name inside the run's artifact directory. */
export const PLATFORM_TRACE_ARTIFACT = 'platform-trace.jsonl';

/** One safe trace line. Every field is a fixed-shape primitive. */
export interface PlatformTraceEntry {
  at: number;
  method: string;
  /** Scheme + host + port only; `URL.origin` never includes userinfo. */
  origin: string;
  /** Known route label (`/tables/:id/action`) or `unrecognized`. */
  route: string;
  status: number;
  durationMs: number;
}

export interface PlatformTraceInstallOptions {
  /** Clock override for focused tests. */
  now?: () => number;
  /** Classifier override for focused tests; null skips the request. */
  classifyRoute?: (url: URL) => string | null;
}

export interface PlatformTraceHandle {
  readonly entries: readonly PlatformTraceEntry[];
  renderJsonl(): string;
  /** Persist the trace (mode 0600). Callers write it even on failure. */
  writeJsonl(path: string): void;
  /** Restore the previous global fetch; safe to call more than once. */
  restore(): void;
}

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

/**
 * Known canonical API routes. `:id` matches exactly one opaque segment; the
 * template label (never the segment) is what the trace records.
 */
const ROUTE_TEMPLATES: readonly (readonly string[])[] = [
  // Product API
  ['api', 'config'],
  ['api', 'agents'],
  ['api', 'rooms'],
  ['api', 'rooms', ':id'],
  ['api', 'rooms', ':id', 'join'],
  ['api', 'rooms', ':id', 'start'],
  ['api', 'rooms', ':id', 'cancel'],
  ['api', 'stats'],
  ['api', 'audit', 'rooms', ':id'],
  // Platform API
  ['health'],
  ['ready'],
  ['metrics'],
  ['auth', 'nonce'],
  ['auth', 'login'],
  ['auth', 'verify'],
  ['auth', 'me'],
  ['auth', 'logout'],
  ['tables'],
  ['tables', ':id'],
  ['tables', ':id', 'observation'],
  ['tables', ':id', 'action'],
  ['tables', ':id', 'chat'],
  ['tables', ':id', 'replay'],
  ['tables', ':id', 'buy-in'],
  ['tournaments'],
  ['tournaments', ':id'],
  ['competitions'],
  ['competitions', ':id'],
  ['competitions', ':id', 'opt-in'],
  ['competitions', ':id', 'start'],
  ['competitions', ':id', 'agent-credentials'],
  ['finance', 'balances'],
  ['finance', 'deposits', 'claim'],
  ['chips', 'grant'],
  ['notes'],
];

function isLoopbackHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1';
}

/** Provider/RPC paths that are never part of the traced acceptance surface. */
function isIgnoredPath(pathname: string): boolean {
  if (pathname === '' || pathname === '/') return true; // Anvil/JSON-RPC root
  if (/\/rpc\/?$/.test(pathname)) return true;
  if (/\/(?:v1\/)?(?:chat\/completions|completions|embeddings)\/?$/.test(pathname)) return true;
  return false;
}

function matchTemplate(segments: readonly string[]): readonly string[] | null {
  for (const template of ROUTE_TEMPLATES) {
    if (template.length !== segments.length) continue;
    let matched = true;
    for (let index = 0; index < template.length; index += 1) {
      const expected = template[index]!;
      if (expected === ':id') {
        if (segments[index] === undefined || segments[index] === '') {
          matched = false;
          break;
        }
        continue;
      }
      if (expected !== segments[index]) {
        matched = false;
        break;
      }
    }
    if (matched) return template;
  }
  return null;
}

/**
 * Normalize a pathname to a known route label. Returns `unrecognized` (never
 * the raw path) when no canonical template matches. An optional `v1` prefix is
 * accepted for platform routes.
 */
export function normalizeTraceRoute(url: URL): string {
  const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
  const candidates: Array<readonly string[]> =
    segments[0] === 'v1' ? [segments, segments.slice(1)] : [segments];
  for (const candidate of candidates) {
    const template = matchTemplate(candidate);
    if (template !== null) return `/${template.join('/')}`;
  }
  return 'unrecognized';
}

/**
 * Full skip/route classification: only loopback API/product routes are traced;
 * provider completions, RPC and every non-loopback URL return null.
 */
export function classifyTraceUrl(url: URL): string | null {
  if (!isLoopbackHost(url.hostname)) return null;
  if (isIgnoredPath(url.pathname)) return null;
  return normalizeTraceRoute(url);
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  const raw =
    init?.method ??
    (typeof input === 'object' && input !== null && 'method' in input
      ? (input as Request).method
      : undefined) ??
    'GET';
  const upper = String(raw).toUpperCase();
  return ALLOWED_METHODS.has(upper) ? upper : 'OTHER';
}

function requestUrl(input: RequestInfo | URL): URL | null {
  try {
    if (typeof input === 'string') return new URL(input);
    if (input instanceof URL) return input;
    return new URL(input.url);
  } catch {
    return null;
  }
}

/** Endpoint-only rendering used inside rate-limit errors (no headers/query). */
export function formatTraceContext(entry: PlatformTraceEntry): string {
  return `${entry.method} ${entry.route} @ ${entry.origin} (${entry.durationMs}ms)`;
}

let activeEntries: PlatformTraceEntry[] | null = null;
let activeState: { base: typeof globalThis.fetch; wrapped: typeof globalThis.fetch } | null = null;

/**
 * Most recent observed 429 endpoint label, or null when no trace is installed
 * or no 429 was observed. Safe to call from error builders.
 */
export function rateLimitContextLabel(): string | null {
  const entries = activeEntries;
  if (entries === null) return null;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.status === 429) return formatTraceContext(entry);
  }
  return null;
}

/**
 * Install the global fetch wrapper. Must be called BEFORE topology bootstrap
 * and restored in a finally block; the handle survives failures so the trace
 * can always be written before teardown.
 */
export function installPlatformTrace(options: PlatformTraceInstallOptions = {}): PlatformTraceHandle {
  if (activeState !== null) throw new Error('platform trace is already installed');
  const entries: PlatformTraceEntry[] = [];
  const now = options.now ?? (() => Date.now());
  const classify = options.classifyRoute ?? classifyTraceUrl;
  const base = globalThis.fetch;

  const record = (url: URL, method: string, status: number, startedAt: number): void => {
    try {
      const route = classify(url);
      if (route === null) return;
      entries.push({
        at: startedAt,
        method,
        origin: url.origin,
        route,
        status,
        durationMs: Math.max(0, now() - startedAt),
      });
    } catch {
      // Tracing must never affect the request path.
    }
  };

  const wrapped: typeof globalThis.fetch = async (input, init) => {
    const startedAt = now();
    const url = requestUrl(input);
    const method = requestMethod(input, init);
    let response: Response;
    try {
      response = await base(input, init);
    } catch (error) {
      if (url !== null) record(url, method, 0, startedAt);
      throw error;
    }
    if (url !== null) record(url, method, response.status, startedAt);
    return response;
  };

  globalThis.fetch = wrapped;
  activeEntries = entries;
  activeState = { base, wrapped };

  const handle: PlatformTraceHandle = {
    get entries() {
      return entries;
    },
    renderJsonl() {
      return entries.length === 0 ? '' : `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
    },
    writeJsonl(path) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, handle.renderJsonl(), { mode: 0o600 });
    },
    restore() {
      if (activeState !== null && globalThis.fetch === wrapped) globalThis.fetch = base;
      activeState = null;
      activeEntries = null;
    },
  };
  return handle;
}
