#!/usr/bin/env tsx
/**
 * Focused regression for teardown log capture:
 * - only `*.log` files under the runtime dir are snapshotted (never `.env`,
 *   manifests or JSON metadata);
 * - every captured byte passes through the redactor;
 * - an empty runtime dir records a safe diagnostic instead of an empty file.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshotRuntimeLogs } from './staging.js';

const dir = mkdtempSync(join(tmpdir(), 'nlhe-staging-logs-selftest-'));
const secret = 'nlheit-test-secret-value-0123456789abcdef';
const redact = (text: string): string => text.split(secret).join('<redacted>');

try {
  mkdirSync(join(dir, 'nested'), { recursive: true });
  writeFileSync(join(dir, 'anvil.log'), `anvil start key=${secret}\n`);
  writeFileSync(join(dir, 'nested', 'quorum.log'), `quorum up token=${secret}\n`);
  writeFileSync(join(dir, 'runtime.env'), `JWT_SECRET=${secret}\n`);
  writeFileSync(join(dir, 'manifest.json'), `{"secret":"${secret}"}\n`);

  const destination = join(dir, 'captured.log');
  const result = snapshotRuntimeLogs(dir, destination, redact);
  if (result.files !== 2) throw new Error(`expected 2 captured .log files, saw ${result.files}`);
  const captured = readFileSync(destination, 'utf8');
  if (captured.includes(secret)) throw new Error('captured runtime logs leaked an unredacted secret');
  if (!captured.includes('<redacted>')) throw new Error('captured runtime logs were not redacted');
  if (captured.includes('JWT_SECRET=') || captured.includes('"secret"')) {
    throw new Error('captured runtime logs included a non-.log file');
  }
  if (!captured.includes('anvil.log') || !captured.includes(join('nested', 'quorum.log'))) {
    throw new Error('captured runtime logs missed a nested .log file');
  }

  const emptyDir = mkdtempSync(join(tmpdir(), 'nlhe-staging-logs-empty-'));
  try {
    const emptyDestination = join(emptyDir, 'captured.log');
    const empty = snapshotRuntimeLogs(emptyDir, emptyDestination, redact);
    if (empty.files !== 0) throw new Error(`expected 0 files, saw ${empty.files}`);
    const emptyText = readFileSync(emptyDestination, 'utf8');
    if (!emptyText.includes('no runtime .log files')) {
      throw new Error('empty runtime dir did not record a safe diagnostic');
    }
  } finally {
    rmSync(emptyDir, { recursive: true, force: true });
  }

  console.log('staging log capture PASS: .log only, recursive, redacted, safe empty diagnostic');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
