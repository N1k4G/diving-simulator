// ============================================================
// FILE: state.js
// PURPOSE: Canvas/context setup, ALL mutable game-state variables,
//          mode and CCR configuration objects, tank helper functions,
//          and dive initialisation. Every global that other modules
//          read or write is declared here.
//
// DEPENDS ON: constants.js
//
// USED BY: physics.js, world.js, renderer.js, ui.js, game-loop.js, touch.js
//
// KEY SYMBOLS (grep to find):
//   canvas / ctx            — DOM canvas element and 2D context
//   gameState               — current phase: 'setup'|'surface'|'diving'|'gameover'|'postdive'
//   depth / maxDepth        — current and max depth in metres
//   tissues / tissuesHe     — Bühlmann N2/He compartment arrays [0..15]
//   tanks / activeTank      — multi-tank array and active tank index
//   tankCount               — number of tanks in use
//   diveMode                — 'rec' | 'tec' | 'ccr'
//   ccrState                — CCR rebreather state object (SP, O2 cyl, diluent, scrubber)
//   modeSettings            — per-mode saved configuration
//   diver                   — diver position/velocity object
//   keys                    — keyboard state map (key → boolean)
//   resetDive()             — reset all dive state to initial values
//   initCCR()               — (re)initialise CCR state object
//   initTissues()           — zero all Bühlmann compartments
//   initTanks()             — build tanks[] from current mode settings
//   createTank(o2,he,pres,vol) — tank factory function
//   gasLabel(tank)          — format gas mix as string e.g. "EAN32"
//   activeGas()             — return {o2,he} fractions for current tank/mode
// SECTION: Canvas setup and resize
// SEARCH TERMS: canvas, ctx, resize, width, height

// ============================================================
// ============================================================
//  CANVAS SETUP
// ============================================================

const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');

// WP-015: HiDPI canvas. The buffer is physical-pixel-sized (innerWidth * dpr)
// so text/lines are crisp on Retina and mobile displays. The 2D context is
// pre-scaled by dpr so ALL drawing code continues to work in CSS pixels.
// cssWidth / cssHeight expose the logical CSS-pixel size for layout math —
// every reader of canvas.width/height across the renderer/world/ui/game-loop
// has been switched to these.
let cssWidth = 0;
let cssHeight = 0;

function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DEVICE_PIXEL_RATIO);
    cssWidth = window.innerWidth;
    cssHeight = window.innerHeight;
    canvas.width = cssWidth * dpr;
    canvas.height = cssHeight * dpr;
    canvas.style.width = cssWidth + 'px';
    canvas.style.height = cssHeight + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resize);
resize();

// SECTION: Input / keyboard state
// SEARCH TERMS: keys, keydown, keyup, addEventListener

// ============================================================
//  INPUT
// ============================================================

const keys = {};
window.addEventListener('keydown', e => {
    keys[e.key.toLowerCase()] = true;
    keys[e.key] = true;
    // Prevent Tab from leaving the page
    if (e.key === 'Tab') e.preventDefault();
    if (e.key === 'h' || e.key === 'H' || e.key === '?') {
        if (gameState !== 'gas-setup') {
            showHelp = !showHelp;
            if (showHelp) showGasInfo = false;
        }
    }
    // WP-037 / BUG-CCR-3: Cycle info page mode. CCR mode has only one extra
    // page (5 = CCR detail), so it toggles 0 <-> 5. Tec keeps the existing
    // 0..4 cycle (with tanks-1 page skipped when only one tank).
    if ((e.key === 'i' || e.key === 'I') && gameState === 'diving' && (isAdvanced() || diveMode === 'ccr')) {
        if (diveMode === 'ccr') {
            infoPageMode = (infoPageMode === 5) ? 0 : 5;
        } else {
            infoPageMode++;
            if (infoPageMode === 2 && tankCount <= 3) infoPageMode++;
            if (infoPageMode > (tankCount > 3 ? 4 : 3)) infoPageMode = 0;
        }
    }
    if (e.key === 'Escape' && showHelp) {
        showHelp = false;
    }
    if (e.key === 'Escape' && infoPageMode > 0) {
        infoPageMode = 0;
    }
    // Issue #46: Instructor overlay toggle (L for "Learn"). Only reacts
    // in the diving state so the same key stays free in gas-setup / surface
    // / gameover / post-dive — mirrors the `I` info-page and `H` help
    // gates. The overlay itself hides when showHelp / infoPageMode > 0
    // regardless of this flag (space conflict), so no extra guard is
    // needed here for those overlays being open at press time.
    if ((e.key === 'l' || e.key === 'L') && gameState === 'diving') {
        instructorMode = !instructorMode;
    }
});
window.addEventListener('keyup', e => {
    // Issue #9: if Shift is released before the letter (e.g. Shift+G), the
    // keyup for the letter arrives with e.key === 'g' (lowercase) even
    // though keydown stored keys['G'] = true. Clear both case variants
    // (not just the two forms of whatever case e.key happens to be) so a
    // Shift-combo key can never get stuck true.
    keys[e.key.toLowerCase()] = false;
    keys[e.key.toUpperCase()] = false;
    keys[e.key] = false;
});

// SECTION: Mutable game-state variables
// SEARCH TERMS: gameState, depth, maxDepth, tissues, tanks, diveMode, ccrState, diver, verticalVelocity, bcdGasSurfaceLiters

// ============================================================
//  GAME STATE
// ============================================================

let gameState = 'gas-setup';

// TASK-017: Multi-tank state
let tanks = [];
let activeTank = 0;
let tankCount = 1;
let selectedTankTab = 0;

// BYP-029: Best gas available info tone
let bestGasAlerted = false;
var lastDecoStopDepth = 0;

// Diver state
let depth = 0;
let maxDepth = 0;
let avgDepthAccum = 0;
let avgDepthSamples = 0;
let diveTime = 0;
let ascentRate = 0;
let gameOverReason = '';

// Bühlmann tissues — 16 compartments
let tissues = [];
let tissuesHe = [];

// WP-038: CNS O2 toxicity tracking
let cnsPercent = 0;

// O2 toxicity
let po2ViolationTime = 0;

// DCS violation
let dcsViolationTime = 0;

// Safety stop
let safetyStopRemaining = 0;
let safetyStopNeeded = false;
let safetyStopComplete = false;

// WP-034: Dive profile recording
let diveProfile = [];
let _profileSampleTimer = 0;
let safetyStopCountdownStarted = false;
let safetyStopPaused = false;
let ndlDroppedBelow5 = false;

