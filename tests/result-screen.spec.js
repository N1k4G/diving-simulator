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

// Installs window.__controlBoxes(): the box of every control a thumb could
// actually hit. Defined once because the #121 test both waits on this set and
// measures it — two copies of the predicate could disagree, and the wait would
// then let the measurement run against a set it had not actually waited for.
const CONTROL_BOXES = () => {
  window.__controlBoxes = () => Array.from(document.querySelectorAll('button, .gs-btn'))
    .filter(el => {
      const s = getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && el.offsetParent !== null;
    })
    .map(el => {
      const r = el.getBoundingClientRect();
      return {
        label: (el.textContent || '').trim().slice(0, 16) || el.id,
        x: r.x, y: r.y, w: r.width, h: r.height,
      };
    })
    .filter(b => b.w > 0 && b.h > 0);
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

  test('no post-dive text runs off either edge, in any language or dive mode', async ({ page }) => {
    // The matrix has to cover modes as well as languages: the CCR cylinder
    // lines are the longest strings the screen can draw and only exist in CCR,
    // so a Rec-only loop leaves them untested however many languages it walks.
    const errors = await bootGame(page);

    const clipped = [];
    const modesSeen = [];
    for (const mode of ['rec', 'tec', 'ccr']) {
      for (const lang of ['en', 'de']) {
        await page.evaluate(
          ({ l, m }) => { window.gameAPI.currentLang = l; window.gameAPI.diveMode = m; },
          { l: lang, m: mode }
        );
        await reachDiving(page);
        const { runs, width } = await captureResultScreen(page, 'post-dive');

        // Guard the matrix itself. If switching mode silently failed, every
        // iteration would draw the same Rec screen and the loop would prove
        // nothing — which is exactly how the CCR lines went untested before.
        const drawn = runs.map(r => r.text).join(' ');
        modesSeen.push({ mode, lang, ccrLinesDrawn: /Cylinder|Flasche|Scrubber/.test(drawn) });

        for (const run of runs) {
          if (run.left < -0.5 || run.right > width + 0.5) {
            clipped.push(`${mode}/${lang}: "${run.text.slice(0, 40)}" spans ${run.left.toFixed(1)}…${run.right.toFixed(1)} in ${width}px`);
          }
        }
        await page.reload();
        await page.waitForFunction(() => !!window.gameAPI, { timeout: 15000 });
      }
    }

    const ccrRuns = modesSeen.filter(m => m.mode === 'ccr');
    expect(ccrRuns).toHaveLength(2);
    for (const run of ccrRuns) {
      expect(run.ccrLinesDrawn, `${run.mode}/${run.lang} must actually draw the CCR cylinder lines`).toBe(true);
    }

    expect(clipped, clipped.join('\n')).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('content taller than the viewport is reachable by scrolling', async ({ page }) => {
    // Reachability has to be measured against the content, not against the
    // renderer's own declared scroll range. Asserting only that scrolling
    // reaches `resultScrollMaxY` is circular: pinning that value to 1 leaves
    // every line below the fold unreachable and still satisfies it.
    await bootGame(page);
    await reachDiving(page);

    const { runs, height, scrollMax } = await captureResultScreen(page, 'post-dive');

    // Text is drawn inside a translate(0, -resultScrollY), so recorded y values
    // are content-space. Screen position is `content y - resultScrollY`.
    const lowestContentY = Math.max(...runs.map(r => r.bottom));
    // The post-dive screen genuinely overflows a 568px phone; if it ever stops
    // doing so, this is the signal to revisit the rest of the test.
    expect(lowestContentY).toBeGreaterThan(height);

    const overflow = lowestContentY - height;
    expect(
      scrollMax,
      `declared scroll range ${scrollMax.toFixed(1)} must cover the ${overflow.toFixed(1)}px the content actually overflows`
    ).toBeGreaterThanOrEqual(overflow);

    await page.mouse.move(160, 300);
    await page.mouse.wheel(0, 10000);
    await page.waitForTimeout(250);

    // Re-measure at the bottom of the scroll and check where the last line
    // actually lands, using the offset the renderer really applied.
    const atBottom = await page.evaluate(async () => {
      window.__inkStart();
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      return {
        runs: window.__inkStop(),
        offset: window.gameAPI.resultScrollY,
        height: window.innerHeight,
      };
    });
    const lowestOnScreen = Math.max(...atBottom.runs.map(r => r.bottom)) - atBottom.offset;
    expect(
      lowestOnScreen,
      `last line sits ${lowestOnScreen.toFixed(1)}px down a ${atBottom.height}px viewport after scrolling to the bottom`
    ).toBeLessThanOrEqual(atBottom.height);
    expect(lowestOnScreen, 'and should not have been scrolled off the top').toBeGreaterThan(0);
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
    await page.evaluate(CONTROL_BOXES);

    // bootGame waits only for window.gameAPI, which can exist before the setup
    // screen has been laid out. The predicate below filters on offsetParent and
    // a non-zero box, so reading too early returns an EMPTY set — and an empty
    // set satisfies both array assertions at the end of this test trivially.
    //
    // `total > 10` is the guard against that silent pass, and on a slow runner
    // it is what fired instead: issue #151, "expected 0 to be greater than 10",
    // on a PR that touched nothing but a workflow file. The guard did its job;
    // it was just standing in for a wait that was never written.
    //
    // Waiting on the same predicate the assertions measure keeps `total > 10`
    // an assertion about the UI rather than about timing. It deliberately stays
    // below: if the controls are ever built differently, it should still catch
    // a set that silently collapses.
    await page.waitForFunction(() => window.__controlBoxes().length > 10, { timeout: 10000 });

    const geometry = await page.evaluate(() => {
      const boxes = window.__controlBoxes();

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
