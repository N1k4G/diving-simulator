# Research: Algorithm Realism & Correctness Audit — Diving Simulator

> **Date**: 2026-05-01  
> **Requested by**: @architect  
> **Research brief**: Comprehensive audit of all physics, gas, decompression, buoyancy, CCR, and narcosis algorithms in `diving-simulator.html` for correctness against authoritative sources.  
> **Sources cross-referenced**: Bühlmann (1984), Erik Baker (1998), NOAA Diving Manual, the reference dive computer Rev C Manual, Standard physics (Boyle, Archimedes)

---

## Summary Table

| # | Algorithm / Subsystem | Verdict | Notes |
|---|----------------------|---------|-------|
| 1 | ZHL-16C N₂ half-times | ✅ CORRECT | All 16 values match published ZHL-16C |
| 2 | ZHL-16C N₂ a/b coefficients | ✅ CORRECT | Matches Erik Baker / Bühlmann tables |
| 3 | ZHL-16C He half-times | ✅ CORRECT | Standard ~2.65:1 ratio with N₂ |
| 4 | ZHL-16C He a/b coefficients | ✅ CORRECT | Matches published ZHL-16C He tables |
| 5 | Tissue loading (Schreiner eq.) | ✅ CORRECT | Proper exponential with P_H₂O correction |
| 6 | Combined a,b (trimix) | ✅ CORRECT | Loading-weighted method per Baker |
| 7 | M-value / ceiling formula | ✅ CORRECT | Proper GF-Hi applied ceiling |
| 8 | GF interpolation (deco) | ✅ CORRECT | Linear GF-Lo→GF-Hi per Baker method |
| 9 | NDL calculation | ✅ CORRECT | Iterative 0.5-min steps with GF-Hi |
| 10 | Deco schedule generation | ✅ CORRECT | 3m stops, 3m/min between stops, GF interp |
| 11 | BCD inflate/vent rates | ⚠️ ACCEPTABLE | Inflate 1.5 L/s slightly slow; vent 3.0 L/s OK |
| 12 | Boyle's law (BCD overpressure) | ✅ CORRECT | Gas expansion + relief valve modeled |
| 13 | Wetsuit compression | ⚠️ ACCEPTABLE | Simplified power-law; exponent 0.7 reasonable |
| 14 | Drag coefficient | ⚠️ ACCEPTABLE | Linear drag (should be quadratic) — OK for game |
| 15 | Buoyant force calculation | ✅ CORRECT | BCD + wetsuit + body − lead − gear |
| 16 | Surface dead zone | ✅ CORRECT | 0.3 kg neutral band prevents oscillation |
| 17 | SAC/RMV depth scaling | ✅ CORRECT | AMV × Pamb formula |
| 18 | MOD calculation | ✅ CORRECT | ((1.4/fO₂) − 1) × 10 |
| 19 | Minimum depth (hypoxic) | ✅ CORRECT | ((0.16/fO₂) − 1) × 10 |
| 20 | END formula | ✅ CORRECT | (D+10)×(1−fHe)−10; O₂ counted as narcotic |
| 21 | Gas consumption from tanks | ✅ CORRECT | Surface-liter accounting; AMV × Pamb × dt |
| 22 | CCR metabolic O₂ rate | ✅ CORRECT | 0.8 L/min — reasonable working diver |
| 23 | CCR PO₂ solenoid response | ⚠️ ACCEPTABLE | 0.05 bar/s — slightly slow but gameplay-valid |
| 24 | CCR scrubber duration | ✅ CORRECT | 180 min (3 hr) — conservative but realistic |
| 25 | CCR diluent consumption | ⚠️ MINOR BUG | Formula overestimates by p₂/p₁ factor (negligible in practice) |
| 26 | CCR loop gas fraction | ✅ CORRECT | fO₂ = PO₂/Pamb; inert split by diluent ratio |
| 27 | N₂ narcosis weighting | ✅ CORRECT | N₂ treated as narcotic |
| 28 | O₂ narcosis contribution | ✅ CORRECT | O₂ counted narcotic (conservative, modern approach) |
| 29 | He non-narcotic treatment | ✅ CORRECT | Helium excluded from narcotic PP |
| 30 | Depth-to-pressure | ⚠️ ACCEPTABLE | P = 1 + D/10 (standard approx; true saltwater = D/10.06) |
| 31 | Water vapor pressure | ✅ CORRECT | P_H₂O = 0.0627 bar (37°C saturated) |
| 32 | Initial N₂ loading | ✅ CORRECT | (1 − P_H₂O) × 0.79 = 0.7405 bar |
| 33 | Ascent/descent rate limits | ✅ CORRECT | 18 m/min barotrauma; 9 m/min safe guidance |
| 34 | Safety stop logic | ✅ CORRECT | Matches the reference dive computer adaptive spec |
| 35 | BCD inflate from tank | ✅ CORRECT | Deducts gas in surface-equivalent liters |

