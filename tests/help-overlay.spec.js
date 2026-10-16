const { expect, test } = require('./helpers/pinned-seed.cjs');
const {
  acceptSafetyGate,
  descendTo,
  startDiveAndWaitForCanvas,
} = require('./helpers/start-dive.cjs');

// The help overlay (#160): legacy's H / ? overlay as a modal dialog. H, ? and
// Escape close it, as do Close and a tap outside it; under water the dive
// stands still while it is open; over the debriefing it scrolls on its own,
// the case #120 fixed in legacy.

const SAVE_KEY = 'diving-simulator.save-game';
const overlay = (page) => page.locator('[data-help-overlay]');
const isOpen = (page) => overlay(page).evaluate((dialog) => dialog.open);
const hudValue = (page, name) => page.locator(`.wreck-hud [data-hud-metric="${name}"] dd`);

/** The #121 test of tests/result-screen.spec.js: each visible button 44 px, 8 px from its neighbours. */
async function expectTouchTargets(page, selector) {
  const boxes = await page.locator(`${selector} button`).evaluateAll((buttons) => buttons
    .filter((el) => el.getClientRects().length > 0)
    .map((el) => {
      const r = el.getBoundingClientRect();
      return { label: el.getAttribute('aria-label') || el.textContent, x: r.x, y: r.y, w: r.width, h: r.height };
    }));
  const problems = [];
  for (const [i, a] of boxes.entries()) {
    if (a.w < 44 || a.h < 44) problems.push(`${a.label} is ${Math.round(a.w)}x${Math.round(a.h)}`);
    if (a.x < 0 || a.x + a.w > page.viewportSize().width) problems.push(`${a.label} is off screen`);
    for (const b of boxes.slice(i + 1)) {
      const gapX = Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w);
      const gapY = Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h);
      if (Math.max(gapX, gapY) < 8) problems.push(`${a.label} <-> ${b.label}`);
    }
  }
  expect(problems, problems.join('\n')).toEqual([]);
  return boxes.length;
}

test('under water H opens it and stops the dive; Escape, ?, H and Enter on Close work it', async ({ page }) => {
  await page.goto('/dist/');
  await startDiveAndWaitForCanvas(page);
  await descendTo(page, 2);

  await page.keyboard.press('h');
  // A dialog named by its heading, focus inside, no live region (#138).
  await expect(page.getByRole('dialog', { name: 'Controls' })).toBeVisible();
  await expect(page.locator('[data-help-close]')).toBeFocused();
  expect(await overlay(page).locator('[aria-live], [role=alert], [role=status]').count()).toBe(0);
  await expect(overlay(page).locator('.help-paused')).toHaveText('The dive is paused while this help is open.');

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
  await page.keyboard.press('H');
  await page.keyboard.press('Enter');
  expect(await isOpen(page)).toBe(false);
});

test('at the surface it leads with S, S pressed behind it does not begin the dive, and a key let go behind it is let go', async ({ page }) => {
  await page.goto('/dist/');
  await startDiveAndWaitForCanvas(page);
  // W held as it opens and let go behind it: legacy's keyup clears the key.
  // The first frame first, so the controller is listening.
  await expect(hudValue(page, 'depth')).toHaveText('0 m');
  await page.keyboard.down('w');
  await page.locator('[data-help-open]').click();
  await page.keyboard.up('w');
  await expect(overlay(page).locator('h3').first()).toHaveText('At the surface');
  await expect(overlay(page).locator('.help-paused')).toHaveCount(0);
  await page.keyboard.press('s');
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-surface-prompt]')).toBeVisible();
  await expect(page.locator('[data-help-open]')).toBeFocused();
  // A stuck W goes on inflating once S is let go: 6 s after 4 s of S the
  // diver is back at 0.6 m, where without it the dive is at 7.9 m.
  await page.keyboard.down('s');
  await page.waitForTimeout(4000);
  await page.keyboard.up('s');
  await page.waitForTimeout(6000);
  expect(Number.parseFloat(await hudValue(page, 'depth').textContent())).toBeGreaterThan(3);
});

