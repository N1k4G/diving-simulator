const { expect, test } = require('./helpers/pinned-seed.cjs');
const { acceptSafetyGate, descendTo } = require('./helpers/start-dive.cjs');

// Which controls the dive screen shows, state by state and mode by mode
// (#168 PR 3), against legacy's src/touch.js: updateCcrDiveButtonVisibility()
// (206-225), updateNavPadVisibility() (233-242) and touchUpdateUI() (245-324),
// with src/diving-simulator.html's #touch-ui (12-56).
//
// Each row of TABLE is what legacy shows on a touch screen, with the line
// that shows it, and the departures recorded in docs/decisions.md ("#168,
// PR 3") that turn it into what this client shows. The migration shows the
// same on a phone and on a desktop: legacy's desktop shows the pad while
// diving (touch.js 238-241) and its context group only on a rebreather while
// the loop is breathed (221-225), a departure recorded with #168 PR 2.
//
// Every control is read three ways: 'shown' (drawn, and focus reaches it),
// 'hidden' (not drawn, and focus cannot reach it), 'inert' (drawn under a
// modal dialog, which focus cannot leave); 'absent' off the dive screen.

const SAVE_KEY = 'diving-simulator.save-game';

const PHONE = {
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1',
};
const DESKTOP = { viewport: { width: 1280, height: 720 } };

const CONTROLS = {
  ascend: '.wreck-controls [data-control="ascend"]',
  descend: '.wreck-controls [data-control="descend"]',
  left: '.wreck-controls [data-control="left"]',
  right: '.wreck-controls [data-control="right"]',
  torch: '[data-torch]',
  fastForward: '[data-fast-forward]',
  cylinders: '[data-wreck-tanks]',
  gasInfo: '[data-gas-info-toggle]',
  help: '.wreck-topbar [data-help-open]',
  loop: '[data-wreck-ccr]',
  learn: '[data-instructor-toggle]',
  mute: '.audio-control',
  // Not a control: the topbar's "» ×10" (#163, #269). Legacy has no
  // counterpart; its fast-forward button lights up instead (touch.js 295-296).
  speed: '[data-fast-forward-indicator]',
};
const NAMES = Object.keys(CONTROLS);
const PAD = ['ascend', 'descend', 'left', 'right'];

/**
 * Legacy's #touch-dive group while `gameState === 'diving'` (touch.js 257-305),
 * with the pad (236) and the loop's buttons (206-214).
 */
function legacyDiving(mode, { atStop = false, bailedOut = false } = {}) {
  return [
    ...PAD, // 236: 'diving', no help over it
    'help', // html 25, in #touch-dive (258)
    'learn', // html 27, in #touch-dive (258)
    'torch', // 299-300: the site has an overhead; the wreck has
    // 261: tankCount > 1. Two cylinders on the technical dive here; one on a
    // recreational dive, and a rebreather has one (state.js 712).
    ...(mode === 'tec' ? ['cylinders'] : []),
    ...(mode === 'rec' ? [] : ['gasInfo']), // 284: isAdvanced() || ccr
    // 289-294: at a deco or safety stop, and stationary (the PR 2 departure).
    ...(atStop ? ['fastForward'] : []),
    ...(mode === 'ccr' && !bailedOut ? ['loop'] : []), // 206-214: ccr, not bailed out
  ];
}

