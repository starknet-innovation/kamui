// bun run main.ts
import { RpcProvider } from 'starknet';
import { sessionCall, sponsor } from '@kamui/sdk';
import { connect } from './connect';
import { fileStore } from './file-store';

const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const GAME = '0x2f8ce9fcc5f6e165ab5dcccf865c4c08e7d752d6b930938195683eef9f43dfc';

const provider = new RpcProvider({ nodeUrl: process.env.STARKNET_RPC_URL! });
const store = fileStore(process.env.KAMUI_STORAGE_PATH ?? '.kamui/session.json');

const connection = await connect({
  provider,
  store,
  keychainUrl: 'https://sepolia.kamui.page',
  appName: 'My bot',
  validUntil: Math.floor(Date.now() / 1000) + 7 * 24 * 3600, // a week
  maxCalls: 1000,
  calls: [
    { to: GAME, entrypoint: 'ping' },
    { to: STRK, entrypoint: 'transfer' },
  ],
  limits: [{ token: STRK, maxPerCall: 10n ** 18n, maxPerWindow: 5n * 10n ** 18n, windowSeconds: 86_400 }],
});
console.log(`connected as ${connection.account}`);

// A server holds the sponsorship credential itself, so it calls Kamui directly.
const withCredentials = (url: string, init: { method: string; headers: Record<string, string>; body: string }) =>
  fetch(url, {
    ...init,
    headers: {
      ...init.headers,
      'x-kamui-app-key': process.env.KAMUI_APP_KEY!,
      'x-kamui-sponsor-token': process.env.KAMUI_SPONSOR_TOKEN!,
    },
  });

const prepared = await sessionCall(connection, [{ contractAddress: GAME, entrypoint: 'ping', calldata: [] }], provider);
if (!prepared) throw new Error('the session has used all its calls');
const hash = await sponsor('https://sepolia.kamui.page/api/sponsor', prepared.call, withCredentials);
console.log(`sent ${hash}`);
await provider.waitForTransaction(hash);
console.log('confirmed');