// Issue #44: Post-dive debriefing — event log + running minimum NDL.
// diveEvents entries are {t, kind, value}; kinds are 'fastAscent',
// 'ceilingViolation', 'safetyStopSkipped'. Debounced via _fastAscentAccum /
// _ceilingViolationAccum so a sustained violation records exactly one entry
// (accumulator is set to -Infinity after firing and cleared once the
// condition drops back below threshold — same debounce pattern used by
// po2ViolationTime / barotraumaTime).
let diveEvents = [];
let minNdlSeen = Infinity;
let _fastAscentAccum = 0;
let _fastAscentPeak = 0;
let _ceilingViolationAccum = 0;

// Bubbles
let bubbles = [];
var breathPhase = 'inhale';
var breathTimer = BREATH_CYCLE_INHALE;
var exhaleEmitted = false;

// Particles (plankton)
let particles = [];
const PARTICLE_COUNT = 150;

// Wave
let waveTime = 0;

// Timing
let lastFrameTime = 0;

// TASK-019: Gas switch notification
let gasSwitchNotifyTime = 0;
let gasSwitchNotifyText = '';

// Issue #38: Contextual onboarding hint toasts.
// One-time in-dive nudges triggered by state transitions (not timers). Each
// hint id is remembered in localStorage under HINT_STORAGE_PREFIX + id so it
// fires exactly once per browser. A single global HINT_DONE_KEY suppresses
// the whole system (the "don't show again" button on the help overlay).
// Rendering mirrors the gasSwitchNotify pattern at HINT_TOAST_Y_FRAC (below
// the gas-switch banner so both can be visible simultaneously). Queue depth
// is unbounded but only one hint is visible at a time; the queue drains one
// entry per HINT_DISPLAY_SEC seconds via the pump call in updateDiving().
const HINT_DISPLAY_SEC = 6;
const HINT_STORAGE_PREFIX = 'diveSim_hint_';
const HINT_DONE_KEY = 'diveSim_hintsDone';
const HINT_TOAST_Y_FRAC = 0.36; // gas-switch sits at 0.30 — hints go below it
// NDL threshold used by the "NDL dropping" trigger. Below 10 min the diver
// should already start planning; the hint fires at the first crossing.
const HINT_NDL_MIN = 10;
// Minimum depth for the BCD hint — avoids firing during the surface descent
// gate (where depth briefly ticks past 0 but the diver is not yet "in-dive").
const HINT_BCD_MIN_DEPTH = 2;
let hintNotifyTime = 0;
let hintNotifyText = '';
let hintQueue = [];
// Per-dive edge state so a trigger fires at most once per dive AND, once its
// localStorage flag is set, never again. Reset in resetDive() to re-detect
// edges cleanly on the next dive — the localStorage guard inside
// showHintOnce() still prevents any duplicate display.
let hintEdges = { bcd: false, ndl: false, safetyStop: false, deco: false, overhead: false, current: false };

// TASK-022: Fish system
let fishes = [];
let fishSpawnTimer = 0;
const MAX_FISH = 6;

let wildlife = [];
let wildlifeSpawnTimer = 0;
const MAX_WILDLIFE = 7;

// TASK-023: Variable rate state
let currentVerticalRate = 0;
let fastForwardActive = false;   // m/min, negative=ascending, positive=descending
let bcdGasSurfaceLiters = 0;
let verticalVelocity = 0;
let barotraumaTime = 0;        // tracks sustained >18m/min ascent in dive-seconds
let hypoxiaTime = 0;

// Phase A: Horizontal movement
let diverX = 0;              // world position in metres, 0 = entry point
let horizontalVelocity = 0;  // m/s, positive = right

// Phase C: Site state
let diveSite = 'open';       // 'open' | 'shore' | 'reef' | 'wreck' | 'cave' — set at setup, not reset mid-dive
let guidelineNodes = [];     // [{x, d}] breadcrumb trail, appended while inOverhead
let _guidelineTimer = 0;     // accumulates dive-seconds between samples
let visibility = 1.0;        // 1 = clear, 0 = full silt-out
let inOverhead = false;      // cached overheadAt(diverX, depth) for this tick
let badAirWarning = false;   // diver's head is in an unbreathable dome
// Issue #27: Rule-of-thirds gas planning (cave/wreck overhead only).
// thirdsStartingGas is snapshotted from the total across all tanks on
// first entry into the overhead and cleared when the diver leaves (so a
// second penetration re-snapshots against whatever gas remains at that
// point). The turn/reserve flags latch on threshold cross so the alert
// beep fires exactly once per overhead excursion.
let thirdsStartingGas = 0;                 // surface-litre reference "full" gas
let thirdsCurrentPhase = 'outbound';       // 'outbound' | 'turn' | 'reserve'
let thirdsPct = 100;                       // integer 0..100 for HUD data-pct
let thirdsTurnWarned = false;
let thirdsReserveActive = false;
// Issue #44/#27: thirdsReserveActive is a live HUD/excursion flag that
// clears the moment the diver leaves the overhead (see the "left overhead"
// branch below) — by the time gradeDive() runs post-dive, the diver has
// always long since surfaced, so that flag can never reflect what happened
// during the dive. This latch mirrors it but only ever resets on
// resetDive(), so gradeDive() can see whether reserve was hit at ANY point
// across ANY excursion this dive, not just the most recent one.
let thirdsReserveHitThisDive = false;
// D6: Player torch — ON by default for overhead sites, OFF in open water
let torchOn = false;

// Issue #53: opt-in visual-zone debug overlay. Default OFF — zero visual
// change in normal gameplay. When true, drawVisualZoneDebug() paints the
// current site's zone rectangles with a low-alpha overlay and prints the
// current zone id as a small HUD line.
let debugVisualZones = false;

// Issue #46: Instructor overlay ("Learn" mode). Toggled by the `L` key or
// the touch button while gameState === 'diving'. When true, drawScene()
// paints a narrow left-edge panel showing live physics values (ambient
// pressure, BCD Boyle expansion, bubble growth, leading tissue, gas
// consumption ∝ depth, MOD/END) with mini-formulas. Persists across dives
// intentionally — a user who wants it on for one dive almost always wants
// it on for the next. Never affected by resetDive().
let instructorMode = false;

