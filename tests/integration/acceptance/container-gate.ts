/**
 * Deterministic standalone-container gate (fresh staging topology).
 *
 * Exactly one 1H1A SPONSORED room is created and started by the product's own
 * orchestration against the loopback deterministic provider. No paid provider
 * is ever contacted (all provider URLs are loopback and asserted as such).
 *
 * The gate proves, on the ACTUAL built container with persistent SQLite:
 * - restart #1 (graceful) while the room is ACTIVE, after the first stored
 *   provider exchange;
 * - restart #2 (SIGKILL) only after recovered activity following restart #1;
 * - stored successes never duplicate: each provider turn is exchanged exactly
 *   once, attempt identities are unique, committed receipts are unique, and
 *   replay event request ids are unique;
 * - SQLite and platform state independently preserve the same room/table and
 *   the same accepted-action identities;
 * - an explicit safe platform outage (Redis paused): platform and product
 *   `/health` stay 200 while `/ready` returns 503, then `/ready` recovers to
 *   200 without restarting the product container (container identity kept);
 * - the SPONSORED authority creates no financial transitions across restarts.
 *
 * Artifacts are metadata + redacted logs only. The container SQLite backup is
 * read from the runtime directory outside captured artifacts.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { RunContext } from '../infra/context.js';
import { FIXTURE_API_KEY, FIXTURE_MODEL } from '../infra/fixtures.js';
import { startFakeProvider, parseDecisionRequest, type FakeProviderHandle } from '../infra/fake-provider.js';
import { waitFor } from '../infra/gameplay.js';
import { writeFakeAgentRoster } from '../infra/nlhe.js';
import { ensureOperator } from '../infra/admin.js';
import {
  mintOrchestrationToken,
  productAdminToken,
  provisionFakeAgentPrincipals,
} from '../infra/agents.js';
import { ephemeralWallet, loginWallet, type WalletSession } from '../infra/wallet.js';
import { startStandaloneContainer, type StandaloneContainerHandle } from '../infra/standalone-container.js';
import type { StagingTopology } from '../infra/staging.js';
import type { TestEnvironment } from '../infra/environment.js';
import type { ProductRoomView } from './product-client.js';
import { ProductClient } from './product-client.js';
import { runProductRoom } from './product-room.js';
import { inspectRoomEvidence, readRoomEvidence, type RoomEvidence } from './evidence.js';
import type { RosterSpec } from './roster.js';
import { readPlatform429Total } from './platform-metrics.js';
import { adminDatabaseQuery, captureFinancialJournalEvidence } from './financial-journals.js';

export interface ContainerGateOptions {
  context: RunContext;
  topology: StagingTopology;
  /** Optional pre-teardown step (for example real-browser acceptance). */
  onBeforeStop?: (productBaseUrl: string, databasePath: string) => Promise<void>;
}

export interface ContainerGateResult {
  roomId: string;
  tableId: string;
  providerRequests: number;
  decisions: number;
  committed: number;
  restartModes: Array<'graceful' | 'kill'>;
  restartEvidence: Array<{ index: number; storedSuccesses: number; storedReceipts: number; identityBefore: Record<string, unknown>; identityAfter: Record<string, unknown>; authorityPreserved: boolean; financialTransitions: number }>;
  outage: { platformHealth: number; platformReadyBefore: number; platformReadyAfter: number; productHealth: number; productReadyBefore: number; productReadyAfter: number };
  fingerprint: string;
}

