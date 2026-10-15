const { expect, test } = require('./helpers/pinned-seed.cjs');
const {
  acceptSafetyGate,
  beginDescent,
  descendTo,
  startDiveAndWaitForCanvas,
} = require('./helpers/start-dive.cjs');

// The help overlay (#160): legacy's H / ? overlay (src/state.js
// showHtmlHelp) as a modal dialog over the stage. H, ? and Escape close it,
// so do its Close button and a tap outside it; under water the dive stands
// still while it is open, as legacy's gameLoop() skips updateDiving(); over
// the debriefing it scrolls on its own, the case #120 fixed in legacy.

const SAVE_KEY = 'diving-simulator.save-game';

const overlay = (page) => page.locator('[data-help-overlay]');
const hudValue = (page, name) => page.locator(`.wreck-hud [data-hud-metric="${name}"] dd`);
const isOpen = (page) => overlay(page).evaluate((dialog) => dialog.open);

/** The box of every visible button inside `selector`, for the #121 geometry. */
const buttonBoxes = (page, selector) =>
  page.evaluate((sel) => [...document.querySelectorAll(`${sel} button`)]
    .filter((el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden')
    .map((el) => {
      const r = el.getBoundingClientRect();
      return { label: el.getAttribute('aria-label') || el.textContent, x: r.x, y: r.y, w: r.width, h: r.height };
    }), selector);

/** The #121 test of tests/result-screen.spec.js: 44 px each, 8 px between neighbours. */
function expectTouchTargets(boxes) {
  const undersized = boxes.filter((b) => b.w < 44 || b.h < 44)
    .map((b) => `${b.label} is ${Math.round(b.w)}x${Math.round(b.h)}`);
  const tight = [];
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i];
      const b = boxes[j];
      const gapX = Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w);
      const gapY = Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h);
      const overlapX = gapX < 0;
      const overlapY = gapY < 0;
      if (overlapX && overlapY) {
        tight.push(`${a.label} overlaps ${b.label}`);
        continue;
      }
      if (overlapX === overlapY) continue;
      const gap = overlapX ? gapY : gapX;
      if (gap < 8) tight.push(`${a.label} <-> ${b.label} = ${gap.toFixed(1)}px`);
    }
  }
  expect(undersized, undersized.join('\n')).toEqual([]);
  expect(tight, tight.join('\n')).toEqual([]);
}

/** The rows' action keys, in order. */
const rowActions = (page) =>
  overlay(page).locator('[data-help-row]').evaluateAll((rows) => rows.map((row) => row.dataset.helpRow));

test('H opens it under water and stops the dive; Escape, ? and H work it by keyboard', async ({ page }) => {
  await page.goto('/dist/');
  await startDiveAndWaitForCanvas(page);
  await descendTo(page, 2);

  await page.keyboard.press('h');
  await expect(overlay(page)).toBeVisible();
  // A dialog named by its heading, focus inside it, and no live region:
  // announced once as focus moves in, never per frame (#138).
  await expect(page.getByRole('dialog', { name: 'Controls' })).toBeVisible();
  await expect(page.locator('[data-help-close]')).toBeFocused();
  expect(await overlay(page).evaluate((dialog) => dialog.querySelectorAll('[aria-live], [role=alert], [role=status]').length)).toBe(0);
  await expect(overlay(page).locator('.help-paused')).toHaveText('The dive is paused while this help is open.');
  // A recreational dive: one cylinder, no I, no loop.
  const actions = await rowActions(page);
  expect(actions).toContain('wreck.controls.ascend');
  for (const absent of ['help.action.cylinder', 'wreck.gasInfo.open', 'help.action.setpoint', 'wreck.controls.bailout']) {
    expect(actions).not.toContain(absent);
  }

  // Paused: no dive time passes, and S held behind it vents nothing.
  const time = await hudValue(page, 'time').textContent();
  const depth = await hudValue(page, 'depth').textContent();
  await page.keyboard.down('s');
  await page.waitForTimeout(1500);
  await page.keyboard.up('s');
  await expect(hudValue(page, 'time')).toHaveText(time);
  await expect(hudValue(page, 'depth')).toHaveText(depth);

  await page.keyboard.press('Escape');
  expect(await isOpen(page)).toBe(false);
  await expect(hudValue(page, 'time')).not.toHaveText(time);

  await page.keyboard.press('?');
  expect(await isOpen(page)).toBe(true);
  await page.keyboard.press('h');
  expect(await isOpen(page)).toBe(false);

  // Enter on the focused Close button closes it.
  await page.keyboard.press('Shift+?');
  expect(await isOpen(page)).toBe(true);
  await page.keyboard.press('Enter');
  expect(await isOpen(page)).toBe(false);
});

