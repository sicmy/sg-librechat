import path from 'path';
import { defineConfig } from '@playwright/test';
import phase1Config from './playwright.config.phase1';

const rootPath = path.resolve(__dirname, '..');
const gatewayRoot = process.env.SG_GATEWAY_E2E_ROOT;
if (!gatewayRoot) {
  throw new Error('Phase 4 E2E requires the resolved SG_GATEWAY_E2E_ROOT');
}

const gatewayServiceRoot = path.resolve(gatewayRoot, 'services/sg-ai-gateway');
const gatewayConfigPath = path.resolve(gatewayServiceRoot, 'tests/e2e/gateway.phase4.yaml');
const libreChatConfigPath = path.resolve(rootPath, 'e2e/config/librechat.phase4.yaml');
const servers = Array.isArray(phase1Config.webServer)
  ? phase1Config.webServer
  : [phase1Config.webServer];

if (servers.length !== 3) {
  throw new Error(`Phase 4 E2E expected three web servers, received ${servers.length}`);
}

const [stubServer, gatewayServer, libreChatServer] = servers;

export default defineConfig({
  ...phase1Config,
  testDir: 'specs',
  testMatch: ['phase4/**/*.spec.ts', 'mock/sg-citations.spec.ts'],
  outputDir: 'specs/.test-results/phase4',
  webServer: [
    {
      ...stubServer,
      env: { ...stubServer?.env, E2E_STREAM_DELAY_SECONDS: '0' },
    },
    {
      ...gatewayServer,
      command:
        'uv run uvicorn task4e_app:app --app-dir tests/e2e --host 127.0.0.1 --port 4000 --no-access-log',
      cwd: gatewayServiceRoot,
      env: {
        ...gatewayServer?.env,
        SG_GATEWAY_CONFIG: gatewayConfigPath,
      },
    },
    {
      ...libreChatServer,
      env: {
        ...libreChatServer?.env,
        CONFIG_PATH: libreChatConfigPath,
      },
    },
  ],
});
