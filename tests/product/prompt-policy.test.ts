import { expect, it } from 'vitest';
import { assertPromptPolicy, seatPromptPolicy } from '../../src/llm/prompt-policy.js';

it('requires an explicit supported content-addressed prompt policy', () => {
  expect(() => assertPromptPolicy(seatPromptPolicy.id, seatPromptPolicy.hash)).not.toThrow();
  expect(() => assertPromptPolicy('other', seatPromptPolicy.hash)).toThrow();
  expect(() => assertPromptPolicy(seatPromptPolicy.id, '0'.repeat(64))).toThrow();
});
