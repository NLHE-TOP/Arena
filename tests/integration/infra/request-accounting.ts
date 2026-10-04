/**
 * Read-only HTTP request accounting for platform traffic (PhaseC diagnostics).
 *
 * A loopback reverse proxy sits in front of the platform so every request that
 * crosses the wire is timestamped, categorized and status-tagged, including the
 * retries the SDK performs internally after a 429. The proxy forwards requests
 * (and WebSocket upgrades) without altering method, path, headers, body or
 * status, and never changes retry policy, pacing or limits. The upstream must
 * be a loopback `http:` URL with an explicit port (the platform under test);
 * non-loopback or non-HTTP targets are refused.
 *
 * Recorded per request (exactly once, whether the upstream responded, failed
 * after headers, or answered an upgrade with a plain HTTP response): arrival
 * timestamp, HTTP method, normalized route label (never a raw unknown path),
 * category, response status and duration. Bodies, query strings, cookies,
 * tokens and identities are never read into the record; the ONLY header
 * exception is a whitelist of numeric standard throttle metadata
 * (`x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset`),
 * validated as non-negative safe integers and stored as plain numbers (null
 * when absent/invalid — never a false zero). A transport reset at any
 * stage (client before/after an upgrade, upstream before/after an upgrade,
 * mid-body) is recorded once as status 0 when no HTTP response was observed,
 * tears the paired sockets down, and can never crash the runner process.
 *
 * The pure summarizers below turn those entries into:
 * - per-category totals (observation GET / chat GET / action POST /
 *   competition GET / other HTTP);
 * - 429 counts by category;
 * - per-minute buckets (relative to a caller-supplied window);
 * - the peak rolling-60s total (exact, sliding over entry timestamps) for
 *   proxy-covered traffic only.
 *
 * The authoritative platform counter readers below sample
 * `pokertools_http_requests_total{method,route,status}` directly so
 * per-category deltas include requests that bypass the proxies (fixture,
 * admin/probe or platform-internal HTTP); callers label proxy-covered and
 * authoritative coverage separately instead of conflating them.
 */
