// Read-only: prints a Kamui account's state on Sepolia.
//   bun run sepolia-check.ts <account> [RPC_URL]
import { RpcProvider } from 'starknet';

const account = process.argv[2];
if (!account) throw new Error('usage: bun run sepolia-check.ts <account> [RPC_URL]');
const provider = new RpcProvider({
  nodeUrl: process.argv[3] ?? 'https://sepolia.nodes.starknet.org/rpc/v0_10',
});
const call = (entrypoint: string, calldata: string[] = []) =>
  provider.callContract({ contractAddress: account, entrypoint, calldata });

const SESSION_KEY_INTERFACE_ID = '0x9da822b09dda470480ed02c12ae8745d4ac010023df23c6db0314abe5cdc02';
const ISRC9_V2_ID = '0x1d1144bb2138366ff28d8e9ab57456b1d332ac42196230c3a602003c89872';
const ISRC6_ID = '0x2ceccef7f994940b3962a6c67e0ba4fcd37df7d131417c604f91e03caecc1cd';

const [count, ...owners] = await call('get_owners');
console.log(`class hash     ${await provider.getClassHashAt(account)}`);
console.log(`owners (${Number(BigInt(count))})     ${owners.join('\n               ')}`);
console.log(`owners anchor  ${(await call('get_owners_anchor'))[0]}`);
console.log(`session epoch  ${Number(BigInt((await call('get_session_epoch'))[0]))}`);
console.log(`identity       ${(await call('identity'))[0]}`);
for (const [name, id] of [['SRC-6', ISRC6_ID], ['SNIP-9 v2', ISRC9_V2_ID], ['SNIP-41', SESSION_KEY_INTERFACE_ID]]) {
  console.log(`supports ${name.padEnd(9)} ${BigInt((await call('supports_interface', [id]))[0]) === 1n}`);
}
