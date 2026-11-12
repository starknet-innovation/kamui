import { existsSync, readFileSync } from 'node:fs';
import { RpcProvider, shortString } from 'starknet';

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

// Kamui: every RPC request has a deadline (RPC_TIMEOUT_MS, 30 seconds by default), so a node
// that stops answering fails a request instead of holding it.
export function makeProvider() {
  const timeoutMs = Number(process.env.RPC_TIMEOUT_MS ?? 30_000);
  return new RpcProvider({
    nodeUrl: env('RPC_URL'),
    baseFetch: ((input: RequestInfo | URL, init?: RequestInit) =>
      fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) })) as typeof fetch,
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

/**
 * Kamui: the chain a service runs on, without making start-up depend on the RPC. With CHAIN_ID
 * set (SN_SEPOLIA, SN_MAIN) the service starts at once and `confirmed` checks the node in the
 * background, retrying while it is unreachable; it rejects if the node is on another chain, and
 * the caller must then stop (mainnet rules depend on the chain name). Without CHAIN_ID the node
 * is asked first, as upstream does, and an RPC outage at start-up fails the process.
 */
export async function resolveChain(provider: Pick<RpcProvider, 'getChainId'>, configured = process.env.CHAIN_ID, retryMs = 15_000): Promise<{ chain: string; chainId: string; confirmed: Promise<void> }> {
  if (!configured) {
    const chainId = await provider.getChainId();
    return { chain: decodeChainId(chainId), chainId, confirmed: Promise.resolve() };
  }
  if (!/^[A-Z0-9_]{1,31}$/.test(configured)) throw new Error('CHAIN_ID must be a chain name such as SN_SEPOLIA');
  const chainId = shortString.encodeShortString(configured);
  const confirmed = (async () => {
    while (true) {
      let actual: string;
      try {
        actual = await provider.getChainId();
      } catch {
        await new Promise((resolve) => setTimeout(resolve, retryMs));
        continue;
      }
      if (BigInt(actual) !== BigInt(chainId)) throw new Error(`CHAIN_ID is ${configured} but the node is on ${decodeChainId(actual)}`);
      return;
    }
  })();
  return { chain: configured, chainId, confirmed };
}

/** Stops the process if the node turns out to be on another chain than CHAIN_ID says. */
export function exitOnWrongChain(confirmed: Promise<void>): void {
  confirmed.catch((e) => {
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'error', event: 'wrong_chain', detail: (e as Error).message }));
    process.exit(1);
  });
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
