/**
 * Minimal, connection-isolated JSON-RPC proxies for quorum tests.
 *
 * Two distinct loopback URLs forwarding to the same real Anvil. Each upstream
 * request opens a fresh connection with `Connection: close` so a stale
 * keep-alive socket can never make a quorum read spuriously fail (which would
 * open an RPC_QUORUM_FAILURE incident and freeze the asset).
 */
import { createServer, request as httpRequest, type Server } from 'node:http';

export interface RpcProxySet {
  urls: string[];
  close(): Promise<void>;
}

export async function startRpcProxies(upstreamUrl: string, count = 2): Promise<RpcProxySet> {
  const upstream = new URL(upstreamUrl);
  const servers: Server[] = [];
  const urls: string[] = [];

  await Promise.all(
    Array.from({ length: count }, (_, index) =>
      new Promise<void>((resolve, reject) => {
        const server = createServer((incoming, outgoing) => {
          const chunks: Buffer[] = [];
          incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
          incoming.on('end', () => {
            const upstreamRequest = httpRequest(
              {
                host: upstream.hostname,
                port: upstream.port,
                path: '/',
                method: 'POST',
                agent: false,
                headers: {
                  'content-type': 'application/json',
                  'content-length': Buffer.byteLength(Buffer.concat(chunks)),
                  connection: 'close',
                },
              },
              (upstreamResponse) => {
                // Keep the DOWNSTREAM connection alive (the registry client
                // reuses it); only upstream sockets are fresh per request.
                const { connection: _upstreamConnection, ...safeHeaders } = upstreamResponse.headers;
                void _upstreamConnection;
                outgoing.writeHead(upstreamResponse.statusCode ?? 502, safeHeaders);
                upstreamResponse.pipe(outgoing);
              }
            );
            upstreamRequest.on('error', () => {
              if (!outgoing.headersSent) outgoing.writeHead(502);
              outgoing.end();
            });
            upstreamRequest.end(Buffer.concat(chunks));
          });
        });
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
          const address = server.address();
          if (address === null || typeof address === 'string') {
            server.close(() => reject(new Error('no proxy port assigned')));
            return;
          }
          urls[index] = `http://127.0.0.1:${address.port}`;
          servers.push(server);
          resolve();
        });
      })
    )
  );

  return {
    urls: [...urls].filter(Boolean),
    close: async () => {
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve) => {
              server.close(() => resolve());
            })
        )
      );
    },
  };
}
