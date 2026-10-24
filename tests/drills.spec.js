const { expect, test } = require('./helpers/pinned-seed.cjs');
const { descendTo } = require('./helpers/start-dive.cjs');

// The training drills (#160): legacy's #45 drills, opted into on the setup
// screen, as a modal dialog over the stage that stops the dive for the
// decision and its debriefing. Started, run and debriefed by keyboard and by
// touch; each dialog written and announced once, never per frame. The gates,
// the options and their effects are tested in src/core/drills.test.ts and
// against legacy in tests/parity/drills.test.ts.

const SAVE_KEY = 'diving-simulator.save-game';
const drill = (page) => page.locator('[data-drill-overlay]');
const hudTime = (page) => page.locator('.wreck-hud [data-hud-metric="time"] dd').textContent();

/**
 * A dive in `mode` saved four minutes in, neutral at 20 m, where a drill may
 * fire (3 to 15 dive minutes, deeper than 8 m), with the hints dismissed so no
 * toast crowds the screen. The page is left on the setup screen with the save
 * on offer.
 */
async function offerDiveUnderWay(page, mode, tap) {
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
  const pressureBar = 1 + 20 / 10;
  Object.assign(saved.state, {
    depthM: 20,
    maxDepthM: 20,
    elapsedTimeS: 240,
    verticalVelocityMpm: 0,
    bcdGasSurfaceLiters: (7 + 2 - 3 - 5 * Math.pow(1 / pressureBar, 0.7)) * pressureBar,
  });
  await page.goto('/dist/');
  await page.evaluate(([key, value]) => {
    window.localStorage.setItem(key, value);
    window.localStorage.setItem('diveSim_hintsDone', '1');
  }, [SAVE_KEY, JSON.stringify(saved)]);
  const gate = page.locator('[data-accept-safety]');
  await (tap ? gate.tap() : gate.click());
  await page.locator('.setup-screen').waitFor();
}

/**
 * Counts the dialog's writes from now on, from before the dialog exists, so
 * a drill that comes at once is counted too: one per decision or
 * debriefing, none per frame.
 */
async function countWrites(page) {
  await page.evaluate(() => {
    window.drillWrites = 0;
    new MutationObserver((records) => {
      for (const record of records) {
        const target = record.target.nodeType === Node.ELEMENT_NODE ? record.target : record.target.parentElement;
        if (target?.closest('[data-drill-overlay]')) window.drillWrites += 1;
      }
    }).observe(document.body, { childList: true, characterData: true, subtree: true });
  });
  return () => page.evaluate(() => window.drillWrites);
}

/**
 * Escape four times, then a close the browser makes on its own, as Chromium
 * does for a close request without user activation or Android's back: the
 * drill's dialog is open after each.
 */
async function refuseToClose(page, dialog) {
  for (let i = 0; i < 4; i += 1) {
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
  }
  await page.evaluate(() => document.querySelector('[data-drill-overlay]').close());
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => document.querySelector('[data-drill-overlay]').matches(':modal'))).toBe(true);
}

