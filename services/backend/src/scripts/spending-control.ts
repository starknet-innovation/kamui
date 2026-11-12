// Operator-only, stopped-API control. No signing key or transaction is read/submitted.
import '../env';
import { loadRuntimeSecretFiles } from '../secrets';
import { acquirePostgresWriterLock, initializePostgres, storageBackend } from '../storage/postgres';
import { disabledFundingPolicy, PostgresFunding } from '../services/sponsor/funding';

const [ack, command, ...extra] = process.argv.slice(2);
if (ack !== '--api-stopped' || !['pause', 'resume', 'status'].includes(command ?? '') || extra.length) {
  console.error('Usage: bun run src/scripts/spending-control.ts --api-stopped <pause|resume|status>');
  process.exit(1);
}
let lease: Awaited<ReturnType<typeof acquirePostgresWriterLock>> | undefined;
try {
  await loadRuntimeSecretFiles(process.env, ['DATABASE_URL']);
  if (storageBackend(process.env) !== 'postgres') throw new Error('POSTGRES_REQUIRED');
  lease = await acquirePostgresWriterLock(process.env.DATABASE_URL!, () => {
    console.error(JSON.stringify({ status: 'refused', error: 'POSTGRES_WRITER_LOCK_LOST' }));
    process.exit(1);
  });
  await initializePostgres(lease.sql);
  const funding = new PostgresFunding(lease.sql, disabledFundingPolicy());
  if (command !== 'status') await funding.setPaused(command === 'pause');
  console.log(JSON.stringify({ status: 'ok', paused: await funding.isPaused() }));
} catch (error) {
  const message = error instanceof Error ? error.message : '';
  console.error(JSON.stringify({ status: 'refused', error: /^(POSTGRES_[A-Z_]+|DATABASE_URL_[A-Z_]+|STORAGE_BACKEND_INVALID|SQLITE_PATHS_WITH_POSTGRES)$/.test(message) ? message : 'SPENDING_CONTROL_FAILED' }));
  process.exitCode = 1;
} finally { await lease?.close(); }
