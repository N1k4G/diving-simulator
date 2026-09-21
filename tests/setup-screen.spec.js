const { expect, test } = require('@playwright/test');
const { acceptSafetyGate, startDive, startDiveAndWaitForCanvas } = require('./helpers/start-dive.cjs');

// hasTouch, unlike the other specs' mobile blocks: one test below taps
// rather than clicks, and Playwright refuses tap without it.
const MOBILE_VIEWPORT = { viewport: { width: 390, height: 844 }, hasTouch: true };

const oxygenValue = (page) => page.locator('[data-setup-value=oxygen]');
const pressureValue = (page) => page.locator('[data-setup-value=pressure]');
const stepButton = (page, stepper, direction) =>
  page.locator(`[data-setup-stepper=${stepper}] [data-setup-step=${direction}]`);

// Configures the same dive twice, once with keys and once with the pointer.
// #158's acceptance is that both reach an identical configuration, so the two
// helpers below deliberately produce the same end state by different means —
// if they ever drift apart, the comparison test fails rather than quietly
// testing two different dives.
async function configureByKeyboard(page) {
  await page.keyboard.press('3'); // EAN32
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('PageUp');
}

async function configureByPointer(page) {
  await page.locator('[data-setup-preset=ean32]').click();
  await stepButton(page, 'oxygen', 'increase').click();
  await stepButton(page, 'oxygen', 'increase').click();
  await stepButton(page, 'pressure', 'increase').click();
}

test('the setup screen stands between the safety gate and the dive', async ({ page }) => {
  await page.goto('/dist/');
  await page.getByRole('button', { name: 'I understand — start simulation' }).click();

  await expect(page.locator('.setup-screen')).toBeVisible();
  // The dive must not have started yet: a renderer mounted behind the setup
  // screen would mean the configuration cannot affect it.
  await expect(page.locator('[data-renderer=pixi] canvas')).toHaveCount(0);

  await page.locator('[data-start-dive]').click();
  await expect(page.locator('[data-renderer=pixi] canvas')).toBeVisible();
});

test('keyboard and pointer reach the same configuration and the same dive', async ({ page }) => {
  await page.goto('/dist/');
  await acceptSafetyGate(page);
  await configureByKeyboard(page);
  const keyboardOxygen = await oxygenValue(page).textContent();
  const keyboardPressure = await pressureValue(page).textContent();
  await page.locator('[data-start-dive]').click();
  await page.locator('[data-renderer=pixi] canvas').waitFor();
  const keyboardGas = await page.locator('.wreck-hud [data-hud-metric=gas] dd').textContent();

  // A fresh context, because a saved dive would be restored over the
  // configuration and both runs would then agree for the wrong reason.
  await page.context().clearCookies();
  await page.goto('/dist/');
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
  await acceptSafetyGate(page);
  await configureByPointer(page);
  const pointerOxygen = await oxygenValue(page).textContent();
  const pointerPressure = await pressureValue(page).textContent();
  await page.locator('[data-start-dive]').click();
  await page.locator('[data-renderer=pixi] canvas').waitFor();
  const pointerGas = await page.locator('.wreck-hud [data-hud-metric=gas] dd').textContent();

  expect(pointerOxygen).toBe(keyboardOxygen);
  expect(pointerPressure).toBe(keyboardPressure);
  expect(pointerGas).toBe(keyboardGas);

  // And the values are the configured ones, not merely equal to each other:
  // two broken paths agreeing on a default would satisfy the three above.
  expect(keyboardOxygen).toContain('34');  // EAN32 plus two 1% steps
  expect(keyboardPressure).toContain('210');
});

test('rec hides the trimix presets and tec shows them', async ({ page }) => {
  await page.goto('/dist/');
  await acceptSafetyGate(page);

  await expect(page.locator('[data-setup-preset=ean36]')).toBeVisible();
  await expect(page.locator('[data-setup-preset=tx21-35]')).toHaveCount(0);

  await page.locator('[data-setup-group=mode] [data-setup-option=tec]').check();
  await expect(page.locator('[data-setup-preset=tx21-35]')).toBeVisible();
});

test('CCR is offered but says why it cannot be chosen yet', async ({ page }) => {
  // The mode exists in the model and in the legacy client, so hiding it would
  // misrepresent the product. Disabled with a stated reason is the honest
  // intermediate state while #158's third slice is outstanding.
  await page.goto('/dist/');
  await acceptSafetyGate(page);

  const ccr = page.locator('[data-setup-group=mode] [data-setup-option=ccr]');
  await expect(ccr).toBeDisabled();
  await expect(page.locator('[data-setup-group=mode]')).toContainText(
    'Not configurable yet',
  );
});

