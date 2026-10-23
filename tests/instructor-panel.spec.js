const { expect, test } = require('./helpers/pinned-seed.cjs');
const { beginDescent, descendTo, startDiveAndWaitForCanvas } = require('./helpers/start-dive.cjs');

// Legacy's instructor panel (#46), "PHYSICS LIVE" on L, in the migration
// client (#160): toggled by L or its button while diving, hidden under the
// gas information and the help, its values written every frame outside any
// live region and each toggle announced once. Its values and rules are
// tested in tests/unit/instructor-panel.test.ts (legacy's TC-46 cases).

const panel = (page) => page.locator('[data-instructor-panel]');
const toggle = (page) => page.locator('[data-instructor-toggle]');
const status = (page) => page.locator('[data-instructor-status]');
const row = (page, id) => panel(page).locator(`[data-instructor-row="${id}"] .instructor-value`);
const tec = (setup) => setup.locator('[data-setup-group=mode] [data-setup-option=tec]').check();

/** Counts the status region's writes from now on: one per toggle, none per frame. */
async function countWrites(page) {
  await status(page).evaluate((element) => {
    window.instructorWrites = 0;
    new MutationObserver((records) => {
      window.instructorWrites += records.length;
    }).observe(element, { childList: true, characterData: true, subtree: true });
  });
  return () => page.evaluate(() => window.instructorWrites);
}

test('by keyboard: L does nothing at the surface, toggles the panel while diving, which hides under the gas information and the help, and each toggle is announced once', async ({ page }) => {
  await page.goto('/dist/');
  await startDiveAndWaitForCanvas(page, tec);
  // TC-46-L-KEY-DIVING-ONLY: legacy's 'surface' state takes no L, and shows no button.
  await expect(toggle(page)).toBeHidden();
  await page.keyboard.press('l');
  await expect(panel(page)).toBeHidden();
  await expect(status(page)).toHaveText('');

  await descendTo(page, 2);
  // TC-46-DEFAULT-OFF: offered, and off.
  await expect(toggle(page)).toBeVisible();
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(panel(page)).toBeHidden();
  const writes = await countWrites(page);

  // TC-46-L-KEY-TOGGLE: l and L.
  await page.keyboard.press('l');
  await expect(page.getByRole('region', { name: 'PHYSICS LIVE' })).toBeVisible();
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(status(page)).toHaveText('Physics live shown');
  await expect(status(page)).toHaveAttribute('role', 'status');
  // The values are no live region; they follow the dive every frame.
  await expect(panel(page)).not.toHaveAttribute('aria-live', /.+/);
  await expect(panel(page)).not.toHaveAttribute('role', /.+/);
  const [depthM, pressureBar] = await page.evaluate(() => [
    Number.parseFloat(document.querySelector('.wreck-hud [data-hud-metric="depth"] dd').textContent),
    Number.parseFloat(document.querySelector('[data-instructor-row="pressure"] .instructor-value').textContent),
  ]);
  expect(Math.abs(pressureBar - (1 + depthM / 10))).toBeLessThan(0.02);
  await page.waitForTimeout(1000);
  expect(await writes()).toBe(1);

  await page.keyboard.press('L');
  await expect(panel(page)).toBeHidden();
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(status(page)).toHaveText('Physics live hidden');
  await page.keyboard.press('l');
  await expect(panel(page)).toBeVisible();
  expect(await writes()).toBe(3);

  // TC-46-HIDES-UNDER-HELP: under the gas information and the help, as
  // legacy's drawScene() skips it there, and back once they close.
  await page.keyboard.press('i');
  await expect(page.locator('[data-gas-info]')).toBeVisible();
  await expect(panel(page)).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(panel(page)).toBeVisible();
  await page.keyboard.press('h');
  await expect(page.getByRole('dialog', { name: 'Controls' })).toBeVisible();
  await expect(page.locator('[data-help-row="instructor.open"]')).toContainText('Learn: physics live');
  await expect(panel(page)).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(panel(page)).toBeVisible();
  // Only the toggles were announced.
  expect(await writes()).toBe(3);
});

const SAVE_KEY = 'diving-simulator.save-game';

/** The page's frames, stepped by hand (tests/shark.spec.js PIN_FRAMES). */
const PIN_FRAMES = () => {
  let now = 0;
  let queue = [];
  window.requestAnimationFrame = (callback) => queue.push(callback);
  window.cancelAnimationFrame = () => {};
  window.performance.now = () => now;
  window.__stepFrames = (frames) => {
    for (let i = 0; i < frames; i += 1) {
      now += 1000 / 60;
      const due = queue;
      queue = [];
      for (const callback of due) callback(now);
    }
  };
};

