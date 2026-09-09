import { defineConfig } from '@playwright/test';
import deletion from './playwright.config.deletion';
const servers = Array.isArray(deletion.webServer) ? deletion.webServer : [];
export default defineConfig({
  ...deletion,
  testMatch: ['terminalDeletion/**/*.spec.ts'],
  outputDir: 'specs/.test-results/terminalDeletion',
  webServer: servers.map((server, index) =>
    index === 2
      ? {
          ...server,
          env: { ...server.env, E2E_TERMINAL_DELETION: 'true' },
        }
      : server,
  ),
});
