#!/usr/bin/env tsx
/**
 * Browser acceptance: the real public UI served by the actual NLHE process,
 * driven by Playwright with an injected EIP-1193 wallet whose signatures are
 * produced by a real viem account.
 *
 * No API/WS routing, no fake backend, no page-level SDK substitution: the page
 * talks to the real product and the real platform. Checks are strict — a
 * missing connect control or a failed session restore is a failure, never a
 * pending pass.
 */
import { join } from 'node:path';
import { createRunContext, Report, type RunContext } from '../integration/infra/context.js';
import { startEnvironment } from '../integration/infra/environment.js';
import { ensureNlheBuild, startNlhe, writeFakeAgentRoster } from '../integration/infra/nlhe.js';
import { ephemeralWallet, loginWallet } from '../integration/infra/wallet.js';
import { ensureOperator } from '../integration/infra/admin.js';
import { mintOrchestrationToken, productAdminToken, provisionFakeAgentPrincipals } from '../integration/infra/agents.js';
import { FIXTURE_API_KEY, FIXTURE_MODEL } from '../integration/infra/fixtures.js';
import { readRoomEvidence, type RoomEvidence } from '../integration/acceptance/evidence.js';
import {
  assertNoCardSecrets,
  buildCanonicalActionCapture,
  parseCanonicalActionResult,
  type CanonicalActionCapture,
  type CapturedCanonicalRequest,
} from '../integration/acceptance/canonical-capture.js';
import { installInjectedWallet, verifyInjectedSignature } from './wallet.js';
import {
  UI,
  actionCadenceElapsed,
  classifyTerminalContinuation,
  clickRoomRowContainer,
  currentRoomTitle,
  openRoomFromList,
  pickUiAction,
  roomRow,
  tableVersion,
  uiActionReady,
  waitForTableConnected,
  waitForTableVersion,
  waitForUiActionReadiness,
  waitForWalletSession,
  type UiActionControl,
  type UiActionSizing,
} from './ui.js';

/** One structured driver phase, emitted for standalone gates and diagnostics. */
export interface BrowserPhase {
  name: string;
  at: number;
  roomId?: string;
  tableId?: string;
  /** Same-room COMMITTED decisions backed by a SUCCEEDED provider attempt. */
  agentCommitted?: number;
  /** Successful canonical action responses observed on the page. */
  humanActions?: number;
  detail?: string;
}

export interface BrowserHumanFoldOption {
  /**
   * Resolves once the deterministic fold trigger has been observed (for
   * example the scripted provider stalls plus the real timeout worker
   * resolving the agent turn onto a new hand). The driver keeps its normal
   * aggressive play until this resolves and only then submits the first
   * server-issued FOLD. Rejection fails the terminal check.
   */
  when: () => Promise<void>;
  /**
   * Awaited after the accepted FOLD response is captured (sanitized receipt +
   * exact result observation) and BEFORE the driver continues, so diagnostics
   * always complete before the next phase. A rejection fails the terminal
   * check.
   */
  onAccepted?: (capture: CanonicalActionCapture) => void | Promise<void>;
}

export interface BrowserHumanActionExchange {
  /** Request-send order; late responses cannot replace a newer request. */
  sequence: number;
  tableId: string | null;
  request: CapturedCanonicalRequest | null;
  /** Null means the request was sent but no response has been observed. */
  status: number | null;
  captureError: 'invalid-canonical-request' | null;
}

/** Metadata only: never forward headers, raw bodies, observations or cards. */
export function captureHumanActionExchange(
  tableId: string,
  submitted: CapturedCanonicalRequest,
  status: number | null,
  sequence = 0
): BrowserHumanActionExchange {
  const identifier = (value: string): boolean => /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value);
  const valid = identifier(tableId) && identifier(submitted.requestId) &&
    identifier(submitted.turnId) && identifier(submitted.actionId) &&
    Number.isSafeInteger(submitted.expectedVersion) && submitted.expectedVersion >= 0 &&
    (submitted.amount === undefined || (Number.isSafeInteger(submitted.amount) && submitted.amount >= 0));
  return {
    sequence,
    tableId: identifier(tableId) ? tableId : null,
    request: valid ? {
      requestId: submitted.requestId,
      turnId: submitted.turnId,
      expectedVersion: submitted.expectedVersion,
      actionId: submitted.actionId,
      ...(submitted.amount !== undefined ? { amount: submitted.amount } : {}),
    } : null,
    status,
    captureError: valid ? null : 'invalid-canonical-request',
  };
}

export function selectLatestHumanActionExchange(
  current: BrowserHumanActionExchange | null,
  incoming: BrowserHumanActionExchange
): BrowserHumanActionExchange {
  if (current === null || incoming.sequence > current.sequence) return incoming;
  if (incoming.sequence < current.sequence) return current;
  return incoming.status !== null ? incoming : current;
}

export interface BrowserChecksOptions {
  context: RunContext;
  productBaseUrl: string;
  platformBaseUrl: string;
  /**
   * Read-only product-room evidence accessor. The standalone container gate
   * supplies a database path/copy; without it the mandatory same-room
   * agent-commit evidence cannot be proven and the browser acceptance fails.
   */
  getRoomEvidence?: (roomId: string) => Promise<RoomEvidence> | RoomEvidence;
  /**
   * Deterministic post-timeout FOLD mode (external human-fold regression): the
   * human plays the normal aggressive policy, then `when()` arms the first
   * accepted server-issued FOLD, captured from the real POST /action response
   * body before the flow continues.
   */
  humanFoldAfter?: BrowserHumanFoldOption;
  /** Passive evidence for the latest request, including rejection/lost response. */
  onHumanActionExchange?: (exchange: BrowserHumanActionExchange) => void;
  /** Structured phase trace (also returned in the result). */
  onPhase?: (phase: BrowserPhase) => void;
}

