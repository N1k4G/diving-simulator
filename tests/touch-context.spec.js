const { expect, test } = require('./helpers/pinned-seed.cjs');
const { acceptSafetyGate, descendTo } = require('./helpers/start-dive.cjs');

// The touch context group (#168 PR 2): legacy's touch-dive group
// (src/touch.js, src/diving-simulator.html #touch-dive) — the cylinders, gas
// information, fast-forward, the torch, the setpoint and bailout, and help.
//
// Legacy binds each of them to touchstart, which every finger sends, so a
// thumb can hold the D-pad while another finger works them. A browser sends
// a click only for a lone tap; these cases hold a direction with one finger
// and press each control with a second, through the DevTools protocol, and
// read the dive to see that the press took. On main, which pressed these
// buttons by click alone, none of them did. The geometry cases apply the #121
// rule (tests/result-screen.spec.js) to every control of the group at once,
// overlap included.

const SAVE_KEY = 'diving-simulator.save-game';

const PHONE = {
  hasTouch: true,
  isMobile: true,
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1',
};

const pad = (page, control) => page.locator(`.wreck-controls [data-control="${control}"]`);
const hudValue = (page, name) => page.locator(`.wreck-hud [data-hud-metric="${name}"] dd`);
const torch = (page) => page.locator('[data-torch]');
const fastForward = (page) => page.locator('[data-fast-forward]');
const gasInfoToggle = (page) => page.locator('[data-gas-info-toggle]');

const persistedSave = (page) =>
  page
    .waitForFunction((key) => {
      const raw = window.localStorage.getItem(key);
      const saved = raw === null ? null : JSON.parse(raw);
      return saved !== null && saved.state.elapsedTimeS > 0 ? saved : null;
    }, SAVE_KEY)
    .then((handle) => handle.jsonValue());

/** The first autosave written after this call, so one that saw every press before it. */
async function nextSave(page) {
  const now = await page.evaluate(() => Date.now());
  const handle = await page.waitForFunction(
    ([key, after]) => {
      const saved = JSON.parse(window.localStorage.getItem(key) ?? 'null');
      return saved !== null && saved.savedAtEpochMs > after ? saved : null;
    },
    [SAVE_KEY, now],
    { timeout: 15_000 },
  );
  return handle.jsonValue();
}

/**
 * A hand on the screen, sent as touch through the DevTools protocol: each
 * event lists every finger down, as a phone's do. The protocol's touchEnd
 * lifts every finger at once, in the order they went down, so a thumb and a
 * second finger lift together, the thumb first. The page still sees what a
 * phone sends for a second finger: its pointer is not the primary one, and
 * no click follows its tap.
 */
async function hand(page) {
  const cdp = await page.context().newCDPSession(page);
  const down = new Map();
  const send = (type, touchPoints) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
  return {
    async down(id, locator) {
      const box = await locator.boundingBox();
      expect(box, 'the control has a box to touch').not.toBeNull();
      down.set(id, { x: box.x + box.width / 2, y: box.y + box.height / 2, id });
      await send('touchStart', [...down.values()]);
    },
    async moveTo(id, point) {
      down.set(id, { ...point, id });
      await send('touchMove', [...down.values()]);
    },
    async liftAll() {
      down.clear();
      await send('touchEnd', []);
    },
    async cancelAll() {
      down.clear();
      await send('touchCancel', []);
    },
  };
}

/**
 * Holds left with a thumb and taps `control` with a second finger. Left is
 * held while both are down, and let go once they lift.
 */
async function pressWithThumbOnPad(page, control) {
  const touch = await hand(page);
  await touch.down(1, pad(page, 'left'));
  await touch.down(2, control);
  await expect(pad(page, 'left')).toHaveAttribute('data-held', 'true');
  await touch.liftAll();
  await expect(pad(page, 'left')).not.toHaveAttribute('data-held', /.*/);
}

async function setUpDive(page, mode, tanksToAdd = 0) {
  await page.goto('/dist/');
  await page.evaluate(() => window.localStorage.clear());
  await acceptSafetyGate(page);
  await page.locator(`[data-setup-group=mode] [data-setup-option=${mode}]`).check();
  for (let i = 0; i < tanksToAdd; i += 1) await page.locator('[data-setup-tank-add]').click();
  await page.locator('[data-start-dive]').click();
  await page.locator('[data-renderer=pixi] canvas').waitFor();
  await descendTo(page, 1);
}

/**
 * A dive in `mode` resumed at 5 m with its safety stop under way, so every
 * control of the group is on screen at once: fast-forward is offered there.
 * Neutral at 5 m (src/core/buoyancy.ts neutralBcdSurfaceLitres), the diver
 * stays in the stop's band.
 */
