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

// #302: the same suite in three engines. `npm run test:e2e` and verify run the
// chromium project; pr.yml's `browsers` job runs firefox and webkit over the
// verified dist/. A test that drives the page through the Chrome DevTools
// Protocol (multi-touch input through Input.dispatchTouchEvent, the
// accessibility tree through Accessibility.getPartialAXTree) has no equivalent
// in the other two, so it carries the @chromium-only tag and runs in Chromium
// alone. A test that fails in one engine for a reason of that engine's is
// marked test.fixme for that engine only, with its issue number.
const CHROMIUM_ONLY = /@chromium-only/;

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
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    // Headless Firefox on a GPU-less Linux runner refuses WebGL on its
    // software rasteriser, so the Pixi scene never starts there; Chromium
    // (SwiftShader) and WebKit draw on theirs without being asked (#302).
    {
      name: 'firefox',
      use: { browserName: 'firefox', launchOptions: { firefoxUserPrefs: { 'webgl.force-enabled': true } } },
      grepInvert: CHROMIUM_ONLY,
    },
    { name: 'webkit', use: { browserName: 'webkit' }, grepInvert: CHROMIUM_ONLY },
  ],
});
