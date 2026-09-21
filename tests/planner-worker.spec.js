const { expect, test } = require('@playwright/test');
const { startDive } = require('./helpers/start-dive.cjs');

// WHAT THIS GUARDS. The planner has to run off the main thread, from a
// same-origin module URL. `worker-src 'self'` in src/_headers blocks a blob:
// worker outright, so a bundler change that inlines the worker would not fail
// here — it would fail in production, at the first forecast, with the CSP
// error in a console nobody is reading.
//
// WHY IT DRIVES THE SIMULATION RATHER THAN A PROBE. This used to read
// `window.plannerWorkerDiagnostic`, a start-up probe that spawned a worker of
// its own. #161 moved that probe behind `import.meta.env.DEV`, because the
// Definition of done requires diagnostics to be absent from production and
// this suite tests the production bytes in /dist/. So the test now observes
// the worker the running simulation creates — which is the one that matters,
// and was never the one being asserted before.
//
// The simulation does not start until the safety gate is accepted
// (wreck-app.ts), so the click is load-bearing: without it no worker is ever
// created and the wait below would time out.
test('planner Worker runs off-main-thread from a same-origin module', async ({ page }) => {
  const workerUrl = new Promise(resolve => {
    page.once('worker', worker => resolve(worker.url()));
  });

  await page.goto('/dist/');
  await startDive(page);

  const url = await workerUrl;

  expect(url).toMatch(
    /^http:\/\/127\.0\.0\.1:8080\/dist\/assets\/planner-worker-/,
  );
  expect(url).not.toMatch(/^blob:/);

  // The URL alone only proves a worker was created from the right place. NDL
  // is rendered from `presentation.planner`, which exists only once a forecast
  // has come back through that worker (game-controller.ts), so a round trip is
  // what moves this readout off its placeholder. That is the half the old
  // forecast assertion covered, asserted through the shipped path.
  // Asserted as "has a number in it" rather than against a formatted string:
  // the placeholder is an em dash in both locales, so any digit means a
  // forecast arrived, and the check does not break when the duration format or
  // the negotiated locale changes.
  const ndl = page.locator('.wreck-hud [data-hud-metric="ndl"] dd');
  await expect(ndl).toHaveText(/\d/);
});
