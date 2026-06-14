import globals from "globals";

// All top-level symbols shared across the 8 script files.
// Generated from: grep -hP "^(?:const|var|let|function)\s+(\w+)" src/*.js
const gameGlobals = {
  // i18n
  S: "readonly", STRINGS: "readonly", currentLang: "writable",

  // ZHL-16C tables
  ZHL16C_N2: "readonly", ZHL16C_HE: "readonly",
  INITIAL_N2_LOADING: "readonly", LN2: "readonly",
  SURFACE_PRESSURE: "readonly", P_H2O: "readonly",

  // Tuning constants
  TIME_ACCELERATION: "readonly", FAST_FORWARD_MULTIPLIER: "readonly",
  MAX_ASCENT_RATE: "readonly", MAX_DESCENT_RATE: "readonly",
  MAX_DEPTH: "readonly",

  // Diver physics
  BUOYANCY_PARAMS: "readonly",
  FINKICK_PARAMS: "readonly", CURRENT_PARAMS: "readonly",
  WORLD_MPS: "readonly",
  // Phase C constants (sites.js / constants.js)
  DIVER_RADIUS: "readonly",
  GUIDELINE_MAX_NODES: "readonly", GUIDELINE_SAMPLE_SEC: "readonly",
  SILT_KICK_THRESHOLD: "readonly", SILT_DECAY: "readonly",
  SILT_RECOVER: "readonly", TORCH_RADIUS_M: "readonly",
  BAROTRAUMA_RATE: "readonly", BAROTRAUMA_TIME: "readonly",
  AMV_MIN: "readonly", AMV_MAX: "readonly", AMV_DEFAULT: "readonly",
  TANK_VOL_MIN: "readonly", TANK_VOL_MAX: "readonly", TANK_VOL_DEFAULT: "readonly",
  MAX_TANKS: "readonly",

  // O2 / toxicity thresholds
  PO2_SAFE: "readonly", PO2_ELEVATED: "readonly",
  PO2_HIGH: "readonly", PO2_HYPOXIA: "readonly",
  PO2_TOXICITY_TIME: "readonly", DCS_VIOLATION_TIME: "readonly",

  // Gradient factors
  GF_LOW_DEFAULT: "readonly", GF_LOW_MIN: "readonly", GF_LOW_MAX: "readonly",
  GF_HIGH_DEFAULT: "readonly", GF_HIGH_MIN: "readonly", GF_HIGH_MAX: "readonly",

  // CCR constants
  CCR_DEFAULTS: "readonly", CCR_DIL_PRESETS: "readonly",
  CCR_SP_MIN: "readonly", CCR_SP_MAX: "readonly", CCR_SP_STEP: "readonly",
  CCR_O2_VOL_MIN: "readonly", CCR_O2_VOL_MAX: "readonly",
  CCR_O2_PRES_MIN: "readonly", CCR_O2_PRES_MAX: "readonly", CCR_O2_PRES_STEP: "readonly",
  CCR_DIL_VOL_MIN: "readonly", CCR_DIL_VOL_MAX: "readonly",

  // World / rendering constants
  BUBBLE_RISE_MIN: "readonly", BUBBLE_RISE_MAX: "readonly",
  BUBBLE_RADIUS_MIN: "readonly", BUBBLE_RADIUS_MAX: "readonly",
  BUBBLE_MAX_AGE: "readonly",
  BREATH_CYCLE_INHALE: "readonly", BREATH_CYCLE_EXHALE: "readonly",
  BREATH_CYCLE_PAUSE: "readonly",
  PARTICLE_COUNT: "readonly",
  MAX_FISH: "readonly", FISH_TYPES: "readonly", randomFishInterval: "readonly",
  MAX_WILDLIFE: "readonly", WILDLIFE_TYPES: "readonly",
  NARC_ONSET_BAR: "readonly", NARC_FULL_BAR: "readonly",
  NARC_KO_THRESHOLD: "readonly", NARC_KO_TIME: "readonly",
  NARC_RAMP_UP: "readonly", NARC_RAMP_DOWN: "readonly",
  DEPTH_GRADIENT_MAX: "readonly",
  COLOR_SURFACE_WATER: "readonly", COLOR_DEEP_WATER: "readonly",
  REEF_PAL: "readonly",
  SAVE_KEY: "readonly", SAVE_INTERVAL_MS: "readonly",
  GAME_OVER_INFO: "readonly",
  GAS_PRESETS: "readonly",

  // Canvas
  canvas: "writable", ctx: "writable", resize: "readonly",

  // Input
  keys: "writable",

  // Mutable game state (state.js)
  gameState: "writable", diveMode: "writable",
  depth: "writable", maxDepth: "writable",
  avgDepthAccum: "writable", avgDepthSamples: "writable",
  diveTime: "writable", ascentRate: "writable",
  gameOverReason: "writable",
  tissues: "writable", tissuesHe: "writable",
  cnsPercent: "writable", po2ViolationTime: "writable", dcsViolationTime: "writable",
  safetyStopRemaining: "writable", safetyStopNeeded: "writable",
  safetyStopComplete: "writable", safetyStopCountdownStarted: "writable",
  safetyStopPaused: "writable", ndlDroppedBelow5: "writable",
  tanks: "writable", activeTank: "writable",
  tankCount: "writable", selectedTankTab: "writable", tankVolume: "writable",
  amvRate: "writable", gfLow: "writable", gfHigh: "writable",
  bestGasAlerted: "writable",
  lastDecoStopDepth: "writable",
  diveProfile: "writable", _profileSampleTimer: "writable",
  diver: "writable", verticalVelocity: "writable",
  diverX: "writable", horizontalVelocity: "writable", current: "writable",
  // Phase C state (state.js)
  diveSite: "writable", guidelineNodes: "writable", _guidelineTimer: "writable",
  visibility: "writable", inOverhead: "writable", badAirWarning: "writable",
  thirdsTurnWarned: "writable", thirdsReserveActive: "writable", torchOn: "writable",
  currentVerticalRate: "writable", bcdGasSurfaceLiters: "writable",
  barotraumaTime: "writable", hypoxiaTime: "writable",
  bubbles: "writable", breathPhase: "writable",
  breathTimer: "writable", exhaleEmitted: "writable",
  particles: "writable", waveTime: "writable",
  lastFrameTime: "writable",
  gasSwitchNotifyTime: "writable", gasSwitchNotifyText: "writable",
  fishes: "writable", fishSpawnTimer: "writable",
  wildlife: "writable", wildlifeSpawnTimer: "writable",
  shark: "writable", sharkTimer: "writable",
  narcosisIndex: "writable", narcosisKOTime: "writable", narcDrift: "writable",
  _alertCtx: "writable", _lastAlertTime: "writable",
  fastForwardActive: "writable",
  showHelp: "writable", showGasInfo: "writable",
  _gasInfoShown: "writable", infoPageMode: "writable",
  ccrState: "writable", modeSettings: "writable",
  ccrHypoxiaTime: "writable", ccrHyperoxiaTime: "writable",
  ccrWarningBeepTriggered: "writable",
  _helpShown: "writable", _gsBuilt: "writable", _gsNodes: "writable",
  _realGameLoop: "writable", _lastSaveTime: "writable", _savedDive: "writable",
  isTouchDevice: "writable",

  // Phase C geometry helpers (sites.js)
  DIVE_SITES: "readonly",
  activeSite: "readonly", lerpProfile: "readonly",
  floorAt: "readonly", ceilingAt: "readonly",
  solidAt: "readonly", overheadAt: "readonly", badAirAt: "readonly",

  // Physics functions (physics.js)
  ambientPressure: "readonly", updateTissues: "readonly",
  calculateNDL: "readonly", calculateCeiling: "readonly",
  calculateDecoSchedule: "readonly", calculateTTS: "readonly",
  calculatePO2: "readonly", calculateMOD: "readonly",
  calculateGTR: "readonly", calculateEND: "readonly",
  calculateNarcoticPP: "readonly", calculateMinDepth: "readonly",
  calculateSafetyStopDuration: "readonly",
  combinedAB: "readonly", combinedABSim: "readonly",
  decoStop: "readonly",
  updateCNS: "readonly", updateNarcosis: "readonly",
  updateBuoyancyPhysics: "readonly",
  updateHorizontalPhysics: "readonly", currentVelAt: "readonly",
  updateOverheadState: "readonly",
  inflateBCD: "readonly", ventBCD: "readonly",
  updateCCRDiluent: "readonly", updateCCRLoop: "readonly",
  getCCRInspiredGas: "readonly",

  // State / init functions (state.js)
  resetDive: "readonly", initCCR: "readonly",
  initTissues: "readonly", initParticles: "readonly", initTanks: "readonly",
  createTank: "readonly", gasLabel: "readonly",
  activeGas: "readonly", getActiveTank: "readonly",
  isAdvanced: "readonly", switchMode: "readonly",
  saveModeSettings: "readonly", restoreModeSettings: "readonly",
  restoreDiveState: "readonly",

  // World functions (world.js)
  emitBubbles: "readonly", updateBubbles: "readonly",
  emitBCDBubbles: "readonly", updateBreathCycle: "readonly",
  bubbleDisplayRadius: "readonly",
  spawnFish: "readonly", updateFish: "readonly",
  spawnWildlife: "readonly", updateWildlife: "readonly",
  updateParticles: "readonly",
  _eligibleTypes: "readonly",

  // Renderer functions (renderer.js)
  drawScene: "readonly", drawDiver: "readonly",
  drawDiveComputer: "readonly", drawGasSetup: "readonly",
  drawDiveProfileChart: "readonly", drawPostDive: "readonly",
  drawGameOver: "readonly", drawSurface: "readonly",
  drawFish: "readonly", drawWildlife: "readonly",
  drawHelpOverlay: "readonly", drawWrappedText: "readonly",
  po2Color: "readonly", waterColor: "readonly",
  tankBar: "readonly", tankColor: "readonly",
  smoothstep: "readonly", formatTime: "readonly",
  // Phase C renderer helpers
  drawTerrain: "readonly", drawStructures: "readonly",
  drawFeatures: "readonly", drawSeagrass: "readonly",
  drawWarningSign: "readonly", drawThermocline: "readonly",
  drawCoral: "readonly", drawVehicle: "readonly", drawBuoy: "readonly", drawPond: "readonly",
  drawGuideline: "readonly", drawSiltAndTorch: "readonly",
  drawTableCoral: "readonly", drawBrainCoral: "readonly", drawStaghorn: "readonly",
  drawSoftCoral: "readonly", drawGorgonian: "readonly", drawBarrelSponge: "readonly",
  drawAnthiasCloud: "readonly", drawBlueHaze: "readonly",

  // UI functions (ui.js)
  showHtmlHelp: "readonly", hideHtmlHelp: "readonly",
  showHtmlGasInfo: "readonly", hideHtmlGasInfo: "readonly",
  buildHtmlGasSetup: "readonly", updateGasSetup: "readonly",
  startDiveAction: "readonly",
  gsAdjustO2: "readonly", gsAdjustHe: "readonly",
  gsAdjustPressure: "readonly", gsAdjustTankVol: "readonly",
  gsAdjustAMV: "readonly", gsAdjustGFLow: "readonly", gsAdjustGFHigh: "readonly",
  gsAdjustSwitchDepth: "readonly", gsApplyPreset: "readonly",
  gsAddTank: "readonly", gsRemoveTank: "readonly",
  ccrAdjustSP: "readonly", ccrAdjustDilVol: "readonly",
  ccrAdjustO2Vol: "readonly", ccrAdjustO2Pres: "readonly",
  ccrApplyDilPreset: "readonly", ccrDilPresetName: "readonly",

  // Game loop (game-loop.js)
  effectiveAMV: "readonly",
  updateSurface: "readonly", updateDiving: "readonly",
  gameLoop: "writable",
  saveDiveState: "readonly", loadSavedDive: "readonly",
  maybeSaveDiveState: "readonly", clearSavedDive: "readonly",
  beforeUnloadHandler: "readonly", updateBeforeUnloadGuard: "readonly",
  recommendBestGas: "readonly", bestGasForDepth: "readonly",
  playAlertBeep: "readonly", playInfoTone: "readonly",

  // Touch (touch.js)
  touchUpdateUI: "readonly", updateCcrDiveButtonVisibility: "readonly",
  bindTapPressRelease: "readonly",

  // gameAPI (test harness)
  gameAPI: "writable",

  // Build info (version.js)
  BUILD_VERSION: "readonly",
};

export default [
  {
    files: ["src/*.js"],
    ignores: ["src/version.js"],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: "script",
      globals: {
        ...globals.browser,
        ...gameGlobals,
      },
    },
    rules: {
      // Errors — real bugs
      "no-unreachable": "error",
      "no-duplicate-case": "error",
      "no-constant-condition": ["error", { "checkLoops": false }],
      "no-dupe-keys": "error",
      "no-self-assign": "error",
      "no-sparse-arrays": "error",
      "use-isnan": "error",
      "valid-typeof": "error",
      "no-undef": "error",

      // Warnings — code quality
      "eqeqeq": ["warn", "always", { "null": "ignore" }],
      "no-unused-vars": ["warn", { "vars": "local", "args": "none" }],
      "no-fallthrough": "warn",
    },
  },
];
