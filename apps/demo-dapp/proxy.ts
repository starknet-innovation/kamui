// Sponsorship credentials belong to the approved app server, never /config.json or JS.
export function proxyHeaders(request: Request, clientAddress: string | undefined, sponsorToken?: string, sponsorAppKey?: string): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const forwarded = [request.headers.get('x-forwarded-for'), clientAddress].filter(Boolean).join(', ');
  if (forwarded) headers['x-forwarded-for'] = forwarded;
  const appKey = request.headers.get('x-kamui-app-key');
  if (appKey) headers['x-kamui-app-key'] = appKey;
  // Ignore any credential supplied by the browser. This server's policy owns its budget.
  if (new URL(request.url).pathname === '/api/sponsor') {
    if (sponsorToken) headers['x-kamui-sponsor-token'] = sponsorToken;
    if (sponsorAppKey) headers['x-kamui-app-key'] = sponsorAppKey;
  }
  return headers;
}
