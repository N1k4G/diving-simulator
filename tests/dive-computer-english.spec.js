const { expect, test } = require('./helpers/pinned-seed.cjs');
const { descendTo } = require('./helpers/start-dive.cjs');

// The dive computer reads English in both languages, its warnings included
// (#232, owner decision 2026-10-07), as legacy draws its dive computer
// (src/renderer.js drawDiveComputer) in English in both. Everything around
// it stays German in a German browser: the safety gate, the controls and
// their names, the surface prompt, the location row and the running chip.
// The dive computer's elements carry lang="en", so a German screen reader
// speaks the English it shows.

test.use({ locale: 'de-DE' });

const SAVE_KEY = 'diving-simulator.save-game';

const hudRow = (page, name) => page.locator(`.wreck-hud [data-hud-metric="${name}"]`);
const hudTerm = (page, name) => hudRow(page, name).locator('dt');
const hudValue = (page, name) => hudRow(page, name).locator('dd');

/** The German gate is passed by its data attribute, not its English name. */
async function startGermanDive(page) {
  await page.goto('/dist/');
  await page.evaluate(() => window.localStorage.clear());
  await expect(page.locator('#safety-heading')).toHaveText('Dies ist eine Simulation, kein Tauchplaner');
  await page.locator('[data-accept-safety]').click();
  await page.locator('.setup-screen').waitFor();
  await page.locator('[data-start-dive]').click();
  await page.locator('[data-renderer=pixi] canvas').waitFor();
}

/** tests/hud-readouts.spec.js resumeWith, through the German gate. */
async function resumeWith(page, mutate) {
  await startGermanDive(page);
  await descendTo(page, 1);
  const saved = await page
    .waitForFunction((key) => {
      const raw = window.localStorage.getItem(key);
      const parsed = raw === null ? null : JSON.parse(raw);
      return parsed !== null && parsed.state.elapsedTimeS > 0 ? parsed : null;
    }, SAVE_KEY)
    .then((handle) => handle.jsonValue());
  mutate(saved.state);
  await page.goto('/dist/');
  await page.evaluate(
    ([key, value]) => window.localStorage.setItem(key, value),
    [SAVE_KEY, JSON.stringify(saved)],
  );
  await page.locator('[data-accept-safety]').click();
  await page.locator('.setup-screen').waitFor();
  await page.locator('[data-start-dive]').click();
  await page.locator('[data-renderer=pixi] canvas').waitFor();
}

test('the readouts are English, numbers included, and what is around them stays German', async ({ page }) => {
  await startGermanDive(page);
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');

  const hud = page.locator('.wreck-hud');
  await expect(hud).toHaveAttribute('lang', 'en');
  for (const [metric, label] of [
    ['depth', 'Depth'],
    ['ascentRate', 'Ascent rate'],
    ['time', 'Dive time'],
    ['gas', 'Gas'],
    ['cylinder', 'Cylinder'],
    ['ndl', 'No-decompression time'],
  ]) {
    await expect(hudTerm(page, metric)).toHaveText(label);
  }
  // English numbers and units, not "1 Min., 40 Sek." or "21,0 %".
  await expect(hudValue(page, 'ascentRate')).toHaveText('0 m/min');
  await expect(hudValue(page, 'time')).toHaveText(/^\d+ sec$/);
  await expect(hudValue(page, 'cylinder')).toHaveText(/^1 · 21(\.\d)?% O₂$/);

  // The location row is not the dive computer's.
  await expect(hudRow(page, 'zone')).toHaveAttribute('lang', 'de');
  await expect(hudTerm(page, 'zone')).toHaveText('Ort');
  await expect(hudValue(page, 'zone')).toHaveText('Wrackaußenseite');

  // Nor are the surface prompt, the controls or the running chip.
  await expect(page.locator('[data-surface-prompt]')).toHaveText(
    'An der Oberfläche. S oder ↓ drücken zum Ablassen und Abtauchen',
  );
  await expect(page.getByRole('button', { name: 'BCD ablassen (abtauchen)' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Audio stummschalten' })).toBeVisible();
  const chip = page.locator('.status-chip');
  await expect(chip).toHaveText('Simulation läuft');
  await expect(chip).toHaveAttribute('lang', 'de');

  await descendTo(page, 2);
  await expect(hudValue(page, 'depth')).toHaveText(/^\d+(\.\d)? m$/);
});

test('a fast ascent warns in English, alert and chip both, and both are marked English', async ({ page }) => {
  await resumeWith(page, (state) => {
    state.depthM = 20;
    state.maxDepthM = Math.max(state.maxDepthM, 20);
    state.verticalVelocityMpm = 0;
    state.bcdGasSurfaceLiters = 40;
  });

  const alert = page.getByRole('alert');
  await expect(alert).toHaveText('Ascending too fast — slow down', { timeout: 15_000 });
  await expect(alert).toHaveAttribute('lang', 'en');
  const chip = page.locator('.status-chip');
  await expect(chip).toHaveText('⚠ Fast ascent');
  await expect(chip).toHaveAttribute('lang', 'en');
  await expect(hudValue(page, 'ascentRate')).toHaveText(/^⚠ ↑ \d+ m\/min$/);
});

for (const [what, remainingS, reading] of [
  // English units, not "noch 1 Min., 40 Sek.".
  ['counts down in English units', 100, /^5 m · 1 min,? \d+ sec left( · paused)?$/],
  // Legacy's SAFETY STOP / Complete, not "Absolviert".
  ['ends Complete', 1, /^Complete$/],
]) {
  test(`a safety stop ${what}`, async ({ page }) => {
    await resumeWith(page, (state) => {
      state.depthM = 5;
      state.maxDepthM = Math.max(state.maxDepthM, 24);
      state.verticalVelocityMpm = 0;
      state.safetyStop = {
        needed: true,
        countdownStarted: true,
        remainingS,
        paused: false,
        complete: false,
      };
    });

    await expect(hudTerm(page, 'safetyStop')).toHaveText('Safety stop');
    await expect(hudValue(page, 'safetyStop')).toHaveText(reading);
  });
}

test('under a ceiling the stop row reads Deco stop', async ({ page }) => {
  // tests/hud-readouts.spec.js's deco case: loaded tissues, neutral at 18 m.
  await resumeWith(page, (state) => {
    state.depthM = 18;
    state.maxDepthM = 34;
    state.verticalVelocityMpm = 0;
    state.bcdGasSurfaceLiters = 9.990465669399928;
    state.tissues.nitrogenBar = state.tissues.nitrogenBar.map(() => 3);
  });

  await expect(hudRow(page, 'safetyStop')).toHaveAttribute('data-phase', 'deco');
  await expect(hudTerm(page, 'safetyStop')).toHaveText('Deco stop');
  await expect(hudValue(page, 'safetyStop')).toHaveText(/^\d+ m · \d+ min$/, { timeout: 15_000 });
});
