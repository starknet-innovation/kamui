// Kamui: how an issuer's RSA key maps to what the on-chain registry stores and emits. Shared by
// the rotator (which writes keys) and the watcher (which checks what was written). They share
// this arithmetic and nothing else: no state, no cache, no key.
import { CallData, byteArray, hash, shortString } from 'starknet';
import type { Jwk } from './verification';

// Garaga RSA2048PublicKey: 6 u384 chunks x 4 u96 limbs, low to high.
const LIMB_BITS = 96n;
const LIMBS = 24;

export function modulusLimbs(nBase64url: string): bigint[] {
  const bytes = Buffer.from(nBase64url, 'base64url');
  if (bytes.length !== 256) throw new Error(`modulus is ${bytes.length} bytes, need 256`);
  const n = BigInt('0x' + bytes.toString('hex'));
  const mask = (1n << LIMB_BITS) - 1n;
  return Array.from({ length: LIMBS }, (_, i) => (n >> (LIMB_BITS * BigInt(i))) & mask);
}

/**
 * `modulus_hash` in contracts/src/jwt/registry.cairo: poseidon_hash_span over the key's Serde
 * output, which is its 24 u96 limbs, low to high. This is the value in a `KeySet` event's keys.
 */
export function modulusHash(limbs: bigint[]): bigint {
  if (limbs.length !== LIMBS) throw new Error(`a key has ${LIMBS} limbs, got ${limbs.length}`);
  return BigInt(hash.computePoseidonHashOnElements(limbs));
}

/** The keys the registry mirrors: RS256 signing keys with e = 65537, by kid, as limbs. */
export function filterEligibleKeys(keys: Jwk[]): Map<string, bigint[]> {
  const out = new Map<string, bigint[]>();
  for (const k of keys) {
    if (k.kty !== 'RSA' || k.alg !== 'RS256' || k.use !== 'sig' || k.e !== 'AQAB') continue;
    out.set(k.kid, modulusLimbs(k.n));
  }
  return out;
}

/** Consecutive Cairo ByteArrays as they appear in event data: [len, ...words, pending_word, pending_word_len]... */
export function byteArraysFromFelts(d: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < d.length;) {
    const len = Number(BigInt(d[i]!));
    out.push(
      byteArray.stringFromByteArray({
        data: d.slice(i + 1, i + 1 + len),
        pending_word: d[i + 1 + len]!,
        pending_word_len: Number(BigInt(d[i + 2 + len]!)),
      }),
    );
    i += len + 3;
  }
  return out;
}

export const KEY_SET_SELECTOR = hash.getSelectorFromName('KeySet');
export const KEY_REMOVED_SELECTOR = hash.getSelectorFromName('KeyRemoved');

export type RegistryEvent = {
  kind: 'set' | 'removed';
  iss: string;
  kid: string;
  /** On `set`: the hash the contract computed from the key it stored. Absent if the contract did not emit one. */
  modulusHash?: bigint;
  blockNumber: number;
  transactionHash: string;
};

type RawEvent = { keys: string[]; data: string[]; block_number?: number; transaction_hash?: string };

/** A `KeySet` or `KeyRemoved` event decoded, or null for any other event or a malformed one. */
export function parseRegistryEvent(e: RawEvent): RegistryEvent | null {
  try {
    const selector = BigInt(e.keys[0]!);
    const isSet = selector === BigInt(KEY_SET_SELECTOR);
    if (!isSet && selector !== BigInt(KEY_REMOVED_SELECTOR)) return null;
    const [iss, kid] = byteArraysFromFelts(e.data);
    if (iss === undefined || kid === undefined) return null;
    return {
      kind: isSet ? 'set' : 'removed',
      iss,
      kid,
      // A registry class older than the hash emits KeySet without it.
      ...(isSet && e.keys[1] !== undefined ? { modulusHash: BigInt(e.keys[1]) } : {}),
      blockNumber: e.block_number ?? 0,
      transactionHash: e.transaction_hash ?? '0x0',
    };
  } catch {
    return null;
  }
}

type EventsProvider = {
  getEvents(filter: {
    address: string;
    from_block: { block_number: number };
    to_block: 'latest' | { block_number: number };
    keys: string[][];
    chunk_size: number;
    continuation_token?: string;
  }): Promise<{ events: RawEvent[]; continuation_token?: string }>;
};

/** Every `KeySet` and `KeyRemoved` event of the registry from `fromBlock`, oldest first. */
export async function registryEvents(provider: EventsProvider, address: string, fromBlock: number, toBlock: 'latest' | number = 'latest'): Promise<RegistryEvent[]> {
  const out: RegistryEvent[] = [];
  let continuation_token: string | undefined;
  do {
    const chunk = await provider.getEvents({
      address,
      from_block: { block_number: fromBlock },
      to_block: toBlock === 'latest' ? 'latest' : { block_number: toBlock },
      keys: [[KEY_SET_SELECTOR, KEY_REMOVED_SELECTOR]],
      chunk_size: 1000,
      continuation_token,
    });
    for (const raw of chunk.events) {
      const event = parseRegistryEvent(raw);
      if (event) out.push(event);
    }
    continuation_token = chunk.continuation_token;
  } while (continuation_token);
  return out;
}

const UNKNOWN_KID = 'UNKNOWN_KID';
const UNKNOWN_KID_FELT = shortString.encodeShortString(UNKNOWN_KID).replace(/^0x0*/, '');

/**
 * The key the registry stores for (iss, kid), as 24 limbs, read from
 * storage with `get_key`. null when the registry has no such key. Any other failure throws, so
 * a node error can never be mistaken for "no key".
 */
export async function storedKey(ctx: { provider: { callContract(call: { contractAddress: string; entrypoint: string; calldata: string[] }): Promise<string[]> }; registryContractAddress: string }, iss: string, kid: string): Promise<bigint[] | null> {
  let felts: string[];
  try {
    felts = await ctx.provider.callContract({
      contractAddress: ctx.registryContractAddress,
      entrypoint: 'get_key',
      calldata: CallData.compile([byteArray.byteArrayFromString(iss), byteArray.byteArrayFromString(kid)]),
    });
  } catch (e) {
    const text = `${(e as Error).message ?? ''} ${JSON.stringify((e as { baseError?: unknown }).baseError ?? '')}`;
    if (text.includes(UNKNOWN_KID) || text.toLowerCase().includes(UNKNOWN_KID_FELT)) return null;
    throw e;
  }
  if (felts.length !== 24) throw new Error(`get_key returned ${felts.length} felts, expected 24`);
  return felts.map(BigInt);
}
