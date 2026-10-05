/**
 * Child-process environment boundary.
 *
 * The harness must never leak credentials across process boundaries:
 * - PokerTools children (build, prisma generate, migrate, seed, API, workers,
 *   and any future Anvil/custody process) receive the sanitized system
 *   allowlist plus explicitly declared platform variables ONLY. Provider
 *   credentials (OPENAI*, provider base URLs/models) must never appear.
 * - The NLHE product child receives the system allowlist plus explicitly
 *   declared product variables (its own provider key, orchestration token,
 *   agent env refs). PokerTools JWT/cookie/signing/custody/RPC secrets must
 *   never appear.
 *
 * `buildChildEnv` is a pure function of (purpose, declared, system) and fails
 * closed on a boundary violation, so the boundary is measurable without
 * spawning anything.
 */

/** System variables safe for every child: no credentials, no app config. */
export const SYSTEM_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TEMP',
  'SYSTEMROOT',
  'TZ',
] as const;

export type ChildPurpose = 'platform' | 'nlhe';

/** Provider credential/config names that must never reach a platform child. */
const PROVIDER_ENV_SEGMENTS = new Set([
  'OPENAI',
  'ANTHROPIC',
  'OPENROUTER',
  'GEMINI',
  'MISTRAL',
  'GROQ',
  'TOGETHER',
  'LLM',
  'PROVIDER',
]);

export function isProviderEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  if (upper === 'API_KEY' || upper.endsWith('_API_KEY')) return true;
  if (upper === 'BASE_URL' || upper.endsWith('_BASE_URL')) return true;
  return upper.split('_').some((segment) => PROVIDER_ENV_SEGMENTS.has(segment));
}

/** Platform authority/secret names that must never reach the NLHE child. */
export const PLATFORM_SECRET_ENV_NAME_RE =
  /(?:JWT_SECRET|COOKIE_SECRET|PAYOUT|TREASURY|PRIVATE_KEY|PRIVATEKEY|MNEMONIC|CUSTODY|SIGNING|RPC_PROVIDER|RPC_QUORUM|RPC_URL|RPC_ENDPOINT|ASSET_INCIDENT_RESOLVE|WALLET_ENCRYPTION|COOKIE|JWT)/i;

/** Names treated as credential values when scanning a source environment. */
const SECRET_VALUE_NAME_RE = /(?:SECRET|TOKEN|KEY|PASSWORD|PRIVATE|MNEMONIC|CREDENTIAL)/i;
const NON_SECRET_VALUE_NAME_RE = /MODEL|ENDPOINT|URL/i;
const MIN_SECRET_VALUE_LENGTH = 4;

function defined(source: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (typeof value === 'string') out[name] = value;
  }
  return out;
}

/**
 * One or more credential sources. Multiple sources are collected
 * independently: a child environment that overrides an ambient variable name
 * must not hide the ambient value from redaction.
 */
export type SecretSource = NodeJS.ProcessEnv | readonly NodeJS.ProcessEnv[];

/**
 * Collect credential-shaped source values without ever exposing them.
 *
 * `extraSecrets` carries values generated inside this process (for example a
 * disposable database password) that can never be discovered from names in the
 * environment. They are filtered with the same minimum length as env values so
 * a one-character "secret" can never redact ordinary text.
 */
export function collectSecretValues(
  source: SecretSource = process.env,
  extraSecrets: readonly string[] = []
): string[] {
  const values: string[] = [];
  const sources: readonly NodeJS.ProcessEnv[] = Array.isArray(source) ? source : [source];
  for (const entry of sources) {
    for (const [name, value] of Object.entries(defined(entry))) {
      if (!SECRET_VALUE_NAME_RE.test(name) || NON_SECRET_VALUE_NAME_RE.test(name)) continue;
      if (value.length < MIN_SECRET_VALUE_LENGTH) continue;
      values.push(value);
    }
  }
  for (const value of extraSecrets) {
    if (typeof value !== 'string') continue;
    if (value.length < MIN_SECRET_VALUE_LENGTH || value.includes('\n')) continue;
    values.push(value);
  }
  return [...new Set(values)].sort((left, right) => right.length - left.length);
}

/**
 * Redact known credential values from arbitrary diagnostic text (log lines,
 * captured stdout/stderr tails). The full value is matched against the raw
 * text; nothing is truncated before redaction, so a secret can never survive
 * as a prefix or suffix of a bounded diagnostic.
 */
