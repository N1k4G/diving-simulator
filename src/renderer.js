// ============================================================
// FILE: renderer.js
// PURPOSE: All canvas drawing — underwater scene, diver sprite,
//          dive computer HUD, gas-setup screen, dive profile chart,
//          post-dive summary, game-over screen, and surface screen.
//
// DEPENDS ON:
//   constants.js — colours, layout constants, S()
//   state.js     — every game-state variable (depth, tissues, tanks, diver, …)
//   physics.js   — calculateNDL(), calculateCeiling(), calculateDecoSchedule()
//   world.js     — bubble/fish/particle arrays rendered here
//
// USED BY:
//   game-loop.js — gameLoop() calls the appropriate draw* fn each frame
//
// KEY FUNCTIONS (grep to find):
//   drawScene()              — underwater background, diver, particles, fish
//   drawDiveComputer()       — HUD overlay: depth, NDL, tissue bars, PO2, deco
//   drawDiveProfileChart()   — post-dive depth/time profile chart
//   drawPostDive()           — post-dive summary screen
//   drawGameOver()           — game-over screen with cause of death
//   drawSurface()            — surface / pre-dive screen
//   showHtmlHelp()           — build and show the HTML help overlay
// SECTION: Rendering helper utilities
// SEARCH TERMS: formatDepth, formatTime, lerpColor, roundRect, wrapText

// ============================================================
// Diagnostics are an optional observer, exactly as in game-loop.js. This file
// is parsed before diagnostics.js, so the collector must be resolved lazily at
// draw time rather than captured at load time — an eager capture would bind the
// no-op permanently and silently drop every render sub-pass metric.
var _RENDER_DIAG_NOOP = {
    enabled: false,
    start: function() { return 0; },
    record: function() {}
};
function _renderDiag() {
    return window.baselineDiagnostics || _RENDER_DIAG_NOOP;
}

// ============================================================
//  RENDERING HELPERS
// ============================================================

function waterColor(d) {
    // Atmospheric deep-ocean palette — eased multi-stop (depth metres -> RGB)
    var stops = [
        [0,   [96, 171, 196]],
        [12,  [58, 140, 173]],
        [30,  [32, 102, 139]],
        [60,  [17, 66, 99]],
        [110, [8, 37, 61]],
        [180, [3, 14, 27]]
    ];
    if (d <= stops[0][0]) return 'rgb(' + stops[0][1].join(',') + ')';
    for (var i = 1; i < stops.length; i++) {
        if (d <= stops[i][0]) {
            var a = stops[i - 1], b = stops[i];
            var t = (d - a[0]) / (b[0] - a[0]);
            t = t * t * (3 - 2 * t); // smoothstep
            var r = Math.round(a[1][0] + (b[1][0] - a[1][0]) * t);
            var g = Math.round(a[1][1] + (b[1][1] - a[1][1]) * t);
            var bl = Math.round(a[1][2] + (b[1][2] - a[1][2]) * t);
            return 'rgb(' + r + ',' + g + ',' + bl + ')';
        }
    }
    var last = stops[stops.length - 1][1];
    return 'rgb(' + last.join(',') + ')';
}

// ── Cenote / cave palette (matches the Cueva del Silencio mockup) ──
// Warm Yucatán limestone above, tannic→turquoise→ink-black water below.
// Used by drawScene/drawTerrain when activeSite().id === 'cave'.
var CAVE_PAL = {
    sky:        '#9ec8b9',
    skyWarm:    '#f3e2c4',
    jungle:     '#3c5a3a',
    jungleDark: '#1f3324',
    earth:      '#2a1c10',
    earthLite:  '#4a3220',
    rockLite:   '#a89072',
    rockMid:    '#6b5a40',
    rockWarm:   '#4e3f2a',
    rockShade:  '#2c2114',
    rockDark:   '#150d06',
    // Cool grey limestone — the deep cave turns to bare grey rock the further
    // (and deeper) you go from the warm, organic, tannin-stained entrance.
    greyBrown:  '#534a3c',   // transition (brown → grey)
    greyLite:   '#74736c',
    greyMid:    '#4a4944',
    greyShade:  '#33322d',
    greyDark:   '#1d1c19',
    halocline:  '#a8d8d0',
    calciteLite:'#e8dcc0',
    calciteMid: '#b89a72',
    calciteDark:'#3a2818',
    sunbeam:    '#fff5d8',
    signYellow: '#f0c038',
    signRed:    '#c8281a',
    signBlack:  '#0a0a0a',
    signWhite:  '#f5efe2',
};

// Cenote water colour ramp. Mimics a Yucatán sinkhole: greenish tannic
// surface, turquoise mid water past the halocline, fading to black in the
// deep tunnels.
function caveWaterColor(d) {
    var stops = [
        [0,   [108, 130, 88]],   // tannic surface
        [4,   [76, 122, 110]],   // greenish
        [8,   [50, 132, 138]],   // turquoise (just below halocline)
        [16,  [28, 88, 116]],    // deeper blue
        [24,  [12, 48, 78]],     // dark blue
        [32,  [4, 18, 32]]       // black
    ];
    if (d <= stops[0][0]) return 'rgb(' + stops[0][1].join(',') + ')';
    for (var i = 1; i < stops.length; i++) {
        if (d <= stops[i][0]) {
            var a = stops[i - 1], b = stops[i];
            var t = (d - a[0]) / (b[0] - a[0]);
            t = t * t * (3 - 2 * t);
            var r = Math.round(a[1][0] + (b[1][0] - a[1][0]) * t);
            var g = Math.round(a[1][1] + (b[1][1] - a[1][1]) * t);
            var bl = Math.round(a[1][2] + (b[1][2] - a[1][2]) * t);
            return 'rgb(' + r + ',' + g + ',' + bl + ')';
        }
    }
    var last = stops[stops.length - 1][1];
    return 'rgb(' + last.join(',') + ')';
}

function formatTime(diveMinutes) {
    var totalSeconds = Math.floor(diveMinutes * 60);
    var mm = Math.floor(totalSeconds / 60);
    var ss = totalSeconds % 60;
    return String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
}

// D1: persistent facing direction — updates when diver fins, holds last value when still
var _diverFacing = 1;
// Torch/overhead darkness ramp — eases in/out so entering a wreck/cave dims gradually
var _torchDark = 0;
// Wreck metal-interior backdrop ramp — fades in only while inside the hull
var _wreckMetal = 0;

// ── Issue #31: Directional torch beam ─────────────────────────────
// _diverFacing is ±1 (right/left only — no vertical aim). torchBeamAngle()
// returns the beam's centre angle in canvas radian convention:
//   0        = +x (right, horizontal)
//   +PI/2    = +y (DOWN — canvas y grows downward)
//   PI       = -x (left, horizontal)
// A small fixed tilt gives the beam a realistic "held slightly down" pose:
//   facing right (+1): angle = 0 + TILT       → cos>0, sin>0 (down-right)
//   facing left  (-1): angle = PI - TILT      → cos<0, sin>0 (down-left)
// In BOTH cases sin(angle) > 0, i.e. the y-component points DOWN. The sign
// is easy to get backwards (subtracting from PI is required for the left
// side because increasing above PI would point UP-left) — see TC-31-*.
const TORCH_BEAM_TILT_RAD = 12 * Math.PI / 180;      // ~12° downward tilt
const TORCH_BEAM_HALF_ANGLE_RAD = 28 * Math.PI / 180; // ±28° cone opening
// Near-field spill radius as a fraction of the torch's total reach. A weak
// all-around glow so the diver's back/head isn't pure black (which reads as
// broken rather than atmospheric) while still making the cone the dominant
// visible zone.
const TORCH_NEAR_FIELD_FRACTION = 0.42;

function torchBeamAngle(facing) {
    // Clamp to ±1: any non-`-1` input is treated as facing right (matches
    // _diverFacing's own initialisation to +1).
    var f = (facing === -1) ? -1 : 1;
    return (f === 1) ? TORCH_BEAM_TILT_RAD : (Math.PI - TORCH_BEAM_TILT_RAD);
}

// ── Issue #33: Object-relative light + interior distance queries ───
// A shared query helper: "how lit is this specific world point?" Reuses
// #31's exact beam axis/geometry — never invents a second torch cone,
// mask, or facing calculation. First consumer is the wreck interior
// object-brightness/tint pass (drawFeatures / drawStructures on wreck);
// deliberately GENERIC (not wreck-specific) since the same query is
// useful anywhere a drawer wants to modulate colour by torch reach.
//
// Contract:
//   sampleTorchLightAtWorldPoint(worldX, worldD) → number in [0..1]
//   • Returns EXACTLY 0 when torchOn is false — the point is unlit,
//     no artificial warm brightening is added (see TC-33-LIGHT-TORCH-OFF-ZERO).
//   • Returns 1 at the diver's own world position when torchOn is true.
//   • Soft radial fall-off from the diver, with a soft angular edge to
//     the beam cone — no hard step (see TC-33-LIGHT-SOFT-EDGE).
//   • Points inside the near-field spill radius are lit regardless of
//     angle (mirrors #31's near-field circle).
// Pure function of its inputs + current diver state (facing, position,
// torchOn, visibility). No state mutation.
const TORCH_LIGHT_EDGE_SOFTNESS = 0.22;   // fraction of angular half-width used for smooth edge
// Interior object-distance falloff — how present an object reads INSIDE
// the wreck as a function of its distance from the diver. This is the
// separate #33 effect: it modulates alpha/brightness slightly with a
// per-object distance factor, layered ON TOP of #54's zone-wide fog
// (never a second fullscreen fog layer). See TC-33-INTERIOR-FACTOR-*.
const INTERIOR_OBJECT_NEAR_M = 4;         // full-present within this radius
const INTERIOR_OBJECT_FAR_M  = 26;        // fully faded past this radius

function sampleTorchLightAtWorldPoint(worldX, worldD) {
    if (!torchOn) return 0;
    // Reach in world metres, scaled by local visibility — matches the
    // exact formula the drawing side already uses (drawSiltAndTorch,
    // drawWreckHullSkin: TORCH_RADIUS_M * 1.7 * max(0.3, visibility)).
    var reachM = TORCH_RADIUS_M * 1.7 * Math.max(0.3, visibility);
    var nearM  = reachM * TORCH_NEAR_FIELD_FRACTION;
    var dx = worldX - diverX;
    var dy = worldD - depth;
    var dist = Math.sqrt(dx * dx + dy * dy);
    if (dist <= 1e-6) return 1;
    // Near-field spill — soft radial falloff, angle-independent.
    var nearFactor = 0;
    if (dist < nearM) {
        var nr = 1 - dist / nearM;
        nearFactor = nr * nr * (3 - 2 * nr);   // smoothstep 0→1
    }
    // Directional cone — same axis as #31.
    var coneFactor = 0;
    if (dist < reachM) {
        var pointAngle = Math.atan2(dy, dx);
        var beamAngle = torchBeamAngle(_diverFacing);
        var halfA = TORCH_BEAM_HALF_ANGLE_RAD;
        var da = pointAngle - beamAngle;
        while (da >  Math.PI) da -= Math.PI * 2;
        while (da < -Math.PI) da += Math.PI * 2;
        var absDA = Math.abs(da);
        var innerHalf = halfA * (1 - TORCH_LIGHT_EDGE_SOFTNESS);
        var angularWeight = 0;
        if (absDA <= innerHalf) {
            angularWeight = 1;
        } else if (absDA < halfA) {
            var t = (halfA - absDA) / (halfA - innerHalf);
            angularWeight = t * t * (3 - 2 * t);   // smoothstep
        }
        if (angularWeight > 0) {
            var radial = 1 - dist / reachM;
            if (radial < 0) radial = 0;
            radial = radial * radial * (3 - 2 * radial);   // smoothstep
            coneFactor = angularWeight * radial;
        }
    }
    return Math.max(nearFactor, coneFactor);
}

function interiorObjectDistanceFactor(worldX, worldD) {
    var dx = worldX - diverX;
    var dy = worldD - depth;
    var dist = Math.sqrt(dx * dx + dy * dy);
    if (dist <= INTERIOR_OBJECT_NEAR_M) return 1;
    if (dist >= INTERIOR_OBJECT_FAR_M)  return 0;
    var t = (INTERIOR_OBJECT_FAR_M - dist) / (INTERIOR_OBJECT_FAR_M - INTERIOR_OBJECT_NEAR_M);
    return t * t * (3 - 2 * t);   // smoothstep
}

// ── Issue #36: depth-dependent color absorption ────────────────────
// Red is the first wavelength absorbed by water — gone by ~10-15 m —
// followed by orange/yellow; by ~25 m without a light source everything
// reads blue-grey. Only the water gradient itself (waterColor()) darkens
// with depth today; objects in the scene (features, fish, wildlife) stay
// at full saturation regardless of depth. This is the single most
// iconic visual of real diving and is currently entirely missing.
//
// depthColorFactors() is a pure function: r/g/b multiply-tint factors,
// monotonically non-increasing (r, g) as depth increases, smoothstep-
// composed so the transition never pops while ascending/descending.
const DEPTH_COLOR_R_NEAR = 5,  DEPTH_COLOR_R_FAR = 25, DEPTH_COLOR_R_LOSS = 0.75;
const DEPTH_COLOR_G_NEAR = 15, DEPTH_COLOR_G_FAR = 60, DEPTH_COLOR_G_LOSS = 0.45;
// Cave's torch-darkness overlay (drawSiltAndTorch) already dominates the
// mood there; a full-strength tint on top of that reads as double-
// darkening rather than color loss, so soften it in caves specifically.
const DEPTH_COLOR_CAVE_STRENGTH = 0.6;

function depthColorFactors(d, siteId) {
    var strength = (siteId === 'cave') ? DEPTH_COLOR_CAVE_STRENGTH : 1;
    var rLoss = smoothstep(DEPTH_COLOR_R_NEAR, DEPTH_COLOR_R_FAR, d) * DEPTH_COLOR_R_LOSS * strength;
    var gLoss = smoothstep(DEPTH_COLOR_G_NEAR, DEPTH_COLOR_G_FAR, d) * DEPTH_COLOR_G_LOSS * strength;
    var r = 1 - rLoss, g = 1 - gLoss;
    if (r < 0) r = 0; if (r > 1) r = 1;
    if (g < 0) g = 0; if (g > 1) g = 1;
    return { r: r, g: g, b: 1 };
}

// Cached regional buffers for the torch color-restore composite. _effect
// holds the tint with a transparent torch-shaped opening; _mask holds the
// soft near-field circle and directional cone used to cut that opening.
var _depthColorEffectCanvas = null, _depthColorEffectCtx = null;
var _depthColorMaskCanvas = null, _depthColorMaskCtx = null;

function _ensureDepthColorBuffers(W, H) {
    if (_depthColorEffectCanvas && _depthColorEffectCanvas.width === W && _depthColorEffectCanvas.height === H) return;
    _depthColorEffectCanvas = document.createElement('canvas');
    _depthColorEffectCanvas.width = W; _depthColorEffectCanvas.height = H;
    _depthColorEffectCtx = _depthColorEffectCanvas.getContext('2d');
    _depthColorMaskCanvas = document.createElement('canvas');
    _depthColorMaskCanvas.width = W; _depthColorMaskCanvas.height = H;
    _depthColorMaskCtx = _depthColorMaskCanvas.getContext('2d');
}

// Full-screen depth-color tint, applied AFTER every world object (terrain,
// structures, features, particles, fish, wildlife, bubbles) but BEFORE the
// cave darkness/torch-cone punch and #54's local-atmosphere pass — so both
// of those layer on top of an already-tinted scene, and the diver (drawn
// later still) stays untouched/crisp. Clipped to below the surface line so
// sky/HUD are structurally unreachable (HUD is a separate DOM layer above
// the canvas regardless — this clip is defence in depth, not the only guard).
function drawDepthColorAbsorption() {
    if (gameState !== 'diving') return;
    var s = activeSite();
    var f = depthColorFactors(depth, s ? s.id : null);
    if (f.r > 0.995 && f.g > 0.995) return; // negligible — skip the fill entirely

    var W = cssWidth, H = cssHeight, mpp = 0.05;
    var diverScreenX = W * DIVER_SCREEN_X_FRACTION, diverScreenY = H * 0.45;
    var surfaceScreenY = diverScreenY - depth / mpp;
    var top = Math.max(0, surfaceScreenY);
    if (top >= H) return; // nothing below the surface is on screen

    var cx = ctx;
    var restoring = !!torchOn;
    var tintColor = 'rgb(' + Math.round(255 * f.r) + ',' + Math.round(255 * f.g) + ',' + Math.round(255 * f.b) + ')';
    var beamAngle, halfA, exceptionR;
    if (restoring) {
        var _depthStageStarted = _renderDiag().start();
        beamAngle = torchBeamAngle(_diverFacing);
        halfA = TORCH_BEAM_HALF_ANGLE_RAD;
        var torchPx = TORCH_RADIUS_M / mpp;
        exceptionR = torchPx * 1.7 * Math.max(0.3, visibility);
    }

    if (restoring) {
        // The mask is zero outside the torch radius, so both offscreen
        // buffers stay tightly bounded to the visible torch region.
        var maskExtent = exceptionR * 1.05 + 2;
        var regionLeft = Math.max(0, Math.floor(diverScreenX - maskExtent));
        var regionTop = Math.max(top, Math.floor(diverScreenY - maskExtent));
        var regionRight = Math.min(W, Math.ceil(diverScreenX + maskExtent));
        var regionBottom = Math.min(H, Math.ceil(diverScreenY + maskExtent));
        var regionW = Math.max(1, regionRight - regionLeft);
        var regionH = Math.max(1, regionBottom - regionTop);
        var localDiverX = diverScreenX - regionLeft;
        var localDiverY = diverScreenY - regionTop;
        _ensureDepthColorBuffers(regionW, regionH);
        // 2. Build the soft union mask (near-field circle ∪ directional
        //    cone) by drawing both gradients with plain source-over —
        //    alpha-over-transparent compositing sums correctly (never
        //    exceeds 1), so this is a proper soft union, not a hack.
        _depthColorMaskCtx.clearRect(0, 0, regionW, regionH);
        var nearR = exceptionR * TORCH_NEAR_FIELD_FRACTION;
        var nearGrad = _depthColorMaskCtx.createRadialGradient(localDiverX, localDiverY, 0, localDiverX, localDiverY, nearR);
        nearGrad.addColorStop(0, 'rgba(0,0,0,0.7)');
        nearGrad.addColorStop(1, 'rgba(0,0,0,0)');
        _depthColorMaskCtx.fillStyle = nearGrad;
        _depthColorMaskCtx.fillRect(0, 0, regionW, regionH);
        _depthColorMaskCtx.save();
        _depthColorMaskCtx.beginPath();
        _depthColorMaskCtx.moveTo(localDiverX, localDiverY);
        _depthColorMaskCtx.arc(localDiverX, localDiverY, exceptionR * 1.05, beamAngle - halfA, beamAngle + halfA);
        _depthColorMaskCtx.closePath();
        _depthColorMaskCtx.clip();
        var wedgeGrad = _depthColorMaskCtx.createRadialGradient(localDiverX, localDiverY, 0, localDiverX, localDiverY, exceptionR);
        wedgeGrad.addColorStop(0,    'rgba(0,0,0,1)');
        wedgeGrad.addColorStop(0.7,  'rgba(0,0,0,0.85)');
        wedgeGrad.addColorStop(1,    'rgba(0,0,0,0)');
        _depthColorMaskCtx.fillStyle = wedgeGrad;
        _depthColorMaskCtx.fillRect(0, 0, regionW, regionH);
        _depthColorMaskCtx.restore();
        _renderDiag().record('renderDepthMask', _depthStageStarted);
        _depthStageStarted = _renderDiag().start();
        // Cut the torch-shaped opening out of a regional tint layer.
        _depthColorEffectCtx.clearRect(0, 0, regionW, regionH);
        _depthColorEffectCtx.fillStyle = tintColor;
        _depthColorEffectCtx.fillRect(0, 0, regionW, regionH);
        _depthColorEffectCtx.globalCompositeOperation = 'destination-out';
        _depthColorEffectCtx.drawImage(_depthColorMaskCanvas, 0, 0);
        _depthColorEffectCtx.globalCompositeOperation = 'source-over';
        _renderDiag().record('renderDepthEffectBuild', _depthStageStarted);
    }

    // Apply the tint over the clipped underwater area. Four non-overlapping
    // rectangles cover the area outside the regional effect layer.
    var _depthTintStarted = _renderDiag().start();
    cx.globalCompositeOperation = 'multiply';
    cx.fillStyle = tintColor;

    // 5. Composite the pre-tint, masked snapshot back on top — colors
    //    survive smoothly within the torch's reach, fade back to fully
    //    tinted at the mask's soft edge.
    if (restoring) {
        cx.fillRect(0, top, W, regionTop - top);
        cx.fillRect(0, regionTop, regionLeft, regionH);
        cx.fillRect(regionRight, regionTop, W - regionRight, regionH);
        cx.fillRect(0, regionBottom, W, H - regionBottom);
        cx.drawImage(_depthColorEffectCanvas, regionLeft, regionTop, regionW, regionH);
    } else {
        cx.fillRect(0, top, W, H - top);
    }
    cx.globalCompositeOperation = 'source-over';
    _renderDiag().record('renderDepthTint', _depthTintStarted);

}

// ── Material texture tiles (issue #41) ─────────────────────────────
// Offscreen-canvas patterns generated once at first-render, applied as a
// semi-transparent overlay pass on top of each site's base gradient fills.
// World-anchored so the texture stays glued to the world (does not swim
// with the camera). Precedent for offscreen-canvas caching: _rockCache.
//
// SEARCH TERMS: buildMaterialTiles, _matTiles, fillWithMaterialPattern
var MAT_TILE = {
    grain:     { w: 64,  h: 64  },
    sand:      { w: 128, h: 64  },
    limestone: { w: 128, h: 128 },
    steel:     { w: 128, h: 96  },
    crust:     { w: 96,  h: 96  }
};
// Fixed seeds for sRand — deterministic tile generation (no Math.random()).
var MAT_SEED = {
    grain:     101.13,
    sand:      207.71,
    limestone: 313.29,
    steel:     419.87,
    crust:     521.43
};
// Reef mesa: use `crust` above this floor depth, `grain` below.
var REEF_CRUST_MAX_DEPTH = 20;
// Open-water threshold for applying the grain dither pass (banding is
// most visible where the water gradient is near-black).
var GRAIN_DITHER_MIN_DEPTH = 40;
// Metres per pixel — matches drawScene/drawTerrain (0.05 m/px = 20 px/m).
var MAT_MPP = 0.05;

// Issue #34 point 2: Ambient occlusion contact bands.
// A soft darkening stroke along floor/ceiling silhouettes and structure
// baselines. Uses canvas shadowBlur on a low-alpha stroke to produce the
// soft falloff cheaply in one draw call per polyline. World-anchored by
// construction: the input point arrays are already computed from world
// coordinates, so the band moves rigidly with the camera.
const CONTACT_AO = {
    // Terrain silhouette (floor + ceiling): a thin dark stroke with a wider
    // soft-blur halo. The halo is what reads as an AO band; the stroke
    // itself is invisible where the line is convex (bulging away from the
    // solid), and pools visibly darker at concave kinks.
    terrain: {
        strokeAlpha: 0.18,   // core stroke color alpha
        strokeWidth: 1.5,    // core stroke line width (px)
        blurRadius: 6,       // shadowBlur radius (px) — this is the visible band width
        shadowAlpha: 0.42    // shadowColor alpha
    },
    // Structure baselines (bottom edge for floor-sitting structures, top
    // edge for ceiling-hanging structures). Slightly stronger than terrain
    // because it's a shorter line and needs to read against the fill.
    structure: {
        strokeAlpha: 0.22,
        strokeWidth: 1.5,
        blurRadius: 5,
        shadowAlpha: 0.5,
        // World-space distance (m) below which a structure's bottom counts as
        // "sitting on the floor" (or top on the ceiling). Beyond this, no
        // contact band is drawn — the structure is floating in the water column.
        contactSlackM: 0.6
    }
};

// ============================================================
//  ISSUE #56 — SURFACE ACCUMULATION (material-based deposits)
//
//  A shared visual pass that places sediment on horizontal top
//  surfaces, rubble/debris at wall bases, rust streaks on steel
//  panels, and small growth patches along exposed exterior edges.
//  Complementary to (not a replacement for) #34's ambient
//  occlusion contact bands: #34 owns "this edge should look
//  dark" via a soft blurred shadow; this pass owns "material has
//  accumulated here" via warm sediment colors and small irregular
//  shapes. See comment on drawContactAccumulation for details.
// ============================================================

// Per-zone intensities in [0..1]. Missing zone → site default;
// missing site → ACCUMULATION_NEUTRAL_DEFAULT. Any value outside
// [0..1] is clamped inside accumulationProfileFor().
var ACCUMULATION_PROFILES = {
    // Shore
    shore_entry:         { sediment: 0.55, contactDebris: 0.4,  streaks: 0,    growth: 0.10 },
    shore_grass:         { sediment: 0.45, contactDebris: 0.35, streaks: 0,    growth: 0.20 },
    shore_slope:         { sediment: 0.55, contactDebris: 0.5,  streaks: 0,    growth: 0.10 },
    shore_deep:          { sediment: 0.7,  contactDebris: 0.6,  streaks: 0,    growth: 0.05 },
    // Reef
    reef_plateau:        { sediment: 0.2,  contactDebris: 0.2,  streaks: 0,    growth: 0.6  },
    reef_upper_wall:     { sediment: 0.1,  contactDebris: 0.3,  streaks: 0,    growth: 0.7  },
    reef_mid_wall:       { sediment: 0.15, contactDebris: 0.4,  streaks: 0,    growth: 0.5  },
    reef_deep_wall:      { sediment: 0.3,  contactDebris: 0.5,  streaks: 0,    growth: 0.2  },
    // Wreck
    wreck_exterior:      { sediment: 0.3,  contactDebris: 0.4,  streaks: 0.6,  growth: 0.5  },
    wreck_bridge:        { sediment: 0.6,  contactDebris: 0.5,  streaks: 0.8,  growth: 0.10 },
    wreck_accommodation: { sediment: 0.7,  contactDebris: 0.6,  streaks: 0.9,  growth: 0.05 },
    wreck_vehicle_deck:  { sediment: 0.55, contactDebris: 0.5,  streaks: 0.7,  growth: 0.05 },
    wreck_crew_deck:     { sediment: 0.7,  contactDebris: 0.6,  streaks: 0.9,  growth: 0.05 },
    wreck_cargo_hold:    { sediment: 0.9,  contactDebris: 0.7,  streaks: 0.8,  growth: 0.02 },
    wreck_engine_room:   { sediment: 0.8,  contactDebris: 0.7,  streaks: 1.0,  growth: 0.05 },
    wreck_bilge:         { sediment: 1.0,  contactDebris: 0.8,  streaks: 1.0,  growth: 0.02 },
    // Cave
    cave_entrance:       { sediment: 0.4,  contactDebris: 0.4,  streaks: 0.2,  growth: 0.10 },
    cave_upper_tunnel:   { sediment: 0.55, contactDebris: 0.5,  streaks: 0.3,  growth: 0.02 },
    cave_down_shaft:     { sediment: 0.2,  contactDebris: 0.4,  streaks: 0.5,  growth: 0    },
    cave_cathedral:      { sediment: 0.25, contactDebris: 0.5,  streaks: 0.4,  growth: 0    },
    cave_up_shaft:       { sediment: 0.2,  contactDebris: 0.4,  streaks: 0.4,  growth: 0    },
    cave_exit:           { sediment: 0.4,  contactDebris: 0.4,  streaks: 0.2,  growth: 0.05 }
};

var ACCUMULATION_SITE_DEFAULTS = {
    shore: { sediment: 0.5,  contactDebris: 0.4,  streaks: 0,    growth: 0.10 },
    reef:  { sediment: 0.2,  contactDebris: 0.35, streaks: 0,    growth: 0.4  },
    wreck: { sediment: 0.55, contactDebris: 0.55, streaks: 0.7,  growth: 0.10 },
    cave:  { sediment: 0.35, contactDebris: 0.45, streaks: 0.25, growth: 0    }
};

var ACCUMULATION_NEUTRAL_DEFAULT = { sediment: 0.3, contactDebris: 0.3, streaks: 0.2, growth: 0.1 };

// Palette shared by all accumulation helpers. Deliberately warm
// browns / rust / muted greens — NOT pure black — so the pass
// stays visually distinct from #34's light-based dark AO band.
var ACCUMULATION_PAL = {
    sedimentFill:   'rgba(106,90,72,0.55)',
    sedimentEdge:   'rgba(74,60,44,0.35)',
    sedimentGrain:  'rgba(56,44,32,0.4)',
    rubbleDark:     'rgba(58,46,36,0.5)',
    rubbleMid:      'rgba(96,80,60,0.5)',
    // For "contact darkening" component we deliberately cap the
    // black alpha to stay well below CONTACT_AO.terrain.shadowAlpha (0.42).
    contactDark:    'rgba(20,14,10,0.09)',
    rustLight:      'rgba(160,72,32,0.20)',
    rustDark:       'rgba(110,44,18,0.28)',
    mineralPale:    'rgba(180,168,140,0.14)',
    growthOlive:    'rgba(58,80,52,0.55)',
    growthCoralline:'rgba(148,88,102,0.45)'
};

// Fixed seed offsets so surface-accumulation randomness never
// collides with other passes' seeds (#41 MAT_SEED, #55 CELL_SEED_MULT, ...).
var ACCUM_SEED = {
    sediment: 601.17,
    contact:  733.29,
    streak:   857.83,
    growth:   971.51
};

// Cap the max sediment cap thickness in world metres. Issue #56
// suggests 0.10–0.35 m visible deposit — keep the upper bound so
// the pass never dominates the surface it decorates.
var ACCUMULATION_SEDIMENT_MAX_M = 0.35;

// Cap streak count per panel — issue asks 2–5.
var ACCUMULATION_STREAKS_MIN = 2;
var ACCUMULATION_STREAKS_MAX = 5;

// Clamped, safe accessor — used by all callers, never index
// ACCUMULATION_PROFILES directly.
function accumulationProfileFor(siteId, zoneId) {
    function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
    var raw = (zoneId && ACCUMULATION_PROFILES[zoneId])
        || (siteId && ACCUMULATION_SITE_DEFAULTS[siteId])
        || ACCUMULATION_NEUTRAL_DEFAULT;
    return {
        sediment:      clamp01(raw.sediment      != null ? raw.sediment      : 0),
        contactDebris: clamp01(raw.contactDebris != null ? raw.contactDebris : 0),
        streaks:       clamp01(raw.streaks       != null ? raw.streaks       : 0),
        growth:        clamp01(raw.growth        != null ? raw.growth        : 0)
    };
}

// Lazy registry — populated on first drawScene(); never re-allocated.
var _matTiles = null;

function buildMaterialTiles() {
    if (_matTiles) return _matTiles;    // idempotent — never re-allocate
    var tiles = {};
    tiles.grain     = _buildGrainTile();
    tiles.sand      = _buildSandTile(tiles.grain);
    tiles.limestone = _buildLimestoneTile(tiles.grain);
    tiles.steel     = _buildSteelTile();
    tiles.crust     = _buildCrustTile();
    _matTiles = tiles;
    return _matTiles;
}

// Grain: monochrome ±alpha stipple. Doubles as the gradient-dither pass
// for the dark cave / deep-water backgrounds (closes #34 point 1).
function _buildGrainTile() {
    var w = MAT_TILE.grain.w, h = MAT_TILE.grain.h;
    var oc = document.createElement('canvas');
    oc.width = w; oc.height = h;
    var cx = oc.getContext('2d');
    var pixels = 400;
    for (var i = 0; i < pixels; i++) {
        var s = MAT_SEED.grain + i * 3.17;
        var gx = Math.floor(sRand(s)         * w);
        var gy = Math.floor(sRand(s + 0.53)  * h);
        cx.fillStyle = (i % 2 === 0)
            ? 'rgba(255,255,255,0.04)'
            : 'rgba(0,0,0,0.04)';
        cx.fillRect(gx, gy, 1, 1);
    }
    return oc;
}

// Sand: grain base + a few shallow highlight arcs for fine grain.
function _buildSandTile(grainCanvas) {
    var w = MAT_TILE.sand.w, h = MAT_TILE.sand.h;
    var oc = document.createElement('canvas');
    oc.width = w; oc.height = h;
    var cx = oc.getContext('2d');
    // Tile the grain across the (wider) sand canvas so both dimensions
    // are covered — grain is 64×64, sand is 128×64.
    var gw = grainCanvas.width, gh = grainCanvas.height;
    for (var gyOff = 0; gyOff < h; gyOff += gh) {
        for (var gxOff = 0; gxOff < w; gxOff += gw) {
            cx.drawImage(grainCanvas, gxOff, gyOff);
        }
    }
    cx.strokeStyle = 'rgba(255,226,162,0.05)';
    cx.lineWidth = 1;
    var arcs = 9;
    for (var a = 0; a < arcs; a++) {
        var s = MAT_SEED.sand + a * 7.31;
        var ax = sRand(s)         * w;
        var ay = sRand(s + 1.13)  * h;
        var rx = 15 + sRand(s + 2.27) * 25;
        var ry = 2  + sRand(s + 3.41) * 4;
        cx.beginPath();
        cx.ellipse(ax, ay, rx, ry, 0, 0, Math.PI);
        cx.stroke();
    }
    return oc;
}

// Limestone: grain base + calcite patches + dark pore dots.
function _buildLimestoneTile(grainCanvas) {
    var w = MAT_TILE.limestone.w, h = MAT_TILE.limestone.h;
    var oc = document.createElement('canvas');
    oc.width = w; oc.height = h;
    var cx = oc.getContext('2d');
    var gw = grainCanvas.width, gh = grainCanvas.height;
    for (var gyOff = 0; gyOff < h; gyOff += gh) {
        for (var gxOff = 0; gxOff < w; gxOff += gw) {
            cx.drawImage(grainCanvas, gxOff, gyOff);
        }
    }
    // Lighter calcite patches
    cx.fillStyle = 'rgba(220,210,185,0.05)';
    var patches = 20;
    for (var pi = 0; pi < patches; pi++) {
        var ps = MAT_SEED.limestone + pi * 5.19;
        var px = sRand(ps)         * w;
        var py = sRand(ps + 1.29)  * h;
        var pr = 3 + sRand(ps + 2.71) * 5;
        cx.beginPath(); cx.arc(px, py, pr, 0, Math.PI * 2); cx.fill();
    }
    // Dark pore dots
    cx.fillStyle = 'rgba(10,8,6,0.08)';
    var pores = 40;
    for (var di = 0; di < pores; di++) {
        var ds = MAT_SEED.limestone + 1000 + di * 3.71;
        var dx = sRand(ds)         * w;
        var dy = sRand(ds + 0.83)  * h;
        var dr = 1 + sRand(ds + 1.57);
        cx.beginPath(); cx.arc(dx, dy, dr, 0, Math.PI * 2); cx.fill();
    }
    return oc;
}

// Steel: 2×2 plate grid with edge seams + rivets + a few rust streaks.
function _buildSteelTile() {
    var w = MAT_TILE.steel.w, h = MAT_TILE.steel.h;
    var oc = document.createElement('canvas');
    oc.width = w; oc.height = h;
    var cx = oc.getContext('2d');
    // 2×2 plate seams — one internal, one on the far edge (so the tile
    // reads seamlessly across the repeat).
    cx.strokeStyle = 'rgba(0,0,0,0.18)';
    cx.lineWidth = 1;
    var seamX1 = w / 2;
    var seamY1 = h / 2;
    cx.beginPath(); cx.moveTo(seamX1, 0); cx.lineTo(seamX1, h); cx.stroke();
    cx.beginPath(); cx.moveTo(w - 0.5, 0); cx.lineTo(w - 0.5, h); cx.stroke();
    cx.beginPath(); cx.moveTo(0, seamY1); cx.lineTo(w, seamY1); cx.stroke();
    cx.beginPath(); cx.moveTo(0, h - 0.5); cx.lineTo(w, h - 0.5); cx.stroke();
    // Rivets along each seam
    cx.fillStyle = 'rgba(255,255,255,0.08)';
    var rivetSpacing = 10;
    for (var rx = rivetSpacing / 2; rx < w; rx += rivetSpacing) {
        cx.beginPath(); cx.arc(rx, seamY1, 1.2, 0, Math.PI * 2); cx.fill();
        cx.beginPath(); cx.arc(rx, h - 0.5, 1.2, 0, Math.PI * 2); cx.fill();
    }
    for (var ry = rivetSpacing / 2; ry < h; ry += rivetSpacing) {
        cx.beginPath(); cx.arc(seamX1, ry, 1.2, 0, Math.PI * 2); cx.fill();
        cx.beginPath(); cx.arc(w - 0.5, ry, 1.2, 0, Math.PI * 2); cx.fill();
    }
    // 2–3 vertical rust streaks
    cx.fillStyle = 'rgba(150,60,20,0.06)';
    var streaks = 3;
    for (var st = 0; st < streaks; st++) {
        var ss = MAT_SEED.steel + st * 11.7;
        var sx = Math.floor(sRand(ss) * (w - 3));
        cx.fillRect(sx, 0, 3, h);
    }
    return oc;
}

// Crust: dense coral blobs in 3 muted tones (reef growth).
function _buildCrustTile() {
    var w = MAT_TILE.crust.w, h = MAT_TILE.crust.h;
    var oc = document.createElement('canvas');
    oc.width = w; oc.height = h;
    var cx = oc.getContext('2d');
    var tones = ['192,90,58', '138,74,106', '176,138,74'];  // #c05a3a, #8a4a6a, #b08a4a
    var blobs = 60;
    for (var bi = 0; bi < blobs; bi++) {
        var bs = MAT_SEED.crust + bi * 4.79;
        var bx = sRand(bs)         * w;
        var by = sRand(bs + 1.19)  * h;
        var br = 2 + sRand(bs + 2.31) * 3;
        var toneIdx = bi % tones.length;
        var alpha = 0.05 + sRand(bs + 3.13) * 0.04;
        cx.fillStyle = 'rgba(' + tones[toneIdx] + ',' + alpha.toFixed(3) + ')';
        cx.beginPath(); cx.arc(bx, by, br, 0, Math.PI * 2); cx.fill();
    }
    return oc;
}

// Fill the current context with a repeating tile pattern, world-anchored so
// the tile stays glued to the world rather than swimming with the camera.
// The caller is responsible for any clipping.
//   tile        — a canvas from _matTiles.*
//   ox, oy      — anchor coordinate (world metres OR screen pixels)
//   useScreen   — true if ox/oy are already screen px (used by wreck struct
//                 callers that already have sx1/sy1 handy). Otherwise ox/oy
//                 are world metres (converted via MAT_MPP).
function fillWithMaterialPattern(cx, tile, ox, oy, useScreen) {
    var tw = tile.width, th = tile.height;
    var W = cssWidth, H = cssHeight;
    var p = cx.createPattern(tile, 'repeat');
    if (!p) return;
    var offX, offY;
    if (useScreen) {
        offX = -(((ox % tw) + tw) % tw);
        offY = -(((oy % th) + th) % th);
    } else {
        offX = -((((ox / MAT_MPP) % tw) + tw) % tw);
        offY = -((((oy / MAT_MPP) % th) + th) % th);
    }
    cx.save();
    cx.translate(offX, offY);
    cx.fillStyle = p;
    cx.fillRect(-tw, -th, W + 2 * tw, H + 2 * th);
    cx.restore();
}

// SECTION: Underwater scene
// SEARCH TERMS: drawScene, drawDiver, narcosis, waveTime, background gradient

// ============================================================
//  SCENE RENDERING
// ============================================================

function drawScene() {
    var W = cssWidth;
    var H = cssHeight;
    var cx = ctx;
    var _renderPassStarted = _renderDiag().start();

    // Issue #41: lazily build material texture tiles on first render.
    if (!_matTiles) buildMaterialTiles();

    // WP-020: Narcosis visual effects — filters
    var narcFilter = '';
    if (narcosisIndex > 0.40) {
        var grayAmt = Math.min(80, (narcosisIndex - 0.40) * 133);
        narcFilter += 'grayscale(' + grayAmt.toFixed(0) + '%) ';
    }
    if (narcosisIndex > 0.50) {
        var blurAmt = Math.min(3, (narcosisIndex - 0.50) * 6);
        narcFilter += 'blur(' + blurAmt.toFixed(1) + 'px) ';
    }
    if (narcFilter) cx.filter = narcFilter.trim();

    // WP-020: Narcosis wobble
    var narcWobble = narcosisIndex > 0.25;
    if (narcWobble) {
        var wobStr = (narcosisIndex - 0.25) * 8;
        cx.save();
        cx.translate(
            Math.sin(Date.now() * 0.002) * wobStr,
            Math.cos(Date.now() * 0.0015) * wobStr * 0.5
        );
    }

    var diverScreenY = H * 0.45;
    var metersPerPixel = 0.05;

    var depthAtTop = depth - (diverScreenY * metersPerPixel);
    var depthAtBottom = depth + ((H - diverScreenY) * metersPerPixel);

    // Background gradient
    var grad = cx.createLinearGradient(0, 0, 0, H);
    var topD = Math.max(0, depthAtTop);
    var botD = Math.min(MAX_DEPTH + 10, depthAtBottom);
    var _site = activeSite();
    // Issue #54: sample the local atmosphere ONCE per frame at the diver's
    // position. All downstream passes (tint/fog overlay, particle
    // modulation, debug overlay) read from this single sample so we never
    // re-run visualZoneAt / zoneBlendWeight per particle or per feature.
    var _localAtmo = sampleLocalAtmosphere(_site, diverX, depth);
    var _isCave = _site && _site.id === 'cave';
    var _wc = _isCave ? caveWaterColor : waterColor;
    grad.addColorStop(0, _wc(topD));
    grad.addColorStop(0.5, _wc((topD + botD) / 2));
    grad.addColorStop(1, _wc(botD));
    cx.fillStyle = grad;
    cx.fillRect(0, 0, W, H);

    // Issue #41: grain dither over dark background gradients (also closes
    // #34 point 1 — banding). Cave gets it unconditionally (whole ramp is
    // dark). Open water gets it when the diver is deep enough that banding
    // in the near-black stops becomes visible.
    if (_isCave || depth > GRAIN_DITHER_MIN_DEPTH) {
        fillWithMaterialPattern(cx, _matTiles.grain, diverX, depth, false);
    }

    // Wreck visibility: ease an "inside-ness" factor (0 outside → 1 inside the
    // hull). Drives the hull-skin visibility bubble + the hatch light beam. The
    // steel hull itself is painted later (drawWreckSteelBack / drawWreckHullSkin)
    // so the ocean background stays everywhere that is NOT the wreck.
    var _metalTarget = (_site && _site.id === 'wreck' && inOverhead) ? 1 : 0;
    _wreckMetal += (_metalTarget - _wreckMetal) * 0.08;

    var surfaceScreenY = diverScreenY - (depth / metersPerPixel);
    var _activeSiteD5 = _site;

    // Sky if surface visible. In caves the textured rock ceiling (drawn later in
    // drawTerrain) covers the overhead area, so sky only shows through the open
    // pond shafts — no special-case fill needed here.
    if (surfaceScreenY > 0) {
        var skyGrad = cx.createLinearGradient(0, 0, 0, Math.max(1, surfaceScreenY));
        if (_isCave) {
            // Warm Yucatán cenote sky — jungle haze above the karst.
            skyGrad.addColorStop(0,   CAVE_PAL.skyWarm);
            skyGrad.addColorStop(0.55, CAVE_PAL.sky);
            skyGrad.addColorStop(1,    '#7a9d8d');
        } else {
            skyGrad.addColorStop(0, '#c4e6f0');
            skyGrad.addColorStop(1, '#83bcd2');
        }
        cx.fillStyle = skyGrad;
        cx.fillRect(0, 0, W, surfaceScreenY);

        // Cenote: paint a sun disk and jungle silhouette across the top.
        // Both are drawn BEFORE drawTerrain, so the rock ceiling will mask
        // them out everywhere except through the open pond shafts.
        if (_isCave && surfaceScreenY > 24) {
            // sun disk near the right side, soft halo
            var sunPx = W * 0.22, sunPy = Math.min(surfaceScreenY - 38, 56);
            if (sunPy > 8) {
                cx.save();
                var sg = cx.createRadialGradient(sunPx, sunPy, 0, sunPx, sunPy, 70);
                sg.addColorStop(0, 'rgba(255,233,184,0.85)');
                sg.addColorStop(0.4, 'rgba(255,233,184,0.35)');
                sg.addColorStop(1, 'rgba(255,233,184,0)');
                cx.fillStyle = sg;
                cx.fillRect(sunPx - 80, sunPy - 80, 160, 160);
                cx.fillStyle = '#ffe9b8';
                cx.beginPath(); cx.arc(sunPx, sunPy, 18, 0, Math.PI * 2); cx.fill();
                cx.restore();
            }
            // jungle silhouette band along the karst rim (just above water)
            cx.save();
            cx.fillStyle = CAVE_PAL.jungleDark;
            cx.globalAlpha = 0.5;
            cx.fillRect(0, Math.max(0, surfaceScreenY - 24), W, 24);
            cx.globalAlpha = 1;
            cx.fillStyle = CAVE_PAL.jungle;
            for (var jx = 0; jx < W; jx += 12) {
                var jh = 8 + Math.sin(jx * 0.13) * 5 + Math.sin(jx * 0.31) * 3;
                cx.fillRect(jx, surfaceScreenY - jh, 13, jh);
            }
            // a few palm-frond suggestions
            cx.strokeStyle = CAVE_PAL.jungle;
            cx.lineWidth = 2;
            cx.lineCap = 'round';
            for (var ji = 0; ji < 6; ji++) {
                var jpx = (ji * 173.1 + 47) % W;
                var jpy = surfaceScreenY - 18;
                if (jpy < 10) continue;
                cx.beginPath();
                cx.moveTo(jpx, surfaceScreenY);
                cx.lineTo(jpx, jpy);
                cx.stroke();
                for (var ang = -45; ang <= 45; ang += 30) {
                    var rad = ang * Math.PI / 180;
                    cx.beginPath();
                    cx.moveTo(jpx, jpy);
                    cx.quadraticCurveTo(
                        jpx + Math.sin(rad) * 10, jpy - Math.cos(rad) * 8,
                        jpx + Math.sin(rad) * 16, jpy - Math.cos(rad) * 14);
                    cx.stroke();
                }
            }
            cx.restore();
        }
    }

    // Wave animation at surface line
    if (surfaceScreenY > -50 && surfaceScreenY < H + 50) {
        cx.save();
        cx.beginPath();
        for (var x = 0; x <= W; x += 4) {
            var waveY = surfaceScreenY + Math.sin(x * 0.02 + waveTime * 2) * 4 +
                          Math.sin(x * 0.035 + waveTime * 1.5) * 2;
            if (x === 0) cx.moveTo(x, waveY);
            else cx.lineTo(x, waveY);
        }
        cx.lineTo(W, surfaceScreenY + 20);
        cx.lineTo(0, surfaceScreenY + 20);
        cx.closePath();
        cx.fillStyle = 'rgba(135,206,235,0.3)';
        cx.fill();
        cx.restore();
    }

    // Ship on surface — D4/D9: Boat with Alpha flag; site-aware world anchor
    if (surfaceScreenY > -80 && surfaceScreenY < H) {
        cx.save();
        var _boatWorldX = (_activeSiteD5 && _activeSiteD5.boatX != null) ? _activeSiteD5.boatX : 0;
        var shipX = W * DIVER_SCREEN_X_FRACTION + (_boatWorldX - diverX) / metersPerPixel;
        var bob = Math.sin(waveTime * 0.9) * 2.2;
        var rock = Math.sin(waveTime * 0.75) * 0.022;
        cx.translate(shipX, surfaceScreenY + bob);
        cx.rotate(rock);
        // reflection
        cx.save(); cx.globalAlpha = 0.16; cx.scale(1, -1); cx.translate(0, 6);
        paintShip(cx, true); cx.restore();
        // wake ripples
        cx.strokeStyle = 'rgba(225,248,255,0.22)'; cx.lineWidth = 1.4;
        for (var wri = 0; wri < 3; wri++) {
            cx.globalAlpha = 0.5 - wri * 0.14;
            cx.beginPath(); cx.ellipse(0, 2, 70 + wri * 26, 5 + wri * 2, 0, 0, Math.PI * 2); cx.stroke();
        }
        cx.globalAlpha = 1;
        paintShip(cx, false);
        cx.restore();
    }

    // Site-specific atmosphere is cheap gradient/line work behind terrain.
    drawSiteAtmosphere();
    // Issue #58: shared near-surface optics — water underside highlight
    // and boat shadow. Runs at the same slot as drawSiteAtmosphere
    // (behind terrain) so it's part of the water/background layer.
    drawNearSurfaceAtmosphere(_localAtmo);
    _renderDiag().record('renderBackground', _renderPassStarted);
    _renderPassStarted = _renderDiag().start();

    // Phase C: Site terrain (floor + ceiling) drawn before entities
    drawTerrain();
    drawSiteDetailPass();
    // Issue #58: caustics belong ON the terrain, so they run AFTER
    // drawTerrain()/drawSiteDetailPass() and BEFORE set-dressing so
    // decoration props sit on top of the light pattern.
    drawSurfaceCaustics(_localAtmo);
    // Issue #55: deterministic set dressing (small cosmetic filler between
    // hand-placed features). Runs AFTER terrain/material passes so props sit
    // on top of the surface, and BEFORE structures/features so hand-placed
    // landmarks visually dominate.
    var _visLeftM  = (0 - W * DIVER_SCREEN_X_FRACTION) * metersPerPixel + diverX;
    var _visRightM = (W - W * DIVER_SCREEN_X_FRACTION) * metersPerPixel + diverX;
    drawSetDressing(activeSite(), _visLeftM, _visRightM, metersPerPixel);
    // Cenote-only: refractive halocline band at ~7 m
    if (_isCave) drawHalocline(cx, W, H, diverScreenY, metersPerPixel);
    _renderDiag().record('renderTerrainDetail', _renderPassStarted);
    _renderPassStarted = _renderDiag().start();
    // Wreck: steel hull skin BEHIND the interior objects (so behind cars/decks
    // you see metal, not ocean). Clipped to the ship silhouette only.
    drawWreckSteelBack();
    // Phase C: Solid AABB structures
    drawStructures();
    // Phase C: Cosmetic features (seagrass, signs, thermocline, coral)
    drawFeatures();
    // Wreck: opaque exterior hull skin over the silhouette (can't see inside
    // from outside) with a line-of-sight bubble punched around the diver while
    // inside the hull (makes interior navigation harder).
    drawWreckHullSkin();
    // Decorative-only ship cues sit on top of the exterior skin.
    drawWreckExteriorDetails();
    // Wreck: highlight the three penetration points so they're findable from
    // outside (drawn over the hull skin; fades as the diver enters).
    drawWreckEntryMarkers();
    _renderDiag().record('renderWorldGeometry', _renderPassStarted);
    _renderPassStarted = _renderDiag().start();

    // ── Depth scale (DiveSim Redesign spec) ─────────────────────
    cx.save();
    cx.textBaseline = 'middle';
    for (var dm = 0; dm <= MAX_DEPTH; dm += 10) {
        var gy = diverScreenY + (dm - depth) / metersPerPixel;
        if (gy < -4 || gy > H + 4) continue;
        // hairline from right edge of tick zone to screen edge
        cx.strokeStyle = 'rgba(225,245,255,0.048)';
        cx.lineWidth = 1; cx.setLineDash([]);
        cx.beginPath(); cx.moveTo(36, gy); cx.lineTo(W, gy); cx.stroke();
        // tick mark (26 px from left edge)
        cx.strokeStyle = 'rgba(225,245,255,0.28)';
        cx.lineWidth = 1;
        cx.beginPath(); cx.moveTo(0, gy); cx.lineTo(22, gy); cx.stroke();
        // depth number
        cx.font = '500 13px "Barlow Semi Condensed", monospace';
        cx.fillStyle = 'rgba(225,245,255,0.52)';
        cx.textAlign = 'left';
        cx.fillText(String(dm), 28, gy);
        // 'm' suffix — smaller, dimmer
        var nmW = cx.measureText(String(dm)).width;
        cx.font = '10px "Barlow Semi Condensed", monospace';
        cx.fillStyle = 'rgba(225,245,255,0.32)';
        cx.fillText('m', 28 + nmW + 2, gy);
    }
    cx.textBaseline = 'alphabetic';
    cx.restore();

    // Particles (plankton)
    for (var j = 0; j < particles.length; j++) {
        var p = particles[j];
        var py = diverScreenY + (p.depth - depth) / metersPerPixel;
        if (py < -10 || py > H + 10) continue;
        var px = ((p.x % W) + W) % W;
        var densityAlpha = Math.min(1, p.depth / 50) * p.alpha
                         * Math.min(1, _localAtmo.particleDensity)
                         * _localAtmo.particleBrightness;
        cx.fillStyle = 'rgba(200,220,180,' + densityAlpha + ')';
        cx.beginPath();
        cx.arc(px, py, p.size, 0, Math.PI * 2);
        cx.fill();
        // Reef particulate: brighter white dots
        if (_site && _site.id === 'reef') {
            var _reefDotAlpha = 0.3 * Math.min(1, _localAtmo.particleDensity) * _localAtmo.particleBrightness;
            cx.fillStyle = 'rgba(255,255,255,' + _reefDotAlpha.toFixed(3) + ')';
            cx.beginPath();
            cx.arc(px, py + 3, p.size * 0.6, 0, Math.PI * 2);
            cx.fill();
        }
    }

    // TASK-022: Fish — world-space x rendered via camera transform
    for (var fi = 0; fi < fishes.length; fi++) {
        var f = fishes[fi];
        var fy = diverScreenY + (f.depth - depth) / metersPerPixel;
        if (fy < -40 || fy > H + 40) continue;
        var fsx = W * DIVER_SCREEN_X_FRACTION + (f.x - diverX) / metersPerPixel;
        if (fsx < -f.type.size * 3 || fsx > W + f.type.size * 3) continue;
        drawFish(cx, fsx, fy, f);
    }

    // Wildlife rendering — world-space x
    for (var wi = 0; wi < wildlife.length; wi++) {
        var w = wildlife[wi];
        var wScreenY = diverScreenY + (w.depth - depth) / metersPerPixel;
        var wsx = W * DIVER_SCREEN_X_FRACTION + (w.x - diverX) / metersPerPixel;
        if (wScreenY > -100 && wScreenY < H + 100 && wsx > -w.type.size * 3 && wsx < W + w.type.size * 3) {
            drawWildlife(cx, wsx, wScreenY, w);
        }
    }

    // TASK-044: Shark rendering — world-space x
    if (shark) {
        var sharkScreenY = diverScreenY + (shark.depth - depth) / metersPerPixel;
        var sharkScreenX = W * DIVER_SCREEN_X_FRACTION + (shark.x - diverX) / metersPerPixel;
        if (sharkScreenY > -100 && sharkScreenY < H + 100) {
            cx.save();
            cx.translate(sharkScreenX, sharkScreenY + Math.sin(shark.phase) * 4);
            if (shark.direction < 0) cx.scale(-1, 1);
            var ss = shark.size;
            // Body
            cx.fillStyle = 'rgba(40,50,60,0.85)';
            cx.beginPath();
            cx.ellipse(0, 0, ss, ss * 0.35, 0, 0, Math.PI * 2);
            cx.fill();
            // Dorsal fin
            cx.beginPath();
            cx.moveTo(-ss * 0.1, -ss * 0.35);
            cx.lineTo(ss * 0.05, -ss * 0.85);
            cx.lineTo(ss * 0.3, -ss * 0.3);
            cx.closePath();
            cx.fill();
            // Tail fin
            cx.beginPath();
            cx.moveTo(-ss, 0);
            cx.lineTo(-ss * 1.5, -ss * 0.5);
            cx.lineTo(-ss * 1.2, 0);
            cx.lineTo(-ss * 1.5, ss * 0.4);
            cx.closePath();
            cx.fill();
            // Pectoral fin
            cx.beginPath();
            cx.moveTo(ss * 0.1, ss * 0.2);
            cx.lineTo(-ss * 0.2, ss * 0.55);
            cx.lineTo(-ss * 0.3, ss * 0.15);
            cx.closePath();
            cx.fill();
            // Mouth
            cx.strokeStyle = 'rgba(20,25,30,0.9)';
            cx.lineWidth = 1.5;
            cx.beginPath();
            cx.moveTo(ss * 0.7, ss * 0.08);
            cx.lineTo(ss * 0.95, ss * 0.02);
            cx.lineTo(ss * 0.7, -ss * 0.05);
            cx.stroke();
            // Eye
            cx.fillStyle = '#111';
            cx.beginPath();
            cx.arc(ss * 0.6, -ss * 0.1, ss * 0.06, 0, Math.PI * 2);
            cx.fill();
            cx.fillStyle = 'rgba(200,0,0,0.5)';
            cx.beginPath();
            cx.arc(ss * 0.6, -ss * 0.1, ss * 0.03, 0, Math.PI * 2);
            cx.fill();
            cx.restore();
        }
    }

    // Reef redesign: blue-water haze toward the open-water edge (reef only)
    drawBlueHaze();

    // Bubbles
    for (var bi = 0; bi < bubbles.length; bi++) {
        var b = bubbles[bi];
        var by = diverScreenY + (b.depth - depth) / metersPerPixel;
        if (by < -20 || by > H + 20) continue;
        var bx = W * DIVER_SCREEN_X_FRACTION + b.x;
        var r = bubbleDisplayRadius(b);
        var alpha = Math.max(0, 1 - b.age / BUBBLE_MAX_AGE) * 0.6;
        cx.beginPath();
        cx.arc(bx, by, r, 0, Math.PI * 2);
        cx.fillStyle = 'rgba(200,230,255,' + alpha + ')';
        cx.fill();
        cx.strokeStyle = 'rgba(255,255,255,' + (alpha * 0.5) + ')';
        cx.lineWidth = 0.5;
        cx.stroke();
    }

    // Phase C: Guideline rope (drawn before diver so diver sits on top)
    drawGuideline();
    _renderDiag().record('renderEntities', _renderPassStarted);
    _renderPassStarted = _renderDiag().start();

    // Issue #36: depth-dependent color absorption — tints every world
    // object drawn so far (terrain, structures, features, particles, fish,
    // wildlife, bubbles, guideline) toward blue-grey with depth, restoring
    // true color within torch range. Runs BEFORE the cave/wreck darkness
    // passes and #54's local-atmosphere pass so those layer on top of an
    // already-tinted scene, matching the ordering the issue calls for.
    drawDepthColorAbsorption();
    _renderDiag().record('renderDepthAbsorption', _renderPassStarted);
    _renderPassStarted = _renderDiag().start();

    // Issue #32: cave-only turbidity cloud from stirred silt. Reads
    // ONLY the existing `visibility` state (no second reservoir), no-op
    // above SILT_CLOUD_MIN_VIS. Drawn BEFORE the silt/torch overlay so
    // the cave darkness pass tints/dims the cloud consistently with
    // everything else, and the torch adds a soft brightening on top via
    // sampleTorchLightAtWorldPoint().
    drawCaveSiltCloud();

    // Issue #37: subtle depth-scale ruler on the right edge. Drawn
    // BEFORE drawSiltAndTorch so the cave/wreck darkness overlay dims
    // it along with the rest of the world — matches the requirement
    // that it "dims along with everything else that responds to
    // _torchDark" without the ruler owning its own fade logic.
    drawDepthScale();

    // Phase C: Silt-out + torch overlay — dims the environment + guideline.
    // Drawn BEFORE the diver so the diver is never shadowed by its own torch.
    drawSiltAndTorch();

    // Light shafts punch down through the gloom to mark navigable passages.
    drawLightShafts();

    // Issue #32: additive light streaming through the cenote's REAR exit
    // opening. Wedge/gradient light-shaft recipe, origin-anchored to the
    // cave_exit visualZone (open-to-surface at x=146..200), not to the
    // main surfaceScreenY — the diver is inside overhead here, so
    // drawNearSurfaceAtmosphere has already returned.
    drawCaveExitLightShaft();

    // Issue #54: local water volumes — tint + distance fog composite
    // pass. Sits AFTER all world entities, silt, and torch so it reads
    // as an atmospheric layer over the scene, and BEFORE the diver so
    // the diver stays crisp. HUD is on a separate DOM layer, so it's
    // physically unable to be touched by this pass.
    drawLocalAtmospherePass(_localAtmo, W, H, W * DIVER_SCREEN_X_FRACTION, diverScreenY, metersPerPixel);
    _renderDiag().record('renderPostEffects', _renderPassStarted);
    _renderPassStarted = _renderDiag().start();

    // Diver (Phase B: tilt toward current direction proportional to current.level)
    var diverTilt = 0;
    if (current.active && current.level > 0) {
        diverTilt = current.direction * Math.min(current.level / CURRENT_PARAMS.maxStrength, 1) * 0.25;
    }
    drawDiver(W * DIVER_SCREEN_X_FRACTION, diverScreenY, diverTilt);
    drawForegroundLayer();

    // Phase C: Bad-air warning banner (cave unbreathable dome)
    if (badAirWarning) {
        cx.save();
        cx.textAlign = 'center';
        cx.font = 'bold 18px monospace';
        cx.fillStyle = 'rgba(255,80,40,0.9)';
        cx.fillText('⚠ BAD AIR — UNBREATHABLE POCKET', W / 2, H * 0.18);
        cx.textAlign = 'left';
        cx.restore();
    }

    // TASK-019: Gas switch notification
    if (gasSwitchNotifyTime > 0) {
        cx.save();
        cx.textAlign = 'center';
        cx.font = 'bold 24px monospace';
        var nAlpha = Math.min(1, gasSwitchNotifyTime / 0.5);
        cx.fillStyle = 'rgba(0,255,200,' + nAlpha + ')';
        cx.fillText(gasSwitchNotifyText, W / 2, H * 0.3);
        cx.textAlign = 'left';
        cx.restore();
    }

    // Issue #38: Contextual onboarding hint toast. Rendered at
    // HINT_TOAST_Y_FRAC so it sits BELOW the gas-switch banner and both
    // can be visible simultaneously without overlap. Suppressed while
    // any full-screen overlay is up (help/gas-info/dive-computer info
    // pages) and outside the diving state — drawScene() also runs in the
    // game-over screen and the issue explicitly bans hints there. Also
    // suppressed during fast-forward: the queue pump only refuses to
    // *start* a new toast while fast-forwarding, so a toast already
    // showing when FF is toggled on must still be hidden here, not just
    // left to expire on its own timer. The last-second fade uses the
    // same tail-alpha math as the gas-switch toast for visual consistency.
    if (hintNotifyTime > 0 && hintNotifyText && gameState === 'diving' && !showHelp && !showGasInfo &&
        !fastForwardActive && infoPageMode === 0) {
        cx.save();
        cx.textAlign = 'center';
        cx.font = 'bold 18px monospace';
        var hAlpha = Math.min(1, hintNotifyTime / 0.5);
        cx.fillStyle = 'rgba(255,220,120,' + hAlpha + ')';
        cx.fillText(hintNotifyText, W / 2, H * HINT_TOAST_Y_FRAC);
        cx.textAlign = 'left';
        cx.restore();
    }

    // Red edge flash on dangerous ascent rate
    if (gameState === 'diving' && ascentRate > 9) {
        var flashAlpha = (0.2 + 0.15 * Math.sin(Date.now() * 0.01)) * Math.min(1, (ascentRate - 9) / 9);
        ctx.fillStyle = 'rgba(255,0,0,' + flashAlpha + ')';
        ctx.fillRect(0, 0, W, 20);           // top
        ctx.fillRect(0, H - 20, W, 20);      // bottom
        ctx.fillRect(0, 0, 20, H);           // left
        ctx.fillRect(W - 20, 0, 20, H);      // right
    }

    // WP-020: Narcosis wobble cleanup
    if (narcWobble) cx.restore();
    cx.filter = 'none';

    // WP-020: Narcosis vignette (drawn stable, no wobble/filter)
    if (narcosisIndex > 0.15) {
        var vigAlpha = Math.min(0.7, (narcosisIndex - 0.15) * 0.82);
        var vigGrad = cx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.7);
        vigGrad.addColorStop(0, 'rgba(0,0,0,0)');
        vigGrad.addColorStop(1, 'rgba(0,0,0,' + vigAlpha.toFixed(2) + ')');
        cx.fillStyle = vigGrad;
        cx.fillRect(0, 0, W, H);
    }

    // Issue #53: opt-in visual-zone debug overlay. Off by default; when
    // enabled paints translucent zone rectangles + current-zone id text so
    // future consumers can verify the map/zone assignment visually.
    if (debugVisualZones) drawVisualZoneDebug(_localAtmo);

    // Issue #46: Instructor overlay ("Learn" mode). Painted LAST inside
    // drawScene so it stays legible on top of every darkness/silt/torch/
    // narcosis pass — this is instructional UI, not a world object. Only
    // reads pre-computed per-frame values (bcdGasSurfaceLiters, tissues,
    // amvRate, narcosisIndex, bubbles[]) — it must NEVER call
    // calculateNDL()/calculateCeiling()/etc from here (they're expensive
    // and are already cached in frameCalc, which the panel would use if
    // it needed them). Hidden while help / gas-info / info-page is up so
    // it never fights the full-screen overlays for space.
    if (instructorMode && gameState === 'diving'
        && !showHelp && !showGasInfo && infoPageMode === 0) {
        drawInstructorOverlay();
    }
    _renderDiag().record('renderForeground', _renderPassStarted);
}

// Issue #54: local atmosphere composite pass. One pass, one canvas
// save/restore, two visual layers:
//   1. Subtle tint multiply over the underwater region only (never
//      touches sky/surface, never touches HUD — HUD is a separate DOM
//      layer above canvas anyway; this is defence in depth). Kept
//      deliberately weak — the eventual #36 global depth absorption
//      should remain the dominant depth-darkening logic.
//   2. Radial "distance fog" gradient centered on the diver. Center
//      near-transparent; edge alpha derived from (1 - visibility).
//      NOT the same as the silt-out mechanic — silt is a separate
//      pass and layers on top additively.
// Called from drawScene() AFTER all world entities + silt/torch +
// light shafts, BEFORE the diver and foreground layer, so the diver
// stays crisp and the atmospheric character reads over the scene.
const LOCAL_ATMO_TINT_MAX_ALPHA  = 0.22;   // hard ceiling on tint pass alpha
const LOCAL_ATMO_TINT_STRENGTH   = 0.55;   // scales the deviation from neutral
const LOCAL_ATMO_FOG_CENTER_FRAC = 0.18;   // radial gradient inner radius (fraction of min(W,H))
const LOCAL_ATMO_FOG_EDGE_FRAC   = 0.75;   // outer radius (fraction of max(W,H))
const LOCAL_ATMO_FOG_MAX_ALPHA   = 0.55;   // cap on fog edge alpha

function drawLocalAtmospherePass(atmo, W, H, diverScreenX, diverScreenY, metersPerPixel) {
    if (!atmo) return;
    var cx = ctx;
    // Underwater region — everything at or below the surface line.
    var surfaceScreenY = diverScreenY - (depth / metersPerPixel);
    var waterTop = Math.max(0, surfaceScreenY);
    if (waterTop >= H) return; // fully above water — nothing to tint
    cx.save();

    // ---- 1. Tint pass ----
    // Convert tint multipliers (~0.8..1.2) into an RGB color to paint at
    // low alpha with 'multiply' composite. Deviation from 1.0 is scaled
    // by LOCAL_ATMO_TINT_STRENGTH to keep the effect subtle.
    var dR = 1 + (atmo.tintR - 1) * LOCAL_ATMO_TINT_STRENGTH;
    var dG = 1 + (atmo.tintG - 1) * LOCAL_ATMO_TINT_STRENGTH;
    var dB = 1 + (atmo.tintB - 1) * LOCAL_ATMO_TINT_STRENGTH;
    // Also fold ambient brightness in as a uniform multiplier.
    var amb = 1 + (atmo.ambient - 1) * LOCAL_ATMO_TINT_STRENGTH;
    dR *= amb; dG *= amb; dB *= amb;
    // Total deviation magnitude drives the alpha of the multiply pass;
    // a perfectly neutral profile (1,1,1,1) draws nothing.
    var deviation = Math.abs(dR - 1) + Math.abs(dG - 1) + Math.abs(dB - 1);
    if (deviation > 0.001) {
        var tintAlpha = Math.min(LOCAL_ATMO_TINT_MAX_ALPHA, deviation * 0.5);
        // Compute the RGB color we're multiplying into the framebuffer.
        // We render as a normal alpha blend of the target color — this is
        // cheaper than 'multiply' composite and reads the same on the
        // predominantly cool underwater palette.
        var r = Math.round(255 * Math.max(0, Math.min(1, dR)));
        var g = Math.round(255 * Math.max(0, Math.min(1, dG)));
        var b = Math.round(255 * Math.max(0, Math.min(1, dB)));
        cx.fillStyle = 'rgba(' + r + ',' + g + ',' + b + ',' + tintAlpha.toFixed(3) + ')';
        cx.fillRect(0, waterTop, W, H - waterTop);
    }

    // ---- 2. Radial distance fog ----
    // visibility == 1 → skip entirely.
    if (atmo.visibility < 0.999) {
        var fogAlpha = Math.min(LOCAL_ATMO_FOG_MAX_ALPHA, (1 - atmo.visibility) * 0.9);
        var innerR = Math.min(W, H) * LOCAL_ATMO_FOG_CENTER_FRAC;
        var outerR = Math.max(W, H) * LOCAL_ATMO_FOG_EDGE_FRAC;
        // Fog edge color leans on the local tint so a warmer/rustier
        // atmosphere fogs to a warmer edge than a cooler cave atmosphere.
        var fR = Math.round(255 * Math.max(0, Math.min(1, atmo.tintR * atmo.ambient * 0.35)));
        var fG = Math.round(255 * Math.max(0, Math.min(1, atmo.tintG * atmo.ambient * 0.35)));
        var fB = Math.round(255 * Math.max(0, Math.min(1, atmo.tintB * atmo.ambient * 0.4)));
        var fg = cx.createRadialGradient(diverScreenX, diverScreenY, innerR, diverScreenX, diverScreenY, outerR);
        fg.addColorStop(0, 'rgba(' + fR + ',' + fG + ',' + fB + ',0)');
        fg.addColorStop(1, 'rgba(' + fR + ',' + fG + ',' + fB + ',' + fogAlpha.toFixed(3) + ')');
        cx.fillStyle = fg;
        cx.fillRect(0, waterTop, W, H - waterTop);
    }
    cx.restore();
}

// Issue #53: debug visualization for the visualZones lookup. Purely
// diagnostic — never called in normal gameplay. Uses only sites.js data
// via visualZoneAt(); this function does not itself decide which zone
// the diver is in, keeping decoration/lookup concerns separated.
const VISUAL_ZONE_DEBUG = {
    mpp:        0.05,     // metres per pixel, matches drawScene() world scale
    // Issue #53/#100 (review follow-up): this was still hardcoded to the
    // pre-#100 0.25 look-ahead offset after drawScene() was recentered to
    // DIVER_SCREEN_X_FRACTION (0.5) — the debug rectangles were drawn 320px
    // off from the real world at 1280px width. Reference the shared
    // constant directly so the two can never drift apart again.
    diverSx:    DIVER_SCREEN_X_FRACTION, // diver screen-x fraction, matches drawScene()
    diverSy:    0.45,     // diver screen-y fraction, matches drawScene()
    fillAlpha:  0.10,     // translucent rectangle fill
    edgeAlpha:  0.45,     // rectangle outline
    labelAlpha: 0.75,     // per-rect id label
    labelFont:  '10px monospace',
    hudFont:    'bold 12px monospace',
    hudFill:    'rgba(255, 220, 80, 0.90)',
    hudBg:      'rgba(0, 0, 0, 0.55)',
    // Distinct hues so overlapping zones read as separate rectangles.
    palette: [
        '#ff6b6b', '#4ecdc4', '#ffe66d', '#a8e6cf', '#c780e8',
        '#ff9770', '#6ab7ff', '#f7a072', '#7ee8b8', '#e0b0ff'
    ]
};

function drawVisualZoneDebug(cachedAtmo) {
    var s = activeSite();
    if (!s || !s.visualZones || !s.visualZones.length) return;
    var cx = ctx;
    var W = cssWidth, H = cssHeight;
    var cfg = VISUAL_ZONE_DEBUG;
    var mpp = cfg.mpp;
    var dsx = W * cfg.diverSx;
    var dsy = H * cfg.diverSy;
    var zones = s.visualZones;
    cx.save();
    cx.font = cfg.labelFont;
    cx.textAlign = 'left';
    cx.textBaseline = 'top';
    for (var i = 0; i < zones.length; i++) {
        var z = zones[i];
        var sx1 = dsx + (z.x1 - diverX) / mpp;
        var sx2 = dsx + (z.x2 - diverX) / mpp;
        var sy1 = dsy + (z.d1 - depth) / mpp;
        var sy2 = dsy + (z.d2 - depth) / mpp;
        // Skip rectangles fully off-screen — cheap frustum cull.
        if (sx2 < -20 || sx1 > W + 20 || sy2 < -20 || sy1 > H + 20) continue;
        var col = cfg.palette[i % cfg.palette.length];
        cx.globalAlpha = cfg.fillAlpha;
        cx.fillStyle = col;
        cx.fillRect(sx1, sy1, sx2 - sx1, sy2 - sy1);
        cx.globalAlpha = cfg.edgeAlpha;
        cx.strokeStyle = col;
        cx.lineWidth = 1;
        cx.strokeRect(sx1 + 0.5, sy1 + 0.5, sx2 - sx1 - 1, sy2 - sy1 - 1);
        cx.globalAlpha = cfg.labelAlpha;
        cx.fillStyle = col;
        var lx = Math.max(4, sx1 + 4);
        var ly = Math.max(4, sy1 + 4);
        cx.fillText(z.id, lx, ly);
    }
    cx.globalAlpha = 1;
    // HUD text — current zone id + Issue #54 sampled atmosphere values.
    var here = visualZoneAt(diverX, depth, s);
    // Issue #54 (review follow-up): reuse the frame's one sample when
    // called from drawScene() (cachedAtmo param), same pass-through as
    // drawNearSurfaceAtmosphere()/drawSurfaceCaustics() above.
    var atmo = cachedAtmo !== undefined ? cachedAtmo : sampleLocalAtmosphere(s, diverX, depth);
    var label1 = 'ZONE: ' + (here ? here.id : '(none)');
    // Issue #54: sampled atmosphere values, one decimal each so the
    // overlay is short but still verifiable at a glance.
    var label2 = 'ATMO vis=' + atmo.visibility.toFixed(2)
        + ' tint=' + atmo.tintR.toFixed(2) + '/' + atmo.tintG.toFixed(2) + '/' + atmo.tintB.toFixed(2)
        + ' pd=' + atmo.particleDensity.toFixed(2)
        + ' pb=' + atmo.particleBrightness.toFixed(2)
        + ' amb=' + atmo.ambient.toFixed(2);
    cx.font = cfg.hudFont;
    var pad = 6;
    var lineH = 16;
    var textW = Math.max(cx.measureText(label1).width, cx.measureText(label2).width);
    cx.fillStyle = cfg.hudBg;
    cx.fillRect(8, 8, textW + pad * 2, 4 + lineH * 2);
    cx.fillStyle = cfg.hudFill;
    cx.fillText(label1, 8 + pad, 8 + pad - 2);
    cx.fillText(label2, 8 + pad, 8 + pad - 2 + lineH);
    cx.restore();
}

function drawDiver(x, y, tilt) {
    var cx = ctx;
    var t = waveTime;
    // Sprite spans ~104 local px (fin-tip → fingertip). At the world scale of
    // 20 px/m, scale 0.48 makes the diver ≈ 2.5 m fin-to-hand — realistically
    // smaller than a 3.6 m car/6.5 m lorry instead of dwarfing them.
    var scale = 0.48;

    // Update facing direction only while actively finning; hold last when still
    if (horizontalVelocity > 0.05) _diverFacing = 1;
    else if (horizontalVelocity < -0.05) _diverFacing = -1;

    // Fin-kick style depends on dive mode. Recreational divers FLUTTER kick
    // (legs alternate up/down, continuous). Technical / CCR divers FROG kick
    // (legs sweep symmetrically in phase — recovery, power stroke, then a glide
    // pause) — the standard kick for trim and silt control in overhead/tec
    // diving. Only animated while actually moving horizontally.
    var moving = Math.abs(horizontalVelocity) > 0.05;
    var useFrog = (typeof diveMode !== 'undefined') && diveMode !== 'rec';
    var farKick = 0, nearKick = 0, farSplay = 0, nearSplay = 0;
    if (moving) {
        if (useFrog) {
            // One cycle: recovery (heels drawn up) → power (quick thrust back,
            // fins whip apart) → glide (legs together, momentarily still). The
            // asymmetric timing gives the characteristic pause-and-glide rhythm.
            var fc = (t * 1.6) % (Math.PI * 2);
            var tuck, splay;
            if (fc < Math.PI * 0.55) {                 // recovery — slow draw-up
                var rr = fc / (Math.PI * 0.55);
                tuck = rr; splay = rr * 0.35;
            } else if (fc < Math.PI * 0.85) {          // power — fast thrust + whip
                var pw = (fc - Math.PI * 0.55) / (Math.PI * 0.30);
                tuck = 1 - pw; splay = 0.35 + 0.65 * pw;
            } else {                                   // glide — legs together, still
                tuck = 0; splay = 0;
            }
            farKick = nearKick = -tuck * 9;            // both legs in phase, heels up
            farSplay = -splay * 0.5;                   // fins splay apart on the sweep
            nearSplay = splay * 0.5;
        } else {
            var fk = Math.sin(t * 3.2);
            farKick = -fk * 7;                         // flutter — legs alternate
            nearKick = fk * 7;
        }
    }

    cx.save();
    cx.translate(x, y + Math.sin(t * 0.8) * 3);
    if (tilt) cx.rotate(tilt);
    cx.rotate(-0.12 + Math.sin(t * 0.7) * 0.03);
    cx.scale(scale * _diverFacing, scale);

    // ambient occlusion under diver
    var sh = cx.createRadialGradient(-2, 11, 1, -2, 11, 26);
    sh.addColorStop(0, 'rgba(0,0,0,0.14)'); sh.addColorStop(1, 'rgba(0,0,0,0)');
    cx.fillStyle = sh; cx.beginPath(); cx.ellipse(-2, 12, 26, 6, 0, 0, Math.PI * 2); cx.fill();

    // far leg + fin
    drawDiverLeg(cx, -16, 4, farKick, '#22262a', '#c45c0e', farSplay);

    // tank — issue #90: nudged up and toward the head (was riding low/rearward
    // on the back, disconnected from the shoulder/neck area)
    cx.save(); cx.rotate(-0.02);
    cx.fillStyle = '#1d3140';
    cx.beginPath(); cx.roundRect(-17, -20, 26, 11, 5); cx.fill();
    cx.fillStyle = '#0c1a23'; cx.fillRect(-19, -17, 4, 6);
    cx.fillStyle = 'rgba(150,205,225,0.25)'; cx.beginPath(); cx.roundRect(-15, -19, 22, 3, 2); cx.fill();
    cx.restore();

    // reg hose
    cx.strokeStyle = '#2a3038'; cx.lineWidth = 2.4; cx.lineCap = 'round';
    cx.beginPath(); cx.moveTo(-13, -13); cx.quadraticCurveTo(6, -6, 26, 2); cx.stroke();

    // torso — D1: grey wetsuit with gradient shading
    cx.fillStyle = '#2e3338';
    cx.beginPath(); cx.ellipse(0, 0, 23, 9.5, 0, 0, Math.PI * 2); cx.fill();
    var tg = cx.createLinearGradient(0, -10, 0, 10);
    tg.addColorStop(0, 'rgba(255,255,255,0.07)'); tg.addColorStop(1, 'rgba(0,0,0,0.15)');
    cx.fillStyle = tg; cx.beginPath(); cx.ellipse(0, 0, 23, 9.5, 0, 0, Math.PI * 2); cx.fill();
    cx.strokeStyle = 'rgba(206,231,240,0.5)'; cx.lineWidth = 1.5;
    cx.beginPath(); cx.ellipse(0, 0, 22, 8.6, 0, Math.PI * 1.05, Math.PI * 1.95); cx.stroke();

    // forward arm
    cx.strokeStyle = '#2e3338'; cx.lineWidth = 7; cx.lineCap = 'round';
    cx.beginPath(); cx.moveTo(14, -1); cx.quadraticCurveTo(30, 1, 42, 3 + Math.sin(t * 2) * 1.5); cx.stroke();
    cx.strokeStyle = 'rgba(206,231,240,0.5)'; cx.lineWidth = 1.2;
    cx.beginPath(); cx.moveTo(15, -4); cx.lineTo(40, 0); cx.stroke();

    // near leg + fin
    drawDiverLeg(cx, -15, 3, nearKick, '#2e3338', '#ff7a1a', nearSplay);

    // head + hood — D1: grey
    cx.fillStyle = '#2e3338';
    cx.beginPath(); cx.arc(27, -1, 8.6, 0, Math.PI * 2); cx.fill();
    var hg2 = cx.createRadialGradient(24, -3, 2, 27, -1, 9);
    hg2.addColorStop(0, 'rgba(255,255,255,0.08)'); hg2.addColorStop(1, 'rgba(0,0,0,0.18)');
    cx.fillStyle = hg2; cx.beginPath(); cx.arc(27, -1, 8.6, 0, Math.PI * 2); cx.fill();
    cx.strokeStyle = 'rgba(206,231,240,0.5)'; cx.lineWidth = 1.4;
    cx.beginPath(); cx.arc(27, -1, 8, Math.PI * 1.1, Math.PI * 1.9); cx.stroke();

    // mask frame (orange)
    cx.fillStyle = '#ff7a1a';
    cx.beginPath(); cx.roundRect(30.5, -5.5, 8, 10, 3); cx.fill();
    // mask lens (light blue)
    cx.fillStyle = '#bfe8ff';
    cx.beginPath(); cx.roundRect(32, -4, 5.5, 7.5, 2); cx.fill();
    // lens glint
    cx.fillStyle = 'rgba(255,255,255,0.65)';
    cx.beginPath(); cx.roundRect(32.5, -3.5, 2, 2.5, 0.5); cx.fill();

    cx.restore();
}

// D1: leg + fin helper (called for near and far legs).
// `splay` (optional) rotates the fin extra during the frog-kick power sweep.
function drawDiverLeg(cx, hx, hy, kick, col, finCol, splay) {
    splay = splay || 0;
    var kneeY = hy + 3 + kick * 0.4, ankleY = hy + 5 + kick;
    cx.strokeStyle = col; cx.lineCap = 'round';
    cx.lineWidth = 8; cx.beginPath(); cx.moveTo(hx, hy); cx.lineTo(hx - 13, kneeY); cx.stroke();
    cx.lineWidth = 6; cx.beginPath(); cx.moveTo(hx - 13, kneeY); cx.lineTo(hx - 26, ankleY); cx.stroke();
    cx.save(); cx.translate(hx - 26, ankleY); cx.rotate(0.15 + kick * 0.04 + splay);
    cx.fillStyle = finCol;
    cx.beginPath();
    cx.moveTo(0, -5); cx.lineTo(-18, -8); cx.quadraticCurveTo(-23, 0, -18, 8); cx.lineTo(0, 5); cx.closePath(); cx.fill();
    cx.strokeStyle = 'rgba(255,255,255,0.22)'; cx.lineWidth = 1.2;
    cx.beginPath(); cx.moveTo(0, -5); cx.lineTo(-16, -7.5); cx.stroke();
    cx.restore();
}

// D4: Boat A body — painted at (0,0) after caller translates/rotates
function paintShip(cx, isRefl) {
    // hull with gradient shading
    cx.beginPath();
    cx.moveTo(-64, 0); cx.lineTo(64, 0);
    cx.quadraticCurveTo(78, -2, 70, -14);
    cx.lineTo(-50, -16);
    cx.quadraticCurveTo(-66, -15, -64, -2);
    cx.closePath();
    if (!isRefl) {
        var hg = cx.createLinearGradient(0, -16, 0, 0);
        hg.addColorStop(0, '#1e3340'); hg.addColorStop(0.5, '#16252f'); hg.addColorStop(1, '#0f1b23');
        cx.fillStyle = hg;
    } else { cx.fillStyle = '#16252f'; }
    cx.fill();
    cx.fillStyle = 'rgba(52,230,255,0.5)'; cx.fillRect(-60, -5, 128, 2.4);
    if (!isRefl) {
        cx.strokeStyle = 'rgba(206,231,240,0.5)'; cx.lineWidth = 1.4;
        cx.beginPath(); cx.moveTo(-50, -16); cx.lineTo(70, -14); cx.stroke();
    }
    // wheelhouse
    cx.fillStyle = '#0f1b23';
    cx.beginPath(); cx.roundRect(-20, -40, 40, 26, 4); cx.fill();
    cx.fillStyle = isRefl ? 'rgba(150,200,220,0.25)' : 'rgba(180,225,240,0.6)';
    cx.beginPath(); cx.roundRect(-14, -36, 16, 12, 2); cx.fill();
    cx.fillStyle = isRefl ? 'rgba(150,200,220,0.18)' : 'rgba(180,225,240,0.45)';
    cx.beginPath(); cx.roundRect(8, -34, 7, 7, 2); cx.fill();
    // hardtop
    cx.fillStyle = '#16252f';
    cx.beginPath(); cx.roundRect(-26, -50, 52, 8, 3); cx.fill();
    cx.fillStyle = '#0f1b23'; cx.fillRect(-22, -42, 3, 12); cx.fillRect(19, -42, 3, 12);
    if (!isRefl) {
        cx.strokeStyle = 'rgba(206,231,240,0.5)'; cx.lineWidth = 1.2;
        cx.beginPath(); cx.moveTo(-26, -50); cx.lineTo(26, -50); cx.stroke();
    }
    // A-frame stern
    cx.strokeStyle = '#0f1b23'; cx.lineWidth = 3;
    cx.beginPath(); cx.moveTo(-46, -16); cx.lineTo(-40, -44); cx.lineTo(-34, -16); cx.stroke();
    // dive ladder
    if (!isRefl) {
        cx.strokeStyle = 'rgba(180,210,220,0.65)'; cx.lineWidth = 1.5;
        cx.beginPath(); cx.moveTo(-57, -3); cx.lineTo(-57, 15); cx.stroke();
        cx.beginPath(); cx.moveTo(-51, -3); cx.lineTo(-51, 15); cx.stroke();
        for (var ry = 1; ry <= 14; ry += 4.5) {
            cx.beginPath(); cx.moveTo(-57, ry); cx.lineTo(-51, ry); cx.stroke();
        }
    }
    // mast
    cx.strokeStyle = '#cdd5da'; cx.lineWidth = 1.6;
    cx.beginPath(); cx.moveTo(58, -14); cx.lineTo(58, -56); cx.stroke();
    // Alpha flag (swallowtail: white hoist, royal-blue fly)
    cx.save(); cx.translate(58, -56);
    cx.beginPath();
    cx.moveTo(0, 0); cx.lineTo(26, 0); cx.lineTo(18, 8.5); cx.lineTo(26, 17); cx.lineTo(0, 17); cx.closePath();
    cx.save(); cx.clip();
    cx.fillStyle = '#f4f7f8'; cx.fillRect(0, 0, 12, 17);
    cx.fillStyle = '#1555c0'; cx.fillRect(12, 0, 26, 17);
    cx.restore();
    if (!isRefl) { cx.strokeStyle = 'rgba(100,140,200,0.3)'; cx.lineWidth = 0.8; cx.stroke(); }
    cx.restore();
    // diver-down flag below Alpha
    cx.save(); cx.translate(58, -36);
    cx.fillStyle = '#d83a39'; cx.beginPath(); cx.rect(0, 0, 20, 13); cx.fill();
    cx.save(); cx.beginPath(); cx.rect(0, 0, 20, 13); cx.clip();
    cx.strokeStyle = '#f4f7f8'; cx.lineWidth = 3;
    cx.beginPath(); cx.moveTo(0, 13); cx.lineTo(20, 0); cx.stroke();
    cx.restore(); cx.restore();
}

// ============================================================
//  PHASE C — SITE TERRAIN + OVERHEAD HELPERS
// ============================================================

function drawTerrain() {
    var W = cssWidth, H = cssHeight;
    var diverScreenX = W * DIVER_SCREEN_X_FRACTION;
    var diverScreenY = H * 0.45;
    var mpp = 0.05;
    var cx = ctx;
    var s = activeSite();

    if (!s) {
        // Open water — original flat seabed at MAX_DEPTH + texture + treasure chest
        var floorY = diverScreenY + (MAX_DEPTH - depth) / mpp;
        if (floorY < H + 100) {
            cx.fillStyle = '#2a1f0e';
            cx.fillRect(0, floorY, W, H - floorY + 100);
            cx.fillStyle = '#3d2f1a';
            for (var sfx = 0; sfx < W; sfx += 12) {
                var sfh = 2 + Math.sin(sfx * 0.3) * 3;
                cx.fillRect(sfx, floorY - sfh, 8, sfh);
            }
            // BYP-007: Treasure chest
            var chestX = W * 0.4;
            var chestW = 40, chestH = 25, lidH = 10;
            var chestY = floorY - chestH - lidH;
            cx.save();
            cx.shadowColor = 'rgba(255,215,0,0.6)';
            cx.shadowBlur = 15 + 5 * Math.sin(Date.now() * 0.003);
            cx.fillStyle = '#5c3a1e';
            cx.fillRect(chestX - chestW / 2, chestY + lidH, chestW, chestH);
            cx.fillStyle = '#7a4e2e';
            cx.beginPath();
            cx.moveTo(chestX - chestW / 2 - 1, chestY + lidH);
            cx.lineTo(chestX + chestW / 2 + 1, chestY + lidH);
            cx.quadraticCurveTo(chestX + chestW / 2 + 1, chestY, chestX, chestY - 2);
            cx.quadraticCurveTo(chestX - chestW / 2 - 1, chestY, chestX - chestW / 2 - 1, chestY + lidH);
            cx.fill();
            cx.restore();
            cx.fillStyle = '#8b7333';
            cx.fillRect(chestX - chestW / 2, chestY + lidH, chestW, 2);
            cx.fillRect(chestX - chestW / 2, chestY + lidH + chestH - 2, chestW, 2);
            cx.fillStyle = '#ffd700';
            cx.fillRect(chestX - 4, chestY + lidH - 2, 8, 8);
            cx.fillStyle = '#b8860b';
            cx.beginPath();
            cx.arc(chestX, chestY + lidH + 2, 2, 0, Math.PI * 2);
            cx.fill();
        }
        return;
    }

    // Site-specific terrain — piecewise-linear floor (and ceiling for cave)
    var xLeftM  = diverX + (0 - diverScreenX) * mpp - 2;   // a bit beyond left edge
    var xRightM = diverX + (W - diverScreenX) * mpp + 2;   // a bit beyond right edge
    var stepM = 4 * mpp;  // sample every 4 pixels

    // Issue #56: fetch the per-zone accumulation profile ONCE for this
    // frame's terrain pass (not per-column) — zone lookup is a linear
    // scan over the site's visualZones, so keep it out of the sampling loop.
    var _accumZoneHere = visualZoneAt(diverX, floorAt(diverX), s);
    var _accumProfile = accumulationProfileFor(s.id, _accumZoneHere ? _accumZoneHere.id : null);

    // Floor polygon — fill from profile down to bottom of screen
    // D3: Shore gets a sandy gradient; reef is warm rock; cave is warm
    // limestone bedrock; others dark brown.
    var reefMesa = (s.id === 'reef');
    var caveSite = (s.id === 'cave');
    if (s.id === 'shore') {
        var sandGrad = cx.createLinearGradient(0, diverScreenY + (3 - depth) / mpp, 0, H);
        sandGrad.addColorStop(0, '#c2a06a');
        sandGrad.addColorStop(0.2, '#9a7840');
        sandGrad.addColorStop(0.6, '#5a3f22');
        sandGrad.addColorStop(1, '#2a1f0e');
        cx.fillStyle = sandGrad;
    } else if (reefMesa) {
        // Warm Red-Sea rock, anchored to absolute depth (surface-relative) so
        // the whole seamount reads as one solid sunlit-to-shadow mass.
        var surfY = diverScreenY - depth / mpp;
        var reefRockGrad = cx.createLinearGradient(0, surfY, 0, surfY + 140 / mpp * 0.05 + 900);
        reefRockGrad.addColorStop(0,    '#7a4a32');
        reefRockGrad.addColorStop(0.12, '#5a3623');
        reefRockGrad.addColorStop(0.45, '#3f2818');
        reefRockGrad.addColorStop(1,    '#241509');
        cx.fillStyle = reefRockGrad;
    } else if (caveSite) {
        // Depth-graded limestone: warm tan/brown at the shallow entrance,
        // cooling to bare grey rock down in the deep cathedral. Anchored to the
        // surface (2000 px ≈ 100 m) so the colour tracks absolute depth all the
        // way to the cathedral floor.
        var caveFloorSurfY = diverScreenY - depth / mpp;
        var caveFloorGrad = cx.createLinearGradient(0, caveFloorSurfY, 0, caveFloorSurfY + 2000);
        caveFloorGrad.addColorStop(0,    CAVE_PAL.rockMid);    // d0  warm brown
        caveFloorGrad.addColorStop(0.06, CAVE_PAL.rockWarm);   // d6  brown
        caveFloorGrad.addColorStop(0.13, CAVE_PAL.greyBrown);  // d13 transition
        caveFloorGrad.addColorStop(0.22, CAVE_PAL.greyMid);    // d22 grey
        caveFloorGrad.addColorStop(0.40, CAVE_PAL.greyShade);  // d40 dark grey
        caveFloorGrad.addColorStop(1,    CAVE_PAL.greyDark);   // d100 near black
        cx.fillStyle = caveFloorGrad;
    } else {
        cx.fillStyle = '#2a1f0e';
    }
    // Build the floor polygon, remembering the silhouette points so the reef
    // can re-clip to them for rock texture.
    var floorPts = [];
    for (var fwx = xLeftM; fwx <= xRightM + stepM; fwx += stepM) {
        var fdCol = floorAt(fwx);
        var fdVis = visualProfileDepth(s.id, 'floor', fwx, fdCol);
        var fpx = diverScreenX + (fwx - diverX) / mpp;
        var fpy = diverScreenY + (fdVis - depth) / mpp;
        floorPts.push([fpx, fpy]);
    }
    var floorRight = diverScreenX + (xRightM + stepM - diverX) / mpp;
    var floorLeft  = diverScreenX + (xLeftM - diverX) / mpp;
    cx.beginPath();
    for (var fpi = 0; fpi < floorPts.length; fpi++) {
        if (fpi === 0) cx.moveTo(floorPts[fpi][0], floorPts[fpi][1]);
        else cx.lineTo(floorPts[fpi][0], floorPts[fpi][1]);
    }
    cx.lineTo(floorRight, H + 10);
    cx.lineTo(floorLeft, H + 10);
    cx.closePath();
    cx.fill();

    // Issue #41: material texture overlay on the floor polygon (shore sand,
    // cave limestone). Reef gets its `crust`/`grain` inside its own clip
    // block below (it needs the mesa-only clip anyway for its stipple pass).
    if (s.id === 'shore' || caveSite) {
        cx.save();
        cx.beginPath();
        for (var fpi2 = 0; fpi2 < floorPts.length; fpi2++) {
            if (fpi2 === 0) cx.moveTo(floorPts[fpi2][0], floorPts[fpi2][1]);
            else cx.lineTo(floorPts[fpi2][0], floorPts[fpi2][1]);
        }
        cx.lineTo(floorRight, H + 10);
        cx.lineTo(floorLeft, H + 10);
        cx.closePath();
        cx.clip();
        var floorTile = (s.id === 'shore') ? _matTiles.sand : _matTiles.limestone;
        fillWithMaterialPattern(cx, floorTile, diverX, depth, false);
        // Issue #56: sediment cap on this horizontal top surface.
        drawSedimentCap(cx, floorPts, {
            intensity: _accumProfile.sediment,
            thicknessM: 0.28,
            mpp: mpp,
            worldSeed: xLeftM * 11.7 + ACCUM_SEED.sediment
        });
        cx.restore();
    }

    // Reef: warm rim along the lit crest + clipped rock texture so the mesa
    // reads as solid coral rock, not a flat silhouette.
    if (reefMesa) {
        cx.save();
        // soft warm rim on the upper silhouette (the sunlit edge)
        cx.strokeStyle = 'rgba(168,115,85,0.5)';
        cx.lineWidth = 2.5;
        cx.beginPath();
        for (var ri = 0; ri < floorPts.length; ri++) {
            if (ri === 0) cx.moveTo(floorPts[ri][0], floorPts[ri][1]);
            else cx.lineTo(floorPts[ri][0], floorPts[ri][1]);
        }
        cx.stroke();
        // clip to the mesa body and stipple lumps + cracks (stable world seed)
        cx.beginPath();
        for (var ci = 0; ci < floorPts.length; ci++) {
            if (ci === 0) cx.moveTo(floorPts[ci][0], floorPts[ci][1]);
            else cx.lineTo(floorPts[ci][0], floorPts[ci][1]);
        }
        cx.lineTo(floorRight, H + 10);
        cx.lineTo(floorLeft, H + 10);
        cx.closePath();
        cx.clip();
        // Issue #41: coral crust texture over the sunlit crest, plain grain
        // deeper where crust growth thins out. Uses the floor depth AT the
        // diver's world-x so the threshold tracks the terrain profile rather
        // than the diver's viewing depth (which would toggle with vertical
        // motion).
        var reefFloorHere = floorAt(diverX);
        var reefTile = (reefFloorHere < REEF_CRUST_MAX_DEPTH) ? _matTiles.crust : _matTiles.grain;
        fillWithMaterialPattern(cx, reefTile, diverX, depth, false);
        // Issue #56: sediment cap on the mesa's top surface.
        drawSedimentCap(cx, floorPts, {
            intensity: _accumProfile.sediment,
            thicknessM: 0.28,
            mpp: mpp,
            worldSeed: xLeftM * 11.7 + ACCUM_SEED.sediment
        });
        // Issue #56: growth edge along the sunlit upper crest — reef only.
        drawGrowthEdge(cx, floorPts, {
            intensity: _accumProfile.growth,
            worldSeed: xLeftM * 9.13 + ACCUM_SEED.growth,
            variant: 'coralline'
        });
        // shading lumps — iterate an ABSOLUTE integer grid index so each cell's
        // seed is identical every frame (no float drift from a camera-relative
        // start → no flicker while scrolling).
        var lumpStepM = 1.6;
        for (var lk = Math.floor(xLeftM / lumpStepM); lk <= Math.ceil(xRightM / lumpStepM); lk++) {
            var lwx = lk * lumpStepM;
            var lseed = lwx * 12.9;
            var lpx = diverScreenX + (lwx - diverX) / mpp;
            var ldepth = floorAt(lwx) + 2 + sRand(lseed) * 60;
            var lpy = diverScreenY + (ldepth - depth) / mpp;
            var lr = 8 + sRand(lseed + 3.1) * 22;
            cx.fillStyle = sRand(lseed + 7.9) > 0.5 ? 'rgba(168,115,85,0.07)' : 'rgba(0,0,0,0.14)';
            cx.beginPath(); cx.arc(lpx, lpy, lr, 0, Math.PI * 2); cx.fill();
        }
        // a few vertical cracks down the flanks
        cx.strokeStyle = 'rgba(0,0,0,0.22)'; cx.lineWidth = 1.4;
        for (var crk = Math.floor(xLeftM / 5); crk <= Math.ceil(xRightM / 5); crk++) {
            var crwx = crk * 5;
            var cseed = crwx * 3.7;
            var ctop = floorAt(crwx);
            var cpx = diverScreenX + (crwx - diverX) / mpp;
            var cpyTop = diverScreenY + (ctop + 2 - depth) / mpp;
            cx.beginPath();
            cx.moveTo(cpx, cpyTop);
            cx.quadraticCurveTo(cpx + (sRand(cseed) - 0.5) * 18, cpyTop + 120,
                                cpx + (sRand(cseed + 2) - 0.5) * 14, cpyTop + 260);
            cx.stroke();
        }
        cx.restore();
    }

    // Issue #34: AO contact band along the floor silhouette. Runs on ALL
    // sites (shore/reef/cave/wreck) — creases in the silhouette pool
    // shadow, giving the terrain more perceived volume.
    drawContactBand(cx, floorPts, CONTACT_AO.terrain);
    // Issue #56: material accumulation along the same silhouette, layered
    // ON TOP of #34's AO band (drawn after it — see drawContactAccumulation's
    // header comment for why this doesn't double up the darkness).
    drawContactAccumulation(cx, floorPts, {
        intensity: _accumProfile.contactDebris,
        mpp: mpp,
        worldSeed: xLeftM * 13.3 + ACCUM_SEED.contact,
        side: 'above'
    });

    // Ceiling polygon — textured rock, filled from profile up to top of screen (cave only)
    if (s.ceiling) {
        // Build the ceiling outline points (and remember them for texturing)
        var ceilPts = [];
        for (var cwx = xLeftM; cwx <= xRightM + stepM; cwx += stepM) {
            var cdCol = ceilingAt(cwx);
            if (cdCol <= 0.01) continue;  // open shaft — leave sky visible
            var cdVis = visualProfileDepth(s.id, 'ceiling', cwx, cdCol);
            ceilPts.push([diverScreenX + (cwx - diverX) / mpp,
                          diverScreenY + (cdVis - depth) / mpp]);
        }
        if (ceilPts.length > 1) {
            var cLeftX = ceilPts[0][0], cRightX = ceilPts[ceilPts.length - 1][0];
            // Rock body gradient — warm limestone for caves, dark slate otherwise.
            var ceilSurfY = diverScreenY - depth / mpp;
            var rockGrad;
            if (caveSite) {
                // Depth-graded like the floor: soil + warm brown at the rim,
                // cooling to grey bedrock where the ceiling dips deep.
                rockGrad = cx.createLinearGradient(0, ceilSurfY - 20, 0, ceilSurfY + 1000);
                rockGrad.addColorStop(0,    CAVE_PAL.earth);       // soil layer at karst rim
                rockGrad.addColorStop(0.05, CAVE_PAL.earthLite);
                rockGrad.addColorStop(0.12, CAVE_PAL.rockMid);     // bedrock proper (≈d5)
                rockGrad.addColorStop(0.24, CAVE_PAL.rockWarm);    // brown (≈d11)
                rockGrad.addColorStop(0.40, CAVE_PAL.greyBrown);   // transition (≈d19)
                rockGrad.addColorStop(0.58, CAVE_PAL.greyMid);     // grey (≈d28)
                rockGrad.addColorStop(1,    CAVE_PAL.greyDark);
            } else {
                rockGrad = cx.createLinearGradient(0, -10, 0, diverScreenY);
                rockGrad.addColorStop(0, '#15110d');
                rockGrad.addColorStop(1, '#3a2e22');
            }
            cx.fillStyle = rockGrad;
            cx.beginPath();
            cx.moveTo(cLeftX, -10);
            cx.lineTo(ceilPts[0][0], ceilPts[0][1]);
            for (ci = 1; ci < ceilPts.length; ci++) cx.lineTo(ceilPts[ci][0], ceilPts[ci][1]);
            cx.lineTo(cRightX, -10);
            cx.closePath();
            cx.fill();

            // Clip to the rock and paint strata bands + speckle for texture
            cx.save();
            cx.clip();
            if (caveSite) {
                // Issue #41: limestone material texture on the cave ceiling
                // rock body — placed before the earth band + strata + speckle
                // so those sharper features still read on top of the base
                // texture.
                fillWithMaterialPattern(cx, _matTiles.limestone, diverX, depth, false);
                // Earth band along the karst rim — a thin dark soil layer
                // hanging just under the surface (depth 0–1.5 m).
                var earthTopY = ceilSurfY;
                var earthBotY = ceilSurfY + 1.5 / mpp;
                cx.fillStyle = CAVE_PAL.earth;
                cx.fillRect(0, earthTopY, W, earthBotY - earthTopY);
                // Hanging tree-root strands from the underside of the earth
                // band. Seeded by WORLD-x (not screen-x) so they stay anchored
                // to the karst rim and don't slide along as the camera scrolls.
                cx.strokeStyle = '#1a1208';
                cx.lineWidth = 1.1;
                cx.lineCap = 'round';
                var rootStepM = 1.3;
                for (var rk = Math.floor(xLeftM / rootStepM); rk <= Math.ceil(xRightM / rootStepM); rk++) {
                    var rwx = rk * rootStepM;
                    var rtSeed = rwx * 13.7;
                    var rtH = 12 + sRand(rtSeed) * 32;
                    var rtX = diverScreenX + (rwx - diverX) / mpp + (sRand(rtSeed + 1) - 0.5) * 14;
                    cx.beginPath();
                    cx.moveTo(rtX, earthBotY);
                    cx.quadraticCurveTo(rtX + (sRand(rtSeed + 2) - 0.5) * 8,
                                        earthBotY + rtH * 0.55,
                                        rtX + (sRand(rtSeed + 3) - 0.5) * 6,
                                        earthBotY + rtH);
                    cx.stroke();
                }
                // bedding strata — horizontal layer lines through the limestone
                cx.strokeStyle = 'rgba(20,10,4,0.35)';
                cx.lineWidth = 1.6;
                for (var bbD = 4; bbD < 60; bbD += 4.5) {
                    cx.beginPath();
                    var bf = true;
                    for (var bbX = xLeftM; bbX <= xRightM + stepM; bbX += stepM) {
                        var bbY = ceilSurfY + bbD / mpp + Math.sin(bbX * 0.4 + bbD) * 2;
                        var bbPx = diverScreenX + (bbX - diverX) / mpp;
                        if (bf) { cx.moveTo(bbPx, bbY); bf = false; }
                        else cx.lineTo(bbPx, bbY);
                    }
                    cx.stroke();
                }
                // pocking speckle — dark dots scattered in the bedrock
                var spkStepM = 1.2;
                for (var spk = Math.floor(xLeftM / spkStepM); spk <= Math.ceil(xRightM / spkStepM); spk++) {
                    var spwx = spk * spkStepM;
                    var spSeed = spwx * 41.3;
                    var spDepthOffset = sRand(spSeed) * 12;
                    var spY = ceilSurfY + spDepthOffset / mpp;
                    var spX = diverScreenX + (spwx - diverX) / mpp + (sRand(spSeed + 1) - 0.5) * 16;
                    var spR = 0.6 + sRand(spSeed + 2) * 1.4;
                    cx.fillStyle = sRand(spSeed + 3) > 0.5
                        ? 'rgba(16,14,10,0.5)' : 'rgba(156,152,140,0.3)';
                    cx.beginPath(); cx.arc(spX, spY, spR, 0, Math.PI * 2); cx.fill();
                }
                // Highlight rim just under the ceiling lip
                cx.strokeStyle = 'rgba(216,200,168,0.45)';
                cx.lineWidth = 1.4;
                cx.beginPath();
                for (var hi = 0; hi < ceilPts.length; hi++) {
                    if (hi === 0) cx.moveTo(ceilPts[hi][0], ceilPts[hi][1] - 0.5);
                    else cx.lineTo(ceilPts[hi][0], ceilPts[hi][1] - 0.5);
                }
                cx.stroke();
            } else {
                cx.strokeStyle = 'rgba(0,0,0,0.22)';
                cx.lineWidth = 2;
                for (var bandD = 0; bandD < 40; bandD += 6) {
                    cx.beginPath();
                    var bFirst = true;
                    for (var bx = xLeftM; bx <= xRightM + stepM; bx += stepM) {
                        var by = diverScreenY + (ceilingAt(bx) - bandD - depth) / mpp;
                        var wob = Math.sin(bx * 0.6 + bandD) * 3;
                        var bpx = diverScreenX + (bx - diverX) / mpp;
                        if (bFirst) { cx.moveTo(bpx, by + wob); bFirst = false; }
                        else cx.lineTo(bpx, by + wob);
                    }
                    cx.stroke();
                }
                // Highlight just below the rock lip
                cx.strokeStyle = 'rgba(150,125,95,0.25)';
                cx.lineWidth = 2;
                cx.beginPath();
                for (var hi2 = 0; hi2 < ceilPts.length; hi2++) {
                    if (hi2 === 0) cx.moveTo(ceilPts[hi2][0], ceilPts[hi2][1] - 1);
                    else cx.lineTo(ceilPts[hi2][0], ceilPts[hi2][1] - 1);
                }
                cx.stroke();
            }
            cx.restore();

            // Issue #34: AO contact band along the ceiling silhouette.
            drawContactBand(cx, ceilPts, CONTACT_AO.terrain);
        }

        // Cave-only: stalactites hanging from the ceiling + stalagmites on
        // the floor, world-anchored (seed by world-x) so they don't shimmer
        // as the camera scrolls.
        if (caveSite) {
            drawCaveSpeleothems(cx, xLeftM, xRightM, diverScreenX, diverScreenY, mpp);
        }
    }
}

// ── Cenote bedding speleothems: stalactites + stalagmites ──
// Procedural calcite formations drawn along the ceiling/floor profiles.
// Issue #32: when a stalactite tip and a stalagmite tip at the same
// world-x end up within COLUMN_MERGE_TOL_M of one another, they're
// drawn as a continuous column instead of two disconnected drips.
// Also seeds flowstone drapes on a few standout STEEP wall sections
// (never everywhere — a handful of formations, not a texture).
function drawCaveSpeleothems(cx, xLeftM, xRightM, dsx, dsy, mpp) {
    var stepM = 0.9;
    // Iterate an ABSOLUTE integer grid index (not a camera-relative float start)
    // so every formation's seed is identical each frame → no flicker scrolling.
    for (var k = Math.floor(xLeftM / stepM); k <= Math.ceil(xRightM / stepM); k++) {
        var x = k * stepM;
        var seed = x * 11.7 + 3.1;
        var cd = ceilingAt(x);
        var fd = floorAt(x);
        // Decide independently whether each end rolls a formation, exactly
        // as before — the merge below just changes how they're painted.
        var haveStalac = cd > 1 && sRand(seed) < 0.55;
        var haveStalag = cd > 1 && fd > 12 && sRand(seed + 5.1) < 0.4;
        // Pre-compute geometry using the same formulas as before.
        var sH = (0.4 + sRand(seed + 1.3) * 1.8) / mpp;
        var sW = (0.18 + sRand(seed + 2.7) * 0.42) / mpp;
        var gH = (0.4 + sRand(seed + 6.3) * 1.4) / mpp;
        var gW = (0.22 + sRand(seed + 7.1) * 0.46) / mpp;

        // ---- column merge check (issue #32) ----
        // Convert screen heights back to world metres to test the tip gap.
        var stalacTipD = haveStalac ? cd + sH * mpp : null;
        var stalagTipD = haveStalag ? fd - gH * mpp : null;
        var mergeGap = null;
        if (stalacTipD != null && stalagTipD != null) {
            mergeGap = stalagTipD - stalacTipD;   // positive = still separated
        }
        var shouldMerge = (mergeGap != null && mergeGap <= COLUMN_MERGE_TOL_M);
        if (shouldMerge) {
            var colPx = dsx + (x - diverX) / mpp;
            var colTopY = dsy + (cd - depth) / mpp;
            var colBotY = dsy + (fd - depth) / mpp;
            _drawSpeleothemColumn(cx, colPx, colTopY, colBotY,
                Math.max(sW, gW), Math.min(sW, gW), seed);
        } else {
            if (haveStalac) {
                var px = dsx + (x - diverX) / mpp;
                var py = dsy + (cd - depth) / mpp;
                drawStalactite(cx, px, py, sH, sW);
            }
            if (haveStalag) {
                var fpx = dsx + (x - diverX) / mpp;
                var fpy = dsy + (fd - depth) / mpp;
                drawStalagmite(cx, fpx, fpy, gH, gW);
            }
        }

        // ---- flowstone drape on steep wall sections (issue #32) ----
        // Sample the local ceiling/floor gradients; only steep spots roll.
        // Kept infrequent (FLOWSTONE_PROBABILITY) so this reads as a
        // handful of standout drapes across the cave, not a uniform skin.
        var cdL = ceilingAt(x - stepM), cdR = ceilingAt(x + stepM);
        var fdL = floorAt(x - stepM),   fdR = floorAt(x + stepM);
        var ceilGrad = Math.abs((cdR - cdL) / (2 * stepM));
        var floorGrad = Math.abs((fdR - fdL) / (2 * stepM));
        // Ceiling flowstone — hangs on a steep ceiling section (going up
        // fast means the wall behind us is sheer). Requires cave overhead.
        if (haveStalac === false && cd > 4 && ceilGrad > FLOWSTONE_STEEP_GRADIENT &&
            sRand(seed + 13.7) < FLOWSTONE_PROBABILITY) {
            var fpxC = dsx + (x - diverX) / mpp;
            var fpyC = dsy + (cd - depth) / mpp;
            var wC = (1.4 + sRand(seed + 14.1) * 1.2) / mpp;
            var hC = (0.9 + sRand(seed + 14.3) * 1.4) / mpp;
            _drawFlowstoneDrape(cx, fpxC, fpyC, wC, hC, seed + 14);
        }
        // Floor flowstone — on a steep floor drop (down-shaft/up-shaft).
        // Draw the drape above the floor point so it reads as a curtain
        // draped from the wall down to the deck.
        if (haveStalag === false && fd > 20 && floorGrad > FLOWSTONE_STEEP_GRADIENT &&
            sRand(seed + 17.7) < FLOWSTONE_PROBABILITY) {
            var fpxF = dsx + (x - diverX) / mpp;
            var wF = (1.4 + sRand(seed + 18.1) * 1.2) / mpp;
            var hF = (1.2 + sRand(seed + 18.3) * 1.6) / mpp;
            var fpyF = dsy + (fd - depth) / mpp - hF;
            _drawFlowstoneDrape(cx, fpxF, fpyF, wF, hF, seed + 18);
        }
    }
}

// Draw a continuous stalactite→stalagmite column. Purely visual — the
// pair still carries no collision (see TC-32-COLLISION-UNCHANGED).
function _drawSpeleothemColumn(cx, x, topY, botY, wTop, wBot, seed) {
    cx.save();
    var g = cx.createLinearGradient(x, topY, x, botY);
    g.addColorStop(0,    CAVE_PAL.calciteLite);
    g.addColorStop(0.5,  CAVE_PAL.calciteMid);
    g.addColorStop(1,    CAVE_PAL.calciteLite);
    cx.fillStyle = g;
    // Slight waist: narrower in the middle where the two drips met.
    var midY = (topY + botY) * 0.5;
    var waist = Math.min(wTop, wBot) * 0.7 + (sRand(seed + 19.1) - 0.5) * 2;
    if (waist < 2) waist = 2;
    cx.beginPath();
    cx.moveTo(x - wTop * 0.5, topY);
    cx.lineTo(x + wTop * 0.5, topY);
    cx.quadraticCurveTo(x + wTop * 0.55, topY + (midY - topY) * 0.4, x + waist * 0.5, midY);
    cx.quadraticCurveTo(x + wBot * 0.55, midY + (botY - midY) * 0.6, x + wBot * 0.5, botY);
    cx.lineTo(x - wBot * 0.5, botY);
    cx.quadraticCurveTo(x - wBot * 0.55, midY + (botY - midY) * 0.6, x - waist * 0.5, midY);
    cx.quadraticCurveTo(x - wTop * 0.55, topY + (midY - topY) * 0.4, x - wTop * 0.5, topY);
    cx.closePath();
    cx.fill();
    // Central highlight rib
    cx.strokeStyle = 'rgba(232,220,192,0.5)';
    cx.lineWidth = 1;
    cx.beginPath();
    cx.moveTo(x, topY + 2);
    cx.lineTo(x, botY - 2);
    cx.stroke();
    // Layered horizontal rings — 2-3 pale ribbons hinting at growth bands.
    var bands = 2 + Math.floor(sRand(seed + 19.3) * 2);
    cx.strokeStyle = 'rgba(232,220,192,0.32)';
    cx.lineWidth = 0.8;
    for (var bi = 1; bi <= bands; bi++) {
        var by = topY + (botY - topY) * (bi / (bands + 1));
        cx.beginPath();
        cx.moveTo(x - waist * 0.6, by);
        cx.quadraticCurveTo(x, by + 0.8, x + waist * 0.6, by);
        cx.stroke();
    }
    cx.restore();
}

function drawStalactite(cx, x, y, h, w) {
    cx.save();
    // flowstone gradient — pale calcite to dark wall shadow
    var g = cx.createLinearGradient(x, y, x, y + h);
    g.addColorStop(0,   CAVE_PAL.calciteLite);
    g.addColorStop(0.6, CAVE_PAL.calciteMid);
    g.addColorStop(1,   CAVE_PAL.calciteDark);
    cx.fillStyle = g;
    cx.beginPath();
    cx.moveTo(x - w * 0.5, y);
    cx.lineTo(x + w * 0.5, y);
    cx.lineTo(x + w * 0.35, y + h * 0.18);
    cx.lineTo(x + w * 0.45, y + h * 0.32);
    cx.lineTo(x + w * 0.22, y + h * 0.55);
    cx.lineTo(x + w * 0.28, y + h * 0.72);
    cx.lineTo(x,             y + h);
    cx.lineTo(x - w * 0.28, y + h * 0.72);
    cx.lineTo(x - w * 0.22, y + h * 0.55);
    cx.lineTo(x - w * 0.45, y + h * 0.32);
    cx.lineTo(x - w * 0.35, y + h * 0.18);
    cx.closePath();
    cx.fill();
    // central highlight rib
    cx.strokeStyle = 'rgba(232,220,192,0.55)';
    cx.lineWidth = 0.9;
    cx.beginPath();
    cx.moveTo(x, y + 2);
    cx.lineTo(x, y + h - 2);
    cx.stroke();
    // tip drip bead
    cx.fillStyle = CAVE_PAL.calciteLite;
    cx.globalAlpha = 0.8;
    cx.beginPath(); cx.arc(x, y + h + 1, Math.max(1, w * 0.15), 0, Math.PI * 2); cx.fill();
    cx.restore();
}

function drawStalagmite(cx, x, y, h, w) {
    cx.save();
    var g = cx.createLinearGradient(x, y - h, x, y);
    g.addColorStop(0,   CAVE_PAL.calciteLite);
    g.addColorStop(0.6, CAVE_PAL.calciteMid);
    g.addColorStop(1,   CAVE_PAL.calciteDark);
    cx.fillStyle = g;
    cx.beginPath();
    cx.moveTo(x - w * 0.5, y);
    cx.lineTo(x - w * 0.4, y - h * 0.18);
    cx.lineTo(x - w * 0.32, y - h * 0.4);
    cx.lineTo(x - w * 0.22, y - h * 0.62);
    cx.lineTo(x - w * 0.18, y - h * 0.82);
    cx.lineTo(x,             y - h);
    cx.lineTo(x + w * 0.18, y - h * 0.82);
    cx.lineTo(x + w * 0.22, y - h * 0.62);
    cx.lineTo(x + w * 0.32, y - h * 0.4);
    cx.lineTo(x + w * 0.4, y - h * 0.18);
    cx.lineTo(x + w * 0.5, y);
    cx.closePath();
    cx.fill();
    // central highlight rib
    cx.strokeStyle = 'rgba(232,220,192,0.45)';
    cx.lineWidth = 0.8;
    cx.beginPath();
    cx.moveTo(x, y - 2);
    cx.lineTo(x, y - h + 2);
    cx.stroke();
    cx.restore();
}

// ── Seeded deterministic pseudo-random (Task 7-10 structure helpers) ──
function sRand(n) {
    return (Math.abs(Math.sin(n * 127.1 + 311.7) * 43758.5453)) % 1;
}

// ── Environment micro-motion (issue #57) ──────────────────────────
// Shared, deterministic passive sway/surge for flexible environment
// objects (seagrass, soft corals, gorgonians, and later hanging lines
// / nets from #33). One helper so every flexible drawer has identical
// motion character — no per-drawer ad-hoc Math.sin() formulas, no
// per-object timers, no state mutation.
//
// Contract (pure function of its inputs each frame):
//   sampleEnvironmentSway(seed, profile, heightFactor) → {x, y, angle}
//     seed:         stable per-object identity, derived from world-x —
//                   MUST NOT depend on screen-x / camera / draw order.
//     profile:      one of SWAY_PROFILES (flexibility 0..1, amplitudePx).
//                   Drawers must NOT invent their own numbers.
//     heightFactor: 0 at the fixed foot, 1 at the free tip.
//   x, y:  pixel offsets to add to a control point or tip.
//   angle: small local angle (radians), for consumers that want to
//          rotate a rope segment rather than translate its endpoints
//          (reserved for #33's hangingLine / net drawers).
//
// Reads waveTime, current and CURRENT_PARAMS from outer scope. Time
// advances only through waveTime → fast-forward stays smooth, no jumps.

var SWAY_PROFILES = {
    seagrass:    { flexibility: 0.95, amplitudePx: 8 },
    softCoral:   { flexibility: 0.70, amplitudePx: 5 },
    gorgonian:   { flexibility: 0.25, amplitudePx: 2 },
    hangingLine: { flexibility: 0.80, amplitudePx: 6 },
    net:         { flexibility: 0.45, amplitudePx: 3 }
};

// Persistent current lean is capped at a fraction of the free oscillation
// so even a full-strength current bends things visibly without pinning
// them at a hard limit (avoids the whole reef looking clamped).
var ENV_SWAY_CURRENT_BIAS_GAIN = 0.5;
// Normalised sway → radians. Kept small so consumers that map angle to
// a rotation don't get rubbery whole-object spin.
var ENV_SWAY_ANGLE_GAIN = 0.15;
// Base / detail frequency + amplitude coefficients — the issue's model.
var ENV_SWAY_BASE_FREQ    = 0.7;
var ENV_SWAY_BASE_AMP     = 0.6;
var ENV_SWAY_DETAIL_FREQ  = 1.15;
var ENV_SWAY_DETAIL_AMP   = 0.25;
var ENV_SWAY_PHASE_MULT   = 13.37;   // seed → phase multiplier
var ENV_SWAY_DETAIL_PHASE = 1.73;    // detail phase decorrelation

function sampleEnvironmentSway(seed, profile, heightFactor) {
    if (!profile) return { x: 0, y: 0, angle: 0 };
    var flex = profile.flexibility || 0;
    var amp  = profile.amplitudePx || 0;
    // Fixed foot: heightFactor 0 → zero offset regardless of anything else.
    // Rigid object (flex 0) or zero amplitude → zero offset too. Early-out
    // both avoids trig work and guarantees the "foot pixel-fixed" invariant.
    if (flex <= 0 || heightFactor <= 0 || amp <= 0) {
        return { x: 0, y: 0, angle: 0 };
    }
    var phase = sRand(seed * ENV_SWAY_PHASE_MULT) * Math.PI * 2;
    var base   = Math.sin(waveTime * ENV_SWAY_BASE_FREQ   + phase)                          * ENV_SWAY_BASE_AMP;
    var detail = Math.sin(waveTime * ENV_SWAY_DETAIL_FREQ + phase * ENV_SWAY_DETAIL_PHASE)  * ENV_SWAY_DETAIL_AMP;
    var currentBias = 0;
    if (current && current.active && current.level > 0) {
        var maxS = (typeof CURRENT_PARAMS !== 'undefined' && CURRENT_PARAMS.maxStrength) || 1;
        var norm = Math.min(1, current.level / maxS);
        currentBias = current.direction * norm * ENV_SWAY_CURRENT_BIAS_GAIN;
    }
    var swayN = (base + detail + currentBias) * flex * heightFactor;
    return {
        x: swayN * amp,
        y: 0,
        angle: swayN * ENV_SWAY_ANGLE_GAIN
    };
}

// ── Visual Surface Layer (issue #52) ─────────────────────────────
// Deterministic, world-anchored contour noise added ON TOP OF the
// unchanged collision profile (floorAt / ceilingAt). The safety
// clamp in visualProfileDepth() guarantees the visual surface never
// recedes into the solid — it may only wobble into the passable
// water column. Amplitudes are intentionally small (tens of cm).
//
// Contract:
//   visualSurfaceNoise(worldX, seed) → number in ~[-1, 1]
//   visualProfileDepth(siteId, kind, worldX, collisionDepth)
//     kind = 'floor'  → returned depth ≤ collisionDepth
//     kind = 'ceiling' → returned depth ≥ collisionDepth
// Pure functions of their inputs — no state, no time, no Math.random().

var VISUAL_SURFACE_CONFIG = {
    shore: { floorAmp: 0.15, floorSeed: 11.31 },
    reef:  { floorAmp: 0.28, floorSeed: 27.17 },
    cave:  { floorAmp: 0.22, floorSeed: 42.71,
             ceilAmp:  0.20, ceilSeed:  63.83 }
};

// low-frequency base shape + two smaller high-frequency components
function visualSurfaceNoise(worldX, seed) {
    return Math.sin(worldX * 0.55 + seed) * 0.55
         + Math.sin(worldX * 1.70 + seed * 1.7) * 0.30
         + Math.sin(worldX * 4.10 + seed * 2.3) * 0.15;
}

function visualProfileDepth(siteId, surfaceKind, worldX, collisionDepth) {
    var cfg = VISUAL_SURFACE_CONFIG[siteId];
    if (!cfg) return collisionDepth;
    var amp, seed;
    if (surfaceKind === 'floor') {
        amp  = cfg.floorAmp;
        seed = cfg.floorSeed;
    } else if (surfaceKind === 'ceiling') {
        amp  = cfg.ceilAmp;
        seed = cfg.ceilSeed;
    }
    if (!amp) return collisionDepth;
    var n = visualSurfaceNoise(worldX, seed);
    // Bias the offset entirely INTO the water column so the contour
    // has continuous smooth wobble (never clipped flat by the safety
    // Math.min/Math.max below). The clamp is still applied as a
    // defensive guard.
    if (surfaceKind === 'floor') {
        // floor: visualD must be ≤ collisionDepth  → offset ∈ [−amp, 0]
        var floorCand = collisionDepth + 0.5 * amp * (n - 1);
        return Math.min(collisionDepth, floorCand);
    }
    // ceiling: visualD must be ≥ collisionDepth  → offset ∈ [0, amp]
    var ceilCand = collisionDepth + 0.5 * amp * (1 - n);
    return Math.max(collisionDepth, ceilCand);
}

// ============================================================
//  ISSUE #55 — DETERMINISTIC SET DRESSING (MICRO-DECORATION)
//
//  Small, deterministic cosmetic filler props (pebbles, shells, rust
//  flakes, calcite chips, …) scattered across each site's visualZones
//  per a declarative `decorationRules` list (see sites.js). Purely
//  render-only: no physics, collision, gas, or wildlife-spawn effect.
//  Every prop's position/kind/scale/orientation is a pure function of
//  (rule, cell) via sRand() — no Math.random(), no per-frame state
//  beyond a draw-count counter kept for perf inspection/tests.
//
//  Anchoring reuses the issue #52 visual-surface helper directly
//  (visualProfileDepth) — there is NO fallback path to plain
//  floorAt()/ceilingAt() for the final prop depth. floorAt/ceilingAt
//  are only called to (a) get the raw collision depth fed into
//  visualProfileDepth, and (b) act as the zone-probe depth used to
//  test which visualZone a candidate cell actually belongs to (so a
//  rule targeting an interior deck doesn't spawn a floor prop floating
//  where the real substrate is actually far below/above).
// ============================================================

var SET_DRESSING_MAX_MARGIN_CELLS      = 1;
var SET_DRESSING_MIN_SCREEN_PX         = 1.0;
var SET_DRESSING_JITTER_FRACTION       = 0.7;
var SET_DRESSING_CELL_SEED_MULT        = 1009;
var SET_DRESSING_JITTER_SEED_MULT      = 9176;
var SET_DRESSING_PROP_SEED_MULT        = 5273;
var SET_DRESSING_SCALE_SEED_MULT       = 3391;
var SET_DRESSING_ROT_SEED_MULT         = 7717;
var SET_DRESSING_DEFAULT_MIN_SCALE     = 0.8;
var SET_DRESSING_DEFAULT_MAX_SCALE     = 1.15;
var SET_DRESSING_UNKNOWN_KIND_WARN_CAP = 4;
// Vertical offset (world metres) above a deck structure's dTop used to
// anchor 'floor' props resting on it -- solidAt() is inclusive at dTop,
// so anchoring exactly on the surface would get the candidate rejected
// by its own solid check.
var SET_DRESSING_DECK_SURFACE_OFFSET   = 0.05;

// Rate-limits the "unknown prop kind" console.warn per kind, and surfaces
// the last frame's accepted-candidate count for perf inspection/tests.
var _setDressingUnknownWarned = Object.create(null);
var _setDressingLastFrameCount = 0;

// Small palette dedicated to micro set-dressing props. Deliberately muted /
// desaturated relative to the hand-placed feature drawers (REEF_PAL,
// CAVE_PAL) so filler never competes with landmark features for attention.
var SET_DRESSING_PAL = {
    pebble1: '#9c9284', pebble2: '#7d7466',
    rockGrey1: '#6a6258',
    debris: '#5a5248',
    shell: '#e8dcc4', shellShade: '#c8b896',
    grass: '#3a6a3a',
    sandRipple: 'rgba(90,74,46,0.35)',
    crust: '#c9895a', crustLite: '#e0a878',
    sponge: '#9c5a3a', spongeLite: '#c07850',
    coralBranch: '#c8839a',
    rust1: '#b5501f', rust2: '#8a3814',
    cable: '#2a2a28',
    metal: '#5a6068', metalHi: '#8a929a',
    sediment: '#6a5a48',
    calcite: '#e8dcc0', calciteShade: '#b89a72',
    rockCave: '#6b5a40'
};

// Weighted prop-kind selection over rule.props ([{kind,weight}]).
// Deterministic in r (r ∈ [0,1)) — same r always yields the same kind.
function pickProp(rule, r) {
    var props = rule.props;
    var total = 0;
    for (var i = 0; i < props.length; i++) {
        total += (props[i].weight > 0 ? props[i].weight : 0);
    }
    if (total <= 0) return props[0].kind;
    var target = r * total;
    var acc = 0;
    for (var j = 0; j < props.length; j++) {
        acc += (props[j].weight > 0 ? props[j].weight : 0);
        if (target < acc) return props[j].kind;
    }
    return props[props.length - 1].kind;
}

// Some sites (currently: Wreck) define their walkable interior floors as
// thin 'deck' AABB structures rather than as part of the site-wide
// floor/ceiling profile -- the wreck's `floor` array is just the flat
// outer seabed line at d=66. Without this, every 'floor' decoration rule
// probes at the seabed depth regardless of which deck it's meant to
// target, so interior-deck rules would silently produce zero candidates.
// Returns the containing deck's dTop, or null if wx isn't over a deck.
// Generic by design (checks structure kind, not site id) so it applies to
// any future site with the same floor/deck split, not just Wreck.
//
// Ships stack multiple decks at very similar x-ranges but different
// depths (e.g. bridge roof, accommodation, vehicle deck, crew deck all
// overlap in x). A plain "first deck containing wx" scan picks whichever
// deck happens to be earliest in the array, which is very often the
// WRONG deck for the zone a given rule targets. Constraining the match
// to a [zoneD1, zoneD2] depth band (the target zone's own bounds) ties
// deck selection to "the deck that IS this named zone", removing the
// ambiguity.
function _deckSurfaceAt(site, wx, zoneD1, zoneD2) {
    if (!site.structures) return null;
    for (var i = 0; i < site.structures.length; i++) {
        var st = site.structures[i];
        if (st.kind === 'deck' && wx >= st.x1 && wx <= st.x2
            && st.dTop >= zoneD1 && st.dTop <= zoneD2) return st.dTop;
    }
    return null;
}

// Shared iteration core used by both drawSetDressing() (real canvas draw)
// and sampleSetDressingCandidates() (pure, test-friendly candidate list).
// Keeps the density/zone/depth/solid filter logic in exactly one place so
// tests and rendering can never drift apart. `cb` is called once per
// accepted candidate with {ruleId, rule, cell, wx, depth, kind, scale,
// orientation}. No canvas / screen-space work happens here.
function _forEachDecorationCandidate(site, visibleWorldLeft, visibleWorldRight, cb) {
    if (!site || !site.decorationRules) return;
    var rules = site.decorationRules;
    for (var ri = 0; ri < rules.length; ri++) {
        var rule = rules[ri];
        // Resolve the rule's target zone definition once per rule (not per
        // cell) so _deckSurfaceAt can constrain deck selection to this
        // zone's own depth band. See _deckSurfaceAt for why this matters.
        var targetZoneDef = null;
        if (site.visualZones) {
            for (var zi = 0; zi < site.visualZones.length; zi++) {
                if (site.visualZones[zi].id === rule.zone) { targetZoneDef = site.visualZones[zi]; break; }
            }
        }
        var startCell = Math.floor(visibleWorldLeft / rule.spacing) - SET_DRESSING_MAX_MARGIN_CELLS;
        var endCell = Math.ceil(visibleWorldRight / rule.spacing) + SET_DRESSING_MAX_MARGIN_CELLS;
        var maxPerScreen = (rule.maxPerScreen != null) ? rule.maxPerScreen : Infinity;
        var acceptedCount = 0;
        for (var cell = startCell; cell <= endCell; cell++) {
            if (acceptedCount >= maxPerScreen) break;

            var r0 = sRand(cell * SET_DRESSING_CELL_SEED_MULT + rule.seed);
            if (r0 > rule.density) continue; // density gate

            var jitter = (sRand(cell * SET_DRESSING_JITTER_SEED_MULT + rule.seed) - 0.5)
                       * rule.spacing * SET_DRESSING_JITTER_FRACTION;
            var wx = cell * rule.spacing + jitter;

            // Zone-probe: sample the zone AT the real collision surface the
            // prop would sit on, so a rule targeting a specific deck/zone
            // doesn't fire where that surface isn't actually present. For
            // 'floor' rules, prefer a containing deck structure's top face
            // over the raw seabed profile (see _deckSurfaceAt) — otherwise
            // every wreck interior-deck rule would probe at the seabed and
            // never match its own zone.
            var deckD = (rule.surface === 'floor' && targetZoneDef)
                ? _deckSurfaceAt(site, wx, targetZoneDef.d1, targetZoneDef.d2) : null;
            var probeD = (rule.surface === 'ceiling') ? ceilingAt(wx) : (deckD != null ? deckD : floorAt(wx));
            var zone = visualZoneAt(wx, probeD, site);
            if (!zone || zone.id !== rule.zone) continue;

            // Anchor: deck surfaces are flat structural AABBs, not part of
            // the #52 organic terrain contour, so anchor a hair above the
            // deck's dTop (solidAt() is inclusive there) instead of routing
            // through visualProfileDepth. Otherwise, anchor to the issue #52
            // VISUAL surface — no fallback to the raw collision depth.
            var visualD = (deckD != null)
                ? deckD - SET_DRESSING_DECK_SURFACE_OFFSET
                : visualProfileDepth(site.id, rule.surface === 'ceiling' ? 'ceiling' : 'floor', wx, probeD);

            if (rule.minDepth != null && visualD < rule.minDepth) continue;
            if (rule.maxDepth != null && visualD > rule.maxDepth) continue;

            // Safety net for wreck/cave interiors: never place a prop inside solid rock/hull.
            if (solidAt(wx, visualD)) continue;

            var minScale = (rule.minScale != null) ? rule.minScale : SET_DRESSING_DEFAULT_MIN_SCALE;
            var maxScale = (rule.maxScale != null) ? rule.maxScale : SET_DRESSING_DEFAULT_MAX_SCALE;
            var scale = minScale + sRand(cell * SET_DRESSING_SCALE_SEED_MULT + rule.seed) * (maxScale - minScale);

            var rotJitter = (rule.rotationJitter != null) ? rule.rotationJitter : 1;
            var orientation = sRand(cell * SET_DRESSING_ROT_SEED_MULT + rule.seed) * Math.PI * 2 * rotJitter;

            var kind = pickProp(rule, sRand(cell * SET_DRESSING_PROP_SEED_MULT + rule.seed));

            acceptedCount++;
            cb({
                ruleId: rule.id,
                rule: rule,
                cell: cell,
                wx: wx,
                depth: visualD,
                kind: kind,
                scale: scale,
                orientation: orientation
            });
        }
    }
}

// Pure, canvas-free candidate list — same deterministic filter/anchoring
// logic as drawSetDressing(), used by tests to assert determinism without
// touching a canvas context.
function sampleSetDressingCandidates(site, visibleWorldLeft, visibleWorldRight) {
    var out = [];
    _forEachDecorationCandidate(site, visibleWorldLeft, visibleWorldRight, function(cand) {
        out.push({
            ruleId: cand.ruleId,
            cell: cand.cell,
            wx: cand.wx,
            depth: cand.depth,
            kind: cand.kind,
            scale: cand.scale,
            orientation: cand.orientation
        });
    });
    return out;
}

// Dispatcher: draws one small decoration prop at screen (sx, sy). All
// shapes are small (max ~6 screen px at scale 1) and cheap (no canvas
// creation, no gradients beyond a couple of fills/strokes). `seed` drives
// any internal per-prop variation via sRand(); `orientation` is a scalar
// in [0, 2π) used for rotation where it reads naturally (grass, coral
// branches, stalagmites, cable scraps, angular rock/debris chips).
function drawDecorationProp(cx, kind, sx, sy, seed, scale, orientation) {
    switch (kind) {
        // ---- Shared -------------------------------------------------
        case 'pebble': {
            cx.save();
            var pebN = 1 + Math.floor(sRand(seed) * 3); // 1-3
            for (var pi = 0; pi < pebN; pi++) {
                var pr = (0.5 + sRand(seed + pi * 1.7) * 0.7) * scale;
                var pox = (sRand(seed + pi * 2.3) - 0.5) * 4 * scale;
                var poy = (sRand(seed + pi * 3.1) - 0.5) * 1.5 * scale;
                cx.fillStyle = sRand(seed + pi * 4.1) > 0.5 ? SET_DRESSING_PAL.pebble1 : SET_DRESSING_PAL.pebble2;
                cx.beginPath();
                cx.ellipse(sx + pox, sy + poy, pr, pr * 0.6, 0, 0, Math.PI * 2);
                cx.fill();
            }
            cx.restore();
            break;
        }
        case 'smallRock': {
            cx.save();
            cx.translate(sx, sy);
            cx.rotate(orientation);
            var rkBase = 2.2 * scale;
            cx.fillStyle = SET_DRESSING_PAL.rockGrey1;
            cx.beginPath();
            for (var vi = 0; vi < 5; vi++) {
                var vAng = (vi / 5) * Math.PI * 2;
                var vr = rkBase * (0.7 + sRand(seed + vi) * 0.5);
                var vx = Math.cos(vAng) * vr, vy = Math.sin(vAng) * vr * 0.6;
                if (vi === 0) cx.moveTo(vx, vy); else cx.lineTo(vx, vy);
            }
            cx.closePath();
            cx.fill();
            cx.strokeStyle = 'rgba(0,0,0,0.25)';
            cx.lineWidth = 0.4;
            cx.stroke();
            cx.restore();
            break;
        }
        case 'debrisSpeck': {
            cx.save();
            cx.fillStyle = SET_DRESSING_PAL.debris;
            var dsR = (0.4 + sRand(seed) * 0.6) * scale;
            cx.beginPath();
            cx.ellipse(sx, sy, dsR, dsR * 0.7, 0, 0, Math.PI * 2);
            cx.fill();
            cx.restore();
            break;
        }

        // ---- Shore ----------------------------------------------------
        case 'shell': {
            cx.save();
            cx.translate(sx, sy);
            cx.rotate(orientation * 0.3);
            var shR = 2 * scale;
            cx.fillStyle = SET_DRESSING_PAL.shell;
            cx.beginPath();
            cx.arc(0, shR * 0.2, shR, Math.PI, 0, false);
            cx.closePath();
            cx.fill();
            cx.strokeStyle = SET_DRESSING_PAL.shellShade;
            cx.lineWidth = 0.35;
            for (var ribI = -2; ribI <= 2; ribI++) {
                cx.beginPath();
                cx.moveTo(0, shR * 0.2);
                cx.lineTo(ribI * shR * 0.35, shR * 0.2 - shR * 0.85);
                cx.stroke();
            }
            cx.restore();
            break;
        }
        case 'grassTuft': {
            cx.save();
            cx.translate(sx, sy);
            var bladeN = 2 + Math.floor(sRand(seed) * 2); // 2-3
            var bladeH = 3.5 * scale;
            cx.strokeStyle = SET_DRESSING_PAL.grass;
            cx.lineWidth = 0.5;
            cx.lineCap = 'round';
            for (var bi = 0; bi < bladeN; bi++) {
                var lean = (sRand(seed + bi * 1.3) - 0.5) * 0.9 + Math.sin(orientation) * 0.3;
                var baseX = (bi - bladeN / 2) * 0.8 * scale;
                cx.beginPath();
                cx.moveTo(baseX, 0);
                cx.quadraticCurveTo(baseX + lean * bladeH * 0.5, -bladeH * 0.6,
                                     baseX + lean * bladeH, -bladeH);
                cx.stroke();
            }
            cx.restore();
            break;
        }
        case 'sandRippleAccent': {
            cx.save();
            cx.strokeStyle = SET_DRESSING_PAL.sandRipple;
            cx.lineWidth = 0.6 * scale;
            var rippleW = 4 * scale;
            cx.beginPath();
            cx.moveTo(sx - rippleW / 2, sy);
            cx.lineTo(sx + rippleW / 2, sy);
            cx.stroke();
            cx.restore();
            break;
        }

        // ---- Reef -------------------------------------------------
        case 'reefCrustBlob': {
            cx.save();
            cx.translate(sx, sy);
            var crBase = 2 * scale;
            cx.fillStyle = SET_DRESSING_PAL.crust;
            cx.beginPath();
            for (var ci = 0; ci < 6; ci++) {
                var cAng = (ci / 6) * Math.PI * 2;
                var cr = crBase * (0.7 + sRand(seed + ci) * 0.5);
                var cvx = Math.cos(cAng) * cr, cvy = Math.sin(cAng) * cr * 0.55;
                if (ci === 0) cx.moveTo(cvx, cvy); else cx.lineTo(cvx, cvy);
            }
            cx.closePath();
            cx.fill();
            cx.fillStyle = SET_DRESSING_PAL.crustLite;
            cx.globalAlpha = 0.4;
            cx.beginPath();
            cx.ellipse(-crBase * 0.2, -crBase * 0.15, crBase * 0.35, crBase * 0.2, 0, 0, Math.PI * 2);
            cx.fill();
            cx.restore();
            break;
        }
        case 'tinySponge': {
            cx.save();
            var spW = 1.4 * scale, spH = 2.6 * scale;
            cx.fillStyle = SET_DRESSING_PAL.sponge;
            cx.beginPath();
            cx.ellipse(sx, sy - spH * 0.5, spW * 0.5, spH * 0.5, 0, 0, Math.PI * 2);
            cx.fill();
            cx.fillStyle = SET_DRESSING_PAL.spongeLite;
            cx.globalAlpha = 0.5;
            cx.beginPath();
            cx.ellipse(sx, sy - spH * 0.75, spW * 0.3, spH * 0.25, 0, 0, Math.PI * 2);
            cx.fill();
            cx.restore();
            break;
        }
        case 'smallCoralBranch': {
            cx.save();
            cx.translate(sx, sy);
            cx.rotate(orientation * 0.4);
            var brH = 3 * scale;
            cx.strokeStyle = SET_DRESSING_PAL.coralBranch;
            cx.lineWidth = 0.5 * scale;
            cx.lineCap = 'round';
            cx.beginPath();
            cx.moveTo(0, 0);
            cx.lineTo(0, -brH * 0.55);
            cx.moveTo(0, -brH * 0.55);
            cx.lineTo(-brH * 0.35, -brH);
            cx.moveTo(0, -brH * 0.55);
            cx.lineTo(brH * 0.35, -brH);
            cx.stroke();
            cx.restore();
            break;
        }

        // ---- Wreck ------------------------------------------------
        case 'rustFlake': {
            cx.save();
            cx.translate(sx, sy);
            cx.rotate(orientation);
            var rfBase = 1.8 * scale;
            cx.fillStyle = sRand(seed) > 0.5 ? SET_DRESSING_PAL.rust1 : SET_DRESSING_PAL.rust2;
            cx.beginPath();
            for (var fi = 0; fi < 5; fi++) {
                var fAng = (fi / 5) * Math.PI * 2;
                var fr = rfBase * (0.6 + sRand(seed + fi) * 0.6);
                var fx = Math.cos(fAng) * fr, fy = Math.sin(fAng) * fr * 0.6;
                if (fi === 0) cx.moveTo(fx, fy); else cx.lineTo(fx, fy);
            }
            cx.closePath();
            cx.fill();
            cx.restore();
            break;
        }
        case 'cableScrap': {
            cx.save();
            cx.translate(sx, sy);
            cx.rotate(orientation);
            var cabL = 4 * scale;
            cx.strokeStyle = SET_DRESSING_PAL.cable;
            cx.lineWidth = 0.5 * scale;
            cx.lineCap = 'round';
            cx.beginPath();
            cx.moveTo(-cabL * 0.5, 0);
            cx.quadraticCurveTo(0, cabL * 0.4, cabL * 0.5, -0.2 * cabL);
            cx.stroke();
            cx.restore();
            break;
        }
        case 'smallMetalDebris': {
            cx.save();
            cx.translate(sx, sy);
            cx.rotate(orientation);
            var mdW = 3 * scale, mdH = 1.4 * scale;
            cx.fillStyle = SET_DRESSING_PAL.metal;
            cx.fillRect(-mdW / 2, -mdH / 2, mdW, mdH);
            cx.strokeStyle = SET_DRESSING_PAL.metalHi;
            cx.globalAlpha = 0.5;
            cx.lineWidth = 0.3;
            cx.strokeRect(-mdW / 2, -mdH / 2, mdW, mdH);
            cx.restore();
            break;
        }
        case 'sedimentClump': {
            cx.save();
            var sedN = 2 + Math.floor(sRand(seed) * 2);
            cx.fillStyle = SET_DRESSING_PAL.sediment;
            cx.globalAlpha = 0.7;
            for (var si = 0; si < sedN; si++) {
                var sedR = (0.8 + sRand(seed + si * 1.9) * 0.8) * scale;
                var sedX = sx + (sRand(seed + si * 2.7) - 0.5) * 3 * scale;
                var sedY = sy + (sRand(seed + si * 3.3) - 0.5) * scale;
                cx.beginPath();
                cx.ellipse(sedX, sedY, sedR, sedR * 0.55, 0, 0, Math.PI * 2);
                cx.fill();
            }
            cx.restore();
            break;
        }

        // ---- Cave ---------------------------------------------------
        case 'calciteChip': {
            cx.save();
            cx.translate(sx, sy);
            cx.rotate(orientation);
            var ccBase = 1.6 * scale;
            cx.fillStyle = SET_DRESSING_PAL.calcite;
            cx.beginPath();
            for (var chi = 0; chi < 5; chi++) {
                var chAng = (chi / 5) * Math.PI * 2;
                var chr = ccBase * (0.6 + sRand(seed + chi) * 0.6);
                var chx = Math.cos(chAng) * chr, chy = Math.sin(chAng) * chr * 0.65;
                if (chi === 0) cx.moveTo(chx, chy); else cx.lineTo(chx, chy);
            }
            cx.closePath();
            cx.fill();
            cx.restore();
            break;
        }
        case 'smallStalagmite': {
            cx.save();
            var stgW = 1.6 * scale, stgH = 4 * scale;
            cx.fillStyle = SET_DRESSING_PAL.calciteShade;
            cx.beginPath();
            cx.moveTo(sx - stgW / 2, sy);
            cx.lineTo(sx + stgW / 2, sy);
            cx.lineTo(sx, sy - stgH);
            cx.closePath();
            cx.fill();
            cx.restore();
            break;
        }
        case 'smallStalactite': {
            cx.save();
            var sttW = 1.4 * scale, sttH = 3.4 * scale;
            cx.fillStyle = SET_DRESSING_PAL.calcite;
            cx.beginPath();
            cx.moveTo(sx - sttW / 2, sy);
            cx.lineTo(sx + sttW / 2, sy);
            cx.lineTo(sx, sy + sttH);
            cx.closePath();
            cx.fill();
            cx.restore();
            break;
        }
        case 'rockFragment': {
            cx.save();
            cx.translate(sx, sy);
            cx.rotate(orientation);
            var rgBase = 2 * scale;
            cx.fillStyle = SET_DRESSING_PAL.rockCave;
            cx.beginPath();
            for (var rgi = 0; rgi < 5; rgi++) {
                var rgAng = (rgi / 5) * Math.PI * 2;
                var rgr = rgBase * (0.65 + sRand(seed + rgi) * 0.55);
                var rgx = Math.cos(rgAng) * rgr, rgy = Math.sin(rgAng) * rgr * 0.6;
                if (rgi === 0) cx.moveTo(rgx, rgy); else cx.lineTo(rgx, rgy);
            }
            cx.closePath();
            cx.fill();
            cx.restore();
            break;
        }

        default: {
            var warnCount = _setDressingUnknownWarned[kind] || 0;
            if (warnCount < SET_DRESSING_UNKNOWN_KIND_WARN_CAP) {
                console.warn('drawDecorationProp: unknown prop kind "' + kind + '"');
                _setDressingUnknownWarned[kind] = warnCount + 1;
            }
            return;
        }
    }
}

// Central entry point, called once per frame from drawScene(). Iterates
// every rule's visible cells via the shared candidate helper, culls to the
// screen, applies a minimum-drawn-size cutoff, and dispatches each accepted
// prop to drawDecorationProp(). `site`/`visibleWorldLeft`/`visibleWorldRight`
// /`mpp` are the only inputs — diver position, canvas size and context are
// read from outer-scope module state (same convention as drawStructures()/
// drawFeatures()) rather than threaded through the signature.
function drawSetDressing(site, visibleWorldLeft, visibleWorldRight, mpp) {
    if (!site || !site.decorationRules) return;
    _setDressingLastFrameCount = 0;

    var W = cssWidth, H = cssHeight;
    var diverScreenX = W * DIVER_SCREEN_X_FRACTION, diverScreenY = H * 0.45;
    var cx = ctx;

    _forEachDecorationCandidate(site, visibleWorldLeft, visibleWorldRight, function(cand) {
        var sx = diverScreenX + (cand.wx - diverX) / mpp;
        var sy = diverScreenY + (cand.depth - depth) / mpp;
        if (sx < -8 || sx > W + 8 || sy < -8 || sy > H + 8) return;

        // Minimum drawn-size cutoff: a ~1 m baseline prop scaled by `scale`
        // and projected through mpp must exceed SET_DRESSING_MIN_SCREEN_PX
        // on screen, otherwise it's not worth a draw call.
        if (cand.scale * (1 / mpp) * 0.05 < SET_DRESSING_MIN_SCREEN_PX / 20) return;

        var rule = cand.rule;
        var wrapAlpha = rule.alpha != null;
        if (wrapAlpha) {
            cx.save();
            cx.globalAlpha *= rule.alpha;
        }
        drawDecorationProp(cx, cand.kind, sx, sy, cand.cell + rule.seed, cand.scale, cand.orientation);
        if (wrapAlpha) cx.restore();

        _setDressingLastFrameCount++;
    });
}

// ── Near-surface optics (issue #58) ────────────────────────────────
// Shared, stylised 2D pass covering the light effects that live in the
// upper ~20 m of the water column: moving caustics on shallow floor, a
// slightly richer water underside, and a soft boat shadow. Consolidates
// code that used to live in per-site branches and gives future sites
// (issue #35 reef polish, #43 shore) a single call site instead of a
// fresh copy each time.
//
// Not physically accurate — no refraction, no Snell's window, no
// depth colour absorption (that's issue #36). Depth colour, water-
// volume fog and torch cones are still owned by their own passes.

// Depth curve. 1 near the surface, 0 by ~20 m. Composed of two
// non-decreasing smoothsteps so the character matches the design brief:
//   0–5 m:   strong (~1)
//   5–12 m:  drops markedly
//   12–20 m: only a very subtle tail
//   >20 m:   0
// Also 0 when the surface is not visible (deep overhead, etc.).
function nearSurfaceLightFactor(depth, surfaceVisible) {
    if (surfaceVisible === false) return 0;
    if (!(depth > 0)) return 1;         // NaN / negative / at-surface → full
    if (depth >= 20) return 0;
    // 85% weight on the 5→12 m knee, 15% on the 12→20 m tail.
    var t1 = 1 - smoothstep(5,  12, depth);
    var t2 = 1 - smoothstep(12, 20, depth);
    var v = t1 * 0.85 + t2 * 0.15;
    if (v < 0) v = 0;
    if (v > 1) v = 1;
    return v;
}

// Per-site multiplier on top of the base depth factor. Shore is the
// baseline (sunlit sand). Reef is a hair more (bright plateau water).
// Cave Entry is conservative (open water only visible through pond
// shafts). Wreck exterior is very subtle (murky, north-Atlantic feel).
function _nearSurfaceSiteMultiplier(siteId) {
    if (siteId === 'shore') return 1.0;
    if (siteId === 'reef')  return 1.1;
    if (siteId === 'cave')  return 0.6;
    if (siteId === 'wreck') return 0.4;
    return 1.0;
}

// Shared caustic renderer. Draws slow horizontal sine-wavy stroke
// bands over the visible floor area, phase-locked to WORLD coordinates
// so the pattern does not swim with the camera when the diver moves
// horizontally. Extracted from the pre-#58 Shore atmosphere branch —
// visuals are near-unchanged for Shore, and Reef now shares the exact
// same helper (previously had no caustics at all).
// Issue #58 (review follow-up): reused across drawCausticsOnVisibleFloor()
// calls instead of allocating a fresh array/objects every frame — plain
// parallel arrays (not an array of {sx,worldX,...} objects), truncated with
// .length=0 and refilled by index each call rather than reallocated.
var _causticsColSx = [];
var _causticsColWorldX = [];
var _causticsColFloorScreenY = [];
var _causticsColOk = [];

function drawCausticsOnVisibleFloor(site, lightFactor) {
    if (lightFactor <= 0.01) return;
    var W = cssWidth, H = cssHeight;
    var dsx = W * DIVER_SCREEN_X_FRACTION, dsy = H * 0.45, mpp = 0.05;
    var cx = ctx;
    cx.save();
    var alpha = (0.16 * lightFactor).toFixed(3);
    cx.strokeStyle = 'rgba(245,238,188,' + alpha + ')';
    cx.lineWidth = 1.2;
    // World-anchored horizontal wavelength ≈ 2π/0.6 ≈ 10.5 m (matches
    // the original 0.03/pixel * 0.05 mpp period, just in world units).
    var kx = 0.6;
    // Issue #58 (review follow-up, round 2): two bugs in the previous
    // per-column rewrite. (1) Sign was backwards — `floorScreenY - offset`
    // moves UP the screen (smaller y = shallower = further INTO the water
    // column), the opposite of onto the terrain; drawTerrain()'s own floor
    // polygon is filled at y >= its floor line (larger y = deeper/into the
    // terrain), so the offset must be ADDED. (2) floorScreenY was derived
    // from floorAt() (the collision floor), but drawTerrain() renders
    // visualProfileDepth(site.id,'floor',worldX,floorAt(worldX)) — the
    // organic visual contour, which is always at or shallower than the
    // collision floor (issue #52) — so anchoring to the collision floor
    // could still land caustics either in the water or underground
    // relative to what's actually drawn. Both fixed: anchor to the same
    // visualProfileDepth() drawTerrain() itself uses, offset added so
    // every point lands on/into the rendered terrain side of that line.
    // Minimum offset must exceed the sine wobble's amplitude (5px) below —
    // otherwise a point with the smallest offset and a fully-negative
    // wobble sample nets to less than 0 and lands back on the water side.
    var OFFSETS_PX = [6, 12, 18, 24];
    var REEF_MAX_SLOPE = 1.5;    // metres of depth change per metre — above this, treat as a wall
    // Precompute per-column floor data once, reused across every offset band.
    _causticsColSx.length = 0;
    _causticsColWorldX.length = 0;
    _causticsColFloorScreenY.length = 0;
    _causticsColOk.length = 0;
    var n = 0;
    for (var sx = -20; sx <= W + 20; sx += 18) {
        var worldX = diverX + (sx - dsx) * mpp;
        var floorDCol = floorAt(worldX);
        var floorDVis = visualProfileDepth(site.id, 'floor', worldX, floorDCol);
        var floorScreenY = dsy + (floorDVis - depth) / mpp;
        var ok = true;
        if (site.id === 'reef') {
            var slope = Math.abs(floorAt(worldX + 1) - floorAt(worldX - 1)) / 2;
            ok = slope < REEF_MAX_SLOPE;
        }
        _causticsColSx[n] = sx;
        _causticsColWorldX[n] = worldX;
        _causticsColFloorScreenY[n] = floorScreenY;
        _causticsColOk[n] = ok;
        n++;
    }
    for (var oi = 0; oi < OFFSETS_PX.length; oi++) {
        var offset = OFFSETS_PX[oi];
        cx.beginPath();
        var pathOpen = false;
        for (var ci = 0; ci < n; ci++) {
            if (!_causticsColOk[ci]) { pathOpen = false; continue; }
            var cy = _causticsColFloorScreenY[ci] + offset;
            var y = cy + Math.sin(_causticsColWorldX[ci] * kx + waveTime * 1.7 + cy * 0.02) * 5;
            if (!pathOpen) { cx.moveTo(_causticsColSx[ci], y); pathOpen = true; } else { cx.lineTo(_causticsColSx[ci], y); }
        }
        cx.stroke();
    }
    cx.restore();
}

// Water underside: a bright moving highlight just below the surface
// line plus a couple of faint offset wave bands so the surface line
// isn't a single flat stroke when viewed from below.
function _drawSurfaceUnderside(surfaceY, W, H, lightFactor) {
    if (lightFactor <= 0.01) return;
    if (surfaceY <= -50 || surfaceY >= H + 50) return;
    var cx = ctx;
    cx.save();
    // Thin bright moving highlight line just under the surface.
    var hiAlpha = (0.35 * lightFactor).toFixed(3);
    cx.strokeStyle = 'rgba(230,248,255,' + hiAlpha + ')';
    cx.lineWidth = 1;
    cx.beginPath();
    for (var x = 0; x <= W; x += 6) {
        var worldX = diverX + (x - W * DIVER_SCREEN_X_FRACTION) * 0.05;
        var y = surfaceY + 2 + Math.sin(worldX * 0.45 + waveTime * 2.2) * 1.4 +
                Math.sin(worldX * 0.9 + waveTime * 1.4) * 0.6;
        if (x === 0) cx.moveTo(x, y); else cx.lineTo(x, y);
    }
    cx.stroke();
    // 1-2 wider offset wave bands, low alpha.
    var bands = [
        { off: 6,  a: 0.10, kx: 0.35, w: 3, spd: 1.6 },
        { off: 14, a: 0.06, kx: 0.28, w: 4, spd: 1.1 }
    ];
    for (var bi = 0; bi < bands.length; bi++) {
        var b = bands[bi];
        cx.fillStyle = 'rgba(180,220,235,' + (b.a * lightFactor).toFixed(3) + ')';
        cx.beginPath();
        for (var bx = 0; bx <= W; bx += 6) {
            var bwx = diverX + (bx - W * DIVER_SCREEN_X_FRACTION) * 0.05;
            var by = surfaceY + b.off + Math.sin(bwx * b.kx + waveTime * b.spd) * 2;
            if (bx === 0) cx.moveTo(bx, by); else cx.lineTo(bx, by);
        }
        for (var bx2 = W; bx2 >= 0; bx2 -= 6) {
            var bwx2 = diverX + (bx2 - W * DIVER_SCREEN_X_FRACTION) * 0.05;
            var by2 = surfaceY + b.off + b.w + Math.sin(bwx2 * b.kx + waveTime * b.spd + 0.9) * 2;
            cx.lineTo(bx2, by2);
        }
        cx.closePath();
        cx.fill();
    }
    cx.restore();
}

// Boat shadow / surface silhouette: a soft dark elongated blob
// hanging under the surface at the boat's screen-x. Uses the SAME
// derivation as the boat sprite (drawScene line ~663) so the shadow
// tracks the boat exactly. No effect if boat is far offscreen.
function _drawBoatShadow(surfaceY, W, H, lightFactor, siteMult) {
    var s = activeSite();
    if (!s || s.boatX == null) return;
    var eff = lightFactor * siteMult;
    if (eff <= 0.02) return;
    if (surfaceY <= -20 || surfaceY >= H + 20) return;
    var mpp = 0.05;
    var boatWorldX = s.boatX;
    var shipX = W * DIVER_SCREEN_X_FRACTION + (boatWorldX - diverX) / mpp;
    // Fallback: skip work for boats far outside the visible world-x range.
    if (shipX < -180 || shipX > W + 180) return;
    var cx = ctx;
    cx.save();
    // Slight lateral sway with waveTime — the boat drifts on wavelets.
    var sway = Math.sin(waveTime * 0.9) * 1.4;
    var cxPos = shipX + sway;
    var cyPos = surfaceY + 6;
    // Two-stop soft radial "shadow" — no hard edges.
    var g = cx.createRadialGradient(cxPos, cyPos, 6, cxPos, cyPos, 90);
    var aCore = 0.22 * eff;
    g.addColorStop(0,   'rgba(4,10,16,' + aCore.toFixed(3) + ')');
    g.addColorStop(0.5, 'rgba(4,10,16,' + (aCore * 0.35).toFixed(3) + ')');
    g.addColorStop(1,   'rgba(4,10,16,0)');
    cx.fillStyle = g;
    // Elliptical footprint (wider than tall) to hint at hull silhouette.
    cx.beginPath();
    cx.ellipse(cxPos, cyPos, 80, 14, 0, 0, Math.PI * 2);
    cx.fill();
    cx.restore();
}

// Public: near-surface atmosphere layer. Runs BEFORE terrain — this
// is the background/water side of the pass (boat shadow, water-
// underside). The caustics on the floor are painted AFTER terrain by
// drawSurfaceCaustics().
// Issue #54 (review follow-up): cachedAtmo lets drawScene() pass through
// the ONE sampleLocalAtmosphere() result it already computed this frame
// (_localAtmo) instead of this function re-sampling the exact same
// site/diverX/depth a second time. Undefined (the standalone/test-call
// path — see TC-54 tests) falls back to sampling fresh, same as before.
function drawNearSurfaceAtmosphere(cachedAtmo) {
    // No-op outside the live dive scene — no work in setup/post-dive/
    // game-over/surface screens.
    if (gameState !== 'diving') return;
    var s = activeSite();
    if (!s) return;
    // No near-surface work if the diver is inside overhead (interior).
    if (inOverhead) return;
    var W = cssWidth, H = cssHeight;
    var mpp = 0.05, dsy = H * 0.45;
    var surfaceY = dsy - depth / mpp;
    var surfaceVisible = (surfaceY > -50 && surfaceY < H + 50);
    var base = nearSurfaceLightFactor(depth, surfaceVisible);
    var siteMult = _nearSurfaceSiteMultiplier(s.id);
    // Optional local-atmosphere modulation — sample once at the diver's
    // position and use visibility to dampen, ambient to nudge brightness.
    // Small effect only; #54 owns the real tint / fog work.
    var atmo = null;
    if (cachedAtmo !== undefined) {
        atmo = cachedAtmo;
    } else {
        try { atmo = sampleLocalAtmosphere(s, diverX, depth); } catch { atmo = null; }
    }
    var atmoK = 1;
    if (atmo) {
        atmoK = (atmo.ambient || 1) * (0.6 + 0.4 * (atmo.visibility || 1));
        if (atmoK < 0.3) atmoK = 0.3;
        if (atmoK > 1.6) atmoK = 1.6;
    }
    var lightFactor = base * atmoK;
    if (lightFactor <= 0.01) return;
    _drawSurfaceUnderside(surfaceY, W, H, lightFactor);
    _drawBoatShadow(surfaceY, W, H, lightFactor, siteMult);
}

// Public: caustics on the visible floor. Runs AFTER terrain +
// site detail pass and BEFORE set-dressing — matches the render-order
// constraint in issue #58. Currently just Shore + Reef; Cave uses its
// own pond sunbeam and Wreck exterior is deep enough that the depth
// curve already zeroes this out.
// Issue #54 (review follow-up): see drawNearSurfaceAtmosphere() above —
// same cachedAtmo pass-through to avoid a third per-frame sample.
function drawSurfaceCaustics(cachedAtmo) {
    if (gameState !== 'diving') return;
    var s = activeSite();
    if (!s) return;
    if (inOverhead) return;                 // no floor caustics inside overhead
    var H = cssHeight;
    var mpp = 0.05, dsy = H * 0.45;
    var surfaceY = dsy - depth / mpp;
    var surfaceVisible = (surfaceY > -50 && surfaceY < H + 50);
    var base = nearSurfaceLightFactor(depth, surfaceVisible);
    var siteMult = _nearSurfaceSiteMultiplier(s.id);
    var atmo = null;
    if (cachedAtmo !== undefined) {
        atmo = cachedAtmo;
    } else {
        try { atmo = sampleLocalAtmosphere(s, diverX, depth); } catch { atmo = null; }
    }
    var atmoK = atmo ? Math.max(0.3, Math.min(1.6,
        (atmo.ambient || 1) * (0.6 + 0.4 * (atmo.visibility || 1))
    )) : 1;
    var lightFactor = base * siteMult * atmoK;
    if (lightFactor <= 0.01) return;
    // Shore + Reef always eligible. Cave gets caustics only in the very
    // shallow entry zone where an open pond surface is visible — the
    // depth curve + 0.6 site multiplier keep that conservative. Wreck
    // exterior is 0.4 site + rapid depth falloff → naturally silent
    // below ~10 m. No new zone-specific branches needed.
    if (s.id === 'shore' || s.id === 'reef' || s.id === 'cave' || s.id === 'wreck') {
        drawCausticsOnVisibleFloor(s, lightFactor);
    }
}

// ────────────────────────────────────────────────────────────────
// Issue #43 — depth staggering / parallax factors.
//
// One entry per named layer per site so all magic-number choices
// live in ONE table (no per-function inline literals). Values MUST
// stay constant per layer — moving them by frame or by camera would
// break the spatial illusion.
//
//   Far background : 0.15 – 0.25
//   Midground      : 0.30 – 0.55
//   Near background: 0.70 – 0.90
//
// Foreground layers (>1) are owned by drawForegroundLayer() and its
// per-site helpers; this table only covers background/midground.
// ────────────────────────────────────────────────────────────────
const PARALLAX_FACTORS = Object.freeze({
    shore: {
        sandRidge:    0.28,   // far background
        seagrassBand: 0.42    // midground
    },
    reef: {
        farRidge:     0.18,   // existing far background (kept as-is)
        midRidge:     0.35    // NEW midground ridge
    },
    wreck: {
        debrisBand:   0.55,   // midground seabed debris silhouettes
        hullMass:     0.85    // near background — distant hull silhouette
    },
    cave: {
        cathedralColumn: 0.50, // midground speleothem/column silhouettes
        passageMouth:    0.40  // midground negative-space cues
    }
});

function drawSiteAtmosphere() {
    // Skip cleanly outside the live dive scene — matches the guard on
    // drawNearSurfaceAtmosphere/drawSurfaceCaustics so this pass emits
    // zero canvas ops in gas-setup / post-dive / game-over / surface.
    if (gameState !== 'diving') return;
    var s = activeSite();
    if (!s) return;
    var W = cssWidth, H = cssHeight;
    var dsx = W * DIVER_SCREEN_X_FRACTION, dsy = H * 0.45, mpp = 0.05;
    var cx = ctx;
    var surfaceY = dsy - depth / mpp;
    cx.save();

    if (s.id === 'shore') {
        // Caustics moved to the shared near-surface-optics pass (issue #58,
        // drawSurfaceCaustics → drawCausticsOnVisibleFloor). Keep the warm
        // surface veil here since it belongs to the site atmosphere, not the
        // near-surface optics layer.
        var shoreGlow = cx.createLinearGradient(0, Math.max(0, surfaceY), 0, H);
        shoreGlow.addColorStop(0, 'rgba(235,218,160,0.08)');
        shoreGlow.addColorStop(1, 'rgba(75,42,16,0)');
        cx.fillStyle = shoreGlow;
        cx.fillRect(0, Math.max(0, surfaceY), W, H);
        // Issue #43: spatial depth behind the diver. Runs INSIDE cx.save
        // so alpha bleed can't leak into later passes.
        drawShoreParallaxLayers(cx, W, H, dsx, dsy, mpp);
    } else if (s.id === 'reef') {
        // Distant reef silhouettes behind the playable wall: a low-cost parallax layer.
        // World-anchored: iterate over fixed integer world-x strides across
        // the visible viewport so a given ridge peak stays pinned to its
        // world position instead of sliding with the sample window.
        cx.globalAlpha = 0.12;
        cx.fillStyle = '#142a32';
        var pFar = PARALLAX_FACTORS.reef.farRidge;
        var baseD = Math.max(18, depth + 8);
        var xLeftFar = diverX + (0 - dsx) * mpp / pFar - 5;
        var xRightFar = diverX + (W - dsx) * mpp / pFar + 5;
        var strideFar = 5;
        cx.beginPath();
        cx.moveTo(0, H);
        for (var kFar = Math.floor(xLeftFar / strideFar); kFar <= Math.ceil(xRightFar / strideFar); kFar++) {
            var wx = kFar * strideFar;
            var sx = dsx + (wx - diverX) / mpp * pFar;
            var ridgeD = baseD + 14 + Math.sin(wx * 0.12) * 7 + Math.sin(wx * 0.29) * 2;
            var sy = dsy + (ridgeD - depth) / mpp;
            cx.lineTo(sx, sy);
        }
        cx.lineTo(W, H);
        cx.closePath();
        cx.fill();
        cx.globalAlpha = 1;
        // Issue #43: second, closer ridge layer at a different parallax rate.
        drawReefParallaxLayers(cx, W, H, dsx, dsy, mpp);
    } else if (s.id === 'wreck') {
        // Slight murk and searchlight falloff around the wreck exterior/interior.
        var murk = cx.createRadialGradient(dsx, dsy, 80, dsx, dsy, Math.max(W, H) * 0.75);
        murk.addColorStop(0, 'rgba(135,185,190,0.03)');
        murk.addColorStop(1, 'rgba(12,22,26,0.18)');
        cx.fillStyle = murk;
        cx.fillRect(0, 0, W, H);
        // Issue #43: distant hull mass + seabed debris band. Both are
        // decorative silhouettes and MUST NOT read as navigable structure.
        drawWreckParallaxLayers(cx, W, H, dsx, dsy, mpp);
    } else if (s.id === 'cave') {
        // Subtle limestone dust in the water before the torch overlay darkens it.
        cx.fillStyle = 'rgba(188,178,148,0.08)';
        for (var i = 0; i < 80; i++) {
            var seed = i * 19.37;
            var px = (sRand(seed) * W + Math.sin(waveTime * 0.08 + i) * 8) % W;
            var py = sRand(seed + 2.1) * H;
            var pr = 0.7 + sRand(seed + 4.2) * 1.8;
            cx.beginPath(); cx.arc(px, py, pr, 0, Math.PI * 2); cx.fill();
        }
        // Issue #43: cathedral speleothem silhouettes + passage-mouth cues.
        // Purely decorative; collision/geometry unaffected.
        drawCaveParallaxLayers(cx, W, H, dsx, dsy, mpp);
    }
    cx.restore();
}

// ────────────────────────────────────────────────────────────────
// Issue #43 — per-site parallax helpers.
//
// Shared rules (see issue for the full contract):
//   • World-anchored — sample by world-x, not screen-x.
//   • Deterministic — sRand only; no Math.random().
//   • Cosmetic-only — never touches floorAt/ceilingAt/collision.
//   • Behind the diver, guideline, features, HUD.
//   • Respect visible-range window (xLeftM/xRightM) so we do not
//     iterate the whole world every frame.
// ────────────────────────────────────────────────────────────────

// Shore: distant sand ridge + simplified seagrass band. Adds spatial
// depth behind the diver where before there was only open water.
function drawShoreParallaxLayers(cx, W, H, dsx, dsy, mpp) {
    cx.save();
    // ── Layer A: far sand ridge silhouette (parallax 0.28). ──
    // Shore's terrain fill is opaque from the local floor curve all the
    // way to the bottom of the canvas (unlike Reef/Wreck/Cave, which have
    // open water beyond/around their structures) — so a "distant ridge"
    // anchored DEEPER than the real local floor is always painted over
    // by drawTerrain() and never actually visible. Anchor it SHALLOWER
    // than the real floor instead (a low crest poking up into the open
    // water above the sand line, like a further headland glimpsed down
    // the coast), guaranteeing it lands in the one region that stays
    // open water: above floorAt(x). Sampled at fixed integer world-x
    // strides (world-anchored) across the visible viewport → shifts
    // under the camera at exactly (Δx / mpp * factor), not screen-locked.
    var pA = PARALLAX_FACTORS.shore.sandRidge;
    var ridgeMargin = 9; // metres shallower than the real local floor
    var xLeftA = diverX + (0 - dsx) * mpp / pA - 4;
    var xRightA = diverX + (W - dsx) * mpp / pA + 4;
    var strideA = 4;
    cx.globalAlpha = 0.14;
    cx.fillStyle = '#3a2c1c';
    cx.beginPath();
    cx.moveTo(0, H);
    for (var kA = Math.floor(xLeftA / strideA); kA <= Math.ceil(xRightA / strideA); kA++) {
        var wxA = kA * strideA;
        var sxA = dsx + (wxA - diverX) / mpp * pA;
        // Wave amplitude tops out around ±9.5; halving it keeps the crest's
        // shallowest excursion (center + 4.75) safely below
        // floorAt(wxA) - ridgeMargin, so it never reaches the real sand line.
        var wave = Math.sin(wxA * 0.08) * 4.5
                 + Math.sin(wxA * 0.21 + 1.7) * 2
                 + Math.sin(wxA * 0.045) * 3;
        var ridgeD = Math.max(1, floorAt(wxA) - ridgeMargin + wave * 0.5);
        var syA = dsy + (ridgeD - depth) / mpp;
        cx.lineTo(sxA, syA);
    }
    cx.lineTo(W, H);
    cx.closePath();
    cx.fill();
    cx.globalAlpha = 1;

    // ── Layer B: distant seagrass band (parallax 0.42). ──
    // Simple tapered strokes — NOT the detailed set-dressing plants
    // from #55. Very low density/alpha so it reads as a distant
    // suggestion, not another prop layer. Same visibility constraint as
    // Layer A: anchor each blade above the REAL local floor at that
    // world-x (not a fixed world-depth), so it always sits in open
    // water instead of being painted over by the opaque sand fill.
    var pB = PARALLAX_FACTORS.shore.seagrassBand;
    var grassMargin = 5; // metres shallower than the real local floor
    var xLeftM = diverX + (0 - dsx) * mpp / pB - 4;
    var xRightM = diverX + (W - dsx) * mpp / pB + 4;
    cx.globalAlpha = 0.18;
    cx.strokeStyle = '#1c3722';
    cx.lineCap = 'round';
    cx.lineWidth = 1.4;
    for (var k = Math.floor(xLeftM / 2.4); k <= Math.ceil(xRightM / 2.4); k++) {
        var wxB = k * 2.4;
        if (sRand(wxB + 43) > 0.45) continue;
        var sxB = dsx + (wxB - diverX) / mpp * pB;
        // Blade height and lean derived deterministically from wxB.
        var bh = 10 + sRand(wxB + 1) * 14;
        var lean = (sRand(wxB + 2) - 0.5) * 6;
        var bandD = Math.max(1, floorAt(wxB) - grassMargin);
        var syBase = dsy + (bandD - depth) / mpp;
        if (sxB < -12 || sxB > W + 12) continue;
        if (syBase < -30 || syBase > H + 30) continue;
        cx.beginPath();
        cx.moveTo(sxB, syBase);
        cx.quadraticCurveTo(sxB + lean * 0.5, syBase - bh * 0.55,
                            sxB + lean, syBase - bh);
        cx.stroke();
    }
    cx.globalAlpha = 1;
    cx.restore();
}

// Reef: second (closer) ridge silhouette. The existing 0.18-parallax
// ridge is untouched above; this layer sits between it and the wall
// so the reef reads as two depth planes instead of one.
function drawReefParallaxLayers(cx, W, H, dsx, dsy, mpp) {
    cx.save();
    var p = PARALLAX_FACTORS.reef.midRidge;
    // Warmer, higher-alpha ridge than the far one, and closer to the
    // diver's depth so it clearly reads as the nearer plane.
    var baseD = Math.max(14, depth + 4);
    var xLeft = diverX + (0 - dsx) * mpp / p - 5;
    var xRight = diverX + (W - dsx) * mpp / p + 5;
    var stride = 5;
    cx.globalAlpha = 0.18;
    cx.fillStyle = '#0f2028';
    cx.beginPath();
    cx.moveTo(0, H);
    for (var k = Math.floor(xLeft / stride); k <= Math.ceil(xRight / stride); k++) {
        var wx = k * stride;
        var sx = dsx + (wx - diverX) / mpp * p;
        // Distinct wave signature from the far ridge so the two layers
        // don't lock-step visually.
        var ridgeD = baseD + 10 + Math.sin(wx * 0.19 + 0.8) * 5
                              + Math.sin(wx * 0.41) * 1.6;
        var sy = dsy + (ridgeD - depth) / mpp;
        cx.lineTo(sx, sy);
    }
    cx.lineTo(W, H);
    cx.closePath();
    cx.fill();
    cx.globalAlpha = 1;
    cx.restore();
}

// Wreck: a near-background dark hull mass silhouette PLUS a distant
// debris field band along the seabed. Both are decorative — the diver
// never collides with them, and the hull mass is drawn very low alpha
// so it never reads as a real navigable ship.
function drawWreckParallaxLayers(cx, W, H, dsx, dsy, mpp) {
    cx.save();

    // ── Layer A: distant hull mass (parallax 0.85). ──
    // A very simple ship-bulk silhouette: a long low trapezoid with
    // a superstructure and a funnel bump. It reuses the recognisable
    // silhouette proportions of the main wreck (long hull, one funnel
    // between bridge and stern) so the ship's bulk stays "somewhere
    // out there" even when the diver is off-axis. Alpha kept very low.
    var pA = PARALLAX_FACTORS.wreck.hullMass;
    // Anchor at ~62 m in world depth so the keel line sits below the
    // diver at typical wreck depths. Kept constant so the silhouette
    // doesn't wander vertically as the diver ascends/descends.
    var keelD = 62;
    var deckD = 30;         // main deck
    var bridgeD = 20;
    var funnelD = 14;
    var hullAnchorD = (keelD + funnelD) / 2; // mid-height reference depth
    // Place the distant hull along the +x direction (offset by 210 m
    // in world space) so it stays behind the playable ship without
    // overlapping it. The ANCHOR point pans at pA's near-background
    // parallax rate (~17 px/world-m) — but the hull is ~190 m long, so
    // drawing its own shape at that same per-metre rate would span
    // several screen widths and never read as a ship, just a soft edge.
    // Decouple shape size from position speed: the anchor still pans at
    // pA, but the silhouette itself is drawn at a small, fixed visual
    // span so the whole ship fits legibly in frame regardless of pA.
    var wx0 = 210;
    var hullLenM = 190;
    var HULL_VISUAL_SPAN_PX = 480; // full hull length on screen, tuned for legibility
    var posScaleX = 1 / mpp * pA;
    var sizeScale = HULL_VISUAL_SPAN_PX / hullLenM; // px per world-metre, shape-only
    var sxStern = dsx + (wx0 - diverX) * posScaleX;
    var sxBow = sxStern + hullLenM * sizeScale;
    // Early-out if the whole silhouette is offscreen (both sides).
    if (sxBow < -40 || sxStern > W + 40) {
        // Try the -x mirror side.
        wx0 = -210 - hullLenM;
        sxStern = dsx + (wx0 - diverX) * posScaleX;
        sxBow = sxStern + hullLenM * sizeScale;
        if (sxBow < -40 || sxStern > W + 40) { cx.restore(); return; }
    }
    var syAnchor = dsy + (hullAnchorD - depth) / mpp;
    var syKeel   = syAnchor + (keelD   - hullAnchorD) * sizeScale;
    var syDeck   = syAnchor + (deckD   - hullAnchorD) * sizeScale;
    var syBridge = syAnchor + (bridgeD - hullAnchorD) * sizeScale;
    var syFunnel = syAnchor + (funnelD - hullAnchorD) * sizeScale;
    cx.globalAlpha = 0.16;
    cx.fillStyle = '#0a1013';
    cx.beginPath();
    // hull trapezoid
    cx.moveTo(sxStern, syKeel);
    cx.lineTo(sxBow, syKeel);
    cx.lineTo(sxBow - 40, syDeck);
    // superstructure block (bridge)
    var sbxL = sxStern + (sxBow - sxStern) * 0.45;
    var sbxR = sxStern + (sxBow - sxStern) * 0.62;
    cx.lineTo(sbxR, syDeck);
    cx.lineTo(sbxR, syBridge);
    cx.lineTo(sbxL, syBridge);
    cx.lineTo(sbxL, syDeck);
    // funnel bump
    var fnxL = sxStern + (sxBow - sxStern) * 0.50;
    var fnxR = sxStern + (sxBow - sxStern) * 0.55;
    cx.lineTo(fnxL, syDeck);
    cx.lineTo(fnxL, syFunnel);
    cx.lineTo(fnxR, syFunnel);
    cx.lineTo(fnxR, syDeck);
    // remaining deck to stern
    cx.lineTo(sxStern + 30, syDeck);
    cx.closePath();
    cx.fill();
    cx.globalAlpha = 1;

    // ── Layer B: distant debris field band (parallax 0.55). ──
    // A handful of low-contrast dark shapes sitting on the seabed
    // depth so a diver at typical wreck depths sees a "junk on the
    // ocean floor" hint receding to either side. Simple ellipses;
    // NOT the detailed set-dressing props from #55.
    var pB = PARALLAX_FACTORS.wreck.debrisBand;
    var xLeftM = diverX + (0 - dsx) * mpp / pB - 6;
    var xRightM = diverX + (W - dsx) * mpp / pB + 6;
    var seabedD = 64;
    var syBed = dsy + (seabedD - depth) / mpp;
    if (syBed > -20 && syBed < H + 60) {
        cx.globalAlpha = 0.16;
        cx.fillStyle = '#0d1418';
        for (var k = Math.floor(xLeftM / 6); k <= Math.ceil(xRightM / 6); k++) {
            var wxB = k * 6;
            if (sRand(wxB + 71) > 0.55) continue;
            var sxB = dsx + (wxB - diverX) / mpp * pB;
            var wid = 10 + sRand(wxB + 3) * 26;
            var hgt = 2.4 + sRand(wxB + 5) * 3.6;
            var jy = (sRand(wxB + 7) - 0.5) * 3;
            if (sxB < -60 || sxB > W + 60) continue;
            cx.beginPath();
            cx.ellipse(sxB, syBed + jy, wid, hgt, 0, 0, Math.PI * 2);
            cx.fill();
        }
        cx.globalAlpha = 1;
    }
    cx.restore();
}

// Cave: distant speleothem/column silhouettes inside the deep
// cathedral chamber, and darker "passage-mouth" negative-space
// shapes near the shaft edges to reinforce room scale.
function drawCaveParallaxLayers(cx, W, H, dsx, dsy, mpp) {
    // Only paint when the diver is anywhere near the cathedral —
    // outside that vertical band, the tunnels are too tight for
    // depth layering to make sense.
    var CATHEDRAL_D_MIN = 42;
    var CATHEDRAL_D_MAX = 106;
    if (depth < CATHEDRAL_D_MIN || depth > CATHEDRAL_D_MAX) return;
    cx.save();

    // ── Layer A: distant speleothem columns (parallax 0.50). ──
    // Large, simple tapered rock silhouettes anchored at fixed world
    // positions inside the cathedral (x=60..134, per sites.js zone
    // bounds). Deterministic — same layout every dive.
    var pA = PARALLAX_FACTORS.cave.cathedralColumn;
    var scaleA = 1 / mpp * pA;
    // Hand-picked column anchors inside the cathedral zone (world
    // metres). Two columns are enough for the required "1-2 distant
    // silhouettes" — more would clutter the space.
    var columns = [
        { wx:  78, topD: 52, botD: 100, w: 12 },
        { wx: 118, topD: 55, botD: 100, w: 14 }
    ];
    cx.globalAlpha = 0.13;
    for (var ci = 0; ci < columns.length; ci++) {
        var c = columns[ci];
        var csx = dsx + (c.wx - diverX) * scaleA;
        if (csx < -60 || csx > W + 60) continue;
        var cyTop = dsy + (c.topD - depth) / mpp;
        var cyBot = dsy + (c.botD - depth) / mpp;
        if (cyBot < -40 || cyTop > H + 40) continue;
        var g = cx.createLinearGradient(csx, cyTop, csx, cyBot);
        g.addColorStop(0, 'rgba(30,26,20,0.85)');
        g.addColorStop(0.5, 'rgba(46,42,36,0.55)');
        g.addColorStop(1, 'rgba(20,18,14,0.85)');
        cx.fillStyle = g;
        cx.beginPath();
        cx.moveTo(csx - c.w * 0.35, cyTop);
        cx.quadraticCurveTo(csx - c.w * 0.9, (cyTop + cyBot) * 0.5,
                            csx - c.w * 0.55, cyBot);
        cx.lineTo(csx + c.w * 0.55, cyBot);
        cx.quadraticCurveTo(csx + c.w * 0.9, (cyTop + cyBot) * 0.5,
                            csx + c.w * 0.35, cyTop);
        cx.closePath();
        cx.fill();
    }
    cx.globalAlpha = 1;

    // ── Layer B: passage-mouth cues (parallax 0.40). ──
    // Two darker vertical negative-space blobs near the edges of the
    // cathedral, one on each side, to hint at continuing passages
    // and reinforce the room scale. Purely graphical — never affects
    // collision or the guideline.
    var pB = PARALLAX_FACTORS.cave.passageMouth;
    var scaleB = 1 / mpp * pB;
    var mouths = [
        { wx:  62, cxd: 90, w: 26, h: 28 },  // low-left mouth
        { wx: 132, cxd: 88, w: 24, h: 26 }   // low-right mouth
    ];
    for (var mi = 0; mi < mouths.length; mi++) {
        var m = mouths[mi];
        var msx = dsx + (m.wx - diverX) * scaleB;
        if (msx < -80 || msx > W + 80) continue;
        var msy = dsy + (m.cxd - depth) / mpp;
        if (msy < -40 || msy > H + 40) continue;
        var wpx = m.w / mpp * 0.35;
        var hpx = m.h / mpp * 0.35;
        var rg = cx.createRadialGradient(msx, msy, 4, msx, msy, Math.max(wpx, hpx));
        rg.addColorStop(0, 'rgba(0,0,0,0.42)');
        rg.addColorStop(0.6, 'rgba(0,0,0,0.18)');
        rg.addColorStop(1, 'rgba(0,0,0,0)');
        cx.fillStyle = rg;
        cx.beginPath();
        cx.ellipse(msx, msy, wpx, hpx, 0, 0, Math.PI * 2);
        cx.fill();
    }
    cx.restore();
}

function drawSiteDetailPass() {
    var s = activeSite();
    if (!s) return;
    drawTerrainEdgeAccents(s);
    if (s.id === 'shore') drawShoreSandDetails();
    else if (s.id === 'reef') drawReefTextureDetails();
    else if (s.id === 'cave') drawCaveMineralDetails();
}

function drawTerrainEdgeAccents(s) {
    var W = cssWidth, H = cssHeight;
    var dsx = W * DIVER_SCREEN_X_FRACTION, dsy = H * 0.45, mpp = 0.05;
    var xLeftM = diverX + (0 - dsx) * mpp - 2;
    var xRightM = diverX + (W - dsx) * mpp + 2;
    var cx = ctx;
    cx.save();

    if (s.id === 'shore') {
        cx.strokeStyle = 'rgba(236,205,135,0.32)';
        cx.lineWidth = 1.4;
        cx.beginPath();
        var first = true;
        for (var sxm = xLeftM; sxm <= xRightM; sxm += 0.35) {
            var sandY = dsy + (floorAt(sxm) - depth) / mpp;
            var wob = Math.sin(sxm * 2.8 + waveTime * 0.25) * 1.4;
            var spx = dsx + (sxm - diverX) / mpp;
            if (first) { cx.moveTo(spx, sandY + wob); first = false; }
            else cx.lineTo(spx, sandY + wob);
        }
        cx.stroke();
    } else if (s.id === 'reef') {
        // Small shelves and dark notches break the clean wall edge into ledges.
        for (var rk = Math.floor(xLeftM / 2); rk <= Math.ceil(xRightM / 2); rk++) {
            var rwx = rk * 2;
            if (sRand(rwx + 70) > 0.38) continue;
            var rfd = floorAt(rwx);
            if (rfd >= MAX_DEPTH - 1) continue;
            var rpx = dsx + (rwx - diverX) / mpp;
            var rpy = dsy + (rfd - depth) / mpp;
            if (rpx < -30 || rpx > W + 30 || rpy < -40 || rpy > H + 60) continue;
            var shelfW = 10 + sRand(rwx) * 24;
            cx.fillStyle = sRand(rwx + 1) > 0.5 ? 'rgba(30,18,10,0.34)' : 'rgba(158,98,60,0.22)';
            cx.beginPath();
            cx.ellipse(rpx, rpy + 2, shelfW, 4 + sRand(rwx + 3) * 5, 0, 0, Math.PI * 2);
            cx.fill();
        }
    } else if (s.id === 'cave') {
        cx.strokeStyle = 'rgba(202,190,160,0.16)';
        cx.lineWidth = 1.2;
        for (var ck = Math.floor(xLeftM / 3); ck <= Math.ceil(xRightM / 3); ck++) {
            var cwx = ck * 3;
            var cd = ceilingAt(cwx);
            if (cd <= 1 || sRand(cwx + 44) > 0.55) continue;
            var cpx = dsx + (cwx - diverX) / mpp;
            var cpy = dsy + (cd - depth) / mpp;
            if (cpx < -20 || cpx > W + 20 || cpy < -40 || cpy > H + 20) continue;
            var dripH = 18 + sRand(cwx + 2) * 42;
            cx.beginPath();
            cx.moveTo(cpx, cpy + 2);
            cx.lineTo(cpx + (sRand(cwx + 3) - 0.5) * 5, cpy + dripH);
            cx.stroke();
        }
    }
    cx.restore();
}

function drawShoreSandDetails() {
    var W = cssWidth, H = cssHeight;
    var dsx = W * DIVER_SCREEN_X_FRACTION, dsy = H * 0.45, mpp = 0.05;
    var xLeftM = diverX + (0 - dsx) * mpp - 2;
    var xRightM = diverX + (W - dsx) * mpp + 2;
    var cx = ctx;
    cx.save();
    cx.strokeStyle = 'rgba(255,226,162,0.16)';
    cx.lineWidth = 1;
    for (var r = Math.floor(xLeftM / 3); r <= Math.ceil(xRightM / 3); r++) {
        var wx = r * 3;
        var fd = floorAt(wx);
        var sx = dsx + (wx - diverX) / mpp;
        var sy = dsy + (fd - depth) / mpp;
        if (sy < -20 || sy > H + 40) continue;
        var len = 28 + sRand(wx) * 36;
        var rise = 4 + sRand(wx + 1.2) * 6;
        cx.beginPath();
        cx.moveTo(sx - len * 0.5, sy - 2);
        cx.quadraticCurveTo(sx, sy - rise, sx + len * 0.5, sy - 2);
        cx.stroke();
    }
    cx.fillStyle = 'rgba(45,30,16,0.16)';
    for (var p = Math.floor(xLeftM / 1.8); p <= Math.ceil(xRightM / 1.8); p++) {
        var pwx = p * 1.8;
        if (sRand(pwx + 9.1) > 0.42) continue;
        var pd = floorAt(pwx);
        var psx = dsx + (pwx - diverX) / mpp + (sRand(pwx + 2) - 0.5) * 20;
        var psy = dsy + (pd - depth) / mpp - 1;
        if (psy < -10 || psy > H + 20) continue;
        cx.beginPath(); cx.ellipse(psx, psy, 1.3 + sRand(pwx) * 2.5, 0.8, 0, 0, Math.PI * 2); cx.fill();
    }
    drawShoreAnchoredGrass(cx, xLeftM, xRightM, dsx, dsy, mpp, H);
    cx.restore();
}

function drawShoreAnchoredGrass(cx, xLeftM, xRightM, dsx, dsy, mpp, H) {
    cx.save();
    cx.globalAlpha = 0.34;
    cx.strokeStyle = '#21452b';
    cx.lineCap = 'round';
    for (var k = Math.floor(xLeftM / 3.4); k <= Math.ceil(xRightM / 3.4); k++) {
        var wx = k * 3.4;
        var fd = floorAt(wx);
        if (fd < 6 || fd > 24 || sRand(wx + 80) > 0.52) continue;
        // Do not paint grass through solid structures; those rocks/wrecks should
        // visually own the foreground when they occupy the same world space.
        if (solidAt(wx, fd - 0.25) || solidAt(wx, fd - 1.5)) continue;
        var sx = dsx + (wx - diverX) / mpp;
        var sy = dsy + (fd - depth) / mpp;
        if (sx < -50 || sx > cssWidth + 50 || sy < -20 || sy > H + 30) continue;
        var blades = 4 + Math.floor(sRand(wx + 1) * 4);
        for (var b = 0; b < blades; b++) {
            var ox = (b - blades / 2) * 5;
            var h = 20 + sRand(wx + b * 2.7) * 34;
            cx.lineWidth = 1.4 + sRand(wx + b) * 1.2;
            cx.beginPath();
            cx.moveTo(sx + ox, sy);
            cx.quadraticCurveTo(sx + ox + Math.sin(waveTime + b) * 5, sy - h * 0.55,
                                sx + ox + Math.sin(waveTime * 1.3 + b) * 8, sy - h);
            cx.stroke();
        }
    }
    cx.restore();
}

function drawReefTextureDetails() {
    var W = cssWidth, H = cssHeight;
    var dsx = W * DIVER_SCREEN_X_FRACTION, dsy = H * 0.45, mpp = 0.05;
    var xLeftM = diverX + (0 - dsx) * mpp - 2;
    var xRightM = diverX + (W - dsx) * mpp + 2;
    var cx = ctx;
    cx.save();
    for (var k = Math.floor(xLeftM / 1.2); k <= Math.ceil(xRightM / 1.2); k++) {
        var wx = k * 1.2;
        var fd = floorAt(wx);
        if (fd >= MAX_DEPTH - 1 || sRand(wx + 31) > 0.55) continue;
        var sx = dsx + (wx - diverX) / mpp;
        var sy = dsy + (fd - depth) / mpp;
        if (sx < -50 || sx > W + 50 || sy < -50 || sy > H + 60) continue;
        var hue = sRand(wx + 2.4);
        cx.fillStyle = hue < 0.33 ? 'rgba(230,142,70,0.35)' : hue < 0.66 ? 'rgba(198,68,132,0.32)' : 'rgba(236,205,110,0.28)';
        cx.beginPath();
        cx.ellipse(sx, sy - 3, 5 + sRand(wx) * 11, 2 + sRand(wx + 4) * 4, -0.2, 0, Math.PI * 2);
        cx.fill();
    }
    cx.strokeStyle = 'rgba(10,8,6,0.34)';
    cx.lineCap = 'round';
    for (var c = Math.floor(xLeftM / 3.2); c <= Math.ceil(xRightM / 3.2); c++) {
        var cwx = c * 3.2;
        var cfd = floorAt(cwx);
        if (cfd >= MAX_DEPTH - 1 || sRand(cwx + 105) > 0.42) continue;
        var cpx = dsx + (cwx - diverX) / mpp;
        var cpy = dsy + (cfd + 1.4 + sRand(cwx) * 16 - depth) / mpp;
        if (cpx < -40 || cpx > W + 40 || cpy < -50 || cpy > H + 70) continue;
        if (sRand(cwx + 6) > 0.55) {
            cx.fillStyle = 'rgba(8,8,8,0.28)';
            cx.beginPath(); cx.ellipse(cpx, cpy, 5 + sRand(cwx + 1) * 9, 8 + sRand(cwx + 2) * 15, 0.15, 0, Math.PI * 2); cx.fill();
        } else {
            cx.lineWidth = 1.2 + sRand(cwx + 3) * 1.2;
            cx.beginPath();
            cx.moveTo(cpx, cpy - 14);
            cx.quadraticCurveTo(cpx + (sRand(cwx + 4) - 0.5) * 15, cpy + 10,
                                cpx + (sRand(cwx + 5) - 0.5) * 12, cpy + 42);
            cx.stroke();
        }
    }
    cx.restore();
}

function drawWreckExteriorDetails() {
    var s = activeSite();
    if (!s || s.id !== 'wreck') return;
    var W = cssWidth, H = cssHeight, cx = ctx;
    var dsx = W * DIVER_SCREEN_X_FRACTION, dsy = H * 0.45, mpp = 0.05;
    var exteriorFade = Math.max(0.18, 1 - _wreckMetal * 0.78);

    cx.save();
    cx.globalAlpha = exteriorFade;
    _buildWreckSilhouette(cx, dsx, dsy, mpp);
    cx.clip();
    drawUprightFerryShell(cx, dsx, dsy, mpp, W, H);
    // Long rust tears and old paint scratches, seeded in world-space columns.
    for (var i = 0; i < 34; i++) {
        var wx = 18 + i * 4.5 + sRand(i) * 2;
        var d0 = 19 + sRand(i + 7) * 22;
        var sx = dsx + (wx - diverX) / mpp;
        var sy = dsy + (d0 - depth) / mpp;
        if (sx < -20 || sx > W + 20 || sy > H + 60) continue;
        var len = 26 + sRand(i + 12) * 70;
        var rust = cx.createLinearGradient(sx, sy, sx, sy + len);
        rust.addColorStop(0, 'rgba(190,82,28,0.34)');
        rust.addColorStop(1, 'rgba(80,36,18,0)');
        cx.strokeStyle = rust;
        cx.lineWidth = 1 + sRand(i + 4) * 2.5;
        cx.beginPath();
        cx.moveTo(sx, sy);
        cx.quadraticCurveTo(sx + (sRand(i + 2) - 0.5) * 18, sy + len * 0.45,
                            sx + (sRand(i + 3) - 0.5) * 10, sy + len);
        cx.stroke();
    }
    drawWreckShipCues(cx, dsx, dsy, mpp, W, H, exteriorFade);
    cx.restore();
}

function drawUprightFerryShell(cx, dsx, dsy, mpp, W, H) {
    function SX(wx) { return dsx + (wx - diverX) / mpp; }
    function SY(wd) { return dsy + (wd - depth) / mpp; }
    cx.save();

    // Keel contact shadow and silt mound: the ship feels heavy on the seabed.
    var keelY = SY(66);
    var keelG = cx.createRadialGradient(SX(92), keelY, 20, SX(92), keelY, 680);
    keelG.addColorStop(0, 'rgba(0,0,0,0.34)');
    keelG.addColorStop(1, 'rgba(0,0,0,0)');
    cx.fillStyle = keelG;
    cx.beginPath(); cx.ellipse(SX(92), keelY + 8, 1550, 34, 0, 0, Math.PI * 2); cx.fill();

    // Upright ferry shell: angled bow/stern faces and a dark lower hull band.
    var hullTop = SY(28), hullBot = SY(66);
    var shellG = cx.createLinearGradient(0, hullTop, 0, hullBot);
    shellG.addColorStop(0, 'rgba(54,65,68,0.34)');
    shellG.addColorStop(0.55, 'rgba(34,40,43,0.22)');
    shellG.addColorStop(1, 'rgba(10,12,14,0.38)');
    cx.fillStyle = shellG;
    cx.beginPath();
    cx.moveTo(SX(14), SY(66));
    cx.lineTo(SX(17), SY(34));
    cx.quadraticCurveTo(SX(21), SY(29), SX(29), SY(28));
    cx.lineTo(SX(154), SY(28));
    cx.quadraticCurveTo(SX(166), SY(30), SX(170), SY(39));
    cx.lineTo(SX(170), SY(66));
    cx.closePath();
    cx.fill();
    cx.strokeStyle = 'rgba(125,146,148,0.18)';
    cx.lineWidth = 2;
    cx.stroke();

    // Old antifouling/boot stripe and deck-level seams.
    cx.fillStyle = 'rgba(92,36,28,0.20)';
    cx.fillRect(SX(14), SY(53), SX(170) - SX(14), SY(66) - SY(53));
    cx.strokeStyle = 'rgba(8,10,12,0.55)';
    cx.lineWidth = 2;
    cx.beginPath(); cx.moveTo(SX(18), SY(40)); cx.lineTo(SX(166), SY(40)); cx.stroke();
    cx.beginPath(); cx.moveTo(SX(18), SY(46)); cx.lineTo(SX(166), SY(46)); cx.stroke();
    cx.beginPath(); cx.moveTo(SX(18), SY(53)); cx.lineTo(SX(166), SY(53)); cx.stroke();

    // Vehicle deck shadow slot: long Ro-Ro identity, but still upright.
    cx.fillStyle = 'rgba(0,0,0,0.18)';
    cx.beginPath();
    cx.roundRect(SX(24), SY(31), SX(148) - SX(24), Math.max(8, SY(39) - SY(31)), 2);
    cx.fill();
    cx.strokeStyle = 'rgba(130,150,150,0.14)';
    cx.lineWidth = 1;
    cx.stroke();

    // Superstructure front panels and bridge glazing.
    cx.fillStyle = 'rgba(88,96,88,0.22)';
    cx.fillRect(SX(42), SY(22), SX(138) - SX(42), SY(28) - SY(22));
    cx.fillStyle = 'rgba(18,45,54,0.55)';
    for (var w = 73; w <= 105; w += 8) {
        cx.beginPath();
        cx.roundRect(SX(w), SY(19.4), 5 / mpp, 2.4 / mpp, 1.2);
        cx.fill();
    }
    cx.strokeStyle = 'rgba(160,190,190,0.15)';
    cx.lineWidth = 1;
    cx.beginPath(); cx.moveTo(SX(72), SY(19)); cx.lineTo(SX(108), SY(19)); cx.stroke();

    cx.restore();
}

function drawWreckShipCues(cx, dsx, dsy, mpp, W, H, alpha) {
    function SX(wx) { return dsx + (wx - diverX) / mpp; }
    function SY(wd) { return dsy + (wd - depth) / mpp; }

    // Portholes and a tired livery stripe help the blocky shell read as a ferry.
    cx.save();
    cx.globalAlpha *= alpha;
    cx.strokeStyle = 'rgba(95,130,140,0.34)';
    cx.lineWidth = 1.2;
    for (var x = 46; x <= 134; x += 8) {
        var px = SX(x), py = SY(24.5);
        if (px < -20 || px > W + 20 || py < -20 || py > H + 20) continue;
        cx.fillStyle = 'rgba(18,48,58,0.45)';
        cx.beginPath(); cx.arc(px, py, 3.2, 0, Math.PI * 2); cx.fill(); cx.stroke();
        cx.fillStyle = 'rgba(160,220,220,0.12)';
        cx.beginPath(); cx.arc(px - 0.8, py - 0.8, 1.1, 0, Math.PI * 2); cx.fill();
    }
    cx.strokeStyle = 'rgba(180,70,48,0.28)';
    cx.lineWidth = 4;
    cx.beginPath(); cx.moveTo(SX(18), SY(30)); cx.lineTo(SX(166), SY(30)); cx.stroke();

    // Bow visor and stern ramp outlines: Ro-Ro ferry, upright on the bottom.
    cx.strokeStyle = 'rgba(20,24,26,0.70)';
    cx.lineWidth = 2.2;
    cx.beginPath();
    cx.moveTo(SX(16), SY(29)); cx.lineTo(SX(26), SY(36)); cx.lineTo(SX(22), SY(40));
    cx.stroke();
    cx.beginPath();
    cx.moveTo(SX(148), SY(30)); cx.lineTo(SX(168), SY(35)); cx.lineTo(SX(164), SY(40));
    cx.stroke();

    // Deck railings: decorative only, not collision.
    cx.strokeStyle = 'rgba(18,24,26,0.78)';
    cx.lineWidth = 2;
    var railY = SY(22);
    cx.beginPath(); cx.moveTo(SX(42), railY); cx.lineTo(SX(138), railY); cx.stroke();
    cx.lineWidth = 1;
    for (var r = 42; r <= 138; r += 6) {
        cx.beginPath(); cx.moveTo(SX(r), railY); cx.lineTo(SX(r), railY - 12); cx.stroke();
    }

    // Davit arms near the lifeboat positions.
    cx.strokeStyle = 'rgba(20,24,26,0.62)';
    cx.lineWidth = 1.6;
    var davits = [48, 132];
    for (var d = 0; d < davits.length; d++) {
        cx.beginPath();
        cx.moveTo(SX(davits[d]), SY(22));
        cx.quadraticCurveTo(SX(davits[d] + (d === 0 ? -5 : 5)), SY(21), SX(davits[d] + (d === 0 ? -8 : 8)), SY(24));
        cx.stroke();
    }

    // Torn plating around the three entry mouths and a few hanging cables.
    var entries = [18, 85, 158];
    cx.strokeStyle = 'rgba(10,12,14,0.55)';
    cx.lineWidth = 2.2;
    for (var e = 0; e < entries.length; e++) {
        var ex = SX(entries[e]);
        var ey = SY(e === 1 ? 28 : 27.5);
        if (ex < -80 || ex > W + 80) continue;
        cx.beginPath();
        cx.moveTo(ex - 24, ey + 2);
        cx.lineTo(ex - 12, ey + 12);
        cx.lineTo(ex + 2, ey + 5);
        cx.lineTo(ex + 18, ey + 16);
        cx.stroke();
        cx.lineWidth = 1.2;
        cx.beginPath();
        cx.moveTo(ex + 10, ey + 2);
        cx.quadraticCurveTo(ex + 16, ey + 22, ex + 8, ey + 40);
        cx.stroke();
        cx.lineWidth = 2.2;
    }

    // Marine-growth fringes along exposed rails and deck lips.
    cx.strokeStyle = 'rgba(150,130,72,0.46)';
    cx.lineWidth = 2.2;
    cx.lineCap = 'round';
    for (var g = 0; g < 26; g++) {
        var gx = 30 + g * 5.1;
        if (sRand(gx + 211) > 0.62) continue;
        var gd = 28 + sRand(gx) * 3.5;
        cx.beginPath();
        cx.moveTo(SX(gx), SY(gd));
        cx.quadraticCurveTo(SX(gx + 0.6), SY(gd + 1.2), SX(gx + 0.2), SY(gd + 3.2 + sRand(gx + 3) * 2));
        cx.stroke();
    }

    // Small debris and silt against the upright keel.
    cx.fillStyle = 'rgba(70,56,38,0.34)';
    for (var s = 0; s < 22; s++) {
        var dx = 18 + sRand(s + 301) * 148;
        var dy = 65.4 + sRand(s + 302) * 1.2;
        var px2 = SX(dx), py2 = SY(dy);
        if (px2 < -20 || px2 > W + 20 || py2 < -20 || py2 > H + 20) continue;
        cx.beginPath(); cx.ellipse(px2, py2, 2 + sRand(s) * 5, 0.8 + sRand(s + 2) * 1.4, 0, 0, Math.PI * 2); cx.fill();
    }
    cx.restore();
}

function drawCaveMineralDetails() {
    var W = cssWidth, H = cssHeight;
    var dsx = W * DIVER_SCREEN_X_FRACTION, dsy = H * 0.45, mpp = 0.05;
    var xLeftM = diverX + (0 - dsx) * mpp - 2;
    var xRightM = diverX + (W - dsx) * mpp + 2;
    var cx = ctx;
    cx.save();
    for (var k = Math.floor(xLeftM / 2.4); k <= Math.ceil(xRightM / 2.4); k++) {
        var wx = k * 2.4;
        if (sRand(wx + 15) > 0.45) continue;
        var cd = ceilingAt(wx);
        if (cd <= 1) continue;
        var sx = dsx + (wx - diverX) / mpp;
        var sy = dsy + (cd - depth) / mpp;
        if (sx < -20 || sx > W + 20 || sy < -30 || sy > H + 30) continue;
        cx.strokeStyle = 'rgba(232,220,192,0.22)';
        cx.lineWidth = 1 + sRand(wx) * 1.5;
        var h = 24 + sRand(wx + 3) * 60;
        cx.beginPath();
        cx.moveTo(sx, sy + 3);
        cx.quadraticCurveTo(sx + (sRand(wx + 4) - 0.5) * 10, sy + h * 0.45,
                            sx + (sRand(wx + 5) - 0.5) * 8, sy + h);
        cx.stroke();
    }
    // Bad-air lens — moved to _drawCaveBadAirLens (issue #32). Reads
    // position from activeSite().badAir. See below for the full formation.
    _drawCaveBadAirLens(cx, activeSite(), dsx, dsy, mpp, W, H);
    cx.restore();
}

// ── Issue #32: cave visual polish ─────────────────────────────────
// All four pieces (bad-air lens, exit light staging, silt cloud,
// speleothem columns/flowstone) share these guardrails:
//   • NEVER change gameplay geometry — collisions and warning triggers
//     stay on the physics side. These are read-only from `activeSite()`
//     / `visibility` / `torchOn`.
//   • Position data is read from source-of-truth structures:
//       - bad-air lens ← activeSite().badAir[]  (no hardcoded coords)
//       - exit shaft   ← activeSite().visualZones (cave_exit) + ceilingAt()
//     So if sites.js ever moves them, the visuals track.
//   • Deterministic — every stochastic value is `sRand(worldSeed)`;
//     never `Math.random()` per frame.

// Speleothem-column merge tolerance: when a stalactite tip and a
// stalagmite tip end up within COLUMN_MERGE_TOL_M metres of each other
// at the same world-x, they read as one continuous column instead of
// two independent drips. Purely visual; the underlying pair still
// carries no collision.
const COLUMN_MERGE_TOL_M = 0.6;
// Flowstone: spawn probability per candidate wall segment. Kept low so
// only a handful of standout drapes appear, not a uniform texture.
const FLOWSTONE_PROBABILITY = 0.18;
// Wall gradient (rise in floor or ceiling depth over a small horizontal
// step) above which the segment counts as "steep" and eligible for
// flowstone. Metres of depth change per metre of x.
const FLOWSTONE_STEEP_GRADIENT = 1.6;
// Bad-air lens visual thickness — the lens hugs the ceiling underside;
// this is how tall the air pocket is drawn (metres). Purely cosmetic.
const BAD_AIR_LENS_THICKNESS_M = 1.1;
// Silt cloud parameters. Sits near the floor where kicks stir sediment.
const SILT_CLOUD_HEIGHT_M     = 1.6;   // vertical thickness of the cloud band above floor
const SILT_CLOUD_STEP_M       = 0.5;   // world-x sample spacing for particles
const SILT_CLOUD_MAX_ALPHA    = 0.55;  // alpha at full silt-out (visibility = 0)
const SILT_CLOUD_MIN_VIS      = 0.02;  // early-out threshold — cloud is invisible above this
// Exit light shaft — how many world metres from the exit opening the
// approach brightening starts to ramp up.
const EXIT_LIGHT_NEAR_M       = 6;
const EXIT_LIGHT_FAR_M        = 40;
const EXIT_LIGHT_BASE_ALPHA   = 0.10;
const EXIT_LIGHT_TORCH_BOOST_ALPHA = 0.06;

// Bad-air pocket: a silvery air lens along the ceiling underside. Reads
// as a physical air pocket BEFORE the diver would swim into it. Position
// is derived exactly from activeSite().badAir[] — never hardcoded here.
function _drawCaveBadAirLens(cx, s, dsx, dsy, mpp, W, H) {
    if (!s || !s.badAir || !s.badAir.length) return;
    cx.save();
    for (var i = 0; i < s.badAir.length; i++) {
        var pocket = s.badAir[i];
        var x1 = dsx + (pocket.x1 - diverX) / mpp;
        var x2 = dsx + (pocket.x2 - diverX) / mpp;
        // Sample the actual ceiling profile across the pocket so the
        // lens hugs whatever cave ceiling sits above the pocket span.
        // We use ceilingAt() rather than pocket.d directly — pocket.d is
        // the depth at which the pocket _starts_, i.e. its bottom edge;
        // the ceiling above it may be higher/lower depending on profile.
        var topY = dsy + (pocket.d - depth) / mpp;
        var lensBotY = topY;
        var lensTopY = topY - BAD_AIR_LENS_THICKNESS_M / mpp;
        if (x2 < -60 || x1 > W + 60) continue;
        if (lensBotY < -40 && lensTopY < -40) continue;
        if (lensTopY > H + 40 && lensBotY > H + 40) continue;

        // ---- underside mirror gradient — brighter at top (rock/air
        // interface), fading down into the water. Standard source-over
        // so it reads as reflective surface, not additive glow.
        var lensGrad = cx.createLinearGradient(0, lensTopY, 0, lensBotY);
        lensGrad.addColorStop(0,    'rgba(232,240,248,0.72)');
        lensGrad.addColorStop(0.55, 'rgba(190,210,225,0.48)');
        lensGrad.addColorStop(1,    'rgba(50,64,80,0.18)');
        cx.fillStyle = lensGrad;
        cx.beginPath();
        // Gently wavering top edge (against ceiling).
        cx.moveTo(x1, lensTopY);
        for (var sxT = x1; sxT <= x2; sxT += 5) {
            var yT = lensTopY + Math.sin((sxT + waveTime * 22) * 0.06) * 0.7;
            cx.lineTo(sxT, yT);
        }
        // Wavering bottom edge — this is the visible boundary line.
        for (var sxB = x2; sxB >= x1; sxB -= 5) {
            var yB = lensBotY + Math.sin((sxB + waveTime * 30) * 0.09) * 1.6;
            cx.lineTo(sxB, yB);
        }
        cx.closePath();
        cx.fill();

        // ---- soft mirror-highlight band right along the ceiling.
        var hlGrad = cx.createLinearGradient(0, lensTopY, 0, lensTopY + 6);
        hlGrad.addColorStop(0, 'rgba(248,252,255,0.85)');
        hlGrad.addColorStop(1, 'rgba(248,252,255,0)');
        cx.fillStyle = hlGrad;
        cx.fillRect(Math.max(-40, x1 - 2), lensTopY - 1, Math.min(W + 40, x2) - x1 + 4, 7);

        // ---- gently wavering boundary line at the water/air interface.
        cx.strokeStyle = 'rgba(240,246,252,0.85)';
        cx.lineWidth = 1.6;
        cx.beginPath();
        for (var sxL = x1; sxL <= x2; sxL += 4) {
            var yL = lensBotY + Math.sin((sxL + waveTime * 30) * 0.09) * 1.6;
            if (sxL === x1) cx.moveTo(sxL, yL); else cx.lineTo(sxL, yL);
        }
        cx.stroke();

        // ---- faint darker underline just below the interface — makes
        // the lens read as sitting ABOVE the water, not floating in it.
        cx.strokeStyle = 'rgba(15,20,26,0.50)';
        cx.lineWidth = 1.0;
        cx.beginPath();
        for (var sxU = x1; sxU <= x2; sxU += 4) {
            var yU = lensBotY + 2 + Math.sin((sxU + waveTime * 30) * 0.09) * 1.6;
            if (sxU === x1) cx.moveTo(sxU, yU); else cx.lineTo(sxU, yU);
        }
        cx.stroke();
    }
    cx.restore();
}

// Silt turbidity cloud. Deterministic (seeded by world-x) — no per-frame
// Math.random(). Intensity is driven by the EXISTING `visibility` state
// (1 = clear, 0 = full silt-out) so we don't invent a second reservoir.
// Slightly brighter where the torch cone hits, using #33's
// sampleTorchLightAtWorldPoint(). Runs BEFORE the torch/silt pass so it
// composites naturally into the scene alongside plankton.
function drawCaveSiltCloud() {
    if (gameState !== 'diving') return;
    var s = activeSite();
    if (!s || s.id !== 'cave') return;
    if (!(visibility < 1 - SILT_CLOUD_MIN_VIS)) return;   // essentially clear → cheap early-out
    var W = cssWidth, H = cssHeight;
    var dsx = W * DIVER_SCREEN_X_FRACTION, dsy = H * 0.45, mpp = 0.05;
    var xLeftM = diverX + (0 - dsx) * mpp - 2;
    var xRightM = diverX + (W - dsx) * mpp + 2;
    var cx = ctx;
    cx.save();
    var siltT = 1 - visibility;                          // 0 clear → 1 full silt-out
    if (siltT < 0) siltT = 0;
    if (siltT > 1) siltT = 1;
    var globalAlpha = SILT_CLOUD_MAX_ALPHA * siltT;
    for (var kx = Math.floor(xLeftM / SILT_CLOUD_STEP_M); kx <= Math.ceil(xRightM / SILT_CLOUD_STEP_M); kx++) {
        var wx = kx * SILT_CLOUD_STEP_M;
        var seed = wx * 13.31 + 4.7;
        // Roll a per-cell "particle exists" flag, biased by silt intensity so
        // heavier silt-outs paint noticeably denser cloud (not just brighter).
        if (sRand(seed + 1.1) > 0.4 + 0.5 * siltT) continue;
        var fd = floorAt(wx);
        if (!(fd > 1)) continue;
        // Distribute particles vertically in the near-floor band.
        var vFrac = sRand(seed + 2.3);                    // 0..1 → floor band
        var wd = fd - vFrac * SILT_CLOUD_HEIGHT_M;
        if (wd < depth - 12) continue;                    // don't draw far above the diver's viewport
        // Very slow world-anchored drift so the cloud reads as suspended
        // sediment, not a static texture. Deterministic sine of waveTime.
        var driftX = Math.sin(waveTime * 0.35 + seed) * 0.4;
        var driftY = Math.sin(waveTime * 0.28 + seed * 1.7) * 0.25;
        var px = dsx + (wx + driftX - diverX) / mpp;
        var py = dsy + (wd + driftY - depth) / mpp;
        if (px < -20 || px > W + 20 || py < -20 || py > H + 20) continue;
        var radius = 3 + sRand(seed + 5.1) * 6;           // 3..9 px puff
        // Brownish-gray body, low base alpha, brightened where torch reaches.
        var torchLight = sampleTorchLightAtWorldPoint(wx, wd);
        var baseA = globalAlpha * (0.4 + 0.6 * sRand(seed + 7.9));
        var litA = Math.min(0.85, baseA * (1 + torchLight * 1.6));
        var g = cx.createRadialGradient(px, py, 0, px, py, radius);
        // Warm brown → cool gray core so different puffs feel like
        // different silt densities without a per-frame color roll.
        var warmR = 130 + Math.floor(sRand(seed + 9.1) * 20);
        var warmG = 118 + Math.floor(sRand(seed + 9.3) * 16);
        var warmB = 100 + Math.floor(sRand(seed + 9.5) * 14);
        g.addColorStop(0,   'rgba(' + warmR + ',' + warmG + ',' + warmB + ',' + litA.toFixed(3) + ')');
        g.addColorStop(0.6, 'rgba(' + warmR + ',' + warmG + ',' + warmB + ',' + (litA * 0.35).toFixed(3) + ')');
        g.addColorStop(1,   'rgba(' + warmR + ',' + warmG + ',' + warmB + ',0)');
        cx.fillStyle = g;
        cx.beginPath();
        cx.arc(px, py, radius, 0, Math.PI * 2);
        cx.fill();
    }
    cx.restore();
}

// Rear-exit light staging. Wedge/gradient light-shaft math, origin-anchored
// to the cave_exit visualZone opening (where the ceiling meets the surface
// at ~x=200), NOT to the global surfaceScreenY — the
// diver is inside overhead so the general near-surface pass has
// early-returned. Alpha ramps with the diver's approach distance so the
// exit reads as an inviting light target from deep inside the tunnel.
function drawCaveExitLightShaft() {
    if (gameState !== 'diving') return;
    var s = activeSite();
    if (!s || s.id !== 'cave') return;
    if (!s.visualZones) return;
    var exitZone = null;
    for (var i = 0; i < s.visualZones.length; i++) {
        if (s.visualZones[i].id === 'cave_exit') { exitZone = s.visualZones[i]; break; }
    }
    if (!exitZone) return;
    var W = cssWidth, H = cssHeight;
    var dsx = W * DIVER_SCREEN_X_FRACTION, dsy = H * 0.45, mpp = 0.05;
    // Approach factor: 1 when diver is right at/inside the exit opening,
    // fading to a base intensity at EXIT_LIGHT_FAR_M metres away.
    var approachDx;
    if (diverX < exitZone.x1) approachDx = exitZone.x1 - diverX;
    else if (diverX > exitZone.x2) approachDx = diverX - exitZone.x2;
    else approachDx = 0;
    var approach;
    if (approachDx <= EXIT_LIGHT_NEAR_M) approach = 1;
    else if (approachDx >= EXIT_LIGHT_FAR_M) approach = 0.25;
    else {
        var tA = (EXIT_LIGHT_FAR_M - approachDx) / (EXIT_LIGHT_FAR_M - EXIT_LIGHT_NEAR_M);
        approach = 0.25 + 0.75 * tA * tA * (3 - 2 * tA);
    }
    // Wedges anchored on a 6 m world grid inside the exit opening. Only
    // where the ceiling has actually risen (cd small) so the wedge origin
    // is a real opening, not a spot still enclosed by rock.
    var cx = ctx;
    cx.save();
    cx.globalCompositeOperation = 'lighter';
    var spacing = 6;
    var xStart = Math.floor(exitZone.x1 / spacing) * spacing;
    var xEnd = Math.ceil(exitZone.x2 / spacing) * spacing;
    var anyDrawn = false;
    for (var wx = xStart; wx <= xEnd; wx += spacing) {
        if (wx < exitZone.x1 - 2 || wx > exitZone.x2 + 2) continue;
        var cd = ceilingAt(wx);
        // Only draw where the ceiling is essentially open (near-surface).
        // The exit ceiling rises from d≈16 at x1 to d=0 at x2 — we want
        // the shaft only where light could plausibly enter.
        if (cd > 8) continue;
        var seed = wx * 0.171 + 3.7;
        var jitter = (sRand(seed) - 0.5) * 4;
        var rayWorldX = wx + jitter + Math.sin(waveTime * 0.25 + seed) * 1;
        var topScreenX = dsx + (rayWorldX - diverX) / mpp;
        if (topScreenX < -80 || topScreenX > W + 80) continue;
        // Wedge origin sits at the ceiling profile above the exit.
        var beamTopY = dsy + (cd - depth) / mpp - 6;
        // Descends into the cave interior. Cap at 22 m below the origin
        // so the shaft fades before it would clip through the far floor.
        var beamBotY = beamTopY + 22 / mpp;
        beamTopY = Math.max(-40, beamTopY);
        beamBotY = Math.min(H + 20, beamBotY);
        if (beamBotY <= beamTopY + 20) continue;
        var angle = (sRand(seed + 1.1) - 0.5) * 0.35;
        var topHalf = 10 + sRand(seed + 2.3) * 6;
        var botHalf = 34 + sRand(seed + 3.3) * 14;
        var xTopL = topScreenX - topHalf;
        var xTopR = topScreenX + topHalf;
        var xBotL = topScreenX - botHalf + angle * 30;
        var xBotR = topScreenX + botHalf + angle * 30;
        // Small extra brightening when the torch is on and pointed near
        // this shaft — not "torch creates the light", but "torch reveals
        // the medium/scatter within it".
        var torchAt = sampleTorchLightAtWorldPoint(rayWorldX, cd + 2);
        var aTop = (EXIT_LIGHT_BASE_ALPHA + EXIT_LIGHT_TORCH_BOOST_ALPHA * torchAt) * approach;
        var g = cx.createLinearGradient(0, beamTopY, 0, beamBotY);
        // Match drawPond's warm sunbeam palette so the exit reads as
        // the same open-water light source as the entrance pond.
        g.addColorStop(0,    'rgba(255,245,216,' + aTop.toFixed(3) + ')');
        g.addColorStop(0.55, 'rgba(200,230,220,' + (aTop * 0.45).toFixed(3) + ')');
        g.addColorStop(1,    'rgba(160,200,205,0)');
        cx.fillStyle = g;
        cx.beginPath();
        cx.moveTo(xTopL, beamTopY);
        cx.lineTo(xTopR, beamTopY);
        cx.lineTo(xBotR, beamBotY);
        cx.lineTo(xBotL, beamBotY);
        cx.closePath();
        cx.fill();
        anyDrawn = true;
    }
    // A small overall glow blob at the brightest opening spot (right end
    // of the exit, where ceilingAt is smallest) so the reader can pick
    // the exit out even from far away when individual wedges are dim.
    if (anyDrawn) {
        var brightX = exitZone.x2 - 4;
        var brightCd = ceilingAt(brightX);
        var glowY = dsy + (brightCd - depth) / mpp;
        var glowSX = dsx + (brightX - diverX) / mpp;
        if (glowSX > -100 && glowSX < W + 100 && glowY > -40 && glowY < H + 40) {
            var glowA = 0.14 * approach;
            var glowGrad = cx.createRadialGradient(glowSX, glowY, 0, glowSX, glowY, 70);
            glowGrad.addColorStop(0,   'rgba(255,245,216,' + glowA.toFixed(3) + ')');
            glowGrad.addColorStop(0.4, 'rgba(220,235,220,' + (glowA * 0.5).toFixed(3) + ')');
            glowGrad.addColorStop(1,   'rgba(160,200,205,0)');
            cx.fillStyle = glowGrad;
            cx.beginPath();
            cx.arc(glowSX, glowY, 70, 0, Math.PI * 2);
            cx.fill();
        }
    }
    cx.restore();
}

// Flowstone: wide, layered calcite curtain on a steep wall section. Runs
// beside stalactite/stalagmite generation, sharing its deterministic
// seed-by-world-x pattern.
function _drawFlowstoneDrape(cx, x, y, wPx, hPx, seed) {
    cx.save();
    var g = cx.createLinearGradient(x, y, x, y + hPx);
    g.addColorStop(0,    CAVE_PAL.calciteLite);
    g.addColorStop(0.35, CAVE_PAL.calciteMid);
    g.addColorStop(1,    CAVE_PAL.calciteDark);
    cx.fillStyle = g;
    cx.beginPath();
    cx.moveTo(x - wPx * 0.5, y);
    // Layered scalloped bottom edge — 4-6 lobes.
    var lobes = 4 + Math.floor(sRand(seed + 1.3) * 3);
    var lobeStep = wPx / lobes;
    for (var li = 0; li <= lobes; li++) {
        var lx = x - wPx * 0.5 + li * lobeStep;
        var lyOff = (li % 2 === 0 ? 0.85 : 1.0);
        cx.lineTo(lx, y + hPx * lyOff);
    }
    cx.lineTo(x + wPx * 0.5, y);
    cx.closePath();
    cx.fill();
    // Two or three horizontal deposition bands — pale ribbons.
    var bands = 2 + Math.floor(sRand(seed + 2.7) * 2);
    cx.strokeStyle = 'rgba(232,220,192,0.35)';
    cx.lineWidth = 1;
    for (var bi = 1; bi <= bands; bi++) {
        var by = y + hPx * (bi / (bands + 1));
        cx.beginPath();
        cx.moveTo(x - wPx * 0.45, by);
        cx.quadraticCurveTo(x, by + 1.2, x + wPx * 0.45, by);
        cx.stroke();
    }
    cx.restore();
}

function drawForegroundLayer() {
    var s = activeSite();
    if (!s) return;
    var W = cssWidth, H = cssHeight;
    var dsx = W * DIVER_SCREEN_X_FRACTION, dsy = H * 0.45, mpp = 0.05;
    var cx = ctx;
    cx.save();
    if (s.id === 'shore') {
        // Shore grass is drawn world-anchored in the sand detail pass so rocks
        // and wreckage can occlude it correctly.
    } else if (s.id === 'reef') {
        drawForegroundReefFans(cx, W, H, dsx, dsy, mpp);
    } else if (s.id === 'wreck') {
        drawForegroundWreckDebris(cx, W, H, dsx, dsy, mpp);
    } else if (s.id === 'cave') {
        drawForegroundCaveColumns(cx, W, H, dsx, dsy, mpp);
    }
    cx.restore();
}

function drawForegroundReefFans(cx, W, H, dsx, dsy, mpp) {
    var side = diverX > 0 ? -1 : 1;
    var baseX = side < 0 ? -15 : W + 15;
    cx.globalAlpha = 0.24;
    cx.strokeStyle = '#5a1730';
    cx.lineCap = 'round';
    for (var i = 0; i < 5; i++) {
        var seed = i * 17.3 + Math.floor(diverX / 5);
        var y = H * (0.25 + i * 0.14) + Math.sin(seed) * 22;
        var h = 95 + sRand(seed) * 90;
        var sign = side;
        cx.lineWidth = 3;
        cx.beginPath();
        cx.moveTo(baseX, y + h * 0.45);
        cx.quadraticCurveTo(baseX + sign * 28, y - h * 0.15, baseX + sign * 46, y - h * 0.42);
        cx.stroke();
        cx.lineWidth = 1.5;
        for (var r = 0; r < 12; r++) {
            var t = r / 11;
            var len = h * (0.42 + Math.sin(t * Math.PI) * 0.35);
            cx.beginPath();
            cx.moveTo(baseX, y + h * 0.45);
            cx.quadraticCurveTo(baseX + sign * len * 0.34, y + h * 0.2 - len * t,
                                baseX + sign * len, y + h * 0.35 - len);
            cx.stroke();
        }
    }
    cx.globalAlpha = 1;
}

function drawForegroundWreckDebris(cx, W, H, dsx, dsy, mpp) {
    var floorY = dsy + (66 - depth) / mpp;
    if (floorY < H * 0.45 || floorY > H + 220) return;
    cx.globalAlpha = 0.26;
    cx.strokeStyle = '#0b0d0f';
    cx.lineWidth = 5;
    cx.lineCap = 'round';
    for (var i = 0; i < 9; i++) {
        var wx = -20 + i * 28 + sRand(i) * 10;
        var sx = dsx + (wx - diverX) / (mpp * 0.82);
        var sy = floorY + 18 + sRand(i + 2) * 110;
        if (sx < -120 || sx > W + 120) continue;
        cx.beginPath();
        cx.moveTo(sx - 42, sy);
        cx.lineTo(sx + 36, sy - 10 - sRand(i + 5) * 35);
        cx.stroke();
        cx.lineWidth = 2;
        cx.beginPath();
        cx.moveTo(sx - 20, sy - 4);
        cx.lineTo(sx - 14, sy - 36);
        cx.moveTo(sx + 12, sy - 7);
        cx.lineTo(sx + 18, sy - 42);
        cx.stroke();
        cx.lineWidth = 5;
    }
    cx.globalAlpha = 1;
}

function drawForegroundCaveColumns(cx, W, H, dsx, dsy, mpp) {
    var xLeftM = diverX + (0 - dsx) * mpp * 0.7 - 8;
    var xRightM = diverX + (W - dsx) * mpp * 0.7 + 8;
    cx.globalAlpha = 0.18;
    for (var k = Math.floor(xLeftM / 12); k <= Math.ceil(xRightM / 12); k++) {
        var wx = k * 12;
        if (sRand(wx + 99) > 0.42) continue;
        var cd = ceilingAt(wx);
        var fd = floorAt(wx);
        if (cd <= 1 || fd - cd < 12) continue;
        var sx = dsx + (wx - diverX) / (mpp * 0.7);
        var y1 = dsy + (cd - depth) / mpp;
        var y2 = dsy + (fd - depth) / mpp;
        if (sx < -120 || sx > W + 120 || y2 < -80 || y1 > H + 80) continue;
        if (sx > W * 0.18 && sx < W * 0.82) continue;
        var w = 12 + sRand(wx + 2) * 18;
        var g = cx.createLinearGradient(sx, y1, sx, y2);
        g.addColorStop(0, 'rgba(6,5,4,0.58)');
        g.addColorStop(0.5, 'rgba(22,20,17,0.36)');
        g.addColorStop(1, 'rgba(5,4,3,0.60)');
        cx.fillStyle = g;
        cx.beginPath();
        cx.moveTo(sx - w * 0.45, y1);
        cx.quadraticCurveTo(sx - w, (y1 + y2) * 0.5, sx - w * 0.35, y2);
        cx.lineTo(sx + w * 0.35, y2);
        cx.quadraticCurveTo(sx + w, (y1 + y2) * 0.5, sx + w * 0.45, y1);
        cx.closePath();
        cx.fill();
        cx.strokeStyle = 'rgba(180,170,140,0.10)';
        cx.lineWidth = 1.2;
        cx.beginPath();
        cx.moveTo(sx - w * 0.12, y1 + 20);
        cx.lineTo(sx - w * 0.28, y2 - 20);
        cx.stroke();
    }
    cx.globalAlpha = 1;
}

// ── Wreck interior backdrop — riveted steel plating + windows ──
// Replaces open-ocean background for the wreck site. Tiles in world space
// (via the camera transform) so the wall scrolls with the diver.
function drawWreckBackdrop(cx, W, H, dsx, dsy, mpp) {
    // Base dark steel gradient
    //
    // Issue #124: tried rusting this (#563e2c / #362a1f / #1f1913 at matched
    // luminance) on the theory that the wreck interior read grey because its
    // steel was grey. It measured WORSE — per-pixel chroma fell from 26.1 to
    // 25.1 on the vehicle deck and 14.1 to 13.1 in the engine room. The scene
    // is blue-dominant from the depth tint, so warming a large surface pulls it
    // toward neutral rather than away. Reverted; the wreck's lever is elsewhere.
    var g = cx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#3b424a'); g.addColorStop(0.5, '#2a3036'); g.addColorStop(1, '#171b1f');
    cx.fillStyle = g;
    cx.fillRect(0, 0, W, H);

    // Issue #41: steel plate texture over the whole backdrop, world-anchored.
    // The caller (drawWreckSteelBack / drawWreckHullSkin) has already clipped
    // to the ship silhouette, so this lands only inside the hull outline.
    if (_matTiles) fillWithMaterialPattern(cx, _matTiles.steel, diverX, depth, false);

    // ── Depth-layered hull livery ──────────────────────────────────────────
    // The wreck's hull reads as distinct bands split at the old waterline /
    // main-deck line ("bowline", ≈28 m): cooler bare topside steel ABOVE it,
    // a dark boot-top stripe ON it, and rust-red antifouling + marine growth
    // BELOW it that deepens toward the keel.
    var bootD = 28;
    var yOf = function (d) { return dsy + (d - depth) / mpp; };
    var bootY = yOf(bootD);
    // topside band (above the line): faint cool sheen
    var topG = cx.createLinearGradient(0, yOf(bootD - 20), 0, bootY);
    topG.addColorStop(0, 'rgba(126,146,156,0.16)');
    topG.addColorStop(1, 'rgba(126,146,156,0)');
    cx.fillStyle = topG;
    cx.fillRect(0, 0, W, Math.max(0, Math.min(bootY, H)));
    // antifouling band (below the line): rust-red fading into shadow
    var antiBot = yOf(bootD + 32);
    var aG = cx.createLinearGradient(0, bootY, 0, antiBot);
    aG.addColorStop(0,    'rgba(104,46,32,0.34)');   // boot-top edge
    aG.addColorStop(0.4,  'rgba(78,38,28,0.22)');
    aG.addColorStop(1,    'rgba(34,20,16,0.06)');
    cx.fillStyle = aG;
    cx.fillRect(0, bootY, W, Math.max(0, antiBot - bootY));
    // dark boot-top stripe sitting on the line
    cx.fillStyle = 'rgba(18,12,10,0.55)';
    cx.fillRect(0, bootY - 2, W, 4.5);

    var panelW = 6, panelH = 4;  // metres per steel plate
    var xLeftM  = diverX + (0 - dsx) * mpp;
    var xRightM = diverX + (W - dsx) * mpp;
    var dTopM   = depth + (0 - dsy) * mpp;
    var dBotM   = depth + (H - dsy) * mpp;
    var c0 = Math.floor(xLeftM / panelW), c1 = Math.ceil(xRightM / panelW);
    var r0 = Math.floor(dTopM / panelH), r1 = Math.ceil(dBotM / panelH);

    // Plate shading (alternating subtle tone per panel) + windows
    for (var c = c0; c <= c1; c++) {
        for (var r = r0; r <= r1; r++) {
            var px = dsx + (c * panelW - diverX) / mpp;
            var py = dsy + (r * panelH - depth) / mpp;
            var pw = panelW / mpp, ph = panelH / mpp;
            // faint per-plate tone variation
            if (((c + r) & 1) === 0) {
                cx.fillStyle = 'rgba(255,255,255,0.018)';
                cx.fillRect(px, py, pw, ph);
            }
            // sparse windows / portholes letting dim outside light in
            var wseed = ((c * 73 + r * 149) % 100 + 100) % 100;
            if (wseed < 12) {
                var wx = px + pw * 0.5, wy = py + ph * 0.5;
                var wr = Math.min(pw, ph) * 0.28;
                var wg = cx.createRadialGradient(wx, wy, 1, wx, wy, wr * 1.4);
                wg.addColorStop(0, 'rgba(120,190,200,0.55)');
                wg.addColorStop(1, 'rgba(120,190,200,0)');
                cx.fillStyle = wg;
                cx.beginPath(); cx.arc(wx, wy, wr * 1.4, 0, Math.PI * 2); cx.fill();
                cx.fillStyle = 'rgba(70,120,135,0.5)';
                cx.beginPath(); cx.arc(wx, wy, wr, 0, Math.PI * 2); cx.fill();
                cx.strokeStyle = 'rgba(150,170,180,0.4)'; cx.lineWidth = 2;
                cx.beginPath(); cx.arc(wx, wy, wr, 0, Math.PI * 2); cx.stroke();
            }
        }
    }

    // Plate seams (vertical + horizontal) with rivets at intersections
    cx.strokeStyle = 'rgba(0,0,0,0.30)'; cx.lineWidth = 1.5;
    for (var cv = c0; cv <= c1; cv++) {
        var sx = dsx + (cv * panelW - diverX) / mpp;
        cx.beginPath(); cx.moveTo(sx, 0); cx.lineTo(sx, H); cx.stroke();
    }
    for (var rh = r0; rh <= r1; rh++) {
        var sy = dsy + (rh * panelH - depth) / mpp;
        cx.beginPath(); cx.moveTo(0, sy); cx.lineTo(W, sy); cx.stroke();
    }
    cx.fillStyle = 'rgba(180,190,200,0.22)';
    for (var cc = c0; cc <= c1; cc++) {
        for (var rr = r0; rr <= r1; rr++) {
            var ix = dsx + (cc * panelW - diverX) / mpp;
            var iy = dsy + (rr * panelH - depth) / mpp;
            cx.beginPath(); cx.arc(ix, iy, 1.5, 0, Math.PI * 2); cx.fill();
        }
    }

    // Marine growth clinging to the lower hull (below the boot-top line) —
    // olive/rust tufts seeded per plate cell so they stay put while scrolling.
    for (var gc = c0; gc <= c1; gc++) {
        for (var gr = r0; gr <= r1; gr++) {
            if (gr * panelH < bootD) continue;          // only below the line
            var gsd = ((gc * 131 + gr * 197) % 100 + 100) % 100;
            if (gsd >= 24) continue;
            var gx = dsx + (gc * panelW - diverX) / mpp + (gsd % 5) * (panelW / mpp / 6);
            var gy = dsy + (gr * panelH - depth) / mpp + (gsd % 4) * (panelH / mpp / 5);
            cx.fillStyle = gsd < 12 ? 'rgba(58,86,48,0.45)' : 'rgba(96,82,42,0.40)';
            cx.beginPath(); cx.arc(gx, gy, 1.6 + (gsd % 3), 0, Math.PI * 2); cx.fill();
        }
    }
}

// ── Issue #33: Ferry-like ship silhouette ──────────────────────────
// The wreck silhouette is a clip mask used by drawWreckSteelBack (paints
// steel behind the interior so gaps read as metal, not open ocean) and
// drawWreckHullSkin (paints an opaque steel skin OVER the interior that
// only opens up a diver-centred line-of-sight bubble). It is PURELY
// COSMETIC — it never affects collision (src/sites.js `structures`), deck
// heights, penetration openings, `solidAt()` / `overheadAt()`, or entry
// markers. See TC-33-COLLISION-UNCHANGED for the regression net.
//
// Old shape was a union of three axis-aligned rectangles [hull body,
// accommodation block, bridge]. Reads as a stack of boxes. Reshaped
// into a single closed polygon that traces a Ro-Ro ferry outline:
//   • raked-forward bow stem (angled forefoot, not a flat vertical edge)
//   • subtle sheer + a small stern-top shoulder (fewer 90° outer corners)
//   • existing superstructure blocks (accommodation, bridge) still
//     reflected in the silhouette with their outer corners preserved.
// The polygon is a strict SUPERSET of the old three-rectangle union
// (every point that used to be inside the union is still inside the
// polygon; the polygon only ADDS area outside collision-solid regions
// — bow rake, stern shoulder). This "add-only" property is the guard
// that keeps drawWreckHullSkin from opening an apparent gap over any
// collision-solid point. Enforced by TC-33-SILHOUETTE-SUPERSET.

// Kept for backward compat and TC-33-SILHOUETTE-SUPERSET's floor: the
// three rectangles are still the guaranteed minimum coverage.
function _wreckSilhouetteRects() {
    return [
        [14, 170, 28, 66],   // multi-deck hull body (main deck → keel)
        [40, 140, 22, 28],   // accommodation block
        [70, 110, 18, 22]    // bridge / wheelhouse
    ];
}

// Ferry outline in world space, traced clockwise (canvas y-down). Every
// vertex here EITHER coincides with an old-union outer corner (must
// stay to preserve collision coverage) OR sits OUTSIDE the old union
// in an area that had no collision solid (the bow-rake triangle and
// the stern-top shoulder — see comment above).
function _wreckSilhouettePolygon() {
    return [
        // ── Bridge / wheelhouse top (unchanged outer corners) ──
        [70,  18], [110, 18],
        // Down bridge right wall
        [110, 22],
        // ── Accommodation top-right (unchanged outer corner) ──
        [140, 22],
        // Down accommodation right wall
        [140, 28],
        // ── Hull top-right sheer (adds a small stern-top shoulder,
        //    entirely outside the old union — no collision underneath) ──
        [172, 28],
        [172, 32],
        [170, 34],
        // Stern side down (unchanged x=170 collision preserved)
        [170, 66],
        // ── Keel run (unchanged) ──
        [14,  66],
        // ── Raked-forward bow stem: forefoot bulges forward of x=14 as
        //    it approaches the keel, then the stem rakes back UP toward
        //    a top-forward point at (12, 28). This entire triangle lies
        //    left of the collision bow stem (x=14..16) — pure addition. ──
        [10,  60],
        [10,  34],
        [12,  28],
        // ── Hull top-left back to accommodation (unchanged) ──
        [40,  28],
        // Up accommodation left wall
        [40,  22],
        // Accommodation top-left (unchanged outer corner)
        [70,  22]
        // implicit close back to [70, 18]
    ];
}

function _buildWreckSilhouette(cx, dsx, dsy, mpp) {
    var poly = _wreckSilhouettePolygon();
    cx.beginPath();
    for (var i = 0; i < poly.length; i++) {
        var sx = dsx + (poly[i][0] - diverX) / mpp;
        var sy = dsy + (poly[i][1] - depth) / mpp;
        if (i === 0) cx.moveTo(sx, sy);
        else cx.lineTo(sx, sy);
    }
    cx.closePath();
}

// Steel hull painted BEHIND the interior objects so gaps read as metal, not
// open ocean. Clipped to the ship silhouette → ocean stays everywhere else.
function drawWreckSteelBack() {
    var s = activeSite();
    if (!s || s.id !== 'wreck') return;
    var W = cssWidth, H = cssHeight, cx = ctx;
    var dsx = W * DIVER_SCREEN_X_FRACTION, dsy = H * 0.45, mpp = 0.05;
    cx.save();
    _buildWreckSilhouette(cx, dsx, dsy, mpp);
    cx.clip();
    drawWreckBackdrop(cx, W, H, dsx, dsy, mpp);
    cx.restore();
}

// Cached overlay for the wreck hull skin. Steel is drawn into this transparent
// layer and the line-of-sight hole is punched there before compositing it over
// the already-rendered interior. This preserves the interior without copying
// the main canvas into an offscreen restore buffer.
var _wreckHoleOverlayCanvas = null, _wreckHoleOverlayCtx = null;

function _ensureWreckHoleBuffers(W, H) {
    if (_wreckHoleOverlayCanvas && _wreckHoleOverlayCanvas.width === W && _wreckHoleOverlayCanvas.height === H) return;
    _wreckHoleOverlayCanvas = document.createElement('canvas');
    _wreckHoleOverlayCanvas.width = W; _wreckHoleOverlayCanvas.height = H;
    _wreckHoleOverlayCtx = _wreckHoleOverlayCanvas.getContext('2d');
}

// Opaque steel hull skin painted OVER the interior (so you cannot see inside
// from open water). While the diver is inside (overhead), a round line-of-sight
// hole in the skin lets only the nearby interior show through — beyond it the
// hull is solid steel, so navigation is limited in every direction. The hole
// grows in as the diver enters (eased via _wreckMetal) and is bigger with the
// torch on.
function drawWreckHullSkin() {
    // No-op outside the live dive scene — see drawSiltAndTorch note above.
    if (gameState !== 'diving') return;
    var s = activeSite();
    if (!s || s.id !== 'wreck') return;
    var W = cssWidth, H = cssHeight, cx = ctx;
    var dsx = W * DIVER_SCREEN_X_FRACTION, dsy = H * 0.45, mpp = 0.05;
    var rad = (torchOn ? 165 : 100) * Math.max(0.55, visibility) * _wreckMetal;
    var haveTorchLight = !!torchOn && rad > 1;
    // With torch OFF the plain circular bubble is the only line of sight.
    // With torch ON the near-field shrinks to a weak spill AND the cone
    // reach is stretched well past the plain-circle radius, so the beam's
    // directionality is unmistakable inside the murky steel interior.
    // Preserves torch-off behaviour exactly.
    var nearR = haveTorchLight ? rad * TORCH_NEAR_FIELD_FRACTION : rad;
    var coneR = haveTorchLight ? rad * 1.75 : 0;
    // Hidden test iframes can expose a zero-sized viewport; in that case the
    // direct no-hole path avoids allocating an unusable overlay.
    var canRestoreHole = rad > 1 && W > 0 && H > 0;
    var beamAngle = torchBeamAngle(_diverFacing);
    var halfA = TORCH_BEAM_HALF_ANGLE_RAD;
    var holeLeft = 0, holeTop = 0, holeRight = W, holeBottom = H;
    var holeW = W, holeH = H;

    // Skin pass: fill the silhouette with steel, then destination-out
    // punch the near-field circle and (if torch on) the directional cone
    // wedge. destination-out avoids the fill-rule overlap trap that a
    // single evenodd path would hit where circle and wedge intersect.
    if (canRestoreHole) {
        // Bound the overlay to the union of the near-field circle and the
        // directional cone. Cardinal angles are included when they fall
        // inside the cone so the bounding box contains its true extrema.
        var holeExtent = nearR + 2;
        var holeMinX = dsx - holeExtent, holeMaxX = dsx + holeExtent;
        var holeMinY = dsy - holeExtent, holeMaxY = dsy + holeExtent;
        if (haveTorchLight) {
            var coneExtent = coneR * 1.05 + 2;
            var boundAngles = [beamAngle - halfA, beamAngle + halfA, beamAngle];
            var cardinalAngles = [0, Math.PI / 2, Math.PI, Math.PI * 1.5];
            for (var bai = 0; bai < cardinalAngles.length; bai++) {
                var angleDelta = Math.atan2(
                    Math.sin(cardinalAngles[bai] - beamAngle),
                    Math.cos(cardinalAngles[bai] - beamAngle)
                );
                if (Math.abs(angleDelta) <= halfA) boundAngles.push(cardinalAngles[bai]);
            }
            for (bai = 0; bai < boundAngles.length; bai++) {
                var boundX = dsx + Math.cos(boundAngles[bai]) * coneExtent;
                var boundY = dsy + Math.sin(boundAngles[bai]) * coneExtent;
                holeMinX = Math.min(holeMinX, boundX);
                holeMaxX = Math.max(holeMaxX, boundX);
                holeMinY = Math.min(holeMinY, boundY);
                holeMaxY = Math.max(holeMaxY, boundY);
            }
        }
        holeLeft = Math.max(0, Math.floor(holeMinX));
        holeTop = Math.max(0, Math.floor(holeMinY));
        holeRight = Math.min(W, Math.ceil(holeMaxX));
        holeBottom = Math.min(H, Math.ceil(holeMaxY));
        holeW = Math.max(1, holeRight - holeLeft);
        holeH = Math.max(1, holeBottom - holeTop);
        // Keep allocation capacity stable while _wreckMetal eases toward 1;
        // resizing to each one-pixel bounds change creates periodic stalls.
        // Only the bounded source rectangle is cleared and blitted below.
        _ensureWreckHoleBuffers(W, H);
        _wreckHoleOverlayCtx.clearRect(0, 0, holeW, holeH);

        // Paint the opaque part of the hull directly, excluding only the
        // small rectangle that needs a soft transparency gradient.
        cx.save();
        _buildWreckSilhouette(cx, dsx, dsy, mpp);
        cx.clip();
        cx.beginPath();
        cx.rect(0, 0, W, H);
        cx.rect(holeLeft, holeTop, holeW, holeH);
        cx.clip('evenodd');
        drawWreckBackdrop(cx, W, H, dsx, dsy, mpp);
        cx.restore();
    }

    var skinCx = canRestoreHole ? _wreckHoleOverlayCtx : cx;
    var _wreckOverlayStarted = _renderDiag().start();
    skinCx.save();
    if (canRestoreHole) skinCx.translate(-holeLeft, -holeTop);
    _buildWreckSilhouette(skinCx, dsx, dsy, mpp);
    skinCx.clip();                                   // restrict to the ship
    drawWreckBackdrop(skinCx, W, H, dsx, dsy, mpp);  // paint steel
    if (rad > 1) {
        skinCx.globalCompositeOperation = 'destination-out';
        // Near-field spill — always present when the diver is inside.
        var spill = skinCx.createRadialGradient(dsx, dsy, 0, dsx, dsy, nearR);
        spill.addColorStop(0,   'rgba(0,0,0,1)');
        spill.addColorStop(0.7, 'rgba(0,0,0,0.88)');
        spill.addColorStop(1,   'rgba(0,0,0,0)');
        skinCx.fillStyle = spill;
        skinCx.fillRect(0, 0, W, H);
        // Directional cone — only when torch is on.
        if (haveTorchLight) {
            skinCx.save();
            skinCx.beginPath();
            skinCx.moveTo(dsx, dsy);
            skinCx.arc(dsx, dsy, coneR * 1.05, beamAngle - halfA, beamAngle + halfA);
            skinCx.closePath();
            skinCx.clip();
            var beam = skinCx.createRadialGradient(dsx, dsy, 0, dsx, dsy, coneR);
            // Strong alpha kept high across most of the cone so the beam
            // reads unmistakably against the steel-on-steel interior
            // (where a soft gradient would fade into the surrounding
            // hull tone and read as a slightly-offset circle).
            beam.addColorStop(0,    'rgba(0,0,0,1)');
            beam.addColorStop(0.55, 'rgba(0,0,0,0.95)');
            beam.addColorStop(0.85, 'rgba(0,0,0,0.65)');
            beam.addColorStop(1,    'rgba(0,0,0,0)');
            skinCx.fillStyle = beam;
            skinCx.fillRect(0, 0, W, H);
            skinCx.restore();
        }
        skinCx.globalCompositeOperation = 'source-over';
    }
    skinCx.restore();
    _renderDiag().record('renderWreckOverlayBuild', _wreckOverlayStarted);

    // Composite the transparent steel overlay over the preserved interior.
    if (canRestoreHole) {
        _wreckOverlayStarted = _renderDiag().start();
        cx.drawImage(
            _wreckHoleOverlayCanvas,
            0, 0, holeW, holeH,
            holeLeft, holeTop, holeW, holeH
        );
        _renderDiag().record('renderWreckOverlayBlit', _wreckOverlayStarted);
    }

    // Feather the rim of the near-field circle so the always-visible spill
    // blends into steel instead of a hard disc. The cone's radial-gradient
    // falloff already softens its own edges, so no separate feather there.
    if (rad > 1) {
        cx.save();
        _buildWreckSilhouette(cx, dsx, dsy, mpp);
        cx.clip();
        var ring = cx.createRadialGradient(dsx, dsy, nearR * 0.72, dsx, dsy, nearR * 1.16);
        ring.addColorStop(0, 'rgba(28,33,38,0)');
        ring.addColorStop(1, 'rgba(28,33,38,' + (0.9 * _wreckMetal).toFixed(3) + ')');
        cx.fillStyle = ring;
        cx.fillRect(0, 0, W, H);
        cx.restore();
    }

    // Volumetric glow + backscatter for the wreck interior — currently
    // missing (drawSiltAndTorch early-returns for wreck). Runs only when
    // the torch actually illuminates the cone.
    if (haveTorchLight) {
        drawTorchGlowAndSparkles(cx, W, H, dsx, dsy, coneR, beamAngle, halfA);
    }
}

// The three deliberate penetrations into the hull, marked so a diver can spot
// them from OUTSIDE (the opaque hull skin otherwise hides every opening). Each
// gets a dark recessed mouth, a pulsing cyan glow, a down-pointing chevron and
// a label. They fade out as the diver enters (1 − _wreckMetal) since the hull
// skin's line-of-sight bubble takes over for navigation once inside.
function drawWreckEntryMarkers() {
    var s = activeSite();
    if (!s || s.id !== 'wreck') return;
    var vis = 1 - _wreckMetal;
    if (vis < 0.05) return;
    var W = cssWidth, H = cssHeight, cx = ctx;
    var dsx = W * DIVER_SCREEN_X_FRACTION, dsy = H * 0.45, mpp = 0.05;
    var deckD = 27.5;                       // main-deck line (top of the openings)
    var entries = [
        { x1: 16,  x2: 22,  label: 'BOW' },
        { x1: 78,  x2: 92,  label: 'HATCH' },
        { x1: 148, x2: 168, label: 'STERN' }
    ];
    var pulse = 0.5 + 0.5 * Math.sin(waveTime * 1.6);
    cx.save();
    cx.globalAlpha = vis * 0.62;            // understated overall
    cx.textAlign = 'center';
    for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        var cxm = dsx + ((e.x1 + e.x2) / 2 - diverX) / mpp;
        var ow = (e.x2 - e.x1) / mpp;       // opening width in px
        var oy = dsy + (deckD - depth) / mpp;
        if (cxm < -ow || cxm > W + ow) continue;
        var halfW = ow / 2;
        // faint glow halo hinting at the opening
        var glow = cx.createRadialGradient(cxm, oy, 2, cxm, oy, halfW + 14);
        glow.addColorStop(0, 'rgba(120,205,220,' + (0.12 + 0.07 * pulse).toFixed(3) + ')');
        glow.addColorStop(1, 'rgba(120,205,220,0)');
        cx.fillStyle = glow;
        cx.fillRect(cxm - halfW - 18, oy - 22, ow + 36, 48);
        // thin rim outlining the dark mouth (no opaque fill — keep it subtle)
        cx.strokeStyle = 'rgba(140,215,225,' + (0.34 + 0.14 * pulse).toFixed(3) + ')';
        cx.lineWidth = 1.2;
        cx.beginPath();
        cx.roundRect(cxm - halfW, oy - 2, ow, 12, 3);
        cx.stroke();
        // small down-pointing chevron above the opening
        cx.strokeStyle = 'rgba(150,220,230,' + (0.34 + 0.16 * pulse).toFixed(3) + ')';
        cx.lineWidth = 1.5;
        cx.lineCap = 'round'; cx.lineJoin = 'round';
        var chevW = 6, chevY = oy - 12 - pulse * 1.5;
        cx.beginPath();
        cx.moveTo(cxm - chevW, chevY);
        cx.lineTo(cxm, chevY + 5);
        cx.lineTo(cxm + chevW, chevY);
        cx.stroke();
        // small label
        cx.fillStyle = 'rgba(175,220,228,0.6)';
        cx.font = '7px "Barlow Semi Condensed", monospace';
        cx.fillText('ENTRY', cxm, oy - 18);
    }
    cx.textAlign = 'left';
    cx.restore();
}

// ── Task 7: Rock — organic overlapping boulders (stable world seed) ──
// tone: optional palette override.
//   'reef'     — warm coralline cliff face
//   'caveGrey' — cool grey limestone (deep cave)
//   'caveBrown'— warm tan limestone (cave entrance)
//   'shore'    — mottled grey-tan beach boulder
// Boulders get a rounded multi-lobe crown, a soft top rim-light, internal
// shading lumps, cracks, and a contact-shadow skirt so they read as sitting
// IN the seabed rather than floating on it.
var ROCK_PALETTES = {
    reef:      ['#7a4a32', '#5a3623', '#3a2415'],
    caveGrey:  ['#787770', '#4c4b45', '#23221d'],
    caveBrown: ['#6e5d44', '#4a3a28', '#241a10'],
    shore:     ['#6a6256', '#494238', '#221e18'],
    'default': ['#5b4d40', '#3d3228', '#1e1a16']
};
// Issue #101 — bound the rounded-boulder dome sink so the visual silhouette
// closely fills the AABB collision box at the top corners. Values are in
// canvas pixels; at the game's mpp=0.05 (20 px/m), ROCK_DOME_MAX_PX=30 caps
// the shoulder sag at 1.5 m below the AABB top for any rock size, keeping
// a subtle rounded crown without leaving phantom "collide in mid-air"
// gaps in the top corners. The two fractional caps (SH_FRAC/SW_FRAC) keep
// small boulders proportionally rounder than large ones — a 2 m-wide rock
// still domes gently rather than reading as a rectangle.
var ROCK_DOME_MAX_PX  = 30;
var ROCK_DOME_SH_FRAC = 0.15;
var ROCK_DOME_SW_FRAC = 0.10;
// Boulders are static vector art that only TRANSLATES as the camera pans, but
// re-rasterising their fine detail (cracks, speckle, rim) every frame makes the
// thin 1px features shimmer/crawl under sub-pixel motion — worst on the widest
// rocks because they carry the most detail (more lobes, cracks and lumps), which
// reads as the rock "jittering". Fix: rasterise each boulder to an offscreen
// canvas ONCE (keyed by size + seed + tone) and blit it thereafter. The blit
// interpolates smoothly at sub-pixel positions, so the detail no longer shimmers
// (and it's far cheaper per frame). Size/seed are constant per rock, so each rock
// occupies exactly one cache entry that is reused every frame.
var _rockCache = {};
function drawRockStruct(cx, sx1, sy1, sw, sh, seed, tone) {
    var w = Math.max(1, Math.round(sw));
    var h = Math.max(1, Math.round(sh));
    var padX = Math.ceil(w * 0.13) + 16;   // covers the contact-shadow ellipse + overhang
    var padT = 18, padB = 18;              // crown rim above, shadow below
    var key = (tone || 'default') + '|' + w + '|' + h + '|' + seed.toFixed(2);
    var entry = _rockCache[key];
    if (!entry) {
        var oc = document.createElement('canvas');
        oc.width = w + padX * 2;
        oc.height = h + padT + padB;
        _paintRockStruct(oc.getContext('2d'), padX, padT, w, h, seed, tone);
        entry = _rockCache[key] = { canvas: oc, padX: padX, padT: padT };
    }
    cx.drawImage(entry.canvas, sx1 - entry.padX, sy1 - entry.padT);
}

function _paintRockStruct(cx, sx1, sy1, sw, sh, seed, tone) {
    cx.save();
    // Lobed organic silhouette: the top edge is only mildly irregular — the dip
    // is a small bounded amount (NOT a fraction of height) so tall reef columns
    // still fill their footprint instead of leaving big empty gaps.
    // Rounder boulders everywhere EXCEPT reef cliff faces: the top is a smooth
    // dome (apex at the box top, shoulders sinking toward the sides) with only
    // gentle bumps, so each rock reads as a water-worn round boulder. Reef
    // walls keep the old near-flat cliff profile. The dome apex stays at the
    // box top (never bulges past the collision AABB).
    //
    // Issue #101 — the previous dome (`min(sh*0.5, sw*0.4)` px) sank the top
    // corners of a typical shore boulder by 4-6 m below the AABB top, which
    // left large chunks of the collision box floating in what looked like
    // open water. A diver approaching over the shoulder read a phantom
    // "collide in mid-air" hit. ROCK_DOME_MAX_PX bounds the sink so the
    // silhouette closely fills the AABB at the top-corners (max ≈ 1.5 m of
    // shoulder sag at any rock size at 1 m/20 px) while keeping a subtle
    // rounded crown.
    var rounded = (tone !== 'reef');
    var lobes = Math.max(rounded ? 6 : 3, Math.round(sw / (rounded ? 16 : 26)));
    var jitter = rounded ? Math.min(sw * 0.05, sh * 0.12, 7)
                         : Math.min(sh * 0.3, sw * 0.45, 20);
    if (tone === 'reef') jitter = Math.min(jitter, 5);
    var dome = rounded ? Math.min(sh * ROCK_DOME_SH_FRAC,
                                  sw * ROCK_DOME_SW_FRAC,
                                  ROCK_DOME_MAX_PX)
                       : 0;
    var crown = rounded ? Math.min(dome * 0.18, 6) : Math.min(jitter * 0.7, 12);
    var top = [];
    for (var i = 0; i <= lobes; i++) {
        var t = i / lobes;
        var px = sx1 + sw * t;
        // dome shoulders: 0 px at the centre, `dome` px lower at each edge
        var shoulder = dome * (1 - Math.sin(Math.PI * t));
        var bump = sRand(seed + i * 4.1) * jitter;
        top.push([px, sy1 + shoulder + bump]);
    }
    function traceTop() {
        cx.moveTo(sx1 - sw * 0.04, sy1 + sh);      // bottom-left (slight overhang)
        cx.lineTo(top[0][0], top[0][1]);
        for (var j = 1; j < top.length; j++) {
            var mx = (top[j - 1][0] + top[j][0]) / 2;
            var my = Math.min(top[j - 1][1], top[j][1]) - crown;
            cx.quadraticCurveTo(mx, my, top[j][0], top[j][1]);   // rounded crowns
        }
        cx.lineTo(sx1 + sw * 1.04, sy1 + sh);      // bottom-right
        cx.closePath();
    }

    // Contact-shadow skirt: a soft dark ellipse where the boulder meets the
    // seabed, so it looks grounded (drawn before the body, outside the clip).
    cx.fillStyle = 'rgba(0,0,0,0.22)';
    cx.beginPath();
    cx.ellipse(sx1 + sw / 2, sy1 + sh, sw * 0.62, Math.min(10, sh * 0.18), 0, 0, Math.PI * 2);
    cx.fill();

    cx.beginPath();
    traceTop();
    var pal = ROCK_PALETTES[tone] || ROCK_PALETTES['default'];
    var rg = cx.createLinearGradient(sx1, sy1, sx1, sy1 + sh);
    rg.addColorStop(0, pal[0]); rg.addColorStop(0.5, pal[1]); rg.addColorStop(1, pal[2]);
    cx.fillStyle = rg;
    cx.fill();
    if (tone === 'reef') {
        cx.strokeStyle = '#a87355'; cx.lineWidth = 2;
        cx.stroke();
    }

    // Clip to the boulder body and stipple shading lumps + cracks.
    cx.save();
    cx.clip();
    var lumps = Math.max(2, Math.round(sw * sh / 4200));
    for (var l = 0; l < lumps; l++) {
        var lx = sx1 + sRand(seed + l * 9.7) * sw;
        var ly = sy1 + (0.2 + sRand(seed + l * 5.1) * 0.8) * sh;
        var lr = (6 + sRand(seed + l * 3.3) * 14);
        var shade = sRand(seed + l * 7.9);
        cx.fillStyle = shade > 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.16)';
        cx.beginPath(); cx.arc(lx, ly, lr, 0, Math.PI * 2); cx.fill();
    }
    // A couple of cracks
    cx.strokeStyle = 'rgba(0,0,0,0.30)'; cx.lineWidth = 1;
    var nc = Math.max(1, Math.floor(sw / 45));
    for (var c = 1; c <= nc; c++) {
        var crx = sx1 + sw * (c / (nc + 1)) + (sRand(seed + c * 5.3) - 0.5) * 14;
        cx.beginPath();
        cx.moveTo(crx, sy1 + sh * (0.1 + sRand(seed + c * 7.1) * 0.2));
        cx.quadraticCurveTo(crx + (sRand(seed + c * 9.3) - 0.5) * 14, sy1 + sh * 0.55,
                            crx + (sRand(seed + c * 2.7) - 0.5) * 10, sy1 + sh * 0.92);
        cx.stroke();
    }
    cx.restore();

    // Soft rim light along the lit crown (re-trace, stroke only the top arc).
    cx.save();
    cx.beginPath();
    cx.moveTo(top[0][0], top[0][1]);
    for (var k = 1; k < top.length; k++) {
        var mx2 = (top[k - 1][0] + top[k][0]) / 2;
        var my2 = Math.min(top[k - 1][1], top[k][1]) - crown;
        cx.quadraticCurveTo(mx2, my2, top[k][0], top[k][1]);
    }
    cx.strokeStyle = tone === 'caveGrey' ? 'rgba(190,192,188,0.28)'
                   : tone === 'reef'     ? 'rgba(190,140,110,0.0)'   // reef has its own stroke
                                         : 'rgba(200,186,150,0.22)';
    cx.lineWidth = 1.6;
    cx.stroke();
    cx.restore();

    cx.restore();
}

// ── Cave bedrock partition — a solid limestone mass (NOT boulders) used to
//    genuinely separate the upper tunnel from the deep cathedral. Filled with
//    the same depth-graded limestone gradient as the floor/ceiling so it tiles
//    seamlessly with the surrounding walls; strata + speckle are world-anchored
//    so they don't shimmer while the camera scrolls. ──
function drawBedrockStruct(cx, wx1, wx2, wdTop, wdBottom, accum) {
    var W = cssWidth, H = cssHeight;
    var dsx = W * DIVER_SCREEN_X_FRACTION, dsy = H * 0.45, mpp = 0.05;
    var sy1 = dsy + (wdTop - depth) / mpp, sy2 = dsy + (wdBottom - depth) / mpp;
    var sx1 = dsx + (wx1 - diverX) / mpp, sx2 = dsx + (wx2 - diverX) / mpp;
    if (sx2 < -60 || sx1 > W + 60 || sy2 < -60 || sy1 > H + 60) return;
    var surfY = dsy - depth / mpp;
    function SX(wx) { return dsx + (wx - diverX) / mpp; }
    function SY(wd) { return dsy + (wd - depth) / mpp; }
    // smooth world-anchored 1D noise (stable while scrolling)
    function nz(a) { return Math.sin(a * 0.7) * 0.6 + Math.sin(a * 1.9 + 2.1) * 0.3 + Math.sin(a * 3.3 + 4.7) * 0.1; }

    // Build organic top + bottom edges so the mass reads as natural rock rather
    // than a box: a gently rolling upper surface (the upper-tunnel floor) and a
    // lumpy cathedral ceiling. Both hug the collision AABB to within ~2 m.
    var step = 1.5, topPts = [], botPts = [];
    for (var wx = wx1; wx <= wx2 + 0.01; wx += step) {
        topPts.push([SX(wx), SY(wdTop + 1.1 + nz(wx * 1.0) * 1.4)]);
        botPts.push([SX(wx), SY(wdBottom + 0.4 + nz(wx * 0.9 + 31.0) * 2.0)]);
    }

    cx.save();
    // closed organic outline (top L→R, down the right face, bottom R→L)
    cx.beginPath();
    cx.moveTo(topPts[0][0], topPts[0][1]);
    for (var i = 1; i < topPts.length; i++) cx.lineTo(topPts[i][0], topPts[i][1]);
    for (var j = botPts.length - 1; j >= 0; j--) cx.lineTo(botPts[j][0], botPts[j][1]);
    cx.closePath();

    // depth-graded limestone fill (same stops as the cave floor in drawTerrain)
    var g = cx.createLinearGradient(0, surfY, 0, surfY + 2000);
    g.addColorStop(0,     CAVE_PAL.rockMid);
    g.addColorStop(0.06,  CAVE_PAL.rockWarm);
    g.addColorStop(0.13,  CAVE_PAL.greyBrown);
    g.addColorStop(0.22,  CAVE_PAL.greyMid);
    g.addColorStop(0.40,  CAVE_PAL.greyShade);
    g.addColorStop(1,     CAVE_PAL.greyDark);
    cx.fillStyle = g;
    cx.fill();

    // texture clipped to the organic mass (strata + speckle, world-anchored)
    cx.save();
    cx.clip();
    // Issue #41: limestone material texture inside the bedrock mass.
    // Anchored to the same (diverX, depth) origin as the cave floor/ceiling
    // so the tile is continuous across the shared seam.
    fillWithMaterialPattern(cx, _matTiles.limestone, diverX, depth, false);
    cx.strokeStyle = 'rgba(14,10,6,0.30)'; cx.lineWidth = 1.4;
    for (var wd = Math.ceil(wdTop / 4.5) * 4.5; wd < wdBottom; wd += 4.5) {
        var yy = SY(wd);
        cx.beginPath();
        var first = true;
        for (var bx = wx1; bx <= wx2; bx += 0.6) {
            var wob = Math.sin(bx * 0.4 + wd * 0.5) * 2;
            if (first) { cx.moveTo(SX(bx), yy + wob); first = false; }
            else cx.lineTo(SX(bx), yy + wob);
        }
        cx.stroke();
    }
    var stepM = 1.2;
    for (var swx = Math.floor(wx1 / stepM) * stepM; swx <= wx2; swx += stepM) {
        for (var swd = Math.floor(wdTop); swd < wdBottom; swd += 1.2) {
            var sd = swx * 31.7 + swd * 7.3;
            if (sRand(sd) >= 0.4) continue;
            var spx = SX(swx) + (sRand(sd + 1) - 0.5) * 16;
            var spy = SY(swd) + (sRand(sd + 2) - 0.5) * 16;
            var spr = 0.6 + sRand(sd + 3) * 1.4;
            cx.fillStyle = sRand(sd + 4) > 0.5 ? 'rgba(14,12,8,0.5)' : 'rgba(150,148,140,0.26)';
            cx.beginPath(); cx.arc(spx, spy, spr, 0, Math.PI * 2); cx.fill();
        }
    }
    cx.restore();

    // Issue #56: sediment on the rolling top surface + material accumulation
    // along the same edge. Both operate on topPts which is already in
    // screen-space coordinates. Gated on accum being passed by the caller
    // (drawStructures always passes it; any legacy caller that omits it is safe).
    if (accum) {
        drawSedimentCap(cx, topPts, {
            intensity: accum.sediment,
            thicknessM: 0.30,
            mpp: 0.05,
            worldSeed: wx1 * 11.7 + ACCUM_SEED.sediment
        });
        drawContactAccumulation(cx, topPts, {
            intensity: accum.contactDebris,
            mpp: 0.05,
            worldSeed: wx1 * 13.3 + ACCUM_SEED.contact,
            side: 'above'
        });
    }

    // lit rim along the rolling top + soft shadow along the lumpy underside
    cx.strokeStyle = 'rgba(156,154,146,0.30)'; cx.lineWidth = 1.6;
    cx.beginPath();
    cx.moveTo(topPts[0][0], topPts[0][1]);
    for (var k = 1; k < topPts.length; k++) cx.lineTo(topPts[k][0], topPts[k][1]);
    cx.stroke();
    cx.strokeStyle = 'rgba(0,0,0,0.28)'; cx.lineWidth = 3;
    cx.beginPath();
    cx.moveTo(botPts[0][0], botPts[0][1]);
    for (var m = 1; m < botPts.length; m++) cx.lineTo(botPts[m][0], botPts[m][1]);
    cx.stroke();

    // a few rock pendants hanging from the cathedral ceiling (drama + detail)
    for (var p = 1; p < botPts.length - 1; p += 3) {
        var pseed = (wx1 * 5.3 + p * 9.7);
        if (sRand(pseed) >= 0.4) continue;
        var bxp = botPts[p][0], byp = botPts[p][1];
        var ph = 10 + sRand(pseed + 1) * 26;
        var pw = 4 + sRand(pseed + 2) * 5;
        cx.fillStyle = g;
        cx.beginPath();
        cx.moveTo(bxp - pw, byp - 2);
        cx.quadraticCurveTo(bxp - pw * 0.35, byp + ph * 0.55, bxp, byp + ph);
        cx.quadraticCurveTo(bxp + pw * 0.35, byp + ph * 0.55, bxp + pw, byp - 2);
        cx.closePath(); cx.fill();
    }
    cx.restore();
}

// ── Shore landmark: an old half-buried admiralty anchor in the sand ──
function drawAnchor(cx, x, yFloor, worldSeed, scale) {
    cx.save();
    var seed = (worldSeed || 0) * 3.7 + 1.3;
    // Lie the anchor back at a jaunty angle, flukes dug into the sand.
    cx.translate(x, yFloor);
    cx.rotate(-0.32 + (sRand(seed) - 0.5) * 0.1);
    var sc = scale || 1.0;
    cx.scale(sc, sc);

    // Contact shadow on the sand
    cx.fillStyle = 'rgba(0,0,0,0.20)';
    cx.beginPath(); cx.ellipse(0, 4, 30, 6, 0, 0, Math.PI * 2); cx.fill();

    // Rusty iron gradient used for all members
    var ironG = cx.createLinearGradient(-4, -46, 6, 6);
    ironG.addColorStop(0, '#5a4332');
    ironG.addColorStop(0.5, '#3d2c20');
    ironG.addColorStop(1, '#241912');
    cx.strokeStyle = ironG;
    cx.fillStyle = ironG;
    cx.lineCap = 'round';
    cx.lineJoin = 'round';

    // Shank (main vertical bar)
    cx.lineWidth = 5;
    cx.beginPath(); cx.moveTo(0, -44); cx.lineTo(0, 4); cx.stroke();
    // Ring at the top
    cx.lineWidth = 3;
    cx.beginPath(); cx.arc(0, -49, 5.5, 0, Math.PI * 2); cx.stroke();
    // Stock (cross-bar near the top)
    cx.lineWidth = 4;
    cx.beginPath(); cx.moveTo(-15, -38); cx.lineTo(15, -34); cx.stroke();
    // Arms sweeping down to the flukes (curved crown at the base)
    cx.lineWidth = 5;
    cx.beginPath();
    cx.moveTo(-18, 6);
    cx.quadraticCurveTo(0, -6, 18, 6);     // crown arc
    cx.stroke();
    // Flukes (arrowhead pads on each arm)
    cx.beginPath();
    cx.moveTo(-18, 6); cx.lineTo(-24, 0); cx.lineTo(-21, 9); cx.closePath(); cx.fill();
    cx.beginPath();
    cx.moveTo(18, 6); cx.lineTo(24, 0); cx.lineTo(21, 9); cx.closePath(); cx.fill();

    // A few rust speckles + algae tuft
    cx.fillStyle = 'rgba(150,70,10,0.25)';
    cx.beginPath(); cx.ellipse(0, -20, 2.4, 5, 0, 0, Math.PI * 2); cx.fill();
    cx.strokeStyle = 'rgba(60,120,60,0.7)'; cx.lineWidth = 1.6;
    for (var a = -1; a <= 1; a++) {
        cx.beginPath();
        cx.moveTo(a * 6, -34);
        cx.quadraticCurveTo(a * 6 + 3, -42, a * 6 - 1, -48);
        cx.stroke();
    }
    cx.restore();
}

// ── Shore: small sunken rowing/sailing boat (no interior) ──
function drawSmallWreck(cx, sx1, sy1, sw, sh) {
    cx.save();
    var cxm = sx1 + sw / 2, by = sy1 + sh;
    // Hull — open shell, tilted slightly, planked
    cx.translate(cxm, by);
    cx.rotate(-0.12);
    var hw = sw * 0.62, hh = sh * 0.85;
    var hg = cx.createLinearGradient(0, -hh, 0, 0);
    hg.addColorStop(0, '#6b5436'); hg.addColorStop(1, '#3a2c1a');
    cx.fillStyle = hg;
    cx.beginPath();
    cx.moveTo(-hw, -hh);                                   // gunwale port (open top)
    cx.quadraticCurveTo(-hw * 1.05, -hh * 0.2, -hw * 0.7, 0);
    cx.quadraticCurveTo(0, hh * 0.5, hw * 0.7, 0);
    cx.quadraticCurveTo(hw * 1.05, -hh * 0.2, hw, -hh);    // gunwale starboard
    cx.quadraticCurveTo(0, -hh * 0.55, -hw, -hh);          // open deck rim
    cx.closePath();
    cx.fill();
    // Plank lines
    cx.strokeStyle = 'rgba(0,0,0,0.3)'; cx.lineWidth = 1;
    for (var p = 1; p <= 3; p++) {
        var yy = -hh + (hh * 0.9) * p / 4;
        cx.beginPath();
        cx.moveTo(-hw * (1 - p * 0.06), yy);
        cx.quadraticCurveTo(0, yy + hh * 0.35, hw * (1 - p * 0.06), yy);
        cx.stroke();
    }
    // Interior shadow (hollow shell)
    cx.fillStyle = 'rgba(0,0,0,0.35)';
    cx.beginPath();
    cx.moveTo(-hw * 0.86, -hh * 0.95);
    cx.quadraticCurveTo(0, -hh * 0.5, hw * 0.86, -hh * 0.95);
    cx.quadraticCurveTo(0, hh * 0.2, -hw * 0.86, -hh * 0.95);
    cx.closePath();
    cx.fill();
    // Broken mast stub leaning out
    cx.strokeStyle = '#4a3a22'; cx.lineWidth = 3; cx.lineCap = 'round';
    cx.beginPath(); cx.moveTo(hw * 0.1, -hh * 0.7); cx.lineTo(hw * 0.55, -hh * 1.9); cx.stroke();
    // Algae tufts on the rim
    cx.strokeStyle = 'rgba(60,120,60,0.7)'; cx.lineWidth = 2;
    for (var a = -2; a <= 2; a++) {
        var ax = a * hw * 0.32;
        cx.beginPath(); cx.moveTo(ax, -hh); cx.quadraticCurveTo(ax + 3, -hh - 8, ax - 2, -hh - 14); cx.stroke();
    }
    cx.restore();
}

// ── Task 8: Hull — steel gradient, rust patches, rivets, drip streaks ──
function drawHullStruct(cx, sx1, sy1, sw, sh, seed, accum) {
    var g = cx.createLinearGradient(sx1, sy1, sx1, sy1 + sh);
    g.addColorStop(0, '#687888'); g.addColorStop(0.5, '#556677'); g.addColorStop(1, '#2e3c48');
    cx.fillStyle = g;
    cx.fillRect(sx1, sy1, sw, sh);
    // Issue #41: steel plate texture. sx1/sy1 already track the world position
    // via the caller in drawStructures(), so anchoring in screen space keeps
    // the pattern glued to the structure as the camera scrolls.
    if (_matTiles) {
        cx.save();
        cx.beginPath(); cx.rect(sx1, sy1, sw, sh); cx.clip();
        fillWithMaterialPattern(cx, _matTiles.steel, sx1, sy1, true);
        cx.restore();
    }
    cx.fillStyle = 'rgba(140,70,20,0.18)';
    var rp = Math.max(2, Math.floor(sw / 30));
    for (var r = 0; r < rp; r++) {
        cx.beginPath();
        cx.ellipse(sx1 + sRand(seed + r * 7.1) * sw, sy1 + sRand(seed + r * 11.3) * sh,
            8 + sRand(seed + r * 3.7) * 24, 4 + sRand(seed + r * 5.1) * 12,
            sRand(seed + r * 13) * Math.PI, 0, Math.PI * 2);
        cx.fill();
    }
    cx.fillStyle = 'rgba(180,200,210,0.3)';
    var rows = Math.max(1, Math.floor(sh / 20));
    for (var row = 1; row <= rows; row++) {
        var ry2 = sy1 + sh * row / (rows + 1);
        for (var rx2 = sx1 + 8; rx2 < sx1 + sw - 4; rx2 += 16) {
            cx.beginPath(); cx.arc(rx2, ry2, 1.5, 0, Math.PI * 2); cx.fill();
        }
    }
    cx.strokeStyle = 'rgba(140,60,10,0.22)'; cx.lineWidth = 1;
    var drips = Math.max(1, Math.floor(sw / 40));
    for (var d = 0; d < drips; d++) {
        var dx = sx1 + 8 + d * (sw - 16) / Math.max(1, drips - 1 || 1);
        var dy = sy1 + sh * 0.2;
        cx.beginPath();
        cx.moveTo(dx, dy);
        cx.lineTo(dx + (sRand(seed + d * 3) - 0.5) * 4, dy + sh * (0.2 + sRand(seed + d * 9) * 0.3));
        cx.stroke();
    }
    cx.strokeStyle = 'rgba(255,255,255,0.07)'; cx.lineWidth = 1;
    cx.strokeRect(sx1, sy1, sw, sh);
    // Issue #56: vertical rust streaks on the hull plating. Exterior hull
    // panels also get a faint biofouling tail; interior panels stay pure rust.
    if (accum) {
        drawVerticalStreaks(cx, { sx: sx1, sy: sy1, sw: sw, sh: sh }, {
            intensity: accum.streaks,
            worldSeed: seed + ACCUM_SEED.streak,
            variant: 'rust',
            exterior: !!accum.exterior
        });
    }
}

// ── Task 8: Deck — plank lines across top face ──────────────────
function drawDeckStruct(cx, sx1, sy1, sw, sh, seed, accum) {
    var g = cx.createLinearGradient(sx1, sy1, sx1, sy1 + sh);
    g.addColorStop(0, '#506070'); g.addColorStop(1, '#2a3845');
    cx.fillStyle = g; cx.fillRect(sx1, sy1, sw, sh);
    // Issue #41: steel plate texture (anchored in screen px — see drawHullStruct).
    if (_matTiles) {
        cx.save();
        cx.beginPath(); cx.rect(sx1, sy1, sw, sh); cx.clip();
        fillWithMaterialPattern(cx, _matTiles.steel, sx1, sy1, true);
        cx.restore();
    }
    cx.strokeStyle = 'rgba(0,0,0,0.3)'; cx.lineWidth = 1;
    var ps = Math.max(6, Math.floor(sh / 4));
    for (var py = sy1 + ps; py < sy1 + sh; py += ps) {
        cx.beginPath(); cx.moveTo(sx1, py); cx.lineTo(sx1 + sw, py); cx.stroke();
    }
    cx.fillStyle = 'rgba(120,60,10,0.12)';
    cx.beginPath();
    cx.ellipse(sx1 + sw * (0.3 + sRand(seed) * 0.4), sy1 + sh * 0.5,
        sw * 0.15 + 10, sh * 0.35, 0, 0, Math.PI * 2);
    cx.fill();
    cx.strokeStyle = 'rgba(255,255,255,0.06)'; cx.lineWidth = 1;
    cx.strokeRect(sx1, sy1, sw, sh);
    // Issue #56: sediment settling on the top face + rust streaks bleeding
    // down the sides — decks are horizontal, so both passes apply.
    if (accum) {
        drawSedimentCap(cx, [[sx1, sy1], [sx1 + sw, sy1]], {
            intensity: accum.sediment,
            thicknessM: 0.30,
            mpp: 0.05,
            worldSeed: seed + ACCUM_SEED.sediment
        });
        drawVerticalStreaks(cx, { sx: sx1, sy: sy1, sw: sw, sh: sh }, {
            intensity: accum.streaks,
            worldSeed: seed + ACCUM_SEED.streak,
            variant: 'rust',
            exterior: false
        });
    }
}

// ── Task 8: Bulkhead — panel frame + portholes on wide sections ──
function drawBulkheadStruct(cx, sx1, sy1, sw, sh, seed, accum, sitsOnFloor) {
    var g = cx.createLinearGradient(sx1, sy1, sx1, sy1 + sh);
    g.addColorStop(0, '#5a6878'); g.addColorStop(1, '#2e3c4e');
    cx.fillStyle = g; cx.fillRect(sx1, sy1, sw, sh);
    // Issue #41: steel plate texture (anchored in screen px — see drawHullStruct).
    if (_matTiles) {
        cx.save();
        cx.beginPath(); cx.rect(sx1, sy1, sw, sh); cx.clip();
        fillWithMaterialPattern(cx, _matTiles.steel, sx1, sy1, true);
        cx.restore();
    }
    var inset = Math.min(6, sw * 0.08, sh * 0.12);
    cx.strokeStyle = 'rgba(255,255,255,0.12)'; cx.lineWidth = 1.5;
    cx.strokeRect(sx1 + inset, sy1 + inset, sw - inset * 2, sh - inset * 2);
    if (sw > 60) {
        var pc = Math.floor(sw / 60);
        for (var p = 0; p < pc; p++) {
            var phx = sx1 + (p + 0.5) * (sw / pc);
            var phy = sy1 + sh * 0.4;
            var pr  = Math.min(sh * 0.18, 10);
            cx.fillStyle = 'rgba(10,30,50,0.85)';
            cx.beginPath(); cx.arc(phx, phy, pr, 0, Math.PI * 2); cx.fill();
            cx.strokeStyle = 'rgba(180,200,215,0.3)'; cx.lineWidth = 2;
            cx.stroke();
            cx.fillStyle = 'rgba(100,180,220,0.18)';
            cx.beginPath(); cx.arc(phx - pr * 0.3, phy - pr * 0.3, pr * 0.4, 0, Math.PI * 2); cx.fill();
        }
    }
    cx.fillStyle = 'rgba(130,65,15,0.15)';
    cx.beginPath();
    cx.ellipse(sx1 + sw * (0.6 + sRand(seed) * 0.2), sy1 + sh * 0.75,
        sw * 0.12, sh * 0.18, 0, 0, Math.PI * 2);
    cx.fill();
    cx.strokeStyle = 'rgba(255,255,255,0.06)'; cx.lineWidth = 1;
    cx.strokeRect(sx1, sy1, sw, sh);
    // Issue #56: rust streaks on the panel, and — mirroring #34's own
    // sitsOnFloor gate — a contact-accumulation band along the bottom
    // edge only when this bulkhead actually meets the floor.
    if (accum) {
        drawVerticalStreaks(cx, { sx: sx1, sy: sy1, sw: sw, sh: sh }, {
            intensity: accum.streaks,
            worldSeed: seed + ACCUM_SEED.streak,
            variant: 'rust',
            exterior: false
        });
        if (sitsOnFloor) {
            drawContactAccumulation(cx, [[sx1, sy1 + sh], [sx1 + sw, sy1 + sh]], {
                intensity: accum.contactDebris,
                worldSeed: seed + ACCUM_SEED.contact,
                side: 'above'
            });
        }
    }
}

// ============================================================
//  ZENOBIA-style ferry wreck — detail sprites
//  Each takes (cx, x, y) where y is the BOTTOM baseline of the
//  sprite (rests on the floor of its deck). Sizes are tuned to
//  the standard wreck mpp = 0.05 (1 m = 20 px) so 1 sprite-meter
//  matches 1 world-meter.
// ============================================================

// Crew bunk — stacked bed (upper + lower) with pillows + ladder
function drawBunk(cx, x, y) {
    cx.save();
    var w = 30, h = 24;
    var bx = x - w / 2, by = y - h;
    // posts
    cx.fillStyle = '#2a3038';
    cx.fillRect(bx - 1, by, 2, h);
    cx.fillRect(bx + w - 1, by, 2, h);
    // upper bunk
    cx.fillStyle = '#3a3528';
    cx.fillRect(bx, by + 2, w, 8);
    cx.fillStyle = 'rgba(180,170,140,0.55)';
    cx.fillRect(bx + 2, by + 3, 8, 5);
    cx.fillStyle = 'rgba(255,255,255,0.15)';
    cx.fillRect(bx, by + 2, w, 1);
    // lower bunk
    cx.fillStyle = '#3a3528';
    cx.fillRect(bx, by + h - 10, w, 8);
    cx.fillStyle = 'rgba(180,170,140,0.55)';
    cx.fillRect(bx + 2, by + h - 9, 8, 5);
    cx.fillStyle = 'rgba(255,255,255,0.15)';
    cx.fillRect(bx, by + h - 10, w, 1);
    // ladder rungs on the right post
    cx.strokeStyle = 'rgba(120,130,150,0.7)';
    cx.lineWidth = 0.7;
    for (var r = 0; r < 4; r++) {
        cx.beginPath();
        cx.moveTo(bx + w - 4, by + 4 + r * 4);
        cx.lineTo(bx + w + 1, by + 4 + r * 4);
        cx.stroke();
    }
    cx.restore();
}

// Intermodal shipping container — corrugated, end-door, rust streaks
function drawContainer(cx, x, y, color) {
    cx.save();
    var w = 88, h = 36;
    var bx = x - w / 2, by = y - h;
    var c = color || '#3a6a4a';
    cx.fillStyle = c;
    cx.fillRect(bx, by, w, h);
    // corrugation lines
    cx.strokeStyle = 'rgba(0,0,0,0.35)';
    cx.lineWidth = 0.7;
    for (var i = 1; i < 16; i++) {
        cx.beginPath();
        cx.moveTo(bx + i * (w / 16), by + 2);
        cx.lineTo(bx + i * (w / 16), by + h - 2);
        cx.stroke();
    }
    // corner castings
    cx.fillStyle = '#1a1a1a';
    cx.fillRect(bx, by, 5, 5);
    cx.fillRect(bx + w - 5, by, 5, 5);
    cx.fillRect(bx, by + h - 5, 5, 5);
    cx.fillRect(bx + w - 5, by + h - 5, 5, 5);
    // door panel + handle
    cx.strokeStyle = 'rgba(0,0,0,0.55)';
    cx.lineWidth = 0.8;
    cx.strokeRect(bx + w - 16, by + 2, 14, h - 4);
    cx.fillStyle = '#1a1a1a';
    cx.fillRect(bx + w - 4, by + h / 2 - 4, 2, 8);
    // rust streaks
    cx.fillStyle = 'rgba(110,40,15,0.5)';
    cx.fillRect(bx + w * 0.18, by, 2, h);
    cx.fillRect(bx + w * 0.58, by, 2, h);
    // algae top
    cx.fillStyle = 'rgba(80,100,50,0.65)';
    cx.fillRect(bx, by - 1, w, 2);
    cx.restore();
}

// Twin-cylinder diesel engine block — 6 cylinder heads, gauges, pipes
function drawEngine(cx, x, y) {
    cx.save();
    var w = 88, h = 64;
    var bx = x - w / 2, by = y - h;
    // base block
    cx.fillStyle = '#3a3a3a';
    cx.fillRect(bx, by + h * 0.45, w, h * 0.55);
    // brass top trim of block
    cx.fillStyle = 'rgba(160,120,60,0.7)';
    cx.fillRect(bx, by + h * 0.45, w, 2);
    // row of 6 cylinder heads + exhaust risers
    var cylW = (w * 0.84) / 6;
    for (var c = 0; c < 6; c++) {
        var cxl = bx + w * 0.08 + c * cylW;
        cx.fillStyle = '#1a1a1a';
        cx.fillRect(cxl, by + h * 0.25, cylW - 3, h * 0.22);
        // exhaust riser
        cx.fillRect(cxl + (cylW - 3) / 2 - 2, by, 4, h * 0.25);
        // brass valve cap
        cx.fillStyle = 'rgba(160,120,60,0.7)';
        cx.beginPath();
        cx.ellipse(cxl + (cylW - 3) / 2, by + 1, 3, 1.4, 0, 0, Math.PI * 2);
        cx.fill();
    }
    // gauges left + right
    cx.fillStyle = '#1a1a1a';
    cx.beginPath(); cx.arc(bx + 8, by + h * 0.72, 4, 0, Math.PI * 2); cx.fill();
    cx.beginPath(); cx.arc(bx + w - 8, by + h * 0.72, 4, 0, Math.PI * 2); cx.fill();
    cx.strokeStyle = 'rgba(160,120,60,0.7)';
    cx.lineWidth = 0.8;
    cx.beginPath(); cx.arc(bx + 8, by + h * 0.72, 4, 0, Math.PI * 2); cx.stroke();
    cx.beginPath(); cx.arc(bx + w - 8, by + h * 0.72, 4, 0, Math.PI * 2); cx.stroke();
    // side pipes
    cx.strokeStyle = 'rgba(160,120,60,0.6)';
    cx.lineWidth = 2;
    cx.beginPath();
    cx.moveTo(bx, by + h * 0.6); cx.lineTo(bx - 10, by + h * 0.6); cx.lineTo(bx - 10, by + h);
    cx.stroke();
    cx.beginPath();
    cx.moveTo(bx + w, by + h * 0.6); cx.lineTo(bx + w + 10, by + h * 0.6); cx.lineTo(bx + w + 10, by + h);
    cx.stroke();
    // brass nameplate
    cx.fillStyle = 'rgba(160,120,60,0.55)';
    cx.fillRect(bx + w * 0.35, by + h * 0.62, w * 0.3, h * 0.12);
    // algae top + rust below
    cx.fillStyle = 'rgba(80,100,50,0.6)';
    cx.fillRect(bx, by - 1, w, 2);
    cx.fillStyle = 'rgba(120,50,20,0.45)';
    cx.fillRect(bx + w * 0.2, by + h - 2, w * 0.6, 2);
    cx.restore();
}

// Mess hall table — long bench with cups + plates drifting on top
function drawMessTable(cx, x, y) {
    cx.save();
    var w = 56, h = 14;
    var bx = x - w / 2, by = y - h;
    // benches above + below the table
    cx.fillStyle = '#3a3528';
    cx.fillRect(bx - 3, by + 1, w + 6, 2.5);
    cx.fillRect(bx - 3, by + h - 3.5, w + 6, 2.5);
    // table top
    cx.fillStyle = '#7e7762';
    cx.fillRect(bx, by + 5, w, 4);
    cx.fillStyle = 'rgba(220,210,180,0.5)';
    cx.fillRect(bx, by + 5, w, 1);
    // cups + plates drifting on the table
    cx.fillStyle = 'rgba(200,190,160,0.65)';
    cx.beginPath(); cx.arc(bx + 10, by + 7, 1.8, 0, Math.PI * 2); cx.fill();
    cx.beginPath(); cx.arc(bx + 22, by + 7, 1.4, 0, Math.PI * 2); cx.fill();
    cx.beginPath(); cx.arc(bx + 34, by + 7, 1.6, 0, Math.PI * 2); cx.fill();
    cx.beginPath(); cx.arc(bx + 46, by + 7, 1.3, 0, Math.PI * 2); cx.fill();
    cx.restore();
}

// Bridge helm — ship's wheel + curved console + gauges
function drawHelm(cx, x, y) {
    cx.save();
    var w = 56, h = 40;
    var bx = x - w / 2, by = y - h;
    // curved console
    cx.fillStyle = '#7e7762';
    cx.beginPath();
    cx.moveTo(bx, by + h * 0.55);
    cx.quadraticCurveTo(x, by + h * 0.3, bx + w, by + h * 0.55);
    cx.lineTo(bx + w, by + h);
    cx.lineTo(bx, by + h);
    cx.closePath(); cx.fill();
    // brass trim line
    cx.strokeStyle = 'rgba(160,120,60,0.85)';
    cx.lineWidth = 1.4;
    cx.beginPath();
    cx.moveTo(bx, by + h * 0.55);
    cx.quadraticCurveTo(x, by + h * 0.3, bx + w, by + h * 0.55);
    cx.stroke();
    // helm wheel
    var wcy = by + h * 0.55;
    cx.lineWidth = 1.8;
    cx.beginPath(); cx.arc(x, wcy, 10, 0, Math.PI * 2); cx.stroke();
    // spokes
    for (var s = 0; s < 6; s++) {
        var a = s * Math.PI / 3;
        cx.beginPath();
        cx.moveTo(x, wcy);
        cx.lineTo(x + Math.cos(a) * 11, wcy + Math.sin(a) * 11);
        cx.stroke();
    }
    cx.fillStyle = 'rgba(160,120,60,0.95)';
    cx.beginPath(); cx.arc(x, wcy, 3.5, 0, Math.PI * 2); cx.fill();
    // gauges
    cx.fillStyle = '#1a1a1a';
    cx.beginPath(); cx.arc(bx + 9, by + h * 0.8, 3.5, 0, Math.PI * 2); cx.fill();
    cx.beginPath(); cx.arc(bx + w - 9, by + h * 0.8, 3.5, 0, Math.PI * 2); cx.fill();
    cx.strokeStyle = 'rgba(160,120,60,0.7)';
    cx.lineWidth = 0.7;
    cx.beginPath(); cx.arc(bx + 9, by + h * 0.8, 3.5, 0, Math.PI * 2); cx.stroke();
    cx.beginPath(); cx.arc(bx + w - 9, by + h * 0.8, 3.5, 0, Math.PI * 2); cx.stroke();
    cx.restore();
}

// Lifeboat in davits — orange covered capsule with portholes
function drawLifeboat(cx, x, y) {
    cx.save();
    var w = 56, h = 20;
    var bx = x - w / 2, by = y - h;
    // davit arms (cradle holding the boat)
    cx.strokeStyle = '#7e7762';
    cx.lineWidth = 1.5;
    cx.beginPath();
    cx.moveTo(bx + 4, by + h); cx.lineTo(bx, by - 10); cx.lineTo(bx + 10, by - 14);
    cx.stroke();
    cx.beginPath();
    cx.moveTo(bx + w - 4, by + h); cx.lineTo(bx + w, by - 10); cx.lineTo(bx + w - 10, by - 14);
    cx.stroke();
    // covered orange capsule
    cx.fillStyle = '#d97a1a';
    cx.beginPath();
    cx.moveTo(bx + 4, by + h);
    cx.quadraticCurveTo(bx - 2, by, bx + 10, by);
    cx.lineTo(bx + w - 10, by);
    cx.quadraticCurveTo(bx + w + 2, by, bx + w - 4, by + h);
    cx.closePath(); cx.fill();
    // hatch / topline
    cx.fillStyle = 'rgba(255,255,255,0.5)';
    cx.fillRect(bx + 8, by + 4, w - 16, 2);
    // portholes
    cx.fillStyle = '#0a141a';
    for (var p = 0; p < 4; p++) {
        cx.beginPath();
        cx.arc(bx + 10 + p * (w - 20) / 3, by + h * 0.55, 1.8, 0, Math.PI * 2);
        cx.fill();
    }
    // hull number
    cx.fillStyle = 'rgba(255,255,255,0.45)';
    cx.font = 'bold 5px monospace';
    cx.textAlign = 'center';
    cx.fillText('1', bx + w * 0.18, by + h * 0.95);
    cx.textAlign = 'left';
    cx.restore();
}

// Bow visor — hinged-up door at the forward vehicle-deck opening
function drawBowVisor(cx, x, y) {
    cx.save();
    cx.translate(x, y);
    cx.rotate(-Math.PI * 0.35);
    // door slab
    var g = cx.createLinearGradient(0, -10, 0, 10);
    g.addColorStop(0, '#7a8898');
    g.addColorStop(1, '#3a4858');
    cx.fillStyle = g;
    cx.fillRect(-36, -10, 72, 20);
    // plate seam
    cx.strokeStyle = 'rgba(0,0,0,0.45)';
    cx.lineWidth = 0.8;
    cx.beginPath();
    cx.moveTo(-36, 0); cx.lineTo(36, 0);
    cx.stroke();
    // rivets
    cx.fillStyle = 'rgba(15,15,15,0.65)';
    for (var rv = -30; rv <= 30; rv += 8) {
        cx.beginPath(); cx.arc(rv, -6, 0.8, 0, Math.PI * 2); cx.fill();
        cx.beginPath(); cx.arc(rv, 6, 0.8, 0, Math.PI * 2); cx.fill();
    }
    // anchor recess
    cx.fillStyle = '#0a0a0a';
    cx.beginPath(); cx.arc(-14, 0, 3.5, 0, Math.PI * 2); cx.fill();
    cx.fillRect(-18, -2, 8, 3);
    // hinge spindle
    cx.fillStyle = '#1a1a1a';
    cx.beginPath(); cx.arc(36, 0, 2.5, 0, Math.PI * 2); cx.fill();
    cx.restore();
}

// Rust hole — jagged dark opening in a hull plate with rust bleed below
function drawRustHole(cx, x, y) {
    cx.save();
    var w = 22, h = 16;
    // opening fill
    cx.fillStyle = '#0a0a0a';
    cx.beginPath();
    cx.moveTo(x - w / 2, y);
    cx.quadraticCurveTo(x - w * 0.35, y - h, x, y - h * 0.45);
    cx.quadraticCurveTo(x + w * 0.4, y - h * 0.3, x + w / 2, y);
    cx.quadraticCurveTo(x + w * 0.3, y + h * 0.9, x, y + h * 0.45);
    cx.quadraticCurveTo(x - w * 0.4, y + h, x - w / 2, y);
    cx.closePath(); cx.fill();
    // rust ring
    cx.strokeStyle = 'rgba(140,55,20,0.9)';
    cx.lineWidth = 1.6;
    cx.stroke();
    // rust streak below
    var grad = cx.createLinearGradient(x, y, x, y + 36);
    grad.addColorStop(0, 'rgba(90,30,12,0.7)');
    grad.addColorStop(1, 'rgba(90,30,12,0)');
    cx.fillStyle = grad;
    cx.fillRect(x - w * 0.4, y + h * 0.35, w * 0.8, 36);
    cx.restore();
}

// ── Issue #33: sagging line ────────────────────────────────────────
// A slack cable / rope hanging between two anchor points. Purely
// cosmetic — no collision, no gameplay. Motion (a very slight sway of
// the sagging body) comes EXCLUSIVELY from #57's sampleEnvironmentSway
// with `SWAY_PROFILES.hangingLine`; this drawer never invents its own
// Math.sin() and never keeps state between frames. `worldX` is passed
// so the seed is stable in world coordinates (survives camera pan).
//
// Feature shape defaults: two anchors ~2 m apart, sagging ~1.4 m below
// the anchor line. Consumers may override via feature.length (m) or
// feature.sag (m).
function drawHangingLine(cx, x, y, worldX, feature) {
    var mpp = 0.05;
    var lenM = (feature && feature.length) || 2.2;
    var sagM = (feature && feature.sag)    || 1.4;
    var lenPx = lenM / mpp;
    var sagPx = sagM / mpp;
    // Small tip sway from #57 — reuses hangingLine profile, no local math.
    var seed = (worldX || 0) * 3.19 + 71.7;
    var swMid = sampleEnvironmentSway(seed, SWAY_PROFILES.hangingLine, 1.0);
    var swQtr = sampleEnvironmentSway(seed, SWAY_PROFILES.hangingLine, 0.5);
    var ax = x - lenPx * 0.5, ay = y;
    var bx = x + lenPx * 0.5, by = y + 0.6;   // slight asymmetry — rarely level
    // Sag control points: mid drops by sagPx, offset by sway sample.
    var midX = (ax + bx) / 2 + swMid.x;
    var midY = ay + sagPx + swMid.y;
    // Two quadratic bezier halves gives a gently sagging catenary look.
    var q1cX = ax + lenPx * 0.25 + swQtr.x * 0.6;
    var q1cY = ay + sagPx * 0.75;
    var q2cX = bx - lenPx * 0.25 + swQtr.x * 0.6;
    var q2cY = by + sagPx * 0.75;
    cx.save();
    // Faint shadow under the rope for depth cue (low alpha; #34 owns AO,
    // this is just a subtle reading aid).
    cx.strokeStyle = 'rgba(0,0,0,0.25)';
    cx.lineWidth = 2.2;
    cx.lineCap = 'round';
    cx.beginPath();
    cx.moveTo(ax + 1, ay + 1);
    cx.quadraticCurveTo(q1cX + 1, q1cY + 1, midX + 1, midY + 1);
    cx.quadraticCurveTo(q2cX + 1, q2cY + 1, bx + 1, by + 1);
    cx.stroke();
    // Rope itself — muted olive-brown, low contrast.
    cx.strokeStyle = 'rgba(120,102,72,0.72)';
    cx.lineWidth = 1.4;
    cx.beginPath();
    cx.moveTo(ax, ay);
    cx.quadraticCurveTo(q1cX, q1cY, midX, midY);
    cx.quadraticCurveTo(q2cX, q2cY, bx, by);
    cx.stroke();
    // Anchor knots at each end
    cx.fillStyle = 'rgba(60,50,38,0.85)';
    cx.beginPath(); cx.arc(ax, ay, 1.4, 0, Math.PI * 2); cx.fill();
    cx.beginPath(); cx.arc(bx, by, 1.4, 0, Math.PI * 2); cx.fill();
    cx.restore();
}

// ── Issue #33: torn fishing net ────────────────────────────────────
// A bounded frame curve plus a sparse thin grid pattern. Purely
// cosmetic. Motion via #57 `SWAY_PROFILES.net` only. Consumers may
// override feature.width / feature.height (metres).
function drawNet(cx, x, y, worldX, feature) {
    var mpp = 0.05;
    var wM = (feature && feature.width)  || 3.0;
    var hM = (feature && feature.height) || 2.4;
    var wPx = wM / mpp;
    var hPx = hM / mpp;
    var seed = (worldX || 0) * 5.71 + 133.3;
    var swMid = sampleEnvironmentSway(seed, SWAY_PROFILES.net, 1.0);
    var swQtr = sampleEnvironmentSway(seed, SWAY_PROFILES.net, 0.5);
    // The net hangs from a top anchor line (x1..x2, y). Bottom edge
    // drifts with the sway sample; sides sag slightly toward the middle.
    var x1 = x - wPx * 0.5, x2 = x + wPx * 0.5;
    var yTop = y;
    var yBot = y + hPx + swMid.y;
    var xBotShift = swMid.x;
    var xMidShift = swQtr.x;
    cx.save();
    // Grid: 4 vertical strands, 3 horizontal strands. Kept intentionally
    // sparse so this reads as a distant, atmospheric detail rather than
    // a focal prop. Each strand is a quadratic curve so it sags with the
    // frame — no per-strand ad-hoc trig.
    cx.strokeStyle = 'rgba(120,132,124,0.42)';
    cx.lineWidth = 0.7;
    // Vertical strands
    var vCount = 4;
    for (var v = 0; v <= vCount; v++) {
        var tv = v / vCount;
        var xTop = x1 + wPx * tv;
        var xB   = x1 + wPx * tv + xBotShift;
        var xMid = (xTop + xB) / 2 + xMidShift * (1 - Math.abs(tv - 0.5) * 2) * 0.5;
        var yMid = yTop + (yBot - yTop) * 0.55;
        cx.beginPath();
        cx.moveTo(xTop, yTop);
        cx.quadraticCurveTo(xMid, yMid, xB, yBot);
        cx.stroke();
    }
    // Horizontal strands
    var hCount = 3;
    for (var h = 1; h <= hCount; h++) {
        var th = h / (hCount + 1);
        var yH = yTop + (yBot - yTop) * th;
        var xLH = x1 + xBotShift * th;
        var xRH = x2 + xBotShift * th;
        var xMH = (xLH + xRH) / 2;
        var yMH = yH + xMidShift * 0.2;    // very subtle horizontal wobble
        cx.beginPath();
        cx.moveTo(xLH, yH);
        cx.quadraticCurveTo(xMH, yMH, xRH, yH);
        cx.stroke();
    }
    // Frame curve — slightly darker, traces the net's outer boundary so
    // the sparse grid still reads as a bounded object even off-camera.
    cx.strokeStyle = 'rgba(80,88,80,0.55)';
    cx.lineWidth = 1.0;
    cx.beginPath();
    cx.moveTo(x1, yTop);
    cx.lineTo(x2, yTop);                    // top edge (headline)
    cx.quadraticCurveTo(x2 + xMidShift, (yTop + yBot) / 2, x2 + xBotShift, yBot);
    cx.quadraticCurveTo(x + xBotShift, yBot + Math.abs(xMidShift) * 0.5, x1 + xBotShift, yBot);
    cx.quadraticCurveTo(x1 + xMidShift, (yTop + yBot) / 2, x1, yTop);
    cx.stroke();
    // Anchor floats at each end of the headline
    cx.fillStyle = 'rgba(48,54,50,0.7)';
    cx.beginPath(); cx.arc(x1, yTop, 1.6, 0, Math.PI * 2); cx.fill();
    cx.beginPath(); cx.arc(x2, yTop, 1.6, 0, Math.PI * 2); cx.fill();
    cx.restore();
}

// ---- Structure-kind drawers (replace plain hull for ferry chrome) ----

// Funnel — trapezoid stack, ship's-livery red band, cap.
function drawFunnelStruct(cx, sx1, sy1, sw, sh) {
    cx.save();
    // stack body
    cx.fillStyle = '#b8b09a';
    cx.beginPath();
    cx.moveTo(sx1 + sw * 0.05, sy1);
    cx.lineTo(sx1 + sw * 0.95, sy1);
    cx.lineTo(sx1 + sw, sy1 + sh);
    cx.lineTo(sx1, sy1 + sh);
    cx.closePath(); cx.fill();
    // shade right
    cx.fillStyle = 'rgba(0,0,0,0.18)';
    cx.beginPath();
    cx.moveTo(sx1 + sw * 0.6, sy1);
    cx.lineTo(sx1 + sw * 0.95, sy1);
    cx.lineTo(sx1 + sw, sy1 + sh);
    cx.lineTo(sx1 + sw * 0.7, sy1 + sh);
    cx.closePath(); cx.fill();
    // red livery band
    var bandTop = sy1 + sh * 0.25;
    var bandBot = sy1 + sh * 0.6;
    cx.fillStyle = '#a04030';
    cx.fillRect(sx1 + sw * 0.05, bandTop, sw * 0.9, bandBot - bandTop);
    cx.fillStyle = 'rgba(255,255,255,0.5)';
    cx.fillRect(sx1 + sw * 0.05, bandTop, sw * 0.9, 1.5);
    cx.fillStyle = 'rgba(0,0,0,0.45)';
    cx.fillRect(sx1 + sw * 0.05, bandBot - 1.5, sw * 0.9, 1.5);
    // livery logo — white disc with letter
    var lx = sx1 + sw / 2, ly = (bandTop + bandBot) / 2;
    var lr = Math.min(sw, sh) * 0.13;
    cx.fillStyle = 'rgba(255,255,255,0.7)';
    cx.beginPath(); cx.arc(lx, ly, lr, 0, Math.PI * 2); cx.fill();
    cx.fillStyle = '#a04030';
    cx.font = 'bold ' + Math.floor(lr * 1.4) + 'px monospace';
    cx.textAlign = 'center'; cx.textBaseline = 'middle';
    cx.fillText('Z', lx, ly + 0.5);
    cx.textBaseline = 'alphabetic'; cx.textAlign = 'left';
    // cap rim + black exhaust opening
    cx.fillStyle = '#3a3528';
    cx.fillRect(sx1, sy1, sw, 4);
    cx.fillStyle = '#0a0a0a';
    cx.fillRect(sx1 + 4, sy1 + 1, sw - 8, 2.5);
    // algae bleed at the base
    cx.fillStyle = 'rgba(80,100,50,0.55)';
    cx.fillRect(sx1 + sw * 0.08, sy1 + sh * 0.7, 3, sh * 0.3);
    cx.fillRect(sx1 + sw * 0.78, sy1 + sh * 0.65, 3, sh * 0.35);
    cx.restore();
}

// Mast — pole + yard arm + crow's nest + radar
function drawMastStruct(cx, sx1, sy1, sw, sh) {
    cx.save();
    var midX = sx1 + sw / 2;
    // pole
    cx.strokeStyle = '#3a3528';
    cx.lineWidth = Math.max(2, sw);
    cx.beginPath(); cx.moveTo(midX, sy1); cx.lineTo(midX, sy1 + sh); cx.stroke();
    cx.strokeStyle = 'rgba(255,255,255,0.25)';
    cx.lineWidth = 0.7;
    cx.beginPath(); cx.moveTo(midX - 0.5, sy1); cx.lineTo(midX - 0.5, sy1 + sh); cx.stroke();
    // yard
    cx.strokeStyle = '#3a3528';
    cx.lineWidth = 2;
    var yardY = sy1 + sh * 0.42;
    cx.beginPath(); cx.moveTo(midX - 24, yardY); cx.lineTo(midX + 24, yardY); cx.stroke();
    // navigation lights at yard tips
    cx.fillStyle = '#3a6a3a';
    cx.beginPath(); cx.arc(midX + 24, yardY, 2, 0, Math.PI * 2); cx.fill();
    cx.fillStyle = '#6a3a3a';
    cx.beginPath(); cx.arc(midX - 24, yardY, 2, 0, Math.PI * 2); cx.fill();
    // crow's nest
    var nestY = sy1 + sh * 0.3;
    cx.fillStyle = '#7e7762';
    cx.fillRect(midX - 9, nestY, 18, 11);
    cx.fillStyle = '#b8b09a';
    cx.fillRect(midX - 9, nestY, 18, 2);
    cx.fillStyle = '#0a141a';
    cx.fillRect(midX - 6, nestY + 4, 12, 5);
    // radar dish at top
    cx.fillStyle = '#3a3528';
    cx.fillRect(midX - 1.5, sy1 - 8, 3, 8);
    cx.beginPath();
    cx.ellipse(midX, sy1 - 8, 14, 3, 0, 0, Math.PI * 2);
    cx.fill();
    cx.fillStyle = 'rgba(255,255,255,0.2)';
    cx.beginPath();
    cx.ellipse(midX, sy1 - 9, 12, 1.5, 0, 0, Math.PI);
    cx.fill();
    cx.restore();
}

// Cenote halocline — the soft, blurry shimmer where fresh water floats on
// salt. Rendered as a wide, very faint mixing band at ~7 m with a couple of
// gentle drifting shimmer lines, rather than a hard silver seam.
function drawHalocline(cx, W, H, dsy, mpp) {
    var hd = 7;  // halocline depth in metres
    var hy = dsy + (hd - depth) / mpp;
    if (hy < -24 || hy > H + 24) return;
    cx.save();
    // Wide, low-opacity mixing haze — the out-of-focus blur of two fluids.
    var band = 20;
    var hg = cx.createLinearGradient(0, hy - band, 0, hy + band);
    hg.addColorStop(0,    'rgba(196,226,220,0)');
    hg.addColorStop(0.5,  'rgba(220,238,232,0.12)');
    hg.addColorStop(1,    'rgba(196,226,220,0)');
    cx.fillStyle = hg;
    cx.fillRect(0, hy - band, W, band * 2);
    // A couple of faint shimmer lines drifting through the band.
    cx.lineWidth = 1;
    for (var k = 0; k < 2; k++) {
        cx.strokeStyle = 'rgba(228,242,238,' + (0.10 - k * 0.04).toFixed(3) + ')';
        cx.beginPath();
        for (var x = 0; x <= W; x += 8) {
            var wob = Math.sin(x * 0.035 + waveTime * 0.5 + k * 1.7) * 2.4
                    + Math.sin(x * 0.11 + waveTime * 0.22) * 1.2
                    + (k - 0.5) * 5;
            if (x === 0) cx.moveTo(x, hy + wob);
            else cx.lineTo(x, hy + wob);
        }
        cx.stroke();
    }
    cx.restore();
}

function drawStructures() {
    var s = activeSite();
    if (!s || !s.structures.length) return;
    var W = cssWidth, H = cssHeight;
    var diverScreenX = W * DIVER_SCREEN_X_FRACTION, diverScreenY = H * 0.45, mpp = 0.05;
    var cx = ctx;
    for (var i = 0; i < s.structures.length; i++) {
        var w = s.structures[i];
        var sx1 = diverScreenX + (w.x1 - diverX) / mpp;
        var sx2 = diverScreenX + (w.x2 - diverX) / mpp;
        var sy1 = diverScreenY + (w.dTop - depth) / mpp;
        var sy2 = diverScreenY + (w.dBottom - depth) / mpp;
        if (sx2 < -10 || sx1 > W + 10 || sy2 < -10 || sy1 > H + 10) continue;
        var sw = sx2 - sx1, sh = sy2 - sy1;
        var seed = w.x1 * 17.3 + w.dTop * 31.7;
        var rockTone = null;
        if (s.id === 'reef') rockTone = 'reef';
        else if (s.id === 'shore') rockTone = 'shore';
        else if (s.id === 'cave') rockTone = (w.dTop >= 16) ? 'caveGrey' : 'caveBrown';

        // Issue #56: per-zone accumulation profile for this structure,
        // sampled once at its centre. `accum.exterior` is a call-local
        // convenience flag (not part of the shared profile shape) so
        // drawHullStruct can tell exterior plating from interior plating
        // without re-deriving the zone itself.
        var midWx = (w.x1 + w.x2) / 2;
        var midWd = (w.dTop + w.dBottom) / 2;
        var _z = visualZoneAt(midWx, midWd, s);
        var accum = accumulationProfileFor(s.id, _z ? _z.id : null);
        accum.exterior = !!(_z && _z.id === 'wreck_exterior');

        // Issue #34: AO contact band gate — computed BEFORE the switch so
        // #56's drawBulkheadStruct can mirror the same "sits on floor" gate
        // for its own bottom-edge contact accumulation.
        var floorHereL = floorAt(w.x1), floorHereR = floorAt(w.x2);
        var ceilHereL  = ceilingAt(w.x1), ceilHereR = ceilingAt(w.x2);
        var slack = CONTACT_AO.structure.contactSlackM;
        var sitsOnFloor = (Math.abs(w.dBottom - floorHereL) < slack)
                       || (Math.abs(w.dBottom - floorHereR) < slack);
        var hangsFromCeil = (s.ceiling)
                       && ((Math.abs(w.dTop - ceilHereL) < slack)
                        || (Math.abs(w.dTop - ceilHereR) < slack));

        // Issue #33: object-relative interior lighting for wreck structures.
        // Same modulator drawFeatures uses — near/lit reads present, far
        // outside cone blends toward background steel. No-op outside wreck
        // interior. AO contact bands stay at full alpha (computed after
        // restore) so contact reading isn't muted by object distance.
        var _strAlphaMul = wreckInteriorAlphaMul(midWx, midWd);
        var _strNeedsGate = (_strAlphaMul !== 1);
        if (_strNeedsGate) { cx.save(); cx.globalAlpha *= _strAlphaMul; }

        switch (w.kind) {
            case 'rock': case 'pillar':
                drawRockStruct(cx, sx1, sy1, sw, sh, seed, rockTone); break;
            case 'bedrock':
                drawBedrockStruct(cx, w.x1, w.x2, w.dTop, w.dBottom, accum); break;
            case 'wreckSmall':
                drawSmallWreck(cx, sx1, sy1, sw, sh); break;
            case 'hull':
                drawHullStruct(cx, sx1, sy1, sw, sh, seed, accum); break;
            case 'deck':
                drawDeckStruct(cx, sx1, sy1, sw, sh, seed, accum); break;
            case 'bulkhead':
                drawBulkheadStruct(cx, sx1, sy1, sw, sh, seed, accum, sitsOnFloor); break;
            case 'funnel':
                drawFunnelStruct(cx, sx1, sy1, sw, sh); break;
            case 'mast':
                drawMastStruct(cx, sx1, sy1, sw, sh); break;
            default:
                cx.fillStyle = '#445566';
                cx.fillRect(sx1, sy1, sw, sh);
                cx.strokeStyle = 'rgba(255,255,255,0.08)';
                cx.lineWidth = 1;
                cx.strokeRect(sx1, sy1, sw, sh);
        }

        if (_strNeedsGate) cx.restore();

        // Issue #34: AO contact band along the structure's contact edge with
        // terrain. Sits-on-floor: draw the bottom edge. Hangs-from-ceiling:
        // draw the top edge. World-anchored via the same screen-space
        // conversion the structure uses. Skipped for structures floating in
        // the water column (e.g. midwater bedrock crossings) — those don't
        // touch anything, so an AO band there would read as a bug.
        if (sitsOnFloor) {
            drawContactBand(cx, [[sx1, sy2], [sx2, sy2]], CONTACT_AO.structure);
        }
        if (hangsFromCeil) {
            drawContactBand(cx, [[sx1, sy1], [sx2, sy1]], CONTACT_AO.structure);
        }
    }
}

// Issue #33: object-relative interior alpha modulator (wreck only,
// while the diver is in an overhead). Combines the two #33 effects
// into ONE small alpha multiplier layered on top of whatever #54's
// zone-wide atmosphere already does. Never rebuilds a fog layer.
//   • interior distance: near objects read more present than far ones.
//   • torch-relative:   in-cone objects reach full presence even at
//                       distance; outside-cone objects sit lower.
// Combines via max() so a near-but-unlit object stays present, and a
// far-but-lit object stays legible. Amplitude capped at ~30% swing so
// nothing is fully obscured or fully saturated. Exposed via gameAPI
// for TC-33-INTERIOR-* tests.
function wreckInteriorAlphaMul(worldX, worldD) {
    var s = activeSite();
    if (!s || s.id !== 'wreck' || !inOverhead) return 1;
    var interiorF = interiorObjectDistanceFactor(worldX, worldD);
    var lightF = sampleTorchLightAtWorldPoint(worldX, worldD);
    var combined = interiorF > lightF ? interiorF : lightF;
    return 0.72 + 0.28 * combined;
}

function drawFeatures() {
    var s = activeSite();
    if (!s || !s.features.length) return;
    var W = cssWidth, H = cssHeight;
    var diverScreenX = W * DIVER_SCREEN_X_FRACTION, diverScreenY = H * 0.45, mpp = 0.05;
    var cx = ctx;
    for (var i = 0; i < s.features.length; i++) {
        var f = s.features[i];
        var ffx = diverScreenX + ((f.x || 0) - diverX) / mpp;
        if (ffx < -200 || ffx > W + 200) continue;
        // Issue #33: apply interior alpha modulation for wreck features.
        // Uses save/restore around the switch so every drawer sees the
        // modulated globalAlpha without needing per-kind wiring.
        var _featAlphaMul = wreckInteriorAlphaMul(f.x || 0, f.d || 0);
        var _needsAlphaGate = (_featAlphaMul !== 1);
        if (_needsAlphaGate) { cx.save(); cx.globalAlpha *= _featAlphaMul; }
        if (f.kind === 'seagrass') {
            var fgy = diverScreenY + ((f.d || 0) - depth) / mpp;
            if (fgy > -20 && fgy < H + 20) drawSeagrass(cx, ffx, fgy, (f.x || 0));
        } else if (f.kind === 'warningSign') {
            // Anchor the sign's base to the cave floor so it stands on the rock
            // instead of floating in the water column.
            var fwy = diverScreenY + (floorAt(f.x || 0) - depth) / mpp;
            if (fwy > -20 && fwy < H + 20) drawWarningSign(cx, ffx, fwy);
        } else if (f.kind === 'thermocline') {
            drawThermocline(cx, f.d || 0);
        } else if (f.kind === 'coral') {
            var fcy = diverScreenY + ((f.d || 0) - depth) / mpp;
            if (fcy > -20 && fcy < H + 20) { drawContactShadow(cx, ffx, fcy, 34, 8, 0.18); drawCoral(cx, ffx, fcy, (f.x || 0)); }
        } else if (f.kind === 'lorry') {
            var flY = diverScreenY + ((f.d || 0) - depth) / mpp;
            if (flY > -20 && flY < H + 20) { drawContactShadow(cx, ffx, flY, 138, 14, 0.26); drawVehicle(cx, ffx, flY, 'lorry', (f.x || 0)); }
        } else if (f.kind === 'car') {
            var fcaY = diverScreenY + ((f.d || 0) - depth) / mpp;
            if (fcaY > -20 && fcaY < H + 20) { drawContactShadow(cx, ffx, fcaY, 82, 10, 0.24); drawVehicle(cx, ffx, fcaY, 'car', (f.x || 0)); }
        } else if (f.kind === 'umbrella') {
            var fuy = diverScreenY + (floorAt(f.x || 0) - depth) / mpp;  // sand line
            if (fuy > -120 && fuy < H + 40) drawUmbrella(cx, ffx, fuy);
        } else if (f.kind === 'towel') {
            var fty = diverScreenY + (floorAt(f.x || 0) - depth) / mpp;  // sand line
            if (fty > -40 && fty < H + 40) drawTowel(cx, ffx, fty);
        } else if (f.kind === 'buoy') {
            var fbuoyY = diverScreenY - depth / mpp;  // surface line
            if (fbuoyY > -60 && fbuoyY < H + 20) drawBuoy(cx, ffx, fbuoyY);
        } else if (f.kind === 'anchor') {
            var faY = diverScreenY + (floorAt(f.x || 0) - depth) / mpp;  // sand line
            // Larger anchors (e.g. the wreck's bow anchor) cull from higher up.
            var aMargin = 40 + (f.scale ? f.scale * 60 : 0);
            if (faY > -aMargin && faY < H + 40) { drawContactShadow(cx, ffx, faY, 46 * (f.scale || 1), 8 * (f.scale || 1), 0.22); drawAnchor(cx, ffx, faY, (f.x || 0), f.scale); }
        } else if (f.kind === 'pond') {
            var fpY = diverScreenY - depth / mpp;
            if (fpY > -60 && fpY < H + 20) drawPond(cx, ffx, fpY);
        } else if (f.kind === 'tableCoral') {
            var ty = diverScreenY + ((f.d || 0) - depth) / mpp;
            if (ty > -40 && ty < H + 40) { drawContactShadow(cx, ffx, ty, 72, 9, 0.18); drawTableCoral(cx, ffx, ty, (f.x || 0)); }
        } else if (f.kind === 'brainCoral') {
            var by2 = diverScreenY + ((f.d || 0) - depth) / mpp;
            if (by2 > -40 && by2 < H + 40) { drawContactShadow(cx, ffx, by2, 56, 8, 0.18); drawBrainCoral(cx, ffx, by2, (f.x || 0)); }
        } else if (f.kind === 'staghorn') {
            var sy = diverScreenY + ((f.d || 0) - depth) / mpp;
            if (sy > -40 && sy < H + 40) { drawContactShadow(cx, ffx, sy, 48, 7, 0.16); drawStaghorn(cx, ffx, sy, (f.x || 0)); }
        } else if (f.kind === 'softCoral') {
            var scy = diverScreenY + ((f.d || 0) - depth) / mpp;
            if (scy > -90 && scy < H + 40) { drawContactShadow(cx, ffx, scy, 42, 8, 0.14); drawSoftCoral(cx, ffx, scy, f.color, (f.x || 0)); }
        } else if (f.kind === 'gorgonian') {
            var gy = diverScreenY + ((f.d || 0) - depth) / mpp;
            // Issue #59: `f.scale` (optional) lets a single hand-placed hero
            // gorgonian read distinctly larger than the coralVariation range.
            var gScale = (typeof f.scale === 'number') ? f.scale : 1;
            var gShadowW = 44 * gScale, gShadowH = 9 * Math.sqrt(gScale);
            var gCull = 160 * Math.max(1, gScale);
            if (gy > -gCull && gy < H + gCull) { drawContactShadow(cx, ffx, gy, gShadowW, gShadowH, 0.15); drawGorgonian(cx, ffx, gy, f.side, f.color, (f.x || 0), f.scale); }
        } else if (f.kind === 'barrelSponge') {
            var bsy = diverScreenY + ((f.d || 0) - depth) / mpp;
            if (bsy > -80 && bsy < H + 40) { drawContactShadow(cx, ffx, bsy, 42, 9, 0.17); drawBarrelSponge(cx, ffx, bsy, f.color, (f.x || 0)); }
        } else if (f.kind === 'anthiasCloud') {
            var acy = diverScreenY + ((f.d || 0) - depth) / mpp;
            if (acy > -200 && acy < H + 200) drawAnthiasCloud(cx, ffx, acy, f);
        } else if (f.kind === 'bunk') {
            var fby = diverScreenY + ((f.d || 0) - depth) / mpp;
            if (fby > -40 && fby < H + 40) { drawContactShadow(cx, ffx, fby, 48, 7, 0.18); drawBunk(cx, ffx, fby); }
        } else if (f.kind === 'container') {
            var fcoy = diverScreenY + ((f.d || 0) - depth) / mpp;
            if (fcoy > -60 && fcoy < H + 60) { drawContactShadow(cx, ffx, fcoy, 96, 10, 0.22); drawContainer(cx, ffx, fcoy, f.color); }
        } else if (f.kind === 'engine') {
            var fegy = diverScreenY + ((f.d || 0) - depth) / mpp;
            if (fegy > -80 && fegy < H + 80) { drawContactShadow(cx, ffx, fegy, 78, 10, 0.24); drawEngine(cx, ffx, fegy); }
        } else if (f.kind === 'messTable') {
            var fmy = diverScreenY + ((f.d || 0) - depth) / mpp;
            if (fmy > -30 && fmy < H + 30) drawMessTable(cx, ffx, fmy);
        } else if (f.kind === 'helm') {
            var fhy = diverScreenY + ((f.d || 0) - depth) / mpp;
            if (fhy > -60 && fhy < H + 60) drawHelm(cx, ffx, fhy);
        } else if (f.kind === 'lifeboat') {
            var flby = diverScreenY + ((f.d || 0) - depth) / mpp;
            if (flby > -40 && flby < H + 40) drawLifeboat(cx, ffx, flby);
        } else if (f.kind === 'bowVisor') {
            var fbvy = diverScreenY + ((f.d || 0) - depth) / mpp;
            if (fbvy > -60 && fbvy < H + 60) drawBowVisor(cx, ffx, fbvy);
        } else if (f.kind === 'rustHole') {
            var fry = diverScreenY + ((f.d || 0) - depth) / mpp;
            if (fry > -30 && fry < H + 30) drawRustHole(cx, ffx, fry);
        } else if (f.kind === 'line') {
            // Issue #33: sagging line — cosmetic only, no collision.
            var flnY = diverScreenY + ((f.d || 0) - depth) / mpp;
            if (flnY > -60 && flnY < H + 120) drawHangingLine(cx, ffx, flnY, (f.x || 0), f);
        } else if (f.kind === 'net') {
            // Issue #33: hanging net — cosmetic only, no collision.
            var fnetY = diverScreenY + ((f.d || 0) - depth) / mpp;
            if (fnetY > -60 && fnetY < H + 200) drawNet(cx, ffx, fnetY, (f.x || 0), f);
        } else if (f.kind === 'caveColumn') {
            // Issue #59: hand-placed cathedral columns. Reuses #32's
            // _drawSpeleothemColumn so the shape stays consistent with the
            // ambient speleothem field. Purely cosmetic — no collision.
            // Feature fields: {x, dTop, dBottom, wTop, wBot, seed}.
            var fdTop = (typeof f.dTop === 'number') ? f.dTop : (f.d || 0);
            var fdBot = (typeof f.dBottom === 'number') ? f.dBottom : (f.d || 0) + 6;
            var ftopY = diverScreenY + (fdTop - depth) / mpp;
            var fbotY = diverScreenY + (fdBot - depth) / mpp;
            var fwTop = (typeof f.wTop === 'number') ? f.wTop : 8;
            var fwBot = (typeof f.wBot === 'number') ? f.wBot : 10;
            var fseed = (typeof f.seed === 'number') ? f.seed : (f.x || 0);
            if (fbotY > -40 && ftopY < H + 40) _drawSpeleothemColumn(cx, ffx, ftopY, fbotY, fwTop, fwBot, fseed);
        }
        if (_needsAlphaGate) cx.restore();
    }
}

function drawContactShadow(cx, x, y, w, h, alpha) {
    cx.save();
    var grad = cx.createRadialGradient(x, y, 1, x, y, Math.max(w * 0.55, h));
    grad.addColorStop(0, 'rgba(0,0,0,' + (alpha || 0.18).toFixed(3) + ')');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    cx.fillStyle = grad;
    cx.beginPath();
    cx.ellipse(x, y + 1, w * 0.55, h, 0, 0, Math.PI * 2);
    cx.fill();
    cx.restore();
}

// Issue #34 point 2: Draw a soft AO darkening band along a polyline.
//
// `points`   — array of [screenX, screenY] pairs (already computed in world
//              → screen space by the caller, so the band is world-anchored).
// `cfg`      — one of CONTACT_AO.terrain / CONTACT_AO.structure.
//
// Uses canvas shadowBlur on a low-alpha stroke so the visible band is the
// blurred shadow, not the stroke itself. One draw call per polyline. No
// allocations. Safe to call with < 2 points (early return).
function drawContactBand(cx, points, cfg) {
    if (!points || points.length < 2) return;
    cx.save();
    cx.strokeStyle = 'rgba(0,0,0,' + cfg.strokeAlpha.toFixed(3) + ')';
    cx.lineWidth = cfg.strokeWidth;
    cx.lineCap = 'round';
    cx.lineJoin = 'round';
    cx.shadowColor = 'rgba(0,0,0,' + cfg.shadowAlpha.toFixed(3) + ')';
    cx.shadowBlur = cfg.blurRadius;
    cx.shadowOffsetX = 0;
    cx.shadowOffsetY = 0;
    cx.beginPath();
    cx.moveTo(points[0][0], points[0][1]);
    for (var i = 1; i < points.length; i++) {
        cx.lineTo(points[i][0], points[i][1]);
    }
    cx.stroke();
    cx.restore();
}

// ── Issue #56: Surface accumulation helpers ──────────────────────
// Shared, deterministic, render-only. No offscreen canvases, no
// Math.random() — all variation comes from sRand(seed). Every helper
// early-returns on intensity <= 0 so callers can pass a per-zone
// profile straight through without a guard at the call site.

// drawSedimentCap(cx, points, options)
//   points  — screen-space polyline of the TOP visible edge (already
//             computed in world→screen by the caller).
//   options — { intensity, thicknessM, mpp, worldSeed, palette }
// Renders a thin sediment band clipped to a constant-thickness strip
// BELOW the polyline (so it hugs the contour exactly), alpha-graded
// opaque at the surface to transparent at its lower edge, plus a
// handful of deterministic sediment grains scattered along the line.
// Never mutates `points`.
function drawSedimentCap(cx, points, options) {
    if (!options || options.intensity <= 0) return;
    if (!points || points.length < 2) return;
    var intensity = options.intensity;
    var mpp = options.mpp || MAT_MPP;
    var thicknessM = Math.min(
        options.thicknessM != null ? options.thicknessM : 0.25,
        ACCUMULATION_SEDIMENT_MAX_M
    );
    var thicknessPx = Math.max(1.5, thicknessM / mpp) * intensity;
    var worldSeed = options.worldSeed || 0;
    var pal = options.palette || ACCUMULATION_PAL;

    var minX = points[0][0], maxX = points[0][0];
    var minY = points[0][1], maxBottomY = points[0][1] + thicknessPx;
    for (var i = 1; i < points.length; i++) {
        if (points[i][0] < minX) minX = points[i][0];
        if (points[i][0] > maxX) maxX = points[i][0];
        if (points[i][1] < minY) minY = points[i][1];
        var bY = points[i][1] + thicknessPx;
        if (bY > maxBottomY) maxBottomY = bY;
    }

    cx.save();
    // Clip to a constant-thickness band hugging the polyline's contour:
    // top edge L→R along `points`, bottom edge R→L offset by thicknessPx.
    cx.beginPath();
    cx.moveTo(points[0][0], points[0][1]);
    for (var pi = 1; pi < points.length; pi++) cx.lineTo(points[pi][0], points[pi][1]);
    for (var pj = points.length - 1; pj >= 0; pj--) cx.lineTo(points[pj][0], points[pj][1] + thicknessPx);
    cx.closePath();
    cx.clip();

    var grad = cx.createLinearGradient(0, minY, 0, maxBottomY);
    grad.addColorStop(0, pal.sedimentFill || ACCUMULATION_PAL.sedimentFill);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    cx.globalAlpha = intensity;
    cx.fillStyle = grad;
    cx.fillRect(minX - 2, minY - 2, (maxX - minX) + 4, (maxBottomY - minY) + 4);

    // Thin sediment-color edge line right at the top of the cap.
    cx.strokeStyle = pal.sedimentEdge || ACCUMULATION_PAL.sedimentEdge;
    cx.lineWidth = 1.2;
    cx.beginPath();
    cx.moveTo(points[0][0], points[0][1]);
    for (var li = 1; li < points.length; li++) cx.lineTo(points[li][0], points[li][1]);
    cx.stroke();
    cx.restore();

    // Deterministic sediment grains distributed along the polyline —
    // drawn outside the clip/gradient save block (own alpha per grain).
    cx.save();
    var grainCount = Math.max(3, Math.min(24, Math.round(points.length * 0.5 * intensity)));
    for (var gi = 0; gi < grainCount; gi++) {
        var gseed = worldSeed + gi * 2.71;
        var t = sRand(gseed);
        var idxF = t * (points.length - 1);
        var idx0 = Math.floor(idxF);
        var idx1 = Math.min(points.length - 1, idx0 + 1);
        var frac = idxF - idx0;
        var gx = points[idx0][0] + (points[idx1][0] - points[idx0][0]) * frac;
        var gy = points[idx0][1] + (points[idx1][1] - points[idx0][1]) * frac;
        var goff = sRand(gseed + 4.19) * thicknessPx * 0.7;
        var gr = 0.8 + sRand(gseed + 6.53) * 1.6;
        cx.globalAlpha = intensity * (0.5 + sRand(gseed + 8.71) * 0.5);
        cx.fillStyle = pal.sedimentGrain || ACCUMULATION_PAL.sedimentGrain;
        cx.beginPath();
        cx.ellipse(gx, gy + goff, gr * 1.4, gr * 0.7, 0, 0, Math.PI * 2);
        cx.fill();
    }
    cx.restore();
}

// drawContactAccumulation(cx, points, options)
//   points  — screen-space polyline of the contact edge (structure
//             baseline OR wall/floor meeting line).
//   options — { intensity, mpp, worldSeed, side }
//     side: 'below' | 'above' (default 'above') — which side of the
//     line the rubble jitters toward.
//
// Issue #34 (drawContactBand / CONTACT_AO) already draws a soft dark
// AMBIENT-OCCLUSION band at these same edges: a low-alpha stroke with
// shadowBlur, reading as "this edge should look dark." This helper is
// deliberately built differently so it reads as "material has piled
// up here" instead of stacking a second dark band on top of #34's:
//   • warm sediment/rubble browns (ACCUMULATION_PAL), never pure black
//   • NO shadowBlur anywhere in this function (that is #34's signature)
//   • small irregular rubble ellipses + a thin flat sediment line,
//     not a single smooth uniform stroke
//   • the one pure-black darkening component uses ACCUMULATION_PAL
//     .contactDark, alpha 0.09 — well below CONTACT_AO.terrain's
//     shadowAlpha (0.42) / CONTACT_AO.structure's shadowAlpha (0.5)
// The two passes are meant to layer additively (#34 first, this pass
// second) without doubling up the darkness.
function drawContactAccumulation(cx, points, options) {
    if (!options || options.intensity <= 0) return;
    if (!points || points.length < 2) return;
    var intensity = options.intensity;
    var worldSeed = options.worldSeed || 0;
    var side = (options.side === 'below') ? 1 : -1;
    var pal = ACCUMULATION_PAL;

    cx.save();
    // Thin sediment-colored line along the contact edge — flat stroke,
    // no shadowBlur, warm brown — NOT #34's dark blurred band.
    cx.globalAlpha = intensity;
    cx.strokeStyle = pal.sedimentEdge;
    cx.lineWidth = 1.5;
    cx.lineCap = 'round';
    cx.lineJoin = 'round';
    cx.beginPath();
    cx.moveTo(points[0][0], points[0][1]);
    for (var i = 1; i < points.length; i++) cx.lineTo(points[i][0], points[i][1]);
    cx.stroke();

    // Very-low-alpha darkening component (alpha 0.09, see block comment
    // above) — nowhere near #34's shadowAlpha of 0.42/0.5.
    cx.strokeStyle = pal.contactDark;
    cx.lineWidth = 2.5;
    cx.beginPath();
    cx.moveTo(points[0][0], points[0][1]);
    for (var di = 1; di < points.length; di++) cx.lineTo(points[di][0], points[di][1]);
    cx.stroke();

    // Small irregular rubble ellipses scattered along the line.
    var totalLen = points.length - 1;
    var rubbleCount = Math.max(3, Math.min(18, Math.round(totalLen * 1.2 * intensity)));
    for (var ri = 0; ri < rubbleCount; ri++) {
        var rseed = worldSeed + ri * 4.19;
        var t = sRand(rseed);
        var idxF = t * totalLen;
        var idx0 = Math.floor(idxF);
        var idx1 = Math.min(points.length - 1, idx0 + 1);
        var frac = idxF - idx0;
        var rx = points[idx0][0] + (points[idx1][0] - points[idx0][0]) * frac;
        var ry = points[idx0][1] + (points[idx1][1] - points[idx0][1]) * frac;
        var jitterY = (1 + sRand(rseed + 6.53) * 2.5) * side;
        var rw = 1.5 + sRand(rseed + 8.31) * 3.5;
        var rh = 0.8 + sRand(rseed + 1.13) * 1.6;
        cx.globalAlpha = intensity * (0.5 + sRand(rseed + 2.91) * 0.5);
        cx.fillStyle = (sRand(rseed + 3.7) > 0.5) ? pal.rubbleDark : pal.rubbleMid;
        cx.beginPath();
        cx.ellipse(rx + (sRand(rseed + 5.1) - 0.5) * 4, ry + jitterY, rw, rh, 0, 0, Math.PI * 2);
        cx.fill();
    }
    cx.restore();
}

// drawVerticalStreaks(cx, bounds, options)
//   bounds  — { sx, sy, sw, sh } screen-space AABB of the panel (e.g.
//             a wreck hull/deck/bulkhead panel).
//   options — { intensity, worldSeed, variant, exterior }
//     variant  : 'rust' (default) | 'mineral'
//     exterior : true → adds a small biofouling-green tail to each
//                streak; false → pure rust/mineral only.
// Draws ACCUMULATION_STREAKS_MIN..MAX thin near-vertical streaks,
// clipped to `bounds`. Positions/lengths/alphas are all derived from
// sRand(worldSeed + i * prime) — no gradients per streak, cheap fillRect
// + a single thin quadratic path per streak for organic drift.
function drawVerticalStreaks(cx, bounds, options) {
    if (!options || options.intensity <= 0) return;
    if (!bounds || bounds.sw <= 0 || bounds.sh <= 0) return;
    var intensity = options.intensity;
    var worldSeed = options.worldSeed || 0;
    var variant = options.variant || 'rust';
    var exterior = !!options.exterior;
    var pal = ACCUMULATION_PAL;
    var sx = bounds.sx, sy = bounds.sy, sw = bounds.sw, sh = bounds.sh;

    var countF = ACCUMULATION_STREAKS_MIN + (ACCUMULATION_STREAKS_MAX - ACCUMULATION_STREAKS_MIN) * intensity;
    var count = Math.max(ACCUMULATION_STREAKS_MIN, Math.round(countF));

    cx.save();
    cx.beginPath(); cx.rect(sx, sy, sw, sh); cx.clip();

    for (var i = 0; i < count; i++) {
        var seed = worldSeed + i * 2.71;
        var fracX = sRand(seed);
        var x0 = sx + fracX * sw;
        var lenFrac = 0.4 + sRand(seed + 4.19) * 0.5;   // 40–90% of sh
        var len = sh * lenFrac;
        var y0 = sy + sRand(seed + 6.53) * Math.max(0, sh - len);
        var width = 1 + sRand(seed + 8.31);              // 1–2 px
        var alpha = intensity * (0.4 + sRand(seed + 1.91) * 0.5);
        var drift = (sRand(seed + 3.3) - 0.5) * width * 3;

        var color = (variant === 'mineral')
            ? pal.mineralPale
            : (sRand(seed + 5.7) > 0.5 ? pal.rustDark : pal.rustLight);
        cx.globalAlpha = alpha;
        cx.fillStyle = color;
        cx.fillRect(x0 - width / 2, y0, width, len);
        cx.strokeStyle = color;
        cx.lineWidth = width;
        cx.beginPath();
        cx.moveTo(x0, y0);
        cx.quadraticCurveTo(x0 + drift, y0 + len * 0.5, x0 + drift * 1.4, y0 + len);
        cx.stroke();

        if (exterior) {
            cx.globalAlpha = alpha * 0.6;
            cx.fillStyle = pal.growthOlive;
            cx.fillRect(x0 - width, y0 + len * 0.7, width * 2, len * 0.3);
        }
    }
    cx.restore();
}

// drawGrowthEdge(cx, points, options)
//   Small dark olive / coralline patches placed deterministically
//   along selected segments of a screen-space polyline. Coverage
//   stays low (sparse gate below) so this never competes with #35's
//   big coral objects or #55's props — it's a thin accent, not a
//   growth feature of its own.
function drawGrowthEdge(cx, points, options) {
    if (!options || options.intensity <= 0) return;
    if (!points || points.length < 2) return;
    var intensity = options.intensity;
    var worldSeed = options.worldSeed || 0;
    var variant = options.variant || 'olive';
    var pal = ACCUMULATION_PAL;

    cx.save();
    var totalLen = points.length - 1;
    var patchCount = Math.max(1, Math.min(10, Math.round(totalLen * 0.3 * intensity)));
    for (var i = 0; i < patchCount; i++) {
        var seed = worldSeed + i * 6.53;
        // Sparse gate — most candidate slots produce nothing.
        if (sRand(seed) > (0.25 + intensity * 0.35)) continue;
        var t = sRand(seed + 2.71);
        var idxF = t * totalLen;
        var idx0 = Math.floor(idxF);
        var idx1 = Math.min(points.length - 1, idx0 + 1);
        var frac = idxF - idx0;
        var px = points[idx0][0] + (points[idx1][0] - points[idx0][0]) * frac;
        var py = points[idx0][1] + (points[idx1][1] - points[idx0][1]) * frac;
        var pr = 1.5 + sRand(seed + 4.19) * 3;
        cx.globalAlpha = intensity * (0.5 + sRand(seed + 8.31) * 0.5);
        cx.fillStyle = (variant === 'coralline' && sRand(seed + 1.13) > 0.5)
            ? pal.growthCoralline : pal.growthOlive;
        cx.beginPath();
        cx.ellipse(px, py, pr * 1.3, pr * 0.7, sRand(seed + 3.3) * Math.PI, 0, Math.PI * 2);
        cx.fill();
    }
    cx.restore();
}

// Beach towel — striped mat lying flat on the sand.
function drawTowel(cx, x, y) {
    cx.save();
    var w = 26, h = 7;
    cx.translate(x, y - 1);
    cx.rotate(-0.05);
    // mat base
    cx.fillStyle = '#e8e2d0';
    cx.fillRect(-w / 2, -h, w, h);
    // stripes
    var stripes = ['#e44', '#49c', '#fc3', '#4a4'];
    for (var i = 0; i < 5; i++) {
        cx.fillStyle = stripes[i % stripes.length];
        cx.fillRect(-w / 2 + 2 + i * (w - 4) / 5, -h + 1, (w - 4) / 5 - 1, h - 2);
    }
    cx.strokeStyle = 'rgba(0,0,0,0.2)'; cx.lineWidth = 1;
    cx.strokeRect(-w / 2, -h, w, h);
    cx.restore();
}

// Beach parasol — pole with a scalloped red/white canopy.
function drawUmbrella(cx, x, y) {
    cx.save();
    cx.translate(x, y);
    // pole
    cx.strokeStyle = '#8a6a3a'; cx.lineWidth = 2.5; cx.lineCap = 'round';
    cx.beginPath(); cx.moveTo(0, 0); cx.lineTo(-6, -46); cx.stroke();
    // canopy — scalloped dome, alternating red / white wedges
    var cxn = -6, cyn = -46, rad = 26, segs = 6;
    for (var i = 0; i < segs; i++) {
        var a0 = Math.PI + i * (Math.PI / segs);
        var a1 = Math.PI + (i + 1) * (Math.PI / segs);
        cx.fillStyle = (i % 2 === 0) ? '#e23b3b' : '#f4f4f4';
        cx.beginPath();
        cx.moveTo(cxn, cyn);
        cx.arc(cxn, cyn, rad, a0, a1);
        cx.closePath();
        cx.fill();
    }
    // scalloped lower rim
    cx.fillStyle = 'rgba(0,0,0,0.12)';
    for (var s = 0; s < segs; s++) {
        var mx = cxn + Math.cos(Math.PI + (s + 0.5) * (Math.PI / segs)) * rad;
        cx.beginPath(); cx.arc(mx, cyn, 3, 0, Math.PI); cx.fill();
    }
    // finial
    cx.fillStyle = '#8a6a3a';
    cx.beginPath(); cx.arc(cxn, cyn - 2, 2.5, 0, Math.PI * 2); cx.fill();
    cx.restore();
}

function drawSeagrass(cx, x, y, worldX) {
    cx.save();
    cx.strokeStyle = '#2d6a2d';
    cx.lineWidth = 2;
    // Seed from the feature's world-x so the same tuft has the same
    // phase across camera movement. Fall back to screen-x only if the
    // caller has not been updated (defensive; every current call site
    // passes worldX).
    var seedBase = (worldX == null ? x : worldX);
    var profile = SWAY_PROFILES.seagrass;
    for (var i = -2; i <= 2; i++) {
        var bx = x + i * 6;
        // Per-blade phase from world-x + blade index → neighbouring
        // tufts at different world positions never move in unison.
        var seed = seedBase * 0.31 + i * 0.71;
        var swMid = sampleEnvironmentSway(seed, profile, 0.5);
        var swTip = sampleEnvironmentSway(seed, profile, 1.0);
        cx.beginPath();
        cx.moveTo(bx, y);  // foot pixel-fixed (heightFactor 0 → zero sway)
        cx.quadraticCurveTo(
            bx + 3 + swMid.x, y - 12 + swMid.y,
            bx + (i % 2 === 0 ? 2 : -2) + swTip.x, y - 22 + swTip.y
        );
        cx.stroke();
    }
    cx.restore();
}

// Set a centred font that is guaranteed to fit `maxW`, shrinking the size
// only if the natural width would overflow. Keeps sign text legible AND
// inside its plaque at any zoom.
function setFittedFont(cx, text, maxW, px, weight) {
    var suffix = 'px "Barlow Semi Condensed", sans-serif';
    cx.font = (weight ? weight + ' ' : '') + px + suffix;
    var w = cx.measureText(text).width;
    if (w > maxW) {
        px = px * maxW / w;
        cx.font = (weight ? weight + ' ' : '') + px.toFixed(2) + suffix;
    }
}

// Cave warning sign — the classic "Grim Reaper" cave-diving sign: a yellow
// caution triangle with a skull, a red STOP banner, and a white plaque, all
// mounted on a post planted in a rock cairn at the cave mouth. Plaque text is
// auto-fitted so it never overflows the sign.
function drawWarningSign(cx, x, y) {
    cx.save();
    cx.textAlign = 'center';
    cx.lineJoin = 'round';

    // ── rock cairn base ──
    cx.fillStyle = CAVE_PAL.rockShade;
    cx.beginPath(); cx.ellipse(x, y, 22, 4, 0, 0, Math.PI * 2); cx.fill();
    cx.fillStyle = CAVE_PAL.rockWarm;
    cx.beginPath();
    cx.moveTo(x - 18, y);
    cx.quadraticCurveTo(x - 14, y - 9, x - 6, y - 10);
    cx.quadraticCurveTo(x + 8, y - 11, x + 16, y - 6);
    cx.quadraticCurveTo(x + 20, y - 1, x + 14, y);
    cx.closePath(); cx.fill();

    // ── metal post (behind the sign plates) ──
    cx.fillStyle = '#2a2620';
    cx.fillRect(x - 1.4, y - 52, 2.8, 52);
    cx.fillStyle = 'rgba(58,74,40,0.55)';   // algae on lower post
    cx.fillRect(x - 1.4, y - 16, 2.8, 12);

    // ── white plaque (bottom plate) ──
    var plX = x - 30, plW = 60, plY = y - 38, plH = 20;
    cx.fillStyle = CAVE_PAL.signWhite;
    cx.fillRect(plX, plY, plW, plH);
    cx.strokeStyle = CAVE_PAL.signBlack; cx.lineWidth = 0.9;
    cx.strokeRect(plX, plY, plW, plH);
    var pad = plW - 8;                       // usable text width
    cx.fillStyle = CAVE_PAL.signBlack;
    setFittedFont(cx, 'DIVERS HAVE DIED HERE', pad, 6, 'bold');
    cx.fillText('DIVERS HAVE DIED HERE', x, plY + 8.5);
    setFittedFont(cx, 'GO NO FARTHER', pad, 6, 'bold');
    cx.fillText('GO NO FARTHER', x, plY + 16);

    // ── red STOP banner (above the plaque) ──
    var sbX = x - 24, sbW = 48, sbY = y - 50, sbH = 11;
    cx.fillStyle = CAVE_PAL.signRed;
    cx.fillRect(sbX, sbY, sbW, sbH);
    cx.strokeStyle = CAVE_PAL.signBlack; cx.lineWidth = 1;
    cx.strokeRect(sbX, sbY, sbW, sbH);
    cx.fillStyle = CAVE_PAL.signWhite;
    setFittedFont(cx, 'STOP', sbW - 8, 8.5, 'bold');
    cx.fillText('STOP', x, sbY + 8.5);

    // ── yellow caution triangle with skull (top plate) ──
    var apexY = y - 90, baseY = y - 52, half = 24;
    cx.fillStyle = CAVE_PAL.signYellow;
    cx.strokeStyle = CAVE_PAL.signBlack; cx.lineWidth = 2.4;
    cx.beginPath();
    cx.moveTo(x, apexY);
    cx.lineTo(x + half, baseY);
    cx.lineTo(x - half, baseY);
    cx.closePath(); cx.fill(); cx.stroke();
    // inner rim
    cx.strokeStyle = 'rgba(10,10,10,0.5)'; cx.lineWidth = 0.9;
    cx.beginPath();
    cx.moveTo(x, apexY + 5);
    cx.lineTo(x + half - 5, baseY - 3);
    cx.lineTo(x - half + 5, baseY - 3);
    cx.closePath(); cx.stroke();

    // ── skull glyph centred in the triangle ──
    var sx = x, sy = y - 64;
    cx.fillStyle = CAVE_PAL.signBlack;
    cx.beginPath();
    cx.moveTo(sx - 6.4, sy - 1);
    cx.quadraticCurveTo(sx - 6.4, sy - 8.4, sx, sy - 8.4);
    cx.quadraticCurveTo(sx + 6.4, sy - 8.4, sx + 6.4, sy - 1);
    cx.lineTo(sx + 6.4, sy + 3.4);
    cx.quadraticCurveTo(sx + 6.2, sy + 5.8, sx + 4, sy + 6.2);
    cx.lineTo(sx - 4, sy + 6.2);
    cx.quadraticCurveTo(sx - 6.2, sy + 5.8, sx - 6.4, sy + 3.4);
    cx.closePath(); cx.fill();
    // eye sockets (cut the yellow back through)
    cx.fillStyle = CAVE_PAL.signYellow;
    cx.beginPath(); cx.ellipse(sx - 2.7, sy - 2, 1.5, 1.9, 0, 0, Math.PI * 2); cx.fill();
    cx.beginPath(); cx.ellipse(sx + 2.7, sy - 2, 1.5, 1.9, 0, 0, Math.PI * 2); cx.fill();
    // nasal triangle
    cx.beginPath();
    cx.moveTo(sx - 0.9, sy + 1.7); cx.lineTo(sx + 0.9, sy + 1.7); cx.lineTo(sx, sy + 3.4);
    cx.closePath(); cx.fill();
    // jaw teeth bar
    cx.fillStyle = CAVE_PAL.signBlack;
    cx.fillRect(sx - 4, sy + 6.8, 8, 1.9);
    cx.fillStyle = CAVE_PAL.signYellow;
    cx.fillRect(sx - 2.5, sy + 6.8, 0.6, 1.9);
    cx.fillRect(sx - 0.7, sy + 6.8, 0.6, 1.9);
    cx.fillRect(sx + 1.1, sy + 6.8, 0.6, 1.9);

    cx.textAlign = 'left';
    cx.restore();
}

function drawThermocline(cx, thd) {
    var W = cssWidth, H = cssHeight;
    var diverScreenY = H * 0.45, mpp = 0.05;
    var thy = diverScreenY + (thd - depth) / mpp;
    if (thy < -5 || thy > H + 5) return;
    cx.save();
    cx.strokeStyle = 'rgba(100,180,255,0.3)';
    cx.lineWidth = 3;
    cx.setLineDash([8, 4]);
    cx.beginPath();
    cx.moveTo(0, thy);
    cx.lineTo(W, thy);
    cx.stroke();
    cx.setLineDash([]);
    cx.restore();
}

// ── Reef redesign: dedicated coral / sponge / cloud drawers ──
// All read REEF_PAL (constants.js) and waveTime (state.js) from outer scope.

// ── Issue #35: per-instance coral variation ──────────────────────
// Pure, deterministic helpers consumed by drawTableCoral/drawBrainCoral/
// drawStaghorn/drawSoftCoral/drawGorgonian/drawBarrelSponge so every
// instance of the same species reads as an individual (different scale,
// mirrored where geometrically sensible, subtle hue/brightness shift,
// small shape tweak) without duplicating drawers. Reuses the project-
// wide sRand() helper — never Math.random(). Sits ON TOP of the #57
// sway system for softCoral/gorgonian — the sway math itself is
// untouched, it just draws under the additional cx.scale() transform.
const CORAL_SCALE_MIN = 0.80;
const CORAL_SCALE_MAX = 1.25;
const CORAL_BRIGHTNESS_RANGE = 0.10;   // ±0.10 lightness
const CORAL_HUE_SHIFT_DEG    = 12;     // ±12°

function coralVariation(seed) {
    var s = (typeof seed === 'number') ? seed : 0;
    var r1 = sRand(s * 0.913 + 1.71);
    var r2 = sRand(s * 1.317 + 3.29);
    var r3 = sRand(s * 0.427 + 5.71);
    var r4 = sRand(s * 1.913 + 7.23);
    var r5 = sRand(s * 2.311 + 9.17);
    return {
        seed: s,
        scale:      CORAL_SCALE_MIN + r1 * (CORAL_SCALE_MAX - CORAL_SCALE_MIN),
        mirror:     r2 < 0.5 ? -1 : 1,
        brightness: 1 - CORAL_BRIGHTNESS_RANGE + r3 * (2 * CORAL_BRIGHTNESS_RANGE),
        hueShift:   (r4 - 0.5) * 2 * CORAL_HUE_SHIFT_DEG,
        shape:      r5    // 0..1, drawers use this for small extra shape tweaks
    };
}

// Hex -> HSL -> tint -> hex. Pure. Handles #rgb and #rrggbb. Returns null
// for non-hex input so callers can fall back to the untouched color.
function tintCoralColor(hexColor, brightness, hueShiftDeg) {
    if (typeof hexColor !== 'string') return null;
    var hex = hexColor.trim();
    if (hex[0] !== '#') return null;
    hex = hex.slice(1);
    if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
    if (hex.length !== 6) return null;
    var r = parseInt(hex.slice(0,2), 16) / 255;
    var g = parseInt(hex.slice(2,4), 16) / 255;
    var b = parseInt(hex.slice(4,6), 16) / 255;
    var max = Math.max(r,g,b), min = Math.min(r,g,b);
    var h = 0, s = 0;
    var l0 = (max + min) / 2;
    if (max !== min) {
        var d = max - min;
        s = l0 > 0.5 ? d / (2 - max - min) : d / (max + min);
        if (max === r) { h = ((g - b) / d + (g < b ? 6 : 0)); }
        else if (max === g) { h = ((b - r) / d + 2); }
        else { h = ((r - g) / d + 4); }
        h *= 60;
    }
    // apply shifts
    h = (h + hueShiftDeg + 360) % 360;
    var l = Math.max(0, Math.min(1, l0 * (brightness || 1)));
    // HSL -> RGB
    function hue2rgb(p, q, t) {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1/6) return p + (q - p) * 6 * t;
        if (t < 1/2) return q;
        if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
        return p;
    }
    var R, G, B;
    if (s === 0) { R = G = B = l; }
    else {
        var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        var p = 2 * l - q;
        R = hue2rgb(p, q, h/360 + 1/3);
        G = hue2rgb(p, q, h/360);
        B = hue2rgb(p, q, h/360 - 1/3);
    }
    function to2(v) {
        var n = Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16);
        return n.length === 1 ? '0' + n : n;
    }
    return '#' + to2(R) + to2(G) + to2(B);
}

function drawTableCoral(cx, x, y, seed) {
    var v = coralVariation(seed);
    cx.save();
    cx.translate(x, y);
    cx.scale(v.mirror * v.scale, v.scale);
    cx.lineCap = 'round';
    var w = 90, h = 22;
    // flat cap ellipse
    cx.fillStyle = tintCoralColor(REEF_PAL.tableCoral, v.brightness, v.hueShift) || REEF_PAL.tableCoral;
    cx.beginPath(); cx.ellipse(0, -h, w/2, h/2.2, 0, 0, Math.PI*2); cx.fill();
    // highlight
    cx.fillStyle = tintCoralColor(REEF_PAL.tableHi, v.brightness, v.hueShift) || REEF_PAL.tableHi; cx.globalAlpha = 0.6;
    cx.beginPath(); cx.ellipse(0, -h-3, w/2-3, h/2.6, 0, 0, Math.PI*2); cx.fill();
    cx.globalAlpha = 1;
    // stalk (structural — untinted)
    cx.fillStyle = '#6a4a26';
    cx.fillRect(-5, -h, 10, h);
    // foot (structural — untinted)
    cx.globalAlpha = 0.7;
    cx.fillRect(-12, -h*0.4, 24, h*0.3);
    cx.globalAlpha = 1;
    cx.restore();
}

function drawBrainCoral(cx, x, y, seed) {
    var v = coralVariation(seed);
    cx.save();
    cx.translate(x, y);
    cx.scale(v.mirror * v.scale, v.scale);
    var w = 60;
    // outer ellipse
    cx.fillStyle = tintCoralColor(REEF_PAL.brainCoral, v.brightness, v.hueShift) || REEF_PAL.brainCoral;
    cx.beginPath(); cx.ellipse(0, 0, w/2, w/3.5, 0, 0, Math.PI*2); cx.fill();
    // highlight
    cx.fillStyle = tintCoralColor(REEF_PAL.brainHi, v.brightness, v.hueShift) || REEF_PAL.brainHi; cx.globalAlpha = 0.6;
    cx.beginPath(); cx.ellipse(0, -4, w/2-4, w/4, 0, 0, Math.PI*2); cx.fill();
    cx.globalAlpha = 1;
    // gyri lines
    cx.strokeStyle = '#6a4a26'; cx.lineWidth = 0.9; cx.globalAlpha = 0.6;
    for (var i = 0; i < 7; i++) {
        var yo = -8 + i * 2.5;
        cx.beginPath();
        cx.moveTo(-w/2+5, yo);
        cx.quadraticCurveTo(-w/6, yo-3, 0, yo);
        cx.quadraticCurveTo(w/6, yo+3, w/3, yo);
        cx.stroke();
    }
    cx.globalAlpha = 1;
    cx.restore();
}

function drawStaghorn(cx, x, y, seed) {
    var v = coralVariation(seed);
    cx.save();
    cx.translate(x, y);
    cx.scale(v.mirror * v.scale, v.scale);
    cx.lineCap = 'round';
    var tintedStaghorn = tintCoralColor(REEF_PAL.staghorn, v.brightness, v.hueShift) || REEF_PAL.staghorn;
    // branch count: 4, 5, or 6 based on shape variation
    var branchCount = 4 + Math.floor(v.shape * 3);
    for (var i = 0; i < branchCount; i++) {
        // even spread across [-20, 20] so coral width stays constant with more branches
        var ox = Math.round(-20 + (40 / (branchCount - 1)) * i);
        // per-branch curl direction — use a seed derived from parent seed so
        // mirroring feels less mechanical than a plain i%2 pattern
        var curlSeed = sRand(v.seed + i * 0.317 + 2.11);
        var curl = (curlSeed < 0.5) ? -4 : 4;
        var tipX = ox + (curlSeed < 0.5 ? -2 : 2);
        // antler branch
        cx.strokeStyle = tintedStaghorn; cx.lineWidth = 3;
        cx.beginPath(); cx.moveTo(ox, 0);
        cx.quadraticCurveTo(ox + curl, -22, tipX, -34);
        cx.stroke();
        // tip circle
        cx.fillStyle = tintedStaghorn;
        cx.beginPath(); cx.arc(tipX, -34, 3, 0, Math.PI*2); cx.fill();
        cx.fillStyle = '#fff'; cx.globalAlpha = 0.6;
        cx.beginPath(); cx.arc(tipX, -34, 1.4, 0, Math.PI*2); cx.fill();
        cx.globalAlpha = 1;
    }
    cx.restore();
}

function drawSoftCoral(cx, x, y, color, worldX) {
    // Issue #35: per-instance variation layered ON TOP of #57 sway.
    // v.scale + v.mirror wrap the whole drawer as a cx transform so
    // the sway math (unchanged below) draws under it automatically.
    var v = coralVariation(worldX);
    cx.save();
    cx.translate(x, y);
    cx.scale(v.mirror * v.scale, v.scale);
    cx.lineCap = 'round';
    var col = color || REEF_PAL.softPink;
    col = tintCoralColor(col, v.brightness, v.hueShift) || col;
    var h = 70;
    var stalks = [-12, -2, 8, 16];
    // World-x seed keeps phase stable across camera; per-stalk offset
    // keeps the 4 stalks of one coral from moving as one plane.
    var seedBase = (worldX == null ? x : worldX);
    var profile = SWAY_PROFILES.softCoral;
    for (var i = 0; i < stalks.length; i++) {
        var ox = stalks[i];
        var seed = seedBase * 0.19 + i * 1.13;
        var swMid = sampleEnvironmentSway(seed, profile, 0.5);
        var swTip = sampleEnvironmentSway(seed, profile, 1.0);
        cx.strokeStyle = col; cx.lineWidth = 5; cx.globalAlpha = 0.85;
        cx.beginPath(); cx.moveTo(ox, 0);  // foot pixel-fixed
        cx.quadraticCurveTo(
            ox - 2 + swMid.x, -h * 0.5 + swMid.y,
            ox     + swTip.x, -h       + swTip.y
        );
        cx.stroke();
        cx.globalAlpha = 1;
        // Polyps sit on the stalk — sample the sway at each polyp's
        // height with the SAME per-stalk seed so they track the stalk
        // rather than drift off it.
        var polyps = [0.3, 0.55, 0.8];
        for (var j = 0; j < polyps.length; j++) {
            var t = polyps[j];
            var swP = sampleEnvironmentSway(seed, profile, t);
            var py = -h * t + swP.y;
            var pr = 2.2 + (1 - t) * 1.2;
            cx.fillStyle = col;
            cx.beginPath(); cx.arc(ox - 1 + swP.x, py, pr, 0, Math.PI * 2); cx.fill();
            cx.strokeStyle = '#fff'; cx.lineWidth = 0.4; cx.globalAlpha = 0.6;
            cx.stroke();
            cx.globalAlpha = 1;
        }
    }
    cx.restore();
}

function drawGorgonian(cx, x, y, side, color, worldX, scaleOverride) {
    // Issue #35: per-instance variation layered ON TOP of #57 sway.
    // No mirror here — `side` already anchors direction to the wall.
    // Issue #59: `scaleOverride` (optional) replaces the coralVariation
    // scale entirely so a single hero gorgonian can read distinctly larger
    // than the [0.80, 1.25] variation range. Undefined → normal variation.
    var v = coralVariation(worldX);
    var drawScale = (typeof scaleOverride === 'number') ? scaleOverride : v.scale;
    cx.save();
    cx.translate(x, y);
    cx.scale(drawScale, drawScale);
    cx.lineCap = 'round';
    var col = color || REEF_PAL.gorgBright;
    col = tintCoralColor(col, v.brightness, v.hueShift) || col;
    var sign = (side === 'right') ? 1 : -1;
    var h = 140;
    // Gorgonian is deliberately near-rigid: profile flex 0.25, amp 2px.
    // Base at (0,0) stays fixed; only outer tips move minimally. No
    // whole-object rotation — every segment anchors at (0,0) directly.
    var seedBase = (worldX == null ? x : worldX);
    var profile = SWAY_PROFILES.gorgonian;
    // trunk — base fixed; mid + outer control points get tiny sway
    var trunkSeed = seedBase * 0.27 + 0.53;
    var swTrunkMid = sampleEnvironmentSway(trunkSeed, profile, 0.5);
    var swTrunkTip = sampleEnvironmentSway(trunkSeed, profile, 1.0);
    cx.strokeStyle = col; cx.lineWidth = 4; cx.globalAlpha = 0.7;
    cx.beginPath(); cx.moveTo(0, 0);
    cx.quadraticCurveTo(
        sign * 18 + swTrunkMid.x, -h * 0.35 + swTrunkMid.y,
        sign * 28 + swTrunkTip.x, -h * 0.65 + swTrunkTip.y
    );
    cx.stroke();
    cx.globalAlpha = 1;
    // branches — fan from straight-up (t=0) to horizontal outward (t=1).
    // All branches point into open water (away from the wall) so they never
    // cross the rock face and appear to change shape as the camera scrolls.
    // Each branch has its own per-index phase → the fan does NOT move as
    // one flat plane; the whole fan looks alive without any single object
    // rotating.
    for (var i = 0; i < 14; i++) {
        var t = i / 13;
        // ang: 0 = vertical up, PI/2 = horizontal outward
        var ang = t * Math.PI * 0.5;
        var len = h * (0.55 + Math.sin(t * Math.PI) * 0.3);
        var x2 = sign * Math.sin(ang) * len * 0.75;
        var y2 = -Math.cos(ang) * len;
        var branchSeed = seedBase * 0.27 + i * 0.53;
        var swBrMid = sampleEnvironmentSway(branchSeed, profile, 0.5);
        var swBrTip = sampleEnvironmentSway(branchSeed, profile, 1.0);
        cx.strokeStyle = col; cx.lineWidth = 2.2; cx.globalAlpha = 0.92;
        cx.beginPath(); cx.moveTo(0, 0);  // branch base pixel-fixed
        cx.quadraticCurveTo(
            sign * Math.sin(ang) * len * 0.25 + swBrMid.x, -len * 0.5 + swBrMid.y,
            x2 + swBrTip.x, y2 + swBrTip.y
        );
        cx.stroke();
        // twig — a stiff extension attached 70% out along the branch.
        // Same seed as its parent branch → moves as a rigid extension,
        // stays visibly connected to the branch geometry.
        var swTwigBase = sampleEnvironmentSway(branchSeed, profile, 0.7);
        var swTwigMid  = sampleEnvironmentSway(branchSeed, profile, 0.85);
        var swTwigTip  = sampleEnvironmentSway(branchSeed, profile, 1.0);
        cx.lineWidth = 1.1; cx.globalAlpha = 0.8;
        cx.beginPath();
        cx.moveTo(x2 * 0.7 + swTwigBase.x, y2 * 0.7 + swTwigBase.y);
        cx.quadraticCurveTo(
            x2 * 0.7 + sign * 6  + swTwigMid.x, y2 * 0.7 - 4 + swTwigMid.y,
            x2 * 0.7 + sign * 14 + swTwigTip.x, y2 * 0.7 - 8 + swTwigTip.y
        );
        cx.stroke();
        cx.globalAlpha = 1;
    }
    cx.restore();
}

function drawBarrelSponge(cx, x, y, color, seed) {
    var v = coralVariation(seed);
    cx.save();
    cx.translate(x, y);
    cx.scale(v.mirror * v.scale, v.scale);
    var col = color || REEF_PAL.barrel1;
    col = tintCoralColor(col, v.brightness, v.hueShift) || col;
    var w = 36, h = 60;
    // tapered barrel body
    cx.fillStyle = col;
    cx.beginPath();
    cx.moveTo(-w/2, 0);
    cx.quadraticCurveTo(-w/2, -h, w*0.1-w/2, -h);
    cx.lineTo(w/2 - w*0.1, -h);
    cx.quadraticCurveTo(w/2, -h, w/2, 0);
    cx.closePath();
    cx.fill();
    // dark mouth
    cx.fillStyle = '#1a0a04'; cx.globalAlpha = 0.7;
    cx.beginPath(); cx.ellipse(0, -h, w/2-2, 6, 0, 0, Math.PI*2); cx.fill();
    cx.globalAlpha = 1;
    cx.fillStyle = '#3a1a0c';
    cx.beginPath(); cx.ellipse(0, -h+1, w/2-5, 4, 0, 0, Math.PI*2); cx.fill();
    // ridges
    cx.strokeStyle = '#5a2818'; cx.lineWidth = 0.8;
    var ridges = [0.2, 0.45, 0.7];
    for (var i = 0; i < ridges.length; i++) {
        var ry = -h * ridges[i];
        cx.globalAlpha = 0.7;
        cx.beginPath(); cx.moveTo(-w/2+2, ry);
        cx.quadraticCurveTo(0, ry - 3, w-4-w/2+2, ry);
        cx.stroke();
    }
    cx.globalAlpha = 1;
    cx.restore();
}

function drawAnthiasCloud(cx, x, y, f) {
    cx.save();
    cx.translate(x, y);
    var count = f.count || 90;
    var w = f.w || 260;
    var h = f.h || 140;
    var dir = f.dir || 1;
    for (var i = 0; i < count; i++) {
        var u = Math.abs(Math.sin(i * 91.3) * 43758.5453) % 1;
        var v = Math.abs(Math.cos(i * 47.7) * 43758.5453) % 1;
        var fx = Math.pow(u, 1.3) * w * dir - w * dir * 0.5;
        var fy = (v - 0.5) * h + Math.sin(waveTime * 1.5 + i) * 1.5;
        var sz = 4 + (Math.sin(i * 13.1) * 0.5 + 0.5) * 4;
        var fishDir = Math.cos(i) > 0 ? 1 : -1;
        var alpha = sz < 5 ? 0.55 : 1.0;
        cx.save();
        cx.translate(fx, fy);
        cx.scale(fishDir, 1);
        cx.globalAlpha = alpha;
        // body — 3 stacked solid ellipses (cheaper than radial gradient)
        cx.fillStyle = REEF_PAL.anthiasCore;
        cx.beginPath(); cx.ellipse(0, 0, sz * 0.5, sz * 0.3, 0, 0, Math.PI*2); cx.fill();
        cx.fillStyle = REEF_PAL.anthias;
        cx.beginPath(); cx.ellipse(sz * 0.15, 0, sz * 0.7, sz * 0.45, 0, 0, Math.PI*2); cx.fill();
        cx.fillStyle = REEF_PAL.anthiasDeep;
        cx.beginPath(); cx.ellipse(-sz * 0.2, 0, sz * 0.35, sz * 0.25, 0, 0, Math.PI*2); cx.fill();
        // tail
        cx.fillStyle = REEF_PAL.anthias;
        cx.beginPath();
        cx.moveTo(-sz, 0); cx.lineTo(-sz*1.7, -sz*0.5); cx.lineTo(-sz*1.7, sz*0.5); cx.closePath(); cx.fill();
        // eye
        cx.fillStyle = '#0a0a0a';
        cx.beginPath(); cx.arc(sz * 0.55, -sz * 0.15, sz * 0.18, 0, Math.PI*2); cx.fill();
        // dorsal highlight
        cx.strokeStyle = REEF_PAL.anthiasLt; cx.lineWidth = 0.6;
        cx.beginPath(); cx.moveTo(-sz * 0.2, -sz * 0.55);
        cx.quadraticCurveTo(sz * 0.4, -sz * 0.5, sz * 0.7, -sz * 0.1); cx.stroke();
        cx.restore();
    }
    cx.restore();
}

// ── Task 9: Coral — varied species (branching / brain / fan / table / tube) ──
// worldSeed = stable world-x so the shape doesn't re-randomise while scrolling.
function drawCoral(cx, x, y, worldSeed) {
    cx.save();
    var seed = ((Math.floor((worldSeed || 0) * 7.3) % 100) + 100) % 100;
    var cols = ['#cc4433', '#cc6644', '#bb5588', '#dd7733', '#c84060',
                '#d98a2b', '#7a9b3c', '#b15fb0', '#e0a050'];
    var col = cols[seed % cols.length];
    var col2 = cols[(seed + 3) % cols.length];
    var species = seed % 5;
    cx.lineCap = 'round';

    if (species === 0) {
        // Branching (staghorn) — recursive forks with polyp tips
        cx.strokeStyle = col; cx.fillStyle = col;
        var branch = function(bx, by, angle, len, d) {
            if (d === 0 || len < 2) return;
            var ex = bx + Math.cos(angle) * len, ey = by + Math.sin(angle) * len;
            cx.lineWidth = d * 0.9;
            cx.beginPath(); cx.moveTo(bx, by); cx.lineTo(ex, ey); cx.stroke();
            if (d === 1) { cx.beginPath(); cx.arc(ex, ey, 2, 0, Math.PI * 2); cx.fill(); }
            var spread = 0.42 + sRand(seed + d * 7.3) * 0.2;
            branch(ex, ey, angle - spread, len * 0.62, d - 1);
            branch(ex, ey, angle + spread, len * 0.62, d - 1);
        };
        branch(x, y, -Math.PI / 2, 18 + sRand(seed) * 8, 4);
        branch(x + (sRand(seed + 1) * 16 - 8), y, -Math.PI / 2 + (sRand(seed + 2) * 0.6 - 0.3),
               12 + sRand(seed + 3) * 6, 3);
    } else if (species === 1) {
        // Brain coral — domed mound with winding grooves
        var br = 9 + sRand(seed) * 6;
        var bgr = cx.createRadialGradient(x - br * 0.3, y - br * 0.8, 1, x, y - br * 0.4, br * 1.4);
        bgr.addColorStop(0, col); bgr.addColorStop(1, col2);
        cx.fillStyle = bgr;
        cx.beginPath(); cx.arc(x, y, br, Math.PI, 0); cx.fill();
        cx.fillRect(x - br, y - 1, br * 2, 2);
        cx.strokeStyle = 'rgba(0,0,0,0.28)'; cx.lineWidth = 1;
        for (var g = -2; g <= 2; g++) {
            cx.beginPath();
            cx.arc(x + g * br * 0.32, y, br * (0.7 - Math.abs(g) * 0.12), Math.PI, 0);
            cx.stroke();
        }
    } else if (species === 2) {
        // Sea fan / gorgonian — flat fan of curved ribs
        cx.strokeStyle = col; cx.lineWidth = 1.6;
        var fh = 16 + sRand(seed) * 10, ribs = 7;
        for (var f = 0; f < ribs; f++) {
            var a = -Math.PI / 2 + (f - (ribs - 1) / 2) * 0.16;
            var ex2 = x + Math.cos(a) * fh, ey2 = y + Math.sin(a) * fh;
            cx.beginPath(); cx.moveTo(x, y);
            cx.quadraticCurveTo(x + Math.cos(a) * fh * 0.5 - 3, y + Math.sin(a) * fh * 0.5, ex2, ey2);
            cx.stroke();
        }
        // cross-weave
        cx.lineWidth = 0.8;
        for (var w2 = 0.4; w2 < 1; w2 += 0.3) {
            cx.beginPath(); cx.arc(x, y, fh * w2, -Math.PI * 0.78, -Math.PI * 0.22); cx.stroke();
        }
    } else if (species === 3) {
        // Table / plate coral — flat top on a short stalk
        cx.fillStyle = col;
        cx.fillRect(x - 2, y - 8, 4, 8);                 // stalk
        var tw = 13 + sRand(seed) * 7;
        cx.beginPath();
        cx.ellipse(x, y - 8, tw, 3.5, 0, 0, Math.PI * 2);
        cx.fill();
        cx.fillStyle = col2;
        cx.beginPath(); cx.ellipse(x, y - 9, tw * 0.8, 2, 0, 0, Math.PI * 2); cx.fill();
    } else {
        // Tube / barrel sponges — cluster of upright tubes
        var tubes = 3 + (seed % 3);
        for (var tb = 0; tb < tubes; tb++) {
            var tx = x + (tb - (tubes - 1) / 2) * 6;
            var th = 10 + sRand(seed + tb * 3.1) * 10;
            var tw2 = 3 + sRand(seed + tb) * 2;
            cx.fillStyle = tb % 2 ? col2 : col;
            cx.beginPath(); cx.roundRect(tx - tw2, y - th, tw2 * 2, th, [tw2, tw2, 0, 0]); cx.fill();
            cx.fillStyle = 'rgba(0,0,0,0.35)';
            cx.beginPath(); cx.ellipse(tx, y - th, tw2 * 0.7, 1.4, 0, 0, Math.PI * 2); cx.fill();
        }
    }
    cx.restore();
}

// ── Task 10: Vehicles — gradient body, windows, wheel arches, rust ──
// worldSeed = stable world-x so rust patches don't shimmer while scrolling.
function drawVehicle(cx, x, y, kind, worldSeed) {
    cx.save();
    var isLorry = kind === 'lorry';
    // Realistic footprints at mpp=0.05 (20 px/m): car ≈ 3.6 m long / 1.4 m body,
    // lorry ≈ 6.5 m long / 1.7 m box. y is the GROUND line — wheels rest on it.
    var bw = isLorry ? 130 : 72, bh = isLorry ? 34 : 22;
    var wheelR = isLorry ? 9 : 7;
    y = y - wheelR;                          // lift so the tyres sit on the floor
    var bx = x - bw / 2, by = y - bh;
    var seed = ((Math.floor((worldSeed || 0) * 5.1) % 80) + 80) % 80;
    // body
    var bg = cx.createLinearGradient(bx, by, bx, by + bh);
    bg.addColorStop(0, isLorry ? '#3e4a38' : '#3a3840');
    bg.addColorStop(0.5, isLorry ? '#2e3828' : '#2c2a32');
    bg.addColorStop(1, isLorry ? '#1e2418' : '#1c1a20');
    cx.fillStyle = bg;
    cx.beginPath(); cx.roundRect(bx, by, bw, bh, 2); cx.fill();
    if (isLorry) {
        var cabW = 36, cabH = 26;
        // load-bay ribs (box behind the cab)
        cx.strokeStyle = 'rgba(0,0,0,0.4)'; cx.lineWidth = 1.5;
        for (var r = 1; r < 7; r++) {
            var rx = bx + cabW + (bw - cabW) * r / 7;
            cx.beginPath(); cx.moveTo(rx, by + 1); cx.lineTo(rx, by + bh - 1); cx.stroke();
        }
        // cab
        var cabG = cx.createLinearGradient(bx, by - cabH, bx, by);
        cabG.addColorStop(0, '#353f2e'); cabG.addColorStop(1, '#232a1e');
        cx.fillStyle = cabG;
        cx.beginPath(); cx.roundRect(bx, by - cabH, cabW, cabH, [3, 3, 0, 0]); cx.fill();
        // cab window
        cx.fillStyle = 'rgba(20,50,70,0.88)';
        cx.beginPath(); cx.roundRect(bx + 3, by - cabH + 3, cabW - 9, cabH * 0.5, 1.5); cx.fill();
        cx.fillStyle = 'rgba(180,240,255,0.12)';
        cx.beginPath(); cx.roundRect(bx + 4, by - cabH + 4, 9, 4, 0.5); cx.fill();
        // headlight
        cx.fillStyle = 'rgba(120,140,90,0.8)';
        cx.beginPath(); cx.ellipse(bx + 4, by - 5, 3, 2.4, 0, 0, Math.PI * 2); cx.fill();
    } else {
        // car roof / greenhouse
        var roofW = bw * 0.62, roofX = x - roofW / 2, roofH = bh * 0.85;
        var roofG = cx.createLinearGradient(roofX, by - roofH, roofX, by);
        roofG.addColorStop(0, '#302e38'); roofG.addColorStop(1, '#222028');
        cx.fillStyle = roofG;
        cx.beginPath(); cx.roundRect(roofX, by - roofH, roofW, roofH, [4, 4, 0, 0]); cx.fill();
        // side windows
        cx.fillStyle = 'rgba(20,50,70,0.9)';
        cx.beginPath(); cx.roundRect(roofX + 2, by - roofH + 2, roofW / 2 - 3, roofH - 4, 1); cx.fill();
        cx.beginPath(); cx.roundRect(roofX + roofW / 2 + 1, by - roofH + 2, roofW / 2 - 3, roofH - 4, 1); cx.fill();
        cx.fillStyle = 'rgba(180,240,255,0.10)';
        cx.fillRect(roofX + 3, by - roofH + 3, 4, 2);
    }
    // rust patches
    cx.fillStyle = 'rgba(150,70,10,0.2)';
    cx.beginPath(); cx.ellipse(bx + bw * 0.3, by + bh * 0.6, bw * 0.1, bh * 0.3, 0, 0, Math.PI * 2); cx.fill();
    cx.beginPath(); cx.ellipse(bx + bw * 0.75, by + bh * 0.4, bw * 0.07 + sRand(seed) * 5, bh * 0.25, 0, 0, Math.PI * 2); cx.fill();
    // wheels (lorry gets a rear bogie)
    var wheels = isLorry ? [bx + 26, bx + bw * 0.6, bx + bw - 20] : [bx + 16, bx + bw - 16];
    for (var wi = 0; wi < wheels.length; wi++) {
        cx.fillStyle = 'rgba(0,0,0,0.65)';
        cx.beginPath(); cx.arc(wheels[wi], y, wheelR + 1, Math.PI, 0); cx.fill();
        cx.fillStyle = '#1a1a1a';
        cx.beginPath(); cx.arc(wheels[wi], y, wheelR, 0, Math.PI * 2); cx.fill();
        cx.strokeStyle = 'rgba(160,170,180,0.35)'; cx.lineWidth = 1.5;
        cx.beginPath(); cx.arc(wheels[wi], y, wheelR, 0, Math.PI * 2); cx.stroke();
        cx.fillStyle = 'rgba(160,170,180,0.4)';
        cx.beginPath(); cx.arc(wheels[wi], y, wheelR * 0.35, 0, Math.PI * 2); cx.fill();
    }
    cx.restore();
}

function drawBuoy(cx, x, y) {
    // SMB buoy + mooring line
    cx.save();
    cx.strokeStyle = 'rgba(255,200,100,0.5)';
    cx.lineWidth = 1;
    cx.setLineDash([3, 3]);
    cx.beginPath();
    cx.moveTo(x, y);
    cx.lineTo(x, y + 30);
    cx.stroke();
    cx.setLineDash([]);
    cx.fillStyle = '#ff6600';
    cx.beginPath();
    cx.ellipse(x, y - 8, 7, 10, 0, 0, Math.PI * 2);
    cx.fill();
    cx.fillStyle = '#ffaa44';
    cx.beginPath();
    cx.ellipse(x, y - 11, 3, 4, 0, 0, Math.PI * 2);
    cx.fill();
    cx.restore();
}

function drawPond(cx, x, y) {
    // Cenote pond entrance — a sunlit shaft of warm light pouring through
    // the open sinkhole, with a rimmed water surface and root strands.
    cx.save();
    var W = cssWidth, H = cssHeight;
    var mpp = 0.05;
    var diverScreenY = H * 0.45;
    var floorD = floorAt(x ? (diverX + (x - W * DIVER_SCREEN_X_FRACTION) * mpp) : diverX);
    // sunbeam cone — narrows at surface, fans out as it descends
    var beamTop = y - 6;
    var beamBot = diverScreenY + (Math.min(floorD, depth + 22) - depth) / mpp;
    if (beamBot < H + 20 && beamBot > beamTop + 6) {
        var bg = cx.createLinearGradient(0, beamTop, 0, beamBot);
        bg.addColorStop(0,   'rgba(255,245,216,0.75)');
        bg.addColorStop(0.5, 'rgba(188,229,216,0.30)');
        bg.addColorStop(1,   'rgba(168,208,200,0)');
        cx.fillStyle = bg;
        cx.globalCompositeOperation = 'lighter';
        cx.beginPath();
        cx.moveTo(x - 30, beamTop);
        cx.lineTo(x + 30, beamTop);
        cx.lineTo(x + 80, beamBot);
        cx.lineTo(x - 80, beamBot);
        cx.closePath();
        cx.fill();
        // a few thin god-rays inside the cone
        cx.strokeStyle = 'rgba(255,245,216,0.32)';
        cx.lineWidth = 1.4;
        for (var ri = -2; ri <= 2; ri++) {
            cx.beginPath();
            cx.moveTo(x + ri * 10, beamTop);
            cx.lineTo(x + ri * 30, beamBot);
            cx.stroke();
        }
        cx.globalCompositeOperation = 'source-over';
    }
    // dark earth lip on either side of the pond opening (the karst rim)
    cx.fillStyle = CAVE_PAL.earth;
    cx.fillRect(x - 80, y - 2, 30, 6);
    cx.fillRect(x + 50, y - 2, 30, 6);
    // root strands dangling from the rim into the water
    cx.strokeStyle = '#1a1208';
    cx.lineWidth = 1.1;
    cx.lineCap = 'round';
    for (var ri2 = 0; ri2 < 5; ri2++) {
        var rsX = x + (ri2 - 2) * 16 + (ri2 % 2 ? 4 : -4);
        if (rsX > x - 28 && rsX < x + 28) continue;  // skip the open shaft
        cx.beginPath();
        cx.moveTo(rsX, y - 1);
        cx.quadraticCurveTo(rsX + 2, y + 14, rsX - 1, y + 28);
        cx.stroke();
    }
    // water-line ripples across the open part
    cx.strokeStyle = 'rgba(232,244,232,0.65)';
    cx.lineWidth = 1.4;
    cx.beginPath();
    cx.ellipse(x, y, 36, 4, 0, 0, Math.PI * 2);
    cx.stroke();
    cx.strokeStyle = 'rgba(232,244,232,0.3)';
    cx.beginPath();
    cx.ellipse(x, y + 2, 30, 3, 0, 0, Math.PI * 2);
    cx.stroke();
    // "SURFACE" label
    cx.font = 'bold 10px "Barlow Semi Condensed", sans-serif';
    cx.fillStyle = 'rgba(232,244,232,0.85)';
    cx.textAlign = 'center';
    cx.fillText('◆ SURFACE', x, y - 10);
    cx.textAlign = 'left';
    cx.restore();
}

function drawGuideline() {
    if (guidelineNodes.length < 2) return;
    var W = cssWidth, H = cssHeight;
    var diverScreenX = W * DIVER_SCREEN_X_FRACTION, diverScreenY = H * 0.45, mpp = 0.05;
    var cx = ctx;
    cx.save();
    cx.strokeStyle = 'rgba(255,230,130,0.75)';
    cx.lineWidth = 2;
    cx.beginPath();
    for (var gi = 0; gi < guidelineNodes.length; gi++) {
        var gn = guidelineNodes[gi];
        var gpx = diverScreenX + (gn.x - diverX) / mpp;
        var gpy = diverScreenY + (gn.d - depth) / mpp;
        if (gi === 0) cx.moveTo(gpx, gpy); else cx.lineTo(gpx, gpy);
    }
    cx.stroke();
    cx.restore();
}

// Issue #37: Subtle depth-scale ruler on the right edge of the canvas.
// Short tick every DEPTH_SCALE_TICK_INTERVAL_M metres, labelled tick
// every DEPTH_SCALE_LABEL_INTERVAL_M metres. World-anchored on Y so the
// ticks appear to scroll past as the diver descends — giving a visual
// sense of ascent/descent rate and helping hold stop depths without
// staring at the dive computer. Screen-anchored on X (right edge).
//
// Uses the same depth-to-screen-Y conversion the rest of the file uses:
// dsy = H * 0.45, mpp = 0.05  →  y = dsy + (d - depth) / mpp.
//
// Dimming: drawn BEFORE drawSiltAndTorch in the render pipeline, so the
// cave/wreck darkness overlay tints the ruler along with everything
// else that responds to _torchDark. This function does not need its own
// _torchDark branch.
function drawDepthScale() {
    if (gameState !== 'diving') return;
    var W = cssWidth, H = cssHeight;
    var dsy = H * 0.45, mpp = 0.05;
    var cx = ctx;
    // Right-edge column: short ticks between rightEdgeX and tickInnerX;
    // labels sit just left of the ticks, right-aligned to labelX. Kept
    // narrow (~30px total) so the ruler stays clear of the touch-button
    // strip that lives at right:20px with 48px-wide buttons.
    var rightEdgeX = W - 4;
    var tickShortX = W - 10;
    var tickLongX  = W - 14;
    var labelX     = W - 18;
    var tickIntervalM  = DEPTH_SCALE_TICK_INTERVAL_M;
    var labelIntervalM = DEPTH_SCALE_LABEL_INTERVAL_M;
    // World-depth range visible on screen. Round to the tick interval so
    // ticks land on integer depths, not on partial multiples that would
    // wobble frame-to-frame.
    var minVisibleDepth = depth - (dsy * mpp);
    var maxVisibleDepth = depth + ((H - dsy) * mpp);
    // Clamp: never draw ticks above 0 m (surface) — negative depths
    // aren't meaningful for a depth ruler.
    if (minVisibleDepth < 0) minVisibleDepth = 0;
    // First tick at or below minVisibleDepth aligned to tickIntervalM.
    var firstTick = Math.ceil(minVisibleDepth / tickIntervalM) * tickIntervalM;
    cx.save();
    cx.textBaseline = 'middle';
    cx.textAlign = 'right';
    cx.font = '10px monospace';
    for (var d = firstTick; d <= maxVisibleDepth + 0.001; d += tickIntervalM) {
        var y = dsy + (d - depth) / mpp;
        // Skip ticks that would clip off screen (tick line ~1px, label ~10px tall).
        if (y < 6 || y > H - 6) continue;
        var isLabelled = (Math.round(d) % labelIntervalM) === 0;
        var x1 = isLabelled ? tickLongX : tickShortX;
        cx.strokeStyle = isLabelled
            ? 'rgba(255,255,255,0.35)'
            : 'rgba(255,255,255,0.18)';
        cx.lineWidth = 1;
        cx.beginPath();
        cx.moveTo(x1, y);
        cx.lineTo(rightEdgeX, y);
        cx.stroke();
        if (isLabelled) {
            cx.fillStyle = 'rgba(255,255,255,0.55)';
            cx.fillText(Math.round(d) + ' m', labelX, y);
        }
    }
    cx.restore();
}

function drawSiltAndTorch() {
    // No-op outside the live dive scene — matches the pattern used by
    // drawNearSurfaceAtmosphere / drawSiteAtmosphere so callers/tests can
    // invoke this directly in any game state without emitting canvas ops.
    if (gameState !== 'diving') return;
    // Ease the darkness level toward its target so entering/leaving an
    // overhead environment fades gradually instead of snapping.
    var target = inOverhead ? 1 : 0;
    _torchDark += (target - _torchDark) * 0.06;
    if (_torchDark < 0.012 && target === 0) { _torchDark = 0; return; }

    // On the WRECK the solid steel hull skin already limits line-of-sight, so
    // no full-screen gloom overlay there.
    var s = activeSite();
    if (s && s.id === 'wreck') return;

    var W = cssWidth, H = cssHeight;
    var diverScreenX = W * DIVER_SCREEN_X_FRACTION, diverScreenY = H * 0.45, mpp = 0.05;
    var cx = ctx;

    // Cave gloom is a FLAT, uniform darkness — never a diver-centred vignette
    // (that read as an ugly dark "cloud" stuck to the diver). Torch OFF: the
    // cave is nearly pitch black. Torch ON: cut a bright cone of light around
    // the diver so the torch genuinely illuminates the passage.
    // Issue #124: the gloom is cool, not neutral.
    //
    // This was rgba(2,5,9), which is so close to black that at alpha 0.80-0.93
    // it erased hue rather than tinting it — measured, the cave interiors came
    // out at a channel spread of 10-14 against 94-120 for open water at the
    // same brightness. Dark was never the problem; colourless was.
    //
    // A deep blue-teal keeps the darkness while leaving the ambient with a
    // temperature for the warm torch to read against.
    var baseDark = (torchOn ? 0.80 : 0.93) * _torchDark;
    cx.fillStyle = 'rgba(3,11,21,' + baseDark.toFixed(3) + ')';
    cx.fillRect(0, 0, W, H);

    if (torchOn) {
        var torchPx = TORCH_RADIUS_M / mpp;
        var effectiveR = torchPx * 1.7 * Math.max(0.3, visibility);
        var beamAngle = torchBeamAngle(_diverFacing);
        var halfA = TORCH_BEAM_HALF_ANGLE_RAD;
        var nearR = effectiveR * TORCH_NEAR_FIELD_FRACTION;

        cx.save();
        cx.globalCompositeOperation = 'destination-out';

        // Near-field spill — small, all-around, weaker. Keeps the diver's
        // back/head dimly readable instead of pure black (which reads as
        // broken rather than atmospheric). Full-screen fill; only the
        // gradient's inner disc actually erases anything.
        var spill = cx.createRadialGradient(diverScreenX, diverScreenY, 0,
                                             diverScreenX, diverScreenY, nearR);
        spill.addColorStop(0,   'rgba(0,0,0,0.85)');
        spill.addColorStop(0.6, 'rgba(0,0,0,0.55)');
        spill.addColorStop(1,   'rgba(0,0,0,0)');
        cx.fillStyle = spill;
        cx.fillRect(0, 0, W, H);

        // Directional cone — clip to a wedge along the beam axis, then
        // fill the strong radial gradient. The clip guarantees the
        // "punch" only opens along the beam direction.
        cx.save();
        cx.beginPath();
        cx.moveTo(diverScreenX, diverScreenY);
        cx.arc(diverScreenX, diverScreenY, effectiveR * 1.05,
               beamAngle - halfA, beamAngle + halfA);
        cx.closePath();
        cx.clip();
        var beam = cx.createRadialGradient(diverScreenX, diverScreenY, 0,
                                            diverScreenX, diverScreenY, effectiveR);
        beam.addColorStop(0,    'rgba(0,0,0,1)');
        beam.addColorStop(0.5,  'rgba(0,0,0,0.92)');
        beam.addColorStop(0.82, 'rgba(0,0,0,0.45)');
        beam.addColorStop(1,    'rgba(0,0,0,0)');
        cx.fillStyle = beam;
        cx.fillRect(0, 0, W, H);
        cx.restore();

        cx.globalCompositeOperation = 'source-over';
        cx.restore();

        drawTorchGlowAndSparkles(cx, W, H, diverScreenX, diverScreenY,
                                 effectiveR, beamAngle, halfA);
    }
}

function drawTorchGlowAndSparkles(cx, W, H, diverScreenX, diverScreenY, effectiveR,
                                    beamAngle, beamHalfAngle) {
    var s = activeSite();
    // Issue #31: extended to wreck (was cave-only) so the wreck interior
    // gets glow/backscatter too. Any other site (open water / reef / shore)
    // still short-circuits.
    if (!s || (s.id !== 'cave' && s.id !== 'wreck')) return;

    // Beam-direction params default to the current diver facing so old-style
    // callers keep working; both current call sites (cave + wreck) pass them
    // explicitly.
    if (typeof beamAngle !== 'number') beamAngle = torchBeamAngle(_diverFacing);
    if (typeof beamHalfAngle !== 'number') beamHalfAngle = TORCH_BEAM_HALF_ANGLE_RAD;

    cx.save();
    cx.globalCompositeOperation = 'lighter';

    // Warm all-around glow — omni-directional, matches the near-field spill
    // in the cutout pass so the diver's immediate surroundings glow softly.
    var warm = cx.createRadialGradient(diverScreenX, diverScreenY, 0,
                                       diverScreenX, diverScreenY, effectiveR * 0.72);
    // Issue #124: the torch reads warm against a cool ambient.
    //
    // The glow was already warm-to-cool but too faint to separate anything —
    // interiors measured near-neutral. Strengthened, and the falloff now goes
    // amber to teal rather than amber to grey-blue, so lit surfaces differ from
    // the surrounding gloom in temperature and not only in brightness. This
    // runs for the wreck as well as the cave, which is where the wreck gets its
    // warmth: the cave gloom overlay above returns early for wrecks.
    warm.addColorStop(0, 'rgba(255,206,132,0.17)');
    warm.addColorStop(0.45, 'rgba(96,168,182,0.06)');
    warm.addColorStop(1, 'rgba(52,116,164,0)');
    cx.fillStyle = warm;
    cx.fillRect(0, 0, W, H);

    // Volumetric cone-shaped backscatter — suspended particles caught in
    // the beam. Density scales with 1-visibility (silty water scatters
    // more). Clipped to the beam wedge so it visibly extends along the
    // torch direction rather than blooming in every direction.
    var vis = (typeof visibility === 'number') ? visibility : 0.8;
    var visClamped = Math.max(0, Math.min(1, vis));
    // 0.05 in crystal-clear water, up to 0.30 in murky. Cave is usually
    // clear; wreck interior tends to sit around vis 0.4-0.6, so the wreck
    // naturally reads dustier without hard-coding a site check.
    var scatterA = 0.05 + (1 - visClamped) * 0.25;
    cx.save();
    cx.beginPath();
    cx.moveTo(diverScreenX, diverScreenY);
    cx.arc(diverScreenX, diverScreenY, effectiveR * 1.05,
           beamAngle - beamHalfAngle, beamAngle + beamHalfAngle);
    cx.closePath();
    cx.clip();
    var scatter = cx.createRadialGradient(diverScreenX, diverScreenY, 0,
                                          diverScreenX, diverScreenY, effectiveR);
    scatter.addColorStop(0,    'rgba(255,225,175,' + scatterA.toFixed(3) + ')');
    scatter.addColorStop(0.55, 'rgba(210,220,200,' + (scatterA * 0.55).toFixed(3) + ')');
    scatter.addColorStop(1,    'rgba(150,180,200,0)');
    cx.fillStyle = scatter;
    cx.fillRect(0, 0, W, H);
    cx.restore();

    // Deterministic point-sparkles (cave only — cave has clear water and
    // the sparkles read as fine silt/mica flecks; wreck's murkier ambient
    // is already conveyed by the backscatter layer above, and steel-
    // backdrop sparkles read as noise there).
    if (s.id === 'cave') {
        cx.fillStyle = 'rgba(238,226,184,0.32)';
        for (var i = 0; i < 36; i++) {
            var seed = i * 23.7;
            var ang = sRand(seed) * Math.PI * 2;
            var rr = Math.pow(sRand(seed + 1), 0.65) * effectiveR * 0.85;
            var x = diverScreenX + Math.cos(ang) * rr + Math.sin(waveTime * 0.8 + i) * 2;
            var y = diverScreenY + Math.sin(ang) * rr;
            if (x < 0 || x > W || y < 0 || y > H) continue;
            var a = Math.max(0, 1 - rr / effectiveR);
            cx.globalAlpha = a * 0.85;
            cx.beginPath(); cx.arc(x, y, 0.7 + sRand(seed + 2) * 1.3, 0, Math.PI * 2); cx.fill();
        }
    }
    cx.globalAlpha = 1;
    cx.restore();
}

// Reef ambient: blue-water haze fading toward the open-water screen edge.
function drawBlueHaze() {
    var s = activeSite();
    if (!s || s.id !== 'reef') return;
    var W = cssWidth, H = cssHeight;
    var cx = ctx;
    // open water is on the side away from the wall (wall at x=0)
    var hazeOnLeft = diverX > 0;
    var hazeW = 180;
    var grad = cx.createLinearGradient(hazeOnLeft ? 0 : W, 0, hazeOnLeft ? hazeW : W - hazeW, 0);
    grad.addColorStop(0, 'rgba(6,40,66,0.5)');
    grad.addColorStop(1, 'rgba(6,40,66,0)');
    cx.fillStyle = grad;
    cx.fillRect(0, 0, W, H);
}

// Light shafts — additive beams from above marking deck-switch passages.
// On the wreck the beam only appears once the diver is inside the hull
// (faded in via the same "inside-ness" factor as the hull skin) — from open
// water it looked unnatural hanging in the blue.
function drawLightShafts() {
    var s = activeSite();
    if (!s || !s.features.length) return;
    var beamFade = (s.id === 'wreck') ? _wreckMetal : 1;
    if (beamFade < 0.02) return;
    var W = cssWidth, H = cssHeight;
    var diverScreenX = W * DIVER_SCREEN_X_FRACTION, diverScreenY = H * 0.45, mpp = 0.05;
    var cx = ctx;
    for (var i = 0; i < s.features.length; i++) {
        var f = s.features[i];
        if (f.kind !== 'lightShaft') continue;
        var sx = diverScreenX + ((f.x || 0) - diverX) / mpp;
        if (sx < -200 || sx > W + 200) continue;
        var topD = (f.d || 0) - 16;
        var botD = (f.d || 0) + 26;
        var topY = diverScreenY + (topD - depth) / mpp;
        var botY = diverScreenY + (botD - depth) / mpp;
        var topHalf = f.topHalf || 44, botHalf = f.botHalf || 92;   // beam widens as it falls
        var shaftAlpha = f.alpha || 0.72;
        cx.save();
        cx.globalCompositeOperation = 'lighter';
        cx.globalAlpha = beamFade * shaftAlpha;
        var beam = cx.createLinearGradient(0, topY, 0, botY);
        beam.addColorStop(0,   'rgba(150,210,255,0.22)');
        beam.addColorStop(0.5, 'rgba(140,200,250,0.10)');
        beam.addColorStop(1,   'rgba(130,190,245,0)');
        cx.fillStyle = beam;
        cx.beginPath();
        cx.moveTo(sx - topHalf, topY);
        cx.lineTo(sx + topHalf, topY);
        cx.lineTo(sx + botHalf, botY);
        cx.lineTo(sx - botHalf, botY);
        cx.closePath();
        cx.fill();
        // Soft floating motes drifting in the beam
        cx.fillStyle = 'rgba(210,235,255,0.35)';
        for (var m = 0; m < 5; m++) {
            var mt = ((waveTime * 0.15 + m * 0.21) % 1);
            var my = topY + (botY - topY) * mt;
            var mx = sx + Math.sin(waveTime * 0.6 + m * 2) * (topHalf * 0.5);
            cx.beginPath(); cx.arc(mx, my, 1.6, 0, Math.PI * 2); cx.fill();
        }
        cx.restore();
    }
}

// SECTION: Dive computer HUD overlay
// SEARCH TERMS: drawDiveComputer, NDL, ceiling, tissue bars, PO2, deco schedule, infoPageMode

// ============================================================
//  DIVE COMPUTER OVERLAY — WP-007: Dive computer UI redesign
// ============================================================

function drawDiveComputer() {
    var cx = ctx;
    var W = cssWidth;
    var dcScale = W < 400 ? 0.6 : W < 600 ? 0.75 : 1;
    var s = function(v) { return Math.round(v * dcScale); };
    var DCF = "'Barlow Semi Condensed', monospace";
    var dcW = s(380);
    var dcH = s(244); // Taller to fit the mode + battery top bar (dive-computer style)
    var dcX = W - dcW - 15;
    var dcY = 15;

    // --- Titanium bezel + LCD screen ---
    cx.save();
    var bezGrad = cx.createLinearGradient(dcX, dcY, dcX + dcW * 0.55, dcY + dcH);
    bezGrad.addColorStop(0, '#474c53');
    bezGrad.addColorStop(0.32, '#2b2f34');
    bezGrad.addColorStop(0.62, '#23262b');
    bezGrad.addColorStop(1, '#141619');
    cx.beginPath();
    cx.roundRect(dcX, dcY, dcW, dcH, s(14));
    cx.fillStyle = bezGrad;
    cx.fill();
    // side piezo buttons
    cx.fillStyle = '#363b41';
    var pbH2 = s(42), pbW2 = s(5), pbY2 = dcY + dcH / 2 - pbH2 / 2;
    cx.beginPath(); cx.roundRect(dcX - pbW2 + s(1), pbY2, pbW2, pbH2, s(2)); cx.fill();
    cx.beginPath(); cx.roundRect(dcX + dcW - s(1), pbY2, pbW2, pbH2, s(2)); cx.fill();
    // bevel highlight + outer shadow
    cx.lineWidth = 1;
    cx.strokeStyle = 'rgba(255,255,255,0.16)';
    cx.beginPath(); cx.roundRect(dcX + 0.5, dcY + 0.5, dcW - 1, dcH - 1, s(14)); cx.stroke();
    cx.strokeStyle = 'rgba(0,0,0,0.55)';
    cx.beginPath(); cx.roundRect(dcX, dcY, dcW, dcH, s(14)); cx.stroke();
    // LCD screen
    var scrX = dcX + s(5), scrY = dcY + s(5), scrW = dcW - s(10), scrH = dcH - s(10);
    var scrGrad = cx.createRadialGradient(scrX + scrW / 2, scrY - s(8), s(8), scrX + scrW / 2, scrY + scrH * 0.4, scrH);
    scrGrad.addColorStop(0, '#0d141a');
    scrGrad.addColorStop(0.65, '#06090d');
    scrGrad.addColorStop(1, '#040609');
    cx.beginPath(); cx.roundRect(scrX, scrY, scrW, scrH, s(9));
    cx.fillStyle = scrGrad; cx.fill();
    cx.strokeStyle = 'rgba(120,150,170,0.10)'; cx.lineWidth = 1; cx.stroke();
    // subtle top glass glare
    cx.save();
    cx.beginPath(); cx.roundRect(scrX, scrY, scrW, scrH, s(9)); cx.clip();
    var glare = cx.createLinearGradient(0, scrY, 0, scrY + scrH * 0.18);
    glare.addColorStop(0, 'rgba(255,255,255,0.05)');
    glare.addColorStop(1, 'rgba(255,255,255,0)');
    cx.fillStyle = glare; cx.fillRect(scrX, scrY, scrW, scrH * 0.18);
    cx.restore();

    // --- Layout constants ---
    var innerX = dcX + s(5);
    var innerY = dcY + s(5);
    var innerW = dcW - s(10);
    var innerH = dcH - s(10);
    var contentX = innerX;
    var contentW = innerW;

    // --- Data values ---
    // Issue #14: ndl/ceilDepth/schedule read from the per-tick cache
    // (game-loop.js's frameCalc, refreshed once per frame in updateDiving()
    // right after this frame's tissue update) instead of recomputing —
    // calculateDecoSchedule() alone was up to ~3000 iterations.
    var po2 = calculatePO2();
    var ndl = frameCalc.ndl;
    var ceilDepth = frameCalc.ceiling;
    var decoStopDepth = decoStop(ceilDepth);
    var avgDepthVal = avgDepthSamples > 0 ? avgDepthAccum / avgDepthSamples : 0;
    var tank = getActiveTank();
    var gtr = calculateGTR();
    var tBar = tankBar();
    var arRate = Math.abs(ascentRate);
    var inDeco = decoStopDepth > 0;
    var schedule = inDeco ? frameCalc.schedule : null;

    // --- Region Y positions ---
    var statusTop = innerY;
    var mainTop = statusTop + s(18);
    var mainH = s(90); // Further reduced height for more compact layout
    var warnBannerH = s(22);
    var bottomH = s(68);
    var bottomTop = innerY + innerH - bottomH;
    var warnBannerTop = bottomTop - warnBannerH - s(2);

    // Region widths
    var regionAW = Math.round(contentW * 0.50);
    var regionBW = contentW - regionAW - s(18);

    // ================================================================
    //  TOP BAR — mode chip (left) + battery (right)
    // ================================================================
    {
        var tbY = innerY + s(2);
        var chipH = s(15);
        var modeLabel = diveMode === 'ccr' ? (ccrState.onBailout ? 'BAIL' : 'CC\u00B7BO') : diveMode === 'tec' ? 'OC TEC' : 'REC';
        // Issue #39: bailout tone is a danger-tier status (mode is degraded);
        // REC tone is an ok-tier status. #34e6ff (cyan) is a mode chip accent,
        // not traffic-light \u2014 kept as a literal (out of HUD_COLORS scope).
        var modeTone = diveMode === 'ccr' ? (ccrState.onBailout ? hudColor('danger') : '#34e6ff') : diveMode === 'tec' ? '#34e6ff' : hudColor('ok');
        cx.font = 'bold ' + s(11) + "px " + DCF;
        cx.textAlign = 'left';
        var mlW = cx.measureText(modeLabel).width;
        var chipPadX = s(7);
        cx.strokeStyle = modeTone; cx.lineWidth = 1;
        cx.beginPath(); cx.roundRect(contentX + s(2), tbY, mlW + chipPadX * 2, chipH, s(4)); cx.stroke();
        cx.fillStyle = modeTone;
        cx.textBaseline = 'middle';
        cx.fillText(modeLabel, contentX + s(2) + chipPadX, tbY + chipH / 2 + s(1));
        cx.textBaseline = 'alphabetic';
        // Battery (cosmetic, ~full) — shown in the top bar
        var batW = s(22), batH = s(11);
        var batX = contentX + contentW - batW - s(7), batY = tbY + (chipH - batH) / 2;
        cx.strokeStyle = '#8694a1'; cx.lineWidth = 1;
        cx.beginPath(); cx.roundRect(batX, batY, batW, batH, s(2)); cx.stroke();
        cx.fillStyle = '#8694a1';
        cx.fillRect(batX + batW + s(1), batY + batH * 0.28, s(2), batH * 0.44);
        // Issue #39: battery is "full" indicator — ok tier.
        cx.fillStyle = hudColor('ok');
        cx.fillRect(batX + s(1.5), batY + s(1.5), (batW - s(3)) * 0.82, batH - s(3));
        cx.textAlign = 'left';
    }

    // ================================================================
    //  REGION A — Basic Dive Info (left column)
    // ================================================================
    var rAX = contentX + s(6);
    var rATop = mainTop + s(4);

    // DEPTH (hero) — left-aligned with micro label (matches redesign mockup)
    cx.font = s(10) + "px " + DCF;
    cx.fillStyle = '#8694a1';
    cx.textAlign = 'left';
    cx.fillText('DEPTH', rAX, rATop + s(6));
    cx.font = 'bold ' + s(48) + "px " + DCF;
    cx.fillStyle = '#fff';
    var depthStr = depth.toFixed(1);
    cx.fillText(depthStr, rAX, rATop + s(46));
    var depthTextW = cx.measureText(depthStr).width;
    cx.font = s(18) + "px " + DCF;
    cx.fillStyle = '#a8b6cc';
    cx.fillText('m', rAX + depthTextW + s(3), rATop + s(46));

    // Chevron ascent indicator (right of Block 1.1)
    var chevX = contentX + regionAW - s(20);
    var chevTop = rATop + s(2);
    var chevW = s(10);
    var chevH = s(8);
    var chevGap = s(3);
    var numChevrons = Math.min(6, Math.max(0, Math.round(arRate / 3)));
    // Issue #39: chevron count already encodes rate independently of colour
    // (six chevrons at max, filled proportionally), and >18 m/min also
    // blinks — two non-colour cues in addition to the tier colour swap.
    var chevColor = '#555';
    if (arRate > 18) chevColor = hudColor('danger');
    else if (arRate > 9) chevColor = hudColor('caution');
    else if (arRate > 0.5) chevColor = '#fff';
    var flashChev = arRate > 18 && Math.floor(Date.now() / 300) % 2 === 0;

    var chevDescending = ascentRate < -0.5;
    for (var ci = 0; ci < 6; ci++) {
        var cy2 = chevTop + (5 - ci) * (chevH + chevGap);
        var isLit = ci < numChevrons;
        cx.beginPath();
        if (chevDescending) {
            // Point down when descending
            cx.moveTo(chevX, cy2);
            cx.lineTo(chevX + chevW / 2, cy2 + chevH);
            cx.lineTo(chevX + chevW, cy2);
        } else {
            // Point up when ascending
            cx.moveTo(chevX, cy2 + chevH);
            cx.lineTo(chevX + chevW / 2, cy2);
            cx.lineTo(chevX + chevW, cy2 + chevH);
        }
        cx.closePath();
        if (isLit && !flashChev) {
            cx.fillStyle = chevColor;
            cx.globalAlpha = 0.95;
        } else {
            cx.fillStyle = '#333';
            cx.globalAlpha = 0.25;
        }
        cx.fill();
        cx.globalAlpha = 1;
    }

    // Ascent rate text below chevrons
    if (arRate > 0.5) {
        cx.font = s(10) + "px " + DCF;
        cx.fillStyle = '#a8b6cc';
        cx.textAlign = 'center';
        var chevCenterX = chevX + chevW / 2;
        var chevBottomY = chevTop + 6 * (chevH + chevGap);
        cx.fillText(Math.round(arRate), chevCenterX, chevBottomY + s(10));
        cx.fillText('m/m', chevCenterX, chevBottomY + s(20));
        cx.textAlign = 'left';
    }

    // TIME (below depth) — left-aligned in Region A
    var timeTop = rATop + s(60);
    cx.font = s(14) + "px " + DCF;
    cx.fillStyle = '#8694a1';
    cx.textAlign = 'left';
    cx.fillText('TIME', rAX, timeTop);
    cx.font = 'bold ' + s(28) + "px " + DCF;
    cx.fillStyle = '#fff';
    cx.fillText(formatTime(diveTime), rAX, timeTop + s(26));

    // Vertical divider between Region A and Region B
    cx.strokeStyle = '#8694a1';
    cx.lineWidth = 1;
    cx.beginPath();
    cx.moveTo(contentX + regionAW, mainTop);
    cx.lineTo(contentX + regionAW, bottomTop - s(1));
    cx.stroke();

    // ================================================================
    //  REGION B — Decompression Info (right of Region A)
    // ================================================================
    var rBX = contentX + regionAW + s(4);
    var rBTop = mainTop + s(4);
    var rBW = regionBW;

    // --- Stop Box ---
    var stopBoxH = s(48);
    var showStopBox = inDeco || (safetyStopNeeded && !safetyStopComplete);

    if (showStopBox) {

        if (inDeco) {
            // DECO STOP title — issue #39: deco is a danger-tier state.
            cx.font = s(14) + "px " + DCF;
            cx.fillStyle = hudColor('danger');
            cx.textAlign = 'left';
            cx.fillText('DECO STOP', rBX + s(6), rBTop + s(12));
            // Stop depth + time
            cx.font = 'bold ' + s(28) + "px " + DCF;
            cx.fillStyle = '#fff';
            if (schedule && schedule.stops.length > 0) {
                // depth value + small 'm'
                cx.textAlign = 'left';
                var dsStr = String(schedule.stops[0].depth);
                cx.fillText(dsStr, rBX + s(6), rBTop + s(38));
                var dsW = cx.measureText(dsStr).width;
                cx.font = s(18) + "px " + DCF;
                cx.fillStyle = '#a8b6cc';
                cx.fillText('m', rBX + s(6) + dsW + s(2), rBTop + s(38));
                // time value + small 'min' — centered in right half of box
                cx.font = 'bold ' + s(28) + "px " + DCF;
                cx.fillStyle = '#fff';
                cx.font = s(18) + "px " + DCF;
                var dMinW = cx.measureText('min').width;
                cx.font = 'bold ' + s(28) + "px " + DCF;
                var dNumW = cx.measureText(String(schedule.stops[0].time)).width;
                var dGroupW = dNumW + s(3) + dMinW;
                var dGroupX = rBX + rBW * 0.60 - dGroupW / 2;
                cx.textAlign = 'left';
                cx.fillText(String(schedule.stops[0].time), dGroupX, rBTop + s(38));
                cx.font = s(18) + "px " + DCF;
                cx.fillStyle = '#a8b6cc';
                cx.fillText('min', dGroupX + dNumW + s(3), rBTop + s(38));
            }
        } else {
            // SAFETY STOP title
            cx.font = s(14) + "px " + DCF;
            cx.fillStyle = '#34e6ff';
            cx.textAlign = 'left';
            cx.fillText('SAFETY STOP', rBX + s(6), rBTop + s(12));
            cx.font = 'bold ' + s(28) + "px " + DCF;
            cx.fillStyle = '#fff';
            // Issue #13: nominal target depth derived from the real active
            // window (SAFETY_STOP_ACTIVE_MIN_D..MAX_D, issue #68) instead of
            // a hardcoded "5" disconnected from the actual 2.4-8.3m zone.
            var ssTargetD = String(Math.round((SAFETY_STOP_ACTIVE_MIN_D + SAFETY_STOP_ACTIVE_MAX_D) / 2));
            if (safetyStopCountdownStarted && !safetyStopComplete && !safetyStopPaused) {
                var ssMin = Math.floor(safetyStopRemaining / 60);
                var ssSec = Math.floor(safetyStopRemaining % 60);
                cx.fillStyle = hudColor('ok');
                cx.fillText(ssTargetD, rBX + s(6), rBTop + s(38));
                var ss5W = cx.measureText(ssTargetD).width;
                cx.font = s(18) + "px " + DCF;
                cx.fillStyle = '#a8b6cc';
                cx.fillText('m', rBX + s(6) + ss5W + s(2), rBTop + s(38));
                cx.font = 'bold ' + s(28) + "px " + DCF;
                cx.textAlign = 'right';
                cx.fillText(ssMin + ':' + String(ssSec).padStart(2, '0'), rBX + rBW - s(6), rBTop + s(38));
                cx.textAlign = 'left';
            } else if (safetyStopCountdownStarted && !safetyStopComplete && safetyStopPaused) {
                var ssMin2 = Math.floor(safetyStopRemaining / 60);
                var ssSec2 = Math.floor(safetyStopRemaining % 60);
                cx.fillStyle = hudColor('caution');
                cx.fillText(ssTargetD, rBX + s(6), rBTop + s(38));
                var ss5W2 = cx.measureText(ssTargetD).width;
                cx.font = s(18) + "px " + DCF;
                cx.fillStyle = '#a8b6cc';
                cx.fillText('m', rBX + s(6) + ss5W2 + s(2), rBTop + s(38));
                cx.font = 'bold ' + s(28) + "px " + DCF;
                cx.textAlign = 'right';
                cx.fillText(ssMin2 + ':' + String(ssSec2).padStart(2, '0'), rBX + rBW - s(6), rBTop + s(38));
                cx.textAlign = 'left';
            } else {
                var ssDur = calculateSafetyStopDuration();
                var ssMinPlan = Math.floor(ssDur / 60);
                cx.fillStyle = hudColor('caution');
                cx.fillText(ssTargetD, rBX + s(6), rBTop + s(38));
                var ss5W3 = cx.measureText(ssTargetD).width;
                cx.font = s(18) + "px " + DCF;
                cx.fillStyle = '#a8b6cc';
                cx.fillText('m', rBX + s(6) + ss5W3 + s(2), rBTop + s(38));
                cx.font = 'bold ' + s(28) + "px " + DCF;
                cx.fillStyle = hudColor('caution');
                cx.font = s(18) + "px " + DCF;
                var spUnitW = cx.measureText('min').width;
                cx.font = 'bold ' + s(28) + "px " + DCF;
                var spNumW = cx.measureText(String(ssMinPlan)).width;
                var spGroupW = spNumW + s(3) + spUnitW;
                var spGroupX = rBX + rBW * 0.60 - spGroupW / 2;
                cx.fillStyle = hudColor('caution');
                cx.textAlign = 'left';
                cx.fillText(String(ssMinPlan), spGroupX, rBTop + s(38));
                cx.font = s(18) + "px " + DCF;
                cx.fillStyle = '#a8b6cc';
                cx.fillText('min', spGroupX + spNumW + s(3), rBTop + s(38));
            }
        }
    } else if (safetyStopComplete) {
        cx.font = s(14) + "px " + DCF;
        cx.fillStyle = hudColor('ok');
        cx.textAlign = 'left';
        cx.fillText('SAFETY STOP', rBX + s(6), rBTop + s(12));
        cx.font = 'bold ' + s(28) + "px " + DCF;
        cx.fillText('Complete', rBX + s(6), rBTop + s(38));
    }

    // --- NDL — top-right hero; drops to a smaller readout when a stop is shown ---
    var ndlHero = !showStopBox;
    var ndlLabelTop = ndlHero ? (rBTop + s(8)) : (rBTop + stopBoxH + s(16));
    {
        var ndlRightX = rBX + rBW - s(6);
        cx.font = s(12) + "px " + DCF;
        cx.fillStyle = '#8694a1';
        cx.textAlign = 'right';
        cx.fillText('NDL', ndlRightX, ndlLabelTop);
        cx.font = 'bold ' + s(ndlHero ? 46 : 34) + "px " + DCF;
        // Issue #39: NDL < 5 is danger tier — prefix with ⚠ so the state is
        // identifiable in grayscale / for fully colour-blind users.
        var ndlIsDanger = ndl < 5;
        cx.fillStyle = ndlIsDanger ? hudColor('danger') : ndl < 15 ? hudColor('caution') : hudColor('ok');
        var ndlText = ndl >= 999 ? '---' : ndl > 99 ? '99' : String(ndl);
        if (ndlIsDanger && ndl < 999) ndlText = hudDangerPrefix() + ndlText;
        cx.fillText(ndlText, ndlRightX, ndlLabelTop + s(ndlHero ? 44 : 30));
        if (ndlHero && ndl < 999) {
            cx.font = s(11) + "px " + DCF;
            cx.fillStyle = '#8694a1';
            cx.fillText('min', ndlRightX, ndlLabelTop + s(58));
        }
        cx.textAlign = 'left';
    }

    // Vertical N2 loading bar (right column)
    var n2BarX = contentX + contentW - s(10);
    var n2BarW = s(6);
    var n2BarTop = mainTop + s(4);
    var n2BarBot = mainTop + mainH - s(4);
    var n2BarFullH = n2BarBot - n2BarTop;
    cx.fillStyle = 'rgba(255,255,255,0.06)';
    cx.beginPath();
    cx.roundRect(n2BarX, n2BarTop, n2BarW, n2BarFullH, s(3));
    cx.fill();
    cx.strokeStyle = 'rgba(255,255,255,0.14)';
    cx.lineWidth = 1;
    cx.stroke();
    var n2LoadFill = Math.min(1, Math.max(0, 1 - ndl / 120));
    if (n2LoadFill > 0) {
        var n2FillH = n2LoadFill * n2BarFullH;
        var n2FillTop = n2BarBot - n2FillH;
        cx.save();
        cx.beginPath();
        cx.roundRect(n2BarX, n2BarTop, n2BarW, n2BarFullH, s(3));
        cx.clip();
        var n2VGrad = cx.createLinearGradient(0, n2BarBot, 0, n2FillTop);
        n2VGrad.addColorStop(0, hudColor('ok'));
        n2VGrad.addColorStop(1, n2LoadFill > 0.9 ? hudColor('danger') : n2LoadFill > 0.7 ? hudColor('caution') : hudColor('ok'));
        cx.fillStyle = n2VGrad;
        cx.fillRect(n2BarX, n2FillTop, n2BarW, n2FillH);
        cx.restore();
    }
    // Issue #39: threshold tick marks \u2014 caution (70 %) + danger (90 %) \u2014
    // give the bar an unambiguous fill-vs-threshold reading that doesn't
    // depend on the colour swap alone. Positions match issue #39's own
    // spec (70/90 %) and the color-swap thresholds above.
    cx.strokeStyle = 'rgba(255,255,255,0.55)';
    cx.lineWidth = 1;
    var _n2Tick70Y = n2BarBot - 0.7 * n2BarFullH;
    var _n2Tick90Y = n2BarBot - 0.9 * n2BarFullH;
    cx.beginPath();
    cx.moveTo(n2BarX - s(2), _n2Tick70Y);
    cx.lineTo(n2BarX + n2BarW + s(2), _n2Tick70Y);
    cx.moveTo(n2BarX - s(2), _n2Tick90Y);
    cx.lineTo(n2BarX + n2BarW + s(2), _n2Tick90Y);
    cx.stroke();
    cx.font = s(8) + "px " + DCF;
    cx.fillStyle = '#8694a1';
    cx.textAlign = 'center';
    cx.fillText('N\u2082', n2BarX + n2BarW / 2, n2BarBot + s(10));

    // Divider above bottom
    cx.strokeStyle = '#8694a1';
    cx.lineWidth = 1;
    cx.beginPath();
    cx.moveTo(contentX, bottomTop - s(1));
    cx.lineTo(contentX + contentW, bottomTop - s(1));
    cx.stroke();

    // ================================================================
    //  WARNING BANNER (above info row)
    // ================================================================
    var highestWarn = '';
    var warnCritical = false;

    if (inDeco && depth < decoStopDepth) {
        highestWarn = S('warnCeiling'); warnCritical = true;
    } else if (po2 > PO2_HIGH) {
        highestWarn = S('warnO2'); warnCritical = true;
    } else if (narcosisIndex > 0.70) {
        highestWarn = S('warnNarc'); warnCritical = true;
    } else if (ascentRate > 9) {
        highestWarn = S('warnSlow'); warnCritical = true;
    } else if (tBar < 30) {
        highestWarn = S('warnLowGas'); warnCritical = true;
    } else if (tBar < 50) {
        highestWarn = S('warnReserve'); warnCritical = false;
    } else if (!inDeco && ndl > 0 && ndl < 5) {
        highestWarn = S('warnLowNDL'); warnCritical = true;
    } else if (narcosisIndex > 0.20) {
        highestWarn = S('warnNarc'); warnCritical = false;
    }

    if (highestWarn) {
        // Issue #39: banner already blinks + already carries a ⚠ prefix in
        // the localised text (S('warnO2'), etc.) — two non-colour cues in
        // addition to the tier colour swap.
        var wBlink = warnCritical && Math.floor(Date.now() / 380) % 2 === 0;
        var wCol   = warnCritical ? hudColor('danger') : hudColor('caution');
        var wbx = contentX + s(4), wbw = contentW - s(8);
        var wby = warnBannerTop,   wbh = warnBannerH;
        // dark pill background
        cx.fillStyle = warnCritical ? 'rgba(45,6,6,0.90)' : 'rgba(38,26,0,0.88)';
        cx.beginPath(); cx.roundRect(wbx, wby, wbw, wbh, s(5)); cx.fill();
        // coloured border (blinks on critical)
        cx.strokeStyle = warnCritical
            ? (wBlink ? 'rgba(255,75,75,0.88)' : 'rgba(255,75,75,0.40)')
            : 'rgba(255,210,77,0.44)';
        cx.lineWidth = 1;
        cx.beginPath(); cx.roundRect(wbx, wby, wbw, wbh, s(5)); cx.stroke();
        // left accent strip
        cx.fillStyle = warnCritical
            ? (wBlink ? 'rgba(255,75,75,0.88)' : 'rgba(255,75,75,0.50)')
            : 'rgba(255,210,77,0.65)';
        cx.beginPath(); cx.roundRect(wbx, wby, s(3), wbh, [s(5), 0, 0, s(5)]); cx.fill();
        // glow ring (only when not blinking out)
        if (!wBlink) {
            cx.save();
            cx.shadowColor = wCol; cx.shadowBlur = s(10);
            cx.strokeStyle = warnCritical ? 'rgba(255,75,75,0.18)' : 'rgba(255,210,77,0.15)';
            cx.lineWidth = 1;
            cx.beginPath(); cx.roundRect(wbx, wby, wbw, wbh, s(5)); cx.stroke();
            cx.restore();
        }
        // icon + text
        cx.font = 'bold ' + s(11) + 'px ' + DCF;
        cx.fillStyle = wBlink ? 'rgba(255,75,75,0.16)' : wCol;
        cx.textAlign = 'center';
        cx.fillText(highestWarn,
            contentX + contentW / 2, warnBannerTop + s(15));
        cx.textAlign = 'left';
    }

    // ================================================================
    //  REGION C — Info Row (bottom, 3 boxes: Gas | MAX/AVG/AMV | GTR/TTS/CEIL)
    // ================================================================
    var slotGap = s(6);
    var slotW = Math.floor((contentW - slotGap * 2 - s(4)) / 3);
    var slotH = bottomH - s(4);
    var slotY = bottomTop + s(2);

    function drawSlot(sx, sw) {
        // WP-037: Background boxes removed
    }

    var rowH = Math.floor(slotH / 3);
    var labelFont = s(10) + "px " + DCF;
    var valueFont = 'bold ' + s(11) + "px " + DCF;
    var labelColor = '#8694a1';
    var valueColor = '#eaf2ff';
    var padL = s(6);


    // --- Box 0: GAS (Classic 5-row style) / CCR HUD ---
    var box0X = contentX + s(2);
    var box0W = slotW;

    // Row heights for 5 rows (shared)
    var rowH5 = slotH / 5;
    var bY1 = slotY + rowH5 * 0 + s(13);
    var bY2 = slotY + rowH5 * 1 + s(13);
    var bY3 = slotY + rowH5 * 2 + s(13);
    var bY4 = slotY + rowH5 * 3 + s(13);
    var bY5 = slotY + rowH5 * 4 + s(13);
    var padR = padL;

    // Box positions (shared by both modes)
    var box1X = box0X + box0W + slotGap;
    var box1W = slotW;
    var box2X = box1X + box1W + slotGap;
    var box2W = contentX + contentW - box2X - s(2);

    if (infoPageMode === 0) {

    if (diveMode === 'ccr') {
      // TASK-032D: CCR HUD Display — issue #39: colours via hudColor().
      var po2Val = ccrState.actualPO2;
      var po2IsDangerCCR = po2Val < 0.18 || po2Val > 1.6;
      var ccrPO2Color = po2IsDangerCCR ? hudColor('danger') : po2Val > 1.4 ? hudColor('warn') : po2Val > 1.0 ? hudColor('caution') : hudColor('ok');
      var o2Bar = Math.round(ccrState.o2CylPressure);
      var dilBar = Math.round(ccrState.dilCylPressure);
      var scrMin = Math.round(ccrState.scrubberRemaining);
      var scrIsDanger = scrMin < 10;
      var scrColor = scrIsDanger ? hudColor('danger') : scrMin < 30 ? hudColor('caution') : hudColor('ok');
      var modeText = ccrState.onBailout ? 'BAIL' : 'CCR';
      var modeColor = ccrState.onBailout ? hudColor('danger') : hudColor('ok');

      // Row 1: Mode + SP
      cx.font = valueFont; cx.textAlign = 'left';
      cx.fillStyle = modeColor;
      cx.fillText(modeText, box0X + padL, bY1);
      cx.fillStyle = '#fff'; cx.textAlign = 'right';
      cx.fillText('SP:' + ccrState.targetSP.toFixed(1), box0X + box0W - padR, bY1);

      // Row 2: PO2 (issue #39: ⚠ prefix on danger)
      cx.font = labelFont; cx.fillStyle = labelColor; cx.textAlign = 'left';
      cx.fillText('PO2', box0X + padL, bY2);
      cx.font = valueFont; cx.fillStyle = ccrPO2Color; cx.textAlign = 'right';
      cx.fillText((po2IsDangerCCR ? hudDangerPrefix() : '') + po2Val.toFixed(2), box0X + box0W - padR, bY2);

      // Row 3: O2 cylinder
      var o2IsDangerCCR = o2Bar < 30;
      var o2Color = o2IsDangerCCR ? hudColor('danger') : '#eaf2ff';
      cx.font = labelFont; cx.fillStyle = labelColor; cx.textAlign = 'left';
      cx.fillText('O2', box0X + padL, bY3);
      cx.font = valueFont; cx.fillStyle = o2Color; cx.textAlign = 'right';
      cx.fillText((o2IsDangerCCR ? hudDangerPrefix() : '') + o2Bar + ' bar', box0X + box0W - padR, bY3);

      // Row 4: Diluent cylinder
      var dilIsDangerCCR = dilBar < 30;
      var dilColor = dilIsDangerCCR ? hudColor('danger') : '#eaf2ff';
      cx.font = labelFont; cx.fillStyle = labelColor; cx.textAlign = 'left';
      cx.fillText('DIL', box0X + padL, bY4);
      cx.font = valueFont; cx.fillStyle = dilColor; cx.textAlign = 'right';
      cx.fillText((dilIsDangerCCR ? hudDangerPrefix() : '') + dilBar + ' bar', box0X + box0W - padR, bY4);

      // Row 5: Scrubber
      cx.font = labelFont; cx.fillStyle = labelColor; cx.textAlign = 'left';
      cx.fillText('SCR', box0X + padL, bY5);
      cx.font = valueFont; cx.fillStyle = scrColor; cx.textAlign = 'right';
      cx.fillText((scrIsDanger ? hudDangerPrefix() : '') + scrMin + ' min', box0X + box0W - padR, bY5);

    } else {
    // OC Gas Box (original) — issue #39: colours via hudColor().
    tank = getActiveTank();
    var bestIdx = recommendBestGas();
    var isBest = (activeTank === bestIdx);
    tBar = tankBar();
    var tankIsDanger = tBar < 50;
    var barColor = tBar > 100 ? hudColor('ok') : (tBar >= 50 ? hudColor('caution') : hudColor('danger'));

    // Row 1: "Gas" label (left-aligned, consistent font)
    cx.font = labelFont; cx.fillStyle = labelColor; cx.textAlign = 'left';
    cx.fillText('Gas', box0X + padL, bY1);

    // Row 2: tank.label (left-aligned, bold, white)
    cx.font = valueFont; cx.textAlign = 'left';
    cx.fillStyle = '#fff';
    cx.fillText(tank.label, box0X + padL, bY2);

    // Row 3: Bar indicator (horizontal, color-coded, numeric value right-aligned, aligned with bar)
    var barX = box0X + padL;
    var barY = bY3 - s(7);
    var barW = box0W - padL * 2 - s(54); // Make pressure bar a bit shorter
    var barH = s(8);
    // Bar background (rounded rect, subtle like N2 bar)
    cx.fillStyle = 'rgba(255,255,255,0.06)';
    cx.beginPath();
    cx.roundRect(barX, barY, barW, barH, s(3));
    cx.fill();
    cx.strokeStyle = 'rgba(255,255,255,0.14)';
    cx.lineWidth = 1;
    cx.stroke();
    // Bar fill (solid color, not gradient)
    var barFrac = Math.max(0, Math.min(1, tBar / 200));
    if (barFrac > 0) {
        cx.save();
        cx.beginPath();
        cx.roundRect(barX, barY, barW, barH, s(3));
        cx.clip();
        cx.fillStyle = barColor;
        cx.fillRect(barX, barY, barW * barFrac, barH);
        cx.restore();
    }
    // Issue #39: threshold tick marks at 50 bar (danger→caution edge) and
    // 100 bar (caution→ok edge). Renders on top of the fill so the bar is
    // legible as "fill vs threshold" without relying on colour.
    cx.strokeStyle = 'rgba(255,255,255,0.55)';
    cx.lineWidth = 1;
    var _tk50X = barX + (50 / 200) * barW;
    var _tk100X = barX + (100 / 200) * barW;
    cx.beginPath();
    cx.moveTo(_tk50X, barY - s(1));
    cx.lineTo(_tk50X, barY + barH + s(1));
    cx.moveTo(_tk100X, barY - s(1));
    cx.lineTo(_tk100X, barY + barH + s(1));
    cx.stroke();
    // Numeric value (vertically centered with bar, right-aligned) — issue #39
    // prefixes ⚠ on danger so the value is unambiguous in grayscale.
    cx.font = valueFont; cx.fillStyle = barColor; cx.textAlign = 'right';
    cx.fillText((tankIsDanger ? hudDangerPrefix() : '') + Math.round(tBar) + ' bar', box0X + box0W - padR, barY + barH - s(1));

    // Row 4: Tank dots (smaller, subtle, active/best highlighted)
    var dotCount = tankCount;
    var dotR = s(4.5);
    var dotGap = s(11);
    var dotsStartX = barX + s(4); // Move tank dots slightly left for better centering
    var dotsY = bY4;
    for (var i = 0; i < dotCount; i++) {
        var tk = tanks[i];
        var hasGas = tk.gasRemaining > 0;
        var isActive = (i === activeTank);
        var isBestDot = (i === bestIdx);
        // #33ffcc (active) is an identity accent, not a status tier — kept
        // as a literal. Issue #39: best-gas dot IS a "safe/available" cue,
        // so it flips to the CVD palette's ok tone in colour-blind mode.
        var dotColor = hasGas ? (isActive ? '#33ffcc' : (isBestDot ? hudColor('ok') : '#aaa')) : '#444';
        cx.beginPath();
        cx.arc(dotsStartX + i * dotGap, dotsY, dotR, 0, Math.PI * 2);
        cx.fillStyle = dotColor;
        cx.globalAlpha = isActive ? 1.0 : 0.6;
        cx.fill();
        cx.globalAlpha = 1.0;
        if (!hasGas) {
            cx.font = 'bold ' + s(11) + "px " + DCF;
            cx.fillStyle = '#fff';
            cx.textAlign = 'center';
            cx.fillText('\u25CB', dotsStartX + i * dotGap, dotsY + s(4));
        }
    }

    // Row 5: Best gas indicator (label color, right-aligned)
    // Issue #51: recommendBestGas() returns -1 when no tank has a PO2 inside
    // the operational window. Surface that as "NO SAFE GAS" in warning colour
    // rather than pointing at some other tank as "Best".
    cx.font = labelFont; cx.textAlign = 'right';
    var bestText;
    if (bestIdx === -1) {
        // Issue #39: "no safe gas" is danger tier \u2014 no valid PO2 window.
        bestText = hudDangerPrefix() + 'NO SAFE GAS';
        cx.fillStyle = hudColor('danger');
    } else if (isBest) {
        bestText = 'Best: \u2713';
        cx.fillStyle = hudColor('ok');
    } else {
        bestText = 'Best: T' + (bestIdx + 1);
        // Blink ok/grey every 500ms if a better tank is available \u2014 the
        // blink itself is the primary non-colour cue for "switch me".
        var blink = Math.floor(Date.now() / 500) % 2 === 0;
        cx.fillStyle = blink ? hudColor('ok') : '#888';
    }
    cx.fillText(bestText, box0X + box0W - padR, bY5);
    } // end OC/CCR gas box

    // --- Box 1: MAX / AVG / AMV ---
    drawSlot(box1X, box1W);

    // Box 1 Row 1: MAX
    var bR1Y = slotY + rowH * 0 + s(14);
    cx.font = labelFont; cx.fillStyle = labelColor; cx.textAlign = 'left';
    cx.fillText('MAX', box1X + padL, bR1Y);
    cx.font = valueFont; cx.fillStyle = valueColor; cx.textAlign = 'right';
    cx.fillText(maxDepth.toFixed(1) + ' m', box1X + box1W - padL, bR1Y);

    // Box 1 Row 2: AVG
    var bR2Y = slotY + rowH * 1 + s(14);
    cx.font = labelFont; cx.fillStyle = labelColor; cx.textAlign = 'left';
    cx.fillText('AVG', box1X + padL, bR2Y);
    cx.font = valueFont; cx.fillStyle = valueColor; cx.textAlign = 'right';
    cx.fillText(avgDepthVal.toFixed(1) + ' m', box1X + box1W - padL, bR2Y);

    // Box 1 Row 3: AMV — a configured user preference, not a status tier;
    // keep the amber literal (not in HUD_COLORS scope).
    var bR3Y = slotY + rowH * 2 + s(14);
    cx.font = labelFont; cx.fillStyle = labelColor; cx.textAlign = 'left';
    cx.fillText('AMV', box1X + padL, bR3Y);
    cx.font = valueFont; cx.fillStyle = '#ffcc00'; cx.textAlign = 'right';
    cx.fillText(amvRate + ' L/min', box1X + box1W - padL, bR3Y);

    // --- Box 2: GTR / TTS / CEIL ---
    drawSlot(box2X, box2W);

    // Box 2 Row 1: GTR (issue #39: colours + ⚠ prefix on danger)
    bR1Y = slotY + rowH * 0 + s(14);
    cx.font = labelFont; cx.fillStyle = labelColor; cx.textAlign = 'left';
    cx.fillText('GTR', box2X + padL, bR1Y);
    var gtrIsDanger = gtr < 10;
    var gtrColor2 = hudColor('ok');
    if (gtrIsDanger) gtrColor2 = hudColor('danger');
    else if (gtr < 30) gtrColor2 = hudColor('caution');
    cx.font = valueFont; cx.fillStyle = gtrColor2; cx.textAlign = 'right';
    var gtrText = gtr >= 999 ? '---' : Math.floor(gtr) + ' min';
    if (gtrIsDanger && gtr < 999) gtrText = hudDangerPrefix() + gtrText;
    cx.fillText(gtrText, box2X + box2W - padL, bR1Y);

    // Box 2 Row 2: TTS (in-deco is warn tier)
    bR2Y = slotY + rowH * 1 + s(14);
    cx.font = labelFont; cx.fillStyle = labelColor; cx.textAlign = 'left';
    cx.fillText('TTS', box2X + padL, bR2Y);
    var ttsVal = frameCalc.tts;
    cx.font = valueFont;
    cx.fillStyle = ttsVal > 0 ? (inDeco ? hudColor('warn') : '#eaf2ff') : '#555';
    cx.textAlign = 'right';
    cx.fillText(ttsVal > 0 ? ttsVal + ' min' : '--', box2X + box2W - padL, bR2Y);

    // Box 2 Row 3: PO2 (issue #39: ⚠ prefix on danger)
    bR3Y = slotY + rowH * 2 + s(14);
    cx.font = labelFont; cx.fillStyle = labelColor; cx.textAlign = 'left';
    cx.fillText('PO2', box2X + padL, bR3Y);
    cx.font = valueFont;
    cx.fillStyle = po2Color(po2);
    cx.textAlign = 'right';
    cx.fillText((po2IsDanger(po2) ? hudDangerPrefix() : '') + po2.toFixed(2), box2X + box2W - padL, bR3Y);
    cx.textAlign = 'left';

    // Vertical dividers between bottom info boxes
    cx.strokeStyle = '#8694a1';
    cx.lineWidth = 1;
    cx.beginPath();
    cx.moveTo(box0X + box0W + Math.floor(slotGap / 2), slotY);
    cx.lineTo(box0X + box0W + Math.floor(slotGap / 2), slotY + slotH);
    cx.stroke();
    cx.beginPath();
    cx.moveTo(box1X + box1W + Math.floor(slotGap / 2), slotY);
    cx.lineTo(box1X + box1W + Math.floor(slotGap / 2), slotY + slotH);
    cx.stroke();

    } else if (infoPageMode === 1 || infoPageMode === 2) {
        // WP-037/038: Tank inventory pages
        var startTank = (infoPageMode - 1) * 3;
        for (var ti = 0; ti < 3; ti++) {
            var tankIdx = startTank + ti;
            var bX = (ti === 0) ? box0X : (ti === 1) ? box1X : box2X;
            var bW = (ti === 0) ? box0W : (ti === 1) ? box1W : box2W;
            if (tankIdx < tankCount) {
                tk = tanks[tankIdx];
                var tkBar = Math.round(tk.gasRemaining / tk.volume);
                var tkIsDanger = tkBar < 50;
                var tkBarColor = tkBar > 100 ? hudColor('ok') : tkBar >= 50 ? hudColor('caution') : hudColor('danger');
                var tkMOD = Math.floor(((PO2_HIGH / tk.fO2) - 1) * 10);
                // Row 1: Tank label
                cx.font = valueFont; cx.fillStyle = (tankIdx === activeTank) ? '#33ffcc' : '#fff';
                cx.textAlign = 'left';
                cx.fillText('T' + (tankIdx + 1), bX + padL, bY1);
                // Row 2: Gas mix
                cx.font = labelFont; cx.fillStyle = '#a8b6cc'; cx.textAlign = 'left';
                cx.fillText(tk.label, bX + padL, bY2);
                // Row 3: Pressure bar + value
                var tBarX = bX + padL;
                var tBarY = bY3 - s(7);
                var tBarW2 = bW - padL * 2 - s(40);
                var tBarH2 = s(8);
                cx.fillStyle = 'rgba(255,255,255,0.06)';
                cx.beginPath(); cx.roundRect(tBarX, tBarY, tBarW2, tBarH2, s(3)); cx.fill();
                var tBarFrac = Math.max(0, Math.min(1, tkBar / 200));
                if (tBarFrac > 0) {
                    cx.save(); cx.beginPath(); cx.roundRect(tBarX, tBarY, tBarW2, tBarH2, s(3)); cx.clip();
                    cx.fillStyle = tkBarColor; cx.fillRect(tBarX, tBarY, tBarW2 * tBarFrac, tBarH2);
                    cx.restore();
                }
                // Issue #39: threshold ticks at 50 / 100 bar (same as active-tank bar).
                cx.strokeStyle = 'rgba(255,255,255,0.55)';
                cx.lineWidth = 1;
                var _tkT50X = tBarX + (50 / 200) * tBarW2;
                var _tkT100X = tBarX + (100 / 200) * tBarW2;
                cx.beginPath();
                cx.moveTo(_tkT50X, tBarY - s(1));
                cx.lineTo(_tkT50X, tBarY + tBarH2 + s(1));
                cx.moveTo(_tkT100X, tBarY - s(1));
                cx.lineTo(_tkT100X, tBarY + tBarH2 + s(1));
                cx.stroke();
                cx.font = valueFont; cx.fillStyle = tkBarColor; cx.textAlign = 'right';
                cx.fillText((tkIsDanger ? hudDangerPrefix() : '') + tkBar + 'b', bX + bW - padL, tBarY + tBarH2 - s(1));
                // Row 4: MOD
                cx.font = labelFont; cx.fillStyle = labelColor; cx.textAlign = 'left';
                cx.fillText('MOD', bX + padL, bY4);
                cx.font = valueFont; cx.fillStyle = valueColor; cx.textAlign = 'right';
                cx.fillText(tkMOD + 'm', bX + bW - padL, bY4);
                // Row 5: Active indicator
                if (tankIdx === activeTank) {
                    cx.font = labelFont; cx.fillStyle = '#33ffcc'; cx.textAlign = 'center';
                    cx.fillText('ACTIVE', bX + bW / 2, bY5);
                }
            } else {
                cx.font = labelFont; cx.fillStyle = '#444'; cx.textAlign = 'center';
                cx.fillText('---', bX + bW / 2, bY3);
            }
        }
        // Vertical dividers between tank slots
        cx.strokeStyle = '#8694a1';
        cx.lineWidth = 1;
        cx.beginPath();
        cx.moveTo(box0X + box0W + Math.floor(slotGap / 2), slotY);
        cx.lineTo(box0X + box0W + Math.floor(slotGap / 2), slotY + slotH);
        cx.stroke();
        cx.beginPath();
        cx.moveTo(box1X + box1W + Math.floor(slotGap / 2), slotY);
        cx.lineTo(box1X + box1W + Math.floor(slotGap / 2), slotY + slotH);
        cx.stroke();

    } else if (infoPageMode === 3) {
        // WP-038: Tissue bar graph page
        cx.font = s(10) + "px " + DCF; cx.fillStyle = '#8694a1'; cx.textAlign = 'left';
        cx.fillText('TISSUES', contentX + s(4), slotY + s(10));

        var barAreaX = contentX + s(4);
        var barAreaW = contentW - s(8);
        var barAreaTop = slotY + s(14);
        var barAreaH = slotH - s(20);
        var barGap = s(2);
        barW = Math.floor((barAreaW - barGap * 15) / 16);
        var pAmb = ambientPressure(depth);

        for (i = 0; i < 16; i++) {
            var ab = combinedAB(i);
            var ptTotal = tissues[i] + tissuesHe[i];
            var mVal = ab.a + pAmb / ab.b;
            var ratio = ptTotal / mVal;
            ratio = Math.max(0, Math.min(1.2, ratio));
            var bx = barAreaX + i * (barW + barGap);
            var bh = Math.round(ratio * barAreaH / 1.2);
            var by = barAreaTop + barAreaH - bh;

            // Background (unfilled portion)
            cx.fillStyle = 'rgba(255,255,255,0.06)';
            cx.fillRect(bx, barAreaTop, barW, barAreaH);

            // Bar color based on ratio — issue #39 via hudColor().
            var bColor = ratio >= 1.0 ? hudColor('danger') : ratio >= 0.8 ? hudColor('caution') : hudColor('ok');
            cx.fillStyle = bColor;
            cx.fillRect(bx, by, barW, bh);
        }

        // Compartment labels
        cx.font = s(7) + "px " + DCF; cx.fillStyle = '#555'; cx.textAlign = 'center';
        var labelIdxs = [0, 3, 7, 11, 15];
        for (var li = 0; li < labelIdxs.length; li++) {
            var idx = labelIdxs[li];
            var lx = barAreaX + idx * (barW + barGap) + barW / 2;
            cx.fillText(String(idx + 1), lx, barAreaTop + barAreaH + s(8));
        }

    } else if (infoPageMode === 4) {
        // WP-039: Deco metrics page — 3-row layout matching Box 3.2/3.3
        pAmb = ambientPressure(depth);

        // GF99 calculation
        var gf99 = 0;
        for (i = 0; i < 16; i++) {
            ab = combinedAB(i);
            ptTotal = tissues[i] + tissuesHe[i];
            mVal = ab.a + pAmb / ab.b;
            var gfi = (mVal - pAmb) > 0.0001 ? (ptTotal - pAmb) / (mVal - pAmb) * 100 : 0;
            if (gfi > gf99) gf99 = gfi;
        }
        gf99 = Math.max(0, Math.round(gf99));

        // SurfGF calculation
        var surfGF = 0;
        var pSurf = 1.0;
        for (i = 0; i < 16; i++) {
            ab = combinedAB(i);
            ptTotal = tissues[i] + tissuesHe[i];
            mVal = ab.a + pSurf / ab.b;
            gfi = (mVal - pSurf) > 0.0001 ? (ptTotal - pSurf) / (mVal - pSurf) * 100 : 0;
            if (gfi > surfGF) surfGF = gfi;
        }
        surfGF = Math.max(0, Math.round(surfGF));

        // Use 3-row Y positions (same as Box 3.2/3.3)
        var gR1Y = slotY + rowH * 0 + s(14);
        var gR2Y = slotY + rowH * 1 + s(14);
        var gR3Y = slotY + rowH * 2 + s(14);

        // Box 0: GF99 / SurfGF / CNS — issue #39 via hudColor() + ⚠ prefix.
        cx.font = labelFont; cx.fillStyle = labelColor; cx.textAlign = 'left';
        cx.fillText('GF99', box0X + padL, gR1Y);
        var gf99IsDanger = gf99 >= 100;
        var gf99Color = gf99IsDanger ? hudColor('danger') : gf99 >= 80 ? hudColor('caution') : hudColor('ok');
        cx.font = valueFont; cx.fillStyle = gf99Color; cx.textAlign = 'right';
        cx.fillText((gf99IsDanger ? hudDangerPrefix() : '') + gf99 + '%', box0X + box0W - padL, gR1Y);

        cx.font = labelFont; cx.fillStyle = labelColor; cx.textAlign = 'left';
        cx.fillText('SrfGF', box0X + padL, gR2Y);
        var surfGFIsDanger = surfGF >= 100;
        var surfGFColor = surfGFIsDanger ? hudColor('danger') : surfGF >= 80 ? hudColor('caution') : hudColor('ok');
        cx.font = valueFont; cx.fillStyle = surfGFColor; cx.textAlign = 'right';
        cx.fillText((surfGFIsDanger ? hudDangerPrefix() : '') + surfGF + '%', box0X + box0W - padL, gR2Y);

        var cnsVal = Math.round(cnsPercent);
        var cnsIsDanger = cnsVal >= 80;
        var cnsColor = cnsIsDanger ? hudColor('danger') : cnsVal >= 50 ? hudColor('caution') : hudColor('ok');
        cx.font = labelFont; cx.fillStyle = labelColor; cx.textAlign = 'left';
        cx.fillText('CNS', box0X + padL, gR3Y);
        cx.font = valueFont; cx.fillStyle = cnsColor; cx.textAlign = 'right';
        cx.fillText((cnsIsDanger ? hudDangerPrefix() : '') + cnsVal + '%', box0X + box0W - padL, gR3Y);

        // Box 1: CEIL / GF Lo / GF Hi
        // Issue #14: tissues are frozen once the dive ends (updateTissues()
        // no longer runs), so frameCalc's value from the last diving tick
        // is numerically identical to a fresh call here.
        var ceilVal = frameCalc.ceiling;
        cx.font = labelFont; cx.fillStyle = labelColor; cx.textAlign = 'left';
        cx.fillText('CEIL', box1X + padL, gR1Y);
        cx.font = valueFont; cx.fillStyle = ceilVal > 0 ? hudColor('warn') : hudColor('ok'); cx.textAlign = 'right';
        cx.fillText(ceilVal > 0 ? ceilVal.toFixed(1) + 'm' : '0m', box1X + box1W - padL, gR1Y);

        cx.font = labelFont; cx.fillStyle = labelColor; cx.textAlign = 'left';
        cx.fillText('GF Lo', box1X + padL, gR2Y);
        cx.font = valueFont; cx.fillStyle = valueColor; cx.textAlign = 'right';
        cx.fillText(gfLow + '%', box1X + box1W - padL, gR2Y);

        cx.font = labelFont; cx.fillStyle = labelColor; cx.textAlign = 'left';
        cx.fillText('GF Hi', box1X + padL, gR3Y);
        cx.font = valueFont; cx.fillStyle = valueColor; cx.textAlign = 'right';
        cx.fillText(gfHigh + '%', box1X + box1W - padL, gR3Y);

        // Box 2: TTS / NDL / PO2 (additional useful metrics) — issue #39 via hudColor().
        var ttsVal2 = frameCalc.tts;
        cx.font = labelFont; cx.fillStyle = labelColor; cx.textAlign = 'left';
        cx.fillText('TTS', box2X + padL, gR1Y);
        cx.font = valueFont;
        cx.fillStyle = ttsVal2 > 0 ? hudColor('warn') : '#555';
        cx.textAlign = 'right';
        cx.fillText(ttsVal2 > 0 ? ttsVal2 + ' min' : '--', box2X + box2W - padL, gR1Y);

        cx.font = labelFont; cx.fillStyle = labelColor; cx.textAlign = 'left';
        cx.fillText('NDL', box2X + padL, gR2Y);
        cx.font = valueFont;
        var ndlIsDanger2 = ndl < 5;
        var ndlColor2 = ndlIsDanger2 ? hudColor('danger') : ndl < 15 ? hudColor('caution') : hudColor('ok');
        cx.fillStyle = ndlColor2; cx.textAlign = 'right';
        var ndlText2 = ndl >= 999 ? '---' : (ndl > 99 ? '99' : ndl) + ' min';
        if (ndlIsDanger2 && ndl < 999) ndlText2 = hudDangerPrefix() + ndlText2;
        cx.fillText(ndlText2, box2X + box2W - padL, gR2Y);

        cx.font = labelFont; cx.fillStyle = labelColor; cx.textAlign = 'left';
        cx.fillText('PO2', box2X + padL, gR3Y);
        cx.font = valueFont; cx.fillStyle = po2Color(po2); cx.textAlign = 'right';
        cx.fillText((po2IsDanger(po2) ? hudDangerPrefix() : '') + po2.toFixed(2), box2X + box2W - padL, gR3Y);

        // Vertical dividers
        cx.strokeStyle = '#8694a1';
        cx.lineWidth = 1;
        cx.beginPath();
        cx.moveTo(box0X + box0W + Math.floor(slotGap / 2), slotY);
        cx.lineTo(box0X + box0W + Math.floor(slotGap / 2), slotY + slotH);
        cx.stroke();
        cx.beginPath();
        cx.moveTo(box1X + box1W + Math.floor(slotGap / 2), slotY);
        cx.lineTo(box1X + box1W + Math.floor(slotGap / 2), slotY + slotH);
        cx.stroke();
    } else if (infoPageMode === 5 && diveMode === 'ccr') {
        // BUG-CCR-3: CCR-specific gas-info page. Shows actual PO2, target SP,
        // O2 cylinder, diluent cylinder + mix, scrubber minutes remaining.
        var ccrInfoR1Y = slotY + rowH * 0 + s(14);
        var ccrInfoR2Y = slotY + rowH * 1 + s(14);
        var ccrInfoR3Y = slotY + rowH * 2 + s(14);

        var po2Actual = ccrState.actualPO2;
        var po2ActualIsDanger = po2Actual < PO2_HYPOXIA || po2Actual > PO2_HIGH;
        var po2ActualColor = po2ActualIsDanger ? hudColor('danger')
            : po2Actual > PO2_ELEVATED ? hudColor('warn')
            : po2Actual > PO2_SAFE ? hudColor('caution') : hudColor('ok');
        var o2Bar5 = Math.round(ccrState.o2CylPressure);
        var dilBar5 = Math.round(ccrState.dilCylPressure);
        var scrMin5 = Math.round(ccrState.scrubberRemaining);
        var scrIsDanger5 = scrMin5 < 10;
        var scrColor5 = scrIsDanger5 ? hudColor('danger') : scrMin5 < 30 ? hudColor('caution') : hudColor('ok');
        var o2IsDanger5 = o2Bar5 < 30;
        var dilIsDanger5 = dilBar5 < 30;
        var o2Color5 = o2IsDanger5 ? hudColor('danger') : '#eaf2ff';
        var dilColor5 = dilIsDanger5 ? hudColor('danger') : '#eaf2ff';

        // Box 0: PO2 actual / SP target / mode (CCR or BAIL) — issue #39 ⚠ on danger.
        cx.font = labelFont; cx.fillStyle = labelColor; cx.textAlign = 'left';
        cx.fillText('PO2', box0X + padL, ccrInfoR1Y);
        cx.font = valueFont; cx.fillStyle = po2ActualColor; cx.textAlign = 'right';
        cx.fillText((po2ActualIsDanger ? hudDangerPrefix() : '') + po2Actual.toFixed(2), box0X + box0W - padL, ccrInfoR1Y);

        cx.font = labelFont; cx.fillStyle = labelColor; cx.textAlign = 'left';
        cx.fillText('SP', box0X + padL, ccrInfoR2Y);
        cx.font = valueFont; cx.fillStyle = '#ffcc00'; cx.textAlign = 'right';
        cx.fillText(ccrState.targetSP.toFixed(1), box0X + box0W - padL, ccrInfoR2Y);

        cx.font = labelFont; cx.fillStyle = labelColor; cx.textAlign = 'left';
        cx.fillText('MODE', box0X + padL, ccrInfoR3Y);
        cx.font = valueFont;
        cx.fillStyle = ccrState.onBailout ? hudColor('danger') : hudColor('ok');
        cx.textAlign = 'right';
        cx.fillText((ccrState.onBailout ? hudDangerPrefix() : '') + (ccrState.onBailout ? 'BAIL' : 'CCR'), box0X + box0W - padL, ccrInfoR3Y);

        // Box 1: O2 cyl pressure / O2 cyl volume / scrubber (⚠ prefix on danger)
        cx.font = labelFont; cx.fillStyle = labelColor; cx.textAlign = 'left';
        cx.fillText('O2 P', box1X + padL, ccrInfoR1Y);
        cx.font = valueFont; cx.fillStyle = o2Color5; cx.textAlign = 'right';
        cx.fillText((o2IsDanger5 ? hudDangerPrefix() : '') + o2Bar5 + 'b', box1X + box1W - padL, ccrInfoR1Y);

        cx.font = labelFont; cx.fillStyle = labelColor; cx.textAlign = 'left';
        cx.fillText('O2 V', box1X + padL, ccrInfoR2Y);
        cx.font = valueFont; cx.fillStyle = '#eaf2ff'; cx.textAlign = 'right';
        cx.fillText(ccrState.o2CylVolume + 'L', box1X + box1W - padL, ccrInfoR2Y);

        cx.font = labelFont; cx.fillStyle = labelColor; cx.textAlign = 'left';
        cx.fillText('SCR', box1X + padL, ccrInfoR3Y);
        cx.font = valueFont; cx.fillStyle = scrColor5; cx.textAlign = 'right';
        cx.fillText((scrIsDanger5 ? hudDangerPrefix() : '') + scrMin5 + 'm', box1X + box1W - padL, ccrInfoR3Y);

        // Box 2: diluent pressure / diluent volume / diluent mix label
        cx.font = labelFont; cx.fillStyle = labelColor; cx.textAlign = 'left';
        cx.fillText('DIL P', box2X + padL, ccrInfoR1Y);
        cx.font = valueFont; cx.fillStyle = dilColor5; cx.textAlign = 'right';
        cx.fillText((dilIsDanger5 ? hudDangerPrefix() : '') + dilBar5 + 'b', box2X + box2W - padL, ccrInfoR1Y);

        cx.font = labelFont; cx.fillStyle = labelColor; cx.textAlign = 'left';
        cx.fillText('DIL V', box2X + padL, ccrInfoR2Y);
        cx.font = valueFont; cx.fillStyle = '#eaf2ff'; cx.textAlign = 'right';
        cx.fillText(ccrState.dilCylVolume + 'L', box2X + box2W - padL, ccrInfoR2Y);

        cx.font = labelFont; cx.fillStyle = labelColor; cx.textAlign = 'left';
        cx.fillText('MIX', box2X + padL, ccrInfoR3Y);
        cx.font = valueFont; cx.fillStyle = '#66ccff'; cx.textAlign = 'right';
        cx.fillText(ccrDilPresetName(), box2X + box2W - padL, ccrInfoR3Y);

        // Vertical dividers (matches other info pages)
        cx.strokeStyle = '#8694a1';
        cx.lineWidth = 1;
        cx.beginPath();
        cx.moveTo(box0X + box0W + Math.floor(slotGap / 2), slotY);
        cx.lineTo(box0X + box0W + Math.floor(slotGap / 2), slotY + slotH);
        cx.stroke();
        cx.beginPath();
        cx.moveTo(box1X + box1W + Math.floor(slotGap / 2), slotY);
        cx.lineTo(box1X + box1W + Math.floor(slotGap / 2), slotY + slotH);
        cx.stroke();
    }

    // ================================================================
    //  TASK-032E: CCR Warning Banner (flashing)
    // ================================================================
    if (diveMode === 'ccr') {
      var ccrWarnText = '';
      var ccrWarnColor = hudColor('danger');
      if (ccrState.actualPO2 < 0.18 && !ccrState.onBailout) ccrWarnText = 'LOW PO2';
      else if (ccrState.actualPO2 > 1.5 && !ccrState.onBailout) ccrWarnText = 'HIGH PO2';
      if (ccrState.scrubberFailed && !ccrState.onBailout) ccrWarnText = 'CO2!';
      if (!ccrState.scrubberFailed && ccrState.scrubberRemaining < 10 && ccrState.scrubberRemaining > 0 && !ccrState.onBailout) {
        ccrWarnText = 'SCR LOW'; ccrWarnColor = hudColor('caution');
      }
      if (ccrWarnText && Math.floor(Date.now() / 500) % 2 === 0) {
        cx.font = 'bold ' + s(14) + "px " + DCF;
        cx.fillStyle = ccrWarnColor;
        cx.textAlign = 'center';
        cx.fillText(ccrWarnText, dcX + dcW / 2, warnBannerTop + s(14));
      }
      if (ccrWarnText) {
        if (!ccrWarningBeepTriggered) { playAlertBeep(); ccrWarningBeepTriggered = true; }
      } else {
        ccrWarningBeepTriggered = false;
      }
    }

    // ================================================================
    //  Alert beep (preserved)
    // ================================================================
    var hasWarning = (tBar < 50) || (po2 > PO2_HIGH) || (ascentRate > 9) || (inDeco && depth < decoStopDepth) || (narcosisIndex > 0.20);
    if (hasWarning) playAlertBeep();

    cx.restore();
}

// SECTION: Dive profile chart
// SEARCH TERMS: drawDiveProfileChart, diveProfile, depth-time chart

// ============================================================
//  WP-034: DIVE PROFILE CHART
// ============================================================

function drawDiveProfileChart(cx, x, y, w, h) {
    if (diveProfile.length < 2) return;

    // Chart frame
    cx.fillStyle = '#000';
    cx.fillRect(x, y, w, h);
    cx.strokeStyle = '#fff';
    cx.lineWidth = 1;
    cx.strokeRect(x, y, w, h);

    // Determine scales
    var maxD = 0;
    var maxT = diveTime;
    for (var i = 0; i < diveProfile.length; i++) {
        if (diveProfile[i].depth > maxD) maxD = diveProfile[i].depth;
    }
    if (maxD < 1) maxD = 1;
    if (maxT < 1) maxT = 1;

    var pad = 4;
    var chartX = x + pad;
    var chartY = y + pad;
    var chartW = w - pad * 2;
    var chartH = h - pad * 2;

    // Horizontal grid lines every 10m
    cx.strokeStyle = 'rgba(255,255,255,0.25)';
    cx.lineWidth = 0.5;
    var gridStep = 10;
    for (var gd = gridStep; gd < maxD; gd += gridStep) {
        var gy = chartY + (gd / maxD) * chartH;
        cx.beginPath();
        cx.moveTo(chartX, gy);
        cx.lineTo(chartX + chartW, gy);
        cx.stroke();
    }

    // Draw depth polyline (blue)
    cx.beginPath();
    cx.strokeStyle = '#17a8ff';
    cx.lineWidth = 2;
    for (i = 0; i < diveProfile.length; i++) {
        var px = chartX + (diveProfile[i].t / maxT) * chartW;
        var py = chartY + (diveProfile[i].depth / maxD) * chartH;
        if (i === 0) cx.moveTo(px, py);
        else cx.lineTo(px, py);
    }
    cx.stroke();

    // Draw ceiling polyline (danger tier, only where ceiling > 0)
    cx.beginPath();
    cx.strokeStyle = hudColor('danger');
    cx.lineWidth = 1.5;
    var inCeiling = false;
    for (i = 0; i < diveProfile.length; i++) {
        var ceil = diveProfile[i].ceiling;
        if (ceil > 0) {
            px = chartX + (diveProfile[i].t / maxT) * chartW;
            py = chartY + (ceil / maxD) * chartH;
            if (!inCeiling) { cx.moveTo(px, py); inCeiling = true; }
            else cx.lineTo(px, py);
        } else {
            if (inCeiling) { cx.stroke(); cx.beginPath(); inCeiling = false; }
        }
    }
    if (inCeiling) cx.stroke();

    // Issue #44: Violation markers — small dots at (t, depth-at-that-t) for
    // each diveEvents entry so the player can see WHERE in the profile the
    // mistake happened. Depth is looked up from the nearest diveProfile
    // sample by timestamp. safetyStopSkipped is drawn amber at the surface
    // end of the chart (~5 m) since "where" isn't meaningful for it.
    if (typeof diveEvents !== 'undefined' && diveEvents.length > 0) {
        for (var ei = 0; ei < diveEvents.length; ei++) {
            var ev = diveEvents[ei];
            var evT = ev.t;
            var evDepth;
            if (ev.kind === 'safetyStopSkipped') {
                evT = diveProfile[diveProfile.length - 1].t;
                evDepth = 5;
            } else {
                var bestIdx = 0;
                var bestDt = Math.abs(diveProfile[0].t - evT);
                for (var pj = 1; pj < diveProfile.length; pj++) {
                    var dtp = Math.abs(diveProfile[pj].t - evT);
                    if (dtp < bestDt) { bestDt = dtp; bestIdx = pj; }
                }
                evDepth = diveProfile[bestIdx].depth;
            }
            var mx = chartX + (evT / maxT) * chartW;
            var my = chartY + (evDepth / maxD) * chartH;
            cx.beginPath();
            cx.arc(mx, my, 4, 0, Math.PI * 2);
            cx.fillStyle = ev.kind === 'safetyStopSkipped' ? '#ffb84d' : '#ff3b3b';
            cx.fill();
            cx.strokeStyle = 'rgba(0,0,0,0.6)';
            cx.lineWidth = 1;
            cx.stroke();
        }
    }

    // Labels
    cx.font = '11px monospace';
    cx.fillStyle = '#ccc';
    cx.textAlign = 'left';
    cx.fillText('0m', x + 3, y + 13);
    cx.fillText(maxD.toFixed(0) + 'm', x + 3, y + h - 4);
    cx.textAlign = 'right';
    cx.fillText(formatTime(maxT), x + w - 3, y + h - 4);
    cx.textAlign = 'center';
}

// SECTION: Post-dive summary screen
// SEARCH TERMS: drawPostDive, maxDepth, avgDepth, diveTime, CNS, tissue saturation

// ============================================================
//  POST-DIVE SUMMARY
// ============================================================

// Shared backdrop + panel helpers for the result screens
function gsBackdrop(cx, W, H) {
    var g = cx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#0b1418');
    g.addColorStop(0.7, '#06090c');
    g.addColorStop(1, '#04070a');
    cx.fillStyle = g;
    cx.fillRect(0, 0, W, H);
    var rg = cx.createRadialGradient(W / 2, -H * 0.1, 40, W / 2, H * 0.2, H * 0.75);
    rg.addColorStop(0, 'rgba(40,120,140,0.16)');
    rg.addColorStop(1, 'rgba(40,120,140,0)');
    cx.fillStyle = rg;
    cx.fillRect(0, 0, W, H);
}

function gsPanel(cx, x, y, w, h, r) {
    cx.beginPath();
    cx.roundRect(x, y, w, h, r || 16);
    cx.fillStyle = '#0d161b';
    cx.fill();
    cx.strokeStyle = '#18242a';
    cx.lineWidth = 1;
    cx.stroke();
}

// ============================================================
// Issue #46: Instructor overlay ("Learn" mode)
// ============================================================
// Narrow (~230px) semi-transparent left-edge panel of six live-physics
// rows. Called from drawScene() after every darkness/silt/torch pass so
// it stays fully readable regardless of the world tint.
//
// Contract:
//   - No expensive calculations. Reads existing per-tick state:
//     bcdGasSurfaceLiters, tissues[], tissuesHe[], bubbles[],
//     narcosisIndex, amvRate, ccrState. When it needs a schedule/ceiling
//     it reads frameCalc (populated by updateDiving()) rather than
//     calling calculateCeiling() fresh.
//   - Values equal what the dive computer / grade / MOD readout show —
//     the panel is a WINDOW onto the existing physics, not a second
//     source of truth.
//   - All display strings via S(...) so a mid-dive language toggle
//     updates the overlay on the next frame.
const INSTRUCTOR_PANEL_W = 230;
const INSTRUCTOR_ROW_H   = 46;    // px per row (title + value + subtext)
const INSTRUCTOR_ROWS    = 6;
const INSTRUCTOR_PAD_X   = 10;
const INSTRUCTOR_TOP_Y_FRAC = 0.12;   // top edge as fraction of cssHeight
// Rounded to the same 4-halftime buckets the ZHL16C table uses for its
// row labels in the tissue-bar page; keeps the panel's compartment label
// consistent with what a diver already sees on the Info page.
const INSTRUCTOR_TISSUE_MIN_LOAD = 0.001;  // ignore compartments essentially at 0
// Highlight thresholds for the leading-tissue % row. Same three-bucket
// pattern that the existing GF99 row uses on the info page (46f08f /
// ffd24d / ff3333) — matched deliberately so a diver reading both at
// once gets the same colour code for the same underlying saturation.
const INSTRUCTOR_TISSUE_WARN_PCT = 80;
const INSTRUCTOR_TISSUE_CRIT_PCT = 100;

// Pick the leading compartment (highest saturation as % of surface
// M-value). Returns { i, pct, ht } or null if no compartment is loaded.
// Runs the same combinedAB() math the ceiling/GF99 pages use, so a
// SurfGF row of, e.g., 42% on the info page yields the same pct here for
// the same tick — this is what the "no double-calculation" requirement
// in the issue asks for.
function _instructorLeadingTissue() {
    var pSurf = 1.0;
    var lead = -1;
    var leadPct = -1;
    for (var i = 0; i < 16; i++) {
        var ptTotal = tissues[i] + tissuesHe[i];
        if (ptTotal <= INSTRUCTOR_TISSUE_MIN_LOAD) continue;
        var ab = combinedAB(i);
        var mVal = ab.a + pSurf / ab.b;
        var denom = mVal - pSurf;
        var pct = denom > 0.0001 ? (ptTotal - pSurf) / denom * 100 : 0;
        if (pct > leadPct) { leadPct = pct; lead = i; }
    }
    if (lead < 0) return null;
    return { i: lead, pct: leadPct, ht: ZHL16C_N2[lead].ht };
}

function drawInstructorOverlay() {
    var cx = ctx;
    var W = cssWidth;
    var H = cssHeight;

    var panelW = INSTRUCTOR_PANEL_W;
    var rowH   = INSTRUCTOR_ROW_H;
    var panelH = rowH * INSTRUCTOR_ROWS + 46; // + title header
    var panelX = 8;
    var panelY = Math.max(8, Math.floor(H * INSTRUCTOR_TOP_Y_FRAC));

    // Panel background — a bit darker than gsPanel + explicit alpha so
    // it doesn't hide the dive-computer HUD if they ever overlap (they
    // won't at default HUD placement, but the panel scales with viewport
    // height and this defends against a small-window edge case).
    cx.save();
    cx.beginPath();
    cx.roundRect(panelX, panelY, panelW, panelH, 10);
    cx.fillStyle = 'rgba(10, 18, 24, 0.82)';
    cx.fill();
    cx.strokeStyle = 'rgba(52, 230, 255, 0.35)';
    cx.lineWidth = 1;
    cx.stroke();

    cx.textAlign = 'left';
    var padX = panelX + INSTRUCTOR_PAD_X;

    // Title
    cx.font = 'bold 12px monospace';
    cx.fillStyle = '#34e6ff';
    cx.fillText(S('instructorTitle'), padX, panelY + 18);
    cx.font = '9px monospace';
    cx.fillStyle = '#6b8a95';
    cx.fillText(S('instructorHintOff'), padX, panelY + 32);

    var rowTopY = panelY + 46;

    // Precompute the values ONCE — the overlay must never trigger a
    // second calculateCeiling()/calculateNDL() call this frame.
    var P    = ambientPressure(depth);
    var gas  = activeGas();
    var fO2  = gas.fO2;
    var mod  = calculateMOD(fO2);          // cheap: arithmetic only
    var end  = calculateEND();             // cheap: arithmetic only
    var bcdSurf = bcdGasSurfaceLiters;
    var bcdEff  = P > 0 ? bcdSurf / P : 0;
    var bcdMax  = (typeof BUOYANCY_PARAMS !== 'undefined' && BUOYANCY_PARAMS.bcdMaxCapacity)
        ? BUOYANCY_PARAMS.bcdMaxCapacity : 18;
    var sac  = amvRate * P;                 // surface-liters/min at depth
    var lead = _instructorLeadingTissue();
    // Newest bubble in flight (last emitted with depth > 0). We scan
    // from the end because updateBubbles() splices out surfaced bubbles
    // in reverse order — the last live entry is the youngest.
    var newest = null;
    for (var bi = bubbles.length - 1; bi >= 0; bi--) {
        if (bubbles[bi].depth > 0.1) { newest = bubbles[bi]; break; }
    }
    var bubblePctGain = null;
    if (newest) {
        // bubbleDisplayRadius() already applies the (Pe/Pn)^(1/3) growth;
        // don't reinvent the exponent here.
        var r0 = newest.emissionRadius;
        var r1 = bubbleDisplayRadius(newest);
        if (r0 > 0) bubblePctGain = (r1 / r0 - 1) * 100;
    }

    var y = rowTopY;

    // Fonts / colours shared across rows
    var labelFont   = 'bold 10px monospace';
    var valueFont   = 'bold 13px monospace';
    var subFont     = '9px monospace';
    var labelColor  = '#8fb2bd';
    var valueColor  = '#e0f4fb';
    var subColor    = '#6b8a95';

    function drawRow(label, value, sub, valColor) {
        cx.font = labelFont;
        cx.fillStyle = labelColor;
        cx.fillText(label, padX, y + 12);
        cx.font = valueFont;
        cx.fillStyle = valColor || valueColor;
        cx.fillText(value, padX, y + 28);
        cx.font = subFont;
        cx.fillStyle = subColor;
        cx.fillText(sub, padX, y + 40);
        y += rowH;
    }

    // Row 1 — Ambient pressure
    drawRow(
        S('instructorPressureRow'),
        P.toFixed(2) + ' bar',
        S('instructorPressureFormula')
    );

    // Row 2 — BCD Boyle's law (with an inline bar)
    cx.font = labelFont; cx.fillStyle = labelColor;
    cx.fillText(S('instructorBcdRow'), padX, y + 12);
    cx.font = valueFont; cx.fillStyle = valueColor;
    cx.fillText(bcdSurf.toFixed(1) + 'L / ' + bcdEff.toFixed(1) + 'L', padX, y + 28);
    // Mini bar: full-width = bcdMaxCapacity effective volume. Uses the
    // effective (depth-corrected) volume as the bar length so a diver at
    // depth SEES their BCD shrink under pressure. Surface-equivalent is
    // shown as a faint outline behind it.
    var barX = padX;
    var barY = y + 34;
    var barW = panelW - INSTRUCTOR_PAD_X * 2;
    var barH = 5;
    cx.fillStyle = 'rgba(80, 100, 110, 0.35)';
    cx.fillRect(barX, barY, barW, barH);
    var effFrac  = Math.max(0, Math.min(1, bcdEff  / bcdMax));
    var surfFrac = Math.max(0, Math.min(1, bcdSurf / bcdMax));
    cx.fillStyle = 'rgba(52, 230, 255, 0.35)';
    cx.fillRect(barX, barY, barW * surfFrac, barH);
    cx.fillStyle = '#34e6ff';
    cx.fillRect(barX, barY, barW * effFrac, barH);
    cx.font = subFont; cx.fillStyle = subColor;
    cx.fillText(S('instructorBcdFormula'), padX, y + rowH - 4);
    y += rowH;

    // Row 3 — Bubble expansion (annotated on the newest live bubble)
    if (newest && bubblePctGain !== null) {
        cx.font = labelFont; cx.fillStyle = labelColor;
        cx.fillText(S('instructorBubbleRow'), padX, y + 12);
        cx.font = valueFont; cx.fillStyle = '#a0f0ff';
        var sign = bubblePctGain >= 0 ? '+' : '';
        cx.fillText(sign + bubblePctGain.toFixed(0) + '% since exhale', padX, y + 28);
        cx.font = subFont; cx.fillStyle = subColor;
        cx.fillText(S('instructorBubbleFormula'), padX, y + 40);
        // Draw a thin annotation line from the panel to that bubble's
        // on-screen position. Kept subtle (alpha 0.35, 1px) so it reads
        // as instructional marginalia, not a game HUD element.
        var metersPerPixel = 0.05;
        var diverScreenY = H * 0.45;
        // Issue #100: diver screen anchor moved from W * 0.25 to
        // W * DIVER_SCREEN_X_FRACTION (0.5). Use the same constant so the
        // bubble-annotation line lands on the actual bubble sprite.
        var diverScreenX = W * DIVER_SCREEN_X_FRACTION;
        var bubScreenX = diverScreenX + newest.x;
        var bubScreenY = diverScreenY - (depth - newest.depth) / metersPerPixel;
        if (bubScreenX > panelX + panelW &&
            bubScreenX < W && bubScreenY > 0 && bubScreenY < H) {
            cx.save();
            cx.strokeStyle = 'rgba(160, 240, 255, 0.35)';
            cx.lineWidth = 1;
            cx.beginPath();
            cx.moveTo(panelX + panelW, y + 22);
            cx.lineTo(bubScreenX, bubScreenY);
            cx.stroke();
            cx.restore();
        }
        y += rowH;
    } else {
        drawRow(
            S('instructorBubbleRow'),
            S('instructorBubbleNone'),
            S('instructorBubbleFormula'),
            subColor
        );
    }

    // Row 4 — Leading tissue compartment
    if (lead) {
        // Issue #39 (review follow-up): route through hudColor() like every
        // other semantic HUD status colour, so this reacts to the CVD palette.
        var tissueColor = lead.pct >= INSTRUCTOR_TISSUE_CRIT_PCT ? hudColor('danger')
                        : lead.pct >= INSTRUCTOR_TISSUE_WARN_PCT ? hudColor('caution')
                        : hudColor('ok');
        drawRow(
            S('instructorTissueRow') + ' #' + (lead.i + 1) + '  (t½=' + lead.ht.toFixed(0) + 'min)',
            Math.max(0, Math.round(lead.pct)) + '% of M-value',
            S('instructorTissueFormula'),
            tissueColor
        );
    } else {
        drawRow(
            S('instructorTissueRow'),
            '—',
            S('instructorTissueNone'),
            subColor
        );
    }

    // Row 5 — Gas consumption
    drawRow(
        S('instructorConsRow'),
        sac.toFixed(1) + ' L/min  (×' + P.toFixed(1) + ')',
        S('instructorConsFormula')
    );

    // Row 6 — MOD / END
    // Issue #39 (review follow-up): route through hudColor() instead of a
    // hardcoded literal so this reacts to the CVD palette.
    var modColor = depth >= mod ? hudColor('warn') : valueColor;
    var narcPct = Math.round(narcosisIndex * 100);
    drawRow(
        S('instructorGasRow'),
        'MOD ' + Math.round(mod) + 'm | END ' + Math.round(end) + 'm | N ' + narcPct + '%',
        S('instructorGasFormula'),
        modColor
    );

    cx.restore();
    cx.textAlign = 'left';
}

// ============================================================
//  ISSUE #120 — RESULT-SCREEN SCROLL FRAME
//
//  drawPostDive() and drawGameOver() lay out in absolute pixels, so on a small
//  viewport they draw well past the bottom edge — and the page cannot scroll,
//  because style.css sets `html, body { overflow: hidden }`. Content below the
//  fold was simply unreachable.
//
//  These two helpers wrap a draw pass: the backdrop is painted unscrolled, the
//  body is drawn inside a translate, and the final `y` reported back becomes
//  the scroll bound for the next frame. Measuring the frame we just drew (as
//  opposed to a separate measure pass) keeps one source of layout truth; the
//  bound is right from the second frame on, and the first frame is drawn at
//  offset 0 anyway.
//
//  Content reserves BOTTOM_GUTTER at the end so the fixed touch CTA
//  (#touch-postdive-btn / #touch-gameover-btn, anchored bottom: 6%/12% in
//  style.css) never sits on top of the last line of text.
// ============================================================
var RESULT_BOTTOM_GUTTER = 96;

function beginResultScroll(cx) {
    cx.save();
    cx.translate(0, -resultScrollY);
}

// `contentBottomY` is the layout cursor after the last element was drawn.
function endResultScroll(cx, contentBottomY, W, H) {
    cx.restore();
    var overflow = Math.max(0, (contentBottomY + RESULT_BOTTOM_GUTTER) - H);
    resultScrollMaxY = overflow;
    if (resultScrollY > overflow) resultScrollY = overflow;
    // The CTA is a fixed DOM button (style.css anchors it bottom: 6%/12%), so
    // scrolling body text passes underneath it. Reserving space at the end of
    // the content is not enough on its own — text still crosses the button on
    // the way past. A scrim gives it a surface to disappear behind instead of
    // colliding with the label.
    if (isTouchDevice) drawResultFooterScrim(cx, W, H);
    if (overflow > 0) drawResultScrollIndicator(cx, W, H, overflow);
}

function drawResultFooterScrim(cx, W, H) {
    var band = Math.min(RESULT_BOTTOM_GUTTER, H * 0.28);
    var g = cx.createLinearGradient(0, H - band, 0, H);
    g.addColorStop(0, 'rgba(6,20,26,0)');
    g.addColorStop(0.45, 'rgba(6,20,26,0.88)');
    g.addColorStop(1, 'rgba(6,20,26,0.97)');
    cx.save();
    cx.fillStyle = g;
    cx.fillRect(0, H - band, W, band);
    cx.restore();
}

// A slim track on the right plus a "more below" cue, so the affordance is
// visible without a scrollbar the platform would otherwise draw for us.
function drawResultScrollIndicator(cx, W, H, overflow) {
    var trackX = W - 7;
    var trackTop = 12;
    var trackH = H - 24;
    var frac = H / (H + overflow);
    var thumbH = Math.max(28, trackH * frac);
    var thumbY = trackTop + (trackH - thumbH) * (resultScrollY / overflow);

    cx.save();
    cx.fillStyle = 'rgba(150,180,200,0.13)';
    cx.beginPath();
    cx.roundRect(trackX, trackTop, 4, trackH, 2);
    cx.fill();
    cx.fillStyle = 'rgba(120,220,255,0.5)';
    cx.beginPath();
    cx.roundRect(trackX, thumbY, 4, thumbH, 2);
    cx.fill();

    // Chevron only while there is still something below. The fade behind it is
    // drawn by drawResultFooterScrim() so the two do not stack.
    if (resultScrollY < overflow - 1) {
        cx.strokeStyle = 'rgba(160,220,240,0.75)';
        cx.lineWidth = 2;
        cx.beginPath();
        cx.moveTo(W / 2 - 8, H - 20);
        cx.lineTo(W / 2, H - 13);
        cx.lineTo(W / 2 + 8, H - 20);
        cx.stroke();
    }
    cx.restore();
}

function drawPostDive() {
    var cx = ctx;
    var W = cssWidth;
    var H = cssHeight;
    var DCF = "'Barlow Semi Condensed', monospace";

    // Backdrop is painted before the scroll translate so it stays put.
    gsBackdrop(cx, W, H);
    beginResultScroll(cx);

    var centerX = W / 2;
    var y = H * 0.07;

    cx.textAlign = 'center';
    cx.font = 'bold 12px monospace';
    cx.fillStyle = '#34e6ff';
    cx.fillText('DIVE LOG', centerX, y);
    // 38px type with an alphabetic baseline reaches ~30px above it, so a 30px
    // step put "DIVE COMPLETE" back through the kicker. Clear the ascender.
    y += 38;
    cx.font = 'bold 38px ' + DCF;
    cx.fillStyle = hudColor('ok');
    drawFittedText(cx, S('diveComplete'), centerX, y, W - 24);
    y += 30;

    // Stats card: Dive Time / Max / Avg
    var avgD = avgDepthSamples > 0 ? (avgDepthAccum / avgDepthSamples).toFixed(1) : '0.0';
    var cardW = Math.min(560, W - 80);
    var cardX = centerX - cardW / 2;
    var cardH = 84;
    gsPanel(cx, cardX, y, cardW, cardH, 16);
    var statCells = [
        [S('diveTimeLbl'), formatTime(diveTime)],
        [S('maxDepthLbl'), maxDepth.toFixed(1) + 'm'],
        [S('avgDepthLbl'), avgD + 'm']
    ];
    for (var sc = 0; sc < 3; sc++) {
        var sccx = cardX + cardW * (sc + 0.5) / 3;
        if (sc > 0) {
            cx.strokeStyle = 'rgba(130,160,180,0.16)';
            cx.lineWidth = 1;
            cx.beginPath();
            cx.moveTo(cardX + cardW * sc / 3, y + 16);
            cx.lineTo(cardX + cardW * sc / 3, y + cardH - 16);
            cx.stroke();
        }
        // Fit to the cell. cardW is min(560, W-80), so at 320 px wide each of
        // the three cells is only 80 px — "1840:00" at 30px Barlow is wider
        // than that, and the three values ran into each other. The maxWidth
        // argument condenses instead of overlapping.
        var cellInnerW = cardW / 3 - 10;
        cx.textAlign = 'center';
        cx.font = '11px monospace';
        cx.fillStyle = '#8694a1';
        cx.fillText(String(statCells[sc][0]).toUpperCase(), sccx, y + 31, cellInnerW);
        cx.font = 'bold 30px ' + DCF;
        cx.fillStyle = '#eaf2ff';
        cx.fillText(statCells[sc][1], sccx, y + 63, cellInnerW);
    }
    y += cardH + 20;

    // Issue #44: Debriefing card — graded scoring with 5 sub-scores + stars.
    // Same gsPanel() style as the stats card. Only shown for successful
    // surfaces (drawPostDive is the successful-surface renderer; game-over
    // uses drawGameOver()). gradeDive() lives in physics.js.
    var grade = gradeDive();
    var dbH = 218;
    gsPanel(cx, cardX, y, cardW, dbH, 16);
    // Title
    cx.textAlign = 'left';
    cx.font = 'bold 12px monospace';
    cx.fillStyle = '#8694a1';
    cx.fillText(S('debriefTitle'), cardX + 16, y + 22);
    // Stars + overall score, right-aligned
    var stars = grade.stars;
    cx.textAlign = 'right';
    cx.font = 'bold 22px ' + DCF;
    // Use precomposed '★' + '☆' padding so both filled + empty positions
    // render at the same width (unicode monospace-in-'monospace' still
    // varies slightly, but a 3-char run keeps the visual weight consistent).
    var starStr = '';
    for (var st = 0; st < 3; st++) starStr += (st < stars ? '★' : '☆');
    cx.fillStyle = stars >= 2 ? '#ffd24d' : (stars >= 1 ? '#a8b6cc' : '#6b7a8d');
    cx.fillText(starStr, cardX + cardW - 66, y + 24);
    cx.font = 'bold 16px monospace';
    cx.fillStyle = '#eaf2ff';
    cx.fillText(String(grade.overall), cardX + cardW - 16, y + 24);
    // Rows — 5 sub-scores. Each row: label (left), bar + score (right).
    var rowY = y + 48;
    var rowH = 33;
    for (var gi = 0; gi < grade.subs.length; gi++) {
        var sub = grade.subs[gi];
        // Issue #39 (review follow-up): route through hudColor() instead of
        // hardcoded literals so the debrief sub-scores react to the CVD palette.
        var scoreCol = sub.score >= 75 ? hudColor('ok') : (sub.score >= 50 ? hudColor('caution') : hudColor('danger'));
        // Label
        cx.textAlign = 'left';
        cx.font = 'bold 12px monospace';
        cx.fillStyle = '#eaf2ff';
        cx.fillText(sub.label, cardX + 16, rowY);
        // Score bar
        var barX = cardX + 190;
        var barTotalW = cardW - 190 - 60;
        var barHpx = 6;
        cx.fillStyle = 'rgba(130,160,180,0.16)';
        cx.fillRect(barX, rowY - 6, barTotalW, barHpx);
        cx.fillStyle = scoreCol;
        cx.fillRect(barX, rowY - 6, barTotalW * (sub.score / 100), barHpx);
        // Numeric score
        cx.textAlign = 'right';
        cx.font = 'bold 12px monospace';
        cx.fillStyle = scoreCol;
        cx.fillText(String(sub.score), cardX + cardW - 16, rowY);
        // One-line hint (ellipsised if too wide for the card)
        cx.textAlign = 'left';
        cx.font = '10px monospace';
        cx.fillStyle = '#8694a1';
        var noteText = sub.note;
        var maxNoteW = cardW - 32;
        if (cx.measureText(noteText).width > maxNoteW) {
            while (noteText.length > 4 && cx.measureText(noteText + '…').width > maxNoteW) {
                noteText = noteText.slice(0, -1);
            }
            noteText = noteText + '…';
        }
        cx.fillText(noteText, cardX + 16, rowY + 14);
        rowY += rowH;
    }
    y += dbH + 18;

    cx.textAlign = 'center';
    cx.font = '15px monospace';
    cx.fillStyle = '#a8b6cc';

    // Gas usage — BUG-24: CCR doesn't breathe from tanks[], so show the
    // O2/diluent cylinders and scrubber instead of the untouched OC tank
    // that's just leftover state from a previous mode.
    if (diveMode === 'ccr') {
        var o2Used = (ccrState.o2CylPressureStart - ccrState.o2CylPressure) * ccrState.o2CylVolume;
        var dilUsed = (ccrState.dilCylPressureStart - ccrState.dilCylPressure) * ccrState.dilCylVolume;
        var scrubUsed = ccrState.scrubberTotal - ccrState.scrubberRemaining;
        drawFittedText(cx, S('ccrO2Cyl') + ': ' + o2Used.toFixed(0) + 'L ' + S('gasUsed') + ' / ' + ccrState.o2CylPressure.toFixed(0) + ' ' + S('barLeft'), centerX, y, W - 32);
        y += 24;
        drawFittedText(cx, S('ccrDilCyl') + ': ' + dilUsed.toFixed(0) + 'L ' + S('gasUsed') + ' / ' + ccrState.dilCylPressure.toFixed(0) + ' ' + S('barLeft'), centerX, y, W - 32);
        y += 24;
        drawFittedText(cx, S('ccrScrubber') + ': ' + scrubUsed.toFixed(0) + ' min ' + S('gasUsed'), centerX, y, W - 32);
        y += 24;
        if (ccrState.onBailout) {
            cx.fillStyle = hudColor('caution');
            drawFittedText(cx, S('ccrBailout'), centerX, y, W - 32);
            cx.fillStyle = '#a8b6cc';
            y += 24;
        }
    } else {
        for (var ti = 0; ti < tankCount; ti++) {
            var tk = tanks[ti];
            var used = tk.totalGas - tk.gasRemaining;
            drawFittedText(cx, 'Tank ' + (ti + 1) + ' (' + tk.label + '): ' + used.toFixed(0) + 'L ' + S('gasUsed') + ' / ' + tk.totalGas + 'L', centerX, y, W - 32);
            y += 24;
        }
    }
    y += 15;

    // Safety stop skipped warning
    if (safetyStopNeeded && !safetyStopComplete) {
        cx.font = 'bold 16px monospace';
        cx.fillStyle = hudColor('caution');
        drawFittedText(cx, S('safetySkipped'), centerX, y, W - 24);
        y += 22;
        cx.font = '12px monospace';
        cx.fillStyle = '#8694a1';
        // S('safetyExpl') is authored as fixed-length lines wrapped for a
        // desktop width — they measure 383-416 px and bled off both edges of a
        // 320 px screen. Re-wrap to the card instead of trusting the authored
        // line breaks.
        y = drawWrappedText(cx, S('safetyExpl').join(' '), centerX, y, cardW, 16);
        y += 24;
    }

    // WP-034: Dive Profile Chart (same width as tissue bars)
    var barW = 16;
    var barMaxH = 100;
    var totalBarW = 16 * (barW + 4);
    var profileW = totalBarW;
    drawDiveProfileChart(cx, centerX - profileW / 2, y, profileW, H * 0.25);
    y += H * 0.25 + 20;

    // Tissue loading bar graph — N2 + He
    cx.font = 'bold 14px monospace';
    cx.fillStyle = '#8694a1';
    drawFittedText(cx, S('tissueLoading'), centerX, y, W - 24);
    y += 20;

    var startX = centerX - totalBarW / 2;

    for (var i = 0; i < 16; i++) {
        var bx = startX + i * (barW + 4);
        var ab = combinedAB(i);
        var m0 = ab.a + 1.0 / ab.b;
        var totalLoad = tissues[i] + tissuesHe[i];
        var loading = totalLoad / m0;
        var h = Math.min(barMaxH, loading * barMaxH);

        var n2Frac = totalLoad > 0.0001 ? tissues[i] / totalLoad : 1;
        var heFrac = 1 - n2Frac;
        var n2H = h * n2Frac;
        var heH = h * heFrac;

        // Background
        cx.fillStyle = 'rgba(130,160,180,0.14)';
        cx.fillRect(bx, y, barW, barMaxH);

        // N2 fill — issue #39 via hudColor().
        var color = hudColor('ok');
        if (loading > 0.9) color = hudColor('danger');
        else if (loading > 0.7) color = hudColor('caution');
        cx.fillStyle = color;
        cx.fillRect(bx, y + barMaxH - n2H, barW, n2H);

        // He fill
        if (heH > 0.5) {
            cx.fillStyle = '#34e6ff';
            cx.fillRect(bx, y + barMaxH - n2H - heH, barW, heH);
        }

        // M-value line
        cx.strokeStyle = 'rgba(255,75,75,0.65)';
        cx.lineWidth = 1;
        cx.beginPath();
        cx.moveTo(bx, y);
        cx.lineTo(bx + barW, y);
        cx.stroke();

        cx.font = '8px monospace';
        cx.fillStyle = '#5b6773';
        cx.textAlign = 'center';
        cx.fillText(String(i + 1), bx + barW / 2, y + barMaxH + 12);
    }

    // Legend
    y += barMaxH + 25;
    cx.font = '10px monospace';
    cx.textAlign = 'center';
    cx.fillStyle = hudColor('ok');
    cx.fillText('\u25A0', centerX - 40, y);
    cx.fillStyle = '#8694a1';
    cx.fillText('N\u2082', centerX - 28, y);
    cx.fillStyle = '#34e6ff';
    cx.fillText('\u25A0', centerX + 10, y);
    cx.fillStyle = '#8694a1';
    cx.fillText('He', centerX + 22, y);

    y += 30;
    if (!isTouchDevice) {
        cx.textAlign = 'center';
        cx.font = 'bold 13px monospace';
        var pTxt = S('diveAgain');
        var pW = cx.measureText(pTxt).width + 36;
        cx.beginPath();
        cx.roundRect(centerX - pW / 2, y - 16, pW, 30, 8);
        cx.fillStyle = 'rgba(70,240,143,0.12)';
        cx.fill();
        cx.strokeStyle = 'rgba(70,240,143,0.5)';
        cx.lineWidth = 1;
        cx.stroke();
        cx.fillStyle = '#7df0b0';
        drawFittedText(cx, pTxt, centerX, y + 4, W - 32);
        y += 14;
    }

    endResultScroll(cx, y, W, H);
    cx.textAlign = 'left';
}

// SECTION: Game over screen
// SEARCH TERMS: drawGameOver, gameOverReason, cause of death

// ============================================================
//  GAME OVER SCREEN
// ============================================================

// Issue #120: the result screens lay out in absolute pixels, so any string
// wider than the canvas ran off both edges with no way to reach it — scrolling
// recovers height, not width. Single-line headings and stat lines cannot be
// wrapped without breaking the layout around them, so shrink to fit instead.
//
// Shrinks the current font down to 60% (never below 9px), then hands whatever
// is still too wide to the canvas `maxWidth` squeeze, so the string can never
// overhang however long a translation turns out to be. The caller's font is
// restored, so this is a drop-in for `cx.fillText(t, x, y)`.
//
// Worst case measured at 320px: "PULMONARY BAROTRAUMA — PNEUMOTHORAX" spanned
// x=-61.7…381.7 against a 320px canvas.
function drawFittedText(cx, text, x, y, maxWidth) {
    var str = String(text);
    var originalFont = cx.font;
    var parts = /^(.*?)(\d+(?:\.\d+)?)px(.*)$/.exec(originalFont);
    if (parts && cx.measureText(str).width > maxWidth) {
        var px = parseFloat(parts[2]);
        var floor = Math.max(9, px * 0.6);
        while (px > floor) {
            px -= 1;
            cx.font = parts[1] + px + 'px' + parts[3];
            if (cx.measureText(str).width <= maxWidth) break;
        }
    }
    cx.fillText(str, x, y, maxWidth);
    cx.font = originalFont;
}

function drawWrappedText(cx, text, x, y, maxWidth, lineHeight, measureOnly) {
    var words = text.split(' ');
    var line = '';
    for (var i = 0; i < words.length; i++) {
        var test = line + words[i] + ' ';
        if (cx.measureText(test).width > maxWidth && line.length > 0) {
            if (!measureOnly) cx.fillText(line.trim(), x, y);
            y += lineHeight;
            line = words[i] + ' ';
        } else {
            line = test;
        }
    }
    if (line.trim().length > 0) {
        if (!measureOnly) cx.fillText(line.trim(), x, y);
        y += lineHeight;
    }
    return y;
}

function drawGameOver() {
    var cx = ctx;
    var W = cssWidth;
    var H = cssHeight;

    var DCF = "'Barlow Semi Condensed', monospace";
    var g = cx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#1a0c0e');
    g.addColorStop(0.6, '#0a0608');
    g.addColorStop(1, '#070405');
    cx.fillStyle = g;
    cx.fillRect(0, 0, W, H);
    var rg = cx.createRadialGradient(W / 2, -H * 0.1, 40, W / 2, H * 0.18, H * 0.7);
    rg.addColorStop(0, 'rgba(200,50,50,0.16)');
    rg.addColorStop(1, 'rgba(200,50,50,0)');
    cx.fillStyle = rg;
    cx.fillRect(0, 0, W, H);
    // Backdrop first, then scroll the body (issue #120). Every gameOverReason
    // overflows 320x568 — narcosis by 438 px — and none of it was reachable.
    beginResultScroll(cx);

    var margin = 40;
    var maxTextW = Math.min(700, W - margin * 2);
    var centerX = W / 2;
    var y = H * 0.07;

    cx.textAlign = 'center';

    // Header
    cx.font = 'bold 12px monospace';
    cx.fillStyle = '#8694a1';
    cx.fillText('— DIVE TERMINATED —', centerX, y);
    // 46px type reaches ~37px above its baseline, so a 30px step drew "GAME
    // OVER" straight through the kicker above it (125x9 px of overlap).
    y += 46;
    cx.font = 'bold 46px ' + DCF;
    cx.fillStyle = hudColor('danger');
    drawFittedText(cx, S('gameOver'), centerX, y, W - 24);
    y += 40;

    // Failure reason
    cx.font = 'bold 24px ' + DCF;
    cx.fillStyle = '#ffb060';
    drawFittedText(cx, S('gameOverReasons')[gameOverReason] || gameOverReason, centerX, y, W - 24);
    y += 35;

    cx.textAlign = 'left';
    var textX = centerX - maxTextW / 2;

    var info = S('gameOverInfo')[gameOverReason];
    if (info) {
        // WHAT HAPPENED
        cx.font = 'bold 14px monospace';
        cx.fillStyle = '#fff';
        cx.fillText(S('whatHappened'), textX, y);
        y += 18;
        cx.font = '12px monospace';
        cx.fillStyle = '#aab6c1';
        y = drawWrappedText(cx, info.cause, textX, y, maxTextW, 15);
        y += 12;

        // MEDICAL
        cx.font = 'bold 14px monospace';
        cx.fillStyle = '#ff8a8a';
        cx.fillText(S('medicalLabel'), textX, y);
        y += 18;
        cx.font = '12px monospace';
        cx.fillStyle = '#9aa7b3';
        y = drawWrappedText(cx, info.medical, textX, y, maxTextW, 15);
        y += 12;

        // HOW TO AVOID
        cx.font = 'bold 14px monospace';
        cx.fillStyle = hudColor('ok');
        cx.fillText(S('howToAvoid'), textX, y);
        y += 20;
        cx.font = '12px monospace';
        cx.fillStyle = '#9fd8ff';
        for (var i = 0; i < info.prevention.length; i++) {
            var tipText = (i + 1) + '. ' + info.prevention[i];
            y = drawWrappedText(cx, tipText, textX + 10, y, maxTextW - 10, 15);
            y += 4;
        }
        y += 10;
    }

    // Overhead-environment warning — only when the fatal dive was inside a
    // wreck or cave (both flagged hasOverhead). Drawn as a bordered amber box
    // so it reads as a distinct safety callout, not just another tip.
    var ovSite = activeSite();
    if (ovSite && ovSite.hasOverhead) {
        cx.textAlign = 'left';
        var boxX = textX - 12, boxW = maxTextW + 24, boxTop = y - 4;
        // Measure wrapped body height first (measure-only, no draw) so the box
        // can be sized and painted BEFORE the text goes on top of it.
        cx.font = '12px monospace';
        var bodyY = drawWrappedText(cx, S('overheadDanger'), textX, y + 32, maxTextW, 15, true);
        var boxH = (bodyY - boxTop) + 8;
        cx.fillStyle = 'rgba(255,160,40,0.08)';
        cx.strokeStyle = 'rgba(255,160,40,0.55)';
        cx.lineWidth = 1;
        cx.beginPath(); cx.roundRect(boxX, boxTop, boxW, boxH, 8); cx.fill(); cx.stroke();
        // ⚠ title
        cx.font = 'bold 14px monospace';
        cx.fillStyle = '#ffb84d';
        cx.fillText('⚠ ' + S('overheadDangerTitle'), textX, y + 14);
        // body (re-draw over the box)
        cx.font = '12px monospace';
        cx.fillStyle = '#ffd9a0';
        y = drawWrappedText(cx, S('overheadDanger'), textX, y + 32, maxTextW, 15);
        y += 22;
    }

    // Dive stats
    cx.font = '14px monospace';
    cx.fillStyle = '#8694a1';
    cx.textAlign = 'center';
    drawFittedText(cx, S('diveTimeLbl') + ': ' + formatTime(diveTime) + '    ' + S('maxDepthLbl') + ': ' + maxDepth.toFixed(1) + 'm', centerX, y, W - 32);
    y += 35;

    if (!isTouchDevice) {
        cx.textAlign = 'center';
        cx.font = 'bold 13px monospace';
        var gTxt = S('tryAgain');
        var gW = cx.measureText(gTxt).width + 36;
        cx.beginPath();
        cx.roundRect(centerX - gW / 2, y - 16, gW, 30, 8);
        cx.fillStyle = 'rgba(255,75,75,0.12)';
        cx.fill();
        cx.strokeStyle = 'rgba(255,75,75,0.5)';
        cx.lineWidth = 1;
        cx.stroke();
        cx.fillStyle = '#ff9a9a';
        drawFittedText(cx, gTxt, centerX, y + 4, W - 32);
        y += 14;
    }

    endResultScroll(cx, y, W, H);
    cx.textAlign = 'left';
}

// SECTION: Issue #45 — Scenario-drill overlays (decision + debrief + flicker)
// SEARCH TERMS: drawDrillOverlay, drawDrillDebrief, drawDrillFlicker, drillState

// Shared: return the currently-visible option list for a drill (filters
// out multi-tank-only options if tankCount === 1). Duplicates the logic
// from game-loop.js's _visibleDrillOptions() so the renderer does not
// depend on a helper the classic-script load order might not have wired
// yet at first paint.
function _drillVisibleOptions(drill) {
    var out = [];
    for (var i = 0; i < drill.options.length; i++) {
        var o = drill.options[i];
        if (o.requiresMultiTank && tankCount <= 1) continue;
        out.push(o);
    }
    return out;
}

function _drillById(id) {
    if (!id || typeof DRILLS === 'undefined') return null;
    for (var i = 0; i < DRILLS.length; i++) if (DRILLS[i].id === id) return DRILLS[i];
    return null;
}

// Decision overlay — styled as an amber-bordered card that occupies the
// centre of the screen. Option rows are recorded in drillState.optionRects
// (CSS-pixel bounds) so touch.js can hit-test taps against the same coords
// the diver sees. Kept visually distinct from drawGameOver() (which uses a
// red palette) to avoid confusion — a drill is a training pause, not a
// fatal outcome.
function drawDrillOverlay() {
    if (!drillState || drillState.phase !== 'overlay') return;
    var drill = _drillById(drillState.id);
    if (!drill) return;
    var strs = S('drills')[drill.stringsKey];
    if (!strs) return;
    var options = _drillVisibleOptions(drill);

    var cx = ctx;
    var W = cssWidth, H = cssHeight;
    var DCF = "'Barlow Semi Condensed', monospace";

    // Dim the frozen scene behind the card so text stays readable.
    cx.fillStyle = 'rgba(6,10,16,0.72)';
    cx.fillRect(0, 0, W, H);

    var panelW = Math.min(640, W - 48);
    var panelH = Math.min(H - 60, 320 + options.length * 44);
    var panelX = (W - panelW) / 2;
    var panelY = (H - panelH) / 2;

    // Amber card
    cx.fillStyle = 'rgba(30,20,10,0.94)';
    cx.strokeStyle = 'rgba(255,180,80,0.85)';
    cx.lineWidth = 2;
    cx.beginPath();
    cx.roundRect(panelX, panelY, panelW, panelH, 12);
    cx.fill();
    cx.stroke();

    var y = panelY + 22;
    cx.textAlign = 'center';

    // Header + title
    cx.font = 'bold 11px monospace';
    cx.fillStyle = '#ffb84d';
    cx.fillText('⚠ ' + S('drillHeader'), W / 2, y);
    y += 22;
    cx.font = 'bold 26px ' + DCF;
    cx.fillStyle = '#ffd9a0';
    cx.fillText(strs.title, W / 2, y);
    y += 24;

    // Situation text (wrapped)
    cx.textAlign = 'left';
    var textX = panelX + 24;
    var textMaxW = panelW - 48;
    cx.font = '14px monospace';
    cx.fillStyle = '#f0e6d6';
    y = drawWrappedText(cx, strs.text, textX, y + 12, textMaxW, 18);
    y += 18;

    // Options — record CSS-pixel bounds for touch hit-testing.
    drillState.optionRects = [];
    for (var i = 0; i < options.length; i++) {
        var label = (i + 1) + '. ' + strs.options[i];
        var rowH = 40;
        var rowX = textX;
        var rowY = y;
        var rowW = textMaxW;
        cx.fillStyle = 'rgba(60,45,25,0.7)';
        cx.strokeStyle = 'rgba(255,180,80,0.55)';
        cx.lineWidth = 1;
        cx.beginPath();
        cx.roundRect(rowX, rowY, rowW, rowH, 6);
        cx.fill();
        cx.stroke();
        cx.font = 'bold 14px monospace';
        cx.fillStyle = '#ffe4b8';
        cx.fillText(label, rowX + 14, rowY + 26);
        drillState.optionRects.push({ x: rowX, y: rowY, w: rowW, h: rowH, index: i });
        y += rowH + 8;
    }

    // Footer prompt
    cx.textAlign = 'center';
    cx.font = '12px monospace';
    cx.fillStyle = 'rgba(255,220,180,0.55)';
    cx.fillText(S('drillPromptFooter'), W / 2, panelY + panelH - 14);
    cx.textAlign = 'left';
}

// Debrief card — green-bordered card summarising the choice + WHY +
// REAL-WORLD context. Auto-dismisses after DRILL_DEBRIEF_DURATION_SEC or
// on Enter. Same visual language as drawGameOver()'s "HOW TO AVOID" pass
// so returning divers recognise the shape.
function drawDrillDebrief() {
    if (!drillState || drillState.phase !== 'debrief') return;
    var drill = _drillById(drillState.id);
    if (!drill) return;
    var strs = S('drills')[drill.stringsKey];
    if (!strs) return;

    var cx = ctx;
    var W = cssWidth, H = cssHeight;
    var DCF = "'Barlow Semi Condensed', monospace";

    cx.fillStyle = 'rgba(6,10,16,0.75)';
    cx.fillRect(0, 0, W, H);

    var panelW = Math.min(640, W - 48);
    var panelH = Math.min(H - 60, 340);
    var panelX = (W - panelW) / 2;
    var panelY = (H - panelH) / 2;
    var ok = drillState.correct;
    var borderCol = ok ? 'rgba(70,240,143,0.85)' : 'rgba(255,140,80,0.85)';
    var bg = ok ? 'rgba(12,26,18,0.94)' : 'rgba(30,20,12,0.94)';

    cx.fillStyle = bg;
    cx.strokeStyle = borderCol;
    cx.lineWidth = 2;
    cx.beginPath();
    cx.roundRect(panelX, panelY, panelW, panelH, 12);
    cx.fill();
    cx.stroke();

    var y = panelY + 22;
    cx.textAlign = 'center';
    cx.font = 'bold 11px monospace';
    cx.fillStyle = ok ? '#46f08f' : '#ffb060';
    cx.fillText(S('drillDebriefHeader') + ' — ' + strs.title, W / 2, y);
    y += 22;
    cx.font = 'bold 20px ' + DCF;
    cx.fillStyle = ok ? '#a6f9c8' : '#ffcda0';
    cx.fillText(ok ? S('drillDebriefCorrect') : S('drillDebriefWrong'), W / 2, y);
    y += 24;

    cx.textAlign = 'left';
    var textX = panelX + 24;
    var textMaxW = panelW - 48;

    cx.font = 'bold 12px monospace';
    cx.fillStyle = '#fff';
    cx.fillText(S('drillDebriefWhyLabel'), textX, y);
    y += 16;
    cx.font = '12px monospace';
    cx.fillStyle = ok ? '#c9e8d4' : '#e8d1b8';
    y = drawWrappedText(cx, strs.why, textX, y, textMaxW, 15);
    y += 12;

    cx.font = 'bold 12px monospace';
    cx.fillStyle = '#67d4ff';
    cx.fillText(S('drillDebriefRealLabel'), textX, y);
    y += 16;
    cx.font = '12px monospace';
    cx.fillStyle = '#9fd8ff';
    y = drawWrappedText(cx, strs.realWorld, textX, y, textMaxW, 15);

    cx.textAlign = 'center';
    cx.font = '11px monospace';
    cx.fillStyle = 'rgba(200,220,240,0.55)';
    cx.fillText(S('drillDebriefDismiss'), W / 2, panelY + panelH - 14);
    cx.textAlign = 'left';
}

// Torch flicker overlay — only relevant during the lightFailure drill's
// 2-second flicker phase (gameState still 'diving', physics ticking). A
// simple sin-based alpha modulation painted over the whole scene reads as
// a failing torch without requiring changes to drawSiltAndTorch()'s
// existing torch pipeline.
function drawDrillFlicker() {
    if (!drillState || drillState.phase !== 'flicker') return;
    if (drillState.id !== 'lightFailure') return;
    var cx = ctx;
    var t = (typeof performance !== 'undefined' && performance.now)
        ? performance.now() / 1000
        : Date.now() / 1000;
    // High-frequency flicker: three overlaid sines to avoid a mechanical
    // beat pattern. Alpha stays in [0, 0.6] so the scene is never fully
    // black — the diver still needs to perceive that the light is failing.
    var a = 0.32 + 0.22 * Math.sin(t * 24) + 0.10 * Math.sin(t * 60 + 1.3) + 0.08 * Math.sin(t * 11 + 0.7);
    if (a < 0) a = 0;
    if (a > 0.65) a = 0.65;
    cx.fillStyle = 'rgba(0,0,0,' + a.toFixed(3) + ')';
    cx.fillRect(0, 0, cssWidth, cssHeight);
}

// SECTION: Surface / pre-dive screen
// SEARCH TERMS: drawSurface, surface state

// ============================================================
//  SURFACE SCREEN
// ============================================================

function drawSurface() {
    drawScene();
    drawDiveComputer();

    var cx2 = ctx;
    if (!isTouchDevice) {
        cx2.textAlign = 'center';
        cx2.font = 'bold 20px monospace';
        cx2.fillStyle = 'rgba(255,255,255,0.8)';
        cx2.fillText(S('surfaceDescend'), cssWidth / 2, cssHeight * 0.75);
        cx2.font = '14px monospace';
        cx2.fillStyle = 'rgba(255,255,255,0.5)';
        var tLabel = getActiveTank().label;
        var hintParts = tLabel + ' ' + S('surfaceLoaded') + '  |  ' + S('surfaceHints') + '  |  1-' + tankCount + ' ' + S('surfaceTankHint') + '  |  ' + S('surfaceHelp');
        if (isAdvanced()) hintParts += '  |  ' + S('surfaceGasInfo');
        cx2.fillText(hintParts, cssWidth / 2, cssHeight * 0.80);
    }
    cx2.font = '11px monospace';
    cx2.fillStyle = 'rgba(255,255,255,0.25)';
    cx2.fillText('build ' + (typeof BUILD_VERSION !== 'undefined' ? BUILD_VERSION : 'dev'), cssWidth / 2, cssHeight * 0.85);
    cx2.textAlign = 'left';
}