import {
  createServer,
  request as httpRequest,
  Agent,
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { Socket } from 'node:net';
import { normalizeTraceRoute } from './trace-platform.js';

export type RequestCategory = 'observation' | 'chat' | 'action' | 'competition' | 'other';

/**
 * Numeric standard throttle metadata from one upstream response (whitelisted
 * `x-ratelimit-limit/remaining/reset` headers only). Values are plain
 * non-negative safe integers; `reset` is whatever numeric unit the platform
 * sends (recorded, never interpreted here). No identity, authorization,
 * cookie or body data can ever enter this shape.
 */
export interface ThrottleSample {
  limit: number;
  remaining: number;
  reset: number | null;
}

/** One safe accounting record; fixed-shape primitives only. */
export interface AccountingEntry {
  /** Request arrival time at the proxy (ms epoch). */
  at: number;
  method: string;
  /** Canonical route label or `unrecognized`; never the raw unknown path. */
  route: string;
  category: RequestCategory;
  /** Upstream response status; 0 when the upstream connection failed. */
  status: number;
  durationMs: number;
  /** Validated numeric throttle samples, or null when absent/invalid. */
  throttle: ThrottleSample[] | null;
}

/**
 * Canonical platform routes missing from the shared trace templates
 * (`trace-platform.ts` owns the base list; this module only extends it).
 * `:id` matches exactly one opaque segment and is never recorded.
 */
const EXTRA_ROUTE_TEMPLATES: readonly (readonly string[])[] = [
  ['auth', 'service-principals'],
  ['auth', 'service-credentials'],
  ['auth', 'service-credentials', ':id'],
  ['competitions', ':id', 'settle'],
  ['ws', 'play'],
];

function matchTemplate(segments: readonly string[], template: readonly string[]): boolean {
  if (segments.length !== template.length) return false;
  for (let index = 0; index < template.length; index += 1) {
    const expected = template[index]!;
    if (expected === ':id') {
      if (segments[index] === undefined || segments[index] === '') return false;
      continue;
    }
    if (segments[index] !== expected) return false;
  }
  return true;
}

/** Normalize a request URL to a known route label; unknown paths stay opaque. */
export function normalizeAccountingRoute(url: URL): string {
  const known = normalizeTraceRoute(url);
  if (known !== 'unrecognized') return known;
  const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
  const candidates: Array<readonly string[]> =
    segments[0] === 'v1' ? [segments, segments.slice(1)] : [segments];
  for (const candidate of candidates) {
    for (const template of EXTRA_ROUTE_TEMPLATES) {
      if (matchTemplate(candidate, template)) return `/${template.join('/')}`;
    }
  }
  return 'unrecognized';
}

/** PhaseC categories: the four named platform surfaces plus everything else. */
export function classifyRequestCategory(method: string, route: string): RequestCategory {
  const upper = method.toUpperCase();
  if (upper === 'GET' && route === '/tables/:id/observation') return 'observation';
  if (upper === 'GET' && route === '/tables/:id/chat') return 'chat';
  if (upper === 'POST' && route === '/tables/:id/action') return 'action';
  if (upper === 'GET' && (route === '/competitions' || route.startsWith('/competitions/'))) {
    return 'competition';
  }
  return 'other';
}

/** The ONLY response headers ever inspected; all three are numeric metadata. */
const THROTTLE_LIMIT_HEADER = 'x-ratelimit-limit';
const THROTTLE_REMAINING_HEADER = 'x-ratelimit-remaining';
const THROTTLE_RESET_HEADER = 'x-ratelimit-reset';

function headerValues(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** Non-negative safe integer or null; anything else is ignored, never coerced. */
function parseNonNegativeSafeInt(value: string | undefined): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Parse the whitelisted numeric throttle headers into validated samples.
 * Rules: `limit` must be a positive safe integer, `remaining` a non-negative
 * safe integer with `remaining <= limit`; `reset` is optional numeric. Any
 * malformed, negative, over-limit or non-numeric value is dropped (never
 * coerced), and a value that looks like a credential is simply not a number,
 * so it can never enter the accounting. Returns null when no valid sample
 * exists (missing headers stay missing, never a false zero).
 */
export function parseThrottleSamples(headers: IncomingHttpHeaders | null | undefined): ThrottleSample[] | null {
  if (headers === null || headers === undefined) return null;
  const limits = headerValues(headers[THROTTLE_LIMIT_HEADER]);
  const remainings = headerValues(headers[THROTTLE_REMAINING_HEADER]);
  const resets = headerValues(headers[THROTTLE_RESET_HEADER]);
  if (limits.length === 0 || remainings.length === 0) return null;
  const samples: ThrottleSample[] = [];
  const pairs = Math.min(limits.length, remainings.length);
  for (let index = 0; index < pairs; index += 1) {
    const limit = parseNonNegativeSafeInt(limits[index]);
    const remaining = parseNonNegativeSafeInt(remainings[index]);
    if (limit === null || limit < 1 || remaining === null || remaining > limit) continue;
    const reset =
      parseNonNegativeSafeInt(resets[index]) ??
      (resets.length === 1 ? parseNonNegativeSafeInt(resets[0]) : null);
    samples.push({ limit, remaining, reset });
  }
  return samples.length === 0 ? null : samples;
}

export interface RequestAccountingProxyOptions {
  /** Upstream base URL; must be loopback `http:` with an explicit port. */
  upstream: string;
  /** Clock override for focused tests. */
  now?: () => number;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/** Extract and validate a loopback upstream host + explicit port. */
export function loopbackUpstream(upstream: string): { hostname: string; port: number; host: string } {
  let url: URL;
  try {
    url = new URL(upstream);
  } catch {
    throw new Error(`request accounting proxy upstream is not a URL: ${upstream}`);
  }
  if (url.protocol !== 'http:') {
    throw new Error(`request accounting proxy requires an http upstream, saw ${url.protocol}`);
  }
  const hostname = url.hostname.replace(/^\[/, '').replace(/\]$/, '');
  if (!LOOPBACK_HOSTS.has(hostname)) {
    throw new Error(
      `request accounting proxy upstream must be loopback (127.0.0.1/localhost/::1), saw ${url.hostname}`
    );
  }
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`request accounting proxy upstream requires an explicit port, saw ${url.host || '(none)'}`);
  }
  return { hostname, port, host: url.host };
}

export interface RequestAccountingProxy {
  /** Loopback base URL the product/SDK should target. */
  readonly url: string;
  readonly port: number;
  /** Append-only accounting records (same array reference; never reseated). */
  readonly entries: AccountingEntry[];
  stop(): Promise<void>;
}

function forwardHeaders(req: IncomingMessage, upstreamHost: string): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || name === 'host') continue;
    headers[name] = value;
  }
  headers.host = upstreamHost;
  return headers;
}

