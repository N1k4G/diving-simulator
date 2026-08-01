const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');

const root = path.resolve(__dirname, '..');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

test('baseline: simulation-only boundary is visible and localized', async ({ page }) => {
  await page.goto('/src/diving-simulator.html');
  await page.waitForFunction(() => Boolean(window.gameAPI));

  const boundary = page.locator('.gs-simulation-boundary');
  await expect(boundary).toBeVisible();
  await expect(boundary).toContainText('SIMULATION ONLY');
  await expect(boundary).toContainText('Not a dive computer');

  await page.evaluate(() => {
    window.gameAPI.currentLang = 'de';
  });
  await expect(boundary).toContainText('NUR SIMULATION');
  await expect(boundary).toContainText('Kein Tauchcomputer');
});

test('baseline: diagnostics are opt-in and export named metrics', async ({ page }) => {
  await page.goto('/src/diving-simulator.html');
  await page.waitForFunction(() => Boolean(window.gameAPI));
  await expect(page.locator('#baseline-diagnostics')).toHaveCount(0);
  expect(await page.evaluate(() => window.gameAPI.diagnosticsEnabled)).toBe(false);

  await page.goto('/src/diving-simulator.html?diagnostics=1');
  await page.waitForFunction(() => Boolean(window.gameAPI));
  await page.evaluate(() => {
    const api = window.gameAPI;
    api.resetDiagnostics({ runId: 'test-run', sceneId: 'shore-18m' });
    api.gameState = 'diving';
    api.diveSite = 'shore';
    api.setDepth(18);
  });
  await page.waitForTimeout(750);

  const exported = await page.evaluate(() => window.gameAPI.exportDiagnostics());
  expect(exported.schemaVersion).toBe(1);
  expect(exported.kind).toBe('diving-simulator-performance');
  expect(exported.context).toEqual({ runId: 'test-run', sceneId: 'shore-18m' });
  expect(exported.metrics.frame.sampleCount).toBeGreaterThan(0);
  expect(exported.metrics.update.sampleCount).toBeGreaterThan(0);
  expect(exported.metrics.planner.sampleCount).toBeGreaterThan(0);
  expect(exported.metrics.render.sampleCount).toBeGreaterThan(0);
  expect(exported.metrics.frame.p95Ms).toBeGreaterThanOrEqual(exported.metrics.frame.medianMs);
  await expect(page.locator('#baseline-diagnostics')).toContainText('WP-01 DIAGNOSTICS');

  const direct = await page.evaluate(() => {
    window.gameAPI.resetDiagnostics({ runId: 'direct-test' });
    return window.gameAPI.runBaselineDiagnosticFrames(5, 0);
  });
  expect(direct.metrics.frame.sampleCount).toBe(5);
  expect(direct.metrics.update.sampleCount).toBe(5);
  expect(direct.metrics.planner.sampleCount).toBe(5);
  expect(direct.metrics.render.sampleCount).toBe(5);
});

test('baseline: reference client boots when diagnostics.js is absent', async ({ page }) => {
  await page.route('**/src/diving-simulator.html', async route => {
    const response = await route.fetch();
    const body = (await response.text()).replace(
      /\s*<script src="diagnostics\.js"><\/script>/,
      ''
    );
    await route.fulfill({ response, body });
  });

  await page.goto('/src/diving-simulator.html');
  await page.waitForFunction(() => Boolean(window.gameAPI));
  expect(await page.evaluate(() => window.gameAPI.diagnosticsEnabled)).toBe(false);
  expect(await page.evaluate(() => window.gameAPI.exportDiagnostics())).toBeNull();

  await page.evaluate(() => {
    window.gameAPI.gameState = 'surface';
    window.gameAPI.setKeys({ s: true });
  });
  await page.waitForFunction(() => window.gameAPI.gameState === 'diving');
});

