/**
 * Test-only generic TCP forwarding sidecar; never included in the NLHE image.
 *
 * `PROXY_PORTS` is a JSON array of mappings. Both forms are accepted:
 *   [listenPort, targetPort]                    legacy: target host = PROXY_TARGET_HOST
 *   [listenPort, targetHost, targetPort]        explicit destination
 *
 * The sidecar listens on `0.0.0.0:<listenPort>` inside its own network
 * namespace (so a container sharing that namespace can reach it at
 * `127.0.0.1:<listenPort>`, and Docker can publish it) and forwards every
 * connection to the resolved target. `PROXY_TARGET_HOST` defaults to
 * `host.docker.internal` (the host-side acceptance service); an explicit
 * 3-element mapping can instead target a container on the shared Docker
 * network (for example the platform API at `<apiContainer>:3000`), which keeps
 * the caller's genuine container-source address instead of the host NAT
 * address. No product or platform source here.
 */
import net from 'node:net';

const raw = process.env.PROXY_PORTS;
if (typeof raw !== 'string' || raw.trim() === '') {
  console.error('PROXY_PORTS is required');
  process.exit(1);
}

let mappings;
try {
  mappings = JSON.parse(raw);
} catch {
  console.error('PROXY_PORTS is not valid JSON');
  process.exit(1);
}
if (!Array.isArray(mappings) || mappings.length === 0) {
  console.error('PROXY_PORTS must be a non-empty array');
  process.exit(1);
}

const legacyTargetHost = process.env.PROXY_TARGET_HOST || 'host.docker.internal';
const resolved = [];
for (const mapping of mappings) {
  if (!Array.isArray(mapping)) {
    console.error('PROXY_PORTS entries must be arrays');
    process.exit(1);
  }
  const [listenPort, second, third] = mapping;
  const targetHost = mapping.length >= 3 ? String(second) : legacyTargetHost;
  const targetPort = mapping.length >= 3 ? third : second;
  if (!Number.isInteger(listenPort) || !Number.isInteger(targetPort) || targetHost.length === 0) {
    console.error('PROXY_PORTS entries must be [listenPort, targetPort] or [listenPort, targetHost, targetPort]');
    process.exit(1);
  }
  resolved.push({ listenPort, targetHost, targetPort });
}

for (const { listenPort, targetHost, targetPort } of resolved) {
  net
    .createServer((socket) => {
      const upstream = net.connect({ host: targetHost, port: targetPort });
      socket.pipe(upstream).pipe(socket);
      socket.on('error', () => upstream.destroy());
      upstream.on('error', () => socket.destroy());
      socket.on('close', () => upstream.destroy());
      upstream.on('close', () => socket.destroy());
    })
    .listen(listenPort, '0.0.0.0');
}

process.on('SIGTERM', () => process.exit(0));
