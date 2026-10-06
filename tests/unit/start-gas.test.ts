import { describe, expect, it } from "vitest";

import { DiveModel } from "../../src/core/dive-model";
import {
  createCcrState,
  createGasMix,
  createInitialDiveState,
  createTankState,
  freezeDiveState,
} from "../../src/core/dive-state";
import { bars, metres, seconds } from "../../src/core/units";

// The start of the dive (#199): each cylinder's fill and the rebreather's
// start pressures and scrubber total, legacy's totalGas, o2CylPressureStart,
// dilCylPressureStart and scrubberTotal. Gas used is these less the current
// values, as drawPostDive() computes it; the dive only ever draws down.

describe("the start of the dive", () => {
  it("is each cylinder's fill: volume times pressure", () => {
    const tank = createTankState(createGasMix(0.32, 0), 11, 207);
    expect(tank.startGasL).toBe(11 * 207);
    expect(tank.gasRemainingL).toBe(tank.startGasL);
  });

  it("is the rebreather's cylinders and scrubber as configured", () => {
    const loop = createCcrState(createGasMix(0.21, 0), {
      oxygenCylinderPressureBar: bars(190),
      diluentCylinderPressureBar: bars(180),
      scrubberRemainingS: seconds(150 * 60),
    });
    expect(loop.oxygenCylinderStartPressureBar).toBe(190);
    expect(loop.diluentCylinderStartPressureBar).toBe(180);
    expect(loop.scrubberTotalS).toBe(150 * 60);
  });

  it("stays put while an open-circuit dive breathes, switches and inflates", () => {
    const base = createInitialDiveState(4, {
      tanks: [createTankState(createGasMix(0.21, 0)), createTankState(createGasMix(0.5, 0), 7, 200)],
    });
    const model = new DiveModel(freezeDiveState({ ...base, depthM: metres(20), maxDepthM: metres(20) }));
    model.advance({ depthM: metres(20) }, seconds(120));
    model.switchGas(1);
    model.advanceWithBuoyancy({ ceilingM: 0, floorM: 300 }, seconds(0.3), { inflate: true, vent: false });
    const [air, nitrox] = model.snapshot.tanks;
    expect(air?.startGasL).toBe(2400);
    expect(nitrox?.startGasL).toBe(1400);
    expect(air?.gasRemainingL).toBeLessThan(2400);
    expect(nitrox?.gasRemainingL).toBeLessThan(1400);
  });

  it("stays put while a rebreather dive runs its loop, inflates from the diluent and bails out", () => {
    const base = createInitialDiveState(5, { ccr: createCcrState(createGasMix(0.21, 0), { targetPo2Bar: bars(1.2) }) });
    const model = new DiveModel(freezeDiveState({ ...base, depthM: metres(25), maxDepthM: metres(25) }));
    model.advance({ depthM: metres(25) }, seconds(300));
    model.advanceWithBuoyancy({ ceilingM: 0, floorM: 300 }, seconds(0.3), { inflate: true, vent: false });
    model.bailOut();
    model.advance({ depthM: metres(25) }, seconds(30));
    const ccr = model.snapshot.ccr;
    expect(ccr?.oxygenCylinderStartPressureBar).toBe(200);
    expect(ccr?.diluentCylinderStartPressureBar).toBe(200);
    expect(ccr?.scrubberTotalS).toBe(180 * 60);
    expect(ccr?.oxygenCylinderPressureBar).toBeLessThan(200);
    expect(ccr?.diluentCylinderPressureBar).toBeLessThan(200);
    expect(ccr?.scrubberRemainingS).toBeLessThan(180 * 60);
  });
});
