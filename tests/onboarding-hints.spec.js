const { expect, test } = require('./helpers/pinned-seed.cjs');
const { descendTo, startDiveAndWaitForCanvas } = require('./helpers/start-dive.cjs');

// The onboarding hints (#160): legacy's #38 toasts as a status region over
// the stage, each shown once per browser, for 6 s, hidden under the gas
// information and the help, and stopped for good by the help's "Don't show
// hints again". The triggers themselves are tested in
// src/app/onboarding-hints.test.ts; the BCD hint, the one every dive meets,
// stands for them here.

const BCD_EN = 'W/S control BCD buoyancy — short bursts, then trim out';
const BCD_DE = 'W/S steuern die Tarierweste — kurze Stöße, dann austrimmen';
const toast = (page) => page.locator('[data-onboarding-hint]');
const dismiss = (page) => page.locator('[data-help-overlay] [data-hint-dismiss]');
const flag = (page, key) => page.evaluate((k) => window.localStorage.getItem(k), key);

/** Counts the region's writes from now on: one per change, none per frame. */
async function countWrites(page) {
  await toast(page).evaluate((element) => {
    window.hintWrites = 0;
    new MutationObserver((records) => {
      window.hintWrites += records.length;
    }).observe(element, { childList: true, characterData: true, subtree: true });
  });
  return () => page.evaluate(() => window.hintWrites);
}

test('by keyboard: shown once past 2 m and announced once, hidden under the gas information and the help, then dismissed for good', async ({ page }) => {
  await page.goto('/dist/');
  await startDiveAndWaitForCanvas(page, (setup) => setup.locator('[data-setup-group=mode] [data-setup-option=tec]').check());
  await expect(toast(page)).toHaveAttribute('role', 'status');
  await expect(toast(page)).toHaveText('');
  const writes = await countWrites(page);

  await descendTo(page, 3);
  await expect(toast(page)).toHaveText(BCD_EN);
  expect(await flag(page, 'diveSim_hint_bcd')).toBe('1');
  // Written once, and not again while it shows.
  await page.waitForTimeout(1000);
  expect(await writes()).toBe(1);

  // Not drawn over the gas information, nor under the help, as legacy's.
  await page.keyboard.press('i');
  await expect(toast(page)).toHaveText('');
  await page.keyboard.press('Escape');
  await expect(toast(page)).toHaveText(BCD_EN);
  await page.keyboard.press('h');
  await expect(toast(page)).toHaveText('');
  await page.keyboard.press('Escape');
  await expect(toast(page)).toHaveText(BCD_EN);
  // Its last half second fades, as legacy's alpha min(1, time / 0.5), and
  // fading writes nothing to the region.
  const shownWrites = await writes();
  await page.waitForFunction(() => {
    const element = document.querySelector('[data-onboarding-hint]');
    const opacity = Number(getComputedStyle(element).opacity);
    return element.textContent !== '' && opacity > 0 && opacity < 1;
  }, undefined, { timeout: 10_000 });
  expect(await writes()).toBe(shownWrites);
  // Gone after its 6 s, and not shown again this dive.
  await expect(toast(page)).toHaveText('', { timeout: 10_000 });
  expect(await writes()).toBe(shownWrites + 1);
  await expect(toast(page)).toHaveCSS('opacity', '1');
  const settled = await writes();
  await page.waitForTimeout(1500);
  expect(await writes()).toBe(settled);

  // Tab from Close reaches the opt-out, and Enter takes it.
  await page.keyboard.press('h');
  await page.keyboard.press('Tab');
  await expect(dismiss(page)).toBeFocused();
  await expect(dismiss(page)).toHaveText('Don’t show hints again');
  await page.keyboard.press('Enter');
  await expect(dismiss(page)).toHaveCount(0);
  await expect(page.locator('[data-help-close]')).toBeFocused();
  expect(await flag(page, 'diveSim_hintsDone')).toBe('1');
  await page.keyboard.press('Escape');

  // The next visit, with the BCD hint unseen: the opt-out alone holds it back.
  await page.evaluate(() => window.localStorage.removeItem('diveSim_hint_bcd'));
  await page.reload();
  await startDiveAndWaitForCanvas(page);
  const after = await countWrites(page);
  await descendTo(page, 3);
  await page.waitForTimeout(1500);
  await expect(toast(page)).toHaveText('');
  expect(await after()).toBe(0);
  expect(await flag(page, 'diveSim_hint_bcd')).toBeNull();
  await page.keyboard.press('h');
  await expect(page.getByRole('dialog', { name: 'Controls' })).toBeVisible();
  await expect(dismiss(page)).toHaveCount(0);
});

