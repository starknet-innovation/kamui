import { Account, CallData, RpcError, RpcProvider, type Call } from 'starknet';
import { HttpError } from '../../http';
import { ISSUERS, extractJwt, verifyJwt, type Jwk, type Jwt } from '../../jwk/verification';
import type { Limiter } from '../../limiter';
import { errorCode, log } from '../../log';
import { metrics } from '../../metrics';
import { accountAddress, deployCall, expectedNonce, extractIdentity } from '../../social-account';
import type { Proof } from '../prover/prove';
import type { ProofQueue } from '../prover/queue';
import type { RecoveryJournal } from './jobs';
import { journaledTransaction, withRelayerLock, waitForAcceptedTransaction } from './transaction';
import { assertPepperShape, confirmPepper, type PepperSettings } from './pepper';

export type RecoverContext = {
  provider: RpcProvider;
  /** Durable paid-send intent journal; supplied only by the job executor. */
  journal?: RecoveryJournal;
  /** Prevent legacy routes from starting while a durable recovery is unresolved. */
  assertRecoveryAvailable?: (account: string) => void | Promise<void>;
  /** Funded. Deploys accounts and submits recover. */
  relayer: Account;
  /** The SNIP-36 prover and the unfunded account that signs its virtual transaction. */
  prover?: { account: Account; url: string };
  classHash: string;
  /** The `aud` this backend serves per `iss`. A token from an issuer not listed here is refused. */
  audiences: Record<string, string>;
  /** Cap on relayer-paid deployments through POST /deploy. 0 disables the route. */
  deploysPerHour: number;
  /** Kamui: how the pepper in a request is confirmed before anything is paid for. */
  pepper: PepperSettings;
  /** Kamui: the issuers' keys, cached (jwk/verification.ts). */
  jwks: { keys(iss: string, kid?: string): Promise<Jwk[]> };
  /** Kamui: the limiter behind every cap in these routes (limiter.ts). */
  limiter: Limiter;
  /** Kamui: bounds how many proofs run and wait (prover/queue.ts). */
  proofs: ProofQueue;
  /** Kamui: deadline for one proof. Defaults to prove.ts's ten minutes. */
  proverTimeoutMs?: number;
  /** Kamui: replaces the call to the prover in tests. */
  prove?: (call: Call) => Promise<Proof>;
};
export type RecoverRequest = {
  jwt: string;
  account: string;
  newPubkey: string;
  blinding: string;
  /** Secret input of the identity hash, see `extractIdentity`. Confirmed with the pepper service. */
  pepper: string;
  /** Kamui: the device key's signature for the pepper service. Required when one is configured. */
  keyProof?: string[];
  signature: string[];
  /** 
   * This flag is used to denote that a recovery override is requested
   * 
   * The JWT's aud is a whitelisted recovery aud, not the one `account` 
   * was created with. 
   */
  override?: boolean;
};
export type RecoverResult = { address: string; identity: string; transaction_hash: string };

export const HEX = /^0x[0-9a-fA-F]+$/;

/** Longer than any Google or Apple ID token; bounds what is parsed before anything is verified. */
export const MAX_JWT_LENGTH = 8_192;

/**
 * Kamui (audit finding #3): everything that can be checked from the request alone, before any
 * outbound call. The claims are not trusted yet; a token that fails here would fail later too.
 */