test('at the surface it leads with S, and S pressed behind it does not begin the dive', async ({ page }) => {
  await page.goto('/dist/');
  await startDiveAndWaitForCanvas(page);
  await expect(page.locator('[data-surface-prompt]')).toBeVisible();

  await page.locator('[data-help-open]').click();
  await expect(overlay(page).locator('h3').first()).toHaveText('At the surface');
  await expect(overlay(page).locator('.help-paused')).toHaveCount(0);
  await page.keyboard.press('s');
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-surface-prompt]')).toBeVisible();
  // Focus returns to the button that opened it.
  await expect(page.locator('[data-help-open]')).toBeFocused();
  await beginDescent(page);
});

test('a rebreather dive lists the setpoint, the bailout and I, and no cylinder keys', async ({ page }) => {
  await page.goto('/dist/');
  await startDiveAndWaitForCanvas(page, async (setup) => {
    await setup.locator('[data-setup-group=mode] [data-setup-option=ccr]').check();
  });
  await beginDescent(page);
  await page.keyboard.press('h');
  const actions = await rowActions(page);
  expect(actions).toEqual(expect.arrayContaining(['help.action.setpoint', 'wreck.controls.bailout', 'wreck.gasInfo.open']));
  expect(actions).not.toContain('help.action.cylinder');
  // The bailout's row says it cannot be undone, as its button's name does.
  await expect(overlay(page).locator('[data-help-row="wreck.controls.bailout"]')).toContainText('cannot be undone');
  // B behind the overlay bails out of nothing.
  await page.keyboard.press('b');
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-bailout]')).toBeVisible();
});

test.describe('on the smallest phone', () => {
  test.use({ viewport: { width: 320, height: 568 }, hasTouch: true });

  test('the topbar holds Help beside the chip, I and mute, all on screen and 44 px', async ({ page }) => {
    await page.goto('/dist/');
    await startDiveAndWaitForCanvas(page, async (setup) => {
      await setup.locator('[data-setup-group=mode] [data-setup-option=ccr]').check();
    });
    await descendTo(page, 1);
    await expect(page.locator('[data-gas-info-toggle]')).toBeVisible();
    const topbar = await buttonBoxes(page, '.topbar-actions');
    expect(topbar).toHaveLength(3);
    for (const box of topbar) {
      expect(box.x, `${box.label} inside the viewport`).toBeGreaterThanOrEqual(0);
      expect(box.x + box.w, `${box.label} inside the viewport`).toBeLessThanOrEqual(320);
    }
    expectTouchTargets(topbar);
    await page.locator('[data-help-open]').tap();
    expect(await isOpen(page)).toBe(true);
  });
});

