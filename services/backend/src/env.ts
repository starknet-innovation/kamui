import { existsSync, readFileSync } from 'node:fs';
import { RpcProvider } from 'starknet';

// Kamui: public deployment addresses live in deployments.env, loaded here. Upstream keeps them
// in a committed .env, which this repository's rules do not allow. Values already in the
// environment win. Secrets stay in .env.local, which Bun loads by itself.
const DEPLOYMENTS = `${import.meta.dir}/../deployments.env`;
if (existsSync(DEPLOYMENTS)) {
  for (const line of readFileSync(DEPLOYMENTS, 'utf8').split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match && process.env[match[1]!] === undefined) process.env[match[1]!] = match[2]!;
  }
}

export function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

export function makeProvider() {
  return new RpcProvider({
    nodeUrl: env('RPC_URL'),
  });
}

/** A chain id felt as text: 0x534e5f5345504f4c4941 -> SN_SEPOLIA. */
export function decodeChainId(felt: string): string {
  const hex = BigInt(felt).toString(16);
  return Buffer.from(hex.padStart(hex.length + (hex.length % 2), '0'), 'hex').toString();
}

export async function chainName(provider: RpcProvider) {
  return decodeChainId(await provider.getChainId());
}

/** Sets each KEY=value line in a .env text, replacing the line if KEY is already there. */
export function upsertEnv(text: string, vars: Record<string, string>): string {
  for (const [k, v] of Object.entries(vars)) {
    const line = new RegExp(`^${k}=.*$`, 'm');
    if (line.test(text)) text = text.replace(line, `${k}=${v}`);
    else text = `${text}${text && !text.endsWith('\n') ? '\n' : ''}${k}=${v}\n`;
  }
  return text;
}
