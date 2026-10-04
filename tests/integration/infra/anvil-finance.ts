/**
 * Real valueless financial topology for the ASSET challenge.
 *
 * Reuses the PokerTools e2e finance helpers (tests-only private fixture
 * imports): a real Anvil chain, the in-tree MockUSDC compile, two distinct RPC
 * quorum proxies, the declared Asset registry row (backed by the actually
 * deployed token) and the ACTUAL custody worker process, which produces durable
 * heartbeats and matched treasury reconciliation evidence.
 *
 * No READY row is ever fabricated: readiness is polled from the platform's
 * `/ready` endpoint, and balances only ever come from real on-chain transfers
 * claimed through the public `PokerClient.claimDeposit` API.
 */
import type { Address, Hex } from 'viem';
import type { RunContext } from './context.js';
import { POKERTOOLS_DIR, ROOT } from './context.js';
import { buildChildEnv } from './env-boundary.js';
import { runCommandOrThrow, spawnManaged, waitForHttp, type ManagedProcess } from './proc.js';
import { psqlContainer } from './docker.js';
import type { WalletSession } from './wallet.js';

// Tests-only private fixture imports from the PokerTools e2e finance helpers.
import {
  ANVIL_ACCOUNT_ZERO_KEY,
  CHAIN_A_ID,
  CHAIN_A_RPC,
  deployMockUsdc6,
  findTransferLogs,
  getAccount,
  mintToken,
  mine,
  startTwoChainAnvil,
  stopTwoChainAnvil,
  transferToken,
  type LocalChain,
} from '../../../pokertools/packages/e2e/tests/finance/helpers/anvil-two-chain.js';
import { startRpcProxies, type RpcProxySet } from './rpc-proxies.js';

/**
 * Tests-only diagnostic: run the production deposit verifier in-process to
 * surface its rejection reason (the public API intentionally hides it).
 */
