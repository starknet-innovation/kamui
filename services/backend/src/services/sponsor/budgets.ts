// Kamui: sponsorship budgets and their accounting.
//
// A budget says how many transactions the relayer pays for per period, how many of them one
// account may use, and the most it pays for one transaction. A request picks its budget with
// an app key in the `x-kamui-app-key` header; without the header it uses the shared
// "anonymous" budget.
//
// What an app key is: a public identifier of who is billed. It ships in the app's front end,
// so anyone can read it and send it. It protects nobody: users are protected by the account,
// which checks the owner or session signature on every sponsored call, and the budget's owner
// is protected only by the budget's limits. Treat a key like a publishable API key; rotate it
// by editing the budgets file.
import { readFileSync } from 'node:fs';

export const APP_KEY_HEADER = 'x-kamui-app-key';
export const APP_KEY = /^[A-Za-z0-9_-]{16,64}$/;
/** 1 STRK in fri. Used when a budget names no ceiling, so there is always one. */
export const DEFAULT_MAX_FEE_PER_TX = 10n ** 18n;

export type Budget = {
  /** Shown in metrics and logs. Never the key. */
  name: string;
  /** Transactions per period. 0 turns the budget off. */
  txPerPeriod: number;
  periodSeconds: number;
  /** Transactions one account may take from this budget per period. */
  perAccountPerPeriod: number;
  /** The relayer refuses to pay more than this for one transaction, in fri. */
  maxFeePerTx: bigint;
};

export type Budgets = { anonymous: Budget; byKey: Map<string, Budget> };

const wholeNumber = (value: unknown, what: string, min: number): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) throw new Error(`budgets: ${what} must be a whole number of at least ${min}`);
  return value;
};

function parseBudget(raw: any, name: string, fallback?: Budget): Budget {
  if (typeof raw !== 'object' || raw === null) throw new Error(`budgets: ${name} must be an object`);
  const txPerPeriod = wholeNumber(raw.txPerPeriod ?? fallback?.txPerPeriod, `${name}.txPerPeriod`, 0);
  const periodSeconds = wholeNumber(raw.periodSeconds ?? fallback?.periodSeconds ?? 3600, `${name}.periodSeconds`, 1);
  const perAccountPerPeriod = wholeNumber(raw.perAccountPerPeriod ?? fallback?.perAccountPerPeriod ?? txPerPeriod, `${name}.perAccountPerPeriod`, 0);
  let maxFeePerTx = fallback?.maxFeePerTx ?? DEFAULT_MAX_FEE_PER_TX;
  if (raw.maxFeePerTx !== undefined) {
    if (typeof raw.maxFeePerTx !== 'string' || !/^(0x[0-9a-fA-F]+|[0-9]+)$/.test(raw.maxFeePerTx)) throw new Error(`budgets: ${name}.maxFeePerTx must be fri as a decimal or hex string`);
    maxFeePerTx = BigInt(raw.maxFeePerTx);
    if (maxFeePerTx <= 0n) throw new Error(`budgets: ${name}.maxFeePerTx must be above 0`);
  }
  return { name, txPerPeriod, periodSeconds, perAccountPerPeriod, maxFeePerTx };
}

/** The anonymous budget when no file configures one: SPONSORED_PER_HOUR, or 120 an hour on a testnet and off on mainnet. */
export function defaultAnonymous(chain: string, sponsoredPerHour: string | undefined): Budget {
  let txPerPeriod = chain === 'SN_MAIN' ? 0 : 120;
  if (sponsoredPerHour !== undefined && sponsoredPerHour !== '') {
    txPerPeriod = Number(sponsoredPerHour);
    if (!Number.isInteger(txPerPeriod) || txPerPeriod < 0) throw new Error('SPONSORED_PER_HOUR must be a whole number');
  }
  return { name: 'anonymous', txPerPeriod, periodSeconds: 3600, perAccountPerPeriod: Math.min(txPerPeriod, 30), maxFeePerTx: DEFAULT_MAX_FEE_PER_TX };
}

/**
 * Reads a budgets document: `{ anonymous?: {...}, apps?: [{ name, key, ... }] }`. Fields left
 * out of `anonymous` keep the default's values. Throws on anything malformed: a budget that
 * silently fell back to a default would spend money nobody agreed to.
 */
