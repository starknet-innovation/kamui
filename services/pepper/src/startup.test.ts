import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('pepper startup emits only a fixed error code for invalid private configuration', async()=>{
  const cwd=mkdtempSync(join(tmpdir(),'kamui-pepper-startup-'));
  const sentinel='SYNTHETIC_INVALID_PRIVATE_CONFIGURATION';
  try {
    const child=Bun.spawn([process.execPath,join(import.meta.dir,'index.ts')],{cwd,env:{PATH:process.env.PATH!,HOME:process.env.HOME!,PEPPER_KEY_SOURCE:sentinel},stdout:'pipe',stderr:'pipe'});
    const output=await new Response(child.stderr).text();
    expect(await child.exited).toBe(1);
    expect(JSON.parse(output)).toEqual({event:'pepper_startup_failed'});
    expect(output).not.toContain(sentinel);
  } finally {rmSync(cwd,{recursive:true,force:true});}
});
