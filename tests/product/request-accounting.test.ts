/**
 * Deterministic simulated request accounting.
 *
 * This is deliberately NOT platform integration. It counts the HTTP-shaped
 * requests the product would make through in-process doubles:
 *
 * - `AgentTurnTransport` is implemented by a counting transport whose
 *   `fetchObservation` / `fetchChat` / `sendChat` / `submitAction` calls map to
 *   the product's platform REST paths (`observation`, `chat`, `action`);
 * - `PlatformCompetitions` / `PlatformProbe` are in-process doubles that count
 *   competition lifecycle and readiness calls made by `ProductRooms`;
 * - the real product decision-provider pipeline runs against an injected
 *   `fetchImpl` that returns the existing deterministic `toolCallResponse`
 *   fixture at zero price, so no paid provider and no network are involved.
 *
 * Socket deliveries are not HTTP and are not counted against the platform
 * budget. The counter enforces the platform's general per-principal limit
 * (`RATE_LIMIT_MAX = 100`, rolling 1 minute; pokertools
 * packages/api/src/app.ts + config.ts) over a trailing 60s window and reports
 * simulated 429s.
 *
 * Shapes: 1H1A (1 human + 1 agent), 10A (agent-only, 10 agents) and 1H9A
 * (1 human + 9 agents). Each simulated minute is healthy WS: every agent that
 * has not acted receives heartbeat observations between turns and one turn
 * each, so the only REST observation reads are the one startup read per agent.
 */
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CanonicalActionResultSchema,
  type CanonicalActionRequest,
  type CanonicalActionResult,
  type CancelCompetitionResponse,
  type Competition,
  type CreateCompetitionRequest,
  type CreateCompetitionResponse,
  type IssueAgentCredentialRequest,
  type IssuedAgentCredential,
  type SeatObservation,
  type SettleCompetitionRequest,
  type SettleCompetitionResponse,
  type StartCompetitionRequest,
  type StartCompetitionResponse,
} from '@pokertools/types';
import {
  AgentRuntime,
  createProductDecisionProviderFactory,
  type AgentTurnTransport,
} from '../../src/agents/index.js';
import { seatPromptPolicy } from '../../src/llm/prompt-policy.js';
import { AgentCatalog, type AgentConfigInput } from '../../src/product/catalog.js';
import {
  ProductRooms,
  type PlatformCompetitions,
  type PlatformProbe,
} from '../../src/product/rooms.js';
import { ProductStore } from '../../src/product/store.js';
import { observationFixture, seatObservationFixture, validActionArguments } from './fixtures.js';
import { toolCallResponse } from './fake-provider.js';

const MIGRATIONS = resolve(process.cwd(), 'migrations');
const ORCHESTRATOR = 'service:orchestrator';
/** Platform general rate limit: `RATE_LIMIT_MAX` requests per rolling minute. */
const RATE_LIMIT_MAX = 100;
const RATE_LIMIT_WINDOW_MS = 60_000;

type RequestCategory = 'observation' | 'chat' | 'action' | 'competition' | 'other';

interface RequestEvent {
  at: number;
  category: RequestCategory;
  principal: string;
}

/** Rolling-window platform budget meter; every counter is simulated. */
class RequestCounter {
  readonly totals: Record<RequestCategory, number> = {
    observation: 0,
    chat: 0,
    action: 0,
    competition: 0,
    other: 0,
  };
  readonly events: RequestEvent[] = [];
  /** Simulated HTTP 429s: requests over the assumed platform budget. */
  rejected = 0;

  record(category: RequestCategory, principal: string, at: number): void {
    this.totals[category] += 1;
    this.events.push({ at, category, principal });
    if (this.rolling(principal, at) > RATE_LIMIT_MAX) this.rejected += 1;
  }

  rolling(principal: string, at: number): number {
    return this.events.filter(
      (event) =>
        event.principal === principal &&
        event.at <= at &&
        event.at > at - RATE_LIMIT_WINDOW_MS,
    ).length;
  }

  /** Maximum trailing-60s count observed for one principal. */
  maxRolling(principal: string): number {
    let max = 0;
    for (const event of this.events) {
      if (event.principal !== principal) continue;
      max = Math.max(max, this.rolling(principal, event.at));
    }
    return max;
  }