export interface BrowserChecksResult {
  code: number;
  failures: string[];
  /** The product room created and completed by this browser run. */
  roomId: string | null;
  tableId: string | null;
  /** Ordered phase trace with committed/action counters for independent proof. */
  phases: BrowserPhase[];
  /** Accepted canonical FOLD capture when `humanFoldAfter` was configured. */
  humanFold: CanonicalActionCapture | null;
}

export interface BrowserOptions {
  keep?: boolean;
}

const AUTH_NONCE = /\/(?:v1\/|api\/)?auth\/nonce(?:\?|$)/;
const AUTH_LOGIN = /\/(?:v1\/|api\/)?auth\/(?:login|verify)(?:\?|$)/;

/**
 * One human action through the real UI, choosing only among the rendered
 * server-issued controls. `minimum` sizes conservatively (Check/Call, else the
 * minimum legal Bet/Raise) for the pre-reload window; `maximum` keeps the
 * existing all-in completion behavior.
 *
 * Acceptance cadence: the successful-submission timestamp is checked FIRST, so
 * while the gate is closed the driver returns false without reading the turn
 * line, the controls or issuing any request — the caller's socket/lifecycle
 * wait continues. Only immediately before an actual submission does the driver
 * re-evaluate the current turn and freshly rendered controls. Returns false
 * when gated, not the human's turn, or no control is available.
 */
async function uiAction(
  page: import('playwright').Page,
  sizing: UiActionSizing,
  cadence: { lastAcceptedAt: number | null }
): Promise<boolean> {
  if (!actionCadenceElapsed(cadence.lastAcceptedAt, Date.now())) return false;
  const deadline = Date.now() + 2000;
  do {
    const turn = ((await page.locator(UI.turnLine).textContent().catch(() => '')) ?? '').trim();
    if (!turn.startsWith('Your turn')) return false;
    if (await uiActionOnce(page, sizing)) return true;
    // Turn text and legal controls may render on separate observation updates.
    // Retry only before submitting an action, never after a click.
    await page.waitForTimeout(100);
  } while (Date.now() < deadline);
  return false;
}