const SAVE_KEY = 'diving-simulator.save-game';

/** The page's frames, stepped by hand (tests/shark.spec.js PIN_FRAMES), so a hint stays up while it is measured. */
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

/**
 * A dive in `mode` resumed at 9 m, neutral, its safety stop paused, so the
 * stop row shows (tests/in-dive-controls.spec.js resumeGermanAtPausedStop),
 * on frames stepped by hand. The BCD hint is marked seen, so the first hint
 * is the safety stop's, in German the longest. `edit` changes the saved
 * state before the dive is resumed.
 */
async function resumeAtPausedStop(page, mode, edit = () => {}) {
  await page.goto('/dist/');
  await page.locator('[data-accept-safety]').click();
  await page.locator(`[data-setup-group=mode] [data-setup-option=${mode}]`).check();
  await page.locator('[data-start-dive]').click();
  await page.locator('[data-renderer=pixi] canvas').waitFor();
  await descendTo(page, 1);
  const saved = await page
    .waitForFunction((key) => {
      const parsed = JSON.parse(window.localStorage.getItem(key) ?? 'null');
      return parsed !== null && parsed.state.elapsedTimeS > 0 ? parsed : null;
    }, SAVE_KEY)
    .then((handle) => handle.jsonValue());
  const pressureBar = 1 + 9 / 10;
  Object.assign(saved.state, {
    depthM: 9,
    maxDepthM: 20,
    verticalVelocityMpm: 0,
    bcdGasSurfaceLiters: (7 + 2 - 3 - 5 * Math.pow(1 / pressureBar, 0.7)) * pressureBar,
    safetyStop: { needed: true, countdownStarted: true, remainingS: 172, paused: true, complete: false },
  });
  edit(saved.state);
  await page.addInitScript(PIN_FRAMES);
  await page.goto('/dist/');
  await page.evaluate(([key, value]) => {
    window.localStorage.setItem(key, value);
    window.localStorage.setItem('diveSim_hint_bcd', '1');
  }, [SAVE_KEY, JSON.stringify(saved)]);
  await page.locator('[data-accept-safety]').click();
  await page.locator('[data-resume-continue]').click();
  await page.locator('[data-renderer=pixi] canvas').waitFor();
  await page.evaluate(() => window.__stepFrames(10));
  await expect(page.locator('.wreck-hud [data-hud-metric="safetyStop"] dd')).toContainText('paused');
}

/**
 * What hides or crowds the hint, or what it hides: every HUD row topmost at
 * its left, middle and right; each line of the hint's text topmost at its
 * start, middle and end; and the hint 8 px from every control.
 */
function layoutProblems() {
  const problems = [];
  const region = document.querySelector('[data-onboarding-hint]');
  // It takes no touch, so hit testing would pass through it: for the check
  // it takes it, so elementFromPoint finds it wherever it is on top.
  region.style.pointerEvents = 'auto';
  try {
    const hint = region.getBoundingClientRect();
    for (const cell of document.querySelectorAll('.wreck-hud > div:not([hidden]) > :is(dt, dd)')) {
      const r = cell.getBoundingClientRect();
      if (r.width === 0) continue;
      for (const x of [r.left + 2, r.left + r.width / 2, r.right - 2]) {
        const hit = document.elementFromPoint(x, r.top + r.height / 2);
        if (!cell.contains(hit)) problems.push(`${cell.parentElement.dataset.hudMetric} ${cell.tagName} under ${hit?.className ?? 'nothing'}`);
      }
    }
    const range = document.createRange();
    range.selectNodeContents(region);
    const lines = [...range.getClientRects()];
    if (lines.length === 0) problems.push('the hint has no text');
    for (const line of lines) {
      for (const x of [line.left + 1, line.left + line.width / 2, line.right - 1]) {
        const hit = document.elementFromPoint(x, line.top + line.height / 2);
        if (!region.contains(hit)) problems.push(`the hint's line at ${Math.round(x)},${Math.round(line.top)} under ${hit?.className ?? 'nothing'}`);
      }
    }
    for (const control of document.querySelectorAll('.wreck-shell button')) {
      if (control.getClientRects().length === 0) continue;
      const c = control.getBoundingClientRect();
      const gap = Math.max(c.top - hint.bottom, hint.top - c.bottom, c.left - hint.right, hint.left - c.right);
      if (gap < 8) problems.push(`${control.getAttribute('aria-label') ?? control.textContent} ${Math.round(gap)} px from the hint`);
    }
  } finally {
    region.style.pointerEvents = '';
  }
  return problems;
}

