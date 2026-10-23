// ============================================================
// scripts/phone-screenshots.mjs
// PURPOSE: Per-PR review evidence for the client we ship (#137 A13a): the
//          built dist/ at a phone viewport, portrait and landscape, in
//          English and German. Setup screen, dive a little below the
//          surface, the help overlay and the post-dive screen.
//
// This is evidence for a reviewer, not a guard. There are no reference
// frames and no thresholds, and nothing here fails a PR over what a frame
// looks like. It exits non-zero only when a frame could not be taken at all
// (a screen never appeared) or came out blank, since a blank image reviews
// nothing. A Playwright viewport shows neither system bars, safe areas nor a
// native WebView; that is A13b's emulator capture.
//
// Usage: `npm run build && npm run screenshots:phone`
//        [--out <dir>]   output directory (default ./screenshots-phone)
// Serves dist/ on an ephemeral 127.0.0.1 port, so it never clashes with the
// Playwright test server on 8080 or with a second run on the same machine.
// Shots are taken one after the other in one browser.
//
// Determinism: the dive seed is pinned the way tests/helpers/pinned-seed.cjs
// pins it, and Math.random is a fixed sequence. The dive's depth comes from
// the S key held until the HUD reads it, not from a wall-clock wait.
// ============================================================
import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outFlag = process.argv.indexOf('--out');
const outDir = path.resolve(root, outFlag > 0 ? process.argv[outFlag + 1] : 'screenshots-phone');
const SAVE_KEY = 'diving-simulator.save-game';
const PINNED_DIVE_SEED = 0x57524543;

const VIEWPORTS = [
  { id: 'portrait', width: 390, height: 844 },
  { id: 'landscape', width: 844, height: 390 },
];
const LOCALES = [
  { id: 'en', locale: 'en-GB' },
  { id: 'de', locale: 'de-DE' },
];

const MIME = {
  '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
};

function serveDist() {
  const distRoot = path.join(root, 'dist');
  const server = createServer((request, response) => {
    try {
      const url = new URL(request.url || '/', 'http://127.0.0.1');
      let file = path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
      if (!file.startsWith(`${distRoot}${path.sep}`) && file !== distRoot) {
        response.writeHead(403).end();
        return;
      }
      if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, 'index.html');
      if (!existsSync(file) || !statSync(file).isFile()) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      createReadStream(file).pipe(response);
    } catch {
      response.writeHead(400).end();
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      close: () => new Promise((done) => server.close(done)),
    }));
  });
}

function pinPage(seed) {
  const native = crypto.getRandomValues.bind(crypto);
  crypto.getRandomValues = (array) => {
    if (array instanceof Uint32Array) {
      array.fill(seed);
      return array;
    }
    return native(array);
  };
  let state = 0x2545f491;
  Math.random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

async function holdSUntilDepth(page, depthM) {
  await page.keyboard.down('s');
  try {
    await page.waitForFunction((target) => {
      const value = document.querySelector('.wreck-hud [data-hud-metric="depth"] dd');
      return Number.parseFloat(String(value?.textContent ?? '').replace(',', '.')) >= target;
    }, depthM, { timeout: 60_000 });
  } finally {
    await page.keyboard.up('s');
  }
}

/** The save of a dive that ended at the surface, as tests/post-dive.spec.js edits it. */
function completeAtSurface(state) {
  const END_S = 1530;
  const deepest = 18;
  const profile = [];
  for (let t = 0; t <= END_S; t += 2) {
    const depth = t < 120 ? (deepest * t) / 120
      : t < END_S - 150 ? deepest
        : Math.max(0, (deepest * (END_S - t)) / 150);
    profile.push({ elapsedTimeS: t, depthM: Math.min(deepest, depth), ceilingM: 0 });
  }
  const submergedS = END_S - 60;
  Object.assign(state, {
    elapsedTimeS: END_S, depthM: 0.1, maxDepthM: deepest, verticalVelocityMpm: 0, completed: true,
    thirds: { startingGasL: 0, turnWarned: false, reserveHit: false },
    safetyStop: { needed: true, countdownStarted: true, remainingS: 150, paused: true, complete: false },
  });
  Object.assign(state.log, {
    entries: [
      { kind: 'fast-ascent', elapsedTimeS: END_S - 90, value: 14.2 },
      { kind: 'safety-stop-skipped', elapsedTimeS: END_S, value: 0 },
    ],
    ascentRateMpm: 0, fastAscentS: 0, fastAscentPeakMpm: 0, fastAscentLatched: false,
    ceilingViolationS: 0, ceilingViolationLatched: false,
    depthTimeMS: 16 * submergedS, submergedS, profile, profileTimerS: 0, lastCeilingM: 0,
  });
}

/** Luma standard deviation of a PNG, decoded in the browser; a blank frame reads 0. */
async function sdLuma(scratch, png) {
  return scratch.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let n = 0, sum = 0, sum2 = 0;
    for (let i = 0; i < data.length; i += 4) {
      const luma = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      n += 1; sum += luma; sum2 += luma * luma;
    }
    const mean = sum / n;
    return Math.sqrt(Math.max(0, sum2 / n - mean * mean));
  }, png.toString('base64'));
}

