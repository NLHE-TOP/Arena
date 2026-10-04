import { DECISION_PROMPT_VERSION, decisionSystemPrompt, sha256Hex } from './decision-prompt.js';

/** A policy is content-addressed; historical evidence retains its own content. */
export const seatPromptPolicy = Object.freeze({
  id: DECISION_PROMPT_VERSION,
  content: decisionSystemPrompt(),
  hash: sha256Hex(decisionSystemPrompt()),
});

export function assertPromptPolicy(id: string, hash: string): void {
  if (id !== seatPromptPolicy.id || hash !== seatPromptPolicy.hash) {
    throw new Error('Agent prompt policy is not supported by this runtime');
  }
}
