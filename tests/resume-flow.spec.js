const { expect, test } = require('./helpers/pinned-seed.cjs');
const { acceptSafetyGate, descendTo } = require('./helpers/start-dive.cjs');

// The resume flow (#191). Legacy offers a saved dive on its gas setup with a
// banner, Resume or Discard (src/game-loop.js _updateResumeBanner,
// resumeSavedDive, discardSavedDive; #67), and Enter there starts a new dive.
// Its restoreDiveState() writes the save's mode, factors and cylinders into
// the globals its setup is drawn from, so after a resumed dive fails, Enter
// returns to that dive's settings. The migration client used to resume the
// save behind Start, silently, and return a resumed dive's game over to the
// screen from before the resume.

const SAVE_KEY = 'diving-simulator.save-game';

const savedRaw = (page) => page.evaluate((key) => window.localStorage.getItem(key), SAVE_KEY);

/**
 * The save of a recreational dive a metre down, made technical: 50/80, a
 * 12 L cylinder filled to 230 bar and part breathed, and a 7 L one of EAN50
 * at 250 bar, untouched. What the setup screen shows by default is none of it.
 */
async function technicalSave(page) {
  await page.goto('/dist/');
  await page.evaluate(() => window.localStorage.clear());
  // By data attribute: the German case passes this gate too.
  await page.locator('[data-accept-safety]').click();
  await page.locator('[data-start-dive]').click();
  await page.locator('[data-renderer=pixi] canvas').waitFor();
  await descendTo(page, 1);
  const saved = await page
    .waitForFunction((key) => {
      const raw = window.localStorage.getItem(key);
      const parsed = raw === null ? null : JSON.parse(raw);
      return parsed !== null && parsed.state.elapsedTimeS > 0 ? parsed : null;
    }, SAVE_KEY)
    .then((handle) => handle.jsonValue());
  saved.diveMode = 'tec';
  saved.gradientFactors = { lowPercent: 50, highPercent: 80 };
  const first = saved.state.tanks[0];
  first.gasRemainingL += 12 * 30;
  first.startGasL = 12 * 230;
  saved.state.tanks.push({
    gas: { oxygenFraction: 0.5, heliumFraction: 0, nitrogenFraction: 0.5 },
    volumeL: 7,
    gasRemainingL: 1750,
    startGasL: 1750,
  });
  return saved;
}

/** Leaves the dive, writes `saved`, and reloads to the gate. */
async function seed(page, saved) {
  await page.goto('/dist/');
  await page.evaluate(([key, value]) => window.localStorage.setItem(key, value), [SAVE_KEY, JSON.stringify(saved)]);
  await page.goto('/dist/');
}

const banner = (page) => page.getByRole('region', { name: 'A saved dive was found. Resume?' });

test('a saved dive waits on the setup screen, and Resume reached by keyboard continues it', async ({ page }) => {
  const saved = await technicalSave(page);
  await seed(page, saved);
  await acceptSafetyGate(page);

  // Legacy's strip, in its words, at the top of the setup.
  await expect(banner(page)).toBeVisible();
  await expect(banner(page).getByRole('button')).toHaveText(['Resume', 'Discard']);
  expect(await page.locator('.setup-screen > *').first().getAttribute('data-resume-banner')).toBe('true');
  // It blocks nothing: the setup beneath it still answers.
  await page.locator('[data-setup-group=mode] [data-setup-option=ccr]').check();
  await expect(page.locator('[data-setup-stepper=setpoint]')).toBeVisible();

  // Before every control in the tab order, and Enter on it is Resume, not
  // Start.
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('[data-resume-discard]')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('[data-resume-continue]')).toBeFocused();
  await page.keyboard.press('Enter');

  await page.locator('[data-renderer=pixi] canvas').waitFor();
  await expect(page.locator('.setup-screen')).toHaveCount(0);
  // The saved dive, under way and on its two cylinders, not a new one.
  await expect(page.locator('[data-surface-prompt]')).toBeHidden();
  await expect(page.locator('[data-tank]')).toHaveCount(2);
});

