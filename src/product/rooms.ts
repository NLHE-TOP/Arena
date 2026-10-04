/**
 * Product room orchestration.
 *
 * `ProductRooms` is the only module that turns a product room request into
 * durable product state and platform competition operations. It owns no poker
 * truth and no money:
 *
 * - The product `ProductStore` owns rooms, the desired-roster policy snapshot,
 *   participant principal references and the immutable derived result
 *   projection. No seats, hands or financial settlement are stored there.
 * - The platform competition API owns roster admission, authoritative seats,
 *   entry settlement and placements. The product stores only opaque platform
 *   references (`tableId`, competition id) and derived placements.
 *
 * Platform access travels through the narrow `PlatformCompetitions` /
 * `PlatformProbe` interfaces below. They mirror the public canonical contracts
 * in `@pokertools/types`; `src/main.ts` adapts the public SDK to them, so this
 * module never reaches into platform internals or performs ad-hoc HTTP.
 *
 * Invariants:
 * - The policy snapshot captured at creation represents the DESIRED roster
 *   (unclaimed human seats are descriptors without a principal and never
 *   become participant rows). Only durable participant rows are reported.
 * - Agent references are resolved from the durable agent catalog only for
 *   rooms that name agents. Human-only rooms require no provider credentials.
 * - CHALLENGE terms always come from startup configuration (`src/config.ts`):
 *   creation carries an exact consent-only finance body, the paying wallet
 *   opts in directly through the public SDK, and the product only reads the
 *   authoritative platform entry state. A caller can never choose an asset,
 *   entry or prize, and no paid flag is fabricated locally.
 * - Provisioning uses a stable `idempotencyKey` per room, so recovering a
 *   PROVISIONING room replays the same platform competition instead of
 *   creating a duplicate.
 * - Completion is derived exclusively from the platform competition
 *   settle/placements projection. Local poker state is never reconstructed,
 *   and no prize/P&L value is persisted.
 */
import { createHash, randomUUID } from 'node:crypto';

import {
  CompetitionSchema,
  CancelCompetitionResponseSchema,
  CreateCompetitionResponseSchema,
  SettleCompetitionResponseSchema,
  StartCompetitionResponseSchema,
  type Competition,
  type CancelCompetitionResponse,
  type CompetitionEntrantSpec,
  type CompetitionSeatAssignment,
  type CreateCompetitionRequest,
  type CreateCompetitionResponse,
  type IssueAgentCredentialRequest,
  type IssuedAgentCredential,
  type SettleCompetitionRequest,
  type SettleCompetitionResponse,
  type StartCompetitionRequest,
  type StartCompetitionResponse,
} from '@pokertools/types';

import { PolicyViolationError, type ProductPolicy } from './policy.js';
import type { AgentCatalog, AgentConfig } from './catalog.js';
import {
  ProductStoreError,
  type ProductParticipant,
  type ProductRoom,
  type ProductStore,
  type RoomResultPlacement,
  type RoomStatus,
} from './store.js';
import {
  productStatistics,
  type ModelMetric,
  type ProductOutcome,
} from './statistics.js';

/** Product room modes. */
export type RoomMode = 'SPONSORED' | 'CHALLENGE';

/**
 * Narrow platform competition surface. Every method maps one-to-one to the
 * public SDK `CompetitionClient` / canonical competition contract; the client
 * carries the `competition:orchestrate` credential.
 *
 * Entry opt-in is deliberately absent: the paying wallet opts in directly
 * through the public SDK, and the product only reads the resulting
 * authoritative entry state from the competition projection.
 */
export interface PlatformCompetitions {
  createCompetition(request: CreateCompetitionRequest): Promise<CreateCompetitionResponse>;
  /** Returns the privacy-preserving competition projection (unwrapped). */
  getCompetition(competitionId: string): Promise<Competition>;
  startCompetition(
    competitionId: string,
    request: StartCompetitionRequest,
  ): Promise<StartCompetitionResponse>;
  settleCompetition(
    competitionId: string,
    request: SettleCompetitionRequest,
  ): Promise<SettleCompetitionResponse>;
  cancelCompetition(competitionId: string): Promise<CancelCompetitionResponse>;
  /** Table-scoped agent credential issue/rotation (orchestration only). */
  issueAgentCredential(
    competitionId: string,
    request: IssueAgentCredentialRequest,
  ): Promise<IssuedAgentCredential>;
}

/** Platform liveness/readiness probe (never a duplicated custody check). */
export interface PlatformProbe {
  health(): Promise<unknown>;
  readiness(): Promise<unknown>;
}

/**
 * Agent runtime attachment seam. The decision runtime (`src/agents`) is wired
 * by the composition root; rooms only hand it activated platform references.
 * `detach` (when provided) is called when a room reaches a terminal state so
 * the runtime stops and drops its in-memory credentials.
 */
export interface RoomRuntime {
  attach(room: ProductRoom): Promise<void>;
  detach?(roomId: string): Promise<void> | void;
  /**
   * Bounded recorded-only recovery for terminal rooms: resolve pending
   * PROVIDER_RECORDED/ACTION_SUBMITTED traces with new provider HTTP
   * disabled, then stop and drop the temporary credential.
   */
  recoverRecorded?(room: ProductRoom): Promise<void>;
}

/** Server-configured CHALLENGE terms (from `src/config.ts`). */
export interface ChallengeTermsConfig {
  readonly assetId: string;
  readonly entryAtomic: string;
  readonly prizeAtomic: string;
  readonly sponsorPrincipalId: string;
}

/** Stable failure codes for product room operations. */
export type ProductRoomErrorCode =
  | 'INVALID_REQUEST'
  | 'CHALLENGE_DISABLED'
  | 'TERMS_MISMATCH'
  | 'NOT_AUTHORIZED'
  | 'ROOM_NOT_FOUND'
  | 'ROOM_STATE'
  | 'ROOM_FULL'
  | 'ROSTER_INCOMPLETE'
  | 'AGENT_NOT_AVAILABLE'
  | 'PLATFORM_UNAVAILABLE'
  | 'PLATFORM_REJECTED';

export class ProductRoomError extends Error {
  readonly code: ProductRoomErrorCode;

  constructor(code: ProductRoomErrorCode, message: string) {
    super(message);
    this.name = 'ProductRoomError';
    this.code = code;
  }
}

/** Resolved human identity for a product action. */
export interface HumanActor {
  readonly principalId: string;
  readonly walletAddress: string | null;
}

/** Caller context for create/start. */
export interface RoomActor {
  readonly principalId: string | null;
  /** Product admin authority verified by the HTTP layer. */
  readonly admin: boolean;
}

/** `POST /api/rooms` input after HTTP validation. */
export interface CreateRoomCommand {
  readonly name: string;
  readonly mode: RoomMode;
  readonly humanCount: number;
  readonly agentIds: readonly string[];
  /**
   * Final CHALLENGE consent body. `optIn: true` is a consent assertion only:
   * it never marks anything paid locally, and every amount/asset must equal
   * the server-configured terms exactly.
   */
  readonly finance: {
    readonly assetId: string;
    readonly entryAtomic: string;
    readonly prizeAtomic: string;
    readonly optIn: true;
  } | null;
  readonly creator: HumanActor | null;
  readonly admin: boolean;
}

