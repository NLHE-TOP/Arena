/**
 * Financial acceptance for the generic competition surface.
 *
 * Part 1: the public NONFINANCIAL competition contract end-to-end through
 * `CompetitionClient` with a real orchestration credential.
 *
 * Part 2: the mandatory valueless ASSET challenge. It runs on the real
 * topology provisioned by `startFinancialTopology` (real Anvil, in-tree
 * MockUSDC, two quorum proxies, declared Asset/sponsor fixtures backed by the
 * deployed token, actual custody worker heartbeats + reconciliation). Balances
 * come only from real on-chain transfers claimed through the public
 * `PokerClient.claimDeposit`; readiness is polled from `/ready`; entry/prize
 * run entirely through the public SDK and product challenge policy; settlement
 * is asserted exactly once across an actual product restart.
 */
import { CompetitionClient, PokerClient } from '@pokertools/sdk';
import { randomUUID } from 'node:crypto';
import type { TestEnvironment } from '../infra/environment.js';
import type { RunContext } from '../infra/context.js';
import type { WalletSession } from '../infra/wallet.js';
import { loginWallet } from '../infra/wallet.js';
import type { ProvisionedAgent } from '../infra/agents.js';
import type { FakeProviderHandle } from '../infra/fake-provider.js';
import { getAccount } from '../../../pokertools/packages/e2e/tests/finance/helpers/anvil-two-chain.js';
import type { ProductClient } from './product-client.js';
import { runProductRoom } from './product-room.js';
import { ROSTER_MATRIX } from './roster.js';
import { waitFor } from '../infra/gameplay.js';
import type { ActionProxyHandle } from '../infra/action-proxy.js';

export interface FinancialChallengeInput {
  context: RunContext;
  environment: TestEnvironment;
  orchestratorToken: string;
  humans: readonly WalletSession[];
  admin: WalletSession;
  product: ProductClient;
  nlhe: { restart: () => Promise<void>; kill?: () => Promise<void> };
  lifecycleProxy?: ActionProxyHandle;
  agents: ProvisionedAgent[];
  productDatabasePath: string;
  fakeProvider: FakeProviderHandle;
}

/** Public NONFINANCIAL competition contract: create -> read -> start. */
export async function runNonfinancialCompetition(input: FinancialChallengeInput): Promise<void> {
  const competitions = new CompetitionClient({
    baseUrl: input.environment.platform.baseUrl,
    token: input.orchestratorToken,
    timeout: 30_000,
  });
  const [first, second] = input.humans;
  if (!first || !second) throw new Error('financial checks need at least two human wallets');

  const created = await competitions.createCompetition({
    name: `accept-nonfinancial-${randomUUID().slice(0, 8)}`,
    mode: 'NONFINANCIAL',
    entrants: [
      { principalId: first.userId, kind: 'WALLET' },
      { principalId: second.userId, kind: 'WALLET' },
    ],
    idempotencyKey: `accept-nonfinancial:${randomUUID()}`,
  });
  const competition = await competitions.getCompetition(created.competition.id);
  if (competition.entrants.length !== 2) throw new Error('competition roster is incomplete');

  const started = await competitions.start(competition.id);
  if (!started.tableId) throw new Error('competition start returned no table');
  if (started.seats.length !== 2) throw new Error('competition start returned incomplete seats');
  input.context.log(`nonfinancial competition ${competition.id} active on table ${started.tableId}`);
}

function availableBalance(balances: Awaited<ReturnType<WalletSession['client']['getBalances']>>, assetId: string): bigint {
  const row = balances.find((balance) => balance.assetId === assetId);
  return row ? BigInt(row.availableAtomic) : 0n;
}

/**
 * Boundary assertion for the PT credential-seat fix: an agent credential
 * issued without an explicit seat must be table-only (`seat === null`), not
 * silently defaulted to the entrant's current seat (which breaks cached replay
 * for eliminated SERVICE principals). Fails until the PT fix lands.
 */
