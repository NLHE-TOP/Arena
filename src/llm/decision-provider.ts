/**
 * Product-owned OpenAI-compatible transport for the canonical seat-decision
 * prompt.
 *
 * Guarantees:
 * - The exact sanitized request body is persisted through `onRequest` BEFORE
 *   any HTTP I/O. Auth headers are never part of a record.
 * - The exact sanitized response body is persisted through `onResponse` BEFORE
 *   this module returns or throws, for every HTTP exchange (including error
 *   statuses, timeouts and transport failures).
 * - Timeouts are strict: one `timeoutMs` deadline bounds the whole exchange
 *   (headers + body) and is combined with the caller signal.
 * - Model output fails closed: exactly one `choose_action` call over the
 *   supplied menu, integer amounts within the selected action's bounds, no
 *   extra fields, no identity fields, no unknown tools.
 * - Cost is integer micro-USD with per-million integer prices, ceiling-rounded
 *   per token term. No floating point money.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { LegalActionFamily, SeatObservation } from '@pokertools/types';
import {
  resolveKnownSecrets,
  sanitizeSecretText,
  sanitizeSecretValue,
} from '../security/sanitize.js';
import {
  computeUsageCostUsdMicro,
  type MicroUsdPerMillion,
} from './cost.js';
import {
  buildDecisionPrompt,
  DECISION_TOOL_NAME,
  MAX_SPEECH_CHARS,
  type ChatSelectionOptions,
  type DecisionActionOption,
  type DecisionPrompt,
} from './decision-prompt.js';

export const DEFAULT_DECISION_TIMEOUT_MS = 30_000;
/** Hard cap on a provider response body; larger bodies are cut off mid-stream. */
export const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_UNPARSED_RESPONSE_CHARS = 4096;

export type DecisionTransportErrorCode =
  | 'timeout'
  | 'aborted'
  | 'transport_error'
  | 'http_error'
  | 'rate_limit'
  | 'provider_error'
  | 'response_too_large';

export type DecisionResponseErrorCode =
  | 'invalid_provider_payload'
  | 'missing_choice'
  | 'unknown_tool'
  | 'missing_tool_call'
  | 'multiple_tool_calls'
  | 'invalid_arguments'
  | 'unknown_field'
  | 'identity_field'
  | 'unknown_action'
  | 'missing_amount'
  | 'invalid_amount'
  | 'amount_out_of_bounds'
  | 'amount_mismatch'
  | 'amount_not_allowed'
  | 'invalid_speech'
  | 'invalid_usage';

export class DecisionTransportError extends Error {
  constructor(
    readonly code: DecisionTransportErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'DecisionTransportError';
  }
}

export class DecisionResponseError extends Error {
  constructor(
    readonly code: DecisionResponseErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DecisionResponseError';
  }
}

/** Exact sanitized request persisted before HTTP. Never contains auth headers. */
export interface DecisionRequestRecord {
  requestId: string;
  provider: string;
  model: string;
  baseUrlHost: string;
  promptVersion: string;
  promptHash: string;
  observationHash: string;
  /** Exact sanitized request body sent to the provider. */
  requestJson: string;
  requestHash: string;
  requestBytes: number;
  startedAt: number;
}

/** Exact sanitized response persisted before returning or throwing. */
export interface DecisionResponseRecord {
  requestId: string;
  /** HTTP status, or 0 when no response was received (timeout/transport). */
  status: number;
  ok: boolean;
  /** Exact sanitized response body, or null when no response was received. */
  responseJson: string | null;
  /** Byte length of the retained sanitized `responseJson` (0 when null). */
  responseBytes: number;
  /** Raw bytes received from the wire before sanitization/truncation. */
  rawResponseBytes: number;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Integer micro-USD, ceiling-rounded per token term. */
  costUsdMicro: bigint;
  errorCode: string | null;
  finishedAt: number;
}

export interface ChosenAction {
  actionId: string;
  family: LegalActionFamily;
  /** Resolved integer amount: model choice or the action's exact server amount. */
  amount: number | null;
  speech: string | null;
  /**
   * `'amount_ignored'` when the raw provider response supplied an `amount` for
   * an action whose menu entry has `requiresAmount: false`. The amount cannot
   * alter that action (the server amount is exact), so it was discarded and the
   * server amount resolved; the raw provider response remains exactly recorded.
   * `null` when no normalization happened.
   */
  normalization: 'amount_ignored' | null;
}

