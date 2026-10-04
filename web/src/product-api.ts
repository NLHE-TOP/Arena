/**
 * Product API client (same-origin `/api/*`).
 *
 * EXACT contract for the fresh product API: no legacy field aliases, no
 * direct/envelope tolerance. Every response is parsed field-by-field and an
 * unexpected shape fails with a readable error instead of producing partial
 * UI state.
 *
 * Contract (see web/README.md):
 *
 *   GET  /api/config              -> ProductConfig (direct object)
 *   GET  /api/agents              -> { agents: AgentSummary[] }
 *   GET  /api/rooms               -> { rooms: RoomDetail[] }
 *   POST /api/rooms               -> { room: RoomDetail }
 *   GET  /api/rooms/:id           -> { room: RoomDetail }
 *   POST /api/rooms/:id/join      -> { room: RoomDetail }
 *   POST /api/rooms/:id/start     -> { room: RoomDetail }
 *   GET  /api/stats               -> ProductStats (direct object)
 *
 * The product API resolves identity by introspecting the caller's opaque
 * PokerTools bearer token; this client only attaches it. Entry charging never
 * happens here: the payer calls the platform `CompetitionClient.optIn` directly.
 */

export type RoomMode = 'SPONSORED' | 'CHALLENGE';

/** Product room lifecycle (durable DB status, exact). */
export type RoomStatus =
  | 'DRAFT'
  | 'WAITING_FOR_ROSTER'
  | 'PROVISIONING'
  | 'ACTIVE'
  | 'COMPLETE'
  | 'FAILED';

export type PlatformStatusValue = 'AVAILABLE' | 'UNAVAILABLE' | 'UNKNOWN';

export interface PlatformStatus {
  status: PlatformStatusValue;
  reason: string | null;
  updatedAt: number | null;
}

/** Operator-configured CHALLENGE terms; the only valid create tuple. */
export interface ChallengeTerms {
  assetId: string;
  entryAtomic: string;
  prizeAtomic: string;
  termsVersion: string;
}

export interface ProductConfig {
  /** Base URL of the PokerTools API used by the public SDK. */
  pokerApiUrl: string;
  platform: PlatformStatus;
  /**
   * Challenge availability and the configured terms. The product server may
   * also expose an `assets` reference/placeholder list; it is deliberately not
   * parsed here because symbol/decimals must come from the platform's actual
   * finance assets (`PokerClient.getAssets()`).
   */
  challenge: { enabled: boolean; terms: ChallengeTerms | null };
}

export interface AgentSummary {
  id: string;
  name: string;
  /** Public model metadata only. */
  model: string;
  provider: string | null;
  available: boolean;
}

export interface RoomParticipant {
  id: string;
  kind: 'HUMAN' | 'AGENT';
  name: string;
  address: string | null;
  agentId: string | null;
  agentModel: string | null;
  /** Durable PokerTools principal id. */
  pokerPrincipalId: string;
  /** Authoritative seat when assigned; never authorization. */
  seat: number | null;
  joinedAt: number;
}

export interface RoomFinance {
  assetId: string;
  entryAtomic: string;
  prizeAtomic: string;
  termsVersion: string;
}

export interface RoomResult {
  participantId: string;
  name: string;
  kind: 'HUMAN' | 'AGENT';
  finishPosition: number;
}

export interface RoomSummary {
  id: string;
  name: string;
  mode: RoomMode;
  status: RoomStatus;
  /** Backing engine table assigned only when ACTIVE/COMPLETE. */
  pokerTableId: string | null;
  /** Durable platform competition reference (set from PROVISIONING on). */
  pokerCompetitionId: string | null;
  /** Desired roster counts, not merely joined. */
  humanCount: number;
  agentCount: number;
  totalSeats: number;
  createdAt: number;
  updatedAt: number;
}

export interface RoomDetail extends RoomSummary {
  participants: RoomParticipant[];
  finance: RoomFinance | null;
  results: RoomResult[] | null;
  failureReason: string | null;
}

/**
 * `POST /api/rooms` body. CHALLENGE `finance` must be the exact
 * operator-configured tuple with explicit opt-in; the server re-validates it.
 */
export interface CreateRoomRequest {
  name: string;
  mode: RoomMode;
  humanCount: number;
  agentIds: string[];
  finance?: {
    assetId: string;
    entryAtomic: string;
    prizeAtomic: string;
    optIn: boolean;
  } | null;
}

export interface ModelMetricView {
  agentId: string;
  games: number;
  wins: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsdMicro: number;
  latencyMs: number;
}

export interface ProductStats {
  platform: PlatformStatus;
  rooms: { total: number; open: number; running: number; finished: number };
  games: { total: number; running: number; finished: number };
  humans: number;
  agents: number;
  models: ModelMetricView[];
}

