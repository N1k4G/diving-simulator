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
    { site: 'Shore', x: 85, depth: 28, name: 'desktop-dive-shore-floor' },
    { site: 'Reef',  x: 0,  depth: 6,  name: 'desktop-dive-reef-plateau' },
    { site: 'Wreck', x: 92, depth: 32, name: 'desktop-dive-wreck-vehicle-deck' },
    { site: 'Wreck', x: 92, depth: 57, name: 'desktop-dive-wreck-engine-room' },
    { site: 'Cave',  x: 90, depth: 16, name: 'desktop-dive-cave-upper-tunnel' },
    // Issue #58: shared near-surface optics — sanity shots for the
    // shallow-water light effects (caustics + godrays + water underside
    // + boat shadow). Deep companions confirm the pass has faded to 0.
    { site: 'Shore', x: 85, depth: 4,  name: 'desktop-dive-shore-shallow-optics' },
    { site: 'Shore', x: 85, depth: 22, name: 'desktop-dive-shore-deep-no-optics' },
    { site: 'Reef',  x: 0,  depth: 5,  name: 'desktop-dive-reef-plateau-caustics' },
    { site: 'Reef',  x: 12, depth: 30, name: 'desktop-dive-reef-wall-no-optics' },
    { site: 'Cave',  x: 90, depth: 6,  name: 'desktop-dive-cave-entry-optics' },
    // Issue #43: parallax depth staggering — each site gets two shots at
    // different x-positions so the reviewer can compare the background/
    // midground silhouette offsets and confirm the layers move at
    // visibly different rates from the near geometry.
    { site: 'Shore', x: 70,  depth: 14, name: 'desktop-dive-shore-parallax-a' },
    { site: 'Shore', x: 100, depth: 14, name: 'desktop-dive-shore-parallax-b' },
    { site: 'Reef',  x: 14,  depth: 20, name: 'desktop-dive-reef-parallax-a' },
    { site: 'Reef',  x: 22,  depth: 20, name: 'desktop-dive-reef-parallax-b' },
    // Exterior, clear of the hull (x=210..400 is where the distant hull
    // mass / debris band anchor) so the new layers are actually on camera
    // instead of the ship's own interior deck geometry.
    { site: 'Wreck', x: 220, depth: 40, name: 'desktop-dive-wreck-parallax-a' },
    { site: 'Wreck', x: 240, depth: 40, name: 'desktop-dive-wreck-parallax-b' },
    // Cave cathedral is where the depth-layered speleothem silhouettes
    // are meant to trigger — sample there specifically.
    { site: 'Cave',  x: 90,  depth: 70, name: 'desktop-dive-cave-cathedral-parallax-a' },
    { site: 'Cave',  x: 108, depth: 70, name: 'desktop-dive-cave-cathedral-parallax-b' },
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
