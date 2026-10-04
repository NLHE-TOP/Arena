/**
 * Targeted SdkRoomRuntime attachment-recovery tests.
 *
 * Regression source: a real container failure produced 27 shared-IP
 * `/auth/me` 429s that blocked agents 2..10. The old adapter cached the
 * partially attached runtime array forever, so one failed `startAgent` meant
 * the missing agents were never retried (and a later retry would have
 * re-authenticated every agent again).
 *
 * The production adapter now single-flights attachment per room, retains
 * healthy runtimes and retries only missing agent ids, bounds `stop()` on
 * in-flight attachments, and clears per-room state on `detach`. These tests
 * drive that contract through the `createRuntime` seam: no network, no
 * provider call and no real credential/Auth exchange is performed.
 */
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  Competition,
  CreateCompetitionRequest,
  CreateCompetitionResponse,
  IssueAgentCredentialRequest,
  IssuedAgentCredential,
  SettleCompetitionRequest,
  SettleCompetitionResponse,
  StartCompetitionRequest,
  StartCompetitionResponse,
} from '@pokertools/types';
import type { AgentRuntimeConfig } from '../../src/agents/contracts.js';
import {
  SdkRoomRuntime,
  type AgentRuntimeHandle,
  type RoomRuntimeDependencies,
} from '../../src/agents/rooms.js';
import { loadConfig } from '../../src/config.js';
import { seatPromptPolicy } from '../../src/llm/prompt-policy.js';
import { AgentCatalog, type AgentConfigInput } from '../../src/product/catalog.js';
import {
  ProductRooms,
  type PlatformCompetitions,
  type PlatformProbe,
} from '../../src/product/rooms.js';
import { ProductStore, type ProductRoom } from '../../src/product/store.js';

const MIGRATIONS = resolve(process.cwd(), 'migrations');
const ALICE = { principalId: 'u:alice', walletAddress: '0xalice' };
const ALICE_ACTOR = { principalId: ALICE.principalId, admin: false } as const;

const ACE: AgentConfigInput = {
  id: 'ace',
  name: 'Ace',
  model: 'test-model',
  provider: 'openai-compatible',
  baseUrl: 'http://127.0.0.1:9/v1',
  keyEnv: 'ROOM_RUNTIME_ACE_KEY',
  principalId: 'svc:ace',
  promptPolicyId: seatPromptPolicy.id,
  promptPolicyHash: seatPromptPolicy.hash,
  pricing: { inputMicroUsdPerMillionTokens: 0, outputMicroUsdPerMillionTokens: 0 },
  limits: { maxCallsPerRoom: 10, maxCostMicroUsdPerRoom: 0, maxCostMicroUsdPerCall: 0 },
  enabled: true,
};
const BEE: AgentConfigInput = { ...ACE, id: 'bee', name: 'Bee', principalId: 'svc:bee' };

const stores: ProductStore[] = [];

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
});

function openStore(): ProductStore {
  const store = ProductStore.open({ path: ':memory:', migrationsDir: MIGRATIONS });
  stores.push(store);
  store.upsertAgentConfig(ACE);
  store.upsertAgentConfig(BEE);
  return store;
}

/** Seed one ACTIVE SPONSORED room with the requested agent participants. */
function seedActiveRoom(store: ProductStore, agentIds: readonly string[]): ProductRoom {
  const room = store.createRoom({
    name: `Room ${agentIds.join('+')}`,
    policy: {
      kind: 'SPONSORED',
      participants: [
        { kind: 'HUMAN' },
        ...agentIds.map((agentId) => ({ kind: 'AGENT' as const, agentId })),
      ],
    },
  });
  store.addParticipant(room.id, { principalId: 'u:human', kind: 'HUMAN' });
  for (const agentId of agentIds) {
    store.addParticipant(room.id, {
      principalId: `svc:${agentId}`,
      kind: 'AGENT',
      agentId,
    });
  }
  store.openRoomForRoster(room.id);
  store.beginProvisioning(room.id);
  return store.activateRoom(room.id, { tableId: `table-${room.id.slice(0, 8)}` });
}

interface HandleRecord {
  roomId: string;
  agentId: string;
  startCalls: number;
  stopCalls: number;
}

interface RuntimeStub {
  createRuntime: NonNullable<RoomRuntimeDependencies['createRuntime']>;
  /** agentIds passed to createRuntime, in creation order. */
  created: string[];
  startCalls(roomId: string, agentId: string): number;
  stopCalls(roomId: string, agentId: string): number;
}

