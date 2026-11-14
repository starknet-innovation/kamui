// Adding a device from one that is already signed in: the two texts the devices exchange.
// No page, storage or network here, so this file can be tested on its own. See DEVICE_LINK.md.
//
//   signed-in device -> new device   a link:  /link#v=1&account=…&chain=…&class=…&id=…&exp=…
//   new device -> signed-in device   a code:  kamui-link1.<id>.<key>.<anchor>.<r>.<s>
//
// The link holds nothing secret to the chain: the account address, the network and the account
// class. Its `id` is random and only ties a code to the link it answers, so that a code made
// without the link is refused by the signed-in device. The code holds the new device's public
// key and its signature accepting ownership (contracts/src/owners.cairo, `add_owner`). No
// private key, token or pepper is in either.
import { ec, hash } from 'starknet';
import { newOwnerMessageHash } from '../../sdk/src';

export const LINK_VERSION = '1';
/** How long a link can be answered. The signed-in device also forgets it when its page closes. */
export const LINK_LIFETIME_SECONDS = 15 * 60;
const CODE_PREFIX = 'kamui-link1';
/** The Stark field prime. Every value exchanged is a felt. */
const FELT_BOUND = (1n << 251n) + 17n * (1n << 192n) + 1n;
const MAX_LINK_CHARS = 1024;

export type LinkInvite = {
  account: string;
  chainId: string;
  classHash: string;
  /** Random, made by the signed-in device. The answer must repeat it. */
  id: string;
  /** Unix seconds after which the link is refused. */
  expires: number;
};

export type LinkAnswer = {
  id: string;
  publicKey: string;
  /** The account's owners anchor the new key signed over. */
  anchor: string;
  signature: [string, string];
};

const hex = (value: bigint) => `0x${value.toString(16)}`;

function felt(text: string | null | undefined, what: string, nonZero = true): string {
  if (typeof text !== 'string' || !/^(0x)?[0-9a-f]{1,64}$/i.test(text)) throw new Error(`${what} is not valid`);
  const value = BigInt(text.startsWith('0x') || text.startsWith('0X') ? text : `0x${text}`);
  if (value >= FELT_BOUND || (nonZero && value === 0n)) throw new Error(`${what} is not valid`);
  return hex(value);
}

/** A fresh `id` for a link: 16 random bytes. */
export function newLinkId(): string {
  return '0x' + Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The address the new device opens. Everything is in the fragment, which is not sent to a server. */
export function linkUrl(origin: string, invite: LinkInvite): string {
  const fragment = new URLSearchParams({
    v: LINK_VERSION,
    account: invite.account,
    chain: invite.chainId,
    class: invite.classHash,
    id: invite.id,
    exp: String(invite.expires),
  });
  return `${origin}/link#${fragment}`;
}

/** Reads the fragment of a link. Throws with a sentence a user can be shown. */
export function parseLinkFragment(fragment: string): LinkInvite {
  if (fragment.length > MAX_LINK_CHARS) throw new Error('This link is not a Kamui device link.');
  const fields = new URLSearchParams(fragment.replace(/^#/, ''));
  if (fields.get('v') !== LINK_VERSION) throw new Error('This link is not a Kamui device link, or was made by another version of Kamui.');
  const expires = Number(fields.get('exp'));
  try {
    if (!/^[0-9]{1,12}$/.test(fields.get('exp') ?? '') || !Number.isSafeInteger(expires)) throw new Error('expiry is not valid');
    return {
      account: felt(fields.get('account'), 'account'),
      chainId: felt(fields.get('chain'), 'network'),
      classHash: felt(fields.get('class'), 'account class'),
      id: felt(fields.get('id'), 'id'),
      expires,
    };
  } catch (error) {
    throw new Error(`This link is not a Kamui device link (${(error as Error).message}).`);
  }
}

/** The text the new device shows, to be copied to the signed-in device. */
export function linkAnswerCode(answer: LinkAnswer): string {
  return [CODE_PREFIX, ...[answer.id, answer.publicKey, answer.anchor, ...answer.signature].map((value) => BigInt(value).toString(16))].join('.');
}

/** Reads a code typed or pasted by the user. Throws with a sentence a user can be shown. */
export function parseLinkAnswer(text: string): LinkAnswer {
  const parts = text.trim().split('.');
  if (text.length > MAX_LINK_CHARS || parts.length !== 6 || parts[0] !== CODE_PREFIX) throw new Error('This is not a code from a new device. Copy the whole code shown there.');
  try {
    return {
      id: felt(parts[1], 'id'),
      publicKey: felt(parts[2], 'key'),
      // An account with owners never has anchor 0 (contracts/src/owners.cairo).
      anchor: felt(parts[3], 'anchor'),
      signature: [felt(parts[4], 'signature'), felt(parts[5], 'signature')],
    };
  } catch (error) {
    throw new Error(`This is not a code from a new device (${(error as Error).message}).`);
  }
}

/**
 * Whether the code's signature is the code's key accepting ownership of `account` at the code's
 * anchor: what `add_owner` will check. Checked before a sponsored transaction is spent on it.
 */
export function linkAnswerSigned(account: string, answer: LinkAnswer): boolean {
  const digest = BigInt(newOwnerMessageHash(account, answer.anchor)).toString(16).padStart(64, '0');
  let signature: InstanceType<typeof ec.starkCurve.Signature>;
  try {
    signature = new ec.starkCurve.Signature(BigInt(answer.signature[0]), BigInt(answer.signature[1]));
  } catch {
    return false;
  }
  // An owner key is the x coordinate of a point; either of the two points with that x will do,
  // as for the contract's own check.
  return ['02', '03'].some((prefix) => {
    try {
      return ec.starkCurve.verify(signature, digest, prefix + BigInt(answer.publicKey).toString(16).padStart(64, '0'));
    } catch {
      return false;
    }
  });
}

/**
 * Six characters both devices show for the same key, so the user can see that the code pasted on
 * the signed-in device is the one this new device made. It is a comparison aid, not a secret.
 */
export function checkCode(publicKey: string): string {
  const digits = BigInt(hash.computePoseidonHashOnElements([publicKey])).toString(16).padStart(6, '0').slice(-6).toUpperCase();
  return `${digits.slice(0, 3)}-${digits.slice(3)}`;
}
