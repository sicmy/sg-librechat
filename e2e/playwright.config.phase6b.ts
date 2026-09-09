import { defineConfig } from '@playwright/test';
import phase6aConfig from './playwright.config.phase6a';

export default defineConfig({
  ...phase6aConfig,
  testMatch: ['phase6b/**/*.spec.ts'],
  outputDir: 'specs/.test-results/phase6b',
});
