#!/usr/bin/env tsx
/**
 * NLHE integration entrypoint.
 *
 * Commands:
 *   tsx tests/integration/run.ts smoke        focused offline smoke (default)
 *   tsx tests/integration/run.ts acceptance   roster-matrix acceptance (gated)
 *   tsx tests/integration/run.ts browser      Playwright browser smoke (gated)
 *   tsx tests/integration/run.ts doctor       prerequisite/capability report
 *   tsx tests/integration/run.ts list         roster matrix + interfaces
 *
 * The smoke targets an external PokerTools 2.0.0 test deployment with real
 * PostgreSQL + Redis, then uses only the public `@pokertools/sdk` and
 * `@pokertools/types` contract with real viem SIWE wallets. It never calls a
 * paid provider. Acceptance suites that need product routes still under
 * implementation are reported PENDING rather than guessed.
 */
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createRunContext, Report, ROOT } from './infra/context.js';
import { startEnvironment } from './infra/environment.js';
import { detectSdkCapabilities, probeProductSurface, surfaceReady, describeSurface } from './infra/capabilities.js';
import { ephemeralWallet, loginWallet, tokenClient } from './infra/wallet.js';
import { ensureOperator, grantChips } from './infra/admin.js';
import { assertProviderRequestsExact } from './infra/fake-provider.js';
import {
  createCashTable,
  seatPlayer,
  submitLegalAction,
  waitForActingParticipant,
  waitForObservation,
} from './infra/gameplay.js';
import { ensureNlheBuild, startNlhe, writeFakeAgentRoster } from './infra/nlhe.js';
import { FIXTURE_API_KEY, FIXTURE_MODEL } from './infra/fixtures.js';
import { mintOrchestrationToken, productAdminToken, provisionFakeAgentPrincipals } from './infra/agents.js';
import { verifyEnvironmentBoundary } from './infra/env-boundary.js';
import { ProductClient } from './acceptance/product-client.js';
import { runProductRoom } from './acceptance/product-room.js';
import { ROSTER_MATRIX } from './acceptance/roster.js';
import { runAnvilChallenge, runNonfinancialCompetition } from './acceptance/financial.js';
import { getAccount } from './infra/wallet.js';
import { inspectPersistedDecision } from './inspector.js';
import type { SeatObservation } from '@pokertools/types';

const command = process.argv[2] ?? 'smoke';
const flags = new Set(process.argv.slice(3));

function usage(): void {
  // eslint-disable-next-line no-console
  console.log(
    [
      'usage: tsx tests/integration/run.ts [smoke|endpoints|room-prove|financial|acceptance|browser|doctor|list|env-boundary] [--keep] [--force-build]',
      '',
      'env: NLHE_IT_PLATFORM_URL NLHE_IT_DATABASE_URL NLHE_IT_REDIS_URL NLHE_IT_POSTGRES_CONTAINER',
      '     NLHE_IT_KEEP=1 NLHE_IT_BUILD=auto|force|never NLHE_IT_ANVIL=1 (financial challenge)',
    ].join('\n')
  );
}

