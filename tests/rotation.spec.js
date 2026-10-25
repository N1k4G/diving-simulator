const { expect, test } = require('./helpers/pinned-seed.cjs');
const { acceptSafetyGate, descendTo } = require('./helpers/start-dive.cjs');

// Rotation, the browser level (#137 A8). A phone turned during a dive
// changes the viewport and nothing else: the document, the dive and what the
// diver holds go on. Playwright's setViewportSize is that change as the
// page sees it (a resize, with the layout reflowing); the Activity and
// WebView path that Capacitor's `configChanges` governs, which no viewport
// change can exercise, is the emulator or device level of A8 and is not
// covered here (no Android project exists yet).
//
// Covered, between a portrait phone and its landscape counterpart (390x844 and
// 844x390, 360x640 and 640x360), several times over:
//   - the same document: no navigation, no reload, a marker on window stays;
//   - the dive goes on: its clock advances; depth never jumps by more than the
//     elapsed time allows, sampled every animation frame across the whole turn;
//   - the torch and the diver's place on the route are continuous;
//   - a D-pad direction held across a rotation, then lifted or cancelled, is
//     let go (its button, and the model, which stops acting on it);
//   - the open help, gas page and instructor panel stay open, a closed one
//     stays closed, and the help's own pause outlasts the turn;
//   - every in-dive control stands inside the viewport and is at least 44 px.
//
// Not asserted here, on purpose: that the HUD and the controls do not
// overlap, where the hint stands and that the bottom controls are on screen on
// a short landscape screen. Those are #256 (844x390, 667x375; its text puts
// the D-pad below the fold, about 154 px off screen at 844x390) and, at 320 px,
// #258. The bottom edge is therefore checked in portrait only, as
// tests/viewport.spec.js does. The diver's facing is not asserted either:
// nothing the page shows, saves or exposes carries it but the canvas.

const SAVE_KEY = 'diving-simulator.save-game';

const PHONE = {
  hasTouch: true,
  isMobile: true,
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1',
};

const PAIRS = [
  { portrait: { width: 390, height: 844 }, landscape: { width: 844, height: 390 } },
  { portrait: { width: 360, height: 640 }, landscape: { width: 640, height: 360 } },
];

// The 44 px touch target of #121 (tests/result-screen.spec.js).
const MIN_TARGET_PX = 44;
// src/app/game-controller.ts FIN_SPEED_MPS: the diver's speed along the route
// in real seconds, which bounds how far the position may move.
const FIN_SPEED_MPS = 5;

const hudValue = (page, name) => page.locator(`.wreck-hud [data-hud-metric="${name}"] dd`);
const pad = (page, control) => page.locator(`.wreck-controls [data-control="${control}"]`);
const torch = (page) => page.locator('[data-torch]');

const persistedSave = (page) =>
  page
    .waitForFunction((key) => {
      const raw = window.localStorage.getItem(key);
      const saved = raw === null ? null : JSON.parse(raw);
      return saved !== null && saved.state.elapsedTimeS > 0 ? saved : null;
    }, SAVE_KEY)
    .then((handle) => handle.jsonValue());

/** The first autosave written after this call, so one that saw everything before it. */
async function nextSave(page) {
  const now = await page.evaluate(() => Date.now());
  const handle = await page.waitForFunction(
    ([key, after]) => {
      const saved = JSON.parse(window.localStorage.getItem(key) ?? 'null');
      return saved !== null && saved.savedAtEpochMs > after ? saved : null;
    },
    [SAVE_KEY, now],
    { timeout: 15_000 },
  );
  return handle.jsonValue();
}

/**
 * A dive in `mode`, held still at 5 m with its safety stop under way and the
 * diver on the route at `routePositionM`: neutral there, as
 * tests/touch-context.spec.js resumeAtSafetyStop() makes it (the BCD's gas is
 * src/core/buoyancy.ts neutralBcdSurfaceLitres at 5 m: 7 + 2 - 3 less 5 litres
 * of the wetsuit's gas at that pressure), so depth stays where it is and a
 * jump is not hidden by a drift. 5 m is above the hull, so the diver can swim
 * the route's length. Returns the BCD's gas at the start.
 *
 * `pinned` is for the case that vents: the diver is put under the deck of the
 * wreck at 23.9 m, 0.1 m below its underside at x 50 (src/sites/wreck-route.ts
 * WRECK_DECK_UNDERSIDE, 24.5 m at x 22 to 23 m at x 82: 23.8 m at x 50), with
 * 18 L of gas in the BCD at that depth's 3.39 bar (61 surface litres; the save
 * codec takes any non-negative value). Positively buoyant, the diver rises to
 * the deck and stays there, the model clamping depth and ascent rate at the
 * ceiling, so a vent has gas to take for the seven seconds or so that a
 * hold of any plausible length needs, whatever the machine's speed, and the
 * diver does not run away upward.
 */
