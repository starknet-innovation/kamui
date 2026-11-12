import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileSecretSource } from './secrets';

test('file secret source reads a scoped private mount and rejects unmounted roles/unsafe files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kamui-secret-source-'));
  const path = join(dir, 'RELAYER_PRIVATE_KEY');
  try {
    const source = new FileSecretSource(dir);
    writeFileSync(path, 'synthetic-fixture-value\n', { mode: 0o600 });
    expect(await source.get('RELAYER_PRIVATE_KEY')).toBe('synthetic-fixture-value');
    await expect(source.get('OWNER_PRIVATE_KEY')).rejects.toThrow('SECRET_FILE_UNAVAILABLE');
    await expect(source.get('../RELAYER_PRIVATE_KEY')).rejects.toThrow('SECRET_NAME_INVALID');
    chmodSync(path, 0o644);
    await expect(source.get('RELAYER_PRIVATE_KEY')).rejects.toThrow('SECRET_FILE_UNAVAILABLE');
    chmodSync(path, 0o600);
    rmSync(path); symlinkSync('missing', path);
    await expect(source.get('RELAYER_PRIVATE_KEY')).rejects.toThrow('SECRET_FILE_UNAVAILABLE');
    rmSync(path); writeFileSync(path, 'x'.repeat(4097), {mode:0o600});
    await expect(source.get('RELAYER_PRIVATE_KEY')).rejects.toThrow('SECRET_FILE_UNAVAILABLE');
    expect(() => new FileSecretSource('relative')).toThrow('SECRET_DIRECTORY_INVALID');
  } finally { rmSync(dir, {recursive:true,force:true}); }
});

test('runtime file settings reject ambiguous values and never fall back on file failure', async () => {
  const { loadRuntimeSecretFiles } = await import('./secrets');
  const dir = mkdtempSync(join(tmpdir(), 'kamui-runtime-source-'));
  const path = join(dir, 'DATABASE_URL');
  try {
    writeFileSync(path, 'postgres://local-fixture/test\n', {mode:0o600});
    const env:Record<string,string|undefined> = { DATABASE_URL_FILE:path };
    await loadRuntimeSecretFiles(env);
    expect(env.DATABASE_URL).toBe('postgres://local-fixture/test');
    await expect(loadRuntimeSecretFiles({DATABASE_URL:'postgres://another',DATABASE_URL_FILE:path})).rejects.toThrow('SECRET_CONFIGURATION_AMBIGUOUS');
    await expect(loadRuntimeSecretFiles({DATABASE_URL_FILE:join(dir,'missing')})).rejects.toThrow('SECRET_FILE_UNAVAILABLE');
  } finally {rmSync(dir,{recursive:true,force:true});}
});