async function runSmoke(): Promise<Report> {
  const context = createRunContext({
    keep: flags.has('--keep'),
    build: flags.has('--force-build') ? 'force' : undefined,
  });
  const report = new Report();

  context.log(`NLHE integration smoke ${context.runId}`);
  context.log(`artifacts: ${context.artifactDir}`);

  const environment = await startEnvironment(context, { allowExternal: true });
  try {
    // ------------------------------------------------------------------
    // Public SDK contract (extensions in progress are checked, not assumed)
    // ------------------------------------------------------------------
    const sdkProbe = tokenClient(environment.platform.baseUrl);
    const sdk = detectSdkCapabilities(sdkProbe);
    const gameplaySurface = [
      'createTable',
      'getTables',
      'buyIn',
      'getObservation',
      'action',
      'getChat',
      'sendChat',
      'getReplay',
      'health',
    ];
    await report.check('sdk: canonical gameplay surface present', async () => {
      const missing = gameplaySurface.filter((method) => !sdk.has(method));
      if (missing.length > 0) throw new Error(`SDK methods missing: ${missing.join(', ')}`);
    });
    const extensionSurface = [
      'getPrincipal',
      'getReadiness',
      'createServiceCredential',
      'listServiceCredentials',
      'revokeServiceCredential',
      'getChat',
      'sendChat',
      'getReplay',
    ];
    const missingExtensions = extensionSurface.filter((method) => !sdk.has(method));
    if (missingExtensions.length === 0) {
      await report.check('sdk: identity/readiness/service-credential/chat/replay extensions present', async () => undefined);
    } else {
      report.pending('sdk: identity/readiness/service-credential/chat/replay extensions', `missing: ${missingExtensions.join(', ')}`);
    }
    if (sdk.has('grantChips')) {
      await report.check('sdk: chip grant extension present', async () => undefined);
    } else {
      // Not a required production surface: operator grants are exercised
      // through the canonical POST /chips/grant contract validated by the
      // shared strict schemas.
      await report.check('sdk: chip grant method not required (canonical contract used)', async () => undefined);
    }

    // ------------------------------------------------------------------
    // Platform liveness/readiness + real SIWE wallet
    // ------------------------------------------------------------------
    const humanWallet = ephemeralWallet();
    const human = await loginWallet(environment.platform.baseUrl, humanWallet);
    await report.check('platform: health via SDK', async () => {
      const health = await human.client.health();
      if (health.status !== 'ok') throw new Error(`unexpected status ${health.status}`);
    });
    await report.check('platform: readiness via SDK (typed 200/503)', async () => {
      const readiness = await human.client.getReadiness();
      if (readiness.status !== 'ready' && readiness.status !== 'not_ready') {
        throw new Error(`unexpected readiness status ${String(readiness.status)}`);
      }
      const checkNames = readiness.checks.map((entry) => entry.name);
      if (!checkNames.includes('database') || !checkNames.includes('redis')) {
        throw new Error(`readiness checks missing database/redis: ${checkNames.join(', ')}`);
      }
    });
    await report.check('auth: real SIWE login + GET /auth/me principal', async () => {
      const principal = await human.client.getPrincipal();
      if (principal.kind !== 'WALLET') throw new Error(`unexpected principal kind ${principal.kind}`);
      if (principal.walletAddress?.toLowerCase() !== humanWallet.address.toLowerCase()) {
        throw new Error('principal wallet address does not match the signing wallet');
      }
    });

    // ------------------------------------------------------------------
    // Explicit-infrastructure operator bootstrap + canonical chip grant
    // ------------------------------------------------------------------
    await report.check('operator: ADMIN bootstrap in disposable database', async () => {
      const promotion = await ensureOperator(environment.adminTarget, human);
      if (!promotion.promoted) throw new Error('wallet row was not promoted to ADMIN');
    });
    await report.check('operator: canonical chip grant via public contract', async () => {
      const grant = await grantChips(environment.platform.baseUrl, human.token, {
        principalId: human.userId,
        amount: 10_000,
        reason: 'nlhe integration smoke',
        idempotencyKey: `smoke-human-${context.runId}`,
      });
      if (grant.balanceAfter !== '10000') throw new Error(`unexpected balance ${grant.balanceAfter}`);
    });

    // ------------------------------------------------------------------
    // Service credential lifecycle through the public SDK extensions
    // ------------------------------------------------------------------
    let mintedCredentialId: string | null = null;
    await report.check('credentials: mint/list/revoke through SDK + live revocation', async () => {
      const created = await human.client.createServiceCredential({
        name: `smoke-credential-${context.runId}`,
        scopes: ['table:observe', 'table:act', 'table:chat'],
      });
      mintedCredentialId = created.id;
      const summaries = await human.client.listServiceCredentials();
      if (!summaries.some((summary) => summary.id === created.id)) {
        throw new Error('minted credential missing from list response');
      }
      const service = tokenClient(environment.platform.baseUrl, created.token);
      const principal = await service.getPrincipal();
      if (principal.kind !== 'SERVICE') throw new Error(`unexpected service kind ${principal.kind}`);
      await human.client.revokeServiceCredential(created.id);
      let rejected = false;
      try {
        await service.getPrincipal();
      } catch (error) {
        rejected = (error as { statusCode?: number }).statusCode === 401;
      }
      if (!rejected) throw new Error('revoked service credential was still accepted');
    });
    void mintedCredentialId;

    // ------------------------------------------------------------------
    // Table lifecycle: two participants, real actions, chat, replay
    // ------------------------------------------------------------------
    let createdTableId: string | null = null;
    let decisionObservation: SeatObservation | null = null;
    await report.check('table: create + seat two principals + first legal action', async () => {
      createdTableId = await createCashTable(human.client, {
        name: `smoke-${context.runId}`,
        maxPlayers: 2,
        smallBlind: 1,
        bigBlind: 2,
        minBuyIn: 50,
        maxBuyIn: 1000,
        actionTimeoutSeconds: 60,
      });
      const credential = await human.client.createServiceCredential({
        name: `smoke-agent-${context.runId}`,
        scopes: ['table:observe', 'table:act', 'table:chat'],
        tableId: createdTableId,
        seat: 1,
      });
      const service = tokenClient(environment.platform.baseUrl, credential.token);
      const servicePrincipal = await service.getPrincipal();
      if (servicePrincipal.kind !== 'SERVICE') throw new Error(`unexpected service kind ${servicePrincipal.kind}`);
      await grantChips(environment.platform.baseUrl, human.token, {
        principalId: credential.userId,
        amount: 10_000,
        reason: 'nlhe integration smoke agent',
        idempotencyKey: `smoke-agent-${context.runId}`,
      });
      await seatPlayer(human.client, createdTableId, { seat: 0, amount: 1000 });
      await seatPlayer(service, createdTableId, { seat: 1, amount: 1000 });
      const turn = await waitForActingParticipant(
        [
          { id: 'human', client: human.client },
          { id: 'service', client: service },
        ],
        createdTableId,
        { timeoutMs: 60_000 }
      );
      decisionObservation = turn.observation;
      await submitLegalAction(turn.participant.client, turn.observation);
    });

    await report.check('table: bounded chat append/read via SDK', async () => {
      if (!createdTableId) throw new Error('table was not created');
      const message = await human.client.sendChat(createdTableId, '<b>smoke</b> chat');
      if (!message.body.includes('&lt;b&gt;')) throw new Error(`chat body was not escaped: ${message.body}`);
      const page = await human.client.getChat(createdTableId, { limit: 10 });
      if (!page.messages.some((entry) => entry.messageId === message.messageId)) {
        throw new Error('sent message missing from chat page');
      }
    });

    await report.check('table: real WS wallet session joins, observes and reconnects', async () => {
      if (!createdTableId) throw new Error('table was not created');
      const { PokerSocket } = await import('@pokertools/sdk');
      const wsUrl = `${environment.platform.baseUrl.replace(/^http/, 'ws')}/ws/play`;
      const seenTables: string[] = [];
      const first = new PokerSocket({ url: wsUrl, token: human.token, reconnectAttempts: 0 });
      first.on('observation', (tableId: string) => seenTables.push(tableId));
      await first.connect();
      const firstObservation = await first.join(createdTableId);
      if (firstObservation.tableId !== createdTableId) throw new Error('WS joined the wrong table');
      first.disconnect();

      const second = new PokerSocket({ url: wsUrl, token: human.token, reconnectAttempts: 0 });
      second.on('observation', (tableId: string) => seenTables.push(tableId));
      await second.connect();
      const secondObservation = await second.join(createdTableId);
      if (secondObservation.version < firstObservation.version) {
        throw new Error('reconnect observation regressed below the first join');
      }
      second.disconnect();
      if (seenTables.length < 2) throw new Error('WS observation events were not emitted for both joins');
    });

    await report.check('table: replay is hash-chained and makes no provider calls', async () => {
      if (!createdTableId) throw new Error('table was not created');
      const before = environment.fakeProvider.requestCount();
      const frame = await human.client.getReplay(createdTableId, { fromEventSeq: 1 });
      if (!frame.chainValid) throw new Error('replay chain is not valid');
      if (frame.events.length === 0) throw new Error('replay returned no events');
      const after = environment.fakeProvider.requestCount();
      if (after !== before) throw new Error(`replay triggered ${after - before} provider request(s)`);
    });

    // ------------------------------------------------------------------
    // Product decision provider + loopback provider + independent inspector
    // ------------------------------------------------------------------
    await report.check('product: decision provider returns a legal action (loopback, $0)', async () => {
      if (!decisionObservation) throw new Error('no authoritative observation captured');
      const providerModule = await import('../../src/llm/decision-provider.js').catch((error) => {
        throw new Error(
          `product decision provider is not importable: ${error instanceof Error ? error.message : String(error)}`
        );
      });
      const provider = new providerModule.ProductDecisionProvider({
        baseUrl: environment.fakeProvider.baseUrl,
        model: FIXTURE_MODEL,
        apiKey: FIXTURE_API_KEY,
        inputUsdMicroPerMillion: 0n,
        outputUsdMicroPerMillion: 0n,
      });
      const outcome = await provider.chooseAction({ observation: decisionObservation });
      const legal = decisionObservation.legalActions.find((action) => action.actionId === outcome.action.actionId);
      if (!legal) throw new Error(`provider chose an action outside the legal menu: ${outcome.action.actionId}`);

      // Independent inspector: exact persisted request bytes vs the canonical
      // SDK observation. It runs immediately, before the capture can be
      // reconciled by anything else.
      const inspection = await inspectPersistedDecision({
        record: {
          requestJson: outcome.request.requestJson,
          model: outcome.request.model,
          promptVersion: outcome.request.promptVersion,
          promptHash: outcome.request.promptHash,
          observationHash: outcome.request.observationHash,
          temperature: outcome.prompt.temperature,
          maxOutputTokens: outcome.prompt.maxOutputTokens,
        },
        observation: decisionObservation,
      });
      if (inspection.error !== undefined) {
        throw new Error(`independent product inspector unavailable: ${inspection.error}`);
      }
      if (!inspection.ok) {
        throw new Error('independent inspector rejected the persisted decision request');
      }
      context.log(`inspector checks: ${inspection.checks.join(', ')}`);
    });

    await report.check('provider: every captured loopback request is structurally exact', async () => {
      assertProviderRequestsExact(environment.fakeProvider, { minimumCount: 1 });
      const { turnIdFromCapturedRequest } = await import('./inspector.js');
      for (const capture of environment.fakeProvider.requests) {
        if (turnIdFromCapturedRequest(capture.body) === null) {
          throw new Error(`captured request ${capture.index} carries no canonical turn id`);
        }
      }
      const before = environment.fakeProvider.requestCount();
      if (decisionObservation) {
        const replayFrame = createdTableId
          ? await human.client.getReplay(createdTableId, { fromEventSeq: 1 })
          : null;
        if (replayFrame && environment.fakeProvider.requestCount() !== before) {
          throw new Error('replay inspection triggered additional provider calls');
        }
      }
    });

    // ------------------------------------------------------------------
    // Actual built NLHE process: strict build, start, probe, restart
    // ------------------------------------------------------------------
    const orchestration = await mintOrchestrationToken(human);
    const agents = await provisionFakeAgentPrincipals(human, 10, {
      delegatedToPrincipalId: orchestration.principalId,
    });
    const roster = await writeFakeAgentRoster(context, {
      baseUrl: environment.fakeProvider.baseUrl,
      principals: agents,
    });
    const build = await report.check('nlhe: strict build from source (no stale dist)', async () => {
      await ensureNlheBuild(context);
    });
    if (build.status === 'PASS') {
      const nlhe = await startNlhe(context, {
        platformBaseUrl: environment.platform.baseUrl,
        openaiBaseUrl: environment.fakeProvider.baseUrl,
        openaiApiKey: FIXTURE_API_KEY,
        openaiModel: FIXTURE_MODEL,
        databasePath: join(context.artifactDir, 'nlhe-product.sqlite'),
        agentsConfigPath: roster.path,
        maxProviderCalls: 200,
        maxCostUsdMicro: 0,
        perCallTimeoutMs: 5000,
        overallRuntimeMs: 300_000,
        maxHands: 20,
        extraEnv: {
          POKERTOOLS_ORCHESTRATION_TOKEN: orchestration.token,
          PRODUCT_ADMIN_TOKEN: productAdminToken(),
        },
      });
      try {
        await report.check('nlhe: actual built process health', async () => {
          const response = await fetch(`${nlhe.baseUrl}${nlhe.healthPath}`);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
        });
        const surface = await probeProductSurface(nlhe.baseUrl);
        context.log(`nlhe product surface: ${describeSurface(surface)}`);
        await report.check('nlhe: mandatory catalog + room orchestration routes', async () => {
          if (!surfaceReady(surface)) throw new Error(describeSurface(surface));
        });
        await report.check('nlhe: product catalog/rooms/stats respond on the real process', async () => {
          const agentsResponse = await fetch(`${nlhe.baseUrl}/api/agents`);
          if (!agentsResponse.ok) throw new Error(`/api/agents HTTP ${agentsResponse.status}`);
          const agentsPayload = (await agentsResponse.json()) as { agents?: unknown[] };
          if (!Array.isArray(agentsPayload.agents)) throw new Error('/api/agents did not return an agent list');
          const roomsResponse = await fetch(`${nlhe.baseUrl}/api/rooms`);
          if (!roomsResponse.ok) throw new Error(`/api/rooms HTTP ${roomsResponse.status}`);
          const roomsPayload = (await roomsResponse.json()) as { rooms?: unknown[] };
          if (!Array.isArray(roomsPayload.rooms)) throw new Error('/api/rooms did not return a room list');
          const statsResponse = await fetch(`${nlhe.baseUrl}/api/stats`);
          if (!statsResponse.ok) throw new Error(`/api/stats HTTP ${statsResponse.status}`);
        });
        await report.check('nlhe: process restart keeps platform topology healthy', async () => {
          await nlhe.restart();
          const platformHealth = await fetch(`${environment.platform.baseUrl}/health`);
          if (!platformHealth.ok) throw new Error(`platform health after NLHE restart: HTTP ${platformHealth.status}`);
          const nlheHealth = await fetch(`${nlhe.baseUrl}${nlhe.healthPath}`);
          if (!nlheHealth.ok) throw new Error(`NLHE health after restart: HTTP ${nlheHealth.status}`);
        });
      } finally {
        await nlhe.stop();
      }
    }

    report.skip(
      'final acceptance: all mandatory rosters through product orchestration',
      'run `tsx tests/integration/run.ts acceptance` (strict, no subset)'
    );
  } finally {
    await environment.stop();
  }
  return report;
}

