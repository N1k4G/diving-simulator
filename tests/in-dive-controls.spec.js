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
 * A two-cylinder technical dive. Both cylinders are air — the comment here
 * used to claim the second was 50%, which the helper never configured
 * (#163 review). What it does configure is 250 bar on the second, so the two
 * are distinguishable by the gas readout without an active-cylinder display.
 * Both have gas, so both are switchable.
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

async function startThreeCylinderDive(page) {
  await page.goto('/dist/');
  await page.evaluate(() => window.localStorage.clear());
  await acceptSafetyGate(page);
  await page.locator('[data-setup-group=mode] [data-setup-option=tec]').check();
  await page.locator('[data-setup-option=tec]').evaluate((el) => el.blur());
  await page.locator('[data-setup-tank-add]').click();
  await page.locator('[data-setup-tank-add]').click();
  await page.locator('[data-start-dive]').click();
  await page.locator('[data-renderer=pixi] canvas').waitFor();
  await expect(page.locator('[data-wreck-tanks] button')).toHaveCount(3);
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

test('the switch applies before the next simulation step', async ({ page }) => {
  // Pressing immediately after the canvas appears: the first whole-second
  // step has not run yet. The switch has to be visible anyway, because it is
  // applied when pressed rather than sampled at the next step.
  await startTwoCylinderDive(page);
  await page.keyboard.press('2');

  await expect(page.locator('[data-tank="1"]')).toHaveAttribute('aria-pressed', 'true');
});

test('a second press in the same second does not swallow the first switch', async ({ page }) => {
  // #163 review. The request used to sit in a single latest-value slot until
  // the next whole-second step, so a second press inside that second
  // overwrote the first and the intermediate switch never happened at all —
  // one event where the diver made two decisions.
  //
  // Three cylinders, because the review's own example (2 then an
  // out-of-range 6) can no longer reach the slot: the controller now binds
  // only as many digits as there are cylinders, so 6 is not a dive key on a
  // two-cylinder dive. The general case it named is the one still worth
  // pinning, and it is the one that survives that gate.
  await startThreeCylinderDive(page);

  await page.keyboard.press('2');
  await page.keyboard.press('3');

  await expect(page.locator('[data-tank="2"]')).toHaveAttribute('aria-pressed', 'true');
  const saved = await persistedSave(page);
  expect(saved.state.activeTankIndex).toBe(2);

  // Both decisions are recorded, in order. The old design produced only the
  // second, because the first was overwritten before any step read it.
  const switches = saved.state.events.filter((e) => e.type === 'gas-switch');
  expect(switches.map((e) => e.tankIndex)).toEqual([1, 2]);
});

test('a digit beyond the cylinder count is not a dive key', async ({ page }) => {
  // Legacy iterates to tankCount, not to six (game-loop.js TASK-019), so on
  // a two-cylinder dive `3` names nothing and the client leaves the key
  // alone rather than claiming and discarding it.
  await startTwoCylinderDive(page);
  await page.keyboard.press('3');

  await expect(page.locator('[data-tank="0"]')).toHaveAttribute('aria-pressed', 'true');
  const saved = await persistedSave(page);
  expect(saved.state.events.filter((e) => e.type === 'gas-switch')).toHaveLength(0);
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

/**
 * Every button a diver can press during the dive, other than the cylinders.
 * Kept as one list so a control added later is covered by the overlap check
 * without anyone remembering to extend it.
 */
async function otherControlBoxes(page) {
  const boxes = [];
  for (const handle of await page
    .locator('.wreck-controls button, .controls-hint, .wreck-warning:not([hidden])')
    .all()) {
    const box = await handle.boundingBox();
    if (box && box.width > 0 && box.height > 0) boxes.push(box);
  }
  return boxes;
}

async function expectNoOverlapWithOtherControls(page) {
  const others = await otherControlBoxes(page);
  expect(others.length).toBeGreaterThan(0);

  for (const handle of await page.locator('[data-wreck-tanks] button').all()) {
    const tank = await handle.boundingBox();
    const label = await handle.getAttribute('data-tank');
    if (!tank) continue;
    for (const other of others) {
      const dx = Math.min(tank.x + tank.width, other.x + other.width) -
        Math.max(tank.x, other.x);
      const dy = Math.min(tank.y + tank.height, other.y + other.height) -
        Math.max(tank.y, other.y);
      expect(
        dx <= 0 || dy <= 0,
        `cylinder ${Number(label) + 1} overlaps another control by ${Math.round(dx)}x${Math.round(dy)}px`,
      ).toBe(true);
    }
  }
}

async function startSixCylinderDive(page) {
  await page.goto('/dist/');
  await page.evaluate(() => window.localStorage.clear());
  await acceptSafetyGate(page);
  await page.locator('[data-setup-group=mode] [data-setup-option=tec]').check();
  for (let i = 0; i < 5; i += 1) {
    await page.locator('[data-setup-tank-add]').click();
  }
  await page.locator('[data-start-dive]').click();
  await page.locator('[data-renderer=pixi] canvas').waitFor();
  await expect(page.locator('[data-wreck-tanks] button')).toHaveCount(6);
}

test('no cylinder button overlaps another control at desktop width', async ({ page }) => {
  // The narrow case is the one that broke, but the row is laid out by the
  // same rule at both widths, so both are asserted.
  await startSixCylinderDive(page);
  await expectNoOverlapWithOtherControls(page);
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

  test('no cylinder button overlaps another control', async ({ page }) => {
    // The gap check below measures the cylinder row against itself, which is
    // why it stayed green while cylinders 4-6 sat underneath the D-pad at
    // 390px — five overlapping pairs, both at z-index 4, with the D-pad
    // painting over them because it comes later in the DOM (#163 review).
    // A control you cannot press is worse than one that is slightly small.
    await startSixCylinderDive(page);
    await expectNoOverlapWithOtherControls(page);
  });

  test('every cylinder button meets the 44px touch target with 8px spacing', async ({ page }) => {
    // The #121 rule, applied to the controls this slice adds.
    await startSixCylinderDive(page);

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
    // Pairwise, not just along one row: the row wraps at this width, so
    // comparing each button with the previous one in document order would
    // measure a negative "gap" at every line break and prove nothing about
    // the buttons that sit above each other.
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i];
        const b = boxes[j];
        const gapX = Math.max(a.x - (b.x + b.width), b.x - (a.x + a.width));
        const gapY = Math.max(a.y - (b.y + b.height), b.y - (a.y + a.height));
        expect(
          Math.round(Math.max(gapX, gapY)),
          `spacing between cylinders ${i + 1} and ${j + 1}`,
        ).toBeGreaterThanOrEqual(8);
      }
    }
  });
});
