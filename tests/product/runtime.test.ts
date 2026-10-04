/**
 * AgentRuntime unit tests.
 *
 * Transport is a programmable in-memory fake; durability is an in-memory
 * implementation of the narrow `AgentDecisionStorePort` that mirrors the
 * `ProductStore` CAS semantics (decision id, attempt rows, reservations).
 * Restart tests construct a second runtime over the same store to prove that
 * durable lifecycle states resume correctly. One integration-shaped test runs
 * the real `ProductDecisionProvider` over the loopback HTTP fake.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Config } from '../../src/config.js';
import { SdkRoomRuntime, type RoomRuntimeDependencies } from '../../src/agents/rooms.js';
import {
  CanonicalActionResultSchema,
  SeatObservationSchema,
  type CanonicalActionRequest,
  type CanonicalActionResult,
  type ChatMessage,
  type LegalAction,
  type SeatObservation,
} from '@pokertools/types';
import {
  AgentAuthorityError,
  AgentRuntime,
  DecisionConcurrencyLimiter,
  classifyActionFailure,
  createProductDecisionProviderFactory,
  resolveCallBudgetMs,
  serializeDecisionRequest,
  type AgentAuditEvent,
  type AgentDecisionStorePort,
  type AgentRuntimeConfig,
  type AgentRuntimeDependencies,
  type AgentTurnTransport,
  type DecisionProviderCallContext,
  type DecisionProviderFactory,
  type DecisionProviderPort,
} from '../../src/agents/index.js';
import {
  buildDecisionPrompt,
  deriveDecisionMenu,
  type DecisionPrompt,
} from '../../src/llm/decision-prompt.js';
import type {
  DecisionRequestRecord,
  DecisionResponseRecord,
} from '../../src/llm/decision-provider.js';
import { seatPromptPolicy } from '../../src/llm/prompt-policy.js';
import {
  computeDecisionId,
  computeAttemptId,
  ProductStore,
  type AgentReservation,
  type AttemptRecordInput,
  type DecisionFilter,
  type ModelAttempt,
  type ObserveDecisionInput,
  type ProductDecision,
  type ProductRoom,
  type RoomReservationLimits,
  type StartAttemptResult,
} from '../../src/product/store.js';
import {
  normalizeAgentConfig,
  type AgentConfig,
} from '../../src/product/catalog.js';
import {
  computeObservationHash,
  parseDecisionSource,
  parseSeatObservation,
} from '../../src/product/observation.js';
import { sanitizeSecretValue } from '../../src/security/sanitize.js';
import {
  chatFixture,
  observationFixture,
  observationInput,
  TEST_TABLE_ID,
  TEST_TURN_ID,
  validActionArguments,
} from './fixtures.js';
import { startFakeProvider, toolCallResponse } from './fake-provider.js';

const PRINCIPAL = 'principal-agent';
const AGENT_ID = 'agent-1';
const AGENT_2_ID = 'agent-2';
const ROOM_ID = 'room-1';
const MODEL = 'fake-model';
const PROVIDER = 'fake-provider';

// ---------------------------------------------------------------------------
// In-memory durable store port
// ---------------------------------------------------------------------------

class FakeStoreError extends Error {
  constructor(readonly code: string, message = code) {
    super(message);
    this.name = 'FakeStoreError';
  }
}

class MemoryDecisionStore implements AgentDecisionStorePort {
  readonly decisions = new Map<string, ProductDecision>();
  readonly attempts = new Map<string, ModelAttempt[]>();
  readonly reservations = new Map<string, AgentReservation>();
  limits = {
    maxCallsPerRoom: 1_000_000,
    maxCostMicroUsdPerRoom: 1_000_000_000,
    maxCostMicroUsdPerCall: 100_000,
  };
  private readonly otherAgentLimits = new Map<
    string,
    { maxCallsPerRoom: number; maxCostMicroUsdPerRoom: number; maxCostMicroUsdPerCall: number }
  >();

  observeDecision(input: ObserveDecisionInput): ProductDecision {
    const observation = parseSeatObservation(input.observation);
    if (observation.tableId !== input.tableId || observation.turnId !== input.turnId) {
      throw new FakeStoreError('OBSERVATION_CONFLICT');
    }
    const id = computeDecisionId(input.tableId, input.turnId, input.principalId);
    const hash = computeObservationHash(observation);
    const existing = this.decisions.get(id);
    if (existing !== undefined) {
      if (
        existing.observationHash !== hash ||
        existing.promptPolicyId !== input.promptPolicyId ||
        existing.eventCursor !== input.eventCursor
      ) {
        throw new FakeStoreError('OBSERVATION_CONFLICT');
      }
      return existing;
    }
    const source =
      input.source === undefined || input.source === null
        ? null
        : parseDecisionSource(input.source);
    const now = Date.now();
    const decision: ProductDecision = {
      id,
      tableId: input.tableId,
      turnId: input.turnId,
      principalId: input.principalId,
      roomId: input.roomId ?? null,
      status: 'OBSERVED',
      observation,
      observationHash: hash,
      version: observation.version,
      promptPolicyId: input.promptPolicyId,
      eventCursor: input.eventCursor,
      source,
      requestJson: null,
      receiptJson: null,
      errorReason: null,
      attemptCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.decisions.set(id, decision);
    this.attempts.set(id, []);
    return decision;
  }

  getDecision(decisionId: string): ProductDecision | null {
    return this.decisions.get(decisionId) ?? null;
  }

  getDecisionForTurn(tableId: string, turnId: string, principalId: string): ProductDecision | null {
    return this.decisions.get(computeDecisionId(tableId, turnId, principalId)) ?? null;
  }

  listDecisions(filter: DecisionFilter = {}): ProductDecision[] {
    return [...this.decisions.values()].filter((decision) => {
      if (filter.tableId !== undefined && decision.tableId !== filter.tableId) return false;
      if (filter.roomId !== undefined && decision.roomId !== filter.roomId) return false;
      if (filter.principalId !== undefined && decision.principalId !== filter.principalId) return false;
      if (filter.status !== undefined && decision.status !== filter.status) return false;
      return true;
    });
  }

  startAttempt(
    decisionId: string,
    requestJson: string,
    requestMetadata?: unknown,
  ): StartAttemptResult {
    const decision = this.requireDecision(decisionId);
    if (
      decision.status === 'PROVIDER_RECORDED' ||
      decision.status === 'ACTION_SUBMITTED' ||
      decision.status === 'COMMITTED'
    ) {
      const recorded = [...(this.attempts.get(decisionId) ?? [])]
        .reverse()
        .find((attempt) => attempt.status === 'SUCCEEDED');
      if (recorded === undefined) throw new FakeStoreError('ATTEMPT_STATE');
      return { kind: 'reuse', attempt: recorded };
    }
    if (decision.status === 'CALLING_PROVIDER') throw new FakeStoreError('ATTEMPT_IN_FLIGHT');
    if (decision.status !== 'OBSERVED') throw new FakeStoreError('DECISION_STATE');
    const attemptNo = decision.attemptCount + 1;
    const now = Date.now();
    const attempt: ModelAttempt = {
      id: computeAttemptId(decisionId, attemptNo),
      decisionId,
      attemptNo,
      status: 'PENDING',
      requestJson,
      requestHash: createHash('sha256').update(requestJson).digest('hex'),
      requestMetadataJson:
        requestMetadata === undefined || requestMetadata === null
          ? null
          : JSON.stringify(requestMetadata),
      responseJson: null,
      error: null,
      model: null,
      provider: null,
      promptPolicyId: null,
      promptTokens: 0,
      completionTokens: 0,
      costMicroUsd: 0,
      latencyMs: 0,
      createdAt: now,
      recordedAt: null,
    };
    this.attempts.get(decisionId)!.push(attempt);
    this.decisions.set(decisionId, {
      ...decision,
      status: 'CALLING_PROVIDER',
      attemptCount: attemptNo,
      updatedAt: now,
    });
    return { kind: 'started', attempt };
  }

  recordAttemptResponse(
    decisionId: string,
    attemptId: string,
    record: AttemptRecordInput,
  ): ModelAttempt {
    const decision = this.requireDecision(decisionId);
    if (decision.status !== 'CALLING_PROVIDER') throw new FakeStoreError('DECISION_STATE');
    const attempts = this.attempts.get(decisionId) ?? [];
    const index = attempts.findIndex((attempt) => attempt.id === attemptId);
    if (index < 0) throw new FakeStoreError('ATTEMPT_STATE');
    const attempt = attempts[index]!;
    if (attempt.status !== 'PENDING') throw new FakeStoreError('ATTEMPT_STATE');
    const updated: ModelAttempt = {
      ...attempt,
      status: record.status,
      responseJson: record.responseJson ?? null,
      error: record.error ?? null,
      model: record.model,
      provider: record.provider,
      promptPolicyId: record.promptPolicyId,
      promptTokens: record.usage.promptTokens,
      completionTokens: record.usage.completionTokens,
      costMicroUsd: record.usage.costMicroUsd,
      latencyMs: record.usage.latencyMs,
      recordedAt: Date.now(),
    };
    attempts[index] = updated;
    this.decisions.set(decisionId, {
      ...decision,
      status: record.status === 'SUCCEEDED' ? 'PROVIDER_RECORDED' : 'OBSERVED',
      updatedAt: Date.now(),
    });
    return updated;
  }

  submitResolvedAction(decisionId: string, requestJson: string): ProductDecision {
    const decision = this.requireDecision(decisionId);
    if (decision.status !== 'PROVIDER_RECORDED') throw new FakeStoreError('DECISION_STATE');
    const updated: ProductDecision = {
      ...decision,
      status: 'ACTION_SUBMITTED',
      requestJson,
      updatedAt: Date.now(),
    };
    this.decisions.set(decisionId, updated);
    return updated;
  }

  commitDecision(decisionId: string, receiptJson: string): ProductDecision {
    const decision = this.requireDecision(decisionId);
    if (decision.status !== 'ACTION_SUBMITTED') throw new FakeStoreError('DECISION_STATE');
    const updated: ProductDecision = {
      ...decision,
      status: 'COMMITTED',
      receiptJson,
      updatedAt: Date.now(),
    };
    this.decisions.set(decisionId, updated);
    return updated;
  }

  markDecisionStale(decisionId: string, reason: string): ProductDecision {
    return this.terminate(decisionId, 'STALE', reason);
  }

  failDecision(decisionId: string, reason: string): ProductDecision {
    return this.terminate(decisionId, 'FAILED', reason);
  }

  listAttempts(decisionId: string): ModelAttempt[] {
    return [...(this.attempts.get(decisionId) ?? [])];
  }

  private readonly reserveAmounts = new Map<string, number[]>();

  reserveCall(
    roomId: string,
    agentId: string,
    roomLimits: RoomReservationLimits = {},
    reserveMicroUsd?: number | bigint | null,
  ): AgentReservation {
    const limits = this.limitsFor(agentId);
    const perCall =
      reserveMicroUsd === undefined || reserveMicroUsd === null
        ? limits.maxCostMicroUsdPerCall
        : Number(reserveMicroUsd);
    const key = `${roomId}\0${agentId}`;
    const current =
      this.reservations.get(key) ??
      ({
        roomId,
        agentId,
        callsReserved: 0,
        costMicroUsdReserved: 0,
        callsSettled: 0,
        costMicroUsdSettled: 0,
        updatedAt: Date.now(),
      } satisfies AgentReservation);
    const next: AgentReservation = {
      ...current,
      callsReserved: current.callsReserved + 1,
      costMicroUsdReserved: current.costMicroUsdReserved + perCall,
      updatedAt: Date.now(),
    };
    // Room-aggregate admission, evaluated before any modification (strict >).
    const roomMaxCalls = roomLimits.maxCalls ?? null;
    const roomMaxCost = roomLimits.maxCostMicroUsd ?? null;
    if (roomMaxCalls !== null || roomMaxCost !== null) {
      let totalCalls = 0n;
      let totalCost = 0n;
      for (const reservation of this.listRoomReservations(roomId)) {
        totalCalls += BigInt(reservation.callsReserved + reservation.callsSettled);
        totalCost += BigInt(reservation.costMicroUsdReserved + reservation.costMicroUsdSettled);
      }
      if (roomMaxCalls !== null && totalCalls + 1n > BigInt(roomMaxCalls)) {
        throw new FakeStoreError('ROOM_RESERVATION_EXCEEDED', 'maxCalls');
      }
      if (roomMaxCost !== null && totalCost + BigInt(perCall) > BigInt(roomMaxCost)) {
        throw new FakeStoreError('ROOM_RESERVATION_EXCEEDED', 'maxCostMicroUsd');
      }
    }
    if (next.callsSettled + next.callsReserved > limits.maxCallsPerRoom) {
      throw new FakeStoreError('RESERVATION_EXCEEDED', 'maxCallsPerRoom');
    }
    if (next.costMicroUsdSettled + next.costMicroUsdReserved > limits.maxCostMicroUsdPerRoom) {
      throw new FakeStoreError('RESERVATION_EXCEEDED', 'maxCostMicroUsdPerRoom');
    }
    this.reservations.set(key, next);
    const amounts = this.reserveAmounts.get(key) ?? [];
    amounts.push(perCall);
    this.reserveAmounts.set(key, amounts);
    return next;
  }

  settleCall(roomId: string, agentId: string, costMicroUsd: number): AgentReservation {
    const limits = this.limitsFor(agentId);
    const key = `${roomId}\0${agentId}`;
    const current = this.reservations.get(key);
    if (current === undefined || current.callsReserved < 1) {
      throw new FakeStoreError('RESERVATION_NOT_FOUND');
    }
    if (costMicroUsd > limits.maxCostMicroUsdPerCall) {
      throw new FakeStoreError('RESERVATION_EXCEEDED');
    }
    const released = this.takeOldestReserve(key, limits.maxCostMicroUsdPerCall);
    const next: AgentReservation = {
      ...current,
      callsReserved: current.callsReserved - 1,
      costMicroUsdReserved: Math.max(0, current.costMicroUsdReserved - released),
      callsSettled: current.callsSettled + 1,
      costMicroUsdSettled: current.costMicroUsdSettled + costMicroUsd,
      updatedAt: Date.now(),
    };
    this.reservations.set(key, next);
    return next;
  }

  settleUnknownCall(roomId: string, agentId: string): AgentReservation {
    const limits = this.limitsFor(agentId);
    const key = `${roomId}\0${agentId}`;
    const current = this.reservations.get(key);
    if (current === undefined || current.callsReserved < 1) {
      throw new FakeStoreError('RESERVATION_NOT_FOUND');
    }
    const released = this.takeOldestReserve(key, limits.maxCostMicroUsdPerCall);
    const next: AgentReservation = {
      ...current,
      callsReserved: current.callsReserved - 1,
      costMicroUsdReserved: Math.max(0, current.costMicroUsdReserved - released),
      callsSettled: current.callsSettled + 1,
      costMicroUsdSettled: current.costMicroUsdSettled + released,
      updatedAt: Date.now(),
    };
    this.reservations.set(key, next);
    return next;
  }

  releaseCall(roomId: string, agentId: string): AgentReservation {
    const limits = this.limitsFor(agentId);
    const key = `${roomId}\0${agentId}`;
    const current = this.reservations.get(key);
    if (current === undefined || current.callsReserved < 1) {
      throw new FakeStoreError('RESERVATION_NOT_FOUND');
    }
    const released = this.takeOldestReserve(key, limits.maxCostMicroUsdPerCall);
    const next: AgentReservation = {
      ...current,
      callsReserved: current.callsReserved - 1,
      costMicroUsdReserved: Math.max(0, current.costMicroUsdReserved - released),
      updatedAt: Date.now(),
    };
    this.reservations.set(key, next);
    return next;
  }

  private takeOldestReserve(key: string, fallback: number): number {
    const amounts = this.reserveAmounts.get(key);
    if (amounts === undefined || amounts.length === 0) return fallback;
    const released = amounts.shift() ?? fallback;
    if (amounts.length === 0) this.reserveAmounts.delete(key);
    return released;
  }

  getAgentConfig(agentId: string): AgentConfig | null {
    const limits = this.limitsFor(agentId);
    return normalizeAgentConfig({
      id: agentId,
      name: agentId,
      model: 'fake-model',
      provider: 'fake-provider',
      baseUrl: 'https://provider.example/v1',
      keyEnv: 'FAKE_PROVIDER_KEY',
      principalId: agentId === AGENT_ID ? PRINCIPAL : 'other-principal',
      promptPolicyId: seatPromptPolicy.id,
      promptPolicyHash: seatPromptPolicy.hash,
      pricing: { inputMicroUsdPerMillionTokens: 0, outputMicroUsdPerMillionTokens: 0 },
      limits,
      enabled: true,
    });
  }

  setOtherAgentLimits(
    agentId: string,
    limits: { maxCallsPerRoom: number; maxCostMicroUsdPerRoom: number; maxCostMicroUsdPerCall: number },
  ): void {
    this.otherAgentLimits.set(agentId, limits);
  }

  private limitsFor(agentId: string): {
    maxCallsPerRoom: number;
    maxCostMicroUsdPerRoom: number;
    maxCostMicroUsdPerCall: number;
  } {
    if (agentId === AGENT_ID) return this.limits;
    return (
      this.otherAgentLimits.get(agentId) ?? {
        maxCallsPerRoom: 1_000_000,
        maxCostMicroUsdPerRoom: 1_000_000_000,
        maxCostMicroUsdPerCall: 0,
      }
    );
  }

  /** Aggregate view used by the runtime's room-level budget guard. */
  listRoomReservations(roomId: string): AgentReservation[] {
    return [...this.reservations.values()].filter((reservation) => reservation.roomId === roomId);
  }

  /** Write-once at-most-once speech intention, COMMITTED decisions only. */
  readonly speechIntended = new Set<string>();
  speechIntentionDenied = false;

  markSpeechIntended(decisionId: string): boolean {
    const decision = this.requireDecision(decisionId);
    if (decision.status !== 'COMMITTED') throw new FakeStoreError('DECISION_STATE');
    if (this.speechIntentionDenied || this.speechIntended.has(decisionId)) return false;
    this.speechIntended.add(decisionId);
    return true;
  }

  private terminate(decisionId: string, status: 'STALE' | 'FAILED', reason: string): ProductDecision {
    const decision = this.requireDecision(decisionId);
    if (decision.status === 'COMMITTED' || decision.status === 'STALE' || decision.status === 'FAILED') {
      throw new FakeStoreError('DECISION_STATE');
    }
    const updated: ProductDecision = { ...decision, status, errorReason: reason, updatedAt: Date.now() };
    this.decisions.set(decisionId, updated);
    return updated;
  }

  private requireDecision(decisionId: string): ProductDecision {
    const decision = this.decisions.get(decisionId);
    if (decision === undefined) throw new FakeStoreError('DECISION_NOT_FOUND');
    return decision;
  }
}

