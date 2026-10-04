# NLHE real-integration infrastructure (`tests/integration/`, `tests/browser/`)

Reusable, isolated, real-infrastructure acceptance for the NLHE product on top
of an externally started PokerTools 2.0.0 test deployment. Nothing here mocks
poker, auth, persistence or transport: the platform uses real PostgreSQL + Redis;
NLHE runs its actual built product process, signs real SIWE
messages with ephemeral viem wallets, and drives agent seats through a loopback
OpenAI-compatible provider or the opt-in live provider.

Owned areas: `tests/integration/**` and `tests/browser/**`. Production code is
never edited by the harness.

## Topology

```
external disposable PostgreSQL
external disposable Redis
        │
        ├─ PokerTools 2.0.0 API     (operator-started)
        ├─ PokerTools 2.0.0 workers (operator-started)
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

NLHE consumes published `@pokertools/sdk@2.0.0` and `@pokertools/types@2.0.0`.
The platform is deployed separately; NLHE never builds or migrates it.
`NLHE_IT_BUILD=never` refuses missing or stale NLHE artifacts.
`ensureNlheBuild` fails on a red product build rather than executing an old `dist`.

## Secret boundary

`tests/integration/infra/env-boundary.ts` is a pure, exported builder asserted
by `env-boundary` and `doctor`:

- Start the external platform without NLHE provider credentials. The
  platform-purpose environment builder rejects provider names and values.
- The NLHE child receives the same system allowlist plus explicitly declared
  product variables (its own provider key, minted orchestration token, agent env
  refs). Platform JWT/cookie/signing/custody/RPC secrets are rejected by name and
  by value.
- Command lines written to logs retain arguments but redact known secret values;
  process environments are never logged.

`verifyEnvironmentBoundary()` runs against a synthetic secret-bearing
environment and the real one.

## External deployment prerequisites

Set `NLHE_IT_PLATFORM_URL`, `NLHE_IT_DATABASE_URL` and `NLHE_IT_REDIS_URL`.
The operator starts PokerTools 2.0.0 API/workers and owns migration, seed and
shutdown. Use a disposable PostgreSQL database: the harness promotes its
ephemeral operator wallet through SQL. Set `NLHE_IT_POSTGRES_CONTAINER` to run
that SQL via Docker, or install `psql` for the database URL.
Configure SIWE chain 31337 and a fast test hand cadence on the external platform.

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
   unavoidable platform-owned sponsor budget fixture** performs one idempotent, balanced
  `USER_AVAILABLE -> OPERATOR` classification of exactly the claimed prize
  amount, because the platform prize reserve debits the sponsor's OPERATOR
  account while a public deposit credits USER_AVAILABLE. It creates no value,
  touches no payer balance and no entry/prize/settlement row; the actual custody
  reconciler must still match the on-chain backing after classification;
- the actual custody worker heartbeat and the actual reconciliation producer run
   on the external deployment; no seeded READY attestation;
- entry/prize/settlement behaviour runs only through the public SDK and the
  actual API; no application-database entry/settlement mutation is allowed.

Test-seam quorum injection and fabricated readiness are not accepted.

For financial scenarios, set `NLHE_IT_FINANCE_FIXTURE` to an absolute path to
the external deployment's built operator fixture module (`.js`/`.mjs`). It must
export `startFinancialTopology(input)` satisfying `FinancialTopology` in
`infra/anvil-finance.ts`: real Anvil transfers/public deposit claims, balanced
sponsor classification, ledger reads, real custody start and readiness polling.
Its optional `restartApi()` operator hook is forwarded to the test platform
handle for deposit-verifier isolation; it never restarts NLHE or imports platform
internals into the product. NLHE does not ship this platform-owned fixture.
The operator fixture must configure the external deployment's sponsor
allowlist/identity and asset registry for the supplied sponsor before paid
admission (including any operator-owned service restart that this needs).
Standard public Anvil accounts are used (never fund them with value).
NLHE contains no custody or ledger implementation. Missing fixtures fail the
financial run; they are never replaced with mocks or a skipped acceptance.

The sponsor operation must use the platform's own operator ledger mechanism:
exactly two opposite postings from the sponsor's `USER_AVAILABLE` to that same
sponsor's `OPERATOR`, under one durable request identity. Acceptance must verify
a duplicate invocation leaves balances unchanged, the journal is balanced and
sealed exactly once, and the principal's total is unchanged. Payer balances
come only from real treasury transfers and public `claimDeposit`.

## Environment knobs

| Variable | Meaning |
| --- | --- |
| `NLHE_IT_BUILD=auto\|force\|never` | NLHE build policy (never refuses missing/stale) |
| `NLHE_IT_PLATFORM_URL`, `NLHE_IT_DATABASE_URL`, `NLHE_IT_REDIS_URL`, `NLHE_IT_POSTGRES_CONTAINER` | external test topology (container name optional) |
| `NLHE_IT_FINANCE_FIXTURE` | built operator fixture for the external real financial deployment |
| `NLHE_IT_ANVIL=1` | attempt the real valueless Anvil challenge |
| `NLHE_IT_PRODUCT_ROUTES` | JSON `{catalog:[],rooms:[]}` probe override |
| `NLHE_IT_HEADED=1` | headed Chromium for the browser acceptance |

## Notes

- Run artifacts live under `tests/artifacts/integration/<runId>/` (git-ignored).
- The harness never shuts down the operator's external platform services.
- A red NLHE build or unavailable external deployment fails the run.
