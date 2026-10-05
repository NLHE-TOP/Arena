#!/usr/bin/env tsx
/**
 * Mandatory deterministic release-roster subset on ONE standalone container.
 *
 * Repeatable tracked runner for the mandatory subset of the final acceptance
 * rosters, all against a FRESH released-image staging topology and a single
 * standalone product container:
 *
 *   1H1A                 product-orchestrated mixed room
 *   10A                  agent-only room at the platform seat ceiling
 *   1H9A                 mixed room at the seat ceiling
 *   2H2A-pair            TWO SIMULTANEOUS 2H2A rooms (same container/provider)
 *   wallet-only-2H       pure-WALLET 2H gameplay (zero provider requests)
 *
 * Reuse, never reimplementation:
 * - `runProductRoom` is the existing acceptance roster driver: the product
 *   (not this file) creates/starts the rooms and attaches the agent runtime;
 *   human seats are real SIWE wallets played through the public SDK; agents
 *   decide through the loopback deterministic provider;
 * - the existing zero-429 gate: `requireNoRateLimit` is backed by the
 *   platform's own `/metrics` 429 counter for every room (never only driver
 *   errors), plus a start/end total assertion here;
 * - persisted-evidence assertions: `runProductRoom` enforces exact provider
 *   attempts (`providerRequests === persistedAttempts`), agent-owned decisions
 *   and evidence inspection; this file additionally asserts terminal placement
 *   coverage, unique persisted attempt identities, unique canonical action
 *   request ids and per-table provider-turn exactness;
 * - provenance via `infra/provenance.ts`: ACTUAL running API/workers/custody
 *   artifact captured with `capturePlatformRuntimeProvenance` and enforced
 *   against the official released digest with `expectedPlatformArtifact` +
 *   `assertExpectedPlatformArtifact`; ACTUAL running product identity captured
 *   with `captureRunningProductProvenance`. The mandatory fields are persisted
 *   in the summary, never only as flags;
 * - terminal durable obligations via the mandatory tracked
 *   `acceptance/terminal-diagnostics.ts` (static import): every room that
 *   reached a table MUST yield a complete packet (missing/failed/incomplete
 *   fails the room/scenario); the affected hand is scoped from authoritative
 *   `Table.state` (an unsettled current hand on failure) or the last completed
 *   hand's EXACT history; unresolved outbox jobs are classified through the
 *   read-only BullMQ redis-cli reader, never merely assumed unproven;
 * - the final secret scanner lifecycle of `container-gate.ts`: after teardown
 *   the retained generated-secret registry re-persists an ephemeral manifest
 *   (outside artifacts), the scanner runs over every subset artifact
 *   (`context.artifactDir`), then the manifest directory is removed.
 *
 * Deliberately NOT here (owned by the existing separate gates): browser
 * acceptance, container restarts, platform outage/recovery and the paid
 * CHALLENGE flow. No paid provider is contacted: the provider URL is loopback
 * and asserted as such.
 *
 * Usage:
 *   NLHE_IT_STAGING_FIXTURE=<abs path to staging-platform.mjs> \
 *   NLHE_IT_SECRET_SCANNER=<abs path to nlhe-final-secret-check.mjs> \
 *     tsx tests/integration/container-release-subset.ts [--max-wait-ms N] [--keep] [--json <path>]
 *
 * `--max-wait-ms` bounds only how long `runProductRoom` waits for a room to
 * settle (minimum one budget minute); it never changes provider caps. Exit
 * codes: 0 PASS, 1 FAIL, 2 not runnable (missing fixture/scanner/arguments).
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, createRunContext, type RunContext } from './infra/context.js';
import { buildChildEnv } from './infra/env-boundary.js';
import { runCommandOrThrow } from './infra/proc.js';
import { ephemeralWallet, getAccount, loginWallet, type WalletSession } from './infra/wallet.js';
import { ensureOperator } from './infra/admin.js';
import {
  mintOrchestrationToken,
  productAdminToken,
  provisionFakeAgentPrincipals,
  type ProvisionedAgent,
} from './infra/agents.js';
import { writeFakeAgentRoster } from './infra/nlhe.js';
import { parseDecisionRequest, startFakeProvider, type FakeProviderHandle } from './infra/fake-provider.js';
import { FIXTURE_API_KEY, FIXTURE_MODEL } from './infra/fixtures.js';
import { DEFAULT_PLATFORM_IMAGE, startStagingTopology, type StagingTopology } from './infra/staging.js';
import { startStandaloneContainer, type StandaloneContainerHandle } from './infra/standalone-container.js';
import type { TestEnvironment } from './infra/environment.js';
import {
  RELEASED_PLATFORM_IMAGE,
  assertExpectedPlatformArtifact,
  capturePlatformRuntimeProvenance,
  captureRunningProductProvenance,
  expectedPlatformArtifact,
  selectPlatformContainers,
  selectStandaloneProductContainer,
  type ContainerProvenance,
  type ExpectedPlatformArtifact,
  type PlatformArtifact,
  type ProductArtifact,
} from './infra/provenance.js';
import { ProductClient, type ProductRoomView } from './acceptance/product-client.js';
import {
  HUMAN_DRIVER_PACING,
  runProductRoom,
  type HumanDriverStats,
  type ProductRoomRunResult,
} from './acceptance/product-room.js';
import { readPlatform429Total } from './acceptance/platform-metrics.js';
import { ROSTER_MATRIX, type RosterSpec } from './acceptance/roster.js';
import {
  collectTerminalDiagnostics,
  terminalDiagnosticCompleteness,
  terminalDiagnosticsQuery,
  type TerminalDiagnosticsBundle,
  type TerminalDiagnosticsIdentifiers,
  type TerminalDiagnosticsJobStateInput,
} from './acceptance/terminal-diagnostics.js';
import { createBullMqJobStateReader } from './acceptance/live-failure-packet.js';
import { DEFAULT_DIAGNOSTIC_MAX_WAIT_MS, parseDiagnosticMaxWaitMs } from './request-budget.js';

/** Maximum simultaneous human seats: the two simultaneous 2H2A rooms. */
const HUMAN_POOL_SIZE = 4;
/** Maximum agent seats: the agent-only 10A room. */
const AGENT_POOL_SIZE = 10;

