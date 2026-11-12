// Network-only test double for expensive browser proving. Never included in app builds.
import type { BrowserContext } from '@playwright/test';
import { hash, shortString } from 'starknet';
import { identity } from '../../sdk/src/address';
import { recoveryMessage, V2_HEADER, V2_PROGRAM, V2_SEPOLIA_CONFIG } from '../../sdk/src/client-proving';
import { ACCOUNT, APPLE_CLAIMS, CLAIMS, KEYCHAIN, PEPPER, type World } from './fakes';

export async function installProverFake(context: BrowserContext, world: World) {
  await context.addInitScript(() => {
    const validate = WebAssembly.validate.bind(WebAssembly);
    WebAssembly.validate = (b) => {
      const bytes = b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
      return bytes.length === 13 && bytes[11] === 4 ? true : validate(b);
    };
  });
  await context.route(`${KEYCHAIN}/prover/v1.0.1/public-run-controller.mjs`, route => route.fulfill({ contentType: 'text/javascript', body: `
    export class PublicRunController {
      constructor(hooks) { this.hooks = hooks; }
      cancel() { this.cancelled = true; }
      async start(request) {
        const r = await (await fetch('/test-proof', {method:'POST', body:JSON.stringify(request)})).json();
        if (!this.cancelled) this.hooks.onComplete(r);
      }
    }` }));
  await context.route(`${KEYCHAIN}/test-proof`, route => {
    const r = route.request().postDataJSON();
    const key = r.transaction.calldata.at(-3);
    const account = r.transaction.calldata[1];
    const claims = BigInt(account) === BigInt(ACCOUNT) ? CLAIMS : APPLE_CLAIMS;
    const message = recoveryMessage(account, identity(claims, PEPPER), key, '0x' + world.anchor.toString(16));
    const facts = [V2_PROGRAM, shortString.encodeShortString('VIRTUAL_SNOS0'), '0x1', '0x2', V2_SEPOLIA_CONFIG, '0x1', message];
    return route.fulfill({ json: { kind: 'proof', proof: Array.from(Buffer.from(V2_HEADER + '00', 'hex')), output_preimage: ['0x1', '0x8', ...facts] } });
  });
}
