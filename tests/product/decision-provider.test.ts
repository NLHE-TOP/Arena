/**
 * Loopback HTTP tests for the product-owned OpenAI-compatible provider.
 *
 * The provider uses the real global `fetch` against an in-process HTTP server,
 * so recording order, exact wire bytes, auth-header exclusion, strict response
 * validation, integer cost and timeout behavior are exercised end to end.
 */
import { describe, expect, it } from 'vitest';
import {
  DecisionResponseError,
  MAX_RESPONSE_BYTES,
  ProductDecisionProvider,
  type DecisionProviderConfig,
  type DecisionRequestRecord,
  type DecisionResponseRecord,
} from '../../src/llm/decision-provider.js';
import { sha256Hex } from '../../src/llm/decision-prompt.js';
import { inspectDecisionRequest } from '../../src/audit/decision-request-inspector.js';
import { chatFixture, observationFixture } from './fixtures.js';
import { startFakeProvider, toolCallResponse, type FakeReply } from './fake-provider.js';

const MODEL = 'fixture-model';
const observation = observationFixture();

interface Recorded {
  events: string[];
  requests: DecisionRequestRecord[];
  responses: DecisionResponseRecord[];
}

function recordingConfig(events: string[], requests: DecisionRequestRecord[], responses: DecisionResponseRecord[]) {
  return {
    onRequest: (record: DecisionRequestRecord) => {
      events.push('request');
      requests.push(record);
    },
    onResponse: (record: DecisionResponseRecord) => {
      events.push('response');
      responses.push(record);
    },
  };
}

function baseConfig(
  url: string,
  recorded: Recorded,
  overrides: Partial<DecisionProviderConfig> = {},
): DecisionProviderConfig {
  return {
    baseUrl: url,
    model: MODEL,
    timeoutMs: 1000,
    inputUsdMicroPerMillion: 2_500_000n,
    outputUsdMicroPerMillion: 1_000_000n,
    includeEnvSecrets: false,
    ...recordingConfig(recorded.events, recorded.requests, recorded.responses),
    ...overrides,
  };
}

function mutateToolCallResponse(mutate: (payload: {
  choices: Array<{ message: Record<string, unknown> }>;
  usage?: Record<string, unknown>;
}) => void): string {
  const payload = JSON.parse(
    toolCallResponse({ actionId: 'act-raise-half', amount: 12, speech: 'raising it up' }),
  ) as { choices: Array<{ message: Record<string, unknown> }>; usage?: Record<string, unknown> };
  mutate(payload);
  return JSON.stringify(payload);
}