// `legacy`: legacy's set on a touch screen. `add` and `remove`: this client's
// departures from it. `modal`: drawn under a modal dialog, so inert.
const TABLE = {
  // 311-313: #touch-surface, one Descend button bound to S (186); the pad is
  // 'diving' only (236). Added: ↓ is that button. Help, as H opens the help
  // here (state.js 164), so a touch reaches what the keyboard reaches; mute
  // has no legacy counterpart and stands in the topbar throughout.
  surface: { legacy: () => ['descend'], add: ['help', 'mute'] },
  // 257-305, at depth.
  diving: { legacy: (mode) => legacyDiving(mode), add: ['mute'] },
  // Begun and back at 0 m, the dive not ended: legacy stays in 'diving' until
  // game-loop.js 1022 ends it, so all of the above. Info was hidden here under
  // 0.5 m until #168 PR 3.
  divingAtSurface: { legacy: (mode) => legacyDiving(mode), add: ['mute'] },
  atStop: { legacy: (mode) => legacyDiving(mode, { atStop: true }), add: ['mute'] },
  // 294-296: the button stays, lit, while fast-forward runs.
  fastForward: { legacy: (mode) => legacyDiving(mode, { atStop: true }), add: ['mute', 'speed'] },
  // Legacy hides on showGasInfo (209-210, 236, 254), which nothing sets
  // (state.js 479; showHtmlGasInfo() has no caller), and never reads
  // infoPageMode, the page I opens: nothing hides (#255 pass 4).
  gasPage: { legacy: (mode) => legacyDiving(mode), add: ['mute'] },
  // 209, 236, 254: legacy hides everything under its help. Here the help is a
  // modal dialog: the controls stay drawn under its backdrop, inert, so
  // nothing moves under a thumb and focus returns to Help as it closes.
  help: { legacy: () => [], add: (mode) => [...legacyDiving(mode), 'mute'], modal: true },
  // game-loop.js 152-204: the decision and the debriefing are 'drill', which
  // no line above shows anything in. A modal dialog, as the help; Learn is
  // hidden, as L does nothing in it (state.js 194).
  drill: { legacy: () => [], add: (mode) => [...legacyDiving(mode), 'mute'], remove: ['learn'], modal: true },
  // 206-214: the loop's three buttons go; Info stays, the mode being 'ccr'.
  bailedOut: { legacy: () => legacyDiving('ccr', { atStop: true, bailedOut: true }), add: ['mute'] },
};

function expectedFor(state, mode) {
  const row = TABLE[state];
  const remove = row.remove ?? [];
  const add = typeof row.add === 'function' ? row.add(mode) : row.add;
  const shown = new Set([...row.legacy(mode), ...add].filter((name) => !remove.includes(name)));
  return Object.fromEntries(
    NAMES.map((name) => {
      if (!shown.has(name)) return [name, 'hidden'];
      return [name, row.modal && name !== 'speed' ? 'inert' : 'shown'];
    }),
  );
}

/** Each control as the page has it: drawn or not, and whether focus can reach it. */
function readControls(page) {
  return page.evaluate((controls) => {
    const result = {};
    for (const [name, selector] of Object.entries(controls)) {
      const element = document.querySelector(selector);
      if (!element) {
        result[name] = 'absent';
        continue;
      }
      const drawn = element.checkVisibility();
      const target = element.matches('button') ? element : element.querySelector('button');
      let focusable = false;
      if (target) {
        const before = document.activeElement;
        target.focus();
        focusable = document.activeElement === target;
        if (before instanceof HTMLElement && before !== document.body) before.focus();
        else target.blur();
      } else {
        focusable = drawn;
      }
      result[name] = drawn ? (focusable ? 'shown' : 'inert') : focusable ? 'hidden but focusable' : 'hidden';
    }
    return result;
  }, CONTROLS);
}

async function expectControls(page, state, mode) {
  await expect.poll(() => readControls(page), { message: `${state}, ${mode}` }).toEqual(expectedFor(state, mode));
}

async function expectNoDiveControls(page) {
  expect(await readControls(page)).toEqual(Object.fromEntries(NAMES.map((name) => [name, 'absent'])));
}

async function startDive(page, mode, { tanksToAdd = 0, drills = false } = {}) {
  await page.goto('/dist/');
  await page.evaluate(() => {
    window.localStorage.clear();
    window.localStorage.setItem('diveSim_hintsDone', '1');
  });
  await acceptSafetyGate(page);
  await page.locator(`[data-setup-group=mode] [data-setup-option=${mode}]`).check();
  for (let i = 0; i < tanksToAdd; i += 1) await page.locator('[data-setup-tank-add]').click();
  if (drills) await page.locator('[data-setup-drills]').click();
  await expectNoDiveControls(page);
  await page.locator('[data-start-dive]').click();
  await page.locator('[data-renderer=pixi] canvas').waitFor();
}

