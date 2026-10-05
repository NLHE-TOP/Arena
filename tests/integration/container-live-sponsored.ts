#!/usr/bin/env tsx
/**
 * Guarded standalone LIVE SPONSORED run (real provider, PAID). Prepared only:
 * this file never authorizes itself, and it refuses before any paid-capable
 * setup unless all of the following hold.
 *
 * 1. `NLHE_LIVE_ENABLED=1` (explicit opt-in);
 * 2. a prior DETERMINISTIC full-gate summary is supplied as an absolute path
 *    (`--gate-summary` / `NLHE_LIVE_GATE_SUMMARY`) and parses as
 *    `mode === "full"`, `exitCode === 0` IN THE SUMMARY, every `checks[]` PASS,
 *    `secretScan === "pass"`, a completed standalone gate result AND the
 *    mandatory immutable provenance (`platformVersion`, `platformImage`,
 *    `platformImageId`, `platformDigest`, `productImage`, `productImageId`);
 *    missing provenance fails closed. The caller-supplied reviewed exit code
 *    must also be 0 (`--gate-exit-code` / `NLHE_LIVE_GATE_EXIT_CODE`); a
 *    cleanup failure that keeps all checks PASS but exits non-zero stays
 *    blocked.
 * 2b. BEFORE any topology, the configured platform image must be the same
 *    pinned immutable release artifact recorded by the gate (digest-pinned
 *    ref, released version); a mutable tag override is rejected. AFTER the
 *    topology starts, the ACTUAL API/workers/custody containers must match the
 *    gate version/Config.Image/image ID/RepoDigests digest (and the product
 *    image its gate identity) before any provider can be used.
 * 3. `NLHE_IT_SECRET_SCANNER` names an absolute, existing final secret scanner:
 *    a paid run never skips the scan.
 * 4. an exclusive one-run marker path (`--marker` /
 *    `NLHE_LIVE_SPONSORED_MARKER`) can be created with `O_EXCL`. The marker is
 *    never deleted or replaced by this wrapper, so one authorization can never
 *    replay itself.
 *    Operator procedure (main, never automatic): if a failure happened before
 *    the first model call, the marker records `paidCallsConsumed: false` and
 *    `infraRetryEligible: true`; main may then explicitly remove it to
 *    authorize one infrastructure rerun. Once `paidCallsConsumed` is true, no
 *    rerun may be authorized from that marker.
 *
 * `--check` validates every guard above without loading credentials, creating
 * the marker, starting topology, or touching a provider.
 *
 * Authorized flow: fresh `startStagingTopology` (external fixture; new
 * PostgreSQL/Redis/Anvil/quorum/custody), the standalone product container with
 * the real provider base URL/model and the unchanged `LIVE_CAPS` /
 * `LIVE_PRICING` / per-call cost bound propagated through `extraEnv`, then
 * `runBrowserChecks` creates exactly one SPONSORED 1H1A room through the real
 * UI and proves the same-room agent commit + reload/reconnect + terminal path
 * against the container SQLite. `assertLiveRoomOutcome` (shared with the
 * in-repo live suite) enforces the fixed call/cost caps and terminal state.
 * Platform `/metrics` must show zero actual HTTP 429s before and after.
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
import { ROOT, createRunContext, type RunContext } from './infra/context.js';
import { buildChildEnv } from './infra/env-boundary.js';
import { DEFAULT_PLATFORM_IMAGE, startStagingTopology, type StagingTopology } from './infra/staging.js';
import type { ReleasedProcessUnit } from './infra/supervisor.js';
import {
  assertExpectedPlatformArtifact,
  assertRuntimePlatformMatches,
  assertRuntimeProductMatches,
  capturePlatformRuntimeProvenance,
  captureRunningProductProvenance,
  expectedPlatformArtifact,
  gateImmutableArtifactFromSummary,
  selectPlatformContainers,
  terminalFoldFromGateSummary,
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
import { ProductClient } from './acceptance/product-client.js';
import { readRoomEvidence } from './acceptance/evidence.js';
import { readPlatform429Total } from './acceptance/platform-metrics.js';
import {
  collectLiveFailurePacket,
  lastCanonicalHumanActionFromBrowserResult,
  privateProductDatabasePath,
  privateProductDataDirectory,
  proveContainerStopped,
  type LastCanonicalHumanAction,
  type LiveFailurePacketResult,
} from './acceptance/live-failure-packet.js';
import {
  runBrowserChecks,
  selectLatestHumanActionExchange,
  type BrowserChecksResult,
  type BrowserHumanActionExchange,
  type BrowserPhase,
} from '../browser/run.js';import {
  LIVE_CAPS,
  LIVE_PRICING,
  LIVE_PER_CALL_COST_USD_MICRO,
  assertFixedCaps,
  assertLiveRoomOutcome,
  type LiveRoomOutcome,
} from './live.js';

interface LiveSponsoredArgs {
  check: boolean;
  gateSummary: string | null;
  gateExitCode: number | null;
  marker: string | null;
}

/** Strict CLI: only the reviewed guard inputs are accepted. */
export function parseLiveSponsoredArgs(argv: readonly string[]): LiveSponsoredArgs {
  const args: LiveSponsoredArgs = { check: false, gateSummary: null, gateExitCode: null, marker: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === '--check') {
      args.check = true;
      continue;
    }
    if (argument === '--gate-summary' || argument === '--gate-exit-code' || argument === '--marker') {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${argument} requires a value`);
      index += 1;
      if (argument === '--gate-summary') args.gateSummary = value;
      else if (argument === '--marker') args.marker = value;
      else {
        const parsed = Number(value);
        if (!Number.isInteger(parsed)) throw new Error(`--gate-exit-code must be an integer, saw ${value}`);
        args.gateExitCode = parsed;
      }
      continue;
    }
    throw new Error(`unknown live-sponsored argument: ${argument}`);
  }
  return args;
}

interface DeterministicGateSummary {
  mode: unknown;
  exitCode?: unknown;
  runId?: unknown;
  checks: unknown;
  secretScan: unknown;
  gate: unknown;
}

function requireAbsolute(label: string, value: string | null): string {
  if (value === null || !isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`);
  }
  return value;
}

