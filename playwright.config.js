const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.js',
  timeout: 60000,
  globalSetup: require.resolve('./tests/global-setup.js'),
  use: {
    baseURL: 'http://127.0.0.1:8080',
    headless: true,
  },
  reporter: [['list'], ['html', { open: 'never' }]],
});
