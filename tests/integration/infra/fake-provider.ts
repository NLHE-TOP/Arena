/**
 * Loopback OpenAI-compatible provider for acceptance runs. It never reaches a
 * paid model: it parses the exact decision request, chooses an action from the
 * supplied canonical legal menu (varied across families), and returns a valid
 * `choose_action` tool call. Every exchange is captured for the request
 * inspector; no request means no capture and no cost.
 *
 * Modes exercise failure and timeout behavior:
 * - `varied`: rotate legal families deterministically.
 * - `fold`: always fold when legal.
 * - `stall`: hold responses (stale-timeout path) until released or aborted.
 * - `invalid`: return an actionId outside the menu.
 * - `error`: return HTTP 500.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { freePort } from './proc.js';

export type FakeProviderMode = 'varied' | 'fold' | 'stall' | 'invalid' | 'error';

export interface FakeProviderRequestRecord {
  index: number;
  method: string;
  path: string;
  authorization: string | null;
  body: unknown;
  rawBody: string;
  receivedAt: number;
  responded: boolean;
}

export interface FakeProviderOptions {
  mode?: FakeProviderMode;
  model?: string;
  /** Artificial per-response latency, used to exercise deadlines. */
  latencyMs?: number;
  /** Include one short speech utterance every Nth response. */
  speechEvery?: number;
  /**
   * Per-table intro window: requests below this index rotate families/sizings
   * (family audit); at/after it the provider plays aggressively (max BET/RAISE,
   * else CALL/CHECK/FOLD) so rooms complete in a few hands.
   */
  aggressiveAfter?: number;
  onRequest?: (record: FakeProviderRequestRecord) => void;
}

export interface FakeProviderHandle {
  /** OpenAI-compatible base URL, e.g. http://127.0.0.1:1234/v1 */
  baseUrl: string;
  port: number;
  requests: FakeProviderRequestRecord[];
  requestCount: () => number;
  /** Exact per-table attribution parsed from each captured observation. */
  requestCountForTable: (tableId: string) => number;
  /** Exact per-turn attribution for restart/replay invariants. */
  requestCountForTurn: (tableId: string, turnId: string) => number;
  responsibleRequests: () => FakeProviderRequestRecord[];
  setMode: (mode: FakeProviderMode) => void;
  getMode: () => FakeProviderMode;
  /** Stall the next `count` requests regardless of mode (bounded by caller). */
  stallRequests: (count: number) => void;
  releaseStalled: () => void;
  stop: () => Promise<void>;
}

interface DecisionAction {
  actionId: string;
  family: string;
  minAmount?: number | null;
  maxAmount?: number | null;
  amount?: number | null;
  requiresAmount?: boolean;
}

interface ParsedDecisionRequest {
  model: string;
  actions: DecisionAction[];
  toolName: string;
  observation: unknown;
}

const ALLOWED_BODY_KEYS = new Set(['max_tokens', 'messages', 'model', 'temperature', 'tool_choice', 'tools']);

export function parseDecisionRequest(body: unknown): ParsedDecisionRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error('decision request body must be an object');
  }
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ALLOWED_BODY_KEYS.has(key)) throw new Error(`unexpected decision request field: ${key}`);
  }
  if (typeof record.model !== 'string' || record.model.length === 0) {
    throw new Error('decision request model is required');
  }
  const messages = record.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('decision request messages are required');
  }
  const tools = record.tools;
  if (!Array.isArray(tools) || tools.length !== 1) throw new Error('decision request must carry exactly one tool');
  const fn = (tools[0] as { function?: { name?: unknown } } | undefined)?.function;
  if (fn?.name !== 'choose_action') throw new Error(`unexpected decision tool: ${String(fn?.name)}`);

  let decisionPayload: Record<string, unknown> | null = null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: unknown; content?: unknown };
    if (message.role !== 'user' || typeof message.content !== 'string') continue;
    try {
      const parsed = JSON.parse(message.content) as Record<string, unknown>;
      if (Array.isArray(parsed.allowedActions)) {
        decisionPayload = parsed;
        break;
      }
    } catch {
      // Not the JSON decision payload (e.g. untrusted chat); keep searching.
    }
  }
  if (!decisionPayload) throw new Error('decision request has no allowedActions payload');
  const actions = decisionPayload.allowedActions as DecisionAction[];
  if (actions.length === 0) throw new Error('decision request legal menu is empty');
  for (const action of actions) {
    if (typeof action.actionId !== 'string' || typeof action.family !== 'string') {
      throw new Error('decision request legal menu entry is malformed');
    }
  }
  return {
    model: record.model,
    actions,
    toolName: fn.name,
    observation: decisionPayload.observation,
  };
}

