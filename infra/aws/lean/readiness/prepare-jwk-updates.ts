// Off-server, capture-only Google JWK planner. No signer or broadcast path exists.
import { createRequire } from 'node:module';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { syncOnce, type Ctx } from '../../../../services/backend/src/services/rotator/jwk-rotator';
import { setLogSink } from '../../../../services/backend/src/log';

const require = createRequire(new URL('../../../../services/backend/package.json', import.meta.url));
const { RpcProvider, hash } = require('starknet');
const GOOGLE = 'https://accounts.google.com';
const RPC = 'https://api.zan.top/public/starknet-sepolia/rpc/v0_10';
const REVOKER = hash.getSelectorFromName('REVOKER_ROLE');
const PRIME = 2n ** 251n + 17n * 2n ** 192n + 1n;
const publicFelt = (value: unknown): string => {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(value) || BigInt(value) === 0n || BigInt(value) >= PRIME) throw Error('PUBLIC_FELT_REQUIRED');
  return '0x' + BigInt(value).toString(16);
};

export type UnsignedCall = { contractAddress: string; entrypoint: string; calldata: string[] };
export type PlanningReads = Omit<Ctx, 'registryOwner' | 'assertPaidAvailable'>;

/** A unique thrown object stops syncOnce before receipt waiting or any 'updated' log.
 * An upstream error with the same text is not mistaken for successful capture.
 */
export async function collectGoogleJwkCalls(reads: PlanningReads): Promise<UnsignedCall[]> {
  const captured: UnsignedCall[] = [];
  const stop = new Error('UNSIGNED_JWK_PLAN_CAPTURED');
  const context: Ctx = {
    ...reads,
    registryOwner: { execute: async (calls) => {
      captured.push(...calls.map(call => ({contractAddress:call.contractAddress,entrypoint:call.entrypoint,calldata:[...(call.calldata as string[])]})));
      throw stop;
    } },
  };
  try { await syncOnce(context, GOOGLE); }
  catch (error) { if (error !== stop) throw error; }
  return captured;
}

async function input(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.mode & 0o077 || stat.size > 4096) throw Error('PRIVATE_INPUT_REQUIRED');
    const bytes = Buffer.alloc(4097);
    const {bytesRead} = await handle.read(bytes,0,bytes.length,0);
    if (bytesRead > 4096) throw Error('PRIVATE_INPUT_REQUIRED');
    return JSON.parse(bytes.subarray(0,bytesRead).toString('utf8'));
  } finally {await handle.close();}
}

async function writePlan(path: string, plan: object) {
  if (!isAbsolute(path)) throw Error('PRIVATE_OUTPUT_REQUIRED');
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(JSON.stringify(plan,null,2)+'\n'); await file.sync(); }
  finally {await file.close();}
}


/** The selected dedicated immutable KMS account must still match its reviewed class/key. */
export async function assertPinnedK1Admin(provider: {
  getClassHashAt: (address: string) => Promise<string>;
  callContract: (call: {contractAddress:string;entrypoint:string;calldata:string[]}) => Promise<string[]>;
}, account: string, expectedClass: unknown, expectedKey: unknown): Promise<void> {
  const reviewedClass = publicFelt(expectedClass);
  if (typeof expectedKey !== 'string' || !/^0x04[0-9a-fA-F]{128}$/.test(expectedKey)) throw Error('K1_PUBLIC_KEY_REQUIRED');
  const x=BigInt('0x'+expectedKey.slice(4,68)),y=BigInt('0x'+expectedKey.slice(68));
  const p=(1n<<256n)-(1n<<32n)-977n;
  if (x>=p || y>=p || (x===0n && y===0n) || ((y*y-x*x*x-7n)%p+p)%p!==0n) throw Error('K1_PUBLIC_KEY_INVALID');
  if (BigInt(await provider.getClassHashAt(account))!==BigInt(reviewedClass)) throw Error('NEW_ADMINISTRATOR_CLASS_CHANGED');
  const raw=await provider.callContract({contractAddress:account,entrypoint:'get_public_key',calldata:[]});
  if (!Array.isArray(raw) || raw.length!==4 || raw.some(value=>typeof value!=='string' || !/^0x[0-9a-fA-F]+$/.test(value) || BigInt(value)>=(1n<<128n))) throw Error('NEW_ADMINISTRATOR_PUBLIC_KEY_INVALID');
  const limbs=raw.map(BigInt);
  if (limbs[0]+(limbs[1]<<128n)!==x || limbs[2]+(limbs[3]<<128n)!==y) throw Error('NEW_ADMINISTRATOR_PUBLIC_KEY_CHANGED');
}

