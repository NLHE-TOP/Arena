/**
 * PokerTools SDK adapter.
 *
 * Runtime transport is the public `@pokertools/sdk`: HTTP via `PokerClient`
 * and the live masked stream via `PokerSocket`. Wire types are the SDK's
 * public re-exports (`@pokertools/sdk/types` surface), so the web app never
 * reaches into package internals and never reproduces poker legality locally.
 *
 * The SDK owns reconnect/resubscribe; this adapter only mirrors its state into
 * the UI store.
 */

import {
  CompetitionClient,
  PokerClient,
  PokerSocket,
  type CanonicalActionRequest,
  type CanonicalActionResult,
  type ChatMessage,
  type ChatPage,
  type ReplayFrame,
  type SeatObservation,
} from '@pokertools/sdk';

/** Create the HTTP client for one PokerTools API base URL. */
export function createPokerClient(baseUrl: string, token?: string | null): PokerClient {
  return new PokerClient({
    baseUrl,
    token: token ?? undefined,
    timeout: 20_000,
    retry: { count: 2, delay: 300, backoff: 2 },
  });
}

/**
 * Competition transport for the human's own wallet session. `getCompetition`
 * shows the actual platform terms/entry state; `optIn` is the only path that
 * can charge an entry and runs with the payer's own opaque bearer, never the
 * product orchestrator credential.
 */
export function createCompetitionClient(baseUrl: string, token: string): CompetitionClient {
  return new CompetitionClient({
    baseUrl,
    token,
    timeout: 20_000,
    retry: { count: 2, delay: 300, backoff: 2 },
  });
}

/**
 * Stable entry idempotency key for one human in one room. Retrying the explicit
 * Pay entry action replays the same platform opt-in instead of charging twice.
 */
export function entryOptInKey(roomId: string, principalId: string): string {
  return `nlhe-entry:${roomId}:${principalId}`;
}

/**
 * Submit one canonical action for the current server-issued turn.
 *
 * The caller must generate the request id once per user intent and must not
 * re-enter while a submission is in flight; the SDK reuses the identical
 * serialized body (including this `requestId`) across its own transport
 * retries, so a lost response cannot apply the action twice.
 */
export function submitCanonicalAction(
  client: PokerClient,
  observation: SeatObservation,
  actionId: string,
  amount?: number
): Promise<CanonicalActionResult> {
  const request: CanonicalActionRequest = {
    requestId: crypto.randomUUID(),
    turnId: observation.turnId,
    expectedVersion: observation.version,
    actionId,
    ...(amount === undefined ? {} : { amount }),
  };
  return client.action(observation.tableId, request);
}

// ---------------------------------------------------------------------------
// Chat / replay
// ---------------------------------------------------------------------------

export function loadChat(
  client: PokerClient,
  tableId: string,
  options: { limit?: number; beforeSeq?: number } = {}
): Promise<ChatPage> {
  return client.getChat(tableId, options);
}

/**
 * Append one chat message. The current SDK transport carries no idempotency
 * key for chat, so callers must disable the composer while a send is in
 * flight and must not retry automatically.
 */
export function postChat(client: PokerClient, tableId: string, body: string): Promise<ChatMessage> {
  return client.sendChat(tableId, body);
}

export function loadReplay(
  client: PokerClient,
  tableId: string,
  options: { fromEventSeq: number; toEventSeq?: number }
): Promise<ReplayFrame> {
  return client.getReplay(tableId, options);
}

// ---------------------------------------------------------------------------
// Live socket
// ---------------------------------------------------------------------------

export type SocketStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export interface TableSocketEvents {
  observation(tableId: string, observation: SeatObservation): void;
  status(status: SocketStatus, detail: string): void;
}

/**
 * One authenticated live-table subscription. `PokerSocket` performs
 * reconnect/resubscribe internally; `open` resolves with the first full
 * authoritative observation after join.
 */
export class TableSocket {
  private socket: PokerSocket | null = null;
  private tableId: string | null = null;

  constructor(private readonly events: TableSocketEvents) {}

  async open(baseUrl: string, token: string, tableId: string): Promise<SeatObservation> {
    this.close();

    const socket = PokerSocket.fromConfig({ baseUrl, token });
    this.socket = socket;
    this.tableId = tableId;
    this.events.status('connecting', 'connecting');

    socket.on('observation', (observedTableId, observation) => {
      if (observedTableId === this.tableId) this.events.observation(observedTableId, observation);
    });
    socket.on('connect', () => this.events.status('connected', 'connected'));
    socket.on('disconnect', (reason) =>
      this.events.status('disconnected', reason && reason.length > 0 ? reason : 'disconnected')
    );
    socket.on('reconnect', (attempt) => this.events.status('reconnecting', `attempt ${attempt}`));
    socket.on('error', (error) =>
      this.events.status(socket.isConnected() ? 'connected' : 'disconnected', error.message)
    );

    await socket.connect();
    return socket.join(tableId);
  }

  close(): void {
    const socket = this.socket;
    const tableId = this.tableId;
    this.socket = null;
    this.tableId = null;
    if (!socket) return;
    try {
      if (tableId) socket.leave(tableId);
      socket.disconnect();
    } catch {
      // The socket may already be closed; teardown is best effort.
    }
    this.events.status('idle', 'closed');
  }
}