export interface ProductRoomsOptions {
  readonly store: ProductStore;
  readonly agents: AgentCatalog;
  readonly competitions: PlatformCompetitions;
  readonly platform: PlatformProbe;
  /** Paid CHALLENGE terms; `null` disables paid rooms entirely. */
  readonly challenge: ChallengeTermsConfig | null;
  /** Optional runtime attachment seam (wired by the composition root). */
  readonly runtime?: RoomRuntime;
  /**
   * Whether an agent has usable provider credentials. Defaults to the catalog
   * `enabled` flag; the composition root supplies the environment check.
   */
  readonly agentAvailable?: (agentId: string) => boolean;
  /** Structured operational logging; never receives secrets. */
  readonly log?: (event: { event: string; detail?: string }) => void;
}

/** One joined room participant as exposed to the product API. */
export interface RoomParticipantView {
  readonly id: string;
  readonly kind: 'HUMAN' | 'AGENT';
  readonly name: string;
  /** Wallet address when known; product persistence never stores it. */
  readonly address: string | null;
  readonly agentId: string | null;
  readonly agentModel: string | null;
  /** Durable PokerTools principal id. */
  readonly pokerPrincipalId: string;
  /** Authoritative platform seat when assigned; never authorization. */
  readonly seat: number | null;
  readonly joinedAt: number;
}

export interface RoomFinanceView {
  readonly assetId: string;
  readonly entryAtomic: string;
  readonly prizeAtomic: string;
  readonly termsVersion: string;
}

export interface RoomResultView {
  readonly participantId: string;
  readonly name: string;
  readonly kind: 'HUMAN' | 'AGENT';
  readonly finishPosition: number;
}

export interface RoomView {
  readonly id: string;
  readonly name: string;
  readonly mode: RoomMode;
  readonly status: RoomStatus;
  /** Backing engine table assigned by the platform when the room is active. */
  readonly pokerTableId: string | null;
  /** Platform competition id (durable orchestration reference). */
  readonly pokerCompetitionId: string | null;
  /** Desired/expected humans for this room (not merely joined). */
  readonly humanCount: number;
  /** Desired/expected agents for this room. */
  readonly agentCount: number;
  readonly totalSeats: number;
  readonly participants: readonly RoomParticipantView[];
  readonly finance: RoomFinanceView | null;
  readonly results: readonly RoomResultView[] | null;
  readonly failureReason: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Cached platform liveness for config/stats views. */
export interface PlatformStatusView {
  readonly status: 'AVAILABLE' | 'UNAVAILABLE' | 'UNKNOWN';
  readonly reason: string | null;
  readonly updatedAt: number | null;
}

/** `GET /api/stats`; derived projection over product records only. */
export interface ProductStatsView {
  readonly platform: PlatformStatusView;
  readonly rooms: { total: number; open: number; running: number; finished: number };
  readonly games: { total: number; running: number; finished: number };
  readonly humans: number;
  readonly agents: number;
  readonly models: ReturnType<typeof productStatistics>;
}

/**
 * Operator audit projection. Deliberately exposes model/attempt metadata only:
 * no provider request/response bodies, headers, prompts, credentials or error
 * text ever leave this module for an audit response.
 */
export interface RoomAuditAttemptView {
  readonly attemptNo: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly costMicroUsd: number;
  readonly latencyMs: number;
  readonly createdAt: number;
  readonly recordedAt: number | null;
}

export interface RoomAuditDecisionView {
  readonly id: string;
  readonly tableId: string;
  readonly turnId: string;
  readonly principalId: string;
  readonly status: string;
  readonly promptPolicyId: string;
  readonly eventCursor: number;
  readonly attemptCount: number;
  readonly agentId: string | null;
  readonly model: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly attempts: readonly RoomAuditAttemptView[];
}

export interface RoomAuditView {
  readonly roomId: string;
  readonly decisions: readonly RoomAuditDecisionView[];
}

/** Outcome of one reconciliation pass over a room. */
export type ReconcileOutcome = 'SKIPPED' | 'PENDING' | 'ACTIVE' | 'COMPLETED' | 'FAILED';

/** `GET /api/config` challenge terms projection. */
export interface ChallengeTermsView {
  readonly assetId: string;
  readonly entryAtomic: string;
  readonly prizeAtomic: string;
  readonly termsVersion: string;
}

const COMPETITION_IDEMPOTENCY_PREFIX = 'nlhe-room:competition:v1';
const CHALLENGE_TERMS_VERSION_PREFIX = 'nlhe-challenge-terms:v1';

function stableKey(prefix: string, roomId: string): string {
  return `${prefix}:${roomId}`;
}

/** Deterministic opt-in terms version exposed to clients and re-checked. */
export function challengeTermsVersion(
  terms: Pick<ChallengeTermsConfig, 'assetId' | 'entryAtomic' | 'prizeAtomic'>,
): string {
  return createHash('sha256')
    .update(
      `${CHALLENGE_TERMS_VERSION_PREFIX}\0${terms.assetId}\0${terms.entryAtomic}\0${terms.prizeAtomic}`,
    )
    .digest('hex')
    .slice(0, 16);
}

function assertRequest(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ProductRoomError('INVALID_REQUEST', message);
}

function shortName(principalId: string): string {
  return principalId.length > 12 ? `${principalId.slice(0, 6)}…${principalId.slice(-4)}` : principalId;
}

function isPlatformErrorCode(error: ProductRoomError): boolean {
  return error.code === 'PLATFORM_UNAVAILABLE' || error.code === 'PLATFORM_REJECTED';
}

/**
 * Product room orchestrator. All methods are safe to retry: create returns the
 * existing room for an identical participant, join is idempotent, start
 * resumes PROVISIONING rooms through stable idempotency keys and completion is
 * recorded exactly once.
 */
export class ProductRooms {
  private readonly store: ProductStore;
  private readonly agents: AgentCatalog;
  private readonly competitions: PlatformCompetitions;
  private readonly platform: PlatformProbe;
  private readonly runtime: RoomRuntime | undefined;
  private readonly agentAvailable: (agentId: string) => boolean;
  private readonly log: (event: { event: string; detail?: string }) => void;
  private readonly challenge: ChallengeTermsConfig | null;
  private readonly seats = new Map<string, Map<string, number>>();
  private reconciliation: Promise<Record<ReconcileOutcome, number>> | null = null;
  private readonly roomOperations = new Map<string, Promise<unknown>>();
  private readonly roomReconciliations = new Map<string, Promise<ReconcileOutcome>>();
  private readonly nextReconciliationAt = new Map<string, number>();
  private platformStatus: PlatformStatusView = {
    status: 'UNKNOWN',
    reason: null,
    updatedAt: null,
  };

  constructor(options: ProductRoomsOptions) {
    this.store = options.store;
    this.agents = options.agents;
    this.competitions = options.competitions;
    this.platform = options.platform;
    this.runtime = options.runtime;
    this.challenge = options.challenge;
    this.agentAvailable = options.agentAvailable ?? ((agentId) => this.agents.get(agentId).enabled);
    this.log = options.log ?? (() => undefined);
  }

  // -------------------------------------------------------------------------
  // Configuration views
  // -------------------------------------------------------------------------

  /** Paid CHALLENGE availability; `null` when disabled. */
  challengeTerms(): ChallengeTermsView | null {
    if (this.challenge === null) return null;
    return {
      assetId: this.challenge.assetId,
      entryAtomic: this.challenge.entryAtomic,
      prizeAtomic: this.challenge.prizeAtomic,
      termsVersion: challengeTermsVersion(this.challenge),
    };
  }

  /** Last observed platform readiness; never throws. */
  cachedPlatformStatus(): PlatformStatusView {
    return this.platformStatus;
  }