export async function assertTableOnlyAgentCredential(input: FinancialChallengeInput & { servicePrincipalId: string }): Promise<void> {
  const competitions = new CompetitionClient({
    baseUrl: input.environment.platform.baseUrl,
    token: input.orchestratorToken,
    timeout: 30_000,
  });
  const human = input.humans[0];
  if (!human) throw new Error('seat-null assertion needs a human wallet entrant');
  const created = await competitions.createCompetition({
    name: `accept-seat-null-${randomUUID().slice(0, 8)}`,
    mode: 'NONFINANCIAL',
    entrants: [
      { principalId: human.userId, kind: 'WALLET' },
      { principalId: input.servicePrincipalId, kind: 'SERVICE' },
    ],
    idempotencyKey: `accept-seat-null:${randomUUID()}`,
  });
  await competitions.start(created.competition.id);
  const issued = await competitions.issueAgentCredential(created.competition.id, {
    principalId: input.servicePrincipalId,
    name: 'it-table-only-credential',
  });
  if (issued.seat !== null) {
    throw new Error(
      `table-only agent credential defaulted to a seat (${String(issued.seat)}); expected null for table-only refs`
    );
  }
  const agent = new PokerClient({ baseUrl: input.environment.platform.baseUrl, token: issued.token });
  if ((await agent.getPrincipal()).id !== input.servicePrincipalId) throw new Error('agent credential changed durable identity');
  const rotated = await competitions.issueAgentCredential(created.competition.id, {
    principalId: input.servicePrincipalId, name: 'it-table-only-rotated', credentialId: issued.credentialId,
  });
  if (!rotated.rotated || rotated.seat !== null || rotated.principalId !== issued.principalId) throw new Error('rotation changed credential scope/identity');
  let oldRejected = false;
  try { await agent.getPrincipal(); } catch { oldRejected = true; }
  if (!oldRejected) throw new Error('rotated old credential is still accepted');
  agent.setToken(rotated.token);
  if ((await agent.getPrincipal()).id !== input.servicePrincipalId) throw new Error('rotated identity changed');
  await input.admin.client.revokeServiceCredential(rotated.credentialId);
  let revoked = false;
  try { await agent.getPrincipal(); } catch { revoked = true; }
  if (!revoked) throw new Error('revoked credential is still accepted');
  if (!(await competitions.getCompetition(created.competition.id)).entrants.some((entrant) => entrant.principalId === issued.principalId)) {
    throw new Error('revocation changed the durable entrant identity');
  }
}
export async function runAnvilChallenge(input: FinancialChallengeInput): Promise<void> {
  const financial = input.environment.financial;
  if (!financial) {
    throw new Error(
      'blocked: the valueless Anvil challenge requires NLHE_IT_ANVIL=1 so the harness provisions the real topology (Anvil + MockUSDC + quorum proxies + custody worker) before the platform starts'
    );
  }
  const platformBaseUrl = input.environment.platform.baseUrl;

  // Deterministic Anvil-funded wallets: index 1 pays the entry, index 2 is the
  // pre-seeded prize sponsor. Both are real on-chain token holders.
  const payerSession = await loginWallet(platformBaseUrl, getAccount(1));
  const sponsorSession = await loginWallet(platformBaseUrl, getAccount(2));
  if (sponsorSession.userId !== financial.sponsorPrincipalId) {
    throw new Error('sponsor wallet did not resolve to the pre-seeded sponsor principal');
  }

  const config = (await input.product.getConfig()) as {
    challenge?: {
      enabled?: boolean;
      terms?: { assetId?: string; entryAtomic?: string; prizeAtomic?: string; termsVersion?: string };
    };
    assets?: Array<{ assetId?: string; entryAtomic?: string; prizeAtomic?: string; termsVersion?: string }>;
  };
  // The current product projection exposes challenge terms as the assets list;
  // the nested `challenge` shape is accepted too so the harness tolerates the
  // documented transition.
  const challengeTerms = config.challenge?.terms ?? config.assets?.[0];
  const challengeEnabled = config.challenge?.enabled === true || (config.assets?.length ?? 0) > 0;
  if (!challengeEnabled || !challengeTerms?.assetId || !challengeTerms.entryAtomic || !challengeTerms.prizeAtomic) {
    throw new Error(
      `product challenge terms are not enabled/configured: ${JSON.stringify({ config, financialAsset: financial.assetId })}`
    );
  }
  if (challengeTerms.assetId !== financial.assetId) {
    throw new Error('product challenge asset does not match the provisioned valueless asset');
  }

  // Real on-chain backing for exactly the claimed amounts: payer funds the
  // entry, sponsor funds the prize. Every balance below comes from a public
  // claim of an exact on-chain Transfer log.
  const entryAtomic = BigInt(challengeTerms.entryAtomic);
  const prizeAtomic = BigInt(challengeTerms.prizeAtomic);
  await financial.fundAndClaim(payerSession, 1, entryAtomic);
  // The API caches one lazy deposit-verifier registry per process. Restart only
  // the API process between the two public claims so the second claim cannot
  // inherit a poisoned cached registry (workers and the platform stay up).
  await input.environment.platform.restartApi?.();
  await financial.fundAndClaim(sponsorSession, 2, prizeAtomic);
  input.context.log('on-chain payer/sponsor transfers claimed through the public API');

  const payerBefore = availableBalance(await payerSession.client.getBalances(), financial.assetId);
  if (payerBefore !== entryAtomic) throw new Error(`payer available ${payerBefore} != entry ${entryAtomic}`);
  const sponsorBefore = await financial.readPrincipalAccounts(financial.sponsorPrincipalId);
  if (sponsorBefore.available !== prizeAtomic || sponsorBefore.operator !== 0n) {
    throw new Error(
      `sponsor claimed funds are not USER_AVAILABLE=${sponsorBefore.available}/OPERATOR=${sponsorBefore.operator} as expected before bootstrap`
    );
  }

  // Declared infrastructure fixture ONLY (documented): classify the already
  // claimed prize budget from the sponsor's USER_AVAILABLE to the same
  // principal's OPERATOR account, which is what the platform prize reserve
  // debits. Balanced and idempotent; it creates no value, touches no payer
  // balance and no entry/prize/settlement row.
  const sponsorBudget = await financial.bootstrapSponsorBudget(prizeAtomic);
  if (sponsorBudget.available !== 0n || sponsorBudget.operator !== prizeAtomic) {
    throw new Error(
      `sponsor budget bootstrap failed: available=${sponsorBudget.available} operator=${sponsorBudget.operator}`
    );
  }
  input.context.log('declared sponsor budget fixture classification applied (USER_AVAILABLE -> OPERATOR)');

  // Only now start the ACTUAL custody worker: it produces heartbeats and
  // matched reconciliation evidence without ever observing the transient
  // transfer/claim window (which would open a shortfall incident and freeze the
  // asset before the paid flow begins).
  await financial.startCustody();
  await financial.waitForReady();

  await runPrestartCancellation(input, payerSession, entryAtomic, prizeAtomic);

  const spec = ROSTER_MATRIX.find((candidate) => candidate.label === '1H1A')!;
  const result = await runProductRoom({
    spec,
    context: input.context,
    environment: input.environment,
    product: input.product,
    humans: [payerSession],
    agentIds: input.agents.map((agent) => agent.agentId),
    agentPrincipalIds: new Set(input.agents.map((agent) => agent.principalId)),
    fakeProvider: input.fakeProvider,
    productDatabasePath: input.productDatabasePath,
    challenge: {
      assetId: financial.assetId,
      entryAtomic: challengeTerms.entryAtomic,
      prizeAtomic: challengeTerms.prizeAtomic,
    },
    maxWaitMs: 15 * 60 * 1000,
  });
  if (result.room.status !== 'COMPLETE') throw new Error(`challenge room ended ${result.room.status}`);
  input.context.log(`challenge room ${result.room.id} complete; settlement recorded`);

  const afterFirst = {
    payer: availableBalance(await payerSession.client.getBalances(), financial.assetId),
    sponsor: availableBalance(await sponsorSession.client.getBalances(), financial.assetId),
    sponsorOperator: (await financial.readPrincipalAccounts(financial.sponsorPrincipalId)).operator,
  };
  // Exactly-once entry/prize disposition, winner-kind aware: a WALLET winner
  // (the human payer is the only human) receives the reserved prize and the
  // sponsor operator keeps the entry; a SERVICE winner causes the reserve to be
  // released to the sponsor operator (entry + prize).
  const winner = (result.room.results ?? []).find((placement) => placement.finishPosition === 1) ?? null;
  if (winner === null) throw new Error('completed challenge room has no placement-1 winner');
  const payerWon = winner.participantId === payerSession.userId;
  const expectedPayer = payerWon ? prizeAtomic : 0n;
  const expectedOperator = winner.kind === 'HUMAN' ? entryAtomic : entryAtomic + prizeAtomic;
  if (afterFirst.payer !== expectedPayer) {
    throw new Error(
      `payer available ${afterFirst.payer} != expected ${expectedPayer} (winner kind=${winner.kind}, payerWon=${payerWon})`
    );
  }
  if (afterFirst.sponsor !== 0n) throw new Error(`sponsor prize budget was not consumed exactly once: ${afterFirst.sponsor}`);
  if (afterFirst.sponsorOperator !== expectedOperator) {
    throw new Error(
      `sponsor operator balance ${afterFirst.sponsorOperator} != expected ${expectedOperator} (winner kind=${winner.kind})`
    );
  }

  // Retry + restart: the product must not settle a second time. Restarting the
  // actual process re-runs recovery/reconciliation against durable state only.
  await input.nlhe.restart();
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const afterRestart = {
    payer: availableBalance(await payerSession.client.getBalances(), financial.assetId),
    sponsor: availableBalance(await sponsorSession.client.getBalances(), financial.assetId),
    sponsorOperator: (await financial.readPrincipalAccounts(financial.sponsorPrincipalId)).operator,
  };
  if (
    afterRestart.payer !== afterFirst.payer ||
    afterRestart.sponsor !== afterFirst.sponsor ||
    afterRestart.sponsorOperator !== afterFirst.sponsorOperator
  ) {
    throw new Error('restart/reconcile settled the valueless challenge a second time');
  }
  const evidence = input.fakeProvider.requestCountForTable(result.tableId);
  if (evidence === 0) throw new Error('challenge room recorded no provider requests');
}

