// ============================================================
// FILE: constants.js
// PURPOSE: All game constants, ZHL-16C coefficient tables, tuning
//          parameters, and the S() i18n string lookup function.
//          Nothing here has side effects — safe to read first.
//
// DEPENDS ON: nothing
//
// USED BY: every other file
//
// KEY SYMBOLS (grep to find):
//   S(key)               — i18n string lookup, language set by currentLang
//   STRINGS              — full EN/DE string table
//   ZHL16C_N2[]          — Bühlmann N2 compartment coefficients, {ht, a, b} × 16
//   ZHL16C_HE[]          — Bühlmann He compartment coefficients, {ht, a, b} × 16
//   BUOYANCY_PARAMS.maxAscentRate/maxDescentRate — physical ascent/descent clamps (m/min)
//   TIME_ACCELERATION    — 3x real-time default
//   FAST_FORWARD_MULTIPLIER — 10x skip multiplier
// SECTION: Game constants and tuning parameters
// SEARCH TERMS: TIME_ACCELERATION, BUOYANCY_PARAMS, FAST_FORWARD_MULTIPLIER, ZHL16C_N2, ZHL16C_HE

// ============================================================
// ============================================================
//  CONSTANTS
// ============================================================

const TIME_ACCELERATION = 3;
const FAST_FORWARD_MULTIPLIER = 10;
// Issue #100: the diver's horizontal screen anchor as a fraction of canvas
// width, used by every world-to-screen projection in renderer.js
// (screenX = W * DIVER_SCREEN_X_FRACTION + (worldX - diverX) / metersPerPixel).
// Previously inlined as the literal 0.25 (25% from the left — a "look-ahead"
// framing) at 35+ separate call sites; centralized here per the decision to
// center the diver unconditionally (0.5 = screen-center).
const DIVER_SCREEN_X_FRACTION = 0.5;
// Issue #65: physics integrator sub-step cap. `updateBuoyancyPhysics()` and
// `updateHorizontalPhysics()` both do explicit Euler with per-step drag
// factors of ~0.4-0.8 * dt — at dt = 3s (fast-forward + a frame drop) the
// per-step drag factor can exceed 1, inverting velocity sign every step.
// Callers break a large frame dt into steps of at most this many seconds
// to keep every per-step drag factor well below 1. A single sub-step is a
// no-op wrapper in the common small-dt case.
const PHYSICS_MAX_SUBSTEP_SEC = 0.1;
// Issue #30: the ASSUMED planning rate used when simulating time-to-surface,
// distinct from BUOYANCY_PARAMS.maxAscentRate below (the physical clamp on
// how fast the diver's own buoyancy CAN carry them). calculateDecoSchedule() used to
// simulate ascent-to-first-stop and the final ascent at a very conservative
// 3 m/min while calculateTTS()'s non-deco path used 9 m/min — a diver
// crossing from non-deco into deco saw TTS triple for no in-fiction reason.
// 9 m/min matches typical deco software and the in-game help text's
// recommended ≤9-10 m/min ascent rate.
const DECO_PLANNING_ASCENT_RATE_MPM = 9;
// WP-015: HiDPI canvas — cap devicePixelRatio to avoid fill-rate cost on
// phones with dpr 3+ where the visual gain is negligible.
const MAX_DEVICE_PIXEL_RATIO = 2;
// (Old movement constants removed — buoyancy system replaced direct accel/decel)

const BUOYANCY_PARAMS = {
  bcdMaxCapacity: 18,
  inflateRate: 0.4,
  ventRate: 0.75,
  wetsuitBuoyancySurface: 5.0,
  wetsuitCompressionExp: 0.7,
  bodyBuoyancy: 3.0,
  leadWeight: 7.0,
  gearWeightNet: 2.0,
  diverMass: 85,
  dragCoefficient: 0.4,
  gravityFactor: 0.115,
  neutralDeadZone: 0.15,
  maxAscentRate: 25,   // runaway over-inflated ascent can exceed BAROTRAUMA_RATE (18) → pneumothorax
  maxDescentRate: 20
};

const FINKICK_PARAMS = {
  kickAccel: 0.48,        // m/s² impulse per second while A/D held — tuned so terminal v = maxSpeed
  dragCoefficient: 0.8,   // high drag — stops in ~1–2 s with no input
  maxSpeed: 0.6,          // m/s cap — hard sprint pace for a recreational diver
  exertionThreshold: 0.1, // m/s above which gas cost rises
  exertionFactor: 1.4     // AMV multiplier while actively kicking
};

const CURRENT_PARAMS = {
  chancePerDive: 0.15,    // probability a dive features a current at all
  minStrength: 0.20,      // m/s
  maxStrength: 0.55,      // m/s — can exceed relaxed kick, near max sprint
  minDuration: 60,        // sim seconds active
  maxDuration: 180,
  bandMargin: 8,          // depth band half-height around a centre depth (m)
  rampTime: 8             // sim seconds to fade in/out (gradual onset/decay)
};

// Phase C: dive-site geometry constants
const DIVER_RADIUS          = 0.6;   // metres — half-width of the diver collision shape
const GUIDELINE_MAX_NODES   = 400;   // maximum breadcrumb nodes stored
const GUIDELINE_SAMPLE_SEC  = 1.0;   // dive-seconds between guideline samples
const SILT_KICK_THRESHOLD   = 0.35;  // m/s above which fast kicks stir silt
const SILT_DECAY            = 0.25;  // visibility lost per dive-second at threshold
const SILT_RECOVER          = 0.08;  // visibility gained per dive-second while calm
const TORCH_RADIUS_M        = 5;     // torch light cone radius in metres

// Issue #27: Rule-of-thirds gas planning (overhead environments only).
// Standard tec/cave-diving convention: one third of the starting gas for
// the outbound leg, one third for the return leg, one third as reserve.
// Fractions are of the "starting gas" snapshotted on first entry into
// the overhead — see updateDiving()'s rule-of-thirds block.
const THIRDS_TURN_FRACTION    = 2 / 3;   // > 2/3 remaining -> outbound
const THIRDS_RESERVE_FRACTION = 1 / 3;   // < 1/3 remaining -> reserve

// Issue #68: the safety-stop countdown's own active-tick range (2.4-8.3m)
// was duplicated as a narrower ±1.5m-around-5m band in two separate
// fast-forward-eligibility checks (game-loop.js, touch.js), so at e.g. 7.5m
// the countdown visibly ticked down but the FF button didn't appear. One
// shared constant pair, used by the countdown tick AND both FF checks.
const SAFETY_STOP_ACTIVE_MIN_D = 2.4;
const SAFETY_STOP_ACTIVE_MAX_D = 8.3;

const BAROTRAUMA_RATE   = 18;   // m/min ascent threshold for injury
const BAROTRAUMA_TIME   = 10;   // dive-seconds sustained to trigger game over

// Issue #44: Post-dive debriefing thresholds. FAST_ASCENT_RATE is 9 m/min
// (the yellow-caution line the ascent bar already uses). Sustained above
// this for FAST_ASCENT_EVENT_SEC seconds records one fastAscent event.
// Ceiling violation similarly needs to be sustained (0.3 m tolerance so
// a one-frame overshoot doesn't count).
const FAST_ASCENT_RATE            = 9;    // m/min — threshold for a debriefing "fast ascent" event
const FAST_ASCENT_EVENT_SEC       = 2;    // sustained seconds required to record one event
const CEILING_VIOLATION_TOL_M     = 0.3;  // m — depth below ceiling before a violation counts
const CEILING_VIOLATION_EVENT_SEC = 2;    // sustained seconds required

// Grading — see gradeDive() in physics.js
const GRADE_STAR_1_MIN            = 50;
const GRADE_STAR_2_MIN            = 75;
const GRADE_STAR_3_MIN            = 92;
const GRADE_FAST_ASCENT_PENALTY   = 15;   // points off per fastAscent event
const GRADE_CEILING_PENALTY       = 30;   // points off per ceilingViolation event
const GRADE_SAFETY_SKIPPED_SCORE  = 30;   // fixed score when needed stop was skipped
const GRADE_GAS_RESERVE_FULL_BAR  = 50;   // min remaining bar for full "gas reserve" score
const GRADE_LOW_NDL_HINT_MIN      = 3;    // min NDL seen below this adds "cut it close" note
const GRADE_TRIM_HOLD_WINDOW_SEC  = 60;   // rolling-window seconds for "holding" detection
const GRADE_TRIM_HOLD_DELTA_M     = 1.0;  // rolling window range < this m = holding phase
const GRADE_TRIM_STDDEV_FULL_M    = 0.5;  // stddev at/below this m => score 100
const GRADE_TRIM_STDDEV_ZERO_M    = 3.0;  // stddev at/above this m => score 0
const MAX_DEPTH         = 300;
const P_H2O             = 0.0627;
const LN2               = Math.log(2);
const INITIAL_N2_LOADING = (1.0 - P_H2O) * 0.79;

// Gas
let tankVolume           = 12;
const TANK_VOL_DEFAULT   = 12;
const TANK_VOL_MIN       = 6;
const TANK_VOL_MAX       = 24;
let amvRate             = 15;   // mutable — configurable in advanced settings
const AMV_DEFAULT       = 15;
const AMV_MIN           = 8;
const AMV_MAX           = 25;

// Gradient factors (Bühlmann GF)
let gfLow = 35;        // percent (30-100) — technical dive computer default
let gfHigh = 75;       // percent (30-100) — technical dive computer default
const GF_LOW_MIN = 30;
const GF_LOW_MAX = 100;
const GF_HIGH_MIN = 30;
const GF_HIGH_MAX = 100;
const GF_LOW_DEFAULT = 35;
const GF_HIGH_DEFAULT = 75;

// Issue #6: gas-setup keyboard step sizes. Match the values previously
// baked into the HTML/touch-button handlers (buildHtmlGasSetup() action
// buttons) and the ±steps promised in the gfHint / pressureHint / amvHint /
// tankSizeHint strings above. Centralised here so a step-size tweak is a
// single-line edit, not a hunt through ui.js.
const GAS_SETUP_O2_STEP        = 0.01;   // O2 fraction per arrow-left/right press
const GAS_SETUP_HE_STEP        = 0.01;   // He fraction per arrow-up/down press
const GAS_SETUP_PRESSURE_STEP  = 10;     // bar per PgUp/PgDn press
const GAS_SETUP_AMV_STEP       = 1;      // L/min per [/] press
const GAS_SETUP_TANK_VOL_STEP  = 1;      // litres per ,/. press
const GAS_SETUP_GF_STEP        = 5;      // percent per G/F press (Shift inverts sign)

// Bubble config
const BUBBLE_RADIUS_MIN = 2;
const BUBBLE_RADIUS_MAX = 6;
const BUBBLE_RISE_MIN   = 0.15;
const BUBBLE_RISE_MAX   = 0.30;
const BUBBLE_MAX_AGE    = 15;

// Breathing cycle
const BREATH_CYCLE_INHALE = 2.0;   // dive-seconds
const BREATH_CYCLE_EXHALE = 1.5;   // dive-seconds
const BREATH_CYCLE_PAUSE  = 0.5;   // dive-seconds

