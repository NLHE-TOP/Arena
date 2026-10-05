# Fresh disposable topology / standalone-container gate (infrastructure)

Tracked infrastructure: `tests/integration/infra/supervisor.ts`,
`staging.ts`, `standalone-container.ts`, `secret-registry.ts`.
Gate entrypoint and acceptance assertions are owned by the main session
(`tests/integration/container-gate.ts`, `acceptance/container-gate.ts`).

## Runnable interface (fresh external fixture)

The external staging fixture is the runnable PokerTools operational wiring
(fresh Anvil + two quorum proxies + pinned platform api/workers/custody):

```
/private/var/folders/v5/p6r4p28j27l_0_f3g6yzbkm40000gn/T/opencode/nlhe-container-gate/fixture/staging-platform.mjs
```

Cheap readiness (fresh topology, identities, API `/health` + `/ready`, custody
heartbeat, cleanup):

```bash
cd /Users/llama/Developer/nlhe
NLHE_IT_STAGING_FIXTURE=/private/var/folders/v5/p6r4p28j27l_0_f3g6yzbkm40000gn/T/opencode/nlhe-container-gate/fixture/staging-platform.mjs \
  ./node_modules/.bin/tsx tests/integration/container-gate.ts
```

Product image (must be built from current source; the gate refuses stale images):

```bash
cd /Users/llama/Developer/nlhe
npm run build
docker build -t nlhe-product:container-gate .
```

Environment:

| Variable | Meaning |
| --- | --- |
| `NLHE_IT_STAGING_FIXTURE` | absolute path to a built fixture exporting `startStagingPlatform` (required) |
| `NLHE_IT_PLATFORM_IMAGE` | released PokerTools 2.0.4 immutable image (default: `ghcr.io/aaurelions/pokertools@sha256:115beb096708048f98eb6271c65e6bb4f833c1dc03618cdc8bf3ce2a8f8b5469`) |
| `NLHE_IT_PRODUCT_IMAGE` | product image (default `nlhe-product:container-gate`) |
| `NLHE_IT_SECRET_SCANNER` | absolute path to the external final secret scanner |
| `NLHE_IT_TERMINAL_FOLD_SUMMARY` | absolute path to the focused terminal-FOLD summary; required for paid eligibility, bound to the gate's actual platform and product artifacts |
| `NLHE_IT_KEEP_RUNTIME=1` | keep the runtime dir + secret manifest for scanning |

Exit codes: `0` PASS, `1` gate FAIL, `2` not runnable (missing fixture/image).

The npm SDK/types version (`2.0.3`) is independent of platform runtime
provenance. The gate must persist `platformVersion`, `platformImage`,
`platformImageId`, `platformDigest` when available, `productImage` and
`productImageId`. Both paid wrappers must match the actual immutable platform
artifact to that reviewed gate; missing provenance or a mismatch blocks the
run. Historical 2.0.0 evidence does not attest to the current runtime. Consumed
paid markers remain immutable; any newly authorized attempt needs a fresh path.
A full gate without a validated terminal-FOLD proof is development evidence
only (`PAID_ELIGIBLE=NO`), even if its ordinary checks pass.

## Supervision contract

Every unit registered with `Supervisor` carries a public identity and a
liveness probe; two consecutive probe failures record an UNEXPECTED DEATH and
fail the next assertion:

- **process** (`processUnit`/`adoptProcess`): `pid` + `ps -o lstart=` start
  time (PID reuse safe) + optional chain-id/health probe;
- **container** (`startContainerUnit`/`adoptContainer`): `Id`,
  `Config.Image`, `State.StartedAt`, `State.Pid`; `State.Running` is the
  liveness signal; containers run with no restart policy;
- **endpoint** (`endpointUnit`): exact JSON-RPC `eth_chainId` agreement.

Required units for the full gate: `anvil`, `quorum-1`, `quorum-2`,
`platform-workers`, `platform-custody` (plus `platform-api`). Endpoint probes
are supplementary: quorum units must additionally expose a distinct child
process PID + start time (or container id), which the fixture provides.

`supervisor.pause(name)` / `resume(name)` implement the explicit Redis outage
(planned maintenance is never reported as a death). `dispose()` stops units in
reverse order and then runs cleanups (containers, volumes, network); it never
throws and returns collected errors.

Regression: `--self-test` (owned by the gate entrypoint) injects a child exit
and must observe UNEXPECTED DEATH; the same check is available as
`tests/integration/infra/secret-registry-selftest.ts` for the secret authority
boundary (platform-forbidden vs product-authorized values).

