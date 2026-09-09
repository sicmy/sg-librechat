import path from 'path';
import { defineConfig } from '@playwright/test';
import phase5bConfig from './playwright.config.phase5b';

const gatewayRoot = process.env.SG_GATEWAY_E2E_ROOT;
if (!gatewayRoot) {
  throw new Error('Phase 6A requires SG_GATEWAY_E2E_ROOT');
}
const servers = Array.isArray(phase5bConfig.webServer) ? phase5bConfig.webServer : [];
const [stubServer, gatewayServer, libreChatServer] = servers;

export default defineConfig({
  ...phase5bConfig,
  testMatch: ['phase6a/**/*.spec.ts'],
  outputDir: 'specs/.test-results/phase6a',
  webServer: [
    { ...stubServer },
    {
      ...gatewayServer,
      env: {
        ...gatewayServer?.env,
        SG_GATEWAY_CONFIG: path.resolve(
          gatewayRoot,
          'services/sg-ai-gateway/tests/e2e/gateway.phase6a.yaml',
        ),
      },
    },
    { ...libreChatServer },
  ],
});
