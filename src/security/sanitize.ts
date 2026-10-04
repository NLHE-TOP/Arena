/**
 * Compact product boundary sanitizer.
 *
 * This is the single secret-redaction policy for the product-owned LLM path
 * (decision prompt, provider transport records, chat selection and the
 * independent request inspector). It deliberately contains no custody, SIWE,
 * chain or legacy audit coupling.
 *
 * Guarantees:
 * - Reviewed sensitive key names are dropped wholesale (authorization,
 *   cookies, api/private/service keys, tokens, secrets, passwords, signatures,
 *   provider headers, raw transactions, RPC credentials).
 * - Credential-shaped substrings are redacted in every string and object key:
 *   `Bearer ...`, `sk-...` API keys and `scheme://user:pass@host` userinfo.
 * - Exact known secret values are redacted wherever they appear, including as
 *   JSON object keys, so a malicious provider cannot echo a configured key
 *   back through a retained response or a speech field.
 * - `knownSecrets` is the explicit policy source. `includeEnvSecrets` opts in
 *   to exact values of environment names referencing SECRET / TOKEN / KEY
 *   (NLHE service credentials); it is OFF by default so prompt construction and
 *   inspection stay deterministic unless a caller explicitly supplies policy.
 * - Environment discovery excludes MODEL/ENDPOINT-style configuration names;
 *   only credential-holding names are candidates. Values are never printed.
 * - Text that is not secret-shaped or an exact known value is returned
 *   byte-for-byte unchanged.
 */

/** Replacement for an entire known secret value. */
export const REDACTED = '<redacted>';
/** Replacement for a bearer token (keeps the scheme readable). */
export const BEARER_REDACTED = 'Bearer <redacted>';
/** Replacement for an `sk-...` API key. */
export const API_KEY_REDACTED = '<redacted-key>';
/** Deepest object/array nesting walked before truncating. */
export const MAX_SANITIZE_DEPTH = 16;
/** Minimum length of an environment-discovered value worth redacting. */
const MIN_ENV_SECRET_LENGTH = 4;

/**
 * Key names whose value is dropped entirely. Anchored, case-insensitive and
 * covering plain, kebab-case, snake_case and camelCase spellings. `max_tokens`
 * and `prompt_tokens` must never match.
 */
export const SENSITIVE_KEY_RE = new RegExp(
  '^(?:' +
    [
      'authorization',
      'proxy[-_]?authorization',
      '(?:[a-z0-9]+[-_])*api[-_]?key',
      '(?:[a-z0-9]+[-_])*(?:access|refresh|id|auth|service|bearer|session)[-_]?token',
      'token',
      'cookie',
      'set[-_]?cookie',
      '(?:request|response|http)?[-_]?headers',
      'secret',
      'client[-_]?secret',
      'session[-_]?secret',
      'service[-_]?secret',
      'password',
      'passwd',
      'passphrase',
      'private[-_]?key',
      'privatekey',
      'mnemonic',
      'seed(?:[-_]?phrase)?',
      'session(?:[-_]?(?:id|secret|signature))?',
      'sid',
      'rpc(?:[-_]?(?:url|endpoint|credential))?',
      'raw[-_]?tx',
      'raw[-_]?transaction',
      '(?:siwe|session|request|wallet)?[-_]?signature',
      'siwe',
      'bearer',
    ].join('|') +
    ')$',
  'i',
);

/** Bearer authorization values inside free text. */
export const BEARER_RE = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;
/** OpenAI-style `sk-...` API keys inside free text. */
export const API_KEY_RE = /\bsk-[A-Za-z0-9._-]{6,}\b/g;
/** Public-platform machine credentials must never survive text redaction. */
export const SERVICE_TOKEN_RE = /\bptsvc_[A-Za-z0-9_-]+\b/g;
/** `scheme://userinfo@` — userinfo is credential material and is redacted. */
export const CREDENTIAL_URL_RE = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/\s?#@]+@/g;

/**
 * Environment names treated as credential holders: anything referencing a
 * secret, token or key. `MODEL`-style configuration (e.g. OPENAI_MODEL) is not
 * a credential and is excluded.
 */