// O2 thresholds
const PO2_HYPOXIA       = 0.16;
const PO2_SAFE          = 1.0;
const PO2_ELEVATED      = 1.4;
const PO2_HIGH          = 1.6;
const PO2_TOXICITY_TIME = 30;

// DCS threshold
const DCS_VIOLATION_TIME = 60;

// TASK-032A / BUG-CCR-4: CCR cylinder configuration limits
const CCR_O2_VOL_MIN     = 2;     // litres
const CCR_O2_VOL_MAX     = 5;     // litres
const CCR_O2_PRES_MIN    = 50;    // bar
const CCR_O2_PRES_MAX    = 300;   // bar
const CCR_O2_PRES_STEP   = 10;    // bar (also used for diluent)
const CCR_DIL_VOL_MIN    = 2;     // litres
const CCR_DIL_VOL_MAX    = 12;    // litres
const CCR_SP_MIN         = 0.5;   // bar
const CCR_SP_MAX         = 1.6;   // bar
const CCR_SP_STEP        = 0.1;   // bar

// WP-020: Nitrogen narcosis
const NARC_ONSET_BAR    = 1.5;
const NARC_FULL_BAR     = 8.0;
const NARC_RAMP_UP      = 0.012;
const NARC_RAMP_DOWN    = 0.025;
const NARC_KO_THRESHOLD = 0.95;
const NARC_KO_TIME      = 30;

// Issue #37: Orientation aids — back-way chip + depth-scale ruler.
// BACKWAY_MIN_DISTANCE_M — the chip is hidden when |diverX - boatX|
// is at or below this value. Right at the entry the chip is noise;
// beyond ~25 m the diver has genuinely drifted and wants a heading.
// DEPTH_SCALE_TICK_INTERVAL_M / DEPTH_SCALE_LABEL_INTERVAL_M — the
// ruler paints a short tick every TICK metres and a labelled tick
// every LABEL metres. LABEL must be an integer multiple of TICK.
const BACKWAY_MIN_DISTANCE_M     = 25;
const DEPTH_SCALE_TICK_INTERVAL_M  = 5;
const DEPTH_SCALE_LABEL_INTERVAL_M = 10;

// Colors
const COLOR_SURFACE_WATER = [135, 206, 235];
const COLOR_DEEP_WATER    = [0, 17, 51];
const DEPTH_GRADIENT_MAX  = 200;

// Issue #39: HUD status colours — colour-blind accessibility.
// -----------------------------------------------------------------------
// Every semantic status readout on the dive-computer HUD (PO2, NDL, GTR,
// tank pressure, N2 loading, GF99/SurfGF/CNS, ceiling, ascent chevrons,
// tissue bars, safety-stop text, CCR PO2/SCR/O2/dil pressure) resolves
// its colour through hudColor(tier) instead of a hardcoded '#ff3333' /
// '#46f08f' / etc. literal. Two palettes ship:
//
//   HUD_COLORS_DEFAULT  — traffic-light (green / yellow / orange / red),
//                         matches the visual identity divers coming from
//                         real dive computers expect.
//   HUD_COLORS_CVD      — colour-vision-deficient safe palette. Uses a
//                         blue → yellow → orange → magenta-red axis so
//                         deuteranopes / protanopes / tritanopes still
//                         see a clear tier progression (Wong 2011 style,
//                         adjusted for HUD contrast on a dark canvas).
//
// Danger-tier VALUES additionally get a '⚠ ' prefix via hudDangerPrefix()
// (redundant coding — the state remains identifiable in grayscale even
// when colour vision fails entirely). Blink was already used for the
// warning banner and >18 m/min ascent chevrons; those keep working
// unchanged and continue to serve as the second non-colour cue.
//
// Persistence: the chosen mode is stored under HUD_COLORS_STORAGE_KEY.
// gameAPI.colorMode exposes get/set for tests.
const HUD_COLORS_DEFAULT = {
    ok:      '#46f08f',
    caution: '#ffd24d',
    warn:    '#ff9933',
    danger:  '#ff3333'
};
const HUD_COLORS_CVD = {
    ok:      '#3a86ff',   // saturated blue — clearly distinct from yellow/orange for all CVD types
    caution: '#ffcc00',   // bright yellow — luminance separated from ok and warn even in grayscale
    warn:    '#fb8500',   // orange — sits between yellow and magenta-red for a smooth ramp
    danger:  '#e5383b'    // magenta-red — retains "red" identity but shifted off pure red so
                          // deuteranopes/protanopes don't confuse it with the orange warn tier
};
const HUD_COLORS_STORAGE_KEY = 'hudColorMode';
const HUD_DANGER_PREFIX = '⚠ ';   // ⚠ + space — redundant coding for grayscale readability

let hudColorMode = 'default';   // 'default' | 'cvd'
try {
    const _stored = localStorage.getItem(HUD_COLORS_STORAGE_KEY);
    if (_stored === 'cvd' || _stored === 'default') hudColorMode = _stored;
} catch { /* private mode / storage disabled — fall back to in-memory default */ }

function hudColor(tier) {
    const pal = hudColorMode === 'cvd' ? HUD_COLORS_CVD : HUD_COLORS_DEFAULT;
    return pal[tier] || pal.ok;
}

// Prepend to danger-tier text values so the state is unambiguously
// identifiable even in grayscale or by fully colour-blind users.
function hudDangerPrefix() {
    return HUD_DANGER_PREFIX;
}

function setHudColorMode(mode) {
    if (mode !== 'default' && mode !== 'cvd') return false;
    hudColorMode = mode;
    try { localStorage.setItem(HUD_COLORS_STORAGE_KEY, mode); } catch { /* swallow */ }
    return true;
}

function toggleHudColorMode() {
    return setHudColorMode(hudColorMode === 'default' ? 'cvd' : 'default');
}

// Reef palette — used by reef coral/sponge/cloud drawers and warm rock tone.
const REEF_PAL = {
  rockShade:'#3a2415', rockMid:'#5a3623', rockWarm:'#7a4a32', rockLite:'#a87355',
  sand:'#d6c08a',
  tableCoral:'#c89860', tableHi:'#e8c98a',
  brainCoral:'#b08a4a', brainHi:'#d8aa66',
  staghorn:'#e8c44b', staghorn2:'#d8b85a',
  softPink:'#e8839a', softMag:'#c84a8a', softPurple:'#7a4a8a',
  gorgBright:'#c83a5a', gorgMid:'#a83a4a', gorgDeep:'#882a3a',
  barrel1:'#9c5a3a', barrel2:'#8a4828',
  anthias:'#ff7a3a', anthiasLt:'#ffb18a', anthiasCore:'#ffe1bd', anthiasDeep:'#c63a1a'
};

// ZHL-16C N2 compartment constants.
// Issue #40: provenance note. These a/b/half-time coefficients are Albert
// Bühlmann's published ZHL-16C algorithm — standard reference data used
// throughout the diving/decompression software field (e.g. Baker,
// "Understanding M-values", 1998; Bühlmann, "Tauchmedizin", 5th ed.), not
// original research. Independently transcribed for this project; not
// copied from any specific copyleft-licensed codebase.
const ZHL16C_N2 = [
    { ht: 5.0,   a: 1.2599, b: 0.5050 },
    { ht: 8.0,   a: 1.0000, b: 0.6514 },
    { ht: 12.5,  a: 0.8618, b: 0.7222 },
    { ht: 18.5,  a: 0.7562, b: 0.7825 },
    { ht: 27.0,  a: 0.6200, b: 0.8126 },
    { ht: 38.3,  a: 0.5043, b: 0.8434 },
    { ht: 54.3,  a: 0.4410, b: 0.8693 },
    { ht: 77.0,  a: 0.4000, b: 0.8910 },
    { ht: 109.0, a: 0.3750, b: 0.9092 },
    { ht: 146.0, a: 0.3500, b: 0.9222 },
    { ht: 187.0, a: 0.3295, b: 0.9319 },
    { ht: 239.0, a: 0.3065, b: 0.9403 },
    { ht: 305.0, a: 0.2835, b: 0.9477 },
    { ht: 390.0, a: 0.2610, b: 0.9544 },
    { ht: 498.0, a: 0.2480, b: 0.9602 },
    { ht: 635.0, a: 0.2327, b: 0.9653 }
];

// TASK-015: ZHL-16C He compartment constants
const ZHL16C_HE = [
    { ht: 1.88,  a: 1.6189, b: 0.4770 },
    { ht: 3.02,  a: 1.3830, b: 0.5747 },
    { ht: 4.72,  a: 1.1919, b: 0.6527 },
    { ht: 6.99,  a: 1.0458, b: 0.7223 },
    { ht: 10.21, a: 0.9220, b: 0.7582 },
    { ht: 14.48, a: 0.8205, b: 0.7957 },
    { ht: 20.53, a: 0.7305, b: 0.8279 },
    { ht: 29.11, a: 0.6502, b: 0.8553 },
    { ht: 41.20, a: 0.5950, b: 0.8757 },
    { ht: 55.19, a: 0.5545, b: 0.8903 },
    { ht: 70.69, a: 0.5333, b: 0.8997 },
    { ht: 90.34, a: 0.5189, b: 0.9073 },
    { ht: 115.29, a: 0.5181, b: 0.9122 },
    { ht: 147.42, a: 0.5176, b: 0.9171 },
    { ht: 188.24, a: 0.5172, b: 0.9217 },
    { ht: 240.03, a: 0.5119, b: 0.9267 }
];

