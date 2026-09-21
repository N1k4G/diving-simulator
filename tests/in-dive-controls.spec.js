const { expect, test } = require('@playwright/test');
const {
  acceptSafetyGate,
  startDiveByKeyboard,
  startDiveByTouch,
} = require('./helpers/start-dive.cjs');

// In-dive controls (#163). This first slice is the cylinder switch: keys 1-6
// and a button per cylinder, mirroring src/game-loop.js TASK-019.
//
// The save is read rather than the HUD in several places below, because the
// active cylinder has no readout of its own yet — the gas metric shows the
// active cylinder's pressure, which is a proxy, and the authoritative index
// lives in the model. That gap is the HUD half of #163.

const SAVE_KEY = 'diving-simulator.save-game';

const persistedSave = (page) =>
  page
    .waitForFunction((key) => {
      const raw = window.localStorage.getItem(key);
      return raw === null ? null : JSON.parse(raw);
    }, SAVE_KEY)
    .then((handle) => handle.jsonValue());

/**
 * A two-cylinder technical dive: air on 1, 50% on 2. Both have gas, so both
 * are switchable, and their pressures differ so the HUD readout distinguishes
 * them without needing an active-cylinder display.
 */
async function configureTwoCylinderTec(page) {
  await page.locator('[data-setup-group=mode] [data-setup-option=tec]').check();
  await page.locator('[data-setup-option=tec]').evaluate((el) => el.blur());
  await page.locator('[data-setup-tank-add]').click();
  await page.locator('[data-setup-tab="1"]').click();
  // Second cylinder to 250 bar, so the two readouts cannot be confused.
  for (let i = 0; i < 5; i += 1) await page.keyboard.press('PageUp');
  await expect(page.locator('[data-setup-value=pressure]')).toContainText('250');
}

async function startTwoCylinderDive(page) {
  await page.goto('/dist/');
  await page.evaluate(() => window.localStorage.clear());
  await acceptSafetyGate(page);
  await configureTwoCylinderTec(page);
  await page.locator('[data-start-dive]').click();
  await page.locator('[data-renderer=pixi] canvas').waitFor();
  await expect(page.locator('[data-wreck-tanks] button')).toHaveCount(2);
}

