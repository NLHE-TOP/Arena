# Operations

The NLHE product server is one process with one SQLite database. The PokerTools
API, PostgreSQL, Redis and custody worker are separate services with their own
runbooks; this guide covers only the product server.

## Configuration and startup

`loadConfig` in `src/config.ts` parses the environment once at startup and
fails closed on invalid values. Both origins must be credential-free HTTP(S)
URLs without queries or fragments, and any non-loopback origin must be HTTPS;
`PUBLIC_ORIGIN` must be an origin, not a URL path. The loader also rejects
platform signing, session and RPC credential names (`PAYOUT_*`, `TREASURY_*`,
`CUSTODY_*`, `RPC_PROVIDER_*`, `JWT_SECRET`, `COOKIE_SECRET`, `MNEMONIC`,
`CHAIN_PRIVATE_KEY`): those secrets must never enter the product process.

| Variable                        | Default                 | Meaning                                                      |
| ------------------------------- | ----------------------- | ------------------------------------------------------------ |
| `NODE_ENV`                      | `development`           | `development`/`test`/`production`; production rejects `:memory:`. |
| `LOG_LEVEL`                     | `info`                  | Fastify log level (`trace`…`fatal`, `silent`).                |
| `HOST`                          | `127.0.0.1`             | Bind address; set `0.0.0.0` in containers.                    |
| `PORT`                          | `3001`                  | HTTP port.                                                    |
| `PUBLIC_ORIGIN`                 | `http://localhost:3001` | Public origin of the product server (origin only).            |
| `POKERTOOLS_API_URL`            | `http://localhost:3000` | PokerTools platform API base URL.                             |
| `POKERTOOLS_ORCHESTRATION_TOKEN`| unset                   | Scoped `competition:orchestrate` SERVICE credential; **secret**. |
| `DATABASE_PATH`                 | `data/product.sqlite`   | Dedicated product SQLite file (no `://` database URLs).       |
| `AGENTS_CONFIG_PATH`            | `config/agents.json`    | Agent catalog; schema in `src/product/catalog.ts`.            |
| `AGENT_CHAT_ENABLED`            | `0`                     | `1` allows optional post-commit agent public chat.            |
| `PRODUCT_ADMIN_TOKEN`           | unset                   | ≥32 characters, guards operator-only administration and audit; **secret**. |
| `CHALLENGE_ENABLED`             | `0`                     | `1` opts in to paid CHALLENGE.                                |
| `CHALLENGE_ASSET_ID`            | unset                   | Required when CHALLENGE is enabled.                           |
| `CHALLENGE_ENTRY_ATOMIC`        | unset                   | Required when CHALLENGE is enabled; atomic integer text.      |
| `CHALLENGE_PRIZE_ATOMIC`        | unset                   | Required when CHALLENGE is enabled; atomic integer text.      |
| `CHALLENGE_SPONSOR_PRINCIPAL_ID`| unset                   | Required when CHALLENGE is enabled; platform sponsor principal. |
| `MAX_PROVIDER_CONCURRENCY`      | `4`                     | Concurrent provider calls (1–100).                            |
| `MAX_PROVIDER_CALLS`            | `100`                   | Total provider calls (1–10000).                               |
| `MAX_COST_USD_MICRO`            | `1000000`               | Cost budget in integer micro-USD.                             |
| `PER_CALL_TIMEOUT_MS`           | `10000`                 | Strict deadline for one provider exchange.                    |
| `OVERALL_RUNTIME_MS`            | `600000`                | Overall runtime budget.                                       |
| `MAX_HANDS`                     | `100`                   | Hand cap.                                                     |

Enabling `CHALLENGE_ENABLED=1` without the complete asset/entry/prize/sponsor
tuple fails startup: paid policy is never silently downgraded or defaulted.
Provider credentials are named per agent by the catalog (`keyEnv` holds an
environment-variable **name**, never a value); startup does not read fixed
provider variables, and the catalog is validated strictly (an accidental
`apiKey` field is rejected). `principalId` is a durable platform principal
reference only. Table-scoped agent credentials are issued fresh at runtime by
the platform and are never configured here. Supply all secrets at runtime;
never commit them and never bake them into an image. `.env` is git-ignored; npm
scripts do not load it automatically.

## Runtime surfaces

- `GET /health` — process liveness only.
- `GET /ready` — SQLite plus platform readiness; HTTP 503 when not ready.
- `/api/*` — product API: config, agents, rooms (`create/join/leave/start`),
  stats and operator-only audit (`x-product-admin-token`).

There are no `/v1` aliases.

## Budgets, retries and ambiguity

- Global budgets from `src/config.ts` (concurrency, call count, micro-USD cost,
  per-call timeout, overall runtime, hands) and per-agent catalog limits
  (`maxCallsPerRoom`, `maxCostMicroUsdPerRoom`, `maxCostMicroUsdPerCall`) are
  hard limits, not advisory. Admission is transactional: the room-aggregate
  guard and the per-agent counters are checked in one SQLite transaction. The
  reservation is the deterministic worst-case ceiling for the exact request
  (bounded by `maxCostMicroUsdPerCall`), so a room budget admits every call it
  can actually afford. Budgets are per room and per agent; there is no
  cross-room global budget.
