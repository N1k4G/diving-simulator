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

test('a failed dive offers no cylinder controls at all', async ({ page }) => {
  // DiveModel.switchGas refuses a switch once failure.reason is set, so
  // leaving the buttons enabled offered an action that could not happen, and
  // the digit keys were still claimed with preventDefault (#163 review).
  // Legacy takes its touch UI away outside `gameState === 'diving'`.
  await startTwoCylinderDive(page);
  const saved = await persistedSave(page);

  // A failed state the codec will accept: isEventHistory wants exactly one
  // failure event, last in the list, with the same reason as failure.reason.
  saved.state.failure.reason = 'out-of-gas';
  saved.state.events.push({
    type: 'failure',
    elapsedTimeS: saved.state.elapsedTimeS,
    failureReason: 'out-of-gas',
  });

  await page.goto('/dist/');
  await page.evaluate(
    ([key, value]) => window.localStorage.setItem(key, value),
    [SAVE_KEY, JSON.stringify(saved)],
  );
  await acceptSafetyGate(page);
  await page.locator('[data-start-dive]').click();
  await page.locator('[data-renderer=pixi] canvas').waitFor();

  await expect(page.locator('[data-wreck-tanks]')).toBeHidden();

  // And the key is released rather than swallowed. Asserting the model is
  // unchanged would prove nothing here — switchGas refuses on a failed dive
  // either way, so that assertion passes whether or not the key was claimed.
  // What distinguishes the two is preventDefault(), so that is what is read:
  // this listener is registered after the controller's, so it sees the flag
  // the controller would have set.
  await page.evaluate(() => {
    window.__tankKeyClaimed = null;
    window.addEventListener('keydown', (event) => {
      if (event.key === '2') window.__tankKeyClaimed = event.defaultPrevented;
    });
  });
  await page.keyboard.press('2');

  expect(await page.evaluate(() => window.__tankKeyClaimed)).toBe(false);
  const after = await persistedSave(page);
  expect(after.state.activeTankIndex).toBe(saved.state.activeTankIndex);
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

async function expectNoOverlapWithOtherControls(
  page,
  selector = '[data-wreck-tanks] button',
) {
  const others = await otherControlBoxes(page);
  expect(others.length).toBeGreaterThan(0);

  for (const handle of await page.locator(selector).all()) {
    const tank = await handle.boundingBox();
    const label =
      (await handle.getAttribute('data-tank')) ?? (await handle.getAttribute('aria-label'));
    if (!tank) continue;
    for (const other of others) {
      const dx = Math.min(tank.x + tank.width, other.x + other.width) -
        Math.max(tank.x, other.x);
      const dy = Math.min(tank.y + tank.height, other.y + other.height) -
        Math.max(tank.y, other.y);
      expect(
        dx <= 0 || dy <= 0,
        `control ${label} overlaps another control by ${Math.round(dx)}x${Math.round(dy)}px`,
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

// The active-cylinder readout (#163, HUD half). Until this row existed the
// tests above had to read the save to learn which cylinder was breathed.
test.describe('cylinder readout', () => {
  test('the HUD names the cylinder being breathed and follows a switch', async ({ page }) => {
    await startTwoCylinderDive(page);
    const cylinder = page.locator('.wreck-hud [data-hud-metric="cylinder"] dd');

    await expect(cylinder).toContainText('1 ·');
    await page.keyboard.press('2');
    await expect(cylinder).toContainText('2 ·');
    // The oxygen fraction is part of the row, so a switch between two
    // different mixes reads as a change of gas and not only of number.
    await expect(cylinder).toContainText('21%');
  });

  test('a closed-circuit dive shows the loop, not a cylinder', async ({ page }) => {
    // tanks[0] exists on a CCR dive only because the codec requires one; it
    // is not being breathed and must not be named as if it were.
    await page.goto('/dist/');
    await page.evaluate(() => window.localStorage.clear());
    await acceptSafetyGate(page);
    await page.locator('[data-setup-group=mode] [data-setup-option=ccr]').check();
    await expect(page.locator('[data-setup-stepper=setpoint]')).toBeVisible();
    await page.locator('[data-start-dive]').click();
    await page.locator('[data-renderer=pixi] canvas').waitFor();

    await expect(page.locator('.wreck-hud [data-hud-metric="cylinder"] dd')).toHaveText(
      'Rebreather loop',
    );
  });

  test('a bailed-out closed-circuit dive names the diluent cylinder', async ({ page }) => {
    // After a bailout the model breathes the diluent open-circuit
    // (breathingSourceForState), and a save can resume in that state. The
    // row used to say "Rebreather loop" for any CCR dive (#163 review
    // round 1); the loop is exactly what a bailed-out diver is not on.
    await page.goto('/dist/');
    await page.evaluate(() => window.localStorage.clear());
    await acceptSafetyGate(page);
    await page.locator('[data-setup-group=mode] [data-setup-option=ccr]').check();
    await expect(page.locator('[data-setup-stepper=setpoint]')).toBeVisible();
    await page.locator('[data-start-dive]').click();
    await page.locator('[data-renderer=pixi] canvas').waitFor();

    const saved = await persistedSave(page);
    saved.state.ccr.onBailout = true;
    saved.state.events.push({ type: 'bailout', elapsedTimeS: saved.state.elapsedTimeS });

    await page.goto('/dist/');
    await page.evaluate(
      ([key, value]) => window.localStorage.setItem(key, value),
      [SAVE_KEY, JSON.stringify(saved)],
    );
    await acceptSafetyGate(page);
    await page.locator('[data-start-dive]').click();
    await page.locator('[data-renderer=pixi] canvas').waitFor();

    await expect(page.locator('.wreck-hud [data-hud-metric="cylinder"] dd')).toHaveText(
      'Bailout · diluent cylinder',
    );
  });
});

// The torch has had a key and a button since the wreck slice; what #163's
// definition of done adds is that the two must reach the same state, which
// nothing asserted for the keyboard path.
test('the torch key and the torch button reach the same state', async ({ page }) => {
  await page.goto('/dist/');
  await page.evaluate(() => window.localStorage.clear());
  await startDiveByKeyboard(page);
  await page.locator('[data-renderer=pixi] canvas').waitFor();
  const torch = page.locator('[data-torch]');
  await expect(torch).toHaveAttribute('aria-pressed', 'true');

  await page.keyboard.press('t');
  await expect(torch).toHaveAttribute('aria-pressed', 'false');

  await torch.click();
  await expect(torch).toHaveAttribute('aria-pressed', 'true');
});

/**
 * A dive resumed while holding an 18 m decompression stop.
 *
 * Every compartment is loaded to 3.0 bar of nitrogen, which under the default
 * gradient factors puts the ceiling at 17.5 m; decoStop() rounds that up to
 * 18 m, the shallowest depth the wreck route allows, and the diver is parked
 * there. tests/unit/game-controller-fast-forward.test.ts asserts that the same
 * loading forecasts an 18 m stop, so this fixture and the unit test cannot
 * drift apart silently.
 *
 * Built by starting a real dive and editing its save, as the empty-cylinder
 * test does, so the payload has whatever shape the codec currently requires.
 */
async function startDiveAtDecoStop(page, configure) {
  await page.goto('/dist/');
  await page.evaluate(() => window.localStorage.clear());
  await acceptSafetyGate(page);
  if (configure) await configure(page);
  await page.locator('[data-start-dive]').click();
  await page.locator('[data-renderer=pixi] canvas').waitFor();

  const saved = await persistedSave(page);
  saved.state.depthM = 18;
  saved.state.maxDepthM = 34;
  saved.state.tissues.nitrogenBar = saved.state.tissues.nitrogenBar.map(() => 3);

  await page.goto('/dist/');
  await page.evaluate(
    ([key, value]) => window.localStorage.setItem(key, value),
    [SAVE_KEY, JSON.stringify(saved)],
  );
  await acceptSafetyGate(page);
  await page.locator('[data-start-dive]').click();
  await page.locator('[data-renderer=pixi] canvas').waitFor();
  // Offered from the first frame: the ceiling is computed from the model's
  // own tissues, not awaited from the forecast worker.
  await expect(page.locator('[data-fast-forward]')).toBeVisible();
}

const fastForwardButton = (page) => page.locator('[data-fast-forward]');
const fastForwardIndicator = (page) => page.locator('[data-fast-forward-indicator]');

// Fast-forward (#163): F and a button, offered only while a stop is held,
// mirroring src/game-loop.js updateDiving() and src/touch.js touchUpdateUI().
test.describe('fast-forward', () => {
  test('is not offered on a dive with no stop to wait out', async ({ page }) => {
    // A fresh dive at 26 m on air has no ceiling, so legacy's canFastForward
    // is false: the button is not shown and F is left to whoever else wants
    // it rather than claimed and discarded (the #163 review's rule for the
    // digit keys, applied here too).
    await page.goto('/dist/');
    await page.evaluate(() => window.localStorage.clear());
    await startDiveByKeyboard(page);
    await page.locator('[data-renderer=pixi] canvas').waitFor();

    await expect(fastForwardButton(page)).toBeHidden();
    await expect(fastForwardIndicator(page)).toBeHidden();

    await page.evaluate(() => {
      window.__fastForwardKeyClaimed = null;
      window.addEventListener('keydown', (event) => {
        if (event.key === 'f') window.__fastForwardKeyClaimed = event.defaultPrevented;
      });
    });
    await page.keyboard.press('f');
    expect(await page.evaluate(() => window.__fastForwardKeyClaimed)).toBe(false);
    await expect(fastForwardIndicator(page)).toBeHidden();
  });

  test('F runs the dive clock ten times faster while the stop is held', async ({ page }) => {
    await startDiveAtDecoStop(page);
    await expect(fastForwardButton(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(fastForwardIndicator(page)).toBeHidden();

    const before = await persistedSave(page);
    await page.keyboard.press('f');

    await expect(fastForwardButton(page)).toHaveAttribute('aria-pressed', 'true');
    // Said in words, not only through the button's state: the diver has to
    // be told the clock is running fast (docs/decisions.md, colour alone).
    await expect(fastForwardIndicator(page)).toBeVisible();
    await expect(fastForwardIndicator(page)).toHaveText('Fast-forward ×10');

    // Twenty dive seconds would take twenty real seconds at normal speed
    // and two at ten times. Six seconds of wall clock is the margin for a
    // loaded test machine, and still a third of what normal speed needs —
    // so a clock that did not actually speed up fails here.
    await page.waitForFunction(
      ([key, startS]) => {
        const raw = window.localStorage.getItem(key);
        return raw !== null && JSON.parse(raw).state.elapsedTimeS >= startS + 20;
      },
      [SAVE_KEY, before.state.elapsedTimeS],
      { timeout: 6_000 },
    );

    // And off again on the next press.
    await page.keyboard.press('f');
    await expect(fastForwardButton(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(fastForwardIndicator(page)).toBeHidden();
  });

  test('the button reaches the same state as the key', async ({ page }) => {
    await startDiveAtDecoStop(page);

    await fastForwardButton(page).click();
    await expect(fastForwardButton(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(fastForwardIndicator(page)).toBeVisible();

    // Mixed: on by button, off by key. One control, two ways in.
    await page.keyboard.press('f');
    await expect(fastForwardButton(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(fastForwardIndicator(page)).toBeHidden();
  });

  test('holding a vertical key ends it, and releasing does not resume it', async ({ page }) => {
    // src/game-loop.js: `canFastForward && !keys['w'] && !keys['arrowup']
    // && !keys['s'] && !keys['arrowdown']`, else fastForwardActive = false.
    await startDiveAtDecoStop(page);
    await page.keyboard.press('f');
    await expect(fastForwardIndicator(page)).toBeVisible();

    await page.keyboard.down('ArrowUp');
    // Not on offer while the key is held, and off.
    await expect(fastForwardButton(page)).toBeHidden();
    await expect(fastForwardIndicator(page)).toBeHidden();

    await page.keyboard.up('ArrowUp');
    // The route floor is 18 m, so the diver is still at the stop and the
    // control returns — unpressed. Legacy cleared the flag; only a new press
    // sets it again.
    await expect(fastForwardButton(page)).toBeVisible();
    await expect(fastForwardButton(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(fastForwardIndicator(page)).toBeHidden();
  });

  test('a cylinder switch ends it', async ({ page }) => {
    // src/game-loop.js TASK-019 clears fastForwardActive with the switch.
    await startDiveAtDecoStop(page, configureTwoCylinderTec);
    await expect(page.locator('[data-wreck-tanks] button')).toHaveCount(2);
    await page.keyboard.press('f');
    await expect(fastForwardIndicator(page)).toBeVisible();

    await page.keyboard.press('2');

    await expect(page.locator('[data-tank="1"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(fastForwardIndicator(page)).toBeHidden();
    await expect(fastForwardButton(page)).toHaveAttribute('aria-pressed', 'false');
    // Still at the stop, so still on offer for a new decision.
    await expect(fastForwardButton(page)).toBeVisible();
  });

  test.describe('mobile viewport', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

    test('can be toggled by touch and meets the 44px target', async ({ page }) => {
      await startDiveAtDecoStop(page);

      const box = await fastForwardButton(page).boundingBox();
      expect(box).not.toBeNull();
      expect(Math.round(box.width), 'button width').toBeGreaterThanOrEqual(44);
      expect(Math.round(box.height), 'button height').toBeGreaterThanOrEqual(44);

      await fastForwardButton(page).tap();
      await expect(fastForwardButton(page)).toHaveAttribute('aria-pressed', 'true');
      await expect(fastForwardIndicator(page)).toBeVisible();
    });
  });
});

// The rebreather controls (#163): [ and ] move the setpoint, B bails out,
// mirroring src/game-loop.js updateDiving and src/touch.js
// updateCcrDiveButtonVisibility; and the loop's HUD rows and warnings, from
// the CCR gas box and warning banner in src/renderer.js.

async function startCcrDive(page) {
  await page.goto('/dist/');
  await page.evaluate(() => window.localStorage.clear());
  await acceptSafetyGate(page);
  await page.locator('[data-setup-group=mode] [data-setup-option=ccr]').check();
  await expect(page.locator('[data-setup-stepper=setpoint]')).toBeVisible();
  await page.locator('[data-start-dive]').click();
  await page.locator('[data-renderer=pixi] canvas').waitFor();
  await expect(page.locator('[data-wreck-ccr]')).toBeVisible();
}

/** Starts a CCR dive, edits its save with `mutate`, and resumes it. */
async function resumeCcrDiveWith(page, mutate) {
  await startCcrDive(page);
  const saved = await persistedSave(page);
  mutate(saved.state);
  await page.goto('/dist/');
  await page.evaluate(
    ([key, value]) => window.localStorage.setItem(key, value),
    [SAVE_KEY, JSON.stringify(saved)],
  );
  await acceptSafetyGate(page);
  await page.locator('[data-start-dive]').click();
  await page.locator('[data-renderer=pixi] canvas').waitFor();
}

/**
 * The save once it satisfies `predicate`, or the latest one after
 * `timeoutMs` so the caller's own expect reports the mismatch.
 *
 * persistedSave() waits only for a save to exist. The app writes one every
 * five simulated seconds, so a read right after a second key press can
 * return the save made before it — a real ordering in the app, not a bug in
 * it, and one the HUD assertion just before does not cover because the HUD
 * is fed by the frame, not the save.
 */
async function savedStateWhere(page, predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const saved = await persistedSave(page);
    if (predicate(saved.state) || Date.now() > deadline) return saved;
    await page.waitForTimeout(250);
  }
}

/**
 * The HUD panel and every visible HUD row against every visible control and
 * the hint. The panel itself is included, not only its rows: at 844x390 the
 * rows stopped short of the dock while the panel's padding and background ran
 * 9px into it, and a control drawn over the panel's edge is still a control
 * drawn over the HUD.
 */
async function expectHudClearOfControls(page) {
  const boxesOf = (selector) =>
    page.evaluate((sel) => {
      return [...document.querySelectorAll(sel)]
        .filter((el) => el.getClientRects().length > 0)
        .map((el) => {
          const r = el.getBoundingClientRect();
          return {
            label: el.dataset.hudMetric || el.getAttribute('aria-label') || el.className,
            x: r.x,
            y: r.y,
            width: r.width,
            height: r.height,
          };
        });
    }, selector);
  // The gas-information panel counts as HUD too when it is open (#163): it
  // shares the HUD's column and must stop above the controls just the same.
  const rows = await boxesOf('.wreck-hud, .wreck-hud > div, .gas-info');
  const controls = await boxesOf(
    '.wreck-controls button, .wreck-dock button, .controls-hint',
  );
  expect(rows.length).toBeGreaterThan(0);
  expect(controls.length).toBeGreaterThan(0);
  for (const row of rows) {
    for (const control of controls) {
      const dx = Math.min(row.x + row.width, control.x + control.width) - Math.max(row.x, control.x);
      const dy = Math.min(row.y + row.height, control.y + control.height) - Math.max(row.y, control.y);
      expect(
        dx <= 0 || dy <= 0,
        `HUD row ${row.label} meets ${control.label} by ${Math.round(dx)}x${Math.round(dy)}px`,
      ).toBe(true);
    }
  }
}

const hudRow = (page, name) => page.locator(`.wreck-hud [data-hud-metric="${name}"]`);
const hudValue = (page, name) => hudRow(page, name).locator('dd');
const LOOP_ROWS = ['setpoint', 'loopPo2', 'oxygenCylinder', 'diluentCylinder', 'scrubber'];

/** Whether the controller claimed `key` on the next press, read via defaultPrevented. */
async function pressAndReadClaim(page, key) {
  await page.evaluate((k) => {
    window.__keyClaimed = null;
    window.addEventListener(
      'keydown',
      (event) => {
        if (event.key === k) window.__keyClaimed = event.defaultPrevented;
      },
      { once: true },
    );
  }, key);
  await page.keyboard.press(key);
  return page.evaluate(() => window.__keyClaimed);
}

test.describe('rebreather controls', () => {
  test('the loop rows replace the gas row on a closed-circuit dive', async ({ page }) => {
    // src/renderer.js draws SP, PO2, O2, DIL and SCR where the open-circuit
    // gas box would be. The gas row here would otherwise show tanks[0], the
    // codec's placeholder cylinder, at a pressure nobody draws down.
    await startCcrDive(page);

    for (const name of LOOP_ROWS) {
      await expect(hudRow(page, name), `${name} row`).toBeVisible();
    }
    await expect(hudRow(page, 'gas')).toBeHidden();
    await expect(hudValue(page, 'setpoint')).toHaveText('0.70 bar');
    await expect(hudValue(page, 'loopPo2')).not.toHaveText('—');
    await expect(hudValue(page, 'oxygenCylinder')).toHaveText('200 bar');
    await expect(hudValue(page, 'diluentCylinder')).toHaveText('200 bar');
    await expect(hudValue(page, 'scrubber')).not.toHaveText('—');
  });

  test('open circuit shows neither the rows nor the controls, and leaves the keys alone', async ({ page }) => {
    await page.goto('/dist/');
    await page.evaluate(() => window.localStorage.clear());
    await startDiveByKeyboard(page);
    await page.locator('[data-renderer=pixi] canvas').waitFor();

    for (const name of LOOP_ROWS) {
      await expect(hudRow(page, name), `${name} row`).toBeHidden();
    }
    await expect(hudRow(page, 'gas')).toBeVisible();
    await expect(page.locator('[data-wreck-ccr]')).toBeHidden();

    // Legacy gates the keys on `diveMode === 'ccr'`; here they are left to
    // whoever else wants them rather than claimed and discarded.
    expect(await pressAndReadClaim(page, ']')).toBe(false);
    expect(await pressAndReadClaim(page, 'b')).toBe(false);
    const saved = await persistedSave(page);
    expect(saved.state.ccr).toBeNull();
  });

  test('] raises the setpoint by a tenth and [ lowers it', async ({ page }) => {
    await startCcrDive(page);

    await page.keyboard.press(']');
    await expect(hudValue(page, 'setpoint')).toHaveText('0.80 bar');
    let saved = await savedStateWhere(page, (s) => s.ccr.targetPo2Bar === 0.8);
    expect(saved.state.ccr.targetPo2Bar).toBe(0.8);

    await page.keyboard.press('[');
    await expect(hudValue(page, 'setpoint')).toHaveText('0.70 bar');
    saved = await savedStateWhere(page, (s) => s.ccr.targetPo2Bar === 0.7);
    expect(saved.state.ccr.targetPo2Bar).toBe(0.7);
  });

  test('holding ] keeps raising the setpoint, as legacy does', async ({ page }) => {
    // Legacy's keydown listener sets keys[']'] on every event, autorepeat
    // included, and updateDiving consumes one step per set (#163 review
    // round 3 on PR #182). Playwright marks every keyboard.down() after the
    // first as a repeat until the key is released, which is what a held key
    // sends.
    await startCcrDive(page);

    await page.keyboard.down(']');
    await page.keyboard.down(']');
    await page.keyboard.down(']');
    await page.keyboard.up(']');

    await expect(hudValue(page, 'setpoint')).toHaveText('1.00 bar');
    const saved = await savedStateWhere(page, (s) => s.ccr.targetPo2Bar === 1);
    expect(saved.state.ccr.targetPo2Bar).toBe(1);
  });

  test('the setpoint buttons reach the same state as the keys', async ({ page }) => {
    await startCcrDive(page);

    await page.locator('[data-setpoint="increase"]').click();
    await expect(hudValue(page, 'setpoint')).toHaveText('0.80 bar');
    // Mixed: up by button, down by key. One control, two ways in.
    await page.keyboard.press('[');
    await expect(hudValue(page, 'setpoint')).toHaveText('0.70 bar');
    await page.locator('[data-setpoint="decrease"]').click();
    await expect(hudValue(page, 'setpoint')).toHaveText('0.60 bar');

    const saved = await savedStateWhere(page, (s) => s.ccr.targetPo2Bar === 0.6);
    expect(saved.state.ccr.targetPo2Bar).toBe(0.6);
  });

  test('B bails out to open circuit, and nothing can undo it', async ({ page }) => {
    // src/game-loop.js TASK-032F. Confirmed by state, not by a dialog (#67):
    // the row that held the button is gone, the cylinder row names the
    // diluent, and the model refuses a second bailout and any setpoint move.
    await startCcrDive(page);

    await page.keyboard.press('b');

    await expect(hudValue(page, 'cylinder')).toHaveText('Bailout · diluent cylinder');
    await expect(page.locator('[data-wreck-ccr]')).toBeHidden();
    let saved = await savedStateWhere(page, (s) => s.ccr.onBailout);
    expect(saved.state.ccr.onBailout).toBe(true);
    expect(saved.state.events.filter((e) => e.type === 'bailout')).toHaveLength(1);

    // The keys are no longer claimed, and change nothing. Waiting for a
    // save newer than the one above, so the assertion reads state written
    // after the presses rather than the save that preceded them.
    expect(await pressAndReadClaim(page, 'b')).toBe(false);
    expect(await pressAndReadClaim(page, ']')).toBe(false);
    const savedAtS = saved.state.elapsedTimeS;
    saved = await savedStateWhere(page, (s) => s.elapsedTimeS > savedAtS);
    expect(saved.state.elapsedTimeS).toBeGreaterThan(savedAtS);
    expect(saved.state.ccr.onBailout).toBe(true);
    expect(saved.state.ccr.targetPo2Bar).toBe(0.7);
    expect(saved.state.events.filter((e) => e.type === 'bailout')).toHaveLength(1);
  });

  test('the bailout button reaches the same state as the key', async ({ page }) => {
    await startCcrDive(page);

    await page.locator('[data-bailout]').click();

    await expect(hudValue(page, 'cylinder')).toHaveText('Bailout · diluent cylinder');
    await expect(page.locator('[data-wreck-ccr]')).toBeHidden();
    const saved = await savedStateWhere(page, (s) => s.ccr.onBailout);
    expect(saved.state.ccr.onBailout).toBe(true);
    expect(saved.state.events.filter((e) => e.type === 'bailout')).toHaveLength(1);
  });

  test('a nearly spent scrubber warns, in words', async ({ page }) => {
    // src/renderer.js TASK-032E: SCR LOW under ten minutes.
    await resumeCcrDiveWith(page, (state) => {
      state.ccr.scrubberRemainingS = 5 * 60;
    });

    await expect(page.locator('[role="alert"]')).toHaveText('Scrubber nearly spent — end the dive');
    await expect(page.locator('.status-chip')).toContainText('Scrubber low');
  });

  test('a failed scrubber warns of CO₂ buildup', async ({ page }) => {
    // src/renderer.js TASK-032E: CO2! once scrubberFailed.
    await resumeCcrDiveWith(page, (state) => {
      state.ccr.scrubberRemainingS = 0;
      state.ccr.scrubberFailed = true;
    });

    await expect(page.locator('[role="alert"]')).toHaveText(
      'Scrubber failed — simulated CO₂ buildup, bail out',
    );
    await expect(page.locator('.status-chip')).toContainText('CO₂ buildup');
  });

  test('a rebreather cylinder under 30 bar is marked and warns', async ({ page }) => {
    // src/renderer.js marks the O2 and DIL rows in danger tone with the ⚠
    // prefix under 30 bar (#163 review round 2 on PR #182). Here that is the
    // glyph in the row and the low-gas warning in words.
    await resumeCcrDiveWith(page, (state) => {
      state.ccr.oxygenCylinderPressureBar = 25;
    });

    await expect(hudValue(page, 'oxygenCylinder')).toHaveText('⚠ 25 bar');
    await expect(hudRow(page, 'oxygenCylinder')).toHaveAttribute('data-danger', '');
    await expect(hudValue(page, 'diluentCylinder')).toHaveText('200 bar');
    await expect(page.locator('[role="alert"]')).toHaveText(
      'Low gas pressure — begin a controlled exit',
    );
    await expect(page.locator('.status-chip')).toContainText('Low gas');
  });

  test('the cylinder rows show whole bar, so the reading and the mark agree at 30', async ({ page }) => {
    // #163 review round 4 on PR #182. The rule reads the rounded pressure, as
    // legacy's does; the row used to show one decimal, so 29.6 bar appeared
    // under the threshold with no mark. Legacy rounds the display too.
    await resumeCcrDiveWith(page, (state) => {
      state.ccr.oxygenCylinderPressureBar = 29.6;
      state.ccr.diluentCylinderPressureBar = 29.4;
    });

    await expect(hudValue(page, 'oxygenCylinder')).toHaveText('30 bar');
    await expect(hudRow(page, 'oxygenCylinder')).not.toHaveAttribute('data-danger', '');
    await expect(hudValue(page, 'diluentCylinder')).toHaveText('⚠ 29 bar');
    await expect(hudRow(page, 'diluentCylinder')).toHaveAttribute('data-danger', '');
  });

  test('the scrubber reads in whole minutes, as legacy draws it', async ({ page }) => {
    await resumeCcrDiveWith(page, (state) => {
      state.ccr.scrubberRemainingS = 150 * 60 + 20;
    });
    await expect(hudValue(page, 'scrubber')).toHaveText(/^150 min$/);
  });

  test('a failed dive offers no rebreather controls', async ({ page }) => {
    await resumeCcrDiveWith(page, (state) => {
      state.failure.reason = 'ccr-hypoxia';
      state.events.push({
        type: 'failure',
        elapsedTimeS: state.elapsedTimeS,
        failureReason: 'ccr-hypoxia',
      });
    });

    await expect(page.locator('[data-wreck-ccr]')).toBeHidden();
    expect(await pressAndReadClaim(page, ']')).toBe(false);
  });

  // The HUD against every control, at the sizes a phone takes. The CCR HUD
  // has ten rows; in one column they ran into the dock at short heights
  // (#163 review round 2 on PR #182). Checked for both modes, since the
  // open-circuit HUD shares the layout.
  for (const [width, height] of [[844, 390], [667, 375], [390, 844], [1280, 720]]) {
    test.describe(`${width}x${height}`, () => {
      test.use({ viewport: { width, height } });

      test('no HUD row meets a control on a rebreather dive', async ({ page }) => {
        await startCcrDive(page);
        await expectHudClearOfControls(page);
      });

      test('no HUD row meets a control on a six-cylinder dive', async ({ page }) => {
        await startSixCylinderDive(page);
        await expectHudClearOfControls(page);
      });
    });
  }

  test.describe('mobile viewport', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

    test('the rebreather buttons meet the 44px target with 8px spacing and overlap nothing', async ({ page }) => {
      await startCcrDive(page);

      const boxes = [];
      for (const handle of await page.locator('[data-wreck-ccr] button').all()) {
        const box = await handle.boundingBox();
        if (box) boxes.push(box);
      }
      expect(boxes).toHaveLength(3);
      for (const box of boxes) {
        expect(Math.round(box.width), 'button width').toBeGreaterThanOrEqual(44);
        expect(Math.round(box.height), 'button height').toBeGreaterThanOrEqual(44);
      }
      for (let i = 0; i < boxes.length; i += 1) {
        for (let j = i + 1; j < boxes.length; j += 1) {
          const a = boxes[i];
          const b = boxes[j];
          const gapX = Math.max(a.x - (b.x + b.width), b.x - (a.x + a.width));
          const gapY = Math.max(a.y - (b.y + b.height), b.y - (a.y + a.height));
          expect(Math.round(Math.max(gapX, gapY)), `spacing ${i}-${j}`).toBeGreaterThanOrEqual(8);
        }
      }
      await expectNoOverlapWithOtherControls(page, '[data-wreck-ccr] button');
    });

    test('the setpoint and the bailout can be driven by touch alone', async ({ page }) => {
      await startCcrDive(page);

      await page.locator('[data-setpoint="increase"]').tap();
      await expect(hudValue(page, 'setpoint')).toHaveText('0.80 bar');

      await page.locator('[data-bailout]').tap();
      await expect(hudValue(page, 'cylinder')).toHaveText('Bailout · diluent cylinder');
      const saved = await savedStateWhere(page, (s) => s.ccr.onBailout);
      expect(saved.state.ccr.targetPo2Bar).toBe(0.8);
      expect(saved.state.ccr.onBailout).toBe(true);
    });
  });
});

// Gas information (#163): I walks legacy's info pages and Escape closes
// them, mirroring src/state.js (WP-037 / BUG-CCR-3) and the pages
// src/renderer.js draws for infoPageMode 1-5.

const gasInfoPanel = (page) => page.locator('[data-gas-info]');
const gasInfoToggle = (page) => page.locator('[data-gas-info-toggle]');
const gasInfoHeading = (page) => gasInfoPanel(page).locator('h2');

async function startFourCylinderDive(page) {
  await page.goto('/dist/');
  await page.evaluate(() => window.localStorage.clear());
  await acceptSafetyGate(page);
  await page.locator('[data-setup-group=mode] [data-setup-option=tec]').check();
  for (let i = 0; i < 3; i += 1) {
    await page.locator('[data-setup-tank-add]').click();
  }
  await page.locator('[data-start-dive]').click();
  await page.locator('[data-renderer=pixi] canvas').waitFor();
  await expect(page.locator('[data-wreck-tanks] button')).toHaveCount(4);
}

test.describe('gas information', () => {
  test('a recreational dive has none, and leaves I alone', async ({ page }) => {
    // Legacy: `isAdvanced() || diveMode === 'ccr'`.
    await page.goto('/dist/');
    await page.evaluate(() => window.localStorage.clear());
    await startDiveByKeyboard(page);
    await page.locator('[data-renderer=pixi] canvas').waitFor();

    await expect(gasInfoToggle(page)).toBeHidden();
    expect(await pressAndReadClaim(page, 'i')).toBe(false);
    await expect(gasInfoPanel(page)).toBeHidden();
  });

  test('I walks cylinders and tissues, then closes', async ({ page }) => {
    // Legacy's decompression page joins with CNS in #186 (#185 review).
    await startTwoCylinderDive(page);
    await expect(gasInfoToggle(page)).toBeVisible();
    await expect(gasInfoToggle(page)).toHaveAttribute('aria-expanded', 'false');

    await page.keyboard.press('i');
    await expect(gasInfoPanel(page)).toBeVisible();
    await expect(gasInfoToggle(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(gasInfoHeading(page)).toHaveText('Gas information · Cylinders 1–2');
    await expect(gasInfoPanel(page)).toContainText('Cylinder 1 · Breathing');
    await expect(gasInfoPanel(page)).toContainText('Cylinder 2');
    // Air: floor((1.6 / 0.21 - 1) * 10) = 66 m, legacy's MOD row.
    await expect(gasInfoPanel(page)).toContainText('66 m');
    await expect(gasInfoPanel(page)).toContainText('250 bar');

    await page.keyboard.press('i');
    await expect(gasInfoHeading(page)).toHaveText('Gas information · Tissue saturation');
    await expect(gasInfoPanel(page).locator('.gas-info-bars li')).toHaveCount(16);
    await expect(gasInfoPanel(page).locator('.gas-info-bars li').first()).toContainText(
      /Compartment 1: \d+% of its M-value/,
    );

    await page.keyboard.press('i');
    await expect(gasInfoPanel(page)).toBeHidden();
    await expect(gasInfoToggle(page)).toHaveAttribute('aria-expanded', 'false');
  });

  test('the default technical dive, one cylinder, has it, and keeps it across a reload', async ({ page }) => {
    // #185 review: counting cylinders read the default technical setup as
    // recreational. The mode now comes from the setup, and from the save on
    // a resume.
    await page.goto('/dist/');
    await page.evaluate(() => window.localStorage.clear());
    await acceptSafetyGate(page);
    await page.locator('[data-setup-group=mode] [data-setup-option=tec]').check();
    await page.locator('[data-start-dive]').click();
    await page.locator('[data-renderer=pixi] canvas').waitFor();

    await expect(gasInfoToggle(page)).toBeVisible();
    await page.keyboard.press('i');
    await expect(gasInfoHeading(page)).toHaveText('Gas information · Cylinders 1–1');

    const saved = await persistedSave(page);
    expect(saved.version).toBe(3);
    expect(saved.diveMode).toBe('tec');

    // Resume: the setup screen the reload draws says recreational, the save
    // says technical, and the save wins, as it does for the gradient factors.
    await page.reload();
    await acceptSafetyGate(page);
    await page.locator('[data-start-dive]').click();
    await page.locator('[data-renderer=pixi] canvas').waitFor();
    await expect(gasInfoToggle(page)).toBeVisible();
  });

  test('four cylinders get a second cylinders page', async ({ page }) => {
    // Legacy skips page 2 unless tankCount > 3.
    await startFourCylinderDive(page);
    await page.keyboard.press('i');
    await expect(gasInfoHeading(page)).toHaveText('Gas information · Cylinders 1–3');
    await page.keyboard.press('i');
    await expect(gasInfoHeading(page)).toHaveText('Gas information · Cylinders 4–4');
    await expect(gasInfoPanel(page)).toContainText('Cylinder 4');
    await page.keyboard.press('i');
    await expect(gasInfoHeading(page)).toHaveText('Gas information · Tissue saturation');
  });

  test('the button walks the same pages as the key', async ({ page }) => {
    await startTwoCylinderDive(page);

    await gasInfoToggle(page).click();
    await expect(gasInfoHeading(page)).toHaveText('Gas information · Cylinders 1–2');
    // Mixed: on by button, on to the next page by key.
    await page.keyboard.press('i');
    await expect(gasInfoHeading(page)).toHaveText('Gas information · Tissue saturation');
    await gasInfoToggle(page).click();
    await expect(gasInfoPanel(page)).toBeHidden();
  });

  test('Escape closes it, and is left alone while it is closed', async ({ page }) => {
    await startTwoCylinderDive(page);
    expect(await pressAndReadClaim(page, 'Escape')).toBe(false);

    await page.keyboard.press('i');
    await expect(gasInfoPanel(page)).toBeVisible();
    expect(await pressAndReadClaim(page, 'Escape')).toBe(true);
    await expect(gasInfoPanel(page)).toBeHidden();

    // And I starts again from the first page.
    await page.keyboard.press('i');
    await expect(gasInfoHeading(page)).toHaveText('Gas information · Cylinders 1–2');
  });

  test('a rebreather toggles its one page, which follows a bailout', async ({ page }) => {
    // Legacy: `infoPageMode = (infoPageMode === 5) ? 0 : 5`.
    await startCcrDive(page);
    await page.keyboard.press('i');
    await expect(gasInfoHeading(page)).toHaveText('Gas information · Rebreather');
    await expect(gasInfoPanel(page)).toContainText('Loop');
    await expect(gasInfoPanel(page)).toContainText('21% O₂ · 0% He');
    // Legacy's O2 V and DIL V rows (#185 review): the default 2 L and 3 L.
    await expect(gasInfoPanel(page)).toContainText('O₂ cylinder size');
    await expect(gasInfoPanel(page)).toContainText('2 L');
    await expect(gasInfoPanel(page)).toContainText('Diluent cylinder size');
    await expect(gasInfoPanel(page)).toContainText('3 L');

    await page.keyboard.press('b');
    // BAIL in legacy's danger tone; here the glyph says it.
    await expect(gasInfoPanel(page)).toContainText('⚠ Bailout');

    await page.keyboard.press('i');
    await expect(gasInfoPanel(page)).toBeHidden();
  });

  test('a failed dive has none', async ({ page }) => {
    await resumeCcrDiveWith(page, (state) => {
      state.failure.reason = 'ccr-hypoxia';
      state.events.push({
        type: 'failure',
        elapsedTimeS: state.elapsedTimeS,
        failureReason: 'ccr-hypoxia',
      });
    });
    await expect(gasInfoToggle(page)).toBeHidden();
    expect(await pressAndReadClaim(page, 'i')).toBe(false);
  });

  test('the toggle meets the 44px target', async ({ page }) => {
    await startTwoCylinderDive(page);
    const box = await gasInfoToggle(page).boundingBox();
    expect(Math.round(box.width)).toBeGreaterThanOrEqual(44);
    expect(Math.round(box.height)).toBeGreaterThanOrEqual(44);
  });

  // Open pages against every control, at the sizes a phone takes. The panel
  // shares the HUD's column and has to stop above the dock and the D-pad.
  for (const [width, height] of [[844, 390], [667, 375], [390, 844], [1280, 720]]) {
    test.describe(`${width}x${height}`, () => {
      test.use({ viewport: { width, height } });

      test('no open page meets a control, and NDL stays visible', async ({ page }) => {
        await startSixCylinderDive(page);
        // Cylinders 1-3, cylinders 4-6, tissues.
        for (let step = 0; step < 3; step += 1) {
          await gasInfoToggle(page).click();
          await expect(gasInfoPanel(page)).toBeVisible();
          await expectHudClearOfControls(page);
          await expect(hudRow(page, 'ndl')).toBeVisible();
        }
      });
    });
  }
});
