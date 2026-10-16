const { expect, test } = require('./helpers/pinned-seed.cjs');
const {
  descendTo,
  resumeSavedDive,
  startDiveAndWaitForCanvas,
} = require('./helpers/start-dive.cjs');

// The HUD readouts the surface route made reachable (#199 slice 7b, #197):
// the ascent rate and its fast-ascent warning, the safety-stop countdown,
// and the rule-of-thirds gauge, from legacy's dive computer (src/renderer.js
// drawDiveComputer) and its hud-thirds element (src/game-loop.js).

const SAVE_KEY = 'diving-simulator.save-game';

const hudRow = (page, name) => page.locator(`.wreck-hud [data-hud-metric="${name}"]`);
const hudValue = (page, name) => hudRow(page, name).locator('dd');
const chevrons = (page) => hudRow(page, 'ascentRate').locator('.ascent-chevrons');

/** A diver at 20 m with a BCD full enough to rise at legacy's 25 m/min cap. */
const risingFast = (state) => {
  state.depthM = 20;
  state.maxDepthM = Math.max(state.maxDepthM, 20);
  state.verticalVelocityMpm = 0;
  state.bcdGasSurfaceLiters = 40;
};

/**
 * Watches the chevrons in the page, frame by frame, from the first frame they
 * show legacy's danger tone for 1.2 s of real time, or until the dive ends
 * and the HUD goes. In the page, so that a rising dive ending in barotrauma
 * on a slow machine does not take the HUD away between two Playwright round
 * trips. Every frame's count, lit chevrons, direction and blink.
 */
const watchDangerChevrons = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        const frames = [];
        let firstDanger = null;
        const started = performance.now();
        const look = () => {
          const element = document.querySelector('.ascent-chevrons');
          const now = performance.now();
          if (element?.dataset.tier === 'danger') {
            firstDanger ??= now;
            frames.push({
              count: element.dataset.count,
              direction: element.dataset.direction,
              ariaHidden: element.getAttribute('aria-hidden'),
              lit: element.querySelectorAll('span[data-lit]').length,
              blinkedOff: element.hasAttribute('data-blinked-off'),
            });
          }
          const done =
            (firstDanger !== null && (now - firstDanger > 1_200 || !element)) ||
            now - started > 30_000;
          if (done) resolve({ frames, dangerMs: firstDanger === null ? 0 : now - firstDanger });
          else requestAnimationFrame(look);
        };
        look();
      }),
  );

