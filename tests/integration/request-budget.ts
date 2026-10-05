#!/usr/bin/env tsx
/**
 * PhaseC unpaid request-accounting diagnostic (platform pre/post-patch).
 *
 * Measures the ACTUAL HTTP request pressure the NLHE product's room runtime
 * places on the external PokerTools platform while the deterministic
 * provider/product room harness runs the PhaseC scenario set:
 *
 *   fresh-1H1A   one SPONSORED 1H1A room on a fresh product instance
 *   10A          one SPONSORED 10A room (agent-only, platform maximum)
 *   1H9A         one SPONSORED 1H9A room
 *   mixed-pair   TWO simultaneous mixed rooms (default 2H2A + 2H2A)
 *
 * Measurement is protocol-level: a loopback accounting HTTP proxy sits between
 * the product and the actual platform (`POKERTOOLS_API_URL`), and a second
 * proxy carries the human harness SDK traffic. Every product/harness platform
 * request (including the retries the SDK performs internally after a 429, and
 * WebSocket upgrades) is timestamped and categorized as observation GET /
 * chat GET / action POST / competition GET / other HTTP. For each scenario the
 * report records:
 *
 * - total and per-category request counts for the product, the human harness
 *   and combined (proxy-covered traffic);
 * - per-minute buckets (relative to the scenario start) and the exact peak
 *   rolling-60s total over proxy-covered request arrival timestamps;
 * - proxy-observed 429 count by category, cross-checked against the
 *   platform's own `pokertools_http_requests_total{method,route,status}` delta
 *   read directly before/after each scenario (authoritative; includes SDK
 *   retries and any traffic that bypasses the proxies, reported as a labeled
 *   `unmatchedBeyondProxies` difference per scenario — never hidden).
 *
 * Coverage is explicit: operator bootstrap / service-principal provisioning /
 * human SIWE login is setup traffic, budgeted separately via its own
 * authoritative counter delta; the proxies carry all product and harness
 * gameplay traffic for the whole run. The combined proxy rolling peak is
 * labeled as proxy-covered only and is never presented as a whole-platform
 * peak. When the platform's own per-IP limiter answers a direct `/metrics`
 * sample with 429 (it does under saturation), the sample is retried on a
 * bounded schedule — measurement only, never in-scenario pacing — and
 * scenario boundaries share samples so no extra sampling request is inserted
 * between scenarios. Per-identity (principal) rolling 60s is not reported:
 * product agent credentials are minted into the product and platform metrics
 * carry no principal label, so attribution would require token capture (see
 * `perIdentity.reason` in the report).
 *
 * Numeric throttle headroom (future E evidence): the proxies additionally
 * capture ONLY the numeric standard `x-ratelimit-limit/remaining/reset`
 * response headers (HTTP and WS upgrade) and summarize minimum remaining and
 * headroom percent per limit bucket (`appMax100`, separate `auth5`/`auth10`,
 * plus any other limit, never hidden). Identity, authorization and cookie
 * headers, tokens, bodies and principal ids are never captured; null means the
 * headers were absent, never a false zero. Diagnostic C is not gated on
 * headroom; the technical target (>= 25 remaining of 100) applies to final
 * normal app traffic after the platform patch (user E). Network headroom
 * continues to use the existing tracked peaks versus the default network
 * limit; no network-level header API is invented.
 *
 * The NLHE runtime caps are EXACTLY the deterministic acceptance settings
 * (`maxProviderCalls=5000`, `overallRuntimeMs=600000`, `maxHands=100`;
 * `MAX_PROVIDER_CONCURRENCY=8`, agent chat enabled, agent catalog limits
 * unchanged). Provider caps are never raised for this diagnostic.
 *
 * This is a diagnostic, not a zero-rate-limit gate: 429s are recorded and
 * reported, never used to fail the run by themselves. Production limits are
 * preserved (the fixture never relaxes RATE_LIMIT_MAX/AUTH_* rate limits), no
 * sleep is inserted to evade a limit, and the existing documented human driver
 * pacing (2.5s sweep cadence, 200ms think time) is used unchanged. No paid
 * provider is contacted (all provider URLs are loopback).
 *
 * User C (legacy shared-IP limiter) expects 429s and non-terminal rooms: the
 * report separates `phaseC.allFourAccounted` (proxy + authoritative coverage
 * for all four scenarios) from `phaseC.allFourCompleted` (every room terminal,
 * expected only after the platform patch, user E). The diagnostic
 * `--max-wait-ms N` (default 900000, minimum 60000) only bounds how long the
 * harness waits for a scenario to settle so all four can be recorded; it never
 * changes provider caps. Each scenario records failed-prior-room contamination
 * from read-only public product room snapshots (ids/names/status only, no
 * bodies or tokens), so a failed case's budget is never claimed isolated.
 * A run that had any room failure still exits non-zero.
 *
 * Usage:
 *   NLHE_IT_STAGING_FIXTURE=<abs path to staging-platform.mjs> \
 *     tsx tests/integration/request-budget.ts [--smoke] [--scenarios a,b] \
 *     [--mixed-pair 2H2A,2H2A] [--max-wait-ms N] [--wallet-only] \
 *     [--json <path>] [--keep] [--self-test]
 *
 * `--wallet-only` appends ONE optional pure-WALLET 2H scenario after the
 * selected scenarios, reusing the existing human pool sessions (`humans[0..1]`,
 * no additional nonce/login or identity hack). The mandatory PhaseC required
 * list stays the four scenarios and `--scenarios` still selects only those
 * four; the wallet-only room runs through the existing `runProductRoom`
 * authority and documented human pacing, and must record exactly 0 provider
 * requests (no agent seats). Readiness, metrics and numeric throttle headroom
 * for that room are reported under `walletOnly`.
 *
 * --smoke runs only `fresh-1H1A` (the targeted cheap PhaseC scenario).
 * --self-test exercises the proxy/categorization/bucketing math offline
 * (loopback only, no Docker, no platform) and exits without a stage.
 *
 * Exit codes: 0 accounting recorded (429s allowed), 1 scenario/accounting
 * failure, 2 not runnable (missing fixture/arguments).
 */
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRunContext, type RunContext } from './infra/context.js';
import { getAccount, ephemeralWallet, loginWallet, type WalletSession } from './infra/wallet.js';
import { ensureOperator } from './infra/admin.js';
import { mintOrchestrationToken, productAdminToken, provisionFakeAgentPrincipals, type ProvisionedAgent } from './infra/agents.js';
import { ensureNlheBuild, startNlhe, writeFakeAgentRoster, type NlheHandle } from './infra/nlhe.js';
import { startFakeProvider, type FakeProviderHandle } from './infra/fake-provider.js';
import { FIXTURE_API_KEY, FIXTURE_MODEL } from './infra/fixtures.js';
import { DEFAULT_PLATFORM_IMAGE, startStagingTopology, type StagingTopology } from './infra/staging.js';
import { RELEASED_PLATFORM_IMAGE } from './infra/provenance.js';
import type { TestEnvironment } from './infra/environment.js';
import {
  coverageComparison,
  formatCategoryCounts,
  loopbackUpstream,
  parseThrottleSamples,
  platform429DeltaByRoute,
  platformHttpDeltaByCategory,
  readPlatformHttpCounters,
  readPlatformHttpCountersWithRetry,
  startRequestAccountingProxy,
  summarizeAccounting,
  type AccountingEntry,
  type AccountingSummary,
  type PlatformHttpCounterSample,
  type PlatformHttpDelta,
  type PlatformRoute429,
  type RequestAccountingProxy,
} from './infra/request-accounting.js';
import { ProductClient } from './acceptance/product-client.js';
import { HUMAN_DRIVER_PACING, runProductRoom, type HumanDriverStats } from './acceptance/product-room.js';
import { ROSTER_MATRIX, type RosterSpec } from './acceptance/roster.js';

/** Mandatory PhaseC scenarios (required list never changes). */
const REQUIRED_SCENARIO_NAMES = ['fresh-1H1A', '10A', '1H9A', 'mixed-pair'] as const;
type RequiredScenarioName = (typeof REQUIRED_SCENARIO_NAMES)[number];
/** Optional appended scenarios (never part of the required four). */
const WALLET_ONLY_SCENARIO = 'wallet-only' as const;
type ScenarioName = RequiredScenarioName | typeof WALLET_ONLY_SCENARIO;

/** Central released immutable platform image (never env-overridable here). */
const PUBLISHED_PLATFORM_2_0_0_IMAGE = RELEASED_PLATFORM_IMAGE;

const HUMAN_POOL_SIZE = 4;
const AGENT_POOL_SIZE = 10;

interface BudgetArgs {
  smoke: boolean;
  selfTest: boolean;
  keep: boolean;
  scenarios: RequiredScenarioName[] | null;
  mixedPair: [string, string];
  jsonPath: string | null;
  /** Diagnostic wait only (runProductRoom maxWaitMs); never a provider cap. */
  maxWaitMs: number;
  /**
   * Append the optional pure-WALLET 2H scenario after the selected scenarios.
   * It reuses the existing human pool sessions; the required four stay as-is.
   */
  walletOnly: boolean;
}

/** Default diagnostic wait: unchanged from the acceptance harness. */
export const DEFAULT_DIAGNOSTIC_MAX_WAIT_MS = 900_000;

/**
 * Validate the diagnostic `--max-wait-ms` value. It only bounds how long the
 * harness waits for a scenario to settle (so the full matrix can be recorded
 * even when legacy-platform 429s prevent room completion); provider caps are
 * never affected. Minimum one budget minute so a shorter wait cannot be used
 * to slice across the platform's rate-limit window.
 */
export function parseDiagnosticMaxWaitMs(value: string): number {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`--max-wait-ms must be an integer number of milliseconds, saw ${value}`);
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < 60_000) {
    throw new Error(`--max-wait-ms must be >= 60000 (one budget minute), saw ${value}`);
  }
  return parsed;
}

