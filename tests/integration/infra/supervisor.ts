/**
 * Independent unit supervision for the fresh disposable acceptance topology.
 *
 * Every unit (Anvil, each quorum proxy, custody, workers, API, PostgreSQL,
 * Redis, the standalone product container) is registered with a stable public
 * identity and a liveness probe:
 * - process units capture `pid` + `ps -o lstart=` start time so PID reuse is
 *   detectable; death is the process exiting or the identity changing;
 * - container units capture `Id`, `Config.Image`, `State.StartedAt` and
 *   `State.Pid`; death is `State.Running === false` (or a removed container);
 * - endpoint units probe the JSON-RPC `eth_chainId` they are expected to serve;
 *   death is a probe that no longer agrees.
 *
 * Liveness is polled by a single unref'd interval; two consecutive failures
 * record an UNEXPECTED DEATH, which fails the gate at the next assertion and is
 * reported with bounded, redacted evidence. Planned maintenance (for example a
 * deliberate Redis outage) uses `pause`/`resume` and is never reported as a
 * death.
 *
 * Nothing here prints or stores environment variables, argv secrets or raw
 * container inspect payloads: identities are name/pid/container-id/image/
 * endpoint fields only, and evidence passes through the configured redactor.
 *
 * This module imports `proc.ts`/`env-boundary.ts` read-only. It never edits
 * product, platform or other diagnostics code.
 */
import { rmSync } from 'node:fs';
import { basename } from 'node:path';
import { collectSecretValues } from './env-boundary.js';
import { runCommand, spawnManaged, tailFile, type ManagedProcess } from './proc.js';

export type UnitKind = 'process' | 'container' | 'endpoint';

/** Public identity only: never credentials, environment or argv payloads. */
export type UnitIdentity = Record<string, string | number | undefined>;

export interface UnitDescriptor {
  readonly name: string;
  readonly kind: UnitKind;
  identity(): Promise<UnitIdentity>;
  alive(): Promise<boolean>;
  evidence?(): Promise<string>;
  /** Permanent stop (teardown). Omit for units owned by an external fixture. */
  stop?(): Promise<void>;
  /** Optional restart support for outage recovery. */
  start?(): Promise<void>;
}

/** Container-like units support a planned stop/start without removal. */
export interface PausableUnit {
  pause(): Promise<void>;
  resume(): Promise<void>;
}

export interface UnexpectedDeath {
  name: string;
  kind: UnitKind;
  detail: string;
  at: number;
  identity: UnitIdentity | null;
  evidence: string;
}

export interface SupervisorOptions {
  log?: (message: string) => void;
  /** Redacts captured evidence; defaults to process.env credential values. */
  redact?: (text: string) => string;
  intervalMs?: number;
  onUnexpectedDeath?: (death: UnexpectedDeath) => void;
}

function defaultRedact(text: string): string {
  let out = text;
  for (const secret of collectSecretValues(process.env).sort((left, right) => right.length - left.length)) {
    if (out.includes(secret)) out = out.split(secret).join('<redacted>');
  }
  return out;
}

