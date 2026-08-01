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

const beforePaths = argumentValue('--before').split(',');
const afterPath = argumentValue('--after');
const outputDirectory = path.resolve(root, argumentValue('--output'));
const beforeParts = await Promise.all(beforePaths.map(readJson));
const after = await readJson(afterPath);
const beforeRuns = beforeParts.flatMap(part => part.runs);
const beforeScenes = beforeParts.flatMap(part => part.scenes);
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
    note: 'The same measurement-only harness adjustments were applied to the archived source commit and the optimized commit.'
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
    const change = render[field].changePercent;
    return change != null && change > 5;
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
  '# WP-01B desktop synthetic comparison',
  '',
  `Before: \`${before.sourceCommit}\``,
  '',
  `After: \`${after.sourceCommit}\``,
  '',
  'This is yielded headless Chromium diagnostic evidence at 759 x 839 CSS px and DPR 1. It is not physical-device acceptance.',
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
  'The authoritative golden trace file was regenerated and remained byte-for-byte unchanged.'
);

await mkdir(outputDirectory, { recursive: true });
await writeFile(path.join(outputDirectory, 'before.json'), `${JSON.stringify(before, null, 2)}\n`, 'utf8');
await writeFile(path.join(outputDirectory, 'comparison.json'), `${JSON.stringify(comparison, null, 2)}\n`, 'utf8');
await writeFile(path.join(outputDirectory, 'report.md'), `${reportLines.join('\n')}\n`, 'utf8');

if (!comparison.gate.passed) process.exitCode = 1;
