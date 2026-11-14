// Kamui as a wallet for Starknet Start. Created once, outside any component.
import { RpcProvider } from 'starknet';
import { KamuiStandardWallet } from '@kamui/sdk/starknet-start';

/** Any Starknet Sepolia JSON-RPC endpoint. */
export const RPC_URL = 'https://YOUR-SEPOLIA-RPC';
export const provider = new RpcProvider({ nodeUrl: RPC_URL });

/** The game contract the session may call, and STRK on Sepolia. */
export const GAME = '0x2f8ce9fcc5f6e165ab5dcccf865c4c08e7d752d6b930938195683eef9f43dfc';
export const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';

export const kamui = new KamuiStandardWallet({
  keychainUrl: 'https://sepolia.kamui.page',
  provider,
  // Your own server route that forwards sponsored calls (see "Sponsorship").
  sponsor: '/api/kamui/sponsor',
  // Read when the user connects, so the day starts then.
  session: () => ({
    appName: 'My game',
    validUntil: Math.floor(Date.now() / 1000) + 24 * 3600,
    maxCalls: 200,
    maxFeePerTx: 0n, // sponsored only
    calls: [
      { to: GAME, entrypoint: 'ping' },
      { to: STRK, entrypoint: 'transfer' },
    ],
    limits: [{ token: STRK, maxPerCall: 10n ** 18n, maxPerWindow: 5n * 10n ** 18n, windowSeconds: 86_400 }],
  }),
});
