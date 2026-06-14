// ============================================================
// FILE: physics.js
// PURPOSE: Bühlmann ZHL-16C decompression model, gas consumption,
//          buoyancy physics, O2/CNS toxicity tracking.
//
// DEPENDS ON:
//   constants.js — ZHL16C_N2_A/B/HT, ZHL16C_HE_A/B/HT, SURFACE_PRESSURE,
//                  MAX_ASCENT_RATE, CNS_* thresholds
//   state.js     — tissues, tissuesHe, depth, tanks, activeTank,
//                  diveMode, ccrState, cnsPercent, dcsViolationTime,
//                  safetyStopNeeded, safetyStopRemaining, diver
//
// USED BY:
//   game-loop.js — updateDiving() calls updateTissues(), calculateTTS()
//   renderer.js  — drawDiveComputer() calls calculateNDL(), calculateCeiling(),
//                  calculateDecoSchedule()
//   ui.js        — buildHtmlGasSetup() calls calculateMOD()
//
// KEY FUNCTIONS (grep to find):
//   ambientPressure(d)       — bar at depth d in metres
//   updateTissues(dt)        — Bühlmann tissue saturation step, called every tick
//   calculateNDL()           — iterative no-decompression limit in minutes
//   calculateCeiling()       — current deco ceiling in metres
//   calculateDecoSchedule()  — full stop table with deco gas switches
//   calculatePO2(gas, depth) — oxygen partial pressure for a gas+depth
//   calculateMOD(o2frac)     — maximum operating depth for O2 fraction
//   calculateGTR()           — gas time remaining in current tank
//   calculateTTS()           — time-to-surface estimate in minutes
// SECTION: Bühlmann ZHL-16C tissue engine
// SEARCH TERMS: updateTissues, calculateNDL, calculateCeiling, calculateDecoSchedule, ambientPressure, tissues, tissuesHe, gfLow, gfHigh

// ============================================================
// ============================================================
//  BÜHLMANN ZHL-16C ENGINE
// ============================================================

function ambientPressure(d) {
    return 1.0 + d / 10.0;
}

// TASK-030B: BCD inflate/vent and buoyancy physics
function inflateBCD(dtSec, depth) {
    var P = ambientPressure(depth);
    var ambientLiters = BUOYANCY_PARAMS.inflateRate * dtSec;
    var surfEquiv = ambientLiters * P;
    // Check BCD capacity
    var actualVolAfter = (bcdGasSurfaceLiters + surfEquiv) / P;
    if (actualVolAfter > BUOYANCY_PARAMS.bcdMaxCapacity) {
        surfEquiv = BUOYANCY_PARAMS.bcdMaxCapacity * P - bcdGasSurfaceLiters;
        if (surfEquiv < 0) surfEquiv = 0;
    }
    // Deduct from tank (surface-equivalent liters)
    var tank = tanks[activeTank];
    var available = tank.gasRemaining;
    if (available <= 0) return;
    if (surfEquiv > available) surfEquiv = available;
    tank.gasRemaining -= surfEquiv;
    bcdGasSurfaceLiters += surfEquiv;
}

function ventBCD(dtSec, depth) {
    var P = ambientPressure(depth);
    var ambientLiters = BUOYANCY_PARAMS.ventRate * dtSec;
    var surfEquiv = ambientLiters * P;
    if (surfEquiv > bcdGasSurfaceLiters) surfEquiv = bcdGasSurfaceLiters;
    bcdGasSurfaceLiters -= surfEquiv;
}