test('by keyboard: turned on, the free-flow drill stops the dive, 1 picks, Enter ends the debriefing, each announced once', async ({ page }) => {
  await offerDiveUnderWay(page, 'rec', false);
  const toggle = page.locator('[data-setup-drills]');
  await expect(toggle).toHaveText('Training Drills: OFF');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveText('Training Drills: ON');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle).toBeFocused();
  const writes = await countWrites(page);
  await page.locator('[data-resume-continue]').focus();
  await page.keyboard.press('Enter');

  // Legacy's chance is 3 % a frame once eligible: it comes within seconds.
  const decision = page.getByRole('dialog', { name: '⚠ TRAINING DRILL Regulator Free-Flow' });
  await expect(decision).toBeVisible({ timeout: 20_000 });
  await expect(decision).toBeFocused();
  await expect(decision).toHaveAccessibleDescription(/Your regulator is icing up/);
  // One cylinder: the backup is not offered, and each row reads its own option.
  await expect(decision.locator('[data-drill-option]')).toHaveText([
    '1. Breathe through it calmly, initiate ascent/turn',
    '2. Hold your breath and cover the regulator',
  ]);
  await expect(page.locator('[data-drill-overlay] :is([aria-live], [role=status], [role=alert])')).toHaveCount(0);
  // The dive stands while it is up, and the dialog is not written again.
  const stopped = await hudTime(page);
  await page.waitForTimeout(1500);
  expect(await hudTime(page)).toBe(stopped);
  expect(await writes()).toBe(1);
  // Escape does not close it, however often (pre-review pass 1 of #272:
  // Chromium honours a cancelled close request only with user activation),
  // nor does a close the browser makes itself; nor H open the help behind it.
  await refuseToClose(page, decision);
  await expect(decision).toBeFocused();
  await page.keyboard.press('h');
  await expect(decision).toBeVisible();
  await expect(page.locator('[data-help-overlay]')).not.toBeVisible();
  expect(await hudTime(page)).toBe(stopped);
  expect(await writes()).toBe(1);

  await page.keyboard.press('1');
  const debrief = page.getByRole('dialog', { name: 'DEBRIEFING — Regulator Free-Flow Correct choice' });
  await expect(debrief).toBeVisible();
  await expect(debrief).toHaveAccessibleDescription(/A free-flowing reg can still be breathed from/);
  await expect(debrief).toContainText('IN THE REAL WORLD:');
  await expect(page.locator('[data-drill-continue]')).toBeFocused();
  expect(await writes()).toBe(2);
  await page.waitForTimeout(1000);
  expect(await writes()).toBe(2);
  expect(await hudTime(page)).toBe(stopped);
  await refuseToClose(page, debrief);
  await expect(page.locator('[data-drill-continue]')).toBeFocused();
  expect(await writes()).toBe(2);

  await page.keyboard.press('Enter');
  await expect(drill(page)).not.toBeVisible();
  await expect.poll(() => hudTime(page)).not.toBe(stopped);
  // At most one per dive.
  await page.waitForTimeout(2000);
  await expect(drill(page)).not.toBeVisible();
  expect(await writes()).toBe(2);
});