  totalsFor(principalPrefix: string): Record<RequestCategory, number> {
    const totals: Record<RequestCategory, number> = {
      observation: 0,
      chat: 0,
      action: 0,
      competition: 0,
      other: 0,
    };
    for (const event of this.events) {
      if (!event.principal.startsWith(principalPrefix)) continue;
      totals[event.category] += 1;
    }
    return totals;
  }
}

function actionReceipt(request: CanonicalActionRequest, tableId: string): CanonicalActionResult {
  const base = observationFixture();
  const version = base.version + 1;
  return CanonicalActionResultSchema.parse({
    receipt: {
      requestId: request.requestId,
      tableId,
      handId: base.handId,
      turnId: request.turnId,
      actionId: request.actionId,
      version,
      eventSeq: base.eventSeq,
      acceptedAt: 1_700_000_000_001,
    },
    observation: {
      ...base,
      tableId,
      turnId: request.turnId,
      version,
      state: { ...base.state, version },
    },
  });
}

/**
 * Counting `AgentTurnTransport`. Every platform-shaped REST method records its
 * request category; SDK-level retries are not simulated, so each product call
 * maps to exactly one simulated HTTP request.
 */
class AccountingTransport implements AgentTurnTransport {
  principalId: string;
  fetchObservationCalls = 0;
  fetchChatCalls = 0;
  actionCalls = 0;
  private readonly current: SeatObservation;
  private readonly listeners = new Map<string, Set<(observation: SeatObservation) => void>>();
  private readonly recoveryListeners = new Set<() => void>();

  constructor(
    private readonly counter: RequestCounter,
    private readonly principal: string,
    private readonly tableId: string,
    initial: SeatObservation,
    private readonly now: () => number,
  ) {
    this.principalId = principal;
    this.current = initial;
  }

  async connect(): Promise<void> {}

  close(): void {}

  async fetchObservation(_tableId: string): Promise<SeatObservation> {
    this.fetchObservationCalls += 1;
    this.counter.record('observation', this.principal, this.now());
    return this.current;
  }

  async submitAction(
    _tableId: string,
    request: CanonicalActionRequest,
  ): Promise<CanonicalActionResult> {
    this.actionCalls += 1;
    this.counter.record('action', this.principal, this.now());
    return actionReceipt(request, this.tableId);
  }

  async fetchChat(): Promise<readonly unknown[]> {
    this.fetchChatCalls += 1;
    this.counter.record('chat', this.principal, this.now());
    return [];
  }

  async sendChat(): Promise<{ messageId: string }> {
    // Speech is OFF in these simulations; kept for contract completeness.
    this.counter.record('chat', this.principal, this.now());
    return { messageId: 'msg-simulated' };
  }

  onObservation(tableId: string, listener: (observation: SeatObservation) => void): () => void {
    let listeners = this.listeners.get(tableId);
    if (listeners === undefined) {
      listeners = new Set();
      this.listeners.set(tableId, listeners);
    }
    listeners.add(listener);
    // Authenticated join snapshot: delivered over the socket, no REST.
    listener(this.current);
    return () => listeners.delete(listener);
  }

  onRecovery(listener: () => void): () => void {
    this.recoveryListeners.add(listener);
    return () => this.recoveryListeners.delete(listener);
  }

  /** Socket delivery; never counted as HTTP. */
  deliver(observation: SeatObservation): void {
    for (const listener of this.listeners.get(this.tableId) ?? []) listener(observation);
  }
}

class AccountingCompetitions implements PlatformCompetitions {
  private readonly byId = new Map<string, Competition>();
  private sequence = 0;

  constructor(
    private readonly counter: RequestCounter,
    private readonly now: () => number,
  ) {}

  private record(): void {
    this.counter.record('competition', ORCHESTRATOR, this.now());
  }

