#!/usr/bin/env tsx
/**
 * Guarded standalone LIVE CHALLENGE run (real provider, PAID). Prepared only:
 * this file never authorizes itself, and it refuses before any paid-capable
 * setup unless all of the following hold.
 *
 * 1. `NLHE_LIVE_ENABLED=1` (explicit opt-in).
 * 2. A prior DETERMINISTIC full-gate summary (absolute path,
 *    `--gate-summary` / `NLHE_LIVE_GATE_SUMMARY`) that parses as
 *    `mode === "full"`, `exitCode === 0` IN THE SUMMARY, every `checks[]` PASS,
 *    `secretScan === "pass"`, a completed standalone gate result AND the
 *    mandatory immutable provenance (`platformVersion`, `platformImage`,
 *    `platformImageId`, `platformDigest`, `productImage`, `productImageId`);
 *    the caller-supplied reviewed exit code must also be 0
 *    (`--gate-exit-code` / `NLHE_LIVE_GATE_EXIT_CODE`). The pure guard is the
 *    one already reviewed for the sponsored wrapper. Before any topology the
 *    configured platform image must be the same pinned immutable release
 *    artifact (digest-pinned ref + released version; mutable overrides are
 *    rejected); after topology the ACTUAL API/workers/custody containers and
 *    the product image must match the gate identity before any provider use.
 * 3. A persisted, actually completed SPONSORED result (absolute path,
 *    `--sponsored-result` / `NLHE_LIVE_SPONSORED_RESULT`) that records
 *    `mode === "SPONSORED"`, `status === "COMPLETE"`, `calls >= 1`,
 *    `committed >= 1`, `scan === "pass"`, no cleanupFailure/teardown errors,
 *    zero platform 429s, `browserCode === 0`, consumed paid calls and no
 *    infrastructure-retry flag -- AND the same deterministic gate run
 *    (runId + real path) as the reviewed summary. Nothing here trusts a
 *    manually authored artifact: every field must be internally consistent.
 * 4. `NLHE_IT_SECRET_SCANNER` names an absolute, existing final secret scanner:
 *    a paid run never skips the scan.
 * 5. An exclusive one-run marker path (`--marker` /
 *    `NLHE_LIVE_CHALLENGE_MARKER`) can be created with `O_EXCL`. The marker is
 *    never deleted or replaced by this wrapper, so one authorization can never
 *    replay itself. Operator procedure (main, never automatic): if a failure
 *    happened before the first model call, the marker records
 *    `paidCallsConsumed: false` and `infraRetryEligible: true`; main may then
 *    explicitly remove it to authorize one infrastructure rerun. Once
 *    `paidCallsConsumed` is true, no rerun may be authorized from that marker.
 *
 * `--check` validates every guard above without loading credentials, creating
 * the marker, starting topology, or touching a provider.
 *
 * Authorized flow: a FRESH `startStagingTopology` per run (new
 * PostgreSQL/Redis/network, fresh Anvil + two quorum proxies + pinned platform
 * API/workers/custody + fresh product SQLite; never the prior RUNNING
 * scenario), exactly ONE product-orchestrated CHALLENGE 1H1A room through the
 * shared `runChallengeScenario`, the unchanged `LIVE_CAPS` / `LIVE_PRICING` /
 * per-call bound, and the fixed valueless terms entry=1 / prize=2. The scenario
 * funds/claims real on-chain value through the public `claimDeposit` API,
 * classifies the declared sponsor budget, polls actual platform readiness, then
 * enforces the winner-aware CHALLENGE settlement, the read-only exactly-once
 * journal contract and byte-identical journal evidence across the one EXISTING
 * product restart. The wrapper independently gates platform 429s before/after.
 *
 * Custody ordering (acceptance-only, removes the documented deposit-window
 * race): this wrapper requests `deferCustodyStartup`, so the fresh topology
 * plans the custody worker but does not start it. The initial API `/health` is
 * 200 while `/ready` is expected non-READY and the planned custody unit sits in
 * a supervisor maintenance window. Only after the real public deposits and the
 * declared sponsor classification does the existing
 * `FinancialTopology.startCustody` contract create the worker once; the wrapper
 * then releases the maintenance window and requires actual all-unit liveness +
 * custody heartbeat + central READY + product `/ready` 200 BEFORE the CHALLENGE
 * room is created or any provider call can happen. No fake readiness, no direct
 * value credit, no custody stop/restart mid-competition; the only API restart
 * is the explicit pre-admission deposit-verifier cache isolation. The default
 * deterministic/SPONSORED topology never defers custody.
 *
 * Finalization order is fixed: the NLHE runtime is stopped first (no further
 * paid calls) and its container is PROVEN gone (`docker inspect`); then a
 * durable sanitized failure packet is captured while PostgreSQL/Redis/workers
 * still exist. The product SQLite always lives in a dedicated 0700
 * `private-product-data` child of the protected runtime dir (outside captured
 * artifacts; the container mounts only that child, never the runtimeDir root
 * with its platform secret env files). Only a complete packet with a
 * proven-stopped runtime permits `topology.stop()` (which removes the private
 * runtime DB); otherwise the topology and the private DB are retained, the
 * retained state/path/phase/runtimeStopProven are recorded in the result and
 * marker, and no delete/move is attempted while the container could still be
 * alive. Then an ephemeral mode-0600 secret manifest is rebuilt from the
 * retained registry OUTSIDE artifacts and the scanner runs over all captured
 * evidence; only then are the sanitized run artifact and the marker finalized.
 * Any scan or teardown failure forces a FAILED result (exit 1) with
 * `cleanupFailure` recorded -- it is never logged and ignored.
 *
 * Credential handling: the local `.env` is loaded only after every guard has
 * passed; provider values are registered with the generated-secret redactor,
 * are never printed or echoed, never written unsanitized to artifacts, and are
 * passed only to the product container (never to the platform fixture).
 */
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Address, Hex } from 'viem';
import { ROOT, createRunContext, type RunContext } from './infra/context.js';
import { buildChildEnv } from './infra/env-boundary.js';
import {
  DEFAULT_PLATFORM_IMAGE,
  startStagingTopology,
  type StagingPlatformFinance,
  type StagingTopology,
} from './infra/staging.js';
import {
  assertExpectedPlatformArtifact,
  assertPlatformArtifactMatches,
  assertProductArtifactMatches,
  assertRuntimePlatformMatches,
  assertRuntimeProductMatches,
  capturePlatformRuntimeProvenance,
  captureRunningProductProvenance,
  expectedPlatformArtifact,
  isSha256,
  selectPlatformContainers,
  type GatePaidEligibleArtifact,
  type PlatformArtifact,
  type ProductArtifact,
} from './infra/provenance.js';
import { startStandaloneContainer, type StandaloneContainerHandle } from './infra/standalone-container.js';
import { ephemeralWallet, getAccount, loginWallet } from './infra/wallet.js';
import { ensureOperator } from './infra/admin.js';
import { mintOrchestrationToken, productAdminToken, provisionFakeAgentPrincipals } from './infra/agents.js';
import { writeFakeAgentRoster } from './infra/nlhe.js';
import { runCommandOrThrow } from './infra/proc.js';
import type { PlatformHandle } from './infra/platform.js';
import { ProductClient } from './acceptance/product-client.js';
import { readRoomEvidence } from './acceptance/evidence.js';
import { readPlatform429Total } from './acceptance/platform-metrics.js';
import {
  collectLiveFailurePacket,
  privateProductDatabasePath,
  privateProductDataDirectory,
  proveContainerStopped,
  type LastCanonicalHumanAction,
  type LiveFailurePacketResult,
} from './acceptance/live-failure-packet.js';
import {
  adminDatabaseQuery,
  captureFinancialJournalEvidence,
  financialJournalEvidenceFingerprint,
} from './acceptance/financial-journals.js';
import type { FinancialTopology } from './infra/anvil-finance.js';
import {
  LIVE_CAPS,
  LIVE_PRICING,
  LIVE_PER_CALL_COST_USD_MICRO,
  LIVE_CHALLENGE_ENTRY_ATOMIC,
  LIVE_CHALLENGE_PRIZE_ATOMIC,
  assertFixedCaps,
  runChallengeScenario,
  type LiveChallengeHumanAction,
  type LiveChallengeOutcome,
  type LiveChallengeProgress,
} from './live.js';
import { requireSecretScanner, validateDeterministicGateSummary } from './container-live-sponsored.js';

