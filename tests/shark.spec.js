const { expect, test, PINNED_DIVE_SEED } = require('./helpers/pinned-seed.cjs');
const { acceptSafetyGate } = require('./helpers/start-dive.cjs');

// The shark in the migration client (#219 part 2): each dive draws its own
// seed at its start and keeps it in the save, and the controller hands the
// model the world the shark swims in, so a shark that reaches the diver rolls
// and can end the dive. The rolls come from the save's random state, so a
// save with a shark close by plays out the same every time.

const SAVE_KEY = 'diving-simulator.save-game';

// src/core/rng.ts nextRandom(): the first roll of random state 0 is 0.266,
// under the 0.33 that attacks; of 1 it is 0.627, which lets the diver be.
const ATTACKS = 0;
const SPARES = 1;

const persistedSave = (page) =>
  page
    .waitForFunction((key) => {
      const raw = window.localStorage.getItem(key);
      return raw === null ? null : JSON.parse(raw);
    }, SAVE_KEY)
    .then((handle) => handle.jsonValue());

/** The first save after the shark has passed the diver. */
const saveWithSharkPassed = (page) =>
  page
    .waitForFunction((key) => {
      const raw = window.localStorage.getItem(key);
      const save = raw === null ? null : JSON.parse(raw);
      return save !== null && save.state.shark.encounter !== null && save.state.shark.encounter.passed ? save : null;
    }, SAVE_KEY)
    .then((handle) => handle.jsonValue());

/** Starts a fresh dive and returns its first save, written at the surface. */
async function firstSave(page) {
  await page.goto('/dist/');
  await page.evaluate(() => window.localStorage.clear());
  await acceptSafetyGate(page);
  await page.locator('[data-start-dive]').click();
  await page.locator('[data-renderer=pixi] canvas').waitFor();
  return persistedSave(page);
}

/**
 * Resumes a dive two minutes in at 18 m, a shark 3 m behind the diver and
 * closing at its depth, on `randomState`.
 */
async function resumeWithSharkClosing(page, randomState) {
  const saved = await firstSave(page);
  Object.assign(saved.state, {
    elapsedTimeS: 120,
    depthM: 18,
    maxDepthM: 18,
    verticalVelocityMpm: 0,
    randomState,
  });
  saved.state.shark = {
    timerS: 60,
    encounter: { offsetM: -3, depthM: 18, direction: 1, speedMps: 7.5, passed: false },
  };
  await page.goto('/dist/');
  await page.evaluate(([key, value]) => window.localStorage.setItem(key, value), [SAVE_KEY, JSON.stringify(saved)]);
  await acceptSafetyGate(page);
  await page.locator('[data-start-dive]').click();
}

test.describe('a dive on a seed of its own', () => {
  test.use({ diveSeed: 0x0badf00d });

  test('draws it at the dive\'s start and keeps it in the save', async ({ page }) => {
    const saved = await firstSave(page);
    expect(saved.state.randomState).toBe(0x0badf00d);
    expect(saved.state.randomState).not.toBe(PINNED_DIVE_SEED);
  });
});

test('a shark that reaches the diver on a roll under 0.33 ends the dive in a shark attack', async ({ page }) => {
  await resumeWithSharkClosing(page, ATTACKS);
  await expect(page.locator('[data-game-over]')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-game-over-reason]')).toHaveText('Shark attack');
});

test('a shark that reaches the diver on a roll of 0.33 or more passes, faster, and the dive goes on', async ({ page }) => {
  await resumeWithSharkClosing(page, SPARES);
  const passed = await saveWithSharkPassed(page);
  expect(passed.state.shark.encounter.speedMps).toBe(12);
  expect(passed.state.failure.reason).toBeNull();
  await expect(page.locator('[data-game-over]')).toHaveCount(0);
});
