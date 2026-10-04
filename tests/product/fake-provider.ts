/**
 * Minimal loopback HTTP fake provider. The product provider under test uses the
 * real global `fetch`, so each test exercises an actual HTTP exchange on
 * 127.0.0.1 instead of a mocked fetch function.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeExchange {
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface FakeReply {
  status?: number;
  /** Raw response body; callers normally JSON.stringify their payload. */
  body?: string;
  /** Streamed parts written in order; takes precedence over `body`. */
  chunks?: string[];
  /** Delay between streamed chunks, in milliseconds. */
  chunkDelayMs?: number;
  contentType?: string;
  delayMs?: number;
}

export interface FakeProvider {
  url: string;
  exchanges: FakeExchange[];
  close(): Promise<void>;
}

export async function startFakeProvider(
  handler: (exchange: FakeExchange) => FakeReply | Promise<FakeReply>,
): Promise<FakeProvider> {
  const exchanges: FakeExchange[] = [];
  const server: Server = createServer((request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      void (async () => {
        const exchange: FakeExchange = {
          headers: request.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        };
        exchanges.push(exchange);
        const reply = await handler(exchange);
        if (reply.delayMs) await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
        if (response.destroyed || response.writableEnded) return;
        response.writeHead(reply.status ?? 200, {
          'content-type': reply.contentType ?? 'application/json',
        });
        const parts = reply.chunks ?? [reply.body ?? '{}'];
        for (const part of parts) {
          if (response.destroyed || response.writableEnded || response.writableFinished) return;
          response.write(part);
          if (reply.chunkDelayMs) await new Promise((resolve) => setTimeout(resolve, reply.chunkDelayMs));
        }
        if (!response.destroyed && !response.writableEnded) response.end();
      })().catch(() => {
        if (response.destroyed || response.writableEnded || response.headersSent) return;
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'fake provider failure' }));
      });
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

export function toolCallResponse(argumentsValue: unknown, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: 'chatcmpl-test',
    choices: [
      {
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: {
                name: 'choose_action',
                arguments: JSON.stringify(argumentsValue),
              },
            },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 10 },
    ...overrides,
  });
}
