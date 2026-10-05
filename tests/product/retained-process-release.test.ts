/**
 * Focused NON-PAID regression: retained-diagnostics finalization must not leave
 * the harness orchestrator pinned on the external fixture's piped process
 * children.
 *
 * The probe (tests/product/fixtures/retained-exit-probe.ts) reproduces the
 * fixture's quorum TCP-proxy spawn shape exactly (piped stdout + unref + data
 * listener) and calls the tracked `Supervisor.releaseProcessUnits()`. The probe
 * is required to exit NATURALLY within the bounded wait: a `process.exit`, a
 * self-SIGTERM or a timeout kill would show up as a non-zero/`SIGKILL` close
 * and fail this test. The pidfile allows cleanup of a leftover grandchild when
 * the regression fails.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const PROBE = fileURLToPath(new URL('./fixtures/retained-exit-probe.ts', import.meta.url));
const NATURAL_EXIT_TIMEOUT_MS = 20_000;

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nlhe-retained-exit-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('retained-diagnostics process release', () => {
  it('naturally exits after releasing a supervised piped TCP-proxy process unit', async () => {
    const dir = tempDir();
    const pidFile = join(dir, 'proxy.pid');
    const probe = spawn(process.execPath, ['--import', 'tsx', PROBE, '--pidfile', pidFile], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    probe.stdout.on('data', (chunk) => (stdout += chunk.toString()));
    probe.stderr.on('data', (chunk) => (stderr += chunk.toString()));

    const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; timedOut: boolean }>(
      (resolve) => {
        const timer = setTimeout(() => {
          probe.kill('SIGKILL');
          resolve({ code: null, signal: 'SIGKILL', timedOut: true });
        }, NATURAL_EXIT_TIMEOUT_MS);
        probe.on('close', (code, signal) => {
          clearTimeout(timer);
          resolve({ code, signal, timedOut: false });
        });
      }
    );

    // Cleanup a leftover grandchild if the release path failed to dispose it.
    try {
      if (existsSync(pidFile)) {
        const pid = Number(readFileSync(pidFile, 'utf8').trim());
        if (Number.isInteger(pid) && pid > 1) process.kill(pid, 'SIGKILL');
      }
    } catch {
      // Already gone.
    }

    expect({ stdout, stderr, ...outcome }).toMatchObject({ timedOut: false, signal: null, code: 0 });
    expect(stdout).toContain('released');
  });
});
