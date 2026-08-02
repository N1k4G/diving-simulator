import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const cliArguments = process.argv.slice(2);

function argumentValue(name) {
  const index = cliArguments.indexOf(name);
  if (index === -1 || !cliArguments[index + 1]) {
    throw new Error(`missing required argument ${name}`);
  }
  return cliArguments[index + 1];
}

async function readJson(filePath) {
  return JSON.parse(await readFile(path.resolve(root, filePath), 'utf8'));
}

function percentChange(before, after) {
  if (before === 0) return after === 0 ? 0 : null;
  return (after - before) * 100 / before;
}

function regressedMoreThan(before, after, limitPercent) {
  if (before === 0) return after > 0;
  return percentChange(before, after) > limitPercent;
}

function environmentKey(run) {
  return JSON.stringify(run.environment);
}

const beforePaths = argumentValue('--before').split(',');
const afterPath = argumentValue('--after');
const outputDirectory = path.resolve(root, argumentValue('--output'));
const beforeParts = await Promise.all(beforePaths.map(readJson));
const after = await readJson(afterPath);
const beforeRuns = beforeParts.flatMap(part => part.runs);
const beforeScenes = beforeParts.flatMap(part => part.scenes);
const expectedScenes = ['shore-meadow', 'reef-plateau', 'wreck-engine-room', 'cave-upper-tunnel'];
const targetScenes = ['wreck-engine-room', 'cave-upper-tunnel'];
const metricFields = [
  'minMs',
  'medianMs',
  'p95Ms',
  'p99Ms',
  'maxMs',
  'longFrameCount',
  'totalTimeAboveBudgetMsPer1000'
];

if (beforeParts.some(part => part.acceptanceClass !== 'relative-hotspot-ranking') ||
    after.acceptanceClass !== 'relative-hotspot-ranking') {
  throw new Error('before and after captures must use the relative-hotspot-ranking acceptance class');
}
const comparisonSessionId = after.comparisonSessionId;
if (!comparisonSessionId || beforeParts.some(part => part.comparisonSessionId !== comparisonSessionId)) {
  throw new Error('before and after captures must share a non-empty --comparison-session-id');
}
const beforeCaptureTimes = beforeParts.map(part => Date.parse(part.captureStartedAt));
const afterCaptureTime = Date.parse(after.captureStartedAt);
if (beforeCaptureTimes.some(time => !Number.isFinite(time)) || !Number.isFinite(afterCaptureTime)) {
  throw new Error('before and after captures must record captureStartedAt');
}
const earliestCaptureTime = Math.min(...beforeCaptureTimes);
const latestBeforeCaptureTime = Math.max(...beforeCaptureTimes);
const latestCaptureTime = Math.max(...beforeCaptureTimes, afterCaptureTime);
if (latestCaptureTime - earliestCaptureTime > 30 * 60 * 1000) {
  throw new Error('before and after captures must start within the same 30-minute comparison window');
}
if (afterCaptureTime < latestBeforeCaptureTime) {
  throw new Error('the after capture must start after every before capture');
}
if (beforeParts.some(part => part.sourceCommit !== beforeParts[0].sourceCommit)) {
  throw new Error('all before captures must use the same source commit');
}
if (beforeParts[0].sourceCommit === after.sourceCommit) {
  throw new Error('before and after captures must identify different source commits');
}
const allRuns = [...beforeRuns, ...after.runs];
if (!allRuns.length || allRuns.some(run => environmentKey(run) !== environmentKey(allRuns[0]))) {
  throw new Error('before and after runs must use the same browser, viewport, and DPR');
}
for (const [label, runs] of [['before', beforeRuns], ['after', after.runs]]) {
  const runIds = new Set(runs.map(run => run.context.runId));
  if (runs.length !== expectedScenes.length * 3 || runIds.size !== runs.length) {
    throw new Error(`${label} capture must contain exactly 12 unique runs`);
  }
  for (const sceneId of expectedScenes) {
    for (let run = 1; run <= 3; run++) {
      if (!runIds.has(`${sceneId}-${run}`)) {
        throw new Error(`${label} capture is missing ${sceneId}-${run}`);
      }
    }
  }
}

const before = {
  ...beforeParts[0],
  kind: 'diving-simulator-performance-before',
  generatedBy: 'node scripts/compare-performance.mjs',
  sourceCommit: beforeParts[0].sourceCommit,
  scenes: beforeScenes,
  runs: beforeRuns,
  harness: {
    yieldedBetweenSamples: true,
    diagnosticsOverlay: false,
    backgroundAnimationLoopPaused: true,
    note: 'The same measurement-only harness adjustments were applied to the baseline source commit and the optimized commit.'
  }
};