  /**
   * Probe platform readiness once and cache it. Failures are reported as an
   * unavailable status; no platform detail is echoed to clients.
   */
  async probePlatform(): Promise<PlatformStatusView> {
    try {
      const readiness = (await this.platform.readiness()) as { status?: unknown } | null;
      if (readiness === null || typeof readiness !== 'object' || readiness.status !== 'ready') {
        throw new Error('platform is not ready');
      }
      this.platformStatus = { status: 'AVAILABLE', reason: null, updatedAt: Date.now() };
    } catch {
      this.platformStatus = { status: 'UNAVAILABLE', reason: 'PLATFORM_UNREACHABLE', updatedAt: Date.now() };
    }
    return this.platformStatus;
  }

  // -------------------------------------------------------------------------
  // Room reads
  // -------------------------------------------------------------------------

  /** All rooms, oldest first. */
  list(): RoomView[] {
    return this.store.listRooms().map((room) => this.roomView(room));
  }

  /** One room or `ROOM_NOT_FOUND`. */
  get(roomId: string): RoomView {
    return this.roomView(this.requireRoom(roomId));
  }

  // -------------------------------------------------------------------------
  // Room creation, membership, start
  // -------------------------------------------------------------------------

  /**
   * Create a room whose policy snapshot captures the desired roster. Agents
   * are resolved from the durable catalog; an authenticated human creator
   * claims one human seat; agent-only scheduled rooms require product admin.
   */
  create(command: CreateRoomCommand): RoomView {
    const name = command.name.trim();
    assertRequest(name.length > 0 && name.length <= 100, 'room name must be 1..100 characters');
    assertRequest(
      command.mode === 'SPONSORED' || command.mode === 'CHALLENGE',
      'mode must be SPONSORED or CHALLENGE',
    );
    assertRequest(
      Number.isSafeInteger(command.humanCount) && command.humanCount >= 0 && command.humanCount <= 10,
      'humanCount must be an integer in 0..10',
    );
    assertRequest(Array.isArray(command.agentIds), 'agentIds must be an array');
    assertRequest(
      new Set(command.agentIds).size === command.agentIds.length,
      'each agent may only be selected once',
    );
    assertRequest(
      command.agentIds.every((agentId) => typeof agentId === 'string' && agentId.trim() === agentId && agentId.length > 0),
      'agentIds must be non-empty identifiers',
    );

    const total = command.humanCount + command.agentIds.length;
    assertRequest(total >= 2 && total <= 10, 'a room requires 2..10 seats');

    if (command.mode === 'CHALLENGE') {
      if (this.challenge === null) {
        throw new ProductRoomError('CHALLENGE_DISABLED', 'paid CHALLENGE rooms are disabled');
      }
      assertRequest(command.humanCount === 1, 'CHALLENGE requires exactly one human');
      assertRequest(
        command.agentIds.length >= 1 && command.agentIds.length <= 9,
        'CHALLENGE requires 1..9 agents',
      );
      const finance = command.finance;
      assertRequest(finance !== null, 'CHALLENGE requires explicit entry and prize opt-in');
      assertRequest(
        finance.optIn === true,
        'CHALLENGE requires an explicit opt-in consent to the configured terms',
      );
      const atomic = /^[1-9][0-9]*$/;
      assertRequest(
        atomic.test(finance.entryAtomic) && atomic.test(finance.prizeAtomic),
        'challenge amounts must be positive canonical atomic decimal strings',
      );
      if (
        finance.assetId !== this.challenge.assetId ||
        finance.entryAtomic !== this.challenge.entryAtomic ||
        finance.prizeAtomic !== this.challenge.prizeAtomic
      ) {
        throw new ProductRoomError(
          'TERMS_MISMATCH',
          'challenge terms do not match the configured asset, entry and prize',
        );
      }
      if (command.creator === null) {
        throw new ProductRoomError(
          'NOT_AUTHORIZED',
          'CHALLENGE requires the paying wallet as its human participant',
        );
      }
    } else {
      assertRequest(command.finance == null, 'SPONSORED rooms never carry finance terms');
      if (command.creator === null && !command.admin) {
        throw new ProductRoomError('NOT_AUTHORIZED', 'creating a room requires an authenticated wallet');
      }
      if (command.creator !== null && command.humanCount < 1) {
        throw new ProductRoomError('INVALID_REQUEST', 'the creating wallet must claim a human seat');
      }
      if (command.creator === null && command.humanCount > 0) {
        throw new ProductRoomError(
          'NOT_AUTHORIZED',
          'human rooms require the creating wallet; the product admin creates agent-only rooms',
        );
      }
      if (command.humanCount === 0 && !command.admin) {
        throw new ProductRoomError(
          'NOT_AUTHORIZED',
          'agent-only rooms require the product admin credential',
        );
      }
    }

    const configs = command.agentIds.map((agentId) => this.requireAgent(agentId));
    const plannedPrincipals = new Set<string>();
    for (const config of configs) {
      assertRequest(
        !plannedPrincipals.has(config.principalId),
        `agent ${config.id} shares a principal with another agent`,
      );
      plannedPrincipals.add(config.principalId);
    }
    if (command.creator !== null) {
      assertRequest(
        !plannedPrincipals.has(command.creator.principalId),
        'the creating wallet shares a principal with an agent',
      );
    }

    // The policy snapshot is the desired roster: the authenticated creator and
    // every agent carry their durable principal (the store inserts only those
    // rows); unclaimed human seats are descriptors without a principal. Joins
    // compare actual human rows against the snapshot count.
    const participants = [
      ...(command.creator === null
        ? []
        : [{ kind: 'HUMAN' as const, principalId: command.creator.principalId }]),
      ...Array.from({ length: command.humanCount - (command.creator === null ? 0 : 1) }, () => ({
        kind: 'HUMAN' as const,
      })),
      ...configs.map((config) => ({
        kind: 'AGENT' as const,
        agentId: config.id,
        principalId: config.principalId,
      })),
    ];
    const policy =
      command.mode === 'CHALLENGE'
        ? {
            kind: 'CHALLENGE' as const,
            participants,
            finance: {
              optIn: true as const,
              assetId: this.challenge!.assetId,
              entryAtomic: this.challenge!.entryAtomic,
              prizeAtomic: this.challenge!.prizeAtomic,
            },
          }
        : { kind: 'SPONSORED' as const, participants };

    const id = randomUUID();
    try {
      this.store.createRoom({ id, name, policy });
      this.store.openRoomForRoster(id);
    } catch (error) {
      throw this.translateStoreError(error, `room ${id}`);
    }
    this.log({ event: 'room.created', detail: id });
    return this.get(id);
  }

  /** Add the authenticated human to an open room; idempotent for members. */
  join(roomId: string, principal: HumanActor): RoomView {
    const room = this.requireRoom(roomId);
    if (room.status !== 'DRAFT' && room.status !== 'WAITING_FOR_ROSTER') {
      throw new ProductRoomError('ROOM_STATE', `room ${roomId} is not open for joining`);
    }
    const participants = this.participants(roomId);
    if (participants.some((participant) => participant.principalId === principal.principalId)) {
      return this.roomView(room, participants);
    }
    const joinedHumans = participants.filter((participant) => participant.kind === 'HUMAN').length;
    if (joinedHumans >= room.policy.humanCount) {
      throw new ProductRoomError('ROOM_FULL', `room ${roomId} has no free human seat`);
    }
    try {
      this.store.addParticipant(roomId, { principalId: principal.principalId, kind: 'HUMAN' });
    } catch (error) {
      throw this.translateStoreError(error, `room ${roomId}`);
    }
    return this.roomView(this.requireRoom(roomId));
  }

