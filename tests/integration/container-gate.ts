#!/usr/bin/env tsx
/**
 * Fresh disposable topology / standalone-container gate entrypoint.
 *
 *   tsx tests/integration/container-gate.ts                 # cheap readiness
 *   tsx tests/integration/container-gate.ts --full          # deterministic gate
 *   tsx tests/integration/container-gate.ts --full --no-browser
 *   tsx tests/integration/container-gate.ts --self-test     # death injection
 *
 * Readiness mode is the cheap runnable interface: it brings up a fresh,
 * disposable, fully supervised topology (Anvil + two quorum endpoints + worker
 * + custody + pinned PokerTools API image + fresh PostgreSQL/Redis), proves
 * API `/health` + `/ready`, custody heartbeat evidence and captured unit
 * identities, captures the ACTUAL immutable platform artifact
 * provenance (API/workers/custody `Config.Image`, image ID, `RepoDigests` and
 * root package version) plus the actual running product container identity
 * (`Config.Image` + `.Image`) into the deterministic gate summary, then cleans
 * everything up. Full mode additionally runs the
 * deterministic 1H1A SPONSORED standalone-container gate (two restarts,
 * outage/recovery, stored-success/no-duplicate invariants) and by default the
 * existing real-browser public-path acceptance (pass --no-browser to skip).
 *
 * Exit codes: 0 PASS, 1 gate FAIL, 2 not runnable (missing fixture/image/env).
 * No paid provider is ever used; every provider URL is loopback.
 *
 * External configuration:
 *   NLHE_IT_STAGING_FIXTURE   absolute path to the built staging fixture
 *                             (exporting startStagingPlatform)
 *   NLHE_IT_PLATFORM_IMAGE    pinned PokerTools image (default: ghcr digest)
 *   NLHE_IT_PRODUCT_IMAGE     fresh product image built from current source
 *   NLHE_IT_SECRET_SCANNER    absolute path to nlhe-final-secret-check.mjs
 *   NLHE_IT_TERMINAL_FOLD_SUMMARY  optional absolute path to the focused
 *                             terminal-FOLD summary (`provenance` +
 *                             `terminalFold` PASS evidence). Required for a
 *                             PAID-ELIGIBLE full summary: the proof must be
 *                             bound to the same actual platform artifact and
 *                             running product identity. Readiness is
 *                             development-only and never paid-eligible.
 *   NLHE_IT_KEEP_RUNTIME=1    keep runtime dir + secret manifest for scanning
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { ROOT, createRunContext, type RunContext } from './infra/context.js';
import { buildChildEnv } from './infra/env-boundary.js';
import { getAccount } from './infra/wallet.js';
import { runCommandOrThrow } from './infra/proc.js';
import { processUnit, Supervisor } from './infra/supervisor.js';
import { startStagingTopology, type StagingTopology } from './infra/staging.js';
import {
  capturePlatformRuntimeProvenance,
  captureRunningProductProvenance,
  selectPlatformContainers,
  selectStandaloneProductContainer,
  validateTerminalFoldSummary,
  type ContainerProvenance,
  type PlatformArtifact,
  type ProductArtifact,
  type ValidatedTerminalFold,
} from './infra/provenance.js';
import { runContainerGate, type ContainerGateResult } from './acceptance/container-gate.js';
import { readRoomEvidence } from './acceptance/evidence.js';
import { installPlatformTrace, PLATFORM_TRACE_ARTIFACT } from './infra/trace-platform.js';

interface GateMode {
  full: boolean;
  selfTest: boolean;
  browser: boolean;
}

function parseMode(argv: readonly string[]): GateMode {
  const unknown = argv.filter(
    (argument) => !['--full', '--readiness-only', '--self-test', '--no-browser'].includes(argument)
  );
  if (unknown.length > 0) throw new Error(`unknown container-gate arguments: ${unknown.join(' ')}`);
  const full = argv.includes('--full');
  if (full && argv.includes('--no-browser')) throw new Error('the full deterministic gate cannot skip the browser');
  return {
    full,
    selfTest: argv.includes('--self-test'),
    browser: full && !argv.includes('--no-browser'),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Required individually supervised fixtures (process IDs / container IDs). */