async function resumeStill(page, mode, routePositionM, pinned = false) {
  await page.goto('/dist/');
  await page.evaluate(() => window.localStorage.clear());
  await acceptSafetyGate(page);
  await page.locator(`[data-setup-group=mode] [data-setup-option=${mode}]`).check();
  await page.locator('[data-start-dive]').click();
  await page.locator('[data-renderer=pixi] canvas').waitFor();
  await descendTo(page, 1);
  const saved = await persistedSave(page);
  const depthM = pinned ? 23.9 : 5;
  const pressureBar = 1 + depthM / 10;
  const bcdGasSurfaceLiters = pinned
    ? 18 * pressureBar
    : (7 + 2 - 3 - 5 * Math.pow(1 / pressureBar, 0.7)) * pressureBar;
  Object.assign(saved.state, {
    depthM,
    maxDepthM: pinned ? 24 : 20,
    verticalVelocityMpm: 0,
    bcdGasSurfaceLiters,
    // The stop of the save as it stands for the pinned dive: the codec ties a
    // stop to the depth it was made at, and refuses this one at 23.9 m.
    ...(pinned ? {} : { safetyStop: { needed: true, countdownStarted: true, remainingS: 172, paused: false, complete: false } }),
  });
  saved.routePositionM = routePositionM;
  await page.goto('/dist/');
  await page.evaluate(([key, value]) => window.localStorage.setItem(key, value), [SAVE_KEY, JSON.stringify(saved)]);
  await page.locator('[data-accept-safety]').click();
  await page.locator('.setup-screen').waitFor();
  await page.locator('[data-resume-continue]').click();
  await page.locator('[data-renderer=pixi] canvas').waitFor();
  await expect(pad(page, 'right')).toBeVisible();
  return bcdGasSurfaceLiters;
}

/**
 * Marks this document and records, every animation frame, the dive's depth
 * and clock as the HUD shows them, with the page's own time. The marker and
 * the record live on window, so a reload or a navigation loses both.
 */
function watchDocument(page) {
  const navigations = [];
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) navigations.push(frame.url());
  });
  return page
    .evaluate(() => {
      window.__rotationMarker = `marker-${Math.random()}`;
      window.__rotationSamples = [];
      const depth = document.querySelector('.wreck-hud [data-hud-metric="depth"] dd');
      const read = () => {
        const metres = Number.parseFloat(String(depth?.textContent ?? '').replace(',', '.'));
        window.__rotationSamples.push({ t: performance.now(), depthM: metres });
        requestAnimationFrame(read);
      };
      requestAnimationFrame(read);
      return window.__rotationMarker;
    })
    .then((marker) => ({
      marker,
      navigations,
      async sameDocument() {
        expect(await page.evaluate(() => window.__rotationMarker), 'the document is the same').toBe(marker);
        expect(navigations, 'the page has not navigated').toEqual([]);
        expect(await page.evaluate(() => performance.getEntriesByType('navigation').length)).toBe(1);
      },
      samples: () => page.evaluate(() => window.__rotationSamples),
    }));
}

/** Lets the resize and the frame after it happen. */
async function rotateTo(page, size) {
  await page.setViewportSize(size);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([size.width, size.height]);
}

/** The boxes of every visible in-dive control, as edges. */
function controlBoxes(page) {
  const selector = [
    '.wreck-topbar button',
    '[data-instructor-toggle]',
    '.wreck-controls button',
    '.wreck-dock button',
    '[data-torch]',
    '[data-fast-forward]',
    '[data-wreck-tanks] button',
  ].join(', ');
  return page.locator(selector).evaluateAll((elements) => elements
    .filter((el) => el.getClientRects().length > 0)
    .map((el) => {
      const r = el.getBoundingClientRect();
      const label = el.dataset.control ?? el.getAttribute('aria-label') ?? String(el.className);
      return { label, l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height };
    }));
}

