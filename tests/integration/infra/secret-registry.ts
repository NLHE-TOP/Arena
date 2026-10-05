/**
 * Generated-secret registry for the fresh disposable container gate.
 *
 * Two authorities are tracked separately:
 * - `platform`: PokerTools authority/signing values. They are redacted from all
 *   evidence, listed in the final-scanner manifest, and are FORBIDDEN in an
 *   NLHE child environment.
 * - `product`: product-authorized credentials (minted orchestration token,
 *   product admin token, the product's own provider key). They are redacted
 *   and manifested too, but they may legitimately appear in the NLHE child
 *   environment, so the boundary check must not reject them.
 *
 * Constraints this module enforces:
 * - every generated secret has a recognizable `nlheit-` shape so a final log
 *   scanner can detect leaks even without the value list;
 * - captured evidence passes through `redact()` before it is written anywhere;
 * - values are never written into `tests/artifacts/**`; the mode-0600 manifest
 *   lives in a runtime directory outside captured artifacts and is deleted at
 *   teardown unless the operator explicitly keeps it;
 * - declared child environments are checked fail-closed against every
 *   platform-authority value (never against product-authorized values).
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { collectSecretValues } from './env-boundary.js';

/** Recognizable synthetic prefix: scanners can match `nlheit-` by shape. */
const GENERATED_PREFIX = 'nlheit';

export type SecretAuthority = 'platform' | 'product';

export function generateSyntheticSecret(label: string, bytes = 32): string {
  const safeLabel = label.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  return `${GENERATED_PREFIX}-${safeLabel}-${randomBytes(bytes).toString('hex')}`;
}

export interface SecretRegistryEntry {
  label: string;
  value: string;
  authority: SecretAuthority;
}

export class SecretRegistry {
  private readonly entries: SecretRegistryEntry[] = [];

  /** Default authority is `platform` (fail closed). */
  add(label: string, value: string): void {
    this.addSecret(label, value, 'platform');
  }

  /** Platform authority: redacted/manifested AND forbidden in an NLHE child. */
  addPlatformSecret(label: string, value: string): void {
    this.addSecret(label, value, 'platform');
  }

  /** Product-authorized credential: redacted/manifested but child-allowed. */
  addProductSecret(label: string, value: string): void {
    this.addSecret(label, value, 'product');
  }

  private addSecret(label: string, value: string, authority: SecretAuthority): void {
    if (typeof value !== 'string' || value.length < 4) return;
    const existing = this.entries.find((entry) => entry.value === value);
    if (existing) {
      // A value that is ever platform authority must stay platform authority.
      if (authority === 'platform') existing.authority = 'platform';
      return;
    }
    this.entries.push({ label, value, authority });
  }

  addAll(label: string, values: Record<string, string | undefined>): void {
    for (const [name, value] of Object.entries(values)) {
      if (typeof value === 'string') this.addPlatformSecret(`${label}.${name}`, value);
    }
  }

  values(): string[] {
    return this.entries.map((entry) => entry.value);
  }

  platformValues(): string[] {
    return this.entries.filter((entry) => entry.authority === 'platform').map((entry) => entry.value);
  }

  /** Redact environment secrets plus every registered generated value. */
  redact(text: string): string {
    const values = [...new Set([...collectSecretValues(process.env), ...this.values()])]
      .filter((value) => value.length >= 4)
      .sort((left, right) => right.length - left.length);
    let out = text;
    for (const value of values) {
      if (out.includes(value)) out = out.split(value).join('<redacted>');
    }
    return out;
  }

  /**
   * Fail closed when a declared NLHE child variable carries a registered
   * PLATFORM-authority secret value. Product-authorized credentials are
   * allowed here; platform-secret names remain rejected by `buildChildEnv`.
   */
  assertNoPlatformSecrets(declared: Record<string, string | undefined>, boundary: string): void {
    for (const [name, value] of Object.entries(declared)) {
      if (typeof value !== 'string') continue;
      for (const secret of this.platformValues()) {
        if (value === secret || value.includes(secret)) {
          throw new Error(`${boundary}: ${name} carries a registered platform-authority secret value`);
        }
      }
    }
  }

  /** Backwards-compatible alias for the platform-authority boundary check. */
  assertNoSecretValues(declared: Record<string, string | undefined>, boundary: string): void {
    this.assertNoPlatformSecrets(declared, boundary);
  }

  /**
   * Persist as a mode-0600 sensitive-env-assignment manifest (`KEY=value`
   * lines, value-free comments). The external final secret scanner consumes
   * this via `--manifest <path>`; values are never printed.
   */
  persistEnvManifest(path: string): string {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const lines = [
      `# nlheit generated secrets (values never printed); generatedAt=${new Date().toISOString()}`,
      ...this.entries.map((entry) => {
        const key = entry.label.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase();
        // The scanner parser expects assignments; authority is conveyed by a
        // separate comment line so the assignment syntax stays canonical.
        return `# authority=${entry.authority}\n${key}=${entry.value}`;
      }),
    ];
    writeFileSync(path, `${lines.join('\n')}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
    return path;
  }

  static remove(path: string): void {
    rmSync(path, { force: true });
  }
}

/**
 * Focused pure regression for the authority distinction: a product-authorized
 * value must be redacted/manifested but accepted in an NLHE child, while a
 * platform-authority value must be rejected by the same boundary check.
 * Throws on the first violation.
 */
export function verifySecretRegistryBoundary(): { checks: string[] } {
  const registry = new SecretRegistry();
  const platformSecret = generateSyntheticSecret('boundary-platform');
  const productSecret = generateSyntheticSecret('boundary-product');
  registry.addPlatformSecret('BOUNDARY_PLATFORM', platformSecret);
  registry.addProductSecret('BOUNDARY_PRODUCT', productSecret);

  if (!registry.redact(`x=${platformSecret}`).includes('<redacted>')) {
    throw new Error('platform-authority secret was not redacted');
  }
  if (!registry.redact(`x=${productSecret}`).includes('<redacted>')) {
    throw new Error('product-authorized secret was not redacted');
  }
  if (!registry.values().includes(platformSecret) || !registry.values().includes(productSecret)) {
    throw new Error('registry manifest lost a value');
  }

  // Product-authorized credentials are legitimate in the NLHE child.
  registry.assertNoPlatformSecrets({ POKERTOOLS_ORCHESTRATION_TOKEN: productSecret }, 'nlhe child');
  registry.assertNoPlatformSecrets({ PRODUCT_ADMIN_TOKEN: productSecret }, 'nlhe child');

  // Platform authority in the same child must fail closed.
  let platformRejected = false;
  try {
    registry.assertNoPlatformSecrets({ LEAKED: `prefix-${platformSecret}-suffix` }, 'nlhe child');
  } catch {
    platformRejected = true;
  }
  if (!platformRejected) {
    throw new Error('platform-authority secret passed the NLHE child boundary check');
  }

  return {
    checks: [
      'platform-and-product-secrets-redacted',
      'product-authorized-child-values-allowed',
      'platform-authority-child-values-rejected',
    ],
  };
}
