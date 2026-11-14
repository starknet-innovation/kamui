// Without starknet-react: the same session as a wallet object (`request`, `on`, `off`).
import { RpcProvider, WalletAccount } from 'starknet';
import { KamuiWallet, injectKamuiWallet } from '@kamui/sdk';

const provider = new RpcProvider({ nodeUrl: 'https://YOUR-SEPOLIA-RPC' });
const GAME = '0x2f8ce9fcc5f6e165ab5dcccf865c4c08e7d752d6b930938195683eef9f43dfc';

export const wallet = new KamuiWallet({
  keychainUrl: 'https://sepolia.kamui.page',
  provider,
  sponsor: '/api/kamui/sponsor',
  session: () => ({
    appName: 'My game',
    validUntil: Math.floor(Date.now() / 1000) + 24 * 3600,
    maxCalls: 200,
    calls: [{ to: GAME, entrypoint: 'ping' }],
  }),
});

// Lists Kamui next to extension wallets for anything that scans `window.starknet_*`
// (get-starknet v4 discovery, starknet-react's InjectedConnector with id "kamui").
injectKamuiWallet(wallet);

/** Call on every page load. Null until the user has connected. */
export async function kamuiAccount(): Promise<WalletAccount | null> {
  // Reads the keychain's answer if the user just came back, then checks the session on chain.
  if (!(await wallet.resume())) return null;
  return WalletAccount.connectSilent(provider, wallet);
}

/** From a click. Leaves the page; `kamuiAccount()` returns the account on the next load. */
export function connectKamui(): void {
  void wallet.request({ type: 'wallet_requestAccounts' });
}