async function assertRequiredUnits(topology: StagingTopology): Promise<string[]> {
  const identities = topology.supervisor.identityLines();
  const names = topology.supervisor.names();
  const required: Array<[string, number]> = [
    ['anvil', 1],
    ['quorum', 2],
    ['worker', 1],
    ['custody', 1],
  ];
  const problems: string[] = [];
  const childIdentities = new Set<string>();
  for (const [needle, minimum] of required) {
    const matched = names.filter((name) => new RegExp(needle, 'i').test(name));
    if (matched.length < minimum) {
      problems.push(`missing ${minimum} supervised ${needle} unit(s): saw ${matched.join(',') || 'none'}`);
    }
    for (const name of matched) {
      const unit = topology.platform.units.find((candidate) => candidate.name === name);
      const identity = await unit?.identity();
      const key = unit?.kind === 'process' && Number(identity?.pid) > 0 && identity?.startTime
        ? `process:${identity.pid}:${identity.startTime}`
        : unit?.kind === 'container' && identity?.containerId
          ? `container:${identity.containerId}` : null;
      if (key === null) problems.push(`${name} lacks a supervised process/container identity`);
      else if (childIdentities.has(key)) problems.push(`${name} shares another required child's identity`);
      else childIdentities.add(key);
    }
  }
  if (problems.length > 0) {
    throw new Error(`required supervised units incomplete: ${problems.join('; ')} (all: ${names.join(',')})`);
  }
  return identities;
}

interface GateProvenance {
  platform: PlatformArtifact;
  platformContainers: ContainerProvenance[];
}

/**
 * Capture the ACTUAL immutable platform artifact identity of the running
 * topology: API/workers/custody Docker `Config.Image`, image ID, `RepoDigests`
 * and root package version. The product identity is captured separately from
 * the ACTUAL running product container once it exists (never a pre-spawn tag
 * inspection). Missing/unreadable provenance fails the gate.
 */
async function captureGateProvenance(topology: StagingTopology): Promise<GateProvenance> {
  const actual = await capturePlatformRuntimeProvenance(selectPlatformContainers(topology.supervisor.names()));
  return { platform: actual.artifact, platformContainers: actual.containers };
}

/** Capture the running standalone product identity from its container. */
async function captureGateProductProvenance(topology: StagingTopology): Promise<ProductArtifact> {
  const container = selectStandaloneProductContainer(topology.supervisor.names());
  return captureRunningProductProvenance(container);
}

/**
 * Regression: a supervised child that exits unexpectedly must be recorded as
 * UNEXPECTED DEATH, and a liveness assertion afterwards must fail.
 */
async function runDeathInjectionSelfTest(context: RunContext): Promise<void> {
  const supervisor = new Supervisor({ log: (message) => context.log(message) });
  const child = processUnit(
    'death-injection-child',
    process.execPath,
    ['-e', 'setTimeout(() => undefined, 60000)'],
    { cwd: process.cwd(), logDir: context.logDir }
  );
  supervisor.add(child);
  await supervisor.captureIdentities();
  supervisor.startMonitoring();
  await supervisor.assertAllAlive('before death injection');
  await child.process.kill();
  const deadline = Date.now() + 15_000;
  while (supervisor.deaths().length === 0 && Date.now() < deadline) await sleep(200);
  if (supervisor.deaths().length === 0) {
    throw new Error('supervisor did not detect the injected child exit');
  }
  let livenessFailed = false;
  try {
    await supervisor.assertAllAlive('after death injection');
  } catch {
    livenessFailed = true;
  }
  const errors = await supervisor.dispose();
  if (!livenessFailed) throw new Error('supervisor liveness assertion passed despite a dead child');
  if (errors.length > 0) context.log(`self-test cleanup: ${errors.join('; ')}`);
  context.log('death injection regression PASS: unexpected child exit detected and failed liveness');
}

