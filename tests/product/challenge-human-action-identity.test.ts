/**
 * Focused regressions for the CHALLENGE SDK human-action identity relay.
 *
 * The failure packet must identify the EXACT last canonical human request even
 * when the action was rejected, superseded or interrupted by a network error.
 * Wallet actions are not persisted as product decisions, so the only exact
 * identity is the metadata observer added to `driveHumanSeats`:
 * - `onSubmitted` fires once, BEFORE the first canonical send, with only
 *   tableId/handId/requestId/turnId/actionId and the same requestId across SDK
 *   retries;
 * - `onAcceptedAction` confirms acceptance from the exact sanitized capture;
 * - `onRejected` reports a bounded reason/status for ignored races.
 *
 * No paid run, no topology: a fake SDK session drives the real `driveHumanSeats`
 * loop. Card hygiene and callback ordering are asserted directly.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CanonicalActionReceiptSchema,
  type CanonicalActionReceipt,
  type CanonicalActionResult,
  type SeatObservation,
} from '@pokertools/types';
import {
  assertNoCardSecrets,
  type CanonicalActionCapture,
  type CapturedCanonicalRequest,
} from '../integration/acceptance/canonical-capture.js';
import {
  classifyHumanActionRejection,
  driveHumanSeats,
  type HumanActionIdentity,
  type HumanActionRejection,
} from '../integration/acceptance/product-room.js';
import type { WalletSession } from '../integration/infra/wallet.js';
import { seatObservationFixture, TEST_HAND_ID, TEST_TABLE_ID, TEST_TURN_ID } from './fixtures.js';

function receiptFor(
  request: CapturedCanonicalRequest,
  observation: SeatObservation
): CanonicalActionReceipt {
  return CanonicalActionReceiptSchema.parse({
    requestId: request.requestId,
    tableId: observation.tableId,
    handId: observation.handId,
    turnId: request.turnId,
    actionId: request.actionId,
    version: observation.version,
    eventSeq: observation.eventSeq,
    acceptedAt: 1_700_000_000_002,
  });
}

function canonicalResult(
  request: CapturedCanonicalRequest,
  observation: SeatObservation
): CanonicalActionResult {
  return { receipt: receiptFor(request, observation), observation };
}

interface FakeHuman {
  session: WalletSession;
  requests: CapturedCanonicalRequest[];
}

function fakeHuman(input: {
  observations: () => SeatObservation;
  action: (request: CapturedCanonicalRequest) => Promise<CanonicalActionResult>;
  onSend?: () => void;
}): FakeHuman {
  const requests: CapturedCanonicalRequest[] = [];
  const session = {
    client: {
      getObservation: async (_tableId: string) => input.observations(),
      action: async (_tableId: string, request: CapturedCanonicalRequest) => {
        requests.push(request);
        input.onSend?.();
        return input.action(request);
      },
    },
  } as unknown as WalletSession;
  return { session, requests };
}

function rateLimitError(): Error {
  return Object.assign(new Error('Rate limit exceeded, retry in 0 seconds'), {
    statusCode: 429,
    details: { retryAfterMs: 1 },
  });
}

describe('SDK human action identity observer', () => {
  it('fires onSubmitted before the first send, keeps the requestId across a 429 retry and confirms acceptance', async () => {
    const events: string[] = [];
    const submitted: HumanActionIdentity[] = [];
    const captures: CanonicalActionCapture[] = [];
    let attempts = 0;
    let terminal = false;
    const observation = seatObservationFixture();
    const human = fakeHuman({
      observations: () => observation,
      onSend: () => events.push('send'),
      action: async (request) => {
        attempts += 1;
        if (attempts === 1) throw rateLimitError();
        terminal = true;
        events.push('accepted-response');
        return canonicalResult(request, observation);
      },
    });
    const stats = await driveHumanSeats({
      humans: [human.session],
      tableId: TEST_TABLE_ID,
      isTerminal: () => terminal,
      pacing: { actionDelayMs: 0, pollIntervalMs: 5 },
      humanActionObserver: {
        onSubmitted: (value) => {
          submitted.push(value);
          events.push('submitted');
        },
        onAcceptedAction: (capture) => {
          captures.push(capture);
          events.push('accepted-hook');
        },
      },
    });
    expect(stats.actions).toBe(1);
    expect(stats.rateLimitRetries).toBe(1);
    expect(human.requests).toHaveLength(2);
    expect(human.requests[0]!.requestId).toBe(human.requests[1]!.requestId);
    expect(events).toEqual(['submitted', 'send', 'send', 'accepted-response', 'accepted-hook']);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toEqual({
      tableId: TEST_TABLE_ID,
      handId: TEST_HAND_ID,
      requestId: human.requests[0]!.requestId,
      turnId: TEST_TURN_ID,
      actionId: human.requests[0]!.actionId,
    });
    // The accepted confirmation identifies exactly the submitted request.
    expect(captures).toHaveLength(1);
    expect(captures[0]!.receipt.requestId).toBe(submitted[0]!.requestId);
    expect(captures[0]!.receipt.actionId).toBe(submitted[0]!.actionId);
    // Metadata only: exactly the five identity fields, no cards anywhere.
    expect(Object.keys(submitted[0]!).sort()).toEqual([
      'actionId',
      'handId',
      'requestId',
      'tableId',
      'turnId',
    ]);
    expect(JSON.stringify(submitted[0])).not.toContain('"hand":');
    expect(() => assertNoCardSecrets('submitted identity', submitted[0])).not.toThrow();
    expect(() => assertNoCardSecrets('accepted capture', captures[0])).not.toThrow();
  });

  it('reports an ignorable stale rejection with the exact request id and a bounded reason', async () => {
    const events: string[] = [];
    const submitted: HumanActionIdentity[] = [];
    const rejections: HumanActionRejection[] = [];
    let terminal = false;
    const observation = seatObservationFixture();
    const human = fakeHuman({
      observations: () => observation,
      onSend: () => events.push('send'),
      action: async () => {
        throw Object.assign(new Error('stale turn superseded'), { code: 'STALE_TURN', statusCode: 409 });
      },
    });
    const stats = await driveHumanSeats({
      humans: [human.session],
      tableId: TEST_TABLE_ID,
      isTerminal: () => terminal,
      pacing: { actionDelayMs: 0, pollIntervalMs: 5 },
      humanActionObserver: {
        onSubmitted: (value) => {
          submitted.push(value);
          events.push('submitted');
        },
        onRejected: (value) => {
          rejections.push(value);
          events.push('rejected');
          terminal = true;
        },
      },
    });
    expect(stats.actions).toBe(0);
    expect(events).toEqual(['submitted', 'send', 'rejected']);
    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toEqual({
      ...submitted[0]!,
      reason: 'stale',
      status: 409,
    });
  });

  it('reports superseded when the 429 re-check shows the turn moved, without resending', async () => {
    const rejections: HumanActionRejection[] = [];
    const submitted: HumanActionIdentity[] = [];
    let observations = 0;
    let terminal = false;
    const observation = seatObservationFixture();
    const human = fakeHuman({
      observations: () => {
        observations += 1;
        return observations === 1
          ? observation
          : seatObservationFixture({ turnId: 'turn-moved', version: observation.version + 1 });
      },
      action: async () => {
        throw rateLimitError();
      },
    });
    const stats = await driveHumanSeats({
      humans: [human.session],
      tableId: TEST_TABLE_ID,
      isTerminal: () => terminal,
      pacing: { actionDelayMs: 0, pollIntervalMs: 5 },
      humanActionObserver: {
        onSubmitted: (value) => submitted.push(value),
        onRejected: (value) => {
          rejections.push(value);
          terminal = true;
        },
      },
    });
    expect(human.requests).toHaveLength(1);
    expect(stats.rateLimitRetries).toBe(1);
    expect(rejections).toEqual([
      { ...submitted[0]!, reason: 'superseded', status: 429 },
    ]);
  });

  it('leaves a network-interrupted request pending: no rejection, identity still submitted', async () => {
    const submitted: HumanActionIdentity[] = [];
    const rejections: HumanActionRejection[] = [];
    const captures: CanonicalActionCapture[] = [];
    const observation = seatObservationFixture();
    const human = fakeHuman({
      observations: () => observation,
      action: async () => {
        throw new Error('fetch failed');
      },
    });
    await expect(
      driveHumanSeats({
        humans: [human.session],
        tableId: TEST_TABLE_ID,
        isTerminal: () => false,
        pacing: { actionDelayMs: 0, pollIntervalMs: 5 },
        humanActionObserver: {
          onSubmitted: (value) => submitted.push(value),
          onRejected: (value) => rejections.push(value),
          onAcceptedAction: (capture) => captures.push(capture),
        },
      })
    ).rejects.toThrow('fetch failed');
    expect(submitted).toHaveLength(1);
    expect(rejections).toHaveLength(0);
    expect(captures).toHaveLength(0);
  });

  it('keeps the default aggressive behavior unchanged without an observer', async () => {
    let terminal = false;
    const observation = seatObservationFixture();
    const human = fakeHuman({
      observations: () => observation,
      action: async (request) => {
        terminal = true;
        return canonicalResult(request, observation);
      },
    });
    const stats = await driveHumanSeats({
      humans: [human.session],
      tableId: TEST_TABLE_ID,
      isTerminal: () => terminal,
      pacing: { actionDelayMs: 0, pollIntervalMs: 5 },
    });
    expect(stats.actions).toBe(1);
    expect(human.requests).toHaveLength(1);
    expect(human.requests[0]!.actionId).toBe('act-raise-half');
    expect(human.requests[0]!.amount).toBe(40);
  });

  it('classifies ignorable races into bounded reasons', () => {
    expect(classifyHumanActionRejection({ code: 'STALE_TURN', statusCode: 409 }, false)).toEqual({
      reason: 'stale',
      status: 409,
    });
    expect(classifyHumanActionRejection(new Error('request timed out'), false)).toEqual({
      reason: 'timeout',
      status: null,
    });
    expect(classifyHumanActionRejection({ statusCode: 429 }, false)).toEqual({
      reason: 'rate-limit',
      status: 429,
    });
    expect(classifyHumanActionRejection({ statusCode: 404 }, true)).toEqual({
      reason: 'terminal',
      status: 404,
    });
    expect(classifyHumanActionRejection(new Error('boom'), false)).toEqual({
      reason: 'unknown',
      status: null,
    });
  });
});

describe('challenge identity propagation scope guard', () => {
  it('wires the observer through the challenge scenario and the wrapper packet', () => {
    const live = readFileSync(
      fileURLToPath(new URL('../integration/live.ts', import.meta.url)),
      'utf8'
    );
    for (const marker of [
      'humanActionObserver',
      'canonicalHumanAction: humanAction',
      'onSubmitted',
      'onAcceptedAction',
      'onRejected',
      'emitHumanAction',
    ]) {
      expect(live).toContain(marker);
    }
    const wrapper = readFileSync(
      fileURLToPath(new URL('../integration/container-live-challenge.ts', import.meta.url)),
      'utf8'
    );
    expect(wrapper).toContain('lastCanonicalHumanActionFromChallenge(');
    expect(wrapper).toContain('challengeProgress.current?.canonicalHumanAction');
    // No raw payload bodies are referenced by the identity relay.
    expect(wrapper).not.toContain('observation_json');
    expect(wrapper).not.toContain('request_json');
  });
});
