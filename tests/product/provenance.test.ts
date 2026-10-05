/**
 * Focused provenance regressions for the deterministic gate summary and the
 * guarded paid wrappers.
 *
 * Pure only: no Docker, topology, provider or database is touched. The release
 * digest below is the PROVEN published 2.0.4 ghcr artifact; image IDs are
 * synthetic because the actual `.Image` is captured by inspection at runtime
 * (on Docker Desktop/containerd it can equal the digest, so it is never
 * assumed here).
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RELEASE_PLATFORM_VERSION,
  RELEASED_PLATFORM_IMAGE,
  assertExpectedPlatformArtifact,
  assertRuntimePlatformMatches,
  assertRuntimeProductMatches,
  expectedPlatformArtifact,
  gateImmutableArtifactFromSummary,
  parseContainerInspectState,
  parseImageDigest,
  parseJsonStringArray,
  parseRunningProductProvenance,
  platformArtifactFromContainers,
  selectImageDigest,
  selectPlatformContainers,
  selectStandaloneProductContainer,
  validateTerminalFoldEvidence,
  validateTerminalFoldSummary,
  type ContainerProvenance,
  type PlatformArtifact,
  type ProductArtifact,
} from '../integration/infra/provenance.js';
import { DEFAULT_PLATFORM_IMAGE } from '../integration/infra/staging.js';
import { validateDeterministicGateSummary } from '../integration/container-live-sponsored.js';

const RELEASE_DIGEST = 'sha256:115beb096708048f98eb6271c65e6bb4f833c1dc03618cdc8bf3ce2a8f8b5469';
const RELEASE_IMAGE = `ghcr.io/aaurelions/pokertools@${RELEASE_DIGEST}`;
const PLATFORM_IMAGE_ID = `sha256:${'1'.repeat(64)}`;
const PRODUCT_IMAGE = 'nlhe-product:container-gate';
const PRODUCT_IMAGE_ID = `sha256:${'2'.repeat(64)}`;

function platformArtifact(overrides: Partial<PlatformArtifact> = {}): PlatformArtifact {
  return {
    version: DEFAULT_RELEASE_PLATFORM_VERSION,
    image: RELEASE_IMAGE,
    imageId: PLATFORM_IMAGE_ID,
    digest: RELEASE_DIGEST,
    ...overrides,
  };
}

function productArtifact(overrides: Partial<ProductArtifact> = {}): ProductArtifact {
  return { image: PRODUCT_IMAGE, imageId: PRODUCT_IMAGE_ID, ...overrides };
}

function containerProvenance(
  container: string,
  overrides: Partial<ContainerProvenance> = {}
): ContainerProvenance {
  return {
    container,
    configImage: RELEASE_IMAGE,
    imageId: PLATFORM_IMAGE_ID,
    repoDigests: [`ghcr.io/aaurelions/pokertools@${RELEASE_DIGEST}`],
    packageVersion: DEFAULT_RELEASE_PLATFORM_VERSION,
    startedAt: '2026-10-05T07:39:27.944852837Z',
    ...overrides,
  };
}

function gateSummary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mode: 'full',
    exitCode: 0,
    runId: 'gate-run',
    checks: [{ name: 'fresh topology readiness', status: 'PASS' }],
    secretScan: 'pass',
    gate: { roomId: 'gate-room', tableId: 'gate-table' },
    platformVersion: DEFAULT_RELEASE_PLATFORM_VERSION,
    platformImage: RELEASE_IMAGE,
    platformImageId: PLATFORM_IMAGE_ID,
    platformDigest: RELEASE_DIGEST,
    productImage: PRODUCT_IMAGE,
    productImageId: PRODUCT_IMAGE_ID,
    terminalFold: terminalFoldProof(),
    ...overrides,
  };
}

function terminalFoldEvidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'PASS',
    requestId: 'fold-request-1',
    tableId: 'fold-table-1',
    handId: 'fold-hand-1',
    family: 'FOLD',
    handCompleted: true,
    archiveCompleted: true,
    directorProgressed: true,
    continuation: 'NEXT_HAND',
    roomTerminal: true,
    platform429: 0,
    secretScan: 'pass',
    ...overrides,
  };
}

function foldProvenance(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    platform: {
      version: DEFAULT_RELEASE_PLATFORM_VERSION,
      image: RELEASE_IMAGE,
      imageId: PLATFORM_IMAGE_ID,
      digest: RELEASE_DIGEST,
      ...(overrides['platform'] as Record<string, unknown> | undefined),
    },
    product: {
      image: PRODUCT_IMAGE,
      imageId: PRODUCT_IMAGE_ID,
      ...(overrides['product'] as Record<string, unknown> | undefined),
    },
  };
}

function terminalFoldProof(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { provenance, ...evidence } = overrides;
  return {
    ...terminalFoldEvidence(evidence),
    provenance: foldProvenance((provenance as Record<string, unknown> | undefined) ?? {}),
  };
}

describe('immutable released platform version and artifact', () => {
  it('pins the proven 2.0.4 release as the acceptance default', () => {
    expect(DEFAULT_RELEASE_PLATFORM_VERSION).toBe('2.0.4');
    expect(RELEASED_PLATFORM_IMAGE).toBe(
      'ghcr.io/aaurelions/pokertools@sha256:115beb096708048f98eb6271c65e6bb4f833c1dc03618cdc8bf3ce2a8f8b5469'
    );
    expect(parseImageDigest(RELEASED_PLATFORM_IMAGE)).toBe(RELEASE_DIGEST);
  });

  it('derives the staging default from the central released artifact', () => {
    expect(DEFAULT_PLATFORM_IMAGE).toBe(process.env.NLHE_IT_PLATFORM_IMAGE ?? RELEASED_PLATFORM_IMAGE);
  });
});

describe('preflight expected immutable platform artifact', () => {
  it('resolves the central released image when no override is given', () => {
    expect(expectedPlatformArtifact()).toEqual({
      version: '2.0.4',
      image: RELEASED_PLATFORM_IMAGE,
      digest: RELEASE_DIGEST,
    });
    expect(expectedPlatformArtifact(RELEASE_IMAGE)).toEqual(expectedPlatformArtifact());
  });

  it('rejects every other reference, mutable or stale immutable, before topology', () => {
    for (const ref of [
      PRODUCT_IMAGE,
      'ghcr.io/aaurelions/pokertools:2.0.4',
      'ghcr.io/aaurelions/pokertools@sha256:abc',
      'ghcr.io/aaurelions/pokertools@latest',
      'ghcr.io/aaurelions/pokertools@sha256:' + 'b'.repeat(64),
      'ghcr.io/other/pokertools@' + RELEASE_DIGEST,
      '',
    ]) {
      expect(() => expectedPlatformArtifact(ref)).toThrow(/not the released immutable artifact/);
    }
  });

  it('accepts only the same pinned gate artifact', () => {
    const expected = expectedPlatformArtifact(RELEASE_IMAGE);
    expect(() => assertExpectedPlatformArtifact(platformArtifact(), expected)).not.toThrow();

    expect(() =>
      assertExpectedPlatformArtifact(platformArtifact({ version: '2.0.2' }), expected)
    ).toThrow(/version gate=2.0.2 expected=2.0.4/);
    expect(() =>
      assertExpectedPlatformArtifact(
        platformArtifact({ image: 'ghcr.io/aaurelions/pokertools@sha256:' + 'b'.repeat(64) }),
        expected
      )
    ).toThrow(/image gate=/);
    expect(() => assertExpectedPlatformArtifact(platformArtifact({ digest: null }), expected)).toThrow(
      /digest gate=null expected=/
    );
    expect(() =>
      assertExpectedPlatformArtifact(
        platformArtifact({ digest: 'sha256:' + 'c'.repeat(64) }),
        expected
      )
    ).toThrow(/digest gate="sha256:c{64}" expected=sha256:115beb/);
  });
});

describe('actual runtime platform/product guard', () => {
  it('accepts the same actual artifact (version/image/id/digest)', () => {
    expect(() => assertRuntimePlatformMatches(platformArtifact(), platformArtifact())).not.toThrow();
    expect(() => assertRuntimeProductMatches(productArtifact(), productArtifact())).not.toThrow();
  });

  it('blocks a version mismatch', () => {
    expect(() =>
      assertRuntimePlatformMatches(platformArtifact(), platformArtifact({ version: '2.0.2' }))
    ).toThrow(/actual platform root version 2.0.2 != gate platformVersion 2.0.4/);
  });

  it('blocks an image mismatch', () => {
    expect(() =>
      assertRuntimePlatformMatches(
        platformArtifact(),
        platformArtifact({ image: 'ghcr.io/aaurelions/pokertools:2.0.4' })
      )
    ).toThrow(/actual platform Config.Image .* != gate platformImage/);
  });

  it('blocks an image ID mismatch (never assumed from the digest)', () => {
    expect(() =>
      assertRuntimePlatformMatches(
        platformArtifact(),
        platformArtifact({ imageId: 'sha256:' + '9'.repeat(64) })
      )
    ).toThrow(/actual platform image ID .* != gate platformImageId/);
  });

  it('blocks a digest mismatch or a missing digest', () => {
    expect(() =>
      assertRuntimePlatformMatches(
        platformArtifact(),
        platformArtifact({ digest: 'sha256:' + '9'.repeat(64) })
      )
    ).toThrow(/actual platform digest .* != gate platformDigest/);
    expect(() => assertRuntimePlatformMatches(platformArtifact(), platformArtifact({ digest: null }))).toThrow(
      /platform digest provenance is unavailable/
    );
    expect(() => assertRuntimePlatformMatches(platformArtifact({ digest: null }), platformArtifact())).toThrow(
      /platform digest provenance is unavailable/
    );
  });

  it('blocks a product image or image ID mismatch', () => {
    expect(() =>
      assertRuntimeProductMatches(productArtifact(), productArtifact({ image: 'nlhe-product:other' }))
    ).toThrow(/actual product image nlhe-product:other != gate productImage/);
    expect(() =>
      assertRuntimeProductMatches(productArtifact(), productArtifact({ imageId: 'sha256:' + '9'.repeat(64) }))
    ).toThrow(/actual product image ID .* != gate productImageId/);
  });
});

describe('deterministic gate summary provenance', () => {
  it('accepts a full PASS summary and returns the immutable artifact + bound FOLD proof', () => {
    const artifact = validateDeterministicGateSummary(gateSummary(), 0);
    expect(artifact.platform).toEqual({
      version: '2.0.4',
      image: RELEASE_IMAGE,
      imageId: PLATFORM_IMAGE_ID,
      digest: RELEASE_DIGEST,
    });
    expect(artifact.product).toEqual({ image: PRODUCT_IMAGE, imageId: PRODUCT_IMAGE_ID });
    expect(artifact.terminalFold.evidence).toEqual(
      validateTerminalFoldEvidence(terminalFoldEvidence(), 'expected')
    );
    expect(artifact.terminalFold.provenance).toEqual({
      platform: artifact.platform,
      product: artifact.product,
    });
  });

  it('blocks every missing provenance field', () => {
    for (const field of [
      'platformVersion',
      'platformImage',
      'platformImageId',
      'platformDigest',
      'productImage',
      'productImageId',
    ]) {
      expect(() => validateDeterministicGateSummary(gateSummary({ [field]: undefined }), 0)).toThrow(
        new RegExp(field)
      );
    }
    expect(() => validateDeterministicGateSummary(gateSummary({ platformDigest: null }), 0)).toThrow(
      /platformDigest/
    );
    expect(() => validateDeterministicGateSummary(gateSummary({ productImage: '' }), 0)).toThrow(
      /productImage/
    );
    expect(() =>
      validateDeterministicGateSummary(gateSummary({ platformImageId: 'not-a-sha' }), 0)
    ).toThrow(/platformImageId/);
  });

  it('rejects malformed provenance values through the pure extractor', () => {
    expect(() => gateImmutableArtifactFromSummary(gateSummary() as Record<string, unknown>)).not.toThrow();
    expect(() =>
      gateImmutableArtifactFromSummary(gateSummary({ platformImageId: 'sha256:short' }) as Record<string, unknown>)
    ).toThrow(/platformImageId/);
  });
});

describe('focused terminal FOLD paid eligibility', () => {
  it('blocks every full summary without the focused FOLD proof (old summaries)', () => {
    expect(() =>
      validateDeterministicGateSummary(gateSummary({ terminalFold: undefined }), 0)
    ).toThrow(/terminalFold is missing/);
    expect(() => validateDeterministicGateSummary(gateSummary({ terminalFold: null }), 0)).toThrow(
      /terminalFold is missing/
    );
    expect(() => validateDeterministicGateSummary(gateSummary({ terminalFold: 'PASS' }), 0)).toThrow(
      /terminalFold is missing/
    );
  });

  it('accepts only the exact FOLD PASS evidence contract', () => {
    expect(validateTerminalFoldEvidence(terminalFoldEvidence())).toEqual({
      status: 'PASS',
      requestId: 'fold-request-1',
      tableId: 'fold-table-1',
      handId: 'fold-hand-1',
      family: 'FOLD',
      handCompleted: true,
      archiveCompleted: true,
      directorProgressed: true,
      continuation: 'NEXT_HAND',
      roomTerminal: true,
      platform429: 0,
      secretScan: 'pass',
    });
    expect(validateTerminalFoldEvidence(terminalFoldEvidence({ continuation: 'SETTLEMENT_READY' })).continuation).toBe(
      'SETTLEMENT_READY'
    );
  });

  it('blocks incomplete or failed FOLD evidence', () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ status: 'FAIL' }, /status "FAIL" != PASS/],
      [{ family: 'SHOWDOWN' }, /family "SHOWDOWN" != FOLD/],
      [{ handCompleted: false }, /handCompleted must be true/],
      [{ archiveCompleted: false }, /archiveCompleted must be true/],
      [{ directorProgressed: false }, /directorProgressed must be true/],
      [{ roomTerminal: false }, /roomTerminal must be true/],
      [{ continuation: 'NONE' }, /continuation "NONE" is not one of NEXT_HAND\|SETTLEMENT_READY/],
      [{ continuation: undefined }, /continuation/],
      [{ platform429: 1 }, /platform429 1 != 0/],
      [{ secretScan: 'skipped' }, /secretScan "skipped" != pass/],
      [{ requestId: '' }, /requestId is missing/],
      [{ tableId: undefined }, /tableId is missing/],
      [{ handId: null }, /handId is missing/],
    ];
    for (const [override, pattern] of cases) {
      expect(() =>
        validateDeterministicGateSummary(gateSummary({ terminalFold: terminalFoldProof(override) }), 0)
      ).toThrow(pattern);
    }
  });

  it('blocks a FOLD proof produced on a different platform or product artifact', () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ platform: { version: '2.0.2' } }, /terminal FOLD platform root version 2.0.2 != gate platformVersion/],
      [
        { platform: { image: 'ghcr.io/aaurelions/pokertools:2.0.4' } },
        /terminal FOLD platform Config.Image .* != gate platformImage/,
      ],
      [
        { platform: { imageId: `sha256:${'9'.repeat(64)}` } },
        /terminal FOLD platform image ID .* != gate platformImageId/,
      ],
      [
        { platform: { digest: `sha256:${'9'.repeat(64)}` } },
        /terminal FOLD platform digest .* != gate platformDigest/,
      ],
      [{ product: { image: 'nlhe-product:other' } }, /terminal FOLD product image nlhe-product:other != gate productImage/],
      [
        { product: { imageId: `sha256:${'9'.repeat(64)}` } },
        /terminal FOLD product image ID .* != gate productImageId/,
      ],
    ];
    for (const [provenance, pattern] of cases) {
      expect(() =>
        validateDeterministicGateSummary(gateSummary({ terminalFold: terminalFoldProof({ provenance }) }), 0)
      ).toThrow(pattern);
    }
  });

  it('validates the focused runner summary schema directly against the actual artifact', () => {
    const expected = { platform: platformArtifact(), product: productArtifact() };
    const summary = { provenance: foldProvenance(), terminalFold: terminalFoldEvidence() };
    const validated = validateTerminalFoldSummary(summary, expected);
    expect(validated.evidence.family).toBe('FOLD');
    expect(validated.provenance.platform).toEqual(expected.platform);
    expect(() =>
      validateTerminalFoldSummary(
        { provenance: foldProvenance({ platform: { version: '2.0.2' } }), terminalFold: terminalFoldEvidence() },
        expected
      )
    ).toThrow(/terminal FOLD summary platform root version 2.0.2/);
    expect(() => validateTerminalFoldSummary('not-an-object', expected)).toThrow(/is not an object/);
    expect(() =>
      validateTerminalFoldSummary({ provenance: foldProvenance() }, expected)
    ).toThrow(/terminalFold is not an object/);
  });
});

describe('docker identity parsing', () => {
  it('parses the container inspect identity and requires a running sha256 image', () => {
    const parsed = parseContainerInspectState(
      `${RELEASE_IMAGE}|${PLATFORM_IMAGE_ID}|2026-10-05T07:39:27.944852837Z|true\n`,
      'nlhe-stage-api-x'
    );
    expect(parsed).toEqual({
      configImage: RELEASE_IMAGE,
      imageId: PLATFORM_IMAGE_ID,
      startedAt: '2026-10-05T07:39:27.944852837Z',
      running: true,
    });
    expect(() =>
      parseContainerInspectState(`${RELEASE_IMAGE}|not-a-sha|<time>|true`, 'api')
    ).toThrow(/image ID/);
    expect(() => parseContainerInspectState('garbage', 'api')).toThrow(/unreadable docker inspect identity/);
  });

  it('parses JSON string arrays and rejects other shapes', () => {
    expect(parseJsonStringArray('["a@sha256:x"]', 'RepoDigests')).toEqual(['a@sha256:x']);
    expect(parseJsonStringArray('[]', 'RepoDigests')).toEqual([]);
    expect(() => parseJsonStringArray('not-json', 'RepoDigests')).toThrow(/not valid JSON/);
    expect(() => parseJsonStringArray('{"a":1}', 'RepoDigests')).toThrow(/not a JSON string array/);
    expect(() => parseJsonStringArray('["ok",1]', 'RepoDigests')).toThrow(/not a JSON string array/);
  });

  it('resolves the actual digest from RepoDigests and never guesses', () => {
    expect(parseImageDigest(RELEASE_IMAGE)).toBe(RELEASE_DIGEST);
    expect(parseImageDigest('ghcr.io/x:2.0.3')).toBeNull();
    expect(
      selectImageDigest(RELEASE_IMAGE, [`ghcr.io/aaurelions/pokertools@${RELEASE_DIGEST}`])
    ).toBe(RELEASE_DIGEST);
    expect(() => selectImageDigest(RELEASE_IMAGE, ['ghcr.io/aaurelions/pokertools@sha256:' + '9'.repeat(64)])).toThrow(
      /does not expose its pinned digest/
    );
    // Docker Desktop/containerd: the actual inspected image ID can be the
    // digest itself while RepoDigests is empty; it is never assumed.
    expect(selectImageDigest(RELEASE_IMAGE, [], RELEASE_DIGEST)).toBe(RELEASE_DIGEST);
    expect(() => selectImageDigest(RELEASE_IMAGE, [], 'sha256:' + '9'.repeat(64))).toThrow(
      /does not expose its pinned digest/
    );
    expect(selectImageDigest('nlhe-product:local', [])).toBeNull();
    expect(selectImageDigest('nlhe-product:local', ['nlhe-product@sha256:' + '9'.repeat(64)])).toBe(
      'sha256:' + '9'.repeat(64)
    );
    expect(() =>
      selectImageDigest('nlhe-product:local', [
        'nlhe-product@sha256:' + '9'.repeat(64),
        'nlhe-product@sha256:' + '8'.repeat(64),
      ])
    ).toThrow(/multiple RepoDigests/);
  });

  it('selects exactly one platform container per role and fails closed on ambiguity', () => {
    expect(
      selectPlatformContainers([
        'nlhe-stage-pg-a1',
        'nlhe-stage-redis-a1',
        'nlhe-stage-api-a1',
        'nlhe-stage-workers-a1',
        'nlhe-stage-custody-a1',
        'nlhe-standalone-a1',
        'nlhe-standalone-proxy-a1',
      ])
    ).toEqual({
      api: 'nlhe-stage-api-a1',
      workers: 'nlhe-stage-workers-a1',
      custody: 'nlhe-stage-custody-a1',
    });
    expect(() => selectPlatformContainers(['nlhe-stage-api-a1', 'nlhe-stage-workers-a1'])).toThrow(
      /platform custody container/
    );
    expect(() =>
      selectPlatformContainers(['nlhe-stage-api-a1', 'nlhe-stage-api-b2', 'nlhe-stage-workers-a1', 'nlhe-stage-custody-a1'])
    ).toThrow(/exactly one supervised platform API container/);
  });

  it('reconciles API/workers/custody provenance and fails closed on disagreement', () => {
    const api = containerProvenance('nlhe-stage-api-a1');
    const workers = containerProvenance('nlhe-stage-workers-a1');
    const custody = containerProvenance('nlhe-stage-custody-a1');
    expect(platformArtifactFromContainers([api, workers, custody])).toEqual(platformArtifact());
    // Containerd image store: RepoDigests empty, actual image ID equals the
    // pinned manifest digest.
    expect(
      platformArtifactFromContainers([
        containerProvenance('nlhe-stage-api-a1', { imageId: RELEASE_DIGEST, repoDigests: [] }),
        containerProvenance('nlhe-stage-workers-a1', { imageId: RELEASE_DIGEST, repoDigests: [] }),
        containerProvenance('nlhe-stage-custody-a1', { imageId: RELEASE_DIGEST, repoDigests: [] }),
      ])
    ).toEqual(platformArtifact({ imageId: RELEASE_DIGEST }));
    expect(() => platformArtifactFromContainers([])).toThrow(/no platform container provenance/);
    expect(() =>
      platformArtifactFromContainers([api, workers, containerProvenance('custody', { packageVersion: '2.0.2' })])
    ).toThrow(/disagree on root package version/);
    expect(() =>
      platformArtifactFromContainers([api, workers, containerProvenance('custody', { imageId: 'sha256:' + '9'.repeat(64) })])
    ).toThrow(/disagree on image ID/);
  });

  it('selects the standalone product container and never the proxy sidecar', () => {
    expect(
      selectStandaloneProductContainer([
        'nlhe-stage-api-a1',
        'nlhe-stage-workers-a1',
        'nlhe-stage-custody-a1',
        'nlhe-standalone-a1',
        'nlhe-standalone-proxy-a1',
      ])
    ).toBe('nlhe-standalone-a1');
    expect(() =>
      selectStandaloneProductContainer(['nlhe-stage-api-a1', 'nlhe-standalone-proxy-a1'])
    ).toThrow(/standalone product container/);
    expect(() =>
      selectStandaloneProductContainer(['nlhe-standalone-a1', 'nlhe-standalone-b2', 'nlhe-standalone-proxy-a1'])
    ).toThrow(/exactly one supervised standalone product container/);
  });

  it('parses the ACTUAL running product identity (Config.Image + .Image)', () => {
    expect(
      parseRunningProductProvenance(
        `${PRODUCT_IMAGE}|${PRODUCT_IMAGE_ID}|2026-10-05T07:39:37.425066383Z|true\n`,
        'nlhe-standalone-a1'
      )
    ).toEqual(productArtifact());
    expect(() =>
      parseRunningProductProvenance(`${PRODUCT_IMAGE}|${PRODUCT_IMAGE_ID}|2026-10-05T07:39:37Z|false`, 'nlhe-standalone-a1')
    ).toThrow(/is not running/);
    expect(() => parseRunningProductProvenance('garbage', 'nlhe-standalone-a1')).toThrow(
      /unreadable docker inspect identity/
    );
  });

  it('blocks a runtime product whose launched image or actual .Image differs from the gate', () => {
    const running = (image: string, imageId: string) =>
      parseRunningProductProvenance(`${image}|${imageId}|2026-10-05T07:39:37Z|true`, 'nlhe-standalone-a1');
    // Same artifact accepted.
    expect(() => assertRuntimeProductMatches(productArtifact(), running(PRODUCT_IMAGE, PRODUCT_IMAGE_ID))).not.toThrow();
    // Tag replaced after the gate: same Config.Image ref, different actual image.
    expect(() =>
      assertRuntimeProductMatches(productArtifact(), running(PRODUCT_IMAGE, 'sha256:' + '9'.repeat(64)))
    ).toThrow(/actual product image ID .* != gate productImageId/);
    // Different launched reference (for example an override tag).
    expect(() =>
      assertRuntimeProductMatches(productArtifact(), running('nlhe-product:other', PRODUCT_IMAGE_ID))
    ).toThrow(/actual product image nlhe-product:other != gate productImage/);
  });
});