/**
 * Small public-endpoints smoke: provisions the topology and checks only the
 * public platform + product endpoints. Fast, no provider calls, no rooms.
 */
async function runEndpointsSmoke(): Promise<Report> {
  const context = createRunContext({
    keep: flags.has('--keep'),
    build: flags.has('--force-build') ? 'force' : undefined,
  });
  const report = new Report();
  context.log(`public endpoints smoke ${context.runId}`);
  const environment = await startEnvironment(context, { allowExternal: true });
  let nlhe: Awaited<ReturnType<typeof startNlhe>> | null = null;
  try {
    const admin = await loginWallet(environment.platform.baseUrl, ephemeralWallet());
    const promotion = await ensureOperator(environment.adminTarget, admin);
    if (!promotion.promoted) throw new Error('operator promotion failed');

    await report.check('platform: GET /health + GET /ready (typed)', async () => {
      const health = await admin.client.health();
      if (health.status !== 'ok') throw new Error('platform health is not ok');
      const readiness = await admin.client.getReadiness();
      if (readiness.status !== 'ready' && readiness.status !== 'not_ready') {
        throw new Error(`unexpected readiness status ${String(readiness.status)}`);
      }
    });
    await report.check('platform: GET /auth/me principal', async () => {
      const principal = await admin.client.getPrincipal();
      if (principal.kind !== 'WALLET') throw new Error(`unexpected principal kind ${principal.kind}`);
    });
    await report.check('platform: GET /competitions route is mounted (auth required)', async () => {
      const response = await fetch(`${environment.platform.baseUrl}/competitions/not-a-competition`);
      if (response.status === 404 && (await response.text()).includes('Not Found')) {
        throw new Error('/competitions is not mounted');
      }
    });

    const orchestration = await mintOrchestrationToken(admin);
    const agents = await provisionFakeAgentPrincipals(admin, 2, {
      delegatedToPrincipalId: orchestration.principalId,
    });
    const roster = await writeFakeAgentRoster(context, {
      baseUrl: environment.fakeProvider.baseUrl,
      principals: agents,
    });
    const build = await report.check('product: strict build from source (no stale dist)', async () => {
      await ensureNlheBuild(context);
    });
    if (build.status !== 'PASS') {
      return report;
    }
    nlhe = await startNlhe(context, {
      platformBaseUrl: environment.platform.baseUrl,
      openaiBaseUrl: environment.fakeProvider.baseUrl,
      openaiApiKey: FIXTURE_API_KEY,
      openaiModel: FIXTURE_MODEL,
      databasePath: join(context.artifactDir, 'nlhe-endpoints.sqlite'),
      agentsConfigPath: roster.path,
      maxProviderCalls: 50,
      maxCostUsdMicro: 0,
      extraEnv: {
        POKERTOOLS_ORCHESTRATION_TOKEN: orchestration.token,
        PRODUCT_ADMIN_TOKEN: productAdminToken(),
      },
    });
    await report.check('product: GET /health + /ready only', async () => {
      const health = await fetch(`${nlhe!.baseUrl}/health`);
      if (!health.ok) throw new Error(`/health HTTP ${health.status}`);
      const ready = await fetch(`${nlhe!.baseUrl}/ready`);
      if (ready.status !== 200 && ready.status !== 503) throw new Error(`/ready HTTP ${ready.status}`);
    });
    await report.check('product: GET /api/config + /api/agents + /api/rooms + /api/stats', async () => {
      const product = new ProductClient(nlhe!.baseUrl);
      const config = await product.getConfig();
      if (typeof config.pokerApiUrl !== 'string') throw new Error('/api/config shape is unexpected');
      const agentsPayload = await product.getAgents();
      if (agentsPayload.agents.length !== 2) throw new Error('agent catalog does not list the provisioned agents');
      const rooms = await product.getRooms();
      if (!Array.isArray(rooms.rooms)) throw new Error('/api/rooms did not return a list');
      const stats = await product.getStats();
      if (typeof stats.rooms?.total !== 'number') throw new Error('/api/stats shape is unexpected');
    });
  } finally {
    if (nlhe) await nlhe.stop();
    await environment.stop();
  }
  return report;
}