test('reloaded at its decision, the dive resumes the drill, which is answered and runs no second (TC-45-66)', async ({ page }) => {
  await offerDiveUnderWay(page, 'rec', false);
  await page.locator('[data-setup-drills]').click();
  await page.locator('[data-resume-continue]').click();
  const decision = page.getByRole('dialog', { name: '⚠ TRAINING DRILL Regulator Free-Flow' });
  await expect(decision).toBeVisible({ timeout: 20_000 });
  const stopped = await hudTime(page);
  // The autosave goes on while the drill stops the dive, and holds it.
  await page.waitForFunction((key) => {
    const parsed = JSON.parse(window.localStorage.getItem(key) ?? 'null');
    return parsed?.drill?.phase === 'overlay';
  }, SAVE_KEY, { timeout: 10_000 });

  await page.goto('/dist/');
  await page.locator('[data-accept-safety]').click();
  await page.locator('.setup-screen').waitFor();
  // Training Drills stays off: the drill comes from the save, not a new roll.
  await expect(page.locator('[data-setup-drills]')).toHaveText('Training Drills: OFF');
  await page.locator('[data-resume-continue]').click();
  await expect(decision).toBeVisible();
  await expect(decision).toBeFocused();
  await expect(decision.locator('[data-drill-option]')).toHaveCount(2);
  expect(await hudTime(page)).toBe(stopped);
  await page.waitForTimeout(1000);
  expect(await hudTime(page)).toBe(stopped);

  await page.keyboard.press('1');
  await expect(page.getByRole('dialog', { name: 'DEBRIEFING — Regulator Free-Flow Correct choice' })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(drill(page)).not.toBeVisible();
  await expect.poll(() => hudTime(page)).not.toBe(stopped);
  // Its free-flow and the drill's run are saved as the dive goes on.
  const saved = await page
    .waitForFunction((key) => {
      const parsed = JSON.parse(window.localStorage.getItem(key) ?? 'null');
      return parsed?.drill?.phase === 'effect' ? parsed.drill : null;
    }, SAVE_KEY, { timeout: 10_000 })
    .then((handle) => handle.jsonValue());
  expect(saved).toMatchObject({ id: 'freeflow', ranThisDive: true, correct: true, freeflowTankIndex: 0 });
});

test('the drill\'s outcome is legacy\'s dot on the post-dive profile at its time, out of the violations and the grade', async ({ page }) => {
  await offerDiveUnderWay(page, 'rec', false);
  await page.locator('[data-setup-drills]').click();
  await page.locator('[data-resume-continue]').click();
  const decision = page.getByRole('dialog', { name: '⚠ TRAINING DRILL Regulator Free-Flow' });
  await expect(decision).toBeVisible({ timeout: 20_000 });
  await page.keyboard.press('2');
  await expect(page.getByRole('dialog', { name: 'DEBRIEFING — Regulator Free-Flow Suboptimal choice' })).toBeVisible();
  await page.keyboard.press('Enter');
  // The model logged the outcome, and the autosave carries it.
  const saved = await page
    .waitForFunction((key) => {
      const parsed = JSON.parse(window.localStorage.getItem(key) ?? 'null');
      return parsed?.state.log.entries.some((entry) => entry.kind === 'drill-outcome') ? parsed : null;
    }, SAVE_KEY, { timeout: 10_000 })
    .then((handle) => handle.jsonValue());
  const outcome = saved.state.log.entries.find((entry) => entry.kind === 'drill-outcome');
  expect(outcome).toMatchObject({ drillId: 'freeflow', option: 1, correct: false });
  expect(outcome.elapsedTimeS).toBeGreaterThanOrEqual(240);

  // The dive then ends at the surface, as tests/post-dive.spec.js ends one:
  // 25.5 minutes at 20 m, a fast ascent 90 s before the end and the safety
  // stop skipped, the drill's entry kept where the model logged it.
  const endS = 1530;
  const profile = [];
  for (let t = 0; t <= endS; t += 2) {
    profile.push({ elapsedTimeS: t, depthM: t < 120 ? (20 * t) / 120 : t < endS - 150 ? 20 : (20 * (endS - t)) / 150, ceilingM: 0 });
  }
  Object.assign(saved.state, {
    elapsedTimeS: endS,
    depthM: 0.1,
    verticalVelocityMpm: 0,
    completed: true,
    thirds: { startingGasL: 0, turnWarned: false, reserveHit: false },
    safetyStop: { needed: true, countdownStarted: true, remainingS: 150, paused: true, complete: false },
  });
  Object.assign(saved.state.log, {
    entries: [outcome, { kind: 'fast-ascent', elapsedTimeS: endS - 90, value: 14.2 }, { kind: 'safety-stop-skipped', elapsedTimeS: endS, value: 0 }],
    ascentRateMpm: 0,
    fastAscentS: 0,
    fastAscentPeakMpm: 0,
    fastAscentLatched: false,
    ceilingViolationS: 0,
    ceilingViolationLatched: false,
    depthTimeMS: 16 * (endS - 60),
    submergedS: endS - 60,
    profile,
    profileTimerS: 0,
    lastCeilingM: 0,
  });
  saved.drill = { ...saved.drill, freeflowUntilS: 0, freeflowTankIndex: -1, breathHoldUntilS: 0 };
  await page.goto('/dist/');
  await page.evaluate(([key, value]) => window.localStorage.setItem(key, value), [SAVE_KEY, JSON.stringify(saved)]);
  await page.locator('[data-accept-safety]').click();
  await page.locator('[data-resume-continue]').click();
  const screen = page.locator('[data-post-dive]');
  await screen.waitFor();

  // The violations and the grade are as without a drill: legacy's gradeDive()
  // reads fast ascents and ceilings only. One fast ascent (85), the stop
  // skipped (30), the thirds (100), no ceiling (100), the depth (100): 83.
  await expect(screen.locator('.post-dive-violation-list li')).toHaveText([
    /^24 min,? 0 sec Fast ascent, peak 14\.2 m\/min$/,
    /^25 min,? 30 sec Safety stop skipped$/,
  ]);
  await expect(screen.locator('.post-dive-grade [data-overall]')).toHaveText('83');
  await expect(screen.locator('[data-grade-category] .post-dive-score-value')).toHaveText(['85', '30', '100', '100', '100']);

  // On the profile, legacy's red dot at the drill's time and the nearest
  // sample's depth, 20 m, unnumbered beside the two numbered violations; the
  // chart's text alternative names it, and the legend keys it.
  const minutes = Math.floor(Math.round(outcome.elapsedTimeS) / 60);
  const secs = Math.round(outcome.elapsedTimeS) % 60;
  const plot = screen.getByRole('img', {
    name: new RegExp(
      `2 marks, numbered as in the violations list\\. An unnumbered dot marks the training drill at ${minutes} min,? ${secs} sec: Regulator Free-Flow\\. Suboptimal choice\\.$`,
    ),
  });
  await expect(plot.locator('.profile-marker:not(.profile-marker-drill)')).toHaveText(['1', '2']);
  const dot = plot.locator('[data-marker=drill-outcome]');
  await expect(dot).toHaveCount(1);
  await expect(dot).toHaveText('');
  await expect(dot).toHaveCSS('background-color', 'rgb(255, 59, 59)');
  const [x, y] = await dot.evaluate((el) => [parseFloat(el.style.left), parseFloat(el.style.top)]);
  expect(x).toBeCloseTo((outcome.elapsedTimeS / endS) * 100, 2);
  expect(y).toBeCloseTo(100, 2);
  await expect(screen.locator('.profile-legend li')).toHaveText(['Depth', 'Deco ceiling', 'Violation, numbered as listed', 'Training drill']);
});

test('by keyboard, on a rebreather: the co2 drill fails the scrubber, bailing out is right, and the debriefing ends by itself after 5 s', async ({ page }) => {
  await offerDiveUnderWay(page, 'ccr', false);
  await page.locator('[data-setup-drills]').click();
  await page.locator('[data-resume-continue]').click();
  const decision = page.getByRole('dialog', { name: '⚠ TRAINING DRILL CO2 Buildup In The Loop' });
  await expect(decision).toBeVisible({ timeout: 20_000 });
  // Its warning tone is the dive computer's CO₂ warning, still drawn behind it.
  await expect(page.locator('.wreck-warning')).not.toBeEmpty();
  await expect(page.locator('.wreck-ccr')).toBeVisible();
  await page.keyboard.press('1');
  await expect(page.getByRole('dialog', { name: /Correct choice$/ })).toBeVisible();
  // Bailed out at once: the loop's controls are gone behind the debriefing.
  await expect(page.locator('.wreck-ccr')).toBeHidden();
  await expect(drill(page)).not.toBeVisible({ timeout: 8_000 });
});

test.describe('by touch, in German, on a phone', () => {
  test.use({ locale: 'de-DE', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('the toggle and the options are 44 px targets 8 px apart, a tap picks, a tap outside ends the debriefing', async ({ page }) => {
    await offerDiveUnderWay(page, 'rec', true);
    const toggle = page.locator('[data-setup-drills]');
    await toggle.tap();
    await expect(toggle).toHaveText('Trainings-Drills: ON');
    const box = await toggle.boundingBox();
    expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
    await page.locator('[data-resume-continue]').tap();

    const decision = page.getByRole('dialog', { name: '⚠ TRAININGS-DRILL Vereister Automat' });
    await expect(decision).toBeVisible({ timeout: 20_000 });
    const rows = await decision.locator('[data-drill-option]').evaluateAll((buttons) =>
      buttons.map((el) => el.getBoundingClientRect()).map((r) => ({ top: r.top, bottom: r.bottom, w: r.width, h: r.height })));
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(Math.min(r.w, r.h)).toBeGreaterThanOrEqual(44);
    expect(rows[1].top - rows[0].bottom).toBeGreaterThanOrEqual(8);
    // Nothing under the modal is pressed (#168's touch presses included): a
    // tap on the torch and on help lands on the backdrop, and the decision stays.
    for (const control of ['[data-torch]', '[data-help-open]']) {
      const under = await page.locator(control).boundingBox();
      await page.touchscreen.tap(under.x + under.width / 2, under.y + under.height / 2);
    }
    await expect(page.locator('[data-torch]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-help-overlay]')).not.toBeVisible();
    await expect(decision).toBeVisible();
    // Android's back, a close the browser makes itself: the drill stays up, and a tap still answers it.
    await refuseToClose(page, decision);

    await decision.locator('[data-drill-option="1"]').tap();
    const debrief = page.getByRole('dialog', { name: 'AUSWERTUNG — Vereister Automat Suboptimale Entscheidung' });
    await expect(debrief).toBeVisible();
    const proceed = page.locator('[data-drill-continue]');
    await expect(proceed).toHaveText('Weiter');
    const continueBox = await proceed.boundingBox();
    expect(Math.min(continueBox.width, continueBox.height)).toBeGreaterThanOrEqual(44);
    await refuseToClose(page, debrief);
    // Outside the card, on the backdrop beside it: legacy's tap anywhere.
    const card = await debrief.boundingBox();
    expect(card.x).toBeGreaterThan(8);
    await page.touchscreen.tap(4, card.y + card.height / 2);
    await expect(drill(page)).not.toBeVisible();
  });
});
