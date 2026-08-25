// ============================================================
// FILE: scripts/interior-optics-check.mjs
// PURPOSE: Reference frames + thresholds for the legacy client's overhead
//          interiors (issue #124).
//
//   npm run interior:check     verify against the thresholds below
//   npm run interior:update    re-record the reference FRAMES, deliberately
//
// WHAT THIS GUARDS
//
// #124 asked whether torch-lit wreck and cave interiors reading flat was the
// intended look. The answer was that it was a shortfall: interiors should stay
// dark, but should separate a cool ambient from warm torch and material
// highlights rather than sitting on neutral grey. The cave was fixed in #135
// and the wreck in #136. This is the guard that keeps them fixed.
//
// It is deliberately NOT a general visual-regression net for the legacy client.
// It watches one property — do the interiors still carry colour — because that
// is the property that silently regressed twice, once per renderer surface,
// and neither time did anything notice.
//
// WHY PER-PIXEL CHROMA
//
//   chroma(pixel) = max(R,G,B) - min(R,G,B)
//   metric        = mean over the sampled region
//
// #124 was originally stated in mean channel spread — the gap between the
// frame's highest and lowest mean channel — and that metric cannot see the
// look the issue asks for. Warm highlights against cool ambient average toward
// neutral across a frame, so a scene can gain exactly the requested separation
// while its frame-mean spread FALLS. That is not hypothetical: rusting the
// wreck's steel backdrop at matched luminance moved the vehicle deck from 26.1
// to 25.1 on spread while looking warmer, because the scene is blue-dominant
// from the depth grade.
//
// Per-pixel chroma measures how colourful each pixel is regardless of what the
// frame averages to. It rises when warm marks appear against cool ambient and
// does not reward a flat global tint. Every number below is in it.
//
// WHY THRESHOLDS ARE HAND-WRITTEN AND FRAMES ARE RECORDED
//
// `--update` re-records the reference PNGs. It does NOT touch the thresholds.
//
// That split is the point of #124's sequencing warning: thresholds derived
// from whatever is currently on screen describe the current state, and if the
// current state is the shortfall, recording it locks the shortfall in. So the
// bands live here in code with their reasoning attached, and moving one is a
// deliberate edit that shows up in review — never a side effect of running a
// tool because a run went red.
//
// WHY THE FRAMES ARE NOT BYTE-COMPARED
//
// #133 established that Playwright's frames are deterministic per platform but
// NOT across them: win32 and linux captures of the same Pixi scene differed by
// a max channel delta of 230 across 10.6% of pixels, structurally. The Pixi
// guard solves that by committing a reference set per platform.
//
// That is not available here — these references were recorded on win32 and
// there is no linux node on this machine to record the matching set — so the
// frames are committed as REVIEW ARTEFACTS, for a human to grade a change
// against and to sit beside the `.actual.png` a breach writes out.
//
// The enforced half is the statistics, and they do cross platforms: the same
// scenes measured on win32 and on ubuntu-latest agree to within 0.5 on every
// interior, while their pixels do not agree at all. Figures under THRESHOLDS.
// ============================================================

