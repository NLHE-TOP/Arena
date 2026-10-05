#!/usr/bin/env tsx
/**
 * Generic external browser acceptance gate (NO terminal-FOLD opt-in).
 *
 * This is the plain public-path release gate that runs the real UI against a
 * fresh external staging topology and a standalone product container:
 *
 * - the external staging fixture starts the pinned/released OR an explicitly
 *   supplied pre-publication candidate PokerTools platform (API + workers +
 *   custody + PostgreSQL + Redis + Anvil/quorum);
 * - exactly one SPONSORED 1H1A room is created and completed through the real
 *   public UI (real SIWE wallet, live socket, loopback fake provider);
 * - `runBrowserChecks` runs WITHOUT `humanFoldAfter`: canonical human and agent
 *   actions are required, but no particular legal action family is. HUMAN FOLD
 *   is mandatory only in the dedicated deterministic
 *   `container-terminal-fold.ts` regression.
 *
 * Programmatic candidate runs use the exact local Docker image ID (never a
 * mutable tag or a guessed registry digest) and are explicitly not
 * paid-eligible. With no candidate the default released-official immutable
 * artifact guard applies. A `container-browser-gate-summary.json` with the
 * ACTUAL running platform/product provenance, browser verdict and platform 429
 * totals is always written as retained release evidence only: it is NOT a paid
 * authorization (the paid wrappers bind the full deterministic
 * `container-gate.ts` contract and its validated terminal-FOLD proof). No paid
 * provider is ever used; every provider URL is loopback.
 *
 * Usage (released default; candidate is programmatic-only):
 *   NLHE_IT_STAGING_FIXTURE=<abs path> tsx tests/integration/container-browser-gate.ts
 *
 * Exit codes: 0 PASS, 1 FAIL, 2 not runnable (missing fixture).
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, createRunContext, type RunContext } from './infra/context.js';
import { buildChildEnv } from './infra/env-boundary.js';
import { FIXTURE_API_KEY, FIXTURE_MODEL } from './infra/fixtures.js';
import { ensureOperator } from './infra/admin.js';
import { mintOrchestrationToken, productAdminToken, provisionFakeAgentPrincipals } from './infra/agents.js';
import { writeFakeAgentRoster } from './infra/nlhe.js';
import { startFakeProvider, type FakeProviderHandle } from './infra/fake-provider.js';
import { getAccount, ephemeralWallet, loginWallet } from './infra/wallet.js';
import { runCommandOrThrow } from './infra/proc.js';
import { startStagingTopology, type StagingTopology } from './infra/staging.js';
import { startStandaloneContainer, type StandaloneContainerHandle } from './infra/standalone-container.js';
import {
  assertExpectedPlatformArtifact,
  capturePlatformRuntimeProvenance,
  captureRunningProductProvenance,
  expectedPlatformArtifact,
  selectPlatformContainers,
  selectStandaloneProductContainer,
} from './infra/provenance.js';
import { ProductClient, type ProductRoomView } from './acceptance/product-client.js';
import { readRoomEvidence } from './acceptance/evidence.js';
import { readPlatform429Total } from './acceptance/platform-metrics.js';
import { runBrowserChecks, type BrowserChecksResult } from '../browser/run.js';
import { validateTerminalFoldCandidate, type TerminalFoldCandidate } from './container-terminal-fold.js';

/** Mandatory summary artifact name for a generic external browser gate run. */
export const BROWSER_GATE_SUMMARY_FILE = 'container-browser-gate-summary.json';

/**
 * Bounded generic-gate provider budget. The embedded public-path browser smoke
 * uses the same 100-call ceiling and the loopback fake provider costs nothing;
 * no LIVE cap is claimed or raised by this gate.
 */
export const BROWSER_GATE_MAX_PROVIDER_CALLS = 100;
export const BROWSER_GATE_MAX_HANDS = 40;

export interface ContainerBrowserGateOptions {
  /**
   * Optional pre-publication candidate platform artifact. Omitted keeps the
   * released-official immutable artifact guard.
   */
  candidate?: TerminalFoldCandidate | null;
  /** Optional pre-created run context (programmatic callers); default fresh. */
  context?: RunContext;
}