function parseBound(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Recover the submitted canonical action body from the observed request. The
 * receipt cross-check in `buildCanonicalActionCapture` then proves the response
 * belongs to exactly this request; a missing/damaged body fails the capture
 * instead of producing an unverifiable one.
 */
function parseSubmittedActionRequest(request: import('playwright').Request): CapturedCanonicalRequest {
  let body: unknown = null;
  try {
    body = request.postDataJSON();
  } catch {
    body = null;
  }
  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const text = (key: string): string => (typeof record[key] === 'string' ? (record[key] as string) : '');
  const integer = (key: string): number | null => {
    const value = record[key];
    return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
  };
  const amount = integer('amount');
  return {
    requestId: text('requestId'),
    turnId: text('turnId'),
    expectedVersion: integer('expectedVersion') ?? -1,
    actionId: text('actionId'),
    ...(amount !== null ? { amount } : {}),
  };
}

async function uiActionOnce(page: import('playwright').Page, sizing: UiActionSizing): Promise<boolean> {
  const turn = ((await page.locator(UI.turnLine).textContent().catch(() => '')) ?? '').trim();
  if (!turn.startsWith('Your turn')) return false;

  interface RenderedControl extends UiActionControl {
    fill?: (value: string) => Promise<void>;
    click: () => Promise<void>;
  }
  const controls: RenderedControl[] = [];
  const groups = page.locator('.legal-actions .action-group');
  const groupCount = await groups.count();
  for (let index = 0; index < groupCount; index += 1) {
    const group = groups.nth(index);
    const input = group.locator('input.amount-input');
    const button = group.locator('button');
    controls.push({
      label: (await group.locator('.action-label').textContent()) ?? '',
      min: parseBound(await input.getAttribute('min')),
      max: parseBound(await input.getAttribute('max')),
      disabled: await button.isDisabled(),
      fill: (value) => input.fill(value),
      click: () => button.click(),
    });
  }
  const simple = page.locator('.legal-actions > button');
  const simpleCount = await simple.count();
  for (let index = 0; index < simpleCount; index += 1) {
    const button = simple.nth(index);
    controls.push({
      label: (await button.textContent()) ?? '',
      min: null,
      max: null,
      disabled: await button.isDisabled(),
      click: () => button.click(),
    });
  }

  if (!uiActionReady(controls, sizing)) return false;
  const pick = pickUiAction(controls, sizing)!;
  const chosen = controls[pick.index]!;
  if (pick.amount !== undefined && chosen.fill !== undefined) {
    await chosen.fill(String(pick.amount));
  }
  await chosen.click();
  return true;
}

/**
 * Strict browser checks against an already-running product + platform.
 * Returns `code: 0` only when every check passes.
 *
 * The same-room evidence contract: the created 1H1A room must show at least
 * one agent decision COMMITTED through a SUCCEEDED provider attempt *before*
 * the active reload, and canonical play (human UI action and/or a further
 * agent commit) must continue after the reconnect until the room is terminal.
 * `getRoomEvidence` is the read-only SQLite accessor that proves it; when it
 * is absent the mandatory evidence check fails instead of passing weakly.
 */
export async function runBrowserChecks(options: BrowserChecksOptions): Promise<BrowserChecksResult> {
  const { context } = options;
  const report = new Report();
  const phases: BrowserPhase[] = [];
  const phase = (name: string, data: Omit<BrowserPhase, 'name' | 'at'> = {}): void => {
    const entry: BrowserPhase = { name, at: Date.now(), ...data };
    phases.push(entry);
    options.onPhase?.(entry);
  };
  let roomId: string | null = null;
  let tableId: string | null = null;
  let humanFold: CanonicalActionCapture | null = null;
  let humanActionEvidenceFailed = false;
  let reconnectedAt = 0;
  let agentCommittedBeforeReload = 0;
  let agentCommittedAtReload = 0;
  const committedAgentActions = (evidence: RoomEvidence): number =>
    evidence.decisions.filter(
      (decision) =>
        decision.status === 'COMMITTED' &&
        evidence.attempts.some(
          (attempt) => attempt.decision_id === decision.id && attempt.status === 'SUCCEEDED'
        )
    ).length;
  const readEvidence = async (id: string): Promise<RoomEvidence> => {
    if (!options.getRoomEvidence) {
      throw new Error(
        'mandatory same-room agent-commit evidence requires options.getRoomEvidence(roomId) (read-only product SQLite accessor)'
      );
    }
    return options.getRoomEvidence(id);
  };
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: process.env.NLHE_IT_HEADED !== '1' });
  try {
    const page = await browser.newPage();
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => pageErrors.push(error.message));

    const wallet = ephemeralWallet();
    const nonceRequests: string[] = [];
    const loginRequests: string[] = [];
    const failedResponses: string[] = [];
    const rateLimitedResponses: Array<{ url: string; retryAfter: string | null }> = [];
    const successfulHumanActions: Array<{ at: number; url: string }> = [];
    const actionConflicts: Array<{ url: string; version: string; notice: string }> = [];
    const pageErrors: string[] = [];
    // Acceptance client cadence: timestamp of the last successfully accepted
    // browser action submission (2xx canonical action response).
    const uiCadence: { lastAcceptedAt: number | null } = { lastAcceptedAt: null };
    let roomReads = 0;
    // One-shot capture waiter, armed immediately before a FOLD submission and
    // settled by the next accepted action response (the driver submits no other
    // action while armed).
    let pendingFoldCapture: {
      resolve: (capture: CanonicalActionCapture) => void;
      reject: (error: unknown) => void;
    } | null = null;
    const humanRequestSequences = new WeakMap<import('playwright').Request, number>();
    let nextHumanRequestSequence = 0;
    const recordHumanActionExchange = (request: import('playwright').Request, status: number | null): void => {
      if (!options.onHumanActionExchange || request.method() !== 'POST') return;
      const match = /^\/tables\/([^/]+)\/action$/.exec(new URL(request.url()).pathname);
      if (!match) return;
      const sequence = humanRequestSequences.get(request) ?? ++nextHumanRequestSequence;
      humanRequestSequences.set(request, sequence);
      const exchange = captureHumanActionExchange(match[1]!, parseSubmittedActionRequest(request), status, sequence);
      if (exchange.captureError !== null) humanActionEvidenceFailed = true;
      try {
        options.onHumanActionExchange(exchange);
      } catch {
        // An evidence callback must not create an unhandled Playwright event
        // exception, nor turn a damaged capture into a successful gate.
        humanActionEvidenceFailed = true;
      }
    };
    page.on('request', (request) => {
      recordHumanActionExchange(request, null);
      const url = request.url();
      if (AUTH_NONCE.test(url)) nonceRequests.push(url);
      if (AUTH_LOGIN.test(url)) loginRequests.push(url);
    });
    page.on('response', (response) => {
      recordHumanActionExchange(response.request(), response.status());
      const url = response.url();
      if (response.status() === 429) {
        rateLimitedResponses.push({ url, retryAfter: response.headers()['retry-after'] ?? null });
      }
      if (
        response.request().method() === 'GET' &&
        /^\/api\/rooms\/[^/]+$/.test(new URL(url).pathname)
      ) {
        roomReads += 1;
      }
      if (
        response.status() >= 200 &&
        response.status() < 300 &&
        response.request().method() === 'POST' &&
        /\/tables\/[^/]+\/action(?:\?|$)/.test(url)
      ) {
        const at = Date.now();
        successfulHumanActions.push({ at, url });
        // Successful submissions only: a 409/race does not consume the cadence.
        uiCadence.lastAcceptedAt = at;
        if (pendingFoldCapture !== null) {
          // One-shot: only the accepted response for the action submitted while
          // armed is captured. The hook is awaited before the waiter resolves,
          // so the driver can never continue past unfinished diagnostics.
          const waiter = pendingFoldCapture;
          pendingFoldCapture = null;
          const submitted = parseSubmittedActionRequest(response.request());
          void response
            .json()
            .then(async (payload) => {
              const result = parseCanonicalActionResult(payload);
              const capture = buildCanonicalActionCapture({
                family: 'FOLD',
                request: submitted,
                result,
                acceptedAt: at,
              });
              assertNoCardSecrets('browser fold capture', capture);
              humanFold = capture;
              await options.humanFoldAfter?.onAccepted?.(capture);
              return capture;
            })
            .then(waiter.resolve, waiter.reject);
        }
      }
      if (response.status() === 409 && /\/tables\/[^/]+\/action(?:\?|$)/.test(url)) {
        // Documented canonical action race (stale turn/version). The page must
        // still handle it and refresh its authoritative state.
        void page
          .evaluate(() => ({
            version: (document.querySelector('#tableVersion')?.textContent ?? '').trim(),
            notice: (document.querySelector('#noticeText')?.textContent ?? '').trim(),
          }))
          .then((snapshot) => actionConflicts.push({ url, ...snapshot }))
          .catch(() => actionConflicts.push({ url, version: '', notice: '' }));
        return;
      }
      if (response.status() >= 400) {
        void response
          .text()
          .then((text) => failedResponses.push(`${response.status()} ${url} ${text.slice(0, 200)}`))
          .catch(() => failedResponses.push(`${response.status()} ${url}`));
      }
    });

    await installInjectedWallet(page, wallet, { chainId: 31337 });

    const response = await page.goto(options.productBaseUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await report.check('browser: real NLHE-served UI responds with HTML', async () => {
      if (!response || !response.ok()) throw new Error(`HTTP ${response?.status() ?? 'no response'}`);
      const contentType = response.headers()['content-type'] ?? '';
      if (!contentType.includes('text/html')) throw new Error(`unexpected content-type ${contentType}`);
      const html = await page.content();
      if (!/<html/i.test(html)) throw new Error('page did not render HTML');
    });

    await report.check('browser: injected EIP-1193 provider returns the wallet account', async () => {
      const accounts = (await page.evaluate(async () => {
        const ethereum = (window as unknown as { ethereum: { request: (args: unknown) => Promise<unknown> } }).ethereum;
        return ethereum.request({ method: 'eth_requestAccounts' });
      })) as string[];
      if (!Array.isArray(accounts) || accounts[0]?.toLowerCase() !== wallet.address.toLowerCase()) {
        throw new Error(`unexpected accounts: ${JSON.stringify(accounts)}`);
      }
    });

    await report.check('browser: injected provider signs a valid EIP-191 message', async () => {
      const message = `nlhe browser acceptance ${context.runId}`;
      const signature = (await page.evaluate(async (payload: string) => {
        const ethereum = (window as unknown as { ethereum: { request: (args: unknown) => Promise<unknown> } }).ethereum;
        const address = (window as unknown as { __nlheWalletAddress?: string }).__nlheWalletAddress ?? '';
        return ethereum.request({ method: 'personal_sign', params: [payload, address] });
      }, message)) as string;
      if (typeof signature !== 'string' || !/^0x[0-9a-f]+$/i.test(signature)) {
        throw new Error('provider returned no signature');
      }
      if (!(await verifyInjectedSignature(wallet, message, signature))) {
        throw new Error('signature did not verify against the wallet address');
      }
    });

    await report.check('browser: reconnect returns the account without a new approval', async () => {
      await page.reload({ waitUntil: 'domcontentloaded' });
      const accounts = (await page.evaluate(async () => {
        const ethereum = (window as unknown as { ethereum: { request: (args: unknown) => Promise<unknown> } }).ethereum;
        return ethereum.request({ method: 'eth_accounts' });
      })) as string[];
      if (!Array.isArray(accounts) || accounts[0]?.toLowerCase() !== wallet.address.toLowerCase()) {
        throw new Error(`account was not restored after reload: ${JSON.stringify(accounts)}`);
      }
    });

    const connectControl = page
      .locator('button, a, [role="button"]')
      .filter({ hasText: /connect|sign in|wallet|login/i })
      .first();
    const hasConnect = (await connectControl.count()) > 0;
    await report.check('browser: public UI exposes a wallet connect control', async () => {
      if (!hasConnect) throw new Error('no discoverable connect/sign-in control in the real UI');
    });

    if (hasConnect) {
      await report.check('browser: UI wallet login reaches real SIWE nonce + login endpoints', async () => {
        // The real UI keeps Connect disabled until its config projection loads.
        await page
          .waitForFunction(
            () => {
              const button = document.querySelector('#connectBtn') as HTMLButtonElement | null;
              return button !== null && !button.disabled;
            },
            undefined,
            { timeout: 30_000 }
          )
          .catch(async () => {
            const notice = await page.locator('#noticeText').textContent().catch(() => null);
            throw new Error(`connect control never became enabled (notice: ${notice ?? 'none'})`);
          });
        await connectControl.click({ timeout: 10_000 });
        const deadline = Date.now() + 25_000;
        while (Date.now() < deadline && nonceRequests.length === 0) {
          await page.waitForTimeout(250);
        }
        if (nonceRequests.length === 0) {
          throw new Error('no SIWE nonce request observed after clicking connect');
        }
        while (Date.now() < deadline && loginRequests.length === 0) {
          await page.waitForTimeout(250);
        }
        if (loginRequests.length === 0) {
          throw new Error('no login request observed after the nonce request');
        }
        // A request is not a completed login. Wait for the public signed-in
        // projection (token stored and principal loaded) before reloading.
        await waitForWalletSession(page);
      });

      await report.check('browser: reload restores the signed-in session without a new nonce', async () => {
        const noncesBefore = nonceRequests.length;
        await page.reload({ waitUntil: 'domcontentloaded' });
        const restored = await waitForWalletSession(page);
        const expected = `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}`;
        if (restored.toLowerCase() !== expected.toLowerCase()) {
          throw new Error(`wallet chip restored ${restored}, expected ${expected}`);
        }
        if (nonceRequests.length > noncesBefore) {
          throw new Error('reload requested a new SIWE nonce instead of restoring the session');
        }
      });

      if (loginRequests.length === 0) {
        report.skip('browser ui lifecycle', 'requires a successful UI wallet login');
      } else {
        const roomName = `ui-${context.runId}`;
        let roomCompleted = false;

        await report.check('browser ui: create + start SPONSORED 1H1A through real controls', async () => {
          // The real UI keeps the create form inside a collapsed <details>.
          const createDetails = page.locator('details.create');
          const isOpen = await createDetails.evaluate((element) => (element as HTMLDetailsElement).open);
          if (!isOpen) await createDetails.locator('summary').click();
          await page.waitForSelector('#createMode', { state: 'visible' });
          await page.selectOption('#createMode', 'SPONSORED');
          await page.fill('#createName', roomName);
          await page.fill('#sponsoredHumans', '1');
          const agentOption = page.locator('#sponsoredAgents option:not([disabled])').first();
          if ((await agentOption.count()) === 0) throw new Error('no selectable agent in #sponsoredAgents');
          const agentId = await agentOption.getAttribute('value');
          if (!agentId) throw new Error('#sponsoredAgents option has no value');
          await page.selectOption('#sponsoredAgents', [agentId]);
          const createEnabled = await page
            .waitForFunction(
              () => {
                const button = document.querySelector('#createBtn') as HTMLButtonElement | null;
                return button !== null && !button.disabled;
              },
              undefined,
              { timeout: 15_000 }
            )
            .then(() => true)
            .catch(() => false);
          if (!createEnabled) {
            const note = (await page.locator('#createNote').textContent()) ?? '';
            const walletChipHidden = await page.locator('#walletChip').isHidden();
            throw new Error(
              `create button stayed disabled (note: ${note}; walletChipHidden=${walletChipHidden}; failed: ${failedResponses.slice(-3).join(', ')})`
            );
          }
          await page.click('#createBtn');
          await page.waitForSelector('#roomCard:not([hidden])', { timeout: 20_000 });
          await page.waitForFunction(
            (name) => document.querySelector('#roomTitle')?.textContent?.includes(name) === true,
            roomName,
            { timeout: 20_000 }
          );
          await page.waitForFunction(
            () => {
              const button = document.querySelector('#startRoomBtn') as HTMLButtonElement | null;
              return button !== null && !button.disabled;
            },
            undefined,
            { timeout: 20_000 }
          );
          await page.click('#startRoomBtn');
          await page.waitForFunction(
            (selector) => document.querySelector(selector)?.textContent?.trim() === 'ACTIVE',
            UI.roomStatus,
            { timeout: 60_000 }
          );
          const created = await page.evaluate(async (name) => {
            const response = await fetch('/api/rooms');
            const payload = (await response.json()) as {
              rooms?: Array<{ id: string; name: string; pokerTableId: string | null }>;
            };
            const room = payload.rooms?.find((candidate) => candidate.name === name) ?? null;
            return room === null ? null : { id: room.id, tableId: room.pokerTableId };
          }, roomName);
          if (created === null || created.tableId === null) {
            throw new Error('created room has no product id/pokerTableId');
          }
          roomId = created.id;
          tableId = created.tableId;
          phase('room-active', { roomId, tableId });
        });

        await report.check('browser ui: live masked seat observation via page SDK socket', async () => {
          await page.waitForSelector(`${UI.tableCard}:not([hidden])`, { timeout: 30_000 });
          await waitForTableConnected(page);
          await page.waitForFunction(
            () => document.querySelectorAll('#seats .seat').length >= 2,
            undefined,
            { timeout: 30_000 }
          );
          const versionText = (await page.locator(UI.tableVersion).textContent()) ?? '';
          if (!/^v\d+/.test(versionText.trim())) throw new Error(`table version not live: ${versionText}`);
          const turnText = (await page.locator(UI.turnLine).textContent()) ?? '';
          if (!/Your turn|Waiting for the server/.test(turnText)) {
            throw new Error(`unexpected turn line: ${turnText}`);
          }
        });

        await report.check('browser ui: canonical human action accepted, version advances', async () => {
            // Observable readiness, not just the `Your turn` text: the SHOWDOWN
            // intermission renders `Your turn` with only a DEAL control, which is
            // not a betting turn. Wait for an enabled server-issued betting
            // control pickable under the existing uiAction policy before sizing
            // the baseline version this action must advance.
            await waitForUiActionReadiness(page, 60_000);
            const before = await tableVersion(page);
            // Conservative minimum-sized canonical play before the evidence wait:
            // the human stays in the hand without risking an all-in bust that
            // would end the room before the active reload. Post-reload play uses
            // the existing maximum-size completion driver.
            const acted = await uiAction(page, 'minimum', uiCadence);
            if (!acted) throw new Error('no server-issued legal action control was available for the human turn');
            await page.waitForFunction(
              (args) => {
                const text = document.querySelector(args.selector)?.textContent ?? 'v0';
                return Number(text.replace(/\D/g, '')) > args.previous;
              },
              { selector: UI.tableVersion, previous: before },
              { timeout: 30_000 }
            );
            const notice = (await page.locator('#noticeText').textContent()) ?? '';
            if (/failed|rejected|illegal|error/i.test(notice)) throw new Error(`action surfaced an error notice: ${notice}`);
          });

        await report.check('browser ui: agent canonical action committed before reload', async () => {
          if (roomId === null || tableId === null) throw new Error('room id/table id unavailable');
          const deadline = Date.now() + 60_000;
          let committed = 0;
          let evidence: RoomEvidence | null = null;
          while (Date.now() < deadline) {
            // Keep the human seat on conservative minimum play until the actual
            // agent commit is observed; the room must stay active through it.
            await uiAction(page, 'minimum', uiCadence);
            evidence = await readEvidence(roomId);
            committed = committedAgentActions(evidence);
            if (committed > 0) break;
            await page.waitForTimeout(500);
          }
          if (evidence === null || committed === 0) {
            throw new Error('no agent COMMITTED canonical action with a SUCCEEDED provider attempt before reload');
          }
          if (evidence.room.status === 'COMPLETE' || evidence.room.status === 'FAILED') {
            throw new Error(
              'room reached terminal before the active reload; post-reconnect continuation cannot be proven'
            );
          }
          if (evidence.room.id !== roomId) {
            throw new Error(`evidence room ${evidence.room.id} != browser room ${roomId}`);
          }
          if (evidence.room.table_id !== tableId) {
            throw new Error(`evidence table ${evidence.room.table_id ?? 'null'} != browser table ${tableId}`);
          }
          agentCommittedBeforeReload = committed;
          phase('agent-committed-before-reload', { roomId, tableId, agentCommitted: committed });
        });

        await report.check('browser ui: chat appears in UI and in the platform chat stream', async () => {
          const body = `ui-chat-${context.runId}`;
          await page.fill('#chatInput', body);
          await page.click('#chatSendBtn');
          await page.waitForFunction(
            (expected) =>
              [...document.querySelectorAll('#chatLog .chat-body')].some((node) => node.textContent === expected),
            body,
            { timeout: 20_000 }
          );
          if (tableId === null) throw new Error('table id unavailable for platform chat assertion');
          const observer = await loginWallet(options.platformBaseUrl, ephemeralWallet());
          const page1 = await observer.client.getChat(tableId, { limit: 50 });
          if (!page1.messages.some((message) => message.body === body)) {
            throw new Error('chat message missing from the platform chat stream');
          }
        });

        await report.check('browser ui: reload restores session/current room/live socket; row click alone is a no-op', async () => {
          if (tableId === null || roomId === null) throw new Error('room id/table id unavailable');
          const noncesBefore = nonceRequests.length;
          const roomReadsBefore = roomReads;
          await page.reload({ waitUntil: 'domcontentloaded' });
          const restored = await waitForWalletSession(page);
          if (nonceRequests.length > noncesBefore) {
            throw new Error('reload requested a new SIWE nonce instead of restoring the session');
          }
          if (await page.locator('#connectBtn').isVisible()) {
            throw new Error('connect control is still visible after session restore');
          }
          // The real UI does not persist the selected room: re-open it from the
          // room list, which is the public reconnect path.
          await page.waitForSelector(`${UI.roomList} ${UI.roomRow}`, { timeout: 30_000 });
          if ((await roomRow(page, roomName).count()) !== 1) {
            throw new Error('room missing from the room list after reload');
          }
          // Deterministic repro of the previous staging bug: the old driver
          // clicked the row container, which is a no-op and never opened the
          // room (no room read, no socket). Only the explicit Open control may.
          await clickRoomRowContainer(page, roomName);
          await page.waitForTimeout(400);
          if (roomReads !== roomReadsBefore) {
            throw new Error('clicking the room row container issued a room read; only Open may open the room');
          }
          if (await page.locator(UI.tableCard).isVisible()) {
            throw new Error('clicking the room row container opened the table card');
          }
          await openRoomFromList(page, roomName);
          if (roomReads <= roomReadsBefore) {
            throw new Error('Open did not read the current room from the product');
          }
          if ((await currentRoomTitle(page)) !== roomName) {
            throw new Error('current room is not the reloaded room');
          }
          await waitForTableConnected(page);
          // Strict continuation boundary: the reconnect is authoritative once
          // the live socket is connected and the current room is rendered.
          reconnectedAt = Date.now();
          // The socket reports `connected` before the JOIN observation arrives,
          // so the version placeholder (`v—`, parsed as 0) can still be
          // rendered here. Wait for the same authoritative version/seat
          // readiness the initial join requires before reading the version.
          await waitForTableVersion(page);
          await page.waitForFunction(
            () => document.querySelectorAll('#seats .seat').length >= 2,
            undefined,
            { timeout: 30_000 }
          );
          const version = await tableVersion(page);
          if (version <= 0) throw new Error(`table version not live after reconnect: v${version}`);
          await page.waitForFunction(
            (expected) =>
              [...document.querySelectorAll('#chatLog .chat-body')].some((node) => node.textContent === expected),
            `ui-chat-${context.runId}`,
            { timeout: 20_000 }
          );
          const duplicates = await page.locator('#chatLog .chat-body', { hasText: `ui-chat-${context.runId}` }).count();
          if (duplicates > 1) throw new Error(`chat message duplicated after reconnect: ${duplicates}`);
          const evidence = await readEvidence(roomId);
          agentCommittedAtReload = committedAgentActions(evidence);
          if (agentCommittedAtReload < agentCommittedBeforeReload) {
            throw new Error('agent commits regressed across the reconnect');
          }
          phase('reload-reconnect', {
            roomId,
            tableId,
            agentCommitted: agentCommittedAtReload,
            humanActions: successfulHumanActions.length,
            detail: `version=v${version} wallet=${restored} reconnectedAt=${reconnectedAt}`,
          });
        });

        await report.check('browser ui: aggressive play completes room and UI shows terminal results', async () => {
          if (roomId === null || tableId === null) throw new Error('room id/table id unavailable');
          const foldOption = options.humanFoldAfter ?? null;
          // Arm the deterministic fold trigger in the background: the driver
          // keeps the existing aggressive policy until it resolves, then the
          // first server-issued FOLD is submitted and captured before play
          // continues (the accepted hook is awaited by the capture).
          let foldTriggerArmed = false;
          let foldTriggerError: unknown = null;
          if (foldOption !== null) {
            void foldOption.when().then(
              () => {
                foldTriggerArmed = true;
              },
              (error: unknown) => {
                foldTriggerError = error;
              }
            );
          }
          const submitFoldAndCapture = async (): Promise<CanonicalActionCapture | null> => {
            if (humanFold !== null) return humanFold;
            if (!actionCadenceElapsed(uiCadence.lastAcceptedAt, Date.now())) return null;
            let resolveCapture!: (capture: CanonicalActionCapture) => void;
            let rejectCapture!: (error: unknown) => void;
            const promise = new Promise<CanonicalActionCapture>((resolve, reject) => {
              resolveCapture = resolve;
              rejectCapture = reject;
            });
            // Also awaited by this function; the no-op catch prevents an
            // unhandled rejection when the bounded wait wins the race.
            promise.catch(() => undefined);
            pendingFoldCapture = { resolve: resolveCapture, reject: rejectCapture };
            const acted = await uiAction(page, 'fold', uiCadence);
            if (!acted) {
              pendingFoldCapture = null;
              return null;
            }
            const accepted = await Promise.race<CanonicalActionCapture | null>([
              promise,
              page.waitForTimeout(15_000).then(() => null),
            ]);
            pendingFoldCapture = null;
            if (accepted === null) {
              // The fold request was actually submitted (a rendered control was
              // clicked) but its accepted response never arrived. Continuing the
              // normal aggressive policy here would violate the fold boundary:
              // stop play with a bounded capture failure instead. The durable
              // operator receipt (recovered before teardown) is the fallback.
              throw new Error(
                'the FOLD request was submitted but no accepted canonical response was captured within 15000ms'
              );
            }
            return accepted;
          };
          const deadline = Date.now() + 180_000;
          let status = '';
          let lastRefresh = Date.now();
          const refreshIntervalMs = 15_000;
          while (Date.now() < deadline) {
            status = ((await page.locator(UI.roomStatus).textContent()) ?? '').trim();
            if (status === 'COMPLETE' || status === 'FAILED') break;
            const terminalNotice = (await page.locator('#roomNote').textContent()) ?? '';
            if (/failed/i.test(terminalNotice)) throw new Error(`room reported failure: ${terminalNotice}`);
            if (foldTriggerError !== null) {
              throw foldTriggerError instanceof Error
                ? foldTriggerError
                : new Error(String(foldTriggerError));
            }
            if (foldOption !== null && foldTriggerArmed && humanFold === null) {
              const accepted = await submitFoldAndCapture();
              if (accepted !== null) {
                if (accepted.family !== 'FOLD' || accepted.receipt.tableId !== tableId) {
                  throw new Error(
                    `captured fold family/table mismatch: ${accepted.family}/${accepted.receipt.tableId}`
                  );
                }
                phase('human-fold', {
                  roomId: roomId ?? undefined,
                  tableId,
                  humanActions: successfulHumanActions.length,
                  detail: `requestId=${accepted.receipt.requestId} handId=${accepted.observation.state.handId} eventSeq=${accepted.receipt.eventSeq}`,
                });
              } else {
                // No server-issued FOLD on this turn: keep the normal
                // aggressive policy and try again on the next human turn.
                await uiAction(page, 'maximum', uiCadence);
              }
            } else {
              await uiAction(page, 'maximum', uiCadence);
            }
            if (Date.now() - lastRefresh >= refreshIntervalMs) {
              lastRefresh = Date.now();
              // The product re-reads the room projection on demand. Pace the
              // refresh at a socket lifecycle boundary; between refreshes the
              // driver acts only on authoritative socket observations.
              await page.click(UI.roomRefresh, { timeout: 5_000 }).catch(() => undefined);
              await page
                .waitForFunction(
                  (selector) =>
                    document.querySelector(selector)?.getAttribute('data-socket-status') === 'connected',
                  UI.tableConnection,
                  { timeout: 15_000 }
                )
                .catch(() => undefined);
            }
            await page.waitForTimeout(250);
          }
          if (foldOption !== null && humanFold === null) {
            throw new Error(
              `the deterministic fold trigger ${
                foldTriggerArmed ? 'resolved' : 'never resolved'
              } without an accepted canonical FOLD`
            );
          }
          if (status !== 'COMPLETE') throw new Error(`room did not complete through the UI (status ${status})`);
          const results = (await page.locator('#results').textContent()) ?? '';
          if (!/\d/.test(results)) throw new Error('terminal results are not rendered in #results');
          // Same-room canonical continuation after the active reconnect: a NEW
          // accepted human action strictly after the reconnect is mandatory.
          // An additional agent COMMIT is optional ONLY when the authoritative
          // room is COMPLETE after that human action (a legitimate final human
          // call can end the game immediately). If the room were still
          // non-terminal the loop above kept waiting for real agent activity.
          const evidence = await readEvidence(roomId);
          const agentCommittedFinal = committedAgentActions(evidence);
          if (evidence.room.id !== roomId || evidence.room.table_id !== tableId) {
            throw new Error('terminal evidence does not belong to the browser room/table');
          }
          if (evidence.room.status !== 'COMPLETE') {
            throw new Error(`product SQLite room status ${evidence.room.status} != COMPLETE`);
          }
          if (evidence.decisions.every((decision) => decision.status !== 'COMMITTED')) {
            throw new Error('no durable COMMITTED agent decision in the browser room');
          }
          const continuation = classifyTerminalContinuation({
            reconnectedAt,
            humanActionTimes: successfulHumanActions.map((entry) => entry.at),
            agentCommittedAtReload,
            agentCommittedFinal,
            roomStatus: evidence.room.status,
          });
          if (continuation.branch === 'insufficient-continuation') {
            throw new Error(
              `post-reconnect continuation not proven: ${continuation.reason} (humanContinuedAt=${
                continuation.humanContinuedAt ?? 'none'
              }; agentCommitted ${agentCommittedAtReload}->${agentCommittedFinal}; reconnectedAt=${reconnectedAt})`
            );
          }
          phase('terminal', {
            roomId,
            tableId,
            agentCommitted: agentCommittedFinal,
            humanActions: successfulHumanActions.length,
            detail: `branch=${continuation.branch} results=${results.trim().slice(0, 80)}`,
          });
          if (continuation.branch === 'human-terminal-continuation') {
            // Explicit branch proof (never a silent pass or timeout relaxation):
            // the post-reconnect human canonical action is what ended the room,
            // so no additional AI turn was possible by game state.
            phase('human terminal continuation', {
              roomId,
              tableId,
              agentCommitted: agentCommittedFinal,
              humanActions: successfulHumanActions.length,
              detail: `humanContinuedAt=${continuation.humanContinuedAt} agentCommitted ${agentCommittedAtReload}->${agentCommittedFinal} roomStatus=${evidence.room.status}`,
            });
          }
          roomCompleted = true;
        });

        await report.check('browser ui: canonical action race handled with state refresh', async () => {
          if (actionConflicts.length === 0) return; // no race observed in this run
          if (pageErrors.length > 0) {
            throw new Error(`uncaught page error during canonical action race: ${pageErrors[0]}`);
          }
          if (!roomCompleted) throw new Error('room did not complete after a canonical action race');
          const finalVersion = await tableVersion(page);
          const finalNotice = (await page.locator('#noticeText').textContent()) ?? '';
          for (const conflict of actionConflicts) {
            const at = Number(conflict.version.replace(/\D/g, ''));
            const advanced = Number.isFinite(finalVersion) && finalVersion > at;
            const noticeCleared = !/error|failed|rejected|conflict|stale/i.test(finalNotice);
            if (!advanced && !noticeCleared) {
              throw new Error(
                `race at ${conflict.url} did not refresh UI state (version ${conflict.version} -> v${finalVersion}, notice ${finalNotice})`
              );
            }
          }
        });
      }
    }

    await report.check('browser: no uncaught page errors', async () => {
      if (pageErrors.length > 0) throw new Error(pageErrors.slice(0, 3).join(' | '));
      const unexplained409 = failedResponses.some((entry) => entry.startsWith('409 '));
      const allowAction409 = actionConflicts.length > 0 && !unexplained409;
      const fatal = consoleErrors.filter((message) => {
        if (/favicon|net::ERR_/i.test(message)) return false;
        // A 409 on the canonical action endpoint is a documented race, counted
        // and asserted handled above; 409s anywhere else remain fatal.
        if (allowAction409 && /status of 409 \(Conflict\)/.test(message)) return false;
        return true;
      });
      if (fatal.length > 0) throw new Error(fatal.slice(0, 3).join(' | '));
    });

    await report.check('browser: paced normal run observed zero rate-limit responses', async () => {
      if (rateLimitedResponses.length === 0) return;
      const first = rateLimitedResponses[0]!;
      throw new Error(
        `${rateLimitedResponses.length} HTTP 429 response(s) observed under normal pacing; first ${first.url}${
          first.retryAfter ? ` (retry-after ${first.retryAfter})` : ''
        }`
      );
    });

    await page.close();
  } finally {
    await browser.close();
  }
  if (options.onHumanActionExchange) {
    await report.check('canonical human action evidence', () => {
      if (humanActionEvidenceFailed) throw new Error('canonical human action evidence capture failed');
    });
  }
  report.print();
  const failures = report.failures().map((failure) => `${failure.name}: ${failure.detail ?? 'failed'}`);
  // Widened read: the capture is assigned from the page response handler, so
  // control-flow narrowing would otherwise treat it as permanently null here.
  const acceptedFold = humanFold as CanonicalActionCapture | null;
  phase('result', {
    roomId: roomId ?? undefined,
    tableId: tableId ?? undefined,
    detail: `failures=${failures.length}${acceptedFold === null ? '' : ` foldRequestId=${acceptedFold.receipt.requestId}`}`,
  });
  return {
    code: failures.length > 0 ? 1 : 0,
    failures,
    roomId,
    tableId,
    phases,
    humanFold,
  };
}