---

## Detailed Findings

### 1. Bühlmann ZHL-16C Decompression Model

#### 1.1 Tissue Compartment Constants

**N₂ Half-times (minutes):**
```
5.0, 8.0, 12.5, 18.5, 27.0, 38.3, 54.3, 77.0, 109.0, 146.0, 187.0, 239.0, 305.0, 390.0, 498.0, 635.0
```

**Verdict: ✅ CORRECT** — These are the published ZHL-16C values from Bühlmann's "Decompression – Decompression Sickness" and Erik Baker's implementation papers. All 16 compartments verified.

**N₂ a-coefficients:**
```
1.2599, 1.0000, 0.8618, 0.7562, 0.6200, 0.5043, 0.4410, 0.4000,
0.3750, 0.3500, 0.3295, 0.3065, 0.2835, 0.2610, 0.2480, 0.2327
```

**N₂ b-coefficients:**
```
0.5050, 0.6514, 0.7222, 0.7825, 0.8126, 0.8434, 0.8693, 0.8910,
0.9092, 0.9222, 0.9319, 0.9403, 0.9477, 0.9544, 0.9602, 0.9653
```

**Verdict: ✅ CORRECT** — All match the ZHL-16C table (variant C, not B). Cross-referenced against Baker's "Understanding M-values" and multiple open-source implementations.

**He Half-times (minutes):**
```
1.88, 3.02, 4.72, 6.99, 10.21, 14.48, 20.53, 29.11, 41.20, 55.19, 70.69, 90.34, 115.29, 147.42, 188.24, 240.03
```

**He a/b coefficients:** All verified against ZHL-16C published tables.

**Verdict: ✅ CORRECT** — He half-times maintain the expected ~2.65:1 ratio with N₂ half-times. Coefficients match published values.

#### 1.2 Tissue Loading Formula (Schreiner Equation)

```javascript
var kN2 = LN2 / ZHL16C_N2[i].ht;  // k = ln(2) / half-time
var piN2 = (pAmb - P_H2O) * gas.fN2;  // inspired alveolar N₂ partial pressure
tissues[i] = piN2 + (tissues[i] - piN2) * Math.exp(-kN2 * dtMinutes);
```

This is the standard Schreiner equation:
$$P_t(t) = P_{i,gas} + (P_t(0) - P_{i,gas}) \cdot e^{-k \cdot t}$$

Where:
- $P_{i,gas} = (P_{amb} - P_{H_2O}) \times f_{gas}$ (alveolar inspired pressure)
- $k = \frac{\ln 2}{t_{1/2}}$
- $P_{H_2O} = 0.0627$ bar

**Verdict: ✅ CORRECT** — Proper Schreiner equation with water vapor correction. The Haldane exponential model correctly applied.

#### 1.3 M-value / Ceiling Calculation with Gradient Factors

```javascript
var ceil = (totalLoad - ab.a * gfH) / (gfH / ab.b + 1 - gfH);
```

The Bühlmann M-value at ambient pressure $P_{amb}$ is:
$$M = a + \frac{P_{amb}}{b}$$

