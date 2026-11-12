// Durable paid-attempt accounting. No automatic refunds: a failed response may hide a send.
import type { SQL } from 'bun';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { HttpError } from '../../http';

export const SPONSOR_TOKEN_HEADER = 'x-kamui-sponsor-token';
export type FundingKind = 'sponsor' | 'deployment' | 'recovery';
export type FundingLimit = {
  periodSeconds: number;
  txPerPeriod: number;
  perAccountPerPeriod: number;
  maxFeePerTx: bigint;
  maxFeePerPeriod: bigint;
  perAccountMaxFeePerPeriod: bigint;
};
export type FundingApp = FundingLimit & { credentialHash: string };
export type FundingPolicy = {
  global: FundingLimit;
  operations: Record<FundingKind, FundingLimit>;
  apps: Record<string, FundingApp>;
  /** External fees are not bounded by our signed resource bounds. Requires separate review. */
  allowExternalPaymaster: boolean;
};
export type FundingDebit = {
  kind: FundingKind;
  account: string;
  maxFee: bigint;
  /** Deterministic signed hash where available; duplicate debits refuse another send. */
  id?: string;
  appKey?: string | null;
  credential?: string | null;
  external?: boolean;
};
export interface FundingController {
  authorizeApp(appKey: string | null | undefined, credential: string | null | undefined): void;
  debit(request: FundingDebit): Promise<void>;
}
export const FUNDING_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS funding_control (
  key TEXT PRIMARY KEY,
  paused BOOLEAN NOT NULL
);
INSERT INTO funding_control (key, paused) VALUES ('global', true) ON CONFLICT (key) DO NOTHING;
CREATE TABLE IF NOT EXISTS funding_debits (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('sponsor','deployment','recovery')),
  account TEXT NOT NULL,
  app TEXT,
  fee NUMERIC(80,0) NOT NULL CHECK (fee >= 0),
  created_at BIGINT NOT NULL,
  external BOOLEAN NOT NULL
);
CREATE INDEX IF NOT EXISTS funding_debits_time ON funding_debits(created_at);
CREATE INDEX IF NOT EXISTS funding_debits_account ON funding_debits(account, created_at);
CREATE INDEX IF NOT EXISTS funding_debits_app ON funding_debits(app, created_at);
`;
const FRI_MAX = 2n ** 256n - 1n;
const keyPattern = /^[A-Za-z0-9_-]{16,64}$/;
const failPolicy = (): never => { throw new Error('FUNDING_POLICY_INVALID'); };
const integer = (v: unknown, min: number): number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min ? v : failPolicy();
const amount = (v: unknown): bigint => {
  if (typeof v !== 'string' || !/^(0x[0-9a-fA-F]+|[0-9]+)$/.test(v)) return failPolicy();
  const result = BigInt(v);
  return result <= FRI_MAX ? result : failPolicy();
};
const limit = (v: any): FundingLimit => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return failPolicy();
  const result = { periodSeconds: integer(v.periodSeconds, 1), txPerPeriod: integer(v.txPerPeriod, 0),
    perAccountPerPeriod: integer(v.perAccountPerPeriod, 0), maxFeePerTx: amount(v.maxFeePerTx),
    maxFeePerPeriod: amount(v.maxFeePerPeriod), perAccountMaxFeePerPeriod: amount(v.perAccountMaxFeePerPeriod) };
  if (!Number.isSafeInteger(result.periodSeconds * 1000)) return failPolicy();
  return result;
};
export function disabledFundingPolicy(): FundingPolicy {
  const off = (): FundingLimit => ({ periodSeconds: 3600, txPerPeriod: 0, perAccountPerPeriod: 0, maxFeePerTx: 0n, maxFeePerPeriod: 0n, perAccountMaxFeePerPeriod: 0n });
  return { global: off(), operations: { sponsor: off(), deployment: off(), recovery: off() }, apps: {}, allowExternalPaymaster: false };
}
export function parseFundingPolicy(v: any): FundingPolicy {
  if (!v || typeof v !== 'object' || Array.isArray(v) || !v.operations || !v.apps || Array.isArray(v.apps) || typeof v.apps !== 'object' || typeof v.allowExternalPaymaster !== 'boolean') return failPolicy();
  const apps: Record<string, FundingApp> = Object.create(null);
  for (const [key, entry] of Object.entries(v.apps) as [string, any][]) {
    if (!keyPattern.test(key) || typeof entry?.credentialHash !== 'string' || !/^[0-9a-f]{64}$/.test(entry.credentialHash) || entry.credentialHash === createHash('sha256').update('').digest('hex')) return failPolicy();
    apps[key] = { ...limit(entry), credentialHash: entry.credentialHash };
  }
  return { global: limit(v.global), operations: { sponsor: limit(v.operations.sponsor), deployment: limit(v.operations.deployment), recovery: limit(v.operations.recovery) }, apps, allowExternalPaymaster: v.allowExternalPaymaster };
}
export function loadFundingPolicy(path?: string): FundingPolicy {
  if (!path) return disabledFundingPolicy();
  try { return parseFundingPolicy(JSON.parse(readFileSync(path, 'utf8'))); }
  catch { throw new Error('FUNDING_POLICY_INVALID'); }
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const accountingLock = (sql: SQL) => sql`SELECT pg_advisory_xact_lock(1262570837, 3)`;

export class PostgresFunding implements FundingController {
  constructor(private readonly sql: SQL, private readonly policy: FundingPolicy, private readonly now = Date.now) {}

  authorizeApp(appKey: string | null | undefined, credential: string | null | undefined): void {
    const app = appKey && keyPattern.test(appKey) ? this.policy.apps[appKey] : undefined;
    // Hash before comparison; never retain or log the bearer. The app key is only an ID.
    const validCredential = typeof credential === 'string' && credential.length > 0 && credential.length <= 4096;
    const provided = digest(validCredential ? credential : '');
    const expected = app?.credentialHash ?? '0'.repeat(64);
    const matches = timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'));
    if (!app || !validCredential || !matches) throw new HttpError(403, 'APP_AUTH_REQUIRED');
  }

  async debit(request: FundingDebit): Promise<void> {
    if (!['sponsor', 'deployment', 'recovery'].includes(request.kind)) throw new Error('FUNDING_KIND_INVALID');
    if (typeof request.account !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(request.account) || typeof request.maxFee !== 'bigint' || request.maxFee < 0n || request.maxFee > FRI_MAX) throw new Error('FUNDING_DEBIT_INVALID');
    if (request.kind === 'sponsor') this.authorizeApp(request.appKey, request.credential);
    if (request.external && !this.policy.allowExternalPaymaster) throw new HttpError(403, 'EXTERNAL_SPENDING_CONTROLS_REQUIRED');
    const account = '0x' + BigInt(request.account).toString(16);
    const app = request.kind === 'sponsor' ? digest(request.appKey!) : null;
    if (request.id && !/^0x[0-9a-fA-F]{1,64}$/.test(request.id)) throw new Error('FUNDING_DEBIT_ID_INVALID');
    const id = request.id ? 'tx:' + BigInt(request.id).toString(16) : 'attempt:' + randomUUID();
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('FUNDING_CLOCK_INVALID');
    await this.sql.begin(async tx => {
      await accountingLock(tx);
      const [control] = await tx`SELECT paused FROM funding_control WHERE key = 'global'`;
      if (!control || control.paused) throw new HttpError(503, 'SPENDING_PAUSED');
      if ((await tx`SELECT 1 FROM funding_debits WHERE id = ${id}`).length) throw new HttpError(409, 'FUNDING_ALREADY_DEBITED');
      const check = async (bound: FundingLimit, scope: 'global' | 'operation' | 'app') => {
        if (!bound.txPerPeriod || !bound.perAccountPerPeriod || !bound.maxFeePerTx || !bound.maxFeePerPeriod || !bound.perAccountMaxFeePerPeriod) throw new HttpError(403, 'FUNDING_DISABLED');
        if (request.maxFee > bound.maxFeePerTx) throw new HttpError(402, 'FUNDING_FEE_CEILING');
        const cutoff = now - bound.periodSeconds * 1000;
        const [counts] = scope === 'global'
          ? await tx`SELECT COUNT(*) AS n, COALESCE(SUM(fee), 0)::text AS fee, COUNT(*) FILTER (WHERE account = ${account}) AS account_n, COALESCE(SUM(fee) FILTER (WHERE account = ${account}), 0)::text AS account_fee FROM funding_debits WHERE created_at > ${cutoff}`
          : scope === 'operation'
          ? await tx`SELECT COUNT(*) AS n, COALESCE(SUM(fee), 0)::text AS fee, COUNT(*) FILTER (WHERE account = ${account}) AS account_n, COALESCE(SUM(fee) FILTER (WHERE account = ${account}), 0)::text AS account_fee FROM funding_debits WHERE created_at > ${cutoff} AND kind = ${request.kind}`
          : await tx`SELECT COUNT(*) AS n, COALESCE(SUM(fee), 0)::text AS fee, COUNT(*) FILTER (WHERE account = ${account}) AS account_n, COALESCE(SUM(fee) FILTER (WHERE account = ${account}), 0)::text AS account_fee FROM funding_debits WHERE created_at > ${cutoff} AND app = ${app}`;
        if (BigInt(counts.n) >= BigInt(bound.txPerPeriod) || BigInt(counts.fee) + request.maxFee > bound.maxFeePerPeriod) throw new HttpError(429, 'FUNDING_CAP');
        if (BigInt(counts.account_n) >= BigInt(bound.perAccountPerPeriod) || BigInt(counts.account_fee) + request.maxFee > bound.perAccountMaxFeePerPeriod) throw new HttpError(429, 'ACCOUNT_FUNDING_CAP');
      };
      await check(this.policy.global, 'global');
      await check(this.policy.operations[request.kind], 'operation');
      if (request.kind === 'sponsor') await check(this.policy.apps[request.appKey!]!, 'app');
      await tx`INSERT INTO funding_debits (id, kind, account, app, fee, created_at, external) VALUES (${id}, ${request.kind}, ${account}, ${app}, ${request.maxFee.toString()}, ${now}, ${request.external ?? false})`;
    });
  }

  async setPaused(paused: boolean): Promise<void> {
    await this.sql.begin(async tx => {
      await accountingLock(tx);
      await tx`INSERT INTO funding_control (key, paused) VALUES ('global', ${paused}) ON CONFLICT (key) DO UPDATE SET paused = EXCLUDED.paused`;
    });
  }
  async isPaused(): Promise<boolean> {
    const [row] = await this.sql`SELECT paused FROM funding_control WHERE key = 'global'`;
    return !row || row.paused;
  }
}

/** Existing per-app count preflight remains an additional bound, not the durable authority. */
export function sponsorBudgetsFromFundingPolicy(policy: FundingPolicy): import('./budgets').Budgets {
  const anonymous = { name: 'anonymous', txPerPeriod: 0, periodSeconds: 3600, perAccountPerPeriod: 0, maxFeePerTx: 0n };
  return { anonymous, byKey: new Map(Object.entries(policy.apps).map(([key, value]) => [key, {
    name: 'app_' + digest(key).slice(0, 20), txPerPeriod: value.txPerPeriod, periodSeconds: value.periodSeconds,
    perAccountPerPeriod: value.perAccountPerPeriod, maxFeePerTx: value.maxFeePerTx,
  }])) };
}
