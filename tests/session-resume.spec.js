const { expect, test } = require('./helpers/pinned-seed.cjs');
const { descendTo, resumeSavedDive, startDiveAndWaitForCanvas } = require('./helpers/start-dive.cjs');

// A reload mid-dive gives the session back (#137 A4b): the route position,
// the way the diver faces and the torch as the page left them, the diver
// drawn at the saved depth from the first frame, and no control still held,
// though the key that was down as the page went is still down.
//
// The facing is drawn on the canvas alone; the save carries it since v21,
// written from the field the scene draws (src/app/game-controller.ts), so
// the resumed dive's own save is where it is read.

const SAVE_KEY = 'diving-simulator.save-game';
const torch = (page) => page.locator('[data-torch]');
const readSave = (page) => page.evaluate((key) => JSON.parse(window.localStorage.getItem(key)), SAVE_KEY);

/** The first save written after this call, so one that saw everything before it. */
async function nextSave(page, check = () => true) {
  const now = await page.evaluate(() => Date.now());
  const handle = await page.waitForFunction(
    ([key, after]) => {
      const saved = JSON.parse(window.localStorage.getItem(key) ?? 'null');
      return saved !== null && saved.savedAtEpochMs > after ? saved : null;
    },
    [SAVE_KEY, now],
    { timeout: 15_000 },
  );
  const saved = await handle.jsonValue();
  return check(saved) ? saved : nextSave(page, check);
}

/** The HUD's depth, which the shell shows as unavailable until the dive's first frame. */
function hudDepthShown(page) {
  return page.waitForFunction(() => {
    const value = document.querySelector('.wreck-hud [data-hud-metric="depth"] dd');
    return Number.isFinite(Number.parseFloat(String(value?.textContent ?? '').replace(',', '.')));
  });
}

/**
 * Records the HUD's depth and the torch button's state on every animation
 * frame from now, once the dive's first frame has shown a depth.
 */
function recordHud(page) {
  return page.evaluate(() => {
    window.__hudSamples = [];
    const read = () => {
      const value = document.querySelector('.wreck-hud [data-hud-metric="depth"] dd');
      const depthM = Number.parseFloat(String(value?.textContent ?? '').replace(',', '.'));
      const torchOn = document.querySelector('[data-torch]')?.getAttribute('aria-pressed');
      if (Number.isFinite(depthM)) window.__hudSamples.push({ depthM, torchOn });
      requestAnimationFrame(read);
    };
    requestAnimationFrame(read);
  });
}

test('a dive reloaded mid-dive resumes its position, facing, torch and depth, with nothing held', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/dist/');
  await page.evaluate(() => window.localStorage.clear());
  await startDiveAndWaitForCanvas(page);
  await descendTo(page, 1);
  // Held still at 5 m over the bow, neutral there (tests/rotation.spec.js
  // resumeStill), so the depth stays where it is and a jump is not hidden by
  // a drift; the stop's countdown under way, as the codec ties it to 5 m.
  const saved = await nextSave(page, (save) => save.state.elapsedTimeS > 0);
  const pressureBar = 1.5;
  Object.assign(saved.state, {
    depthM: 5,
    maxDepthM: 20,
    verticalVelocityMpm: 0,
    bcdGasSurfaceLiters: (7 + 2 - 3 - 5 * Math.pow(1 / pressureBar, 0.7)) * pressureBar,
    safetyStop: { needed: true, countdownStarted: true, remainingS: 172, paused: false, complete: false },
  });
  saved.session.routePositionM = 50;
  await page.goto('/dist/');
  await page.evaluate(([key, value]) => window.localStorage.setItem(key, value), [SAVE_KEY, JSON.stringify(saved)]);
  await resumeSavedDive(page);
  // The torch button stands in the shell before the dive runs, so wait for
  // the dive's first frame before pressing its key.
  await hudDepthShown(page);
  await expect(torch(page)).toBeVisible();

  // Turn the torch off and fin left, which turns the diver; the key is still
  // down as the page goes.
  await page.keyboard.press('t');
  await expect(torch(page)).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.down('a');
  await nextSave(page, (save) => save.session.facing === -1 && save.session.routePositionM < 49);
  await page.goto('/dist/');

  // What pagehide saved as the page went.
  const left = await readSave(page);
  expect(left.version).toBe(21);
  expect(left.session.facing).toBe(-1);
  expect(left.session.torchOn).toBe(false);
  expect(left.session.routePositionM).toBeLessThan(49);
  expect(Object.keys(left.session).sort()).toEqual(['facing', 'routePositionM', 'torchOn']);

  await recordHud(page);
  await resumeSavedDive(page);
  // From the dive's first frame the torch is off and the depth shown is the
  // saved one, and no frame after it jumps (a neutral diver drifts well under
  // 0.1 m here).
  await page.waitForFunction(() => window.__hudSamples.length >= 30);
  const samples = await page.evaluate(() => window.__hudSamples);
  expect(Math.abs(samples[0].depthM - left.state.depthM)).toBeLessThanOrEqual(0.05 + 1e-9);
  for (const sample of samples) {
    expect(sample.torchOn).toBe('false');
    expect(Math.abs(sample.depthM - left.state.depthM)).toBeLessThanOrEqual(0.15);
  }
  await expect(torch(page)).toBeVisible();

  // The resumed dive's own saves: the same place, facing and torch. The A key
  // still down in the browser is not held in the dive, so the diver has not
  // moved along the route.
  const resumed = await nextSave(page, (save) => save.state.elapsedTimeS > left.state.elapsedTimeS);
  expect(resumed.session.routePositionM).toBeCloseTo(left.session.routePositionM, 6);
  expect(resumed.session.facing).toBe(-1);
  expect(resumed.session.torchOn).toBe(false);
  const later = await nextSave(page, (save) => save.state.elapsedTimeS > resumed.state.elapsedTimeS + 2);
  expect(later.session.routePositionM).toBeCloseTo(left.session.routePositionM, 6);
  expect(later.state.bcdGasSurfaceLiters).toBeCloseTo(left.state.bcdGasSurfaceLiters, 6);
  await page.keyboard.up('a');
});
