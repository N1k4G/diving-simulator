const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 60000,
  use: {
    baseURL: 'http://localhost:8080',
    headless: true,
  },
  webServer: {
    command: 'node node_modules/http-server/bin/http-server . -p 8080 --silent',
    port: 8080,
    reuseExistingServer: process.env.PLAYWRIGHT_REUSE_SERVER === '1' || !process.env.CI,
  },
  reporter: [['list'], ['html', { open: 'never' }]],
});
