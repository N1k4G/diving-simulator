// Buoyancy physics (#192): vertical motion from the BCD, the wetsuit and drag,
// ported from legacy src/physics.js inflateBCD(), ventBCD() and
// updateBuoyancyPhysics(). Pure: no DOM, no renderer.
//
// Units follow legacy: BCD gas in surface-equivalent litres, velocity in
// m/min, positive downwards. The physics integrates in dive seconds, in
// sub-steps of at most 0.1 s, exactly as legacy's frame loop does
// (PHYSICS_MAX_SUBSTEP_SEC), so a one-second model step is the same ten
// sub-steps legacy runs for a one-second tick.
import { freezeDiveState, type DiveState } from "./dive-state";
import { bars, litres, type Seconds } from "./units";

/** src/constants.js BUOYANCY_PARAMS, the fields the physics reads. */
export const BUOYANCY_PARAMS = Object.freeze({
  bcdMaxCapacity: 18,
  inflateRate: 0.4,
  ventRate: 0.75,
  wetsuitBuoyancySurface: 5.0,
  wetsuitCompressionExp: 0.7,
  bodyBuoyancy: 3.0,
  leadWeight: 7.0,
  gearWeightNet: 2.0,
  dragCoefficient: 0.4,
  gravityFactor: 0.115,
  neutralDeadZone: 0.15,
  maxAscentRate: 25,
  maxDescentRate: 20,
});

/** src/constants.js PHYSICS_MAX_SUBSTEP_SEC. */
export const PHYSICS_MAX_SUBSTEP_S = 0.1;
/** src/constants.js MAX_DEPTH. */
export const MAX_DEPTH_M = 300;
/**
 * The BCD gas legacy sets when a dive leaves the surface
 * (src/game-loop.js updateSurface: `bcdGasSurfaceLiters = 2.0`).
 */
export const BCD_START_SURFACE_LITRES = 2.0;

/** The shallowest and deepest the diver can be here: legacy's ceilingAt() and floorAt(). */
export interface VerticalBounds {
  readonly ceilingM: number;
  readonly floorM: number;
}

export interface BuoyancyControls {
  readonly inflate: boolean;
  readonly vent: boolean;
}

function ambientPressureBar(depthM: number): number {
  return 1 + depthM / 10;
}

/**
 * The BCD gas that makes the diver neutral at a depth: legacy's
 * neutralizeAt(), used by the baseline scenarios, and here for saves that
 * predate the field.
 */
export function neutralBcdSurfaceLitres(depthM: number): number {
  const p = ambientPressureBar(depthM);
  const P = BUOYANCY_PARAMS;
  const wetsuitLift = P.wetsuitBuoyancySurface * Math.pow(1 / p, P.wetsuitCompressionExp);
  const requiredLift = P.leadWeight + P.gearWeightNet - P.bodyBuoyancy - wetsuitLift;
  return Math.max(0, requiredLift * p);
}

/**
 * Inflates or vents the BCD for `elapsedS` at the current depth: legacy's
 * inflateBCD() and ventBCD(), in that order when both are held.
 *
 * Inflation gas comes from the cylinder being breathed. On open circuit that
 * is the active tank, as in legacy. On a rebreather it is the diluent
 * cylinder, by owner decision (#192): legacy draws from tanks[activeTank],
 * which on a CCR dive is the setup placeholder the diver does not carry
 * (docs/decisions.md, "Deliberate departures from the legacy client").
 */
export function applyBcdControls(
  state: DiveState,
  controls: BuoyancyControls,
  elapsedS: Seconds,
): DiveState {
  if (!controls.inflate && !controls.vent) {
    return state;
  }
  const P = BUOYANCY_PARAMS;
  const p = ambientPressureBar(state.depthM);
  let bcd = state.bcdGasSurfaceLiters;
  let next = state;

  if (controls.inflate) {
    let surfEquiv = P.inflateRate * elapsedS * p;
    if ((bcd + surfEquiv) / p > P.bcdMaxCapacity) {
      surfEquiv = Math.max(0, P.bcdMaxCapacity * p - bcd);
    }
    const drawn = drawInflationGas(next, surfEquiv);
    next = drawn.state;
    bcd += drawn.litres;
  }
  if (controls.vent) {
    let surfEquiv = P.ventRate * elapsedS * p;
    if (surfEquiv > bcd) surfEquiv = bcd;
    bcd -= surfEquiv;
  }
  return freezeDiveState({ ...next, bcdGasSurfaceLiters: bcd });
}

