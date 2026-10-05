/**
 * Focused static/pure regressions for the deterministic financial CHALLENGE
 * entrypoint (`tests/integration/container-challenge.ts`).
 *
 * No topology, container, provider or database is touched: only argument
 * parsing, the loopback-only provider assertion, the deterministic acceptance
 * caps and source-shape guards that keep the paid/live/marker paths out.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DETERMINISTIC_CHALLENGE_ASSERTION_CAPS,
  DETERMINISTIC_CHALLENGE_CAPS,
  DETERMINISTIC_CHALLENGE_RESULT_ARTIFACT,
  assertLoopbackProviderUrl,
  parseDeterministicChallengeArgs,
} from '../integration/container-challenge.js';
import {
  LIVE_CAPS,
  LIVE_CHALLENGE_ENTRY_ATOMIC,
  LIVE_CHALLENGE_PRIZE_ATOMIC,
  assertLiveOutcomeCaps,
  type ChallengeAssertionCaps,
} from '../integration/live.js';

const source = readFileSync(
  fileURLToPath(new URL('../integration/container-challenge.ts', import.meta.url)),
  'utf8'
);

describe('deterministic challenge arguments, caps and fixed terms', () => {
  it('accepts only the side-effect-free --check argument', () => {
    expect(parseDeterministicChallengeArgs([])).toEqual({ check: false });
    expect(parseDeterministicChallengeArgs(['--check'])).toEqual({ check: true });
    expect(() => parseDeterministicChallengeArgs(['--live'])).toThrow(
      /unknown deterministic-challenge argument/
    );
    expect(() => parseDeterministicChallengeArgs(['--check', '--force'])).toThrow(
      /unknown deterministic-challenge argument/
    );
  });

  it('freezes the existing deterministic acceptance caps and valueless terms', () => {
    expect(DETERMINISTIC_CHALLENGE_CAPS).toEqual({
      maxProviderCalls: 5_000,
      maxCostUsdMicro: 0,
      perCallTimeoutMs: 5_000,
      overallRuntimeMs: 600_000,
      maxHands: 100,
      maxProviderConcurrency: 8,
    });
    expect(LIVE_CHALLENGE_ENTRY_ATOMIC).toBe('1');
    expect(LIVE_CHALLENGE_PRIZE_ATOMIC).toBe('2');
    expect(DETERMINISTIC_CHALLENGE_RESULT_ARTIFACT).toBe('deterministic-challenge-result.json');
  });
});

describe('loopback-only provider assertion', () => {
  it('accepts loopback fake-provider URLs', () => {
    expect(assertLoopbackProviderUrl('http://127.0.0.1:1234/v1')).toBe('http://127.0.0.1:1234/v1');
    expect(assertLoopbackProviderUrl('http://localhost:1234/v1')).toBe('http://localhost:1234/v1');
  });

  it('refuses every non-loopback provider path before any container starts', () => {
    expect(() => assertLoopbackProviderUrl('https://openrouter.ai/api/v1')).toThrow(/must be loopback/);
    expect(() => assertLoopbackProviderUrl('http://host.docker.internal:1234/v1')).toThrow(/must be loopback/);
    expect(() => assertLoopbackProviderUrl('https://api.provider.test/v1', 'fake provider URL')).toThrow(
      /fake provider URL must be loopback/
    );
    expect(() => assertLoopbackProviderUrl('not a url')).toThrow(/not a valid URL/);
  });
});

describe('deterministic challenge static shape', () => {
  it('reuses the reviewed deferred-custody / standalone / scenario wiring', () => {
    expect(source).toContain('startStagingTopology');
    expect(source).toContain('deferCustodyStartup: true');
    expect(source).toContain('activateDeferredCustody');
    expect(source).toContain('buildChallengeFinancialTopology');
    expect(source).toContain('startStandaloneContainer');
    expect(source).toContain('waitForInitialReady: false');
    expect(source).toContain('runChallengeScenario');
    expect(source).toContain('CHALLENGE_ENABLED');
    expect(source).toContain('CHALLENGE_ENTRY_ATOMIC: LIVE_CHALLENGE_ENTRY_ATOMIC');
    expect(source).toContain('CHALLENGE_PRIZE_ATOMIC: LIVE_CHALLENGE_PRIZE_ATOMIC');
    expect(source).toContain('beginMaintenance(apiUnitName)');
    expect(source).toContain('endMaintenance(apiUnitName)');
  });

  it('is deterministic and has no paid, dotenv, live-gate or marker path', () => {
    expect(source).toContain('startFakeProvider');
    expect(source).toContain("mode: 'fold'");
    expect(source).toContain('aggressiveAfter: 12');
    expect(source).toContain('FIXTURE_API_KEY');
    expect(source).toContain('FIXTURE_MODEL');
    expect(source).toContain('assertLoopbackProviderUrl');
    expect(source).not.toMatch(/loadEnvFile|process\.env\.OPENAI|OPENAI_BASE_URL|OPENAI_MODEL/);
    expect(source).not.toMatch(
      /NLHE_LIVE_|createExclusiveMarker|NLHE_LIVE_CHALLENGE_MARKER|gateSummary|sponsoredResult|live-challenge-result/
    );
  });

  it('gates zero platform 429, supervised liveness and the mandatory final scan', () => {
    expect(source).toContain('readPlatform429Total');
    expect(source).toContain('assertAllAlive');
    expect(source).toContain('requireSecretScanner');
    expect(source).toContain("'--manifest'");
    expect(source).toContain('DETERMINISTIC_CHALLENGE_RESULT_ARTIFACT');
    expect(source).toContain('invokedAsEntrypoint');
    expect(source).toContain('mode: 0o600');
  });

  it('requires an existing fixture path and injects the deterministic assertion caps', () => {
    expect(source).toContain('existsSync');
    expect(source).toContain('absolute existing path to the built external staging fixture');
    expect(source).toContain('DETERMINISTIC_CHALLENGE_ASSERTION_CAPS');
    expect(source).toMatch(/DETERMINISTIC_CHALLENGE_ASSERTION_CAPS\s*\)\s*;/);
  });
});

describe('injected assertion caps (live defaults unchanged)', () => {
  it('keeps the frozen LIVE_CAPS and the shared helper default exactly at the reviewed live bounds', () => {
    expect(LIVE_CAPS).toEqual({
      maxCalls: 24,
      maxCostUsdMicro: 50_000n,
      perCallTimeoutMs: 5_000,
      overallRuntimeMs: 120_000,
      maxHands: 8,
    });
    expect(() => assertLiveOutcomeCaps(24, 50_000)).not.toThrow();
    expect(() => assertLiveOutcomeCaps(25, 50_000)).toThrow(/live call cap exceeded/);
    expect(() => assertLiveOutcomeCaps(24, 50_001)).toThrow(/live cost cap exceeded/);
  });

  it('enforces the deterministic 5000-call / 0-cost bounds when injected', () => {
    expect(DETERMINISTIC_CHALLENGE_ASSERTION_CAPS).toEqual({
      maxCalls: 5_000,
      maxCostUsdMicro: 0n,
      overallRuntimeMs: 600_000,
    });
    const caps: ChallengeAssertionCaps = DETERMINISTIC_CHALLENGE_ASSERTION_CAPS;
    expect(() => assertLiveOutcomeCaps(5_000, 0, caps)).not.toThrow();
    expect(() => assertLiveOutcomeCaps(5_001, 0, caps)).toThrow(/live call cap exceeded/);
    expect(() => assertLiveOutcomeCaps(5_000, 1, caps)).toThrow(/live cost cap exceeded/);
    // The injected bounds derive from the deterministic product caps.
    expect(caps.maxCalls).toBe(DETERMINISTIC_CHALLENGE_CAPS.maxProviderCalls);
    expect(caps.maxCostUsdMicro).toBe(BigInt(DETERMINISTIC_CHALLENGE_CAPS.maxCostUsdMicro));
    expect(caps.overallRuntimeMs).toBe(DETERMINISTIC_CHALLENGE_CAPS.overallRuntimeMs);
  });

  it('binds the injection into the terminal wait and outcome assertion, leaving paid call sites on the default', () => {
    const liveSource = readFileSync(
      fileURLToPath(new URL('../integration/live.ts', import.meta.url)),
      'utf8'
    );
    expect(liveSource).toContain('caps: ChallengeAssertionCaps = LIVE_CAPS');
    expect(liveSource).toContain('assertLiveOutcomeCaps(calls, cost, input.caps)');
    expect(liveSource).toContain('caps.overallRuntimeMs');
    const outcomeCalls = liveSource.match(/assertLiveRoomOutcome\(\{[\s\S]*?\n  \}\);/g) ?? [];
    expect(outcomeCalls).toHaveLength(2);
    expect(outcomeCalls.filter((call) => call.includes('caps,')).length).toBe(1);
  });
});
