const { expect, test } = require('@playwright/test');
const {
  descendTo,
  startDive,
  startDiveAndWaitForCanvas,
} = require('./helpers/start-dive.cjs');

// The HUD readouts the surface route made reachable (#199 slice 7b, #197):
// the ascent rate and its fast-ascent warning, the safety-stop countdown,
// and the rule-of-thirds gauge, from legacy's dive computer (src/renderer.js
// drawDiveComputer) and its hud-thirds element (src/game-loop.js).

const SAVE_KEY = 'diving-simulator.save-game';

const hudRow = (page, name) => page.locator(`.wreck-hud [data-hud-metric="${name}"]`);
const hudValue = (page, name) => hudRow(page, name).locator('dd');

/**
 * Starts a dive, takes a save of it under way, edits it with `mutate` and
 * resumes it. A resumed dive picks up at the route's start, in open water
 * off the bow, as the save holds no route position.
 */
async function resumeWith(page, mutate) {
  await page.goto('/dist/');
  await page.evaluate(() => window.localStorage.clear());
  await startDiveAndWaitForCanvas(page);
  await descendTo(page, 1);
  const saved = await page
    .waitForFunction((key) => {
      const raw = window.localStorage.getItem(key);
      const parsed = raw === null ? null : JSON.parse(raw);
      return parsed !== null && parsed.state.elapsedTimeS > 0 ? parsed : null;
    }, SAVE_KEY)
    .then((handle) => handle.jsonValue());
  mutate(saved.state);
  await page.goto('/dist/');
  await page.evaluate(
    ([key, value]) => window.localStorage.setItem(key, value),
    [SAVE_KEY, JSON.stringify(saved)],
  );
  await startDive(page);
  await page.locator('[data-renderer=pixi] canvas').waitFor();
}

test('the ascent rate points down while the diver sinks', async ({ page }) => {
  await page.goto('/dist/');
  await page.evaluate(() => window.localStorage.clear());
  await startDiveAndWaitForCanvas(page);
  await expect(hudValue(page, 'ascentRate')).toHaveText('0 m/min');
  await descendTo(page, 3);
  // Released, the vented diver goes on sinking.
  await expect(hudValue(page, 'ascentRate')).toHaveText(/^↓ \d+ m\/min$/);
  await expect(hudRow(page, 'ascentRate')).not.toHaveAttribute('data-danger', '');
});

test('a fast ascent warns in words, marks the rate, and names it in the chip', async ({ page }) => {
  // Legacy's SLOW DOWN banner past 9 m/min up (#197). A diver at 20 m with
  // a BCD full enough to rise at legacy's 25 m/min cap.
  await resumeWith(page, (state) => {
    state.depthM = 20;
    state.maxDepthM = Math.max(state.maxDepthM, 20);
    state.verticalVelocityMpm = 0;
    state.bcdGasSurfaceLiters = 40;
  });

  await expect(page.getByRole('alert')).toHaveText('Ascending too fast — slow down', { timeout: 15_000 });
  await expect(page.locator('.status-chip')).toHaveText('⚠ Fast ascent');
  await expect(hudValue(page, 'ascentRate')).toHaveText(/^⚠ ↑ \d+ m\/min$/);
  await expect(hudRow(page, 'ascentRate')).toHaveAttribute('data-danger', '');
});

test('a safety stop under way counts down at its 5 m, and fast-forward is offered', async ({ page }) => {
  await resumeWith(page, (state) => {
    state.depthM = 5;
    state.maxDepthM = Math.max(state.maxDepthM, 24);
    state.verticalVelocityMpm = 0;
    state.safetyStop = {
      needed: true,
      countdownStarted: true,
      remainingS: 100,
      paused: false,
      complete: false,
    };
  });

  await expect(hudRow(page, 'safetyStop')).toBeVisible();
  await expect(hudValue(page, 'safetyStop')).toHaveText(/^5 m · 1 min,? \d+ sec left( · paused)?$/);
  await expect(page.locator('[data-fast-forward]')).toBeVisible();
});

test('a safety stop that is done says so, as legacy\'s SAFETY STOP / Complete', async ({ page }) => {
  await resumeWith(page, (state) => {
    state.depthM = 5;
    state.maxDepthM = Math.max(state.maxDepthM, 24);
    state.verticalVelocityMpm = 0;
    state.safetyStop = {
      needed: true,
      countdownStarted: true,
      remainingS: 1,
      paused: false,
      complete: false,
    };
  });

  await expect(hudValue(page, 'safetyStop')).toHaveText('Complete');
  await expect(hudRow(page, 'safetyStop')).toHaveAttribute('data-phase', 'complete');
});