test('Discard clears the save, and Start then begins a new dive on the screen\'s settings', async ({ page }) => {
  await seed(page, await technicalSave(page));
  await acceptSafetyGate(page);

  await banner(page).getByRole('button', { name: 'Discard' }).click();
  await expect(page.locator('[data-resume-banner]')).toHaveCount(0);
  expect(await savedRaw(page)).toBeNull();
  // Focus goes on to where Tab would have taken it, not to the page.
  await expect(page.locator('[data-setup-group=mode] [data-setup-option=rec]')).toBeFocused();

  await page.locator('[data-start-dive]').click();
  await page.locator('[data-renderer=pixi] canvas').waitFor();
  await expect(page.locator('[data-surface-prompt]')).toBeVisible();
  await expect(page.locator('.wreck-hud [data-hud-metric="time"] dd')).toHaveText('0 sec');
});

// docs/decisions.md, deliberate departures: legacy leaves its strip drawn
// over the new dive and can restore the old save mid-dive; here Start ends
// the offer.
test('Start with the banner up ends the offer and begins a new dive on the screen\'s settings, whose saves replace the old one', async ({ page }) => {
  await seed(page, await technicalSave(page));
  await acceptSafetyGate(page);
  await expect(banner(page)).toBeVisible();

  await page.locator('[data-start-dive]').click();
  await page.locator('[data-renderer=pixi] canvas').waitFor();
  // No resume is offered over the dive.
  await expect(page.locator('[data-resume-banner], [data-resume-continue]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Resume' })).toHaveCount(0);
  // A new dive at the surface, recreational on one cylinder, where Start
  // used to resume the save behind the screen.
  await expect(page.locator('[data-surface-prompt]')).toBeVisible();
  await expect(page.locator('.wreck-hud [data-hud-metric="time"] dd')).toHaveText('0 sec');
  const replaced = await page
    .waitForFunction((key) => {
      const parsed = JSON.parse(window.localStorage.getItem(key) ?? 'null');
      return parsed !== null && parsed.diveMode === 'rec' ? parsed : null;
    }, SAVE_KEY, { timeout: 15_000 })
    .then((handle) => handle.jsonValue());
  expect(replaced.state.tanks).toHaveLength(1);
  expect(replaced.state.elapsedTimeS).toBe(0);
  // Still none once the old save is gone.
  await expect(page.locator('[data-resume-banner], [data-resume-continue]')).toHaveCount(0);
});

test('a save more than an hour old is cleared and not offered, as legacy\'s loadSavedDive()', async ({ page }) => {
  const saved = await technicalSave(page);
  await page.goto('/dist/');
  // An hour and a second before the page's clock, as legacy compares.
  await page.evaluate(([key, value]) => {
    const aged = JSON.parse(value);
    aged.savedAtEpochMs = Date.now() - 3_600_001;
    window.localStorage.setItem(key, JSON.stringify(aged));
  }, [SAVE_KEY, JSON.stringify(saved)]);
  await page.goto('/dist/');
  await acceptSafetyGate(page);

  await expect(page.locator('[data-resume-banner]')).toHaveCount(0);
  expect(await savedRaw(page)).toBeNull();
});

/** A rebreather dive a metre down, its save changed by `mutate`. */
async function rebreatherSave(page, mutate) {
  await page.goto('/dist/');
  await page.evaluate(() => window.localStorage.clear());
  await acceptSafetyGate(page);
  await page.locator('[data-setup-group=mode] [data-setup-option=ccr]').check();
  // No screen sets the diluent's pressure; a new dive's is legacy's 200 bar.
  await expect(page.locator('[data-setup-value=diluent-pressure]')).toHaveText(/^200\sbar$/);
  await page.locator('[data-start-dive]').click();
  await page.locator('[data-renderer=pixi] canvas').waitFor();
  await descendTo(page, 1);
  const saved = await savedDive(page, true);
  mutate(saved.state);
  return saved;
}

/** The page's save once the dive is under way (`underWay`), or still at the surface. */
function savedDive(page, underWay) {
  return page
    .waitForFunction(([key, wanted]) => {
      const parsed = JSON.parse(window.localStorage.getItem(key) ?? 'null');
      return parsed !== null && (parsed.state.elapsedTimeS > 0) === wanted ? parsed : null;
    }, [SAVE_KEY, underWay], { timeout: 30_000 })
    .then((handle) => handle.jsonValue());
}

const bar = (text) => Number.parseFloat((text ?? '').replace(',', '.'));

