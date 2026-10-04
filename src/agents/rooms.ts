/**
 * Product room runtime glue for the durable agent runtime.
 *
 * This module owns the SDK-side composition that `src/main.ts` used to carry:
 * per-room/per-agent `AgentRuntime` construction, the exact runtime
 * configuration derived from product startup config and room state, the
 * in-memory table-scoped credential lifecycle, and terminal recorded-only
 * recovery. It deliberately contains no HTTP routes, store schema or platform
 * authority: poker truth stays in the platform SDK and the durable decision
 * store.
 *
 * One `AgentRuntime` is created per room/agent pair over that agent's own
 * authenticated `SdkAgentTransport`; a shared limiter bounds platform
 * concurrency across every runtime, and the `ProductStore` itself is the
 * decision port (aggregate room reservations, immutable attempts and the
 * write-once speech intention all live there). Only a competition-issued,
 * table-scoped agent credential is used — there is no configured global-token
 * fallback — and issued tokens are kept in memory only.
 */
import type { Config } from '../config.js';
import type { AgentCatalog, AgentConfig } from '../product/catalog.js';
import type { ProductRoom, ProductStore } from '../product/store.js';
import type { RoomRuntime } from '../product/rooms.js';
import {
  type AgentRuntimeConfig,
  type AgentRuntimeDependencies,
} from './contracts.js';
import { DecisionConcurrencyLimiter } from './limiter.js';
import { AgentRuntime, createProductDecisionProviderFactory } from './runtime.js';
import { SdkAgentTransport } from './sdk-transport.js';

interface ManagedRoomRuntime extends RoomRuntime {
  stop(): Promise<void>;
}

/** Minimal runtime handle owned by the composition root. */
export interface AgentRuntimeHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
  /**
   * Terminal-close hook: records abandoned PENDING attempts before stopping.
   * Present on the real `AgentRuntime`; optional for test seams.
   */
  closeAbandonedAttempts?(): void;
}

export interface RoomRuntimeDependencies {
  readonly config: Config;
  readonly store: ProductStore;
  readonly agents: AgentCatalog;
  readonly platformUrl: string;
  readonly knownSecrets: readonly string[];
  readonly issueCredentials: (
    roomId: string,
  ) => Promise<Array<{ agentId: string; token: string }>>;
  readonly log: (event: { event: string; detail?: string }) => void;
  /**
   * Composition/test seam: constructs the durable runtime from the exact
   * config and dependencies. Defaults to the real `AgentRuntime`.
   */
  readonly createRuntime?: (
    config: AgentRuntimeConfig,
    deps: AgentRuntimeDependencies,
  ) => AgentRuntimeHandle;
}

/**
 * Pure runtime configuration for one room/agent pair. Speech is enabled only
 * when the validated product configuration approves agent chat
 * (`AGENT_CHAT_ENABLED=1`); the store's write-once speech intention then gates
 * each message after an accepted commit.
 */
export function buildAgentRuntimeConfig(
  config: Config,
  agent: AgentConfig,
  room: ProductRoom,
  agentPrincipalIds: readonly string[],
  options: { recordedOnly?: boolean; providerCallsEnabled?: boolean } = {},
): AgentRuntimeConfig {
  if (room.tableId === null) {
    throw new Error('agent runtime requires an active platform table');
  }
  const recordedOnly = options.recordedOnly === true;
  const providerCallsEnabled = recordedOnly ? false : options.providerCallsEnabled ?? true;
  return {
    agentId: agent.id,
    principalId: agent.principalId,
    promptPolicyId: agent.promptPolicyId,
    promptPolicyHash: agent.promptPolicyHash,
    rooms: [
      {
        roomId: room.id,
        tableId: room.tableId,
        agentPrincipalIds,
        maxHands: config.MAX_HANDS,
        maxCalls: config.MAX_PROVIDER_CALLS,
        // Zero is a real fail-closed spend cap: zero-priced calls settle at
        // 0 and pass; any billable cost is rejected by the runtime.
        maxCostMicroUsd: config.MAX_COST_USD_MICRO,
      },
    ],
    perCallTimeoutMs: config.PER_CALL_TIMEOUT_MS,
    // New provider HTTP is disabled for recorded-only recovery and while the
    // provider key is missing; recorded attempts still resolve and replay.
    providerCallsEnabled,
    // The absolute deadline is anchored to the activation timestamp
    // (`updatedAt` is written once when the room becomes ACTIVE and is not
    // updated again while ACTIVE), so the run window survives process
    // restarts and is never reset by a later `start()`. Recorded-only
    // recovery passes no fabricated sentinel deadline at all.
    overallDeadlineAtMs: recordedOnly ? null : room.updatedAt + config.OVERALL_RUNTIME_MS,
    overallRuntimeMs: recordedOnly ? null : config.OVERALL_RUNTIME_MS,
    maxConcurrency: config.MAX_PROVIDER_CONCURRENCY,
    speech: config.AGENT_CHAT_ENABLED === '1' ? 'AFTER_COMMIT' : 'OFF',
  };
}

