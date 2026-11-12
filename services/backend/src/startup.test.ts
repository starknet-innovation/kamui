import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('API startup never echoes malformed signing configuration in top-level exceptions', async () => {
  const cwd=mkdtempSync(join(tmpdir(),'kamui-startup-'));
  const sentinel='SYNTHETIC_INVALID_SIGNING_FIXTURE_DO_NOT_LOG';
  try {
    const child=Bun.spawn([process.execPath,join(import.meta.dir,'services/api/index.ts')],{
      cwd,env:{PATH:process.env.PATH!,HOME:process.env.HOME!,STORAGE_BACKEND:'postgres',DATABASE_URL:'invalid://never-connect',SECRET_SOURCE:'env',RELAYER_PRIVATE_KEY:sentinel,RELAYER_ADDRESS:'0x1',RPC_URL:'http://127.0.0.1:1',CHAIN_ID:'SN_SEPOLIA',AUTHORIZED_GOOGLE_RECOVERY_CLIENT_ID:'fixture',KAMUI_ACCOUNT_CLASS_HASH:'0x1'},stdout:'pipe',stderr:'pipe'});
    const output=await new Response(child.stderr).text();
    expect(await child.exited).toBe(1);
    expect(output).toContain('api_startup_failed');
    expect(output).not.toContain(sentinel);
    expect(output).not.toContain('BigInt');
  } finally {rmSync(cwd,{recursive:true,force:true});}
});
