import path from 'path';
import { defineConfig } from '@playwright/test';
import phase6aConfig from './playwright.config.phase6a';

const gatewayRoot = process.env.SG_GATEWAY_E2E_ROOT;
if (!gatewayRoot) {
  throw new Error('Phase 7 requires SG_GATEWAY_E2E_ROOT');
}
const servers = Array.isArray(phase6aConfig.webServer) ? phase6aConfig.webServer : [];
const [stubServer, gatewayServer, libreChatServer] = servers;
export default defineConfig({
  ...phase6aConfig,
  testMatch: ['phase7/**/*.spec.ts'],
  outputDir: 'specs/.test-results/phase7',
  webServer: [
    { ...stubServer },
    {
      ...gatewayServer,
      command: 'uv run python tests/e2e/recovery_server.py',
      url: 'http://127.0.0.1:4021/ready',
      env: {
        ...gatewayServer?.env,
        SG_GATEWAY_CONFIG: path.resolve(
          gatewayRoot,
          'services/sg-ai-gateway/tests/e2e/gateway.phase7.yaml',
        ),
      },
    },
    { ...libreChatServer },
  ],
});
