# Architecture

## Two services, two authorities

The NLHE product server is a **single Node.js process with its own SQLite
database**. It is a modular product layer, not the poker platform: it can be
built, deployed, restarted and backed up independently of any platform
internals. Its composition root is `src/main.ts`.

The **PokerTools platform** is a separate service with its own repository,
release and databases (PostgreSQL durable state, Redis disposable coordination,
an isolated treasury custody worker). PokerTools owns:

- authentication: SIWE wallet sessions and scoped SERVICE credentials;
- seat authority, gameplay commits, legal actions and engine versions;
- competitions, roster admission, entry settlement and placements;
- table chat, replay and hand history;
- asset finance and custody: assets, ledger, deposits, withdrawals, treasury
  signing and chain access.

NLHE consumes PokerTools exclusively through the public `@pokertools/sdk` and
`@pokertools/types` packages. All poker truth arrives as platform-issued
`SeatObservation`s and leaves as canonical action submissions; all money
movement happens in platform competitions and finance APIs. Importing platform
persistence, private packages or platform source is rejected by
`scripts/check-boundaries.mjs`.

## Repository layout

- `src/main.ts` — composition root; `src/config.ts`, `src/platform.ts`,
  `src/security/sanitize.ts`.
- `src/agents/` — decision runtime, SDK transport, concurrency limiter and the
  table-scoped credential lifecycle.
- `src/api/` — product `/api/*` routes; `src/audit/` — independent inspector;
  `src/llm/` — prompt, provider transport, cost, prompt policy;
  `src/product/` — catalog, policy, rooms, store, statistics, observation.
- `migrations/001_product.sql` is the only product migration baseline;
  `config/agents.example.json` is the only configuration example.
- `tests/product` (offline unit), `tests/integration` (real PostgreSQL + Anvil
  harness), `tests/browser` (Playwright against the real public path).

## Runtime surfaces

- `GET /health` — process liveness only.
- `GET /ready` — product readiness (SQLite plus platform probe); 503 when not
  ready.
- `/api/*` — product API: config, agent catalog, room create/join/leave/start,
  statistics and operator-only audit.

No `/v1` aliases exist; the platform API is a separate service.

## What the product server owns

- **Room orchestration and product policy** — `src/product/rooms.ts` and
  `src/product/policy.ts` turn a room request into durable product state and
  generic platform competition operations. Only opaque platform references
  (`pokerCompetitionId`, `pokerTableId`) are stored or exposed. Completion is
  driven by the platform's authoritative `settlementReady` signal and recorded
  platform placements; the product never applies a local winner heuristic or
  reconstructs poker state.
- **The agent decision loop and catalog** — deterministic prompt construction
  from the exact `SeatObservation` plus bounded current-hand public chat, strict
  OpenAI-compatible transport, immutable request/response records and integer
  micro-USD cost accounting, with per-agent configuration, pricing and limits in
  `src/product/catalog.ts`. See [LLM_CONTEXT.md](LLM_CONTEXT.md).
- **Agent credentials** — the runtime never holds a configured global agent
  token. For each room it obtains a fresh table-scoped credential from the
  platform (`CompetitionClient.issueAgentCredential`, owner delegation) and
  keeps it in memory only. The credential is deliberately table-bound without a
  seat restriction: the platform derives the acting seat from the authenticated
  principal, and a seat restriction would reject an idempotent cached receipt
  after the agent is eliminated. It carries observe/act scope plus chat only
  when `AGENT_CHAT_ENABLED=1`. Issuance failure fails closed: no global
  fallback, no fake wallet. Optional platform SDK `provisionServicePrincipal`
  and `rotateServiceCredential` support operator setup and rotation; the product
  itself carries only the `competition:orchestrate` service credential.
- **Budgets** — global provider concurrency, call count, cost, per-call
  timeout, overall runtime and hand limits from `src/config.ts`, plus per-agent
  catalog limits, enforced transactionally per room and per agent.
- **Operator-private audit** — the independent inspector over actual recorded
  transport requests. Spectators never see prompts, transcripts, private events
  or provider errors.

The product server must never receive custody/treasury keys, chain RPC
credentials, SIWE/session signing secrets, or access to the platform database.
`loadConfig` rejects platform signing/session/RPC credential names at startup,
and the integration environment boundary rejects provider credentials in
platform children (see [TESTING.md](TESTING.md)).

## Product policies

### SPONSORED

| Property       | Policy                                            |
| -------------- | ------------------------------------------------- |
| Seats          | any 2–10                                          |
| Controllers    | HUMAN, AGENT, or any mix                          |
| Entry          | none                                              |
| Prize          | none                                              |
| Provider cost  | operator expense                                  |
| Donations      | never accepted                                    |

### CHALLENGE

| Property       | Policy                                                     |
| -------------- | ---------------------------------------------------------- |
| Competition    | generic PokerTools ASSET competition, NLHE policy           |
| Seats          | 2–10: exactly one HUMAN plus 1–9 AGENTs                     |
| Terms          | fixed by server configuration; callers cannot choose them   |
| Payment        | browser opts in directly via `CompetitionClient.optIn`; the product only reads authoritative entry state |
| Start          | `/api/rooms/:id/start` moves the room to `PROVISIONING` until the payer's entry is actually `PAID` |
| Asset metadata | symbol/decimals come from the platform's real asset projection (`PokerClient.getAssets`, `ACTIVE` only); never guessed |
| Completion     | platform `settlementReady` and recorded placements          |
| Failure mode   | fail closed on any platform finance/ledger uncertainty      |
| Donations      | never accepted                                             |

CHALLENGE never books a compensating movement locally: if the platform cannot
confirm the asset and ledger state, the product action stops instead of
inventing an accounting outcome.

## Dependencies and packaging

- `package.json` consumes `@pokertools/types` and `@pokertools/sdk` from npm at
  exactly `2.0.0`; `npm ci` uses the registry artifacts pinned in the lockfile.
- Ordinary installation and container builds need no local platform build.
  The frozen `./pokertools` checkout remains the integration platform runtime,
  not a package dependency, and is excluded from the Docker build context.
- TypeScript stays pinned to **6.0.3** because current `typescript-eslint` does
  not accept `>=6.1.0`; move both together once the peer range widens.
- `scripts/check-boundaries.mjs` enforces public-package-only imports and that
  browser code never reaches server modules.

## Data ownership

The product server's SQLite database (`DATABASE_PATH`, opened by `ProductStore`
in `src/product/store.ts`) is its own. Rooms, participant metadata, policy
snapshots, decision records, immutable model attempts, compute reservations and
derived results belong to NLHE; gameplay, chat, replay and financial truth
belong to PokerTools' PostgreSQL. The schema deliberately holds **no seats, no
poker state and no financial settlement**.

`001_product.sql` is the only product migration baseline and may change only
before the database is frozen for a deployment; after that, changes append new
`NNN_product.sql` migrations and never rewrite applied ones. Applied migration
SHA-256 is recorded and re-verified on every open. The exact pre-HTTP request
bytes, their hash and sanitized transport metadata are persisted before the
provider call, and recorded responses are immutable. See
[OPERATIONS.md](OPERATIONS.md) for backup and deployment guidance.
