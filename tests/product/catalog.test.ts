import { describe, expect, it } from 'vitest';

import {
  AgentCatalog,
  estimateCallCostMicroUsd,
  normalizeAgentConfig,
  type AgentConfigInput,
} from '../../src/product/catalog.js';

const PROMPT_HASH = 'ab'.repeat(32);

function config(overrides: Partial<AgentConfigInput> = {}): AgentConfigInput {
  return {
    id: 'agent-1',
    name: 'Agent One',
    model: 'model-x',
    provider: 'provider-x',
    baseUrl: 'https://provider.example/v1',
    keyEnv: 'PROVIDER_KEY',
    principalId: 'svc:agent-1',
    promptPolicyId: 'prompt-policy-v1',
    promptPolicyHash: PROMPT_HASH,
    pricing: {
      inputMicroUsdPerMillionTokens: 1_000_000,
      outputMicroUsdPerMillionTokens: 2_000_000,
    },
    limits: {
      maxCallsPerRoom: 4,
      maxCostMicroUsdPerRoom: 10_000,
      maxCostMicroUsdPerCall: 2_000,
    },
    ...overrides,
  };
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

describe('agent configuration', () => {
  it('normalizes defaults and keeps prompt policy separate from model/provider', () => {
    const normalized = normalizeAgentConfig(config({ enabled: undefined }));
    expect(normalized).toMatchObject({
      id: 'agent-1',
      baseUrl: 'https://provider.example/v1',
      enabled: true,
      promptPolicyId: 'prompt-policy-v1',
      promptPolicyHash: PROMPT_HASH,
      model: 'model-x',
      provider: 'provider-x',
    });
    expect(normalized.pricing).toEqual({
      inputMicroUsdPerMillionTokens: 1_000_000,
      outputMicroUsdPerMillionTokens: 2_000_000,
    });
  });

  it('requires the explicit prompt policy identity', () => {
    const withoutId = { ...config() } as Record<string, unknown>;
    delete withoutId.promptPolicyId;
    expect(codeOf(() => normalizeAgentConfig(withoutId as never))).toBe('INVALID_FIELD');
    expect(codeOf(() => normalizeAgentConfig(config({ promptPolicyHash: 'not-a-hash' })))).toBe(
      'INVALID_FIELD',
    );
  });

  it('rejects secret material and unknown fields so secrets are never persisted', () => {
    expect(codeOf(() => normalizeAgentConfig({ ...config(), apiKey: 'sk-live-secret' } as never))).toBe(
      'UNKNOWN_FIELD',
    );
    expect(codeOf(() => normalizeAgentConfig(config({ keyEnv: 'sk-live-secret' })))).toBe(
      'INVALID_ENV_REF',
    );
    // Dead configured principal-token references are rejected outright.
    expect(
      codeOf(() => normalizeAgentConfig({ ...config(), tokenEnv: 'PRINCIPAL_TOKEN' } as never)),
    ).toBe('UNKNOWN_FIELD');
  });

  it('requires a safe provider base URL and never echoes it in errors', () => {
    expect(codeOf(() => normalizeAgentConfig(config({ baseUrl: undefined as never })))).toBe(
      'INVALID_FIELD',
    );
    expect(codeOf(() => normalizeAgentConfig(config({ baseUrl: null as never })))).toBe('INVALID_FIELD');
    for (const baseUrl of [
      'notaurl',
      'http://provider.example/v1',
      'ftp://provider.example/v1',
      'https://provider.example/v1?key=1',
      'https://provider.example/v1#fragment',
    ]) {
      expect(codeOf(() => normalizeAgentConfig(config({ baseUrl })))).toBe('INVALID_FIELD');
    }
    for (const baseUrl of [
      'https://provider.example/v1',
      'https://provider.example:8443/openai/v1',
      'http://localhost:8080/v1',
      'http://127.0.0.1:8080/v1',
      'http://[::1]:8080/v1',
    ]) {
      expect(() => normalizeAgentConfig(config({ baseUrl }))).not.toThrow();
    }

    const secretUrl = 'https://user:secretpw@provider.example/v1';
    let message = '';
    try {
      normalizeAgentConfig(config({ baseUrl: secretUrl }));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain('secretpw');
    expect(message).not.toContain(secretUrl);
  });

  it('rejects floats, negatives and incoherent limits', () => {
    expect(
      codeOf(() =>
        normalizeAgentConfig(
          config({
            pricing: { inputMicroUsdPerMillionTokens: 1.5, outputMicroUsdPerMillionTokens: 1 },
          }),
        ),
      ),
    ).toBe('INVALID_NUMBER');
    expect(
      codeOf(() =>
        normalizeAgentConfig(
          config({
            pricing: { inputMicroUsdPerMillionTokens: -1, outputMicroUsdPerMillionTokens: 1 },
          }),
        ),
      ),
    ).toBe('INVALID_NUMBER');
    expect(
      codeOf(() => normalizeAgentConfig(config({ limits: { ...config().limits, maxCallsPerRoom: 0 } }))),
    ).toBe('INVALID_LIMIT');
    expect(
      codeOf(() =>
        normalizeAgentConfig(
          config({
            limits: { maxCallsPerRoom: 1, maxCostMicroUsdPerRoom: 100, maxCostMicroUsdPerCall: 101 },
          }),
        ),
      ),
    ).toBe('INVALID_LIMIT');
  });
});

describe('agent catalog', () => {
  it('registers per-agent configurations and resolves them by id', () => {
    const catalog = new AgentCatalog([config()]);
    catalog.register(config({ id: 'agent-2', model: 'model-y', keyEnv: 'OTHER_KEY' }));
    expect(catalog.has('agent-1')).toBe(true);
    expect(catalog.list().map((entry) => entry.id)).toEqual(['agent-1', 'agent-2']);
    expect(catalog.get('agent-2').model).toBe('model-y');
    expect(codeOf(() => catalog.get('missing'))).toBe('AGENT_NOT_FOUND');

    catalog.register(config({ id: 'agent-1', model: 'model-replaced' }));
    expect(catalog.get('agent-1').model).toBe('model-replaced');
    expect(catalog.unregister('agent-2')).toBe(true);
    expect(catalog.unregister('agent-2')).toBe(false);
  });

  it('resolves only the provider credential from per-agent environment names', () => {
    const catalog = new AgentCatalog([
      config(),
      config({ id: 'agent-2', keyEnv: 'AGENT_TWO_KEY' }),
    ]);
    const env = {
      PROVIDER_KEY: 'sk-live-secret',
      AGENT_TWO_KEY: 'sk-two-secret',
      PRINCIPAL_TOKEN: 'ignored-table-credential',
    };
    expect(catalog.resolveCredentials('agent-1', env)).toEqual({ apiKey: 'sk-live-secret' });
    expect(catalog.resolveCredentials('agent-2', env)).toEqual({ apiKey: 'sk-two-secret' });

    expect(codeOf(() => catalog.resolveCredentials('agent-1', { PRINCIPAL_TOKEN: 'x' }))).toBe('MISSING_ENV');
    expect(codeOf(() => catalog.resolveCredentials('agent-1', { PROVIDER_KEY: '' }))).toBe('MISSING_ENV');

    const serialized = JSON.stringify(catalog.list());
    expect(serialized).not.toContain('sk-live-secret');
    expect(serialized).not.toContain('sk-two-secret');
    expect(serialized).not.toContain('PRINCIPAL_TOKEN');
  });

  it('estimates integer call costs per agent with exact ceil division', () => {
    const pricing = {
      inputMicroUsdPerMillionTokens: 1_000_000,
      outputMicroUsdPerMillionTokens: 2_000_000,
    };
    expect(estimateCallCostMicroUsd(pricing, { promptTokens: 1500, completionTokens: 2000 })).toBe(5500);
    expect(
      estimateCallCostMicroUsd(
        { inputMicroUsdPerMillionTokens: 1_500_000, outputMicroUsdPerMillionTokens: 0 },
        { promptTokens: 1, completionTokens: 0 },
      ),
    ).toBe(2);
    expect(estimateCallCostMicroUsd(pricing, { promptTokens: 0, completionTokens: 0 })).toBe(0);
    expect(Number.isSafeInteger(estimateCallCostMicroUsd(pricing, { promptTokens: 3, completionTokens: 5 }))).toBe(
      true,
    );

    const catalog = new AgentCatalog([config(), config({ id: 'agent-2', pricing: { inputMicroUsdPerMillionTokens: 2_000_000, outputMicroUsdPerMillionTokens: 4_000_000 } })]);
    const usage = { promptTokens: 1000, completionTokens: 1000 };
    expect(catalog.estimateCallCostMicroUsd('agent-1', usage)).toBe(3000);
    expect(catalog.estimateCallCostMicroUsd('agent-2', usage)).toBe(6000);

    expect(codeOf(() => estimateCallCostMicroUsd(pricing, { promptTokens: 1.5, completionTokens: 0 }))).toBe(
      'INVALID_NUMBER',
    );
  });
});
