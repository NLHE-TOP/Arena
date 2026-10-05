/**
 * Stable browser UI contract for the NLHE product page.
 *
 * The acceptance and staging drivers must not depend on incidental CSS
 * structure (for example clicking the `.room-row` container after a reload,
 * which is a no-op and never opens the room). Every interactive element used
 * by a driver is addressed through an explicit `data-testid` and, where the
 * element is repeated, a stable data attribute (`data-room-name`).
 *
 * Contract:
 * - session restore: `[data-testid="wallet-chip"]` becomes visible and shows
 *   the short wallet address;
 * - open room: `[data-testid="room-row"][data-room-name="..."]` is the row and
 *   `[data-testid="room-open"]` is the only control that opens it;
 * - live table: `[data-testid="table-connection"]` carries
 *   `data-socket-status` with the exact socket state, and
 *   `[data-testid="table-version"]` shows the authoritative version;
 * - current room: `[data-testid="room-title"]` equals the opened room name.
 */
import type { Locator, Page } from 'playwright';

export const UI = {
  walletChip: '[data-testid="wallet-chip"]',
  roomList: '[data-testid="room-list"]',
  roomRow: '[data-testid="room-row"]',
  roomOpen: '[data-testid="room-open"]',
  roomTitle: '[data-testid="room-title"]',
  roomStatus: '[data-testid="room-status"]',
  roomRefresh: '[data-testid="room-refresh"]',
  tableCard: '[data-testid="table-card"]',
  tableConnection: '[data-testid="table-connection"]',
  tableVersion: '[data-testid="table-version"]',
  turnLine: '[data-testid="turn-line"]',
} as const;

const SHORT_ADDRESS = /^0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4}$/;

