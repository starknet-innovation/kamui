// Produce browser code at image build time, never during a hosted startup.
import { mkdir } from 'node:fs/promises';
const output = `${import.meta.dir}/../dist`;
const build = await Bun.build({ entrypoints: [`${import.meta.dir}/../src/main.ts`], target: 'browser', minify: true });
if (!build.success || build.outputs.length !== 1) throw new Error('KEYCHAIN_BUILD_FAILED');
await mkdir(output, { recursive: true });
await Bun.write(`${output}/main.js`, build.outputs[0]!);