export interface DecisionProviderConfig {
  baseUrl: string;
  model: string;
  /** Secret; sent as a bearer header and NEVER persisted or recorded. */
  apiKey?: string;
  /** Provider label for audit records. Defaults to "openai-compatible". */
  provider?: string;
  /** Strict deadline for one HTTP exchange. Defaults to 30000 ms. */
  timeoutMs?: number;
  temperature?: number;
  maxOutputTokens?: number;
  /**
   * Extra exact secret values scrubbed from request, response and speech. The
   * configured `apiKey` is always included explicitly, independent of env.
   */
  knownSecrets?: readonly string[];
  /**
   * When true (default), credential-named env values (SECRET / TOKEN / KEY) are
   * also redacted. Set false for a fully explicit, hermetic policy.
   */
  includeEnvSecrets?: boolean;
  /** Integer micro-USD per 1,000,000 input tokens. */
  inputUsdMicroPerMillion: MicroUsdPerMillion;
  /** Integer micro-USD per 1,000,000 output tokens. */
  outputUsdMicroPerMillion: MicroUsdPerMillion;
  selection?: ChatSelectionOptions;
  /** Injectable for offline/loopback tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Persist the exact sanitized request synchronously BEFORE HTTP. */
  onRequest?: (record: DecisionRequestRecord) => void;
  /** Persist the exact sanitized response synchronously BEFORE returning. */
  onResponse?: (record: DecisionResponseRecord) => void;
}

export interface ChooseActionInput {
  observation: SeatObservation;
  publicChat?: readonly unknown[];
  signal?: AbortSignal;
}

export interface DecisionOutcome {
  action: ChosenAction;
  prompt: DecisionPrompt;
  request: DecisionRequestRecord;
  response: DecisionResponseRecord;
}

export class ProductDecisionProvider {
  private readonly baseUrl: string;
  private readonly baseUrlHost: string;
  private readonly model: string;
  private readonly apiKey: string | null;
  private readonly provider: string;
  private readonly timeoutMs: number;
  private readonly temperature: number;
  private readonly maxOutputTokens: number;
  private readonly inputPrice: MicroUsdPerMillion;
  private readonly outputPrice: MicroUsdPerMillion;
  private readonly selection: ChatSelectionOptions | undefined;
  private readonly knownSecrets: readonly string[];
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly onRequest: ((record: DecisionRequestRecord) => void) | null;
  private readonly onResponse: ((record: DecisionResponseRecord) => void) | null;

  constructor(config: DecisionProviderConfig) {
    if (!config || typeof config !== 'object') {
      throw new TypeError('ProductDecisionProvider requires a configuration object');
    }
    if (typeof config.baseUrl !== 'string' || config.baseUrl.trim() === '') {
      throw new TypeError('ProductDecisionProvider requires baseUrl');
    }
    if (typeof config.model !== 'string' || config.model.trim() === '') {
      throw new TypeError('ProductDecisionProvider requires model');
    }
    const baseUrlHost = validateBaseUrl(config.baseUrl);

    const timeoutMs = config.timeoutMs ?? DEFAULT_DECISION_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError(`timeoutMs must be a positive integer: ${String(timeoutMs)}`);
    }
    if (timeoutMs > 2_147_483_647) {
      throw new RangeError(`timeoutMs exceeds the platform timer range: ${String(timeoutMs)}`);
    }
    const temperature = config.temperature ?? 0;
    if (typeof temperature !== 'number' || !Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
      throw new RangeError(`temperature must be a finite number in [0, 2]: ${String(temperature)}`);
    }
    const maxOutputTokens = config.maxOutputTokens ?? 256;
    if (!Number.isInteger(maxOutputTokens) || maxOutputTokens <= 0) {
      throw new RangeError(`maxOutputTokens must be a positive integer: ${String(maxOutputTokens)}`);
    }
    assertPrice(config.inputUsdMicroPerMillion, 'inputUsdMicroPerMillion');
    assertPrice(config.outputUsdMicroPerMillion, 'outputUsdMicroPerMillion');
    if (config.onRequest !== undefined && typeof config.onRequest !== 'function') {
      throw new TypeError('onRequest must be a function');
    }
    if (config.onResponse !== undefined && typeof config.onResponse !== 'function') {
      throw new TypeError('onResponse must be a function');
    }
    const doFetch = config.fetchImpl ?? globalThis.fetch;
    if (typeof doFetch !== 'function') throw new Error('global fetch is unavailable; pass fetchImpl');

