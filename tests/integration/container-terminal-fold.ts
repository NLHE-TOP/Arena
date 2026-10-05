#!/usr/bin/env tsx
/**
 * LIVE-shaped deterministic HUMAN FOLD terminal regression (external, no paid
 * provider).
 *
 * This runner reproduces the exact failure shape of the authorized 2.0.3 live
 * SPONSORED run on a FRESH released-image staging topology:
 *
 * - the real external staging fixture starts the pinned released PokerTools
 *   platform (API + workers + custody + PostgreSQL + Redis + Anvil/quorum) and
 *   a real standalone product container with its own SQLite store
 *   (`AUTO_DEAL_DELAY_MS=5000`, real timeout worker);
 * - exactly one SPONSORED 1H1A room is created/started through the real public
 *   UI (real SIWE wallet, live socket, SERVICE agent principal) against a
 *   deterministic loopback provider (never a paid call);
 * - the provider answers the agent's first two decisions normally (the live
 *   2.0.3 sequence: CHECK then BET 20), then switches itself into a stall:
 *   every later agent decision request hangs until the product's real per-call
 *   timeout and the platform's real action-timeout worker resolve the turn, so
 *   the agent produces no further committed action;
 * - the human plays the ordinary aggressive browser policy (CALL preflop,
 *   maximum RAISE all-in on the flop) exactly like the live run, then - once
 *   the scripted timeout has resolved and a NEW hand is dealt - submits the
 *   first server-issued legal FOLD through the same public action route;
 * - the accepted canonical response (receipt + EXACT result observation) is
 *   captured from the real POST /action response before play continues, and the
 *   awaited hook captures a read-only operator diagnostic bundle (fold receipt,
 *   events, outbox obligations, hand history, competition/tournament
 *   reconciliation) for the canonical fold hand.
 *
 * Required terminal-fold evidence (all must hold for a PASS summary): the fold
 * was accepted, its exact result observation carries a non-empty winner set,
 * the fold hand reached HAND_COMPLETED, its archive obligation completed and the
 * director progressed to the next hand or settlement-ready, the room is
 * COMPLETE, the fresh platform recorded zero HTTP 429s, no accepted-action
 * request / provider turn / persisted attempt was duplicated, no manual DEAL
 * was submitted, and the captured action payload carries no card secret.
 *
 * The runner ALWAYS writes `container-terminal-fold-summary.json` (also on
 * failure) with the mandatory immutable provenance fields and the nested
 * `provenance`/`terminalFold` contract, so the full deterministic gate and the
 * paid guards can bind a retained focused fold summary
 * (`NLHE_IT_TERMINAL_FOLD_SUMMARY`). A run against the unfixed released image
 * is expected to capture the exact failure and stay FAIL; only a proven green
 * run sets PASS.
 *
 * Caps are EXACTLY the frozen `LIVE_CAPS` (24 provider calls, 8 hands, 5s per
 * call, 120s overall runtime, 50 000 micro-USD, `MAX_PROVIDER_CONCURRENCY=2`)
 * and the same Sponsored roster limits as the paid run: the deterministic
 * provider must reproduce within the same live-shaped budget, and no timeout
 * is ever raised to hide a failure.
 *
 * Usage:
 *   NLHE_IT_STAGING_FIXTURE=<abs path to staging-platform.mjs> \
 *     tsx tests/integration/container-terminal-fold.ts [--check]
 *
 * Exit codes: 0 PASS, 1 FAIL, 2 not runnable (missing fixture/guards).
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CompetitionClient } from '@pokertools/sdk';
import { ROOT, createRunContext, type RunContext } from './infra/context.js';
import { buildChildEnv } from './infra/env-boundary.js';
import { FIXTURE_API_KEY, FIXTURE_MODEL } from './infra/fixtures.js';
import { ensureOperator } from './infra/admin.js';
import { mintOrchestrationToken, productAdminToken, provisionFakeAgentPrincipals } from './infra/agents.js';
import { writeFakeAgentRoster } from './infra/nlhe.js';
import { parseDecisionRequest, startFakeProvider, type FakeProviderHandle } from './infra/fake-provider.js';
import { getAccount, ephemeralWallet, loginWallet, type WalletSession } from './infra/wallet.js';
import { runCommand, runCommandOrThrow } from './infra/proc.js';
import { waitFor } from './infra/gameplay.js';
import { startStagingTopology, type StagingTopology } from './infra/staging.js';
import { startStandaloneContainer, type StandaloneContainerHandle } from './infra/standalone-container.js';
import {
  capturePlatformRuntimeProvenance,
  captureRunningProductProvenance,
  selectPlatformContainers,
  selectStandaloneProductContainer,
  DEFAULT_RELEASE_PLATFORM_VERSION,
  assertExpectedPlatformArtifact,
  expectedPlatformArtifact,
} from './infra/provenance.js';
import { ProductClient, type ProductRoomView } from './acceptance/product-client.js';
import {
  assertNoCardSecrets,
  type CanonicalActionCapture,
} from './acceptance/canonical-capture.js';
import { readRoomEvidence, type RoomEvidence } from './acceptance/evidence.js';
import { readPlatform429Total } from './acceptance/platform-metrics.js';
import {
  analyzeTournamentReplay,
  type TournamentReplayAnalysis,
} from './acceptance/tournament-blind-boundary.js';
import {
  collectTerminalDiagnostics,
  terminalDiagnosticCompleteness,
  terminalDiagnosticsQuery,
  type TerminalDiagnosticsBundle,
  type TerminalDiagnosticsJobStateInput,
} from './acceptance/terminal-diagnostics.js';
import { parseReconcileMetrics, type ReconcileMetricFamily } from './acceptance/live-failure-packet.js';
import { runBrowserChecks, type BrowserChecksResult } from '../browser/run.js';
import { LIVE_CAPS, LIVE_PRICING, LIVE_PER_CALL_COST_USD_MICRO } from './live.js';

/** Summary artifact name the full gate/paid guards bind by contract. */
export const TERMINAL_FOLD_SUMMARY_FILE = 'container-terminal-fold-summary.json';

const CANDIDATE_IMAGE_ID_RE = /^sha256:[0-9a-f]{64}$/;
const CANDIDATE_VERSION_RE = /^\d+\.\d+\.\d+$/;

/**
 * Read-only BullMQ job-state projection over the platform Redis container:
 * targeted hash fields only (`attemptsMade`/`failedReason`/`processedOn`/
 * `finishedOn`) plus the list/zset/set-derived state. No job payload/options
 * are ever read. The value is whitelisted again by the diagnostics module.
 *
 * State membership is Redis-TYPE dispatched: BullMQ `wait`/`active`/`paused`
 * are lists (LPOS), `completed`/`failed`/`delayed`/`prioritized` are sorted
 * sets (ZSCORE), and `waiting-children` is a set (SISMEMBER). Calling a
 * list-only command against a present zset raises WRONGTYPE, which previously
 * made every executed job read `unavailable` and failed the mandatory
 * completeness contract with `job-state-unreadable`.
 */
export const BULLMQ_JOB_STATE_SCRIPT = [
  "local id=ARGV[1] local p=ARGV[2]",
  "if redis.call('EXISTS', p..id)==0 then return {'missing','','','',''} end",
  "local st='unknown'",
  "for _,k in ipairs({'wait','active','delayed','completed','failed','paused','prioritized','waiting-children'}) do",
  '  local key=p..k',
  "  local t=redis.call('TYPE',key)['ok']",
  '  local found=false',
  "  if t=='list' then",
  "    if redis.call('LPOS',key,id) then found=true end",
  "  elseif t=='zset' then",
  "    if redis.call('ZSCORE',key,id) then found=true end",
  "  elseif t=='set' then",
  '    if redis.call(\'SISMEMBER\',key,id)==1 then found=true end',
  '  end',
  '  if found then st=k break end',
  'end',
  "local h=redis.call('HMGET', p..id, 'attemptsMade','failedReason','processedOn','finishedOn')",
  "return {st, h[1] or '', h[2] or '', h[3] or '', h[4] or ''}",
].join('\n');

/**
 * Pre-publication candidate platform artifact. This is a PROGRAMMATIC-only
 * option (no CLI flag): the caller must supply the exact local Docker image ID
 * of the built candidate, never a mutable tag or a guessed registry digest.
 * A candidate run is explicitly not paid-eligible; the released-official guard
 * stays the default until a new version is actually published.
 */
export interface TerminalFoldCandidate {
  version: string;
  imageId: string;
}

