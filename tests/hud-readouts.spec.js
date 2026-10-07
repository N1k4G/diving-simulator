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

test('the rule of thirds is kept under the deck, from the plan made on entering, and not outside', async ({ page }) => {
  test.setTimeout(120_000);
  // Neutral at 28 m (tests/unit/thirds-turn-beep.test.ts pins the value), so
  // the diver swims level into the cargo hold between its deck and floor.
  await resumeWith(page, (state) => {
    state.depthM = 28;
    state.maxDepthM = Math.max(state.maxDepthM, 28);
    state.verticalVelocityMpm = 0;
    state.bcdGasSurfaceLiters = 15.337143629243002;
  });
  await expect(hudRow(page, 'thirds')).toBeHidden();

  const zone = hudValue(page, 'zone');
  await page.keyboard.down('d');
  await expect(zone).toHaveText('Cargo hold', { timeout: 30_000 });
  await page.keyboard.up('d');
  await expect(hudRow(page, 'thirds')).toBeVisible();
  await expect(hudValue(page, 'thirds')).toHaveText(/^Outbound · \d+%$/);

  await page.keyboard.down('a');
  await expect(zone).toHaveText('Wreck exterior', { timeout: 30_000 });
  await page.keyboard.up('a');
  await expect(hudRow(page, 'thirds')).toBeHidden();
});