/** SHA-256 over dist/'s relative paths and bytes, in sorted order: the build that was shot. */
function hashTree(dir) {
  const hash = createHash('sha256');
  const walk = (current) => {
    const entries = readdirSync(current, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name));
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        hash.update(`${path.relative(dir, full).split(path.sep).join('/')}\0`).update(readFileSync(full));
      }
    }
  };
  walk(dir);
  return hash.digest('hex');
}

async function main() {
  if (!existsSync(path.join(root, 'dist', 'index.html'))) {
    throw new Error('dist/ is missing: run `npm run build` first');
  }
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const server = await serveDist();
  const base = `http://127.0.0.1:${server.port}/dist/`;
  const browser = await chromium.launch();
  const browserVersion = browser.version();
  const scratch = await (await browser.newContext()).newPage();
  const shots = [];
  const errors = [];

  try {
    for (const { id: lang, locale } of LOCALES) {
      for (const viewport of VIEWPORTS) {
        const context = await browser.newContext({
          locale,
          viewport: { width: viewport.width, height: viewport.height },
          deviceScaleFactor: 2,
          isMobile: true,
          hasTouch: true,
        });
        await context.addInitScript(pinPage, PINNED_DIVE_SEED);
        const page = await context.newPage();
        page.on('pageerror', (error) => errors.push(`[${lang} ${viewport.id}] ${error}`));
        const shoot = async (screen) => {
          const name = `${screen}-${lang}-${viewport.id}.png`;
          const png = await page.screenshot({ path: path.join(outDir, name) });
          const sd = await sdLuma(scratch, png);
          shots.push({
            file: name, screen, language: lang, orientation: viewport.id,
            viewport: `${viewport.width}x${viewport.height}`, deviceScaleFactor: 2,
            bytes: png.length, sha256: createHash('sha256').update(png).digest('hex'),
            sdLuma: +sd.toFixed(3),
          });
          console.log(`  ${name}  sdLuma=${sd.toFixed(2)}`);
        };

        await page.goto(base);
        await page.locator('[data-accept-safety]').click();
        await page.locator('.setup-screen').waitFor();
        await shoot('setup');

        await page.locator('[data-start-dive]').click();
        await page.locator('[data-renderer=pixi] canvas').waitFor();
        await holdSUntilDepth(page, 2);
        await page.waitForTimeout(300);
        await shoot('dive');

        await page.locator('[data-help-open]').click();
        await page.locator('[data-help-overlay]').waitFor({ state: 'visible' });
        await shoot('help');
        await page.keyboard.press('Escape');

        // Post-dive: turn the save of this dive into one that ended at the surface, and resume it.
        const saved = await page.evaluate((key) => JSON.parse(window.localStorage.getItem(key)), SAVE_KEY);
        completeAtSurface(saved.state);
        await page.goto(base);
        await page.evaluate(([key, value]) => window.localStorage.setItem(key, value), [SAVE_KEY, JSON.stringify(saved)]);
        await page.locator('[data-accept-safety]').click();
        await page.locator('[data-resume-continue]').click();
        await page.locator('[data-post-dive]').waitFor();
        await shoot('post-dive');
        await context.close();
      }
    }
  } finally {
    await browser.close();
    await server.close();
  }

  let checkoutSha = null;
  try {
    checkoutSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch { /* not a git checkout */ }
  // On a pull_request run HEAD is GitHub's synthetic merge commit; the PR's
  // own head arrives as PR_HEAD_SHA (pr.yml). Both are recorded.
  const prHeadSha = process.env.PR_HEAD_SHA || null;
  const playwrightVersion = JSON.parse(
    readFileSync(path.join(root, 'node_modules', '@playwright', 'test', 'package.json'), 'utf8'),
  ).version;
  writeFileSync(path.join(outDir, 'index.json'), `${JSON.stringify({
    purpose: 'review evidence for #137 A13a; not a gate',
    sourceCommit: prHeadSha || checkoutSha || 'unknown',
    checkoutCommit: checkoutSha,
    prHeadCommit: prHeadSha,
    buildId: `sha256:${hashTree(path.join(root, 'dist'))}`,
    command: 'npm run screenshots:phone',
    generatedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: `${os.platform()} ${os.release()}`,
      arch: os.arch(),
      ci: process.env.GITHUB_ACTIONS === 'true',
      playwright: playwrightVersion,
      browser: `chromium ${browserVersion}`,
    },
    shots,
  }, null, 2)}\n`);

  const blank = shots.filter((shot) => !(shot.sdLuma > 0));
  if (errors.length > 0) console.warn(`page errors:\n${errors.join('\n')}`);
  if (blank.length > 0) throw new Error(`blank frames: ${blank.map((shot) => shot.file).join(', ')}`);
  console.log(`wrote ${shots.length} frames and index.json to ${path.relative(root, outDir) || '.'}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