// Issue #45: Scenario drills — opt-in scriptable emergency scenarios.
// drillsEnabled is the setup-time toggle; drillState is the mutable per-dive
// runtime object driven by game-loop.js's trigger/resolution helpers.
// resetDive() clears drillState and drillHasRunThisDive; drillsEnabled is a
// setup-screen choice that intentionally persists across dives (same rule as
// diveSite, currentLang).
//
// drillState.phase transitions:
//   'inactive' — no drill running (default between dives / after debrief).
//   'flicker'  — visual pre-roll for lightFailure (2 s of torch flicker,
//                gameState still 'diving'; physics continues so the visual
//                warning has real time to be perceived).
//   'overlay'  — decision overlay is up (gameState === 'drill'; physics
//                paused; keys 1/2/3 or tap on option row selects).
//   'debrief'  — 5-second debrief card, then auto-dismisses; Enter dismisses
//                immediately (gameState === 'drill' still, physics paused).
//   'effect'   — resolution effects that outlive the overlay (freeflow
//                multiplier, light dark period). gameState back to 'diving';
//                consumption code + renderer read the timers below.
//
// drillState fields set during a run:
//   id                          — drill catalog id (e.g. 'lightFailure')
//   startedAt                   — dive-time (min) when the drill started
//   flickerUntilReal            — real-time timestamp (Date.now/1000) when
//                                 the flicker phase ends and overlay opens
//   selectedOption              — index of the option the player picked
//   correct                     — whether that option was marked correct
//   debriefUntilReal            — real-time timestamp when the debrief card
//                                 auto-dismisses (also cleared by Enter)
//   freeflowUntilDiveSec        — dive-seconds timestamp when the free-flow
//                                 consumption multiplier expires
//   freeflowDrainTankIdx        — tank index whose regulator is free-flowing.
//                                 If === activeTank, the ×N multiplier is
//                                 applied to breathing consumption; if
//                                 different, that tank drains in parallel.
//   lightRestoreAt              — dive-seconds timestamp when the torch turns
//                                 back on (correct + wrong-option paths both
//                                 restore at DRILL_LIGHT_DARK_SEC).
//   optionRects                 — CSS-pixel bounding boxes of the on-canvas
//                                 option rows, populated by drawDrillOverlay()
//                                 each frame so touch.js can hit-test taps.
let drillsEnabled = false;
let drillHasRunThisDive = false;
let drillState = {
    phase: 'inactive',
    id: null,
    startedAt: 0,
    flickerUntilReal: 0,
    selectedOption: -1,
    correct: false,
    debriefUntilReal: 0,
    freeflowUntilDiveSec: 0,
    freeflowDrainTankIdx: -1,
    lightRestoreAt: 0,
    // Issue #45 (review follow-up): set by the freeflow drill's "hold
    // breath" wrong option — while > 0 and unexpired, any positive
    // ascent rate (not just a fast one) accumulates barotraumaTime.
    breathHoldUntilDiveSec: 0,
    optionRects: []
};

// Phase B: Current state
let current = {
  active: false,
  direction: 1,           // -1 = pushing left, +1 = pushing right
  strength: 0,            // target m/s
  level: 0,               // ramped 0..strength (actual contribution, smoothed)
  depthMin: 0, depthMax: 0,
  timer: 0,               // sim seconds remaining while active
  rolledThisDive: false   // ensures per-dive chance is evaluated once
};

// TASK-025: Help overlay
let showHelp = false;
// TASK-031D: Gas info overlay
var showGasInfo = false;
var _gasInfoShown = false;
var infoPageMode = 0; // 0=normal, 1=tanks 1-3, 2=tanks 4-6, 3=tissues, 4=deco metrics

// TASK-032E: CCR failure state timers
var ccrHypoxiaTime = 0;
var ccrHyperoxiaTime = 0;
var ccrWarningBeepTriggered = false;

// WP-029: Dive mode state ('rec' | 'tec' | 'ccr')
let diveMode = 'rec';
function isAdvanced() { return diveMode === 'tec'; }

// Per-mode settings storage
let modeSettings = { rec: null, tec: null, ccr: null };

// TASK-032A: CCR state
var CCR_DEFAULTS = {
  o2CylVolume: 2, o2CylPressure: 200, o2CylPressureStart: 200,
  dilCylVolume: 3, dilCylPressure: 200, dilCylPressureStart: 200,
  dilFO2: 0.21, dilFN2: 0.79, dilFHe: 0.00,
  loopVolume: 6.0,
  targetSP: 0.7,
  actualPO2: 0.21,
  scrubberTotal: 180, scrubberRemaining: 180,
  metabolicO2Rate: 0.8,
  po2ResponseRate: 0.05,
  onBailout: false,
  scrubberFailed: false,
  co2BuildupTime: 0
};

var ccrState = {};
function initCCR() {
  ccrState = JSON.parse(JSON.stringify(CCR_DEFAULTS));
}
initCCR();

var CCR_DIL_PRESETS = [
  { name: 'Air',       fO2: 0.21, fHe: 0.00 },
  { name: 'Tmx 21/35', fO2: 0.21, fHe: 0.35 },
  { name: 'Tmx 15/45', fO2: 0.15, fHe: 0.45 },
  { name: 'Tmx 10/70', fO2: 0.10, fHe: 0.70 },
  { name: 'Hx 10/90',  fO2: 0.10, fHe: 0.90 }
];

function ccrDilPresetName() {
  for (var i = 0; i < CCR_DIL_PRESETS.length; i++) {
    var p = CCR_DIL_PRESETS[i];
    if (Math.abs(ccrState.dilFO2 - p.fO2) < 0.005 && Math.abs(ccrState.dilFHe - p.fHe) < 0.005) return p.name;
  }
  return 'Custom';
}

function ccrApplyDilPreset(idx) {
  var p = CCR_DIL_PRESETS[idx];
  if (!p) return;
  ccrState.dilFO2 = p.fO2;
  ccrState.dilFHe = p.fHe;
  ccrState.dilFN2 = 1 - p.fO2 - p.fHe;
  _gsBuilt = false;
}

function ccrAdjustSP(delta) {
  ccrState.targetSP = Math.max(CCR_SP_MIN, Math.min(CCR_SP_MAX, +(ccrState.targetSP + delta).toFixed(1)));
  _gsBuilt = false;
}

function ccrAdjustDilVol(delta) {
  ccrState.dilCylVolume = Math.max(CCR_DIL_VOL_MIN, Math.min(CCR_DIL_VOL_MAX, ccrState.dilCylVolume + delta));
  _gsBuilt = false;
}

