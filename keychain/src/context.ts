// What every part of the keychain shares: the page's two fixed elements, the configuration and
// the RPC provider. Evaluated once, at startup, before any page is drawn.
import { RpcProvider } from 'starknet';

type Config = {
  proverReady: boolean;
  proverExecutor: string;
  proverRpcUrl: string;
  jwkRegistry: string; googleClientId: string; appleClientId?: string; rpcUrl: string; rpcFallbackUrl?: string; classHash: string; pepperUrl: string; apiUrl: string; redirectUri: string; pollMs: number };

export const view = document.getElementById('view')!;
export const statusLine = document.getElementById('status')!;
export const config = (await (await fetch('/config.json')).json()) as Config;
// A request the first node cannot serve (unreachable, 429 or 5xx) goes once to the fallback.
// Only the content-type header is sent, which is all the public nodes' CORS allows.
const rpcFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (!config.rpcFallbackUrl) return fetch(input, init);
  try {
    const answer = await fetch(input, init);
    if (answer.status !== 429 && answer.status < 500) return answer;
  } catch { /* unreachable: try the fallback */ }
  return fetch(config.rpcFallbackUrl, init);
}) as typeof fetch;
export const provider = new RpcProvider({ nodeUrl: config.rpcUrl, transactionRetryIntervalFallback: config.pollMs, baseFetch: rpcFetch });