test('under a ceiling the stop row is the deco stop, with the first stop of the forecast', async ({ page }) => {
  // Legacy's stop box while inDeco: DECO STOP, then schedule.stops[0]'s depth
  // and minutes. tests/in-dive-controls.spec.js DECO_STOPS.midWater: loaded
  // tissues, neutral at 18 m (pinned in
  // tests/unit/game-controller-fast-forward.test.ts). A safety stop is owed
  // too, from 34 m, and gives way.
  await resumeWith(page, (state) => {
    state.depthM = 18;
    state.maxDepthM = 34;
    state.verticalVelocityMpm = 0;
    state.bcdGasSurfaceLiters = 9.990465669399928;
    state.tissues.nitrogenBar = state.tissues.nitrogenBar.map(() => 3);
  });

  const row = hudRow(page, 'safetyStop');
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute('data-phase', 'deco');
  await expect(row.locator('dt')).toHaveText('Deco stop');
  // The numbers come with the worker's forecast; the planner rounds the
  // minutes up, as legacy's calculateDecoSchedule() does.
  await expect(hudValue(page, 'safetyStop')).toHaveText(/^\d+ m · \d+ min$/, { timeout: 15_000 });
});

test('a dive surfaced fast past its stop ends on the post-dive screen, with no stop row or warning left', async ({ page }) => {
  // Legacy's post-dive state draws no dive computer: the stop it skipped is
  // logged, not owed, and nothing rises any more. A diver 1.5 m down, rising
  // fast with a full BCD, a paused stop still owed from 20 m. Since #227 the
  // completed dive's HUD is torn down for the post-dive screen; the
  // presentation's own rule (no rate, no stop once completed) is pinned in
  // tests/unit/presentation-state.test.ts.
  await resumeWith(page, (state) => {
    state.elapsedTimeS = 120;
    state.depthM = 1.5;
    state.maxDepthM = Math.max(state.maxDepthM, 20);
    state.verticalVelocityMpm = -15;
    state.bcdGasSurfaceLiters = 40;
    state.safetyStop = {
      needed: true,
      countdownStarted: true,
      remainingS: 100,
      paused: true,
      complete: false,
    };
  });

  // Completion clears the save (#223).
  await page.waitForFunction(
    (key) => window.localStorage.getItem(key) === null,
    SAVE_KEY,
    { timeout: 30_000 },
  );
  await expect(page.locator('[data-post-dive]')).toBeVisible();
  // Nothing of the dive computer stays: not the stop row, not the rate, not
  // the fast-ascent warning or its chip.
  await expect(page.locator('.wreck-hud')).toHaveCount(0);
  await expect(page.locator('.wreck-warning, .status-chip')).toHaveCount(0);
});

test('the rule of thirds is kept under the deck, from the plan made on entering, and not outside', async ({ page }) => {
  test.setTimeout(120_000);
  // The hold is entered from above, through the bow visor's opening (#222):
  // the diver starts at 21 m, over the stem's top at 24.5 m and below the
  // raised visor's top at 19.4 m, light on gas so it sinks. Finning aft, it
  // crosses the stem into the opening, where the visor and the deck's forward
  // edge hold it until it has sunk below the deck, and then goes on under the
  // deck into the cargo hold.
  await resumeWith(page, (state) => {
    state.depthM = 21;
    state.maxDepthM = Math.max(state.maxDepthM, 21);
    state.verticalVelocityMpm = 0;
    state.bcdGasSurfaceLiters = 5;
  });
  await expect(hudRow(page, 'thirds')).toBeHidden();

  const zone = hudValue(page, 'zone');
  await page.keyboard.down('d');
  await expect(zone).toHaveText('Cargo hold', { timeout: 30_000 });
  await page.keyboard.up('d');
  await expect(hudRow(page, 'thirds')).toBeVisible();
  await expect(hudValue(page, 'thirds')).toHaveText(/^Outbound · \d+%$/);

  // Back out the same way: forward from under the deck into the opening,
  // which is open water and not the overhead.
  await page.keyboard.down('a');
  await expect(zone).toHaveText('Wreck exterior', { timeout: 30_000 });
  await page.keyboard.up('a');
  await expect(hudRow(page, 'thirds')).toBeHidden();
});
