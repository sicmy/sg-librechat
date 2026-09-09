import { defineConfig } from '@playwright/test';
import deletion from './playwright.config.deletion';

export default defineConfig({
  ...deletion,
  testMatch: ['import/**/*.spec.ts'],
  outputDir: 'specs/.test-results/import',
});
