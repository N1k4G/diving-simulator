const { expect, test } = require('./helpers/pinned-seed.cjs');
const { beginDescent } = require('./helpers/start-dive.cjs');

// The language switch (#169). Legacy offers it on its gas setup alone, as a
// button that names the other language in that language, "Sprache" or
// "Language" (src/ui.js 403-417 and 568; src/touch.js 176-180), and keeps no
// choice: every load opens in English. This client offers it in the same
// place, redraws the setup in place, and keeps the choice in the page's
// storage, which wins over the browser's languages at the next load
// (docs/decisions.md, the #169 departure row).

const { translate } = require('../src/app/i18n/catalog.ts');

const LOCALE_KEY = 'diving-simulator.locale';
const SAVE_KEY = 'diving-simulator.save-game';

const switchButton = (page) => page.locator('[data-setup-locale]');
const storedLocale = (page) => page.evaluate((key) => window.localStorage.getItem(key), LOCALE_KEY);

/** Opens the page with nothing stored, the gate up. */
async function openFresh(page) {
  await page.goto('/dist/');
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
  await page.locator('[data-accept-safety]').waitFor();
}

async function acceptGate(page) {
  await page.locator('[data-accept-safety]').click();
  await page.locator('.setup-screen').waitFor();
}

/**
 * Counts main-frame navigations from here on and marks the window, so a
 * switch that reloaded the page, or replaced its document, is caught.
 */
async function watchForReload(page) {
  const navigations = [];
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) navigations.push(frame.url());
  });
  await page.evaluate(() => {
    window.__loc169SamePage = true;
  });
  return async () => {
    expect(navigations, 'no navigation during the switch').toEqual([]);
    expect(await page.evaluate(() => window.__loc169SamePage === true), 'the same document').toBe(true);
  };
}

async function expectSetupIn(page, lang) {
  const other = lang === 'en' ? 'de' : 'en';
  await expect(page.locator('html')).toHaveAttribute('lang', lang);
  await expect(page).toHaveTitle(translate(lang, 'wreck.brand'));
  await expect(page.locator('.setup-heading')).toHaveText(translate(lang, 'setup.heading'));
  await expect(page.locator('[data-start-dive]')).toHaveText(translate(lang, 'setup.start'));
  await expect(page.locator('[data-setup-group=mode] legend')).toHaveText(translate(lang, 'setup.mode.legend'));
  await expect(switchButton(page)).toHaveText(translate(lang, 'setup.language.switch'));
  await expect(switchButton(page)).toHaveAttribute('lang', other);
}

