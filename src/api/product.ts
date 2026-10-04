/**
 * Product HTTP API (`/api/*`).
 *
 * This plugin is the product contract consumed by the same-origin web client:
 * configuration, the agent catalog, room listing/creation, authenticated
 * membership and room start, statistics and operator-only audit.
 *
 * Identity comes exclusively from the opaque PokerTools bearer token, resolved
 * with the public SDK `getPrincipal()` (never a local session and never a
 * client-supplied principal). State-changing requests additionally verify the
 * `Origin` header against `PUBLIC_ORIGIN` when a browser sends one. The
 * operator audit surface requires the constant-time `x-product-admin-token`.
 *
 * The plugin owns no platform transport: every platform operation goes through
 * `ProductRooms`, whose narrow interfaces are adapted to the public SDK in
 * `src/main.ts`.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Principal } from '@pokertools/types';
import { z } from 'zod';

import type { Config } from '../config.js';
import type { AgentCatalog } from '../product/catalog.js';
import {
  ProductRoomError,
  type HumanActor,
  type ProductRoomErrorCode,
  type RoomActor,
  type RoomView,
} from '../product/rooms.js';
import type { ProductRooms } from '../product/rooms.js';

/** Resolve an opaque bearer token to the canonical public principal. */
export interface PrincipalResolver {
  getPrincipal(token: string): Promise<Principal>;
}

export interface ProductApiOptions {
  readonly config: Config;
  readonly agents: AgentCatalog;
  readonly rooms: ProductRooms;
  readonly getPrincipal: (token: string) => Promise<Principal>;
  /** Trusted browser origin for write requests. */
  readonly publicOrigin?: string;
  /** Operator credential; absent disables every admin-only route. */
  readonly adminToken?: string | null;
  /** Whether an agent currently has usable provider credentials. */
  readonly agentAvailable?: (agentId: string) => boolean;
}

const CREATE_ROOM_FINANCE = z.strictObject({
  assetId: z.string().min(1).max(200),
  entryAtomic: z.string().regex(/^[1-9][0-9]*$/, 'must be a positive atomic amount'),
  prizeAtomic: z.string().regex(/^[1-9][0-9]*$/, 'must be a positive atomic amount'),
  optIn: z.literal(true),
});

const CREATE_ROOM_BODY = z.strictObject({
  name: z.string().min(1).max(60),
  mode: z.enum(['SPONSORED', 'CHALLENGE']),
  humanCount: z.number().int().min(0).max(10),
  agentIds: z.array(z.string().min(1).max(80)).max(10).default([]),
  finance: CREATE_ROOM_FINANCE.nullish(),
});

const ERROR_STATUS: Record<ProductRoomErrorCode, number> = {
  INVALID_REQUEST: 400,
  CHALLENGE_DISABLED: 403,
  TERMS_MISMATCH: 400,
  NOT_AUTHORIZED: 403,
  ROOM_NOT_FOUND: 404,
  ROOM_STATE: 409,
  ROOM_FULL: 409,
  ROSTER_INCOMPLETE: 409,
  AGENT_NOT_AVAILABLE: 409,
  PLATFORM_UNAVAILABLE: 503,
  PLATFORM_REJECTED: 502,
};

function fail(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
  return reply.code(status).send({ error: code, code, message });
}

function readBearer(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

/** Constant-time comparison of the operator credential. */
function adminAuthorized(request: FastifyRequest, expected: string | null | undefined): boolean {
  if (expected === undefined || expected === null || expected.length === 0) return false;
  const provided = request.headers['x-product-admin-token'];
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const providedHash = createHash('sha256').update(provided).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(providedHash, expectedHash);
}

/**
 * Verify browser origin for a state-changing request. A missing Origin is a
 * non-browser client and is allowed; when a browser sends one it must match
 * the configured public origin exactly.
 */
function originAllowed(request: FastifyRequest, publicOrigin: string | undefined): boolean {
  const header = request.headers.origin;
  if (header === undefined || header === '') return true;
  if (publicOrigin === undefined) return false;
  try {
    return new URL(header).origin === new URL(publicOrigin).origin;
  } catch {
    return false;
  }
}

function sendError(request: FastifyRequest, reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof ProductRoomError) {
    return fail(reply, ERROR_STATUS[error.code], error.code, error.message);
  }
  request.log.error({ errorType: error instanceof Error ? error.name : 'unknown' }, 'product api error');
  return fail(reply, 500, 'INTERNAL_ERROR', 'internal product error');
}

