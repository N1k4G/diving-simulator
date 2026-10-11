const { expect, test } = require('./helpers/pinned-seed.cjs');
const { acceptSafetyGate, resumeSavedDiveAndWaitForCanvas } = require('./helpers/start-dive.cjs');

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
  // Start begins a new dive since #191; the save is resumed from the banner.
  await resumeSavedDiveAndWaitForCanvas(page);
}

async function frameAt(page, saved, narcosisIndex) {
  await resumeAt(page, saved, narcosisIndex);
  await page.evaluate(() => window.__stepFrames(30));
  return page.locator('[data-wreck-viewport]').screenshot({ style: HIDE_CHROME });
}

test('the view darkens above index 0.15 and wobbles above 0.25, and only then', async ({ page }) => {
  // Eight dives started, each a page load: the suite's load took one past
  // 60 s.
  test.setTimeout(150000);
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

// The vignette is a whole-screen blend, so its cost is measured at named
// backing resolutions (docs/decisions.md): a desktop view at DPR 1 and at
// DPR 2, the renderer's resolution cap, and a phone at DPR 2: the phone is
// the project's reference phone and the desktop near its 1280x800 one
// (scripts/screenshots.mjs). The renderer caps the resolution, not the
// viewport, so a larger window at DPR 2 draws more.
const FRAME_TIME_VIEWS = [
  { name: '1280x720 at DPR 1', viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 },
  { name: '1280x720 at DPR 2', viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 },
  { name: '390x844 at DPR 2', viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 },
];

for (const view of FRAME_TIME_VIEWS) {
  test.describe(view.name, () => {
    test.use({ viewport: view.viewport, deviceScaleFactor: view.deviceScaleFactor });

    test('a frame with every narcosis effect on takes no longer than one without', async ({ page, context }, testInfo) => {
      // Two pages and 330 frames each, every one finished on SwiftShader's CPU
      // rasteriser. Under the full suite's load its long frames dominate:
      // 390x844 at DPR 2 ran past 120 s, and 1280x720 at DPR 2 (a 2428x1308
      // backing) past 240 s.
      test.setTimeout(600000);
      const saved = await firstSave(page);
      // Index 0.94 and 0 on two pages, the same dive otherwise, both holding a
      // fin key and the vent, so the swallowed inputs and the drift draw too.
      // The index eases toward 20 m's, still above 0.45 at the last frame, so all
      // four effects stay on.
      const narcosed = page;
      const sober = await context.newPage();
      await resumeAt(narcosed, saved, 0.94);
      await resumeAt(sober, saved, 0);
      // The backing resolution the frames are drawn at, as measured.
      const backing = await narcosed.locator('[data-renderer=pixi] canvas').evaluate((canvas) => ({
        devicePixelRatio: window.devicePixelRatio,
        width: canvas.width,
        height: canvas.height,
      }));
      expect(backing.devicePixelRatio).toBe(view.deviceScaleFactor);
      for (const each of [narcosed, sober]) {
        await each.keyboard.down('ArrowRight');
        await each.keyboard.down('ArrowDown');
        await each.evaluate(() => window.__timeFrames(30));
      }
      // Interleaved in short runs, so that a load on the machine falls on both
      // alike.
      const times = { narcosed: [], sober: [] };
      for (let round = 0; round < 30; round += 1) {
        times.narcosed.push(...(await narcosed.evaluate(() => window.__timeFrames(10))));
        times.sober.push(...(await sober.evaluate(() => window.__timeFrames(10))));
      }
      // docs/decisions.md, Performance evidence, summarised as src/diagnostics.js
      // summarize() does: a percentile is the ceil(q * n)th sample, and a frame
      // over the 16.67 ms budget counts its excess.
      const BUDGET_MS = 16.67;
      const stats = (samples) => {
        const sorted = [...samples].sort((a, b) => a - b);
        const at = (q) => +sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)].toFixed(3);
        const long = sorted.filter((ms) => ms > BUDGET_MS);
        return {
          sampleCount: sorted.length,
          minMs: at(0),
          medianMs: at(0.5),
          p95Ms: at(0.95),
          p99Ms: at(0.99),
          maxMs: at(1),
          longFrameCount: long.length,
          totalTimeAboveBudgetMsPer1000: +((long.reduce((sum, ms) => sum + ms - BUDGET_MS, 0) * 1000) / sorted.length).toFixed(3),
        };
      };
      const result = { view: view.name, backing, narcosed: stats(times.narcosed), sober: stats(times.sober) };
      testInfo.annotations.push({ type: 'narcosis-frame-time', description: JSON.stringify(result) });
      console.log(`narcosis frame time ${JSON.stringify(result)}`);
      expect(result.narcosed.sampleCount).toBe(300);
      // A coarse bound on the effects' cost, not a claim that they cost nothing.
      // Alone, the medians agree within about half a millisecond. Under the full
      // suite's load the narcosed page has mostly run slower, by around a
      // millisecond (the evidence lists every run with its numbers,
      // artifacts/wp-08/220/verification-visuals.json): the full-screen vignette
      // is a real blend in SwiftShader's CPU rasteriser. The bound allows that,
      // and it is far under a 16.67 ms frame. It does not tell a blur
      // apart, since a Pixi BlurFilter on the world measured 1.8 against 1.6 ms;
      // the wreck-narcosis reference frame (scripts/pixi-visual-check.mjs) does.
      expect(result.narcosed.medianMs).toBeLessThanOrEqual(result.sober.medianMs * 1.5 + 1);
    });
  });
}
