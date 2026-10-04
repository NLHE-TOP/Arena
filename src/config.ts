import { z } from 'zod';

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  PUBLIC_ORIGIN: z.url().default('http://localhost:3001'),
  POKERTOOLS_API_URL: z.url().default('http://localhost:3000'),
  POKERTOOLS_ORCHESTRATION_TOKEN: z.string().min(1).optional(),
  DATABASE_PATH: z.string().min(1).refine((value) => !value.includes('://'),
    'Product persistence requires a dedicated SQLite file, not a platform database URL').default('data/product.sqlite'),
  AGENTS_CONFIG_PATH: z.string().default('config/agents.json'),
  AGENT_CHAT_ENABLED: z.enum(['0', '1']).default('0'),
  PRODUCT_ADMIN_TOKEN: z.string().min(32).optional(),
  CHALLENGE_ENABLED: z.enum(['0', '1']).default('0'),
  CHALLENGE_ASSET_ID: z.string().min(1).optional(),
  CHALLENGE_ENTRY_ATOMIC: z.string().regex(/^[1-9][0-9]*$/).optional(),
  CHALLENGE_PRIZE_ATOMIC: z.string().regex(/^[1-9][0-9]*$/).optional(),
  CHALLENGE_SPONSOR_PRINCIPAL_ID: z.string().min(1).optional(),
  MAX_PROVIDER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(4),
  MAX_PROVIDER_CALLS: z.coerce.number().int().min(1).max(10000).default(100),
  MAX_COST_USD_MICRO: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(1000000),
  PER_CALL_TIMEOUT_MS: z.coerce.number().int().min(100).max(120000).default(10000),
  OVERALL_RUNTIME_MS: z.coerce.number().int().min(1000).max(86400000).default(600000),
  MAX_HANDS: z.coerce.number().int().min(1).max(10000).default(100),
});

export type Config = z.infer<typeof ConfigSchema>;

/** Configuration is parsed once; credentials never become public config. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const forbidden = /^(?:PAYOUT_|TREASURY_|CUSTODY_|RPC_PROVIDER_|JWT_SECRET$|COOKIE_SECRET$)|(?:MNEMONIC|CHAIN_PRIVATE_KEY)/i;
  if (Object.entries(env).some(([name, value]) => value && forbidden.test(name))) {
    throw new Error('Platform signing, session and RPC credentials must not enter the product process');
  }
  const config = ConfigSchema.parse(env);
  if (config.NODE_ENV === 'production' && config.DATABASE_PATH === ':memory:') {
    throw new Error('Production model evidence requires durable product persistence');
  }
  if (config.CHALLENGE_ENABLED === '1' && (!config.CHALLENGE_ASSET_ID ||
      !config.CHALLENGE_ENTRY_ATOMIC || !config.CHALLENGE_PRIZE_ATOMIC ||
      !config.CHALLENGE_SPONSOR_PRINCIPAL_ID)) {
    throw new Error('Enabled challenges require explicit asset, entry, prize and platform sponsor');
  }
  for (const value of [config.PUBLIC_ORIGIN, config.POKERTOOLS_API_URL]) {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol)) {
      throw new Error('Origins must be HTTP(S) URLs without credentials, queries or fragments');
    }
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      throw new Error('Non-loopback origins require HTTPS');
    }
  }
  const publicOrigin = new URL(config.PUBLIC_ORIGIN);
  if (publicOrigin.pathname !== '/') throw new Error('PUBLIC_ORIGIN must be an origin, not a URL path');
  config.PUBLIC_ORIGIN = publicOrigin.origin;
  return config;
}
