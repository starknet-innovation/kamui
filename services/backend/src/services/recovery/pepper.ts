// Kamui: the pepper is confirmed with the pepper service before the relayer pays for anything.
//
// The client picks the pepper it sends, and the pepper decides which account address is
// deployed. Without this check anyone holding a valid token could make the relayer deploy
// accounts for made-up peppers, and a client bug could put a user on an account nobody can
// find again. See services/pepper/DESIGN.md.
import { HttpError } from '../../http';
import { metrics } from '../../metrics';

export type PepperSettings = {
  /** Base URL of the pepper service. Without it nothing is confirmed (testnets only). */
  serviceUrl?: string;
  /** On mainnet pepper 0 is never accepted and the service is mandatory. */
  mainnet: boolean;
};

export type PepperRequest = {
  jwt: string;
  newPubkey: string;
  blinding: string;
  pepper: string;
  /** The device key's signature for the pepper service (the SDK's `keyProof`). */
  keyProof?: string[];
};

const HEX = /^0x[0-9a-fA-F]{1,64}$/;

type Send = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<Response>;

/** Reads the pepper settings for a chain. Refuses mainnet without a pepper service. */
export function pepperSettings(chain: string, serviceUrl: string | undefined): PepperSettings {
  const mainnet = chain === 'SN_MAIN';
  if (mainnet && !serviceUrl) throw new Error('PEPPER_SERVICE_URL is required on mainnet');
  return { serviceUrl: serviceUrl || undefined, mainnet };
}

function unavailable(): HttpError {
  metrics.outboundFailures.inc({ target: 'pepper' });
  return new HttpError(502, 'PEPPER_SERVICE_UNAVAILABLE');
}

/** The checks that need no one else: a well-formed pepper, and never pepper 0 on mainnet. */
export function assertPepperShape(pepper: string, settings: PepperSettings): void {
  if (!HEX.test(pepper)) throw new HttpError(400, 'BAD_PEPPER');
  if (settings.mainnet && BigInt(pepper) === 0n) throw new HttpError(400, 'PEPPER_REQUIRED');
}

/**
 * Throws unless `req.pepper` is the pepper the service derives for this token. The service
 * verifies the token and the key proof itself; this backend only compares the answer.
 */
export async function confirmPepper(
  req: PepperRequest,
  settings: PepperSettings,
  send: Send = (url, init) => fetch(url, init),
): Promise<void> {
  if (!HEX.test(req.pepper)) throw new HttpError(400, 'BAD_PEPPER');
  if (settings.mainnet && BigInt(req.pepper) === 0n) throw new HttpError(400, 'PEPPER_REQUIRED');
  if (!settings.serviceUrl) return;

  const proof = req.keyProof;
  if (!Array.isArray(proof) || proof.length !== 2 || !proof.every((s) => typeof s === 'string' && HEX.test(s))) {
    throw new HttpError(400, 'KEY_PROOF_REQUIRED');
  }

  let response: Response;
  try {
    response = await send(`${settings.serviceUrl.replace(/\/$/, '')}/v1/pepper`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jwt: req.jwt, public_key: req.newPubkey, blinding: req.blinding, signature: proof }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw unavailable();
  }
  const body = (await response.json().catch(() => ({}))) as { pepper?: unknown; error?: unknown };
  if (response.status >= 500) throw unavailable();
  // The service's own refusals (bad token, bad key proof, rate limit) pass through by code.
  if (!response.ok) throw new HttpError(response.status === 429 ? 429 : 400, `PEPPER_SERVICE: ${typeof body.error === 'string' ? body.error : response.status}`);
  if (typeof body.pepper !== 'string' || !HEX.test(body.pepper)) throw unavailable();
  // The message never includes either pepper.
  if (BigInt(body.pepper) !== BigInt(req.pepper)) throw new HttpError(400, 'WRONG_PEPPER');
}