// TASK-022 / D2: Fish types — REQUIRED sites:[] restricts spawning to those
// diveSite values. Issue #42: every type carries an explicit filter so
// mismatched fauna (e.g. whales in caves) can no longer slip in via the
// unfiltered fallback in _eligibleTypes(). Cave is deliberately near-empty —
// real caves have almost no free-swimming fauna. Leaving a site with an
// empty eligible pool is fine: spawnFish() / spawnWildlife() just no-op that
// tick and try again on the next spawn timer.
const FISH_TYPES = [
    { name: 'clownfish',  color: '#ff8c00', stripe: '#fff',    size: 12, speedMin: 0.3,  speedMax: 0.6,  depthMin: 5,   depthMax: 30,  sites: ['reef'] },
    { name: 'bluefish',   color: '#4488ff', stripe: '#aaccff', size: 15, speedMin: 0.2,  speedMax: 0.5,  depthMin: 10,  depthMax: 50,  sites: ['shore','reef','wreck'] },
    { name: 'anglerfish', color: '#334455', stripe: '#556677', size: 20, speedMin: 0.1,  speedMax: 0.3,  depthMin: 40,  depthMax: 90,  sites: ['reef'] },
    { name: 'tropical',   color: '#ffdd00', stripe: '#ff4444', size: 10, speedMin: 0.4,  speedMax: 0.8,  depthMin: 3,   depthMax: 25,  sites: ['shore','reef'] },
    { name: 'grouper',    color: '#556b2f', stripe: '#6b8e23', size: 25, speedMin: 0.1,  speedMax: 0.3,  depthMin: 15,  depthMax: 60,  sites: ['reef','wreck'] },
    { name: 'viperfish',  color: '#1a1a3a', stripe: '#3344aa', size: 14, speedMin: 0.05, speedMax: 0.2,  depthMin: 80,  depthMax: 280, sites: ['reef'] },
    { name: 'barracuda',  color: '#8899aa', stripe: '#aabbcc', size: 22, speedMin: 0.5,  speedMax: 1.0,  depthMin: 5,   depthMax: 40,  sites: ['shore','reef','wreck'] },
    { name: 'lionfish',   color: '#cc4422', stripe: '#ffaa66', size: 14, speedMin: 0.1,  speedMax: 0.3,  depthMin: 10,  depthMax: 45,  sites: ['reef'] },
    { name: 'tang',       color: '#1177ff', stripe: '#ffee00', size: 11, speedMin: 0.3,  speedMax: 0.7,  depthMin: 5,   depthMax: 25,  sites: ['reef'] },
    { name: 'parrotfish', color: '#44bb88', stripe: '#ff88aa', size: 18, speedMin: 0.2,  speedMax: 0.5,  depthMin: 5,   depthMax: 30,  sites: ['reef'] },
    { name: 'snapper',    color: '#dd7722', stripe: '#ffcc66', size: 16, speedMin: 0.2,  speedMax: 0.5,  depthMin: 10,  depthMax: 40,  sites: ['shore','reef','wreck'] },
    { name: 'flounder',   color: '#8b7355', stripe: '#a09060', size: 18, speedMin: 0.05, speedMax: 0.2,  depthMin: 15,  depthMax: 50,  sites: ['shore'] },
    { name: 'dragonfish', color: '#0a0a1a', stripe: '#223388', size: 16, speedMin: 0.05, speedMax: 0.15, depthMin: 150, depthMax: 280, sites: ['reef'] },
    { name: 'anthias',    color: '#ff7a3a', stripe: '#ffb18a', size: 6,  speedMin: 0.3,  speedMax: 0.6,  depthMin: 4,   depthMax: 25,  sites: ['reef'] },
    { name: 'bannerfish', color: '#f5f5e8', stripe: '#1a1a1a', size: 14, speedMin: 0.25, speedMax: 0.5,  depthMin: 5,   depthMax: 35,  sites: ['reef'] }
];

// D2: Wildlife types — turtle and ray added for reef/shore variety.
// Issue #42: whale is now reef-only (a 60-metre whale swimming through a
// wreck or cave broke immersion completely). jellyfish/octopus keep their
// broad open-water range but are explicitly excluded from cave.
const WILDLIFE_TYPES = [
    { name: 'jellyfish', color: 'rgba(180,220,255,0.6)', size: 18, speedMin: 0.05, speedMax: 0.15, depthMin: 3,  depthMax: 50,  sites: ['shore','reef','wreck'] },
    { name: 'octopus',   color: '#8B4513',               size: 22, speedMin: 0.08, speedMax: 0.2,  depthMin: 10, depthMax: 70,  sites: ['shore','reef','wreck'] },
    { name: 'whale',     color: '#334455',               size: 60, speedMin: 0.1,  speedMax: 0.2,  depthMin: 20, depthMax: 100, sites: ['reef'] },
    { name: 'turtle',    color: '#4a7a3a',               size: 24, speedMin: 0.1,  speedMax: 0.25, depthMin: 3,  depthMax: 40,  sites: ['reef', 'shore'] },
    { name: 'ray',       color: '#2a3a4a',               size: 30, speedMin: 0.15, speedMax: 0.35, depthMin: 10, depthMax: 60,  sites: ['reef', 'wreck'] },
    { name: 'greyReefShark', color: '#4a5664',           size: 46, speedMin: 0.2,  speedMax: 0.4,  depthMin: 15, depthMax: 80,  sites: ['reef'] },
    { name: 'hammerhead',    color: '#3a4754',           size: 60, speedMin: 0.18, speedMax: 0.35, depthMin: 40, depthMax: 120, sites: ['reef'] },
    { name: 'dolphin',       color: '#465260',           size: 34, speedMin: 0.25, speedMax: 0.45, depthMin: 2,  depthMax: 14,  sites: ['reef'] }
];

const GAME_OVER_INFO = {
    'OUT OF GAS': {
        cause: 'All tanks depleted \u2014 no breathing gas remaining.',
        medical: 'Without breathing gas, drowning is immediate. At depth, the diver cannot reach the surface safely without gas to breathe.',
        prevention: [
            'Monitor your tank pressure and GTR (Gas Time Remaining) regularly',
            'Plan turn pressure \u2014 start ascending when you reach 1/3 of your total gas',
            'At depth, gas is consumed much faster due to increased ambient pressure',
            'Carry a redundant gas supply in a stage/bailout tank'
        ]
    },
    'O2 TOXICITY \u2014 CNS SEIZURE': {
        cause: 'Partial pressure of oxygen (PO2) exceeded 1.6 bar for more than 30 seconds.',
        medical: 'Central Nervous System (CNS) oxygen toxicity causes convulsions, loss of consciousness, and drowning. It occurs when the partial pressure of oxygen exceeds safe limits, typically above 1.6 bar.',
        prevention: [
            'Never exceed your gas mix\'s Maximum Operating Depth (MOD)',
            'Switch to a lower O2% gas when descending deeper',
            'Use Trimix or Heliox for deep dives to keep PO2 in safe range',
            'Monitor the PO2 display \u2014 orange/red means danger'
        ]
    },
    'DECOMPRESSION SICKNESS': {
        cause: 'Ascended above your decompression ceiling or surfaced with excess dissolved inert gas. Nitrogen and/or helium formed bubbles in your tissues.',
        medical: 'DCS ("the bends") occurs when dissolved inert gas comes out of solution as bubbles in blood and tissues. Symptoms range from joint pain and skin rashes to paralysis, stroke, and death. Bubbles can block blood vessels and damage the spinal cord and brain.',
        prevention: [
            'Never ascend above your ceiling depth \u2014 watch the CEIL indicator',
            'Complete ALL required decompression stops before surfacing',
            'Ascend slowly (max 9m/min recommended)',
            'Always do a 3-minute safety stop at 5m',
            'Stay within NDL limits for recreational diving'
        ]
    },
    'PULMONARY BAROTRAUMA \u2014 PNEUMOTHORAX': {
        cause: 'Ascended too rapidly, causing lung over-expansion injury from Boyle\'s Law gas expansion.',
        medical: 'Rapid ascent causes air trapped in the lungs to expand. This can rupture lung tissue (alveoli), causing pneumothorax (collapsed lung), arterial gas embolism, or mediastinal emphysema. It can be fatal even in very shallow water.',
        prevention: [
            'Never ascend faster than 9\u201310 m/min',
            'Watch your ascent rate indicator \u2014 keep it green',
            'Release the W key periodically to slow your ascent',
            'In real diving: never hold your breath while ascending'
        ]
    },
    'HYPOXIA \u2014 LOSS OF CONSCIOUSNESS': {
        cause: 'Partial pressure of oxygen (PO2) dropped below 0.16 bar \u2014 insufficient oxygen for consciousness.',
        medical: 'Hypoxia causes loss of consciousness without warning. Unlike high-PO2 toxicity, low-PO2 gives no clear symptoms before blackout. The brain requires a minimum PO2 of ~0.16 bar to function. Breathing a low-oxygen mix at shallow depth is immediately dangerous.',
        prevention: [
            'Never breathe a hypoxic mix (low O2%) at shallow depth',
            'Check your gas MOD AND minimum operating depth before switching',
            'Travel mixes with <18% O2 should only be breathed below their minimum depth',
            'Trimix with 15% O2 becomes hypoxic above ~3m'
        ]
    },
    'SHARK ATTACK': {
        cause: 'A shark decided you looked like lunch.',
        medical: 'Sharks rarely attack divers, but when they do, it tends to be memorable. This was an especially hungry shark.',
        prevention: [
            'Be aware of your surroundings at all times',
            'Avoid areas known for aggressive shark species',
            'Do not carry bleeding fish or shiny objects'
        ]
    },
    'NITROGEN NARCOSIS \u2014 UNCONSCIOUSNESS': {
        cause: 'Narcotic partial pressure exceeded safe limits for too long, causing loss of consciousness at depth.',
        medical: 'Nitrogen narcosis occurs when breathing nitrogen at elevated partial pressures during deep dives. Nitrogen disrupts neural transmission via NMDA receptor antagonism and GABAA receptor potentiation \u2014 similar to alcohol intoxication. Effects progress from mild euphoria and impaired judgment to hallucinations, confusion, and eventually unconsciousness. Unlike DCS, narcosis is immediately reversible on ascent, but an unconscious diver at depth will drown.',
        prevention: [
            'Use trimix (helium-enriched gas) for deep dives \u2014 helium has no narcotic effect',
            'Monitor the NARC warning and END (Equivalent Narcotic Depth) on your dive computer',
            'Watch for narcosis visual symptoms: tunnel vision, color desaturation, screen wobble',
            'Ascend immediately if you notice impaired control response',
            'On air, narcosis becomes significant below 30m and dangerous below 60m',
            'Most training agencies recommend a maximum depth of 40m on air'
        ]
    }
};

// TASK-017: Multi-tank system + Gas presets with He
const MAX_TANKS = 6;

const GAS_PRESETS = [
    { name: 'Air',         fO2: 0.21, fHe: 0.00 },
    { name: 'EAN28',       fO2: 0.28, fHe: 0.00 },
    { name: 'EAN32',       fO2: 0.32, fHe: 0.00 },
    { name: 'EAN36',       fO2: 0.36, fHe: 0.00 },
    { name: 'Tx 21/35',    fO2: 0.21, fHe: 0.35 },
    { name: 'Tx 18/45',    fO2: 0.18, fHe: 0.45 },
    { name: 'Tx 15/55',    fO2: 0.15, fHe: 0.55 },
    { name: 'Hx 21/79',    fO2: 0.21, fHe: 0.79 }
];

// ============================================================
//  Issue #45: Scenario drills — scriptable, opt-in didactic incidents
// ============================================================
// A drill is a scriptable emergency management scenario that pauses the
// dive at a "what would you do now?" decision point instead of the fatal
// game-over screen. Framework tuning constants below; the DRILLS catalog
// (id, precondition, text keys, options with correct/effect, debrief keys)
// lives further down together with the string table so both are edited in
// lock-step.
//
// All drills use ONLY mechanics that already exist elsewhere in the
// simulator (torch on/off, silt visibility, effectiveAMV multiplier,
// tank drain, scrubberFailed / co2BuildupTime, onBailout, barotraumaTime).
// No new physics.
const DRILL_MIN_DIVETIME_MIN            = 3;    // earliest firing point (dive-minutes)
const DRILL_MAX_DIVETIME_MIN            = 15;   // latest firing point (dive-minutes)
const DRILL_MIN_DEPTH_M                 = 8;    // depth floor: no drill in the last few metres
const DRILL_TRIGGER_PROB_PER_SEC        = 0.03; // per real-second Bernoulli chance while eligible
const DRILL_DEBRIEF_DURATION_SEC        = 5;    // real-seconds a debrief card auto-dismisses after
const DRILL_LIGHT_FLICKER_SEC           = 2;    // torch flicker duration before overlay appears
const DRILL_LIGHT_DARK_SEC              = 8;    // dark period after correct "backup light" answer
const DRILL_LIGHT_WRONG_VIS             = 0.15; // visibility floor forced by "swim fast" wrong option
const DRILL_FREEFLOW_MULT               = 6;    // consumption multiplier for a free-flowing regulator
const DRILL_FREEFLOW_DURATION_SEC       = 45;   // dive-seconds the free-flow lasts