function updateBuoyancyPhysics(dtSec) {
    var BP = BUOYANCY_PARAMS;
    var P = ambientPressure(depth);

    // Overpressure relief (Boyle's law)
    var actualVol = bcdGasSurfaceLiters / P;
    if (actualVol > BP.bcdMaxCapacity) {
        bcdGasSurfaceLiters = BP.bcdMaxCapacity * P;
        actualVol = BP.bcdMaxCapacity;
    }

    // BCD lift = actual volume in liters = kg of lift
    var bcdLift = actualVol;

    // Wetsuit lift with compression
    var wetsuitLift = BP.wetsuitBuoyancySurface * Math.pow(1 / P, BP.wetsuitCompressionExp);

    // Net buoyancy (positive = upward lift)
    var netBuoyancy = bcdLift + wetsuitLift + BP.bodyBuoyancy - BP.leadWeight - BP.gearWeightNet;

    // Dead zone
    var effectiveBuoyancy = 0;
    if (Math.abs(netBuoyancy) > BP.neutralDeadZone) {
        effectiveBuoyancy = netBuoyancy;
    }

    // Acceleration (m/s²) — positive buoyancy → negative velocity (ascent)
    var accel = -effectiveBuoyancy * BP.gravityFactor;

    // Current velocity in m/s (convert from m/min)
    var velMPerS = verticalVelocity / 60;

    // Drag (opposes motion)
    var drag = -velMPerS * BP.dragCoefficient;

    // Integrate velocity
    velMPerS += (accel + drag) * dtSec;

    // Convert back to m/min and clamp
    verticalVelocity = velMPerS * 60;
    if (verticalVelocity < -BP.maxAscentRate) verticalVelocity = -BP.maxAscentRate;
    if (verticalVelocity > BP.maxDescentRate) verticalVelocity = BP.maxDescentRate;

    // Integrate depth (positive velocity = descending = depth increases)
    var _dz = verticalVelocity * (dtSec / 60);
    var _siteV = activeSite();
    // Sites with solid AABB structures need vertical collision too, not just
    // horizontal: overhead wrecks/caves (decks & bulkheads), AND open-water
    // sites that have boulders (e.g. shore). Without this the diver sinks
    // straight THROUGH a boulder to the sand and then gets trapped inside its
    // footprint (where horizontal motion is blocked) — popping up and lurching
    // as it bobs, which reads as the rocks jittering. With it the diver rests
    // on top of the boulder instead.
    var _solidSite = _siteV && (_siteV.hasOverhead ||
        (_siteV.structures && _siteV.structures.length));
    if (_solidSite && _dz !== 0) {
        // Sub-step finely so the diver cannot tunnel through a 1 m slab, and
        // only block when crossing from open water INTO solid (so a diver that
        // somehow starts inside a structure can still swim free).
        var vsteps = Math.max(1, Math.ceil(Math.abs(_dz) / 0.1));
        var vstep = _dz / vsteps;
        for (var vk = 0; vk < vsteps; vk++) {
            var ndp = depth + vstep;
            if (solidAt(diverX, ndp) && !solidAt(diverX, depth)) {
                verticalVelocity = 0;
                break;
            }
            depth = ndp;
        }
    } else {
        depth += _dz;
    }

    // Phase C: Site geometry vertical clamp (before global bounds)
    var _ceil = ceilingAt(diverX);
    var _flr  = floorAt(diverX);
    if (depth < _ceil) { depth = _ceil; if (verticalVelocity < 0) verticalVelocity = 0; }
    if (depth > _flr)  { depth = _flr;  if (verticalVelocity > 0) verticalVelocity = 0; }

    // Global bounds (outer limit — open water or site floor deeper than MAX_DEPTH)
    if (depth < 0) { depth = 0; verticalVelocity = 0; }
    if (depth > MAX_DEPTH) { depth = MAX_DEPTH; verticalVelocity = 0; }

    // Sync for backward compat
    currentVerticalRate = verticalVelocity;
}

// Phase B: Returns the ground-frame current velocity at a given depth (m/s).
function currentVelAt(d) {
    if (!current.active) return 0;
    if (d < current.depthMin || d > current.depthMax) return 0;
    return current.direction * current.level;
}

// Phase A/C: Horizontal fin-kick physics. kickDir = -1 | 0 | +1.
// horizontalVelocity is diver velocity RELATIVE TO WATER (water-frame model).
// Phase C adds sub-stepped collision against site geometry.
function updateHorizontalPhysics(dtSec, kickDir) {
    var FP = FINKICK_PARAMS;
    var v = horizontalVelocity;
    v += kickDir * FP.kickAccel * dtSec;           // kick impulse
    v -= v * FP.dragCoefficient * dtSec;           // drag (relative to water)
    v = Math.max(-FP.maxSpeed, Math.min(FP.maxSpeed, v));
    horizontalVelocity = v;

    var cv = currentVelAt(depth);
    var dispX = (v + cv) * dtSec;                  // intended displacement (m)
    // Sub-step to prevent tunnelling through thin bulkheads at 3× time accel
    var steps = Math.max(1, Math.ceil(Math.abs(dispX) / 0.3));
    var sx = dispX / steps;
    for (var k = 0; k < steps; k++) {
        var nx = diverX + sx;
        // Blocked by solid structure, or by terrain pinch at the new x position
        if (solidAt(nx, depth) || depth > floorAt(nx) || depth < ceilingAt(nx)) {
            horizontalVelocity = 0;
            break;
        }
        diverX = nx;
    }
}