/**
 * Start the accounting proxy. Every request/upgrade is recorded once, when the
 * upstream starts responding (status known), with the timestamp of arrival.
 * The proxy never alters the forwarded request, body, headers or status.
 */
export async function startRequestAccountingProxy(
  options: RequestAccountingProxyOptions
): Promise<RequestAccountingProxy> {
  const upstream = loopbackUpstream(options.upstream);
  const now = options.now ?? (() => Date.now());
  const entries: AccountingEntry[] = [];
  // One-off sockets: teardown must never wait on pooled keep-alive sockets.
  const agent = new Agent({ keepAlive: false });
  // Every proxied socket (client side and upgrade upstream side) so stop()
  // can force teardown even with a live WebSocket pipe.
  const liveSockets = new Set<Socket>();
  const track = (socket: Socket): void => {
    liveSockets.add(socket);
    socket.on('close', () => liveSockets.delete(socket));
    // Safety net: every proxied socket carries an error handler so a transport
    // reset can never surface as an unhandled 'error' event and crash Node.
    socket.on('error', () => undefined);
  };

  const safeDestroy = (target: { destroy: () => void } | null | undefined): void => {
    try {
      target?.destroy();
    } catch {
      // Already gone.
    }
  };

  /**
   * Reciprocal teardown for one upgraded client/upstream socket pair: a
   * transport reset or close on either side destroys the other (after the
   * sweep, on both ends).
   */
  const linkSockets = (client: Socket, upstreamSocket: Socket): void => {
    client.on('error', () => safeDestroy(upstreamSocket));
    upstreamSocket.on('error', () => safeDestroy(client));
    client.on('close', () => safeDestroy(upstreamSocket));
    upstreamSocket.on('close', () => safeDestroy(client));
  };

  const record = (
    req: IncomingMessage,
    status: number,
    startedAt: number,
    headers: IncomingHttpHeaders | null
  ): void => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const route = normalizeAccountingRoute(url);
      const method = (req.method ?? 'GET').toUpperCase();
      entries.push({
        at: startedAt,
        method,
        route,
        category: classifyRequestCategory(method, route),
        status,
        durationMs: Math.max(0, now() - startedAt),
        throttle: parseThrottleSamples(headers),
      });
    } catch {
      // Accounting must never affect the request path.
    }
  };

  /**
   * Exactly-once recorder for one proxied request. A response, a late upstream
   * error after headers, an upgrade success, an HTTP response to an upgrade and
   * a transport failure all race to finish first; only one status is counted.
   */
  const recorder = (
    req: IncomingMessage,
    startedAt: number
  ): ((status: number, headers?: IncomingHttpHeaders | null) => void) => {
    let recorded = false;
    return (status: number, headers: IncomingHttpHeaders | null = null) => {
      if (recorded) return;
      recorded = true;
      record(req, status, startedAt, headers);
    };
  };

  const rawResponseHead = (response: {
    statusCode?: number;
    statusMessage?: string;
    rawHeaders: string[];
  }): string => {
    const lines = [`HTTP/1.1 ${response.statusCode ?? 502} ${response.statusMessage ?? 'Unknown'}`];
    for (let index = 0; index + 1 < response.rawHeaders.length; index += 2) {
      lines.push(`${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}`);
    }
    return `${lines.join('\r\n')}\r\n\r\n`;
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const startedAt = now();
    const recordOnce = recorder(req, startedAt);
    let upstreamRequest: ClientRequest | null = null;
    // Client/transport failures at any point must never crash the proxy and
    // must never produce a second record for the same exchange.
    req.on('error', () => {
      recordOnce(0);
      safeDestroy(upstreamRequest);
      safeDestroy(res);
    });
    res.on('error', () => safeDestroy(upstreamRequest));
    upstreamRequest = httpRequest(
      {
        host: upstream.hostname,
        port: upstream.port,
        method: req.method,
        path: req.url,
        headers: forwardHeaders(req, upstream.host),
        agent,
      },
      (upstreamResponse) => {
        recordOnce(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        // A mid-body upstream failure must not crash the proxy and must not
        // produce a second accounting record (recordOnce already ran).
        upstreamResponse.on('error', () => {
          safeDestroy(res);
          safeDestroy(upstreamRequest);
        });
        res.on('error', () => safeDestroy(upstreamResponse));
        res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(res);
      }
    );
    upstreamRequest.on('error', () => {
      recordOnce(0);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('accounting proxy upstream error');
    });
    req.pipe(upstreamRequest);
  });

  // Every client connection is tracked (with a safety error handler) so stop()
  // can force teardown and a transport reset never crashes the process.
  server.on('connection', (socket: Socket) => track(socket));

  // Connections that reset before any request is parsed are transport noise,
  // not accounting events; destroy them explicitly instead of letting the
  // default handler race a listener-less socket.
  server.on('clientError', (_error: Error, socket: Socket) => safeDestroy(socket));

  // WebSocket passthrough: the product's realtime socket must keep working, or
  // its recovery polling would change the very request profile being measured.
  server.on('upgrade', (req: IncomingMessage, clientSocket: Socket, head: Buffer) => {
    const startedAt = now();
    const recordOnce = recorder(req, startedAt);
    let upstreamRequest: ClientRequest | null = null;
    let upgraded = false;
    // Attached BEFORE any upstream work: the client can reset while the
    // upgrade is still in flight (`ECONNRESET`), and that race previously
    // surfaced as an unhandled 'error' event on the client socket.
    clientSocket.on('error', () => {
      recordOnce(0);
      safeDestroy(upstreamRequest);
    });
    req.on('error', () => {
      recordOnce(0);
      safeDestroy(upstreamRequest);
      safeDestroy(clientSocket);
    });
    clientSocket.on('close', () => {
      if (!upgraded) safeDestroy(upstreamRequest);
    });
    upstreamRequest = httpRequest({
      host: upstream.hostname,
      port: upstream.port,
      method: req.method,
      path: req.url,
      headers: forwardHeaders(req, upstream.host),
      agent,
    });
    upstreamRequest.on('upgrade', (upstreamResponse, upstreamSocket: Socket, upstreamHead) => {
      upgraded = true;
      recordOnce(upstreamResponse.statusCode ?? 101, upstreamResponse.headers);
      track(upstreamSocket);
      clientSocket.write(rawResponseHead(upstreamResponse));
      if (upstreamHead.length > 0) clientSocket.write(upstreamHead);
      if (head.length > 0) upstreamSocket.write(head);
      // Either side erroring/closing tears the other down, so teardown can
      // never hang on a live socket pair and no reset is left unhandled.
      linkSockets(clientSocket, upstreamSocket);
      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
    });
    // The platform may answer an upgrade with a plain HTTP response (for
    // example 401/404); it still is exactly one HTTP exchange and must be
    // forwarded, not left as a hanging socket.
    upstreamRequest.on('response', (upstreamResponse) => {
      recordOnce(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.on('error', () => safeDestroy(clientSocket));
      clientSocket.write(rawResponseHead(upstreamResponse));
      upstreamResponse.pipe(clientSocket);
      upstreamResponse.on('end', () => clientSocket.end());
    });
    upstreamRequest.on('error', () => {
      recordOnce(0);
      safeDestroy(clientSocket);
    });
    upstreamRequest.end();
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('request accounting proxy did not bind a loopback port'));
        return;
      }
      resolve(address.port);
    });
  });

  let stopped = false;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    entries,
    async stop() {
      if (stopped) return;
      stopped = true;
      // Bounded: a peer holding a half-open socket must never hang teardown.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1_000);
        server.close(() => {
          clearTimeout(timer);
          resolve();
        });
        for (const socket of [...liveSockets]) socket.destroy();
        server.closeAllConnections?.();
      });
      agent.destroy();
    },
  };
}

