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
  PHYSICS_MAX_SUBSTEP_SEC: "readonly",
  MAX_ASCENT_RATE: "readonly", MAX_DESCENT_RATE: "readonly",
  DECO_PLANNING_ASCENT_RATE_MPM: "readonly",
  MAX_DEPTH: "readonly",
  MAX_DEVICE_PIXEL_RATIO: "readonly",

  // Diver physics
  BUOYANCY_PARAMS: "readonly",
  FINKICK_PARAMS: "readonly", CURRENT_PARAMS: "readonly",
  WORLD_MPS: "readonly",
  // Phase C constants (sites.js / constants.js)
  DIVER_RADIUS: "readonly",
  GUIDELINE_MAX_NODES: "readonly", GUIDELINE_SAMPLE_SEC: "readonly",
  SILT_KICK_THRESHOLD: "readonly", SILT_DECAY: "readonly",
  SILT_RECOVER: "readonly", TORCH_RADIUS_M: "readonly",
  SAFETY_STOP_ACTIVE_MIN_D: "readonly", SAFETY_STOP_ACTIVE_MAX_D: "readonly",
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
  SAVE_STATE_VERSION: "readonly", _isValidSaveState: "readonly",
  GAME_OVER_INFO: "readonly",
  GAS_PRESETS: "readonly",

  // Canvas
  canvas: "writable", ctx: "writable", resize: "readonly",
  cssWidth: "writable", cssHeight: "writable",

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
  // Issue #53: Visual zones (sites.js + state.js + renderer.js)
  visualZoneAt: "readonly", zoneBlendWeight: "readonly",
  VISUAL_ZONE_DEFAULT_PRIORITY: "readonly", VISUAL_ZONE_DEFAULT_BLEND: "readonly",
  debugVisualZones: "writable",
  drawVisualZoneDebug: "readonly", VISUAL_ZONE_DEBUG: "readonly",
  // Issue #54: Local atmosphere profiles + sampler (sites.js)
  sampleLocalAtmosphere: "readonly",
  LOCAL_ATMO_DEFAULT: "readonly", LOCAL_ATMO_CLAMP: "readonly",
  // Issue #55: Deterministic set dressing / micro-decoration (renderer.js)
  drawSetDressing: "readonly", drawDecorationProp: "readonly",
  pickProp: "readonly", sampleSetDressingCandidates: "readonly",
  SET_DRESSING_MAX_MARGIN_CELLS: "readonly", SET_DRESSING_MIN_SCREEN_PX: "readonly",
  SET_DRESSING_JITTER_FRACTION: "readonly", SET_DRESSING_CELL_SEED_MULT: "readonly",
  SET_DRESSING_JITTER_SEED_MULT: "readonly", SET_DRESSING_PROP_SEED_MULT: "readonly",
  SET_DRESSING_SCALE_SEED_MULT: "readonly", SET_DRESSING_ROT_SEED_MULT: "readonly",
  SET_DRESSING_DEFAULT_MIN_SCALE: "readonly", SET_DRESSING_DEFAULT_MAX_SCALE: "readonly",
  SET_DRESSING_UNKNOWN_KIND_WARN_CAP: "readonly", SET_DRESSING_PAL: "readonly",

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
  // Issue #42: fauna terrain-avoidance + organic-motion constants and helpers
  faunaBlockedAt: "readonly",
  _stepFaunaMotion: "readonly",
  FAUNA_AVOID_INTERVAL: "readonly", FAUNA_AVOID_MARGIN: "readonly",
  FAUNA_AVOID_SPEED: "readonly", FAUNA_AVOID_DECAY: "readonly",
  FAUNA_TRAPPED_SECONDS: "readonly", FAUNA_FADE_RATE: "readonly",
  FAUNA_TURN_CHANCE: "readonly", FAUNA_TURN_TIME: "readonly",
  FAUNA_UNDULATION_AMP: "readonly",
  FAUNA_UNDULATION_FREQ_BASE: "readonly", FAUNA_UNDULATION_FREQ_SCALE: "readonly",
  FAUNA_SPEED_PULSE_AMP: "readonly",
  FAUNA_WANDER_AMP_M: "readonly", FAUNA_WANDER_FREQ: "readonly",
  FAUNA_WANDER_LERP: "readonly",

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
  // Issue #52: Visual Surface Layer helpers (renderer.js)
  VISUAL_SURFACE_CONFIG: "readonly",
  visualSurfaceNoise: "readonly", visualProfileDepth: "readonly",
  // Issue #41: Material texture tiles (renderer.js)
  MAT_TILE: "readonly", buildMaterialTiles: "readonly",
  _matTiles: "writable",
  // Issue #34: AO contact band (renderer.js)
  CONTACT_AO: "readonly", drawContactBand: "readonly",
  // Issue #55: Set-dressing internal state (renderer.js)
  _setDressingLastFrameCount: "writable", _setDressingUnknownWarned: "writable",
  // Issue #56: Surface accumulation pass (renderer.js)
  ACCUMULATION_PROFILES: "readonly", ACCUMULATION_SITE_DEFAULTS: "readonly",
  ACCUMULATION_NEUTRAL_DEFAULT: "readonly", ACCUMULATION_PAL: "readonly",
  ACCUM_SEED: "readonly",
  ACCUMULATION_SEDIMENT_MAX_M: "readonly",
  ACCUMULATION_STREAKS_MIN: "readonly", ACCUMULATION_STREAKS_MAX: "readonly",
  accumulationProfileFor: "readonly",
  drawSedimentCap: "readonly", drawContactAccumulation: "readonly",
  drawVerticalStreaks: "readonly", drawGrowthEdge: "readonly",
  // Issue #57: Environment micro-motion (renderer.js)
  SWAY_PROFILES: "readonly", sampleEnvironmentSway: "readonly",
  ENV_SWAY_CURRENT_BIAS_GAIN: "readonly", ENV_SWAY_ANGLE_GAIN: "readonly",
  ENV_SWAY_BASE_FREQ: "readonly", ENV_SWAY_BASE_AMP: "readonly",
  ENV_SWAY_DETAIL_FREQ: "readonly", ENV_SWAY_DETAIL_AMP: "readonly",
  ENV_SWAY_PHASE_MULT: "readonly", ENV_SWAY_DETAIL_PHASE: "readonly",
  // Issue #58: Shared near-surface optics (renderer.js)
  nearSurfaceLightFactor: "readonly", drawCausticsOnVisibleFloor: "readonly",
  drawNearSurfaceAtmosphere: "readonly", drawSurfaceCaustics: "readonly",
  _nearSurfaceSiteMultiplier: "readonly",
  _drawSurfaceUnderside: "readonly", _drawGodRays: "readonly",
  _drawBoatShadow: "readonly",
  // Issue #43: World-anchored parallax layers (renderer.js)
  PARALLAX_FACTORS: "readonly",
  drawSiteAtmosphere: "readonly",
  drawShoreParallaxLayers: "readonly", drawReefParallaxLayers: "readonly",
  drawWreckParallaxLayers: "readonly", drawCaveParallaxLayers: "readonly",
  // Issue #31: Directional torch cone + backscatter (renderer.js)
  torchBeamAngle: "readonly",
  TORCH_BEAM_TILT_RAD: "readonly", TORCH_BEAM_HALF_ANGLE_RAD: "readonly",
  TORCH_NEAR_FIELD_FRACTION: "readonly",
  drawWreckHullSkin: "readonly", drawTorchGlowAndSparkles: "readonly",
  _diverFacing: "writable", _torchDark: "writable", _wreckMetal: "writable",
  // Issue #33: Wreck visual polish (renderer.js)
  sampleTorchLightAtWorldPoint: "readonly",
  interiorObjectDistanceFactor: "readonly",
  wreckInteriorAlphaMul: "readonly",
  TORCH_LIGHT_EDGE_SOFTNESS: "readonly",
  INTERIOR_OBJECT_NEAR_M: "readonly", INTERIOR_OBJECT_FAR_M: "readonly",
  _wreckSilhouetteRects: "readonly", _wreckSilhouettePolygon: "readonly",
  _buildWreckSilhouette: "readonly",
  drawHangingLine: "readonly", drawNet: "readonly",
  // Issue #32: Cave visual polish (renderer.js)
  drawCaveSiltCloud: "readonly", drawCaveExitLightShaft: "readonly",
  drawCaveSpeleothems: "readonly",
  COLUMN_MERGE_TOL_M: "readonly", FLOWSTONE_PROBABILITY: "readonly",
  FLOWSTONE_STEEP_GRADIENT: "readonly", BAD_AIR_LENS_THICKNESS_M: "readonly",
  SILT_CLOUD_HEIGHT_M: "readonly", SILT_CLOUD_STEP_M: "readonly",
  SILT_CLOUD_MAX_ALPHA: "readonly", SILT_CLOUD_MIN_VIS: "readonly",
  EXIT_LIGHT_NEAR_M: "readonly", EXIT_LIGHT_FAR_M: "readonly",
  EXIT_LIGHT_BASE_ALPHA: "readonly", EXIT_LIGHT_TORCH_BOOST_ALPHA: "readonly",
  // Issue #36: depth-dependent color absorption (renderer.js)
  depthColorFactors: "readonly", drawDepthColorAbsorption: "readonly",
  DEPTH_COLOR_R_NEAR: "readonly", DEPTH_COLOR_R_FAR: "readonly", DEPTH_COLOR_R_LOSS: "readonly",
  DEPTH_COLOR_G_NEAR: "readonly", DEPTH_COLOR_G_FAR: "readonly", DEPTH_COLOR_G_LOSS: "readonly",
  DEPTH_COLOR_CAVE_STRENGTH: "readonly",
  _depthColorRestoreCanvas: "writable", _depthColorRestoreCtx: "writable",
  _depthColorMaskCanvas: "writable", _depthColorMaskCtx: "writable",
  // Phase C renderer helpers
  drawTerrain: "readonly", drawStructures: "readonly",
  drawFeatures: "readonly", drawSeagrass: "readonly",
  drawWarningSign: "readonly", drawThermocline: "readonly",
  drawCoral: "readonly", drawVehicle: "readonly", drawBuoy: "readonly", drawPond: "readonly",
  drawGuideline: "readonly", drawSiltAndTorch: "readonly",
  drawTableCoral: "readonly", drawBrainCoral: "readonly", drawStaghorn: "readonly",
  drawSoftCoral: "readonly", drawGorgonian: "readonly", drawBarrelSponge: "readonly",
  drawAnthiasCloud: "readonly", drawBlueHaze: "readonly",
  // Issue #35: coral variation helpers
  coralVariation: "readonly", tintCoralColor: "readonly",
  CORAL_SCALE_MIN: "readonly", CORAL_SCALE_MAX: "readonly",
  CORAL_BRIGHTNESS_RANGE: "readonly", CORAL_HUE_SHIFT_DEG: "readonly",

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
  perSecondToPerFrameProbability: "readonly",
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
      "no-redeclare": ["error", { "builtinGlobals": false }],

      // Warnings — code quality
      "eqeqeq": ["warn", "always", { "null": "ignore" }],
      "no-unused-vars": ["warn", { "vars": "local", "args": "none" }],
      "no-fallthrough": "warn",
    },
  },
];
