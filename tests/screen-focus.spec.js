const { expect, test } = require('./helpers/pinned-seed.cjs');
const {
  acceptSafetyGate,
  beginDescent,
  descendTo,
  startDive,
  startDiveByKeyboard,
} = require('./helpers/start-dive.cjs');

// Focus follows the screen (#311). A screen that replaces another moves focus
// to its heading, as the game-over and debriefing screens do (#138): the
// control that had it is gone, and focus left on a removed element tells a
// keyboard or screen-reader user nothing. docs/decisions.md, departures
// table, the #311 row.

const SAVE_KEY = 'diving-simulator.save-game';

const LIVE = [
  '[aria-live]:not([aria-live="off"])',
  '[role=alert]',
  '[role=status]',
  '[role=log]',
  '[role=marquee]',
  '[role=timer]',
].join(', ');

test.beforeEach(async ({ page }) => {
  await page.goto('/dist/');
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
});

test('the setup screen takes focus on its heading after Accept, and keeps it across a redraw', async ({ page }) => {
  await acceptSafetyGate(page);
  const heading = page.locator('#setup-heading');
  await expect(heading).toHaveText('Plan your gas');
  await expect(heading).toBeFocused();

  // M redraws the whole screen; focus stays on the heading, and the screen's
  // keys reach it from there.
  await page.keyboard.press('m');
  await expect(page.locator('[data-setup-group=mode] [data-setup-option=tec]')).toBeChecked();
  await expect(heading).toBeFocused();

  // Not in the tab order: Tab goes on to the mode, the first control after it.
  await page.keyboard.press('Tab');
  await expect(page.locator('[data-setup-group=mode] [data-setup-option=tec]')).toBeFocused();
});

test('accepted by keyboard, the setup screen takes focus on its heading', async ({ page }) => {
  await page.locator('[data-accept-safety]').focus();
  await page.keyboard.press('Enter');
  await page.locator('.setup-screen').waitFor();
  await expect(page.locator('#setup-heading')).toBeFocused();
});

test('with a saved dive on offer, focus goes to its line and Tab reaches Resume next', async ({ page }) => {
  await startDive(page);
  await page.locator('[data-renderer=pixi] canvas').waitFor();
  await beginDescent(page);
  await page.waitForFunction((key) => {
    const raw = window.localStorage.getItem(key);
    return raw !== null && JSON.parse(raw).state.elapsedTimeS > 0;
  }, SAVE_KEY);

  await page.reload();
  await acceptSafetyGate(page);
  await expect(page.locator('#resume-banner-text')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('[data-resume-continue]')).toBeFocused();
});

test('the dive takes focus on its heading after Start, and the keyboard still drives it', async ({ page }) => {
  await startDive(page);
  await page.locator('[data-renderer=pixi] canvas').waitFor();
  const heading = page.locator('#wreck-title');
  await expect(heading).toBeFocused();

  // The dive's keys are read on the window: from the heading they still
  // begin the dive and move the diver.
  await beginDescent(page);
  await descendTo(page, 2);
  await expect(heading).toBeFocused();

  // Every movement key, pressed with focus on the heading, is taken by the
  // controller, which claims each with preventDefault(). This listener is
  // added after the controller's, so it sees the event once it is done.
  await page.evaluate(() => {
    window.__f311Keys = [];
    window.addEventListener('keydown', (event) => {
      window.__f311Keys.push({
        key: event.key,
        target: event.target instanceof HTMLElement ? event.target.id : null,
        taken: event.defaultPrevented,
      });
    });
  });
  const keys = ['w', 'a', 's', 'd', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight'];
  for (const key of keys) await page.keyboard.press(key);
  expect(await page.evaluate(() => window.__f311Keys)).toEqual(
    keys.map((key) => ({ key, target: 'wreck-title', taken: true })),
  );
});

test('started by keyboard, the dive takes focus on its heading', async ({ page }) => {
  await startDiveByKeyboard(page);
  await page.locator('[data-renderer=pixi] canvas').waitFor();
  await expect(page.locator('#wreck-title')).toBeFocused();
});

test('a site with no scene takes focus on its panel\'s heading, and Back on the setup\'s', async ({ page }) => {
  await acceptSafetyGate(page);
  await page.locator('[data-setup-group=site] [data-setup-option=cave]').check();
  await page.locator('[data-start-dive]').click();

  await expect(page.locator('[data-unavailable-site]')).toBeVisible();
  await expect(page.locator('#unavailable-site-heading')).toBeFocused();

  await page.locator('[data-back-to-setup]').click();
  await expect(page.locator('#setup-heading')).toBeFocused();
});

test('the start error takes focus on its heading and is no live region', async ({ page }) => {
  // The renderer's chunk fails to load, so the dive cannot start.
  await page.route('**/dist/assets/pixi-renderer-*', (route) => route.abort());
  await startDive(page);

  const error = page.locator('[data-start-error]');
  await expect(error).toBeVisible();
  const heading = page.locator('#start-error-heading');
  await expect(heading).toHaveText('The wreck preview could not start');
  await expect(heading).toBeFocused();
  // A screen, as the game over is: focus says it changed, not an alert.
  await expect(error.locator(LIVE)).toHaveCount(0);
  expect(await error.evaluate((el, sel) => el.closest(sel) !== null, LIVE)).toBe(false);
  await expect(error).toHaveAccessibleName('The wreck preview could not start');

  // Tab goes on to its one control.
  await page.keyboard.press('Tab');
  await expect(error.getByRole('button', { name: 'Reload and try again' })).toBeFocused();
});
