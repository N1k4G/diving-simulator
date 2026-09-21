const { expect, test } = require('@playwright/test');
const { startDive, startDiveAndWaitForCanvas } = require('./helpers/start-dive.cjs');

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
  Object.freeze({ kind: 'hold', key: 'ArrowDown', durationMs: 1250 }),
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
  await expect(page.getByRole('button', { name: 'Toggle torch' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('button', { name: 'Mute audio' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await page.getByRole('button', { name: 'Mute audio' }).click();
  await expect(page.getByRole('button', { name: 'Mute audio' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await page.getByRole('button', { name: 'Toggle torch' }).click();
  await expect(page.getByRole('button', { name: 'Toggle torch' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );

  const depthValue = page.locator('.wreck-hud dd').first();
  const initialDepth = await depthValue.textContent();
  await page.keyboard.down('ArrowDown');
  await page.waitForTimeout(1250);
  await page.keyboard.up('ArrowDown');
  await expect(depthValue).not.toHaveText(initialDepth || '');
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

test('persisted safety states produce visible semantic warnings', async ({ page }) => {
  await page.goto('/dist/');
  await startDiveAndWaitForCanvas(page);
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
  await page.reload();

  await mutateSavedState(page, 'failure');
  await startDive(page);
  await expect(page.getByRole('alert')).toHaveText(
    'Simulated dive failure — return to the surface',
  );
  await expect(chip).toHaveText('⚠ Dive failure');
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
    api.gameState = 'diving';
    api.setDepth(26);
    api.maxDepth = 26;
    api.diverX = 18;
    api.verticalVelocity = 0;
    api.torchOn = true;
    api.clearKeys();
  });
  const legacyBefore = await readLegacyObservation(page);
  await replayInputTrace(page, CROSS_CLIENT_TRACE);
  const legacyAfter = await readLegacyObservation(page);

  await page.goto('/dist/');
  await startDiveAndWaitForCanvas(page);
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
      tank.gasRemainingL = tank.volumeL * 40;
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
      await page.keyboard.down(step.key);
      await page.waitForTimeout(step.durationMs);
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
    torchOn:
      (await page
        .getByRole('button', { name: 'Toggle torch' })
        .getAttribute('aria-pressed')) === 'true',
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
