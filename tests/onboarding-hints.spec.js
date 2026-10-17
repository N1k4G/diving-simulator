const { expect, test } = require('./helpers/pinned-seed.cjs');
const { descendTo, startDiveAndWaitForCanvas } = require('./helpers/start-dive.cjs');

// The onboarding hints (#160): legacy's #38 toasts as a status region over
// the stage, each shown once per browser, for 6 s, hidden under the gas
// information and the help, and stopped for good by the help's "Don't show
// hints again". The triggers themselves are tested in
// src/app/onboarding-hints.test.ts; the BCD hint, the one every dive meets,
// stands for them here.

const BCD_EN = 'W/S control BCD buoyancy — short bursts, then trim out';
const BCD_DE = 'W/S steuern die Tarierweste — kurze Stöße, dann austrimmen';
const toast = (page) => page.locator('[data-onboarding-hint]');
const dismiss = (page) => page.locator('[data-help-overlay] [data-hint-dismiss]');
const flag = (page, key) => page.evaluate((k) => window.localStorage.getItem(k), key);

/** Counts the region's writes from now on: one per change, none per frame. */
async function countWrites(page) {
  await toast(page).evaluate((element) => {
    window.hintWrites = 0;
    new MutationObserver((records) => {
      window.hintWrites += records.length;
    }).observe(element, { childList: true, characterData: true, subtree: true });
  });
  return () => page.evaluate(() => window.hintWrites);
}

test('by keyboard: shown once past 2 m and announced once, hidden under the gas information and the help, then dismissed for good', async ({ page }) => {
  await page.goto('/dist/');
  await startDiveAndWaitForCanvas(page, (setup) => setup.locator('[data-setup-group=mode] [data-setup-option=tec]').check());
  await expect(toast(page)).toHaveAttribute('role', 'status');
  await expect(toast(page)).toHaveText('');
  const writes = await countWrites(page);

  await descendTo(page, 3);
  await expect(toast(page)).toHaveText(BCD_EN);
  expect(await flag(page, 'diveSim_hint_bcd')).toBe('1');
  // Written once, and not again while it shows.
  await page.waitForTimeout(1000);
  expect(await writes()).toBe(1);

  // Not drawn over the gas information, nor under the help, as legacy's.
  await page.keyboard.press('i');
  await expect(toast(page)).toHaveText('');
  await page.keyboard.press('Escape');
  await expect(toast(page)).toHaveText(BCD_EN);
  await page.keyboard.press('h');
  await expect(toast(page)).toHaveText('');
  await page.keyboard.press('Escape');
  await expect(toast(page)).toHaveText(BCD_EN);
  // Gone after its 6 s, and not shown again this dive.
  await expect(toast(page)).toHaveText('', { timeout: 10_000 });
  const settled = await writes();
  await page.waitForTimeout(1500);
  expect(await writes()).toBe(settled);

  // Tab from Close reaches the opt-out, and Enter takes it.
  await page.keyboard.press('h');
  await page.keyboard.press('Tab');
  await expect(dismiss(page)).toBeFocused();
  await expect(dismiss(page)).toHaveText('Don’t show hints again');
  await page.keyboard.press('Enter');
  await expect(dismiss(page)).toHaveCount(0);
  await expect(page.locator('[data-help-close]')).toBeFocused();
  expect(await flag(page, 'diveSim_hintsDone')).toBe('1');
  await page.keyboard.press('Escape');

  // The next visit, with the BCD hint unseen: the opt-out alone holds it back.
  await page.evaluate(() => window.localStorage.removeItem('diveSim_hint_bcd'));
  await page.reload();
  await startDiveAndWaitForCanvas(page);
  const after = await countWrites(page);
  await descendTo(page, 3);
  await page.waitForTimeout(1500);
  await expect(toast(page)).toHaveText('');
  expect(await after()).toBe(0);
  expect(await flag(page, 'diveSim_hint_bcd')).toBeNull();
  await page.keyboard.press('h');
  await expect(page.getByRole('dialog', { name: 'Controls' })).toBeVisible();
  await expect(dismiss(page)).toHaveCount(0);
});

const SAVE_KEY = 'diving-simulator.save-game';

/**
 * A dive in `mode` resumed at 9 m, neutral, its safety stop paused, so the
 * stop row shows (tests/in-dive-controls.spec.js resumeGermanAtPausedStop).
 * No hint has been seen: the BCD and safety-stop hints follow, 12 s of them.
 */
