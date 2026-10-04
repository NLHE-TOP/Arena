/**
 * Independent inspector for a recorded canonical seat-decision request.
 *
 * It parses the ACTUAL persisted request body and verifies it against allowed
 * canonical sources (`SeatObservation` plus current-hand public chat) without
 * calling the prompt builder. Prompt hashing, chat selection and legal-menu
 * derivation are deliberately re-implemented here so a builder regression
 * cannot satisfy the oracle by construction.
 *
 * Checks:
 * - exact body/message/tool structure: only the reviewed top-level fields, one
 *   system message, an optional separate untrusted-chat user payload, one
 *   decision user payload, and no extra message fields;
 * - system instructions and prompt version are byte-exact;
 * - the embedded observation deep-equals the schema-validated canonical source,
 *   and the observation hash recomputes from that source;
 * - the allowed-action menu and family-sizing summary deep-equal an independent
 *   derivation from `observation.legalActions`, in canonical order;
 * - selected chat deep-equals an independent current-hand `eventSeq <= bound`
 *   bounded selection, in ascending order, with matching selection metadata;
 * - the prompt content hash recomputes from the recorded messages and actions;
 * - no sensitive keys, token shapes, provider telemetry, foreign traces or
 *   reasoning fields appear anywhere in the request.
 *
 * Secret policy is explicit and deterministic: `knownSecrets` is supplied by
 * the caller (the configured provider key belongs there) and env discovery is
 * never implicit, so inspection does not depend on machine environment.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  ChatMessageSchema,
  type ChatMessage,
  SeatObservationSchema,
  type LegalAction,
  type LegalActionFamily,
  type SeatObservation,
} from '@pokertools/types';
import { sanitizeSecretText, sanitizeSecretValue } from '../security/sanitize.js';
import {
  DECISION_AMOUNT_PARAMETER_DESCRIPTION,
  DECISION_INSTRUCTIONS,
  DECISION_OBJECTIVE,
  DECISION_PROMPT_VERSION,
  DECISION_TOOL_DESCRIPTION,
  DECISION_TOOL_NAME,
  DECISION_UNTRUSTED_CHAT_NOTICE,
} from '../llm/decision-prompt.js';

const DEFAULT_MAX_CHAT_MESSAGES = 16;
const DEFAULT_MAX_CHAT_BYTES = 4096;

const BODY_KEYS = ['max_tokens', 'messages', 'model', 'temperature', 'tool_choice', 'tools'];
const DECISION_PAYLOAD_KEYS = ['allowedActions', 'families', 'objective', 'observation', 'response'];
const CHAT_PAYLOAD_KEYS = ['messages', 'notice', 'selection'];

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  'reasoning',
  'reasoning_content',
  'chain_of_thought',
  'chainOfThought',
  'thoughts',
  'provider',
  'provider_request_id',
  'rawResponse',
  'raw_response',
  'response_json',
  'request_json',
  'apiKey',
  'api_key',
  'authorization',
  'cookie',
  'secret',
  'system_prompt',
  'systemPrompt',
]);

const PublicChatEntrySchema = ChatMessageSchema;
type SelectedChatEntry = ChatMessage;

interface SelectionMetadata {
  tableId: string;
  handId: string;
  eventSeq: number;
  considered: number;
  selected: number;
  dropped: number;
  excludedForeignTable: number;
  excludedForeignHand: number;
  excludedAfterEventSeq: number;
  excludedDuplicateEventSeq: number;
  droppedByCount: number;
  droppedByBytes: number;
  maxMessages: number;
  maxBytes: number;
  selectedBytes: number;
  firstEventSeq: number | null;
  lastEventSeq: number | null;
  ordering: 'eventSeq:asc';
  untrusted: true;
}

export interface InspectionRecordHeader {
  requestHash?: string;
  model: string;
  promptVersion: string;
  promptHash: string;
  observationHash: string;
  temperature?: number;
  maxOutputTokens?: number;
}

export interface InspectDecisionRequestInput {
  /** Parsed ACTUAL recorded request body. */
  request: unknown;
  /** Header fields persisted alongside the request, including its hashes. */
  record: InspectionRecordHeader;
  /** Canonical source observation the request must describe. */
  observation: SeatObservation;
  /** Canonical current-hand public chat source. */
  publicChat?: readonly unknown[];
  /** Bounds used when the prompt was built. */
  selection?: { maxMessages?: number; maxBytes?: number };
  /**
   * Explicit exact secret values scrubbed by the boundary policy (e.g. the
   * configured provider key). No env discovery happens here, so inspection is
   * deterministic; callers that used env-backed policy pass those values.
   */
  knownSecrets?: readonly string[];
}