// With fast-forward's chip as well, the buttons still run off narrow phones: #259.
for (const locale of ['en-GB', 'de-DE']) {
  test.describe(`in ${locale}, the topbar`, () => {
    test.use({ locale });

    test('fits from 320 to 430 px in every mode', async ({ page }) => {
      test.setTimeout(120_000);
      for (const [mode, buttons] of [['rec', 2], ['tec', 3], ['ccr', 3]]) {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto('/dist/');
        await page.evaluate(() => window.localStorage.clear());
        await page.locator('[data-accept-safety]').click();
        await page.locator(`[data-setup-group=mode] [data-setup-option=${mode}]`).check();
        await page.locator('[data-start-dive]').click();
        await page.locator('[data-renderer=pixi] canvas').waitFor();
        // Under water, where tec and CCR show I.
        await descendTo(page, 1);
        for (const width of [320, 340, 360, 375, 390, 393, 402, 412, 430]) {
          await page.setViewportSize({ width, height: 844 });
          // The chip, I where the mode has it, Help and mute: on screen, 44 px, 8 px apart.
          expect(await expectTouchTargets(page, '.topbar-actions'), `${mode} at ${width}`).toBe(buttons);
          const actions = await page.locator('.topbar-actions').boundingBox();
          expect(actions.x + actions.width, `${mode} at ${width}`).toBeLessThanOrEqual(width);
        }
      }
    });
  });
}

test.describe('in German, by touch, on the smallest phone', () => {
  test.use({ locale: 'de-DE', viewport: { width: 320, height: 568 }, hasTouch: true });

  test('Hilfe opens it beside I and mute; Close and a tap outside close it; every target 44 px', async ({ page }) => {
    await page.goto('/dist/');
    await page.locator('[data-accept-safety]').tap();
    await page.locator('[data-setup-group=mode] [data-setup-option=ccr]').tap();
    await page.locator('[data-start-dive]').tap();
    // I is offered under water, past 0.5 m.
    await page.locator('[data-renderer=pixi] canvas').waitFor();
    await descendTo(page, 1);
    await page.getByRole('button', { name: 'Hilfe' }).tap();
    await expect(page.getByRole('dialog', { name: 'Steuerung' })).toBeVisible();
    await expect(overlay(page)).toContainText('H, ? oder ESC zum Schließen');
    await expect(overlay(page).locator('.help-safety')).toContainText('BCD nahe der Oberfläche NICHT überfüllen');
    // A rebreather's rows: the setpoint and the bailout, no cylinder keys.
    await expect(overlay(page).locator('[data-help-row="wreck.controls.bailout"]')).toContainText('nicht rückgängig');
    await expect(overlay(page).locator('[data-help-row="help.action.cylinder"]')).toHaveCount(0);
    await expectTouchTargets(page, '[data-help-overlay]');
    await page.locator('[data-help-close]').tap();
    expect(await isOpen(page)).toBe(false);

    await page.locator('[data-help-open]').tap();
    await overlay(page).locator('h2').tap();
    expect(await isOpen(page)).toBe(true);
    const box = await overlay(page).boundingBox();
    expect(box.y, 'backdrop above the dialog to tap').toBeGreaterThanOrEqual(8);
    await page.touchscreen.tap(box.x + box.width / 2, box.y / 2);
    expect(await isOpen(page)).toBe(false);
  });
});

/** A dive ended at the surface, as tests/post-dive.spec.js builds one: 18 m, up without the safety stop. */
function completeAtSurface(state) {
  const endS = 1530;
  const profile = [];
  for (let t = 0; t <= endS; t += 2) {
    const depthM = Math.min(18, t < 120 ? (18 * t) / 120 : t < endS - 150 ? 18 : Math.max(0, (18 * (endS - t)) / 150));
    profile.push({ elapsedTimeS: t, depthM, ceilingM: 0 });
  }
  Object.assign(state, {
    elapsedTimeS: endS, depthM: 0.1, maxDepthM: 18, verticalVelocityMpm: 0, completed: true,
    thirds: { startingGasL: 0, turnWarned: false, reserveHit: false },
    safetyStop: { needed: true, countdownStarted: true, remainingS: 150, paused: true, complete: false },
  });
  Object.assign(state.log, {
    entries: [{ kind: 'safety-stop-skipped', elapsedTimeS: endS, value: 0 }],
    ascentRateMpm: 0, fastAscentS: 0, fastAscentPeakMpm: 0, fastAscentLatched: false,
    ceilingViolationS: 0, ceilingViolationLatched: false,
    depthTimeMS: 16 * (endS - 60), submergedS: endS - 60, profile, profileTimerS: 0, lastCeilingM: 0,
  });
}

