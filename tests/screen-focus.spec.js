const { expect, test } = require('./helpers/pinned-seed.cjs');
const {
  acceptSafetyGate,
  beginDescent,
  descendTo,
  startDive,
  startDiveByKeyboard,
} = require('./helpers/start-dive.cjs');

// Focus follows the screen (#311). A screen that replaces another moves focus
// to its heading, as the game-over and debriefing screens do (#138): the
// control that had it is gone, and focus left on a removed element tells a
// keyboard or screen-reader user nothing. docs/decisions.md, departures
// table, the #311 row.

const SAVE_KEY = 'diving-simulator.save-game';

const LIVE = [
  '[aria-live]:not([aria-live="off"])',
  '[role=alert]',
  '[role=status]',
  '[role=log]',
  '[role=marquee]',
  '[role=timer]',
].join(', ');

test.beforeEach(async ({ page }) => {
  await page.goto('/dist/');
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
});

test('the setup screen takes focus on its heading after Accept, and keeps it across a redraw', async ({ page }) => {
  await acceptSafetyGate(page);
  const heading = page.locator('#setup-heading');
  await expect(heading).toHaveText('Plan your gas');
  await expect(heading).toBeFocused();

  // M redraws the whole screen; focus stays on the heading, and the screen's
  // keys reach it from there.
  await page.keyboard.press('m');
  await expect(page.locator('[data-setup-group=mode] [data-setup-option=tec]')).toBeChecked();
  await expect(heading).toBeFocused();

  // Not in the tab order: Tab goes on to the mode, the first control after it.
  await page.keyboard.press('Tab');
  await expect(page.locator('[data-setup-group=mode] [data-setup-option=tec]')).toBeFocused();
});

test('accepted by keyboard, the setup screen takes focus on its heading', async ({ page }) => {
  await page.locator('[data-accept-safety]').focus();
  await page.keyboard.press('Enter');
  await page.locator('.setup-screen').waitFor();
  await expect(page.locator('#setup-heading')).toBeFocused();
});

test('with a saved dive on offer, focus goes to its line and Tab reaches Resume next', async ({ page }) => {
  await startDive(page);
  await page.locator('[data-renderer=pixi] canvas').waitFor();
  await beginDescent(page);
  await page.waitForFunction((key) => {
    const raw = window.localStorage.getItem(key);
    return raw !== null && JSON.parse(raw).state.elapsedTimeS > 0;
  }, SAVE_KEY);

  await page.reload();
  await acceptSafetyGate(page);
  await expect(page.locator('#resume-banner-text')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('[data-resume-continue]')).toBeFocused();
});

