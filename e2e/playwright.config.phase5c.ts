import path from 'path';
import { defineConfig } from '@playwright/test';
import phase5bConfig from './playwright.config.phase5b';

const gatewayRoot = process.env.SG_GATEWAY_E2E_ROOT;
if (!gatewayRoot) {
  throw new Error('Phase 5C requires SG_GATEWAY_E2E_ROOT');
}
const servers = Array.isArray(phase5bConfig.webServer) ? phase5bConfig.webServer : [];
const [stubServer, gatewayServer, libreChatServer] = servers;

export default defineConfig({
  ...phase5bConfig,
  testMatch: ['phase5c/**/*.spec.ts'],
  outputDir: 'specs/.test-results/phase5c',
  webServer: [
    { ...stubServer },
    {
      ...gatewayServer,
      env: {
        ...gatewayServer?.env,
        SG_GATEWAY_CONFIG: path.resolve(
          gatewayRoot,
          'services/sg-ai-gateway/tests/e2e/gateway.phase5c.yaml',
        ),
      },
    },
    { ...libreChatServer },
  ],
});
