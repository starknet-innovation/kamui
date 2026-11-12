// POST /relay: submits `recover` with a proof the browser generated. The JWT is not sent to this route. Everything below runs before the relayer pays: shape, markers, a base block old enough to have a stored hash, one relay
// per account at a time, the account's class and keys, and that the facts bind exactly the
// recovery requested (account, identity, new key, owners anchor, override flag). What slips past
// still reverts at the free fee estimate in relayRecover.
import { RpcError, shortString } from 'starknet';
import { accountAddress, recoverMessageHash } from '../../social-account';
import { HttpError } from '../../http';
import { HOUR } from '../../limiter';
import { log } from '../../log';
import { relayRecover, type RecoverContext } from './recover';

export type RelayRequest = {
  account: string;
  newPubkey: string;
  signature: string[];
  /** The SNIP-36 proof, base64. */
  proof: string;
  /** 9 felts: PROOF2, VIRTUAL_SNOS, program hash, VIRTUAL_SNOS0, base block, base hash, config hash, 1, message hash. */
  proofFacts: string[];
  override?: boolean;
};
export type RelayResult = { address: string; identity: string; transaction_hash: string; override: boolean };

/** Decoded proof cap enforced by the gateway (max_proof_size on 0.14.5). */
export const MAX_PROOF_BYTES = 480_000;
/**
 * The chain only accepts a proof whose base block has a stored hash: at least this many blocks
 * old (STORED_BLOCK_HASH_BUFFER in the blockifier). The contract caps the age at
 * PROOF_VALIDITY_BLOCKS for both recovery paths; the relay does not, and an old proof reverts
 * at the free fee estimate.
 */
export const MIN_PROOF_AGE_BLOCKS = 10;
const OVERRIDES_PER_IP = 5;
const FIELD_PRIME = 2n ** 251n + 17n * 2n ** 192n + 1n;
const felt = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(v) && BigInt(v) < FIELD_PRIME;
const V2_HEADER = Buffer.from('020400098446bd35fd2272efe19bf43aac7037b3b7e25e86d94170d95198245bbb8dc7', 'hex');
// Pinned v1.0.1 executor's Sepolia V4 config. Upstream OsChainInfo hashes only
// [StarknetOsConfig4, chain_id, STRK fee token] (no public keys for virtual OS),
// independent of block number/hash. V4 applies from Starknet 0.14.3; future
// network/profile changes must review this pin with the program and circuit.
const SEPOLIA_V2_CONFIG = BigInt('0x57ed4d5e20d617d8cc087a5882eae4f71d005172326be6439b2e1fd8b4dc57');
const tag = (s: string) => BigInt(shortString.encodeShortString(s));
const MARKERS: [number, bigint][] = [[0, tag('PROOF2')], [1, tag('VIRTUAL_SNOS')], [3, tag('VIRTUAL_SNOS0')], [7, 1n]];

export type ParsedRelay = RelayRequest & { override: boolean; baseBlock: number; proofBytes: number };

export function parseRelayRequest(req: RelayRequest): ParsedRelay {
  if (!felt(req.account) || BigInt(req.account) === 0n) {
    throw new HttpError(400, 'BAD_ACCOUNT');
  }
  if (!felt(req.newPubkey) || BigInt(req.newPubkey) === 0n) {
    throw new HttpError(400, 'BAD_PUBLIC_KEY');
  }
  if (!Array.isArray(req.signature) || req.signature.length !== 2 || !req.signature.every(felt)) {
    throw new HttpError(400, 'BAD_SIGNATURE_FORMAT');
  }
  if (!Array.isArray(req.proofFacts) || req.proofFacts.length !== 9 || !req.proofFacts.every(felt)) {
    throw new HttpError(400, 'BAD_PROOF_FACTS');
  }
  if (req.override !== undefined && typeof req.override !== 'boolean') throw new HttpError(400, 'BAD_OVERRIDE');
  if (typeof req.proof !== 'string' || req.proof.length > Math.ceil(MAX_PROOF_BYTES / 3) * 4 || req.proof.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(req.proof)) {
    throw new HttpError(400, 'BAD_PROOF');
  }

  const bytes = Buffer.from(req.proof, 'base64');
  if (bytes.toString('base64') !== req.proof) throw new HttpError(400, 'BAD_PROOF');
  if (bytes.length <= V2_HEADER.length || !bytes.subarray(0, V2_HEADER.length).equals(V2_HEADER)) throw new HttpError(400, 'BAD_PROOF_PROFILE');
  const proofBytes = bytes.length;
  if (BigInt(req.proofFacts[2]) !== BigInt('0x1c7be3225dfb33359b3ba9ffbe1542b7da27879b6d89f47b967e512463fd324') || BigInt(req.proofFacts[6]) !== SEPOLIA_V2_CONFIG) throw new HttpError(400, 'BAD_PROOF_FACTS');
  if (proofBytes < 1 || proofBytes > MAX_PROOF_BYTES) {
    throw new HttpError(400, 'BAD_PROOF');
  }

  for (const [i, value] of MARKERS) {
    if (BigInt(req.proofFacts[i]) !== value) {
      throw new HttpError(400, 'BAD_PROOF_FACTS');
    }
  }

  const baseBlock = Number(BigInt(req.proofFacts[4]));
  if (!Number.isSafeInteger(baseBlock)) {
    throw new HttpError(400, 'BAD_PROOF_FACTS');
  }

  return { ...req, override: req.override === true, baseBlock, proofBytes };
}

