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
    // A notice taken out of view is clipped to a pixel, whatever its spans measure.
    if (document.querySelector('[data-persistence-notice]').getBoundingClientRect().width <= 1) return '';
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
// an open gas page or the open instructor panel. Below 800px of height its
// opening words stand alone. An open gas page, and the instructor panel where
// it stands under the HUD, take its place: each keeps the content height it
// has without the notice, and its box meets no control it does not meet
// without it (on 749e193 a technical dive's gas page kept 5px of its 47 at
// 320x568, and a rebreather's Learn panel ran behind the setpoint buttons).
test.describe('the notice on phones', () => {
  test.use({ viewport: { width: 390, height: 844 }, locale: 'de-DE', hasTouch: true });

  const SIZES = [[320, 568], [360, 640], [375, 667], [360, 740], [390, 844], [667, 375]];
  /** Sub-pixel rounding between two layouts of the same page. */
  const TOLERANCE_PX = 1;

  /**
   * What the notice overlaps, in px of height, whether it is on screen, and
   * the open page's or panel's content height and the controls its box meets.
   */
  const layout = (page) =>
    page.evaluate(() => {
      const shown = (element) => element !== null && !element.hidden && element.getClientRects().length > 0;
      const across = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const down = (a, b) => Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      const overlap = (a, b) => (across(a, b) > 0 && down(a, b) > 0 ? Math.round(down(a, b) * 10) / 10 : 0);
      const buttons = [...document.querySelectorAll('.wreck-shell button')].filter(shown);
      const name = (button) => button.getAttribute('aria-label') || button.textContent.trim();
      const notice = document.querySelector('[data-persistence-notice]');
      const n = notice.getBoundingClientRect();
      const found = {};
      // Visually hidden, an open page in its place: nothing to meet.
      if (n.width > 1) {
        for (const button of buttons) {
          const px = overlap(button.getBoundingClientRect(), n);
          if (px > 0) found[name(button)] = px;
        }
        for (const selector of ['.wreck-hud', '[data-gas-info]', '[data-instructor-panel]']) {
          const element = document.querySelector(selector);
          const px = shown(element) ? overlap(element.getBoundingClientRect(), n) : 0;
          if (px > 0) found[selector] = px;
        }
      }
      const onScreen = n.top >= 0 && n.left >= 0 && n.bottom <= window.innerHeight && n.right <= window.innerWidth;
      const open = [document.querySelector('[data-gas-info]'), document.querySelector('[data-instructor-panel]')].find(shown);
      let content = null;
      const meets = [];
      if (open) {
        const style = getComputedStyle(open);
        content = Math.round((open.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)) * 10) / 10;
        const box = open.getBoundingClientRect();
        for (const button of buttons) {
          if (!open.contains(button) && overlap(button.getBoundingClientRect(), box) > 0) meets.push(name(button));
        }
      }
      // Controls the notice pushed into each other (Learn stands under the HUD at 320x568).
      const pairs = [];
      buttons.forEach((a, i) => {
        for (const b of buttons.slice(i + 1)) {
          if (!a.contains(b) && !b.contains(a) && overlap(a.getBoundingClientRect(), b.getBoundingClientRect()) > 0) {
            pairs.push(`${name(a)} / ${name(b)}`);
          }
        }
      });
      return { found, onScreen, content, meets, pairs };
    });

  const twoFrames = (page) =>
    page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

  /** The same page laid out as with the notice empty, as on main: out of the flow, no size. */
  const asIfEmpty = (page, on) =>
    page.evaluate((add) => {
      const id = 'n282-as-if-empty';
      document.getElementById(id)?.remove();
      if (!add) return;
      const style = document.createElement('style');
      style.id = id;
      style.textContent = '[data-persistence-notice] { position: absolute !important; width: 0 !important; height: 0 !important; padding: 0 !important; border: 0 !important; overflow: hidden !important; }';
      document.head.append(style);
    }, on);

  for (const mode of ['rec', 'tec', 'ccr']) {
    test(`${mode}: from 320x568 to 390x844 and at 667x375 the notice meets nothing and an open page keeps its room`, async ({ page }) => {
      test.setTimeout(240_000);
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
        const shownNow = await layout(page);
        if (!shownNow.onScreen) problems.push(`${label}: off screen`);
        for (const [what, px] of Object.entries(shownNow.found)) problems.push(`${label}: ${px}px over ${what}`);
        const seen = await shownForm(page);
        if (seen !== form) problems.push(`${label}: shows ${seen || 'nothing'}, not ${form}`);
        await asIfEmpty(page, true);
        await twoFrames(page);
        const without = await layout(page);
        await asIfEmpty(page, false);
        const pushed = shownNow.pairs.filter((pair) => !without.pairs.includes(pair));
        if (pushed.length > 0) problems.push(`${label}: controls meet: ${pushed.join('; ')}`);
        if (shownNow.content === null) return;
        if (shownNow.content < without.content - TOLERANCE_PX) {
          problems.push(`${label}: ${shownNow.content}px of content, ${without.content}px without the notice`);
        }
        const newly = shownNow.meets.filter((control) => !without.meets.includes(control));
        if (newly.length > 0) problems.push(`${label}: its box meets ${newly.join(', ')}`);
      };
      const gasToggle = page.locator('[data-gas-info-toggle]');
      const learn = page.locator('[data-instructor-toggle]');
      for (const [width, height] of SIZES) {
        await page.setViewportSize({ width, height });
        const label = `${mode} ${width}x${height}`;
        await check(label, height < 800 ? 'opening' : 'sentence');
        // By their keys (I, L): the diver sinks on through a long run, and a
        // warning banner can stand over a toggle by then.
        if (await gasToggle.isVisible()) {
          for (let step = 1; ; step += 1) {
            await page.keyboard.press('i');
            await twoFrames(page);
            if (!(await page.locator('[data-gas-info]').isVisible())) break;
            await check(`${label} gas page ${step}`, '');
          }
        }
        if (await learn.isVisible()) {
          await page.keyboard.press('l');
          await expect(page.locator('[data-instructor-panel]')).toBeVisible();
          await check(`${label} Learn`, '');
          await page.keyboard.press('l');
          await expect(page.locator('[data-instructor-panel]')).toBeHidden();
        }
      }
      expect(problems).toEqual([]);
    });
  }
});