  /** Remove the authenticated human from an open room. */
  leave(roomId: string, principalId: string): RoomView {
    const room = this.requireRoom(roomId);
    if (room.status !== 'DRAFT' && room.status !== 'WAITING_FOR_ROSTER') {
      throw new ProductRoomError('ROOM_STATE', `room ${roomId} can no longer change membership`);
    }
    const participant = this.participants(roomId).find(
      (candidate) => candidate.principalId === principalId,
    );
    if (participant === undefined) {
      throw new ProductRoomError('NOT_AUTHORIZED', 'only a room participant can leave');
    }
    try {
      this.store.removeParticipant(roomId, principalId);
    } catch (error) {
      throw this.translateStoreError(error, `room ${roomId}`);
    }
    return this.roomView(this.requireRoom(roomId));
  }

  /**
   * Start (or resume) a room. Readiness is checked before transition:
   * SPONSORED rooms require platform readiness, CHALLENGE rooms also require the
   * platform's own `financial.state === 'READY'` and fail closed otherwise.
   * Provisioning is idempotent through stable room-derived keys.
   */
  async start(roomId: string, actor: RoomActor): Promise<RoomView> {
    return this.withRoomOperation(roomId, () => this.startRoom(roomId, actor));
  }

  private async startRoom(roomId: string, actor: RoomActor): Promise<RoomView> {
    let room = this.requireRoom(roomId);
    if (room.status === 'COMPLETE') return this.roomView(room);
    if (room.status === 'FAILED') {
      throw new ProductRoomError('ROOM_STATE', `room ${roomId} has failed`);
    }
    const participants = this.participants(roomId);
    this.assertStartAuthorized(room, participants, actor);
    if (this.store.roomCancellationRequested(roomId)) {
      throw new ProductRoomError('ROOM_STATE', `room ${roomId} cancellation is pending`);
    }

    if (room.status === 'ACTIVE') {
      await this.attachRuntime(room);
      return this.roomView(room);
    }

    if (room.status === 'WAITING_FOR_ROSTER') {
      this.assertRosterComplete(room, participants);
      await this.assertPlatformReady(room);
      try {
        room = this.store.beginProvisioning(roomId);
      } catch (error) {
        throw this.translateStoreError(error, `room ${roomId}`);
      }
    }

    if (room.status === 'PROVISIONING') {
      this.assertRosterComplete(room, participants);
      await this.assertPlatformReady(room);
      room = await this.provision(room, participants);
    }
    return this.roomView(room);
  }

  /** Creator/operator recovery path. No readiness gate blocks risk-reducing cancellation. */
  async cancel(roomId: string, actor: RoomActor): Promise<RoomView> {
    return this.withRoomOperation(roomId, () => this.cancelRoom(roomId, actor));
  }

  private async cancelRoom(roomId: string, actor: RoomActor): Promise<RoomView> {
    const room = this.requireRoom(roomId);
    const participants = this.participants(roomId);
    this.assertStartAuthorized(room, participants, actor);
    if (room.status === 'FAILED' && room.failureReason === 'PLATFORM_CANCELLED') {
      return this.roomView(room);
    }
    try {
      this.store.requestRoomCancellation(roomId);
    } catch (error) {
      throw this.translateStoreError(error, `room ${roomId}`);
    }
    if (room.status === 'DRAFT' || room.status === 'WAITING_FOR_ROSTER') {
      return this.roomView(this.store.failRoom(roomId, 'PLATFORM_CANCELLED'));
    }
    return this.roomView(await this.provision(room, participants));
  }

  // -------------------------------------------------------------------------
  // Recovery and platform lifecycle reconciliation
  // -------------------------------------------------------------------------

  /**
   * Startup recovery: resume PROVISIONING rooms through their stable keys,
   * re-attach ACTIVE rooms to the runtime, record missing COMPLETE results and
   * run bounded recorded-only recovery for terminal rooms with pending traces
   * (even when the immutable result already exists). Individual room failures
   * are reported, never fabricated.
   */
  async recover(): Promise<{
    resumed: number;
    attached: number;
    recovered: number;
    pending: number;
    failed: number;
  }> {
    const summary = { resumed: 0, attached: 0, recovered: 0, pending: 0, failed: 0 };
    for (const room of this.store.listRooms('PROVISIONING')) {
      const outcome = await this.reconcileRoom(room.id);
      if (outcome === 'ACTIVE') summary.resumed += 1;
      else if (outcome === 'PENDING') summary.pending += 1;
      else if (outcome === 'FAILED') summary.failed += 1;
    }
    for (const room of this.store.listRooms('ACTIVE')) {
      try {
        await this.withRoomOperation(room.id, async () => {
          const current = this.store.getRoom(room.id);
          if (current?.status === 'ACTIVE') await this.attachRuntime(current);
        });
        summary.attached += 1;
      } catch {
        summary.pending += 1;
      }
    }
    for (const room of this.store.listRooms('COMPLETE')) {
      if (this.store.getRoomResult(room.id) === null) {
        await this.reconcileRoom(room.id);
      }
    }
    for (const room of [...this.store.listRooms('COMPLETE'), ...this.store.listRooms('FAILED')]) {
      if (!this.hasPendingRecorded(room.id)) continue;
      await this.reconcileRoom(room.id);
      if (!this.hasPendingRecorded(room.id)) summary.recovered += 1;
      else summary.pending += 1;
    }
    return summary;
  }

  /** Reconcile every non-terminal room once; safe to call on a timer. */
  reconcileAll(): Promise<Record<ReconcileOutcome, number>> {
    if (this.reconciliation !== null) return this.reconciliation;
    const pass = this.reconcileDueRooms();
    this.reconciliation = pass;
    void pass.finally(() => {
      if (this.reconciliation === pass) this.reconciliation = null;
    }).catch(() => undefined);
    return pass;
  }

  private async reconcileDueRooms(): Promise<Record<ReconcileOutcome, number>> {
    const counts: Record<ReconcileOutcome, number> = {
      SKIPPED: 0,
      PENDING: 0,
      ACTIVE: 0,
      COMPLETED: 0,
      FAILED: 0,
    };
    for (const room of this.store.listRooms()) {
      // A late durable receipt/response may appear after a terminal detach
      // failure. Re-enable recovery from local evidence, not platform polling.
      if (this.nextReconciliationAt.get(room.id) === Infinity && this.hasPendingRecorded(room.id)) {
        this.nextReconciliationAt.delete(room.id);
      }
      if (room.status === 'DRAFT' || room.status === 'WAITING_FOR_ROSTER' ||
          Date.now() < (this.nextReconciliationAt.get(room.id) ?? 0)) {
        counts.SKIPPED += 1;
        continue;
      }
      const outcome = await this.reconcileRoom(room.id);
      counts[outcome] += 1;
    }
    return counts;
  }

  /**
   * Reconcile one room exactly from durable state:
   * - PROVISIONING replays provisioning (stable idempotency key);
   * - ACTIVE polls the platform lifecycle and records authoritative results:
   *   settlement is triggered by the platform's `settlementReady` signal while
   *   RUNNING, or by an already-FINISHED cached projection;
   * - COMPLETE with no product result settles once and records placements;
   * - terminal rooms with pending recorded receipts get a bounded recorded-only
   *   recovery pass;
   * - a fully complete immutable room with no pending trace is SKIPPED before
   *   any platform read, so periodic reconciliation never polls history.
   */
  reconcileRoom(roomId: string): Promise<ReconcileOutcome> {
    const existing = this.roomReconciliations.get(roomId);
    if (existing !== undefined) return existing;
    const work = this.withRoomOperation(roomId, () => this.reconcileRoomOnce(roomId));
    this.roomReconciliations.set(roomId, work);
    void work.finally(() => {
      this.roomReconciliations.delete(roomId);
      this.setReconciliationCadence(roomId);
    }).catch(() => undefined);
    return work;
  }