async function runFinalSecretScan(context: RunContext, manifestPath: string): Promise<'pass' | 'skipped'> {
  const scanner = process.env.NLHE_IT_SECRET_SCANNER;
  if (!scanner) {
    context.log('final secret scan: SKIP (set NLHE_IT_SECRET_SCANNER to run the external scanner)');
    return 'skipped';
  }
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

async function main(): Promise<number> {
  const mode = parseMode(process.argv.slice(2));

  if (mode.selfTest) {
    const context = createRunContext();
    context.log(`container-gate self-test ${context.runId}`);
    try {
      await runDeathInjectionSelfTest(context);
      return 0;
    } catch (error) {
      context.log(`self-test FAIL: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }

  const fixture = process.env.NLHE_IT_STAGING_FIXTURE;
  if (!fixture) {
    console.error(
      'BLOCKED: NLHE_IT_STAGING_FIXTURE is required (absolute path to the built external staging fixture exporting startStagingPlatform). No embedded platform fallback exists.'
    );
    return 2;
  }
  if (mode.full && (!process.env.NLHE_IT_SECRET_SCANNER || !isAbsolute(process.env.NLHE_IT_SECRET_SCANNER))) {
    console.error('BLOCKED: the full deterministic gate requires an absolute NLHE_IT_SECRET_SCANNER path');
    return 2;
  }

  // Full-gate OPTIONAL focused terminal-FOLD proof. When supplied it must be
  // an absolute, readable JSON file and is validated against the ACTUAL
  // running artifact after the gate body. When absent the full summary stays a
  // valid development run but is NOT paid-eligible: the paid wrappers require
  // the persisted, artifact-bound FOLD proof.
  let terminalFoldPath: string | null = null;
  let terminalFoldPayload: unknown = null;
  if (mode.full) {
    const candidate = process.env.NLHE_IT_TERMINAL_FOLD_SUMMARY;
    if (candidate === undefined || candidate.trim() === '') {
      console.error(
        'NOTICE: NLHE_IT_TERMINAL_FOLD_SUMMARY is not set; the full summary will NOT be paid-eligible (a focused terminal FOLD PASS bound to the actual artifact is required)'
      );
    } else if (!isAbsolute(candidate)) {
      console.error(
        'BLOCKED: NLHE_IT_TERMINAL_FOLD_SUMMARY must be an absolute path to the focused terminal FOLD summary'
      );
      return 2;
    } else {
      terminalFoldPath = candidate;
      try {
        terminalFoldPayload = JSON.parse(readFileSync(terminalFoldPath, 'utf8')) as unknown;
      } catch (error) {
        console.error(
          `BLOCKED: focused terminal FOLD summary unreadable: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        return 2;
      }
    }
  }

  const context = createRunContext();
  context.log(`container gate ${mode.full ? 'FULL' : 'readiness'} ${context.runId}`);
  context.log(`artifacts: ${context.artifactDir}`);
  const checks: Array<{ name: string; status: 'PASS' | 'FAIL'; detail?: string }> = [];
  let topology: StagingTopology | null = null;
  let gateResult: ContainerGateResult | null = null;
  let provenance: GateProvenance | null = null;
  // Held in an object so the assignment from the runContainerGate callback is
  // visible after the await without TypeScript flow-narrowing the binding.
  const productProvenance: { current: ProductArtifact | null } = { current: null };
  let terminalFold: ValidatedTerminalFold | null = null;
  let scannerResult: 'pass' | 'skipped' = 'skipped';
  let code = 1;
  let identities: string[] = [];
  const trace = installPlatformTrace();

  try {
    topology = await startStagingTopology({
      context,
      sponsor: { principalId: randomUUID(), address: getAccount(2).address },
    });
    identities = await assertRequiredUnits(topology);
    await topology.assertHealthy('readiness', { requireCustodyHeartbeat: true });
    // Mandatory immutable artifact provenance of the ACTUAL topology: the paid
    // wrappers refuse to run unless their running platform/product matches
    // exactly these values.
    provenance = await captureGateProvenance(topology);
    context.log(
      `provenance platform: version=${provenance.platform.version} image=${provenance.platform.image} imageId=${provenance.platform.imageId} digest=${provenance.platform.digest}`
    );
    for (const container of provenance.platformContainers) {
      context.log(
        `provenance container ${container.container}: configImage=${container.configImage} imageId=${container.imageId} repoDigests=${container.repoDigests.join(',')} version=${container.packageVersion}`
      );
    }
    context.log('readiness PASS: all required units alive; API /health + /ready 200; custody heartbeat present');
    checks.push({ name: 'fresh topology readiness', status: 'PASS' });

    if (mode.full) {
      gateResult = await runContainerGate({
        context,
        topology,
        onBeforeStop: async (productBaseUrl: string, databasePath: string) => {
          // The gate summary product identity must describe the ACTUAL running
          // product container (Config.Image + .Image), captured here where the
          // container is guaranteed to exist. A pre-spawn tag inspection is
          // never the source of record.
          productProvenance.current = await captureGateProductProvenance(topology!);
          context.log(
            `provenance product (running container): image=${productProvenance.current.image} imageId=${productProvenance.current.imageId}`
          );
          if (!mode.browser) return;
          const { runBrowserChecks } = await import('../browser/run.js');
          const result = await runBrowserChecks({
            context,
            productBaseUrl,
            platformBaseUrl: topology!.platformUrl,
            getRoomEvidence: (roomId) => readRoomEvidence(databasePath, roomId),
          });
          writeFileSync(join(context.artifactDir, 'browser-phases.json'), topology!.secretRegistry.redact(JSON.stringify(result, null, 2)) + '\n');
          if (result.code !== 0) throw new Error(`browser acceptance failed: ${result.failures.join('; ')}`);
          context.log('browser acceptance PASS (real SIWE public path)');
        },
      });
      checks.push({ name: 'standalone container deterministic gate', status: 'PASS' });
    }

    if (terminalFoldPayload !== null) {
      // The focused proof must be bound to the SAME ACTUAL artifact: its
      // projected provenance must equal the API/workers/custody artifact and
      // the running product identity captured above. A mismatch fails the gate.
      if (provenance === null || productProvenance.current === null) {
        throw new Error(
          'a focused terminal FOLD summary was supplied but actual platform/product provenance was not captured'
        );
      }
      terminalFold = validateTerminalFoldSummary(terminalFoldPayload, {
        platform: provenance.platform,
        product: productProvenance.current,
      });
      context.log(
        `terminal FOLD proof PASS bound to actual artifact: requestId=${terminalFold.evidence.requestId} tableId=${terminalFold.evidence.tableId} handId=${terminalFold.evidence.handId} continuation=${terminalFold.evidence.continuation} platform429=${terminalFold.evidence.platform429} secretScan=${terminalFold.evidence.secretScan}`
      );
      checks.push({ name: 'focused terminal FOLD proof bound to actual artifact', status: 'PASS' });
    }

    code = 0;
  } catch (error) {
    checks.push({
      name: mode.full ? 'deterministic gate' : 'fresh topology readiness',
      status: 'FAIL',
      detail: topology?.secretRegistry.redact(error instanceof Error ? error.message : String(error)) ?? 'staging initialization failed',
    });
    context.log(`container gate FAIL: ${checks.at(-1)?.detail}`);
  } finally {
    trace.writeJsonl(join(context.artifactDir, PLATFORM_TRACE_ARTIFACT));
    trace.restore();
    if (topology) {
      const errors = await topology.stop();
      for (const cleanupError of errors) context.log(`teardown: ${topology.secretRegistry.redact(cleanupError)}`);
      if (errors.length > 0) code = 1;
      context.log(`teardown ${errors.length === 0 ? 'complete' : 'FAILED'}: supervised units and runtime secrets cleanup`);
      // Scan only after all child/container output and teardown diagnostics have
      // been captured. This temporary manifest is never a captured artifact.
      const scanDir = mkdtempSync(join(dirname(topology.runtimeDir), 'final-scan-'));
      try {
        const manifest = topology.secretRegistry.persistEnvManifest(join(scanDir, 'secrets.env'));
        scannerResult = await runFinalSecretScan(context, manifest);
        if (mode.full && scannerResult !== 'pass') code = 1;
      } catch (error) {
        code = 1;
        context.log(`final secret scan FAIL: ${topology.secretRegistry.redact(error instanceof Error ? error.message : String(error))}`);
      } finally {
        rmSync(scanDir, { recursive: true, force: true });
      }
    }
  }
  const summary = { mode: mode.full ? 'full' : 'readiness', runId: context.runId,
    supervised: identities, checks, secretScan: scannerResult, gate: gateResult, exitCode: code,
    platformVersion: provenance?.platform.version ?? null,
    platformImage: provenance?.platform.image ?? null,
    platformImageId: provenance?.platform.imageId ?? null,
    platformDigest: provenance?.platform.digest ?? null,
    productImage: productProvenance.current?.image ?? null,
    productImageId: productProvenance.current?.imageId ?? null,
    // Validated focused terminal-FOLD evidence persisted only when a supplied
    // proof matched the SAME actual artifact; null means NOT paid-eligible.
    terminalFold:
      terminalFold === null ? null : { ...terminalFold.evidence, provenance: terminalFold.provenance },
    provenance: provenance === null ? null : { ...provenance, product: productProvenance.current } };
  writeFileSync(join(context.artifactDir, 'container-gate-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  if (code === 0 && mode.full) {
    if (terminalFold === null) {
      context.log('PAID_ELIGIBLE=NO: no focused terminal FOLD proof bound to the actual artifact');
    }
    context.log('DETERMINISTIC_STAGING=PASS');
  }
  return code;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