export interface TerminalFoldRunOptions {
  /** Optional candidate artifact; omitted keeps the released-official guard. */
  candidate?: TerminalFoldCandidate | null;
  /** Optional pre-created run context (programmatic callers); default fresh. */
  context?: RunContext;
}

export interface TerminalFoldRunResult {
  exitCode: number;
  summaryPath: string;
  summary: Record<string, unknown>;
}

/**
 * Pure, tight validator for the programmatic candidate pointer. It performs no
 * command execution and no filesystem access: the caller only runs it once the
 * platform engine/API candidate build is coherent and approved.
 */
export function validateTerminalFoldCandidate(value: unknown): TerminalFoldCandidate {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('terminal fold candidate must be an object { version, imageId }');
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'version' && key !== 'imageId') {
      throw new Error(`terminal fold candidate carries unsupported field ${JSON.stringify(key)}`);
    }
  }
  const version = record.version;
  if (typeof version !== 'string' || !CANDIDATE_VERSION_RE.test(version)) {
    throw new Error(
      `terminal fold candidate version ${JSON.stringify(version)} is not an exact x.y.z release version`
    );
  }
  if (version === DEFAULT_RELEASE_PLATFORM_VERSION) {
    throw new Error(
      `terminal fold candidate version ${version} is the released official artifact; a candidate must be a different pre-publication build`
    );
  }
  const imageId = record.imageId;
  if (typeof imageId !== 'string' || !CANDIDATE_IMAGE_ID_RE.test(imageId)) {
    throw new Error(
      `terminal fold candidate imageId ${JSON.stringify(imageId)} must be the exact local Docker image ID sha256:<64 lowercase hex>`
    );
  }
  return { version, imageId };
}

export type TerminalFoldSecretScan = 'pass' | 'fail' | 'not-run';

/**
 * Durable fallback fold boundary: when the accepted HTTP action response never
 * resolves, the operator database still holds the exact persisted canonical
 * result (`GameActionRequest.response`) and its resulting observation
 * projection. These identities are recovered from the pre-teardown diagnostic
 * bundle and are equivalent to the HTTP capture for the fold boundary.
 */
export interface TerminalFoldDurableBoundary {
  requestId: string;
  tableId: string | null;
  handId: string;
  turnId: string;
  actionId: string;
  receiptStatus: string;
  responseReceiptRequestId: string | null;
  /** Durable acceptance timestamp (ms epoch) of the persisted canonical result. */
  acceptedAt: number | null;
  winnersNonEmpty: boolean;
  /** True when the durable receipt's own observation identifies the same hand. */
  observationHandMatches: boolean;
}

/** Machine-readable terminal-fold verdict (mandatory summary section). */
export interface TerminalFoldEvidence {
  status: 'PASS' | 'FAIL';
  requestId: string | null;
  tableId: string | null;
  handId: string | null;
  family: 'FOLD';
  handCompleted: boolean;
  archiveCompleted: boolean;
  directorProgressed: boolean;
  continuation: 'NEXT_HAND' | 'SETTLEMENT_READY' | null;
  roomTerminal: boolean;
  platform429: number | null;
  secretScan: TerminalFoldSecretScan;
}

export interface TerminalFoldCheck {
  name: string;
  pass: boolean;
  detail: string | null;
}

export interface TerminalFoldInputs {
  roomStatus: string | null;
  capture: CanonicalActionCapture | null;
  /** Durable operator fallback when the HTTP fold response never returned. */
  durableFold?: TerminalFoldDurableBoundary | null;
  /** Exact fold boundary observation: the result observation carries winners. */
  replay: Pick<
    TournamentReplayAnalysis,
    'handStarts' | 'handCompletions' | 'manualDealActions' | 'duplicateRequestIds'
  > | null;
  diagnostics: TerminalDiagnosticsBundle | null;
  competition: { settlementReady: boolean; status: string } | null;
  platform429: number | null;
  secretScan: TerminalFoldSecretScan;
  noCardSecrets: boolean;
  noDuplicateAttempts: boolean;
  noDuplicateProviderTurns: boolean;
}

export interface TerminalFoldVerdict {
  evidence: TerminalFoldEvidence;
  checks: TerminalFoldCheck[];
  nextHandStarted: boolean;
  winnersNonEmpty: boolean;
  acceptedFold: boolean;
}

/**
 * Canonical hand identity inside an outbox obligation payload. `archive-hand`
 * and `settle-hand` carry `handId`; `next-hand` carries `expectedHandId`; the
 * durable value is the composite `<tableId>_<handId>`.
 */
function payloadHandId(payload: Record<string, unknown>): string | null {
  for (const key of ['handId', 'expectedHandId']) {
    const handId = payload[key];
    if (typeof handId === 'string' && handId.length > 0) return handId;
  }
  return null;
}

/** Composite `<tableId>_<handId>` and bare `<handId>` both identify the hand. */
function payloadHandMatches(payloadId: string | null, handId: string): boolean {
  if (payloadId === null) return false;
  return payloadId === handId || payloadId.endsWith(`_${handId}`);
}

/**
 * Pure classification of the retained terminal-fold evidence. Every mandatory
 * invariant is a named check; PASS requires all of them, so an incomplete
 * diagnostic bundle, a stalled fold hand or a duplicated exchange can never
 * pass.
 */
