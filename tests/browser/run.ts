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
import { installInjectedWallet, verifyInjectedSignature } from './wallet.js';

export interface BrowserChecksOptions {
  context: RunContext;
  productBaseUrl: string;
  platformBaseUrl: string;
}

export interface BrowserOptions {
  keep?: boolean;
}

const AUTH_NONCE = /\/(?:v1\/|api\/)?auth\/nonce(?:\?|$)/;
const AUTH_LOGIN = /\/(?:v1\/|api\/)?auth\/(?:login|verify)(?:\?|$)/;

/**
 * One aggressive human action through the real UI: max-amount BET/RAISE when a
 * bounded chip control is offered, otherwise CALL/CHECK/FOLD. Returns false
 * when it is not the human's turn or no control is available.
 */
async function uiAggressiveAction(page: import('playwright').Page): Promise<boolean> {
  const deadline = Date.now() + 2000;
  do {
    const turn = ((await page.locator('#turnLine').textContent().catch(() => '')) ?? '').trim();
    if (!turn.startsWith('Your turn')) return false;
    if (await uiAggressiveActionOnce(page)) return true;
    // Turn text and legal controls may render on separate observation updates.
    // Retry only before submitting an action, never after a click.
    await page.waitForTimeout(100);
  } while (Date.now() < deadline);
  return false;
}

async function uiAggressiveActionOnce(page: import('playwright').Page): Promise<boolean> {
  const turn = ((await page.locator('#turnLine').textContent().catch(() => '')) ?? '').trim();
  if (!turn.startsWith('Your turn')) return false;
  const groups = page.locator('.legal-actions .action-group');
  const count = await groups.count();
  for (let index = 0; index < count; index += 1) {
    const group = groups.nth(index);
    const label = (await group.locator('.action-label').textContent()) ?? '';
    if (!/Raise|Bet/i.test(label)) continue;
    const input = group.locator('input.amount-input');
    const max = await input.getAttribute('max');
    if (max) await input.fill(max);
    const button = group.locator('button');
    if (await button.isDisabled()) return false;
    await button.click();
    return true;
  }
  const fallback = page.locator('.legal-actions button', { hasText: /Call|Check|Fold/i }).first();
  if ((await fallback.count()) > 0 && !(await fallback.isDisabled())) {
    await fallback.click();
    return true;
  }
  return false;
}

/**
 * Strict browser checks against an already-running product + platform.
 * Returns 0 only when every check passes.
 */
