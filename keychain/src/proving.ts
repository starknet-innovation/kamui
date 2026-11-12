// Kamui adapter for the pinned Apache-2.0 SNIP-36 runtime. All witnesses stay in memory.
import { CallData, byteArray, hash, RpcProvider, num } from 'starknet';
import { init, rsa2048Sha256CalldataBuilder } from 'garaga';
import { clientProofFacts, decodeIdToken, identity, recoveryMessage, V2_HEADER, type ClientProver } from '../../sdk/src';

export const PROVER_ASSETS = '/prover/v1.0.1/';
// Kept identical to the pinned upstream read-only transport allow-list.
export const PROVING_RPC_ENDPOINT = 'https://api.zan.top/public/starknet-sepolia/rpc/v0_10';
const PROVING_TIMEOUT_MS = 20 * 60_000;
const MEMORY64 = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 5, 3, 1, 4, 1]);
export function provingSupported(): boolean {
  return typeof Worker !== 'undefined' && typeof WebAssembly !== 'undefined' && WebAssembly.validate(MEMORY64);
}
export function assertBrowserProvingSupported(endpoint = PROVING_RPC_ENDPOINT) {
  if (endpoint !== PROVING_RPC_ENDPOINT) throw new Error('Browser proving requires the pinned public Sepolia RPC endpoint.');
  if (!provingSupported()) throw new Error('Recovery proving requires a recent desktop Chromium browser with WebAssembly memory64 support and enough memory (at least 8 GB device RAM recommended).');
}
const felt = (v: string | bigint | number) => num.toHex(v);
const bytes = (v: string) => Uint8Array.from(atob(v.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const integer = (v: Uint8Array) => BigInt('0x' + Array.from(v, b => b.toString(16).padStart(2, '0')).join(''));
const base64 = (v: Uint8Array) => { let s = ''; for (let i = 0; i < v.length; i += 8192) s += String.fromCharCode(...v.subarray(i, i + 8192)); return btoa(s); };

export function createVirtualTransaction(chain: string, executor: string, account: string, calldata: string[], nonce: string) {
  if (BigInt(chain) !== BigInt('0x534e5f5345504f4c4941')) throw new Error('prover: only Sepolia is supported');
  const zero = { max_amount: '0x0', max_price_per_unit: '0x0' };
  return {
    captured_chain_id: felt(chain),
    chain_info: { chain_id: 'SN_SEPOLIA', is_l3: false, fee_token_addresses: {
      eth_fee_token_address: '0x216e06f4761eb833ec9fbc9d08ae554427a2e6f23539d669a26d7e9997222b3',
      strk_fee_token_address: '0x4718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d',
    } },
    transaction: { sender_address: felt(executor), calldata: ['0x1', felt(account), hash.getSelectorFromName('prove_jwt'), felt(calldata.length), ...calldata.map(felt)],
      signature: ['0x0', '0x0'], nonce: felt(nonce), resource_bounds: { l1_gas: zero, l1_data_gas: zero, l2_gas: { max_amount: '0x3b9aca00', max_price_per_unit: '0x0' } },
      tip: '0x0', paymaster_data: [], account_deployment_data: [], nonce_data_availability_mode: 'L1', fee_data_availability_mode: 'L1' },
  };
}

type Receipt = { kind: string; proof?: number[]; output_preimage?: string[] };
type Controller = { start(r: unknown, s: unknown, o: unknown): void; cancel(): void };
export function browserProver(args: { rpcUrl: string; executor: string; registry: string; onStatus: (text: string) => void; signal?: AbortSignal }): ClientProver {
  return async (request, anchor) => {
    assertBrowserProvingSupported(args.rpcUrl);
    const lifetime = new AbortController();
    const deadline = Date.now() + PROVING_TIMEOUT_MS;
    let controller: Controller | undefined;
    let timedOut = false;
    const interruption = () => new Error(timedOut
      ? 'Browser proving timed out. Start a fresh sign-in to continue.'
      : 'Browser proving cancelled. Start a fresh sign-in to continue.');
    let rejectInterrupted!: (reason: Error) => void;
    const interrupted = new Promise<never>((_, reject) => { rejectInterrupted = reject; });
    const abort = () => {
      lifetime.abort();
      controller?.cancel();
      rejectInterrupted(interruption());
    };
    const timer = setTimeout(() => { timedOut = true; abort(); }, PROVING_TIMEOUT_MS);
    args.signal?.addEventListener('abort', abort, { once: true });
    const check = () => {
      if (Date.now() >= deadline) { timedOut = true; abort(); }
      if (lifetime.signal.aborted) throw interruption();
    };
    const run = async () => {
      if (args.signal?.aborted) abort();
      check();
      const claims = decodeIdToken(request.jwt);
      if (claims.exp - Date.now() / 1000 < 15 * 60) throw new Error('Sign in again: this token expires too soon for browser proving.');
      const provider = new RpcProvider({ nodeUrl: args.rpcUrl, baseFetch: (input, init) => fetch(input, {
        ...init, signal: lifetime.signal, credentials: 'omit', redirect: 'error',
      }) });
      // Get a key at the SAME base block as the authenticated execution. No private calldata goes to RPC.
      const block = await provider.getBlockWithTxHashes('latest');
      check();
      if (!('block_hash' in block)) throw new Error('prover: finalized base block unavailable');
      const [chain, nonce] = await Promise.all([provider.getChainId(), provider.getNonceForAddress(args.executor, block.block_hash)]);
      check();
      const [header, payload, signature] = request.jwt.split('.');
      let kid: string;
      try {
        const h = JSON.parse(new TextDecoder().decode(bytes(header!)));
        if (h.alg !== 'RS256' || typeof h.kid !== 'string') throw Error();
        kid = h.kid;
      } catch { throw new Error('prover: unsupported login token'); }
      args.onStatus('Preparing the browser proof…');
      const limbs = await provider.callContract({ contractAddress: args.registry, entrypoint: 'get_key', calldata: CallData.compile([byteArray.byteArrayFromString(claims.iss), byteArray.byteArrayFromString(kid)]) }, block.block_hash);
      check();
      if (limbs.length !== 24 || limbs.some(l => BigInt(l) >= 1n << 96n)) throw new Error('prover: invalid registered RSA key');
      const modulus = limbs.reduce((n, l, i) => n | BigInt(l) << (96n * BigInt(i)), 0n);
      await init();
      check();
      let hint: bigint[];
      try { hint = rsa2048Sha256CalldataBuilder(integer(bytes(signature!)), new TextEncoder().encode(`${header}.${payload}`), modulus, false); }
      catch { throw new Error('prover: could not prepare the RSA signature witness'); }
      check();
      const calldata = CallData.compile([byteArray.byteArrayFromString(header!), byteArray.byteArrayFromString(payload!), byteArray.byteArrayFromString(kid), hint, request.newPubkey, request.blinding, request.pepper]);
      const virtual = createVirtualTransaction(chain, args.executor, request.account, calldata, nonce);
      const base = new URL(PROVER_ASSETS, location.origin);
      const module = await import(new URL('public-run-controller.mjs', base).href);
      check();
      const receipt = await new Promise<Receipt>((resolve, reject) => {
        let finished = false;
        const fail = (message: string) => { if (finished) return; finished = true; controller?.cancel(); reject(new Error(message)); };
        controller = new module.PublicRunController({
          workerFactory: (url: string) => new Worker(new URL(url, base), { type: 'module' }),
          save: async () => {}, // Never persist receipts, private requests, captures or PIE.
          onStatus: (s: { kind: string; phase?: string }) => {
            // No raw worker errors, panics, captures or request data in UI/logs/telemetry.
            if (s.kind === 'error' || s.kind === 'panic') fail('Browser proving failed. Try a fresh sign-in in desktop Chrome with enough free memory.');
            else if (s.kind === 'cancelled') fail(interruption().message);
            else if (s.kind === 'phase') args.onStatus(s.phase === 'recursive proving' ? 'Proving in this browser. Keep this page open…' : 'Executing the recovery in this browser…');
          },
          onComplete: (r: Receipt) => { if (!finished) { finished = true; resolve(r); } },
        });
        check();
        args.onStatus('Loading the browser prover (about 108 MiB on first use)…');
        controller!.start(virtual, { endpoint: args.rpcUrl, block_id: { block_hash: block.block_hash } }, { build: 'standard', expectedWasm: { bytes: 76749727, sha256: 'febb42b85947772b129eec17ba58aec50dae1988a7af5ef0fd6b61812358bde7' } });
      });
      check();
      if (receipt.kind !== 'proof' || !receipt.proof || !receipt.output_preimage) throw new Error('prover: no proof returned');
      const proof = Uint8Array.from(receipt.proof);
      const expectedHeader = Uint8Array.from(V2_HEADER.match(/../g)!, x => parseInt(x, 16));
      if (proof.length > 480_000 || proof.length <= expectedHeader.length || !expectedHeader.every((b, i) => proof[i] === b)) throw new Error('prover: incompatible proof profile');
      const proofFacts = clientProofFacts(receipt.output_preimage, recoveryMessage(request.account, identity(claims, request.pepper), request.newPubkey, anchor));
      return { proof: base64(proof), proofFacts };
    };
    try {
      // This also bounds imports and transports which ignore AbortSignal. Every continuation
      // checks lifetime before preparing private work or starting another Worker.
      return await Promise.race([interrupted, run()]);
    } finally {
      clearTimeout(timer);
      args.signal?.removeEventListener('abort', abort);
      controller?.cancel();
      lifetime.abort();
    }
  };
}
