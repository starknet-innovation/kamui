import { expect, test } from 'bun:test';
import { newKeyPair, signNewOwner } from '../sdk/src';
import { checkCode, linkAnswerCode, linkAnswerSigned, linkUrl, newLinkId, parseLinkAnswer, parseLinkFragment, type LinkInvite } from './src/link-code';

const ACCOUNT = '0x4a1';
const invite: LinkInvite = { account: ACCOUNT, chainId: '0x534e5f5345504f4c4941', classHash: '0x13c5', id: '0xabc', expires: 1_900_000_000 };

function answerFor(account = ACCOUNT, anchor = '0x7') {
  const device = newKeyPair();
  return { device, answer: { id: invite.id, publicKey: device.publicKey, anchor, signature: signNewOwner(account, anchor, device.privateKey) } };
}

test('a link survives the trip through its address, in the fragment only', () => {
  const url = new URL(linkUrl('https://keychain.example', invite));
  expect(url.pathname).toBe('/link');
  expect(url.search).toBe('');
  expect(parseLinkFragment(url.hash)).toEqual(invite);
});

test('a fresh link id is a non-zero felt that differs each time', () => {
  const [a, b] = [newLinkId(), newLinkId()];
  expect(a).not.toBe(b);
  expect(parseLinkFragment(new URL(linkUrl('https://k.example', { ...invite, id: a })).hash).id).toBe(`0x${BigInt(a).toString(16)}`);
});

test('a link with a missing, zero, oversized or foreign field is refused', () => {
  const fragment = (change: Record<string, string | null>) => {
    const fields = new URLSearchParams(new URL(linkUrl('https://k.example', invite)).hash.slice(1));
    for (const [key, value] of Object.entries(change)) value === null ? fields.delete(key) : fields.set(key, value);
    return `#${fields}`;
  };
  for (const bad of [
    fragment({ v: '2' }), fragment({ account: null }), fragment({ account: '0x0' }), fragment({ account: 'javascript:alert(1)' }),
    fragment({ account: '0x' + 'f'.repeat(64) }), fragment({ id: null }), fragment({ exp: '-1' }), fragment({ exp: '1e9' }),
    fragment({ class: '<b>' }), fragment({ chain: '' }), '', `#${'a'.repeat(2000)}`,
  ]) expect(() => parseLinkFragment(bad)).toThrow(/not a Kamui device link/);
});

test('a code survives being copied, with or without surrounding space', () => {
  const { answer } = answerFor();
  const text = linkAnswerCode(answer);
  expect(text.startsWith('kamui-link1.')).toBe(true);
  expect(parseLinkAnswer(`  ${text}\n`)).toEqual(answer);
});

test('a truncated or altered code is refused', () => {
  const text = linkAnswerCode(answerFor().answer);
  for (const bad of ['', 'hello', text.slice(0, text.lastIndexOf('.')), text.replace('kamui-link1', 'kamui-link2'), `${text}.1`, text.replace(/\.[0-9a-f]+$/, '.zz'), text.replace(/\.[0-9a-f]+$/, '.0')]) {
    expect(() => parseLinkAnswer(bad)).toThrow(/not a code from a new device/);
  }
});

test('only the code\'s own key, for this account and this anchor, counts as signed', () => {
  const { answer } = answerFor();
  expect(linkAnswerSigned(ACCOUNT, answer)).toBe(true);
  // Another account, another anchor, another key, or a changed signature.
  expect(linkAnswerSigned('0x4a2', answer)).toBe(false);
  expect(linkAnswerSigned(ACCOUNT, { ...answer, anchor: '0x8' })).toBe(false);
  expect(linkAnswerSigned(ACCOUNT, { ...answer, publicKey: newKeyPair().publicKey })).toBe(false);
  expect(linkAnswerSigned(ACCOUNT, { ...answer, signature: [answer.signature[0], '0x1'] })).toBe(false);
  expect(linkAnswerSigned(ACCOUNT, { ...answer, signature: ['0x0', '0x0'] })).toBe(false);
});

test('the check code is the same for the same key however it is written, and differs between keys', () => {
  const key = newKeyPair().publicKey;
  expect(checkCode(key)).toMatch(/^[0-9A-F]{3}-[0-9A-F]{3}$/);
  expect(checkCode(`0x${BigInt(key).toString(16).padStart(64, '0')}`)).toBe(checkCode(key));
  expect(new Set(Array.from({ length: 20 }, () => checkCode(newKeyPair().publicKey))).size).toBeGreaterThan(15);
});
