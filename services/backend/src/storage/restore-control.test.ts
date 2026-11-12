import { afterAll, beforeAll, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readRestoreGate } from './restore-fence';

const integration = process.env.KAMUI_TEST_POSTGRES_URL ? test : test.skip;
const db = 'kamui_restore_' + randomUUID().replaceAll('-', '');
let admin: SQL;
let sql: SQL;
let dir: string;
let gate: string;
let secret: string;
const script = join(import.meta.dir, '../scripts/restore-control.ts');
beforeAll(async () => {
  if (!process.env.KAMUI_TEST_POSTGRES_URL) return;
  admin = new SQL(process.env.KAMUI_TEST_POSTGRES_URL);
  await admin.unsafe(`CREATE DATABASE ${db}`);
  const url = new URL(process.env.KAMUI_TEST_POSTGRES_URL); url.pathname = '/' + db;
  sql = new SQL(url.toString());
  dir = mkdtempSync(join(tmpdir(), 'kamui-restore-control-'));
  gate = join(dir, 'gate/state.json'); secret = join(dir, 'DATABASE_URL');
  writeFileSync(secret, url.toString(), { mode: 0o600 });
});
afterAll(async () => {
  if (!admin) return;
  await sql.close();
  await admin.unsafe(`DROP DATABASE ${db} WITH (FORCE)`); await admin.close();
  rmSync(dir, { recursive: true, force: true });
});
async function control(...args: string[]) {
  // No inherited application signing keys or runtime .env.local.
  const child = Bun.spawn([process.execPath, script, ...args], {
    cwd: dir, env: { PATH: process.env.PATH, NODE_ENV: 'test', DATABASE_URL_FILE: secret, RESTORE_GATE_FILE: gate },
    stdout: 'pipe', stderr: 'pipe',
  });
  return { code: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() };
}
const acknowledgement = () => ({ version: 1, generation: readRestoreGate(gate).generation, mode: 'fresh', reviewRef: 'local-gate-cli-drill', apiAndRotatorStopped: true, originalWriterCannotRestart: true });

integration('operator CLI loads scoped DB secret, allows empty first setup and refuses reuse or fresh acknowledgement of restored data', async () => {
  expect((await control('initialize')).code).toBe(0);
  const checklist = join(dir, 'ack.json'); writeFileSync(checklist, JSON.stringify(acknowledgement()));
  const first = await control('acknowledge', checklist);
  expect(first.code).toBe(0); expect(JSON.parse(first.stdout)).toEqual({ status: 'ready', mode: 'fresh' });
  expect(first.stdout + first.stderr).not.toContain('postgres://');
  expect((await control('initialize')).code).toBe(1);
  expect((await control('block')).code).toBe(0);
  writeFileSync(checklist, JSON.stringify(acknowledgement()));
  expect((await control('acknowledge', checklist)).code).toBe(1);
  expect(readRestoreGate(gate).state).toBe('blocked');
});

integration('fresh acknowledgement refuses a nonempty initialized database while preserving the blocked gate', async () => {
  rmSync(join(dir, 'gate'), { recursive: true });
  expect((await control('initialize')).code).toBe(0);
  await sql`CREATE TABLE funding_debits (id TEXT PRIMARY KEY)`;
  await sql`INSERT INTO funding_debits (id) VALUES ('fixture')`;
  const checklist = join(dir, 'ack.json'); writeFileSync(checklist, JSON.stringify(acknowledgement()));
  const refused = await control('acknowledge', checklist);
  expect(refused.code).toBe(1); expect(refused.stderr).toContain('RESTORE_FRESH_DATABASE_NOT_EMPTY');
  expect(readRestoreGate(gate).state).toBe('blocked');
});
