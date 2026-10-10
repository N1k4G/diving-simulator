const { expect, test } = require('@playwright/test');
const { descendTo, startDive, startDiveAndWaitForCanvas } = require('./helpers/start-dive.cjs');

// Mirrors smoke.spec.js's MOBILE_VIEWPORT: a hand-rolled touch viewport
// rather than Playwright's `devices['iPhone 12']`, which forbids overriding
// `defaultBrowserType` inside a describe group and would take us off the
// project's default browser (chromium). Width 390 sits well under the
// diagnostic.css `width <= 720px` breakpoint these tests exercise.
const MOBILE_VIEWPORT = {
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1',
};

/** "28.1 m" -> 28.1. Returns NaN for a placeholder such as the em dash. */
function parseMetres(text) {
  const match = /(-?\d+(?:\.\d+)?)/.exec(String(text ?? ''));
  return match ? Number(match[1]) : NaN;
}

const CROSS_CLIENT_TRACE = Object.freeze([
  // Held for frames worth 1.25 s of frame time, what the old 1250 ms hold
  // gave at 60 Hz (#239); replayInputTrace says why it counts frames.
  Object.freeze({ kind: 'hold', key: 'ArrowDown', frameTimeS: 1.25 }),
  Object.freeze({ kind: 'press', key: 't' }),
]);

test('wreck slice requires the simulation-use boundary before WebGL starts', async ({ page }) => {
  await page.goto('/dist/');

  await expect(
    page.getByRole('heading', {
      name: 'This is a simulation, not a dive planner',
    }),
  ).toBeVisible();
  await expect(page.locator('[data-wreck-viewport]')).toHaveCount(0);
  await expect(page.locator('canvas')).toHaveCount(0);
  await expect(
    page.getByRole('button', {
      name: 'I understand — start simulation',
    }),
  ).toBeVisible();
});

