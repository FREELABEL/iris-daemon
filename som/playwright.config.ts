import { defineConfig } from '@playwright/test';

export default defineConfig({
  timeout: 600000,
  use: {
    headless: false,
    viewport: { width: 1280, height: 720 },
    actionTimeout: 30000,
  },
  reporter: [['list']],
});