// Phase C: Update per-tick overhead / silt / bad-air state.
// Called once per updateDiving() tick, after narcosis update.
function updateOverheadState(dtDiveSeconds) {
    inOverhead = overheadAt(diverX, depth);

    // Silt: fast kick near floor while enclosed degrades visibility
    var nearFloor = (floorAt(diverX) - depth) < 1.5;
    if (inOverhead && nearFloor && Math.abs(horizontalVelocity) > SILT_KICK_THRESHOLD) {
        visibility = Math.max(0, visibility - SILT_DECAY * dtDiveSeconds);
    } else {
        visibility = Math.min(1, visibility + SILT_RECOVER * dtDiveSeconds);
    }

    // Bad-air dome: diver's head inside an unbreathable air pocket
    var ba = badAirAt(diverX);
    badAirWarning = !!(ba && depth <= ba.d + 0.5);
}

function updateTissues(dtMinutes) {
    var pAmb = ambientPressure(depth);
    var gas;
    if (diveMode === 'ccr' && !ccrState.onBailout) {
        gas = getCCRInspiredGas(depth, ccrState.actualPO2);
    } else {
        gas = activeGas();
    }
    var piN2 = (pAmb - P_H2O) * gas.fN2;
    var piHe = (pAmb - P_H2O) * gas.fHe;
    for (var i = 0; i < 16; i++) {
        var kN2 = LN2 / ZHL16C_N2[i].ht;
        tissues[i] = piN2 + (tissues[i] - piN2) * Math.exp(-kN2 * dtMinutes);
        var kHe = LN2 / ZHL16C_HE[i].ht;
        tissuesHe[i] = piHe + (tissuesHe[i] - piHe) * Math.exp(-kHe * dtMinutes);
    }
}

// WP-038: CNS accumulation based on NOAA PO2 exposure limits
function updateCNS(dtMinutes) {
    var po2 = calculatePO2();
    var rate = 0; // %/min
    if (po2 <= 0.5) rate = 0;
    else if (po2 <= 0.6) rate = 0.14;
    else if (po2 <= 0.7) rate = 0.19;
    else if (po2 <= 0.8) rate = 0.28;
    else if (po2 <= 0.9) rate = 0.33;
    else if (po2 <= 1.1) rate = 0.42;
    else if (po2 <= 1.3) rate = 0.56;
    else if (po2 <= 1.5) rate = 0.83;
    else if (po2 <= 1.6) rate = 2.22;
    else rate = 10.0;
    cnsPercent += rate * dtMinutes;
}

// TASK-016: Combined M-value a,b
function combinedAB(i) {
    var ptN2 = tissues[i];
    var ptHe = tissuesHe[i];
    var total = ptN2 + ptHe;
    if (total < 0.0001) return { a: ZHL16C_N2[i].a, b: ZHL16C_N2[i].b };
    var a = (ZHL16C_N2[i].a * ptN2 + ZHL16C_HE[i].a * ptHe) / total;
    var b = (ZHL16C_N2[i].b * ptN2 + ZHL16C_HE[i].b * ptHe) / total;
    return { a: a, b: b };
}

// Combined a,b from arbitrary tissue arrays (for simulations)
function combinedABSim(simN2, simHe, i) {
    var ptN2 = simN2[i];
    var ptHe = simHe[i];
    var total = ptN2 + ptHe;
    if (total < 0.0001) return { a: ZHL16C_N2[i].a, b: ZHL16C_N2[i].b };
    var a = (ZHL16C_N2[i].a * ptN2 + ZHL16C_HE[i].a * ptHe) / total;
    var b = (ZHL16C_N2[i].b * ptN2 + ZHL16C_HE[i].b * ptHe) / total;
    return { a: a, b: b };
}

