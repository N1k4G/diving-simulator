import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const port = 4173;
const baseUrl = `http://127.0.0.1:${port}`;
const server = spawn(
  process.execPath,
  [require.resolve('http-server/bin/http-server'), root, '-p', String(port), '--silent'],
  { cwd: root, stdio: 'ignore', windowsHide: true }
);

async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await fetch(`${baseUrl}/src/diving-simulator.html`);
      if (response.ok) return;
    } catch {
      // The server normally needs a few polls on Windows.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`baseline server did not start on ${baseUrl}`);
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

try {
  await waitForServer();
  const browser = await chromium.launch({
    env: {
      ...process.env,
      CHROME_LOG_FILE: path.join(os.tmpdir(), 'diving-simulator-baseline-chrome.log')
    }
  });
  try {
    const page = await browser.newPage();
    await page.goto(`${baseUrl}/src/diving-simulator.html`);
    await page.waitForFunction(() => Boolean(window.gameAPI));

    const traces = await page.evaluate(() => {
      const api = window.gameAPI;

      function setup(mode, site, tankList) {
        api.diveMode = mode;
        api.tanks.length = 0;
        api.tankCount = 0;
        api.resetDive();
        api.initTissues();
        api.initCCR();
        for (const tank of tankList) api.pushTank(tank[0], tank[1], tank[2]);
        api.activeTank = 0;
        api.diveSite = site;
        api.gameState = 'diving';
        api.shark = null;
        api.sharkTimer = 1e9;
        api.drillsEnabled = false;
        api.current.active = false;
        api.current.rolledThisDive = true;
        api.clearKeys();
      }

      function holdDepth(depth, minutes, stepMinutes = 0.1) {
        const steps = Math.round(minutes / stepMinutes);
        api.setDepth(depth);
        api.maxDepth = Math.max(api.maxDepth, depth);
        for (let i = 0; i < steps; i++) api.updateTissues(stepMinutes);
        api.diveTime += steps * stepMinutes;
      }

      function ascend(fromDepth, rateMpm, stepMinutes = 0.1) {
        let depth = fromDepth;
        while (depth > 0) {
          depth = Math.max(0, depth - rateMpm * stepMinutes);
          api.setDepth(depth);
          api.updateTissues(stepMinutes);
          api.diveTime += stepMinutes;
        }
      }

      const scenarios = [];

      setup('rec', 'shore', [[0.21, 0, 200]]);
      const air = {
        scenarioId: 'air-18m-30min',
        description: 'Air at 18 m for 30 min followed by a 9 m/min direct ascent',
        checkpoints: [api.captureBaselineCheckpoint('air-18m-30min', 'surface')]
      };
      holdDepth(18, 30);
      air.checkpoints.push(api.captureBaselineCheckpoint('air-18m-30min', 'bottom-30min'));
      ascend(18, 9);
      air.checkpoints.push(api.captureBaselineCheckpoint('air-18m-30min', 'surfaced'));
      scenarios.push(air);

      setup('tec', 'wreck', [[0.21, 0.35, 200], [0.5, 0, 200]]);
      const trimix = {
        scenarioId: 'trimix-45m-20min',
        description: 'Trimix 21/35 at 45 m for 20 min with an available 50% deco gas',
        checkpoints: [api.captureBaselineCheckpoint('trimix-45m-20min', 'surface')]
      };
      holdDepth(45, 20);
      trimix.checkpoints.push(api.captureBaselineCheckpoint('trimix-45m-20min', 'bottom-20min'));
      scenarios.push(trimix);

      setup('ccr', 'cave', [[0.21, 0, 200]]);
      api.ccrState.targetSP = 1.3;
      api.ccrState.actualPO2 = 1.3;
      api.ccrState.dilFO2 = 0.15;
      api.ccrState.dilFHe = 0.45;
      api.ccrState.dilFN2 = 0.4;
      const ccr = {
        scenarioId: 'ccr-30m-20min',
        description: 'CCR at 1.3 bar setpoint and trimix 15/45 diluent at 30 m for 20 min',
        checkpoints: [api.captureBaselineCheckpoint('ccr-30m-20min', 'surface')]
      };
      holdDepth(30, 20);
      ccr.checkpoints.push(api.captureBaselineCheckpoint('ccr-30m-20min', 'bottom-20min'));
      scenarios.push(ccr);

      return scenarios;
    });

    const traceFixture = {
      schemaVersion: 1,
      kind: 'diving-simulator-golden-traces',
      referenceCommit: '30c151f',
      generator: 'npm run baseline:generate',
      tolerances: {
        exact: [
          'scenarioId',
          'checkpointId',
          'state.gameState',
          'state.diveMode',
          'state.diveSite',
          'state.activeTankIndex',
          'state.safetyStop.*',
          'tanks.length',
          'ccr.onBailout',
          'events'
        ],
        absoluteEpsilon: {
          default: 1e-9,
          'planner.ceiling_m': 1e-6,
          'planner.ndl_min': 0,
          'planner.tts_min': 1e-6,
          'tissues.*_bar': 1e-9,
          'tanks.*.pressure_bar': 1e-6,
          'tanks.*.gasRemaining_l': 1e-6
        }
      },
      scenarios: traces
    };

    await page.goto(`${baseUrl}/src/diving-simulator-tests.html`);
    await page.waitForFunction(() => Array.isArray(window.tests) && window.tests.length > 0);
    const publicTests = await page.evaluate(() =>
      window.tests.map(test => ({ id: test.id, name: test.name }))
    );
    const testInventory = {
      schemaVersion: 1,
      referenceCommit: '30c151f',
      legacyHarness: {
        path: 'src/diving-simulator-tests.html',
        disposition: 'Parity oracle until WP-12; port assertions incrementally',
        tests: publicTests
      },
      playwright: [
        { id: 'PW-GAME', path: 'tests/game.spec.js', coverage: 'Legacy in-browser suite' },
        { id: 'PW-SMOKE', path: 'tests/smoke.spec.js', coverage: 'Desktop/mobile input and startup smoke' },
        { id: 'PW-RELOAD', path: 'tests/reload-resume.spec.js', coverage: 'Save/reload/drill recovery' }
      ]
    };

    const fixtureDirectory = path.join(root, 'tests', 'fixtures', 'traces');
    const baselineDirectory = path.join(root, 'docs', 'baseline');
    await mkdir(fixtureDirectory, { recursive: true });
    await mkdir(baselineDirectory, { recursive: true });
    await writeFile(
      path.join(fixtureDirectory, 'baseline-v1.json'),
      stableJson(traceFixture),
      'utf8'
    );
    await writeFile(
      path.join(baselineDirectory, 'test-inventory.json'),
      stableJson(testInventory),
      'utf8'
    );
  } finally {
    await browser.close();
  }
} finally {
  server.kill();
}