// SECTION: i18n string tables (EN/DE)
// SEARCH TERMS: STRINGS, S(), currentLang, EN, DE, language

// ============================================================
//  i18n — WP-013: Language strings
// ============================================================

let currentLang = 'en';
function S(key) { return STRINGS[currentLang][key]; }

const STRINGS = {
  en: {
    // Gas Setup
    gasSetupTitle: 'GAS SETUP',
    o2Hint: '\u25C4 \u25BA arrows to adjust O\u2082',
    heHint: '\u25B2 \u25BC arrows to adjust He',
    pressure: 'Pressure',
    pressureHint: 'PgUp / PgDn to adjust (10 bar)',
    amvLabel: 'AMV',
    amvHint: '[ / ] to adjust (8-25 L/min)',
    tankSizeLabel: 'Tank',
    tankSizeHint: ', / . to adjust (6-24 L)',
    gfLowLabel: 'GF Low',
    gfHighLabel: 'GF High',
    gfHint: 'G / Shift+G to adjust GF Low \u00B15   F / Shift+F to adjust GF High \u00B15',
    presetsBasic: '[1] Air  [2] EAN28  [3] EAN32  [4] EAN36',
    presetsAdv1: '[1] Air  [2] EAN28  [3] EAN32  [4] EAN36',
    presetsAdv2: '[5] Tx21/35  [6] Tx18/45  [7] Tx15/55  [8] Hx21/79',
    ctrlAdv: '[TAB] cycle tanks  [+/-] add/remove tank  [1-8] presets  [/] AMV  [,/.] tank size  [M] Mode (Rec/Tec/CCR)',
    ctrlBasic: '[1-4] gas presets  [M] Mode (Rec/Tec/CCR)',
    startDive: 'Start Dive',
    langToggle: '[L] Language: English',
    // Issue #67: non-blocking resume-dive banner (replaces blocking confirm())
    resumeBannerText: 'A saved dive was found. Resume?',
    resumeBannerYes: 'Resume',
    resumeBannerDiscard: 'Discard',
    // Surface
    surfaceDescend: 'Press S to vent & descend',
    surfaceLoaded: 'loaded',
    surfaceHints: 'W/S inflate/vent BCD',
    surfaceTankHint: 'switch tank',
    surfaceHelp: 'H help',
    surfaceGasInfo: 'I gas info',
    // Game Over
    gameOver: 'GAME OVER',
    whatHappened: 'WHAT HAPPENED:',
    medicalLabel: 'MEDICAL:',
    howToAvoid: 'HOW TO AVOID:',
    diveTimeLbl: 'Dive Time',
    maxDepthLbl: 'Max Depth',
    tryAgain: 'Press ENTER to try again',
    // Overhead-environment warning (wreck / cave)
    overheadDangerTitle: 'OVERHEAD ENVIRONMENT',
    overheadDanger: 'You died in an overhead environment with no direct route to the surface. Wrecks and caves are among the most dangerous diving there is: silt-outs, entanglement, lost guideline and gas mismanagement kill quickly when you cannot simply ascend. Never enter overhead without specialised training, a continuous guideline to open water, and the rule of thirds for gas.',
    // Post-Dive
    diveComplete: 'DIVE COMPLETE',
    avgDepthLbl: 'Avg Depth',
    gasUsed: 'used',
    safetySkipped: '\u26A0 SAFETY STOP SKIPPED',
    safetyExpl: [
      'A safety stop helps off-gas dissolved nitrogen and reduces',
      'the risk of decompression sickness. While not mandatory for',
      'recreational no-deco dives, skipping it significantly increases',
      'the chance of subclinical bubble formation and DCS symptoms.',
      'Always perform your safety stop \u2014 it only takes a few minutes.'
    ],
    tissueLoading: 'Tissue Compartment Loading (N\u2082 + He)',
    diveAgain: 'Press ENTER to dive again',
    // Help
    helpTitle: 'DIVE COMPUTER GUIDE',
    helpClose: 'Press H, ?, or ESC to close',
    controlsTitle: 'CONTROLS',
    controlsText: 'W = inflate BCD (ascend), S = vent BCD (descend). A / D = fin kick left / right (horizontal swim). T = toggle torch (cave/wreck). F = fast-forward at a deco/safety stop. 1-6 = switch tank. I = gas info (Tec/CCR). H or ? = this help. ESC = close overlay. Buoyancy changes depth gradually \u2014 do NOT over-inflate near the surface or a runaway ascent can cause lung barotrauma. CCR (in dive): [ / ] = Setpoint \u00B10.1, B = Bailout (OC). Dive mode (Rec/Tec/CCR) and dive site (Shore/Reef/Wreck/Cave) are chosen on the gas-setup screen.',
    helpDepth: 'Current depth in meters. The large central number on the dive computer. Camera follows diver vertically.',
    helpNDL: 'Minutes you can stay at current depth without needing decompression stops. Green = safe. Yellow <15min. Red <5min. "---" = unlimited.',
    helpDeco: 'When NDL reaches 0, you have a decompression obligation. CEIL shows the shallowest safe depth. STOP shows where to pause. You MUST complete deco stops before surfacing or risk DCS.',
    helpPO2: 'Oxygen pressure = fO2 \u00D7 ambient pressure. Green <1.0, Yellow 1.0-1.4, Orange 1.4-1.6, Red >1.6 (toxic). Stay below MOD!',
    helpGTR: 'Minutes of gas left at current depth and consumption rate. Green >30min, Yellow 10-30, Red <10. Plan your ascent before it runs low.',
    helpAMV: 'Your breathing rate at surface pressure (default 15 L/min, adjustable 8-25 in gas setup). Actual consumption = AMV \u00D7 ambient pressure. Example: AMV 20 at 40m = 20 \u00D7 5.0 = 100 L/min actual.',
    helpAscent: 'Vertical bar on the left edge of the dive computer. Green <6m/min (safe), Yellow 6-9 (caution), Red >9 (dangerous). Screen flashes red above 9m/min. >18m/min causes lung barotrauma!',
    helpSafety: 'Activates when max depth exceeds 11m. Countdown starts when ascending through 6m. Counts down in the 2.4\u20138.3m range (3 min standard, 5 min if NDL dropped below 5). Resets if you descend back below 11m. Advisory for recreational no-deco dives.',
    helpBest: 'Shows which tank has the optimal gas for current depth (highest O2 where PO2 \u2264 1.4). "\u2713" = you\'re on it. Flashing "T{n}" = switch recommended.',
    helpTank: 'Shows remaining gas. Green >100bar, Yellow 50-100, Red <50. Multi-tank: dots show all tanks (\u25CF=has gas, \u25CB=empty). Keys 1-6 switch tanks.',
    helpTTS: 'Total time needed to reach surface including all deco stops and ascent time. Only shown when in decompression.',
    helpFF: 'Press F to toggle fast-forward through deco/safety stops at 10x speed. Only works when at the correct stop depth. Disengages when you move or leave the stop zone.',
    // Warnings
    warnLowGas: '\u26A0 LOW GAS',
    warnReserve: '\u26A0 GAS RESERVE',
    warnLowNDL: '\u26A0 LOW NDL',
    warnO2: '\u26A0 O2 TOXICITY RISK',
    warnSlow: '\u26A0 SLOW DOWN',
    warnCeiling: '\u26A0 ABOVE CEILING \u2014 DESCEND',
    warnNarc: '\u26A0 NARCOSIS',
    helpNarc: 'Nitrogen narcosis impairs brain function at depth. The \u26A0 NARCOSIS warning appears when narcotic partial pressure is high. Symptoms: tunnel vision (vignette), colour desaturation, screen wobble, delayed controls, random drift. Use trimix (helium) to reduce narcosis. END (Equivalent Narcotic Depth) shows the air-equivalent depth for narcotic effect. Ascending reverses narcosis, but with a short delay.',
    helpTec: 'Tec (Technical) mode unlocks advanced features: up to 6 tanks with different gas mixes (Trimix, Heliox), configurable gradient factors (GF Low/High), AMV adjustment, and tank size selection. Use TAB to cycle tanks in gas setup, +/\u2212 to add/remove tanks. During the dive, press 1\u20136 to switch tanks. Plan your gas switches based on MOD \u2014 the dive computer shows the BEST gas indicator when a better tank is available. Trimix reduces narcosis and O2 toxicity risk for deep dives.',
    helpCcr: 'CCR (Closed Circuit Rebreather) mode simulates a rebreather with electronic PO2 control. The unit maintains a target setpoint (SP) by injecting O2 from a small cylinder. You breathe from a loop \u2014 exhaled CO2 is removed by a scrubber. Gas consumption is minimal compared to OC. Adjust setpoint with [ / ] keys (\u00B10.1 bar). Monitor: actual PO2, O2 cylinder pressure, diluent cylinder pressure, and scrubber time remaining. Failures: scrubber exhaustion causes CO2 buildup, O2 depletion causes hypoxia, high SP causes hyperoxia. Press B for bailout (irreversible switch to open-circuit using diluent).',
    // Game over reasons (display text)
    gameOverReasons: {
      'OUT OF GAS': 'OUT OF GAS',
      'O2 TOXICITY \u2014 CNS SEIZURE': 'O2 TOXICITY \u2014 CNS SEIZURE',
      'DECOMPRESSION SICKNESS': 'DECOMPRESSION SICKNESS',
      'PULMONARY BAROTRAUMA \u2014 PNEUMOTHORAX': 'PULMONARY BAROTRAUMA \u2014 PNEUMOTHORAX',
      'HYPOXIA \u2014 LOSS OF CONSCIOUSNESS': 'HYPOXIA \u2014 LOSS OF CONSCIOUSNESS',
      'NITROGEN NARCOSIS \u2014 UNCONSCIOUSNESS': 'NITROGEN NARCOSIS \u2014 UNCONSCIOUSNESS',
      'SHARK ATTACK': 'SHARK ATTACK'
    },
    // WP-029: Dive mode strings
    modeRec: 'Rec',
    modeTec: 'Tec',
    modeCcr: 'CCR',
    modeCcrPlaceholder: 'CCR Mode \u2014 Coming Soon',
    modeLabel: 'Mode',
    // Dive site names + torch
    siteShore: 'Shore',
    siteReef: 'Reef',
    siteWreck: 'Wreck',
    siteCave: 'Cave',
    torchLabel: 'TORCH',
    switchDepthLabel: 'Switch Depth',
    minDepthLabel: 'Min Depth',
    // TASK-031D: Gas info overlay strings
    gasInfoTitle: 'Gas Inventory',
    gasInfoBest: 'BEST',
    gasInfoPressure: 'P',
    gasInfoMOD: 'MOD',
    gasInfoMinDepth: 'Min',
    gasInfoSwitchDepth: 'Switch',
    gasInfoClose: 'close',
    // TASK-032A: CCR strings
    ccrO2Cyl: 'O\u2082 Cylinder',
    ccrDilCyl: 'Diluent Cylinder',
    ccrDiluent: 'Diluent',
    ccrSetpoint: 'Setpoint',
    ccrScrubber: 'Scrubber',
    ccrDilAir: 'Air',
    ccrDilTmx2135: 'Tmx 21/35',
    ccrDilTmx1545: 'Tmx 15/45',
    ccrDilTmx1070: 'Tmx 10/70',
    ccrDilHeliox: 'Hx 10/90',
    ccrHypoxia: 'HYPOXIA \u2014 O\u2082 TOO LOW',
    ccrHyperoxia: 'O\u2082 TOXICITY \u2014 PO\u2082 TOO HIGH',
    ccrCO2: 'CO\u2082 POISONING \u2014 SCRUBBER EXHAUSTED',
    ccrBailout: 'BAILOUT',
    // Issue #38: contextual onboarding hint toasts (edge-triggered, one-time)
    hintBcd: 'W/S control BCD buoyancy \u2014 short bursts, then trim out',
    hintNdl: 'NDL dropping: deco obligation soon \u2014 go shallower or plan your ascent',
    hintSafetyStop: 'Safety stop: hold 3\u20135 min between 2.4\u20138.3m, F = fast-forward',
    hintDeco: 'Deco ceiling: don\u2019t ascend above the CEIL depth!',
    hintOverhead: 'Overhead: the guideline marks the way back, T = torch',
    hintCurrent: 'Current! Swim against it with A/D',
    hintDismissBtn: 'Don\u2019t show hints again',
    // Issue #46: Instructor overlay (\u201cLearn\u201d mode). All strings the
    // panel prints come from here so a language switch mid-dive updates the
    // overlay on the next frame. Keep every subtext single-line \u2014 the
    // panel is deliberately narrow (230px) and rows are laid out on a fixed
    // vertical stride, not word-wrapped.
    instructorTitle:      'PHYSICS LIVE',
    instructorPressureRow: 'Ambient pressure',
    instructorPressureFormula: 'P = 1 + depth/10 bar',
    instructorBcdRow:      'BCD (Boyle\u2019s law)',
    instructorBcdFormula:  'same gas \u2192 double pressure = half volume',
    instructorBcdSurf:     'surface-equiv',
    instructorBcdEff:      'effective now',
    instructorBubbleRow:   'Bubble expansion',
    instructorBubbleFormula: 'r_now = r_emit \u00d7 (P_emit / P_now)^(1/3)',
    instructorBubbleNone:  'no bubble in flight yet',
    instructorTissueRow:   'Leading tissue',
    instructorTissueFormula: 'saturation vs. M-value at surface',
    instructorTissueNone:  'compartments still washing in',
    instructorConsRow:     'Gas consumption',
    instructorConsFormula: 'SAC = AMV \u00d7 P (at 30m: 4\u00d7 surface rate)',
    instructorGasRow:      'Current gas',
    instructorGasFormula:  'MOD = (1.4/fO\u2082 \u2212 1) \u00d7 10, END with He',
    instructorHintOff:     '[L] toggle',
    instructorTouchLabel:  'LEARN',
    // Issue #44: Post-dive debriefing labels + hints. {count}/{peak}/{bar}/
    // {ndl}/{stddev} are simple placeholders replaced by gradeDive() in
    // physics.js (no full template engine \u2014 String.prototype.replace only).
    debriefTitle: 'DEBRIEFING',
    gradeLabels: ['Ascent Discipline', 'Safety Stop', 'Gas Reserve', 'Deco Discipline', 'Trim & Buoyancy'],
    gradeNotes: {
      ascentClean:     'Ascent rate stayed within the recommended 9 m/min limit.',
      ascentBad:       'Fast ascent {count}x (peak {peak} m/min). Above 9 m/min, dissolved nitrogen has less time to off-gas \u2014 slower means fewer bubbles.',
      safetyDone:      'Safety stop completed \u2014 well done.',
      safetyNotNeeded: 'Dive was too shallow to need a safety stop.',
      safetySkipped:   'Safety stop skipped. A 3-min pause at 5 m sharply cuts DCS risk on any dive that reached 12 m.',
      gasReserveHit:   'Dropped into the reserve third of your gas inside the overhead. Turn earlier next time \u2014 the reserve is your buffer, not a target.',
      gasThirdsClean:  'Rule-of-thirds respected inside the overhead \u2014 clean gas management.',
      gasEnd:          'Surfaced with {bar} bar. Aim for 50 bar reserve on the boat \u2014 buddy assists and delayed ascents burn gas fast.',
      decoClean:       'Stayed well clear of any deco ceiling.',
      decoNdlClose:    'Cut it very close to the no-deco limit ({ndl} min NDL). Turn shallower earlier to keep a buffer.',
      decoBad:         'Broke the deco ceiling {count}x. Above the ceiling, dissolved gas comes out of solution too fast and bubbles form in tissue.',
      trimNoHold:      'No sustained depth-hold phases in this dive to grade trim.',
      trimReport:      'Depth held to \u00b1{stddev} m stddev during your stops. Aim for \u00b10.5 m \u2014 bobbing wastes gas and stirs silt.'
    },
    debriefStarLabel: 'Rating',
    // Issue #45: Scenario drills — opt-in didactic emergency scenarios.
    // Text keys are consumed by drawDrillOverlay() / drawDrillDebrief();
    // the DRILLS catalog binds each key to a drill id + option index.
    drillsToggleLabel: 'Training Drills',
    drillsToggleHint: 'Occasional scripted incidents with a decision point',
    drillHeader: 'TRAINING DRILL',
    drillPromptFooter: 'Press 1 / 2 / 3 to choose',
    drillDebriefHeader: 'DEBRIEFING',
    drillDebriefCorrect: 'Correct choice',
    drillDebriefWrong: 'Suboptimal choice',
    drillDebriefWhyLabel: 'WHY:',
    drillDebriefRealLabel: 'IN THE REAL WORLD:',
    drillDebriefDismiss: 'Enter to continue',
    drills: {
      lightFailure: {
        title: 'Light Failure',
        text: 'Your primary torch just failed and the passage is dark. You are on the guideline. What do you do?',
        options: [
          'Stop, activate backup light, stay on the guideline',
          'Swim fast toward the exit right now',
          'Ascend to open water'
        ],
        why: 'Stop-Think-Act on a light failure: a backup light and the guideline get you out. Rushing kicks up silt; ascending in a cave hits ceiling.',
        realWorld: 'Cave and technical divers always carry at least two redundant lights and never leave the guideline. Silt-outs and lost lines kill quickly when you cannot simply ascend.'
      },
      freeflow: {
        title: 'Regulator Free-Flow',
        text: 'Your regulator is icing up — gas is free-flowing loudly! You feel it draining fast. What do you do?',
        options: [
          'Breathe through it calmly, initiate ascent/turn',
          'Switch to your backup tank',
          'Hold your breath and cover the regulator'
        ],
        why: 'A free-flowing reg can still be breathed from — a shallow "sipping" technique keeps you alive while you turn the dive. Holding your breath while ascending risks lung barotrauma.',
        realWorld: 'Open-water and technical courses drill breathing from a free-flow so it becomes muscle memory. Redundancy (independent second-stage or bailout tank) is the ultimate answer, but the reg you have keeps working until it runs the tank dry.'
      },
      co2: {
        title: 'CO2 Buildup In The Loop',
        text: 'Loud warning tone: CO2 is building up in the loop — the scrubber is not clearing your exhalations. What do you do?',
        options: [
          'Bail out to open circuit, end the dive',
          'Increase setpoint and continue'
        ],
        why: 'CO2 is not fixed by more O2 — the scrubber sorbs CO2, not the diluent or oxygen supply. Bailout puts you on OC where every exhaled breath leaves your system.',
        realWorld: 'CCR training makes bailout the automatic answer to any scrubber problem. CO2 toxicity impairs judgement fast — every extra minute inside the failing loop reduces your ability to recognise you are in trouble.'
      }
    },
    gameOverInfo: null // set below
  },
  de: {
    // Gas Setup
    gasSetupTitle: 'GASEINSTELLUNG',
    o2Hint: '\u25C4 \u25BA Pfeiltasten f\u00FCr O\u2082',
    heHint: '\u25B2 \u25BC Pfeiltasten f\u00FCr He',
    pressure: 'Druck',
    pressureHint: 'Bild\u2191 / Bild\u2193 zum Anpassen (10 bar)',
    amvLabel: 'AMV',
    amvHint: '[ / ] zum Anpassen (8\u201325 L/min)',
    tankSizeLabel: 'Flasche',
    tankSizeHint: ', / . zum Anpassen (6-24 L)',
    gfLowLabel: 'GF Low',
    gfHighLabel: 'GF High',
    gfHint: 'G / Shift+G f\u00FCr GF Low \u00B15   F / Shift+F f\u00FCr GF High \u00B15',
    presetsBasic: '[1] Air  [2] EAN28  [3] EAN32  [4] EAN36',
    presetsAdv1: '[1] Air  [2] EAN28  [3] EAN32  [4] EAN36',
    presetsAdv2: '[5] Tx21/35  [6] Tx18/45  [7] Tx15/55  [8] Hx21/79',
    ctrlAdv: '[TAB] Flaschen  [+/-] hinzuf\u00FCgen/entfernen  [1-8] Presets  [/] AMV  [,/.] Flaschengr\u00F6\u00DFe  [M] Modus (Rec/Tec/CCR)',
    ctrlBasic: '[1-4] Gas-Presets  [M] Modus (Rec/Tec/CCR)',
    startDive: 'Tauchgang starten',
    langToggle: '[L] Sprache: Deutsch',
    // Issue #67: non-blocking resume-dive banner (replaces blocking confirm())
    resumeBannerText: 'Ein gespeicherter Tauchgang wurde gefunden. Fortsetzen?',
    resumeBannerYes: 'Fortsetzen',
    resumeBannerDiscard: 'Verwerfen',
    // Surface
    surfaceDescend: 'S dr\u00FCcken zum Ablassen & Abtauchen',
    surfaceLoaded: 'geladen',
    surfaceHints: 'W/S BCD aufblasen/ablassen',
    surfaceTankHint: 'Flasche wechseln',
    surfaceHelp: 'H Hilfe',
    surfaceGasInfo: 'I Gasinfo',
    // Game Over
    gameOver: 'SPIEL VORBEI',
    whatHappened: 'WAS PASSIERT IST:',
    medicalLabel: 'MEDIZINISCH:',
    howToAvoid: 'SO VERMEIDEST DU ES:',
    diveTimeLbl: 'Tauchzeit',
    maxDepthLbl: 'Max. Tiefe',
    tryAgain: 'ENTER dr\u00FCcken f\u00FCr neuen Versuch',
    // Overhead-Umgebung Warnung (Wrack / H\u00F6hle)
    overheadDangerTitle: '\u00DCBERKOPF-UMGEBUNG',
    overheadDanger: 'Du bist in einer \u00DCberkopf-Umgebung ohne direkten Weg an die Oberfl\u00E4che gestorben. Wracks und H\u00F6hlen geh\u00F6ren zum gef\u00E4hrlichsten Tauchen \u00FCberhaupt: Silt-Out, Verhedderung, verlorene Leine und falsches Gasmanagement t\u00F6ten schnell, wenn man nicht einfach auftauchen kann. Geh nie ohne spezielle Ausbildung, durchgehende Leine ins Freiwasser und die Drittelregel f\u00FCr Gas in eine \u00DCberkopf-Umgebung.',
    // Post-Dive
    diveComplete: 'TAUCHGANG BEENDET',
    avgDepthLbl: 'Durchschn. Tiefe',
    gasUsed: 'verbraucht',
    safetySkipped: '\u26A0 SICHERHEITSSTOPP AUSGELASSEN',
    safetyExpl: [
      'Ein Sicherheitsstopp hilft, gel\u00F6sten Stickstoff abzuatmen und',
      'reduziert das Risiko der Dekompressionskrankheit. Obwohl nicht',
      'vorgeschrieben bei Nullzeit-Tauchg\u00E4ngen, erh\u00F6ht das Auslassen',
      'deutlich die Gefahr subklinischer Blasenbildung und DCS-Symptome.',
      'F\u00FChre immer deinen Sicherheitsstopp durch \u2014 er dauert nur wenige Minuten.'
    ],
    tissueLoading: 'Gewebe-Kompartiment-S\u00E4ttigung (N\u2082 + He)',
    diveAgain: 'ENTER dr\u00FCcken f\u00FCr neuen Tauchgang',
    // Help
    helpTitle: 'TAUCHCOMPUTER-ANLEITUNG',
    helpClose: 'H, ? oder ESC zum Schlie\u00DFen',
    controlsTitle: 'STEUERUNG',
    controlsText: 'W = BCD aufblasen (aufsteigen), S = BCD ablassen (abtauchen). A / D = Flossenschlag links / rechts (horizontal schwimmen). T = Lampe an/aus (H\u00F6hle/Wrack). F = Zeitraffer am Deko-/Sicherheitsstopp. 1-6 = Flasche wechseln. I = Gasinfo (Tec/CCR). H oder ? = diese Hilfe. ESC = Overlay schlie\u00DFen. Auftrieb ver\u00E4ndert die Tiefe graduell \u2014 BCD nahe der Oberfl\u00E4che NICHT \u00FCberf\u00FCllen, sonst kann ein unkontrollierter Aufstieg ein Lungenbarotrauma ausl\u00F6sen. CCR (im Tauchgang): [ / ] = Sollwert \u00B10.1, B = Bailout (OC). Tauchmodus (Rec/Tec/CCR) und Tauchplatz (Ufer/Riff/Wrack/H\u00F6hle) werden im Gas-Setup gew\u00E4hlt.',
    helpDepth: 'Aktuelle Tiefe in Metern. Die gro\u00DFe zentrale Zahl auf dem Tauchcomputer. Kamera folgt dem Taucher vertikal.',
    helpNDL: 'Minuten, die du auf aktueller Tiefe bleiben kannst, ohne Dekompressionsstopps zu ben\u00F6tigen. Gr\u00FCn = sicher. Gelb <15min. Rot <5min. "---" = unbegrenzt.',
    helpDeco: 'Wenn NDL 0 erreicht, hast du eine Dekompressionspflicht. CEIL zeigt die flachste sichere Tiefe. STOP zeigt, wo du anhalten musst. Du MUSST Deko-Stopps vor dem Auftauchen absolvieren, sonst riskierst du DCS.',
    helpPO2: 'Sauerstoffdruck = fO2 \u00D7 Umgebungsdruck. Gr\u00FCn <1,0, Gelb 1,0-1,4, Orange 1,4-1,6, Rot >1,6 (toxisch). Unter MOD bleiben!',
    helpGTR: 'Verbleibende Gasminuten bei aktueller Tiefe und Verbrauchsrate. Gr\u00FCn >30min, Gelb 10-30, Rot <10. Plane deinen Aufstieg, bevor es knapp wird.',
    helpAMV: 'Deine Atemrate bei Oberfl\u00E4chendruck (Standard 15 L/min, einstellbar 8-25 im Gas-Setup). Tats\u00E4chlicher Verbrauch = AMV \u00D7 Umgebungsdruck. Beispiel: AMV 20 auf 40m = 20 \u00D7 5,0 = 100 L/min tats\u00E4chlich.',
    helpAscent: 'Vertikaler Balken am linken Rand des Tauchcomputers. Gr\u00FCn <6m/min (sicher), Gelb 6-9 (Vorsicht), Rot >9 (gef\u00E4hrlich). Bildschirm blinkt rot \u00FCber 9m/min. >18m/min verursacht Lungenbarotrauma!',
    helpSafety: 'Aktiviert sich wenn Max-Tiefe 11m \u00FCberschreitet. Countdown startet beim Aufstieg durch 6m. Z\u00E4hlt im 2,4\u20138,3m Bereich (3 Min Standard, 5 Min wenn NDL unter 5 fiel). Reset bei R\u00FCckkehr unter 11m. Empfehlung f\u00FCr Sporttauchg\u00E4nge.',
    helpBest: 'Zeigt welche Flasche das optimale Gas f\u00FCr die aktuelle Tiefe hat (h\u00F6chster O2-Anteil bei PO2 \u2264 1,4). "\u2713" = du atmest es. Blinkend "T{n}" = Wechsel empfohlen.',
    helpTank: 'Zeigt verbleibendes Gas. Gr\u00FCn >100bar, Gelb 50-100, Rot <50. Multi-Flaschen: Punkte zeigen alle Flaschen (\u25CF=hat Gas, \u25CB=leer). Tasten 1-6 wechseln Flaschen.',
    helpTTS: 'Gesamtzeit bis zur Oberfl\u00E4che inklusive aller Deko-Stopps und Aufstiegszeit. Wird nur bei Dekompression angezeigt.',
    helpFF: 'F gedr\u00FCckt halten um Deko-/Sicherheitsstopps mit 10-facher Geschwindigkeit zu beschleunigen. Funktioniert nur in korrekter Stopptiefe. Stoppt bei Bewegung oder Stoppwechsel.',
    // Warnings
    warnLowGas: '\u26A0 WENIG GAS',
    warnReserve: '\u26A0 GASRESERVE',
    warnLowNDL: '\u26A0 NDL NIEDRIG',
    warnO2: '\u26A0 O2-TOXIZIT\u00C4TSRISIKO',
    warnSlow: '\u26A0 LANGSAMER',
    warnCeiling: '\u26A0 \u00DCBER CEILING \u2014 ABTAUCHEN',
    warnNarc: '\u26A0 NARKOSE',
    helpNarc: 'Stickstoffnarkose beeintr\u00E4chtigt die Hirnfunktion in der Tiefe. Die \u26A0 NARKOSE-Warnung erscheint bei hohem narkotischem Partialdruck. Symptome: Tunnelblick (Vignette), Farbverlust, Bildschirmwackeln, verz\u00F6gerte Steuerung, zuf\u00E4lliges Abdriften. Verwende Trimix (Helium) zur Narkosereduktion. END (Equivalent Narcotic Depth) zeigt die \u00E4quivalente Luft-Tiefe f\u00FCr den narkotischen Effekt. Aufsteigen hebt die Narkose auf, aber mit kurzer Verz\u00F6gerung.',
    helpTec: 'Tec (Technisches Tauchen) schaltet erweiterte Funktionen frei: bis zu 6 Flaschen mit verschiedenen Gasmischungen (Trimix, Heliox), konfigurierbare Gradientenfaktoren (GF Low/High), AMV-Einstellung und Flaschengr\u00F6\u00DFe. TAB zum Wechseln der Flaschen im Gas-Setup, +/\u2212 zum Hinzuf\u00FCgen/Entfernen. W\u00E4hrend des Tauchgangs 1\u20136 zum Flaschenwechsel. Plane deine Gaswechsel anhand der MOD \u2014 der Tauchcomputer zeigt den BEST-Gasindikator wenn eine bessere Flasche verf\u00FCgbar ist. Trimix reduziert Narkose und O2-Toxizit\u00E4tsrisiko bei Tieftauchg\u00E4ngen.',
    helpCcr: 'CCR (Closed Circuit Rebreather) simuliert einen Kreislauftauchger\u00E4t mit elektronischer PO2-Steuerung. Das Ger\u00E4t h\u00E4lt einen Ziel-Sollwert (SP) durch O2-Injektion aus einer kleinen Flasche. Du atmest aus einem Kreislauf \u2014 ausgeatmetes CO2 wird vom Scrubber entfernt. Gasverbrauch ist minimal im Vergleich zu OC. Sollwert mit [ / ] Tasten anpassen (\u00B10,1 bar). \u00DCberwache: tats\u00E4chlichen PO2, O2-Flaschendruck, Diluent-Flaschendruck und Scrubber-Restzeit. Ausf\u00E4lle: Scrubber-Ersch\u00F6pfung verursacht CO2-Aufbau, O2-Mangel verursacht Hypoxie, hoher SP verursacht Hyperoxie. B f\u00FCr Bailout (irreversibler Wechsel zu Open-Circuit mit Diluent).',
    // Game over reasons
    gameOverReasons: {
      'OUT OF GAS': 'KEIN GAS MEHR',
      'O2 TOXICITY \u2014 CNS SEIZURE': 'O2-VERGIFTUNG \u2014 ZNS-KRAMPFANFALL',
      'DECOMPRESSION SICKNESS': 'DEKOMPRESSIONSKRANKHEIT',
      'PULMONARY BAROTRAUMA \u2014 PNEUMOTHORAX': 'LUNGENBAROTRAUMA \u2014 PNEUMOTHORAX',
      'HYPOXIA \u2014 LOSS OF CONSCIOUSNESS': 'HYPOXIE \u2014 BEWUSSTLOSIGKEIT',
      'NITROGEN NARCOSIS \u2014 UNCONSCIOUSNESS': 'STICKSTOFFNARKOSE \u2014 BEWUSSTLOSIGKEIT',
      'SHARK ATTACK': 'HAIANGRIFF'
    },
    // WP-029: Dive mode strings
    modeRec: 'Rec',
    modeTec: 'Tec',
    modeCcr: 'CCR',
    modeCcrPlaceholder: 'CCR-Modus \u2014 Demn\u00E4chst',
    modeLabel: 'Modus',
    // Dive site names + torch
    siteShore: 'Strand',
    siteReef: 'Riff',
    siteWreck: 'Wrack',
    siteCave: 'H\u00F6hle',
    torchLabel: 'LAMPE',
    switchDepthLabel: 'Wechseltiefe',
    minDepthLabel: 'Min. Tiefe',
    // TASK-031D: Gas info overlay strings
    gasInfoTitle: 'Gasbestand',
    gasInfoBest: 'BESTE',
    gasInfoPressure: 'D',
    gasInfoMOD: 'MOD',
    gasInfoMinDepth: 'Min',
    gasInfoSwitchDepth: 'Wechsel',
    gasInfoClose: 'schließen',
    // TASK-032A: CCR strings
    ccrO2Cyl: 'O\u2082-Flasche',
    ccrDilCyl: 'Diluent-Flasche',
    ccrDiluent: 'Diluent',
    ccrSetpoint: 'Sollwert',
    ccrScrubber: 'Scrubber',
    ccrDilAir: 'Luft',
    ccrDilTmx2135: 'Tmx 21/35',
    ccrDilTmx1545: 'Tmx 15/45',
    ccrDilTmx1070: 'Tmx 10/70',
    ccrDilHeliox: 'Hx 10/90',
    ccrHypoxia: 'HYPOXIE \u2014 O\u2082 ZU NIEDRIG',
    ccrHyperoxia: 'O\u2082-TOXIZIT\u00C4T \u2014 PO\u2082 ZU HOCH',
    ccrCO2: 'CO\u2082-VERGIFTUNG \u2014 SCRUBBER ERSCH\u00D6PFT',
    ccrBailout: 'NOTFALL-OC',
    // Issue #38: kontextuelle Onboarding-Hinweise (Edge-getriggert, einmalig)
    hintBcd: 'W/S steuern die Tarierweste \u2014 kurze St\u00F6\u00DFe, dann austrimmen',
    hintNdl: 'NDL sinkt: bald Deko-Pflicht \u2014 flacher gehen oder Aufstieg planen',
    hintSafetyStop: 'Sicherheitsstopp: 3\u20135 min zwischen 2,4\u20138,3m halten, F = Zeitraffer',
    hintDeco: 'Deko-Ceiling: nicht \u00FCber die CEIL-Tiefe aufsteigen!',
    hintOverhead: '\u00DCberkopf: die Leine markiert den R\u00FCckweg, T = Lampe',
    hintCurrent: 'Str\u00F6mung! Mit A/D dagegen anschwimmen',
    hintDismissBtn: 'Hinweise nicht mehr anzeigen',
    // Issue #46: Instruktor-Overlay („Lern"-Modus). Alle Strings, die das
    // Panel anzeigt, kommen hier her; ein Sprachwechsel während des
    // Tauchgangs aktualisiert das Overlay im nächsten Frame. Jeder
    // Untertitel bleibt einzeilig — das Panel ist bewusst schmal (230px)
    // und Zeilen werden auf einem festen vertikalen Raster ausgelegt.
    instructorTitle:      'PHYSIK LIVE',
    instructorPressureRow: 'Umgebungsdruck',
    instructorPressureFormula: 'P = 1 + Tiefe/10 bar',
    instructorBcdRow:      'Tarierweste (Gesetz von Boyle)',
    instructorBcdFormula:  'gleiche Gasmenge → doppelter Druck = halbes Volumen',
    instructorBcdSurf:     'Oberflächen-äquiv.',
    instructorBcdEff:      'effektiv jetzt',
    instructorBubbleRow:   'Blasenexpansion',
    instructorBubbleFormula: 'r_jetzt = r_emit × (P_emit / P_jetzt)^(1/3)',
    instructorBubbleNone:  'noch keine Blase unterwegs',
    instructorTissueRow:   'Führendes Gewebe',
    instructorTissueFormula: 'Sättigung vs. M-Wert an Oberfläche',
    instructorTissueNone:  'Kompartimente sättigen noch',
    instructorConsRow:     'Gasverbrauch',
    instructorConsFormula: 'SAC = AMV × P (auf 30m: 4× Oberflächenrate)',
    instructorGasRow:      'Aktuelles Gas',
    instructorGasFormula:  'MOD = (1,4/fO₂ − 1) × 10, END mit He',
    instructorHintOff:     '[L] umschalten',
    instructorTouchLabel:  'LERN',
    // Issue #44: Post-Dive-Debriefing — Labels + Hinweise (mirrors EN keys).
    debriefTitle: 'AUSWERTUNG',
    gradeLabels: ['Aufstiegsdisziplin', 'Sicherheitsstopp', 'Gasreserve', 'Dekodisziplin', 'Trimm & Tarierung'],
    gradeNotes: {
      ascentClean:     'Aufstiegsrate blieb im empfohlenen Rahmen bis 9 m/min.',
      ascentBad:       '{count}x zu schnell aufgestiegen (Spitze {peak} m/min). Über 9 m/min hat gelöster Stickstoff weniger Zeit zum Abatmen — langsamer aufsteigen, weniger Blasen.',
      safetyDone:      'Sicherheitsstopp absolviert — sehr gut.',
      safetyNotNeeded: 'Tauchgang war zu flach für einen Sicherheitsstopp.',
      safetySkipped:   'Sicherheitsstopp ausgelassen. 3 Min auf 5 m senken das DCS-Risiko deutlich, sobald der Tauchgang über 12 m ging.',
      gasReserveHit:   'In die Reserve-Drittel im Überkopf abgesunken. Umkehrpunkt früher setzen — die Reserve ist Puffer, kein Ziel.',
      gasThirdsClean:  'Drittelregel im Überkopf eingehalten — sauberes Gasmanagement.',
      gasEnd:          'Mit {bar} bar aufgetaucht. Ziel: mindestens 50 bar Reserve am Boot — Buddy-Hilfe und verzögerte Aufstiege verbrauchen schnell Gas.',
      decoClean:       'Deckenhöhe sicher eingehalten.',
      decoNdlClose:    'Sehr knapp an die Nullzeitgrenze ({ndl} min NDL) gegangen. Früher flacher werden, mehr Puffer lassen.',
      decoBad:         '{count}x die Deko-Decke gerissen. Über der Decke perlt gelöstes Gas zu schnell aus und bildet Blasen im Gewebe.',
      trimNoHold:      'Keine ausreichenden Halte-Phasen im Tauchgang, um die Tarierung zu bewerten.',
      trimReport:      'Tiefe auf ±{stddev} m Streuung gehalten. Ziel: ±0,5 m — Auf-und-ab verbraucht Gas und wirbelt Silt auf.'
    },
    debriefStarLabel: 'Bewertung',
    // Issue #45: Szenario-Drills (spiegelt EN-Schlüssel)
    drillsToggleLabel: 'Trainings-Drills',
    drillsToggleHint: 'Vereinzelte Zwischenfälle mit Entscheidungsmoment',
    drillHeader: 'TRAININGS-DRILL',
    drillPromptFooter: '1 / 2 / 3 drücken zum Wählen',
    drillDebriefHeader: 'AUSWERTUNG',
    drillDebriefCorrect: 'Richtige Entscheidung',
    drillDebriefWrong: 'Suboptimale Entscheidung',
    drillDebriefWhyLabel: 'WARUM:',
    drillDebriefRealLabel: 'IN DER PRAXIS:',
    drillDebriefDismiss: 'Enter zum Fortfahren',
    drills: {
      lightFailure: {
        title: 'Lampenausfall',
        text: 'Deine Hauptlampe ist gerade ausgefallen und der Gang ist dunkel. Du bist an der Leine. Was tust du?',
        options: [
          'Stop, Backup-Lampe aktivieren, an der Leine bleiben',
          'Sofort schnell Richtung Ausgang schwimmen',
          'Ins Freiwasser aufsteigen'
        ],
        why: 'Stop-Think-Act bei Lampenausfall: Backup-Lampe und Leine bringen dich raus. Hektik wirbelt Silt auf; in der Höhle aufsteigen stößt an die Decke.',
        realWorld: 'Höhlen- und Tec-Taucher führen immer mindestens zwei redundante Lampen und verlassen nie die Leine. Silt-Out und verlorene Leine töten schnell, wenn du nicht einfach auftauchen kannst.'
      },
      freeflow: {
        title: 'Vereister Automat',
        text: 'Dein Automat friert ein — das Gas strömt laut ab! Du spürst, wie es schnell weniger wird. Was tust du?',
        options: [
          'Ruhig weiteratmen, Aufstieg/Umkehr einleiten',
          'Auf die Backup-Flasche wechseln',
          'Luft anhalten und Automat abdecken'
        ],
        why: 'Ein blasender Automat kann noch geatmet werden — "sippen" hält dich am Leben, während du den Tauchgang beendest. Luft anhalten beim Aufsteigen riskiert ein Lungenbarotrauma.',
        realWorld: 'OWD- und Tec-Kurse drillen das Atmen aus einem Freeflow, damit es Muskelgedächtnis wird. Redundanz (unabhängige zweite Stufe oder Bailout-Flasche) ist die endgültige Antwort, aber der laufende Automat funktioniert bis die Flasche leer ist.'
      },
      co2: {
        title: 'CO2-Aufbau im Kreislauf',
        text: 'Warnton: CO2 baut sich im Kreislauf auf — der Scrubber bindet deine Ausatemluft nicht mehr. Was tust du?',
        options: [
          'Bailout auf Open Circuit, Tauchgang beenden',
          'Sollwert erhöhen und weitertauchen'
        ],
        why: 'CO2 wird nicht durch mehr O2 behoben — der Scrubber bindet CO2, nicht Diluent oder Sauerstoff. Bailout bringt dich auf OC, wo jede Ausatmung dein System verlässt.',
        realWorld: 'Die CCR-Ausbildung macht Bailout zur automatischen Antwort auf jedes Scrubber-Problem. CO2-Vergiftung trübt das Urteilsvermögen rasant — jede zusätzliche Minute im defekten Kreislauf verringert deine Fähigkeit, das überhaupt zu erkennen.'
      }
    },
    gameOverInfo: {
      'OUT OF GAS': {
        cause: 'Alle Flaschen leer \u2014 kein Atemgas mehr vorhanden.',
        medical: 'Ohne Atemgas ist sofortiges Ertrinken die Folge. In der Tiefe kann der Taucher ohne Atemgas nicht sicher zur Oberfl\u00E4che gelangen.',
        prevention: [
          '\u00DCberwache regelm\u00E4\u00DFig Flaschendruck und GTR (verbleibende Gaszeit)',
          'Plane deinen Umkehrdruck \u2014 beginne den Aufstieg bei 1/3 des Gesamtgases',
          'In der Tiefe wird Gas durch erh\u00F6hten Umgebungsdruck viel schneller verbraucht',
          'F\u00FChre eine Reserveflasche als Bailout-Gas mit'
        ]
      },
      'O2 TOXICITY \u2014 CNS SEIZURE': {
        cause: 'Sauerstoff-Partialdruck (PO2) \u00FCberschritt 1,6 bar f\u00FCr mehr als 30 Sekunden.',
        medical: 'ZNS-Sauerstofftoxizit\u00E4t verursacht Kr\u00E4mpfe, Bewusstlosigkeit und Ertrinken. Sie tritt auf, wenn der Sauerstoff-Partialdruck sichere Grenzen \u00FCberschreitet, typisch \u00FCber 1,6 bar.',
        prevention: [
          '\u00DCberschreite niemals die maximale Einsatztiefe (MOD) deines Gasgemischs',
          'Wechsle beim Abtauchen zu einem Gas mit niedrigerem O2-Anteil',
          'Verwende Trimix oder Heliox f\u00FCr tiefe Tauchg\u00E4nge, um PO2 im sicheren Bereich zu halten',
          '\u00DCberwache die PO2-Anzeige \u2014 Orange/Rot bedeutet Gefahr'
        ]
      },
      'DECOMPRESSION SICKNESS': {
        cause: '\u00DCber das Deko-Ceiling aufgestiegen oder mit \u00FCbersch\u00FCssigem gel\u00F6stem Inertgas aufgetaucht. Stickstoff und/oder Helium bildeten Blasen im Gewebe.',
        medical: 'DCS (\u201ETaucherkrankheit\u201C) entsteht, wenn gel\u00F6stes Inertgas als Blasen in Blut und Gewebe austritt. Symptome reichen von Gelenkschmerzen und Hautausschlag bis zu L\u00E4hmung, Schlaganfall und Tod.',
        prevention: [
          'Steige niemals \u00FCber deine Ceiling-Tiefe auf \u2014 beachte den CEIL-Indikator',
          'Absolviere ALLE erforderlichen Dekompressionsstopps vor dem Auftauchen',
          'Steige langsam auf (empfohlen max. 9m/min)',
          'Mache immer einen 3-Minuten-Sicherheitsstopp auf 5m',
          'Bleibe innerhalb der NDL-Grenzen f\u00FCr Sporttauchen'
        ]
      },
      'PULMONARY BAROTRAUMA \u2014 PNEUMOTHORAX': {
        cause: 'Zu schneller Aufstieg verursachte Lungen\u00FCberdehnung durch Gasausdehnung nach dem Boyle-Gesetz.',
        medical: 'Schneller Aufstieg bewirkt, dass Luft in der Lunge expandiert. Dies kann Lungengewebe (Alveolen) zerrei\u00DFen und Pneumothorax, arterielle Gasembolie oder Mediastinalemphysem verursachen. Kann selbst in flachem Wasser t\u00F6dlich sein.',
        prevention: [
          'Steige niemals schneller als 9\u201310 m/min auf',
          'Beachte die Aufstiegsratenanzeige \u2014 halte sie gr\u00FCn',
          'Lasse die W-Taste periodisch los, um den Aufstieg zu verlangsamen',
          'Beim echten Tauchen: Halte niemals beim Aufstieg die Luft an'
        ]
      },
      'HYPOXIA \u2014 LOSS OF CONSCIOUSNESS': {
        cause: 'Sauerstoff-Partialdruck (PO2) fiel unter 0,16 bar \u2014 unzureichend Sauerstoff f\u00FCr Bewusstsein.',
        medical: 'Hypoxie verursacht Bewusstlosigkeit ohne Vorwarnung. Anders als bei hohem PO2 gibt niedriger PO2 keine Symptome vor der Ohnmacht. Das Gehirn ben\u00F6tigt einen Mindest-PO2 von ca. 0,16 bar.',
        prevention: [
          'Atme niemals ein hypoxisches Gemisch (niedriger O2%) in geringer Tiefe',
          'Pr\u00FCfe MOD UND Mindesteinsatztiefe deines Gases vor dem Wechsel',
          'Reisemischungen mit <18% O2 nur unterhalb ihrer Mindesttiefe atmen',
          'Trimix mit 15% O2 wird \u00FCber ca. 3m hypoxisch'
        ]
      },
      'SHARK ATTACK': {
        cause: 'Ein Hai hat entschieden, dass du wie ein Mittagessen aussiehst.',
        medical: 'Haie greifen selten Taucher an, aber wenn, ist es unvergesslich. Dies war ein besonders hungriger Hai.',
        prevention: [
          'Sei jederzeit aufmerksam auf deine Umgebung',
          'Meide Gebiete mit aggressiven Haiarten',
          'Trage keine blutenden Fische oder gl\u00E4nzende Gegenst\u00E4nde'
        ]
      },
      'NITROGEN NARCOSIS \u2014 UNCONSCIOUSNESS': {
        cause: 'Der narkotische Partialdruck \u00FCberschritt die sicheren Grenzen zu lange und verursachte Bewusstlosigkeit in der Tiefe.',
        medical: 'Stickstoffnarkose tritt auf, wenn Stickstoff unter erh\u00F6htem Partialdruck bei tiefen Tauchg\u00E4ngen geatmet wird. Stickstoff st\u00F6rt die neuronale \u00DCbertragung \u2014 \u00E4hnlich wie Alkoholvergiftung. Die Wirkung reicht von leichter Euphorie und Urteilsschw\u00E4che bis zu Halluzinationen, Verwirrung und Bewusstlosigkeit. Anders als DCS ist Narkose beim Aufstieg sofort reversibel, aber ein bewusstloser Taucher in der Tiefe ertrinkt.',
        prevention: [
          'Verwende Trimix (heliumangereichertes Gas) f\u00FCr tiefe Tauchg\u00E4nge \u2014 Helium hat keine narkotische Wirkung',
          '\u00DCberwache die NARC-Warnung und END auf deinem Tauchcomputer',
          'Achte auf Narkose-Symptome: Tunnelblick, Farbverlust, Bildschirmwackeln',
          'Steige sofort auf, wenn du verz\u00F6gerte Steuerung bemerkst',
          'Mit Luft wird Narkose unter 30m sp\u00FCrbar und unter 60m gef\u00E4hrlich',
          'Die meisten Verb\u00E4nde empfehlen eine maximale Lufttiefe von 40m'
        ]
      }
    }
  }
};
// Point English gameOverInfo to the existing GAME_OVER_INFO object
STRINGS.en.gameOverInfo = GAME_OVER_INFO;

