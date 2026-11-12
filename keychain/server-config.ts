/** Public OAuth origin is configured by the operator, never inferred from request headers. */
export function keychainOrigin(settings: { port: number; publicOrigin?: string }): { origin: string; redirectUri: string } {
  if (!Number.isInteger(settings.port) || settings.port < 1 || settings.port > 65535) throw new Error('PORT must be an integer from 1 to 65535');
  if (settings.publicOrigin === undefined) {
    const origin = `http://localhost:${settings.port}`;
    return { origin, redirectUri: `${origin}/callback` };
  }
  const configured = settings.publicOrigin;
  let url: URL;
  try { url = new URL(configured); }
  catch { throw new Error('KEYCHAIN_PUBLIC_ORIGIN must be a bare HTTPS origin'); }
  const authorityOnly = /^https:\/\/[^/\\?#\s]+\/?$/.test(configured);
  const labels = url.hostname.split('.');
  const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  const dnsName = labels.length >= 2 && labels.every((label) => dnsLabel.test(label)) && /[a-z]/.test(labels.at(-1)!);
  if (!authorityOnly || configured !== configured.trim() || url.protocol !== 'https:' || !dnsName ||
      url.hostname === 'localhost' || url.hostname.endsWith('.localhost') ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      configured.includes('?') || configured.includes('#')) {
    throw new Error('KEYCHAIN_PUBLIC_ORIGIN must be a bare HTTPS DNS origin without credentials, path, query or fragment');
  }
  return { origin: url.origin, redirectUri: `${url.origin}/callback` };
}