// ---------------------------------------------------------------------------
// Fake authenticated transport
// ---------------------------------------------------------------------------

class FakeTransport implements AgentTurnTransport {
  principalId: string | null = null;
  connectPrincipal: string | null = PRINCIPAL;
  observation: SeatObservation = observationFixture();
  tableObservations = new Map<string, SeatObservation>();
  observationError: Error | null = null;
  fetchObservationCalls = 0;
  private readonly fetchWaiters: Array<{ count: number; resolve: () => void }> = [];
  chat: ChatMessage[] = [];
  chatError: Error | null = null;
  actionRequests: CanonicalActionRequest[] = [];
  actionHandler: (request: CanonicalActionRequest) => Promise<CanonicalActionResult> =
    async (request) => actionResult(request);
  sentChats: Array<{ tableId: string; body: string; requestId: string }> = [];
  chatSendError: Error | null = null;
  private readonly listeners = new Map<string, Set<(observation: SeatObservation) => void>>();

  async connect(): Promise<void> {
    this.principalId = this.connectPrincipal;
  }

  close(): void {}

  async fetchObservation(tableId: string): Promise<SeatObservation> {
    this.fetchObservationCalls += 1;
    for (const waiter of [...this.fetchWaiters]) {
      if (this.fetchObservationCalls >= waiter.count) {
        this.fetchWaiters.splice(this.fetchWaiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
    if (this.observationError !== null) throw this.observationError;
    return this.tableObservations.get(tableId) ?? this.observation;
  }

  /** Latched wait for the Nth REST observation fetch (no polling/sleeps). */
  waitForFetch(count: number): Promise<void> {
    if (this.fetchObservationCalls >= count) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.fetchWaiters.push({ count, resolve });
    });
  }

  async submitAction(_tableId: string, request: CanonicalActionRequest): Promise<CanonicalActionResult> {
    this.actionRequests.push(request);
    return this.actionHandler(request);
  }

  async fetchChat(): Promise<readonly unknown[]> {
    if (this.chatError !== null) throw this.chatError;
    return this.chat;
  }

  async sendChat(input: { tableId: string; body: string; requestId: string }): Promise<{ messageId: string }> {
    this.sentChats.push(input);
    if (this.chatSendError !== null) throw this.chatSendError;
    return { messageId: `msg-${this.sentChats.length}` };
  }

  onObservation(_tableId: string, listener: (observation: SeatObservation) => void): () => void {
    let set = this.listeners.get(_tableId);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(_tableId, set);
    }
    set.add(listener);
    return () => set.delete(listener);
  }

  emitObservation(tableId: string, observation?: SeatObservation): void {
    for (const listener of this.listeners.get(tableId) ?? []) listener(observation ?? this.observation);
  }
}

function actionResult(request: CanonicalActionRequest): CanonicalActionResult {
  const base = observationFixture();
  const version = base.version + 1;
  const observation = SeatObservationSchema.parse({
    ...base,
    turnId: request.turnId,
    version,
    state: { ...base.state, version },
  });
  return CanonicalActionResultSchema.parse({
    receipt: {
      requestId: request.requestId,
      tableId: observation.tableId,
      handId: observation.handId,
      turnId: request.turnId,
      actionId: request.actionId,
      version,
      eventSeq: observation.eventSeq,
      acceptedAt: Date.now(),
    },
    observation,
  });
}

// ---------------------------------------------------------------------------
// Fake provider factory
// ---------------------------------------------------------------------------

type FakeCallResult =
  | {
      kind: 'valid';
      arguments?: Record<string, unknown>;
      speech?: string;
      usage?: 'known' | 'unknown';
      costUsdMicro?: bigint;
    }
  | { kind: 'invalid-success'; payload?: unknown }
  | { kind: 'malformed'; payload?: unknown }
  | { kind: 'http-error'; status?: number; errorCode?: string }
  | { kind: 'hang' }
  | { kind: 'request-mismatch' };

interface FakeProviderHarness {
  factory: DecisionProviderFactory;
  invocations: number;
  /** Resolves as soon as the Nth provider call has begun (latched, no polling). */
  waitForInvocation(count: number): Promise<void>;
}

function makeFakeProviderFactory(
  script: (invocation: number, prompt: DecisionPrompt) => FakeCallResult | Promise<FakeCallResult>,
  costCeilingUsdMicro: (prompt: DecisionPrompt) => bigint = () => 0n,
): FakeProviderHarness {
  const waiters: Array<{ count: number; resolve: () => void }> = [];
  const harness = {
    invocations: 0,
    waitForInvocation(count: number): Promise<void> {
      if (harness.invocations >= count) return Promise.resolve();
      return new Promise<void>((resolve) => {
        waiters.push({ count, resolve });
      });
    },
  } as FakeProviderHarness;
  harness.factory = Object.assign(
    (context: DecisionProviderCallContext): DecisionProviderPort => ({
      // Deliberately reuse the canonical builder so the fake cannot "fix" a
      // broken request; the runtime inspector still validates independently.
      buildPrompt: (observation, publicChat) =>
        buildDecisionPrompt({
          observation,
          publicChat,
          model: MODEL,
          temperature: 0,
          maxOutputTokens: 128,
        }),
      async sendPrompt(prompt, options) {
        harness.invocations += 1;
        const invocation = harness.invocations;
        for (const waiter of [...waiters]) {
          if (harness.invocations >= waiter.count) {
            waiters.splice(waiters.indexOf(waiter), 1);
            waiter.resolve();
          }
        }
        const result = await script(invocation, prompt);
          const requestJson = serializeDecisionRequest(prompt);
          const request: DecisionRequestRecord = {
            requestId: `prov-${invocation}`,
            provider: PROVIDER,
            model: MODEL,
            baseUrlHost: '127.0.0.1',
            promptVersion: prompt.promptVersion,
            promptHash: prompt.promptHash,
            observationHash: prompt.observationHash,
            requestJson,
            requestHash: createHash('sha256').update(requestJson).digest('hex'),
            requestBytes: Buffer.byteLength(requestJson, 'utf8'),
            startedAt: Date.now(),
          };
          if (result.kind === 'request-mismatch') {
            context.onRequest({
              ...request,
              requestJson: JSON.stringify({ tampered: true }),
            });
            throw new Error('tampered request');
          }
          context.onRequest(request);
          if (result.kind === 'hang') {
            await new Promise<never>((_resolve, reject) => {
              const signal = options?.signal;
              const rejectAborted = (): void => {
                const error = new Error('aborted');
                error.name = 'AbortError';
                reject(error);
              };
              if (signal?.aborted === true) {
                rejectAborted();
                return;
              }
              signal?.addEventListener('abort', rejectAborted, { once: true });
            });
          }
          if (result.kind === 'http-error') {
            const status = result.status ?? 503;
            context.onResponse(
              responseRecord(
                request.requestId,
                status,
                false,
                JSON.stringify({ error: result.errorCode ?? 'provider_error' }),
                result.errorCode ?? 'provider_error',
                0n,
              ),
            );
            throw new Error(`provider http ${status}`);
          }
          if (result.kind === 'malformed') {
            // HTTP 200 with provider validation failure: recorded FAILED with
            // the exact sanitized body and a validation error code.
            const responseJson = JSON.stringify(
              result.payload ?? { choices: [{ message: { role: 'assistant', content: 'no tool call' } }] },
            );
            context.onResponse(
              responseRecord(request.requestId, 200, true, responseJson, 'missing_tool_call', 7n),
            );
            throw new Error('missing_tool_call');
          }
          const responseJson =
            result.kind === 'valid'
              ? toolCallResponse(
                  result.arguments ?? validActionArguments(),
                  result.speech === undefined ? {} : { speech: result.speech },
                )
              : JSON.stringify(
                  result.payload ?? { choices: [{ message: { role: 'assistant', content: 'no tool call' } }] },
                );
          context.onResponse(
            responseRecord(
              request.requestId,
              200,
              true,
              responseJson,
              null,
              result.kind === 'valid' ? (result.costUsdMicro ?? 7n) : 7n,
              result.kind !== 'valid' || result.usage !== 'unknown',
            ),
          );
          return { prompt };
        },
      }),
      {
        identity: { model: MODEL, provider: PROVIDER, baseUrlHost: '127.0.0.1' },
        knownSecrets: [],
        sanitizeSourceChat: (entries) =>
          sanitizeSecretValue(entries, { knownSecrets: [] }) as ChatMessage[],
        costCeilingUsdMicro,
      },
    );
  return harness;
}

