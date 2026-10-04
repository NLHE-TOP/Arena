/**
 * Product HTTP API contract tests.
 *
 * The Fastify app is composed through the real `buildServer` (no listener),
 * with an injected in-memory product store, fake SDK competition surface and a
 * fake bearer introspection function. No platform process, provider or network
 * is involved.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  Competition,
  CreateCompetitionRequest,
  CreateCompetitionResponse,
  IssueAgentCredentialRequest,
  IssuedAgentCredential,
  Principal,
  SettleCompetitionRequest,
  SettleCompetitionResponse,
  StartCompetitionRequest,
  StartCompetitionResponse,
} from '@pokertools/types';

import { loadConfig } from '../../src/config.js';
import { buildAgentRuntimeConfig, SdkRoomRuntime } from '../../src/agents/rooms.js';
import { createPlatformProbe, platformCompetitions } from '../../src/platform.js';
import {
  buildServer,
  configuredSecrets,
  loadAgentConfigsFile,
  syncAgentCatalog,
} from '../../src/main.js';
import { AgentCatalog, type AgentConfigInput } from '../../src/product/catalog.js';
import { seatPromptPolicy } from '../../src/llm/prompt-policy.js';
import { ProductStore } from '../../src/product/store.js';
import {
  ProductRooms,
  type ChallengeTermsConfig,
  type PlatformCompetitions,
  type PlatformProbe,
} from '../../src/product/rooms.js';
import { seatObservationFixture } from './fixtures.js';

const REPO_MIGRATIONS = resolve(process.cwd(), 'migrations');
const PUBLIC_ORIGIN = 'https://nlhe.example';
const ADMIN_TOKEN = 'test-admin-token-placeholder-32-characters';
const CHALLENGE: ChallengeTermsConfig = {
  assetId: 'eip155:31337/erc20:0x0000000000000000000000000000000000000001',
  entryAtomic: '1000',
  prizeAtomic: '5000',
  sponsorPrincipalId: 'svc:sponsor',
};

const PRINCIPALS: Record<string, Principal> = {
  'alice-token': { id: 'u:alice', kind: 'WALLET', walletAddress: '0xalice' },
  'bob-token': { id: 'u:bob', kind: 'WALLET', walletAddress: '0xbob' },
  'carol-token': { id: 'u:carol', kind: 'WALLET', walletAddress: '0xcarol' },
  'service-token': { id: 'svc:service', kind: 'SERVICE', walletAddress: null },
};

type SdkFetchInit = { headers?: Record<string, string>; body?: unknown };
type SdkFetchHandler = (url: URL, init: SdkFetchInit) => Response | undefined;

/** Injected public-SDK fetch boundary: no production SDK code is mocked. */
function sdkFetch(handler: SdkFetchHandler): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const response = handler(url, {
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body,
    });
    return response ?? jsonResponse({ error: 'NOT_FOUND' }, 404);
  }) as typeof fetch;
}

async function withStubbedFetch<T>(handler: SdkFetchHandler, run: () => Promise<T>): Promise<T> {
  vi.stubGlobal('fetch', sdkFetch(handler));
  try {
    return await run();
  } finally {
    vi.unstubAllGlobals();
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const SERVICE_PRINCIPAL = { id: 'svc:orchestrator', kind: 'SERVICE', walletAddress: null };
const WALLET_PRINCIPAL = {
  id: 'u:admin',
  kind: 'WALLET',
  walletAddress: `0x${'1'.repeat(40)}`,
};
const READINESS_PAYLOAD = {
  status: 'ready',
  timestamp: 1,
  checks: [{ name: 'db', state: 'READY', mandatory: true, latencyMs: 1, detail: 'ok' }],
  financial: { state: 'READY', reasons: [], checks: [] },
};

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

class FakeCompetitions implements PlatformCompetitions {
  readonly byId = new Map<string, Competition>();
  readonly byKey = new Map<string, Competition>();
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
    const competition = this.byId.get(competitionId);
    if (competition === undefined) throw new Error('competition not found');
    return competition;
  }

  /** Test hook: overwrite a competition projection. */
  setCompetition(competitionId: string, patch: Partial<Competition>): void {
    const current = this.byId.get(competitionId);
    if (current === undefined) throw new Error('competition not found');
    this.byId.set(competitionId, { ...current, ...patch });
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
    competitionId: string,
    _request: SettleCompetitionRequest,
  ): Promise<SettleCompetitionResponse> {
    const competition = await this.getCompetition(competitionId);
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
      prizeStatus: 'NOT_APPLICABLE',
      prize: null,
      placements,
    };
  }

  async cancelCompetition(): Promise<never> {
    throw new Error('unexpected cancellation');
  }

  async issueAgentCredential(
    competitionId: string,
    request: IssueAgentCredentialRequest,
  ): Promise<IssuedAgentCredential> {
    const competition = await this.getCompetition(competitionId);
    return {
      credentialId: 'credential-1',
      principalId: request.principalId,
      competitionId,
      tableId: competition.tableId,
      name: request.name,
      scopes: ['table:observe', 'table:act', 'table:chat'],
      seat: null,
      expiresAt: null,
      token: 'runtime-token',
      rotated: false,
    };
  }
}

