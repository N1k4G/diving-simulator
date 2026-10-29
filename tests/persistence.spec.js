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
  await expect(sentence(page)).toHaveText(NOT_SAVING_DE);
  await expect(sentence(page)).toBeVisible();
  // The short form is for the eye alone, and not shown where the sentence fits.
  await expect(opening(page)).toHaveAttribute('aria-hidden', 'true');
  await expect(opening(page)).toBeHidden();
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
  await expect(sentence(page)).toBeVisible();

  await page.evaluate(() => {
    Storage.prototype.setItem = window.__setItem;
    window.localStorage.removeItem('diving-simulator.save-game');
  });
  await expect(notice(page)).toHaveText('', { timeout: 10_000 });
  await expect(notice(page)).toBeHidden();
  expect(await page.evaluate((key) => window.localStorage.getItem(key), SAVE_KEY)).not.toBeNull();
});

// #282: on the narrowest phones, in German (the longer), at depth with the
// most crowded docks, the notice stays on screen and covers no control: the
// sentence at the top of the dock at 390x844, its opening words alone above
// the D-pad below that. It stays clear of the HUD too, but at 320x568, where
// on linux fonts a rebreather's HUD itself runs into the dock on main
// (#258), as tests/in-dive-controls.spec.js leaves that size out for.
test.describe('the notice on narrow phones', () => {
  test.use({ viewport: { width: 390, height: 844 }, locale: 'de-DE', hasTouch: true });

  /** The notice's least distance to the HUD and to any visible control, and whether it is on screen. */
  const noticeClearance = (page) =>
    page.evaluate(() => {
      const n = document.querySelector('[data-persistence-notice]').getBoundingClientRect();
      const gap = (c) => Math.max(c.top - n.bottom, n.top - c.bottom, c.left - n.right, n.left - c.right);
      let control = Infinity;
      for (const button of document.querySelectorAll('.wreck-shell button')) {
        if (button.getClientRects().length > 0) control = Math.min(control, gap(button.getBoundingClientRect()));
      }
      const hud = gap(document.querySelector('.wreck-hud').getBoundingClientRect());
      const onScreen = n.top >= 0 && n.left >= 0 && n.bottom <= window.innerHeight && n.right <= window.innerWidth;
      return { control: Math.round(control * 10) / 10, hud: Math.round(hud * 10) / 10, onScreen };
    });

  for (const mode of ['rec', 'tec', 'ccr']) {
    test(`${mode}: at 320x568, 360x640 and 390x844 the notice covers no control`, async ({ page }) => {
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
      const measured = {};
      for (const [width, height, shown] of [[320, 568, opening], [360, 640, opening], [390, 844, sentence]]) {
        await page.setViewportSize({ width, height });
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await expect(shown(page)).toBeVisible();
        measured[`${width}x${height}`] = await noticeClearance(page);
      }
      for (const [size, { control, hud, onScreen }] of Object.entries(measured)) {
        expect(onScreen, `${mode} ${size} on screen`).toBe(true);
        expect(control, `${mode} ${size} clear of every control`).toBeGreaterThan(0);
        if (size !== '320x568') expect(hud, `${mode} ${size} clear of the HUD`).toBeGreaterThan(0);
      }
    });
  }
});