export class ProductApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string | null = null
  ) {
    super(message);
    this.name = 'ProductApiError';
  }
}

// ---------------------------------------------------------------------------
// Strict parsing helpers
// ---------------------------------------------------------------------------

function fail(label: string, detail: string): never {
  throw new ProductApiError(`${label}: ${detail}`, 0);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(label, 'expected an object');
  }
  return value as Record<string, unknown>;
}

function field(source: Record<string, unknown>, key: string, label: string): unknown {
  if (!(key in source)) fail(label, `missing "${key}"`);
  return source[key];
}

function stringField(source: Record<string, unknown>, key: string, label: string): string {
  const value = field(source, key, label);
  if (typeof value !== 'string' || value.length === 0) fail(label, `"${key}" must be a non-empty string`);
  return value;
}

function nullableStringField(
  source: Record<string, unknown>,
  key: string,
  label: string
): string | null {
  const value = field(source, key, label);
  if (value === null) return null;
  if (typeof value !== 'string') fail(label, `"${key}" must be a string or null`);
  return value;
}

function numberField(source: Record<string, unknown>, key: string, label: string): number {
  const value = field(source, key, label);
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(label, `"${key}" must be a number`);
  return value;
}

function integerField(source: Record<string, unknown>, key: string, label: string): number {
  const value = numberField(source, key, label);
  if (!Number.isInteger(value)) fail(label, `"${key}" must be an integer`);
  return value;
}

function booleanField(source: Record<string, unknown>, key: string, label: string): boolean {
  const value = field(source, key, label);
  if (typeof value !== 'boolean') fail(label, `"${key}" must be a boolean`);
  return value;
}

function arrayField(source: Record<string, unknown>, key: string, label: string): unknown[] {
  const value = field(source, key, label);
  if (!Array.isArray(value)) fail(label, `"${key}" must be an array`);
  return value;
}

function parsePlatform(raw: unknown, label: string): PlatformStatus {
  const source = record(raw, label);
  const status = stringField(source, 'status', label);
  if (status !== 'AVAILABLE' && status !== 'UNAVAILABLE' && status !== 'UNKNOWN') {
    fail(label, `unknown platform status "${status}"`);
  }
  return {
    status,
    reason: nullableStringField(source, 'reason', label),
    updatedAt: (() => {
      const value = field(source, 'updatedAt', label);
      if (value === null) return null;
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        fail(label, '"updatedAt" must be a number or null');
      }
      return value;
    })(),
  };
}

function parseTerms(raw: unknown, label: string): ChallengeTerms {
  const source = record(raw, label);
  return {
    assetId: stringField(source, 'assetId', label),
    entryAtomic: stringField(source, 'entryAtomic', label),
    prizeAtomic: stringField(source, 'prizeAtomic', label),
    termsVersion: stringField(source, 'termsVersion', label),
  };
}

function parseParticipant(raw: unknown, label: string): RoomParticipant {
  const source = record(raw, label);
  const kind = stringField(source, 'kind', label);
  if (kind !== 'HUMAN' && kind !== 'AGENT') fail(label, `unknown participant kind "${kind}"`);
  const seatValue = field(source, 'seat', label);
  if (seatValue !== null && (!Number.isInteger(seatValue) || (seatValue as number) < 0 || (seatValue as number) > 9)) {
    fail(label, '"seat" must be an integer 0..9 or null');
  }
  return {
    id: stringField(source, 'id', label),
    kind,
    name: stringField(source, 'name', label),
    address: nullableStringField(source, 'address', label),
    agentId: nullableStringField(source, 'agentId', label),
    agentModel: nullableStringField(source, 'agentModel', label),
    pokerPrincipalId: stringField(source, 'pokerPrincipalId', label),
    seat: seatValue as number | null,
    joinedAt: numberField(source, 'joinedAt', label),
  };
}

function parseResult(raw: unknown, label: string): RoomResult {
  const source = record(raw, label);
  const kind = stringField(source, 'kind', label);
  if (kind !== 'HUMAN' && kind !== 'AGENT') fail(label, `unknown result kind "${kind}"`);
  return {
    participantId: stringField(source, 'participantId', label),
    name: stringField(source, 'name', label),
    kind,
    finishPosition: integerField(source, 'finishPosition', label),
  };
}

function parseFinance(raw: unknown, label: string): RoomFinance | null {
  if (raw === null) return null;
  const source = record(raw, label);
  return {
    assetId: stringField(source, 'assetId', label),
    entryAtomic: stringField(source, 'entryAtomic', label),
    prizeAtomic: stringField(source, 'prizeAtomic', label),
    termsVersion: stringField(source, 'termsVersion', label),
  };
}

