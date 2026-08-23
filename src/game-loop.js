// ============================================================
// FILE: game-loop.js
// PURPOSE: Core update functions, main requestAnimationFrame loop,
//          dive-state persistence (localStorage), and bootstrap.
//          This is the top-level orchestrator — it calls into all
//          other modules and owns the main execution entry point.
//
// DEPENDS ON:
//   constants.js — TIME_ACCELERATION, FAST_FORWARD_MULTIPLIER
//   state.js     — gameState, depth, diver, tanks, all physics state
//   physics.js   — updateTissues(), calculateTTS(), calculateCeiling()
//   world.js     — updateBubbles(), updateFish(), updateParticles()
//   renderer.js  — draw*() functions called each frame
//   ui.js        — updateGasSetup(), buildHtmlGasSetup()
//
// USED BY:
//   touch.js     — monkey-patches gameLoop() to inject touchUpdateUI()
//
// KEY FUNCTIONS (grep to find):
//   updateSurface(dt)        — surface state tick (pre-dive screen)
//   updateDiving(dt)         — core dive physics tick (calls everything)
//   gameLoop(timestamp)      — rAF callback, dispatches to update + draw
//   saveDiveState()          — serialize full dive state to localStorage
//   loadSavedDive()          — restore dive state from localStorage
// SECTION: Surface and diving update functions
// SEARCH TERMS: updateSurface, updateDiving, fastForwardActive, gameOverReason

// Diagnostics are an optional observer. Keep the reference client runnable
// when diagnostics.js is omitted from a production or legacy script list.
var _baselineDiag = window.baselineDiagnostics || {
    enabled: false,
    start: function() { return 0; },
    record: function() {},
    reset: function() {},
    exportSnapshot: function() { return null; }
};
// Geometry used by the most recent model tick. Baseline scenarios may isolate
// numerical profiles from declared site collision/overhead behavior, so this
// must be captured independently from diveSite.
var _baselineLastSimulatedGeometry = null;

// Phase A: Exertion multiplier for gas consumption while kicking.
function effectiveAMV(kicking) {
    return amvRate * (kicking ? FINKICK_PARAMS.exertionFactor : 1);
}

// Issue #45: Scenario drills — helper functions.
// -----------------------------------------------------------------------
// isDrillEligibleNow()
//   Framework-level gates that apply BEFORE a specific drill's precondition
//   is checked: dive-time window, depth floor, no active alarm/gameover
//   condition, opt-in toggle on, at most one drill per dive. Returns
//   boolean.
// tryTriggerDrill(dtReal)
//   Called once per updateDiving() tick when eligible. Picks a random
//   drill whose precondition passes and starts it. Uses a per-second
//   Bernoulli probability converted through perSecondToPerFrameProbability
//   so the expected number of triggers per real-second is framerate-
//   independent (same pattern as bubbles / narcosis input drops).
// startDrill(id)
//   Public entry (also used by gameAPI.forceDrill()). Marks the drill as
//   run this dive so the trigger check will not re-fire, runs the drill's
//   optional onTrigger (e.g. co2 flips ccrState.scrubberFailed), and either
//   begins the flicker phase (lightFailure — 2 s of visual pre-roll,
//   physics continues) or opens the overlay immediately (freeflow, co2).
// resolveDrillOption(idx)
//   Called by the keyboard handler (1/2/3) OR by touch.js's canvas tap
//   handler. Runs the option's effect, logs a 'drillOutcome' event into
//   diveEvents (issue #44 debriefing), moves to the debrief phase.
// dismissDrillDebrief()
//   Called by Enter OR by the auto-dismiss timer. Returns to 'diving'.
function _drillIsAlarmActive() {
    // "Active alarm" = any of the sustained-violation timers has any
    // accumulated time, OR the CCR loop is already failing, OR the diver
    // is in the bad-air lens. This is deliberately broad — the didactic
    // point of the framework is that drills only fire when the diver is
    // NOT already fighting for their life.
    if (po2ViolationTime > 0 || dcsViolationTime > 0 ||
        barotraumaTime > 0 || hypoxiaTime > 0) return true;
    if (diveMode === 'ccr' && (ccrHypoxiaTime > 0 || ccrHyperoxiaTime > 0)) return true;
    if (badAirWarning) return true;
    return false;
}
function isDrillEligibleNow() {
    if (!drillsEnabled) return false;
    if (drillHasRunThisDive) return false;
    if (drillState.phase !== 'inactive') return false;
    if (diveTime < DRILL_MIN_DIVETIME_MIN) return false;
    if (diveTime > DRILL_MAX_DIVETIME_MIN) return false;
    if (depth <= DRILL_MIN_DEPTH_M) return false;
    if (_drillIsAlarmActive()) return false;
    return true;
}
function _pickEligibleDrill() {
    var candidates = [];
    for (var i = 0; i < DRILLS.length; i++) {
        try {
            if (DRILLS[i].precondition()) candidates.push(DRILLS[i]);
        } catch { /* precondition may touch not-yet-populated state; skip */ }
    }
    if (candidates.length === 0) return null;
    return candidates[Math.floor(Math.random() * candidates.length)];
}
function tryTriggerDrill(dtReal) {
    if (!isDrillEligibleNow()) return false;
    var pFrame = perSecondToPerFrameProbability(DRILL_TRIGGER_PROB_PER_SEC, dtReal);
    if (Math.random() >= pFrame) return false;
    var drill = _pickEligibleDrill();
    if (!drill) return false;
    return startDrill(drill.id);
}
function _drillById(id) {
    for (var i = 0; i < DRILLS.length; i++) if (DRILLS[i].id === id) return DRILLS[i];
    return null;
}
function startDrill(id) {
    var drill = _drillById(id);
    if (!drill) return false;
    drillHasRunThisDive = true;
    drillState.id = id;
    drillState.startedAt = diveTime;
    drillState.selectedOption = -1;
    drillState.correct = false;
    drillState.optionRects = [];
    if (typeof drill.onTrigger === 'function') {
        try { drill.onTrigger(); } catch { /* onTrigger has no rollback path */ }
    }
    if (id === 'lightFailure') {
        // 2 s of torch flicker BEFORE the overlay appears — the didactic
        // signal is "you saw your light die, then had to decide". Physics
        // keeps ticking during the flicker so the interruption feels real.
        drillState.phase = 'flicker';
        drillState.flickerUntilReal = _drillRealTime() + DRILL_LIGHT_FLICKER_SEC;
    } else {
        _openDrillOverlay();
    }
    return true;
}
function _drillRealTime() {
    // performance.now() when available (avoids Date.now() jumping backward
    // on wall-clock adjustments); fallback for the classic-script iframe
    // context used by the test harness.
    return (typeof performance !== 'undefined' && performance.now)
        ? performance.now() / 1000
        : Date.now() / 1000;
}
function _openDrillOverlay() {
    // lightFailure: torch has now definitely failed (flicker window over).
    // Other drills open the overlay directly from startDrill().
    if (drillState.id === 'lightFailure') torchOn = false;
    drillState.phase = 'overlay';
    if (gameState === 'diving') gameState = 'drill';
}
function _updateDrillTiming(dtReal) {
    // Called BEFORE physics from the 'diving' branch (advance flicker->overlay)
    // AND from the 'drill' branch (auto-dismiss debrief). One entry point so
    // the same real-time clock drives both, whether we are still ticking
    // physics or paused. Also expires the freeflow multiplier once dive-time
    // passes the deadline (called from within updateDiving()).
    if (drillState.phase === 'flicker' && _drillRealTime() >= drillState.flickerUntilReal) {
        _openDrillOverlay();
    }
    if (drillState.phase === 'debrief' && _drillRealTime() >= drillState.debriefUntilReal) {
        dismissDrillDebrief();
    }
}
function resolveDrillOption(idx) {
    if (drillState.phase !== 'overlay') return false;
    var drill = _drillById(drillState.id);
    if (!drill) return false;
    // Multi-tank gating: the freeflow "switch to backup" option is only
    // offered when tankCount > 1. The overlay renderer / tap-hit logic
    // already filters the visible options through the same gate, but a
    // programmatic (test) forceOption path must reject an unavailable idx
    // rather than silently pick another option.
    var visible = _visibleDrillOptions(drill);
    if (idx < 0 || idx >= visible.length) return false;
    var opt = visible[idx];
    drillState.selectedOption = idx;
    drillState.correct = !!opt.correct;
    try { opt.effect(); } catch { /* option effects don't currently throw */ }
    diveEvents.push({ t: diveTime, kind: 'drillOutcome', value: {
        id: drill.id, option: idx, correct: !!opt.correct
    }});
    drillState.phase = 'debrief';
    drillState.debriefUntilReal = _drillRealTime() + DRILL_DEBRIEF_DURATION_SEC;
    return true;
}
function _visibleDrillOptions(drill) {
    var out = [];
    for (var i = 0; i < drill.options.length; i++) {
        var o = drill.options[i];
        if (o.requiresMultiTank && tankCount <= 1) continue;
        out.push(o);
    }
    return out;
}
function dismissDrillDebrief() {
    if (drillState.phase !== 'debrief') return false;
    drillState.phase = 'effect';
    // Ongoing effects (freeflow multiplier, light-restore countdown) remain
    // active — they are read directly off drillState by consumption code and
    // the renderer respectively.
    if (gameState === 'drill') gameState = 'diving';
    return true;
}

// Issue #69: convert a per-frame probability that was calibrated at an
// assumed 60 fps (p60) into the correct per-frame probability for the
// actual frame's dt so that the expected NUMBER of events per real second
// stays constant regardless of framerate. Standard framerate-independent
// Bernoulli trial: P(no event over dt) = (1 - p60)^(dt * 60). A per-frame
// call sites feeding a raw p60 fired 2.4x more often on a 144 Hz display
// than on 60 Hz (bubbles, narcosis input drops); wrapping p60 through
// this helper removes that dependency.
function perSecondToPerFrameProbability(p60, dt) {
    if (!(dt > 0)) return 0;
    if (p60 <= 0) return 0;
    if (p60 >= 1) return 1;
    return 1 - Math.pow(1 - p60, dt * 60);
}

// D6: Torch toggle — edge-detect on F key so one press = one toggle
var _torchKeyPrev = false;

// Issue #14: per-tick cache for the expensive Bühlmann calculations
// (calculateCeiling(), calculateNDL(), calculateDecoSchedule(), calculateTTS())
// that used to run multiple times per frame — once per call site inside
// updateDiving(), then again in drawDiveComputer()/drawPostDive(). Populated
// once at the top of updateDiving(); every other call site in this file and
// in renderer.js reads from here instead of recomputing. Frozen at whatever
// it held on the last diving tick once the dive ends, which is the correct
// (final) state for the post-dive summary screen to read. No behavior
// change — pure efficiency.
var frameCalc = { ceiling: 0, ndl: 999, schedule: null, tts: 0 };

// ============================================================
function updateSurface(dtReal) {
    waveTime += dtReal;
    if (keys['s'] || keys['arrowdown']) {
        bcdGasSurfaceLiters = 2.0;
        verticalVelocity = 0;
        if (diveMode === 'ccr') { ccrState.actualPO2 = ccrState.targetSP < ambientPressure(0) ? ccrState.targetSP : 0.21; }
        gameState = 'diving';
    }
}

