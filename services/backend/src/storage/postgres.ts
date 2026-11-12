// PostgreSQL bootstrap and the single API/operator writer lease. Never log the URL.
import { SQL } from 'bun';
import { FUNDING_SCHEMA_SQL, FUNDING_V3_MIGRATION_SQL } from '../services/sponsor/funding';
import { REGISTRY_SCHEMA_SQL } from '../services/registry/postgres-store';
import { RECOVERY_POSTGRES_SCHEMA } from '../services/recovery/postgres-store';

export const POSTGRES_WRITER_LOCK = [1262570837, 1] as const;

export function postgresUrl(value: string | undefined): string {
  if (!value) throw new Error('DATABASE_URL_REQUIRED');
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error('DATABASE_URL_INVALID'); }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error('DATABASE_URL_INVALID');
  return value;
}

export function storageBackend(env: Record<string, string | undefined>): 'sqlite' | 'postgres' {
  const backend = env.STORAGE_BACKEND || (env.DATABASE_URL ? 'postgres' : 'sqlite');
  if (backend !== 'sqlite' && backend !== 'postgres') throw new Error('STORAGE_BACKEND_INVALID');
  if (backend === 'postgres') {
    postgresUrl(env.DATABASE_URL);
    if (env.REGISTRY_DB || env.RECOVERY_DB) throw new Error('SQLITE_PATHS_WITH_POSTGRES');
  } else if (env.DATABASE_URL) throw new Error('DATABASE_URL_WITH_SQLITE');
  return backend;
}

/** One connection owns both the session lock and every data transaction. A separate
 * lease connection would leave an overlap window when only that connection died.
 * The pool is terminally closed on loss; it must never reconnect without a new lease.
 */
export async function acquirePostgresWriterLock(url: string, onLost: () => void = () => {}): Promise<{ sql: SQL; close(): Promise<void> }> {
  let closing = false;
  let acquired = false;
  let lost = false;
  const fail = () => {
    if (!acquired || closing || lost) return;
    lost = true;
    void sql.close({ timeout: 0 }).catch(() => {});
    onLost();
  };
  const sql = new SQL(postgresUrl(url), {
    max: 1, idleTimeout: 0, maxLifetime: 0, connectionTimeout: 5,
    connection: { application_name: 'kamui-writer-lease', synchronous_commit: 'on', statement_timeout: '15000', lock_timeout: '5000' },
    onclose: fail,
    onconnect: () => { if (acquired) fail(); },
  });
  try {
    const [row] = await sql`SELECT pg_try_advisory_lock(${POSTGRES_WRITER_LOCK[0]}, ${POSTGRES_WRITER_LOCK[1]}) AS acquired`;
    if (!row.acquired) throw new Error('POSTGRES_WRITER_ALREADY_RUNNING');
    acquired = true;
    const [fsync] = await sql.unsafe('SHOW fsync');
    const [pages] = await sql.unsafe('SHOW full_page_writes');
    if (fsync.fsync !== 'on' || pages.full_page_writes !== 'on') throw new Error('POSTGRES_DURABILITY_REQUIRED');
    return { sql, async close() {
      if (closing) return;
      closing = true;
      await sql.close({ timeout: 0 });
    } };
  } catch (error) {
    closing = true;
    await sql.close({ timeout: 0 });
    throw error;
  }
}

/** Versioned, transactional first schema. No data cutover or replay-state reset. */
export async function initializePostgres(sql: SQL, _binding?: string): Promise<void> {
  await sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(${POSTGRES_WRITER_LOCK[0]}, 2)`;
    await tx.unsafe('CREATE TABLE IF NOT EXISTS kamui_storage_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const [version] = await tx`SELECT value FROM kamui_storage_meta WHERE key = 'schema_version'`;
    if (version && !['1', '2', '3'].includes(version.value)) throw new Error('POSTGRES_SCHEMA_VERSION_UNSUPPORTED');
    await tx.unsafe(REGISTRY_SCHEMA_SQL);
    await tx.unsafe(RECOVERY_POSTGRES_SCHEMA);
    await tx.unsafe(FUNDING_SCHEMA_SQL);
    if (version?.value !== '3') await tx.unsafe(FUNDING_V3_MIGRATION_SQL);
    await tx`INSERT INTO kamui_storage_meta (key, value) VALUES ('schema_version', '3') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
  });
}