/** Exact deterministic acceptance caps (provider caps are never raised). */
const SUBSET_CAPS = Object.freeze({
  maxProviderCalls: 5_000,
  maxHands: 100,
  overallRuntimeMs: 600_000,
  maxProviderConcurrency: 8,
  perCallTimeoutMs: 5_000,
  maxCostUsdMicro: 0,
});

const MIXED_PAIR_SCENARIO = '2H2A-pair';
const WALLET_ONLY_SCENARIO = 'wallet-only-2H';

/** Bounded convergence window before terminal diagnostics are asserted. */
const DIAGNOSTICS_SETTLE_ATTEMPTS = 10;
const DIAGNOSTICS_SETTLE_INTERVAL_MS = 1_500;

const USAGE =
  'usage: NLHE_IT_STAGING_FIXTURE=<abs fixture> NLHE_IT_SECRET_SCANNER=<abs scanner> tsx tests/integration/container-release-subset.ts [--max-wait-ms N] [--keep] [--json <path>]';

interface SubsetArgs {
  /** Diagnostic room-settlement wait only; never a provider cap. */
  maxWaitMs: number;
  keep: boolean;
  jsonPath: string | null;
}

function parseArgs(argv: readonly string[]): SubsetArgs {
  const args: SubsetArgs = { maxWaitMs: DEFAULT_DIAGNOSTIC_MAX_WAIT_MS, keep: false, jsonPath: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === '--keep') {
      args.keep = true;
      continue;
    }
    if (argument === '--max-wait-ms' || argument === '--json') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${argument} requires a value`);
      index += 1;
      if (argument === '--max-wait-ms') args.maxWaitMs = parseDiagnosticMaxWaitMs(value);
      else args.jsonPath = value;
      continue;
    }
    throw new Error(`unknown container-release-subset argument: ${argument}`);
  }
  return args;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertLoopback(url: string, label: string): void {
  const host = new URL(url).hostname;
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]') {
    throw new Error(`${label} must be loopback for the deterministic subset, saw ${host}`);
  }
}

interface SubsetPlanRoom {
  spec: RosterSpec;
  humans: WalletSession[];
  agentIds: string[];
}

interface SubsetPlan {
  name: string;
  rosters: string[];
  rooms: SubsetPlanRoom[];
}

function rosterSpec(label: string): RosterSpec {
  const spec = ROSTER_MATRIX.find((candidate) => candidate.label === label);
  if (spec === undefined) throw new Error(`roster ${label} is not in the canonical matrix`);
  return spec;
}

/**
 * Fixed mandatory subset order: 1H1A, 10A, 1H9A, two simultaneous 2H2A, then
 * the pure-WALLET 2H room reusing the existing human pool sessions. No subset
 * selection flag exists: the mandatory roster subset is complete by contract.
 */
export function resolveSubsetPlans(
  humans: readonly WalletSession[],
  agents: readonly ProvisionedAgent[]
): SubsetPlan[] {
  const agentIds = agents.map((agent) => agent.agentId);
  if (humans.length < HUMAN_POOL_SIZE) {
    throw new Error(`release subset needs ${HUMAN_POOL_SIZE} human wallets, saw ${humans.length}`);
  }
  if (agentIds.length < AGENT_POOL_SIZE) {
    throw new Error(`release subset needs ${AGENT_POOL_SIZE} agents, saw ${agentIds.length}`);
  }
  return [
    {
      name: '1H1A',
      rosters: ['1H1A'],
      rooms: [{ spec: rosterSpec('1H1A'), humans: humans.slice(0, 1), agentIds: agentIds.slice(0, 1) }],
    },
    {
      name: '10A',
      rosters: ['10A'],
      rooms: [{ spec: rosterSpec('10A'), humans: [], agentIds: agentIds.slice(0, 10) }],
    },
    {
      name: '1H9A',
      rosters: ['1H9A'],
      rooms: [{ spec: rosterSpec('1H9A'), humans: humans.slice(0, 1), agentIds: agentIds.slice(0, 9) }],
    },
    {
      name: MIXED_PAIR_SCENARIO,
      rosters: ['2H2A', '2H2A'],
      rooms: [
        {
          spec: { ...rosterSpec('2H2A'), label: '2H2A-1' },
          humans: humans.slice(0, 2),
          agentIds: agentIds.slice(0, 2),
        },
        {
          spec: { ...rosterSpec('2H2A'), label: '2H2A-2' },
          humans: humans.slice(2, 4),
          agentIds: agentIds.slice(2, 4),
        },
      ],
    },
    {
      name: WALLET_ONLY_SCENARIO,
      rosters: ['2H'],
      rooms: [{ spec: rosterSpec('2H'), humans: humans.slice(0, 2), agentIds: [] }],
    },
  ];
}

interface RoomRecord {
  label: string;
  humans: number;
  agents: number;
  seats: number;
  roomId: string | null;
  tableId: string | null;
  status: string | null;
  providerRequests: number | null;
  persistedAttempts: number | null;
  providerTurns: number | null;
  decisions: number | null;
  committed: number | null;
  canonicalActionRequestIds: number | null;
  placedResults: number | null;
  humanDriver: HumanDriverStats | null;
  platform429: number | null;
  durationMs: number;
  error: string | null;
}

interface ScenarioRecord {
  name: string;
  rosters: string[];
  startedAt: number;
  endedAt: number;
  durationMs: number;
  maxConcurrentRooms: number;
  rooms: RoomRecord[];
  error: string | null;
}

interface SubsetEvidenceSummary {
  decisions: number;
  committed: number;
  canonicalActionRequestIds: number;
  placedResults: number;
}

/**
 * Terminal + persisted-evidence assertions not already covered by
 * `runProductRoom`:
 * - the room is COMPLETE with a persisted placement for every seat;
 * - persisted attempt identities (`decision_id:attempt_no`) are unique;
 * - every persisted canonical action request carries one unique request id
 *   (an accepted action identity can never repeat across decisions);
 * - agent rooms persist at least one COMMITTED decision with its action id;
 * - human-only rooms persist no agent decisions and did play human actions.
 */
function assertSubsetEvidence(spec: RosterSpec, result: ProductRoomRunResult): SubsetEvidenceSummary {
  const label = spec.label;
  if (result.room.status !== 'COMPLETE') {
    throw new Error(`${label}: terminal room status ${result.room.status} != COMPLETE`);
  }
  if (result.room.results === null || result.room.results.length !== spec.seats) {
    throw new Error(
      `${label}: terminal results do not cover ${spec.seats} placements (got ${
        result.room.results === null ? 'null' : result.room.results.length
      })`
    );
  }
  const attemptKeys = new Set<string>();
  for (const attempt of result.evidence.attempts) {
    const key = `${attempt.decision_id}:${attempt.attempt_no}`;
    if (attemptKeys.has(key)) throw new Error(`${label}: duplicate persisted attempt identity ${key}`);
    attemptKeys.add(key);
  }
  const requestIds = new Set<string>();
  for (const decision of result.evidence.decisions) {
    if (decision.request_json === null) continue;
    let parsed: { requestId?: unknown };
    try {
      parsed = JSON.parse(decision.request_json) as { requestId?: unknown };
    } catch {
      throw new Error(`${label}: decision ${decision.id} canonical request is not valid JSON`);
    }
    if (typeof parsed.requestId !== 'string' || parsed.requestId.length === 0) {
      throw new Error(`${label}: decision ${decision.id} canonical request has no request id`);
    }
    if (requestIds.has(parsed.requestId)) {
      throw new Error(`${label}: duplicate canonical action request id ${parsed.requestId}`);
    }
    requestIds.add(parsed.requestId);
  }
  const committed = result.evidence.decisions.filter((decision) => decision.status === 'COMMITTED').length;
  if (spec.agents > 0) {
    if (requestIds.size === 0) throw new Error(`${label}: no canonical action request ids persisted`);
    if (committed === 0) throw new Error(`${label}: no COMMITTED decisions persisted`);
  } else {
    if (result.evidence.decisions.length !== 0 || requestIds.size !== 0) {
      throw new Error(`${label}: human-only room persisted agent decisions`);
    }
    if (result.humanDriver.actions === 0) {
      throw new Error(`${label}: wallet-only room completed without a recorded human action`);
    }
  }
  return {
    decisions: result.evidence.decisions.length,
    committed,
    canonicalActionRequestIds: requestIds.size,
    placedResults: result.room.results.length,
  };
}

/**
 * Independent provider-side exactness for this room's table: every captured
 * decision request must be parseable, carry a turn id, and each turn must have
 * been exchanged exactly once (no duplicated provider turn).
 */
function assertProviderTurnExactness(
  provider: FakeProviderHandle,
  tableId: string,
  label: string
): number {
  const turns = new Map<string, number>();
  for (const record of provider.requests) {
    let parsed: { observation?: { tableId?: unknown; turnId?: unknown } };
    try {
      parsed = parseDecisionRequest(record.body) as { observation?: { tableId?: unknown; turnId?: unknown } };
    } catch {
      throw new Error(`${label}: loopback provider capture is not a parseable decision request`);
    }
    if (parsed.observation?.tableId !== tableId) continue;
    const turnId = parsed.observation.turnId;
    if (typeof turnId !== 'string' || turnId.length === 0) {
      throw new Error(`${label}: loopback provider request carries no turn id`);
    }
    turns.set(turnId, (turns.get(turnId) ?? 0) + 1);
  }
  const duplicates = [...turns.entries()].filter(([, count]) => count !== 1);
  if (duplicates.length > 0) {
    throw new Error(
      `${label}: loopback provider turn duplication: ${duplicates
        .map(([turnId, count]) => `${turnId}x${count}`)
        .join(',')}`
    );
  }
  return turns.size;
}

// ---------------------------------------------------------------------------
// Terminal durable diagnostics (mandatory tracked module, read-only)
// ---------------------------------------------------------------------------

/** Last known durable identity of one planned room (populated at ACTIVE). */
interface TrackedRoom {
  label: string;
  roomId: string | null;
  tableId: string | null;
  competitionId: string | null;
}

interface DiagnosticsPacketRecord {
  label: string;
  roomId: string | null;
  tableId: string;
  competitionId: string | null;
  /** Canonical completed hand this packet's events/history were scoped to. */
  handId: string | null;
  collection: 'COMPLETE' | 'FAILED' | null;
  /** `terminalDiagnosticCompleteness(bundle).complete` for the packet. */
  complete: boolean;
  warnings: string[];
  problems: string[];
  file: string | null;
  error: string | null;
}

interface TerminalDiagnosticsSummary {
  status: 'collected' | 'partial' | 'failed' | 'no-packet';
  /** True only when at least one sanitized durable packet was captured. */
  packet: boolean;
  reason: string | null;
  packets: DiagnosticsPacketRecord[];
  problems: string[];
}

interface TerminalDiagnosticsDeps {
  context: RunContext;
  topology: StagingTopology;
  trackedRooms: ReadonlyMap<string, TrackedRoom>;
  sanitize: (value: string) => string;
  redact: (text: string) => string;
  /**
   * Read-only BullMQ projection (`createBullMqJobStateReader`); classifies a
   * dispatched-but-unresolved outbox job by its actual queue state instead of
   * leaving it unproven.
   */
  readJobState: (input: TerminalDiagnosticsJobStateInput) => Promise<unknown> | unknown;
}

/** Archival/settlement obligations that must be COMPLETED on a terminal room. */
const STRICT_OUTBOX_KINDS: ReadonlySet<string> = new Set(['archive-hand', 'settle-hand']);
/** Known BullMQ projections that make a non-FAILED outbox row stuck. */
const BAD_OUTBOX_JOB_STATES: ReadonlySet<string> = new Set([
  'failed',
  'missing',
  'unavailable',
  'unknown',
]);

/**
 * Affected-hand scoping for a terminal/failed room.
 *
 * Authoritative current `Table.state` wins over the committed event window:
 * an unsettled current hand (`winners === null`, failure capture) is the
 * affected hand to diagnose instead of an older completed hand; a settled
 * current hand (`winners` is `[]` or a non-empty list) is the exact last
 * completed hand whose history is required. The null/empty `winners`
 * distinction is preserved exactly, never collapsed. Only when the table has
 * no authoritative hand identity does the latest committed HAND_COMPLETED
 * event stand in.
 */
function scopedDiagnosticsHandId(bundle: TerminalDiagnosticsBundle): string | null {
  const state = bundle.table?.state ?? null;
  if (state !== null && state.present && state.handId !== null && state.handId.length > 0) {
    return state.handId;
  }
  for (let index = bundle.events.length - 1; index >= 0; index -= 1) {
    const event = bundle.events[index]!;
    if (event.type === 'HAND_COMPLETED' && event.handId !== null && event.handId.length > 0) {
      return event.handId;
    }
  }
  return null;
}

/**
 * Explicit per-room durable assertions over the hand-scoped diagnostics
 * bundle:
 * - the read-only capture and the module completeness contract are complete
 *   (table, authoritative normalized snapshot, requested hand,
 *   competition/tournament);
 * - the canonical completed hand's EXACT archived history exists;
 * - every `archive-hand`/`settle-hand` obligation is COMPLETED (old hand
 *   obligations resolved);
 * - non-queue `pubsub` rows have no BullMQ contract and are skipped; a row
 *   whose BullMQ job is proven `completed` is resolved even when the outbox
 *   status column has not caught up;
 * - a `next-hand` row may be COMPLETED (the legitimate terminal no-op) or
 *   PENDING (valid, not yet due); FAILED, stale-due PENDING and a
 *   dispatched-but-unresolved job (classified through the read-only BullMQ
 *   reader) are never silently allowed;
 * - when a next hand is applicable (at least two stack-positive entrants) and
 *   no subsequent HAND_STARTED exists, a next-hand obligation must exist.
 */
function assessTerminalDiagnostics(bundle: TerminalDiagnosticsBundle): string[] {
  const problems: string[] = [];
  if (bundle.collection.status !== 'COMPLETE') {
    problems.push(`diagnostics capture ${bundle.collection.status}: ${bundle.collection.error ?? 'unknown'}`);
  }
  for (const error of terminalDiagnosticCompleteness(bundle).errors) {
    problems.push(`packet-${error}`);
  }
  if (bundle.contract.handCompleted === 'present' && bundle.contract.handHistory !== 'present') {
    problems.push(`completed-hand-without-archived-history:${bundle.identifiers.handId ?? 'unscoped'}`);
  }
  const stackPositiveEntrants = bundle.entrants.filter(
    (entrant) => entrant.authoritativeStack !== null && entrant.authoritativeStack > 0
  ).length;
  const nextHandApplicable = stackPositiveEntrants >= 2;
  const nextHandRows = bundle.outbox.filter((row) => row.kind === 'next-hand');
  const capturedAt = Date.parse(bundle.collectedAt);
  for (const row of bundle.outbox) {
    const id = `${row.kind}#${row.id}`;
    // `pubsub` is published directly and has no BullMQ queue contract.
    if (row.kind === 'pubsub') continue;
    const job = row.jobState;
    // A proven-completed job resolves the row even if the status column lags.
    if (job !== null && job.state === 'completed') continue;
    if (row.status === 'FAILED') {
      problems.push(`outbox-failed:${id}`);
      continue;
    }
    if (job !== null && BAD_OUTBOX_JOB_STATES.has(job.state)) {
      problems.push(`outbox-job-${job.state}:${id}`);
      continue;
    }
    if (STRICT_OUTBOX_KINDS.has(row.kind)) {
      if (row.status !== 'COMPLETED') problems.push(`outbox-unresolved:${id}:status=${row.status}`);
      continue;
    }
    if (row.kind === 'next-hand') {
      if (row.status === 'COMPLETED') continue;
      if (row.status === 'PENDING') {
        const availableAt = Date.parse(row.availableAt);
        if (Number.isFinite(availableAt) && Number.isFinite(capturedAt) && availableAt < capturedAt) {
          problems.push(`outbox-stale-pending:${id}:availableAt=${row.availableAt}`);
        }
        continue;
      }
      if (row.status === 'DISPATCHED') {
        problems.push(
          job === null
            ? `outbox-dispatched-unproven:${id}`
            : `outbox-dispatched-unresolved:${id}:job=${job.state}`
        );
        continue;
      }
      problems.push(`outbox-unexpected-status:${id}:${row.status}`);
    }
  }
  if (
    nextHandApplicable &&
    bundle.contract.handCompleted === 'present' &&
    bundle.contract.nextHandStarted !== 'present' &&
    nextHandRows.length === 0
  ) {
    problems.push(`next-hand-obligation-missing:stackPositiveEntrants=${stackPositiveEntrants}`);
  }
  return problems;
}

