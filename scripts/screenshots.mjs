// ============================================================
// scripts/screenshots.mjs
// PURPOSE: Capture a few representative screenshots of the diving
//          simulator (phone + desktop, setup + in-dive) so a pull
//          request can be reviewed visually. Run in CI via
//          `npm run screenshots`; output lands in ./screenshots.
//
// Uses the chromium build that ships with @playwright/test, so it
// needs no extra dependency beyond what `npm test` already installs.
// ============================================================
import { chromium } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const pageUrl = 'file://' + path.join(root, 'src', 'diving-simulator.html').replace(/\\/g, '/');
const outDir = path.join(root, 'screenshots');
fs.mkdirSync(outDir, { recursive: true });

const PHONE = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 ' +
    '(KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
};
const DESKTOP = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 };

// Drive the gas-setup screen to an in-dive scene at a fixed camera so the
// shot is deterministic regardless of timing.
async function startDive(page, { site, x, depth }) {
  // The HTML gas-setup overlay is the active setup UI on both phone and
  // desktop, so drive it the same way in both: pick the site, hit Start Dive.
  try {
    await page.locator('#html-gas-setup button', { hasText: new RegExp(`^${site}$`, 'i') }).click();
  } catch { /* site button optional */ }
  await page.locator('#html-gas-setup button:visible', { hasText: /Start Dive/i }).first().click();
  await page.waitForTimeout(400);
  // surface -> diving
  await page.keyboard.down('s');
  await page.waitForTimeout(1200);
  await page.keyboard.up('s');
  // Pin the camera to a flattering spot and let a couple of frames settle.
  // diverX / depth are top-level bindings, assignable from page scope.
  await page.evaluate(({ x, d }) => {
    try { diverX = x; } catch {}
    try { depth = d; } catch {}
    try { verticalVelocity = 0; horizontalVelocity = 0; } catch {}
  }, { x, d: depth });
  await page.waitForTimeout(600);
}

async function shot(page, name) {
  const file = path.join(outDir, name + '.png');
  await page.screenshot({ path: file });
  console.log('  wrote', path.relative(root, file));
}

async function run() {
  const browser = await chromium.launch();
  const errors = [];

  // ---- Phone: setup + reef dive ----
  {
    const ctx = await browser.newContext(PHONE);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push('[phone] ' + e));
    await page.goto(pageUrl, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);
    await shot(page, 'phone-setup');
    await startDive(page, { site: 'Reef', x: 11, depth: 20 });
    await shot(page, 'phone-dive-reef');
    await ctx.close();
  }

  // ---- Desktop: setup + all authored dive sites ----
  {
    const ctx = await browser.newContext(DESKTOP);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push('[desktop] ' + e));
    await page.goto(pageUrl, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);
    await shot(page, 'desktop-setup');
    await ctx.close();
  }

  const desktopDiveShots = [
    { site: 'Shore', x: 85, depth: 12, name: 'desktop-dive-shore' },
    { site: 'Reef',  x: 11, depth: 20, name: 'desktop-dive-reef' },
    { site: 'Wreck', x: 60, depth: 24, name: 'desktop-dive-wreck' },
    { site: 'Wreck', x: 92, depth: 36, name: 'desktop-dive-wreck-wide' },
    { site: 'Cave',  x: 90, depth: 24, name: 'desktop-dive-cave' },
  ];

  for (const diveShot of desktopDiveShots) {
    const ctx = await browser.newContext(DESKTOP);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`[desktop ${diveShot.site}] ` + e));
    await page.goto(pageUrl, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    await startDive(page, diveShot);
    await shot(page, diveShot.name);
    await ctx.close();
  }

  await browser.close();

  if (errors.length) {
    console.error('Page errors during screenshot run:\n' + errors.join('\n'));
    process.exit(1);
  }
  console.log('Screenshots written to', path.relative(root, outDir));
}

run().catch((e) => { console.error(e); process.exit(1); });
