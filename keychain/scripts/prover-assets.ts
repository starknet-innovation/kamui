// Install release binaries without consulting any other wallet implementation.
// Run: bun scripts/prover-assets.ts [--check | /path/to/snip-36-prover-wasm]
import { createHash } from 'node:crypto';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
const root = `${import.meta.dir}/../prover`;
const manifest = await Bun.file(`${root}/manifest.json`).json();
const argument = process.argv[2];
for (const [path, identity] of Object.entries(manifest.files) as [string, { bytes: number; sha256: string }][]) {
  let data = new Uint8Array(await Bun.file(`${root}/${path}`).arrayBuffer().catch(() => new ArrayBuffer(0)));
  const valid = () => data.length === identity.bytes && createHash('sha256').update(data).digest('hex') === identity.sha256;
  if (!valid() && path.endsWith('.wasm') && argument !== '--check') {
    if (argument) data = new Uint8Array(await Bun.file(`${argument}/web/${path}`).arrayBuffer());
    else {
      const name = path.includes('browser_virtual_os') ? 'executor.wasm' : 'prover.wasm';
      const response = await fetch(`${manifest.repository}/releases/download/${manifest.release}/${name}`, { credentials: 'omit', signal: AbortSignal.timeout(300_000) });
      if (!response.ok) throw new Error(`Release artifact unavailable: ${name}`);
      if (!response.body) throw new Error(`Empty release artifact: ${name}`);
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > identity.bytes) throw new Error(`Oversized release artifact: ${name}`);
          chunks.push(value);
        }
      } finally { await reader.cancel(); }
      data = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
    }
    if (!valid()) throw new Error(`Artifact identity mismatch: ${path}`);
    await mkdir(dirname(`${root}/${path}`), { recursive: true });
    const temp = `${root}/${path}.tmp`;
    try { await Bun.write(temp, data); await rename(temp, `${root}/${path}`); }
    finally { await rm(temp, { force: true }); }
  }
  if (!valid()) throw new Error(`Missing or changed pinned asset: ${path}; run scripts/prover-assets.ts`);
}
console.log(`Verified SNIP-36 ${manifest.release} assets (${manifest.commit}).`);