const persistedSave = (page, begun) =>
  page
    .waitForFunction(([key, mustHaveBegun]) => {
      const saved = JSON.parse(window.localStorage.getItem(key) ?? 'null');
      return saved !== null && (!mustHaveBegun || saved.state.elapsedTimeS > 0) ? saved : null;
    }, [SAVE_KEY, begun])
    .then((handle) => handle.jsonValue());

/** Neutral at `depthM` (src/core/buoyancy.ts neutralBcdSurfaceLitres), so the diver stays there. */
const neutralAt = (depthM) => {
  const pressureBar = 1 + depthM / 10;
  return (7 + 2 - 3 - 5 * Math.pow(1 / pressureBar, 0.7)) * pressureBar;
};

/**
 * Starts a dive in `mode`, takes its first autosave, edits it, and resumes
 * it, with the drills turned on if asked; `until` is what the resume opens.
 * `descend: false` takes the save written at the surface, before S.
 */
async function resumeEdited(page, mode, edit, { tanksToAdd = 0, drills = false, until, descend = true } = {}) {
  await startDive(page, mode, { tanksToAdd });
  if (descend) await descendTo(page, 1);
  const saved = await persistedSave(page, descend);
  edit(saved.state);
  await page.goto('/dist/');
  await page.evaluate(([key, value]) => window.localStorage.setItem(key, value), [SAVE_KEY, JSON.stringify(saved)]);
  await acceptSafetyGate(page);
  if (drills) await page.locator('[data-setup-drills]').click();
  await page.locator('[data-resume-continue]').click();
  await page.locator(until ?? '[data-renderer=pixi] canvas').waitFor();
}

const atSafetyStop = (state) =>
  Object.assign(state, {
    depthM: 5,
    maxDepthM: 20,
    verticalVelocityMpm: 0,
    bcdGasSurfaceLiters: neutralAt(5),
    safetyStop: { needed: true, countdownStarted: true, remainingS: 172, paused: false, complete: false },
  });

const MODES = [
  ['rec', 0],
  ['tec', 1],
  ['ccr', 0],
];

