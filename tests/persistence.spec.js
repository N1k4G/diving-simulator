const { expect, test } = require('./helpers/pinned-seed.cjs');
const { descendTo, startDiveAndWaitForCanvas } = require('./helpers/start-dive.cjs');

// The asynchronous persistence contract (#137 A4a). The save goes through
// the platform's asynchronous store, one write at a time; where the store
// refuses it, or cannot be read at all, the dive says it is not being saved.
// Legacy says nothing when its save fails (src/game-loop.js 1581).

const SAVE_KEY = 'diving-simulator.save-game';
const notice = (page) => page.locator('[data-persistence-notice]');
/** The sentence, what the region announces; its opening words stand alone on small screens. */
const sentence = (page) => notice(page).locator('.persistence-notice-full');
const opening = (page) => notice(page).locator('.persistence-notice-short');
const NOT_SAVING_EN = 'Not saving: storage is unavailable or full. If you leave, progress since the last save will be lost.';
const NOT_SAVING_DE = 'Speichern nicht möglich: Der Speicher ist nicht verfügbar oder voll. Wenn du gehst, geht der Fortschritt seit dem letzten Speichern verloren.';

/** Which form the eye sees: the sentence, its opening words alone, or nothing. */
const shownForm = (page) =>
  page.evaluate(() => {
    const laidOut = (selector) => {
      const element = document.querySelector(`[data-persistence-notice] ${selector}`);
      return element !== null && element.getBoundingClientRect().width > 1;
    };
    if (laidOut('.persistence-notice-full')) return 'sentence';
    return laidOut('.persistence-notice-short') ? 'opening' : '';
  });

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
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator('[data-start-dive]').click();
  await page.locator('[data-renderer=pixi] canvas').waitFor();

  // A status region, there from the start and written once the dive runs.
  await expect(notice(page)).toHaveAttribute('role', 'status');
  await expect(sentence(page)).toHaveText(NOT_SAVING_DE);
  expect(await shownForm(page)).toBe('sentence');
  // The short form is for the eye alone, shown where the sentence does not fit.
  await expect(opening(page)).toHaveAttribute('aria-hidden', 'true');
  await expect(opening(page)).toBeHidden();
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect.poll(() => shownForm(page)).toBe('opening');
  // The dive runs on regardless.
  await descendTo(page, 2);
  await expect(sentence(page)).toHaveText(NOT_SAVING_DE);
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
  await expect(sentence(page)).toHaveText(NOT_SAVING_EN, { timeout: 10_000 });
  expect(await shownForm(page)).toBe('opening');

  await page.evaluate(() => {
    Storage.prototype.setItem = window.__setItem;
    window.localStorage.removeItem('diving-simulator.save-game');
  });
  await expect(notice(page)).toHaveText('', { timeout: 10_000 });
  await expect(notice(page)).toBeHidden();
  expect(await page.evaluate((key) => window.localStorage.getItem(key), SAVE_KEY)).not.toBeNull();
});

// #282: on phones, in German (the longer), at depth with the most crowded
// docks, the notice stands under the HUD and meets no control, nor the HUD,
// an open gas page or the open instructor panel. Below 800px of height, and
// while a page is open, its opening words stand alone.
test.describe('the notice on phones', () => {
  test.use({ viewport: { width: 390, height: 844 }, locale: 'de-DE', hasTouch: true });

  const SIZES = [[320, 568], [360, 640], [375, 667], [390, 844], [667, 375]];

  /** What the notice overlaps, in px of height, and whether it is on screen. */
  const noticeOverlaps = (page) =>
    page.evaluate(() => {
      const n = document.querySelector('[data-persistence-notice]').getBoundingClientRect();
      const shown = (element) => element !== null && element.getClientRects().length > 0;
      const overlap = (element) => {
        if (!shown(element)) return 0;
        const c = element.getBoundingClientRect();
        const across = Math.min(c.right, n.right) - Math.max(c.left, n.left);
        const down = Math.min(c.bottom, n.bottom) - Math.max(c.top, n.top);
        return across > 0 && down > 0 ? Math.round(down * 10) / 10 : 0;
      };
      const found = {};
      for (const button of document.querySelectorAll('.wreck-shell button')) {
        const px = overlap(button);
        if (px > 0) found[button.getAttribute('aria-label') || button.textContent.trim()] = px;
      }
      for (const selector of ['.wreck-hud', '[data-gas-info]', '[data-instructor-panel]']) {
        const px = overlap(document.querySelector(selector));
        if (px > 0) found[selector] = px;
      }
      const onScreen = n.top >= 0 && n.left >= 0 && n.bottom <= window.innerHeight && n.right <= window.innerWidth;
      return { found, onScreen };
    });

  const twoFrames = (page) =>
    page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

  for (const mode of ['rec', 'tec', 'ccr']) {
    test(`${mode}: from 320x568 to 390x844 and at 667x375 the notice meets no control, nor the HUD or an open page`, async ({ page }) => {
      test.setTimeout(180_000);
      await page.addInitScript(blockStorage);
      await page.goto('/dist/');
      await page.locator('[data-accept-safety]').click();
      await page.locator(`[data-setup-group=mode] [data-setup-option=${mode}]`).check();
      if (mode === 'tec') {
        for (let i = 0; i < 5; i += 1) await page.locator('[data-setup-tank-add]').click();
      }
      await page.locator('[data-start-dive]').click();
      await page.locator('[data-renderer=pixi] canvas').waitFor();
      // Under water the dock shows its cylinder and rebreather rows.
      await descendTo(page, 4);
      await expect(sentence(page)).toHaveText(NOT_SAVING_DE);
      const problems = [];
      const check = async (label, form) => {
        await twoFrames(page);
        const { found, onScreen } = await noticeOverlaps(page);
        if (!onScreen) problems.push(`${label}: off screen`);
        for (const [what, px] of Object.entries(found)) problems.push(`${label}: ${px}px over ${what}`);
        const seen = await shownForm(page);
        if (seen !== form) problems.push(`${label}: shows ${seen || 'nothing'}, not ${form}`);
      };
      const gasToggle = page.locator('[data-gas-info-toggle]');
      const learn = page.locator('[data-instructor-toggle]');
      for (const [width, height] of SIZES) {
        await page.setViewportSize({ width, height });
        const label = `${mode} ${width}x${height}`;
        await check(label, height < 800 ? 'opening' : 'sentence');
        if (await gasToggle.isVisible()) {
          for (let step = 1; ; step += 1) {
            await gasToggle.click();
            if (!(await page.locator('[data-gas-info]').isVisible())) break;
            await check(`${label} gas page ${step}`, 'opening');
          }
        }
        if (await learn.isVisible()) {
          await learn.click();
          await check(`${label} Learn`, 'opening');
          await learn.click();
        }
      }
      expect(problems).toEqual([]);
    });
  }
});