With Gradient Factor applied, the allowed supersaturation becomes:
$$P_{amb,tol} = \frac{P_t - a \cdot GF}{\frac{GF}{b} + 1 - GF}$$

This is the standard Erik Baker formulation for the ceiling pressure, which is then converted to depth: `(Pamb_tol - 1.0) * 10.0`.

**Verdict: ✅ CORRECT** — Properly implements Baker's GF ceiling formula.

#### 1.4 Combined a,b for Trimix

```javascript
var a = (ZHL16C_N2[i].a * ptN2 + ZHL16C_HE[i].a * ptHe) / total;
var b = (ZHL16C_N2[i].b * ptN2 + ZHL16C_HE[i].b * ptHe) / total;
```

Tissue-loading-weighted combination of gas-specific coefficients. This is the standard method described by Bühlmann for mixed-gas diving and used by all ZHL-16C implementations for trimix.

**Verdict: ✅ CORRECT**

#### 1.5 GF Interpolation in Deco Schedule

```javascript
function gfAtDepth(d) {
    if (firstStop <= 0) return gfH;
    var frac = Math.max(0, Math.min(1, d / firstStop));
    return gfH + (gfL - gfH) * frac;
}
```

Linear interpolation: GF = GF-Hi at surface (d=0), GF = GF-Lo at first stop depth. This matches Erik Baker's "Clearing Up the Confusion" paper on gradient factors.

**Verdict: ✅ CORRECT**

#### 1.6 NDL Calculation

Iterative forward-projection in 0.5-minute steps (max 200 minutes = 400 steps). Simulates tissue loading at current depth and checks when any compartment exceeds its GF-Hi-modified M-value at surface (1 bar). Returns the time before the first compartment exceeds the limit.

**Verdict: ✅ CORRECT** — Standard iterative approach. The 0.5-min resolution provides adequate precision (most dive computers use 1-min resolution).

#### 1.7 Deco Schedule

- Ascent to first stop at 3 m/min (calculated from `(simDepth - firstStop) / 3.0` as time)
- Stops at 3m increments (`Math.ceil(ceilDepth / 3) * 3`)
- Simulates tissue off-gassing at each stop in 0.1-min steps
- Uses best available gas at each stop depth (gas switching in deco)
- Properly applies GF interpolation for clearing each stop

**Verdict: ✅ CORRECT** — Matches professional dive computer deco planning algorithms.

---

### 2. Buoyancy & BCD Physics

#### 2.1 BCD Inflate/Vent

| Parameter | Value | Real-World | Assessment |
|-----------|-------|------------|------------|
| BCD max capacity | 18 L | 15–30 L (recreational wing) | ✅ Realistic |
| Inflate rate | 1.5 L/s ambient | 2–3 L/s typical | ⚠️ Slightly slow |
| Vent rate | 3.0 L/s ambient | 3–5 L/s (dump valve) | ✅ Realistic |

**Verdict: ⚠️ ACCEPTABLE SIMPLIFICATION** — Inflate rate is on the low side but provides good gameplay balance (prevents instant buoyancy changes).

#### 2.2 Boyle's Law Expansion

```javascript
var actualVol = bcdGasSurfaceLiters / P;
if (actualVol > BP.bcdMaxCapacity) {
    bcdGasSurfaceLiters = BP.bcdMaxCapacity * P;
}
```

Correctly models gas expansion on ascent. When BCD volume exceeds capacity, excess gas is vented (overpressure relief valve behavior). The BCD tracks gas in surface-equivalent liters and derives actual volume by dividing by ambient pressure — proper Boyle's Law application.

**Verdict: ✅ CORRECT**

#### 2.3 Wetsuit Compression

```javascript
var wetsuitLift = BP.wetsuitBuoyancySurface * Math.pow(1 / P, BP.wetsuitCompressionExp);
```

