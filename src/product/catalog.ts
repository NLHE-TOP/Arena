/**
 * Agent catalog.
 *
 * A per-agent configuration separates identity (`id`, `name`, `principalId`),
 * provider routing (`model`, `provider`, `baseUrl`), the mandatory explicit
 * prompt policy identity (`promptPolicyId` plus its `promptPolicyHash`), and
 * integer economics (`pricing` in micro-USD per million tokens, `limits` for
 * per-room call/cost budgets). The prompt policy is separate from the model
 * and provider so an agent cannot silently change its instructions.
 *
 * Secrets are never persisted, returned or serialized: configuration stores
 * only the provider credential environment-variable *name* (`keyEnv`), and
 * `AgentCatalog.resolveCredentials` reads the value at call time from the
 * environment handed to it. Table-scoped principal credentials are obtained
 * fresh by the runtime from the public competition client and are never
 * configured here.
 *
 * All amounts are integer micro-USD. `estimateCallCostMicroUsd` performs exact
 * integer arithmetic (ceil division per component) and never returns a float.
 */
import { z } from 'zod';

const EnvRefSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be an environment variable name');

const MicroUsdSchema = z
  .number()
  .int()
  .nonnegative()
  .refine(Number.isSafeInteger, 'must be a safe integer micro-USD amount');

/** Loopback hosts allowed to use plain HTTP for local provider transport. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Required provider base URL. HTTPS always; HTTP only for loopback hosts.
 * Credentials (userinfo), query strings and fragments are rejected. Error
 * messages never echo the URL so credential material cannot leak.
 */
const BaseUrlSchema = z.string().superRefine((value, ctx) => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'baseUrl must be an absolute URL' });
    return;
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    ctx.addIssue({ code: 'custom', message: 'baseUrl must not contain credentials' });
  }
  if (parsed.search.length > 0) {
    ctx.addIssue({ code: 'custom', message: 'baseUrl must not contain a query string' });
  }
  if (parsed.hash.length > 0) {
    ctx.addIssue({ code: 'custom', message: 'baseUrl must not contain a fragment' });
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname))) {
    ctx.addIssue({ code: 'custom', message: 'baseUrl must use https (http is allowed only for loopback hosts)' });
  }
});

/** Integer per-million-token pricing (provider token analytics only). */
export const AgentPricingSchema = z.strictObject({
  inputMicroUsdPerMillionTokens: MicroUsdSchema,
  outputMicroUsdPerMillionTokens: MicroUsdSchema,
});
export type AgentPricing = z.infer<typeof AgentPricingSchema>;

/** Integer per-room compute limits for one agent. */
export const AgentLimitsSchema = z
  .strictObject({
    maxCallsPerRoom: z.number().int().min(1).refine(Number.isSafeInteger),
    maxCostMicroUsdPerRoom: MicroUsdSchema,
    maxCostMicroUsdPerCall: MicroUsdSchema,
  })
  .refine((limits) => limits.maxCostMicroUsdPerCall <= limits.maxCostMicroUsdPerRoom, {
    path: ['maxCostMicroUsdPerCall'],
    message: 'maxCostMicroUsdPerCall must not exceed maxCostMicroUsdPerRoom',
  });
export type AgentLimits = z.infer<typeof AgentLimitsSchema>;

/** Per-agent configuration schema. Strict: unknown fields (for example an accidental `apiKey`) are rejected. */
export const AgentConfigSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  model: z.string().min(1),
  provider: z.string().min(1),
  /** Required provider base URL: HTTPS, loopback-only HTTP, no credentials/query/fragment. */
  baseUrl: BaseUrlSchema,
  /** Environment variable holding the provider API key (a name, never a value). */
  keyEnv: EnvRefSchema,
  /** Principal this agent acts as. Carries no seat authority. */
  principalId: z.string().min(1),
  /** Mandatory explicit prompt policy identity, independent of model/provider. */
  promptPolicyId: z.string().min(1),
  /** SHA-256 of the prompt policy content. */
  promptPolicyHash: z.string().regex(/^[0-9a-f]{64}$/i, 'must be a sha256 hex digest'),
  pricing: AgentPricingSchema,
  limits: AgentLimitsSchema,
  enabled: z.boolean().default(true),
});

export type AgentConfigInput = z.input<typeof AgentConfigSchema>;
export type AgentConfig = Readonly<z.output<typeof AgentConfigSchema>>;

/** Token usage for one provider call. */
export const AgentUsageSchema = z.strictObject({
  promptTokens: z.number().int().nonnegative().refine(Number.isSafeInteger),
  completionTokens: z.number().int().nonnegative().refine(Number.isSafeInteger),
});
export type AgentUsage = z.infer<typeof AgentUsageSchema>;

/** Read-only environment map (for example `process.env`). */
export interface AgentEnvironment {
  readonly [name: string]: string | undefined;
}

/** Credentials resolved for a call; values are never stored by the catalog. */
export interface AgentCredentials {
  apiKey: string;
}