function drawInflationGas(
  state: DiveState,
  wantedL: number,
): { state: DiveState; litres: number } {
  const ccr = state.ccr;
  if (ccr) {
    const availableL = ccr.diluentCylinderPressureBar * ccr.diluentCylinderVolumeL;
    if (availableL <= 0) return { state, litres: 0 };
    const drawnL = Math.min(wantedL, availableL);
    return {
      litres: drawnL,
      state: freezeDiveState({
        ...state,
        ccr: {
          ...ccr,
          diluentCylinderPressureBar: bars(
            ccr.diluentCylinderPressureBar - drawnL / ccr.diluentCylinderVolumeL,
          ),
        },
      }),
    };
  }
  const tank = state.tanks[state.activeTankIndex];
  if (!tank || tank.gasRemainingL <= 0) return { state, litres: 0 };
  const drawnL = Math.min(wantedL, tank.gasRemainingL);
  return {
    litres: drawnL,
    state: freezeDiveState({
      ...state,
      tanks: state.tanks.map((t, i) =>
        i === state.activeTankIndex
          ? { ...t, gasRemainingL: litres(t.gasRemainingL - drawnL) }
          : t,
      ),
    }),
  };
}

export interface BuoyancyResult {
  readonly depthM: number;
  readonly verticalVelocityMpm: number;
  readonly bcdGasSurfaceLiters: number;
}

/**
 * Integrates `elapsedS` of vertical motion from the state's depth, velocity
 * and BCD gas: legacy's sub-step loop around updateBuoyancyPhysics(), without
 * the per-structure collision sub-stepping, which only applies on sites with
 * solid structures; the bounds stand in for ceilingAt()/floorAt().
 */
export function integrateBuoyancy(
  state: DiveState,
  bounds: VerticalBounds,
  elapsedS: number,
): BuoyancyResult {
  const P = BUOYANCY_PARAMS;
  let depth: number = state.depthM;
  let velocity = state.verticalVelocityMpm;
  let bcd = state.bcdGasSurfaceLiters;

  let remaining = elapsedS;
  while (remaining > 1e-9) {
    const dt = remaining > PHYSICS_MAX_SUBSTEP_S ? PHYSICS_MAX_SUBSTEP_S : remaining;
    const p = ambientPressureBar(depth);

    let actualVol = bcd / p;
    if (actualVol > P.bcdMaxCapacity) {
      bcd = P.bcdMaxCapacity * p;
      actualVol = P.bcdMaxCapacity;
    }
    const wetsuitLift = P.wetsuitBuoyancySurface * Math.pow(1 / p, P.wetsuitCompressionExp);
    const net = actualVol + wetsuitLift + P.bodyBuoyancy - P.leadWeight - P.gearWeightNet;
    const effective = Math.abs(net) > P.neutralDeadZone ? net : 0;
    const accel = -effective * P.gravityFactor;

    let v = velocity / 60;
    const drag = -v * P.dragCoefficient;
    v += (accel + drag) * dt;
    velocity = v * 60;
    if (velocity < -P.maxAscentRate) velocity = -P.maxAscentRate;
    if (velocity > P.maxDescentRate) velocity = P.maxDescentRate;

    depth += velocity * (dt / 60);

    if (depth < bounds.ceilingM) {
      depth = bounds.ceilingM;
      if (velocity < 0) velocity = 0;
    }
    if (depth > bounds.floorM) {
      depth = bounds.floorM;
      if (velocity > 0) velocity = 0;
    }
    if (depth < 0) {
      depth = 0;
      velocity = 0;
    }
    if (depth > MAX_DEPTH_M) {
      depth = MAX_DEPTH_M;
      velocity = 0;
    }
    remaining -= dt;
  }
  return { depthM: depth, verticalVelocityMpm: velocity, bcdGasSurfaceLiters: bcd };
}
