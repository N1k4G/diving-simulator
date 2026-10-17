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
