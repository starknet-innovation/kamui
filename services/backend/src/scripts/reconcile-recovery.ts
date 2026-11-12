// Operator-only: settle an orphaned intent using a finalized replacement transaction.
// No signing, private key, JWT, proof or pepper is read or accepted by this command.
import { env, makeProvider } from '../env';
import { RecoveryJobs, recoveryDbPath } from '../services/recovery/jobs';

const [originalHash, replacementHash] = process.argv.slice(2);
if (!originalHash || !replacementHash || ![originalHash, replacementHash].every((v) => /^0x[0-9a-fA-F]{1,64}$/.test(v))) {
  console.error('Usage: bun run src/scripts/reconcile-recovery.ts <original-tx-hash> <finalized-replacement-tx-hash>');
  process.exit(1);
}
let jobs: RecoveryJobs | undefined;
try {
  const provider = makeProvider();
  jobs = new RecoveryJobs({ path: recoveryDbPath(), binding: `${await provider.getChainId()}:${env('KAMUI_ACCOUNT_CLASS_HASH')}`, journalMode: process.env.REGISTRY_JOURNAL_MODE || 'DELETE' });
  await jobs.resolveSuperseded(originalHash, replacementHash, provider);
  console.log(JSON.stringify({ status: 'resolved', transaction_hash: originalHash }));
} catch (error) {
  // No arbitrary RPC text (which can hold URLs or request material).
  const message = error instanceof Error ? error.message : '';
  console.error(JSON.stringify({ status: 'refused', error: /^[A-Z_]{3,60}$/.test(message) ? message : 'RECONCILIATION_UNAVAILABLE' }));
  process.exitCode = 1;
} finally { jobs?.close(); }
