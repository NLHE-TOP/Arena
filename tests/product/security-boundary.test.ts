/**
 * Product boundary sanitizer tests: key dropping, credential-shape redaction,
 * explicit known secrets (including object keys), deterministic
 * non-discovery by default, and SECRET/TOKEN/KEY env catalog discovery.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  API_KEY_REDACTED,
  REDACTED,
  collectEnvKnownSecrets,
  resolveKnownSecrets,
  sanitizeSecretText,
  sanitizeSecretValue,
} from '../../src/security/sanitize.js';

const savedEnv = new Map<string, string | undefined>();

function setEnv(name: string, value: string | undefined): void {
  if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedEnv.clear();
});

describe('product boundary sanitizer', () => {
  it('drops reviewed sensitive keys and keeps benign fields byte-identical', () => {
    const value = {
      authorization: 'Bearer abc.def.ghi',
      api_key: 'sk-whatever',
      set_cookie: 'session=1',
      serviceToken: 'svc-token',
      privateKey: '0xdeadbeef',
      headers: { 'x-api-key': 'nested' },
      max_tokens: 256,
      prompt_tokens: 12,
      messages: [{ role: 'user', content: 'hello' }],
    };
    expect(sanitizeSecretValue(value)).toEqual({
      max_tokens: 256,
      prompt_tokens: 12,
      messages: [{ role: 'user', content: 'hello' }],
    });
  });

  it('redacts credential shapes in free text', () => {
    expect(sanitizeSecretText('call Bearer abc.def.ghi now')).toBe('call Bearer <redacted> now');
    expect(sanitizeSecretText('key sk-live-abcdef')).toBe(`key ${API_KEY_REDACTED}`);
    expect(sanitizeSecretText('see https://user:pass@host/v1')).toBe(`see https://${REDACTED}@host/v1`);
    expect(sanitizeSecretText('plain public speech')).toBe('plain public speech');
  });

  it('redacts explicit known values anywhere, including object keys', () => {
    const secret = 'sk-custom-echo-999';
    const value = {
      note: `leaked ${secret} value`,
      [secret]: 'echoed as a key',
      nested: [{ deep: `prefix ${secret}` }],
    };
    const out = sanitizeSecretValue(value, { knownSecrets: [secret] }) as Record<string, unknown>;
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain(secret);
    expect(out.note).toBe(`leaked ${REDACTED} value`);
    expect(Object.keys(out)).toContain(REDACTED);
    expect(serialized).toContain(`${REDACTED} value`);
  });

  it('does no implicit env discovery unless explicitly requested', () => {
    setEnv('NLHE_SERVICE_TOKEN', 'token-abc-123');
    expect(resolveKnownSecrets({})).toEqual([]);
    expect(resolveKnownSecrets({ includeEnvSecrets: false })).toEqual([]);
    expect(collectEnvKnownSecrets()).toContain('token-abc-123');
    expect(sanitizeSecretText('uses token-abc-123')).toBe('uses token-abc-123');
    expect(sanitizeSecretText('uses token-abc-123', { includeEnvSecrets: true })).toBe(
      `uses ${REDACTED}`,
    );
  });

  it('discovers SECRET/TOKEN/KEY env names and excludes model configuration', () => {
    setEnv('NLHE_SERVICE_TOKEN', 'tok-12345');
    setEnv('RUNTIME_SHARED_SECRET', 'sec-12345');
    setEnv('THIRD_PARTY_API_KEY', 'key-12345');
    setEnv('OPENAI_MODEL', 'gpt-4o');
    const discovered = collectEnvKnownSecrets();
    expect(discovered).toEqual(expect.arrayContaining(['tok-12345', 'sec-12345', 'key-12345']));
    expect(discovered).not.toContain('gpt-4o');
  });

  it('redacts explicit values regardless of env naming or shape', () => {
    expect(sanitizeSecretText('x custom-credential x', { knownSecrets: ['custom-credential'] })).toBe(
      `x ${REDACTED} x`,
    );
    expect(sanitizeSecretText('abc', { knownSecrets: ['abc'] })).toBe(REDACTED);
  });

  it('orders known secrets longest-first so partial substrings cannot survive', () => {
    const out = sanitizeSecretText('value supersecret and secret', {
      knownSecrets: ['secret', 'supersecret'],
    });
    expect(out).toBe(`value ${REDACTED} and ${REDACTED}`);
  });
});
