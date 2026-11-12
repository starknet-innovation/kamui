// A live check of the KMS key holder against a real AWS KMS key. Test keys only.
//
//   AWS_PROFILE=<profile> bun run scripts/kms-live-check.ts
//
// Reads PEPPER_KEY_SOURCE, KMS_KEY_ID and PEPPER_KEY_CHECK from the environment (.env.local).
// It asks KMS for MACs of made-up inputs and prints only pass/fail lines and timings: no ARN,
// no account id, no pepper.
import { kmsSettings, loadKmsDeriver } from '../src/config';
import { awsKms } from '../src/kms';

const { keyId, region } = kmsSettings(process.env);
const kms = await awsKms(keyId, region);

const results: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, detail = '') => results.push([name, ok, detail]);

// Startup: the key is the right kind and matches the recorded key check value.
const { deriver, key } = await loadKmsDeriver(process.env, kms);
check('startup checks pass (key kind, state, key check value)', true);
check('the key is multi-Region', key.multiRegion === true);

// A wrong key check value must stop startup.
const wrong = await loadKmsDeriver({ ...process.env, PEPPER_KEY_CHECK: '0123456789abcdef' }, kms).then(() => false, () => true);
check('a wrong key check value is refused', wrong);

const GOOGLE = 'https://accounts.google.com';
const a1 = await deriver.derive(GOOGLE, 'live-check-user-a');
const a2 = await deriver.derive(GOOGLE, 'live-check-user-a');
const b = await deriver.derive(GOOGLE, 'live-check-user-b');
const apple = await deriver.derive('https://appleid.apple.com', 'live-check-user-a');
check('the same user always gets the same pepper', a1 === a2);
check('different users get different peppers', a1 !== b);
check('the same id at another issuer gets a different pepper', a1 !== apple);
check('peppers are non-zero and below 2^250', [a1, b, apple].every((p) => p > 0n && p < 1n << 250n));

// Latency of one derivation, which is one KMS call.
const times: number[] = [];
for (let i = 0; i < 10; i++) {
  const start = performance.now();
  await deriver.derive(GOOGLE, `live-check-latency-${i}`);
  times.push(performance.now() - start);
}
times.sort((x, y) => x - y);
const median = times[Math.floor(times.length / 2)]!;

for (const [name, ok, detail] of results) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `: ${detail}` : ''}`);
console.log(`one derivation through KMS: median ${median.toFixed(0)} ms, slowest ${times.at(-1)!.toFixed(0)} ms (10 calls, region ${region})`);
process.exit(results.every(([, ok]) => ok) ? 0 : 1);
