const { expect, test } = require('@playwright/test');
const { descendTo } = require('./helpers/start-dive.cjs');

// Legacy's last three dive-computer banners (#228, src/renderer.js
// drawDiveComputer, the highestWarn chain): above the ceiling, low NDL and
// narcosis, and the gas reserve split from low gas. Like the rest of the dive
// computer they read English in every language (#232), so each runs in an
// English and a German browser. Legacy's hasWarning beeps for the ceiling,
// the reserve and narcosis, not for a low NDL; the reserve and narcosis up to
// 0.70 are its cautions (warnCritical = false). The alarm is legacy's only
// square-wave cue (src/audio/audio-policy.ts), counted as its oscillators
// start.

const SAVE_KEY = 'diving-simulator.save-game';

/** A dive resumed from its own save, changed by `mutate`, past either gate. */
async function resumeWith(page, mutate) {
  await page.addInitScript(() => {
    window.__alarms = 0;
    const start = OscillatorNode.prototype.start;
    OscillatorNode.prototype.start = function (...args) {
      if (this.type === 'square') {
        window.__alarms += 1;
      }
      return start.apply(this, args);
    };
  });
  for (const step of ['first', 'resume']) {
    await page.goto('/dist/');
    if (step === 'first') {
      await page.evaluate(() => window.localStorage.clear());
    }
    await page.locator('[data-accept-safety]').click();
    await page.locator('.setup-screen').waitFor();
    await page.locator('[data-start-dive]').click();
    await page.locator('[data-renderer=pixi] canvas').waitFor();
    if (step === 'resume') {
      return;
    }
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
  }
}

const alarms = (page) => page.evaluate(() => window.__alarms);

// Air at 25 m for 11.5 min from the surface's 0.7405 bar: no ceiling, an
// NDL of 3 min at 25 m and GF 75 (src/core/decompression.ts ndlMinutes).
const NEAR_NDL_NITROGEN_BAR = [
  2.314, 1.986, 1.672, 1.432, 1.245, 1.112, 1.01, 0.935, 0.88, 0.845, 0.823, 0.805, 0.791, 0.78, 0.772, 0.765,
];

const cases = [
  {
    name: 'above the ceiling',
    // tests/hud-readouts.spec.js's deco tissues put the first stop at 18 m;
    // the diver is at 12 m, a little heavy.
    mutate: (state) => {
      state.depthM = 12;
      state.maxDepthM = 34;
      state.verticalVelocityMpm = 0;
      state.bcdGasSurfaceLiters = 7.5;
      state.tissues.nitrogenBar = state.tissues.nitrogenBar.map(() => 3);
    },
    alert: 'Above ceiling — descend',
    chip: '⚠ Above ceiling',
    beeps: true,
    tier: 'critical',
  },
  {
    name: 'the gas reserve',
    // 40 bar: under legacy's 50 bar reserve, over its 30 bar low gas.
    mutate: (state) => {
      const tank = state.tanks[state.activeTankIndex];
      tank.gasRemainingL = tank.volumeL * 40;
    },
    alert: 'Gas reserve',
    chip: '⚠ Gas reserve',
    beeps: true,
    tier: 'caution',
  },
  {
    name: 'a low NDL',
    mutate: (state) => {
      state.depthM = 25;
      state.maxDepthM = 25;
      state.verticalVelocityMpm = 0;
      state.bcdGasSurfaceLiters = 12;
      state.tissues.nitrogenBar = [...NEAR_NDL_NITROGEN_BAR];
    },
    alert: 'Low NDL',
    chip: '⚠ Low NDL',
    beeps: false,
    tier: 'critical',
  },
  {
    name: 'narcosis',
    // At 35 m on air the index settles at 0.24, over the 0.20 caution.
    mutate: (state) => {
      state.depthM = 35;
      state.maxDepthM = 35;
      state.verticalVelocityMpm = 0;
      state.bcdGasSurfaceLiters = 15;
      state.narcosisIndex = 0.5;
    },
    alert: 'Narcosis',
    chip: '⚠ Narcosis',
    beeps: true,
    tier: 'caution',
  },
];

for (const locale of ['en-US', 'de-DE']) {
  test.describe(`in ${locale}`, () => {
    test.use({ locale });

    for (const { name, mutate, alert: alertText, chip: chipText, beeps, tier } of cases) {
      test(`${name} warns in English as a ${tier}${beeps ? ', with the alarm' : ', silently'}`, async ({ page }) => {
        await resumeWith(page, mutate);
        const alert = page.getByRole('alert');
        await expect(alert).toHaveText(alertText, { timeout: 15_000 });
        await expect(alert).toHaveAttribute('lang', 'en');
        const chip = page.locator('.status-chip');
        await expect(chip).toHaveText(chipText);
        await expect(chip).toHaveAttribute('lang', 'en');
        // Legacy's warnCritical: red, or its amber caution, which a dashed
        // border also tells apart without colour.
        for (const element of [alert, chip]) {
          await expect(element).toHaveAttribute('data-tier', tier);
          await expect(element).toHaveCSS('border-top-style', tier === 'caution' ? 'dashed' : 'solid');
          await expect(element).toHaveCSS(
            'background-color',
            tier === 'caution' ? 'rgb(38, 26, 0)' : 'rgb(169, 40, 40)',
          );
        }
        if (beeps) {
          await expect.poll(() => alarms(page), { timeout: 10_000 }).toBeGreaterThan(0);
        } else {
          // The alarm repeats every 5 s while it is due: two periods, still on the warning.
          await page.waitForTimeout(6_000);
          await expect(alert).toHaveText(alertText);
          expect(await alarms(page)).toBe(0);
        }
      });
    }
  });
}