/** Extra lifetime beyond the runtime's overall budget for issued credentials. */
export const CREDENTIAL_EXPIRY_MARGIN_MS = 60_000;

export class SdkRoomRuntime implements ManagedRoomRuntime {
  private readonly limiter: DecisionConcurrencyLimiter;
  private readonly createRuntime: NonNullable<RoomRuntimeDependencies['createRuntime']>;
  private readonly sessions = new Map<string, AgentRuntimeHandle[]>();
  private readonly attachedAgents = new Map<string, Set<string>>();
  private readonly attachments = new Map<string, Promise<void>>();
  private readonly roomCredentials = new Map<string, Map<string, string>>();
  private stopping = false;

  constructor(private readonly deps: RoomRuntimeDependencies) {
    this.limiter = new DecisionConcurrencyLimiter(deps.config.MAX_PROVIDER_CONCURRENCY);
    this.createRuntime =
      deps.createRuntime ??
      ((config, dependencies) => new AgentRuntime(config, dependencies));
  }

  attach(room: ProductRoom): Promise<void> {
    if (room.tableId === null || this.stopping) return Promise.resolve();
    const existing = this.attachments.get(room.id);
    if (existing !== undefined) return existing;
    const work = this.attachMissing(room);
    this.attachments.set(room.id, work);
    void work.finally(() => {
      if (this.attachments.get(room.id) === work) this.attachments.delete(room.id);
    }).catch(() => undefined);
    return work;
  }

