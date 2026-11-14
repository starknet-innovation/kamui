// Kamui: storage for the session registry, in SQLite (bun:sqlite). One row per
// (account, session key). The rows say which sites an account connected to, which is private:
// nothing here is logged, and the file belongs on a private volume.
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type StoredSession = {
  publicKey: string;
  origin: string;
  appName?: string;
  validUntil: number;
  maxCalls: number;
  maxFeePerTx: string;
  calls: { to: string; entrypoint: string }[];
  limits: { token: string; maxPerCall: string; maxPerWindow: string; windowSeconds: number }[];
};
export type ListedSession = StoredSession & { createdAt: number };

export const DEFAULT_REGISTRY_DB = `${import.meta.dir}/../../../data/registry.sqlite`;
/** Matches the SDK's REGISTRY_MAX_ENTRIES: a listing never holds more than the client keeps. */
export const MAX_SESSIONS_PER_ACCOUNT = 50;

const JOURNAL_MODES = ['DELETE', 'TRUNCATE', 'WAL'];

/** Says whether a path sits on a network filesystem (NFS, EFS). Injectable so tests can fake the volume type. */
export type VolumeProbe = (path: string) => boolean;
export type RegistryStoreOptions = { isNetworkVolume?: VolumeProbe };

/** Stores may be synchronous locally or asynchronous over PostgreSQL. */
export type Awaitable<T> = T | Promise<T>;
export interface RegistryStorage {
  useOnce(message: string, expires: number, now: number): Awaitable<boolean>;
  dropExpired(now: number): Awaitable<number>;
  put(account: string, session: StoredSession, now: number): Awaitable<boolean>;
  list(account: string, now: number): Awaitable<ListedSession[]>;
  remove(account: string, publicKey: string): Awaitable<boolean>;
  readonly journalMode: string;
  close(): Awaitable<void>;
}

export class RegistryStore implements RegistryStorage {
  private db: Database;

  /**
   * `path` is a file, or ':memory:' in tests. `account` and `publicKey` arguments must be canonical (see `felt` in registry.ts).
   *
   * The journal mode is set explicitly, to DELETE (a rollback journal) by default. WAL needs
   * shared memory between the processes that open the file, which a network volume (NFS, EFS)
   * does not give; on such a volume use DELETE and exactly one api process. WAL is only for a
   * local disk (REGISTRY_JOURNAL_MODE=WAL).
   *
   * `options.isNetworkVolume` is a test seam for the volume type; the constructor does not consult it yet.
   */
  constructor(
    path: string = DEFAULT_REGISTRY_DB,
    readonly maxPerAccount = MAX_SESSIONS_PER_ACCOUNT,
    journalMode = 'DELETE',
    readonly options: RegistryStoreOptions = {},
  ) {
    if (!JOURNAL_MODES.includes(journalMode.toUpperCase())) throw new Error(`REGISTRY_JOURNAL_MODE must be one of ${JOURNAL_MODES.join(', ')}`);
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec(`PRAGMA journal_mode = ${journalMode.toUpperCase()}`);
    this.db.exec('PRAGMA synchronous = FULL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(`CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account TEXT NOT NULL,
      public_key TEXT NOT NULL,
      valid_until INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      session TEXT NOT NULL,
      UNIQUE (account, public_key)
    )`);
    this.db.exec('CREATE INDEX IF NOT EXISTS sessions_valid_until ON sessions (valid_until)');
    // Signed messages already accepted, kept until their timestamp is too old to be accepted anyway.
    this.db.exec('CREATE TABLE IF NOT EXISTS used_messages (message TEXT PRIMARY KEY, expires INTEGER NOT NULL) WITHOUT ROWID');
    this.db.exec('CREATE INDEX IF NOT EXISTS used_messages_expires ON used_messages (expires)');
  }

  /**
   * Records a signed message as used. False when it was used before. `expires` is the last
   * second at which the message would still be accepted; older rows are dropped here.
   */
  useOnce(message: string, expires: number, now: number): boolean {
    this.db.query('DELETE FROM used_messages WHERE expires < $now').run({ now });
    return this.db.query('INSERT OR IGNORE INTO used_messages (message, expires) VALUES ($message, $expires)').run({ message, expires }).changes > 0;
  }

  /** Deletes every entry whose session has expired. Returns how many. */
  dropExpired(now: number): number {
    return this.db.query('DELETE FROM sessions WHERE valid_until <= $now').run({ now }).changes;
  }

  /**
   * Writes an entry, replacing the one for the same (account, session key). Returns false,
   * and writes nothing, when the account already holds `maxPerAccount` other live entries.
   */
  put(account: string, session: StoredSession, now: number): boolean {
    return this.db.transaction(() => {
      this.db.query('DELETE FROM sessions WHERE account = $account AND (valid_until <= $now OR public_key = $key)').run({ account, now, key: session.publicKey });
      const { n } = this.db.query('SELECT COUNT(*) AS n FROM sessions WHERE account = $account').get({ account }) as { n: number };
      if (n >= this.maxPerAccount) return false;
      this.db
        .query('INSERT INTO sessions (account, public_key, valid_until, created_at, session) VALUES ($account, $key, $validUntil, $now, $session)')
        .run({ account, key: session.publicKey, validUntil: session.validUntil, now, session: JSON.stringify(session) });
      return true;
    })();
  }

  /** The account's live entries, newest first. */
  list(account: string, now: number): ListedSession[] {
    this.db.query('DELETE FROM sessions WHERE account = $account AND valid_until <= $now').run({ account, now });
    const rows = this.db
      .query('SELECT session, created_at FROM sessions WHERE account = $account ORDER BY created_at DESC, id DESC LIMIT $limit')
      .all({ account, limit: this.maxPerAccount }) as { session: string; created_at: number }[];
    return rows.map((row) => ({ ...(JSON.parse(row.session) as StoredSession), createdAt: row.created_at }));
  }

  /** Removes an entry. True when there was one. */
  remove(account: string, publicKey: string): boolean {
    return this.db.query('DELETE FROM sessions WHERE account = $account AND public_key = $key').run({ account, key: publicKey }).changes > 0;
  }

  /** The journal mode SQLite reports. */
  get journalMode(): string {
    return (this.db.query('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode;
  }

  close(): void {
    this.db.close();
  }
}