/**
 * Strict product-room prove: one real 1H1A room created/started by the product
 * and driven by the actual NLHE runtime against the loopback provider, with
 * persisted evidence inspected. Clearly distinct from final acceptance.
 */
async function runRoomProve(): Promise<Report> {
  const context = createRunContext({
    keep: flags.has('--keep'),
    build: flags.has('--force-build') ? 'force' : undefined,
  });
  const report = new Report();
  context.log(`product room prove ${context.runId}`);
  const environment = await startEnvironment(context, { allowExternal: true });
  let nlhe: Awaited<ReturnType<typeof startNlhe>> | null = null;
  try {
    const admin = await loginWallet(environment.platform.baseUrl, ephemeralWallet());
    const promotion = await ensureOperator(environment.adminTarget, admin);
    if (!promotion.promoted) throw new Error('operator promotion failed');
    const orchestrator = await mintOrchestrationToken(admin);
    const agents = await provisionFakeAgentPrincipals(admin, 1, {
      delegatedToPrincipalId: orchestrator.principalId,
    });
    const roster = await writeFakeAgentRoster(context, {
      baseUrl: environment.fakeProvider.baseUrl,
      principals: agents,
    });
    const databasePath = join(context.artifactDir, 'nlhe-room-prove.sqlite');
    await ensureNlheBuild(context);
    nlhe = await startNlhe(context, {
      platformBaseUrl: environment.platform.baseUrl,
      openaiBaseUrl: environment.fakeProvider.baseUrl,
      openaiApiKey: FIXTURE_API_KEY,
      openaiModel: FIXTURE_MODEL,
      databasePath,
      agentsConfigPath: roster.path,
      maxProviderCalls: 5000,
      maxCostUsdMicro: 0,
      perCallTimeoutMs: 5000,
      overallRuntimeMs: 300_000,
      maxHands: 20,
      extraEnv: {
        POKERTOOLS_ORCHESTRATION_TOKEN: orchestrator.token,
        PRODUCT_ADMIN_TOKEN: productAdminToken(),
        AGENT_CHAT_ENABLED: '1',
      },
    });
    const product = new ProductClient(nlhe.baseUrl);
    const surface = await probeProductSurface(nlhe.baseUrl);
    await report.check('room-prove: product surface ready', async () => {
      if (!surfaceReady(surface)) throw new Error(describeSurface(surface));
      const ready = await fetch(`${nlhe!.baseUrl}/ready`);
      if (!ready.ok) throw new Error(`product /ready HTTP ${ready.status}`);
    });
    const humans = [await loginWallet(environment.platform.baseUrl, ephemeralWallet())];
    const spec = ROSTER_MATRIX.find((candidate) => candidate.label === '1H1A')!;
    await report.check('room-prove: product-orchestrated 1H1A room completes with clean evidence', async () => {
      let acceptedHumanActions = 0;
      const result = await runProductRoom({
        spec,
        context,
        environment,
        product,
        humans,
        agentIds: agents.map((agent) => agent.agentId),
        agentPrincipalIds: new Set(agents.map((agent) => agent.principalId)),
        fakeProvider: environment.fakeProvider,
        productDatabasePath: databasePath,
        maxWaitMs: 10 * 60 * 1000,
        // Focused 1H1A gate: zero rate limits under normal pacing, proven by
        // the platform's own /metrics 429 counter (the SDK retries 429s
        // internally, so driver-level counters alone cannot prove zero).
        requireNoRateLimit: true,
        platformMetrics: {
          url: environment.platform.baseUrl,
          token: process.env.NLHE_IT_PLATFORM_METRICS_TOKEN ?? null,
        },
        onHumanAction: () => { acceptedHumanActions += 1; },
      });
      if (acceptedHumanActions === 0) throw new Error('no accepted human canonical action');
      if (!result.evidence.decisions.some(decision => decision.status === 'COMMITTED' && decision.receipt_json !== null)) {
        throw new Error('no accepted deterministic-provider agent canonical action');
      }
      const { CompetitionClient } = await import('@pokertools/sdk');
      const competitions = new CompetitionClient({ baseUrl: environment.platform.baseUrl, token: orchestrator.token });
      const platformRoom = await competitions.getCompetition(result.room.pokerCompetitionId!);
      if (platformRoom.tableId !== result.tableId || !platformRoom.settlementReady) {
        throw new Error('product completion disagrees with authoritative platform state');
      }
      if (result.evidence.decisions.length === 0) throw new Error('no durable agent decisions were recorded');
      if (result.providerRequests !== result.persistedAttempts) {
        throw new Error(
          `provider requests ${result.providerRequests} != persisted attempts ${result.persistedAttempts}`
        );
      }
    });
  } finally {
    if (nlhe) await nlhe.stop();
    await environment.stop();
  }
  return report;
}

