import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const baseUrl = 'http://127.0.0.1:8080';
let server = null;

async function serverIsReady() {
  try {
    const response = await fetch(baseUrl);
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await serverIsReady()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`test server did not start on ${baseUrl}`);
}

function runPlaywright() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [require.resolve('@playwright/test/cli'), 'test', ...process.argv.slice(2)],
      {
        cwd: root,
        stdio: 'inherit',
        windowsHide: true,
        env: { ...process.env, PLAYWRIGHT_REUSE_SERVER: '1' }
      }
    );
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`Playwright exited via ${signal}`));
      else resolve(code ?? 1);
    });
  });
}

try {
  if (!(await serverIsReady())) {
    server = spawn(
      process.execPath,
      [require.resolve('http-server/bin/http-server'), root, '-p', '8080', '--silent'],
      { cwd: root, stdio: 'ignore', windowsHide: true }
    );
    await waitForServer();
  }
  process.exitCode = await runPlaywright();
} finally {
  if (server) {
    server.kill();
    server.unref();
  }
}
