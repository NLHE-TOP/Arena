/**
 * Deterministic competition-backed tournament blind-boundary acceptance over
 * the published PokerTools 2.0.0 SDK only (`@pokertools/sdk` / `@pokertools/types`).
 *
 * Uses the same production path NLHE uses: a NONFINANCIAL competition with two
 * real WALLET entrants created/started/settled through the public
 * `CompetitionClient`, whose backing single-table tournament carries the
 * platform default blind structure. No legacy `/tournaments` route is touched:
 * no self-registration, no `advanceTournamentBlinds`, no manual `DEAL`.
 *
 * Scenario (fresh disposable staging topology):
 * - two real SIWE wallets log in; the organizer wallet is promoted through the
 *   documented operator bootstrap (ADMIN role) so orchestration is authorized;
 * - `CompetitionClient.createCompetition` provisions the roster (server-assigned
 *   seats, NONFINANCIAL = zero entry, zero prize, no chip ledger movement) and
 *   `start` seats both entrants and commits the legitimate initial DEAL;
 * - deterministic canonical table actions (fold-first before the boundary,
 *   shove/call in a hand dealt after it) keep hands finishing until the real
 *   tournament-blinds worker crosses the first configured interval (the
 *   external fixture sets a disposable short interval); every following hand is
 *   auto-dealt by the platform's own next-hand outbox — the harness never
 *   submits DEAL;
 * - after the last accepted action the platform reconciles the backing
 *   tournament through the public action route, `settlementReady` turns true,
 *   and the harness settles through `CompetitionClient.settle` to FINISHED.
 *
 * Asserted evidence (public authority only):
 * - table replay chain valid; multiple sequential handIds with exactly one
 *   HAND_STARTED and one HAND_COMPLETED each; no duplicate accepted-action
 *   request ids and no ACTION_APPLIED DEAL;
 * - the public table state exposes the blind structure; the observed blind
 *   level advanced with small/big blinds matching the next structure level, at
 *   least `minimumAdvanceDelayMs` after the tournament started, with hands
 *   completed before and after the boundary;
 * - `settlementReady` before settlement and competition FINISHED after it with
 *   authoritative placements;
 * - the platform's own `/metrics` 429 counter delta is exactly zero (absolute
 *   counter still zero) and no legacy `/tournaments*` HTTP request was made.
 *
 * No provider is contacted and no poker rule is changed: every submitted
 * actionId is echoed from the authoritative observation legal menu.
 */
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CompetitionClient, type PokerClient } from '@pokertools/sdk';
import type {
  BlindLevel,
  Competition,
  LegalAction,
  PublicWireState,
  ReplayFrame,
  ReplayFrameEvent,
  SeatObservation,
} from '@pokertools/types';
import { ensureOperator } from '../infra/admin.js';
import type { RunContext } from '../infra/context.js';
import { waitFor } from '../infra/gameplay.js';
import {
  platform429DeltaByRoute,
  platformHttpDeltaByCategory,
  readPlatformHttpCountersWithRetry,
  type PlatformHttpCounterSample,
  type PlatformRoute429,
} from '../infra/request-accounting.js';
import type { StagingTopology } from '../infra/staging.js';
import { ephemeralWallet, loginWallet, type WalletSession } from '../infra/wallet.js';

/** Fold-first keeps each pre-boundary hand to one deterministic action. */
export const POLL_INTERVAL_MS = 2_000;
export const BOUNDARY_TIMEOUT_MS = 90_000;
export const SCENARIO_TIMEOUT_MS = 300_000;
export const SETTLEMENT_READY_TIMEOUT_MS = 30_000;
export const MIN_COMPLETED_HANDS = 2;
/** The fixture's disposable interval is 15s; a real worker advance is >= 10s. */
export const MIN_BLIND_ADVANCE_DELAY_MS = 10_000;
const MAX_RACE_ERRORS = 30;

export type BlindBoundaryPhase = 'pre-boundary' | 'post-boundary';