/**
 * Resizes the page and waits for the HUD's height on the shell, which
 * places the hint on a short screen held upright (trackHudHeight), to be
 * the HUD's height now: a ResizeObserver writes it after the layout a
 * resize starts. Polled on a timer, as the frames are stepped by hand.
 */
async function resizeTo(page, width, height) {
  await page.setViewportSize({ width, height });
  await page.waitForFunction(() => {
    const shell = document.querySelector('.wreck-shell');
    const hud = document.querySelector('.wreck-hud');
    return getComputedStyle(shell).getPropertyValue('--wreck-hud-height').trim() === `${hud.offsetHeight}px`;
  }, undefined, { polling: 50 });
}

/** The portrait phones of docs/decisions.md's layout contract, rule 1. */
const PORTRAIT_SIZES = [[320, 568], [340, 640], [360, 640], [375, 553], [375, 667], [390, 844]];

// Legacy draws its toast in drawScene() and its dive computer over it
// (src/game-loop.js gameLoop), so no hint hides a HUD row. Here it stands
// beside the HUD, so nothing hides it either; on a short screen held
// upright, where the HUD is as wide as the screen, it stands under the HUD
// beside Learn, and on a rebreather takes the place of the cylinder rows
// while it shows, never of the loop's PO2, setpoint or scrubber (#258,
// owner 2026-11-15).
const HIDDEN_WITH_HINT = { rec: [], ccr: ['cylinder', 'oxygenCylinder', 'diluentCylinder'] };
const LOOP_ROWS = ['setpoint', 'loopPo2', 'scrubber'];

/** The HUD's rows on screen, by name. */
const shownRows = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.wreck-hud > div')]
      .filter((row) => row.getClientRects().length > 0)
      .map((row) => row.dataset.hudMetric));

/** The least distance from the HUD to any shown control. */
const hudToControls = (page) =>
  page.evaluate(() => {
    const hud = document.querySelector('.wreck-hud').getBoundingClientRect();
    let nearest = Infinity;
    for (const control of document.querySelectorAll('.wreck-shell button')) {
      if (control.getClientRects().length === 0) continue;
      const c = control.getBoundingClientRect();
      nearest = Math.min(nearest, Math.max(c.top - hud.bottom, hud.top - c.bottom, c.left - hud.right, hud.left - c.right));
    }
    return nearest;
  });