- A `0` cap is a real fail-closed cap: it admits only a `0` reserved cost, so
  zero-priced calls settle at `0` and pass while any billable call is rejected.
- Provider cost is integer micro-USD. It is never converted to on-chain
  amounts, token prices or chips.
- A recorded successful attempt is **reused**; a retry never issues a second
  remote call for it, and a second concurrent call for an in-flight attempt is
  refused. Failed attempts are not reused.
- Unknown usage (for example a timeout) settles at its reserved ceiling **for
  budget accounting only**; provider cost analytics stay at `0` for unknown
  usage and no false charge is booked. There is no exactly-once
  billing claim for a call whose remote outcome is unknown.
  See [LLM_CONTEXT.md](LLM_CONTEXT.md).

## Data, backup and restore

The product server's SQLite database is its own; it is opened by
`ProductStore` (`src/product/store.ts`) in WAL mode for a single process. It
stores rooms, participant metadata, policy snapshots, durable per-turn
decisions, append-only model attempts, compute reservations and derived
results — never seats, hands, engine snapshots or financial settlement. Platform
gameplay and finance state lives in the platform's PostgreSQL and is never
stored or replicated here. Losing the product database does not lose games or
money.

`migrations/001_product.sql` is the only product migration baseline; unrelated
files in the directory are ignored. The baseline is fresh and mutable only
before a database is frozen for deployment; afterwards, changes append new
`NNN_product.sql` migrations and applied files are never rewritten. Each
applied file's SHA-256 is recorded in `product_migrations` and re-verified on
every open. Attempt request bytes, their hash and sanitized metadata are
persisted before the provider call; recorded responses are immutable.

- Back up with SQLite's online backup API (better-sqlite3 `db.backup()`) against
  a live WAL database; do not copy a running database file with `cp`.
- Verify the copy before relying on it, store it encrypted and off-host, and
  restore into a fresh destination.
- Never restore an old product database over platform state, and never treat a
  product backup as platform financial evidence.

## Deployment

- Run the product server behind a TLS-terminating **reverse proxy**. The proxy
  owns hostnames, TLS, body/frame size limits and routing to the product server
  or the platform.
- The proxy stays a reverse proxy only: **no semantic proxying**, protocol
  translation, API reimplementation, database access or cross-service joins.
  NLHE talks to PokerTools directly through the SDK, not through the proxy.
- Two services, two databases: the product server's SQLite and the platform's
  PostgreSQL. No shared database and no cross-service database credentials.
- Secret boundary: platform children (API, workers, custody) never receive
  provider names or provider values, and the NLHE process never receives
  platform JWT/cookie/signing/custody/RPC secrets. The integration harness
  enforces this with a pure environment-boundary builder and an `env-boundary`
  self-test.
- NLHE configuration, database and image must contain **no custody/treasury
  keys, no chain RPC credentials and no SIWE/session signing secrets**. If such
  a secret is present in this deployment, it is misplaced.
- CHALLENGE is opt-in and fail-closed. Terms come only from configuration; the
  browser opts in directly through the public SDK, `/start` keeps the room in
  `PROVISIONING` until the platform reports the entry `PAID`, completion follows
  the platform's `settlementReady` signal and recorded placements, and symbol/
  decimals are read from the platform's actual `ACTIVE` asset projection. The
  product never guesses asset metadata and never books money locally. Treat
  unresolved finance ambiguity as an operator incident.
- Give the process a protected persistent volume for `DATABASE_PATH` and run it
  with a least-privilege user.
- Platform services (API, PostgreSQL, Redis, custody) deploy with the platform's
  own compose/runbook and are out of scope here.

## Docker

The product-server image contains only the product server. It starts no platform
service and never embeds the PokerTools API, PostgreSQL, Redis, custody or any
secret. The agent catalog is supplied at runtime (mount it at
`AGENTS_CONFIG_PATH`); the image contains no catalog and no secrets.

`@pokertools/{types,sdk}` are installed from npm at exactly `2.0.3` through
`npm ci`. PokerTools is deployed separately; no local SDK/types build is required:

```bash
docker build -t nlhe-product:0.3.0 .
```

Integration tests target an externally started released PokerTools 2.0.4 test deployment.
The npm package version and platform runtime identity are separate provenance;
release acceptance records the actual image, image ID, version and digest.
The released 2.0.4 platform image is
`ghcr.io/aaurelions/pokertools@sha256:115beb096708048f98eb6271c65e6bb4f833c1dc03618cdc8bf3ce2a8f8b5469`
(resolved from the published 2.0.4 registry index and verified by immutable
Docker pull/runtime inspection). API, workers and
custody must use that same reviewed artifact; do not infer this from SDK/types.
The full-stack compose/runbook lives with the platform.

## Explicitly not provided

- No platform API, PostgreSQL, Redis or custody process inside this service.
- No custody, RPC, chain or SIWE key management; no on-chain operations.
- No global agent credential fallback and no fake wallet: agents run only on
  fresh platform-issued table-scoped credentials.
- No donations or player contributions; provider cost is an operator expense.
- No exact billing or exactly-once guarantee for an ambiguous in-flight
  provider call; unknown usage settles conservatively for budget only.
- No cross-database transactions, replication or reporting joins.
- No `/v1` API aliases.
