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
async function startDive(page, { site, x, depth, torch, facing, pinVisibility }) {
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
  // torch/facing are optional overrides used by issue #31 shots so we can
  // capture the directional cone reorienting with the diver's facing.
  await page.evaluate(({ x, d, torch, facing, pinVisibility }) => {
    try { diverX = x; } catch {}
    try { depth = d; } catch {}
    try { verticalVelocity = 0; horizontalVelocity = 0; } catch {}
    if (torch != null) {
      try { window.gameAPI.torchOn = !!torch; } catch {}
    }
    if (facing === 1 || facing === -1) {
      try { window.gameAPI.diverFacing = facing; } catch {}
    }
    if (pinVisibility != null) {
      try { window.gameAPI.visibility = pinVisibility; } catch {}
    }
  }, { x, d: depth, torch, facing, pinVisibility });
  // Let the render loop settle. For overhead sites the darkness ramp
  // (_torchDark) and wreck-metal ramp (_wreckMetal) ease in over ~50
  // frames; force them AND `inOverhead` to fully-in every frame for a
  // few animation ticks so the very next screenshot captures the fully-
  // established torch cone / interior view. (drawScene() re-nudges
  // _wreckMetal toward `inOverhead ? 1 : 0` every frame, so forcing it
  // once is not enough — force it via a short rAF pump.)
  await page.waitForTimeout(400);
  const wantInside = site.toLowerCase() === 'wreck' || site.toLowerCase() === 'cave';
  if (wantInside) {
    await page.evaluate(async (pv) => {
      const pin = () => {
        try {
          inOverhead = true;
          if (typeof _torchDark !== 'undefined')  _torchDark  = 1;
          if (typeof _wreckMetal !== 'undefined') _wreckMetal = 1;
          if (pv != null) {
            // Physics ticks between our render calls will nudge visibility
            // back toward 1 via SILT_RECOVER; re-pin every frame so the
            // heavy-silt screenshot is representative.
            try { window.gameAPI.visibility = pv; } catch {}
          }
        } catch {}
      };
      // Pump ~6 frames so any interleaved physics/render updates settle.
      for (let i = 0; i < 6; i++) {
        pin();
        await new Promise(r => requestAnimationFrame(r));
      }
      pin();  // one more just before returning control
    }, pinVisibility);
  }
  await page.waitForTimeout(150);
  // Final re-pin of pinVisibility right before the screenshot so the
  // 150 ms wait above hasn't let SILT_RECOVER creep it back to clear.
  if (pinVisibility != null) {
    await page.evaluate((pv) => {
      try { window.gameAPI.visibility = pv; } catch {}
    }, pinVisibility);
    await page.waitForTimeout(30);   // one render frame to reflect the pin
  }
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
    // Issue #35: reef coral individualization — proof shots. The pair
    // shots frame two same-species corals close together (staghorn at
    // x=-2 & x=1; tableCoral at x=-4 & x=2) so a reviewer can eyeball
    // that the two visibly differ. Density/mid/deep shots show the
    // depth-zone staggering (plateau densest → deep sparsest).
    { site: 'Reef',  x: -2, depth: 5,  name: 'desktop-dive-reef-plateau-pair-staghorn' },
    { site: 'Reef',  x: -4, depth: 5,  name: 'desktop-dive-reef-plateau-pair-table' },
    { site: 'Reef',  x: 0,  depth: 5,  name: 'desktop-dive-reef-plateau-density' },
    { site: 'Reef',  x: 13, depth: 37, name: 'desktop-dive-reef-mid-wall' },
    { site: 'Reef',  x: 16, depth: 60, name: 'desktop-dive-reef-deep-sentinel' },
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
    // Issue #31: Directional torch cone + backscatter. Facing-left vs
    // facing-right pairs on both cave AND wreck so reviewers can confirm
    // the cone visibly REORIENTS with _diverFacing (not just a slightly-
    // offset circle). Also a wreck torch-OFF baseline so the interior
    // glow/backscatter delta is visible.
    { site: 'Cave',  x: 90, depth: 24, torch: true,  facing:  1, name: 'desktop-dive-cave-torch-cone-right' },
    { site: 'Cave',  x: 90, depth: 24, torch: true,  facing: -1, name: 'desktop-dive-cave-torch-cone-left' },
    // Wreck at vehicle deck (x=92, depth=32) puts the diver INSIDE the
    // hull so drawWreckHullSkin actually punches the cone. Depth 24 sits
    // above the deck line in open water and would show no interior.
    { site: 'Wreck', x: 92, depth: 32, torch: true,  facing:  1, name: 'desktop-dive-wreck-torch-cone-right' },
    { site: 'Wreck', x: 92, depth: 32, torch: true,  facing: -1, name: 'desktop-dive-wreck-torch-cone-left' },
    { site: 'Wreck', x: 92, depth: 32, torch: false, facing:  1, name: 'desktop-dive-wreck-torch-off-baseline' },
    // Issue #36: depth-dependent color absorption. Reef x=16,d=60 puts a
    // hand-placed red gorgonian (src/sites.js, exactly the feature the
    // issue text calls out) in frame. Shallow shot is the full-saturation
    // baseline; deep-no-torch should read blue-grey; deep-with-torch
    // should restore red near the diver.
    { site: 'Reef',  x: 0,  depth: 5,  torch: false, name: 'desktop-dive-reef-colors-shallow-baseline' },
    { site: 'Reef',  x: 10, depth: 60, torch: false, name: 'desktop-dive-reef-colors-deep-no-torch' },
    { site: 'Reef',  x: 10, depth: 60, torch: true,  name: 'desktop-dive-reef-colors-deep-torch-restore' },
    { site: 'Wreck', x: 92, depth: 32, torch: false, facing: 1, name: 'desktop-dive-wreck-colors-no-torch' },
    { site: 'Wreck', x: 92, depth: 32, torch: true,  facing: 1, name: 'desktop-dive-wreck-colors-torch-restore' },
    // Issue #42: fauna clipping fix. Fauna positions are randomised by
    // design, so any single screenshot is inherently weak evidence — the
    // logic checks in TC-42-* are the real verification. These vantage
    // points sit near solid terrain (reef rock mesa at x=0, wreck interior,
    // cave bedrock area) so IF a fish/wildlife happens to be in frame the
    // reviewer can spot-check that it isn't clipping through geometry.
    { site: 'Reef',  x: 0,   depth: 8,  name: 'desktop-dive-reef-fauna-near-mesa' },
    { site: 'Wreck', x: 92,  depth: 40, name: 'desktop-dive-wreck-fauna-interior' },
    { site: 'Cave',  x: 100, depth: 30, name: 'desktop-dive-cave-fauna-bedrock-area' },
    // Issue #33: wreck visual polish — ferry silhouette read + interior
    // areas (line/net cues visible; object-distance + torch-relative
    // lighting affecting readability). Exterior shots frame the ship
    // outline from open water so the raked bow reads. Interior shots
    // sample each deck. Torch-on vs torch-off pair at the vehicle deck
    // shows the object-lighting swing without a second cone effect.
    { site: 'Wreck', x: 25,  depth: 24, torch: false, facing:  1, name: 'desktop-dive-wreck-33-exterior-bow' },
    { site: 'Wreck', x: 90,  depth: 20, torch: false, facing:  1, name: 'desktop-dive-wreck-33-bridge-accommodation' },
    { site: 'Wreck', x: 50,  depth: 32, torch: true,  facing:  1, name: 'desktop-dive-wreck-33-vehicle-deck-torch-on' },
    { site: 'Wreck', x: 50,  depth: 32, torch: false, facing:  1, name: 'desktop-dive-wreck-33-vehicle-deck-torch-off' },
    { site: 'Wreck', x: 100, depth: 50, torch: true,  facing:  1, name: 'desktop-dive-wreck-33-cargo-hold' },
    { site: 'Wreck', x: 100, depth: 58, torch: true,  facing:  1, name: 'desktop-dive-wreck-33-engine-room' },
    // Line/net feature focus — vehicle deck net (~x=100 d=32) and the
    // crew-deck net + line cluster near port aft (~x=118 d=41).
    { site: 'Wreck', x: 100, depth: 32, torch: true,  facing:  1, name: 'desktop-dive-wreck-33-vehicle-deck-net' },
    { site: 'Wreck', x: 118, depth: 41, torch: true,  facing:  1, name: 'desktop-dive-wreck-33-crew-deck-net-line' },
    // Issue #32: cave visual polish.
    //   • BAD-AIR LENS: pocket is at x=103..109, d=12 (see src/sites.js).
    //     Frame from a safe distance in the upper tunnel with the torch on
    //     so the silvery lens catches the light before the diver would
    //     swim into it.
    //   • SILT: two frames on the cathedral floor — one at near-clear
    //     visibility (light silt state) and one at heavy silt (visibility
    //     driven low via the setter) so the brown/gray turbidity cloud
    //     is visible.
    //   • EXIT: framed from deep inside the tunnel at x=125 looking
    //     toward the rear exit at x=200 so the light-target reads as
    //     inviting from a distance.
    //   • FORMATIONS: cathedral chamber at x=90..108 where the
    //     stalactite/stalagmite pair grid is dense enough for a merged
    //     column or two, plus steep wall gradients for flowstone drapes.
    { site: 'Cave', x: 106, depth: 15, torch: true,  facing:  1, name: 'desktop-dive-cave-32-bad-air-lens' },
    { site: 'Cave', x: 90,  depth: 100, torch: true,  facing:  1, name: 'desktop-dive-cave-32-silt-clear',
      pinVisibility: 1.0 },
    { site: 'Cave', x: 90,  depth: 100, torch: true,  facing:  1, name: 'desktop-dive-cave-32-silt-heavy',
      pinVisibility: 0.15 },
    { site: 'Cave', x: 125, depth: 15,  torch: true,  facing:  1, name: 'desktop-dive-cave-32-exit-from-tunnel' },
    { site: 'Cave', x: 175, depth: 12,  torch: true,  facing:  1, name: 'desktop-dive-cave-32-exit-near' },
    // Formations: columns need narrow ceiling-floor gaps (near the
    // sinkhole rim at x~18-22 where floor≈16 and ceiling≈14), and
    // flowstone needs steep wall gradients (down-shaft at x~56-68,
    // up-shaft at x~132-140). Cathedral centre has a wide bedrock roof
    // so drawCaveSpeleothems (anchored to the cave-envelope ceiling)
    // draws its stalactites far offscreen — those shots wouldn't show
    // any new formations. These framings target the narrow sections.
    { site: 'Cave', x: 22, depth: 15, torch: true,  facing:  1, name: 'desktop-dive-cave-32-column-narrow-tunnel' },
    { site: 'Cave', x: 62, depth: 55, torch: true,  facing:  1, name: 'desktop-dive-cave-32-flowstone-down-shaft' },
    { site: 'Cave', x: 138, depth: 55, torch: true,  facing:  1, name: 'desktop-dive-cave-32-flowstone-up-shaft' },
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
