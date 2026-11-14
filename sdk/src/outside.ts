// Sponsored calls: SNIP-9 v2 outside execution, signed by an owner or by a session and sent by
// anyone (a relayer or paymaster). See contracts/src/core.cairo.
import {
  CallData,
  OutsideExecutionVersion,
  hash,
  outsideExecution,
  typedData,
  type BigNumberish,
  type Call,
} from 'starknet';
import { ANY_CALLER } from './constants';
import type { KamuiReader } from './reader';
import { sessionSignature } from './sessions';
import { randomFelt, signHash, toHex } from './utils';

export type OutsideWindow = {
  /** Who may submit it. Defaults to anyone. */
  caller?: string;
  /** Unix seconds; the call is valid strictly after this. Defaults to 0. */
  executeAfter?: number;
  /** Unix seconds; the call is valid strictly before this. */
  executeBefore: number;
};

const windowOf = (w: OutsideWindow) => ({
  caller: w.caller ?? ANY_CALLER,
  executeAfter: w.executeAfter ?? 0,
  executeBefore: w.executeBefore,
});

/** The SNIP-12 hash an owner or session signs for an outside execution. */
export function outsideExecutionHash(
  chainId: string,
  account: string,
  calls: Call[],
  nonce: BigNumberish,
  window: OutsideWindow,
): string {
  const w = windowOf(window);
  const data = outsideExecution.getTypedData(
    chainId as Parameters<typeof outsideExecution.getTypedData>[0],
    { caller: w.caller, execute_after: w.executeAfter, execute_before: w.executeBefore },
    toHex(nonce),
    calls,
    OutsideExecutionVersion.V2,
  );
  return typedData.getMessageHash(data, account);
}

/** The `execute_from_outside_v2` call a relayer sends, given the signature. */
export function outsideExecutionCall(
  account: string,
  calls: Call[],
  nonce: BigNumberish,
  window: OutsideWindow,
  signature: string[],
): Call {
  const w = windowOf(window);
  const flat = calls.flatMap((call) => {
    const data = CallData.compile(call.calldata ?? []).map((felt) => toHex(felt));
    return [call.contractAddress, hash.getSelectorFromName(call.entrypoint), toHex(data.length), ...data];
  });
  return {
    contractAddress: account,
    entrypoint: 'execute_from_outside_v2',
    calldata: [
      w.caller,
      toHex(nonce),
      toHex(w.executeAfter),
      toHex(w.executeBefore),
      toHex(calls.length),
      ...flat,
      toHex(signature.length),
      ...signature,
    ],
  };
}

/** A sponsored call signed by an owner key. Any unused nonce works; a random one is picked. */
export function ownerOutsideExecution(args: {
  chainId: string;
  account: string;
  calls: Call[];
  ownerPrivateKey: string;
  window: OutsideWindow;
  nonce?: BigNumberish;
}): Call {
  const nonce = args.nonce ?? randomFelt();
  const messageHash = outsideExecutionHash(args.chainId, args.account, args.calls, nonce, args.window);
  return outsideExecutionCall(args.account, args.calls, nonce, args.window, signHash(messageHash, args.ownerPrivateKey));
}

/**
 * A sponsored call signed by a session key. The nonce must be one of the session's reserved
 * nonces (`nextSessionNonce`); the contract refuses any other.
 */
export function sessionOutsideExecution(args: {
  chainId: string;
  account: string;
  calls: Call[];
  session: { privateKey: string; publicKey: string; validUntil: number };
  nonce: BigNumberish;
  window?: OutsideWindow;
}): Call {
  const window = args.window ?? { executeBefore: args.session.validUntil };
  const messageHash = outsideExecutionHash(args.chainId, args.account, args.calls, args.nonce, window);
  return outsideExecutionCall(args.account, args.calls, args.nonce, window, sessionSignature(messageHash, args.session));
}

