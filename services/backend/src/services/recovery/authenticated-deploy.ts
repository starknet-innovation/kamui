// Authenticate a first deployment, without executing or proving the token on the server.
import { accountAddress, deployCall, extractIdentity } from '../../social-account';
import { verifyJwt } from '../../jwk/verification';
import { HttpError } from '../../http';
import { HOUR } from '../../limiter';
import { assertPepperShape, confirmPepper } from './pepper';
import { isDeployed, precheckRecover, type RecoverContext, type RecoverRequest } from './recover';
import type { RecoveryJournal } from './jobs';
import { journaledTransaction, waitForAcceptedTransaction } from './transaction';

export async function prepareDeployment(req: RecoverRequest, ip: string, ctx: RecoverContext) {
  if (req.override) throw new HttpError(400, 'OVERRIDE_NOT_SUPPORTED');
  const token = precheckRecover(req, ctx);
  await verifyJwt(token, await ctx.jwks.keys(token.iss, token.kid));
  assertPepperShape(req.pepper, ctx.pepper);
  const identity = extractIdentity(token, req.pepper);
  const address = accountAddress(token.aud, identity, ctx.classHash);
  if (BigInt(address) !== BigInt(req.account)) throw new HttpError(400, 'WRONG_ACCOUNT');
  return async (journal?: RecoveryJournal) => {
    if (!journal) throw new HttpError(503, 'DURABLE_JOURNAL_REQUIRED');
    // Existing accounts never need a token/pepper service call in the normal client flow.
    if (await isDeployed(ctx.provider, address)) return { address, identity, transaction_hash: '0x0' };
    if (ctx.deploysPerHour === 0) throw new HttpError(403, 'DEPLOY_DISABLED');
    await confirmPepper(req, ctx.pepper);
    if (!(await ctx.limiter.take(`deploy:${ip}`, 3, HOUR))) throw new HttpError(429, 'RATE_LIMITED');
    if (!(await ctx.limiter.take('deploy', ctx.deploysPerHour, HOUR))) throw new HttpError(429, 'DEPLOY_CAP');
    const transaction_hash = await journaledTransaction(ctx, deployCall(token.aud, identity, ctx.classHash), {}, journal, 'prepare', { address, identity });
    await waitForAcceptedTransaction(ctx.provider, transaction_hash);
    return { address, identity, transaction_hash };
  };
}