async function diagnoseDeposit(
  databaseUrl: string,
  input: { assetId: string; chainId: number; txHash: string; logIndex: number; walletAddress: string },
  priorClaims: ReadonlyArray<{ assetId: string; chainId: number; txHash: string; logIndex: number; walletAddress: string }> = []
): Promise<string> {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = databaseUrl;
  try {
    const [{ createPrismaClient }, { createAssetBackedDepositVerifier }] = await Promise.all([
      import('../../../pokertools/packages/api/src/utils/prisma-client.js'),
      import('../../../pokertools/packages/api/src/services/canonical-deposit-verifier.js'),
    ]);
    const prisma = createPrismaClient();
    try {
      const verifier = createAssetBackedDepositVerifier({ prisma: prisma as never });
      // Reproduce the API's cached-registry lifecycle: verify prior successful
      // claims first, then the failing one with the SAME verifier instance.
      for (const prior of priorClaims) {
        await verifier({ ...prior, principalId: 'diagnostic-prior' });
      }
      const result = await verifier({
        assetId: input.assetId,
        chainId: input.chainId,
        txHash: input.txHash,
        logIndex: input.logIndex,
        principalId: 'diagnostic',
        walletAddress: input.walletAddress,
      });
      const incidents = await prisma.financialIncident.findMany({
        where: { chainId: input.chainId, status: { not: 'RESOLVED' } },
        select: { kind: true, severity: true, evidence: true },
        take: 3,
      });
      return JSON.stringify({ result, openIncidents: incidents });
    } finally {
      await prisma.$disconnect();
    }
  } catch (error) {
    return `diagnostic failed: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
}

export interface FinancialTopology {
  chain: LocalChain;
  tokenAddress: Address;
  tokenDecimals: number;
  assetId: string;
  treasuryAddress: Address;
  sponsorPrincipalId: string;
  sponsorAddress: Address;
  /**
   * Start the ACTUAL custody worker. Called only after all on-chain
   * transfers/claims/classification are complete so its reconciler never
   * observes a transient funding window (which would freeze the asset).
   */
  startCustody(): Promise<void>;
  custodyLogPath: string;
  /** Real on-chain transfer to the treasury, then public claimDeposit. */
  fundAndClaim(
    session: WalletSession,
    accountIndex: number,
    amountAtomic: bigint
  ): Promise<{ txHash: Hex; logIndex: number }>;
  /**
   * Declared infrastructure fixture: idempotent balanced classification of
   * already-claimed sponsor funds from USER_AVAILABLE to the same principal's
   * OPERATOR account (the prize-reserve source). Never creates value.
   */
  bootstrapSponsorBudget(amountAtomic: bigint): Promise<{ available: bigint; operator: bigint }>;
  /** Read one principal's ledger classes (fixture child, read-only). */
  readPrincipalAccounts(principalId: string): Promise<{ available: bigint; operator: bigint }>;
  /** Wait until the platform reports financial readiness from real evidence. */
  waitForReady(timeoutMs?: number): Promise<void>;
  stop(): Promise<void>;
}

export interface FinancialTopologyInput {
  context: RunContext;
  databaseUrl: string;
  postgresContainer: string;
  platformBaseUrl: string;
  sponsor: { principalId: string; address: string };
}

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Tests-only fixture child runner: filtered platform env (DATABASE_URL only, no
 * provider credentials), local PokerTools production source imported privately.
 */
async function runLedgerFixture(databaseUrl: string, args: string[]): Promise<unknown> {
  const result = await runCommandOrThrow(
    process.execPath,
    ['--import', 'tsx', 'tests/integration/fixtures/ledger-fixture.ts', ...args],
    {
      cwd: ROOT,
      env: buildChildEnv({ purpose: 'platform', declared: { DATABASE_URL: databaseUrl } }),
      timeoutMs: 120_000,
    }
  );
  const lastLine = result.stdout.trim().split('\n').filter(Boolean).at(-1) ?? '{}';
  try {
    return JSON.parse(lastLine) as unknown;
  } catch {
    throw new Error(`ledger fixture returned non-JSON output: ${lastLine.slice(0, 200)}`);
  }
}

export async function startFinancialTopology(input: FinancialTopologyInput): Promise<FinancialTopology> {
  const { context } = input;
  const { chainA } = await startTwoChainAnvil();
  context.log(`anvil chain ${CHAIN_A_ID} live at ${CHAIN_A_RPC}`);

  const proxies: RpcProxySet = await startRpcProxies(CHAIN_A_RPC, 2);
  context.log(`quorum proxies: ${proxies.urls.join(', ')}`);

  const token = await deployMockUsdc6(chainA);
  const treasury = getAccount(0);
  const assetId = `eip155:${CHAIN_A_ID}/erc20:${token.address.toLowerCase()}`;
  context.log(`valueless MockUSDC ${token.address} (${token.decimals} decimals) asset ${assetId}`);

  // Declared, unavoidable identity/asset-registry fixtures: the sponsor User
  // row (so the platform sponsor allowlist can be fixed before boot) and the
  // Asset row referencing the real deployed token, treasury and quorum URLs.
  const sponsorAddress = input.sponsor.address.toLowerCase();
  const userSql = `INSERT INTO "User" ("id","username","address","role","kind","createdAt","updatedAt")
    VALUES (${sqlLiteral(input.sponsor.principalId)}, ${sqlLiteral(
      `sponsor_${input.sponsor.principalId.slice(0, 10)}`
    )}, ${sqlLiteral(sponsorAddress)}, 'PLAYER', 'WALLET', NOW(), NOW())
    ON CONFLICT ("id") DO UPDATE SET "address" = EXCLUDED."address", "updatedAt" = NOW()`;
  await psqlContainer(input.postgresContainer, userSql);

  const rpcUrlsJson = JSON.stringify(proxies.urls);
  const sql = `INSERT INTO "Asset" ("id","chainId","tokenAddress","symbol","decimals","status","confirmations","deepFinality","treasuryAddress","rpcUrls","minGasAtomic","ledgerVersion","createdAt","updatedAt")
    VALUES (${sqlLiteral(assetId)}, ${CHAIN_A_ID}, ${sqlLiteral(token.address.toLowerCase())}, 'USDC', ${token.decimals}, 'ACTIVE', 1, 3, ${sqlLiteral(
      treasury.address.toLowerCase()
    )}, ${sqlLiteral(rpcUrlsJson)}::jsonb, '1000000000000000', 0, NOW(), NOW())
    ON CONFLICT ("id") DO UPDATE SET "rpcUrls" = EXCLUDED."rpcUrls", "status" = 'ACTIVE', "treasuryAddress" = EXCLUDED."treasuryAddress", "minGasAtomic" = EXCLUDED."minGasAtomic", "updatedAt" = NOW()`;
  await psqlContainer(input.postgresContainer, sql);
  context.log('declared sponsor identity + Asset registry seeded (backed by the deployed token)');

  const custodyLogPath = `${context.logDir}/custody-worker.log`;
  const successfulClaims: Array<{ assetId: string; chainId: number; txHash: string; logIndex: number; walletAddress: string }> = [];
  let custody: ManagedProcess | null = null;
  const startCustody = async (): Promise<void> => {
    if (custody !== null) return;
    custody = spawnManaged('custody-worker', process.execPath, ['packages/custody/dist/index.js'], {
      cwd: POKERTOOLS_DIR,
      env: buildChildEnv({
        purpose: 'platform',
        declared: {
          NODE_ENV: 'test',
          DATABASE_URL: input.databaseUrl,
          CUSTODY_WORKER_INTERVAL_MS: '2000',
          CUSTODY_RECONCILE_INTERVAL_MS: '2000',
          CUSTODY_QUORUM_THRESHOLD: '2',
          CUSTODY_MIN_QUORUM: '2',
          // Treasury signing key material stays inside the custody child only.
          TREASURY_SIGNING_KEYS_JSON: JSON.stringify({ [CHAIN_A_ID]: ANVIL_ACCOUNT_ZERO_KEY }),
          LOG_LEVEL: 'warn',
        },
      }),
      logDir: context.logDir,
    });
  };

  const topology: FinancialTopology = {
    chain: chainA,
    tokenAddress: token.address,
    tokenDecimals: token.decimals,
    assetId,
    treasuryAddress: treasury.address,
    sponsorPrincipalId: input.sponsor.principalId,
    sponsorAddress: input.sponsor.address as Address,
    startCustody,
    custodyLogPath,
    readPrincipalAccounts: async (principalId) => {
      const payload = (await runLedgerFixture(input.databaseUrl, ['accounts', assetId, principalId])) as {
        accounts?: Array<{ class?: string; balanceAtomic?: string }>;
      };
      const balance = (accountClass: string): bigint =>
        BigInt(payload.accounts?.find((entry) => entry.class === accountClass)?.balanceAtomic ?? '0');
      return { available: balance('USER_AVAILABLE'), operator: balance('OPERATOR') };
    },
    bootstrapSponsorBudget: async (amountAtomic) => {
      await runLedgerFixture(input.databaseUrl, [
        'classify',
        assetId,
        input.sponsor.principalId,
        amountAtomic.toString(),
        `nlhe-fixture:sponsor-budget:${assetId}:${input.sponsor.principalId}`,
      ]);
      return topology.readPrincipalAccounts(input.sponsor.principalId);
    },
    fundAndClaim: async (session, accountIndex, amountAtomic) => {
      // Real on-chain movement: mint exactly the claim amount to the human
      // wallet, then the wallet transfers it to the treasury (one exact log),
      // then the public claim credits the ledger. Treasury balance and ledger
      // liability therefore match exactly, with no fixture credit anywhere.
      await mintToken(chainA, token.address, session.wallet.address, amountAtomic);
      const receipt = await transferToken(chainA, token.address, accountIndex, treasury.address, amountAtomic);
      // Mine a few blocks so confirmation-depth quorum reads cannot race a
      // just-mined head across the two proxy endpoints.
      await mine(chainA, 3);
      const [match] = findTransferLogs(receipt, token.address, {
        from: session.wallet.address,
        to: treasury.address,
        value: amountAtomic,
      });
      if (!match) throw new Error('on-chain transfer produced no exact Transfer log');
      const claimOnce = async (): Promise<void> => {
        const claim = await session.client.claimDeposit({
          assetId,
          txHash: match.txHash,
          logIndex: match.logIndex,
        });
        if (!claim || typeof claim.id !== 'string') throw new Error('deposit claim returned no record');
      };
      try {
        await claimOnce();
      } catch (firstError) {
        // A valid exact-log claim can be rejected transiently while a quorum
        // read races a just-mined head; the claim identity is idempotent, so a
        // single bounded retry is safe and never credits twice.
        await new Promise((resolve) => setTimeout(resolve, 1500));
        try {
          await claimOnce();
        } catch (error) {
          const principal = await session.client.getPrincipal().catch(() => null);
          const walletAddress = principal?.walletAddress ?? session.wallet.address;
          const reason = await diagnoseDeposit(
            input.databaseUrl,
            {
              assetId,
              chainId: CHAIN_A_ID,
              txHash: match.txHash,
              logIndex: match.logIndex,
              walletAddress,
            },
            successfulClaims
          );
          throw new Error(
            `deposit claim failed twice: ${firstError instanceof Error ? firstError.message : String(firstError)} / ${
              error instanceof Error ? error.message : String(error)
            }; apiCode=${String((error as { code?: unknown }).code)} apiStatus=${String(
              (error as { statusCode?: unknown }).statusCode
            )}; verifier: ${reason}; principalWallet=${walletAddress} sessionWallet=${session.wallet.address} transferFrom=${match.from} transferTo=${match.to}`
          );
        }
      }
      successfulClaims.push({
        assetId,
        chainId: CHAIN_A_ID,
        txHash: match.txHash,
        logIndex: match.logIndex,
        walletAddress: session.wallet.address,
      });
      return { txHash: match.txHash, logIndex: match.logIndex };
    },
    waitForReady: async (timeoutMs = 180_000) => {
      let lastFinancial: unknown = null;
      try {
        await waitForHttp(`${input.platformBaseUrl}/ready`, {
          timeoutMs,
          intervalMs: 1000,
          accept: async (candidate) => {
            const body = (await candidate.json().catch(() => null)) as {
              financial?: { state?: unknown; reasons?: unknown };
            } | null;
            lastFinancial = body?.financial ?? null;
            return body?.financial?.state === 'READY';
          },
          logPath: custodyLogPath,
        });
      } catch (error) {
        throw new Error(
          `financial readiness never reached READY: ${JSON.stringify(lastFinancial)} (custody log: ${custodyLogPath})`
        );
      }
    },
    stop: async () => {
      await custody?.stop();
      await proxies.close();
      await stopTwoChainAnvil();
    },
  };

  return topology;
}
