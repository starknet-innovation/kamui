// Kamui settings for this app. Defined once, outside any component.
import { RpcProvider } from 'starknet';
import type { ConnectOptions } from '@kamui/sdk';

/** The hosted Sepolia keychain. */
export const KEYCHAIN_URL = 'https://sepolia.kamui.page';

/** Your own server route that forwards sponsored calls (see "Sponsorship"). */
export const SPONSOR_URL = '/api/kamui/sponsor';

/** Any Starknet Sepolia JSON-RPC endpoint (Alchemy, Infura, Blast, your own node...). */
export const RPC_URL = 'https://YOUR-SEPOLIA-RPC';
export const provider = new RpcProvider({ nodeUrl: RPC_URL });

/** The game contract the session may call, and STRK on Sepolia. */
export const GAME = '0x2f8ce9fcc5f6e165ab5dcccf865c4c08e7d752d6b930938195683eef9f43dfc';
export const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';

/**
 * What the session may do. The keychain shows exactly this to the user, and the account
 * enforces it on chain.
 */
export function sessionRequest(): Omit<ConnectOptions, 'keychainUrl' | 'redirectUri'> {
  return {
    appName: 'My game',
    validUntil: Math.floor(Date.now() / 1000) + 24 * 3600, // one day
    maxCalls: 200,
    maxFeePerTx: 0n, // sponsored only: the session never spends the user's STRK on fees
    calls: [
      { to: GAME, entrypoint: 'ping' },
      { to: STRK, entrypoint: 'transfer' },
    ],
    // Required for any token call that moves value: at most 1 STRK per call, 5 STRK a day.
    limits: [{ token: STRK, maxPerCall: 10n ** 18n, maxPerWindow: 5n * 10n ** 18n, windowSeconds: 86_400 }],
  };
}