  /** Serialize explicit transitions with recovery; never read an equivalent
   * competition concurrently from start/cancel and background reconciliation. */
  private withRoomOperation<T>(roomId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.roomOperations.get(roomId) ?? Promise.resolve();
    const work = previous.catch(() => undefined).then(operation);
    this.roomOperations.set(roomId, work);
    void work.finally(() => {
      if (this.roomOperations.get(roomId) === work) this.roomOperations.delete(roomId);
      this.setReconciliationCadence(roomId);
    }).catch(() => undefined);
    return work;
  }

  private setReconciliationCadence(roomId: string): void {
    const room = this.store.getRoom(roomId);
    if (room === null) { this.nextReconciliationAt.delete(roomId); return; }
    // ACTIVE: <=2 lifecycle reads/min/room, with <=30s settlement projection
    // latency. Provisioning/cancellation: <=12 recovery passes/min. Terminal
    // history never polls; only genuinely pending durable work is retried.
    const terminal = room.status === 'COMPLETE' || room.status === 'FAILED';
    const pendingTerminal = terminal && (this.hasPendingRecorded(roomId) ||
      (room.status === 'COMPLETE' && this.store.getRoomResult(roomId) === null));
    const delay = terminal && !pendingTerminal ? Infinity :
      room.status === 'ACTIVE' && !this.store.roomCancellationRequested(roomId) ? 30_000 : 5_000;
    this.nextReconciliationAt.set(roomId, Date.now() + delay);
  }

  private async reconcileRoomOnce(roomId: string): Promise<ReconcileOutcome> {
    const room = this.store.getRoom(roomId);
    if (room === null) return 'SKIPPED';
    try {
      if (room.status === 'PROVISIONING') {
        if (!this.store.roomCancellationRequested(roomId)) await this.assertPlatformReady(room);
        const participants = this.participants(roomId);
        const resumed = await this.provision(room, participants);
        if (resumed.status === 'ACTIVE') return 'ACTIVE';
        if (resumed.status === 'FAILED') return 'FAILED';
        return 'PENDING';
      }
      if (room.status === 'ACTIVE') {
        return await this.reconcilePlatformRoom(room);
      }
      if (room.status === 'COMPLETE') {
        if (this.store.getRoomResult(roomId) === null) {
          return await this.reconcilePlatformRoom(room);
        }
        if (this.hasPendingRecorded(roomId)) {
          await this.recoverRecordedRuntime(room);
          return this.hasPendingRecorded(roomId) ? 'PENDING' : 'SKIPPED';
        }
        return 'SKIPPED';
      }
      if (room.status === 'FAILED') {
        if (this.hasPendingRecorded(roomId)) {
          await this.recoverRecordedRuntime(room);
          return this.hasPendingRecorded(roomId) ? 'PENDING' : 'SKIPPED';
        }
        return 'SKIPPED';
      }
      return 'SKIPPED';
    } catch (error) {
      if (error instanceof ProductRoomError && isPlatformErrorCode(error)) {
        this.log({ event: 'room.reconcile_pending', detail: `${roomId}:${error.code}` });
        return 'PENDING';
      }
      this.log({ event: 'room.reconcile_failed', detail: roomId });
      return 'PENDING';
    }
  }

  // -------------------------------------------------------------------------
  // Statistics (product projections only, never financial P&L)
  // -------------------------------------------------------------------------

  /**
   * Product store projection: room counts, distinct participants and per-agent
   * model analytics (games/wins from platform placements, integer provider
   * expense separately). No financial profit or loss is derived.
   */
  stats(): ProductStatsView {
    const rooms = this.store.listRooms();
    const outcomes: ProductOutcome[] = [];
    const calls: ModelMetric[] = [];
    const humans = new Set<string>();
    const agentPrincipals = new Map<string, string>();

    const outcomesByRoom: ProductOutcome[] = [];
    for (const room of rooms) {
      for (const participant of this.participants(room.id)) {
        if (participant.kind === 'HUMAN') humans.add(participant.principalId);
        else if (participant.agentId !== null) {
          agentPrincipals.set(participant.principalId, participant.agentId);
        }
      }
      const result = this.store.getRoomResult(room.id);
      if (result === null) continue;
      for (const placement of result.placements) {
        outcomesByRoom.push({
          roomId: room.id,
          principalId: placement.principalId,
          agentId: agentPrincipals.get(placement.principalId) ?? null,
          placement: placement.placement,
          mode: room.policyKind,
        });
      }
    }
    outcomes.push(...outcomesByRoom);

    for (const decision of this.store.listDecisions()) {
      const agentId = agentPrincipals.get(decision.principalId);
      if (agentId === undefined) continue;
      for (const attempt of this.store.listAttempts(decision.id)) {
        if (attempt.recordedAt === null) continue;
        calls.push({
          agentId,
          inputTokens: attempt.promptTokens,
          outputTokens: attempt.completionTokens,
          costUsdMicro: attempt.costMicroUsd,
          latencyMs: attempt.latencyMs,
        });
      }
    }

    return {
      platform: this.platformStatus,
      rooms: {
        total: rooms.length,
        open: rooms.filter((room) => room.status === 'DRAFT' || room.status === 'WAITING_FOR_ROSTER').length,
        running: rooms.filter((room) => room.status === 'PROVISIONING' || room.status === 'ACTIVE').length,
        finished: rooms.filter((room) => room.status === 'COMPLETE' || room.status === 'FAILED').length,
      },
      games: {
        total: rooms.length,
        running: rooms.filter((room) => room.status === 'ACTIVE').length,
        finished: rooms.filter((room) => room.status === 'COMPLETE').length,
      },
      humans: humans.size,
      agents: this.agents.list().length,
      models: productStatistics(outcomes, calls),
    };
  }

  // -------------------------------------------------------------------------
  // Operator audit (metadata only; never provider payloads)
  // -------------------------------------------------------------------------

  /**
   * Operator-private audit projection for one room. Only decision coordinates,
   * model identity and integer usage metrics are returned; recorded provider
   * requests/responses, prompts, headers and error text stay in the store.
   */
  auditRoom(roomId: string): RoomAuditView {
    this.requireRoom(roomId);
    const agentByPrincipal = new Map<string, string>();
    for (const participant of this.participants(roomId)) {
      if (participant.kind === 'AGENT' && participant.agentId !== null) {
        agentByPrincipal.set(participant.principalId, participant.agentId);
      }
    }
    const decisions = this.store
      .listDecisions({ roomId })
      .map((decision): RoomAuditDecisionView => {
        const agentId = agentByPrincipal.get(decision.principalId) ?? null;
        return {
          id: decision.id,
          tableId: decision.tableId,
          turnId: decision.turnId,
          principalId: decision.principalId,
          status: decision.status,
          promptPolicyId: decision.promptPolicyId,
          eventCursor: decision.eventCursor,
          attemptCount: decision.attemptCount,
          agentId,
          model:
            agentId !== null && this.agents.has(agentId) ? this.agents.get(agentId).model : null,
          createdAt: decision.createdAt,
          updatedAt: decision.updatedAt,
          attempts: this.store.listAttempts(decision.id).map((attempt) => ({
            attemptNo: attempt.attemptNo,
            promptTokens: attempt.promptTokens,
            completionTokens: attempt.completionTokens,
            costMicroUsd: attempt.costMicroUsd,
            latencyMs: attempt.latencyMs,
            createdAt: attempt.createdAt,
            recordedAt: attempt.recordedAt,
          })),
        };
      });
    return { roomId, decisions };
  }