function responseRecord(
  requestId: string,
  status: number,
  ok: boolean,
  responseJson: string | null,
  errorCode: string | null,
  costUsdMicro: bigint,
  usageKnown = ok,
): DecisionResponseRecord {
  return {
    requestId,
    status,
    ok,
    responseJson,
    responseBytes: responseJson === null ? 0 : Buffer.byteLength(responseJson, 'utf8'),
    rawResponseBytes: responseJson === null ? 0 : Buffer.byteLength(responseJson, 'utf8'),
    inputTokens: ok && usageKnown ? 50 : null,
    outputTokens: ok && usageKnown ? 5 : null,
    costUsdMicro,
    errorCode,
    finishedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function observationWith(overrides: {
  tableId?: string;
  turnId?: string;
  handId?: string;
  version?: number;
  eventSeq?: number;
  handNumber?: number;
  legalActions?: LegalAction[];
  viewingPlayerId?: string | null;
  state?: Record<string, unknown>;
}): SeatObservation {
  const base = observationInput();
  const viewingPlayerId =
    overrides.viewingPlayerId === undefined
      ? base.state.viewingPlayerId
      : overrides.viewingPlayerId;
  // A non-seat-scoped observation must not leak any hand.
  const players =
    viewingPlayerId === null
      ? base.state.players.map((player) => (player === null ? null : { ...player, hand: null }))
      : base.state.players;
  return SeatObservationSchema.parse({
    ...base,
    tableId: overrides.tableId ?? base.tableId,
    turnId: overrides.turnId ?? base.turnId,
    handId: overrides.handId ?? base.handId,
    version: overrides.version ?? base.version,
    eventSeq: overrides.eventSeq ?? base.eventSeq,
    legalActions: overrides.legalActions ?? base.legalActions,
    state: {
      ...base.state,
      players,
      viewingPlayerId,
      handId: overrides.handId ?? base.state.handId,
      version: overrides.version ?? base.version,
      handNumber: overrides.handNumber ?? base.state.handNumber,
      ...(overrides.state ?? {}),
    },
  });
}

function makeConfig(overrides: Partial<AgentRuntimeConfig> = {}): AgentRuntimeConfig {
  return {
    agentId: AGENT_ID,
    principalId: PRINCIPAL,
    promptPolicyId: seatPromptPolicy.id,
    promptPolicyHash: seatPromptPolicy.hash,
    rooms: [{ roomId: ROOM_ID, tableId: TEST_TABLE_ID, agentPrincipalIds: [PRINCIPAL] }],
    perCallTimeoutMs: 5_000,
    ...overrides,
  };
}

interface Harness {
  store: MemoryDecisionStore;
  transport: FakeTransport;
  provider: FakeProviderHarness;
  audits: AgentAuditEvent[];
  runtime: AgentRuntime;
}

function makeHarness(options: {
  config?: Partial<AgentRuntimeConfig>;
  script?: (invocation: number, prompt: DecisionPrompt) => FakeCallResult | Promise<FakeCallResult>;
  costCeilingUsdMicro?: (prompt: DecisionPrompt) => bigint;
  store?: MemoryDecisionStore;
  transport?: FakeTransport;
  limiter?: DecisionConcurrencyLimiter;
  now?: () => number;
} = {}): Harness {
  const store = options.store ?? new MemoryDecisionStore();
  const transport = options.transport ?? new FakeTransport();
  transport.observation = observationWith({});
  transport.observationError = null;
  const provider = makeFakeProviderFactory(
    options.script ?? (() => ({ kind: 'valid' })),
    options.costCeilingUsdMicro,
  );
  const audits: AgentAuditEvent[] = [];
  const dependencies: AgentRuntimeDependencies = {
    transport,
    store,
    providerFactory: provider.factory,
    audit: (event) => audits.push(event),
    now: options.now,
    ...(options.limiter !== undefined ? { limiter: options.limiter } : {}),
  };
  return {
    store,
    transport,
    provider,
    audits,
    runtime: new AgentRuntime(makeConfig(options.config), dependencies),
  };
}

function expectStatus(store: MemoryDecisionStore, tableId: string, turnId: string): ProductDecision {
  const decision = store.getDecisionForTurn(tableId, turnId, PRINCIPAL);
  if (decision === null) throw new Error(`no decision for ${tableId}/${turnId}`);
  return decision;
}

function hasAudit(audits: AgentAuditEvent[], code: string): boolean {
  return audits.some((event) => event.code === code);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentRuntime lifecycle', () => {
  it('observes, persists, calls the provider once and commits the canonical action', async () => {
    const harness = makeHarness();
    await harness.runtime.start();

    const decision = expectStatus(harness.store, TEST_TABLE_ID, TEST_TURN_ID);
    expect(decision.status).toBe('COMMITTED');
    expect(decision.requestJson).not.toBeNull();
    const request = JSON.parse(decision.requestJson!) as CanonicalActionRequest;
    expect(request.requestId).toBe(decision.id);
    expect(request.actionId).toBe('act-raise-half');
    expect(request.amount).toBe(12);
    expect(decision.receiptJson).not.toBeNull();
    expect(harness.provider.invocations).toBe(1);
    expect(harness.transport.actionRequests).toHaveLength(1);

    const attempts = harness.store.listAttempts(decision.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.status).toBe('SUCCEEDED');
    expect(attempts[0]!.attemptNo).toBe(1);

    const reservation = harness.store.reservations.get(`${ROOM_ID}\0${AGENT_ID}`);
    expect(reservation?.callsReserved).toBe(0);
    expect(reservation?.callsSettled).toBe(1);
    expect(hasAudit(harness.audits, 'PROVIDER_REQUEST_PERSISTED')).toBe(true);
    expect(hasAudit(harness.audits, 'COMMITTED')).toBe(true);
  });

  it('restores the allowed chat source at the observed boundary and passes it to the prompt', async () => {
    const harness = makeHarness();
    harness.transport.chat = [chatFixture(3, 'call the raise')];
    await harness.runtime.start();

    const decision = expectStatus(harness.store, TEST_TABLE_ID, TEST_TURN_ID);
    expect(decision.status).toBe('COMMITTED');
    expect(decision.source?.publicChat).toHaveLength(1);
    expect(decision.source?.publicChat[0]!.body).toBe('call the raise');
  });

  it('skips turns without legal actions and never calls the provider', async () => {
    const harness = makeHarness();
    harness.transport.observation = observationWith({ legalActions: [] });
    await harness.runtime.start();
    expect(harness.provider.invocations).toBe(0);
    expect(harness.transport.actionRequests).toHaveLength(0);
    expect(harness.store.decisions.size).toBe(0);
  });

  it('makes zero calls for human-only and non-agent rooms', async () => {
    const humanOnly = makeHarness({
      config: { rooms: [{ roomId: ROOM_ID, tableId: TEST_TABLE_ID, agentPrincipalIds: [] }] },
    });
    await humanOnly.runtime.start();
    expect(humanOnly.provider.invocations).toBe(0);
    expect(humanOnly.transport.fetchObservationCalls).toBe(0);
    expect(hasAudit(humanOnly.audits, 'HUMAN_ONLY_ROOM')).toBe(true);

    const otherAgent = makeHarness({
      config: {
        rooms: [{ roomId: ROOM_ID, tableId: TEST_TABLE_ID, agentPrincipalIds: ['somebody-else'] }],
      },
    });
    await otherAgent.runtime.start();
    expect(otherAgent.provider.invocations).toBe(0);
    expect(otherAgent.transport.fetchObservationCalls).toBe(0);
  });

  it('refuses a transport that authenticates a different principal', async () => {
    const harness = makeHarness();
    harness.transport.connectPrincipal = 'impostor';
    await expect(harness.runtime.start()).rejects.toBeInstanceOf(AgentAuthorityError);
    expect(harness.store.decisions.size).toBe(0);
    expect(harness.provider.invocations).toBe(0);
  });

  it('keeps the conservative reservation when provider usage is unknown', async () => {
    const harness = makeHarness({
      script: () => ({ kind: 'valid', usage: 'unknown' }),
      costCeilingUsdMicro: () => 321n,
    });
    await harness.runtime.start();

    const decision = expectStatus(harness.store, TEST_TABLE_ID, TEST_TURN_ID);
    expect(decision.status).toBe('COMMITTED');
    const reservation = harness.store.reservations.get(`${ROOM_ID}\0${AGENT_ID}`);
    expect(reservation?.callsReserved).toBe(0);
    expect(reservation?.callsSettled).toBe(1);
    // Unknown usage settles at the exact reserved ceiling for budget only.
    expect(reservation?.costMicroUsdReserved).toBe(0);
    expect(reservation?.costMicroUsdSettled).toBe(321);
    expect(hasAudit(harness.audits, 'RESERVATION_SETTLED_UNKNOWN')).toBe(true);
  });
});

describe('AgentRuntime observation authority', () => {
  it('rejects an observation that is not seat-scoped before any provider call', async () => {
    const harness = makeHarness();
    harness.transport.observation = observationWith({ viewingPlayerId: null });
    await harness.runtime.start();

    expect(harness.provider.invocations).toBe(0);
    expect(harness.transport.actionRequests).toHaveLength(0);
    expect(harness.store.decisions.size).toBe(0);
    expect(hasAudit(harness.audits, 'OBSERVATION_IDENTITY_MISMATCH')).toBe(true);
  });

  it('rejects an observation naming another player than the configured seat', async () => {
    const harness = makeHarness({
      config: {
        rooms: [
          {
            roomId: ROOM_ID,
            tableId: TEST_TABLE_ID,
            agentPrincipalIds: [PRINCIPAL],
            expectedPlayerId: 'p9',
          },
        ],
      },
    });
    harness.transport.observation = observationWith({ viewingPlayerId: 'p0' });
    await harness.runtime.start();

    expect(harness.provider.invocations).toBe(0);
    expect(harness.store.decisions.size).toBe(0);
    expect(hasAudit(harness.audits, 'OBSERVATION_IDENTITY_MISMATCH')).toBe(true);
  });

  it('accepts an observation whose viewing player matches the configured expectation', async () => {
    const harness = makeHarness({
      config: {
        rooms: [
          {
            roomId: ROOM_ID,
            tableId: TEST_TABLE_ID,
            agentPrincipalIds: [PRINCIPAL],
            expectedPlayerId: 'p0',
          },
        ],
      },
    });
    await harness.runtime.start();
    expect(expectStatus(harness.store, TEST_TABLE_ID, TEST_TURN_ID).status).toBe('COMMITTED');
  });
});

describe('AgentRuntime restart safety', () => {
  it('resolves a recorded successful response from durable state without calling the provider again', async () => {
    const store = new MemoryDecisionStore();
    const observation = observationWith({});
    const decision = store.observeDecision({
      tableId: observation.tableId,
      turnId: observation.turnId,
      principalId: PRINCIPAL,
      roomId: ROOM_ID,
      observation,
      observationHash: computeObservationHash(observation),
      source: null,
      promptPolicyId: seatPromptPolicy.id,
      eventCursor: observation.eventSeq,
    });
    const started = store.startAttempt(decision.id, JSON.stringify({ placeholder: true }));
    if (started.kind !== 'started') throw new Error('expected started');
    store.recordAttemptResponse(decision.id, started.attempt.id, {
      status: 'SUCCEEDED',
      responseJson: toolCallResponse(validActionArguments()),
      model: MODEL,
      provider: PROVIDER,
      promptPolicyId: seatPromptPolicy.id,
      usage: { promptTokens: 10, completionTokens: 2, costMicroUsd: 5, latencyMs: 1 },
    });

    const harness = makeHarness({
      store,
      script: () => {
        throw new Error('provider must not be called on restart');
      },
    });
    await harness.runtime.start();

    const reloaded = expectStatus(store, TEST_TABLE_ID, TEST_TURN_ID);
    expect(reloaded.status).toBe('COMMITTED');
    expect(harness.provider.invocations).toBe(0);
    expect(harness.transport.actionRequests).toHaveLength(1);
    expect(harness.transport.actionRequests[0]!.requestId).toBe(decision.id);
    expect(harness.transport.actionRequests[0]!.actionId).toBe('act-raise-half');
    expect(harness.store.listAttempts(decision.id)).toHaveLength(1);
  });

  it('replays the stored action request first and commits on the idempotent platform receipt', async () => {
    const store = new MemoryDecisionStore();
    const observation = observationWith({});
    const decision = seedActionSubmitted(store, observation);

    const harness = makeHarness({
      store,
      script: () => {
        throw new Error('provider must not be called');
      },
    });
    await harness.runtime.start();

    const reloaded = expectStatus(store, TEST_TABLE_ID, TEST_TURN_ID);
    expect(reloaded.status).toBe('COMMITTED');
    expect(harness.transport.actionRequests).toHaveLength(1);
    expect(harness.transport.actionRequests[0]!.requestId).toBe(decision.id);
    expect(harness.provider.invocations).toBe(0);
  });

  it('marks a deterministically rejected stored action STALE after trying the same request', async () => {
    const store = new MemoryDecisionStore();
    const observation = observationWith({});
    seedActionSubmitted(store, observation);
    const harness = makeHarness({ store });
    harness.transport.actionHandler = async () => {
      throw Object.assign(new Error('turn mismatch'), { code: 'TURN_MISMATCH', statusCode: 409 });
    };

    await harness.runtime.start();
    const reloaded = expectStatus(store, TEST_TABLE_ID, TEST_TURN_ID);
    expect(reloaded.status).toBe('STALE');
    expect(reloaded.errorReason).toContain('action_stale');
    expect(harness.transport.actionRequests).toHaveLength(1);
  });

  it('recovers an abandoned in-flight attempt as a distinct audited attempt 2', async () => {
    const store = new MemoryDecisionStore();
    const transport = new FakeTransport();
    transport.observation = observationWith({});
    const provider = makeFakeProviderFactory(async (invocation) => {
      if (invocation === 1) return { kind: 'hang' };
      return { kind: 'valid' };
    });
    const audits: AgentAuditEvent[] = [];
    const dependencies: AgentRuntimeDependencies = {
      transport,
      store,
      providerFactory: provider.factory,
      audit: (event) => audits.push(event),
    };

    const firstRuntime = new AgentRuntime(makeConfig(), dependencies);
    const starting = firstRuntime.start();
    await provider.waitForInvocation(1);
    await firstRuntime.stop();
    await starting;

    const afterCrash = expectStatus(store, TEST_TABLE_ID, TEST_TURN_ID);
    expect(afterCrash.status).toBe('CALLING_PROVIDER');
    expect(afterCrash.attemptCount).toBe(1);
    const crashedAttempts = store.listAttempts(afterCrash.id);
    expect(crashedAttempts).toHaveLength(1);
    expect(crashedAttempts[0]!.status).toBe('PENDING');

    // Second process over the same durable store.
    const secondRuntime = new AgentRuntime(makeConfig(), dependencies);
    await secondRuntime.start();

    const reloaded = expectStatus(store, TEST_TABLE_ID, TEST_TURN_ID);
    expect(reloaded.status).toBe('COMMITTED');
    const attempts = store.listAttempts(reloaded.id);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]!.status).toBe('FAILED');
    expect(attempts[0]!.error).toContain('inflight_abandoned');
    expect(attempts[1]!.status).toBe('SUCCEEDED');
    expect(provider.invocations).toBe(2);
    expect(hasAudit(audits, 'IN_FLIGHT_AMBIGUITY_RECOVERED')).toBe(true);
  });

  it('bounds recorded provider failures to two distinct attempts and never mutates poker state', async () => {
    const harness = makeHarness({
      script: () => ({ kind: 'http-error', status: 503, errorCode: 'provider_error' }),
    });
    await harness.runtime.start();

    const decision = expectStatus(harness.store, TEST_TABLE_ID, TEST_TURN_ID);
    expect(decision.status).toBe('FAILED');
    expect(decision.attemptCount).toBe(2);
    const attempts = harness.store.listAttempts(decision.id);
    expect(attempts).toHaveLength(2);
    expect(attempts.map((attempt) => attempt.attemptNo)).toEqual([1, 2]);
    expect(attempts.every((attempt) => attempt.status === 'FAILED')).toBe(true);
    expect(harness.provider.invocations).toBe(2);
    expect(harness.transport.actionRequests).toHaveLength(0);
  });

  it('stops making fresh provider calls but keeps durable state on abort', async () => {
    const harness = makeHarness({ script: () => ({ kind: 'hang' }) });
    const starting = harness.runtime.start();
    await harness.provider.waitForInvocation(1);
    await harness.runtime.stop();
    await starting;

    const decision = expectStatus(harness.store, TEST_TABLE_ID, TEST_TURN_ID);
    expect(decision.status).toBe('CALLING_PROVIDER');
    expect(harness.store.listAttempts(decision.id)[0]!.status).toBe('PENDING');
    expect(hasAudit(harness.audits, 'ABORTED')).toBe(true);
  });

  it('honors an absolute run deadline recorded before this process started (real store)', async () => {
    const real = openRealStore();
    const activation = real.room.updatedAt;
    const transport = new FakeTransport();
    transport.observation = observationWith({});
    const provider = makeFakeProviderFactory(() => ({ kind: 'valid' }));
    const runtime = new AgentRuntime(
      makeConfig({
        overallDeadlineAtMs: activation + 60_000,
        rooms: [
          { roomId: real.room.id, tableId: TEST_TABLE_ID, agentPrincipalIds: [PRINCIPAL] },
        ],
      }),
      {
        transport,
        store: real.store,
        providerFactory: provider.factory,
        // New process clock is beyond activation + window.
        now: () => activation + 61_000,
      },
    );
    try {
      await runtime.start();
      const decision = real.store.getDecisionForTurn(TEST_TABLE_ID, TEST_TURN_ID, PRINCIPAL);
      expect(decision?.status).toBe('FAILED');
      expect(decision?.errorReason).toContain('runtime_deadline_exhausted');
      expect(provider.invocations).toBe(0);
      expect(transport.actionRequests).toHaveLength(0);
      expect(real.store.listAttempts(decision!.id)).toHaveLength(0);
    } finally {
      real.cleanup();
    }
  });

  it('rejects a canonical handNumber beyond the room cap on a fresh instance', async () => {
    const harness = makeHarness({
      config: {
        rooms: [
          { roomId: ROOM_ID, tableId: TEST_TABLE_ID, agentPrincipalIds: [PRINCIPAL], maxHands: 1 },
        ],
      },
    });
    harness.transport.observation = observationWith({ handNumber: 2 });
    await harness.runtime.start();

    const decision = expectStatus(harness.store, TEST_TABLE_ID, TEST_TURN_ID);
    expect(decision.status).toBe('FAILED');
    expect(decision.errorReason).toContain('room_max_hands_exhausted');
    expect(harness.provider.invocations).toBe(0);
    expect(harness.store.listAttempts(decision.id)).toHaveLength(0);
  });

  it('still replays a recorded action request when the run budget has elapsed', async () => {
    const store = new MemoryDecisionStore();
    const observation = observationWith({});
    seedActionSubmitted(store, observation);
    const harness = makeHarness({
      store,
      config: { overallDeadlineAtMs: Date.now() - 1 },
      script: () => {
        throw new Error('provider must not be called');
      },
    });
    await harness.runtime.start();

    const decision = expectStatus(store, TEST_TABLE_ID, TEST_TURN_ID);
    expect(decision.status).toBe('COMMITTED');
    expect(harness.transport.actionRequests).toHaveLength(1);
    expect(harness.provider.invocations).toBe(0);
  });

  it('still resolves a recorded provider response when the run budget has elapsed', async () => {
    const store = new MemoryDecisionStore();
    const observation = observationWith({});
    const decision = store.observeDecision({
      tableId: observation.tableId,
      turnId: observation.turnId,
      principalId: PRINCIPAL,
      roomId: ROOM_ID,
      observation,
      observationHash: computeObservationHash(observation),
      source: null,
      promptPolicyId: seatPromptPolicy.id,
      eventCursor: observation.eventSeq,
    });
    const started = store.startAttempt(decision.id, JSON.stringify({ placeholder: true }));
    if (started.kind !== 'started') throw new Error('expected started');
    store.recordAttemptResponse(decision.id, started.attempt.id, {
      status: 'SUCCEEDED',
      responseJson: toolCallResponse(validActionArguments()),
      model: MODEL,
      provider: PROVIDER,
      promptPolicyId: seatPromptPolicy.id,
      usage: { promptTokens: 10, completionTokens: 2, costMicroUsd: 5, latencyMs: 1 },
    });
    const harness = makeHarness({
      store,
      config: { overallDeadlineAtMs: Date.now() - 1 },
      script: () => {
        throw new Error('provider must not be called');
      },
    });
    await harness.runtime.start();

    expect(expectStatus(store, TEST_TABLE_ID, TEST_TURN_ID).status).toBe('COMMITTED');
    expect(harness.transport.actionRequests).toHaveLength(1);
    expect(harness.provider.invocations).toBe(0);
  });

  it('commits an SDK-accepted action received during shutdown without starting speech', async () => {
    const harness = makeHarness({
      config: { speech: 'AFTER_COMMIT' },
      script: () => ({
        kind: 'valid',
        arguments: { ...validActionArguments(), speech: 'late talk' },
      }),
    });
    let signalActionStarted: () => void = () => {};
    const actionStarted = new Promise<void>((resolve) => {
      signalActionStarted = resolve;
    });
    let releaseAction: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseAction = resolve;
    });
    harness.transport.actionHandler = async (request) => {
      signalActionStarted();
      await gate;
      return actionResult(request);
    };

    const starting = harness.runtime.start();
    await actionStarted;
    // stop() marks stopping synchronously before awaiting drain; release the
    // accepted SDK response while the store is still open.
    const stopping = harness.runtime.stop();
    releaseAction();
    await stopping;
    await starting;

    const decision = expectStatus(harness.store, TEST_TABLE_ID, TEST_TURN_ID);
    expect(decision.status).toBe('COMMITTED');
    expect(decision.receiptJson).not.toBeNull();
    expect(harness.transport.actionRequests).toHaveLength(1);
    expect(harness.transport.actionRequests[0]!.requestId).toBe(decision.id);
    expect(harness.provider.invocations).toBe(1);
    expect(harness.transport.sentChats).toHaveLength(0);
    expect(hasAudit(harness.audits, 'ACTION_ACCEPTED_ON_STOP')).toBe(true);
  });

  it('blocks only new provider calls when provider calls are disabled', async () => {
    const harness = makeHarness({
      config: { providerCallsEnabled: false },
      script: () => {
        throw new Error('provider must not be called');
      },
    });
    await harness.runtime.start();

    const decision = expectStatus(harness.store, TEST_TABLE_ID, TEST_TURN_ID);
    expect(decision.status).toBe('FAILED');
    expect(decision.errorReason).toContain('provider_unavailable');
    expect(harness.provider.invocations).toBe(0);
    expect(harness.store.listAttempts(decision.id)).toHaveLength(0);
    expect(hasAudit(harness.audits, 'PROVIDER_UNAVAILABLE')).toBe(true);
  });

  it('still resolves recorded responses and replays recorded actions with provider calls disabled', async () => {
    const recordedStore = new MemoryDecisionStore();
    const recordedObservation = observationWith({});
    const recorded = recordedStore.observeDecision({
      tableId: recordedObservation.tableId,
      turnId: recordedObservation.turnId,
      principalId: PRINCIPAL,
      roomId: ROOM_ID,
      observation: recordedObservation,
      observationHash: computeObservationHash(recordedObservation),
      source: null,
      promptPolicyId: seatPromptPolicy.id,
      eventCursor: recordedObservation.eventSeq,
    });
    const started = recordedStore.startAttempt(recorded.id, JSON.stringify({ placeholder: true }));
    if (started.kind !== 'started') throw new Error('expected started');
    recordedStore.recordAttemptResponse(recorded.id, started.attempt.id, {
      status: 'SUCCEEDED',
      responseJson: toolCallResponse(validActionArguments()),
      model: MODEL,
      provider: PROVIDER,
      promptPolicyId: seatPromptPolicy.id,
      usage: { promptTokens: 10, completionTokens: 2, costMicroUsd: 5, latencyMs: 1 },
    });
    const recordedHarness = makeHarness({
      store: recordedStore,
      config: { providerCallsEnabled: false },
      script: () => {
        throw new Error('provider must not be called');
      },
    });
    await recordedHarness.runtime.start();
    expect(expectStatus(recordedStore, TEST_TABLE_ID, TEST_TURN_ID).status).toBe('COMMITTED');
    expect(recordedHarness.transport.actionRequests).toHaveLength(1);
    expect(recordedHarness.provider.invocations).toBe(0);

    const submittedStore = new MemoryDecisionStore();
    seedActionSubmitted(submittedStore, observationWith({}));
    const submittedHarness = makeHarness({
      store: submittedStore,
      config: { providerCallsEnabled: false },
      script: () => {
        throw new Error('provider must not be called');
      },
    });
    await submittedHarness.runtime.start();
    expect(expectStatus(submittedStore, TEST_TABLE_ID, TEST_TURN_ID).status).toBe('COMMITTED');
    expect(submittedHarness.transport.actionRequests).toHaveLength(1);
    expect(submittedHarness.provider.invocations).toBe(0);
  });
});

