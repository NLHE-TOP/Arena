/**
 * Focused guard/static regressions for the guarded standalone live CHALLENGE
 * wrapper.
 *
 * No paid provider, topology, container or database is touched: only the pure
 * opt-in/artifact guards, the pure read-only finance adapter and the frozen
 * caps/terms shared with the in-repo live suite.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFERRED_CUSTODY_BOOTSTRAP,
  activateDeferredCustody,
  buildChallengeFinancialTopology,
  parseLiveChallengeArgs,
  validateLiveSponsoredResult,
} from '../integration/container-live-challenge.js';
import type { StagingPlatformFinance } from '../integration/infra/staging.js';
import {
  assertPlatformArtifactMatches,
  assertProductArtifactMatches,
  type PlatformArtifact,
  type ProductArtifact,
} from '../integration/infra/provenance.js';
import {
  LIVE_CAPS,
  LIVE_CHALLENGE_ENTRY_ATOMIC,
  LIVE_CHALLENGE_PRIZE_ATOMIC,
  LIVE_PER_CALL_COST_USD_MICRO,
  LIVE_PRICING,
} from '../integration/live.js';

const RELEASE_DIGEST = 'sha256:115beb096708048f98eb6271c65e6bb4f833c1dc03618cdc8bf3ce2a8f8b5469';
const RELEASE_IMAGE = `ghcr.io/aaurelions/pokertools@${RELEASE_DIGEST}`;
const PLATFORM_IMAGE_ID = `sha256:${'1'.repeat(64)}`;
const PRODUCT_IMAGE_ID = `sha256:${'2'.repeat(64)}`;

function validSponsoredResult(): Record<string, unknown> {
  return {
    runId: 'sponsored-run',
    mode: 'SPONSORED',
    status: 'COMPLETE',
    gateSummaryPath: '/tmp/gate/container-gate-summary.json',
    gateSummaryRunId: 'gate-run',
    providerHost: 'api.provider.test',
    model: 'provider-model',
    roomId: 'sponsored-room',
    tableId: 'sponsored-table',
    calls: 4,
    committed: 2,
    costMicroUsd: 321,
    browserCode: 0,
    platform429Before: 0,
    platform429After: 0,
    scan: 'pass',
    cleanupFailure: null,
    teardownErrors: [],
    paidCallsConsumed: true,
    infraRetryEligible: false,
    platformVersion: '2.0.4',
    platformImage: RELEASE_IMAGE,
    platformImageId: PLATFORM_IMAGE_ID,
    platformDigest: RELEASE_DIGEST,
    productImage: 'nlhe-product:container-gate',
    productImageId: PRODUCT_IMAGE_ID,
  };
}

interface FinanceHarness {
  finance: StagingPlatformFinance;
  fixture: {
    bootstrapSponsorBudget: ReturnType<typeof vi.fn>;
    fundAndClaim: ReturnType<typeof vi.fn>;
    readPrincipalAccounts: ReturnType<typeof vi.fn>;
    startCustody: ReturnType<typeof vi.fn>;
    waitForReady: ReturnType<typeof vi.fn>;
  };
  restartApi: ReturnType<typeof vi.fn>;
}

function financeHarness(overrides: Partial<StagingPlatformFinance> = {}): FinanceHarness {
  const fixture = {
    bootstrapSponsorBudget: vi.fn(async () => ({ available: '7', operator: '3' })),
    fundAndClaim: vi.fn(async () => ({ txHash: '0xabc', logIndex: 2 })),
    readPrincipalAccounts: vi.fn(async () => ({ available: '11', operator: '5' })),
    startCustody: vi.fn(async () => undefined),
    waitForReady: vi.fn(async () => undefined),
  };
  return {
    finance: {
      assetId: 'eip155:31337/erc20:0xtoken',
      tokenAddress: '0xtoken',
      tokenDecimals: 6,
      sponsorPrincipalId: 'sponsor-1',
      sponsorAddress: '0xsponsor',
      treasuryAddress: '0xtreasury',
      ...fixture,
      ...overrides,
    },
    fixture,
    restartApi: vi.fn(async () => undefined),
  };
}

function adapterInput(overrides: Partial<StagingPlatformFinance> = {}) {
  const harness = financeHarness(overrides);
  return {
    ...harness,
    input: {
      finance: harness.finance,
      sponsorPrincipalId: 'sponsor-1',
      sponsorAddress: '0xsponsor',
      custodyLogPath: '/tmp/custody-container.log',
      // The harness keeps the Mock type for assertions; the adapter only needs
      // the callable shape.
      restartApi: harness.restartApi as unknown as () => Promise<void>,
    },
  };
}

function financeWith(
  base: { finance: StagingPlatformFinance },
  overrides: Partial<StagingPlatformFinance>
): StagingPlatformFinance {
  return { ...base.finance, ...overrides };
}

describe('live challenge argument parsing', () => {
  it('accepts only the reviewed guard inputs', () => {
    expect(parseLiveChallengeArgs([])).toEqual({
      check: false,
      gateSummary: null,
      gateExitCode: null,
      sponsoredResult: null,
      marker: null,
    });
    expect(
      parseLiveChallengeArgs([
        '--check',
        '--gate-summary',
        '/tmp/summary.json',
        '--gate-exit-code',
        '0',
        '--sponsored-result',
        '/tmp/sponsored.json',
        '--marker',
        '/tmp/marker.json',
      ])
    ).toEqual({
      check: true,
      gateSummary: '/tmp/summary.json',
      gateExitCode: 0,
      sponsoredResult: '/tmp/sponsored.json',
      marker: '/tmp/marker.json',
    });
    expect(() => parseLiveChallengeArgs(['--execute'])).toThrow(/unknown live-challenge argument/);
    expect(() => parseLiveChallengeArgs(['--marker'])).toThrow(/requires a value/);
    expect(() => parseLiveChallengeArgs(['--gate-exit-code', 'zero'])).toThrow(/must be an integer/);
  });
});

describe('completed SPONSORED result guard', () => {
  it('accepts an actual completed sponsored run and exposes its evidence', () => {
    const evidence = validateLiveSponsoredResult(validSponsoredResult());
    expect(evidence).toMatchObject({
      runId: 'sponsored-run',
      roomId: 'sponsored-room',
      tableId: 'sponsored-table',
      gateSummaryRunId: 'gate-run',
      providerHost: 'api.provider.test',
      model: 'provider-model',
      calls: 4,
      committed: 2,
      costMicroUsd: 321,
      platform: {
        version: '2.0.4',
        image: RELEASE_IMAGE,
        imageId: PLATFORM_IMAGE_ID,
        digest: RELEASE_DIGEST,
      },
      product: { image: 'nlhe-product:container-gate', imageId: PRODUCT_IMAGE_ID },
    });
  });

  it('refuses a historical COMPLETE SPONSORED artifact without actual provenance', () => {
    for (const field of [
      'platformVersion',
      'platformImage',
      'platformImageId',
      'platformDigest',
      'productImage',
      'productImageId',
    ]) {
      expect(() => validateLiveSponsoredResult({ ...validSponsoredResult(), [field]: undefined })).toThrow(
        new RegExp(field)
      );
    }
    expect(() =>
      validateLiveSponsoredResult({ ...validSponsoredResult(), platformImageId: 'not-a-sha' })
    ).toThrow(/platformImageId/);
    expect(() => validateLiveSponsoredResult({ ...validSponsoredResult(), platformDigest: null })).toThrow(
      /platformDigest/
    );
    expect(() => validateLiveSponsoredResult({ ...validSponsoredResult(), productImage: '' })).toThrow(
      /productImage/
    );
  });

  it('blocks a SPONSORED artifact produced on a different artifact than the reviewed gate', () => {
    const evidence = validateLiveSponsoredResult(validSponsoredResult());
    const gate: PlatformArtifact = {
      version: '2.0.4',
      image: RELEASE_IMAGE,
      imageId: PLATFORM_IMAGE_ID,
      digest: RELEASE_DIGEST,
    };
    const gateProduct: ProductArtifact = { image: 'nlhe-product:container-gate', imageId: PRODUCT_IMAGE_ID };
    expect(() =>
      assertPlatformArtifactMatches('persisted SPONSORED platform', gate, evidence.platform)
    ).not.toThrow();
    expect(() =>
      assertProductArtifactMatches('persisted SPONSORED product', gateProduct, evidence.product)
    ).not.toThrow();
    for (const override of [
      { version: '2.0.2' },
      { image: 'ghcr.io/aaurelions/pokertools:2.0.4' },
      { imageId: `sha256:${'9'.repeat(64)}` },
      { digest: `sha256:${'9'.repeat(64)}` },
      { digest: null },
    ] as Array<Partial<PlatformArtifact>>) {
      expect(() =>
        assertPlatformArtifactMatches('persisted SPONSORED platform', gate, { ...evidence.platform, ...override })
      ).toThrow(/persisted SPONSORED platform/);
    }
    expect(() =>
      assertProductArtifactMatches('persisted SPONSORED product', gateProduct, {
        ...evidence.product,
        imageId: `sha256:${'9'.repeat(64)}`,
      })
    ).toThrow(/persisted SPONSORED product/);
  });

  it('refuses a run without real provider-backed activity', () => {
    expect(() => validateLiveSponsoredResult({ ...validSponsoredResult(), calls: 0 })).toThrow(
      /calls 0 is not an integer >= 1/
    );
    expect(() => validateLiveSponsoredResult({ ...validSponsoredResult(), committed: 0 })).toThrow(
      /committed 0 is not an integer >= 1/
    );
    expect(() => validateLiveSponsoredResult({ ...validSponsoredResult(), calls: '4' })).toThrow(/calls/);
  });

  it('refuses failed, ineligible or dirty sponsored artifacts', () => {
    expect(() => validateLiveSponsoredResult({ ...validSponsoredResult(), status: 'FAILED' })).toThrow(
      /status "FAILED" != COMPLETE/
    );
    expect(() => validateLiveSponsoredResult({ ...validSponsoredResult(), mode: 'CHALLENGE' })).toThrow(
      /mode "CHALLENGE" != SPONSORED/
    );
    expect(() => validateLiveSponsoredResult({ ...validSponsoredResult(), scan: 'failed' })).toThrow(
      /secretScan "failed" != pass/
    );
    expect(() =>
      validateLiveSponsoredResult({ ...validSponsoredResult(), cleanupFailure: 'scan failed' })
    ).toThrow(/cleanupFailure/);
    expect(() =>
      validateLiveSponsoredResult({ ...validSponsoredResult(), teardownErrors: ['topology stop'] })
    ).toThrow(/teardown errors/);
    expect(() =>
      validateLiveSponsoredResult({ ...validSponsoredResult(), platform429After: 3 })
    ).toThrow(/platform 429s/);
    expect(() => validateLiveSponsoredResult({ ...validSponsoredResult(), browserCode: 1 })).toThrow(
      /browser code 1 != 0/
    );
    expect(() =>
      validateLiveSponsoredResult({ ...validSponsoredResult(), paidCallsConsumed: false })
    ).toThrow(/consumed paid calls/);
    expect(() =>
      validateLiveSponsoredResult({ ...validSponsoredResult(), infraRetryEligible: true })
    ).toThrow(/infrastructure-retry eligible/);
    expect(() => validateLiveSponsoredResult({ ...validSponsoredResult(), roomId: '' })).toThrow(/roomId/);
    expect(() =>
      validateLiveSponsoredResult({ ...validSponsoredResult(), gateSummaryPath: 'relative.json' })
    ).toThrow(/must be absolute/);
    expect(() => validateLiveSponsoredResult(null)).toThrow(/not an object/);
  });
});

describe('read-only challenge financial adapter', () => {
  it('maps the fixture metadata and canonical string balances without side effects', async () => {
    const { input, fixture, restartApi } = adapterInput();
    const topology = buildChallengeFinancialTopology(input);
    expect(fixture.fundAndClaim).not.toHaveBeenCalled();
    expect(fixture.bootstrapSponsorBudget).not.toHaveBeenCalled();
    expect(topology.assetId).toBe('eip155:31337/erc20:0xtoken');
    expect(topology.tokenAddress).toBe('0xtoken');
    expect(topology.tokenDecimals).toBe(6);
    expect(topology.treasuryAddress).toBe('0xtreasury');
    expect(topology.sponsorPrincipalId).toBe('sponsor-1');
    expect(topology.sponsorAddress).toBe('0xsponsor');
    expect(topology.custodyLogPath).toBe('/tmp/custody-container.log');
    expect(topology.restartApi).toBe(restartApi);

    expect(await topology.bootstrapSponsorBudget(2n)).toEqual({ available: 7n, operator: 3n });
    expect(fixture.bootstrapSponsorBudget).toHaveBeenCalledWith('2');
    expect(await topology.readPrincipalAccounts('payer-1')).toEqual({ available: 11n, operator: 5n });
    expect(fixture.readPrincipalAccounts).toHaveBeenCalledWith('payer-1');
    const claim = await topology.fundAndClaim(
      { userId: 'payer-1', wallet: { address: '0xpayer' } } as never,
      1,
      2n
    );
    expect(claim).toEqual({ txHash: '0xabc', logIndex: 2 });
    expect(fixture.fundAndClaim).toHaveBeenCalledWith(
      { userId: 'payer-1', wallet: { address: '0xpayer' } },
      1,
      '2'
    );
    await topology.startCustody();
    await topology.waitForReady(1_000);
    await topology.restartApi?.();
    expect(fixture.startCustody).toHaveBeenCalledTimes(1);
    expect(fixture.waitForReady).toHaveBeenCalledWith(1_000);
    expect(restartApi).toHaveBeenCalledTimes(1);
    await topology.stop();
  });

  it('fails closed when the fixture omits required public operator metadata', () => {
    const base = adapterInput().input;
    for (const field of ['assetId', 'tokenAddress', 'treasuryAddress'] as const) {
      expect(() =>
        buildChallengeFinancialTopology({ ...base, finance: financeWith(base, { [field]: undefined }) })
      ).toThrow(new RegExp(`finance\\.${field} is required`));
    }
    for (const field of ['startCustody', 'waitForReady', 'readPrincipalAccounts', 'fundAndClaim'] as const) {
      expect(() =>
        buildChallengeFinancialTopology({ ...base, finance: financeWith(base, { [field]: undefined }) })
      ).toThrow(new RegExp(`finance\\.${field} is required`));
    }
    expect(() =>
      buildChallengeFinancialTopology({ ...base, finance: financeWith(base, { tokenDecimals: undefined }) })
    ).toThrow(/tokenDecimals/);
    expect(() =>
      buildChallengeFinancialTopology({
        ...base,
        finance: financeWith(base, { sponsorPrincipalId: 'someone-else' }),
      })
    ).toThrow(/sponsor principal does not match/);
    expect(() =>
      buildChallengeFinancialTopology({ ...base, restartApi: undefined as never })
    ).toThrow(/supervised API maintenance restart hook/);
  });

  it('rejects non-canonical fixture balances instead of coercing them', async () => {
    const { input } = adapterInput({
      bootstrapSponsorBudget: vi.fn(async () => ({ available: 'not-a-number', operator: '0' })),
    });
    const topology = buildChallengeFinancialTopology(input);
    await expect(topology.bootstrapSponsorBudget(2n)).rejects.toThrow(/not a canonical atomic integer/);
  });
});

describe('frozen live caps, fixed challenge terms and deferred custody ordering', () => {
  it('keeps the reviewed caps/pricing/terms constants unchanged', () => {
    expect(LIVE_CAPS).toEqual({
      maxCalls: 24,
      maxCostUsdMicro: 50_000n,
      perCallTimeoutMs: 5_000,
      overallRuntimeMs: 120_000,
      maxHands: 8,
    });
    expect(LIVE_PRICING).toEqual({ input: 200_000, output: 1_000_000 });
    expect(LIVE_PER_CALL_COST_USD_MICRO).toBe(Math.floor(50_000 / 24));
    expect(LIVE_CHALLENGE_ENTRY_ATOMIC).toBe('1');
    expect(LIVE_CHALLENGE_PRIZE_ATOMIC).toBe('2');
  });

  it('documents planned-not-started custody with actual-readiness admission gating', () => {
    expect(DEFERRED_CUSTODY_BOOTSTRAP).toMatch(/planned .*not started/i);
    expect(DEFERRED_CUSTODY_BOOTSTRAP).toMatch(/maintenance window/i);
    expect(DEFERRED_CUSTODY_BOOTSTRAP).toMatch(/startCustody contract creates the custody worker exactly once/);
    expect(DEFERRED_CUSTODY_BOOTSTRAP).toMatch(/actual custody heartbeat, actual central READY and the product \/ready 200/);
    expect(DEFERRED_CUSTODY_BOOTSTRAP).toMatch(/never stopped or restarted mid-competition/);
    expect(DEFERRED_CUSTODY_BOOTSTRAP).not.toMatch(/fabricat/i);
  });
});

describe('deferred custody activation ordering', () => {
  function harness(overrides: Partial<Parameters<typeof activateDeferredCustody>[0]> = {}) {
    const calls: string[] = [];
    const input = {
      unit: 'custody-planned',
      startCustody: vi.fn(async () => {
        calls.push('startCustody');
      }),
      endMaintenance: vi.fn(async (unit: string) => {
        calls.push(`endMaintenance:${unit}`);
      }),
      waitForCentralReady: vi.fn(async () => {
        calls.push('waitForCentralReady');
      }),
      assertFinancialEvidence: vi.fn(async () => {
        calls.push('assertFinancialEvidence');
      }),
      waitForProductReady: vi.fn(async () => {
        calls.push('waitForProductReady');
      }),
      ...overrides,
    };
    return { input, calls };
  }

  it('starts the worker, releases maintenance, then requires actual evidence and product readiness', async () => {
    const { input, calls } = harness();
    await activateDeferredCustody(input);
    expect(calls).toEqual([
      'startCustody',
      'endMaintenance:custody-planned',
      'waitForCentralReady',
      'assertFinancialEvidence',
      'waitForProductReady',
    ]);
  });

  it('blocks before maintenance release when startCustody itself fails', async () => {
    const { input } = harness({
      startCustody: vi.fn(async () => {
        throw new Error('custody container did not start');
      }),
    });
    await expect(activateDeferredCustody(input)).rejects.toThrow(/did not start/);
    expect(input.endMaintenance).not.toHaveBeenCalled();
    expect(input.waitForCentralReady).not.toHaveBeenCalled();
  });

  it('blocks admission when central READY, evidence or product readiness is missing', async () => {
    const central = harness({
      waitForCentralReady: vi.fn(async () => {
        throw new Error('platform /ready HTTP 503');
      }),
    });
    await expect(activateDeferredCustody(central.input)).rejects.toThrow(/ready HTTP 503/);
    expect(central.input.assertFinancialEvidence).not.toHaveBeenCalled();
    expect(central.input.waitForProductReady).not.toHaveBeenCalled();

    const evidence = harness({
      assertFinancialEvidence: vi.fn(async () => {
        throw new Error('custody heartbeat missing');
      }),
    });
    await expect(activateDeferredCustody(evidence.input)).rejects.toThrow(/heartbeat missing/);
    expect(evidence.input.waitForProductReady).not.toHaveBeenCalled();

    const product = harness({
      waitForProductReady: vi.fn(async () => {
        throw new Error('product /ready HTTP 503');
      }),
    });
    await expect(activateDeferredCustody(product.input)).rejects.toThrow(/product \/ready HTTP 503/);
  });
});

describe('live challenge wrapper static guard shape', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../integration/container-live-challenge.ts', import.meta.url)),
    'utf8'
  );

  it('keeps opt-in, exclusive marker, challenge env, supervised restart and entrypoint gate', () => {
    expect(source).toContain("process.env.NLHE_LIVE_ENABLED !== '1'");
    expect(source).toContain('NLHE_LIVE_CHALLENGE_MARKER');
    expect(source).toContain("openSync(path, 'wx', 0o600)");
    expect(source).toContain("CHALLENGE_ENABLED: '1'");
    expect(source).toContain('CHALLENGE_ENTRY_ATOMIC: LIVE_CHALLENGE_ENTRY_ATOMIC');
    expect(source).toContain('beginMaintenance(apiUnitName)');
    expect(source).toContain('endMaintenance(apiUnitName)');
    expect(source).toContain('deferCustodyStartup: true');
    expect(source).toContain('waitForInitialReady: false');
    expect(source).toContain('activateDeferredCustody');
    expect(source).toContain('endMaintenance: (unit) => started.supervisor.endMaintenance(unit)');
    expect(source).toContain('runChallengeScenario');
    expect(source).toContain('validateDeterministicGateSummary');
    expect(source).toContain('validateLiveSponsoredResult');
    expect(source).toContain('assertExpectedPlatformArtifact');
    expect(source).toContain('assertPlatformArtifactMatches');
    expect(source).toContain('assertRuntimeProductMatches');
    expect(source).toContain('capturePlatformRuntimeProvenance');
    expect(source).toContain('selectPlatformContainers');
    expect(source).toContain('invokedAsEntrypoint');
    expect(source).toContain('live-challenge-result.json');
    expect(source).toContain('DEFERRED_CUSTODY_BOOTSTRAP');
  });

  it('never restarts Anvil/quorum/workers/custody from the wrapper', () => {
    expect(source).not.toMatch(/restart\(['"](anvil|quorum|workers|custody)/i);
    expect(source).toMatch(/Anvil, quorum,[\s\S]*workers and custody are never restarted/);
  });
});
