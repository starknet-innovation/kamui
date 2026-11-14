// Kamui: what an approved app may do for itself: read its own usage and replace or end its
// credential. Runs against an explicit disposable PostgreSQL, like funding.test.ts.
import { describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { createHash, randomUUID } from 'node:crypto';
import { FUNDING_SCHEMA_SQL, PostgresFunding, type FundingLimit, type FundingPolicy } from './funding';

const url = process.env.KAMUI_TEST_POSTGRES_URL;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const appKey = 'kamui_approved_test_app';
const otherKey = 'kamui_other_test_app_1';
const credential = 'TEST_ONLY_SERVER_CREDENTIAL_NOT_FOR_DISK';
const otherCredential = 'TEST_ONLY_OTHER_APP_CREDENTIAL_NOT_FOR_DISK';
const bound = (v: Partial<FundingLimit> = {}): FundingLimit => ({ periodSeconds: 3600, txPerPeriod: 10, perAccountPerPeriod: 10, maxFeePerTx: 100n, maxFeePerPeriod: 1000n, perAccountMaxFeePerPeriod: 1000n, ...v });
const policy = (): FundingPolicy => ({
  global: bound({ txPerPeriod: 100, maxFeePerPeriod: 10_000n }), operations: { sponsor: bound({ txPerPeriod: 100, maxFeePerPeriod: 10_000n }), deployment: bound(), recovery: bound() },
  apps: { [appKey]: { ...bound({ txPerPeriod: 5, perAccountPerPeriod: 3, maxFeePerPeriod: 60n, perAccountMaxFeePerPeriod: 40n }), credentialHash: sha(credential) }, [otherKey]: { ...bound(), credentialHash: sha(otherCredential) } },
  allowExternalPaymaster: false,
});
const debit = (over: Record<string, unknown> = {}) => ({ kind: 'sponsor' as const, account: '0x1', appKey, credential, maxFee: 10n, ...over });

async function withDatabase(work: (sql: SQL, other: SQL) => Promise<void>) {
  const schema = `kamui_selfserve_${randomUUID().replaceAll('-', '')}`;
  const admin = new SQL(url!);
  let sql: SQL | undefined, other: SQL | undefined;
  try {
    await admin.unsafe(`CREATE SCHEMA ${schema}`);
    sql = new SQL(url!, { max: 4, connection: { search_path: schema } });
    other = new SQL(url!, { max: 4, connection: { search_path: schema } });
    await sql.unsafe(FUNDING_SCHEMA_SQL);
    await sql`UPDATE funding_control SET paused = false WHERE key = 'global'`;
    await work(sql, other);
  } finally {
    await sql?.close(); await other?.close();
    await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.close();
  }
}

test('self-serve refuses a missing, unknown or malformed credential without reading the database', async () => {
  const funding = new PostgresFunding({} as SQL, policy());
  for (const [key, token] of [[null, null], [appKey, null], [appKey, ''], [appKey, 'x'.repeat(4097)], ['unregistered_app_key_1', credential], ['__proto__', credential], ['propertyIsEnumerable', credential]] as const) {
    await expect(funding.appUsage(key, token)).rejects.toThrow('APP_AUTH_REQUIRED');
    await expect(funding.rotateAppCredential(key, token)).rejects.toThrow('APP_AUTH_REQUIRED');
    await expect(funding.revokeAppCredential(key, token)).rejects.toThrow('APP_AUTH_REQUIRED');
  }
  await expect(funding.appUsage(appKey, credential, 'not-an-address')).rejects.toThrow('BAD_ACCOUNT');
});

describe.skipIf(!url)('PostgreSQL self-serve sponsorship (explicit disposable database)', () => {
  test('usage reports the app\'s own limits, rolling usage and what is left, and nothing of another app', async () => {
    await withDatabase(async sql => {
      let now = 10_000_000;
      const funding = new PostgresFunding(sql, policy(), () => now);
      expect(await funding.appUsage(appKey, credential)).toEqual({
        limits: { periodSeconds: 3600, txPerPeriod: 5, perAccountPerPeriod: 3, maxFeePerTx: '100', maxFeePerPeriod: '60', perAccountMaxFeePerPeriod: '40' },
        usage: { tx: 0, fee: '0', txRemaining: 5, feeRemaining: '60' }, paused: false, credentialRotatedAt: null,
      });
      await funding.debit(debit());
      await funding.debit(debit({ account: '0x0002', maxFee: 15n }));
      // Another app, deployments and wallet maintenance spend the shared budget, not this app's.
      await funding.debit(debit({ appKey: otherKey, credential: otherCredential, maxFee: 99n }));
      await funding.debit({ kind: 'deployment', account: '0x1', maxFee: 7n });
      const usage = await funding.appUsage(appKey, credential, '0x02');
      expect(usage.usage).toEqual({ tx: 2, fee: '25', txRemaining: 3, feeRemaining: '35' });
      expect(usage.account).toEqual({ address: '0x2', tx: 1, fee: '15', txRemaining: 2, feeRemaining: '25' });
      expect((await funding.appUsage(otherKey, otherCredential, '0x1')).account).toEqual({ address: '0x1', tx: 1, fee: '99', txRemaining: 9, feeRemaining: '901' });
      // One app's credential never opens another app's numbers.
      await expect(funding.appUsage(otherKey, credential)).rejects.toThrow('APP_AUTH_REQUIRED');
      await expect(funding.appUsage(appKey, otherCredential)).rejects.toThrow('APP_AUTH_REQUIRED');
      // Only the passing of the period gives budget back.
      now += 3600 * 1000;
      expect((await funding.appUsage(appKey, credential)).usage).toEqual({ tx: 0, fee: '0', txRemaining: 5, feeRemaining: '60' });
    });
  });

  test('usage never reports less than nothing left, and shows the operator pause', async () => {
    await withDatabase(async sql => {
      const generous = policy();
      const funding = new PostgresFunding(sql, generous);
      for (let i = 0; i < 4; i++) await funding.debit(debit({ account: `0x${i + 1}` }));
      const tightened = policy(); tightened.apps[appKey]!.txPerPeriod = 2; tightened.apps[appKey]!.maxFeePerPeriod = 30n;
      const reopened = new PostgresFunding(sql, tightened);
      expect((await reopened.appUsage(appKey, credential)).usage).toEqual({ tx: 4, fee: '40', txRemaining: 0, feeRemaining: '0' });
      await reopened.setPaused(true);
      expect((await reopened.appUsage(appKey, credential)).paused).toBe(true);
    });
  });

  test('rotation returns a new credential once, stores only its hash, and ends the old one everywhere', async () => {
    await withDatabase(async (sql, other) => {
      const now = 1_800_000_000_000;
      const funding = new PostgresFunding(sql, policy(), () => now);
      const { token, rotatedAt } = await funding.rotateAppCredential(appKey, credential);
      expect(token).toMatch(/^[A-Za-z0-9_-]{64}$/);
      expect(rotatedAt).toBe(now);
      const rows = await sql`SELECT * FROM funding_app_credentials`;
      expect(rows).toHaveLength(1);
      expect(rows[0].credential_hash).toBe(sha(token));
      const bytes = JSON.stringify(rows, (_, v) => typeof v === 'bigint' ? v.toString() : v);
      expect(bytes).not.toContain(token); expect(bytes).not.toContain(credential); expect(bytes).not.toContain(appKey);
      // A second process, as after a restart, reads the same decision: the policy file's hash no longer opens anything.
      const reopened = new PostgresFunding(other, policy(), () => now);
      for (const instance of [funding, reopened]) {
        await expect(instance.authorizeApp(appKey, credential)).rejects.toThrow('APP_AUTH_REQUIRED');
        await expect(instance.debit(debit())).rejects.toThrow('APP_AUTH_REQUIRED');
        await expect(instance.appUsage(appKey, credential)).rejects.toThrow('APP_AUTH_REQUIRED');
        await expect(instance.rotateAppCredential(appKey, credential)).rejects.toThrow('APP_AUTH_REQUIRED');
        await instance.authorizeApp(appKey, token);
      }
      await reopened.debit(debit({ credential: token }));
      expect((await reopened.appUsage(appKey, token)).credentialRotatedAt).toBe(now);
      expect(Number((await sql`SELECT COUNT(*) AS n FROM funding_debits`)[0].n)).toBe(1);
      // The other app is untouched, and the new credential is this app's alone.
      await funding.authorizeApp(otherKey, otherCredential);
      await expect(funding.authorizeApp(otherKey, token)).rejects.toThrow('APP_AUTH_REQUIRED');
      // Rotating again ends the first replacement too.
      const second = await reopened.rotateAppCredential(appKey, token);
      expect(second.token).not.toBe(token);
      await expect(funding.authorizeApp(appKey, token)).rejects.toThrow('APP_AUTH_REQUIRED');
      await funding.authorizeApp(appKey, second.token);
    });
  });

  test('concurrent rotations with the same credential: exactly one wins and its credential is the one that works', async () => {
    await withDatabase(async (sql, other) => {
      const first = new PostgresFunding(sql, policy()), second = new PostgresFunding(other, policy());
      const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => (i % 2 ? first : second).rotateAppCredential(appKey, credential)));
      const won = results.filter((r): r is PromiseFulfilledResult<{ token: string; rotatedAt: number }> => r.status === 'fulfilled');
      expect(won).toHaveLength(1);
      await first.authorizeApp(appKey, won[0]!.value.token);
      expect(Number((await sql`SELECT COUNT(*) AS n FROM funding_app_credentials`)[0].n)).toBe(1);
    });
  });

  test('a failed rotation changes nothing', async () => {
    await withDatabase(async sql => {
      const funding = new PostgresFunding(sql, policy());
      await expect(funding.rotateAppCredential(appKey, 'wrong')).rejects.toThrow('APP_AUTH_REQUIRED');
      await expect(funding.revokeAppCredential(appKey, otherCredential)).rejects.toThrow('APP_AUTH_REQUIRED');
      expect(await sql`SELECT 1 FROM funding_app_credentials`).toHaveLength(0);
      await funding.authorizeApp(appKey, credential);
    });
  });

  test('revocation ends the credential with no replacement; rotation and usage are refused after it', async () => {
    await withDatabase(async (sql, other) => {
      const funding = new PostgresFunding(sql, policy());
      const { token } = await funding.rotateAppCredential(appKey, credential);
      await funding.revokeAppCredential(appKey, token);
      const reopened = new PostgresFunding(other, policy());
      for (const dead of [credential, token, '', '0'.repeat(64)]) {
        await expect(reopened.authorizeApp(appKey, dead)).rejects.toThrow('APP_AUTH_REQUIRED');
        await expect(reopened.debit(debit({ credential: dead }))).rejects.toThrow('APP_AUTH_REQUIRED');
        await expect(reopened.rotateAppCredential(appKey, dead)).rejects.toThrow('APP_AUTH_REQUIRED');
      }
      expect((await sql`SELECT credential_hash FROM funding_app_credentials`)[0].credential_hash).toBeNull();
      await reopened.authorizeApp(otherKey, otherCredential);
    });
  });

  test('a credential the operator issues afterwards takes precedence over a self-serve rotation or revocation', async () => {
    await withDatabase(async sql => {
      const funding = new PostgresFunding(sql, policy());
      const { token } = await funding.rotateAppCredential(appKey, credential);
      await funding.revokeAppCredential(otherKey, otherCredential);
      const reissued = policy();
      reissued.apps[appKey]!.credentialHash = sha('OPERATOR_REISSUED_FIXTURE_ONE');
      reissued.apps[otherKey]!.credentialHash = sha('OPERATOR_REISSUED_FIXTURE_TWO');
      const reopened = new PostgresFunding(sql, reissued);
      await reopened.authorizeApp(appKey, 'OPERATOR_REISSUED_FIXTURE_ONE');
      await reopened.authorizeApp(otherKey, 'OPERATOR_REISSUED_FIXTURE_TWO');
      await expect(reopened.authorizeApp(appKey, token)).rejects.toThrow('APP_AUTH_REQUIRED');
      await expect(reopened.authorizeApp(appKey, credential)).rejects.toThrow('APP_AUTH_REQUIRED');
      expect((await reopened.appUsage(appKey, 'OPERATOR_REISSUED_FIXTURE_ONE')).credentialRotatedAt).toBeNull();
      // And the app can rotate again from the operator's credential.
      const next = await reopened.rotateAppCredential(appKey, 'OPERATOR_REISSUED_FIXTURE_ONE');
      await reopened.authorizeApp(appKey, next.token);
      await expect(reopened.authorizeApp(appKey, 'OPERATOR_REISSUED_FIXTURE_ONE')).rejects.toThrow('APP_AUTH_REQUIRED');
    });
  });

  test('a credential replaced between the sponsor preflight and the debit pays for nothing', async () => {
    await withDatabase(async sql => {
      const funding = new PostgresFunding(sql, policy());
      await funding.authorizeApp(appKey, credential);
      await funding.rotateAppCredential(appKey, credential);
      await expect(funding.debit(debit())).rejects.toThrow('APP_AUTH_REQUIRED');
      expect(await sql`SELECT 1 FROM funding_debits`).toHaveLength(0);
    });
  });
});