  // -------------------------------------------------------------------------
  // Agent runtime credentials (table-scoped, competition-bound)
  // -------------------------------------------------------------------------

  /**
   * Issue or rotate the table-scoped runtime credential for every AGENT
   * participant of a provisioned room. The credential is deliberately
   * table-bound only: the platform derives the acting seat from the
   * authenticated principal, and a seat restriction would reject an
   * idempotent cached receipt after the agent is eliminated. `chatEnabled`
   * and `expiresAt` are injected service configuration only (never browser
   * authority); public chat scope is requested only when the product has
   * approved agent speech.
   */
  async issueAgentCredentials(
    roomId: string,
    options: { chatEnabled?: boolean; expiresAt?: string } = {},
  ): Promise<
    Array<{
      agentId: string;
      principalId: string;
      credentialId: string;
      token: string;
      scopes: readonly string[];
      seat: number | null;
    }>
  > {
    const room = this.requireRoom(roomId);
    if (room.platformCompetitionId === null) {
      throw new ProductRoomError('ROOM_STATE', `room ${roomId} has no platform competition yet`);
    }
    const scopes: IssueAgentCredentialRequest['scopes'] =
      options.chatEnabled === true
        ? ['table:observe', 'table:act', 'table:chat']
        : ['table:observe', 'table:act'];
    const issued: Array<{
      agentId: string;
      principalId: string;
      credentialId: string;
      token: string;
      scopes: readonly string[];
      seat: number | null;
    }> = [];
    for (const participant of this.participants(roomId)) {
      if (participant.kind !== 'AGENT' || participant.agentId === null) continue;
      const config = this.requireAgent(participant.agentId);
      const request: IssueAgentCredentialRequest = {
        principalId: participant.principalId,
        name: config.name,
        scopes,
        ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
      };
      const credential = await this.issueCredential(room.platformCompetitionId, request);
      issued.push({
        agentId: config.id,
        principalId: participant.principalId,
        credentialId: credential.credentialId,
        token: credential.token,
        scopes: credential.scopes,
        seat: credential.seat,
      });
    }
    return issued;
  }

  private async issueCredential(
    competitionId: string,
    request: IssueAgentCredentialRequest,
  ): Promise<IssuedAgentCredential> {
    try {
      return await this.competitions.issueAgentCredential(competitionId, request);
    } catch (error) {
      throw this.platformError('issueAgentCredential', error);
    }
  }

  // -------------------------------------------------------------------------
  // Private: authorization and roster checks
  // -------------------------------------------------------------------------

  private requireRoom(roomId: string): ProductRoom {
    const room = this.store.getRoom(roomId);
    if (room === null) throw new ProductRoomError('ROOM_NOT_FOUND', `room not found: ${roomId}`);
    return room;
  }

  private requireAgent(agentId: string): AgentConfig {
    let config: AgentConfig;
    try {
      config = this.agents.get(agentId);
    } catch {
      throw new ProductRoomError('AGENT_NOT_AVAILABLE', `unknown agent: ${agentId}`);
    }
    if (!config.enabled) {
      throw new ProductRoomError('AGENT_NOT_AVAILABLE', `agent ${agentId} is disabled`);
    }
    return config;
  }

  private assertStartAuthorized(
    room: ProductRoom,
    participants: readonly ProductParticipant[],
    actor: RoomActor,
  ): void {
    if (actor.admin) return;
    if (actor.principalId === null) {
      throw new ProductRoomError('NOT_AUTHORIZED', 'starting a room requires authentication');
    }
    const member = participants.find(
      (participant) => participant.principalId === actor.principalId,
    );
    if (member === undefined) {
      throw new ProductRoomError('NOT_AUTHORIZED', 'only a room participant may start the room');
    }
    if (room.policyKind === 'CHALLENGE' && member.kind !== 'HUMAN') {
      throw new ProductRoomError('NOT_AUTHORIZED', 'the challenge human must start the room');
    }
  }

  private assertRosterComplete(
    room: ProductRoom,
    participants: readonly ProductParticipant[],
  ): void {
    // The policy snapshot is the desired roster; the actual roster must match
    // it exactly with durable identities only (no placeholders exist).
    const desiredHumans = room.policy.humanCount;
    const desiredAgents = room.policy.agentCount;
    const joinedHumans = participants.filter((participant) => participant.kind === 'HUMAN').length;
    const joinedAgents = participants.filter((participant) => participant.kind === 'AGENT').length;
    if (joinedHumans !== desiredHumans) {
      throw new ProductRoomError(
        'ROSTER_INCOMPLETE',
        `room needs ${desiredHumans} human(s), has ${joinedHumans}`,
      );
    }
    if (joinedAgents !== desiredAgents) {
      throw new ProductRoomError(
        'ROSTER_INCOMPLETE',
        `room needs ${desiredAgents} agent(s), has ${joinedAgents}`,
      );
    }
    for (const participant of participants) {
      if (participant.principalId.length === 0) {
        throw new ProductRoomError('ROSTER_INCOMPLETE', 'room participant identity is missing');
      }
      if (participant.kind !== 'AGENT' || participant.agentId === null) continue;
      const config = this.requireAgent(participant.agentId);
      if (!this.agentAvailable(config.id)) {
        throw new ProductRoomError(
          'AGENT_NOT_AVAILABLE',
          `agent ${config.id} has no usable provider credentials`,
        );
      }
    }
  }

  private async assertPlatformReady(room: ProductRoom): Promise<void> {
    let readiness: { status?: unknown; financial?: { state?: unknown } } | null;
    try {
      readiness = await this.platform.readiness() as typeof readiness;
    } catch {
      throw new ProductRoomError('PLATFORM_UNAVAILABLE', 'platform readiness could not be read');
    }
    if (readiness?.status !== 'ready' ||
        (room.policyKind === 'CHALLENGE' && readiness.financial?.state !== 'READY')) {
      throw new ProductRoomError('PLATFORM_UNAVAILABLE', 'required platform readiness is not READY');
    }
  }

  // -------------------------------------------------------------------------
  // Private: provisioning and platform lifecycle
  // -------------------------------------------------------------------------