export function precheckRecover(req: RecoverRequest, ctx: Pick<RecoverContext, 'audiences'>, now = Date.now()): Jwt {
  if (!Array.isArray(req.signature) || req.signature.length !== 2 || !req.signature.every((s) => typeof s === 'string' && HEX.test(s)))
    throw new HttpError(400, 'BAD_SIGNATURE_FORMAT');
  if (!HEX.test(req.newPubkey)) throw new HttpError(400, 'BAD_PUBLIC_KEY');
  if (!HEX.test(req.blinding)) throw new HttpError(400, 'BAD_BLINDING');
  if (!HEX.test(req.pepper)) throw new HttpError(400, 'BAD_PEPPER');
  if (!HEX.test(req.account)) throw new HttpError(400, 'BAD_ACCOUNT');
  if (req.jwt.length > MAX_JWT_LENGTH) throw new HttpError(400, 'BAD_JWT');

  let token: Jwt;
  try {
    token = extractJwt(req.jwt);
  } catch (e) {
    // A JSON error would echo part of the token; only our own codes pass.
    const code = errorCode(e);
    throw new HttpError(400, ['BAD_JWT', 'UNSUPPORTED_ALG', 'BAD_PAYLOAD'].includes(code) ? code : 'BAD_JWT');
  }
  if (!ISSUERS.some((i) => i.iss === token.iss)) throw new HttpError(400, 'WRONG_ISSUER');
  if (token.aud !== ctx.audiences[token.iss]) throw new HttpError(400, 'WRONG_AUDIENCE');
  if (typeof token.exp !== 'number' || token.exp <= now / 1000) throw new HttpError(400, 'TOKEN_EXPIRED');
  if (typeof token.nonce !== 'string' || !/^0x[0-9a-f]{1,64}$/.test(token.nonce)) throw new HttpError(400, 'BAD_NONCE');
  if (BigInt(token.nonce) !== expectedNonce(req.newPubkey, req.blinding)) throw new HttpError(400, 'NONCE_MISMATCH');
  return token;
}

// Kamui: one recovery per account at a time, so two requests cannot both deploy or both queue a proof.
const recovering = new Set<string>();

/** Authenticate before a job occupies retained storage; paid work runs only when invoked. */
export async function prepareRecovery(req: RecoverRequest, ctx: RecoverContext): Promise<(journal?: RecoveryJournal) => Promise<RecoverResult>> {
  const token = precheckRecover(req, ctx);
  const jwk = await verifyJwt(token, await ctx.jwks.keys(token.iss, token.kid));
  assertPepperShape(req.pepper, ctx.pepper);
  return (journal) => runRecovery(req, journal ? { ...ctx, journal } : ctx, token, jwk);
}

export async function recoverAccount(req: RecoverRequest, ctx: RecoverContext): Promise<RecoverResult> {
  return (await prepareRecovery(req, ctx))();
}

async function runRecovery(req: RecoverRequest, ctx: RecoverContext, token: Jwt, jwk: Jwk): Promise<RecoverResult> {
  // Kamui: refuse now, before a deployment, if the proof could not even be queued.
  if (ctx.proofs.full) {
    metrics.proofs.inc({ result: 'refused' });
    throw new HttpError(503, 'PROVER_BUSY');
  }

  const inFlightKey = BigInt(req.account).toString(16);
  if (recovering.has(inFlightKey)) throw new HttpError(409, 'IN_PROGRESS');
  recovering.add(inFlightKey);
  try {
    let address: string;
    let identity: string;
    if (req.override) {
      // The account belongs to another aud. prove_jwt checks h(iss, original_aud, sub) and the whitelist.
      if (!(await isDeployed(ctx.provider, req.account))) throw new Error('ACCOUNT_NOT_DEPLOYED');
      address = req.account;
      [identity] = (await ctx.provider.callContract({ contractAddress: address, entrypoint: 'identity' })) as [string];
    } else {
      identity = extractIdentity(token, req.pepper);
      address = accountAddress(token.aud, identity, ctx.classHash);
      if (BigInt(address) !== BigInt(req.account)) throw new Error('WRONG_ACCOUNT');

      if (!(await isDeployed(ctx.provider, address))) {
        // Kamui: the pepper is confirmed with the pepper service before the relayer deploys an
        // account for it, so nobody can have accounts deployed for made-up peppers. An account
        // that already exists needs no confirmation: its address was derived from this very
        // pepper, and `prove_jwt` checks the identity again on chain. That is also what lets a
        // user sign in from a recovery file when the pepper service is unavailable or lost.
        await confirmPepper(req, ctx.pepper);
        const call = deployCall(token.aud, identity, ctx.classHash);
        const transaction_hash = ctx.journal
          ? await journaledTransaction(ctx, call, {}, ctx.journal, 'deploy', { address, identity })
          : (await withRelayerLock(ctx.relayer, () => ctx.relayer.execute(call))).transaction_hash;
        metrics.relayerTransactions.inc({ kind: 'deploy' });
        await waitForAcceptedTransaction(ctx.provider, transaction_hash);
        log('info', 'account_deployed', { account: address, tx: transaction_hash });
        await ctx.journal?.deploymentConfirmed();
      }
    }

    const { proveJwtCalldata } = await import('../prover/prove');
    const prove: Call = {
      contractAddress: address,
      entrypoint: 'prove_jwt',
      calldata: proveJwtCalldata(req.jwt, token, jwk, req.newPubkey, req.blinding, req.pepper),
    };
    const { proof, proof_facts } = await ctx.proofs.run(() => timedProof(prove, ctx));
    const transaction_hash = await relayRecover(address, req.newPubkey, req.signature, proof, proof_facts, ctx, { address, identity });
    log('info', req.override ? 'override_recovery_pending' : 'recovered', { account: address, tx: transaction_hash, proving: 'backend' });
    return { address, identity, transaction_hash };
  } finally {
    recovering.delete(inFlightKey);
  }
}

