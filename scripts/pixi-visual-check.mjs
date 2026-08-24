// ============================================================
// FILE: scripts/pixi-visual-check.mjs
// PURPOSE: Visual regression guard for the Pixi client (issue #127).
//
//   npm run pixi:visual-check    verify against the committed references
//   npm run pixi:visual-update   re-record them, deliberately
//
// WHY THIS EXISTS
//
// `compare-rendering.mjs` gates the legacy canvas client only, so nothing
// watched the Pixi one. The worked example is the silt regression in #119:
// silt was assigned to the `terrain` layer, below `structure`, which put 31 of
// its 48 particles behind the hull's opaque fill. It passed lint, typecheck,
// unit, parity and e2e, and was found by reading the diff.
//
// WHY BOTH FRAMES AND STATISTICS
//
// Scene statistics — mean luminance, contrast, channel spread — are cheap and
// survive intentional art changes, but they cannot see an object that moved or
// vanished: silt drawn behind the hull and silt drawn correctly produce very
// similar frame-wide numbers. Reference frames catch displacement and absence.
// Statistics catch drift the reference set does not cover. Neither alone.
//
// WHY COMMITTED PNGs ARE VIABLE HERE
//
// Playwright's headless Chromium rasterises through SwiftShader — software, not
// the GPU — so captures are byte-identical across runs and across browser
// processes, which is the usual reason pixel baselines are unusable. Measured
// before building this: 0 differing bytes, same browser and fresh process.
//
// The references are decoded by loading them back into the page and drawing
// them to a 2D canvas, so the browser is the PNG decoder and this script needs
// no image dependency.
// ============================================================

import { createServer } from 'node:http';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync, statSync, createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chromium } from '@playwright/test';

const root = path.resolve(import.meta.dirname, '..');
// References are keyed by platform.
//
// The first version of this guard assumed SwiftShader made captures portable,
// because it is a software rasteriser and captures were byte-identical across
// runs and browser processes on one machine. CI disproved that immediately:
// frames recorded on win32 differed from the same scenes rendered on linux by
// a max channel delta of 230 across 10.6% of pixels — structural, not
// antialiasing noise. Deterministic per platform, not across them.
//
// Loosening the budget to absorb that would take it past the silt regression
// this guard exists to catch (delta 35), so the frames are per-platform
// instead and each environment compares against its own.
const PLATFORM = process.platform;
const referenceDir = path.join(root, 'tests', 'fixtures', 'reference-frames', 'pixi', PLATFORM);
const args = process.argv.slice(2);
const UPDATE = args.includes('--update');

function argValue(name, fallback) {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  if (!args[i + 1]) throw new Error(`missing value for ${name}`);
  return args[i + 1];
}

// Budgets, applied per scene.
//
// Captures are byte-identical on this renderer, so anything above zero is
// already slack. These sit low enough that a moved or missing object fails and
// high enough that antialiasing or a driver revision does not.
//
// Raising a threshold to make a run pass is how a visual regression ships. If a
// change is intended, re-record with --update so the diff shows the new frames.
const MAX_CHANNEL_DELTA = Number(argValue('--max-channel-delta', '24'));
const MAX_MEAN_CHANNEL_DELTA = Number(argValue('--max-mean-channel-delta', '0.35'));
const MAX_CHANGED_PIXEL_PERCENT = Number(argValue('--max-changed-pixel-percent', '1.5'));

// Statistics move for reasons a frame diff can tolerate — a global tint, a
// lighting change — so they get their own, looser budget. Absolute units:
// luminance 0-255, channel spread 0-255.
const MAX_MEAN_LUMA_DELTA = Number(argValue('--max-mean-luma-delta', '3'));
const MAX_SD_LUMA_DELTA = Number(argValue('--max-sd-luma-delta', '3'));
const MAX_CHANNEL_SPREAD_DELTA = Number(argValue('--max-channel-spread-delta', '6'));

const VIEWPORT = { width: 960, height: 540 };