export function redactSecretText(
  text: string,
  extraSecrets: readonly string[] = [],
  source: SecretSource = process.env
): string {
  let out = text;
  for (const secret of collectSecretValues(source, extraSecrets)) {
    if (out.includes(secret)) out = out.split(secret).join('<redacted>');
  }
  return out;
}

/**
 * Redact credential values from a command line before it is logged. Arguments
 * themselves are retained (never process env), with any occurrence of a known
 * secret value replaced. `extraSecrets` covers values generated in-process
 * (argv-only credentials) that are absent from the environment.
 */
export function redactCommandLine(
  command: string,
  args: readonly string[],
  source: SecretSource = process.env,
  extraSecrets: readonly string[] = []
): string {
  const redact = (value: string): string => redactSecretText(value, extraSecrets, source);
  return `$ ${redact(command)} ${args.map(redact).join(' ')}`;
}

export interface ChildEnvInput {
  purpose: ChildPurpose;
  /** Explicit variables for this child. Nothing else is inherited. */
  declared: Record<string, string | undefined>;
  /** Source environment; injectable for pure boundary tests. */
  system?: NodeJS.ProcessEnv;
}

function systemEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const name of SYSTEM_ENV_ALLOWLIST) {
    if (source[name] !== undefined) out[name] = source[name];
  }
  return out;
}

function assertNoProviderLeak(env: NodeJS.ProcessEnv, source: NodeJS.ProcessEnv): void {
  for (const name of Object.keys(env)) {
    if (isProviderEnvName(name)) {
      throw new Error(`environment boundary: provider variable ${name} is not allowed in a platform child`);
    }
  }
  for (const [name, value] of Object.entries(defined(source))) {
    if (!isProviderEnvName(name) || value.length < MIN_SECRET_VALUE_LENGTH) continue;
    for (const [childName, childValue] of Object.entries(env)) {
      if (typeof childValue !== 'string') continue;
      if (childValue === value || (SECRET_VALUE_NAME_RE.test(name) && childValue.includes(value))) {
        throw new Error(
          `environment boundary: platform child variable ${childName} carries the value of provider variable ${name}`
        );
      }
    }
  }
}

function assertNoPlatformSecretLeak(env: NodeJS.ProcessEnv, source: NodeJS.ProcessEnv): void {
  for (const [name, value] of Object.entries(defined(source))) {
    if (!PLATFORM_SECRET_ENV_NAME_RE.test(name) || value.length < MIN_SECRET_VALUE_LENGTH) continue;
    for (const [childName, childValue] of Object.entries(env)) {
      if (typeof childValue !== 'string') continue;
      if (childValue === value || childValue.includes(value)) {
        throw new Error(
          `environment boundary: NLHE child variable ${childName} carries the value of platform secret ${name}`
        );
      }
    }
  }
}

/**
 * Build the exact environment for a child process. Only the system allowlist
 * is inherited; every application variable must be declared explicitly.
 */
export function buildChildEnv(input: ChildEnvInput): NodeJS.ProcessEnv {
  const source = input.system ?? process.env;
  const declared = defined(input.declared);
  const env: NodeJS.ProcessEnv = { ...systemEnv(source), ...declared };
  if (input.purpose === 'platform') {
    assertNoProviderLeak(env, source);
  } else {
    for (const name of Object.keys(declared)) {
      if (PLATFORM_SECRET_ENV_NAME_RE.test(name)) {
        throw new Error(`environment boundary: platform secret ${name} is not allowed in the NLHE child`);
      }
    }
    assertNoPlatformSecretLeak(env, source);
  }
  return env;
}

/**
 * Deterministic boundary self-test. Runs against a synthetic environment that
 * contains provider and platform secrets, plus the real process environment.
 * Throws on the first violation.
 */
