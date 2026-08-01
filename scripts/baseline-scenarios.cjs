function runBaselineScenarios() {
  const api = window.gameAPI;
  const originalRandom = Math.random;

  function setup(mode, site, tankList) {
    api.diveMode = mode;
    api.tanks.length = 0;
    api.tankCount = 0;
    api.resetDive();
    api.initTissues();
    api.initCCR();
    for (const tank of tankList) api.pushTank(tank[0], tank[1], tank[2]);
    api.activeTank = 0;
    api.diveSite = site;
    api.gameState = 'diving';
    api.shark = null;
    api.sharkTimer = 1e9;
    api.drillsEnabled = false;
    api.current.active = false;
    api.current.rolledThisDive = true;
    api.clearKeys();
  }

  function neutralizeAt(depth) {
    const params = api.BUOYANCY_PARAMS;
    const pressure = api.ambientPressure(depth);
    const wetsuitLift = params.wetsuitBuoyancySurface *
      Math.pow(1 / pressure, params.wetsuitCompressionExp);
    const requiredLift = params.leadWeight + params.gearWeightNet -
      params.bodyBuoyancy - wetsuitLift;
    api.bcdGasSurfaceLiters = Math.max(0, requiredLift * pressure);
  }

  function updateAtDepth(depth, stepMinutes, verticalRateMpm) {
    api.setDepth(depth);
    neutralizeAt(depth);
    api.verticalVelocity = verticalRateMpm;
    api.horizontalVelocity = 0;
    // Model traces intentionally exclude site collision/overhead effects.
    // The declared site is restored before every checkpoint, while the real
    // updateDiving lifecycle runs against the legacy open-water geometry.
    const declaredSite = api.diveSite;
    api.diveSite = 'open';
    try {
      api.updateDiving(stepMinutes * 60 / api.TIME_ACCELERATION);
    } finally {
      api.diveSite = declaredSite;
    }
  }

  function holdDepth(depth, minutes, stepMinutes = 0.1) {
    const steps = Math.round(minutes / stepMinutes);
    for (let step = 0; step < steps; step++) {
      updateAtDepth(depth, stepMinutes, 0);
    }
    api.setDepth(depth);
    api.verticalVelocity = 0;
  }

  function ascend(fromDepth, toDepth, rateMpm, stepMinutes = 0.025) {
    const totalMinutes = (fromDepth - toDepth) / rateMpm;
    const steps = Math.ceil(totalMinutes / stepMinutes);
    for (let step = 1; step <= steps; step++) {
      const targetDepth = Math.max(
        toDepth,
        fromDepth - (fromDepth - toDepth) * step / steps
      );
      updateAtDepth(targetDepth, totalMinutes / steps, -rateMpm);
      if (api.gameState !== 'diving') break;
    }
    api.setDepth(toDepth);
    api.verticalVelocity = -rateMpm;
  }

  try {
    // Keep browser-only scenery randomness out of the model fixture while
    // still executing the complete updateDiving lifecycle.
    Math.random = () => 0.5;
    const scenarios = [];

    setup('rec', 'shore', [[0.21, 0, 200]]);
    const air = {
      scenarioId: 'air-18m-30min',
      description: 'Air at 18 m for 30 min followed by a 12 m/min direct ascent',
      checkpoints: [api.captureBaselineCheckpoint('air-18m-30min', 'surface')]
    };
    holdDepth(18, 30);
    air.checkpoints.push(api.captureBaselineCheckpoint('air-18m-30min', 'bottom-30min'));
    ascend(18, 0, 12);
    air.checkpoints.push(api.captureBaselineCheckpoint('air-18m-30min', 'surfaced'));
    scenarios.push(air);

    setup('tec', 'wreck', [[0.21, 0.35, 200], [0.5, 0, 200]]);
    const trimix = {
      scenarioId: 'trimix-45m-20min',
      description: 'Trimix 21/35 at 45 m for 20 min, ascent to 21 m, and switch to 50% deco gas',
      checkpoints: [api.captureBaselineCheckpoint('trimix-45m-20min', 'surface')]
    };
    holdDepth(45, 20);
    trimix.checkpoints.push(api.captureBaselineCheckpoint('trimix-45m-20min', 'bottom-20min'));
    ascend(45, 21, 9);
    trimix.checkpoints.push(api.captureBaselineCheckpoint('trimix-45m-20min', 'ascent-21m'));
    api.setKeys({ 2: true });
    updateAtDepth(21, 0.025, 0);
    api.clearKeys();
    trimix.checkpoints.push(api.captureBaselineCheckpoint('trimix-45m-20min', 'deco-gas-21m'));
    scenarios.push(trimix);

    setup('ccr', 'cave', [[0.21, 0, 200]]);
    api.ccrState.targetSP = 1.3;
    api.ccrState.actualPO2 = 1.3;
    api.ccrState.dilFO2 = 0.15;
    api.ccrState.dilFHe = 0.45;
    api.ccrState.dilFN2 = 0.4;
    const ccr = {
      scenarioId: 'ccr-30m-30min',
      description: 'CCR at 1.3 bar with trimix 15/45 diluent at 30 m for 30 min and ascent to 12 m',
      checkpoints: [api.captureBaselineCheckpoint('ccr-30m-30min', 'surface')]
    };
    holdDepth(30, 30);
    ccr.checkpoints.push(api.captureBaselineCheckpoint('ccr-30m-30min', 'bottom-30min'));
    ascend(30, 12, 9);
    ccr.checkpoints.push(api.captureBaselineCheckpoint('ccr-30m-30min', 'ascent-12m'));
    scenarios.push(ccr);

    setup('ccr', 'shore', [[0.21, 0, 200]]);
    api.ccrState.targetSP = 1.3;
    api.ccrState.actualPO2 = 1.3;
    api.ccrState.dilFO2 = 0.21;
    api.ccrState.dilFHe = 0;
    api.ccrState.dilFN2 = 0.79;
    const bailout = {
      scenarioId: 'ccr-bailout-30m',
      description: 'CCR at 30 m followed by irreversible open-circuit bailout and ascent to 18 m',
      checkpoints: [api.captureBaselineCheckpoint('ccr-bailout-30m', 'surface')]
    };
    holdDepth(30, 10);
    bailout.checkpoints.push(api.captureBaselineCheckpoint('ccr-bailout-30m', 'pre-bailout'));
    api.setKeys({ b: true });
    updateAtDepth(30, 0.025, 0);
    api.clearKeys();
    bailout.checkpoints.push(api.captureBaselineCheckpoint('ccr-bailout-30m', 'bailed-out'));
    ascend(30, 18, 9);
    bailout.checkpoints.push(api.captureBaselineCheckpoint('ccr-bailout-30m', 'bailout-ascent-18m'));
    scenarios.push(bailout);

    return scenarios;
  } finally {
    Math.random = originalRandom;
  }
}

module.exports = { runBaselineScenarios };