export function parseBudgets(doc: unknown, anonymous: Budget): Budgets {
  if (typeof doc !== 'object' || doc === null) throw new Error('budgets: the file must hold an object');
  const { anonymous: rawAnonymous, apps = [] } = doc as { anonymous?: unknown; apps?: unknown };
  const byKey = new Map<string, Budget>();
  const names = new Set(['anonymous']);
  if (!Array.isArray(apps)) throw new Error('budgets: apps must be a list');
  for (const app of apps) {
    const name = app?.name;
    if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(name)) throw new Error('budgets: each app needs a name of lower-case letters, digits, - and _');
    if (names.has(name)) throw new Error(`budgets: the name ${name} is used twice`);
    if (typeof app.key !== 'string' || !APP_KEY.test(app.key)) throw new Error(`budgets: ${name}.key must be 16 to 64 characters of A-Z a-z 0-9 _ -`);
    if (byKey.has(app.key)) throw new Error(`budgets: ${name} reuses another app's key`);
    names.add(name);
    byKey.set(app.key, parseBudget(app, name));
  }
  return { anonymous: rawAnonymous === undefined ? anonymous : parseBudget(rawAnonymous, 'anonymous', anonymous), byKey };
}

/** Budgets from SPONSOR_BUDGETS_FILE when set, otherwise the anonymous default alone. */
export function loadBudgets(chain: string, env: { file?: string; sponsoredPerHour?: string }): Budgets {
  const anonymous = defaultAnonymous(chain, env.sponsoredPerHour);
  if (!env.file) return { anonymous, byKey: new Map() };
  return parseBudgets(JSON.parse(readFileSync(env.file, 'utf8')), anonymous);
}

/** The budget for a request, or null when it carries a key that is not configured. */
export function budgetFor(budgets: Budgets, appKey: string | null | undefined): Budget | null {
  if (appKey === null || appKey === undefined || appKey === '') return budgets.anonymous;
  return (APP_KEY.test(appKey) && budgets.byKey.get(appKey)) || null;
}

/** A slot taken from a budget. Exactly one of `commit` and `release` must follow. */
export type Reservation = { commit(): Promise<void>; release(): Promise<void> };

/**
 * The accounting behind the budgets. `reserve` must be atomic: it takes a slot only if fewer
 * than `limit` are committed or reserved in the current period, so concurrent requests cannot
 * overspend. A slot counts against the budget only from `commit`; `release` gives it back.
 * A shared store (one Redis script, one SQL statement) implements this same interface when the
 * api is replicated.
 */
export interface SponsorLedger {
  reserve(key: string, limit: number, periodMs: number): Promise<Reservation | null>;
  /** Committed transactions in the current period. */
  used(key: string, periodMs: number): Promise<number>;
}

/** In process. Lost on restart, not shared between replicas. */
export class MemoryLedger implements SponsorLedger {
  private committed = new Map<string, number[]>();
  private reserved = new Map<string, number>();

  constructor(private now: () => number = Date.now) {}

  private recent(key: string, periodMs: number): number[] {
    const now = this.now();
    const times = (this.committed.get(key) ?? []).filter((t) => now - t < periodMs);
    if (times.length) this.committed.set(key, times);
    else this.committed.delete(key);
    return times;
  }

  async reserve(key: string, limit: number, periodMs: number): Promise<Reservation | null> {
    const held = this.reserved.get(key) ?? 0;
    if (this.recent(key, periodMs).length + held >= limit) return null;
    this.reserved.set(key, held + 1);
    let settled = false;
    const settle = (commit: boolean) => {
      if (settled) return;
      settled = true;
      const left = (this.reserved.get(key) ?? 1) - 1;
      if (left > 0) this.reserved.set(key, left);
      else this.reserved.delete(key);
      if (commit) this.committed.set(key, [...(this.committed.get(key) ?? []), this.now()]);
    };
    return { commit: async () => settle(true), release: async () => settle(false) };
  }

  async used(key: string, periodMs: number): Promise<number> {
    return this.recent(key, periodMs).length;
  }
}