async function expectControlsInside(page, size) {
  const found = await controlBoxes(page);
  expect(found.length, 'the controls are on screen').toBeGreaterThanOrEqual(6);
  // The bottom edge in portrait only: on a short landscape screen the D-pad
  // sits below the fold, which is #256's.
  const bottomLimit = size.height > size.width ? size.height + 0.5 : Infinity;
  const outside = found.filter((box) => box.l < -0.5 || box.t < -0.5 || box.r > size.width + 0.5 || box.b > bottomLimit);
  expect(outside, `controls inside the ${size.width}x${size.height} viewport`).toEqual([]);
  const small = found.filter((box) => box.w < MIN_TARGET_PX - 0.5 || box.h < MIN_TARGET_PX - 0.5);
  expect(small, 'every control is at least 44 px').toEqual([]);
}

/**
 * Depth never moves faster than the dive allows between two frames. A reset
 * or a jump shows as metres in one frame; the bound is generous (the dive
 * runs at a few times real time) and still far below a reset from 5 m.
 */
function expectDepthContinuous(samples, allowedDriftMPerS) {
  expect(samples.length, 'frames were sampled').toBeGreaterThan(30);
  const jumps = [];
  for (let i = 1; i < samples.length; i += 1) {
    const dt = (samples[i].t - samples[i - 1].t) / 1000;
    const dd = Math.abs(samples[i].depthM - samples[i - 1].depthM);
    // The HUD rounds to a tenth of a metre.
    if (dd > allowedDriftMPerS * dt + 0.15) jumps.push({ at: samples[i].t, from: samples[i - 1].depthM, to: samples[i].depthM, dt });
  }
  expect(jumps, 'depth between frames').toEqual([]);
}

for (const { portrait, landscape } of PAIRS) {
  test.describe(`rotating ${portrait.width}x${portrait.height} and ${landscape.width}x${landscape.height}`, () => {
    test.use({ ...PHONE, viewport: portrait });

    test('should keep the document, the clock, depth, torch and position when the phone turns four times', async ({ page }) => {
      await resumeStill(page, 'rec', 50);
      await expectControlsInside(page, portrait);
      // Torch off, so a reset to its default (on) would show.
      await page.keyboard.press('t');
      await expect(torch(page)).toHaveAttribute('aria-pressed', 'false');
      const watched = await watchDocument(page);
      const before = await nextSave(page);

      for (const size of [landscape, portrait, landscape, portrait]) {
        const clock = await hudValue(page, 'time').textContent();
        await rotateTo(page, size);
        await watched.sameDocument();
        await expect(torch(page)).toHaveAttribute('aria-pressed', 'false');
        // Not paused: the clock goes on, not stopped by the turn.
        await expect(hudValue(page, 'time')).not.toHaveText(clock, { timeout: 5_000 });
        await expectControlsInside(page, size);
        await expect(page.locator('[data-renderer=pixi] canvas')).toBeVisible();
      }

      // The dive is the same dive: the same safety stop under way, the same
      // depth, the diver where it was (it was not moved) and its clock on.
      const after = await nextSave(page);
      expect(after.state.elapsedTimeS, 'the dive clock advanced').toBeGreaterThan(before.state.elapsedTimeS);
      expect(after.state.depthM).toBeCloseTo(before.state.depthM, 0);
      expect(after.state.maxDepthM).toBe(before.state.maxDepthM);
      expect(after.routePositionM).toBeCloseTo(before.routePositionM, 6);
      expect(after.state.safetyStop.needed).toBe(true);
      // A neutral diver at 5 m drifts well under a metre in those seconds; a reset
      // is metres. The frame-to-frame record is the tighter check.
      expectDepthContinuous(await watched.samples(), 3);
      await watched.sameDocument();
    });

    test('should leave the dive paused and its dialog open when the help is open across a turn', async ({ page }) => {
      await resumeStill(page, 'rec', 50);
      const watched = await watchDocument(page);
      await page.keyboard.press('h');
      await expect(page.locator('[data-help-overlay]')).toBeVisible();
      const clock = await hudValue(page, 'time').textContent();

      for (const size of [landscape, portrait, landscape]) {
        await rotateTo(page, size);
        await expect(page.locator('[data-help-overlay]')).toBeVisible();
        await watched.sameDocument();
      }
      await page.waitForTimeout(1500);
      await expect(hudValue(page, 'time')).toHaveText(clock);

      await page.keyboard.press('Escape');
      await expect(page.locator('[data-help-overlay]')).toBeHidden();
      await expect(hudValue(page, 'time')).not.toHaveText(clock);
      await rotateTo(page, portrait);
      await expect(page.locator('[data-help-overlay]')).toBeHidden();
    });

    test('should keep the gas page and the instructor panel as they are across turns, open or closed', async ({ page }) => {
      // The gas pages are a rebreather's or a technical dive's.
      await resumeStill(page, 'ccr', 50);
      const pages = [['i', '[data-gas-info]'], ['l', '[data-instructor-panel]']];
      const all = pages.map(([, selector]) => selector);

      // Closed stays closed.
      await rotateTo(page, landscape);
      for (const selector of all) await expect(page.locator(selector)).toBeHidden();
      await rotateTo(page, portrait);
      for (const selector of all) await expect(page.locator(selector)).toBeHidden();

      for (const [key, selector] of pages) {
        await page.keyboard.press(key);
        await expect(page.locator(selector)).toBeVisible();
        const others = all.filter((other) => other !== selector);
        for (const size of [landscape, portrait, landscape, portrait]) {
          await rotateTo(page, size);
          await expect(page.locator(selector)).toBeVisible();
          // The rebreather's own buttons and Learn are on screen with it open.
          await expectControlsInside(page, size);
          // Only the page that was opened.
          for (const other of others) await expect(page.locator(other)).toBeHidden();
        }
        await page.keyboard.press(key);
        await expect(page.locator(selector)).toBeHidden();
        await rotateTo(page, landscape);
        await expect(page.locator(selector)).toBeHidden();
        await rotateTo(page, portrait);
      }
    });
  });
}

