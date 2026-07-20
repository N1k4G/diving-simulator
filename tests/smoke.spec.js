// ============================================================
// FILE: tests/smoke.spec.js
// PURPOSE: Real-browser smoke tests for the actual game page
//          (src/diving-simulator.html). Complements game.spec.js,
//          which only exercises the internal test harness in an
//          iframe.
//
// SCOPE (issue #16): these cover the "echte Browser-/Input-Smoke-Tests"
// section — the app shell, DOM buttons, and keyboard/pointer input plumbing.
// They do NOT assert any of the still-open CCR runtime or setup-keyboard
// behaviour; those regression tests are intentionally left to land with
// their respective bugfix PRs (#4, #5, #6, #8, #9, #25, #26/#71, #50, #51).
// ============================================================

const { test, expect } = require('@playwright/test');

// Mobile emulation config. We deliberately do NOT spread devices['iPhone 12']
// because it sets defaultBrowserType: 'webkit', which Playwright forbids
// inside a describe group. A hand-rolled touch viewport keeps us on the
// project's default browser (chromium) while still exercising the
// isTouchDevice branch of touch.js.
const MOBILE_VIEWPORT = {
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1',
};

/**
 * Common bootstrap: navigate to the game page, wire up console-error capture,
 * and wait for window.gameAPI to become available.
 *
 * Returns an array that accumulates any console-error / pageerror messages
 * observed during the test. Assert this is empty at the end of each test.
 */
async function bootGame(page) {
  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', err => consoleErrors.push(err.message));
  // Defensive: dismiss any "resume dive?" confirm() if a saved dive somehow
  // survives across tests. Playwright default contexts are isolated so this
  // should never actually fire, but the handler keeps the suite unblocked.
  page.on('dialog', d => d.dismiss().catch(() => {}));

  await page.goto('/src/diving-simulator.html');
  await page.waitForFunction(() => !!window.gameAPI, { timeout: 15000 });
  return consoleErrors;
}

/**
 * Drive setup -> surface -> diving and teleport to a comfortable depth.
 *
 * The surface -> diving transition is driven by a genuine held keyboard 's'
 * so the input pipeline is exercised end-to-end. Once diving, we teleport
 * to `targetDepth` via gameAPI.setDepth() — the internal harness uses the
 * same trick, and it keeps the subsequent hold/release tests fast and
 * independent of buoyancy-tuning quirks that may still be in flux.
 */
async function reachDivingUnderwater(page, targetDepth = 5) {
  // Start dive deterministically (avoid the RAF race that plagues plain
  // page.keyboard.press('Enter')). This is the same entry point used by
  // the Enter key and the "Start Dive" DOM button, so no coverage is lost.
  await page.evaluate(() => window.gameAPI.startDiveAction());
  await page.waitForFunction(() => window.gameAPI.gameState === 'surface', { timeout: 5000 });

  // Hold "s" to descend. Held until updateSurface() flips the state.
  await page.keyboard.down('s');
  await page.waitForFunction(() => window.gameAPI.gameState === 'diving', { timeout: 5000 });
  await page.keyboard.up('s');

  // Teleport to a stable depth so subsequent tests have something concrete.
  await page.evaluate(d => window.gameAPI.setDepth(d), targetDepth);
  await page.waitForFunction(
    d => window.gameAPI.depth >= d - 0.1,
    targetDepth,
    { timeout: 3000 }
  );
}

// -----------------------------------------------------------------
// SMOKE-01: Page loads cleanly, gameAPI is exposed, initial state ok.
// -----------------------------------------------------------------
test('smoke: page loads without console errors and exposes gameAPI', async ({ page }) => {
  const consoleErrors = await bootGame(page);

  // Canvas is present and sized.
  const canvasBox = await page.locator('#c').boundingBox();
  expect(canvasBox).not.toBeNull();
  expect(canvasBox.width).toBeGreaterThan(0);
  expect(canvasBox.height).toBeGreaterThan(0);

  // Initial state is the gas-setup screen and the HTML setup overlay is visible.
  const initialState = await page.evaluate(() => window.gameAPI.gameState);
  expect(initialState).toBe('gas-setup');

  const setupVisible = await page.evaluate(() => {
    const el = document.getElementById('html-gas-setup');
    return el && getComputedStyle(el).display !== 'none';
  });
  expect(setupVisible).toBe(true);

  // Let the game render a handful of frames — catches any renderer error that
  // only fires from inside gameLoop(). 200ms is well over 10 frames at 60fps.
  await page.waitForTimeout(200);

  expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
});

// -----------------------------------------------------------------
// SMOKE-02: Keyboard drives setup -> surface -> diving; hold/release
//           a movement key without crashes or console errors.
// -----------------------------------------------------------------
test('smoke: keyboard setup->surface->diving flow, ascend hold/release is clean', async ({ page }) => {
  const consoleErrors = await bootGame(page);
  await reachDivingUnderwater(page, 5);

  const depthBefore = await page.evaluate(() => window.gameAPI.depth);

  // Hold "w" (ascend) briefly and then release. The BCD/velocity model needs a
  // moment to react so we hold for ~600ms — enough to exercise the input path
  // in updateDiving() across many frames.
  await page.keyboard.down('w');
  await page.waitForTimeout(600);
  await page.keyboard.up('w');

  // After release, the game must remain alive (no crash, no game over from a
  // short hold). We do NOT assert a specific verticalVelocity — that depends
  // on physics tuning that other issues may still be fixing.
  await page.waitForTimeout(200);
  const state = await page.evaluate(() => window.gameAPI.gameState);
  expect(['diving', 'surface', 'post-dive']).toContain(state);

  // Sanity: depth should have moved SOMEWHERE during the hold (not stuck).
  // A ~9 m/min ascent = 0.15 m/s → 0.09 m over 600ms; use a generous 0.02 m
  // change threshold to avoid flakiness from BCD lag.
  const depthAfter = await page.evaluate(() => window.gameAPI.depth);
  expect(Math.abs(depthAfter - depthBefore)).toBeGreaterThan(0.02);

  expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
});