/**
 * Focused real-financial prove: provisions the valueless Anvil topology and
 * runs the NONFINANCIAL competition contract plus the ASSET challenge.
 */
async function runFinancialProve(): Promise<Report> {
  const context = createRunContext({
    keep: flags.has('--keep'),
    build: flags.has('--force-build') ? 'force' : undefined,
  });
  const report = new Report();
  context.log(`financial prove ${context.runId}`);
  const sponsorPrincipalId = randomUUID();
  const sponsorAddress = getAccount(2).address;
  const environment = await startEnvironment(context, {
    allowExternal: true,
    financial: { sponsorPrincipalId, sponsorAddress },
  });
  let nlhe: Awaited<ReturnType<typeof startNlhe>> | null = null;
  try {
    const admin = await loginWallet(environment.platform.baseUrl, ephemeralWallet());
    const promotion = await ensureOperator(environment.adminTarget, admin);
    if (!promotion.promoted) throw new Error('operator promotion failed');
    const orchestrator = await mintOrchestrationToken(admin);
    const agents = await provisionFakeAgentPrincipals(admin, 1, {
      delegatedToPrincipalId: orchestrator.principalId,
    });
    const roster = await writeFakeAgentRoster(context, {
      baseUrl: environment.fakeProvider.baseUrl,
      principals: agents,
    });
    const databasePath = join(context.artifactDir, 'nlhe-financial.sqlite');
    await ensureNlheBuild(context);
    nlhe = await startNlhe(context, {
      platformBaseUrl: environment.platform.baseUrl,
      openaiBaseUrl: environment.fakeProvider.baseUrl,
      openaiApiKey: FIXTURE_API_KEY,
      openaiModel: FIXTURE_MODEL,
      databasePath,
      agentsConfigPath: roster.path,
      maxProviderCalls: 200,
      maxCostUsdMicro: 0,
      perCallTimeoutMs: 5000,
      overallRuntimeMs: 300_000,
      maxHands: 20,
      extraEnv: {
        POKERTOOLS_ORCHESTRATION_TOKEN: orchestrator.token,
        PRODUCT_ADMIN_TOKEN: productAdminToken(),
        AGENT_CHAT_ENABLED: '1',
        CHALLENGE_ENABLED: '1',
        CHALLENGE_ASSET_ID: environment.financial!.assetId,
        CHALLENGE_ENTRY_ATOMIC: '1',
        CHALLENGE_PRIZE_ATOMIC: '2',
        CHALLENGE_SPONSOR_PRINCIPAL_ID: environment.financial!.sponsorPrincipalId,
      },
    });
    const product = new ProductClient(nlhe.baseUrl);
    const surface = await probeProductSurface(nlhe.baseUrl);
    await report.check('financial-prove: product surface ready', async () => {
      if (!surfaceReady(surface)) throw new Error(describeSurface(surface));
    });
    const humans = [
      await loginWallet(environment.platform.baseUrl, ephemeralWallet()),
      await loginWallet(environment.platform.baseUrl, ephemeralWallet()),
    ];
    const input = {
      context,
      environment,
      orchestratorToken: orchestrator.token,
      humans,
      admin,
      product,
      nlhe: nlhe!,
      agents,
      productDatabasePath: databasePath,
      fakeProvider: environment.fakeProvider,
    };
    await report.check('financial-prove: NONFINANCIAL competition contract', async () => {
      await runNonfinancialCompetition(input);
    });
    await report.check('financial-prove: valueless Anvil ASSET challenge', async () => {
      await runAnvilChallenge(input);
    });
  } finally {
    if (nlhe) await nlhe.stop();
    await environment.stop();
  }
  return report;
}