/** The save of a dive under way, taken once its clock has run. */
async function savedDive(page, mode) {
  await page.goto('/dist/');
  await page.locator('[data-accept-safety]').click();
  await page.locator(`[data-setup-group=mode] [data-setup-option=${mode}]`).check();
  await page.locator('[data-start-dive]').click();
  await page.locator('[data-renderer=pixi] canvas').waitFor();
  await descendTo(page, 1);
  return page
    .waitForFunction((key) => {
      const parsed = JSON.parse(window.localStorage.getItem(key) ?? 'null');
      return parsed !== null && parsed.state.elapsedTimeS > 0 ? parsed : null;
    }, SAVE_KEY)
    .then((handle) => handle.jsonValue());
}

/** Resumes an edited save, on frames stepped by hand unless `live`. */
async function resume(page, saved, { live = false, hints = true } = {}) {
  if (!live) await page.addInitScript(PIN_FRAMES);
  await page.goto('/dist/');
  await page.evaluate(([key, value, quiet]) => {
    window.localStorage.setItem(key, value);
    if (quiet) window.localStorage.setItem('diveSim_hintsDone', '1');
    else window.localStorage.setItem('diveSim_hint_bcd', '1');
  }, [SAVE_KEY, JSON.stringify(saved), !hints]);
  await page.locator('[data-accept-safety]').click();
  await page.locator('[data-resume-continue]').click();
  await page.locator('[data-renderer=pixi] canvas').waitFor();
  if (!live) await page.evaluate(() => window.__stepFrames(10));
}

/**
 * What the panel hides or crowds, or what hides it: every HUD row topmost at
 * its left, middle and right; the onboarding hint's lines topmost; the
 * panel's heading topmost; the panel 8 px from every control; and its button
 * a 44 px target on screen, 8 px from its neighbours.
 */
function layoutProblems() {
  const problems = [];
  const topmost = (element, x, y, name) => {
    const hit = document.elementFromPoint(x, y);
    if (!element.contains(hit)) problems.push(`${name} under ${hit?.className ?? 'nothing'}`);
  };
  const hint = document.querySelector('[data-onboarding-hint]');
  hint.style.pointerEvents = 'auto';
  try {
    for (const cell of document.querySelectorAll('.wreck-hud > div:not([hidden]) > :is(dt, dd)')) {
      const r = cell.getBoundingClientRect();
      if (r.width === 0) continue;
      for (const x of [r.left + 2, r.left + r.width / 2, r.right - 2]) {
        topmost(cell, x, r.top + r.height / 2, `${cell.parentElement.dataset.hudMetric} ${cell.tagName}`);
      }
    }
    const range = document.createRange();
    range.selectNodeContents(hint);
    for (const line of range.getClientRects()) {
      topmost(hint, line.left + line.width / 2, line.top + line.height / 2, 'a line of the hint');
    }
    const heading = document.querySelector('.instructor-heading').getBoundingClientRect();
    topmost(document.querySelector('.instructor-heading'), heading.left + 4, heading.top + heading.height / 2, 'the panel\'s heading');
    const box = document.querySelector('[data-instructor-panel]').getBoundingClientRect();
    const gap = (a, b) => Math.max(a.top - b.bottom, b.top - a.bottom, a.left - b.right, b.left - a.right);
    const button = document.querySelector('[data-instructor-toggle]');
    const own = button.getBoundingClientRect();
    if (own.width < 44 || own.height < 44) problems.push(`the button is ${own.width}x${own.height}`);
    if (own.left < 0 || own.right > window.innerWidth) problems.push('the button is off screen');
    for (const control of document.querySelectorAll('.wreck-shell button')) {
      if (control.getClientRects().length === 0) continue;
      const c = control.getBoundingClientRect();
      const name = control.getAttribute('aria-label') ?? control.textContent;
      if (gap(c, box) < 8) problems.push(`${name} ${Math.round(gap(c, box))} px from the panel`);
      if (control !== button && gap(c, own) < 8) problems.push(`${name} ${Math.round(gap(c, own))} px from the button`);
    }
  } finally {
    hint.style.pointerEvents = '';
  }
  return problems;
}