export interface CategoryCounts {
  observation: number;
  chat: number;
  action: number;
  competition: number;
  other: number;
}

export function emptyCategoryCounts(): CategoryCounts {
  return { observation: 0, chat: 0, action: 0, competition: 0, other: 0 };
}

export interface RouteCount {
  method: string;
  route: string;
  category: RequestCategory;
  count: number;
  status429: number;
}

export interface MinuteCount {
  /** 1-based minute index relative to the summary window start. */
  minute: number;
  total: number;
  byCategory: CategoryCounts;
  status429: number;
}

export interface RollingPeak {
  count: number;
  /** Timestamp of the first counted request in the peak window. */
  startAt: number;
  /** Timestamp of the last counted request in the peak window. */
  endAt: number;
}

/** Worst-case numeric throttle observation for one limit bucket. */
export interface ThrottleLimitSummary {
  limit: number;
  samples: number;
  minimumRemaining: number;
  maximumRemaining: number;
  maximumReset: number | null;
  /** `minimumRemaining / limit * 100`, rounded to two decimals. */
  headroomPercent: number;
}

export interface ThrottleSummary {
  byLimit: ThrottleLimitSummary[];
  /** Runtime app bucket (`RATE_LIMIT_MAX=100`); null when headers were absent. */
  appMax100: ThrottleLimitSummary | null;
  /** Auth nonce bucket (5) when observed. */
  auth5: ThrottleLimitSummary | null;
  /** Auth login bucket (10) when observed. */
  auth10: ThrottleLimitSummary | null;
  /** Any other observed limit, never hidden. */
  otherLimits: ThrottleLimitSummary[];
  entriesWithThrottle: number;
  entriesMissingThrottle: number;
  /** Technical target for final normal app traffic; null = no data, never a pass. */
  technicalTarget: { limit: number; minimumRemaining: number; met: boolean | null };
}

