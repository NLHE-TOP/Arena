/**
 * Transparent fault-injection proxy between the NLHE product's public SDK and
 * the real PokerTools API. It never fakes protocol responses: every request is
 * forwarded to the real API (which really accepts and commits it). It only
 * controls delivery:
 *
 * - `holdNextActionResponse`: forwards the canonical action, waits for the real
 *   accepted receipt, and holds it (the product crashes without seeing it).
 *   Release may then be a no-op because the client is gone; the restarted
 *   product must replay the same requestId and reuse the stored receipt.
 * - `delayNextActionForward`: holds the canonical action request itself for a
 *   fixed delay, so the platform timeout wins and the late request is stale.
 *
 * HTTP and WebSocket upgrade traffic are both proxied.
 */
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import { freePort } from './proc.js';

interface HeldResponse {
  response: ServerResponse;
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export interface ActionProxyHandle {
  url: string;
  /** Hold the next canonical action response after the real API accepts it. */
  holdNextActionResponse(): void;
  /** Delay forwarding the next canonical action request by `delayMs`. */
  delayNextActionForward(delayMs: number): void;
  delayNextCompetitionStartForward(delayMs: number): void;
  holdNextCancellationResponse(): void;
  competitionStartRequests: () => number;
  heldResponses: () => number;
  heldActionRequestId: () => string | null;
  heldActionReceipt: () => unknown;
  delayedActionRequestId: () => string | null;
  releaseHeld: () => void;
  actionRequests: () => number;
  stop: () => Promise<void>;
}

function isActionPath(path: string): boolean {
  return /^\/tables\/[^/]+\/action(?:\?|$)/.test(path);
}

export async function startActionProxy(targetBaseUrl: string): Promise<ActionProxyHandle> {
  const target = new URL(targetBaseUrl);
  const port = await freePort();
  let holdArmed = false;
  let delayArmedMs: number | null = null;
  let delayedAction: { requestId: string; deadline: number } | null = null;
  let heldRequestId: string | null = null;
  let heldReceipt: unknown = null;
  let actionRequests = 0;
  let startDelayMs: number | null = null;
  let holdCancellation = false;
  let competitionStarts = 0;
  const held: HeldResponse[] = [];

  const server: Server = createServer((incoming: IncomingMessage, outgoing: ServerResponse) => {
    const path = incoming.url ?? '/';
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.on('end', () => {
      const body = Buffer.concat(chunks);
      const action = isActionPath(path);
      let requestId: string | null = null;
      if (action) {
        try {
          const parsed = JSON.parse(body.toString('utf8')) as { requestId?: unknown };
          if (typeof parsed.requestId === 'string') requestId = parsed.requestId;
        } catch { /* Forward invalid bodies to the real platform unchanged. */ }
      }
      const competitionStart = incoming.method === 'POST' && /^\/competitions\/[^/]+\/start$/.test(path);
      const cancellation = incoming.method === 'POST' && /^\/competitions\/[^/]+\/cancel$/.test(path);
      if (competitionStart) competitionStarts += 1;
      if (action) actionRequests += 1;

      const forward = (): void => {
        const upstream = httpRequest(
          {
            host: target.hostname,
            port: target.port,
            path,
            method: incoming.method,
            agent: false,
            headers: { ...incoming.headers, host: target.host, connection: 'close' },
          },
          (upstreamResponse) => {
            const responseChunks: Buffer[] = [];
            upstreamResponse.on('data', (chunk: Buffer) => responseChunks.push(chunk));
            upstreamResponse.on('end', () => {
              const responseBody = Buffer.concat(responseChunks);
              const headers = { ...upstreamResponse.headers, connection: 'close' } as Record<
                string,
                string | string[] | undefined
              >;
              const accepted = (upstreamResponse.statusCode ?? 502) >= 200 && (upstreamResponse.statusCode ?? 502) < 300;
              if (action && accepted && holdArmed && requestId !== null) {
                holdArmed = false;
                heldRequestId = requestId;
                heldReceipt = (JSON.parse(responseBody.toString('utf8')) as { receipt?: unknown }).receipt ?? null;
              }
              // Retries of this canonical identity must not escape the crash
              // window merely because the first response was already held.
              if ((action && requestId !== null && requestId === heldRequestId) || (cancellation && holdCancellation)) {
                if (cancellation) holdCancellation = false;
                held.push({
                  response: outgoing,
                  status: upstreamResponse.statusCode ?? 502,
                  headers,
                  body: responseBody,
                });
                // Do not deliver: the product must crash without this receipt.
                return;
              }
              outgoing.writeHead(upstreamResponse.statusCode ?? 502, headers);
              outgoing.end(responseBody);
            });
          }
        );
        upstream.on('error', () => {
          if (!outgoing.headersSent) outgoing.writeHead(502, { connection: 'close' });
          outgoing.end();
        });
        upstream.end(body);
      };

      if (competitionStart && startDelayMs !== null) {
        const delayMs = startDelayMs;
        startDelayMs = null;
        setTimeout(forward, delayMs);
        return;
      }
      if (action && requestId !== null && delayArmedMs !== null) {
        delayedAction = { requestId, deadline: Date.now() + delayArmedMs };
        delayArmedMs = null;
      }
      // The SDK retries canonical requests with the same identity. Delay all
      // of them until the same deadline, not just the first HTTP attempt.
      if (action && delayedAction?.requestId === requestId && delayedAction.deadline > Date.now()) {
        setTimeout(forward, delayedAction.deadline - Date.now());
        return;
      }
      forward();
    });
  });

  // WebSocket upgrade passthrough (product realtime resync triggers).
  server.on('upgrade', (request, socket, head) => {
    const upstream = connect(Number(target.port), target.hostname, () => {
      const headerLines = [`${request.method} ${request.url} HTTP/1.1`];
      for (const [name, value] of Object.entries(request.headers)) {
        if (value === undefined) continue;
        headerLines.push(`${name}: ${Array.isArray(value) ? value.join(', ') : value}`);
      }
      upstream.write(`${headerLines.join('\r\n')}\r\n\r\n`);
      if (head && head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });

  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });

  return {
    url: `http://127.0.0.1:${port}`,
    holdNextActionResponse: () => {
      holdArmed = true;
      heldRequestId = null;
      heldReceipt = null;
    },
    delayNextActionForward: (delayMs) => {
      delayArmedMs = delayMs;
      delayedAction = null;
    },
    heldResponses: () => held.length,
    heldActionRequestId: () => heldRequestId,
    heldActionReceipt: () => heldReceipt,
    delayedActionRequestId: () => delayedAction?.requestId ?? null,
    releaseHeld: () => {
      heldRequestId = null;
      for (const entry of held.splice(0)) {
        try {
          if (!entry.response.writableEnded && !entry.response.destroyed) {
            entry.response.writeHead(entry.status, entry.headers);
            entry.response.end(entry.body);
          }
        } catch {
          // Client is gone (crashed); the receipt stays with the platform.
        }
      }
    },
    actionRequests: () => actionRequests,
    delayNextCompetitionStartForward: (delayMs) => { startDelayMs = delayMs; },
    holdNextCancellationResponse: () => { holdCancellation = true; },
    competitionStartRequests: () => competitionStarts,
    stop: async () => {
      holdArmed = false;
      heldRequestId = null;
      for (const entry of held.splice(0)) entry.response.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
