import { defineConfig, devices } from '@playwright/test';
import path from 'path';
import { getE2EBaseURL, getLocalE2EEnv } from './setup/env';

const rootPath = path.resolve(__dirname, '..');
const serverPath = path.resolve(rootPath, 'e2e/setup/start-server.js');
const noDotenvPath = path.resolve(rootPath, 'e2e/specs/.test-results/no-dotenv');
const gatewayRoot = process.env.SG_GATEWAY_E2E_ROOT;
if (!gatewayRoot) {
  throw new Error('SG_GATEWAY_E2E_ROOT must point to the sg-librechat Task 1E worktree');
}
const gatewayServiceRoot = path.resolve(gatewayRoot, 'services/sg-ai-gateway');
const stubPath = path.resolve(gatewayServiceRoot, 'tests/e2e/stub_provider.py');
const gatewayConfigPath = path.resolve(gatewayServiceRoot, 'tests/e2e/gateway.yaml');

Object.assign(process.env, {
  DOTENV_CONFIG_PATH: noDotenvPath,
  E2E_BASE_URL: 'http://127.0.0.1:3334',
  E2E_HOST: '127.0.0.1',
  E2E_PASSTHROUGH_ENV: '',
  E2E_PORT: '3334',
  E2E_STREAM_STORE: 'memory',
  E2E_USE_MEMORY_MONGO: 'true',
  ENDPOINTS: 'custom',
  MONGO_URI: 'mongodb://127.0.0.1:27017/LibreChat-phase1-e2e',
  OPENAI_API_KEY: '',
});

const baseURL = getE2EBaseURL();
const baseEnv = {
  ...getLocalE2EEnv(),
  ALLOW_SOCIAL_LOGIN: 'false',
  ALLOW_SOCIAL_REGISTRATION: 'false',
  CONFIG_PATH: path.resolve(rootPath, 'e2e/config/librechat.phase1.yaml'),
  DOTENV_CONFIG_PATH: noDotenvPath,
  ENDPOINTS: 'custom',
  OPENAI_API_KEY: '',
  OPENID_AUTO_REDIRECT: 'false',
  OPENID_CLIENT_ID: '',
  OPENID_ISSUER: '',
  SG_GATEWAY_API_KEY: 'e2e-gateway-key',
  TENANT_ISOLATION_STRICT: 'false',
};

const gatewayEnv = {
  ...baseEnv,
  E2E_PROVIDER_API_KEY: 'e2e-provider-key',
  SG_GATEWAY_API_KEY: 'e2e-gateway-key',
  SG_GATEWAY_CONFIG: gatewayConfigPath,
};

Object.assign(process.env, baseEnv);

export default defineConfig({
  globalSetup: require.resolve('./setup/global-setup.phase1'),
  globalTeardown: require.resolve('./setup/global-teardown.mock'),
  testDir: 'specs/phase1/',
  outputDir: 'specs/.test-results/phase1',
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL,
    headless: true,
    ignoreHTTPSErrors: true,
    screenshot: 'off',
    storageState: path.resolve(rootPath, 'e2e/specs/.test-results/phase1/storage-state.json'),
    trace: 'off',
    video: 'off',
  },
  expect: { timeout: 10_000 },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: `uv run python ${stubPath} --port 4010`,
      cwd: gatewayServiceRoot,
      env: baseEnv,
      url: 'http://127.0.0.1:4010/health',
      stdout: 'pipe',
      timeout: 60_000,
      reuseExistingServer: false,
    },
    {
      command: 'uv run uvicorn sg_ai_gateway.main:app --host 127.0.0.1 --port 4000 --no-access-log',
      cwd: gatewayServiceRoot,
      env: gatewayEnv,
      url: 'http://127.0.0.1:4000/ready',
      stdout: 'pipe',
      timeout: 60_000,
      reuseExistingServer: false,
    },
    {
      command: `node ${serverPath}`,
      cwd: rootPath,
      env: baseEnv,
      url: baseURL,
      stdout: 'pipe',
      timeout: 120_000,
      reuseExistingServer: false,
    },
  ],
});