describe('AgentRuntime provider output safety', () => {
  it('fails closed on malformed provider output without submitting any action', async () => {
    const harness = makeHarness({ script: () => ({ kind: 'malformed' }) });
    await harness.runtime.start();

    const decision = expectStatus(harness.store, TEST_TABLE_ID, TEST_TURN_ID);
    expect(decision.status).toBe('FAILED');
    expect(decision.errorReason).toContain('provider_attempts_exhausted');
    expect(harness.transport.actionRequests).toHaveLength(0);
    const attempts = harness.store.listAttempts(decision.id);
    expect(attempts).toHaveLength(2);
    expect(attempts.every((attempt) => attempt.status === 'FAILED')).toBe(true);
    expect(attempts.every((attempt) => attempt.error === 'missing_tool_call')).toBe(true);
    expect(harness.provider.invocations).toBe(2);
  });

  it('never mutates when a stored successful response fails validation on restart', async () => {
    const harness = makeHarness({ script: () => ({ kind: 'invalid-success' }) });
    await harness.runtime.start();

    const decision = expectStatus(harness.store, TEST_TABLE_ID, TEST_TURN_ID);
    expect(decision.status).toBe('FAILED');
    expect(decision.errorReason).toContain('invalid_provider_response');
    expect(harness.transport.actionRequests).toHaveLength(0);
    expect(harness.provider.invocations).toBe(1);
    expect(hasAudit(harness.audits, 'MALFORMED_PROVIDER_RESPONSE')).toBe(true);
  });

  it('fails closed before HTTP when the recorded request differs from the persisted attempt', async () => {
    const harness = makeHarness({
      script: () => ({ kind: 'request-mismatch' }),
    });
    await harness.runtime.start();

    const decision = expectStatus(harness.store, TEST_TABLE_ID, TEST_TURN_ID);
    expect(decision.status).toBe('FAILED');
    const attempts = harness.store.listAttempts(decision.id);
    expect(attempts).toHaveLength(2);
    expect(attempts.every((attempt) => attempt.status === 'FAILED')).toBe(true);
    expect(harness.transport.actionRequests).toHaveLength(0);
    expect(hasAudit(harness.audits, 'PROVIDER_REQUEST_MISMATCH')).toBe(true);
  });

  it('defers to a fresh observation when the turn is superseded', async () => {
    const harness = makeHarness();
    harness.transport.observation = observationWith({ turnId: 'turn-newer' });
    await harness.runtime.start();

    const decision = expectStatus(harness.store, TEST_TABLE_ID, 'turn-newer');
    expect(decision.status).toBe('COMMITTED');
    // The old turn was never observed at all.
    expect(harness.store.getDecisionForTurn(TEST_TABLE_ID, TEST_TURN_ID, PRINCIPAL)).toBeNull();
  });
});

describe('AgentRuntime room guards', () => {
  it('stops provider calls when the room call budget is exhausted', async () => {
    const harness = makeHarness();
    harness.store.limits.maxCallsPerRoom = 1;
    harness.store.limits.maxCostMicroUsdPerRoom = 100_000;
    await harness.runtime.start();
    expect(expectStatus(harness.store, TEST_TABLE_ID, TEST_TURN_ID).status).toBe('COMMITTED');

    harness.transport.observation = observationWith({
      turnId: 'turn-2',
      version: 5,
      eventSeq: 11,
    });
    await harness.runtime.syncNow();

    const second = expectStatus(harness.store, TEST_TABLE_ID, 'turn-2');
    expect(second.status).toBe('FAILED');
    expect(second.errorReason).toContain('room_reservation_denied');
    expect(harness.provider.invocations).toBe(1);
    expect(harness.transport.actionRequests).toHaveLength(1);
    expect(hasAudit(harness.audits, 'ROOM_RESERVATION_DENIED')).toBe(true);
  });

  it('stops provider calls once the room hand cap is reached', async () => {
    const harness = makeHarness({
      config: {
        rooms: [
          { roomId: ROOM_ID, tableId: TEST_TABLE_ID, agentPrincipalIds: [PRINCIPAL], maxHands: 1 },
        ],
      },
    });
    await harness.runtime.start();
    expect(expectStatus(harness.store, TEST_TABLE_ID, TEST_TURN_ID).status).toBe('COMMITTED');

    harness.transport.observation = observationWith({
      handId: 'hand-2',
      turnId: 'turn-2',
      version: 5,
      eventSeq: 11,
      handNumber: 2,
    });
    await harness.runtime.syncNow();

    const second = expectStatus(harness.store, TEST_TABLE_ID, 'turn-2');
    expect(second.status).toBe('FAILED');
    expect(second.errorReason).toContain('room_max_hands_exhausted');
    expect(harness.provider.invocations).toBe(1);
    expect(hasAudit(harness.audits, 'ROOM_MAX_HANDS_EXCEEDED')).toBe(true);
  });

  it('does not spend provider calls when the derived deadline margin is exhausted', () => {
    const now = 1_000_000;
    expect(resolveCallBudgetMs({ state: {}, now, perCallTimeoutMs: 5_000 })).toBe(4_750);
    expect(
      resolveCallBudgetMs({ state: { turnDeadline: now + 1_000 }, now, perCallTimeoutMs: 5_000 }),
    ).toBe(750);
    expect(
      resolveCallBudgetMs({ state: { actionDeadline: now - 1 }, now, perCallTimeoutMs: 5_000 }),
    ).toBe(0);
    expect(
      resolveCallBudgetMs({ state: { deadline: 'ignored' }, now, perCallTimeoutMs: 5_000 }),
    ).toBe(4_750);
  });
});

describe('AgentRuntime cost admission', () => {
  it('denies before HTTP when the declared ceiling exceeds the agent per-call maximum', async () => {
    const harness = makeHarness({ costCeilingUsdMicro: () => 50_000n });
    harness.store.limits.maxCostMicroUsdPerCall = 10_000;
    await harness.runtime.start();

    const decision = expectStatus(harness.store, TEST_TABLE_ID, TEST_TURN_ID);
    expect(decision.status).toBe('FAILED');
    expect(decision.errorReason).toContain('provider_cost_ceiling_exceeded');
    expect(harness.provider.invocations).toBe(0);
    expect(harness.store.listAttempts(decision.id)).toHaveLength(0);
    expect(harness.store.reservations.size).toBe(0);
    expect(hasAudit(harness.audits, 'PROVIDER_COST_CEILING_EXCEEDED')).toBe(true);
  });

  it('admits a zero-priced call under a zero room cost cap', async () => {
    const harness = makeHarness({
      config: {
        rooms: [
          {
            roomId: ROOM_ID,
            tableId: TEST_TABLE_ID,
            agentPrincipalIds: [PRINCIPAL],
            maxCostMicroUsd: 0,
          },
        ],
      },
      script: () => ({ kind: 'valid', costUsdMicro: 0n }),
    });
    harness.store.limits.maxCostMicroUsdPerCall = 0;
    await harness.runtime.start();

    const decision = expectStatus(harness.store, TEST_TABLE_ID, TEST_TURN_ID);
    expect(decision.status).toBe('COMMITTED');
    expect(harness.provider.invocations).toBe(1);
    const reservation = harness.store.reservations.get(`${ROOM_ID}\0${AGENT_ID}`);
    expect(reservation?.callsSettled).toBe(1);
    expect(reservation?.costMicroUsdSettled).toBe(0);
  });

  it('denies any positive per-call reserve under a zero room cost cap', async () => {
    const harness = makeHarness({
      config: {
        rooms: [
          {
            roomId: ROOM_ID,
            tableId: TEST_TABLE_ID,
            agentPrincipalIds: [PRINCIPAL],
            maxCostMicroUsd: 0,
          },
        ],
      },
      costCeilingUsdMicro: () => 10n,
    });
    await harness.runtime.start();

    const decision = expectStatus(harness.store, TEST_TABLE_ID, TEST_TURN_ID);
    expect(decision.status).toBe('FAILED');
    expect(decision.errorReason).toContain('room_reservation_denied:ROOM_RESERVATION_EXCEEDED');
    expect(harness.provider.invocations).toBe(0);
    expect(harness.transport.actionRequests).toHaveLength(0);
    expect(harness.store.reservations.size).toBe(0);
  });

  it('admits two billable calls under one room cap using exact ceilings', async () => {
    const harness = makeHarness({
      config: {
        rooms: [
          {
            roomId: ROOM_ID,
            tableId: TEST_TABLE_ID,
            agentPrincipalIds: [PRINCIPAL],
            maxCostMicroUsd: 120,
          },
        ],
      },
      script: () => ({ kind: 'valid', costUsdMicro: 7n }),
      costCeilingUsdMicro: () => 60n,
    });
    await harness.runtime.start();
    expect(expectStatus(harness.store, TEST_TABLE_ID, TEST_TURN_ID).status).toBe('COMMITTED');

    harness.transport.observation = observationWith({ turnId: 'turn-2', version: 5, eventSeq: 11 });
    await harness.runtime.syncNow();
    expect(expectStatus(harness.store, TEST_TABLE_ID, 'turn-2').status).toBe('COMMITTED');
    expect(harness.provider.invocations).toBe(2);

    const reservation = harness.store.reservations.get(`${ROOM_ID}\0${AGENT_ID}`);
    expect(reservation?.callsSettled).toBe(2);
    expect(reservation?.costMicroUsdSettled).toBe(14);
    expect(reservation?.costMicroUsdReserved).toBe(0);
  });

  it('denies a call when the incoming reserve exceeds the room call cap', async () => {
    const harness = makeHarness({
      config: {
        rooms: [
          {
            roomId: ROOM_ID,
            tableId: TEST_TABLE_ID,
            agentPrincipalIds: [PRINCIPAL],
            maxCalls: 1,
          },
        ],
      },
    });
    // Another agent already consumed the room's single call.
    harness.store.setOtherAgentLimits('other-agent', {
      maxCallsPerRoom: 10,
      maxCostMicroUsdPerRoom: 1_000_000,
      maxCostMicroUsdPerCall: 100,
    });
    harness.store.reserveCall(ROOM_ID, 'other-agent', { maxCalls: 1 });

    await harness.runtime.start();

    const decision = expectStatus(harness.store, TEST_TABLE_ID, TEST_TURN_ID);
    expect(decision.status).toBe('FAILED');
    expect(decision.errorReason).toContain('room_reservation_denied:ROOM_RESERVATION_EXCEEDED');
    expect(harness.provider.invocations).toBe(0);
  });
});

describe('AgentRuntime socket triggers and authority', () => {
  it('coalesces socket observations into one REST resync and ignores their payload', async () => {
    const harness = makeHarness();
    harness.transport.observation = observationWith({ legalActions: [] });
    await harness.runtime.start();
    const afterStart = harness.transport.fetchObservationCalls;

    // REST now exposes a turn; socket payloads claim a different, bogus turn.
    harness.transport.observation = observationWith({ turnId: 'turn-rest' });
    const bogus = observationWith({ turnId: 'turn-socket-bogus' });
    for (let index = 0; index < 5; index += 1) {
      harness.transport.emitObservation(TEST_TABLE_ID, bogus);
    }
    await harness.runtime.syncNow();

    expect(harness.transport.fetchObservationCalls - afterStart).toBe(1);
    const decision = expectStatus(harness.store, TEST_TABLE_ID, 'turn-rest');
    expect(decision.status).toBe('COMMITTED');
    expect(harness.store.getDecisionForTurn(TEST_TABLE_ID, 'turn-socket-bogus', PRINCIPAL)).toBeNull();
  });
});

describe('AgentRuntime speech at-most-once', () => {
  it('marks the durable intention and sends once after commit', async () => {
    const harness = makeHarness({
      config: { speech: 'AFTER_COMMIT' },
      script: () => ({ kind: 'valid', arguments: { ...validActionArguments(), speech: 'nice hand' } }),
    });
    await harness.runtime.start();

    const decision = expectStatus(harness.store, TEST_TABLE_ID, TEST_TURN_ID);
    expect(decision.status).toBe('COMMITTED');
    expect(harness.transport.sentChats).toHaveLength(1);
    expect(harness.transport.sentChats[0]!.body).toBe('nice hand');
    expect(harness.store.speechIntended.has(decision.id)).toBe(true);
    expect(hasAudit(harness.audits, 'SPEECH_SENT')).toBe(true);
  });

  it('never resends when the send outcome is ambiguous and never rolls back the commit', async () => {
    const harness = makeHarness({
      config: { speech: 'AFTER_COMMIT' },
      script: () => ({ kind: 'valid', arguments: { ...validActionArguments(), speech: 'hello' } }),
    });
    harness.transport.chatSendError = new Error('chat transport down');
    await harness.runtime.start();

    const decision = expectStatus(harness.store, TEST_TABLE_ID, TEST_TURN_ID);
    expect(decision.status).toBe('COMMITTED');
    expect(harness.transport.sentChats).toHaveLength(1);
    expect(harness.store.speechIntended.has(decision.id)).toBe(true);

    // A later restart over the committed decision must not retry the speech.
    const second = new AgentRuntime(makeConfig({ speech: 'AFTER_COMMIT' }), {
      transport: harness.transport,
      store: harness.store,
      providerFactory: makeFakeProviderFactory(() => ({ kind: 'valid' })).factory,
    });
    await second.start();
    expect(harness.transport.sentChats).toHaveLength(1);
    expect(hasAudit(harness.audits, 'SPEECH_FAILED')).toBe(true);
  });

  it('never sends when the store denies the write-once intention', async () => {
    const harness = makeHarness({
      config: { speech: 'AFTER_COMMIT' },
      script: () => ({ kind: 'valid', arguments: { ...validActionArguments(), speech: 'hi' } }),
    });
    harness.store.speechIntentionDenied = true;
    await harness.runtime.start();

    expect(expectStatus(harness.store, TEST_TABLE_ID, TEST_TURN_ID).status).toBe('COMMITTED');
    expect(harness.transport.sentChats).toHaveLength(0);
    expect(hasAudit(harness.audits, 'SPEECH_AT_MOST_ONCE_ABANDONED')).toBe(true);
  });

  it('sends no speech by default and marks no intention', async () => {
    const harness = makeHarness({
      script: () => ({ kind: 'valid', arguments: { ...validActionArguments(), speech: 'hi' } }),
    });
    await harness.runtime.start();
    expect(harness.transport.sentChats).toHaveLength(0);
    expect(harness.store.speechIntended.size).toBe(0);
  });
});