export interface DecisionRequestInspectionReport {
  ok: true;
  promptVersion: string;
  promptHash: string;
  observationHash: string;
  messageCount: number;
  chatSelectedEventSeqs: number[];
  actionIds: string[];
  checks: string[];
}

// ---------------------------------------------------------------------------
// Independent primitives (duplicated on purpose; no builder imports)
// ---------------------------------------------------------------------------

function stableJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) sorted[key] = sortJsonValue(source[key]);
    return sorted;
  }
  return value;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function resolveChatBounds(selection: InspectDecisionRequestInput['selection']): {
  maxMessages: number;
  maxBytes: number;
} {
  const maxMessages = selection?.maxMessages ?? DEFAULT_MAX_CHAT_MESSAGES;
  const maxBytes = selection?.maxBytes ?? DEFAULT_MAX_CHAT_BYTES;
  assert.ok(Number.isInteger(maxMessages) && maxMessages >= 0, 'maxMessages must be a non-negative integer');
  assert.ok(Number.isInteger(maxBytes) && maxBytes >= 0, 'maxBytes must be a non-negative integer');
  return { maxMessages, maxBytes };
}

/** Independent copy of the documented entry-wide boundary redaction. */
function sanitizeChatEntryIndependently(
  entry: SelectedChatEntry,
  knownSecrets: readonly string[],
): SelectedChatEntry {
  return {
    messageId: sanitizeSecretText(entry.messageId, { knownSecrets }),
    tableId: sanitizeSecretText(entry.tableId, { knownSecrets }),
    handId: sanitizeSecretText(entry.handId, { knownSecrets }),
    eventSeq: entry.eventSeq,
    principalId: sanitizeSecretText(entry.principalId, { knownSecrets }),
    body: sanitizeSecretText(entry.body, { knownSecrets }),
    sentAt: entry.sentAt,
  };
}

