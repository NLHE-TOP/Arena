/**
 * Child-process supervision and HTTP readiness helpers for the real local
 * acceptance topology. Logs are streamed to the run's artifact directory and
 * tailed into errors so a failed start is diagnosable from CI output.
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { createWriteStream, readFileSync, type WriteStream } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import {
  buildChildEnv,
  redactCommandLine,
  redactSecretText,
  type SecretSource,
} from './env-boundary.js';

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('no port assigned')));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

export function tailFile(path: string, lines = 30): string {
  try {
    return readFileSync(path, 'utf8').split('\n').slice(-lines).join('\n');
  } catch {
    return '<no log>';
  }
}

export interface CommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** Redacted command line; safe for diagnostics. */
  command: string;
}

export interface CommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  logFile?: string;
  /**
   * In-process generated credentials that are absent from `process.env`
   * (for example a random disposable database password passed through argv).
   * They are redacted from the command line, the log file and error tails.
   */
  knownSecrets?: readonly string[];
}

/**
 * Credential sources for one child: the ambient environment AND the child's
 * own environment are collected independently, so a child env that overrides
 * an ambient variable name cannot hide the ambient value from redaction.
 */
function redactionSources(options: { env?: NodeJS.ProcessEnv }): SecretSource {
  return options.env === undefined ? process.env : [process.env, options.env];
}

/**
 * Line-buffered log writer. Complete lines are redacted before they reach the
 * artifact log, so a credential split across stream chunks is never written as
 * a partial value. `end()` flushes the final unterminated line.
 */
function redactingLineWriter(
  sink: WriteStream,
  source: SecretSource,
  knownSecrets: readonly string[]
): { write: (chunk: string) => void; end: () => void } {
  let pending = '';
  return {
    write(chunk: string): void {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) sink.write(redactSecretText(`${line}\n`, knownSecrets, source));
    },
    end(): void {
      if (pending.length > 0) sink.write(redactSecretText(pending, knownSecrets, source));
      pending = '';
    },
  };
}

export function runCommand(
  command: string,
  args: string[],
  options: CommandOptions = {}
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      // Every child is explicitly bounded: no ambient environment is inherited
      // unless the caller declares it.
      env: options.env ?? buildChildEnv({ purpose: 'platform', declared: {} }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timer =
      options.timeoutMs !== undefined && options.timeoutMs > 0
        ? setTimeout(() => {
            child.kill('SIGKILL');
          }, options.timeoutMs)
        : null;
    let settled = false;
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      settled = true;
      reject(error);
    });
    child.on('close', async (code, signal) => {
      if (timer) clearTimeout(timer);
      if (settled) return;
      settled = true;
      const knownSecrets = options.knownSecrets ?? [];
      const source = redactionSources(options);
      if (options.logFile) {
        const sink = createWriteStream(options.logFile, { flags: 'a' });
        const closed = new Promise<void>((flushed, failed) => {
          sink.on('error', failed);
          sink.once('close', () => flushed());
        });
        sink.write(`${redactCommandLine(command, args, source, knownSecrets)}\n`);
        // Streams stay exact for callers; the diagnostic log is redacted.
        sink.write(redactSecretText(stdout, knownSecrets, source));
        sink.write(redactSecretText(stderr, knownSecrets, source));
        sink.end();
        // A failed log write must reject this promise (never surface as an
        // unhandled stream error) and must not leave the caller waiting.
        try {
          await closed;
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
      }
      resolve({
        code,
        signal,
        stdout,
        stderr,
        command: redactCommandLine(command, args, source, knownSecrets),
      });
    });
  });
}

export async function runCommandOrThrow(
  command: string,
  args: string[],
  options: CommandOptions = {}
): Promise<CommandResult> {
  const result = await runCommand(command, args, options);
  if (result.code !== 0) {
    const details = `${result.command} exited ${result.code}${result.signal ? ` (${result.signal})` : ''}`;
    const tail = (result.stderr || result.stdout).split('\n').slice(-25).join('\n');
    throw new Error(
      `${details}\n${redactSecretText(tail, options.knownSecrets ?? [], redactionSources(options))}`
    );
  }
  return result;
}

export interface ManagedProcess {
  name: string;
  child: ChildProcessByStdio<null, Readable, Readable>;
  logPath: string;
  pid: number | undefined;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stop: (signal?: NodeJS.Signals) => Promise<void>;
  /** Hard kill (SIGKILL) for deterministic crash-window tests. */
  kill: () => Promise<void>;
}

export function spawnManaged(
  name: string,
  command: string,
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    logDir: string;
    /**
     * In-process generated credentials for this child. Ambient and declared
     * child env credentials are collected automatically as separate sources.
     */
    knownSecrets?: readonly string[];
  }
): ManagedProcess {
  const logPath = join(options.logDir, `${name}.log`);
  const sink = createWriteStream(logPath, { flags: 'a' });
  const source = redactionSources(options);
  const knownSecrets = options.knownSecrets ?? [];
  sink.write(`${redactCommandLine(command, args, source, knownSecrets)}\n`);
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? buildChildEnv({ purpose: 'platform', declared: {} }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const writer = redactingLineWriter(sink, source, knownSecrets);
  child.stdout.on('data', (chunk: Buffer) => writer.write(chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => writer.write(chunk.toString()));
  // Artifact logs are diagnostics: a failed write must never crash the run.
  sink.on('error', () => undefined);

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('close', (code, signal) => {
      writer.end();
      sink.end();
      // The log is flushed before callers observe the process as exited. A
      // sink that already closed (for example after a failed write) resolves
      // immediately instead of hanging the supervisor.
      if (sink.closed) {
        resolve({ code, signal });
        return;
      }
      sink.once('close', () => resolve({ code, signal }));
    });
  });

  const managed: ManagedProcess = {
    name,
    child,
    logPath,
    pid: child.pid,
    exited,
    stop: async (signal: NodeJS.Signals = 'SIGTERM') => {
      if (child.exitCode !== null || child.signalCode !== null) {
        await exited;
        return;
      }
      child.kill(signal);
      const killed = await Promise.race([
        exited.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
      ]);
      if (!killed) {
        child.kill('SIGKILL');
        await exited;
      }
    },
    kill: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    },
  };
  return managed;
}

export async function waitForHttp(
  url: string,
  options: {
    timeoutMs?: number;
    intervalMs?: number;
    accept?: (response: Response) => boolean | Promise<boolean>;
    onRetry?: (error: unknown) => void;
    logPath?: string;
  } = {}
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const intervalMs = options.intervalMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(Math.min(5000, timeoutMs)) });
      if (options.accept === undefined || (await options.accept(response))) {
        return response;
      }
      lastError = new Error(`HTTP ${response.status} from ${url}`);
    } catch (error) {
      lastError = error;
    }
    options.onRetry?.(lastError);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  const logs = options.logPath
    ? `\n--- ${options.logPath} ---\n${redactSecretText(tailFile(options.logPath))}`
    : '';
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${url}: ${detail}${logs}`);
}