// BUG-CCR-4: Adjust the CCR O2 cylinder volume (clamped to CCR_O2_VOL_MIN..MAX).
function ccrAdjustO2Vol(delta) {
  ccrState.o2CylVolume = Math.max(CCR_O2_VOL_MIN, Math.min(CCR_O2_VOL_MAX, ccrState.o2CylVolume + delta));
  _gsBuilt = false;
}

// BUG-CCR-4: Adjust the CCR O2 cylinder pressure (clamped to CCR_O2_PRES_MIN..MAX).
function ccrAdjustO2Pres(delta) {
  ccrState.o2CylPressure = Math.max(CCR_O2_PRES_MIN, Math.min(CCR_O2_PRES_MAX, ccrState.o2CylPressure + delta));
  _gsBuilt = false;
}

function updateCCRLoop(dtSec, prevDepth) {
  if (ccrState.onBailout) return;
  var dtMin = dtSec / 60;

  // Metabolic O2 consumption (constant rate regardless of depth)
  var o2Used = ccrState.metabolicO2Rate * dtMin; // surface liters
  var o2AvailBefore = ccrState.o2CylPressure * ccrState.o2CylVolume; // total surface liters in O2 cyl
  if (o2Used > o2AvailBefore) o2Used = o2AvailBefore;
  ccrState.o2CylPressure -= o2Used / ccrState.o2CylVolume;
  if (ccrState.o2CylPressure < 0) ccrState.o2CylPressure = 0;

  // PO2 management
  var pAmb = ambientPressure(depth);

  // BUG-25: Depth-change compression/decompression. The loop is a closed
  // volume — as ambient pressure rises on descent, all partial pressures
  // in it (including O2) rise proportionally before the solenoid can react;
  // on ascent they fall the same way. Without this, actualPO2 could only
  // ever approach targetSP from below and could only drop via an empty O2
  // cylinder, making both hyperoxia (>1.6, descent spike) and hypoxia from
  // a fast ascent unreachable regardless of setpoint.
  //
  // Issue #25: on descent, updateCCRDiluent() (called earlier this same
  // tick, before updateCCRLoop) already applies the combined
  // compression-plus-topoff mass balance to actualPO2, including the
  // diluent's own O2 fraction — a plain p2/p1 multiply here on top of that
  // would double-apply the compression and drop the diluent's O2
  // contribution (see the comment there for the derivation). On
  // ascent/flat there is no diluent topoff (the ADV only fires on
  // descent), so the loop gas simply expands and vents through the OPV at
  // constant mole fraction — the plain ratio multiply is exact there.
  var pAmbPrev = ambientPressure(prevDepth === undefined ? depth : prevDepth);
  if (prevDepth === undefined || depth <= prevDepth) {
    ccrState.actualPO2 *= pAmb / pAmbPrev;
  }

  // If O2 cylinder has gas, solenoid injects to maintain setpoint. BUG-25:
  // the injected O2 must be deducted from the cylinder like any other
  // consumption — previously a setpoint increase was gas-balance-free.
  // Surface liters needed for a PO2 rise of `desiredRise` in a loop of
  // volume loopVolume is loopVolume * desiredRise, independent of depth
  // (the ambient-liter injection volume and the ambient->surface
  // conversion cancel out).
  var o2Available = ccrState.o2CylPressure * ccrState.o2CylVolume; // surface liters remaining after metabolic draw
  if (o2Available > 0 && ccrState.actualPO2 < ccrState.targetSP) {
    var maxRise = ccrState.po2ResponseRate * dtSec;
    var deficit = ccrState.targetSP - ccrState.actualPO2;
    var desiredRise = Math.min(maxRise, deficit);
    var o2Cost = ccrState.loopVolume * desiredRise;
    var actualRise = desiredRise;
    if (o2Cost > o2Available) {
      // Not enough O2 to fully correct — apply only what's affordable.
      actualRise = o2Available / ccrState.loopVolume;
      o2Cost = o2Available;
    }
    ccrState.actualPO2 += actualRise;
    ccrState.o2CylPressure -= o2Cost / ccrState.o2CylVolume;
    if (ccrState.o2CylPressure < 0) ccrState.o2CylPressure = 0;
  } else if (ccrState.o2CylPressure <= 0) {
    // No O2 available — PO2 drops from metabolism
    var po2Drop = (ccrState.metabolicO2Rate / 60 * dtSec) / ccrState.loopVolume * pAmb;
    ccrState.actualPO2 -= po2Drop;
  }

  // Clamp PO2
  if (ccrState.actualPO2 < 0) ccrState.actualPO2 = 0;
  if (ccrState.actualPO2 > pAmb) ccrState.actualPO2 = pAmb; // can't exceed ambient

  // Scrubber countdown
  ccrState.scrubberRemaining -= dtMin;
  if (ccrState.scrubberRemaining < 0) ccrState.scrubberRemaining = 0;
}

function updateCCRDiluent(prevD, newD) {
  if (ccrState.onBailout) return;
  if (newD <= prevD) return; // only on descent
  var p1 = ambientPressure(prevD);
  var p2 = ambientPressure(newD);
  // BUG-8: to hold a constant loop volume of loopVolume ambient liters as
  // pressure rises from p1 to p2, the required top-off is
  // loopVolume * (p2 - p1) surface liters (Boyle's law: the ambient-liter
  // deficit loopVolume*(p2/p1-1) at p2, converted to surface-equivalent by
  // multiplying by p2, reduces to loopVolume*(p2-p1) once you cancel the
  // p2 factor — NOT loopVolume*(p2-p1)*p2/p1 as the old two-step calc
  // computed). The previous formula overestimated consumption by a
  // factor of p2/p1 (e.g. +50% for a 10m -> 20m descent).
  var dilSurfEquiv = ccrState.loopVolume * (p2 - p1);
  var dilAvailable = ccrState.dilCylPressure * ccrState.dilCylVolume;
  if (dilSurfEquiv > dilAvailable) dilSurfEquiv = dilAvailable;
  ccrState.dilCylPressure -= dilSurfEquiv / ccrState.dilCylVolume;
  if (ccrState.dilCylPressure < 0) ccrState.dilCylPressure = 0;

  // Issue #25: actualPO2 must reflect this same top-off, not just the
  // cylinder depletion above — otherwise the compression multiply in
  // updateCCRLoop() models the loop as sealed (no gas exchanged), which
  // both overstates the PO2 spike and ignores the diluent's own O2
  // fraction entirely. Combined mass balance: the O2 amount already in the
  // loop (actualPO2 * loopVolume, bar-liters) is conserved through
  // compression; the top-off adds dilSurfEquiv surface-liters of gas at
  // fO2 = dilFO2, i.e. dilFO2 * dilSurfEquiv bar-liters of O2 and
  // dilSurfEquiv bar-liters of total gas. Dividing new O2 amount by new
  // total-gas ambient-volume-at-p2 gives:
  //   newPO2 = p2 * (oldPO2*loopVolume + dilFO2*dilSurfEquiv)
  //            / (p1*loopVolume + dilSurfEquiv)
  // This reduces to oldPO2*p2/p1 (the old sealed-loop formula) when
  // dilSurfEquiv = 0 (cylinder empty — no top-off happened), and to
  // oldPO2 + dilFO2*(p2-p1) when the loop is fully topped off, matching
  // both known-correct limit cases.
  var oldPO2 = ccrState.actualPO2;
  ccrState.actualPO2 = p2 * (oldPO2 * ccrState.loopVolume + ccrState.dilFO2 * dilSurfEquiv) /
                        (p1 * ccrState.loopVolume + dilSurfEquiv);
}

