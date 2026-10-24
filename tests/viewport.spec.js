const { expect, test } = require('./helpers/pinned-seed.cjs');
const { descendTo, startDiveAndWaitForCanvas } = require('./helpers/start-dive.cjs');

// Viewport hardening (#137 A7): the page reaches under the system bars
// (viewport-fit=cover), so every control must stand inside the safe-area
// insets, the page must not scroll or bounce during a dive, and the shell
// uses dynamic viewport units. The insets are simulated the way the D-pad
// spec does, with the custom properties Capacitor's SystemBars injects. The
// on-device half of A7 is blocked on #155 (the device matrix).

const PHONE = {
  hasTouch: true,
  isMobile: true,
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1',
};

const INSET = { top: 44, right: 47, bottom: 34, left: 47 };

const VIEWPORTS = [
  { name: 'portrait', width: 390, height: 844 },
  { name: 'landscape', width: 844, height: 390 },
];

async function startDive(page) {
  await page.goto('/dist/');
  await page.evaluate(() => window.localStorage.clear());
  await startDiveAndWaitForCanvas(page);
  await descendTo(page, 1);
}

async function setInsets(page) {
  await page.evaluate((inset) => {
    for (const [edge, px] of Object.entries(inset)) {
      document.documentElement.style.setProperty(`--safe-area-inset-${edge}`, `${px}px`);
    }
  }, INSET);
}

/** The boxes of every visible match, as edges. */
function boxes(page, selector) {
  return page.locator(selector).evaluateAll((elements) => elements
    .filter((el) => el.getClientRects().length > 0)
    .map((el) => {
      const r = el.getBoundingClientRect();
      return { label: el.dataset.control ?? String(el.className), l: r.left, t: r.top, r: r.right, b: r.bottom };
    }));
}

async function expectInside(page, selector, viewport, what) {
  const found = await boxes(page, selector);
  expect(found.length, `${what} is on screen`).toBeGreaterThan(0);
  // On a phone held sideways the dive's shell is still taller than the
  // screen and the bottom controls sit below it (#256), so the bottom edge
  // is checked in portrait only; the three others in both.
  const bottomLimit = viewport.height > viewport.width ? viewport.height - INSET.bottom + 0.5 : Infinity;
  const outside = found.filter((box) => box.l < INSET.left - 0.5 || box.r > viewport.width - INSET.right + 0.5
    || box.t < INSET.top - 0.5 || box.b > bottomLimit);
  expect(outside, `${what} stays inside the insets`).toEqual([]);
}

for (const viewport of VIEWPORTS) {
  test.describe(`the viewport, ${viewport.name} ${viewport.width}x${viewport.height}`, () => {
    test.use({ ...PHONE, viewport: { width: viewport.width, height: viewport.height } });

    test('the viewport meta covers the screen', async ({ page }) => {
      await page.goto('/dist/');
      const content = await page.locator('meta[name="viewport"]').getAttribute('content');
      expect(content).toContain('viewport-fit=cover');
    });

    test('the shell does not overscroll', async ({ page }) => {
      await startDive(page);
      for (const selector of ['html', 'body', '.wreck-shell']) {
        const value = await page.locator(selector).evaluate((el) => getComputedStyle(el).overscrollBehaviorY);
        expect(value, selector).toBe('none');
      }
    });

    test('the controls stand inside the insets', async ({ page }) => {
      await startDive(page);
      await setInsets(page);
      await expectInside(page, '.wreck-topbar > *', viewport, 'the topbar');
      await expectInside(page, '.wreck-hud', viewport, 'the HUD');
      await expectInside(page, '.wreck-dock', viewport, 'the dock');
      await expectInside(page, '.wreck-controls button', viewport, 'the D-pad');
      await page.keyboard.press('h');
      await expect(page.locator('[data-help-overlay]')).toBeVisible();
      await expectInside(page, '[data-help-overlay]', viewport, 'the help dialog');
    });
  });
}

test.describe('the dive screen on a phone in portrait', () => {
  test.use({ ...PHONE, viewport: { width: 390, height: 844 } });

  test('the page does not scroll', async ({ page }) => {
    await startDive(page);
    const size = await page.evaluate(() => ({
      scroll: document.documentElement.scrollHeight,
      inner: window.innerHeight,
    }));
    expect(size.scroll).toBeLessThanOrEqual(size.inner);
  });
});
