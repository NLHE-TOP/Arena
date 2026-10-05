#!/usr/bin/env tsx
/**
 * Narrow unpaid production-container rate-limit acceptance.
 *
 * Proves, on the ACTUAL candidate/released PokerTools image started by the
 * existing external `startStagingTopology` fixture under its immutable
 * production defaults (`NODE_ENV=production`, `RATE_LIMIT_MAX=100`,
 * `RATE_LIMIT_NETWORK_MAX=1000`, `AUTH_NONCE_RATE_LIMIT_MAX=5`,
 * `AUTH_LOGIN_RATE_LIMIT_MAX=10`, no trusted proxies, no environment override):
 *
 * - four independent principals — two fresh SIWE WALLET sessions and two
 *   distinct orchestration SERVICE principals minted through the existing
 *   `mintOrchestrationToken` helper twice with verified unique names — each get
 *   exactly the documented 100-request per-principal budget on `GET /auth/me`,
 *   even though every request shares one loopback egress IP and every request
 *   is forced onto a brand-new TCP connection (`Connection: close`, no agent);
 * - the 101st unit is rejected with HTTP 429 whose standard
 *   `x-ratelimit-limit` header is 100 (never the 1000 network bound), and the
 *   platform's own authoritative prometheus counters confirm the exact
 *   accepted/rejected counts for the window;
 * - a principal that already overflowed cannot evade the cap by rotating its
 *   credential in place or by opening a fresh wallet session (same durable
 *   principal), and a forged `X-Forwarded-For` header cannot rotate the bucket;
 * - the actual running container's root `package.json` reports version 2.0.1,
 *   and the image's compiled config evaluates to the production defaults with
 *   no rate-limit override variable present in the container environment.
 *
 * This is deliberately narrow: no gameplay, no paid provider, no table or
 * finance mutation, no `@pokertools/api` dependency (public SDK/types plus the
 * tracked integration infra only), and no legacy `runProductionAcceptance.sh`
 * 100000-request override. The unauthenticated `/health` 100-then-429 block is
 * intentionally omitted: exhausting the anonymous per-IP application bucket
 * would make the authoritative `/metrics` sampling unreadable until the window
 * resets (measurement artifact). The four verified principal budgets plus the
 * retried authoritative metric samples are the gate.
 *
 * All fixture cleanup happens in `finally`; any unexpected supervised death or
 * teardown error fails the run, so a dead infrastructure can never report PASS.
 *
 * Usage:
 *   NLHE_IT_STAGING_FIXTURE=<abs path to staging-platform.mjs> \
 *   NLHE_IT_PLATFORM_IMAGE=pokertools:rate-limit-2.0.1-candidate \
 *     tsx tests/integration/production-rate-limit.ts [--json <path>] [--keep]
 *   tsx tests/integration/production-rate-limit.ts --self-test
 *
 * Exit codes: 0 PASS, 1 acceptance/infrastructure FAIL, 2 not runnable
 * (missing fixture or image).
 */
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { isAbsolute, join } from 'node:path';
import { PrincipalSchema, type Principal } from '@pokertools/types';
import { ensureOperator } from './infra/admin.js';
import { mintOrchestrationToken } from './infra/agents.js';
import { createRunContext } from './infra/context.js';
import { runCommand, runCommandOrThrow } from './infra/proc.js';
import {
  platform429DeltaByRoute,
  readPlatformHttpCountersWithRetry,
  type PlatformHttpCounterSample,
  type PlatformRoute429,
} from './infra/request-accounting.js';
import { generateSyntheticSecret, SecretRegistry } from './infra/secret-registry.js';
import { DEFAULT_PLATFORM_IMAGE, startStagingTopology, type StagingTopology } from './infra/staging.js';
import { ephemeralWallet, getAccount, loginWallet } from './infra/wallet.js';

/** Root package.json version of the candidate/released platform image. */
export const EXPECTED_IMAGE_VERSION = '2.0.1';
/** Per-principal application cap (`RATE_LIMIT_MAX` production default). */
export const EXPECTED_PRINCIPAL_CAP = 100;
/** Coarse per-IP network cap (`RATE_LIMIT_NETWORK_MAX` production default). */
export const EXPECTED_NETWORK_CAP = 1000;
/** Strict SIWE nonce/login per-IP route limits (production defaults). */
export const EXPECTED_AUTH_NONCE_MAX = 5;
export const EXPECTED_AUTH_LOGIN_MAX = 10;
export const WALLET_PRINCIPALS = 2;
export const SERVICE_PRINCIPALS = 2;
export const TOTAL_PRINCIPALS = WALLET_PRINCIPALS + SERVICE_PRINCIPALS;
/** One setup identity read per principal is already charged to its budget. */
export const SETUP_AUTH_ME_READS_PER_PRINCIPAL = 1;
/** Each principal: 1 setup read + 99 post-setup accepted + 1 overflow + 1 denial probe. */
export const AUTH_ME_REQUESTS_PER_PRINCIPAL = 1 + (EXPECTED_PRINCIPAL_CAP - 1) + 1 + 1;
/** Final simultaneous denial probes plus XFF/rotation/fresh-session probes. */
export const EXTRA_AUTH_ME_REQUESTS = TOTAL_PRINCIPALS + 1 + 1 + 1 + 1;
export const EXPECTED_AUTH_ME_REQUESTS =
  TOTAL_PRINCIPALS * AUTH_ME_REQUESTS_PER_PRINCIPAL + EXTRA_AUTH_ME_REQUESTS;
export const EXPECTED_AUTH_ME_200 = TOTAL_PRINCIPALS * (1 + (EXPECTED_PRINCIPAL_CAP - 1));
/** 2 rejections per principal + 4 final + XFF + rotated + fresh-session. */
export const EXPECTED_AUTH_ME_429 = TOTAL_PRINCIPALS * 2 + TOTAL_PRINCIPALS + 1 + 1 + 1;
export const EXPECTED_AUTH_ME_401 = 1;
/** Setup HTTP: admin+2 wallets+relogin nonces/logins, 2 mints, 1 list. */
export const EXPECTED_SETUP_HTTP_REQUESTS = 4 + 4 + 2 + 1;
export const EXPECTED_METRICS_READS = 3;
export const EXPECTED_HEALTH_READS = 2;
/** Fixture startup health/readiness polling allowance (same shared egress IP). */
export const FIXTURE_STARTUP_ALLOWANCE = 100;
export const EXPECTED_NETWORK_UPPER_BOUND =
  EXPECTED_AUTH_ME_REQUESTS +
  EXPECTED_SETUP_HTTP_REQUESTS +
  EXPECTED_METRICS_READS +
  EXPECTED_HEALTH_READS +
  FIXTURE_STARTUP_ALLOWANCE;

const FORGED_XFF = '203.0.113.250';
const CONFIG_PROBE = [
  "const { config } = require('/app/packages/api/dist/config.js');",
  'process.stdout.write(JSON.stringify({',
  'env: {',
  'NODE_ENV: process.env.NODE_ENV ?? null,',
  'RATE_LIMIT_MAX: process.env.RATE_LIMIT_MAX ?? null,',
  'RATE_LIMIT_NETWORK_MAX: process.env.RATE_LIMIT_NETWORK_MAX ?? null,',
  'AUTH_NONCE_RATE_LIMIT_MAX: process.env.AUTH_NONCE_RATE_LIMIT_MAX ?? null,',
  'AUTH_LOGIN_RATE_LIMIT_MAX: process.env.AUTH_LOGIN_RATE_LIMIT_MAX ?? null,',
  'TRUSTED_PROXY_CIDRS: process.env.TRUSTED_PROXY_CIDRS ?? null,',
  '},',
  'effective: {',
  'nodeEnv: config.NODE_ENV,',
  'rateLimitMax: config.RATE_LIMIT_MAX,',
  'networkMax: config.RATE_LIMIT_NETWORK_MAX,',
  'nonceMax: config.AUTH_NONCE_RATE_LIMIT_MAX,',
  'loginMax: config.AUTH_LOGIN_RATE_LIMIT_MAX,',
  'trustedProxyCidrs: config.TRUSTED_PROXY_CIDRS,',
  '},',
  '}))',
].join('');