function saveModeSettings() {
    modeSettings[diveMode] = {
        tanks: JSON.parse(JSON.stringify(tanks.slice(0, tankCount))),
        tankCount: tankCount,
        selectedTankTab: selectedTankTab,
        gfLow: gfLow,
        gfHigh: gfHigh,
        amvRate: amvRate,
        ccrState: JSON.parse(JSON.stringify(ccrState))
    };
}

function restoreModeSettings(mode) {
    var saved = modeSettings[mode];
    if (saved) {
        tanks = saved.tanks;
        tankCount = saved.tankCount;
        selectedTankTab = Math.min(saved.selectedTankTab, tankCount - 1);
        gfLow = saved.gfLow;
        gfHigh = saved.gfHigh;
        amvRate = saved.amvRate;
        if (saved.ccrState) ccrState = JSON.parse(JSON.stringify(saved.ccrState));
    }
}

function switchMode(newMode) {
    if (newMode === diveMode) return;
    saveModeSettings();
    diveMode = newMode;
    restoreModeSettings(newMode);
    // BUG-CCR-9: CCR has no concept of multiple OC tanks — normalise to a
    // single-tank state when entering CCR so stale tank UI/state can't leak
    // through from the previously-active mode. Leaving CCR is already handled
    // by restoreModeSettings for the destination mode.
    if (newMode === 'ccr') {
        tankCount = 1;
        selectedTankTab = 0;
        activeTank = 0;
    }
    _gsBuilt = false;
}

// TASK-042: Shark easter egg
let shark = null;
let sharkTimer = 60;

// WP-020: Narcosis state
let narcosisIndex = 0;
let narcosisKOTime = 0;
let narcDrift = 0;

// WP-017: Alert sound
var _alertCtx = null;
var _lastAlertTime = 0;
function playAlertBeep() {
    var now = Date.now();
    if (now - _lastAlertTime < 5000) return;
    _lastAlertTime = now;
    try {
        if (!_alertCtx) _alertCtx = new (window.AudioContext || window.webkitAudioContext)();
        var osc = _alertCtx.createOscillator();
        var gain = _alertCtx.createGain();
        osc.connect(gain);
        gain.connect(_alertCtx.destination);
        osc.type = 'square';
        osc.frequency.value = 800;
        gain.gain.value = 0.15;
        osc.start();
        gain.gain.exponentialRampToValueAtTime(0.001, _alertCtx.currentTime + 0.3);
        osc.stop(_alertCtx.currentTime + 0.3);
    } catch {}
    if (navigator.vibrate) {
        try { navigator.vibrate([100, 50, 100]); } catch {}
    }
}

// BYP-029: Info tone for better gas available
function playInfoTone() {
    try {
        if (!_alertCtx) _alertCtx = new (window.AudioContext || window.webkitAudioContext)();
        var osc = _alertCtx.createOscillator();
        var gain = _alertCtx.createGain();
        osc.connect(gain);
        gain.connect(_alertCtx.destination);
        osc.type = 'sine';
        osc.frequency.value = 600;
        gain.gain.value = 0.15;
        osc.start();
        gain.gain.exponentialRampToValueAtTime(0.001, _alertCtx.currentTime + 0.15);
        osc.stop(_alertCtx.currentTime + 0.15);
    } catch {}
}

