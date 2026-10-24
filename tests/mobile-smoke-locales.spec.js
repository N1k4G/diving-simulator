const { expect, test } = require('./helpers/pinned-seed.cjs');

// The mobile smoke flow in both release locales (#169, its third acceptance
// item): a phone in portrait, a finger only, from the safety gate to "Dive
// again". Each screen is held to three things: its visible text is in the
// requested language, the console stays clean, and every control meets the
// 44 px touch target (docs/decisions.md, "Accessibility and localization").
//
// The expected copy comes from the catalogue itself, so a rewording does not
// break the test; what the test cannot read from it is whether a screen shows
// a string of the other language, which is what the leak check looks for.
// The dive computer is the one decided exception (#232): the HUD readouts and
// the gas pages read English in German too, carry lang="en", and are left out
// of the German leak check.

const { messageCatalog, translate } = require('../src/app/i18n/catalog.ts');

const SAVE_KEY = 'diving-simulator.save-game';
const END_S = 1530;
const DEEPEST_M = 18;

const LOCALES = [
  { locale: 'en-GB', lang: 'en', other: 'de' },
  { locale: 'de-DE', lang: 'de', other: 'en' },
];

function collectConsoleErrors(page) {
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(String(error)));
  return errors;
}

/** Every visible control of the screen is at least 44 x 44 CSS px and on screen. */
async function expectTouchTargets(page, scope, label) {
  const width = page.viewportSize().width;
  const boxes = await page.locator(scope).locator('button, label:has(input)').evaluateAll((els) => els
    .filter((el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden')
    .map((el) => {
      const r = el.getBoundingClientRect();
      return { name: el.getAttribute('aria-label') || el.textContent.trim().slice(0, 30), x: r.x, w: r.width, h: r.height };
    }));
  expect(boxes.length, `${label}: controls found in ${scope}`).toBeGreaterThan(0);
  const problems = boxes
    .filter((b) => b.w < 43.5 || b.h < 43.5 || b.x < 0 || b.x + b.w > width + 0.5)
    .map((b) => `${b.name} is ${Math.round(b.w)}x${Math.round(b.h)} at x ${Math.round(b.x)}`);
  expect(problems, `${label}: ${problems.join('; ')}`).toEqual([]);
}

/**
 * The screen's text outside the dive computer (lang="en" subtrees), checked
 * against the catalogue: nothing in it may be the other language's wording of
 * a key whose two wordings differ. Strings under 6 characters, and any with a
 * placeholder, say too little to tell the languages apart.
 */
async function expectOnlyLocale(page, lang, other, label) {
  const text = await page.evaluate(() => {
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll('script, style, canvas, [lang="en"]').forEach((el) => el.remove());
    return clone.textContent.replace(/\s+/g, ' ');
  });
  const own = messageCatalog[lang];
  const foreign = messageCatalog[other];
  const leaks = Object.keys(foreign).filter((key) => {
    const value = foreign[key];
    return value.length >= 6 && !value.includes('{') && own[key] !== value
      && !own[key]?.includes(value) && text.includes(value);
  });
  expect(leaks.map((key) => `${key}: "${foreign[key]}"`), `${label}: ${other} text shown in ${lang}`).toEqual([]);
}

/** A screen's own wording is on it: the catalogue's text for each key, in this language. */
async function expectCopy(page, lang, scope, keys, label) {
  const text = await page.locator(scope).evaluate((el) => el.textContent.replace(/\s+/g, ' '));
  for (const key of keys) {
    expect(text, `${label}: ${key}`).toContain(translate(lang, key));
  }
}

/** A finger held on the element (real touch, through the protocol) while the dive reaches the depth. */
async function holdTouchUntilDepth(page, locator, depthM) {
  const box = await locator.boundingBox();
  const cdp = await page.context().newCDPSession(page);
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2, id: 1 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  try {
    await page.waitForFunction((target) => {
      const value = document.querySelector('.wreck-hud [data-hud-metric="depth"] dd');
      return Number.parseFloat(String(value?.textContent ?? '').replace(',', '.')) >= target;
    }, depthM, { timeout: 60_000 });
  } finally {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
}

const persistedSave = (page) => page
  .waitForFunction((key) => {
    const raw = window.localStorage.getItem(key);
    const parsed = raw === null ? null : JSON.parse(raw);
    return parsed !== null && parsed.state.elapsedTimeS > 0 ? parsed : null;
  }, SAVE_KEY)
  .then((handle) => handle.jsonValue());

/** tests/post-dive.spec.js completeAtSurface: the save of a dive that ended at the surface. */
function completeAtSurface(state) {
  const profile = [];
  for (let t = 0; t <= END_S; t += 2) {
    const depth = t < 120 ? (DEEPEST_M * t) / 120
      : t < END_S - 150 ? DEEPEST_M
        : Math.max(0, (DEEPEST_M * (END_S - t)) / 150);
    profile.push({ elapsedTimeS: t, depthM: Math.min(DEEPEST_M, depth), ceilingM: 0 });
  }
  const submergedS = END_S - 60;
  Object.assign(state, {
    elapsedTimeS: END_S,
    depthM: 0.1,
    maxDepthM: DEEPEST_M,
    verticalVelocityMpm: 0,
    completed: true,
    thirds: { startingGasL: 0, turnWarned: false, reserveHit: false },
    safetyStop: { needed: true, countdownStarted: true, remainingS: 150, paused: true, complete: false },
  });
  Object.assign(state.log, {
    entries: [
      { kind: 'fast-ascent', elapsedTimeS: END_S - 90, value: 14.2 },
      { kind: 'safety-stop-skipped', elapsedTimeS: END_S, value: 0 },
    ],
    ascentRateMpm: 0,
    fastAscentS: 0,
    fastAscentPeakMpm: 0,
    fastAscentLatched: false,
    ceilingViolationS: 0,
    ceilingViolationLatched: false,
    depthTimeMS: 16 * submergedS,
    submergedS,
    profile,
    profileTimerS: 0,
    lastCeilingM: 0,
  });
}

for (const { locale, lang, other } of LOCALES) {
  test.describe(`mobile smoke flow in ${locale}`, () => {
    test.use({ locale, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    test('gate, setup, dive, help, gas page, post-dive and Dive again, by touch', async ({ page }) => {
      test.setTimeout(180_000);
      const errors = collectConsoleErrors(page);

      // The safety gate.
      await page.goto('/dist/');
      await page.evaluate(() => window.localStorage.clear());
      await expect(page.locator('html')).toHaveAttribute('lang', lang);
      await expect(page.locator('#safety-heading')).toHaveText(translate(lang, 'wreck.safety.heading'));
      await expectCopy(page, lang, '[data-accept-safety]', ['wreck.safety.accept'], 'gate');
      await expectOnlyLocale(page, lang, other, 'gate');
      await expectTouchTargets(page, 'body', 'gate');
      await page.locator('[data-accept-safety]').tap();

      // The setup: a mode picked by touch, then Start.
      const setup = page.locator('.setup-screen');
      await setup.waitFor();
      await expectCopy(page, lang, '.setup-screen',
        ['setup.heading', 'setup.mode.legend', 'setup.mode.rec', 'setup.mode.tec', 'setup.start'], 'setup');
      await expectOnlyLocale(page, lang, other, 'setup');
      await expectTouchTargets(page, '.setup-screen', 'setup');
      await setup.locator('[data-setup-group=mode] [data-setup-option=tec]').tap();
      await expect(setup.locator('[data-setup-group=mode] [data-setup-option=tec]')).toBeChecked();
      await page.locator('[data-start-dive]').tap();
      await page.locator('[data-renderer=pixi] canvas').waitFor();

      // The dive: the D-pad's ↓ begins it, and a held finger takes it down.
      const descend = page.locator('.wreck-controls [data-control="descend"]');
      await expect(descend).toHaveAttribute('aria-label', translate(lang, 'wreck.controls.descend'));
      await expect(page.locator('.wreck-controls [data-control="left"]'))
        .toHaveAttribute('aria-label', translate(lang, 'wreck.controls.left'));
      await expect(page.locator('[data-surface-prompt]')).toHaveText(translate(lang, 'wreck.controls.surfaceDescend'));
      await holdTouchUntilDepth(page, descend, 2);
      await expect(page.locator('[data-surface-prompt]')).toBeHidden();
      await expect(page.locator('.wreck-hud')).toHaveAttribute('lang', 'en');
      await expectOnlyLocale(page, lang, other, 'dive');
      await expectTouchTargets(page, '.wreck-controls', 'dive D-pad');
      await expectTouchTargets(page, '.wreck-topbar', 'dive topbar');

      // The help: open, in the locale, scrolling aside nothing, closed.
      await page.locator('[data-help-open]').tap();
      const help = page.getByRole('dialog', { name: translate(lang, 'help.heading') });
      await expect(help).toBeVisible();
      await expectCopy(page, lang, '[data-help-overlay]',
        ['help.heading', 'help.paused', 'help.column.action', 'help.section.dive', 'help.buoyancy'], 'help');
      await expectOnlyLocale(page, lang, other, 'help');
      await expectTouchTargets(page, '[data-help-overlay]', 'help');
      await page.locator('[data-help-close]').tap();
      await expect(help).toBeHidden();

      // The gas page (technical dive): the button is a control of the page's
      // language, the page itself the dive computer's English.
      const toggle = page.locator('[data-gas-info-toggle]');
      await expect(toggle).toHaveAttribute('aria-label', translate(lang, 'wreck.gasInfo.open'));
      await toggle.tap();
      const panel = page.locator('[data-gas-info]');
      await expect(panel).toBeVisible();
      await expect(panel).toHaveAttribute('lang', 'en');
      await expect(panel.locator('.gas-info-heading')).not.toHaveText('');
      await expectOnlyLocale(page, lang, other, 'gas page');
      await expectTouchTargets(page, '.wreck-topbar', 'gas page topbar');
      // The button walks the pages and then closes the panel.
      for (let taps = 0; taps < 8 && await panel.isVisible(); taps += 1) await toggle.tap();
      await expect(panel).toBeHidden();

      // The end: the running dive's save, turned into one ended at the surface, resumed.
      const saved = await persistedSave(page);
      completeAtSurface(saved.state);
      await page.goto('/dist/');
      await page.evaluate(([key, value]) => window.localStorage.setItem(key, value), [SAVE_KEY, JSON.stringify(saved)]);
      await page.locator('[data-accept-safety]').tap();
      await page.locator('.setup-screen').waitFor();
      await expectCopy(page, lang, '.setup-screen', ['setup.resume.text', 'setup.resume.continue'], 'resume banner');
      await expectTouchTargets(page, '.setup-screen', 'resume banner');
      await page.locator('[data-resume-continue]').tap();

      // The post-dive screen.
      const post = page.locator('[data-post-dive]');
      await post.waitFor();
      await expect(post.getByRole('heading', { level: 1 })).toHaveText(translate(lang, 'postDive.heading'));
      await expectCopy(page, lang, '[data-post-dive]',
        ['postDive.debrief', 'postDive.gas', 'postDive.profile', 'postDive.diveAgain'], 'post-dive');
      await expectOnlyLocale(page, lang, other, 'post-dive');
      await expectTouchTargets(page, '[data-post-dive]', 'post-dive');

      // Dive again: back on the setup, in the same language.
      await page.locator('[data-dive-again]').tap();
      await expect(setup).toBeVisible();
      await expectCopy(page, lang, '.setup-screen', ['setup.heading', 'setup.start'], 'setup after Dive again');
      await expectOnlyLocale(page, lang, other, 'setup after Dive again');

      expect(errors).toEqual([]);
    });
  });
}
