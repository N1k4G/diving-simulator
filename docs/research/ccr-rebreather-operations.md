# Research: Closed Circuit Rebreather (CCR) Operations

> **Date**: 2026-05-01
> **Requested by**: @architect
> **Research brief**: Deep-dive research into CCR diving operations to inform implementation of a CCR mode in the diving simulator — covering fundamentals, PO2 setpoints, gas consumption, decompression, failure modes, bailout, the reference dive computerCCR display, and a simplified game model.
> **Sources consulted**: 2 successful / 3 attempted

---

## Executive Summary

A Closed Circuit Rebreather (CCR) recycles the diver's exhaled breath by scrubbing CO2 and adding oxygen to maintain a target partial pressure (setpoint). Unlike open circuit where gas is wasted with every exhalation, CCR uses only the metabolic oxygen consumed (~0.8–1.0 L/min at rest, independent of depth). The diver controls PO2 via setpoints (typically 0.7 for ascent/descent, 1.3 for bottom phase). This constant-PO2 approach fundamentally changes decompression calculations — the fraction of inert gas in the loop varies with depth, giving CCR divers a significant decompression advantage at shallower depths. Failure modes include hypoxia, hyperoxia, hypercapnia, and loop flooding — all potentially fatal within seconds to minutes.

---

## Source Summaries

### 1. Wikipedia — Rebreather
- **URL**: https://en.wikipedia.org/wiki/Rebreather
- **Tier**: 2 (well-maintained wiki with authoritative citations including US Navy Diving Manual)
- **Relevance**: High

**Key facts:**
- Base metabolism requires ~0.25 L/min O2; fit person working hard metabolises ~4 L/min
- Exhaled air contains 13.5–16% O2 (only ~4–5% consumed per breath)
- CCR adds O2 to replenish metabolic usage, scrubs CO2, recycles the rest
- Loop architecture: mouthpiece → exhalation hose → scrubber → counterlung → inhalation hose (one-way valves enforce direction)
- Counterlung holds exhaled gas volume until reinhalation
- Scrubber uses soda lime (Ca(OH)2 + NaOH); 100g removes 15–25L CO2 at surface pressure
- O2 sensors monitor PO2; solenoid valve adds O2 when PO2 drops below setpoint
- Endurance limited by O2 supply rate and scrubber capacity (independent of depth)
- PO2 reference table: <0.16 = hypoxia symptoms, 0.21 = sea level air, 1.0–1.2 = recreational CCR setpoint, 1.4 = OC recreational limit, 1.6 = NOAA working diver limit
- Failure modes: hypoxia (PO2 too low), CO2 buildup (scrubber failure), caustic cocktail (loop flooding wets scrubber), hyperoxia (PO2 too high)
- Electronically controlled CCRs maintain PO2 between programmable setpoints and integrate with decompression computers

### 2. Wikipedia — Rebreather (Closed-circuit redirect)
- **URL**: https://en.wikipedia.org/wiki/Closed-circuit_rebreather
- **Tier**: 2
- **Relevance**: High (same article, redirected)

**Key facts (additional):**
- CCR uses two parallel gas supplies: diluent (bulk gas, recycled) and oxygen (metabolically expended)
- Gas is only dumped from loop during ascent (expansion) or intentional flushing
- Diluent added only when loop volume decreases (descent)
- Semi-closed vs fully closed: CCR is fully closed — no gas leaves unless overpressure vents during ascent

### 3. the manufacturer Blog — Intro to CCR Diving
- **URL**: source-link-removed
- **Tier**: 1 (manufacturer)
- **Relevance**: High
- **Status**: ❌ 404 — page not found

---

## Key Findings

### 1. CCR Fundamentals

**How a CCR Works:**

```
┌─────────────────────────────────────────────────────────────────┐
│                    BREATHING LOOP                                 │
│                                                                   │
│  Diver ──exhale──► Exhalation Hose ──► SCRUBBER (removes CO2)   │
│    ▲                                        │                     │
│    │                                        ▼                     │
│    │              Inhalation Hose ◄── COUNTERLUNG                │
│    └────inhale────────────────────────────────┘                  │
│                                                                   │
│  O2 Cylinder ──solenoid/manual──► adds O2 to loop               │
│  Diluent Cyl ──ADV/manual──► adds diluent to loop (descent)     │
│                                                                   │
│  Overpressure Valve ──► vents excess gas (ascent)                │
└─────────────────────────────────────────────────────────────────┘
```