  async createCompetition(request: CreateCompetitionRequest): Promise<CreateCompetitionResponse> {
    this.record();
    const id = `comp-sim-${++this.sequence}`;
    const competition: Competition = {
      id,
      name: request.name,
      mode: request.mode,
      status: 'REGISTRATION',
      tableId: `table-${id}`,
      organizerPrincipalId: ORCHESTRATOR,
      maxEntrants: request.entrants.length,
      startingStack: request.startingStack ?? 1000,
      smallBlind: request.smallBlind ?? 10,
      bigBlind: request.bigBlind ?? 20,
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
    this.byId.set(id, competition);
    return { success: true, competition, replayed: false };
  }

  async getCompetition(competitionId: string): Promise<Competition> {
    this.record();
    const competition = this.byId.get(competitionId);
    if (competition === undefined) throw new Error('competition not found');
    return competition;
  }

  async startCompetition(
    competitionId: string,
    _request: StartCompetitionRequest,
  ): Promise<StartCompetitionResponse> {
    this.record();
    const competition = this.byId.get(competitionId);
    if (competition === undefined) throw new Error('competition not found');
    this.byId.set(competitionId, {
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
    _competitionId: string,
    _request: SettleCompetitionRequest,
  ): Promise<SettleCompetitionResponse> {
    throw new Error('settlement is not simulated');
  }

  async cancelCompetition(_competitionId: string): Promise<CancelCompetitionResponse> {
    throw new Error('cancellation is not simulated');
  }

  async issueAgentCredential(
    competitionId: string,
    request: IssueAgentCredentialRequest,
  ): Promise<IssuedAgentCredential> {
    this.record();
    const competition = this.byId.get(competitionId);
    if (competition === undefined) throw new Error('competition not found');
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

class AccountingProbe implements PlatformProbe {
  constructor(
    private readonly counter: RequestCounter,
    private readonly now: () => number,
  ) {}

  async health(): Promise<unknown> {
    return { status: 'ok', timestamp: this.now() };
  }

  async readiness(): Promise<unknown> {
    this.counter.record('other', ORCHESTRATOR, this.now());
    return {
      status: 'ready',
      timestamp: this.now(),
      checks: [],
      financial: { state: 'READY', reasons: [], checks: [] },
    };
  }
}

interface ShapeSpec {
  label: string;
  humans: number;
  agentCount: number;
}

interface ShapeTotals {
  observation: number;
  chat: number;
  action: number;
  competition: number;
  other: number;
  provider: number;
  rejected: number;
  startupObservationReads: number;
  /** Accepted WS frames whose version skipped intermediate projections. */
  healthyVersionJumps: number;
}

interface AgentStream {
  principal: string;
  transport: AccountingTransport;
  version: number;
  eventSeq: number;
}

interface ShapeRun {
  shape: ShapeSpec;
  roomId: string;
  tableId: string;
  harnesses: AgentStream[];
  providerBefore: number;
  providerAfter: number;
  competitionBefore: number;
  competitionAfterProvision: number;
  otherBefore: number;
  otherAfter: number;
  /** Healthy version jumps (>1) accepted during the WS minute. */
  versionJumps: number;
}

interface AccountingResult {
  counter: RequestCounter;
  perShape: Map<string, ShapeTotals>;
  maxRollingByPrincipal: Map<string, number>;
}

function agentInputs(shape: ShapeSpec): AgentConfigInput[] {
  return Array.from({ length: shape.agentCount }, (_, index) => ({
    id: `${shape.label}:agent-${index}`,
    name: `${shape.label} Agent ${index}`,
    model: 'accounting-model',
    provider: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:9/v1',
    keyEnv: 'ACCOUNTING_SIM_KEY',
    principalId: `svc:${shape.label}:agent-${index}`,
    promptPolicyId: seatPromptPolicy.id,
    promptPolicyHash: seatPromptPolicy.hash,
    pricing: { inputMicroUsdPerMillionTokens: 0, outputMicroUsdPerMillionTokens: 0 },
    limits: { maxCallsPerRoom: 100, maxCostMicroUsdPerRoom: 0, maxCostMicroUsdPerCall: 0 },
    enabled: true,
  }));
}

function shapeOfAgent(shape: ShapeSpec, index: number): string {
  return `svc:${shape.label}:agent-${index}`;
}

/**
 * Drain the in-process decision pipeline without depending on event-loop
 * scheduling. The simulated transport and provider resolve in-process and the
 * product store is synchronous SQLite, so progress is microtask-only; a
 * `setTimeout(0)` yield here would stretch under parallel CI/Docker load and
 * inflate the test's wall time without changing any assertion.
 */
async function drainMicrotasks(turns = 200): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
}

/**
 * Wait until `expected` decisions for one room are durably committed. The
 * bounded attempt count is a structural guard, not a wall-clock budget; the
 * macrotask safety valve only exists for a hypothetical stream-internal turn
 * (the in-process fake response body is read without real I/O).
 */
async function settleCommittedDecisions(
  store: ProductStore,
  roomId: string,
  expected: number,
): Promise<number> {
  let committed = 0;
  for (let attempt = 0; attempt < 500; attempt += 1) {
    committed = store.listDecisions({ roomId, status: 'COMMITTED' }).length;
    if (committed >= expected) return committed;
    await drainMicrotasks();
    if (attempt % 20 === 19) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  return committed;
}

/**
 * Run every shape in one shared product store over a single simulated minute.
 * `activeCadence` additionally models the 30s ACTIVE reconciliation cadence at
 * exactly +30s and +60s, which requires the caller to have faked `Date`.
 */
async function runVirtualMinute(
  shapes: readonly ShapeSpec[],
  options: { activeCadence?: boolean } = {},
): Promise<AccountingResult> {
  const store = ProductStore.open({ path: ':memory:', migrationsDir: MIGRATIONS });
  const startedAt = Date.now();
  const counter = new RequestCounter();
  const perShape = new Map<string, ShapeTotals>();
  const maxRollingByPrincipal = new Map<string, number>();
  let providerCalls = 0;
  const providerFactory = createProductDecisionProviderFactory({
    baseUrl: 'https://provider.simulated.invalid/v1',
    model: 'accounting-model',
    apiKey: 'simulated-not-a-real-key',
    inputUsdMicroPerMillionTokens: 0,
    outputUsdMicroPerMillionTokens: 0,
    includeEnvSecrets: false,
    fetchImpl: async () => {
      providerCalls += 1;
      return new Response(toolCallResponse(validActionArguments()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const runtimes: AgentRuntime[] = [];
  const runs: ShapeRun[] = [];
  try {
    const catalog = new AgentCatalog(shapes.flatMap((shape) => agentInputs(shape)));
    for (const config of catalog.list()) store.upsertAgentConfig(config);
    const competitions = new AccountingCompetitions(counter, () => Date.now());
    const probe = new AccountingProbe(counter, () => Date.now());
    const rooms = new ProductRooms({
      store,
      agents: catalog,
      competitions,
      platform: probe,
      challenge: null,
    });

    // Provision every shape first so a combined run covers one shared window.
    for (const shape of shapes) {
      const configs = agentInputs(shape);
      const agentIds = configs.map((config) => config.id);
      const creatorPrincipal = `u:${shape.label}:human`;
      const competitionBefore = counter.totals.competition;
      const otherBefore = counter.totals.other;
      const created = rooms.create(
        shape.humans === 0
          ? {
              name: shape.label,
              mode: 'SPONSORED',
              humanCount: 0,
              agentIds,
              finance: null,
              creator: null,
              admin: true,
            }
          : {
              name: shape.label,
              mode: 'SPONSORED',
              humanCount: shape.humans,
              agentIds,
              finance: null,
              creator: { principalId: creatorPrincipal, walletAddress: `0x${shape.label}` },
              admin: false,
            },
      );
      const room = await rooms.start(
        created.id,
        shape.humans === 0
          ? { principalId: null, admin: true }
          : { principalId: creatorPrincipal, admin: false },
      );
      expect(room.status).toBe('ACTIVE');
      const tableId = room.pokerTableId!;
      const credentials = await rooms.issueAgentCredentials(created.id);
      expect(credentials).toHaveLength(shape.agentCount);

      const harnesses: AgentStream[] = [];
      for (let index = 0; index < shape.agentCount; index += 1) {
        const principal = shapeOfAgent(shape, index);
        const transport = new AccountingTransport(
          counter,
          principal,
          tableId,
          seatObservationFixture({ tableId, legalActions: [] }),
          () => Date.now(),
        );
        const runtime = new AgentRuntime(
          {
            agentId: agentIds[index]!,
            principalId: principal,
            promptPolicyId: seatPromptPolicy.id,
            promptPolicyHash: seatPromptPolicy.hash,
            rooms: [{ roomId: created.id, tableId, agentPrincipalIds: [principal] }],
            perCallTimeoutMs: 5_000,
            chatSelection: { maxMessages: 5 },
          },
          {
            transport,
            store,
            providerFactory,
            audit: () => {},
          },
        );
        await runtime.start();
        runtimes.push(runtime);
        harnesses.push({ principal, transport, version: 4, eventSeq: 10 });
      }
      runs.push({
        shape,
        roomId: created.id,
        tableId,
        harnesses,
        // Provider attribution is captured per WS window below.
        providerBefore: 0,
        providerAfter: 0,
        competitionBefore,
        competitionAfterProvision: counter.totals.competition,
        otherBefore,
        otherAfter: counter.totals.other,
        versionJumps: 0,
      });
    }

    // One healthy-WS minute per shape: heartbeats between turns, one turn per
    // agent. The actor's turn deliberately skips intermediate state versions:
    // the published SocketManager drains the latest full DB projection and the
    // SDK cache only rejects monotonic regressions, so a large version jump is
    // healthy and must not trigger any REST recovery read.
    for (const run of runs) {
      // Per-run provider baseline: each run owns its own window (important
      // when two rooms share one virtual minute).
      const providerBefore = providerCalls;
      const acted = new Set<string>();
      for (let tick = 0; tick < run.shape.agentCount; tick += 1) {
        for (const harness of run.harnesses) {
          if (acted.has(harness.principal)) continue;
          if (harness.principal === run.harnesses[tick]!.principal) {
            const jumpedVersion = harness.version + 10;
            harness.transport.deliver(
              seatObservationFixture({
                tableId: run.tableId,
                turnId: `turn-${tick + 1}`,
                version: jumpedVersion,
                eventSeq: harness.eventSeq + 100,
              }),
            );
            harness.version = jumpedVersion;
            run.versionJumps += 1;
            acted.add(harness.principal);
          } else {
            harness.eventSeq += 1;
            harness.transport.deliver(
              seatObservationFixture({
                tableId: run.tableId,
                version: 4,
                eventSeq: harness.eventSeq,
                legalActions: [],
              }),
            );
          }
        }
        await drainMicrotasks();
      }

      // Wait for this run's decisions before the next run starts delivering,
      // so provider attribution stays per shape.
      const committed = await settleCommittedDecisions(
        store,
        run.roomId,
        run.shape.agentCount,
      );
      expect(committed).toBe(run.shape.agentCount);
      run.providerBefore = providerBefore;
      run.providerAfter = providerCalls;
    }

    if (options.activeCadence === true) {
      // ACTIVE cadence: one lifecycle read per room at +30s and one at +60s.
      for (const offset of [30_000, 60_000]) {
        vi.setSystemTime(startedAt + offset);
        const pass = await rooms.reconcileAll();
        expect(pass.PENDING).toBe(shapes.length);
      }
    }

    for (const run of runs) {
      const agentTotals = counter.totalsFor(`svc:${run.shape.label}:`);
      perShape.set(run.shape.label, {
        ...agentTotals,
        // Competition and readiness traffic belongs to the orchestrator
        // principal, so it is attributed by provisioning delta.
        competition:
          run.competitionAfterProvision -
          run.competitionBefore +
          (options.activeCadence === true ? 2 : 0),
        other: run.otherAfter - run.otherBefore,
        provider: run.providerAfter - run.providerBefore,
        rejected: counter.rejected,
        startupObservationReads: run.harnesses.reduce(
          (sum, harness) => sum + harness.transport.fetchObservationCalls,
          0,
        ),
        healthyVersionJumps: run.versionJumps,
      });
      for (let index = 0; index < run.shape.agentCount; index += 1) {
        const principal = shapeOfAgent(run.shape, index);
        maxRollingByPrincipal.set(principal, counter.maxRolling(principal));
      }
    }
    maxRollingByPrincipal.set(ORCHESTRATOR, counter.maxRolling(ORCHESTRATOR));
  } finally {
    await Promise.all(runtimes.map((runtime) => runtime.stop()));
    store.close();
  }
  return { counter, perShape, maxRollingByPrincipal };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('simulated request accounting (deterministic, no paid provider)', () => {
  it('accounts 1H1A, 10A and 1H9A over one virtual minute each', async () => {
    const total: Record<RequestCategory, number> = {
      observation: 0,
      chat: 0,
      action: 0,
      competition: 0,
      other: 0,
    };
    let healthyVersionJumps = 0;
    for (const shape of [
      { label: '1H1A', humans: 1, agentCount: 1 },
      { label: '10A', humans: 0, agentCount: 10 },
      { label: '1H9A', humans: 1, agentCount: 9 },
    ] as const) {
      const result = await runVirtualMinute([shape]);
      const totals = result.perShape.get(shape.label)!;
      // The join snapshot is delivered over the socket immediately, so there is
      // no REST observation read at all; the turn and heartbeat frames follow
      // the same direct path.
      expect(totals.observation).toBe(0);
      expect(totals.startupObservationReads).toBe(0);
      // Every agent turn carried a healthy version jump and still consumed
      // exactly, with zero REST recovery.
      expect(totals.healthyVersionJumps).toBe(shape.agentCount);
      // One chat fetch and one action submit per committed decision.
      expect(totals.chat).toBe(shape.agentCount);
      expect(totals.action).toBe(shape.agentCount);
      expect(totals.provider).toBe(shape.agentCount);
      // One create + one start + one credential per agent; readiness is read
      // once when entering provisioning and once resuming it.
      expect(totals.competition).toBe(shape.agentCount + 2);
      expect(totals.other).toBe(2);
      expect(totals.rejected).toBe(0);
      for (const rolling of result.maxRollingByPrincipal.values()) {
        expect(rolling).toBeLessThanOrEqual(RATE_LIMIT_MAX);
      }
      healthyVersionJumps += totals.healthyVersionJumps;
      for (const category of Object.keys(total) as RequestCategory[]) {
        total[category] += totals[category];
      }
    }
    expect(healthyVersionJumps).toBe(20);
    expect(total.observation).toBe(0);
    expect(total.chat).toBe(20);
    expect(total.action).toBe(20);
    expect(total.competition).toBe(20 + 3 * 2);
    expect(total.other).toBe(6);
  });

  it('accounts two mixed rooms (1H1A + 1H9A) in one rolling minute with active cadence', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const result = await runVirtualMinute(
        [
          { label: 'roomA:1H1A', humans: 1, agentCount: 1 },
          { label: 'roomB:1H9A', humans: 1, agentCount: 9 },
        ],
        { activeCadence: true },
      );
      const roomA = result.perShape.get('roomA:1H1A')!;
      const roomB = result.perShape.get('roomB:1H9A')!;
      // Direct WS observations on both tables: no REST observation read.
      expect(roomA.observation).toBe(0);
      expect(roomB.observation).toBe(0);
      expect(roomA.startupObservationReads).toBe(0);
      expect(roomB.startupObservationReads).toBe(0);
      // Every agent turn skipped intermediate state versions and still made
      // zero REST recovery reads on both tables.
      expect(roomA.healthyVersionJumps + roomB.healthyVersionJumps).toBe(10);
      // One decision each.
      expect(roomA.chat + roomB.chat).toBe(10);
      expect(roomA.action + roomB.action).toBe(10);
      expect(roomA.provider + roomB.provider).toBe(10);
      // 1 create + 1 start + N credentials + 2 cadence reads per room.
      expect(roomA.competition).toBe(1 + 1 + 1 + 2);
      expect(roomB.competition).toBe(1 + 1 + 9 + 2);
      expect(roomB.other).toBe(2);
      expect(result.counter.rejected).toBe(0);
      for (const rolling of result.maxRollingByPrincipal.values()) {
        expect(rolling).toBeLessThanOrEqual(RATE_LIMIT_MAX);
      }
      // The orchestrator's trailing-60s maximum is the busiest principal.
      const orchestratorMax = result.maxRollingByPrincipal.get(ORCHESTRATOR)!;
      expect(orchestratorMax).toBeGreaterThan(0);
      expect(orchestratorMax).toBeLessThanOrEqual(RATE_LIMIT_MAX);
    } finally {
      vi.useRealTimers();
    }
  });
});