test('a cylinder can be chosen with its digit key', async ({ page }) => {
  // src/game-loop.js TASK-019 binds 1-6 during the dive.
  await startTwoCylinderDive(page);

  await expect(page.locator('[data-tank="0"]')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('2');

  await expect(page.locator('[data-tank="1"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-tank="0"]')).toHaveAttribute('aria-pressed', 'false');

  const saved = await persistedSave(page);
  expect(saved.state.activeTankIndex).toBe(1);
  // The model records the switch as an event, which is what the parity trace
  // compares. One switch, one event.
  const switches = saved.state.events.filter((e) => e.type === 'gas-switch');
  expect(switches).toHaveLength(1);
  expect(switches[0].tankIndex).toBe(1);
});

test('a cylinder can be chosen with its button, reaching the same state', async ({ page }) => {
  // The DoD asks for keyboard and pointer to produce the same authoritative
  // action, not merely a similar one.
  await startTwoCylinderDive(page);
  await page.locator('[data-tank="1"]').click();

  await expect(page.locator('[data-tank="1"]')).toHaveAttribute('aria-pressed', 'true');
  const saved = await persistedSave(page);
  expect(saved.state.activeTankIndex).toBe(1);
  expect(saved.state.events.filter((e) => e.type === 'gas-switch')).toHaveLength(1);
});

test('the switch survives being pressed between simulation steps', async ({ page }) => {
  // The model moves in whole seconds and ignores an advance of zero, so the
  // request is queued rather than applied. Queued must mean kept: a press
  // that lands between two steps has to take effect on the next one, not be
  // dropped. Pressing immediately after the canvas appears is exactly that
  // case — the first step has not run yet.
  await startTwoCylinderDive(page);
  await page.keyboard.press('2');

  await expect(page.locator('[data-tank="1"]')).toHaveAttribute('aria-pressed', 'true');
});

test('an empty cylinder is offered but cannot be breathed', async ({ page }) => {
  // The model refuses a switch to a cylinder with no gas
  // (applyGasSwitchIntent), matching legacy's `tanks[i].gasRemaining > 0`.
  // The button stays visible and says why through its disabled state rather
  // than vanishing, so the cylinder does not silently disappear mid-dive.
  await page.goto('/dist/');
  await page.evaluate(() => window.localStorage.clear());
  await acceptSafetyGate(page);
  await page.locator('[data-setup-group=mode] [data-setup-option=tec]').check();
  await page.locator('[data-setup-option=tec]').evaluate((el) => el.blur());
  await page.locator('[data-setup-tank-add]').click();
  await page.locator('[data-start-dive]').click();
  await page.locator('[data-renderer=pixi] canvas').waitFor();

  // Empty the second cylinder in the saved dive, then resume it.
  const saved = await persistedSave(page);
  saved.state.tanks[1].gasRemainingL = 0;
  await page.goto('/dist/');
  await page.evaluate(
    ([key, value]) => window.localStorage.setItem(key, value),
    [SAVE_KEY, JSON.stringify(saved)],
  );
  await acceptSafetyGate(page);
  await page.locator('[data-start-dive]').click();
  await page.locator('[data-renderer=pixi] canvas').waitFor();

  await expect(page.locator('[data-tank="1"]')).toBeDisabled();
  await page.keyboard.press('2');
  await expect(page.locator('[data-tank="0"]')).toHaveAttribute('aria-pressed', 'true');
});

test('a single-cylinder dive shows no cylinder row', async ({ page }) => {
  // Nothing to switch between. Legacy shows the slots only where the mode
  // has more than one cylinder.
  await page.goto('/dist/');
  await page.evaluate(() => window.localStorage.clear());
  await startDiveByKeyboard(page);
  await page.locator('[data-renderer=pixi] canvas').waitFor();

  await expect(page.locator('[data-wreck-tanks]')).toBeHidden();
});

test('a closed-circuit dive shows no cylinder row', async ({ page }) => {
  // CCR breathes a loop, and applyGasSwitchIntent refuses a gas switch
  // outright while ccr is set. Offering the control would be offering
  // something the model will not do.
  await page.goto('/dist/');
  await page.evaluate(() => window.localStorage.clear());
  await acceptSafetyGate(page);
  await page.locator('[data-setup-group=mode] [data-setup-option=ccr]').check();
  await expect(page.locator('[data-setup-stepper=setpoint]')).toBeVisible();
  await page.locator('[data-start-dive]').click();
  await page.locator('[data-renderer=pixi] canvas').waitFor();

  await expect(page.locator('[data-wreck-tanks]')).toBeHidden();
});

test.describe('mobile viewport', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('a cylinder can be chosen by touch alone', async ({ page }) => {
    await page.goto('/dist/');
    await page.evaluate(() => window.localStorage.clear());
    await startDiveByTouch(page, async (target) => {
      await target.locator('[data-setup-group=mode] [data-setup-option=tec]').tap();
      await target.locator('[data-setup-tank-add]').tap();
    });
    await page.locator('[data-renderer=pixi] canvas').waitFor();

    await page.locator('[data-tank="1"]').tap();

    await expect(page.locator('[data-tank="1"]')).toHaveAttribute('aria-pressed', 'true');
    const saved = await persistedSave(page);
    expect(saved.state.activeTankIndex).toBe(1);
  });

  test('every cylinder button meets the 44px touch target with 8px spacing', async ({ page }) => {
    // The #121 rule, applied to the controls this slice adds.
    await page.goto('/dist/');
    await page.evaluate(() => window.localStorage.clear());
    await startDiveByTouch(page, async (target) => {
      await target.locator('[data-setup-group=mode] [data-setup-option=tec]').tap();
      for (let i = 0; i < 5; i += 1) {
        await target.locator('[data-setup-tank-add]').tap();
      }
    });
    await page.locator('[data-renderer=pixi] canvas').waitFor();
    await expect(page.locator('[data-wreck-tanks] button')).toHaveCount(6);

    const boxes = [];
    for (const handle of await page.locator('[data-wreck-tanks] button').all()) {
      const box = await handle.boundingBox();
      if (box) boxes.push(box);
    }
    expect(boxes).toHaveLength(6);

    for (const box of boxes) {
      expect(Math.round(box.width), 'button width').toBeGreaterThanOrEqual(44);
      expect(Math.round(box.height), 'button height').toBeGreaterThanOrEqual(44);
    }
    for (let i = 1; i < boxes.length; i += 1) {
      const gap = boxes[i].x - (boxes[i - 1].x + boxes[i - 1].width);
      expect(Math.round(gap), `gap before button ${i + 1}`).toBeGreaterThanOrEqual(8);
    }
  });
});
