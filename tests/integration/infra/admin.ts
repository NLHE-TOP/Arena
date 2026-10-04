/**
 * Explicit operator infrastructure: ADMIN role bootstrap and canonical chip
 * grants. These are the only mutations outside the public SDK contract, and
 * they mirror the platform's own acceptance harness (ADMIN is an explicit
 * database role; chips are funded only by an operator grant).
 *
 * No poker/gameplay table is ever mutated here, and no NLHE product code path
 * depends on this module.
 */
import { GrantChipsRequestSchema, GrantChipsResponseSchema, type GrantChipsRequest } from '@pokertools/types';
import { psqlContainer, psqlUrl } from './docker.js';
import type { WalletSession } from './wallet.js';

export type AdminDatabaseTarget =
  | { kind: 'container'; container: string }
  | { kind: 'url'; databaseUrl: string };

export async function promoteWalletToAdmin(
  target: AdminDatabaseTarget,
  address: string
): Promise<{ promoted: boolean; affected: number }> {
  const normalized = address.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized)) throw new Error(`invalid wallet address: ${address}`);
  const sql = `UPDATE "User" SET "role" = 'ADMIN' WHERE "address" = '${normalized}'`;
  const output = target.kind === 'container' ? await psqlContainer(target.container, sql) : await psqlUrl(target.databaseUrl, sql);
  const affected = Number(/(\d+)$/.exec(output)?.[1] ?? 0);
  return { promoted: affected > 0, affected };
}

export interface ChipGrantResult {
  grantId: string;
  replayed: boolean;
  balanceAfter: string;
}

/**
 * Canonical operator chip grant through the public `/chips/grant` contract.
 *
 * The SDK does not (yet) ship a typed `grantChips` method; the request and
 * response are still validated against the shared strict schemas from
 * `@pokertools/types`, so this cannot drift from the public contract. When the
 * SDK gains the method, `grantChipsViaClient` below detects and uses it.
 */
export async function grantChips(
  platformBaseUrl: string,
  operatorToken: string,
  request: GrantChipsRequest
): Promise<ChipGrantResult> {
  const parsed = GrantChipsRequestSchema.parse(request);
  const response = await fetch(`${platformBaseUrl}/chips/grant`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorToken}` },
    body: JSON.stringify(parsed),
  });
  const payload = (await response.json().catch(() => ({}))) as unknown;
  if (!response.ok) {
    throw new Error(
      `chip grant failed HTTP ${response.status}: ${JSON.stringify(payload)}`
    );
  }
  const result = GrantChipsResponseSchema.parse(payload);
  return {
    grantId: result.grantId,
    replayed: result.replayed,
    balanceAfter: result.balanceAfter,
  };
}

/**
 * Prefer a future SDK `grantChips` method when present; fall back to the
 * canonical raw contract above. Capability detection is intentional: the SDK
 * extension is in progress, not assumed.
 */
export async function grantChipsViaClient(
  client: { grantChips?: (request: GrantChipsRequest) => Promise<unknown> },
  platformBaseUrl: string,
  operatorToken: string,
  request: GrantChipsRequest
): Promise<ChipGrantResult> {
  if (typeof client.grantChips === 'function') {
    const result = (await client.grantChips(request)) as Partial<ChipGrantResult>;
    if (typeof result.grantId !== 'string') throw new Error('SDK grantChips returned no grantId');
    return {
      grantId: result.grantId,
      replayed: result.replayed ?? false,
      balanceAfter: result.balanceAfter ?? '0',
    };
  }
  return grantChips(platformBaseUrl, operatorToken, request);
}

export async function ensureOperator(
  target: AdminDatabaseTarget,
  session: WalletSession
): Promise<{ promoted: boolean; affected: number }> {
  return promoteWalletToAdmin(target, session.wallet.address);
}