// TASK-016: Iterative NDL with combined gases (TASK-037: GF High applied)
function calculateNDL() {
    var simN2 = tissues.slice();
    var simHe = tissuesHe.slice();
    var gas;
    if (diveMode === 'ccr' && !ccrState.onBailout) {
        gas = getCCRInspiredGas(depth, ccrState.targetSP);
    } else {
        gas = activeGas();
    }
    var pAmb = ambientPressure(depth);
    var piN2 = (pAmb - P_H2O) * gas.fN2;
    var piHe = (pAmb - P_H2O) * gas.fHe;
    var stepMin = 0.5;
    var totalMin = 0;
    var gfH = gfHigh / 100;

    for (var step = 0; step < 400; step++) {
        for (var i = 0; i < 16; i++) {
            var kN2 = LN2 / ZHL16C_N2[i].ht;
            simN2[i] = piN2 + (simN2[i] - piN2) * Math.exp(-kN2 * stepMin);
            var kHe = LN2 / ZHL16C_HE[i].ht;
            simHe[i] = piHe + (simHe[i] - piHe) * Math.exp(-kHe * stepMin);
        }
        totalMin += stepMin;

        var exceeded = false;
        for (var i = 0; i < 16; i++) {
            var ab = combinedABSim(simN2, simHe, i);
            var m0 = ab.a + 1.0 / ab.b;
            var mAllowed = gfH * (m0 - 1.0) + 1.0;
            var ptTotal = simN2[i] + simHe[i];
            if (ptTotal > mAllowed) { exceeded = true; break; }
        }
        if (exceeded) return Math.floor(totalMin);
    }
    return 999;
}

// TASK-016: Ceiling with combined a,b (TASK-036: GF High applied)
function calculateCeiling() {
    var maxCeil = 0;
    var gfH = gfHigh / 100;
    for (var i = 0; i < 16; i++) {
        var ab = combinedAB(i);
        var totalLoad = tissues[i] + tissuesHe[i];
        var ceil = (totalLoad - ab.a * gfH) / (gfH / ab.b + 1 - gfH);
        if (ceil > maxCeil) maxCeil = ceil;
    }
    return Math.max(0, (maxCeil - 1.0) * 10.0);
}

function decoStop(ceilDepth) {
    if (ceilDepth <= 0) return 0;
    return Math.ceil(ceilDepth / 3) * 3;
}