const comparisons = after.runs.map(afterRun => {
  const beforeRun = beforeRuns.find(run => run.context.runId === afterRun.context.runId);
  if (!beforeRun) throw new Error(`missing before run ${afterRun.context.runId}`);
  if (beforeRun.metrics.render.sampleCount !== 300 || afterRun.metrics.render.sampleCount !== 300) {
    throw new Error(`run ${afterRun.context.runId} does not contain exactly 300 render samples`);
  }
  const metrics = {};
  for (const metricName of ['frame', 'update', 'planner', 'render']) {
    metrics[metricName] = {};
    for (const field of metricFields) {
      metrics[metricName][field] = {
        before: beforeRun.metrics[metricName][field],
        after: afterRun.metrics[metricName][field],
        changePercent: percentChange(
          beforeRun.metrics[metricName][field],
          afterRun.metrics[metricName][field]
        )
      };
    }
  }
  return {
    runId: afterRun.context.runId,
    sceneId: afterRun.context.sceneId,
    metrics
  };
});

const targetRuns = comparisons.filter(run => targetScenes.includes(run.sceneId));
const runGates = targetRuns.map(run => {
  const render = run.metrics.render;
  const p95Improvement = -(render.p95Ms.changePercent || 0);
  const longFrameImprovement = -(render.longFrameCount.changePercent || 0);
  const primaryPassed = p95Improvement >= 20 || longFrameImprovement >= 50;
  const regressions = metricFields.filter(field => {
    return regressedMoreThan(render[field].before, render[field].after, 5);
  });
  return {
    runId: run.runId,
    p95ImprovementPercent: p95Improvement,
    longFrameImprovementPercent: longFrameImprovement,
    primaryPassed,
    regressions,
    passed: primaryPassed && regressions.length === 0
  };
});

const comparison = {
  schemaVersion: 1,
  kind: 'diving-simulator-performance-comparison',
  beforeSourceCommit: before.sourceCommit,
  afterSourceCommit: after.sourceCommit,
  acceptanceClass: after.acceptanceClass,
  comparisonSessionId,
  captureWindow: {
    beforeStartedAt: before.captureStartedAt,
    afterStartedAt: after.captureStartedAt
  },
  targetScenes,
  gate: {
    minimumWarmedSamplesPerRun: 300,
    independentRunsPerScene: 3,
    primary: 'render p95 improves by at least 20% or render long-frame count improves by at least 50%',
    regressionGuard: 'No reported render metric in either targeted scene regresses by more than 5%',
    passed: runGates.every(run => run.passed),
    runs: runGates
  },
  comparisons
};

const reportLines = [
  '# WP-01B desktop relative-hotspot comparison',
  '',
  `Before: \`${before.sourceCommit}\``,
  '',
  `After: \`${after.sourceCommit}\``,
  '',
  `Comparison session: \`${comparisonSessionId}\``,
  '',
  `Captures started at ${before.captureStartedAt} and ${after.captureStartedAt}.`,
  '',
  'This is back-to-back, yielded headless Chromium relative-hotspot evidence at 759 x 839 CSS px and DPR 1. It is not physical-device acceptance.',
  '',
  '| Scene / run | Render median | Render p95 | Long frames | Gate |',
  '| --- | ---: | ---: | ---: | --- |'
];

for (const run of comparisons) {
  const render = run.metrics.render;
  const gate = runGates.find(entry => entry.runId === run.runId);
  reportLines.push(
    `| ${run.runId} | ${render.medianMs.before.toFixed(1)} -> ${render.medianMs.after.toFixed(1)} ms (${render.medianMs.changePercent.toFixed(1)}%) | ` +
    `${render.p95Ms.before.toFixed(1)} -> ${render.p95Ms.after.toFixed(1)} ms (${render.p95Ms.changePercent.toFixed(1)}%) | ` +
    `${render.longFrameCount.before} -> ${render.longFrameCount.after} | ${gate ? (gate.passed ? 'PASS' : 'FAIL') : 'guard scene'} |`
  );
}

reportLines.push(
  '',
  `Corrected WP-01B gate: **${comparison.gate.passed ? 'PASS' : 'FAIL'}**.`,
  '',
  'The authoritative golden trace was regenerated; its numerical scenario payload remained unchanged.'
);

await mkdir(outputDirectory, { recursive: true });
await writeFile(path.join(outputDirectory, 'before.json'), `${JSON.stringify(before, null, 2)}\n`, 'utf8');
await writeFile(path.join(outputDirectory, 'comparison.json'), `${JSON.stringify(comparison, null, 2)}\n`, 'utf8');
await writeFile(path.join(outputDirectory, 'report.md'), `${reportLines.join('\n')}\n`, 'utf8');

if (!comparison.gate.passed) process.exitCode = 1;