function parseRoom(raw: unknown, label: string): RoomDetail {
  const source = record(raw, label);
  const mode = stringField(source, 'mode', label);
  if (mode !== 'SPONSORED' && mode !== 'CHALLENGE') fail(label, `unknown room mode "${mode}"`);
  const status = stringField(source, 'status', label);
  if (!['DRAFT', 'WAITING_FOR_ROSTER', 'PROVISIONING', 'ACTIVE', 'COMPLETE', 'FAILED'].includes(status)) {
    fail(label, `unknown room status "${status}"`);
  }
  return {
    id: stringField(source, 'id', label),
    name: stringField(source, 'name', label),
    mode,
    status: status as RoomStatus,
    pokerTableId: nullableStringField(source, 'pokerTableId', label),
    pokerCompetitionId: nullableStringField(source, 'pokerCompetitionId', label),
    humanCount: integerField(source, 'humanCount', label),
    agentCount: integerField(source, 'agentCount', label),
    totalSeats: integerField(source, 'totalSeats', label),
    createdAt: numberField(source, 'createdAt', label),
    updatedAt: numberField(source, 'updatedAt', label),
    participants: arrayField(source, 'participants', label).map((entry, index) =>
      parseParticipant(entry, `${label}.participants[${index}]`)
    ),
    finance: parseFinance(field(source, 'finance', label), `${label}.finance`),
    results:
      field(source, 'results', label) === null
        ? null
        : arrayField(source, 'results', label).map((entry, index) =>
            parseResult(entry, `${label}.results[${index}]`)
          ),
    failureReason: nullableStringField(source, 'failureReason', label),
  };
}

function parseModelMetric(raw: unknown, label: string): ModelMetricView {
  const source = record(raw, label);
  return {
    agentId: stringField(source, 'agentId', label),
    games: integerField(source, 'games', label),
    wins: integerField(source, 'wins', label),
    calls: integerField(source, 'calls', label),
    inputTokens: integerField(source, 'inputTokens', label),
    outputTokens: integerField(source, 'outputTokens', label),
    costUsdMicro: integerField(source, 'costUsdMicro', label),
    latencyMs: integerField(source, 'latencyMs', label),
  };
}

/** A room is live over the socket only while ACTIVE. */
export function roomIsLive(status: RoomStatus): boolean {
  return status === 'ACTIVE';
}