/**
 * Starts a dive, takes a save of it under way, edits it with `mutate` and
 * resumes it. The save is taken before the diver has finned, so the resumed
 * dive picks up at the route's start, in open water off the bow.
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
  await resumeSavedDive(page);
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
  // Legacy's chevrons point down too (#222).
  await expect(chevrons(page)).toHaveAttribute('data-direction', 'down');
});

test('a fast ascent warns in words, marks the rate, and names it in the chip', async ({ page }) => {
  // Legacy's SLOW DOWN banner past 9 m/min up (#197).
  await resumeWith(page, risingFast);

  await expect(page.getByRole('alert')).toHaveText('Ascending too fast — slow down', { timeout: 15_000 });
  await expect(page.locator('.status-chip')).toHaveText('⚠ Fast ascent');
  await expect(hudValue(page, 'ascentRate')).toHaveText(/^⚠ ↑ \d+ m\/min$/);
  await expect(hudRow(page, 'ascentRate')).toHaveAttribute('data-danger', '');
});

test('past 18 m/min up all six chevrons show in the danger tone, and blink', async ({ page }) => {
  // Legacy's chevrons (#222). They repeat the row's words for the eye only.
  await resumeWith(page, risingFast);
  const { frames, dangerMs } = await watchDangerChevrons(page);

  expect(frames.length).toBeGreaterThan(0);
  for (const frame of frames) {
    expect(frame).toMatchObject({ count: '6', direction: 'up', ariaHidden: 'true' });
    expect(frame.lit).toBe(frame.blinkedOff ? 0 : 6);
  }
  // Off for 300 ms in every 600: both seen within the 1.2 s watched.
  expect(dangerMs).toBeGreaterThan(600);
  expect(frames.some((frame) => frame.blinkedOff)).toBe(true);
  expect(frames.some((frame) => !frame.blinkedOff)).toBe(true);
});

// The chevrons take no room in the row (#254 pre-review pass 1): between
// its label and its value they wrapped both onto two lines. With and
// without them the row is as high, and they meet no row's text and stay in
// the panel. 960x540 and 844x390 lay the HUD out in two columns, 390x844 in
// one 12.5rem column.
for (const [width, height] of [[960, 540], [844, 390], [390, 844]]) {
  test.describe(`${width}x${height}`, () => {
    test.use({ viewport: { width, height } });

    test('the chevrons leave the ascent-rate row as high as without them, clear of every row', async ({ page }) => {
      await page.goto('/dist/');
      await page.evaluate(() => window.localStorage.clear());
      await startDiveAndWaitForCanvas(page);
      await expect(hudValue(page, 'ascentRate')).toHaveText('0 m/min');

      const measure = () =>
        page.evaluate(() => {
          const box = (element) => element.getBoundingClientRect().toJSON();
          const row = document.querySelector('.wreck-hud [data-hud-metric="ascentRate"]');
          return {
            row: box(row),
            hud: box(document.querySelector('.wreck-hud')),
            chevrons: box(row.querySelector('.ascent-chevrons')),
            texts: [...document.querySelectorAll('.wreck-hud dt, .wreck-hud dd')]
              .filter((element) => element.getClientRects().length > 0)
              .map(box),
          };
        });
      const withChevrons = await measure();
      await page.addStyleTag({ content: '.ascent-chevrons { display: none !important; }' });
      const without = await measure();

      // No absolute height: at 390x844 linux's fonts wrap the row with or
      // without the chevrons (38 px in CI), win32's do not.
      expect(withChevrons.row.height).toBe(without.row.height);
      const { chevrons, hud } = withChevrons;
      expect(chevrons.width).toBeGreaterThan(0);
      expect(chevrons.left).toBeGreaterThanOrEqual(hud.left);
      expect(chevrons.right).toBeLessThanOrEqual(hud.right);
      expect(chevrons.top).toBeGreaterThanOrEqual(hud.top);
      expect(chevrons.bottom).toBeLessThanOrEqual(hud.bottom);
      for (const text of withChevrons.texts) {
        const overlaps =
          chevrons.left < text.right &&
          text.left < chevrons.right &&
          chevrons.top < text.bottom &&
          text.top < chevrons.bottom;
        expect(overlaps, JSON.stringify(text)).toBe(false);
      }
    });
  });
}

test('with reduced motion the chevrons of a fast ascent stay lit and do not blink', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await resumeWith(page, risingFast);
  const { frames } = await watchDangerChevrons(page);

  expect(frames.length).toBeGreaterThan(0);
  for (const frame of frames) {
    expect(frame).toMatchObject({ count: '6', lit: 6, blinkedOff: false });
  }
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

test('a dive resumed in the cargo hold stays there, under the overhead with the plan it entered on', async ({ page }) => {
  test.setTimeout(120_000);
  // Into the hold as above (#222), then a reload: the save holds the route
  // position, so the resumed diver is still under the deck, and the rule of
  // thirds runs on from the plan made on entering, not one made afresh.
  await resumeWith(page, (state) => {
    state.depthM = 21;
    state.maxDepthM = Math.max(state.maxDepthM, 21);
    state.verticalVelocityMpm = 0;
    state.bcdGasSurfaceLiters = 5;
  });
  const zone = hudValue(page, 'zone');
  await page.keyboard.down('d');
  await expect(zone).toHaveText('Cargo hold', { timeout: 30_000 });
  await page.keyboard.up('d');
  await expect(hudValue(page, 'thirds')).toHaveText(/^Outbound · \d+%$/);

  // An autosave taken under the deck, with the plan made on entering.
  const inHold = await page
    .waitForFunction((key) => {
      const raw = window.localStorage.getItem(key);
      const parsed = raw === null ? null : JSON.parse(raw);
      return parsed !== null && parsed.routePositionM >= 22 && parsed.state.thirds.startingGasL > 0
        ? parsed
        : null;
    }, SAVE_KEY, { timeout: 15_000 })
    .then((handle) => handle.jsonValue());
  expect(inHold.version).toBe(18);

  // A real reload, and Resume on the banner. Leaving the page saved once
  // more, still in the hold.
  await page.goto('/dist/');
  const reloaded = await page.evaluate((key) => JSON.parse(window.localStorage.getItem(key)), SAVE_KEY);
  expect(reloaded.routePositionM).toBeGreaterThanOrEqual(22);
  expect(reloaded.state.thirds.startingGasL).toBe(inHold.state.thirds.startingGasL);
  await resumeSavedDive(page);
  await page.locator('[data-renderer=pixi] canvas').waitFor();

  await expect(zone).toHaveText('Cargo hold');
  await expect(hudRow(page, 'thirds')).toBeVisible();
  await expect(hudValue(page, 'thirds')).toHaveText(/^Outbound · \d+%$/);
  // The resumed dive's own saves: still in the hold, on the same plan.
  const resumed = await page
    .waitForFunction(
      ([key, before]) => {
        const raw = window.localStorage.getItem(key);
        const parsed = raw === null ? null : JSON.parse(raw);
        return parsed !== null && parsed.state.elapsedTimeS > before ? parsed : null;
      },
      [SAVE_KEY, reloaded.state.elapsedTimeS],
      { timeout: 15_000 },
    )
    .then((handle) => handle.jsonValue());
  expect(resumed.routePositionM).toBe(reloaded.routePositionM);
  expect(resumed.state.thirds.startingGasL).toBe(reloaded.state.thirds.startingGasL);
});
