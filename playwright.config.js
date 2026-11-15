const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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

// #319: on the GPU-less CI runner Firefox gets no WebGL headless, and under
// Xvfb Pixi's init never settles, so the wreck scene cannot start there. With
// PLAYWRIGHT_FIREFOX_NO_WEBGL set (pr.yml, Firefox only) the firefox project
// leaves out every spec file that starts the scene: one that waits for its
// canvas or drives a dive through the start helpers. Read from the files, so a
// new spec is sorted without a list to keep. Remove with #319.
const STARTS_PIXI = /data-renderer=pixi|WaitForCanvas|\b(startDive|startDiveByKeyboard|startDiveByTouch|resumeSavedDive|descendTo|beginDescent)\b/;
const PIXI_SPECS = fs
  .readdirSync(path.join(__dirname, 'tests'))
  .filter((name) => name.endsWith('.spec.js'))
  .filter((name) => STARTS_PIXI.test(fs.readFileSync(path.join(__dirname, 'tests', name), 'utf8')));
const FIREFOX_IGNORE = process.env.PLAYWRIGHT_FIREFOX_NO_WEBGL ? PIXI_SPECS : [];

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
    { name: 'firefox', use: { browserName: 'firefox' }, grepInvert: CHROMIUM_ONLY, testIgnore: FIREFOX_IGNORE },
    { name: 'webkit', use: { browserName: 'webkit' }, grepInvert: CHROMIUM_ONLY },
  ],
});
