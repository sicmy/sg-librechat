import path from 'path';
import { defineConfig } from '@playwright/test';
import deletion from './playwright.config.deletion';
const servers = Array.isArray(deletion.webServer) ? deletion.webServer : [];
export default defineConfig({
  ...deletion,
  testMatch: ['deletionRestart/**/*.spec.ts'],
  outputDir: 'specs/.test-results/deletionRestart',
  globalTeardown: require.resolve('./setup/teardown.restart'),
  webServer: servers.map((server, index) =>
    index === 2
      ? {
          ...server,
          command: `node "${path.resolve(__dirname, 'setup/restart-server.cjs')}"`,
        }
      : server,
  ),
});