interface StoredFingerprint {
  roomStatus: string;
  tableId: string | null;
  decisions: string[];
  receipts: string[];
  attempts: string[];
  providerRequests: number;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function fingerprint(evidence: RoomEvidence, providerRequests: number): StoredFingerprint {
  return {
    roomStatus: evidence.room.status,
    tableId: evidence.room.table_id,
    decisions: evidence.decisions.map((decision) => `${decision.id}:${decision.status}`).sort(),
    receipts: evidence.decisions
      .filter((decision) => decision.receipt_json !== null)
      .map((decision) => `${decision.id}:${sha256(decision.receipt_json!)}`)
      .sort(),
    attempts: evidence.attempts
      .map((attempt) => `${attempt.decision_id}:${attempt.attempt_no}:${attempt.status}`)
      .sort(),
    providerRequests,
  };
}

function assertSameFingerprint(label: string, before: StoredFingerprint, after: StoredFingerprint): void {
  const beforeJson = JSON.stringify(before);
  const afterJson = JSON.stringify(after);
  if (beforeJson !== afterJson) {
    throw new Error(`${label}: stored state changed across the boundary\nbefore=${beforeJson}\nafter=${afterJson}`);
  }
}

/** Every provider turn must be exchanged exactly once; duplicates fail. */
function assertNoDuplicateProviderTurns(provider: FakeProviderHandle): number {
  const counts = new Map<string, number>();
  for (const record of provider.requests) {
    const parsed = parseDecisionRequest(record.body) as { observation?: { turnId?: unknown } };
    const turnId = parsed.observation?.turnId;
    if (typeof turnId !== 'string' || turnId.length === 0) continue;
    counts.set(turnId, (counts.get(turnId) ?? 0) + 1);
  }
  const duplicates = [...counts.entries()].filter(([, count]) => count !== 1);
  if (duplicates.length > 0) {
    throw new Error(
      `provider turn duplication: ${duplicates.map(([turnId, count]) => `${turnId}x${count}`).join(',')}`
    );
  }
  return counts.size;
}

function assertEvidenceIntegrity(evidence: RoomEvidence, provider: FakeProviderHandle, tableId: string): number {
  const decisionIds = new Set(evidence.decisions.map((decision) => decision.id));
  if (decisionIds.size !== evidence.decisions.length) throw new Error('duplicate decision identities in SQLite');
  const attemptKeys = new Set(evidence.attempts.map((attempt) => `${attempt.decision_id}:${attempt.attempt_no}`));
  if (attemptKeys.size !== evidence.attempts.length) throw new Error('duplicate attempt identities in SQLite');
  const receiptHashes = new Set(
    evidence.decisions.filter((decision) => decision.receipt_json !== null).map((decision) => sha256(decision.receipt_json!))
  );
  if (receiptHashes.size !== evidence.decisions.filter((decision) => decision.receipt_json !== null).length) {
    throw new Error('identical committed receipts recorded more than once');
  }
  const committed = evidence.decisions.filter((decision) => decision.status === 'COMMITTED');
  if (committed.length === 0 || committed.every((decision) => decision.receipt_json === null)) {
    throw new Error('no COMMITTED decision carries a stored receipt');
  }
  const providerRequests = provider.requestCountForTable(tableId);
  const persistedAttempts = evidence.attempts.filter((attempt) => attempt.recorded_at !== null).length;
  if (providerRequests !== persistedAttempts) {
    throw new Error(`provider requests ${providerRequests} != persisted attempts ${persistedAttempts}`);
  }
  return providerRequests;
}

async function assertPlatformPreservation(
  topology: StagingTopology,
  admin: WalletSession,
  tableId: string,
  competitionId: string
): Promise<void> {
  const { CompetitionClient } = await import('@pokertools/sdk');
  const replay = await admin.client.getReplay(tableId, { fromEventSeq: 1 });
  if (!replay.chainValid) throw new Error('platform replay chain is invalid');
  const requestIds = replay.events
    .map((event) => (event as { requestId?: string | null }).requestId)
    .filter((requestId): requestId is string => typeof requestId === 'string' && requestId.length > 0);
  if (new Set(requestIds).size !== requestIds.length) {
    throw new Error('platform replay contains duplicate accepted-action request ids');
  }
  if (requestIds.length === 0) throw new Error('platform replay recorded no accepted-action identity');
  const competition = await new CompetitionClient({
    baseUrl: topology.platformUrl,
    token: admin.token,
    timeout: 30_000,
  }).getCompetition(competitionId);
  if (competition.tableId !== tableId) {
    throw new Error(`platform competition table ${competition.tableId} != product table ${tableId}`);
  }
}

function assertLoopback(url: string, label: string): void {
  const host = new URL(url).hostname;
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new Error(`${label} must be loopback for the deterministic gate, saw ${host}`);
  }
}

