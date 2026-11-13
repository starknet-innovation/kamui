// Browser tests for the keychain. They run the real keychain server and page in Chrome, Firefox
// and WebKit, and replace everything outside it (the chain, the backend, the session registry,
// the pepper service and the issuers) with fakes at the network level. See tests/fakes.ts.
//
//   playwright test                     all three browsers
//   playwright test --project=chrome    one of them
//
// Chrome is the installed one. Firefox and WebKit are Playwright's own builds:
//   playwright install firefox webkit
// WebKit is the engine Safari is built on, not Safari itself.
import { defineConfig, devices } from '@playwright/test';

const BUN = process.env.BUN ?? 'bun';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  // CI also writes an HTML report and keeps a trace of each failed test, uploaded on failure.
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: process.env.KAMUI_TEST_EXTERNAL_ORIGIN ?? 'http://localhost:5183',
    headless: true,
    trace: process.env.CI ? 'retain-on-failure' : 'off',
  },
  projects: [
    // The installed Chrome, so nothing has to be downloaded for it.
    { name: 'chrome', use: { ...devices['Desktop Chrome'], ...(process.env.KAMUI_TEST_BUNDLED_CHROMIUM ? {} : { channel: 'chrome' }), launchOptions: { env: { PATH: process.env.PATH!, HOME: process.env.HOME!, LANG: 'C.UTF-8' } } } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: process.env.KAMUI_TEST_EXTERNAL_ORIGIN ? undefined : {
    command: `${BUN} run server.ts`,
    url: 'http://localhost:5183/config.json',
    reuseExistingServer: false,
    env: {
      PORT: '5183',
      PROVER_EXECUTOR_ADDRESS: '0x123',
      JWK_REGISTRY_ADDRESS: '0x456',
      GOOGLE_CLIENT_ID: 'test-client',
      APPLE_CLIENT_ID: 'test-apple-client',
      RPC_URL: 'http://localhost:5184',
      PEPPER_URL: 'http://localhost:5185',
      POLL_MS: '100',
      KAMUI_ACCOUNT_CLASS_HASH: '0x13c5e8166199db99e894da9e55ce642267e5258c42eae8851357747b6201fdc',
      // /api is answered by the tests before it reaches this address.
      API_URL: 'http://localhost:5186',
    },
  },
});
