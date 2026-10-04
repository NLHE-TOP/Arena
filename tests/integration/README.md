# NLHE real-integration infrastructure (`tests/integration/`, `tests/browser/`)

Reusable, isolated, real-infrastructure acceptance for the NLHE product on top
of the local PokerTools platform. Nothing here mocks poker, auth, persistence or
transport: it provisions disposable PostgreSQL + Redis, builds and runs the
actual platform API/workers and the actual built NLHE process, signs real SIWE
messages with ephemeral viem wallets, and drives agent seats through a loopback
OpenAI-compatible provider or the opt-in live provider.

Owned areas: `tests/integration/**` and `tests/browser/**`. Production code is
never edited by the harness.

## Topology

```
disposable PostgreSQL (docker, random loopback port)
disposable Redis      (docker; local redis-server fallback)
        │
        ├─ platform API     node pokertools/packages/api/dist/server.js
        ├─ platform workers node pokertools/packages/api/dist/workers.js
        │
        ├─ loopback OpenAI-compatible provider (exact request validation,
        │  varied legal `choose_action` tool call, stall/error/invalid modes)
        │
        └─ NLHE product     node dist/main.js   (actual built process,
               public @pokertools/sdk + @pokertools/types only; /health + /ready;
               restartable while the platform stays up)
```

## Commands

```bash
npm run test:integration                      # focused offline smoke (not final)
tsx tests/integration/run.ts endpoints        # small public-endpoints smoke
tsx tests/integration/run.ts room-prove       # strict single 1H1A product room
tsx tests/integration/run.ts acceptance       # FINAL: all mandatory, strict
tsx tests/integration/run.ts browser          # standalone browser acceptance
tsx tests/integration/run.ts doctor           # prerequisites/capability report
tsx tests/integration/run.ts env-boundary     # secret-boundary self-test
tsx tests/integration/run.ts list             # matrix + interface reference

NLHE_LIVE_ENABLED=1 tsx tests/integration/live.ts   # opt-in PAID live room
```

`acceptance` has no PENDING path and no subset flag: every mandatory roster and
scenario either passes or the run exits non-zero. Smoke/endpoints/room-prove are
staged development commands, clearly distinct from final acceptance. The product
health surface is exactly `/health` (liveness) and `/ready` (readiness).

## Strict builds — no stale or partial dist

The local `./pokertools` source tree is the only authoritative platform runtime.
`ensurePlatformBuilds` builds every stale workspace and **throws on failure**;
there is no last-green fallback. `NLHE_IT_BUILD=never` refuses missing or stale
artifacts instead of using them. The NLHE product build is equally strict
(`ensureNlheBuild`), so a red product build fails the run rather than executing
an old `dist`.

## Secret boundary

`tests/integration/infra/env-boundary.ts` is a pure, exported builder asserted
by `env-boundary` and `doctor`:

- PokerTools children (build, prisma generate, migrate, seed, API, workers, and
  any future Anvil/custody process) receive only `PATH HOME TMPDIR TEMP
  SYSTEMROOT TZ` plus explicitly declared platform variables. Provider names and
  provider values are rejected (`OPENAI*`, provider hosts/models, API keys).
- The NLHE child receives the same system allowlist plus explicitly declared
  product variables (its own provider key, minted orchestration token, agent env
  refs). Platform JWT/cookie/signing/custody/RPC secrets are rejected by name and
  by value.
- Command lines written to logs retain arguments but redact known secret values;
  process environments are never logged.

`verifyEnvironmentBoundary()` runs against a synthetic secret-bearing
environment and the real one.

## Prisma generation lock

The platform workspace has one shared generated Prisma client. The harness
serializes `generate -> migrate -> seed -> API/workers start` under
`pokertools/.runtime/nlhe-it-prisma.lock` (stale after 10 minutes) so an
independent PokerTools tester cannot flip the provider mid-boot. Set
`NLHE_IT_SKIP_PRISMA_GENERATE=1` to assert an existing PostgreSQL generation
instead of regenerating.

## Interfaces (public only)

- SDK: `PokerClient` identity/readiness/credential lifecycle
  (`getPrincipal`, `getReadiness`, `createServiceCredential`,
  `listServiceCredentials`, `revokeServiceCredential`,
  `provisionServicePrincipal`, `rotateServiceCredential`), tables
  (`createTable`, `getTables`, `buyIn`, `getObservation`, `action`, `getChat`,
  `sendChat`, `getReplay`), `PokerSocket`, and the root `CompetitionClient`
  (`createCompetition`, `getCompetition`, `optIn`, `start`,
  `settle`, `cancel`, `issueAgentCredential`). Lifecycle bodies are empty;
  PokerTools provides durable financial and lifecycle idempotency.
- Operator infrastructure (explicit, outside the product boundary): ADMIN role
  promotion via SQL on the disposable database; canonical chip grants via
  `POST /chips/grant` validated by `@pokertools/types`. A future SDK
  `grantChips` is not required.
- Agent principals are durable SERVICE identities provisioned through
  `provisionServicePrincipal` and delegated to the orchestrator principal;
  table-scoped runtime credentials are issued by the platform competition
  surface, never minted by the harness.