test.describe('in German, on a phone, by touch', () => {
  test.use({ locale: 'de-DE', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('the topbar button opens it; Close and a tap outside close it; every target is 44 px', async ({ page }) => {
    await page.goto('/dist/');
    await page.locator('[data-accept-safety]').tap();
    await page.locator('.setup-screen').waitFor();
    await page.locator('[data-start-dive]').tap();
    await page.locator('[data-renderer=pixi] canvas').waitFor();
    await page.locator('[data-control="descend"]').tap();
    await expect(page.locator('[data-surface-prompt]')).toBeHidden();

    const button = page.locator('[data-help-open]');
    await expect(button).toHaveAttribute('aria-label', 'Hilfe');
    expectTouchTargets(await buttonBoxes(page, '.topbar-actions'));
    const topbar = await buttonBoxes(page, '.topbar-actions');
    for (const box of topbar) {
      expect(box.x + box.w, `${box.label} inside the viewport`).toBeLessThanOrEqual(390);
    }

    await button.tap();
    await expect(page.getByRole('dialog', { name: 'Steuerung' })).toBeVisible();
    await expect(overlay(page)).toContainText('H, ? oder ESC zum Schließen');
    await expect(overlay(page).locator('.help-safety')).toContainText(
      'BCD nahe der Oberfläche NICHT überfüllen, sonst kann ein unkontrollierter Aufstieg ein Lungenbarotrauma auslösen.',
    );
    expectTouchTargets(await buttonBoxes(page, '[data-help-overlay]'));
    await page.locator('[data-help-close]').tap();
    expect(await isOpen(page)).toBe(false);

    await button.tap();
    expect(await isOpen(page)).toBe(true);
    // A tap in the dialog's own text leaves it open; one on the backdrop closes it.
    await overlay(page).locator('h2').tap();
    expect(await isOpen(page)).toBe(true);
    const box = await overlay(page).boundingBox();
    expect(box.y, 'backdrop above the dialog to tap').toBeGreaterThanOrEqual(8);
    await page.touchscreen.tap(box.x + box.width / 2, box.y / 2);
    expect(await isOpen(page)).toBe(false);
  });
});

/**
 * A dive the model could have ended at the surface, as tests/post-dive.spec.js
 * builds one: 18 m for 25 minutes, up without the safety stop. The tissues
 * stay the save's, which a few seconds at depth leave without a ceiling.
 */
function completeAtSurface(state) {
  const endS = 1530;
  const deepest = 18;
  const profile = [];
  for (let t = 0; t <= endS; t += 2) {
    const depth = t < 120 ? (deepest * t) / 120
      : t < endS - 150 ? deepest
        : Math.max(0, (deepest * (endS - t)) / 150);
    profile.push({ elapsedTimeS: t, depthM: Math.min(deepest, depth), ceilingM: 0 });
  }
  const submergedS = endS - 60;
  Object.assign(state, {
    elapsedTimeS: endS,
    depthM: 0.1,
    maxDepthM: deepest,
    verticalVelocityMpm: 0,
    completed: true,
    thirds: { startingGasL: 0, turnWarned: false, reserveHit: false },
    safetyStop: { needed: true, countdownStarted: true, remainingS: 150, paused: true, complete: false },
  });
  Object.assign(state.log, {
    entries: [{ kind: 'safety-stop-skipped', elapsedTimeS: endS, value: 0 }],
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

/** Starts a dive, turns its save into one ended at the surface, and resumes it into the debriefing. */
async function openDebriefing(page) {
  await page.goto('/dist/');
  await page.evaluate(() => window.localStorage.clear());
  await startDiveAndWaitForCanvas(page);
  await descendTo(page, 1);
  const saved = await page
    .waitForFunction((key) => {
      const raw = window.localStorage.getItem(key);
      const parsed = raw === null ? null : JSON.parse(raw);
      return parsed !== null && parsed.state.elapsedTimeS > 0 ? parsed : null;
    }, SAVE_KEY)
    .then((handle) => handle.jsonValue());
  completeAtSurface(saved.state);
  await page.goto('/dist/');
  await page.evaluate(([key, value]) => window.localStorage.setItem(key, value), [SAVE_KEY, JSON.stringify(saved)]);
  await acceptSafetyGate(page);
  await page.locator('[data-resume-continue]').click();
  await page.locator('[data-post-dive]').waitFor();
}

test.describe('over the debriefing, on a small phone', () => {
  test.use({ viewport: { width: 320, height: 568 } });

  test('it scrolls on its own and never the screen behind it (#120), and holds Enter until closed', async ({ page }) => {
    await openDebriefing(page);
    await page.evaluate(() => window.scrollTo(0, 200));
    const pageScroll = await page.evaluate(() => window.scrollY);
    expect(pageScroll, 'the debriefing scrolls when nothing is over it').toBeGreaterThan(0);

    await page.keyboard.press('h');
    await expect(overlay(page).locator('h3').first()).toHaveText('After the dive');
    const dims = await overlay(page).evaluate((dialog) => ({ scroll: dialog.scrollHeight, client: dialog.clientHeight }));
    expect(dims.scroll, 'the overlay is taller than its box').toBeGreaterThan(dims.client);

    const box = await overlay(page).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    // Wheeled again on each poll: a wheel that lands on the frame the dialog
    // is shown in can be dropped before the page has a scroll target.
    await expect.poll(async () => {
      await page.mouse.wheel(0, 300);
      return overlay(page).evaluate((dialog) => dialog.scrollTop);
    }).toBeGreaterThan(0);
    // Past its end the wheel still moves nothing behind it.
    await page.mouse.wheel(0, 5000);
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => window.scrollY), 'the debriefing behind the overlay must not move').toBe(pageScroll);
    // The sticky header keeps Close in view at the bottom.
    await expect(page.locator('[data-help-close]')).toBeInViewport();

    // Enter presses Close, focused, and does not dive again behind it.
    await page.keyboard.press('Enter');
    expect(await isOpen(page)).toBe(false);
    await expect(page.locator('[data-post-dive]')).toBeVisible();

    // The screen's own Help button, and Enter on it opens the help, not the next dive.
    const help = page.locator('[data-post-dive] [data-help-open]');
    await expect(help).toHaveText('Help');
    const helpBox = await help.boundingBox();
    expect(helpBox.height).toBeGreaterThanOrEqual(44);
    await help.focus();
    await page.keyboard.press('Enter');
    expect(await isOpen(page)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-post-dive]')).toBeVisible();
    expectTouchTargets(await buttonBoxes(page, '[data-post-dive]'));

    // Closed, Enter dives again as before.
    await page.locator('[data-post-dive] h1').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.setup-screen')).toBeVisible();
    expect(await page.locator('[data-help-overlay]').count(), 'the overlay goes with the screen').toBe(0);
  });
});

