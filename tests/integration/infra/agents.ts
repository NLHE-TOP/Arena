/**
 * Explicit-infrastructure platform principals for fake agents and the room
 * orchestrator, using the public service-principal lifecycle:
 *
 * - `provisionServicePrincipal` creates the durable SERVICE identity only (no
 *   credential, no ambient token);
 * - delegation to the orchestrator principal lets the orchestrator provision
 *   rosters and issue table-scoped agent credentials without any operator
 *   secret surviving in the product.
 */
import { randomUUID } from 'node:crypto';
import type { WalletSession } from './wallet.js';

export interface ProvisionedAgent {
  agentId: string;
  principalId: string;
}

export async function provisionFakeAgentPrincipals(
  admin: WalletSession,
  count: number,
  options: { delegatedToPrincipalId?: string } = {}
): Promise<ProvisionedAgent[]> {
  const agents: ProvisionedAgent[] = [];
  for (let index = 0; index < count; index += 1) {
    const agentId = `agent${index + 1}`;
    const provisioned = await admin.client.provisionServicePrincipal({
      name: `it-${agentId}-${randomUUID().slice(0, 8)}`,
      ...(options.delegatedToPrincipalId !== undefined
        ? { delegatedToPrincipalId: options.delegatedToPrincipalId }
        : {}),
    });
    agents.push({ agentId, principalId: provisioned.principalId });
  }
  return agents;
}

export interface OrchestrationToken {
  credentialId: string;
  principalId: string;
  token: string;
}

/**
 * Mint the room orchestrator credential (`competition:orchestrate`, exclusive).
 * It can create/start/settle competitions and issue table-scoped agent
 * credentials for principals delegated to it; it holds no table or finance
 * authority.
 */
export async function mintOrchestrationToken(admin: WalletSession): Promise<OrchestrationToken> {
  const created = await admin.client.createServiceCredential({
    name: `it-orchestrator-${randomUUID().slice(0, 8)}`,
    scopes: ['competition:orchestrate'],
  });
  return { credentialId: created.id, principalId: created.userId, token: created.token };
}

/** Random product admin token (>= 32 chars) for agent-only room operations. */
export function productAdminToken(): string {
  return `it-product-admin-${randomUUID()}-${randomUUID()}`;
}
