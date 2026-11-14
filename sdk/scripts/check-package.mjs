// Packs the SDK the way `npm publish` would and uses the tarball from a scratch project, so a
// broken `exports` map, a missing file or an import plain Node cannot resolve fails here and not
// in someone's app. Run from sdk/: node scripts/check-package.mjs [dir]   (needs npm and the network)
// With a directory, the checked tarball is left there; that is the file the release workflow publishes.
//
// Checks: the tarball's file list; `import '@kamui/sdk'` under plain Node (and Bun, if on PATH);
// and the type declarations under TypeScript's strictest resolution (NodeNext).
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sdk = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(sdk, 'package.json'), 'utf8'));
const starknet = manifest.devDependencies.starknet; // the version the SDK is tested against
const work = mkdtempSync(join(tmpdir(), 'kamui-sdk-package-'));
const run = (cmd, args, cwd) => {
  try {
    return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  } catch (error) {
    if (error.stdout) console.error(error.stdout); // tsc reports its errors on stdout
    throw error;
  }
};

try {
  // `npm pack` runs prepack, which builds dist/.
  const [packed] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', work], sdk));
  const files = packed.files.map((f) => f.path).sort();
  for (const needed of ['package.json', 'README.md', 'LICENSE', 'dist/index.js', 'dist/index.d.ts']) {
    if (!files.includes(needed)) throw new Error(`the tarball is missing ${needed}`);
  }
  const stray = files.filter((f) => !f.startsWith('dist/') && !['package.json', 'README.md', 'LICENSE'].includes(f));
  if (stray.length) throw new Error(`the tarball has files it should not: ${stray.join(', ')}`);
  console.log(`packed ${packed.filename}: ${files.length} files, ${packed.size} bytes`);

  const app = join(work, 'app');
  mkdirSync(app);
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'scratch', private: true, type: 'module' }));
  const typescript = manifest.devDependencies.typescript;
  run('npm', ['install', '--no-audit', '--no-fund', '--silent',
    join(work, packed.filename), `starknet@${starknet}`, `typescript@${typescript}`], app);

  // Runtime: every relative import inside dist/ has to resolve without a bundler.
  writeFileSync(join(app, 'smoke.mjs'), `
import * as sdk from '@kamui/sdk';
import { beginConnect, checkSessionEnded, finishConnect, keyPairFromPrivateKey, sessionCall, sponsor, KamuiReader } from '@kamui/sdk';
for (const [name, value] of Object.entries({ beginConnect, checkSessionEnded, finishConnect, sessionCall, sponsor, KamuiReader })) {
  if (typeof value !== 'function') throw new Error(name + ' is not exported as a function');
}
const pair = keyPairFromPrivateKey('0x1');
if (pair.publicKey !== '0x1ef15c18599971b7beced415a40f0c7deacfd9b0d1819e03d723d8bc943cfca') {
  throw new Error('unexpected public key ' + pair.publicKey);
}
console.log(Object.keys(sdk).length + ' exports, key derivation works');
`);
  console.log(`node ${process.version}: ${run('node', ['smoke.mjs'], app).trim()}`);
  try {
    const version = run('bun', ['--version'], app).trim();
    console.log(`bun ${version}: ${run('bun', ['smoke.mjs'], app).trim()}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    console.log('bun: not on PATH, skipped');
  }

  // Types: NodeNext is the resolution that rejects extensionless imports in .d.ts files.
  // skipLibCheck stays on because starknet's own declarations do not pass a full check. A
  // declaration of ours that failed to resolve would still fail here: each name below comes
  // through index.d.ts from a different module, and a broken re-export loses the name.
  writeFileSync(join(app, 'types.ts'), `
import { beginConnect, newKeyPair, type ConnectOptions, type KeyPair, type KeyValueStore, type SessionEnd } from '@kamui/sdk';
const pair: KeyPair = newKeyPair();
const publicKey: string = pair.publicKey;
export type { ConnectOptions, KeyValueStore, SessionEnd };
export { beginConnect, publicKey };
`);
  for (const resolution of ['NodeNext', 'Bundler']) {
    writeFileSync(join(app, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        noEmit: true, strict: true, target: 'ES2022', lib: ['ES2022', 'DOM'], types: [], skipLibCheck: true,
        module: resolution === 'NodeNext' ? 'NodeNext' : 'ESNext', moduleResolution: resolution,
      },
      files: ['types.ts'],
    }));
    run(join(app, 'node_modules/.bin/tsc'), ['-p', '.'], app);
    console.log(`tsc (${resolution}): the declarations type-check`);
  }

  if (process.argv[2]) {
    const out = resolve(process.argv[2]);
    mkdirSync(out, { recursive: true });
    copyFileSync(join(work, packed.filename), join(out, packed.filename));
    console.log(`kept ${join(out, packed.filename)}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