export interface AccountingSummary {
  window: { startAt: number; endAt: number } | null;
  durationMs: number;
  total: number;
  byCategory: CategoryCounts;
  status429: number;
  status429ByCategory: CategoryCounts;
  byRoute: RouteCount[];
  perMinute: MinuteCount[];
  peakRolling60s: RollingPeak | null;
  firstAt: number | null;
  lastAt: number | null;
  /** Numeric throttle headroom (whitelisted x-ratelimit-* headers only). */
  throttle: ThrottleSummary;
}

function addCategory(counts: CategoryCounts, category: RequestCategory, amount: number): void {
  counts[category] += amount;
}

/**
 * Summarize entries, optionally restricted to `[window.startAt, window.endAt]`.
 * Per-minute buckets are relative to the window start (empty minutes are kept,
 * so idle gaps are visible). The rolling peak is an exact sliding 60s window
 * over request arrival timestamps, counting all categories together.
 */
export function summarizeAccounting(
  entries: readonly AccountingEntry[],
  window?: { startAt: number; endAt: number }
): AccountingSummary {
  const filtered =
    window === undefined
      ? [...entries].sort((left, right) => left.at - right.at)
      : entries.filter((entry) => entry.at >= window.startAt && entry.at <= window.endAt).sort((left, right) => left.at - right.at);

  const firstAt = filtered.length > 0 ? filtered[0]!.at : null;
  const lastAt = filtered.length > 0 ? filtered[filtered.length - 1]!.at : null;
  const startAt = window?.startAt ?? firstAt ?? 0;
  const endAt = window?.endAt ?? lastAt ?? startAt;

  const byCategory = emptyCategoryCounts();
  const status429ByCategory = emptyCategoryCounts();
  const routeCounts = new Map<string, RouteCount>();
  let status429 = 0;

  const minuteSpan = Math.max(1, Math.ceil((endAt - startAt) / 60_000));
  const perMinute: MinuteCount[] = Array.from({ length: minuteSpan }, (_, index) => ({
    minute: index + 1,
    total: 0,
    byCategory: emptyCategoryCounts(),
    status429: 0,
  }));

  for (const entry of filtered) {
    addCategory(byCategory, entry.category, 1);
    const minuteIndex = Math.min(
      minuteSpan - 1,
      Math.max(0, Math.floor((entry.at - startAt) / 60_000))
    );
    const minute = perMinute[minuteIndex]!;
    minute.total += 1;
    addCategory(minute.byCategory, entry.category, 1);
    if (entry.status === 429) {
      status429 += 1;
      addCategory(status429ByCategory, entry.category, 1);
      minute.status429 += 1;
    }
    const key = `${entry.method} ${entry.route}`;
    const route = routeCounts.get(key);
    if (route === undefined) {
      routeCounts.set(key, {
        method: entry.method,
        route: entry.route,
        category: entry.category,
        count: 1,
        status429: entry.status === 429 ? 1 : 0,
      });
    } else {
      route.count += 1;
      if (entry.status === 429) route.status429 += 1;
    }
  }

  let peakRolling60s: RollingPeak | null = null;
  let left = 0;
  for (let right = 0; right < filtered.length; right += 1) {
    while (left < right && filtered[left]!.at <= filtered[right]!.at - 60_000) left += 1;
    const count = right - left + 1;
    if (peakRolling60s === null || count > peakRolling60s.count) {
      peakRolling60s = {
        count,
        startAt: filtered[left]!.at,
        endAt: filtered[right]!.at,
      };
    }
  }

  // Numeric throttle headroom: worst (minimum) remaining per limit bucket.
  // Entries without valid headers are counted as missing, never zero-filled.
  const throttleAgg = new Map<
    number,
    {
      limit: number;
      samples: number;
      minimumRemaining: number;
      maximumRemaining: number;
      maximumReset: number | null;
    }
  >();
  let entriesWithThrottle = 0;
  for (const entry of filtered) {
    if (entry.throttle === null) continue;
    entriesWithThrottle += 1;
    for (const sample of entry.throttle) {
      const aggregate = throttleAgg.get(sample.limit);
      if (aggregate === undefined) {
        throttleAgg.set(sample.limit, {
          limit: sample.limit,
          samples: 1,
          minimumRemaining: sample.remaining,
          maximumRemaining: sample.remaining,
          maximumReset: sample.reset,
        });
        continue;
      }
      aggregate.samples += 1;
      aggregate.minimumRemaining = Math.min(aggregate.minimumRemaining, sample.remaining);
      aggregate.maximumRemaining = Math.max(aggregate.maximumRemaining, sample.remaining);
      if (sample.reset !== null) {
        aggregate.maximumReset =
          aggregate.maximumReset === null ? sample.reset : Math.max(aggregate.maximumReset, sample.reset);
      }
    }
  }
  const byLimit: ThrottleLimitSummary[] = [...throttleAgg.values()]
    .map((aggregate) => ({
      ...aggregate,
      headroomPercent: Math.round((aggregate.minimumRemaining * 10_000) / aggregate.limit) / 100,
    }))
    .sort((leftLimit, rightLimit) => leftLimit.limit - rightLimit.limit);
  const appMax100 = byLimit.find((bucket) => bucket.limit === 100) ?? null;
  const throttle: ThrottleSummary = {
    byLimit,
    appMax100,
    auth5: byLimit.find((bucket) => bucket.limit === 5) ?? null,
    auth10: byLimit.find((bucket) => bucket.limit === 10) ?? null,
    otherLimits: byLimit.filter((bucket) => bucket.limit !== 100 && bucket.limit !== 5 && bucket.limit !== 10),
    entriesWithThrottle,
    entriesMissingThrottle: filtered.length - entriesWithThrottle,
    technicalTarget: {
      limit: 100,
      minimumRemaining: 25,
      met: appMax100 === null ? null : appMax100.minimumRemaining >= 25,
    },
  };

  return {
    window: window ?? null,
    durationMs: Math.max(0, endAt - startAt),
    total: filtered.length,
    byCategory,
    status429,
    status429ByCategory,
    byRoute: [...routeCounts.values()].sort((left, right) => right.count - left.count || left.route.localeCompare(right.route)),
    perMinute,
    peakRolling60s,
    firstAt,
    lastAt,
    throttle,
  };
}