test('an unmigrated site says so instead of silently diving the wreck', async ({ page }) => {
  // The screen offers all four authored sites on purpose (#158); the
  // composition root is what knows only the wreck has a scene. Without this
  // panel, choosing Cave would drop the player into the wreck.
  await page.goto('/dist/');
  await acceptSafetyGate(page);

  await page.locator('[data-setup-group=site] [data-setup-option=cave]').check();
  await page.locator('[data-start-dive]').click();

  await expect(page.locator('[data-unavailable-site]')).toBeVisible();
  await expect(page.locator('[data-renderer=pixi] canvas')).toHaveCount(0);

  await page.locator('[data-back-to-setup]').click();
  await expect(page.locator('.setup-screen')).toBeVisible();
});

test('the setup keyboard bindings stop applying once the dive starts', async ({ page }) => {
  // The screen listens on document, so a listener left attached would let
  // `1`-`8` keep reconfiguring a dive already in progress.
  await page.goto('/dist/');
  await startDiveAndWaitForCanvas(page);

  const gas = page.locator('.wreck-hud [data-hud-metric=gas] dd');
  const before = await gas.textContent();
  await page.keyboard.press('PageUp');
  await page.keyboard.press('3');
  await page.waitForTimeout(150);

  expect(await gas.textContent()).toBe(before);
});

test('mode and site can be chosen with the keyboard alone', async ({ page }) => {
  // The document-level O2 shortcuts used to swallow ArrowLeft/Right everywhere
  // and preventDefault() them, which cancelled the radio groups' native
  // traversal and silently changed the gas instead. Radios are radios exactly
  // for this traversal, so it is asserted rather than assumed.
  await page.goto('/dist/');
  await acceptSafetyGate(page);

  const oxygenBefore = await oxygenValue(page).textContent();

  const rec = page.locator('[data-setup-group=mode] [data-setup-option=rec]');
  await rec.focus();
  await page.keyboard.press('ArrowRight');
  await expect(
    page.locator('[data-setup-group=mode] [data-setup-option=tec]'),
  ).toBeChecked();

  // And the gas did not move while the radio group was being traversed.
  expect(await oxygenValue(page).textContent()).toBe(oxygenBefore);

  const wreck = page.locator('[data-setup-group=site] [data-setup-option=wreck]');
  await wreck.focus();
  await page.keyboard.press('ArrowRight');
  await expect(
    page.locator('[data-setup-group=site] [data-setup-option=cave]'),
  ).toBeChecked();
  expect(await oxygenValue(page).textContent()).toBe(oxygenBefore);
});

test('a focused control survives the re-render a change triggers', async ({ page }) => {
  // Every change redraws the whole screen. Without restoring focus the first
  // keypress on a stepper would be the last one that worked.
  await page.goto('/dist/');
  await acceptSafetyGate(page);

  const increase = stepButton(page, 'pressure', 'increase');
  await increase.focus();
  await page.keyboard.press('Enter');
  await expect(pressureValue(page)).toContainText('210');

  await expect(increase).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(pressureValue(page)).toContainText('220');
});

test('open-circuit bounds match the legacy setup screen', async ({ page }) => {
  // src/state.js gsAdjustPressure clamps to 200-300, so 190 must be
  // unreachable here too; an earlier version of this screen allowed it.
  await page.goto('/dist/');
  await acceptSafetyGate(page);

  await page.keyboard.press('PageDown');
  await expect(pressureValue(page)).toContainText('200');

  for (let i = 0; i < 12; i += 1) await page.keyboard.press('PageUp');
  await expect(pressureValue(page)).toContainText('300');
});


