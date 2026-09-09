import { defineConfig } from '@playwright/test';
import phase6 from './playwright.config.phase6';

export default defineConfig({
  ...phase6,
  testMatch: ['deletion/**/*.spec.ts'],
  outputDir: 'specs/.test-results/deletion',
});