/**
 * Deterministic `createRuntime` seam. `failStart` makes a chosen attempt throw
 * (modeling an attach/auth failure); `startGate` defers a chosen agent's start
 * so overlapping attach/stop/detach can be exercised without timers.
 */
function runtimeStub(options: {
  failStart?: (agentId: string, attempt: number) => boolean;
  startGate?: (agentId: string) => Promise<void> | undefined;
  onStart?: (agentId: string) => void;
} = {}): RuntimeStub {
  const handles = new Map<string, HandleRecord>();
  const key = (roomId: string, agentId: string): string => `${roomId}:${agentId}`;
  const record = (roomId: string, agentId: string): HandleRecord => {
    let handle = handles.get(key(roomId, agentId));
    if (handle === undefined) {
      handle = { roomId, agentId, startCalls: 0, stopCalls: 0 };
      handles.set(key(roomId, agentId), handle);
    }
    return handle;
  };
  const created: string[] = [];
  const createRuntime = (config: AgentRuntimeConfig): AgentRuntimeHandle => {
    const roomId = config.rooms[0]!.roomId;
    const handle = record(roomId, config.agentId);
    created.push(config.agentId);
    return {
      start: async (): Promise<void> => {
        handle.startCalls += 1;
        options.onStart?.(config.agentId);
        await options.startGate?.(config.agentId);
        if (options.failStart?.(config.agentId, handle.startCalls) === true) {
          throw new Error(`stub start failed for ${config.agentId}`);
        }
      },
      stop: async (): Promise<void> => {
        handle.stopCalls += 1;
      },
    };
  };
  return {
    createRuntime,
    created,
    startCalls: (roomId, agentId) => handles.get(key(roomId, agentId))?.startCalls ?? 0,
    stopCalls: (roomId, agentId) => handles.get(key(roomId, agentId))?.stopCalls ?? 0,
  };
}

interface DepsHarness {
  deps: RoomRuntimeDependencies;
  issueCredentials: ReturnType<typeof vi.fn>;
}

function makeDeps(store: ProductStore, stub: RuntimeStub): DepsHarness {
  const issueCredentials = vi.fn(async () => [
    { agentId: 'ace', token: 'issued-token-ace' },
    { agentId: 'bee', token: 'issued-token-bee' },
  ]);
  const deps: RoomRuntimeDependencies = {
    config: loadConfig({}),
    store,
    agents: new AgentCatalog([ACE, BEE]),
    platformUrl: 'http://127.0.0.1:1',
    knownSecrets: [],
    issueCredentials,
    log: () => undefined,
    createRuntime: stub.createRuntime,
  };
  return { deps, issueCredentials };
}

/** Deterministic microtask latch (no timers involved). */
async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function flushMicrotasks(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await Promise.resolve();
  }
}

