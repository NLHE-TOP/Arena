/**
 * Playwright EIP-1193 wallet injection.
 *
 * The page sees a real `window.ethereum` provider: account requests, message
 * signing (EIP-191 personal_sign) and EIP-712 typed-data signing are delegated
 * to the harness's viem account over Playwright bindings, so signatures are
 * cryptographically valid for the real SIWE/session endpoints. Provider
 * approval is persisted in localStorage, so a page reload behaves like a real
 * reconnect: `eth_accounts` returns the account without a new prompt.
 *
 * The init script is injected as a plain source string (never a serialized
 * function) so no bundler helper such as `__name` can leak into the page.
 */
import type { Page } from 'playwright';
import { verifyMessage } from 'viem';
import type { EphemeralWallet } from '../integration/infra/wallet.js';

export interface InjectedWalletHandle {
  address: `0x${string}`;
  chainId: number;
}

function providerSource(address: string, chainId: number): string {
  return `
(function () {
  var address = ${JSON.stringify(address)};
  var injectedChainId = ${JSON.stringify(chainId)};
  var APPROVAL_KEY = 'nlhe-it-wallet-approved';
  var listeners = {};
  function emit(event) {
    var args = Array.prototype.slice.call(arguments, 1);
    (listeners[event] || []).forEach(function (listener) { listener.apply(null, args); });
  }
  function waitForBinding(name) {
    return new Promise(function (resolve, reject) {
      var attempts = 0;
      function check() {
        var fn = window[name];
        if (typeof fn === 'function') { resolve(fn); return; }
        if (++attempts > 100) { reject(new Error('wallet binding ' + name + ' unavailable')); return; }
        setTimeout(check, 20);
      }
      check();
    });
  }
  var provider = {
    isMetaMask: true,
    isConnected: function () { return true; },
    chainId: '0x' + injectedChainId.toString(16),
    selectedAddress: null,
    on: function (event, listener) {
      (listeners[event] = listeners[event] || []).push(listener);
      return provider;
    },
    removeListener: function (event, listener) {
      listeners[event] = (listeners[event] || []).filter(function (entry) { return entry !== listener; });
      return provider;
    },
    request: function (args) {
      var method = args.method;
      var params = args.params || [];
      function approved() { return window.localStorage.getItem(APPROVAL_KEY) === address.toLowerCase(); }
      switch (method) {
        case 'eth_chainId': return Promise.resolve(provider.chainId);
        case 'net_version': return Promise.resolve(String(injectedChainId));
        case 'eth_accounts': return Promise.resolve(approved() ? [address] : []);
        case 'eth_requestAccounts':
          if (!approved()) {
            window.localStorage.setItem(APPROVAL_KEY, address.toLowerCase());
            emit('accountsChanged', [address]);
          }
          provider.selectedAddress = address;
          return Promise.resolve([address]);
        case 'wallet_requestPermissions': return Promise.resolve([{ parentCapability: 'eth_accounts' }]);
        case 'wallet_switchEthereumChain':
        case 'wallet_addEthereumChain': return Promise.resolve(null);
        case 'personal_sign': {
          var first = params[0];
          var second = params[1];
          var message = typeof first === 'string' && first.toLowerCase() === address.toLowerCase() ? second : first;
          if (typeof message !== 'string') return Promise.reject(new Error('personal_sign message missing'));
          return waitForBinding('__nlheWalletSignMessage').then(function (sign) { return sign(message); });
        }
        case 'eth_signTypedData_v4':
        case 'eth_signTypedData': {
          var payload = params
            .map(function (value) { return typeof value === 'string' ? value : JSON.stringify(value); })
            .filter(function (value) { return value.trim().charAt(0) === '{'; })[0];
          if (!payload) return Promise.reject(new Error('typed data missing'));
          return waitForBinding('__nlheWalletSignTypedData').then(function (sign) { return sign(payload); });
        }
        case 'eth_sendTransaction': return Promise.reject(new Error('injected test wallet never broadcasts transactions'));
        default: return Promise.reject(new Error('unsupported injected wallet method: ' + method));
      }
    }
  };
  window.ethereum = provider;
  window.__nlheWalletAddress = address;
})();
`;
}

export async function installInjectedWallet(
  page: Page,
  wallet: EphemeralWallet,
  options: { chainId?: number } = {}
): Promise<InjectedWalletHandle> {
  const chainId = options.chainId ?? 31337;

  await page.exposeFunction('__nlheWalletSignMessage', async (message: string) => {
    // EIP-1193 personal_sign params are hex-encoded bytes; sign raw bytes when
    // the caller sent hex, otherwise sign the UTF-8 string as-is.
    if (/^0x[0-9a-fA-F]*$/.test(message)) {
      return wallet.account.signMessage({ message: { raw: message as `0x${string}` } });
    }
    return wallet.account.signMessage({ message });
  });
  await page.exposeFunction('__nlheWalletSignTypedData', async (typedDataJson: string) => {
    const typedData = JSON.parse(typedDataJson) as {
      domain?: Record<string, unknown>;
      types?: Record<string, Array<{ name: string; type: string }>>;
      primaryType?: string;
      message?: Record<string, unknown>;
    };
    return wallet.account.signTypedData({
      domain: (typedData.domain ?? {}) as never,
      types: (typedData.types ?? {}) as never,
      primaryType: typedData.primaryType ?? '',
      message: (typedData.message ?? {}) as never,
    });
  });

  await page.addInitScript({ content: providerSource(wallet.address, chainId) });

  return { address: wallet.address, chainId };
}

/** Verify a signature the injected provider produced for a message. */
export async function verifyInjectedSignature(
  wallet: EphemeralWallet,
  message: string,
  signature: string
): Promise<boolean> {
  return verifyMessage({ address: wallet.address, message, signature: signature as `0x${string}` });
}