async function resumeAtPausedStop(page, mode) {
  await page.goto('/dist/');
  await page.locator('[data-accept-safety]').click();
  await page.locator(`[data-setup-group=mode] [data-setup-option=${mode}]`).check();
  await page.locator('[data-start-dive]').click();
  await page.locator('[data-renderer=pixi] canvas').waitFor();
  await descendTo(page, 1);
  const saved = await page
    .waitForFunction((key) => {
      const parsed = JSON.parse(window.localStorage.getItem(key) ?? 'null');
      return parsed !== null && parsed.state.elapsedTimeS > 0 ? parsed : null;
    }, SAVE_KEY)
    .then((handle) => handle.jsonValue());
  const pressureBar = 1 + 9 / 10;
  Object.assign(saved.state, {
    depthM: 9,
    maxDepthM: 20,
    verticalVelocityMpm: 0,
    bcdGasSurfaceLiters: (7 + 2 - 3 - 5 * Math.pow(1 / pressureBar, 0.7)) * pressureBar,
    safetyStop: { needed: true, countdownStarted: true, remainingS: 172, paused: true, complete: false },
  });
  await page.goto('/dist/');
  await page.evaluate(([key, value]) => window.localStorage.setItem(key, value), [SAVE_KEY, JSON.stringify(saved)]);
  await page.locator('[data-accept-safety]').click();
  await page.locator('[data-resume-continue]').click();
  await page.locator('[data-renderer=pixi] canvas').waitFor();
  await expect(page.locator('.wreck-hud [data-hud-metric="safetyStop"] dd')).toContainText('paused');
}

// Legacy draws its toast in drawScene() and its dive computer over it
// (src/game-loop.js gameLoop), so no hint ever hides a HUD row.
for (const mode of ['rec', 'ccr']) {
  test(`on a ${mode} dive with the stop row showing, every HUD row stays on top of the hint`, async ({ page }) => {
    test.setTimeout(120_000);
    await resumeAtPausedStop(page, mode);
    let overlapped = 0;
    for (const [width, height] of [[844, 390], [667, 375], [390, 844]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await expect(toast(page)).not.toHaveText('');
      const { covered, overlaps } = await page.evaluate(() => {
        // The hint takes no touch, so hit testing passes through it; for the
        // test it is made to take it, so elementFromPoint finds it if on top.
        const region = document.querySelector('[data-onboarding-hint]');
        region.style.pointerEvents = 'auto';
        const hint = region.getBoundingClientRect();
        const result = { covered: [], overlaps: 0 };
        for (const cell of document.querySelectorAll('.wreck-hud > div:not([hidden]) > :is(dt, dd)')) {
          const r = cell.getBoundingClientRect();
          if (r.width === 0 || r.bottom > window.innerHeight) continue;
          if (r.left < hint.right && hint.left < r.right && r.top < hint.bottom && hint.top < r.bottom) result.overlaps += 1;
          for (const x of [r.left + 2, r.left + r.width / 2, r.right - 2]) {
            const top = document.elementFromPoint(x, r.top + r.height / 2);
            if (!cell.contains(top)) result.covered.push(`${cell.parentElement.dataset.hudMetric} ${cell.tagName} at ${Math.round(x)}: ${top?.className}`);
          }
        }
        region.style.pointerEvents = '';
        return result;
      });
      expect(covered, `${width}x${height}`).toEqual([]);
      overlapped += overlaps;
    }
    // The hint does lie across HUD rows here, so the check above means something.
    expect(overlapped).toBeGreaterThan(0);
  });
}

test.describe('by touch, in German, on a phone', () => {
  test.use({ locale: 'de-DE', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('the D-pad takes the dive past 2 m, the hint shows, and the help\'s opt-out is a 44 px target that stops it', async ({ page }) => {
    await page.goto('/dist/');
    // The gate by its data attribute: its name is German here.
    await page.locator('[data-accept-safety]').tap();
    await page.locator('[data-start-dive]').tap();
    await page.locator('[data-renderer=pixi] canvas').waitFor();
    const descend = page.locator('.wreck-controls [data-control="descend"]');
    const box = await descend.boundingBox();
    const cdp = await page.context().newCDPSession(page);
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2, id: 1 };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    await expect(toast(page)).toHaveText(BCD_DE, { timeout: 60_000 });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

    await page.locator('[data-help-open]').tap();
    await expect(page.getByRole('dialog', { name: 'Steuerung' })).toBeVisible();
    await expect(toast(page)).toHaveText('');
    await expect(dismiss(page)).toHaveText('Hinweise nicht mehr anzeigen');
    // The #121 geometry: 44 px, and 8 px from Close and the rest.
    const boxes = await page.locator('[data-help-overlay] button').evaluateAll((buttons) =>
      buttons.map((el) => el.getBoundingClientRect()).map((r) => ({ x: r.x, y: r.y, w: r.width, h: r.height })));
    expect(boxes).toHaveLength(2);
    for (const b of boxes) expect(Math.min(b.w, b.h)).toBeGreaterThanOrEqual(44);
    await dismiss(page).scrollIntoViewIfNeeded();
    const [a, b] = await page.locator('[data-help-overlay] button').evaluateAll((buttons) =>
      buttons.map((el) => el.getBoundingClientRect()).map((r) => ({ top: r.top, bottom: r.bottom })));
    expect(Math.max(b.top - a.bottom, a.top - b.bottom)).toBeGreaterThanOrEqual(8);

    await dismiss(page).tap();
    await expect(dismiss(page)).toHaveCount(0);
    expect(await flag(page, 'diveSim_hintsDone')).toBe('1');
    await page.locator('[data-help-close]').tap();
    // The hint that was showing is gone with the opt-out.
    // Read at once: a wait could outlast its 6 s.
    await page.waitForTimeout(500);
    expect(await toast(page).textContent()).toBe('');
  });
});