/** Stable failure codes for catalog operations. */
export type AgentConfigErrorCode =
  | 'INVALID_FIELD'
  | 'UNKNOWN_FIELD'
  | 'INVALID_ENV_REF'
  | 'INVALID_NUMBER'
  | 'INVALID_LIMIT'
  | 'AGENT_NOT_FOUND'
  | 'MISSING_ENV';

export class AgentConfigError extends Error {
  readonly code: AgentConfigErrorCode;
  readonly field?: string;

  constructor(code: AgentConfigErrorCode, message: string, field?: string) {
    super(message);
    this.name = 'AgentConfigError';
    this.code = code;
    if (field !== undefined) this.field = field;
  }
}

function catalogError(error: z.ZodError): AgentConfigError {
  const issue = error.issues[0];
  const path = issue?.path.map(String).join('.') ?? '';
  if (issue?.code === 'unrecognized_keys') {
    return new AgentConfigError('UNKNOWN_FIELD', issue.message, path);
  }
  if (path === 'keyEnv') {
    return new AgentConfigError('INVALID_ENV_REF', issue.message, path);
  }
  if (path.startsWith('pricing')) {
    return new AgentConfigError('INVALID_NUMBER', issue.message, path);
  }
  if (path === 'promptTokens' || path === 'completionTokens') {
    return new AgentConfigError('INVALID_NUMBER', issue.message, path);
  }
  if (path.startsWith('limits')) {
    return new AgentConfigError('INVALID_LIMIT', issue.message, path);
  }
  return new AgentConfigError('INVALID_FIELD', issue?.message ?? 'invalid agent config', path);
}

function parseCatalog<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw catalogError(result.error);
  return result.data;
}

/**
 * Validate and freeze one agent configuration. Unknown fields (for example an
 * accidental `apiKey`) are rejected so secret material can never ride along
 * into persistence.
 */
export function normalizeAgentConfig(input: unknown): AgentConfig {
  return Object.freeze(parseCatalog(AgentConfigSchema, input));
}

/**
 * Exact integer cost estimate in micro-USD for one provider call: ceil-divided
 * per-million token components. No floats are used.
 */
export function estimateCallCostMicroUsd(pricing: AgentPricing, usage: AgentUsage): number {
  const rates = parseCatalog(AgentPricingSchema, pricing);
  const tokens = parseCatalog(AgentUsageSchema, usage);
  const million = 1_000_000n;
  const ceilDiv = (numerator: bigint, denominator: bigint): bigint =>
    (numerator + denominator - 1n) / denominator;
  const cost =
    ceilDiv(BigInt(tokens.promptTokens) * BigInt(rates.inputMicroUsdPerMillionTokens), million) +
    ceilDiv(BigInt(tokens.completionTokens) * BigInt(rates.outputMicroUsdPerMillionTokens), million);
  if (cost > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new AgentConfigError('INVALID_NUMBER', 'estimated call cost exceeds safe integer range');
  }
  return Number(cost);
}

/**
 * In-memory per-agent catalog. Registering an existing id replaces that agent
 * configuration (last write wins). Credential resolution reads only the
 * environment passed by the caller; no value is retained.
 */
export class AgentCatalog {
  private readonly configs = new Map<string, AgentConfig>();

  constructor(initial: readonly AgentConfigInput[] = []) {
    for (const config of initial) {
      this.register(config);
    }
  }

  /** Validate, freeze and register (or replace) one agent configuration. */
  register(input: AgentConfigInput): AgentConfig {
    const config = normalizeAgentConfig(input);
    this.configs.set(config.id, config);
    return config;
  }

  /** Remove an agent configuration; returns whether it existed. */
  unregister(agentId: string): boolean {
    return this.configs.delete(agentId);
  }

  has(agentId: string): boolean {
    return this.configs.has(agentId);
  }

  /** Get one agent configuration; throws `AGENT_NOT_FOUND`. */
  get(agentId: string): AgentConfig {
    const config = this.configs.get(agentId);
    if (config === undefined) {
      throw new AgentConfigError('AGENT_NOT_FOUND', `unknown agent: ${agentId}`, agentId);
    }
    return config;
  }

  /** All configurations in registration order. */
  list(): AgentConfig[] {
    return [...this.configs.values()];
  }

  /**
   * Resolve the provider credential for one agent from its per-agent
   * environment variable name. The value is returned to the caller only and
   * is never stored. Principal/table credentials are not configured here; the
   * runtime obtains them fresh from the competition client.
   */
  resolveCredentials(agentId: string, env: AgentEnvironment): AgentCredentials {
    const config = this.get(agentId);
    const apiKey = env[config.keyEnv];
    if (apiKey === undefined || apiKey.length === 0) {
      throw new AgentConfigError(
        'MISSING_ENV',
        `environment variable ${config.keyEnv} is not set for agent ${agentId}`,
        config.keyEnv,
      );
    }
    return { apiKey };
  }

  /** Exact integer cost estimate for one call by this agent. */
  estimateCallCostMicroUsd(agentId: string, usage: AgentUsage): number {
    return estimateCallCostMicroUsd(this.get(agentId).pricing, usage);
  }
}