/** Compact one-line category rendering for logs (`observation=12 chat=...`). */
export function formatCategoryCounts(counts: CategoryCounts): string {
  return `observation=${counts.observation} chat=${counts.chat} action=${counts.action} competition=${counts.competition} other=${counts.other}`;
}

/**
 * Authoritative platform counter sample: every
 * `pokertools_http_requests_total{method,route,status}` value, keyed by
 * `METHOD route status`. Read directly from the platform `/metrics` surface
 * (never through an accounting proxy) so the token-free route labels stay
 * authoritative for all actors, including SDK-internal 429 retries.
 */
export interface PlatformHttpCounterSample {
  at: number;
  counts: Map<string, number>;
  total429: number;
}

/** Metrics endpoint failure carrying the status and any advised retry delay. */
export class PlatformMetricsUnavailableError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | null;
  constructor(url: string, status: number, retryAfterMs: number | null) {
    super(`platform metrics unavailable at ${url}: HTTP ${status}`);
    this.name = 'PlatformMetricsUnavailableError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function parseRetryAfterMs(response: Response): number | null {
  const value = response.headers.get('retry-after');
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10) * 1000;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

function metricsUrl(source: { url: string }): string {
  return source.url.endsWith('/metrics') ? source.url : `${source.url.replace(/\/$/, '')}/metrics`;
}

