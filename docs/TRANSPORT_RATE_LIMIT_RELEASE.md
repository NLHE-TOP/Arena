# Transport / authenticated rate-limit release gate

This change is limited to request amplification and platform rate-limit identity.
No poker rules, prompts, provider caps, or custody/ledger terms are changed.

## NLHE transport invariants

- The authenticated PokerTools socket issues full canonical `SeatObservation`
  objects. Validate their schema, table, and viewer without replacing or mutating
  the object. Persist that object at the durable decision boundary.
- Both `version` and `eventSeq` must be monotonic. Ignore duplicates/reordering.
  **Neither version nor eventSeq jumps alone imply a gap.** The published
  `SocketManager` serializes notification drains but re-reads the latest full
  PostgreSQL projection; intermediate versions are deliberately not guaranteed.
  One state transition can also append multiple events, and chat advances
  eventSeq independently of state version. Accept any advancing coherent full
  snapshot directly. A changed turn at an unchanged version indicates an
  incoherent boundary and triggers coalesced REST recovery. Reconnect/rejoin
  and explicit uncertain-transport signals also request coalesced recovery.
- REST is startup, explicit synchronization, reconnect/rejoin-failure, and gap
  recovery. A five-minute inactivity watchdog is the last-resort silent-stream
  recovery boundary; ongoing valid socket delivery resets it. There is no
  five-second per-agent observation poll.
- Resolve pending durable work before considering a fresh turn. Existing stored
  successful responses, canonical requests, and receipt replay remain unchanged.
- Fetch bounded public chat only for a newly observed decision; existing
  decisions and duplicate observations do not fetch chat.

## Lifecycle request budget

`reconcileAll()` is explicitly single-flight. Room transitions and reconciliation
are serialized per room, preventing concurrent equivalent competition reads.
Explicit transitions do not wait for background cadence.

- ACTIVE: 30 seconds between completed passes (at most two background
  competition reads/minute/room). Timer dispatch can add up to five seconds of
  projection latency. Platform authority and settlement readiness are unchanged.
- Provisioning, cancellation, and required terminal durable recovery: five
  seconds between completed passes; slow work never overlaps another pass.
- Terminal rooms without pending durable work or a missing result: no polling.

Runtime attachment is also single-flight per room. If startup authentication or
socket connection fails for some agents, retain successful runtimes and retry
only missing agents on ACTIVE recovery cadence. A healthy attachment performs
no platform HTTP. Startup recovery shares the same room-operation boundary as
explicit transitions and timer reconciliation.

Before, ten agents alone generated 120 periodic observation reads/minute, plus
one REST read for each socket-triggered resync. ACTIVE lifecycle polling added
12 competition reads/minute/room. These are source-derived models, not measured
full-workload totals.

Prior production-container baseline `2026-10-04T18-25-05-779Z-7e839b`
(1H1A gate, before this patch) recorded these authoritative API counters over
74 seconds of API uptime:

| HTTP category | Count | Normalized/minute |
| --- | ---: | ---: |
| Observation GET | 104 | 84.3 |
| Chat GET | 30 | 24.3 |
| Action POST | 41 | 33.2 |
| Competition GET | 30 | 24.3 |
| Other platform HTTP | 55 | 44.6 |
| Total | 260 | 210.8 |

There were **69 HTTP 429s** (36 observation, 27 competition, 6 action).
Evidence: that run's `platform-metrics-final.txt` and
`container-gate-summary.json` under `tests/artifacts/integration/`.
These are whole-process counters including setup/probes/retries, normalized by
uptime, not steady-state rates. The old control trace did not capture all
platform requests, so a whole-platform rolling-60-second peak is unavailable.

## External platform provenance

PokerTools work starts from published `v2.0.0`, commit
`dac7df553f8eef5326043e1ffd88ef0dde003067`, in a separate external worktree.
Published 2.0.0 packages/artifacts must remain immutable. NLHE retains published
`@pokertools/sdk@2.0.0` and `@pokertools/types@2.0.0` until a verified 2.0.1
release exists; no local platform source dependency is allowed.

Published-source hook check: 2.0.0 uses the rate-limit plugin's default
`onRequest` phase and IP key, with no `trustProxy` option. The plugin appends
its route hook after existing route `onRequest` authentication; global SERVICE
resolution also runs before route hooks. Thus "always before authentication"
is not accurate for protected REST routes. The identity is nevertheless still
IP-only, and early authentication rejection can bypass that route-level
limiter. The intended correction explicitly places a coarse network hook before
credential verification and a principal application hook after verification.

The first real post-transport run (`2026-10-04T20-05-35-589Z-003e79`)
completed 1H1A in 35.7 seconds with **one agent observation REST read**, 12 chat
GETs, 12 agent action POSTs, and one competition GET. Including human-driver
traffic: observation 16, chat 12, action 26, competition 1, other 15; rolling
60-second tracked peak 70, with **zero authoritative platform 429s**.

That run was **not** an all-scenario acceptance pass. Legacy IP limiting rejected
agent 2 through 10 at 10A startup (27 `/auth/me` 429s: nine principals times three
SDK attempts). This exposed partial-runtime attachment being cached forever;
the bounded missing-agent recovery above fixes that NLHE transport-recovery
defect without restarting healthy agents. The run then crashed in the new
accounting proxy on an unhandled socket reset. Fault-injection-tested proxy
hardening was required before repeating the complete accounting matrix.

## Acceptance status

This document is not a PASS artifact. All request budgets must identify whether
they came from a simulated transport or real production-container HTTP traffic.
Required real budgets: 1H1A, 10A, 1H9A, and two simultaneous mixed rooms, including
HTTP retries, chat/actions, competition reads, other requests, rolling 60-second
peak, and 429 count.

Final acceptance requires the released platform, zero unexpected 429s with
meaningful headroom, browser reconnect, two product restarts, and platform
outage/readiness recovery. Paid live scenarios remain blocked until those
deterministic gates pass. Missing or failed gates mean
`NLHE_EXTERNAL_RELEASE=FAIL`.