export function describeIdentity(identity: UnitIdentity | null): string {
  if (identity === null) return '<identity unavailable>';
  return Object.entries(identity)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function processStartTime(pid: number | undefined): Promise<string | null> {
  if (pid === undefined) return null;
  const result = await runCommand('ps', ['-o', 'lstart=', '-p', String(pid)], { timeoutMs: 5_000 });
  if (result.code !== 0) return null;
  const value = result.stdout.trim();
  return value.length > 0 ? value : null;
}

// ---------------------------------------------------------------------------
// Process units
// ---------------------------------------------------------------------------

export interface ProcessUnitOptions {
  cwd: string;
  logDir: string;
  env?: NodeJS.ProcessEnv;
}

export interface ManagedProcessUnit extends UnitDescriptor {
  readonly kind: 'process';
  readonly process: ManagedProcess;
}

/**
 * Supervise a child process started by the tracked harness. Logs are written
 * by `spawnManaged` with the command line redacted; the supervisor only tails
 * the log path.
 */
export function processUnit(
  name: string,
  command: string,
  args: string[],
  options: ProcessUnitOptions
): ManagedProcessUnit {
  const managed = spawnManaged(name, command, args, options);
  let capturedStartTime: string | null = null;

  return {
    name,
    kind: 'process',
    process: managed,
    async identity() {
      const startTime = await processStartTime(managed.pid);
      if (startTime !== null) capturedStartTime = capturedStartTime ?? startTime;
      return { pid: managed.pid, startTime: startTime ?? capturedStartTime ?? undefined, command: basename(command) };
    },
    async alive() {
      if (managed.child.exitCode !== null || managed.child.signalCode !== null) return false;
      const startTime = await processStartTime(managed.pid);
      if (startTime === null) return false;
      capturedStartTime = capturedStartTime ?? startTime;
      return startTime === capturedStartTime;
    },
    async evidence() {
      return tailFile(managed.logPath, 20);
    },
    async stop() {
      await managed.stop();
    },
    async start() {
      throw new Error(`${name}: process lifecycle is owned by the external fixture`);
    },
  };
}

/**
 * Adopt a process owned elsewhere (for example an Anvil spawned by the
 * external fixture) by pid + start time only.
 */
export function adoptProcess(
  name: string,
  pid: number,
  startTime: string,
  aliveProbe: () => Promise<boolean>
): UnitDescriptor {
  return {
    name,
    kind: 'process',
    async identity() {
      return { pid, startTime };
    },
    async alive() {
      const current = await processStartTime(pid);
      if (current === null || current !== startTime) return false;
      return aliveProbe();
    },
  };
}

// ---------------------------------------------------------------------------
// Container units
// ---------------------------------------------------------------------------

export interface ContainerUnitOptions {
  name: string;
  imageRef: string;
  /** Args after `docker run -d --name <name>`. */
  runArgs: readonly string[];
  /** Remove the container on permanent stop (default true). */
  removeOnStop?: boolean;
  /** Mode-0600 files (env files) deleted immediately after create and on stop. */
  transientFiles?: readonly string[];
}

export interface ManagedContainerUnit extends UnitDescriptor, PausableUnit {
  readonly kind: 'container';
  readonly imageRef: string;
  refreshIdentity(): Promise<UnitIdentity>;
}

interface DockerInspectState {
  id: string;
  image: string;
  startedAt: string;
  running: boolean;
  pid?: number;
  exitCode?: number;
}

const INSPECT_FORMAT =
  '{{.Id}}|{{.Config.Image}}|{{.State.StartedAt}}|{{.State.Running}}|{{.State.Pid}}|{{.State.ExitCode}}';

async function inspectContainer(name: string): Promise<DockerInspectState | null> {
  const result = await runCommand('docker', ['inspect', '--format', INSPECT_FORMAT, name], { timeoutMs: 15_000 });
  if (result.code !== 0) return null;
  const [id, image, startedAt, running, pid, exitCode] = result.stdout.trim().split('|');
  if (!id) return null;
  return {
    id,
    image: image ?? '',
    startedAt: startedAt ?? '',
    running: running === 'true',
    pid: Number.isFinite(Number(pid)) && Number(pid) > 0 ? Number(pid) : undefined,
    exitCode: Number.isFinite(Number(exitCode)) ? Number(exitCode) : undefined,
  };
}

function removeTransientFiles(files: readonly string[] | undefined): void {
  if (!files) return;
  for (const file of files) {
    // Env files carry credentials: remove immediately after create/at teardown.
    rmSync(file, { force: true });
  }
}

async function waitForContainerRunning(name: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await inspectContainer(name);
    if (state?.running === true) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`container ${name} did not report Running within ${timeoutMs}ms`);
}

/**
 * Start a supervised container with no `--restart` policy: an unexpected exit
 * is a gate failure, never silently restarted.
 *
 * `transientFiles` (mode-0600 env files) are deleted immediately after the
 * container has been created, so credentials never persist in the runtime
 * directory or captured artifacts.
 */