- Product routes: `/health`, `/ready`, `/api/config`, `/api/agents`,
  `/api/rooms`, `/api/rooms/:id(/join|/leave|/start)`, `/api/stats`,
  `/api/audit/rooms/:id`.

## Roster matrix

`2H 10H 2A 10A 1H1A 2H2A 1H9A`, all mandatory and product-created
(SPONSORED competitions created and started by the product's own room
orchestration; agents decided by the actual NLHE runtime). The harness only
plays human seats through the public SDK and inspects persisted evidence.

Verified automatically:

- every agent decision/attempt inspected against the saved `observation_json`
  and saved `source_json.publicChat` by the independent inspector, including
  failed/aborted exchanges (all actual requests);
- humans cause zero provider requests and own zero decisions;
- replay makes zero actual requests and creates no decision/attempt records;
- at least two rooms active simultaneously;
- stale provider timeout produces bounded failed attempts without cap loosening;
- an actual NLHE process restart mid-room reuses persisted responses (no
  duplicate attempt identities, no replayed provider request);
- browser runs the real public UI path with an injected EIP-1193 wallet, real
  SIWE endpoints and a session-restoring reload (no routed fake API/WS);
- stats show agent-only model analytics with zero human provider cost.

## Live provider (opt-in, paid)

`live.ts` requires `NLHE_LIVE_ENABLED=1` and `.env`
`OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENAI_MODEL`. Caps are fixed before the
run and never loosened: calls 24, cost 50 000 micro-USD, per call 5 000 ms,
overall 120 000 ms, hands 8. Accounting uses conservative upper rates (input
200 000, output 1 000 000 micro-USD per million tokens). The model is called with
a plain forced `choose_action` tool (temperature 0, max_tokens 256); no
provider-specific reasoning parameters are sent. Reasoning tokens share the
output cap, and a missing tool call is recorded as a validation failure — never
worked around by raising caps. Once opted in, any failure (red build, missing
runtime, cap exhaustion, invalid model response) is reported as the actual FAIL;
there is no manual provider-decision fallback. Credential values are never
printed or passed to any PokerTools child.

## Financial challenge

`financial: generic NONFINANCIAL competition public contract` runs the real
create/read/start flow through `CompetitionClient`.

`financial: valueless Anvil ASSET challenge` is mandatory and fails closed until
all of the following are true:

- the PokerTools finance settle/freeze fixes and their regressions are green
  (`NLHE_IT_FINANCIAL_FINAL=1` unlocks the attempt);
- a real Anvil chain with a deployed valueless ERC20 and a platform chain
  registry, `REAL_MONEY_ENABLED=1`, `COMPETITION_PAID_ENABLED=1` and central
  `financial.state === READY` from actual chain/custody/reconciliation evidence;
- the payer is funded by an actual on-chain transfer and claims that exact
  deposit through the normal public API (`PokerClient.claimDeposit`) — no direct
  payer credit;
- after the sponsor's real on-chain transfer and public claim, a **declared,
  unavoidable sponsor budget fixture** (tests-only child importing local
  PokerTools production source) performs one idempotent, balanced
  `USER_AVAILABLE -> OPERATOR` classification of exactly the claimed prize
  amount, because the platform prize reserve debits the sponsor's OPERATOR
  account while a public deposit credits USER_AVAILABLE. It creates no value,
  touches no payer balance and no entry/prize/settlement row; the actual custody
  reconciler must still match the on-chain backing after classification;
- the actual custody worker heartbeat and the actual reconciliation producer run
  (reusing the PokerTools e2e finance helpers/config); no seeded READY
  attestation;
- entry/prize/settlement behaviour runs only through the public SDK and the
  actual API; no application-database entry/settlement mutation is allowed.

Test-seam quorum injection and fabricated readiness are not accepted.

## Environment knobs

| Variable | Meaning |
| --- | --- |
| `NLHE_IT_KEEP=1` | leave disposable containers running for inspection |
| `NLHE_IT_BUILD=auto\|force\|never` | build policy (never refuses missing/stale) |
| `NLHE_IT_SKIP_PRISMA_GENERATE=1` | assert existing PostgreSQL generation |
| `NLHE_IT_PG_IMAGE`, `NLHE_IT_REDIS_IMAGE` | override container images |
| `NLHE_IT_PLATFORM_URL`, `NLHE_IT_DATABASE_URL`, `NLHE_IT_REDIS_URL`, `NLHE_IT_POSTGRES_CONTAINER` | reuse an external topology |
| `NLHE_IT_ANVIL=1` | attempt the real valueless Anvil challenge |
| `NLHE_IT_PRODUCT_ROUTES` | JSON `{catalog:[],rooms:[]}` probe override |
| `NLHE_IT_HEADED=1` | headed Chromium for the browser acceptance |
| `NLHE_IT_AUTO_DEAL_DELAY_MS` | platform hand cadence (default 250ms) |

## Notes

- Run artifacts live under `tests/artifacts/integration/<runId>/` (git-ignored).
- The first `postgres:18-alpine` pull can take a minute; images are cached.
- A red platform/product source tree fails the run by design; finish the
  in-flight implementation before running acceptance.
