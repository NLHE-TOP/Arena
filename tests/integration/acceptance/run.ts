#!/usr/bin/env tsx
/**
 * Final acceptance: every mandatory roster through the product's own room
 * orchestration and the actual NLHE runtime.
 *
 * Mandatory by default (no subset, no full flag, no manual provider-decision
 * fallback):
 * - 2H 10H 2A 10A 1H1A 2H2A 1H9A product-created SPONSORED competitions;
 * - loopback provider only, varied legal menu, persisted attempts inspected
 *   against the saved observation and saved `source_json.publicChat`;
 * - zero human provider cost, replay with zero provider calls, two rooms
 *   concurrently active, stale provider timeout, actual NLHE process restart
 *   with persisted response reuse, browser against the real public path,
 *   and the valueless Anvil financial challenge.
 *
 * Any unavailable capability fails with a non-zero exit; there is no PENDING
 * path in final acceptance.
 */
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createRunContext, Report } from '../infra/context.js';
import { startEnvironment } from '../infra/environment.js';
import { probeProductSurface, surfaceReady, describeSurface } from '../infra/capabilities.js';
import { ensureNlheBuild, startNlhe, writeFakeAgentRoster } from '../infra/nlhe.js';
import { ephemeralWallet, loginWallet, type WalletSession } from '../infra/wallet.js';
import { ensureOperator } from '../infra/admin.js';
import { FIXTURE_API_KEY, FIXTURE_MODEL } from '../infra/fixtures.js';
import {
  mintOrchestrationToken,
  productAdminToken,
  provisionFakeAgentPrincipals,
  type ProvisionedAgent,
} from '../infra/agents.js';
import { waitFor } from '../infra/gameplay.js';
import { readRoomEvidence } from './evidence.js';
import { ProductClient } from './product-client.js';
import { runProductRoom, type ProductRoomRunResult } from './product-room.js';
import { ROSTER_MATRIX, assertMatrixValid, parseRosterNotation, ROSTER_NOTATION } from './roster.js';
import { assertTableOnlyAgentCredential, runAnvilChallenge, runNonfinancialCompetition } from './financial.js';
import { startActionProxy } from '../infra/action-proxy.js';
import { startFakeProvider } from '../infra/fake-provider.js';
import { getAccount } from '../infra/wallet.js';
import { runBrowserChecks } from '../../browser/run.js';

export interface AcceptanceOptions {
  keep?: boolean;
}

