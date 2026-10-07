const { expect, test } = require('@playwright/test');
const { descendTo } = require('./helpers/start-dive.cjs');

/** The safety gate in either language: the shared helper names its English button. */
async function acceptSafetyGate(page) {
  await page.locator('[data-accept-safety]').click();
  await page.locator('.setup-screen').waitFor();
}

// The post-dive screen (#159): legacy's drawPostDive() as DOM, with the text
// of src/constants.js and the flow of src/game-loop.js: surfacing ends the
// dive on that tick, the save is cleared, and Enter returns to the setup.
//
// The screen's content is checked the way tests/game-over.spec.js checks a
// failure's: a running dive's save is turned into one that ended at the
// surface, and resumed, so the whole dive behind the debriefing is known. The
// live end, a dive surfacing on screen, is checked below and in
// tests/wreck-slice.spec.js.

const SAVE_KEY = 'diving-simulator.save-game';
/** The dive's length in the edited save: 25.5 dive minutes. */
const END_S = 1530;
/** The deepest point of the edited dives: past 11 m, so the safety stop is needed. */
const DEEPEST_M = 18;

/**
 * The save of a dive under way. The dive starts at the surface (#199) and the
 * codec refuses gas drawn by one still waiting there, so it is taken from a
 * dive that has begun.
 */
const persistedSave = (page) =>
  page
    .waitForFunction((key) => {
      const raw = window.localStorage.getItem(key);
      const parsed = raw === null ? null : JSON.parse(raw);
      return parsed !== null && parsed.state.elapsedTimeS > 0 ? parsed : null;
    }, SAVE_KEY)
    .then((handle) => handle.jsonValue());

/**
 * A dive the model could have ended at the surface: down to the deepest
 * point the save already holds, a hold there, a fast ascent (14.2 m/min,
 * logged 90 s before the end) and up without the safety stop, whose
 * countdown started above 6 m and paused out of its band. The tissues stay
 * the save's, which a few seconds at depth leave without a ceiling.
 */
function completeAtSurface(state) {
  const deepest = DEEPEST_M;
  const profile = [];
  for (let t = 0; t <= END_S; t += 2) {
    const depth = t < 120 ? (deepest * t) / 120
      : t < END_S - 150 ? deepest
        : Math.max(0, (deepest * (END_S - t)) / 150);
    profile.push({ elapsedTimeS: t, depthM: Math.min(deepest, depth), ceilingM: 0 });
  }
  const submergedS = END_S - 60;
  Object.assign(state, {
    elapsedTimeS: END_S,
    depthM: 0.1,
    maxDepthM: DEEPEST_M,
    verticalVelocityMpm: 0,
    completed: true,
    thirds: { startingGasL: 0, turnWarned: false, reserveHit: false },
    safetyStop: { needed: true, countdownStarted: true, remainingS: 150, paused: true, complete: false },
  });
  Object.assign(state.log, {
    entries: [
      { kind: 'fast-ascent', elapsedTimeS: END_S - 90, value: 14.2 },
      { kind: 'safety-stop-skipped', elapsedTimeS: END_S, value: 0 },
    ],
    ascentRateMpm: 0,
    fastAscentS: 0,
    fastAscentPeakMpm: 0,
    fastAscentLatched: false,
    ceilingViolationS: 0,
    ceilingViolationLatched: false,
    depthTimeMS: 16 * submergedS,
    submergedS,
    profile,
    profileTimerS: 0,
    lastCeilingM: 0,
  });
}

/** Starts a dive, turns its save into one completed at the surface, and resumes it. */
async function resumeCompletedDive(page, { configure, editState } = {}) {
  await page.goto('/dist/');
  await page.evaluate(() => window.localStorage.clear());
  await acceptSafetyGate(page);
  if (configure) await configure(page);
  await page.locator('[data-start-dive]').click();
  await page.locator('[data-renderer=pixi] canvas').waitFor();
  await descendTo(page, 1);

  const saved = await persistedSave(page);
  completeAtSurface(saved.state);
  if (editState) editState(saved.state);
  await page.goto('/dist/');
  await page.evaluate(
    ([key, value]) => window.localStorage.setItem(key, value),
    [SAVE_KEY, JSON.stringify(saved)],
  );
  await acceptSafetyGate(page);
  await page.locator('[data-start-dive]').click();
  await page.locator('[data-post-dive]').waitFor();
  return saved;
}

