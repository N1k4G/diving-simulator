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

test('Start with the banner up begins a new dive on the screen\'s settings, whose saves replace the old one', async ({ page }) => {
  await seed(page, await technicalSave(page));
  await acceptSafetyGate(page);
  await expect(banner(page)).toBeVisible();

  await page.locator('[data-start-dive]').click();
  await page.locator('[data-renderer=pixi] canvas').waitFor();
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
