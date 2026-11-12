// Kamui: where signing keys come from. The relayer, prover-account and registry-owner keys are
// read through this interface and nowhere else.
//
// Today the only source is the process environment. A managed secret store plugs in by
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

/** The source named by SECRET_SOURCE. Only `env` exists; anything else is refused, not ignored. */
export function secretSource(kind = process.env.SECRET_SOURCE ?? 'env'): SecretSource {
  if (kind === 'env') return new EnvSecretSource();
  throw new Error(`SECRET_SOURCE=${kind} is not implemented; see src/secrets.ts`);
}