export interface TournamentReplayAnalysis {
  handStarts: Array<{ handId: string; handNumber: number; occurredAt: number }>;
  handCompletions: Array<{ handId: string; occurredAt: number }>;
  blindAdvances: Array<{ handId: string | null; occurredAt: number }>;
  /** ACTION_APPLIED DEAL events: a manual DEAL would appear here. */
  manualDealActions: string[];
  requestIds: string[];
  duplicateHandStarts: string[];
  duplicateHandCompletions: string[];
  duplicateRequestIds: string[];
}

function payloadString(event: ReplayFrameEvent, key: string): string | null {
  const value = event.payload[key];
  return typeof value === 'string' ? value : null;
}

function payloadNumber(event: ReplayFrameEvent, key: string): number | null {
  const value = event.payload[key];
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function duplicates(values: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].filter(([, count]) => count > 1).map(([value]) => value);
}

/**
 * Pure replay projection: hand identities in event order, blind-advance
 * events, accepted-action request ids and every duplicate class the scenario
 * must reject. Malformed platform events throw instead of being silently
 * skipped (the strict wire contract guarantees the payload keys).
 */
export function analyzeTournamentReplay(events: readonly ReplayFrameEvent[]): TournamentReplayAnalysis {
  const handStarts: TournamentReplayAnalysis['handStarts'] = [];
  const handCompletions: TournamentReplayAnalysis['handCompletions'] = [];
  const blindAdvances: TournamentReplayAnalysis['blindAdvances'] = [];
  const manualDealActions: string[] = [];
  const requestIds: string[] = [];

  for (const event of events) {
    if (event.type === 'HAND_STARTED') {
      const handId = payloadString(event, 'handId');
      const handNumber = payloadNumber(event, 'handNumber');
      if (handId === null || handId.length === 0 || handNumber === null) {
        throw new Error(`HAND_STARTED event ${event.eventSeq} is missing handId/handNumber`);
      }
      handStarts.push({ handId, handNumber, occurredAt: event.occurredAt });
      continue;
    }
    if (event.type === 'HAND_COMPLETED') {
      const handId = payloadString(event, 'handId');
      if (handId === null || handId.length === 0) {
        throw new Error(`HAND_COMPLETED event ${event.eventSeq} is missing handId`);
      }
      handCompletions.push({ handId, occurredAt: event.occurredAt });
      continue;
    }
    if (event.type === 'ACTION_APPLIED') {
      const action = payloadString(event, 'action');
      if (action === 'NEXT_BLIND_LEVEL') {
        blindAdvances.push({ handId: payloadString(event, 'handId'), occurredAt: event.occurredAt });
      } else if (action === 'DEAL') {
        manualDealActions.push(event.eventId);
      }
      if (typeof event.requestId === 'string' && event.requestId.length > 0) {
        requestIds.push(event.requestId);
      }
    }
  }

  return {
    handStarts,
    handCompletions,
    blindAdvances,
    manualDealActions,
    requestIds,
    duplicateHandStarts: duplicates(handStarts.map((hand) => hand.handId)),
    duplicateHandCompletions: duplicates(handCompletions.map((hand) => hand.handId)),
    duplicateRequestIds: duplicates(requestIds),
  };
}

export interface BlindBoundaryEvidenceInput {
  replay: ReplayFrame;
  analysis: TournamentReplayAnalysis;
  /** Blind structure exactly as exposed by the public table state. */
  structure: readonly BlindLevel[];
  initial: { blindLevel: number; smallBlind: number; bigBlind: number };
  observed: { blindLevel: number; smallBlind: number; bigBlind: number };
  startedAtMs: number;
  minimumHands: number;
  minimumAdvanceDelayMs: number;
}

/**
 * Strict, pure acceptance checks over the replay projection and the observed
 * public table state. Every failure names the exact invariant so a red run is
 * actionable without reading the artifacts first.
 */
