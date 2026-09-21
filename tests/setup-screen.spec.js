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

test('all three modes can be chosen, and none still says it cannot be', async ({ page }) => {
  // CCR was offered and disabled with a stated reason through the first two
  // slices rather than hidden. Now that it is configurable, the reason has to
  // go with it — a stale "not configurable yet" beside a working control is
  // the same defect as a keyboard hint naming a key that was removed.
  await page.goto('/dist/');
  await acceptSafetyGate(page);

  for (const mode of ['rec', 'tec', 'ccr']) {
    await expect(
      page.locator(`[data-setup-group=mode] [data-setup-option=${mode}]`),
    ).toBeEnabled();
  }
  await expect(page.locator('[data-setup-group=mode]')).not.toContainText(
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

  // This compared the gas readout before and after and expected it unchanged,
  // which is not a property the readout has: the cylinder drains while the
  // dive runs, and the HUD prints one decimal of bar. That is what the
  // unexplained failure in the previous slice was — the reading ticked down
  // between the two samples. The hypothesis recorded then, a race against the
  // first painted frame, was the wrong one.
  //
  // So assert what the leak would actually do. PageUp adds 10 bar, which is
  // the one thing draining cannot produce: the reading may only go down.
  // Preset 3 changes the mix, which does not drain, so it is compared exactly
  // through the save.
  const gas = page.locator('.wreck-hud [data-hud-metric=gas] dd');
  await expect(gas).toHaveText(/\d/);
  const reading = async () =>
    Number.parseFloat((await gas.textContent()).replace(',', '.'));
  const before = await reading();

  await page.keyboard.press('PageUp');
  await page.keyboard.press('3');
  await page.waitForTimeout(150);

  expect(await reading()).toBeLessThanOrEqual(before);

  const saved = await page
    .waitForFunction(() => {
      const raw = window.localStorage.getItem('diving-simulator.save-game');
      return raw === null ? null : JSON.parse(raw);
    })
    .then((handle) => handle.jsonValue());
  expect(saved.state.tanks[0].gas.oxygenFraction).toBeCloseTo(0.21, 10);
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
      // Cleared here, on the setup screen, rather than after the reading. The
      // previous dive went on saving for as long as it ran, so a clear issued
      // while it was still on screen was undone within seconds and this call
      // resumed that dive instead of starting a fresh one. It went unnoticed
      // while a resumed dive took its factors from the setup screen anyway;
      // once the resume started honouring the save (#158 review), the second
      // reading came back as the first one's and this test caught it.
      await page.evaluate(() => window.localStorage.clear());
      for (let i = 0; i < presses; i += 1) await page.keyboard.press(key);
      await page.locator('[data-start-dive]').click();
      await page.locator('[data-renderer=pixi] canvas').waitFor();
      const ndl = page.locator('.wreck-hud [data-hud-metric=ndl] dd');
      await expect(ndl).toHaveText(/\d/);
      return ndl.textContent();
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

    // Bounded, not exact. The dive is running by the time the HUD first
    // paints, and the cylinder is already draining: this asserted
    // toContainText('210') and met "209.9 bar" under load. The configured
    // pressure is still what is being pinned — an unconfigured dive starts at
    // 200 bar and reads about 199.9, nowhere near this window.
    const gas = page.locator('.wreck-hud [data-hud-metric=gas] dd');
    await expect(gas).toHaveText(/\d/);
    const bar = Number.parseFloat((await gas.textContent()).replace(',', '.'));
    expect(bar).toBeGreaterThan(209);
    expect(bar).toBeLessThanOrEqual(210);

    // The mix does not drain, so it is asserted exactly. Tx 18/45.
    const saved = await persistedSave(page);
    expect(saved.state.tanks[0].gas.oxygenFraction).toBeCloseTo(0.18, 10);
    expect(saved.state.tanks[0].gas.heliumFraction).toBeCloseTo(0.45, 10);
  });

  // The save key, from src/save/save-repository.ts SAVE_GAME_STORAGE_KEY. The
  // spec is CommonJS and the constant is TypeScript, so it is spelled out
  // here; the two tests below fail loudly if it ever stops matching.
  const SAVE_KEY = 'diving-simulator.save-game';

  const persistedSave = (page) =>
    page
      .waitForFunction((key) => {
        const raw = window.localStorage.getItem(key);
        return raw === null ? null : JSON.parse(raw);
      }, SAVE_KEY)
      .then((handle) => handle.jsonValue());

  test('the save carries the factors the dive is being planned with', async ({ page }) => {
    // #158 review: SaveGame held the DiveState alone. Half of the resume fix —
    // the factors have to be written down before anything can read them back.
    await toTec(page);
    await page.keyboard.press('g');
    await page.keyboard.press('g');
    await page.keyboard.press('g');
    await page.keyboard.press('f');
    await expect(page.locator('[data-setup-value=gf-low]')).toContainText('50');
    await expect(page.locator('[data-setup-value=gf-high]')).toContainText('80');

    await page.locator('[data-start-dive]').click();
    await page.locator('[data-renderer=pixi] canvas').waitFor();

    const saved = await persistedSave(page);
    expect(saved.gradientFactors).toEqual({ lowPercent: 50, highPercent: 80 });
  });

  test('a resumed dive is planned on its save, not on the setup screen behind it', async ({ page }) => {
    // The other half. Before the fix the state came from the save while the
    // factors came from the setup screen the reload had just drawn, so a
    // 50/80 dive continued on 35/75: same tissues, same gas, same clock,
    // different ceiling.
    //
    // Both resumes below start from the identical saved dive and differ only
    // in the persisted factors. Running the dive twice instead would have
    // compared two different amounts of elapsed time, and the NDLs would
    // differ whether or not the factors survived — a test that passes for the
    // wrong reason.
    await toTec(page);
    await page.locator('[data-start-dive]').click();
    await page.locator('[data-renderer=pixi] canvas').waitFor();
    const save = await persistedSave(page);

    const resumedNdl = async (lowPercent, highPercent) => {
      // Leave the dive before writing. A running dive saves every few seconds,
      // so injecting underneath one overwrites the factors again before
      // anything reads them — which is how this test first passed the buggy
      // build and the fixed one alike.
      await page.goto('/dist/');
      await page.evaluate(
        ([key, value]) => {
          window.localStorage.setItem(key, value);
        },
        [
          SAVE_KEY,
          JSON.stringify({
            ...save,
            gradientFactors: { lowPercent, highPercent },
          }),
        ],
      );
      // The save is read when the dive starts, not when the page loads, so
      // this is the point the injected factors take effect. Started without
      // touching a control, so the setup screen is offering the defaults: if
      // they win, both calls return the same number.
      await startDiveAndWaitForCanvas(page);
      const ndl = page.locator('.wreck-hud [data-hud-metric=ndl] dd');
      await expect(ndl).toHaveText(/\d/);
      return ndl.textContent();
    };

    const conservative = await resumedNdl(30, 30);
    const liberal = await resumedNdl(100, 100);

    expect(conservative).not.toBe(liberal);
  });
});