for (const [device, use] of [['phone', PHONE], ['desktop', DESKTOP]]) {
  test.describe(`on a ${device}`, () => {
    test.use(use);

    for (const [mode, tanksToAdd] of MODES) {
      test(`${mode}: the setup, the surface, under water, the gas page and the help`, async ({ page }) => {
        await startDive(page, mode, { tanksToAdd });
        await expectControls(page, 'surface', mode);

        await descendTo(page, 1);
        await expectControls(page, 'diving', mode);

        if (mode !== 'rec') {
          await page.keyboard.press('i');
          await expect(page.locator('[data-gas-info]')).toBeVisible();
          await expectControls(page, 'gasPage', mode);
          await page.keyboard.press('Escape');
          await expect(page.locator('[data-gas-info]')).toBeHidden();
        }

        // Opened by its button, so it is Help that focus returns to.
        await page.locator(CONTROLS.help).click();
        await expect(page.locator('[data-help-overlay]')).toHaveAttribute('open', '');
        await expectControls(page, 'help', mode);
        await page.keyboard.press('Escape');
        await expect(page.locator('[data-help-overlay]')).not.toHaveAttribute('open', '');
        await expect(page.locator(CONTROLS.help)).toBeFocused();
        await expectControls(page, 'diving', mode);
      });

      test(`${mode}: at a stop, with fast-forward running${mode === 'ccr' ? ', and bailed out' : ''}`, async ({ page }) => {
        await resumeEdited(page, mode, atSafetyStop, { tanksToAdd });
        await expectControls(page, 'atStop', mode);

        await page.keyboard.press('f');
        await expect(page.locator(CONTROLS.fastForward)).toHaveAttribute('aria-pressed', 'true');
        await expectControls(page, 'fastForward', mode);
        await page.keyboard.press('f');
        await expect(page.locator(CONTROLS.fastForward)).toHaveAttribute('aria-pressed', 'false');

        if (mode === 'ccr') {
          await page.keyboard.press('b');
          await expectControls(page, 'bailedOut', mode);
        }
      });
    }

    for (const mode of ['tec', 'ccr']) {
      test(`${mode}: a dive under way back at 0 m keeps every control, the gas information included`, async ({ page }) => {
        // Begun, never deeper than 2 m, so it does not end at the surface
        // (game-loop.js 1022 and the model want more), floating at 0 m.
        await resumeEdited(
          page,
          mode,
          (state) => {
            expect(state.maxDepthM).toBeLessThanOrEqual(2);
            // Light, 3 L in the BCD where 1 L is neutral, so it stays up.
            Object.assign(state, { depthM: 0, verticalVelocityMpm: 0, bcdGasSurfaceLiters: neutralAt(0) + 2 });
          },
          { tanksToAdd: mode === 'tec' ? 1 : 0 },
        );
        const depth = page.locator('.wreck-hud [data-hud-metric="depth"] dd');
        await expect(depth).toHaveText(/^0(\.0)?\s?m$/);
        await expectControls(page, 'divingAtSurface', mode);
        await page.keyboard.press('i');
        await expect(page.locator('[data-gas-info]')).toBeVisible();
        await expect(depth).toHaveText(/^0(\.0)?\s?m$/);
      });
    }

    test('rec: a drill\'s decision and debriefing leave every control inert under them, Learn hidden', async ({ page }) => {
      // Four minutes in at 20 m, where legacy's drills may fire.
      await resumeEdited(
        page,
        'rec',
        (state) =>
          Object.assign(state, { depthM: 20, maxDepthM: 20, elapsedTimeS: 240, verticalVelocityMpm: 0, bcdGasSurfaceLiters: neutralAt(20) }),
        { drills: true },
      );
      const dialog = page.locator('[data-drill-overlay]');
      await expect(dialog).toHaveAttribute('data-phase', 'overlay', { timeout: 20_000 });
      await expectControls(page, 'drill', 'rec');
      await page.keyboard.press('1');
      await expect(dialog).toHaveAttribute('data-phase', 'debrief');
      await expectControls(page, 'drill', 'rec');
      await page.keyboard.press('Enter');
      await expect(dialog).not.toHaveAttribute('open', '');
      await expectControls(page, 'diving', 'rec');
    });

    test('no dive controls on the game over or the debriefing', async ({ page }) => {
      // 315-321: legacy's touch screen shows Try again and Dive again there.
      // As tests/game-over.spec.js fails a dive: its save at the surface.
      await resumeEdited(page, 'rec', (state) => {
        state.failure.reason = 'out-of-gas';
        state.events.push({ type: 'failure', elapsedTimeS: state.elapsedTimeS, failureReason: 'out-of-gas' });
      }, { until: '[data-game-over]', descend: false });
      await expectNoDiveControls(page);
      await expect(page.locator('[data-retry]')).toBeVisible();

      // As tests/post-dive.spec.js surfaces one: light at 1 m after a dive
      // to 18 m, its stop done, it drifts up and ends on screen.
      await resumeEdited(
        page,
        'rec',
        (state) =>
          Object.assign(state, {
            elapsedTimeS: 90,
            depthM: 1,
            maxDepthM: 18,
            verticalVelocityMpm: 0,
            bcdGasSurfaceLiters: 3,
            safetyStop: { needed: true, countdownStarted: true, remainingS: 0, paused: false, complete: true },
          }),
        { until: '[data-post-dive]' },
      );
      await expectNoDiveControls(page);
      await expect(page.locator('[data-dive-again]')).toBeVisible();
      // Legacy's H opens the help on its debriefing too (game-loop.js 1252).
      await expect(page.locator('[data-post-dive] [data-help-open]')).toBeVisible();
    });
  });
}
