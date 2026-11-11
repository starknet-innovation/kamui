// Read-only checks before an S1 run. Sends no transactions and needs no keys.
//   bun run preflight.ts [RPC_URL]
// Answers: can the existing Sepolia deployment of social-account be reused as it is?
import { RpcProvider, byteArray, hash } from 'starknet';

const RPC = process.argv[2] ?? process.env.RPC_URL ?? 'https://api.zan.top/public/starknet-sepolia/rpc/v0_10';
// Values committed in social-account's backend/.env at e168134.
const REGISTRY = '0x654508b46a551c5b3dd8425e0ec4f06af316d28c68500bb83f9b815ba3fb3db';
const REGISTRY_BLOCK = 16518420;
const CLASS_HASH = '0x558d0559950cd4c089af122c3b1040e5f19ba0472a8632cba9f71d610d32c0d';
const EXECUTOR = '0x44c921502db6c924a29f78256d72926060efa599cd13d97142efa192eaebd4c';
const GOOGLE_ISS = 'https://accounts.google.com';
const GOOGLE_JWKS = 'https://www.googleapis.com/oauth2/v3/certs';

const provider = new RpcProvider({ nodeUrl: RPC });
const results: [string, boolean, string][] = [];
const check = async (name: string, fn: () => Promise<string>) => {
  try {
    results.push([name, true, await fn()]);
  } catch (e) {
    results.push([name, false, (e as Error).message.split('\n')[0].slice(0, 160)]);
  }
};

function byteArraysFromFelts(d: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < d.length) {
    const len = Number(BigInt(d[i]));
    out.push(
      byteArray.stringFromByteArray({
        data: d.slice(i + 1, i + 1 + len),
        pending_word: d[i + 1 + len],
        pending_word_len: Number(BigInt(d[i + 2 + len])),
      }),
    );
    i += len + 3;
  }
  return out;
}

await check('RPC reachable, chain is Sepolia', async () => {
  const id = await provider.getChainId();
  if (id !== '0x534e5f5345504f4c4941') throw new Error(`chain id ${id}`);
  return `block ${await provider.getBlockNumber()}`;
});

await check('RPC serves starknet_getStorageProof (needed by the prover)', async () => {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'starknet_getStorageProof',
      params: { block_id: 'latest', contract_addresses: [REGISTRY] },
    }),
  });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (!body.result) throw new Error(body.error?.message ?? `HTTP ${res.status}`);
  return 'ok';
});

await check('SocialAccount class is declared', async () => {
  await provider.getClassByHash(CLASS_HASH);
  return CLASS_HASH.slice(0, 12) + '…';
});

await check('ProverExecutor is deployed', async () => {
  return 'class ' + (await provider.getClassHashAt(EXECUTOR)).slice(0, 12) + '…';
});

await check("Registry holds Google's current signing keys", async () => {
  const KEY_SET = hash.getSelectorFromName('KeySet');
  const KEY_REMOVED = hash.getSelectorFromName('KeyRemoved');
  const kids = new Set<string>();
  let continuation_token: string | undefined;
  do {
    const chunk = await provider.getEvents({
      address: REGISTRY,
      from_block: { block_number: REGISTRY_BLOCK },
      to_block: 'latest',
      keys: [[KEY_SET, KEY_REMOVED]],
      chunk_size: 1000,
      continuation_token,
    });
    for (const e of chunk.events) {
      const [iss, kid] = byteArraysFromFelts(e.data);
      if (iss !== GOOGLE_ISS) continue;
      if (BigInt(e.keys[0]) === BigInt(KEY_SET)) kids.add(kid);
      else kids.delete(kid);
    }
    continuation_token = chunk.continuation_token;
  } while (continuation_token);
  const jwks = (await (await fetch(GOOGLE_JWKS)).json()) as { keys: { kid: string; alg: string }[] };
  const live = jwks.keys.filter((k) => k.alg === 'RS256').map((k) => k.kid);
  const missing = live.filter((k) => !kids.has(k));
  if (missing.length) throw new Error(`${missing.length} of ${live.length} Google keys missing on chain (registry is stale)`);
  return `${live.length} of ${live.length} present`;
});

for (const [name, ok, detail] of results) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
process.exit(results.every(([, ok]) => ok) ? 0 : 1);
