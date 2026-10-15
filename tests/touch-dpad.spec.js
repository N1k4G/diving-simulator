const { expect, test } = require('./helpers/pinned-seed.cjs');
const {
  beginDescent,
  descendTo,
  startDiveAndWaitForCanvas,
  startDiveByTouch,
} = require('./helpers/start-dive.cjs');

// The touch D-pad (#168), PR 1 of its slicing: legacy's WASD cross
// (src/touch.js initNavPad and bindHold) as DOM over the Pixi stage, held
// from pointerdown to its release and driving the keyboard's intents.
//
// The first two cases port legacy's smoke tests "D-pad ascend
// pointerdown/pointerup does not stall the game" and "mobile click-through —
// no stuck keys" (tests/smoke.spec.js SMOKE-03 and SMOKE-04). Legacy could
// only check that its button lost the `active` class; the class is the
// button's own bookkeeping, and the key it drove could still be stuck. Here
// the dive itself is the witness: the BCD's gas, which only the inflate and
// vent intents change, is read from two consecutive autosaves after the
// release and must not move between them.
//
// Touch is real touch, sent through the DevTools protocol: a touchStart that
// stays down for as long as the test needs, then a touchEnd or a
// touchCancel. Chromium turns those into the pointer events a phone sends,
// pointercancel included, which Playwright's tap() cannot hold or cancel.

const SAVE_KEY = 'diving-simulator.save-game';

const PHONE = {
  hasTouch: true,
  isMobile: true,
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1',
};

const ORIENTATIONS = [
  { name: 'portrait', viewport: { width: 390, height: 844 } },
  { name: 'landscape', viewport: { width: 844, height: 390 } },
];

const DIRECTIONS = ['left', 'ascend', 'descend', 'right'];

const pad = (page, control) => page.locator(`.wreck-controls [data-control="${control}"]`);

function collectConsoleErrors(page) {
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(String(error)));
  return errors;
}

/** A finger held down on the middle of the element until the returned end() or cancel(). */
async function touchDown(page, locator, id = 1) {
  const box = await locator.boundingBox();
  expect(box, 'the control has a box to touch').not.toBeNull();
  const cdp = await page.context().newCDPSession(page);
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2, id };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  return {
    end: () => cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }),
    cancel: () => cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] }),
  };
}

/** The first autosave written after the page's clock reads `afterMs`. */
async function saveAfter(page, afterMs) {
  const handle = await page.waitForFunction(
    ({ key, after }) => {
      const raw = window.localStorage.getItem(key);
      const saved = raw === null ? null : JSON.parse(raw);
      return saved !== null && saved.savedAtEpochMs > after ? saved : null;
    },
    { key: SAVE_KEY, after: afterMs },
    { timeout: 15_000 },
  );
  return handle.jsonValue();
}

const pageNow = (page) => page.evaluate(() => Date.now());

/**
 * No direction is held: across two autosaves written after the release, the
 * BCD neither filled nor emptied. Returns the gas it holds.
 */
async function expectNothingHeld(page) {
  const first = await saveAfter(page, await pageNow(page));
  const second = await saveAfter(page, first.savedAtEpochMs);
  expect(second.state.bcdGasSurfaceLiters, 'the BCD moved with nothing held').toBe(
    first.state.bcdGasSurfaceLiters,
  );
  for (const control of DIRECTIONS) {
    await expect(pad(page, control), control).not.toHaveAttribute('data-held', /.*/);
  }
  return second.state.bcdGasSurfaceLiters;
}

/**
 * Holds ascend for a moment, then lets `release` end the hold. The BCD has
 * taken gas, and takes no more after. With `liftAfter`, the finger is still
 * down after the release and is lifted at the end: its pointerup must find
 * nothing left to let go of.
 *
 * The hold is short on purpose. The dive clock runs three times faster than
 * real time, and a few seconds of inflation is enough to start a runaway
 * ascent that ends the dive in barotrauma before the saves are read.
 */