const configureCcr = async (page) => {
  await page.locator('[data-setup-group=mode] [data-setup-option=ccr]').check();
};

/** The rebreather drawn down over the dive, and bailed out five minutes before the end. */
function drawDownLoop(state) {
  Object.assign(state.ccr, {
    oxygenCylinderPressureBar: state.ccr.oxygenCylinderStartPressureBar - 40,
    diluentCylinderPressureBar: state.ccr.diluentCylinderStartPressureBar - 25,
    scrubberRemainingS: state.ccr.scrubberTotalS - 1500,
    onBailout: true,
  });
  state.events.push({ type: 'bailout', elapsedTimeS: END_S - 300 });
}

test('a dive completed at the surface opens legacy\'s debriefing, and clears the save', async ({ page }) => {
  const saved = await resumeCompletedDive(page, {
    // 1500 L drawn from the first cylinder, which grades on the wreck's
    // rule of thirds, not on the gas left.
    editState: (state) => { state.tanks[0].gasRemainingL = state.tanks[0].startGasL - 1500; },
  });
  const screen = page.locator('[data-post-dive]');

  await expect(screen.getByRole('heading', { level: 1 })).toHaveText('Dive complete');
  // Focus moves to the heading instead of an aria-live announcement (#138).
  await expect(page.locator('#post-dive-heading')).toBeFocused();
  await expect(screen.locator('[aria-live], [role=alert], [role=status]')).toHaveCount(0);

  // The stats card: dive time, max depth, and the time-weighted average.
  const stats = screen.locator('.result-stats');
  await expect(stats).toContainText(/Dive time25 min,? 30 sec/);
  await expect(stats).toContainText(
    `Max depth${new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(saved.state.maxDepthM)} m`,
  );
  await expect(stats).toContainText('Avg depth16 m');

  // The debriefing, by legacy's gradeDive(): one fast ascent (85), the stop
  // skipped (30), the rule of thirds kept (100), no ceiling (100), the depth
  // held (100). (85 + 30 + 100 + 100 + 100) / 5 = 83, two stars.
  const grade = screen.locator('.post-dive-grade');
  await expect(grade.getByRole('heading', { name: 'Debriefing' })).toBeVisible();
  await expect(grade.locator('[data-overall]')).toHaveText('83');
  await expect(grade.getByRole('img', { name: '2 of 3 stars' })).toHaveText('★★☆');
  const rows = grade.locator('[data-grade-category]');
  await expect(rows).toHaveCount(5);
  await expect(rows.locator('.post-dive-score-value')).toHaveText(['85', '30', '100', '100', '100']);
  await expect(rows.nth(0)).toContainText('Fast ascent 1x (peak 14.2 m/min).');
  await expect(rows.nth(1)).toHaveAttribute('data-tier', 'danger');
  await expect(rows.nth(1)).toContainText('Safety stop skipped. A 3-min pause at 5 m');
  await expect(rows.nth(2)).toContainText('Rule-of-thirds respected inside the overhead');

  // Gas used: legacy's "Tank 1 (mix): used / total".
  const gas = screen.locator('[data-gas=cylinder-0]');
  await expect(gas.locator('dt')).toHaveText(/^Cylinder 1 \((Air|EAN\d+|Tx \d+\/\d+)\)$/);
  await expect(gas.locator('dd')).toHaveText(
    `1,500 L used of ${saved.state.tanks[0].startGasL.toLocaleString('en-US')} L`,
  );

  // Legacy's safety-stop warning, with its explanation.
  await expect(screen).toHaveAttribute('data-safety-stop', 'skipped');
  await expect(screen.getByRole('heading', { name: '⚠ Safety stop skipped' })).toBeVisible();
  await expect(screen).toContainText('A safety stop helps off-gas dissolved nitrogen');

  // The violations, with their dive time: legacy's chart markers as text.
  const violations = screen.locator('.post-dive-violation-list li');
  await expect(violations).toHaveText([
    /^24 min,? 0 sec Fast ascent, peak 14\.2 m\/min$/,
    /^25 min,? 30 sec Safety stop skipped$/,
  ]);

  // The dive view is gone, and so is the save: an ended dive is not resumed.
  await expect(page.locator('.wreck-shell')).toHaveCount(0);
  expect(await page.evaluate((key) => window.localStorage.getItem(key), SAVE_KEY)).toBeNull();

  // Enter dives again, from the setup as it was.
  await page.keyboard.press('Enter');
  await page.locator('.setup-screen').waitFor();
  await expect(page.locator('[data-post-dive]')).toHaveCount(0);
});

