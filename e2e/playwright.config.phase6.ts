import { defineConfig } from '@playwright/test';
import phase6aConfig from './playwright.config.phase6a';

export default defineConfig({
  ...phase6aConfig,
  testMatch: ['phase6a/**/*.spec.ts', 'phase6b/**/*.spec.ts', 'phase6c/**/*.spec.ts'],
  outputDir: 'specs/.test-results/phase6',
});