With `wetsuitBuoyancySurface = 5.0` kg and `wetsuitCompressionExp = 0.7`:
- At surface (P=1): 5.0 kg lift
- At 10m (P=2): 5.0 × 0.5^0.7 = 3.08 kg
- At 30m (P=4): 5.0 × 0.25^0.7 = 1.67 kg
- At 60m (P=7): 5.0 × 0.143^0.7 = 1.07 kg

Real wetsuit compression: ~38% volume loss at 10m, ~65% loss by 60m (Wikipedia/NOAA). The model gives 38% reduction at 10m and 79% at 60m — reasonable approximation of the non-linear compression behavior.

**Verdict: ⚠️ ACCEPTABLE SIMPLIFICATION** — A single power-law captures the general trend. Real neoprene compression is more complex (cell structure collapse is non-linear and partially irreversible) but this is adequate.

#### 2.4 Drag Model

```javascript
var drag = -velMPerS * BP.dragCoefficient;  // Linear drag
```

Real hydrodynamic drag follows: $F_d = \frac{1}{2} C_d \rho A v^2$ (quadratic in velocity).

The simulator uses linear drag (proportional to v, not v²). This means:
- At low speeds: drag is overestimated slightly
- At high speeds: drag is significantly underestimated

However, since velocity is hard-clamped at ±18/30 m/min and the typical operating range is 0–10 m/min, the linear approximation produces acceptable behavior within the gameplay range.

**Verdict: ⚠️ ACCEPTABLE SIMPLIFICATION** — Quadratic drag would be more realistic but the max-rate clamps prevent runaway behavior.

#### 2.5 Net Buoyancy

```javascript
var netBuoyancy = bcdLift + wetsuitLift + BP.bodyBuoyancy - BP.leadWeight - BP.gearWeightNet;
```

Budget:
- BCD: 0–18 L variable lift
- Wetsuit: 5.0 kg at surface, reducing with depth
- Body: +3.0 kg (positive buoyancy — realistic for typical human body composition)
- Lead: −6.0 kg (standard recreational weight belt for wetsuit diving)
- Gear: −2.0 kg (net negative for tank + regulator system)

At surface, neutral requires: BCD lift = 6.0 + 2.0 − 5.0 − 3.0 = 0 kg → BCD essentially empty at surface. This is realistic for a properly weighted diver.

**Verdict: ✅ CORRECT** — Values are within realistic ranges for a recreational diver in 5–7mm wetsuit.

---

### 3. Gas Physics

#### 3.1 SAC/RMV and Depth Scaling

```javascript
var consumed = amvRate * pAmb * dtDiveMinutes;
```

Where `amvRate` defaults to 15 L/min (adjustable 8–25 L/min). This is the standard Actual Minute Volume at depth calculation:

$$\text{Gas consumed} = \text{SAC} \times P_{amb} \times t$$

NOAA reference: Typical SAC rates are 12–20 L/min. Default of 15 is moderate (fit recreational diver at moderate workload).

**Verdict: ✅ CORRECT**

#### 3.2 MOD Calculation

```javascript
return ((1.4 / fo2) - 1) * 10;
```

$$MOD = \left(\frac{PO_{2,max}}{fO_2} - 1\right) \times 10$$

Uses PO₂ = 1.4 bar as the operational limit (standard recreational/technical maximum). NOAA and all training agencies use this formula.

**Verdict: ✅ CORRECT**

#### 3.3 Minimum Depth (Hypoxic)

```javascript
var minD = ((PO2_HYPOXIA / fO2) - 1) * 10;  // PO2_HYPOXIA = 0.16
```

$$D_{min} = \left(\frac{0.16}{fO_2} - 1\right) \times 10$$

0.16 bar is the standard hypoxia threshold (loss of consciousness). Correctly identifies the shallowest depth where a gas mix can be safely breathed.

**Verdict: ✅ CORRECT**

#### 3.4 END (Equivalent Narcotic Depth)

```javascript
return Math.max(0, (depth + 10) * (1 - tank.fHe) - 10);
```

$$END = (D + 10) \times (1 - f_{He}) - 10$$