import { mkdir, readdir, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';

const root = path.resolve(import.meta.dirname, '..');
const pageUrl = `file://${root.replace(/\\/g, '/')}/src/diving-simulator.html`;
const referenceDir = path.join(root, 'tests', 'fixtures', 'reference-frames', 'interior-optics');
const args = process.argv.slice(2);
const UPDATE = args.includes('--update');

const VIEWPORT = { width: 1280, height: 800 };

// Sample window: the centre 60% x 44% of the frame.
//
// #124's numbers came from a centre 76% x 50% crop and carried a caveat that it
// still caught fixed chrome — min and max luma came out identical (5.79 / 243)
// across nearly every scene, which is chrome, not scenery — with a note to
// tighten it before deriving thresholds. This is that tightening, and it took
// two passes to get right.
//
// The dive computer, gauges and warning banners are a separate DOM layer above
// the canvas, so reading the canvas back never sees them. The trap is that the
// TOASTS are not: `drawScene` paints three lines of text straight onto the
// canvas, at y fractions 0.18 (bad air), 0.30 (gas switch) and 0.36 (hint).
// They are amber on a dark scene, so they are the highest-chroma pixels in the
// frame, and the hint line refills from a queue on a timer — a scene measured
// with a hint up and the same scene measured without differ for no reason to do
// with the renderer. A first version of this window started at y 0.28, caught
// all three, and its recorded reference frame is what gave it away.
//
// The toasts are suppressed at source in openScene rather than dodged
// geometrically, and openScene then ASSERTS they are silent before measuring.
// Moving the window below them to 0.40 was tried first and is the worse trade:
// at that offset it slides off the interior and onto the seabed below the keel,
// which dropped the engine room's contrast from SD 17.1 to 7.9 and its chroma
// from 21.4 to 16.4. It would have been measuring mostly silt.
//
// The dive computer is the other trap, and the opposite of the toasts: it looks
// like DOM and is not. It is painted onto the canvas at x >= 880, y <= 270, so
// reading the canvas back sees it, and a window running to 0.80 put its
// bottom-left corner inside the sample — 1.79% of the measured pixels were
// gauge. Hence 0.48 wide rather than 0.60: x 256..870 stops just short of it.
//
// Both were found the same way, and it is worth stating the method because
// eyeballing a crop is what let them in. Two scenes that share nothing —
// wreck-engine-room and reef-open-water — are captured and compared pixel for
// pixel. Anything byte-identical across both is not scenery. That is what
// `assertNoChrome` below does on every run, so this crop cannot quietly rot the
// next time the HUD moves.
//
// Measured this way at 0.28-0.72 vertically, which keeps the window on the
// diver's own eye level where the interior actually is:
//
//   width 0.60  ->  1.7907% identical   (dive computer corner in frame)
//   width 0.50  ->  0.1851%
//   width 0.48  ->  0.0393%             <- chosen
//   width 0.46  ->  0.0410%             (same 85 pixels: coincidence, not chrome)
//
// The residual 85 pixels are dark scenery that happens to match, and they do
// not shrink as the window does, which is how you can tell them from chrome.
const CROP = { fx: 0.20, fy: 0.28, fw: 0.48, fh: 0.44 };

// Two scenes with nothing in common, used to locate fixed chrome (see CROP).
const CHROME_PROBES = ['wreck-engine-room', 'reef-open-water'];

// Budget for byte-identical pixels between those two. The measured floor is
// 0.039% of coincidentally-matching dark scenery; the dive computer intruding
// on one corner was 1.79%. Anything at or above this is a block of chrome, not
// coincidence.
const MAX_IDENTICAL_PERCENT = 0.5;

// ── THRESHOLDS ──────────────────────────────────────────────────────────────
//
// `chroma` and `luma` are inclusive [min, max] bands in absolute units
// (0-255). A scene fails if either measurement leaves its band.
//
// HOW THE CHROMA FLOORS WERE SET. Each floor sits roughly midway between the
// scene's measured flat state and its measured fixed state, which is the
// placement with the most headroom on both sides that still fails the
// regression it exists to catch:
//
//   scene                flat -> fixed   floor   catches   headroom
//   wreck-vehicle-deck   26.4 -> 35.5     31.0     +4.6      -4.5
//   wreck-crew-deck      22.6 -> 31.7     27.0     +4.4      -4.7
//   wreck-cargo-hold     19.1 -> 27.8     23.5     +4.4      -4.3
//   wreck-engine-room    14.3 -> 21.1     17.5     +3.2      -3.6
//   cave-upper-tunnel    10.1 -> 17.8     14.0     +3.9      -3.8
//   cave-restriction     12.2 -> 19.4     15.5     +3.3      -3.9
//   cave-cathedral       16.6 -> 23.6     20.0     +3.4      -3.6
//
// ("catches" is how far the flat state is below the floor; "headroom" is how
// far the current state can drift down before a false failure.)
//
// Both columns were measured by this script, on this crop, with the toasts
// suppressed — the "flat" column by reverting the two gloom colours (#135's
// cave overlay and #136's wreck ring) and re-running it. They are NOT #124's
// published figures, which were taken on a wider crop with the toasts in
// frame; those run about 0.6-0.9 higher on chroma for that reason and are not
// comparable to these. The regression each floor has to catch is a real
// measured state of this codebase, not an estimate.
//
// WHY THAT HEADROOM IS THE RIGHT SIZE. Two sources of drift, both measured.
//
// Run-to-run noise on one machine is under 0.1: across three consecutive runs
// of all nine scenes, no value moved by more than that.
//
// Cross-platform drift is the one that mattered, because CI is linux and these
// thresholds were derived on win32. #133 found that Playwright FRAMES are not
// portable — win32 and linux differed by a max channel delta of 230 across
// 10.6% of pixels — which is the reason it keeps a reference set per platform,
// and the reason this guard enforces statistics instead. That bet is now
// confirmed: the same nine scenes on ubuntu-latest, against the win32 figures
// the bands were built from, moved by
//
//   wreck-vehicle-deck   35.5 -> 35.5    cave-upper-tunnel   17.8 -> 17.7
//   wreck-crew-deck      31.7 -> 31.8    cave-restriction    19.4 -> 19.3
//   wreck-cargo-hold     27.8 -> 27.8    cave-cathedral      23.6 -> 23.6
//   wreck-engine-room    21.1 -> 21.6    wreck-exterior-bow 113.1 -> 114.3
//                                        reef-open-water     54.2 -> 54.1
//
// — at most 0.5 on any interior and 1.2 on a control, against 3.2-4.7 of
// headroom. Aggregate statistics over ~63k samples average the per-pixel
// rasteriser differences away even though the frames themselves do not match.
//
// So the headroom is not guesswork about platforms any more; it is mostly
// slack for future art changes that are meant to happen. A band that does
// start failing is far more likely to be a real change than an environment.
//
// The ceilings are deliberately loose. Nothing has ever regressed by being too
// colourful, so they exist only to catch gross drift, and are set at roughly
// current + 12 for interiors rather than tuned.
//
// The LUMA bands encode "this is not a brightening exercise", #124's other
// explicit requirement: a torch-lit overhead has to still read as dark. They
// are current +/- 10, wide enough that ordinary art changes pass and narrow
// enough that lighting an interior up to open-water levels does not.
const SCENES = [
  // ── Wreck interiors ──
  {
    id: 'wreck-vehicle-deck', kind: 'interior',
    site: 'Wreck', x: 92, depth: 32, torch: true,
    chroma: [31.0, 48.0], luma: [52.0, 72.0],
  },
  {
    id: 'wreck-crew-deck', kind: 'interior',
    site: 'Wreck', x: 92, depth: 43, torch: true,
    chroma: [27.0, 44.0], luma: [57.0, 77.0],
  },
  {
    id: 'wreck-cargo-hold', kind: 'interior',
    site: 'Wreck', x: 92, depth: 49, torch: true,
    chroma: [23.5, 40.0], luma: [55.0, 75.0],
  },
  {
    // The deepest and, before #136, by far the flattest scene in the game:
    // chroma 14.3 against wreck-exterior-bow's 113.2 at a comparable
    // brightness. If any one scene earns its place here it is this one.
    id: 'wreck-engine-room', kind: 'interior',
    site: 'Wreck', x: 92, depth: 57, torch: true,
    chroma: [17.5, 33.0], luma: [48.0, 68.0],
  },
  // ── Cave interiors (guarding #135) ──
  {
    id: 'cave-upper-tunnel', kind: 'interior',
    site: 'Cave', x: 40, depth: 16, torch: true,
    chroma: [14.0, 30.0], luma: [53.0, 73.0],
  },
  {
    id: 'cave-restriction', kind: 'interior',
    site: 'Cave', x: 90, depth: 16, torch: true,
    chroma: [15.5, 32.0], luma: [56.0, 76.0],
  },
  {
    id: 'cave-cathedral', kind: 'interior',
    site: 'Cave', x: 90, depth: 70, torch: true,
    chroma: [20.0, 36.0], luma: [46.0, 66.0],
  },
  // ── Open-water controls ──
  //
  // These are not decoration. The whole #124 finding rests on interiors being
  // flat COMPARED to open water at a similar brightness, so a change that
  // "fixed" the interiors by draining the colour out of everything would move
  // the interior scenes into band while quietly destroying the contrast the
  // issue is about. These two catch that, and they are also the scenes a
  // careless global tint would hit first.
  {
    id: 'wreck-exterior-bow', kind: 'control',
    site: 'Wreck', x: 20, depth: 22, torch: false,
    chroma: [95.0, 135.0], luma: [72.0, 92.0],
  },
  {
    id: 'reef-open-water', kind: 'control',
    site: 'Reef', x: 11, depth: 20, torch: false,
    chroma: [44.0, 70.0], luma: [50.0, 78.0],
  },
];

// Seed the page's randomness so the recorded frames are reproducible.
//
// Unlike the Pixi client this one does not need its clock taken away: the
// statistics here are means over ~63k sampled pixels of scenery that is pinned
// in place below, and three consecutive runs agreed to within 0.1 without any
// clock control. Seeding Math.random is enough to stop the particle and fauna
// scatter reshuffling between recordings, which is what would otherwise make
// two reference frames of the same scene look gratuitously different.
const SEED_RANDOM = () => {
  let seed = 0x5eed1234;
  Math.random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
};

async function openScene(browser, scene) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    // The setup screen is localised and the buttons are matched by name, so
    // without this the run follows the host machine's locale and fails on a
    // German desktop while passing in CI. Same reason as #133.
    locale: 'en-US',
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.addInitScript(SEED_RANDOM);
  await page.goto(pageUrl, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);

  await page.locator('#html-gas-setup button', { hasText: new RegExp(`^${scene.site}$`, 'i') }).click();
  await page.locator('#html-gas-setup button:visible', { hasText: /Start Dive/i }).first().click();
  await page.waitForTimeout(400);
  // Surface -> diving. The scene is only rendered in the diving state.
  await page.keyboard.down('s');
  await page.waitForTimeout(1200);
  await page.keyboard.up('s');

  await page.evaluate(({ x, d, torch }) => {
    diverX = x;
    depth = d;
    verticalVelocity = 0;
    horizontalVelocity = 0;
    window.gameAPI.torchOn = !!torch;
    window.gameAPI.diverFacing = 1;
    // Silence the canvas-drawn toasts. The sample window already starts below
    // all three, but the hint line refills from a queue on a timer, so leaving
    // the queue loaded means a capture can differ from the next one for
    // reasons that have nothing to do with the scene.
    hintNotifyTime = 0;
    hintNotifyText = '';
    hintQueue = [];
    gasSwitchNotifyTime = 0;
    gasSwitchNotifyText = '';
  }, { x: scene.x, d: scene.depth, torch: scene.torch });
  await page.waitForTimeout(400);

  // Settle the scene, silence the toasts and read the result — all inside ONE
  // page evaluation, ending on the same frame it measures.
  //
  // Splitting these apart does not work, and the toast assertion below is what
  // proved it. The game loop pops a fresh hint off `hintQueue` the moment
  // `hintNotifyTime` reaches 0, so clearing the queue from one evaluate and
  // measuring from the next leaves room for a frame in between that re-arms a
  // toast and draws amber text across the sample window. Clearing every frame
  // and reading immediately after the last one closes that window entirely.
  //
  // The ramp pinning is here for a related reason. _torchDark and _wreckMetal
  // ease toward their target at 0.06 per frame, so a scene captured shortly
  // after entering shows almost none of the gloom and measures far better than
  // the same scene actually looks — #124's first baseline was taken that way
  // and understated the problem, as its re-baseline notes. drawScene re-nudges
  // both every frame, so they have to be re-pinned every frame, not once.
  //
  // `isOverhead` is deliberately not "the site is a wreck or a cave":
  // wreck-exterior-bow is an open-water control AT a wreck site and must not be
  // forced inside. Conflating the two was a real bug in the harness this script
  // grew out of, and it silently turned a control into a fourth wreck interior.
  const isOverhead = scene.torch && (scene.site === 'Wreck' || scene.site === 'Cave');
  const reading = await page.evaluate(async ({ crop, overhead, wantFingerprint }) => {
    const quiet = () => {
      hintNotifyTime = 0;
      hintNotifyText = '';
      hintQueue = [];
      gasSwitchNotifyTime = 0;
      gasSwitchNotifyText = '';
    };
    const pin = () => {
      quiet();
      if (!overhead) return;
      inOverhead = true;
      if (typeof _torchDark !== 'undefined') _torchDark = 1;
      if (typeof _wreckMetal !== 'undefined') _wreckMetal = 1;
    };
    for (let i = 0; i < 12; i += 1) {
      pin();
      await new Promise(r => requestAnimationFrame(r));
    }

    const canvas = document.getElementById('c');
    const context = canvas.getContext('2d');
    const x0 = Math.round(canvas.width * crop.fx);
    const y0 = Math.round(canvas.height * crop.fy);
    const w = Math.round(canvas.width * crop.fw);
    const h = Math.round(canvas.height * crop.fh);
    const data = context.getImageData(x0, y0, w, h).data;
    let n = 0, sum = 0, sum2 = 0, chroma = 0, r = 0, g = 0, b = 0;
    // Stride 2 in both axes: ~63k samples out of 253k pixels, which agrees with
    // a full read to inside 0.1 at a quarter of the work.
    for (let y = 0; y < h; y += 2) {
      for (let x = 0; x < w; x += 2) {
        const i = ((y * w) + x) << 2;
        const R = data[i], G = data[i + 1], B = data[i + 2];
        const L = 0.2126 * R + 0.7152 * G + 0.0722 * B;
        n += 1; sum += L; sum2 += L * L;
        chroma += Math.max(R, G, B) - Math.min(R, G, B);
        r += R; g += G; b += B;
      }
    }
    const mean = sum / n;

    // The reference frame is cut from the SAME pixels just measured. A page
    // screenshot would composite the DOM HUD over the canvas, so the frame and
    // the numbers printed beside it would describe different images — and the
    // frame's whole job is to be what a human grades the numbers against.
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    out.getContext('2d').drawImage(canvas, x0, y0, w, h, 0, 0, w, h);

    // For the chrome probes only, hand back the sampled pixels so the two can
    // be compared against each other once both are captured. Stride 2, matching
    // the measurement, which is ample: chrome arrives in blocks, not specks.
    let fingerprint = null;
    if (wantFingerprint) {
      fingerprint = [];
      for (let y = 0; y < h; y += 2) {
        for (let x = 0; x < w; x += 2) {
          const i = ((y * w) + x) << 2;
          fingerprint.push(data[i], data[i + 1], data[i + 2]);
        }
      }
    }

    return {
      fingerprint,
      stats: {
        luma: +mean.toFixed(2),
        sd: +Math.sqrt(Math.max(0, sum2 / n - mean * mean)).toFixed(2),
        chroma: +(chroma / n).toFixed(2),
        rgb: [r / n, g / n, b / n].map(v => +v.toFixed(1)),
      },
      png: out.toDataURL('image/png'),
      state: {
        site: activeSite() ? activeSite().id : null,
        torch: !!torchOn,
        overhead: typeof inOverhead !== 'undefined' ? !!inOverhead : null,
        gameState,
        toastsSilent: hintNotifyTime === 0 && gasSwitchNotifyTime === 0,
      },
    };
  }, { crop: CROP, overhead: isOverhead, wantFingerprint: CHROME_PROBES.includes(scene.id) });

  // Assert the scene is the state its thresholds assume, rather than trusting
  // that driving it produced one. A scene that quietly failed to enter the hull
  // still renders, still measures and still compares — it just measures
  // something else. #133 shipped a scene named `wreck-torch-on` that captured
  // the torch off for exactly this reason.
  const state = reading.state;
  if (state.gameState !== 'diving') {
    throw new Error(`${scene.id}: game state is "${state.gameState}", not "diving" — nothing was rendered`);
  }
  if (state.site !== scene.site.toLowerCase()) {
    throw new Error(`${scene.id}: site is "${state.site}", expected "${scene.site.toLowerCase()}"`);
  }
  if (state.torch !== scene.torch) {
    throw new Error(
      `${scene.id}: expected the torch ${scene.torch ? 'on' : 'off'} but it is ${state.torch ? 'on' : 'off'}` +
      ' — the scene is not exercising what its thresholds assume.',
    );
  }
  if (isOverhead && state.overhead !== true) {
    throw new Error(`${scene.id}: expected to be inside an overhead but inOverhead is ${state.overhead}`);
  }
  // The sample window sits across the toast band, so amber text getting into a
  // capture would be the highest-chroma pixels in the frame. Suppression that
  // silently stopped working is exactly the kind of thing that shifts a
  // threshold by a point and gets blamed on the renderer.
  if (!state.toastsSilent) {
    throw new Error(
      `${scene.id}: a canvas toast is active — the sample window would include amber text.` +
      ' The suppression above is not holding.',
    );
  }

  const stats = reading.stats;
  const png = Buffer.from(reading.png.slice('data:image/png;base64,'.length), 'base64');

  return { context, errors, stats, png, fingerprint: reading.fingerprint };
}