// WP-017: Gas-setup direct state modification helpers
function gsAdjustO2(delta) {
    var t = tanks[selectedTankTab];
    if (delta < 0) t.fO2 = Math.max(0.0, t.fO2 + delta);
    else t.fO2 = Math.min(1.0 - t.fHe, t.fO2 + delta);
    if (t.fO2 + t.fHe > 1.0) t.fHe = 1.0 - t.fO2;
    t.fN2 = 1 - t.fO2 - t.fHe;
    t.label = gasLabel(t.fO2, t.fHe);
    if (selectedTankTab > 0) {
        var newMod = calculateMOD(tanks[selectedTankTab].fO2);
        if (tanks[selectedTankTab].switchDepth === null || tanks[selectedTankTab].switchDepth > newMod) {
            tanks[selectedTankTab].switchDepth = Math.round(newMod);
        }
    }
    _gsBuilt = false;
}
function gsAdjustHe(delta) {
    var t = tanks[selectedTankTab];
    if (delta > 0) t.fHe = Math.min(1.0 - t.fO2, t.fHe + delta);
    else t.fHe = Math.max(0, t.fHe + delta);
    t.fN2 = 1 - t.fO2 - t.fHe;
    t.label = gasLabel(t.fO2, t.fHe);
    _gsBuilt = false;
}
function gsAdjustPressure(delta) {
    var t = tanks[selectedTankTab];
    t.pressure = Math.max(200, Math.min(300, t.pressure + delta));
    t.totalGas = t.volume * t.pressure;
    t.gasRemaining = t.totalGas;
    _gsBuilt = false;
}
function gsAdjustAMV(delta) {
    amvRate = Math.max(AMV_MIN, Math.min(AMV_MAX, amvRate + delta));
    _gsBuilt = false;
}
function gsAdjustTankVol(delta) {
    var t = tanks[selectedTankTab];
    t.volume = Math.max(TANK_VOL_MIN, Math.min(TANK_VOL_MAX, t.volume + delta));
    t.totalGas = t.volume * t.pressure;
    t.gasRemaining = t.totalGas;
    _gsBuilt = false;
}
function gsAdjustSwitchDepth(delta) {
    if (selectedTankTab === 0) return;
    var t = tanks[selectedTankTab];
    var mod = calculateMOD(t.fO2);
    var minD = calculateMinDepth(t.fO2);
    if (t.switchDepth === null) t.switchDepth = Math.round(mod);
    t.switchDepth += delta;
    if (t.switchDepth > mod) t.switchDepth = Math.round(mod);
    if (t.switchDepth < minD) t.switchDepth = Math.ceil(minD);
    if (t.switchDepth < 0) t.switchDepth = 0;
    _gsBuilt = false;
}
function gsAdjustGFLow(delta) {
    gfLow = Math.max(GF_LOW_MIN, Math.min(GF_LOW_MAX, gfLow + delta));
    if (gfLow > gfHigh) gfLow = gfHigh;
    _gsBuilt = false;
}
function gsAdjustGFHigh(delta) {
    gfHigh = Math.max(GF_HIGH_MIN, Math.min(GF_HIGH_MAX, gfHigh + delta));
    if (gfHigh < gfLow) gfHigh = gfLow;
    _gsBuilt = false;
}
function gsApplyPreset(idx) {
    var t = tanks[selectedTankTab];
    var preset = GAS_PRESETS[idx];
    if (preset) {
        t.fO2 = preset.fO2;
        t.fHe = preset.fHe;
        t.fN2 = 1 - t.fO2 - t.fHe;
        t.label = gasLabel(t.fO2, t.fHe);
        _gsBuilt = false;
    }
}
function gsAddTank() {
    if (tankCount < MAX_TANKS) {
        tankCount++;
        tanks.push(createTank(0.21, 0.0, 200));
        tanks[tankCount - 1].switchDepth = Math.round(calculateMOD(tanks[tankCount - 1].fO2));
        _gsBuilt = false;
    }
}
function gsRemoveTank() {
    if (tankCount > 1) {
        tankCount--;
        tanks.pop();
        if (selectedTankTab >= tankCount) selectedTankTab = tankCount - 1;
        if (activeTank >= tankCount) activeTank = tankCount - 1;
        _gsBuilt = false;
    }
}

// WP-017: HTML help overlay
var _helpShown = false;

function showHtmlHelp() {
    var overlay = document.getElementById('html-help-overlay');
    var content = overlay.querySelector('.help-content');
    content.innerHTML = '';

    var title = document.createElement('div');
    title.className = 'help-title';
    title.textContent = S('helpTitle');
    content.appendChild(title);

    var sections = [
        { title: S('controlsTitle'), color: '#33ff99', text: S('controlsText') },
        { title: 'DEPTH', color: '#fff', text: S('helpDepth') },
        { title: 'NDL (No Deco Limit)', color: '#33ff33', text: S('helpNDL') },
        { title: 'DECO / Ceiling / Stops', color: '#ff3333', text: S('helpDeco') },
        { title: 'PO2 (O\u2082 Partial Pressure)', color: '#ffff33', text: S('helpPO2') },
        { title: 'GTR (Gas Time Remaining)', color: '#33ff33', text: S('helpGTR') },
        { title: 'AMV (Actual Minute Volume)', color: '#aaa', text: S('helpAMV') },
        { title: 'Ascent Rate Bar', color: '#ffff33', text: S('helpAscent') },
        { title: 'Safety Stop', color: '#ffff33', text: S('helpSafety') },
        { title: 'BEST Gas Indicator', color: '#00ffff', text: S('helpBest') },
        { title: 'Tank Bar', color: '#33ff33', text: S('helpTank') },
        { title: 'TTS (Time To Surface)', color: '#ff9933', text: S('helpTTS') },
        { title: 'Narcosis / END', color: '#ff8833', text: S('helpNarc') },
        { title: 'Tec Mode (Technical Diving)', color: '#66ccff', text: S('helpTec') },
        { title: 'CCR Mode (Rebreather)', color: '#ffcc00', text: S('helpCcr') }
    ];

    for (var i = 0; i < sections.length; i++) {
        var sec = document.createElement('div');
        sec.className = 'help-section';
        var t = document.createElement('div');
        t.className = 'help-section-title';
        t.style.color = sections[i].color;
        t.textContent = sections[i].title;
        sec.appendChild(t);
        var p = document.createElement('div');
        p.className = 'help-section-text';
        p.textContent = sections[i].text;
        sec.appendChild(p);
        content.appendChild(sec);
    }

    // Issue #38: "Don't show hints again" opt-out. Uses the same button styling
    // so the row reads as a coherent footer; setting HINT_DONE_KEY drops any
    // currently-queued hint and prevents future ones for this browser.
    var dismissBtn = document.createElement('button');
    dismissBtn.className = 'help-close-btn';
    dismissBtn.textContent = S('hintDismissBtn');
    dismissBtn.setAttribute('data-hint-dismiss', '1');
    dismissBtn.addEventListener('click', function() { dismissAllHints(); });
    dismissBtn.addEventListener('touchstart', function(e) { e.preventDefault(); dismissAllHints(); }, { passive: false });
    content.appendChild(dismissBtn);

    var closeBtn = document.createElement('button');
    closeBtn.className = 'help-close-btn';
    closeBtn.textContent = S('helpClose');
    closeBtn.addEventListener('click', function() { showHelp = false; });
    closeBtn.addEventListener('touchstart', function(e) { e.preventDefault(); showHelp = false; }, { passive: false });
    content.appendChild(closeBtn);

    overlay.style.display = 'block';
    overlay.scrollTop = 0;
}

function hideHtmlHelp() {
    document.getElementById('html-help-overlay').style.display = 'none';
}

