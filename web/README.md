# web/ — nlhe.top product UI

Vanilla TypeScript + Vite browser client for the nlhe.top product API and the
public `@pokertools/sdk`. It contains no poker engine, no money movement, no
authorization logic and no backend test helpers.

```bash
npx tsc -p tsconfig.web.json --noEmit   # typecheck
npx eslint web --max-warnings=0         # lint
npx vite build                          # -> dist/web (served by the product server)
npx vite                                # dev server; proxies /api -> 127.0.0.1:3001
```

## Responsibilities

- **Wallet auth** — injected EIP-1193 only. `eth_requestAccounts` → SDK
  `getNonce()` → `createSiweMessage({ domain: <API hostname>, uri: <pokerApiUrl> })`
  → `personal_sign` → `client.login({ message, signature })` →
  `client.getPrincipal()` verification. The opaque token lives in
  `sessionStorage` (`nlhe.pokerTools.token.v1`) and is restored on load.
- **Product API** — room discovery/creation/membership/start/stats via
  same-origin `/api/*`. Every request carries `Authorization: Bearer <token>`
  when signed in; the API introspects that token server-side.
- **Gameplay** — `PokerSocket.fromConfig(...).connect()/join(pokerTableId)`
  streams the authoritative masked `SeatObservation`. Actions echo the server
  `actionId` with a stable `requestId`, `turnId` and `expectedVersion`;
  `BET`/`RAISE` use only the server-issued `minAmount`/`maxAmount`.
- **Entry payment** — the product server never proxies money. The browser uses
  the root-exported `CompetitionClient` from `@pokertools/sdk` with the human's
  own token to read the real competition and to call `optIn(...)`.
- **Chat / replay** — `client.getChat()/sendChat()` and `client.getReplay()`.
  Chat has no idempotency key in the current SDK, so the composer disables
  itself while a send is in flight and never auto-retries.
- **Rendering** — all untrusted strings (room names, ids, model names, chat
  bodies, replay payloads) are inserted with `textContent`; there is no
  `innerHTML` anywhere.

## Product API contract (exact; no aliases)

Responses are parsed field-by-field; an unexpected shape fails with a readable
error. Envelopes are required exactly as shown.

```jsonc
// GET /api/config  (direct object)
{
  "pokerApiUrl": "https://poker.example.com",
  "platform": { "status": "AVAILABLE", "reason": null, "updatedAt": 0 },
  "challenge": {
    "enabled": true,
    "terms": { "assetId": "eip155:8453/erc20:0x…", "entryAtomic": "10000000",
               "prizeAtomic": "20000000", "termsVersion": "…" } // null while disabled
  }
  // An `assets` reference/placeholder list may also be present; the browser
  // deliberately ignores it (symbol/decimals come from the platform).
}

// GET /api/agents
{ "agents": [ { "id": "agent1", "name": "Agent 1", "model": "gpt-x",
                "provider": "openai", "available": true } ] }

// GET /api/rooms           -> { "rooms": [ RoomView, … ] }
// POST /api/rooms          -> { "room": RoomView }   body CreateRoomRequest
// GET  /api/rooms/:id      -> { "room": RoomView }
// POST /api/rooms/:id/join -> { "room": RoomView }   (bearer required)
// POST /api/rooms/:id/start-> { "room": RoomView }   (bearer required)

// GET /api/stats (direct object)
{ "platform": { "status": "AVAILABLE", "reason": null, "updatedAt": 0 },
  "rooms": { "total": 1, "open": 0, "running": 1, "finished": 0 },
  "games": { "total": 1, "running": 1, "finished": 0 },
  "humans": 1, "agents": 2,
  "models": [ { "agentId": "agent1", "games": 1, "wins": 1, "calls": 4,
                "inputTokens": 100, "outputTokens": 20, "costUsdMicro": 5,
                "latencyMs": 800 } ] }
```

```ts
type RoomMode = "SPONSORED" | "CHALLENGE";
type RoomStatus = "DRAFT" | "WAITING_FOR_ROSTER" | "PROVISIONING" | "ACTIVE" | "COMPLETE" | "FAILED";

interface RoomView {
  id: string;
  name: string;
  mode: RoomMode;
  status: RoomStatus;
  pokerTableId: string | null;        // backing engine table (ACTIVE/COMPLETE)
  pokerCompetitionId: string | null;  // platform competition reference
  humanCount: number;                 // desired roster, not merely joined
  agentCount: number;
  totalSeats: number;
  participants: Array<{
    id: string; kind: "HUMAN" | "AGENT"; name: string;
    address: string | null; agentId: string | null; agentModel: string | null;
    pokerPrincipalId: string; seat: number | null; joinedAt: number;
  }>;
  finance: { assetId: string; entryAtomic: string; prizeAtomic: string; termsVersion: string } | null;
  results: Array<{ participantId: string; name: string; kind: "HUMAN" | "AGENT"; finishPosition: number }> | null;
  failureReason: string | null;
  createdAt: number;
  updatedAt: number;
}

interface CreateRoomRequest {
  name: string;                       // 1..60
  mode: RoomMode;
  humanCount: number;                 // SPONSORED 1..10 (creator claims one); CHALLENGE exactly 1
  agentIds: string[];                 // CHALLENGE 1..9; SPONSORED 0..
  finance?: {                         // CHALLENGE only; forbidden for SPONSORED
    assetId: string;                  // exact operator-configured tuple
    entryAtomic: string;
    prizeAtomic: string;
    optIn: boolean;                   // must be true
  } | null;
}
```