/** Terminal rooms keep chat and replay readable over HTTP only. */
export function roomIsTerminal(status: RoomStatus): boolean {
  return status === 'COMPLETE' || status === 'FAILED';
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class ProductApi {
  private token: string | null = null;

  constructor(private readonly baseUrl = '') {}

  /** Attach (or clear) the opaque PokerTools bearer token. */
  setToken(token: string | null): void {
    this.token = token;
  }

  async getConfig(): Promise<ProductConfig> {
    const payload = await this.request<unknown>('GET', '/api/config');
    const source = record(payload, 'config');
    const challenge = record(field(source, 'challenge', 'config'), 'config.challenge');
    const enabled = booleanField(challenge, 'enabled', 'config.challenge');
    const termsValue = field(challenge, 'terms', 'config.challenge');
    if (enabled && termsValue === null) fail('config.challenge', '"terms" is required while enabled');
    return {
      pokerApiUrl: stringField(source, 'pokerApiUrl', 'config').replace(/\/+$/, ''),
      platform: parsePlatform(field(source, 'platform', 'config'), 'config.platform'),
      challenge: {
        enabled,
        terms: termsValue === null ? null : parseTerms(termsValue, 'config.challenge.terms'),
      },
    };
  }

  async getAgents(): Promise<AgentSummary[]> {
    const payload = await this.request<unknown>('GET', '/api/agents');
    const source = record(payload, 'agents');
    return arrayField(source, 'agents', 'agents').map((entry, index): AgentSummary => {
      const label = `agents[${index}]`;
      const agent = record(entry, label);
      const provider = field(agent, 'provider', label);
      if (provider !== null && typeof provider !== 'string') fail(label, '"provider" must be a string');
      return {
        id: stringField(agent, 'id', label),
        name: stringField(agent, 'name', label),
        model: stringField(agent, 'model', label),
        provider: provider as string | null,
        available: booleanField(agent, 'available', label),
      };
    });
  }

  async getRooms(): Promise<RoomDetail[]> {
    const payload = await this.request<unknown>('GET', '/api/rooms');
    const source = record(payload, 'rooms');
    return arrayField(source, 'rooms', 'rooms').map((entry, index) =>
      parseRoom(entry, `rooms[${index}]`)
    );
  }

  async getRoom(roomId: string): Promise<RoomDetail> {
    const payload = await this.request<unknown>('GET', `/api/rooms/${encodeURIComponent(roomId)}`);
    return this.roomEnvelope(payload, 'room');
  }

  async createRoom(request: CreateRoomRequest): Promise<RoomDetail> {
    const payload = await this.request<unknown>('POST', '/api/rooms', request);
    return this.roomEnvelope(payload, 'created room');
  }

  async joinRoom(roomId: string): Promise<RoomDetail> {
    const payload = await this.request<unknown>('POST', `/api/rooms/${encodeURIComponent(roomId)}/join`);
    return this.roomEnvelope(payload, 'joined room');
  }

  async startRoom(roomId: string): Promise<RoomDetail> {
    const payload = await this.request<unknown>('POST', `/api/rooms/${encodeURIComponent(roomId)}/start`);
    return this.roomEnvelope(payload, 'started room');
  }

  async getStats(): Promise<ProductStats> {
    const payload = await this.request<unknown>('GET', '/api/stats');
    const source = record(payload, 'stats');
    const rooms = record(field(source, 'rooms', 'stats'), 'stats.rooms');
    const games = record(field(source, 'games', 'stats'), 'stats.games');
    return {
      platform: parsePlatform(field(source, 'platform', 'stats'), 'stats.platform'),
      rooms: {
        total: integerField(rooms, 'total', 'stats.rooms'),
        open: integerField(rooms, 'open', 'stats.rooms'),
        running: integerField(rooms, 'running', 'stats.rooms'),
        finished: integerField(rooms, 'finished', 'stats.rooms'),
      },
      games: {
        total: integerField(games, 'total', 'stats.games'),
        running: integerField(games, 'running', 'stats.games'),
        finished: integerField(games, 'finished', 'stats.games'),
      },
      humans: integerField(source, 'humans', 'stats'),
      agents: integerField(source, 'agents', 'stats'),
      models: arrayField(source, 'models', 'stats').map((entry, index) =>
        parseModelMetric(entry, `stats.models[${index}]`)
      ),
    };
  }

  private roomEnvelope(payload: unknown, label: string): RoomDetail {
    const source = record(payload, label);
    return parseRoom(field(source, 'room', label), `${label}.room`);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.token) headers.Authorization = `Bearer ${this.token}`;

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new ProductApiError(
        `Network error calling ${path}: ${error instanceof Error ? error.message : String(error)}`,
        0
      );
    }

    const text = await response.text();
    let parsed: unknown = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }

    if (!response.ok) {
      const source =
        typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null;
      const message =
        (source && typeof source.message === 'string' && source.message) ||
        (source && typeof source.error === 'string' && source.error) ||
        `HTTP ${response.status} from ${path}`;
      const code = source && typeof source.code === 'string' ? source.code : null;
      throw new ProductApiError(message, response.status, code);
    }

    return parsed as T;
  }
}

// ---------------------------------------------------------------------------
// Client-side creation rules (the server remains authoritative)
// ---------------------------------------------------------------------------

/**
 * Enforce the product's creation rules before sending a request. Returns a
 * human-readable problem, or null when the request satisfies the contract.
 */
export function validateCreateRoom(request: CreateRoomRequest): string | null {
  const name = request.name.trim();
  if (name.length === 0) return 'Enter a room name.';
  if (name.length > 60) return 'Room names are limited to 60 characters.';
  if (!Number.isInteger(request.humanCount) || request.humanCount < 0 || request.humanCount > 10) {
    return 'Human count must be an integer in 0..10.';
  }
  if (request.agentIds.length !== new Set(request.agentIds).size) {
    return 'Each agent can only be selected once.';
  }
  const total = request.humanCount + request.agentIds.length;

  if (request.mode === 'CHALLENGE') {
    if (request.humanCount !== 1) return 'Challenge rooms require exactly one human.';
    if (request.agentIds.length < 1 || request.agentIds.length > 9) {
      return 'Challenge rooms require 1–9 agents.';
    }
    if (total > 10) return 'A table seats at most 10 participants.';
    const finance = request.finance;
    if (!finance || finance.assetId.length === 0) {
      return 'Choose the configured settlement asset for the challenge entry and prize.';
    }
    if (finance.entryAtomic.length === 0 || finance.prizeAtomic.length === 0) {
      return 'The selected asset has no server-configured entry/prize terms.';
    }
    if (finance.optIn !== true) {
      return 'Opt in to the entry and prize terms before creating a challenge.';
    }
    return null;
  }

  if (request.finance) return 'Sponsored rooms never carry entry or prize terms.';
  if (request.humanCount < 1) return 'The creating wallet must claim a human seat.';
  if (total < 2) return 'Sponsored rooms require at least 2 participants.';
  if (total > 10) return 'Sponsored rooms are limited to 10 participants.';
  return null;
}
