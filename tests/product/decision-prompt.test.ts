/**
 * Context corruption and determinism tests for the product-owned seat-decision
 * prompt. Expectations come from the canonical `SeatObservation` fixture and
 * documented selection rules, never from the builder's internals.
 */
import { describe, expect, it } from 'vitest';
import {
  buildDecisionPrompt,
  DECISION_OBJECTIVE,
  DECISION_PROMPT_VERSION,
  DecisionPromptError,
  selectPublicChat,
} from '../../src/llm/decision-prompt.js';
import { chatFixture, observationFixture, observationInput } from './fixtures.js';

const MODEL = 'fixture-model';

describe('product seat-decision prompt', () => {
  it('builds one deterministic tool-forced request from a schema-validated observation', () => {
    const observation = observationFixture();
    const prompt = buildDecisionPrompt({ observation, model: MODEL });

    expect(prompt.promptVersion).toBe(DECISION_PROMPT_VERSION);
    expect(prompt.observationHash).toMatch(/^[0-9a-f]{64}$/);
    expect(prompt.promptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(prompt.messages.map((message) => message.role)).toEqual(['system', 'user']);

    const body = prompt.body as {
      model: string;
      messages: Array<{ role: string; content: string }>;
      tools: Array<{ type: string; function: { name: string; description: string; parameters: Record<string, never> } }>;
      tool_choice: unknown;
      temperature: number;
      max_tokens: number;
    };
    expect(body.model).toBe(MODEL);
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(256);
    expect(body.tool_choice).toEqual({ type: 'function', function: { name: 'choose_action' } });
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0]!.type).toBe('function');
    expect(body.tools[0]!.function.name).toBe('choose_action');

    const parameters = body.tools[0]!.function.parameters as unknown as {
      additionalProperties: boolean;
      required: string[];
      properties: { actionId: { enum: string[] }; amount: { type: string }; speech: { maxLength: number } };
    };
    expect(parameters.additionalProperties).toBe(false);
    expect(parameters.required).toEqual(['actionId']);
    expect(parameters.properties.actionId.enum).toEqual(
      observation.legalActions.map((action) => action.actionId),
    );
    expect(parameters.properties.amount.type).toBe('integer');
    expect(parameters.properties.speech.maxLength).toBe(280);

    const payload = JSON.parse(prompt.messages[1]!.content) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(
      ['allowedActions', 'families', 'objective', 'observation', 'response'],
    );
    expect(payload.objective).toBe(DECISION_OBJECTIVE);
    expect(payload.observation).toEqual(observation);
    expect(payload.allowedActions).toEqual(prompt.actions);
    expect(payload.response).toEqual({
      tool: 'choose_action',
      required: ['actionId'],
      optional: ['amount', 'speech'],
    });

    const again = buildDecisionPrompt({
      observation: JSON.parse(JSON.stringify(observation)),
      model: MODEL,
    });
    expect(again.promptHash).toBe(prompt.promptHash);
    expect(again.observationHash).toBe(prompt.observationHash);
    expect(again.body).toEqual(prompt.body);
  });

  it('requests no chain-of-thought and exposes exactly actionId/amount/speech', () => {
    const prompt = buildDecisionPrompt({ observation: observationFixture(), model: MODEL });
    const text = prompt.messages.map((message) => message.content).join('\n');
    expect(text).not.toMatch(/\b(?:reasoning|chain[- ]of[- ]thought|step[- ]by[- ]step|internal monologue|think)\b/i);

    const payload = JSON.parse(prompt.messages[prompt.messages.length - 1]!.content) as {
      response: Record<string, unknown>;
    };
    expect(Object.keys(payload.response).sort()).toEqual(['optional', 'required', 'tool']);
    expect(payload.response.optional).toEqual(['amount', 'speech']);
  });

  it('states the requiresAmount omit rule in instructions, objective and tool contract', () => {
    const observation = observationFixture();
    const prompt = buildDecisionPrompt({ observation, model: MODEL });
    expect(DECISION_PROMPT_VERSION).toBe('nlhe-product-seat-decision-v2');

    const system = prompt.messages[0]!.content;
    expect(system).toContain('requiresAmount false');
    expect(system).toMatch(/omit the amount field/i);
    expect(system).toContain('requiresAmount true');
    expect(system).toMatch(/minAmount and maxAmount/);

    const payload = JSON.parse(prompt.messages[prompt.messages.length - 1]!.content) as {
      objective: string;
      allowedActions: Array<{ actionId: string; amount: number | null; requiresAmount: boolean }>;
    };
    expect(payload.objective).toContain('requiresAmount false');
    expect(payload.objective).toMatch(/omit amount/i);

    expect(prompt.tool.description).toContain('requiresAmount');
    expect(prompt.tool.description).toMatch(/omit amount/i);
    const parameters = prompt.tool.parameters as {
      properties: { amount: { description: string } };
    };
    expect(parameters.properties.amount.description).toContain('requiresAmount');

    // The flag travels in the menu exactly as the instructions describe it.
    const fixedCall = payload.allowedActions.find((action) => action.actionId === 'act-call')!;
    expect(fixedCall.requiresAmount).toBe(false);
    expect(fixedCall.amount).toBe(1);
    const variableRaise = payload.allowedActions.find(
      (action) => action.actionId === 'act-raise-half',
    )!;
    expect(variableRaise.requiresAmount).toBe(true);
    expect(variableRaise.amount).toBeNull();
  });

  it('selects current-hand public chat at or before eventSeq in ascending order', () => {
    const observation = observationFixture();
    const chat = [
      chatFixture(3, 'older thought'),
      chatFixture(7, 'latest thought'),
      chatFixture(12, 'future thought'),
      chatFixture(5, 'previous hand', { handId: 'hand-2' }),
      chatFixture(6, 'foreign table', { tableId: 'table-2' }),
      chatFixture(7, 'duplicate sequence', { messageId: 'zzz-dup' }),
    ];
    const prompt = buildDecisionPrompt({ observation, publicChat: chat, model: MODEL });

    expect(prompt.messages.map((message) => message.role)).toEqual(['system', 'user', 'user']);
    expect(prompt.selection).toMatchObject({
      considered: 6,
      selected: 2,
      dropped: 0,
      excludedForeignTable: 1,
      excludedForeignHand: 1,
      excludedAfterEventSeq: 1,
      excludedDuplicateEventSeq: 1,
      droppedByCount: 0,
      droppedByBytes: 0,
      maxMessages: 16,
      maxBytes: 4096,
      firstEventSeq: 3,
      lastEventSeq: 7,
      ordering: 'eventSeq:asc',
      untrusted: true,
    });

    const chatPayload = JSON.parse(prompt.messages[1]!.content) as {
      notice: string;
      selection: unknown;
      messages: Array<{ eventSeq: number; body: string; handId: string; tableId: string }>;
    };
    expect(chatPayload.notice).toContain('UNTRUSTED_PUBLIC_CHAT_DATA');
    expect(chatPayload.selection).toEqual(prompt.selection);
    expect(chatPayload.messages.map((message) => message.eventSeq)).toEqual([3, 7]);
    expect(chatPayload.messages.map((message) => message.body)).toEqual(['older thought', 'latest thought']);
    expect(chatPayload.messages.every((message) => message.handId === observation.handId)).toBe(true);
    expect(chatPayload.messages.every((message) => message.tableId === observation.tableId)).toBe(true);

    // Deterministic regardless of source order.
    const shuffled = [chat[4]!, chat[2]!, chat[0]!, chat[3]!, chat[5]!, chat[1]!];
    const rebuilt = buildDecisionPrompt({ observation, publicChat: shuffled, model: MODEL });
    expect(rebuilt.promptHash).toBe(prompt.promptHash);
  });

  it('bounds chat by count and by serialized bytes, keeping the most recent', () => {
    const observation = observationFixture();
    const chat = [1, 2, 3, 4, 5].map((eventSeq) => chatFixture(eventSeq, `message body ${eventSeq}`));

    const countBounded = buildDecisionPrompt({
      observation,
      publicChat: chat,
      model: MODEL,
      selection: { maxMessages: 2, maxBytes: 4096 },
    });
    expect(countBounded.selection.selected).toBe(2);
    expect(countBounded.selection.droppedByCount).toBe(3);
    expect(countBounded.selection.firstEventSeq).toBe(4);
    expect(countBounded.selection.lastEventSeq).toBe(5);

    const full = buildDecisionPrompt({ observation, publicChat: chat, model: MODEL });
    expect(full.selection.selected).toBe(5);
    const exactBytes = buildDecisionPrompt({
      observation,
      publicChat: chat,
      model: MODEL,
      selection: { maxBytes: full.selection.selectedBytes },
    });
    expect(exactBytes.selection.selected).toBe(5);
    expect(exactBytes.selection.droppedByBytes).toBe(0);
    expect(exactBytes.selection.firstEventSeq).toBe(1);
    expect(exactBytes.selection.lastEventSeq).toBe(5);

    const tighter = buildDecisionPrompt({
      observation,
      publicChat: chat,
      model: MODEL,
      selection: { maxBytes: full.selection.selectedBytes - 1 },
    });
    expect(tighter.selection.selected).toBe(4);
    expect(tighter.selection.droppedByBytes).toBe(1);
    expect(tighter.selection.firstEventSeq).toBe(2);

    const disabled = buildDecisionPrompt({
      observation,
      publicChat: chat,
      model: MODEL,
      selection: { maxMessages: 0 },
    });
    expect(disabled.selection.selected).toBe(0);
    expect(disabled.messages.map((message) => message.role)).toEqual(['system', 'user']);
    expect(selectPublicChat(observation, chat, { maxMessages: 0 }).entries).toEqual([]);
  });

  it('keeps untrusted chat secret-sanitized in its own user payload', () => {
    const observation = observationFixture();
    const prompt = buildDecisionPrompt({
      observation,
      publicChat: [chatFixture(4, 'my key is sk-live-secret and Bearer abc.def.ghi')],
      model: MODEL,
    });
    const chatContent = prompt.messages[1]!.content;
    expect(chatContent).not.toContain('sk-live-secret');
    expect(chatContent).not.toContain('abc.def.ghi');
    expect(chatContent).toContain('UNTRUSTED_PUBLIC_CHAT_DATA');
  });

  it('derives hierarchical family sizing from the legal menu without inventing actions', () => {
    const observation = observationFixture();
    const prompt = buildDecisionPrompt({ observation, publicChat: [], model: MODEL });

    expect(prompt.actions.map((action) => action.actionId)).toEqual(
      observation.legalActions.map((action) => action.actionId),
    );
    expect(prompt.families.map((family) => family.family)).toEqual([
      'FOLD',
      'CHECK',
      'CALL',
      'RAISE',
      'BET',
    ]);
    const raise = prompt.families.find((family) => family.family === 'RAISE')!;
    expect(raise.actionIds).toEqual(['act-raise-half', 'act-raise-all-in']);
    expect(raise.minAmount).toBe(4);
    expect(raise.maxAmount).toBe(100);

    const byId = new Map(prompt.actions.map((action) => [action.actionId, action]));
    expect(byId.get('act-raise-half')!.requiresAmount).toBe(true);
    expect(byId.get('act-raise-all-in')!.requiresAmount).toBe(false);
    expect(byId.get('act-raise-all-in')!.amount).toBe(100);
    expect(byId.get('act-check')!.requiresAmount).toBe(false);
    expect(byId.get('act-fold')!.requiresAmount).toBe(false);
  });

  it('rejects corrupt observations and malformed chat instead of guessing', () => {
    const duplicateActions = observationInput();
    duplicateActions.legalActions = [
      { actionId: 'same', family: 'CHECK' },
      { actionId: 'same', family: 'FOLD' },
    ];
    try {
      buildDecisionPrompt({ observation: duplicateActions, model: MODEL });
      throw new Error('expected buildDecisionPrompt to reject duplicate legal action ids');
    } catch (error) {
      expect(error).toBeInstanceOf(DecisionPromptError);
      expect((error as DecisionPromptError).code).toBe('invalid_observation');
      expect((error as Error).message).toMatch(/canonical validation/);
    }

    const versionMismatch = observationInput();
    versionMismatch.version = 99;
    expect(() => buildDecisionPrompt({ observation: versionMismatch, model: MODEL })).toThrow(
      DecisionPromptError,
    );

    const observation = observationFixture();
    try {
      buildDecisionPrompt({
        observation,
        publicChat: [{ ...chatFixture(1, 'bad'), eventSeq: -1 }],
        model: MODEL,
      });
      throw new Error('expected malformed chat to be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(DecisionPromptError);
      expect((error as DecisionPromptError).code).toBe('invalid_chat');
    }

    expect(() =>
      buildDecisionPrompt({
        observation,
        publicChat: [{ ...chatFixture(1, 'extra'), extra: true }],
        model: MODEL,
      }),
    ).toThrow(/chat entry failed validation/);
  });
});