// A deliberately small set. Each scene has to earn its place by exercising a
// layer the others do not.
const SCENES = [
  {
    id: 'wreck-exterior-start',
    // As mounted: backdrop, terrain, structure and foreground all visible.
    frames: 30,
  },
  {
    id: 'wreck-descended',
    // Camera travelled, so culling and marker pooling have resynced. 75 frames
    // at 60 Hz is the 1.25 s descent the e2e specs use, expressed in frames so
    // it does not depend on how fast the machine ran.
    frames: 30,
    hold: { key: 'ArrowDown', frames: 75 },
  },
  {
    id: 'wreck-torch-on',
    // The torch is a foreground element drawn over the structure layer.
    frames: 30,
    press: 't',
  },
];

// Take the clock away from the page entirely.
//
// Seeding Math.random and pinning Date.now is not enough here, and neither is
// waiting a fixed number of milliseconds. GameController.#tick takes the
// requestAnimationFrame timestamp and advances BOTH the diver's position and
// `elapsedRealS` — which drives the bubbles — by however long the frame
// actually took. Two runs of the same script therefore render different scenes,
// and the first version of this guard failed against its own freshly recorded
// references with a max channel delta of 128.
//
// So rAF is replaced by a queue that only runs when the harness says so, with a
// virtual clock advancing exactly one 60 Hz frame per step. Nothing renders
// between steps, and the same step count always produces the same frame.
const PIN_CLOCK = () => {
  let seed = 0x5eed1234;
  Math.random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };

  let virtualNow = 0;
  let queue = [];
  window.requestAnimationFrame = (callback) => queue.push(callback);
  window.cancelAnimationFrame = () => {};
  window.performance.now = () => virtualNow;
  const EPOCH = 1_735_689_600_000;
  Date.now = () => EPOCH + virtualNow;

  // Advance exactly `frames` frames. Callbacks registered during a frame run in
  // the next one, matching how rAF actually behaves.
  window.__stepFrames = (frames) => {
    for (let i = 0; i < frames; i += 1) {
      virtualNow += 1000 / 60;
      const due = queue;
      queue = [];
      for (const callback of due) callback(virtualNow);
    }
  };
};

function startServer(port) {
  const MIME = {
    '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8', '.png': 'image/png',
    '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
  };
  const server = createServer((request, response) => {
    try {
      const url = new URL(request.url || '/', `http://127.0.0.1:${port}`);
      let filePath = path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
      if (!filePath.startsWith(`${root}${path.sep}`) && filePath !== root) {
        response.writeHead(403).end();
        return;
      }
      if (existsSync(filePath) && statSync(filePath).isDirectory()) {
        filePath = path.join(filePath, 'index.html');
      }
      if (!existsSync(filePath) || !statSync(filePath).isFile()) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      createReadStream(filePath).pipe(response);
    } catch {
      response.writeHead(400).end();
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({
      port: server.address().port,
      close: () => new Promise(done => server.close(done)),
    }));
  });
}

async function captureScene(browser, baseUrl, scene) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    // The boundary copy is localised, and the button is matched by name. Without
    // this the locale follows the host machine and the run fails on a German
    // desktop while passing in CI.
    locale: 'en-US',
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.addInitScript(PIN_CLOCK);
  await page.goto(`${baseUrl}/dist/?renderer=pixi`);
  await page.getByRole('button', { name: /I understand/ }).click();
  await page.locator('[data-wreck-viewport] canvas').waitFor();

  const step = (frames) => page.evaluate(n => window.__stepFrames(n), frames);

  // Settle the scene, then drive it, entirely in frames. Nothing here waits on
  // wall time, so the same script always produces the same pixels.
  await step(scene.frames);
  if (scene.hold) {
    await page.keyboard.down(scene.hold.key);
    await step(scene.hold.frames);
    await page.keyboard.up(scene.hold.key);
    await step(scene.frames);
  }
  if (scene.press) {
    await page.keyboard.press(scene.press);
    await step(scene.frames);
  }

  const viewport = page.locator('[data-wreck-viewport]');
  const png = await viewport.screenshot();
  await context.close();
  return { png, errors };
}

/**
 * Decode a capture (and optionally its reference) in the page, and return the
 * scene statistics plus the frame delta.
 *
 * Statistics are taken from the decoded SCREENSHOT rather than by reading the
 * live canvas back. Drawing a WebGL canvas into a 2D one returns transparent
 * black unless the context was created with preserveDrawingBuffer, which this
 * one is not — the first version of this script did exactly that and recorded
 * meanLuma 0 for every scene. Zero compares equal to zero, so the statistics
 * half of the guard would have passed no matter what the renderer did.
 */
