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
  // Escape does not close it, nor H open the help behind it.
  await page.keyboard.press('Escape');
  await page.keyboard.press('h');
  await expect(decision).toBeVisible();
  await expect(page.locator('[data-help-overlay]')).not.toBeVisible();

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

  await page.keyboard.press('Enter');
  await expect(drill(page)).not.toBeVisible();
  await expect.poll(() => hudTime(page)).not.toBe(stopped);
  // At most one per dive.
  await page.waitForTimeout(2000);
  await expect(drill(page)).not.toBeVisible();
  expect(await writes()).toBe(2);
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

    await decision.locator('[data-drill-option="1"]').tap();
    const debrief = page.getByRole('dialog', { name: 'AUSWERTUNG — Vereister Automat Suboptimale Entscheidung' });
    await expect(debrief).toBeVisible();
    const proceed = page.locator('[data-drill-continue]');
    await expect(proceed).toHaveText('Weiter');
    const continueBox = await proceed.boundingBox();
    expect(Math.min(continueBox.width, continueBox.height)).toBeGreaterThanOrEqual(44);
    // Outside the card, on the backdrop beside it: legacy's tap anywhere.
    const card = await debrief.boundingBox();
    expect(card.x).toBeGreaterThan(8);
    await page.touchscreen.tap(4, card.y + card.height / 2);
    await expect(drill(page)).not.toBeVisible();
  });
});