test('baseline: generated contracts are complete and internally consistent', async () => {
  const traces = readJson('tests/fixtures/traces/baseline-v1.json');
  const tests = readJson('docs/baseline/test-inventory.json');
  const features = readJson('docs/baseline/feature-inventory.json');
  const claims = readJson('docs/baseline/claims-register.json');
  const audio = readJson('docs/baseline/audio-inventory.json');
  const performance = readJson('artifacts/wp-01/desktop-reference/performance.json');
  const traceSchema = readJson('docs/baseline/schemas/trace.schema.json');
  const performanceSchema = readJson('docs/baseline/schemas/performance.schema.json');

  expect(traces.schemaVersion).toBe(1);
  expect(traces.referenceCommit).toBe('30c151f');
  expect(traces.scenarios.map(scenario => scenario.scenarioId)).toEqual([
    'air-18m-30min',
    'trimix-45m-20min',
    'ccr-30m-20min'
  ]);
  for (const scenario of traces.scenarios) {
    expect(scenario.checkpoints.length).toBeGreaterThan(0);
    for (const checkpoint of scenario.checkpoints) {
      expect(checkpoint.scenarioId).toBe(scenario.scenarioId);
      expect(checkpoint.tissues.n2_bar).toHaveLength(16);
      expect(checkpoint.tissues.he_bar).toHaveLength(16);
    }
  }

  expect(tests.legacyHarness.tests.length).toBeGreaterThan(300);
  const testIds = tests.legacyHarness.tests.map(entry => entry.id);
  expect(new Set(testIds).size).toBe(testIds.length);
  expect(features.sites.map(site => site.id)).toEqual(['shore', 'reef', 'wreck', 'cave']);
  expect(features.modes.map(mode => mode.id)).toEqual(['rec', 'tec', 'ccr']);
  expect(features.locales.map(locale => locale.id)).toEqual(['en', 'de']);

  const claimIds = claims.claims.map(claim => claim.id);
  expect(new Set(claimIds).size).toBe(claimIds.length);
  expect(claims.externalGates.domainReview).toBe('BLOCKED_EXTERNAL');
  expect(claims.externalGates.legalReview).toBe('BLOCKED_EXTERNAL');
  expect(audio.events.map(event => event.id)).toEqual([
    'alert.warning',
    'info.betterGas',
    'info.decoStopChanged'
  ]);
  expect(performance.sourceCommit).toMatch(/^[0-9a-f]{40}$/);
  expect(performance.acceptanceClass).toBe('desktop-synthetic-reference');
  expect(performance.runs).toHaveLength(12);
  for (const run of performance.runs) {
    expect(run.context.sourceCommit).toBe(performance.sourceCommit);
    expect(run.metrics.frame.sampleCount).toBe(300);
    expect(run.metrics.update.sampleCount).toBe(300);
    expect(run.metrics.planner.sampleCount).toBe(300);
    expect(run.metrics.render.sampleCount).toBe(300);
  }
  expect(traceSchema.properties.schemaVersion.const).toBe(1);
  expect(performanceSchema.properties.schemaVersion.const).toBe(1);
});

test('baseline: live checkpoint matches the generated surface fixture', async ({ page }) => {
  const traces = readJson('tests/fixtures/traces/baseline-v1.json');
  const expected = traces.scenarios[0].checkpoints[0];

  await page.goto('/src/diving-simulator.html');
  await page.waitForFunction(() => Boolean(window.gameAPI));
  const actual = await page.evaluate(() => {
    const api = window.gameAPI;
    api.diveMode = 'rec';
    api.tanks.length = 0;
    api.tankCount = 0;
    api.resetDive();
    api.initTissues();
    api.initCCR();
    api.pushTank(0.21, 0, 200);
    api.activeTank = 0;
    api.diveSite = 'shore';
    api.gameState = 'diving';
    return api.captureBaselineCheckpoint('air-18m-30min', 'surface');
  });

  expect(actual).toEqual(expected);
});
