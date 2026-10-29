const { expect, test } = require('./helpers/pinned-seed.cjs');
const { descendTo } = require('./helpers/start-dive.cjs');

// The warning banner against the in-dive controls on narrow phones in
// portrait (#287). The banner stood centred over the topbar and took the
// taps meant for the gas pages' I under it, and a long warning hid Help and
// mute, the alarm's off switch. While a warning shows, every control stays
// pressable (a tap at its centre reaches it) and in view (it is painted over
// the banner there), a focused one included (WCAG 2.4.11), and so does
// fast-forward's badge. The banner stays off the depth, ascent-rate and NDL
// rows (#137 A15), keeps its alert semantics, and its text fits it.
//
// A real warning, raised as tests/hud-warnings.spec.js raises it: the dive's
// own save, changed and resumed. Narcosis is the issue's case and a short
// text; low gas is one of the longest, which wraps. Every other warning's
// text is measured too, in a copy of the banner that is not an alert, so the
// rule holds for every length the dive computer shows.

const SAVE_KEY = 'diving-simulator.save-game';

// tests/in-dive-controls.spec.js's narrow sizes, and 320x568.
const NARROW_SIZES = [[320, 568], [340, 640], [360, 640], [375, 667], [390, 844]];

// Every alert text (src/app/i18n/catalog.ts, diveComputer.alert.*). The dive
// computer reads English in every locale (#232).
const ALERT_TEXTS = [
  'Low gas pressure — begin a controlled exit',
  'Scrubber nearly spent — end the dive',
  'Unsafe simulated oxygen pressure',
  'Ascending too fast — slow down',
  'Scrubber failed — simulated CO₂ buildup, bail out',
  'Simulated dive failure — return to the surface',
  'Above ceiling — descend',
  'Gas reserve',
  'Low NDL',
  'Narcosis',
];

const WARNINGS = {
  narcosis: {
    text: 'Narcosis',
    // At 35 m, over legacy's 0.20 caution (tests/hud-warnings.spec.js).
    mutate: (state) => {
      Object.assign(state, {
        depthM: 35,
        maxDepthM: 35,
        verticalVelocityMpm: 0,
        bcdGasSurfaceLiters: 15,
        narcosisIndex: 0.5,
      });
    },
  },
  lowGas: {
    text: 'Low gas pressure — begin a controlled exit',
    // 20 bar, under legacy's 30 bar low gas.
    mutate: (state) => {
      const tank = state.tanks[state.activeTankIndex];
      tank.gasRemainingL = tank.volumeL * 20;
    },
  },
};

/** A dive in `mode`, resumed from its own save as changed by `mutate`. */
async function resumeWith(page, mode, mutate) {
  await page.goto('/dist/');
  await page.evaluate(() => window.localStorage.clear());
  await page.locator('[data-accept-safety]').click();
  await page.locator('.setup-screen').waitFor();
  await page.locator(`[data-setup-group=mode] [data-setup-option=${mode}]`).check();
  await page.locator('[data-start-dive]').click();
  await page.locator('[data-renderer=pixi] canvas').waitFor();
  await descendTo(page, 1);
  const saved = await page
    .waitForFunction((key) => {
      const raw = window.localStorage.getItem(key);
      const parsed = raw === null ? null : JSON.parse(raw);
      return parsed !== null && parsed.state.elapsedTimeS > 0 ? parsed : null;
    }, SAVE_KEY)
    .then((handle) => handle.jsonValue());
  mutate(saved.state);
  await page.goto('/dist/');
  await page.evaluate(([key, value]) => window.localStorage.setItem(key, value), [SAVE_KEY, JSON.stringify(saved)]);
  await page.locator('[data-accept-safety]').click();
  await page.locator('.setup-screen').waitFor();
  await page.locator('[data-resume-continue]').click();
  await page.locator('[data-renderer=pixi] canvas').waitFor();
}

/**
 * What the banner does to the controls and the HUD: the controls a tap at
 * their centre misses, the controls it is painted over (hit-tested as if it
 * took taps), the HUD rows its box meets, and whether its text fits. With
 * `text`, a copy of the banner showing that text, not an alert, stands in
 * for it, with the same rules.
 */
