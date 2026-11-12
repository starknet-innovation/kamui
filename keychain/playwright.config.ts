// Browser tests for the keychain. They run the real keychain server and page in Chrome, and
// replace everything outside it (the chain, the backend, the pepper service and the issuer)
// with fakes at the network level. See tests/fakes.ts.
import { defineConfig } from '@playwright/test';

const BUN = process.env.BUN ?? 'bun';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5183',
    // The installed Chrome, so nothing has to be downloaded.
    channel: 'chrome',
    headless: true,
  },
  webServer: {
    command: `${BUN} run server.ts`,
    url: 'http://localhost:5183/config.json',
    reuseExistingServer: false,
    env: {
      PORT: '5183',
      GOOGLE_CLIENT_ID: 'test-client',
      RPC_URL: 'http://localhost:5184',
      PEPPER_URL: 'http://localhost:5185',
      POLL_MS: '100',
      KAMUI_ACCOUNT_CLASS_HASH: '0x13c5e8166199db99e894da9e55ce642267e5258c42eae8851357747b6201fdc',
      // /api is answered by the tests before it reaches this address.
      API_URL: 'http://localhost:5186',
    },
  },
});