function parseArgs(argv: readonly string[]): BudgetArgs {
  const args: BudgetArgs = {
    smoke: false,
    selfTest: false,
    keep: false,
    scenarios: null,
    mixedPair: ['2H2A', '2H2A'],
    jsonPath: null,
    maxWaitMs: DEFAULT_DIAGNOSTIC_MAX_WAIT_MS,
    walletOnly: false,
  };
  const value = (index: number, flag: string): string => {
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) throw new Error(`${flag} requires a value`);
    return next;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    switch (argument) {
      case '--smoke':
        args.smoke = true;
        break;
      case '--self-test':
        args.selfTest = true;
        break;
      case '--keep':
        args.keep = true;
        break;
      case '--wallet-only':
        args.walletOnly = true;
        break;
      case '--max-wait-ms': {
        const raw = value(index, '--max-wait-ms');
        index += 1;
        args.maxWaitMs = parseDiagnosticMaxWaitMs(raw);
        break;
      }
      case '--scenarios': {
        const raw = value(index, '--scenarios');
        index += 1;
        const names = raw.split(',').map((entry) => entry.trim()).filter(Boolean);
        if (names.length === 0) throw new Error('--scenarios requires at least one scenario name');
        for (const name of names) {
          // `--scenarios` selects only the required four; the optional
          // wallet-only scenario is appended exclusively via --wallet-only.
          if (!REQUIRED_SCENARIO_NAMES.includes(name as RequiredScenarioName)) {
            throw new Error(`unknown scenario ${name}; expected one of ${REQUIRED_SCENARIO_NAMES.join(', ')}`);
          }
        }
        args.scenarios = names as RequiredScenarioName[];
        break;
      }
      case '--mixed-pair': {
        const raw = value(index, '--mixed-pair');
        index += 1;
        const labels = raw.split(',').map((entry) => entry.trim()).filter(Boolean);
        if (labels.length !== 2) throw new Error('--mixed-pair requires exactly two roster labels');
        args.mixedPair = [labels[0]!, labels[1]!];
        break;
      }
      case '--json':
        args.jsonPath = value(index, '--json');
        index += 1;
        break;
      default:
        throw new Error(`unknown request-budget argument: ${argument}`);
    }
  }
  return args;
}

function roster(label: string): RosterSpec {
  const spec = ROSTER_MATRIX.find((candidate) => candidate.label === label);
  if (spec === undefined) {
    throw new Error(`unknown roster ${label}; expected one of ${ROSTER_MATRIX.map((entry) => entry.label).join(', ')}`);
  }
  return spec;
}

interface ScenarioPlan {
  name: ScenarioName;
  rosters: RosterSpec[];
}

function resolveScenarioPlans(args: BudgetArgs): ScenarioPlan[] {
  const names: RequiredScenarioName[] =
    args.scenarios ?? (args.smoke ? ['fresh-1H1A'] : [...REQUIRED_SCENARIO_NAMES]);
  const plans: ScenarioPlan[] = names.map((name) => {
    if (name === 'mixed-pair') {
      const rosters = [roster(args.mixedPair[0]), roster(args.mixedPair[1])];
      for (const spec of rosters) {
        if (spec.humans === 0 || spec.agents === 0) {
          throw new Error(`mixed-pair requires two mixed rosters (human + agent), saw ${spec.label}`);
        }
      }
      return { name, rosters };
    }
    return { name, rosters: [roster(name === 'fresh-1H1A' ? '1H1A' : name)] };
  });
  if (args.walletOnly) {
    // Optional pure-WALLET 2H gameplay appended after the selected scenarios;
    // it reuses the existing human pool sessions (no new nonce/login) and
    // never joins the required-four list.
    plans.push({ name: WALLET_ONLY_SCENARIO, rosters: [roster('2H')] });
  }
  return plans;
}

interface RoomRunRecord {
  label: string;
  roomId: string | null;
  tableId: string | null;
  status: string | null;
  providerRequests: number | null;
  persistedAttempts: number | null;
  humanDriver: HumanDriverStats | null;
  durationMs: number;
  error: string | null;
}

/** Minimal public product-room snapshot shape (no bodies, no credentials). */
export interface RoomSnapshot {
  id: string;
  name: string;
  status: string;
}

export interface ContaminationReport {
  /** Earlier-scenario rooms still non-terminal when this window started. */
  priorActiveRoomIds: string[];
  /** Any non-terminal rooms still present when this window ended. */
  stillActiveAfterIds: string[];
  /** This scenario's own rooms left non-terminal (failed cases). */
  currentFailedActiveIds: string[];
  budgetIsolation: 'isolated' | 'contaminated';
  source: string;
  snapshotError: string | null;
}

/**
 * Pure classification of failed-prior-room contamination from public product
 * room snapshots. Only ids/names/status are used; a scenario whose window
 * started with earlier rooms still ACTIVE is labeled `contaminated` so its
 * budget is never claimed isolated.
 */
export function classifyContamination(
  before: readonly RoomSnapshot[],
  after: readonly RoomSnapshot[],
  currentRoomNamePrefixes: readonly string[]
): Pick<ContaminationReport, 'priorActiveRoomIds' | 'stillActiveAfterIds' | 'currentFailedActiveIds'> {
  const nonTerminal = (room: RoomSnapshot): boolean =>
    room.status !== 'COMPLETE' && room.status !== 'FAILED';
  const priorActiveRoomIds = before.filter(nonTerminal).map((room) => room.id);
  const stillActive = after.filter(nonTerminal);
  return {
    priorActiveRoomIds,
    stillActiveAfterIds: stillActive.map((room) => room.id),
    currentFailedActiveIds: stillActive
      .filter(
        (room) =>
          currentRoomNamePrefixes.some((prefix) => room.name.startsWith(prefix)) &&
          !priorActiveRoomIds.includes(room.id)
      )
      .map((room) => room.id),
  };
}

interface ScenarioRecord {
  name: string;
  rosters: string[];
  startedAt: number;
  endedAt: number;
  durationMs: number;
  maxConcurrentRooms: number;
  platform429Before: number | null;
  platform429After: number | null;
  platform429Delta: number | null;
  /** Authoritative per-route 429 delta (all actors, SDK retries included). */
  platform429ByRoute: PlatformRoute429[];
  /** Authoritative per-category HTTP delta (all actors; includes bypass traffic). */
  authoritative: PlatformHttpDelta | null;
  /** Proxy-vs-authoritative coverage comparison for this scenario window. */
  coverage: {
    proxyCoveredTotal: number;
    authoritativeTotal: number | null;
    /** Direct `/metrics` sampling reads counted inside the authoritative delta. */
    metricsSamplingTotal: number | null;
    /** Bounded measurement retries after the metrics endpoint itself 429'd. */
    metricsReadRetries: number;
    /** Authoritative minus direct /metrics sampling minus proxy-covered. */
    unmatchedBeyondProxies: number | null;
    rollingPeakCoverage: string;
  };
  accounting: { product: AccountingSummary; harness: AccountingSummary; combined: AccountingSummary };
  rooms: RoomRunRecord[];
  /** Failed-prior-room contamination metadata (budget never claimed isolated). */
  contamination: ContaminationReport;
  error: string | null;
}

interface RoomPlan {
  spec: RosterSpec;
  label: string;
  humans: WalletSession[];
  agentIds: string[];
}