// TASK-031D: Gas info overlay
function showHtmlGasInfo() {
  var overlay = document.getElementById('html-gas-info-overlay');
  var bestIdx = recommendBestGas();
  var html = '<div style="max-width:400px;margin:0 auto;color:#cde;font-family:monospace;">';
  html += '<h3 style="color:#33ff99;text-align:center;">' + S('gasInfoTitle') + '</h3>';
  for (var i = 0; i < tankCount; i++) {
    var t = tanks[i];
    var isActive = (i === activeTank);
    var isBest = (i === bestIdx && bestIdx !== activeTank);
    var cls = 'gas-info-card' + (isActive ? ' active' : '');
    var pBar = t.volume > 0 ? Math.round(t.gasRemaining / t.volume) : 0;
    var mod = Math.round(calculateMOD(t.fO2));
    var minD = Math.round(calculateMinDepth(t.fO2));
    var sdText = (i === 0 || t.switchDepth === null) ? '\u2014' : t.switchDepth + 'm';
    html += '<div class="' + cls + '">';
    html += '<div style="display:flex;justify-content:space-between;align-items:center;">';
    html += '<span style="color:#fff;font-size:14px;"><b>T' + (i+1) + '</b>: ' + t.label + '</span>';
    if (isActive) html += '<span style="color:#33ff99;font-size:11px;">\u25CF ACTIVE</span>';
    if (isBest) html += '<span class="best-tag">\u25B6 ' + S('gasInfoBest') + '</span>';
    html += '</div>';
    html += '<div style="font-size:12px;margin-top:4px;color:#9ab;">';
    html += 'O\u2082: ' + Math.round(t.fO2*100) + '% | He: ' + Math.round(t.fHe*100) + '% | N\u2082: ' + Math.round(t.fN2*100) + '%';
    html += '</div>';
    html += '<div style="font-size:12px;margin-top:2px;color:#9ab;">';
    html += S('gasInfoPressure') + ': ' + pBar + ' bar | ' + S('gasInfoMOD') + ': ' + mod + 'm | ' + S('gasInfoMinDepth') + ': ' + minD + 'm';
    html += '</div>';
    html += '<div style="font-size:12px;margin-top:2px;color:#9ab;">';
    html += S('gasInfoSwitchDepth') + ': ' + sdText;
    html += '</div></div>';
  }
  html += '<div style="text-align:center;margin-top:16px;">';
  html += '<button id="gas-info-close-btn" style="background:rgba(255,255,255,0.12);border:1px solid #556;color:#cde;font-family:monospace;font-size:13px;padding:8px 24px;border-radius:4px;cursor:pointer;">[I] / [Esc] ' + S('gasInfoClose') + '</button>';
  html += '</div></div>';
  overlay.innerHTML = html;
  overlay.style.display = 'block';
  // Issue #29: no inline onclick (CSP script-src doesn't allow 'unsafe-inline').
  document.getElementById('gas-info-close-btn').addEventListener('click', function() {
      showGasInfo = false;
  });
}

function hideHtmlGasInfo() {
  var overlay = document.getElementById('html-gas-info-overlay');
  if (overlay) overlay.style.display = 'none';
}

// SECTION: Tank helper functions
// SEARCH TERMS: createTank, gasLabel, activeGas, tankCount, selectedTankTab

// ============================================================
//  TANK HELPERS (TASK-017)
// ============================================================

function gasLabel(fO2, fHe) {
    if (fHe < 0.005) {
        if (Math.abs(fO2 - 0.21) < 0.005) return 'Air';
        return 'EAN' + Math.round(fO2 * 100);
    }
    return 'Tx ' + Math.round(fO2 * 100) + '/' + Math.round(fHe * 100);
}

function createTank(fO2, fHe, pressure) {
    if (fO2 === undefined) fO2 = 0.32;
    if (fHe === undefined) fHe = 0.0;
    if (pressure === undefined) pressure = 200;
    const volume = tankVolume;
    return {
        fO2: fO2,
        fHe: fHe,
        fN2: 1 - fO2 - fHe,
        pressure: pressure,
        volume: volume,
        totalGas: volume * pressure,
        gasRemaining: volume * pressure,
        label: gasLabel(fO2, fHe),
        switchDepth: null
    };
}

function getActiveTank() {
    return tanks[activeTank];
}

function activeGas() {
    if (diveMode === 'ccr' && ccrState.onBailout) {
        return { fO2: ccrState.dilFO2, fN2: ccrState.dilFN2, fHe: ccrState.dilFHe };
    }
    var t = tanks[activeTank];
    return { fO2: t.fO2, fHe: t.fHe, fN2: t.fN2 };
}

// SECTION: Dive initialization
// SEARCH TERMS: resetDive, initTissues, initParticles, initTanks, initCCR

// ============================================================
//  INITIALIZATION
// ============================================================

function initTissues() {
    tissues = [];
    tissuesHe = [];
    for (var i = 0; i < 16; i++) {
        tissues.push(INITIAL_N2_LOADING);
        tissuesHe.push(0.0);
    }
}

function initParticles() {
    particles = [];
    for (var i = 0; i < PARTICLE_COUNT; i++) {
        particles.push({
            x: Math.random() * 2000 - 500,
            depth: Math.random() * MAX_DEPTH,
            size: 1 + Math.random() * 2,
            speed: 0.002 + Math.random() * 0.005,
            phase: Math.random() * Math.PI * 2,
            alpha: 0.2 + Math.random() * 0.4
        });
    }
}

function initTanks() {
    tanks = [];
    for (var i = 0; i < tankCount; i++) {
        tanks.push(createTank(0.21, 0.0, 200));
    }
    activeTank = 0;
    selectedTankTab = 0;
}