test('a rebreather dive reports its oxygen, diluent and scrubber, and the bailout', async ({ page }) => {
  const saved = await resumeCompletedDive(page, { configure: configureCcr, editState: drawDownLoop });
  const screen = page.locator('[data-post-dive]');
  const { ccr } = saved.state;
  await expect(screen.locator('[data-gas^=cylinder]')).toHaveCount(0);
  await expect(screen.locator('[data-gas=oxygen]')).toHaveText(
    `O₂ cylinder${40 * ccr.oxygenCylinderVolumeL} L used, ${ccr.oxygenCylinderPressureBar} bar left`,
  );
  await expect(screen.locator('[data-gas=diluent]')).toHaveText(
    `Diluent cylinder${25 * ccr.diluentCylinderVolumeL} L used, ${ccr.diluentCylinderPressureBar} bar left`,
  );
  await expect(screen.locator('[data-gas=scrubber]')).toHaveText('Scrubber25 min used');
  await expect(screen.locator('.post-dive-bailout')).toHaveText('⚠ Bailout: the dive ended on open circuit');
});

/**
 * A dive a metre down, light enough to drift up and surface gently, after a
 * minute and a half that went to 18 m: the model ends it on screen, on the
 * tick it surfaces, as legacy's updateDiving() does. `safetyStop` is the stop
 * it surfaces with.
 */
async function surfaceLiveDive(page, safetyStop) {
  await page.goto('/dist/');
  await page.evaluate(() => window.localStorage.clear());
  await acceptSafetyGate(page);
  await page.locator('[data-start-dive]').click();
  await page.locator('[data-renderer=pixi] canvas').waitFor();
  await descendTo(page, 1);

  const saved = await persistedSave(page);
  Object.assign(saved.state, {
    elapsedTimeS: 90,
    depthM: 1,
    maxDepthM: DEEPEST_M,
    verticalVelocityMpm: 0,
    bcdGasSurfaceLiters: 3,
    safetyStop,
  });
  await page.goto('/dist/');
  await page.evaluate(
    ([key, value]) => window.localStorage.setItem(key, value),
    [SAVE_KEY, JSON.stringify(saved)],
  );
  await acceptSafetyGate(page);
  await page.locator('[data-start-dive]').click();
  // The dive itself first: it is resumed under way, not debriefed.
  await page.locator('[data-renderer=pixi] canvas').waitFor();
  await page.locator('[data-post-dive]').waitFor({ timeout: 30_000 });
}

test('a dive that surfaces with its stop done is debriefed with the stop done', async ({ page }) => {
  // The stop done before the last metre: no skipped entry, no warning.
  await surfaceLiveDive(page, { needed: true, countdownStarted: true, remainingS: 0, paused: false, complete: true });
  const screen = page.locator('[data-post-dive]');
  await expect(page.locator('#post-dive-heading')).toBeFocused();
  await expect(screen).toHaveAttribute('data-safety-stop', 'done');
  await expect(screen.locator('.post-dive-safety-skipped')).toHaveCount(0);
  await expect(screen.locator('[data-grade-category=safetyStop]')).toContainText('Safety stop completed — well done.');
  await expect(screen.locator('.result-stats')).toContainText('Max depth18 m');
  await expect(page.locator('.wreck-shell')).toHaveCount(0);
  expect(await page.evaluate((key) => window.localStorage.getItem(key), SAVE_KEY)).toBeNull();
});

test('a dive that surfaces without its stop is debriefed with the stop skipped', async ({ page }) => {
  // Needed at 18 m and not begun: it starts above 6 m and pauses out of its
  // band, and the surface logs it skipped on the tick the dive ends.
  await surfaceLiveDive(page, { needed: true, countdownStarted: false, remainingS: 0, paused: false, complete: false });
  const screen = page.locator('[data-post-dive]');
  await expect(screen).toHaveAttribute('data-safety-stop', 'skipped');
  await expect(screen.getByRole('heading', { name: '⚠ Safety stop skipped' })).toBeVisible();
  await expect(screen.locator('[data-violation=safety-stop-skipped]')).toHaveCount(1);
});

/**
 * #120 and #121 for the DOM screen: no horizontal overflow, no text past
 * either edge, the bottom of the screen reachable by ordinary scrolling, and
 * every button 44 px with 8 px between neighbours.
 */