/** One diagnostics collection request for a room, optionally hand-scoped. */
async function collectRoomDiagnostics(
  deps: TerminalDiagnosticsDeps,
  room: TrackedRoom & { tableId: string },
  handId: string | null
): Promise<TerminalDiagnosticsBundle> {
  const identifiers: TerminalDiagnosticsIdentifiers = {
    roomId: room.roomId,
    tableId: room.tableId,
    competitionId: room.competitionId,
    ...(handId === null ? {} : { handId }),
  };
  return collectTerminalDiagnostics({
    query: terminalDiagnosticsQuery(deps.topology.adminTarget),
    identifiers,
    knownSecrets: deps.topology.secretRegistry.values(),
    redactText: (text) => deps.topology.secretRegistry.redact(text),
    readJobState: deps.readJobState,
  });
}

/**
 * Capture one MANDATORY sanitized terminal-diagnostics packet per room that
 * reached a table: the canonical last completed hand is discovered from the
 * unscoped bundle (committed events / authoritative table state) and a second
 * bundle scopes events and history to exactly that hand. Missing, failed and
 * incomplete packets are recorded as problems; the caller must fail the
 * subset, never pass with `packet === false`.
 */
async function captureTerminalDiagnostics(
  deps: TerminalDiagnosticsDeps
): Promise<TerminalDiagnosticsSummary> {
  try {
    const tracked = [...deps.trackedRooms.values()].sort((left, right) => left.label.localeCompare(right.label));
    if (tracked.length === 0) {
      const reason = 'no room identity was tracked';
      return { status: 'no-packet', packet: false, reason, packets: [], problems: [reason] };
    }
    const withTable = tracked.filter((room): room is TrackedRoom & { tableId: string } => room.tableId !== null);
    if (withTable.length === 0) {
      const reason = `no room reached ACTIVE (${tracked.map((room) => room.label).join(', ')})`;
      return { status: 'no-packet', packet: false, reason, packets: [], problems: [reason] };
    }
    const packets: DiagnosticsPacketRecord[] = [];
    const problems: string[] = [];
    const reachedWithoutTable = tracked.filter(
      (room) => room.roomId !== null && room.tableId === null
    );
    if (reachedWithoutTable.length > 0) {
      problems.push(
        `room(s) reached without a table identity: ${reachedWithoutTable.map((room) => room.label).join(', ')}`
      );
    }
    for (const room of withTable) {
      try {
        const unscoped = await collectRoomDiagnostics(deps, room, null);
        const handId = scopedDiagnosticsHandId(unscoped);
        const bundle = handId === null ? unscoped : await collectRoomDiagnostics(deps, room, handId);
        const packetProblems = assessTerminalDiagnostics(bundle);
        const file = join(deps.context.artifactDir, 'terminal-diagnostics', `${room.label}.json`);
        try {
          mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
          writeFileSync(file, `${deps.redact(JSON.stringify(bundle, null, 2))}\n`, { mode: 0o600 });
        } catch (error) {
          packetProblems.push(`packet-not-persisted: ${deps.sanitize(errorText(error))}`);
        }
        packets.push({
          label: room.label,
          roomId: room.roomId,
          tableId: room.tableId,
          competitionId: room.competitionId,
          handId,
          collection: bundle.collection.status,
          complete: terminalDiagnosticCompleteness(bundle).complete,
          warnings: bundle.warnings,
          problems: packetProblems,
          file,
          error: null,
        });
        for (const problem of packetProblems) problems.push(`${room.label}: ${problem}`);
      } catch (error) {
        const message = deps.sanitize(errorText(error));
        packets.push({
          label: room.label,
          roomId: room.roomId,
          tableId: room.tableId,
          competitionId: room.competitionId,
          handId: null,
          collection: null,
          complete: false,
          warnings: [],
          problems: [],
          file: null,
          error: message,
        });
        problems.push(`${room.label}: terminal diagnostics capture threw: ${message}`);
      }
    }
    const collected = packets.filter((packet) => packet.error === null).length;
    const status = collected === 0 ? 'failed' : collected === packets.length ? 'collected' : 'partial';
    return { status, packet: collected > 0, reason: null, packets, problems };
  } catch (error) {
    const reason = `terminal diagnostics collection failed: ${deps.sanitize(errorText(error))}`;
    return { status: 'failed', packet: false, reason, packets: [], problems: [reason] };
  }
}