function resetDive() {
    depth = 0;
    maxDepth = 0;
    avgDepthAccum = 0;
    avgDepthSamples = 0;
    diveTime = 0;
    ascentRate = 0;
    gameOverReason = '';
    po2ViolationTime = 0;
    dcsViolationTime = 0;
    safetyStopRemaining = 0;
    safetyStopNeeded = false;
    safetyStopComplete = false;
    safetyStopCountdownStarted = false;
    safetyStopPaused = false;
    ndlDroppedBelow5 = false;
    bubbles = [];
    breathPhase = 'inhale';
    breathTimer = BREATH_CYCLE_INHALE;
    exhaleEmitted = false;
    gasSwitchNotifyTime = 0;
    gasSwitchNotifyText = '';
    // Issue #38: reset in-memory hint state (queue + timer + edge cache) so a
    // new dive re-detects state-transition edges cleanly. The localStorage
    // flags (HINT_STORAGE_PREFIX + id, HINT_DONE_KEY) are intentionally left
    // untouched — hints persist "seen" across dives in the same browser, and
    // the "don't show again" opt-out survives resetDive() by design.
    hintNotifyTime = 0;
    hintNotifyText = '';
    hintQueue = [];
    hintEdges = { bcd: false, ndl: false, safetyStop: false, deco: false, overhead: false, current: false };
    fishes = [];
    fishSpawnTimer = randomFishInterval();
    wildlife = [];
    wildlifeSpawnTimer = 15;
    shark = null;
    sharkTimer = 60;
    currentVerticalRate = 0;
    bcdGasSurfaceLiters = 0;
    verticalVelocity = 0;
    barotraumaTime = 0;
    hypoxiaTime = 0;
    diverX = 0;
    horizontalVelocity = 0;
    // diveSite is intentionally NOT reset — it's a setup choice
    guidelineNodes = [];
    _guidelineTimer = 0;
    visibility = 1.0;
    inOverhead = false;
    badAirWarning = false;
    thirdsStartingGas = 0;
    thirdsCurrentPhase = 'outbound';
    thirdsPct = 100;
    thirdsTurnWarned = false;
    thirdsReserveActive = false;
    thirdsReserveHitThisDive = false;
    torchOn = !!(DIVE_SITES[diveSite] && DIVE_SITES[diveSite].hasOverhead);
    current.active = false;
    current.direction = 1;
    current.strength = 0;
    current.level = 0;
    current.depthMin = 0;
    current.depthMax = 0;
    current.timer = 0;
    current.rolledThisDive = false;
    narcosisIndex = 0;
    narcosisKOTime = 0;
    narcDrift = 0;
    bestGasAlerted = false;
    lastDecoStopDepth = 0;
    fastForwardActive = false;
    showHelp = false;
    showGasInfo = false;
    infoPageMode = 0;
    cnsPercent = 0;
    diveProfile = [];
    _profileSampleTimer = 0;
    // Issue #44: reset debriefing event log + accumulators
    diveEvents = [];
    minNdlSeen = Infinity;
    _fastAscentAccum = 0;
    _fastAscentPeak = 0;
    _ceilingViolationAccum = 0;
    // Issue #45: reset scenario-drill state (drillsEnabled itself is a
    // setup-time toggle and intentionally persists across dives).
    drillHasRunThisDive = false;
    drillState = {
        phase: 'inactive',
        id: null,
        startedAt: 0,
        flickerUntilReal: 0,
        selectedOption: -1,
        correct: false,
        debriefUntilReal: 0,
        freeflowUntilDiveSec: 0,
        freeflowDrainTankIdx: -1,
        lightRestoreAt: 0,
        // Issue #45 (review follow-up): set by the freeflow drill's "hold
        // breath" wrong option — while > 0 and unexpired, any positive
        // ascent rate (not just a fast one) accumulates barotraumaTime.
        breathHoldUntilDiveSec: 0,
        optionRects: []
    };
    for (var i = 0; i < tanks.length; i++) {
        tanks[i].gasRemaining = tanks[i].totalGas;
    }
    activeTank = 0;
    if (diveMode === 'ccr') {
        // BUG-5: previously called initCCR(), which wiped the entire
        // ccrState back to CCR_DEFAULTS — silently discarding every
        // setup-screen choice (diluent preset, cylinder sizes, setpoint).
        // Reset only the dynamic per-dive fields; configuration survives.
        ccrState.actualPO2 = ccrState.targetSP < ambientPressure(0) ? ccrState.targetSP : 0.21;
        ccrState.onBailout = false;
        ccrState.scrubberFailed = false;
        ccrState.co2BuildupTime = 0;
        ccrState.scrubberRemaining = ccrState.scrubberTotal;
        // BUG-24: snapshot the starting cylinder pressures so drawPostDive()
        // can compute gas used this dive (start - current), the same way
        // OC tanks track totalGas vs gasRemaining.
        ccrState.o2CylPressureStart = ccrState.o2CylPressure;
        ccrState.dilCylPressureStart = ccrState.dilCylPressure;
    }
    ccrHypoxiaTime = 0;
    ccrHyperoxiaTime = 0;
    ccrWarningBeepTriggered = false;
    initTissues();
    initParticles();
}

// Issue #38: onboarding-hint helpers.
// -----------------------------------------------------------------------
// showHintOnce(id, textKey)
//   Enqueue the localized string S(textKey) for one-time display, unless:
//     - the diver dismissed all hints (HINT_DONE_KEY is set), or
//     - this specific hint id already fired at least once in this browser
//       (HINT_STORAGE_PREFIX + id is set).
//   The localStorage write happens BEFORE the queue push so a mid-frame
//   crash still marks the hint as seen — a duplicate display is worse UX
//   than a silent drop. localStorage failures (private mode, disabled
//   storage) are swallowed; the hint simply won't persist across sessions
//   but still respects the in-memory hintEdges guard for the current dive.
// hintsDismissed() / dismissHints() / resetAllHints()
//   Small wrappers used by the help overlay button and the test harness.
function _hintsAreDismissed() {
    try { return localStorage.getItem(HINT_DONE_KEY) === '1'; }
    catch { return false; }
}
function showHintOnce(id, textKey) {
    if (_hintsAreDismissed()) return false;
    var key = HINT_STORAGE_PREFIX + id;
    try {
        if (localStorage.getItem(key) === '1') return false;
        localStorage.setItem(key, '1');
    } catch {
        // Storage unavailable — fall back to the in-memory hintEdges guard
        // (updateDiving() sets hintEdges[trigger]=true after calling
        // showHintOnce, so the trigger won't re-fire this dive).
    }
    hintQueue.push(S(textKey));
    return true;
}
function dismissAllHints() {
    try { localStorage.setItem(HINT_DONE_KEY, '1'); } catch {}
    // Also drop any queued/visible hint so the opt-out feels immediate.
    hintQueue = [];
    hintNotifyTime = 0;
    hintNotifyText = '';
}
// Test helper — clears every persisted hint flag so a test can exercise
// "first-time" behaviour repeatedly. Only clears keys under the
// HINT_STORAGE_PREFIX namespace + HINT_DONE_KEY; unrelated localStorage
// (e.g. SAVE_KEY) is left untouched.
function resetAllHintsForTests() {
    try {
        var toRemove = [];
        for (var i = 0; i < localStorage.length; i++) {
            var k = localStorage.key(i);
            if (k && (k === HINT_DONE_KEY || k.indexOf(HINT_STORAGE_PREFIX) === 0)) {
                toRemove.push(k);
            }
        }
        for (var j = 0; j < toRemove.length; j++) localStorage.removeItem(toRemove[j]);
    } catch {}
    hintQueue = [];
    hintNotifyTime = 0;
    hintNotifyText = '';
    hintEdges = { bcd: false, ndl: false, safetyStop: false, deco: false, overhead: false, current: false };
}

function randomFishInterval() {
    return 8 + Math.random() * 12;
}