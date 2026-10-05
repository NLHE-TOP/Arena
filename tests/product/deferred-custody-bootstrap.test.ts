/**
 * Focused pure regressions for the acceptance-only deferred custody bootstrap.
 *
 * No topology, provider or container is touched: only the default-resolution
 * helpers and static source shapes that keep deferral impossible unless the
 * CHALLENGE wrapper explicitly opts in, and keep the normal standalone
 * startup contract (health + ready) as the default.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveDeferredCustodyUnit } from '../integration/infra/staging.js';
import { shouldWaitForInitialReady } from '../integration/infra/standalone-container.js';

function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
}

describe('deferred custody unit resolution', () => {
  it('never defers by default, even if a fixture declares a planned unit', () => {
    expect(resolveDeferredCustodyUnit(false, {})).toBeNull();
    expect(resolveDeferredCustodyUnit(false, { deferredCustodyUnit: 'custody-planned' })).toBeNull();
  });

  it('fails closed when deferral is requested without a declared planned unit', () => {
    expect(() => resolveDeferredCustodyUnit(true, {})).toThrow(/did not declare the planned custody unit/);
    expect(() => resolveDeferredCustodyUnit(true, { deferredCustodyUnit: '' })).toThrow(
      /did not declare the planned custody unit/
    );
  });

  it('resolves the planned unit only for an explicit deferred bootstrap', () => {
    expect(resolveDeferredCustodyUnit(true, { deferredCustodyUnit: 'nlhe-stage-custody-x' })).toBe(
      'nlhe-stage-custody-x'
    );
  });
});

describe('standalone initial readiness wait default', () => {
  it('waits for /ready unless the caller explicitly opts out', () => {
    expect(shouldWaitForInitialReady(undefined)).toBe(true);
    expect(shouldWaitForInitialReady(true)).toBe(true);
    expect(shouldWaitForInitialReady(false)).toBe(false);
  });
});

describe('deferred custody opt-in is challenge-only by source shape', () => {
  const defaultCallers = [
    '../integration/container-gate.ts',
    '../integration/acceptance/container-gate.ts',
    '../integration/container-live-sponsored.ts',
  ];

  it('no deterministic/SPONSORED caller requests deferred custody or skips initial readiness', () => {
    for (const caller of defaultCallers) {
      const source = readSource(caller);
      expect(source, caller).not.toContain('deferCustodyStartup');
      expect(source, caller).not.toContain('waitForInitialReady');
    }
  });

  it('only the live CHALLENGE wrapper opts into the deferred bootstrap', () => {
    const source = readSource('../integration/container-live-challenge.ts');
    expect(source).toContain('deferCustodyStartup: true');
    expect(source).toContain('waitForInitialReady: false');
    expect(source).toMatch(/startCustody[\s\S]*endMaintenance[\s\S]*assertFinancialEvidence[\s\S]*waitForProductReady/);
  });
});
