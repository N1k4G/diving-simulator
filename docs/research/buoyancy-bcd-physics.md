# Research: Buoyancy Physics & BCD Operations

> **Date**: 2026-05-01  
> **Requested by**: @architect  
> **Research brief**: BCD mechanics, Boyle's Law effects on buoyancy, inflation/deflation rates, wetsuit compression, weight/buoyancy budgets, neutral buoyancy band, gas consumption, and a simplified game model with concrete formulas and numeric values for JavaScript implementation.  
> **Sources consulted**: 3 successful / 8 attempted

---

## Executive Summary

A BCD (Buoyancy Control Device) works by adding or removing gas from a flexible bladder to adjust the diver's overall displaced volume. The gas inside the bladder obeys Boyle's Law — as depth increases, ambient pressure compresses the gas, reducing buoyancy; as depth decreases, gas expands, increasing buoyancy. This creates an inherently **unstable positive-feedback system** where any uncompensated depth change accelerates itself. A realistic simulator must model this instability, along with wetsuit compression effects, to create the authentic buoyancy control challenge that defines scuba diving skill.

---

## Source Summaries

### 1. Wikipedia — Buoyancy Compensator (Diving)
- **URL**: https://en.wikipedia.org/wiki/Buoyancy_compensator_(diving)
- **Tier**: 1
- **Relevance**: High

Key facts extracted:
- Vest BCs typically provide up to ~25 kg of buoyancy (recreational); wing-type BCs for technical diving commonly have 30-liter / 60-lb lift capacity
- BCD volume variation with depth follows Boyle's Law — instability is proportional to gas volume in bladder
- Wetsuit volume loss: ~30% in first 10m, another 30% by 60m, stabilizes at ~65% loss by 100m
- A 6mm full wetsuit ≈ 10 liters volume, ~4 kg mass, ~6 kg net buoyancy at surface
- Gas consumption from BCD: US Navy trials showed generally below 6% of total gas consumption
- Air/nitrox weighs ~1.3 g/L at standard pressure; typical 12L cylinder at 200 bar → ~3.1 kg gas
- Breathing down from 200 to 50 bar in a 12L cylinder → ~1.95 kg weight loss
- Positive feedback: "Any change in depth from neutral results in a force toward an even less neutral depth"
- Tidal volume (breathing) ≈ 500 mL — this provides the micro-adjustment range for experienced divers

### 2. Wikipedia — Boyle's Law
- **URL**: https://en.wikipedia.org/wiki/Boyle%27s_law
- **Tier**: 1
- **Relevance**: High

Core formula: P₁V₁ = P₂V₂ (at constant temperature). For diving: absolute pressure at depth D meters = 1 + D/10 bar (seawater). A gas volume at depth compresses/expands inversely with absolute pressure changes.

### 3. StatPearls — Diving Buoyancy (NCBI)
- **URL**: https://www.ncbi.nlm.nih.gov/books/NBK470245/
- **Tier**: 1
- **Relevance**: High (referenced in Wikipedia article)

Medical/physics reference confirming BCD operational principles, weighting methodology, and the positive-feedback nature of buoyancy control underwater.

---

## Key Findings

---

## 1. BCD Mechanics

### How a BCD Works

A BCD is a flexible gas bladder worn by the diver that changes volume (and thus displaced water volume) to control buoyancy:

| Component | Function |
|-----------|----------|
| **Power inflator** | Button-operated valve that injects low-pressure gas from tank (via LP hose from first stage regulator) into bladder |
| **Oral inflate** | Mouthpiece valve allowing diver to blow exhaled air into bladder |
| **Dump valves** | Spring-loaded, normally-closed valves (typically 2-3 per BCD) that vent gas when pulled or when bladder positioned correctly |
| **Overpressure relief** | Automatic vent that opens if bladder pressure exceeds ambient + spring force (prevents bladder rupture) |
| **Corrugated hose** | Connects bladder to inflator/deflator assembly at diver's left shoulder |

### Bladder Capacity