async function holdAscendThen(page, release, { liftAfter = false } = {}) {
  const before = await expectNothingHeld(page);
  const ascend = pad(page, 'ascend');
  const finger = await touchDown(page, ascend);
  await expect(ascend).toHaveAttribute('data-held', 'true');
  await page.waitForTimeout(300);
  await release(finger);
  await expect(ascend).not.toHaveAttribute('data-held', /.*/);
  const after = await expectNothingHeld(page);
  expect(after, 'the held ascend inflated the BCD').toBeGreaterThan(before);
  if (liftAfter) {
    await finger.end();
    expect(await expectNothingHeld(page)).toBe(after);
  }
}

async function startDiveBelow(page, depthM) {
  await page.goto('/dist/');
  await page.evaluate(() => window.localStorage.clear());
  await startDiveAndWaitForCanvas(page);
  await descendTo(page, depthM);
}

/**
 * The #121 rule (tests/result-screen.spec.js) for the pad: every target at
 * least 44 x 44 and at least 8 px from its neighbours, and here also from
 * every other control on screen, overlap included — the #121 test skips
 * overlapping pairs, which would pass two buttons drawn on top of each other.
 * The fast-forward cell is shown for the measurement, as it is at a stop,
 * and hidden again in the same task, before a frame can draw it.
 */
async function measurePad(page) {
  return page.evaluate(() => {
    const fastForward = document.querySelector('[data-fast-forward]');
    const wasHidden = fastForward.hidden;
    fastForward.hidden = false;
    // Every visible control on the dive screen, and whether it is the pad's.
    const all = [...document.querySelectorAll('.wreck-shell button')]
      .filter((element) => element.getClientRects().length > 0)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          label: element.dataset.control ?? element.getAttribute('aria-label') ?? element.textContent,
          inPad: element.closest('.wreck-controls') !== null,
          x: rect.x,
          y: rect.y,
          w: rect.width,
          h: rect.height,
        };
      });
    fastForward.hidden = wasHidden;

    const viewport = { w: window.innerWidth, h: window.innerHeight };
    const padBoxes = all.filter((box) => box.inPad);
    const undersized = padBoxes
      .filter((box) => box.w < 44 || box.h < 44)
      .map((box) => `${box.label} is ${Math.round(box.w)}x${Math.round(box.h)}`);
    const offscreen = padBoxes
      .filter((box) => box.x < 0 || box.y < 0 || box.x + box.w > viewport.w || box.y + box.h > viewport.h)
      .map((box) => box.label);
    const tight = [];
    for (const a of padBoxes) {
      for (const b of all) {
        if (a === b || (b.inPad && all.indexOf(b) < all.indexOf(a))) continue;
        const gapX = Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w);
        const gapY = Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h);
        // Apart along either axis by 8 px is enough; a diagonal pair is
        // apart along both.
        if (Math.max(gapX, gapY) < 8) {
          tight.push(`${a.label} <-> ${b.label} = ${Math.max(gapX, gapY).toFixed(1)}px`);
        }
      }
    }
    return {
      padCount: padBoxes.length,
      labels: padBoxes.map((box) => box.label),
      undersized,
      offscreen,
      tight,
      right: Math.max(...padBoxes.map((box) => box.x + box.w)),
      bottom: Math.max(...padBoxes.map((box) => box.y + box.h)),
      viewport,
    };
  });
}

test('smoke: D-pad ascend pointerdown/pointerup does not stall the game', async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  await startDiveBelow(page, 5);

  const ascend = pad(page, 'ascend');
  await expect(ascend).toBeVisible();
  const before = await expectNothingHeld(page);
  const time = page.locator('.wreck-hud [data-hud-metric="time"] dd');
  const box = await ascend.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(ascend).toHaveAttribute('data-held', 'true');
  await page.waitForTimeout(500);
  await page.mouse.up();
  await expect(ascend).not.toHaveAttribute('data-held', /.*/);

  // The hold reached the dive, and nothing stays held after it.
  const after = await expectNothingHeld(page);
  expect(after).toBeGreaterThan(before);
  // The dive goes on.
  const clock = await time.textContent();
  await expect(time).not.toHaveText(clock || '');
  expect(consoleErrors, consoleErrors.join(' | ')).toEqual([]);
});