export async function runAcceptance(options: AcceptanceOptions): Promise<number> {
  const context = createRunContext({ keep: options.keep });
  const report = new Report();
  context.log(`NLHE FINAL acceptance ${context.runId}`);
  context.log(`artifacts: ${context.artifactDir}`);

  const anvilEnabled = process.env.NLHE_IT_ANVIL === '1';
  const sponsorPrincipalId = randomUUID();
  const sponsorAddress = getAccount(2).address;
  const environment = await startEnvironment(context, {
    allowExternal: true,
    ...(anvilEnabled ? { financial: { sponsorPrincipalId, sponsorAddress } } : {}),
  });
  const lifecycleProxy = await startActionProxy(environment.platform.baseUrl);
  let nlhe: Awaited<ReturnType<typeof startNlhe>> | null = null;
  try {
    await report.check('matrix: canonical roster notation parses and is bounded', async () => {
      assertMatrixValid(ROSTER_MATRIX);
      const parsed = parseRosterNotation(ROSTER_NOTATION);
      if (parsed.length !== ROSTER_MATRIX.length) {
        throw new Error(`parsed ${parsed.length} rosters, expected ${ROSTER_MATRIX.length}`);
      }
    });

    // Explicit infrastructure: ADMIN wallet, orchestrator credential and the
    // durable SERVICE principals the agent catalog references.
    const adminWallet = ephemeralWallet();
    const admin = await loginWallet(environment.platform.baseUrl, adminWallet);
    const promotion = await ensureOperator(environment.adminTarget, admin);
    if (!promotion.promoted) throw new Error('acceptance operator wallet was not promoted to ADMIN');
    context.log(`acceptance operator ${adminWallet.address} promoted to ADMIN`);

    const orchestrator = await mintOrchestrationToken(admin);
    const agents: ProvisionedAgent[] = await provisionFakeAgentPrincipals(admin, 10, {
      delegatedToPrincipalId: orchestrator.principalId,
    });
    const agentPrincipalIds = new Set(agents.map((agent) => agent.principalId));
    const roster = await writeFakeAgentRoster(context, {
      baseUrl: environment.fakeProvider.baseUrl,
      principals: agents,
    });
    const adminToken = productAdminToken();
    const productDatabasePath = join(context.artifactDir, 'nlhe-acceptance.sqlite');

    const build = await report.check('product: strict build from source (no stale dist)', async () => {
      await ensureNlheBuild(context);
    });
    if (build.status !== 'PASS') {
      report.print();
      return 1;
    }
    nlhe = await startNlhe(context, {
      platformBaseUrl: lifecycleProxy.url,
      openaiBaseUrl: environment.fakeProvider.baseUrl,
      openaiApiKey: FIXTURE_API_KEY,
      openaiModel: FIXTURE_MODEL,
      databasePath: productDatabasePath,
      agentsConfigPath: roster.path,
      maxProviderCalls: 5000,
      maxCostUsdMicro: 0,
      perCallTimeoutMs: 5000,
      overallRuntimeMs: 600_000,
      maxHands: 100,
      extraEnv: {
        POKERTOOLS_ORCHESTRATION_TOKEN: orchestrator.token,
        PRODUCT_ADMIN_TOKEN: adminToken,
        AGENT_CHAT_ENABLED: '1',
        MAX_PROVIDER_CONCURRENCY: '8',
        ...(environment.financial
          ? {
              CHALLENGE_ENABLED: '1',
              CHALLENGE_ASSET_ID: environment.financial.assetId,
              CHALLENGE_ENTRY_ATOMIC: '1',
              CHALLENGE_PRIZE_ATOMIC: '2',
              CHALLENGE_SPONSOR_PRINCIPAL_ID: environment.financial.sponsorPrincipalId,
            }
          : { CHALLENGE_ENABLED: '0' }),
      },
    });

    const product = new ProductClient(nlhe.baseUrl, { adminToken });
    const surface = await probeProductSurface(nlhe.baseUrl);
    context.log(`product surface: ${describeSurface(surface)}`);
    await report.check('product: mandatory public surface (catalog + rooms + stats)', async () => {
      if (!surfaceReady(surface)) throw new Error(describeSurface(surface));
      const agentsPayload = await product.getAgents();
      if (agentsPayload.agents.length < 10) throw new Error('agent catalog is incomplete');
      const stats = await product.getStats();
      if (typeof stats.rooms?.total !== 'number') throw new Error('/api/stats is not the expected projection');
    });

    // Establish real financial readiness before any room starts; /health is
    // deliberately insufficient even for the product's general readiness.
    await report.check('financial: valueless CHALLENGE, pre-start refunds and restart-safe settlement', async () => {
      await runAnvilChallenge({
        context, environment, orchestratorToken: orchestrator.token, humans: [], admin,
        product, nlhe: nlhe!, agents, productDatabasePath,
        fakeProvider: environment.fakeProvider, lifecycleProxy,
      });
    });

    // Browser acceptance runs before the concurrent roster wave so the product's
    // request-rate budget is not already consumed by room polling.
    await report.check('browser: real public UI path with injected wallet (no routed fake API/WS)', async () => {
      const result = await runBrowserChecks({
        context,
        productBaseUrl: nlhe!.baseUrl,
        platformBaseUrl: environment.platform.baseUrl,
        getRoomEvidence: (roomId) => readRoomEvidence(productDatabasePath, roomId),
      });
      if (result.code !== 0) {
        throw new Error(`browser acceptance checks failed: ${result.failures.join(' | ')}`);
      }
    });

    // Real human wallets (max ten seats).
    const humans: WalletSession[] = [];
    for (let index = 0; index < 10; index += 1) {
      humans.push(await loginWallet(environment.platform.baseUrl, ephemeralWallet()));
    }

    // All mandatory rosters, concurrently active.
    let activeRooms = 0;
    let maxActiveRooms = 0;
    const results = new Map<string, ProductRoomRunResult>();
    const rosterChecks = ROSTER_MATRIX.map((spec) =>
      report.check(`roster ${spec.label}: product-orchestrated room + evidence inspection`, async () => {
        const result = await runProductRoom({
          spec,
          context,
          environment,
          product,
          humans,
          agentIds: agents.map((agent) => agent.agentId),
          agentPrincipalIds,
          fakeProvider: environment.fakeProvider,
          productDatabasePath,
          maxWaitMs: 15 * 60 * 1000,
          onActive: async () => {
            activeRooms += 1;
            maxActiveRooms = Math.max(maxActiveRooms, activeRooms);
          },
          onTerminal: async () => {
            activeRooms = Math.max(0, activeRooms - 1);
          },
          ...(spec.label === '2H2A' ? { passiveHumanIntro: { untilProviderRequests: 6 } } : {}),
        });
        results.set(spec.label, result);
        if (spec.agents > 0 && result.evidence.decisions.length === 0) {
          throw new Error('agent seats produced no durable decisions');
        }
        if (spec.label === '2H2A') {
          // Focused fake-provider family/sizing audit on this mixed room: the
          // bounded intro window must exercise several families and at least
          // one non-maximum bounded sizing before aggressive completion play.
          const { summarizeChosenActions } = await import('./evidence.js');
          const summary = summarizeChosenActions(result.evidence);
          const families = new Set(summary.map((entry) => entry.family).filter(Boolean));
          if (families.size < 3) {
            throw new Error(`fake family audit saw only ${families.size} families: ${[...families].join(',')}`);
          }
          const variedSizing = summary.some(
            (entry) =>
              entry.requiresAmount === true &&
              entry.amount !== null &&
              entry.maxAmount !== null &&
              entry.minAmount !== null &&
              entry.amount > entry.minAmount &&
              entry.amount < entry.maxAmount
          );
          if (!variedSizing) throw new Error('fake family audit saw no varied bounded sizing');
        }
        if (spec.agents === 0) {
          if (result.evidence.decisions.length !== 0 || result.providerRequests !== 0) {
            throw new Error('human-only room produced provider activity');
          }
        }
        if (result.room.results === null || result.room.results.length !== spec.seats) {
          throw new Error(`room results do not cover ${spec.seats} placements`);
        }
      })
    );
    await Promise.all(rosterChecks);

    await report.check('concurrency: at least two rooms active simultaneously', async () => {
      if (maxActiveRooms < 2) throw new Error(`max simultaneously ACTIVE rooms was ${maxActiveRooms}`);
    });

    await report.check('stats: zero human provider cost, agent-only model analytics', async () => {
      const stats = await product.getStats();
      for (const row of stats.models) {
        if (!agentPrincipalIds.has(row.agentId) && !agents.some((agent) => agent.agentId === row.agentId)) {
          throw new Error(`model analytics reference a non-agent: ${row.agentId}`);
        }
        if (row.calls <= 0) throw new Error(`agent ${row.agentId} has no recorded calls`);
      }
      if (stats.models.length === 0) throw new Error('no agent model analytics were recorded');
      if (stats.humans < humans.length) {
        throw new Error(`stats humans ${stats.humans} < provisioned ${humans.length}`);
      }
      if (stats.games.finished < ROSTER_MATRIX.length) {
        throw new Error(`stats finished games ${stats.games.finished} < mandatory rosters ${ROSTER_MATRIX.length}`);
      }
    });

    await report.check('replay: completed room replay makes zero actual requests or attempts', async () => {
      const completed = [...results.values()][0];
      if (!completed) throw new Error('no completed room available');
      const beforeCount = environment.fakeProvider.requestCount();
      const beforeEvidence = readRoomEvidence(productDatabasePath, completed.room.id);
      const frame = await humans[0]!.client.getReplay(completed.tableId, { fromEventSeq: 1 });
      if (!frame.chainValid) throw new Error('replay chain is invalid');
      if (frame.events.length === 0) throw new Error('replay returned no events');
      if (environment.fakeProvider.requestCount() !== beforeCount) throw new Error('replay caused provider requests');
      const afterEvidence = readRoomEvidence(productDatabasePath, completed.room.id);
      if (
        afterEvidence.decisions.length !== beforeEvidence.decisions.length ||
        afterEvidence.attempts.length !== beforeEvidence.attempts.length
      ) {
        throw new Error('replay created decision/attempt records');
      }
    });

    await report.check('restart: crash window replays the stored accepted receipt exactly once', async () => {
      const proxy = await startActionProxy(environment.platform.baseUrl);
      const crashDb = join(context.artifactDir, 'nlhe-crash.sqlite');
      let crash: Awaited<ReturnType<typeof startNlhe>> | null = null;
      try {
        crash = await startNlhe(context, {
          platformBaseUrl: proxy.url,
          openaiBaseUrl: environment.fakeProvider.baseUrl,
          openaiApiKey: FIXTURE_API_KEY,
          openaiModel: FIXTURE_MODEL,
          databasePath: crashDb,
          agentsConfigPath: roster.path,
          maxProviderCalls: 200,
          maxCostUsdMicro: 0,
          perCallTimeoutMs: 5000,
          overallRuntimeMs: 300_000,
          maxHands: 20,
          extraEnv: {
            POKERTOOLS_ORCHESTRATION_TOKEN: orchestrator.token,
            PRODUCT_ADMIN_TOKEN: adminToken,
            AGENT_CHAT_ENABLED: '0',
          },
        });
        const crashProduct = new ProductClient(crash.baseUrl, { adminToken });
        proxy.holdNextActionResponse();
        const spec = ROSTER_MATRIX.find((candidate) => candidate.label === '2A')!;
        const room = await crashProduct.createRoom(
          { name: `crash-${spec.label}-${Date.now().toString(36)}`, mode: 'SPONSORED', humanCount: 0, agentIds: agents.slice(0, 2).map((agent) => agent.agentId) },
          { admin: true }
        );
        // startRoom awaits runtime attachment and its first drain. Observe the
        // accepted-action window concurrently, before that request can finish.
        const starting = crashProduct.startRoom(room.id, { admin: true }).catch((error: unknown) => error);

        const submitted = await waitFor(
          'decision ACTION_SUBMITTED with a stored request',
          async () => {
            const evidence = readRoomEvidence(crashDb, room.id);
            const heldRequestId = proxy.heldActionRequestId();
            if (proxy.heldResponses() === 0 || heldRequestId === null) return null;
            return (
              evidence.decisions.find((decision) => decision.status === 'ACTION_SUBMITTED' && decision.request_json !== null &&
                (JSON.parse(decision.request_json) as { requestId: string }).requestId === heldRequestId) ??
              null
            );
          },
          { timeoutMs: 90_000, intervalMs: 150 }
        );
        const tableId = submitted.table_id;
        const turnId = submitted.turn_id;
        const acceptedReceiptBeforeCrash = proxy.heldActionReceipt();
        if (acceptedReceiptBeforeCrash === null) throw new Error('crash window has no real accepted receipt');
        const providerBefore = environment.fakeProvider.requestCountForTurn(tableId, turnId);
        const attemptsBefore = readRoomEvidence(crashDb, room.id).attempts.filter(
          (attempt) => attempt.decision_id === submitted.id
        ).length;
        context.log('restart: SIGKILLing the actual NLHE process inside the accepted-action window...');
        await crash.kill();
        await starting;
        proxy.releaseHeld();
        await crash.restart();

        const committed = await waitFor(
          'decision COMMITTED after restart',
          async () => {
            const evidence = readRoomEvidence(crashDb, room.id);
            const decision = evidence.decisions.find((candidate) => candidate.id === submitted.id);
            return decision?.status === 'COMMITTED' ? decision : null;
          },
          { timeoutMs: 120_000, intervalMs: 250 }
        );
        const evidence = readRoomEvidence(crashDb, room.id);
        if (!isDeepStrictEqual(JSON.parse(committed.receipt_json!), acceptedReceiptBeforeCrash)) {
          throw new Error('restart did not reuse the original accepted platform receipt');
        }
        const attempts = evidence.attempts.filter((attempt) => attempt.decision_id === submitted.id);
        if (attempts.length !== 1 || attempts[0]!.status !== 'SUCCEEDED') {
          throw new Error(`expected exactly one SUCCEEDED provider attempt for the crashed decision, saw ${attempts.length}`);
        }
        if (attemptsBefore !== 1) throw new Error(`crash window recorded ${attemptsBefore} attempts before the kill`);
        const providerAfter = environment.fakeProvider.requestCountForTurn(tableId, turnId);
        if (providerBefore !== 1 || providerAfter !== 1) {
          throw new Error(
            `crashed turn provider exchanges before=${providerBefore} after=${providerAfter} (expected exactly one)`
          );
        }
        const requestId = (JSON.parse(submitted.request_json!) as { requestId: string }).requestId;
        const container = environment.postgres?.container ?? null;
        if (container !== null) {
          const { psqlContainer } = await import('../infra/docker.js');
          const eventCount = Number(
            await psqlContainer(
              container,
              `SELECT count(*) FROM "GameEvent" WHERE "tableId"='${tableId}' AND "requestId"='${requestId}'`
            )
          );
          const requestCount = Number(
            await psqlContainer(
              container,
              `SELECT count(*) FROM "GameActionRequest" WHERE "requestId"='${requestId}'`
            )
          );
          if (eventCount !== 1 || requestCount !== 1) {
            throw new Error(
              `accepted action identity ${requestId} persisted ${requestCount} request row(s) and ${eventCount} event row(s)`
            );
          }
        } else {
          const frame = await admin.client.getReplay(tableId, { fromEventSeq: 1 });
          // v2.0.0 exposes accepted-action correlation on the replay event,
          // not inside its masked public payload.
          const acceptedEvents = frame.events.filter((event) => event.requestId === requestId);
          if (acceptedEvents.length !== 1) {
            throw new Error(`expected exactly one accepted action event for ${requestId}, saw ${acceptedEvents.length}`);
          }
          const request = JSON.parse(submitted.request_json!) as { actionId: string };
          const receipt = JSON.parse(committed.receipt_json!) as { requestId: string; eventSeq: number; actionId: string };
          const event = acceptedEvents[0]!;
          // The receipt cursor includes events derived from the action (for
          // example the next turn), not only the ACTION_APPLIED event itself.
          if (!frame.chainValid || event.turnId !== turnId || event.actionId !== request.actionId ||
              receipt.requestId !== requestId || receipt.actionId !== event.actionId || event.eventSeq > receipt.eventSeq ||
              !frame.events.some(candidate => candidate.eventSeq === receipt.eventSeq)) {
            throw new Error('recovered receipt does not identify the one authoritative accepted action');
          }
        }
        void committed;
      } finally {
        proxy.releaseHeld();
        if (crash) await crash.stop();
        await proxy.stop();
      }
    });

    await report.check('stale: late action forward loses the turn without mutation or speech', async () => {
      const proxy = await startActionProxy(environment.platform.baseUrl);
      const speechProvider = await startFakeProvider({ speechEvery: 1 });
      const staleDb = join(context.artifactDir, 'nlhe-stale.sqlite');
      let staleNlhe: Awaited<ReturnType<typeof startNlhe>> | null = null;
      try {
        const speechRoster = await writeFakeAgentRoster(context, { baseUrl: speechProvider.baseUrl, principals: agents });
        staleNlhe = await startNlhe(context, {
          platformBaseUrl: proxy.url,
          openaiBaseUrl: speechProvider.baseUrl,
          openaiApiKey: FIXTURE_API_KEY,
          openaiModel: FIXTURE_MODEL,
          databasePath: staleDb,
          agentsConfigPath: speechRoster.path,
          maxProviderCalls: 200,
          maxCostUsdMicro: 0,
          // Two submission attempts must outlive the real 10s platform turn
          // timeout and the 12s forwarding fence, so we observe STALE, not a
          // transport timeout before the request ever reaches the platform.
          perCallTimeoutMs: 8000,
          overallRuntimeMs: 300_000,
          maxHands: 20,
          extraEnv: {
            POKERTOOLS_ORCHESTRATION_TOKEN: orchestrator.token,
            PRODUCT_ADMIN_TOKEN: adminToken,
            AGENT_CHAT_ENABLED: '1',
          },
        });
        const staleProduct = new ProductClient(staleNlhe.baseUrl, { adminToken });
        // The provider call completes well within its budget; the canonical
        // action forward is delayed past the platform timeout so the timeout
        // worker wins and the late request is genuinely STALE.
        proxy.delayNextActionForward(12_000);
        const spec = ROSTER_MATRIX.find((candidate) => candidate.label === '2A')!;
        const room = await staleProduct.createRoom(
          { name: `stale-${spec.label}-${Date.now().toString(36)}`, mode: 'SPONSORED', humanCount: 0, agentIds: agents.slice(0, 2).map((agent) => agent.agentId) },
          { admin: true }
        );
        const started = await staleProduct.startRoom(room.id, { admin: true });
        const tableId = started.pokerTableId;
        if (tableId === null) throw new Error('stale room ACTIVE without a table');

        const staleDecision = await waitFor(
          'STALE decision with a completed provider attempt',
          async () => {
            const evidence = readRoomEvidence(staleDb, room.id);
            const delayedRequestId = proxy.delayedActionRequestId();
            return evidence.decisions.find((decision) => decision.status === 'STALE' && decision.request_json !== null &&
              (JSON.parse(decision.request_json) as { requestId: string }).requestId === delayedRequestId) ?? null;
          },
          { timeoutMs: 120_000, intervalMs: 250 }
        );
        const evidence = readRoomEvidence(staleDb, room.id);
        const attempts = evidence.attempts.filter((attempt) => attempt.decision_id === staleDecision.id);
        if (attempts.length !== 1 || attempts[0]!.status !== 'SUCCEEDED') {
          throw new Error(`stale decision attempts are not one SUCCEEDED provider exchange: ${JSON.stringify(attempts.map((a) => a.status))}`);
        }
        if (speechProvider.requestCountForTurn(tableId, staleDecision.turn_id) !== 1) {
          throw new Error('stale turn did not use the dedicated speech provider exactly once');
        }
        const completion = JSON.parse(attempts[0]!.response_json!) as {
          choices: Array<{ message: { tool_calls: Array<{ function: { arguments: string } }> } }>;
        };
        const speech = (JSON.parse(completion.choices[0]!.message.tool_calls[0]!.function.arguments) as { speech?: string }).speech;
        if (typeof speech !== 'string' || !/^fake-table-speech-\d+$/.test(speech)) {
          throw new Error('delayed stale action did not carry its deterministic speech');
        }
        const requestId = (JSON.parse(staleDecision.request_json!) as { requestId: string }).requestId;
        const frame = await admin.client.getReplay(tableId, { fromEventSeq: 1 });
        const accepted = frame.events.filter((event) => event.requestId === requestId);
        if (accepted.length !== 0) throw new Error('the stale request mutated the table');
        const observation = JSON.parse(staleDecision.observation_json) as { version: number };
        const winningMutation = frame.events.filter(event => event.type === 'ACTION_APPLIED' && event.version === observation.version + 1);
        if (!frame.chainValid || winningMutation.length !== 1) {
          throw new Error('the timed-out turn did not have exactly one authoritative winning mutation');
        }
        await waitFor(
          'next COMMITTED decision after the stale turn',
          async () => {
            const current = readRoomEvidence(staleDb, room.id);
            return current.decisions.find((decision) => decision.status === 'COMMITTED') ?? null;
          },
          { timeoutMs: 120_000, intervalMs: 250 }
        );
        const recoveredFrame = await admin.client.getReplay(tableId, { fromEventSeq: 1 });
        const chatEvents = recoveredFrame.events.filter((event) => event.type === 'CHAT_MESSAGE');
        const chat = await admin.client.getChat(tableId, { limit: 100 });
        if (chat.messages.some(message => message.body === speech)) throw new Error('the stale decision published its speech');
        const committed = readRoomEvidence(staleDb, room.id).decisions.filter((decision) => decision.status === 'COMMITTED');
        if (chatEvents.length > committed.length) {
          throw new Error(`chat events ${chatEvents.length} exceed committed decisions ${committed.length}: a stale decision spoke`);
        }
      } finally {
        if (staleNlhe) await staleNlhe.stop();
        await speechProvider.stop();
        await proxy.stop();
      }
    });

    await report.check('financial: generic NONFINANCIAL competition public contract', async () => {
      await runNonfinancialCompetition({
        context,
        environment,
        orchestratorToken: orchestrator.token,
        humans,
        admin,
        product,
        nlhe: nlhe!,
        agents,
        productDatabasePath,
        fakeProvider: environment.fakeProvider,
      });
    });

    await report.check('credentials: omitted seat issues a table-only credential (seat null)', async () => {
      await assertTableOnlyAgentCredential({
        context,
        environment,
        orchestratorToken: orchestrator.token,
        humans,
        admin,
        product,
        nlhe: nlhe!,
        agents,
        productDatabasePath,
        fakeProvider: environment.fakeProvider,
        servicePrincipalId: agents[1]!.principalId,
      });
    });
  } finally {
    if (nlhe) await nlhe.stop();
    await lifecycleProxy.stop();
    await environment.stop();
  }

  report.print();
  if (report.failures().length > 0) return 1;
  if (report.pendingResults().length > 0) return 1; // final acceptance has no pending path
  return 0;
}
