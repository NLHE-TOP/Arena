/**
 * Ordinary SDK transport for one authenticated agent credential.
 *
 * Composes the standard `PokerClient` and `PokerSocket`:
 * - REST (`getObservation`, `action`, `getChat`, `sendChat`, `getPrincipal`)
 *   provides recovery observations and canonical action submission;
 * - socket `observation` messages carry the authoritative decision boundary;
 * - the bearer token is held only by the SDK clients and never logged.
 */
import { PokerClient, PokerSocket } from '@pokertools/sdk';
import type {
  CanonicalActionRequest,
  CanonicalActionResult,
  Principal,
  SeatObservation,
} from '@pokertools/types';
import type { AgentChatQuery, AgentChatReceipt, AgentTurnTransport } from './contracts.js';

export interface SdkAgentTransportOptions {
  baseUrl: string;
  /** Bearer credential (wallet session or scoped SERVICE credential). */
  token: string;
  /** Optional explicit WebSocket URL. */
  wsUrl?: string;
  /** Per-request SDK timeout; defaults to 15000 ms. */
  timeoutMs?: number;
  /** Connect the realtime socket for canonical observations; default true. */
  connectSocket?: boolean;
  /** Injectable WebSocket constructor (tests); defaults to the global one. */
  WebSocket?: typeof WebSocket;
}

export class SdkAgentTransport implements AgentTurnTransport {
  private readonly client: PokerClient;
  private readonly socket: PokerSocket | null;
  private readonly wantedTables = new Set<string>();
  private readonly listeners = new Map<
    string,
    Set<(observation: SeatObservation) => void>
  >();
  private principal: Principal | null = null;
  private closed = false;
  private readonly recoveryListeners = new Set<() => void>();

  constructor(options: SdkAgentTransportOptions) {
    this.client = new PokerClient({
      baseUrl: options.baseUrl,
      token: options.token,
      timeout: options.timeoutMs ?? 15_000,
      retry: { count: 2, delay: 100, backoff: 2 },
    });
    this.socket =
      options.connectSocket === false
        ? null
        : PokerSocket.fromConfig({
            baseUrl: options.baseUrl,
            token: options.token,
            wsUrl: options.wsUrl,
            WebSocket: options.WebSocket,
          });
  }

  get principalId(): string | null {
    return this.principal?.id ?? null;
  }

  async connect(): Promise<void> {
    this.principal = await this.client.getPrincipal();
    if (this.socket === null) return;
    this.socket.on('observation', (tableId, observation) => {
      const listeners = this.listeners.get(tableId);
      if (listeners === undefined) return;
      for (const listener of listeners) listener(observation);
    });
    this.socket.on('connect', () => {
      for (const listener of this.recoveryListeners) listener();
    });
    this.socket.on('disconnect', () => {
      if (!this.closed) this.notifyRecovery();
    });
    this.socket.on('error', () => {
      if (!this.closed) this.notifyRecovery();
    });
    await this.socket.connect();
    for (const tableId of this.wantedTables) {
      void this.socket.join(tableId).catch(() => {
        this.notifyRecovery();
      });
    }
  }

  close(): void {
    this.closed = true;
    this.socket?.disconnect();
  }

  fetchObservation(tableId: string): Promise<SeatObservation> {
    return this.client.getObservation(tableId);
  }

  submitAction(
    tableId: string,
    request: CanonicalActionRequest,
  ): Promise<CanonicalActionResult> {
    return this.client.action(tableId, request);
  }

  async fetchChat(tableId: string, options: AgentChatQuery): Promise<readonly unknown[]> {
    const page = await this.client.getChat(tableId, {
      limit: options.limit,
      ...(options.beforeSeq !== undefined ? { beforeSeq: options.beforeSeq } : {}),
    });
    return page.messages;
  }

  async sendChat(input: {
    tableId: string;
    body: string;
    requestId: string;
  }): Promise<AgentChatReceipt> {
    // The platform chat append carries no idempotency key, so `requestId` is
    // only the runtime's durable at-most-once intention identity.
    const message = await this.client.sendChat(input.tableId, input.body);
    return { messageId: message.messageId };
  }

  onObservation(
    tableId: string,
    listener: (observation: SeatObservation) => void,
  ): () => void {
    let listeners = this.listeners.get(tableId);
    if (listeners === undefined) {
      listeners = new Set();
      this.listeners.set(tableId, listeners);
    }
    listeners.add(listener);
    this.wantedTables.add(tableId);
    if (this.socket !== null && this.socket.isConnected()) {
      void this.socket.join(tableId).catch(() => {
        this.notifyRecovery();
      });
    }
    return () => {
      const current = this.listeners.get(tableId);
      if (current === undefined) return;
      current.delete(listener);
      if (current.size === 0) {
        this.listeners.delete(tableId);
        if (!this.closed) this.socket?.leave(tableId);
      }
    };
  }

  onRecovery(listener: () => void): () => void {
    this.recoveryListeners.add(listener);
    return () => { this.recoveryListeners.delete(listener); };
  }

  private notifyRecovery(): void {
    for (const listener of this.recoveryListeners) listener();
  }
}
