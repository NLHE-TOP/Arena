/**
 * Focused regression for command diagnostics that carry credentials generated
 * in-process (for example a disposable PostgreSQL password). Such values never
 * exist in `process.env`, so they must be declared explicitly and redacted
 * before any command line, log line or bounded error tail is produced.
 *
 * Assertions compare booleans and generic messages only: a failing test must
 * never print the credential or one of its fragments.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { redactCommandLine } from '../integration/infra/env-boundary.js';
import { runCommand, runCommandOrThrow, spawnManaged } from '../integration/infra/proc.js';

/** A generated credential that exists nowhere in the ambient environment. */
function generatedSecret(): string {
  const secret = `gen-${randomBytes(18).toString('hex')}`;
  expect(
    Object.values(process.env).includes(secret),
    'the regression credential must not come from process.env'
  ).toBe(false);
  return secret;
}

/** Full value plus meaningful prefixes, suffixes and middles (8/12/16 chars). */
function disclosedFragments(secret: string): string[] {
  const fragments = [secret];
  for (const length of [8, 12, 16]) {
    if (secret.length <= length + 2) continue;
    fragments.push(secret.slice(0, length), secret.slice(-length));
    const middle = Math.floor((secret.length - length) / 2);
    fragments.push(secret.slice(middle, middle + length));
  }
  return fragments;
}

function assertNoDisclosure(text: string, secret: string, context: string): void {
  for (const fragment of disclosedFragments(secret)) {
    expect(
      text.includes(fragment),
      `${context}: output carries a ${fragment.length}-char credential fragment`
    ).toBe(false);
  }
}

describe('generated-credential command diagnostics', () => {
  it('redacts a generated argv credential from the logged command line', () => {
    const secret = generatedSecret();
    const line = redactCommandLine(
      'docker',
      ['run', '-e', `POSTGRES_PASSWORD=${secret}`, 'postgres:18-alpine'],
      process.env,
      [secret]
    );
    assertNoDisclosure(line, secret, 'redactCommandLine');
    expect(line).toContain('POSTGRES_PASSWORD=');
    expect(line).toContain('<redacted>');
  });

  it('redacts the redacted command on CommandResult and in bounded error tails', async () => {
    const secret = generatedSecret();
    // 30 stderr lines: the secret is on the dropped first line, on the first
    // retained line of the 25-line tail, and on the last retained line.
    const script = [
      'const lines = [];',
      'for (let i = 0; i < 30; i += 1) {',
      '  if (i === 0) lines.push(`dropped ${process.argv[1]}`);',
      '  else if (i === 5) lines.push(`first-retained ${process.argv[1]} tail`);',
      '  else if (i === 29) lines.push(`last ${process.argv[1]}`);',
      '  else lines.push(`filler-${i}`);',
      '}',
      "process.stderr.write(lines.join('\\n'));",
      'process.exit(9);',
    ].join('\n');

    const failure = await runCommandOrThrow('node', ['-e', script, secret], {
      env: { ...process.env },
      knownSecrets: [secret],
      timeoutMs: 10_000,
    }).then(
      () => null,
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(Error);
    const message = failure instanceof Error ? failure.message : '';
    expect(message.length, 'failed command must explain itself').toBeGreaterThan(0);
    assertNoDisclosure(message, secret, 'runCommandOrThrow error');
    expect(message).toContain('<redacted>');

    const result = await runCommand('node', ['-e', 'process.exit(3)', secret], {
      env: { ...process.env },
      knownSecrets: [secret],
      timeoutMs: 10_000,
    });
    expect(result.code).toBe(3);
    assertNoDisclosure(result.command, secret, 'CommandResult.command');
    expect(result.command).toContain('<redacted>');
  });

  it('redacts the log file while returned streams stay exact for callers', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nlhe-diag-redaction-'));
    try {
      const secret = generatedSecret();
      const logFile = join(directory, 'command.log');
      const script = 'process.stdout.write(`out ${process.argv[1]}`); process.stderr.write(`err ${process.argv[1]}`);';
      const result = await runCommand('node', ['-e', script, secret], {
        env: { ...process.env },
        knownSecrets: [secret],
        timeoutMs: 10_000,
        logFile,
      });
      expect(result.code).toBe(0);
      expect(result.stdout.includes(secret), 'returned stdout remains exact for parsing').toBe(true);
      expect(result.stderr.includes(secret), 'returned stderr remains exact for parsing').toBe(true);

      const logged = readFileSync(logFile, 'utf8');
      assertNoDisclosure(logged, secret, 'command log file');
      expect(logged).toContain('<redacted>');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects when the diagnostic log cannot be written instead of leaking a stream error', async () => {
    const missingDirectory = join(tmpdir(), `nlhe-missing-${randomBytes(6).toString('hex')}`);
    const failure = await runCommand('node', ['-e', 'process.exit(0)'], {
      logFile: join(missingDirectory, 'command.log'),
      timeoutMs: 10_000,
    }).then(
      () => null,
      (error: unknown) => error
    );
    expect(failure, 'a failed log write must reject the command promise').toBeInstanceOf(Error);
  });

  it('keeps both ambient and child-overridden credentials redacted', async () => {
    const ambient = `ambient-${randomBytes(18).toString('hex')}`;
    const childOverride = `child-${randomBytes(18).toString('hex')}`;
    const name = 'NLHE_TEST_BOUNDARY_SECRET';
    const previous = process.env[name];
    process.env[name] = ambient;
    try {
      const result = await runCommand('node', ['-e', 'process.exit(3)', ambient, childOverride], {
        env: { ...process.env, [name]: childOverride },
        timeoutMs: 10_000,
      });
      expect(result.code).toBe(3);
      assertNoDisclosure(result.command, ambient, 'ambient-env credential');
      assertNoDisclosure(result.command, childOverride, 'child-overridden credential');
      expect(result.command).toContain('<redacted>');
    } finally {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
  });

  it('redacts spawnManaged logs per complete line when a secret spans stream chunks', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nlhe-diag-spawn-'));
    try {
      const secret = generatedSecret();
      const script = [
        'const value = process.env.BOUNDARY_CHILD_SECRET;',
        "process.stdout.write('prefix ' + value.slice(0, 10));",
        "setTimeout(() => { process.stdout.write(value.slice(10) + ' suffix\\n'); }, 40);",
      ].join('\n');
      const managed = spawnManaged('child', process.execPath, ['-e', script], {
        cwd: directory,
        env: { ...process.env, BOUNDARY_CHILD_SECRET: secret },
        logDir: directory,
      });
      const exit = await managed.exited;
      expect(exit.code).toBe(0);
      const logged = readFileSync(managed.logPath, 'utf8');
      assertNoDisclosure(logged, secret, 'spawnManaged child log');
      expect(logged).toContain('<redacted>');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