export interface AcceptanceArgs {
  jsonPath: string | null;
  selfTest: boolean;
  keep: boolean;
}

export function parseProductionRateLimitArgs(argv: readonly string[]): AcceptanceArgs {
  const args: AcceptanceArgs = { jsonPath: null, selfTest: false, keep: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    switch (argument) {
      case '--self-test':
        args.selfTest = true;
        break;
      case '--keep':
        args.keep = true;
        break;
      case '--json': {
        const next = argv[index + 1];
        if (next === undefined || next.startsWith('--') || next.trim().length === 0) {
          throw new Error('--json requires a non-empty path');
        }
        args.jsonPath = next;
        index += 1;
        break;
      }
      default:
        throw new Error(`unknown production-rate-limit argument: ${argument}`);
    }
  }
  return args;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface CheckRecord {
  name: string;
  status: 'PASS' | 'FAIL';
  detail?: string;
}

async function check(
  checks: CheckRecord[],
  name: string,
  fn: () => Promise<void> | void
): Promise<void> {
  try {
    await fn();
    checks.push({ name, status: 'PASS' });
  } catch (error) {
    checks.push({ name, status: 'FAIL', detail: errorText(error) });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Raw HTTP: no SDK retry, forced `Connection: close` (a brand-new TCP
// connection per request). Only status, whitelisted numeric rate-limit headers
// and the client local port are read; bodies are parsed only for identity.
// ---------------------------------------------------------------------------

const MAX_RESPONSE_BYTES = 64 * 1024;

export interface RawHttpResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
  localPort: number | null;
}

export interface RawGetOptions {
  token?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export function rawGet(
  baseUrl: string,
  path: string,
  options: RawGetOptions = {}
): Promise<RawHttpResponse> {
  const url = new URL(path, baseUrl);
  const headers: Record<string, string> = {
    accept: 'application/json',
    connection: 'close',
    ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
    ...options.headers,
  };
  return new Promise<RawHttpResponse>((resolve, reject) => {
    let settled = false;
    const finish = (response: RawHttpResponse): void => {
      if (!settled) {
        settled = true;
        resolve(response);
      }
    };
    const fail = (error: Error): void => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
    const request = httpRequest(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers,
        agent: false,
        timeout: options.timeoutMs ?? 15_000,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            response.destroy(new Error(`raw GET ${path} response exceeded ${MAX_RESPONSE_BYTES} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        response.on('error', (error) => fail(error));
        response.on('end', () =>
          finish({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
            localPort: request.socket?.localPort ?? null,
          })
        );
      }
    );
    request.on('timeout', () => request.destroy(new Error(`raw GET ${path} timed out`)));
    request.on('error', (error) => fail(error));
    request.end();
  });
}

type RawGet = (
  path: string,
  options?: RawGetOptions
) => Promise<RawHttpResponse>;

// ---------------------------------------------------------------------------
// Pure budget/header logic (exercised offline by --self-test).
// ---------------------------------------------------------------------------

export interface ParsedRateLimitHeaders {
  limit: number;
  remaining: number;
  reset: number | null;
  retryAfter: number | null;
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | null {
  const value = headers[name];
  if (value === undefined) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function parseNonNegativeInt(value: string | null): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Parse the standard numeric rate-limit headers. Returns null when the required
 * `limit`/`remaining` pair is absent or malformed; a `remaining` above `limit`
 * is rejected rather than coerced.
 */
export function parseRateLimitHeaders(headers: IncomingHttpHeaders): ParsedRateLimitHeaders | null {
  const limit = parseNonNegativeInt(headerValue(headers, 'x-ratelimit-limit'));
  const remaining = parseNonNegativeInt(headerValue(headers, 'x-ratelimit-remaining'));
  if (limit === null || limit < 1 || remaining === null || remaining > limit) return null;
  return {
    limit,
    remaining,
    reset: parseNonNegativeInt(headerValue(headers, 'x-ratelimit-reset')),
    retryAfter: parseNonNegativeInt(headerValue(headers, 'retry-after')),
  };
}

interface BudgetAttempt {
  status: number;
  rate: ParsedRateLimitHeaders | null;
  localPort: number | null;
}

/**
 * Classify the ordered attempts of one principal: every attempt before the
 * first non-200 must be 200, the accepted count (including the setup read) must
 * be exactly the documented cap, and the first rejection must be a 429.
 */
export function classifyBudgetAttempts(
  attempts: readonly Pick<BudgetAttempt, 'status'>[],
  setupReads: number
): { acceptedAfterSetup: number; overflowIndex: number } {
  const overflowIndex = attempts.findIndex((attempt) => attempt.status !== 200);
  if (overflowIndex < 0) {
    throw new Error(
      `budget never overflowed within ${attempts.length} attempts; the ${EXPECTED_PRINCIPAL_CAP + 1}th unit must be rejected`
    );
  }
  const acceptedAfterSetup = overflowIndex;
  const totalAccepted = acceptedAfterSetup + setupReads;
  if (totalAccepted !== EXPECTED_PRINCIPAL_CAP) {
    throw new Error(
      `principal accepted ${totalAccepted} requests (setup ${setupReads} + ${acceptedAfterSetup} after), expected exactly ${EXPECTED_PRINCIPAL_CAP}`
    );
  }
  const overflow = attempts[overflowIndex]!;
  if (overflow.status !== 429) {
    throw new Error(`first rejected attempt was HTTP ${overflow.status}, expected 429`);
  }
  return { acceptedAfterSetup, overflowIndex };
}

/**
 * A principal overflow must carry the 100 per-principal cap and never the 1000
 * network bound; the standard reset/retry-after headers must be present.
 */
export function assertOverflowAttempt(
  attempt: Pick<BudgetAttempt, 'status' | 'rate'>,
  label: string,
  expectedCap: number = EXPECTED_PRINCIPAL_CAP
): ParsedRateLimitHeaders {
  if (attempt.status !== 429) throw new Error(`${label}: expected HTTP 429, saw ${attempt.status}`);
  const rate = attempt.rate;
  if (rate === null) {
    throw new Error(`${label}: 429 response carried no valid x-ratelimit-limit/remaining headers`);
  }
  if (rate.limit !== expectedCap) {
    throw new Error(
      `${label}: 429 x-ratelimit-limit=${rate.limit}, expected the ${expectedCap} per-principal cap${
        rate.limit === EXPECTED_NETWORK_CAP ? ' (the 1000 network bound was tripped)' : ''
      }`
    );
  }
  if (rate.remaining !== 0) {
    throw new Error(`${label}: 429 x-ratelimit-remaining=${rate.remaining}, expected 0`);
  }
  if (rate.reset === null || rate.reset < 1) {
    throw new Error(`${label}: 429 x-ratelimit-reset is missing or invalid`);
  }
  if (rate.retryAfter === null || rate.retryAfter < 1) {
    throw new Error(`${label}: 429 retry-after is missing or invalid`);
  }
  return rate;
}

// ---------------------------------------------------------------------------
// Acceptance types.
// ---------------------------------------------------------------------------

interface PrincipalPlan {
  label: string;
  kind: 'WALLET' | 'SERVICE';
  token: string;
  principalId: string;
  walletAddress: string | null;
  forgedXffAfterOverflow: boolean;
}

export interface PrincipalBudgetRecord {
  label: string;
  kind: 'WALLET' | 'SERVICE';
  principalId: string;
  setupAuthMeReads: number;
  acceptedAfterSetup: number;
  totalAccepted: number;
  firstOverflow: {
    status: number;
    limit: number | null;
    remaining: number | null;
    reset: number | null;
    retryAfter: number | null;
  } | null;
  postExhaustDenialStatus: number | null;
  distinctLocalPorts: number;
  totalRequests: number;
  connectionsAllFresh: boolean;
  independentAfterPriorExhaustion: boolean | null;
  windowAgeMsAtEnd: number;
}

interface ActualImageMetadata {
  container: string;
  containerId: string;
  configImage: string;
  containerImageId: string;
  running: boolean;
  startedAt: string;
  imageId: string;
  imageCreated: string;
  rootPackageJsonVersion: string;
  env: Record<string, string | null>;
  effective: {
    nodeEnv: string;
    rateLimitMax: number;
    networkMax: number;
    nonceMax: number;
    loginMax: number;
    trustedProxyCidrs: string;
  };
}

interface SetupEvidence {
  operatorPromoted: boolean;
  walletPrincipals: number;
  servicePrincipals: number;
  distinctPrincipalIds: number;
  credentialNames: { serviceA: string; serviceB: string; unique: boolean };
  tokensRegistered: number;
  siweSessions: { setup: number; relogin: number; total: number; nonceMax: number; loginMax: number };
}

interface IsolationEvidence {
  sharedIp: string;
  allCallsSameEgress: true;
  independentPrincipals: number;
  samePrincipalNewTcpDenied: boolean;
  freshConnectionsPerRequest: boolean;
  forgedXff: { header: string; status: number; limit: number | null } | null;
  rotatedCredential: { oldStatus: number; newStatus: number; samePrincipal: boolean } | null;
  freshWalletSession: { status: number; samePrincipal: boolean; windowAgeMs: number } | null;
  finalSimultaneousDenials: Array<{ label: string; status: number; limit: number | null }>;
}

interface AcceptanceReport {
  kind: 'production-container-rate-limit-acceptance';
  runId: string;
  generatedAt: string;
  pass: boolean;
  platform: {
    configuredImage: string;
    actual: ActualImageMetadata | null;
    host: string | null;
    sameEgress: true;
    productionDefaultsConfirmed: boolean;
    legacyAcceptanceOverrideUsed: false;
  };
  principals: {
    wallet: number;
    service: number;
    total: number;
    allDistinct: boolean;
    entries: Array<{ label: string; kind: string; principalId: string }>;
  };
  expected: {
    perPrincipalCap: number;
    networkCap: number;
    authMeRequests: number;
    authMe200: number;
    authMe401: number;
    authMe429: number;
    networkRequestsUpperBound: number;
    note: string;
  };
  budgets: PrincipalBudgetRecord[];
  isolation: IsolationEvidence | null;
  setup: SetupEvidence | null;
  metrics: {
    readRetries: number;
    atStart: { at: number; total429: number; series: number } | null;
    afterSetup: { at: number; total429: number; series: number } | null;
    afterBudgets: { at: number; total429: number; series: number } | null;
    setupDelta429: number | null;
    budgetDelta429: number | null;
    budget429ByRoute: PlatformRoute429[];
    authMeDelta: { '200': number; '401': number; '429': number; '5xx': number } | null;
  };
  rawAuthMeRequests: number;
  checks: CheckRecord[];
  cleanup: { unexpectedDeaths: string[]; teardownErrors: string[] };
  failure: string | null;
}

function summarizeSample(sample: PlatformHttpCounterSample | null): {
  at: number;
  total429: number;
  series: number;
} | null {
  return sample === null ? null : { at: sample.at, total429: sample.total429, series: sample.counts.size };
}

function statusDelta(
  before: PlatformHttpCounterSample,
  after: PlatformHttpCounterSample,
  method: string,
  route: string,
  status: string
): number {
  const key = `${method} ${route} ${status}`;
  return (after.counts.get(key) ?? 0) - (before.counts.get(key) ?? 0);
}

// ---------------------------------------------------------------------------
// Actual image identity / effective production defaults (metadata only, never
// environment secrets: only the five rate-limit variables plus NODE_ENV are
// read out of the container, and the compiled config is evaluated in place).
// ---------------------------------------------------------------------------

async function readActualImageMetadata(
  topology: StagingTopology,
  configuredImage: string
): Promise<ActualImageMetadata> {
  const container = topology.platform.finance?.apiContainerName;
  if (container === undefined || container.length === 0) {
    throw new Error('external staging fixture did not expose the API container name (finance.apiContainerName)');
  }
  const inspect = await runCommandOrThrow(
    'docker',
    ['inspect', '--format', '{{.Id}}|{{.Config.Image}}|{{.Image}}|{{.State.Running}}|{{.State.StartedAt}}', container],
    { timeoutMs: 15_000 }
  );
  const [containerId = '', configImage = '', containerImageId = '', running = '', startedAt = ''] = inspect.stdout
    .trim()
    .split('|');
  const imageInspect = await runCommandOrThrow(
    'docker',
    ['image', 'inspect', '--format', '{{.Id}}|{{.Created}}', configuredImage],
    { timeoutMs: 15_000 }
  );
  const [imageId = '', imageCreated = ''] = imageInspect.stdout.trim().split('|');
  const versionProbe = await runCommandOrThrow(
    'docker',
    ['exec', container, 'node', '-e', "process.stdout.write(require('/app/package.json').version)"],
    { timeoutMs: 15_000 }
  );
  const configProbe = await runCommandOrThrow('docker', ['exec', container, 'node', '-e', CONFIG_PROBE], {
    timeoutMs: 15_000,
  });
  const parsed = JSON.parse(configProbe.stdout.trim()) as {
    env: Record<string, string | null>;
    effective: ActualImageMetadata['effective'];
  };
  return {
    container,
    containerId,
    configImage,
    containerImageId,
    running: running === 'true',
    startedAt,
    imageId,
    imageCreated,
    rootPackageJsonVersion: versionProbe.stdout.trim(),
    env: parsed.env,
    effective: parsed.effective,
  };
}

// ---------------------------------------------------------------------------
// Principal budget flow.
// ---------------------------------------------------------------------------

async function warmupPrincipal(
  get: RawGet,
  plan: PrincipalPlan
): Promise<{ principal: Principal; rate: ParsedRateLimitHeaders | null }> {
  const response = await get('/auth/me', { token: plan.token });
  if (response.status !== 200) {
    throw new Error(`${plan.label}: setup /auth/me expected 200, saw ${response.status}`);
  }
  const principal = PrincipalSchema.parse(JSON.parse(response.body) as unknown);
  if (principal.id !== plan.principalId) {
    throw new Error(`${plan.label}: /auth/me resolved ${principal.id}, expected ${plan.principalId}`);
  }
  if (principal.kind !== plan.kind) {
    throw new Error(`${plan.label}: /auth/me resolved kind ${principal.kind}, expected ${plan.kind}`);
  }
  if (plan.kind === 'WALLET') {
    if (principal.walletAddress?.toLowerCase() !== plan.walletAddress?.toLowerCase()) {
      throw new Error(`${plan.label}: /auth/me wallet address mismatch`);
    }
  } else if (principal.walletAddress !== null) {
    throw new Error(`${plan.label}: SERVICE principal unexpectedly reported a wallet address`);
  }
  return { principal, rate: parseRateLimitHeaders(response.headers) };
}

async function exhaustPrincipal(
  get: RawGet,
  plan: PrincipalPlan,
  windowStartedAt: number
): Promise<PrincipalBudgetRecord> {
  const setupReads = SETUP_AUTH_ME_READS_PER_PRINCIPAL;
  const attempts: BudgetAttempt[] = [];
  const probeLimit = EXPECTED_PRINCIPAL_CAP - setupReads + 8;
  for (let index = 0; index < probeLimit; index += 1) {
    const response = await get('/auth/me', { token: plan.token });
    const attempt: BudgetAttempt = {
      status: response.status,
      rate: parseRateLimitHeaders(response.headers),
      localPort: response.localPort,
    };
    attempts.push(attempt);
    if (attempt.status !== 200) break;
  }
  const { acceptedAfterSetup, overflowIndex } = classifyBudgetAttempts(attempts, setupReads);
  const overflow = attempts[overflowIndex]!;
  const overflowHeaders = assertOverflowAttempt(overflow, `${plan.label} overflow`);
  const localPorts = attempts
    .map((attempt) => attempt.localPort)
    .filter((port): port is number => port !== null);
  const distinctLocalPorts = new Set(localPorts).size;
  const connectionsAllFresh =
    localPorts.length === attempts.length && distinctLocalPorts === attempts.length;
  if (!connectionsAllFresh) {
    throw new Error(
      `${plan.label}: expected a fresh TCP connection per request (Connection: close), saw ${distinctLocalPorts} distinct local ports for ${attempts.length} requests`
    );
  }
  const denial = await get('/auth/me', { token: plan.token });
  const denialAttempt: BudgetAttempt = {
    status: denial.status,
    rate: parseRateLimitHeaders(denial.headers),
    localPort: denial.localPort,
  };
  assertOverflowAttempt(denialAttempt, `${plan.label} post-overflow`);
  return {
    label: plan.label,
    kind: plan.kind,
    principalId: plan.principalId,
    setupAuthMeReads: setupReads,
    acceptedAfterSetup,
    totalAccepted: acceptedAfterSetup + setupReads,
    firstOverflow: {
      status: overflow.status,
      limit: overflowHeaders.limit,
      remaining: overflowHeaders.remaining,
      reset: overflowHeaders.reset,
      retryAfter: overflowHeaders.retryAfter,
    },
    postExhaustDenialStatus: denial.status,
    distinctLocalPorts,
    totalRequests: attempts.length + 1,
    connectionsAllFresh,
    independentAfterPriorExhaustion: null,
    windowAgeMsAtEnd: Date.now() - windowStartedAt,
  };
}

// ---------------------------------------------------------------------------
// Offline self-test (no Docker, no fixture, no network).
// ---------------------------------------------------------------------------

export function runSelfTest(): { checks: string[] } {
  const checks: string[] = [];

  const parsedArgs = parseProductionRateLimitArgs(['--self-test', '--json', '/tmp/report.json']);
  if (!parsedArgs.selfTest || parsedArgs.jsonPath !== '/tmp/report.json') {
    throw new Error('argument parsing self-test failed');
  }
  let rejectedUnknown = false;
  try {
    parseProductionRateLimitArgs(['--bogus']);
  } catch {
    rejectedUnknown = true;
  }
  if (!rejectedUnknown) throw new Error('unknown argument was not rejected');
  checks.push('argument-parsing');

  const validHeaders = {
    'x-ratelimit-limit': '100',
    'x-ratelimit-remaining': '0',
    'x-ratelimit-reset': '42',
    'retry-after': '42',
  };
  const parsedValid = parseRateLimitHeaders(validHeaders);
  if (parsedValid?.limit !== 100 || parsedValid.remaining !== 0 || parsedValid.reset !== 42) {
    throw new Error('valid rate-limit headers were not parsed');
  }
  if (parseRateLimitHeaders({ 'x-ratelimit-limit': '0', 'x-ratelimit-remaining': '0' }) !== null) {
    throw new Error('limit 0 was accepted');
  }
  if (parseRateLimitHeaders({ 'x-ratelimit-limit': '5', 'x-ratelimit-remaining': '6' }) !== null) {
    throw new Error('remaining > limit was accepted');
  }
  if (parseRateLimitHeaders({ 'x-ratelimit-limit': 'many', 'x-ratelimit-remaining': '0' }) !== null) {
    throw new Error('non-numeric limit was accepted');
  }
  checks.push('rate-limit-header-parsing');

  const overflowAttempt: BudgetAttempt = {
    status: 429,
    rate: parsedValid,
    localPort: 1234,
  };
  assertOverflowAttempt(overflowAttempt, 'self-test');
  let networkCapRejected = false;
  try {
    assertOverflowAttempt(
      { status: 429, rate: { limit: 1000, remaining: 0, reset: 42, retryAfter: 42 } },
      'self-test'
    );
  } catch {
    networkCapRejected = true;
  }
  if (!networkCapRejected) throw new Error('network-cap 429 was not rejected by the principal-cap assertion');
  checks.push('overflow-header-assertion');

  const capAttempts = [
    ...Array.from({ length: EXPECTED_PRINCIPAL_CAP - 1 }, () => ({ status: 200 })),
    { status: 429 },
  ];
  const classified = classifyBudgetAttempts(capAttempts, 1);
  if (classified.acceptedAfterSetup !== EXPECTED_PRINCIPAL_CAP - 1) {
    throw new Error('cap classification did not count the accepted units');
  }
  let underflowRejected = false;
  try {
    classifyBudgetAttempts(capAttempts.slice(0, -2).concat({ status: 429 }), 1);
  } catch {
    underflowRejected = true;
  }
  if (!underflowRejected) throw new Error('an under-budget sequence was not rejected');
  let wrongRejectionRejected = false;
  try {
    classifyBudgetAttempts([...Array.from({ length: 99 }, () => ({ status: 200 })), { status: 401 }], 1);
  } catch {
    wrongRejectionRejected = true;
  }
  if (!wrongRejectionRejected) throw new Error('a non-429 rejection was not rejected');
  checks.push('budget-classification');

  if (EXPECTED_AUTH_ME_REQUESTS !== 416) {
    throw new Error(`expected 416 raw /auth/me requests, computed ${EXPECTED_AUTH_ME_REQUESTS}`);
  }
  if (EXPECTED_AUTH_ME_429 !== 15 || EXPECTED_AUTH_ME_401 !== 1 || EXPECTED_AUTH_ME_200 !== 400) {
    throw new Error('expected authoritative /auth/me delta constants drifted');
  }
  if (EXPECTED_NETWORK_UPPER_BOUND >= EXPECTED_NETWORK_CAP) {
    throw new Error(
      `expected network upper bound ${EXPECTED_NETWORK_UPPER_BOUND} must stay below the ${EXPECTED_NETWORK_CAP} network cap`
    );
  }
  if (EXPECTED_AUTH_NONCE_MAX < 4 || EXPECTED_AUTH_LOGIN_MAX < 4) {
    throw new Error('setup SIWE sessions no longer fit the strict auth route limits');
  }
  checks.push('budget-arithmetic');

  const registry = new SecretRegistry();
  const syntheticToken = generateSyntheticSecret('self-test-token');
  registry.addPlatformSecret('self-test-token', syntheticToken);
  const redacted = registry.redact(JSON.stringify({ token: syntheticToken }));
  if (redacted.includes(syntheticToken) || !redacted.includes('<redacted>')) {
    throw new Error('generated token was not redacted');
  }
  checks.push('token-redaction');

  return { checks };
}

// ---------------------------------------------------------------------------
// Acceptance run.
// ---------------------------------------------------------------------------

async function runAcceptance(args: AcceptanceArgs): Promise<number> {
  const fixture = process.env.NLHE_IT_STAGING_FIXTURE;
  if (fixture === undefined || !isAbsolute(fixture)) {
    console.error(
      'BLOCKED: NLHE_IT_STAGING_FIXTURE is required (absolute path to the built external staging fixture exporting startStagingPlatform)'
    );
    return 2;
  }
  const configuredImage = DEFAULT_PLATFORM_IMAGE;
  const context = createRunContext({ keep: args.keep });
  context.log(`production rate-limit acceptance ${context.runId}`);
  context.log(`artifacts: ${context.artifactDir}`);
  context.log(`configured platform image: ${configuredImage}`);
  context.log(
    `production defaults under test: RATE_LIMIT_MAX=${EXPECTED_PRINCIPAL_CAP} RATE_LIMIT_NETWORK_MAX=${EXPECTED_NETWORK_CAP} AUTH_NONCE=${EXPECTED_AUTH_NONCE_MAX} AUTH_LOGIN=${EXPECTED_AUTH_LOGIN_MAX} (no override)`
  );

  const imageProbe = await runCommand(
    'docker',
    ['image', 'inspect', '--format', '{{.Id}}|{{.Created}}', configuredImage],
    { timeoutMs: 15_000 }
  );
  if (imageProbe.code !== 0) {
    console.error(`BLOCKED: platform image ${configuredImage} is not available locally`);
    return 2;
  }

  let topology: StagingTopology | null = null;
  let failure: string | null = null;
  let sanitize = (value: string): string => value;
  const checks: CheckRecord[] = [];
  const budgets: PrincipalBudgetRecord[] = [];
  const finalDenials: Array<{ label: string; status: number; limit: number | null }> = [];
  const registeredTokens: string[] = [];
  let imageMetadata: ActualImageMetadata | null = null;
  let metricsAtStart: PlatformHttpCounterSample | null = null;
  let metricsAfterSetup: PlatformHttpCounterSample | null = null;
  let metricsAfterBudgets: PlatformHttpCounterSample | null = null;
  let metricsReadRetries = 0;
  let setupEvidence: SetupEvidence | null = null;
  let isolation: IsolationEvidence | null = null;
  let rawAuthMeRequests = 0;
  let cleanupErrors: string[] = [];
  let unexpectedDeaths: string[] = [];
  let platformHost: string | null = null;
  let productionDefaultsConfirmed = false;

  try {
    topology = await startStagingTopology({
      context,
      sponsor: { principalId: randomUUID(), address: getAccount(2).address },
    });
    const activeTopology = topology;
    sanitize = (value) => activeTopology.secretRegistry.redact(value);
    const log = (message: string): void => context.log(sanitize(message));
    const platformUrl = activeTopology.platformUrl;
    platformHost = new URL(platformUrl).hostname;
    log(`platform url: ${platformUrl} (all acceptance traffic is direct HTTP from this host)`);
    log(`platform image: ${activeTopology.platformImage}`);

    let rawRequests = 0;
    const get: RawGet = async (path, options) => {
      rawRequests += 1;
      if (path === '/auth/me') rawAuthMeRequests += 1;
      return rawGet(platformUrl, path, options);
    };

    await check(checks, 'fresh fixture is a loopback http host (one shared egress IP)', () => {
      if (platformHost !== '127.0.0.1') {
        throw new Error(`platform host must be loopback 127.0.0.1, saw ${platformHost}`);
      }
      if (new URL(platformUrl).protocol !== 'http:') {
        throw new Error(`platform url must be http, saw ${platformUrl}`);
      }
    });

    imageMetadata = await readActualImageMetadata(activeTopology, configuredImage);
    await check(checks, 'actual running container is the configured image', () => {
      if (imageMetadata?.configImage !== configuredImage) {
        throw new Error(`container Config.Image=${imageMetadata?.configImage}, expected ${configuredImage}`);
      }
      if (imageMetadata.containerImageId !== imageMetadata.imageId) {
        throw new Error(
          `container image id ${imageMetadata.containerImageId} does not match local image ${imageMetadata.imageId}`
        );
      }
      if (!imageMetadata.running) throw new Error('actual API container is not running');
    });
    await check(checks, `actual image root package.json version is ${EXPECTED_IMAGE_VERSION}`, () => {
      if (imageMetadata?.rootPackageJsonVersion !== EXPECTED_IMAGE_VERSION) {
        throw new Error(
          `actual image root package.json version=${imageMetadata?.rootPackageJsonVersion}, expected ${EXPECTED_IMAGE_VERSION}`
        );
      }
    });
    await check(checks, 'actual runtime is production with default limits and no override variable', () => {
      const effective = imageMetadata?.effective;
      const env = imageMetadata?.env;
      if (effective === undefined || env === undefined) throw new Error('actual image metadata is missing');
      if (effective.nodeEnv !== 'production') {
        throw new Error(`actual NODE_ENV=${effective.nodeEnv}, expected production`);
      }
      if (
        effective.rateLimitMax !== EXPECTED_PRINCIPAL_CAP ||
        effective.networkMax !== EXPECTED_NETWORK_CAP ||
        effective.nonceMax !== EXPECTED_AUTH_NONCE_MAX ||
        effective.loginMax !== EXPECTED_AUTH_LOGIN_MAX ||
        effective.trustedProxyCidrs !== ''
      ) {
        throw new Error(
          `actual compiled limits are not the production defaults: ${JSON.stringify(effective)}`
        );
      }
      for (const name of [
        'RATE_LIMIT_MAX',
        'RATE_LIMIT_NETWORK_MAX',
        'AUTH_NONCE_RATE_LIMIT_MAX',
        'AUTH_LOGIN_RATE_LIMIT_MAX',
        'TRUSTED_PROXY_CIDRS',
      ]) {
        if (env[name] !== null) {
          throw new Error(`container environment overrides ${name}=${env[name]}; acceptance requires no override`);
        }
      }
      if (env.NODE_ENV !== 'production') {
        throw new Error(`container NODE_ENV env=${env.NODE_ENV}, expected production`);
      }
      productionDefaultsConfirmed = true;
    });

    const readMetrics = (label: string): Promise<PlatformHttpCounterSample> =>
      readPlatformHttpCountersWithRetry(activeTopology.platformMetrics, {
        maxAttempts: 4,
        scheduleMs: [5_000, 15_000, 30_000],
        maxAdvisedDelayMs: 30_000,
        log: (message) => log(`${label}: ${message}`),
        onRetry: () => {
          metricsReadRetries += 1;
        },
      });

    metricsAtStart = await readMetrics('metrics at start');
    await check(checks, 'authoritative prometheus metrics readable before setup', () => {
      if (metricsAtStart === null || metricsAtStart.counts.size === 0) {
        throw new Error('no authoritative metric series were readable at start');
      }
    });

    // --- setup: operator, two wallets, two distinct SERVICE principals ---
    const admin = await loginWallet(platformUrl, ephemeralWallet());
    activeTopology.addGeneratedSecret('production-rate-limit.admin-token', admin.token);
    registeredTokens.push(admin.token);
    const promotion = await ensureOperator(activeTopology.adminTarget, admin);
    await check(checks, 'operator wallet promoted to ADMIN', () => {
      if (!promotion.promoted) throw new Error('operator wallet was not promoted to ADMIN');
    });

    const walletA = await loginWallet(platformUrl, ephemeralWallet());
    activeTopology.addGeneratedSecret('production-rate-limit.wallet-a-token', walletA.token);
    registeredTokens.push(walletA.token);
    const walletB = await loginWallet(platformUrl, ephemeralWallet());
    activeTopology.addGeneratedSecret('production-rate-limit.wallet-b-token', walletB.token);
    registeredTokens.push(walletB.token);
    await check(checks, 'two fresh wallet principals logged in with distinct ids', () => {
      if (walletA.userId === walletB.userId) throw new Error('wallet sessions resolved to the same principal');
      if (walletA.wallet.address.toLowerCase() === walletB.wallet.address.toLowerCase()) {
        throw new Error('wallet sessions share one address');
      }
    });

    const serviceA = await mintOrchestrationToken(admin);
    activeTopology.addGeneratedSecret('production-rate-limit.service-a-token', serviceA.token);
    registeredTokens.push(serviceA.token);
    const serviceB = await mintOrchestrationToken(admin);
    activeTopology.addGeneratedSecret('production-rate-limit.service-b-token', serviceB.token);
    registeredTokens.push(serviceB.token);
    const credentials = await admin.client.listServiceCredentials();
    const credentialA = credentials.find((credential) => credential.id === serviceA.credentialId);
    const credentialB = credentials.find((credential) => credential.id === serviceB.credentialId);
    const credentialAName = credentialA?.name ?? '';
    const credentialBName = credentialB?.name ?? '';
    await check(
      checks,
      'two distinct orchestration SERVICE principals minted with unique credential names',
      () => {
        if (serviceA.principalId === serviceB.principalId) {
          throw new Error('the two minted SERVICE credentials resolved to the same principal');
        }
        if (serviceA.credentialId === serviceB.credentialId) {
          throw new Error('the two minted SERVICE credentials share one credential id');
        }
        if (credentialA === undefined || credentialB === undefined) {
          throw new Error('minted SERVICE credentials are missing from the operator credential list');
        }
        if (credentialA.userId !== serviceA.principalId || credentialB.userId !== serviceB.principalId) {
          throw new Error('credential list principal does not match the minted principal');
        }
        if (credentialAName.length === 0 || credentialBName.length === 0 || credentialAName === credentialBName) {
          throw new Error('minted SERVICE credential names are not unique');
        }
        if (credentialA.revoked || credentialB.revoked) throw new Error('a freshly minted credential is revoked');
      }
    );

    const setup = {
      siweSessions: 3,
      reloginSessions: 1,
    };
    await check(checks, 'all generated tokens registered for redaction', () => {
      const values = activeTopology.secretRegistry.values();
      for (const token of registeredTokens) {
        if (!values.includes(token)) throw new Error('a generated token was not registered for redaction');
      }
    });
    setupEvidence = {
      operatorPromoted: promotion.promoted,
      walletPrincipals: 2,
      servicePrincipals: 2,
      distinctPrincipalIds: new Set([walletA.userId, walletB.userId, serviceA.principalId, serviceB.principalId])
        .size,
      credentialNames: { serviceA: credentialAName, serviceB: credentialBName, unique: credentialAName !== credentialBName },
      tokensRegistered: registeredTokens.length,
      siweSessions: {
        setup: setup.siweSessions,
        relogin: setup.reloginSessions,
        total: setup.siweSessions + setup.reloginSessions,
        nonceMax: EXPECTED_AUTH_NONCE_MAX,
        loginMax: EXPECTED_AUTH_LOGIN_MAX,
      },
    };

    metricsAfterSetup = await readMetrics('metrics after setup');
    await check(checks, 'authoritative prometheus metrics readable after setup', () => {
      if (metricsAfterSetup === null) throw new Error('no authoritative metric series were readable after setup');
    });
    await check(checks, 'no /auth/me rejection occurred during setup', () => {
      if (statusDelta(metricsAtStart!, metricsAfterSetup!, 'GET', '/auth/me', '429') !== 0) {
        throw new Error('setup traffic was unexpectedly rate limited before the measured budgets');
      }
    });

    // --- four verified principal budgets, same shared egress IP ---
    const plans: PrincipalPlan[] = [
      {
        label: 'wallet-a',
        kind: 'WALLET',
        token: walletA.token,
        principalId: walletA.userId,
        walletAddress: walletA.wallet.address,
        forgedXffAfterOverflow: false,
      },
      {
        label: 'wallet-b',
        kind: 'WALLET',
        token: walletB.token,
        principalId: walletB.userId,
        walletAddress: walletB.wallet.address,
        forgedXffAfterOverflow: false,
      },
      {
        label: 'service-a',
        kind: 'SERVICE',
        token: serviceA.token,
        principalId: serviceA.principalId,
        walletAddress: null,
        forgedXffAfterOverflow: true,
      },
      {
        label: 'service-b',
        kind: 'SERVICE',
        token: serviceB.token,
        principalId: serviceB.principalId,
        walletAddress: null,
        forgedXffAfterOverflow: false,
      },
    ];
    const windowStartedAtByLabel = new Map<string, number>();
    let forgedXff: IsolationEvidence['forgedXff'] = null;
    for (const [index, plan] of plans.entries()) {
      const windowStartedAt = Date.now();
      windowStartedAtByLabel.set(plan.label, windowStartedAt);
      const warmup = await warmupPrincipal(get, plan);
      await check(
        checks,
        `${plan.label}: setup /auth/me resolves the expected ${plan.kind} principal`,
        () => {
          if (warmup.principal.id !== plan.principalId || warmup.principal.kind !== plan.kind) {
            throw new Error('warm-up principal identity mismatch');
          }
        }
      );
      const record = await exhaustPrincipal(get, plan, windowStartedAt);
      record.independentAfterPriorExhaustion =
        index === 0
          ? null
          : budgets.length === index &&
            budgets.every(
              (prior) => prior.firstOverflow !== null && prior.firstOverflow.status === 429
            );
      if (index > 0 && record.independentAfterPriorExhaustion !== true) {
        throw new Error(`${plan.label}: did not receive a fresh 200 while earlier principals were rejected`);
      }
      budgets.push(record);
      await check(
        checks,
        `${plan.label}: exactly ${EXPECTED_PRINCIPAL_CAP} accepted /auth/me before the ${EXPECTED_PRINCIPAL_CAP + 1}th is rejected`,
        () => {
          if (record.totalAccepted !== EXPECTED_PRINCIPAL_CAP || record.firstOverflow?.status !== 429) {
            throw new Error(
              `accepted=${record.totalAccepted} overflow=${record.firstOverflow?.status} for ${plan.label}`
            );
          }
        }
      );
      await check(
        checks,
        `${plan.label}: overflow 429 carries x-ratelimit-limit=${EXPECTED_PRINCIPAL_CAP} (not the ${EXPECTED_NETWORK_CAP} network bound)`,
        () => {
          if (record.firstOverflow?.limit !== EXPECTED_PRINCIPAL_CAP) {
            throw new Error(`overflow x-ratelimit-limit=${record.firstOverflow?.limit}`);
          }
        }
      );
      await check(checks, `${plan.label}: every request used a fresh TCP connection`, () => {
        if (!record.connectionsAllFresh) {
          throw new Error(
            `${record.distinctLocalPorts} distinct local ports for ${record.totalRequests} requests`
          );
        }
      });
      await check(checks, `${plan.label}: post-overflow request on a new connection is still denied`, () => {
        if (record.postExhaustDenialStatus !== 429) {
          throw new Error(`post-overflow status=${record.postExhaustDenialStatus}`);
        }
      });
      if (plan.forgedXffAfterOverflow) {
        const forged = await get('/auth/me', {
          token: plan.token,
          headers: { 'x-forwarded-for': FORGED_XFF },
        });
        const forgedAttempt: BudgetAttempt = {
          status: forged.status,
          rate: parseRateLimitHeaders(forged.headers),
          localPort: forged.localPort,
        };
        const forgedRate = assertOverflowAttempt(forgedAttempt, `${plan.label} forged X-Forwarded-For`);
        forgedXff = { header: FORGED_XFF, status: forged.status, limit: forgedRate.limit };
        await check(
          checks,
          `${plan.label}: forged X-Forwarded-For cannot rotate the bucket (still 429)`,
          () => {
            if (forged.status !== 429) throw new Error(`forged XFF status=${forged.status}`);
          }
        );
      }
    }

    // --- final simultaneous denials for all four principals ---
    for (const plan of plans) {
      const denial = await get('/auth/me', { token: plan.token });
      const denialAttempt: BudgetAttempt = {
        status: denial.status,
        rate: parseRateLimitHeaders(denial.headers),
        localPort: denial.localPort,
      };
      const rate = assertOverflowAttempt(denialAttempt, `${plan.label} final denial`);
      finalDenials.push({ label: plan.label, status: denial.status, limit: rate.limit });
    }
    await check(checks, 'all four principals are simultaneously denied after their budgets', () => {
      if (finalDenials.length !== TOTAL_PRINCIPALS || finalDenials.some((denial) => denial.status !== 429)) {
        throw new Error(`final denials: ${JSON.stringify(finalDenials)}`);
      }
    });

    // --- same-principal evasion probes (rotation / fresh session) ---
    const rotated = await admin.client.rotateServiceCredential(serviceA.credentialId);
    activeTopology.addGeneratedSecret('production-rate-limit.service-a-rotated-token', rotated.token);
    registeredTokens.push(rotated.token);
    const oldCredentialResponse = await get('/auth/me', { token: serviceA.token });
    const rotatedResponse = await get('/auth/me', { token: rotated.token });
    const rotatedAttempt: BudgetAttempt = {
      status: rotatedResponse.status,
      rate: parseRateLimitHeaders(rotatedResponse.headers),
      localPort: rotatedResponse.localPort,
    };
    assertOverflowAttempt(rotatedAttempt, 'service-a rotated credential');
    await check(
      checks,
      'service-a: credential rotation keeps the same principal denied and revokes the old credential (401)',
      () => {
        if (rotated.userId !== serviceA.principalId) {
          throw new Error('rotated credential changed the durable principal');
        }
        if (oldCredentialResponse.status !== 401) {
          throw new Error(`old credential status=${oldCredentialResponse.status}, expected 401`);
        }
        if (rotatedResponse.status !== 429) {
          throw new Error(`rotated credential status=${rotatedResponse.status}, expected 429`);
        }
      }
    );

    const relogin = await loginWallet(platformUrl, walletA.wallet);
    activeTopology.addGeneratedSecret('production-rate-limit.wallet-a-relogin-token', relogin.token);
    registeredTokens.push(relogin.token);
    const reloginResponse = await get('/auth/me', { token: relogin.token });
    const reloginAttempt: BudgetAttempt = {
      status: reloginResponse.status,
      rate: parseRateLimitHeaders(reloginResponse.headers),
      localPort: reloginResponse.localPort,
    };
    assertOverflowAttempt(reloginAttempt, 'wallet-a fresh session');
    const walletWindowAge = Date.now() - (windowStartedAtByLabel.get('wallet-a') ?? Date.now());
    await check(
      checks,
      'wallet-a: a fresh wallet session for the same principal is still denied',
      () => {
        if (relogin.userId !== walletA.userId) throw new Error('fresh session changed the wallet principal');
        if (reloginResponse.status !== 429) {
          throw new Error(`fresh session status=${reloginResponse.status}, expected 429`);
        }
        if (walletWindowAge >= 60_000) {
          throw new Error(`wallet budget window already reset (${walletWindowAge}ms); rerun`);
        }
      }
    );
    await check(checks, 'all generated tokens (including rotated/fresh) registered for redaction', () => {
      const values = activeTopology.secretRegistry.values();
      for (const token of registeredTokens) {
        if (!values.includes(token)) throw new Error('a generated token was not registered for redaction');
      }
    });

    isolation = {
      sharedIp: platformHost ?? 'unknown',
      allCallsSameEgress: true,
      independentPrincipals: budgets.filter((record) => record.totalAccepted === EXPECTED_PRINCIPAL_CAP).length,
      samePrincipalNewTcpDenied: budgets.every(
        (record) =>
          record.connectionsAllFresh &&
          record.postExhaustDenialStatus === 429 &&
          record.firstOverflow?.status === 429
      ),
      freshConnectionsPerRequest: budgets.every((record) => record.connectionsAllFresh),
      forgedXff,
      rotatedCredential: {
        oldStatus: oldCredentialResponse.status,
        newStatus: rotatedResponse.status,
        samePrincipal: rotated.userId === serviceA.principalId,
      },
      freshWalletSession: {
        status: reloginResponse.status,
        samePrincipal: relogin.userId === walletA.userId,
        windowAgeMs: walletWindowAge,
      },
      finalSimultaneousDenials: finalDenials,
    };
    await check(
      checks,
      'four independent principal budgets behind the same egress IP (2 wallet + 2 service)',
      () => {
        if (isolation?.independentPrincipals !== TOTAL_PRINCIPALS) {
          throw new Error(`only ${isolation?.independentPrincipals} principals reached the full cap`);
        }
      }
    );

    // --- infrastructure liveness and authoritative after sample ---
    await activeTopology.assertHealthy('after production rate-limit acceptance', {
      requireCustodyHeartbeat: true,
    });
    await check(checks, 'supervised topology healthy after the budgets', () => {
      if (activeTopology.supervisor.deaths().length > 0) {
        throw new Error('unexpected supervised death before the final health check');
      }
    });

    metricsAfterBudgets = await readMetrics('metrics after budgets');
    await check(checks, 'authoritative prometheus delta confirms the exact /auth/me counts', () => {
      if (metricsAfterSetup === null || metricsAfterBudgets === null) {
        throw new Error('authoritative metric samples are incomplete');
      }
      const delta200 = statusDelta(metricsAfterSetup, metricsAfterBudgets, 'GET', '/auth/me', '200');
      const delta401 = statusDelta(metricsAfterSetup, metricsAfterBudgets, 'GET', '/auth/me', '401');
      const delta429 = statusDelta(metricsAfterSetup, metricsAfterBudgets, 'GET', '/auth/me', '429');
      if (delta200 !== EXPECTED_AUTH_ME_200) {
        throw new Error(`authoritative GET /auth/me 200 delta=${delta200}, expected ${EXPECTED_AUTH_ME_200}`);
      }
      if (delta401 !== EXPECTED_AUTH_ME_401) {
        throw new Error(`authoritative GET /auth/me 401 delta=${delta401}, expected ${EXPECTED_AUTH_ME_401}`);
      }
      if (delta429 !== EXPECTED_AUTH_ME_429) {
        throw new Error(`authoritative GET /auth/me 429 delta=${delta429}, expected ${EXPECTED_AUTH_ME_429}`);
      }
      if (rawAuthMeRequests !== EXPECTED_AUTH_ME_REQUESTS) {
        throw new Error(`raw /auth/me requests=${rawAuthMeRequests}, expected ${EXPECTED_AUTH_ME_REQUESTS}`);
      }
    });
    await check(checks, 'authoritative prometheus delta shows no /auth/me 5xx', () => {
      if (metricsAfterSetup === null || metricsAfterBudgets === null) {
        throw new Error('authoritative metric samples are incomplete');
      }
      for (const status of ['500', '502', '503']) {
        const delta = statusDelta(metricsAfterSetup, metricsAfterBudgets, 'GET', '/auth/me', status);
        if (delta !== 0) throw new Error(`GET /auth/me ${status} delta=${delta}, expected 0`);
      }
    });
    if (rawRequests !== rawAuthMeRequests) {
      throw new Error(`raw request accounting drifted: ${rawRequests} total vs ${rawAuthMeRequests} /auth/me`);
    }
  } catch (error) {
    failure = sanitize(errorText(error));
    if (checks.at(-1)?.status !== 'FAIL') {
      checks.push({ name: 'acceptance run', status: 'FAIL', detail: failure });
    }
  } finally {
    if (topology !== null) {
      unexpectedDeaths = topology.supervisor.deaths().map((death) => `${death.name}: ${death.detail}`);
      try {
        cleanupErrors = await topology.stop();
      } catch (error) {
        cleanupErrors = [`topology stop threw: ${sanitize(errorText(error))}`];
      }
    }
  }

  await check(checks, 'no unexpected supervised deaths during acceptance', () => {
    if (unexpectedDeaths.length > 0) throw new Error(unexpectedDeaths.join('; '));
  }).catch(() => undefined);
  await check(checks, 'clean fixture teardown', () => {
    if (cleanupErrors.length > 0) throw new Error(cleanupErrors.join('; '));
  }).catch(() => undefined);

  let authMeDelta: AcceptanceReport['metrics']['authMeDelta'] = null;
  let budget429ByRoute: PlatformRoute429[] = [];
  let setupDelta429: number | null = null;
  let budgetDelta429: number | null = null;
  if (metricsAtStart !== null && metricsAfterSetup !== null && metricsAfterBudgets !== null) {
    setupDelta429 = metricsAfterSetup.total429 - metricsAtStart.total429;
    budgetDelta429 = metricsAfterBudgets.total429 - metricsAfterSetup.total429;
    budget429ByRoute = platform429DeltaByRoute(metricsAfterSetup, metricsAfterBudgets);
    authMeDelta = {
      '200': statusDelta(metricsAfterSetup, metricsAfterBudgets, 'GET', '/auth/me', '200'),
      '401': statusDelta(metricsAfterSetup, metricsAfterBudgets, 'GET', '/auth/me', '401'),
      '429': statusDelta(metricsAfterSetup, metricsAfterBudgets, 'GET', '/auth/me', '429'),
      '5xx': ['500', '502', '503']
        .map((status) => statusDelta(metricsAfterSetup, metricsAfterBudgets, 'GET', '/auth/me', status))
        .reduce((total, value) => total + value, 0),
    };
  }

  const report: AcceptanceReport = {
    kind: 'production-container-rate-limit-acceptance',
    runId: context.runId,
    generatedAt: new Date().toISOString(),
    pass: false,
    platform: {
      configuredImage,
      actual: imageMetadata,
      host: platformHost,
      sameEgress: true,
      productionDefaultsConfirmed,
      legacyAcceptanceOverrideUsed: false,
    },
    principals: {
      wallet: setupEvidence?.walletPrincipals ?? 0,
      service: setupEvidence?.servicePrincipals ?? 0,
      total: setupEvidence?.distinctPrincipalIds ?? 0,
      allDistinct: setupEvidence?.distinctPrincipalIds === TOTAL_PRINCIPALS,
      entries: budgets.map((record) => ({
        label: record.label,
        kind: record.kind,
        principalId: record.principalId,
      })),
    },
    expected: {
      perPrincipalCap: EXPECTED_PRINCIPAL_CAP,
      networkCap: EXPECTED_NETWORK_CAP,
      authMeRequests: EXPECTED_AUTH_ME_REQUESTS,
      authMe200: EXPECTED_AUTH_ME_200,
      authMe401: EXPECTED_AUTH_ME_401,
      authMe429: EXPECTED_AUTH_ME_429,
      networkRequestsUpperBound: EXPECTED_NETWORK_UPPER_BOUND,
      note: 'unauth /health 100-then-429 block intentionally omitted so the anonymous per-IP bucket cannot make the authoritative /metrics sampling unreadable (measurement artifact)',
    },
    budgets,
    isolation,
    setup: setupEvidence,
    metrics: {
      readRetries: metricsReadRetries,
      atStart: summarizeSample(metricsAtStart),
      afterSetup: summarizeSample(metricsAfterSetup),
      afterBudgets: summarizeSample(metricsAfterBudgets),
      setupDelta429,
      budgetDelta429,
      budget429ByRoute,
      authMeDelta,
    },
    rawAuthMeRequests,
    checks,
    cleanup: { unexpectedDeaths, teardownErrors: cleanupErrors },
    failure,
  };

  const defaultPath = join(context.artifactDir, 'production-rate-limit-report.json');
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  const redacted = topology === null ? serialized : topology.secretRegistry.redact(serialized);
  if (topology !== null) {
    const tokenLeak = registeredTokens.find((token) => redacted.includes(token));
    checks.push(
      tokenLeak === undefined
        ? { name: 'report carries no generated token material', status: 'PASS' }
        : { name: 'report carries no generated token material', status: 'FAIL', detail: 'a generated token was not redacted from the report' }
    );
  }
  const pass = failure === null && checks.every((entry) => entry.status === 'PASS');
  report.pass = pass;
  // Final write with the pass flag and leak check included (checks is the same array reference as report.checks).
  const finalSerialized = `${JSON.stringify(report, null, 2)}\n`;
  const finalRedacted = topology === null ? finalSerialized : topology.secretRegistry.redact(finalSerialized);
  writeFileSync(defaultPath, finalRedacted, { mode: 0o600 });
  if (args.jsonPath !== null) writeFileSync(args.jsonPath, finalRedacted, { mode: 0o600 });

  context.log('---- production rate-limit acceptance summary ----');
  for (const record of budgets) {
    context.log(
      `${record.label} [${record.kind}]: accepted=${record.totalAccepted} firstOverflow=${record.firstOverflow?.status} x-ratelimit-limit=${record.firstOverflow?.limit} remaining=${record.firstOverflow?.remaining} retry-after=${record.firstOverflow?.retryAfter} freshTcp=${record.connectionsAllFresh} requests=${record.totalRequests}`
    );
  }
  if (isolation !== null) {
    context.log(
      `isolation: sharedIp=${isolation.sharedIp} independent=${isolation.independentPrincipals}/${TOTAL_PRINCIPALS} samePrincipalNewTcpDenied=${isolation.samePrincipalNewTcpDenied} forgedXff=${isolation.forgedXff?.status ?? 'n/a'} rotated=${isolation.rotatedCredential?.newStatus ?? 'n/a'} freshSession=${isolation.freshWalletSession?.status ?? 'n/a'}`
    );
  }
  if (authMeDelta !== null) {
    context.log(
      `authoritative GET /auth/me delta: 200=${authMeDelta['200']} 401=${authMeDelta['401']} 429=${authMeDelta['429']} 5xx=${authMeDelta['5xx']} (metrics retries=${metricsReadRetries})`
    );
  }
  context.log(`report: ${defaultPath}`);
  context.log(`cleanup: unexpectedDeaths=${unexpectedDeaths.length} teardownErrors=${cleanupErrors.length}`);
  context.log(`RESULT: ${pass ? 'PASS' : 'FAIL'}${failure === null ? '' : ` (${failure})`}`);
  return pass ? 0 : 1;
}

async function main(): Promise<number> {
  let args: AcceptanceArgs;
  try {
    args = parseProductionRateLimitArgs(process.argv.slice(2));
  } catch (error) {
    console.error(errorText(error));
    return 2;
  }
  if (args.selfTest) {
    try {
      const result = runSelfTest();
      // eslint-disable-next-line no-console
      console.log(`SELF-TEST PASS (${result.checks.length} checks: ${result.checks.join(', ')})`);
      return 0;
    } catch (error) {
      console.error(`SELF-TEST FAIL: ${errorText(error)}`);
      return 1;
    }
  }
  return runAcceptance(args);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