export const ENV_SECRET_NAME_RE = /(?:SECRET|TOKEN|KEY)/i;
const ENV_NON_SECRET_NAME_RE = /MODEL/i;

export interface SanitizeOptions {
  /**
   * Explicit exact secret values redacted anywhere they appear. The configured
   * provider key must always be passed here, never relied on via env naming.
   * Non-empty explicit values are honored even when shorter than the env
   * minimum, because the caller declared them secret.
   */
  knownSecrets?: readonly string[];
  /**
   * When true, also redact exact values from credential-named environment
   * variables. Defaults to false: no implicit environment discovery, so prompt
   * construction and inspection are deterministic unless explicitly opted in.
   */
  includeEnvSecrets?: boolean;
}

/**
 * Discover exact secret values from credential-named environment variables
 * WITHOUT ever exposing them. Only names referencing SECRET / TOKEN / KEY are
 * eligible; MODEL-style configuration names are never treated as credentials.
 */
export function collectEnvKnownSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  const secrets: string[] = [];
  for (const [name, raw] of Object.entries(env)) {
    if (typeof raw !== 'string') continue;
    if (!ENV_SECRET_NAME_RE.test(name) || ENV_NON_SECRET_NAME_RE.test(name)) continue;
    const value = raw.trim();
    if (value.length < MIN_ENV_SECRET_LENGTH) continue;
    secrets.push(value);
  }
  return dedupeLongestFirst(secrets);
}

/** Resolve the effective known-secret list for one boundary policy. */
export function resolveKnownSecrets(options: SanitizeOptions = {}): string[] {
  const collected: string[] = [];
  if (options.includeEnvSecrets) collected.push(...collectEnvKnownSecrets());
  if (options.knownSecrets) {
    for (const secret of options.knownSecrets) {
      if (typeof secret === 'string' && secret.length > 0) collected.push(secret);
    }
  }
  return dedupeLongestFirst(collected);
}

function dedupeLongestFirst(values: readonly string[]): string[] {
  // Longest first so a shorter secret that is a substring of a longer one
  // never leaves a partial value behind.
  return [...new Set(values)].sort((a, b) => b.length - a.length);
}

function redactString(value: string, secrets: readonly string[]): string {
  let out = value;
  for (const secret of secrets) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  out = out.replace(CREDENTIAL_URL_RE, `$1${REDACTED}@`);
  out = out.replace(BEARER_RE, BEARER_REDACTED);
  out = out.replace(API_KEY_RE, API_KEY_REDACTED);
  out = out.replace(SERVICE_TOKEN_RE, REDACTED);
  return out;
}

/**
 * Redact a single free-text value (no key traversal), e.g. a speech field or a
 * chat body before it enters a prompt or a record.
 */
export function sanitizeSecretText(value: string, options: SanitizeOptions = {}): string {
  if (typeof value !== 'string') throw new TypeError('sanitizeSecretText requires a string');
  return redactString(value, resolveKnownSecrets(options));
}

function walk(value: unknown, secrets: readonly string[], depth: number): unknown {
  if (depth > MAX_SANITIZE_DEPTH) return '[truncated]';
  if (typeof value === 'string') return redactString(value, secrets);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => walk(item, secrets, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (SENSITIVE_KEY_RE.test(key)) continue;
      // A malicious provider can echo a configured credential as a JSON key,
      // not only as a value; collapse such keys to the generic marker.
      const safeKey = redactString(key, secrets);
      out[safeKey === key ? key : REDACTED] = walk(entry, secrets, depth + 1);
    }
    return out;
  }
  return null;
}

/**
 * Recursively strip sensitive keys and redact credential-shaped substrings and
 * exact known secret values (including in object keys). Returns a JSON-safe
 * value. `depth` is used by the recursion; callers should pass only `value`
 * and `options`.
 */
export function sanitizeSecretValue(
  value: unknown,
  options: SanitizeOptions = {},
  depth = 0,
): unknown {
  return walk(value, resolveKnownSecrets(options), depth);
}