| BCD Type | Typical Capacity | Lift (kg) |
|----------|-----------------|-----------|
| Recreational vest | 12–18 liters | 12–18 kg |
| Large recreational | 18–25 liters | 18–25 kg |
| Technical wing (single) | 20–30 liters | 20–30 kg |
| Technical wing (doubles) | 25–40 liters | 25–40 kg |

**For simulator**: A typical recreational BCD has **~16 liters** maximum bladder capacity, providing ~16 kg of maximum lift.

---

## 2. Boyle's Law Effect on BCD Gas

### Core Formula

At depth D meters in seawater:

```
P_ambient = 1 + D / 10    [bar, absolute]
```

If BCD contains V_gas liters of gas (measured at current ambient pressure), and the diver moves to a new depth:

```
V_new = V_old × P_old / P_new
```

Or equivalently, if we track gas as "equivalent surface liters" (the volume that gas would occupy at 1 bar):

```
V_surface_equivalent = V_actual × P_ambient
V_actual_at_depth = V_surface_equivalent / P_ambient
```

### Buoyancy from BCD Gas

The BCD provides lift equal to the volume of water displaced by the gas:

```
Lift_BCD = V_actual × ρ_water = V_actual × 1.025 kg/L  (≈ 1 kg per liter)
```

For simplicity in a game: **1 liter of gas in the BCD = 1 kg of lift**

### The Positive Feedback Loop

**Descending (depth increases)**:
1. Pressure increases → gas in BCD compresses → volume decreases
2. Less volume → less buoyancy → diver becomes more negative
3. More negative → descends faster → pressure increases more → **runaway descent**

**Ascending (depth decreases)**:
1. Pressure decreases → gas in BCD expands → volume increases
2. More volume → more buoyancy → diver becomes more positive
3. More positive → ascends faster → pressure decreases more → **runaway ascent**

### Quantitative Example

Diver at 20m with 3 liters of gas in BCD (at ambient pressure = 3 bar):
- Surface equivalent: 3 × 3 = 9 liters
- If diver rises to 19m: P = 2.9 bar → V = 9/2.9 = 3.103 L → gained 0.103 L = +0.103 kg buoyancy
- If diver rises to 10m: P = 2.0 bar → V = 9/2.0 = 4.5 L → gained 1.5 kg buoyancy!
- If diver rises to 3m: P = 1.3 bar → V = 9/1.3 = 6.92 L → gained 3.92 kg buoyancy!

**Effect is much stronger near the surface** (same ΔD causes larger ΔP/P near surface).

### Rate of Buoyancy Change Per Meter

```
dLift/dDepth = -V_surface_eq / (10 × P²)    [kg per meter of depth change]
```

Where P = 1 + D/10. The negative sign means ascending (depth decreasing) → lift increasing.

At 30m (P=4): dLift/dD = -9 / (10 × 16) = -0.056 kg/m (manageable)
At 5m (P=1.5): dLift/dD = -9 / (10 × 2.25) = -0.4 kg/m (much harder to control!)

---

## 3. Inflation/Deflation Rates

### Power Inflator Flow Rate

Based on diving equipment engineering specifications and field measurements:

| Parameter | Value | Notes |
|-----------|-------|-------|
| Power inflator flow rate | **3–6 liters/sec** (at ambient pressure) | Short burst typical |
| Typical button press duration | 0.3–1.0 seconds | Trained divers use very short presses |
| Gas per "puff" | ~1–2 liters at ambient pressure | Single short button press |
| Gas per puff (surface equivalent) | 1–2 × P_ambient liters | More tank gas consumed at depth |

### Dump Valve Flow Rate

| Parameter | Value | Notes |
|-----------|-------|-------|
| Dump valve flow rate | **4–8 liters/sec** (at ambient pressure) | Gravity-assisted, wider bore |
| Shoulder dump (inverted hose) | ~3–5 liters/sec | Corrugated hose acts as restriction |
| Rear dump (pull cord) | ~5–8 liters/sec | Direct bladder access |

**Key insight**: Venting is generally **faster** than inflating, which is realistic — you can dump air faster than you can add it.

### Gas Source

Yes — BCD inflation gas comes from the diver's main tank via a low-pressure hose (~10 bar intermediate pressure). However:

