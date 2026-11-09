import { defineConfig, devices } from '@playwright/test';

const externalWeb = process.env.OMNIS_TEST_EXTERNAL_WEB === '1';
const frontendOrigin = externalWeb
  ? requiredComposeWebOrigin('OMNIS_TEST_FRONTEND_ORIGIN')
  : requiredLoopbackOrigin('OMNIS_TEST_FRONTEND_ORIGIN');
const frontendPort = Number(new URL(frontendOrigin).port);
if (!Number.isInteger(frontendPort) || frontendPort < 1 || frontendPort > 65_535) {
  throw new Error('OMNIS_TEST_FRONTEND_ORIGIN must include a valid explicit port.');
}

export default defineConfig({
  testDir: './integration',
  testMatch: '**/*.integration.spec.ts',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  timeout: 30_000,
  globalTimeout: 210_000,
  reporter: 'list',
  outputDir: process.env.OMNIS_TEST_OUTPUT_DIR ?? './test-results/full-stack-smoke',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: frontendOrigin,
    ...(externalWeb
      ? {
          channel: 'chromium',
          launchOptions: {
            args: ['--unsafely-treat-insecure-origin-as-secure=http://web:8080'],
          },
        }
      : {}),
    trace: 'off',
    screenshot: 'off',
    video: 'off',
    actionTimeout: 10_000,
    navigationTimeout: 10_000,
  },
  ...(externalWeb
    ? {}
    : {
        webServer: {
          command: `node node_modules/vite/bin/vite.js --config vite.integration.config.ts --host 127.0.0.1 --port ${frontendPort} --strictPort`,
          url: frontendOrigin,
          reuseExistingServer: false,
          timeout: 30_000,
        },
      }),
});

function requiredLoopbackOrigin(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be configured for the disposable browser test.`);
  const parsed = new URL(value);
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || !parsed.port) {
    throw new Error(`${name} must use an explicit 127.0.0.1 HTTP origin.`);
  }
  return parsed.origin;
}

function requiredComposeWebOrigin(name: string): string {
  const value = process.env[name];
  if (value !== 'http://web:8080') {
    throw new Error(`${name} must use the test-only http://web:8080 Compose origin.`);
  }
  return value;
}