  private async attachMissing(room: ProductRoom): Promise<void> {
    const participants = this.deps.store
      .listParticipants(room.id)
      .filter((participant) => participant.kind === 'AGENT' && participant.agentId !== null);
    if (participants.length === 0) return;
    const agentPrincipalIds = participants.map((participant) => participant.principalId);
    const runtimes = this.sessions.get(room.id) ?? [];
    const attached = this.attachedAgents.get(room.id) ?? new Set<string>();
    this.sessions.set(room.id, runtimes);
    this.attachedAgents.set(room.id, attached);
    for (const participant of participants) {
      if (this.stopping) break;
      if (attached.has(participant.agentId!)) continue;
      const runtime = await this.startAgent(room, participant.agentId!, agentPrincipalIds);
      if (runtime === null) continue;
      if (this.stopping) {
        await runtime.stop().catch(() => undefined);
        break;
      }
      runtimes.push(runtime);
      attached.add(participant.agentId!);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await Promise.allSettled([...this.attachments.values()]);
    await Promise.all([...this.sessions.keys()].map((roomId) => this.stopRoom(roomId)));
  }

  /**
   * Stop every runtime attached to a room and drop the room's in-memory
   * credentials WITHOUT closing PENDING attempts: a non-terminal process stop
   * leaves durable rows for restart recovery. Safe to call repeatedly.
   */
  private async stopRoom(roomId: string): Promise<void> {
    const runtimes = this.sessions.get(roomId) ?? [];
    this.sessions.delete(roomId);
    this.attachedAgents.delete(roomId);
    this.roomCredentials.delete(roomId);
    await Promise.all(runtimes.map((runtime) => runtime.stop().catch(() => undefined)));
  }

  /**
   * Stop every runtime attached to a room and drop the room's in-memory
   * credentials. Called by `ProductRooms` when the room reaches a terminal
   * state: each runtime first records its abandoned PENDING attempts as FAILED
   * `runtime_stopped`, so a terminal room never leaves unrecorded evidence.
   * Safe to call repeatedly.
   */
  async detach(roomId: string): Promise<void> {
    await this.attachments.get(roomId)?.catch(() => undefined);
    const runtimes = this.sessions.get(roomId) ?? [];
    this.sessions.delete(roomId);
    this.attachedAgents.delete(roomId);
    this.roomCredentials.delete(roomId);
    await Promise.all(
      runtimes.map(async (runtime) => {
        try {
          runtime.closeAbandonedAttempts?.();
        } catch {
          this.deps.log({ event: 'runtime.close_abandoned_failed', detail: roomId });
        }
        await runtime.stop().catch(() => undefined);
      }),
    );
  }

  /** Composition/test visibility: agent runtimes currently attached to a room. */
  attachedAgentCount(roomId: string): number {
    return this.sessions.get(roomId)?.length ?? 0;
  }

  /**
   * Bounded recorded-only recovery for terminal rooms. Fresh table-scoped
   * credentials are issued for the durable SERVICE principals; each runtime
   * starts with new provider HTTP disabled, drains pending
   * PROVIDER_RECORDED/ACTION_SUBMITTED traces, then stops and drops the
   * credential immediately. No sentinel deadline is fabricated and no runtime
   * is retained.
   */
  async recoverRecorded(room: ProductRoom): Promise<void> {
    if (room.status !== 'COMPLETE' && room.status !== 'FAILED') return;
    if (room.tableId === null) return;
    const participants = this.deps.store
      .listParticipants(room.id)
      .filter((participant) => participant.kind === 'AGENT' && participant.agentId !== null);
    if (participants.length === 0) return;
    const agentPrincipalIds = participants.map((participant) => participant.principalId);
    for (const participant of participants) {
      const handle = await this.startAgent(room, participant.agentId!, agentPrincipalIds, {
        recordedOnly: true,
      });
      if (handle === null) continue;
      try {
        await handle.stop();
      } catch {
        this.deps.log({
          event: 'runtime.recorded_stop_failed',
          detail: `${participant.agentId}:${room.id}`,
        });
      }
    }
    this.roomCredentials.delete(room.id);
  }

  private async startAgent(
    room: ProductRoom,
    agentId: string,
    agentPrincipalIds: readonly string[],
    options: { recordedOnly?: boolean } = {},
  ): Promise<AgentRuntimeHandle | null> {
    if (this.stopping) return null;
    if (!this.deps.agents.has(agentId)) return null;
    const agent = this.deps.agents.get(agentId);
    const apiKey = process.env[agent.keyEnv];
    const providerKeyAvailable = typeof apiKey === 'string' && apiKey.length > 0;
    if (!providerKeyAvailable) {
      // Recorded-only: pending PROVIDER_RECORDED/ACTION_SUBMITTED receipts
      // still resolve and replay with no new provider HTTP. No model or
      // default-bot fallback exists.
      this.deps.log({ event: 'runtime.provider_credentials_missing', detail: agentId });
    }
    // Always issue a fresh narrow, table-scoped credential for the durable
    // SERVICE principal. There is deliberately no fallback to any configured
    // global agent token: if issuance is unavailable or the generic capability
    // is missing, the runtime fails closed. Issued tokens are kept in memory
    // only and never persisted.
    const token = await this.roomToken(room, agentId);
    if (this.stopping) return null;
    if (token === null) {
      this.deps.log({ event: 'runtime.credential_unavailable', detail: agentId });
      return null;
    }
    const transport = new SdkAgentTransport({
      baseUrl: this.deps.platformUrl,
      token,
      timeoutMs: this.deps.config.PER_CALL_TIMEOUT_MS,
    });
    const providerFactory = createProductDecisionProviderFactory({
      baseUrl: agent.baseUrl,
      model: agent.model,
      provider: agent.provider,
      ...(providerKeyAvailable ? { apiKey } : {}),
      inputUsdMicroPerMillionTokens: agent.pricing.inputMicroUsdPerMillionTokens,
      outputUsdMicroPerMillionTokens: agent.pricing.outputMicroUsdPerMillionTokens,
      knownSecrets: [...this.deps.knownSecrets, ...(providerKeyAvailable ? [apiKey] : []), token],
      includeEnvSecrets: false,
    });
    const runtime = this.createRuntime(
      buildAgentRuntimeConfig(this.deps.config, agent, room, agentPrincipalIds, {
        recordedOnly: options.recordedOnly === true,
        providerCallsEnabled: providerKeyAvailable,
      }),
      {
        transport,
        store: this.deps.store,
        providerFactory,
        limiter: this.limiter,
      },
    );
    try {
      await runtime.start();
    } catch {
      transport.close();
      this.deps.log({ event: 'runtime.attach_failed', detail: `${agentId}:${room.id}` });
      return null;
    }
    this.deps.log({ event: 'runtime.attached', detail: `${agentId}:${room.id}` });
    return runtime;
  }

  private async roomToken(room: ProductRoom, agentId: string): Promise<string | null> {
    let tokens = this.roomCredentials.get(room.id);
    if (tokens === undefined) {
      try {
        const issued = await this.deps.issueCredentials(room.id);
        tokens = new Map(issued.map((credential) => [credential.agentId, credential.token]));
        this.roomCredentials.set(room.id, tokens);
      } catch {
        this.deps.log({ event: 'runtime.credentials_unavailable', detail: room.id });
        return null;
      }
    }
    return tokens.get(agentId) ?? null;
  }
}
