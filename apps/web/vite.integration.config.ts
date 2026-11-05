import { defineConfig, mergeConfig } from 'vite';
import baseConfig from './vite.config.ts';

const apiTarget = process.env.OMNIS_TEST_API_PROXY_TARGET;
if (!apiTarget) {
  throw new Error('OMNIS_TEST_API_PROXY_TARGET is required for the full-stack browser test.');
}

const parsedTarget = new URL(apiTarget);
if (
  parsedTarget.protocol !== 'http:' ||
  parsedTarget.hostname !== '127.0.0.1' ||
  !parsedTarget.port
) {
  throw new Error('OMNIS_TEST_API_PROXY_TARGET must use an explicit 127.0.0.1 HTTP target.');
}

const frontendPort = Number(process.env.OMNIS_TEST_FRONTEND_PORT);
if (!Number.isInteger(frontendPort) || frontendPort < 1 || frontendPort > 65_535) {
  throw new Error('OMNIS_TEST_FRONTEND_PORT must be a valid loopback port.');
}

export default mergeConfig(
  baseConfig,
  defineConfig({
    server: {
      host: '127.0.0.1',
      port: frontendPort,
      strictPort: true,
      proxy: {
        '/api': {
          target: parsedTarget.origin,
          changeOrigin: false,
        },
      },
    },
  }),
);