function escapeAttribute(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** The unique room row for an exact room name. */
export function roomRow(page: Page, roomName: string): Locator {
  return page.locator(`${UI.roomRow}[data-room-name="${escapeAttribute(roomName)}"]`);
}

/**
 * Wait for the restored signed-in projection. Returns the short address shown
 * by the wallet chip; a visible chip without an address is a failure.
 */
export async function waitForWalletSession(page: Page, timeoutMs = 25_000): Promise<string> {
  await page.waitForSelector(`${UI.walletChip}:not([hidden])`, { timeout: timeoutMs });
  const text = ((await page.locator(UI.walletChip).textContent()) ?? '').trim();
  if (!SHORT_ADDRESS.test(text)) {
    throw new Error(`wallet chip does not show a restored session address: ${text}`);
  }
  return text;
}

/**
 * Wait for the live table subscription. Uses the explicit
 * `data-socket-status` attribute, never a text prefix.
 */
export async function waitForTableConnected(page: Page, timeoutMs = 30_000): Promise<void> {
  await page.waitForFunction(
    (selector) => document.querySelector(selector)?.getAttribute('data-socket-status') === 'connected',
    UI.tableConnection,
    { timeout: timeoutMs }
  );
}

/**
 * Rendered authoritative version shape. Before the first JOIN observation the
 * product renders the placeholder `v—`, which must never parse as `v0`.
 */
const TABLE_VERSION_PATTERN = '^v(\\d+)';

/**
 * Parse the rendered table version text; null when no authoritative version is
 * present (`v—` or missing).
 */
export function parseTableVersion(text: string | null | undefined): number | null {
  const match = new RegExp(TABLE_VERSION_PATTERN).exec((text ?? '').trim());
  if (match === null) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

/**
 * True only once a real positive authoritative version is rendered. The
 * pre-JOIN placeholder `v—` (socket connected, observation not yet delivered)
 * and a missing version are not ready.
 */
export function tableVersionReady(text: string | null | undefined): boolean {
  const value = parseTableVersion(text);
  return value !== null && value > 0;
}

/**
 * Wait for the authoritative JOIN observation behind the version chip. The
 * socket reports `connected` before the server delivers the observation (the
 * placeholder is `v—`), so drivers must wait for a real positive version
 * instead of parsing the placeholder as 0. Mirrors the initial join readiness:
 * page-side observation only, no REST reads and no sleeps.
 */
export async function waitForTableVersion(page: Page, timeoutMs = 30_000): Promise<number> {
  await page.waitForFunction(
    ([selector, pattern]: readonly [string, string]) => {
      const match = new RegExp(pattern).exec((document.querySelector(selector)?.textContent ?? '').trim());
      return match !== null && Number(match[1]) > 0;
    },
    [UI.tableVersion, TABLE_VERSION_PATTERN] as const,
    { timeout: timeoutMs }
  );
  return tableVersion(page);
}

/** The authoritative table version as a number (`v0` when not yet present). */
export async function tableVersion(page: Page): Promise<number> {
  const text = ((await page.locator(UI.tableVersion).textContent()) ?? '').trim();
  return parseTableVersion(text) ?? 0;
}

/** The room name rendered as the current room. */
export async function currentRoomTitle(page: Page): Promise<string> {
  return ((await page.locator(UI.roomTitle).textContent()) ?? '').trim();
}

export async function waitForCurrentRoom(page: Page, roomName: string, timeoutMs = 20_000): Promise<void> {
  await page.waitForFunction(
    ([selector, expected]) => document.querySelector(selector)?.textContent?.trim() === expected,
    [UI.roomTitle, roomName] as const,
    { timeout: timeoutMs }
  );
}

/**
 * Open one room from the list through its explicit Open control. This is the
 * connector the staging/browser drivers must reuse; it waits for the list,
 * requires exactly one row for the name, clicks `[data-testid="room-open"]`,
 * and waits until `[data-testid="room-title"]` shows that room.
 */
export async function openRoomFromList(page: Page, roomName: string, timeoutMs = 30_000): Promise<void> {
  await page.waitForSelector(`${UI.roomList} ${UI.roomRow}`, { timeout: timeoutMs });
  const row = roomRow(page, roomName);
  const count = await row.count();
  if (count !== 1) throw new Error(`expected exactly one room row for "${roomName}", found ${count}`);
  const open = row.locator(UI.roomOpen);
  if ((await open.count()) !== 1) throw new Error(`room "${roomName}" has no explicit Open control`);
  await open.click({ timeout: timeoutMs });
  await waitForCurrentRoom(page, roomName, timeoutMs);
}

/**
 * Deterministic repro of the previous staging bug: clicking the row container
 * itself must target nothing. Drivers assert this stays a no-op (the room is
 * not opened and the table card stays hidden), then use {@link openRoomFromList}.
 */
export async function clickRoomRowContainer(page: Page, roomName: string): Promise<void> {
  const row = roomRow(page, roomName);
  if ((await row.count()) !== 1) throw new Error(`expected exactly one room row for "${roomName}"`);
  // The old staging driver clicked the row container; its center falls on the
  // non-interactive main area, so this is a deterministic no-op.
  await row.locator('.room-row-main').click();
}

// ---------------------------------------------------------------------------
// Server-issued action sizing
// ---------------------------------------------------------------------------

/**
 * Rendered action policy:
 * - `minimum` — the conservative pre-reload driver (Check, then Call, then the
 *   minimum legal Bet/Raise, Fold only last);
 * - `maximum` — the existing aggressive completion driver (max Bet/Raise,
 *   otherwise Check/Call/Fold);
 * - `fold` — deterministic fold-first driver (the first enabled Fold control),
 *   used by the external human-fold regression.
 */
export type UiActionSizing = 'minimum' | 'maximum' | 'fold';

/** One rendered server-issued control; no action is ever invented client-side. */
export interface UiActionControl {
  /** Rendered label text (`Check`, `Call (4–100)`, ...). */
  label: string;
  /** Bounded chip input bounds when this control takes an amount. */
  min: number | null;
  max: number | null;
  disabled: boolean;
}

export interface UiActionPick {
  /** Index of the existing rendered control to click. */
  index: number;
  /** Amount to fill (never outside the server bounds); omitted uses the UI default. */
  amount?: number;
}

const CHIP_LABEL = /bet|raise/i;
const CLOSING_LABEL = /check|call|fold/i;
const FOLD_LABEL = /fold/i;

/**
 * Enabled controls whose labels match this source are pickable betting actions
 * under {@link pickUiAction}; the SHOWDOWN intermission `Deal` control
 * deliberately does not match. Exported as a regex source because page-side
 * readiness predicates cannot close over module scope.
 */
export const UI_BETTING_LABEL_SOURCE = `${CHIP_LABEL.source}|${CLOSING_LABEL.source}`;

/**
 * Acceptance-only client cadence: minimum interval between SUCCESSFUL browser
 * action submissions (no product delay, no server polling). The first action
 * is immediate; afterwards the driver returns before touching the turn/DOM
 * until the window has elapsed, letting the socket/lifecycle pacing continue.
 */
export const UI_ACTION_CADENCE_MS = 2_500;

/** Pure cadence gate: true when an action submission is allowed at `now`. */
export function actionCadenceElapsed(
  lastAcceptedAt: number | null,
  now: number,
  cadenceMs: number = UI_ACTION_CADENCE_MS
): boolean {
  if (lastAcceptedAt === null) return true;
  return now - lastAcceptedAt >= cadenceMs;
}

// ---------------------------------------------------------------------------
// Post-reconnect terminal continuation contract
// ---------------------------------------------------------------------------

export interface TerminalContinuationInput {
  /** Authoritative reconnect instant; only strictly later actions count. */
  reconnectedAt: number;
  /** Accepted human canonical action response timestamps (all phases). */
  humanActionTimes: readonly number[];
  /** Same-room agent COMMITTED+SUCCEEDED count captured at reload. */
  agentCommittedAtReload: number;
  /** Same-room agent COMMITTED+SUCCEEDED count at terminal. */
  agentCommittedFinal: number;
  /** Terminal product room status. */
  roomStatus: string;
}

export type TerminalContinuationBranch =
  /** A post-reconnect human canonical action ended the room; no extra AI turn is possible. */
  | 'human-terminal-continuation'
  /** Canonical human play continued and the agent runtime also committed after reconnect. */
  | 'agent-continuation'
  /** Continuation is not proven (no post-reconnect human action, or room not terminal). */
  | 'insufficient-continuation';

export interface TerminalContinuationVerdict {
  branch: TerminalContinuationBranch;
  humanContinuedAt: number | null;
  continuedAgent: boolean;
  reason: string;
}

/**
 * Pure terminal-continuation contract. A legitimate post-reconnect human call
 * can finish the game immediately, so an additional agent COMMIT is optional
 * ONLY when the authoritative room is COMPLETE after a new accepted human
 * action. The human action must be strictly after the reconnect; terminal
 * before that is never continuation.
 */
export function classifyTerminalContinuation(
  input: TerminalContinuationInput
): TerminalContinuationVerdict {
  const humanContinuedAt =
    [...input.humanActionTimes].filter((at) => at > input.reconnectedAt).sort((left, right) => left - right)[0] ??
    null;
  const continuedAgent = input.agentCommittedFinal > input.agentCommittedAtReload;
  if (input.roomStatus !== 'COMPLETE') {
    return {
      branch: 'insufficient-continuation',
      humanContinuedAt,
      continuedAgent,
      reason: `room status ${input.roomStatus} != COMPLETE`,
    };
  }
  if (humanContinuedAt === null) {
    return {
      branch: 'insufficient-continuation',
      humanContinuedAt,
      continuedAgent,
      reason: 'no accepted human canonical action strictly after the reconnect',
    };
  }
  return {
    branch: continuedAgent ? 'agent-continuation' : 'human-terminal-continuation',
    humanContinuedAt,
    continuedAgent,
    reason: continuedAgent
      ? 'canonical human play continued and the agent committed after reconnect'
      : 'the post-reconnect human canonical action ended the room',
  };
}

function chipAmount(control: UiActionControl, sizing: UiActionSizing): number | undefined {
  return sizing === 'maximum' ? control.max ?? undefined : control.min ?? undefined;
}

/**
 * Pick one existing server-issued control from the rendered menu.
 *
 * - `maximum` (post-reconnect completion driver): the first enabled Bet/Raise
 *   chip at its maximum legal amount, otherwise the first enabled Check/Call/
 *   Fold control.
 * - `minimum` (conservative pre-reload driver): the first enabled Check, then
 *   Call, then the minimum legal Bet/Raise, and Fold only when nothing else is
 *   offered — so the human cannot force an instant all-in terminal before the
 *   agent commit/reload window exists.
 * - `fold` (deterministic fold-first driver): the first enabled Fold control
 *   only, null when the server did not issue a legal FOLD. Used to reproduce
 *   the human-fold terminal path without inventing an action.
 *
 * The returned index always refers to an existing control (the canonical
 * server-issued actionId is bound to that control by the product UI).
 */
export function pickUiAction(
  controls: readonly UiActionControl[],
  sizing: UiActionSizing
): UiActionPick | null {
  const enabled = controls
    .map((control, index) => ({ control, index }))
    .filter((entry) => !entry.control.disabled);
  const simpleLabel = (entry: { control: UiActionControl }): boolean =>
    CLOSING_LABEL.test(entry.control.label) && !CHIP_LABEL.test(entry.control.label);
  if (sizing === 'fold') {
    const fold = enabled.find(
      (entry) => FOLD_LABEL.test(entry.control.label) && !CHIP_LABEL.test(entry.control.label)
    );
    return fold ? { index: fold.index } : null;
  }
  if (sizing === 'maximum') {
    const chip = enabled.find((entry) => CHIP_LABEL.test(entry.control.label));
    if (chip) return { index: chip.index, amount: chipAmount(chip.control, sizing) };
  } else {
    for (const family of [/check/i, /call/i]) {
      const simple = enabled.find(
        (entry) => family.test(entry.control.label) && !CHIP_LABEL.test(entry.control.label)
      );
      if (simple) return { index: simple.index };
    }
    const chip = enabled.find((entry) => CHIP_LABEL.test(entry.control.label));
    if (chip) return { index: chip.index, amount: chipAmount(chip.control, sizing) };
  }
  const closing = enabled.find(simpleLabel);
  return closing ? { index: closing.index } : null;
}

/**
 * Pure readiness contract for a canonical human action: true only when the
 * rendered server-issued menu contains at least one enabled control the
 * existing picker policy can submit. The SHOWDOWN intermission DEAL menu is
 * deliberately not ready — the product renders `Your turn` for it, but DEAL is
 * not a betting action.
 */
export function uiActionReady(controls: readonly UiActionControl[], sizing: UiActionSizing): boolean {
  return pickUiAction(controls, sizing) !== null;
}

/**
 * Wait for an enabled server-issued betting control, the observable readiness
 * for a canonical human action. During the SHOWDOWN intermission the product
 * renders `Your turn` with only a DEAL control; that is not a betting turn, so
 * this wait spans the automatic deal until real betting controls arrive.
 * Polling is page-side (`waitForFunction`): no REST reads and no sleeps.
 */
export async function waitForUiActionReadiness(page: Page, timeoutMs = 60_000): Promise<void> {
  await page.waitForFunction(
    ([selector, labelSource]: readonly [string, string]) => {
      const betting = new RegExp(labelSource, 'i');
      return [...document.querySelectorAll<HTMLButtonElement>(`${selector} button`)].some(
        (button) => !button.disabled && betting.test(button.textContent ?? '')
      );
    },
    ['.legal-actions', UI_BETTING_LABEL_SOURCE] as const,
    { timeout: timeoutMs }
  );
}

/**
 * Wait for an enabled server-issued FOLD control. Used by the deterministic
 * human-fold regression: the human seat must submit a real server-issued FOLD,
 * so the driver waits across automatic deals until a turn actually offers one
 * (the SHOWDOWN DEAL intermission and a free CHECK menu are not fold turns).
 */
export async function waitForUiFoldReadiness(page: Page, timeoutMs = 60_000): Promise<void> {
  await page.waitForFunction(
    (selector: string) =>
      [...document.querySelectorAll<HTMLButtonElement>(`${selector} > button`)].some(
        (button) => !button.disabled && /^fold$/i.test((button.textContent ?? '').trim())
      ),
    '.legal-actions',
    { timeout: timeoutMs }
  );
}