interface TestApp {
  app: Awaited<ReturnType<typeof buildServer>>;
  store: ProductStore;
  rooms: ProductRooms;
  competitions: FakeCompetitions;
  agents: AgentCatalog;
  config: ReturnType<typeof loadConfig>;
}

async function buildTestApp(
  options: { challengeEnabled?: boolean; ready?: boolean } = {},
): Promise<TestApp> {
  const config = loadConfig({
    POKERTOOLS_API_URL: 'https://poker.example',
    PUBLIC_ORIGIN,
    PRODUCT_ADMIN_TOKEN: ADMIN_TOKEN,
    CHALLENGE_ENABLED: options.challengeEnabled === true ? '1' : '0',
    ...(options.challengeEnabled === true
      ? {
          CHALLENGE_ASSET_ID: CHALLENGE.assetId,
          CHALLENGE_ENTRY_ATOMIC: CHALLENGE.entryAtomic,
          CHALLENGE_PRIZE_ATOMIC: CHALLENGE.prizeAtomic,
          CHALLENGE_SPONSOR_PRINCIPAL_ID: CHALLENGE.sponsorPrincipalId,
        }
      : {}),
  });
  const store = ProductStore.open({ path: ':memory:', migrationsDir: REPO_MIGRATIONS });
  const agents = new AgentCatalog([ACE, BEE]);
  const competitions = new FakeCompetitions();
  const probe: PlatformProbe = {
    health: vi.fn(async () => ({ status: 'ok', timestamp: Date.now() })),
    readiness: vi.fn(async () => ({
      status: options.ready === false ? 'not_ready' : 'ready',
      timestamp: Date.now(),
      checks: [],
      financial: { state: 'READY', reasons: [], checks: [] },
    })),
  };
  const rooms = new ProductRooms({
    store,
    agents,
    competitions,
    platform: probe,
    challenge: options.challengeEnabled === true ? CHALLENGE : null,
  });
  const app = await buildServer({
    config,
    store,
    agents,
    rooms,
    getPrincipal: async (token: string) => {
      const principal = PRINCIPALS[token];
      if (principal === undefined) throw new Error('unknown token');
      return principal;
    },
    agentAvailable: (agentId: string) => agentId === 'ace',
    logger: false,
    staticRoot: null,
  });
  return { app, store, rooms, competitions, agents, config };
}

let current: TestApp | null = null;
afterEach(async () => {
  vi.unstubAllGlobals();
  if (current !== null) {
    await current.app.close();
    current.store.close();
    current = null;
  }
});

async function getApp(options: { challengeEnabled?: boolean; ready?: boolean } = {}): Promise<TestApp> {
  current = await buildTestApp(options);
  return current;
}

const writeHeaders = { origin: PUBLIC_ORIGIN };

