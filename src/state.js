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

function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
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
});
window.addEventListener('keyup', e => {
    keys[e.key.toLowerCase()] = false;
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
// Rule-of-thirds warning flags (cave/wreck only)
let thirdsTurnWarned = false;
let thirdsReserveActive = false;
// D6: Player torch — ON by default for overhead sites, OFF in open water
let torchOn = false;

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
  o2CylVolume: 2, o2CylPressure: 200,
  dilCylVolume: 3, dilCylPressure: 200,
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
  { name: 'Heliox',    fO2: 0.00, fHe: 1.00 }
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

function updateCCRLoop(dtSec) {
  if (ccrState.onBailout) return;
  var dtMin = dtSec / 60;

  // Metabolic O2 consumption (constant rate regardless of depth)
  var o2Used = ccrState.metabolicO2Rate * dtMin; // surface liters
  var o2Available = ccrState.o2CylPressure * ccrState.o2CylVolume; // total surface liters in O2 cyl
  if (o2Used > o2Available) o2Used = o2Available;
  ccrState.o2CylPressure -= o2Used / ccrState.o2CylVolume;
  if (ccrState.o2CylPressure < 0) ccrState.o2CylPressure = 0;

  // PO2 management
  var pAmb = ambientPressure(depth);

  // If O2 cylinder has gas, solenoid injects to maintain setpoint
  if (ccrState.o2CylPressure > 0 && ccrState.actualPO2 < ccrState.targetSP) {
    var maxRise = ccrState.po2ResponseRate * dtSec;
    var deficit = ccrState.targetSP - ccrState.actualPO2;
    ccrState.actualPO2 += Math.min(maxRise, deficit);
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
  // Loop volume compresses on descent, needs diluent to maintain volume
  var dilNeeded = ccrState.loopVolume * (p2 / p1 - 1); // ambient liters needed
  var dilSurfEquiv = dilNeeded * p2; // convert to surface equivalent
  var dilAvailable = ccrState.dilCylPressure * ccrState.dilCylVolume;
  if (dilSurfEquiv > dilAvailable) dilSurfEquiv = dilAvailable;
  ccrState.dilCylPressure -= dilSurfEquiv / ccrState.dilCylVolume;
  if (ccrState.dilCylPressure < 0) ccrState.dilCylPressure = 0;
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
  html += '<button onclick="showGasInfo=false;" style="background:rgba(255,255,255,0.12);border:1px solid #556;color:#cde;font-family:monospace;font-size:13px;padding:8px 24px;border-radius:4px;cursor:pointer;">[I] / [Esc] ' + S('gasInfoClose') + '</button>';
  html += '</div></div>';
  overlay.innerHTML = html;
  overlay.style.display = 'block';
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
    thirdsTurnWarned = false;
    thirdsReserveActive = false;
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
    for (var i = 0; i < tanks.length; i++) {
        tanks[i].gasRemaining = tanks[i].totalGas;
    }
    activeTank = 0;
    if (diveMode === 'ccr') { initCCR(); }
    ccrHypoxiaTime = 0;
    ccrHyperoxiaTime = 0;
    ccrWarningBeepTriggered = false;
    initTissues();
    initParticles();
}

function randomFishInterval() {
    return 8 + Math.random() * 12;
}