/** One proof, counted and timed. */
async function timedProof(call: Call, ctx: RecoverContext): Promise<Proof> {
  const started = Date.now();
  metrics.proofs.inc({ result: 'started' });
  try {
    const { proveJwt } = await import('../prover/prove');
    const proof = await (ctx.prove ? ctx.prove(call) : proveJwt(call, ctx.provider, ctx.prover!.account, ctx.prover!.url, ctx.proverTimeoutMs));
    metrics.proofs.inc({ result: 'succeeded' });
    metrics.proofSeconds.observe((Date.now() - started) / 1000);
    return proof;
  } catch (e) {
    metrics.proofs.inc({ result: 'failed' });
    metrics.outboundFailures.inc({ target: 'prover' });
    metrics.proofSeconds.observe((Date.now() - started) / 1000);
    throw e;
  }
}

/**
 * Submits `recover(newPubkey, signature)` from the relayer with the proof attached and waits for it.
 * starknet.js estimates the fee first with the facts attached, so a `recover` that would revert
 * throws here at no cost; that revert comes back as a 400 with the contract's reason.
 */
export async function relayRecover(
  address: string,
  newPubkey: string,
  signature: string[],
  proof: string,
  proofFacts: string[],
  ctx: Pick<RecoverContext, 'relayer' | 'provider' | 'journal'>,
  result?: Omit<RecoverResult, 'transaction_hash'>,
): Promise<string> {
  // The gateway rejects a decoded proof above max_proof_size (480,000 bytes on 0.14.5).
  log('debug', 'proof_ready', { account: address, bytes: Buffer.from(proof, 'base64').length, facts: proofFacts.length });
  let transaction_hash: string;
  try {
    const call = { contractAddress: address, entrypoint: 'recover', calldata: CallData.compile([newPubkey, signature]) };
    if (ctx.journal) {
      if (!result) throw new Error('RECOVERY_JOURNAL_RESULT_REQUIRED');
      transaction_hash = await journaledTransaction(ctx, call, { proof, proofFacts }, ctx.journal, 'recover', result);
    } else {
      ({ transaction_hash } = await withRelayerLock(ctx.relayer, () => ctx.relayer.execute(call, { proof, proofFacts })));
    }
  } catch (e) {
    if (e instanceof RpcError) throw new HttpError(400, `REVERTED: ${revertReason(e)}`);
    throw e;
  }
  metrics.relayerTransactions.inc({ kind: 'recover' });
  await waitForAcceptedTransaction(ctx.provider, transaction_hash);
  return transaction_hash;
}

/** The contract's failure reason out of an estimate error, without the request echo (which carries the proof). */
function revertReason(e: RpcError): string {
  const { data } = e.baseError as { data?: unknown };
  const text = typeof data === 'string' ? data : JSON.stringify(data ?? e.baseError.message);
  const felts = [...text.matchAll(/'([A-Za-z0-9_/-]+)'/g)].map((m) => m[1]).filter((s) => s !== 'ENTRYPOINT_FAILED');
  return felts.length ? felts.join(', ') : text.slice(0, 300);
}

/** True when a contract lives at `address`. Only "contract not found" counts as no. */
export async function isDeployed(provider: RpcProvider, address: string): Promise<boolean> {
  try {
    await provider.getClassHashAt(address);
    return true;
  } catch (e) {
    if (e instanceof RpcError && e.isType('CONTRACT_NOT_FOUND')) return false;
    throw e;
  }
}
