/**
 * One mandatory roster run against the product's own room orchestration.
 *
 * The product (not this harness) creates/starts the generic platform
 * competition and attaches the agent runtime; agents decide through the real
 * loopback provider. The harness only:
 * - authenticates human participants with real SIWE wallets and plays their
 *   seats through the public SDK (a human is a player, not an orchestrator);
 * - waits for the product-owned runtime to drive every agent seat;
 * - reads the product's persisted decisions/attempts read-only and inspects
 *   the exact recorded requests against the saved observation and chat source.
 */
import type { SeatObservation } from '@pokertools/types';
import type { TestEnvironment } from '../infra/environment.js';
import type { RunContext } from '../infra/context.js';
import type { FakeProviderHandle } from '../infra/fake-provider.js';
import type { WalletSession } from '../infra/wallet.js';
import { waitFor } from '../infra/gameplay.js';
import { readRoomEvidence, inspectRoomEvidence, type EvidenceInspection, type RoomEvidence } from './evidence.js';
import type { ProductClient, ProductRoomView } from './product-client.js';
import type { RosterSpec } from './roster.js';

export interface ProductRoomRunInput {
  spec: RosterSpec;
  context: RunContext;
  environment: TestEnvironment;
  product: ProductClient;
  /** Human wallet sessions (at least spec.humans). */
  humans: readonly WalletSession[];
  /** Provisioned agent ids for this roster (at least spec.agents). */
  agentIds: readonly string[];
  /** Durable agent principals for evidence ownership checks. */
  agentPrincipalIds: ReadonlySet<string>;
  fakeProvider: FakeProviderHandle;
  /** Product SQLite path (read-only evidence). */
  productDatabasePath: string;
  /** Paid ASSET terms; when present the room is CHALLENGE with the human payer. */
  challenge?: {
    assetId: string;
    entryAtomic: string;
    prizeAtomic: string;
  } | null;
  /** Hook after the room is ACTIVE and before completion waiting. */
  onActive?: (room: ProductRoomView) => Promise<void>;
  /**
   * Mixed-audit rooms: drive human seats passively (CHECK/CALL/FOLD only)
   * until the loopback provider has served this many requests for the table,
   * then switch to aggressive play. Keeps the bounded family/sizing intro real.
   */
  passiveHumanIntro?: { untilProviderRequests: number } | null;
  /** Hook invoked on every poll while the room is not yet terminal. */
  onTick?: (room: ProductRoomView) => Promise<void>;
  maxWaitMs?: number;
  /** Called when the room reaches a terminal state (for restart planning). */
  onTerminal?: (room: ProductRoomView, evidence: RoomEvidence) => Promise<void>;
}

export interface ProductRoomRunResult {
  room: ProductRoomView;
  evidence: RoomEvidence;
  inspection: EvidenceInspection;
  providerRequests: number;
  persistedAttempts: number;
  tableId: string;
}

/**
 * Play the human seats of a room through the public SDK with ordinary
 * aggressive play: an all-in BET/RAISE at the server-issued maximum when
 * offered, otherwise CALL/CHECK/FOLD. This completes human and mixed rooms in
 * a few hands without touching caps. Agents are never driven here.
 *
 * Only documented race outcomes are swallowed (stale/turn/version conflicts,
 * timeouts, and terminal platform rejections after the room ended); auth,
 * broken-SDK and unexpected errors are rethrown.
 */
function isIgnorableHumanRace(error: unknown, terminal: boolean): boolean {
  const record = error as { name?: unknown; code?: unknown; statusCode?: unknown; message?: unknown };
  const code = typeof record?.code === 'string' ? record.code : '';
  const message = typeof record?.message === 'string' ? record.message : '';
  const status = typeof record?.statusCode === 'number' ? record.statusCode : null;
  if (code === 'TIMEOUT' || code === 'NOT_MODIFIED') return true;
  if (/(stale|superseded|conflict|turn|version|illegal|obsolete|expired)/i.test(`${code} ${message}`)) return true;
  // The competition/table can stop being actionable the moment the room
  // settles; a human racing that boundary is a documented terminal race.
  if (/(not open for play|COMPETITION_NOT_ACTIONABLE|NOT_ACTIONABLE|table is closed|TABLE_CLOSED)/i.test(`${code} ${message}`)) {
    return true;
  }
  if (terminal && (status === 404 || status === 409)) return true;
  return false;
}

