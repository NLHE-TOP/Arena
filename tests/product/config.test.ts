import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

describe('startup configuration', () => {
  it('permits local development and defaults to unpaid policy', () => {
    const config = loadConfig({});
    expect(config.CHALLENGE_ENABLED).toBe('0');
    expect(config.MAX_PROVIDER_CONCURRENCY).toBe(4);
  });
  it('requires secure credential-free production origins', () => {
    expect(() => loadConfig({ POKERTOOLS_API_URL: 'http://poker.example' })).toThrow();
    expect(() => loadConfig({ POKERTOOLS_API_URL: 'https://key@poker.example' })).toThrow();
    expect(() => loadConfig({ POKERTOOLS_API_URL: 'https://poker.example?key=private' })).toThrow();
    expect(() => loadConfig({ PUBLIC_ORIGIN: 'https://nlhe.example/room' })).toThrow();
    expect(loadConfig({ PUBLIC_ORIGIN: 'https://nlhe.example/' }).PUBLIC_ORIGIN).toBe('https://nlhe.example');
    expect(loadConfig({ POKERTOOLS_API_URL: 'https://poker.example' }).POKERTOOLS_API_URL).toBe('https://poker.example');
  });
  it('rejects unbounded and fractional budgets', () => {
    expect(() => loadConfig({ MAX_PROVIDER_CONCURRENCY: '0' })).toThrow();
    expect(() => loadConfig({ MAX_COST_USD_MICRO: '0.1' })).toThrow();
    expect(() => loadConfig({ MAX_PROVIDER_CALLS: '10001' })).toThrow();
  });
  it('rejects platform credentials without echoing their values', () => {
    for (const name of ['CUSTODY_SIGNER', 'TREASURY_KEY', 'JWT_SECRET', 'COOKIE_SECRET', 'RPC_PROVIDER_A']) {
      expect(() => loadConfig({ [name]: 'synthetic-secret' })).toThrow('must not enter the product process');
    }
  });
  it('requires a dedicated durable production database', () => {
    expect(() => loadConfig({ DATABASE_PATH: 'postgres://private.example/platform' })).toThrow();
    expect(() => loadConfig({ NODE_ENV: 'production', DATABASE_PATH: ':memory:' })).toThrow();
    expect(loadConfig({ NODE_ENV: 'test', DATABASE_PATH: ':memory:' }).DATABASE_PATH).toBe(':memory:');
  });
});
