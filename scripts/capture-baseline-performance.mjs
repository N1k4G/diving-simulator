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
const sampleTarget = 300;
const runCount = 3;
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8'
}).trim();

const scenes = [
  { id: 'shore-meadow', site: 'shore', x: 40, depth: 10, torch: false },
  { id: 'reef-plateau', site: 'reef', x: 0, depth: 5, torch: false },
  { id: 'wreck-engine-room', site: 'wreck', x: 102, depth: 58, torch: true },
  { id: 'cave-upper-tunnel', site: 'cave', x: 80, depth: 16, torch: true }
];

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
        console.log(`capturing ${scene.id} run ${run}/${runCount}`);
        await page.goto(`${baseUrl}/src/diving-simulator.html?diagnostics=1`);
        await page.waitForFunction(() => Boolean(window.gameAPI));
        runs.push(await page.evaluate(({ sceneConfig, runNumber, commit, target }) => {
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
            acceptanceClass: 'desktop-synthetic-reference'
          };
          api.resetDiagnostics({ warmupFor: context.runId });
          api.runBaselineDiagnosticFrames(30, 0);
          api.resetDiagnostics(context);
          return api.runBaselineDiagnosticFrames(target, 0);
        }, {
          sceneConfig: scene,
          runNumber: run,
          commit: sourceCommit,
          target: sampleTarget
        }));
        console.log(`completed ${scene.id} run ${run}/${runCount}`);
      }
    }

    const artifact = {
      schemaVersion: 1,
      kind: 'diving-simulator-performance-baseline',
      sourceCommit,
      generatedBy: 'npm run baseline:perf',
      acceptanceClass: 'desktop-synthetic-reference',
      acceptanceLimitations: [
        'Headless desktop Chromium is diagnostic evidence only.',
        'This artifact does not satisfy any physical Android or iOS gate.',
        'Compare changes only on the same machine, browser build, viewport and DPR.'
      ],
      sampling: {
        warmedSamplesPerRun: sampleTarget,
        independentRunsPerScene: runCount,
        frameBudgetMs: 16.67
      },
      scenes,
      runs
    };
    const outputDirectory = path.join(root, 'artifacts', 'wp-01', 'desktop-reference');
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(
      path.join(outputDirectory, 'performance.json'),
      `${JSON.stringify(artifact, null, 2)}\n`,
      'utf8'
    );
  } finally {
    await browser.close();
  }
} finally {
  server.kill();
}