/**
 * A hand on the screen, sent as touch through the DevTools protocol, as
 * tests/touch-context.spec.js hand() does: the finger stays where it went
 * down while the page turns under it.
 */
async function finger(page) {
  const cdp = await page.context().newCDPSession(page);
  const send = (type, touchPoints) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
  let point = null;
  return {
    /** Puts the finger down; resolves to the time just before the touch is sent. */
    async down(locator) {
      const box = await locator.boundingBox();
      expect(box, 'the control has a box to touch').not.toBeNull();
      point = { x: box.x + box.width / 2, y: box.y + box.height / 2, id: 1 };
      const sentAt = Date.now();
      await send('touchStart', [point]);
      return sentAt;
    },
    async lift() {
      await send('touchEnd', []);
    },
    async cancel() {
      await send('touchCancel', []);
    },
  };
}

// What each direction changes in the model, read from the autosave: the
// route position for A and D, the BCD's gas for descend (the BCD's gas
// changes only with inflate and vent, as tests/page-lifecycle.spec.js reads
// it). Ascend has no reading of its effect, and is checked at its button
// alone: a diver who has inflated rises on without any input, and ends the
// dive on a rapid ascent within seconds, after which nothing is saved, so no
// reading after the turns could tell a held inflate from a let-go one.
//
// A reading that has hit its bound proves nothing: a diver stopped by the
// route's end or a hull holds still whether or not the direction is let go,
// and an empty BCD stops venting. `saturated` says so for a reading, and the
// case asserts it is not, while held and after the release.
// src/sites/wreck-route.ts ROUTE_MIN_POSITION_M and ROUTE_MAX_POSITION_M.
const ROUTE_MIN_POSITION_M = 8;
const ROUTE_MAX_POSITION_M = 106;
const offTheEnds = (position) => position > ROUTE_MIN_POSITION_M + 1 && position < ROUTE_MAX_POSITION_M - 1;
// A vent takes src/core/buoyancy.ts ventRate 0.75 x ambient pressure litres
// per dive second, and the dive runs three times real time (src/constants.js
// TIME_ACCELERATION = 3): 7.6 L per real second at the descend case's 3.39 bar
// (3.4 L at 5 m, which a hold of a second empties; hence the pinned start, see
// resumeStill). Its gas is read after the release. The hold afterwards is a
// fixed 1.2 s, and the reading must be well above `saturated`'s bound and
// above what the hold would have vented had the first turn let go of it.
const VENT_L_PER_REAL_S = 0.75 * 3.39 * 3;
const HOLD_AFTER_TURNS_MS = 1200;
const PAD = [
  // The left case starts aft, so that its 35 m or so of swimming ends far
  // from the route's min end; the right case starts at the middle.
  { control: 'left', startM: 80, read: (save) => save.routePositionM, saturated: (value) => !offTheEnds(value) },
  { control: 'right', startM: 50, read: (save) => save.routePositionM, saturated: (value) => !offTheEnds(value) },
  { control: 'ascend', startM: 50, read: null, saturated: null },
  { control: 'descend', startM: 50, vents: true, read: (save) => save.state.bcdGasSurfaceLiters, saturated: (value) => value <= 0.5 },
];

