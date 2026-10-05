# Changelog

## 0.3.1 — 2026-10-06

Acceptance/evidence correlation and cleanup fix only; no NLHE
gameplay/runtime/provider policy change. The released platform is unchanged
(PokerTools 2.0.4, immutable digest
`sha256:115beb096708048f98eb6271c65e6bb4f833c1dc03618cdc8bf3ce2a8f8b5469`) and
the public SDK/types stay pinned to 2.0.3.

- Terminal evidence correlation: the durable failure packet now anchors its
  terminal diagnostics to the accepted canonical transition / completed hand
  that owns the authoritative terminal state (the last durable
  `HAND_COMPLETED` hand) instead of blindly scoping to the latest human action
  request. A later rejected action can no longer replace that anchor.
- Benign post-terminal races: a late human/browser action that the platform
  correctly rejects with its canonical terminal conflict (HTTP 409/404) while
  the room is authoritative terminal, has no committed receipt, and leaves the
  completed hand with complete durable evidence (HAND_COMPLETED, HandHistory,
  completed outbox work, terminal competition/tournament, `settlementReady`,
  and a settled CHALLENGE prize) is classified `BENIGN_POST_TERMINAL_RACE` and
  no longer turns an otherwise successful terminal run into a retained FAIL.
  A conflict before the authoritative terminal state, a request whose product
  row claims a committed receipt, a missing HAND_COMPLETED, incomplete durable
  outbox work, or an incomplete CHALLENGE financial settlement still fail
  closed and retain the topology.
- Retained-diagnostics cleanup: after evidence finalization with a genuinely
  retained topology, the harness explicitly releases its supervised local
  process fixtures (Anvil and the quorum TCP proxies, whose piped stdio pinned
  the orchestrator's event loop) so the wrapper exits naturally. Containers,
  volumes, the runtime dir, the secret manifest and the private product SQLite
  remain untouched for operator classification; no `process.exit`/self-SIGTERM
  or timeout kill is used.
- Deterministic regressions: the deterministic CHALLENGE runner now reproduces
  the exact post-terminal race on a real completed challenge (real
  server-issued pre-terminal action submitted after terminal, HTTP 409) and
  requires the packet to stay complete with `durableComplete=true` and the
  benign classification; focused unit regressions cover the benign positive and
  all fail-closed negatives, plus a natural-exit probe for the retained
  release path. No paid provider calls were made.

## 0.3.0 — 2026-10-05

**User-visible**

- Single-process NLHE product server over a separately deployed PokerTools
  platform: own SQLite product database, no custody/RPC/SIWE secrets, and the
  final surfaces `/health`, `/ready` and `/api/*` (no `/v1` aliases).
- SPONSORED: any 2–10 HUMAN/AGENT seats, no entry, no prize, no donations;
  provider cost is an operator expense.
- CHALLENGE: exactly one HUMAN + 1–9 AGENTs on a generic PokerTools ASSET
  competition with terms fixed by server configuration. The browser opts in
  directly through the public SDK, the room stays `PROVISIONING` until the
  entry is actually `PAID`, completion follows the platform's authoritative
  `settlementReady` signal, asset metadata is never guessed, and platform
  finance uncertainty fails closed.
- Optional agent public chat via `AGENT_CHAT_ENABLED` (default off), published
  at most once after an accepted commit.

**Developer**

- The agent runtime always obtains a fresh table-scoped platform credential
  (owner delegation, in-memory only): no global credential fallback and no fake
  wallet. The catalog stores a provider `keyEnv` name and a `principalId`
  reference only; optional platform SDK `provisionServicePrincipal` and
  `rotateServiceCredential` cover operator setup and rotation.
- Immutable decision attempts record the exact pre-HTTP request bytes, hash and
  sanitized metadata, with write-once responses; successful attempts are reused
  and failed attempts are not. Budget admission is transactional per room and
  per agent, a `0` cap admits only zero-priced calls, and unknown usage settles
  conservatively for budget only (no exact-billing claim).
- `migrations/001_product.sql` is the fresh product baseline, mutable only
  before deployment freeze; later changes append `NNN_product.sql` migrations
  whose SHA-256 is recorded and re-verified.
- Superseded v0.2 local infrastructure was removed. The source is
  `src/{config,main,platform,security/sanitize}.ts` and
  `src/{agents,api,audit,llm,product}`; the only configuration example is
  `config/agents.example.json`.
- Real integration harness under `tests/integration` (external disposable
  PokerTools 2.0.0 deployment, real PostgreSQL/Redis, loopback provider, valueless Anvil) and
  `tests/browser` (Playwright against the real public path), with strict
  no-PENDING final acceptance and provider-key/secret environment boundaries.
- `@pokertools/sdk` and `@pokertools/types` consume the published npm packages
  at exactly `2.0.0`. PokerTools is deployed separately. TypeScript
  stays pinned to 6.0.3 because current typescript-eslint rejects `>=6.1.0`.
- Documentation is the four durable guides (`docs/ARCHITECTURE.md`,
  `docs/OPERATIONS.md`, `docs/LLM_CONTEXT.md`, `docs/TESTING.md`); obsolete
  `docs/API.md` was removed because the platform SDK owns the API contract.

Technical readiness is not legal, regulatory or compliance approval.
