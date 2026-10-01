import { describe, expect, it } from "vitest";

import { DiveModel, advanceDiveStep } from "../../src/core/dive-model";
import {
  createGasMix,
  createInitialDiveState,
  createTankState,
  freezeDiveState,
  type DiveState,
} from "../../src/core/dive-state";
import { litres, metres, seconds } from "../../src/core/units";

// The rule of thirds (#199), legacy's Issue #27 in updateDiving(): under an
// overhead, the gas carried on going in is the plan; more than two thirds of
// it left is outbound, more than one third the turn (one beep), the rest the
// reserve, latched for the dive. Out from under it, the plan clears.

const AIR = createGasMix(0.21, 0);

/** Two cylinders, 2400 L and 1400 L, at 30 m. */
function twoCylinders(): DiveState {
  const base = createInitialDiveState(71, {
    tanks: [createTankState(AIR), createTankState(createGasMix(0.5, 0), 7, 200)],
  });
  return freezeDiveState({ ...base, depthM: metres(30), maxDepthM: metres(30) });
}

function withGas(state: DiveState, ...gasL: number[]): DiveState {
  return freezeDiveState({
    ...state,
    tanks: state.tanks.map((tank, index) => ({ ...tank, gasRemainingL: litres(gasL[index] ?? 0) })),
  });
}

/** One step at 30 m, breathing its own cylinder, under the overhead or not. */
function step(state: DiveState, inOverhead: boolean): DiveState {
  return advanceDiveStep(
    state,
    { depthM: metres(30), inOverhead },
    seconds(1),
  );
}

describe("the rule of thirds", () => {
  it("starts every dive with no plan and no reserve reached", () => {
    expect(createInitialDiveState(1).thirds).toEqual({ startingGasL: 0, turnWarned: false, reserveHit: false });
  });

  it("does nothing outside an overhead, the default", () => {
    const model = new DiveModel(withGas(twoCylinders(), 100, 0));
    model.advance({ depthM: metres(30) }, seconds(30));
    expect(model.snapshot.thirds).toEqual({ startingGasL: 0, turnWarned: false, reserveHit: false });
  });

  it("plans from all cylinders' gas on going under the overhead", () => {
    const entered = step(twoCylinders(), true);
    expect(entered.thirds.startingGasL).toBe(2400 + 1400);
    expect(entered.thirds.turnWarned).toBe(false);
    expect(entered.thirds.reserveHit).toBe(false);
  });

  it("reads the gas before the step's breathing, as legacy does", () => {
    // The plan is the gas carried as the step starts; the step then breathes.
    const entered = step(twoCylinders(), true);
    const carriedL = entered.tanks.reduce((sum, tank) => sum + tank.gasRemainingL, 0);
    expect(carriedL).toBeLessThan(entered.thirds.startingGasL);
  });

  it("latches the turn below two thirds and the reserve at one third, and keeps the plan", () => {
    const planned = step(twoCylinders(), true);
    const turned = step(withGas(planned, 2400, 133), true);
    expect(turned.thirds).toEqual({ startingGasL: 3800, turnWarned: true, reserveHit: false });
    const reserve = step(withGas(turned, 1266, 0), true);
    expect(reserve.thirds).toEqual({ startingGasL: 3800, turnWarned: true, reserveHit: true });
  });

  it("is still outbound at exactly two thirds left, and the turn at exactly one third", () => {
    // Legacy compares with > on both: more than two thirds is outbound.
    const planned = withGas(step(withGas(twoCylinders(), 3000, 0), true), 2000, 0);
    expect(step(planned, true).thirds.turnWarned).toBe(true);
    const outbound = withGas(step(withGas(twoCylinders(), 3000, 0), true), 2001, 0);
    expect(step(outbound, true).thirds.turnWarned).toBe(false);
    const turn = withGas(step(withGas(twoCylinders(), 3000, 0), true), 1001, 0);
    expect(step(turn, true).thirds.reserveHit).toBe(false);
    const reserve = withGas(step(withGas(twoCylinders(), 3000, 0), true), 1000, 0);
    expect(step(reserve, true).thirds.reserveHit).toBe(true);
  });

  it("clears the plan and the turn on leaving, keeps the reserve, and plans afresh on going back", () => {
    const reserve = step(withGas(step(twoCylinders(), true), 1000, 0), true);
    expect(reserve.thirds.reserveHit).toBe(true);
    const out = step(reserve, false);
    expect(out.thirds).toEqual({ startingGasL: 0, turnWarned: false, reserveHit: true });
    const back = step(out, true);
    const carriedL = out.tanks.reduce((sum, tank) => sum + tank.gasRemainingL, 0);
    expect(back.thirds.startingGasL).toBe(carriedL);
    expect(back.thirds.turnWarned).toBe(false);
    expect(back.thirds.reserveHit).toBe(true);
  });

  it("reads a diver with no gas at all as in the reserve", () => {
    const empty = step(withGas(twoCylinders(), 0, 0), true);
    expect(empty.thirds.startingGasL).toBe(0);
    expect(empty.thirds.reserveHit).toBe(true);
  });

  it("is told by the client whether the diver is under the overhead, frame by frame", () => {
    const model = new DiveModel(twoCylinders());
    model.advanceWithBuoyancy({ ceilingM: 0, floorM: 300 }, seconds(0.3), { inflate: false, vent: false }, true);
    expect(model.snapshot.thirds.startingGasL).toBeGreaterThan(0);
    model.advanceWithBuoyancy({ ceilingM: 0, floorM: 300 }, seconds(0.3), { inflate: false, vent: false });
    expect(model.snapshot.thirds.startingGasL).toBe(0);
  });
});