export function classifyTerminalFold(input: TerminalFoldInputs): TerminalFoldVerdict {
  const capture = input.capture;
  const durable = input.durableFold ?? null;
  const requestId = capture?.receipt.requestId ?? durable?.requestId ?? null;
  const tableId = capture?.receipt.tableId ?? durable?.tableId ?? null;
  const handId = capture?.observation.state.handId ?? durable?.handId ?? null;
  const acceptedFold =
    capture !== null
      ? capture.family === 'FOLD' &&
        capture.request.actionId === capture.receipt.actionId &&
        capture.receipt.requestId === capture.request.requestId
      : durable !== null &&
        durable.receiptStatus === 'COMPLETED' &&
        durable.responseReceiptRequestId === durable.requestId &&
        durable.observationHandMatches;
  const winnersNonEmpty =
    capture !== null
      ? (capture.observation.state.winners?.length ?? 0) > 0
      : durable?.winnersNonEmpty === true;
  // ---- no-stranded-chips (exact settled fold observation) ----
  // The accepted HTTP capture is the primary exact observation; when it never
  // resolved, the durable receipt's projected snapshot is the boundary. Both
  // must show a FULLY SETTLED state: no chip remains in pots or currentBets,
  // every committed chip is conserved across the remaining stacks (minus the
  // rake the fold hand's settle-hand obligation accounts for), and exactly one
  // contender is still live (the sole-contender shape the terminal fold must
  // resolve). Nonzero pots/currentBets or a lost stack is stranded money and
  // fails closed.
  const exactState = (capture?.observation.state ??
    input.diagnostics?.foldReceipt?.observation?.state ??
    null) as {
    actionTo?: unknown;
    winners?: unknown;
    players?: unknown;
    pots?: unknown;
    currentBets?: unknown;
  } | null;
  const chipsConservation: { pass: boolean; detail: string | null } = (() => {
    const fail = (detail: string): { pass: boolean; detail: string } => ({ pass: false, detail });
    if (exactState === null) return fail('no exact fold observation state for the folded hand');
    if (exactState.actionTo !== null) {
      return fail(`the completed fold observation still has a pending actor (${String(exactState.actionTo)})`);
    }
    if (!Array.isArray(exactState.winners) || exactState.winners.length === 0) {
      return fail('the exact fold observation is not a settled winner state');
    }
    if (!Array.isArray(exactState.pots)) return fail('the settled state carries no readable pot list');
    if (!Array.isArray(exactState.players)) return fail('the settled state carries no readable player list');
    const players = (exactState.players as Array<{ status?: unknown; stack?: unknown } | null>).filter(
      (player): player is { status?: unknown; stack?: unknown } =>
        typeof player === 'object' && player !== null
    );
    if (players.length < 2) return fail(`the settled state carries ${players.length} seated player(s)`);
    const stacks: number[] = [];
    for (const player of players) {
      if (typeof player.stack !== 'number' || !Number.isFinite(player.stack) || player.stack < 0) {
        return fail(`a settled stack is not a readable non-negative chip count (${String(player.stack)})`);
      }
      if (typeof player.status !== 'string' || player.status.length === 0) {
        return fail('a settled player status is missing');
      }
      stacks.push(player.stack);
    }
    let potMoney = 0;
    for (const pot of exactState.pots) {
      const amount =
        typeof pot === 'object' && pot !== null ? (pot as { amount?: unknown }).amount : undefined;
      if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
        return fail('a settled pot amount is missing or unreadable');
      }
      potMoney += amount;
    }
    if (potMoney !== 0) {
      return fail(`the completed fold state still carries ${potMoney} chip(s) in pots`);
    }
    const currentBets = exactState.currentBets;
    if (typeof currentBets !== 'object' || currentBets === null || Array.isArray(currentBets)) {
      return fail('the settled state carries no readable currentBets projection');
    }
    for (const [seat, value] of Object.entries(currentBets as Record<string, unknown>)) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value !== 0) {
        return fail(`the completed fold state still carries chip(s) in currentBets (seat ${seat})`);
      }
    }
    const liveContenders = players.filter((player) => player.status !== 'FOLDED').length;
    if (liveContenders !== 1) {
      return fail(`the completed fold state has ${liveContenders} live contender(s), not exactly one`);
    }
    const startingStack =
      input.diagnostics?.competition?.startingStack ??
      input.diagnostics?.tournament?.startingStack ??
      null;
    if (startingStack === null || !Number.isFinite(startingStack) || startingStack <= 0) {
      return fail('no initial chip stack evidence (competition/tournament startingStack missing)');
    }
    const initialChips = startingStack * players.length;
    // Rake is accounted only when the fold hand's own settle-hand obligation
    // projects a readable rakeTotal; otherwise the completed stacks must cover
    // every initial chip exactly.
    let rake = 0;
    if (handId !== null) {
      const settleRow = input.diagnostics?.outbox.find(
        (row) => row.kind === 'settle-hand' && payloadHandMatches(payloadHandId(row.payload), handId)
      );
      const rawRake = settleRow?.payload['rakeTotal'];
      if (rawRake !== undefined && rawRake !== null) {
        if (typeof rawRake === 'number' && Number.isSafeInteger(rawRake) && rawRake >= 0) {
          rake = rawRake;
        } else if (typeof rawRake === 'string' && /^\d+$/.test(rawRake)) {
          rake = Number(rawRake);
        } else {
          return fail('the fold hand settle-hand obligation carries an unreadable rakeTotal');
        }
      }
    }
    const stackSum = stacks.reduce((total, stack) => total + stack, 0);
    if (stackSum !== initialChips - rake) {
      return fail(`completed stacks ${stackSum} + rake ${rake} != initial chips ${initialChips}`);
    }
    return { pass: true, detail: null };
  })();
  // Direct next-hand evidence comes from the platform's own committed
  // HAND_STARTED events strictly after the fold hand's last event; the public
  // replay scan is an independent fallback only.
  const diagnosticsNextHand = (input.diagnostics?.subsequentHandStarts.length ?? 0) > 0;
  const foldHandIndex = handId === null ? -1 : (input.replay?.handStarts.findIndex((hand) => hand.handId === handId) ?? -1);
  const replayNextHand =
    input.replay !== null && foldHandIndex >= 0 && input.replay.handStarts.length > foldHandIndex + 1;
  const nextHandStarted = diagnosticsNextHand || replayNextHand;
  const settlementReady =
    input.competition !== null &&
    (input.competition.settlementReady || input.competition.status === 'FINISHED');
  const handCompleted =
    handId !== null &&
    ((input.replay?.handCompletions.some((hand) => hand.handId === handId) ?? false) ||
      (input.diagnostics?.events.some(
        (event) => event.type === 'HAND_COMPLETED' && event.handId === handId
      ) ?? false));
  const archiveCompleted =
    handId !== null &&
    (input.diagnostics?.outbox.some(
      (row) =>
        row.kind === 'archive-hand' &&
        payloadHandMatches(payloadHandId(row.payload), handId) &&
        row.status === 'COMPLETED'
    ) ?? false);
  const nextHandObligationCompleted =
    handId !== null &&
    (input.diagnostics?.outbox.some(
      (row) =>
        row.kind === 'next-hand' &&
        payloadHandMatches(payloadHandId(row.payload), handId) &&
        row.status === 'COMPLETED'
    ) ?? false);
  const settleObligationCompleted =
    handId !== null &&
    (input.diagnostics?.outbox.some(
      (row) =>
        row.kind === 'settle-hand' &&
        payloadHandMatches(payloadHandId(row.payload), handId) &&
        row.status === 'COMPLETED'
    ) ?? false);
  // Director reconciliation proof (never inferred from the next hand simply
  // starting): the latest TOURNAMENT_RECONCILED must post-date the accepted
  // fold and the authoritative entrant statuses must be consistent (a busted
  // stack can never stay ACTIVE) unless the tournament is already terminal.
  const foldAcceptedAt = capture?.receipt.acceptedAt ?? durable?.acceptedAt ?? null;
  const reconciliation = input.diagnostics?.reconciliation ?? null;
  const reconciliationAt =
    reconciliation === null ? Number.NaN : Date.parse(reconciliation.occurredAt);
  const reconciliationAfterFold =
    reconciliation !== null &&
    Number.isFinite(reconciliationAt) &&
    foldAcceptedAt !== null &&
    reconciliationAt >= foldAcceptedAt;
  const terminalTournament =
    input.diagnostics?.tournament?.status === 'FINISHED' ||
    input.competition?.status === 'FINISHED';
  const entrantStatusConsistent =
    terminalTournament ||
    (input.diagnostics?.entrants ?? []).every(
      (entrant) => !(entrant.authoritativeStack === 0 && entrant.tournamentStatus === 'ACTIVE')
    );
  const directorProgressed =
    reconciliation !== null &&
    entrantStatusConsistent &&
    (reconciliationAfterFold || terminalTournament);
  const continuation: TerminalFoldEvidence['continuation'] =
    nextHandStarted || nextHandObligationCompleted
      ? 'NEXT_HAND'
      : settlementReady || settleObligationCompleted
        ? 'SETTLEMENT_READY'
        : null;
  const roomTerminal = input.roomStatus === 'COMPLETE';
  const noManualDeal = (input.replay?.manualDealActions.length ?? 1) === 0;
  const noDuplicateRequests = (input.replay?.duplicateRequestIds.length ?? 1) === 0;
  // Collection incompleteness can never pass: the corrected diagnostics module
  // owns the mandatory per-identity contract and its typed collection errors.
  const completeness =
    input.diagnostics === null ? null : terminalDiagnosticCompleteness(input.diagnostics);
  const diagnosticsComplete =
    completeness !== null &&
    completeness.collectionErrors === 0 &&
    completeness.complete &&
    input.diagnostics !== null &&
    input.diagnostics.foldReceipt !== null &&
    requestId !== null &&
    input.diagnostics.foldReceipt.requestId === requestId &&
    // The durable fold receipt's own observation snapshot (when projected) must
    // identify the same canonical fold hand as the exact action response.
    (input.diagnostics.foldReceipt.observation?.state?.handId == null ||
      handId === null ||
      input.diagnostics.foldReceipt.observation.state.handId === handId);
  const diagnosticsDetail = (): string => {
    if (input.diagnostics === null) return 'no operator diagnostic bundle was collected';
    if (completeness === null) return 'the operator diagnostic bundle was not evaluated';
    const parts: string[] = [...completeness.errors];
    if (!completeness.complete && parts.length === 0) parts.push('incomplete');
    if (requestId !== null && input.diagnostics.foldReceipt?.requestId !== requestId) {
      parts.push('exact-fold-receipt-mismatch');
    }
    return parts.length > 0 ? parts.join(',') : 'incomplete';
  };
  // Mandatory phase6 sections: the corrected diagnostics contract covers
  // required identities; these outcome sections must additionally be present
  // for a followed-through fold hand (history archived, outbox obligation rows,
  // tournament reconciliation) rather than an empty/failed collection.
  const mandatorySections =
    input.diagnostics !== null &&
    input.diagnostics.table !== null &&
    input.diagnostics.events.length > 0 &&
    input.diagnostics.outbox.length > 0 &&
    input.diagnostics.handHistory.exists &&
    input.diagnostics.competition !== null &&
    input.diagnostics.tournament !== null &&
    input.diagnostics.entrants.length >= 2 &&
    // The authoritative entrant table binding is now projected; an entrant is
    // either eliminated (null) or seated at the one table under test.
    input.diagnostics.entrants.every(
      (entrant) => entrant.currentTableId === null || entrant.currentTableId === input.diagnostics!.table?.id
    ) &&
    input.diagnostics.reconciliation !== null;
  // Forward-compatible mandatory public predicate: when the diagnostics module
  // projects `canonicalReady`, it must be exactly true; an older module without
  // the field is reported as unknown, never fabricated as ready.
  const bundleRecord = input.diagnostics as unknown as Record<string, unknown> | null;
  const canonicalReady = bundleRecord === null ? undefined : bundleRecord['canonicalReady'];
  const canonicalReadyPass = canonicalReady === undefined || canonicalReady === true;

  const checks: TerminalFoldCheck[] = [
    { name: 'accepted-fold', pass: acceptedFold, detail: acceptedFold ? null : 'no coherent accepted canonical FOLD capture' },
    { name: 'winners-nonempty', pass: winnersNonEmpty, detail: winnersNonEmpty ? null : 'the exact fold result observation carries no winner' },
    { name: 'no-stranded-chips', pass: chipsConservation.pass, detail: chipsConservation.detail },
    { name: 'diagnostics-complete', pass: diagnosticsComplete, detail: diagnosticsComplete ? null : diagnosticsDetail() },
    { name: 'mandatory-phase6-sections', pass: mandatorySections, detail: mandatorySections ? null : 'table/events/outbox/hand-history/competition/tournament/entrants/reconciliation missing' },
    { name: 'canonical-ready', pass: canonicalReadyPass, detail: canonicalReadyPass ? null : 'canonicalReady is not true' },
    { name: 'hand-completed', pass: handCompleted, detail: handCompleted ? null : 'the fold hand never reached HAND_COMPLETED' },
    { name: 'archive-completed', pass: archiveCompleted, detail: archiveCompleted ? null : 'the archive-hand obligation for the fold hand is not COMPLETED' },
    {
      name: 'director-progressed',
      pass: directorProgressed,
      detail: directorProgressed
        ? null
        : reconciliation === null
          ? 'post-fold director reconciliation not attempted/absent'
          : !entrantStatusConsistent
            ? 'authoritative entrant status inconsistent with a busted completed hand'
            : 'no TOURNAMENT_RECONCILED after the accepted fold',
    },
    { name: 'continuation', pass: continuation !== null, detail: continuation === null ? 'neither a next hand nor settlement-ready was observed' : null },
    { name: 'room-terminal', pass: roomTerminal, detail: roomTerminal ? null : `room status ${input.roomStatus ?? 'unknown'} != COMPLETE` },
    { name: 'zero-platform-429', pass: input.platform429 === 0, detail: input.platform429 === 0 ? null : `platform 429 total ${String(input.platform429)}` },
    { name: 'no-manual-deal', pass: noManualDeal, detail: noManualDeal ? null : 'an ACTION_APPLIED DEAL event was recorded' },
    { name: 'no-duplicate-action-requests', pass: noDuplicateRequests, detail: noDuplicateRequests ? null : 'duplicate accepted-action request ids in replay' },
    { name: 'no-duplicate-attempts', pass: input.noDuplicateAttempts, detail: input.noDuplicateAttempts ? null : 'duplicate persisted attempt identity' },
    { name: 'no-duplicate-provider-turns', pass: input.noDuplicateProviderTurns, detail: input.noDuplicateProviderTurns ? null : 'a provider turn was exchanged more than once' },
    { name: 'action-card-secret-scan', pass: input.noCardSecrets, detail: input.noCardSecrets ? null : 'the captured action payload carries a card value' },
    { name: 'secret-scan', pass: input.secretScan === 'pass', detail: input.secretScan === 'pass' ? null : input.secretScan === 'fail' ? 'final artifact secret scan failed' : 'external secret scanner not configured' },
  ];
  const status = checks.every((check) => check.pass) ? 'PASS' : 'FAIL';
  return {
    evidence: {
      status,
      requestId,
      tableId,
      handId,
      family: 'FOLD',
      handCompleted,
      archiveCompleted,
      directorProgressed,
      continuation,
      roomTerminal,
      platform429: input.platform429,
      secretScan: input.secretScan,
    },
    checks,
    nextHandStarted,
    winnersNonEmpty,
    acceptedFold,
  };
}