test.describe('over the debriefing, on a small phone', () => {
  test.use({ viewport: { width: 320, height: 568 } });

  test('it scrolls on its own and never the screen behind it (#120), and holds Enter until closed', async ({ page }) => {
    await page.goto('/dist/');
    await startDiveAndWaitForCanvas(page);
    await descendTo(page, 1);
    const saved = await page.waitForFunction((key) => {
      const parsed = JSON.parse(window.localStorage.getItem(key) ?? 'null');
      return parsed !== null && parsed.state.elapsedTimeS > 0 ? parsed : null;
    }, SAVE_KEY).then((handle) => handle.jsonValue());
    completeAtSurface(saved.state);
    await page.goto('/dist/');
    await page.evaluate(([key, value]) => window.localStorage.setItem(key, value), [SAVE_KEY, JSON.stringify(saved)]);
    await acceptSafetyGate(page);
    await page.locator('[data-resume-continue]').click();
    await page.locator('[data-post-dive]').waitFor();

    await page.evaluate(() => window.scrollTo(0, 200));
    const pageScroll = await page.evaluate(() => window.scrollY);
    expect(pageScroll, 'the debriefing scrolls when nothing is over it').toBeGreaterThan(0);

    await page.keyboard.press('h');
    await expect(overlay(page).locator('h3').first()).toHaveText('After the dive');
    // With focus on Close, Space pages the dialog down and Shift+Space back
    // up, and neither presses Close; Page Down scrolls it too.
    const scrollTop = () => overlay(page).evaluate((dialog) => dialog.scrollTop);
    await expect(page.locator('[data-help-close]')).toBeFocused();
    await page.keyboard.press('Space');
    await expect.poll(scrollTop).toBeGreaterThan(100);
    expect(await isOpen(page)).toBe(true);
    await page.keyboard.press('Shift+Space');
    await expect.poll(scrollTop).toBe(0);
    await page.keyboard.press('PageDown');
    await expect.poll(scrollTop).toBeGreaterThan(0);
    expect(await isOpen(page)).toBe(true);
    await overlay(page).evaluate((dialog) => { dialog.scrollTop = 0; });
    const box = await overlay(page).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    // Wheeled on each poll: a wheel on the frame the dialog is shown in can be dropped.
    await expect.poll(async () => {
      await page.mouse.wheel(0, 300);
      return overlay(page).evaluate((dialog) => dialog.scrollTop);
    }).toBeGreaterThan(0);
    await page.mouse.wheel(0, 5000);
    // Nor over the backdrop beside it.
    await page.mouse.move(4, box.y + box.height / 2);
    await page.mouse.wheel(0, 3000);
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => window.scrollY), 'the debriefing behind it must not move').toBe(pageScroll);
    await expect(page.locator('[data-help-close]')).toBeInViewport();

    // Enter presses the focused Close and does not dive again behind it.
    await page.keyboard.press('Enter');
    expect(await isOpen(page)).toBe(false);
    await expect(page.locator('[data-post-dive]')).toBeVisible();

    // The screen's Help button: Enter on it opens the help, not the next dive.
    await page.locator('[data-post-dive] [data-help-open]').focus();
    await page.keyboard.press('Enter');
    expect(await isOpen(page)).toBe(true);
    await page.keyboard.press('Escape');
    await expectTouchTargets(page, '[data-post-dive]');

    await page.locator('[data-post-dive] h1').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.setup-screen')).toBeVisible();
    await expect(overlay(page), 'the overlay goes with the screen').toHaveCount(0);
  });
});