const SAFETY_STOP_DE = 'Sicherheitsstopp: 3–5 min zwischen 2,4–8,3m halten, F = Zeitraffer';
for (const mode of ['rec', 'ccr']) {
  test.describe(`in German, on a ${mode} dive at a paused safety stop`, () => {
    test.use({ locale: 'de-DE' });

    test('the longest hint is wholly visible, under no HUD row and 8 px from every control, at every size', async ({ page }) => {
      test.setTimeout(120_000);
      await resumeAtPausedStop(page, mode);
      await expect(toast(page)).toHaveText(SAFETY_STOP_DE);
      for (const [width, height] of [[844, 390], [667, 375], ...PORTRAIT_SIZES, [1280, 720]]) {
        await resizeTo(page, width, height);
        expect(await page.evaluate(layoutProblems), `${width}x${height}`).toEqual([]);
      }
      // No frame ran while it was measured: the same hint is still up.
      await expect(toast(page)).toHaveText(SAFETY_STOP_DE);
    });

    test('on a short screen held upright the hint hides no loop row, and any row it hides is back as it goes', async ({ page }) => {
      test.setTimeout(120_000);
      await resumeAtPausedStop(page, mode);
      await expect(toast(page)).toHaveText(SAFETY_STOP_DE);
      // Wider and taller, the hint stands beside the HUD, which keeps every row.
      await resizeTo(page, 390, 844);
      const all = await shownRows(page);
      if (mode === 'ccr') expect(all).toEqual(expect.arrayContaining([...LOOP_ROWS, ...HIDDEN_WITH_HINT.ccr]));
      await resizeTo(page, 320, 568);
      const withHint = await shownRows(page);
      expect(withHint).toEqual(all.filter((row) => !HIDDEN_WITH_HINT[mode].includes(row)));
      // The loop's PO2 among them, on screen and topmost (owner, 2026-11-15).
      if (mode === 'ccr') {
        expect(withHint).toEqual(expect.arrayContaining(LOOP_ROWS));
        expect(await page.evaluate(() => {
          const row = document.querySelector('.wreck-hud [data-hud-metric="loopPo2"]').getBoundingClientRect();
          return document.elementFromPoint(row.left + row.width / 2, row.top + row.height / 2)?.closest('[data-hud-metric]')?.dataset.hudMetric;
        })).toBe('loopPo2');
      }
      expect(await page.evaluate(layoutProblems)).toEqual([]);
      // The hint's 6 s, then it is gone and the rows are back.
      await page.evaluate(() => window.__stepFrames(7 * 60));
      await expect(toast(page)).toHaveText('');
      await resizeTo(page, 320, 568);
      expect(await shownRows(page)).toEqual(all);
    });

    // The shell's side carries the safe-area insets (#137 A7), so the hint,
    // which stands beside the HUD in the shell's terms, must carry them too.
    test('the same holds with the safe-area insets a cutout and a gesture bar inject', async ({ page }) => {
      test.setTimeout(120_000);
      await resumeAtPausedStop(page, mode);
      await expect(toast(page)).toHaveText(SAFETY_STOP_DE);
      // Real phones: 844×390 with 47 px (iPhone 12–14), 812×375 with 44 px
      // (iPhone X–11 Pro). On these short screens the shell is held at its
      // 34rem minimum (#256), so a hint squeezed beside the HUD can run its
      // last line off the bottom of the screen (on linux CI at 812×375 with
      // 44 px, and at 844×390 with 59 px). That overflow, reported as "under
      // nothing", is #256's; everything else, the HUD or a control over the
      // hint in particular, must still not happen.
      const offScreen = (problem) => problem.startsWith("the hint's line") && problem.endsWith(' under nothing');
      const cases = [
        [844, 390, { top: 0, right: 47, bottom: 21, left: 47 }],
        [812, 375, { top: 0, right: 44, bottom: 21, left: 44 }],
        [390, 844, { top: 47, right: 0, bottom: 34, left: 0 }],
        [360, 640, { top: 0, right: 0, bottom: 24, left: 0 }],
        // A short screen held upright, where the hint stands under the HUD
        // (#258): an iPhone SE's status bar in an app.
        [320, 568, { top: 20, right: 0, bottom: 0, left: 0 }],
      ];
      for (const [width, height, inset] of cases) {
        await page.evaluate((edges) => {
          for (const [edge, px] of Object.entries(edges)) {
            document.documentElement.style.setProperty(`--safe-area-inset-${edge}`, `${px}px`);
          }
        }, inset);
        await resizeTo(page, width, height);
        const problems = await page.evaluate(layoutProblems);
        // The allowance is #256's, short landscape only.
        const short = height <= 600 && width > height;
        expect(short ? problems.filter((p) => !offScreen(p)) : problems, `${width}x${height} ${JSON.stringify(inset)}`).toEqual([]);
      }
    });
  });
}

