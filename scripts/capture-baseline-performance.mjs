import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const port = 4174;
const baseUrl = `http://127.0.0.1:${port}`;
const cliArguments = process.argv.slice(2);
function argumentValue(name, fallback) {
  const index = cliArguments.indexOf(name);
  return index === -1 ? fallback : cliArguments[index + 1];
}

const sampleTarget = Number(argumentValue('--samples', '300'));
const runCount = Number(argumentValue('--runs', '3'));
const selectedSceneId = argumentValue('--scene', null);
const servedRoot = path.resolve(root, argumentValue('--serve-root', '.'));
const outputPath = path.resolve(
  root,
  argumentValue('--output', 'artifacts/wp-01/desktop-reference/performance.json')
);
const suspendedFrameThresholdMs = Number(argumentValue('--suspended-frame-threshold-ms', '1000'));
const comparisonSessionId = argumentValue('--comparison-session-id', null);
const captureStartedAt = new Date().toISOString();
const sourceCommit = argumentValue('--source-commit', null) || execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8'
}).trim();
const allScenes = [
  { id: 'shore-meadow', site: 'shore', x: 40, depth: 10, torch: false },
  { id: 'reef-plateau', site: 'reef', x: 0, depth: 5, torch: false },
  { id: 'wreck-engine-room', site: 'wreck', x: 102, depth: 58, torch: true },
  { id: 'cave-upper-tunnel', site: 'cave', x: 80, depth: 16, torch: true }
];
const scenes = selectedSceneId
  ? allScenes.filter(scene => scene.id === selectedSceneId)
  : allScenes;

if (!Number.isInteger(sampleTarget) || sampleTarget < 1) {
  throw new Error('--samples must be a positive integer');
}
if (!Number.isInteger(runCount) || runCount < 1) {
  throw new Error('--runs must be a positive integer');
}
if (!Number.isFinite(suspendedFrameThresholdMs) || suspendedFrameThresholdMs <= 0) {
  throw new Error('--suspended-frame-threshold-ms must be a positive number');
}
if (!scenes.length) {
  throw new Error(`unknown --scene value: ${selectedSceneId}`);
}

const server = spawn(
  process.execPath,
  [require.resolve('http-server/bin/http-server'), servedRoot, '-p', String(port), '--silent'],
  { cwd: servedRoot, stdio: 'ignore', windowsHide: true }
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
  throw new Error(`performance server did not start on ${baseUrl}`);
}

try {
  await waitForServer();
  const browser = await chromium.launch({
    env: {
      ...process.env,
      CHROME_LOG_FILE: path.join(os.tmpdir(), 'diving-simulator-performance-chrome.log')
    }
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 759, height: 839 },
      deviceScaleFactor: 1
    });
    const runs = [];

    for (const scene of scenes) {
      for (let run = 1; run <= runCount; run++) {
        let capturedRun = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
          console.log(`capturing ${scene.id} run ${run}/${runCount} attempt ${attempt}/3`);
          await page.goto(`${baseUrl}/src/diving-simulator.html?diagnostics=1&diagnosticsOverlay=0`);
          await page.waitForFunction(() => Boolean(window.gameAPI));
          capturedRun = await page.evaluate(async ({ sceneConfig, runNumber, commit, target }) => {
          const api = window.gameAPI;
          api.gameState = 'diving';
          api.diveMode = 'rec';
          api.diveSite = sceneConfig.site;
          api.diverX = sceneConfig.x;
          api.setDepth(sceneConfig.depth);
          api.maxDepth = sceneConfig.depth;
          api.verticalVelocity = 0;
          api.horizontalVelocity = 0;
          api.torchOn = sceneConfig.torch;
          api.visibility = 1;
          api.shark = null;
          api.sharkTimer = 1e9;
          api.drillsEnabled = false;
          api.current.active = false;
          api.current.rolledThisDive = true;
          const context = {
            runId: `${sceneConfig.id}-${runNumber}`,
            sceneId: sceneConfig.id,
            sourceCommit: commit,
            acceptanceClass: 'relative-hotspot-ranking'
          };
          window.__baselineCapturePaused = true;
          try {
            api.resetDiagnostics({ warmupFor: context.runId });
            for (let frame = 0; frame < 30; frame++) {
              api.runBaselineDiagnosticFrames(1, 0);
              await new Promise(resolve => setTimeout(resolve, 0));
            }
            api.resetDiagnostics(context);
            for (let frame = 0; frame < target; frame++) {
              api.runBaselineDiagnosticFrames(1, 0);
              await new Promise(resolve => setTimeout(resolve, 0));
            }
            return api.exportDiagnostics();
          } finally {
            window.__baselineCapturePaused = false;
          }
          }, {
            sceneConfig: scene,
            runNumber: run,
            commit: sourceCommit,
            target: sampleTarget
          });

          if (capturedRun.metrics.frame.maxMs < suspendedFrameThresholdMs) break;
          console.warn(
            `discarding ${scene.id} run ${run}: frame max ` +
            `${capturedRun.metrics.frame.maxMs.toFixed(1)} ms indicates host suspension`
          );
          capturedRun = null;
        }
        if (!capturedRun) {
          throw new Error(
            `${scene.id} run ${run} exceeded the ${suspendedFrameThresholdMs} ms ` +
            'host-suspension threshold on all three attempts'
          );
        }
        runs.push(capturedRun);
        console.log(`completed ${scene.id} run ${run}/${runCount}`);
      }
    }

    const artifact = {
      schemaVersion: 1,
      kind: 'diving-simulator-performance-baseline',
      sourceCommit,
      generatedBy: `npm run baseline:perf -- ${cliArguments.join(' ')}`.trim(),
      acceptanceClass: 'relative-hotspot-ranking',
      captureStartedAt,
      ...(comparisonSessionId ? { comparisonSessionId } : {}),
      acceptanceLimitations: [
        'Headless desktop Chromium is diagnostic evidence only.',
        'This artifact does not satisfy any physical Android or iOS gate.',
        'Same-harness developer-machine sessions varied roughly 3x for unchanged wreck renderer code (49.3-53.4 ms versus 146.7-153.4 ms medians); broader recorded evidence ranges from 14.2 ms to 153.4 ms. This artifact ranks scene cost and does not establish an absolute frame time.',
        'Before/after timing comparisons are valid only when captured back to back in the same session; comparing a fresh capture with a committed artifact from an earlier session is invalid.',
        'The update metric uses dtReal=0 to isolate CPU cost; it is not representative of a live simulation tick.'
      ],
      sampling: {
        warmedSamplesPerRun: sampleTarget,
        independentRunsPerScene: runCount,
        frameBudgetMs: 16.67
      },
      scenes,
      runs
    };
    const outputDirectory = path.dirname(outputPath);
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(
      outputPath,
      `${JSON.stringify(artifact, null, 2)}\n`,
      'utf8'
    );
  } finally {
    await browser.close();
  }
} finally {
  server.kill();
  server.unref();
}