test.describe('technical mode', () => {
  const toTec = async (page) => {
    await page.goto('/dist/');
    await acceptSafetyGate(page);
    await page.locator('[data-setup-group=mode] [data-setup-option=tec]').check();
    await expect(page.locator('[data-setup-stepper=helium]')).toBeVisible();
    // .check() leaves focus on the radio, and a focused radio owns the arrow
    // keys — deliberately, so mode traversal keeps working. The global
    // shortcuts therefore only apply when focus is not inside a radio group,
    // which is ordinary web behaviour rather than a quirk. Blur so the
    // shortcut tests below exercise the shortcuts and not the traversal.
    await page.locator('[data-setup-option=tec]').evaluate((el) => el.blur());
  };

  test('rec shows none of the technical controls and tec shows all of them', async ({ page }) => {
    await page.goto('/dist/');
    await acceptSafetyGate(page);

    for (const id of ['helium', 'volume', 'amv', 'gf-low', 'gf-high']) {
      await expect(page.locator(`[data-setup-stepper=${id}]`)).toHaveCount(0);
    }
    await expect(page.locator('[data-setup-group=tanks]')).toHaveCount(0);

    await page.locator('[data-setup-group=mode] [data-setup-option=tec]').check();
    for (const id of ['helium', 'volume', 'amv', 'gf-low', 'gf-high']) {
      await expect(page.locator(`[data-setup-stepper=${id}]`)).toBeVisible();
    }
    await expect(page.locator('[data-setup-group=tanks]')).toBeVisible();
  });

  test('the technical keyboard bindings match the legacy screen', async ({ page }) => {
    // README "Gas Setup Screen": up/down helium, [ ] AMV, comma/period tank
    // size, g/G and f/F the gradient factors.
    await toTec(page);

    await page.keyboard.press('ArrowUp');
    await expect(page.locator('[data-setup-value=helium]')).toContainText('1');

    await page.keyboard.press(']');
    await expect(page.locator('[data-setup-value=amv]')).toContainText('16');

    await page.keyboard.press('.');
    await expect(page.locator('[data-setup-value=volume]')).toContainText('13');

    await page.keyboard.press('g');
    await expect(page.locator('[data-setup-value=gf-low]')).toContainText('40');

    await page.keyboard.press('F');
    await expect(page.locator('[data-setup-value=gf-high]')).toContainText('70');
  });

  test('gradient factors cannot cross', async ({ page }) => {
    // src/state.js gsAdjustGFLow: after clamping, `if (gfLow > gfHigh) gfLow = gfHigh`.
    await toTec(page);

    for (let i = 0; i < 20; i += 1) await page.keyboard.press('g');
    await expect(page.locator('[data-setup-value=gf-low]')).toContainText('75');
    await expect(page.locator('[data-setup-value=gf-high]')).toContainText('75');
  });

  test('cylinders can be added, selected and removed', async ({ page }) => {
    await toTec(page);
    await expect(page.locator('[data-setup-tab]')).toHaveCount(1);
    await expect(page.locator('[data-setup-tank-remove]')).toBeDisabled();

    await page.locator('[data-setup-tank-add]').click();
    await page.locator('[data-setup-tank-add]').click();
    await expect(page.locator('[data-setup-tab]')).toHaveCount(3);

    // Editing follows the selected tab, not the active tank.
    await page.locator('[data-setup-tab="1"]').click();
    await expect(page.locator('[data-setup-tab="1"]')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('[data-setup-preset=ean36]').click();
    await expect(page.locator('[data-setup-value=oxygen]')).toContainText('36');

    await page.locator('[data-setup-tab="0"]').click();
    await expect(page.locator('[data-setup-value=oxygen]')).toContainText('21');

    await page.locator('[data-setup-tank-remove]').click();
    await expect(page.locator('[data-setup-tab]')).toHaveCount(2);
  });

  test('the add button stops at six cylinders', async ({ page }) => {
    // src/constants.js MAX_TANKS = 6.
    await toTec(page);
    for (let i = 0; i < 8; i += 1) {
      const add = page.locator('[data-setup-tank-add]');
      if (await add.isDisabled()) break;
      await add.click();
    }
    await expect(page.locator('[data-setup-tab]')).toHaveCount(6);
    await expect(page.locator('[data-setup-tank-add]')).toBeDisabled();
  });

  test('switching mode keeps each mode its own configuration', async ({ page }) => {
    // src/state.js switchMode: saveModeSettings then restoreModeSettings.
    await toTec(page);
    await page.locator('[data-setup-preset=tx21-35]').click();
    await expect(page.locator('[data-setup-value=helium]')).toContainText('35');

    await page.locator('[data-setup-group=mode] [data-setup-option=rec]').check();
    await expect(page.locator('[data-setup-value=oxygen]')).toContainText('21');
    await expect(page.locator('[data-setup-stepper=helium]')).toHaveCount(0);

    await page.locator('[data-setup-group=mode] [data-setup-option=tec]').check();
    await expect(page.locator('[data-setup-value=helium]')).toContainText('35');
  });


  test('Tab moves focus through the form instead of cycling cylinders', async ({ page }) => {
    // #158 review: handleTecKey used to take Tab and preventDefault() it, so a
    // keyboard user could not leave whichever control they were on — in a
    // surface that is DOM precisely so it can be navigated.
    await toTec(page);
    await page.locator('[data-setup-tank-add]').click();
    await expect(page.locator('[data-setup-tab]')).toHaveCount(2);

    const first = page.locator('[data-setup-tab="0"]');
    await first.focus();
    const selectedBefore = await page
      .locator('[data-setup-tab="0"]')
      .getAttribute('aria-pressed');

    await page.keyboard.press('Tab');

    // Focus moved off the control it was on...
    await expect(first).not.toBeFocused();
    // ...and the selected cylinder did not change.
    await expect(page.locator('[data-setup-tab="0"]')).toHaveAttribute(
      'aria-pressed',
      selectedBefore ?? 'true',
    );
  });

  test('a cylinder button keeps focus across the re-render it triggers', async ({ page }) => {
    // The same class PR #177 fixed for the steppers; focusKeyOf did not know
    // the tank buttons.
    await toTec(page);

    const add = page.locator('[data-setup-tank-add]');
    await add.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-setup-tab]')).toHaveCount(2);
    await expect(add).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(page.locator('[data-setup-tab]')).toHaveCount(3);
  });

  test('a new cylinder is the default size, not the resized one', async ({ page }) => {
    // src/state.js createTank reads the module-level tankVolume (12);
    // gsAdjustTankVol writes t.volume and never tankVolume.
    await toTec(page);
    await page.keyboard.press('.');
    await page.keyboard.press('.');
    await page.keyboard.press('.');
    await expect(page.locator('[data-setup-value=volume]')).toContainText('15');

    await page.locator('[data-setup-tank-add]').click();
    await page.locator('[data-setup-tab="1"]').click();
    await expect(page.locator('[data-setup-value=volume]')).toContainText('12');
  });

  test('the configured gradient factors reach the dive', async ({ page }) => {
    // #158 review: the planner was called with DEFAULT_PLANNER_SETTINGS no
    // matter what the screen said, so the GF controls were decorative. NDL is
    // the readout they move.
    const ndlFor = async (presses, key) => {
      await toTec(page);
      for (let i = 0; i < presses; i += 1) await page.keyboard.press(key);
      await page.locator('[data-start-dive]').click();
      await page.locator('[data-renderer=pixi] canvas').waitFor();
      const ndl = page.locator('.wreck-hud [data-hud-metric=ndl] dd');
      await expect(ndl).toHaveText(/\d/);
      const text = await ndl.textContent();
      await page.evaluate(() => window.localStorage.clear());
      return text;
    };

    // G lowers GF low, F lowers GF high: the conservative end.
    const conservative = await ndlFor(20, 'F');
    const liberal = await ndlFor(20, 'f');

    expect(conservative).not.toBe(liberal);
  });

  test('a technical dive starts with the configured mix', async ({ page }) => {
    await toTec(page);
    await page.locator('[data-setup-preset=tx18-45]').click();
    await page.keyboard.press('PageUp');
    await page.locator('[data-start-dive]').click();
    await page.locator('[data-renderer=pixi] canvas').waitFor();

    await expect(page.locator('.wreck-hud [data-hud-metric=gas] dd')).toContainText('210');
  });
});