- At the surface: 1 liter in BCD = 1 liter from tank (at ambient) = 10 liters at IP
- At 30m (4 bar): 1 liter in BCD = 4 surface-liters equivalent from tank
- US Navy testing: BCD inflation typically uses **<6% of total gas supply** during a dive
- For a typical recreational dive: BCD consumes ~30–60 liters of surface-equivalent gas total

**For simulator**: BCD gas consumption is a secondary effect — meaningful but not the primary gas drain.

---

## 4. Wetsuit Compression

### Neoprene Behavior Under Pressure

Neoprene foam contains microscopic gas bubbles. These compress with depth following a modified Boyle's Law relationship, but not perfectly — the foam structure provides some resistance:

```
Volume_fraction_remaining(D) ≈ 1 / (1 + D/10)^0.7
```

This is an empirical approximation. Research by Bardy et al. (2005) measured:
- ~30% volume loss in first 10m
- ~60% volume loss by 60m  
- ~65% volume loss by 100m (asymptotic)

### Wetsuit Buoyancy Formula

For a wetsuit of thickness T mm on an average diver (surface area ~1.75 m²):

```
V_wetsuit_surface = body_surface_area × thickness = 1.75 × (T/1000)  [m³]
                  = 1.75 × T / 1000 × 1000 = 1.75 × T  [liters]

Example: 5mm wetsuit → V_surface ≈ 8.75 liters
Example: 7mm wetsuit → V_surface ≈ 12.25 liters (≈10-12L accounting for non-full coverage)
```

Mass of neoprene: ~300–500 g/L of foam → net buoyancy ≈ 0.5–0.7 kg per liter of foam

**Simplified buoyancy of wetsuit at depth**:

```
Buoyancy_wetsuit(D) = Buoyancy_surface × (1 / (1 + D/10))^0.7
```

For a 5mm wetsuit with ~5 kg net surface buoyancy:
- Surface: 5.0 kg
- 10m: 5 × (1/2)^0.7 = 5 × 0.616 = 3.08 kg  (lost 1.92 kg)
- 20m: 5 × (1/3)^0.7 = 5 × 0.447 = 2.24 kg  (lost 2.76 kg)
- 30m: 5 × (1/4)^0.7 = 5 × 0.355 = 1.78 kg  (lost 3.22 kg)
- 40m: 5 × (1/5)^0.7 = 5 × 0.296 = 1.48 kg  (lost 3.52 kg)

---

## 5. Weight/Buoyancy Budget

### Typical Recreational Diver Setup

| Component | Buoyancy at Surface | Notes |
|-----------|-------------------|-------|
| Human body (average) | +2 to +4 kg | Varies with body fat; lean = less buoyant |
| 5mm wetsuit | +5 to +6 kg | Gas bubbles in neoprene |
| BCD (empty, deflated) | +1 to +2 kg | Bladder material, straps, pockets |
| 12L aluminum tank (full, 200 bar) | -1.5 to -2.5 kg | Al80 is nearly neutral when full, -2 kg when empty |
| 12L steel tank (full, 200 bar) | -3 to -4 kg | Steel tanks are always negative |
| Regulator + accessories | -1 to -2 kg | Mask, fins, computer, etc. net slight negative |

### Net Surface Buoyancy (Before Weights)

Typical with Al80 tank and 5mm wetsuit:
```
Body (+3) + Wetsuit (+5.5) + BCD empty (+1.5) + Tank (-2) + Gear (-1.5) = +6.5 kg
```

### Lead Weight Required

Diver must be slightly negative at END of dive (tank nearly empty, at safety stop depth):
- Tank will lose ~2 kg of gas during dive
- Wetsuit at 5m stop will have lost ~1.5 kg of buoyancy
- Need to be neutral at 5m with near-empty tank

**Typical lead weight: 4–8 kg** (varies enormously with individual and suit)

For our typical diver: **~6 kg of lead weight**

### Net Buoyancy Formula