const measure = (page, text = null) =>
  page.evaluate((text) => {
    const shown = (element) => element !== null && element.getClientRects().length > 0;
    const meets = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    const name = (element) =>
      element.getAttribute('aria-label') || element.dataset.direction || element.className || element.textContent;
    const alert = document.querySelector('.wreck-warning');
    let banner = alert;
    if (text !== null) {
      banner = alert.cloneNode(false);
      banner.removeAttribute('role');
      banner.removeAttribute('aria-live');
      banner.textContent = text;
      alert.after(banner);
      alert.style.visibility = 'hidden';
    }
    const box = banner.getBoundingClientRect();
    const controls = [...document.querySelectorAll('.wreck-shell button')].filter(shown);
    const centre = (control) => {
      const c = control.getBoundingClientRect();
      return document.elementFromPoint(c.left + c.width / 2, c.top + c.height / 2);
    };
    const untappable = controls
      .filter((control) => !control.contains(centre(control)))
      .map((control) => `${name(control)} under ${centre(control)?.className ?? 'nothing'}`);
    banner.style.pointerEvents = 'auto';
    const hidden = controls.filter((control) => !control.contains(centre(control))).map(name);
    banner.style.pointerEvents = '';
    const coveredRows = ['depth', 'ascentRate', 'ndl'].filter((metric) => {
      const row = document.querySelector(`[data-hud-metric="${metric}"]`);
      return shown(row) && meets(box, row.getBoundingClientRect());
    });
    const result = {
      controls: controls.length,
      untappable,
      hidden,
      coveredRows,
      inView: box.left >= 0 && box.right <= window.innerWidth && box.top >= 0,
      overflows: banner.scrollWidth > banner.clientWidth,
      fontPx: parseFloat(getComputedStyle(banner).fontSize),
    };
    if (banner !== alert) {
      banner.remove();
      alert.style.visibility = '';
    }
    return result;
  }, text);

/** `failures` gains what `m`, measured at `at`, breaks. */
function check(failures, at, m) {
  if (m.controls === 0) failures.push(`${at}: no control found`);
  if (m.untappable.length > 0) failures.push(`${at}: a tap misses ${m.untappable.join(', ')}`);
  if (m.hidden.length > 0) failures.push(`${at}: the banner hides ${m.hidden.join(', ')}`);
  if (m.coveredRows.length > 0) failures.push(`${at}: the banner covers the HUD's ${m.coveredRows.join(', ')}`);
  if (!m.inView) failures.push(`${at}: the banner runs out of the screen`);
  if (m.overflows) failures.push(`${at}: the banner's text overflows it`);
  if (m.fontPx < 12) failures.push(`${at}: the banner's text is ${m.fontPx}px`);
}

/**
 * The fast-forward badge under a warning: the share of 5 points on it (its
 * centre and near its corners) where it is painted on top, hit-tested as if
 * the banner took taps, and whether any of the banner's text runs under it.
 */
const badgeOnTop = (page) =>
  page.evaluate(() => {
    const banner = document.querySelector('.wreck-warning');
    const badge = document.querySelector('[data-fast-forward-indicator]');
    const b = badge.getBoundingClientRect();
    banner.style.pointerEvents = 'auto';
    const points = [[0.5, 0.5], [0.15, 0.25], [0.85, 0.25], [0.15, 0.75], [0.85, 0.75]];
    const onTop = points.filter(([x, y]) => badge.contains(
      document.elementFromPoint(b.left + b.width * x, b.top + b.height * y),
    )).length / points.length;
    banner.style.pointerEvents = '';
    const text = document.createRange();
    text.selectNodeContents(banner);
    const textUnder = [...text.getClientRects()].some((t) =>
      t.left < b.right && b.left < t.right && t.top < b.bottom && b.top < t.bottom);
    return { onTop, textUnder };
  });

/**
 * A dive in `mode` at a deco stop, where F is offered, resumed with the gas
 * reserve's warning: 45 bar, under legacy's 50 (tests/help-overlay.spec.js
 * resumeAtDecoStop, and tests/hud-warnings.spec.js for the reserve).
 */