test('production starts the Pixi wreck shell with semantic HUD and controls', async ({ page }) => {
  await page.goto('/dist/?renderer=canvas');
  await startDive(page);

  const viewport = page.locator('[data-wreck-viewport]');
  await expect(viewport).toHaveAttribute('data-renderer', 'pixi');
  await expect(viewport.locator('canvas')).toBeVisible();
  await expect(page.getByText('Simulation running')).toBeVisible();
  await expect(page.getByText('Wreck exterior')).toBeVisible();
  // Legacy offers the torch only while diving (#223 Codex round 1): at the
  // surface the button is hidden and T does nothing.
  const torch = page.locator('[data-torch]');
  await expect(torch).toBeHidden();
  await expect(torch).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('t');
  await expect(torch).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Mute audio' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await page.getByRole('button', { name: 'Mute audio' }).click();
  await expect(page.getByRole('button', { name: 'Mute audio' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  const depthValue = page.locator('.wreck-hud dd').first();
  const initialDepth = await depthValue.textContent();
  await page.keyboard.down('ArrowDown');
  await page.waitForTimeout(1250);
  await page.keyboard.up('ArrowDown');
  await expect(depthValue).not.toHaveText(initialDepth || '');

  await expect(page.getByRole('button', { name: 'Toggle torch' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: 'Toggle torch' }).click();
  await expect(page.getByRole('button', { name: 'Toggle torch' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await expect(page.locator('[role="alert"]')).toBeHidden();

  // Compare like with like. Reading the HUD here and asserting the restored HUD
  // matches it raced the simulation: `pagehide` saves
  // controller.authoritativeState, which keeps moving after the frame the HUD
  // was painted from, so buoyancy momentum made the two differ by about a metre
  // (27 m read, 28.1 m restored) and failed roughly one full-suite run in two.
  //
  // The property worth testing is that restoration reproduces what was SAVED,
  // so read that back rather than a snapshot taken before the save happened.
  const depthBeforeReload = parseMetres(await depthValue.textContent());
  await page.reload();

  const savedDepthM = await page.evaluate(() => {
    const raw = localStorage.getItem('diving-simulator.save-game');
    return raw === null ? null : JSON.parse(raw).state.depthM;
  });
  expect(savedDepthM, 'the dive should have been persisted on pagehide').not.toBeNull();
  // The descent really happened, so restoration has something to prove.
  expect(savedDepthM).toBeGreaterThan(parseMetres(initialDepth));

  await startDive(page);
  const restored = page.locator('.wreck-hud dd').first();
  await expect(restored).toBeVisible();
  await expect
    .poll(async () => parseMetres(await restored.textContent()))
    .toBeCloseTo(savedDepthM, 0);
  // And it is the saved dive, not a fresh one at the starting depth.
  expect(Math.abs(savedDepthM - depthBeforeReload)).toBeLessThan(5);
});

// The dive starts at the surface and waits for S (#199, owner decision A):
// legacy's 'surface' state, src/game-loop.js updateSurface() and the
// "Press S to vent & descend" prompt of src/renderer.js drawSurface().
test('the dive starts at the surface and begins on S', async ({ page }) => {
  await page.goto('/dist/');
  await page.evaluate(() => window.localStorage.clear());
  await startDiveAndWaitForCanvas(page);

  const prompt = page.locator('[data-surface-prompt]');
  await expect(prompt).toBeVisible();
  await expect(prompt).toHaveText('At the surface. Press S or ↓ to vent and descend');
  const depth = page.locator('.wreck-hud [data-hud-metric="depth"] dd');
  const time = page.locator('.wreck-hud [data-hud-metric="time"] dd');
  await expect.poll(async () => parseMetres(await depth.textContent())).toBe(0);
  // The clock waits with the diver.
  const waitingTime = await time.textContent();
  await page.waitForTimeout(1500);
  await expect(time).toHaveText(waitingTime || '');
  // The forecast has long arrived by now, and at the surface it has no
  // limit: legacy draws "---" for the 999 sentinel, not a duration (#223
  // pre-review).
  await expect(page.locator('.wreck-hud [data-hud-metric="ndl"] dd')).toHaveText('—');
  // Legacy's surface offers one button, the descent; its nav pad and torch
  // appear only once the dive is under way (#223 Codex round 1).
  const pad = (control) => page.locator(`.wreck-controls [data-control="${control}"]`);
  await expect(pad('descend')).toBeVisible();
  for (const control of ['left', 'ascend', 'right']) {
    await expect(pad(control), control).toBeHidden();
  }
  await expect(page.locator('[data-torch]')).toBeHidden();

  await page.keyboard.down('s');
  await expect(prompt).toBeHidden();
  for (const control of ['left', 'ascend', 'descend', 'right']) {
    await expect(pad(control), control).toBeVisible();
  }
  await expect(page.locator('[data-torch]')).toBeVisible();
  await expect.poll(async () => parseMetres(await depth.textContent())).toBeGreaterThan(0);
  await page.keyboard.up('s');
  await expect(time).not.toHaveText(waitingTime || '');
});

// Legacy clears its save once a dive leaves 'diving' for its post-dive state,
// so a finished dive is never resumed (#223 pre-review). Before, the
// completed dive went on being saved and came back, frozen, on every start.
// The dive ends on the post-dive screen (#159), which tests/post-dive.spec.js
// covers.
test('a dive completed at the surface leaves no save, and the next start is a new dive', async ({ page }) => {
  // Every audio context the page opens, so the end of the dive can be shown
  // to close them: legacy is silent after the dive (#223 pre-review).
  await page.addInitScript(() => {
    const Native = window.AudioContext;
    window.__audioContexts = [];
    window.AudioContext = class extends Native {
      constructor(...args) {
        super(...args);
        window.__audioContexts.push(this);
      }
    };
  });
  await page.goto('/dist/');
  await page.evaluate(() => window.localStorage.clear());
  await startDiveAndWaitForCanvas(page);
  await descendTo(page, 1);
  const saved = await page
    .waitForFunction((key) => {
      const raw = window.localStorage.getItem(key);
      const parsed = raw === null ? null : JSON.parse(raw);
      return parsed !== null && parsed.state.elapsedTimeS > 0 ? parsed : null;
    }, 'diving-simulator.save-game')
    .then((handle) => handle.jsonValue());
  // A minute and a half into a 10 m dive, a metre down and slightly light:
  // it drifts up and surfaces gently, which ends the dive (slice 4b).
  Object.assign(saved.state, {
    elapsedTimeS: 90,
    depthM: 1,
    maxDepthM: 10,
    verticalVelocityMpm: 0,
    bcdGasSurfaceLiters: 3,
  });
  await page.goto('/dist/');
  await page.evaluate(
    (value) => window.localStorage.setItem('diving-simulator.save-game', value),
    JSON.stringify(saved),
  );
  await startDiveAndWaitForCanvas(page);

  await page.waitForFunction(
    () => window.localStorage.getItem('diving-simulator.save-game') === null,
    undefined,
    { timeout: 30_000 },
  );
  // The dive ends on the post-dive screen, legacy's 'post-dive' state, and
  // its view goes with it: no pad, no torch, no dive keys (#223 Codex round 1).
  await expect(page.locator('[data-post-dive]')).toBeVisible();
  await expect(page.locator('.wreck-shell')).toHaveCount(0);
  await expect(page.locator('[data-torch], [data-control]')).toHaveCount(0);
  // The dive's sound stops with it.
  await expect
    .poll(() =>
      page.evaluate(() => window.__audioContexts.map((context) => context.state)),
    )
    .toEqual(['closed']);
  // Leaving the page writes no save either.
  await page.reload();
  expect(await page.evaluate(() => window.localStorage.getItem('diving-simulator.save-game'))).toBeNull();

  await startDiveAndWaitForCanvas(page);
  await expect(page.locator('[data-surface-prompt]')).toBeVisible();
  await expect(page.locator('.wreck-hud [data-hud-metric="time"] dd')).toHaveText('0 sec');
});

test.describe('surface start by touch', () => {
  test.use(MOBILE_VIEWPORT);

  test('the prompt stays on a narrow layout, and the ↓ button begins the dive', async ({ page }) => {
    await page.goto('/dist/');
    await page.evaluate(() => window.localStorage.clear());
    await startDiveAndWaitForCanvas(page);
    const prompt = page.locator('[data-surface-prompt]');
    await expect(prompt).toBeVisible();

    const descend = page.locator('[data-control="descend"]');
    const box = await descend.boundingBox();
    expect(box).not.toBeNull();
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await expect(prompt).toBeHidden();
  });
});

test('persisted safety states produce visible semantic warnings', async ({ page }) => {
  await page.goto('/dist/');
  await startDiveAndWaitForCanvas(page);
  // A save of a dive under way, deep enough for pure oxygen to pass 1.6 bar:
  // the dive starts at the surface (#199), and the codec refuses gas drawn
  // from one still waiting there.
  await descendTo(page, 7);
  await page.reload();

  // Issue #138: the status chip has to say which state it is in, not just turn
  // red. Asserting it alongside the alert copy is what stops the two drifting
  // apart again — the original defect was exactly that they were set from the
  // same selection but three lines apart, and nothing checked the chip.
  const chip = page.locator('.status-chip');

  await mutateSavedState(page, 'low-gas');
  await startDive(page);
  await expect(page.getByRole('alert')).toHaveText(
    'Low gas pressure — begin a controlled exit',
  );
  await expect(chip).toHaveText('⚠ Low gas');
  await page.reload();

  await mutateSavedState(page, 'oxygen');
  await startDive(page);
  await expect(page.getByRole('alert')).toHaveText(
    'Unsafe simulated oxygen pressure',
  );
  await expect(chip).toHaveText('⚠ Oxygen warning');
  // The chip must never contradict the styling: red without a warning word is
  // the colour-only encoding #138 was filed about.
  await expect(page.locator('.wreck-shell')).toHaveClass(/has-warning/);

  // The status chip must not sit inside any live region.
  //
  // It is a visual redundancy for readers who cannot use the red styling; the
  // role=alert paragraph does the announcing. Two failure modes put the chip
  // into a live region and are both checked here against the EFFECTIVE
  // ancestry, i.e. what a screen reader actually resolves:
  //
  //   1. an explicit role/aria-live back on the chip itself — the obvious but
  //      wrong repair for the aria-label ARIA prohibits on role=paragraph;
  //   2. inheritance. aria-live applies from the nearest ancestor that sets
  //      it, and index.html used to wrap everything in <main id="app"
  //      aria-live="polite">, so updating the chip queued a polite
  //      announcement alongside the assertive alert — every warning spoken
  //      twice. That was a WP-02 bootstrap artifact (the diagnostic view it
  //      served renders static text once); removing it also stopped the
  //      per-frame depth/time/gas/NDL churn from being announced.
  //
  // closest() includes the chip itself and walks the real tree to <html>, so
  // one assertion covers both. The alert is a sibling inside the shell, not an
  // ancestor, so it is correctly not matched.
  const LIVE = [
    '[aria-live]:not([aria-live="off"])',
    '[role=alert]',
    '[role=status]',
    '[role=log]',
    '[role=marquee]',
    '[role=timer]',
  ].join(', ');
  const chipInLiveRegion = await chip.evaluate(
    (el, sel) => el.closest(sel) !== null,
    LIVE,
  );
  expect(chipInLiveRegion).toBe(false);

  // Pin the root fix directly so a regression names index.html, not just the
  // chip: #app must not reintroduce a live region over the whole HUD.
  await expect(page.locator('#app')).not.toHaveAttribute('aria-live', /.+/);

  // And the shell still declares exactly one live region of its own: the alert.
  await expect(
    page.locator('.wreck-shell').locator(LIVE),
  ).toHaveCount(1);

  // A failed dive ends on the game-over screen (#159), as legacy switches to
  // its game-over screen on the tick the dive fails. Its cause is stated in
  // words, and the screen is not a live region (#138): focus on its heading
  // is what tells a screen reader the screen changed.
  await page.reload();
  await mutateSavedState(page, 'failure');
  await startDive(page);
  await expect(page.locator('[data-game-over]')).toBeVisible();
  await expect(page.locator('[data-game-over-reason]')).toHaveText('Out of gas');
  await expect(page.locator('[data-game-over]').locator(LIVE)).toHaveCount(0);
  await expect(page.locator('#game-over-heading')).toBeFocused();
});

test.describe('mobile viewport', () => {
  test.use(MOBILE_VIEWPORT);

  test('#137 A15: the narrow HUD layout never hides NDL, and the mute button meets the touch-target minimum', async ({
    page,
  }) => {
    await page.goto('/dist/');
    await startDiveAndWaitForCanvas(page);

    // The narrow-layout media query used to hide the HUD's 4th metric, which
    // by construction order (depth/time/gas/ndl/zone) is NDL — a
    // safety-relevant readout that must never be the one dropped to make five
    // metrics fit a 12.5rem-wide box.
    //
    // Assert on identity, not position, on both sides of the rule. Checking
    // only that NDL survives would stay green if a reorder made the media
    // query hide gas or dive time instead — a different safety readout gone,
    // same defect. So: every safety-relevant metric visible, and the one
    // metric that may be dropped actually the one that is.
    const metric = (name) => page.locator(`.wreck-hud [data-hud-metric="${name}"]`);

    for (const name of ['depth', 'time', 'gas', 'ndl']) {
      await expect(metric(name), `${name} must stay visible on a narrow layout`).toBeVisible();
      // dd is the value element appendMetric() returns and updateHud() writes
      // to; toBeVisible catches display:none on an ancestor too.
      await expect(metric(name).locator('dd')).toBeVisible();
    }
    // Zone is orientation only, and is what the layout is allowed to drop.
    await expect(metric('zone')).toBeHidden();

    // The marker has to match the label, or the check above proves nothing:
    // a stray data-hud-metric="ndl" on the wrong row would satisfy it.
    await expect(metric('ndl').locator('dt')).toHaveText('No-decompression time');

    // The mute button was 2.3rem (~37px), under this project's 44px
    // touch-target standard (the class of defect #121 fixed in the legacy
    // client). Measure the live box rather than reading the CSS value, so a
    // change to font-size or padding that shrinks the box some other way is
    // still caught.
    const box = await page.locator('.audio-control').boundingBox();
    expect(box).not.toBeNull();
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  });
});

test('the same input trace drives equivalent legacy and Pixi control semantics', async ({ page }) => {
  await page.goto('/src/diving-simulator.html');
  await page.waitForFunction(() => Boolean(window.gameAPI));
  await page.evaluate(() => {
    const api = window.gameAPI;
    api.diveSite = 'wreck';
    api.resetDive();
    api.tanks.length = 0;
    api.tankCount = 0;
    api.pushTank(0.21, 0, 200);
    api.activeTank = 0;
    // Both clients start the dive at the surface and leave it on S or the
    // down arrow (#199): legacy's 'surface' state, updateSurface().
    api.gameState = 'surface';
    api.setDepth(0);
    api.maxDepth = 0;
    api.diverX = 10;
    api.verticalVelocity = 0;
    api.torchOn = true;
    api.clearKeys();
  });
  const legacyBefore = await readLegacyObservation(page);
  await replayInputTrace(page, CROSS_CLIENT_TRACE);
  const legacyAfter = await readLegacyObservation(page);

  await page.goto('/dist/');
  await startDiveAndWaitForCanvas(page);
  // The canvas can come before the dive's first frame. Until that frame the
  // depth reads the unavailable mark, and the hold below vents over fewer
  // frames: on a loaded machine the diver then had not left 0 m when read.
  await expect(page.locator('.wreck-hud [data-hud-metric="depth"] dd')).toHaveText(/\d/);
  const pixiBefore = await readPixiObservation(page);
  await replayInputTrace(page, CROSS_CLIENT_TRACE);
  const pixiAfter = await readPixiObservation(page);

  expect(normalizeControlResponse(legacyBefore, legacyAfter)).toEqual({
    verticalDirection: 'deeper',
    torchToggled: true,
  });
  expect(normalizeControlResponse(pixiBefore, pixiAfter)).toEqual(
    normalizeControlResponse(legacyBefore, legacyAfter),
  );
});

async function mutateSavedState(page, variant) {
  await page.evaluate(selectedVariant => {
    const key = 'diving-simulator.save-game';
    const raw = localStorage.getItem(key);
    if (!raw) throw new Error('expected the wreck save to exist');
    const save = JSON.parse(raw);
    const tank = save.state.tanks[save.state.activeTankIndex];

    if (selectedVariant === 'low-gas') {
      // Under legacy's 30 bar; 30 to 50 is its reserve (#228).
      tank.gasRemainingL = tank.volumeL * 20;
    } else if (selectedVariant === 'oxygen') {
      tank.gas.oxygenFraction = 1;
      tank.gas.heliumFraction = 0;
      tank.gas.nitrogenFraction = 0;
    } else if (selectedVariant === 'failure') {
      save.state.failure.reason = 'out-of-gas';
      save.state.events.push({
        type: 'failure',
        elapsedTimeS: save.state.elapsedTimeS,
        failureReason: 'out-of-gas',
      });
    }
    localStorage.setItem(key, JSON.stringify(save));
  }, variant);
}

async function replayInputTrace(page, trace) {
  for (const step of trace) {
    if (step.kind === 'hold') {
      // #239. This used to hold for 1250 ms of wall time, and failed about
      // every other full run under load, reading the diver as 'stationary'.
      // Both clients advance per frame, by that frame's real time capped at
      // 0.1 s:
      //
      //   legacy  game-loop.js gameLoop()   dtReal = Math.min(dtReal, 0.1)
      //   pixi    game-controller.ts #tick  Math.min(MAX_FRAME_SECONDS, ...)
      //
      // A loaded machine delivers few frames in 1250 ms, and a frame that
      // comes later than 0.1 s advances the dive by only 0.1 s, so the hold
      // gave the dive less time than on an idle machine. Leaving the surface
      // starts by venting the BCD, and the depth change stayed under
      // normalizeControlResponse's 0.02 m.
      //
      // So the hold waits for frames in the page and adds up what each one
      // gives the dive: the interval between rAF timestamps, capped as both
      // clients cap it. Their own frame loops get the same timestamps, so
      // the dive gets at least frameTimeS of frame time, whatever the load.
      // Waiting for rAF rather than a millisecond count is the press's
      // reasoning below, and rAF is the browser's, so the trace stays
      // client-agnostic.
      //
      // Not a fixed number of frames: 75 frames are 1.25 s at 60 Hz, but
      // the Pixi client measured 3 to 7 frames per second with eight
      // workers next to a unit test run, so 75 frames held for 10 to 23 s
      // and one of ten runs hit the 60 s test timeout. Past the cap, frame
      // time is what the dive gets, so it is what the hold should count.
      await page.keyboard.down(step.key);
      await waitForFrameTime(page, step.frameTimeS);
      await page.keyboard.up(step.key);
    } else {
      // #175. This used to be page.keyboard.press(), whose default delay
      // between keydown and keyup is 0 ms — and the two clients do not read a
      // key the same way:
      //
      //   legacy  game-loop.js:402  polls keys['t'] in the frame loop, so the
      //                             key has to be down DURING a frame
      //   pixi    game-controller.ts:260  handles keydown directly, so any
      //                             press works however brief
      //
      // A zero-length press is therefore an input only one of the two clients
      // can observe, which made this comparison fail whenever no frame
      // happened to run between the two events. Measured on the legacy client,
      // torch on, differing only in whether a frame elapsed:
      //
      //   keydown + keyup in one evaluate()   -> torchOn stayed true  (missed)
      //   the same with two rAFs between      -> torchOn became false (seen)
      //
      // So hold the key across a frame. Waiting for rAF rather than for a
      // millisecond count is deliberate: a fixed delay is a guess that a
      // loaded machine can still beat, while a frame having elapsed is the
      // actual precondition. rAF is the browser's, not either client's, so the
      // trace stays client-agnostic.
      //
      // The release waits for a frame too. Measured, so as not to oversell it:
      // two consecutive presses toggle twice either way, because the CDP round
      // trips between keyboard.up and the next keyboard.down already leave
      // room for a frame. So this is not fixing an observed defect.
      //
      // It is here because the edge detector also needs tDown to read false
      // during a frame before it can see the NEXT rising edge, and without
      // this line that only holds by incidental timing — which is exactly the
      // kind of accident that produced the bug above. Making the release an
      // explicit guarantee costs one frame and removes the trap from whoever
      // extends this trace later.
      await page.keyboard.down(step.key);
      await waitForAnimationFrames(page, 2);
      await page.keyboard.up(step.key);
      await waitForAnimationFrames(page, 2);
    }
  }
  await page.waitForTimeout(150);
}

/**
 * Both clients advance the dive per frame by the time since the last frame,
 * capped: src/game-loop.js gameLoop() `Math.min(dtReal, 0.1)`,
 * src/app/game-controller.ts MAX_FRAME_SECONDS.
 */
const MAX_FRAME_SECONDS = 0.1;

/** Resolves once the frames since the call add up to `seconds` of capped frame time. */
function waitForFrameTime(page, seconds) {
  return page.evaluate(
    ({ target, cap }) =>
      new Promise((resolve) => {
        let previousMs = null;
        let frameTimeS = 0;
        const tick = (nowMs) => {
          if (previousMs !== null) {
            frameTimeS += Math.min(cap, (nowMs - previousMs) / 1000);
          }
          previousMs = nowMs;
          if (frameTimeS >= target) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    { target: seconds, cap: MAX_FRAME_SECONDS },
  );
}

function waitForAnimationFrames(page, count) {
  return page.evaluate(
    (frames) =>
      new Promise((resolve) => {
        let remaining = frames;
        const tick = () => {
          remaining -= 1;
          if (remaining <= 0) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    count,
  );
}

async function readLegacyObservation(page) {
  return page.evaluate(() => ({
    depthM: window.gameAPI.depth,
    torchOn: window.gameAPI.torchOn,
  }));
}

async function readPixiObservation(page) {
  const depthText = await page.locator('.wreck-hud dd').first().textContent();
  return {
    depthM: Number.parseFloat((depthText || '').replace(',', '.')),
    // By its data attribute, not its role: at the surface the button is
    // hidden (#223 Codex round 1), and getByRole skips hidden elements.
    torchOn: (await page.locator('[data-torch]').getAttribute('aria-pressed')) === 'true',
  };
}

function normalizeControlResponse(before, after) {
  const depthDeltaM = after.depthM - before.depthM;
  return {
    verticalDirection:
      depthDeltaM < -0.02
        ? 'shallower'
        : depthDeltaM > 0.02
          ? 'deeper'
          : 'stationary',
    torchToggled: after.torchOn !== before.torchOn,
  };
}