export function assertTournamentBlindBoundaryEvidence(input: BlindBoundaryEvidenceInput): void {
  const { replay, analysis, structure, initial, observed } = input;
  if (!replay.chainValid) throw new Error('tournament replay hash chain is not valid');
  if (analysis.manualDealActions.length > 0) {
    throw new Error(`manual DEAL action event(s) observed: ${analysis.manualDealActions.join(',')}`);
  }
  if (analysis.duplicateHandStarts.length > 0) {
    throw new Error(`duplicate HAND_STARTED (DEAL) for handId(s): ${analysis.duplicateHandStarts.join(',')}`);
  }
  if (analysis.duplicateHandCompletions.length > 0) {
    throw new Error(`duplicate HAND_COMPLETED for handId(s): ${analysis.duplicateHandCompletions.join(',')}`);
  }
  if (analysis.duplicateRequestIds.length > 0) {
    throw new Error(`duplicate accepted-action requestId(s): ${analysis.duplicateRequestIds.join(',')}`);
  }

  if (structure.length < 2) {
    throw new Error(`public blind structure has ${structure.length} level(s); expected at least 2`);
  }
  for (let index = 0; index < structure.length; index += 1) {
    const level = structure[index]!;
    if (level.bigBlind <= level.smallBlind) {
      throw new Error(`blind structure level ${index} has big blind ${level.bigBlind} <= small blind ${level.smallBlind}`);
    }
    if (index > 0) {
      const previous = structure[index - 1]!;
      if (level.smallBlind <= previous.smallBlind || level.bigBlind <= previous.bigBlind) {
        throw new Error(`blind structure is not strictly increasing at level ${index}`);
      }
    }
  }
  if (initial.blindLevel !== 0) {
    throw new Error(`initial blind level is ${initial.blindLevel}, expected 0`);
  }
  const firstLevel = structure[0]!;
  if (initial.smallBlind !== firstLevel.smallBlind || initial.bigBlind !== firstLevel.bigBlind) {
    throw new Error(
      `initial blinds ${initial.smallBlind}/${initial.bigBlind} do not match structure level 0 ` +
        `(${firstLevel.smallBlind}/${firstLevel.bigBlind})`
    );
  }

  if (analysis.handStarts.length < input.minimumHands) {
    throw new Error(`only ${analysis.handStarts.length} hand(s) started; expected at least ${input.minimumHands}`);
  }
  const handNumbers = analysis.handStarts.map((hand) => hand.handNumber).sort((left, right) => left - right);
  for (let index = 0; index < handNumbers.length; index += 1) {
    if (handNumbers[index] !== index + 1) {
      throw new Error(`hand numbers are not sequential from 1: [${handNumbers.join(',')}]`);
    }
  }
  const completedHandIds = new Set(analysis.handCompletions.map((hand) => hand.handId));
  for (const hand of analysis.handStarts) {
    if (!completedHandIds.has(hand.handId)) {
      throw new Error(`hand ${hand.handId} started but never completed`);
    }
  }
  if (analysis.handCompletions.length !== analysis.handStarts.length) {
    throw new Error(
      `hand completion count ${analysis.handCompletions.length} != start count ${analysis.handStarts.length}`
    );
  }

  if (observed.blindLevel <= initial.blindLevel) {
    throw new Error(
      `blind level did not advance: observed ${observed.blindLevel} <= initial ${initial.blindLevel}`
    );
  }
  if (observed.blindLevel >= structure.length) {
    throw new Error(`observed blind level ${observed.blindLevel} is outside the public structure`);
  }
  const level = structure[observed.blindLevel]!;
  if (level.smallBlind !== observed.smallBlind || level.bigBlind !== observed.bigBlind) {
    throw new Error(
      `observed blinds ${observed.smallBlind}/${observed.bigBlind} do not match structure level ` +
        `${observed.blindLevel} (${level.smallBlind}/${level.bigBlind})`
    );
  }

  const expectedAdvances = observed.blindLevel - initial.blindLevel;
  if (analysis.blindAdvances.length < expectedAdvances) {
    throw new Error(
      `observed ${expectedAdvances} blind level(s) of progress but only ${analysis.blindAdvances.length} NEXT_BLIND_LEVEL event(s)`
    );
  }
  const firstAdvance = analysis.blindAdvances[0];
  if (firstAdvance === undefined) throw new Error('no NEXT_BLIND_LEVEL event was recorded');
  const advanceDelayMs = firstAdvance.occurredAt - input.startedAtMs;
  if (advanceDelayMs < input.minimumAdvanceDelayMs) {
    throw new Error(
      `blind boundary occurred ${advanceDelayMs}ms after start; expected at least ${input.minimumAdvanceDelayMs}ms ` +
        '(a real worker interval, never a manual advance)'
    );
  }
  for (let index = 1; index < analysis.blindAdvances.length; index += 1) {
    if (analysis.blindAdvances[index]!.occurredAt <= analysis.blindAdvances[index - 1]!.occurredAt) {
      throw new Error('NEXT_BLIND_LEVEL events are not strictly ordered in time');
    }
  }

  const completionsBeforeBoundary = analysis.handCompletions.filter(
    (hand) => hand.occurredAt <= firstAdvance.occurredAt
  ).length;
  const startsAfterBoundary = analysis.handStarts.filter(
    (hand) => hand.occurredAt > firstAdvance.occurredAt
  ).length;
  if (completionsBeforeBoundary < 1 || startsAfterBoundary < 1) {
    throw new Error(
      `blind boundary did not cross during hands: ${completionsBeforeBoundary} completion(s) before, ` +
        `${startsAfterBoundary} start(s) after`
    );
  }
}