async function resumeAtSafetyStop(page, mode, tanksToAdd = 0) {
  await setUpDive(page, mode, tanksToAdd);
  const saved = await persistedSave(page);
  const pressureBar = 1 + 5 / 10;
  Object.assign(saved.state, {
    depthM: 5,
    maxDepthM: 20,
    verticalVelocityMpm: 0,
    bcdGasSurfaceLiters: (7 + 2 - 3 - 5 * Math.pow(1 / pressureBar, 0.7)) * pressureBar,
    safetyStop: { needed: true, countdownStarted: true, remainingS: 172, paused: false, complete: false },
  });
  await page.goto('/dist/');
  await page.evaluate(([key, value]) => window.localStorage.setItem(key, value), [SAVE_KEY, JSON.stringify(saved)]);
  await page.locator('[data-accept-safety]').click();
  await page.locator('.setup-screen').waitFor();
  await page.locator('[data-resume-continue]').click();
  await page.locator('[data-renderer=pixi] canvas').waitFor();
  await expect(fastForward(page)).toBeVisible();
}

test.describe('a second finger, with a thumb on the D-pad', () => {
  test.use({ viewport: { width: 390, height: 844 }, ...PHONE });

  test('works the torch, a cylinder and the gas information, once each', async ({ page }) => {
    await setUpDive(page, 'tec', 1);
    await expect(page.locator('[data-tank]')).toHaveCount(2);
    await expect(torch(page)).toHaveAttribute('aria-pressed', 'true');

    await pressWithThumbOnPad(page, torch(page));
    await expect(torch(page)).toHaveAttribute('aria-pressed', 'false');
    await pressWithThumbOnPad(page, page.locator('[data-tank="1"]'));
    await expect(page.locator('[data-tank="1"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(hudValue(page, 'cylinder')).toContainText('2 ·');
    await pressWithThumbOnPad(page, gasInfoToggle(page));
    await expect(page.locator('[data-gas-info]')).toBeVisible();

    // One press each: the torch is still off, the cylinder still the second.
    await expect(torch(page)).toHaveAttribute('aria-pressed', 'false');
    const saved = await nextSave(page);
    expect(saved.state.activeTankIndex).toBe(1);
  });

  test('works fast-forward at a stop', async ({ page }) => {
    await resumeAtSafetyStop(page, 'rec');
    await pressWithThumbOnPad(page, fastForward(page));
    await expect(fastForward(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-fast-forward-indicator]')).toBeVisible();
  });

  test('moves the setpoint once per tap and bails out', async ({ page }) => {
    await setUpDive(page, 'ccr');
    await expect(hudValue(page, 'setpoint')).toHaveText('0.70 bar');
    await pressWithThumbOnPad(page, page.locator('[data-setpoint="increase"]'));
    await expect(hudValue(page, 'setpoint')).toHaveText('0.80 bar');
    await pressWithThumbOnPad(page, page.locator('[data-bailout]'));
    await expect(hudValue(page, 'cylinder')).toHaveText('Bailout · diluent cylinder');
    const saved = await nextSave(page);
    expect(saved.state.ccr.targetPo2Bar).toBe(0.8);
    expect(saved.state.ccr.onBailout).toBe(true);
  });

  test('opens the help', async ({ page }) => {
    await setUpDive(page, 'rec');
    await pressWithThumbOnPad(page, page.locator('[data-help-open]'));
    await expect(page.locator('[data-help-overlay]')).toHaveAttribute('open', '');
  });

  test('toggles the instructor panel once per tap (#160)', async ({ page }) => {
    await setUpDive(page, 'rec');
    const learn = page.locator('[data-instructor-toggle]');
    await pressWithThumbOnPad(page, learn);
    await expect(learn).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-instructor-panel]')).toBeVisible();
    await pressWithThumbOnPad(page, learn);
    await expect(learn).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('[data-instructor-panel]')).toBeHidden();
  });
});

test.describe('one finger', () => {
  test.use({ viewport: { width: 390, height: 844 }, ...PHONE });

  test('a tap presses once; a touch slid off or cancelled presses nothing', async ({ page }) => {
    await setUpDive(page, 'ccr');
    const touch = await hand(page);
    // The touch's own press and the click a lone tap also sends count once.
    await touch.down(1, page.locator('[data-setpoint="increase"]'));
    await touch.liftAll();
    await expect(hudValue(page, 'setpoint')).toHaveText('0.80 bar');

    // Bailout cannot be undone and asks for no confirmation (#67): a finger
    // that slides off it before lifting has not pressed it, as a click is
    // not sent for a tap that left its button.
    const bailout = page.locator('[data-bailout]');
    const box = await page.locator('[data-wreck-viewport]').boundingBox();
    await touch.down(1, bailout);
    await touch.moveTo(1, { x: box.x + box.width / 2, y: box.y + box.height / 3 });
    await touch.liftAll();
    await touch.down(1, bailout);
    await touch.cancelAll();
    // The next autosave has the dive still on the loop at 0.80.
    const later = await nextSave(page);
    expect(later.state.ccr.onBailout).toBe(false);
    expect(later.state.ccr.targetPo2Bar).toBe(0.8);
    await expect(hudValue(page, 'cylinder')).toHaveText('Rebreather loop');
    await expect(bailout).toBeVisible();
  });
});

test('a click and Enter on the focused button each press once', async ({ page }) => {
  await setUpDive(page, 'ccr');
  const raise = page.locator('[data-setpoint="increase"]');
  await raise.click();
  await expect(hudValue(page, 'setpoint')).toHaveText('0.80 bar');
  await raise.focus();
  await page.keyboard.press('Enter');
  await expect(hudValue(page, 'setpoint')).toHaveText('0.90 bar');
});

// Legacy's harness case "CCR — Bailout/SP+/SP- buttons present in
// #touch-dive" (src/diving-simulator-tests.html): the loop's three buttons
// sit in the dive's controls. Here each group is named, as a group, and
// every control names the key that does the same.
test('the groups are named and every control names its key', async ({ page }) => {
  await resumeAtSafetyStop(page, 'ccr');
  const loop = page.getByRole('group', { name: 'Rebreather controls' });
  await expect(loop.getByRole('button')).toHaveCount(3);
  await expect(loop.getByRole('button', { name: 'Lower the setpoint' })).toHaveAttribute('aria-keyshortcuts', '[');
  await expect(loop.getByRole('button', { name: 'Raise the setpoint' })).toHaveAttribute('aria-keyshortcuts', ']');
  await expect(loop.getByRole('button', { name: /^Bail out/ })).toHaveAttribute('aria-keyshortcuts', 'B');
  const dive = page.getByRole('group', { name: 'Dive controls' });
  await expect(dive.getByRole('button', { name: 'Toggle torch' })).toHaveAttribute('aria-keyshortcuts', 'T');
  await expect(dive.getByRole('button', { name: 'Fast-forward at the stop' })).toHaveAttribute('aria-keyshortcuts', 'F');
  await expect(gasInfoToggle(page)).toHaveAttribute('aria-keyshortcuts', 'I');
  await expect(page.locator('[data-help-open]')).toHaveAttribute('aria-keyshortcuts', 'H');

  await setUpDive(page, 'tec', 1);
  const cylinders = page.getByRole('group', { name: 'Cylinders' });
  await expect(cylinders.getByRole('button')).toHaveCount(2);
  await expect(cylinders.getByRole('button').nth(1)).toHaveAttribute('aria-keyshortcuts', '2');
});

/**
 * Every control of the group on screen, at least 44 x 44, and at least 8 px
 * from every other control on the dive screen, the D-pad included. Overlap
 * counts, which the #121 test skips.
 */
async function measureGroup(page) {
  return page.evaluate(() => {
    const context = (element) =>
      element.closest('.wreck-dock, .topbar-actions') !== null ||
      element.matches('[data-torch], [data-fast-forward], [data-instructor-toggle]');
    const all = [...document.querySelectorAll('.wreck-shell button')]
      .filter((element) => element.getClientRects().length > 0)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          label: element.getAttribute('aria-label') ?? element.textContent,
          context: context(element),
          x: rect.x,
          y: rect.y,
          w: rect.width,
          h: rect.height,
        };
      });
    const viewport = { w: window.innerWidth, h: window.innerHeight };
    const group = all.filter((box) => box.context);
    const problems = [];
    for (const box of group) {
      if (Math.round(box.w) < 44 || Math.round(box.h) < 44) {
        problems.push(`${box.label} is ${Math.round(box.w)}x${Math.round(box.h)}`);
      }
      if (box.x < 0 || box.y < 0 || box.x + box.w > viewport.w || box.y + box.h > viewport.h) {
        problems.push(`${box.label} is off screen`);
      }
      for (const other of all) {
        if (other === box || (other.context && all.indexOf(other) < all.indexOf(box))) continue;
        const gapX = Math.max(box.x, other.x) - Math.min(box.x + box.w, other.x + other.w);
        const gapY = Math.max(box.y, other.y) - Math.min(box.y + box.h, other.y + other.h);
        const apart = Math.max(gapX, gapY);
        if (apart < 8) problems.push(`${box.label} <-> ${other.label} = ${apart.toFixed(1)}px`);
      }
    }
    return { labels: group.map((box) => box.label), problems };
  });
}