function labelValue(labels: string, name: string): string | null {
  const match = new RegExp(`(?:^|,)${name}="([^"]*)"(?:,|$)`).exec(labels);
  return match?.[1] ?? null;
}

export async function readPlatformHttpCounters(source: {
  url: string;
  token?: string | null;
}): Promise<PlatformHttpCounterSample> {
  const url = metricsUrl(source);
  const headers: Record<string, string> = {};
  if (source.token) headers.authorization = `Bearer ${source.token}`;
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    throw new PlatformMetricsUnavailableError(url, response.status, parseRetryAfterMs(response));
  }
  const text = await response.text();
  const counts = new Map<string, number>();
  let sawFamily = false;
  let total429 = 0;
  for (const line of text.split('\n')) {
    const sample = /^pokertools_http_requests_total(?:\{([^}]*)\})?\s+(\S+)(?:\s+\S+)?$/.exec(line);
    if (sample === null) continue;
    sawFamily = true;
    const labels = sample[1] ?? '';
    const value = Number(sample[2]);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('platform http counter is invalid');
    const method = labelValue(labels, 'method') ?? 'OTHER';
    const route = labelValue(labels, 'route') ?? 'unrecognized';
    const status = labelValue(labels, 'status') ?? '0';
    counts.set(`${method} ${route} ${status}`, value);
    if (status === '429') total429 += value;
  }
  if (!sawFamily) {
    throw new Error(`platform metrics at ${url} did not expose pokertools_http_requests_total`);
  }
  return { at: Date.now(), counts, total429 };
}

export interface MetricsRetryOptions {
  maxAttempts?: number;
  /** Fallback waits per retry attempt when the server advises nothing usable. */
  scheduleMs?: readonly number[];
  /** Hard cap for one advised wait. */
  maxAdvisedDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
  onRetry?: (waitMs: number) => void;
}

/**
 * Authoritative sample with bounded retry when the platform's own global rate
 * limiter answers the `/metrics` read with 429 (it does when the measured
 * workload is saturated). This is measurement-only: it runs after a response,
 * never changes product or human gameplay pacing, and its own requests are
 * reported as metrics-sampling requests in the coverage section. Non-429
 * failures are never retried.
 */
export async function readPlatformHttpCountersWithRetry(
  source: { url: string; token?: string | null },
  options: MetricsRetryOptions = {}
): Promise<PlatformHttpCounterSample> {
  const maxAttempts = options.maxAttempts ?? 5;
  const schedule = options.scheduleMs ?? [5_000, 15_000, 30_000, 60_000];
  const maxAdvised = options.maxAdvisedDelayMs ?? 75_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await readPlatformHttpCounters(source);
    } catch (error) {
      const retryable = error instanceof PlatformMetricsUnavailableError && error.status === 429;
      if (!retryable || attempt >= maxAttempts) throw error;
      const advised = error.retryAfterMs;
      const fallback = schedule[Math.min(attempt - 1, schedule.length - 1)]!;
      const waitMs =
        advised === null
          ? Math.min(fallback, maxAdvised)
          : Math.min(Math.max(advised + 250, 250), maxAdvised);
      options.log?.(
        `platform /metrics measurement rate-limited (HTTP 429, attempt ${attempt}); retrying in ${waitMs}ms (sampling only, outside gameplay pacing)`
      );
      options.onRetry?.(waitMs);
      await sleep(waitMs);
    }
  }
}

