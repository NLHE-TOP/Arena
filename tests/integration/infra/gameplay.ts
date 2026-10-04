/**
 * Gameplay helpers over the public SDK only.
 *
 * These helpers create real tables, seat real wallet/SERVICE principals with
 * canonically granted chips, and submit server-issued legal actions. They never
 * compute poker legality client-side: every actionId is echoed from the
 * authoritative `SeatObservation`.
 */
import { randomUUID } from 'node:crypto';
import type { PokerClient } from '@pokertools/sdk';
import type { CanonicalActionResult, LegalAction, LegalActionFamily, SeatObservation } from '@pokertools/types';

export const FAMILY_PREFERENCE: LegalActionFamily[] = ['CHECK', 'CALL', 'BET', 'RAISE', 'FOLD', 'TIME_BANK'];

export async function waitFor<T>(
  label: string,
  fn: () => Promise<T | null | undefined | false>,
  options: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    `timed out waiting for ${label}${lastError ? `: ${lastError instanceof Error ? lastError.message : String(lastError)}` : ''}`
  );
}

export interface SeatRequest {
  seat: number;
  amount: number;
  idempotencyKey?: string;
}

export interface CreateTableOptions {
  name: string;
  maxPlayers?: number;
  smallBlind?: number;
  bigBlind?: number;
  minBuyIn?: number;
  maxBuyIn?: number;
  actionTimeoutSeconds?: number;
  mode?: 'CASH' | 'TOURNAMENT';
}

export async function createCashTable(client: PokerClient, options: CreateTableOptions): Promise<string> {
  return client.createTable({
    name: options.name,
    mode: options.mode ?? 'CASH',
    smallBlind: options.smallBlind ?? 1,
    bigBlind: options.bigBlind ?? 2,
    maxPlayers: options.maxPlayers ?? 2,
    ...(options.minBuyIn !== undefined ? { minBuyIn: options.minBuyIn } : {}),
    ...(options.maxBuyIn !== undefined ? { maxBuyIn: options.maxBuyIn } : {}),
    ...(options.actionTimeoutSeconds !== undefined ? { actionTimeoutSeconds: options.actionTimeoutSeconds } : {}),
  });
}

export async function seatPlayer(client: PokerClient, tableId: string, request: SeatRequest): Promise<void> {
  await client.buyIn(tableId, {
    amount: request.amount,
    seat: request.seat,
    idempotencyKey: request.idempotencyKey ?? randomUUID(),
  });
}

export interface ObservationWaitOptions {
  timeoutMs?: number;
  requireLegal?: boolean;
}

export async function waitForObservation(
  client: PokerClient,
  tableId: string,
  predicate: (observation: SeatObservation) => boolean = () => true,
  options: ObservationWaitOptions = {}
): Promise<SeatObservation> {
  const requireLegal = options.requireLegal ?? false;
  return waitFor(
    `observation for ${tableId}${requireLegal ? ' with legal actions' : ''}`,
    async () => {
      const observation = await client.getObservation(tableId);
      if (requireLegal && observation.legalActions.length === 0) return null;
      return predicate(observation) ? observation : null;
    },
    { timeoutMs: options.timeoutMs ?? 30_000 }
  );
}

export interface Participant {
  id: string;
  client: PokerClient;
}

export interface ActingTurn {
  participant: Participant;
  observation: SeatObservation;
}

/** Poll every participant until one owns the authoritative acting turn. */
export async function waitForActingParticipant(
  participants: Participant[],
  tableId: string,
  options: { timeoutMs?: number } = {}
): Promise<ActingTurn> {
  return waitFor(
    `acting participant on ${tableId}`,
    async () => {
      for (const participant of participants) {
        try {
          const observation = await participant.client.getObservation(tableId);
          if (observation.legalActions.length > 0) return { participant, observation };
        } catch {
          // The table may not be visible to this principal yet; keep polling.
        }
      }
      return null;
    },
    { timeoutMs: options.timeoutMs ?? 60_000 }
  );
}

export function pickLegalAction(
  observation: SeatObservation,
  preferred: LegalActionFamily[] = FAMILY_PREFERENCE
): LegalAction {
  for (const family of preferred) {
    const action = observation.legalActions.find((candidate) => candidate.family === family);
    if (action) return action;
  }
  const fallback = observation.legalActions[0];
  if (!fallback) throw new Error('observation carries no legal actions');
  return fallback;
}

export function resolveActionAmount(action: LegalAction): number | undefined {
  if (action.family !== 'BET' && action.family !== 'RAISE') return action.amount;
  if (action.amount !== undefined) return action.amount;
  return action.minAmount;
}

export async function submitLegalAction(
  client: PokerClient,
  observation: SeatObservation,
  action: LegalAction = pickLegalAction(observation)
): Promise<CanonicalActionResult> {
  const amount = resolveActionAmount(action);
  return client.action(observation.tableId, {
    requestId: randomUUID(),
    turnId: observation.turnId,
    expectedVersion: observation.version,
    actionId: action.actionId,
    ...(amount !== undefined && amount > 0 ? { amount } : {}),
  });
}

export interface RoomDriverOptions {
  maxActions?: number;
  actionDelayMs?: number;
}

/** Drive one table by always submitting a server-issued legal action. */
export async function driveRoomToCompletion(
  participants: Participant[],
  tableId: string,
  options: RoomDriverOptions = {}
): Promise<{ actions: number; lastAction: LegalActionFamily | null }> {
  const maxActions = options.maxActions ?? 2000;
  let actions = 0;
  let lastAction: LegalActionFamily | null = null;
  while (actions < maxActions) {
    const turn = await waitForActingParticipant(participants, tableId, { timeoutMs: 120_000 });
    const action = pickLegalAction(turn.observation);
    await submitLegalAction(turn.participant.client, turn.observation, action);
    lastAction = action.family;
    actions += 1;
    if (options.actionDelayMs) await new Promise((resolve) => setTimeout(resolve, options.actionDelayMs));
  }
  return { actions, lastAction };
}