**Components:**
- **Breathing loop**: Closed circuit of hoses, scrubber, and counterlung(s) containing the gas the diver breathes
- **Scrubber**: Canister of soda lime that chemically removes CO2 from exhaled gas
- **Counterlung**: Flexible bag(s) that expand/contract with breathing, maintaining loop volume
- **O2 cylinder**: Pure oxygen supply (typically 2–3L at 200 bar)
- **Diluent cylinder**: Inert gas supply — air, nitrox, or trimix (typically 2–3L at 200 bar)
- **O2 sensors**: 2–3 galvanic cells monitoring PO2 in the loop (typically voting logic)
- **Solenoid valve**: Electronically controlled valve that injects O2 when PO2 drops below setpoint
- **ADV (Automatic Diluent Valve)**: Adds diluent when loop volume drops (like a demand valve)
- **Manual add buttons**: Diver can manually inject O2 or diluent
- **Overpressure valve (OPV)**: Vents gas when loop is overfull (ascending)
- **Dive/Surface valve (DSV)**: Isolates the loop when mouthpiece is removed

**Loop Volume:**
- Typical loop volume: 5–8 litres total (hoses + counterlung + scrubber void space)
- Loop volume matters because:
  - It determines how quickly PO2 changes when O2 is added or consumed
  - Smaller loop = faster PO2 response but less breathing comfort
  - Loop must maintain enough volume for comfortable tidal breathing (~2L tidal volume)
  - On descent, loop compresses (Boyle's Law) and ADV/manual diluent adds gas
  - On ascent, loop expands and OPV vents excess

---

### 2. PO2 and Setpoints

**What is a Setpoint (SP)?**

A setpoint is the target partial pressure of oxygen (PO2) that the CCR electronics attempt to maintain in the breathing loop. The solenoid fires O2 into the loop whenever measured PO2 drops below the setpoint.

**Relationship between SP, depth, and loop FO2:**

```
PO2 = FO2 × P_ambient

Therefore: FO2 = SP / P_ambient = SP / (1 + depth/10)
```

Example at SP 1.3:
- Surface (1 bar): FO2 = 1.3/1.0 = 130% → impossible, PO2 maxes at ~0.95 with air diluent
- 10m (2 bar): FO2 = 1.3/2.0 = 65%
- 30m (4 bar): FO2 = 1.3/4.0 = 32.5%
- 60m (7 bar): FO2 = 1.3/7.0 = 18.6%

**Typical Setpoints:**
| Setpoint | Value (bar) | Usage |
|----------|-------------|-------|
| Low SP | 0.7 | Descent, ascent, surface — prevents hyperoxia at surface |
| High SP | 1.3 | Bottom phase — maximum safe O2 for deco advantage |
| Emergency low | 0.4 | Absolute minimum survivable (hypoxic) |
| Max recreational | 1.4 | Upper limit for most recreational CCR |
| Max deco | 1.6 | NOAA maximum for decompression phase |

**Manual PO2 Control:**
- **Automatic (electronic)**: Solenoid injects O2 whenever PO2 < setpoint. Most modern CCRs.
- **Manual override**: Diver presses O2-add button to inject a burst of O2 (raises PO2)
- **Manual CCR (mCCR)**: No solenoid — diver must manually inject O2 by watching PO2 display and pressing button. Constant mass flow orifice provides baseline O2, diver supplements.
- **Setpoint switching**: Diver changes target SP (e.g., 0.7 → 1.3 on reaching bottom). System then automatically adjusts O2 injection to reach new setpoint.

**How PO2 changes in the loop:**
- PO2 naturally drops as diver metabolises O2 (consumption ~0.5–1.5 L/min surface equivalent)
- PO2 rises when O2 is injected (solenoid burst or manual)
- PO2 changes with depth: ascending raises PO2 of existing gas (Dalton's Law inverted — actually decreasing absolute pressure decreases PO2) — CORRECTION: ascending DECREASES ambient pressure, so PO2 decreases. Descending INCREASES ambient pressure which... no. PO2 = FO2 × P_ambient. If FO2 stays constant and P_ambient increases, PO2 increases. But in a CCR loop the total moles of O2 don't change with depth (closed system) — what changes is loop volume (compression). Let me be precise:

**Critical physics — PO2 and depth changes in a CCR:**
- In a closed loop (no gas added/removed), as depth increases:
  - Loop volume decreases (Boyle's Law)
  - But the moles of each gas remain constant
  - The partial pressures remain constant (P = nRT/V, and P_ambient also increases proportionally)
  - Actually: in a flexible counterlung at ambient pressure, PO2 stays constant if no gas is added/removed and depth changes — the fraction changes but partial pressure doesn't!
- BUT: ADV adds diluent on descent → dilutes the O2 → PO2 drops → solenoid fires to restore SP
- On ascent: loop expands → OPV vents gas (mix stays same composition) → PO2 stays same
- Net effect: PO2 drifts down on descent (dilution), system adds O2 to compensate

**For the simulator, the simplified model:**
- Descent: diluent added → PO2 drops → O2 injection brings it back to SP
- At constant depth: metabolic O2 consumption drops PO2 → solenoid maintains SP
- Ascent: PO2 stays near SP (gas vented maintains composition)
- Setpoint change: system injects O2 (or waits for metabolism to consume) to reach new target

---

### 3. Gas Consumption in CCR

**O2 Consumption:**
- Metabolic O2 use is constant regardless of depth: ~0.5–1.5 L/min (surface equivalent)
- Resting/relaxed diving: ~0.7–0.8 L/min
- Moderate exertion: ~1.0 L/min
- Heavy work: ~1.5–2.0 L/min
- This is the ONLY continuous gas consumption on a CCR

**Diluent Consumption:**
- Diluent is consumed ONLY when adding volume to the loop:
  - On descent (loop compression)
  - After flushing the loop
  - After any gas loss (leak)
- Descent consumption = loop volume × (P2/P1 - 1) for each descent segment
- Example: 6L loop, descending from 0m to 40m: needs 6 × (5/1 - 1) = 24L of diluent
- Once at depth: NO further diluent consumption (unlike OC where every breath uses gas)

**Why CCR is gas-efficient:**
- OC at 40m: 20 L/min × 5 ATA = 100 L/min from cylinder (surface equivalent: 20 L/min SAC × 5)
- CCR at 40m: ~1 L/min O2 only (just metabolic use)
- Ratio: CCR uses ~1/100th the gas of OC at 40m!
- Deeper = more advantage

**Typical Cylinder Sizes and Durations:**

| Cylinder | Volume | Pressure | Total Gas | Duration |
|----------|--------|----------|-----------|----------|
| O2 | 2L | 200 bar | 400L | ~400–570 min at 0.7–1.0 L/min |
| O2 | 3L | 200 bar | 600L | ~600–850 min |
| Diluent | 2L | 200 bar | 400L | Multiple deep dives (descent only) |
| Diluent | 3L | 200 bar | 600L | Multiple deep dives + bailout reserve |

**Key insight**: O2 duration is limited by scrubber life, not cylinder capacity. Most scrubbers last 2–4 hours (varies with water temperature, depth, workload).

---

### 4. Decompression on CCR

**How Constant PO2 Affects Tissue Loading:**

On open circuit, the inspired gas fraction is fixed (e.g., 21% O2, 79% N2). On CCR, the O2 fraction varies with depth to maintain constant PO2, meaning the inert gas fraction also varies:

```
fN2_loop = 1 - (SP / P_ambient)     [for air diluent, assuming no He]
fN2_loop = fN2_diluent × (1 - SP / P_ambient) / (1 - fO2_diluent)   [general]
```

**Simplified for air diluent (79% N2, 21% O2):**
```
fN2_loop = (P_ambient - SP) / P_ambient × (0.79 / 0.79)
         = 1 - SP/P_ambient    [approximately, ignoring the O2 in diluent]
```

More precisely:
```
fO2_loop = SP / P_ambient
fN2_loop = (1 - fO2_loop) × (fN2_diluent / (1 - fO2_diluent))

For air diluent: fN2_loop = (1 - SP/P_ambient) × (0.79/0.79) = 1 - SP/P_ambient
```

**Example at SP 1.3 with air diluent:**
| Depth | P_ambient | fO2_loop | fN2_loop | ppN2 |
|-------|-----------|----------|----------|------|
| 10m | 2.0 bar | 0.65 | 0.35 | 0.70 |
| 20m | 3.0 bar | 0.43 | 0.57 | 1.70 |
| 30m | 4.0 bar | 0.325 | 0.675 | 2.70 |
| 40m | 5.0 bar | 0.26 | 0.74 | 3.70 |
| 50m | 6.0 bar | 0.217 | 0.783 | 4.70 |

**Compare to OC air (21% O2, 79% N2):**
| Depth | ppN2 OC | ppN2 CCR (SP 1.3) | CCR advantage |
|-------|---------|---------------------|---------------|
| 10m | 1.58 | 0.70 | CCR much less N2 loading |
| 20m | 2.37 | 1.70 | CCR less N2 loading |
| 30m | 3.16 | 2.70 | CCR slightly less |
| 40m | 3.95 | 3.70 | Almost equal at depth |

**Key decompression insight:** CCR provides massive deco advantage at shallow depths (high O2 fraction accelerates off-gassing) but similar inert gas loading at depth.

**Bühlmann Adaptation for CCR:**

The existing Bühlmann ZHL-16C algorithm works identically for CCR, with one change:
- Instead of using a fixed `fN2` per gas mix, calculate `fN2_loop` at each depth sample based on the current PO2 and ambient pressure
- Tissue loading equation remains: `Pt(t) = Pt(0) + (Pi - Pt(0)) × (1 - 2^(-t/ht))`
- Where `Pi = fN2_loop × P_ambient = (P_ambient - SP)` for air diluent
- Actually simpler: `Pi_N2 = P_ambient - SP - ppH2O` (ambient minus O2 setpoint minus water vapor)
  - For air diluent: `Pi_N2 = P_ambient - SP` (approximately)
  - For trimix diluent with He: split inert gas into N2 and He fractions

**Gradient Factors on CCR:**
- GF Low/High apply identically to CCR as to OC
- The M-values and tissue half-times are the same
- Only the inspired inert gas pressure changes (it's variable, not fixed)
- Ascent planning: at each stop depth, recalculate fN2_loop based on that depth's ambient pressure and SP

**Decompression advantage summary:**
- During ascent, as depth decreases, SP/P_ambient increases → higher O2 fraction → lower inert gas fraction → faster off-gassing
- At 6m stop: fO2 = 1.3/1.6 = 81% (like breathing EAN80 on OC!)
- At 3m stop: fO2 = 1.3/1.3 = 100% (like pure O2 on OC!)
- This is why CCR divers have shorter decompression obligations

---

### 5. Failure Modes & Safety

#### Hypoxia (PO2 < 0.16)
- **Cause**: O2 supply failure, solenoid stuck closed, O2 cylinder empty, incorrect diluent flush
- **Warning signs**: None reliable — hypoxia is insidious. No air hunger (CO2 still scrubbed). May feel euphoric.
- **Time to incapacitation**: At PO2 0.10 → unconsciousness in 10–20 seconds
- **PO2 thresholds**:
  - 0.16 bar: Initial symptoms (impaired judgment, euphoria)
  - 0.12 bar: Serious impairment
  - 0.10 bar: Unconsciousness
  - 0.08 bar: Coma → death
- **For simulator**: Gradual vision darkening below 0.16, blackout below 0.10. Time to blackout: ~15–30 seconds from 0.16 to unconsciousness.

#### Hyperoxia / O2 Toxicity (PO2 > 1.6)
- **Cause**: Solenoid stuck open, ascending with high SP still set, manual O2 addition error
- **Warning signs**: Twitching, tunnel vision, nausea, dizziness (but often no warning → seizure)
- **Time to seizure**: Highly variable — can be instantaneous at PO2 > 2.0, or 10–45 minutes at PO2 1.6–1.8
- **PO2 thresholds**:
  - 1.4 bar: Recommended recreational OC limit
  - 1.6 bar: NOAA maximum working limit; decompression limit
  - 2.0+ bar: High risk of immediate CNS oxygen toxicity seizure
- **For simulator**: Warning at PO2 > 1.6. CNS toxicity "hit" probability increases with exposure time × PO2. Seizure = game over (unconscious underwater = drowning).

#### Hypercapnia / CO2 Buildup (Scrubber Failure)
- **Cause**: Scrubber exhausted, improperly packed, flooded, bypassed
- **Warning signs**: Headache, breathlessness, panic, increased breathing rate, confusion
- **Time to incapacitation**: 
  - CO2 at 3%: Increased breathing rate, headache (5–10 min tolerable)
  - CO2 at 5%: Severe distress, panic (2–5 min to incapacitation)
  - CO2 at 8%+: Unconsciousness within 1–2 minutes
- **For simulator**: "Scrubber timer" counts down. When expired, CO2 builds progressively. Breathing rate indicator increases. 2–5 minutes to game over after breakthrough.

#### Loop Flooding
- **Cause**: Mouthpiece removed without closing DSV, leak in hose/counterlung, damaged O-ring
- **Warning signs**: Gurgling sound, water in mouthpiece, "caustic cocktail" taste (burning)
- **Time to incapacitation**: Immediate if aspirated; caustic cocktail causes coughing/choking within seconds
- **For simulator**: Instant critical alarm. If not addressed (bailout), game over in ~10–30 seconds.

---

### 6. Bailout Procedure

**What happens when a CCR fails:**
1. Diver closes mouthpiece (DSV to surface/off position)
2. Switches to open-circuit bailout gas (regulator from bailout cylinder)
3. Begins ascent on open circuit following decompression schedule
4. May switch between multiple bailout gases at appropriate depths (like OC tec diving)

**Bailout Gas Planning:**
- Must carry enough OC gas to ascend from maximum depth including all deco stops
- Rule of thumb: plan bailout as if entire ascent is on OC
- Typical bailout rig: 1–3 stage bottles (bottom gas + deco gases)
- Connects directly to existing OC tank/gas management system in the simulator

**Connection to simulator's existing tank system:**
- CCR mode should still support OC tanks as bailout
- On bailout event, simulator switches from CCR loop to OC breathing from selected tank
- Gas consumption then follows normal OC model (AMV × ambient pressure)
- Deco calculations switch from constant-PO2 to fixed-FO2 for the bailout gas

---

### 7. the reference dive computer in CCR Mode

**Display differences in CC/BO mode vs OC:**
- Primary PO2 display: Shows current loop PO2 from O2 sensors (large, prominent)
- Setpoint indicator: Shows current target SP (e.g., "SP 1.3")
- Multiple sensor readings: Shows individual O2 cell values (e.g., 1.29 / 1.31 / 1.30)
- Diluent gas display: Shows configured diluent mix
- No tank pressure from loop (external monitoring by rebreather head unit)
- Bailout gas list: Configured OC gases for emergency
- Deco calculated based on constant PO2 (not fixed FO2)

**CCR-Specific Warnings/Alarms:**
- **PO2 High** (red): Loop PO2 exceeds high alarm threshold (typically > 1.5 or 1.6)
- **PO2 Low** (red): Loop PO2 below low alarm threshold (typically < 0.4)
- **Sensor disagreement**: O2 cells reading inconsistently (voting logic failure)
- **Setpoint not achieved**: PO2 significantly below setpoint for extended time
- **Cell voltage warning**: O2 sensor degrading (millivolt reading)

**How diver adjusts setpoints on the reference dive computer:**
- the reference dive computeris a MONITOR, not a controller — it doesn't fire the solenoid
- Diver changes SP on the rebreather's own controller (handset/HUD)
- the reference dive computerreads current PO2 from external input or its own sensors
- SP can be configured in the reference dive computersettings so deco calculations match
- Switch between "SP Low" and "SP High" via menu or automatic depth triggers
- Some setups: automatic SP switch at a configurable depth (e.g., switch to SP 1.3 below 10m)

**For our simulator (the reference dive computerHUD in CCR mode):**
- Replace tank pressure display with PO2 reading (large, color-coded)
- Show current SP target
- Show O2 and diluent cylinder pressures (side indicators)
- Deco calculations use CCR constant-PO2 model
- Alarm system adds PO2 high/low warnings

---

### 8. Simplified Model for Game Simulator

#### Architecture

```javascript
// CCR State Object
const ccrState = {
    // Loop
    loopVolume: 6.0,           // litres (total breathing loop volume)
    loopPO2: 0.7,              // current actual PO2 in loop (bar)
    targetSP: 0.7,             // current setpoint target
    
    // O2 Cylinder
    o2CylinderVolume: 2.0,     // litres water volume
    o2CylinderPressure: 200,   // bar (starts full)
    o2CylinderMaxPressure: 200,
    
    // Diluent Cylinder  
    dilCylinderVolume: 3.0,    // litres water volume
    dilCylinderPressure: 200,  // bar (starts full)
    dilCylinderMaxPressure: 200,
    dilFO2: 0.21,              // fraction O2 in diluent (air = 0.21)
    dilFN2: 0.79,              // fraction N2 in diluent (air = 0.79)
    dilFHe: 0.00,              // fraction He in diluent (air = 0)
    
    // Scrubber
    scrubberDuration: 180,     // minutes total capacity
    scrubberRemaining: 180,    // minutes remaining
    scrubberFailed: false,
    
    // Solenoid / Control
    solenoidActive: true,      // true = electronic control working
    manualO2Rate: 2.0,         // litres/second when manual O2 button pressed
    solenoidInjectionRate: 1.5,// litres/second when solenoid fires
    
    // PO2 response
    po2ResponseRate: 0.05,     // bar per second (how fast actual PO2 approaches target)
    
    // Metabolic
    o2ConsumptionRate: 0.8,    // litres/min surface equivalent (metabolic)
    
    // Status
    onBailout: false,          // true = switched to OC
    loopFlooded: false
};
```

#### O2 Cylinder Consumption Model

```javascript
function updateO2Consumption(dt_seconds) {
    // Metabolic O2 use (constant, independent of depth)
    const metabolicO2 = ccrState.o2ConsumptionRate / 60 * dt_seconds; // litres at surface
    
    // Solenoid injection to maintain setpoint (on top of metabolic)
    // This O2 is "used" from the cylinder
    const o2Used = metabolicO2; // surface litres consumed from cylinder
    
    // Reduce cylinder pressure
    // P × V = n × R × T → ΔP = ΔV_gas / V_cylinder
    const pressureDrop = o2Used / ccrState.o2CylinderVolume;
    ccrState.o2CylinderPressure -= pressureDrop;
    
    if (ccrState.o2CylinderPressure <= 0) {
        ccrState.o2CylinderPressure = 0;
        // O2 empty → PO2 will drop (metabolic consumption with no replacement)
    }
}
```

#### Diluent Consumption Model

```javascript
function updateDiluentOnDescent(depthChange, currentDepth) {
    if (depthChange <= 0) return; // only consumed on descent
    
    // Volume of diluent needed to maintain loop volume during descent
    const P1 = 1 + (currentDepth - depthChange) / 10;
    const P2 = 1 + currentDepth / 10;
    const dilNeeded = ccrState.loopVolume * (P2/P1 - 1); // litres at depth
    const dilSurface = dilNeeded * P2; // convert to surface equivalent
    
    // Actually: ADV delivers gas at ambient pressure from cylinder
    // Cylinder delivers surface-equivalent litres
    const pressureDrop = dilNeeded * P2 / ccrState.dilCylinderVolume;
    ccrState.dilCylinderPressure -= pressureDrop;
    
    if (ccrState.dilCylinderPressure <= 0) {
        ccrState.dilCylinderPressure = 0;
        // Diluent empty → loop may collapse on descent
    }
}
```

#### PO2 Control Loop

```javascript
function updateLoopPO2(dt_seconds, currentDepth) {
    const P_ambient = 1 + currentDepth / 10;
    
    // 1. Metabolic O2 consumption reduces PO2
    // O2 consumed = metabolicRate (litres/min surface equiv) converted to partial pressure drop
    const loopMolesO2_consumed = (ccrState.o2ConsumptionRate / 60 * dt_seconds);
    const po2Drop = loopMolesO2_consumed / (ccrState.loopVolume) ; // simplified
    ccrState.loopPO2 -= po2Drop;
    
    // 2. Solenoid/manual adds O2 if PO2 < setpoint (and O2 available)
    if (ccrState.solenoidActive && ccrState.o2CylinderPressure > 0) {
        if (ccrState.loopPO2 < ccrState.targetSP) {
            // Inject O2 — approach setpoint at response rate
            const maxIncrease = ccrState.po2ResponseRate * dt_seconds;
            const needed = ccrState.targetSP - ccrState.loopPO2;
            const increase = Math.min(maxIncrease, needed);
            ccrState.loopPO2 += increase;
        }
    }
    
    // 3. Clamp PO2 to physical limits
    ccrState.loopPO2 = Math.max(0, Math.min(ccrState.loopPO2, P_ambient)); // can't exceed ambient
    
    // 4. Scrubber countdown
    ccrState.scrubberRemaining -= dt_seconds / 60;
    if (ccrState.scrubberRemaining <= 0) {
        ccrState.scrubberFailed = true;
    }
}
```

#### Decompression Integration

```javascript
function getCCRInspiredPN2(currentDepth, currentPO2) {
    const P_ambient = 1 + currentDepth / 10;
    const fO2_loop = currentPO2 / P_ambient;
    const fInert_loop = 1 - fO2_loop;
    
    // Split inert gas according to diluent composition
    const totalInertInDiluent = ccrState.dilFN2 + ccrState.dilFHe;
    const fN2_loop = fInert_loop * (ccrState.dilFN2 / totalInertInDiluent);
    const fHe_loop = fInert_loop * (ccrState.dilFHe / totalInertInDiluent);
    
    const ppN2 = fN2_loop * P_ambient;
    const ppHe = fHe_loop * P_ambient;
    
    return { ppN2, ppHe, fN2_loop, fHe_loop };
}
```

#### Failure Conditions (Game Over Triggers)

| Condition | Trigger | Grace Period | Effect |
|-----------|---------|--------------|--------|
| Hypoxia blackout | PO2 < 0.10 for > 5 sec | Symptoms at < 0.16 (vision dims) | Game over |
| Hyperoxia seizure | PO2 > 1.6 for > 60 sec OR > 2.0 for > 10 sec | Warning at > 1.5 | Game over |
| CO2 poisoning | Scrubber exhausted + 3 min | Breathing rate warning | Game over |
| Loop flood | Manual trigger or failure event | 15 sec to bailout | Game over if no bailout |
| O2 empty (no bailout) | O2 pressure = 0 + PO2 < 0.16 + no bailout | Gradual PO2 decline | Game over |

#### Default Parameter Values (for implementation)

```javascript
const CCR_DEFAULTS = {
    // Cylinders
    o2CylinderVolume_L: 2.0,
    o2CylinderPressure_bar: 200,
    dilCylinderVolume_L: 3.0,
    dilCylinderPressure_bar: 200,
    
    // Loop
    loopVolume_L: 6.0,
    
    // Setpoints
    spLow: 0.7,               // bar — for descent/ascent
    spHigh: 1.3,              // bar — for bottom
    spMin: 0.4,               // bar — minimum configurable
    spMax: 1.6,               // bar — maximum configurable
    spStep: 0.1,              // bar — increment for manual adjustment
    
    // PO2 Response
    po2ResponseRate: 0.05,    // bar/second — how fast PO2 tracks toward SP
    metabolicO2Rate: 0.8,     // L/min surface equivalent
    
    // Scrubber
    scrubberDuration_min: 180, // 3 hours
    
    // Alarms
    po2AlarmHigh: 1.5,        // bar — yellow warning
    po2AlarmCriticalHigh: 1.6,// bar — red alarm
    po2AlarmLow: 0.4,         // bar — yellow warning
    po2AlarmCriticalLow: 0.16,// bar — red alarm / blackout imminent
    
    // Diluent presets
    diluents: {
        air: { fO2: 0.21, fN2: 0.79, fHe: 0.00, maxDepth: 56 },   // MOD at PO2 1.4 on OC ≈ narcosis limit
        trimix2135: { fO2: 0.21, fN2: 0.35, fHe: 0.44, maxDepth: 80 },
        trimix1545: { fO2: 0.15, fN2: 0.45, fHe: 0.40, maxDepth: 100 },
        trimix1070: { fO2: 0.10, fN2: 0.20, fHe: 0.70, maxDepth: 150 },
        heliox: { fO2: 0.10, fN2: 0.00, fHe: 0.90, maxDepth: 150 }
    },
    
    // Timing
    solenoidFireDuration_ms: 200,  // typical solenoid pulse
    manualO2BurstDuration_ms: 500, // how long manual button press injects
    
    // Game mechanics
    hypoxiaBlackoutPO2: 0.10,
    hypoxiaSymptomsPO2: 0.16,
    hyperoxiaSeizurePO2: 2.0,
    hyperoxiaWarningPO2: 1.5,
    co2GracePeriod_sec: 180,       // time from scrubber failure to incapacitation
    floodBailoutWindow_sec: 15
};
```

---

### 9. Diluent Choices

**Air Diluent (21/79):**
- Simplest and cheapest
- Works well to ~40m (narcosis becomes significant)
- Equivalent Narcotic Depth (END) = actual depth (no narcosis advantage)
- ppN2 at 40m with SP 1.3: (5.0 - 1.3) × (0.79/0.79) = 3.7 bar → highly narcotic
- **Best for**: Recreational CCR diving to 40m

**Trimix Diluent (reduced N2, added He):**
- Helium reduces narcosis
- END calculation: END = (ppN2 / 0.79) × 10 - 10 (depth where air would give same ppN2)
- Common trimix diluent: 21/35 (21% O2, 35% N2, 44% He)
  - At 60m with SP 1.3: fN2 = (1 - 1.3/7) × (0.35/0.79) = 0.35 → ppN2 = 2.45 → END ≈ 21m
- Deep CCR (>60m) requires trimix or heliox diluent
- **Best for**: Technical CCR diving below 40m

**For the simulator:**
- YES — allow configurable diluent
- Provide presets: Air, Trimix 21/35, Trimix 15/45, Trimix 10/70, Heliox
- Impact on gameplay:
  - Air diluent: narcosis effects at depth (reuse existing narcosis model)
  - Trimix: reduced narcosis, enabling deeper dives
  - Heliox: no narcosis, maximum depth capability
- Diluent choice affects:
  - Narcosis (END calculation)
  - Decompression (different He/N2 tissue loading — requires ZHL-16C with He compartments)
  - Maximum practical depth

---

## Warnings & Anti-Patterns

- **Don't simplify PO2 as instantaneous** — there's a response lag (2–10 seconds for solenoid systems)
- **Don't ignore the "can't exceed ambient" rule** — PO2 cannot exceed ambient pressure (loop is at ambient)
- **Don't make scrubber a binary** — in reality breakthrough is gradual; for the game, use a capacity percentage with increasing CO2 effects in the last 10%
- **Don't forget bailout planning** — CCR mode should integrate with existing OC tank system for bailout
- **Don't allow SP > ~0.95 at surface** — physically impossible with any diluent containing >5% inert gas
- **the reference dive computeris a monitor, not controller** — for our simulator, we can combine both roles (display + control) since there's no separate rebreather handset

---

## Recommended Approach

Implement CCR as a new dive mode that:

1. **Replaces the gas source** from OC tanks to a CCR loop with O2 and diluent cylinders
2. **Adds PO2 as the primary controlled variable** — diver adjusts target SP with +/- buttons (0.1 bar increments, range 0.4–1.6)
3. **Runs a simple PO2 simulation loop** each frame: metabolic consumption → solenoid response → depth effects
4. **Adapts the existing Bühlmann engine** by calculating `fN2` and `fHe` dynamically from current PO2 and depth, rather than using fixed gas fractions
5. **Adds scrubber as a countdown timer** with failure consequences
6. **Supports bailout** by switching to OC mode with a bailout tank on failure
7. **Updates the reference dive computerHUD** to show PO2 prominently, SP target, sensor values, and CCR-specific alarms
8. **Includes failure scenarios** as game challenges: scrubber breakthrough, solenoid failure, O2 empty

The existing nitrogen narcosis model and O2 toxicity (CNS%) tracking should work unchanged — just fed by the variable loop composition instead of fixed tank mix.

---

## Raw Links

| # | URL | Tier | Status |
|---|-----|------|--------|
| 1 | https://en.wikipedia.org/wiki/Rebreather | 2 | ✅ Fetched |
| 2 | https://en.wikipedia.org/wiki/Closed-circuit_rebreather | 2 | ✅ Fetched (redirect to #1) |
| 3 | source-link-removed | 1 | ❌ 404 |

---

## Agent Knowledge (Unverified)

The following technical details are drawn from the researcher's training knowledge on CCR diving, Bühlmann decompression theory, and the manufacturer dive computer operation. They are consistent with published sources (US Navy Diving Manual Rev 7, Bozanic "Mastering Rebreathers", NOAA Diving Manual) but were **not directly verified from fetched web sources** in this session:

- Solenoid pulse duration of ~200ms is typical for Innerspace/AP/rEvo units
- The 0.05 bar/second PO2 response rate is an estimate for game feel; real systems vary from 0.02–0.10 depending on loop volume and injection rate
- Scrubber duration of 3 hours at 4°C water is conservative; warm water gives longer life
- The "voting logic" for O2 sensors (median of 3, ignore outlier) is standard in modern eCCR
- Metabolic O2 rate of 0.8 L/min is the commonly cited figure for relaxed diving (NOAA)
- Bailout planning using "all ascent on OC" is the standard conservative approach taught in CCR courses (TDI, IANTD, PADI TecRec)