async function runDoctor(): Promise<void> {
  const context = createRunContext();
  const report = new Report();
  context.log(`doctor ${context.runId}`);
  const { runCommand } = await import('./infra/proc.js');
  const { isDockerAvailable } = await import('./infra/docker.js');
  await report.check('node >= 24', async () => {
    const major = Number(process.versions.node.split('.')[0]);
    if (major < 24) throw new Error(`node ${process.versions.node}`);
  });
  await report.check('docker daemon reachable', async () => {
    if (!(await isDockerAvailable())) throw new Error('docker daemon unavailable');
  });
  await report.check('host redis-cli available (fallback)', async () => {
    const result = await runCommand('redis-cli', ['--version'], { timeoutMs: 5000 });
    if (result.code !== 0) throw new Error('redis-cli unavailable');
  });
  await report.check('host psql available (external-db admin bootstrap)', async () => {
    const result = await runCommand('psql', ['--version'], { timeoutMs: 5000 });
    if (result.code !== 0) throw new Error('psql unavailable');
  });
  await report.check('playwright chromium installed', async () => {
    const { chromium } = await import('playwright');
    const executable = chromium.executablePath();
    const { existsSync } = await import('node:fs');
    if (!existsSync(executable)) throw new Error(`chromium missing at ${executable}`);
  });
  await report.check('platform SDK extensions', async () => {
    const { PokerClient } = await import('@pokertools/sdk');
    const sdk = detectSdkCapabilities(new PokerClient({ baseUrl: 'http://127.0.0.1:1' }));
    const required = [
      'getPrincipal',
      'getReadiness',
      'createServiceCredential',
      'listServiceCredentials',
      'revokeServiceCredential',
      'getChat',
      'sendChat',
      'getReplay',
    ];
    const missing = required.filter((method) => !sdk.has(method));
    if (missing.length > 0) throw new Error(`missing: ${missing.join(', ')}`);
  });
  await report.check('environment boundary: platform excludes provider secrets; NLHE excludes platform secrets', async () => {
    verifyEnvironmentBoundary();
  });
  await report.check('nlhe build artifacts', async () => {
    const { existsSync } = await import('node:fs');
    if (!existsSync(join(ROOT, 'dist', 'main.js'))) throw new Error('dist/main.js missing (run npm run build)');
  });
  report.print();
  if (report.failures().length > 0) process.exitCode = 1;
}

