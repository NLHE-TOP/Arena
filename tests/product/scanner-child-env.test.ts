/**
 * Focused regression for the external secret-scanner child environment.
 *
 * `runCommandOrThrow` without an explicit env inherits only the platform
 * system allowlist, so an ambient `NLHE_REPO` (the checkout root holding the
 * local `.env` whose values are the scanner's detection needles) would be
 * dropped and the scanner would fall back to a stale default path. Every
 * scanner invocation must therefore declare the root explicitly, while still
 * inheriting no provider or platform credential.
 *
 * Assertions use synthetic placeholder values only: no `.env` value is read,
 * printed or loaded, and no provider is contacted.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ROOT } from '../integration/infra/context.js';
import { buildChildEnv } from '../integration/infra/env-boundary.js';

const SCANNER_ENTRYPOINTS = [
  'container-gate.ts',
  'container-live-sponsored.ts',
  'container-live-challenge.ts',
  'container-challenge.ts',
] as const;

describe('external secret-scanner child environment', () => {
  it('declares the checkout root and inherits no provider/platform credentials', () => {
    const synthetic: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      OPENAI_API_KEY: 'sk-provider-placeholder-value',
      OPENAI_BASE_URL: 'https://provider.example.invalid/v1',
      OPENAI_MODEL: 'provider/model-name',
      JWT_SECRET: 'platform-jwt-placeholder-value',
    };
    const env = buildChildEnv({
      purpose: 'platform',
      declared: { NLHE_REPO: synthetic.NLHE_REPO ?? ROOT },
      system: synthetic,
    });
    expect(env.NLHE_REPO).toBe(ROOT);
    expect(env.PATH).toBe('/usr/bin');
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.OPENAI_BASE_URL).toBeUndefined();
    expect(env.OPENAI_MODEL).toBeUndefined();
    expect(env.JWT_SECRET).toBeUndefined();
    expect(Object.values(env)).not.toContain('sk-provider-placeholder-value');
    expect(Object.values(env)).not.toContain('platform-jwt-placeholder-value');

    // An explicitly configured root wins; the ambient name is never inherited.
    const override = buildChildEnv({
      purpose: 'platform',
      declared: { NLHE_REPO: '/configured/root' },
      system: { ...synthetic, NLHE_REPO: '/ambient/root' },
    });
    expect(override.NLHE_REPO).toBe('/configured/root');
  });

  it('passes the declared-root env in every scanner invocation', () => {
    for (const entry of SCANNER_ENTRYPOINTS) {
      const source = readFileSync(
        fileURLToPath(new URL(`../integration/${entry}`, import.meta.url)),
        'utf8'
      );
      expect(source, entry).toMatch(
        /const env = buildChildEnv\(\{\s*purpose: 'platform',\s*declared: \{ NLHE_REPO: process\.env\.NLHE_REPO \?\? ROOT \},\s*\}\);/
      );
      const scan = source.slice(source.indexOf('async function runFinalSecretScan'));
      expect(scan, entry).toMatch(/runCommandOrThrow\([\s\S]*?\{ timeoutMs: 120_000, env \}/);
    }
  });
});
