// Host operator only. No signing keys, JWTs or proof payloads are read.
import '../env';
import { readFileSync } from 'node:fs';
import { loadRuntimeSecretFiles } from '../secrets';
import { acquirePostgresWriterLock, postgresUrl } from '../storage/postgres';
import { blockRestoreGate, initializeRestoreGate, acknowledgeRestoreGate, readRestoreGate, type RestoreAcknowledgement } from '../storage/restore-fence';

const [action, input, ...extra] = process.argv.slice(2);
try {
  const path = process.env.RESTORE_GATE_FILE;
  if (!path || extra.length) throw new Error('RESTORE_CONTROL_CONFIG_REQUIRED');
  if (action === 'initialize' && !input) {
    const gate = initializeRestoreGate(path);
    console.log(JSON.stringify({ status: 'blocked', generation: gate.generation }));
  } else if (action === 'block' && !input) {
    const gate = blockRestoreGate(path);
    console.log(JSON.stringify({ status: 'blocked', generation: gate.generation }));
  } else if (action === 'status' && !input) {
    const gate = readRestoreGate(path);
    console.log(JSON.stringify({ status: gate.state, generation: gate.generation }));
  } else if (action === 'acknowledge' && input) {
    await loadRuntimeSecretFiles(process.env, ['DATABASE_URL']);
    const raw = readFileSync(input);
    if (raw.length > 4096) throw new Error('RESTORE_ACKNOWLEDGEMENT_INVALID');
    const acknowledgement = JSON.parse(raw.toString()) as RestoreAcknowledgement;
    const lease = await acquirePostgresWriterLock(postgresUrl(process.env.DATABASE_URL), () => { process.exit(1); });
    try {
      // Fresh setup cannot acknowledge a restored/nonempty application database as fresh.
      if (acknowledgement.mode === 'fresh') {
        const tables = await lease.sql`SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`;
        if (tables.length) throw new Error('RESTORE_FRESH_DATABASE_NOT_EMPTY');
      }
      const ready = acknowledgeRestoreGate(path, acknowledgement);
      console.log(JSON.stringify({ status: ready.state, mode: ready.mode }));
    } finally { await lease.close(); }
  } else throw new Error('RESTORE_CONTROL_USAGE');
} catch (error) {
  const code = error instanceof Error && /^RESTORE_[A-Z_]+$/.test(error.message) ? error.message : 'RESTORE_CONTROL_FAILED';
  console.error(JSON.stringify({ status: 'refused', error: code }));
  process.exitCode = 1;
}