// -----------------------------------------------------------------
// SMOKE-03: D-pad ascend button — pointerdown/pointerup drives the same key
//           path as the keyboard, and the diver keeps running afterwards.
// -----------------------------------------------------------------
test('smoke: D-pad ascend pointerdown/pointerup does not stall the game', async ({ page }) => {
  const consoleErrors = await bootGame(page);
  await reachDivingUnderwater(page, 5);

  // The nav D-pad is bound via pointer events in touch.js#bindHold. We drive
  // pointerdown/pointerup directly via dispatchEvent so the test is agnostic
  // to the exact pointer type Playwright emits by default.
  const ascend = page.locator('#touch-dive-ascend');
  await expect(ascend).toBeVisible();

  await ascend.dispatchEvent('pointerdown');
  await page.waitForTimeout(500);
  await ascend.dispatchEvent('pointerup');

  // After release the button must lose its "active" class — this is the
  // outward signal that bindHold's release handler fired. Also confirms
  // no stuck-key state on the D-pad path.
  await page.waitForTimeout(100);
  const classes = await ascend.getAttribute('class');
  expect(classes || '').not.toContain('active');

  // Game keeps running.
  const state = await page.evaluate(() => window.gameAPI.gameState);
  expect(['diving', 'surface', 'post-dive']).toContain(state);

  expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
});

// -----------------------------------------------------------------
// SMOKE-04: Mobile-emulation click-through of the main flow buttons.
//           Uses a touch-enabled iPhone-ish viewport so the isTouchDevice
//           branch of touch.js is exercised (touchstart / bindKey / bindTap).
// -----------------------------------------------------------------
test.describe('mobile viewport', () => {
  test.use(MOBILE_VIEWPORT);

  test('smoke: mobile click-through — Start Dive, descend, D-pad, no stuck keys', async ({ page }) => {
    const consoleErrors = await bootGame(page);

    // Tap the "Start Dive" button in the HTML gas-setup overlay. Two buttons
    // share the .gs-accent class (OC and CCR variants); only the mode-active
    // one is rendered visible. Scan for the visible instance — ordering is
    // not stable enough to rely on nth().
    const candidates = page.locator('#html-gas-setup .gs-accent');
    const count = await candidates.count();
    let startBtn = null;
    for (let i = 0; i < count; i++) {
      if (await candidates.nth(i).isVisible()) {
        startBtn = candidates.nth(i);
        break;
      }
    }
    expect(startBtn, 'expected exactly one visible .gs-accent start button').not.toBeNull();
    await startBtn.tap();
    await page.waitForFunction(() => window.gameAPI.gameState === 'surface', { timeout: 5000 });

    // On the surface, the touch surface button descends (bindKey → 's' key).
    // A plain tap fires touchstart+touchend so quickly that no frame runs
    // between them, so we dispatch a real held press: touchstart, wait, touchend.
    const surfaceBtn = page.locator('#touch-surface-btn');
    await expect(surfaceBtn).toBeVisible();
    await surfaceBtn.dispatchEvent('touchstart');
    // Frame budget: give updateSurface() a few ticks to observe keys.s=true.
    await page.waitForFunction(() => window.gameAPI.gameState === 'diving', { timeout: 5000 });
    await surfaceBtn.dispatchEvent('touchend');

    // Sanity check: the D-pad is visible during diving.
    const ascend = page.locator('#touch-dive-ascend');
    await expect(ascend).toBeVisible();
    // Hold + release via pointer events; a plain tap has the same touchstart+
    // touchend race, so we explicitly hold across frames.
    await ascend.dispatchEvent('pointerdown');
    await page.waitForTimeout(200);
    await ascend.dispatchEvent('pointerup');

    // The D-pad button must not remain in its "active" state (no stuck key).
    await page.waitForTimeout(100);
    const classes = await ascend.getAttribute('class');
    expect(classes || '').not.toContain('active');

    // Game is still alive.
    const state = await page.evaluate(() => window.gameAPI.gameState);
    expect(['diving', 'surface']).toContain(state);

    expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
  });

  test('smoke: mobile CCR mode selector tap flips diveMode to ccr', async ({ page }) => {
    const consoleErrors = await bootGame(page);

    // Switch to CCR mode via the HTML mode selector chip. Wait for the
    // dynamically-built button (touch.js/ui.js render it after the first frame).
    const ccrBtn = page.locator('#html-gas-setup [data-mode="ccr"]');
    await expect(ccrBtn).toBeVisible({ timeout: 5000 });
    await ccrBtn.tap();

    await page.waitForFunction(() => window.gameAPI.diveMode === 'ccr', { timeout: 5000 });

    // Setup is still up; no crash.
    const state = await page.evaluate(() => window.gameAPI.gameState);
    expect(state).toBe('gas-setup');

    expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
  });
});
