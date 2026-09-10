import { defineConfig } from '@playwright/test';
import mockConfig from './playwright.config.mock';

const servers = Array.isArray(mockConfig.webServer) ? mockConfig.webServer : [];
const sandpackURL = 'http://127.0.0.1:5081';

export default defineConfig({
  ...mockConfig,
  testDir: 'specs',
  testMatch: ['sandpack/**/*.spec.ts'],
  outputDir: 'specs/.test-results/sandpack',
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: { ...mockConfig.use, trace: 'retain-on-failure', video: 'off' },
  webServer: servers.map((server, index) =>
    index === servers.length - 1
      ? {
          ...server,
          env: {
            ...server.env,
            E2E_LOCAL_SANDPACK: 'true',
            SANDPACK_BUNDLER_URL: sandpackURL,
          },
        }
      : server,
  ),
});