/** Independent copy of the documented selection algorithm. */
function selectChatIndependently(
  observation: SeatObservation,
  publicChat: readonly unknown[] | undefined,
  selection: InspectDecisionRequestInput['selection'],
  knownSecrets: readonly string[],
): { entries: SelectedChatEntry[]; metadata: SelectionMetadata } {
  const { maxMessages, maxBytes } = resolveChatBounds(selection);
  const candidates: SelectedChatEntry[] = [];
  for (const raw of publicChat ?? []) {
    const parsed = PublicChatEntrySchema.safeParse(raw);
    assert.ok(parsed.success, `canonical chat source failed validation: ${parsed.error?.issues[0]?.message ?? 'unknown'}`);
    // The whole entry is redacted before eligibility so the independent
    // expectation covers exactly the bytes the builder hashed and sent.
    candidates.push(sanitizeChatEntryIndependently(parsed.data, knownSecrets));
  }
  let excludedForeignTable = 0;
  let excludedForeignHand = 0;
  let excludedAfterEventSeq = 0;
  const eligible = candidates.filter((entry) => {
    if (entry.tableId !== observation.tableId) { excludedForeignTable += 1; return false; }
    if (entry.handId !== observation.handId) { excludedForeignHand += 1; return false; }
    if (entry.eventSeq > observation.eventSeq) { excludedAfterEventSeq += 1; return false; }
    return true;
  });
  eligible.sort((a, b) => a.eventSeq - b.eventSeq || a.messageId.localeCompare(b.messageId));
  let excludedDuplicateEventSeq = 0;
  const unique: SelectedChatEntry[] = [];
  for (const entry of eligible) {
    if (unique.length > 0 && unique[unique.length - 1]!.eventSeq === entry.eventSeq) {
      excludedDuplicateEventSeq += 1;
      continue;
    }
    unique.push(entry);
  }
  const countBounded = maxMessages === 0 ? [] : unique.slice(-maxMessages);
  const droppedByCount = unique.length - countBounded.length;
  let droppedByBytes = 0;
  // Entries are already boundary-sanitized end to end.
  let kept = countBounded;
  while (kept.length > 0 && Buffer.byteLength(JSON.stringify(kept), 'utf8') > maxBytes) {
    kept = kept.slice(1);
    droppedByBytes += 1;
  }
  const metadata: SelectionMetadata = {
    tableId: observation.tableId,
    handId: observation.handId,
    eventSeq: observation.eventSeq,
    considered: candidates.length,
    selected: kept.length,
    dropped: droppedByCount + droppedByBytes,
    excludedForeignTable,
    excludedForeignHand,
    excludedAfterEventSeq,
    excludedDuplicateEventSeq,
    droppedByCount,
    droppedByBytes,
    maxMessages,
    maxBytes,
    selectedBytes: Buffer.byteLength(JSON.stringify(kept), 'utf8'),
    firstEventSeq: kept[0]?.eventSeq ?? null,
    lastEventSeq: kept[kept.length - 1]?.eventSeq ?? null,
    ordering: 'eventSeq:asc',
    untrusted: true,
  };
  return { entries: kept, metadata };
}

/** Independent menu derivation from the canonical legal actions. */
function deriveMenuIndependently(observation: SeatObservation): {
  actions: Array<{
    actionId: string;
    family: LegalActionFamily;
    minAmount: number | null;
    maxAmount: number | null;
    amount: number | null;
    requiresAmount: boolean;
  }>;
  families: Array<{
    family: LegalActionFamily;
    actionIds: string[];
    minAmount: number | null;
    maxAmount: number | null;
  }>;
  parameters: Record<string, unknown>;
} {
  const actions = observation.legalActions.map((action: LegalAction) => ({
    actionId: action.actionId,
    family: action.family,
    minAmount: action.minAmount ?? null,
    maxAmount: action.maxAmount ?? null,
    amount: action.amount ?? null,
    requiresAmount:
      (action.family === 'BET' || action.family === 'RAISE') && action.amount === undefined,
  }));
  const families: Array<{
    family: LegalActionFamily;
    actionIds: string[];
    minAmount: number | null;
    maxAmount: number | null;
  }> = [];
  for (const action of actions) {
    let group = families.find((family) => family.family === action.family);
    if (!group) {
      group = { family: action.family, actionIds: [], minAmount: null, maxAmount: null };
      families.push(group);
    }
    group.actionIds.push(action.actionId);
    const low = action.minAmount ?? action.amount;
    const high = action.maxAmount ?? action.amount;
    if (low !== null) group.minAmount = group.minAmount === null ? low : Math.min(group.minAmount, low);
    if (high !== null) group.maxAmount = group.maxAmount === null ? high : Math.max(group.maxAmount, high);
  }
  const lowerBounds = actions
    .map((action) => action.minAmount)
    .filter((value): value is number => value !== null);
  const upperBounds = actions
    .map((action) => action.maxAmount ?? action.amount)
    .filter((value): value is number => value !== null);
  const parameters: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
    required: ['actionId'],
    properties: {
      actionId: {
        type: 'string',
        enum: actions.map((action) => action.actionId),
        description: 'Exact actionId from the allowed action menu.',
      },
      amount: {
        type: 'integer',
        minimum: lowerBounds.length > 0 ? Math.min(...lowerBounds) : 0,
        maximum: upperBounds.length > 0 ? Math.max(...upperBounds) : Number.MAX_SAFE_INTEGER,
        description: DECISION_AMOUNT_PARAMETER_DESCRIPTION,
      },
      speech: {
        type: 'string',
        minLength: 1,
        maxLength: 280,
        description: 'Optional short public table utterance.',
      },
    },
  };
  return { actions, families, parameters };
}