describe('product API', () => {
  it('uses the final public SDK lifecycle endpoints with strict empty bodies', async () => {
    const calls: string[] = [];
    await withStubbedFetch((url, init) => {
      calls.push(url.pathname);
      expect(init.headers?.Authorization).toBe('Bearer svc-token');
      expect(init.body).toBe('{}');
      if (url.pathname.endsWith('/start')) return jsonResponse({ success: true, competitionId: 'comp-final', tableId: 'table-final',
        seats: [{ principalId: 'u:alice', seat: 1 }, { principalId: 'svc:ace', seat: 0 }] });
      if (url.pathname.endsWith('/settle')) return jsonResponse({ success: true, competitionId: 'comp-final',
        winnerPrincipalId: 'u:alice', winnerKind: 'WALLET', prizeStatus: 'NOT_APPLICABLE', prize: null,
        placements: [{ principalId: 'u:alice', kind: 'WALLET', placement: 1, prize: null },
          { principalId: 'svc:ace', kind: 'SERVICE', placement: 2, prize: null }] });
      return jsonResponse({ success: true, competitionId: 'comp-final', status: 'CANCELLED', cancelledAt: new Date().toISOString(),
        prizeStatus: 'NOT_APPLICABLE', prize: null, entries: [
          { principalId: 'u:alice', kind: 'WALLET', entryState: 'NOT_REQUIRED', refunded: false, refundJournalId: null },
          { principalId: 'svc:ace', kind: 'SERVICE', entryState: 'NOT_REQUIRED', refunded: false, refundJournalId: null },
        ] });
    }, async () => {
      const client = platformCompetitions('https://poker.example', 'svc-token');
      await client.startCompetition('comp-final', {});
      await client.settleCompetition('comp-final', {});
      await client.cancelCompetition('comp-final');
    });
    expect(calls).toEqual(['/competitions/comp-final/start', '/competitions/comp-final/settle', '/competitions/comp-final/cancel']);
  });

  it('restricts the pre-start recovery cancellation endpoint to product operators', async () => {
    const { app, rooms } = await getApp();
    const room = rooms.create({ name: 'Abandoned', mode: 'SPONSORED', humanCount: 0,
      agentIds: ['ace', 'bee'], finance: null, creator: null, admin: true });
    const url = `/api/rooms/${room.id}/cancel`;
    expect((await app.inject({ method: 'POST', url, headers: writeHeaders })).statusCode).toBe(403);
    const headers = { ...writeHeaders, 'x-product-admin-token': ADMIN_TOKEN };
    const cancelled = await app.inject({ method: 'POST', url, headers });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().room).toMatchObject({ status: 'FAILED', failureReason: 'PLATFORM_CANCELLED' });
    expect((await app.inject({ method: 'POST', url, headers })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/rooms/missing/cancel', headers })).statusCode).toBe(404);
  });

  it('keeps liveness healthy but refuses readiness when PokerTools is live and not ready', async () => {
    const { app } = await getApp({ ready: false });
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    const ready = await app.inject({ method: 'GET', url: '/ready' });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toMatchObject({ ready: false, db: 'ok', platform: { status: 'UNAVAILABLE' } });
  });

  it('serves configuration, agents and health without exposing secrets', async () => {
    const { app } = await getApp();
    const config = await app.inject({ method: 'GET', url: '/api/config' });
    expect(config.statusCode).toBe(200);
    const configBody = config.json();
    expect(configBody.pokerApiUrl).toBe('https://poker.example');
    expect(configBody.platform).toMatchObject({ status: expect.any(String) });
    expect(configBody.platform).toHaveProperty('reason');
    expect(configBody.platform).toHaveProperty('updatedAt');
    expect(configBody.challenge).toEqual({ enabled: false, terms: null });
    expect('assets' in configBody).toBe(false);
    expect(JSON.stringify(configBody)).not.toContain('CHALLENGE_SPONSOR');

    const agents = await app.inject({ method: 'GET', url: '/api/agents' });
    expect(agents.statusCode).toBe(200);
    const agentBody = agents.json();
    expect(agentBody.agents).toEqual([
      { id: 'ace', name: 'Ace', model: 'test-model', provider: 'openai-compatible', available: true },
      { id: 'bee', name: 'Bee', model: 'test-model', provider: 'openai-compatible', available: false },
    ]);
    expect(JSON.stringify(agentBody)).not.toMatch(/keyEnv|tokenEnv|principalId/);

    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: 'ok', timestamp: expect.any(Number) });
    const ready = await app.inject({ method: 'GET', url: '/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({ ready: true, db: 'ok' });
    expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/v1/health' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/ready' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/v1/ready' })).statusCode).toBe(404);
  });

  it('exposes configured challenge terms when paid rooms are enabled', async () => {
    const { app } = await getApp({ challengeEnabled: true });
    const body = (await app.inject({ method: 'GET', url: '/api/config' })).json();
    expect(body.challenge).toEqual({
      enabled: true,
      terms: {
        assetId: CHALLENGE.assetId,
        entryAtomic: CHALLENGE.entryAtomic,
        prizeAtomic: CHALLENGE.prizeAtomic,
        termsVersion: expect.stringMatching(/^[0-9a-f]{16}$/),
      },
    });
    expect('assets' in body).toBe(false);
    expect(JSON.stringify(body)).not.toMatch(/decimals|symbol/);
  });

  it('rejects cross-origin writes and malformed strict bodies', async () => {
    const { app } = await getApp();
    const crossOrigin = await app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: { origin: 'https://evil.example', authorization: 'Bearer alice-token' },
      payload: { name: 'X', mode: 'SPONSORED', humanCount: 2, agentIds: [] },
    });
    expect(crossOrigin.statusCode).toBe(403);
    expect(crossOrigin.json().code).toBe('ORIGIN_FORBIDDEN');

    const unknownField = await app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: { ...writeHeaders, authorization: 'Bearer alice-token' },
      payload: { name: 'X', mode: 'SPONSORED', humanCount: 2, agentIds: [], extra: true },
    });
    expect(unknownField.statusCode).toBe(400);
    expect(unknownField.json().code).toBe('INVALID_REQUEST');

    const badMode = await app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: { ...writeHeaders, authorization: 'Bearer alice-token' },
      payload: { name: 'X', mode: 'CASH', humanCount: 2, agentIds: [] },
    });
    expect(badMode.statusCode).toBe(400);

    const noAuth = await app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: writeHeaders,
      payload: { name: 'X', mode: 'SPONSORED', humanCount: 2, agentIds: [] },
    });
    expect(noAuth.statusCode).toBe(401);
  });

  it('runs the room lifecycle through bearer-resolved identities', async () => {
    const { app, competitions } = await getApp();
    const created = await app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: { ...writeHeaders, authorization: 'Bearer alice-token' },
      payload: { name: 'API Table', mode: 'SPONSORED', humanCount: 2, agentIds: ['ace'] },
    });
    expect(created.statusCode).toBe(200);
    const room = created.json().room;
    expect(room).toMatchObject({
      name: 'API Table',
      mode: 'SPONSORED',
      status: 'WAITING_FOR_ROSTER',
      humanCount: 2,
      agentCount: 1,
      totalSeats: 3,
      pokerTableId: null,
      pokerCompetitionId: null,
    });
    expect(room.participants.map((participant: { pokerPrincipalId: string }) => participant.pokerPrincipalId).sort()).toEqual([
      'svc:ace',
      'u:alice',
    ]);

    const list = await app.inject({ method: 'GET', url: '/api/rooms' });
    expect(list.json().rooms).toHaveLength(1);
    const detail = await app.inject({ method: 'GET', url: `/api/rooms/${room.id}` });
    expect(detail.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/rooms/missing' })).statusCode).toBe(404);

    const joined = await app.inject({
      method: 'POST',
      url: `/api/rooms/${room.id}/join`,
      headers: { ...writeHeaders, authorization: 'Bearer bob-token' },
    });
    expect(joined.statusCode).toBe(200);
    expect(joined.json().room.humanCount).toBe(2);

    const serviceJoin = await app.inject({
      method: 'POST',
      url: `/api/rooms/${room.id}/join`,
      headers: { ...writeHeaders, authorization: 'Bearer service-token' },
    });
    expect(serviceJoin.statusCode).toBe(403);

    const unrelatedStart = await app.inject({
      method: 'POST',
      url: `/api/rooms/${room.id}/start`,
      headers: { ...writeHeaders, authorization: 'Bearer carol-token' },
    });
    expect(unrelatedStart.statusCode).toBe(403);

    const started = await app.inject({
      method: 'POST',
      url: `/api/rooms/${room.id}/start`,
      headers: { ...writeHeaders, authorization: 'Bearer alice-token' },
    });
    expect(started.statusCode).toBe(200);
    expect(started.json().room).toMatchObject({ status: 'ACTIVE' });
    expect(started.json().room.pokerTableId).toMatch(/^table-comp-/);
    expect(started.json().room.pokerCompetitionId).toMatch(/^comp-/);
    expect(competitions.byId.size).toBe(1);

    const stats = await app.inject({ method: 'GET', url: '/api/stats' });
    expect(stats.statusCode).toBe(200);
    expect(stats.json().rooms.running).toBe(1);
  });

  it('lets a member leave before start and blocks leaving active rooms', async () => {
    const { app } = await getApp();
    const created = await app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: { ...writeHeaders, authorization: 'Bearer alice-token' },
      payload: { name: 'Leave', mode: 'SPONSORED', humanCount: 2, agentIds: ['ace'] },
    });
    const roomId = created.json().room.id;
    const left = await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/leave`,
      headers: { ...writeHeaders, authorization: 'Bearer alice-token' },
    });
    expect(left.statusCode).toBe(200);
    expect(left.json().room.participants.map((participant: { agentId: string | null }) => participant.agentId)).toEqual([
      'ace',
    ]);
  });

  it('loads configured agent references from the agent JSON file and persists them durably', () => {
    const directory = mkdtempSync(join(tmpdir(), 'nlhe-agents-'));
    try {
      const path = join(directory, 'agents.json');
      writeFileSync(path, `${JSON.stringify([ACE])}\n`);
      const configs = loadAgentConfigsFile(path);
      expect(configs).toHaveLength(1);
      expect(loadAgentConfigsFile(undefined)).toEqual([]);
      expect(loadAgentConfigsFile(join(directory, 'missing.json'))).toEqual([]);

      const durable = ProductStore.open({ path: ':memory:', migrationsDir: REPO_MIGRATIONS });
      try {
        const catalog = new AgentCatalog();
        syncAgentCatalog(durable, catalog, configs);
        expect(catalog.get('ace')).toMatchObject({ name: 'Ace', principalId: 'svc:ace' });
        expect(durable.listAgentConfigs()).toHaveLength(1);
        expect(durable.getAgentConfig('ace')?.promptPolicyHash).toBe(seatPromptPolicy.hash);
      } finally {
        durable.close();
      }

      writeFileSync(path, JSON.stringify({ agents: [] }));
      expect(() => loadAgentConfigsFile(path)).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('collects explicit configured secrets for log redaction', () => {
    process.env.ACE_KEY = 'ace-provider-secret-value';
    try {
      const catalog = new AgentCatalog([ACE, BEE]);
      const config = loadConfig({ PRODUCT_ADMIN_TOKEN: ADMIN_TOKEN });
      const secrets = configuredSecrets(config, catalog);
      expect(secrets).toContain(ADMIN_TOKEN);
      expect(secrets).toContain('ace-provider-secret-value');
    } finally {
      delete process.env.ACE_KEY;
    }
  });

  it('builds runtime bindings with approved-speech config and preserves a zero spend cap', async () => {
    const { rooms, store } = await getApp();
    const created = rooms.create({
      name: 'Runtime Config',
      mode: 'SPONSORED',
      humanCount: 1,
      agentIds: ['ace'],
      finance: null,
      creator: { principalId: 'u:alice', walletAddress: null },
      admin: false,
    });
    const active = await rooms.start(created.id, { principalId: 'u:alice', admin: false });
    const room = store.getRoom(active.id)!;
    const agent = new AgentCatalog([
      { ...ACE, baseUrl: 'http://127.0.0.1:9/v1' },
    ]).get('ace');

    const chatOn = loadConfig({ AGENT_CHAT_ENABLED: '1' });
    const chatOff = loadConfig({ AGENT_CHAT_ENABLED: '0', MAX_COST_USD_MICRO: '0' });
    const on = buildAgentRuntimeConfig(chatOn, agent, room, ['svc:ace']);
    expect(on.speech).toBe('AFTER_COMMIT');
    expect(on.overallDeadlineAtMs).toBe(room.updatedAt + chatOn.OVERALL_RUNTIME_MS);
    const off = buildAgentRuntimeConfig(chatOff, agent, room, ['svc:ace']);
    expect(off.speech).toBe('OFF');
    expect(off.rooms[0]!.maxCostMicroUsd).toBe(0);
    expect(off.rooms[0]!.maxCalls).toBe(chatOff.MAX_PROVIDER_CALLS);
    expect(off.overallDeadlineAtMs).toBe(room.updatedAt + chatOff.OVERALL_RUNTIME_MS);
  });

  it('composes the runtime from the shared helper with approved speech and the activation deadline', async () => {
    const { rooms, store } = await getApp();
    const created = rooms.create({
      name: 'Composition Regression',
      mode: 'SPONSORED',
      humanCount: 1,
      agentIds: ['ace'],
      finance: null,
      creator: { principalId: 'u:alice', walletAddress: null },
      admin: false,
    });
    const active = await rooms.start(created.id, { principalId: 'u:alice', admin: false });
    const room = store.getRoom(active.id)!;
    const chatConfig = loadConfig({ AGENT_CHAT_ENABLED: '1' });
    process.env.ACE_KEY = 'provider-key';
    try {
      const captured: Array<ReturnType<typeof buildAgentRuntimeConfig>> = [];
      const stopped: boolean[] = [];
      const runtime = new SdkRoomRuntime({
        config: chatConfig,
        store,
        agents: new AgentCatalog([{ ...ACE, baseUrl: 'http://127.0.0.1:9/v1' }]),
        platformUrl: 'http://127.0.0.1:1',
        knownSecrets: [],
        issueCredentials: async () => [{ agentId: 'ace', token: 'issued-token' }],
        log: () => undefined,
        createRuntime: (config) => {
          captured.push(config);
          return {
            start: async () => undefined,
            stop: async () => {
              stopped.push(true);
            },
          };
        },
      });
      await runtime.attach(room);
      expect(captured).toHaveLength(1);
      expect(captured[0]!.speech).toBe('AFTER_COMMIT');
      expect(captured[0]!.providerCallsEnabled).toBe(true);
      expect(captured[0]!.overallDeadlineAtMs).toBe(
        room.updatedAt + chatConfig.OVERALL_RUNTIME_MS,
      );
      expect(runtime.attachedAgentCount(active.id)).toBe(1);
      await runtime.detach(active.id);
      expect(runtime.attachedAgentCount(active.id)).toBe(0);
      expect(stopped).toEqual([true]);
    } finally {
      delete process.env.ACE_KEY;
    }
  });

  it('attaches ACTIVE rooms recorded-only while the provider key is missing', async () => {
    const { rooms, store, config } = await getApp();
    const created = rooms.create({
      name: 'Active No Key',
      mode: 'SPONSORED',
      humanCount: 1,
      agentIds: ['ace'],
      finance: null,
      creator: { principalId: 'u:alice', walletAddress: null },
      admin: false,
    });
    const active = await rooms.start(created.id, { principalId: 'u:alice', admin: false });
    const room = store.getRoom(active.id)!;
    delete process.env.ACE_KEY;
    try {
      const captured: Array<ReturnType<typeof buildAgentRuntimeConfig>> = [];
      const runtime = new SdkRoomRuntime({
        config,
        store,
        agents: new AgentCatalog([{ ...ACE, baseUrl: 'http://127.0.0.1:9/v1' }]),
        platformUrl: 'http://127.0.0.1:1',
        knownSecrets: [],
        issueCredentials: async () => [{ agentId: 'ace', token: 'issued-token' }],
        log: () => undefined,
        createRuntime: (runtimeConfig) => {
          captured.push(runtimeConfig);
          return { start: async () => undefined, stop: async () => undefined };
        },
      });
      await runtime.attach(room);
      expect(captured).toHaveLength(1);
      expect(captured[0]!.providerCallsEnabled).toBe(false);
      // The genuine activation anchor is preserved; no fabricated deadline.
      expect(captured[0]!.overallDeadlineAtMs).toBe(room.updatedAt + config.OVERALL_RUNTIME_MS);
      expect(runtime.attachedAgentCount(active.id)).toBe(1);
      await runtime.detach(active.id);
    } finally {
      delete process.env.ACE_KEY;
    }
  });

  it('recovers terminal recorded receipts with no provider key and no new provider calls', async () => {
    const { rooms, store, competitions, config } = await getApp();
    const created = rooms.create({
      name: 'Terminal Recovery',
      mode: 'SPONSORED',
      humanCount: 1,
      agentIds: ['ace'],
      finance: null,
      creator: { principalId: 'u:alice', walletAddress: null },
      admin: false,
    });
    const active = await rooms.start(created.id, { principalId: 'u:alice', admin: false });
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

    delete process.env.ACE_KEY;
    try {
      const captured: Array<ReturnType<typeof buildAgentRuntimeConfig>> = [];
      const startedHandles: boolean[] = [];
      const stoppedHandles: boolean[] = [];
      const runtime = new SdkRoomRuntime({
        config,
        store,
        agents: new AgentCatalog([{ ...ACE, baseUrl: 'http://127.0.0.1:9/v1' }]),
        platformUrl: 'http://127.0.0.1:1',
        knownSecrets: [],
        issueCredentials: async () => [{ agentId: 'ace', token: 'issued-token' }],
        log: () => undefined,
        createRuntime: (runtimeConfig) => {
          captured.push(runtimeConfig);
          return {
            start: async () => {
              startedHandles.push(true);
            },
            stop: async () => {
              stoppedHandles.push(true);
            },
          };
        },
      });
      await runtime.recoverRecorded(store.getRoom(active.id)!);
      expect(captured).toHaveLength(1);
      expect(captured[0]!.providerCallsEnabled).toBe(false);
      expect(captured[0]!.overallDeadlineAtMs ?? null).toBeNull();
      expect(captured[0]!.overallRuntimeMs ?? null).toBeNull();
      expect(startedHandles).toEqual([true]);
      expect(stoppedHandles).toEqual([true]);
      expect(runtime.attachedAgentCount(active.id)).toBe(0);
    } finally {
      delete process.env.ACE_KEY;
    }
  });

  it('fails closed without a global-token fallback when credential issuance is unavailable', async () => {
    const { rooms, store, agents, config } = await getApp();
    const created = rooms.create({
      name: 'No Fallback',
      mode: 'SPONSORED',
      humanCount: 1,
      agentIds: ['ace'],
      finance: null,
      creator: { principalId: 'u:alice', walletAddress: null },
      admin: false,
    });
    const active = await rooms.start(created.id, { principalId: 'u:alice', admin: false });
    process.env.ACE_KEY = 'provider-key-that-must-not-become-a-platform-token';
    try {
      const issueCredentials = vi.fn(async () => {
        throw new Error('competition:orchestrate capability unavailable');
      });
      const runtime = new SdkRoomRuntime({
        config,
        store,
        agents: new AgentCatalog([{ ...ACE, baseUrl: 'http://127.0.0.1:9/v1' }]),
        platformUrl: 'http://127.0.0.1:1',
        knownSecrets: [],
        issueCredentials,
        log: () => undefined,
      });
      await runtime.attach(store.getRoom(active.id)!);
      expect(issueCredentials).toHaveBeenCalledWith(active.id);
      expect(runtime.attachedAgentCount(active.id)).toBe(0);
      await runtime.stop();
      expect(runtime.attachedAgentCount(active.id)).toBe(0);
      expect(agents.has('ace')).toBe(true);
    } finally {
      delete process.env.ACE_KEY;
    }
  });

  it('requires an authenticated SERVICE orchestration credential for platform availability', async () => {
    const url = 'https://poker.example';
    const seen: Array<{ path: string; auth: string | undefined }> = [];
    await withStubbedFetch(
      (request, init) => {
        seen.push({ path: request.pathname, auth: init.headers?.Authorization });
        if (request.pathname === '/auth/me') return jsonResponse(SERVICE_PRINCIPAL);
        if (request.pathname === '/health') return jsonResponse({ status: 'ok', timestamp: 1 });
        if (request.pathname === '/ready') return jsonResponse(READINESS_PAYLOAD);
        return undefined;
      },
      async () => {
        const probe = createPlatformProbe(url, 'svc-token');
        await expect(probe.health()).resolves.toMatchObject({ status: 'ok' });
        await expect(probe.readiness()).resolves.toMatchObject({
          financial: { state: 'READY' },
        });
      },
    );
    expect(seen[0]).toEqual({ path: '/auth/me', auth: 'Bearer svc-token' });
  });

  it('preserves a public SDK not-ready response even when platform liveness is OK', async () => {
    await withStubbedFetch((request) => {
      if (request.pathname === '/auth/me') return jsonResponse(SERVICE_PRINCIPAL);
      if (request.pathname === '/health') return jsonResponse({ status: 'ok', timestamp: 1 });
      if (request.pathname === '/ready') return jsonResponse({ ...READINESS_PAYLOAD, status: 'not_ready' }, 503);
      return undefined;
    }, async () => {
      const probe = createPlatformProbe('https://poker.example', 'svc-token');
      await expect(probe.health()).resolves.toMatchObject({ status: 'ok' });
      await expect(probe.readiness()).resolves.toMatchObject({ status: 'not_ready' });
    });
  });

  it('rejects WALLET (including ADMIN) credentials and invalid or missing tokens', async () => {
    await withStubbedFetch(
      (request) =>
        request.pathname === '/auth/me' ? jsonResponse(WALLET_PRINCIPAL) : undefined,
      async () => {
        await expect(createPlatformProbe('https://poker.example', 'admin-token').health()).rejects.toThrow(
          /SERVICE/,
        );
      },
    );

    const authHeaders: Array<string | undefined> = [];
    await withStubbedFetch(
      (request, init) => {
        authHeaders.push(init.headers?.Authorization);
        if (request.pathname === '/auth/me') {
          return jsonResponse({ error: 'UNAUTHORIZED' }, 401);
        }
        return undefined;
      },
      async () => {
        await expect(
          createPlatformProbe('https://poker.example', undefined).health(),
        ).rejects.toThrow();
        await expect(
          createPlatformProbe('https://poker.example', 'revoked-token').health(),
        ).rejects.toThrow();
      },
    );
    expect(authHeaders[0]).toBeUndefined();
  });

  it('reports not-ready while keeping read-only browsing when no orchestration credential is configured', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nlhe-no-orchestration-'));
    try {
      await withStubbedFetch(
        (request) =>
          request.pathname === '/auth/me'
            ? jsonResponse({ error: 'UNAUTHORIZED' }, 401)
            : undefined,
        async () => {
          const config = loadConfig({
            DATABASE_PATH: join(directory, 'product.sqlite'),
            PUBLIC_ORIGIN: 'https://nlhe.example',
            POKERTOOLS_API_URL: 'https://poker.example',
            CHALLENGE_ENABLED: '0',
          });
          const app = await buildServer({ config, logger: false, staticRoot: null });
          try {
            expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
            const ready = await app.inject({ method: 'GET', url: '/ready' });
            expect(ready.statusCode).toBe(503);
            expect(ready.json().platform.status).toBe('UNAVAILABLE');
            const browse = await app.inject({ method: 'GET', url: '/api/config' });
            expect(browse.statusCode).toBe(200);
            expect(browse.json().platform.status).toBe('UNAVAILABLE');
            expect((await app.inject({ method: 'GET', url: '/api/agents' })).statusCode).toBe(200);
          } finally {
            await app.close();
          }
        },
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('performs canonical competition operations with a valid SERVICE credential', async () => {
    const seen: Array<{ path: string; auth: string | undefined }> = [];
    const competition = {
      id: 'comp-1',
      name: 'Runtime Table',
      mode: 'NONFINANCIAL',
      status: 'REGISTRATION',
      tableId: 'table-1',
      organizerPrincipalId: 'svc:orchestrator',
      maxEntrants: 2,
      startingStack: 1000,
      smallBlind: 10,
      bigBlind: 20,
      entrants: [
        { principalId: 'u:alice', kind: 'WALLET', seat: 0, entryState: 'NOT_REQUIRED' },
        { principalId: 'svc:ace', kind: 'SERVICE', seat: 1, entryState: 'NOT_REQUIRED' },
      ],
      terms: null,
      prizeStatus: 'NOT_APPLICABLE',
      settlementReady: false,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      cancelledAt: null,
    };
    await withStubbedFetch(
      (request, init) => {
        if (request.pathname !== '/competitions') return undefined;
        seen.push({
          path: request.pathname,
          auth: init.headers?.Authorization,
        });
        return jsonResponse({ success: true, competition, replayed: false });
      },
      async () => {
        const created = await platformCompetitions(
          'https://poker.example',
          'svc-token',
        ).createCompetition({
          name: 'Runtime Table',
          mode: 'NONFINANCIAL',
          entrants: [
            { principalId: 'u:alice', kind: 'WALLET' },
            { principalId: 'svc:ace', kind: 'SERVICE' },
          ],
          idempotencyKey: 'nlhe-room:competition:v1:room-1',
        });
        expect(created.competition.id).toBe('comp-1');
        expect(created.replayed).toBe(false);
      },
    );
    expect(seen[0]!.auth).toBe('Bearer svc-token');
  });

  it('fails closed on runtime start failure and skips recorded recovery without credentials', async () => {
    const { rooms, store, competitions, config } = await getApp();
    const created = rooms.create({
      name: 'Runtime Failure',
      mode: 'SPONSORED',
      humanCount: 1,
      agentIds: ['ace'],
      finance: null,
      creator: { principalId: 'u:alice', walletAddress: null },
      admin: false,
    });
    const active = await rooms.start(created.id, { principalId: 'u:alice', admin: false });
    const room = store.getRoom(active.id)!;
    const agent = new AgentCatalog([{ ...ACE }]).get('ace');
    expect(() =>
      buildAgentRuntimeConfig(config, agent, { ...room, tableId: null }, ['svc:ace']),
    ).toThrow();

    process.env.ACE_KEY = 'provider-key';
    try {
      const failing = new SdkRoomRuntime({
        config,
        store,
        agents: new AgentCatalog([{ ...ACE }]),
        platformUrl: 'http://127.0.0.1:1',
        knownSecrets: [],
        issueCredentials: async () => [{ agentId: 'ace', token: 'issued-token' }],
        log: () => undefined,
        createRuntime: () => ({
          start: async () => {
            throw new Error('runtime refused to start');
          },
          stop: async () => undefined,
        }),
      });
      await failing.attach(room);
      expect(failing.attachedAgentCount(active.id)).toBe(0);
    } finally {
      delete process.env.ACE_KEY;
    }

    const competition = competitions.byId.get(active.pokerCompetitionId!)!;
    competitions.setCompetition(competition.id, {
      status: 'FINISHED',
      finishedAt: new Date().toISOString(),
    });
    expect(await rooms.reconcileRoom(active.id)).toBe('COMPLETED');

    const captured: Array<ReturnType<typeof buildAgentRuntimeConfig>> = [];
    const unavailable = new SdkRoomRuntime({
      config,
      store,
      agents: new AgentCatalog([{ ...ACE }]),
      platformUrl: 'http://127.0.0.1:1',
      knownSecrets: [],
      issueCredentials: async () => {
        throw new Error('competition:orchestrate capability unavailable');
      },
      log: () => undefined,
      createRuntime: (runtimeConfig) => {
        captured.push(runtimeConfig);
        return { start: async () => undefined, stop: async () => undefined };
      },
    });
    await unavailable.recoverRecorded(store.getRoom(active.id)!);
    expect(captured).toHaveLength(0);
  });

  it('fails CHALLENGE creation closed when paid rooms are disabled', async () => {
    const { app } = await getApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: { ...writeHeaders, authorization: 'Bearer alice-token' },
      payload: {
        name: 'Paid',
        mode: 'CHALLENGE',
        humanCount: 1,
        agentIds: ['ace'],
        finance: {
          assetId: CHALLENGE.assetId,
          entryAtomic: CHALLENGE.entryAtomic,
          prizeAtomic: CHALLENGE.prizeAtomic,
          optIn: true,
        },
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe('CHALLENGE_DISABLED');
  });

  it('rejects the removed legacy finance consent fields', async () => {
    const { app } = await getApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: { ...writeHeaders, authorization: 'Bearer alice-token' },
      payload: {
        name: 'Legacy',
        mode: 'CHALLENGE',
        humanCount: 1,
        agentIds: ['ace'],
        finance: {
          assetId: CHALLENGE.assetId,
          acceptEntry: true,
          acceptPrize: true,
          acceptTerms: true,
        },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('INVALID_REQUEST');
  });

  it('guards operator audit with the constant-time admin token and strips provider payloads', async () => {
    const { app, store, rooms } = await getApp();
    const created = await app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: { ...writeHeaders, authorization: 'Bearer alice-token' },
      payload: { name: 'Audit', mode: 'SPONSORED', humanCount: 2, agentIds: ['ace'] },
    });
    const roomId: string = created.json().room.id;
    const decision = store.observeDecision({
      tableId: 'table-1',
      turnId: 'turn-1',
      principalId: 'svc:ace',
      roomId,
      observation: seatObservationFixture(),
      promptPolicyId: seatPromptPolicy.id,
      eventCursor: 1,
    });
    const started = store.startAttempt(decision.id, JSON.stringify({ secret: 'request-body' }));
    expect(started.kind).toBe('started');
    if (started.kind === 'started') {
      store.recordAttemptResponse(decision.id, started.attempt.id, {
        status: 'SUCCEEDED',
        responseJson: JSON.stringify({ secret: 'provider-response' }),
        model: 'test-model',
        provider: 'openai-compatible',
        promptPolicyId: seatPromptPolicy.id,
        usage: { promptTokens: 3, completionTokens: 4, costMicroUsd: 5, latencyMs: 6 },
      });
    }

    const denied = await app.inject({ method: 'GET', url: `/api/audit/rooms/${roomId}` });
    expect(denied.statusCode).toBe(403);
    const wrong = await app.inject({
      method: 'GET',
      url: `/api/audit/rooms/${roomId}`,
      headers: { 'x-product-admin-token': 'wrong-token' },
    });
    expect(wrong.statusCode).toBe(403);

    const allowed = await app.inject({
      method: 'GET',
      url: `/api/audit/rooms/${roomId}`,
      headers: { 'x-product-admin-token': ADMIN_TOKEN },
    });
    expect(allowed.statusCode).toBe(200);
    const audit = allowed.json();
    expect(audit.decisions).toHaveLength(1);
    expect(audit.decisions[0]).toMatchObject({
      principalId: 'svc:ace',
      agentId: 'ace',
      model: 'test-model',
      attempts: [
        { attemptNo: 1, promptTokens: 3, completionTokens: 4, costMicroUsd: 5, latencyMs: 6 },
      ],
    });
    expect(JSON.stringify(audit)).not.toContain('secret');
    expect(rooms.auditRoom(roomId).decisions[0]!.attempts).toHaveLength(1);
  });
});
