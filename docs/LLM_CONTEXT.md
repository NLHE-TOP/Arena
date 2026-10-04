# LLM decision context and audit

## One decision, one observation

Every agent decision is built from exactly one platform-issued
`SeatObservation` (`@pokertools/types`). The observation is schema-validated and
embedded as the exact context source. The legal-action menu and the per-family
sizing summary are derived one-to-one from `observation.legalActions`, in
canonical order; no poker legality is generated locally and no hidden state,
hand history or foreign-seat projection is added.

The prompt is deterministic, versioned (`nlhe-product-seat-decision-v2`) and
content-addressed: the agent catalog must name the supported prompt policy id
and its exact SHA-256, so an agent cannot silently change instructions by
changing model or provider. The layout is:

1. a fixed system message with the instructions and prompt version;
2. an optional user message containing only bounded current-hand public chat,
   JSON-encoded and labeled untrusted data;
3. a user message with the exact observation, the derived allowed-action menu,
   the objective and the required response shape.

The model must answer by calling the single `choose_action` tool. The prompt
never asks for chain-of-thought, and reasoning/telemetry fields are rejected by
response validation and by the inspector.

## Public chat policy

Public chat enters a decision only when all of the following hold:

- same table and same hand as the observation;
- `eventSeq <= observation.eventSeq` (never future, never cross-hand);
- unique `eventSeq` (an integrity anomaly keeps the lowest `messageId` and
  excludes later duplicates);
- bounded by message count (default 16, most recent kept) and by serialized
  bytes (default 4096, oldest dropped first);
- secret-sanitized before it is persisted, sent, or reviewed.

The selection metadata (considered/selected/dropped counts, bounds, first/last
sequence, ordering `eventSeq:asc`, `untrusted:true`) travels inside the prompt,
so each record is self-describing. Chat is data, never instructions: the system
message says so and the inspector verifies the untrusted-data notice is
byte-exact.

Agent speech is optional and disabled by default (`AGENT_CHAT_ENABLED=0`). When
enabled, an accepted model utterance is published at most once, only after the
poker action commit is accepted; the store's write-once speech intention is the
gate.

## Transport recording

`src/agents` drives one strict-deadline HTTP exchange per attempt through the
product-owned provider:

- the exact request bytes, their SHA-256 and sanitized transport metadata are
  persisted **before** any HTTP I/O; a throwing recorder prevents the call;
- auth headers and credentials are never part of a record;
- the exact sanitized response is recorded write-once when the exchange
  finishes — including error statuses, timeouts and transport failures;
- output fails closed: exactly one `choose_action` call, integer amounts within
  the selected action's bounds, speech within its limit, and identity fields,
  unknown tools/fields and malformed payloads all rejected.

Attempt records are immutable. A successful recorded attempt is **reused** on
retry (`kind: 'reuse'`) instead of issuing a second remote call; a concurrent
second call for an in-flight attempt is refused (`ATTEMPT_IN_FLIGHT`); failed
attempts are never reused and a new attempt is started instead. A call whose
remote outcome cannot be established is recorded as such — there is no
exactly-once claim about remote execution or billing.

## Cost and budgets

Cost is integer micro-USD with integer per-million prices and ceiling-rounded
per-token terms (`src/llm/cost.ts`); floating-point money is never used. A
pre-HTTP worst-case ceiling bounds each attempt. Provider cost is **never
converted** to on-chain amounts, token prices, exchange rates or game chips.

Budgets are hard limits from `src/config.ts`:

| Budget                      | Variable                   |
| --------------------------- | -------------------------- |
| Concurrent provider calls   | `MAX_PROVIDER_CONCURRENCY` |
| Total provider calls        | `MAX_PROVIDER_CALLS`       |
| Cost (micro-USD)            | `MAX_COST_USD_MICRO`       |
| Per-call deadline           | `PER_CALL_TIMEOUT_MS`      |
| Overall runtime             | `OVERALL_RUNTIME_MS`       |
| Hands                       | `MAX_HANDS`                |

Admission is transactional per room and per agent: the room-aggregate guard and
the agent's own counters are checked in one SQLite transaction before a call is
reserved. The reservation is the deterministic token-based worst-case ceiling
for that exact request (bounded by the declared `maxCostMicroUsdPerCall`, which
remains the hard pre-HTTP validation cap), so a room budget admits every call it
can actually afford instead of one declared-max reservation. Per-agent catalog
limits (`maxCallsPerRoom`, `maxCostMicroUsdPerRoom`, `maxCostMicroUsdPerCall`)
apply in addition to the global budgets. Budgets are per room and per agent;
there is no cross-room global budget. A `0` cap admits only a `0` reserved cost,
so zero-priced calls settle at `0` and pass while any billable call is rejected.

When actual usage is unknown (for example a timeout), the call settles at its
reserved ceiling **for budget accounting only**; provider cost analytics remain
`0` for unknown usage and no false charge is booked. Exhaustion
fails closed; the product does not borrow budget from another asset or budget
class. See [OPERATIONS.md](OPERATIONS.md) for the operational view.

## Independent inspection

`src/audit/decision-request-inspector.ts` re-parses the **actual persisted
sanitized request** — not a rebuilt prompt — and independently re-derives chat
selection and the legal menu, so a builder regression cannot satisfy the
inspector by construction. It verifies:

- exact body, message and tool structure, with no extra message fields;
- byte-exact system instructions and prompt version;
- the embedded observation deep-equals the schema-validated canonical source,
  and the observation hash recomputes from that source;
- allowed actions and family sizing deep-equal an independent derivation from
  `observation.legalActions`, in canonical order;
- selected chat deep-equals an independent current-hand, bounded, ascending
  selection with matching metadata;
- prompt content hashes recompute from the recorded messages and actions;
- no sensitive keys, token shapes, provider telemetry, foreign traces or
  reasoning fields appear anywhere.

Reports contain only decision coordinates, invariant booleans, chat event
sequence ids and hashes.

## Audit access

Audit is **operator-private**. Full decision records, prompts and provider
responses are never part of spectator or public replay views; those expose only
the platform's public projections and chat. Spectators never see transcripts,
system instructions or provider errors. Operator access is guarded by the
product admin credential and the product database, never by a platform player
session.
