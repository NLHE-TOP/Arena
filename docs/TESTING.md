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

`tests/integration` provisions a disposable real topology — PostgreSQL, Redis,
the actual platform API and workers, the actual built NLHE process and a
loopback OpenAI-compatible provider — and drives real SIWE wallets through the
product's own room orchestration. `tests/browser` drives the real public UI with
Playwright and an injected EIP-1193 wallet. Nothing is mocked.

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

- platform children (build, prisma generate, migrate, seed, API, workers and any
  Anvil/custody process) receive only the system allowlist plus explicitly
  declared platform variables; provider names and values (`OPENAI*`,
  `OPENROUTER*`, other provider segments, `*_API_KEY`, `*_BASE_URL`) are
  rejected;
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

The product image installs SDK/types `2.0.0` from npm through `npm ci`; no local
platform build is needed (see [OPERATIONS.md](OPERATIONS.md)):

```bash
docker build -t nlhe-product:0.3.0 .
```

The image runs only the product server and embeds no platform service or secret.
The local `pokertools/` checkout is excluded from its build context and remains
available separately for real integration tests.