describe('product decision provider over HTTP loopback', () => {
  it('persists the exact sanitized request before HTTP and response before returning', async () => {
    const recorded: Recorded = { events: [], requests: [], responses: [] };
    let receivedBody = '';
    const replyBody = toolCallResponse({
      actionId: 'act-raise-half',
      amount: 12,
      speech: 'raising it up',
    });
    const fake = await startFakeProvider((exchange) => {
      // The synchronous request callback must already have observed the exact
      // body by the time the server receives it.
      expect(recorded.requests).toHaveLength(1);
      expect(exchange.body).toBe(recorded.requests[0]!.requestJson);
      receivedBody = exchange.body;
      recorded.events.push('http');
      return { status: 200, body: replyBody };
    });

    try {
      const provider = new ProductDecisionProvider(baseConfig(fake.url, recorded, {
        apiKey: 'sk-test-secret',
      }));
      const outcome = await provider.chooseAction({ observation });
      recorded.events.push('return');

      expect(recorded.events).toEqual(['request', 'http', 'response', 'return']);
      expect(recorded.requests).toHaveLength(1);
      expect(recorded.responses).toHaveLength(1);
      expect(recorded.requests[0]!.requestJson).toBe(receivedBody);
      expect(JSON.parse(recorded.requests[0]!.requestJson)).toEqual(JSON.parse(receivedBody));
      expect(recorded.requests[0]!.promptHash).toMatch(/^[0-9a-f]{64}$/);
      expect(recorded.requests[0]!.observationHash).toMatch(/^[0-9a-f]{64}$/);

      // Auth is sent to the provider but never enters an audit record.
      expect(fake.exchanges[0]!.headers.authorization).toBe('Bearer sk-test-secret');
      expect(recorded.requests[0]!).not.toHaveProperty('headers');
      expect(JSON.stringify(recorded.requests[0]!)).not.toContain('sk-test-secret');
      expect(receivedBody).not.toContain('sk-test-secret');

      expect(outcome.action).toEqual({
        actionId: 'act-raise-half',
        family: 'RAISE',
        amount: 12,
        speech: 'raising it up',
        normalization: null,
      });
      expect(outcome.response.status).toBe(200);
      expect(outcome.response.ok).toBe(true);
      expect(outcome.response.errorCode).toBeNull();
      expect(outcome.response.inputTokens).toBe(100);
      expect(outcome.response.outputTokens).toBe(10);
      // ceil(100 * 2_500_000 / 1e6) + ceil(10 * 1_000_000 / 1e6) = 250 + 10
      expect(outcome.response.costUsdMicro).toBe(260n);
      expect(outcome.response.responseJson).not.toBeNull();
      // `responseBytes` describes the retained sanitized body exactly;
      // `rawResponseBytes` describes the wire body.
      expect(recorded.responses[0]!.responseBytes).toBe(
        Buffer.byteLength(recorded.responses[0]!.responseJson!, 'utf8'),
      );
      expect(recorded.responses[0]!.rawResponseBytes).toBe(Buffer.byteLength(replyBody, 'utf8'));
    } finally {
      await fake.close();
    }
  });

  it('rounds usage cost up per token term with integer per-million prices', async () => {
    const recorded: Recorded = { events: [], requests: [], responses: [] };
    const fake = await startFakeProvider(() => ({
      status: 200,
      body: toolCallResponse(
        { actionId: 'act-check' },
        { usage: { prompt_tokens: 1, completion_tokens: 1 } },
      ),
    }));
    try {
      const provider = new ProductDecisionProvider(baseConfig(fake.url, recorded, {
        inputUsdMicroPerMillion: 1n,
        outputUsdMicroPerMillion: 1n,
      }));
      const outcome = await provider.chooseAction({ observation });
      expect(outcome.action.amount).toBeNull();
      expect(outcome.response.costUsdMicro).toBe(2n);
    } finally {
      await fake.close();
    }
  });

  it('accepts an omitted amount for a fixed requiresAmount:false action and keeps the exact server amount', async () => {
    const recorded: Recorded = { events: [], requests: [], responses: [] };
    const fake = await startFakeProvider(() => ({
      status: 200,
      body: toolCallResponse({ actionId: 'act-call' }),
    }));
    try {
      const provider = new ProductDecisionProvider(baseConfig(fake.url, recorded));
      const outcome = await provider.chooseAction({ observation });
      expect(outcome.action).toEqual({
        actionId: 'act-call',
        family: 'CALL',
        amount: 1,
        speech: null,
        normalization: null,
      });
      expect(outcome.response.errorCode).toBeNull();
    } finally {
      await fake.close();
    }
  });

  it('ignores an irrelevant amount for requiresAmount:false actions and records the normalization', async () => {
    const cases: Array<{
      name: string;
      observation: typeof observation;
      reply: Record<string, unknown>;
      expected: { actionId: string; family: string; amount: number | null };
    }> = [
      {
        name: 'CALL fixed amount mismatched',
        observation,
        reply: { actionId: 'act-call', amount: 102 },
        expected: { actionId: 'act-call', family: 'CALL', amount: 1 },
      },
      {
        name: 'CALL fixed amount equal',
        observation,
        reply: { actionId: 'act-call', amount: 1 },
        expected: { actionId: 'act-call', family: 'CALL', amount: 1 },
      },
      {
        name: 'RAISE all-in amount mismatched',
        observation,
        reply: { actionId: 'act-raise-all-in', amount: 99 },
        expected: { actionId: 'act-raise-all-in', family: 'RAISE', amount: 100 },
      },
      {
        name: 'FOLD with amount 0',
        observation,
        reply: { actionId: 'act-fold', amount: 0 },
        expected: { actionId: 'act-fold', family: 'FOLD', amount: null },
      },
      {
        name: 'DEAL with amount 0',
        observation: observationFixture({ legalActions: [{ actionId: 'act-deal', family: 'DEAL' }] }),
        reply: { actionId: 'act-deal', amount: 0 },
        expected: { actionId: 'act-deal', family: 'DEAL', amount: null },
      },
      {
        name: 'CHECK with a non-integer amount',
        observation,
        reply: { actionId: 'act-check', amount: 2.5 },
        expected: { actionId: 'act-check', family: 'CHECK', amount: null },
      },
    ];

    for (const testCase of cases) {
      const recorded: Recorded = { events: [], requests: [], responses: [] };
      const fake = await startFakeProvider(() => ({
        status: 200,
        body: toolCallResponse(testCase.reply),
      }));
      try {
        const provider = new ProductDecisionProvider(baseConfig(fake.url, recorded));
        const outcome = await provider.chooseAction({ observation: testCase.observation });
        expect(outcome.action, testCase.name).toEqual({
          ...testCase.expected,
          speech: null,
          normalization: 'amount_ignored',
        });
        expect(outcome.response.errorCode, testCase.name).toBeNull();
        // The raw provider response stays exactly recorded; only the resolved
        // action differs.
        expect(recorded.responses[0]!.responseJson, testCase.name).toContain(
          JSON.stringify(testCase.reply.amount),
        );
      } finally {
        await fake.close();
      }
    }
  });

  it('treats whitespace-only speech as silence', async () => {
    for (const speech of ['', '   ', '\n\t ']) {
      const recorded: Recorded = { events: [], requests: [], responses: [] };
      const fake = await startFakeProvider(() => ({
        status: 200,
        body: toolCallResponse({ actionId: 'act-check', speech }),
      }));
      try {
        const provider = new ProductDecisionProvider(baseConfig(fake.url, recorded));
        const outcome = await provider.chooseAction({ observation });
        expect(outcome.action.speech, JSON.stringify(speech)).toBeNull();
        expect(outcome.response.errorCode, JSON.stringify(speech)).toBeNull();
      } finally {
        await fake.close();
      }
    }
  });

  it('records a sanitized response and fails closed on HTTP errors', async () => {
    const recorded: Recorded = { events: [], requests: [], responses: [] };
    const fake = await startFakeProvider(() => ({
      status: 500,
      body: JSON.stringify({ error: { message: 'upstream failed Bearer sk-leak-12345' } }),
    }));
    try {
      const provider = new ProductDecisionProvider(baseConfig(fake.url, recorded));
      await expect(provider.chooseAction({ observation })).rejects.toMatchObject({
        name: 'DecisionTransportError',
        code: 'provider_error',
        status: 500,
      });
      expect(recorded.responses).toHaveLength(1);
      expect(recorded.responses[0]!.status).toBe(500);
      expect(recorded.responses[0]!.errorCode).toBe('provider_error');
      expect(recorded.responses[0]!.responseJson).not.toBeNull();
      expect(recorded.responses[0]!.responseJson).not.toContain('sk-leak-12345');
      expect(recorded.events.at(-1)).toBe('response');
    } finally {
      await fake.close();
    }
  });

  it('enforces a strict timeout and records the failed exchange', async () => {
    const recorded: Recorded = { events: [], requests: [], responses: [] };
    const fake = await startFakeProvider(() => ({
      status: 200,
      body: toolCallResponse({ actionId: 'act-check' }),
      delayMs: 250,
    }));
    try {
      const provider = new ProductDecisionProvider(baseConfig(fake.url, recorded, { timeoutMs: 25 }));
      await expect(provider.chooseAction({ observation })).rejects.toMatchObject({
        name: 'DecisionTransportError',
        code: 'timeout',
      });
      expect(recorded.events[0]).toBe('request');
      expect(recorded.events).toContain('response');
      expect(recorded.responses[0]!.status).toBe(0);
      expect(recorded.responses[0]!.errorCode).toBe('timeout');
      expect(recorded.responses[0]!.responseJson).toBeNull();
      expect(recorded.responses[0]!.costUsdMicro).toBe(0n);
    } finally {
      await fake.close();
    }
  });

  it('redacts a configured key echoed by a malicious provider and sanitizes speech', async () => {
    const apiKey = 'sk-custom-echo-abcdef';
    const recorded: Recorded = { events: [], requests: [], responses: [] };
    const payload = JSON.parse(
      toolCallResponse({
        actionId: 'act-raise-half',
        amount: 12,
        speech: `my key is ${apiKey}`,
      }),
    ) as Record<string, unknown> & {
      choices: Array<{ message: Record<string, unknown> }>;
    };
    payload.choices[0]!.message.content = `authorization: Bearer ${apiKey}`;
    payload[apiKey] = 'echoed as a JSON key';
    const fake = await startFakeProvider(() => ({ status: 200, body: JSON.stringify(payload) }));
    try {
      const provider = new ProductDecisionProvider(baseConfig(fake.url, recorded, { apiKey }));
      const outcome = await provider.chooseAction({ observation });

      // The chosen action semantics are unchanged; only speech is sanitized.
      expect(outcome.action.actionId).toBe('act-raise-half');
      expect(outcome.action.amount).toBe(12);
      expect(outcome.action.family).toBe('RAISE');
      expect(outcome.action.speech).not.toBeNull();
      expect(outcome.action.speech).not.toContain(apiKey);
      expect(outcome.action.speech).toContain('<redacted>');

      // Neither retained body nor request may carry the configured key, not
      // even as a JSON key name.
      expect(recorded.responses[0]!.responseJson).not.toContain(apiKey);
      expect(recorded.requests[0]!.requestJson).not.toContain(apiKey);
      expect(recorded.responses[0]!.responseBytes).toBe(
        Buffer.byteLength(recorded.responses[0]!.responseJson!, 'utf8'),
      );
    } finally {
      await fake.close();
    }
  });

  it('redacts secret chat ids before hashing so transport and inspection never drift', async () => {
    const secret = 'sk-chat-id-secret-123456';
    const recorded: Recorded = { events: [], requests: [], responses: [] };
    const fake = await startFakeProvider(() => ({
      status: 200,
      body: toolCallResponse({ actionId: 'act-check' }),
    }));
    try {
      const provider = new ProductDecisionProvider(
        baseConfig(fake.url, recorded, { apiKey: secret, includeEnvSecrets: false }),
      );
      const publicChat = [
        chatFixture(3, 'clean body', {
          messageId: `msg-${secret}`,
          principalId: `svc-${secret}`,
        }),
        chatFixture(5, `body mentioning ${secret}`),
      ];
      const outcome = await provider.chooseAction({ observation, publicChat });

      // The configured secret never reaches the wire or a persisted record,
      // not even inside opaque id fields.
      expect(fake.exchanges[0]!.body).not.toContain(secret);
      expect(recorded.requests[0]!.requestJson).not.toContain(secret);
      expect(outcome.prompt.messages.map((message) => message.content).join('\n')).not.toContain(secret);

      // The record hash covers the exact persisted sanitized body.
      expect(recorded.requests[0]!.requestHash).toBe(sha256Hex(recorded.requests[0]!.requestJson));

      const recordHeader = {
        model: outcome.request.model,
        promptVersion: outcome.request.promptVersion,
        promptHash: outcome.request.promptHash,
        observationHash: outcome.request.observationHash,
        temperature: outcome.prompt.temperature,
        maxOutputTokens: outcome.prompt.maxOutputTokens,
        requestHash: outcome.request.requestHash,
      };
      const request = JSON.parse(recorded.requests[0]!.requestJson) as Record<string, unknown>;

      // The builder-hashed request and the transport-sent request agree, so
      // the independent inspector passes with the same explicit policy.
      const report = inspectDecisionRequest({
        request,
        record: recordHeader,
        observation,
        publicChat,
        knownSecrets: [secret],
      });
      expect(report.ok).toBe(true);
      expect(report.chatSelectedEventSeqs).toEqual([3, 5]);
      expect(report.checks).toContain('request_hash');

      // Without the explicit policy the independently selected source chat
      // differs from the recorded redacted ids: the drift is detected, not
      // silently accepted.
      expect(() =>
        inspectDecisionRequest({ request, record: recordHeader, observation, publicChat }),
      ).toThrow(/chat selection metadata mismatch|selected chat differs/);

      const recordedChat = JSON.parse(
        (request.messages as Array<{ role: string; content: string }>)[1]!.content,
      ) as { messages: Array<{ messageId: string; principalId: string; body: string }> };
      expect(recordedChat.messages[0]!.messageId).toBe('msg-<redacted>');
      expect(recordedChat.messages[0]!.principalId).toBe('svc-<redacted>');
      expect(recordedChat.messages[1]!.body).toContain('<redacted>');
    } finally {
      await fake.close();
    }
  });

  it('never sends a configured key embedded in public chat', async () => {
    const apiKey = 'sk-chat-secret-abcdef';
    const recorded: Recorded = { events: [], requests: [], responses: [] };
    const fake = await startFakeProvider(() => ({
      status: 200,
      body: toolCallResponse({ actionId: 'act-check' }),
    }));
    try {
      const provider = new ProductDecisionProvider(baseConfig(fake.url, recorded, { apiKey }));
      const outcome = await provider.chooseAction({
        observation,
        publicChat: [chatFixture(3, `my key is ${apiKey} and Bearer sk-other-123456`)],
      });
      expect(fake.exchanges[0]!.body).not.toContain(apiKey);
      expect(fake.exchanges[0]!.body).not.toContain('sk-other-123456');
      expect(recorded.requests[0]!.requestJson).not.toContain(apiKey);
      expect(outcome.prompt.messages.map((message) => message.content).join('\n')).not.toContain(apiKey);
    } finally {
      await fake.close();
    }
  });

  it('bounds provider response bytes and retains no oversized raw text', async () => {
    const recorded: Recorded = { events: [], requests: [], responses: [] };
    const oversizedFiller = 'x'.repeat(MAX_RESPONSE_BYTES + 4096);
    const fake = await startFakeProvider(() => ({
      status: 200,
      body: JSON.stringify({ choices: [], padding: oversizedFiller }),
    }));
    try {
      const provider = new ProductDecisionProvider(baseConfig(fake.url, recorded));
      await expect(provider.chooseAction({ observation })).rejects.toMatchObject({
        name: 'DecisionTransportError',
        code: 'response_too_large',
      });
      const response = recorded.responses[0]!;
      expect(response.errorCode).toBe('response_too_large');
      expect(response.responseJson).not.toBeNull();
      expect(response.responseBytes).toBe(Buffer.byteLength(response.responseJson!, 'utf8'));
      expect(response.responseBytes).toBeLessThan(512);
      expect(response.responseJson).not.toContain('x'.repeat(64));
      expect(response.rawResponseBytes).toBeGreaterThan(0);
      expect(recorded.events).toEqual(['request', 'response']);
    } finally {
      await fake.close();
    }
  });

  it('keeps the strict deadline while a body is streaming', async () => {
    const recorded: Recorded = { events: [], requests: [], responses: [] };
    const fake = await startFakeProvider(() => ({
      status: 200,
      chunks: ['{"choices":[', '{"message":', '"never finishes"}'],
      chunkDelayMs: 60,
    }));
    try {
      const provider = new ProductDecisionProvider(baseConfig(fake.url, recorded, { timeoutMs: 25 }));
      await expect(provider.chooseAction({ observation })).rejects.toMatchObject({
        name: 'DecisionTransportError',
        code: 'timeout',
      });
      expect(recorded.responses[0]!.errorCode).toBe('timeout');
      expect(recorded.responses[0]!.responseJson).toBeNull();
      expect(recorded.responses[0]!.rawResponseBytes).toBeLessThan(MAX_RESPONSE_BYTES);
    } finally {
      await fake.close();
    }
  });

  it('rejects credential-bearing, query-bearing and plaintext remote base URLs', () => {
    const base = { model: MODEL, inputUsdMicroPerMillion: 1n, outputUsdMicroPerMillion: 1n };
    expect(() => new ProductDecisionProvider({ ...base, baseUrl: 'http://api.example.com' })).toThrow(
      /HTTPS/,
    );
    expect(() =>
      new ProductDecisionProvider({ ...base, baseUrl: 'https://user:pass@api.example.com' }),
    ).toThrow(/credentials/);
    expect(() =>
      new ProductDecisionProvider({ ...base, baseUrl: 'https://api.example.com?key=abc' }),
    ).toThrow(/query/);
    expect(() =>
      new ProductDecisionProvider({ ...base, baseUrl: 'https://api.example.com#frag' }),
    ).toThrow(/fragment/);
    expect(
      () => new ProductDecisionProvider({ ...base, baseUrl: 'http://127.0.0.1:9' }),
    ).not.toThrow();
    expect(
      () => new ProductDecisionProvider({ ...base, baseUrl: 'https://api.example.com/v1' }),
    ).not.toThrow();
  });

  it('does not call the provider when request persistence fails', async () => {
    const recorded: Recorded = { events: [], requests: [], responses: [] };
    const fake = await startFakeProvider(() => ({ status: 200, body: toolCallResponse({ actionId: 'act-check' }) }));
    try {
      const provider = new ProductDecisionProvider(baseConfig(fake.url, recorded, {
        onRequest: () => {
          throw new Error('audit sink unavailable');
        },
      }));
      await expect(provider.chooseAction({ observation })).rejects.toThrow('audit sink unavailable');
      expect(fake.exchanges).toHaveLength(0);
      expect(recorded.responses).toHaveLength(0);
    } finally {
      await fake.close();
    }
  });

  it('rejects malformed, out-of-menu and identity-bearing model output', async () => {
    const cases: Array<{ name: string; reply: () => FakeReply; code: string }> = [
      {
        name: 'unknown tool',
        reply: () =>
          mutateReply((payload) => {
            (payload.choices[0]!.message.tool_calls as Array<{ function: { name: string } }>)[0]!.function.name =
              'choose_other';
          }),
        code: 'unknown_tool',
      },
      {
        name: 'legacy function_call',
        reply: () =>
          mutateReply((payload) => {
            payload.choices[0]!.message.function_call = { name: 'choose_action', arguments: '{}' };
            delete payload.choices[0]!.message.tool_calls;
          }),
        code: 'unknown_tool',
      },
      {
        name: 'identity field',
        reply: () =>
          mutateReply((payload) => {
            const args = JSON.parse(
              (payload.choices[0]!.message.tool_calls as Array<{ function: { arguments: string } }>)[0]!.function
                .arguments,
            ) as Record<string, unknown>;
            args.playerId = 'p0';
            (payload.choices[0]!.message.tool_calls as Array<{ function: { arguments: string } }>)[0]!.function.arguments =
              JSON.stringify(args);
          }),
        code: 'identity_field',
      },
      {
        name: 'unknown field',
        reply: () =>
          mutateReply((payload) => {
            const args = JSON.parse(
              (payload.choices[0]!.message.tool_calls as Array<{ function: { arguments: string } }>)[0]!.function
                .arguments,
            ) as Record<string, unknown>;
            args.reasoning = 'because';
            (payload.choices[0]!.message.tool_calls as Array<{ function: { arguments: string } }>)[0]!.function.arguments =
              JSON.stringify(args);
          }),
        code: 'unknown_field',
      },
      {
        name: 'non-integer amount',
        reply: () => ({ status: 200, body: toolCallResponse({ actionId: 'act-raise-half', amount: 4.5 }) }),
        code: 'invalid_amount',
      },
      {
        name: 'string amount',
        reply: () => ({ status: 200, body: toolCallResponse({ actionId: 'act-raise-half', amount: '4' }) }),
        code: 'invalid_amount',
      },
      {
        name: 'out-of-bounds amount',
        reply: () => ({ status: 200, body: toolCallResponse({ actionId: 'act-raise-half', amount: 3 }) }),
        code: 'amount_out_of_bounds',
      },
      {
        name: 'missing required amount',
        reply: () => ({ status: 200, body: toolCallResponse({ actionId: 'act-raise-half' }) }),
        code: 'missing_amount',
      },
      {
        name: 'unknown action id',
        reply: () => ({ status: 200, body: toolCallResponse({ actionId: 'act-not-legal' }) }),
        code: 'unknown_action',
      },
      {
        name: 'multiple tool calls',
        reply: () =>
          mutateReply((payload) => {
            (payload.choices[0]!.message.tool_calls as unknown[]).push(
              JSON.parse(JSON.stringify((payload.choices[0]!.message.tool_calls as unknown[])[0])),
            );
          }),
        code: 'multiple_tool_calls',
      },
      {
        name: 'missing tool call',
        reply: () =>
          mutateReply((payload) => {
            delete payload.choices[0]!.message.tool_calls;
          }),
        code: 'missing_tool_call',
      },
      {
        name: 'malformed tool arguments',
        reply: () =>
          mutateReply((payload) => {
            (payload.choices[0]!.message.tool_calls as Array<{ function: { arguments: string } }>)[0]!.function.arguments =
              'not-json';
          }),
        code: 'invalid_arguments',
      },
      {
        name: 'malformed usage',
        reply: () => ({
          status: 200,
          body: toolCallResponse(
            { actionId: 'act-check' },
            { usage: { prompt_tokens: 1.5, completion_tokens: 1 } },
          ),
        }),
        code: 'invalid_usage',
      },
      {
        name: 'oversized speech',
        reply: () => ({ status: 200, body: toolCallResponse({ actionId: 'act-check', speech: 'x'.repeat(281) }) }),
        code: 'invalid_speech',
      },
    ];

    for (const testCase of cases) {
      const recorded: Recorded = { events: [], requests: [], responses: [] };
      const fake = await startFakeProvider(testCase.reply);
      try {
        const provider = new ProductDecisionProvider(baseConfig(fake.url, recorded));
        const error = await provider.chooseAction({ observation }).then(
          () => null,
          (caught: unknown) => caught,
        );
        expect(error, testCase.name).toBeInstanceOf(DecisionResponseError);
        expect((error as DecisionResponseError).code, testCase.name).toBe(testCase.code);
        expect(recorded.events, testCase.name).toEqual(['request', 'response']);
        expect(recorded.responses, testCase.name).toHaveLength(1);
        expect(recorded.responses[0]!.errorCode, testCase.name).toBe(testCase.code);
        expect(recorded.responses[0]!.responseJson, testCase.name).not.toBeNull();
      } finally {
        await fake.close();
      }
    }
  });
});

function mutateReply(mutate: (payload: {
  choices: Array<{ message: Record<string, unknown> }>;
}) => void): FakeReply {
  return { status: 200, body: mutateToolCallResponse(mutate) };
}
