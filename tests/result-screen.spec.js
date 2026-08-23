// ============================================================
// FILE: tests/result-screen.spec.js
// PURPOSE: Regression cover for issues #120 and #121 — the result screens
//          (post-dive / game-over) and mobile touch-target geometry.
//
// These defects all shipped past lint, typecheck, unit and parity because the
// content is painted onto the canvas: nothing in the DOM shows a heading that
// runs off the edge, or a chart drawn 300px below the fold. The only way to
// see them is to measure what the 2D context is actually asked to draw, so
// this spec wraps fillText/strokeText and asserts on the real geometry.
// ============================================================

const { test, expect } = require('@playwright/test');

// The tightest viewport the project targets. Everything that overflows,
// overflows here first.
const SMALL_PHONE = {
  viewport: { width: 320, height: 568 },
  hasTouch: true,
  isMobile: true,
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 ' +
    '(KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
};

// Records the bounding box of every text run drawn between __inkStart and
// __inkStop. Font size is read from the `px` token rather than parseFloat,
// which would return the numeric weight in "500 20px Barlow".
const INK_RECORDER = () => {
  const proto = CanvasRenderingContext2D.prototype;
  window.__ink = null;
  const sizeOf = font => {
    const m = /(\d+(?:\.\d+)?)px/.exec(String(font || ''));
    return m ? parseFloat(m[1]) : 12;
  };
  const record = function (ctx, text, x, y, maxWidth) {
    const sink = window.__ink;
    if (!sink) return;
    let measured = { width: 0 };
    try { measured = ctx.measureText(String(text)); } catch { /* ignore */ }
    const size = sizeOf(ctx.font);
    const width = maxWidth == null ? measured.width : Math.min(measured.width, maxWidth);
    const align = ctx.textAlign;
    const left = align === 'center' ? x - width / 2
      : align === 'right' || align === 'end' ? x - width
        : x;
    if (!isFinite(left) || !isFinite(y)) return;
    sink.push({ text: String(text), left, right: left + width, top: y - size * 0.8, bottom: y + size * 0.2 });
  };
  const originalFill = proto.fillText;
  const originalStroke = proto.strokeText;
  proto.fillText = function (t, x, y, w) { record(this, t, x, y, w); return originalFill.call(this, t, x, y, w); };
  proto.strokeText = function (t, x, y, w) { record(this, t, x, y, w); return originalStroke.call(this, t, x, y, w); };
  window.__inkStart = () => { window.__ink = []; };
  window.__inkStop = () => { const sink = window.__ink; window.__ink = null; return sink; };
};

async function bootGame(page) {
  const consoleErrors = [];
  page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', err => consoleErrors.push(err.message));
  page.on('dialog', d => d.dismiss().catch(() => {}));
  await page.addInitScript(INK_RECORDER);
  await page.goto('/src/diving-simulator.html');
  await page.waitForFunction(() => !!window.gameAPI, { timeout: 15000 });
  return consoleErrors;
}

async function reachDiving(page) {
  await page.evaluate(() => window.gameAPI.startDiveAction());
  await page.waitForFunction(() => window.gameAPI.gameState === 'surface', { timeout: 5000 });
  await page.keyboard.down('s');
  await page.waitForFunction(() => window.gameAPI.gameState === 'diving', { timeout: 5000 });
  await page.keyboard.up('s');
}

/** Draw one frame of `state` and return every text run's geometry. */
async function captureResultScreen(page, state, reason) {
  return page.evaluate(async ({ state, reason }) => {
    window.gameAPI.maxDepth = 38.4;
    if (reason) window.gameAPI.gameOverReason = reason;
    window.gameAPI.gameState = state;
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    window.__inkStart();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    return {
      runs: window.__inkStop(),
      width: window.innerWidth,
      height: window.innerHeight,
      scrollMax: window.gameAPI.resultScrollMaxY,
    };
  }, { state, reason });
}