/** Absolute existing scanner path, part of the guards (never loaded from .env). */
export function requireSecretScanner(value: string | undefined): string {
  if (value === undefined || value.trim() === '' || !isAbsolute(value) || !existsSync(value)) {
    throw new Error(
      'NLHE_IT_SECRET_SCANNER is required (absolute path to the built final secret scanner); a paid run never skips the scan'
    );
  }
  return value;
}

/**
 * Pure guard over the reviewed deterministic full-gate summary. The summary
 * ITSELF must record `exitCode === 0`: a teardown/cleanup failure can keep all
 * checks PASS and still exit non-zero, and that summary must never authorize a
 * paid run. Also requires full mode (browser included), every check PASS,
 * secret scan pass, the caller-supplied reviewed exit code 0, a completed
 * standalone gate result AND the mandatory immutable platform/product artifact
 * provenance (`platformVersion`, `platformImage`, `platformImageId`,
 * `platformDigest`, `productImage`, `productImageId`) bound to a validated
 * focused terminal FOLD PASS proof (`terminalFold`) produced on the same
 * actual artifact. Missing provenance OR missing/mismatched FOLD proof fails
 * closed (every pre-fold full summary is blocked) and the extracted artifact
 * is returned for the preflight/runtime equality guards.
 */
export function validateDeterministicGateSummary(
  payload: unknown,
  exitCode: number
): GatePaidEligibleArtifact {
  if (exitCode !== 0) {
    throw new Error(`deterministic gate reviewed exit code ${exitCode} != 0; a paid run requires a reviewed PASS`);
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('deterministic gate summary is not an object');
  }
  const summary = payload as DeterministicGateSummary;
  if (summary.exitCode !== 0) {
    throw new Error(
      `deterministic gate summary exitCode ${JSON.stringify(summary.exitCode)} != 0 (a cleanup failure can keep all checks PASS and still exit non-zero)`
    );
  }
  if (summary.mode !== 'full') {
    throw new Error(`deterministic gate mode ${JSON.stringify(summary.mode)} != full (browser acceptance not included)`);
  }
  if (summary.secretScan !== 'pass') {
    throw new Error(`deterministic gate secretScan ${JSON.stringify(summary.secretScan)} != pass`);
  }
  if (!Array.isArray(summary.checks) || summary.checks.length === 0) {
    throw new Error('deterministic gate summary carries no checks');
  }
  const failed = summary.checks.filter(
    (check) => (check as { status?: unknown } | null)?.status !== 'PASS'
  );
  if (failed.length > 0) {
    throw new Error(`deterministic gate summary has ${failed.length} non-PASS check(s)`);
  }
  const gate = summary.gate as { roomId?: unknown; tableId?: unknown; restartModes?: unknown } | null;
  if (
    typeof gate !== 'object' ||
    gate === null ||
    typeof gate.roomId !== 'string' ||
    typeof gate.tableId !== 'string'
  ) {
    throw new Error('deterministic gate summary carries no completed standalone gate result');
  }
  const record = summary as unknown as Record<string, unknown>;
  const artifact = gateImmutableArtifactFromSummary(record);
  const terminalFold = terminalFoldFromGateSummary(record, artifact);
  return { platform: artifact.platform, product: artifact.product, terminalFold };
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
    throw new Error(`live sponsored run opted in but ${name} is not configured`);
  }
  return value;
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

