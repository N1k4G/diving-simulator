const { expect, test } = require('./helpers/pinned-seed.cjs');
const { descendTo, startDiveAndWaitForCanvas } = require('./helpers/start-dive.cjs');

// The page in the background (#137 A5, A9). On a phone a page sent to the
// background may be discarded without a pagehide, so the dive is saved as it
// goes and stands still until the diver is back; the controls held as it
// went are let go; the help's own pause outlasts the trip; and the screen is
// kept on only while the dive is on screen and the page is visible.
//
// Headless Chromium cannot be sent to the background, so the page is told it
// is hidden the way it would learn it: document.visibilityState and a
// visibilitychange event.

const SAVE_KEY = 'diving-simulator.save-game';
const hudValue = (page, name) => page.locator(`.wreck-hud [data-hud-metric="${name}"] dd`);
const savedState = (page) => page.evaluate((key) => JSON.parse(window.localStorage.getItem(key)).state, SAVE_KEY);

/** Tells the page it is hidden or visible, as a browser does. */
function setHidden(page, hidden) {
  return page.evaluate((hidden) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

/** A Screen Wake Lock API that records what is asked of it, as an init script. */
function recordWakeLock() {
  const log = [];
  window.__wakeLockLog = log;
  Object.defineProperty(navigator, 'wakeLock', {
    configurable: true,
    value: {
      request: (type) => {
        log.push(`request:${type}`);
        const listeners = [];
        const sentinel = {
          released: false,
          addEventListener: (_type, listener) => listeners.push(listener),
          release: () => {
            if (!sentinel.released) {
              sentinel.released = true;
              log.push('release');
              listeners.forEach((listener) => listener());
            }
            return Promise.resolve();
          },
        };
        return Promise.resolve(sentinel);
      },
    },
  });
}

const wakeLockLog = (page) => page.evaluate(() => [...window.__wakeLockLog]);

/** Every AudioContext the page makes, as an init script, for its state. */
function recordAudioContexts() {
  const contexts = [];
  window.__audioContexts = contexts;
  const Native = window.AudioContext;
  window.AudioContext = class extends Native {
    constructor(...args) {
      super(...args);
      contexts.push(this);
    }
  };
}

const audioStates = (page) => page.evaluate(() => window.__audioContexts.map((context) => context.state));

function collectConsoleErrors(page) {
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

test('hidden, the dive is saved and stands still; visible again, it runs on', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await page.goto('/dist/');
  await startDiveAndWaitForCanvas(page);
  await descendTo(page, 2);

  // The save is written as the page goes, not by the next autosave.
  const written = await page.evaluate((key) => {
    window.localStorage.removeItem(key);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
    return window.localStorage.getItem(key);
  }, SAVE_KEY);
  expect(written).not.toBeNull();
  const atHide = JSON.parse(written).state;
  expect(atHide.elapsedTimeS).toBeGreaterThan(0);

  // Past an autosave interval: no dive time passes and nothing is saved over it.
  const time = await hudValue(page, 'time').textContent();
  await page.waitForTimeout(3500);
  await expect(hudValue(page, 'time')).toHaveText(time);
  expect((await savedState(page)).elapsedTimeS).toBe(atHide.elapsedTimeS);

  await setHidden(page, false);
  await expect(hudValue(page, 'time')).not.toHaveText(time);
  await expect.poll(async () => (await savedState(page)).elapsedTimeS, { timeout: 10_000 })
    .toBeGreaterThan(atHide.elapsedTimeS);
  // The wake lock's request, granted or refused by headless Chromium, logs nothing.
  expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
});

test('the help open across a trip to the background keeps the dive paused until it is closed', async ({ page }) => {
  await page.goto('/dist/');
  await startDiveAndWaitForCanvas(page);
  await descendTo(page, 2);

  await page.keyboard.press('h');
  await expect(page.getByRole('dialog', { name: 'Controls' })).toBeVisible();
  const time = await hudValue(page, 'time').textContent();
  await setHidden(page, true);
  await setHidden(page, false);
  await page.waitForTimeout(1500);
  await expect(hudValue(page, 'time')).toHaveText(time);

  await page.keyboard.press('Escape');
  await expect(hudValue(page, 'time')).not.toHaveText(time);
});

test('a D-pad direction and a key held as the page goes are let go, and stay let go once it is back', async ({ page }) => {
  await page.goto('/dist/');
  await startDiveAndWaitForCanvas(page);
  await descendTo(page, 2);
  const ascend = page.locator('.wreck-controls [data-control="ascend"]');
  const box = await ascend.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  // D, not W: the D-pad lets go of its own direction, which W shares.
  await page.keyboard.down('d');
  await expect(ascend).toHaveAttribute('data-held', 'true');

  // A hidden page may never receive the pointerup or the keyup.
  await setHidden(page, true);
  await expect(ascend).not.toHaveAttribute('data-held', /.*/);
  await setHidden(page, false);

  // Both still down, neither acts: the BCD's gas, which only inflate and vent
  // change, and the route position, which only A and D change, are the same
  // in two autosaves 3 s apart.
  const saved = () => page.evaluate((key) => {
    const save = JSON.parse(window.localStorage.getItem(key));
    return { bcd: save.state.bcdGasSurfaceLiters, routePositionM: save.session.routePositionM };
  }, SAVE_KEY);
  await page.waitForTimeout(3500);
  const first = await saved();
  await page.waitForTimeout(3500);
  expect(await saved()).toEqual(first);
  await expect(ascend).not.toHaveAttribute('data-held', /.*/);
  await page.keyboard.up('d');
  await page.mouse.up();
});

test('the screen wake lock is held while the dive is on screen and visible, and let go otherwise', async ({ page }) => {
  await page.addInitScript(recordWakeLock);
  const log = () => wakeLockLog(page);
  await page.goto('/dist/');
  await page.locator('[data-accept-safety]').click();
  await page.locator('.setup-screen').waitFor();
  // Not on the screens before the dive.
  expect(await log()).toEqual([]);
  await page.locator('[data-start-dive]').click();
  await page.locator('[data-renderer=pixi] canvas').waitFor();
  await expect.poll(log).toEqual(['request:screen']);

  await setHidden(page, true);
  await expect.poll(log).toEqual(['request:screen', 'release']);
  await setHidden(page, false);
  await expect.poll(log).toEqual(['request:screen', 'release', 'request:screen']);

  // The dive leaves the screen with the page: the lock goes with it.
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  await expect.poll(log).toEqual(['request:screen', 'release', 'request:screen', 'release']);
});

test('a dive that finishes loading behind another tab starts in the background: saved, paused, silent, no wake lock; shown, it runs (#276 Codex round 1)', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await page.addInitScript(recordWakeLock);
  await page.addInitScript(recordAudioContexts);
  await page.goto('/dist/');
  await page.evaluate(() => window.localStorage.clear());
  await page.locator('[data-accept-safety]').click();
  await page.locator('.setup-screen').waitFor();
  // Hidden before Start is pressed, so the renderer's import and the dive's
  // start finish in the background, deterministically: the page is already
  // hidden when the dive starts watching it.
  await setHidden(page, true);
  await page.locator('[data-start-dive]').click();
  await page.locator('[data-renderer=pixi] canvas').waitFor();

  // Saved as it went to the background, and nothing saved after: no frame
  // hands the autosave a state while it is paused.
  const saved = () => page.evaluate((key) => window.localStorage.getItem(key), SAVE_KEY);
  const written = await saved();
  expect(written).not.toBeNull();
  // Paused: S, held, does not begin the dive.
  await page.keyboard.down('s');
  await page.waitForTimeout(3500);
  await page.keyboard.up('s');
  await expect(page.locator('[data-surface-prompt]')).toBeVisible();
  expect(await saved()).toBe(written);
  // Silent, and the screen is not kept on for a page nobody sees.
  expect(await audioStates(page)).not.toEqual([]);
  await expect.poll(() => audioStates(page)).not.toContain('running');
  expect(await wakeLockLog(page)).toEqual([]);

  await setHidden(page, false);
  await expect.poll(() => wakeLockLog(page)).toEqual(['request:screen']);
  await expect.poll(() => audioStates(page)).toContain('running');
  await page.keyboard.down('s');
  await expect(page.locator('[data-surface-prompt]')).toBeHidden();
  await page.keyboard.up('s');
  expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
});
