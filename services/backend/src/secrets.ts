import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

// Kamui: where signing keys come from. The relayer, prover-account and registry-owner keys are
// read through this interface and nowhere else.
//
// Development can use the process environment; hosted services can use scoped private files. A managed secret store plugs in by
// implementing `SecretSource` (fetch the value by name at start, with the instance's own
// identity) and returning it from `secretSource`. That keeps the key out of the environment and
// out of deployment files, but the key is still in this process's memory.
//
// The stronger option does not use this interface at all: starknet.js accepts any
// `SignerInterface` where a private key is given, so the relayer can sign through a service
// that holds the key and never returns it (an HSM-backed signer, an enclave). The Stark curve is
// not offered by the cloud KMS products, so that is a service to build or buy.
export interface SecretSource {
  /** The secret called `name`. Throws when it is missing. Never log the result. */
  get(name: string): Promise<string>;
}

export class EnvSecretSource implements SecretSource {
  constructor(private env: Record<string, string | undefined> = process.env) {}
  async get(name: string): Promise<string> {
    const value = this.env[name];
    if (!value) throw new Error(`${name} is not set`);
    return value;
  }
}

/** A per-service, read-only mount; host provisioning and custody still require review.
 * Read only known logical names, reject links/oversized or publicly readable files,
 * and never include a path or contents in an error. No secret is loaded by tooling.
 */
export class FileSecretSource implements SecretSource {
  constructor(private directory = process.env.SECRET_DIRECTORY || '/run/secrets') {
    if (!isAbsolute(directory)) throw new Error('SECRET_DIRECTORY_INVALID');
  }
  async get(name: string): Promise<string> {
    if (!['RELAYER_PRIVATE_KEY', 'OWNER_PRIVATE_KEY'].includes(name)) throw new Error('SECRET_NAME_INVALID');
    return readPrivateSecretFile(join(this.directory, name));
  }
}

/** Explicit configuration paths only; no arbitrary request-controlled file reads. */
export async function readPrivateSecretFile(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error('SECRET_FILE_UNAVAILABLE');
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size < 1 || stat.size > 4096) throw new Error();
    const buffer = Buffer.alloc(4097);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead < 1 || bytesRead > 4096) throw new Error();
    const value = buffer.subarray(0, bytesRead).toString('utf8').trim();
    if (!value || /[\r\n\0]/.test(value)) throw new Error();
    return value;
  } catch { throw new Error('SECRET_FILE_UNAVAILABLE'); }
  finally { await file?.close(); }
}

/** Load only supported non-signing runtime settings from service-scoped mounts.
 * Called by entrypoints, not module imports or review/build tooling.
 */
export async function loadRuntimeSecretFiles(env: Record<string, string | undefined> = process.env, names: readonly ('DATABASE_URL' | 'PAYMASTER_API_KEY')[] = ['DATABASE_URL', 'PAYMASTER_API_KEY']): Promise<void> {
  for (const name of names) {
    const path = env[`${name}_FILE`];
    if (!path) continue;
    if (env[name]) throw new Error('SECRET_CONFIGURATION_AMBIGUOUS');
    env[name] = await readPrivateSecretFile(path);
  }
}

/** A missing/unknown source is never silently replaced with environment credentials. */
export function secretSource(kind = process.env.SECRET_SOURCE ?? 'env'): SecretSource {
  if (kind === 'env') return new EnvSecretSource();
  if (kind === 'files') return new FileSecretSource();
  throw new Error(`SECRET_SOURCE=${kind} is not implemented; see src/secrets.ts`);
}