  private async provision(
    room: ProductRoom,
    participants: readonly ProductParticipant[],
  ): Promise<ProductRoom> {
    const entrants: CompetitionEntrantSpec[] = participants.map((participant) => ({
      principalId: participant.principalId,
      kind: participant.kind === 'AGENT' ? 'SERVICE' : 'WALLET',
    }));
    if (entrants.length < 2 || entrants.length > 10) {
      throw new ProductRoomError('ROSTER_INCOMPLETE', 'platform competitions require 2..10 entrants');
    }
    const mode = room.policyKind === 'CHALLENGE' ? 'ASSET' : 'NONFINANCIAL';
    let competition: Competition;
    try {
      // Once recorded, the platform reference is sufficient for recovery and
      // cancellation, even if CHALLENGE admission has since been disabled.
      if (room.platformCompetitionId !== null) {
        competition = CompetitionSchema.parse(await this.competitions.getCompetition(room.platformCompetitionId));
      } else {
        const request: CreateCompetitionRequest = {
          name: room.name, mode, entrants,
          idempotencyKey: stableKey(COMPETITION_IDEMPOTENCY_PREFIX, room.id),
          ...(mode === 'ASSET' ? { terms: this.competitionTerms(room, participants) } : {}),
        };
        competition = CreateCompetitionResponseSchema.parse(
          await this.competitions.createCompetition(request),
        ).competition;
      }
    } catch (error) {
      throw this.platformError(room.platformCompetitionId === null ? 'createCompetition' : 'getCompetition', error);
    }

    // Re-read durable intent after I/O: a concurrent cancellation or a crash
    // during creation must never be forgotten by provisioning recovery.
    const current = this.requireRoom(room.id);
    if (current.status === 'FAILED' || current.status === 'ACTIVE' || current.status === 'COMPLETE') return current;
    this.recordPlatformReferences(current, competition);
    if (this.store.roomCancellationRequested(room.id) && competition.status === 'REGISTRATION') {
      try {
        const cancelled = CancelCompetitionResponseSchema.parse(
          await this.competitions.cancelCompetition(competition.id),
        );
        if (cancelled.status !== 'CANCELLED' || cancelled.competitionId !== competition.id) {
          throw new Error('platform did not confirm cancellation');
        }
        const latest = this.requireRoom(room.id);
        if (latest.status === 'FAILED') return latest;
        return this.store.failRoom(room.id, 'PLATFORM_CANCELLED');
      } catch (error) {
        // The platform, not a product lock, decides cancel versus start.
        const latest = CompetitionSchema.parse(await this.competitions.getCompetition(competition.id));
        if (latest.status === 'REGISTRATION') throw this.platformError('cancelCompetition', error);
        return this.provision(this.requireRoom(room.id), participants);
      }
    }
    if (competition.status === 'RUNNING' || competition.status === 'FINISHED') {
      this.store.clearRoomCancellation(room.id);
    }

    if (competition.status === 'CANCELLED') {
      try {
        const latest = this.requireRoom(room.id);
        const failed = latest.status === 'FAILED' ? latest : this.store.failRoom(room.id, 'PLATFORM_CANCELLED');
        await this.detachRuntime(room.id);
        return failed;
      } catch (error) {
        throw this.translateStoreError(error, `room ${room.id}`);
      }
    }

    // Paid entry is settled by the wallet itself through the public SDK. The
    // product only reads the authoritative platform entry state; a PENDING
    // entry keeps the room PROVISIONING with its competition reference and
    // never charges, starts or fails locally.
    if (mode === 'ASSET' && !this.entrySettled(competition)) {
      const pending = this.recordPlatformReferences(room, competition);
      this.log({ event: 'room.entry_pending', detail: room.id });
      return pending;
    }

    if (competition.status === 'REGISTRATION') this.assertRosterComplete(room, participants);
    try {
      const started: StartCompetitionResponse = StartCompetitionResponseSchema.parse(
        await this.competitions.startCompetition(competition.id, {}),
      );
      this.rememberSeats(room.id, started.seats);
    } catch (error) {
      throw this.platformError('startCompetition', error);
    }

    let active: ProductRoom;
    try {
      const latest = this.requireRoom(room.id);
      if (latest.status === 'ACTIVE' || latest.status === 'FAILED') return latest;
      this.store.clearRoomCancellation(room.id);
      active = this.store.activateRoom(room.id, {
        tableId: competition.tableId,
        platformCompetitionId: competition.id,
      });
    } catch (error) {
      throw this.translateStoreError(error, `room ${room.id}`);
    }
    await this.attachRuntime(active);
    this.log({ event: 'room.active', detail: room.id });
    return active;
  }

  /** Persist the platform references on a still-PROVISIONING paid room. */
  private recordPlatformReferences(room: ProductRoom, competition: Competition): ProductRoom {
    try {
      return this.store.setPlatformReferences(room.id, {
        tableId: competition.tableId,
        platformCompetitionId: competition.id,
      });
    } catch (error) {
      throw this.translateStoreError(error, `room ${room.id}`);
    }
  }

  /** Whether every configured WALLET entry payer has actually PAID. */
  private entrySettled(competition: Competition): boolean {
    const payerIds = competition.terms?.entry.payers.map((payer) => payer.principalId) ?? [];
    if (payerIds.length === 0) return true;
    return competition.entrants
      .filter((entrant) => payerIds.includes(entrant.principalId))
      .every((entrant) => entrant.entryState === 'PAID');
  }

  private competitionTerms(
    room: ProductRoom,
    participants: readonly ProductParticipant[],
  ): NonNullable<CreateCompetitionRequest['terms']> {
    if (this.challenge === null) {
      throw new ProductRoomError('CHALLENGE_DISABLED', 'paid CHALLENGE rooms are disabled');
    }
    const payer = participants.find((participant) => participant.kind === 'HUMAN');
    if (payer === undefined) {
      throw new ProductRoomError('ROSTER_INCOMPLETE', 'challenge requires its human payer');
    }
    return {
      entry: {
        assetId: this.challenge.assetId,
        amountAtomic: this.challenge.entryAtomic,
        payers: [{ principalId: payer.principalId }],
      },
      prize: {
        assetId: this.challenge.assetId,
        amountAtomic: this.challenge.prizeAtomic,
        sponsorPrincipalId: this.challenge.sponsorPrincipalId,
      },
    };
  }

  private async reconcilePlatformRoom(room: ProductRoom): Promise<ReconcileOutcome> {
    if (room.platformCompetitionId === null) {
      if (room.status === 'COMPLETE') return 'SKIPPED';
      throw new ProductRoomError('PLATFORM_REJECTED', 'active room has no platform competition reference');
    }
    let competition: Competition;
    try {
      competition = CompetitionSchema.parse(
        await this.competitions.getCompetition(room.platformCompetitionId),
      );
    } catch (error) {
      throw this.platformError('getCompetition', error);
    }
    this.rememberCompetitionSeats(room.id, competition.entrants);

    if (room.status === 'COMPLETE') {
      if (this.store.getRoomResult(room.id) === null) {
        await this.settleAndRecord(room, competition);
      }
      await this.detachRuntime(room.id);
      return 'COMPLETED';
    }

    switch (competition.status) {
      case 'FINISHED':
        // Settle already ran (status only becomes FINISHED through it); the
        // cached completed retry stays idempotent.
        await this.settleAndRecord(room, competition);
        return 'COMPLETED';
      case 'RUNNING':
        // Authoritative platform settlement signal from the backing game's
        // completed state. The platform only sets FINISHED once settle
        // succeeds, so waiting for FINISHED alone would stall forever.
        if (competition.settlementReady) {
          await this.settleAndRecord(room, competition);
          return 'COMPLETED';
        }
        // Retry only missing clients after failed startup/auth/rejoin. The
        // runtime coalesces attachment and preserves already-running agents;
        // healthy agents incur no REST reads on this lifecycle cadence.
        await this.attachRuntime(room);
        return 'PENDING';
      case 'CANCELLED':
        this.store.failRoom(room.id, 'PLATFORM_CANCELLED');
        await this.detachRuntime(room.id);
        return 'FAILED';
      default:
        return 'PENDING';
    }
  }