test('the pad names its keys on a desktop and keeps the actions as names', async ({ page }) => {
  // A desktop without a touch screen. Chromium exposes touch wherever the
  // host has a touch screen, as the Windows machines this runs on can, so the
  // two signals legacy's isTouchDevice reads are taken away before load.
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'maxTouchPoints', { configurable: true, get: () => 0 });
    for (const target of [window, Window.prototype]) delete target.ontouchstart;
  });
  await startDiveBelow(page, 1);
  expect(await page.evaluate(() => 'ontouchstart' in window || navigator.maxTouchPoints > 0)).toBe(false);
  const expected = {
    left: ['A', 'Fin left', 'A ArrowLeft'],
    ascend: ['W', 'Inflate the BCD (ascend)', 'W ArrowUp'],
    descend: ['S', 'Vent the BCD (descend)', 'S ArrowDown'],
    right: ['D', 'Fin right', 'D ArrowRight'],
  };
  for (const [control, [face, name, shortcuts]] of Object.entries(expected)) {
    await expect(pad(page, control)).toHaveText(face);
    await expect(pad(page, control)).toHaveAccessibleName(name);
    await expect(pad(page, control)).toHaveAttribute('aria-keyshortcuts', shortcuts);
  }
});

test.describe('in German, on a phone', () => {
  test.use({ ...PHONE, viewport: { width: 390, height: 844 }, locale: 'de-DE' });

  test('the pad shows arrows and German names', async ({ page }) => {
    await page.goto('/dist/');
    await page.evaluate(() => window.localStorage.clear());
    // The gate by its data attribute: its name is German here.
    await page.locator('[data-accept-safety]').click();
    await page.locator('.setup-screen').waitFor();
    await page.locator('[data-start-dive]').click();
    await page.locator('[data-renderer=pixi] canvas').waitFor();
    await beginDescent(page);
    const expected = {
      left: ['←', 'Nach links flossen'],
      ascend: ['↑', 'BCD aufblasen (aufsteigen)'],
      descend: ['↓', 'BCD ablassen (abtauchen)'],
      right: ['→', 'Nach rechts flossen'],
    };
    for (const [control, [face, name]] of Object.entries(expected)) {
      await expect(pad(page, control)).toHaveText(face);
      await expect(pad(page, control)).toHaveAccessibleName(name);
    }
  });
});

