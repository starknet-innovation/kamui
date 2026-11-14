// The pending connect, execute or sign-message request (survives the trip to the issuer), and the
// answer sent back.
import { resultUrl, type ConnectRequest, type ExecuteRequest, type SignMessageRequest } from '../../sdk/src';

export const REQUEST = 'kamui.keychain.request';

export type Pending =
  | { kind: 'connect'; request: ConnectRequest }
  | { kind: 'execute'; request: ExecuteRequest }
  | { kind: 'signMessage'; request: SignMessageRequest };

export function pendingRequest(): Pending | null {
  const text = sessionStorage.getItem(REQUEST);
  return text ? (JSON.parse(text) as Pending) : null;
}

type Answer =
  | { ok: true; account: string; chainId: string; classHash: string }
  | { ok: true; account: string; calldata: string[] }
  | { ok: true; account: string; chainId: string; signature: string[] }
  | { ok: false; error: string };

export function answer(request: { id: string; redirectUri: string }, result: Answer) {
  sessionStorage.removeItem(REQUEST);
  location.assign(resultUrl(request, { v: 1, id: request.id, ...result }));
}