test('a rebreather dive resumed and failed retries on its cylinders and setpoint as the dive left them, as legacy\'s resetDive()', async ({ page }) => {
  test.setTimeout(90_000);
  // Saved at 150 bar of oxygen and 160 of diluent on a 1.3 bar setpoint,
  // with a spent scrubber 60 dive seconds short of CO2 poisoning: the
  // resumed dive breathes on past what the save holds before it fails.
  await seed(page, await rebreatherSave(page, (state) => Object.assign(state.ccr, {
    targetPo2Bar: 1.3,
    oxygenCylinderPressureBar: 150,
    diluentCylinderPressureBar: 160,
    scrubberRemainingS: 0,
    scrubberTotalS: 0,
    scrubberFailed: true,
    co2BuildupS: 120,
  })));
  await acceptSafetyGate(page);
  await page.locator('[data-resume-continue]').click();
  await page.locator('[data-game-over]').waitFor({ timeout: 60_000 });

  await page.keyboard.press('Enter');
  await page.locator('.setup-screen').waitFor();
  await expect(page.locator('[data-setup-group=mode] [data-setup-option=ccr]')).toBeChecked();
  await expect(page.locator('[data-setup-value=setpoint]')).toHaveText('1.3 bar');
  const shownOxygen = bar(await page.locator('[data-setup-value=oxygen-pressure]').textContent());
  const shownDiluent = bar(await page.locator('[data-setup-value=diluent-pressure]').textContent());

  await page.locator('[data-start-dive]').click();
  await page.locator('[data-renderer=pixi] canvas').waitFor();
  // The retry's own save holds the exact pressures it started on, at the
  // surface where nothing is breathed (#199): what the failed dive left,
  // not refilled to 200. The loop always draws oxygen, so that is under the
  // save's 150 bar; it draws diluent only when the diver goes deeper or the
  // BCD inflates, which a run may or may not do, so that is at most the
  // save's 160.
  const retried = await savedDive(page, false);
  const { oxygenCylinderPressureBar: oxygen, diluentCylinderPressureBar: diluent } = retried.state.ccr;
  expect(oxygen).toBeLessThan(150);
  expect(oxygen).toBeGreaterThan(140);
  expect(diluent).toBeLessThanOrEqual(160);
  expect(diluent).toBeGreaterThan(140);
  expect(retried.state.ccr.targetPo2Bar).toBeCloseTo(1.3, 10);
  // The setup showed those values to one decimal, and the HUD shows them
  // rounded to the bar, each from the same number.
  expect(Math.abs(shownOxygen - oxygen)).toBeLessThanOrEqual(0.05);
  expect(Math.abs(shownDiluent - diluent)).toBeLessThanOrEqual(0.05);
  await expect(page.locator('.wreck-hud [data-hud-metric="oxygenCylinder"] dd')).toHaveText(new RegExp(`^${Math.round(oxygen)}\\sbar$`));
  await expect(page.locator('.wreck-hud [data-hud-metric="diluentCylinder"] dd')).toHaveText(new RegExp(`^${Math.round(diluent)}\\sbar$`));
});

test('an emptied diluent cylinder is shown on the retry\'s setup, as legacy\'s gas setup prints it', async ({ page }) => {
  await seed(page, await rebreatherSave(page, (state) => {
    state.ccr.diluentCylinderPressureBar = 0;
    state.failure.reason = 'ccr-co2';
    state.events.push({ type: 'failure', elapsedTimeS: state.elapsedTimeS, failureReason: 'ccr-co2' });
  }));
  await acceptSafetyGate(page);
  await page.locator('[data-resume-continue]').click();
  await page.locator('[data-game-over]').waitFor();

  await page.keyboard.press('Enter');
  await page.locator('.setup-screen').waitFor();
  await expect(page.locator('[data-setup-value=diluent-pressure]')).toHaveText(/^0\sbar$/);
});