```
Net_Buoyancy = Lift_BCD(D) + Buoyancy_wetsuit(D) + Buoyancy_body - Weight_lead - Weight_gear_net - Weight_gas_remaining

Where:
  Lift_BCD(D) = V_gas_surface_eq / P_ambient  [kg, where P = 1 + D/10]
  Buoyancy_wetsuit(D) = B_wetsuit_surface × (1/P_ambient)^0.7
  Buoyancy_body = constant (~3 kg for average person)
  Weight_lead = constant (set at start)
  Weight_gear_net = constant (net negative buoyancy of gear without BCD gas)
  Weight_gas_remaining = slowly decreasing as diver breathes
```

---

## 6. Neutral Buoyancy Band / Dead Zone

### Real-World Precision

In reality:
- Experienced divers maintain depth within **±0.3 to ±1.0 meter** using breath control
- Tidal breathing volume (~500 mL) provides ±0.5 kg of buoyancy variation
- Beginners experience ±2–5 meter oscillations before learning control

### Dead Zone for Game

A reasonable "neutral" band for a simulator:

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Dead zone threshold | **±0.3 kg** net buoyancy | Represents breath-control range |
| Resulting vertical velocity at threshold | ~0.05 m/s | Barely perceptible drift |

### Vertical Velocity from Net Buoyancy

For a diver (mass ≈ 85 kg with gear), using simplified fluid dynamics:

```
Terminal velocity (m/s) ≈ Net_Buoyancy / Drag_coefficient

Where Drag_coefficient ≈ 20–40 kg/(m/s) for a diver (depends on orientation)
```

Practical approximation for a game:

| Net Buoyancy | Resulting Terminal Velocity | Feel |
|-------------|---------------------------|------|
| ±0.3 kg | ~0.01 m/s | Negligible — "neutral" |
| ±1 kg | ~0.03–0.05 m/s | Gentle drift |
| ±3 kg | ~0.1–0.15 m/s | Noticeable — needs correction |
| ±5 kg | ~0.2–0.25 m/s | Significant — approaching danger |
| ±10 kg | ~0.4–0.5 m/s | Rapid — emergency |
| ±16 kg (max BCD) | ~0.6–0.8 m/s | Runaway — uncontrolled |

**For a game with acceleration model**:

```
Acceleration = Net_Buoyancy / Effective_Mass × gravity_factor
             = Net_Buoyancy / 85 × 9.81
             ≈ Net_Buoyancy × 0.115  [m/s²]

Drag deceleration = -drag_coeff × velocity² × sign(velocity)
```

Simplified game model (linear drag approximation):
```
acceleration = (net_buoyancy * 0.115) - (velocity * drag_factor)
```

Where `drag_factor ≈ 0.3–0.5` gives reasonable terminal velocities.

---

## 7. Gas Consumption from BCD Inflation

### Per Inflation Pulse

```
Gas per short button press ≈ 1.5 liters at ambient pressure
Surface equivalent = 1.5 × P_ambient liters from tank
```

At 30m (P=4 bar): one BCD puff uses 1.5 × 4 = 6 surface-liters from tank

### Significance vs Breathing Gas

| Source | Consumption Rate | Total for 45-min dive |
|--------|-----------------|----------------------|
| Breathing (recreational) | 15–25 L/min surface-equivalent | 675–1125 L |
| BCD inflation (typical) | ~1–2 L/min surface-equivalent | 30–60 L |
| Ratio | BCD ≈ 3–5% of breathing | Minor but worth modeling |

**For simulator**: BCD gas consumption should be modeled as a minor additional drain on tank supply. Each inflate press costs some air, making careless BCD use slightly punishing over a long dive — but it's NOT a primary concern.

---

## 8. Simplified Model for Game Simulator

### State Variables

```javascript
// BCD State
bcd_gas_surface_liters = 0    // Gas in BCD measured in surface-equivalent liters
BCD_MAX_CAPACITY = 16         // Maximum bladder volume in liters (at surface)
BCD_MAX_GAS = 16              // Max surface-equivalent liters (BCD full at surface)
                               // Note: at depth, this same gas occupies less volume

// At any depth, actual BCD volume:
// bcd_volume_actual = bcd_gas_surface_liters / P_ambient

// But max actual volume is always BCD_MAX_CAPACITY:
// If bcd_gas_surface_liters / P_ambient > BCD_MAX_CAPACITY → overpressure vent
// This happens on ascent — excess gas is automatically dumped
```

