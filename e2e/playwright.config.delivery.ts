import { defineConfig } from '@playwright/test';
import phase6 from './playwright.config.phase6';

const servers = Array.isArray(phase6.webServer) ? phase6.webServer : [];
export default defineConfig({
  ...phase6,
  testMatch: ['delivery/**/*.spec.ts'],
  outputDir: 'specs/.test-results/delivery',
  webServer: servers.map((server, index) =>
    index === 2 ? { ...server, env: { ...server.env, E2E_DELIVERY_FAULTS: 'true' } } : server,
  ),
});