/**
 * Convert the selected metadata-only exchange into the packet's exact identity.
 * A capture error (invalid canonical request) carries NO request identity and
 * forces `captureFailed`, which makes the packet incomplete and retained — the
 * packet never falls back to an older accepted FOLD.
 */
function humanActionFromExchange(exchange: BrowserHumanActionExchange): LastCanonicalHumanAction {
  if (exchange.captureError !== null || exchange.request === null) {
    return {
      requestIds: [],
      requestId: null,
      actionId: null,
      turnId: null,
      tableId: typeof exchange.tableId === 'string' ? exchange.tableId : null,
      handId: null,
      httpStatus: typeof exchange.status === 'number' ? exchange.status : null,
      captureFailed: true,
    };
  }
  return {
    requestIds: [exchange.request.requestId],
    requestId: exchange.request.requestId,
    actionId: exchange.request.actionId,
    turnId: exchange.request.turnId,
    tableId: typeof exchange.tableId === 'string' ? exchange.tableId : null,
    handId: null,
    httpStatus: typeof exchange.status === 'number' ? exchange.status : null,
    captureFailed: false,
  };
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

async function main(): Promise<number> {
  const args = parseLiveSponsoredArgs(process.argv.slice(2));

  // ---- Guards first: no credentials, no marker, no topology, no paid path ----
  if (process.env.NLHE_LIVE_ENABLED !== '1') {
    console.log('PENDING live sponsored: set NLHE_LIVE_ENABLED=1 to opt in explicitly');
    return 2;
  }
  let summaryPath: string;
  let markerPath: string;
  let scannerPath: string;
  let gateExitCode: number;
  try {
    summaryPath = requireAbsolute(
      '--gate-summary/NLHE_LIVE_GATE_SUMMARY',
      args.gateSummary ?? process.env.NLHE_LIVE_GATE_SUMMARY ?? null
    );
    markerPath = requireAbsolute(
      '--marker/NLHE_LIVE_SPONSORED_MARKER',
      args.marker ?? process.env.NLHE_LIVE_SPONSORED_MARKER ?? null
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
    console.log(`BLOCKED live sponsored: ${safeError(error)}`);
    return 2;
  }
  let summaryPayload: unknown;
  try {
    summaryPayload = JSON.parse(readFileSync(summaryPath, 'utf8')) as unknown;
  } catch (error) {
    console.log(`BLOCKED live sponsored: deterministic gate summary unreadable: ${safeError(error)}`);
    return 2;
  }
  let gateArtifact: GatePaidEligibleArtifact;
  try {
    gateArtifact = validateDeterministicGateSummary(summaryPayload, gateExitCode);
    // Preflight BEFORE any topology: the configured platform image must be the
    // same pinned immutable release artifact the gate recorded. A mutable tag
    // override can never authorize a paid run.
    assertExpectedPlatformArtifact(
      gateArtifact.platform,
      expectedPlatformArtifact(process.env.NLHE_IT_PLATFORM_IMAGE ?? DEFAULT_PLATFORM_IMAGE)
    );
  } catch (error) {
    console.log(`BLOCKED live sponsored: ${safeError(error)}`);
    return 2;
  }
  const summaryRecord = summaryPayload as { runId?: unknown };
  const gateSummaryRunId = typeof summaryRecord.runId === 'string' ? summaryRecord.runId : 'unknown';

  if (args.check) {
    console.log(
      [
        'guards PASS: opt-in, deterministic full gate (mode=full, summary exitCode=0, all checks PASS, secretScan=pass) and pinned immutable release platform artifact',
        `  gate summary: ${summaryPath} (runId ${gateSummaryRunId})`,
        `  immutable platform artifact: version=${gateArtifact.platform.version} image=${gateArtifact.platform.image} imageId=${gateArtifact.platform.imageId} digest=${gateArtifact.platform.digest}`,
        `  immutable product artifact: image=${gateArtifact.product.image} imageId=${gateArtifact.product.imageId}`,
        `  terminal FOLD proof: status=${gateArtifact.terminalFold.evidence.status} requestId=${gateArtifact.terminalFold.evidence.requestId} tableId=${gateArtifact.terminalFold.evidence.tableId} handId=${gateArtifact.terminalFold.evidence.handId} continuation=${gateArtifact.terminalFold.evidence.continuation} platform429=${gateArtifact.terminalFold.evidence.platform429} secretScan=${gateArtifact.terminalFold.evidence.secretScan}`,
        `  one-run marker: ${markerPath} (not created by --check)`,
        `  secret scanner: ${scannerPath}`,
        `  caps: calls=${LIVE_CAPS.maxCalls} costMicroUsd=${LIVE_CAPS.maxCostUsdMicro} perCallMs=${LIVE_CAPS.perCallTimeoutMs} overallMs=${LIVE_CAPS.overallRuntimeMs} hands=${LIVE_CAPS.maxHands}`,
        `  per-call cost bound microUsd=${LIVE_PER_CALL_COST_USD_MICRO}; pricing input=${LIVE_PRICING.input} output=${LIVE_PRICING.output}`,
        '  credentials: not loaded (--check performs no paid or topology work)',
      ].join('\n')
    );
    return 0;
  }

  // ---- Credentials only now; never printed, never written to artifacts ----
  loadDotEnv();
  const baseUrl = requireEnv('OPENAI_BASE_URL');
  const apiKey = requireEnv('OPENAI_API_KEY');
  const model = requireEnv('OPENAI_MODEL');
  const providerHost = new URL(baseUrl).host;
  if (['127.0.0.1', 'localhost'].includes(new URL(baseUrl).hostname)) {
    throw new Error('live sponsored requires a real provider base URL, not loopback');
  }
  if (LIVE_PER_CALL_COST_USD_MICRO <= 0 || LIVE_CAPS.maxCostUsdMicro <= 0n) {
    throw new Error('live sponsored caps are not positive');
  }

  const context = createRunContext();
  const startedAt = new Date().toISOString();
  // Private product data boundary: assigned after the topology starts, into the
  // protected runtimeDir child; never inside captured artifacts.
  let databasePath: string | null = null;
  const markerBase = {
    runId: context.runId,
    startedAt,
    gateSummaryPath: summaryPath,
    gateSummaryRunId,
    providerHost,
    model,
  };
  try {
    createExclusiveMarker(markerPath, { status: 'STARTED', paidCallsConsumed: false, ...markerBase });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    console.log(
      code === 'EEXIST'
        ? `BLOCKED live sponsored: exclusive one-run marker already exists at ${markerPath}; no paid repeat is possible`
        : `BLOCKED live sponsored: could not create the one-run marker: ${safeError(error)}`
    );
    return 2;
  }

  context.log(`live sponsored acceptance ${context.runId}`);
  context.log(`provider host: ${providerHost}; model: ${model}`);
  context.log(
    `caps: calls=${LIVE_CAPS.maxCalls} costMicroUsd=${LIVE_CAPS.maxCostUsdMicro} perCallCostMicroUsd=${LIVE_PER_CALL_COST_USD_MICRO} perCallMs=${LIVE_CAPS.perCallTimeoutMs} overallMs=${LIVE_CAPS.overallRuntimeMs} hands=${LIVE_CAPS.maxHands}`
  );
  context.log(`gate summary: ${summaryPath} (runId ${gateSummaryRunId}, summary exitCode 0, secretScan pass)`);
  context.log(`one-run marker: ${markerPath}`);

  let topology: StagingTopology | null = null;
  let runtime: StandaloneContainerHandle | null = null;
  let productBaseUrl: string | null = null;
  let adminToken: string | null = null;
  let platformProvenance: PlatformArtifact | null = null;
  let productProvenance: ProductArtifact | null = null;
  let browserResult: BrowserChecksResult | null = null;
  let browserRoomId: string | null = null;
  let browserTableId: string | null = null;
  const browserPhases: BrowserPhase[] = [];
  let outcome: LiveRoomOutcome | null = null;
  let evidenceSummary: FailureEvidence | null = null;
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
  let releasedProcessUnits: ReleasedProcessUnit[] = [];
  // Latest metadata-only canonical human action exchange selected by the
  // browser's request-send-order reducer (a late HTTP response can never
  // replace a newer pending request). Ordinary wallet actions are not product
  // decisions; this relay is the only exact identity, including for a
  // rejected/uncommitted request.
  let latestHumanActionExchange: BrowserHumanActionExchange | null = null;
  const sanitize = (value: unknown): string =>
    redact(typeof value === 'string' ? value : String(value)).replace(/[\r\n]+/g, ' ').slice(0, 2_000);
  const sanitizeList = (values: readonly string[]): string[] => values.slice(0, 10).map((value) => sanitize(value));

  try {
    topology = await startStagingTopology({
      context,
      sponsor: { principalId: randomUUID(), address: getAccount(2).address },
    });
    redact = (text) => topology!.secretRegistry.redact(text);
    // Private product data boundary: a dedicated 0700 child of the protected
    // runtime dir (outside captured artifacts). The standalone container mounts
    // ONLY this child (via dirname(databasePath)), never the runtimeDir root
    // that holds platform secret env files.
    const privateDataDir = privateProductDataDirectory(topology.runtimeDir);
    mkdirSync(privateDataDir, { recursive: true, mode: 0o700 });
    databasePath = privateProductDatabasePath(topology.runtimeDir, 'nlhe-live-sponsored.sqlite');
    const productDatabasePath = databasePath;
    // Actual runtime platform guard BEFORE the provider-capable product
    // container is started: API + workers + custody must expose the exact gate
    // artifact (root version, Config.Image, image ID and RepoDigests digest).
    // The ACTUAL running product identity is asserted after the product starts,
    // before any provider/browser can use it.
    const actualPlatform = await capturePlatformRuntimeProvenance(
      selectPlatformContainers(topology.supervisor.names())
    );
    assertRuntimePlatformMatches(gateArtifact.platform, actualPlatform.artifact);
    platformProvenance = actualPlatform.artifact;
    context.log(
      `immutable platform artifact verified (api/workers/custody): version=${platformProvenance.version} image=${platformProvenance.image} imageId=${platformProvenance.imageId} digest=${platformProvenance.digest}`
    );
    topology.addProductSecret('OPENAI_API_KEY', apiKey);
    await topology.assertHealthy('live sponsored topology', { requireCustodyHeartbeat: true });
    platform429Before = await readPlatform429Total(topology.platformMetrics);
    if (platform429Before !== 0) {
      throw new Error(`fresh platform already recorded ${platform429Before} HTTP 429 response(s)`);
    }

    const admin = await loginWallet(topology.platformUrl, ephemeralWallet());
    const promotion = await ensureOperator(topology.adminTarget, admin);
    if (!promotion.promoted) throw new Error('live sponsored operator wallet was not promoted to ADMIN');
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
    adminToken = productAdminToken();
    topology.addProductSecret('PRODUCT_ADMIN_TOKEN', adminToken);
    topology.addProductSecret('POKERTOOLS_ORCHESTRATION_TOKEN', orchestrator.token);

    runtime = await startStandaloneContainer({
      supervisor: topology.supervisor,
      context,
      runtimeDir: topology.runtimeDir,
      secretRegistry: topology.secretRegistry,
      productImage: topology.productImage,
      platformUrl: topology.platformUrl,
      productUrl: topology.productUrl,
      providerBaseUrl: baseUrl,
      providerApiKey: apiKey,
      providerModel: model,
      orchestrationToken: orchestrator.token,
      productAdminToken: adminToken,
      agentsConfigPath: roster.path,
      databasePath: productDatabasePath,
      maxProviderCalls: LIVE_CAPS.maxCalls,
      maxHands: LIVE_CAPS.maxHands,
      // Direct container route when the fixture exposes its API container name;
      // otherwise the legacy host-published target is kept.
      ...(topology.platform.finance?.apiContainerName
        ? {
            dockerNetwork: topology.network,
            platformContainerHost: topology.platform.finance.apiContainerName,
          }
        : {}),
      extraEnv: {
        MAX_COST_USD_MICRO: String(LIVE_CAPS.maxCostUsdMicro),
        PER_CALL_TIMEOUT_MS: String(LIVE_CAPS.perCallTimeoutMs),
        OVERALL_RUNTIME_MS: String(LIVE_CAPS.overallRuntimeMs),
        MAX_PROVIDER_CONCURRENCY: '2',
        CHALLENGE_ENABLED: '0',
      },
    });
    productBaseUrl = runtime.baseUrl;
    await topology.supervisor.assertAllAlive('live sponsored container start');
    await runtime.waitForReady();
    context.log(`live sponsored product ready at ${runtime.baseUrl} (container ${runtime.name})`);
    // Actual RUNNING product guard: the container's own Config.Image and actual
    // .Image must match the gate identity. A tag replaced after the gate fails
    // closed here, before any browser or provider use.
    const actualProduct = await captureRunningProductProvenance(runtime.name);
    assertRuntimeProductMatches(gateArtifact.product, actualProduct);
    productProvenance = actualProduct;
    context.log(
      `immutable running product verified: image=${productProvenance.image} imageId=${productProvenance.imageId} (container ${runtime.name})`
    );

    browserResult = await runBrowserChecks({
      context,
      productBaseUrl: runtime.baseUrl,
      platformBaseUrl: topology.platformUrl,
      getRoomEvidence: (roomId) => readRoomEvidence(productDatabasePath, roomId),
      onPhase: (phase) => {
        browserPhases.push(phase);
        if (typeof phase.roomId === 'string') browserRoomId = phase.roomId;
        if (typeof phase.tableId === 'string') browserTableId = phase.tableId;
        context.log(
          `browser phase ${phase.name}: agentCommitted=${phase.agentCommitted ?? '-'} humanActions=${phase.humanActions ?? '-'}`
        );
      },
      // Metadata-only relay: the request-send-order reducer keeps the latest
      // canonical request identity (including a rejected/uncommitted or pending
      // exchange); bodies and capture-error text are never retained.
      onHumanActionExchange: (exchange: BrowserHumanActionExchange): void => {
        latestHumanActionExchange = selectLatestHumanActionExchange(
          latestHumanActionExchange,
          exchange
        );
      },
    });
    if (browserResult.code !== 0) {
      throw new Error(`browser acceptance failed: ${browserResult.failures.join(' | ')}`);
    }
    if (browserResult.roomId === null || browserResult.tableId === null) {
      throw new Error('browser acceptance did not create the authorized SPONSORED room');
    }
    browserRoomId = browserResult.roomId;
    browserTableId = browserResult.tableId;

    const product = new ProductClient(runtime.baseUrl, { adminToken });
    const room = await product.getRoom(browserResult.roomId);
    outcome = await assertLiveRoomOutcome({
      context,
      room,
      databasePath: productDatabasePath,
      agentPrincipalIds: new Set(principals.map((principal) => principal.principalId)),
    });
    evidenceSummary = summarizeRoomEvidence(productDatabasePath, browserResult.roomId);

    platform429After = await readPlatform429Total(topology.platformMetrics);
    if (platform429After !== 0) {
      throw new Error(`platform recorded ${platform429After} actual HTTP 429 response(s) during the authorized run`);
    }
    await topology.supervisor.assertAllAlive('live sponsored complete');
  } catch (error) {
    failure = sanitize(safeError(error));
    // Same-room paid-failure metadata: resolve the room (fallback by the run's
    // deterministic browser name) and read its SQLite evidence even when the
    // browser/room flow already failed. Credentials are never echoed.
    if (evidenceSummary === null) {
      let roomId = browserRoomId;
      if (roomId === null && productBaseUrl !== null && adminToken !== null) {
        try {
          const rooms = await new ProductClient(productBaseUrl, { adminToken }).getRooms();
          roomId = rooms.rooms.find((room) => room.name === `ui-${context.runId}`)?.id ?? null;
        } catch {
          roomId = null;
        }
      }
      if (roomId !== null && databasePath !== null) {
        evidenceSummary = summarizeRoomEvidence(databasePath, roomId);
      }
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
      reason: failure ?? 'live sponsored run reached finalization; capturing retained metadata',
      lastCanonicalHumanAction:
        latestHumanActionExchange !== null
          ? humanActionFromExchange(latestHumanActionExchange)
          : lastCanonicalHumanActionFromBrowserResult(browserResult),
      agentPrincipalIds,
      roomId: browserRoomId,
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

  // ---- Final scan AFTER all teardown logs: ephemeral manifest from the
  // retained registry, OUTSIDE artifacts, removed immediately. No skip path. ----
  if (topology !== null && runtimeDirForScan !== null) {
    try {
      const scanDir = mkdtempSync(join(dirname(runtimeDirForScan), 'nlhe-live-sponsored-scan-'));
      try {
        const manifestPath = topology.secretRegistry.persistEnvManifest(
          join(scanDir, 'runtime-secrets.env')
        );
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

  // ---- Retained-finalization ownership: after every evidence capture, dispose
  // ONLY the local supervised process fixtures (Anvil/quorum TCP proxies) whose
  // piped stdio would otherwise pin this orchestrator's event loop forever.
  // Containers, volumes, the runtime dir, the secret manifest and the private
  // product SQLite remain untouched for operator classification. ----
  if (retainedTopology && topology !== null) {
    try {
      releasedProcessUnits = await topology.releaseRetainedProcesses();
    } catch (error) {
      teardownErrors.push(`retained process release: ${sanitize(safeError(error))}`);
      cleanupFailure = cleanupFailure ?? teardownErrors.join(' | ');
    }
  }

  // ---- Final status: any failure, teardown error or non-pass scan is FAIL. ----
  if (failure === null && cleanupFailure !== null) failure = cleanupFailure;
  const retainedState =
    retainedTopology && topology !== null
      ? {
          cause: 'failure-packet-incomplete',
          runSource: retainedFromSuccess ? 'success' : 'failure',
          phase: browserPhases.at(-1)?.name ?? (browserResult === null ? 'pre-browser' : 'browser-complete'),
          runtimeDir: topology.runtimeDir,
          privateDataDir: databasePath === null ? null : dirname(databasePath),
          postgresContainer: topology.postgresContainer,
          redisContainer: topology.redisContainer,
          apiContainerName: topology.platform.finance?.apiContainerName ?? null,
          platformUrl: topology.platformUrl,
          packetPath: failurePacket?.packetPath ?? null,
          runtimeStopProven,
          rawSqliteDisposition,
          releasedProcessUnits,
          note: 'topology.stop() and private runtime cleanup were intentionally skipped; PostgreSQL/Redis/workers and the private runtime SQLite (outside captured artifacts) remain for operator classification; local supervised process fixtures were explicitly released so the harness exits naturally',
        }
      : null;
  // Provider calls can only happen through a room's agent runtime, so a failure
  // before any room exists consumed no paid calls and may be retried once by the
  // operator; an unreadable room's evidence stays conservatively consumed.
  const paidCallsConsumed =
    outcome !== null
      ? outcome.calls > 0
      : evidenceSummary !== null
        ? evidenceSummary.attempts > 0
        : browserRoomId !== null;
  const status = failure === null ? 'COMPLETE' : 'FAILED';
  const payload: Record<string, unknown> = {
    ...markerBase,
    mode: 'SPONSORED',
    status,
    platformVersion: platformProvenance?.version ?? gateArtifact.platform.version,
    platformImage: platformProvenance?.image ?? gateArtifact.platform.image,
    platformImageId: platformProvenance?.imageId ?? gateArtifact.platform.imageId,
    platformDigest: platformProvenance?.digest ?? gateArtifact.platform.digest,
    productImage: productProvenance?.image ?? gateArtifact.product.image,
    productImageId: productProvenance?.imageId ?? gateArtifact.product.imageId,
    completedAt: new Date().toISOString(),
    roomId: browserRoomId,
    tableId: browserTableId,
    calls: outcome?.calls ?? evidenceSummary?.calls ?? null,
    committed: outcome?.committed ?? evidenceSummary?.committed ?? null,
    costMicroUsd: outcome?.costMicroUsd ?? evidenceSummary?.costMicroUsd ?? null,
    providerFailures: sanitizeList(evidenceSummary?.providerFailures ?? []),
    browserCode: browserResult?.code ?? null,
    browserFailures: sanitizeList(browserResult?.failures ?? []),
    phases: browserPhases,
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
    releasedProcessUnits,
    paidCallsConsumed,
    infraRetryEligible: status === 'FAILED' && !paidCallsConsumed,
    error: failure,
  };
  writeFileSync(
    join(context.artifactDir, 'live-sponsored-result.json'),
    `${JSON.stringify(payload, null, 2)}\n`,
    { mode: 0o600 }
  );
  updateMarker(markerPath, payload);
  if (status === 'COMPLETE') {
    context.log(
      `live sponsored acceptance completed: room=${browserRoomId} calls=${outcome?.calls} costMicroUsd=${outcome?.costMicroUsd} committed=${outcome?.committed}`
    );
    return 0;
  }
  console.error(`live sponsored acceptance FAILED: ${failure ?? 'cleanup failure'}`);
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