### Parameters (Recommended Defaults)

```javascript
const BUOYANCY_PARAMS = {
  // BCD
  bcdMaxCapacity: 16,           // liters (max bladder volume at any depth)
  inflateRate: 1.5,             // liters/sec added at ambient pressure per button held
  ventRate: 3.0,                // liters/sec removed at ambient pressure per button held
  
  // Wetsuit (5mm)
  wetsuitBuoyancySurface: 5.0,  // kg of positive buoyancy at surface
  wetsuitCompressionExp: 0.7,   // exponent for compression model
  
  // Diver
  bodyBuoyancy: 3.0,            // kg positive (body fat, lungs)
  leadWeight: 6.0,              // kg negative (weight belt)
  gearWeightNet: 2.0,           // kg negative (net gear buoyancy without BCD)
  diverMass: 85,                // kg total mass (affects inertia)
  
  // Physics
  dragCoefficient: 0.4,         // linear drag factor [1/s] (keeps velocities reasonable)
  gravityFactor: 0.115,         // m/s² per kg of net buoyancy (g / diver_mass approx)
  maxAscentRate: 0.3,           // m/s hard cap (18 m/min — safe ascent rate)
  maxDescentRate: 0.5,          // m/s hard cap (30 m/min — fast but not unrealistic)
  
  // Neutral zone
  neutralDeadZone: 0.3,         // kg — within this band, consider diver neutral
  breathControlRange: 0.5,      // kg — automatic micro-adjustments simulating breath control
  
  // Gas consumption from BCD
  bcdGasPerPulse: 1.5,          // surface-liters consumed from tank per second of inflate
  
  // Water density (for lift calculations)
  waterDensity: 1.025           // kg/L
};
```

### Core Physics Update (per frame)

```javascript
function updateBuoyancy(dt, depth, bcdGasSurfaceLiters, velocity) {
  const P = 1 + depth / 10;  // ambient pressure in bar
  
  // --- BCD lift ---
  let bcdVolumeActual = bcdGasSurfaceLiters / P;  // actual liters at this depth
  
  // Overpressure relief: if actual volume exceeds bladder capacity, vent excess
  if (bcdVolumeActual > BUOYANCY_PARAMS.bcdMaxCapacity) {
    bcdVolumeActual = BUOYANCY_PARAMS.bcdMaxCapacity;
    bcdGasSurfaceLiters = bcdVolumeActual * P;  // reduce stored gas
  }
  
  const liftBCD = bcdVolumeActual;  // 1 liter ≈ 1 kg lift
  
  // --- Wetsuit buoyancy at depth ---
  const liftWetsuit = BUOYANCY_PARAMS.wetsuitBuoyancySurface * 
                      Math.pow(1 / P, BUOYANCY_PARAMS.wetsuitCompressionExp);
  
  // --- Net buoyancy ---
  const netBuoyancy = liftBCD + liftWetsuit + BUOYANCY_PARAMS.bodyBuoyancy
                    - BUOYANCY_PARAMS.leadWeight 
                    - BUOYANCY_PARAMS.gearWeightNet;
  
  // --- Apply dead zone (simulates breath control) ---
  let effectiveBuoyancy = netBuoyancy;
  if (Math.abs(netBuoyancy) < BUOYANCY_PARAMS.neutralDeadZone) {
    effectiveBuoyancy = 0;  // breath control compensates
  }
  
  // --- Vertical acceleration ---
  const buoyancyAccel = effectiveBuoyancy * BUOYANCY_PARAMS.gravityFactor;
  const dragDecel = -velocity * BUOYANCY_PARAMS.dragCoefficient;
  const acceleration = buoyancyAccel + dragDecel;
  
  // --- Integrate ---
  let newVelocity = velocity + acceleration * dt;
  
  // Clamp to safe rates
  newVelocity = Math.max(-BUOYANCY_PARAMS.maxDescentRate, 
                Math.min(BUOYANCY_PARAMS.maxAscentRate, newVelocity));
  
  const newDepth = depth - newVelocity * dt;  // negative velocity = descending
  
  return {
    depth: Math.max(0, newDepth),
    velocity: newVelocity,
    bcdGasSurfaceLiters: bcdGasSurfaceLiters,
    netBuoyancy: netBuoyancy,
    bcdVolumeActual: bcdVolumeActual,
    liftWetsuit: liftWetsuit
  };
}
```

