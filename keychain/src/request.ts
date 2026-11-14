// The pending connect or execute request (survives the trip to the issuer), and the answer sent back.
import { POPUP_LEAVING, resultUrl, type ConnectRequest, type ExecuteRequest } from '../../sdk/src';

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

/**
 * Popup mode (sdk/src/popup.ts): when an app opened this window for a request, tells the app's
 * page that the window is about to visit the issuer. An issuer that sets
 * Cross-Origin-Opener-Policy cuts the link between the two windows, and the app's page would
 * otherwise take that for the user closing the popup. The note carries only the request's id
 * and is addressed to the origin the answer goes to, so no other opener can read it.
 */
export function noteLeavingForIssuer() {
  const pending = pendingRequest();
  if (!pending || !window.opener) return;
  try {
    window.opener.postMessage({ kamui: POPUP_LEAVING, id: pending.request.id }, new URL(pending.request.redirectUri).origin);
  } catch { /* the opener is gone: nothing to tell */ }
}
