/**
 * Focused natural-exit probe for retained-diagnostics finalization.
 *
 * Reproduces the EXACT pinning shape of the external staging fixture's quorum
 * TCP proxies: a child process spawned with `stdio: ['ignore','pipe','ignore']`,
 * `unref()`ed, with an active `stdout` data listener. While that child runs, its
 * open stdout pipe keeps the parent Node event loop alive; the tracked
 * `Supervisor.releaseProcessUnits()` must dispose the supervised process unit so
 * this probe exits NATURALLY (no `process.exit`, no self-SIGTERM).
 *
 * Exits 0 only when every supervised process unit was released; the pidfile
 * lets the parent test clean up a leftover grandchild when the regression fails.
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { Supervisor, adoptProcess } from '../../integration/infra/supervisor.js';
import { runCommand } from '../../integration/infra/proc.js';

const pidFlagIndex = process.argv.indexOf('--pidfile');
const pidFile = pidFlagIndex >= 0 ? process.argv[pidFlagIndex + 1] : null;
if (pidFile === null || pidFile === undefined) {
  console.error('retained-exit-probe: --pidfile <path> is required');
  process.exitCode = 2;
} else {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  child.on('error', () => undefined);
  child.unref?.();
  // Exact fixture pattern: the stdout pipe stays open and listened.
  child.stdout.on('data', () => undefined);
  if (child.pid === undefined) {
    console.error('retained-exit-probe: child has no pid');
    process.exitCode = 2;
  } else {
    writeFileSync(pidFile, `${child.pid}\n`, { mode: 0o600 });
    const startTime = await runCommand('ps', ['-o', 'lstart=', '-p', String(child.pid)], {
      timeoutMs: 5_000,
    });
    const supervisor = new Supervisor();
    supervisor.add(
      adoptProcess('probe-tcp-proxy', child.pid, startTime.stdout.trim(), async () => child.exitCode === null)
    );
    await supervisor.captureIdentities();
    supervisor.startMonitoring();
    const released = await supervisor.releaseProcessUnits(5_000);
    if (released.length !== 1 || !released.every((unit) => unit.released)) {
      console.error(`retained-exit-probe: release failed ${JSON.stringify(released)}`);
      process.exitCode = 1;
    } else {
      console.log(`retained-exit-probe: released ${JSON.stringify(released)}`);
    }
    // No process.exit: the process must drain and exit naturally.
  }
}
