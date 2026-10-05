# Testing

## Offline unit suite and static checks

`npm test` runs `tests/product` with Vitest and needs no platform, network or
API key.

```bash
npm test               # offline unit suite (tests/product)
npm run test:coverage
npm run typecheck      # src and web
npm run lint
npm run check:boundaries
npm run build
```

At the current HEAD these commands are green: build, typecheck, lint, boundary
check and the offline unit suite. Integration and live runs are only reported
after actually executing them.

- `tests/product` covers startup configuration, the agent catalog and policy,
  room orchestration, the product store and statistics, the agent runtime, the
  decision modules (deterministic prompt construction and chat bounding,
  provider transport recording over a real loopback HTTP fake, strict response
  validation, integer micro-USD cost arithmetic), security boundaries and the
  independent request inspector.
- Provider tests use a loopback `node:http` fake and the real global `fetch`, so
  no provider key and no external egress are required.
- `check:boundaries` rejects private platform imports and server dependencies in
  browser code.
- Tests exercise the product contract only. Platform gameplay, finance and
  custody acceptance belongs to the PokerTools repository and its own harnesses.

## Real integration and acceptance

`tests/integration` targets an externally started disposable released PokerTools 2.0.3
deployment backed by real PostgreSQL and Redis. It starts the actual built NLHE
process and a loopback OpenAI-compatible provider, and drives real SIWE wallets through the
product's own room orchestration. `tests/browser` drives the real public UI with
Playwright and an injected EIP-1193 wallet. Platform behavior is never mocked.
Set `NLHE_IT_PLATFORM_URL`, `NLHE_IT_DATABASE_URL` and `NLHE_IT_REDIS_URL`;
optionally set `NLHE_IT_POSTGRES_CONTAINER` for operator SQL bootstrap.
See [the integration guide](../tests/integration/README.md) for financial fixtures.

```bash
npx tsx tests/integration/run.ts doctor       # prerequisites/capability report
npx tsx tests/integration/run.ts smoke        # focused offline smoke (staged)
npx tsx tests/integration/run.ts room-prove   # strict single 1H1A product room
npx tsx tests/integration/run.ts financial    # public competition + Anvil challenge
npx tsx tests/integration/run.ts browser      # Playwright against the real public path
npx tsx tests/integration/run.ts acceptance   # FINAL: all mandatory, strict
```

`endpoints`, `env-boundary` and `list` are additional harness helpers.

`acceptance` is strict and mandatory, with no subset flag and **no PENDING
path**: every roster and scenario either passes or the run exits non-zero.
Smoke/room-prove/financial are staged development commands, clearly distinct
from final acceptance. Verified by final acceptance:

- all seven mandatory rosters (`2H 10H 2A 10A 1H1A 2H2A 1H9A`) through the
  product's own room orchestration and the actual NLHE runtime;
- persisted attempts inspected independently against the saved observation and
  public chat (the fake audit), with zero human provider cost and zero provider
  calls for replay;
- an actual NLHE process restart that reuses persisted responses instead of
  replaying provider requests;
- browser reload/session restore against the real public path (no routed fake
  API or socket);
- the valueless Anvil ASSET challenge opt-in/payment flow.

### Provider-key and secret boundary

`tests/integration/infra/env-boundary.ts` is a pure builder asserted by the
`env-boundary` command and `doctor`:

- the external platform is started separately without NLHE provider credentials;
  the platform-purpose environment builder rejects provider names and values;
- the NLHE child receives product variables only; platform JWT/cookie/signing/
  custody/RPC secrets are rejected by name and by value;
- command lines written to logs redact known secret values, and process
  environments are never logged.

### Financial challenge

`financial` runs the real generic nonfinancial competition contract first. The
valueless Anvil ASSET challenge is mandatory and fails closed until all of the
following hold:

- the platform finance settle/freeze fixes are green (`NLHE_IT_FINANCIAL_FINAL=1`
  unlocks the attempt) and the harness runs against a real Anvil chain with a
  deployed valueless ERC20, platform chain registry, `REAL_MONEY_ENABLED=1`,
  `COMPETITION_PAID_ENABLED=1` and central `financial.state === READY` from
  actual chain/custody/reconciliation evidence (`NLHE_IT_ANVIL=1` requests it);
- the payer is funded by an actual on-chain transfer and claims that exact
  deposit through the normal public API — no direct payer credit;
