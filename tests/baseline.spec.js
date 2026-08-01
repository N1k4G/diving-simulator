const fs = require('node:fs');
const path = require('node:path');
const Ajv2020 = require('ajv/dist/2020').default;
const addFormats = require('ajv-formats');
const { test, expect } = require('@playwright/test');
const { runBaselineScenarios } = require('../scripts/baseline-scenarios.cjs');
const { compareCheckpoint, epsilonFor } = require('./helpers/compare-checkpoint.cjs');

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
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validateTraces = ajv.compile(traceSchema);
  const validatePerformanceRun = ajv.compile(performanceSchema);

  expect(validateTraces(traces), ajv.errorsText(validateTraces.errors)).toBe(true);
  for (const run of performance.runs) {
    expect(
      validatePerformanceRun(run),
      ajv.errorsText(validatePerformanceRun.errors)
    ).toBe(true);
  }

  expect(traces.schemaVersion).toBe(1);
  expect(traces.referenceCommit).toMatch(/^[0-9a-f]{40}$/);
  expect(tests.referenceCommit).toBe(traces.referenceCommit);
  expect(traces.scenarios.map(scenario => scenario.scenarioId)).toEqual([
    'air-18m-30min',
    'trimix-45m-20min',
    'ccr-30m-30min',
    'ccr-bailout-30m'
  ]);
  for (const scenario of traces.scenarios) {
    expect(scenario.checkpoints.length).toBeGreaterThan(0);
    for (const checkpoint of scenario.checkpoints) {
      expect(checkpoint.scenarioId).toBe(scenario.scenarioId);
      expect(checkpoint.tissues.n2_bar).toHaveLength(16);
      expect(checkpoint.tissues.he_bar).toHaveLength(16);
    }
  }

  const [air, trimix, ccr, bailout] = traces.scenarios;
  expect(air.checkpoints[1].tanks[0].gasRemaining_l)
    .toBeLessThan(air.checkpoints[0].tanks[0].gasRemaining_l);
  expect(air.checkpoints[1].state.cns_percent).toBeGreaterThan(0);
  expect(air.checkpoints[1].state.safetyStop.needed).toBe(true);
  expect(air.checkpoints.at(-1).events.length).toBeGreaterThan(0);
  expect(trimix.checkpoints.at(-1).state.activeTankIndex).toBe(1);
  expect(ccr.checkpoints[1].ccr.o2Pressure_bar)
    .toBeLessThan(ccr.checkpoints[0].ccr.o2Pressure_bar);
  expect(bailout.checkpoints[2].ccr.onBailout).toBe(true);
  expect(bailout.checkpoints.at(-1).ccr.diluentPressure_bar)
    .toBeLessThan(bailout.checkpoints[2].ccr.diluentPressure_bar);

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

test('baseline: tolerance comparison supports exact paths, globs, and overrides', async () => {
  const policy = {
    exact: ['state.mode'],
    absoluteEpsilon: {
      default: 0.001,
      'tissues.*_bar': 0.01,
      'planner.ceiling_m': 0.000001
    }
  };
  expect(epsilonFor('tissues.n2_bar.0', policy)).toBe(0.01);
  expect(epsilonFor('planner.ceiling_m', policy)).toBe(0.000001);
  expect(compareCheckpoint(
    { state: { mode: 'tec' }, tissues: { n2_bar: [1] }, planner: { ceiling_m: 3 } },
    { state: { mode: 'tec' }, tissues: { n2_bar: [1.005] }, planner: { ceiling_m: 3.0000005 } },
    policy
  )).toEqual([]);
  expect(compareCheckpoint(
    { state: { mode: 'tec' }, tissues: { n2_bar: [1] }, planner: { ceiling_m: 3 } },
    { state: { mode: 'rec' }, tissues: { n2_bar: [1.02] }, planner: { ceiling_m: 3.00001 } },
    policy
  )).toHaveLength(3);
});

test('baseline: every live checkpoint matches its fixture within declared tolerances', async ({ page }) => {
  const traces = readJson('tests/fixtures/traces/baseline-v1.json');

  await page.goto('/src/diving-simulator.html');
  await page.waitForFunction(() => Boolean(window.gameAPI));
  await page.evaluate(() => { window.__baselineCapturePaused = true; });
  const actualScenarios = await page.evaluate(runBaselineScenarios);

  expect(actualScenarios).toHaveLength(traces.scenarios.length);
  for (let scenarioIndex = 0; scenarioIndex < traces.scenarios.length; scenarioIndex++) {
    const expectedScenario = traces.scenarios[scenarioIndex];
    const actualScenario = actualScenarios[scenarioIndex];
    expect(actualScenario.scenarioId).toBe(expectedScenario.scenarioId);
    expect(actualScenario.checkpoints).toHaveLength(expectedScenario.checkpoints.length);
    for (let checkpointIndex = 0; checkpointIndex < expectedScenario.checkpoints.length; checkpointIndex++) {
      const expected = expectedScenario.checkpoints[checkpointIndex];
      const actual = actualScenario.checkpoints[checkpointIndex];
      const failures = compareCheckpoint(expected, actual, traces.tolerances);
      expect(failures, `${expected.scenarioId}/${expected.checkpointId}\n${failures.join('\n')}`)
        .toEqual([]);
    }
  }
});