test('the dive takes focus on its dive computer after Start, and the keyboard still drives it', async ({ page }) => {
  await startDive(page);
  await page.locator('[data-renderer=pixi] canvas').waitFor();
  const computer = page.locator('.wreck-hud');
  await expect(computer).toBeFocused();

  // The dive's keys are read on the window: from the dive computer they
  // still begin the dive and move the diver.
  await beginDescent(page);
  await descendTo(page, 2);
  await expect(computer).toBeFocused();

  // Every movement key, pressed with focus on the dive computer, is taken by the
  // controller, which claims each with preventDefault(). This listener is
  // added after the controller's, so it sees the event once it is done.
  await page.evaluate(() => {
    window.__f311Keys = [];
    window.addEventListener('keydown', (event) => {
      window.__f311Keys.push({
        key: event.key,
        target: event.target instanceof HTMLElement ? event.target.className : null,
        taken: event.defaultPrevented,
      });
    });
  });
  const keys = ['w', 'a', 's', 'd', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight'];
  for (const key of keys) await page.keyboard.press(key);
  expect(await page.evaluate(() => window.__f311Keys)).toEqual(
    keys.map((key) => ({ key, target: 'wreck-hud', taken: true })),
  );
});

test('started by keyboard, the dive takes focus on its dive computer', async ({ page }) => {
  await startDiveByKeyboard(page);
  await page.locator('[data-renderer=pixi] canvas').waitFor();
  await expect(page.locator('.wreck-hud')).toBeFocused();
});

/** The focused element's role and accessible name, as Chrome exposes them. */
async function focusedAccessibleName(cdp) {
  const { result } = await cdp.send('Runtime.evaluate', { expression: 'document.activeElement' });
  const { nodes } = await cdp.send('Accessibility.getPartialAXTree', {
    objectId: result.objectId,
    fetchRelatives: false,
  });
  return { role: nodes[0].role?.value, name: nodes[0].name?.value };
}

// Pre-review pass 2: a focusable element with no name of its own takes its
// readouts as its name, so the focused object's name changed every
// dive-second, and a screen reader speaks the name of the focus again when
// it changes: the per-frame churn #137 §4.4 removed. Its name is fixed.
// Pre-review pass 3: the name is not a readout, so it is in the page's
// language, as the other groups' names are (#232 keeps only the readouts
// English).
for (const [locale, name] of [
  ['en-US', 'Dive computer'],
  ['de-DE', 'Tauchcomputer'],
]) {
  test.describe(`in ${locale}`, () => {
    test.use({ locale });

    test('the focused dive computer keeps one name while its readouts change', { tag: '@chromium-only' }, async ({ page }) => {
      // By the data attributes: the gate's words are German in de-DE.
      await page.locator('[data-accept-safety]').focus();
      await page.keyboard.press('Enter');
      await page.locator('.setup-screen').waitFor();
      await page.locator('[data-start-dive]').focus();
      await page.keyboard.press('Enter');
      await page.locator('[data-renderer=pixi] canvas').waitFor();
      await expect(page.locator('.wreck-hud')).toBeFocused();
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Accessibility.enable');

      const time = page.locator('.wreck-hud [data-hud-metric="time"] dd');
      await page.keyboard.down('s');
      const samples = [];
      const times = [];
      try {
        for (let i = 0; i < 5; i += 1) {
          samples.push(await focusedAccessibleName(cdp));
          times.push(await time.textContent());
          await page.waitForTimeout(300);
        }
      } finally {
        await page.keyboard.up('s');
      }
      // The readouts did change over the samples...
      expect(new Set(times).size).toBeGreaterThan(1);
      // ...and the name did not.
      expect(samples).toEqual(Array(5).fill({ role: 'group', name }));
      // It is read from an element in the page's language, outside the dive
      // computer's lang="en", that no live region holds.
      const label = page.locator('#wreck-hud-name');
      await expect(label).toHaveText(name);
      expect(
        await label.evaluate((el, sel) => ({
          lang: el.closest('[lang]').getAttribute('lang'),
          live: el.closest(sel) !== null,
        }), LIVE),
      ).toEqual({ lang: locale.slice(0, 2), live: false });
    });
  });
}

/**
 * Where the focused element and its ring are: its box, the ring's box (the
 * box grown by the outline's offset and width), the viewport, every ancestor
 * box that clips (overflow other than visible), and, at points in the ring's
 * band and at the box's centre, whether the element is what is drawn on top.
 */
const focusGeometry = (page) =>
  page.evaluate(() => {
    const focused = document.activeElement;
    const style = getComputedStyle(focused);
    const box = focused.getBoundingClientRect();
    const width = Number.parseFloat(style.outlineWidth) || 0;
    const grow = (Number.parseFloat(style.outlineOffset) || 0) + width;
    const ring = {
      left: box.left - grow,
      top: box.top - grow,
      right: box.right + grow,
      bottom: box.bottom + grow,
    };
    const clips = [];
    for (let node = focused.parentElement; node; node = node.parentElement) {
      const { overflowX, overflowY } = getComputedStyle(node);
      if (overflowX !== 'visible' || overflowY !== 'visible') {
        const r = node.getBoundingClientRect();
        clips.push({ name: node.className || node.tagName, left: r.left, top: r.top, right: r.right, bottom: r.bottom });
      }
    }
    // In the ring's band, 1.5 px in from the box's edge, at the middle of
    // each side, and the centre.
    const midX = (box.left + box.right) / 2;
    const midY = (box.top + box.bottom) / 2;
    const points = {
      top: [midX, box.top + 1.5],
      left: [box.left + 1.5, midY],
      bottom: [midX, box.bottom - 1.5],
      right: [box.right - 1.5, midY],
      centre: [midX, midY],
    };
    // Hit-tested as if the warning took taps, as tests/warning-banner.spec.js
    // does: it is pointer-events: none (#287), and hit testing would pass
    // through it to whatever it is painted over.
    const banner = document.querySelector('.wreck-warning');
    const pointerEvents = banner?.style.pointerEvents ?? '';
    if (banner) banner.style.pointerEvents = 'auto';
    const onTop = {};
    for (const [name, [x, y]] of Object.entries(points)) {
      const hit = document.elementFromPoint(x, y);
      onTop[name] = hit !== null && focused.contains(hit);
    }
    if (banner) banner.style.pointerEvents = pointerEvents;
    return {
      className: focused.className,
      focusVisible: focused.matches(':focus-visible'),
      outline: { style: style.outlineStyle, width },
      box: { width: box.width, height: box.height },
      ring,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      clips,
      onTop,
    };
  });

function expectVisibleFocus(geometry) {
  expect(geometry.focusVisible).toBe(true);
  expect(geometry.outline.style).not.toBe('none');
  expect(geometry.outline.width).toBeGreaterThan(0);
  expect(geometry.box.width).toBeGreaterThan(0);
  expect(geometry.box.height).toBeGreaterThan(0);
  const { ring, viewport } = geometry;
  expect(ring.left).toBeGreaterThanOrEqual(0);
  expect(ring.top).toBeGreaterThanOrEqual(0);
  expect(ring.right).toBeLessThanOrEqual(viewport.width);
  expect(ring.bottom).toBeLessThanOrEqual(viewport.height);
  for (const clip of geometry.clips) {
    expect(ring.left, clip.name).toBeGreaterThanOrEqual(clip.left);
    expect(ring.top, clip.name).toBeGreaterThanOrEqual(clip.top);
    expect(ring.right, clip.name).toBeLessThanOrEqual(clip.right);
    expect(ring.bottom, clip.name).toBeLessThanOrEqual(clip.bottom);
  }
  expect(geometry.onTop).toEqual({ top: true, left: true, bottom: true, right: true, centre: true });
}

// Pre-review pass 1: at 320 px a tec or rebreather topbar shrinks the site's
// name to nothing, and a warning's bar stands over it in portrait (#287), so
// a focus there showed no ring. Focus goes to the dive computer, drawn whole
// at 320 px and, in portrait, below the warning bar (#137 A15, #287).
test.describe('at 320x568, by keyboard', () => {
  test.use({ viewport: { width: 320, height: 568 } });

  for (const mode of ['tec', 'ccr']) {
    test(`${mode}: the focused dive computer shows its ring, whole, in view and uncovered, a warning up too`, async ({ page }) => {
      // The mode by keyboard too: after a click, Firefox keeps the focus the
      // dive moves to the dive computer off :focus-visible, where Chromium
      // takes the Enter on Start as the keyboard's (#302).
      await startDiveByKeyboard(page, async (p) => {
        await p.locator(`[data-setup-group=mode] [data-setup-option=${mode}]`).focus();
        await p.keyboard.press('Space');
        await expect(p.locator(`[data-setup-group=mode] [data-setup-option=${mode}]`)).toBeChecked();
      });
      await page.locator('[data-renderer=pixi] canvas').waitFor();
      await beginDescent(page);
      await descendTo(page, 1);
      expectVisibleFocus(await focusGeometry(page));
      await expect(page.locator('.wreck-hud')).toBeFocused();

      // A warning: the dive's own save at 35 m, narcotic, resumed by
      // keyboard, as tests/warning-banner.spec.js raises it.
      const saved = await page
        .waitForFunction((key) => {
          const raw = window.localStorage.getItem(key);
          const parsed = raw === null ? null : JSON.parse(raw);
          return parsed !== null && parsed.state.elapsedTimeS > 0 ? parsed : null;
        }, SAVE_KEY)
        .then((handle) => handle.jsonValue());
      Object.assign(saved.state, {
        depthM: 35,
        maxDepthM: 35,
        verticalVelocityMpm: 0,
        bcdGasSurfaceLiters: 15,
        narcosisIndex: 0.5,
      });
      await page.goto('/dist/');
      await page.evaluate(
        ([key, value]) => window.localStorage.setItem(key, value),
        [SAVE_KEY, JSON.stringify(saved)],
      );
      await page.reload();
      await page.locator('[data-accept-safety]').focus();
      await page.keyboard.press('Enter');
      await page.locator('.setup-screen').waitFor();
      await expect(page.locator('#resume-banner-text')).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(page.locator('[data-resume-continue]')).toBeFocused();
      await page.keyboard.press('Enter');
      await page.locator('[data-renderer=pixi] canvas').waitFor();
      await expect(page.locator('.wreck-warning')).toHaveText('Narcosis');
      expectVisibleFocus(await focusGeometry(page));
      await expect(page.locator('.wreck-hud')).toBeFocused();
    });
  }
});

test('a site with no scene takes focus on its panel\'s heading, and Back on the setup\'s', async ({ page }) => {
  await acceptSafetyGate(page);
  await page.locator('[data-setup-group=site] [data-setup-option=cave]').check();
  await page.locator('[data-start-dive]').click();

  await expect(page.locator('[data-unavailable-site]')).toBeVisible();
  await expect(page.locator('#unavailable-site-heading')).toBeFocused();

  await page.locator('[data-back-to-setup]').click();
  await expect(page.locator('#setup-heading')).toBeFocused();
});

test('the start error takes focus on its heading and is no live region', async ({ page }) => {
  // The renderer's chunk fails to load, so the dive cannot start.
  await page.route('**/dist/assets/pixi-renderer-*', (route) => route.abort());
  await startDive(page);

  const error = page.locator('[data-start-error]');
  await expect(error).toBeVisible();
  const heading = page.locator('#start-error-heading');
  await expect(heading).toHaveText('The wreck preview could not start');
  await expect(heading).toBeFocused();
  // A screen, as the game over is: focus says it changed, not an alert.
  await expect(error.locator(LIVE)).toHaveCount(0);
  expect(await error.evaluate((el, sel) => el.closest(sel) !== null, LIVE)).toBe(false);
  await expect(error).toHaveAccessibleName('The wreck preview could not start');

  // Tab goes on to its one control.
  await page.keyboard.press('Tab');
  await expect(error.getByRole('button', { name: 'Reload and try again' })).toBeFocused();
});