/** Real held entry/prize cancellation, with no product-local financial writes. */
async function runPrestartCancellation(
  input: FinancialChallengeInput, payer: WalletSession, entryAtomic: bigint, prizeAtomic: bigint,
): Promise<void> {
  const financial = input.environment.financial!;
  const proxy = input.lifecycleProxy;
  if (!proxy || !input.nlhe.kill) throw new Error('cancellation requires the real crash/lifecycle proxy');
  const competitions = new CompetitionClient({ baseUrl: input.environment.platform.baseUrl, token: input.orchestratorToken });
  const payerCompetitions = new CompetitionClient({ baseUrl: input.environment.platform.baseUrl, token: payer.token });
  for (const scenario of ['before-opt-in', 'paid', 'crash', 'cancel-start-race'] as const) {
    let room = await input.product.createRoom({
      name: `cancel-${scenario}-${randomUUID().slice(0, 8)}`, mode: 'CHALLENGE', humanCount: 1,
      agentIds: [input.agents[0]!.agentId],
      finance: { assetId: financial.assetId, entryAtomic: entryAtomic.toString(), prizeAtomic: prizeAtomic.toString(), optIn: true },
    }, { walletToken: payer.token });
    room = await input.product.startRoom(room.id, { walletToken: payer.token });
    if (room.status !== 'PROVISIONING' || !room.pokerCompetitionId) throw new Error('challenge was not held pre-start');
    const id = room.pokerCompetitionId;
    const reserved = await financial.readPrincipalAccounts(financial.sponsorPrincipalId);
    if (reserved.operator !== 0n) throw new Error('prize was not reserved exactly once');
    if (scenario !== 'before-opt-in') {
      await payerCompetitions.optIn(id);
      await payerCompetitions.optIn(id);
      if (availableBalance(await payer.client.getBalances(), financial.assetId) !== 0n) throw new Error('entry was not charged once');
    }
    let startRace: Promise<unknown> | null = null;
    if (scenario === 'cancel-start-race') {
      const before = proxy.competitionStartRequests();
      proxy.delayNextCompetitionStartForward(1500);
      startRace = input.product.startRoom(room.id, { walletToken: payer.token }).catch((error: unknown) => error);
      await waitFor('platform start in flight', async () => proxy.competitionStartRequests() > before ? true : null,
        { timeoutMs: 5000, intervalMs: 20 });
    }
    if (scenario === 'crash') {
      proxy.holdNextCancellationResponse();
      const cancelling = input.product.cancelRoom(room.id).catch((error: unknown) => error);
      await waitFor('accepted platform cancellation response held', async () => proxy.heldResponses() > 0 ? true : null,
        { timeoutMs: 5000, intervalMs: 20 });
      await input.nlhe.kill();
      proxy.releaseHeld();
      await cancelling;
      await input.nlhe.restart();
      room = await waitFor('cancellation recovered after real process crash', async () => {
        const recovered = await input.product.getRoom(room.id);
        return recovered.status === 'FAILED' ? recovered : null;
      }, { timeoutMs: 15_000, intervalMs: 500 });
    } else {
      room = await input.product.cancelRoom(room.id);
    }
    await startRace;
    const first = await competitions.cancel(id);
    const duplicate = await competitions.cancel(id);
    if (JSON.stringify(first) !== JSON.stringify(duplicate)) throw new Error('cancellation receipt changed on replay');
    await input.product.cancelRoom(room.id);
    const platform = await competitions.getCompetition(id);
    const after = await financial.readPrincipalAccounts(financial.sponsorPrincipalId);
    const returned = availableBalance(await payer.client.getBalances(), financial.assetId);
    const human = first.entries.find((entrant) => entrant.principalId === payer.userId);
    if (platform.status !== 'CANCELLED' || first.prizeStatus !== 'RELEASED' ||
        first.prize?.amountAtomic !== prizeAtomic.toString() ||
        returned !== entryAtomic || after.operator !== prizeAtomic || after.available !== 0n ||
        room.status !== 'FAILED' || room.failureReason !== 'PLATFORM_CANCELLED' ||
        human?.refunded !== (scenario !== 'before-opt-in')) {
      throw new Error(`incorrect cancellation/refund disposition: ${scenario}`);
    }
    if (scenario !== 'before-opt-in') {
      const replay = await payerCompetitions.optIn(id);
      if (replay.entryState !== 'REFUNDED') throw new Error('accepted opt-in did not replay refunded state');
    }
    input.context.log(`cancellation ${scenario}: entry/prize restored exactly once; platform CANCELLED; room never ACTIVE`);
  }
}