export async function runBrowserChecks(options: BrowserChecksOptions): Promise<number> {
  const { context } = options;
  const report = new Report();
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
    const actionConflicts: Array<{ url: string; version: string; notice: string }> = [];
    const pageErrors: string[] = [];
    page.on('request', (request) => {
      const url = request.url();
      if (AUTH_NONCE.test(url)) nonceRequests.push(url);
      if (AUTH_LOGIN.test(url)) loginRequests.push(url);
    });
    page.on('response', (response) => {
      const url = response.url();
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
        await page.waitForSelector('#walletChip:not([hidden])', { timeout: 25_000 });
      });

      await report.check('browser: reload restores the signed-in session without a new nonce', async () => {
        const noncesBefore = nonceRequests.length;
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#walletChip:not([hidden])', { timeout: 25_000 });
        if (nonceRequests.length > noncesBefore) {
          throw new Error('reload requested a new SIWE nonce instead of restoring the session');
        }
      });

      if (loginRequests.length === 0) {
        report.skip('browser ui lifecycle', 'requires a successful UI wallet login');
      } else {
        const roomName = `ui-${context.runId}`;
        let tableId: string | null = null;
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
            () => document.querySelector('#roomStatusChip')?.textContent?.trim() === 'ACTIVE',
            undefined,
            { timeout: 60_000 }
          );
          tableId = await page.evaluate(async (name) => {
            const response = await fetch('/api/rooms');
            const payload = (await response.json()) as { rooms?: Array<{ name: string; pokerTableId: string | null }> };
            return payload.rooms?.find((room) => room.name === name)?.pokerTableId ?? null;
          }, roomName);
          if (tableId === null) throw new Error('created room has no pokerTableId');
        });

        await report.check('browser ui: live masked seat observation via page SDK socket', async () => {
          await page.waitForSelector('#tableCard:not([hidden])', { timeout: 30_000 });
          await page.waitForFunction(
            () => document.querySelector('#tableConnection')?.textContent?.startsWith('ws: connected') === true,
            undefined,
            { timeout: 30_000 }
          );
          await page.waitForFunction(
            () => document.querySelectorAll('#seats .seat').length >= 2,
            undefined,
            { timeout: 30_000 }
          );
          const versionText = (await page.locator('#tableVersion').textContent()) ?? '';
          if (!/^v\d+/.test(versionText.trim())) throw new Error(`table version not live: ${versionText}`);
          const turnText = (await page.locator('#turnLine').textContent()) ?? '';
          if (!/Your turn|Waiting for the server/.test(turnText)) {
            throw new Error(`unexpected turn line: ${turnText}`);
          }
        });

        await report.check('browser ui: canonical human action accepted, version advances', async () => {
          const before = Number(((await page.locator('#tableVersion').textContent()) ?? 'v0').replace(/\D/g, ''));
          await page.waitForFunction(
            () => document.querySelector('#turnLine')?.textContent?.startsWith('Your turn') === true,
            undefined,
            { timeout: 60_000 }
          );
          const acted = await uiAggressiveAction(page);
          if (!acted) throw new Error('no server-issued legal action control was available for the human turn');
          await page.waitForFunction(
            (previous) => {
              const current = Number((document.querySelector('#tableVersion')?.textContent ?? 'v0').replace(/\D/g, ''));
              return current > previous;
            },
            before,
            { timeout: 30_000 }
          );
          const notice = (await page.locator('#noticeText').textContent()) ?? '';
          if (/failed|rejected|illegal|error/i.test(notice)) throw new Error(`action surfaced an error notice: ${notice}`);
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

        await report.check('browser ui: reload restores session + subscription without duplicate action or nonce', async () => {
          if (tableId === null) throw new Error('table id unavailable');
          const noncesBefore = nonceRequests.length;
          await page.reload({ waitUntil: 'domcontentloaded' });
          // The real UI does not persist the selected room: re-open it from the
          // room list, which is the public reconnect path.
          await page.waitForSelector('#roomList .room-row', { timeout: 30_000 });
          const row = page.locator('.room-row', { hasText: roomName }).first();
          if ((await row.count()) === 0) throw new Error('room missing from the room list after reload');
          await row.getByRole('button', { name: 'Open' }).click();
          await page.waitForSelector('#tableCard:not([hidden])', { timeout: 30_000 });
          await page.waitForFunction(
            () => document.querySelector('#tableConnection')?.textContent?.startsWith('ws: connected') === true,
            undefined,
            { timeout: 30_000 }
          );
          await page.waitForFunction(
            () => document.querySelectorAll('#seats .seat').length >= 2,
            undefined,
            { timeout: 30_000 }
          );
          if (nonceRequests.length > noncesBefore) {
            throw new Error('reload requested a new SIWE nonce instead of restoring the session');
          }
          await page.waitForFunction(
            (expected) =>
              [...document.querySelectorAll('#chatLog .chat-body')].some((node) => node.textContent === expected),
            `ui-chat-${context.runId}`,
            { timeout: 20_000 }
          );
          const duplicates = await page.locator('#chatLog .chat-body', { hasText: `ui-chat-${context.runId}` }).count();
          if (duplicates > 1) throw new Error(`chat message duplicated after reconnect: ${duplicates}`);
        });

        await report.check('browser ui: aggressive play completes room and UI shows terminal results', async () => {
          const deadline = Date.now() + 180_000;
          let status = '';
          let lastRefresh = 0;
          while (Date.now() < deadline) {
            // The real UI refreshes the room projection on demand; pace it well
            // under the product's 120 req/min limit.
            if (Date.now() - lastRefresh > 2500) {
              lastRefresh = Date.now();
              await page.click('#roomRefreshBtn', { timeout: 5_000 }).catch(() => undefined);
            }
            status = ((await page.locator('#roomStatusChip').textContent()) ?? '').trim();
            if (status === 'COMPLETE' || status === 'FAILED') break;
            const terminalNotice = (await page.locator('#roomNote').textContent()) ?? '';
            if (/failed/i.test(terminalNotice)) throw new Error(`room reported failure: ${terminalNotice}`);
            await uiAggressiveAction(page);
            await page.waitForTimeout(250);
          }
          if (status !== 'COMPLETE') throw new Error(`room did not complete through the UI (status ${status})`);
          const results = (await page.locator('#results').textContent()) ?? '';
          if (!/\d/.test(results)) throw new Error('terminal results are not rendered in #results');
          roomCompleted = true;
        });

        await report.check('browser ui: canonical action race handled with state refresh', async () => {
          if (actionConflicts.length === 0) return; // no race observed in this run
          if (pageErrors.length > 0) {
            throw new Error(`uncaught page error during canonical action race: ${pageErrors[0]}`);
          }
          if (!roomCompleted) throw new Error('room did not complete after a canonical action race');
          const finalVersion = Number(((await page.locator('#tableVersion').textContent()) ?? 'v0').replace(/\D/g, ''));
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

    await page.close();
  } finally {
    await browser.close();
  }
  report.print();
  return {
    code: report.failures().length > 0 ? 1 : 0,
    failures: report.failures().map((failure) => `${failure.name}: ${failure.detail ?? 'failed'}`),
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
    nlhe = await startNlhe(context, {
      platformBaseUrl: environment.platform.baseUrl,
      openaiBaseUrl: environment.fakeProvider.baseUrl,
      openaiApiKey: FIXTURE_API_KEY,
      openaiModel: FIXTURE_MODEL,
      databasePath: join(context.artifactDir, 'nlhe-browser.sqlite'),
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
    })).code;
  } finally {
    if (nlhe) await nlhe.stop();
    await environment.stop();
  }
}