// A warning on a rebreather, here an O2 cylinder under 30 bar, which ranks
// last among the rebreather's warnings: no row is hidden for a hint while
// any warning shows or any row is in its danger state, so the low row is
// never the one a hint hides. On a short screen held upright there is then
// no room under the HUD, so the hint is not drawn there, but it is still
// written to its status region and announced (#258, owner 2026-11-15).
test.describe('in German, on a ccr dive with its O2 cylinder low', () => {
  test.use({ locale: 'de-DE' });

  test('on a short screen held upright a hint hides no row, is not drawn, and is still announced', async ({ page }) => {
    test.setTimeout(120_000);
    await resumeAtPausedStop(page, 'ccr', (state) => {
      state.ccr.oxygenCylinderPressureBar = 25;
    });
    await expect(toast(page)).toHaveText(SAFETY_STOP_DE);
    await expect(page.locator('.wreck-hud [data-hud-metric="oxygenCylinder"]')).toHaveAttribute('data-danger', '');
    await resizeTo(page, 390, 844);
    const all = await shownRows(page);
    expect(all).toEqual(expect.arrayContaining([...LOOP_ROWS, ...HIDDEN_WITH_HINT.ccr]));
    for (const [width, height] of [[320, 568], [375, 553]]) {
      await resizeTo(page, width, height);
      expect(await shownRows(page), `${width}x${height}`).toEqual(all);
      // In the status region still, and drawn nowhere.
      await expect(toast(page)).toHaveText(SAFETY_STOP_DE);
      await expect(toast(page)).toHaveAttribute('role', 'status');
      const box = await toast(page).boundingBox();
      expect(box.width * box.height, `${width}x${height}`).toBeLessThanOrEqual(1);
      expect(await hudToControls(page), `${width}x${height}`).toBeGreaterThanOrEqual(8);
    }
    // Where there is room the hint is drawn as before.
    await resizeTo(page, 390, 844);
    expect(await page.evaluate(layoutProblems)).toEqual([]);
  });
});

test.describe('by touch, in German, on a phone', { tag: '@chromium-only' }, () => {
  test.use({ locale: 'de-DE', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('the D-pad takes the dive past 2 m, the hint shows, and the help\'s opt-out is a 44 px target that stops it', async ({ page }) => {
    await page.goto('/dist/');
    // The gate by its data attribute: its name is German here.
    await page.locator('[data-accept-safety]').tap();
    await page.locator('[data-start-dive]').tap();
    await page.locator('[data-renderer=pixi] canvas').waitFor();
    const descend = page.locator('.wreck-controls [data-control="descend"]');
    const box = await descend.boundingBox();
    const cdp = await page.context().newCDPSession(page);
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2, id: 1 };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    await expect(toast(page)).toHaveText(BCD_DE, { timeout: 60_000 });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

    await page.locator('[data-help-open]').tap();
    await expect(page.getByRole('dialog', { name: 'Steuerung' })).toBeVisible();
    await expect(toast(page)).toHaveText('');
    await expect(dismiss(page)).toHaveText('Hinweise nicht mehr anzeigen');
    // The #121 geometry: 44 px, and 8 px from Close and the rest.
    const boxes = await page.locator('[data-help-overlay] button').evaluateAll((buttons) =>
      buttons.map((el) => el.getBoundingClientRect()).map((r) => ({ x: r.x, y: r.y, w: r.width, h: r.height })));
    expect(boxes).toHaveLength(2);
    for (const b of boxes) expect(Math.min(b.w, b.h)).toBeGreaterThanOrEqual(44);
    await dismiss(page).scrollIntoViewIfNeeded();
    const [a, b] = await page.locator('[data-help-overlay] button').evaluateAll((buttons) =>
      buttons.map((el) => el.getBoundingClientRect()).map((r) => ({ top: r.top, bottom: r.bottom })));
    expect(Math.max(b.top - a.bottom, a.top - b.bottom)).toBeGreaterThanOrEqual(8);

    await dismiss(page).tap();
    await expect(dismiss(page)).toHaveCount(0);
    expect(await flag(page, 'diveSim_hintsDone')).toBe('1');
    await page.locator('[data-help-close]').tap();
    // The hint that was showing is gone with the opt-out.
    // Read at once: a wait could outlast its 6 s.
    await page.waitForTimeout(500);
    expect(await toast(page).textContent()).toBe('');
  });
});