interface SubsetDeps {
  context: RunContext;
  environment: TestEnvironment;
  product: ProductClient;
  provider: FakeProviderHandle;
  productDatabasePath: string;
  agentPrincipalIds: ReadonlySet<string>;
  topology: StagingTopology;
  maxWaitMs: number;
  sanitize: (value: string) => string;
  trackRoom: (label: string, room: ProductRoomView) => void;
}

/**
 * One scenario: rooms run concurrently (the mandatory pair) through
 * `runProductRoom`; a failed room is recorded and the scenario then fails so
 * the mandatory run stops with durable per-room evidence in the report.
 */
async function runScenario(plan: SubsetPlan, deps: SubsetDeps): Promise<ScenarioRecord> {
  let active = 0;
  let maxConcurrentRooms = 0;
  const startedAt = Date.now();
  const rooms = await Promise.all(
    plan.rooms.map(async (room): Promise<RoomRecord> => {
      const roomStartedAt = Date.now();
      const base: RoomRecord = {
        label: room.spec.label,
        humans: room.spec.humans,
        agents: room.spec.agents,
        seats: room.spec.seats,
        roomId: null,
        tableId: null,
        status: null,
        providerRequests: null,
        persistedAttempts: null,
        providerTurns: null,
        decisions: null,
        committed: null,
        canonicalActionRequestIds: null,
        placedResults: null,
        humanDriver: null,
        platform429: null,
        durationMs: 0,
        error: null,
      };
      try {
        const result = await runProductRoom({
          spec: room.spec,
          context: deps.context,
          environment: deps.environment,
          product: deps.product,
          humans: room.humans,
          agentIds: room.agentIds,
          agentPrincipalIds: deps.agentPrincipalIds,
          fakeProvider: deps.provider,
          productDatabasePath: deps.productDatabasePath,
          requireNoRateLimit: true,
          platformMetrics: deps.topology.platformMetrics,
          maxWaitMs: deps.maxWaitMs,
          onActive: async (activeRoom) => {
            active += 1;
            maxConcurrentRooms = Math.max(maxConcurrentRooms, active);
            deps.trackRoom(room.spec.label, activeRoom);
          },
          onTerminal: async () => {
            active = Math.max(0, active - 1);
          },
        });
        deps.trackRoom(room.spec.label, result.room);
        const persisted = assertSubsetEvidence(room.spec, result);
        const providerTurns = assertProviderTurnExactness(deps.provider, result.tableId, room.spec.label);
        deps.context.log(
          `room ${room.spec.label}: COMPLETE table=${result.tableId} providerRequests=${result.providerRequests} persistedAttempts=${result.persistedAttempts} providerTurns=${providerTurns} decisions=${persisted.decisions} committed=${persisted.committed} placements=${persisted.placedResults} platform429=${String(result.platform429)} humanDriver[observations=${result.humanDriver.observations} actions=${result.humanDriver.actions} driver429s=${result.humanDriver.rateLimitResponses}]`
        );
        return {
          ...base,
          roomId: result.room.id,
          tableId: result.tableId,
          status: result.room.status,
          providerRequests: result.providerRequests,
          persistedAttempts: result.persistedAttempts,
          providerTurns,
          decisions: persisted.decisions,
          committed: persisted.committed,
          canonicalActionRequestIds: persisted.canonicalActionRequestIds,
          placedResults: persisted.placedResults,
          humanDriver: result.humanDriver,
          platform429: result.platform429,
          durationMs: Date.now() - roomStartedAt,
        };
      } catch (error) {
        const message = deps.sanitize(errorText(error));
        deps.context.log(`room ${room.spec.label}: FAIL ${message}`);
        return { ...base, durationMs: Date.now() - roomStartedAt, error: message };
      }
    })
  );
  const endedAt = Date.now();
  const failed = rooms.filter((room) => room.error !== null);
  return {
    name: plan.name,
    rosters: plan.rosters,
    startedAt,
    endedAt,
    durationMs: endedAt - startedAt,
    maxConcurrentRooms,
    rooms,
    error:
      failed.length === 0
        ? null
        : `${failed.length}/${rooms.length} room(s) failed: ${failed
            .map((room) => `${room.label}(${room.error})`)
            .join('; ')}`,
  };
}