- after the sponsor's real on-chain transfer and public claim, a **declared
  sponsor operator-budget classification fixture** performs one idempotent,
  balanced `USER_AVAILABLE -> OPERATOR` classification of exactly the claimed
  prize amount, because the platform prize reserve debits the sponsor's
  OPERATOR account while a public deposit credits USER_AVAILABLE. It creates no
  value, touches no payer balance and writes no entry/prize/settlement row; the
  actual custody reconciler must still match the on-chain backing after
  classification;
- the actual custody worker heartbeat and reconciliation producer run; a seeded
  READY attestation or test-seam quorum injection is not accepted.

## Live provider acceptance

### Focused external-release staging gate

The disposable container gate is separate from the full roster matrix. It uses
an external operator fixture pinned to released PokerTools 2.0.3; no platform source is
embedded in NLHE. The fixture must expose independently supervised Anvil, two
quorum processes, workers and custody, using their existing operational evidence
rather than API-style HTTP checks for workers/custody.

```bash
docker build -t nlhe-product:container-gate .
NLHE_IT_STAGING_FIXTURE=/absolute/path/to/staging-platform.mjs \
NLHE_IT_SECRET_SCANNER=/absolute/path/to/secret-check.mjs \
  npx tsx tests/integration/container-gate.ts --full
```

Each run creates fresh PostgreSQL, Redis, chain fixtures and product SQLite.
Use production rate-limit settings and the platform's production deal cadence
(5000 ms, also used in the historical 2.0.0 baseline); accelerated fixture hands
can generate an artificial load.
The product's sidecar connects directly over the staging network, keeping its
real source address distinct from host-native operator/human requests. No
forwarded-IP spoofing or rate-limit exemptions are used.
Full mode cannot skip the browser or final secret scan. It requires same-room
human/agent canonical actions, session/socket recovery, terminal state, two
active-room restarts, readiness outage/recovery without a product restart,
zero platform HTTP 429 counters, independent child supervision and cleanup.
Only a complete successful run emits `DETERMINISTIC_STAGING=PASS`. Its summary
must retain actual platform version, configured image, image ID and registry
digest (when available), plus the product image and image ID. Paid wrappers
must compare actual platform artifact identity, not just a gate run ID or PASS
flag. Historical summaries without provenance do not authorize a new paid run.
For paid eligibility, supply `NLHE_IT_TERMINAL_FOLD_SUMMARY` with the focused
terminal-FOLD summary. The full gate binds accepted FOLD, durable completion,
archive, director/continuation, terminal room, zero-429 and clean-scan evidence
to its actual platform and product artifacts. Without that proof the full gate
is not a paid authorization.
Readiness-only and `--self-test` are development checks, not release evidence.
Runtime env files and secret manifests stay outside captured artifacts and are
removed during teardown; captured logs are redacted before writing.

Paid runs remain prohibited until this full deterministic gate passes. The
live financial assertion also counts sealed, balanced entry/reserve/settlement
journals and compares the same evidence across the settlement restart.

Live acceptance is explicit opt-in and paid:

```bash
NLHE_LIVE_ENABLED=1 tsx tests/integration/live.ts  # paid SPONSORED 1H1A room
NLHE_LIVE_ENABLED=1 NLHE_IT_ANVIL=1 tsx tests/integration/live.ts --challenge  # paid valueless ASSET challenge
```

It reads the provider base URL, credential and model from the local `.env`
(general configuration only; credential values are never printed, logged or
passed to platform children) and targets the operator's OpenRouter-hosted model
(Luna). Caps are fixed before the run and can never be loosened (calls,
micro-USD cost, per-call timeout, overall runtime, hands), with conservative
upper token rates. A failure once opted in is reported as a real failure, never
as unavailable credentials.

No document in this repository may claim an integration or live suite passed
unless the run actually happened; keep the recorded command and output with the
run. Do not present a smoke or live run as platform financial acceptance.

## Docker build

The product image installs SDK/types `2.0.3` from npm through `npm ci`; no local
platform build is needed (see [OPERATIONS.md](OPERATIONS.md)):

```bash
docker build -t nlhe-product:0.3.0 .
```

The image runs only the product server and embeds no platform service or secret.
PokerTools is deployed separately and is not part of the NLHE source distribution.