test.describe('mobile viewport', () => {
  test.use(MOBILE_VIEWPORT);

  test('every setup control meets the 44px touch target with 8px spacing', async ({ page }) => {
    // The template is the #121 test in result-screen.spec.js, which caught the
    // legacy setup screen shipping 38-41px controls.
    await page.goto('/dist/');
    await acceptSafetyGate(page);

    const boxes = [];
    for (const handle of await page
      .locator('.setup-screen button, .setup-screen label.setup-choice')
      .all()) {
      const box = await handle.boundingBox();
      if (box) boxes.push(box);
    }
    expect(boxes.length).toBeGreaterThan(8);

    for (const box of boxes) {
      expect(Math.round(box.width), 'control width').toBeGreaterThanOrEqual(44);
      expect(Math.round(box.height), 'control height').toBeGreaterThanOrEqual(44);
    }

    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i];
        const b = boxes[j];
        const gapX = Math.max(a.x - (b.x + b.width), b.x - (a.x + a.width));
        const gapY = Math.max(a.y - (b.y + b.height), b.y - (a.y + a.height));
        // Non-overlapping in at least one axis by 8px, or overlapping in both
        // (which only happens for a label and the control nested inside it).
        const separated = gapX >= 8 || gapY >= 8 || (gapX < 0 && gapY < 0);
        expect(separated, `controls ${i} and ${j} are too close`).toBe(true);
      }
    }
  });

  test('the dive can be started by touch alone', async ({ page }) => {
    await page.goto('/dist/');
    await startDive(page, async (target) => {
      await target.locator('[data-setup-preset=ean32]').tap();
    });
    await expect(page.locator('[data-renderer=pixi] canvas')).toBeVisible();
  });
});
