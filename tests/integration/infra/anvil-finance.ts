/**
 * External platform-owned financial test fixtures.
 *
 * The financial assertions remain in NLHE, but chain deployment, custody and
 * balanced operator-budget classification belong to the test platform. The
 * operator supplies a built fixture module for that disposable deployment;
 * NLHE does not import platform production source or fabricate READY evidence.
 */
import type { Address, Hex } from 'viem';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RunContext } from './context.js';
import type { WalletSession } from './wallet.js';

export interface FinancialTopology {
  tokenAddress: Address;
  tokenDecimals: number;
  assetId: string;
  treasuryAddress: Address;
  sponsorPrincipalId: string;
  sponsorAddress: Address;
  /** Start real custody only after the transfer/claim/bootstrap window. */
  startCustody(): Promise<void>;
  custodyLogPath: string;
  /** Actual on-chain transfer followed by public claimDeposit. */
  fundAndClaim(session: WalletSession, accountIndex: number, amountAtomic: bigint): Promise<{ txHash: Hex; logIndex: number }>;
  /** Idempotent balanced classification of already-claimed sponsor funds. */
  bootstrapSponsorBudget(amountAtomic: bigint): Promise<{ available: bigint; operator: bigint }>;
  readPrincipalAccounts(principalId: string): Promise<{ available: bigint; operator: bigint }>;
  /** Poll real platform custody/reconciliation readiness; never seed READY. */
  waitForReady(timeoutMs?: number): Promise<void>;
  /** Operator-owned API restart for deposit verifier isolation. */
  restartApi?: () => Promise<void>;
  stop(): Promise<void>;
}

export interface FinancialTopologyInput {
  context: RunContext;
  databaseUrl: string;
  postgresContainer?: string;
  platformBaseUrl: string;
  sponsor: { principalId: string; address: string };
}

export async function startFinancialTopology(input: FinancialTopologyInput): Promise<FinancialTopology> {
  const fixture = process.env.NLHE_IT_FINANCE_FIXTURE;
  if (!fixture || !isAbsolute(fixture) || !/\.m?js$/.test(fixture)) {
    throw new Error('Real Anvil financial acceptance requires NLHE_IT_FINANCE_FIXTURE: an absolute path to the external test deployment\'s built operator fixture module exporting startFinancialTopology. No mock or source-checkout fallback is available.');
  }
  const module = await import(pathToFileURL(fixture).href) as {
    startFinancialTopology?: (input: FinancialTopologyInput) => Promise<FinancialTopology>;
  };
  if (typeof module.startFinancialTopology !== 'function') {
    throw new Error('External financial fixture must export startFinancialTopology');
  }
  return module.startFinancialTopology(input);
}
