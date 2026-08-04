import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { chromium } from '@playwright/test';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const cliArguments = process.argv.slice(2);

function argumentValue(name, fallback) {
  const index = cliArguments.indexOf(name);
  if (index === -1) return fallback;
  if (!cliArguments[index + 1]) throw new Error(`missing value for ${name}`);
  return cliArguments[index + 1];
}

function requiredArgument(name) {
  const value = argumentValue(name, null);
  if (!value) throw new Error(`missing required argument ${name}`);
  return value;
}

const beforeRoot = path.resolve(root, requiredArgument('--before-root'));
const afterRoot = path.resolve(root, argumentValue('--after-root', '.'));
const beforeSourceCommit = requiredArgument('--before-source-commit');
const afterSourceCommit = requiredArgument('--after-source-commit');
const comparisonSessionId = requiredArgument('--comparison-session-id');
const outputPath = path.resolve(root, requiredArgument('--output'));

// Budget for acceptable visual drift between two renderers, applied per scene.
//
// Observed drift from replacing snapshot/restore compositing with transparent
// overlays was a maximum channel delta of 18 and a mean of 0.076/255 on the
// wreck, and 7 / 0.009 on the cave. These thresholds sit at roughly twice that,
// which tolerates compositing-rounding differences while still failing on a
// change that visibly alters the scene.
//
// Raise a threshold only with a recorded reason. Widening it to make a run pass
// is how a visual regression ships.
const MAX_CHANNEL_DELTA = Number(argumentValue('--max-channel-delta', '32'));
const MAX_MEAN_CHANNEL_DELTA = Number(
  argumentValue('--max-mean-channel-delta', '0.5'),
);

if (!Number.isFinite(MAX_CHANNEL_DELTA) || MAX_CHANNEL_DELTA <= 0) {
  throw new Error('--max-channel-delta must be a positive number');
}
if (!Number.isFinite(MAX_MEAN_CHANNEL_DELTA) || MAX_MEAN_CHANNEL_DELTA <= 0) {
  throw new Error('--max-mean-channel-delta must be a positive number');
}

function evaluateBudget(result) {
  const breaches = [];
  if (result.maxChannelDelta > MAX_CHANNEL_DELTA) {
    breaches.push(
      `max channel delta ${result.maxChannelDelta} exceeds ${MAX_CHANNEL_DELTA}`,
    );
  }
  if (result.meanAbsoluteDeltaPerChannel > MAX_MEAN_CHANNEL_DELTA) {
    breaches.push(
      `mean channel delta ${result.meanAbsoluteDeltaPerChannel.toFixed(4)} ` +
      `exceeds ${MAX_MEAN_CHANNEL_DELTA}`,
    );
  }
  return breaches;
}
const serverEntry = require.resolve('http-server/bin/http-server');

async function availablePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const { port } = probe.address();
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  return port;
}

const endpoints = [
  { root: beforeRoot, port: await availablePort() },
  { root: afterRoot, port: await availablePort() }
];
const servers = endpoints.map(endpoint => spawn(
  process.execPath,
  [serverEntry, endpoint.root, '-p', String(endpoint.port), '--silent'],
  { cwd: endpoint.root, stdio: 'ignore', windowsHide: true }
));

async function waitFor(url) {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // The server normally needs a few polls on Windows.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`server did not start: ${url}`);
}

async function pixels(browser, baseUrl, scene) {
  const page = await browser.newPage({ viewport: { width: 759, height: 839 }, deviceScaleFactor: 1 });
  await page.addInitScript(() => {
    let seed = 0x5eed1234;
    Math.random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    // Seeding Math.random is not sufficient. Parts of the wreck scene animate
    // on the wall clock -- the treasure-chest glow drives shadowBlur from
    // Date.now() -- so two captures taken moments apart differ by up to 180 on
    // a channel across ~1.9% of pixels, comparing a tree against itself. Pin
    // the clock so the comparison measures the renderer and not the moment.
    const FIXED_NOW = 1_735_689_600_000;
    Date.now = () => FIXED_NOW;
    window.__baselineCapturePaused = true;
  });
  await page.goto(`${baseUrl}/src/diving-simulator.html?diagnostics=1&diagnosticsOverlay=0`);
  await page.waitForFunction(() => Boolean(window.gameAPI));
  const result = await page.evaluate(config => {
    const api = window.gameAPI;
    api.gameState = 'diving';
    api.diveMode = 'rec';
    api.diveSite = config.site;
    api.diverX = config.x;
    api.setDepth(config.depth);
    api.maxDepth = config.depth;
    api.verticalVelocity = 0;
    api.horizontalVelocity = 0;
    api.torchOn = true;
    api.visibility = 1;
    api.waveTime = 0;
    api.shark = null;
    api.sharkTimer = 1e9;
    api.drillsEnabled = false;
    api.current.active = false;
    api.current.rolledThisDive = true;
    if ('wreckMetal' in api) api.wreckMetal = 1;
    try {
      window._wreckMetal = 1;
    } catch {
      // Older source snapshots may not expose the transition state globally.
    }
    api.resetDiagnostics({ sceneId: config.id });
    api.runBaselineDiagnosticFrames(1, 0);
    const canvas = api.canvas;
    return {
      environment: {
        userAgent: navigator.userAgent,
        viewportCssPx: { width: innerWidth, height: innerHeight },
        devicePixelRatio
      },
      width: canvas.width,
      height: canvas.height,
      data: Array.from(api.ctx.getImageData(0, 0, canvas.width, canvas.height).data)
    };
  }, scene);
  await page.close();
  return result;
}