async function main() {
  const [configPath, fromBlockText, output, ...extra] = process.argv.slice(2);
  if (!configPath || !output || !fromBlockText || !/^\d+$/.test(fromBlockText) || extra.length) throw Error('USAGE_PUBLIC_HANDOFF_INPUT_FROM_BLOCK_PRIVATE_OUTPUT');
  const fromBlock = Number(fromBlockText);
  if (!Number.isSafeInteger(fromBlock) || fromBlock < 0) throw Error('START_BLOCK_INVALID');
  const config = await input(configPath);
  if (Object.keys(config).sort().join(',') !== ['expectedRegistryClassHash','newAdministratorAccount','oldAdministratorAccount','registry','expectedNewAdministratorClassHash','expectedNewAdministratorPublicKey','controllerProofTransactionHash'].sort().join(',')) throw Error('HANDOFF_INPUT_INVALID');
  const registry = publicFelt(config.registry), administrator = publicFelt(config.newAdministratorAccount), old = publicFelt(config.oldAdministratorAccount);
  const expectedClass = publicFelt(config.expectedRegistryClassHash);
  publicFelt(config.controllerProofTransactionHash); // Full proof receipt is verified by registry_handoff.py verify before operating.
  if (administrator === old) throw Error('REGISTRY_SIGNERS_MUST_DIFFER');
  const provider = new RpcProvider({nodeUrl:RPC,baseFetch:(url: any,options: any)=>fetch(url,{...options,signal:AbortSignal.timeout(30_000)})});
  if (BigInt(await provider.getChainId()) !== BigInt('0x'+Buffer.from('SN_SEPOLIA').toString('hex'))) throw Error('WRONG_CHAIN');
  if (BigInt(await provider.getClassHashAt(registry)) !== BigInt(expectedClass)) throw Error('REGISTRY_CLASS_CHANGED');
  await assertPinnedK1Admin(provider,administrator,config.expectedNewAdministratorClassHash,config.expectedNewAdministratorPublicKey);
  for (const role of ['0x0',REVOKER]) {
    const current = await provider.callContract({contractAddress:registry,entrypoint:'has_role',calldata:[role,administrator]});
    const previous = await provider.callContract({contractAddress:registry,entrypoint:'has_role',calldata:[role,old]});
    if (current.length !== 1 || BigInt(current[0]) !== 1n || previous.length !== 1 || BigInt(previous[0]) !== 0n) throw Error('REGISTRY_HANDOFF_INCOMPLETE');
  }
  const previousSink = setLogSink(()=>{});
  let calls: UnsignedCall[];
  try {
    calls = await collectGoogleJwkCalls({provider,registryContractAddress:registry,fromBlock});
  } finally {setLogSink(previousSink);}
  if (BigInt(await provider.getClassHashAt(registry)) !== BigInt(expectedClass)) throw Error('REGISTRY_CLASS_CHANGED');
  await assertPinnedK1Admin(provider,administrator,config.expectedNewAdministratorClassHash,config.expectedNewAdministratorPublicKey);
  await writePlan(output,{version:1,network:'SN_SEPOLIA',preparedAt:new Date().toISOString(),registry,registryClassHash:expectedClass,executorAccount:administrator,
    issuer:GOOGLE,calls,containsRevocations:calls.some(call=>call.entrypoint==='remove_key'),
    warning:'REVIEW_REVOCATIONS_INVALIDATE_IN_FLIGHT_PROOFS_AND_PENDING_OVERRIDES',
    signingOrBroadcastPerformed:false,readWindow:'Multiple public reads; recheck before wallet signing, not an atomic state snapshot'});
  console.log(JSON.stringify({status:'unsigned_jwk_plan_prepared',calls:calls.length,signingOrBroadcastPerformed:false}));
}

if (import.meta.main) void main().catch(()=>{console.error('{"status":"refused","error":"JWK_PLAN_PREPARATION_FAILED","signingOrBroadcastPerformed":false}');process.exitCode=1;});