function planRooms(plan: ScenarioPlan, humans: readonly WalletSession[], agents: readonly ProvisionedAgent[]): RoomPlan[] {
  let humanCursor = 0;
  let agentCursor = 0;
  return plan.rosters.map((spec, index) => {
    if (humanCursor + spec.humans > humans.length) {
      throw new Error(`${plan.name}: needs ${humanCursor + spec.humans} human sessions, only ${humans.length} available`);
    }
    if (agentCursor + spec.agents > agents.length) {
      throw new Error(`${plan.name}: needs ${agentCursor + spec.agents} agents, only ${agents.length} available`);
    }
    const room: RoomPlan = {
      spec,
      label: plan.rosters.length > 1 ? `${spec.label}-${index + 1}` : spec.label,
      humans: humans.slice(humanCursor, humanCursor + spec.humans),
      agentIds: agents.slice(agentCursor, agentCursor + spec.agents).map((agent) => agent.agentId),
    };
    humanCursor += spec.humans;
    agentCursor += spec.agents;
    return room;
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface ScenarioDeps {
  context: RunContext;
  environment: TestEnvironment;
  product: ProductClient;
  humans: WalletSession[];
  agents: ProvisionedAgent[];
  agentPrincipalIds: ReadonlySet<string>;
  provider: FakeProviderHandle;
  productDatabasePath: string;
  productProxy: RequestAccountingProxy;
  harnessProxy: RequestAccountingProxy;
  topology: StagingTopology;
  sanitize: (value: string) => string;
  /** Diagnostic scenario wait (runProductRoom maxWaitMs); never a provider cap. */
  maxWaitMs: number;
}

async function executeScenario(
  plan: ScenarioPlan,
  deps: ScenarioDeps,
  countersBeforeInput: PlatformHttpCounterSample | null
): Promise<{ record: ScenarioRecord; countersAfter: PlatformHttpCounterSample | null }> {
  const rooms = planRooms(plan, deps.humans, deps.agents);
  const rosters = plan.rosters.map((spec) => spec.label);
  let active = 0;
  let maxConcurrentRooms = 0;
  let metricsError: string | null = null;
  let metricsReadRetries = 0;
  let snapshotError: string | null = null;

  const snapshotRooms = async (): Promise<RoomSnapshot[]> => {
    try {
      const payload = await deps.product.getRooms();
      return payload.rooms.map((room) => ({ id: room.id, name: room.name, status: room.status }));
    } catch (error) {
      snapshotError = snapshotError ?? errorText(error);
      return [];
    }
  };

  const readMetrics = (label: string): Promise<PlatformHttpCounterSample> =>
    readPlatformHttpCountersWithRetry(deps.topology.platformMetrics, {
      log: (message) => deps.context.log(`  ${label}: ${message}`),
      onRetry: () => {
        metricsReadRetries += 1;
      },
    });

  // Boundary samples are threaded between scenarios: the previous scenario's
  // after-sample is this scenario's before-sample, so no extra direct
  // `/metrics` request is inserted at the boundary when a sample is available.
  let countersBefore = countersBeforeInput;
  if (countersBefore === null) {
    try {
      countersBefore = await readMetrics('metrics before');
    } catch (error) {
      metricsError = `platform metrics before read failed: ${errorText(error)}`;
    }
  }
  // Public room snapshot BEFORE this scenario's rooms are created: any
  // non-terminal room here is a failed prior case whose traffic still shares
  // this scenario's platform budget (recorded, never claimed isolated).
  const beforeSnapshot = await snapshotRooms();
  const startedAt = Date.now();

  const runRoom = async (room: RoomPlan): Promise<RoomRunRecord> => {
    const roomStartedAt = Date.now();
    try {
      const result = await runProductRoom({
        spec: { ...room.spec, label: room.label },
        context: deps.context,
        environment: deps.environment,
        product: deps.product,
        humans: room.humans,
        agentIds: room.agentIds,
        agentPrincipalIds: deps.agentPrincipalIds,
        fakeProvider: deps.provider,
        productDatabasePath: deps.productDatabasePath,
        // Diagnostic wait only (CLI --max-wait-ms); provider caps unchanged.
        maxWaitMs: deps.maxWaitMs,
        onActive: async () => {
          active += 1;
          maxConcurrentRooms = Math.max(maxConcurrentRooms, active);
        },
        onTerminal: async () => {
          active = Math.max(0, active - 1);
        },
      });
      return {
        label: room.label,
        roomId: result.room.id,
        tableId: result.tableId,
        status: result.room.status,
        providerRequests: result.providerRequests,
        persistedAttempts: result.persistedAttempts,
        humanDriver: result.humanDriver,
        durationMs: Date.now() - roomStartedAt,
        error: null,
      };
    } catch (error) {
      // A failed room may still be orchestrated by the product; cancel it
      // (product API only, no platform pacing change) so it cannot pollute the
      // next scenario's request window.
      let cleanupNote = '';
      try {
        const rooms = await deps.product.getRooms();
        const stale = rooms.rooms.filter(
          (candidate) =>
            candidate.name.startsWith(`accept-${room.label}-`) &&
            (candidate.status === 'ACTIVE' ||
              candidate.status === 'PROVISIONING' ||
              candidate.status === 'WAITING_FOR_ROSTER')
        );
        for (const candidate of stale) {
          await deps.product.cancelRoom(candidate.id);
          cleanupNote += `; cancelled stale room ${candidate.id}`;
        }
      } catch (cleanupError) {
        cleanupNote = `; stale-room cleanup failed: ${errorText(cleanupError)}`;
      }
      return {
        label: room.label,
        roomId: null,
        tableId: null,
        status: null,
        providerRequests: null,
        persistedAttempts: null,
        humanDriver: null,
        durationMs: Date.now() - roomStartedAt,
        error: deps.sanitize(`${errorText(error)}${cleanupNote}`),
      };
    }
  };

  const records = await Promise.all(rooms.map((room) => runRoom(room)));
  const endedAt = Date.now();
  const afterSnapshot = await snapshotRooms();
  const contaminationFields = classifyContamination(
    beforeSnapshot,
    afterSnapshot,
    rooms.map((room) => `accept-${room.label}-`)
  );
  const contamination: ContaminationReport = {
    ...contaminationFields,
    budgetIsolation:
      contaminationFields.priorActiveRoomIds.length === 0 ? 'isolated' : 'contaminated',
    source: 'public product room snapshots (/api/rooms, read-only ids/names/status only)',
    snapshotError,
  };

  let countersAfter: PlatformHttpCounterSample | null = null;
  try {
    countersAfter = await readMetrics('metrics after');
  } catch (error) {
    metricsError = metricsError ?? `platform metrics after read failed: ${errorText(error)}`;
  }

  const window = { startAt: startedAt, endAt: endedAt };
  const product = summarizeAccounting(deps.productProxy.entries, window);
  const harness = summarizeAccounting(deps.harnessProxy.entries, window);
  const combined = summarizeAccounting([...deps.productProxy.entries, ...deps.harnessProxy.entries], window);
  const failedRooms = records.filter((record) => record.error !== null);
  const error =
    metricsError ??
    (failedRooms.length > 0 ? `${failedRooms.length}/${records.length} room(s) failed (see rooms)` : null);
  const platform429Delta =
    countersBefore !== null && countersAfter !== null ? countersAfter.total429 - countersBefore.total429 : null;
  const authoritative =
    countersBefore !== null && countersAfter !== null
      ? platformHttpDeltaByCategory(countersBefore, countersAfter)
      : null;
  const coverage = coverageComparison(authoritative, combined.total);

  const record: ScenarioRecord = {
    name: plan.name,
    rosters,
    startedAt,
    endedAt,
    durationMs: endedAt - startedAt,
    maxConcurrentRooms,
    platform429Before: countersBefore?.total429 ?? null,
    platform429After: countersAfter?.total429 ?? null,
    platform429Delta,
    platform429ByRoute:
      countersBefore !== null && countersAfter !== null ? platform429DeltaByRoute(countersBefore, countersAfter) : [],
    authoritative,
    coverage: {
      proxyCoveredTotal: combined.total,
      ...coverage,
      metricsReadRetries,
      rollingPeakCoverage:
        'peakRolling60s covers proxy-covered product+human-harness requests only; authoritative /metrics totals may include fixture/probe or platform-internal traffic that bypasses the proxies',
    },
    accounting: { product, harness, combined },
    rooms: records,
    contamination,
    error,
  };
  return { record, countersAfter };
}

function printSummary(label: string, summary: AccountingSummary): void {
  const peak = summary.peakRolling60s;
  // eslint-disable-next-line no-console
  console.log(`  ${label}: total=${summary.total} ${formatCategoryCounts(summary.byCategory)}`);
  // eslint-disable-next-line no-console
  console.log(
    `    429 proxy=${summary.status429} (${formatCategoryCounts(summary.status429ByCategory)})${
      peak === null ? '' : ` peak60s=${peak.count}`
    } per-minute=${summary.perMinute.map((minute) => `m${minute.minute}=${minute.total}`).join(' ')}`
  );
}

/**
 * Parallel-writes one room record to the console as it settles (avoids a long
 * silent gap during a scenario). `runProductRoom` already logs the room itself.
 */
async function runBudget(args: BudgetArgs): Promise<number> {
  const fixture = process.env.NLHE_IT_STAGING_FIXTURE;
  if (fixture === undefined || !isAbsolute(fixture)) {
    console.error(
      'BLOCKED: NLHE_IT_STAGING_FIXTURE is required (absolute path to the built external staging fixture exporting startStagingPlatform)'
    );
    return 2;
  }
  const plans = resolveScenarioPlans(args);

  const context = createRunContext({ keep: args.keep });
  context.log(`PhaseC unpaid request-accounting ${context.runId}`);
  context.log(`artifacts: ${context.artifactDir}`);
  context.log(`scenarios: ${plans.map((plan) => `${plan.name}[${plan.rosters.map((spec) => spec.label).join('+')}]`).join(', ')}`);
  context.log(
    `diagnostic scenario wait: ${args.maxWaitMs}ms (runProductRoom maxWaitMs only; provider caps unchanged: calls=5000 runtime=600000 hands=100)`
  );
  context.log(`documented human driver pacing (unchanged): ${JSON.stringify(HUMAN_DRIVER_PACING)}`);
  context.log(`fixture: ${fixture}`);

  let topology: StagingTopology | null = null;
  let provider: FakeProviderHandle | null = null;
  let nlhe: NlheHandle | null = null;
  let productProxy: RequestAccountingProxy | null = null;
  let harnessProxy: RequestAccountingProxy | null = null;
  let failure: string | null = null;
  let proxyStartedAt: number | null = null;
  let baselineCounters: PlatformHttpCounterSample | null = null;
  let baselineError: string | null = null;
  let setupEndCounters: PlatformHttpCounterSample | null = null;
  let finalCounters: PlatformHttpCounterSample | null = null;
  let metricsReadRetries = 0;
  const scenarios: ScenarioRecord[] = [];
  let sanitize: (value: string) => string = (value) => value;

  try {
    topology = await startStagingTopology({
      context,
      sponsor: { principalId: randomUUID(), address: getAccount(2).address },
    });
    sanitize = (value) => topology!.secretRegistry.redact(value);
    context.log(`platform image: ${topology.platformImage}`);
    context.log(
      topology.platformImage === PUBLISHED_PLATFORM_2_0_0_IMAGE
        ? 'platform image is the central released pinned digest'
        : 'external platform override: publication/version must be verified separately (not a released-artifact claim)'
    );

    // Authoritative baseline BEFORE operator/provisioning setup, so the setup
    // traffic budget can be reported separately from scenario traffic.
    try {
      baselineCounters = await readPlatformHttpCountersWithRetry(topology.platformMetrics, {
        log: (message) => context.log(`baseline: ${message}`),
        onRetry: () => {
          metricsReadRetries += 1;
        },
      });
      context.log(
        `authoritative baseline before setup: total429=${baselineCounters.total429} routeSeries=${baselineCounters.counts.size}`
      );
    } catch (error) {
      baselineError = `authoritative baseline read failed: ${errorText(error)}`;
      context.log(`WARNING: ${baselineError}`);
    }

    // Explicit infrastructure: operator wallet, orchestrator credential, the
    // durable SERVICE principals the fake agents reference. Setup traffic stays
    // direct (outside the accounting proxies and outside scenario windows).
    const admin = await loginWallet(topology.platformUrl, ephemeralWallet());
    const promotion = await ensureOperator(topology.adminTarget, admin);
    if (!promotion.promoted) throw new Error('request-budget operator wallet was not promoted to ADMIN');
    const orchestrator = await mintOrchestrationToken(admin);
    const agents = await provisionFakeAgentPrincipals(admin, AGENT_POOL_SIZE, {
      delegatedToPrincipalId: orchestrator.principalId,
    });
    const agentPrincipalIds = new Set(agents.map((agent) => agent.principalId));
    provider = await startFakeProvider();
    const providerHost = new URL(provider.baseUrl).hostname;
    if (providerHost !== '127.0.0.1' && providerHost !== 'localhost') {
      throw new Error(`fake provider must be loopback, saw ${providerHost}`);
    }
    const rosterFile = await writeFakeAgentRoster(context, {
      baseUrl: provider.baseUrl,
      principals: agents,
    });
    const adminToken = productAdminToken();
    topology.addProductSecret('PRODUCT_ADMIN_TOKEN', adminToken);
    topology.addProductSecret('POKERTOOLS_ORCHESTRATION_TOKEN', orchestrator.token);
    topology.addProductSecret('OPENAI_API_KEY', FIXTURE_API_KEY);

    // Two independent accounting proxies: product runtime traffic and human
    // harness SDK traffic, both against the same actual platform.
    productProxy = await startRequestAccountingProxy({ upstream: topology.platformUrl });
    harnessProxy = await startRequestAccountingProxy({ upstream: topology.platformUrl });
    proxyStartedAt = Date.now();
    context.log(`product accounting proxy: ${productProxy.url} -> ${topology.platformUrl}`);
    context.log(`harness accounting proxy: ${harnessProxy.url} -> ${topology.platformUrl}`);

    await ensureNlheBuild(context);
    const productDatabasePath = join(context.artifactDir, 'nlhe-request-budget.sqlite');
    nlhe = await startNlhe(context, {
      platformBaseUrl: productProxy.url,
      openaiBaseUrl: provider.baseUrl,
      openaiApiKey: FIXTURE_API_KEY,
      openaiModel: FIXTURE_MODEL,
      databasePath: productDatabasePath,
      agentsConfigPath: rosterFile.path,
      // EXACT deterministic acceptance settings (tests/integration/acceptance/
      // run.ts). Provider caps are never raised for this diagnostic.
      maxProviderCalls: 5_000,
      maxCostUsdMicro: 0,
      perCallTimeoutMs: 5000,
      overallRuntimeMs: 600_000,
      maxHands: 100,
      extraEnv: {
        POKERTOOLS_ORCHESTRATION_TOKEN: orchestrator.token,
        PRODUCT_ADMIN_TOKEN: adminToken,
        AGENT_CHAT_ENABLED: '1',
        MAX_PROVIDER_CONCURRENCY: '8',
        CHALLENGE_ENABLED: '0',
      },
    });
    const product = new ProductClient(nlhe.baseUrl, { adminToken });

    // Human pool: maximum four seats across two simultaneous 2H2A rooms. The
    // sessions talk to the platform through the harness accounting proxy.
    const humans: WalletSession[] = [];
    for (let index = 0; index < HUMAN_POOL_SIZE; index += 1) {
      humans.push(await loginWallet(harnessProxy.url, ephemeralWallet()));
    }
    context.log(`human pool ready: ${humans.length} real SIWE sessions through the harness proxy`);

    const environment: TestEnvironment = {
      context,
      platform: {
        baseUrl: topology.platformUrl,
        port: Number(new URL(topology.platformUrl).port),
        databaseUrl: topology.databaseUrl,
        redisUrl: topology.redisUrl,
        stop: async () => undefined,
      },
      fakeProvider: provider,
      postgres: null,
      redis: null,
      adminTarget: topology.adminTarget,
      reusedExternalPlatform: true,
      financial: null,
      stop: async () => undefined,
    };
    const deps: ScenarioDeps = {
      context,
      environment,
      product,
      humans,
      agents,
      agentPrincipalIds,
      provider,
      productDatabasePath,
      productProxy,
      harnessProxy,
      topology,
      sanitize,
      maxWaitMs: args.maxWaitMs,
    };

    // Authoritative setup-end sample: separates operator bootstrap, service
    // principal provisioning and human SIWE logins from scenario windows. It
    // also serves as the first scenario's before-sample (threaded boundary).
    if (baselineCounters !== null) {
      try {
        setupEndCounters = await readPlatformHttpCountersWithRetry(topology.platformMetrics, {
          log: (message) => context.log(`setup-end: ${message}`),
          onRetry: () => {
            metricsReadRetries += 1;
          },
        });
      } catch (error) {
        baselineError = baselineError ?? `authoritative setup-end read failed: ${errorText(error)}`;
        context.log(`WARNING: ${baselineError}`);
      }
    }

    let boundaryCounters: PlatformHttpCounterSample | null = setupEndCounters;
    for (const plan of plans) {
      context.log(`scenario ${plan.name}: ${plan.rosters.map((spec) => spec.label).join(' + ')}`);
      const { record, countersAfter } = await executeScenario(plan, deps, boundaryCounters);
      boundaryCounters = countersAfter;
      scenarios.push(record);
      context.log(
        `scenario ${record.name} done: rooms=${record.rooms.filter((room) => room.error === null).length}/${
          record.rooms.length
        } maxConcurrent=${record.maxConcurrentRooms} duration=${(record.durationMs / 1000).toFixed(1)}s platform429Delta=${record.platform429Delta}${
          record.platform429ByRoute.length === 0
            ? ''
            : ` authoritative429ByRoute=[${record.platform429ByRoute
                .map((route) => `${route.method} ${route.route}=${route.count}`)
                .join(', ')}]`
        }`
      );
      printSummary('product', record.accounting.product);
      printSummary('harness', record.accounting.harness);
      printSummary('combined', record.accounting.combined);
      if (record.authoritative !== null) {
        // eslint-disable-next-line no-console
        console.log(
          `  authoritative(/metrics, all actors): total=${record.authoritative.total} ${formatCategoryCounts(
            record.authoritative.byCategory
          )} unmatchedVsProxy=${record.coverage.unmatchedBeyondProxies} metricsSampling=${
            record.coverage.metricsSamplingTotal ?? '-'
          }`
        );
      }
      const throttle = record.accounting.combined.throttle;
      if (throttle.byLimit.length > 0) {
        // eslint-disable-next-line no-console
        console.log(
          `  headroom(numeric x-ratelimit only): appMax100.minimumRemaining=${
            throttle.appMax100?.minimumRemaining ?? '-'
          } headroomPercent=${throttle.appMax100?.headroomPercent ?? '-'} auth5.minimumRemaining=${
            throttle.auth5?.minimumRemaining ?? '-'
          } auth10.minimumRemaining=${throttle.auth10?.minimumRemaining ?? '-'} otherLimits=[${throttle.otherLimits
            .map((bucket) => `${bucket.limit}:${bucket.minimumRemaining}`)
            .join(',')}]`
        );
      }
      for (const room of record.rooms) {
        context.log(
          `  room ${room.label}: status=${room.status ?? 'FAILED'} table=${room.tableId ?? '-'} providerRequests=${
            room.providerRequests ?? '-'
          } persistedAttempts=${room.persistedAttempts ?? '-'}${
            room.humanDriver === null
              ? ''
              : ` humanDriver[observations=${room.humanDriver.observations} actions=${room.humanDriver.actions} 429s=${room.humanDriver.rateLimitResponses}]`
          }${room.error === null ? '' : ` error=${room.error}`}`
        );
      }
      if (record.error !== null) context.log(`  WARNING scenario ${record.name}: ${record.error}`);
      const contamination = record.contamination;
      if (
        contamination.priorActiveRoomIds.length > 0 ||
        contamination.currentFailedActiveIds.length > 0 ||
        contamination.snapshotError !== null
      ) {
        context.log(
          `  contamination: budgetIsolation=${contamination.budgetIsolation} priorActive=[${contamination.priorActiveRoomIds.join(
            ','
          )}] currentFailedActive=[${contamination.currentFailedActiveIds.join(',')}] stillActiveAfter=[${contamination.stillActiveAfterIds.join(
            ','
          )}]${contamination.snapshotError === null ? '' : ` snapshotError=${contamination.snapshotError}`}`
        );
      }
    }

    const succeededRooms = scenarios.flatMap((scenario) => scenario.rooms).filter((room) => room.error === null);
    if (succeededRooms.length === 0) {
      failure = 'no room completed; scenario outcomes failed (proxy + authoritative accounting is still captured in this report)';
    }
    // The last scenario's after-sample is the final boundary sample; no extra
    // direct /metrics request is inserted after the matrix.
    finalCounters = boundaryCounters;
  } catch (error) {
    failure = sanitize(errorText(error));
    context.log(`request-budget run FAIL: ${failure}`);
  } finally {
    try {
      await nlhe?.stop();
    } catch (error) {
      context.log(`teardown: product stop failed: ${sanitize(errorText(error))}`);
    }
    try {
      await provider?.stop();
    } catch (error) {
      context.log(`teardown: provider stop failed: ${sanitize(errorText(error))}`);
    }
    try {
      await productProxy?.stop();
    } catch (error) {
      context.log(`teardown: product proxy stop failed: ${sanitize(errorText(error))}`);
    }
    try {
      await harnessProxy?.stop();
    } catch (error) {
      context.log(`teardown: harness proxy stop failed: ${sanitize(errorText(error))}`);
    }
    if (topology !== null) {
      try {
        const errors = await topology.stop();
        for (const cleanupError of errors) context.log(`teardown: ${sanitize(cleanupError)}`);
      } catch (error) {
        context.log(`teardown: topology stop failed: ${sanitize(errorText(error))}`);
      }
    }
  }

  const firstStart = scenarios.length > 0 ? scenarios[0]!.startedAt : null;
  const lastEnd = scenarios.length > 0 ? scenarios[scenarios.length - 1]!.endedAt : null;
  const productEntries = productProxy?.entries ?? [];
  const harnessEntries = harnessProxy?.entries ?? [];
  const combinedEntries = [...productEntries, ...harnessEntries];
  const overall =
    firstStart !== null && lastEnd !== null
      ? summarizeAccounting(combinedEntries, { startAt: firstStart, endAt: lastEnd })
      : null;
  const setupProxy =
    proxyStartedAt !== null && firstStart !== null && firstStart > proxyStartedAt
      ? summarizeAccounting(combinedEntries, { startAt: proxyStartedAt, endAt: firstStart })
      : null;
  const setupAuthoritative =
    baselineCounters !== null && setupEndCounters !== null
      ? platformHttpDeltaByCategory(baselineCounters, setupEndCounters)
      : null;
  const overallAuthoritative =
    setupEndCounters !== null && finalCounters !== null
      ? platformHttpDeltaByCategory(setupEndCounters, finalCounters)
      : baselineCounters !== null && finalCounters !== null
        ? platformHttpDeltaByCategory(baselineCounters, finalCounters)
        : null;

  const scenarioFailures = scenarios.filter(
    (scenario) =>
      scenario.error !== null ||
      scenario.platform429Before === null ||
      scenario.platform429After === null ||
      scenario.authoritative === null ||
      scenario.rooms.length === 0 ||
      scenario.rooms.every((room) => room.error !== null)
  );
  if (failure === null && scenarioFailures.length > 0) {
    failure = `${scenarioFailures.length}/${scenarios.length} scenario(s) failed or lacked authoritative metrics`;
  }
  const accountingRecorded =
    scenarios.length > 0 &&
    scenarios.every(
      (scenario) =>
        scenario.platform429Before !== null &&
        scenario.platform429After !== null &&
        scenario.authoritative !== null
    );
  const code = failure === null && accountingRecorded ? 0 : 1;

  const requiredScenarios = [...REQUIRED_SCENARIO_NAMES];
  const accountedScenarios = scenarios
    .filter(
      (scenario) =>
        scenario.authoritative !== null &&
        scenario.platform429Before !== null &&
        scenario.platform429After !== null
    )
    .map((scenario) => scenario.name);
  const completedScenarios = scenarios
    .filter((scenario) => scenario.rooms.length > 0 && scenario.rooms.every((room) => room.error === null))
    .map((scenario) => scenario.name);
  const allFourAccounted = requiredScenarios.every((name) => accountedScenarios.includes(name));
  const allFourCompleted = requiredScenarios.every((name) => completedScenarios.includes(name));
  const contaminatedScenarios = scenarios
    .filter((scenario) => scenario.contamination.budgetIsolation === 'contaminated')
    .map((scenario) => scenario.name);
  const walletOnlyRecord = scenarios.find((scenario) => scenario.name === WALLET_ONLY_SCENARIO) ?? null;
  const walletOnlyRoom = walletOnlyRecord?.rooms[0] ?? null;

  context.log('---- PhaseC request accounting summary ----');
  for (const scenario of scenarios) {
    context.log(
      `scenario ${scenario.name}: rosters=${scenario.rosters.join('+')} rooms=${
        scenario.rooms.filter((room) => room.error === null).length
      }/${scenario.rooms.length} maxConcurrent=${scenario.maxConcurrentRooms} duration=${(scenario.durationMs / 1000).toFixed(
        1
      )}s proxy429=${scenario.accounting.combined.status429} platform429Delta=${scenario.platform429Delta}`
    );
    printSummary('combined', scenario.accounting.combined);
  }
  if (overall !== null) {
    context.log(
      `overall [${scenarios[0]!.name}..${scenarios[scenarios.length - 1]!.name}]: duration=${(overall.durationMs / 1000).toFixed(1)}s`
    );
    printSummary('combined', overall);
  }
  if (setupProxy !== null && setupProxy.total > 0) printSummary('setup proxy (outside scenario windows)', setupProxy);
  if (setupAuthoritative !== null) {
    // eslint-disable-next-line no-console
    console.log(
      `setup authoritative(/metrics, all actors): total=${setupAuthoritative.total} ${formatCategoryCounts(
        setupAuthoritative.byCategory
      )}`
    );
  }
  if (overallAuthoritative !== null) {
    // eslint-disable-next-line no-console
    console.log(
      `overall authoritative(/metrics, all actors): total=${overallAuthoritative.total} ${formatCategoryCounts(
        overallAuthoritative.byCategory
      )}`
    );
  }

  const payload = {
    runId: context.runId,
    generatedAt: new Date().toISOString(),
    phase: 'C',
    kind: 'unpaid-request-accounting',
    platformImage: topology?.platformImage ?? process.env.NLHE_IT_PLATFORM_IMAGE ?? null,
    platformImageMatchesConfiguredDefault: (topology?.platformImage ?? null) === DEFAULT_PLATFORM_IMAGE,
    platformIsPublished2_0_0: topology?.platformImage === PUBLISHED_PLATFORM_2_0_0_IMAGE,
    platformPatchNote:
      'accounting is bound to the platform image above; do not compare across different platform images',
    product: {
      mode: 'host-process',
      baseUrl: nlhe?.baseUrl ?? null,
      database: join(context.artifactDir, 'nlhe-request-budget.sqlite'),
    },
    fakeProvider: { baseUrl: provider?.baseUrl ?? null, mode: provider?.getMode() ?? null },
    humanDriverPacing: HUMAN_DRIVER_PACING,
    diagnosticWait: {
      maxWaitMs: args.maxWaitMs,
      defaultMaxWaitMs: DEFAULT_DIAGNOSTIC_MAX_WAIT_MS,
      minimumMs: 60_000,
      note: 'diagnostic runProductRoom wait only (CLI --max-wait-ms); provider caps are never affected; minimum one budget minute',
    },
    caps: {
      maxProviderCalls: 5_000,
      overallRuntimeMs: 600_000,
      maxHands: 100,
      maxProviderConcurrency: 8,
      agentChat: 'enabled (unchanged)',
      note: 'exact deterministic acceptance settings (tests/integration/acceptance/run.ts); provider caps are never raised for this diagnostic',
    },
    platformLimits: {
      appRequestsPerMinute: 100,
      networkRequestsPerMinute: 1000,
      note: 'production defaults preserved; the legacy runProductionAcceptance.sh 100000 override is never used',
    },
    scenarioPlans: plans.map((plan) => ({ name: plan.name, rosters: plan.rosters.map((spec) => spec.label) })),
    accountingSource: {
      proxy:
        'loopback accounting HTTP proxy in front of the platform; product and harness measured separately and combined',
      authoritative:
        'platform /metrics pokertools_http_requests_total{method,route,status} delta read directly; includes every actor and requests that bypass the proxies',
    },
    coverage: {
      traceScope:
        'all NLHE product platform traffic (product proxy) and all human harness SDK traffic (harness proxy) is forced through the accounting proxies for the entire run; setup traffic budgeted separately',
      rollingPeak:
        'combined proxy peakRolling60s covers product+human-harness proxy traffic only; it is not a whole-platform peak when any request bypasses the proxies',
      excludedFromProxies: [
        'direct operator bootstrap (ADMIN promotion SQL), service-principal provisioning and orchestrator credential mint before the scenario windows',
        'platform /metrics reads used for authoritative sampling',
        'any fixture/platform-internal HTTP, if present, never touches the proxies',
      ],
      unmatched:
        'per scenario: authoritativeTotal - direct /metrics sampling - proxyCoveredTotal; positive means fixture/probe/platform-internal HTTP outside the proxies, reported (never hidden), and negative is at most a boundary-sampling artifact',
      metricsSampling:
        'authoritative deltas include the direct /metrics sampling reads used to take them; metricsSamplingTotal records that count so the comparison excludes it',
      measurementRetries:
        'direct /metrics sampling may retry (bounded, honoring retry-after) when the platform itself answers the sample with HTTP 429 during saturation; retries are measurement-only and never alter in-scenario product or human pacing',
      boundaryThreading:
        'the previous scenario after-sample is the next scenario before-sample, so no extra direct /metrics request is inserted at scenario boundaries',
    },
    perIdentity: {
      available: false,
      reason:
        'Platform /metrics carries no principal label, and product agent credentials are minted by the platform into the product per table (never exposed to the harness). Per-identity attribution would require reading Authorization headers or persisting tokens, which the accounting contract forbids. Human harness identities are available only as harness-proxy totals, not per principal; no per-identity rolling 60s is therefore reported.',
    },
    phaseC: {
      requiredScenarios,
      accountedScenarios,
      allFourAccounted,
      completedScenarios,
      allFourCompleted,
      optionalScenarios: args.walletOnly ? [WALLET_ONLY_SCENARIO] : [],
      optionalAccountedScenarios: walletOnlyRecord !== null && walletOnlyRecord.authoritative !== null ? [WALLET_ONLY_SCENARIO] : [],
      optionalCompletedScenarios:
        walletOnlyRecord !== null && walletOnlyRecord.rooms.length > 0 && walletOnlyRecord.rooms.every((room) => room.error === null)
          ? [WALLET_ONLY_SCENARIO]
          : [],
      zero429Gate: 'disabled: 429 counts are diagnostic evidence only and never gate the platform patch decision by themselves',
      semantics: {
        accounted:
          'all four scenarios ran with both proxy and authoritative counter coverage; legacy-platform 429s may leave rooms non-terminal without invalidating the accounting (user C)',
        completed:
          'every room in every scenario reached a terminal state; this is expected to be true only after the platform limiter patch (user E)',
      },
      note: 'all four PhaseC scenarios must be accounted (proxy + authoritative counters) before this report supports the rate-limiter implementation decision; completion is reported separately',
    },
    contaminationSummary: {
      contaminatedScenarios,
      note: 'a scenario is contaminated when an earlier scenario left a room non-terminal; its budget then also carries that room\'s traffic and is never claimed isolated',
    },
    walletOnly: {
      requested: args.walletOnly,
      scenario: WALLET_ONLY_SCENARIO,
      present: walletOnlyRecord !== null,
      accounted: walletOnlyRecord !== null ? walletOnlyRecord.authoritative !== null : null,
      completed:
        walletOnlyRecord === null
          ? null
          : walletOnlyRecord.rooms.length > 0 && walletOnlyRecord.rooms.every((room) => room.error === null),
      roomStatus: walletOnlyRoom?.status ?? null,
      roomReadiness:
        walletOnlyRoom === null ? null : walletOnlyRoom.status === 'COMPLETE' ? 'COMPLETE' : walletOnlyRoom.status,
      providerRequests: walletOnlyRoom?.providerRequests ?? null,
      zeroProviderRequests:
        walletOnlyRoom === null || walletOnlyRoom.providerRequests === null
          ? null
          : walletOnlyRoom.providerRequests === 0,
      humanDriver: walletOnlyRoom?.humanDriver ?? null,
      metrics:
        walletOnlyRecord === null
          ? null
          : {
              proxyCoveredTotal: walletOnlyRecord.accounting.combined.total,
              status429: walletOnlyRecord.accounting.combined.status429,
              perMinute: walletOnlyRecord.accounting.combined.perMinute,
              peakRolling60s: walletOnlyRecord.accounting.combined.peakRolling60s,
            },
      headroom: walletOnlyRecord?.accounting.combined.throttle ?? null,
      note: 'optional pure-WALLET 2H gameplay from the existing human pool (no additional nonce/login or identity hack); expected 0 provider requests and 0 agent decisions',
    },
    limitations: [
      'per-minute buckets are relative to each scenario start; empty minutes are retained',
      'proxy accounting covers all product and human-harness traffic; rolling peaks are proxy-covered only',
      'authoritative /metrics deltas cover all actors and any bypass traffic; unmatchedBeyondProxies quantifies the difference per scenario',
      '429s are diagnostic evidence and never fail the run by themselves; phaseC records accounted vs completed separately',
      'production platform rate limits are preserved; no sleep is inserted to evade them',
      'under saturation, authoritative /metrics sampling retries may space scenarios further apart; in-scenario product/human pacing is never altered',
      'the diagnostic --max-wait-ms only bounds how long the harness waits for settlement; it never changes provider caps',
      'contaminated scenarios (failed prior ACTIVE rooms) share their budget with that residual room traffic; see per-scenario contamination',
      'headroom is null when numeric throttle headers are absent (legacy platform), never a false zero; diagnostic C has no headroom gate',
      'only the numeric x-ratelimit-limit/remaining/reset headers are inspected; identity, authorization and cookie headers are never read',
      'per-identity (principal) rolling 60s is not reported; see perIdentity.reason',
    ],
    baselineError,
    metricsReadRetries,
    setup: {
      proxy: setupProxy,
      authoritative: setupAuthoritative,
      note: 'operator bootstrap, service-principal provisioning and human logins are direct/setup traffic; it is budgeted here authoritatively instead of being hidden inside scenario windows',
    },
    overallAuthoritative,
    headroom: {
      source:
        'standard numeric x-ratelimit-limit/remaining/reset response headers only (HTTP responses and WS upgrade responses); identity/auth headers, tokens and bodies are never captured',
      applicationBuckets: {
        appMax100: overall?.throttle.appMax100 ?? null,
        auth5: overall?.throttle.auth5 ?? null,
        auth10: overall?.throttle.auth10 ?? null,
        otherLimits: overall?.throttle.otherLimits ?? [],
        technicalTarget: {
          limit: 100,
          minimumRemaining: 25,
          met: overall?.throttle.technicalTarget.met ?? null,
        },
      },
      perScenario: scenarios.map((scenario) => ({
        name: scenario.name,
        throttle: scenario.accounting.combined.throttle,
      })),
      network: {
        basis:
          'proxy peak rolling-60s plus authoritative direct request upper bounds versus the default network limit',
        assumedNetworkLimit: 1000,
        proxyPeakRolling60s: overall?.peakRolling60s?.count ?? null,
        authoritativeTotal: overallAuthoritative?.total ?? null,
        note: 'network headroom uses the existing tracked peaks only; no network-level rate-limit header API is invented',
      },
      note: 'null means the headers were absent (legacy platform), never a false zero; diagnostic C is not gated on headroom and the technical target applies to final normal app traffic after the platform patch (user E)',
    },
    scenarios,
    overall,
    failure,
    exitCode: code,
  };
  const reportPath = args.jsonPath ?? join(context.artifactDir, 'request-budget.json');
  try {
    writeFileSync(reportPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    context.log(`request-budget report: ${reportPath}`);
  } catch (error) {
    console.error(`could not write request-budget report ${reportPath}: ${errorText(error)}`);
  }
  if (failure !== null) console.error(`PhaseC request accounting FAILED: ${failure}`);
  return code;
}

/** Offline self-test: loopback proxy round-trip, categorization, buckets, WS. */
async function runSelfTest(): Promise<number> {
  const { createServer } = await import('node:http');
  const { createHash } = await import('node:crypto');
  let actionAttempts = 0;
  let metrics429 = 3;
  let metricsAttempts = 0;
  let metrics429Remaining = 0;
  let metricsStatusOverride: number | null = null;
  const upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const path = req.url ?? '';
      const sendJson = (status: number, payload: unknown, headers: Record<string, string> = {}): void => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(payload));
      };
      if (path === '/metrics') {
        metricsAttempts += 1;
        if (metricsStatusOverride !== null) {
          const status = metricsStatusOverride;
          metricsStatusOverride = null;
          res.writeHead(status, { 'content-type': 'text/plain' });
          res.end('forced metrics failure');
          return;
        }
        if (metrics429Remaining > 0) {
          metrics429Remaining -= 1;
          res.writeHead(429, { 'content-type': 'text/plain', 'retry-after': '1' });
          res.end('rate limited');
          return;
        }
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(
          [
            '# HELP pokertools_http_requests_total HTTP requests observed by the API',
            '# TYPE pokertools_http_requests_total counter',
            `pokertools_http_requests_total{method="GET",route="/tables/:id/observation",status="429"} ${metrics429}`,
            `pokertools_http_requests_total{method="POST",route="/tables/:id/action",status="200"} 4`,
            'pokertools_http_requests_total{method="GET",route="/health",status="200"} 1',
          ].join('\n') + '\n'
        );
        return;
      }
      if (path.startsWith('/tables/T1/action')) {
        actionAttempts += 1;
        // Numeric throttle metadata: worst app-bucket remaining 0 on the 429.
        sendJson(actionAttempts === 1 ? 429 : 200, { attempt: actionAttempts }, {
          'x-ratelimit-limit': '100',
          'x-ratelimit-remaining': actionAttempts === 1 ? '0' : '24',
          'x-ratelimit-reset': actionAttempts === 1 ? '45' : '40',
          ...(actionAttempts === 1 ? { 'retry-after': '1' } : {}),
        });
        return;
      }
      if (path.startsWith('/tables/T1/replay')) {
        // Headers sent (flushed) then body deliberately truncated: must be
        // recorded exactly once (at headers) and must not crash the proxy.
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': '999' });
        res.flushHeaders();
        res.write('{"partial":');
        setTimeout(() => res.destroy(), 20);
        return;
      }
      if (path.startsWith('/tables/T1/observation')) {
        sendJson(200, { ok: true }, {
          'x-ratelimit-limit': '100',
          'x-ratelimit-remaining': '25',
          'x-ratelimit-reset': '30',
        });
        return;
      }
      if (path.startsWith('/tables/T1/chat')) {
        sendJson(200, { ok: true }, { 'x-ratelimit-limit': '100', 'x-ratelimit-remaining': '99' });
        return;
      }
      if (path.startsWith('/competitions/')) {
        sendJson(200, { ok: true }, { 'x-ratelimit-limit': '100', 'x-ratelimit-remaining': '50' });
        return;
      }
      if (path.startsWith('/auth/nonce')) {
        sendJson(200, { ok: true }, {
          'x-ratelimit-limit': '5',
          'x-ratelimit-remaining': '4',
          'x-ratelimit-reset': '12',
        });
        return;
      }
      if (path.startsWith('/tables/T1/buy-in')) {
        // Malformed throttle (remaining > limit) plus a sensitive-looking
        // response header: both must be ignored, never captured or leaked.
        res.writeHead(200, {
          'content-type': 'application/json',
          authorization: 'Bearer secret-token',
          'x-ratelimit-limit': '100',
          'x-ratelimit-remaining': '150',
        });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (path.startsWith('/notes')) {
        // Non-numeric throttle value that looks like a credential: ignored.
        sendJson(200, { ok: true }, {
          'x-ratelimit-limit': '100',
          'x-ratelimit-remaining': 'Bearer secret-token',
        });
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  upstream.on('upgrade', (req, socket) => {
    // An upgrade may be answered with a plain HTTP error; the proxy must count
    // it once and forward it instead of hanging the client socket.
    if ((req.url ?? '').startsWith('/ws/denied')) {
      socket.write('HTTP/1.1 401 Unauthorized\r\ncontent-type: text/plain\r\ncontent-length: 0\r\nconnection: close\r\n\r\n');
      socket.end();
      return;
    }
    if ((req.url ?? '').startsWith('/ws/notfound')) {
      socket.write('HTTP/1.1 404 Not Found\r\ncontent-type: text/plain\r\ncontent-length: 0\r\nconnection: close\r\n\r\n');
      socket.end();
      return;
    }
    if ((req.url ?? '').startsWith('/ws/reset')) {
      // Transport reset before any upgrade response: must be recorded once as
      // status 0 and must never crash the proxy.
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string') {
      socket.destroy();
      return;
    }
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nx-ratelimit-limit: 100\r\nx-ratelimit-remaining: 10\r\n\r\n`
    );
    socket.on('error', () => undefined);
    if ((req.url ?? '').startsWith('/ws/after101')) {
      // Transport reset immediately after a real 101: the exchange is a real
      // success and must be recorded exactly once (no phantom duplicate).
      setTimeout(() => socket.destroy(), 10);
    }
  });
  const upstreamPort = await new Promise<number>((resolve, reject) => {
    upstream.on('error', reject);
    upstream.listen(0, '127.0.0.1', () => {
      const address = upstream.address();
      if (address === null || typeof address === 'string') reject(new Error('self-test upstream did not bind'));
      else resolve(address.port);
    });
  });
  const upstreamSockets = new Set<import('node:net').Socket>();
  upstream.on('connection', (socket) => {
    upstreamSockets.add(socket);
    socket.on('close', () => upstreamSockets.delete(socket));
  });

  const proxy = await startRequestAccountingProxy({ upstream: `http://127.0.0.1:${upstreamPort}` });
  const startedAt = Date.now();
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
  const check = (name: string, ok: boolean, detail?: string): void => {
    checks.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
  };
  try {
    await fetch(`${proxy.url}/auth/nonce`, { method: 'POST' });
    await fetch(`${proxy.url}/tables/T1/observation`);
    await fetch(`${proxy.url}/tables/T1/chat?limit=10`);
    const first = await fetch(`${proxy.url}/tables/T1/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'self-test' }),
    });
    const retry = await fetch(`${proxy.url}/tables/T1/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'self-test' }),
    });
    check('first action attempt observed as 429', first.status === 429, `status=${first.status}`);
    check('retried action attempt observed as 200', retry.status === 200, `status=${retry.status}`);
    await fetch(`${proxy.url}/competitions/C1`);
    await fetch(`${proxy.url}/health`);
    await fetch(`${proxy.url}/webhooks/sekret-path`);

    const socket = new WebSocket(`ws://127.0.0.1:${proxy.port}/ws/play?token=self-test`);
    const opened = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 5_000);
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(true);
      });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
    check('WebSocket upgrade passes through the proxy', opened);
    try {
      socket.close();
    } catch {
      // Best effort; the proxy stop below destroys the socket.
    }
    const endedAt = Date.now();
    const summary = summarizeAccounting(proxy.entries, { startAt: startedAt, endAt: endedAt });
    check('all requests recorded', summary.total === 9, `total=${summary.total}`);
    check(
      'category classification',
      summary.byCategory.observation === 1 &&
        summary.byCategory.chat === 1 &&
        summary.byCategory.action === 2 &&
        summary.byCategory.competition === 1 &&
        summary.byCategory.other === 4,
      JSON.stringify(summary.byCategory)
    );
    check('429 counted once on action', summary.status429 === 1 && summary.status429ByCategory.action === 1);
    check('single per-minute bucket holds all requests', summary.perMinute.length === 1 && summary.perMinute[0]!.total === 9);
    check('peak rolling 60s counts all requests', summary.peakRolling60s?.count === 9);
    const actionRoute = summary.byRoute.find((route) => route.route === '/tables/:id/action');
    check(
      'action route aggregates attempts',
      actionRoute?.count === 2 && actionRoute.status429 === 1 && actionRoute.category === 'action',
      JSON.stringify(actionRoute)
    );
    const unknown = summary.byRoute.find((route) => route.route === 'unrecognized');
    check('unknown path stays opaque', unknown?.count === 1);
    check('no raw secret path in serialized accounting', !JSON.stringify(summary).includes('sekret'));

    // Numeric throttle headroom captured from whitelisted headers only.
    const liveThrottle = summary.throttle;
    check(
      'numeric throttle captured for HTTP and WS upgrade',
      liveThrottle.appMax100?.samples === 6 &&
        liveThrottle.appMax100.minimumRemaining === 0 &&
        liveThrottle.appMax100.maximumRemaining === 99 &&
        liveThrottle.appMax100.maximumReset === 45 &&
        liveThrottle.appMax100.headroomPercent === 0,
      JSON.stringify(liveThrottle.appMax100)
    );
    check(
      'auth buckets reported separately (5/10), caps never hidden',
      liveThrottle.auth5?.minimumRemaining === 4 &&
        liveThrottle.auth5.samples === 1 &&
        liveThrottle.auth10 === null &&
        liveThrottle.otherLimits.length === 0
    );
    check(
      'entries without throttle headers are counted, never zero-filled',
      liveThrottle.entriesWithThrottle === 7 && liveThrottle.entriesMissingThrottle === 2
    );
    check(
      'technical target met=false at zero remaining (diagnostic, no gate)',
      liveThrottle.technicalTarget.met === false && liveThrottle.technicalTarget.minimumRemaining === 25
    );

    const countersBefore = await readPlatformHttpCounters({ url: proxy.url });
    metrics429 = 5;
    const countersAfter = await readPlatformHttpCounters({ url: proxy.url });
    const route429 = platform429DeltaByRoute(countersBefore, countersAfter);
    check(
      'authoritative counter parse + per-route 429 delta',
      countersAfter.total429 - countersBefore.total429 === 2 &&
        route429.length === 1 &&
        route429[0]!.method === 'GET' &&
        route429[0]!.route === '/tables/:id/observation' &&
        route429[0]!.category === 'observation' &&
        route429[0]!.count === 2,
      JSON.stringify(route429)
    );
    const parsedRoute = await readPlatformHttpCounters({ url: proxy.url });
    check(
      'non-429 route counters are parsed authoritatively',
      parsedRoute.counts.get('POST /tables/:id/action 200') === 4 &&
        parsedRoute.counts.get('GET /health 200') === 1
    );
    const fullDelta = platformHttpDeltaByCategory(countersBefore, parsedRoute);
    check(
      'authoritative per-category HTTP delta',
      fullDelta.total === 2 &&
        fullDelta.byCategory.observation === 2 &&
        fullDelta.byRoute.length === 1 &&
        fullDelta.byRoute[0]!.route === '/tables/:id/observation',
      JSON.stringify(fullDelta.byCategory)
    );
    const coverageSample = coverageComparison(
      {
        total: 10,
        byCategory: { observation: 4, chat: 2, action: 2, competition: 0, other: 2 },
        byRoute: [
          { method: 'GET', route: '/metrics', category: 'other', count: 2 },
          { method: 'GET', route: '/tables/:id/observation', category: 'observation', count: 4 },
        ],
      },
      7
    );
    check(
      'coverage comparison excludes /metrics sampling',
      coverageSample.authoritativeTotal === 10 &&
        coverageSample.metricsSamplingTotal === 2 &&
        coverageSample.unmatchedBeyondProxies === 1,
      JSON.stringify(coverageSample)
    );
    check(
      'coverage comparison handles a missing authoritative sample',
      coverageComparison(null, 0).unmatchedBeyondProxies === null
    );

    // Malformed and sensitive throttle values on real responses: ignored, and
    // the request-side authorization header is never read into accounting.
    const beforeMalformed = proxy.entries.length;
    await fetch(`${proxy.url}/tables/T1/buy-in`, {
      headers: { authorization: 'Bearer secret-token' },
    });
    await fetch(`${proxy.url}/notes`, { headers: { authorization: 'Bearer secret-token' } });
    const malformedEntries = proxy.entries.slice(beforeMalformed);
    check(
      'malformed and sensitive throttle values are ignored (null, never zero)',
      malformedEntries.length === 2 && malformedEntries.every((entry) => entry.throttle === null),
      JSON.stringify(malformedEntries)
    );
    check(
      'no sensitive value leaks into accounting',
      !JSON.stringify(proxy.entries).includes('secret-token')
    );

    // Pure parser matrix: malformed, negative, over-limit, credential-shaped.
    check(
      'throttle parser drops malformed/negative/over-limit values',
      parseThrottleSamples({ 'x-ratelimit-limit': 'abc', 'x-ratelimit-remaining': '5' }) === null &&
        parseThrottleSamples({ 'x-ratelimit-limit': '100', 'x-ratelimit-remaining': '150' }) === null &&
        parseThrottleSamples({ 'x-ratelimit-limit': '-1', 'x-ratelimit-remaining': '0' }) === null &&
        parseThrottleSamples({ 'x-ratelimit-limit': '100', 'x-ratelimit-remaining': 'Bearer secret-token' }) ===
          null &&
        parseThrottleSamples({ 'x-ratelimit-remaining': '5' }) === null &&
        parseThrottleSamples({}) === null
    );
    const mixedSamples = parseThrottleSamples({
      'x-ratelimit-limit': ['100', 'junk'],
      'x-ratelimit-remaining': [' 25 ', '1'],
      'x-ratelimit-reset': 'nope',
    });
    check(
      'throttle parser keeps valid numeric samples and trims whitespace',
      mixedSamples !== null &&
        mixedSamples.length === 1 &&
        mixedSamples[0]!.limit === 100 &&
        mixedSamples[0]!.remaining === 25 &&
        mixedSamples[0]!.reset === null,
      JSON.stringify(mixedSamples)
    );

    // Min across windows with exactly one throttle record per request.
    const throttleEntries: AccountingEntry[] = [
      { at: 0, method: 'GET', route: '/tables/:id/observation', category: 'observation', status: 200, durationMs: 1, throttle: [{ limit: 100, remaining: 30, reset: 10 }] },
      { at: 1_000, method: 'GET', route: '/tables/:id/observation', category: 'observation', status: 200, durationMs: 1, throttle: [{ limit: 100, remaining: 10, reset: 20 }] },
      { at: 2_000, method: 'GET', route: '/tables/:id/observation', category: 'observation', status: 200, durationMs: 1, throttle: null },
      { at: 3_000, method: 'POST', route: '/auth/login', category: 'other', status: 200, durationMs: 1, throttle: [{ limit: 10, remaining: 9, reset: 5 }] },
    ];
    const firstWindow = summarizeAccounting(throttleEntries, { startAt: 0, endAt: 1_500 });
    const secondWindow = summarizeAccounting(throttleEntries, { startAt: 1_500, endAt: 3_500 });
    const combinedWindow = summarizeAccounting(throttleEntries, { startAt: 0, endAt: 3_500 });
    check(
      'throttle minimum across windows',
      firstWindow.throttle.appMax100?.minimumRemaining === 10 &&
        firstWindow.throttle.appMax100?.samples === 2 &&
        secondWindow.throttle.appMax100 === null &&
        secondWindow.throttle.auth10?.minimumRemaining === 9 &&
        combinedWindow.throttle.appMax100?.minimumRemaining === 10,
      JSON.stringify({
        first: firstWindow.throttle.appMax100,
        second: secondWindow.throttle.appMax100,
        combined: combinedWindow.throttle.appMax100,
      })
    );
    check(
      'one throttle record per request in summaries',
      combinedWindow.throttle.appMax100?.samples === 2 &&
        combinedWindow.throttle.entriesWithThrottle === 3 &&
        combinedWindow.throttle.entriesMissingThrottle === 1
    );
    check(
      'auth10 bucket reported separately',
      combinedWindow.throttle.auth10?.minimumRemaining === 9 &&
        combinedWindow.throttle.auth10.samples === 1 &&
        combinedWindow.throttle.otherLimits.length === 0
    );

    // Measurement retry: the platform's own global limiter can answer the
    // /metrics sample with 429 while the measured workload is saturated.
    const attemptsBeforeRetry = metricsAttempts;
    metrics429Remaining = 2;
    const retried = await readPlatformHttpCountersWithRetry(
      { url: proxy.url },
      { scheduleMs: [5, 5, 5, 5], maxAdvisedDelayMs: 5 }
    );
    const retryAttempts = metricsAttempts - attemptsBeforeRetry;
    check(
      'metrics sampling retries through HTTP 429',
      retried.total429 === 5 && retryAttempts === 3,
      `total429=${retried.total429} attempts=${retryAttempts}`
    );
    metricsStatusOverride = 500;
    let metricsFailure: string | null = null;
    try {
      await readPlatformHttpCountersWithRetry(
        { url: proxy.url },
        { scheduleMs: [5, 5, 5, 5], maxAdvisedDelayMs: 5 }
      );
    } catch (error) {
      metricsFailure = errorText(error);
    }
    check(
      'non-429 metrics failure is not retried',
      metricsFailure !== null &&
        metricsFailure.includes('HTTP 500') &&
        metricsAttempts - attemptsBeforeRetry - retryAttempts === 1,
      `failure=${metricsFailure ?? 'none'} attempts=${metricsAttempts - attemptsBeforeRetry - retryAttempts}`
    );

    // Exactly-once: a response whose body is truncated after headers.
    const beforeReplay = proxy.entries.filter((entry) => entry.route === '/tables/:id/replay').length;
    await fetch(`${proxy.url}/tables/T1/replay`).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const replayEntries = proxy.entries.filter((entry) => entry.route === '/tables/:id/replay');
    check(
      'upstream error after headers recorded exactly once',
      replayEntries.length === beforeReplay + 1 && replayEntries.at(-1)?.status === 200,
      JSON.stringify(replayEntries)
    );

    // Exactly-once: an upgrade answered with a plain HTTP 401. A raw HTTP
    // request is used so exactly one connection attempt is made (the global
    // WebSocket client may legitimately retry a failed handshake, which would
    // be two real exchanges and two correct records).
    const { request: rawHttpRequest } = await import('node:http');
    const beforeDenied = proxy.entries.filter((entry) => entry.route === 'unrecognized').length;
    const deniedStatus = await new Promise<number>((resolve, reject) => {
      const deniedRequest = rawHttpRequest(
        {
          host: '127.0.0.1',
          port: proxy.port,
          path: '/ws/denied',
          headers: {
            connection: 'Upgrade',
            upgrade: 'websocket',
            'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
            'sec-websocket-version': '13',
          },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        }
      );
      deniedRequest.on('upgrade', () => reject(new Error('unexpected 101 upgrade')));
      deniedRequest.on('error', reject);
      deniedRequest.end();
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const deniedEntries = proxy.entries.filter((entry) => entry.route === 'unrecognized');
    check(
      'upgrade answered with HTTP 401 recorded exactly once',
      deniedStatus === 401 &&
        deniedEntries.length === beforeDenied + 1 &&
        deniedEntries.at(-1)?.status === 401,
      `status=${deniedStatus} entries=${JSON.stringify(deniedEntries.slice(-2))}`
    );

    // ---- Transport fault injection: resets at every stage must be recorded
    // once, must tear down cleanly, and must never crash the process. ----
    const upgradeHeaders = {
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'sec-websocket-version': '13',
    };
    const rawUpgrade = (path: string): Promise<string> =>
      new Promise<string>((resolve) => {
        const request = rawHttpRequest(
          { host: '127.0.0.1', port: proxy.port, path, headers: upgradeHeaders },
          (response) => {
            response.resume();
            resolve(`response:${response.statusCode ?? 0}`);
          }
        );
        request.on('upgrade', () => resolve('upgrade'));
        request.on('error', (error: NodeJS.ErrnoException) =>
          resolve(`error:${error.code ?? error.message}`)
        );
        request.end();
      });

    const beforeReset = proxy.entries.length;
    const resetOutcome = await rawUpgrade('/ws/reset');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const resetEntries = proxy.entries.slice(beforeReset);
    const successArtifact = (status: number): boolean => status === 101 || status === 200;
    check(
      'reset before upgrade: one status-0 event, no success artifact',
      resetEntries.length === 1 &&
        !successArtifact(resetEntries[0]!.status) &&
        resetEntries[0]!.status === 0,
      `outcome=${resetOutcome} entries=${JSON.stringify(resetEntries)}`
    );

    const beforeNotFound = proxy.entries.length;
    const notFoundOutcome = await rawUpgrade('/ws/notfound');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const notFoundEntries = proxy.entries.slice(beforeNotFound);
    check(
      'upgrade answered with HTTP 404 recorded exactly once',
      notFoundOutcome === 'response:404' &&
        notFoundEntries.length === 1 &&
        notFoundEntries[0]!.status === 404,
      `outcome=${notFoundOutcome} entries=${JSON.stringify(notFoundEntries)}`
    );

    const beforeAfter101 = proxy.entries.length;
    const after101Outcome = await rawUpgrade('/ws/after101');
    await new Promise((resolve) => setTimeout(resolve, 80));
    const after101Entries = proxy.entries.slice(beforeAfter101);
    check(
      'reset after 101: exactly one real 101 event, no duplicate',
      after101Outcome === 'upgrade' &&
        after101Entries.length === 1 &&
        after101Entries[0]!.status === 101,
      `outcome=${after101Outcome} entries=${JSON.stringify(after101Entries)}`
    );

    const beforeNoise = proxy.entries.length;
    const { connect } = await import('node:net');
    await new Promise<void>((resolve) => {
      const socket = connect(proxy.port, '127.0.0.1', () => {
        socket.destroy();
        resolve();
      });
      socket.on('error', () => resolve());
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    check('pre-request socket reset records nothing and does not crash', proxy.entries.length === beforeNoise);

    // Bounded, crash-free stop with a live upgraded socket.
    const liveSocket = new WebSocket(`ws://127.0.0.1:${proxy.port}/ws/play?token=stop-test`);
    const liveOpened = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 5_000);
      liveSocket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(true);
      });
      liveSocket.addEventListener('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
    const stopStarted = Date.now();
    await proxy.stop();
    const stopElapsedMs = Date.now() - stopStarted;
    check(
      'bounded stop with a live upgraded socket',
      liveOpened && stopElapsedMs < 3_000,
      `opened=${liveOpened} ms=${stopElapsedMs}`
    );
    try {
      liveSocket.close();
    } catch {
      // Proxy already stopped; best effort.
    }

    // Upstream target validation.
    const rejection = async (upstream: string): Promise<string | null> => {
      try {
        const handle = await startRequestAccountingProxy({ upstream });
        await handle.stop();
        return null;
      } catch (error) {
        return errorText(error);
      }
    };
    const httpsError = await rejection('https://127.0.0.1:4321');
    const publicError = await rejection('http://example.com:80');
    const portlessError = await rejection('http://127.0.0.1');
    check('non-http upstream refused', httpsError !== null && httpsError.includes('http upstream'), httpsError ?? 'accepted');
    check(
      'non-loopback upstream refused',
      publicError !== null && publicError.includes('loopback'),
      publicError ?? 'accepted'
    );
    check(
      'portless upstream refused',
      portlessError !== null && portlessError.includes('explicit port'),
      portlessError ?? 'accepted'
    );
    const v6 = loopbackUpstream('http://[::1]:9999');
    check('IPv6 loopback upstream accepted', v6.hostname === '::1' && v6.port === 9999, JSON.stringify(v6));

    // Diagnostic wait validation (never a provider cap).
    check(
      'diagnostic wait accepts >= 60000',
      parseDiagnosticMaxWaitMs('120000') === 120_000 && parseDiagnosticMaxWaitMs('60000') === 60_000
    );
    const waitRejection = (value: string): string | null => {
      try {
        parseDiagnosticMaxWaitMs(value);
        return null;
      } catch (error) {
        return errorText(error);
      }
    };
    const tooShort = waitRejection('59999');
    const notInteger = waitRejection('1.5');
    check('diagnostic wait rejects < 60000', tooShort !== null && tooShort.includes('>= 60000'), tooShort ?? 'accepted');
    check(
      'diagnostic wait rejects non-integers',
      notInteger !== null && notInteger.includes('integer'),
      notInteger ?? 'accepted'
    );

    // Contamination classification from public room snapshots.
    const contaminationSample = classifyContamination(
      [
        { id: 'prior-active', name: 'accept-1H1A-old', status: 'ACTIVE' },
        { id: 'prior-done', name: 'accept-10A-old', status: 'COMPLETE' },
      ],
      [
        { id: 'prior-active', name: 'accept-1H1A-old', status: 'ACTIVE' },
        { id: 'current-failed', name: 'accept-1H9A-1', status: 'ACTIVE' },
        { id: 'current-done', name: 'accept-1H9A-2', status: 'COMPLETE' },
      ],
      ['accept-1H9A-']
    );
    check(
      'contamination lists prior and current failed active rooms',
      contaminationSample.priorActiveRoomIds.length === 1 &&
        contaminationSample.priorActiveRoomIds[0] === 'prior-active' &&
        contaminationSample.stillActiveAfterIds.length === 2 &&
        contaminationSample.currentFailedActiveIds.length === 1 &&
        contaminationSample.currentFailedActiveIds[0] === 'current-failed',
      JSON.stringify(contaminationSample)
    );

    // Optional --wallet-only scenario: appended fifth, required four unchanged.
    check(
      'required PhaseC list stays four and excludes wallet-only',
      REQUIRED_SCENARIO_NAMES.length === 4 &&
        !(REQUIRED_SCENARIO_NAMES as readonly string[]).includes(WALLET_ONLY_SCENARIO)
    );
    const defaultArgs: BudgetArgs = {
      smoke: false,
      selfTest: false,
      keep: false,
      scenarios: null,
      mixedPair: ['2H2A', '2H2A'],
      jsonPath: null,
      maxWaitMs: DEFAULT_DIAGNOSTIC_MAX_WAIT_MS,
      walletOnly: false,
    };
    const defaultPlans = resolveScenarioPlans(defaultArgs);
    check(
      'default scenario plans unchanged without --wallet-only',
      defaultPlans.length === 4 &&
        defaultPlans.map((plan) => plan.name).join(',') === REQUIRED_SCENARIO_NAMES.join(',')
    );
    const walletPlans = resolveScenarioPlans({ ...defaultArgs, walletOnly: true });
    check(
      '--wallet-only appends exactly one 2H scenario',
      walletPlans.length === 5 &&
        walletPlans[4]!.name === 'wallet-only' &&
        walletPlans[4]!.rosters.length === 1 &&
        walletPlans[4]!.rosters[0]!.label === '2H' &&
        REQUIRED_SCENARIO_NAMES.every((name) => walletPlans.some((plan) => plan.name === name)),
      JSON.stringify(
        walletPlans.map((plan) => `${plan.name}[${plan.rosters.map((spec) => spec.label).join('+')}]`)
      )
    );
    const smokeWalletPlans = resolveScenarioPlans({ ...defaultArgs, smoke: true, walletOnly: true });
    check(
      '--smoke --wallet-only runs fresh-1H1A plus wallet-only',
      smokeWalletPlans.length === 2 &&
        smokeWalletPlans[0]!.name === 'fresh-1H1A' &&
        smokeWalletPlans[1]!.name === 'wallet-only'
    );
    check(
      '--scenarios cannot select wallet-only',
      (() => {
        try {
          parseArgs(['--scenarios', 'wallet-only']);
          return false;
        } catch (error) {
          return errorText(error).includes('unknown scenario');
        }
      })()
    );
    const walletArgs = parseArgs(['--wallet-only']);
    check(
      '--wallet-only parses as a flag without changing scenario selection',
      walletArgs.walletOnly === true && walletArgs.scenarios === null
    );
    const dummyHumans = [{ token: 'h1' }, { token: 'h2' }] as unknown as WalletSession[];
    const walletRooms = planRooms(walletPlans[4]!, dummyHumans, []);
    check(
      'wallet-only room reuses human pool [0..1] and allocates no agents',
      walletRooms.length === 1 &&
        walletRooms[0]!.label === '2H' &&
        walletRooms[0]!.humans.length === 2 &&
        walletRooms[0]!.humans[0] === dummyHumans[0] &&
        walletRooms[0]!.humans[1] === dummyHumans[1] &&
        walletRooms[0]!.agentIds.length === 0,
      JSON.stringify(walletRooms.map((room) => ({ label: room.label, humans: room.humans.length, agents: room.agentIds.length })))
    );

    const synthetic = [
      { at: 0, method: 'GET', route: '/tables/:id/observation', category: 'observation' as const, status: 200, durationMs: 1, throttle: null },
      { at: 59_999, method: 'GET', route: '/tables/:id/observation', category: 'observation' as const, status: 200, durationMs: 1, throttle: null },
      { at: 60_000, method: 'GET', route: '/tables/:id/observation', category: 'observation' as const, status: 200, durationMs: 1, throttle: null },
    ];
    const windowed = summarizeAccounting(synthetic, { startAt: 0, endAt: 60_000 });
    check('minute bucketing', windowed.perMinute.length === 1 && windowed.perMinute[0]!.total === 3);
    check('rolling window is half-open at 60s', windowed.peakRolling60s?.count === 2, JSON.stringify(windowed.peakRolling60s));
    const empty = summarizeAccounting([], { startAt: 0, endAt: 1_000 });
    check('empty window is safe', empty.total === 0 && empty.peakRolling60s === null && empty.perMinute.length === 1);
  } finally {
    await proxy.stop();
    for (const socket of [...upstreamSockets]) socket.destroy();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1_000);
      upstream.close(() => {
        clearTimeout(timer);
        resolve();
      });
      upstream.closeAllConnections?.();
    });
  }

  let failed = 0;
  for (const entry of checks) {
    // eslint-disable-next-line no-console
    console.log(`${entry.ok ? 'PASS' : 'FAIL'} self-test: ${entry.name}${entry.detail ? ` (${entry.detail})` : ''}`);
    if (!entry.ok) failed += 1;
  }
  // eslint-disable-next-line no-console
  console.log(failed === 0 ? `SELF-TEST PASS (${checks.length} checks)` : `SELF-TEST FAIL (${failed}/${checks.length})`);
  return failed === 0 ? 0 : 1;
}