interface LiveChallengeArgs {
  check: boolean;
  gateSummary: string | null;
  gateExitCode: number | null;
  sponsoredResult: string | null;
  marker: string | null;
}

/** Strict CLI: only the reviewed guard inputs are accepted. */
export function parseLiveChallengeArgs(argv: readonly string[]): LiveChallengeArgs {
  const args: LiveChallengeArgs = {
    check: false,
    gateSummary: null,
    gateExitCode: null,
    sponsoredResult: null,
    marker: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === '--check') {
      args.check = true;
      continue;
    }
    if (
      argument === '--gate-summary' ||
      argument === '--gate-exit-code' ||
      argument === '--sponsored-result' ||
      argument === '--marker'
    ) {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${argument} requires a value`);
      index += 1;
      if (argument === '--gate-summary') args.gateSummary = value;
      else if (argument === '--sponsored-result') args.sponsoredResult = value;
      else if (argument === '--marker') args.marker = value;
      else {
        const parsed = Number(value);
        if (!Number.isInteger(parsed)) throw new Error(`--gate-exit-code must be an integer, saw ${value}`);
        args.gateExitCode = parsed;
      }
      continue;
    }
    throw new Error(`unknown live-challenge argument: ${argument}`);
  }
  return args;
}

/**
 * Acceptance-only deferred CHALLENGE bootstrap ordering. Custody is planned,
 * not started, during real deposits and sponsor classification; the existing
 * `FinancialTopology.startCustody` contract then creates it once, and actual
 * evidence gates admission. Fabricated readiness and mid-competition custody
 * stop/restart are rejected by construction.
 */
export const DEFERRED_CUSTODY_BOOTSTRAP = [
  'custody is planned by the external fixture but NOT started during bootstrap; the initial API /health is 200 while /ready is expected non-READY;',
  'the tracked topology holds the planned custody unit in a supervisor maintenance window and never fakes readiness, stops or restarts Anvil/quorum/workers;',
  'after the real public deposits and sponsor classification, the existing FinancialTopology.startCustody contract creates the custody worker exactly once; the wrapper then releases the maintenance window and requires all financial units alive with an actual custody heartbeat, actual central READY and the product /ready 200 BEFORE the CHALLENGE room is created or any provider call can happen;',
  'custody is never stopped or restarted mid-competition; the only API restart is the explicit pre-admission deposit-verifier cache isolation.',
].join(' ');

export interface DeferredCustodyActivation {
  /** Planned custody unit held in supervisor maintenance. */
  unit: string;
  /** Existing fixture contract call that actually creates the worker. */
  startCustody: () => Promise<void>;
  /** Release the supervisor maintenance window once the worker exists. */
  endMaintenance: (unit: string) => Promise<void>;
  /** Poll actual central READY (never a fabricated attestation). */
  waitForCentralReady: () => Promise<void>;
  /** Require actual unit liveness + custody heartbeat evidence. */
  assertFinancialEvidence: () => Promise<void>;
  /** Require the product `/ready` 200 before admission. */
  waitForProductReady: () => Promise<void>;
}

/**
 * Pure ordering seam for the deferred bootstrap: start the planned worker,
 * release maintenance, then require actual central READY + live financial
 * evidence + product `/ready` 200. Any rejection propagates out of
 * `financial.startCustody()` inside `runChallengeScenario`, before the
 * scenario can create a room or call a provider.
 */
export async function activateDeferredCustody(input: DeferredCustodyActivation): Promise<void> {
  await input.startCustody();
  await input.endMaintenance(input.unit);
  await input.waitForCentralReady();
  await input.assertFinancialEvidence();
  await input.waitForProductReady();
}

function requireAbsolute(label: string, value: string | null): string {
  if (value === null || !isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
  return value;
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Persisted completed SPONSORED evidence required before a CHALLENGE run. */
export interface SponsoredCompleteEvidence {
  runId: string;
  roomId: string;
  tableId: string;
  gateSummaryPath: string;
  gateSummaryRunId: string;
  providerHost: string;
  model: string;
  calls: number;
  committed: number;
  costMicroUsd: number;
  /** Actual immutable platform artifact of the completed SPONSORED run. */
  platform: PlatformArtifact;
  /** Actual product image identity of the completed SPONSORED run. */
  product: ProductArtifact;
}

function requiredString(record: Record<string, unknown>, field: string, label: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`persisted live-sponsored result ${label} is missing`);
  }
  return value;
}

function requiredInteger(
  record: Record<string, unknown>,
  field: string,
  label: string,
  minimum: number
): number {
  const value = record[field];
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`persisted live-sponsored result ${label} ${JSON.stringify(value)} is not an integer >= ${minimum}`);
  }
  return value as number;
}

/**
 * Pure guard over the persisted SPONSORED result. It requires an actual
 * completed run: calls and committed provider-backed decisions, a passing
 * final secret scan, successful cleanup/teardown, zero platform 429s, a green
 * browser phase, consumed (not retry-eligible) paid calls AND the mandatory
 * immutable provenance of the actual run (platform version/Config.Image/image
 * ID/digest and product image identity). A historical COMPLETE artifact
 * without provenance, a manually authored artifact or a partially failed
 * artifact can never authorize the CHALLENGE run.
 */
export function validateLiveSponsoredResult(payload: unknown): SponsoredCompleteEvidence {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('persisted live-sponsored result is not an object');
  }
  const record = payload as Record<string, unknown>;
  if (record.mode !== 'SPONSORED') {
    throw new Error(`persisted live-sponsored result mode ${JSON.stringify(record.mode)} != SPONSORED`);
  }
  if (record.status !== 'COMPLETE') {
    throw new Error(
      `persisted live-sponsored result status ${JSON.stringify(record.status)} != COMPLETE; one fresh CHALLENGE requires an actual completed SPONSORED run`
    );
  }
  const calls = requiredInteger(record, 'calls', 'calls', 1);
  const committed = requiredInteger(record, 'committed', 'committed', 1);
  const costMicroUsd = requiredInteger(record, 'costMicroUsd', 'costMicroUsd', 0);
  if (record.scan !== 'pass') {
    throw new Error(`persisted live-sponsored result secretScan ${JSON.stringify(record.scan)} != pass`);
  }
  if (record.cleanupFailure !== null) {
    throw new Error(
      `persisted live-sponsored result cleanupFailure ${JSON.stringify(record.cleanupFailure)} != null (cleanup must have succeeded)`
    );
  }
  if (!Array.isArray(record.teardownErrors) || record.teardownErrors.length > 0) {
    throw new Error('persisted live-sponsored result records teardown errors');
  }
  if (record.platform429Before !== 0 || record.platform429After !== 0) {
    throw new Error(
      `persisted live-sponsored run recorded platform 429s (${JSON.stringify(record.platform429Before)} -> ${JSON.stringify(record.platform429After)})`
    );
  }
  if (record.browserCode !== 0) {
    throw new Error(`persisted live-sponsored browser code ${JSON.stringify(record.browserCode)} != 0`);
  }
  if (record.paidCallsConsumed !== true) {
    throw new Error('persisted live-sponsored run did not record consumed paid calls');
  }
  if (record.infraRetryEligible !== false) {
    throw new Error('persisted live-sponsored run is flagged as infrastructure-retry eligible');
  }
  const gateSummaryPath = requiredString(record, 'gateSummaryPath', 'gateSummaryPath');
  if (!isAbsolute(gateSummaryPath)) {
    throw new Error('persisted live-sponsored result gateSummaryPath must be absolute');
  }
  const requiredImmutableSha256 = (field: string): string => {
    const value = requiredString(record, field, field);
    if (!isSha256(value)) {
      throw new Error(
        `persisted live-sponsored result ${field} ${JSON.stringify(value)} is not an immutable sha256 identity`
      );
    }
    return value;
  };
  const platform: PlatformArtifact = {
    version: requiredString(record, 'platformVersion', 'platformVersion'),
    image: requiredString(record, 'platformImage', 'platformImage'),
    imageId: requiredImmutableSha256('platformImageId'),
    digest: requiredImmutableSha256('platformDigest'),
  };
  const product: ProductArtifact = {
    image: requiredString(record, 'productImage', 'productImage'),
    imageId: requiredImmutableSha256('productImageId'),
  };
  return {
    runId: requiredString(record, 'runId', 'runId'),
    roomId: requiredString(record, 'roomId', 'roomId'),
    tableId: requiredString(record, 'tableId', 'tableId'),
    gateSummaryPath,
    gateSummaryRunId: requiredString(record, 'gateSummaryRunId', 'gateSummaryRunId'),
    providerHost: requiredString(record, 'providerHost', 'providerHost'),
    model: requiredString(record, 'model', 'model'),
    calls,
    committed,
    costMicroUsd,
    platform,
    product,
  };
}

export interface ChallengeFinanceSource {
  finance: StagingPlatformFinance;
  sponsorPrincipalId: string;
  sponsorAddress: string;
  /** Informational live-topology log path; never read by this adapter. */
  custodyLogPath: string;
  /** Already wrapped in a supervisor maintenance window by the caller. */
  restartApi: () => Promise<void>;
}

function requireFinanceMember<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(
      `external staging fixture finance.${label} is required for the live CHALLENGE run; update NLHE_IT_STAGING_FIXTURE`
    );
  }
  return value;
}

function requireFinanceMetadata(value: string | undefined, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      `external staging fixture finance.${label} is required for the live CHALLENGE run; update NLHE_IT_STAGING_FIXTURE`
    );
  }
  return value;
}

function toBigIntBalance(
  value: { available: string; operator: string },
  label: string
): { available: bigint; operator: bigint } {
  const parse = (raw: string, side: string): bigint => {
    if (typeof raw !== 'string' || !/^-?\d+$/.test(raw)) {
      throw new Error(`${label} ${side} balance is not a canonical atomic integer: ${JSON.stringify(raw)}`);
    }
    return BigInt(raw);
  };
  return { available: parse(value.available, 'available'), operator: parse(value.operator, 'operator') };
}

/**
 * Pure read-only `FinancialTopology` adapter over the external staging
 * fixture's public operator metadata. It maps canonical string balances to
 * bigint and delegates every effect to the fixture; it never writes ledger
 * state, never fabricates readiness and never imports platform source.
 */
export function buildChallengeFinancialTopology(input: ChallengeFinanceSource): FinancialTopology {
  const { finance } = input;
  const assetId = requireFinanceMetadata(finance.assetId, 'assetId');
  const tokenAddress = requireFinanceMetadata(finance.tokenAddress, 'tokenAddress');
  if (
    typeof finance.tokenDecimals !== 'number' ||
    !Number.isInteger(finance.tokenDecimals) ||
    finance.tokenDecimals < 0
  ) {
    throw new Error('external staging fixture finance.tokenDecimals must be a non-negative integer');
  }
  const treasuryAddress = requireFinanceMetadata(finance.treasuryAddress, 'treasuryAddress');
  if (finance.sponsorPrincipalId !== undefined && finance.sponsorPrincipalId !== input.sponsorPrincipalId) {
    throw new Error('external staging fixture sponsor principal does not match the staged sponsor');
  }
  if (finance.sponsorAddress !== undefined && finance.sponsorAddress !== input.sponsorAddress) {
    throw new Error('external staging fixture sponsor address does not match the staged sponsor');
  }
  const startCustody = requireFinanceMember(finance.startCustody, 'startCustody');
  const waitForReady = requireFinanceMember(finance.waitForReady, 'waitForReady');
  const readPrincipalAccounts = requireFinanceMember(finance.readPrincipalAccounts, 'readPrincipalAccounts');
  const fundAndClaim = requireFinanceMember(finance.fundAndClaim, 'fundAndClaim');
  if (typeof input.restartApi !== 'function') {
    throw new Error('the live CHALLENGE run requires the supervised API maintenance restart hook');
  }
  return {
    tokenAddress: tokenAddress as Address,
    tokenDecimals: finance.tokenDecimals,
    assetId,
    treasuryAddress: treasuryAddress as Address,
    sponsorPrincipalId: input.sponsorPrincipalId,
    sponsorAddress: input.sponsorAddress as Address,
    custodyLogPath: input.custodyLogPath,
    async startCustody() {
      await startCustody();
    },
    async fundAndClaim(session, accountIndex, amountAtomic) {
      const result = await fundAndClaim(session, accountIndex, amountAtomic.toString());
      return { txHash: result.txHash as Hex, logIndex: result.logIndex };
    },
    async bootstrapSponsorBudget(amountAtomic) {
      const budget = await finance.bootstrapSponsorBudget(amountAtomic.toString());
      return toBigIntBalance(budget, `sponsor ${input.sponsorPrincipalId} budget`);
    },
    async readPrincipalAccounts(principalId) {
      return toBigIntBalance(await readPrincipalAccounts(principalId), `principal ${principalId}`);
    },
    async waitForReady(timeoutMs) {
      await waitForReady(timeoutMs);
    },
    restartApi: input.restartApi,
    async stop() {
      // The fresh staging topology owns the fixture lifecycle; teardown is the
      // wrapper's `topology.stop()`.
    },
  };
}

function loadDotEnv(): void {
  try {
    process.loadEnvFile(join(process.cwd(), '.env'));
  } catch {
    // No local .env: the environment must already carry the credential names.
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`live challenge run opted in but ${name} is not configured`);
  }
  return value;
}

/**
 * Exclusive one-run marker. `O_EXCL` is the whole authorization vehicle: once
 * a paid-capable run has started, a second run can never be started from the
 * same marker path. This wrapper only rewrites this exact file; it never
 * unlinks or replaces it.
 */
function createExclusiveMarker(path: string, payload: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeSync(fd, `${JSON.stringify(payload, null, 2)}\n`);
  } finally {
    closeSync(fd);
  }
}

function updateMarker(path: string, payload: Record<string, unknown>): void {
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
}

/** The configured scanner is mandatory for a paid run; there is no skip path. */
async function runFinalSecretScan(
  context: RunContext,
  scanner: string,
  manifestPath: string
): Promise<'pass'> {
  // The scanner prints only key/path/line/kind metadata, never values. The
  // scanner child gets only the system allowlist plus NLHE_REPO (the checkout
  // root holding the local .env whose values are the detection needles); no
  // provider or platform credential is inherited by the scan process.
  const env = buildChildEnv({
    purpose: 'platform',
    declared: { NLHE_REPO: process.env.NLHE_REPO ?? ROOT },
  });
  const result = await runCommandOrThrow(
    process.execPath,
    [scanner, '--manifest', manifestPath, context.artifactDir],
    { timeoutMs: 120_000, env }
  );
  for (const line of result.stdout.trim().split('\n').filter(Boolean)) context.log(`secret scan: ${line}`);
  return 'pass';
}

interface FailureEvidence {
  calls: number;
  committed: number;
  costMicroUsd: number;
  providerFailures: string[];
  attempts: number;
}

/** Same-room SQLite outcome, captured whether the room completed or failed. */
function summarizeRoomEvidence(databasePath: string, roomId: string): FailureEvidence | null {
  try {
    const evidence = readRoomEvidence(databasePath, roomId);
    return {
      calls: evidence.attempts.filter((attempt) => attempt.recorded_at !== null).length,
      committed: evidence.decisions.filter(
        (decision) =>
          decision.status === 'COMMITTED' &&
          evidence.attempts.some(
            (attempt) => attempt.decision_id === decision.id && attempt.status === 'SUCCEEDED'
          )
      ).length,
      costMicroUsd: evidence.attempts.reduce((sum, attempt) => sum + attempt.cost_micro_usd, 0),
      providerFailures: evidence.attempts
        .filter((attempt) => attempt.status === 'FAILED')
        .map((attempt) => attempt.error ?? 'unknown')
        .slice(0, 5),
      attempts: evidence.attempts.length,
    };
  } catch {
    return null;
  }
}

interface ChallengeJournalSummary {
  status: string;
  prizeStatus: string;
  journalCount: number;
  entryJournalCount: number;
  fingerprint: string;
}

/** Read-only journal capture for failure artifacts; never validates/repairs. */
async function summarizeChallengeJournals(
  topology: StagingTopology,
  competitionId: string
): Promise<ChallengeJournalSummary> {
  const evidence = await captureFinancialJournalEvidence(
    adminDatabaseQuery(topology.adminTarget),
    competitionId
  );
  return {
    status: evidence.competition.status,
    prizeStatus: evidence.competition.prizeStatus,
    journalCount: evidence.journals.length,
    entryJournalCount: evidence.journals.filter((journal) =>
      journal.requestId.startsWith(`competition-entry-reserve:${competitionId}:`)
    ).length,
    fingerprint: financialJournalEvidenceFingerprint(evidence),
  };
}

/**
 * Exact last SDK human action identity relayed through the challenge progress
 * observer (metadata only). Pending requests keep their requestId, so a
 * rejected or network-interrupted human action is never replaced by an older
 * agent FOLD.
 */
function lastCanonicalHumanActionFromChallenge(
  action: LiveChallengeHumanAction | null | undefined
): LastCanonicalHumanAction | null {
  if (action === null || action === undefined) return null;
  if (typeof action.requestId !== 'string' || action.requestId.trim() === '') return null;
  return {
    requestIds: [action.requestId],
    requestId: action.requestId,
    actionId: typeof action.actionId === 'string' ? action.actionId : null,
    turnId: typeof action.turnId === 'string' ? action.turnId : null,
    tableId: typeof action.tableId === 'string' ? action.tableId : null,
    handId: typeof action.handId === 'string' ? action.handId : null,
    httpStatus: typeof action.status === 'number' ? action.status : null,
    captureFailed: false,
  };
}

async function main(): Promise<number> {
  const args = parseLiveChallengeArgs(process.argv.slice(2));

  // ---- Guards first: no credentials, no marker, no topology, no paid path ----
  if (process.env.NLHE_LIVE_ENABLED !== '1') {
    console.log('PENDING live challenge: set NLHE_LIVE_ENABLED=1 to opt in explicitly');
    return 2;
  }
  let gateSummaryPath: string;
  let sponsoredResultPath: string;
  let markerPath: string;
  let scannerPath: string;
  let gateExitCode: number;
  try {
    gateSummaryPath = requireAbsolute(
      '--gate-summary/NLHE_LIVE_GATE_SUMMARY',
      args.gateSummary ?? process.env.NLHE_LIVE_GATE_SUMMARY ?? null
    );
    sponsoredResultPath = requireAbsolute(
      '--sponsored-result/NLHE_LIVE_SPONSORED_RESULT',
      args.sponsoredResult ?? process.env.NLHE_LIVE_SPONSORED_RESULT ?? null
    );
    markerPath = requireAbsolute(
      '--marker/NLHE_LIVE_CHALLENGE_MARKER',
      args.marker ?? process.env.NLHE_LIVE_CHALLENGE_MARKER ?? null
    );
    scannerPath = requireSecretScanner(process.env.NLHE_IT_SECRET_SCANNER);
    const rawExit = args.gateExitCode ?? Number(process.env.NLHE_LIVE_GATE_EXIT_CODE ?? 'NaN');
    if (!Number.isInteger(rawExit)) {
      throw new Error('--gate-exit-code/NLHE_LIVE_GATE_EXIT_CODE is required (the reviewed deterministic exit code)');
    }
    gateExitCode = rawExit;
    const fixture = process.env.NLHE_IT_STAGING_FIXTURE;
    if (fixture === undefined || !isAbsolute(fixture) || !/\.m?js$/.test(fixture)) {
      throw new Error(
        'NLHE_IT_STAGING_FIXTURE is required (absolute path to the built external staging fixture exporting startStagingPlatform)'
      );
    }
    assertFixedCaps();
  } catch (error) {
    console.log(`BLOCKED live challenge: ${safeError(error)}`);
    return 2;
  }

  let gateSummaryPayload: unknown;
  let sponsoredPayload: unknown;
  try {
    gateSummaryPayload = JSON.parse(readFileSync(gateSummaryPath, 'utf8')) as unknown;
  } catch (error) {
    console.log(`BLOCKED live challenge: deterministic gate summary unreadable: ${safeError(error)}`);
    return 2;
  }
  let gateArtifact: GatePaidEligibleArtifact;
  try {
    gateArtifact = validateDeterministicGateSummary(gateSummaryPayload, gateExitCode);
    // Preflight BEFORE any topology: the configured platform image must be the
    // same pinned immutable release artifact the gate recorded. A mutable tag
    // override can never authorize a paid run.
    assertExpectedPlatformArtifact(
      gateArtifact.platform,
      expectedPlatformArtifact(process.env.NLHE_IT_PLATFORM_IMAGE ?? DEFAULT_PLATFORM_IMAGE)
    );
  } catch (error) {
    console.log(`BLOCKED live challenge: ${safeError(error)}`);
    return 2;
  }
  try {
    sponsoredPayload = JSON.parse(readFileSync(sponsoredResultPath, 'utf8')) as unknown;
  } catch (error) {
    console.log(`BLOCKED live challenge: persisted live-sponsored result unreadable: ${safeError(error)}`);
    return 2;
  }
  const summaryRecord = gateSummaryPayload as { runId?: unknown };
  const gateSummaryRunId = typeof summaryRecord.runId === 'string' ? summaryRecord.runId : 'unknown';
  let sponsored: SponsoredCompleteEvidence;
  try {
    sponsored = validateLiveSponsoredResult(sponsoredPayload);
    if (sponsored.gateSummaryRunId !== gateSummaryRunId) {
      throw new Error(
        `persisted live-sponsored run was authorized by gate run ${sponsored.gateSummaryRunId} != reviewed gate ${gateSummaryRunId}`
      );
    }
    if (realpathSync(sponsored.gateSummaryPath) !== realpathSync(gateSummaryPath)) {
      throw new Error('persisted live-sponsored run references a different deterministic gate summary path');
    }
    // The persisted SPONSORED run must have been produced on the exact same
    // immutable platform/product artifact as the reviewed gate (and therefore
    // the current topology asserted after custody starts). A historical
    // COMPLETE result without provenance was already rejected above.
    assertPlatformArtifactMatches('persisted SPONSORED platform', gateArtifact.platform, sponsored.platform);
    assertProductArtifactMatches('persisted SPONSORED product', gateArtifact.product, sponsored.product);
  } catch (error) {
    console.log(`BLOCKED live challenge: ${safeError(error)}`);
    return 2;
  }

  if (args.check) {
    console.log(
      [
        'guards PASS: opt-in, deterministic full gate (mode=full, summary exitCode=0, all checks PASS, secretScan=pass) with pinned immutable release platform artifact, completed SPONSORED result (COMPLETE, calls>=1, committed>=1, scan=pass, cleanup clean, 429-free), one-run marker available',
        `  gate summary: ${gateSummaryPath} (runId ${gateSummaryRunId})`,
        `  immutable platform artifact: version=${gateArtifact.platform.version} image=${gateArtifact.platform.image} imageId=${gateArtifact.platform.imageId} digest=${gateArtifact.platform.digest}`,
        `  immutable product artifact: image=${gateArtifact.product.image} imageId=${gateArtifact.product.imageId}`,
        `  terminal FOLD proof: status=${gateArtifact.terminalFold.evidence.status} requestId=${gateArtifact.terminalFold.evidence.requestId} tableId=${gateArtifact.terminalFold.evidence.tableId} handId=${gateArtifact.terminalFold.evidence.handId} continuation=${gateArtifact.terminalFold.evidence.continuation} platform429=${gateArtifact.terminalFold.evidence.platform429} secretScan=${gateArtifact.terminalFold.evidence.secretScan}`,
        `  completed SPONSORED result: ${sponsoredResultPath} (runId ${sponsored.runId}, room ${sponsored.roomId}, calls=${sponsored.calls} committed=${sponsored.committed}, version=${sponsored.platform.version} digest=${sponsored.platform.digest} imageId=${sponsored.platform.imageId})`,
        `  one-run marker: ${markerPath} (not created by --check)`,
        `  secret scanner: ${scannerPath}`,
        `  caps: calls=${LIVE_CAPS.maxCalls} costMicroUsd=${LIVE_CAPS.maxCostUsdMicro} perCallMs=${LIVE_CAPS.perCallTimeoutMs} overallMs=${LIVE_CAPS.overallRuntimeMs} hands=${LIVE_CAPS.maxHands}`,
        `  per-call cost bound microUsd=${LIVE_PER_CALL_COST_USD_MICRO}; pricing input=${LIVE_PRICING.input} output=${LIVE_PRICING.output}`,
        `  terms: entryAtomic=${LIVE_CHALLENGE_ENTRY_ATOMIC} prizeAtomic=${LIVE_CHALLENGE_PRIZE_ATOMIC}`,
        '  credentials: not loaded (--check performs no paid or topology work)',
        `  ordering: ${DEFERRED_CUSTODY_BOOTSTRAP}`,
      ].join('\n')
    );
    return 0;
  }

  // ---- Credentials only now; never printed, never written to artifacts ----
  loadDotEnv();
  let baseUrl: string;
  let apiKey: string;
  let model: string;
  let providerHost: string;
  try {
    baseUrl = requireEnv('OPENAI_BASE_URL');
    apiKey = requireEnv('OPENAI_API_KEY');
    model = requireEnv('OPENAI_MODEL');
    providerHost = new URL(baseUrl).host;
    if (['127.0.0.1', 'localhost'].includes(new URL(baseUrl).hostname)) {
      throw new Error('live challenge requires a real provider base URL, not loopback');
    }
    if (providerHost !== sponsored.providerHost || model !== sponsored.model) {
      throw new Error(
        `live challenge provider ${providerHost}/${model} != the completed SPONSORED provider ${sponsored.providerHost}/${sponsored.model}`
      );
    }
    if (LIVE_PER_CALL_COST_USD_MICRO <= 0 || LIVE_CAPS.maxCostUsdMicro <= 0n) {
      throw new Error('live challenge caps are not positive');
    }
  } catch (error) {
    console.log(`BLOCKED live challenge: ${safeError(error)}`);
    return 2;
  }

  const context = createRunContext();
  const startedAt = new Date().toISOString();
  // Private product data boundary: assigned after the topology starts, into the
  // protected runtimeDir child; never inside captured artifacts.
  let databasePath: string | null = null;
  const sponsorPrincipalId = randomUUID();
  const sponsorAddress = getAccount(2).address;
  const markerBase = {
    runId: context.runId,
    startedAt,
    gateSummaryPath,
    gateSummaryRunId,
    sponsoredResultPath,
    sponsoredRunId: sponsored.runId,
    providerHost,
    model,
  };
  try {
    createExclusiveMarker(markerPath, { status: 'STARTED', paidCallsConsumed: false, ...markerBase });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    console.log(
      code === 'EEXIST'
        ? `BLOCKED live challenge: exclusive one-run marker already exists at ${markerPath}; no paid repeat is possible`
        : `BLOCKED live challenge: could not create the one-run marker: ${safeError(error)}`
    );
    return 2;
  }

  context.log(`live challenge acceptance ${context.runId}`);
  context.log(`provider host: ${providerHost}; model: ${model}`);
  context.log(
    `caps: calls=${LIVE_CAPS.maxCalls} costMicroUsd=${LIVE_CAPS.maxCostUsdMicro} perCallCostMicroUsd=${LIVE_PER_CALL_COST_USD_MICRO} perCallMs=${LIVE_CAPS.perCallTimeoutMs} overallMs=${LIVE_CAPS.overallRuntimeMs} hands=${LIVE_CAPS.maxHands}`
  );
  context.log(
    `terms: entryAtomic=${LIVE_CHALLENGE_ENTRY_ATOMIC} prizeAtomic=${LIVE_CHALLENGE_PRIZE_ATOMIC}`
  );
  context.log(
    `guards: gate ${gateSummaryRunId} + completed SPONSORED run ${sponsored.runId} (room ${sponsored.roomId}, calls=${sponsored.calls} committed=${sponsored.committed})`
  );
  context.log(`ordering: ${DEFERRED_CUSTODY_BOOTSTRAP}`);
  context.log(`one-run marker: ${markerPath}`);

  let topology: StagingTopology | null = null;
  let runtime: StandaloneContainerHandle | null = null;
  let productBaseUrl: string | null = null;
  // Held in an object so assignments from the deferred-custody callback are
  // visible after the try/catch without TypeScript flow-narrowing the binding.
  const provenanceState: { platform: PlatformArtifact | null; product: ProductArtifact | null } = {
    platform: null,
    product: null,
  };
  let outcome: LiveChallengeOutcome | null = null;
  // Held in an object so assignments from the scenario callback are visible
  // after the try/catch without TypeScript flow-narrowing the binding to null.
  const challengeProgress: { current: LiveChallengeProgress | null } = { current: null };
  let challengeEvidence: FailureEvidence | null = null;
  let journalSummary: ChallengeJournalSummary | null = null;
  let platform429Before: number | null = null;
  let platform429After: number | null = null;
  let failure: string | null = null;
  const teardownErrors: string[] = [];
  let scan: 'pending' | 'pass' | 'failed' | 'unavailable' = 'pending';
  let cleanupFailure: string | null = null;
  let redact: (text: string) => string = (text) => text;
  let agentPrincipalIds: readonly string[] = [];
  let failurePacket: LiveFailurePacketResult | null = null;
  let retainedTopology = false;
  let retainedFromSuccess = false;
  let rawSqliteDisposition: 'none' | 'private-runtime' | 'private-runtime-removed' = 'none';
  let runtimeStopProven = false;
  const sanitize = (value: unknown): string =>
    redact(typeof value === 'string' ? value : String(value)).replace(/[\r\n]+/g, ' ').slice(0, 2_000);
  const sanitizeList = (values: readonly string[]): string[] => values.slice(0, 10).map((value) => sanitize(value));

  try {
    const started = await startStagingTopology({
      context,
      sponsor: { principalId: sponsorPrincipalId, address: sponsorAddress },
      // Acceptance-only deferred custody: the planned worker is held in
      // supervisor maintenance until the existing startCustody contract
      // creates it, after the real deposits and sponsor classification.
      deferCustodyStartup: true,
    });
    topology = started;
    redact = (text) => started.secretRegistry.redact(text);
    // Private product data boundary: a dedicated 0700 child of the protected
    // runtime dir (outside captured artifacts). The standalone container mounts
    // ONLY this child (via dirname(databasePath)), never the runtimeDir root
    // that holds platform secret env files.
    const privateDataDir = privateProductDataDirectory(started.runtimeDir);
    mkdirSync(privateDataDir, { recursive: true, mode: 0o700 });
    databasePath = privateProductDatabasePath(started.runtimeDir, 'nlhe-live-challenge.sqlite');
    const productDatabasePath = databasePath;
    // The ACTUAL running product identity is asserted after the product
    // container starts below; the platform guard runs once custody exists.
    started.addProductSecret('OPENAI_API_KEY', apiKey);
    // Bootstrap contract: API /health is live while /ready is expected
    // non-READY (custody planned, not started). All non-custody units must
    // already be alive; actual READY is asserted after startCustody.
    await started.supervisor.assertAllAlive('live challenge deferred bootstrap');
    context.log(
      'live challenge deferred bootstrap: API /health 200, readiness expected non-READY until the custody worker starts'
    );
    platform429Before = await readPlatform429Total(started.platformMetrics);
    if (platform429Before !== 0) {
      throw new Error(`fresh platform already recorded ${platform429Before} HTTP 429 response(s)`);
    }

    const finance = started.platform.finance;
    if (!finance) {
      throw new Error('the external staging fixture exposes no finance handle; the live CHALLENGE run requires it');
    }
    if (typeof finance.restartApi !== 'function' || typeof finance.apiContainerName !== 'string' || finance.apiContainerName.length === 0) {
      throw new Error(
        'the external staging fixture must expose finance.restartApi + finance.apiContainerName for supervised API cache isolation'
      );
    }
    const deferredCustodyUnit = started.deferredCustodyUnit;
    if (deferredCustodyUnit === null) {
      throw new Error(
        'live CHALLENGE requires the deferred custody bootstrap but the topology declared no planned custody unit'
      );
    }
    const apiUnitName = finance.apiContainerName;
    const supervisedApiRestart = async (): Promise<void> => {
      // API process metrics reset on restart. Never let maintenance erase an
      // unexpected limiter response from the public deposit bootstrap.
      const beforeRestart429 = await readPlatform429Total(started.platformMetrics);
      context.log(`pre-admission API restart: platform429=${beforeRestart429}`);
      if (beforeRestart429 !== 0) throw new Error('unexpected platform HTTP 429 before API maintenance');
      // Deposit-verifier cache isolation: restart ONLY the platform API
      // container inside a supervisor maintenance window. Anvil, quorum,
      // workers and custody are never restarted.
      started.supervisor.beginMaintenance(apiUnitName);
      try {
        await finance.restartApi!();
      } finally {
        await started.supervisor.endMaintenance(apiUnitName);
      }
    };
    const supervisedFinance: StagingPlatformFinance = {
      ...finance,
      async startCustody() {
        await activateDeferredCustody({
          unit: deferredCustodyUnit,
          startCustody: async () => {
            await finance.startCustody!();
            // Actual platform guard immediately after the custody worker is
            // created (before maintenance release, READY, product /ready and
            // any room/provider use): API + workers + custody must expose the
            // exact gate artifact.
            const actualPlatform = await capturePlatformRuntimeProvenance(
              selectPlatformContainers(started.supervisor.names())
            );
            assertRuntimePlatformMatches(gateArtifact.platform, actualPlatform.artifact);
            provenanceState.platform = actualPlatform.artifact;
            context.log(
              `immutable platform artifact verified (api/workers/custody): version=${provenanceState.platform.version} image=${provenanceState.platform.image} imageId=${provenanceState.platform.imageId} digest=${provenanceState.platform.digest}`
            );
          },
          endMaintenance: (unit) => started.supervisor.endMaintenance(unit),
          waitForCentralReady: async () => {
            await finance.waitForReady!();
          },
          assertFinancialEvidence: async () => {
            await started.assertHealthy('deferred custody actual READY', { requireCustodyHeartbeat: true });
          },
          waitForProductReady: async () => {
            if (runtime === null) {
              throw new Error('product runtime is not started for deferred custody activation');
            }
            await runtime.waitForReady();
          },
        });
      },
    };
    const financial = buildChallengeFinancialTopology({
      finance: supervisedFinance,
      sponsorPrincipalId,
      sponsorAddress,
      custodyLogPath: join(started.runtimeDir, 'custody-container.log'),
      restartApi: supervisedApiRestart,
    });
    const platform: PlatformHandle = {
      baseUrl: started.platformUrl,
      port: Number(new URL(started.platformUrl).port),
      databaseUrl: started.databaseUrl,
      redisUrl: started.redisUrl,
      stop: async () => undefined,
      restartApi: financial.restartApi,
    };

    const admin = await loginWallet(started.platformUrl, ephemeralWallet());
    const promotion = await ensureOperator(started.adminTarget, admin);
    if (!promotion.promoted) throw new Error('live challenge operator wallet was not promoted to ADMIN');
    const orchestrator = await mintOrchestrationToken(admin);
    const principals = await provisionFakeAgentPrincipals(admin, 2, {
      delegatedToPrincipalId: orchestrator.principalId,
    });
    agentPrincipalIds = principals.map((principal) => principal.principalId);
    const roster = await writeFakeAgentRoster(context, {
      baseUrl,
      model,
      pricing: LIVE_PRICING,
      limits: {
        maxCallsPerRoom: LIVE_CAPS.maxCalls,
        maxCostMicroUsdPerRoom: Number(LIVE_CAPS.maxCostUsdMicro),
        maxCostMicroUsdPerCall: LIVE_PER_CALL_COST_USD_MICRO,
      },
      principals,
    });
    const adminToken = productAdminToken();
    started.addProductSecret('PRODUCT_ADMIN_TOKEN', adminToken);
    started.addProductSecret('POKERTOOLS_ORCHESTRATION_TOKEN', orchestrator.token);

    runtime = await startStandaloneContainer({
      supervisor: started.supervisor,
      context,
      runtimeDir: started.runtimeDir,
      secretRegistry: started.secretRegistry,
      productImage: started.productImage,
      platformUrl: started.platformUrl,
      productUrl: started.productUrl,
      providerBaseUrl: baseUrl,
      providerApiKey: apiKey,
      providerModel: model,
      orchestrationToken: orchestrator.token,
      productAdminToken: adminToken,
      agentsConfigPath: roster.path,
      databasePath: productDatabasePath,
      maxProviderCalls: LIVE_CAPS.maxCalls,
      maxHands: LIVE_CAPS.maxHands,
      // Direct container route: the API observes the genuine container source
      // address instead of the host-NAT address (rate-limit key separation).
      dockerNetwork: started.network,
      platformContainerHost: finance.apiContainerName,
      // Bootstrap without custody: /health + /config are available with zero
      // rooms/models; /ready is asserted explicitly after actual custody READY.
      waitForInitialReady: false,
      extraEnv: {
        MAX_COST_USD_MICRO: String(LIVE_CAPS.maxCostUsdMicro),
        PER_CALL_TIMEOUT_MS: String(LIVE_CAPS.perCallTimeoutMs),
        OVERALL_RUNTIME_MS: String(LIVE_CAPS.overallRuntimeMs),
        MAX_PROVIDER_CONCURRENCY: '2',
        CHALLENGE_ENABLED: '1',
        CHALLENGE_ASSET_ID: financial.assetId,
        CHALLENGE_ENTRY_ATOMIC: LIVE_CHALLENGE_ENTRY_ATOMIC,
        CHALLENGE_PRIZE_ATOMIC: LIVE_CHALLENGE_PRIZE_ATOMIC,
        CHALLENGE_SPONSOR_PRINCIPAL_ID: sponsorPrincipalId,
      },
    });
    productBaseUrl = runtime.baseUrl;
    await started.supervisor.assertAllAlive('live challenge container start');
    // Actual RUNNING product guard: the container's own Config.Image and actual
    // .Image must match the gate identity before any scenario/provider use. A
    // tag replaced after the gate fails closed here.
    const actualProduct = await captureRunningProductProvenance(runtime.name);
    assertRuntimeProductMatches(gateArtifact.product, actualProduct);
    provenanceState.product = actualProduct;
    context.log(
      `immutable running product verified: image=${actualProduct.image} imageId=${actualProduct.imageId} (container ${runtime.name})`
    );
    context.log(
      `live challenge product bootstrap healthy at ${runtime.baseUrl} (container ${runtime.name}); /ready is deferred until actual custody READY`
    );

    outcome = await runChallengeScenario(
      {
        context,
        environment: { platform, adminTarget: started.adminTarget, financial },
        nlhe: {
          restart: async () => {
            await runtime!.restart('graceful');
          },
        },
        product: new ProductClient(runtime.baseUrl),
        principals,
        databasePath: productDatabasePath,
        platformMetrics: started.platformMetrics,
      },
      {
        onProgress: (value) => {
          challengeProgress.current = value;
        },
      }
    );

    platform429After = await readPlatform429Total(started.platformMetrics);
    if (platform429After !== 0) {
      throw new Error(
        `platform recorded ${platform429After} actual HTTP 429 response(s) during the authorized CHALLENGE run`
      );
    }
    await started.supervisor.assertAllAlive('live challenge complete');
  } catch (error) {
    failure = sanitize(safeError(error));
    // Safe same-run capture even on failure: the room's SQLite evidence (same
    // deterministic name fallback) and, once a competition exists, the
    // read-only journal snapshot. Credentials are never echoed.
    try {
      let roomId = outcome?.roomId ?? challengeProgress.current?.roomId ?? null;
      if (roomId === null && productBaseUrl !== null) {
        try {
          const rooms = await new ProductClient(productBaseUrl).getRooms();
          roomId = rooms.rooms.find((room) => room.name === `live-challenge-1H1A-${context.runId}`)?.id ?? null;
        } catch {
          roomId = null;
        }
      }
      if (roomId !== null && databasePath !== null) {
        challengeEvidence = summarizeRoomEvidence(databasePath, roomId);
      }
      const competitionId = outcome?.competitionId ?? challengeProgress.current?.competitionId ?? null;
      if (competitionId !== null && topology !== null) {
        journalSummary = await summarizeChallengeJournals(topology, competitionId);
      }
    } catch {
      // Bounded failure capture only; the original failure is preserved.
    }
  }

  // ---- Stop the paid NLHE runtime FIRST (no further provider calls), PROVE it
  // is gone, then capture the durable failure packet while PostgreSQL/Redis/
  // workers still exist. Only a complete packet with a proven-stopped runtime
  // may tear the topology down; otherwise the topology and the private runtime
  // SQLite (already outside captured artifacts) are retained. ----
  runtimeStopProven = runtime === null;
  try {
    if (runtime !== null) {
      await runtime.stop();
      const proof = await proveContainerStopped(runtime.name);
      runtimeStopProven = proof.stopped;
      if (!proof.stopped) {
        context.log(`runtime stop not proven (${proof.reason}); retaining topology and private data`);
      }
    }
  } catch (error) {
    runtimeStopProven = false;
    teardownErrors.push(`container stop: ${sanitize(safeError(error))}`);
  }
  const runtimeDirForScan: string | null = topology?.runtimeDir ?? null;
  if (topology !== null && databasePath !== null) {
    failurePacket = await collectLiveFailurePacket({
      context,
      adminTarget: topology.adminTarget,
      redisContainer: topology.redisContainer,
      secretRegistry: topology.secretRegistry,
      productDatabasePath: databasePath,
      platformMetrics: topology.platformMetrics,
      apiContainerName: topology.platform.finance?.apiContainerName ?? null,
      reason: failure ?? 'live challenge run reached finalization; capturing retained metadata',
      // Exact SDK human request relayed through the challenge progress observer
      // (pending/accepted/rejected); when absent, the packet labels any
      // inferred accepted FOLD explicitly instead of pretending it is the
      // human request.
      lastCanonicalHumanAction: lastCanonicalHumanActionFromChallenge(
        challengeProgress.current?.canonicalHumanAction
      ),
      agentPrincipalIds,
      roomId: outcome?.roomId ?? challengeProgress.current?.roomId ?? null,
    });
    retainedTopology = failurePacket.retainTopology || !runtimeStopProven;
    retainedFromSuccess = retainedTopology && failure === null;
    if (retainedFromSuccess) {
      failure = !runtimeStopProven
        ? 'runtime stop could not be proven; topology and private data retained'
        : 'failure packet incomplete; topology retained for operator classification';
    }
    if (retainedTopology) {
      // The private SQLite already lives in the protected runtime dir outside
      // captured artifacts: no relocation or artifact-root deletion is needed
      // (and none is attempted while the container may still be alive).
      rawSqliteDisposition = 'private-runtime';
      context.log(
        `retaining topology (packet=${failurePacket.packetPath ?? 'none'}, runtimeDir=${topology.runtimeDir}, rawSqlite=${rawSqliteDisposition})`
      );
    }
  }
  try {
    if (topology !== null && !retainedTopology) {
      for (const cleanupError of await topology.stop()) {
        teardownErrors.push(`topology stop: ${sanitize(cleanupError)}`);
      }
    } else if (topology !== null && retainedTopology) {
      context.log(
        `topology.stop() skipped: retained ${topology.postgresContainer} and ${topology.redisContainer} (protected runtimeDir ${topology.runtimeDir})`
      );
    }
  } catch (error) {
    teardownErrors.push(`topology stop: ${sanitize(safeError(error))}`);
  }
  if (topology !== null && !retainedTopology) {
    // Evidence-based disposition: only claim removal when the private SQLite is
    // actually gone after a successful teardown.
    rawSqliteDisposition =
      databasePath !== null && existsSync(databasePath) ? 'private-runtime' : 'private-runtime-removed';
  }

  // ---- Final scan AFTER all teardown logs; no skip path. ----
  if (topology !== null && runtimeDirForScan !== null) {
    try {
      const scanDir = mkdtempSync(join(dirname(runtimeDirForScan), 'nlhe-live-challenge-scan-'));
      try {
        const manifestPath = topology.secretRegistry.persistEnvManifest(join(scanDir, 'runtime-secrets.env'));
        scan = await runFinalSecretScan(context, scannerPath, manifestPath);
      } finally {
        rmSync(scanDir, { recursive: true, force: true });
      }
    } catch (error) {
      scan = 'failed';
      cleanupFailure = sanitize(safeError(error));
    }
  } else {
    scan = 'unavailable';
    cleanupFailure = 'staging topology never started; the mandatory final secret scan could not run';
  }
  if (teardownErrors.length > 0) {
    cleanupFailure = cleanupFailure ?? teardownErrors.join(' | ');
  }

  // ---- Final status: any failure, teardown error or non-pass scan is FAIL. ----
  if (failure === null && cleanupFailure !== null) failure = cleanupFailure;
  const retainedState =
    retainedTopology && topology !== null
      ? {
          cause: 'failure-packet-incomplete',
          runSource: retainedFromSuccess ? 'success' : 'failure',
          phase: challengeProgress.current?.status ?? 'pre-room',
          roomId: outcome?.roomId ?? challengeProgress.current?.roomId ?? null,
          tableId: outcome?.tableId ?? challengeProgress.current?.tableId ?? null,
          competitionId: outcome?.competitionId ?? challengeProgress.current?.competitionId ?? null,
          runtimeDir: topology.runtimeDir,
          privateDataDir: databasePath === null ? null : dirname(databasePath),
          postgresContainer: topology.postgresContainer,
          redisContainer: topology.redisContainer,
          apiContainerName: topology.platform.finance?.apiContainerName ?? null,
          platformUrl: topology.platformUrl,
          packetPath: failurePacket?.packetPath ?? null,
          runtimeStopProven,
          rawSqliteDisposition,
          note: 'topology.stop() and private runtime cleanup were intentionally skipped; PostgreSQL/Redis/workers and the private runtime SQLite (outside captured artifacts) remain for operator classification',
        }
      : null;
  const paidCallsConsumed =
    outcome !== null
      ? outcome.calls > 0
      : challengeEvidence !== null
        ? challengeEvidence.attempts > 0
        : (challengeProgress.current?.roomId ?? null) !== null;
  const status = failure === null ? 'COMPLETE' : 'FAILED';
  const payload: Record<string, unknown> = {
    ...markerBase,
    mode: 'CHALLENGE',
    status,
    platformVersion: provenanceState.platform?.version ?? gateArtifact.platform.version,
    platformImage: provenanceState.platform?.image ?? gateArtifact.platform.image,
    platformImageId: provenanceState.platform?.imageId ?? gateArtifact.platform.imageId,
    platformDigest: provenanceState.platform?.digest ?? gateArtifact.platform.digest,
    productImage: provenanceState.product?.image ?? gateArtifact.product.image,
    productImageId: provenanceState.product?.imageId ?? gateArtifact.product.imageId,
    completedAt: new Date().toISOString(),
    sponsoredRoomId: sponsored.roomId,
    sponsoredGateSummaryRunId: sponsored.gateSummaryRunId,
    roomId: outcome?.roomId ?? challengeProgress.current?.roomId ?? null,
    tableId: outcome?.tableId ?? challengeProgress.current?.tableId ?? null,
    competitionId: outcome?.competitionId ?? challengeProgress.current?.competitionId ?? null,
    calls: outcome?.calls ?? challengeEvidence?.calls ?? null,
    committed: outcome?.committed ?? challengeEvidence?.committed ?? null,
    costMicroUsd: outcome?.costMicroUsd ?? challengeEvidence?.costMicroUsd ?? null,
    winnerKind: outcome?.winnerKind ?? null,
    prizeStatus: outcome?.prizeStatus ?? journalSummary?.prizeStatus ?? null,
    challengeStatus: journalSummary?.status ?? null,
    entryAtomic: outcome?.entryAtomic ?? LIVE_CHALLENGE_ENTRY_ATOMIC,
    prizeAtomic: outcome?.prizeAtomic ?? LIVE_CHALLENGE_PRIZE_ATOMIC,
    journalFingerprint: outcome?.journalFingerprint ?? journalSummary?.fingerprint ?? null,
    journalCount: outcome?.journalCount ?? journalSummary?.journalCount ?? null,
    entryDebitCount: outcome?.entryDebitCount ?? journalSummary?.entryJournalCount ?? null,
    restart: outcome?.restart ?? null,
    providerFailures: sanitizeList(challengeEvidence?.providerFailures ?? []),
    platform429Before,
    platform429After,
    scan,
    cleanupFailure,
    teardownErrors,
    failurePacket:
      failurePacket === null
        ? null
        : {
            path: failurePacket.packetPath,
            complete: failurePacket.complete,
            retainTopology: failurePacket.retainTopology,
            reason: failurePacket.reason,
          },
    retainedTopology,
    retainedState,
    rawSqliteDisposition,
    runtimeStopProven,
    paidCallsConsumed,
    infraRetryEligible: status === 'FAILED' && !paidCallsConsumed,
    error: failure,
  };
  writeFileSync(
    join(context.artifactDir, 'live-challenge-result.json'),
    `${JSON.stringify(payload, null, 2)}\n`,
    { mode: 0o600 }
  );
  updateMarker(markerPath, payload);
  if (status === 'COMPLETE') {
    context.log(
      `live challenge acceptance completed: room=${outcome?.roomId} competition=${outcome?.competitionId} calls=${outcome?.calls} costMicroUsd=${outcome?.costMicroUsd} committed=${outcome?.committed} winner=${outcome?.winnerKind} prizeStatus=${outcome?.prizeStatus} journalFingerprint=${outcome?.journalFingerprint.slice(0, 16)}`
    );
    return 0;
  }
  console.error(`live challenge acceptance FAILED: ${failure ?? 'cleanup failure'}`);
  return 1;
}

/**
 * Only execute when this file is the process entrypoint: importing the pure
 * guard helpers (for example from the focused Vitest regression) must never
 * start anything.
 */
function invokedAsEntrypoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedAsEntrypoint()) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