## Standalone container loopback sidecar (proven pattern)

The product enforces HTTP-loopback-only base URLs, so the standalone container
joins a TCP-forwarding sidecar network namespace:

- sidecar (`node:24-slim`, tracked `infra/tcp-proxy.mjs`) runs
  `PROXY_PORTS=[[apiProxyPort,hostPlatformPort],[providerProxyPort,hostProviderPort]]`,
  publishes `127.0.0.1:<productPort>:3001` and `127.0.0.1:<apiProxyPort>`;
- tracked `tcp-proxy.mjs` accepts legacy `[listenPort, targetPort]` (target
  `PROXY_TARGET_HOST`, default `host.docker.internal`) and explicit
  `[listenPort, targetHost, targetPort]` mappings;
- when the caller passes `dockerNetwork` + `platformContainerHost`, the sidecar
  joins the topology network and targets the API container **directly**
  (`<apiContainer>:3000`), so the platform observes the genuine container
  source address instead of the host-NAT address (rate-limit key separation);
  omitted fields keep the legacy host-published target; fake provider stays on
  the host gateway and real HTTPS provider URLs are never proxied;
- product runs `--network container:<sidecar>` with
  `POKERTOOLS_API_URL=http://127.0.0.1:<apiProxyPort>` and the derived catalog
  baseUrl `http://127.0.0.1:<providerProxyPort>`;
- the derived catalog (`runtimeDir/agents-proxied.json`, non-secret) remaps
  only loopback fake-provider ports and preserves live HTTPS provider entries;
  it persists through both product restarts;
- the sidecar is registered before the product, so teardown stops the product
  first; a product start failure stops the sidecar too;
- handle exposes `baseUrl` (published product), `platformProxyUrl` (published
  proxy) and the unchanged actual `platformUrl` for operator SDK/metrics;
- `captureLogs()` writes full (never `--tail`) redacted product + sidecar logs
  and is idempotent; call it before the final secret scan.

Focused regressions (no Docker):

```bash
./node_modules/.bin/tsx tests/integration/infra/standalone-proxy-selftest.ts
./node_modules/.bin/tsx tests/integration/infra/secret-registry-selftest.ts
```

## Teardown evidence (two-phase, before deletion)

`staging.stop()` captures evidence before removing anything:

- `platform-metrics-final.txt` — raw platform `/metrics` fetched with the
  in-memory Bearer metrics token and redacted before write, captured **before**
  the API stops; if unavailable, a safe `# platform metrics unavailable: HTTP
  <status>` diagnostic (never a false zero, token never printed);
- `logs/topology-child-logs-pre-stop.log` / `-post-stop.log` — full
  `docker logs` (never `--tail`) for every fixture container plus staging
  PostgreSQL/Redis, redacted; phase 2 catches teardown-flushed output;
- `logs/runtime-child-logs-pre-stop.log` / `-post-stop.log` — recursive
  `*.log` files from the runtime dir only (never `.env`, JSON or manifests),
  redacted, with a safe diagnostic when none exist;
- the final secret scan runs after `stop()` returns, so all of the above is in
  scope; the runtime dir and secret manifest are deleted at teardown.

## Secret handling

- Generated platform secrets use the `nlheit-` shape and are persisted to a
  mode-0600 sensitive-env manifest in the runtime directory outside captured
  artifacts, for the external scanner (`--manifest <path>`).
- **Authority split**: `addPlatformSecret` values are redacted, manifested and
  forbidden in an NLHE child; `addProductSecret` values are redacted and
  manifested but child-allowed (orchestration token, product admin token).
  `assertNoPlatformSecrets` is the boundary check.
- Container env files are mode 0600 in the runtime directory, deleted
  immediately after `docker run` creates the container and again at teardown.
- Captured container logs are redacted before touching an artifact; no
  `docker inspect` format includes `Config.Env`; no argv carries a secret.
- On any failed initialization the runtime directory and manifest are removed
  and every created resource is stopped.

## Fresh fixture responsibilities

The external fixture owns (tracked code must not embed platform config):
Anvil on fresh ports (never attaches to a running chain), two quorum proxy
endpoints, the valueless asset/sponsor registry SQL, the pinned
api/workers/custody containers and their env files, and unit descriptors.
`registerSecret` registers platform-authority values (for example the Anvil
treasury key). `finance.bootstrapSponsorBudget` / `fundAndClaim` are optional
and only used for the declared, valueless classification idempotency check.