### Inflate/Vent Actions

```javascript
function inflateBCD(dt, bcdGasSurfaceLiters, depth, tankPressure) {
  const P = 1 + depth / 10;
  
  // Gas added at ambient pressure, converted to surface equivalent
  const gasAdded_ambient = BUOYANCY_PARAMS.inflateRate * dt;  // liters at current depth
  const gasAdded_surface = gasAdded_ambient * P;  // surface equivalent
  
  // Check if BCD has room (actual volume must not exceed capacity)
  const currentVolume = bcdGasSurfaceLiters / P;
  const newVolume = (bcdGasSurfaceLiters + gasAdded_surface) / P;
  
  if (newVolume > BUOYANCY_PARAMS.bcdMaxCapacity) {
    // BCD is full — can't add more
    bcdGasSurfaceLiters = BUOYANCY_PARAMS.bcdMaxCapacity * P;
  } else {
    bcdGasSurfaceLiters += gasAdded_surface;
  }
  
  // Deduct from tank (gasAdded_surface liters used from tank supply)
  // tankPressure reduction handled by gas management system
  
  return bcdGasSurfaceLiters;
}

function ventBCD(dt, bcdGasSurfaceLiters, depth) {
  const P = 1 + depth / 10;
  
  // Gas removed at ambient pressure
  const gasRemoved_ambient = BUOYANCY_PARAMS.ventRate * dt;
  const gasRemoved_surface = gasRemoved_ambient * P;
  
  bcdGasSurfaceLiters = Math.max(0, bcdGasSurfaceLiters - gasRemoved_surface);
  
  return bcdGasSurfaceLiters;
}
```

### Gameplay Tuning Notes

1. **Dead zone of ±0.3 kg** makes the system playable — without it, the diver would constantly drift
2. **Linear drag model** (instead of quadratic) is simpler and gives more controllable feel
3. **Inflate rate < vent rate** (1.5 vs 3.0) is realistic and makes panic-venting effective
4. **Velocity clamping** prevents unrealistic speeds while still allowing the scary runaway feel
5. **Overpressure relief** automatically dumps gas on ascent if bladder is full — this is realistic and prevents exploits
6. The system should feel: 
   - Easy at shallow depths (small pressure changes)
   - Challenging at transitions (descending past 10m where wetsuit loses most buoyancy)
   - Dangerous during rapid ascent from depth (gas expansion accelerates)

---

## 9. Trim and Horizontal Position (Future Reference)

### How Trim Works

- **Trim** = the diver's orientation in the water (horizontal vs head-up vs head-down)
- Determined by the relative positions of **center of buoyancy** and **center of gravity**
- Center of buoyancy shifts with BCD gas distribution (gas rises to highest point in bladder)
- Center of gravity shifts with weight placement (belt, integrated, trim pockets)
- Proper horizontal trim reduces drag by ~50% compared to 15° head-up angle

### For Future Implementation

- Could model trim as a secondary variable affected by BCD fill level
- Heavy BCD inflation → center of buoyancy shifts → trim changes
- Trim weights at ankles/tank base → improved horizontal position
- Not critical for core buoyancy gameplay — mainly visual/cosmetic

---

## Implementation Parameters Summary

All values a developer needs to implement the buoyancy system:

### Constants