/**
 * Mandatory final secret scan over every subset artifact. Same lifecycle and
 * child environment as `container-gate.ts`: the scanner prints only
 * key/path/line/kind metadata (never values), gets only the system allowlist
 * plus NLHE_REPO, and inherits no provider or platform credential.
 */
async function runFinalSecretScan(context: RunContext, scanner: string, manifestPath: string): Promise<void> {
  const env = buildChildEnv({
    purpose: 'platform',
    declared: { NLHE_REPO: process.env.NLHE_REPO ?? ROOT },
  });
  const result = await runCommandOrThrow(
    process.execPath,
    [scanner, '--manifest', manifestPath, context.artifactDir],
    { timeoutMs: 120_000, env }
  );
  for (const line of result.stdout.trim().split('\n').filter(Boolean)) context.log(`secret scan: ${line}`);
}

async function main(): Promise<number> {
  let args: SubsetArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(errorText(error));
    console.error(USAGE);
    return 2;
  }
  const fixture = process.env.NLHE_IT_STAGING_FIXTURE;
  if (fixture === undefined || !isAbsolute(fixture) || !/\.m?js$/.test(fixture)) {
    console.error(
      'BLOCKED: NLHE_IT_STAGING_FIXTURE is required (absolute path to the built external staging fixture exporting startStagingPlatform)'
    );
    return 2;
  }
  const scannerPath = process.env.NLHE_IT_SECRET_SCANNER;
  if (scannerPath === undefined || !isAbsolute(scannerPath)) {
    console.error(
      'BLOCKED: the release subset requires an absolute NLHE_IT_SECRET_SCANNER path (the mandatory final secret scan runs over every subset artifact and the generated-secret registry manifest)'
    );
    return 2;
  }

  const context = createRunContext({ keep: args.keep });
  context.log(`container release subset ${context.runId}`);
  context.log(`artifacts: ${context.artifactDir}`);
  context.log(`fixture: ${fixture}`);
  context.log(`released platform artifact: ${RELEASED_PLATFORM_IMAGE}`);
  context.log(
    `caps: calls=${SUBSET_CAPS.maxProviderCalls} runtimeMs=${SUBSET_CAPS.overallRuntimeMs} hands=${SUBSET_CAPS.maxHands} concurrency=${SUBSET_CAPS.maxProviderConcurrency} perCallMs=${SUBSET_CAPS.perCallTimeoutMs} costMicroUsd=${SUBSET_CAPS.maxCostUsdMicro}`
  );
  context.log(`documented human driver pacing (unchanged): ${JSON.stringify(HUMAN_DRIVER_PACING)}`);

  let topology: StagingTopology | null = null;
  let runtime: StandaloneContainerHandle | null = null;
  let provider: FakeProviderHandle | null = null;
  let platformArtifact: PlatformArtifact | null = null;
  let platformContainers: ContainerProvenance[] = [];
  let productArtifact: ProductArtifact | null = null;
  let expectedPlatform: ExpectedPlatformArtifact | null = null;
  let platform429Before: number | null = null;
  let platform429After: number | null = null;
  let terminalDiagnostics: TerminalDiagnosticsSummary | null = null;
  let secretScan: 'pending' | 'pass' | 'failed' | 'unavailable' = 'pending';
  let secretScanError: string | null = null;
  const trackedRooms = new Map<string, TrackedRoom>();
  const scenarios: ScenarioRecord[] = [];
  let failure: string | null = null;
  const sanitize = (value: string): string =>
    (topology?.secretRegistry.redact(value) ?? value).replace(/[\r\n]+/g, ' ').slice(0, 2_000);

  const captureDiagnostics = async (): Promise<TerminalDiagnosticsSummary> => {
    const staging = topology;
    if (staging === null) {
      const reason = 'staging topology never started';
      return { status: 'no-packet', packet: false, reason, packets: [], problems: [reason] };
    }
    const jobStateReader = createBullMqJobStateReader({ redisContainer: staging.redisContainer });
    return captureTerminalDiagnostics({
      context,
      topology: staging,
      trackedRooms,
      sanitize,
      redact: (text) => staging.secretRegistry.redact(text),
      readJobState: jobStateReader.readJobState,
    });
  };

  try {
    // Official published released artifact, resolved BEFORE any Docker work:
    // a mutable tag or stale digest override fails closed without starting a
    // topology, then the ACTUAL running API/workers/custody containers must
    // match its version/image/digest before any provider or product work.
    expectedPlatform = expectedPlatformArtifact(
      process.env.NLHE_IT_PLATFORM_IMAGE ?? DEFAULT_PLATFORM_IMAGE
    );
    const staging = await startStagingTopology({
      context,
      sponsor: { principalId: randomUUID(), address: getAccount(2).address },
    });
    topology = staging;

    const platformRuntime = await capturePlatformRuntimeProvenance(
      selectPlatformContainers(staging.supervisor.names())
    );
    assertExpectedPlatformArtifact(platformRuntime.artifact, expectedPlatform);
    platformArtifact = platformRuntime.artifact;
    platformContainers = platformRuntime.containers;
    context.log(
      `provenance platform: version=${platformArtifact.version} image=${platformArtifact.image} imageId=${platformArtifact.imageId} digest=${String(platformArtifact.digest)} expectedDigest=${expectedPlatform.digest}`
    );
    for (const container of platformContainers) {
      context.log(
        `provenance container ${container.container}: configImage=${container.configImage} imageId=${container.imageId} repoDigests=${container.repoDigests.join(',')} version=${container.packageVersion}`
      );
    }
    context.log(`fresh staging topology ready: product image ${staging.productImage}`);

    // The sidecar targets the API container directly on the staging network so
    // the platform observes the genuine container source address; without it
    // every host client collapses into one rate-limit bucket and a zero-429
    // gate would be meaningless.
    const platformContainerHost = staging.platform.finance?.apiContainerName;
    if (!platformContainerHost) {
      throw new Error('staging fixture must expose the API container identity for direct service routing');
    }

    const fakeProvider = await startFakeProvider();
    provider = fakeProvider;
    assertLoopback(fakeProvider.baseUrl, 'fake provider URL');
    context.log(`deterministic loopback provider at ${fakeProvider.baseUrl} mode=${fakeProvider.getMode()} (no paid calls)`);

    const admin = await loginWallet(staging.platformUrl, ephemeralWallet());
    const promotion = await ensureOperator(staging.adminTarget, admin);
    if (!promotion.promoted) throw new Error('release-subset operator wallet was not promoted to ADMIN');
    const orchestrator = await mintOrchestrationToken(admin);
    const agents = await provisionFakeAgentPrincipals(admin, AGENT_POOL_SIZE, {
      delegatedToPrincipalId: orchestrator.principalId,
    });
    const roster = await writeFakeAgentRoster(context, {
      baseUrl: fakeProvider.baseUrl,
      principals: agents,
    });
    const adminToken = productAdminToken();
    staging.addProductSecret('PRODUCT_ADMIN_TOKEN', adminToken);
    staging.addProductSecret('POKERTOOLS_ORCHESTRATION_TOKEN', orchestrator.token);
    staging.addProductSecret('OPENAI_API_KEY', FIXTURE_API_KEY);

    const databasePath = join(context.artifactDir, 'nlhe-release-subset.sqlite');
    const container = await startStandaloneContainer({
      supervisor: staging.supervisor,
      context,
      runtimeDir: staging.runtimeDir,
      secretRegistry: staging.secretRegistry,
      productImage: staging.productImage,
      dockerNetwork: staging.network,
      platformContainerHost,
      platformUrl: staging.platformUrl,
      productUrl: staging.productUrl,
      providerBaseUrl: fakeProvider.baseUrl,
      providerApiKey: FIXTURE_API_KEY,
      providerModel: FIXTURE_MODEL,
      orchestrationToken: orchestrator.token,
      productAdminToken: adminToken,
      agentsConfigPath: roster.path,
      databasePath,
      maxProviderCalls: SUBSET_CAPS.maxProviderCalls,
      maxHands: SUBSET_CAPS.maxHands,
      extraEnv: {
        AGENT_CHAT_ENABLED: '1',
        MAX_PROVIDER_CONCURRENCY: String(SUBSET_CAPS.maxProviderConcurrency),
        CHALLENGE_ENABLED: '0',
      },
    });
    runtime = container;

    // ACTUAL running product identity (Config.Image recorded at launch + the
    // image ID actually running), captured from the live container.
    productArtifact = await captureRunningProductProvenance(
      selectStandaloneProductContainer(staging.supervisor.names())
    );
    context.log(
      `provenance product (running container): image=${productArtifact.image} imageId=${productArtifact.imageId}`
    );
    await staging.supervisor.assertAllAlive('release subset container start');
    context.log(`standalone product container ready at ${container.baseUrl} (container ${container.name})`);

    const humans: WalletSession[] = [];
    for (let index = 0; index < HUMAN_POOL_SIZE; index += 1) {
      humans.push(await loginWallet(staging.platformUrl, ephemeralWallet()));
    }
    context.log(`human pool ready: ${humans.length} real SIWE wallet sessions`);

    const product = new ProductClient(container.baseUrl, { adminToken });

    // The product-room runner receives a minimal real-environment facade; the
    // platform stays externally owned by the staging fixture.
    const environment: TestEnvironment = {
      context,
      platform: {
        baseUrl: staging.platformUrl,
        port: Number(new URL(staging.platformUrl).port),
        databaseUrl: staging.databaseUrl,
        redisUrl: staging.redisUrl,
        stop: async () => undefined,
      },
      fakeProvider,
      postgres: null,
      redis: null,
      adminTarget: staging.adminTarget,
      reusedExternalPlatform: true,
      financial: null,
      stop: async () => undefined,
    };

    platform429Before = await readPlatform429Total(staging.platformMetrics);
    if (platform429Before !== 0) {
      throw new Error(`fresh platform already recorded ${platform429Before} HTTP 429 response(s)`);
    }
    context.log(`zero-429 baseline: platform total=${platform429Before}`);

    const deps: SubsetDeps = {
      context,
      environment,
      product,
      provider: fakeProvider,
      productDatabasePath: databasePath,
      agentPrincipalIds: new Set(agents.map((agent) => agent.principalId)),
      topology: staging,
      maxWaitMs: args.maxWaitMs,
      sanitize,
      trackRoom: (label, room) => {
        trackedRooms.set(label, {
          label,
          roomId: room.id,
          tableId: room.pokerTableId,
          competitionId: room.pokerCompetitionId,
        });
      },
    };

    const plans = resolveSubsetPlans(humans, agents);
    for (const plan of plans) {
      for (const room of plan.rooms) {
        trackedRooms.set(room.spec.label, {
          label: room.spec.label,
          roomId: null,
          tableId: null,
          competitionId: null,
        });
      }
    }

    for (const plan of plans) {
      context.log(`scenario ${plan.name}: ${plan.rosters.join(' + ')}`);
      const record = await runScenario(plan, deps);
      scenarios.push(record);
      context.log(
        `scenario ${record.name} done: rooms=${record.rooms.filter((room) => room.error === null).length}/${
          record.rooms.length
        } maxConcurrent=${record.maxConcurrentRooms} duration=${(record.durationMs / 1000).toFixed(1)}s`
      );
      if (record.error !== null) throw new Error(`scenario ${plan.name}: ${record.error}`);
    }

    const mixed = scenarios.find((scenario) => scenario.name === MIXED_PAIR_SCENARIO);
    if (mixed === undefined) throw new Error(`${MIXED_PAIR_SCENARIO} scenario did not run`);
    if (mixed.maxConcurrentRooms < 2) {
      throw new Error(
        `the two 2H2A rooms were never simultaneously ACTIVE (maxConcurrentRooms=${mixed.maxConcurrentRooms})`
      );
    }

    platform429After = await readPlatform429Total(staging.platformMetrics);
    if (platform429After !== 0) {
      throw new Error(`platform recorded ${platform429After} HTTP 429 response(s) during the release subset`);
    }

    // Explicit per-room durable obligations (mandatory packets), bounded
    // convergence for in-flight archival/settlement jobs, then hard assertions:
    // a missing/failed/incomplete packet or any unresolved obligation fails.
    for (let attempt = 1; ; attempt += 1) {
      terminalDiagnostics = await captureDiagnostics();
      if (!terminalDiagnostics.packet || terminalDiagnostics.problems.length === 0) break;
      if (attempt >= DIAGNOSTICS_SETTLE_ATTEMPTS) break;
      context.log(
        `terminal diagnostics: ${terminalDiagnostics.problems.length} unresolved problem(s); settling before assertion (attempt ${attempt}/${DIAGNOSTICS_SETTLE_ATTEMPTS})`
      );
      await new Promise((resolve) => setTimeout(resolve, DIAGNOSTICS_SETTLE_INTERVAL_MS));
    }
    if (!terminalDiagnostics.packet) {
      throw new Error(
        `terminal diagnostics packet missing: ${terminalDiagnostics.reason ?? 'reason unavailable'}`
      );
    }
    if (terminalDiagnostics.problems.length > 0) {
      throw new Error(
        `terminal diagnostics found unresolved durable obligation(s): ${terminalDiagnostics.problems
          .slice(0, 5)
          .join('; ')}`
      );
    }

    await staging.supervisor.assertAllAlive('release subset complete');
    context.log('release subset PASS: all mandatory rooms terminal, zero platform 429s, evidence exact');
  } catch (error) {
    failure = sanitize(errorText(error));
    context.log(`container release subset FAIL: ${failure}`);
    // Diagnostics capture BEFORE teardown on failure: the topology is still
    // live, so the durable packet is available without restarting anything.
    terminalDiagnostics = terminalDiagnostics ?? (await captureDiagnostics());
  } finally {
    try {
      await runtime?.stop();
    } catch (error) {
      context.log(`teardown: container stop failed: ${sanitize(errorText(error))}`);
    }
    try {
      await provider?.stop();
    } catch (error) {
      context.log(`teardown: provider stop failed: ${sanitize(errorText(error))}`);
    }
    if (topology !== null) {
      try {
        for (const cleanupError of await topology.stop()) {
          context.log(`teardown: ${sanitize(cleanupError)}`);
        }
      } catch (error) {
        context.log(`teardown: topology stop failed: ${sanitize(errorText(error))}`);
      }
    }
  }

  const completedRooms = scenarios.flatMap((scenario) => scenario.rooms).filter((room) => room.error === null);
  const sum = (select: (room: RoomRecord) => number | null): number =>
    completedRooms.reduce((total, room) => total + (select(room) ?? 0), 0);
  const reportArtifactPath = join(context.artifactDir, 'container-release-subset.json');
  const reportPaths =
    args.jsonPath === null || args.jsonPath === reportArtifactPath
      ? [reportArtifactPath]
      : [reportArtifactPath, args.jsonPath];
  /** The pre-scan write keeps the main artifact inside scanner scope. */
  const writeReport = (): void => {
    const payload = {
      kind: 'container-release-subset',
      runId: context.runId,
      generatedAt: new Date().toISOString(),
      fixture,
      platformVersion: platformArtifact?.version ?? null,
      platformImage: platformArtifact?.image ?? null,
      platformImageId: platformArtifact?.imageId ?? null,
      platformDigest: platformArtifact?.digest ?? null,
      productImage: productArtifact?.image ?? null,
      productImageId: productArtifact?.imageId ?? null,
      provenance:
        platformArtifact === null
          ? null
          : {
              platform: platformArtifact,
              platformContainers,
              product: productArtifact,
              expectedPlatform,
            },
      container:
        runtime === null ? null : { name: runtime.name, sidecar: runtime.sidecarName, baseUrl: runtime.baseUrl },
      caps: SUBSET_CAPS,
      humanDriverPacing: HUMAN_DRIVER_PACING,
      maxWaitMs: args.maxWaitMs,
      zero429: { before: platform429Before, after: platform429After },
      maxSimultaneousRooms: scenarios.reduce((max, scenario) => Math.max(max, scenario.maxConcurrentRooms), 0),
      totals: {
        scenarios: scenarios.length,
        rooms: completedRooms.length,
        providerRequests: sum((room) => room.providerRequests),
        persistedAttempts: sum((room) => room.persistedAttempts),
        providerTurns: sum((room) => room.providerTurns),
        decisions: sum((room) => room.decisions),
        committed: sum((room) => room.committed),
        canonicalActionRequestIds: sum((room) => room.canonicalActionRequestIds),
      },
      scenarios,
      terminalDiagnostics,
      secretScan: { status: secretScan, error: secretScanError },
      failure,
      exitCode: failure === null ? 0 : 1,
    };
    for (const path of reportPaths) {
      try {
        writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
      } catch (error) {
        console.error(`could not write release-subset report ${path}: ${errorText(error)}`);
      }
    }
  };

  // Provisional report so the scanner covers the subset's main artifact; the
  // final write only patches the scan verdict (already-scanned bytes).
  writeReport();

  // Final scanner: same lifecycle as container-gate.ts. The topology keeps the
  // generated-secret registry in memory after stop; the ephemeral manifest and
  // scan directory live outside captured artifacts and are removed afterwards.
  if (topology !== null) {
    const scanDir = mkdtempSync(join(dirname(topology.runtimeDir), 'subset-scan-'));
    try {
      const manifestPath = topology.secretRegistry.persistEnvManifest(join(scanDir, 'secrets.env'));
      try {
        await runFinalSecretScan(context, scannerPath, manifestPath);
        secretScan = 'pass';
      } catch (error) {
        secretScan = 'failed';
        secretScanError = sanitize(errorText(error));
        context.log(`final secret scan FAIL: ${secretScanError}`);
      }
    } catch (error) {
      secretScan = 'failed';
      secretScanError = sanitize(errorText(error));
      context.log(`final secret scan setup FAIL: ${secretScanError}`);
    } finally {
      rmSync(scanDir, { recursive: true, force: true });
    }
  } else {
    secretScan = 'unavailable';
    secretScanError = 'staging topology never started; the mandatory final secret scan could not run';
    context.log(`final secret scan UNAVAILABLE: ${secretScanError}`);
  }
  if (secretScan !== 'pass') {
    failure = failure ?? `mandatory final secret scan ${secretScan}${secretScanError === null ? '' : `: ${secretScanError}`}`;
  }

  writeReport();
  context.log(`release-subset report: ${reportArtifactPath}`);
  if (secretScan === 'pass') context.log(`final secret scan PASS over ${context.artifactDir}`);
  if (failure !== null) console.error(`container release subset FAILED: ${failure}`);
  return failure === null ? 0 : 1;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.stack ?? error.message : error);
      process.exitCode = 1;
    });
}