function updateDiving(dtReal) {
    _baselineLastSimulatedGeometry = diveSite;
    // Issue #14: this first read of frameCalc is intentionally the value
    // left over from the END of the PREVIOUS tick (tissues haven't been
    // updated yet this frame, so it's numerically identical to a fresh
    // calculateCeiling() call here) — matches original behavior exactly.
    // frameCalc is refreshed once, right after updateTissues() runs below,
    // for every read later in this tick and in the renderer this frame.
    // Fast-forward eligibility check
    var decoStopD = decoStop(frameCalc.ceiling);
    var atDecoStop = decoStopD > 0 && Math.abs(depth - decoStopD) <= 1.5;
    var atSafetyStop = safetyStopCountdownStarted && !safetyStopComplete && depth >= SAFETY_STOP_ACTIVE_MIN_D && depth <= SAFETY_STOP_ACTIVE_MAX_D;
    var canFastForward = (atDecoStop || atSafetyStop);
    
    if (canFastForward && !keys['w'] && !keys['arrowup'] && !keys['s'] && !keys['arrowdown']) {
        // Toggle on F press (edge-detected)
        if (keys['f'] && !keys['f_prev']) {
            fastForwardActive = !fastForwardActive;
        }
    } else {
        fastForwardActive = false;
    }
    keys['f_prev'] = keys['f'];
    
    var timeMultiplier = fastForwardActive ? TIME_ACCELERATION * FAST_FORWARD_MULTIPLIER : TIME_ACCELERATION;
    var dtDiveSeconds = dtReal * timeMultiplier;
    var dtDiveMinutes = dtDiveSeconds / 60.0;

    waveTime += dtReal;
    diveTime += dtDiveMinutes;

    if (gasSwitchNotifyTime > 0) {
        gasSwitchNotifyTime -= dtReal;
    }

    // Issue #45: advance flicker->overlay transition (real-time driven)
    // + expire the free-flow multiplier when its dive-second deadline
    // passes + restore torch if the light-failure dark period elapsed.
    _updateDrillTiming(dtReal);
    if (drillState.freeflowUntilDiveSec > 0 && diveTime * 60 >= drillState.freeflowUntilDiveSec) {
        drillState.freeflowUntilDiveSec = 0;
        drillState.freeflowDrainTankIdx = -1;
    }
    if (drillState.lightRestoreAt > 0 && diveTime * 60 >= drillState.lightRestoreAt) {
        torchOn = true;
        drillState.lightRestoreAt = 0;
    }
    // Try to fire a scripted drill. Only rolls when isDrillEligibleNow()
    // returns true (dive-time window + depth floor + no active alarm +
    // opt-in + at most one per dive), so this is a cheap gate in the
    // common case.
    tryTriggerDrill(dtReal);

    // Issue #38: Contextual onboarding hint pump.
    // The queue drains one hint at a time. Each visible hint runs for
    // HINT_DISPLAY_SEC real-seconds (dtReal, not dtDiveSeconds — the toast
    // is a UX affordance, not a physics event, so it must not compress
    // under fast-forward). We also refuse to *start* a new hint while
    // fast-forwarding — the diver's attention is on the accelerated
    // timeline, not on a nudge. If a hint was already visible when FF
    // was toggled on, we let its timer finish naturally.
    if (hintNotifyTime > 0) {
        hintNotifyTime -= dtReal;
        if (hintNotifyTime <= 0) {
            hintNotifyTime = 0;
            hintNotifyText = '';
        }
    }
    if (hintNotifyTime <= 0 && hintQueue.length > 0 && !fastForwardActive) {
        hintNotifyText = hintQueue.shift();
        hintNotifyTime = HINT_DISPLAY_SEC;
    }

    // Edge-triggered onboarding hints (issue #38). Each block flips a
    // per-dive edge flag AFTER calling showHintOnce so a trigger that
    // already fired this dive stays silent even if the condition oscillates
    // (e.g. NDL dipping below 10 min and back above 10 min inside a single
    // dive would otherwise re-queue the hint every crossing). The
    // localStorage guard inside showHintOnce is what enforces the
    // once-per-BROWSER promise; hintEdges only prevents re-enqueue within
    // the current dive.
    //
    // NOTE on timing: this runs before this tick's updateTissues()/
    // updateOverheadState()/safety-stop block, so safetyStopNeeded/inOverhead/
    // current.active/calculateNDL()/calculateCeiling() here reflect the END
    // of the PREVIOUS tick, not this one — a hint can lag the true edge by
    // one frame (~16ms), which is inconsequential for a UI tooltip. Moving
    // this block later to eliminate that lag was tried and reverted: it
    // causes setDepth()-driven test scenarios (and, in principle, any real
    // scenario using a large single-frame depth jump) to read post-physics-
    // clamp state instead of the value the diver/test actually asked for.
    if (!hintEdges.bcd && depth > HINT_BCD_MIN_DEPTH) {
        showHintOnce('bcd', 'hintBcd');
        hintEdges.bcd = true;
    }
    if (!hintEdges.ndl) {
        // Only meaningful once the diver is actually underwater — at the
        // surface NDL is 0 (surface pressure has no NDL), which would
        // spuriously trip a "NDL dropping" hint on frame 0.
        // Issue #14 (review follow-up): read frameCalc.ndl (still holding
        // the previous tick's value at this point — see the NOTE above)
        // instead of calling calculateNDL() fresh; numerically identical
        // per that same NOTE, but without the redundant computation.
        var _ndl = frameCalc.ndl;
        if (depth > HINT_BCD_MIN_DEPTH && _ndl > 0 && _ndl < HINT_NDL_MIN) {
            showHintOnce('ndl', 'hintNdl');
            hintEdges.ndl = true;
        }
    }
    if (!hintEdges.safetyStop && safetyStopNeeded) {
        showHintOnce('safetyStop', 'hintSafetyStop');
        hintEdges.safetyStop = true;
    }
    if (!hintEdges.deco) {
        // Deco obligation = there is a mandatory stop shallower than the
        // diver. decoStop(frameCalc.ceiling) > 0 is the exact same check
        // the dive computer uses to switch from NDL to STOP display.
        // Issue #14 (review follow-up): frameCalc.ceiling instead of a
        // fresh calculateCeiling() call, same reasoning as frameCalc.ndl above.
        if (decoStop(frameCalc.ceiling) > 0) {
            showHintOnce('deco', 'hintDeco');
            hintEdges.deco = true;
        }
    }
    if (!hintEdges.overhead && inOverhead) {
        showHintOnce('overhead', 'hintOverhead');
        hintEdges.overhead = true;
    }
    if (!hintEdges.current && current.active) {
        showHintOnce('current', 'hintCurrent');
        hintEdges.current = true;
    }

    // Variable rate movement — acceleration/deceleration
    // WP-020: Narcosis control impairment — random frame skips.
    // Issue #69: `narcDelay * 0.6` is a per-frame drop probability calibrated
    // at 60 fps; feeding it raw made a 144 Hz display drop 2.4x more input
    // events per real second. `perSecondToPerFrameProbability(p60, dtReal)`
    // maps it to the correct per-frame value for the actual frame dt so the
    // expected number of drops per real second is framerate-independent.
    // Uses dtReal (not dtDiveSeconds) because the diver's keypress cadence
    // is a real-time-domain event that shouldn't scale with time-acceleration.
    var narcDelay = narcosisIndex > 0.3 ? (narcosisIndex - 0.3) / 0.7 : 0;
    var narcDropP = perSecondToPerFrameProbability(narcDelay * 0.6, dtReal);
    // Movement keys: WASD or the arrow keys (arrows only adjust gas on the
    // gas-setup screen, so aliasing them here — diving only — is conflict-free).
    var wActive = (keys['w'] || keys['arrowup'])    && Math.random() > narcDropP;
    var sActive = (keys['s'] || keys['arrowdown'])  && Math.random() > narcDropP;
    // Phase A: Horizontal fin kicks — narcosis impairs lateral control too
    var aActive = (keys['a'] || keys['arrowleft'])  && Math.random() > narcDropP;
    var dActive = (keys['d'] || keys['arrowright']) && Math.random() > narcDropP;
    var kickDir = (dActive ? 1 : 0) - (aActive ? 1 : 0);

    // D6: Toggle torch on T press — F is taken by fast-forward
    var tDown = !!keys['t'];
    if (tDown && !_torchKeyPrev) torchOn = !torchOn;
    _torchKeyPrev = tDown;

    // --- BCD Buoyancy Controls ---
    if (wActive) { inflateBCD(dtDiveSeconds, depth); }
    if (sActive) { ventBCD(dtDiveSeconds, depth); }

    // --- Buoyancy + Horizontal Physics ---
    // Issue #65: at fast-forward + a frame drop, dtDiveSeconds can reach
    // ~3 s (0.1s real × 30x). Both integrators use explicit Euler with a
    // per-step drag factor of `dragCoefficient * dtSec` — at 3 s the factor
    // exceeds 1, flipping velocity sign every step and, downstream, tripping
    // the exertion-threshold gas-consumption check at deco stops. Break the
    // frame into fixed sub-steps of at most PHYSICS_MAX_SUBSTEP_SEC (see
    // constants.js) so every per-step drag factor stays well below 1. In
    // the common small-dt case this is a single-iteration no-op wrapper.
    // Same pattern as the existing collision sub-stepping inside
    // updateBuoyancyPhysics() (line ~128) and updateHorizontalPhysics()
    // (line ~177) — those are spatial, this is temporal.
    var prevDepth = depth;
    var _physRemaining = dtDiveSeconds;
    while (_physRemaining > 1e-9) {
        var _physStep = _physRemaining > PHYSICS_MAX_SUBSTEP_SEC ? PHYSICS_MAX_SUBSTEP_SEC : _physRemaining;
        updateBuoyancyPhysics(_physStep);
        updateHorizontalPhysics(_physStep, kickDir);
        _physRemaining -= _physStep;
    }

    // WP-020: Narcosis drift (applies to velocity)
    if (narcosisIndex > 0.45 && depth > 0) {
        var driftStrength = (narcosisIndex - 0.45) / 0.55;
        narcDrift += (Math.random() - 0.5) * 0.3 * driftStrength * dtReal;
        narcDrift *= 0.98;
        verticalVelocity += narcDrift * 60;
    }
    if (narcosisIndex <= 0.45) narcDrift = 0;

    depth = Math.max(0, Math.min(MAX_DEPTH, depth));

    // CCR diluent consumption on descent
    if (diveMode === 'ccr') { updateCCRDiluent(prevDepth, depth); }

    if (dtDiveMinutes > 0) {
        ascentRate = -(depth - prevDepth) / dtDiveMinutes;
    }

    if (depth > maxDepth) maxDepth = depth;
    if (depth > 0.5) {
        // Issue #26: time-weighted, not per-frame. A fast-forwarded frame
        // (up to 30x normal dtDiveSeconds) used to count as exactly one
        // sample same as a normal frame, systematically underweighting
        // flat stop time and skewing the displayed average depth shallow
        // once FF was used. Weighting by dtDiveSeconds also makes the
        // result framerate-independent; the display formula (accum/samples)
        // and saveDiveState() persistence are unchanged.
        avgDepthAccum += depth * dtDiveSeconds;
        avgDepthSamples += dtDiveSeconds;
    }

    // WP-034 / Issue #71: Record dive profile sample every ~2 simulated
    // seconds. Under fast-forward a single frame can advance dtDiveSeconds
    // by up to ~3 s, crossing multiple 2 s boundaries per frame. The old
    // `if` variant consumed one boundary and dropped the remainder, so
    // samples fell behind and clustered irregularly. The `while` catches
    // every boundary crossed this frame — one sample per boundary. Depth/
    // ceiling values are the current end-of-frame values (per issue spec:
    // simple "repeat current values, correct timestamp spacing" is enough
    // to keep the profile chart's cadence stable). Each caught-up sample's
    // timestamp is back-computed from the leftover timer so the entries
    // stay exactly 2 s apart in dive-time even when we're catching up.
    _profileSampleTimer += dtDiveSeconds;
    while (_profileSampleTimer >= 2) {
        _profileSampleTimer -= 2;
        var _sampleT = diveTime - _profileSampleTimer / 60;
        diveProfile.push({t: _sampleT, depth: depth, ceiling: frameCalc.ceiling});
    }

    // Update tissues
    updateTissues(dtDiveMinutes);

    // Issue #14: refresh the per-tick cache now that tissues reflect this
    // frame's update — every read for the rest of this tick, and the
    // renderer's reads later this same frame, use these values instead of
    // recomputing (calculateDecoSchedule() alone was up to ~3000 iterations,
    // previously invoked up to 3x per frame across game-loop.js + renderer.js).
    var _plannerDiagnosticStart = _baselineDiag.start();
    frameCalc.ceiling = calculateCeiling();
    frameCalc.ndl = calculateNDL();
    // Issue #14: pass the ceiling just computed above straight through so
    // calculateDecoSchedule() doesn't call calculateCeiling() again
    // internally, and pass the resulting schedule into calculateTTS() so it
    // doesn't re-run the entire (expensive) schedule simulation a second
    // time this same tick — it previously did both unconditionally.
    frameCalc.schedule = decoStop(frameCalc.ceiling) > 0 ? calculateDecoSchedule(frameCalc.ceiling) : null;
    frameCalc.tts = calculateTTS(frameCalc.ceiling, frameCalc.schedule);
    _baselineDiag.record('planner', _plannerDiagnosticStart);

    // WP-038: Update CNS tracking
    updateCNS(dtDiveMinutes);

    // WP-020: Narcosis update
    updateNarcosis(dtDiveSeconds);

    // Phase C: Update overhead / silt / bad-air state
    updateOverheadState(dtDiveSeconds);

    // Phase C: Guideline laying — sample a breadcrumb while under overhead
    if (inOverhead) {
        _guidelineTimer += dtDiveSeconds;
        if (_guidelineTimer >= GUIDELINE_SAMPLE_SEC) {
            _guidelineTimer = 0;
            guidelineNodes.push({ x: diverX, d: depth });
            if (guidelineNodes.length > GUIDELINE_MAX_NODES) guidelineNodes.shift();
        }
    }

    // Issue #27: Rule-of-thirds gas planning (overhead only). On first entry
    // snapshot the diver's total remaining gas as the reference "full" — for
    // multi-tank tec setups this sums all OC tanks (a cave/wreck plan is over
    // the whole gas supply the diver is carrying, not one bottle). Each tick
    // compute remaining / snapshot -> phase + %; latch turn-phase beep exactly
    // once via thirdsTurnWarned. Leaving the overhead clears the snapshot AND
    // the latches, so a subsequent penetration starts fresh.
    if (inOverhead) {
        if (thirdsStartingGas <= 0) {
            var _thStart = 0;
            for (var _ti = 0; _ti < tankCount; _ti++) {
                _thStart += tanks[_ti].gasRemaining;
            }
            thirdsStartingGas = _thStart;
        }
        var _thNow = 0;
        for (var _tj = 0; _tj < tankCount; _tj++) {
            _thNow += tanks[_tj].gasRemaining;
        }
        var _thFrac = thirdsStartingGas > 0 ? (_thNow / thirdsStartingGas) : 0;
        if (_thFrac < 0) _thFrac = 0;
        if (_thFrac > 1) _thFrac = 1;
        thirdsPct = Math.round(_thFrac * 100);
        if (_thFrac > THIRDS_TURN_FRACTION) {
            thirdsCurrentPhase = 'outbound';
        } else if (_thFrac > THIRDS_RESERVE_FRACTION) {
            thirdsCurrentPhase = 'turn';
            if (!thirdsTurnWarned) {
                thirdsTurnWarned = true;
                playAlertBeep();
            }
        } else {
            thirdsCurrentPhase = 'reserve';
            thirdsReserveActive = true;
            thirdsReserveHitThisDive = true;
        }
    } else if (thirdsStartingGas > 0) {
        // Left the overhead — clear snapshot + latches so the next penetration
        // gets a fresh reference against whatever gas remains at that moment.
        thirdsStartingGas = 0;
        thirdsCurrentPhase = 'outbound';
        thirdsPct = 100;
        thirdsTurnWarned = false;
        thirdsReserveActive = false;
    }

    // Phase B: Current lifecycle — roll once per dive, then run timer + ramp
    // currentBias multiplies the base chance for the active site (0 = never, 1 = open water default)
    if (!current.rolledThisDive && depth > 5) {
        current.rolledThisDive = true;
        var _activeSite = activeSite();
        var _currentChance = _activeSite
            ? CURRENT_PARAMS.chancePerDive * _activeSite.currentBias
            : CURRENT_PARAMS.chancePerDive;
        if (Math.random() < _currentChance) {
            var CP = CURRENT_PARAMS;
            current.direction = Math.random() < 0.5 ? -1 : 1;
            current.strength = CP.minStrength + Math.random() * (CP.maxStrength - CP.minStrength);
            var centreDep = depth;
            current.depthMin = Math.max(0, centreDep - CP.bandMargin);
            current.depthMax = centreDep + CP.bandMargin;
            current.timer = CP.minDuration + Math.random() * (CP.maxDuration - CP.minDuration);
            current.level = 0;
            current.active = true;
        }
    }
    if (current.active) {
        current.timer -= dtDiveSeconds;
        var CP2 = CURRENT_PARAMS;
        if (current.timer > 0) {
            // Ramp level toward strength over rampTime
            var target = current.strength;
            var rampStep = (current.strength / CP2.rampTime) * dtDiveSeconds;
            if (current.level < target) {
                current.level = Math.min(target, current.level + rampStep);
            }
        } else {
            // Ramp level back toward 0
            var rampStep2 = (current.strength / CP2.rampTime) * dtDiveSeconds;
            current.level = Math.max(0, current.level - rampStep2);
            if (current.level === 0) current.active = false;
        }
    }

    // TASK-019: Tank switching (1-6 during dive)
    for (var i = 0; i < tankCount; i++) {
        var key = String(i + 1);
        if (keys[key]) {
            keys[key] = false;
            if (i !== activeTank && tanks[i].gasRemaining > 0) {
                activeTank = i;
                fastForwardActive = false;
                gasSwitchNotifyTime = 2;
                gasSwitchNotifyText = 'GAS SWITCH \u2192 T' + (i + 1) + ': ' + tanks[i].label;
                bestGasAlerted = false;
            }
        }
    }

    // BYP-029: Best gas available info tone
    // Issue #51: recommendBestGas() now returns -1 when no tank satisfies the
    // PO2 window. Suppress the info tone in that case — it would be misleading
    // to chirp "a better gas is available" when the truth is the opposite.
    var bestGasIdx = recommendBestGas();
    if (bestGasIdx !== -1 && bestGasIdx !== activeTank && !bestGasAlerted) {
        playInfoTone();
        bestGasAlerted = true;
    } else if (bestGasIdx === activeTank || bestGasIdx === -1) {
        bestGasAlerted = false;
    }

    // WP-036: Info tone when deco stop depth changes
    var currentDecoStop = decoStop(frameCalc.ceiling);
    if (currentDecoStop > 0 && lastDecoStopDepth > 0 && currentDecoStop !== lastDecoStopDepth) {
        playInfoTone();
    }
    lastDecoStopDepth = currentDecoStop;

    // Gas consumption (effectiveAMV applies exertion multiplier while kicking)
    var pAmb = ambientPressure(depth);
    var kicking = kickDir !== 0 || Math.abs(horizontalVelocity) > FINKICK_PARAMS.exertionThreshold;
    if (diveMode === 'ccr') {
      if (ccrState.onBailout) {
        // OC consumption from diluent cylinder
        var consumed = effectiveAMV(kicking) * pAmb * dtDiveMinutes;
        var dilAvail = ccrState.dilCylPressure * ccrState.dilCylVolume;
        if (consumed > dilAvail) consumed = dilAvail;
        ccrState.dilCylPressure -= consumed / ccrState.dilCylVolume;
        if (ccrState.dilCylPressure < 0) ccrState.dilCylPressure = 0;
      } else {
        updateCCRLoop(dtDiveSeconds, prevDepth);
      }
    } else {
      var baseConsumed = effectiveAMV(kicking) * pAmb * dtDiveMinutes;
      consumed = baseConsumed;
      // Issue #45: Free-flow drill effect. When the free-flow deadline has
      // not yet passed AND the free-flowing reg is on the active tank, the
      // consumption multiplier applies to the diver's breathing. When the
      // free-flowing reg is on a DIFFERENT tank (option 2 — switched to
      // backup), the active tank consumes normally and the old tank drains
      // in parallel at DRILL_FREEFLOW_MULT × base (below).
      var ffActive = drillState.freeflowUntilDiveSec > 0 && diveTime * 60 < drillState.freeflowUntilDiveSec;
      if (ffActive && drillState.freeflowDrainTankIdx === activeTank) {
          consumed = baseConsumed * DRILL_FREEFLOW_MULT;
      }
      var tank = getActiveTank();
      tank.gasRemaining = Math.max(0, tank.gasRemaining - consumed);
      // Parallel free-flow drain on the pre-switch tank (option 2 path).
      if (ffActive && drillState.freeflowDrainTankIdx >= 0 &&
          drillState.freeflowDrainTankIdx !== activeTank) {
          var drainT = tanks[drillState.freeflowDrainTankIdx];
          if (drainT) {
              var drainC = baseConsumed * DRILL_FREEFLOW_MULT;
              drainT.gasRemaining = Math.max(0, drainT.gasRemaining - drainC);
          }
      }

      // Auto-switch if active tank empty — pick best gas for current depth
      if (tank.gasRemaining <= 0) {
          var bestIdx = recommendBestGas();
          if (bestIdx !== -1 && bestIdx !== activeTank && tanks[bestIdx].gasRemaining > 0) {
              activeTank = bestIdx;
              gasSwitchNotifyTime = 2;
              gasSwitchNotifyText = '\u26A0 AUTO SWITCH \u2192 T' + (bestIdx + 1) + ': ' + tanks[bestIdx].label;
          } else if (bestIdx === -1) {
              // Issue #51: no tank has a PO2 inside the operational window.
              // Do NOT silently switch to some other (possibly hypoxic) tank \u2014
              // that used to trip the hypoxia timer as if the diver had chosen
              // it. Alert instead and leave the empty tank active; manual
              // gas-switch keys (1..6) remain available.
              gasSwitchNotifyTime = 2;
              gasSwitchNotifyText = '\u26A0 NO SAFE GAS';
          }
      }
    }

    // CCR setpoint adjustment during dive
    if (diveMode === 'ccr' && !ccrState.onBailout) {
      if (keys['[']) { keys['['] = false; ccrState.targetSP = Math.max(CCR_SP_MIN, +(ccrState.targetSP - CCR_SP_STEP).toFixed(1)); }
      if (keys[']']) { keys[']'] = false; ccrState.targetSP = Math.min(CCR_SP_MAX, +(ccrState.targetSP + CCR_SP_STEP).toFixed(1)); }
    }

    // TASK-032F: Bailout to OC (irreversible)
    if (diveMode === 'ccr' && !ccrState.onBailout) {
      if (keys['b']) {
        keys['b'] = false;
        ccrState.onBailout = true;
      }
    }

    // O2 toxicity
    var po2 = calculatePO2();
    if (po2 > PO2_HIGH) {
        po2ViolationTime += dtDiveSeconds;
    } else {
        po2ViolationTime = Math.max(0, po2ViolationTime - dtDiveSeconds * 0.5);
    }

    // Hypoxia check. Issue #4 (review follow-up): in an active (non-bailout)
    // CCR loop, the CCR-specific 30s check below (ccrHypoxiaTime) is
    // authoritative — but the generic accumulator here was still building
    // up in parallel (both read the same po2/ccrState.actualPO2), so a
    // diver who spent e.g. 12s hypoxic in the loop and then bailed out to
    // a perfectly SAFE gas immediately tripped the generic 10s game-over
    // off the stale pre-bailout value (it only decays at half rate, and
    // the guard on the check below no longer applies once onBailout flips
    // true). Held at 0 during the active loop so it always starts clean
    // from the real bailout-gas PO2 the moment bailout happens.
    if (diveMode === 'ccr' && !ccrState.onBailout) {
        hypoxiaTime = 0;
    } else if (po2 < PO2_HYPOXIA) {
        hypoxiaTime += dtDiveSeconds;
    } else {
        hypoxiaTime = Math.max(0, hypoxiaTime - dtDiveSeconds * 0.5);
    }

    // TASK-032E: CCR-specific failure checks
    if (diveMode === 'ccr' && !ccrState.onBailout) {
      // CCR Hypoxia (PO2 < 0.16 for 30s)
      if (ccrState.actualPO2 < 0.16) {
        ccrHypoxiaTime += dtDiveSeconds;
        if (ccrHypoxiaTime >= 30) {
          gameState = 'gameover';
          gameOverReason = S('ccrHypoxia');
          return;
        }
      } else { ccrHypoxiaTime = 0; }

      // CCR Hyperoxia (PO2 > 1.6 for 30s)
      if (ccrState.actualPO2 > 1.6) {
        ccrHyperoxiaTime += dtDiveSeconds;
        if (ccrHyperoxiaTime >= 30) {
          gameState = 'gameover';
          gameOverReason = S('ccrHyperoxia');
          return;
        }
      } else { ccrHyperoxiaTime = 0; }

      // Scrubber failure / CO2 buildup
      if (ccrState.scrubberRemaining <= 0 && !ccrState.scrubberFailed) {
        ccrState.scrubberFailed = true;
        ccrState.co2BuildupTime = 0;
      }
      if (ccrState.scrubberFailed) {
        ccrState.co2BuildupTime += dtDiveSeconds;
        if (ccrState.co2BuildupTime >= 180) {
          gameState = 'gameover';
          gameOverReason = S('ccrCO2');
          return;
        }
      }
    }

    // DCS check
    var ceilDepth = frameCalc.ceiling;
    if (ceilDepth > 0 && depth < decoStop(ceilDepth)) {
        dcsViolationTime += dtDiveSeconds;
    } else {
        dcsViolationTime = Math.max(0, dcsViolationTime - dtDiveSeconds);
    }

    // Barotrauma check — rapid ascent, OR any ascent at all while
    // breath-holding (issue #45 review follow-up: the freeflow drill's
    // "hold breath" wrong option sets drillState.breathHoldUntilDiveSec —
    // trapped gas expands with Boyle's law on any ascent, not just a fast
    // one, so a held breath makes even a slow ascent dangerous).
    var _breathHolding = drillState.breathHoldUntilDiveSec > 0 &&
        diveTime * 60 < drillState.breathHoldUntilDiveSec;
    if (ascentRate >= BAROTRAUMA_RATE || (_breathHolding && ascentRate > 0)) {
        barotraumaTime += dtDiveSeconds;
    } else {
        barotraumaTime = Math.max(0, barotraumaTime - dtDiveSeconds * 2);
    }

    // Issue #44: Post-dive debriefing — event capture (debounced).
    // Same accumulator-crosses-threshold pattern as po2ViolationTime /
    // barotraumaTime above: one event per sustained violation, not one per
    // frame. _fastAscentAccum is set to -Infinity after firing so a longer
    // sustained violation doesn't fire again until the diver briefly drops
    // below FAST_ASCENT_RATE (which resets the accumulator to 0).
    if (ascentRate > FAST_ASCENT_RATE) {
        _fastAscentAccum += dtDiveSeconds;
        if (ascentRate > _fastAscentPeak) _fastAscentPeak = ascentRate;
        if (_fastAscentAccum >= FAST_ASCENT_EVENT_SEC && _fastAscentPeak > 0) {
            diveEvents.push({ t: diveTime, kind: 'fastAscent', value: _fastAscentPeak });
            _fastAscentAccum = -Infinity;
        }
    } else {
        _fastAscentAccum = 0;
        _fastAscentPeak = 0;
    }
    // Ceiling violation — depth shallower than ceiling minus tolerance,
    // sustained. calculateCeiling() was cached into frameCalc.ceiling
    // earlier this tick; reuse it.
    var _dbCeil = frameCalc.ceiling;
    if (_dbCeil > 0 && depth < _dbCeil - CEILING_VIOLATION_TOL_M) {
        _ceilingViolationAccum += dtDiveSeconds;
        if (_ceilingViolationAccum >= CEILING_VIOLATION_EVENT_SEC) {
            diveEvents.push({ t: diveTime, kind: 'ceilingViolation', value: _dbCeil - depth });
            _ceilingViolationAccum = -Infinity;
        }
    } else {
        _ceilingViolationAccum = 0;
    }
    // Running minimum NDL — only while actually submerged and NDL is finite.
    if (depth > 0.5 && isFinite(frameCalc.ndl) && frameCalc.ndl < minNdlSeen) {
        minNdlSeen = frameCalc.ndl;
    }

    // Adaptive safety stop
    // Track NDL dropping below 5 for duration determination
    if (depth > 0.5 && frameCalc.ndl < 5) {
        ndlDroppedBelow5 = true;
    }
    // Activation: safety stop needed once maxDepth exceeds 11m
    if (maxDepth > 11) {
        safetyStopNeeded = true;
    }
    // Reset: if diver descends back below 11m, safety-stop state resets
    // fully, even if a stop was already completed earlier this dive
    // (issue #90) — a second descent past 11m needs its own stop.
    if (depth > 11) {
        safetyStopCountdownStarted = false;
        safetyStopRemaining = 0;
        safetyStopPaused = false;
        safetyStopComplete = false;
    }
    if (safetyStopNeeded && !safetyStopComplete) {
        // Start countdown: first time depth crosses below 6m
        if (!safetyStopCountdownStarted && depth > 0 && depth < 6) {
            safetyStopCountdownStarted = true;
            safetyStopRemaining = calculateSafetyStopDuration();
            safetyStopPaused = false;
        }
        // Active countdown — see SAFETY_STOP_ACTIVE_MIN_D/MAX_D (issue #68).
        if (safetyStopCountdownStarted) {
            if (depth >= SAFETY_STOP_ACTIVE_MIN_D && depth <= SAFETY_STOP_ACTIVE_MAX_D) {
                safetyStopPaused = false;
                safetyStopRemaining -= dtDiveSeconds;
                if (safetyStopRemaining <= 0) {
                    safetyStopRemaining = 0;
                    safetyStopComplete = true;
                }
            } else {
                safetyStopPaused = true;
            }
        }
    }

    // Bubbles — breathing cycle. dtDiveSeconds drives the phase timer,
    // dtReal is used only for issue #69's framerate-independence math on
    // the exhale-trickle probability.
    updateBreathCycle(dtDiveSeconds, dtReal);
    // BCD exhaust bubbles during fast ascent.
    // Issue #69: 0.3 was a per-frame probability calibrated at 60 fps; at
    // 144 Hz that fired 2.4x more often than intended, dumping a stream of
    // BCD bubbles. Convert to a framerate-independent probability so the
    // expected number of emissions per real second stays constant.
    if (ascentRate > 5 && Math.random() < perSecondToPerFrameProbability(0.3, dtReal)) {
        emitBCDBubbles();
    }
    updateBubbles(dtDiveSeconds);

    // Particles
    updateParticles(dtDiveSeconds);

    // Fish
    updateFish(dtReal);
    updateWildlife(dtReal);

    // TASK-043: Shark spawn & movement
    sharkTimer -= dtDiveSeconds;
    if (sharkTimer <= 0) {
        sharkTimer = 60;
        var _noSharkSite = activeSite();
        if (!shark && Math.random() < 0.005 && !(_noSharkSite && _noSharkSite.noShark)) {
            var sharkDir = Math.random() < 0.5 ? 1 : -1;
            var W = cssWidth;
            // Spawn just off the visible screen edge in world metres
            var sharkStartX = sharkDir > 0
                ? diverX - (W * DIVER_SCREEN_X_FRACTION + 100) * 0.05
                : diverX + (W * (1 - DIVER_SCREEN_X_FRACTION) + 100) * 0.05;
            shark = {
                x: sharkStartX,  // world metres
                depth: Math.max(0, Math.min(MAX_DEPTH, depth + (Math.random() * 20 - 10))),
                direction: sharkDir,
                speed: 2.5 * 0.05 * 60, // m/s (old unit × WORLD_MPS)
                phase: 0,
                size: 45
            };
        }
    }
    if (shark) {
        shark.x += shark.direction * shark.speed * dtReal; // world metres
        shark.phase += dtReal * 3;
        // Track toward diver depth
        var depthDiff = depth - shark.depth;
        var depthDrift = 0.3 * dtDiveSeconds;
        if (Math.abs(depthDiff) > 0.1) {
            shark.depth += Math.sign(depthDiff) * Math.min(depthDrift, Math.abs(depthDiff));
        }
        // Issue #42: minimal floor guard — the scripted encounter is otherwise
        // untouched. Prevents the shark from swimming through solid seabed on
        // shore/wreck floors as it tracks a shallow diver.
        var _sharkFloor = floorAt(shark.x);
        if (shark.depth > _sharkFloor - FAUNA_AVOID_MARGIN) {
            shark.depth = _sharkFloor - FAUNA_AVOID_MARGIN;
        }
        // Collision check — world-space: 2m radius (≈ 40px). Diver can dodge by swimming away.
        if (!shark.passed && Math.abs(shark.x - diverX) < 2 && Math.abs(shark.depth - depth) < 3) {
            shark.passed = true;
            if (Math.random() < 0.33) {
                gameOverReason = 'SHARK ATTACK';
                gameState = 'gameover';
                return;
            }
            shark.speed = 4 * 0.05 * 60; // m/s
        }
        // Remove once it has passed well beyond the visible area
        var W2 = cssWidth;
        if ((shark.direction > 0 && shark.x > diverX + (W2 * (1 - DIVER_SCREEN_X_FRACTION) + 150) * 0.05) ||
            (shark.direction < 0 && shark.x < diverX - (W2 * DIVER_SCREEN_X_FRACTION + 150) * 0.05)) {
            shark = null;
        }
    }

    // --- GAME OVER CHECKS ---

    // All tanks empty / CCR out of gas
    if (diveMode === 'ccr') {
      if (ccrState.onBailout && ccrState.dilCylPressure <= 0) {
        gameOverReason = 'OUT OF GAS';
        gameState = 'gameover';
        return;
      }
    } else {
      var allEmpty = true;
      for (var gi = 0; gi < tankCount; gi++) {
          if (tanks[gi].gasRemaining > 0) { allEmpty = false; break; }
      }
      // Issue #51: an empty active tank with no safe switch target is
      // functionally the same emergency as every tank being empty. Without
      // this, an empty active tank whose only non-empty alternative is
      // unsafe at the current depth (recommendBestGas() correctly refuses
      // to auto-switch to it) was left silently active — calculatePO2()
      // keeps reading its fO2 as if gas were still flowing, so no PO2/
      // hypoxia timer ever detects that the diver has nothing to breathe.
      var activeEmptyNoSafeAlt = tanks[activeTank].gasRemaining <= 0 && recommendBestGas() === -1;
      if (allEmpty || activeEmptyNoSafeAlt) {
          gameOverReason = 'OUT OF GAS';
          gameState = 'gameover';
          return;
      }
    }

    if (po2ViolationTime >= PO2_TOXICITY_TIME) {
        gameOverReason = 'O2 TOXICITY \u2014 CNS SEIZURE';
        gameState = 'gameover';
        return;
    }

    if (dcsViolationTime >= DCS_VIOLATION_TIME) {
        gameOverReason = 'DECOMPRESSION SICKNESS';
        gameState = 'gameover';
        return;
    }

    if (barotraumaTime >= BAROTRAUMA_TIME) {
        gameOverReason = 'PULMONARY BAROTRAUMA \u2014 PNEUMOTHORAX';
        gameState = 'gameover';
        return;
    }

    // Issue #4: in an active CCR loop (not on bailout), calculatePO2() reads
    // ccrState.actualPO2 \u2014 the same value the CCR-specific 30s hypoxia check
    // above accumulates from. This generic 10s threshold is tuned for an OC
    // diver's faster PO2 drop and must not pre-empt the CCR-specific check.
    if (hypoxiaTime >= 10 && !(diveMode === 'ccr' && !ccrState.onBailout)) {
        gameOverReason = 'HYPOXIA \u2014 LOSS OF CONSCIOUSNESS';
        gameState = 'gameover';
        return;
    }

    // WP-020: Narcosis unconsciousness
    if (narcosisKOTime >= NARC_KO_TIME) {
        gameOverReason = 'NITROGEN NARCOSIS \u2014 UNCONSCIOUSNESS';
        gameState = 'gameover';
        return;
    }

    if (depth < 0.5 && ceilDepth > 3) {
        gameOverReason = 'DECOMPRESSION SICKNESS';
        gameState = 'gameover';
        return;
    }

    if (depth < 0.3 && diveTime > 0.5 && ceilDepth <= 0.1) {
        if (maxDepth > 2) {
            // Issue #44: record the safety-stop-skipped debriefing event
            // exactly once, at the moment of surfacing, if the diver's max
            // depth crossed the safety-stop trigger but the stop wasn't
            // completed. Recorded here so the debriefing card and the
            // profile-chart marker both see the same log.
            if (safetyStopNeeded && !safetyStopComplete) {
                diveEvents.push({ t: diveTime, kind: 'safetyStopSkipped', value: 0 });
            }
            gameState = 'post-dive';
            return;
        }
    }

    // Phase A/B: Update HUD data attributes for overlay elements
    var hudSpeed = document.getElementById('hud-horizontal-speed');
    if (hudSpeed) {
        var absSp = Math.abs(horizontalVelocity);
        if (absSp > 0.01) {
            hudSpeed.style.display = '';
            hudSpeed.setAttribute('data-dir', horizontalVelocity > 0 ? '1' : '-1');
            hudSpeed.setAttribute('data-speed', absSp.toFixed(1));
            var arrow = hudSpeed.querySelector('[data-bind="arrow"]');
            var spd = hudSpeed.querySelector('[data-bind="speed"]');
            if (arrow) arrow.textContent = horizontalVelocity > 0 ? '→' : '←';
            if (spd) spd.textContent = absSp.toFixed(1) + ' m/s';
        } else {
            hudSpeed.style.display = 'none';
        }
    }
    var hudCurrent = document.getElementById('hud-current');
    if (hudCurrent) {
        if (current.active && current.level > 0.01) {
            hudCurrent.style.display = '';
            hudCurrent.setAttribute('data-dir', current.direction);
            hudCurrent.setAttribute('data-strength', current.level.toFixed(2));
            var cArrow = hudCurrent.querySelector('[data-bind="arrow"]');
            var cStr = hudCurrent.querySelector('[data-bind="strength"]');
            if (cArrow) cArrow.textContent = current.direction > 0 ? '⇒' : '⇐';
            if (cStr) cStr.textContent = current.level.toFixed(2) + ' m/s';
        } else {
            hudCurrent.style.display = 'none';
        }
    }
    // Issue #27: rule-of-thirds gauge visibility + attributes. Only visible
    // while actually inside an overhead during the diving state — style.css
    // renders phase colour + text and gas % from the data attributes.
    var hudThirds = document.getElementById('hud-thirds');
    if (hudThirds) {
        if (inOverhead && gameState === 'diving') {
            hudThirds.style.display = '';
            hudThirds.setAttribute('data-phase', thirdsCurrentPhase);
            hudThirds.setAttribute('data-pct', String(thirdsPct));
        } else {
            hudThirds.style.display = 'none';
        }
    }
    // Issue #37: back-way chip — direction + distance to boat/entry point.
    // Pure display: computeBackwayState() decides show/hide from
    // activeSite() + diverX, and the DOM update just mirrors it.
    var hudBack = document.getElementById('hud-backway');
    if (hudBack) {
        var backState = computeBackwayState();
        if (backState.visible) {
            hudBack.style.display = '';
            hudBack.setAttribute('data-dir', backState.direction);
            hudBack.setAttribute('data-distance', backState.distance);
            var bArrow = hudBack.querySelector('[data-bind="arrow"]');
            var bDist = hudBack.querySelector('[data-bind="distance"]');
            if (bArrow) bArrow.textContent = backState.direction < 0 ? '◄' : '►';
            if (bDist) bDist.textContent = backState.distance + ' m';
        } else {
            hudBack.style.display = 'none';
        }
    }
}

