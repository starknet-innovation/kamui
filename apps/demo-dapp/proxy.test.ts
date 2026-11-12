import { expect, test } from 'bun:test';
import { proxyHeaders } from './proxy';

test('approved app credential is server-only, scoped to sponsor and cannot be chosen by browser', () => {
  const request = new Request('http://localhost/api/sponsor', {headers:{'x-kamui-app-key':'public-test-app-key','x-kamui-sponsor-token':'browser-forgery'}});
  expect(proxyHeaders(request,'127.0.0.1')['x-kamui-sponsor-token']).toBeUndefined();
  expect(proxyHeaders(request,'127.0.0.1','server-fixture-token')['x-kamui-sponsor-token']).toBe('server-fixture-token');
  expect(proxyHeaders(request,'127.0.0.1')['x-kamui-app-key']).toBe('public-test-app-key');
  expect(proxyHeaders(new Request('http://localhost/api/registry/sessions'),'127.0.0.1','server-fixture-token')['x-kamui-sponsor-token']).toBeUndefined();
});
