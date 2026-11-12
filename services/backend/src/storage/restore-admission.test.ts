import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../services/api/app';
import { assertRestoreReady, initializeRestoreGate, acknowledgeRestoreGate, blockRestoreGate } from './restore-fence';

test('restore gate blocks all POST work before rate limits and notices an atomic gate replacement', async () => {
  const dir = mkdtempSync(join(tmpdir(),'kamui-restore-admission-'));
  const path = join(dir,'state.json');
  let attempts=0;
  const app=buildApp({chain:'SN_SEPOLIA',ctx:{} as any,sponsor:{} as any,registry:{} as any,
    limiter:{take:async()=>{attempts++;return true;}}, admissionGuard:()=>assertRestoreReady({RESTORE_GATE_FILE:path})});
  const poll=()=>app.handle(new Request('http://localhost/recover/status',{method:'POST',body:JSON.stringify({jobId:'0x'+'1'.repeat(62)})}));
  try {
    expect((await poll()).status).toBe(503);
    expect(attempts).toBe(0);
    const gate=initializeRestoreGate(path);
    acknowledgeRestoreGate(path,{version:1,generation:gate.generation,mode:'fresh',reviewRef:'local-test',apiAndRotatorStopped:true,originalWriterCannotRestart:true});
    expect((await poll()).status).toBe(404);
    expect(attempts).toBe(2);
    blockRestoreGate(path);
    expect((await poll()).status).toBe(503);
    expect(attempts).toBe(2);
    expect((await app.handle(new Request('http://localhost/live'))).status).toBe(200);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