for (const { name, viewport } of ORIENTATIONS) {
  test.describe(`phone, ${name} ${viewport.width}x${viewport.height}`, () => {
    test.use({ ...PHONE, viewport });

    test('smoke: mobile click-through — start, descend, D-pad, no stuck input', async ({ page }) => {
      const consoleErrors = collectConsoleErrors(page);
      await page.goto('/dist/');
      await page.evaluate(() => window.localStorage.clear());
      await startDiveByTouch(page);
      await page.locator('[data-renderer=pixi] canvas').waitFor();

      // At the surface the pad is the one button, the descent: legacy's
      // touch-surface-btn, held as its bindKey held S.
      const prompt = page.locator('[data-surface-prompt]');
      await expect(prompt).toBeVisible();
      const descend = pad(page, 'descend');
      await expect(descend).toHaveText('↓');
      const descent = await touchDown(page, descend);
      await expect(prompt).toBeHidden();
      for (const control of DIRECTIONS) {
        await expect(pad(page, control), control).toBeVisible();
      }
      // Vented until well under, so the inflate below cannot lift the diver
      // back to the surface and end the dive.
      await page.waitForFunction(() => {
        const value = document.querySelector('.wreck-hud [data-hud-metric="depth"] dd');
        return Number.parseFloat(String(value?.textContent ?? '')) >= 4;
      }, undefined, { timeout: 60_000 });
      await descent.end();
      await expect(descend).not.toHaveAttribute('data-held', /.*/);

      await holdAscendThen(page, (finger) => finger.end());
      expect(consoleErrors, consoleErrors.join(' | ')).toEqual([]);
    });

    test('a cancelled touch releases the direction', async ({ page }) => {
      await startDiveBelow(page, 4);
      await holdAscendThen(page, (finger) => finger.cancel());
    });

    test('the window losing focus releases the direction', async ({ page }) => {
      await startDiveBelow(page, 4);
      await holdAscendThen(
        page,
        () => page.evaluate(() => window.dispatchEvent(new Event('blur'))),
        { liftAfter: true },
      );
    });

    test('the page being hidden releases the direction', async ({ page }) => {
      await startDiveBelow(page, 4);
      await holdAscendThen(page, () =>
        page.evaluate(() => {
          Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
          Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
          document.dispatchEvent(new Event('visibilitychange'));
          delete document.visibilityState;
          delete document.hidden;
          document.dispatchEvent(new Event('visibilitychange'));
        }),
        { liftAfter: true },
      );
    });

    test('every pad target meets 44px and stands 8px clear of every control', async ({ page }) => {
      await startDiveBelow(page, 1);
      await expect(pad(page, 'ascend')).toBeVisible();
      await expect(page.locator('[data-torch]')).toBeVisible();
      const geometry = await measurePad(page);
      // Four directions, the torch and the fast-forward cell.
      expect(geometry.padCount, geometry.labels.join(', ')).toBe(6);
      expect(geometry.undersized, geometry.undersized.join('\n')).toEqual([]);
      expect(geometry.offscreen, geometry.offscreen.join('\n')).toEqual([]);
      expect(geometry.tight, geometry.tight.join('\n')).toEqual([]);
    });

    test('the pad keeps clear of the safe-area insets', async ({ page }) => {
      await startDiveBelow(page, 1);
      // What Capacitor's SystemBars injects (#137 A7): a cutout on the right
      // in landscape, the home indicator at the bottom.
      const inset = { right: 47, bottom: 34 };
      await page.evaluate(({ right, bottom }) => {
        document.documentElement.style.setProperty('--safe-area-inset-right', `${right}px`);
        document.documentElement.style.setProperty('--safe-area-inset-bottom', `${bottom}px`);
      }, inset);
      const geometry = await measurePad(page);
      expect(geometry.right).toBeLessThanOrEqual(geometry.viewport.w - inset.right);
      expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewport.h - inset.bottom);
      expect(geometry.tight, geometry.tight.join('\n')).toEqual([]);
    });
  });
}

// The keyboard hint goes only where it collides with the HUD, on a phone held
// sideways (#168 pre-review pass 1). A short desktop window keeps it: there
// it is the only text naming T, F, [, ], B and I.
for (const [width, height, shown] of [[1280, 585, true], [844, 390, false]]) {
  test.describe(`a desktop window at ${width}x${height}`, () => {
    test.use({ viewport: { width, height } });

    test(`${shown ? 'keeps' : 'drops'} the keyboard hint`, async ({ page }) => {
      await startDiveBelow(page, 1);
      const hint = page.locator('.controls-hint');
      if (!shown) {
        await expect(hint).toBeHidden();
        return;
      }
      await expect(hint).toBeVisible();
      const hintBox = await hint.boundingBox();
      for (const control of DIRECTIONS) {
        const box = await pad(page, control).boundingBox();
        const gapX = Math.max(hintBox.x, box.x) - Math.min(hintBox.x + hintBox.width, box.x + box.width);
        const gapY = Math.max(hintBox.y, box.y) - Math.min(hintBox.y + hintBox.height, box.y + box.height);
        expect(Math.max(gapX, gapY), `the hint against ${control}`).toBeGreaterThanOrEqual(8);
      }
    });
  });
}

test.describe('the pad and the dive state', () => {
  test.use({ ...PHONE, viewport: { width: 390, height: 844 } });

  test('appears only once the dive has begun, except the descent that begins it', async ({ page }) => {
    await page.goto('/dist/');
    await page.evaluate(() => window.localStorage.clear());
    await expect(page.locator('.wreck-controls')).toHaveCount(0);
    await startDiveAndWaitForCanvas(page);
    await expect(pad(page, 'descend')).toBeVisible();
    for (const control of ['left', 'ascend', 'right']) {
      await expect(pad(page, control), control).toBeHidden();
    }
    await beginDescent(page);
    for (const control of DIRECTIONS) {
      await expect(pad(page, control), control).toBeVisible();
    }
  });
});
