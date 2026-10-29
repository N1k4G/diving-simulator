const { expect, test } = require('./helpers/pinned-seed.cjs');
const { descendTo } = require('./helpers/start-dive.cjs');

// The warning banner against the in-dive controls on narrow phones in
// portrait (#287). The banner stood centred over the topbar and took the
// taps meant for the gas pages' I under it. Every control stays pressable
// while a warning shows: a tap at its centre reaches it. A short warning
// also leaves every control in view; a long one may stand over the topbar's
// buttons, but not over the depth or the NDL row (#137 A15). The banner
// keeps its alert semantics and its text fits it.
//
// A real warning, raised as tests/hud-warnings.spec.js raises it: the dive's
// own save, changed and resumed. Narcosis is the issue's case and a short
// text; low gas is one of the longest, which wraps.

const SAVE_KEY = 'diving-simulator.save-game';

// tests/in-dive-controls.spec.js's narrow sizes, and 320x568.
const NARROW_SIZES = [[320, 568], [340, 640], [360, 640], [375, 667], [390, 844]];

const WARNINGS = {
  narcosis: {
    text: 'Narcosis',
    clearOfControls: true,
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
    clearOfControls: false,
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
 * The banner and every shown control: which control a tap at its centre
 * reaches, which the banner's box meets, and whether the banner's text fits.
 */
const measure = (page) =>
  page.evaluate(() => {
    const shown = (element) => element !== null && element.getClientRects().length > 0;
    const meets = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    const name = (element) =>
      element.getAttribute('aria-label') || element.dataset.direction || element.className || element.textContent;
    const banner = document.querySelector('.wreck-warning');
    const box = banner.getBoundingClientRect();
    const untappable = [];
    const covered = [];
    let controls = 0;
    for (const control of document.querySelectorAll('.wreck-shell button')) {
      if (!shown(control)) continue;
      controls += 1;
      const c = control.getBoundingClientRect();
      const hit = document.elementFromPoint(c.left + c.width / 2, c.top + c.height / 2);
      if (hit === null || !control.contains(hit)) {
        untappable.push(`${name(control)} under ${hit === null ? 'nothing' : hit.className}`);
      }
      if (meets(box, c)) covered.push(name(control));
    }
    const coveredRows = ['depth', 'ndl'].filter((metric) => {
      const row = document.querySelector(`[data-hud-metric="${metric}"]`);
      return shown(row) && meets(box, row.getBoundingClientRect());
    });
    return {
      controls,
      untappable,
      covered,
      coveredRows,
      inView: box.left >= 0 && box.right <= window.innerWidth && box.top >= 0,
      overflows: banner.scrollWidth > banner.clientWidth,
      fontPx: parseFloat(getComputedStyle(banner).fontSize),
    };
  });

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
      test(`${mode}: the ${warningName} banner leaves every control pressable, 320-390 px portrait`, async ({ page }) => {
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
          const at = `${width}x${height}`;
          const m = await measure(page);
          expect(m.controls, `${at}: controls found`).toBeGreaterThan(0);
          if (m.untappable.length > 0) failures.push(`${at}: a tap misses ${m.untappable.join(', ')}`);
          if (warning.clearOfControls && m.covered.length > 0) {
            failures.push(`${at}: the banner covers ${m.covered.join(', ')}`);
          }
          if (m.coveredRows.length > 0) failures.push(`${at}: the banner covers the HUD's ${m.coveredRows.join(', ')}`);
          if (!m.inView) failures.push(`${at}: the banner runs out of the screen`);
          if (m.overflows) failures.push(`${at}: the banner's text overflows it`);
          if (m.fontPx < 12) failures.push(`${at}: the banner's text is ${m.fontPx}px`);
        }
        // A topbar button with keyboard focus is in view at the narrowest
        // size (WCAG 2.4.11), even under a long warning.
        await page.setViewportSize({ width: 320, height: 568 });
        await page.keyboard.press('Shift');
        for (const button of await page.locator('.topbar-actions button:visible').all()) {
          await button.focus();
          const label = await button.getAttribute('aria-label');
          expect(await button.evaluate((el) => el.matches(':focus-visible')), `${label} shows its focus`).toBe(true);
          const focused = await button.boundingBox();
          const banner = await alert.boundingBox();
          const meets = banner.x < focused.x + focused.width && focused.x < banner.x + banner.width &&
            banner.y < focused.y + focused.height && focused.y < banner.y + banner.height;
          if (meets) failures.push(`320x568: the banner covers ${label}, focused`);
        }
        // The whole matrix at once, rather than its first failure.
        expect(failures).toEqual([]);
      });
    }
  });
}
