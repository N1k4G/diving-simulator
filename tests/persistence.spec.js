const { expect, test } = require('./helpers/pinned-seed.cjs');
const { descendTo, startDiveAndWaitForCanvas } = require('./helpers/start-dive.cjs');

// The asynchronous persistence contract (#137 A4a). The save goes through
// the platform's asynchronous store, one write at a time, and the save
// pagehide writes is still in storage before the event returns.

const SAVE_KEY = 'diving-simulator.save-game';

/** The page's storage blocked, as a browser with site data off blocks it, as an init script. */
function blockStorage() {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    get: () => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    },
  });
}

test('pagehide writes the save inside the event, with nothing awaited', async ({ page }) => {
  await page.goto('/dist/');
  await startDiveAndWaitForCanvas(page);
  await descendTo(page, 2);
  const written = await page.evaluate((key) => {
    window.localStorage.removeItem(key);
    window.dispatchEvent(new PageTransitionEvent('pagehide'));
    return window.localStorage.getItem(key);
  }, SAVE_KEY);
  expect(written).not.toBeNull();
  expect(JSON.parse(written).state.depthM).toBeGreaterThan(1);
});

test('storage blocked: the gate, the setup, the language switch and the dive all still work', async ({ page }) => {
  await page.addInitScript(blockStorage);
  await page.goto('/dist/');
  await page.locator('[data-accept-safety]').click();
  await page.locator('.setup-screen').waitFor();
  // No save to offer, and the language switch still holds for this page.
  await expect(page.locator('[data-resume-continue]')).toHaveCount(0);
  await page.locator('[data-setup-locale]').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  await page.locator('[data-start-dive]').click();
  await page.locator('[data-renderer=pixi] canvas').waitFor();
  await descendTo(page, 2);
});
