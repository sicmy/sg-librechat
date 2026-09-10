import { defineConfig } from '@playwright/test';
import phase6Config from './playwright.config.phase6';

/** Initial cross-feature gate; deferred video/office previews are not claimed as covered. */
export default defineConfig({
  ...phase6Config,
  testMatch: ['phase8/**/*.spec.ts'],
  outputDir: 'specs/.test-results/phase8',
});