This formula treats **all non-helium gas** (both N₂ AND O₂) as narcotic. This is the modern conservative approach used by IANTD, TDI, and most rebreather-focused agencies. Some agencies (PADI, SSI for recreational) only count N₂, but counting O₂ as narcotic is increasingly accepted based on research.

**Verdict: ✅ CORRECT** — Uses the more conservative (and increasingly standard) approach.

#### 3.5 Gas Consumption from Finite Cylinders

Gas is tracked as surface-equivalent liters (`totalGas = volume × pressure`). Consumption deducts surface liters consumed (`AMV × Pamb × dt`). BCD inflation also deducts from the tank correctly.

Tank pressure readback: `gasRemaining / volume` gives current bar — correct.

**Verdict: ✅ CORRECT**

---

### 4. CCR (Closed Circuit Rebreather) Model

#### 4.1 Metabolic O₂ Consumption

```javascript
metabolicO2Rate: 0.8  // L/min surface equivalent
```

Literature values:
- Resting: 0.5–0.7 L/min
- Light swimming: 0.8–1.2 L/min
- Heavy work: 1.5–2.5 L/min

0.8 L/min represents a diver under light-to-moderate workload. Appropriately constant regardless of depth (metabolic rate is depth-independent for O₂).

**Verdict: ✅ CORRECT**

#### 4.2 PO₂ Solenoid Response

```javascript
po2ResponseRate: 0.05  // bar per second
```

To rise from setpoint low (0.7) to high (1.3): 0.6 / 0.05 = 12 seconds.

Real solenoids on electronic CCRs (e.g., AP Inspiration, rEvo) respond in 3–8 seconds for typical adjustments. The sim is slightly slower for dramatic effect.

**Verdict: ⚠️ ACCEPTABLE SIMPLIFICATION** — Slightly slower than reality but creates more interesting gameplay dynamics.

#### 4.3 Scrubber Duration

```javascript
scrubberTotal: 180  // minutes (3 hours)
```

Real scrubber durations vary:
- Short canisters (e.g., Meg): 1.5–2.5 hours
- Standard (e.g., AP/JJ/rEvo): 3–5 hours
- Large canister (e.g., Optima): 4–8 hours

3 hours is on the conservative end of typical recreational CCR use, representing a standard-sized canister at moderate workload.

**Verdict: ✅ CORRECT**

#### 4.4 Diluent Consumption (Descent Only)

```javascript
var dilNeeded = ccrState.loopVolume * (p2 / p1 - 1);
var dilSurfEquiv = dilNeeded * p2;
```

**Analysis:** The mathematically correct formula for surface-equivalent diluent needed is:
$$\text{Dil}_{surf} = V_{loop} \times (P_2 - P_1)$$

The code computes: $V_{loop} \times \frac{(P_2 - P_1)}{P_1} \times P_2 = V_{loop} \times (P_2 - P_1) \times \frac{P_2}{P_1}$

This overestimates by a factor of $P_2 / P_1$. However, since this function is called per-frame with very small depth increments (where $P_2 / P_1 \approx 1.0001$), the cumulative error over a full descent is negligible in practice.

**Verified by limit:** For infinitesimal $dP$, the formula gives $V \times dP/P \times P = V \times dP$, which equals the correct answer. The error is a second-order effect that vanishes for small steps.

**Verdict: ⚠️ MINOR BUG** — Formula is mathematically imprecise but practically harmless due to per-frame evaluation. A single large depth change would overestimate consumption, but this case doesn't occur in normal gameplay.

#### 4.5 Loop Gas Fraction

```javascript
var fO2Loop = Math.min(po2 / pAmb, 1.0);
var fInert = 1 - fO2Loop;
// Inert gas split by diluent ratio
var fN2 = fInert * (ccrState.dilFN2 / totalInertDil);
var fHe = fInert * (ccrState.dilFHe / totalInertDil);
```

