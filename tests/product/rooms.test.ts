/**
 * Product room orchestration tests.
 *
 * The product store is the real SQLite-backed `ProductStore` (in-memory
 * database, real migrations). The platform is a fake implementing the narrow
 * `PlatformCompetitions` / `PlatformProbe` contracts; no network, no platform
 * process and no provider credentials are required.
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

import { AgentCatalog, type AgentConfigInput } from '../../src/product/catalog.js';
import { seatPromptPolicy } from '../../src/llm/prompt-policy.js';
import { seatObservationFixture } from './fixtures.js';
import { ProductStore } from '../../src/product/store.js';
import {
  ProductRoomError,
  ProductRooms,
  challengeTermsVersion,
  type ChallengeTermsConfig,
  type PlatformCompetitions,
  type PlatformProbe,
  type RoomRuntime,
} from '../../src/product/rooms.js';

const REPO_MIGRATIONS = resolve(process.cwd(), 'migrations');
const CHALLENGE: ChallengeTermsConfig = {
  assetId: 'eip155:31337/erc20:0x0000000000000000000000000000000000000001',
  entryAtomic: '1000',
  prizeAtomic: '5000',
  sponsorPrincipalId: 'svc:sponsor',
};
const FINANCE = {
  assetId: CHALLENGE.assetId,
  entryAtomic: CHALLENGE.entryAtomic,
  prizeAtomic: CHALLENGE.prizeAtomic,
  optIn: true as const,
};
const ALICE = { principalId: 'u:alice', walletAddress: '0xalice' };
const BOB = { principalId: 'u:bob', walletAddress: '0xbob' };
const CAROL = { principalId: 'u:carol', walletAddress: null };

const ACE: AgentConfigInput = {
  id: 'ace',
  name: 'Ace',
  model: 'test-model',
  provider: 'openai-compatible',
  baseUrl: 'http://127.0.0.1:9/v1',
  keyEnv: 'ACE_KEY',
  principalId: 'svc:ace',
  promptPolicyId: seatPromptPolicy.id,
  promptPolicyHash: seatPromptPolicy.hash,
  pricing: { inputMicroUsdPerMillionTokens: 0, outputMicroUsdPerMillionTokens: 0 },
  limits: { maxCallsPerRoom: 10, maxCostMicroUsdPerRoom: 0, maxCostMicroUsdPerCall: 0 },
  enabled: true,
};
const BEE: AgentConfigInput = { ...ACE, id: 'bee', name: 'Bee', principalId: 'svc:bee' };

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

async function codeOfAsync(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

class FakeCompetitions implements PlatformCompetitions {
  readonly createKeys: string[] = [];
  readonly startKeys: string[] = [];
  readonly settleKeys: string[] = [];
  readonly byKey = new Map<string, Competition>();
  readonly byId = new Map<string, Competition>();
  readonly credentials: Array<{ competitionId: string; request: IssueAgentCredentialRequest }> = [];
  failStartOnce = false;
  failCreateOnce = false;
  failCredentialOnce = false;
  getCalls = 0;
  private sequence = 0;

  /** Test hook: simulate the paying wallet opting in through the public SDK. */
  markPaid(competitionId: string, principalId: string): void {
    const competition = this.byId.get(competitionId);
    if (competition === undefined) throw new Error('competition not found');
    this.replace({
      ...competition,
      entrants: competition.entrants.map((entrant) =>
        entrant.principalId === principalId
          ? { ...entrant, entryState: 'PAID' as const }
          : entrant,
      ),
    });
  }

  async createCompetition(request: CreateCompetitionRequest): Promise<CreateCompetitionResponse> {
    if (this.failCreateOnce) {
      this.failCreateOnce = false;
      throw new Error('platform create unavailable');
    }
    this.createKeys.push(request.idempotencyKey);
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
      startingStack: request.startingStack ?? 1000,
      smallBlind: request.smallBlind ?? 10,
      bigBlind: request.bigBlind ?? 20,
      entrants: request.entrants.map((entrant, index) => ({
        principalId: entrant.principalId,
        kind: entrant.kind,
        seat: index,
        entryState:
          request.mode === 'ASSET' && entrant.kind === 'WALLET' ? 'PENDING' : 'NOT_REQUIRED',
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
    this.getCalls += 1;
    const competition = this.byId.get(competitionId);
    if (competition === undefined) throw new Error('competition not found');
    return competition;
  }

  async startCompetition(
    competitionId: string,
    _request: StartCompetitionRequest,
  ): Promise<StartCompetitionResponse> {
    if (this.failStartOnce) {
      this.failStartOnce = false;
      throw new Error('platform start unavailable');
    }
    this.startKeys.push(competitionId);
    const competition = this.byId.get(competitionId);
    if (competition === undefined) throw new Error('competition not found');
    this.replace({
      ...competition,
      status: 'RUNNING',
      startedAt: new Date().toISOString(),
    });
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
    competitionId: string,
    _request: SettleCompetitionRequest,
  ): Promise<SettleCompetitionResponse> {
    this.settleKeys.push(competitionId);
    const competition = this.byId.get(competitionId);
    if (competition === undefined) throw new Error('competition not found');
    this.replace({
      ...competition,
      status: 'FINISHED',
      finishedAt: new Date().toISOString(),
    });
    const placements = competition.entrants.map((entrant, index) => ({
      principalId: entrant.principalId,
      kind: entrant.kind,
      placement: index + 1,
      prize: null,
    }));
    return {
      success: true,
      competitionId,
      winnerPrincipalId: placements[0]!.principalId,
      winnerKind: placements[0]!.kind,
      prizeStatus: competition.mode === 'ASSET' ? 'RELEASED' : 'NOT_APPLICABLE',
      prize: null,
      placements,
    };
  }

  async cancelCompetition(competitionId: string) {
    const competition = await this.getCompetition(competitionId);
    if (competition.status === 'RUNNING') throw new Error('already started');
    const cancelledAt = competition.cancelledAt ?? new Date().toISOString();
    const entries = competition.entrants.map((entrant) => {
      const refunded = entrant.entryState === 'PAID' || entrant.entryState === 'REFUNDED';
      return { ...entrant, entryState: refunded ? 'REFUNDED' as const : entrant.entryState,
        refunded, refundJournalId: refunded ? `refund-${entrant.principalId}` : null };
    });
    this.replace({ ...competition, status: 'CANCELLED', cancelledAt,
      prizeStatus: competition.mode === 'ASSET' ? 'RELEASED' : 'NOT_APPLICABLE',
      entrants: entries.map(({ principalId, kind, entryState }, seat) => ({ principalId, kind, entryState, seat })),
    });
    return { success: true as const, competitionId, status: 'CANCELLED' as const, cancelledAt,
      prizeStatus: competition.mode === 'ASSET' ? 'RELEASED' as const : 'NOT_APPLICABLE' as const,
      prize: competition.terms?.prize ? { assetId: competition.terms.prize.assetId, amountAtomic: competition.terms.prize.amountAtomic } : null,
      entries: entries.map(({ principalId, kind, entryState, refunded, refundJournalId }) => ({ principalId, kind, entryState, refunded, refundJournalId })),
    };
  }

  async issueAgentCredential(
    competitionId: string,
    request: IssueAgentCredentialRequest,
  ): Promise<IssuedAgentCredential> {
    if (this.failCredentialOnce) {
      this.failCredentialOnce = false;
      throw new Error('competition:orchestrate capability unavailable');
    }
    this.credentials.push({ competitionId, request });
    const competition = await this.getCompetition(competitionId);
    return {
      credentialId: `credential-${request.principalId}`,
      principalId: request.principalId,
      competitionId,
      tableId: competition.tableId,
      name: request.name,
      scopes: request.scopes ?? ['table:observe', 'table:act', 'table:chat'],
      seat: request.seat ?? null,
      expiresAt: null,
      token: `runtime-token-${request.principalId}`,
      rotated: false,
    };
  }

  /** Test hook: overwrite a competition projection. */
  setCompetition(competitionId: string, patch: Partial<Competition>): void {
    const current = this.byId.get(competitionId);
    if (current === undefined) throw new Error('competition not found');
    this.replace({ ...current, ...patch });
  }

  private replace(competition: Competition): void {
    this.byId.set(competition.id, competition);
    for (const [key, value] of this.byKey) {
      if (value.id === competition.id) this.byKey.set(key, competition);
    }
  }
}

function fakeProbe(readinessState = 'READY'): PlatformProbe {
  return {
    health: vi.fn(async () => ({ status: 'ok', timestamp: Date.now() })),
    readiness: vi.fn(async () => ({
      status: readinessState === 'READY' ? 'ready' : 'not_ready',
      timestamp: Date.now(),
      checks: [],
      financial: { state: readinessState, reasons: [], checks: [] },
    })),
  };
}

function setup(options: {
  challenge?: ChallengeTermsConfig | null;
  readiness?: string;
  runtime?: RoomRuntime;
} = {}): {
  store: ProductStore;
  rooms: ProductRooms;
  competitions: FakeCompetitions;
  probe: PlatformProbe;
} {
  const store = ProductStore.open({ path: ':memory:', migrationsDir: REPO_MIGRATIONS });
  const agents = new AgentCatalog([ACE, BEE]);
  const competitions = new FakeCompetitions();
  const probe = fakeProbe(options.readiness ?? 'READY');
  const rooms = new ProductRooms({
    store,
    agents,
    competitions,
    platform: probe,
    challenge: options.challenge === undefined ? CHALLENGE : options.challenge,
    runtime: options.runtime,
  });
  return { store, rooms, competitions, probe };
}

let store: ProductStore | null = null;
afterEach(() => {
  store?.close();
  store = null;
});

function openSetup(options: {
  challenge?: ChallengeTermsConfig | null;
  readiness?: string;
  runtime?: RoomRuntime;
} = {}) {
  const context = setup(options);
  store = context.store;
  return context;
}

describe('product rooms', () => {
  it('creates a SPONSORED room whose policy snapshot is the desired roster', () => {
    const { rooms } = openSetup();
    const created = rooms.create({
      name: 'Friday Table',
      mode: 'SPONSORED',
      humanCount: 2,
      agentIds: ['ace'],
      finance: null,
      creator: ALICE,
      admin: false,
    });
    expect(created.status).toBe('WAITING_FOR_ROSTER');
    expect(created.mode).toBe('SPONSORED');
    expect(created.humanCount).toBe(2);
    expect(created.agentCount).toBe(1);
    expect(created.totalSeats).toBe(3);
    expect(
      [...created.participants.map((participant) => participant.id)].sort(),
    ).toEqual(['svc:ace', 'u:alice']);
    expect(created.finance).toBeNull();

    const joined = rooms.join(created.id, BOB);
    expect([...joined.participants.map((participant) => participant.id)].sort()).toEqual([
      'svc:ace',
      'u:alice',
      'u:bob',
    ]);
    expect(joined.humanCount).toBe(2);
    expect(rooms.join(created.id, BOB).participants).toHaveLength(3);

    expect(codeOf(() => rooms.join(created.id, CAROL))).toBe('ROOM_FULL');
    expect(rooms.get(created.id).participants.some((participant) => participant.id === CAROL.principalId)).toBe(false);
  });

  it('persists desired counts without fabricating unclaimed participant identities', () => {
    const { rooms, store: productStore } = openSetup();
    const created = rooms.create({
      name: 'Open Seats',
      mode: 'SPONSORED',
      humanCount: 3,
      agentIds: ['ace'],
      finance: null,
      creator: ALICE,
      admin: false,
    });
    expect(created.humanCount).toBe(3);
    expect(created.agentCount).toBe(1);
    expect(created.totalSeats).toBe(4);
    expect(created.participants.map((participant) => participant.id).sort()).toEqual([
      'svc:ace',
      'u:alice',
    ]);
    const rows = productStore.listParticipants(created.id);
    expect(rows).toHaveLength(2);
    expect(rows.every((participant) => participant.principalId.length > 0)).toBe(true);
    expect(JSON.stringify(productStore.getRoom(created.id)!.policy)).not.toMatch(
      /open-slot|nlhe:/,
    );

    rooms.join(created.id, BOB);
    rooms.join(created.id, CAROL);
    const full = rooms.get(created.id);
    expect(full.participants).toHaveLength(4);
    expect(full.humanCount).toBe(3);
    expect(codeOf(() => rooms.join(created.id, { principalId: 'u:dave', walletAddress: null }))).toBe(
      'ROOM_FULL',
    );
  });

  it('requires the roster to be complete before start and keeps start member-only', async () => {
    const { rooms, competitions } = openSetup();
    const created = rooms.create({
      name: 'Roster Check',
      mode: 'SPONSORED',
      humanCount: 2,
      agentIds: ['ace'],
      finance: null,
      creator: ALICE,
      admin: false,
    });

    expect(
      await codeOfAsync(() =>
        rooms.start(created.id, { principalId: ALICE.principalId, admin: false }),
      ),
    ).toBe('ROSTER_INCOMPLETE');
    expect(competitions.createKeys).toHaveLength(0);

    rooms.join(created.id, BOB);
    expect(
      await codeOfAsync(() =>
        rooms.start(created.id, { principalId: CAROL.principalId, admin: false }),
      ),
    ).toBe('NOT_AUTHORIZED');

    const active = await rooms.start(created.id, { principalId: ALICE.principalId, admin: false });
    expect(active.status).toBe('ACTIVE');
    expect(active.pokerTableId).toMatch(/^table-comp-/);
    expect(active.pokerCompetitionId).toMatch(/^comp-/);
    expect(active.participants.map((participant) => participant.seat)).toEqual([0, 1, 2]);

    const request = competitions.byId.get(active.pokerCompetitionId!)!;
    expect(request.mode).toBe('NONFINANCIAL');
    expect(request.terms).toBeNull();
    expect([...request.entrants.map((entrant) => entrant.principalId)].sort()).toEqual(
      ['svc:ace', 'u:alice', 'u:bob'].sort(),
    );
    expect(request.entrants.filter((entrant) => entrant.kind === 'SERVICE')).toHaveLength(1);
  });

  it('allows product admin to schedule an agent-only room', async () => {
    const { rooms, competitions } = openSetup();
    const created = rooms.create({
      name: 'Scheduled Agents',
      mode: 'SPONSORED',
      humanCount: 0,
      agentIds: ['ace', 'bee'],
      finance: null,
      creator: null,
      admin: true,
    });
    expect(created.humanCount).toBe(0);
    expect(created.agentCount).toBe(2);
    expect(created.participants.map((participant) => participant.id)).toEqual(['svc:ace', 'svc:bee']);

    expect(
      await codeOfAsync(() =>
        rooms.start(created.id, { principalId: null, admin: true }),
      ),
    ).toBeUndefined();
    const competition = [...competitions.byId.values()][0]!;
    expect(competition.entrants.every((entrant) => entrant.kind === 'SERVICE')).toBe(true);
  });

  it('rejects human-only rooms from the product admin credential and unreachable roster', () => {
    const { rooms } = openSetup();
    expect(
      codeOf(() =>
        rooms.create({
          name: 'Admin Humans',
          mode: 'SPONSORED',
          humanCount: 2,
          agentIds: [],
          finance: null,
          creator: null,
          admin: true,
        }),
      ),
    ).toBe('NOT_AUTHORIZED');

    const created = rooms.create({
      name: 'Humans Only',
      mode: 'SPONSORED',
      humanCount: 2,
      agentIds: [],
      finance: null,
      creator: ALICE,
      admin: false,
    });
    expect(created.agentCount).toBe(0);
    expect(codeOf(() => rooms.join(created.id, CAROL))).toBeUndefined();
    expect(codeOf(() => rooms.join(created.id, BOB))).toBe('ROOM_FULL');
  });

  it('leaves and rejoins open human seats', () => {
    const { rooms } = openSetup();
    const created = rooms.create({
      name: 'Leave Join',
      mode: 'SPONSORED',
      humanCount: 2,
      agentIds: ['ace'],
      finance: null,
      creator: ALICE,
      admin: false,
    });
    const afterLeave = rooms.leave(created.id, ALICE.principalId);
    expect(afterLeave.participants.map((participant) => participant.id)).toEqual(['svc:ace']);
    expect(codeOf(() => rooms.leave(created.id, CAROL.principalId))).toBe('NOT_AUTHORIZED');
    rooms.join(created.id, ALICE);
    rooms.join(created.id, BOB);
    expect(rooms.get(created.id).participants).toHaveLength(3);
  });

  it('keeps paid challenge disabled unless configured terms are used', () => {
    const disabled = openSetup({ challenge: null });
    expect(codeOf(() =>
      disabled.rooms.create({
        name: 'Challenge',
        mode: 'CHALLENGE',
        humanCount: 1,
        agentIds: ['ace'],
        finance: { ...FINANCE },
        creator: ALICE,
        admin: false,
      }),
    )).toBe('CHALLENGE_DISABLED');
    expect(disabled.rooms.challengeTerms()).toBeNull();
  });

  it('requires the exact configured challenge terms and explicit opt-in', () => {
    const { rooms } = openSetup();
    const base = {
      name: 'Paid Challenge',
      mode: 'CHALLENGE' as const,
      humanCount: 1,
      agentIds: ['ace'],
      creator: ALICE,
      admin: false,
    };
    expect(codeOf(() => rooms.create({ ...base, finance: null }))).toBe('INVALID_REQUEST');
    expect(
      codeOf(() => rooms.create({ ...base, finance: { ...FINANCE, optIn: false as true } })),
    ).toBe('INVALID_REQUEST');
    expect(
      codeOf(() =>
        rooms.create({
          ...base,
          finance: {
            ...FINANCE,
            assetId: 'eip155:31337/erc20:0x0000000000000000000000000000000000000002',
          },
        }),
      ),
    ).toBe('TERMS_MISMATCH');
    expect(
      codeOf(() => rooms.create({ ...base, finance: { ...FINANCE, entryAtomic: '999' } })),
    ).toBe('TERMS_MISMATCH');
    expect(
      codeOf(() => rooms.create({ ...base, finance: { ...FINANCE, prizeAtomic: '1' } })),
    ).toBe('TERMS_MISMATCH');
    expect(
      codeOf(() => rooms.create({ ...base, finance: { ...FINANCE, entryAtomic: '01' } })),
    ).toBe('INVALID_REQUEST');
    expect(
      codeOf(() => rooms.create({ ...base, humanCount: 2, finance: { ...FINANCE } })),
    ).toBe('INVALID_REQUEST');

    const created = rooms.create({ ...base, finance: { ...FINANCE } });
    expect(created.finance).toMatchObject({
      assetId: CHALLENGE.assetId,
      entryAtomic: CHALLENGE.entryAtomic,
      prizeAtomic: CHALLENGE.prizeAtomic,
      termsVersion: challengeTermsVersion(CHALLENGE),
    });
  });

  it('fails paid start closed until platform financial readiness is READY', async () => {
    const { rooms, competitions } = openSetup({ readiness: 'NOT_READY' });
    const created = rooms.create({
      name: 'Fail Closed',
      mode: 'CHALLENGE',
      humanCount: 1,
      agentIds: ['ace'],
      finance: { ...FINANCE },
      creator: ALICE,
      admin: false,
    });
    expect(
      await codeOfAsync(() =>
        rooms.start(created.id, { principalId: ALICE.principalId, admin: false }),
      ),
    ).toBe('PLATFORM_UNAVAILABLE');
    expect(rooms.get(created.id).status).toBe('WAITING_FOR_ROSTER');
    expect(competitions.createKeys).toHaveLength(0);
  });

  it('persists cancellation intent and recovers without financial readiness or another start', async () => {
    const { rooms, competitions, probe, store: productStore } = openSetup();
    const room = rooms.create({ name: 'Abandoned paid room', mode: 'CHALLENGE', humanCount: 1,
      agentIds: ['ace'], finance: FINANCE, creator: ALICE, admin: false });
    const pending = await rooms.start(room.id, { principalId: ALICE.principalId, admin: false });
    competitions.markPaid(pending.pokerCompetitionId!, ALICE.principalId);
    vi.mocked(probe.readiness).mockRejectedValue(new Error('finance unavailable'));
    const cancel = vi.spyOn(competitions, 'cancelCompetition');
    cancel.mockRejectedValueOnce(new Error('temporary platform outage'));
    await expect(rooms.cancel(room.id, { principalId: null, admin: true })).rejects.toMatchObject({ code: 'PLATFORM_REJECTED' });
    expect(productStore.roomCancellationRequested(room.id)).toBe(true);
    await expect(rooms.start(room.id, { principalId: null, admin: true })).rejects.toMatchObject({ code: 'ROOM_STATE' });
    await rooms.recover();
    expect(rooms.get(room.id)).toMatchObject({ status: 'FAILED', failureReason: 'PLATFORM_CANCELLED' });
    expect(competitions.startKeys).toHaveLength(0);
    await expect(rooms.cancel(room.id, { principalId: null, admin: true })).resolves.toMatchObject({ status: 'FAILED' });
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it('can cancel a recorded paid competition after CHALLENGE admission is disabled', async () => {
    const { rooms, competitions, probe, store: productStore } = openSetup();
    const room = rooms.create({ name: 'Old terms', mode: 'CHALLENGE', humanCount: 1,
      agentIds: ['ace'], finance: FINANCE, creator: ALICE, admin: false });
    const pending = await rooms.start(room.id, { principalId: ALICE.principalId, admin: false });
    competitions.markPaid(pending.pokerCompetitionId!, ALICE.principalId);
    const restarted = new ProductRooms({ store: productStore, agents: new AgentCatalog([]), competitions,
      platform: probe, challenge: null });
    await expect(restarted.cancel(room.id, { principalId: null, admin: true })).resolves.toMatchObject({ status: 'FAILED' });
    expect(competitions.createKeys).toHaveLength(1);
  });

  it('replays the stable create key when the platform accepted creation but its response was lost', async () => {
    const { rooms, competitions } = openSetup();
    const room = rooms.create({ name: 'Lost create', mode: 'SPONSORED', humanCount: 0,
      agentIds: ['ace', 'bee'], finance: null, creator: null, admin: true });
    const create = competitions.createCompetition.bind(competitions);
    vi.spyOn(competitions, 'createCompetition').mockImplementationOnce(async (request) => {
      await create(request);
      throw new Error('response lost after commit');
    });
    await expect(rooms.start(room.id, { principalId: null, admin: true })).rejects.toMatchObject({ code: 'PLATFORM_REJECTED' });
    await rooms.recover();
    expect(rooms.get(room.id).status).toBe('ACTIVE');
    expect(competitions.byId.size).toBe(1);
    expect(competitions.createKeys[0]).toBe(competitions.createKeys[1]);
  });

  it('cancels an unprovisioned room locally but refuses to cancel an active room', async () => {
    const { rooms, competitions } = openSetup();
    const room = rooms.create({ name: 'Unstarted', mode: 'SPONSORED', humanCount: 0,
      agentIds: ['ace', 'bee'], finance: null, creator: null, admin: true });
    await expect(rooms.cancel(room.id, { principalId: 'stranger', admin: false })).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
    await expect(rooms.cancel(room.id, { principalId: null, admin: true })).resolves.toMatchObject({ status: 'FAILED' });
    expect(competitions.createKeys).toHaveLength(0);
    const active = rooms.create({ name: 'Started', mode: 'SPONSORED', humanCount: 0,
      agentIds: ['ace', 'bee'], finance: null, creator: null, admin: true });
    await rooms.start(active.id, { principalId: null, admin: true });
    await expect(rooms.cancel(active.id, { principalId: null, admin: true })).rejects.toMatchObject({ code: 'ROOM_STATE' });
  });

  it('keeps a paid room PROVISIONING until the wallet entry is PAID, then starts it', async () => {
    const { rooms, competitions } = openSetup();
    const created = rooms.create({
      name: 'Paid Challenge',
      mode: 'CHALLENGE',
      humanCount: 1,
      agentIds: ['ace'],
      finance: { ...FINANCE },
      creator: ALICE,
      admin: false,
    });

    const pending = await rooms.start(created.id, { principalId: ALICE.principalId, admin: false });
    expect(pending.status).toBe('PROVISIONING');
    expect(pending.pokerCompetitionId).toMatch(/^comp-/);
    expect(pending.pokerTableId).toMatch(/^table-comp-/);
    // No platform start before the entry is settled, and no local paid flag.
    expect(competitions.startKeys).toHaveLength(0);
    expect(competitions.createKeys).toHaveLength(1);
    const competition = competitions.byId.get(pending.pokerCompetitionId!)!;
    expect(competition.terms).toMatchObject({
      entry: { assetId: CHALLENGE.assetId, amountAtomic: CHALLENGE.entryAtomic },
      prize: { assetId: CHALLENGE.assetId, amountAtomic: CHALLENGE.prizeAtomic },
    });
    expect(
      competition.entrants.find((entrant) => entrant.principalId === ALICE.principalId)?.entryState,
    ).toBe('PENDING');
    expect(JSON.stringify(pending)).not.toMatch(/entryState|"paid"/i);

    // The wallet opts in directly through the public SDK; the product then
    // reads the authoritative PAID state and starts the competition.
    competitions.markPaid(competition.id, ALICE.principalId);
    const active = await rooms.start(created.id, { principalId: ALICE.principalId, admin: false });
    expect(active.status).toBe('ACTIVE');
    expect(competitions.startKeys).toHaveLength(1);
    expect(competitions.createKeys).toHaveLength(1);
  });

  it('fails a provisionally pending paid room whose competition is cancelled', async () => {
    const { rooms, competitions } = openSetup();
    const created = rooms.create({
      name: 'Cancelled Paid',
      mode: 'CHALLENGE',
      humanCount: 1,
      agentIds: ['ace'],
      finance: { ...FINANCE },
      creator: ALICE,
      admin: false,
    });
    const pending = await rooms.start(created.id, { principalId: ALICE.principalId, admin: false });
    expect(pending.status).toBe('PROVISIONING');
    const competition = competitions.byId.get(pending.pokerCompetitionId!)!;
    competitions.setCompetition(competition.id, { status: 'CANCELLED' });
    expect(await rooms.reconcileRoom(created.id)).toBe('FAILED');
    expect(rooms.get(created.id)).toMatchObject({
      status: 'FAILED',
      failureReason: 'PLATFORM_CANCELLED',
    });
  });

  it('settles placements from the platform projection and records them once', async () => {
    const { rooms, competitions } = openSetup();
    const created = rooms.create({
      name: 'Settled',
      mode: 'SPONSORED',
      humanCount: 2,
      agentIds: ['ace'],
      finance: null,
      creator: ALICE,
      admin: false,
    });
    rooms.join(created.id, BOB);
    const active = await rooms.start(created.id, { principalId: ALICE.principalId, admin: false });
    expect(await rooms.reconcileRoom(active.id)).toBe('PENDING');

    const competition = competitions.byId.get(active.pokerCompetitionId!)!;
    competitions.setCompetition(competition.id, { status: 'FINISHED', finishedAt: new Date().toISOString() });

    expect(await rooms.reconcileRoom(active.id)).toBe('COMPLETED');
    const complete = rooms.get(active.id);
    expect(complete.status).toBe('COMPLETE');
    expect(complete.results).toHaveLength(3);
    expect(complete.results!.map((result) => result.finishPosition)).toEqual([1, 2, 3]);
    expect(complete.results!.every((result) => !('prize' in result) && !('payout' in result))).toBe(true);
    // A fully complete immutable room is skipped before any platform read.
    expect(await rooms.reconcileRoom(active.id)).toBe('SKIPPED');
    expect(rooms.get(active.id).results).toHaveLength(3);
  });

  it('settles a RUNNING competition as soon as the platform reports settlementReady', async () => {
    const runtime: RoomRuntime = {
      attach: vi.fn(async () => undefined),
      detach: vi.fn(async () => undefined),
      recoverRecorded: vi.fn(async () => undefined),
    };
    const { rooms, competitions } = openSetup({ runtime });
    const created = rooms.create({
      name: 'Settlement Ready',
      mode: 'SPONSORED',
      humanCount: 2,
      agentIds: ['ace'],
      finance: null,
      creator: ALICE,
      admin: false,
    });
    rooms.join(created.id, BOB);
    const active = await rooms.start(created.id, { principalId: ALICE.principalId, admin: false });
    const competition = competitions.byId.get(active.pokerCompetitionId!)!;
    expect(competition.status).toBe('RUNNING');
    expect(competition.settlementReady).toBe(false);
    expect(await rooms.reconcileRoom(active.id)).toBe('PENDING');

    // The platform reports the backing game completed while the competition
    // is still RUNNING (status only becomes FINISHED through settle).
    competitions.setCompetition(competition.id, { settlementReady: true });
    expect(await rooms.reconcileRoom(active.id)).toBe('COMPLETED');
    const complete = rooms.get(active.id);
    expect(complete.status).toBe('COMPLETE');
    expect(complete.results).toHaveLength(3);
    expect(competitions.settleKeys).toHaveLength(1);
    expect(runtime.detach).toHaveBeenCalledWith(active.id);
  });

  it('recovers PROVISIONING rooms through the stable idempotency key', async () => {
    const { rooms, competitions } = openSetup();
    const created = rooms.create({
      name: 'Recoverable',
      mode: 'SPONSORED',
      humanCount: 2,
      agentIds: ['ace'],
      finance: null,
      creator: ALICE,
      admin: false,
    });
    rooms.join(created.id, BOB);
    competitions.failStartOnce = true;
    expect(
      await codeOfAsync(() =>
        rooms.start(created.id, { principalId: ALICE.principalId, admin: false }),
      ),
    ).toBe('PLATFORM_REJECTED');
    expect(rooms.get(created.id).status).toBe('PROVISIONING');
    expect(competitions.byId.size).toBe(1);

    const resumed = await rooms.start(created.id, { principalId: ALICE.principalId, admin: false });
    expect(resumed.status).toBe('ACTIVE');
    expect(competitions.byId.size).toBe(1);
    expect(competitions.createKeys).toHaveLength(1);
    expect(competitions.createKeys[0]).toContain(created.id);
  });

  it('issues narrow table credentials without a seat restriction, adding chat only when enabled', async () => {
    const { rooms, competitions } = openSetup();
    const created = rooms.create({
      name: 'Credentials',
      mode: 'SPONSORED',
      humanCount: 1,
      agentIds: ['ace'],
      finance: null,
      creator: ALICE,
      admin: false,
    });
    const active = await rooms.start(created.id, { principalId: ALICE.principalId, admin: false });

    const credentials = await rooms.issueAgentCredentials(active.id);
    expect(credentials[0]).toMatchObject({
      agentId: 'ace',
      principalId: 'svc:ace',
      credentialId: 'credential-svc:ace',
      token: 'runtime-token-svc:ace',
      scopes: ['table:observe', 'table:act'],
      seat: null,
    });
    const request = competitions.credentials[0]!.request;
    expect(request.principalId).toBe('svc:ace');
    expect('seat' in request).toBe(false);
    expect(request.expiresAt).toBeUndefined();

    const expiring = await rooms.issueAgentCredentials(active.id, {
      chatEnabled: true,
      expiresAt: '2030-01-01T00:00:00.000Z',
    });
    expect(expiring[0]!.scopes).toEqual(['table:observe', 'table:act', 'table:chat']);
    const chatRequest = competitions.credentials[1]!.request;
    expect(chatRequest.expiresAt).toBe('2030-01-01T00:00:00.000Z');
    expect('seat' in chatRequest).toBe(false);
  });

  it('fails closed when platform credential issuance is unavailable', async () => {
    const { rooms, competitions } = openSetup();
    const created = rooms.create({
      name: 'Credentials Unavailable',
      mode: 'SPONSORED',
      humanCount: 1,
      agentIds: ['ace'],
      finance: null,
      creator: ALICE,
      admin: false,
    });
    const active = await rooms.start(created.id, { principalId: ALICE.principalId, admin: false });
    competitions.failCredentialOnce = true;
    expect(await codeOfAsync(() => rooms.issueAgentCredentials(active.id))).toBe(
      'PLATFORM_REJECTED',
    );
  });

  it('detaches the runtime and drops room credentials on completion and failure', async () => {
    const runtime: RoomRuntime = {
      attach: vi.fn(async () => undefined),
      detach: vi.fn(async () => undefined),
    };
    const { rooms, competitions } = openSetup({ runtime });

    const completed = rooms.create({
      name: 'Detach Complete',
      mode: 'SPONSORED',
      humanCount: 2,
      agentIds: ['ace'],
      finance: null,
      creator: ALICE,
      admin: false,
    });
    rooms.join(completed.id, BOB);
    const active = await rooms.start(completed.id, { principalId: ALICE.principalId, admin: false });
    expect(runtime.attach).toHaveBeenCalledWith(expect.objectContaining({ id: completed.id }));
    const competition = competitions.byId.get(active.pokerCompetitionId!)!;
    competitions.setCompetition(competition.id, { status: 'FINISHED', finishedAt: new Date().toISOString() });
    expect(await rooms.reconcileRoom(completed.id)).toBe('COMPLETED');
    expect(runtime.detach).toHaveBeenCalledWith(completed.id);
    // A fully complete room with no pending trace is skipped without platform
    // work or another detach.
    expect(await rooms.reconcileRoom(completed.id)).toBe('SKIPPED');

    const cancelled = rooms.create({
      name: 'Detach Cancelled',
      mode: 'SPONSORED',
      humanCount: 2,
      agentIds: ['ace'],
      finance: null,
      creator: ALICE,
      admin: false,
    });
    rooms.join(cancelled.id, BOB);
    const running = await rooms.start(cancelled.id, { principalId: ALICE.principalId, admin: false });
    const cancelledCompetition = competitions.byId.get(running.pokerCompetitionId!)!;
    competitions.setCompetition(cancelledCompetition.id, { status: 'CANCELLED' });
    expect(await rooms.reconcileRoom(cancelled.id)).toBe('FAILED');
    expect(runtime.detach).toHaveBeenCalledWith(cancelled.id);
  });

  it('performs no platform work for a fully complete immutable room', async () => {
    const runtime: RoomRuntime = {
      attach: vi.fn(async () => undefined),
      detach: vi.fn(async () => undefined),
      recoverRecorded: vi.fn(async () => undefined),
    };
    const { rooms, competitions } = openSetup({ runtime });
    const created = rooms.create({
      name: 'Immutable Complete',
      mode: 'SPONSORED',
      humanCount: 2,
      agentIds: ['ace'],
      finance: null,
      creator: ALICE,
      admin: false,
    });
    rooms.join(created.id, BOB);
    const active = await rooms.start(created.id, { principalId: ALICE.principalId, admin: false });
    const competition = competitions.byId.get(active.pokerCompetitionId!)!;
    competitions.setCompetition(competition.id, {
      status: 'FINISHED',
      finishedAt: new Date().toISOString(),
    });
    expect(await rooms.reconcileRoom(active.id)).toBe('COMPLETED');

    const getCalls = competitions.getCalls;
    const settleCalls = competitions.settleKeys.length;
    expect(await rooms.reconcileRoom(active.id)).toBe('SKIPPED');
    expect(await rooms.reconcileRoom(active.id)).toBe('SKIPPED');
    expect(competitions.getCalls).toBe(getCalls);
    expect(competitions.settleKeys.length).toBe(settleCalls);
    expect(runtime.recoverRecorded).not.toHaveBeenCalled();

    // Read-only projections never attach a runtime or touch the platform.
    rooms.stats();
    rooms.get(active.id);
    rooms.auditRoom(active.id);
    expect(runtime.attach).toHaveBeenCalledTimes(1);
    expect(competitions.getCalls).toBe(getCalls);
  });

  it('recovers pending recorded receipts on terminal rooms even with a result present', async () => {
    const runtime: RoomRuntime = {
      attach: vi.fn(async () => undefined),
      detach: vi.fn(async () => undefined),
      recoverRecorded: vi.fn(async () => undefined),
    };
    const { rooms, competitions, store } = openSetup({ runtime });
    const created = rooms.create({
      name: 'Terminal Trace',
      mode: 'SPONSORED',
      humanCount: 2,
      agentIds: ['ace'],
      finance: null,
      creator: ALICE,
      admin: false,
    });
    rooms.join(created.id, BOB);
    const active = await rooms.start(created.id, { principalId: ALICE.principalId, admin: false });

    const decision = store.observeDecision({
      tableId: 'table-1',
      turnId: 'turn-1',
      principalId: 'svc:ace',
      roomId: active.id,
      observation: seatObservationFixture(),
      promptPolicyId: seatPromptPolicy.id,
      eventCursor: 1,
    });
    const started = store.startAttempt(decision.id, JSON.stringify({ request: 1 }));
    if (started.kind === 'started') {
      store.recordAttemptResponse(decision.id, started.attempt.id, {
        status: 'SUCCEEDED',
        responseJson: JSON.stringify({ response: 1 }),
        model: 'test-model',
        provider: 'openai-compatible',
        promptPolicyId: seatPromptPolicy.id,
        usage: { promptTokens: 1, completionTokens: 1, costMicroUsd: 0, latencyMs: 1 },
      });
    }
    store.submitResolvedAction(decision.id, JSON.stringify({ action: 'act-check' }));

    const competition = competitions.byId.get(active.pokerCompetitionId!)!;
    competitions.setCompetition(competition.id, {
      status: 'FINISHED',
      finishedAt: new Date().toISOString(),
    });
    expect(await rooms.reconcileRoom(active.id)).toBe('COMPLETED');
    expect(store.getRoomResult(active.id)).not.toBeNull();

    const getCalls = competitions.getCalls;
    await rooms.recover();
    expect(runtime.recoverRecorded).toHaveBeenCalledWith(
      expect.objectContaining({ id: active.id }),
    );
    // Recorded-only recovery never performs a platform read.
    expect(competitions.getCalls).toBe(getCalls);

    // Periodic terminal reconciliation retries the bounded recovery pass.
    expect(await rooms.reconcileRoom(active.id)).toBe('PENDING');
    expect(runtime.recoverRecorded).toHaveBeenCalledTimes(2);
    expect(competitions.getCalls).toBe(getCalls);
  });

  it('projects product statistics without financial P&L', async () => {
    const { rooms } = openSetup();
    const created = rooms.create({
      name: 'Stats',
      mode: 'SPONSORED',
      humanCount: 2,
      agentIds: ['ace'],
      finance: null,
      creator: ALICE,
      admin: false,
    });
    rooms.join(created.id, BOB);
    const stats = rooms.stats();
    expect(stats.rooms).toMatchObject({ total: 1, open: 1 });
    expect(stats.humans).toBe(2);
    expect(stats.agents).toBe(2);
    expect(stats.models).toEqual([]);
    expect(JSON.stringify(stats)).not.toMatch(/profit|payout|prize/i);
  });

  it('fails a platform-cancelled competition', async () => {
    const { rooms, competitions } = openSetup();
    const created = rooms.create({
      name: 'Cancelled',
      mode: 'SPONSORED',
      humanCount: 2,
      agentIds: ['ace'],
      finance: null,
      creator: ALICE,
      admin: false,
    });
    rooms.join(created.id, BOB);
    const active = await rooms.start(created.id, { principalId: ALICE.principalId, admin: false });
    const competition = competitions.byId.get(active.pokerCompetitionId!)!;
    competitions.setCompetition(competition.id, { status: 'CANCELLED' });
    expect(await rooms.reconcileRoom(active.id)).toBe('FAILED');
    expect(rooms.get(active.id)).toMatchObject({ status: 'FAILED', failureReason: 'PLATFORM_CANCELLED' });
  });

  it('rejects malformed create input and unknown agents', () => {
    const { rooms } = openSetup();
    const base = {
      name: 'Validate',
      mode: 'SPONSORED' as const,
      humanCount: 1,
      agentIds: ['ace'],
      finance: null,
      creator: ALICE,
      admin: false,
    };
    expect(codeOf(() => rooms.create({ ...base, name: '   ' }))).toBe('INVALID_REQUEST');
    expect(codeOf(() => rooms.create({ ...base, humanCount: 1, agentIds: ['ace', 'ace'] }))).toBe('INVALID_REQUEST');
    expect(codeOf(() => rooms.create({ ...base, humanCount: 9, agentIds: ['ace', 'bee'] }))).toBe('INVALID_REQUEST');
    expect(codeOf(() => rooms.create({ ...base, agentIds: ['ghost'] }))).toBe('AGENT_NOT_AVAILABLE');
    expect(
      codeOf(() =>
        rooms.create({
          ...base,
          agentIds: [],
          humanCount: 2,
          creator: null,
          admin: false,
        }),
      ),
    ).toBe('NOT_AUTHORIZED');
    expect(new ProductRoomError('ROOM_FULL', 'x').code).toBe('ROOM_FULL');
  });
});
