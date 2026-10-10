const { expect, test } = require('./helpers/pinned-seed.cjs');
const { acceptSafetyGate } = require('./helpers/start-dive.cjs');

// Narcosis on the view (#220): the tunnel vision above index 0.15 and the
// wobble above 0.25, neither below, the wobble not under
// prefers-reduced-motion, and the frame time with every effect on no worse
// than without. Each dive resumes from its own first save, moved to 20 m
// five minutes in, neutral there, at the index under test, with its frames
// stepped by hand as scripts/pixi-visual-check.mjs steps them.

const SAVE_KEY = 'diving-simulator.save-game';
// The shell's chrome, hidden so a frame holds only the renderer's output.
const HIDE_CHROME = '.wreck-shell > :not([data-wreck-viewport]) { visibility: hidden !important; }';

const PIN_FRAMES = () => {
  const realNow = performance.now.bind(performance);
  let now = 0;
  let queue = [];
  window.requestAnimationFrame = (callback) => queue.push(callback);
  window.cancelAnimationFrame = () => {};
  window.performance.now = () => now;
  window.__stepFrames = (frames) => {
    for (let i = 0; i < frames; i += 1) {
      now += 1000 / 60;
      const due = queue;
      queue = [];
      for (const callback of due) callback(now);
    }
  };
  // One frame's real time, the GPU's work included: finish() waits for it.
  window.__timeFrames = (frames) => {
    const canvas = document.querySelector('[data-wreck-viewport] canvas');
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    const times = [];
    for (let i = 0; i < frames; i += 1) {
      const start = realNow();
      window.__stepFrames(1);
      gl.finish();
      times.push(realNow() - start);
    }
    return times;
  };
};

/** The surface save of a fresh dive, on the platform's clock. */
async function firstSave(page) {
  await page.goto('/dist/');
  await page.evaluate(() => window.localStorage.clear());
  await acceptSafetyGate(page);
  await page.locator('[data-start-dive]').click();
  await page.locator('[data-renderer=pixi] canvas').waitFor();
  const handle = await page.waitForFunction((key) => {
    const raw = window.localStorage.getItem(key);
    return raw === null ? null : JSON.parse(raw);
  }, SAVE_KEY);
  return handle.jsonValue();
}

const pinned = new WeakSet();

/** Resumes `saved` at `narcosisIndex` on `page`, its frames pinned. */
async function resumeAt(page, saved, narcosisIndex) {
  if (!pinned.has(page)) {
    pinned.add(page);
    await page.addInitScript(PIN_FRAMES);
  }
  const state = {
    ...saved.state,
    elapsedTimeS: 300,
    depthM: 20,
    maxDepthM: 20,
    verticalVelocityMpm: 0,
    bcdGasSurfaceLiters: 11.05,
    narcosisIndex,
  };
  await page.goto('/dist/');
  await page.evaluate(([key, value]) => window.localStorage.setItem(key, value), [SAVE_KEY, JSON.stringify({ ...saved, state })]);
  await acceptSafetyGate(page);
  await page.locator('[data-start-dive]').click();
  await page.locator('[data-renderer=pixi] canvas').waitFor();
}

async function frameAt(page, saved, narcosisIndex) {
  await resumeAt(page, saved, narcosisIndex);
  await page.evaluate(() => window.__stepFrames(30));
  return page.locator('[data-wreck-viewport]').screenshot({ style: HIDE_CHROME });
}

test('the view darkens above index 0.15 and wobbles above 0.25, and only then', async ({ page }) => {
  const saved = await firstSave(page);
  const sober = await frameAt(page, saved, 0);
  expect((await frameAt(page, saved, 0)).equals(sober), 'the same dive renders the same frame').toBe(true);
  expect((await frameAt(page, saved, 0.14)).equals(sober), 'nothing below 0.15').toBe(true);

  // Under reduced motion the view does not wobble, so a frame that differs
  // with it from one without it wobbles.
  const wobbles = async (index) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const still = await frameAt(page, saved, index);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const moving = await frameAt(page, saved, index);
    return { still, moving, wobbled: !moving.equals(still) };
  };
  const tunnel = await wobbles(0.24);
  expect(tunnel.still.equals(sober), 'the edges darken above 0.15').toBe(false);
  expect(tunnel.wobbled, 'no wobble at 0.24').toBe(false);
  expect((await wobbles(0.4)).wobbled, 'a wobble at 0.4').toBe(true);
});

test('a frame with every narcosis effect on takes no longer than one without', async ({ page, context }, testInfo) => {
  test.setTimeout(120000);
  const saved = await firstSave(page);
  // Index 0.94 and 0 on two pages, the same dive otherwise, both holding a
  // fin key and the vent, so the swallowed inputs and the drift draw too.
  // The index eases toward 20 m's, still above 0.45 at the last frame, so all
  // four effects stay on.
  const narcosed = page;
  const sober = await context.newPage();
  await resumeAt(narcosed, saved, 0.94);
  await resumeAt(sober, saved, 0);
  for (const each of [narcosed, sober]) {
    await each.keyboard.down('ArrowRight');
    await each.keyboard.down('ArrowDown');
    await each.evaluate(() => window.__timeFrames(30));
  }
  // Interleaved, so that a load on the machine falls on both alike.
  const times = { narcosed: [], sober: [] };
  for (let round = 0; round < 6; round += 1) {
    times.narcosed.push(...(await narcosed.evaluate(() => window.__timeFrames(50))));
    times.sober.push(...(await sober.evaluate(() => window.__timeFrames(50))));
  }
  const stats = (samples) => {
    const sorted = [...samples].sort((a, b) => a - b);
    const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    return { samples: sorted.length, medianMs: +at(0.5).toFixed(3), p95Ms: +at(0.95).toFixed(3), maxMs: +at(1).toFixed(3) };
  };
  const result = { narcosed: stats(times.narcosed), sober: stats(times.sober) };
  testInfo.annotations.push({ type: 'narcosis-frame-time', description: JSON.stringify(result) });
  console.log(`narcosis frame time ${JSON.stringify(result)}`);
  expect(result.narcosed.samples).toBe(300);
  // A per-frame filter or gradient, legacy's way, costs a multiple of a
  // frame; one sprite and an offset cost nothing measurable. The margin
  // absorbs a loaded machine.
  expect(result.narcosed.medianMs).toBeLessThanOrEqual(result.sober.medianMs * 1.25 + 0.5);
});