async function main(): Promise<number> {
  let args: BudgetArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(errorText(error));
    console.error(
      'usage: tsx tests/integration/request-budget.ts [--smoke] [--scenarios fresh-1H1A,10A,1H9A,mixed-pair] [--mixed-pair 2H2A,2H2A] [--max-wait-ms N] [--wallet-only] [--json <path>] [--keep] [--self-test]'
    );
    return 2;
  }
  if (args.selfTest) return runSelfTest();
  return runBudget(args);
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

/**
 * Flush stdio, then exit explicitly. A failed room can leave the existing
 * product-room terminal-wait drain timer pending up to its `maxWaitMs` even
 * after this diagnostic has written its report; without this bounded exit the
 * CLI looks hung (the report and all logs are already complete at this point).
 */
function flushAndExit(code: number): void {
  let pending = 2;
  const finish = (): void => {
    pending -= 1;
    if (pending === 0) process.exit(code);
  };
  const fallback = setTimeout(() => process.exit(code), 2_000);
  fallback.unref?.();
  try {
    process.stdout.write('', finish);
  } catch {
    finish();
  }
  try {
    process.stderr.write('', finish);
  } catch {
    finish();
  }
}

if (isMain) {
  main()
    .then((code) => {
      process.exitCode = code;
      flushAndExit(code);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.stack ?? error.message : error);
      process.exitCode = 1;
      flushAndExit(1);
    });
}