// Issue #37: Back-way chip state.
// Pure function of diveSite + inOverhead + diverX. Returns
//   { visible, direction: -1|0|+1, distance: integer metres, boatX }.
// Hide rules (visible=false):
//   • gameState !== 'diving'
//   • activeSite() is null (open water — no anchor to point at)
//   • activeSite().hasOverhead === true (cave / wreck — guideline serves)
//   • inOverhead is true (belt-and-braces: inside a structure)
//   • the site has no boatX
//   • |diverX - boatX| <= BACKWAY_MIN_DISTANCE_M (chip is noise near entry)
function computeBackwayState() {
    var hidden = { visible: false, direction: 0, distance: 0, boatX: null };
    if (gameState !== 'diving') return hidden;
    var s = activeSite();
    if (!s) return hidden;
    if (s.hasOverhead) return hidden;
    if (inOverhead) return hidden;
    if (s.boatX == null) return hidden;
    var dx = s.boatX - diverX;
    var absDx = Math.abs(dx);
    if (absDx <= BACKWAY_MIN_DISTANCE_M) return hidden;
    return {
        visible: true,
        direction: dx < 0 ? -1 : 1,
        distance: Math.round(absDx),
        boatX: s.boatX
    };
}

// SECTION: Main game loop
// SEARCH TERMS: gameLoop, requestAnimationFrame, lastFrameTime, TIME_ACCELERATION