async function analyse(browser, baseUrl, sceneId, freshPng, withReference) {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.goto(`${baseUrl}/dist/`);
  const result = await page.evaluate(async ({ referenceUrl, freshBase64, compare }) => {
    const decode = async (src) => {
      const image = new Image();
      image.src = src;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      canvas.getContext('2d').drawImage(image, 0, 0);
      return canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    };

    // Scene area only, excluding the HUD strips at top and bottom.
    const statisticsOf = ({ data, width, height }) => {
      const x0 = Math.round(width * 0.08), x1 = Math.round(width * 0.92);
      const y0 = Math.round(height * 0.15), y1 = Math.round(height * 0.85);
      let n = 0, sum = 0, sum2 = 0, r = 0, g = 0, b = 0;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const i = (y * width + x) * 4;
          const R = data[i], G = data[i + 1], B = data[i + 2];
          const L = 0.2126 * R + 0.7152 * G + 0.0722 * B;
          n += 1; sum += L; sum2 += L * L; r += R; g += G; b += B;
        }
      }
      const mean = sum / n;
      const means = [r / n, g / n, b / n];
      return {
        meanLuma: +mean.toFixed(3),
        sdLuma: +Math.sqrt(Math.max(0, sum2 / n - mean * mean)).toFixed(3),
        meanRGB: means.map(v => +v.toFixed(3)),
        channelSpread: +(Math.max(...means) - Math.min(...means)).toFixed(3),
      };
    };

    const fresh = await decode(`data:image/png;base64,${freshBase64}`);
    const statistics = statisticsOf(fresh);
    if (!compare) return { statistics };

    const reference = await decode(referenceUrl);
    if (reference.width !== fresh.width || reference.height !== fresh.height) {
      return {
        statistics,
        sizeMismatch: `reference ${reference.width}x${reference.height} vs fresh ${fresh.width}x${fresh.height}`,
      };
    }
    let changedPixels = 0, totalDelta = 0, maxChannelDelta = 0;
    for (let i = 0; i < reference.data.length; i += 4) {
      let pixelChanged = false;
      for (let c = 0; c < 4; c += 1) {
        const delta = Math.abs(reference.data[i + c] - fresh.data[i + c]);
        if (delta) {
          pixelChanged = true;
          totalDelta += delta;
          if (delta > maxChannelDelta) maxChannelDelta = delta;
        }
      }
      if (pixelChanged) changedPixels += 1;
    }
    const pixelCount = reference.width * reference.height;
    return {
      statistics,
      pixelCount,
      changedPixels,
      changedPixelPercent: +(changedPixels * 100 / pixelCount).toFixed(4),
      meanAbsoluteDeltaPerChannel: +(totalDelta / (pixelCount * 4)).toFixed(5),
      maxChannelDelta,
    };
  }, {
    referenceUrl: `/tests/fixtures/reference-frames/pixi/${PLATFORM}/${sceneId}.png`,
    freshBase64: freshPng.toString('base64'),
    compare: withReference,
  });
  await context.close();

  // A blank readback is the failure this function was rewritten to avoid, so
  // refuse to record or compare statistics that say the scene has no light in
  // it at all.
  if (result.statistics.meanLuma === 0 && result.statistics.channelSpread === 0) {
    throw new Error(
      `${sceneId}: decoded frame is uniformly black — the capture or decode is broken, ` +
      'not the renderer. Recording this would make the statistics check vacuous.',
    );
  }
  return result;
}