  private async settleAndRecord(room: ProductRoom, competition: Competition): Promise<void> {
    let settled: SettleCompetitionResponse;
    try {
      settled = SettleCompetitionResponseSchema.parse(
        await this.competitions.settleCompetition(competition.id, {}),
      );
    } catch (error) {
      throw this.platformError('settleCompetition', error);
    }
    if (room.status !== 'COMPLETE') {
      try {
        this.store.completeRoom(room.id);
      } catch (error) {
        throw this.translateStoreError(error, `room ${room.id}`);
      }
    }
    if (this.store.getRoomResult(room.id) === null) {
      const placements: RoomResultPlacement[] = settled.placements.map((placement) => ({
        principalId: placement.principalId,
        kind: placement.kind === 'SERVICE' ? 'AGENT' : 'HUMAN',
        placement: placement.placement,
      }));
      try {
        this.store.recordRoomResult({ roomId: room.id, placements });
      } catch (error) {
        if (!(error instanceof ProductStoreError && error.code === 'RESULT_EXISTS')) {
          throw this.translateStoreError(error, `room ${room.id}`);
        }
      }
    }
    await this.detachRuntime(room.id);
    this.log({ event: 'room.completed', detail: room.id });
  }

  private async attachRuntime(room: ProductRoom): Promise<void> {
    if (this.runtime === undefined) return;
    try {
      await this.runtime.attach(room);
    } catch {
      this.log({ event: 'room.runtime_attach_failed', detail: room.id });
    }
  }

  /** Stop the room runtime and drop its in-memory credentials (terminal rooms). */
  private async detachRuntime(roomId: string): Promise<void> {
    if (this.runtime?.detach === undefined) return;
    try {
      await this.runtime.detach(roomId);
    } catch {
      this.log({ event: 'room.runtime_detach_failed', detail: roomId });
    }
  }

  /**
   * Durable trace that still needs orchestration: a recorded provider
   * response or a submitted action awaiting the platform receipt. Local
   * versions never imply COMMITTED.
   */
  private hasPendingRecorded(roomId: string): boolean {
    return (
      this.store.listDecisions({ roomId, status: 'PROVIDER_RECORDED' }).length > 0 ||
      this.store.listDecisions({ roomId, status: 'ACTION_SUBMITTED' }).length > 0
    );
  }

  /**
   * Bounded recorded-only recovery: no new provider HTTP, no fabricated
   * deadline, no retained runtime; credentials are dropped immediately after
   * the drain.
   */
  private async recoverRecordedRuntime(room: ProductRoom): Promise<void> {
    if (this.runtime?.recoverRecorded === undefined) return;
    try {
      await this.runtime.recoverRecorded(room);
    } catch {
      this.log({ event: 'room.recorded_recovery_failed', detail: room.id });
    }
  }

  private rememberSeats(roomId: string, seats: readonly CompetitionSeatAssignment[]): void {
    const map = new Map<string, number>();
    for (const assignment of seats) map.set(assignment.principalId, assignment.seat);
    this.seats.set(roomId, map);
  }

  private rememberCompetitionSeats(
    roomId: string,
    entrants: readonly { principalId: string; seat: number }[],
  ): void {
    const map = this.seats.get(roomId) ?? new Map<string, number>();
    for (const entrant of entrants) map.set(entrant.principalId, entrant.seat);
    this.seats.set(roomId, map);
  }

  private seatFor(roomId: string, principalId: string): number | null {
    return this.seats.get(roomId)?.get(principalId) ?? null;
  }

  // -------------------------------------------------------------------------
  // Private: views and projections
  // -------------------------------------------------------------------------

  /**
   * Durable room participants (only rows the store actually holds; the policy
   * snapshot's unclaimed human descriptors never become rows).
   */
  private participants(roomId: string): ProductParticipant[] {
    return this.store
      .listParticipants(roomId)
      .sort((a, b) => a.joinedAt - b.joinedAt || a.principalId.localeCompare(b.principalId));
  }

  private roomView(room: ProductRoom, provided?: readonly ProductParticipant[]): RoomView {
    const participants = provided ?? this.participants(room.id);
    const humanCount = room.policy.humanCount;
    const agentCount = room.policy.agentCount;
    const result = this.store.getRoomResult(room.id);
    return {
      id: room.id,
      name: room.name,
      mode: room.policyKind,
      status: room.status,
      pokerTableId: room.tableId,
      pokerCompetitionId: room.platformCompetitionId,
      humanCount,
      agentCount,
      totalSeats: humanCount + agentCount,
      participants: participants.map((participant) => this.participantView(room.id, participant)),
      finance: this.financeView(room.policy),
      results:
        result === null
          ? null
          : result.placements
              .slice()
              .sort((a, b) => a.placement - b.placement)
              .map((placement) => {
                const participant = participants.find(
                  (candidate) => candidate.principalId === placement.principalId,
                );
                return {
                  participantId: placement.principalId,
                  name:
                    participant === undefined
                      ? shortName(placement.principalId)
                      : this.participantName(participant),
                  kind: placement.kind,
                  finishPosition: placement.placement,
                };
              }),
      failureReason: room.failureReason,
      createdAt: room.createdAt,
      updatedAt: room.updatedAt,
    };
  }

  private participantView(roomId: string, participant: ProductParticipant): RoomParticipantView {
    return {
      id: participant.principalId,
      kind: participant.kind,
      name: this.participantName(participant),
      address: null,
      agentId: participant.agentId,
      agentModel:
        participant.agentId !== null && this.agents.has(participant.agentId)
          ? this.agents.get(participant.agentId).model
          : null,
      pokerPrincipalId: participant.principalId,
      seat: this.seatFor(roomId, participant.principalId),
      joinedAt: participant.joinedAt,
    };
  }

  private participantName(participant: ProductParticipant): string {
    if (participant.kind === 'AGENT' && participant.agentId !== null && this.agents.has(participant.agentId)) {
      return this.agents.get(participant.agentId).name;
    }
    return shortName(participant.principalId);
  }

  private financeView(policy: ProductPolicy): RoomFinanceView | null {
    if (policy.kind !== 'CHALLENGE' || policy.finance === null) return null;
    return {
      assetId: policy.finance.assetId,
      entryAtomic: policy.finance.entryAtomic,
      prizeAtomic: policy.finance.prizeAtomic,
      // Derived from the immutable snapshot, not current configuration.
      termsVersion: challengeTermsVersion(policy.finance),
    };
  }

  // -------------------------------------------------------------------------
  // Private: error translation
  // -------------------------------------------------------------------------

  private platformError(operation: string, error: unknown): ProductRoomError {
    if (error instanceof ProductRoomError) return error;
    const message = error instanceof Error ? error.message : 'platform call failed';
    this.log({ event: 'platform.error', detail: `${operation}:${message}` });
    return new ProductRoomError('PLATFORM_REJECTED', `platform ${operation} failed`);
  }

  private translateStoreError(error: unknown, context: string): ProductRoomError {
    if (error instanceof ProductRoomError) return error;
    if (error instanceof PolicyViolationError) {
      return new ProductRoomError('ROSTER_INCOMPLETE', `${context}: ${error.message}`);
    }
    if (error instanceof ProductStoreError) {
      if (error.code === 'ROOM_NOT_FOUND') return new ProductRoomError('ROOM_NOT_FOUND', error.message);
      if (error.code === 'PARTICIPANT_EXISTS') {
        return new ProductRoomError('ROOM_STATE', `${context}: participant already exists`);
      }
      if (error.code === 'ROOM_STATE') return new ProductRoomError('ROOM_STATE', error.message);
      return new ProductRoomError('INVALID_REQUEST', `${context}: ${error.message}`);
    }
    return new ProductRoomError(
      'PLATFORM_REJECTED',
      `${context}: ${error instanceof Error ? error.message : 'store operation failed'}`,
    );
  }
}
