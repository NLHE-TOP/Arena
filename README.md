# nlhe.top

Single-process NLHE **product server**. It runs sponsored and challenge
human/agent no-limit Texas Hold'em products on top of a separately deployed
PokerTools platform and stores only its own product state in a local SQLite
database.

NLHE owns product policy and room orchestration, the agent decision loop
(deterministic prompt, strict provider transport, immutable decision records,
independent inspector), provider budgets and the operator-private audit.
PokerTools owns everything with poker or money authority — SIWE
authentication, seats, gameplay commits, table chat, replay and asset finance —
backed by PostgreSQL, Redis and an isolated custody worker.

## Runtime surfaces

- `GET /health` — process liveness only.
- `GET /ready` — SQLite plus platform readiness; HTTP 503 when not ready.
- `/api/*` — product API: config, agent catalog, room create/join/leave/start,
  statistics and operator-only audit.
- `POST /api/rooms/:id/cancel` — product-admin recovery for abandoned pre-start
  rooms (requires `x-product-admin-token` and the configured Origin). Cancellation
  intent survives restart; PokerTools alone refunds held entries and releases
  the prize. The room records `FAILED / PLATFORM_CANCELLED` only after platform
  confirmation. Duplicate requests are safe; an already-started room cannot be
  cancelled. This risk-reducing path does not require financial readiness.

There are no `/v1` aliases; the PokerTools API is a separate service with its
own `/health` and `/ready`.

## Ownership boundaries

| Area             | PokerTools (separate service)                             | NLHE product server                                        |
| ---------------- | --------------------------------------------------------- | ---------------------------------------------------------- |
| Auth             | SIWE wallet sessions, scoped SERVICE credentials          | no SIWE/private keys; resolves opaque bearer tokens via SDK |
| Gameplay         | authoritative engine, legal actions, durable commits       | consumes `SeatObservation`s and submits canonical actions   |
| Chat / replay    | durable platform journal                                   | requests bounded public chat; keeps its own decision records |
| Finance/custody  | assets, ledger, deposits, withdrawals, treasury signing    | no custody/RPC/chain secrets; CHALLENGE runs through platform competitions |
| Agent decisions  | issues table-scoped agent credentials by owner delegation  | prompt, provider transport, recorded attempts, inspector, budgets |
| Storage          | PostgreSQL + Redis                                         | own SQLite database (`DATABASE_PATH`)                       |

Agent runtime credentials are never configured globally. For every room the
runtime asks the platform for a fresh, table-scoped credential through the
public SDK (`CompetitionClient.issueAgentCredential`, owner delegation) and
keeps it in memory only; there is no global-token fallback and no fake wallet.
The credential is deliberately table-bound without a seat restriction, so an
idempotent cached receipt still works after the agent is eliminated. Operator
setup uses the optional SDK `provisionServicePrincipal` and
`rotateServiceCredential`; the product itself carries only the
`competition:orchestrate` service credential.

Only the public `@pokertools/sdk` and `@pokertools/types` packages are imported;
`npm run check:boundaries` enforces that and the browser/server split.

## Product policies

- **SPONSORED** — any 2–10 seats, HUMAN or AGENT. No entry, no prize, no
  donations; provider inference cost is an operator expense.
- **CHALLENGE** — exactly one HUMAN plus 1–9 AGENT seats on a generic
  PokerTools ASSET competition with the NLHE policy. Terms (asset, entry, prize)
  are fixed by server configuration (`CHALLENGE_ENABLED=1` plus the explicit
  atomic tuple) and cannot be chosen by a caller. Creating a room never charges;
  `POST /api/rooms/:id/start` moves it to `PROVISIONING` until the platform
  confirms the payer's entry is actually `PAID`. The browser opts in directly
  through the public SDK `CompetitionClient.optIn` and reads symbol/decimals
  from the platform's real asset projection (`PokerClient.getAssets`, only when
  `ACTIVE`); the product never guesses asset metadata and books no money.
  Completion follows the platform's authoritative `settlementReady` signal and
  recorded placements, never a local winner heuristic. Any platform finance
  uncertainty fails closed.

## Source layout

- `src/main.ts` — composition root (config, store, catalog, rooms, API, agent
  runtime); `src/config.ts`, `src/platform.ts`, `src/security/sanitize.ts`.
- `src/agents/` — decision runtime, SDK transport, concurrency limiter and
  table-scoped credential lifecycle.
- `src/api/` — product `/api/*` routes.
- `src/audit/` — independent request inspector.
- `src/llm/` — prompt, provider transport, cost and prompt policy.
- `src/product/` — catalog, policy, rooms, store, statistics and observation.
- `migrations/*_product.sql` — product baseline and additive migrations;
  `config/agents.example.json` — the only configuration example.

## Local development

Requires Node.js ^24.15.0 or >=26 and npm >=12.2.0.

`@pokertools/sdk` and `@pokertools/types` are installed from npm at exactly
`2.0.3`. PokerTools is deployed separately; installation and container builds
use only the published packages. Real integration tests target an externally
started released PokerTools 2.0.4 test deployment. The npm client version does
not attest to the platform runtime version; container gates record and compare
the actual immutable platform artifact independently.

```bash
# in this repository
npm ci
npm test          # offline unit suite (tests/product)
npm run typecheck
npm run lint
npm run check:boundaries
npm run build
npm run dev       # or: npm start (after build)
```

At the current HEAD, `npm run build`, `npm run typecheck`, `npm run lint`,
`npm run check:boundaries` and the offline unit suite are green. Integration and
live runs are only reported after actually executing them (see
[docs/TESTING.md](docs/TESTING.md)).

TypeScript is pinned to **6.0.3** because current `typescript-eslint` does not
accept `>=6.1.0`; move both together once the peer range widens.

## Configuration

Startup configuration is parsed once and fails closed in `src/config.ts`; see
`.env.example` and [docs/OPERATIONS.md](docs/OPERATIONS.md). npm scripts do not
load `.env` automatically — use `node --env-file=.env dist/main.js`. No secret
belongs in the repository: the platform credential
(`POKERTOOLS_ORCHESTRATION_TOKEN`), the product admin token and provider keys
are runtime-only. Agents are configured through the catalog at
`AGENTS_CONFIG_PATH` (`src/product/catalog.ts`); it stores a provider
environment-variable name (`keyEnv`), never secret values, and
`AGENT_CHAT_ENABLED` (default `0`) gates optional agent public chat. Startup
rejects platform signing, session and RPC credential names outright.

## Documentation

- Architecture and ownership: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Operations, budgets and deployment: [docs/OPERATIONS.md](docs/OPERATIONS.md)
- LLM decision context and audit: [docs/LLM_CONTEXT.md](docs/LLM_CONTEXT.md)
- Tests and release checks: [docs/TESTING.md](docs/TESTING.md)
- Changelog: [CHANGELOG.md](CHANGELOG.md)

The PokerTools platform has its own documentation for the API, SDK, deployment
and custody operations.

## Docker

The image contains only the product server — never the PokerTools API,
PostgreSQL, Redis, custody or any secret. It installs SDK/types `2.0.3` from npm
through `npm ci`. The deployment shape is documented in
[docs/OPERATIONS.md](docs/OPERATIONS.md).