function assertNoForbiddenKeys(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenKeys(item, `${path}[${index}]`));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      assert.ok(!FORBIDDEN_KEYS.has(key), `forbidden field in recorded request at ${path}.${key}`);
      assertNoForbiddenKeys(entry, `${path}.${key}`);
    }
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  return value as Record<string, unknown>;
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${label} has unexpected fields`);
}

// ---------------------------------------------------------------------------
// Inspection
// ---------------------------------------------------------------------------

export function inspectDecisionRequest(input: InspectDecisionRequestInput): DecisionRequestInspectionReport {
  const checks: string[] = [];
  const source = SeatObservationSchema.parse(input.observation);
  const expectedTemperature = input.record.temperature ?? 0;
  const expectedMaxOutputTokens = input.record.maxOutputTokens ?? 256;
  assert.equal(input.record.promptVersion, DECISION_PROMPT_VERSION, 'prompt version mismatch');
  checks.push('prompt_version');

  const request = asRecord(input.request, 'recorded request');
  if (input.record.requestHash !== undefined) {
    assert.equal(createHash('sha256').update(JSON.stringify(request)).digest('hex'),
      input.record.requestHash, 'request hash mismatch');
    checks.push('request_hash');
  }
  assertExactKeys(request, BODY_KEYS, 'recorded request');
  assert.equal(request.model, input.record.model, 'recorded model mismatch');
  assert.equal(request.temperature, expectedTemperature, 'recorded temperature mismatch');
  assert.equal(request.max_tokens, expectedMaxOutputTokens, 'recorded max_tokens mismatch');
  checks.push('request_header');

  // The request must already be boundary-sanitized: re-sanitizing it under the
  // explicit policy must be a no-op, and no reviewed telemetry/reasoning/
  // credential field may exist.
  const knownSecrets = input.knownSecrets ?? [];
  assert.deepEqual(
    sanitizeSecretValue(request, { knownSecrets }),
    request,
    'recorded request is not sanitized',
  );
  assertNoForbiddenKeys(request, 'request');
  checks.push('sanitized_and_no_telemetry');

  const messages = request.messages;
  assert.ok(Array.isArray(messages), 'messages must be an array');
  assert.ok(messages.length === 2 || messages.length === 3, 'expected 2 or 3 messages');
  const parsedMessages = messages.map((message, index) => {
    const record = asRecord(message, `messages[${index}]`);
    assertExactKeys(record, ['role', 'content'], `messages[${index}]`);
    assert.ok(record.role === 'system' || record.role === 'user', `messages[${index}].role invalid`);
    assert.equal(typeof record.content, 'string', `messages[${index}].content must be a string`);
    return { role: record.role as 'system' | 'user', content: record.content as string };
  });
  assert.equal(parsedMessages[0]!.role, 'system', 'first message must be the system instructions');
  for (const message of parsedMessages.slice(1)) {
    assert.equal(message.role, 'user', 'all non-system messages must be user payloads');
  }
  const expectedSystem = `${DECISION_INSTRUCTIONS} Prompt-Version: ${DECISION_PROMPT_VERSION}.`;
  assert.equal(parsedMessages[0]!.content, expectedSystem, 'system instructions mismatch');
  checks.push('message_roles_and_system');

  const selection = selectChatIndependently(
    source,
    input.publicChat,
    input.selection,
    knownSecrets,
  );
  if (selection.entries.length > 0) {
    assert.equal(parsedMessages.length, 3, 'chat present as a separate untrusted user payload');
    const chatPayload = asRecord(JSON.parse(parsedMessages[1]!.content), 'chat payload');
    assertExactKeys(chatPayload, CHAT_PAYLOAD_KEYS, 'chat payload');
    assert.equal(chatPayload.notice, DECISION_UNTRUSTED_CHAT_NOTICE, 'untrusted chat notice mismatch');
    assert.deepEqual(chatPayload.selection, selection.metadata, 'chat selection metadata mismatch');
    assert.deepEqual(chatPayload.messages, selection.entries, 'selected chat differs from canonical source');
    for (const entry of selection.entries) {
      assert.ok(entry.handId === source.handId && entry.tableId === source.tableId, 'foreign chat entry');
      assert.ok(entry.eventSeq <= source.eventSeq, 'future chat entry');
    }
  } else {
    assert.equal(parsedMessages.length, 2, 'no eligible chat must yield no chat payload');
  }
  checks.push('chat_selection');

  const decisionPayload = asRecord(
    JSON.parse(parsedMessages[parsedMessages.length - 1]!.content),
    'decision payload',
  );
  assertExactKeys(decisionPayload, DECISION_PAYLOAD_KEYS, 'decision payload');
  assert.equal(decisionPayload.objective, DECISION_OBJECTIVE, 'decision objective mismatch');
  const actualObservation = asRecord(decisionPayload.observation, 'decision observation');
  assert.deepEqual(actualObservation, source, 'recorded observation differs from canonical source');
  assert.deepEqual(decisionPayload.response, {
    tool: DECISION_TOOL_NAME,
    required: ['actionId'],
    optional: ['amount', 'speech'],
  }, 'recorded response contract mismatch');
  checks.push('observation_and_response_contract');

  const menu = deriveMenuIndependently(source);
  const actualActions = decisionPayload.allowedActions;
  assert.ok(Array.isArray(actualActions), 'allowedActions must be an array');
  assert.deepEqual(actualActions, menu.actions, 'recorded action menu differs from canonical legal actions');
  assert.deepEqual(decisionPayload.families, menu.families, 'recorded family sizing differs from canonical legal actions');
  checks.push('legal_menu_order');

  const tools = request.tools;
  assert.ok(Array.isArray(tools) && tools.length === 1, 'expected exactly one tool definition');
  const tool = asRecord(tools[0], 'tools[0]');
  assertExactKeys(tool, ['type', 'function'], 'tools[0]');
  assert.equal(tool.type, 'function', 'tool type must be function');
  const toolFunction = asRecord(tool.function, 'tools[0].function');
  assertExactKeys(toolFunction, ['name', 'description', 'parameters'], 'tools[0].function');
  assert.equal(toolFunction.name, DECISION_TOOL_NAME, 'tool name mismatch');
  assert.equal(toolFunction.description, DECISION_TOOL_DESCRIPTION, 'tool description mismatch');
  assert.deepEqual(toolFunction.parameters, menu.parameters, 'tool parameters differ from canonical legal menu');
  assert.deepEqual(request.tool_choice, {
    type: 'function',
    function: { name: DECISION_TOOL_NAME },
  }, 'tool_choice must force choose_action');
  checks.push('tool_contract');

  const observationHash = sha256Hex(stableJson(source));
  assert.equal(observationHash, input.record.observationHash, 'observation hash mismatch');
  const promptHash = sha256Hex(stableJson({
    promptVersion: input.record.promptVersion,
    messages: parsedMessages.map((message) => ({ role: message.role, content: message.content })),
    actions: actualActions,
  }));
  assert.equal(promptHash, input.record.promptHash, 'prompt content hash mismatch');
  checks.push('content_hashes');

  return {
    ok: true,
    promptVersion: input.record.promptVersion,
    promptHash: input.record.promptHash,
    observationHash: input.record.observationHash,
    messageCount: parsedMessages.length,
    chatSelectedEventSeqs: selection.entries.map((entry) => entry.eventSeq),
    actionIds: menu.actions.map((action) => action.actionId),
    checks,
  };
}
