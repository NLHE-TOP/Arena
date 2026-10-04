/**
 * Wallet session: injected EIP-1193 signing, SIWE login through the public
 * `@pokertools/sdk`, and the opaque session token persisted in
 * `sessionStorage`.
 *
 * The browser never holds keys beyond the injected wallet, never builds the
 * SIWE text by hand (`createSiweMessage` from the SDK does), and never asserts
 * its own product identity: the token is opaque and the identity is verified
 * with `client.getPrincipal()`.
 */

import { createSiweMessage, type PokerClient } from '@pokertools/sdk';

const TOKEN_KEY = 'nlhe.pokerTools.token.v1';

/** Minimal structural view of an injected EIP-1193 provider. */
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
}

/** Canonical public principal (as returned by the PokerTools API). */
export interface PrincipalLike {
  id: string;
  kind: string;
  walletAddress: string | null;
}

/** Read the injected wallet provider, if the browser has one. */
export function injectedProvider(): Eip1193Provider | null {
  const candidate = (window as unknown as { ethereum?: unknown }).ethereum;
  if (
    typeof candidate === 'object' &&
    candidate !== null &&
    typeof (candidate as Eip1193Provider).request === 'function'
  ) {
    return candidate as Eip1193Provider;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Token persistence (sessionStorage only)
// ---------------------------------------------------------------------------

export function readStoredToken(): string | null {
  try {
    const token = window.sessionStorage.getItem(TOKEN_KEY);
    return token && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

export function storeToken(token: string): void {
  try {
    window.sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Private browsing can deny storage; the in-memory session still works.
  }
}

export function clearStoredToken(): void {
  try {
    window.sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// EIP-1193 primitives
// ---------------------------------------------------------------------------

function toHexUtf8(text: string): `0x${string}` {
  const bytes = new TextEncoder().encode(text);
  let hex = '0x';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex as `0x${string}`;
}

function firstAddress(value: unknown): string {
  if (!Array.isArray(value)) throw new Error('Wallet did not return an account');
  const address = value.find((entry): entry is string => typeof entry === 'string' && entry.length > 0);
  if (!address) throw new Error('Wallet did not return an account');
  return address;
}

async function readChainId(provider: Eip1193Provider): Promise<number> {
  try {
    const value = await provider.request({ method: 'eth_chainId' });
    if (typeof value === 'string') {
      const parsed = Number.parseInt(value, 16);
      if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
    }
  } catch {
    // Fall through to the SIWE helper default chain (1).
  }
  return 1;
}

async function personalSign(
  provider: Eip1193Provider,
  address: string,
  message: string
): Promise<`0x${string}`> {
  const signature = await provider.request({
    method: 'personal_sign',
    params: [toHexUtf8(message), address],
  });
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]+$/.test(signature)) {
    throw new Error('Wallet returned an invalid signature');
  }
  return signature as `0x${string}`;
}

// ---------------------------------------------------------------------------
// SIWE login
// ---------------------------------------------------------------------------

export interface WalletIdentity {
  principal: PrincipalLike;
  address: string;
}

/**
 * Run the full wallet login against the PokerTools API:
 * `eth_requestAccounts` -> nonce -> `createSiweMessage` -> `personal_sign` ->
 * `client.login` -> `client.getPrincipal`.
 *
 * The SIWE domain is the API hostname, as required by the API's domain check.
 */
export async function signInWithWallet(
  client: PokerClient,
  provider: Eip1193Provider,
  pokerApiUrl: string
): Promise<WalletIdentity> {
  const account = firstAddress(await provider.request({ method: 'eth_requestAccounts' }));
  const chainId = await readChainId(provider);
  const nonce = await client.getNonce();

  const apiUrl = new URL(pokerApiUrl);
  const message = createSiweMessage({
    domain: apiUrl.hostname,
    address: account as `0x${string}`,
    uri: pokerApiUrl,
    nonce,
    chainId,
    version: '1',
    statement: 'Sign in to nlhe.top',
    issuedAt: new Date(),
  });

  const signature = await personalSign(provider, account, message);
  const login = await client.login({ message, signature });
  if (!login.token || login.token.length === 0) {
    throw new Error('PokerTools login returned no session token');
  }
  storeToken(login.token);

  const principal = await client.getPrincipal();
  return {
    principal: {
      id: principal.id,
      kind: principal.kind,
      walletAddress: principal.walletAddress,
    },
    address: principal.walletAddress ?? account,
  };
}