function compare(sceneId, before, after) {
  if (JSON.stringify(before.environment) !== JSON.stringify(after.environment)) {
    throw new Error(`${sceneId}: capture environments differ`);
  }
  if (before.width !== after.width || before.height !== after.height) {
    throw new Error(`${sceneId}: canvas dimensions differ`);
  }
  let changedPixels = 0;
  let changedChannels = 0;
  let totalAbsoluteDelta = 0;
  let maxChannelDelta = 0;
  const pixelsAboveChannelDelta = { 8: 0, 32: 0, 64: 0, 128: 0 };
  for (let index = 0; index < before.data.length; index += 4) {
    let pixelChanged = false;
    let pixelMaxChannelDelta = 0;
    for (let channel = 0; channel < 4; channel++) {
      const delta = Math.abs(before.data[index + channel] - after.data[index + channel]);
      if (delta) {
        pixelChanged = true;
        changedChannels++;
        totalAbsoluteDelta += delta;
        maxChannelDelta = Math.max(maxChannelDelta, delta);
        pixelMaxChannelDelta = Math.max(pixelMaxChannelDelta, delta);
      }
    }
    if (pixelChanged) {
      changedPixels++;
      for (const threshold of Object.keys(pixelsAboveChannelDelta)) {
        if (pixelMaxChannelDelta > Number(threshold)) pixelsAboveChannelDelta[threshold]++;
      }
    }
  }
  const pixelCount = before.width * before.height;
  return {
    sceneId,
    width: before.width,
    height: before.height,
    pixelCount,
    changedPixels,
    changedPixelPercent: changedPixels * 100 / pixelCount,
    changedChannels,
    meanAbsoluteDeltaPerChannel: totalAbsoluteDelta / (pixelCount * 4),
    maxChannelDelta,
    pixelsAboveChannelDelta
  };
}

try {
  await Promise.all(endpoints.map(endpoint => waitFor(
    `http://127.0.0.1:${endpoint.port}/src/diving-simulator.html`
  )));
  const browser = await chromium.launch();
  try {
    const scenes = [
      { id: 'wreck-engine-room', site: 'wreck', x: 102, depth: 58 },
      { id: 'cave-upper-tunnel', site: 'cave', x: 80, depth: 16 }
    ];
    const results = [];
    for (const scene of scenes) {
      const before = await pixels(browser, `http://127.0.0.1:${endpoints[0].port}`, scene);
      const after = await pixels(browser, `http://127.0.0.1:${endpoints[1].port}`, scene);
      results.push(compare(scene.id, before, after));
    }
    const passed = results.every(result => evaluateBudget(result).length === 0);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify({
      schemaVersion: 1,
      kind: 'diving-simulator-pixel-comparison',
      beforeSourceCommit,
      afterSourceCommit,
      comparisonSessionId,
      generatedBy: `node scripts/compare-rendering.mjs ${cliArguments.join(' ')}`,
      method: 'Seeded, clock-pinned DPR-1 canvas pixel comparison after one dt=0 direct diagnostic frame',
      budget: {
        maxChannelDelta: MAX_CHANNEL_DELTA,
        maxMeanChannelDelta: MAX_MEAN_CHANNEL_DELTA
      },
      passed,
      results
    }, null, 2)}\n`, 'utf8');

    for (const result of results) {
      const breaches = evaluateBudget(result);
      console.log(
        `${result.sceneId}: ${breaches.length ? `FAIL — ${breaches.join('; ')}` : 'pass'} ` +
        `(max ${result.maxChannelDelta}, mean ` +
        `${result.meanAbsoluteDeltaPerChannel.toFixed(4)})`
      );
    }
    if (!passed) {
      // Exit non-zero so this gates a build rather than only informing a reader.
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
  }
} finally {
  await Promise.all(servers.map(async server => {
    if (server.exitCode !== null) return;
    server.kill();
    await Promise.race([
      once(server, 'exit'),
      new Promise(resolve => setTimeout(resolve, 5000))
    ]);
  }));
}