// German, at a paused safety stop at 9 m: the HUD at its tallest, with the
// stop row, and the stop's hint, the longest, beside it (tests/onboarding-hints.spec.js).
for (const mode of ['rec', 'ccr']) {
  test.describe(`in German, on a ${mode} dive at a paused safety stop`, () => {
    test.use({ locale: 'de-DE' });

    test('the panel shows legacy\'s values and covers no HUD row, hint or control at any size', async ({ page }) => {
      test.setTimeout(120_000);
      const saved = await savedDive(page, mode);
      const pressureBar = 1.9;
      Object.assign(saved.state, {
        depthM: 9,
        maxDepthM: 20,
        verticalVelocityMpm: 0,
        bcdGasSurfaceLiters: (7 + 2 - 3 - 5 * Math.pow(1 / pressureBar, 0.7)) * pressureBar,
        safetyStop: { needed: true, countdownStarted: true, remainingS: 172, paused: true, complete: false },
      });
      await resume(page, saved);
      await expect(page.locator('.wreck-hud [data-hud-metric="safetyStop"] dd')).toContainText('paused');
      await page.keyboard.press('l');
      await expect(page.getByRole('region', { name: 'PHYSIK LIVE' })).toBeVisible();
      await expect(status(page)).toHaveText('Physik live eingeblendet');
      // 1 + 9 / 10; the neutral BCD's 5.34 L at 1.9 bar is 2.81 L; AMV 15 × 1.9;
      // MOD of air at 1.4 bar, (1.4 / 0.21 - 1) × 10; END on air, the depth.
      await expect(row(page, 'pressure')).toHaveText('1,90 bar');
      await expect(row(page, 'bcd').locator('[aria-hidden=true]')).toHaveText('5,3 L / 2,8 L');
      await expect(row(page, 'bcd').locator('.visually-hidden')).toHaveText('Oberflächen-äquiv. 5,3 L, effektiv jetzt 2,8 L');
      await expect(row(page, 'consumption')).toHaveText('28,5 L/min (×1,9)');
      await expect(row(page, 'gas')).toHaveText(/^MOD 57\sm \| END 9\sm \| N 0\s%$/);
      await expect(panel(page).locator('[data-instructor-row="pressure"] dt')).toHaveText('Umgebungsdruck');
      await expect(page.locator('[data-onboarding-hint]')).toContainText('Sicherheitsstopp');
      for (const [width, height] of [[844, 390], [667, 375], [390, 844], [360, 640], [1280, 720]]) {
        await page.setViewportSize({ width, height });
        expect(await page.evaluate(layoutProblems), `${width}x${height}`).toEqual([]);
      }
    });
  });
}

test.describe('by touch, in German, on a phone', () => {
  test.use({ locale: 'de-DE', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('its button, offered only under water, is a 44 px target that toggles the panel', async ({ page }) => {
    const saved = await savedDive(page, 'rec');
    await resume(page, saved, { live: true, hints: false });
    await expect(toggle(page)).toBeVisible();
    await expect(toggle(page)).toHaveAccessibleName('Lernen: Physik live');
    await toggle(page).tap();
    await expect(page.getByRole('region', { name: 'PHYSIK LIVE' })).toBeVisible();
    await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(status(page)).toHaveText('Physik live eingeblendet');
    expect(await page.evaluate(layoutProblems)).toEqual([]);
    await toggle(page).tap();
    await expect(panel(page)).toBeHidden();
    await expect(status(page)).toHaveText('Physik live ausgeblendet');
  });
});

test('TC-46-DEFAULT-OFF: a new dive keeps the panel on, as legacy\'s resetDive() keeps instructorMode, and a new page starts with it off', async ({ page }) => {
  test.setTimeout(120_000);
  const saved = await savedDive(page, 'rec');
  // A dive past 2 m and half a minute, a metre under: up with W, it ends at the surface.
  Object.assign(saved.state, { depthM: 1, maxDepthM: 5, elapsedTimeS: 120, verticalVelocityMpm: 0 });
  await resume(page, saved, { live: true, hints: false });
  await page.keyboard.press('l');
  await expect(panel(page)).toBeVisible();
  await page.keyboard.down('w');
  await page.locator('[data-post-dive]').waitFor({ timeout: 60_000 });
  await page.keyboard.up('w');
  await page.locator('[data-dive-again]').click();
  await page.locator('[data-start-dive]').click();
  await page.locator('[data-renderer=pixi] canvas').waitFor();
  // At the surface it is neither offered nor shown, then back with the dive.
  await expect(toggle(page)).toBeHidden();
  await expect(panel(page)).toBeHidden();
  await beginDescent(page);
  await expect(panel(page)).toBeVisible();
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');

  await page.reload();
  await startDiveAndWaitForCanvas(page);
  await descendTo(page, 1);
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(panel(page)).toBeHidden();
});
