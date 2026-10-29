const { expect, test } = require('./helpers/pinned-seed.cjs');
const { descendTo, startDiveAndWaitForCanvas } = require('./helpers/start-dive.cjs');

// The asynchronous persistence contract (#137 A4a). The save goes through
// the platform's asynchronous store, one write at a time; where the store
// refuses it, or cannot be read at all, the dive says it is not being saved.
// Legacy says nothing when its save fails (src/game-loop.js 1581).

const SAVE_KEY = 'diving-simulator.save-game';
const notice = (page) => page.locator('[data-persistence-notice]');
const NOT_SAVING_EN = 'Not saving: storage is unavailable or full. If you leave, this dive cannot be resumed.';
const NOT_SAVING_DE = 'Speichern nicht möglich: Der Speicher ist nicht verfügbar oder voll. Wenn du gehst, lässt sich dieser Tauchgang nicht fortsetzen.';

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

test('storage blocked: the gate and the setup still open, and the dive says it is not saved, in either language', async ({ page }) => {
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

  // A status region, there from the start and written once the dive runs.
  await expect(notice(page)).toHaveAttribute('role', 'status');
  await expect(notice(page)).toHaveText(NOT_SAVING_DE);
  await expect(notice(page)).toBeVisible();
  // The dive runs on regardless.
  await descendTo(page, 2);
  await expect(notice(page)).toHaveText(NOT_SAVING_DE);
});

test('a save the store refuses mid-dive shows the notice in English; a save taken again clears it', async ({ page }) => {
  await page.goto('/dist/');
  await page.evaluate(() => window.localStorage.clear());
  await startDiveAndWaitForCanvas(page);
  await descendTo(page, 2);
  await expect(notice(page)).toHaveText('');
  await expect(notice(page)).toHaveAttribute('role', 'status');

  // A full quota: every write refused, as Storage.setItem throws then.
  await page.evaluate(() => {
    window.__setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function refuse() {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    };
  });
  // The next autosave, within its 3 s.
  await expect(notice(page)).toHaveText(NOT_SAVING_EN, { timeout: 10_000 });
  await expect(notice(page)).toBeVisible();

  await page.evaluate(() => {
    Storage.prototype.setItem = window.__setItem;
    window.localStorage.removeItem('diving-simulator.save-game');
  });
  await expect(notice(page)).toHaveText('', { timeout: 10_000 });
  await expect(notice(page)).toBeHidden();
  expect(await page.evaluate((key) => window.localStorage.getItem(key), SAVE_KEY)).not.toBeNull();
});