export async function driveHumanSeats(input: {
  humans: readonly WalletSession[];
  tableId: string;
  isTerminal: () => boolean;
  /** While true, play passively (CHECK/CALL/FOLD) to expose family variety. */
  isPassive?: () => boolean;
  onAction?: (observation: SeatObservation) => void;
}): Promise<void> {
  while (!input.isTerminal()) {
    let acted = false;
    for (const session of input.humans) {
      if (input.isTerminal()) return;
      try {
        const observation = await session.client.getObservation(input.tableId);
        if (observation.legalActions.length === 0) continue;
        const passive = input.isPassive?.() === true;
        const aggressive =
          passive
            ? undefined
            : (observation.legalActions.find((candidate) => candidate.family === 'RAISE' && candidate.maxAmount !== undefined) ??
              observation.legalActions.find((candidate) => candidate.family === 'BET' && candidate.maxAmount !== undefined));
        const action =
          aggressive ??
          observation.legalActions.find((candidate) => candidate.family === 'CHECK') ??
          observation.legalActions.find((candidate) => candidate.family === 'CALL') ??
          observation.legalActions.find((candidate) => candidate.family === 'FOLD') ??
          observation.legalActions[0]!;
        const amount =
          aggressive !== undefined
            ? (aggressive.maxAmount ?? aggressive.amount)
            : action.family === 'BET' || action.family === 'RAISE'
              ? (action.amount ?? action.minAmount)
              : action.amount;
        await session.client.action(input.tableId, {
          requestId: crypto.randomUUID(),
          turnId: observation.turnId,
          expectedVersion: observation.version,
          actionId: action.actionId,
          ...(amount !== undefined && amount > 0 ? { amount } : {}),
        });
        input.onAction?.(observation);
        acted = true;
      } catch (error) {
        if (isIgnorableHumanRace(error, input.isTerminal())) continue;
        throw error;
      }
    }
    if (!acted) await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export async function runProductRoom(input: ProductRoomRunInput): Promise<ProductRoomRunResult> {
  const { spec, context, product, fakeProvider } = input;
  const humans = input.humans.slice(0, spec.humans);
  const agentIds = input.agentIds.slice(0, spec.agents);
  if (humans.length !== spec.humans) throw new Error(`${spec.label}: not enough human wallets`);
  if (agentIds.length !== spec.agents) throw new Error(`${spec.label}: not enough agents`);

  const roomName = `accept-${spec.label}-${Date.now().toString(36)}`;

  let room: ProductRoomView;
  const challenge = input.challenge ?? null;
  if (humans.length > 0) {
    room = await product.createRoom(
      {
        name: roomName,
        mode: challenge ? 'CHALLENGE' : 'SPONSORED',
        humanCount: spec.humans,
        agentIds,
        ...(challenge
          ? {
              finance: {
                assetId: challenge.assetId,
                entryAtomic: challenge.entryAtomic,
                prizeAtomic: challenge.prizeAtomic,
                optIn: true,
              },
            }
          : {}),
      },
      { walletToken: humans[0]!.token }
    );
    for (const session of humans.slice(1)) {
      room = await product.joinRoom(room.id, session.token);
    }
  } else {
    room = await product.createRoom(
      { name: roomName, mode: 'SPONSORED', humanCount: 0, agentIds },
      { admin: true }
    );
  }

  const startActor =
    humans.length > 0 ? { walletToken: humans[0]!.token } : { admin: true as const };
  room = await product.startRoom(room.id, startActor);
  if (challenge && room.status === 'PROVISIONING' && room.pokerCompetitionId !== null && humans.length > 0) {
    // Paid start is intentionally pending in the product: the payer must opt in
    // directly through the public CompetitionClient (the product API never
    // forwards paid entry). Then start resumes provisioning to ACTIVE.
    const { CompetitionClient } = await import('@pokertools/sdk');
    const payer = new CompetitionClient({
      baseUrl: input.environment.platform.baseUrl,
      token: humans[0]!.token,
      timeout: 30_000,
    });
    await payer.optIn(room.pokerCompetitionId);
    room = await product.startRoom(room.id, startActor);
  }
  context.log(`room ${spec.label}: ${room.id} status=${room.status} table=${room.pokerTableId ?? 'pending'}`);

  let terminal = room.status === 'COMPLETE' || room.status === 'FAILED';
  let humanDriver: Promise<void> = Promise.resolve();
  let humanError: unknown = null;
  let tableId: string | null = room.pokerTableId;

  if (room.status !== 'COMPLETE' && room.status !== 'FAILED') {
    const active = await waitFor(
      `${spec.label} room ACTIVE`,
      async () => {
        const current = await product.getRoom(room.id);
        return current.status === 'ACTIVE' ? current : null;
      },
      // The product rate-limits at 120 requests/minute; poll well under it.
      { timeoutMs: input.maxWaitMs ?? 120_000, intervalMs: 1500 }
    );
    room = active;
    context.log(`room ${spec.label}: ACTIVE table=${room.pokerTableId}`);
    await input.onActive?.(room);

    tableId = room.pokerTableId;
    if (tableId === null) throw new Error(`${spec.label}: ACTIVE room has no table id`);
    humanDriver = driveHumanSeats({
      humans,
      tableId,
      isTerminal: () => terminal,
      isPassive: () => {
        const intro = input.passiveHumanIntro ?? null;
        return intro !== null && fakeProvider.requestCountForTable(tableId) < intro.untilProviderRequests;
      },
    }).catch((error: unknown) => {
      // Capture immediately so an unexpected failure can never become an
      // unhandled rejection; rethrown after the room is terminal (only
      // documented stale/timeout races are swallowed inside).
      humanError = error;
    });

    room = await waitFor(
      `${spec.label} room terminal`,
      async () => {
        const current = await product.getRoom(room.id);
        await input.onTick?.(current);
        if (current.status === 'COMPLETE' || current.status === 'FAILED') {
          terminal = true;
          return current;
        }
        return null;
      },
      // The product rate-limits at 120 requests/minute; with up to nine
      // concurrent rooms a 5s poll stays well under it.
      { timeoutMs: input.maxWaitMs ?? 900_000, intervalMs: 5000 }
    ).catch(async (error: unknown) => {
      // Terminal timeout diagnostics: durable decision statuses plus the last
      // product read error make a stalled room actionable.
      const evidence = readRoomEvidence(input.productDatabasePath, room.id);
      const statuses = evidence.decisions.reduce<Record<string, number>>((accumulator, decision) => {
        accumulator[decision.status] = (accumulator[decision.status] ?? 0) + 1;
        return accumulator;
      }, {});
      const lastRoom = await product.getRoom(room.id).catch((readError: unknown) => ({
        status: `read-failed: ${readError instanceof Error ? readError.message : String(readError)}`,
      }));
      throw new Error(
        `${spec.label}: room terminal timeout (status=${String((lastRoom as { status?: unknown }).status)}; decisions=${JSON.stringify(
          statuses
        )}; attempts=${evidence.attempts.length}): ${error instanceof Error ? error.message : String(error)}`
      );
    });
  }
  terminal = true;
  await humanDriver.catch(() => undefined);
  if (humanError !== null) {
    throw humanError instanceof Error ? humanError : new Error(String(humanError));
  }

  // Grace period: an in-flight attempt recorded at the terminal boundary is
  // recovered (recorded exactly once) before evidence inspection.
  let evidence = readRoomEvidence(input.productDatabasePath, room.id);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (!evidence.attempts.some((row) => row.status === 'PENDING')) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    evidence = readRoomEvidence(input.productDatabasePath, room.id);
  }
  await input.onTerminal?.(room, evidence);
  const inspection = await inspectRoomEvidence(evidence, { agentPrincipalIds: input.agentPrincipalIds });
  // Total per-table provider exchanges: every persisted attempt must map 1:1 to
  // a loopback HTTP exchange, independent of when the harness first observed
  // the table (the runtime can act before the start response returns).
  const providerRequests = tableId === null ? 0 : fakeProvider.requestCountForTable(tableId);

  if (room.status === 'FAILED') {
    throw new Error(`${spec.label}: room failed: ${room.failureReason ?? 'unknown reason'}`);
  }
  if (room.status !== 'COMPLETE') {
    throw new Error(`${spec.label}: room did not complete (status ${room.status})`);
  }
  const persistedAttempts = evidence.attempts.filter((attempt) => attempt.recorded_at !== null).length;
  if (providerRequests !== persistedAttempts) {
    throw new Error(
      `${spec.label}: loopback provider saw ${providerRequests} request(s) but ${persistedAttempts} attempt(s) were recorded`
    );
  }
  if (spec.agents > 0 && evidence.decisions.length === 0) {
    throw new Error(`${spec.label}: no durable decisions were recorded`);
  }
  if (spec.agents === 0 && (evidence.decisions.length !== 0 || providerRequests !== 0)) {
    throw new Error(
      `${spec.label}: human-only room recorded ${evidence.decisions.length} decisions and ${providerRequests} provider requests`
    );
  }
  if (inspection.violations.length > 0) {
    const first = inspection.violations[0]!;
    throw new Error(
      `${spec.label}: evidence violations (${inspection.violations.length}); first: ${first.decisionId}#${first.attemptNo ?? '-'}: ${first.detail}`
    );
  }
  return {
    room,
    evidence,
    inspection,
    providerRequests,
    persistedAttempts,
    tableId: room.pokerTableId!,
  };
}