// Fail if the sample window contains fixed chrome.
//
// #124's own baseline carried a caveat that its crop still caught some, and
// noted that min and max luma came out identical across nearly every scene
// (5.79 / 243) — a tell that something unchanging was in frame. Thresholds
// derived over chrome are thresholds partly measuring the HUD, and the HUD
// moves for reasons that have nothing to do with the renderer: #125 alone
// reflowed the result screens and grew the touch targets.
//
// So rather than trusting a crop that looked right once, prove it every run.
// Two scenes that share no scenery cannot legitimately agree pixel for pixel.
function assertNoChrome(fingerprints) {
  const [a, b] = CHROME_PROBES.map(id => fingerprints[id]);
  if (!a || !b) {
    throw new Error('chrome probe: both probe scenes must be captured before the window can be trusted');
  }
  if (a.length !== b.length) {
    throw new Error('chrome probe: sample windows differ in size between scenes');
  }
  let identical = 0;
  const pixels = a.length / 3;
  for (let i = 0; i < a.length; i += 3) {
    if (a[i] === b[i] && a[i + 1] === b[i + 1] && a[i + 2] === b[i + 2]) identical += 1;
  }
  const percent = identical * 100 / pixels;
  if (percent >= MAX_IDENTICAL_PERCENT) {
    throw new Error(
      `chrome probe: ${percent.toFixed(4)}% of the sample window is byte-identical between `
      + `${CHROME_PROBES[0]} and ${CHROME_PROBES[1]}, over the ${MAX_IDENTICAL_PERCENT}% budget.`
      + ' Two scenes with no scenery in common cannot legitimately agree that widely, so fixed'
      + ' chrome — most likely the dive computer, painted on the canvas at x >= 880, y <= 270 —'
      + ' has moved into the sample window. Narrow CROP until it is out again and re-derive the'
      + ' thresholds; do NOT re-record over it.',
    );
  }
  console.log(`ok   chrome probe          ${percent.toFixed(4)}% identical, under ${MAX_IDENTICAL_PERCENT}%`);
}