This correctly models the CCR loop composition:
1. fO₂ in loop = PO₂ / Pamb (the defining equation of a CCR)
2. Remaining gas fraction is inert
3. Inert gas split matches diluent composition (since only diluent adds inert gas to the loop)

**Verdict: ✅ CORRECT** — Exactly how CCR loop composition works.

---

### 5. Narcosis Model

#### 5.1 Narcotic Partial Pressure

```javascript
function calculateNarcoticPP() {
    return (1 - tank.fHe) * ambientBar;
}
```

$$PP_{narc} = (1 - f_{He}) \times P_{amb}$$

This treats all non-helium gas (N₂ + O₂) as equally narcotic and helium as completely non-narcotic. This aligns with:
- Bennett & Elliott's "The Physiology and Medicine of Diving": N₂ is definitively narcotic
- Hamilton & Thalmann research: O₂ contributes to narcosis
- Helium: established as non-narcotic (inert noble gas with low lipid solubility)

**Verdict: ✅ CORRECT**

#### 5.2 Narcosis Progression Model

```javascript
const NARC_ONSET_BAR = 1.5;   // PP where narcosis begins
const NARC_FULL_BAR = 8.0;    // PP where narcosis is maximal
```

Uses smoothstep interpolation:
- At 30m on air: PP_narc = 4.0 bar → narcosis index ≈ 0.33 (mild wobble starts at 0.25)
- At 45m on air: PP_narc = 5.5 bar → narcosis index ≈ 0.63 (significant impairment)
- At 60m on air: PP_narc = 7.0 bar → narcosis index ≈ 0.94 (near KO threshold of 0.95)

This closely matches the "Martini's Law" progression and training agency guidance:
- 30m: equivalent to 1 martini (mild impairment) ✓
- 40m: significant impairment ✓
- 60m: dangerous/incapacitating ✓
- KO threshold at 0.95 = ~65m on air — matches known incidents

**Verdict: ✅ CORRECT** — Well-calibrated narcosis curve.

#### 5.3 Asymmetric Ramp Rates

```javascript
NARC_RAMP_UP = 0.012;   // slow onset
NARC_RAMP_DOWN = 0.025;  // faster recovery
```

Narcosis on-gassing is slower than recovery — this matches real physiology where narcosis onset has some delay (especially noticeable during rapid descent) but clears relatively quickly on ascent (typically within 1–2 minutes of ascending above narcotic threshold).

**Verdict: ✅ CORRECT**

---

### 6. General Physics

#### 6.1 Depth-to-Pressure Conversion

```javascript
function ambientPressure(d) {
    return 1.0 + d / 10.0;
}
```

$$P_{amb} = 1 + \frac{D}{10}$$

True saltwater: P = 1 + D/10.06 (density 1.025 g/cm³). True freshwater: P = 1 + D/10.3 (density 0.997 g/cm³). The value 10.0 is the universally-used approximation in dive tables, dive computers, and training materials.

**Verdict: ⚠️ ACCEPTABLE** — Standard approximation; not a bug.

#### 6.2 Safety Stop Logic

Implementation matches the **the reference dive computer Adaptive Safety Stop** specification (Rev C manual):

| Feature | Simulator | the reference dive computerSpec | Match |
|---------|-----------|---------------|-------|
| Activation threshold | >11m max depth | >11m | ✅ |
| Countdown trigger | Ascending through 6m | Ascending through 6m | ✅ |
| Active range | 2.4–8.3m | 2.4–8.3m | ✅ |
| Standard duration | 3 minutes | 3 minutes | ✅ |
| Extended duration | 5 min (if >30m or NDL<5) | 5 min (if >30m or NDL<5) | ✅ |
| Reset condition | Descend below 11m | Descend below 11m | ✅ |
| Pauses outside range | Yes | Yes | ✅ |

**Verdict: ✅ CORRECT** — Pixel-perfect implementation of the reference dive computeradaptive safety stop algorithm.

#### 6.3 Ascent/Descent Rates

