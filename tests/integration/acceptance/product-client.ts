/**
 * Minimal typed client for the NLHE product `/api/*` surface.
 *
 * Identity is always an opaque PokerTools bearer (wallet session or SERVICE
 * credential) or the product admin token; the client never fabricates either.
 */
export interface ProductClientOptions {
  adminToken?: string;
}

export class ProductApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body: unknown,
    /** Parsed `retry-after` response header, if the server sent one. */
    readonly retryAfterMs: number | null = null
  ) {
    super(message);
    this.name = 'ProductApiError';
  }
}

/**
 * Parse an HTTP `retry-after` value into milliseconds. Accepts delay-seconds
 * and HTTP-date forms; returns null when the header is absent or invalid.
 */
export function parseRetryAfterHeader(value: string | null): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10) * 1000;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - Date.now());
}

export interface ProductRoomView {
  id: string;
  name: string;
  mode: 'SPONSORED' | 'CHALLENGE';
  status: 'DRAFT' | 'WAITING_FOR_ROSTER' | 'PROVISIONING' | 'ACTIVE' | 'COMPLETE' | 'FAILED';
  pokerTableId: string | null;
  pokerCompetitionId: string | null;
  humanCount: number;
  agentCount: number;
  totalSeats: number;
  participants: Array<{
    id: string;
    kind: 'HUMAN' | 'AGENT';
    name: string;
    address: string | null;
    agentId: string | null;
    agentModel: string | null;
    pokerPrincipalId: string;
    seat: number | null;
    joinedAt: number;
  }>;
  finance: { assetId: string; entryAtomic: string; prizeAtomic: string; termsVersion: string } | null;
  results: Array<{ participantId: string; name: string; kind: 'HUMAN' | 'AGENT'; finishPosition: number }> | null;
  failureReason: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ProductStatsView {
  platform: { status: string; reason: string | null; updatedAt: number | null };
  rooms: { total: number; open: number; running: number; finished: number };
  games: { total: number; running: number; finished: number };
  humans: number;
  agents: number;
  models: Array<{
    agentId: string;
    games: number;
    wins: number;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    costUsdMicro: number;
    latencyMs: number;
  }>;
}

export interface CreateProductRoomRequest {
  name: string;
  mode: 'SPONSORED' | 'CHALLENGE';
  humanCount: number;
  agentIds: string[];
  finance?: {
    assetId: string;
    entryAtomic: string;
    prizeAtomic: string;
    optIn: true;
  } | null;
}

export class ProductClient {
  private readonly baseUrl: string;
  private readonly adminToken: string | null;

  constructor(baseUrl: string, options: ProductClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.adminToken = options.adminToken ?? null;
  }

  private async request<T>(
    method: string,
    path: string,
    options: { body?: unknown; walletToken?: string; admin?: boolean } = {}
  ): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (options.walletToken) headers.authorization = `Bearer ${options.walletToken}`;
    if (options.admin) {
      if (!this.adminToken) throw new Error('product admin token is not configured');
      headers['x-product-admin-token'] = this.adminToken;
    }
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let payload: unknown = null;
    try {
      payload = text === '' ? null : JSON.parse(text);
    } catch {
      payload = text;
    }
    if (!response.ok) {
      const record = (payload ?? {}) as { error?: unknown; code?: unknown; message?: unknown };
      throw new ProductApiError(
        response.status,
        typeof record.code === 'string' ? record.code : typeof record.error === 'string' ? record.error : `HTTP_${response.status}`,
        typeof record.message === 'string' ? record.message : `HTTP ${response.status}`,
        payload,
        parseRetryAfterHeader(response.headers.get('retry-after'))
      );
    }
    return payload as T;
  }

  getConfig(): Promise<Record<string, unknown>> {
    return this.request('GET', '/api/config');
  }

  getAgents(): Promise<{ agents: Array<{ id: string; name: string; available: boolean }> }> {
    return this.request('GET', '/api/agents');
  }

  getRooms(): Promise<{ rooms: ProductRoomView[] }> {
    return this.request('GET', '/api/rooms');
  }

  async getRoom(roomId: string): Promise<ProductRoomView> {
    const payload = await this.request<{ room: ProductRoomView }>('GET', `/api/rooms/${roomId}`);
    return payload.room;
  }

  async createRoom(
    body: CreateProductRoomRequest,
    options: { walletToken?: string; admin?: boolean }
  ): Promise<ProductRoomView> {
    const payload = await this.request<{ room: ProductRoomView }>('POST', '/api/rooms', { body, ...options });
    return payload.room;
  }

  async joinRoom(roomId: string, walletToken: string): Promise<ProductRoomView> {
    const payload = await this.request<{ room: ProductRoomView }>(
      'POST',
      `/api/rooms/${roomId}/join`,
      { walletToken }
    );
    return payload.room;
  }

  async startRoom(
    roomId: string,
    options: { walletToken?: string; admin?: boolean }
  ): Promise<ProductRoomView> {
    const payload = await this.request<{ room: ProductRoomView }>(
      'POST',
      `/api/rooms/${roomId}/start`,
      options
    );
    return payload.room;
  }

  async cancelRoom(roomId: string): Promise<ProductRoomView> {
    const payload = await this.request<{ room: ProductRoomView }>(
      'POST', `/api/rooms/${roomId}/cancel`, { admin: true },
    );
    return payload.room;
  }

  getStats(): Promise<ProductStatsView> {
    return this.request('GET', '/api/stats');
  }

  getAudit(roomId: string): Promise<Record<string, unknown>> {
    return this.request('GET', `/api/audit/rooms/${roomId}`, { admin: true });
  }
}