export async function startContainerUnit(options: ContainerUnitOptions): Promise<ManagedContainerUnit> {
  const { name } = options;
  const removeOnStop = options.removeOnStop ?? true;

  const run = async (): Promise<void> => {
    await runCommand('docker', ['rm', '-f', name], { timeoutMs: 30_000 });
    try {
      const result = await runCommand(
        'docker',
        ['run', '-d', '--name', name, ...options.runArgs],
        { timeoutMs: 120_000 }
      );
      if (result.code !== 0) {
        throw new Error(
          `docker run ${name} exited ${result.code}: ${(result.stderr || result.stdout).split('\n').slice(-8).join('\n')}`
        );
      }
    } finally {
      removeTransientFiles(options.transientFiles);
    }
  };

  const unit: ManagedContainerUnit = {
    name,
    kind: 'container',
    imageRef: options.imageRef,
    async identity() {
      const state = await inspectContainer(name);
      if (state === null) return { name, image: options.imageRef, state: 'missing' };
      return {
        containerId: state.id.slice(0, 12),
        image: state.image,
        startedAt: state.startedAt,
        pid: state.pid,
        exitCode: state.exitCode,
      };
    },
    async refreshIdentity() {
      return unit.identity();
    },
    async alive() {
      const state = await inspectContainer(name);
      return state?.running === true;
    },
    async evidence() {
      try {
        const result = await runCommand('docker', ['logs', '--tail', '20', name], { timeoutMs: 20_000 });
        const text = `${result.stdout}${result.stderr}`.trim();
        return text.length > 0 ? text : '<no container logs>';
      } catch (error) {
        return `<container logs unavailable: ${errorMessage(error)}>`;
      }
    },
    async pause() {
      const result = await runCommand('docker', ['stop', '-t', '10', name], { timeoutMs: 60_000 });
      if (result.code !== 0) {
        throw new Error(`docker stop ${name} exited ${result.code}: ${result.stderr.trim()}`);
      }
    },
    async resume() {
      await runCommand('docker', ['start', name], { timeoutMs: 60_000 });
      await waitForContainerRunning(name);
    },
    async start() {
      await unit.resume();
    },
    async stop() {
      removeTransientFiles(options.transientFiles);
      if (removeOnStop) {
        await runCommand('docker', ['rm', '-f', name], { timeoutMs: 60_000 });
      } else {
        await runCommand('docker', ['stop', '-t', '10', name], { timeoutMs: 60_000 });
      }
    },
  };

  await run();
  return unit;
}

/** Adopt a container started elsewhere (fixture-owned) for liveness only. */
export function adoptContainer(name: string, alive?: () => Promise<boolean>): UnitDescriptor {
  return {
    name,
    kind: 'container',
    async identity() {
      const state = await inspectContainer(name);
      if (state === null) return { name, state: 'missing' };
      return {
        containerId: state.id.slice(0, 12),
        image: state.image,
        startedAt: state.startedAt,
        pid: state.pid,
      };
    },
    async alive() {
      if (alive) return alive();
      return (await inspectContainer(name))?.running === true;
    },
    async evidence() {
      const result = await runCommand('docker', ['logs', '--tail', '20', name], { timeoutMs: 20_000 });
      return `${result.stdout}${result.stderr}`.trim();
    },
  };
}

// ---------------------------------------------------------------------------
// Endpoint units (quorum proxies)
// ---------------------------------------------------------------------------

export interface EndpointUnitOptions {
  expectedChainId: number;
  timeoutMs?: number;
}

/** Probe an Ethereum JSON-RPC endpoint for the exact expected chain id. */
export function endpointUnit(name: string, url: string, options: EndpointUnitOptions): UnitDescriptor {
  let lastDetail = 'not probed';
  let requestId = 0;
  return {
    name,
    kind: 'endpoint',
    async identity() {
      return { endpoint: url, expectedChainId: options.expectedChainId };
    },
    async alive() {
      requestId += 1;
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method: 'eth_chainId', params: [] }),
          signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
        });
        const payload = (await response.json()) as { result?: unknown };
        const expected = `0x${options.expectedChainId.toString(16)}`;
        if (response.ok && payload.result === expected) {
          lastDetail = 'ok';
          return true;
        }
        lastDetail = `chain-id probe mismatch (HTTP ${response.status})`;
        return false;
      } catch (error) {
        lastDetail = `chain-id probe failed: ${errorMessage(error)}`;
        return false;
      }
    },
    async evidence() {
      return lastDetail;
    },
  };
}