interface ScriptedFoldTrigger {
  tableId: string | null;
  agentRequests: number;
  stallArmed: boolean;
  stallHandId: string | null;
  stallTurnId: string | null;
  /** When the real timeout resolved and a new hand was observed. */
  resolvedAt: number | null;
}

/**
 * The exact live stall precondition: the agent is facing a live ALL_IN
 * opponent and holds CALL/FOLD. The real timeout worker then folds the agent
 * (it faces a wager), which is what leaves the opponent sitting out on the
 * following hand - the state in which the human fold resolves zero live
 * players. Facing a mere CHECK would make the timeout check, not fold, and the
 * sitting-out condition would never arise.
 */
function facesAllInDecision(observation: unknown): boolean {
  if (typeof observation !== 'object' || observation === null) return false;
  const record = observation as {
    state?: { players?: Array<{ status?: unknown } | null> } | null;
    legalActions?: Array<{ family?: unknown }> | null;
  };
  const allIn = (record.state?.players ?? []).some(
    (player) => player !== null && player.status === 'ALL_IN'
  );
  const facingBet = (record.legalActions ?? []).some(
    (action) => action.family === 'CALL' || action.family === 'FOLD'
  );
  return allIn && facingBet;
}

interface TerminalFoldRunState {
  topology: StagingTopology | null;
  runtime: StandaloneContainerHandle | null;
  provider: FakeProviderHandle | null;
  product: ProductClient | null;
  admin: WalletSession | null;
  roomId: string | null;
  tableId: string | null;
  room: ProductRoomView | null;
  evidence: RoomEvidence | null;
  replayAnalysis: TournamentReplayAnalysis | null;
  competition: { settlementReady: boolean; status: string } | null;
  capture: CanonicalActionCapture | null;
  durableFold: TerminalFoldDurableBoundary | null;
  hookDiagnostics: TerminalDiagnosticsBundle | null;
  finalDiagnostics: TerminalDiagnosticsBundle | null;
  browser: BrowserChecksResult | null;
  failure: string | null;
  platformVersion: string | null;
  platformImage: string | null;
  platformImageId: string | null;
  platformDigest: string | null;
  productImage: string | null;
  productImageId: string | null;
  platform429Before: number | null;
  platform429After: number | null;
  stalledRequests: number;
  retainTopology: boolean;
  teardownErrors: string[];
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertLoopback(url: string, label: string): void {
  const host = new URL(url).hostname;
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]') {
    throw new Error(`${label} must be loopback for the deterministic fold regression, saw ${host}`);
  }
}

/**
 * Every provider turn the loopback provider actually ANSWERED must be
 * exchanged exactly once. Deliberately stalled/timed-out attempts (the
 * scripted timeout sequence) never carry a response and are excluded: a
 * bounded retry of an unanswered call is the intended reproduction, not a
 * duplicate exchange.
 */
function assertNoDuplicateProviderTurns(provider: FakeProviderHandle, tableId: string): number {
  const counts = new Map<string, number>();
  for (const record of provider.requests) {
    if (!record.responded) continue;
    let parsed: { observation?: { tableId?: unknown; turnId?: unknown } };
    try {
      parsed = parseDecisionRequest(record.body) as { observation?: { tableId?: unknown; turnId?: unknown } };
    } catch {
      continue;
    }
    if (parsed.observation?.tableId !== tableId) continue;
    const turnId = parsed.observation.turnId;
    if (typeof turnId !== 'string' || turnId.length === 0) continue;
    counts.set(turnId, (counts.get(turnId) ?? 0) + 1);
  }
  const duplicates = [...counts.entries()].filter(([, count]) => count !== 1);
  if (duplicates.length > 0) {
    throw new Error(
      `provider turn duplication: ${duplicates.map(([turnId, count]) => `${turnId}x${count}`).join(',')}`
    );
  }
  return counts.size;
}

/** Persisted attempt identity uniqueness + 1:1 provider exchange. */
function assertAttemptExactness(evidence: RoomEvidence, providerRequests: number): void {
  const keys = new Set<string>();
  for (const attempt of evidence.attempts) {
    const key = `${attempt.decision_id}:${attempt.attempt_no}`;
    if (keys.has(key)) throw new Error(`duplicate persisted attempt identity ${key}`);
    keys.add(key);
  }
  const persisted = evidence.attempts.filter((attempt) => attempt.recorded_at !== null).length;
  if (persisted !== providerRequests) {
    throw new Error(`provider requests ${providerRequests} != persisted attempts ${persisted}`);
  }
}

/** Full (never truncated) redacted artifact secret scan. */
async function runFinalSecretScan(
  context: RunContext,
  scanner: string,
  manifestPath: string
): Promise<'pass'> {
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
  return 'pass';
}

function parseArgs(argv: readonly string[]): { check: boolean } {
  const unknown = argv.filter((argument) => argument !== '--check');
  if (unknown.length > 0) throw new Error(`unknown container-terminal-fold arguments: ${unknown.join(' ')}`);
  return { check: argv.includes('--check') };
}