export interface ContainerBrowserGateResult {
  exitCode: number;
  summaryPath: string;
  summary: Record<string, unknown>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Mandatory external fixture guard shared by the CLI and programmatic API. */
function requireStagingFixture(): string {
  const fixture = process.env.NLHE_IT_STAGING_FIXTURE;
  if (fixture === undefined || !isAbsolute(fixture) || !/\.m?js$/.test(fixture)) {
    throw new Error(
      'NLHE_IT_STAGING_FIXTURE is required (absolute path to the built external staging fixture exporting startStagingPlatform)'
    );
  }
  return fixture;
}

function assertLoopback(url: string, label: string): void {
  const host = new URL(url).hostname;
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]') {
    throw new Error(`${label} must be loopback for the deterministic browser gate, saw ${host}`);
  }
}

/** Full (never truncated) redacted artifact secret scan. */
async function runFinalSecretScan(
  context: RunContext,
  scanner: string,
  manifestPath: string
): Promise<'pass'> {
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

/**
 * Programmatic entrypoint. The default (no options) runs the released-official
 * guard; `{ candidate: { version, imageId } }` runs the SAME generic browser
 * shape against a pre-publication local candidate image identified by its
 * exact Docker image ID. A candidate summary is explicitly not paid-eligible.
 */
export async function runContainerBrowserGate(
  options: ContainerBrowserGateOptions = {}
): Promise<ContainerBrowserGateResult> {
  const fixture = requireStagingFixture();
  const candidate =
    options.candidate == null ? null : validateTerminalFoldCandidate(options.candidate);
  const context = options.context ?? createRunContext();

  let topology: StagingTopology | null = null;
  let runtime: StandaloneContainerHandle | null = null;
  let provider: FakeProviderHandle | null = null;
  let browser: BrowserChecksResult | null = null;
  let room: ProductRoomView | null = null;
  let failure: string | null = null;
  let platformVersion: string | null = null;
  let platformImage: string | null = null;
  let platformImageId: string | null = null;
  let platformDigest: string | null = null;
  let productImage: string | null = null;
  let productImageId: string | null = null;
  let platform429Before: number | null = null;
  let platform429After: number | null = null;
  let secretScan: 'pass' | 'fail' | 'not-run' = 'not-run';
  let databasePath: string | null = null;
  let adminToken: string | null = null;
  const teardownErrors: string[] = [];
  const redact = (value: string): string =>
    (topology?.secretRegistry.redact(value) ?? value).replace(/[\r\n]+/g, ' ').slice(0, 2_000);

  context.log(`container generic browser gate ${context.runId}`);
  context.log(`artifacts: ${context.artifactDir}`);

  try {
    topology = await startStagingTopology({
      context,
      sponsor: { principalId: randomUUID(), address: getAccount(2).address },
      ...(candidate !== null ? { platformImage: candidate.imageId } : {}),
    });
    await topology.assertHealthy('generic browser gate start', { requireCustodyHeartbeat: true });

    // Immutable provenance is mandatory for the retained summary; capture the
    // ACTUAL running API/workers/custody and product containers (read-only).
    const platformProvenance = await capturePlatformRuntimeProvenance(
      selectPlatformContainers(topology.supervisor.names())
    );
    platformVersion = platformProvenance.artifact.version;
    platformImage = platformProvenance.artifact.image;
    platformImageId = platformProvenance.artifact.imageId;
    platformDigest = platformProvenance.artifact.digest;
    if (candidate === null) {
      assertExpectedPlatformArtifact(
        platformProvenance.artifact,
        expectedPlatformArtifact(topology.platformImage)
      );
      context.log(
        `released-official platform provenance verified: version=${platformVersion} image=${platformImage} id=${platformImageId} digest=${platformDigest ?? 'none'}`
      );
    } else {
      const actual = platformProvenance.artifact;
      if (actual.version !== candidate.version) {
        throw new Error(
          `candidate platform version ${actual.version} != declared candidate version ${candidate.version}`
        );
      }
      if (actual.image !== candidate.imageId || actual.imageId !== candidate.imageId) {
        throw new Error(
          `candidate platform identity mismatch: Config.Image=${actual.image} imageId=${actual.imageId} != declared local image ${candidate.imageId}`
        );
      }
      // The configured reference is the exact local image ID, not the published
      // immutable registry reference; the release-facing digest stays null and
      // paid eligibility stays false.
      platformDigest = null;
      context.log(
        `candidate platform provenance verified: version=${candidate.version} imageId=${candidate.imageId} digest=null (releasedArtifact=false, not paid-eligible)`
      );
    }

    provider = await startFakeProvider();
    assertLoopback(provider.baseUrl, 'provider URL');

    platform429Before = await readPlatform429Total(topology.platformMetrics);
    if (platform429Before !== 0) {
      throw new Error(`fresh platform already recorded ${platform429Before} HTTP 429 response(s)`);
    }

    const admin = await loginWallet(topology.platformUrl, ephemeralWallet());
    const promotion = await ensureOperator(topology.adminTarget, admin);
    if (!promotion.promoted) throw new Error('generic browser gate operator wallet was not promoted to ADMIN');
    const orchestrator = await mintOrchestrationToken(admin);
    const principals = await provisionFakeAgentPrincipals(admin, 2, {
      delegatedToPrincipalId: orchestrator.principalId,
    });
    const roster = await writeFakeAgentRoster(context, {
      baseUrl: provider.baseUrl,
      principals,
    });
    adminToken = productAdminToken();
    topology.addProductSecret('PRODUCT_ADMIN_TOKEN', adminToken);
    topology.addProductSecret('POKERTOOLS_ORCHESTRATION_TOKEN', orchestrator.token);
    topology.addProductSecret('OPENAI_API_KEY', FIXTURE_API_KEY);

    const platformContainerHost = topology.platform.finance?.apiContainerName;
    if (!platformContainerHost) {
      throw new Error('staging fixture must expose the API container identity for direct service routing');
    }

    databasePath = join(context.artifactDir, 'nlhe-browser-gate.sqlite');
    runtime = await startStandaloneContainer({
      supervisor: topology.supervisor,
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
      maxProviderCalls: BROWSER_GATE_MAX_PROVIDER_CALLS,
      maxHands: BROWSER_GATE_MAX_HANDS,
      extraEnv: { CHALLENGE_ENABLED: '0' },
    });
    await topology.supervisor.assertAllAlive('generic browser gate container start');
    await runtime.waitForReady();
    context.log(`standalone product ready at ${runtime.baseUrl} (container ${runtime.name})`);

    const productProvenance = await captureRunningProductProvenance(
      selectStandaloneProductContainer(topology.supervisor.names())
    );
    productImage = productProvenance.image;
    productImageId = productProvenance.imageId;
    context.log(`product provenance: image=${productImage} id=${productImageId}`);

    const product = new ProductClient(runtime.baseUrl, { adminToken });
    browser = await runBrowserChecks({
      context,
      productBaseUrl: runtime.baseUrl,
      platformBaseUrl: topology.platformUrl,
      // Same-room agent-commit evidence straight from the product SQLite.
      getRoomEvidence: (roomId) => readRoomEvidence(databasePath!, roomId),
    });
    context.log(
      `generic browser checks completed: code=${browser.code} failures=${browser.failures.length} room=${browser.roomId ?? '-'} table=${browser.tableId ?? '-'}`
    );
    if (browser.code !== 0) {
      throw new Error(`browser acceptance failed: ${browser.failures.join(' | ')}`);
    }
    if (browser.roomId !== null) {
      room = await product.getRoom(browser.roomId);
      if (room.status !== 'COMPLETE') {
        throw new Error(`product room status ${room.status} != COMPLETE`);
      }
    }

    platform429After = await readPlatform429Total(topology.platformMetrics);
    if (platform429After !== 0) {
      throw new Error(`platform recorded ${platform429After} HTTP 429 response(s) during the gate`);
    }
  } catch (error) {
    failure = redact(errorText(error));
  } finally {
    // Retained evidence before any teardown.
    if (platform429After === null && topology !== null) {
      platform429After = await readPlatform429Total(topology.platformMetrics).catch(() => null);
    }
    if (room === null && runtime !== null && browser?.roomId != null && adminToken !== null) {
      try {
        room = await new ProductClient(runtime.baseUrl, { adminToken }).getRoom(browser.roomId);
      } catch (error) {
        context.log(`room evidence collection failed safely: ${redact(errorText(error))}`);
      }
    }
    try {
      await runtime?.stop();
    } catch (error) {
      teardownErrors.push(`container stop: ${redact(errorText(error))}`);
    }
    try {
      await provider?.stop();
    } catch (error) {
      teardownErrors.push(`provider stop: ${redact(errorText(error))}`);
    }
    if (topology !== null) {
      try {
        for (const cleanupError of await topology.stop()) {
          teardownErrors.push(`topology stop: ${redact(cleanupError)}`);
        }
      } catch (error) {
        teardownErrors.push(`topology stop: ${redact(errorText(error))}`);
      }
    }
  }

  // ---- Final secret scan after every teardown log has been captured ----
  const scanner = process.env.NLHE_IT_SECRET_SCANNER;
  if (topology !== null && scanner !== undefined && isAbsolute(scanner)) {
    try {
      const scanDir = mkdtempSync(join(dirname(topology.runtimeDir), 'browser-gate-scan-'));
      try {
        const manifest = topology.secretRegistry.persistEnvManifest(join(scanDir, 'secrets.env'));
        secretScan = await runFinalSecretScan(context, scanner, manifest);
      } finally {
        rmSync(scanDir, { recursive: true, force: true });
      }
    } catch (error) {
      secretScan = 'fail';
      failure = failure ?? redact(errorText(error));
    }
  }

  if (teardownErrors.length > 0) {
    failure = failure ?? teardownErrors.join(' | ');
  }

  const exitCode = failure === null ? 0 : 1;
  const payload = {
    kind: candidate === null ? 'container-browser-gate' : 'container-browser-gate-candidate',
    runId: context.runId,
    generatedAt: new Date().toISOString(),
    fixture,
    releasedArtifact: candidate === null,
    candidate:
      candidate === null
        ? null
        : {
            version: candidate.version,
            imageId: candidate.imageId,
            releasedArtifact: false,
            platformDigest: null,
            paidEligible: false,
          },
    platformVersion,
    platformImage,
    platformImageId,
    platformDigest,
    productImage,
    productImageId,
    provenance: {
      platform: {
        version: platformVersion,
        image: platformImage,
        imageId: platformImageId,
        digest: platformDigest,
      },
      product: {
        image: productImage,
        imageId: productImageId,
      },
    },
    browser:
      browser === null
        ? null
        : {
            code: browser.code,
            failures: browser.failures,
            roomId: browser.roomId,
            tableId: browser.tableId,
            phases: browser.phases,
          },
    room:
      room === null
        ? null
        : { id: room.id, status: room.status, tableId: room.pokerTableId },
    platform429: { before: platform429Before, after: platform429After },
    secretScan,
    teardownErrors,
    failure,
    exitCode,
  };
  const summaryPath = join(context.artifactDir, BROWSER_GATE_SUMMARY_FILE);
  try {
    writeFileSync(summaryPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  } catch (error) {
    console.error(`could not write browser-gate summary ${summaryPath}: ${errorText(error)}`);
  }
  context.log(
    `generic browser gate ${exitCode === 0 ? 'PASS' : 'FAIL'}${candidate === null ? '' : ' (candidate, not paid-eligible)'}: room=${room?.status ?? browser?.roomId ?? '-'} browserCode=${browser?.code ?? 'none'} platform429=${String(platform429After)} secretScan=${secretScan}`
  );
  context.log(`browser-gate summary: ${summaryPath}`);
  if (exitCode !== 0) {
    console.error(`container generic browser gate FAILED: ${failure ?? 'checks failed'}`);
  }
  return { exitCode, summaryPath, summary: payload };
}

/** CLI wrapper: default released-official guard, no candidate pointer. */
async function main(): Promise<number> {
  try {
    const fixture = requireStagingFixture();
    if (process.argv.includes('--check')) {
      console.log(
        [
          'guards PASS: fixture configured',
          `  fixture: ${fixture}`,
          '  provider: deterministic loopback only (no paid provider is ever used)',
          '  platform: released-official immutable artifact guard (candidate is programmatic-only)',
          `  summary: ${BROWSER_GATE_SUMMARY_FILE}`,
        ].join('\n')
      );
      return 0;
    }
  } catch (error) {
    console.error(`BLOCKED: ${errorText(error)}`);
    return 2;
  }
  const result = await runContainerBrowserGate();
  return result.exitCode;
}

/**
 * Only execute when this file is the process entrypoint: importing the
 * programmatic API from another harness must never start any topology.
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