/** Standalone browser command: provisions the topology, then runs the checks. */
export async function runBrowserSmoke(options: BrowserOptions): Promise<number> {
  const context = createRunContext({ keep: options.keep });
  context.log(`NLHE browser acceptance ${context.runId}`);
  const environment = await startEnvironment(context, { allowExternal: true });
  let nlhe: Awaited<ReturnType<typeof startNlhe>> | null = null;
  try {
    // Strict: a red build fails, never a pending pass.
    await ensureNlheBuild(context);
    const admin = await loginWallet(environment.platform.baseUrl, ephemeralWallet());
    const promotion = await ensureOperator(environment.adminTarget, admin);
    if (!promotion.promoted) throw new Error('browser operator was not promoted to ADMIN');
    const orchestrator = await mintOrchestrationToken(admin);
    const principals = await provisionFakeAgentPrincipals(admin, 2, {
      delegatedToPrincipalId: orchestrator.principalId,
    });
    const roster = await writeFakeAgentRoster(context, {
      baseUrl: environment.fakeProvider.baseUrl,
      principals,
    });
    const databasePath = join(context.artifactDir, 'nlhe-browser.sqlite');
    nlhe = await startNlhe(context, {
      platformBaseUrl: environment.platform.baseUrl,
      openaiBaseUrl: environment.fakeProvider.baseUrl,
      openaiApiKey: FIXTURE_API_KEY,
      openaiModel: FIXTURE_MODEL,
      databasePath,
      agentsConfigPath: roster.path,
      maxProviderCalls: 100,
      maxCostUsdMicro: 0,
      extraEnv: {
        POKERTOOLS_ORCHESTRATION_TOKEN: orchestrator.token,
        PRODUCT_ADMIN_TOKEN: productAdminToken(),
      },
    });
    return (await runBrowserChecks({
      context,
      productBaseUrl: nlhe.baseUrl,
      platformBaseUrl: environment.platform.baseUrl,
      // Same-room agent-commit evidence straight from the product SQLite.
      getRoomEvidence: (roomId) => readRoomEvidence(databasePath, roomId),
    })).code;
  } finally {
    if (nlhe) await nlhe.stop();
    await environment.stop();
  }
}