test.describe('closed-circuit mode', () => {
  const toCcr = async (page) => {
    await page.goto('/dist/');
    await page.evaluate(() => window.localStorage.clear());
    await acceptSafetyGate(page);
    await page.locator('[data-setup-group=mode] [data-setup-option=ccr]').check();
    await expect(page.locator('[data-setup-stepper=setpoint]')).toBeVisible();
    // Same reason as the tec block: .check() leaves focus on the radio, and a
    // focused radio owns the arrow keys. Blur so the shortcut tests exercise
    // the shortcuts rather than the group's traversal.
    await page.locator('[data-setup-option=ccr]').evaluate((el) => el.blur());
  };

  test('CCR shows the loop controls and none of the open-circuit ones', async ({ page }) => {
    // src/ui.js hides the presets, oxygen, pressure, tabs, helium, AMV, tank
    // size and gradient factors behind its isCcr switches. The dive still
    // carries a cylinder; the screen simply stops offering it.
    await toCcr(page);

    for (const stepper of ['setpoint', 'diluent-volume', 'oxygen-volume', 'oxygen-pressure']) {
      await expect(page.locator(`[data-setup-stepper=${stepper}]`)).toBeVisible();
    }
    await expect(page.locator('[data-setup-group=diluent]')).toBeVisible();

    for (const stepper of ['oxygen', 'pressure', 'helium', 'volume', 'amv', 'gf-low', 'gf-high']) {
      await expect(page.locator(`[data-setup-stepper=${stepper}]`)).toHaveCount(0);
    }
    await expect(page.locator('[data-setup-group=preset]')).toHaveCount(0);
    await expect(page.locator('[data-setup-group=tanks]')).toHaveCount(0);
  });

  test('the CCR keyboard bindings match the legacy screen', async ({ page }) => {
    // src/ui.js updateGasSetup: 1-5 diluent presets, [ and ] setpoint,
    // comma and period the diluent cylinder.
    await toCcr(page);

    await page.keyboard.press('3');
    await expect(page.locator('[data-setup-diluent=tx15-45]')).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await page.keyboard.press(']');
    await page.keyboard.press(']');
    await expect(page.locator('[data-setup-value=setpoint]')).toContainText('0.9');
    await page.keyboard.press('[');
    await expect(page.locator('[data-setup-value=setpoint]')).toContainText('0.8');

    await page.keyboard.press('.');
    await expect(page.locator('[data-setup-value=diluent-volume]')).toContainText('4');
    await page.keyboard.press(',');
    await page.keyboard.press(',');
    await expect(page.locator('[data-setup-value=diluent-volume]')).toContainText('2');
  });

  test('the digits pick a diluent, not an open-circuit gas', async ({ page }) => {
    // Index 2 is EAN32 on the open-circuit list and Tx 15/45 as a diluent.
    // Sharing one list would have put a 32% nitrox mix in the loop.
    await toCcr(page);
    await page.keyboard.press('3');

    await expect(page.locator('[data-setup-diluent=tx15-45]')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // 6-8 exist open-circuit and not here, so they must do nothing at all.
    await page.keyboard.press('6');
    await expect(page.locator('[data-setup-diluent=tx15-45]')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('the open-circuit keys do not edit the cylinder CCR hides', async ({ page }) => {
    // ArrowRight and PageUp would otherwise change an oxygen fraction and a
    // pressure the player cannot see. Legacy returns out of updateGasSetup
    // before reaching them.
    await toCcr(page);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('PageUp');

    // Read through the started dive, not by switching back to rec. Entering a
    // mode restores that mode's saved snapshot, so a trip to rec hands back
    // the cylinder as rec last left it and hides the edit either way — the
    // first version of this test did exactly that and passed with the fix
    // reverted. The dive carries the cylinder CCR was holding.
    await page.locator('[data-start-dive]').click();
    await page.locator('[data-renderer=pixi] canvas').waitFor();
    const saved = await page
      .waitForFunction(() => {
        const raw = window.localStorage.getItem('diving-simulator.save-game');
        return raw === null ? null : JSON.parse(raw);
      })
      .then((handle) => handle.jsonValue());

    const tank = saved.state.tanks[0];
    expect(tank.gas.oxygenFraction).toBeCloseTo(0.21, 10);
    // 12 L at 200 bar. A PageUp that got through would make it 2520.
    expect(tank.gasRemainingL).toBe(2400);
  });

  test('a CCR dive starts on the configured loop', async ({ page }) => {
    await toCcr(page);
    await page.keyboard.press('3');
    for (let i = 0; i < 6; i += 1) await page.keyboard.press(']');
    await expect(page.locator('[data-setup-value=setpoint]')).toContainText('1.3');

    await page.locator('[data-start-dive]').click();
    await page.locator('[data-renderer=pixi] canvas').waitFor();

    const saved = await page
      .waitForFunction(() => {
        const raw = window.localStorage.getItem('diving-simulator.save-game');
        return raw === null ? null : JSON.parse(raw);
      })
      .then((handle) => handle.jsonValue());

    // The save is the only place the configured loop is observable from
    // outside: the HUD has no CCR row yet, and that belongs with the in-dive
    // controls rather than here.
    expect(saved.state.ccr).not.toBeNull();
    expect(saved.state.ccr.targetPo2Bar).toBe(1.3);
    expect(saved.state.ccr.diluent.oxygenFraction).toBeCloseTo(0.15, 10);
    expect(saved.state.ccr.diluent.heliumFraction).toBeCloseTo(0.45, 10);
  });

  test('keyboard and pointer configure the same loop', async ({ page }) => {
    // #158's acceptance: both paths reach the dive with an identical model
    // configuration. The two helpers below deliberately produce the same end
    // state by different means, so drift between them fails here rather than
    // quietly testing two different dives.
    const loopAfter = async (configure) => {
      await toCcr(page);
      await configure(page);
      await page.locator('[data-start-dive]').click();
      await page.locator('[data-renderer=pixi] canvas').waitFor();
      const saved = await page
        .waitForFunction(() => {
          const raw = window.localStorage.getItem('diving-simulator.save-game');
          return raw === null ? null : JSON.parse(raw);
        })
        .then((handle) => handle.jsonValue());
      return saved.state.ccr;
    };

    const byKeyboard = await loopAfter(async (p) => {
      await p.keyboard.press('3');
      for (let i = 0; i < 3; i += 1) await p.keyboard.press(']');
      await p.keyboard.press('.');
    });
    const byPointer = await loopAfter(async (p) => {
      await p.locator('[data-setup-diluent=tx15-45]').click();
      for (let i = 0; i < 3; i += 1) {
        await p.locator('[data-setup-stepper=setpoint] [data-setup-step=increase]').click();
      }
      await p
        .locator('[data-setup-stepper=diluent-volume] [data-setup-step=increase]')
        .click();
    });

    expect(byPointer).toEqual(byKeyboard);
    // And the values are the configured ones, not merely equal: two broken
    // paths agreeing on the defaults would satisfy the line above.
    expect(byKeyboard.targetPo2Bar).toBe(1);
    expect(byKeyboard.diluentCylinderVolumeL).toBe(4);
    expect(byKeyboard.diluent.heliumFraction).toBeCloseTo(0.45, 10);
  });

  test('the keyboard hint names the keys CCR actually has', async ({ page }) => {
    // The base hint promises 1-8 gas presets, arrow-key oxygen and Page
    // Up/Down pressure, and CCR shows none of those. A hint is invisible to
    // every test that only presses the right keys, which is how the tec hint
    // went on naming Tab for a whole slice after Tab was removed.
    await toCcr(page);
    const hints = page.locator('.setup-hint');

    await expect(hints).toHaveCount(1);
    await expect(hints).toContainText('1-5 diluent');
    await expect(hints).not.toContainText('1-8');
    await expect(hints).not.toContainText('oxygen');
  });

  test('mode cycling with M reaches CCR', async ({ page }) => {
    // src/ui.js cycles rec, tec, ccr with M in every mode. The list was two
    // long while CCR was disabled, so M could never arrive here.
    await page.goto('/dist/');
    await acceptSafetyGate(page);
    await page.locator('[data-setup-option=rec]').evaluate((el) => el.blur());

    await page.keyboard.press('m');
    await expect(page.locator('[data-setup-option=tec]')).toBeChecked();
    await page.keyboard.press('m');
    await expect(page.locator('[data-setup-option=ccr]')).toBeChecked();
    await page.keyboard.press('m');
    await expect(page.locator('[data-setup-option=rec]')).toBeChecked();
  });

  test('the configured loop survives a trip through another mode', async ({ page }) => {
    // src/state.js keeps ccrState per mode in modeSettings, so leaving CCR
    // and returning restores the loop rather than resetting it.
    await toCcr(page);
    await page.keyboard.press('4');
    await page.keyboard.press(']');
    await expect(page.locator('[data-setup-value=setpoint]')).toContainText('0.8');

    await page.locator('[data-setup-group=mode] [data-setup-option=tec]').check();
    await expect(page.locator('[data-setup-stepper=helium]')).toBeVisible();
    await page.locator('[data-setup-group=mode] [data-setup-option=ccr]').check();

    await expect(page.locator('[data-setup-value=setpoint]')).toContainText('0.8');
    await expect(page.locator('[data-setup-diluent=tx10-70]')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('a diluent button keeps focus across the re-render it triggers', async ({ page }) => {
    // The class PR #177 fixed for the steppers and PR #178 for the tank
    // buttons; focusKeyOf has to learn each new control or keyboard
    // activation drops focus to <body> after one press.
    await toCcr(page);
    const button = page.locator('[data-setup-diluent=tx21-35]');
    await button.focus();
    await page.keyboard.press('Enter');

    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await expect(button).toBeFocused();
  });
});

test.describe('mobile viewport', () => {
  test.use(MOBILE_VIEWPORT);

  // Measured in every mode, not only the one the screen opens on. Each mode
  // renders a different set of controls — tec adds the tabs and four
  // steppers, CCR replaces the lot with the diluent buttons and its own four
  // — so measuring rec alone left two thirds of the surface unchecked, which
  // is how tec's controls went in unmeasured in the previous slice.
  for (const mode of ['rec', 'tec', 'ccr']) {
    test(`every ${mode} control meets the 44px touch target with 8px spacing`, async ({ page }) => {
      // The template is the #121 test in result-screen.spec.js, which caught
      // the legacy setup screen shipping 38-41px controls.
      await page.goto('/dist/');
      await acceptSafetyGate(page);
      if (mode !== 'rec') {
        await page
          .locator(`[data-setup-group=mode] [data-setup-option=${mode}]`)
          .check();
      }

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
          // Non-overlapping in at least one axis by 8px, or overlapping in
          // both (which only happens for a label and the control nested
          // inside it).
          const separated = gapX >= 8 || gapY >= 8 || (gapX < 0 && gapY < 0);
          expect(separated, `controls ${i} and ${j} are too close`).toBe(true);
        }
      }
    });
  }

  test('the dive can be started by touch alone', async ({ page }) => {
    await page.goto('/dist/');
    await startDive(page, async (target) => {
      await target.locator('[data-setup-preset=ean32]').tap();
    });
    await expect(page.locator('[data-renderer=pixi] canvas')).toBeVisible();
  });
});
