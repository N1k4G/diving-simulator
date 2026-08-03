import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';

const require = createRequire(import.meta.url);
const { runBaselineScenarios } = require('./baseline-scenarios.cjs');
const root = path.resolve(import.meta.dirname, '..');
const port = 4173;
const baseUrl = `http://127.0.0.1:${port}`;
const referenceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8'
}).trim();
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
    const traces = await page.evaluate(runBaselineScenarios);

    const traceFixture = {
      schemaVersion: 1,
      kind: 'diving-simulator-golden-traces',
      referenceCommit,
      generator: 'npm run baseline:generate',
      tolerances: {
        exact: [
          'schemaVersion',
          'scenarioId',
          'checkpointId',
          'simulatedGeometry',
          'state.gameState',
          'state.diveMode',
          'state.diveSite',
          'state.activeTankIndex',
          'state.ndlDroppedBelow5',
          'state.safetyStop.needed',
          'state.safetyStop.countdownStarted',
          'state.safetyStop.paused',
          'state.safetyStop.complete',
          'tanks.length',
          'ccr.onBailout',
          'events.length',
          'events.*.kind'
        ],
        absoluteEpsilon: {
          default: 1e-9,
          'planner.ceiling_m': 1e-6,
          'planner.ndl_min': 1e-9,
          'planner.tts_min': 1e-6,
          'planner.schedule.stops.*.depth': 1e-6,
          'planner.schedule.stops.*.time': 1e-6,
          'planner.schedule.tts': 1e-6,
          'state.safetyStop.remaining_min': 1e-6,
          'tissues.*_bar': 1e-9,
          'tanks.*.pressure_bar': 1e-6,
          'tanks.*.gasRemaining_l': 1e-6,
          'ccr.*Pressure_bar': 1e-6,
          'ccr.scrubberRemaining_min': 1e-6
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
      referenceCommit,
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
  server.unref();
}
