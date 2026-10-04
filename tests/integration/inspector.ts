/**
 * Adapter around the product-owned independent request inspector.
 *
 * The inspector implementation lives with the product (`src/audit/`); this
 * adapter only supplies the ACTUAL persisted request bytes, the canonical
 * `SeatObservation` fetched from the platform authority, and the record header
 * persisted alongside the request. It never rebuilds a prompt, so a prompt
 * builder regression cannot satisfy its own oracle.
 */
import type { SeatObservation } from '@pokertools/types';

export interface PersistedDecisionRequest {
  /** Exact sanitized request body the provider persisted before HTTP. */
  requestJson: string;
  model: string;
  promptVersion: string;
  promptHash: string;
  observationHash: string;
  temperature?: number;
  maxOutputTokens?: number;
}

export interface InspectionInput {
  record: PersistedDecisionRequest;
  observation: SeatObservation;
  publicChat?: readonly unknown[];
  selection?: { maxMessages?: number; maxBytes?: number };
}

export interface InspectionOutcome {
  ok: boolean;
  checks: string[];
  error?: string;
}

interface InspectorModule {
  inspectDecisionRequest: (input: {
    request: unknown;
    record: {
      model: string;
      promptVersion: string;
      promptHash: string;
      observationHash: string;
      temperature?: number;
      maxOutputTokens?: number;
    };
    observation: SeatObservation;
    publicChat?: readonly unknown[];
    selection?: { maxMessages?: number; maxBytes?: number };
  }) => { ok: true; checks: string[] };
}

export async function loadProductInspector(): Promise<InspectorModule | null> {
  try {
    return (await import('../../src/audit/decision-request-inspector.js')) as unknown as InspectorModule;
  } catch {
    return null;
  }
}

export async function inspectPersistedDecision(input: InspectionInput): Promise<InspectionOutcome> {
  const inspector = await loadProductInspector();
  if (!inspector) {
    return { ok: false, checks: [], error: 'product inspector is not importable yet' };
  }
  try {
    const report = inspector.inspectDecisionRequest({
      request: JSON.parse(input.record.requestJson) as unknown,
      record: {
        model: input.record.model,
        promptVersion: input.record.promptVersion,
        promptHash: input.record.promptHash,
        observationHash: input.record.observationHash,
        ...(input.record.temperature !== undefined ? { temperature: input.record.temperature } : {}),
        ...(input.record.maxOutputTokens !== undefined ? { maxOutputTokens: input.record.maxOutputTokens } : {}),
      },
      observation: input.observation,
      ...(input.publicChat !== undefined ? { publicChat: input.publicChat } : {}),
      ...(input.selection !== undefined ? { selection: input.selection } : {}),
    });
    return { ok: report.ok === true, checks: report.checks };
  } catch (error) {
    return {
      ok: false,
      checks: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Match a captured provider request to its canonical observation by turn id. */
export function turnIdFromCapturedRequest(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: unknown; content?: unknown };
    if (message.role !== 'user' || typeof message.content !== 'string') continue;
    try {
      const payload = JSON.parse(message.content) as { observation?: { turnId?: unknown } };
      if (typeof payload.observation?.turnId === 'string') return payload.observation.turnId;
    } catch {
      // Not the decision payload.
    }
  }
  return null;
}