export async function registerProductApi(
  app: FastifyInstance,
  options: ProductApiOptions,
): Promise<void> {
  const { config, agents, rooms } = options;
  const agentAvailable = options.agentAvailable ?? ((agentId: string) => agents.get(agentId).enabled);

  const authenticate = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Principal | undefined> => {
    const token = readBearer(request);
    if (token === null) {
      fail(reply, 401, 'NOT_AUTHORIZED', 'a PokerTools bearer token is required');
      return undefined;
    }
    let principal: Principal;
    try {
      principal = await options.getPrincipal(token);
    } catch {
      fail(reply, 401, 'NOT_AUTHORIZED', 'the PokerTools session is not valid');
      return undefined;
    }
    if (principal.kind !== 'WALLET') {
      fail(reply, 403, 'NOT_AUTHORIZED', 'a wallet session is required for this action');
      return undefined;
    }
    return principal;
  };

  const guardWrite = (request: FastifyRequest, reply: FastifyReply): boolean => {
    if (originAllowed(request, options.publicOrigin)) return true;
    fail(reply, 403, 'ORIGIN_FORBIDDEN', 'origin is not the configured public origin');
    return false;
  };

  // -------------------------------------------------------------------------
  // Configuration and catalog
  // -------------------------------------------------------------------------

  app.get('/api/config', async () => {
    const terms = rooms.challengeTerms();
    return {
      pokerApiUrl: config.POKERTOOLS_API_URL,
      platform: rooms.cachedPlatformStatus(),
      // Challenge availability is service configuration only. Settlement asset
      // metadata (symbol, decimals, balances) is read by the authenticated
      // browser through the public SDK finance API; this route carries terms
      // only and never a placeholder asset list.
      challenge: {
        enabled: terms !== null,
        terms:
          terms === null
            ? null
            : {
                assetId: terms.assetId,
                entryAtomic: terms.entryAtomic,
                prizeAtomic: terms.prizeAtomic,
                termsVersion: terms.termsVersion,
              },
      },
    };
  });

  app.get('/api/agents', async () => ({
    agents: agents.list().map((agent) => ({
      id: agent.id,
      name: agent.name,
      model: agent.model,
      provider: agent.provider,
      available: agent.enabled && agentAvailable(agent.id),
    })),
  }));

  // -------------------------------------------------------------------------
  // Rooms
  // -------------------------------------------------------------------------

  app.get('/api/rooms', async () => ({ rooms: rooms.list() }));

  app.get<{ Params: { id: string } }>('/api/rooms/:id', async (request, reply) => {
    try {
      return { room: rooms.get(request.params.id) };
    } catch (error) {
      return sendError(request, reply, error);
    }
  });

  app.post('/api/rooms', async (request, reply) => {
    if (!guardWrite(request, reply)) return reply;
    const body = CREATE_ROOM_BODY.safeParse(request.body);
    if (!body.success) {
      const issue = body.error.issues[0];
      const path = issue?.path.length ? ` (${issue.path.map(String).join('.')})` : '';
      return fail(reply, 400, 'INVALID_REQUEST', `${issue?.message ?? 'invalid request'}${path}`);
    }

    const admin = adminAuthorized(request, options.adminToken);
    let creator: HumanActor | null = null;
    if (readBearer(request) !== null) {
      const principal = await authenticate(request, reply);
      if (principal === undefined) return reply;
      creator = {
        principalId: principal.id,
        walletAddress: principal.walletAddress,
      };
    }
    if (creator === null && !admin) {
      return fail(
        reply,
        401,
        'NOT_AUTHORIZED',
        'creating a room requires a wallet session or the product admin credential',
      );
    }

    try {
      const room = rooms.create({
        name: body.data.name,
        mode: body.data.mode,
        humanCount: body.data.humanCount,
        agentIds: body.data.agentIds,
        finance: body.data.finance ?? null,
        creator,
        admin,
      });
      return reply.code(200).send({ room });
    } catch (error) {
      return sendError(request, reply, error);
    }
  });

  app.post<{ Params: { id: string } }>('/api/rooms/:id/join', async (request, reply) => {
    if (!guardWrite(request, reply)) return reply;
    const principal = await authenticate(request, reply);
    if (principal === undefined) return reply;
    try {
      const room = rooms.join(request.params.id, {
        principalId: principal.id,
        walletAddress: principal.walletAddress,
      });
      return { room };
    } catch (error) {
      return sendError(request, reply, error);
    }
  });

  app.post<{ Params: { id: string } }>('/api/rooms/:id/leave', async (request, reply) => {
    if (!guardWrite(request, reply)) return reply;
    const principal = await authenticate(request, reply);
    if (principal === undefined) return reply;
    try {
      return { room: rooms.leave(request.params.id, principal.id) };
    } catch (error) {
      return sendError(request, reply, error);
    }
  });

  app.post<{ Params: { id: string } }>('/api/rooms/:id/start', async (request, reply) => {
    if (!guardWrite(request, reply)) return reply;
    const admin = adminAuthorized(request, options.adminToken);
    let actor: RoomActor;
    if (readBearer(request) !== null) {
      const principal = await authenticate(request, reply);
      if (principal === undefined) return reply;
      actor = {
        principalId: principal.id,
        admin,
      };
    } else if (admin) {
      actor = { principalId: null, admin: true };
    } else {
      return fail(
        reply,
        401,
        'NOT_AUTHORIZED',
        'starting a room requires a wallet session or the product admin credential',
      );
    }
    try {
      return { room: await rooms.start(request.params.id, actor) };
    } catch (error) {
      return sendError(request, reply, error);
    }
  });

  // Operator recovery for abandoned pre-start rooms, including paid entries.
  app.post<{ Params: { id: string } }>('/api/rooms/:id/cancel', async (request, reply) => {
    if (!guardWrite(request, reply)) return reply;
    if (!adminAuthorized(request, options.adminToken)) {
      return fail(reply, 403, 'NOT_AUTHORIZED', 'the product admin credential is required');
    }
    try {
      return { room: await rooms.cancel(request.params.id, { principalId: null, admin: true }) };
    } catch (error) {
      return sendError(request, reply, error);
    }
  });

  // -------------------------------------------------------------------------
  // Statistics and operator audit
  // -------------------------------------------------------------------------

  app.get('/api/stats', async () => rooms.stats());

  app.get<{ Params: { id: string } }>('/api/audit/rooms/:id', async (request, reply) => {
    if (!adminAuthorized(request, options.adminToken)) {
      return fail(reply, 403, 'NOT_AUTHORIZED', 'the product admin credential is required');
    }
    try {
      return rooms.auditRoom(request.params.id);
    } catch (error) {
      return sendError(request, reply, error);
    }
  });
}

/** Convenience type for consumers that only need the room payload shape. */
export type ProductRoomPayload = { room: RoomView };
