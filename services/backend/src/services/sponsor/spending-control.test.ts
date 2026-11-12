import { expect, test } from 'bun:test';
import { SQL } from 'bun';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { acquirePostgresWriterLock } from '../../storage/postgres';

const url = process.env.KAMUI_TEST_POSTGRES_URL;
const integration = url ? test : test.skip;
integration('operator spending control requires stopped API and persists pause without signing', async () => {
  const admin = new SQL(url!);
  const database = `kamui_funding_cli_${randomUUID().replaceAll('-', '')}`;
  const target = new URL(url!); target.pathname = `/${database}`;
  const script = resolve(import.meta.dir, '../../scripts/spending-control.ts');
  const run = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, script, ...args], { cwd: tmpdir(), env: { DATABASE_URL: target.toString(), STORAGE_BACKEND: 'postgres', PATH: process.env.PATH }, stdout: 'pipe', stderr: 'pipe' });
    return { exit: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() };
  };
  await admin.unsafe(`CREATE DATABASE ${database}`);
  try {
    const noAck = await run('pause'); expect(noAck.exit).toBe(1);
    expect(noAck.stderr).toContain('Usage:');
    const first = await run('--api-stopped', 'status'); expect(first.exit).toBe(0);
    expect(JSON.parse(first.stdout)).toEqual({ status: 'ok', paused: true });
    const lease = await acquirePostgresWriterLock(target.toString());
    try {
      const refused = await run('--api-stopped', 'resume'); expect(refused.exit).toBe(1);
      expect(JSON.parse(refused.stderr)).toEqual({ status: 'refused', error: 'POSTGRES_WRITER_ALREADY_RUNNING' });
    } finally { await lease.close(); }
    expect(JSON.parse((await run('--api-stopped', 'resume')).stdout)).toEqual({ status: 'ok', paused: false });
    expect(JSON.parse((await run('--api-stopped', 'pause')).stdout)).toEqual({ status: 'ok', paused: true });
    const final = await run('--api-stopped', 'status'); expect(final.exit).toBe(0);
    expect(JSON.parse(final.stdout)).toEqual({ status: 'ok', paused: true });
    expect(final.stdout + final.stderr).not.toContain(target.toString());
  } finally {
    await admin.unsafe(`DROP DATABASE ${database} WITH (FORCE)`);
    await admin.close();
  }
});
