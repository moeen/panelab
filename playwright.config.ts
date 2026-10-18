import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  forbidOnly: true,
  retries: 0,
  workers: 1,
  fullyParallel: false,
  use: { actionTimeout: 10_000, navigationTimeout: 20_000 },
  outputDir: 'test-results',
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  projects: [
    {
      name: 'runtime-chromium',
      testMatch: 'integration/**/*.spec.ts',
      metadata: { engine: 'chromium' },
    },
    {
      name: 'runtime-webkit',
      testMatch: 'integration/**/*.spec.ts',
      metadata: { engine: 'webkit' },
    },
    {
      name: 'runtime-firefox',
      testMatch: 'integration/**/*.spec.ts',
      metadata: { engine: 'firefox' },
    },
    { name: 'electron', testMatch: 'e2e/**/*.spec.ts', testIgnore: '**/*.native.spec.ts' },
    ...(process.env.PANELAB_NATIVE_TESTS === '1'
      ? [{ name: 'native', testMatch: 'e2e/**/*.native.spec.ts' }]
      : []),
  ],
})