// ---------------------------------------------------------------------------
// Supervisor
// ---------------------------------------------------------------------------

interface UnitRecord {
  descriptor: UnitDescriptor;
  pausable: PausableUnit | null;
  identity: UnitIdentity | null;
}

export class Supervisor {
  private readonly records = new Map<string, UnitRecord>();
  private readonly order: string[] = [];
  private readonly intentional = new Set<string>();
  private readonly announced = new Set<string>();
  private readonly failures = new Map<string, number>();
  private readonly deathList: UnexpectedDeath[] = [];
  private readonly cleanups: Array<{ label: string; run: () => Promise<void> }> = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private readonly log: (message: string) => void;
  private readonly redact: (text: string) => string;
  private readonly intervalMs: number;
  private readonly onDeath: ((death: UnexpectedDeath) => void) | undefined;

  constructor(options: SupervisorOptions = {}) {
    this.log = options.log ?? (() => undefined);
    this.redact = options.redact ?? defaultRedact;
    this.intervalMs = options.intervalMs ?? 750;
    this.onDeath = options.onUnexpectedDeath;
  }

  add(descriptor: UnitDescriptor, extras: { pausable?: PausableUnit } = {}): void {
    if (this.records.has(descriptor.name)) {
      throw new Error(`supervisor: duplicate unit ${descriptor.name}`);
    }
    this.records.set(descriptor.name, {
      descriptor,
      pausable: extras.pausable ?? null,
      identity: null,
    });
    this.order.push(descriptor.name);
  }

  names(): string[] {
    return [...this.order];
  }

  /** Capture initial public identities; returns printable, secret-free lines. */
  async captureIdentities(): Promise<string[]> {
    const lines: string[] = [];
    for (const name of this.order) {
      const record = this.records.get(name)!;
      try {
        record.identity = await record.descriptor.identity();
      } catch (error) {
        record.identity = { error: errorMessage(error) };
      }
      lines.push(`${name} [${record.descriptor.kind}] ${describeIdentity(record.identity)}`);
    }
    return lines;
  }

  identityLines(): string[] {
    return this.order.map((name) => {
      const record = this.records.get(name)!;
      return `${name} [${record.descriptor.kind}] ${describeIdentity(record.identity)}`;
    });
  }

