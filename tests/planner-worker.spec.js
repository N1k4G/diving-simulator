const { expect, test } = require('./helpers/pinned-seed.cjs');
const { descendTo, startDive } = require('./helpers/start-dive.cjs');

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

const TEC = (page) => page.locator('[data-setup-group=mode] [data-setup-option=tec]').check();
const ndlRow = (page) => page.locator('.wreck-hud [data-hud-metric="ndl"] dd');

/** Opens the gas information's decompression page and returns its TTS value. */
async function decompressionTts(page) {
  const panel = page.locator('[data-gas-info]');
  // One cylinder: cylinders, tissues, decompression.
  for (let i = 0; i < 3; i += 1) await page.keyboard.press('i');
  await expect(panel.locator('h2')).toHaveText('Gas information · Decompression');
  return panel.locator('dl div', { hasText: 'Time to surface' }).locator('dd');
}

test('planner Worker runs off-main-thread from a same-origin module', async ({ page }) => {
  const workerUrl = new Promise(resolve => {
    page.once('worker', worker => resolve(worker.url()));
  });

  await page.goto('/dist/');
  await startDive(page, TEC);

  const url = await workerUrl;

  expect(url).toMatch(
    /^http:\/\/127\.0\.0\.1:8080\/dist\/assets\/planner-worker-/,
  );
  expect(url).not.toMatch(/^blob:/);

  // The URL alone only proves a worker was created from the right place. The
  // time to surface on the decompression page is rendered from
  // `presentation.planner`, which exists only once a forecast has come back
  // through that worker (game-controller.ts), so a round trip is what moves
  // this readout off its placeholder. That is the half the old forecast
  // assertion covered, asserted through the shipped path. Until #244 this
  // read the HUD's NDL row, which now shows the model's NDL of the tick, as
  // legacy's frameCalc.ndl, and no longer waits for the worker.
  // Asserted as "has a number in it" rather than against a formatted string:
  // the placeholder is an em dash in both locales, so any digit means a
  // forecast arrived. Below the surface the TTS is at least the ascent; the
  // value carries a hidden severity word after its minutes.
  await page.locator('[data-renderer=pixi] canvas').waitFor();
  await descendTo(page, 12);
  await expect(await decompressionTts(page)).toHaveText(/^\d+ min/);
});

// #244: legacy draws the NDL from the same frame's frameCalc.ndl. With a
// worker that answers nothing, no forecast ever arrives, and the NDL row
// still reads the dive's NDL, while the forecast's TTS keeps its placeholder.
test('the NDL row does not wait for the planner Worker', async ({ page }) => {
  await page.route('**/dist/assets/planner-worker-*', (route) =>
    route.fulfill({ status: 200, contentType: 'text/javascript', body: '// answers nothing\n' }),
  );
  await page.goto('/dist/');
  await startDive(page, TEC);
  await page.locator('[data-renderer=pixi] canvas').waitFor();

  // The dive starts at the surface (#199), where the NDL is unlimited and
  // reads as the unavailable mark, as legacy's "---"; below about 9 m on air
  // it is a number, at most 99 minutes as legacy caps it.
  await expect(ndlRow(page)).toHaveText('—');
  await descendTo(page, 12);
  await expect(ndlRow(page)).toHaveText(/^\d+ min$/);
  expect(Number.parseInt(await ndlRow(page).textContent(), 10)).toBeLessThanOrEqual(99);
  // Counter-check: no forecast came back, so the worker really was silent.
  await expect(await decompressionTts(page)).toHaveText('—');
  await expect(ndlRow(page)).toHaveText(/^\d+ min$/);
});