// Every direction on the larger pair; one horizontal and one vertical on the
// smaller, which keeps the spec to a few minutes.
const HELD_CASES = [
  ...PAD.map((entry) => ({ pair: PAIRS[0], ...entry })),
  ...PAD.filter((entry) => entry.control === 'right' || entry.control === 'ascend').map((entry) => ({ pair: PAIRS[1], ...entry })),
];

for (const { pair: { portrait, landscape }, control, startM, vents, read, saturated } of HELD_CASES) {
  for (const ending of ['lifted', 'cancelled']) {
    test.describe(`a ${control} held across a turn, ${portrait.width}x${portrait.height} and back`, () => {
      test.use({ ...PHONE, viewport: portrait });

      test(`should stay held through two turns and be let go when the touch is ${ending}`, async ({ page }) => {
        const startGas = await resumeStill(page, 'rec', startM, vents === true);
        const watched = await watchDocument(page);
        const touch = await finger(page);

        const downAt = await touch.down(pad(page, control));
        await expect(pad(page, control)).toHaveAttribute('data-held', 'true');
        await rotateTo(page, landscape);
        const firstTurnS = (Date.now() - downAt) / 1000;
        await rotateTo(page, portrait);
        await watched.sameDocument();

        // Still down after both turns: the model goes on acting on it. The
        // button's flag is the D-pad's own bookkeeping, which a turn that
        // cleared the controller's held set would leave showing.
        if (vents) {
          // Held on after the turns; the gas it vents is read after the release.
          await page.waitForTimeout(HOLD_AFTER_TURNS_MS);
        } else if (read !== null) {
          const mid1 = await nextSave(page);
          const mid2 = await nextSave(page);
          expect(saturated(read(mid1)) || saturated(read(mid2)), `${control} is not at a bound while held`).toBe(false);
          expect(Math.abs(read(mid2) - read(mid1)), `${control} acts between two autosaves, finger down`)
            .toBeGreaterThan(0.01);
          // And no faster than the diver can swim.
          if (control === 'left' || control === 'right') {
            const wallS = (mid2.savedAtEpochMs - mid1.savedAtEpochMs) / 1000;
            expect(Math.abs(read(mid2) - read(mid1))).toBeLessThanOrEqual(FIN_SPEED_MPS * wallS + 1);
          }
        }
        await expect(pad(page, control)).toHaveAttribute('data-held', 'true');

        const heldS = (Date.now() - downAt) / 1000;
        if (ending === 'lifted') await touch.lift();
        else await touch.cancel();
        await expect(pad(page, control)).not.toHaveAttribute('data-held', /.*/);
        if (read === null) {
          await rotateTo(page, landscape);
          await expect(pad(page, control)).not.toHaveAttribute('data-held', /.*/);
          await rotateTo(page, portrait);
          await expect(pad(page, control)).not.toHaveAttribute('data-held', /.*/);
          return;
        }
        // Let go: two autosaves agree, the first of them after the release,
        // and neither reading has run out, which would agree without it.
        const first = await nextSave(page);
        const second = await nextSave(page);
        expect(saturated(read(first)), `${control} is not at a bound at the release`).toBe(false);
        if (vents) {
          // It vented through the turns, not only up to the first: more than
          // the first turn's hold could have at the nominal rate, and a frame
          // (the model's 0.1 s cap) over. Timestamps are measured, not assumed.
          const vented = startGas - read(first);
          test.info().annotations.push({
            type: 'vent',
            description: `vented ${vented.toFixed(2)} L, hold ${heldS.toFixed(2)} s, first turn at ${firstTurnS.toFixed(2)} s, gas left ${read(first).toFixed(1)} L`,
          });
          expect(vented, `gas vented over a ${heldS} s hold, first turn done at ${firstTurnS} s`)
            .toBeGreaterThan(VENT_L_PER_REAL_S * (firstTurnS + 0.1));
        }
        expect(read(second), `${control} acts no more`).toBeCloseTo(read(first), 6);
        // And a rotation after the release does not hold it again.
        await rotateTo(page, landscape);
        await expect(pad(page, control)).not.toHaveAttribute('data-held', /.*/);
        const third = await nextSave(page);
        const fourth = await nextSave(page);
        expect(saturated(read(third))).toBe(false);
        expect(read(fourth)).toBeCloseTo(read(third), 6);
        await rotateTo(page, portrait);
        await expect(pad(page, control)).not.toHaveAttribute('data-held', /.*/);
      });
    });
  }
}
