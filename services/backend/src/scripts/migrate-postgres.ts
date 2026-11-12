// Offline operator command. Reads no signing key and submits no chain transaction.
import '../env'; // Public deployment defaults only; no RPC or signing-key access.
import { shortString } from 'starknet';
import { migrateSqliteToPostgres } from '../storage/migrate-sqlite';

import { loadRuntimeSecretFiles } from '../secrets';

const [acknowledgement, registryPath, recoveryPath, ...extra] = process.argv.slice(2);
if (acknowledgement !== '--api-stopped' || !registryPath || !recoveryPath || extra.length) {
  console.error('Usage: bun run src/scripts/migrate-postgres.ts --api-stopped <registry-sqlite-path> <recovery-sqlite-path>');
  process.exit(1);
}
try {
  await loadRuntimeSecretFiles(process.env, ['DATABASE_URL']);
  const url = process.env.DATABASE_URL;
  const chain = process.env.CHAIN_ID;
  const classHash = process.env.KAMUI_ACCOUNT_CLASS_HASH;
  if (!url || !chain || !/^[A-Z0-9_]{1,31}$/.test(chain) || !classHash || !/^0x[0-9a-fA-F]{1,64}$/.test(classHash)) throw new Error('SQLITE_MIGRATION_CONFIG_REQUIRED');
  const counts = await migrateSqliteToPostgres(url, {
    registryPath, recoveryPath, binding: `${shortString.encodeShortString(chain)}:${classHash}`, apiStopped: true,
  });
  console.log(JSON.stringify({ status: 'migrated', ...counts }));
} catch (error) {
  // SQL/driver/FS exceptions can contain URLs, paths or row contents. Print only known codes.
  const message = error instanceof Error ? error.message : '';
  const safe = /^(SQLITE_MIGRATION_[A-Z_]+|RECOVERY_DB_NETWORK_MISMATCH|POSTGRES_[A-Z_]+)$/.test(message);
  console.error(JSON.stringify({ status: 'refused', error: safe ? message : 'SQLITE_MIGRATION_FAILED' }));
  process.exitCode = 1;
}