test.describe('on a small landscape phone', () => {
  test.use({ viewport: { width: 667, height: 375 } });

  test('keyboard focus is never hidden behind the banner (WCAG 2.2 SC 2.4.11)', async ({ page }) => {
    await seed(page, await technicalSave(page));
    await acceptSafetyGate(page);
    await page.locator('[data-start-dive]').focus();

    // Shift+Tab back from Start to Resume: each focused control lies inside
    // the panel's visible box and clear of the banner's.
    for (let step = 0; step < 40; step += 1) {
      const geometry = await page.evaluate(() => {
        const focused = document.activeElement;
        const rect = (el) => {
          const r = el.getBoundingClientRect();
          return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
        };
        const bannerEl = document.querySelector('[data-resume-banner]');
        return {
          inBanner: bannerEl !== null && bannerEl.contains(focused),
          continue: focused?.hasAttribute('data-resume-continue') ?? false,
          focused: rect(focused),
          banner: bannerEl === null ? null : rect(bannerEl),
          panel: rect(document.querySelector('.setup-screen')),
          name: focused?.outerHTML.slice(0, 80),
        };
      });
      const { focused, banner: box, panel } = geometry;
      expect(focused.top, geometry.name).toBeGreaterThanOrEqual(panel.top);
      expect(focused.bottom, geometry.name).toBeLessThanOrEqual(panel.bottom);
      if (!geometry.inBanner && box !== null) {
        const overlaps = focused.top < box.bottom && focused.bottom > box.top
          && focused.left < box.right && focused.right > box.left;
        expect(overlaps, geometry.name).toBe(false);
      }
      if (geometry.continue) return;
      await page.keyboard.press('Shift+Tab');
    }
    throw new Error('Shift+Tab never reached Resume');
  });
});

test('a resumed dive\'s game over returns to that dive\'s settings, and retries on them', async ({ page }) => {
  const saved = await technicalSave(page);
  saved.state.failure.reason = 'out-of-gas';
  saved.state.events.push({
    type: 'failure',
    elapsedTimeS: saved.state.elapsedTimeS,
    failureReason: 'out-of-gas',
  });
  await seed(page, saved);
  await acceptSafetyGate(page);
  await page.locator('[data-resume-continue]').click();
  await page.locator('[data-game-over]').waitFor();

  await page.keyboard.press('Enter');
  await page.locator('.setup-screen').waitFor();
  // The save went with the dive, so nothing is offered.
  await expect(page.locator('[data-resume-banner]')).toHaveCount(0);
  // The dive's settings, not the recreational default the screen showed
  // before the resume: technical, 50/80, two cylinders at their fills.
  await expect(page.locator('[data-setup-group=mode] [data-setup-option=tec]')).toBeChecked();
  await expect(page.locator('[data-setup-value=gf-low]')).toHaveText('50%');
  await expect(page.locator('[data-setup-value=gf-high]')).toHaveText('80%');
  await expect(page.locator('[data-setup-tab]')).toHaveCount(2);
  await expect(page.locator('[data-setup-value=pressure]')).toHaveText('230 bar');
  await page.locator('[data-setup-tab="1"]').click();
  await expect(page.locator('[data-setup-value=pressure]')).toHaveText('250 bar');
  await expect(page.locator('[data-setup-value=oxygen]')).toContainText('50');
  await expect(page.locator('[data-setup-value=volume]')).toHaveText('7 L');

  // And the retry starts full on them, on the first cylinder.
  await page.locator('[data-start-dive]').click();
  await page.locator('[data-renderer=pixi] canvas').waitFor();
  await expect(page.locator('.wreck-hud [data-hud-metric=gas] dd')).toContainText('230');
});

test.describe('in German, on a phone', () => {
  test.use({ locale: 'de-DE', viewport: { width: 390, height: 844 }, hasTouch: true });

  test('the banner reads legacy\'s German, its buttons are touch targets, and nothing runs off the side', async ({ page }) => {
    await seed(page, await technicalSave(page));
    await page.locator('[data-accept-safety]').click();
    await page.locator('.setup-screen').waitFor();

    const german = page.getByRole('region', { name: 'Ein gespeicherter Tauchgang wurde gefunden. Fortsetzen?' });
    await expect(german).toBeVisible();
    await expect(german.getByRole('button')).toHaveText(['Fortsetzen', 'Verwerfen']);
    for (const button of await german.getByRole('button').all()) {
      const box = await button.boundingBox();
      expect(Math.round(box.height)).toBeGreaterThanOrEqual(44);
      expect(Math.round(box.width)).toBeGreaterThanOrEqual(44);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
    }

    await german.getByRole('button', { name: 'Fortsetzen' }).tap();
    await page.locator('[data-renderer=pixi] canvas').waitFor();
    await expect(page.locator('[data-tank]')).toHaveCount(2);
  });
});