// TASK-016: Deco schedule with combined N2+He (TASK-038: GF interpolation)
function calculateDecoSchedule() {
    var ceilDepth = calculateCeiling();
    if (ceilDepth <= 0) return { stops: [], tts: 0 };

    var gas;
    if (diveMode === 'ccr' && !ccrState.onBailout) {
        gas = getCCRInspiredGas(depth, ccrState.targetSP);
    } else {
        gas = activeGas();
    }
    var simN2 = tissues.slice();
    var simHe = tissuesHe.slice();
    var simDepth = depth;
    var totalTime = 0;
    var stops = [];
    var firstStop = decoStop(ceilDepth);
    var gfL = gfLow / 100;
    var gfH = gfHigh / 100;

    function gfAtDepth(d) {
        if (firstStop <= 0) return gfH;
        var frac = Math.max(0, Math.min(1, d / firstStop));
        return gfH + (gfL - gfH) * frac;
    }

    function simUpdate(d, dt) {
        var pAmb = ambientPressure(d);
        var piN2 = (pAmb - P_H2O) * gas.fN2;
        var piHe = (pAmb - P_H2O) * gas.fHe;
        for (var i = 0; i < 16; i++) {
            var kN2 = LN2 / ZHL16C_N2[i].ht;
            simN2[i] = piN2 + (simN2[i] - piN2) * Math.exp(-kN2 * dt);
            var kHe = LN2 / ZHL16C_HE[i].ht;
            simHe[i] = piHe + (simHe[i] - piHe) * Math.exp(-kHe * dt);
        }
    }

    function simCeiling(currentGF) {
        var maxCeil = 0;
        for (var i = 0; i < 16; i++) {
            var ab = combinedABSim(simN2, simHe, i);
            var ptTotal = simN2[i] + simHe[i];
            var ceil = (ptTotal - ab.a * currentGF) / (currentGF / ab.b + 1 - currentGF);
            if (ceil > maxCeil) maxCeil = ceil;
        }
        return Math.max(0, (maxCeil - 1.0) * 10.0);
    }

    if (simDepth > firstStop) {
        var ascentTime = (simDepth - firstStop) / 3.0;
        var steps = Math.ceil(ascentTime / 0.1);
        var stepTime = ascentTime / steps;
        var stepDepthChange = (simDepth - firstStop) / steps;
        for (var s = 0; s < steps; s++) {
            simDepth -= stepDepthChange;
            if (diveMode === 'ccr' && !ccrState.onBailout) {
                gas = getCCRInspiredGas(simDepth, ccrState.targetSP);
            } else {
                gas = bestGasForDepth(simDepth);
            }
            simUpdate(simDepth, stepTime);
        }
        totalTime += ascentTime;
    }

    var stopDepth = firstStop;
    var safetyIter = 0;
    while (stopDepth > 0 && safetyIter < 500) {
        safetyIter++;
        var stopTime = 0;
        var nextStop = stopDepth - 3;
        var iter = 0;
        if (diveMode === 'ccr' && !ccrState.onBailout) {
            gas = getCCRInspiredGas(stopDepth, ccrState.targetSP);
        } else {
            gas = bestGasForDepth(stopDepth);
        }
        while (iter < 3000) {
            iter++;
            simUpdate(stopDepth, 0.1);
            stopTime += 0.1;
            totalTime += 0.1;
            var gfForNext = gfAtDepth(Math.max(0, nextStop));
            var c = simCeiling(gfForNext);
            if (c <= Math.max(0, nextStop)) break;
        }
        stops.push({ depth: stopDepth, time: Math.ceil(stopTime) });

        if (nextStop > 0) {
            simDepth = nextStop;
            if (diveMode === 'ccr' && !ccrState.onBailout) {
                gas = getCCRInspiredGas(nextStop, ccrState.targetSP);
            } else {
                gas = bestGasForDepth(nextStop);
            }
            simUpdate(nextStop, 1.0);
            totalTime += 1.0;
        } else {
            if (diveMode === 'ccr' && !ccrState.onBailout) {
                gas = getCCRInspiredGas(0, ccrState.targetSP);
            } else {
                gas = bestGasForDepth(0);
            }
            simUpdate(0, stopDepth / 3.0);
            totalTime += stopDepth / 3.0;
            break;
        }
        stopDepth = nextStop;
    }

    return { stops: stops, tts: Math.ceil(totalTime) };
}

// SECTION: O2 and gas math
// SEARCH TERMS: calculatePO2, calculateMOD, calculateGTR, calculateTTS, cnsPercent, po2ViolationTime

// ============================================================
//  O2 & GAS
// ============================================================

function calculatePO2() {
    return activeGas().fO2 * ambientPressure(depth);
}

function calculateMOD(o2) {
    var fo2 = o2 || activeGas().fO2;
    return ((1.4 / fo2) - 1) * 10;
}

function calculateMinDepth(fO2) {
    if (fO2 <= 0) return 0;
    var minD = ((PO2_HYPOXIA / fO2) - 1) * 10;
    return Math.max(0, Math.round(minD * 10) / 10);
}

function calculateGTR() {
    if (diveMode === 'ccr' && !ccrState.onBailout) {
        if (ccrState.metabolicO2Rate <= 0) return 999;
        return (ccrState.o2CylPressure * ccrState.o2CylVolume) / ccrState.metabolicO2Rate;
    }
    var tank = getActiveTank();
    var pAmb = ambientPressure(depth);
    var consumptionRate = amvRate * pAmb;
    if (consumptionRate <= 0) return 999;
    return tank.gasRemaining / consumptionRate;
}

function calculateTTS() {
    if (depth < 0.5) return 0;
    var ceilDepth = calculateCeiling();
    var inDecoTTS = decoStop(ceilDepth) > 0;
    if (inDecoTTS) {
        var sched = calculateDecoSchedule();
        return sched.tts;
    }
    var ascentTime = depth / 9.0;
    var ssTime = 0;
    if (safetyStopNeeded || maxDepth > 11) {
        ssTime = calculateSafetyStopDuration() / 60;
    }
    return Math.ceil(ascentTime + ssTime);
}

