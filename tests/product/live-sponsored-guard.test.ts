/**
 * Focused guard regressions for the guarded standalone live SPONSORED wrapper.
 *
 * No paid provider, topology, or container is touched: only the pure opt-in
 * guards, the reviewed deterministic-summary validator, and the frozen caps
 * shared with the in-repo live suite.
 */
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  parseLiveSponsoredArgs,
  requireSecretScanner,
  validateDeterministicGateSummary,
} from '../integration/container-live-sponsored.js';
import { LIVE_CAPS, LIVE_PER_CALL_COST_USD_MICRO, LIVE_PRICING, assertLiveRoomOutcome } from '../integration/live.js';

const RELEASE_DIGEST = 'sha256:115beb096708048f98eb6271c65e6bb4f833c1dc03618cdc8bf3ce2a8f8b5469';
const RELEASE_IMAGE = `ghcr.io/aaurelions/pokertools@${RELEASE_DIGEST}`;
const PLATFORM_IMAGE_ID = `sha256:${'1'.repeat(64)}`;
const PRODUCT_IMAGE_ID = `sha256:${'2'.repeat(64)}`;

function validSummary(): Record<string, unknown> {
  return {
    mode: 'full',
    exitCode: 0,
    runId: 'gate-run',
    checks: [{ name: 'fresh topology readiness', status: 'PASS' }],
    secretScan: 'pass',
    gate: { roomId: 'gate-room', tableId: 'gate-table', restartModes: ['graceful', 'kill'] },
    platformVersion: '2.0.4',
    platformImage: RELEASE_IMAGE,
    platformImageId: PLATFORM_IMAGE_ID,
    platformDigest: RELEASE_DIGEST,
    productImage: 'nlhe-product:container-gate',
    productImageId: PRODUCT_IMAGE_ID,
    terminalFold: {
      status: 'PASS',
      requestId: 'fold-request-1',
      tableId: 'gate-table',
      handId: 'fold-hand-1',
      family: 'FOLD',
      handCompleted: true,
      archiveCompleted: true,
      directorProgressed: true,
      continuation: 'NEXT_HAND',
      roomTerminal: true,
      platform429: 0,
      secretScan: 'pass',
      provenance: {
        platform: {
          version: '2.0.4',
          image: RELEASE_IMAGE,
          imageId: PLATFORM_IMAGE_ID,
          digest: RELEASE_DIGEST,
        },
        product: { image: 'nlhe-product:container-gate', imageId: PRODUCT_IMAGE_ID },
      },
    },
  };
}

describe('live sponsored argument parsing', () => {
  it('accepts only the reviewed guard inputs', () => {
    expect(parseLiveSponsoredArgs([])).toEqual({ check: false, gateSummary: null, gateExitCode: null, marker: null });
    expect(
      parseLiveSponsoredArgs([
        '--check',
        '--gate-summary',
        '/tmp/summary.json',
        '--gate-exit-code',
        '0',
        '--marker',
        '/tmp/marker.json',
      ])
    ).toEqual({
      check: true,
      gateSummary: '/tmp/summary.json',
      gateExitCode: 0,
      marker: '/tmp/marker.json',
    });
    expect(() => parseLiveSponsoredArgs(['--execute'])).toThrow(/unknown live-sponsored argument/);
    expect(() => parseLiveSponsoredArgs(['--marker'])).toThrow(/requires a value/);
    expect(() => parseLiveSponsoredArgs(['--gate-exit-code', 'zero'])).toThrow(/must be an integer/);
  });
});

