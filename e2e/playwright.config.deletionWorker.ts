import { defineConfig } from '@playwright/test';
import deletion from './playwright.config.deletion';
const servers = Array.isArray(deletion.webServer) ? deletion.webServer : [];
export default defineConfig({
  ...deletion,
  testMatch: ['deletionWorker/**/*.spec.ts'],
  outputDir: 'specs/.test-results/deletionWorker',
  webServer: servers.map((server, index) =>
    index === 2 ? { ...server, env: { ...server.env, E2E_FILE_DELETION_FAULTS: 'true' } } : server,
  ),
});