// Issue #45: DRILLS catalog — scriptable scenario definitions.
// Each entry:
//   id           — stable string key (also used by gameAPI.forceDrill()).
//   precondition — function(api) -> boolean; determines whether the drill
//                  is eligible in the current dive context. Only preconditions
//                  that read pure "run-time" state (mode, site, tank count,
//                  torch state, alarms) belong here — the framework itself
//                  already gates on drillsEnabled, min dive-time, depth,
//                  and "no active alarm".
//   stringsKey   — key inside STRINGS[lang].drills for text + options + debrief.
//   options      — array of { correct: boolean, effect: function(api) }.
//                  effect() is called synchronously the moment the player
//                  selects the option; it may mutate state (visibility,
//                  scrubberFailed, onBailout, drillState.freeflow*).
//                  Passive effects (e.g. "you'll hit the ceiling on ascent")
//                  are handled by the existing physics — effect() may be a
//                  no-op in that case.
//
// NOTE on file layout: the catalog uses lazy state-reads (site strings via
// activeSite(), tankCount, ccrState fields, torchOn, inOverhead). Those
// symbols only exist at runtime inside the game frames; constants.js loads
// first, so a `precondition` that reads them must do so via the passed api
// (which is `window` inside the game — every game global is either window.x
// directly, or accessed through the standard identifier binding).
const DRILLS = [
    {
        id: 'lightFailure',
        stringsKey: 'lightFailure',
        precondition: function() {
            return inOverhead && torchOn && diveSite === 'cave';
        },
        options: [
            {
                correct: true,
                effect: function() {
                    // Correct: torch stays off, backup light means visibility
                    // stays workable but with a dimmed residual light for 8 s.
                    drillState.lightRestoreAt = diveTime * 60 + DRILL_LIGHT_DARK_SEC;
                }
            },
            {
                correct: false,
                effect: function() {
                    // Swim fast wrong option: silt kicks up hard, light still
                    // returns only after 8 s. Direct visibility drop mirrors
                    // what the silt mechanic would produce over ~2 s of hard
                    // finning near the floor, without requiring the diver to
                    // actually kick during the paused overlay.
                    visibility = Math.min(visibility, DRILL_LIGHT_WRONG_VIS);
                    drillState.lightRestoreAt = diveTime * 60 + DRILL_LIGHT_DARK_SEC;
                }
            },
            {
                correct: false,
                effect: function() {
                    // Ascend wrong option: no drill-side effect. The existing
                    // overhead-ceiling collision + fast-ascent barotrauma
                    // system handles the consequence when the player follows
                    // through with W after the drill closes.
                    drillState.lightRestoreAt = diveTime * 60 + DRILL_LIGHT_DARK_SEC;
                }
            }
        ]
    },
    {
        id: 'freeflow',
        stringsKey: 'freeflow',
        precondition: function() {
            // OC only (CCR uses a different failure mode).
            return diveMode !== 'ccr';
        },
        options: [
            {
                correct: true,
                effect: function() {
                    // Breathe through it: consumption multiplier applied to
                    // the active tank for DRILL_FREEFLOW_DURATION_SEC dive-
                    // seconds. drainingTankIdx === activeTank means "the free-
                    // flowing reg is the one you are breathing from".
                    drillState.freeflowUntilDiveSec = diveTime * 60 + DRILL_FREEFLOW_DURATION_SEC;
                    drillState.freeflowDrainTankIdx = activeTank;
                }
            },
            {
                correct: true,
                // Precondition: option only offered when a second tank exists.
                requiresMultiTank: true,
                effect: function() {
                    // Switch to backup: drain continues on the ORIGINAL tank
                    // (drainTankIdx keeps the pre-switch index) while the
                    // player breathes from the next available tank.
                    var oldIdx = activeTank;
                    var newIdx = -1;
                    for (var i = 0; i < tankCount; i++) {
                        if (i !== oldIdx && tanks[i] && tanks[i].gasRemaining > 0) {
                            newIdx = i;
                            break;
                        }
                    }
                    if (newIdx >= 0) {
                        activeTank = newIdx;
                        gasSwitchNotifyTime = 2;
                        gasSwitchNotifyText = '⚠ DRILL → T' + (newIdx + 1) + ': ' + tanks[newIdx].label;
                    }
                    drillState.freeflowUntilDiveSec = diveTime * 60 + DRILL_FREEFLOW_DURATION_SEC;
                    drillState.freeflowDrainTankIdx = oldIdx;
                }
            },
            {
                correct: false,
                effect: function() {
                    // Hold-breath option: no drill-side mechanic. Barotrauma
                    // physics handles the consequence on the next ascent.
                    // Nothing to schedule.
                }
            }
        ]
    },
    {
        id: 'co2',
        stringsKey: 'co2',
        precondition: function() {
            return diveMode === 'ccr' && !ccrState.onBailout && !ccrState.scrubberFailed;
        },
        onTrigger: function() {
            // Activate the existing scrubber-failure mechanic so the CO2
            // buildup timer starts running BEFORE the player chooses. Reset
            // co2BuildupTime so the drill starts from a clean countdown.
            ccrState.scrubberFailed = true;
            ccrState.co2BuildupTime = 0;
        },
        options: [
            {
                correct: true,
                effect: function() {
                    // Bail out to OC: existing bailout flag stops the loop
                    // update and moves consumption onto the diluent cyl. The
                    // CO2 buildup timer no longer matters because bailout
                    // exhaust leaves the loop.
                    ccrState.onBailout = true;
                    ccrState.co2BuildupTime = 0;
                }
            },
            {
                correct: false,
                effect: function() {
                    // Increase setpoint: the CO2 countdown keeps running. Do
                    // NOT clear scrubberFailed — that IS the lesson.
                    ccrAdjustSP(0.1);
                }
            }
        ]
    }
];