async function resumeAtDecoStopOnReserve(page, mode) {
  await resumeWith(page, mode, (state) => {
    Object.assign(state, {
      depthM: 18,
      maxDepthM: 34,
      verticalVelocityMpm: 0,
      bcdGasSurfaceLiters: 9.990465669399928,
    });
    state.tissues.nitrogenBar = state.tissues.nitrogenBar.map(() => 3);
    const tank = state.tanks[state.activeTankIndex];
    tank.gasRemainingL = tank.volumeL * 45;
  });
  await expect(page.getByRole('alert')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-fast-forward]')).toBeVisible();
}

const CASES = [
  ['rec', 'narcosis'],
  ['tec', 'narcosis'],
  ['ccr', 'narcosis'],
  ['rec', 'lowGas'],
  ['tec', 'lowGas'],
];

for (const locale of ['en-US', 'de-DE']) {
  test.describe(`in ${locale}`, () => {
    test.use({ locale, viewport: { width: 390, height: 844 }, hasTouch: true });

    for (const [mode, warningName] of CASES) {
      test(`${mode}: the ${warningName} banner leaves every control pressable and in view, 320-390 px portrait`, async ({ page }) => {
        test.setTimeout(120_000);
        const warning = WARNINGS[warningName];
        await resumeWith(page, mode, warning.mutate);
        const alert = page.getByRole('alert');
        await expect(alert).toHaveText(warning.text, { timeout: 15_000 });
        await expect(alert).toHaveAttribute('aria-live', 'assertive');
        await expect(alert).toHaveClass('wreck-warning');
        if (mode !== 'rec') {
          // The control #287 reported: the gas pages' I.
          await expect(page.locator('[data-gas-info-toggle]')).toBeVisible();
        }

        const failures = [];
        for (const [width, height] of NARROW_SIZES) {
          await page.setViewportSize({ width, height });
          await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          await expect(alert).toBeVisible();
          check(failures, `${width}x${height}`, await measure(page));
          for (const text of ALERT_TEXTS) {
            check(failures, `${width}x${height} "${text}"`, await measure(page, text));
          }
        }
        // A topbar button with keyboard focus stays in view at the narrowest
        // size (WCAG 2.4.11), and the banner stays where it is, off the HUD.
        await page.setViewportSize({ width: 320, height: 568 });
        await page.keyboard.press('Shift');
        for (const button of await page.locator('.topbar-actions button:visible').all()) {
          await button.focus();
          const label = await button.getAttribute('aria-label');
          expect(await button.evaluate((el) => el.matches(':focus-visible')), `${label} shows its focus`).toBe(true);
          check(failures, `320x568, ${label} focused`, await measure(page));
          check(failures, `320x568, ${label} focused, "${ALERT_TEXTS[4]}"`, await measure(page, ALERT_TEXTS[4]));
        }
        // The whole matrix at once, rather than its first failure.
        expect(failures).toEqual([]);
      });
    }

    // Fast-forward's badge says in words that the clock runs ten times
    // faster, which nothing else in sight does, so a warning must not hide
    // it (#287 pre-review pass 2). It is switched on for each size alone, so
    // the gas the stop breathes at ten times the clock lasts the test.
    for (const mode of ['rec', 'tec']) {
      test(`${mode}: fast-forward's badge stays on top of the banner at a deco stop on the reserve, 320-390 px portrait`, async ({ page }) => {
        test.setTimeout(120_000);
        await resumeAtDecoStopOnReserve(page, mode);
        const badge = page.locator('[data-fast-forward-indicator]');
        const failures = [];
        for (const [width, height] of NARROW_SIZES) {
          const at = `${width}x${height}`;
          await page.setViewportSize({ width, height });
          await page.keyboard.press('f');
          await expect(badge).toBeVisible();
          await expect(page.getByRole('alert')).toBeVisible();
          const { onTop, textUnder } = await badgeOnTop(page);
          if (onTop < 1) failures.push(`${at}: the badge is under the banner at ${Math.round((1 - onTop) * 100)}% of its points`);
          if (textUnder) failures.push(`${at}: the banner's text runs under the badge`);
          check(failures, `${at}, fast-forward`, await measure(page));
          await page.keyboard.press('f');
          await expect(badge).toBeHidden();
        }
        expect(failures).toEqual([]);
      });
    }
  });
}