test.describe('the language switch on the setup screen', () => {
  test.use({ locale: 'en-GB' });

  test('redraws the setup in German in place, keeps its settings and focus, and the dive and the next load follow', async ({ page }) => {
    test.setTimeout(120_000);
    await openFresh(page);
    await acceptGate(page);
    await expectSetupIn(page, 'en');
    expect(await storedLocale(page)).toBeNull();

    // Settings made before the switch.
    await page.locator('[data-setup-group=mode] [data-setup-option=tec]').check();
    await page.locator('[data-setup-stepper=oxygen] [data-setup-step=increase]').click();
    await page.locator('[data-setup-drills]').click();
    const oxygenDigits = (await page.locator('[data-setup-value=oxygen]').textContent()).replace(/\D/g, '');

    const noReload = await watchForReload(page);
    await switchButton(page).focus();
    await page.keyboard.press('Enter');

    await expectSetupIn(page, 'de');
    await expect(switchButton(page)).toBeFocused();
    await expect(page.locator('[data-setup-group=mode] [data-setup-option=tec]')).toBeChecked();
    expect((await page.locator('[data-setup-value=oxygen]').textContent()).replace(/\D/g, '')).toBe(oxygenDigits);
    await expect(page.locator('[data-setup-drills]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-setup-drills]')).toHaveAttribute('aria-label', translate('de', 'setup.drills'));
    expect(await storedLocale(page)).toBe('de');
    await noReload();

    // The dive takes the switched language: its controls and the surface
    // prompt in German, the dive computer in English (#232). Legacy offers no
    // switch under water, and neither does this client.
    await page.locator('[data-start-dive]').click();
    await page.locator('[data-renderer=pixi] canvas').waitFor();
    await expect(page.locator('.wreck-controls [data-control="descend"]'))
      .toHaveAttribute('aria-label', translate('de', 'wreck.controls.descend'));
    await expect(page.locator('[data-surface-prompt]')).toHaveText(translate('de', 'wreck.controls.surfaceDescend'));
    await expect(page.locator('.wreck-hud')).toHaveAttribute('lang', 'en');
    await expect(page.locator('html')).toHaveAttribute('lang', 'de');
    await expect(switchButton(page)).toHaveCount(0);
    await noReload();

    // The next load opens in German, from the gate on, over the browser's English.
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'de');
    await expect(page.locator('#safety-heading')).toHaveText(translate('de', 'wreck.safety.heading'));
    await expect(page.locator('[data-accept-safety]')).toHaveText(translate('de', 'wreck.safety.accept'));
    await acceptGate(page);
    await expectSetupIn(page, 'de');

    // And back to English, kept too.
    await switchButton(page).click();
    await expectSetupIn(page, 'en');
    expect(await storedLocale(page)).toBe('en');
    await page.reload();
    await expect(page.locator('#safety-heading')).toHaveText(translate('en', 'wreck.safety.heading'));
  });

  test('a resume banner still up is redrawn in the new language and still works', async ({ page }) => {
    test.setTimeout(120_000);
    await openFresh(page);
    await acceptGate(page);
    await page.locator('[data-start-dive]').click();
    await page.locator('[data-renderer=pixi] canvas').waitFor();
    await beginDescent(page);
    await page.waitForFunction((key) => {
      const raw = window.localStorage.getItem(key);
      return raw !== null && JSON.parse(raw).state.elapsedTimeS > 0;
    }, SAVE_KEY, { timeout: 60_000 });

    await page.reload();
    await acceptGate(page);
    const banner = page.locator('[data-resume-banner]');
    await expect(banner.locator('.resume-banner-text')).toHaveText(translate('en', 'setup.resume.text'));
    const noReload = await watchForReload(page);
    await switchButton(page).click();
    await expect(banner.locator('.resume-banner-text')).toHaveText(translate('de', 'setup.resume.text'));
    await expect(page.locator('[data-resume-continue]')).toHaveText(translate('de', 'setup.resume.continue'));
    await expect(page.locator('[data-resume-discard]')).toHaveText(translate('de', 'setup.resume.discard'));
    await noReload();

    // Discarded, it stays gone through another switch.
    await page.locator('[data-resume-discard]').click();
    await expect(banner).toHaveCount(0);
    await switchButton(page).click();
    await expectSetupIn(page, 'en');
    await expect(banner).toHaveCount(0);
    expect(await page.evaluate((key) => window.localStorage.getItem(key), SAVE_KEY)).toBeNull();
  });
});

test.describe('the stored choice and the browser language', () => {
  test.use({ locale: 'de-DE' });

  test('a stored choice wins over the browser; an unknown one leaves the browser in charge', async ({ page }) => {
    await openFresh(page);
    await expect(page.locator('html')).toHaveAttribute('lang', 'de');

    await page.evaluate((key) => window.localStorage.setItem(key, 'en'), LOCALE_KEY);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('#safety-heading')).toHaveText(translate('en', 'wreck.safety.heading'));

    await page.evaluate((key) => window.localStorage.setItem(key, 'fr'), LOCALE_KEY);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'de');
    await expect(page.locator('#safety-heading')).toHaveText(translate('de', 'wreck.safety.heading'));
  });
});

test.describe('the language switch on a phone, by touch', () => {
  test.use({ locale: 'en-GB', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('a tap switches; the button is a 44 px target at least 8 px from its neighbours', async ({ page }) => {
    await openFresh(page);
    await page.locator('[data-accept-safety]').tap();
    await page.locator('.setup-screen').waitFor();

    const boxes = async () => Promise.all(
      ['[data-setup-locale]', '[data-setup-drills]', '[data-start-dive]']
        .map((selector) => page.locator(selector).boundingBox()),
    );
    for (const lang of ['en', 'de']) {
      const [button, ...neighbours] = await boxes();
      expect(button.width, `${lang}: width`).toBeGreaterThanOrEqual(44);
      expect(button.height, `${lang}: height`).toBeGreaterThanOrEqual(44);
      expect(button.x).toBeGreaterThanOrEqual(0);
      expect(button.x + button.width).toBeLessThanOrEqual(390);
      for (const [i, other] of neighbours.entries()) {
        const gapX = Math.max(button.x - (other.x + other.width), other.x - (button.x + button.width));
        const gapY = Math.max(button.y - (other.y + other.height), other.y - (button.y + button.height));
        expect(Math.round(Math.max(gapX, gapY)), `${lang}: spacing to neighbour ${i}`).toBeGreaterThanOrEqual(8);
      }
      if (lang === 'en') {
        const noReload = await watchForReload(page);
        await switchButton(page).tap();
        await expectSetupIn(page, 'de');
        await noReload();
      }
    }
    expect(await storedLocale(page)).toBe('de');
  });
});