test.describe('issue #120: result screens fit and can be reached', () => {
  test.use(SMALL_PHONE);

  test('no result text runs off either edge, for any game-over reason', async ({ page }) => {
    const errors = await bootGame(page);
    await reachDiving(page);

    const reasons = await page.evaluate(() => Object.keys(window.gameAPI.S('gameOverReasons')));
    expect(reasons.length).toBeGreaterThan(0);

    const clipped = [];
    for (const reason of reasons) {
      const { runs, width } = await captureResultScreen(page, 'gameover', reason);
      for (const run of runs) {
        if (run.left < -0.5 || run.right > width + 0.5) {
          clipped.push(`${reason}: "${run.text.slice(0, 40)}" spans ${run.left.toFixed(1)}…${run.right.toFixed(1)} in ${width}px`);
        }
      }
    }
    expect(clipped, clipped.join('\n')).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('no post-dive text runs off either edge, in either language', async ({ page }) => {
    const errors = await bootGame(page);

    const clipped = [];
    for (const lang of ['en', 'de']) {
      await page.evaluate(l => { window.gameAPI.currentLang = l; }, lang);
      await reachDiving(page);
      const { runs, width } = await captureResultScreen(page, 'post-dive');
      for (const run of runs) {
        if (run.left < -0.5 || run.right > width + 0.5) {
          clipped.push(`${lang}: "${run.text.slice(0, 40)}" spans ${run.left.toFixed(1)}…${run.right.toFixed(1)} in ${width}px`);
        }
      }
      await page.reload();
      await page.waitForFunction(() => !!window.gameAPI, { timeout: 15000 });
    }
    expect(clipped, clipped.join('\n')).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('content taller than the viewport is reachable by scrolling', async ({ page }) => {
    await bootGame(page);
    await reachDiving(page);

    const { runs, height, scrollMax } = await captureResultScreen(page, 'post-dive');
    const lowest = Math.max(...runs.map(r => r.bottom));
    // The post-dive screen genuinely overflows a 568px phone; if it ever stops
    // doing so this assertion is the signal to revisit the rest of the test.
    expect(lowest).toBeGreaterThan(height);
    expect(scrollMax, 'overflowing content must expose a scroll range').toBeGreaterThan(0);

    await page.mouse.move(160, 300);
    await page.mouse.wheel(0, 10000);
    await page.waitForTimeout(200);
    const scrolled = await page.evaluate(() => window.gameAPI.resultScrollY);
    expect(scrolled).toBeCloseTo(scrollMax, 0);
  });

  test('the help overlay keeps its own scrolling while a result screen is open', async ({ page }) => {
    // Regression: the wheel/touch handlers live on `window`, so events bubbling
    // out of the HTML help overlay were preventDefault()ed on the canvas's
    // behalf — the overlay stayed pinned at scrollTop 0 while the result screen
    // hidden behind it scrolled instead.
    await bootGame(page);
    await reachDiving(page);
    await captureResultScreen(page, 'post-dive');

    await page.mouse.move(160, 300);
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(150);
    const resultBefore = await page.evaluate(() => window.gameAPI.resultScrollY);
    expect(resultBefore, 'result screen should scroll when no overlay is open').toBeGreaterThan(0);

    await page.evaluate(() => { window.gameAPI.showHelp = true; });
    await page.waitForFunction(
      () => getComputedStyle(document.getElementById('html-help-overlay')).display !== 'none',
      { timeout: 5000 }
    );

    const overlay = page.locator('#html-help-overlay');
    expect(await overlay.evaluate(el => el.scrollHeight)).toBeGreaterThan(600);

    await page.mouse.move(160, 300);
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(250);

    expect(await overlay.evaluate(el => el.scrollTop), 'overlay must scroll').toBeGreaterThan(0);
    expect(
      await page.evaluate(() => window.gameAPI.resultScrollY),
      'result screen behind the overlay must not move'
    ).toBe(resultBefore);
  });
});

test.describe('issue #121: mobile touch targets', () => {
  test.use(SMALL_PHONE);

  test('every setup control meets 44px and is at least 8px from its neighbours', async ({ page }) => {
    await bootGame(page);

    const geometry = await page.evaluate(() => {
      const visible = Array.from(document.querySelectorAll('button, .gs-btn'))
        .filter(el => {
          const s = getComputedStyle(el);
          return s.display !== 'none' && s.visibility !== 'hidden' && el.offsetParent !== null;
        });
      const boxes = visible.map(el => {
        const r = el.getBoundingClientRect();
        return { label: (el.textContent || '').trim().slice(0, 16) || el.id, x: r.x, y: r.y, w: r.width, h: r.height };
      }).filter(b => b.w > 0 && b.h > 0);

      const undersized = boxes
        .filter(b => b.w < 44 || b.h < 44)
        .map(b => `${b.label} is ${Math.round(b.w)}x${Math.round(b.h)}`);

      const tight = [];
      for (let i = 0; i < boxes.length; i += 1) {
        for (let j = i + 1; j < boxes.length; j += 1) {
          const a = boxes[i], b = boxes[j];
          const gapX = Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w);
          const gapY = Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h);
          // Only neighbours along one axis are "adjacent"; diagonal pairs are
          // separated by the other axis and cannot be mistapped for each other.
          const overlapX = gapX < 0, overlapY = gapY < 0;
          if (overlapX === overlapY) continue;
          const gap = overlapX ? gapY : gapX;
          if (gap >= 0 && gap < 8) {
            tight.push(`${a.label} <-> ${b.label} = ${gap.toFixed(1)}px`);
          }
        }
      }
      return { undersized, tight, total: boxes.length };
    });

    expect(geometry.total).toBeGreaterThan(10);
    expect(geometry.undersized, geometry.undersized.join('\n')).toEqual([]);
    expect(geometry.tight, geometry.tight.join('\n')).toEqual([]);
  });
});
