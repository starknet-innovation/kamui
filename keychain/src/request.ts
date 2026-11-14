// The pending connect or execute request (survives the trip to the issuer), and the answer sent back.
import { resultUrl, type ConnectRequest, type ExecuteRequest } from '../../sdk/src';

export const REQUEST = 'kamui.keychain.request';

export type Pending = { kind: 'connect'; request: ConnectRequest } | { kind: 'execute'; request: ExecuteRequest };

export function pendingRequest(): Pending | null {
  const text = sessionStorage.getItem(REQUEST);
  return text ? (JSON.parse(text) as Pending) : null;
}

type Answer =
  | { ok: true; account: string; chainId: string; classHash: string }
  | { ok: true; transactionHash: string }
  | { ok: false; error: string };

export function answer(request: { id: string; redirectUri: string }, result: Answer) {
  sessionStorage.removeItem(REQUEST);
  location.assign(resultUrl(request, { v: 1, id: request.id, ...result }));
}
