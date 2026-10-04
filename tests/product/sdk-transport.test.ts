/**
 * SdkAgentTransport unit tests.
 *
 * REST paths run against a real loopback HTTP server that implements the
 * canonical platform routes (`/auth/me`, `/tables/:id/observation`,
 * `/tables/:id/action`, `/tables/:id/chat` GET/POST) using the public
 * `@pokertools/types` schemas. Socket paths use an injectable fake WebSocket
 * class, so no real network or timers are involved.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  CanonicalActionResultSchema,
  ChatMessageSchema,
  ChatPageSchema,
  PrincipalSchema,
  SeatObservationSchema,
  type CanonicalActionRequest,
  type CanonicalActionResult,
  type Principal,
  type SeatObservation,
} from '@pokertools/types';
import { SdkAgentTransport } from '../../src/agents/sdk-transport.js';
import { chatFixture, observationFixture } from './fixtures.js';

const TOKEN = 'test-service-token';
const PRINCIPAL_ID = 'principal-service-1';

function principalFixture(): Principal {
  return PrincipalSchema.parse({
    id: PRINCIPAL_ID,
    kind: 'SERVICE',
    walletAddress: null,
  });
}

function observationFor(tableId: string, version = 4): SeatObservation {
  return SeatObservationSchema.parse({
    ...observationFixture(),
    tableId,
    version,
    state: { ...observationFixture().state, version },
  });
}

function actionResult(request: CanonicalActionRequest): CanonicalActionResult {
  const base = observationFor('table-1');
  const version = base.version + 1;
  const observation = SeatObservationSchema.parse({
    ...base,
    turnId: request.turnId,
    version,
    state: { ...base.state, version },
  });
  return CanonicalActionResultSchema.parse({
    receipt: {
      requestId: request.requestId,
      tableId: observation.tableId,
      handId: observation.handId,
      turnId: request.turnId,
      actionId: request.actionId,
      version,
      eventSeq: observation.eventSeq,
      acceptedAt: Date.now(),
    },
    observation,
  });
}

interface PlatformExchange {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  body: string;
}

interface FakePlatform {
  url: string;
  exchanges: PlatformExchange[];
  close(): Promise<void>;
}

async function startFakePlatform(options: {
  principal?: Principal | null;
  observation?: SeatObservation;
  actionResult?: CanonicalActionResult;
  chatPage?: unknown;
  chatMessage?: unknown;
} = {}): Promise<FakePlatform> {
  const exchanges: PlatformExchange[] = [];
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const exchange: PlatformExchange = {
        method: request.method ?? 'GET',
        path: url.pathname,
        query: url.searchParams,
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      exchanges.push(exchange);
      const json = (status: number, payload: unknown): void => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(payload));
      };
      if (exchange.path === '/auth/me') {
        if (options.principal === null) {
          json(401, { message: 'unauthenticated', code: 'UNAUTHENTICATED' });
          return;
        }
        json(200, options.principal ?? principalFixture());
        return;
      }
      const tableMatch = /^\/tables\/([^/]+)\/(observation|action|chat)$/.exec(exchange.path);
      if (tableMatch === null) {
        json(404, { message: 'not found', code: 'NOT_FOUND' });
        return;
      }
      const tableId = decodeURIComponent(tableMatch[1]!);
      const route = tableMatch[2];
      if (route === 'observation' && exchange.method === 'GET') {
        json(200, options.observation ?? observationFor(tableId));
        return;
      }
      if (route === 'action' && exchange.method === 'POST') {
        const request = JSON.parse(exchange.body) as CanonicalActionRequest;
        json(200, options.actionResult ?? actionResult(request));
        return;
      }
      if (route === 'chat' && exchange.method === 'GET') {
        json(
          200,
          options.chatPage ?? {
            tableId,
            messages: [chatFixture(3, 'hello')],
            nextBeforeSeq: null,
          },
        );
        return;
      }
      if (route === 'chat' && exchange.method === 'POST') {
        json(
          200,
          options.chatMessage ?? {
            messageId: 'msg-sent-1',
            tableId,
            handId: observationFixture().handId,
            eventSeq: 4,
            principalId: PRINCIPAL_ID,
            body: JSON.parse(exchange.body).body as string,
            sentAt: Date.now(),
          },
        );
        return;
      }
      json(405, { message: 'method not allowed', code: 'METHOD_NOT_ALLOWED' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    exchanges,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

// ---------------------------------------------------------------------------
// Injectable fake WebSocket
// ---------------------------------------------------------------------------

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  static failJoinForTables = new Set<string>();

  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: ((event: { reason?: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  readonly sent: string[] = [];

  constructor(
    readonly url: string,
    readonly protocols?: string[],
  ) {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.();
    });
  }

  send(data: string): void {
    this.sent.push(data);
    const message = JSON.parse(data) as {
      type?: string;
      tableId?: string;
      requestId?: string;
    };
    if (message.type === 'JOIN' && message.tableId !== undefined) {
      if (FakeWebSocket.failJoinForTables.has(message.tableId)) return;
      const tableId = message.tableId;
      queueMicrotask(() => {
        this.deliver({
          type: 'OBSERVATION',
          tableId,
          observation: observationFor(tableId),
          timestamp: Date.now(),
          ...(message.requestId !== undefined ? { requestId: message.requestId } : {}),
        });
      });
    }
    if (message.type === 'PING' && message.requestId !== undefined) {
      const requestId = message.requestId;
      queueMicrotask(() => {
        this.deliver({ type: 'PONG', requestId, timestamp: Date.now() });
      });
    }
  }

  close(_code?: number, reason?: string): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ reason });
  }

  deliver(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  static reset(): void {
    FakeWebSocket.instances = [];
    FakeWebSocket.failJoinForTables = new Set();
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SdkAgentTransport REST', () => {
  it('authenticates the principal and forwards canonical observation/action/chat', async () => {
    const platform = await startFakePlatform();
    const transport = new SdkAgentTransport({
      baseUrl: platform.url,
      token: TOKEN,
      connectSocket: false,
    });
    let submittedRequest: CanonicalActionRequest | null = null;
    try {
      expect(transport.principalId).toBeNull();
      await transport.connect();
      expect(transport.principalId).toBe(PRINCIPAL_ID);

      const observation = await transport.fetchObservation('table-1');
      expect(observation.tableId).toBe('table-1');
      expect(observation.turnId).toBe(observationFixture().turnId);

      const request: CanonicalActionRequest = {
        requestId: 'req-1',
        turnId: observation.turnId,
        expectedVersion: observation.version,
        actionId: 'act-check',
      };
      submittedRequest = request;
      const result = await transport.submitAction('table-1', request);
      expect(result.receipt.requestId).toBe('req-1');
      expect(result.receipt.actionId).toBe('act-check');

      const messages = await transport.fetchChat('table-1', { limit: 2, beforeSeq: 11 });
      expect(messages).toHaveLength(1);

      const sent = await transport.sendChat({
        tableId: 'table-1',
        body: 'hello table',
        requestId: 'intent-1',
      });
      expect(sent.messageId).toBe('msg-sent-1');
      transport.close();
      transport.close();
    } finally {
      await platform.close();
    }

    const auth = platform.exchanges.find((exchange) => exchange.path === '/auth/me');
    expect(auth?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    const observationCall = platform.exchanges.find(
      (exchange) => exchange.path === '/tables/table-1/observation',
    );
    expect(observationCall?.method).toBe('GET');
    const actionCall = platform.exchanges.find(
      (exchange) => exchange.path === '/tables/table-1/action',
    );
    expect(JSON.parse(actionCall!.body)).toEqual(submittedRequest);
    const chatGet = platform.exchanges.find(
      (exchange) => exchange.path === '/tables/table-1/chat' && exchange.method === 'GET',
    );
    expect(chatGet?.query.get('limit')).toBe('2');
    expect(chatGet?.query.get('beforeSeq')).toBe('11');
    const chatPost = platform.exchanges.find(
      (exchange) => exchange.path === '/tables/table-1/chat' && exchange.method === 'POST',
    );
    expect(JSON.parse(chatPost!.body)).toEqual({ body: 'hello table' });
  });

  it('rejects when the platform does not authenticate the credential', async () => {
    const platform = await startFakePlatform({ principal: null });
    const transport = new SdkAgentTransport({
      baseUrl: platform.url,
      token: TOKEN,
      connectSocket: false,
    });
    try {
      await expect(transport.connect()).rejects.toThrow();
      expect(transport.principalId).toBeNull();
    } finally {
      await platform.close();
    }
  });

  it('manages observation listeners without a socket', async () => {
    const platform = await startFakePlatform();
    const transport = new SdkAgentTransport({
      baseUrl: platform.url,
      token: TOKEN,
      connectSocket: false,
    });
    try {
      await transport.connect();
      const first = (): void => {};
      const second = (): void => {};
      const offFirst = transport.onObservation('table-1', first);
      const offSecond = transport.onObservation('table-1', second);
      offFirst();
      offSecond();
      // Removing an already-removed listener is a no-op.
      offSecond();
    } finally {
      await platform.close();
    }
  });

  it('keeps canonical chat and action schemas intact', async () => {
    const platform = await startFakePlatform({
      chatPage: {
        tableId: 'table-1',
        messages: [chatFixture(2, 'first'), chatFixture(3, 'second')],
        nextBeforeSeq: 2,
      },
    });
    const transport = new SdkAgentTransport({
      baseUrl: platform.url,
      token: TOKEN,
      connectSocket: false,
    });
    try {
      await transport.connect();
      const messages = await transport.fetchChat('table-1', { limit: 5 });
      expect(messages).toHaveLength(2);
      expect(ChatMessageSchema.safeParse(messages[0]).success).toBe(true);
      expect(ChatPageSchema.safeParse({ tableId: 'table-1', messages, nextBeforeSeq: 2 }).success).toBe(
        true,
      );
    } finally {
      await platform.close();
    }
  });
});

describe('SdkAgentTransport socket triggers', () => {
  it('joins wanted tables, forwards trigger payloads and leaves on unsubscribe', async () => {
    FakeWebSocket.reset();
    const platform = await startFakePlatform();
    const transport = new SdkAgentTransport({
      baseUrl: platform.url,
      token: TOKEN,
      wsUrl: `${platform.url.replace('http', 'ws')}/ws/play`,
      WebSocket: FakeWebSocket as unknown as typeof WebSocket,
    });
    const observed: string[] = [];
    const off = transport.onObservation('table-1', (observation) => {
      observed.push(`${observation.tableId}:${observation.turnId}`);
    });
    try {
      await transport.connect();
      expect(transport.principalId).toBe(PRINCIPAL_ID);
      // The join response is forwarded as a resync trigger.
      expect(observed).toEqual([`table-1:${observationFixture().turnId}`]);

      // A payload for a table with no listener is ignored.
      const socket = FakeWebSocket.instances[0]!;
      socket.deliver({
        type: 'OBSERVATION',
        tableId: 'table-unknown',
        observation: observationFor('table-unknown'),
        timestamp: Date.now(),
      });
      expect(observed).toHaveLength(1);

      // Adding a listener while connected joins that table.
      const offSecond = transport.onObservation('table-2', (observation) => {
        observed.push(`${observation.tableId}:${observation.turnId}`);
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(observed).toContain(`table-2:${observationFixture().turnId}`);

      // Removing the last listener leaves the table.
      offSecond();
      const sentTypes = socket.sent.map(
        (entry) => (JSON.parse(entry) as { type: string; tableId?: string }).type,
      );
      expect(sentTypes).toContain('LEAVE');
      offSecond();

      // Removing a listener after close must not attempt another leave.
      transport.close();
      off();
      expect(transport.principalId).toBe(PRINCIPAL_ID);
    } finally {
      await platform.close();
    }
  });

  it('tolerates failed trigger joins at connect and while connected', async () => {
    FakeWebSocket.reset();
    const platform = await startFakePlatform();
    FakeWebSocket.failJoinForTables.add('table-fail-connect');
    const transport = new SdkAgentTransport({
      baseUrl: platform.url,
      token: TOKEN,
      WebSocket: FakeWebSocket as unknown as typeof WebSocket,
    });
    const off = transport.onObservation('table-fail-connect', () => {});
    try {
      await transport.connect();
      expect(transport.principalId).toBe(PRINCIPAL_ID);
      // A failing join while connected is swallowed by the best-effort catch.
      FakeWebSocket.failJoinForTables.add('table-fail-live');
      const offLive = transport.onObservation('table-fail-live', () => {});
      await Promise.resolve();
      await Promise.resolve();
      offLive();
      off();
    } finally {
      await platform.close();
    }
  });

  it('disconnects cleanly when closed', async () => {
    FakeWebSocket.reset();
    const platform = await startFakePlatform();
    const transport = new SdkAgentTransport({
      baseUrl: platform.url,
      token: TOKEN,
      WebSocket: FakeWebSocket as unknown as typeof WebSocket,
    });
    const off = transport.onObservation('table-1', () => {});
    try {
      await transport.connect();
      transport.close();
      expect(FakeWebSocket.instances[0]!.readyState).toBe(FakeWebSocket.CLOSED);
      // Unsubscribing after close removes the listener without a LEAVE.
      off();
      const leavesAfterClose = FakeWebSocket.instances[0]!.sent.filter(
        (entry) => (JSON.parse(entry) as { type: string }).type === 'LEAVE',
      );
      expect(leavesAfterClose).toHaveLength(0);
    } finally {
      await platform.close();
    }
  });
});