// ============================================================
//  MAIN GAME LOOP
// ============================================================

function gameLoop(timestamp) {
    if (window.__baselineCapturePaused) {
        requestAnimationFrame(gameLoop);
        return;
    }
    var _frameDiagnosticStart = _baselineDiag.start();
    if (!lastFrameTime) lastFrameTime = timestamp;
    var dtReal = (timestamp - lastFrameTime) / 1000;
    lastFrameTime = timestamp;
    dtReal = Math.min(dtReal, 0.1);

    ctx.clearRect(0, 0, cssWidth, cssHeight);

    // Issue #120: reset the result-screen scroll on entry, so a second dive
    // never opens mid-page. Detected as a transition rather than reset at each
    // `gameState = 'post-dive'` / `'gameover'` assignment — there are 13 of
    // those and a 14th would silently miss it.
    if (gameState !== _lastGameState) {
        if (gameState === 'post-dive' || gameState === 'gameover') resetResultScroll();
        // Issue #120: the four in-dive HUD chips are shown/hidden inside
        // updateDiving(), which stops being called the moment the dive ends —
        // so whatever was on screen at that instant stayed on screen. Ending a
        // wreck or cave dive left the rule-of-thirds chip latched on, sitting
        // over the post-dive header. Clear them on any exit from 'diving'
        // rather than at each of the 13 places that end a dive.
        if (_lastGameState === 'diving' && gameState !== 'diving') {
            var _chipIds = ['hud-horizontal-speed', 'hud-current', 'hud-thirds', 'hud-backway'];
            for (var _ci = 0; _ci < _chipIds.length; _ci++) {
                var _chip = document.getElementById(_chipIds[_ci]);
                if (_chip) _chip.style.display = 'none';
            }
        }
        _lastGameState = gameState;
    }

    switch (gameState) {
        case 'gas-setup':
            updateGasSetup();
            document.getElementById('html-gas-setup').style.display = 'block';
            buildHtmlGasSetup();
            break;
        case 'surface':
            document.getElementById('html-gas-setup').style.display = 'none';
            _gsBuilt = false;
            updateSurface(dtReal);
            drawSurface();
            if (showHelp && !_helpShown) { showHtmlHelp(); _helpShown = true; }
            if (!showHelp && _helpShown) { hideHtmlHelp(); _helpShown = false; }
            break;
        case 'diving':
            document.getElementById('html-gas-setup').style.display = 'none';
            if (!showHelp && !showGasInfo) {
                var _updateDiagnosticStart = _baselineDiag.start();
                updateDiving(dtReal);
                _baselineDiag.record('update', _updateDiagnosticStart);
            }
            var _renderDiagnosticStart = _baselineDiag.start();
            drawScene();
            drawDiveComputer();
            // Issue #45: torch-flicker pre-roll for the lightFailure drill.
            // Only fires when drillState.phase === 'flicker' && id === 'lightFailure'.
            drawDrillFlicker();
            _baselineDiag.record('render', _renderDiagnosticStart);
            if (showHelp && !_helpShown) { showHtmlHelp(); _helpShown = true; }
            if (!showHelp && _helpShown) { hideHtmlHelp(); _helpShown = false; }
            break;
        case 'drill':
            // Issue #45: Scripted-drill pause. Physics does NOT tick — the
            // scene renders as a frozen snapshot with the decision overlay
            // (or debrief card, depending on drillState.phase) painted on
            // top. Real-time still advances so the debrief auto-dismiss and
            // any future auto-time-out on undecided drills works, but no
            // gas / tissue / clock updates run.
            document.getElementById('html-gas-setup').style.display = 'none';
            _updateDrillTiming(dtReal);
            _renderDiagnosticStart = _baselineDiag.start();
            drawScene();
            drawDiveComputer();
            if (drillState.phase === 'debrief') {
                drawDrillDebrief();
                if (keys['enter']) {
                    keys['enter'] = false;
                    dismissDrillDebrief();
                }
            } else {
                drawDrillOverlay();
                // Keyboard selection: 1/2/3 map to the currently-visible
                // options (which may be filtered by requiresMultiTank).
                for (var _dk = 1; _dk <= 3; _dk++) {
                    if (keys[String(_dk)]) {
                        keys[String(_dk)] = false;
                        resolveDrillOption(_dk - 1);
                        break;
                    }
                }
            }
            _baselineDiag.record('render', _renderDiagnosticStart);
            break;
        case 'gameover':
            document.getElementById('html-gas-setup').style.display = 'none';
            // TASK-031D: Close gas info on gameover
            if (_gasInfoShown) { hideHtmlGasInfo(); _gasInfoShown = false; }
            _renderDiagnosticStart = _baselineDiag.start();
            drawScene();
            drawGameOver();
            _baselineDiag.record('render', _renderDiagnosticStart);
            if (keys['enter']) {
                keys['enter'] = false;
                gameState = 'gas-setup';
            }
            break;
        case 'post-dive':
            document.getElementById('html-gas-setup').style.display = 'none';
            // TASK-031D: Close gas info on postdive
            if (_gasInfoShown) { hideHtmlGasInfo(); _gasInfoShown = false; }
            drawPostDive();
            if (showHelp && !_helpShown) { showHtmlHelp(); _helpShown = true; }
            if (!showHelp && _helpShown) { hideHtmlHelp(); _helpShown = false; }
            if (!showHelp && keys['enter']) {
                keys['enter'] = false;
                gameState = 'gas-setup';
            }
            break;
    }

    // Periodic dive state save + beforeunload guard
    maybeSaveDiveState(timestamp);

    _baselineDiag.record('frame', _frameDiagnosticStart);
    requestAnimationFrame(gameLoop);
}

// SECTION: Bootstrap
// SEARCH TERMS: initTanks, initTissues, resize, first frame

// ============================================================
//  BOOTSTRAP
// ============================================================

// SECTION: Dive state persistence (localStorage)
// SEARCH TERMS: saveDiveState, loadSavedDive, localStorage, beforeunload, _lastSaveTime

// ============================================================
//  DIVE STATE PERSISTENCE (localStorage + beforeunload)
// ============================================================

var SAVE_KEY = 'diveSim_savedState';
var SAVE_INTERVAL_MS = 3000;
var _lastSaveTime = 0;
// Issue #66: restoreDiveState() used to blindly assign every field from a
// parsed localStorage payload. A save from an older/divergent version with
// missing or malformed fields (e.g. tissues.length !== 16) fed `undefined`
// straight into tissue/physics calculations, propagating NaN through the
// whole simulation. Bump this whenever saveDiveState()'s shape changes in
// a way that would make an old save invalid to restore.
//
// v1 -> v2 (issue #45/#66 review follow-up): drillState/drillHasRunThisDive
// became mandatory fields. Policy is explicit rejection, not migration — a
// v1 payload with gameState==='drill' has no recorded drillState.phase/id
// at all, and reconstructing one would mean guessing at lost information
// (the exact failure mode this version bump exists to prevent). v1 saves
// are short-lived by nature (auto-expired after 1 hour regardless, see
// loadSavedDive()'s staleness check below), so outright rejection just
// means an in-flight v1 dive doesn't resume across this one deploy — a
// deliberately small, bounded cost against re-introducing a stuck state.
var SAVE_STATE_VERSION = 2;