function runList(): void {
  // eslint-disable-next-line no-console
  console.log(
    [
      'Roster matrix (FINAL acceptance, all mandatory):',
      '  2H    two human wallets over SIWE',
      '  10H   ten human wallets (max table)',
      '  2A    two SERVICE-principal agents',
      '  10A   ten SERVICE-principal agents',
      '  1H1A  heads-up human vs agent',
      '  2H2A  mixed four-seat',
      '  1H9A  full ten-seat',
      '',
      'Commands:',
      '  npm run test:integration                # focused offline smoke (not final)',
      '  tsx tests/integration/run.ts endpoints  # small public-endpoints smoke',
      '  tsx tests/integration/run.ts room-prove # strict single 1H1A product room',
      '  tsx tests/integration/run.ts financial  # real Anvil valueless ASSET challenge',
      '  tsx tests/integration/run.ts acceptance # FINAL: all mandatory, strict, no subset',
      '  tsx tests/integration/run.ts browser    # standalone browser acceptance',
      '  tsx tests/integration/run.ts doctor',
      '  tsx tests/integration/live.ts           # opt-in paid provider (NLHE_LIVE_ENABLED=1)',
      '',
      'Interfaces (public SDK only): PokerClient getPrincipal/getReadiness/',
      '  createServiceCredential/listServiceCredentials/revokeServiceCredential/',
      '  createTable/buyIn/getObservation/action/getChat/sendChat/getReplay,',
      '  PokerSocket, CompetitionClient createCompetition/getCompetition/optIn/',
      '  start/settle/cancel/issueAgentCredential; chip grants use',
      '  the canonical POST /chips/grant contract.',
      '',
      'PokerTools 2.0.0 is externally deployed; NLHE builds are strict:',
      'a red product build fails and no last-green dist is ever executed.',
    ].join('\n')
  );
}

