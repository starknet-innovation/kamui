// Packs the SDK the way `npm publish` would and uses the tarball from a scratch project, so a
// broken `exports` map, a missing file or an import plain Node cannot resolve fails here and not
// in someone's app. Run from sdk/: node scripts/check-package.mjs [dir]   (needs npm and the network)
// With a directory, the checked tarball is left there; that is the file the release workflow publishes.
//
// Checks, in order:
//   - the tarball's file list, and that every relative import in dist/ names its ".js" file;
//   - `import '@kamui/sdk'` under plain Node (and Bun, if on PATH) with only `starknet` installed,
//     so the main entry point cannot come to need React or starknet-react;
//   - its type declarations under NodeNext and Bundler resolution;
//   - `import '@kamui/sdk/starknet-react'` under Node and Bun once the optional peers are
//     installed, and its declarations under Bundler resolution.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  const entryPoints = Object.values(manifest.exports).flatMap((entry) => typeof entry === 'string' ? [] : Object.values(entry));
  for (const needed of ['package.json', 'README.md', 'LICENSE', ...entryPoints.map((file) => file.replace(/^\.\//, ''))]) {
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

  // The build does not insist on the ".js" extension plain Node needs (see tsconfig.build.json),
  // so look for a relative import without one in what was installed.
  const dist = join(app, 'node_modules', manifest.name, 'dist');
  const bare = [];
  for (const file of readdirSync(dist, { recursive: true }).filter((f) => /\.(js|d\.ts)$/.test(f))) {
    for (const [, specifier] of readFileSync(join(dist, file), 'utf8').matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]*)['"]/g)) {
      if (!specifier.endsWith('.js')) bare.push(`${file}: ${specifier}`);
    }
  }
  if (bare.length) throw new Error(`relative imports without ".js" in dist/:\n  ${bare.join('\n  ')}`);
  console.log('dist/: every relative import names its .js file');

  const runtimes = [['node', process.version]];
  try {
    runtimes.push(['bun', run('bun', ['--version'], app).trim()]);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    console.log('bun: not on PATH, skipped');
  }
  const typeCheck = (file, resolutions) => {
    for (const resolution of resolutions) {
      writeFileSync(join(app, 'tsconfig.json'), JSON.stringify({
        compilerOptions: {
          noEmit: true, strict: true, target: 'ES2022', lib: ['ES2022', 'DOM'], types: [], skipLibCheck: true,
          module: resolution === 'NodeNext' ? 'NodeNext' : 'ESNext', moduleResolution: resolution,
        },
        files: [file],
      }));
      run(join(app, 'node_modules/.bin/tsc'), ['-p', '.'], app);
      console.log(`tsc (${resolution}): ${file} type-checks`);
    }
  };

  // Runtime, with the optional peers absent: every import inside dist/ has to resolve without a
  // bundler, and the main entry point must not reach React or starknet-react.
  for (const peer of Object.keys(manifest.peerDependenciesMeta ?? {})) {
    try {
      readFileSync(join(app, 'node_modules', peer, 'package.json'));
    } catch {
      continue;
    }
    throw new Error(`${peer} is installed in the scratch project, so the check without optional peers proves nothing`);
  }
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
  for (const [runtime, version] of runtimes) {
    console.log(`${runtime} ${version}: ${run(runtime, ['smoke.mjs'], app).trim()}`);
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
  typeCheck('types.ts', ['NodeNext', 'Bundler']);

  // The starknet-react entry point, with its optional peers at the versions the SDK tests with.
  const peers = Object.keys(manifest.peerDependenciesMeta ?? {}).map((peer) => `${peer}@${manifest.devDependencies[peer]}`);
  // --legacy-peer-deps: @starknet-react/core 5.0.3 declares starknet ^8 as its peer, and npm
  // refuses to install it next to starknet 10 otherwise. Apps installing with npm hit the same.
  run('npm', ['install', '--no-audit', '--no-fund', '--silent', '--legacy-peer-deps', ...peers], app);
  writeFileSync(join(app, 'smoke-react.mjs'), `
import { KamuiConnector, KamuiWallet, useKamuiReconnect } from '@kamui/sdk/starknet-react';
import { KamuiWallet as fromRoot } from '@kamui/sdk';
import { Connector } from '@starknet-react/core';
if (KamuiWallet !== fromRoot) throw new Error('the two entry points load separate copies of the wallet');
if (!(KamuiConnector.prototype instanceof Connector)) throw new Error('KamuiConnector does not extend the installed Connector');
if (typeof useKamuiReconnect !== 'function') throw new Error('useKamuiReconnect is not exported as a function');
console.log('@kamui/sdk/starknet-react loads, KamuiConnector extends Connector');
`);
  for (const [runtime, version] of runtimes) {
    console.log(`${runtime} ${version}: ${run(runtime, ['smoke-react.mjs'], app).trim()}`);
  }
  // Bundler resolution only. Under NodeNext, eventemitter3's declarations resolve as CommonJS
  // and @starknet-react/core's own Connector loses its emitter methods; that is theirs to fix.
  writeFileSync(join(app, 'types-react.ts'), `
import { KamuiConnector, useKamuiReconnect, type KamuiReconnect, type KamuiWalletOptions } from '@kamui/sdk/starknet-react';
export function make(options: KamuiWalletOptions): string {
  const connector = new KamuiConnector(options);
  connector.on('disconnect', () => {});
  return connector.id;
}
export type { KamuiReconnect };
export { useKamuiReconnect };
`);
  typeCheck('types-react.ts', ['Bundler']);

  if (process.argv[2]) {
    const out = resolve(process.argv[2]);
    mkdirSync(out, { recursive: true });
    copyFileSync(join(work, packed.filename), join(out, packed.filename));
    console.log(`kept ${join(out, packed.filename)}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
