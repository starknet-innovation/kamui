// SNIP-29 HTTP integration only. AVNU runs unmodified in a separate process; none of its
// implementation is linked, copied or adapted here. See PAYMASTER.md for operational limits.
import { OutsideExecutionVersion, outsideExecution, shortString, type Call } from 'starknet';
import { HttpError } from '../../http';
import { log } from '../../log';
import { fetchWithTimeout, type Fetch } from '../../net';

const PRIME = (1n << 251n) + 17n * (1n << 192n) + 1n;
const ANY_CALLER = shortString.encodeShortString('ANY_CALLER');
export type SignedOutsideExecution = {
  typedData: ReturnType<typeof outsideExecution.getTypedData>;
  signature: string[];
};
export interface SponsoredPaymaster {
  /** Parses the signed payload before budget reservation or a paid operation. */
  prepare(calldata: string[]): SignedOutsideExecution;
  /** No automatic retry: a failed connection may hide a successful submission. */
  execute(account: string, execution: SignedOutsideExecution): Promise<{ transaction_hash: string }>;
}

/** Decode the existing signed Cairo payload without changing its calls, nonce or signature. */
export function decodeOutsideExecution(calldata: string[], chainId: string): SignedOutsideExecution {
  if (calldata.length > 600 || calldata.some((v) => !/^0x[0-9a-fA-F]{1,64}$/.test(v) || BigInt(v) >= PRIME)) throw new HttpError(400, 'BAD_CALLDATA');
  let offset = 0;
  const take = () => {
    const value = calldata[offset++];
    if (value === undefined) throw new HttpError(400, 'BAD_CALLDATA');
    return value;
  };
  const count = () => {
    const value = BigInt(take());
    if (value > BigInt(calldata.length - offset)) throw new HttpError(400, 'BAD_CALLDATA');
    return Number(value);
  };
  const caller = take();
  // The preflight estimator and AVNU have different relayers. An explicit caller would
  // either fail the preflight or fail later at the paymaster, so require ANY_CALLER.
  if (BigInt(caller) !== BigInt(ANY_CALLER)) throw new HttpError(400, 'PAYMASTER_CALLER_MUST_BE_ANY');
  const nonce = take();
  const after = BigInt(take());
  const before = BigInt(take());
  if (after > BigInt(Number.MAX_SAFE_INTEGER) || before > BigInt(Number.MAX_SAFE_INTEGER) || before <= after) throw new HttpError(400, 'BAD_OUTSIDE_WINDOW');
  const calls: Call[] = [];
  const n = count();
  for (let i = 0; i < n; i++) {
    const contractAddress = take();
    const entrypoint = take();
    const size = count();
    const data = calldata.slice(offset, offset + size);
    offset += size;
    calls.push({ contractAddress, entrypoint, calldata: data });
  }
  const signature = Array.from({ length: count() }, take);
  if (offset !== calldata.length || ![2, 4].includes(signature.length)) throw new HttpError(400, 'BAD_CALLDATA');
  const typedData = outsideExecution.getTypedData(chainId as Parameters<typeof outsideExecution.getTypedData>[0],
      { caller, execute_after: Number(after), execute_before: Number(before) }, nonce, calls, OutsideExecutionVersion.V2);
  // getTypedData hashes entrypoint names. Here the Cairo payload already holds selectors;
  // retain those values instead of hashing their hexadecimal spelling a second time.
  (typedData.message as { Calls: { Selector: string }[] }).Calls.forEach((call, index) => { call.Selector = calls[index]!.entrypoint; });
  // AVNU's felt decoder requires hex strings, including these u128 time bounds.
  // This changes their JSON representation, not the signed numeric values.
  const message = typedData.message as Record<string, unknown>;
  message['Execute After'] = `0x${after.toString(16)}`;
  message['Execute Before'] = `0x${before.toString(16)}`;
  return { typedData, signature };
}

export function avnuPaymaster(options: { url: string; chainId: string; apiKey?: string; timeoutMs?: number; send?: Fetch }): SponsoredPaymaster {
  const url = new URL(options.url);
  if (url.username || url.password || url.search || url.hash) throw new Error('PAYMASTER_URL must not contain credentials, query parameters or a fragment');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', 'paymaster'].includes(url.hostname))) throw new Error('PAYMASTER_URL must use HTTPS (HTTP is allowed for the local paymaster)');
  return {
    prepare: (calldata) => decodeOutsideExecution(calldata, options.chainId),
    async execute(account, execution) {
      // The sponsored mode adds no token payment or extra user call. In particular, do not
      // ask buildTransaction for a different nonce: session nonces live in a reserved range.
      const id = crypto.randomUUID();
      let response: Response;
      let body: any;
      try {
        response = await fetchWithTimeout(url.toString(), {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(options.apiKey ? { 'x-paymaster-api-key': options.apiKey } : {}) },
          body: JSON.stringify({ jsonrpc: '2.0', id, method: 'paymaster_executeTransaction', params: {
            transaction: { type: 'invoke', invoke: { user_address: account, typed_data: execution.typedData, signature: execution.signature } },
            parameters: { version: '0x1', fee_mode: { mode: 'sponsored' } },
          } }),
        }, options.timeoutMs ?? 30_000, async (url, init) => {
          const received = await (options.send ?? fetch)(url, init);
          // Reading the body belongs inside the deadline too: headers alone are not a reply.
          body = await received.json().catch(() => null);
          return received;
        });
      } catch { throw new HttpError(502, 'PAYMASTER_SUBMISSION_UNCERTAIN'); }
      // Never echo errors, bodies or the endpoint (they may include credentials/calldata).
      if (!response.ok || !body || body.jsonrpc !== '2.0' || body.id !== id || body.error || !/^0x[0-9a-fA-F]{1,64}$/.test(body.result?.transaction_hash ?? '')) {
        log('warn', 'paymaster_response_rejected', { status: response.status, rpc_code: Number.isSafeInteger(body?.error?.code) ? body.error.code : null });
        throw new HttpError(502, 'PAYMASTER_SUBMISSION_UNCERTAIN');
      }
      return { transaction_hash: body.result.transaction_hash };
    },
  };
}

/** Disabled by default. Mainnet waits for external spending controls and an end-to-end run. */
export function paymasterFromEnvironment(chainId: string, env: Record<string, string | undefined> = process.env): SponsoredPaymaster | undefined {
  if (!env.PAYMASTER_URL) return undefined;
  if (chainId !== shortString.encodeShortString('SN_SEPOLIA')) throw new Error('AVNU sponsorship is enabled only on Sepolia until validated');
  return avnuPaymaster({ url: env.PAYMASTER_URL, chainId, apiKey: env.PAYMASTER_API_KEY });
}
