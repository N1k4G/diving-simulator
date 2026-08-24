const os = require('node:os');
const { defineConfig } = require('@playwright/test');

// Playwright's default is one worker per two cores, which on a 14-core machine
// means seven headless Chromium instances doing WebGL and canvas work against a
// single-threaded static server. Under that load three different specs timed
// out intermittently — `reload-resume` (#130), `wreck-slice` (#126) and
// `game.spec` — none of which ever failed in isolation. Measured full-suite
// runs on 14 cores:
//
//   7 workers  ~40% of runs failed        ~31 s
//   4 workers  6 of 6 runs clean          ~21 s   <- also the fastest
//   2 workers  3 of 3 runs clean          ~35 s
//   1 worker   2 of 2 runs clean          ~36 s
//
// Parallelism past four was buying nothing and costing reliability. One worker
// per four cores, capped at four, keeps the fast case and stays conservative on
// a small CI runner.
const WORKERS = Math.max(1, Math.min(4, Math.ceil(os.cpus().length / 4)));

module.exports = defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.js',
  timeout: 60000,
  workers: WORKERS,
  globalSetup: require.resolve('./tests/global-setup.js'),
  use: {
    baseURL: 'http://127.0.0.1:8080',
    headless: true,
  },
  reporter: [['list'], ['html', { open: 'never' }]],
});