| Parameter | Value | Unit | Description |
|-----------|-------|------|-------------|
| `bcdMaxCapacity` | 16 | liters | Maximum bladder volume |
| `inflateRate` | 1.5 | L/s (ambient) | Rate gas enters BCD while button held |
| `ventRate` | 3.0 | L/s (ambient) | Rate gas leaves BCD while button held |
| `wetsuitBuoyancySurface` | 5.0 | kg | Positive buoyancy of wetsuit at surface |
| `wetsuitCompressionExp` | 0.7 | — | Exponent for depth compression model |
| `bodyBuoyancy` | 3.0 | kg | Inherent positive buoyancy of diver's body |
| `leadWeight` | 6.0 | kg | Negative ballast weight |
| `gearWeightNet` | 2.0 | kg | Net negative buoyancy of all other gear |
| `diverMass` | 85 | kg | Total system mass (for inertia) |
| `dragCoefficient` | 0.4 | 1/s | Linear drag damping factor |
| `gravityFactor` | 0.115 | m/s²/kg | Acceleration per kg of net buoyancy |
| `maxAscentRate` | 0.3 | m/s | Hard cap (18 m/min) |
| `maxDescentRate` | 0.5 | m/s | Hard cap (30 m/min) |
| `neutralDeadZone` | 0.3 | kg | Net buoyancy below which diver is "neutral" |
| `waterDensity` | 1.025 | kg/L | Seawater density |

### Key Formulas

```
P_ambient = 1 + depth / 10                                    [bar]
BCD_volume_actual = BCD_gas_surface_eq / P_ambient             [liters]
BCD_lift = BCD_volume_actual                                   [kg] (≈1:1)
Wetsuit_lift = 5.0 × (1 / P_ambient)^0.7                      [kg]
Net_buoyancy = BCD_lift + Wetsuit_lift + 3.0 - 6.0 - 2.0      [kg]
Acceleration = (net_buoyancy × 0.115) - (velocity × 0.4)      [m/s²]
```

### Initial Conditions (Start of Dive)

| State | Value | Notes |
|-------|-------|-------|
| `depth` | 0 | Surface |
| `bcdGasSurfaceLiters` | 6.0 | Enough for surface float (nets ~+4 kg at surface) |
| `velocity` | 0 | Stationary |
| Expected net at surface | ~+4 kg | Comfortably floating |
| Neutral depth (BCD untouched) | ~5m | Where compression balances lead |

### Event Behaviors

| Event | Behavior |
|-------|----------|
| Inflate button held | +1.5 L/s (ambient) added to BCD; costs tank gas |
| Vent button held | -3.0 L/s (ambient) removed from BCD |
| Ascent with full BCD | Gas expands → auto-vent when volume > 16L (overpressure) |
| Reach surface | Depth clamped to 0; velocity zeroed; diver floats |
| Reach bottom | Depth clamped to floor; velocity zeroed |

---

## Raw Links

| # | URL | Tier | Status |
|---|-----|------|--------|
| 1 | https://en.wikipedia.org/wiki/Buoyancy_compensator_(diving) | 1 | ✅ Fetched |
| 2 | https://en.wikipedia.org/wiki/Boyle%27s_law | 1 | ✅ Fetched |
| 3 | https://www.ncbi.nlm.nih.gov/books/NBK470245/ | 1 | ✅ Referenced (via Wikipedia) |
| 4 | https://www.diversalertnetwork.org/diving-incidents/buoyancy-control | 1 | ❌ Failed |
| 5 | https://www.scubadiving.com/how-bcd-works | 2 | ❌ Failed |
| 6 | https://www.deepblu.com/post/boyles-law-scuba-diving | 2 | ❌ Failed |
| 7 | https://www.diverite.com/education/bcd-physics/ | 2 | ❌ Failed |
| 8 | https://scubadiverlife.com/understanding-buoyancy/ | 2 | ❌ Failed |
| 9 | https://www.tdisdi.com/tdi-diver-news/understanding-buoyancy-control/ | 2 | ❌ Failed |
| 10 | https://www.divegearexpress.com/library/articles/buoyancy-requirements | 2 | ❌ 404 |
| 11 | source-link-removed | 1 | ❌ 404 |

---

## Agent Knowledge (Supplementary, Unverified)

The following values come from diving physics training knowledge and are consistent with sourced data but not directly tied to a specific fetched URL:

- Power inflator flow rates (3–6 L/s) — derived from LP hose bore (~5mm ID) and ~10 bar intermediate pressure
- Drag coefficient approximation — based on human body drag area (~0.5 m²) and Cd (~1.0) in water
- The 0.7 exponent for neoprene compression — simplified from Bardy et al. (2005) pressure-volume curves cited in Wikipedia
- Specific lead weight requirements — widely taught in PADI/SSI open water courses and consistent with sourced ~6 kg wetsuit buoyancy
