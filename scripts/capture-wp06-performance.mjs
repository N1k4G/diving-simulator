import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const distRoot = path.join(root, 'dist');
const port = 4175;
const baseUrl = `http://127.0.0.1:${port}`;
const cliArguments = process.argv.slice(2);

function argumentValue(name, fallback) {
  const index = cliArguments.indexOf(name);
  return index === -1 ? fallback : cliArguments[index + 1];
}

const sampleTarget = Number(argumentValue('--samples', '600'));
const outputPath = path.resolve(
  root,
  argumentValue(
    '--output',
    'artifacts/wp-06/desktop-reference/performance.json',
  ),
);
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
}).trim();

if (!Number.isInteger(sampleTarget) || sampleTarget < 60) {
  throw new Error('--samples must be an integer of at least 60');
}

const server = spawn(
  process.execPath,
  [
    require.resolve('http-server/bin/http-server'),
    distRoot,
    '-p',
    String(port),
    '--silent',
  ],
  { cwd: distRoot, stdio: 'ignore', windowsHide: true },
);

async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      // The local server normally needs a few polls on Windows.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`performance server did not start on ${baseUrl}`);
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return null;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * fraction) - 1),
  );
  return sorted[index];
}

function summarizeFrames(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  const longFrameCount = samples.filter(value => value > 33).length;
  return {
    sampleCount: samples.length,
    minMs: sorted[0] ?? null,
    medianMs: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    maxMs: sorted.at(-1) ?? null,
    longFrameCount,
    longFramePercent: (longFrameCount / samples.length) * 100,
  };
}

async function directorySize(directory) {
  let totalBytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    totalBytes += entry.isDirectory()
      ? await directorySize(entryPath)
      : (await stat(entryPath)).size;
  }
  return totalBytes;
}

try {
  await waitForServer();
  const browser = await chromium.launch({
    args: ['--enable-precise-memory-info'],
    env: {
      ...process.env,
      CHROME_LOG_FILE: path.join(
        os.tmpdir(),
        'diving-simulator-wp06-performance-chrome.log',
      ),
    },
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
      locale: 'en-US',
    });
    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    const navigation = await page.evaluate(() => {
      const entry = performance.getEntriesByType('navigation')[0];
      return entry
        ? {
            responseEndMs: entry.responseEnd,
            domInteractiveMs: entry.domInteractive,
            loadEventEndMs: entry.loadEventEnd,
          }
        : null;
    });
    const rendererStartedAtMs = await page.evaluate(() => performance.now());
    await page.locator('[data-accept-safety]').click();
    await page.locator('[data-renderer=pixi] canvas').waitFor();
    const rendererReadyMs =
      (await page.evaluate(() => performance.now())) - rendererStartedAtMs;
    const memoryBefore = await page.evaluate(() => {
      const memory = performance.memory;
      return memory
        ? {
            usedJsHeapBytes: memory.usedJSHeapSize,
            totalJsHeapBytes: memory.totalJSHeapSize,
          }
        : null;
    });

    await page.keyboard.down('ArrowRight');
    await page.waitForTimeout(12_250);
    await page.keyboard.up('ArrowRight');
    await page.getByText('Engine room').waitFor();

    const frameSamples = await page.evaluate(target =>
      new Promise(resolve => {
        const samples = [];
        let previous = null;
        const sample = now => {
          if (previous !== null) {
            samples.push(now - previous);
          }
          previous = now;
          if (samples.length >= target) {
            resolve(samples);
          } else {
            requestAnimationFrame(sample);
          }
        };
        requestAnimationFrame(sample);
      }), sampleTarget,
    );
    const memoryAfter = await page.evaluate(() => {
      const memory = performance.memory;
      return memory
        ? {
            usedJsHeapBytes: memory.usedJSHeapSize,
            totalJsHeapBytes: memory.totalJSHeapSize,
          }
        : null;
    });

    const artifact = {
      schemaVersion: 1,
      kind: 'diving-simulator-wp06-performance',
      sourceCommit,
      capturedAt: new Date().toISOString(),
      generatedBy: `npm run wp06:perf -- ${cliArguments.join(' ')}`.trim(),
      acceptanceClass: 'desktop-synthetic-reference',
      acceptanceLimitations: [
        'Headless desktop Chromium is diagnostic evidence only.',
        'requestAnimationFrame cadence includes scheduler time and is not a GPU trace.',
        'Chromium JS heap excludes GPU allocations and native process memory.',
        'This artifact does not satisfy any physical Android or iOS gate.',
      ],
      environment: {
        platform: `${os.platform()} ${os.release()}`,
        cpu: os.cpus()[0]?.model ?? 'unknown',
        logicalCpuCount: os.cpus().length,
        totalSystemMemoryBytes: os.totalmem(),
        userAgent: await page.evaluate(() => navigator.userAgent),
        viewportCssPx: { width: 1280, height: 800 },
        devicePixelRatio: await page.evaluate(() => devicePixelRatio),
      },
      scenario: {
        id: 'wreck-engine-room',
        renderer: 'pixi',
        warmedRouteSeconds: 12.25,
        measuredFrames: sampleTarget,
      },
      budgets: {
        renderP95Ms: 16.67,
        longFrameThresholdMs: 33,
        longFrameMaximumPercent: 1,
        coldStartMaximumMs: 3_000,
        installedSizeMaximumBytes: 150 * 1024 * 1024,
      },
      startup: {
        navigation,
        rendererReadyAfterAcceptanceMs: rendererReadyMs,
      },
      frames: summarizeFrames(frameSamples),
      memory: {
        before: memoryBefore,
        after: memoryAfter,
      },
      package: {
        distBytes: await directorySize(distRoot),
      },
    };

    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    console.log(`wrote ${path.relative(root, outputPath)}`);
  } finally {
    await browser.close();
  }
} finally {
  server.kill();
  server.unref();
}
