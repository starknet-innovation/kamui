// POST /deploy: the relayer pays for a social account deployment so a browser proving locally can
// run prove_jwt against it. The backend derives the address itself, so the request can only ever
// deploy the account its own class and audiences describe. Capped per IP and globally; this costs gas.
import type { RpcProvider } from 'starknet';
import { accountAddress, deployCall } from '../../social-account';
import { HttpError } from '../../http';
import { HOUR } from '../../limiter';
import { log } from '../../log';
import { metrics } from '../../metrics';
import { HEX, isDeployed, type RecoverContext } from './recover';

export type DeployRequest = { aud: string; identity: string };
export type DeployResult = { address: string; transaction_hash: string | null };

const DEPLOYS_PER_IP = 3;

export async function deployAccount(req: DeployRequest, ip: string, ctx: RecoverContext): Promise<DeployResult> {
  if (!Object.values(ctx.audiences).includes(req.aud)) throw new HttpError(400, 'WRONG_AUDIENCE');
  if (!HEX.test(req.identity)) throw new HttpError(400, 'BAD_IDENTITY');
  const address = accountAddress(req.aud, req.identity, ctx.classHash);
  if (await isDeployed(ctx.provider as RpcProvider, address)) return { address, transaction_hash: null };

  // Kamui: this route has no token, so the pepper behind `identity` cannot be confirmed. With a
  // pepper service configured, deployments only happen through /recover.
  if (ctx.deploysPerHour === 0 || ctx.pepper.serviceUrl) throw new HttpError(403, 'DEPLOY_DISABLED');
  if (!(await ctx.limiter.take(`deploy:${ip}`, DEPLOYS_PER_IP, HOUR))) throw new HttpError(429, 'RATE_LIMITED');
  if (!(await ctx.limiter.take('deploy', ctx.deploysPerHour, HOUR))) throw new HttpError(429, 'DEPLOY_CAP');

  const { transaction_hash } = await ctx.relayer.execute(deployCall(req.aud, req.identity, ctx.classHash));
  await ctx.provider.waitForTransaction(transaction_hash);
  metrics.relayerTransactions.inc({ kind: 'deploy' });
  // Kamui: the client address is not logged.
  log('info', 'account_deployed', { account: address, tx: transaction_hash });
  return { address, transaction_hash };
}