export async function runContainerGate(options: ContainerGateOptions): Promise<ContainerGateResult> {
  const { context, topology } = options;
  const supervisor = topology.supervisor;
  const platform429Before = await readPlatform429Total(topology.platformMetrics);
  if (platform429Before !== 0) throw new Error('fresh platform already recorded HTTP 429 responses');
  assertLoopback(topology.platformUrl, 'platform URL');
  // Preserve an active room long enough to prove both restarts and reconnect;
  // the existing fixture switches to terminal-driving play after twelve turns.
  const provider = await startFakeProvider({ mode: 'fold', aggressiveAfter: 12 });
  assertLoopback(provider.baseUrl, 'provider URL');
  context.log(`deterministic loopback provider at ${provider.baseUrl} (no paid calls)`);

  let runtime: StandaloneContainerHandle | null = null;
  try {
    const admin = await loginWallet(topology.platformUrl, ephemeralWallet());
    const promotion = await ensureOperator(topology.adminTarget, admin);
    if (!promotion.promoted) throw new Error('container gate operator wallet was not promoted to ADMIN');
    const orchestrator = await mintOrchestrationToken(admin);
    const agents = await provisionFakeAgentPrincipals(admin, 2, {
      delegatedToPrincipalId: orchestrator.principalId,
    });
    const roster = await writeFakeAgentRoster(context, {
      baseUrl: provider.baseUrl,
      principals: agents,
    });
    const adminToken = productAdminToken();
    topology.addProductSecret('PRODUCT_ADMIN_TOKEN', adminToken);
    topology.addProductSecret('POKERTOOLS_ORCHESTRATION_TOKEN', orchestrator.token);
    topology.addProductSecret('OPENAI_API_KEY', FIXTURE_API_KEY);
    const platformContainerHost = topology.platform.finance?.apiContainerName;
    if (!platformContainerHost) throw new Error('staging fixture must expose the API container identity for direct service routing');

    const databasePath = join(context.artifactDir, 'nlhe-gate.sqlite');
    runtime = await startStandaloneContainer({
      supervisor,
      context,
      runtimeDir: topology.runtimeDir,
      secretRegistry: topology.secretRegistry,
      productImage: topology.productImage,
      dockerNetwork: topology.network,
      platformContainerHost,
      platformUrl: topology.platformUrl,
      productUrl: topology.productUrl,
      providerBaseUrl: provider.baseUrl,
      providerApiKey: FIXTURE_API_KEY,
      providerModel: FIXTURE_MODEL,
      orchestrationToken: orchestrator.token,
      productAdminToken: adminToken,
      agentsConfigPath: roster.path,
      databasePath,
      maxProviderCalls: 5_000,
      maxHands: 40,
      extraEnv: { CHALLENGE_ENABLED: '0' },
    });
    await supervisor.assertAllAlive('standalone container start');

    const product = new ProductClient(runtime.baseUrl, { adminToken });
    const spec: RosterSpec = { label: '1H1A', humans: 1, agents: 1, seats: 2 };
    const human = await loginWallet(topology.platformUrl, ephemeralWallet());

    // The product-room runner receives a minimal real-environment facade; the
    // platform stays externally owned by the staging fixture.
    const environment: TestEnvironment = {
      context,
      platform: {
        baseUrl: topology.platformUrl,
        port: Number(new URL(topology.platformUrl).port),
        databaseUrl: topology.databaseUrl,
        redisUrl: topology.redisUrl,
        stop: async () => undefined,
      },
      fakeProvider: provider,
      postgres: null,
      redis: null,
      adminTarget: topology.adminTarget,
      reusedExternalPlatform: true,
      financial: null,
      stop: async () => undefined,
    };

    let tableId: string | null = null;
    let providerAtRestart1 = 0;
    let decisionsAtRestart1 = 0;
    let restart2Done = false;
    const restartModes: Array<'graceful' | 'kill'> = [];
    const restartEvidence: ContainerGateResult['restartEvidence'] = [];
    const assertNonfinancialAuthority = async (competitionId: string): Promise<void> => {
      const state = await captureFinancialJournalEvidence(adminDatabaseQuery(topology.adminTarget), competitionId);
      if (state.competition.mode !== 'NONFINANCIAL' || state.journals.length !== 0 ||
          state.competition.prizeReservationJournalId !== null || state.competition.prizeSettlementJournalId !== null ||
          state.entrants.some((entrant) => entrant.entryJournalId !== null || entrant.entrySettlementJournalId !== null || entrant.refundJournalId !== null)) {
        throw new Error('SPONSORED authority unexpectedly created a financial transition');
      }
    };
    const restartAndProve = async (room: ProductRoomView, before: RoomEvidence, mode: 'graceful' | 'kill'): Promise<void> => {
      if (room.pokerCompetitionId === null) throw new Error('active room lacks platform competition authority');
      await assertNonfinancialAuthority(room.pokerCompetitionId);
      const identityBefore = await runtime!.unit.identity();
      const replayBefore = await admin.client.getReplay(tableId!, { fromEventSeq: 1 });
      const attempts = before.attempts.filter((attempt) => attempt.status === 'SUCCEEDED');
      const receipts = before.decisions.filter((decision) => decision.status === 'COMMITTED');
      await runtime!.restart(mode);
      const identityAfter = await runtime!.unit.identity();
      if (identityBefore.startedAt === identityAfter.startedAt) throw new Error('restart did not change the container process identity');
      const after = readRoomEvidence(databasePath, room.id);
      if (after.room.table_id !== before.room.table_id || after.room.platform_competition_id !== before.room.platform_competition_id) {
        throw new Error('SQLite authority references changed across restart');
      }
      for (const attempt of attempts) {
        if (JSON.stringify(after.attempts.find((candidate) => candidate.id === attempt.id)) !== JSON.stringify(attempt)) {
          throw new Error('stored successful provider attempt changed across restart');
        }
      }
      for (const decision of receipts) {
        const recovered = after.decisions.find((candidate) => candidate.id === decision.id);
        if (recovered?.status !== 'COMMITTED' || recovered.receipt_json !== decision.receipt_json) throw new Error('stored canonical receipt changed across restart');
      }
      assertNoDuplicateProviderTurns(provider);
      const replayAfter = await admin.client.getReplay(tableId!, { fromEventSeq: 1 });
      if (!replayAfter.chainValid || replayBefore.events.some((event) => !replayAfter.events.some((candidate) => candidate.eventSeq === event.eventSeq && candidate.requestId === event.requestId))) {
        throw new Error('independent platform action authority changed across restart');
      }
      await assertNonfinancialAuthority(room.pokerCompetitionId);
      restartEvidence.push({ index: restartEvidence.length + 1, storedSuccesses: attempts.length, storedReceipts: receipts.length, identityBefore, identityAfter, authorityPreserved: true, financialTransitions: 0 });
      restartModes.push(mode);
    };

    const result = await runProductRoom({
      spec,
      context,
      environment,
      product,
      humans: [human],
      agentIds: agents.map((agent) => agent.agentId),
      agentPrincipalIds: new Set(agents.map((agent) => agent.principalId)),
      fakeProvider: provider,
      productDatabasePath: databasePath,
      requireNoRateLimit: true,
      platformMetrics: topology.platformMetrics,
      passiveHumanIntro: { untilProviderRequests: 12 },
      maxWaitMs: 10 * 60 * 1000,
      onActive: async (room: ProductRoomView) => {
        tableId = room.pokerTableId;
        if (tableId === null) throw new Error('ACTIVE room has no table id');
      },
      onTick: async (room: ProductRoomView) => {
        if (restart2Done || tableId === null) return;
        if (room.status === 'COMPLETE' || room.status === 'FAILED') return;
        const evidence = readRoomEvidence(databasePath, room.id);
        if (!evidence.attempts.some((attempt) => attempt.status === 'SUCCEEDED') ||
            !evidence.decisions.some((decision) => decision.status === 'COMMITTED')) return;
        if (evidence.attempts.some((attempt) => attempt.status === 'PENDING')) return;
        const currentProvider = provider.requestCountForTable(tableId);
        if (restartModes.length === 0) {
          context.log(`restart #1 (graceful) while room ${room.id} is ACTIVE with stored successful canonical action`);
          await restartAndProve(room, evidence, 'graceful');
          providerAtRestart1 = currentProvider;
          decisionsAtRestart1 = evidence.decisions.length;
          await supervisor.assertAllAlive('after restart #1');
          return;
        }
        if (currentProvider > providerAtRestart1 && evidence.decisions.length > decisionsAtRestart1) {
          context.log('recovered activity after restart #1: restart #2 (SIGKILL)');
          await restartAndProve(room, evidence, 'kill');
          restart2Done = true;
          await supervisor.assertAllAlive('after restart #2');
        }
      },
    });
    if (restartModes.length !== 2) {
      throw new Error(`expected exactly two restarts, saw ${restartModes.length} (${restartModes.join(',')})`);
    }
    if (result.room.status !== 'COMPLETE') throw new Error(`room ended ${result.room.status}`);
    if (tableId === null) throw new Error('room completed without a table id');
    if (result.room.pokerCompetitionId === null) throw new Error('room completed without a competition id');

    const persistedRequests = assertEvidenceIntegrity(result.evidence, provider, tableId);
    const turns = assertNoDuplicateProviderTurns(provider);
    context.log(
      `room ${result.room.id} COMPLETE: providerRequests=${persistedRequests} turns=${turns} committed=${result.evidence.decisions.filter((d) => d.status === 'COMMITTED').length}`
    );
    const baseline = fingerprint(result.evidence, persistedRequests);

    // Container-stored evidence (read from a backup copied outside artifacts)
    // must match the product SQLite view exactly.
    const backupPath = join(topology.runtimeDir, 'container-evidence.sqlite');
    await runtime.backupEvidence(backupPath);
    assertSameFingerprint('container SQLite backup', baseline, fingerprint(readRoomEvidence(backupPath, result.room.id), persistedRequests));

    const inspection = await inspectRoomEvidence(result.evidence, {
      agentPrincipalIds: new Set(agents.map((agent) => agent.principalId)),
    });
    if (inspection.violations.length > 0) {
      throw new Error(`evidence violations: ${inspection.violations[0]!.detail}`);
    }

    await assertPlatformPreservation(topology, admin, tableId, result.room.pokerCompetitionId);

    // This gate is SPONSORED/nonfinancial. Deposit/classification/settlement
    // belong to the separately guarded fresh CHALLENGE, not this browser gate.
    await assertNonfinancialAuthority(result.room.pokerCompetitionId);

    // Explicit safe platform outage: Redis stops, readiness degrades, both
    // health surfaces stay live, recovery restores readiness with no product
    // restart and no stored-state change.
    const identityBefore = await runtime.unit.identity();
    await supervisor.pause(topology.redisContainer);
    const platformReadyBefore = await waitFor(
      'platform /ready 503 during Redis outage',
      async () => {
        const response = await fetch(`${topology.platformUrl}/ready`, { signal: AbortSignal.timeout(10_000) });
        return response.status === 503 ? response.status : null;
      },
      { timeoutMs: 90_000, intervalMs: 1_000 }
    );
    const platformHealth = (await fetch(`${topology.platformUrl}/health`)).status;
    if (platformHealth !== 200) throw new Error(`platform /health ${platformHealth} != 200 during outage`);
    const productReadyBefore = await waitFor(
      'product /ready 503 during Redis outage',
      async () => {
        const state = await runtime!.healthState();
        return state.ready === 503 ? state.ready : null;
      },
      { timeoutMs: 90_000, intervalMs: 1_000 }
    );
    const productHealth = (await runtime.healthState()).health;
    if (productHealth !== 200) throw new Error(`product /health ${productHealth} != 200 during outage`);

    await supervisor.resume(topology.redisContainer);
    const platformReadyAfter = await waitFor(
      'platform /ready recovery after Redis restart',
      async () => {
        const response = await fetch(`${topology.platformUrl}/ready`, { signal: AbortSignal.timeout(10_000) });
        return response.ok ? response.status : null;
      },
      { timeoutMs: 120_000, intervalMs: 1_000 }
    );
    const productReadyAfter = await waitFor(
      'product /ready recovery after Redis restart',
      async () => {
        const state = await runtime!.healthState();
        return state.ready === 200 ? state.ready : null;
      },
      { timeoutMs: 120_000, intervalMs: 1_000 }
    );
    const identityAfter = await runtime.unit.identity();
    if (identityAfter.containerId !== identityBefore.containerId || identityAfter.startedAt !== identityBefore.startedAt) {
      throw new Error('product container restarted during outage/recovery (identity changed)');
    }
    await supervisor.assertAllAlive('after outage/recovery');

    const afterOutage = fingerprint(readRoomEvidence(databasePath, result.room.id), provider.requestCountForTable(tableId));
    assertSameFingerprint('after outage/recovery', baseline, afterOutage);
    context.log(
      `outage/recovery: platform /health=${platformHealth} /ready ${platformReadyBefore}->${platformReadyAfter}; product /health=${productHealth} /ready ${productReadyBefore}->${productReadyAfter}; no product restart`
    );

    const committed = result.evidence.decisions.filter((decision) => decision.status === 'COMMITTED').length;
    const gateResult: ContainerGateResult = {
      roomId: result.room.id,
      tableId,
      providerRequests: persistedRequests,
      decisions: result.evidence.decisions.length,
      committed,
      restartModes,
      restartEvidence,
      outage: {
        platformHealth,
        platformReadyBefore,
        platformReadyAfter,
        productHealth,
        productReadyBefore,
        productReadyAfter,
      },
      fingerprint: sha256(JSON.stringify(baseline)),
    };
    if (options.onBeforeStop) {
      // The browser creates a second, independent room. Keep operator/recovery
      // traffic from the first scenario out of that client's minute budget;
      // no active gameplay or paid runtime is delayed by this staging boundary.
      if (await readPlatform429Total(topology.platformMetrics) !== 0) throw new Error('unexpected platform HTTP 429 before browser phase');
      context.log('pacing independent browser phase after the previous API minute window');
      await new Promise((resolve) => setTimeout(resolve, 60_000));
      await options.onBeforeStop(runtime.baseUrl, databasePath);
    }
    const platform429After = await readPlatform429Total(topology.platformMetrics);
    if (platform429After !== 0) throw new Error(`normal deterministic/browser driver produced ${platform429After} platform HTTP 429 responses`);
    await supervisor.assertAllAlive('complete deterministic gate');
    context.log(`container gate PASS: ${JSON.stringify(gateResult)}`);
    return gateResult;
  } finally {
    try {
      await runtime?.stop();
    } finally {
      await provider.stop();
    }
  }
}
