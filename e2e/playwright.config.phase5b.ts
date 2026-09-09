import path from 'path';
import { defineConfig } from '@playwright/test';
import phase5aConfig from './playwright.config.phase5a';

const gatewayRoot = process.env.SG_GATEWAY_E2E_ROOT;
if (!gatewayRoot) {
  throw new Error('Phase 5B requires SG_GATEWAY_E2E_ROOT');
}
const servers = Array.isArray(phase5aConfig.webServer) ? phase5aConfig.webServer : [];
const [stubServer, gatewayServer, libreChatServer] = servers;

export default defineConfig({
  ...phase5aConfig,
  testMatch: ['phase5b/**/*.spec.ts'],
  outputDir: 'specs/.test-results/phase5b',
  webServer: [
    { ...stubServer },
    {
      ...gatewayServer,
      command:
        'uv run uvicorn task4e_app:app --app-dir tests/e2e --host 127.0.0.1 --port 4020 --no-access-log',
      env: {
        ...gatewayServer?.env,
        SG_GATEWAY_CONFIG: path.resolve(
          gatewayRoot,
          'services/sg-ai-gateway/tests/e2e/gateway.phase5b.yaml',
        ),
      },
    },
    { ...libreChatServer },
  ],
});