function breachesFor(scene, stats) {
  const breaches = [];
  // A uniformly black or blank readback compares "fine" against a floor of
  // zero and would make the whole check vacuous, so refuse it outright rather
  // than letting it flow into the band comparison.
  if (stats.luma === 0 && stats.chroma === 0) {
    breaches.push(`${scene.id}: frame is uniformly black — the capture is broken, not the renderer`);
    return breaches;
  }
  const checks = [
    ['chroma', stats.chroma, scene.chroma],
    ['luma', stats.luma, scene.luma],
  ];
  for (const [name, value, [min, max]] of checks) {
    if (value < min) {
      // Say which failure this is. A flat interior and a drained control are
      // different bugs: the first is #124 regressing, the second is a global
      // change pulling the colour out of the whole game, which would drag the
      // interiors back into band while destroying the contrast that made them
      // worth measuring against.
      const why = name !== 'chroma' ? ''
        : scene.kind === 'interior'
          ? ' — the interior has gone flat, which is what #124 was about'
          : ' — this is an OPEN-WATER control: something has drained the colour from the whole scene,'
            + ' not just the interiors';
      breaches.push(`${scene.id}: ${name} ${value.toFixed(2)} is below the floor ${min.toFixed(2)}${why}`);
    } else if (value > max) {
      breaches.push(`${scene.id}: ${name} ${value.toFixed(2)} is above the ceiling ${max.toFixed(2)}`);
    }
  }
  return breaches;
}

