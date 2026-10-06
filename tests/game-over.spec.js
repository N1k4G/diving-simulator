const { expect, test } = require('@playwright/test');
const { acceptSafetyGate } = require('./helpers/start-dive.cjs');

// The game-over screen (#159): legacy's drawGameOver() as DOM. The text
// comes from src/constants.js (GAME_OVER_INFO and STRINGS), the flow from
// src/game-loop.js: a failure switches to game over on that tick, the save is
// cleared, and Enter returns to the gas setup.

const SAVE_KEY = 'diving-simulator.save-game';

const persistedSave = (page) =>
  page
    .waitForFunction((key) => {
      const raw = window.localStorage.getItem(key);
      return raw === null ? null : JSON.parse(raw);
    }, SAVE_KEY)
    .then((handle) => handle.jsonValue());

/**
 * Starts a dive, turns its save into a failure with `reason`, and resumes it.
 * `editState` makes the saved state one that failure could have ended.
 */
async function resumeFailedDive(page, reason, configure, editState) {
  await page.goto('/dist/');
  await page.evaluate(() => window.localStorage.clear());
  await acceptSafetyGate(page);
  if (configure) await configure(page);
  await page.locator('[data-start-dive]').click();
  await page.locator('[data-renderer=pixi] canvas').waitFor();

  const saved = await persistedSave(page);
  if (editState) editState(saved.state);
  saved.state.failure.reason = reason;
  saved.state.events.push({
    type: 'failure',
    elapsedTimeS: saved.state.elapsedTimeS,
    failureReason: reason,
  });
  await page.goto('/dist/');
  await page.evaluate(
    ([key, value]) => window.localStorage.setItem(key, value),
    [SAVE_KEY, JSON.stringify(saved)],
  );
  await acceptSafetyGate(page);
  await page.locator('[data-start-dive]').click();
  await page.locator('[data-game-over]').waitFor();
  return saved;
}

/** A technical dive on a 0% oxygen mix: hypoxic at once, so it fails in ~10 s. */
async function configureHypoxicTec(page) {
  await page.locator('[data-setup-group=mode] [data-setup-option=tec]').check();
  await page.locator('[data-setup-option=tec]').evaluate((el) => el.blur());
  for (let i = 0; i < 25; i += 1) await page.keyboard.press('ArrowLeft');
  await expect(page.locator('[data-setup-value=oxygen]')).toContainText('0');
}

test('an out-of-gas failure ends on the game-over screen with legacy\'s explanation', async ({ page }) => {
  const saved = await resumeFailedDive(page, 'out-of-gas');
  const screen = page.locator('[data-game-over]');

  await expect(screen.getByRole('heading', { level: 1 })).toHaveText('Game over');
  await expect(page.locator('[data-game-over-reason]')).toHaveText('Out of gas');
  // GAME_OVER_INFO['OUT OF GAS'], all three sections.
  await expect(screen.getByRole('heading', { name: 'What happened' })).toBeVisible();
  await expect(screen).toContainText('All tanks depleted — no breathing gas remaining.');
  await expect(screen.getByRole('heading', { name: 'Medical' })).toBeVisible();
  await expect(screen.getByRole('heading', { name: 'How to avoid' })).toBeVisible();
  await expect(screen.locator('.game-over-prevention li')).toHaveCount(4);
  // The wreck is an overhead site, so legacy's overhead box is shown.
  await expect(screen.getByRole('heading', { name: '⚠ Overhead environment' })).toBeVisible();
  // Dive time and max depth, from the failed state.
  await expect(screen.locator('.result-stats')).toContainText('Dive time');
  await expect(screen.locator('.result-stats')).toContainText(`${saved.state.maxDepthM}`.slice(0, 2));

  // Focus moves to the heading instead of an aria-live announcement (#138).
  await expect(page.locator('#game-over-heading')).toBeFocused();
  await expect(screen.locator('[aria-live], [role=alert], [role=status]')).toHaveCount(0);

  // The dive view is gone, and so is the save: a failed dive is not resumed.
  await expect(page.locator('.wreck-shell')).toHaveCount(0);
  expect(await page.evaluate((key) => window.localStorage.getItem(key), SAVE_KEY)).toBeNull();
});

test('a rebreather failure shows its label, without explanation sections, as legacy', async ({ page }) => {
  // Legacy has no GAME_OVER_INFO entry for the CCR causes.
  await resumeFailedDive(page, 'ccr-co2', async (target) => {
    await target.locator('[data-setup-group=mode] [data-setup-option=ccr]').check();
  });
  await expect(page.locator('[data-game-over-reason]')).toHaveText('CO₂ poisoning — scrubber exhausted');
  await expect(page.getByRole('heading', { name: 'What happened' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '⚠ Overhead environment' })).toBeVisible();
});