async function main(): Promise<void> {
  switch (command) {
    case 'smoke': {
      const report = await runSmoke();
      report.print();
      process.exitCode = report.failures().length > 0 ? 1 : 0;
      return;
    }
    case 'doctor':
      await runDoctor();
      return;
    case 'list':
      runList();
      return;
    case 'env-boundary': {
      const { checks } = verifyEnvironmentBoundary();
      // eslint-disable-next-line no-console
      console.log(`environment boundary passed: ${checks.join(', ')}`);
      return;
    }
    case 'endpoints': {
      const report = await runEndpointsSmoke();
      report.print();
      process.exitCode = report.failures().length > 0 ? 1 : 0;
      return;
    }
    case 'room-prove': {
      const report = await runRoomProve();
      report.print();
      process.exitCode = report.failures().length > 0 ? 1 : 0;
      return;
    }
    case 'financial': {
      const report = await runFinancialProve();
      report.print();
      process.exitCode = report.failures().length > 0 ? 1 : 0;
      return;
    }
    case 'acceptance': {
      const { runAcceptance } = await import('./acceptance/run.js');
      const code = await runAcceptance({ keep: flags.has('--keep') });
      process.exitCode = code;
      return;
    }
    case 'browser': {
      const { runBrowserSmoke } = await import('../browser/run.js');
      const code = await runBrowserSmoke({ keep: flags.has('--keep') });
      process.exitCode = code;
      return;
    }
    default:
      usage();
      process.exitCode = 2;
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  });
}