// WP-020: Narcosis engine
function smoothstep(edge0, edge1, x) {
    var t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
}

function calculateNarcoticPP() {
    var tank = getActiveTank();
    var ambientBar = 1 + depth / 10;
    return (1 - tank.fHe) * ambientBar;
}

function calculateEND() {
    var tank = getActiveTank();
    return Math.max(0, (depth + 10) * (1 - tank.fHe) - 10);
}

function updateNarcosis(dtDiveSec) {
    var pNarc = calculateNarcoticPP();
    var targetNarcosis = smoothstep(NARC_ONSET_BAR, NARC_FULL_BAR, pNarc);

    if (targetNarcosis > narcosisIndex) {
        narcosisIndex += (targetNarcosis - narcosisIndex) * NARC_RAMP_UP * dtDiveSec;
    } else {
        narcosisIndex += (targetNarcosis - narcosisIndex) * NARC_RAMP_DOWN * dtDiveSec;
    }
    narcosisIndex = Math.max(0, Math.min(1, narcosisIndex));

    if (narcosisIndex >= NARC_KO_THRESHOLD) {
        narcosisKOTime += dtDiveSec;
    } else {
        narcosisKOTime = 0;
    }
}

// Adaptive safety stop duration
// 5 minutes if dive exceeded 30m or NDL dropped below 5 min; otherwise 3 minutes
function calculateSafetyStopDuration() {
    if (maxDepth > 30 || ndlDroppedBelow5) return 5 * 60;
    return 3 * 60;
}

function getCCRInspiredGas(d, po2) {
    var pAmb = ambientPressure(d);
    var fO2Loop = Math.min(po2 / pAmb, 1.0);
    if (fO2Loop < 0) fO2Loop = 0;
    var fInert = 1 - fO2Loop;
    if (fInert < 0) fInert = 0;
    var totalInertDil = ccrState.dilFN2 + ccrState.dilFHe;
    var fN2, fHe;
    if (totalInertDil < 0.001) {
        fN2 = fInert;
        fHe = 0;
    } else {
        fN2 = fInert * (ccrState.dilFN2 / totalInertDil);
        fHe = fInert * (ccrState.dilFHe / totalInertDil);
    }
    return { fO2: fO2Loop, fN2: fN2, fHe: fHe };
}

function bestGasForDepth(d) {
    if (!isAdvanced()) return { fO2: tanks[activeTank].fO2, fHe: tanks[activeTank].fHe, fN2: tanks[activeTank].fN2 };
    var best = null;
    var bestO2 = -1;
    for (var i = 0; i < tankCount; i++) {
        var t = tanks[i];
        if (t.gasRemaining <= 0) continue;
        var po2 = t.fO2 * ambientPressure(d);
        if (po2 > PO2_HIGH || po2 < PO2_HYPOXIA) continue;
        // DISABLED: Staging of bottles — all tanks available at all depths for now
        // if (i > 0 && t.switchDepth !== null && d > t.switchDepth) continue;
        if (t.fO2 > bestO2) { bestO2 = t.fO2; best = t; }
    }
    if (!best) best = tanks[activeTank];
    return { fO2: best.fO2, fHe: best.fHe, fN2: best.fN2 };
}

function recommendBestGas() {
    var bestIdx = activeTank;
    var bestFO2 = 0;
    var pAmb = ambientPressure(depth);
    for (var i = 0; i < tankCount; i++) {
        if (tanks[i].gasRemaining <= 0) continue;
        var po2 = tanks[i].fO2 * pAmb;
        if (po2 <= 1.4 && tanks[i].fO2 > bestFO2) {
            bestFO2 = tanks[i].fO2;
            bestIdx = i;
        }
    }
    return bestIdx;
}

function po2Color(po2) {
    if (po2 < PO2_HYPOXIA) return '#ff3333';
    if (po2 <= PO2_SAFE)    return '#33ff33';
    if (po2 <= PO2_ELEVATED) return '#ffff33';
    if (po2 <= PO2_HIGH)    return '#ff9933';
    return '#ff3333';
}

function tankBar() {
    var t = getActiveTank();
    return t.gasRemaining / t.volume;
}

function tankColor() {
    var bar = tankBar();
    if (bar > 100) return '#33ff33';
    if (bar >= 50) return '#ffff33';
    return '#ff3333';
}