test('decompression sickness shows legacy\'s label and all three explanation sections', async ({ page }) => {
  // An end the model can reach, which is all the save takes: a minute in,
  // the DCS timer at its 60 s, and tissues loaded to a 27 m ceiling, so the
  // diver at 26 m is above its 30 m stop (#212 pre-review).
  await resumeFailedDive(page, 'decompression-sickness', undefined, (state) => {
    state.elapsedTimeS = Math.max(state.elapsedTimeS, 60);
    state.failure.dcsViolationS = 60;
    state.tissues.nitrogenBar = state.tissues.nitrogenBar.map(() => 4);
    state.tissues.heliumBar = state.tissues.heliumBar.map(() => 0);
  });
  const screen = page.locator('[data-game-over]');
  await expect(page.locator('[data-game-over-reason]')).toHaveText('Decompression sickness');
  // GAME_OVER_INFO['DECOMPRESSION SICKNESS'].
  await expect(screen).toContainText('Ascended above your decompression ceiling or surfaced with excess dissolved inert gas.');
  await expect(screen).toContainText('DCS ("the bends") occurs when dissolved inert gas comes out of solution');
  await expect(screen.locator('.game-over-prevention li')).toHaveCount(5);
  await expect(screen.locator('.game-over-prevention li').first()).toHaveText('Never ascend above your ceiling depth — watch the CEIL indicator');
});

test('a dive that fails while running switches to game over, and Enter returns to the setup as it was', async ({ page }) => {
  // No edited save here: a 0% oxygen mix goes hypoxic at once and the model
  // fails the dive after 10 s, which is the path a player takes.
  await page.goto('/dist/');
  await page.evaluate(() => window.localStorage.clear());
  await acceptSafetyGate(page);
  await configureHypoxicTec(page);
  await page.locator('[data-start-dive]').click();
  await page.locator('[data-renderer=pixi] canvas').waitFor();

  await expect(page.locator('[data-game-over]')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-game-over-reason]')).toHaveText('Hypoxia — loss of consciousness');
  expect(await page.evaluate((key) => window.localStorage.getItem(key), SAVE_KEY)).toBeNull();

  await page.keyboard.press('Enter');
  await page.locator('.setup-screen').waitFor();
  await expect(page.locator('[data-game-over]')).toHaveCount(0);
  // Legacy returns to its gas setup with the same settings.
  await expect(page.locator('[data-setup-group=mode] [data-setup-option=tec]')).toBeChecked();
  await expect(page.locator('[data-setup-value=oxygen]')).toContainText('0');
});

test('the retry button returns to the setup too', async ({ page }) => {
  await resumeFailedDive(page, 'hypoxia');
  await page.locator('[data-retry]').click();
  await page.locator('.setup-screen').waitFor();
});

test.describe('small phone', () => {
  // #120: legacy's result screens needed a custom canvas scroll offset to be
  // usable here. The DOM screen must be reachable by ordinary scrolling and
  // must not run off either edge.
  test.use({ viewport: { width: 320, height: 568 }, hasTouch: true });

  test('the whole screen is reachable by scrolling, nothing runs off an edge, and the retry target is 44px', async ({ page }) => {
    await resumeFailedDive(page, 'oxygen-toxicity');

    const overflow = await page.evaluate(() => {
      const doc = document.scrollingElement;
      return { scrollHeight: doc.scrollHeight, clientHeight: doc.clientHeight, scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth };
    });
    // Taller than the viewport, so scrolling is what makes it reachable...
    expect(overflow.scrollHeight).toBeGreaterThan(overflow.clientHeight);
    // ...and never wider, which would hide text off the side.
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);

    const offEdge = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('[data-game-over] *')) {
        if (!el.textContent.trim() || el.children.length > 0) continue;
        const r = el.getBoundingClientRect();
        if (r.width > 0 && (r.left < 0 || r.right > window.innerWidth + 0.5)) out.push(el.textContent.slice(0, 30));
      }
      return out;
    });
    expect(offEdge).toEqual([]);

    const retry = page.locator('[data-retry]');
    await retry.scrollIntoViewIfNeeded();
    await expect(retry).toBeInViewport();
    const box = await retry.boundingBox();
    expect(Math.round(box.height)).toBeGreaterThanOrEqual(44);
    expect(Math.round(box.width)).toBeGreaterThanOrEqual(44);

    await retry.tap();
    await page.locator('.setup-screen').waitFor();
  });
});