export type SessionNonceOptions = {
  /**
   * Where to look first: the offset after the last one handed out. A good hint makes the search
   * one read. A wrong one costs reads, never correctness.
   */
  hint?: number;
  /**
   * When the search finds nothing free, read every offset not read yet before answering null
   * (default true). Nonces are normally used in order, but the account accepts them in any
   * order, so a call that was signed and never sent leaves a free nonce behind used ones.
   * Costs up to `maxCalls` reads, once, on a session that is used up.
   */
  scanGaps?: boolean;
  /** How many reads the gap scan sends at once (default 8). */
  concurrency?: number;
};

/** The two account reads the nonce search needs. `KamuiReader` has them. */
export type SessionNonceReader = Pick<KamuiReader, 'sessionNonceBase' | 'isOutsideNonceAvailable'>;

/**
 * An unused sponsored nonce of the session at or after `fromOffset`, or null if there is none.
 *
 * The account has no counter of used session nonces, so this searches the reserved range
 * `[base, base + maxCalls)`: the offset at `hint` first, then doubling steps until a free one is
 * found, then a binary search between the last used and the first free one. With `n` nonces used
 * in order that is 1 read with a good hint and about `2·log2(n)` without, instead of `n`.
 *
 * The result is always a nonce the account reported free. It is the lowest free one when the
 * nonces were used in order; when some were skipped, the skipped ones are found by the gap scan
 * once nothing else is left (see `scanGaps`).
 */
export async function nextSessionNonce(
  reader: SessionNonceReader,
  sessionPublicKey: string,
  maxCalls: number,
  fromOffset = 0,
  options: SessionNonceOptions = {},
): Promise<{ nonce: string; offset: number } | null> {
  const base = BigInt(await reader.sessionNonceBase(sessionPublicKey));
  return searchSessionNonce(reader, base, maxCalls, fromOffset, options);
}

/** `nextSessionNonce` for a caller that has already read the session's nonce base. */
export async function searchSessionNonce(
  reader: Pick<KamuiReader, 'isOutsideNonceAvailable'>,
  base: bigint,
  maxCalls: number,
  fromOffset = 0,
  options: SessionNonceOptions = {},
): Promise<{ nonce: string; offset: number } | null> {
  const floor = Math.max(0, Math.floor(fromOffset));
  const last = maxCalls - 1;
  const nonceAt = (offset: number) => toHex(base + BigInt(offset));
  const found = (offset: number) => ({ nonce: nonceAt(offset), offset });

  // What the account said about each offset read so far: true is free.
  const seen = new Map<number, boolean>();
  const isFree = async (offset: number) => {
    let free = seen.get(offset);
    if (free === undefined) {
      free = await reader.isOutsideNonceAvailable(nonceAt(offset));
      seen.set(offset, free);
    }
    return free;
  };

  const start = Math.max(floor, Math.floor(options.hint ?? 0));
  if (start <= last) {
    if (await isFree(start)) return found(start);
    // `used` is taken; step away from it, doubling, until an offset is free or the range ends.
    let used = start;
    for (let step = 1; used < last; step *= 2) {
      const probe = Math.min(used + step, last);
      if (!(await isFree(probe))) {
        used = probe;
        continue;
      }
      // `used` is taken and `free` is not: close in on a neighbouring pair between them.
      let free = probe;
      while (free - used > 1) {
        const middle = used + Math.floor((free - used) / 2);
        if (await isFree(middle)) free = middle;
        else used = middle;
      }
      return found(free);
    }
  }

  if (options.scanGaps === false) return null;
  const size = Math.max(1, Math.floor(options.concurrency ?? 8));
  const unread: number[] = [];
  for (let offset = floor; offset <= last; offset++) if (!seen.has(offset)) unread.push(offset);
  for (let i = 0; i < unread.length; i += size) {
    const chunk = unread.slice(i, i + size);
    const free = await Promise.all(chunk.map(isFree));
    const index = free.indexOf(true);
    if (index !== -1) return found(chunk[index]!);
  }
  return null;
}