  startMonitoring(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stopMonitoring(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const name of this.order) {
        if (this.intentional.has(name)) continue;
        const record = this.records.get(name);
        if (!record) continue;
        let alive = false;
        try {
          alive = await record.descriptor.alive();
        } catch {
          alive = false;
        }
        if (alive) {
          this.failures.set(name, 0);
          continue;
        }
        const count = (this.failures.get(name) ?? 0) + 1;
        this.failures.set(name, count);
        if (count < 2 || this.announced.has(name)) continue;
        this.announced.add(name);
        await this.recordDeath(name, 'liveness probe failed twice consecutively');
      }
    } finally {
      this.ticking = false;
    }
  }

  private async recordDeath(name: string, detail: string): Promise<void> {
    const record = this.records.get(name);
    if (!record) return;
    let identity = record.identity;
    try {
      identity = await record.descriptor.identity();
      record.identity = identity;
    } catch {
      // Keep the last known identity.
    }
    let evidence = '';
    try {
      evidence = this.redact((await record.descriptor.evidence?.()) ?? '').slice(0, 4_000);
    } catch (error) {
      evidence = this.redact(`<evidence unavailable: ${errorMessage(error)}>`);
    }
    const death: UnexpectedDeath = {
      name,
      kind: record.descriptor.kind,
      detail,
      at: Date.now(),
      identity,
      evidence,
    };
    this.deathList.push(death);
    this.log(`supervisor: UNEXPECTED DEATH ${name} [${record.descriptor.kind}] ${describeIdentity(identity)}: ${detail}`);
    try {
      this.onDeath?.(death);
    } catch {
      // Death notification must never mask the recorded failure.
    }
  }

  /** Planned maintenance: temporarily exclude a unit from death detection. */
  async pause(name: string): Promise<void> {
    const record = this.records.get(name);
    if (!record) throw new Error(`supervisor: unknown unit ${name}`);
    if (!record.pausable) throw new Error(`supervisor: unit ${name} does not support pause`);
    this.intentional.add(name);
    this.failures.set(name, 0);
    this.announced.delete(name);
    try {
      await record.pausable.pause();
    } catch (error) {
      this.intentional.delete(name);
      throw error;
    }
  }

  async resume(name: string): Promise<void> {
    const record = this.records.get(name);
    if (!record) throw new Error(`supervisor: unknown unit ${name}`);
    if (!record.pausable) throw new Error(`supervisor: unit ${name} does not support resume`);
    await record.pausable.resume();
    record.identity = await record.descriptor.identity();
    this.intentional.delete(name);
    this.failures.set(name, 0);
    this.announced.delete(name);
  }

  /** Maintenance window for a unit that restarts on a different channel. */
  beginMaintenance(name: string): void {
    if (!this.records.has(name)) throw new Error(`supervisor: unknown unit ${name}`);
    this.intentional.add(name);
    this.failures.set(name, 0);
    this.announced.delete(name);
  }

  async endMaintenance(name: string): Promise<void> {
    const record = this.records.get(name);
    if (!record) throw new Error(`supervisor: unknown unit ${name}`);
    record.identity = await record.descriptor.identity();
    this.intentional.delete(name);
    this.failures.set(name, 0);
    this.announced.delete(name);
  }

  /** Permanent stop of a single unit (planned teardown). */
  async stopUnit(name: string): Promise<void> {
    const record = this.records.get(name);
    if (!record) return;
    this.intentional.add(name);
    await record.descriptor.stop?.();
  }

  deaths(): readonly UnexpectedDeath[] {
    return this.deathList;
  }

  assertNoUnexpectedDeaths(stage: string): void {
    if (this.deathList.length === 0) return;
    const details = this.deathList
      .map((death) => `${death.name} [${death.kind}] ${describeIdentity(death.identity)}: ${death.detail}`)
      .join('; ');
    throw new Error(`unexpected unit death during ${stage}: ${details}`);
  }

  /** Assert that every registered unit is alive right now. */
  async assertAllAlive(stage: string): Promise<void> {
    const problems: string[] = [];
    for (const name of this.order) {
      if (this.intentional.has(name)) continue;
      const record = this.records.get(name)!;
      let alive = false;
      try {
        alive = await record.descriptor.alive();
      } catch (error) {
        problems.push(`${name}: liveness probe error ${errorMessage(error)}`);
        continue;
      }
      if (!alive) {
        try {
          record.identity = await record.descriptor.identity();
        } catch {
          // Keep the last known identity.
        }
        problems.push(`${name} [${record.descriptor.kind}] ${describeIdentity(record.identity)} is not alive`);
      }
    }
    if (problems.length > 0) {
      throw new Error(`unit liveness failure during ${stage}: ${problems.join('; ')}`);
    }
    this.assertNoUnexpectedDeaths(stage);
  }

  addCleanup(label: string, run: () => Promise<void>): void {
    this.cleanups.push({ label, run });
  }

  /** Stop every unit (reverse order) and run cleanups; never throws. */
  async dispose(): Promise<string[]> {
    const errors: string[] = [];
    this.stopMonitoring();
    for (const name of [...this.order].reverse()) {
      try {
        await this.stopUnit(name);
      } catch (error) {
        errors.push(`stop ${name}: ${errorMessage(error)}`);
      }
    }
    for (const cleanup of [...this.cleanups].reverse()) {
      try {
        await cleanup.run();
      } catch (error) {
        errors.push(`cleanup ${cleanup.label}: ${errorMessage(error)}`);
      }
    }
    this.cleanups.length = 0;
    return errors;
  }
}
