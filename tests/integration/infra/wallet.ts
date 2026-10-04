/**
 * Ephemeral viem wallets and real SIWE sign-in through the public SDK.
 *
 * Every participant in the acceptance topology is a real wallet signing a real
 * SIWE message against the running PokerTools API; no session token is ever
 * fabricated. The SDK owns nonce retrieval, message formatting (viem/siwe),
 * login and bearer-token storage.
 */
import { createSiweMessage, PokerClient } from '@pokertools/sdk';
import { generatePrivateKey, mnemonicToAccount, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';

/** Standard public Anvil test mnemonic; never use these accounts with value. */
export function getAccount(addressIndex: number) {
  return mnemonicToAccount('test test test test test test test test test test test junk', { addressIndex });
}

export interface EphemeralWallet {
  account: PrivateKeyAccount;
  address: `0x${string}`;
  privateKey: `0x${string}`;
}

export function ephemeralWallet(): EphemeralWallet {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  return { account, address: account.address, privateKey };
}

export interface WalletLike {
  address: `0x${string}`;
  /** viem HDAccount/PrivateKeyAccount exposes signMessage directly. */
  signMessage?(args: { message: string }): Promise<`0x${string}`>;
  /** EphemeralWallet wraps the viem account here. */
  account?: {
    address: `0x${string}`;
    signMessage(args: { message: string }): Promise<`0x${string}`>;
  };
}

export interface WalletSession {
  client: PokerClient;
  wallet: WalletLike;
  token: string;
  userId: string;
  username: string;
}

export async function loginWallet(
  baseUrl: string,
  wallet: WalletLike,
  options: { chainId?: number; statement?: string } = {}
): Promise<WalletSession> {
  const client = new PokerClient({ baseUrl, timeout: 15_000, retry: { count: 2, delay: 100, backoff: 2 } });
  const nonce = await client.getNonce();
  const origin = new URL(baseUrl);
  const message = createSiweMessage({
    domain: origin.hostname,
    address: wallet.address,
    uri: baseUrl,
    nonce,
    chainId: options.chainId ?? 31337,
    statement: options.statement ?? 'NLHE integration acceptance',
  });
  const signature = await (wallet.account ?? wallet).signMessage({ message });
  const login = await client.login({ message, signature });
  return {
    client,
    wallet,
    token: login.token,
    userId: login.user.id,
    username: login.user.username,
  };
}

/** A bearer client for an existing token (wallet session or service credential). */
export function tokenClient(baseUrl: string, token?: string): PokerClient {
  return new PokerClient({ baseUrl, token, timeout: 20_000, retry: { count: 2, delay: 100, backoff: 2 } });
}
