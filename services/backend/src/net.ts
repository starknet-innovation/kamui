// Kamui: bounded outbound calls, and who the client is.
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * `send` with a deadline. The signal aborts a real fetch; the race also bounds a `send` that
 * ignores the signal, so no caller waits longer than `timeoutMs`.
 */
export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, send: Fetch = fetch): Promise<Response> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([send(url, { ...init, signal: controller.signal }), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The client address rate limits are keyed by. With `trustedHops` 0 it is the socket's peer.
 * Behind N proxies we operate (the keychain's /api proxy, a load balancer), it is the Nth
 * entry from the right of X-Forwarded-For: entries further left are whatever the client sent
 * and are never trusted. If the header is shorter than that, the socket's peer is used.
 */
export function clientAddress(socketAddress: string | undefined, forwardedFor: string | null, trustedHops: number): string {
  const peer = socketAddress ?? 'unknown';
  if (trustedHops <= 0 || !forwardedFor) return peer;
  const chain = forwardedFor.split(',').map((part) => part.trim()).filter(Boolean);
  const picked = chain[chain.length - trustedHops];
  return picked && picked.length <= 64 ? picked : peer;
}
