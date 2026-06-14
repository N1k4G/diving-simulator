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

// Phase A: Exertion multiplier for gas consumption while kicking.
function effectiveAMV(kicking) {
    return amvRate * (kicking ? FINKICK_PARAMS.exertionFactor : 1);
}

// D6: Torch toggle — edge-detect on F key so one press = one toggle
var _torchKeyPrev = false;

// ============================================================
function updateSurface(dtReal) {
    waveTime += dtReal;
    if (keys['s']) {
        bcdGasSurfaceLiters = 2.0;
        verticalVelocity = 0;
        if (diveMode === 'ccr') { ccrState.actualPO2 = ccrState.targetSP < ambientPressure(0) ? ccrState.targetSP : 0.21; }
        gameState = 'diving';
    }
}

function updateDiving(dtReal) {
    // Fast-forward eligibility check
    var decoStopD = decoStop(calculateCeiling());
    var atDecoStop = decoStopD > 0 && Math.abs(depth - decoStopD) <= 1.5;
    var atSafetyStop = safetyStopCountdownStarted && !safetyStopComplete && Math.abs(depth - 5) <= 1.5;
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

    // Variable rate movement — acceleration/deceleration
    // WP-020: Narcosis control impairment — random frame skips
    var narcDelay = narcosisIndex > 0.3 ? (narcosisIndex - 0.3) / 0.7 : 0;
    // Movement keys: WASD or the arrow keys (arrows only adjust gas on the
    // gas-setup screen, so aliasing them here — diving only — is conflict-free).
    var wActive = (keys['w'] || keys['arrowup'])    && Math.random() > narcDelay * 0.6;
    var sActive = (keys['s'] || keys['arrowdown'])  && Math.random() > narcDelay * 0.6;
    // Phase A: Horizontal fin kicks — narcosis impairs lateral control too
    var aActive = (keys['a'] || keys['arrowleft'])  && Math.random() > narcDelay * 0.6;
    var dActive = (keys['d'] || keys['arrowright']) && Math.random() > narcDelay * 0.6;
    var kickDir = (dActive ? 1 : 0) - (aActive ? 1 : 0);

    // D6: Toggle torch on T press — F is taken by fast-forward
    var tDown = !!keys['t'];
    if (tDown && !_torchKeyPrev) torchOn = !torchOn;
    _torchKeyPrev = tDown;

    // --- BCD Buoyancy Controls ---
    if (wActive) { inflateBCD(dtDiveSeconds, depth); }
    if (sActive) { ventBCD(dtDiveSeconds, depth); }

    // --- Buoyancy Physics ---
    var prevDepth = depth;
    updateBuoyancyPhysics(dtDiveSeconds);

    // --- Horizontal Physics (Phase A) ---
    updateHorizontalPhysics(dtDiveSeconds, kickDir);

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
        avgDepthAccum += depth;
        avgDepthSamples++;
    }

    // WP-034: Record dive profile sample every ~2 seconds
    _profileSampleTimer += dtDiveSeconds;
    if (_profileSampleTimer >= 2) {
        _profileSampleTimer -= 2;
        diveProfile.push({t: diveTime, depth: depth, ceiling: calculateCeiling()});
    }

    // Update tissues
    updateTissues(dtDiveMinutes);

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
    var bestGasIdx = recommendBestGas();
    if (bestGasIdx !== activeTank && !bestGasAlerted) {
        playInfoTone();
        bestGasAlerted = true;
    } else if (bestGasIdx === activeTank) {
        bestGasAlerted = false;
    }

    // WP-036: Info tone when deco stop depth changes
    var currentDecoStop = decoStop(calculateCeiling());
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
        updateCCRLoop(dtDiveSeconds);
      }
    } else {
      var consumed = effectiveAMV(kicking) * pAmb * dtDiveMinutes;
      var tank = getActiveTank();
      tank.gasRemaining = Math.max(0, tank.gasRemaining - consumed);

      // Auto-switch if active tank empty — pick best gas for current depth
      if (tank.gasRemaining <= 0) {
          var bestIdx = recommendBestGas();
          if (bestIdx !== activeTank && tanks[bestIdx].gasRemaining > 0) {
              activeTank = bestIdx;
              gasSwitchNotifyTime = 2;
              gasSwitchNotifyText = '\u26A0 AUTO SWITCH \u2192 T' + (bestIdx + 1) + ': ' + tanks[bestIdx].label;
          } else {
              // Fallback: any tank with gas
              for (var si = 0; si < tankCount; si++) {
                  if (si !== activeTank && tanks[si].gasRemaining > 0) {
                      activeTank = si;
                      gasSwitchNotifyTime = 2;
                      gasSwitchNotifyText = '\u26A0 AUTO SWITCH \u2192 T' + (si + 1) + ': ' + tanks[si].label;
                      break;
                  }
              }
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

    // Hypoxia check
    if (po2 < PO2_HYPOXIA) {
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
    var ceilDepth = calculateCeiling();
    if (ceilDepth > 0 && depth < decoStop(ceilDepth)) {
        dcsViolationTime += dtDiveSeconds;
    } else {
        dcsViolationTime = Math.max(0, dcsViolationTime - dtDiveSeconds);
    }

    // Barotrauma check — rapid ascent
    if (ascentRate >= BAROTRAUMA_RATE) {
        barotraumaTime += dtDiveSeconds;
    } else {
        barotraumaTime = Math.max(0, barotraumaTime - dtDiveSeconds * 2);
    }

    // Adaptive safety stop
    // Track NDL dropping below 5 for duration determination
    if (depth > 0.5 && calculateNDL() < 5) {
        ndlDroppedBelow5 = true;
    }
    // Activation: safety stop needed once maxDepth exceeds 11m
    if (maxDepth > 11) {
        safetyStopNeeded = true;
    }
    if (safetyStopNeeded && !safetyStopComplete) {
        // Reset: if diver descends back below 11m, countdown resets fully
        if (depth > 11) {
            safetyStopCountdownStarted = false;
            safetyStopRemaining = 0;
            safetyStopPaused = false;
        }
        // Start countdown: first time depth crosses below 6m
        if (!safetyStopCountdownStarted && depth > 0 && depth < 6) {
            safetyStopCountdownStarted = true;
            safetyStopRemaining = calculateSafetyStopDuration();
            safetyStopPaused = false;
        }
        // Active countdown in 2.4–8.3m range
        if (safetyStopCountdownStarted) {
            if (depth >= 2.4 && depth <= 8.3) {
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

    // Bubbles — breathing cycle
    updateBreathCycle(dtDiveSeconds);
    // BCD exhaust bubbles during fast ascent
    if (ascentRate > 5 && Math.random() < 0.3) {
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
            var W = canvas.width;
            // Spawn just off the visible screen edge in world metres
            var sharkStartX = sharkDir > 0
                ? diverX - (W * 0.25 + 100) * 0.05
                : diverX + (W * 0.75 + 100) * 0.05;
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
        var W2 = canvas.width;
        if ((shark.direction > 0 && shark.x > diverX + (W2 * 0.75 + 150) * 0.05) ||
            (shark.direction < 0 && shark.x < diverX - (W2 * 0.25 + 150) * 0.05)) {
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
      if (allEmpty) {
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

    if (hypoxiaTime >= 10) {
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
}

// SECTION: Main game loop
// SEARCH TERMS: gameLoop, requestAnimationFrame, lastFrameTime, TIME_ACCELERATION

// ============================================================
//  MAIN GAME LOOP
// ============================================================

function gameLoop(timestamp) {
    if (!lastFrameTime) lastFrameTime = timestamp;
    var dtReal = (timestamp - lastFrameTime) / 1000;
    lastFrameTime = timestamp;
    dtReal = Math.min(dtReal, 0.1);

    ctx.clearRect(0, 0, canvas.width, canvas.height);

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
                updateDiving(dtReal);
            }
            drawScene();
            drawDiveComputer();
            if (showHelp && !_helpShown) { showHtmlHelp(); _helpShown = true; }
            if (!showHelp && _helpShown) { hideHtmlHelp(); _helpShown = false; }
            break;
        case 'gameover':
            document.getElementById('html-gas-setup').style.display = 'none';
            // TASK-031D: Close gas info on gameover
            if (_gasInfoShown) { hideHtmlGasInfo(); _gasInfoShown = false; }
            drawScene();
            drawGameOver();
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

function saveDiveState() {
    if (gameState !== 'diving' && gameState !== 'surface') return;
    var state = {
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
    if (gameState === 'diving' || gameState === 'surface') {
        window.addEventListener('beforeunload', beforeUnloadHandler);
    } else {
        window.removeEventListener('beforeunload', beforeUnloadHandler);
    }
}

// Periodic save inside game loop
function maybeSaveDiveState(timestamp) {
    if (timestamp - _lastSaveTime > SAVE_INTERVAL_MS) {
        _lastSaveTime = timestamp;
        if (gameState === 'diving' || gameState === 'surface') {
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

// Check for saved dive state on load
var _savedDive = loadSavedDive();
if (_savedDive) {
    var resumeMsg = currentLang === 'de'
        ? 'Ein gespeicherter Tauchgang wurde gefunden. Fortsetzen?'
        : 'A saved dive was found. Resume?';
    if (confirm(resumeMsg)) {
        restoreDiveState(_savedDive);
    } else {
        clearSavedDive();
        gameState = 'gas-setup';
    }
} else {
    gameState = 'gas-setup';
}

requestAnimationFrame(gameLoop);

// Expose state for testing — used by diving-simulator-tests.html
window.gameAPI = {
    get depth() { return depth; },
    get maxDepth() { return maxDepth; },
    get diveTime() { return diveTime; },
    get ascentRate() { return ascentRate; },
    get currentVerticalRate() { return currentVerticalRate; },
    get gameState() { return gameState; },
    set gameState(v) { gameState = v; },
    get gameOverReason() { return gameOverReason; },
    get tissues() { return tissues; },
    get tissuesHe() { return tissuesHe; },
    get tanks() { return tanks; },
    get activeTank() { return activeTank; },
    set activeTank(v) { activeTank = v; },
    get tankCount() { return tankCount; },
    set tankCount(v) { tankCount = v; },
    get po2ViolationTime() { return po2ViolationTime; },
    get dcsViolationTime() { return dcsViolationTime; },
    get barotraumaTime() { return barotraumaTime; },
    get hypoxiaTime() { return hypoxiaTime; },
    get safetyStopNeeded() { return safetyStopNeeded; },
    get safetyStopRemaining() { return safetyStopRemaining; },
    get safetyStopCountdownStarted() { return safetyStopCountdownStarted; },
    get safetyStopPaused() { return safetyStopPaused; },
    get safetyStopComplete() { return safetyStopComplete; },
    get ndlDroppedBelow5() { return ndlDroppedBelow5; },
    calculateSafetyStopDuration: calculateSafetyStopDuration,
    get showHelp() { return showHelp; },
    get showAdvanced() { return isAdvanced(); },
    set showAdvanced(v) { switchMode(v ? 'tec' : 'rec'); },
    get diveMode() { return diveMode; },
    set diveMode(v) { if (['rec','tec','ccr'].includes(v)) switchMode(v); },
    get currentLang() { return currentLang; },
    set currentLang(v) { if (v === 'en' || v === 'de') currentLang = v; },
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
    calculateGTR: calculateGTR,
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
    get torchOn() { return torchOn; },
    set torchOn(v) { torchOn = !!v; },
    get guidelineNodeCount() { return guidelineNodes.length; },
    get inOverhead() { return inOverhead; },
    floorAt: floorAt,
    ceilingAt: ceilingAt,
    solidAt: solidAt,
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
    // Reef redesign: expose registries for tests
    get DIVE_SITES() { return DIVE_SITES; },
    get FISH_TYPES() { return FISH_TYPES; },
    get WILDLIFE_TYPES() { return WILDLIFE_TYPES; },
    eligibleFishTypes: function() { return _eligibleTypes(FISH_TYPES); },
    eligibleWildlifeTypes: function() { return _eligibleTypes(WILDLIFE_TYPES); }
};