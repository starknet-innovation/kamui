// Tokens: what an amount means, and session limits as the approval and account pages show them.
import { describeAmount, readTokenInfo, type TokenInfo } from '../../sdk/src';
import { provider } from './context';
import { code, el, short, table } from './ui';

/** Looks up every token an approval screen will mention, once. */
export async function lookUpTokens(addresses: string[]): Promise<(address: string) => TokenInfo> {
  const unique = [...new Set(addresses.map((address) => BigInt(address)))];
  const infos = await Promise.all(unique.map((address) => readTokenInfo(provider, `0x${address.toString(16)}`)));
  return (address) => infos[unique.indexOf(BigInt(address))] ?? { status: 'unknown', address };
}

/** A token as a table cell: the symbol its contract gives, and always its address. */
export function tokenCell(info: TokenInfo): Node {
  const cell = el('span');
  const name = info.status === 'named' ? info.symbol : 'unidentified';
  cell.append(document.createTextNode(`${name} `), code(short(info.address)));
  return cell;
}

/** What to say about a contract that did not answer like a token. Nothing for one that did. */
export function tokenCaution(info: TokenInfo): Node | null {
  if (info.status === 'named') return null;
  return el('p', 'Kamui could not identify this token, so the amount is shown in its smallest unit and may be much larger or smaller than it looks.', 'warn');
}

export type Limit = { token: string; maxPerCall: bigint; maxPerWindow: bigint; windowSeconds: number };

/** A session's expiry, transaction count and fee cap, as table rows. */
export function limitRows(validUntil: number, maxCalls: number, maxFeePerTx: bigint): (string | Node)[][] {
  return [
    ['Until', new Date(validUntil * 1000).toLocaleString()],
    ['Transactions', `at most ${maxCalls} sponsored, and ${maxCalls} paid by your account`],
    ['Fees from your account', maxFeePerTx === 0n ? 'none: every transaction must be sponsored' : `at most ${Number(maxFeePerTx) / 1e18} STRK per transaction`],
  ];
}

/** Spending limits as a table, followed by a caution for each token Kamui could not identify. */
export function spendingLimits(limits: Limit[], tokenOf: (address: string) => TokenInfo): Node[] {
  const nodes: Node[] = [
    table(
      ['Token', 'Per call', 'Per period'],
      limits.map((limit) => {
        const info = tokenOf(limit.token);
        return [tokenCell(info), describeAmount(limit.maxPerCall, info), `${describeAmount(limit.maxPerWindow, info)} every ${Math.round(limit.windowSeconds / 60)} min`];
      }),
    ),
  ];
  for (const limit of limits) {
    const caution = tokenCaution(tokenOf(limit.token));
    if (caution) nodes.push(caution);
  }
  return nodes;
}