    this.baseUrl = config.baseUrl;
    this.baseUrlHost = baseUrlHost;
    this.model = config.model;
    this.apiKey = config.apiKey ?? null;
    this.provider = config.provider ?? 'openai-compatible';
    this.timeoutMs = timeoutMs;
    this.temperature = temperature;
    this.maxOutputTokens = maxOutputTokens;
    this.inputPrice = config.inputUsdMicroPerMillion;
    this.outputPrice = config.outputUsdMicroPerMillion;
    this.selection = config.selection;
    // The configured provider key is an explicit policy source, never inferred
    // from env naming. Credential-named env values are additional by default.
    this.knownSecrets = resolveKnownSecrets({
      knownSecrets: [
        ...(config.apiKey ? [config.apiKey] : []),
        ...(config.knownSecrets ?? []),
      ],
      includeEnvSecrets: config.includeEnvSecrets ?? true,
    });
    this.fetchImpl = doFetch;
    this.now = config.now ?? (() => Date.now());
    this.onRequest = config.onRequest ?? null;
    this.onResponse = config.onResponse ?? null;
  }

  /** Build with the configured model, bounds and chat selection. */
  buildPrompt(observation: SeatObservation, publicChat?: readonly unknown[]): DecisionPrompt {
    return buildDecisionPrompt({
      observation,
      publicChat,
      model: this.model,
      maxOutputTokens: this.maxOutputTokens,
      temperature: this.temperature,
      selection: this.selection,
      knownSecrets: this.knownSecrets,
    });
  }

  async chooseAction(input: ChooseActionInput): Promise<DecisionOutcome> {
    const prompt = this.buildPrompt(input.observation, input.publicChat);
    return this.sendPrompt(prompt, input.signal ? { signal: input.signal } : {});
  }

  /**
   * Send one already-built prompt. Persists request, performs exactly one HTTP
   * exchange under a strict deadline, persists the response, then validates the
   * chosen action from the observed provider payload.
   */
  async sendPrompt(prompt: DecisionPrompt, options: { signal?: AbortSignal } = {}): Promise<DecisionOutcome> {
    if (prompt.model !== this.model) {
      throw new TypeError(`prompt model ${prompt.model} does not match provider model ${this.model}`);
    }

    const requestId = randomUUID();
    const startedAt = this.now();
    const requestJson = JSON.stringify(
      sanitizeSecretValue(prompt.body, { knownSecrets: this.knownSecrets }),
    );
    const requestBytes = Buffer.byteLength(requestJson, 'utf8');
    const request: DecisionRequestRecord = {
      requestId,
      provider: this.provider,
      model: this.model,
      baseUrlHost: this.baseUrlHost,
      promptVersion: prompt.promptVersion,
      promptHash: prompt.promptHash,
      observationHash: prompt.observationHash,
      requestJson,
      requestHash: createHash('sha256').update(requestJson).digest('hex'),
      requestBytes,
      startedAt,
    };

    // Exact sanitized request is persisted BEFORE any HTTP I/O. A throwing
    // callback fails closed: no provider call is made.
    this.onRequest?.(request);

    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const userSignal = options.signal;
    const signal = userSignal ? AbortSignal.any([userSignal, timeoutSignal]) : timeoutSignal;

    let status = 0;
    let ok = false;
    let responseJson: string | null = null;
    let responseBytes = 0;
    let rawResponseBytes = 0;
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    let errorCode: string | null = null;
    let action: ChosenAction | null = null;
    let thrown: Error | null = null;

    try {
      const response = await this.fetchImpl(this.completionsUrl(), {
        method: 'POST',
        headers: this.headers(),
        body: requestJson,
        signal,
      });
      status = response.status;
      ok = response.ok;
      // Stream with a hard cap: a hostile/huge body is cut off instead of
      // being buffered, and no truncated raw text is ever retained.
      const body = await readBoundedResponseBody(response, MAX_RESPONSE_BYTES);
      rawResponseBytes = body.bytes;
      if (body.exceeded) {
        const code = 'response_too_large' as const;
        errorCode = code;
        responseJson = JSON.stringify({ error: { code, maxBytes: MAX_RESPONSE_BYTES } });
        responseBytes = Buffer.byteLength(responseJson, 'utf8');
        throw new DecisionTransportError(
          code,
          `provider response exceeded ${MAX_RESPONSE_BYTES} bytes`,
          status,
        );
      }
      const payload = parseJson(body.text);
      responseJson = JSON.stringify(
        payload === null
          ? {
              // Sanitize BEFORE bounding: slicing first could retain a prefix
              // of a known secret that straddles the diagnostic cap.
              unparsed: sanitizeSecretText(body.text, {
                knownSecrets: this.knownSecrets,
              }).slice(0, MAX_UNPARSED_RESPONSE_CHARS),
            }
          : sanitizeSecretValue(payload, { knownSecrets: this.knownSecrets }),
      );
      responseBytes = Buffer.byteLength(responseJson, 'utf8');
      const usage = extractUsage(payload);
      inputTokens = usage.inputTokens;
      outputTokens = usage.outputTokens;
      if (!response.ok) {
        const code = httpErrorCode(status);
        errorCode = code;
        throw new DecisionTransportError(code, `provider responded ${status}`, status);
      }
      // Validate the raw provider payload first, then sanitize only the
      // optional speech: the chosen actionId/amount are never altered.
      const chosen = validateActionChoice(payload, prompt.actions);
      action =
        chosen.speech === null
          ? chosen
          : {
              ...chosen,
              speech: boundSanitizedSpeech(
                sanitizeSecretText(chosen.speech, { knownSecrets: this.knownSecrets }),
              ),
            };
    } catch (error) {
      if (error instanceof DecisionResponseError || error instanceof DecisionTransportError) {
        if (errorCode === null) errorCode = error.code;
        thrown = error;
      } else {
        const code = classifyTransportError(error, signal);
        errorCode = code;
        thrown = new DecisionTransportError(code, `provider request failed: ${code}`);
      }
    }

    const costUsdMicro = computeUsageCostUsdMicro({
      inputTokens,
      outputTokens,
      inputUsdMicroPerMillion: this.inputPrice,
      outputUsdMicroPerMillion: this.outputPrice,
    });
    const response: DecisionResponseRecord = {
      requestId,
      status,
      ok,
      responseJson,
      responseBytes,
      rawResponseBytes,
      inputTokens,
      outputTokens,
      costUsdMicro,
      errorCode,
      finishedAt: this.now(),
    };

    // Exact sanitized response is persisted BEFORE returning or throwing.
    // A throwing callback also fails closed instead of returning success.
    this.onResponse?.(response);

    if (thrown) throw thrown;
    return { action: action!, prompt, request, response };
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    return headers;
  }

  private completionsUrl(): string {
    const base = this.baseUrl.trim().replace(/\/+$/, '');
    return /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`;
  }
}

// ---------------------------------------------------------------------------
// Strict provider-response validation
// ---------------------------------------------------------------------------

const ALLOWED_RESPONSE_FIELDS: ReadonlySet<string> = new Set(['actionId', 'amount', 'speech']);
const IDENTITY_RESPONSE_FIELDS: ReadonlySet<string> = new Set([
  'playerId',
  'principalId',
  'seat',
  'actor',
  'agentId',
  'tableId',
  'handId',
  'turnId',
  'requestId',
  'expectedVersion',
  'version',
  'name',
  'id',
]);

function responseError(code: DecisionResponseErrorCode, message: string): DecisionResponseError {
  return new DecisionResponseError(code, message);
}

/**
 * Validate one OpenAI-compatible payload against the exact menu that was sent.
 *
 * Hard failures: unknown tool/action, multiple or missing calls, extra identity
 * or unknown fields, malformed arguments, invalid/out-of-bounds/missing amounts
 * for `requiresAmount: true`, and oversized speech.
 *
 * Normalization: for a chosen entry with `requiresAmount: false` the server
 * amount is exact and the explicit `actionId` is authoritative, so any supplied
 * `amount` (mismatched, equal or on a no-amount family) is deterministically
 * ignored, the server amount is resolved, and `normalization` records
 * `'amount_ignored'`. The `actionId`/`family` are never repaired. Whitespace-only
 * speech is treated as silence. The raw provider response is not rewritten.
 */
export function validateActionChoice(
  payload: unknown,
  actions: readonly DecisionActionOption[],
): ChosenAction {
  const choices = (payload as { choices?: unknown } | null | undefined)?.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw responseError('missing_choice', 'provider returned no choices');
  }
  const message = (choices[0] as { message?: unknown } | null | undefined)?.message;
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw responseError('invalid_provider_payload', 'first choice has no message object');
  }
  const messageRecord = message as Record<string, unknown>;
  if (messageRecord.function_call !== undefined && messageRecord.function_call !== null) {
    throw responseError('unknown_tool', 'legacy function_call is not an accepted decision tool');
  }
  const toolCalls = messageRecord.tool_calls;
  if (toolCalls === undefined || toolCalls === null) {
    throw responseError('missing_tool_call', `${DECISION_TOOL_NAME} was not called`);
  }
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    throw responseError('missing_tool_call', `${DECISION_TOOL_NAME} was not called`);
  }
  if (toolCalls.length > 1) {
    throw responseError('multiple_tool_calls', `expected exactly one tool call, got ${toolCalls.length}`);
  }
  const call = toolCalls[0] as { function?: { name?: unknown; arguments?: unknown } } | null;
  const fn = call?.function;
  if (!fn || fn.name !== DECISION_TOOL_NAME) {
    throw responseError('unknown_tool', `unknown tool: ${String(fn?.name)}`);
  }
  if (typeof fn.arguments !== 'string') {
    throw responseError('invalid_arguments', 'tool arguments must be a JSON string');
  }
  let parsedArguments: unknown;
  try {
    parsedArguments = JSON.parse(fn.arguments);
  } catch {
    throw responseError('invalid_arguments', 'tool arguments were not valid JSON');
  }
  if (!parsedArguments || typeof parsedArguments !== 'object' || Array.isArray(parsedArguments)) {
    throw responseError('invalid_arguments', 'tool arguments must be a JSON object');
  }
  const args = parsedArguments as Record<string, unknown>;
  for (const key of Object.keys(args)) {
    if (IDENTITY_RESPONSE_FIELDS.has(key)) {
      throw responseError('identity_field', `model response must not carry identity field: ${key}`);
    }
    if (!ALLOWED_RESPONSE_FIELDS.has(key)) {
      throw responseError('unknown_field', `model response has unknown field: ${key}`);
    }
  }

  const actionId = args.actionId;
  if (typeof actionId !== 'string' || actionId.length === 0) {
    throw responseError('unknown_action', 'actionId must be a non-empty string');
  }
  const option = actions.find((action) => action.actionId === actionId);
  if (!option) {
    throw responseError('unknown_action', `actionId is not in the supplied legal menu: ${actionId}`);
  }

  let amount: number | null = option.amount;
  let normalization: ChosenAction['normalization'] = null;
  const rawAmount = args.amount;
  const amountProvided = rawAmount !== undefined && rawAmount !== null;

  if (option.requiresAmount) {
    // Variable-size action: the model amount is the authoritative choice and
    // stays strictly validated.
    if (!amountProvided) {
      throw responseError('missing_amount', `action ${actionId} requires an integer amount`);
    }
    if (typeof rawAmount !== 'number' || !Number.isInteger(rawAmount) || !Number.isSafeInteger(rawAmount)) {
      throw responseError('invalid_amount', `amount must be a safe integer: ${String(rawAmount)}`);
    }
    const low = option.minAmount ?? 0;
    const high = option.maxAmount ?? Number.MAX_SAFE_INTEGER;
    if (rawAmount < low || rawAmount > high) {
      throw responseError(
        'amount_out_of_bounds',
        `amount ${rawAmount} is outside ${actionId} bounds [${low}, ${high}]`,
      );
    }
    amount = rawAmount;
  } else if (amountProvided) {
    // requiresAmount=false: the server already knows the exact amount and the
    // explicit actionId is authoritative. Whatever the model supplied cannot
    // alter the action, so it is ignored (even a mismatch or a no-amount
    // family) and the exact server amount is resolved.
    normalization = 'amount_ignored';
    amount = option.amount;
  }

  let speech: string | null = null;
  const rawSpeech = args.speech;
  if (rawSpeech !== undefined && rawSpeech !== null) {
    if (typeof rawSpeech !== 'string') {
      throw responseError('invalid_speech', `speech must be 1..${MAX_SPEECH_CHARS} code points`);
    }
    if (rawSpeech.trim().length === 0) {
      // Empty/whitespace-only speech is silence, not an invalid decision.
      speech = null;
    } else {
      if ([...rawSpeech].length > MAX_SPEECH_CHARS) {
        throw responseError('invalid_speech', `speech must be 1..${MAX_SPEECH_CHARS} code points`);
      }
      speech = rawSpeech;
    }
  }

  return { actionId, family: option.family, amount, speech, normalization };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertPrice(price: MicroUsdPerMillion, label: string): void {
  if (typeof price !== 'bigint') throw new TypeError(`${label} must be a bigint`);
  if (price < 0n) throw new RangeError(`${label} must be non-negative`);
}

/**
 * Parse and validate the provider base URL.
 *
 * Rejects embedded credentials, query strings and fragments, and requires
 * HTTPS except for loopback hosts (offline tests / local sidecars). Returns the
 * hostname for audit records without re-serializing secrets.
 */
function validateBaseUrl(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new TypeError('baseUrl must be an absolute URL');
  }
  if (url.username !== '' || url.password !== '') {
    throw new TypeError('baseUrl must not embed credentials');
  }
  if (url.search !== '') throw new TypeError('baseUrl must not carry a query string');
  if (url.hash !== '') throw new TypeError('baseUrl must not carry a fragment');
  const isLoopback =
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '[::1]' ||
    url.hostname === '::1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
    throw new TypeError('baseUrl must use HTTPS (http:// is allowed only for loopback)');
  }
  return url.hostname;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

interface BoundedBody {
  exceeded: boolean;
  /** Decoded body; empty when the cap was exceeded. */
  text: string;
  /** Raw bytes received before the cap stopped the read. */
  bytes: number;
}

/**
 * Read a response body with a hard byte cap. A declared oversized
 * `content-length` is refused before reading; otherwise the body is streamed
 * and cancelled as soon as the cap is crossed, so a hostile provider can never
 * force unbounded buffering.
 */
async function readBoundedResponseBody(response: Response, maxBytes: number): Promise<BoundedBody> {
  const declaredHeader = response.headers.get('content-length');
  if (declaredHeader !== null) {
    const declared = Number(declaredHeader);
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      return { exceeded: true, text: '', bytes: 0 };
    }
  }
  if (response.body === null) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) return { exceeded: true, text: '', bytes: buffer.byteLength };
    return { exceeded: false, text: buffer.toString('utf8'), bytes: buffer.byteLength };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { exceeded: true, text: '', bytes: total };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const buffer = Buffer.concat(chunks, total);
  return { exceeded: false, text: buffer.toString('utf8'), bytes: total };
}

/**
 * Keep sanitized speech inside the published bound. Redaction markers can be
 * longer than the secret they replace, so truncate by code points afterwards.
 */
function boundSanitizedSpeech(value: string): string | null {
  const bounded = [...value].slice(0, MAX_SPEECH_CHARS).join('');
  return bounded.length === 0 ? null : bounded;
}

interface ExtractedUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

/** Missing usage contributes nothing; malformed usage fails closed. */
export function extractUsage(payload: unknown): ExtractedUsage {
  const usage = (payload as { usage?: unknown } | null | undefined)?.usage;
  if (usage === undefined || usage === null) return { inputTokens: null, outputTokens: null };
  if (typeof usage !== 'object' || Array.isArray(usage)) {
    throw responseError('invalid_usage', 'usage must be an object');
  }
  const record = usage as Record<string, unknown>;
  return {
    inputTokens: readTokenCount(record.prompt_tokens ?? record.input_tokens, 'prompt_tokens'),
    outputTokens: readTokenCount(record.completion_tokens ?? record.output_tokens, 'completion_tokens'),
  };
}

function readTokenCount(value: unknown, name: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw responseError('invalid_usage', `${name} must be a non-negative integer`);
  }
  return value;
}

function classifyTransportError(error: unknown, combinedSignal: AbortSignal): DecisionTransportErrorCode {
  if (combinedSignal.aborted) {
    const reason = combinedSignal.reason as { name?: string } | undefined;
    return reason?.name === 'TimeoutError' ? 'timeout' : 'aborted';
  }
  return 'transport_error';
}

function httpErrorCode(status: number): DecisionTransportErrorCode {
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'provider_error';
  return 'http_error';
}