function breachesFor(sceneId, frame, statistics, reference) {
  const breaches = [];
  if (frame.sizeMismatch) {
    breaches.push(`${sceneId}: ${frame.sizeMismatch}`);
    return breaches;
  }
  if (frame.maxChannelDelta > MAX_CHANNEL_DELTA) {
    breaches.push(`${sceneId}: max channel delta ${frame.maxChannelDelta} exceeds ${MAX_CHANNEL_DELTA}`);
  }
  if (frame.meanAbsoluteDeltaPerChannel > MAX_MEAN_CHANNEL_DELTA) {
    breaches.push(`${sceneId}: mean channel delta ${frame.meanAbsoluteDeltaPerChannel} exceeds ${MAX_MEAN_CHANNEL_DELTA}`);
  }
  if (frame.changedPixelPercent > MAX_CHANGED_PIXEL_PERCENT) {
    breaches.push(`${sceneId}: ${frame.changedPixelPercent}% of pixels changed, over ${MAX_CHANGED_PIXEL_PERCENT}%`);
  }
  const checks = [
    ['meanLuma', MAX_MEAN_LUMA_DELTA],
    ['sdLuma', MAX_SD_LUMA_DELTA],
    ['channelSpread', MAX_CHANNEL_SPREAD_DELTA],
  ];
  for (const [key, budget] of checks) {
    const delta = Math.abs(statistics[key] - reference.statistics[key]);
    if (delta > budget) {
      breaches.push(
        `${sceneId}: ${key} moved ${delta.toFixed(3)} (${reference.statistics[key]} -> ${statistics[key]}), over ${budget}`,
      );
    }
  }
  return breaches;
}

const server = await startServer(0);
const baseUrl = `http://127.0.0.1:${server.port}`;
const browser = await chromium.launch();
let failed = false;

try {
  if (!existsSync(path.join(root, 'dist', 'index.html'))) {
    throw new Error('dist/ is missing — run `npm run build` first');
  }
  await mkdir(referenceDir, { recursive: true });

  const manifestPath = path.join(referenceDir, 'manifest.json');
  const manifest = UPDATE || !existsSync(manifestPath)
    ? null
    : JSON.parse(await readFile(manifestPath, 'utf8'));

  if (!UPDATE && !manifest) {
    throw new Error(
      `no reference frames recorded for platform "${PLATFORM}".
` +
      'Record them with `npm run pixi:visual-update` and commit ' +
      `tests/fixtures/reference-frames/pixi/${PLATFORM}/.`,
    );
  }

  const recorded = {};
  for (const scene of SCENES) {
    const { png, errors } = await captureScene(browser, baseUrl, scene);
    if (errors.length) {
      throw new Error(`${scene.id} raised page errors:\n  ${errors.join('\n  ')}`);
    }

    const analysis = await analyse(browser, baseUrl, scene.id, png, !UPDATE);
    const statistics = analysis.statistics;

    if (UPDATE) {
      await writeFile(path.join(referenceDir, `${scene.id}.png`), png);
      recorded[scene.id] = { statistics };
      console.log(`recorded ${scene.id}  meanLuma=${statistics.meanLuma} sd=${statistics.sdLuma} spread=${statistics.channelSpread}`);
      continue;
    }

    const reference = manifest.scenes[scene.id];
    if (!reference) {
      throw new Error(`${scene.id} has no reference — run \`npm run pixi:visual-update\``);
    }
    const breaches = breachesFor(scene.id, analysis, statistics, reference);
    if (breaches.length) {
      failed = true;
      for (const breach of breaches) console.error(`FAIL ${breach}`);
      // Leave the offending capture on disk so it can be looked at.
      await writeFile(path.join(referenceDir, `${scene.id}.actual.png`), png);
      console.error(`     wrote tests/fixtures/reference-frames/pixi/${PLATFORM}/${scene.id}.actual.png`);
    } else {
      console.log(
        `ok   ${scene.id}  ${analysis.changedPixelPercent}% pixels, max delta ${analysis.maxChannelDelta}, ` +
        `luma ${statistics.meanLuma}, spread ${statistics.channelSpread}`,
      );
    }
  }

  if (UPDATE) {
    await writeFile(
      manifestPath,
      `${JSON.stringify({
        note: 'Regenerate with `npm run pixi:visual-update`. Do not hand-edit.',
        viewport: VIEWPORT,
        scenes: recorded,
      }, null, 2)}\n`,
    );
    // A stale .actual.png from an earlier failure would be confusing next to a
    // freshly recorded reference.
    for (const entry of await readdir(referenceDir)) {
      if (entry.endsWith('.actual.png')) {
        await writeFile(path.join(referenceDir, entry), Buffer.alloc(0));
      }
    }
    console.log(`\nrecorded ${Object.keys(recorded).length} reference frames`);
  }
} finally {
  await browser.close();
  await server.close();
}

if (failed) {
  console.error('\nPixi visual check failed. If the change is intended, re-record with');
  console.error('`npm run pixi:visual-update` so the new frames land in the diff for review.');
  process.exit(1);
}