// Minimal plausibility check — not a full schema validator, just enough to
// catch a payload that can't safely feed restoreDiveState(): wrong version,
// missing/wrong-length tissue arrays, or non-finite core numbers.
function _isValidSaveState(state) {
    if (!state || typeof state !== 'object') return false;
    if (state.saveVersion !== SAVE_STATE_VERSION) return false;
    if (!Array.isArray(state.tissues) || state.tissues.length !== 16) return false;
    if (!Array.isArray(state.tissuesHe) || state.tissuesHe.length !== 16) return false;
    // Issue #66 (review follow-up round 2): the global isFinite() coerces
    // its argument first (isFinite("20")===true, isFinite(null)===true,
    // isFinite(true)===true) — a string/null/boolean payload value would
    // silently pass every check below and then, post-restore, corrupt
    // physics via string concatenation (`depth += ...`) instead of a
    // rejected save. Number.isFinite() does not coerce. Every check in
    // this function now uses it.
    if (!state.tissues.every(Number.isFinite) || !state.tissuesHe.every(Number.isFinite)) return false;
    if (!Array.isArray(state.tanks) || state.tanks.length < 1) return false;
    if (!Number.isFinite(state.depth) || !Number.isFinite(state.maxDepth)) return false;

    // Issue #66 (review follow-up): the checks above only covered depth and
    // the tissue arrays — every other field restoreDiveState() assigns
    // directly with no fallback (time/average fields, velocities, GF/AMV,
    // per-tank contents, mode-dependent CCR state) passed straight through
    // unvalidated. A payload missing any of these fed `undefined` into
    // live physics/consumption math, propagating NaN from the very next
    // tick onward.
    var finiteFields = [
        'diveTime', 'avgDepthAccum', 'avgDepthSamples',
        'ascentRate', 'verticalVelocity', 'currentVerticalRate', 'bcdGasSurfaceLiters',
        'barotraumaTime', 'hypoxiaTime', 'po2ViolationTime', 'dcsViolationTime',
        'safetyStopRemaining', 'narcosisIndex', 'narcosisKOTime', 'narcDrift',
        'gfLow', 'gfHigh', 'amvRate', 'tankCount', 'activeTank',
        'sharkTimer', 'ccrHypoxiaTime', 'ccrHyperoxiaTime'
    ];
    for (var fi = 0; fi < finiteFields.length; fi++) {
        if (!Number.isFinite(state[finiteFields[fi]])) return false;
    }
    // tanks.length is always kept exactly equal to tankCount (gsAddTank()/
    // gsRemoveTank() push/pop in lockstep) — a mismatch means a malformed
    // or hand-edited payload. tankCount is a discrete count, not just any
    // finite number.
    if (!Number.isInteger(state.tankCount) || state.tankCount < 1 || state.tankCount !== state.tanks.length) return false;
    // Issue #66 (review follow-up): isFinite(0.5) is true, so a fractional
    // activeTank previously slipped through — tanks[0.5] doesn't exist.
    if (!Number.isInteger(state.activeTank) || state.activeTank < 0 || state.activeTank >= state.tankCount) return false;
    if (['rec', 'tec', 'ccr'].indexOf(state.diveMode) === -1) return false;
    // Issue #66 (review follow-up): saveDiveState() only ever writes while
    // gameState is one of these three (see its own guard) — anything else
    // is not a payload this function could have produced.
    if (['diving', 'surface', 'drill'].indexOf(state.gameState) === -1) return false;
    // Issue #66 (review follow-up): loadSavedDive()'s staleness check
    // (Date.now() - state.savedAt > 3600000) silently passes for a
    // non-finite savedAt, since any comparison against NaN is false.
    if (!Number.isFinite(state.savedAt) || state.savedAt <= 0) return false;
    // Issue #66 (review follow-up round 5): an unknown diveSite makes
    // activeSite() return null everywhere — every overhead/silt/thirds/
    // guideline mechanic silently no-ops as if the diver were in open
    // water forever, rather than restoring the real site the dive was
    // actually on. 'open' is a genuine, intentional value here though (see
    // its own declaration in state.js: 'open' | 'shore' | 'reef' | 'wreck'
    // | 'cave') — it's diveSite's actual default before the gas-setup site
    // picker is ever touched, and nothing forces a selection before
    // startDiveAction(), so a real save can legitimately carry it. Only
    // reject values that are neither 'open' nor a real DIVE_SITES key.
    if (state.diveSite !== 'open' && !DIVE_SITES[state.diveSite]) return false;

    // Issue #66 (review follow-up): restoreDiveState() copies state.current
    // field-by-field with no fallback when state.current exists but is
    // missing individual fields (e.g. a partial {active:true}) — each
    // missing field becomes undefined on the live `current` object.
    if (!state.current || typeof state.current !== 'object') return false;
    if (typeof state.current.active !== 'boolean') return false;
    if (typeof state.current.rolledThisDive !== 'boolean') return false;
    var currentFiniteFields = ['direction', 'strength', 'level', 'depthMin', 'depthMax', 'timer'];
    for (var cufi = 0; cufi < currentFiniteFields.length; cufi++) {
        if (!Number.isFinite(state.current[currentFiniteFields[cufi]])) return false;
    }

    // Per-tank contents.
    var tankFields = ['fO2', 'fHe', 'fN2', 'pressure', 'volume', 'totalGas', 'gasRemaining'];
    for (var ti = 0; ti < state.tanks.length; ti++) {
        var t = state.tanks[ti];
        if (!t || typeof t !== 'object') return false;
        for (var tfi = 0; tfi < tankFields.length; tfi++) {
            if (!Number.isFinite(t[tankFields[tfi]])) return false;
        }
    }

    // Mode-dependent CCR state — restoreDiveState() assigns state.ccrState
    // wholesale with no per-field fallback, so a missing/malformed field
    // here (e.g. actualPO2) would feed NaN straight into calculatePO2()
    // and the tissue-loading loop on the very next CCR tick.
    var ccrFields = [
        'o2CylVolume', 'o2CylPressure', 'dilCylVolume', 'dilCylPressure',
        'dilFO2', 'dilFN2', 'dilFHe', 'loopVolume', 'targetSP', 'actualPO2',
        'scrubberTotal', 'scrubberRemaining', 'metabolicO2Rate', 'po2ResponseRate',
        'co2BuildupTime'
    ];
    if (!state.ccrState || typeof state.ccrState !== 'object') return false;
    for (var ci = 0; ci < ccrFields.length; ci++) {
        if (!Number.isFinite(state.ccrState[ccrFields[ci]])) return false;
    }

    // Issue #45/#66 (review follow-up, blocker): drill runtime state.
    // restoreDiveState() assigns every drillState field directly with no
    // fallback — a missing/malformed field here (or a payload from before
    // this was added) would leave drillState half-restored, and a
    // gameState==='drill' payload with drillState.phase !=='inactive'
    // couldn't safely resume at all (no overlay to interact with).
    if (!state.drillState || typeof state.drillState !== 'object') return false;
    if (typeof state.drillHasRunThisDive !== 'boolean') return false;
    var validDrillPhases = ['inactive', 'flicker', 'overlay', 'debrief', 'effect'];
    if (validDrillPhases.indexOf(state.drillState.phase) === -1) return false;
    if (state.drillState.id !== null && typeof state.drillState.id !== 'string') return false;
    if (!Number.isInteger(state.drillState.selectedOption)) return false;
    if (typeof state.drillState.correct !== 'boolean') return false;
    var drillFiniteFields = ['startedAt', 'flickerRemainingSec', 'debriefRemainingSec',
        'freeflowUntilDiveSec', 'lightRestoreAt', 'breathHoldUntilDiveSec'];
    for (var dfi = 0; dfi < drillFiniteFields.length; dfi++) {
        if (!Number.isFinite(state.drillState[drillFiniteFields[dfi]])) return false;
    }

    // Cross-field consistency, verified directly against the state machine
    // (startDrill()/_openDrillOverlay()/resolveDrillOption()/
    // dismissDrillDebrief()), not just inferred from comments:
    //   - startDrill('lightFailure') sets phase='flicker' WITHOUT touching
    //     gameState — flicker only ever coexists with gameState='diving',
    //     never 'drill' (that only happens once _openDrillOverlay() runs,
    //     which is what flicker transitions INTO).
    //   - _openDrillOverlay() is the only place that sets gameState='drill',
    //     and it always pairs that with phase='overlay'; resolveDrillOption()
    //     is the only transition out of 'overlay', into 'debrief' — gameState
    //     stays 'drill' throughout both.
    //   - dismissDrillDebrief() is the only transition out of 'debrief',
    //     into 'effect' AND back to gameState='diving' — 'effect' never
    //     reverts to 'inactive' on its own (only a fresh startDrill() call
    //     or resetDive() ever leaves it), so it can legitimately still be
    //     the recorded phase at 'diving' or 'surface' much later.
    //   - startDiveAction() is the only place gameState becomes 'surface',
    //     and it always immediately follows resetDive() (which wipes
    //     drillState back to {phase:'inactive', id:null,...}) — 'surface'
    //     can therefore only ever coexist with phase='inactive'.
    var drillPhasesByGameState = {
        drill: ['overlay', 'debrief'],
        diving: ['inactive', 'flicker', 'effect'],
        surface: ['inactive']
    };
    var allowedPhases = drillPhasesByGameState[state.gameState];
    if (allowedPhases && allowedPhases.indexOf(state.drillState.phase) === -1) return false;

    // Issue #66 (review follow-up round 3): an active drill phase with a
    // null or unrecognized id recreates the exact stuck-forever bug the
    // previous fix targeted — drawDrillOverlay()/resolveDrillOption() both
    // key off _drillById(drillState.id) and silently no-op/refuse when it
    // returns null, so the diver is paused with nothing to interact with.
    if (state.drillState.phase === 'inactive') {
        if (state.drillState.id !== null) return false;
    } else {
        // flicker/overlay/debrief/effect all require a real catalog entry.
        if (!_drillById(state.drillState.id)) return false;
        // flicker is exclusively the lightFailure pre-roll (startDrill()'s
        // only branch that sets phase='flicker') — no other drill ever
        // produces this phase.
        if (state.drillState.phase === 'flicker' && state.drillState.id !== 'lightFailure') return false;
    }

    // Issue #66 (review follow-up round 3): freeflowDrainTankIdx is only
    // ever a real tank index (>=0) while an effect is actually running
    // (freeflowUntilDiveSec>0) — the expiry handler in updateDiving()
    // resets BOTH fields together back to (0, -1) in the same tick, so the
    // two must always agree. Bounding it against tankCount also prevents a
    // restored effect from indexing a tank that doesn't exist.
    if (!Number.isInteger(state.drillState.freeflowDrainTankIdx)) return false;
    if (state.drillState.freeflowUntilDiveSec > 0) {
        if (state.drillState.freeflowDrainTankIdx < 0 || state.drillState.freeflowDrainTankIdx >= state.tankCount) return false;
    } else if (state.drillState.freeflowDrainTankIdx !== -1) {
        return false;
    }

    return true;
}

function saveDiveState() {
    // Issue #45: 'drill' is a paused-but-inside-dive state — treated the
    // same as 'diving' for persistence purposes so the save game is not
    // cleared while the decision overlay is up.
    if (gameState !== 'diving' && gameState !== 'surface' && gameState !== 'drill') return;
    var state = {
        saveVersion: SAVE_STATE_VERSION,
        gameState: gameState,
        depth: depth,
        maxDepth: maxDepth,
        avgDepthAccum: avgDepthAccum,
        avgDepthSamples: avgDepthSamples,
        diveTime: diveTime,
        ascentRate: ascentRate,
        verticalVelocity: verticalVelocity,
        bcdGasSurfaceLiters: bcdGasSurfaceLiters,
        currentVerticalRate: currentVerticalRate,
        barotraumaTime: barotraumaTime,
        hypoxiaTime: hypoxiaTime,
        po2ViolationTime: po2ViolationTime,
        dcsViolationTime: dcsViolationTime,
        safetyStopRemaining: safetyStopRemaining,
        safetyStopNeeded: safetyStopNeeded,
        safetyStopComplete: safetyStopComplete,
        safetyStopCountdownStarted: safetyStopCountdownStarted,
        safetyStopPaused: safetyStopPaused,
        ndlDroppedBelow5: ndlDroppedBelow5,
        cnsPercent: cnsPercent,
        breathPhase: breathPhase,
        breathTimer: breathTimer,
        exhaleEmitted: exhaleEmitted,
        narcosisIndex: narcosisIndex,
        narcosisKOTime: narcosisKOTime,
        narcDrift: narcDrift,
        tissues: tissues.slice(),
        tissuesHe: tissuesHe.slice(),
        tanks: tanks.map(function(t) { return { fO2: t.fO2, fHe: t.fHe, fN2: t.fN2, pressure: t.pressure, volume: t.volume, totalGas: t.totalGas, gasRemaining: t.gasRemaining, label: t.label, switchDepth: t.switchDepth }; }),
        activeTank: activeTank,
        tankCount: tankCount,
        diveMode: diveMode,
        amvRate: amvRate,
        gfLow: gfLow,
        gfHigh: gfHigh,
        ccrState: JSON.parse(JSON.stringify(ccrState)),
        ccrHypoxiaTime: ccrHypoxiaTime,
        ccrHyperoxiaTime: ccrHyperoxiaTime,
        sharkTimer: sharkTimer,
        diveProfile: diveProfile,
        // Issue #44: persist debriefing state so a reload mid-dive keeps the
        // event log and running-min NDL. JSON can't round-trip Infinity, so
        // encode the "no NDL observed yet" sentinel as null.
        diveEvents: diveEvents.slice(),
        minNdlSeen: isFinite(minNdlSeen) ? minNdlSeen : null,
        // Issue #44/#27: per-dive latch consumed by gradeDive() — must
        // survive a reload mid-dive the same as the rest of the debrief
        // event log above.
        thirdsReserveHitThisDive: thirdsReserveHitThisDive,
        // Issue #45/#66 (review follow-up, blocker): saveDiveState() allows
        // gameState==='drill' but never persisted drillState at all — on
        // resume, gameState came back as 'drill' while drillState reset to
        // its {phase:'inactive'} default, leaving the diver in a paused
        // state with no visible overlay and no way to interact
        // (resolveDrillOption/dismissDrillDebrief both refuse to act
        // outside their expected phase). flickerUntilReal/debriefUntilReal
        // are performance.now()-based real-time deadlines that mean nothing
        // after a reload (the clock restarts at 0), so they're saved as a
        // REMAINING duration instead of an absolute deadline; every other
        // drillState timer is already dive-time based (survives via
        // diveTime, already saved above) so it round-trips as-is.
        // optionRects is a per-frame renderer hit-test cache, not state.
        drillHasRunThisDive: drillHasRunThisDive,
        drillState: {
            phase: drillState.phase,
            id: drillState.id,
            startedAt: drillState.startedAt,
            selectedOption: drillState.selectedOption,
            correct: drillState.correct,
            flickerRemainingSec: drillState.phase === 'flicker'
                ? Math.max(0, drillState.flickerUntilReal - _drillRealTime()) : 0,
            debriefRemainingSec: drillState.phase === 'debrief'
                ? Math.max(0, drillState.debriefUntilReal - _drillRealTime()) : 0,
            freeflowUntilDiveSec: drillState.freeflowUntilDiveSec,
            freeflowDrainTankIdx: drillState.freeflowDrainTankIdx,
            lightRestoreAt: drillState.lightRestoreAt,
            breathHoldUntilDiveSec: drillState.breathHoldUntilDiveSec
        },
        diverX: diverX,
        horizontalVelocity: horizontalVelocity,
        current: { active: current.active, direction: current.direction, strength: current.strength, level: current.level, depthMin: current.depthMin, depthMax: current.depthMax, timer: current.timer, rolledThisDive: current.rolledThisDive },
        // Phase C
        diveSite: diveSite,
        guidelineNodes: guidelineNodes.slice(),
        visibility: visibility,
        torchOn: torchOn,
        savedAt: Date.now()
    };
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(state)); } catch {}
}

function clearSavedDive() {
    try { localStorage.removeItem(SAVE_KEY); } catch {}
}

function loadSavedDive() {
    try {
        var raw = localStorage.getItem(SAVE_KEY);
        if (!raw) return null;
        var state = JSON.parse(raw);
        // Reject stale saves (older than 1 hour)
        if (Date.now() - state.savedAt > 3600000) { clearSavedDive(); return null; }
        // Issue #66: reject saves that don't match the current shape/version
        // or fail a basic plausibility check, instead of feeding malformed
        // data into restoreDiveState().
        if (!_isValidSaveState(state)) { clearSavedDive(); return null; }
        return state;
    } catch { return null; }
}