const browser = await chromium.launch();
let failed = false;

try {
  await mkdir(referenceDir, { recursive: true });
  // A stale .actual.png from an earlier failing run sitting next to a
  // reference is actively misleading during review.
  for (const entry of await readdir(referenceDir)) {
    if (entry.endsWith('.actual.png')) await unlink(path.join(referenceDir, entry));
  }

  const fingerprints = {};

  for (const scene of SCENES) {
    const { context, errors, stats, png, fingerprint } = await openScene(browser, scene);
    await context.close();
    if (fingerprint) fingerprints[scene.id] = fingerprint;

    if (errors.length) {
      throw new Error(`${scene.id} raised page errors:\n  ${errors.join('\n  ')}`);
    }

    const summary =
      `luma ${stats.luma.toFixed(1).padStart(5)}  sd ${stats.sd.toFixed(1).padStart(5)}  ` +
      `chroma ${stats.chroma.toFixed(1).padStart(6)}`;

    if (UPDATE) {
      await writeFile(path.join(referenceDir, `${scene.id}.png`), png);
      const [cMin, cMax] = scene.chroma;
      const inBand = stats.chroma >= cMin && stats.chroma <= cMax;
      // Recording is not a licence to record a shortfall. Say plainly when a
      // frame being recorded does not meet the thresholds it will be judged
      // by, so nobody re-records their way out of a red run by accident.
      console.log(
        `recorded ${scene.id.padEnd(20)} ${summary}` +
        (inBand ? '' : `   <-- WARNING: outside its band [${cMin}, ${cMax}] — recorded anyway, thresholds NOT changed`),
      );
      continue;
    }

    const breaches = breachesFor(scene, stats);
    if (breaches.length) {
      failed = true;
      for (const breach of breaches) console.error(`FAIL ${breach}`);
      const actual = path.join(referenceDir, `${scene.id}.actual.png`);
      await writeFile(actual, png);
      console.error(`     wrote ${path.relative(root, actual)} — compare it against ${scene.id}.png`);
    } else {
      console.log(`ok   ${scene.id.padEnd(20)} ${summary}`);
    }
  }

  // Both probes are captured by now, so the window itself can be validated
  // before any of these numbers are trusted.
  assertNoChrome(fingerprints);

  if (UPDATE) {
    console.log(`\nrecorded ${SCENES.length} reference frames to ${path.relative(root, referenceDir)}`);
    console.log('thresholds were NOT touched — they live in scripts/interior-optics-check.mjs by design');
  }
} finally {
  await browser.close();
}

if (failed) {
  console.error(
    '\nInterior optics check failed.\n' +
    'These bands encode the art direction decided in #124: overhead interiors stay dark\n' +
    'but must not go neutral. If a change here is intended, move the specific band in\n' +
    'scripts/interior-optics-check.mjs and say why in the PR — raising a threshold to make\n' +
    'a run pass is how the shortfall #124 documented ships again.',
  );
  process.exit(1);
}

if (!existsSync(path.join(referenceDir, `${SCENES[0].id}.png`)) && !UPDATE) {
  console.warn(
    `\nnote: no reference frames in ${path.relative(root, referenceDir)} — ` +
    'record them with `npm run interior:update` so breaches have something to be graded against.',
  );
}