/**
 * Deterministic canonical action policy. Before the boundary each hand ends
 * with a single fold whenever folding is legal (heads-up small blind), which
 * keeps the tournament alive across the real interval with minimal request
 * pressure. After the boundary the policy shoves (max BET/RAISE) and calls
 * all-in so one stack empties and the competition can settle.
 */
export function chooseBlindBoundaryAction(
  observation: SeatObservation,
  phase: BlindBoundaryPhase
): { action: LegalAction; amount?: number } {
  const actions = observation.legalActions;
  const find = (family: LegalAction['family']): LegalAction | undefined =>
    actions.find((candidate) => candidate.family === family);

  if (phase === 'pre-boundary') {
    const fold = find('FOLD');
    if (fold) return { action: fold };
    const check = find('CHECK');
    if (check) return { action: check };
    const call = find('CALL');
    if (call) return { action: call };
    throw new Error('pre-boundary observation has no FOLD/CHECK/CALL legal action');
  }

  const raise = find('RAISE');
  if (raise) return { action: raise, amount: raise.maxAmount ?? raise.amount ?? raise.minAmount };
  const bet = find('BET');
  if (bet) return { action: bet, amount: bet.maxAmount ?? bet.amount ?? bet.minAmount };
  const call = find('CALL');
  if (call) return { action: call };
  const check = find('CHECK');
  if (check) return { action: check };
  const fold = find('FOLD');
  if (fold) return { action: fold };
  throw new Error('post-boundary observation has no RAISE/BET/CALL/CHECK/FOLD legal action');
}

