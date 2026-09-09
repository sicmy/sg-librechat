import { defineConfig } from '@playwright/test';
import deletion from './playwright.config.deletion';
const servers = Array.isArray(deletion.webServer) ? deletion.webServer : [];
export default defineConfig({
  ...deletion,
  testMatch: ['expiry/**/*.spec.ts'],
  outputDir: 'specs/.test-results/expiry',
  webServer: servers.map((server, index) =>
    index === 2 ? { ...server, env: { ...server.env, E2E_SG_EXPIRY: 'true' } } : server,
  ),
});
