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
 * Waits until the HUD's height on the side, which places the panel on a
 * phone (trackHudHeight), is the HUD's height now: a ResizeObserver writes
 * it after the layout a resize starts. Polled on a timer, as some cases step
 * the page's animation frames by hand.
 */
async function hudHeightSettled(page) {
  await page.waitForFunction(() => {
    const side = document.querySelector('.wreck-side');
    const hud = document.querySelector('.wreck-hud');
    return getComputedStyle(side).getPropertyValue('--wreck-hud-height').trim() === `${hud.offsetHeight}px`;
  }, undefined, { polling: 50 });
}

/** Resizes the page and waits for the panel's place to follow. */
async function resizeTo(page, width, height) {
  await page.setViewportSize({ width, height });
  await hudHeightSettled(page);
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
      // On the loop no open circuit is breathed: no consumption and no MOD,
      // never the setup cylinder's (#183, #192).
      await expect(row(page, 'pressure')).toHaveText('1,90 bar');
      await expect(row(page, 'bcd').locator('[aria-hidden=true]')).toHaveText('5,3 L / 2,8 L');
      await expect(row(page, 'bcd').locator('.visually-hidden')).toHaveText('Oberflächen-äquiv. 5,3 L, effektiv jetzt 2,8 L');
      await expect(row(page, 'consumption')).toHaveText(mode === 'ccr' ? '—' : '28,5 L/min (×1,9)');
      await expect(row(page, 'gas')).toHaveText(mode === 'ccr' ? /^MOD — \| END 9\sm \| N 0\s%$/ : /^MOD 57\sm \| END 9\sm \| N 0\s%$/);
      await expect(panel(page).locator('[data-instructor-row="pressure"] dt')).toHaveText('Umgebungsdruck');
      await expect(page.locator('[data-onboarding-hint]')).toContainText('Sicherheitsstopp');
      for (const [width, height] of [[844, 390], [667, 375], [390, 844], [360, 640], [1280, 720]]) {
        await resizeTo(page, width, height);
        expect(await page.evaluate(layoutProblems), `${width}x${height}`).toEqual([]);
      }
    });
  });
}

/**
 * Where the panel meets the diver, at each route position given, facing
 * either way, at every whole depth from the surface to the route's deepest
 * floor, 34 m. The diver is placed as the wreck camera places it
 * (src/render/camera.ts): 58 m across, the focus 8 m ahead and held within
 * the scene's bounds, x 29 to 87 for the 0 to 116 m scene and depth -6 to
 * 40, or at their middle where the view is larger; its body
 * (src/render/pixi-renderer.ts) from 2.15 m behind its centre to 1.2 m ahead,
 * 0.53 m above to 0.62 m below. With `unclampedOnly`, a position and facing
 * whose focus the bounds hold is left out.
 */
function panelOverDiver([positions, unclampedOnly]) {
  const viewport = document.querySelector('[data-wreck-viewport]').getBoundingClientRect();
  const panel = document.querySelector('[data-instructor-panel]').getBoundingClientRect();
  const scale = viewport.width / 58;
  const halfHeightM = viewport.height / scale / 2;
  const clamp = (value, low, high, middle) => (low > high ? middle : Math.min(high, Math.max(low, value)));
  const hits = [];
  let probed = 0;
  for (const positionM of positions) {
    for (const facing of [1, -1]) {
      const wantedX = positionM + facing * 8;
      const focusX = clamp(wantedX, 29, 87, 58);
      if (unclampedOnly && focusX !== wantedX) continue;
      probed += 1;
      for (let depthM = 0; depthM <= 34; depthM += 1) {
        const focusY = clamp(depthM, -6 + halfHeightM, 40 - halfHeightM, 17);
        const x = viewport.left + viewport.width / 2 + (positionM - focusX) * scale;
        const y = viewport.top + viewport.height / 2 + (depthM - focusY) * scale;
        const left = x - (facing > 0 ? 2.15 : 1.2) * scale;
        const right = x + (facing > 0 ? 1.2 : 2.15) * scale;
        if (left < panel.right && right > panel.left && y - 0.53 * scale < panel.bottom && y + 0.62 * scale > panel.top) {
          hits.push(`x ${positionM} facing ${facing} at ${depthM} m`);
        }
      }
    }
  }
  return { probed, hits };
}

/** The route's positions, every whole metre from 8 to 106 m (src/sites/wreck-route.ts). */
const ROUTE_M = Array.from({ length: 99 }, (_, index) => 8 + index);