Errors use `{ "error": CODE, "code": CODE, "message": "…" }` with a non-2xx
status; the UI surfaces `message`.

### UI rules derived from the contract

- **SPONSORED**: 2–10 total participants, humans/agents mixed; the form has no
  fee, prize, entry or payment controls at all.
- **CHALLENGE**: exactly 1 human + 1..9 agents. The form shows the
  operator-configured terms and a checkbox that only opts in to those terms —
  creating a room never charges anything. Challenge creation is disabled while
  `challenge.enabled` is false or `challenge.terms` is null.
- The platform **status** is rendered verbatim (`AVAILABLE`/`UNAVAILABLE`/
  `UNKNOWN`) and never collapsed into a boolean.
- Roster rows show `agent · <model>` versus `wallet · 0x…`; the "you" badge
  uses only verified `getPrincipal()` identity and is cosmetic.
- `pokerTableId` gates the live socket; `COMPLETE`/`FAILED` rooms keep chat and
  replay readable over HTTP.

## CHALLENGE entry flow (two-phase, explicit payment)

**Actual asset metadata.** The product server's orchestration credential cannot
read finance assets, and any config asset row is a reference/placeholder only.
The browser therefore resolves the configured `terms.assetId` against the
platform's real asset projection:

```ts
const assets = await client.getAssets();   // PokerClient, human session
const asset = assets.find((a) => a.assetId === terms.assetId) ?? null;
```

This read-only projection is cached in the UI. Money is rendered with the
actual `symbol`/`decimals` and the actual `status` (`ACTIVE`/`DEGRADED`/
`FROZEN`). When it is unavailable, amounts are shown as **explicit atomic units
with the full asset id** and **Pay entry is disabled** — no fabricated metadata
and no RPC/registry client.

1. `POST /api/rooms/:id/start` provisions the platform competition and returns
   the room as `PROVISIONING` with `pokerCompetitionId`; **no entry is charged**.
2. The UI calls `CompetitionClient.getCompetition(pokerCompetitionId)` with the
   human's own token and displays the **actual** platform terms, this wallet's
   entrant `entryState` and the competition `prizeStatus`.
3. When this wallet is a configured payer with `entryState === "PENDING"`, the
   room shows a **Pay entry** button. It is enabled only while the platform
   competition terms still equal the configured product terms and the resolved
   platform asset status is `ACTIVE`; the payment itself calls:

   ```ts
   await competitions.optIn(room.pokerCompetitionId, {
     idempotencyKey: `nlhe-entry:${room.id}:${principal.id}`,
   });
   ```

   directly against the platform (no product finance proxy). The stable key
   makes retries idempotent; `payEntry` re-reads `getAssets()` immediately
   before opting in so a stale projection cannot authorize a charge.
4. The UI then reloads the competition and calls `POST /api/rooms/:id/start`
   again; once every entry is `PAID`, the product completes provisioning and
   the room becomes `ACTIVE` with a `pokerTableId`.

SPONSORED rooms never show entry, prize or payment controls.

## SDK surface used (public packages only)

```ts
import {
  PokerClient, PokerSocket, CompetitionClient, createSiweMessage,
  formatCard, formatChips, getActivePlayer, getStreetName, getTotalPot,
  type SeatObservation, type CanonicalActionRequest, type CanonicalActionResult,
  type Competition, type ChatMessage, type ChatPage, type ReplayFrame,
} from "@pokertools/sdk";
```

- `PokerClient.getPrincipal()` verifies a restored token.
- `client.action(tableId, { requestId, turnId, expectedVersion, actionId, amount? })`
  is the only action path; `requestId` is created once per user intent and the
  UI blocks re-entry while a submission is in flight.
- `PokerSocket.fromConfig({ baseUrl, token })` owns reconnect/resubscribe.
- `CompetitionClient.getCompetition()` / `.optIn()` are the only competition
  calls; the product orchestrator credential never reaches the browser.
- `client.getChat()/sendChat()` and `client.getReplay()` never evaluate poker
  locally.