describe('SdkRoomRuntime attachment recovery', () => {
  it('retries only the missing agent after a partial attach without new credential or auth work', async () => {
    const store = openStore();
    const stub = runtimeStub({
      failStart: (agentId, attempt) => agentId === 'bee' && attempt === 1,
    });
    const { deps, issueCredentials } = makeDeps(store, stub);
    const runtime = new SdkRoomRuntime(deps);
    const room = seedActiveRoom(store, ['ace', 'bee']);

    await runtime.attach(room);
    expect(runtime.attachedAgentCount(room.id)).toBe(1);
    expect(stub.startCalls(room.id, 'ace')).toBe(1);
    expect(stub.startCalls(room.id, 'bee')).toBe(1);
    // One credential issuance per room covers both agents.
    expect(issueCredentials).toHaveBeenCalledTimes(1);

    // A later attach retries ONLY the missing agent: the healthy agent is not
    // re-started and no new credential/Auth exchange happens.
    await runtime.attach(room);
    expect(runtime.attachedAgentCount(room.id)).toBe(2);
    expect(stub.startCalls(room.id, 'ace')).toBe(1);
    expect(stub.startCalls(room.id, 'bee')).toBe(2);
    expect(issueCredentials).toHaveBeenCalledTimes(1);
    expect(stub.stopCalls(room.id, 'ace')).toBe(0);
    expect(stub.stopCalls(room.id, 'bee')).toBe(0);

    await runtime.stop();
    expect(stub.stopCalls(room.id, 'ace')).toBe(1);
    expect(stub.stopCalls(room.id, 'bee')).toBe(1);
    expect(runtime.attachedAgentCount(room.id)).toBe(0);
  });

  it('single-flights concurrent attach calls per room', async () => {
    const store = openStore();
    let releaseStart: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const stub = runtimeStub({
      startGate: (agentId) => (agentId === 'ace' ? gate : undefined),
    });
    const { deps, issueCredentials } = makeDeps(store, stub);
    const runtime = new SdkRoomRuntime(deps);
    const room = seedActiveRoom(store, ['ace', 'bee']);

    const first = runtime.attach(room);
    const second = runtime.attach(room);
    expect(second).toBe(first);

    await waitFor(() => stub.startCalls(room.id, 'ace') === 1, 'gated attach start');
    releaseStart();
    await Promise.all([first, second]);

    expect([...stub.created].sort()).toEqual(['ace', 'bee']);
    expect(stub.startCalls(room.id, 'ace')).toBe(1);
    expect(stub.startCalls(room.id, 'bee')).toBe(1);
    expect(issueCredentials).toHaveBeenCalledTimes(1);
    expect(runtime.attachedAgentCount(room.id)).toBe(2);
  });

  it('stops globally while an attach is pending without extra agents or orphan handles', async () => {
    const store = openStore();
    let releaseStart: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    let signalStarted: () => void = () => {};
    const startEntered = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const stub = runtimeStub({
      startGate: () => gate,
      onStart: (agentId) => {
        if (agentId === 'ace') signalStarted();
      },
    });
    const { deps } = makeDeps(store, stub);
    const runtime = new SdkRoomRuntime(deps);
    const room = seedActiveRoom(store, ['ace', 'bee']);

    const attaching = runtime.attach(room);
    await startEntered;

    let stopSettled = false;
    const stopping = runtime.stop().then(() => {
      stopSettled = true;
    });
    await flushMicrotasks();
    // The pending attach bounds the stop: it is still waiting.
    expect(stopSettled).toBe(false);

    releaseStart();
    await stopping;
    await attaching;

    // The agent that started during shutdown was stopped (no orphan handle),
    // and the remaining agent was never started after stopping.
    expect(stub.startCalls(room.id, 'ace')).toBe(1);
    expect(stub.startCalls(room.id, 'bee')).toBe(0);
    expect(stub.stopCalls(room.id, 'ace')).toBe(1);
    expect(runtime.attachedAgentCount(room.id)).toBe(0);

    // A later attach after global stop is a no-op.
    await runtime.attach(room);
    expect(stub.startCalls(room.id, 'ace')).toBe(1);
    expect(stub.startCalls(room.id, 'bee')).toBe(0);
  });

  it('detach awaits an in-flight attach and re-permits only that room afterwards', async () => {
    const store = openStore();
    let releaseStart: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const stub = runtimeStub({
      startGate: (agentId) => (agentId === 'ace' ? gate : undefined),
    });
    const { deps } = makeDeps(store, stub);
    const runtime = new SdkRoomRuntime(deps);
    const roomA = seedActiveRoom(store, ['ace']);
    const roomB = seedActiveRoom(store, ['bee']);

    await runtime.attach(roomB);
    expect(runtime.attachedAgentCount(roomB.id)).toBe(1);
    const roomBStarts = stub.startCalls(roomB.id, 'bee');

    const attaching = runtime.attach(roomA);
    await waitFor(() => stub.startCalls(roomA.id, 'ace') === 1, 'gated room A attach');

    let detached = false;
    const detaching = runtime.detach(roomA.id).then(() => {
      detached = true;
    });
    await flushMicrotasks();
    // Detach waits for the in-flight attachment before clearing room state.
    expect(detached).toBe(false);

    releaseStart();
    await detaching;
    await attaching;
    expect(runtime.attachedAgentCount(roomA.id)).toBe(0);
    expect(stub.stopCalls(roomA.id, 'ace')).toBe(1);

    // Room B is untouched: detach is scoped to the selected room.
    expect(runtime.attachedAgentCount(roomB.id)).toBe(1);
    expect(stub.stopCalls(roomB.id, 'bee')).toBe(0);
    expect(stub.startCalls(roomB.id, 'bee')).toBe(roomBStarts);

    // A later legitimate attach for the detached room is permitted again.
    await runtime.attach(roomA);
    expect(runtime.attachedAgentCount(roomA.id)).toBe(1);
    expect(stub.startCalls(roomA.id, 'ace')).toBe(2);
    // Still not global: room B was never restarted.
    expect(stub.startCalls(roomB.id, 'bee')).toBe(roomBStarts);
    expect(stub.stopCalls(roomB.id, 'bee')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ProductRooms lifecycle integration (real SdkRoomRuntime, stub handles)
// ---------------------------------------------------------------------------

class CadenceCompetitions implements PlatformCompetitions {
  private readonly byId = new Map<string, Competition>();
  private readonly byKey = new Map<string, Competition>();
  private sequence = 0;

  async createCompetition(request: CreateCompetitionRequest): Promise<CreateCompetitionResponse> {
    const replay = this.byKey.get(request.idempotencyKey);
    if (replay !== undefined) return { success: true, competition: replay, replayed: true };
    const id = `comp-${++this.sequence}`;
    const competition: Competition = {
      id,
      name: request.name,
      mode: request.mode,
      status: 'REGISTRATION',
      tableId: `table-${id}`,
      organizerPrincipalId: 'svc:orchestrator',
      maxEntrants: request.entrants.length,
      startingStack: 1000,
      smallBlind: 10,
      bigBlind: 20,
      entrants: request.entrants.map((entrant, index) => ({
        principalId: entrant.principalId,
        kind: entrant.kind,
        seat: index,
        entryState: 'NOT_REQUIRED',
      })),
      terms: request.mode === 'ASSET' ? (request.terms ?? null) : null,
      prizeStatus: request.mode === 'ASSET' ? 'RESERVED' : 'NOT_APPLICABLE',
      settlementReady: false,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      cancelledAt: null,
    };
    this.byKey.set(request.idempotencyKey, competition);
    this.byId.set(id, competition);
    return { success: true, competition, replayed: false };
  }

  async getCompetition(competitionId: string): Promise<Competition> {
    const competition = this.byId.get(competitionId);
    if (competition === undefined) throw new Error('competition not found');
    return competition;
  }

  async startCompetition(
    competitionId: string,
    _request: StartCompetitionRequest,
  ): Promise<StartCompetitionResponse> {
    const competition = await this.getCompetition(competitionId);
    this.byId.set(competitionId, { ...competition, status: 'RUNNING' });
    return {
      success: true,
      competitionId,
      tableId: competition.tableId,
      seats: competition.entrants.map((entrant) => ({
        principalId: entrant.principalId,
        seat: entrant.seat,
      })),
    };
  }

  async settleCompetition(
    _competitionId: string,
    _request: SettleCompetitionRequest,
  ): Promise<SettleCompetitionResponse> {
    throw new Error('settlement is not simulated');
  }

  async cancelCompetition(): Promise<never> {
    throw new Error('cancellation is not simulated');
  }

  async issueAgentCredential(
    competitionId: string,
    request: IssueAgentCredentialRequest,
  ): Promise<IssuedAgentCredential> {
    const competition = await this.getCompetition(competitionId);
    return {
      credentialId: `credential-${request.principalId}`,
      principalId: request.principalId,
      competitionId,
      tableId: competition.tableId,
      name: request.name,
      scopes: request.scopes ?? ['table:observe', 'table:act'],
      seat: request.seat ?? null,
      expiresAt: null,
      token: `token-${request.principalId}`,
      rotated: false,
    };
  }
}

const PROBE: PlatformProbe = {
  health: async () => ({ status: 'ok', timestamp: Date.now() }),
  readiness: async () => ({
    status: 'ready',
    timestamp: Date.now(),
    checks: [],
    financial: { state: 'READY', reasons: [], checks: [] },
  }),
};

interface ProductRoomsHarness {
  store: ProductStore;
  rooms: ProductRooms;
  runtime: SdkRoomRuntime;
  stub: RuntimeStub;
  issueCredentials: ReturnType<typeof vi.fn>;
}

function makeProductRoomsHarness(stub: RuntimeStub): ProductRoomsHarness {
  const store = openStore();
  const { deps, issueCredentials } = makeDeps(store, stub);
  const runtime = new SdkRoomRuntime(deps);
  const agents = new AgentCatalog([ACE, BEE]);
  const rooms = new ProductRooms({
    store,
    agents,
    competitions: new CadenceCompetitions(),
    platform: PROBE,
    challenge: null,
    runtime,
  });
  return { store, rooms, runtime, stub, issueCredentials };
}

describe('ProductRooms ACTIVE attachment cadence', () => {
  it('invokes runtime.attach on the running cadence and costs nothing when already healthy', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const stub = runtimeStub({
      failStart: (agentId, attempt) => agentId === 'bee' && attempt === 1,
    });
    const harness = makeProductRoomsHarness(stub);
    const created = harness.rooms.create({
      name: 'Cadence',
      mode: 'SPONSORED',
      humanCount: 1,
      agentIds: ['ace', 'bee'],
      finance: null,
      creator: ALICE,
      admin: false,
    });
    const attachSpy = vi.spyOn(harness.runtime, 'attach');
    const active = await harness.rooms.start(created.id, ALICE_ACTOR);
    expect(active.status).toBe('ACTIVE');
    expect(attachSpy).toHaveBeenCalledTimes(1);
    // First attach: ace healthy, bee failed its first start.
    expect(harness.runtime.attachedAgentCount(created.id)).toBe(1);
    expect(stub.startCalls(created.id, 'ace')).toBe(1);
    expect(stub.startCalls(created.id, 'bee')).toBe(1);
    expect(harness.issueCredentials).toHaveBeenCalledTimes(1);

    // The RUNNING non-settlement cadence retries attachment: only the missing
    // agent is started; the healthy adapter costs zero.
    vi.setSystemTime(Date.now() + 30_000);
    const recovered = await harness.rooms.reconcileAll();
    expect(recovered.PENDING).toBe(1);
    expect(attachSpy).toHaveBeenCalledTimes(2);
    expect(harness.runtime.attachedAgentCount(created.id)).toBe(2);
    expect(stub.startCalls(created.id, 'ace')).toBe(1);
    expect(stub.startCalls(created.id, 'bee')).toBe(2);
    expect(harness.issueCredentials).toHaveBeenCalledTimes(1);

    // A fully healthy room keeps the cadence but performs no adapter work.
    vi.setSystemTime(Date.now() + 30_000);
    const healthy = await harness.rooms.reconcileAll();
    expect(healthy.PENDING).toBe(1);
    expect(attachSpy).toHaveBeenCalledTimes(3);
    expect(stub.startCalls(created.id, 'ace')).toBe(1);
    expect(stub.startCalls(created.id, 'bee')).toBe(2);
    expect(harness.issueCredentials).toHaveBeenCalledTimes(1);
  });

  it('serializes startup recovery with an explicit start without duplicate attachment', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const stub = runtimeStub();
    const harness = makeProductRoomsHarness(stub);
    const created = harness.rooms.create({
      name: 'Recover Start',
      mode: 'SPONSORED',
      humanCount: 1,
      agentIds: ['ace', 'bee'],
      finance: null,
      creator: ALICE,
      admin: false,
    });
    const active = await harness.rooms.start(created.id, ALICE_ACTOR);
    expect(active.status).toBe('ACTIVE');
    expect(stub.startCalls(created.id, 'ace')).toBe(1);
    expect(stub.startCalls(created.id, 'bee')).toBe(1);
    expect(harness.issueCredentials).toHaveBeenCalledTimes(1);

    // Gate the attach seam and prove ProductRooms serializes recover() and
    // start() per room: never two concurrent attachment passes.
    const realAttach = harness.runtime.attach.bind(harness.runtime);
    let concurrent = 0;
    let maxConcurrent = 0;
    let entered = 0;
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    vi.spyOn(harness.runtime, 'attach').mockImplementation(async (room) => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      entered += 1;
      await gate;
      await realAttach(room);
      concurrent -= 1;
    });

    const recovering = harness.rooms.recover();
    const starting = harness.rooms.start(created.id, ALICE_ACTOR);
    await waitFor(() => entered === 1, 'first serialized attach');
    expect(maxConcurrent).toBe(1);
    releaseGate();
    await Promise.all([recovering, starting]);
    expect(maxConcurrent).toBe(1);

    // No duplicate runtime/credential work from the overlap.
    expect(stub.startCalls(created.id, 'ace')).toBe(1);
    expect(stub.startCalls(created.id, 'bee')).toBe(1);
    expect(harness.issueCredentials).toHaveBeenCalledTimes(1);
    expect(harness.runtime.attachedAgentCount(created.id)).toBe(2);
  });
});