export interface PlatformRoute429 {
  method: string;
  route: string;
  category: RequestCategory;
  count: number;
}

/** Per-route 429 delta between two authoritative samples (all actors). */
export function platform429DeltaByRoute(
  before: PlatformHttpCounterSample,
  after: PlatformHttpCounterSample
): PlatformRoute429[] {
  const routes: PlatformRoute429[] = [];
  for (const [key, value] of after.counts) {
    const [method, route, status] = key.split(' ');
    if (status !== '429') continue;
    const delta = value - (before.counts.get(key) ?? 0);
    if (delta <= 0) continue;
    routes.push({
      method: method ?? 'OTHER',
      route: route ?? 'unrecognized',
      category: classifyRequestCategory(method ?? 'OTHER', route ?? 'unrecognized'),
      count: delta,
    });
  }
  return routes.sort((left, right) => right.count - left.count || left.route.localeCompare(right.route));
}

export interface PlatformRouteDelta {
  method: string;
  route: string;
  category: RequestCategory;
  count: number;
}

export interface PlatformHttpDelta {
  total: number;
  byCategory: CategoryCounts;
  byRoute: PlatformRouteDelta[];
}

/**
 * Full per-category HTTP delta between two authoritative samples. This counts
 * every platform-observed request in the window regardless of source, so it
 * also covers fixture/probe/admin traffic that bypasses the accounting
 * proxies; callers must report it as authoritative coverage, not as identical
 * to proxy-covered traffic.
 */
export function platformHttpDeltaByCategory(
  before: PlatformHttpCounterSample,
  after: PlatformHttpCounterSample
): PlatformHttpDelta {
  const byCategory = emptyCategoryCounts();
  const routes = new Map<string, PlatformRouteDelta>();
  let total = 0;
  for (const [key, value] of after.counts) {
    const delta = value - (before.counts.get(key) ?? 0);
    if (delta <= 0) continue;
    const [method, route, status] = key.split(' ');
    void status;
    const category = classifyRequestCategory(method ?? 'OTHER', route ?? 'unrecognized');
    total += delta;
    addCategory(byCategory, category, delta);
    const routeKey = `${method} ${route}`;
    const existing = routes.get(routeKey);
    if (existing === undefined) {
      routes.set(routeKey, {
        method: method ?? 'OTHER',
        route: route ?? 'unrecognized',
        category,
        count: delta,
      });
    } else {
      existing.count += delta;
    }
  }
  return {
    total,
    byCategory,
    byRoute: [...routes.values()].sort(
      (left, right) => right.count - left.count || left.route.localeCompare(right.route)
    ),
  };
}

/**
 * Proxy-vs-authoritative coverage comparison. The authoritative delta includes
 * the direct `/metrics` sampling reads used to take it, so those are reported
 * separately and excluded from the mismatch, leaving only genuine bypass
 * traffic (fixture/probe/platform-internal HTTP) as `unmatchedBeyondProxies`.
 */
export function coverageComparison(
  authoritative: PlatformHttpDelta | null,
  proxyCoveredTotal: number
): {
  authoritativeTotal: number | null;
  metricsSamplingTotal: number | null;
  unmatchedBeyondProxies: number | null;
} {
  if (authoritative === null) {
    return { authoritativeTotal: null, metricsSamplingTotal: null, unmatchedBeyondProxies: null };
  }
  const metricsSamplingTotal =
    authoritative.byRoute.find((route) => route.method === 'GET' && route.route === '/metrics')?.count ?? 0;
  return {
    authoritativeTotal: authoritative.total,
    metricsSamplingTotal,
    unmatchedBeyondProxies: authoritative.total - metricsSamplingTotal - proxyCoveredTotal,
  };
}