export function verifyEnvironmentBoundary(): { checks: string[] } {
  const synthetic: NodeJS.ProcessEnv = {
    PATH: '/usr/bin',
    HOME: '/home/test',
    TMPDIR: '/tmp',
    OPENAI_API_KEY: 'sk-provider-secret-value',
    OPENAI_BASE_URL: 'https://provider.example.invalid/v1',
    OPENAI_MODEL: 'provider/model-name',
    JWT_SECRET: 'platform-jwt-secret-value',
    COOKIE_SECRET: 'platform-cookie-secret-value',
    PAYOUT_TREASURY_PRIVATE_KEY: '0xplatform-treasury-private-key',
    RPC_PROVIDER_A: 'https://rpc.example.invalid/secret',
  };
  const checks: string[] = [];

  const platformEnv = buildChildEnv({
    purpose: 'platform',
    declared: { NODE_ENV: 'test', DATABASE_URL: 'postgresql://local', JWT_SECRET: 'fresh-platform-jwt' },
    system: synthetic,
  });
  for (const name of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL']) {
    if (platformEnv[name] !== undefined) throw new Error(`platform env leaked ${name}`);
  }
  for (const value of [synthetic.OPENAI_API_KEY!, synthetic.OPENAI_BASE_URL!, synthetic.OPENAI_MODEL!]) {
    if (Object.values(platformEnv).includes(value)) throw new Error('platform env leaked a provider value');
  }
  if (platformEnv.PATH !== '/usr/bin' || platformEnv.HOME !== '/home/test') {
    throw new Error('platform env dropped the system allowlist');
  }
  if (platformEnv.JWT_SECRET !== 'fresh-platform-jwt') {
    throw new Error('platform env did not apply the declared platform value');
  }
  checks.push('platform-child-excludes-provider-credentials');

  let providerDeclarationRejected = false;
  try {
    buildChildEnv({ purpose: 'platform', declared: { OPENAI_API_KEY: 'x' }, system: synthetic });
  } catch {
    providerDeclarationRejected = true;
  }
  if (!providerDeclarationRejected) throw new Error('platform env accepted a declared provider credential');
  checks.push('platform-child-rejects-provider-declarations');

  const nlheEnv = buildChildEnv({
    purpose: 'nlhe',
    declared: {
      NODE_ENV: 'test',
      OPENAI_API_KEY: 'nlhe-own-provider-key',
      POKERTOOLS_ORCHESTRATION_TOKEN: 'ptsvc_minted_orchestration',
      PRODUCT_ADMIN_TOKEN: 'minted-product-admin',
      POKERTOOLS_API_URL: 'http://127.0.0.1:3000',
    },
    system: synthetic,
  });
  if (nlheEnv.OPENAI_API_KEY !== 'nlhe-own-provider-key') {
    throw new Error('NLHE env did not carry its declared provider key');
  }
  for (const name of ['JWT_SECRET', 'COOKIE_SECRET', 'PAYOUT_TREASURY_PRIVATE_KEY', 'RPC_PROVIDER_A']) {
    if (nlheEnv[name] !== undefined) throw new Error(`NLHE env inherited platform secret ${name}`);
  }
  for (const value of [
    synthetic.JWT_SECRET!,
    synthetic.COOKIE_SECRET!,
    synthetic.PAYOUT_TREASURY_PRIVATE_KEY!,
    synthetic.RPC_PROVIDER_A!,
  ]) {
    if (Object.values(nlheEnv).includes(value)) throw new Error('NLHE env leaked a platform secret value');
  }
  let platformDeclarationRejected = false;
  try {
    buildChildEnv({ purpose: 'nlhe', declared: { JWT_SECRET: 'x' }, system: synthetic });
  } catch {
    platformDeclarationRejected = true;
  }
  if (!platformDeclarationRejected) throw new Error('NLHE env accepted a declared platform secret');
  checks.push('nlhe-child-excludes-platform-secrets');

  // Real environment: same assertions against whatever the operator shell has.
  const realPlatform = buildChildEnv({
    purpose: 'platform',
    declared: { NODE_ENV: 'test', DATABASE_URL: 'postgresql://local' },
  });
  for (const name of Object.keys(realPlatform)) {
    if (isProviderEnvName(name)) throw new Error(`real platform env leaked ${name}`);
  }
  const realNlhe = buildChildEnv({
    purpose: 'nlhe',
    declared: { NODE_ENV: 'test', OPENAI_API_KEY: 'declared', POKERTOOLS_API_URL: 'http://127.0.0.1:3000' },
  });
  for (const [name, value] of Object.entries(defined(process.env))) {
    if (!PLATFORM_SECRET_ENV_NAME_RE.test(name) || value.length < MIN_SECRET_VALUE_LENGTH) continue;
    if (Object.values(realNlhe).includes(value)) {
      throw new Error(`real NLHE env leaked the value of ${name}`);
    }
  }
  checks.push('real-environment-boundary');

  return { checks };
}