export type ChainView = { head: number; classHash: string; identity: string; currentPubkey: string };

export function checkRelay(req: ParsedRelay, chain: ChainView, ctx: Pick<RecoverContext, 'classHash' | 'audiences'>): string {
  if (chain.head - req.baseBlock < MIN_PROOF_AGE_BLOCKS) {
    throw new HttpError(400, 'PROOF_TOO_RECENT');
  }

  if (BigInt(chain.classHash) !== BigInt(ctx.classHash)) {
    throw new HttpError(400, 'WRONG_CLASS');
  }

  const expected = recoverMessageHash(req.account, chain.identity, req.newPubkey, chain.currentPubkey, req.override);
  if (BigInt(req.proofFacts[8]) !== expected) {
    throw new HttpError(400, 'PROOF_MISMATCH');
  }

  if (!req.override && !Object.values(ctx.audiences).some((aud) => BigInt(accountAddress(aud, chain.identity, ctx.classHash)) === BigInt(req.account))) {
    throw new HttpError(400, 'WRONG_AUDIENCE');
  }

  return chain.identity;
}

const inFlight = new Set<string>();

export async function relayProof(body: RelayRequest, ip: string, ctx: RecoverContext): Promise<RelayResult> {
  // Validate the request
  const req = parseRelayRequest(body);
  if (!ctx.journal) ctx.assertRecoveryAvailable?.(req.account);
  const head = await ctx.provider.getBlockNumber();

  // Avoid duplicate requests
  const key = BigInt(req.account).toString(16);
  if (inFlight.has(key)) {
    throw new HttpError(409, 'IN_PROGRESS');
  }

  inFlight.add(key);

  try {
    let classHash: string;
    try {
      classHash = await ctx.provider.getClassHashAt(req.account);
    } catch (e) {
      if (e instanceof RpcError && e.isType('CONTRACT_NOT_FOUND')) throw new HttpError(400, 'ACCOUNT_NOT_DEPLOYED');
      throw e;
    }

    const [[identity], [currentPubkey]] = await Promise.all([
      ctx.provider.callContract({ contractAddress: req.account, entrypoint: 'identity' }),
      // Kamui: the proof binds the owners anchor where upstream bound the account's single key.
      ctx.provider.callContract({ contractAddress: req.account, entrypoint: 'get_owners_anchor' }),
    ]);

    checkRelay(req, { head, classHash, identity, currentPubkey }, ctx);

    if (req.override && !(await ctx.limiter.take(`override:${ip}`, OVERRIDES_PER_IP, HOUR))) {
      throw new HttpError(429, 'RATE_LIMITED');
    }

    const transaction_hash = await relayRecover(req.account, req.newPubkey, req.signature, req.proof, req.proofFacts, ctx, { address: req.account, identity });
    log('info', req.override ? 'override_recovery_pending' : 'recovered', { account: req.account, tx: transaction_hash, proving: 'browser', bytes: req.proofBytes });

    return {
      address: req.account,
      identity,
      transaction_hash,
      override: req.override
    };
  } finally {
    inFlight.delete(key);
  }
}
