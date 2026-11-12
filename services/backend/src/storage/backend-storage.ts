import { loadFundingPolicy, PostgresFunding } from '../services/sponsor/funding';
import { dirname, join } from 'node:path';
import { RegistryStore, DEFAULT_REGISTRY_DB, type RegistryStorage } from '../services/registry/store';
import { PostgresRegistryStore } from '../services/registry/postgres-store';
import { RecoveryJobs, type RecoveryJobsService } from '../services/recovery/jobs';
import { PostgresRecoveryJobs } from '../services/recovery/postgres-jobs';
import { acquirePostgresWriterLock, initializePostgres, storageBackend } from './postgres';

export async function openBackendStorage(env: Record<string, string | undefined>, binding: string, onLeaseLost: () => void) {
  const backend = storageBackend(env);
  if (backend === 'sqlite') {
    const store = new RegistryStore(env.REGISTRY_DB || undefined, undefined, env.REGISTRY_JOURNAL_MODE || 'DELETE');
    try {
      const recoveryJobs = new RecoveryJobs({ path: env.RECOVERY_DB || join(dirname(env.REGISTRY_DB || DEFAULT_REGISTRY_DB), 'recovery.sqlite'), binding, journalMode: env.REGISTRY_JOURNAL_MODE || 'DELETE' });
      return { backend, store: store as RegistryStorage, recoveryJobs: recoveryJobs as RecoveryJobsService, funding: undefined, fundingPolicy: undefined,
        async close() { recoveryJobs.close(); store.close(); } };
    } catch (error) { store.close(); throw error; }
  }
  const lease = await acquirePostgresWriterLock(env.DATABASE_URL!, onLeaseLost);
  const sql = lease.sql;
  try {
    await initializePostgres(sql);
    const recoveryJobs = await PostgresRecoveryJobs.create(sql, { binding });
    const fundingPolicy = loadFundingPolicy(env.FUNDING_POLICY_FILE);
    const funding = new PostgresFunding(sql, fundingPolicy);
    return { backend, funding, fundingPolicy, store: new PostgresRegistryStore(sql) as RegistryStorage, recoveryJobs: recoveryJobs as RecoveryJobsService,
      async close() { await lease.close(); } };
  } catch (error) {
    await lease.close();
    throw error;
  }
}
