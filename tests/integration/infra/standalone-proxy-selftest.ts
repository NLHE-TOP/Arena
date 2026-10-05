#!/usr/bin/env tsx
/**
 * Focused regression for the standalone-container loopback sidecar mapping:
 * - only loopback fake-provider base URLs are remapped; live HTTPS catalogs
 *   and real provider URLs pass through untouched;
 * - legacy host-published and explicit container/direct mappings are built
 *   correctly;
 * - the generic TCP proxy still forwards for BOTH the legacy 2-element mapping
 *   and the explicit 3-element `[listenPort, targetHost, targetPort]` mapping.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildStandaloneEnv,
  containerTargetMapping,
  deriveProxiedAgentsConfig,
  publishedHostMapping,
} from './standalone-container.js';

const proxyScript = join(dirname(fileURLToPath(import.meta.url)), 'tcp-proxy.mjs');

function freeTcpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('no port')));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

function startEchoServer(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => socket.pipe(socket));
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('no echo port')));
        return;
      }
      resolve({
        port: address.port,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function connectRoundTrip(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    let received = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`proxy round-trip timed out on ${port}`));
    }, 5_000);
    socket.on('connect', () => socket.write(payload));
    socket.on('data', (chunk) => {
      received += chunk.toString();
      if (received.includes(payload)) {
        clearTimeout(timer);
        socket.destroy();
        resolve(received);
      }
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function proxyForwards(mapping: unknown[], env: Record<string, string>, targetPort: number): Promise<void> {
  const listenPort = mapping[0] as number;
  const child = spawn(process.execPath, [proxyScript], {
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: process.env.HOME ?? '/tmp',
      TMPDIR: process.env.TMPDIR ?? '/tmp',
      PROXY_PORTS: JSON.stringify([mapping]),
      ...env,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
  try {
    // Wait for the listener, then prove the payload traverses the proxy.
    const deadline = Date.now() + 5_000;
    let lastError: unknown = null;
    while (Date.now() < deadline) {
      try {
        await connectRoundTrip(listenPort, `probe-${targetPort}`);
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    throw new Error(`proxy did not forward [${mapping.join(',')}]: ${lastError} ${stderr.trim()}`);
  } finally {
    child.kill('SIGTERM');
  }
}

const dir = mkdtempSync(join(tmpdir(), 'nlhe-standalone-proxy-selftest-'));
try {
  const catalogPath = join(dir, 'agents.json');
  writeFileSync(
    catalogPath,
    `${JSON.stringify(
      [
        { id: 'agent1', baseUrl: 'http://127.0.0.1:1234/v1' },
        { id: 'agent2', baseUrl: 'http://localhost:9999/v1' },
        { id: 'agent3', baseUrl: 'https://real-provider.example.invalid/v1' },
        { id: 'agent4', baseUrl: null },
      ],
      null,
      2
    )}\n`
  );

  const derived = deriveProxiedAgentsConfig(catalogPath, 1234, 4321);
  const agents = JSON.parse(derived.value) as Array<{ id: string; baseUrl: string | null }>;
  const byId = new Map(agents.map((agent) => [agent.id, agent.baseUrl]));
  // agent4 has no baseUrl: neither remapped nor preserved.
  if (derived.remapped !== 1 || derived.preserved !== 2) {
    throw new Error(`unexpected mapping counts: remapped=${derived.remapped} preserved=${derived.preserved}`);
  }
  if (byId.get('agent1') !== 'http://127.0.0.1:4321/v1') {
    throw new Error(`loopback fake provider was not remapped: ${String(byId.get('agent1'))}`);
  }
  if (byId.get('agent2') !== 'http://localhost:9999/v1') {
    throw new Error(`non-matching loopback port was rewritten: ${String(byId.get('agent2'))}`);
  }
  if (byId.get('agent3') !== 'https://real-provider.example.invalid/v1') {
    throw new Error('live HTTPS provider catalog was rewritten');
  }
  if (byId.get('agent4') !== null) throw new Error('null baseUrl was not preserved');

  // Real HTTPS provider branch: no mapping is passed, so even loopback-shaped
  // entries are preserved unchanged and no fake proxy port is introduced.
  const httpsOnly = deriveProxiedAgentsConfig(catalogPath, null, null);
  if (httpsOnly.remapped !== 0 || httpsOnly.preserved !== 3) {
    throw new Error(`HTTPS branch remapped unexpectedly: remapped=${httpsOnly.remapped} preserved=${httpsOnly.preserved}`);
  }
  const httpsAgents = JSON.parse(httpsOnly.value) as Array<{ id: string; baseUrl: string | null }>;
  if (httpsAgents.find((agent) => agent.id === 'agent1')?.baseUrl !== 'http://127.0.0.1:1234/v1') {
    throw new Error('HTTPS branch rewrote a catalog entry');
  }

  // Mapping constructors: legacy host-published vs explicit container-direct.
  const legacy = publishedHostMapping(5001, 3000);
  if (legacy[0] !== 5001 || legacy[1] !== 'host.docker.internal' || legacy[2] !== 3000) {
    throw new Error(`unexpected legacy mapping: ${JSON.stringify(legacy)}`);
  }
  const direct = containerTargetMapping(5002, 'nlhe-stage-api-abc');
  if (direct[0] !== 5002 || direct[1] !== 'nlhe-stage-api-abc' || direct[2] !== 3000) {
    throw new Error(`unexpected container mapping: ${JSON.stringify(direct)}`);
  }

  // Env boundary: in-namespace loopback proxy URLs are accepted, while platform
  // authority values remain forbidden by the registry check (see the dedicated
  // secret-registry selftest).
  const env = buildStandaloneEnv(
    {
      orchestrationToken: 'ptsvc_' + 'a'.repeat(43),
      productAdminToken: 'nlheit-test-admin-token-value',
      maxProviderCalls: 50,
      maxHands: 4,
    },
    {
      platformUrlForContainer: 'http://127.0.0.1:4321',
      providerBaseUrlForContainer: 'http://127.0.0.1:4322/v1',
      providerApiKey: 'sk-fixture-value-not-real',
      providerModel: 'fixture/model',
      publicOrigin: 'http://127.0.0.1:4323',
      containerDatabasePath: '/data/product.sqlite',
    }
  );
  if (env.POKERTOOLS_API_URL !== 'http://127.0.0.1:4321') {
    throw new Error(`container platform URL is not loopback-proxied: ${String(env.POKERTOOLS_API_URL)}`);
  }
  if (env.OPENAI_BASE_URL !== 'http://127.0.0.1:4322/v1') {
    throw new Error(`container provider URL is not loopback-proxied: ${String(env.OPENAI_BASE_URL)}`);
  }
  if (env.PUBLIC_ORIGIN !== 'http://127.0.0.1:4323') {
    throw new Error('public origin changed');
  }

  // Real HTTPS provider URL is passed through untouched (no proxy port).
  const httpsEnv = buildStandaloneEnv(
    { orchestrationToken: 'ptsvc_' + 'a'.repeat(43), productAdminToken: 'nlheit-test-admin-token-value', maxProviderCalls: 20, maxHands: 2 },
    {
      platformUrlForContainer: 'http://127.0.0.1:4321',
      providerBaseUrlForContainer: 'https://real-provider.example.invalid/v1',
      providerApiKey: 'sk-fixture-value-not-real',
      providerModel: 'fixture/model',
      publicOrigin: 'http://127.0.0.1:4323',
      containerDatabasePath: '/data/product.sqlite',
    }
  );
  if (httpsEnv.OPENAI_BASE_URL !== 'https://real-provider.example.invalid/v1') {
    throw new Error(`real HTTPS provider URL was rewritten: ${String(httpsEnv.OPENAI_BASE_URL)}`);
  }

  // Live proxy forwarding: legacy 2-tuple (host override for the local test)
  // and explicit 3-tuple both traverse the actual forwarded socket.
  const echo = await startEchoServer();
  try {
    const legacyListen = await freeTcpPort();
    await proxyForwards([legacyListen, echo.port], { PROXY_TARGET_HOST: '127.0.0.1' }, echo.port);
    const tripleListen = await freeTcpPort();
    await proxyForwards([tripleListen, '127.0.0.1', echo.port], {}, echo.port);
  } finally {
    await echo.close();
  }

  console.log(
    'standalone proxy mapping PASS: loopback remap only, HTTPS preserved, loopback env URLs, legacy+direct mappings forward'
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