describe('deterministic gate summary guard', () => {
  it('accepts a reviewed full-mode PASS summary with summary and reviewed exit code 0', () => {
    expect(() => validateDeterministicGateSummary(validSummary(), 0)).not.toThrow();
    const artifact = validateDeterministicGateSummary(validSummary(), 0);
    expect(artifact.platform).toEqual({
      version: '2.0.4',
      image: RELEASE_IMAGE,
      imageId: PLATFORM_IMAGE_ID,
      digest: RELEASE_DIGEST,
    });
    expect(artifact.product).toEqual({ image: 'nlhe-product:container-gate', imageId: PRODUCT_IMAGE_ID });
    expect(artifact.terminalFold.evidence.status).toBe('PASS');
    expect(artifact.terminalFold.evidence.family).toBe('FOLD');
    expect(artifact.terminalFold.provenance.platform).toEqual(artifact.platform);
  });

  it('refuses summaries without immutable artifact provenance', () => {
    for (const field of [
      'platformVersion',
      'platformImage',
      'platformImageId',
      'platformDigest',
      'productImage',
      'productImageId',
    ]) {
      expect(() => validateDeterministicGateSummary({ ...validSummary(), [field]: undefined }, 0)).toThrow(
        new RegExp(field)
      );
    }
  });

  it('refuses full summaries without the focused terminal FOLD proof', () => {
    expect(() =>
      validateDeterministicGateSummary({ ...validSummary(), terminalFold: undefined }, 0)
    ).toThrow(/terminalFold is missing/);
    expect(() => validateDeterministicGateSummary({ ...validSummary(), terminalFold: null }, 0)).toThrow(
      /terminalFold is missing/
    );
  });

  it('refuses a summary that records exitCode 1 even when the caller passes 0', () => {
    // A cleanup/teardown failure can keep every check PASS while exiting 1;
    // that summary must never authorize a paid run.
    expect(() => validateDeterministicGateSummary({ ...validSummary(), exitCode: 1 }, 0)).toThrow(
      /summary exitCode 1 != 0/
    );
    expect(() => validateDeterministicGateSummary({ ...validSummary(), exitCode: undefined }, 0)).toThrow(
      /summary exitCode/
    );
  });

  it('refuses a non-zero reviewed exit code', () => {
    expect(() => validateDeterministicGateSummary(validSummary(), 1)).toThrow(/reviewed exit code 1 != 0/);
  });

  it('refuses non-full, skipped-scan, failed-check, empty-check and gate-less summaries', () => {
    expect(() => validateDeterministicGateSummary({ ...validSummary(), mode: 'readiness' }, 0)).toThrow(/!= full/);
    expect(() => validateDeterministicGateSummary({ ...validSummary(), secretScan: 'skipped' }, 0)).toThrow(/!= pass/);
    expect(() =>
      validateDeterministicGateSummary(
        { ...validSummary(), checks: [{ name: 'x', status: 'FAIL' }] },
        0
      )
    ).toThrow(/non-PASS/);
    expect(() => validateDeterministicGateSummary({ ...validSummary(), checks: [] }, 0)).toThrow(/no checks/);
    expect(() => validateDeterministicGateSummary({ ...validSummary(), gate: null }, 0)).toThrow(
      /no completed standalone gate result/
    );
    expect(() => validateDeterministicGateSummary('not-an-object', 0)).toThrow(/not an object/);
  });
});

describe('mandatory final secret scanner guard', () => {
  it('requires an absolute, existing scanner path', () => {
    expect(() => requireSecretScanner(undefined)).toThrow(/NLHE_IT_SECRET_SCANNER is required/);
    expect(() => requireSecretScanner('')).toThrow(/NLHE_IT_SECRET_SCANNER is required/);
    expect(() => requireSecretScanner('./scanner.mjs')).toThrow(/absolute path/);
    expect(() => requireSecretScanner('/nonexistent/nlhe-final-secret-check.mjs')).toThrow(/absolute path/);
    const existing = fileURLToPath(import.meta.url);
    expect(requireSecretScanner(existing)).toBe(existing);
  });
});

describe('frozen live caps and shared outcome helper', () => {
  it('keeps the reviewed caps/pricing constants unchanged', () => {
    expect(LIVE_CAPS).toEqual({
      maxCalls: 24,
      maxCostUsdMicro: 50_000n,
      perCallTimeoutMs: 5_000,
      overallRuntimeMs: 120_000,
      maxHands: 8,
    });
    expect(LIVE_PRICING).toEqual({ input: 200_000, output: 1_000_000 });
    expect(LIVE_PER_CALL_COST_USD_MICRO).toBe(Math.floor(50_000 / 24));
  });

  it('exposes the shared outcome assertion used by the wrapper', () => {
    expect(typeof assertLiveRoomOutcome).toBe('function');
  });
});
