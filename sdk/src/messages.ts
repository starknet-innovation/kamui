// Off-chain messages (SNIP-12 typed data) signed as a Kamui account, in the two formats its
// `is_valid_signature` accepts (contracts/src/core.cairo):
//
//   [r, s]                                  an owner key
//   [session_pubkey, r, s, valid_until]     a live session (SNIP-41)
//
// A session's signature is accepted for any message while the session exists and has not
// expired: there are no calls to check a scope or a limit against. It stops being accepted when
// the session expires, is revoked, or the account's owners change.
import { shortString, typedData as snip12, type ProviderInterface, type TypedData } from 'starknet';
import { sessionSignature } from './sessions';
import { sameFelt, signHash, toHex } from './utils';

/** The hash `account` signs for `data`. It commits to the account, so a signature is not valid for another one. */
export function typedDataHash(data: TypedData, account: string): string {
  return snip12.getMessageHash(data, account);
}

/**
 * Signs typed data with a session key, as the connected account: `[session_pubkey, r, s,
 * valid_until]`. No trip to the keychain and no transaction; the session key never leaves the app.
 */
export function sessionSignTypedData(
  connection: { account: string; session: { privateKey: string; publicKey: string; validUntil: number } },
  data: TypedData,
): string[] {
  return sessionSignature(typedDataHash(data, connection.account), connection.session);
}

/** Signs typed data with an owner key: `[r, s]`. The keychain does this for a sign-message request. */
export function ownerSignTypedData(data: TypedData, account: string, ownerPrivateKey: string): [string, string] {
  return signHash(typedDataHash(data, account), ownerPrivateKey);
}

/** `starknet::VALIDATED`, what `is_valid_signature` returns for a signature it accepts. */
const VALIDATED = shortString.encodeShortString('VALID');

/**
 * Asks the account whether it accepts `signature` for `data` (`is_valid_signature`). This is the
 * check a verifier runs, for example a server reading a sign-in message. It reads the chain as
 * it is now: a session's signature stops verifying once the session ends.
 */
export async function verifyMessageSignature(
  provider: ProviderInterface,
  account: string,
  data: TypedData,
  signature: string[],
): Promise<boolean> {
  const answer = await provider.callContract({
    contractAddress: account,
    entrypoint: 'is_valid_signature',
    calldata: [typedDataHash(data, account), toHex(signature.length), ...signature],
  });
  return answer.length === 1 && sameFelt(answer[0]!, VALIDATED);
}

/** A felt as SNIP-12 reads it: a number, a numeric string, or else a short string. */
export function typedDataFelt(value: unknown): bigint | null {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') return null;
  try {
    return BigInt(value);
  } catch {
    try {
      return BigInt(shortString.encodeShortString(String(value)));
    } catch {
      return null;
    }
  }
}

/** One value of a message, with where it sits and the type it is hashed as. */
export type TypedDataField = { path: string; type: string; value: string };

const own = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);
const leaf = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value) ?? String(value));

/**
 * The message of `data` as a flat list, following its types: exactly the values that are hashed,
 * each with its declared type. Throws if the message has a field its type does not declare (it
 * would be shown but not signed) or lacks one it does.
 */
export function typedDataFields(data: TypedData, maxFields = Infinity): TypedDataField[] {
  const types = data.types as Record<string, { name: string; type: string }[]>;
  const fields: TypedDataField[] = [];
  const push = (field: TypedDataField) => {
    if (fields.length >= maxFields) throw new Error(`typed data: more than ${maxFields} values`);
    fields.push(field);
  };

  const walk = (type: string, value: unknown, path: string) => {
    if (type.endsWith('*')) {
      if (!Array.isArray(value)) throw new Error(`typed data: '${path}' is not a list`);
      if (value.length === 0) push({ path, type, value: '(empty list)' });
      value.forEach((item, index) => walk(type.slice(0, -1), item, `${path}[${index}]`));
      return;
    }
    if (!own(types, type)) {
      // A basic or preset type (felt, shortstring, u128, TokenAmount, …): one value.
      push({ path, type, value: leaf(value) });
      return;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`typed data: '${path}' is not a ${type}`);
    const declared = types[type]!;
    for (const key of Object.keys(value)) {
      if (!declared.some((field) => field.name === key)) throw new Error(`typed data: '${path ? `${path}.` : ''}${key}' is not declared in ${type}`);
    }
    for (const field of declared) {
      const inner = path ? `${path}.${field.name}` : field.name;
      if (!own(value, field.name)) throw new Error(`typed data: '${inner}' is missing`);
      const item = (value as Record<string, unknown>)[field.name];
      // Enums and Merkle trees have their own encodings: shown whole, as written.
      if (field.type === 'enum' || field.type === 'merkletree') push({ path: inner, type: field.type, value: leaf(item) });
      else walk(field.type, item, inner);
    }
  };

  walk(data.primaryType, data.message, '');
  return fields;
}