function restoreDiveState(state) {
    gameState = state.gameState;
    depth = state.depth;
    maxDepth = state.maxDepth;
    avgDepthAccum = state.avgDepthAccum;
    avgDepthSamples = state.avgDepthSamples;
    diveTime = state.diveTime;
    ascentRate = state.ascentRate;
    verticalVelocity = state.verticalVelocity;
    bcdGasSurfaceLiters = state.bcdGasSurfaceLiters;
    currentVerticalRate = state.currentVerticalRate;
    barotraumaTime = state.barotraumaTime;
    hypoxiaTime = state.hypoxiaTime;
    po2ViolationTime = state.po2ViolationTime;
    dcsViolationTime = state.dcsViolationTime;
    safetyStopRemaining = state.safetyStopRemaining;
    safetyStopNeeded = state.safetyStopNeeded;
    safetyStopComplete = state.safetyStopComplete;
    safetyStopCountdownStarted = state.safetyStopCountdownStarted;
    safetyStopPaused = state.safetyStopPaused;
    ndlDroppedBelow5 = state.ndlDroppedBelow5;
    // BUG-10: cnsPercent was missing from save/restore -- CNS O2 toxicity
    // display reset to 0% on resume even though the dive continued.
    // || 0 fallback for saves written before this field existed.
    cnsPercent = state.cnsPercent || 0;
    breathPhase = state.breathPhase || 'inhale';
    breathTimer = state.breathTimer != null ? state.breathTimer : BREATH_CYCLE_INHALE;
    exhaleEmitted = !!state.exhaleEmitted;
    narcosisIndex = state.narcosisIndex;
    narcosisKOTime = state.narcosisKOTime;
    narcDrift = state.narcDrift;
    tissues = state.tissues;
    tissuesHe = state.tissuesHe;
    tanks = state.tanks;
    activeTank = state.activeTank;
    tankCount = state.tankCount;
    diveMode = state.diveMode;
    amvRate = state.amvRate;
    gfLow = state.gfLow;
    gfHigh = state.gfHigh;
    ccrState = state.ccrState;
    ccrHypoxiaTime = state.ccrHypoxiaTime;
    ccrHyperoxiaTime = state.ccrHyperoxiaTime;
    sharkTimer = state.sharkTimer;
    diveProfile = state.diveProfile || [];
    // Issue #44: restore debriefing state; missing fields (older save) fall
    // back to the resetDive() defaults so an older payload doesn't crash.
    diveEvents = Array.isArray(state.diveEvents) ? state.diveEvents : [];
    minNdlSeen = (state.minNdlSeen == null) ? Infinity : state.minNdlSeen;
    thirdsReserveHitThisDive = !!state.thirdsReserveHitThisDive;
    // Issue #45/#66 (review follow-up, blocker): restore the drill runtime
    // state _isValidSaveState() now guarantees is present and well-formed.
    // The two real-time deadlines were saved as a REMAINING duration (see
    // saveDiveState()) — reconstruct a fresh absolute deadline against
    // THIS page's own _drillRealTime() clock (performance.now() restarts
    // at 0 on reload, so the old absolute value would be meaningless).
    // optionRects is a per-frame renderer hit-test cache, not state —
    // starts empty and gets repopulated on the next drill-overlay frame.
    drillHasRunThisDive = !!state.drillHasRunThisDive;
    drillState.phase = state.drillState.phase;
    drillState.id = state.drillState.id;
    drillState.startedAt = state.drillState.startedAt;
    drillState.selectedOption = state.drillState.selectedOption;
    drillState.correct = state.drillState.correct;
    drillState.flickerUntilReal = _drillRealTime() + state.drillState.flickerRemainingSec;
    drillState.debriefUntilReal = _drillRealTime() + state.drillState.debriefRemainingSec;
    drillState.freeflowUntilDiveSec = state.drillState.freeflowUntilDiveSec;
    drillState.freeflowDrainTankIdx = state.drillState.freeflowDrainTankIdx;
    drillState.lightRestoreAt = state.drillState.lightRestoreAt;
    drillState.breathHoldUntilDiveSec = state.drillState.breathHoldUntilDiveSec;
    drillState.optionRects = [];
    diverX = state.diverX || 0;
    horizontalVelocity = state.horizontalVelocity || 0;
    // Phase C
    if (state.diveSite) diveSite = state.diveSite;
    guidelineNodes = state.guidelineNodes ? state.guidelineNodes.slice() : [];
    visibility = state.visibility != null ? state.visibility : 1.0;
    torchOn = state.torchOn != null ? state.torchOn : !!(DIVE_SITES[diveSite] && DIVE_SITES[diveSite].hasOverhead);
    if (state.current) {
        current.active = state.current.active;
        current.direction = state.current.direction;
        current.strength = state.current.strength;
        current.level = state.current.level;
        current.depthMin = state.current.depthMin;
        current.depthMax = state.current.depthMax;
        current.timer = state.current.timer;
        current.rolledThisDive = state.current.rolledThisDive;
    }
    initParticles();
}

// beforeunload guard — warn user during active dive
function beforeUnloadHandler(event) {
    event.preventDefault();
    event.returnValue = true;
}

function updateBeforeUnloadGuard() {
    // Issue #45: 'drill' is a paused-but-mid-dive state — keep the guard on.
    if (gameState === 'diving' || gameState === 'surface' || gameState === 'drill') {
        window.addEventListener('beforeunload', beforeUnloadHandler);
    } else {
        window.removeEventListener('beforeunload', beforeUnloadHandler);
    }
}

// Periodic save inside game loop
function maybeSaveDiveState(timestamp) {
    if (timestamp - _lastSaveTime > SAVE_INTERVAL_MS) {
        _lastSaveTime = timestamp;
        // Issue #45: 'drill' persists the same as 'diving'/'surface' — a
        // page reload with a drill on-screen must not silently discard the
        // paused dive.
        if (gameState === 'diving' || gameState === 'surface' || gameState === 'drill') {
            saveDiveState();
        } else {
            clearSavedDive();
        }
        updateBeforeUnloadGuard();
    }
}

// ============================================================

initTanks();
initTissues();
initParticles();
resetDive();

// Issue #67: non-blocking resume-dive banner. Do not call confirm() at
// script-load time — that blocks the first paint (especially painful on
// mobile). Instead always proceed to 'gas-setup' immediately, and if a
// saved dive was found stash it in _pendingResumeDive so the banner can
// offer the choice non-blockingly. resumeSavedDive() / discardSavedDive()
// are wired to the banner's Yes / Discard buttons below.
var _savedDive = loadSavedDive();
var _pendingResumeDive = _savedDive || null;
gameState = 'gas-setup';

function _updateResumeBanner() {
    const el = document.getElementById('resume-dive-banner');
    if (!el) return;
    if (_pendingResumeDive && gameState === 'gas-setup') {
        const txt = document.getElementById('resume-dive-banner-text');
        const yes = document.getElementById('resume-dive-banner-yes');
        const no = document.getElementById('resume-dive-banner-discard');
        if (txt) txt.textContent = S('resumeBannerText');
        if (yes) yes.textContent = S('resumeBannerYes');
        if (no) no.textContent = S('resumeBannerDiscard');
        el.style.display = 'flex';
    } else {
        el.style.display = 'none';
    }
}

function resumeSavedDive() {
    if (!_pendingResumeDive) return false;
    const s = _pendingResumeDive;
    _pendingResumeDive = null;
    restoreDiveState(s);
    _updateResumeBanner();
    return true;
}

function discardSavedDive() {
    if (!_pendingResumeDive) return false;
    _pendingResumeDive = null;
    clearSavedDive();
    _updateResumeBanner();
    return true;
}

function _baselineFinite(value) {
    return Number.isFinite(value) ? value : null;
}

function captureBaselineCheckpoint(scenarioId, checkpointId) {
    if (!scenarioId || !checkpointId) {
        throw new Error('scenarioId and checkpointId are required');
    }

    var ceiling = calculateCeiling();
    var ndl = calculateNDL();
    var schedule = decoStop(ceiling) > 0 ? calculateDecoSchedule(ceiling) : null;
    var tts = calculateTTS(ceiling, schedule);

    return {
        schemaVersion: 1,
        scenarioId: String(scenarioId),
        checkpointId: String(checkpointId),
        simulatedGeometry: _baselineLastSimulatedGeometry || diveSite,
        state: {
            gameState: gameState,
            diveMode: diveMode,
            diveSite: diveSite,
            depth_m: _baselineFinite(depth),
            maxDepth_m: _baselineFinite(maxDepth),
            diveTime_min: _baselineFinite(diveTime),
            diverX_m: _baselineFinite(diverX),
            verticalVelocity_mpm: _baselineFinite(verticalVelocity),
            horizontalVelocity_mps: _baselineFinite(horizontalVelocity),
            activeTankIndex: activeTank,
            cns_percent: _baselineFinite(cnsPercent),
            narcosisIndex: _baselineFinite(narcosisIndex),
            // Latched in updateDiving() after calculateTTS() has already run for
            // the tick, so it cannot be derived from a checkpoint's recomputed
            // NDL. It widens the safety stop from 3 to 5 minutes, so a planner
            // replaying this checkpoint needs it recorded explicitly.
            ndlDroppedBelow5: ndlDroppedBelow5,
            safetyStop: {
                needed: safetyStopNeeded,
                remaining_min: _baselineFinite(safetyStopRemaining),
                countdownStarted: safetyStopCountdownStarted,
                paused: safetyStopPaused,
                complete: safetyStopComplete
            }
        },
        configuration: {
            gfLow_percent: gfLow,
            gfHigh_percent: gfHigh,
            amv_lpm: amvRate,
            tankVolume_l: tankVolume
        },
        planner: {
            ceiling_m: _baselineFinite(ceiling),
            ndl_min: _baselineFinite(ndl),
            tts_min: _baselineFinite(tts),
            schedule: schedule ? JSON.parse(JSON.stringify(schedule)) : null
        },
        tissues: {
            n2_bar: tissues.map(_baselineFinite),
            he_bar: tissuesHe.map(_baselineFinite)
        },
        tanks: tanks.map(function(tank) {
            return {
                fO2: _baselineFinite(tank.fO2),
                fHe: _baselineFinite(tank.fHe),
                fN2: _baselineFinite(tank.fN2),
                volume_l: _baselineFinite(tank.volume),
                pressure_bar: _baselineFinite(tank.pressure),
                gasRemaining_l: _baselineFinite(tank.gasRemaining),
                switchDepth_m: _baselineFinite(tank.switchDepth)
            };
        }),
        ccr: {
            targetPO2_bar: _baselineFinite(ccrState.targetSP),
            actualPO2_bar: _baselineFinite(ccrState.actualPO2),
            diluent: {
                fO2: _baselineFinite(ccrState.dilFO2),
                fHe: _baselineFinite(ccrState.dilFHe),
                fN2: _baselineFinite(ccrState.dilFN2)
            },
            o2Pressure_bar: _baselineFinite(ccrState.o2CylPressure),
            diluentPressure_bar: _baselineFinite(ccrState.dilCylPressure),
            scrubberRemaining_min: _baselineFinite(ccrState.scrubberRemaining),
            onBailout: !!ccrState.onBailout
        },
        events: diveEvents.map(function(event) {
            return JSON.parse(JSON.stringify(event));
        })
    };
}

function runBaselineDiagnosticFrames(count, dtReal) {
    if (!_baselineDiag.enabled) {
        throw new Error('diagnostics must be enabled with ?diagnostics=1');
    }
    count = Math.max(1, Math.min(1000, Math.floor(count)));
    dtReal = Number.isFinite(dtReal) ? Math.max(0, Math.min(0.1, dtReal)) : 0;

    for (var i = 0; i < count; i++) {
        var frameStarted = _baselineDiag.start();
        var updateStarted = _baselineDiag.start();
        updateDiving(dtReal);
        _baselineDiag.record('update', updateStarted);

        var renderStarted = _baselineDiag.start();
        drawScene();
        drawDiveComputer();
        drawDrillFlicker();
        _baselineDiag.record('render', renderStarted);
        _baselineDiag.record('frame', frameStarted);
    }
    return _baselineDiag.exportSnapshot();
}

(function _wireResumeBanner() {
    const yes = document.getElementById('resume-dive-banner-yes');
    const no = document.getElementById('resume-dive-banner-discard');
    if (yes) yes.addEventListener('click', function() { resumeSavedDive(); });
    if (no) no.addEventListener('click', function() { discardSavedDive(); });
    _updateResumeBanner();
})();

requestAnimationFrame(gameLoop);