/** Mandatory external fixture guard shared by the CLI and programmatic API. */
function requireStagingFixture(): string {
  const fixture = process.env.NLHE_IT_STAGING_FIXTURE;
  if (fixture === undefined || !isAbsolute(fixture) || !/\.m?js$/.test(fixture)) {
    throw new Error(
      'NLHE_IT_STAGING_FIXTURE is required (absolute path to the built external staging fixture exporting startStagingPlatform)'
    );
  }
  return fixture;
}

/**
 * Programmatic entrypoint. The default (no options) runs the released-official
 * guard; `{ candidate: { version, imageId } }` runs the SAME frozen-LIVE-cap
 * browser/service/fake/SQL shape against a pre-publication local candidate
 * image identified by its exact Docker image ID. A candidate summary is
 * explicitly not paid-eligible.
 */
export async function runTerminalFold(
  options: TerminalFoldRunOptions = {}
): Promise<TerminalFoldRunResult> {
  const fixture = requireStagingFixture();
  const candidate =
    options.candidate == null ? null : validateTerminalFoldCandidate(options.candidate);
  const context = options.context ?? createRunContext();
  const state: TerminalFoldRunState = {
    topology: null,
    runtime: null,
    provider: null,
    product: null,
    admin: null,
    roomId: null,
    tableId: null,
    room: null,
    evidence: null,
    replayAnalysis: null,
    competition: null,
    capture: null,
    durableFold: null,
    hookDiagnostics: null,
    finalDiagnostics: null,
    browser: null,
    failure: null,
    platformVersion: null,
    platformImage: null,
    platformImageId: null,
    platformDigest: null,
    productImage: null,
    productImageId: null,
    platform429Before: null,
    platform429After: null,
    stalledRequests: 0,
    retainTopology: false,
    teardownErrors: [],
  };
  let secretScan: TerminalFoldSecretScan = 'not-run';
  let noCardSecrets = true;
  let noDuplicateAttempts = true;
  let noDuplicateProviderTurns = true;
  let databasePath: string | null = null;
  const redact = (value: string): string =>
    (state.topology?.secretRegistry.redact(value) ?? value).replace(/[\r\n]+/g, ' ').slice(0, 2_000);

  const readJobState = async (job: TerminalDiagnosticsJobStateInput): Promise<unknown> => {
    if (state.topology === null) return { state: 'unavailable', exists: null };
    const result = await runCommand(
      'docker',
      [
        'exec',
        state.topology.redisContainer,
        'redis-cli',
        '--json',
        'EVAL',
        BULLMQ_JOB_STATE_SCRIPT,
        '0',
        job.outboxId,
        `bull:${job.kind}:`,
      ],
      { timeoutMs: 15_000 }
    );
    if (result.code !== 0) return { state: 'unavailable', exists: null };
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout.trim() === '' ? 'null' : result.stdout.trim());
    } catch {
      return { state: 'unavailable', exists: null };
    }
    if (!Array.isArray(parsed) || typeof parsed[0] !== 'string') {
      return { state: 'unavailable', exists: null };
    }
    const numberOrNull = (value: unknown): number | null => {
      const numeric = Number(value);
      return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
    };
    const [jobState, attemptsMade, failedReason, processedOn, finishedOn] = parsed as Array<string | null>;
    return {
      state: jobState,
      exists: jobState === 'missing' ? false : true,
      attemptsMade: numberOrNull(attemptsMade),
      failedReason: typeof failedReason === 'string' && failedReason.length > 0 ? failedReason : null,
      processedOn: numberOrNull(processedOn),
      finishedOn: numberOrNull(finishedOn),
    };
  };

  /**
   * Reconcile-family metric counters from the platform's own `/metrics`
   * (numeric families only, labels dropped by the parser). `null` means the
   * read FAILED/unknown and is reported as such - never fabricated as zero.
   */
  let reconcileMetrics: ReconcileMetricFamily[] | null = null;
  let reconcileMetricsStatus: 'ok' | 'unavailable' = 'unavailable';
  const readReconcileMetricFamilies = async (): Promise<void> => {
    if (state.topology === null) return;
    try {
      const response = await fetch(state.topology.platformMetrics.url, {
        headers: { authorization: `Bearer ${state.topology.platformMetrics.token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return;
      reconcileMetrics = parseReconcileMetrics(await response.text());
      reconcileMetricsStatus = 'ok';
    } catch {
      // Leave status unavailable: a failed metrics read is unknown, not zero.
    }
  };

  context.log(`container terminal-fold regression ${context.runId}`);
  context.log(`artifacts: ${context.artifactDir}`);

  // The scripted deterministic trigger: responses 1-2 are the normal varied
  // intro (the observed live 2.0.3 CHECK then BET 20); from the first decision
  // that faces a live ALL_IN opponent onward, the provider stalls so the REAL
  // per-call timeout and the REAL platform action-timeout worker resolve the
  // turn (folding the agent, as in the live turn8), and the agent commits
  // nothing further. No caps, timeouts or manual DEAL are changed.
  const trigger: ScriptedFoldTrigger = {
    tableId: null,
    agentRequests: 0,
    stallArmed: false,
    stallHandId: null,
    stallTurnId: null,
    resolvedAt: null,
  };
  let setStall: () => void = () => undefined;

  /**
   * Retained read-only evidence collection. Runs BEFORE teardown on success and
   * failure alike; every step is best-effort so a partial failure still writes
   * a diagnosable summary.
   */
  const collectRetainedEvidence = async (): Promise<void> => {
    const topology = state.topology;
    const admin = state.admin;
    const product = state.product;
    if (topology === null || admin === null || product === null || state.tableId === null) return;
    const tableId = state.tableId;
    if (databasePath !== null && state.roomId !== null) {
      try {
        state.room = state.room ?? (await product.getRoom(state.roomId));
        state.evidence = state.evidence ?? readRoomEvidence(databasePath, state.roomId);
      } catch (error) {
        context.log(`evidence collection (product room) failed safely: ${redact(errorText(error))}`);
      }
    }
    if (state.replayAnalysis === null) {
      try {
        const replay = await admin.client.getReplay(tableId, { fromEventSeq: 1 });
        state.replayAnalysis = analyzeTournamentReplay(replay.events);
      } catch (error) {
        context.log(`evidence collection (replay) failed safely: ${redact(errorText(error))}`);
      }
    }
    if (state.competition === null && state.room?.pokerCompetitionId != null) {
      try {
        const competition = await new CompetitionClient({
          baseUrl: topology.platformUrl,
          token: admin.token,
          timeout: 30_000,
        }).getCompetition(state.room.pokerCompetitionId);
        state.competition = { settlementReady: competition.settlementReady, status: competition.status };
      } catch (error) {
        context.log(`evidence collection (competition) failed safely: ${redact(errorText(error))}`);
      }
    }
    if (state.finalDiagnostics === null) {
      if (reconcileMetricsStatus !== 'ok') {
        await readReconcileMetricFamilies();
      }
      const collectBundle = (identifiers: {
        roomId: string | null;
        tableId: string | null;
        competitionId: string | null;
        handId: string | null;
        requestId: string | null;
        turnId: string | null;
      }) =>
        collectTerminalDiagnostics({
          query: terminalDiagnosticsQuery(topology.adminTarget),
          identifiers,
          knownSecrets: topology.secretRegistry.values(),
          redactText: (text) => topology.secretRegistry.redact(text),
          readJobState,
          metrics: {
            platform429Before: state.platform429Before,
            // Failed/unknown metrics stay null, never a fabricated zero.
            reconcileMetrics: reconcileMetricsStatus === 'ok' ? reconcileMetrics : null,
            reconcileMetricsStatus,
            browserFailures: state.browser?.failures ?? [],
          },
        });
      let bundle = await collectBundle({
        roomId: state.roomId,
        tableId,
        competitionId: state.room?.pokerCompetitionId ?? null,
        handId: state.capture?.observation.state.handId ?? null,
        requestId: state.capture?.receipt.requestId ?? null,
        turnId: state.capture?.receipt.turnId ?? null,
      });
      if (state.capture === null && bundle.foldReceipt !== null) {
        // The accepted HTTP response never resolved: recover the exact fold
        // boundary from the durable canonical result. ONLY a FOLD by the human
        // wallet, accepted after the scripted trigger resolved, is the forced
        // boundary; an earlier/agent timeout fold is never misattributed.
        const firstReceipt = bundle.foldReceipt;
        const humanPrincipalId =
          state.room?.participants.find((participant) => participant.kind === 'HUMAN')
            ?.pokerPrincipalId ?? null;
        const firstAcceptedAt = firstReceipt.responseReceipt?.acceptedAt ?? null;
        const isHumanPostTriggerFold =
          humanPrincipalId !== null &&
          firstReceipt.principalId === humanPrincipalId &&
          firstReceipt.replayed !== true &&
          firstAcceptedAt !== null &&
          trigger.resolvedAt !== null &&
          firstAcceptedAt >= trigger.resolvedAt;
        if (!isHumanPostTriggerFold) {
          context.log(
            `durable FOLD candidate rejected: principal=${firstReceipt.principalId} human=${humanPrincipalId ?? 'unknown'} acceptedAt=${String(firstAcceptedAt)} triggerResolvedAt=${String(trigger.resolvedAt)}`
          );
        } else {
          const firstHandId =
            firstReceipt.observation?.state?.handId ?? firstReceipt.responseReceipt?.handId ?? null;
          const firstTableId = firstReceipt.observation?.tableId ?? tableId;
          const scoped = await collectBundle({
            roomId: state.roomId,
            tableId: firstTableId,
            competitionId: state.room?.pokerCompetitionId ?? null,
            handId: firstHandId,
            requestId: firstReceipt.requestId,
            turnId: firstReceipt.turnId,
          });
          if (
            scoped.collection.status === 'COMPLETE' &&
            scoped.foldReceipt !== null &&
            scoped.foldReceipt.requestId === firstReceipt.requestId
          ) {
            bundle = scoped;
          }
          const receipt = bundle.foldReceipt;
          const receiptHandId =
            receipt?.observation?.state?.handId ?? receipt?.responseReceipt?.handId ?? firstHandId;
          if (receipt != null && receiptHandId !== null && receiptHandId.length > 0) {
            const observationHandId = receipt.observation?.state?.handId ?? null;
            state.durableFold = {
              requestId: receipt.requestId,
              tableId: receipt.observation?.tableId ?? firstTableId,
              handId: receiptHandId,
              turnId: receipt.turnId,
              actionId: receipt.actionId,
              receiptStatus: receipt.status,
              responseReceiptRequestId: receipt.responseReceipt?.requestId ?? null,
              acceptedAt: receipt.responseReceipt?.acceptedAt ?? null,
              winnersNonEmpty: (receipt.observation?.state?.winners?.length ?? 0) > 0,
              observationHandMatches:
                observationHandId === null || observationHandId === receiptHandId,
            };
            context.log(
              `durable fold fallback recovered: requestId=${state.durableFold.requestId} hand=${state.durableFold.handId} status=${state.durableFold.receiptStatus} winners=${state.durableFold.winnersNonEmpty}`
            );
          }
        }
      }
      state.finalDiagnostics = bundle;
      writeFileSync(
        join(context.artifactDir, 'terminal-fold-diagnostics.json'),
        `${topology.secretRegistry.redact(JSON.stringify(state.finalDiagnostics, null, 2))}\n`,
        { mode: 0o600 }
      );
    }
    if (state.platform429After === null) {
      state.platform429After = await readPlatform429Total(topology.platformMetrics).catch(() => null);
    }
    const provider = state.provider;
    if (provider !== null && state.evidence !== null) {
      const providerRequests = provider.requestCountForTable(tableId);
      try {
        assertAttemptExactness(state.evidence, providerRequests);
      } catch (error) {
        noDuplicateAttempts = false;
        state.failure = state.failure ?? redact(errorText(error));
      }
      try {
        assertNoDuplicateProviderTurns(provider, tableId);
      } catch (error) {
        noDuplicateProviderTurns = false;
        state.failure = state.failure ?? redact(errorText(error));
      }
      state.stalledRequests = provider.requests.filter((record) => !record.responded).length;
    }
  };

  try {
    const topology = await startStagingTopology({
      context,
      sponsor: { principalId: randomUUID(), address: getAccount(2).address },
      ...(candidate !== null ? { platformImage: candidate.imageId } : {}),
    });
    state.topology = topology;
    context.log(`fresh staging topology ready: platform=${topology.platformImage} product=${topology.productImage}`);
    await topology.assertHealthy('terminal fold start', { requireCustodyHeartbeat: true });

    // Immutable provenance is mandatory for the retained summary; capture the
    // ACTUAL running API/workers/custody and product containers (read-only).
    const platformProvenance = await capturePlatformRuntimeProvenance(
      selectPlatformContainers(topology.supervisor.names())
    );
    state.platformVersion = platformProvenance.artifact.version;
    state.platformImage = platformProvenance.artifact.image;
    state.platformImageId = platformProvenance.artifact.imageId;
    state.platformDigest = platformProvenance.artifact.digest;
    if (candidate === null) {
      // Released-official guard: the ACTUAL running artifact must be exactly
      // the released immutable image, version and digest. A mutable tag or a
      // different digest can never pass the default/CLI path.
      assertExpectedPlatformArtifact(
        platformProvenance.artifact,
        expectedPlatformArtifact(topology.platformImage)
      );
      context.log(
        `released-official platform provenance verified: version=${state.platformVersion} image=${state.platformImage} id=${state.platformImageId} digest=${state.platformDigest ?? 'none'}`
      );
    } else {
      const actual = platformProvenance.artifact;
      if (actual.version !== candidate.version) {
        throw new Error(
          `candidate platform version ${actual.version} != declared candidate version ${candidate.version}`
        );
      }
      if (actual.image !== candidate.imageId || actual.imageId !== candidate.imageId) {
        throw new Error(
          `candidate platform identity mismatch: Config.Image=${actual.image} imageId=${actual.imageId} != declared local image ${candidate.imageId}`
        );
      }
      // A local containerd build can expose its actual manifest digest.
      // It remains a candidate because the configured reference is the exact
      // local image ID, not the published immutable registry reference.
      // Preserve manifest evidence in captured containers; the release-facing
      // digest stays null and paid eligibility stays false.
      actual.digest = null;
      context.log(
        `candidate platform provenance verified: version=${candidate.version} imageId=${candidate.imageId} digest=null (releasedArtifact=false, not paid-eligible)`
      );
    }

    const provider = await startFakeProvider({
      mode: 'varied',
      onRequest: (record) => {
        let parsed: ReturnType<typeof parseDecisionRequest>;
        try {
          parsed = parseDecisionRequest(record.body);
        } catch {
          return;
        }
        const observation = parsed.observation as
          | { tableId?: unknown; handId?: unknown; turnId?: unknown }
          | null;
        if (observation === null || typeof observation.tableId !== 'string') return;
        if (trigger.tableId === null) trigger.tableId = observation.tableId;
        if (observation.tableId !== trigger.tableId) return;
        trigger.agentRequests += 1;
        // Keep the first two decisions as the live intro; stall from the first
        // decision that faces the opponent's all-in (the live turn8 shape).
        if (trigger.agentRequests >= 2 && facesAllInDecision(parsed.observation)) {
          if (!trigger.stallArmed) {
            trigger.stallArmed = true;
            trigger.stallHandId =
              typeof observation.handId === 'string' ? observation.handId : null;
            trigger.stallTurnId =
              typeof observation.turnId === 'string' ? observation.turnId : null;
            context.log(
              `scripted provider stall armed on agent decision #${trigger.agentRequests} facing all-in (hand=${trigger.stallHandId ?? 'unknown'})`
            );
          }
          setStall();
        }
      },
    });
    state.provider = provider;
    setStall = () => provider.setMode('stall');
    assertLoopback(provider.baseUrl, 'provider URL');

    state.platform429Before = await readPlatform429Total(topology.platformMetrics);
    if (state.platform429Before !== 0) {
      throw new Error(`fresh platform already recorded ${state.platform429Before} HTTP 429 response(s)`);
    }

    const admin = await loginWallet(topology.platformUrl, ephemeralWallet());
    state.admin = admin;
    const promotion = await ensureOperator(topology.adminTarget, admin);
    if (!promotion.promoted) throw new Error('terminal fold operator wallet was not promoted to ADMIN');
    const orchestrator = await mintOrchestrationToken(admin);
    const principals = await provisionFakeAgentPrincipals(admin, 2, {
      delegatedToPrincipalId: orchestrator.principalId,
    });
    const roster = await writeFakeAgentRoster(context, {
      baseUrl: provider.baseUrl,
      pricing: LIVE_PRICING,
      limits: {
        maxCallsPerRoom: LIVE_CAPS.maxCalls,
        maxCostMicroUsdPerRoom: Number(LIVE_CAPS.maxCostUsdMicro),
        maxCostMicroUsdPerCall: LIVE_PER_CALL_COST_USD_MICRO,
      },
      principals,
    });
    const adminToken = productAdminToken();
    topology.addProductSecret('PRODUCT_ADMIN_TOKEN', adminToken);
    topology.addProductSecret('POKERTOOLS_ORCHESTRATION_TOKEN', orchestrator.token);
    topology.addProductSecret('OPENAI_API_KEY', FIXTURE_API_KEY);

    const platformContainerHost = topology.platform.finance?.apiContainerName;
    if (!platformContainerHost) {
      throw new Error('staging fixture must expose the API container identity for direct service routing');
    }

    databasePath = join(context.artifactDir, 'nlhe-terminal-fold.sqlite');
    const runtime = await startStandaloneContainer({
      supervisor: topology.supervisor,
      context,
      runtimeDir: topology.runtimeDir,
      secretRegistry: topology.secretRegistry,
      productImage: topology.productImage,
      dockerNetwork: topology.network,
      platformContainerHost,
      platformUrl: topology.platformUrl,
      productUrl: topology.productUrl,
      providerBaseUrl: provider.baseUrl,
      providerApiKey: FIXTURE_API_KEY,
      providerModel: FIXTURE_MODEL,
      orchestrationToken: orchestrator.token,
      productAdminToken: adminToken,
      agentsConfigPath: roster.path,
      databasePath,
      maxProviderCalls: LIVE_CAPS.maxCalls,
      maxHands: LIVE_CAPS.maxHands,
      extraEnv: {
        PER_CALL_TIMEOUT_MS: String(LIVE_CAPS.perCallTimeoutMs),
        OVERALL_RUNTIME_MS: String(LIVE_CAPS.overallRuntimeMs),
        MAX_COST_USD_MICRO: String(LIVE_CAPS.maxCostUsdMicro),
        MAX_PROVIDER_CONCURRENCY: '2',
        CHALLENGE_ENABLED: '0',
      },
    });
    state.runtime = runtime;
    state.product = new ProductClient(runtime.baseUrl, { adminToken });
    await topology.supervisor.assertAllAlive('terminal fold container start');
    await runtime.waitForReady();
    context.log(`standalone product ready at ${runtime.baseUrl} (container ${runtime.name})`);

    const productProvenance = await captureRunningProductProvenance(
      selectStandaloneProductContainer(topology.supervisor.names())
    );
    state.productImage = productProvenance.image;
    state.productImageId = productProvenance.imageId;
    context.log(`product provenance: image=${state.productImage} id=${state.productImageId}`);

    // The scripted fold trigger: the provider stalls >= 2 agent decisions (the
    // real per-call timeout spent on each attempt), then the REAL platform
    // action-timeout worker resolves the turn and the auto-dealer moves to a
    // NEW hand. Only then is the fold armed - never on the first normal hand.
    const when = async (): Promise<void> => {
      await waitFor(
        'a stalled scripted provider attempt for the agent decision',
        async () => {
          const stalled = provider.requests.filter((record) => !record.responded).length;
          return stalled >= 1 ? stalled : null;
        },
        { timeoutMs: 30_000, intervalMs: 250 }
      );
      if (trigger.stallHandId === null) {
        throw new Error('the scripted provider never observed the agent stall hand');
      }
      context.log(
        `scripted provider stalled the agent on hand ${trigger.stallHandId}; awaiting the real timeout resolution and a new hand`
      );
      await waitFor(
        'real timeout resolution and a new hand after the stalled agent turn',
        async () => {
          if (state.tableId === null) return null;
          const table = await admin.client.getTableState(state.tableId).catch(() => null);
          if (table === null) return null;
          return table.handId !== trigger.stallHandId ? table.handId : null;
        },
        { timeoutMs: 60_000, intervalMs: 1_000 }
      );
      trigger.resolvedAt = Date.now();
      context.log('real timeout resolved the stalled agent turn; fold armed on a new hand');
    };

    const onAccepted = async (capture: CanonicalActionCapture): Promise<void> => {
      state.capture = capture;
      assertNoCardSecrets('terminal fold capture', capture);
      const hookBundle = await collectTerminalDiagnostics({
        query: terminalDiagnosticsQuery(topology.adminTarget),
        identifiers: {
          roomId: state.roomId,
          tableId: capture.receipt.tableId,
          handId: capture.observation.state.handId,
          requestId: capture.receipt.requestId,
          turnId: capture.receipt.turnId,
        },
        knownSecrets: topology.secretRegistry.values(),
        redactText: (text) => topology.secretRegistry.redact(text),
        readJobState,
        metrics: { phase: 'fold-accepted' },
      });
      state.hookDiagnostics = hookBundle;
      writeFileSync(
        join(context.artifactDir, 'terminal-fold-hook-diagnostics.json'),
        `${topology.secretRegistry.redact(JSON.stringify(hookBundle, null, 2))}\n`,
        { mode: 0o600 }
      );
      if (hookBundle.collection.status !== 'COMPLETE') {
        throw new Error(`fold hook diagnostics are incomplete: ${hookBundle.collection.error ?? 'unknown'}`);
      }
      const hookCompleteness = terminalDiagnosticCompleteness(hookBundle);
      if (hookCompleteness.collectionErrors > 0) {
        throw new Error(
          `fold hook diagnostics have ${hookCompleteness.collectionErrors} collection error(s): ${hookCompleteness.errors.join(',')}`
        );
      }
      if (
        hookBundle.foldReceipt === null ||
        hookBundle.foldReceipt.requestId !== capture.receipt.requestId ||
        hookBundle.foldReceipt.actionId !== capture.receipt.actionId
      ) {
        throw new Error('fold hook diagnostics did not prove the exact durable fold receipt');
      }
    };

    state.browser = await runBrowserChecks({
      context,
      productBaseUrl: runtime.baseUrl,
      platformBaseUrl: topology.platformUrl,
      getRoomEvidence: (roomId) => readRoomEvidence(databasePath!, roomId),
      humanFoldAfter: {
        when,
        onAccepted,
        // Hold the driver from the moment the scripted provider stalls until
        // `when()` resolves on the real timeout/new hand: the human's turn must
        // stay pending for the armed FOLD instead of racing the timeout with
        // another all-in that could complete the room without a fold.
        stalled: () => trigger.stallArmed && trigger.resolvedAt === null,
      },
      onPhase: (phase) => {
        if (typeof phase.roomId === 'string') state.roomId = phase.roomId;
        if (typeof phase.tableId === 'string') state.tableId = phase.tableId;
        if (phase.name === 'human-fold') context.log(`human fold accepted: ${phase.detail ?? ''}`);
      },
    });
    if (state.browser.roomId !== null) state.roomId = state.browser.roomId;
    if (state.browser.tableId !== null) state.tableId = state.browser.tableId;
    if (state.browser.humanFold !== null && state.capture === null) state.capture = state.browser.humanFold;

    await collectRetainedEvidence();

    if (state.browser.code !== 0) {
      // A never-returning accepted action response is the exact reproduced
      // failure shape: the browser cannot capture the HTTP result, but the
      // durable operator receipt already proves the accepted fold boundary.
      // Only that specific missing-capture failure is tolerated, and only
      // when the durable boundary was actually recovered; every other browser
      // failure (and every terminal invariant) still fails.
      const onlyMissingHttpFold =
        state.browser.failures.length > 0 &&
        state.browser.failures.every(
          (failure) =>
            failure.includes('without an accepted canonical FOLD') ||
            failure.includes('no accepted canonical response was captured within')
        );
      if (!(onlyMissingHttpFold && state.durableFold !== null)) {
        throw new Error(`browser terminal checks failed: ${state.browser.failures.join(' | ')}`);
      }
      context.log('accepted FOLD HTTP response did not resolve; durable operator receipt is the boundary');
    }
    if (state.capture === null && state.durableFold === null) {
      throw new Error('the browser run did not produce an accepted canonical FOLD capture or durable receipt');
    }
    if (state.room === null || state.room.status !== 'COMPLETE') {
      throw new Error(`room status ${state.room?.status ?? 'unknown'} != COMPLETE`);
    }
  } catch (error) {
    state.failure = state.failure ?? redact(errorText(error));
  } finally {
    // Retained evidence must be collected before any teardown.
    await collectRetainedEvidence().catch(() => undefined);
    // An incomplete diagnostic packet must never destroy the only copy of the
    // operator evidence: retain the live platform topology (PostgreSQL, Redis,
    // workers, custody) for an operator re-capture, and stop only the NLHE
    // product and the deterministic provider.
    const completeness =
      state.finalDiagnostics === null ? null : terminalDiagnosticCompleteness(state.finalDiagnostics);
    state.retainTopology = completeness !== null && completeness.collectionErrors > 0;
    try {
      await state.runtime?.stop();
    } catch (error) {
      state.teardownErrors.push(`container stop: ${redact(errorText(error))}`);
    }
    try {
      await state.provider?.stop();
    } catch (error) {
      state.teardownErrors.push(`provider stop: ${redact(errorText(error))}`);
    }
    if (state.topology !== null) {
      if (state.retainTopology) {
        context.log(
          `RETAINED live platform topology for operator re-capture (collection errors=${completeness?.collectionErrors ?? 'unknown'}): runtimeDir=${state.topology.runtimeDir} platform=${state.topology.platformUrl} postgres=${state.topology.postgresContainer} redis=${state.topology.redisContainer}`
        );
      } else {
        try {
          for (const cleanupError of await state.topology.stop()) {
            state.teardownErrors.push(`topology stop: ${redact(cleanupError)}`);
          }
        } catch (error) {
          state.teardownErrors.push(`topology stop: ${redact(errorText(error))}`);
        }
      }
    }
  }

  // ---- Final secret scan after every teardown log has been captured ----
  const scanner = process.env.NLHE_IT_SECRET_SCANNER;
  if (state.topology !== null && scanner !== undefined && isAbsolute(scanner)) {
    try {
      const scanDir = mkdtempSync(join(dirname(state.topology.runtimeDir), 'terminal-fold-scan-'));
      try {
        const manifest = state.topology.secretRegistry.persistEnvManifest(join(scanDir, 'secrets.env'));
        secretScan = await runFinalSecretScan(context, scanner, manifest);
      } finally {
        rmSync(scanDir, { recursive: true, force: true });
      }
    } catch (error) {
      secretScan = 'fail';
      state.failure = state.failure ?? redact(errorText(error));
    }
  }

  // Action-payload card hygiene is mandatory regardless of the external scan.
  try {
    if (state.capture !== null) assertNoCardSecrets('summary fold capture', state.capture);
  } catch (error) {
    noCardSecrets = false;
    state.failure = state.failure ?? redact(errorText(error));
  }

  if (state.teardownErrors.length > 0) {
    state.failure = state.failure ?? state.teardownErrors.join(' | ');
  }

  const { evidence, checks, winnersNonEmpty } = classifyTerminalFold({
    roomStatus: state.room?.status ?? null,
    capture: state.capture,
    durableFold: state.durableFold,
    replay: state.replayAnalysis,
    diagnostics: state.finalDiagnostics,
    competition: state.competition,
    platform429: state.platform429After,
    secretScan,
    noCardSecrets,
    noDuplicateAttempts,
    noDuplicateProviderTurns,
  });
  if (state.failure !== null && evidence.status === 'PASS') {
    evidence.status = 'FAIL';
    checks.push({ name: 'run-failure', pass: false, detail: state.failure });
  }
  const failedChecks = checks.filter((check) => !check.pass);
  if (failedChecks.length > 0) {
    state.failure =
      state.failure ??
      `terminal fold checks failed: ${failedChecks
        .map((check) => `${check.name}${check.detail === null ? '' : ` (${check.detail})`}`)
        .join('; ')}`;
  }

  // Widened reads: these are assigned from the metrics fetch closure, so
  // control-flow narrowing would otherwise see only the initial value.
  const currentReconcileMetricsStatus = (): 'ok' | 'unavailable' => reconcileMetricsStatus;
  const finalReconcileMetricsStatus = currentReconcileMetricsStatus();
  const finalReconcileMetrics = finalReconcileMetricsStatus === 'ok' ? reconcileMetrics : null;
  const payload = {
    kind: candidate === null ? 'container-terminal-fold' : 'container-terminal-fold-candidate',
    runId: context.runId,
    generatedAt: new Date().toISOString(),
    fixture,
    releasedArtifact: candidate === null,
    candidate:
      candidate === null
        ? null
        : {
            version: candidate.version,
            imageId: candidate.imageId,
            releasedArtifact: false,
            platformDigest: null,
            paidEligible: false,
          },
    platformVersion: state.platformVersion,
    platformImage: state.platformImage,
    platformImageId: state.platformImageId,
    platformDigest: state.platformDigest,
    productImage: state.productImage,
    productImageId: state.productImageId,
    // Finalized binding schema: the paid guards validate this nested provenance
    // against the deterministic gate's ACTUAL running artifact.
    provenance: {
      platform: {
        version: state.platformVersion,
        image: state.platformImage,
        imageId: state.platformImageId,
        digest: state.platformDigest,
      },
      product: {
        image: state.productImage,
        imageId: state.productImageId,
      },
    },
    terminalFold: evidence,
    checks,
    room:
      state.room === null
        ? null
        : { id: state.room.id, status: state.room.status, tableId: state.room.pokerTableId },
    platform429: { before: state.platform429Before, after: state.platform429After },
    browser:
      state.browser === null
        ? null
        : { code: state.browser.code, failures: state.browser.failures, phases: state.browser.phases },
    scripted: {
      tableId: trigger.tableId,
      agentRequests: trigger.agentRequests,
      stallHandId: trigger.stallHandId,
      stallTurnId: trigger.stallTurnId,
      stalledAttempts: state.stalledRequests,
    },
    // Already card-sanitized and re-scanned; receipt/request/observation only.
    foldCapture: state.capture,
    durableFold: state.durableFold,
    hookDiagnostics: state.hookDiagnostics,
    diagnostics: state.finalDiagnostics,
    replay: state.replayAnalysis,
    evidence:
      state.evidence === null
        ? null
        : {
            roomStatus: state.evidence.room.status,
            decisions: state.evidence.decisions.length,
            attempts: state.evidence.attempts.length,
            committed: state.evidence.decisions.filter((decision) => decision.status === 'COMMITTED').length,
          },
    winnersNonEmpty,
    secretScan,
    reconcileMetrics: finalReconcileMetrics,
    reconcileMetricsStatus: finalReconcileMetricsStatus,
    retainedTopology: state.retainTopology
      ? {
          runtimeDir: state.topology?.runtimeDir ?? null,
          platformUrl: state.topology?.platformUrl ?? null,
          postgres: state.topology?.postgresContainer ?? null,
          redis: state.topology?.redisContainer ?? null,
        }
      : null,
    diagnosticsCompleteness:
      state.finalDiagnostics === null ? null : terminalDiagnosticCompleteness(state.finalDiagnostics),
    teardownErrors: state.teardownErrors,
    failure: state.failure,
    exitCode: evidence.status === 'PASS' ? 0 : 1,
  };
  const summaryPath = join(context.artifactDir, TERMINAL_FOLD_SUMMARY_FILE);
  try {
    writeFileSync(summaryPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  } catch (error) {
    console.error(`could not write terminal-fold summary ${summaryPath}: ${errorText(error)}`);
  }
  context.log(
    `terminal fold ${evidence.status}${candidate === null ? '' : ' (candidate, not paid-eligible)'}: requestId=${evidence.requestId ?? '-'} hand=${evidence.handId ?? '-'} winners=${winnersNonEmpty} handCompleted=${evidence.handCompleted} archiveCompleted=${evidence.archiveCompleted} directorProgressed=${evidence.directorProgressed} continuation=${evidence.continuation ?? 'none'} roomTerminal=${evidence.roomTerminal} platform429=${String(state.platform429After)} secretScan=${secretScan}`
  );
  context.log(`terminal-fold summary: ${summaryPath}`);
  const exitCode = evidence.status === 'PASS' ? 0 : 1;
  if (exitCode !== 0) {
    console.error(`container terminal fold FAILED: ${state.failure ?? 'checks failed'}`);
  }
  return { exitCode, summaryPath, summary: payload };
}

/** CLI wrapper: default released-official guard, no candidate pointer. */
async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  try {
    const fixture = requireStagingFixture();
    if (args.check) {
      console.log(
        [
          'guards PASS: fixture configured',
          `  fixture: ${fixture}`,
          '  provider: deterministic loopback only (no paid provider is ever used)',
          '  platform: released-official immutable artifact guard (candidate is programmatic-only)',
          `  summary: ${TERMINAL_FOLD_SUMMARY_FILE}`,
        ].join('\n')
      );
      return 0;
    }
  } catch (error) {
    console.error(`BLOCKED: ${errorText(error)}`);
    return 2;
  }
  const result = await runTerminalFold();
  return result.exitCode;
}

/**
 * Only execute when this file is the process entrypoint: importing the pure
 * classifier from the focused Vitest regression must never start any topology.
 */
function invokedAsEntrypoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedAsEntrypoint()) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