/** Deterministic action selection over the exact menu the product supplied. */
export function chooseAction(
  request: ParsedDecisionRequest,
  index: number,
  mode: FakeProviderMode,
  aggressive = false
): { actionId: string; amount?: number; speech?: string } {
  const { actions } = request;
  let action: DecisionAction;
  if (aggressive) {
    action =
      actions.find((candidate) => candidate.family === 'RAISE' && candidate.maxAmount !== undefined) ??
      actions.find((candidate) => candidate.family === 'BET' && candidate.maxAmount !== undefined) ??
      actions.find((candidate) => candidate.family === 'CALL') ??
      actions.find((candidate) => candidate.family === 'CHECK') ??
      actions.find((candidate) => candidate.family === 'FOLD') ??
      actions[index % actions.length]!;
  } else if (mode === 'fold') {
    action = actions.find((candidate) => candidate.family === 'FOLD') ?? actions[index % actions.length]!;
  } else {
    action = actions[index % actions.length]!;
  }

  if (mode === 'invalid') return { actionId: `${action.actionId}-not-in-menu` };

  const choice: { actionId: string; amount?: number; speech?: string } = { actionId: action.actionId };
  const requiresAmount =
    action.requiresAmount ??
    ((action.family === 'BET' || action.family === 'RAISE') && action.amount === undefined);
  if (requiresAmount) {
    const low = action.minAmount ?? 1;
    const high = action.maxAmount ?? low;
    if (!Number.isInteger(low) || !Number.isInteger(high) || high < low) {
      throw new Error(`malformed amount bounds for ${action.actionId}: [${String(low)}, ${String(high)}]`);
    }
    const span = high - low;
    // Aggressive policy takes the maximum legal amount (all-in when offered);
    // the bounded intro deterministically picks a strictly-between sizing so
    // the family/sizing audit sees varied amounts, never just min or max.
    choice.amount = aggressive ? high : span >= 2 ? low + 1 + (index % (span - 1)) : low;
  }
  return choice;
}