/** Documented race outcomes only; 429/auth/server failures stay visible. */
function isIgnorableTournamentRace(error: unknown): boolean {
  const record = error as { code?: unknown; statusCode?: unknown; message?: unknown };
  const status = typeof record?.statusCode === 'number' ? record.statusCode : null;
  if (status === 429) return false;
  if (status !== null && (status === 401 || status === 403 || status >= 500)) return false;
  const code = typeof record?.code === 'string' ? record.code : '';
  const message = typeof record?.message === 'string' ? record.message : '';
  if (code === 'TIMEOUT' || code === 'NOT_MODIFIED') return true;
  return /(stale|superseded|conflict|turn|version|illegal|obsolete|expired|not open for play|not actionable|table is closed)/i.test(
    `${code} ${message}`
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readTableState(client: PokerClient, tableId: string): Promise<PublicWireState> {
  const state = await client.getTableState(tableId);
  if (state === null) {
    throw new Error('table state returned null without a `since` cursor');
  }
  return state;
}

export interface TournamentBlindBoundaryOptions {
  context: RunContext;
  topology: StagingTopology;
}

export interface TournamentBlindBoundaryResult {
  runId: string;
  competitionId: string;
  tableId: string;
  mode: string;
  entrants: Array<{ principalId: string; kind: string; seat: number; entryState: string }>;
  structure: BlindLevel[];
  initial: { blindLevel: number; smallBlind: number; bigBlind: number; handId: string; handNumber: number };
  observed: { blindLevel: number; smallBlind: number; bigBlind: number };
  hands: { started: number; completed: number; handNumbers: number[]; handIds: string[] };
  boundary: { advances: number; firstAdvanceDelayMs: number; duringHands: boolean };
  actions: { submitted: number; requestIds: number; duplicateRequestIds: string[] };
  replay: { chainValid: boolean; events: number; tournamentEventTypes: string[] };
  termination: {
    status: string;
    settlementReady: boolean;
    winnerPrincipalId: string | null;
    winnerKind: string | null;
    prizeStatus: string | null;
    placements: Array<{ principalId: string; placement: number }>;
  };
  platform429: {
    before: number;
    after: number;
    delta: number;
    byRoute: PlatformRoute429[];
    metricsReadRetries: number;
  };
  legacyTournamentHttpRequests: number;
  startedAt: number;
  finishedAt: number;
  elapsedMs: number;
}

/**
 * Run the whole scenario against a fresh topology. The caller owns topology
 * lifecycle and artifact capture; this function never stops the platform.
 */
export async function runTournamentBlindBoundary(
  options: TournamentBlindBoundaryOptions
): Promise<TournamentBlindBoundaryResult> {
  const { context, topology } = options;
  const supervisor = topology.supervisor;
  await supervisor.assertAllAlive('tournament blind-boundary start');
  await topology.assertHealthy('tournament blind-boundary start', { requireCustodyHeartbeat: true });

  // Authoritative 429 baseline BEFORE any harness traffic; a fresh platform
  // must not have recorded any 429 at all.
  let metricsReadRetries = 0;
  const readCounters = (label: string): Promise<PlatformHttpCounterSample> =>
    readPlatformHttpCountersWithRetry(topology.platformMetrics, {
      log: (message) => context.log(`${label}: ${message}`),
      onRetry: () => {
        metricsReadRetries += 1;
      },
    });
  const countersBefore = await readCounters('metrics before');
  if (countersBefore.total429 !== 0) {
    throw new Error(`fresh platform already recorded ${countersBefore.total429} HTTP 429 response(s)`);
  }

  const operator = await loginWallet(topology.platformUrl, ephemeralWallet());
  const promotion = await ensureOperator(topology.adminTarget, operator);
  if (!promotion.promoted) throw new Error('competition organizer wallet was not promoted to ADMIN');

  const players: WalletSession[] = [];
  for (let index = 0; index < 2; index += 1) {
    players.push(await loginWallet(topology.platformUrl, ephemeralWallet()));
  }
  context.log(`competition organizer (ADMIN) + ${players.length} real wallet entrants ready`);

  // The production competition path: NONFINANCIAL = zero entry, zero prize,
  // no chip ledger movement; seats are server-assigned.
  const organizer = new CompetitionClient({
    baseUrl: topology.platformUrl,
    token: operator.token,
    timeout: 30_000,
  });
  const created = await organizer.createCompetition({
    name: `blind-boundary-${context.runId}`,
    mode: 'NONFINANCIAL',
    entrants: players.map((player) => ({ principalId: player.userId, kind: 'WALLET' as const })),
    idempotencyKey: `tournament-blind-boundary:create:${context.runId}`,
  });
  if (created.replayed) throw new Error('fresh competition creation unexpectedly replayed');
  const competition = created.competition;
  if (competition.mode !== 'NONFINANCIAL' || competition.status !== 'REGISTRATION') {
    throw new Error(`competition is ${competition.mode}/${competition.status}, expected NONFINANCIAL/REGISTRATION`);
  }
  if (competition.entrants.length !== players.length) {
    throw new Error(`competition has ${competition.entrants.length} entrants, expected ${players.length}`);
  }
  context.log(`competition ${competition.id} provisioned on table ${competition.tableId}`);

  const startedAt = Date.now();
  const started = await organizer.start(competition.id);
  if (started.competitionId !== competition.id || started.tableId !== competition.tableId) {
    throw new Error('competition start did not confirm the same competition/table');
  }
  if (started.seats.length !== players.length) {
    throw new Error(`competition start assigned ${started.seats.length} seats, expected ${players.length}`);
  }

  const reader = players[0]!;
  const initialState = await readTableState(reader.client, competition.tableId);
  const structure = initialState.config.blindStructure;
  if (structure === undefined || structure.length < 2) {
    throw new Error('public table state did not expose a usable blind structure');
  }
  if (
    initialState.blindLevel !== 0 ||
    initialState.smallBlind !== structure[0]!.smallBlind ||
    initialState.bigBlind !== structure[0]!.bigBlind
  ) {
    throw new Error(
      `initial table blinds ${initialState.smallBlind}/${initialState.bigBlind} level ${initialState.blindLevel} ` +
        'do not match the public structure'
    );
  }
  if (initialState.handNumber !== 1 || initialState.handId.length === 0) {
    throw new Error('competition start did not deal the legitimate initial hand');
  }
  context.log(
    `competition ${competition.id} RUNNING; initial hand ${initialState.handId} at ${initialState.smallBlind}/${initialState.bigBlind}`
  );

  let boundaryObservedAt: number | null = null;
  let boundaryObservedHandNumber: number | null = null;
  let actionsSubmitted = 0;
  let raceErrors = 0;
  let bustObserved = false;
  const deadline = startedAt + SCENARIO_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const state = await readTableState(reader.client, competition.tableId);

    if (state.blindLevel > initialState.blindLevel && boundaryObservedAt === null) {
      boundaryObservedAt = Date.now();
      boundaryObservedHandNumber = state.handNumber;
      context.log(
        `real blind boundary observed: level ${state.blindLevel} (${state.smallBlind}/${state.bigBlind}) ` +
          `after ${boundaryObservedAt - startedAt}ms (handNumber=${state.handNumber})`
      );
    }
    if (boundaryObservedAt === null && Date.now() - startedAt > BOUNDARY_TIMEOUT_MS) {
      throw new Error(
        `real blind boundary was not observed within ${BOUNDARY_TIMEOUT_MS}ms ` +
          `(handNumber=${state.handNumber} handId=${state.handId}); the fixture must expose a short interval`
      );
    }
    // An all-in player also carries stack 0 while the hand is still running,
    // and the platform reconciles a completed tournament hand by clearing the
    // busted seat; the terminal fact is a settled hand boundary with exactly
    // one live player left.
    const settledBoundary = state.actionTo === null && (state.winners?.length ?? 0) > 0;
    const livePlayers = state.players.filter((player) => player !== null && player.stack > 0).length;
    if (settledBoundary && livePlayers === 1) {
      bustObserved = true;
      context.log(`terminal hand ${state.handId} settled with a single live player; awaiting settlementReady`);
      break;
    }
    if (state.actionTo !== null) {
      const actor = state.players[state.actionTo];
      const player = actor ? players.find((candidate) => candidate.userId === actor.id) : undefined;
      if (!actor || !player) {
        throw new Error(`acting seat ${state.actionTo} does not map to a registered wallet`);
      }
      const observation = await player.client.getObservation(competition.tableId);
      if (observation.legalActions.length > 0) {
        // Terminal play only starts in a hand that was dealt AFTER the boundary
        // was observed, so at least one HAND_STARTED event necessarily follows
        // the NEXT_BLIND_LEVEL event even when the boundary lands mid-hand.
        const terminalPlay =
          boundaryObservedHandNumber !== null && state.handNumber > boundaryObservedHandNumber;
        const phase: BlindBoundaryPhase = terminalPlay ? 'post-boundary' : 'pre-boundary';
        const choice = chooseBlindBoundaryAction(observation, phase);
        try {
          await player.client.action(competition.tableId, {
            requestId: randomUUID(),
            turnId: observation.turnId,
            expectedVersion: observation.version,
            actionId: choice.action.actionId,
            ...(choice.amount !== undefined && choice.amount > 0 ? { amount: choice.amount } : {}),
          });
          actionsSubmitted += 1;
          raceErrors = 0;
        } catch (error) {
          if (!isIgnorableTournamentRace(error)) throw error;
          raceErrors += 1;
          if (raceErrors > MAX_RACE_ERRORS) {
            throw new Error(`more than ${MAX_RACE_ERRORS} consecutive documented action races`);
          }
        }
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }

  if (boundaryObservedAt === null) {
    throw new Error(`real blind boundary was not observed within ${SCENARIO_TIMEOUT_MS}ms`);
  }
  if (!bustObserved) {
    throw new Error(`competition did not reach a single live stack within ${SCENARIO_TIMEOUT_MS}ms`);
  }

  const finalState = await readTableState(reader.client, competition.tableId);
  const finalSettled = finalState.actionTo === null && (finalState.winners?.length ?? 0) > 0;
  const finalLivePlayers = finalState.players.filter((player) => player !== null && player.stack > 0).length;
  if (!finalSettled || finalLivePlayers !== 1) {
    throw new Error('no settled hand with exactly one live player observed immediately before settlement');
  }

  // Public terminal signal: the accepted action route reconciles the backing
  // tournament after the completed hand, so the competition turns
  // settlement-ready without any harness mutation.
  let ready: Competition;
  try {
    ready = await waitFor(
      'competition settlementReady',
      async () => {
        const current = await organizer.getCompetition(competition.id);
        return current.settlementReady ? current : null;
      },
      { timeoutMs: SETTLEMENT_READY_TIMEOUT_MS, intervalMs: 1_000 }
    );
  } catch (error) {
    const latest = await organizer.getCompetition(competition.id).catch(() => null);
    throw new Error(
      `competition did not report settlementReady within ${SETTLEMENT_READY_TIMEOUT_MS}ms ` +
        `(status=${latest?.status ?? 'unknown'} settlementReady=${latest?.settlementReady ?? 'unknown'}): ` +
        (error instanceof Error ? error.message : String(error))
    );
  }
  if (ready.status !== 'RUNNING') {
    throw new Error(`competition status is ${ready.status} before settlement, expected RUNNING`);
  }

  const settled = await organizer.settle(competition.id);
  if (settled.competitionId !== competition.id || settled.prizeStatus !== 'NOT_APPLICABLE') {
    throw new Error(`competition settle returned ${settled.prizeStatus}, expected NOT_APPLICABLE`);
  }
  if (!players.some((player) => player.userId === settled.winnerPrincipalId)) {
    throw new Error('settled winner is not one of the registered wallet entrants');
  }
  const winnerPlacement = settled.placements.find((placement) => placement.principalId === settled.winnerPrincipalId);
  if (!winnerPlacement || winnerPlacement.placement !== 1) {
    throw new Error('settled winner does not carry placement 1');
  }
  if (settled.placements.length !== players.length) {
    throw new Error(`settle returned ${settled.placements.length} placements, expected ${players.length}`);
  }
  const finished = await organizer.getCompetition(competition.id);
  if (finished.status !== 'FINISHED') {
    throw new Error(`competition status is ${finished.status}, not FINISHED`);
  }

  const replay = await reader.client.getReplay(competition.tableId, { fromEventSeq: 1 });
  const analysis = analyzeTournamentReplay(replay.events);
  assertTournamentBlindBoundaryEvidence({
    replay,
    analysis,
    structure,
    initial: {
      blindLevel: initialState.blindLevel,
      smallBlind: initialState.smallBlind,
      bigBlind: initialState.bigBlind,
    },
    observed: {
      blindLevel: finalState.blindLevel,
      smallBlind: finalState.smallBlind,
      bigBlind: finalState.bigBlind,
    },
    startedAtMs: startedAt,
    minimumHands: MIN_COMPLETED_HANDS,
    minimumAdvanceDelayMs: MIN_BLIND_ADVANCE_DELAY_MS,
  });
  if (analysis.requestIds.length !== actionsSubmitted) {
    throw new Error(
      `replay recorded ${analysis.requestIds.length} accepted action(s) but the harness submitted ${actionsSubmitted}`
    );
  }

  const tournamentEvents = replay.tournamentEvents ?? [];
  const tournamentEventTypes = tournamentEvents.map((event) => event.type);
  for (const required of ['TOURNAMENT_STARTED', 'TOURNAMENT_SETTLED'] as const) {
    if (!tournamentEventTypes.includes(required)) {
      throw new Error(`replay tournament events are missing ${required}`);
    }
  }
  const startEvent = tournamentEvents.find((event) => event.type === 'TOURNAMENT_STARTED');
  if (startEvent?.payload.competitionId !== competition.id) {
    throw new Error('TOURNAMENT_STARTED event is not bound to this competition');
  }

  const countersAfter = await readCounters('metrics after');
  const platform429Delta = countersAfter.total429 - countersBefore.total429;
  const platform429ByRoute = platform429DeltaByRoute(countersBefore, countersAfter);
  const httpDelta = platformHttpDeltaByCategory(countersBefore, countersAfter);
  const legacyTournamentHttpRequests = httpDelta.byRoute
    .filter((route) => route.route === '/tournaments' || route.route.startsWith('/tournaments/'))
    .reduce((total, route) => total + route.count, 0);
  if (countersAfter.total429 !== 0 || platform429Delta !== 0 || platform429ByRoute.length > 0) {
    throw new Error(
      `platform recorded ${platform429Delta} new HTTP 429 response(s) during the tournament window ` +
        `(before=${countersBefore.total429} after=${countersAfter.total429})`
    );
  }
  if (legacyTournamentHttpRequests > 0) {
    throw new Error(`harness made ${legacyTournamentHttpRequests} legacy /tournaments HTTP request(s)`);
  }

  await supervisor.assertAllAlive('tournament blind boundary complete');

  const firstAdvance = analysis.blindAdvances[0]!;
  const result: TournamentBlindBoundaryResult = {
    runId: context.runId,
    competitionId: competition.id,
    tableId: competition.tableId,
    mode: competition.mode,
    entrants: competition.entrants.map((entrant) => ({
      principalId: entrant.principalId,
      kind: entrant.kind,
      seat: entrant.seat,
      entryState: entrant.entryState,
    })),
    structure: structure.map((level) => ({ ...level })),
    initial: {
      blindLevel: initialState.blindLevel,
      smallBlind: initialState.smallBlind,
      bigBlind: initialState.bigBlind,
      handId: initialState.handId,
      handNumber: initialState.handNumber,
    },
    observed: {
      blindLevel: finalState.blindLevel,
      smallBlind: finalState.smallBlind,
      bigBlind: finalState.bigBlind,
    },
    hands: {
      started: analysis.handStarts.length,
      completed: analysis.handCompletions.length,
      handNumbers: analysis.handStarts.map((hand) => hand.handNumber),
      handIds: analysis.handStarts.map((hand) => hand.handId),
    },
    boundary: {
      advances: analysis.blindAdvances.length,
      firstAdvanceDelayMs: firstAdvance.occurredAt - startedAt,
      duringHands:
        analysis.handCompletions.filter((hand) => hand.occurredAt <= firstAdvance.occurredAt).length > 0 &&
        analysis.handStarts.filter((hand) => hand.occurredAt > firstAdvance.occurredAt).length > 0,
    },
    actions: {
      submitted: actionsSubmitted,
      requestIds: analysis.requestIds.length,
      duplicateRequestIds: analysis.duplicateRequestIds,
    },
    replay: { chainValid: replay.chainValid, events: replay.events.length, tournamentEventTypes },
    termination: {
      status: finished.status,
      settlementReady: ready.settlementReady,
      winnerPrincipalId: settled.winnerPrincipalId,
      winnerKind: settled.winnerKind,
      prizeStatus: settled.prizeStatus,
      placements: settled.placements.map((placement) => ({
        principalId: placement.principalId,
        placement: placement.placement,
      })),
    },
    platform429: {
      before: countersBefore.total429,
      after: countersAfter.total429,
      delta: platform429Delta,
      byRoute: platform429ByRoute,
      metricsReadRetries,
    },
    legacyTournamentHttpRequests,
    startedAt,
    finishedAt: Date.now(),
    elapsedMs: Date.now() - startedAt,
  };

  writeFileSync(
    join(context.artifactDir, 'tournament-blind-boundary.json'),
    `${topology.secretRegistry.redact(JSON.stringify(result, null, 2))}\n`,
    { mode: 0o600 }
  );
  context.log(
    `tournament blind boundary PASS: competition=${competition.id} hands=${result.hands.started} ` +
      `completed=${result.hands.completed} blindLevel ${result.initial.blindLevel}->${result.observed.blindLevel} ` +
      `(${result.observed.smallBlind}/${result.observed.bigBlind}) actions=${actionsSubmitted} ` +
      `winner=${result.termination.winnerPrincipalId ?? '-'} platform429Delta=${platform429Delta}`
  );
  return result;
}