| Parameter | Value | Standard | Assessment |
|-----------|-------|----------|------------|
| Max ascent (clamp) | 18 m/min | 18 m/min = lung barotrauma threshold | ✅ |
| Barotrauma threshold | 18 m/min sustained 10s | Reasonable gameplay threshold | ✅ |
| Safe ascent guidance | 9 m/min in warnings | PADI/SSI/NAUI: 9–10 m/min | ✅ |
| Max descent (clamp) | 30 m/min | 18–30 m/min typical | ✅ |
| Deco ascent between stops | 3 m/min | Standard 3 m/min | ✅ |

**Verdict: ✅ CORRECT**

#### 6.4 O₂ Toxicity Timing

```javascript
PO2_HIGH = 1.6;           // toxicity threshold
PO2_TOXICITY_TIME = 30;   // seconds to seizure
```

In reality, CNS O₂ toxicity is probabilistic and typically requires more than 30 seconds at 1.6 bar (NOAA REPEX tables give >45 minutes at 1.6 PO₂). However, for a game, 30 seconds provides dramatic urgency while teaching the correct threshold (1.6 bar). The PO₂ limits (safe <1.0, elevated 1.0–1.4, high 1.4–1.6, toxic >1.6) are industry-standard.

**Verdict: ⚠️ ACCEPTABLE SIMPLIFICATION** — Timing compressed for gameplay; thresholds correct.

---

## Recommendations

### Critical Fixes (None Required)

No critical algorithmic errors were found. The decompression model, gas physics, and all core calculations are correctly implemented.

### Nice-to-Have Improvements

| Priority | Item | Description |
|----------|------|-------------|
| Low | CCR diluent formula | Fix `loopVolume * (p2/p1 - 1)` → `loopVolume * (1 - p1/p2)` for mathematical correctness. Practically irrelevant but cleaner. |
| Low | Quadratic drag | Replace `drag = -v * Cd` with `drag = -sign(v) * Cd * v²` for more realistic deceleration behavior at speed. |
| Low | O₂ toxicity timing | Consider extending to 60–90 seconds to be slightly more forgiving while maintaining urgency. |
| Very Low | Inflate rate | Could increase from 1.5 to 2.0 L/s for more realistic BCD response. |
| Very Low | Saltwater precision | Could offer option for 10.06m per bar vs 10.0m, but this is truly unnecessary. |

### Overall Assessment

**The diving simulator's algorithms are remarkably accurate and well-implemented.** The Bühlmann ZHL-16C model is correctly implemented with proper gradient factor support, the gas physics are sound, the CCR model is functional and realistic, and the narcosis model is well-calibrated against known physiological data. The few simplifications made (linear drag, compressed O₂ toxicity timing, slightly slow inflate rate) are appropriate gameplay-driven tradeoffs that don't compromise educational value.

The implementation demonstrates strong understanding of decompression theory, gas physics, and diving physiology. It would be suitable for use as an educational tool for demonstrating dive computer behavior and basic decompression concepts.

---

## Raw Links

| # | Source | Tier | Status |
|---|--------|------|--------|
| 1 | Bühlmann "Decompression – Decompression Sickness" (1984) | 1 | 📚 Reference text |
| 2 | Erik Baker "Understanding M-values" (1998) | 1 | 📚 Reference paper |
| 3 | Erik Baker "Clearing Up the Confusion About Deep Stops" (1998) | 1 | 📚 Reference paper |
| 4 | NOAA Diving Manual, 6th Edition | 1 | 📚 Reference text |
| 5 | the reference dive computer Recreational Manual Rev C | 1 | 📚 Reference manual |
| 6 | Bennett & Elliott "The Physiology and Medicine of Diving" | 1 | 📚 Reference text |
| 7 | Wikipedia — Buoyancy Compensator (Diving) | 2 | ✅ Cross-referenced |
| 8 | Project research: `docs/research/buoyancy-bcd-physics.md` | — | ✅ Cross-referenced |
| 9 | Project research: `docs/research/adaptive-safety-stop.md` | — | ✅ Cross-referenced |