function buildCompletion(
  request: ParsedDecisionRequest,
  index: number,
  mode: FakeProviderMode,
  speechEvery: number,
  aggressive: boolean
): Record<string, unknown> {
  const chosen = chooseAction(request, index, mode, aggressive);
  const args: Record<string, unknown> = { actionId: chosen.actionId };
  if (chosen.amount !== undefined) args.amount = chosen.amount;
  if (speechEvery > 0 && index % speechEvery === speechEvery - 1) args.speech = `fake-table-speech-${index}`;
  return {
    id: `chatcmpl-it-${index}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: request.model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: `call-it-${index}`,
              type: 'function',
              function: { name: request.toolName, arguments: JSON.stringify(args) },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 128 + index, completion_tokens: 24 + (index % 7), total_tokens: 152 + index },
  };
}

export async function startFakeProvider(options: FakeProviderOptions = {}): Promise<FakeProviderHandle> {
  const port = await freePort();
  const requests: FakeProviderRequestRecord[] = [];
  let mode: FakeProviderMode = options.mode ?? 'varied';
  let stallRemaining = 0;
  const stalled: Array<() => void> = [];
  const tableCounts = new Map<string, number>();
  const aggressiveAfter = options.aggressiveAfter ?? 12;

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      void (async () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        let body: unknown = null;
        try {
          body = rawBody === '' ? null : JSON.parse(rawBody);
        } catch {
          body = null;
        }
        const record: FakeProviderRequestRecord = {
          index: requests.length,
          method: request.method ?? 'POST',
          path: request.url ?? '/',
          authorization: request.headers.authorization ?? null,
          body,
          rawBody,
          receivedAt: Date.now(),
          responded: false,
        };
        requests.push(record);
        options.onRequest?.(record);

        const send = (status: number, payload: unknown) => {
          record.responded = true;
          response.writeHead(status, { 'content-type': 'application/json' });
          response.end(JSON.stringify(payload));
        };

        try {
          const shouldStall = mode === 'stall' || stallRemaining > 0;
          if (stallRemaining > 0) stallRemaining -= 1;
          if (shouldStall) {
            await new Promise<void>((resolve) => {
              stalled.push(resolve);
              request.on('close', resolve);
            });
            if (request.destroyed) return;
          }

          const parsed = parseDecisionRequest(body);
          if (options.latencyMs) await new Promise((resolve) => setTimeout(resolve, options.latencyMs));
          if (mode === 'error') {
            send(500, { error: { message: 'fake provider forced error', type: 'server_error' } });
            return;
          }
          const tableId = (parsed.observation as { tableId?: unknown } | null)?.tableId;
          const tableKey = typeof tableId === 'string' ? tableId : `request-${record.index}`;
          const perTableIndex = tableCounts.get(tableKey) ?? 0;
          tableCounts.set(tableKey, perTableIndex + 1);
          const aggressive = mode !== 'invalid' && perTableIndex >= aggressiveAfter;
          send(200, buildCompletion(parsed, perTableIndex, mode, options.speechEvery ?? 3, aggressive));
        } catch (error) {
          send(500, {
            error: {
              message: error instanceof Error ? error.message : 'fake provider could not parse the request',
              type: 'invalid_request_error',
            },
          });
        }
      })();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    port,
    requests,
    requestCount: () => requests.length,
    requestCountForTable: (tableId) => {
      let count = 0;
      for (const record of requests) {
        try {
          const parsed = parseDecisionRequest(record.body) as { observation?: { tableId?: unknown } };
          if (parsed.observation?.tableId === tableId) count += 1;
        } catch {
          // Malformed captures are reported by the exactness assertions.
        }
      }
      return count;
    },
    requestCountForTurn: (tableId, turnId) => {
      let count = 0;
      for (const record of requests) {
        try {
          const parsed = parseDecisionRequest(record.body) as {
            observation?: { tableId?: unknown; turnId?: unknown };
          };
          if (parsed.observation?.tableId === tableId && parsed.observation.turnId === turnId) count += 1;
        } catch {
          // Malformed captures are reported by the exactness assertions.
        }
      }
      return count;
    },
    responsibleRequests: () => requests.filter((record) => record.responded),
    setMode: (next) => {
      mode = next;
    },
    getMode: () => mode,
    stallRequests: (count) => {
      stallRemaining = Math.max(0, Math.trunc(count));
    },
    releaseStalled: () => {
      for (const resolve of stalled.splice(0)) resolve();
    },
    stop: async () => {
      for (const resolve of stalled.splice(0)) resolve();
      await new Promise<void>((resolve) => (server.close(() => resolve()), server.closeAllConnections()));
    },
  };
}

export interface ProviderRequestAssertions {
  minimumCount?: number;
  expectZero?: boolean;
}

/**
 * Structural exactness of every captured request: only reviewed top-level
 * fields, exactly one `choose_action` tool, and a parseable legal-menu
 * observation payload. Deeper independent inspection is provided by
 * `src/audit/decision-request-inspector.ts` when the product build is present.
 */
export function assertProviderRequestsExact(handle: FakeProviderHandle, assertions: ProviderRequestAssertions = {}): void {
  const requests = handle.requests;
  if (assertions.expectZero && requests.length !== 0) {
    throw new Error(`expected zero provider requests, saw ${requests.length}`);
  }
  if (assertions.minimumCount !== undefined && requests.length < assertions.minimumCount) {
    throw new Error(`expected at least ${assertions.minimumCount} provider requests, saw ${requests.length}`);
  }
  for (const record of requests) {
    const parsed = parseDecisionRequest(record.body);
    if (parsed.actions.length === 0) throw new Error(`request ${record.index} carried an empty legal menu`);
  }
}