async function expectMobileLayout(page) {
  const doc = await page.evaluate(() => {
    const el = document.scrollingElement;
    return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
  });
  // Taller than the viewport, so scrolling is what makes it reachable.
  expect(doc.scrollHeight).toBeGreaterThan(doc.clientHeight);
  expect(doc.scrollWidth).toBeLessThanOrEqual(doc.clientWidth);

  const offEdge = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('[data-post-dive] *')) {
      if (!el.textContent.trim() || el.children.length > 0) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && (r.left < 0 || r.right > window.innerWidth + 0.5)) out.push(el.textContent.slice(0, 30));
    }
    return out;
  });
  expect(offEdge).toEqual([]);

  // Reachability is measured against the content: after scrolling to the
  // end, the last line of the screen sits inside the viewport.
  await page.mouse.wheel(0, 20000);
  const hint = page.locator('[data-post-dive] .result-hint');
  await expect(hint).toBeInViewport();
  const hintBox = await hint.boundingBox();
  const viewport = page.viewportSize();
  expect(hintBox.y + hintBox.height).toBeLessThanOrEqual(viewport.height);

  const geometry = await page.evaluate(() => {
    const boxes = Array.from(document.querySelectorAll('[data-post-dive] button')).map((el) => {
      const r = el.getBoundingClientRect();
      return { label: el.textContent.trim().slice(0, 16), x: r.x, y: r.y, w: r.width, h: r.height };
    });
    const undersized = boxes.filter((b) => b.w < 44 || b.h < 44).map((b) => `${b.label} is ${Math.round(b.w)}x${Math.round(b.h)}`);
    const tight = [];
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i];
        const b = boxes[j];
        const gapX = Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w);
        const gapY = Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h);
        if ((gapX < 0) === (gapY < 0)) continue;
        const gap = gapX < 0 ? gapY : gapX;
        if (gap >= 0 && gap < 8) tight.push(`${a.label} <-> ${b.label} = ${gap.toFixed(1)}px`);
      }
    }
    return { undersized, tight, total: boxes.length };
  });
  expect(geometry.total).toBeGreaterThan(0);
  expect(geometry.undersized, geometry.undersized.join('\n')).toEqual([]);
  expect(geometry.tight, geometry.tight.join('\n')).toEqual([]);

  const again = page.locator('[data-dive-again]');
  await again.scrollIntoViewIfNeeded();
  await expect(again).toBeInViewport();
  await again.tap();
  await page.locator('.setup-screen').waitFor();
}

test.describe('at the mobile viewport', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('the whole debriefing is reachable by scrolling, within the edges, with 44px targets', async ({ page }) => {
    await resumeCompletedDive(page, { configure: configureCcr, editState: drawDownLoop });
    await expectMobileLayout(page);
  });
});

test.describe('on a small phone', () => {
  // The legacy #120 matrix: both languages and both gas summaries, because
  // the rebreather lines and the German strings are the longest the screen
  // draws. The text checks make sure each case draws what it says it does.
  test.use({ viewport: { width: 320, height: 568 }, hasTouch: true, isMobile: true });
  const TEXT = {
    'en-US': { heading: 'Dive complete', ascent: 'Fast ascent, peak 14.2 m/min', again: 'Dive again' },
    'de-DE': { heading: 'Tauchgang beendet', ascent: 'Zu schneller Aufstieg, Spitze 14,2 m/min', again: 'Neuer Tauchgang' },
  };

  for (const locale of ['en-US', 'de-DE']) {
    for (const rebreather of [false, true]) {
      test.describe(locale, () => {
        test.use({ locale });

        test(`${rebreather ? 'a rebreather' : 'open circuit'} fits and scrolls`, async ({ page }) => {
          await resumeCompletedDive(page, rebreather ? { configure: configureCcr, editState: drawDownLoop } : {});
          const screen = page.locator('[data-post-dive]');
          await expect(screen.getByRole('heading', { level: 1 })).toHaveText(TEXT[locale].heading);
          await expect(screen.locator('.post-dive-violation-list li').first()).toContainText(TEXT[locale].ascent);
          await expect(screen.locator('[data-dive-again]')).toHaveText(TEXT[locale].again);
          await expect(screen.locator('[data-gas=oxygen]')).toHaveCount(rebreather ? 1 : 0);
          await expectMobileLayout(page);
        });
      });
    }
  }
});