// Expose state for testing — used by diving-simulator-tests.html
window.gameAPI = {
    // Issue #9 test hook: `keys` is declared with `const` in state.js, so it
    // never became a window property (classic-script quirk: only top-level
    // `function` declarations do). Expose the live object directly — tests
    // need to observe real keydown/keyup mutations, not a snapshot.
    get keys() { return keys; },
    get diagnosticsEnabled() { return _baselineDiag.enabled; },
    resetDiagnostics: function(context) { _baselineDiag.reset(context); },
    exportDiagnostics: function() { return _baselineDiag.exportSnapshot(); },
    captureBaselineCheckpoint: captureBaselineCheckpoint,
    runBaselineDiagnosticFrames: runBaselineDiagnosticFrames,
    get depth() { return depth; },
    get maxDepth() { return maxDepth; },
    set maxDepth(v) { maxDepth = v; },
    get avgDepthAccum() { return avgDepthAccum; },
    set avgDepthAccum(v) { avgDepthAccum = v; },
    get avgDepthSamples() { return avgDepthSamples; },
    set avgDepthSamples(v) { avgDepthSamples = v; },
    get diveTime() { return diveTime; },
    // Issue #45: writable diveTime setter so drill tests can pin the
    // dive-time gate (DRILL_MIN_DIVETIME_MIN) without having to run 120
    // frames of physics just to cross a 3-minute threshold. diveTime is
    // declared `let` in state.js so a bare window.diveTime = x from a
    // test would silently no-op (classic-script scope rules).
    set diveTime(v) { diveTime = +v || 0; },
    get ascentRate() { return ascentRate; },
    get currentVerticalRate() { return currentVerticalRate; },
    get gameState() { return gameState; },
    set gameState(v) { gameState = v; },
    // Issue #67: non-blocking resume-dive banner test hooks.
    // `pendingResumeDive` / `resumeBannerVisible` are read-only observability;
    // `resumeSavedDive` / `discardSavedDive` reproduce the button-click paths;
    // `setPendingResumeDive` lets a test set up a pending dive without going
    // through localStorage; `updateResumeBanner` re-runs the show/hide logic
    // after the test mutates gameState.
    get pendingResumeDive() { return _pendingResumeDive; },
    get resumeBannerVisible() {
        const el = document.getElementById('resume-dive-banner');
        return !!(el && el.style.display !== 'none');
    },
    resumeSavedDive: function() { return resumeSavedDive(); },
    discardSavedDive: function() { return discardSavedDive(); },
    updateResumeBanner: function() { return _updateResumeBanner(); },
    setPendingResumeDive: function(s) { _pendingResumeDive = s || null; _updateResumeBanner(); },
    // fastForwardActive is declared with `let`, so unlike `var`-declared
    // globals it does NOT become a window property — tests must go through
    // this accessor rather than assigning window.fastForwardActive directly.
    get fastForwardActive() { return fastForwardActive; },
    set fastForwardActive(v) { fastForwardActive = !!v; },
    get cssWidth() { return cssWidth; },
    // Test hook (issue #32): the test harness runs in a hidden iframe
    // whose innerWidth/Height is 0, so cssWidth/cssHeight stay 0 unless
    // pinned. Any renderer-facing test that maps world→screen has to
    // set these first so screen bounds aren't [-20, 20].
    set cssWidth(v) { cssWidth = v; },
    get cssHeight() { return cssHeight; },
    set cssHeight(v) { cssHeight = v; },
    get gameOverReason() { return gameOverReason; },
    // Issue #120 test hook: result-screen layout is asserted per reason, and
    // each reason produces a different amount of text.
    set gameOverReason(v) { gameOverReason = v; },
    get tissues() { return tissues; },
    set tissues(v) { tissues = v; },
    get tissuesHe() { return tissuesHe; },
    set tissuesHe(v) { tissuesHe = v; },
    get tanks() { return tanks; },
    get activeTank() { return activeTank; },
    set activeTank(v) { activeTank = v; },
    get tankCount() { return tankCount; },
    // Issue #63: test-only setter used to bypass gsAddTank()/gsRemoveTank().
    // A bare assignment left tanks[] out of sync (e.g. tankCount=4 with only
    // 2 real tanks), so anything indexing tanks[i] for i < tankCount could
    // read undefined. Pad with createTank() (same template gsAddTank uses)
    // or truncate to match. Floor is 0 (not 1) rather than mirroring
    // gsRemoveTank()'s `tankCount > 1` gate: the test harness's own
    // setupDive() helper deliberately does `tanks.length = 0; tankCount = 0;`
    // as an explicit "clear everything" step before manually re-pushing
    // tanks via pushTank() — clamping the floor to 1 here would silently
    // inject an extra dummy tank ahead of every test's real tanks.
    set tankCount(v) {
        v = Math.max(0, Math.min(MAX_TANKS, v));
        while (tanks.length < v) tanks.push(createTank(0.21, 0.0, 200));
        while (tanks.length > v) tanks.pop();
        tankCount = v;
        if (selectedTankTab >= tankCount) selectedTankTab = Math.max(0, tankCount - 1);
        if (activeTank >= tankCount) activeTank = Math.max(0, tankCount - 1);
    },
    get po2ViolationTime() { return po2ViolationTime; },
    get dcsViolationTime() { return dcsViolationTime; },
    get cnsPercent() { return cnsPercent; },
    set cnsPercent(v) { cnsPercent = v; },
    get barotraumaTime() { return barotraumaTime; },
    get hypoxiaTime() { return hypoxiaTime; },
    get safetyStopNeeded() { return safetyStopNeeded; },
    // Issue #44: setter added so tests can pin the safety-stop flags without
    // having to run an actual 25-min dive. The property is `let` in state.js
    // and never became a window property, so tests can't set it directly.
    set safetyStopNeeded(v) { safetyStopNeeded = !!v; },
    get safetyStopRemaining() { return safetyStopRemaining; },
    get safetyStopCountdownStarted() { return safetyStopCountdownStarted; },
    get safetyStopPaused() { return safetyStopPaused; },
    get safetyStopComplete() { return safetyStopComplete; },
    set safetyStopComplete(v) { safetyStopComplete = !!v; },
    get ndlDroppedBelow5() { return ndlDroppedBelow5; },
    calculateSafetyStopDuration: calculateSafetyStopDuration,
    get showHelp() { return showHelp; },
    // Issue #120 test hook: the help overlay layers over a result screen, and
    // the two must not fight over the same wheel/touch events.
    set showHelp(v) { showHelp = !!v; },
    get showAdvanced() { return isAdvanced(); },
    set showAdvanced(v) { switchMode(v ? 'tec' : 'rec'); },
    get diveMode() { return diveMode; },
    set diveMode(v) { if (['rec','tec','ccr'].includes(v)) switchMode(v); },
    get currentLang() { return currentLang; },
    set currentLang(v) { if (v === 'en' || v === 'de') currentLang = v; },
    // Issue #39: HUD colour palette test hooks. `hudColorMode` is declared
    // with `let` in constants.js — classic-script quirk: only top-level
    // `function`/`var` become window/iframe properties, `let`/`const` do
    // NOT — so tests must go through these accessors instead of poking
    // window.hudColorMode directly (which would be undefined and silently
    // no-op the write). `HUD_COLORS_DEFAULT` / `HUD_COLORS_CVD` are also
    // `const` so exposed here for test-side palette shape assertions.
    get colorMode() { return hudColorMode; },
    set colorMode(v) { setHudColorMode(v); },
    toggleColorMode: toggleHudColorMode,
    hudColor: hudColor,
    hudDangerPrefix: hudDangerPrefix,
    get HUD_COLORS_DEFAULT() { return HUD_COLORS_DEFAULT; },
    get HUD_COLORS_CVD() { return HUD_COLORS_CVD; },
    get HUD_COLORS_STORAGE_KEY() { return HUD_COLORS_STORAGE_KEY; },
    get amvRate() { return amvRate; },
    set amvRate(v) { amvRate = Math.max(AMV_MIN, Math.min(AMV_MAX, v)); },
    get tankVolume() { return tankVolume; },
    set tankVolume(v) { tankVolume = Math.max(TANK_VOL_MIN, Math.min(TANK_VOL_MAX, v)); },
    get gfLow() { return gfLow; },
    set gfLow(v) { gfLow = Math.max(GF_LOW_MIN, Math.min(GF_LOW_MAX, v)); },
    get gfHigh() { return gfHigh; },
    set gfHigh(v) { gfHigh = Math.max(GF_HIGH_MIN, Math.min(GF_HIGH_MAX, v)); },
    get breathPhase() { return breathPhase; },
    get breathTimer() { return breathTimer; },
    get bubbles() { return bubbles; },
    resetDive: resetDive,
    initTanks: initTanks,
    initTissues: initTissues,
    createTank: createTank,
    updateDiving: updateDiving,
    updateTissues: updateTissues,
    calculateNDL: calculateNDL,
    calculateCeiling: calculateCeiling,
    calculateDecoSchedule: calculateDecoSchedule,
    calculatePO2: calculatePO2,
    calculateMOD: calculateMOD,
    calculateTTS: calculateTTS,
    // Issue #120: result-screen scroll offset and its measured bound, so a test
    // can assert that content drawn below the fold is actually reachable.
    get resultScrollY() { return resultScrollY; },
    set resultScrollY(v) { resultScrollY = v; },
    get resultScrollMaxY() { return resultScrollMaxY; },
    // Translation lookup, so layout assertions can enumerate the strings that
    // are actually drawn rather than restating them.
    S: S,
    bestGasForDepth: bestGasForDepth,
    get DIVER_SCREEN_X_FRACTION() { return DIVER_SCREEN_X_FRACTION; },
    get SAFETY_STOP_ACTIVE_MIN_D() { return SAFETY_STOP_ACTIVE_MIN_D; },
    get SAFETY_STOP_ACTIVE_MAX_D() { return SAFETY_STOP_ACTIVE_MAX_D; },
    get DECO_PLANNING_ASCENT_RATE_MPM() { return DECO_PLANNING_ASCENT_RATE_MPM; },
    get frameCalc() { return frameCalc; },
    calculateGTR: calculateGTR,
    calculateNarcoticPP: calculateNarcoticPP,
    calculateEND: calculateEND,
    // Issue #65/#69/#71: framerate/timestep-independence hooks
    perSecondToPerFrameProbability: perSecondToPerFrameProbability,
    updateBuoyancyPhysics: updateBuoyancyPhysics,
    updateHorizontalPhysics: updateHorizontalPhysics,
    get PHYSICS_MAX_SUBSTEP_SEC() { return PHYSICS_MAX_SUBSTEP_SEC; },
    get diveProfile() { return diveProfile; },
    set diveProfile(v) { diveProfile = v; },
    get _profileSampleTimer() { return _profileSampleTimer; },
    set _profileSampleTimer(v) { _profileSampleTimer = v; },
    // Issue #44: debriefing accessors — tests inspect diveEvents / minNdlSeen
    // and drive gradeDive() directly. minNdlSeen accepts null as the "not
    // observed" sentinel to mirror the save/restore encoding.
    get diveEvents() { return diveEvents; },
    set diveEvents(v) { diveEvents = Array.isArray(v) ? v : []; },
    get minNdlSeen() { return minNdlSeen; },
    set minNdlSeen(v) { minNdlSeen = (v == null) ? Infinity : v; },
    gradeDive: gradeDive,
    get TIME_ACCELERATION() { return TIME_ACCELERATION; },
    get FAST_FORWARD_MULTIPLIER() { return FAST_FORWARD_MULTIPLIER; },
    get verticalVelocity() { return verticalVelocity; },
    set verticalVelocity(v) { verticalVelocity = v; },
    get bcdGasSurfaceLiters() { return bcdGasSurfaceLiters; },
    set bcdGasSurfaceLiters(v) { bcdGasSurfaceLiters = v; },
    get FINKICK_PARAMS() { return FINKICK_PARAMS; },
    get BUOYANCY_PARAMS() { return BUOYANCY_PARAMS; },
    getCCRInspiredGas: getCCRInspiredGas,
    updateCCRLoop: updateCCRLoop,
    updateCCRDiluent: updateCCRDiluent,
    recommendBestGas: recommendBestGas,
    ambientPressure: ambientPressure,
    setDepth: function(d) { depth = d; },
    setKeys: function(k) { for (var key in k) keys[key] = k[key]; },
    clearKeys: function() { for (var key in keys) keys[key] = false; },
    pushTank: function(fO2, fHe, pressure) {
        tanks.push(createTank(fO2, fHe, pressure));
        tankCount = tanks.length;
    },
    setActiveTankIdx: function(idx) { activeTank = idx; },
    // TASK-045: Shark easter egg API
    get shark() { return shark; },
    set shark(v) { shark = v; },
    get sharkTimer() { return sharkTimer; },
    set sharkTimer(v) { sharkTimer = v; },
    get narcosisIndex() { return narcosisIndex; },
    get narcosisKOTime() { return narcosisKOTime; },
    // Phase A: Horizontal movement test hooks
    get diverX() { return diverX; },
    set diverX(v) { diverX = v; },
    get horizontalVelocity() { return horizontalVelocity; },
    set horizontalVelocity(v) { horizontalVelocity = v; },
    // Phase B: Current test hooks
    get current() { return current; },
    triggerCurrent: function(opts) {
        current.direction = opts.direction || 1;
        current.strength = opts.strength || 0.3;
        current.level = 0;
        current.depthMin = opts.depthMin != null ? opts.depthMin : 0;
        current.depthMax = opts.depthMax != null ? opts.depthMax : 100;
        current.timer = opts.duration || 120;
        current.rolledThisDive = true;
        current.active = true;
    },
    currentVelAt: currentVelAt,
    // Phase C: Site geometry + overhead test hooks
    get badAirWarning() { return badAirWarning; },
    get diveSite() { return diveSite; },
    set diveSite(v) {
        if (v === 'open' || DIVE_SITES[v]) diveSite = v;
    },
    get visibility() { return visibility; },
    // Test hook — visibility drives the torch reach formula and #33's
    // sampleTorchLightAtWorldPoint; TC-33-* needs to pin it explicitly.
    set visibility(v) { visibility = Math.max(0, Math.min(1.25, v)); },
    get torchOn() { return torchOn; },
    set torchOn(v) { torchOn = !!v; },
    get guidelineNodeCount() { return guidelineNodes.length; },
    get inOverhead() { return inOverhead; },
    // Test hook — the game normally maintains inOverhead itself from
    // overheadAt(diverX, depth); TC-33-INTERIOR-MODULATOR-SCOPE + others
    // need to pin it deterministically.
    set inOverhead(v) { inOverhead = !!v; },
    // Issue #27: Rule-of-thirds test hooks. Phase + pct are computed each
    // tick from thirdsStartingGas (snapshotted on overhead entry). Flags
    // are exposed writable so TC-27-* can pin them for edge-case coverage.
    get thirdsCurrentPhase() { return thirdsCurrentPhase; },
    get thirdsPct() { return thirdsPct; },
    get thirdsStartingGas() { return thirdsStartingGas; },
    set thirdsStartingGas(v) { thirdsStartingGas = +v || 0; },
    get thirdsTurnWarned() { return thirdsTurnWarned; },
    set thirdsTurnWarned(v) { thirdsTurnWarned = !!v; },
    get thirdsReserveActive() { return thirdsReserveActive; },
    set thirdsReserveActive(v) { thirdsReserveActive = !!v; },
    get thirdsReserveHitThisDive() { return thirdsReserveHitThisDive; },
    set thirdsReserveHitThisDive(v) { thirdsReserveHitThisDive = !!v; },
    get THIRDS_TURN_FRACTION() { return THIRDS_TURN_FRACTION; },
    get THIRDS_RESERVE_FRACTION() { return THIRDS_RESERVE_FRACTION; },
    floorAt: floorAt,
    ceilingAt: ceilingAt,
    solidAt: solidAt,
    // Issue #122 test hooks: the diver's body test and the raw box predicate,
    // so a spec can assert extent and passability without restating the maths.
    solidBoxAt: solidBoxAt,
    diverSolidAt: diverSolidAt,
    get DIVER_HALF_WIDTH_M() { return DIVER_HALF_WIDTH_M; },
    get DIVER_HALF_HEIGHT_M() { return DIVER_HALF_HEIGHT_M; },
    overheadAt: overheadAt,
    activeSite: activeSite,
    // TASK-032 / BUG-CCR-* test hooks
    get ccrState() { return ccrState; },
    get infoPageMode() { return infoPageMode; },
    set infoPageMode(v) { infoPageMode = v; },
    ccrAdjustO2Vol: ccrAdjustO2Vol,
    ccrAdjustO2Pres: ccrAdjustO2Pres,
    ccrAdjustSP: ccrAdjustSP,
    ccrAdjustDilVol: ccrAdjustDilVol,
    ccrApplyDilPreset: ccrApplyDilPreset,
    initCCR: initCCR,
    startDiveAction: startDiveAction,
    // Issue #6 test hooks: gas-setup key handler + selected-tab getter/setter
    // so TAB-cycle / add-tank / remove-tank / gas-mix / GF / AMV / pressure
    // key assertions can observe and drive the same state the real handler
    // reads.
    updateGasSetup: updateGasSetup,
    get selectedTankTab() { return selectedTankTab; },
    set selectedTankTab(v) { selectedTankTab = Math.max(0, Math.min(tankCount - 1, v | 0)); },
    // Reef redesign: expose registries for tests
    get DIVE_SITES() { return DIVE_SITES; },
    get FISH_TYPES() { return FISH_TYPES; },
    get WILDLIFE_TYPES() { return WILDLIFE_TYPES; },
    eligibleFishTypes: function() { return _eligibleTypes(FISH_TYPES); },
    eligibleWildlifeTypes: function() { return _eligibleTypes(WILDLIFE_TYPES); },
    // Issue #42: fauna terrain-avoidance test hooks.
    faunaBlockedAt: faunaBlockedAt,
    drawFish: drawFish,
    drawWildlife: drawWildlife,
    spawnFish: spawnFish,
    spawnWildlife: spawnWildlife,
    updateFish: updateFish,
    updateWildlife: updateWildlife,
    get fishes() { return fishes; },
    get wildlife() { return wildlife; },
    get fishSpawnTimer() { return fishSpawnTimer; },
    set fishSpawnTimer(v) { fishSpawnTimer = v; },
    get wildlifeSpawnTimer() { return wildlifeSpawnTimer; },
    set wildlifeSpawnTimer(v) { wildlifeSpawnTimer = v; },
    // Issue #101: Rock-silhouette dome caps (renderer-only, purely visual).
    // Exposed so tests can pin the visual↔AABB match ceiling in metres:
    //   maxSagPx = min(sh*SH_FRAC, sw*SW_FRAC, MAX_PX)
    //   maxSagM  = maxSagPx * mpp   (mpp = 0.05 m/px)
    get ROCK_DOME_MAX_PX()  { return ROCK_DOME_MAX_PX;  },
    get ROCK_DOME_SH_FRAC() { return ROCK_DOME_SH_FRAC; },
    get ROCK_DOME_SW_FRAC() { return ROCK_DOME_SW_FRAC; },
    // Issue #52: Visual Surface Layer test hooks (renderer-only, decorative)
    visualSurfaceNoise: visualSurfaceNoise,
    visualProfileDepth: visualProfileDepth,
    get VISUAL_SURFACE_CONFIG() { return VISUAL_SURFACE_CONFIG; },
    // Issue #41: Material texture tile registry (renderer-only, decorative)
    buildMaterialTiles: buildMaterialTiles,
    get materialTiles() { return _matTiles; },
    get MAT_TILE() { return MAT_TILE; },
    // Issue #34: AO contact band helper (renderer-only, decorative)
    drawContactBand: drawContactBand,
    get CONTACT_AO() { return CONTACT_AO; },
    // Issue #53: Visual zones — declarative biome data + deterministic
    // lookup helpers. `debugVisualZones` toggles a diagnostic overlay
    // in drawScene(); default false — zero visual change when unset.
    visualZoneAt: visualZoneAt,
    zoneBlendWeight: zoneBlendWeight,
    get debugVisualZones() { return debugVisualZones; },
    set debugVisualZones(v) { debugVisualZones = !!v; },
    get VISUAL_ZONE_DEFAULT_PRIORITY() { return VISUAL_ZONE_DEFAULT_PRIORITY; },
    get VISUAL_ZONE_DEFAULT_BLEND() { return VISUAL_ZONE_DEFAULT_BLEND; },
    drawVisualZoneDebug: drawVisualZoneDebug,
    get VISUAL_ZONE_DEBUG() { return VISUAL_ZONE_DEBUG; },
    // Issue #54: Local water volumes — atmosphere sampler + clamps
    sampleLocalAtmosphere: sampleLocalAtmosphere,
    get LOCAL_ATMO_DEFAULT() { return LOCAL_ATMO_DEFAULT; },
    get LOCAL_ATMO_CLAMP() { return LOCAL_ATMO_CLAMP; },
    // Issue #55: Set-dressing (render-only)
    drawSetDressing: drawSetDressing,
    drawDecorationProp: drawDecorationProp,
    pickDecorationProp: pickProp,       // renamed for public clarity
    sampleSetDressingCandidates: sampleSetDressingCandidates,
    get setDressingLastFrameCount() { return _setDressingLastFrameCount; },
    get SET_DRESSING_CONSTANTS() {
        return {
            MAX_MARGIN_CELLS: SET_DRESSING_MAX_MARGIN_CELLS,
            MIN_SCREEN_PX:    SET_DRESSING_MIN_SCREEN_PX,
            JITTER_FRACTION:  SET_DRESSING_JITTER_FRACTION,
            CELL_SEED_MULT:   SET_DRESSING_CELL_SEED_MULT,
            JITTER_SEED_MULT: SET_DRESSING_JITTER_SEED_MULT,
            PROP_SEED_MULT:   SET_DRESSING_PROP_SEED_MULT
        };
    },
    // Issue #56: Surface accumulation (render-only, decorative)
    drawSedimentCap: drawSedimentCap,
    drawContactAccumulation: drawContactAccumulation,
    drawVerticalStreaks: drawVerticalStreaks,
    drawGrowthEdge: drawGrowthEdge,
    accumulationProfileFor: accumulationProfileFor,
    get ACCUMULATION_PROFILES() { return ACCUMULATION_PROFILES; },
    get ACCUMULATION_SITE_DEFAULTS() { return ACCUMULATION_SITE_DEFAULTS; },
    get ACCUMULATION_NEUTRAL_DEFAULT() { return ACCUMULATION_NEUTRAL_DEFAULT; },
    get ACCUMULATION_PAL() { return ACCUMULATION_PAL; },
    get ACCUM_SEED() { return ACCUM_SEED; },
    // Issue #57: Environment micro-motion (renderer-only, decorative)
    sampleEnvironmentSway: sampleEnvironmentSway,
    get SWAY_PROFILES() { return SWAY_PROFILES; },
    get waveTime() { return waveTime; },
    set waveTime(v) { waveTime = v; },
    // Issue #35: Per-instance coral variation (renderer-only, decorative)
    coralVariation: coralVariation,
    tintCoralColor: tintCoralColor,
    get CORAL_VARIATION_CONSTANTS() {
        return {
            SCALE_MIN: CORAL_SCALE_MIN,
            SCALE_MAX: CORAL_SCALE_MAX,
            BRIGHTNESS_RANGE: CORAL_BRIGHTNESS_RANGE,
            HUE_SHIFT_DEG: CORAL_HUE_SHIFT_DEG
        };
    },
    drawTableCoral: drawTableCoral,
    drawBrainCoral: drawBrainCoral,
    drawStaghorn: drawStaghorn,
    drawSoftCoral: drawSoftCoral,
    drawGorgonian: drawGorgonian,
    drawBarrelSponge: drawBarrelSponge,
    // Issue #58: Shared near-surface optics — caustics, water underside,
    // boat shadow. Pure depth curve + render helpers.
    nearSurfaceLightFactor: nearSurfaceLightFactor,
    drawCausticsOnVisibleFloor: drawCausticsOnVisibleFloor,
    drawNearSurfaceAtmosphere: drawNearSurfaceAtmosphere,
    drawSurfaceCaustics: drawSurfaceCaustics,
    // Issue #43: World-anchored background/midground parallax layers per
    // site. drawSiteAtmosphere() dispatches to these; they are also
    // exposed individually so tests can stub CanvasRenderingContext2D
    // methods and assert the guards behave (world-anchored, no-op
    // outside diving, deterministic).
    drawSiteAtmosphere: drawSiteAtmosphere,
    drawShoreParallaxLayers: drawShoreParallaxLayers,
    drawReefParallaxLayers: drawReefParallaxLayers,
    drawWreckParallaxLayers: drawWreckParallaxLayers,
    drawCaveParallaxLayers: drawCaveParallaxLayers,
    get PARALLAX_FACTORS() { return PARALLAX_FACTORS; },
    // Issue #31: Directional torch cone + backscatter (renderer-only,
    // decorative). torchBeamAngle() is a pure helper; the draw hooks are
    // exposed so tests can stub CanvasRenderingContext2D and assert the
    // out-of-dive no-ops + torch-off / torch-on branch behaviour.
    torchBeamAngle: torchBeamAngle,
    get TORCH_BEAM_TILT_RAD() { return TORCH_BEAM_TILT_RAD; },
    get TORCH_BEAM_HALF_ANGLE_RAD() { return TORCH_BEAM_HALF_ANGLE_RAD; },
    get TORCH_NEAR_FIELD_FRACTION() { return TORCH_NEAR_FIELD_FRACTION; },
    drawSiltAndTorch: drawSiltAndTorch,
    drawWreckHullSkin: drawWreckHullSkin,
    drawTorchGlowAndSparkles: drawTorchGlowAndSparkles,
    get diverFacing() { return _diverFacing; },
    set diverFacing(v) { _diverFacing = (v === -1) ? -1 : 1; },
    get wreckMetal() { return _wreckMetal; },
    set wreckMetal(v) { _wreckMetal = Math.max(0, Math.min(1, +v || 0)); },
    // Issue #33: Wreck visual polish — ferry silhouette, object-relative
    // interior distance falloff, torch-relative object lighting query
    // helper, line/net feature drawers.
    sampleTorchLightAtWorldPoint: sampleTorchLightAtWorldPoint,
    interiorObjectDistanceFactor: interiorObjectDistanceFactor,
    wreckInteriorAlphaMul: wreckInteriorAlphaMul,
    get TORCH_LIGHT_EDGE_SOFTNESS() { return TORCH_LIGHT_EDGE_SOFTNESS; },
    get INTERIOR_OBJECT_NEAR_M() { return INTERIOR_OBJECT_NEAR_M; },
    get INTERIOR_OBJECT_FAR_M()  { return INTERIOR_OBJECT_FAR_M; },
    wreckSilhouetteRects:    function() { return _wreckSilhouetteRects(); },
    wreckSilhouettePolygon:  function() { return _wreckSilhouettePolygon(); },
    drawHangingLine: drawHangingLine,
    drawNet: drawNet,
    // Issue #36: depth-dependent color absorption.
    depthColorFactors: depthColorFactors,
    drawDepthColorAbsorption: drawDepthColorAbsorption,
    get DEPTH_COLOR_R_NEAR() { return DEPTH_COLOR_R_NEAR; },
    get DEPTH_COLOR_R_FAR() { return DEPTH_COLOR_R_FAR; },
    get DEPTH_COLOR_G_NEAR() { return DEPTH_COLOR_G_NEAR; },
    get DEPTH_COLOR_G_FAR() { return DEPTH_COLOR_G_FAR; },
    get DEPTH_COLOR_CAVE_STRENGTH() { return DEPTH_COLOR_CAVE_STRENGTH; },
    // Issue #32: Cave visual polish — bad-air lens, exit light staging,
    // silt cloud, speleothem columns/flowstone. Renderer-only, decorative.
    // No effect on floorAt/ceilingAt/solidAt/badAirAt/badAirWarning (see
    // TC-32-COLLISION-UNCHANGED and TC-32-BAD-AIR-TRIGGER-UNCHANGED).
    drawCaveSiltCloud: drawCaveSiltCloud,
    drawCaveExitLightShaft: drawCaveExitLightShaft,
    drawCaveSpeleothems: drawCaveSpeleothems,
    get COLUMN_MERGE_TOL_M() { return COLUMN_MERGE_TOL_M; },
    get FLOWSTONE_PROBABILITY() { return FLOWSTONE_PROBABILITY; },
    get FLOWSTONE_STEEP_GRADIENT() { return FLOWSTONE_STEEP_GRADIENT; },
    get BAD_AIR_LENS_THICKNESS_M() { return BAD_AIR_LENS_THICKNESS_M; },
    get SILT_CLOUD_HEIGHT_M() { return SILT_CLOUD_HEIGHT_M; },
    get SILT_CLOUD_STEP_M() { return SILT_CLOUD_STEP_M; },
    get SILT_CLOUD_MAX_ALPHA() { return SILT_CLOUD_MAX_ALPHA; },
    get SILT_CLOUD_MIN_VIS() { return SILT_CLOUD_MIN_VIS; },
    get EXIT_LIGHT_NEAR_M() { return EXIT_LIGHT_NEAR_M; },
    get EXIT_LIGHT_FAR_M() { return EXIT_LIGHT_FAR_M; },
    get EXIT_LIGHT_BASE_ALPHA() { return EXIT_LIGHT_BASE_ALPHA; },
    // Issue #37: Orientation aids — back-way chip helper + depth-scale
    // renderer + constants. computeBackwayState() is a pure function of
    // diveSite / inOverhead / diverX so tests can exercise the show/hide
    // + direction/distance decision without touching the DOM.
    computeBackwayState: computeBackwayState,
    drawDepthScale: drawDepthScale,
    get BACKWAY_MIN_DISTANCE_M() { return BACKWAY_MIN_DISTANCE_M; },
    get DEPTH_SCALE_TICK_INTERVAL_M() { return DEPTH_SCALE_TICK_INTERVAL_M; },
    get DEPTH_SCALE_LABEL_INTERVAL_M() { return DEPTH_SCALE_LABEL_INTERVAL_M; },
    // Renderer test hook: `ctx` and `canvas` are const in state.js so they
    // are NOT properties of `window` (only `var` declarations are). Expose
    // them here so tests can pass the same context the render pipeline
    // draws into.
    get ctx() { return ctx; },
    get canvas() { return canvas; },
    // Issue #38: Onboarding hint hooks. Tests need to (a) observe the
    // queue/timer state after triggering an edge, (b) reset every persisted
    // hint flag between test cases so a "first-time" scenario replays cleanly
    // (same idea as the TC-66 save/restore test's key backup pattern), and
    // (c) exercise the dismiss opt-out. hintEdges is exposed as a live
    // reference so tests can pin one edge without touching the others.
    get hintNotifyTime() { return hintNotifyTime; },
    set hintNotifyTime(v) { hintNotifyTime = v; },
    get hintNotifyText() { return hintNotifyText; },
    set hintNotifyText(v) { hintNotifyText = v; },
    get hintQueue() { return hintQueue; },
    get hintEdges() { return hintEdges; },
    get HINT_DISPLAY_SEC() { return HINT_DISPLAY_SEC; },
    get HINT_STORAGE_PREFIX() { return HINT_STORAGE_PREFIX; },
    get HINT_DONE_KEY() { return HINT_DONE_KEY; },
    get HINT_NDL_MIN() { return HINT_NDL_MIN; },
    get HINT_BCD_MIN_DEPTH() { return HINT_BCD_MIN_DEPTH; },
    showHintOnce: showHintOnce,
    dismissAllHints: dismissAllHints,
    resetAllHintsForTests: resetAllHintsForTests,
    // Issue #46: Instructor overlay ("Learn" mode). `instructorMode` is
    // declared with `let` in state.js so it never became a window
    // property — tests must go through this accessor to observe or set
    // it. drawInstructorOverlay + its constants are exposed so tests can
    // stub CanvasRenderingContext2D and assert the render guards behave.
    get instructorMode() { return instructorMode; },
    set instructorMode(v) { instructorMode = !!v; },
    drawInstructorOverlay: drawInstructorOverlay,
    get INSTRUCTOR_PANEL_W() { return INSTRUCTOR_PANEL_W; },
    get INSTRUCTOR_ROWS() { return INSTRUCTOR_ROWS; },
    // Issue #45: Scenario-drill hooks. `drillsEnabled` / `drillHasRunThisDive`
    // / `drillState` are declared with `let` in state.js so they never became
    // window properties — tests must read/write them through this surface.
    // `forceDrill(id)` triggers a specific catalog entry deterministically
    // (skips the random window + Bernoulli roll but still runs its onTrigger
    // hook so, e.g., the co2 drill flips scrubberFailed exactly the way a
    // "real" trigger would). `resolveDrillOption(idx)` and
    // `dismissDrillDebrief()` reproduce the keyboard / tap-selection paths.
    get drillsEnabled() { return drillsEnabled; },
    set drillsEnabled(v) { drillsEnabled = !!v; },
    get drillHasRunThisDive() { return drillHasRunThisDive; },
    set drillHasRunThisDive(v) { drillHasRunThisDive = !!v; },
    get drillState() { return drillState; },
    get DRILLS() { return DRILLS; },
    get DRILL_MIN_DIVETIME_MIN() { return DRILL_MIN_DIVETIME_MIN; },
    get DRILL_MAX_DIVETIME_MIN() { return DRILL_MAX_DIVETIME_MIN; },
    get DRILL_MIN_DEPTH_M() { return DRILL_MIN_DEPTH_M; },
    get DRILL_LIGHT_FLICKER_SEC() { return DRILL_LIGHT_FLICKER_SEC; },
    get DRILL_LIGHT_DARK_SEC() { return DRILL_LIGHT_DARK_SEC; },
    get DRILL_FREEFLOW_MULT() { return DRILL_FREEFLOW_MULT; },
    get DRILL_FREEFLOW_DURATION_SEC() { return DRILL_FREEFLOW_DURATION_SEC; },
    get DRILL_DEBRIEF_DURATION_SEC() { return DRILL_DEBRIEF_DURATION_SEC; },
    get DRILL_BREATHHOLD_DURATION_SEC() { return DRILL_BREATHHOLD_DURATION_SEC; },
    get DRILL_LIGHT_PANIC_ASCENT_MPM() { return DRILL_LIGHT_PANIC_ASCENT_MPM; },
    isDrillEligibleNow: isDrillEligibleNow,
    forceDrill: startDrill,
    resolveDrillOption: resolveDrillOption,
    dismissDrillDebrief: dismissDrillDebrief,
    tryTriggerDrill: tryTriggerDrill,
    drawDrillOverlay: function() { drawDrillOverlay(); },
    drawDrillDebrief: function() { drawDrillDebrief(); }
};