describe('AgentRuntime concurrency', () => {
  it('bounds concurrent provider exchanges through a shared limiter', async () => {
    const limiter = new DecisionConcurrencyLimiter(1);
    const store = new MemoryDecisionStore();
    const transport = new FakeTransport();
    transport.observation = observationWith({});
    transport.tableObservations.set('table-2', observationWith({ tableId: 'table-2' }));
    let active = 0;
    let maxActive = 0;
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider = makeFakeProviderFactory(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await gate;
      active -= 1;
      return { kind: 'valid' };
    });
    const runtime = new AgentRuntime(
      makeConfig({
        rooms: [
          { roomId: ROOM_ID, tableId: TEST_TABLE_ID, agentPrincipalIds: [PRINCIPAL] },
          { roomId: 'room-2', tableId: 'table-2', agentPrincipalIds: [PRINCIPAL] },
        ],
      }),
      { transport, store, providerFactory: provider.factory, limiter },
    );
    // Second table needs its own observation; fetchObservation is shared here,
    // but the provider gate is what proves the bound.
    const starting = runtime.start();
    await provider.waitForInvocation(1);
    expect(provider.invocations).toBe(1);
    release?.();
    await starting;
    expect(maxActive).toBe(1);
    expect(provider.invocations).toBe(2);
  });

  it('classifies action failures deterministically', () => {
    expect(classifyActionFailure(Object.assign(new Error('x'), { statusCode: 409 }))).toBe('STALE');
    expect(classifyActionFailure(Object.assign(new Error('x'), { statusCode: 429 }))).toBe('RETRY');
    expect(classifyActionFailure(Object.assign(new Error('x'), { statusCode: 502 }))).toBe('RETRY');
    expect(classifyActionFailure(Object.assign(new Error('illegal action'), { code: 'ILLEGAL_ACTION' }))).toBe('STALE');
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(classifyActionFailure(abort)).toBe('ABORT');
  });
});

describe('AgentRuntime real provider integration', () => {
  it('persists exact provider request/response through the real transport and never logs the key', async () => {
    const server = await startFakeProvider(() => ({
      body: toolCallResponse(validActionArguments()),
    }));
    const store = new MemoryDecisionStore();
    const transport = new FakeTransport();
    transport.observation = observationWith({});
    const audits: AgentAuditEvent[] = [];
    const apiKey = 'sekret-provider-key';
    const runtime = new AgentRuntime(makeConfig(), {
      transport,
      store,
      providerFactory: createProductDecisionProviderFactory({
        baseUrl: server.url,
        model: 'gpt-test',
        apiKey,
        inputUsdMicroPerMillionTokens: 1_000,
        outputUsdMicroPerMillionTokens: 2_000,
      }),
      audit: (event) => audits.push(event),
    });
    try {
      await runtime.start();
    } finally {
      await server.close();
    }

    const decision = expectStatus(store, TEST_TABLE_ID, TEST_TURN_ID);
    expect(decision.status).toBe('COMMITTED');
    expect(server.exchanges).toHaveLength(1);
    const body = JSON.parse(server.exchanges[0]!.body) as { model?: unknown };
    expect(body.model).toBe('gpt-test');
    const json = JSON.stringify(audits);
    expect(json).not.toContain(apiKey);
    const attempt = store.listAttempts(decision.id)[0]!;
    expect(attempt.status).toBe('SUCCEEDED');
    expect(attempt.costMicroUsd).toBeGreaterThan(0);
    expect(attempt.model).toBe('gpt-test');
    // The persisted request is the exact sanitized provider body.
    expect(attempt.requestJson).toBe(server.exchanges[0]!.body);
  });

  it('sanitizes the source chat before persistence with the provider secret policy', async () => {
    const server = await startFakeProvider(() => ({
      body: toolCallResponse(validActionArguments()),
    }));
    const store = new MemoryDecisionStore();
    const transport = new FakeTransport();
    transport.observation = observationWith({});
    const apiKey = 'sekret-provider-key';
    transport.chat = [chatFixture(3, `my key is ${apiKey} do not tell`)];
    const runtime = new AgentRuntime(makeConfig(), {
      transport,
      store,
      providerFactory: createProductDecisionProviderFactory({
        baseUrl: server.url,
        model: 'gpt-test',
        apiKey,
        inputUsdMicroPerMillionTokens: 1_000,
        outputUsdMicroPerMillionTokens: 2_000,
      }),
      audit: () => {},
    });
    try {
      await runtime.start();
    } finally {
      await server.close();
    }

    const decision = expectStatus(store, TEST_TABLE_ID, TEST_TURN_ID);
    expect(decision.status).toBe('COMMITTED');
    expect(decision.source?.publicChat[0]!.body).not.toContain(apiKey);
    expect(server.exchanges[0]!.body).not.toContain(apiKey);
  });

  it('records an HTTP 200 validation failure as a FAILED attempt, never a success', async () => {
    const server = await startFakeProvider(() => ({
      body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'no tool' } }] }),
    }));
    const store = new MemoryDecisionStore();
    const transport = new FakeTransport();
    transport.observation = observationWith({});
    const runtime = new AgentRuntime(makeConfig(), {
      transport,
      store,
      providerFactory: createProductDecisionProviderFactory({
        baseUrl: server.url,
        model: 'gpt-test',
        inputUsdMicroPerMillionTokens: 1_000,
        outputUsdMicroPerMillionTokens: 2_000,
      }),
      audit: () => {},
    });
    try {
      await runtime.start();
    } finally {
      await server.close();
    }

    const decision = expectStatus(store, TEST_TABLE_ID, TEST_TURN_ID);
    expect(decision.status).toBe('FAILED');
    const attempts = store.listAttempts(decision.id);
    expect(attempts).toHaveLength(2);
    expect(attempts.every((attempt) => attempt.status === 'FAILED')).toBe(true);
    expect(attempts.every((attempt) => attempt.responseJson !== null)).toBe(true);
    expect(server.exchanges).toHaveLength(2);
    expect(transport.actionRequests).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RealStoreHarness {
  store: ProductStore;
  room: ProductRoom;
  cleanup(): void;
}

