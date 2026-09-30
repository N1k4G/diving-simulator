function runBaselineScenarios() {
  const api = window.gameAPI;
  const originalRandom = Math.random;

  // The depth/duration sequence the legacy client actually integrated tissues
  // over, since the previous checkpoint. Filled by updateAtDepth() and drained
  // by checkpoint().
  //
  // WHY THE RECORDED DEPTH IS READ BACK RATHER THAN PASSED IN. updateAtDepth()
  // asks for a target depth, but updateDiving() does not integrate at it:
  // updateBuoyancyPhysics() moves `depth` first, the result is clamped
  // (game-loop.js), and only then does updateTissues() read the global `depth`
  // for its ambient pressure. Nothing assigns `depth` between that clamp and
  // updateTissues(), so the value left after the tick is exactly the one the
  // tissues loaded at — and the one a pure replay has to use. Recording the
  // requested depth instead is what made ascents unreproducible: replaying the
  // nominal 12 m/min ramp lands ~1.2e-3 bar out against a 1e-9 tolerance
  // (docs/decisions.md, "Trace contract limits").
  const trajectory = [];

  function checkpoint(scenarioId, checkpointId) {
    const captured = api.captureBaselineCheckpoint(scenarioId, checkpointId);
    // splice(0) drains: each checkpoint owns the steps since the previous one.
    captured.trajectory = trajectory.splice(0);
    return captured;
  }

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
    // Prime captureBaselineCheckpoint's observed simulation geometry without
    // advancing any authoritative clock or model value.
    updateAtDepth(0, 0, 0);
    // That priming tick is setup, not dive time: it carries dt 0 and belongs to
    // no segment. Drop it so a scenario's first checkpoint starts from empty.
    trajectory.length = 0;
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
    trajectory.push({ depth_m: api.depth, dtDive_min: stepMinutes });
  }

  // One updateDiving() tick with the given keys held and the buoyancy physics
  // left to move the diver (#192). Unlike updateAtDepth(), nothing sets the
  // depth or neutralises the BCD: the depth recorded is whatever the physics
  // produced. The declared site is swapped for the geometry-free 'open' one,
  // as updateAtDepth() does, so the only bounds are the surface and MAX_DEPTH.
  function physicsTick(keys, stepMinutes) {
    api.clearKeys();
    api.setKeys(keys);
    const declaredSite = api.diveSite;
    api.diveSite = 'open';
    try {
      api.updateDiving(stepMinutes * 60 / api.TIME_ACCELERATION);
    } finally {
      api.diveSite = declaredSite;
      api.clearKeys();
    }
    trajectory.push({ depth_m: api.depth, dtDive_min: stepMinutes });
  }

  // Holds keys for a span of dive time in display frames, 60 Hz unless
  // given: one frame is 1/fps s real, TIME_ACCELERATION/fps s of dive time.
  // Legacy applies the BCD controls once per frame, before that frame's
  // physics, so the frame length is part of the behaviour (#193 review): with
  // W or S held, fast-forward is off, and gameLoop() caps a frame at 0.1 s
  // real, which is 10 fps.
  function holdKeys(keys, diveSeconds, fps = 60) {
    const frameMinutes = api.TIME_ACCELERATION / fps / 60;
    const frames = Math.round(diveSeconds / (frameMinutes * 60));
    for (let frame = 0; frame < frames; frame++) physicsTick(keys, frameMinutes);
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
      checkpoints: [checkpoint('air-18m-30min', 'surface')]
    };
    holdDepth(18, 30);
    air.checkpoints.push(checkpoint('air-18m-30min', 'bottom-30min'));
    ascend(18, 0, 12);
    air.checkpoints.push(checkpoint('air-18m-30min', 'surfaced'));
    scenarios.push(air);

    setup('tec', 'wreck', [[0.21, 0.35, 200], [0.5, 0, 200]]);
    const trimix = {
      scenarioId: 'trimix-45m-20min',
      description: 'Trimix 21/35 at 45 m for 20 min, ascent to 21 m, and switch to 50% deco gas',
      checkpoints: [checkpoint('trimix-45m-20min', 'surface')]
    };
    holdDepth(45, 20);
    trimix.checkpoints.push(checkpoint('trimix-45m-20min', 'bottom-20min'));
    ascend(45, 21, 9);
    trimix.checkpoints.push(checkpoint('trimix-45m-20min', 'ascent-21m'));
    api.setKeys({ 2: true });
    updateAtDepth(21, 0.025, 0);
    api.clearKeys();
    trimix.checkpoints.push(checkpoint('trimix-45m-20min', 'deco-gas-21m'));
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
      checkpoints: [checkpoint('ccr-30m-30min', 'surface')]
    };
    holdDepth(30, 30);
    ccr.checkpoints.push(checkpoint('ccr-30m-30min', 'bottom-30min'));
    ascend(30, 12, 9);
    ccr.checkpoints.push(checkpoint('ccr-30m-30min', 'ascent-12m'));
    scenarios.push(ccr);

    setup('ccr', 'shore', [[0.21, 0, 200]]);
    api.ccrState.targetSP = 1.3;
    api.ccrState.actualPO2 = 1.3;
    api.ccrState.dilFO2 = 0.21;
    api.ccrState.dilFHe = 0;
    api.ccrState.dilFN2 = 0.79;
    const bailout = {
      scenarioId: 'ccr-bailout-30m',
      description: 'CCR at 30 m followed by irreversible open-circuit bailout and ascent to 18 m; bailout drains the diluent cylinder by design, and changing that billing requires a reviewed fixture update',
      checkpoints: [checkpoint('ccr-bailout-30m', 'surface')]
    };
    holdDepth(30, 10);
    bailout.checkpoints.push(checkpoint('ccr-bailout-30m', 'pre-bailout'));
    api.setKeys({ b: true });
    updateAtDepth(30, 0.025, 0);
    api.clearKeys();
    bailout.checkpoints.push(checkpoint('ccr-bailout-30m', 'bailed-out'));
    ascend(30, 18, 9);
    bailout.checkpoints.push(checkpoint('ccr-bailout-30m', 'bailout-ascent-18m'));
    scenarios.push(bailout);

    // #163 acceptance: a tank switch, a setpoint change and a bailout,
    // driven by the keys a diver presses (2, ] and B), so the migration
    // client's DiveModel.switchGas(), adjustSetpoint() and bailOut() can be
    // replayed against them. Two dives, because a CCR dive has one
    // open-circuit cylinder in legacy too (TASK-019 loops to tankCount).
    //
    // EACH KEY IS READ IN A ZERO-LENGTH TICK. updateDiving() reads the keys
    // after updateTissues() and after the gas billing or loop update, so a
    // key read inside an ordinary tick lands in the middle of it: that tick
    // integrates the old gas and, for a tank switch, bills the new one. The
    // migration client applies an act between whole-second steps, where
    // neither half of that split exists. A zero-length tick puts the key on a
    // tick boundary, where the two clients mean the same thing, so the
    // segment after it can be replayed on the model's own breathing and life
    // support and compared field by field (#184 review round 1).
    //
    // The five minutes after ] run in one-second ticks, the model's fixed
    // step. The loop PO2 climbs to the new setpoint inside them, and a 6 s
    // legacy tick integrates that climb differently from six 1 s steps.
    //
    // The CCR diluent is Tx 15/45 while the setup cylinder stays air, on
    // purpose. ccr-bailout-30m uses air for both, so no checkpoint could tell
    // which one a bailout forecast breathes; this one can (#183).
    setup('ccr', 'shore', [[0.21, 0, 200]]);
    api.ccrState.targetSP = 1.2;
    api.ccrState.actualPO2 = 1.2;
    api.ccrState.dilFO2 = 0.15;
    api.ccrState.dilFHe = 0.45;
    api.ccrState.dilFN2 = 0.4;
    const inDive = {
      scenarioId: 'ccr-setpoint-bailout-30m',
      description: 'CCR at 1.2 bar with Tx 15/45 diluent at 30 m; ] in a zero-length tick raises the setpoint to 1.3 after 10 min, five minutes in one-second ticks, B in a zero-length tick, then an ascent to 21 m on the diluent',
      checkpoints: [checkpoint('ccr-setpoint-bailout-30m', 'surface')]
    };
    holdDepth(30, 10);
    inDive.checkpoints.push(checkpoint('ccr-setpoint-bailout-30m', 'bottom-10min'));
    api.setKeys({ ']': true });
    updateAtDepth(30, 0, 0);
    api.clearKeys();
    inDive.checkpoints.push(checkpoint('ccr-setpoint-bailout-30m', 'setpoint-raised'));
    holdDepth(30, 5, 1 / 60);
    inDive.checkpoints.push(checkpoint('ccr-setpoint-bailout-30m', 'bottom-15min'));
    api.setKeys({ b: true });
    updateAtDepth(30, 0, 0);
    api.clearKeys();
    inDive.checkpoints.push(checkpoint('ccr-setpoint-bailout-30m', 'bailed-out'));
    ascend(30, 21, 9);
    inDive.checkpoints.push(checkpoint('ccr-setpoint-bailout-30m', 'bailout-ascent-21m'));
    scenarios.push(inDive);

    // The open-circuit half: key 2 at 21 m on a trimix dive, in a zero-length
    // tick, then three minutes on the 50% cylinder, so both cylinders' gas
    // can be compared after the switch. deco-gas-21m above reads the key in
    // an ordinary tick, and is left exactly as it was recorded.
    setup('tec', 'wreck', [[0.21, 0.35, 200], [0.5, 0, 200]]);
    const tecSwitch = {
      scenarioId: 'tec-switch-21m',
      description: 'Trimix 21/35 at 30 m for 15 min, ascent to 21 m, key 2 in a zero-length tick to the 50% cylinder, then 3 min at 21 m on it',
      checkpoints: [checkpoint('tec-switch-21m', 'surface')]
    };
    holdDepth(30, 15);
    tecSwitch.checkpoints.push(checkpoint('tec-switch-21m', 'bottom-15min'));
    ascend(30, 21, 9);
    tecSwitch.checkpoints.push(checkpoint('tec-switch-21m', 'ascent-21m'));
    api.setKeys({ 2: true });
    updateAtDepth(21, 0, 0);
    api.clearKeys();
    tecSwitch.checkpoints.push(checkpoint('tec-switch-21m', 'switched'));
    holdDepth(21, 3);
    tecSwitch.checkpoints.push(checkpoint('tec-switch-21m', 'deco-gas-3min'));
    scenarios.push(tecSwitch);

    // #192: vertical motion from buoyancy. Air at 12 m, BCD neutral there,
    // then S held briefly (vent and sink), nothing held (the diver keeps
    // sinking on momentum and compression), W held (inflate), nothing held.
    // 11 s of W stops the sink, turns it, and lets the ascent accelerate as
    // the BCD expands. Presses of 12 s or more, or long vents, drive the
    // diver into the velocity limits and a barotrauma game over, which the
    // model cannot produce yet (#189). Recorded in 60 Hz frames (holdKeys).
    setup('rec', 'shore', [[0.21, 0, 200]]);
    api.setDepth(12);
    neutralizeAt(12);
    api.verticalVelocity = 0;
    const buoyancy = {
      scenarioId: 'buoyancy-vent-inflate-12m',
      description: 'Air, neutral at 12 m; S held 4 s, released 20 s, W held 11 s, released 30 s, in 60 Hz frames, then S held 3 s in 10 fps frames, with the buoyancy physics moving the diver',
      checkpoints: [checkpoint('buoyancy-vent-inflate-12m', 'neutral-12m')]
    };
    holdKeys({ s: true }, 4);
    buoyancy.checkpoints.push(checkpoint('buoyancy-vent-inflate-12m', 'vented-4s'));
    holdKeys({}, 20);
    buoyancy.checkpoints.push(checkpoint('buoyancy-vent-inflate-12m', 'sinking-20s'));
    holdKeys({ w: true }, 11);
    buoyancy.checkpoints.push(checkpoint('buoyancy-vent-inflate-12m', 'inflated-11s'));
    holdKeys({}, 30);
    buoyancy.checkpoints.push(checkpoint('buoyancy-vent-inflate-12m', 'coasting-30s'));
    // S held in the slowest frames legacy runs with a control held: 10 fps,
    // 0.3 s of dive time each, the controls applied once per frame and the
    // physics in three 0.1 s sub-steps within it (#193 review).
    holdKeys({ s: true }, 3, 10);
    buoyancy.checkpoints.push(checkpoint('buoyancy-vent-inflate-12m', 'vented-3s-10fps'));
    scenarios.push(buoyancy);

    // #192, the recorded departure: a rebreather diver inflating. Legacy's
    // inflateBCD() draws from tanks[activeTank], the setup placeholder on a
    // CCR dive; the migration draws from the diluent (docs/decisions.md). The
    // fixture keeps legacy's values; tests/parity/buoyancy.test.ts declares
    // the departure. W held 2 s turns the diver upward, and the ascent stays
    // below the velocity limits.
    setup('ccr', 'shore', [[0.21, 0, 200]]);
    api.ccrState.targetSP = 1.3;
    api.ccrState.actualPO2 = 1.3;
    api.ccrState.dilFO2 = 0.21;
    api.ccrState.dilFHe = 0;
    api.ccrState.dilFN2 = 0.79;
    api.setDepth(12);
    neutralizeAt(12);
    api.verticalVelocity = 0;
    const ccrInflate = {
      scenarioId: 'buoyancy-ccr-inflate-12m',
      description: 'CCR at 1.3 bar with air diluent, neutral at 12 m; W held 2 s, released 8 s, in 60 Hz frames with the buoyancy physics moving the diver',
      checkpoints: [checkpoint('buoyancy-ccr-inflate-12m', 'neutral-12m')]
    };
    holdKeys({ w: true }, 2);
    ccrInflate.checkpoints.push(checkpoint('buoyancy-ccr-inflate-12m', 'inflated-2s'));
    holdKeys({}, 8);
    ccrInflate.checkpoints.push(checkpoint('buoyancy-ccr-inflate-12m', 'rising-8s'));
    scenarios.push(ccrInflate);

    return scenarios;
  } finally {
    Math.random = originalRandom;
  }
}

module.exports = { runBaselineScenarios };
