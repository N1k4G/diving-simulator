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

async function startDive(page, mode) {
  await page.goto('/dist/');
  await page.evaluate(() => window.localStorage.clear());
  await startDiveAndWaitForCanvas(page, mode === undefined ? undefined : async (p) => {
    await p.locator(`[data-setup-group=mode] [data-setup-option=${mode}]`).check();
  });
  await descendTo(page, 2);
}

async function setInsets(page, inset = INSET) {
  await page.evaluate((edges) => {
    for (const [edge, px] of Object.entries(edges)) {
      document.documentElement.style.setProperty(`--safe-area-inset-${edge}`, `${px}px`);
    }
  }, inset);
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

// The shell's side carries the insets itself (#137 A7), so what stands inside
// it must not subtract them a second time: with an inset the gas page and the
// instructor panel may lose the room the inset takes, no more.
const SIZED = [
  { width: 360, height: 640, inset: { top: 0, right: 0, bottom: 24, left: 0 } },
  { width: 375, height: 667, inset: { top: 0, right: 0, bottom: 24, left: 0 } },
  { width: 390, height: 844, inset: { top: 47, right: 0, bottom: 34, left: 0 } },
];

async function clearInsets(page) {
  await page.evaluate(() => {
    for (const edge of ['top', 'right', 'bottom', 'left']) {
      document.documentElement.style.removeProperty(`--safe-area-inset-${edge}`);
    }
  });
}

const heightOf = (page, selector) => page.locator(selector).evaluate((el) => el.getBoundingClientRect().height);

for (const { width, height, inset } of SIZED) {
  test.describe(`room with insets, ${width}x${height}`, () => {
    test.use({ ...PHONE, viewport: { width, height } });

    test('the gas page and the instructor panel lose only what the insets take', async ({ page }) => {
      // The gas pages are a rebreather's or a technical dive's.
      await startDive(page, 'ccr');
      const lost = inset.top + inset.bottom;
      for (const [key, selector] of [['i', '[data-gas-info]'], ['l', '[data-instructor-panel]']]) {
        await page.keyboard.press(key);
        await expect(page.locator(selector)).toBeVisible();
        await clearInsets(page);
        const open = await heightOf(page, selector);
        await setInsets(page, inset);
        const inside = await heightOf(page, selector);
        expect(inside, `${selector} with the insets, from ${open}`).toBeGreaterThanOrEqual(open - lost - 1);
        const shell = await page.locator('.wreck-shell').boundingBox();
        const box = await page.locator(selector).boundingBox();
        expect(box.y + box.height, `${selector} ends above the bottom inset`)
          .toBeLessThanOrEqual(shell.y + shell.height - inset.bottom + 0.5);
        await page.keyboard.press(key);
        await clearInsets(page);
      }
    });

    test('the warning banner stands below the top inset', async ({ page }) => {
      await startDive(page);
      await setInsets(page, inset);
      const top = await page.locator('.wreck-warning').evaluate((el) => {
        el.hidden = false;
        el.textContent = '!';
        return el.getBoundingClientRect().top;
      });
      expect(top).toBeGreaterThanOrEqual(inset.top);
    });
  });
}
