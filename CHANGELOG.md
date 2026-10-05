# Changelog

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