test('the panel stands over no part of the diver wherever the camera leads it, either way it faces, at any depth', async ({ page }) => {
  test.setTimeout(120_000);
  const saved = await savedDive(page, 'rec');
  // In the cargo hold, where legacy's wreck-thirds recorded x 50 at 32 m (docs/decisions.md, #222).
  Object.assign(saved, { routePositionM: 50 });
  Object.assign(saved.state, { depthM: 32, maxDepthM: 32, verticalVelocityMpm: 0 });
  await resume(page, saved, { hints: false });
  await expect(page.locator('.wreck-hud [data-hud-metric="zone"] dd')).toHaveText('Cargo hold');
  await page.keyboard.press('l');
  await expect(panel(page)).toBeVisible();
  // Wide screens: every position where the camera's focus is free, x 21-79
  // facing right and x 37-95 facing left. Where the bounds hold it, the
  // diver drifts towards the stage's edges: at the bow under the HUD, and at
  // the stern, from x 98-105 depending on the width, under this panel. That
  // stern range is #271's, so it is not probed here.
  for (const [width, height] of [[1280, 720], [1366, 768], [1440, 900], [1920, 1080]]) {
    await resizeTo(page, width, height);
    const { probed, hits } = await page.evaluate(panelOverDiver, [ROUTE_M, true]);
    expect(probed, `${width}x${height}`).toBe(59 + 59);
    expect(hits, `${width}x${height}`).toEqual([]);
    expect(await page.evaluate(layoutProblems), `${width}x${height}`).toEqual([]);
  }
  // Phones in portrait: the panel is below the diver's deepest line, so the
  // whole route, wherever the camera holds its focus sideways.
  for (const [width, height] of [[390, 844], [360, 640]]) {
    await resizeTo(page, width, height);
    const { probed, hits } = await page.evaluate(panelOverDiver, [ROUTE_M, false]);
    expect(probed, `${width}x${height}`).toBe(2 * ROUTE_M.length);
    expect(hits, `${width}x${height}`).toEqual([]);
    expect(await page.evaluate(layoutProblems), `${width}x${height}`).toEqual([]);
  }
});

// Legacy's drill decision and debriefing are its 'drill' state, not
// 'diving' (src/game-loop.js _openDrillOverlay, dismissDrillDebrief), so
// its L does nothing and drawScene() draws no panel there.
test('a training drill hides the panel and its button and takes no L, and the panel is back after it', async ({ page }) => {
  test.setTimeout(120_000);
  const saved = await savedDive(page, 'rec');
  const pressureBar = 1 + 20 / 10;
  // Where a drill may fire (tests/drills.spec.js): 4 dive minutes in, neutral at 20 m.
  Object.assign(saved.state, {
    depthM: 20,
    maxDepthM: 20,
    elapsedTimeS: 240,
    verticalVelocityMpm: 0,
    bcdGasSurfaceLiters: (7 + 2 - 3 - 5 * Math.pow(1 / pressureBar, 0.7)) * pressureBar,
  });
  await page.addInitScript(PIN_FRAMES);
  await page.goto('/dist/');
  await page.evaluate(([key, value]) => {
    window.localStorage.setItem(key, value);
    window.localStorage.setItem('diveSim_hintsDone', '1');
  }, [SAVE_KEY, JSON.stringify(saved)]);
  await page.locator('[data-accept-safety]').click();
  await page.locator('[data-setup-drills]').click();
  await page.locator('[data-resume-continue]').click();
  await page.locator('[data-renderer=pixi] canvas').waitFor();
  await page.evaluate(() => window.__stepFrames(1));
  await page.keyboard.press('l');
  await expect(panel(page)).toBeVisible();

  const decision = page.locator('[data-drill-overlay]');
  await page.waitForFunction(() => {
    window.__stepFrames(5);
    return document.querySelector('[data-drill-overlay]')?.open === true;
    // Polled on a timer: the page's animation frames are the test's.
  }, undefined, { polling: 50, timeout: 60_000 });
  await expect(decision).toBeVisible();
  await expect(panel(page)).toBeHidden();
  await expect(toggle(page)).toBeHidden();
  await page.keyboard.press('l');
  await page.keyboard.press('1');
  await page.evaluate(() => window.__stepFrames(2));
  await expect(panel(page)).toBeHidden();
  await page.keyboard.press('l');
  await page.keyboard.press('Enter');
  await page.evaluate(() => window.__stepFrames(2));
  await expect(decision).not.toBeVisible();
  // Still on: neither L under the drill toggled it.
  await expect(panel(page)).toBeVisible();
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(status(page)).toHaveText('Physics live shown');
});

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
    await hudHeightSettled(page);
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