// The two modes that show the most controls at once: six cylinders on a
// technical dive, and the loop's row on a rebreather; each at a safety stop,
// where fast-forward joins them. Portrait phones and a desktop. Landscape is
// #256; 320 px is #258.
const MODES = [
  // Six cylinders, torch, fast-forward, gas information, the instructor
  // panel's L (legacy's touch-dive-learn, #160), help, mute.
  { mode: 'tec', tanksToAdd: 5, count: 12 },
  // Setpoint down and up, bailout, torch, fast-forward, gas information, L, help, mute.
  { mode: 'ccr', tanksToAdd: 0, count: 9 },
];
for (const [width, height, device] of [
  [390, 844, PHONE],
  [360, 640, PHONE],
  [1280, 720, {}],
]) {
  test.describe(`${width}x${height}`, () => {
    test.use({ viewport: { width, height }, ...device });

    for (const { mode, tanksToAdd, count } of MODES) {
      test(`every ${mode} context control meets 44px and stands 8px clear of every control`, async ({ page }) => {
        await resumeAtSafetyStop(page, mode, tanksToAdd);
        const measured = await measureGroup(page);
        expect(measured.labels, 'the context controls on screen').toHaveLength(count);
        expect(measured.problems).toEqual([]);
      });
    }
  });
}