function openRealStore(): RealStoreHarness {
  const directory = mkdtempSync(join(tmpdir(), 'nlhe-runtime-store-'));
  const store = ProductStore.open({
    path: join(directory, 'product.db'),
    migrationsDir: join(process.cwd(), 'migrations'),
  });
  const room = store.createRoom({
    name: 'Runtime Room',
    policy: {
      kind: 'SPONSORED',
      participants: [{ kind: 'HUMAN' }, { kind: 'AGENT', agentId: AGENT_ID }],
    },
  });
  store.addParticipant(room.id, { principalId: 'human-1', kind: 'HUMAN' });
  store.addParticipant(room.id, { principalId: PRINCIPAL, kind: 'AGENT', agentId: AGENT_ID });
  store.openRoomForRoster(room.id);
  store.beginProvisioning(room.id);
  store.activateRoom(room.id, { tableId: TEST_TABLE_ID });
  store.upsertAgentConfig({
    id: AGENT_ID,
    name: 'Runtime Agent',
    model: 'gpt-test',
    provider: 'openai-compatible',
    baseUrl: 'https://provider.example/v1',
    keyEnv: 'RUNTIME_TEST_KEY',
    principalId: PRINCIPAL,
    promptPolicyId: seatPromptPolicy.id,
    promptPolicyHash: seatPromptPolicy.hash,
    pricing: { inputMicroUsdPerMillionTokens: 1_000, outputMicroUsdPerMillionTokens: 2_000 },
    limits: {
      maxCallsPerRoom: 10,
      maxCostMicroUsdPerRoom: 1_000_000,
      maxCostMicroUsdPerCall: 100_000,
    },
    enabled: true,
  });
  store.upsertAgentConfig({
    id: AGENT_2_ID,
    name: 'Other Agent',
    model: 'gpt-test',
    provider: 'openai-compatible',
    baseUrl: 'https://provider.example/v1',
    keyEnv: 'RUNTIME_TEST_KEY_2',
    principalId: 'principal-other',
    promptPolicyId: seatPromptPolicy.id,
    promptPolicyHash: seatPromptPolicy.hash,
    pricing: { inputMicroUsdPerMillionTokens: 0, outputMicroUsdPerMillionTokens: 0 },
    limits: {
      maxCallsPerRoom: 10,
      maxCostMicroUsdPerRoom: 1_000_000,
      maxCostMicroUsdPerCall: 60_000,
    },
    enabled: true,
  });
  return {
    store,
    room,
    cleanup() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

describe('AgentRuntime real ProductStore integration', () => {
  it('drives a full decision through the actual store port with request hash and metadata', async () => {
    const real = openRealStore();
    const server = await startFakeProvider(() => ({
      body: toolCallResponse(validActionArguments()),
    }));
    const transport = new FakeTransport();
    transport.observation = observationWith({});
    const runtime = new AgentRuntime(
      makeConfig({
        speech: 'AFTER_COMMIT',
        rooms: [
          {
            roomId: real.room.id,
            tableId: TEST_TABLE_ID,
            agentPrincipalIds: [PRINCIPAL],
            expectedPlayerId: 'p0',
          },
        ],
      }),
      {
        transport,
        store: real.store,
        providerFactory: createProductDecisionProviderFactory({
          baseUrl: server.url,
          model: 'gpt-test',
          inputUsdMicroPerMillionTokens: 1_000,
          outputUsdMicroPerMillionTokens: 2_000,
        }),
      },
    );
    try {
      await runtime.start();
    } finally {
      await server.close();
    }

    try {
      const decision = real.store.getDecisionForTurn(TEST_TABLE_ID, TEST_TURN_ID, PRINCIPAL);
      expect(decision).not.toBeNull();
      expect(decision!.status).toBe('COMMITTED');
      expect(decision!.requestJson).not.toBeNull();

      const attempts = real.store.listAttempts(decision!.id);
      expect(attempts).toHaveLength(1);
      const attempt = attempts[0]!;
      expect(attempt.status).toBe('SUCCEEDED');
      expect(attempt.requestJson).toBe(server.exchanges[0]!.body);
      expect(attempt.requestHash).toBe(
        createHash('sha256').update(attempt.requestJson, 'utf8').digest('hex'),
      );
      expect(attempt.requestMetadataJson).not.toBeNull();
      expect(attempt.requestMetadataJson).not.toContain('authorization');
      expect(attempt.requestMetadataJson).not.toContain('Bearer');
      expect(attempt.requestMetadataJson).not.toContain('apiKey');

      const reservation = real.store.getReservation(real.room.id, AGENT_ID);
      expect(reservation?.callsReserved).toBe(0);
      expect(reservation?.callsSettled).toBe(1);
      expect(real.store.listRoomReservations(real.room.id)).toHaveLength(1);

      // The store owns the write-once speech intention; a second claim is denied.
      expect(transport.sentChats).toHaveLength(1);
      expect(real.store.markSpeechIntended(decision!.id)).toBe(false);
    } finally {
      real.cleanup();
    }
  });

  it('enforces the aggregate room cap through the actual store reservations', async () => {
    const real = openRealStore();
    // Another in-flight call already holds the room's single allowed call.
    real.store.reserveCall(real.room.id, AGENT_ID);
    const transport = new FakeTransport();
    transport.observation = observationWith({});
    const provider = makeFakeProviderFactory(() => ({ kind: 'valid' }));
    const runtime = new AgentRuntime(
      makeConfig({
        rooms: [
          {
            roomId: real.room.id,
            tableId: TEST_TABLE_ID,
            agentPrincipalIds: [PRINCIPAL],
            maxCalls: 1,
          },
        ],
      }),
      {
        transport,
        store: real.store,
        providerFactory: provider.factory,
      },
    );
    try {
      await runtime.start();
      const decision = real.store.getDecisionForTurn(TEST_TABLE_ID, TEST_TURN_ID, PRINCIPAL);
      expect(decision?.status).toBe('FAILED');
      expect(decision?.errorReason).toContain('room_reservation_denied:ROOM_RESERVATION_EXCEEDED');
      expect(provider.invocations).toBe(0);
      expect(transport.actionRequests).toHaveLength(0);
      // The pre-existing reservation is untouched by the denied admission.
      expect(real.store.getReservation(real.room.id, AGENT_ID)?.callsReserved).toBe(1);
    } finally {
      real.cleanup();
    }
  });

  it('denies before HTTP when the room cost remaining is below the per-call reserve', async () => {
    const real = openRealStore();
    // agent-2 holds 60_000 of the 100_000 room cost cap; agent-1's exact
    // ceiling of 50_000 would push the room over.
    real.store.reserveCall(real.room.id, AGENT_2_ID);
    const transport = new FakeTransport();
    transport.observation = observationWith({});
    const provider = makeFakeProviderFactory(() => ({ kind: 'valid' }), () => 50_000n);
    const runtime = new AgentRuntime(
      makeConfig({
        rooms: [
          {
            roomId: real.room.id,
            tableId: TEST_TABLE_ID,
            agentPrincipalIds: [PRINCIPAL],
            maxCostMicroUsd: 100_000,
          },
        ],
      }),
      {
        transport,
        store: real.store,
        providerFactory: provider.factory,
      },
    );
    try {
      await runtime.start();
      const decision = real.store.getDecisionForTurn(TEST_TABLE_ID, TEST_TURN_ID, PRINCIPAL);
      expect(decision?.status).toBe('FAILED');
      expect(decision?.errorReason).toContain('room_reservation_denied:ROOM_RESERVATION_EXCEEDED');
      expect(provider.invocations).toBe(0);
      expect(transport.actionRequests).toHaveLength(0);
      expect(real.store.getReservation(real.room.id, AGENT_ID)).toBeNull();
    } finally {
      real.cleanup();
    }
  });

  it('admits room reservations atomically across agents (incoming > remaining rejects)', () => {
    const real = openRealStore();
    try {
      real.store.reserveCall(real.room.id, AGENT_ID, { maxCalls: 1 });
      let thrown: unknown = null;
      try {
        real.store.reserveCall(real.room.id, AGENT_2_ID, { maxCalls: 1 });
      } catch (error) {
        thrown = error;
      }
      expect((thrown as { code?: string } | null)?.code).toBe('ROOM_RESERVATION_EXCEEDED');
      expect(real.store.getReservation(real.room.id, AGENT_2_ID)).toBeNull();
    } finally {
      real.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

describe('AgentRuntime configuration guards', () => {
  function validDeps(): AgentRuntimeDependencies {
    return {
      transport: new FakeTransport(),
      store: new MemoryDecisionStore(),
      providerFactory: makeFakeProviderFactory(() => ({ kind: 'valid' })).factory,
    };
  }

  it('rejects malformed runtime configuration and dependencies', () => {
    expect(() => new AgentRuntime(null as unknown as AgentRuntimeConfig, validDeps())).toThrow(
      TypeError,
    );
    expect(() => new AgentRuntime(makeConfig(), null as unknown as AgentRuntimeDependencies)).toThrow(
      TypeError,
    );
    expect(() => new AgentRuntime(makeConfig({ agentId: '' }), validDeps())).toThrow(TypeError);
    expect(() => new AgentRuntime(makeConfig({ principalId: ' ' }), validDeps())).toThrow(TypeError);
    expect(() => new AgentRuntime(makeConfig({ promptPolicyId: '' }), validDeps())).toThrow(TypeError);
    expect(() =>
      new AgentRuntime(makeConfig({ promptPolicyHash: 'not-the-policy-hash' }), validDeps()),
    ).toThrow();
    expect(() => new AgentRuntime(makeConfig({ perCallTimeoutMs: 0 }), validDeps())).toThrow(
      RangeError,
    );
    expect(() => new AgentRuntime(makeConfig({ maxProviderAttempts: 3 }), validDeps())).toThrow(
      RangeError,
    );
    expect(() =>
      new AgentRuntime(
        makeConfig({ rooms: 'not-an-array' as unknown as AgentRuntimeConfig['rooms'] }),
        validDeps(),
      ),
    ).toThrow(TypeError);
    expect(() => new AgentRuntime(makeConfig({ safetyMarginMs: -1 }), validDeps())).toThrow(
      RangeError,
    );
    expect(() => new AgentRuntime(makeConfig({ overallDeadlineAtMs: 0 }), validDeps())).toThrow(
      RangeError,
    );
    expect(() => new AgentRuntime(makeConfig({ overallRuntimeMs: -5 }), validDeps())).toThrow(
      RangeError,
    );
    expect(() =>
      new AgentRuntime(makeConfig({ socketResyncIntervalMs: 0 }), validDeps()),
    ).toThrow(RangeError);
  });

  it('rejects malformed provider factory configuration', () => {
    const rates = { inputUsdMicroPerMillionTokens: 1_000, outputUsdMicroPerMillionTokens: 2_000 };
    expect(() => createProductDecisionProviderFactory({ baseUrl: '', model: 'm', ...rates })).toThrow(
      TypeError,
    );
    expect(() =>
      createProductDecisionProviderFactory({ baseUrl: 'https://x.test', model: ' ', ...rates }),
    ).toThrow(TypeError);
    expect(() =>
      createProductDecisionProviderFactory({ baseUrl: 'not a url', model: 'm', ...rates }),
    ).toThrow(TypeError);
    expect(() =>
      createProductDecisionProviderFactory({ baseUrl: 'file:///no-host', model: 'm', ...rates }),
    ).toThrow(TypeError);
    expect(() =>
      createProductDecisionProviderFactory({
        baseUrl: 'https://x.test',
        model: 'm',
        ...rates,
        inputUsdMicroPerMillionTokens: -1,
      }),
    ).toThrow(RangeError);
    expect(() =>
      createProductDecisionProviderFactory({
        baseUrl: 'https://x.test',
        model: 'm',
        ...rates,
        outputUsdMicroPerMillionTokens: 1.5,
      }),
    ).toThrow(RangeError);
  });

  it('classifies message-only and non-object action failures', () => {
    expect(
      classifyActionFailure(Object.assign(new Error('turn mismatch'), { statusCode: 400 })),
    ).toBe('STALE');
    expect(classifyActionFailure(new Error('turn mismatch'))).toBe('RETRY');
    expect(classifyActionFailure(null)).toBe('RETRY');
    expect(classifyActionFailure('boom')).toBe('RETRY');
  });
});

describe('AgentRuntime start and shutdown guards', () => {
  it('covers getters, duplicate room bindings and repeated start', async () => {
    const harness = makeHarness({
      config: {
        rooms: [
          { roomId: ROOM_ID, tableId: TEST_TABLE_ID, agentPrincipalIds: [PRINCIPAL] },
          { roomId: 'room-duplicate', tableId: TEST_TABLE_ID, agentPrincipalIds: [PRINCIPAL] },
        ],
      },
    });
    await harness.runtime.start();
    expect(harness.runtime.isRunning).toBe(true);
    expect(harness.runtime.isStopping).toBe(false);
    expect(harness.runtime.servedTableIds).toEqual([TEST_TABLE_ID]);
    await harness.runtime.start();
    expect(harness.runtime.servedTableIds).toEqual([TEST_TABLE_ID]);

    const stopping = harness.runtime.stop();
    expect(harness.runtime.isStopping).toBe(true);
    await stopping;
    expect(harness.runtime.isRunning).toBe(false);
    await harness.runtime.syncNow();
  });

  it('rejects a transport that authenticates no principal', async () => {
    const harness = makeHarness();
    harness.transport.connectPrincipal = null;
    await expect(harness.runtime.start()).rejects.toBeInstanceOf(AgentAuthorityError);
  });

  it('cleans up trigger subscriptions when start fails', async () => {
    const harness = makeHarness({
      config: {
        rooms: [
          { roomId: ROOM_ID, tableId: TEST_TABLE_ID, agentPrincipalIds: [PRINCIPAL] },
          { roomId: 'room-2', tableId: 'table-2', agentPrincipalIds: [PRINCIPAL] },
        ],
      },
    });
    let subscriptions = 0;
    harness.transport.onObservation = (tableId) => {
      if (tableId === 'table-2') throw new Error('trigger subscription failed');
      subscriptions += 1;
      return () => {
        subscriptions -= 1;
      };
    };
    await expect(harness.runtime.start()).rejects.toThrow('trigger subscription failed');
    expect(subscriptions).toBe(0);
  });

  it('resyncs on the periodic timer without socket payloads', async () => {
    const harness = makeHarness({ config: { socketResyncIntervalMs: 5 } });
    await harness.runtime.start();
    const afterStart = harness.transport.fetchObservationCalls;
    await harness.transport.waitForFetch(afterStart + 1);
    await harness.runtime.stop();
  });
});

describe('AgentRuntime defensive sync paths', () => {
  it('audits observation failures and mismatched table observations', async () => {
    const failed = makeHarness();
    failed.transport.observationError = new Error('observation down');
    await failed.runtime.start();
    expect(hasAudit(failed.audits, 'OBSERVATION_FAILED')).toBe(true);
    expect(failed.provider.invocations).toBe(0);

    const mismatch = makeHarness();
    mismatch.transport.observation = observationWith({ tableId: 'table-x' });
    await mismatch.runtime.start();
    expect(hasAudit(mismatch.audits, 'OBSERVATION_IDENTITY_MISMATCH')).toBe(true);
    expect(mismatch.provider.invocations).toBe(0);
  });

  it('audits store listing failures as sync failures', async () => {
    const broken = makeHarness();
    broken.store.listDecisions = () => {
      throw new Error('db down');
    };
    await broken.runtime.start();
    expect(hasAudit(broken.audits, 'SYNC_FAILED')).toBe(true);
  });

  it('skips observation conflicts and surfaces unexpected observe failures', async () => {
    const conflictStore = new MemoryDecisionStore();
    const observation = observationWith({});
    const existing = conflictStore.observeDecision({
      tableId: TEST_TABLE_ID,
      turnId: TEST_TURN_ID,
      principalId: PRINCIPAL,
      roomId: ROOM_ID,
      observation,
      observationHash: computeObservationHash(observation),
      source: null,
      promptPolicyId: seatPromptPolicy.id,
      eventCursor: observation.eventSeq,
    });
    conflictStore.decisions.set(existing.id, {
      ...existing,
      status: 'FAILED',
      errorReason: 'terminal',
      observationHash: 'f'.repeat(64),
    });
    conflictStore.getDecisionForTurn = () => null;
    const conflictHarness = makeHarness({ store: conflictStore });
    await conflictHarness.runtime.start();
    expect(hasAudit(conflictHarness.audits, 'OBSERVATION_CONFLICT')).toBe(true);
    expect(conflictHarness.provider.invocations).toBe(0);

    const brokenStore = new MemoryDecisionStore();
    brokenStore.observeDecision = () => {
      throw new Error('observe down');
    };
    const brokenHarness = makeHarness({ store: brokenStore });
    await brokenHarness.runtime.start();
    expect(hasAudit(brokenHarness.audits, 'SYNC_FAILED')).toBe(true);
  });

  it('filters chat to the allowed source and tolerates chat failures', async () => {
    const harness = makeHarness({ config: { chatSelection: { maxMessages: 2 } } });
    harness.transport.chat = [
      chatFixture(3, 'kept'),
      { messageId: 'broken' } as unknown as ChatMessage,
      chatFixture(2, 'foreign table', { tableId: 'table-x' }),
      chatFixture(2, 'foreign hand', { handId: 'hand-x' }),
      chatFixture(50, 'future'),
    ];
    await harness.runtime.start();
    const decision = expectStatus(harness.store, TEST_TABLE_ID, TEST_TURN_ID);
    expect(decision.source?.publicChat.map((entry) => entry.body)).toEqual(['kept']);

    const zero = makeHarness({ config: { chatSelection: { maxMessages: 0 } } });
    zero.transport.chat = [chatFixture(3, 'ignored')];
    await zero.runtime.start();
    expect(expectStatus(zero.store, TEST_TABLE_ID, TEST_TURN_ID).source?.publicChat).toEqual([]);

    const chatError = makeHarness();
    chatError.transport.chatError = new Error('chat down');
    await chatError.runtime.start();
    expect(hasAudit(chatError.audits, 'CHAT_FETCH_FAILED')).toBe(true);
    expect(expectStatus(chatError.store, TEST_TABLE_ID, TEST_TURN_ID).status).toBe('COMMITTED');
  });

  it('marks pending decisions stale when the turn or hand was superseded', async () => {
    const turnStore = new MemoryDecisionStore();
    const oldObservation = observationWith({ turnId: 'turn-old' });
    const oldDecision = turnStore.observeDecision({
      tableId: TEST_TABLE_ID,
      turnId: 'turn-old',
      principalId: PRINCIPAL,
      roomId: ROOM_ID,
      observation: oldObservation,
      observationHash: computeObservationHash(oldObservation),
      source: null,
      promptPolicyId: seatPromptPolicy.id,
      eventCursor: oldObservation.eventSeq,
    });
    const turnHarness = makeHarness({ store: turnStore });
    turnHarness.transport.observation = observationWith({ turnId: 'turn-new' });
    await turnHarness.runtime.start();
    expect(turnStore.getDecision(oldDecision.id)?.status).toBe('STALE');
    expect(turnStore.getDecision(oldDecision.id)?.errorReason).toContain('turn_superseded');
    expect(expectStatus(turnStore, TEST_TABLE_ID, 'turn-new').status).toBe('COMMITTED');

    const handStore = new MemoryDecisionStore();
    const oldHandObservation = observationWith({ handId: 'hand-a' });
    const oldHandDecision = handStore.observeDecision({
      tableId: TEST_TABLE_ID,
      turnId: TEST_TURN_ID,
      principalId: PRINCIPAL,
      roomId: ROOM_ID,
      observation: oldHandObservation,
      observationHash: computeObservationHash(oldHandObservation),
      source: null,
      promptPolicyId: seatPromptPolicy.id,
      eventCursor: oldHandObservation.eventSeq,
    });
    const handHarness = makeHarness({ store: handStore });
    handHarness.transport.observation = observationWith({ handId: 'hand-b' });
    await handHarness.runtime.start();
    expect(handStore.getDecision(oldHandDecision.id)?.status).toBe('STALE');
    expect(handStore.getDecision(oldHandDecision.id)?.errorReason).toContain('hand_superseded');
  });

  it('fails decisions with corrupted stored observation integrity', async () => {
    const corruptStore = new MemoryDecisionStore();
    const observation = observationWith({});
    const observed = corruptStore.observeDecision({
      tableId: TEST_TABLE_ID,
      turnId: TEST_TURN_ID,
      principalId: PRINCIPAL,
      roomId: ROOM_ID,
      observation,
      observationHash: computeObservationHash(observation),
      source: null,
      promptPolicyId: seatPromptPolicy.id,
      eventCursor: observation.eventSeq,
    });
    corruptStore.decisions.set(observed.id, { ...observed, observationHash: 'a'.repeat(64) });
    const corruptHarness = makeHarness({ store: corruptStore });
    await corruptHarness.runtime.start();
    expect(corruptStore.getDecision(observed.id)?.status).toBe('FAILED');
    expect(corruptStore.getDecision(observed.id)?.errorReason).toContain(
      'observation_integrity_failure',
    );
    expect(corruptHarness.provider.invocations).toBe(0);

    const recordedStore = new MemoryDecisionStore();
    const recordedObservation = observationWith({});
    const recorded = recordedStore.observeDecision({
      tableId: TEST_TABLE_ID,
      turnId: TEST_TURN_ID,
      principalId: PRINCIPAL,
      roomId: ROOM_ID,
      observation: recordedObservation,
      observationHash: computeObservationHash(recordedObservation),
      source: null,
      promptPolicyId: seatPromptPolicy.id,
      eventCursor: recordedObservation.eventSeq,
    });
    const started = recordedStore.startAttempt(recorded.id, JSON.stringify({ placeholder: true }));
    if (started.kind !== 'started') throw new Error('expected started');
    recordedStore.recordAttemptResponse(recorded.id, started.attempt.id, {
      status: 'SUCCEEDED',
      responseJson: toolCallResponse(validActionArguments()),
      model: MODEL,
      provider: PROVIDER,
      promptPolicyId: seatPromptPolicy.id,
      usage: { promptTokens: 10, completionTokens: 2, costMicroUsd: 5, latencyMs: 1 },
    });
    recordedStore.decisions.set(recorded.id, {
      ...recordedStore.getDecision(recorded.id)!,
      observationHash: 'b'.repeat(64),
    });
    const recordedHarness = makeHarness({
      store: recordedStore,
      script: () => {
        throw new Error('provider must not be called');
      },
    });
    await recordedHarness.runtime.start();
    expect(recordedStore.getDecision(recorded.id)?.status).toBe('FAILED');
    expect(recordedStore.getDecision(recorded.id)?.errorReason).toContain(
      'observation_integrity_failure',
    );
    expect(recordedHarness.transport.actionRequests).toHaveLength(0);

    const missingStore = new MemoryDecisionStore();
    const missingObservation = observationWith({});
    const missing = missingStore.observeDecision({
      tableId: TEST_TABLE_ID,
      turnId: TEST_TURN_ID,
      principalId: PRINCIPAL,
      roomId: ROOM_ID,
      observation: missingObservation,
      observationHash: computeObservationHash(missingObservation),
      source: null,
      promptPolicyId: seatPromptPolicy.id,
      eventCursor: missingObservation.eventSeq,
    });
    missingStore.decisions.set(missing.id, { ...missing, status: 'PROVIDER_RECORDED' });
    const missingHarness = makeHarness({
      store: missingStore,
      script: () => {
        throw new Error('provider must not be called');
      },
    });
    await missingHarness.runtime.start();
    expect(missingStore.getDecision(missing.id)?.status).toBe('FAILED');
    expect(missingStore.getDecision(missing.id)?.errorReason).toContain('recorded_response_missing');
  });
});

describe('AgentRuntime provider and action edge paths', () => {
  it('handles attempt-start contention, unexpected store failures and recorded reuse', async () => {
    const contended = makeHarness();
    contended.store.startAttempt = () => {
      throw new FakeStoreError('ATTEMPT_IN_FLIGHT');
    };
    await contended.runtime.start();
    expect(contended.provider.invocations).toBe(0);
    expect(hasAudit(contended.audits, 'TRANSITION_CONTENDED')).toBe(true);

    const broken = makeHarness();
    broken.store.startAttempt = () => {
      throw new Error('unexpected store failure');
    };
    await broken.runtime.start();
    expect(hasAudit(broken.audits, 'SYNC_FAILED')).toBe(true);

    const store = new MemoryDecisionStore();
    const observation = observationWith({});
    const decision = store.observeDecision({
      tableId: TEST_TABLE_ID,
      turnId: TEST_TURN_ID,
      principalId: PRINCIPAL,
      roomId: ROOM_ID,
      observation,
      observationHash: computeObservationHash(observation),
      source: null,
      promptPolicyId: seatPromptPolicy.id,
      eventCursor: observation.eventSeq,
    });
    const started = store.startAttempt(decision.id, JSON.stringify({ placeholder: true }));
    if (started.kind !== 'started') throw new Error('expected started');
    store.recordAttemptResponse(decision.id, started.attempt.id, {
      status: 'SUCCEEDED',
      responseJson: toolCallResponse(validActionArguments()),
      model: MODEL,
      provider: PROVIDER,
      promptPolicyId: seatPromptPolicy.id,
      usage: { promptTokens: 10, completionTokens: 2, costMicroUsd: 5, latencyMs: 1 },
    });
    const recordedAttempt = store.listAttempts(decision.id)[0]!;
    // Simulate the race where the drive read an older OBSERVED projection while
    // startAttempt already sees the recorded success and returns reuse.
    const realGetDecision = store.getDecision.bind(store);
    let getCalls = 0;
    store.getDecision = (id: string) => {
      getCalls += 1;
      const current = realGetDecision(id);
      if (getCalls === 1 && current !== null) return { ...current, status: 'OBSERVED' };
      return current;
    };
    store.startAttempt = () => ({ kind: 'reuse', attempt: recordedAttempt });
    const harness = makeHarness({
      store,
      script: () => {
        throw new Error('provider must not be called');
      },
    });
    await harness.runtime.start();
    expect(store.getDecision(decision.id)?.status).toBe('COMMITTED');
    expect(harness.provider.invocations).toBe(0);
    expect(harness.transport.actionRequests).toHaveLength(1);
    expect(hasAudit(harness.audits, 'PROVIDER_RESPONSE_REUSED')).toBe(true);
  });

  it('survives abandoned-attempt recovery contention and inconsistent states', async () => {
    const contendedStore = new MemoryDecisionStore();
    const observation = observationWith({});
    const decision = contendedStore.observeDecision({
      tableId: TEST_TABLE_ID,
      turnId: TEST_TURN_ID,
      principalId: PRINCIPAL,
      roomId: ROOM_ID,
      observation,
      observationHash: computeObservationHash(observation),
      source: null,
      promptPolicyId: seatPromptPolicy.id,
      eventCursor: observation.eventSeq,
    });
    const started = contendedStore.startAttempt(decision.id, JSON.stringify({ placeholder: true }));
    if (started.kind !== 'started') throw new Error('expected started');
    contendedStore.recordAttemptResponse = () => {
      throw new FakeStoreError('DECISION_STATE');
    };
    const contended = makeHarness({
      store: contendedStore,
      script: () => {
        throw new Error('provider must not be called');
      },
    });
    await contended.runtime.start();
    expect(contendedStore.getDecision(decision.id)?.status).toBe('CALLING_PROVIDER');
    expect(hasAudit(contended.audits, 'TRANSITION_CONTENDED')).toBe(true);
    expect(contended.provider.invocations).toBe(0);

    const noPendingStore = new MemoryDecisionStore();
    const noPendingObservation = observationWith({});
    const noPending = noPendingStore.observeDecision({
      tableId: TEST_TABLE_ID,
      turnId: TEST_TURN_ID,
      principalId: PRINCIPAL,
      roomId: ROOM_ID,
      observation: noPendingObservation,
      observationHash: computeObservationHash(noPendingObservation),
      source: null,
      promptPolicyId: seatPromptPolicy.id,
      eventCursor: noPendingObservation.eventSeq,
    });
    noPendingStore.decisions.set(noPending.id, {
      ...noPending,
      status: 'CALLING_PROVIDER',
      attemptCount: 1,
    });
    const noPendingHarness = makeHarness({
      store: noPendingStore,
      script: () => {
        throw new Error('provider must not be called');
      },
    });
    await noPendingHarness.runtime.start();
    expect(noPendingStore.getDecision(noPending.id)?.status).toBe('CALLING_PROVIDER');

    const throwingStore = new MemoryDecisionStore();
    const throwingObservation = observationWith({});
    const throwing = throwingStore.observeDecision({
      tableId: TEST_TABLE_ID,
      turnId: TEST_TURN_ID,
      principalId: PRINCIPAL,
      roomId: ROOM_ID,
      observation: throwingObservation,
      observationHash: computeObservationHash(throwingObservation),
      source: null,
      promptPolicyId: seatPromptPolicy.id,
      eventCursor: throwingObservation.eventSeq,
    });
    throwingStore.decisions.set(throwing.id, {
      ...throwing,
      status: 'CALLING_PROVIDER',
      attemptCount: 1,
    });
    throwingStore.listAttempts = () => {
      throw new Error('attempts down');
    };
    const throwingHarness = makeHarness({
      store: throwingStore,
      script: () => {
        throw new Error('provider must not be called');
      },
    });
    await throwingHarness.runtime.start();
    expect(throwingStore.getDecision(throwing.id)?.status).toBe('CALLING_PROVIDER');
  });

  it('fails closed on corrupted stored action requests', async () => {
    const store = new MemoryDecisionStore();
    const observation = observationWith({});
    const decision = store.observeDecision({
      tableId: TEST_TABLE_ID,
      turnId: TEST_TURN_ID,
      principalId: PRINCIPAL,
      roomId: ROOM_ID,
      observation,
      observationHash: computeObservationHash(observation),
      source: null,
      promptPolicyId: seatPromptPolicy.id,
      eventCursor: observation.eventSeq,
    });
    store.decisions.set(decision.id, {
      ...decision,
      status: 'ACTION_SUBMITTED',
      requestJson: 'not json',
    });
    const harness = makeHarness({
      store,
      script: () => {
        throw new Error('provider must not be called');
      },
    });
    await harness.runtime.start();
    expect(store.getDecision(decision.id)?.status).toBe('FAILED');
    expect(store.getDecision(decision.id)?.errorReason).toContain('stored_request_invalid');
    expect(harness.transport.actionRequests).toHaveLength(0);
  });

  it('retries a transient action submission once and then commits', async () => {
    const harness = makeHarness();
    let calls = 0;
    harness.transport.actionHandler = async (request) => {
      calls += 1;
      if (calls === 1) {
        throw Object.assign(new Error('gateway'), { statusCode: 503 });
      }
      return actionResult(request);
    };
    await harness.runtime.start();
    expect(expectStatus(harness.store, TEST_TABLE_ID, TEST_TURN_ID).status).toBe('COMMITTED');
    expect(calls).toBe(2);
    expect(hasAudit(harness.audits, 'ACTION_SUBMIT_RETRY')).toBe(true);
  });

  it('fails after bounded action retries and on a mismatched receipt identity', async () => {
    const always = makeHarness();
    always.transport.actionHandler = async () => {
      throw Object.assign(new Error('gateway'), { statusCode: 503 });
    };
    await always.runtime.start();
    const failed = expectStatus(always.store, TEST_TABLE_ID, TEST_TURN_ID);
    expect(failed.status).toBe('FAILED');
    expect(failed.errorReason).toContain('action_failed');
    expect(always.transport.actionRequests).toHaveLength(2);

    const mismatch = makeHarness();
    mismatch.transport.actionHandler = async (request) => {
      const result = actionResult(request);
      return { ...result, receipt: { ...result.receipt, requestId: 'other-request' } };
    };
    await mismatch.runtime.start();
    const mismatched = expectStatus(mismatch.store, TEST_TABLE_ID, TEST_TURN_ID);
    expect(mismatched.status).toBe('FAILED');
    expect(mismatched.errorReason).toContain('action_receipt_mismatch');
    expect(mismatch.transport.actionRequests).toHaveLength(1);
  });

  it('treats an abort-shaped action failure as aborted without failing the decision', async () => {
    const harness = makeHarness();
    harness.transport.actionHandler = async () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    };
    await harness.runtime.start();
    const decision = expectStatus(harness.store, TEST_TABLE_ID, TEST_TURN_ID);
    expect(decision.status).toBe('ACTION_SUBMITTED');
    expect(hasAudit(harness.audits, 'ACTION_ABORTED')).toBe(true);
  });

  it('rejects a runtime whose prompt policy drifts after construction', async () => {
    const harness = makeHarness();
    await harness.runtime.start();
    const internals = harness.runtime as unknown as { config: AgentRuntimeConfig };
    internals.config.promptPolicyId = 'mutated-policy';
    harness.transport.observation = observationWith({ turnId: 'turn-2', version: 5, eventSeq: 11 });
    await harness.runtime.syncNow();
    const second = expectStatus(harness.store, TEST_TABLE_ID, 'turn-2');
    expect(second.status).toBe('FAILED');
    expect(second.errorReason).toContain('prompt_policy_rejected');
    expect(hasAudit(harness.audits, 'PROMPT_POLICY_REJECTED')).toBe(true);
    expect(harness.provider.invocations).toBe(1);
  });

  it('fails closed when the agent configuration is missing', async () => {
    const harness = makeHarness();
    harness.store.getAgentConfig = () => null;
    await harness.runtime.start();
    const decision = expectStatus(harness.store, TEST_TABLE_ID, TEST_TURN_ID);
    expect(decision.status).toBe('FAILED');
    expect(decision.errorReason).toContain('agent_config_missing');
    expect(harness.provider.invocations).toBe(0);
    expect(hasAudit(harness.audits, 'ROOM_RESERVATION_DENIED')).toBe(true);
  });

  it('honors the relative run window when no absolute deadline exists', async () => {
    let now = 1_000_000;
    const harness = makeHarness({
      config: { overallRuntimeMs: 10 },
      now: () => now,
      script: () => {
        throw new Error('provider must not be called');
      },
    });
    harness.transport.observation = observationWith({ legalActions: [] });
    await harness.runtime.start();
    harness.transport.observation = observationWith({ turnId: 'turn-2', version: 5, eventSeq: 11 });
    now = 1_000_100;
    await harness.runtime.syncNow();
    const decision = expectStatus(harness.store, TEST_TABLE_ID, 'turn-2');
    expect(decision.status).toBe('FAILED');
    expect(decision.errorReason).toContain('runtime_deadline_exhausted');
    expect(harness.provider.invocations).toBe(0);
  });

  it('runs normally when the absolute deadline is still in the future', async () => {
    const harness = makeHarness({ config: { overallDeadlineAtMs: Date.now() + 60_000 } });
    await harness.runtime.start();
    expect(expectStatus(harness.store, TEST_TABLE_ID, TEST_TURN_ID).status).toBe('COMMITTED');
  });

  it('survives contended terminal transitions', async () => {
    const staleStore = new MemoryDecisionStore();
    const oldObservation = observationWith({ turnId: 'turn-old' });
    const old = staleStore.observeDecision({
      tableId: TEST_TABLE_ID,
      turnId: 'turn-old',
      principalId: PRINCIPAL,
      roomId: ROOM_ID,
      observation: oldObservation,
      observationHash: computeObservationHash(oldObservation),
      source: null,
      promptPolicyId: seatPromptPolicy.id,
      eventCursor: oldObservation.eventSeq,
    });
    staleStore.markDecisionStale = () => {
      throw new Error('contended');
    };
    const staleHarness = makeHarness({ store: staleStore });
    staleHarness.transport.observation = observationWith({ turnId: 'turn-new' });
    await staleHarness.runtime.start();
    expect(hasAudit(staleHarness.audits, 'TRANSITION_CONTENDED')).toBe(true);
    expect(staleStore.getDecision(old.id)?.status).toBe('OBSERVED');

    const failStore = new MemoryDecisionStore();
    failStore.failDecision = () => {
      throw new Error('contended');
    };
    const failHarness = makeHarness({
      store: failStore,
      script: () => ({ kind: 'http-error', status: 503 }),
    });
    await failHarness.runtime.start();
    expect(hasAudit(failHarness.audits, 'TRANSITION_CONTENDED')).toBe(true);
  });

  it('releases the reservation when actual cost exceeds the per-call maximum', async () => {
    const harness = makeHarness({ script: () => ({ kind: 'valid', costUsdMicro: 7n }) });
    harness.store.limits.maxCostMicroUsdPerCall = 1;
    harness.store.limits.maxCostMicroUsdPerRoom = 1_000_000;
    await harness.runtime.start();
    expect(expectStatus(harness.store, TEST_TABLE_ID, TEST_TURN_ID).status).toBe('COMMITTED');
    const reservation = harness.store.reservations.get(`${ROOM_ID}\0${AGENT_ID}`);
    expect(reservation?.callsReserved).toBe(0);
    expect(reservation?.callsSettled).toBe(0);
    expect(hasAudit(harness.audits, 'RESERVATION_SETTLE_REJECTED')).toBe(true);
  });

  it('audits a failed reservation release on preflight failure', async () => {
    const harness = makeHarness({ script: () => ({ kind: 'request-mismatch' }) });
    harness.store.releaseCall = () => {
      throw new FakeStoreError('RESERVATION_NOT_FOUND');
    };
    await harness.runtime.start();
    expect(hasAudit(harness.audits, 'RESERVATION_SETTLE_REJECTED')).toBe(true);
  });

  it('audits a failed durable speech intention without sending', async () => {
    const harness = makeHarness({
      config: { speech: 'AFTER_COMMIT' },
      script: () => ({ kind: 'valid', arguments: { ...validActionArguments(), speech: 'hi' } }),
    });
    harness.store.markSpeechIntended = () => {
      throw new Error('speech store down');
    };
    await harness.runtime.start();
    expect(expectStatus(harness.store, TEST_TABLE_ID, TEST_TURN_ID).status).toBe('COMMITTED');
    expect(harness.transport.sentChats).toHaveLength(0);
    expect(hasAudit(harness.audits, 'SPEECH_FAILED')).toBe(true);
  });

  it('fails closed when the provider reports an unrepresentable cost', async () => {
    const harness = makeHarness({
      script: () => ({ kind: 'valid', costUsdMicro: BigInt(Number.MAX_SAFE_INTEGER) + 1n }),
    });
    await harness.runtime.start();
    const decision = expectStatus(harness.store, TEST_TABLE_ID, TEST_TURN_ID);
    expect(decision.status).toBe('FAILED');
    expect(harness.store.listAttempts(decision.id).every((attempt) => attempt.status === 'FAILED')).toBe(
      true,
    );
    expect(harness.transport.actionRequests).toHaveLength(0);
  });

  it('omits the amount for an amountless provider action', async () => {
    const harness = makeHarness({
      script: () => ({ kind: 'valid', arguments: { actionId: 'act-check' } }),
    });
    await harness.runtime.start();
    const decision = expectStatus(harness.store, TEST_TABLE_ID, TEST_TURN_ID);
    expect(decision.status).toBe('COMMITTED');
    const request = JSON.parse(decision.requestJson!) as CanonicalActionRequest;
    expect(request.actionId).toBe('act-check');
    expect(request.amount).toBeUndefined();
  });

  it('audits a provider amount ignored for a no-amount action', async () => {
    const harness = makeHarness({
      script: () => ({ kind: 'valid', arguments: { actionId: 'act-check', amount: 5 } }),
    });
    await harness.runtime.start();
    const decision = expectStatus(harness.store, TEST_TABLE_ID, TEST_TURN_ID);
    expect(decision.status).toBe('COMMITTED');
    const request = JSON.parse(decision.requestJson!) as CanonicalActionRequest;
    expect(request.actionId).toBe('act-check');
    expect(request.amount).toBeUndefined();

    const ignored = harness.audits.find((event) => event.code === 'PROVIDER_AMOUNT_IGNORED');
    expect(ignored).toBeDefined();
    expect(ignored!.detail).toContain('"actionId":"act-check"');
    expect(ignored!.detail).toContain('"normalization":"amount_ignored"');
    expect(ignored!.detail).toContain('"serverAmount":null');
    const persisted = harness.audits.find((event) => event.code === 'ACTION_REQUEST_PERSISTED');
    expect(persisted!.detail).toContain('"normalization":"amount_ignored"');
  });

  it('fails closed when a provider callback arrives before the durable attempt', async () => {
    const makeEvilFactory = (mode: 'request' | 'response'): DecisionProviderFactory =>
      Object.assign(
        (context: DecisionProviderCallContext): DecisionProviderPort => ({
          buildPrompt: (observation, publicChat) => {
            if (mode === 'request') context.onRequest({} as DecisionRequestRecord);
            else context.onResponse({} as DecisionResponseRecord);
            return buildDecisionPrompt({ observation, publicChat, model: MODEL, maxOutputTokens: 64 });
          },
          sendPrompt: async () => ({}),
        }),
        {
          identity: { model: MODEL, provider: PROVIDER, baseUrlHost: '127.0.0.1' },
          knownSecrets: [],
          sanitizeSourceChat: (entries: readonly ChatMessage[]) => [...entries],
          costCeilingUsdMicro: () => 0n,
        },
      );

    for (const mode of ['request', 'response'] as const) {
      const store = new MemoryDecisionStore();
      const transport = new FakeTransport();
      const audits: AgentAuditEvent[] = [];
      const runtime = new AgentRuntime(makeConfig(), {
        transport,
        store,
        providerFactory: makeEvilFactory(mode),
        audit: (event) => audits.push(event),
      });
      await runtime.start();
      const decision = expectStatus(store, TEST_TABLE_ID, TEST_TURN_ID);
      expect(decision.status).toBe('FAILED');
      expect(decision.errorReason).toContain('prompt_build_failed');
      expect(audits.some((event) => event.code === 'PROMPT_BUILD_FAILED')).toBe(true);
    }
  });

  it('builds prompts from a null source with a factory that declares no known secrets', async () => {
    const store = new MemoryDecisionStore();
    const observation = observationWith({});
    const decision = store.observeDecision({
      tableId: TEST_TABLE_ID,
      turnId: TEST_TURN_ID,
      principalId: PRINCIPAL,
      roomId: ROOM_ID,
      observation,
      observationHash: computeObservationHash(observation),
      source: null,
      promptPolicyId: seatPromptPolicy.id,
      eventCursor: observation.eventSeq,
    });
    const transport = new FakeTransport();
    const factory = Object.assign(
      (context: DecisionProviderCallContext): DecisionProviderPort => ({
        buildPrompt: (obs, chat) =>
          buildDecisionPrompt({ observation: obs, publicChat: chat, model: MODEL, maxOutputTokens: 64 }),
        async sendPrompt(prompt) {
          void context.attempt();
          const requestJson = serializeDecisionRequest(prompt);
          context.onRequest({
            requestId: 'prov-nosecret',
            provider: PROVIDER,
            model: MODEL,
            baseUrlHost: '127.0.0.1',
            promptVersion: prompt.promptVersion,
            promptHash: prompt.promptHash,
            observationHash: prompt.observationHash,
            requestJson,
            requestHash: sha256Hex(requestJson),
            requestBytes: Buffer.byteLength(requestJson, 'utf8'),
            startedAt: Date.now(),
          });
          const responseJson = toolCallResponse(validActionArguments());
          context.onResponse({
            requestId: 'prov-nosecret',
            status: 200,
            ok: true,
            responseJson,
            responseBytes: Buffer.byteLength(responseJson, 'utf8'),
            rawResponseBytes: Buffer.byteLength(responseJson, 'utf8'),
            inputTokens: 10,
            outputTokens: 2,
            costUsdMicro: 5n,
            errorCode: null,
            finishedAt: Date.now(),
          });
          return {};
        },
      }),
      {
        identity: { model: MODEL, provider: PROVIDER, baseUrlHost: '127.0.0.1' },
        sanitizeSourceChat: (entries: readonly ChatMessage[]) => [...entries],
        costCeilingUsdMicro: () => 0n,
      },
    ) as DecisionProviderFactory;
    const runtime = new AgentRuntime(makeConfig(), {
      transport,
      store,
      providerFactory: factory,
    });
    await runtime.start();
    expect(store.getDecision(decision.id)?.status).toBe('COMMITTED');
    expect(transport.actionRequests).toHaveLength(1);
  });
});

describe('AgentRuntime canonical deadline budget', () => {
  const NOW = 5_000_000;
  const canonicalState = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    timestamp: NOW,
    config: { actionTimeoutSeconds: 3 },
    viewingPlayerId: 'p0',
    actionTo: 0,
    players: [{ id: 'p0', seat: 0 }],
    timeBanks: {},
    ...overrides,
  });

  it('adapts below the configured budget using the canonical action window', () => {
    expect(
      resolveCallBudgetMs({ state: canonicalState(), now: NOW, perCallTimeoutMs: 10_000 }),
    ).toBe(2_750);
  });

  it('extends the canonical window by the acting seat time bank only', () => {
    expect(
      resolveCallBudgetMs({
        state: canonicalState({ timeBanks: { '0': 5 } }),
        now: NOW,
        perCallTimeoutMs: 10_000,
      }),
    ).toBe(7_750);
    // Not on the clock: the bank is not spendable.
    expect(
      resolveCallBudgetMs({
        state: canonicalState({ actionTo: 1, timeBanks: { '0': 5 } }),
        now: NOW,
        perCallTimeoutMs: 10_000,
      }),
    ).toBe(2_750);
  });

  it('caps the canonical window at the configured per-call budget', () => {
    expect(
      resolveCallBudgetMs({
        state: canonicalState({ config: { actionTimeoutSeconds: 3_600 } }),
        now: NOW,
        perCallTimeoutMs: 5_000,
      }),
    ).toBe(4_750);
  });

  it('falls back to the configured budget when canonical fields are absent or implausible', () => {
    expect(resolveCallBudgetMs({ state: {}, now: NOW, perCallTimeoutMs: 5_000 })).toBe(4_750);
    expect(
      resolveCallBudgetMs({
        state: { config: { actionTimeoutSeconds: 30 }, timestamp: NOW },
        now: NOW,
        perCallTimeoutMs: 5_000,
      }),
    ).toBe(4_750);
    expect(
      resolveCallBudgetMs({
        state: canonicalState({ timestamp: 'bad' }),
        now: NOW,
        perCallTimeoutMs: 5_000,
      }),
    ).toBe(4_750);
    expect(
      resolveCallBudgetMs({
        state: canonicalState({ config: { actionTimeoutSeconds: 0 } }),
        now: NOW,
        perCallTimeoutMs: 5_000,
      }),
    ).toBe(4_750);
    expect(
      resolveCallBudgetMs({
        state: canonicalState({ config: { actionTimeoutSeconds: Number.MAX_SAFE_INTEGER } }),
        now: NOW,
        perCallTimeoutMs: 5_000,
      }),
    ).toBe(4_750);
  });

  it('keeps explicit deadline fields authoritative over the canonical window', () => {
    expect(
      resolveCallBudgetMs({
        state: { ...canonicalState(), turnDeadline: NOW + 1_000 },
        now: NOW,
        perCallTimeoutMs: 5_000,
      }),
    ).toBe(750);
  });

  it('returns zero for an expired canonical window and makes no provider call', async () => {
    expect(
      resolveCallBudgetMs({
        state: canonicalState({ timestamp: NOW - 10_000 }),
        now: NOW,
        perCallTimeoutMs: 5_000,
      }),
    ).toBe(0);

    const now = 1_000_000_000;
    const harness = makeHarness({
      now: () => now,
      script: () => {
        throw new Error('provider must not be called');
      },
    });
    harness.transport.observation = observationWith({
      state: {
        config: { smallBlind: 1, bigBlind: 2, actionTimeoutSeconds: 1 },
        timestamp: now - 10_000,
      },
    });
    await harness.runtime.start();
    const decision = expectStatus(harness.store, TEST_TABLE_ID, TEST_TURN_ID);
    expect(decision.status).toBe('FAILED');
    expect(decision.errorReason).toContain('deadline_margin_exhausted');
    expect(harness.provider.invocations).toBe(0);
    expect(harness.store.listAttempts(decision.id)).toHaveLength(0);
  });

  it('uses the canonical window plus time bank through a real runtime observation', async () => {
    const now = 1_000_000_000;
    const harness = makeHarness({ now: () => now });
    harness.transport.observation = observationWith({
      state: {
        config: { smallBlind: 1, bigBlind: 2, actionTimeoutSeconds: 30 },
        timestamp: now,
        viewingPlayerId: 'p0',
        actionTo: 0,
        timeBanks: { '0': 5 },
      },
    });
    await harness.runtime.start();
    expect(expectStatus(harness.store, TEST_TABLE_ID, TEST_TURN_ID).status).toBe('COMMITTED');
    expect(harness.provider.invocations).toBe(1);
  });
});

describe('AgentRuntime terminal close', () => {
  it('closes an aborted in-flight attempt as FAILED runtime_stopped', async () => {
    const harness = makeHarness({
      script: () => ({ kind: 'hang' }),
      costCeilingUsdMicro: () => 77n,
    });
    const starting = harness.runtime.start();
    await harness.provider.waitForInvocation(1);
    await harness.runtime.stop();
    await starting;

    // Process stop leaves the attempt durably PENDING for restart recovery.
    const decision = expectStatus(harness.store, TEST_TABLE_ID, TEST_TURN_ID);
    expect(decision.status).toBe('CALLING_PROVIDER');
    expect(harness.store.listAttempts(decision.id)[0]!.status).toBe('PENDING');

    // Terminal detach closes it before the runtime is discarded.
    harness.runtime.closeAbandonedAttempts();
    const closed = expectStatus(harness.store, TEST_TABLE_ID, TEST_TURN_ID);
    expect(closed.status).toBe('OBSERVED');
    const attempt = harness.store.listAttempts(decision.id)[0]!;
    expect(attempt.status).toBe('FAILED');
    expect(attempt.error).toBe('runtime_stopped');
    expect(attempt.responseJson).toBeNull();
    expect(attempt.promptTokens).toBe(0);
    expect(attempt.completionTokens).toBe(0);
    expect(attempt.costMicroUsd).toBe(0);
    const reservation = harness.store.reservations.get(`${ROOM_ID}\0${AGENT_ID}`);
    expect(reservation?.callsReserved).toBe(0);
    expect(reservation?.callsSettled).toBe(1);
    expect(reservation?.costMicroUsdSettled).toBe(77);
    expect(hasAudit(harness.audits, 'ABANDONED_ATTEMPTS_CLOSED')).toBe(true);

    // Idempotent: a second close changes nothing.
    harness.runtime.closeAbandonedAttempts();
    expect(harness.store.listAttempts(decision.id)).toHaveLength(1);
    expect(harness.store.listAttempts(decision.id)[0]!.status).toBe('FAILED');
  });

  it('settles a crash-abandoned reservation conservatively and stays idempotent', async () => {
    const harness = makeHarness({
      script: () => ({ kind: 'hang' }),
      costCeilingUsdMicro: () => 77n,
    });
    harness.transport.observation = observationWith({ legalActions: [] });
    await harness.runtime.start();

    // Crash simulation: an attempt is PENDING with its reservation in flight.
    const observation = observationWith({});
    const decision = harness.store.observeDecision({
      tableId: TEST_TABLE_ID,
      turnId: TEST_TURN_ID,
      principalId: PRINCIPAL,
      roomId: ROOM_ID,
      observation,
      observationHash: computeObservationHash(observation),
      source: null,
      promptPolicyId: seatPromptPolicy.id,
      eventCursor: observation.eventSeq,
    });
    const started = harness.store.startAttempt(decision.id, JSON.stringify({ placeholder: true }));
    if (started.kind !== 'started') throw new Error('expected started');
    harness.store.reserveCall(ROOM_ID, AGENT_ID, {}, 77);
    expect(harness.store.reservations.get(`${ROOM_ID}\0${AGENT_ID}`)?.callsReserved).toBe(1);

    harness.runtime.closeAbandonedAttempts();
    const attempt = harness.store.listAttempts(decision.id)[0]!;
    expect(attempt.status).toBe('FAILED');
    expect(attempt.error).toBe('runtime_stopped');
    expect(attempt.responseJson).toBeNull();
    const reservation = harness.store.reservations.get(`${ROOM_ID}\0${AGENT_ID}`);
    expect(reservation?.callsReserved).toBe(0);
    expect(reservation?.callsSettled).toBe(1);
    expect(reservation?.costMicroUsdSettled).toBe(77);

    // A process-level stop does not close a later abandoned attempt.
    const secondObservation = observationWith({ turnId: 'turn-2', version: 5, eventSeq: 11 });
    const second = harness.store.observeDecision({
      tableId: TEST_TABLE_ID,
      turnId: 'turn-2',
      principalId: PRINCIPAL,
      roomId: ROOM_ID,
      observation: secondObservation,
      observationHash: computeObservationHash(secondObservation),
      source: null,
      promptPolicyId: seatPromptPolicy.id,
      eventCursor: secondObservation.eventSeq,
    });
    const secondStarted = harness.store.startAttempt(second.id, JSON.stringify({ placeholder: true }));
    if (secondStarted.kind !== 'started') throw new Error('expected started');
    harness.store.reserveCall(ROOM_ID, AGENT_ID, {}, 77);
    await harness.runtime.stop();
    expect(harness.store.getDecision(second.id)?.status).toBe('CALLING_PROVIDER');
    expect(harness.store.listAttempts(second.id)[0]!.status).toBe('PENDING');
    expect(harness.store.reservations.get(`${ROOM_ID}\0${AGENT_ID}`)?.callsReserved).toBe(1);

    harness.runtime.closeAbandonedAttempts();
    expect(harness.store.listAttempts(second.id)[0]!.status).toBe('FAILED');
    expect(harness.store.listAttempts(second.id)[0]!.error).toBe('runtime_stopped');
    expect(harness.store.reservations.get(`${ROOM_ID}\0${AGENT_ID}`)?.callsReserved).toBe(0);
  });

  it('never overwrites recorded evidence and skips lost races without error', async () => {
    const store = new MemoryDecisionStore();
    const harness = makeHarness({ store, script: () => ({ kind: 'valid' }) });
    harness.transport.observation = observationWith({ legalActions: [] });
    await harness.runtime.start();

    // Recorded success: immutable evidence.
    const recordedObservation = observationWith({});
    const recorded = store.observeDecision({
      tableId: TEST_TABLE_ID,
      turnId: TEST_TURN_ID,
      principalId: PRINCIPAL,
      roomId: ROOM_ID,
      observation: recordedObservation,
      observationHash: computeObservationHash(recordedObservation),
      source: null,
      promptPolicyId: seatPromptPolicy.id,
      eventCursor: recordedObservation.eventSeq,
    });
    const recordedStart = store.startAttempt(recorded.id, JSON.stringify({ placeholder: true }));
    if (recordedStart.kind !== 'started') throw new Error('expected started');
    store.recordAttemptResponse(recorded.id, recordedStart.attempt.id, {
      status: 'SUCCEEDED',
      responseJson: toolCallResponse(validActionArguments()),
      model: MODEL,
      provider: PROVIDER,
      promptPolicyId: seatPromptPolicy.id,
      usage: { promptTokens: 10, completionTokens: 2, costMicroUsd: 5, latencyMs: 1 },
    });
    const recordedBefore = store.listAttempts(recorded.id)[0]!;

    // A PENDING attempt whose recording races with another process.
    const pendingObservation = observationWith({ turnId: 'turn-pending', version: 5, eventSeq: 11 });
    const pending = store.observeDecision({
      tableId: TEST_TABLE_ID,
      turnId: 'turn-pending',
      principalId: PRINCIPAL,
      roomId: ROOM_ID,
      observation: pendingObservation,
      observationHash: computeObservationHash(pendingObservation),
      source: null,
      promptPolicyId: seatPromptPolicy.id,
      eventCursor: pendingObservation.eventSeq,
    });
    const pendingStart = store.startAttempt(pending.id, JSON.stringify({ placeholder: true }));
    if (pendingStart.kind !== 'started') throw new Error('expected started');
    store.recordAttemptResponse = () => {
      throw new FakeStoreError('ATTEMPT_STATE');
    };

    harness.runtime.closeAbandonedAttempts();

    expect(store.listAttempts(recorded.id)[0]).toEqual(recordedBefore);
    expect(store.getDecision(recorded.id)?.status).toBe('PROVIDER_RECORDED');
    // The lost race stays PENDING for the owning process to resolve.
    expect(store.listAttempts(pending.id)[0]!.status).toBe('PENDING');
    expect(store.reservations.size).toBe(0);
  });

  it('closes abandoned attempts on terminal detach but not on process stop', async () => {
    const calls: string[] = [];
    const handle = {
      start: async (): Promise<void> => {
        calls.push('start');
      },
      stop: async (): Promise<void> => {
        calls.push('stop');
      },
      closeAbandonedAttempts: (): void => {
        calls.push('close');
      },
    };
    const room = { id: 'room-glue', status: 'ACTIVE', tableId: TEST_TABLE_ID } as unknown as ProductRoom;
    const agent = normalizeAgentConfig({
      id: AGENT_ID,
      name: 'Glue Agent',
      model: 'glue-model',
      provider: 'glue-provider',
      baseUrl: 'https://provider.example/v1',
      keyEnv: 'GLUE_MISSING_KEY',
      principalId: PRINCIPAL,
      promptPolicyId: seatPromptPolicy.id,
      promptPolicyHash: seatPromptPolicy.hash,
      pricing: { inputMicroUsdPerMillionTokens: 0, outputMicroUsdPerMillionTokens: 0 },
      limits: {
        maxCallsPerRoom: 10,
        maxCostMicroUsdPerRoom: 1_000,
        maxCostMicroUsdPerCall: 100,
      },
      enabled: true,
    });
    const deps = {
      config: {
        MAX_PROVIDER_CONCURRENCY: 1,
        PER_CALL_TIMEOUT_MS: 1_000,
        OVERALL_RUNTIME_MS: 60_000,
        MAX_HANDS: 10,
        MAX_PROVIDER_CALLS: 10,
        MAX_COST_USD_MICRO: 1_000,
        AGENT_CHAT_ENABLED: '0',
      } as unknown as Config,
      store: {
        listParticipants: () => [
          { principalId: PRINCIPAL, kind: 'AGENT', agentId: AGENT_ID },
        ],
      } as unknown as ProductStore,
      agents: {
        has: () => true,
        get: () => agent,
      } as unknown as RoomRuntimeDependencies['agents'],
      platformUrl: 'https://platform.example',
      knownSecrets: [],
      issueCredentials: async () => [{ agentId: AGENT_ID, token: 'glue-token' }],
      log: () => {},
      createRuntime: () => handle,
    } as unknown as RoomRuntimeDependencies;
    const glue = new SdkRoomRuntime(deps);

    await glue.attach(room);
    expect(calls).toEqual(['start']);
    await glue.detach(room.id);
    expect(calls).toEqual(['start', 'close', 'stop']);

    // Process-level stop keeps PENDING rows for restart recovery.
    calls.length = 0;
    await glue.attach(room);
    await glue.stop();
    expect(calls).toEqual(['start', 'stop']);
  });
});

function seedActionSubmitted(store: MemoryDecisionStore, observation: SeatObservation): ProductDecision {
  const decision = store.observeDecision({
    tableId: observation.tableId,
    turnId: observation.turnId,
    principalId: PRINCIPAL,
    roomId: ROOM_ID,
    observation,
    observationHash: computeObservationHash(observation),
    source: null,
    promptPolicyId: seatPromptPolicy.id,
    eventCursor: observation.eventSeq,
  });
  const started = store.startAttempt(decision.id, JSON.stringify({ placeholder: true }));
  if (started.kind !== 'started') throw new Error('expected started');
  store.recordAttemptResponse(decision.id, started.attempt.id, {
    status: 'SUCCEEDED',
    responseJson: toolCallResponse(validActionArguments()),
    model: MODEL,
    provider: PROVIDER,
    promptPolicyId: seatPromptPolicy.id,
    usage: { promptTokens: 10, completionTokens: 2, costMicroUsd: 5, latencyMs: 1 },
  });
  const menu = deriveDecisionMenu(observation.legalActions);
  const chosen = menu.actions.find((action) => action.actionId === 'act-raise-half')!;
  return store.submitResolvedAction(
    decision.id,
    JSON.stringify({
      requestId: decision.id,
      turnId: observation.turnId,
      expectedVersion: observation.version,
      actionId: chosen.actionId,
      amount: 12,
    }),
  );
}
