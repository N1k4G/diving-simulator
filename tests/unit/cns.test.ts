import { describe, expect, it } from "vitest";

import {
  DiveModel,
  closedCircuit,
  cnsRatePercentPerMinute,
} from "../../src/core/dive-model";
import {
  createCcrState,
  createGasMix,
  createInitialDiveState,
  createTankState,
  freezeDiveState,
} from "../../src/core/dive-state";
import { bars, metres, minutes, minutesToSeconds } from "../../src/core/units";

// CNS oxygen exposure in the core model (#186), from legacy's updateCNS()
// (src/physics.js, WP-038). tests/parity checks it against the cns_percent
// every fixture checkpoint records; these pin the rules the recordings do
// not reach.

describe("the NOAA rate table", () => {
  it("uses legacy's bands, each upper bound inclusive", () => {
    const cases: [number, number][] = [
      [0.5, 0], [0.51, 0.14], [0.6, 0.14], [0.61, 0.19], [0.7, 0.19],
      [0.8, 0.28], [0.9, 0.33], [1.1, 0.42], [1.3, 0.56], [1.5, 0.83],
      [1.6, 2.22], [1.61, 10],
    ];
    for (const [po2, rate] of cases) {
      expect(cnsRatePercentPerMinute(po2), `PO2 ${po2}`).toBe(rate);
    }
  });
});

describe("accumulation in the model", () => {
  it("starts at zero", () => {
    expect(createInitialDiveState(1).cnsPercent).toBe(0);
  });

  it("30 minutes on air at 18 m is legacy's 4.2%", () => {
    // PO2 0.21 x 2.8 = 0.588 bar, band 0.14 %/min: the air-18m-30min
    // fixture records 4.199999999999975.
    const model = new DiveModel(createInitialDiveState(2));
    model.advance({ depthM: metres(18) }, minutesToSeconds(minutes(30)));
    expect(model.snapshot.cnsPercent).toBeCloseTo(4.2, 9);
  });

  it("an active loop counts the loop PO2, not the cylinder", () => {
    // Legacy's calculatePO2() returns the loop PO2 on an active rebreather
    // (#4, #50). 10 minutes at 1.3 bar is 0.56 %/min.
    const ccr = createCcrState(createGasMix(0.21, 0), {
      targetPo2Bar: bars(1.3),
      actualPo2Bar: bars(1.3),
    });
    // Already at 30 m: a descent would dilute the loop with diluent first,
    // and the PO2 would sit below 1.3 bar until the loop caught up.
    const model = new DiveModel(
      freezeDiveState({
        ...createInitialDiveState(3, { ccr }),
        depthM: metres(30),
        maxDepthM: metres(30),
      }),
    );
    model.advance({ depthM: metres(30) }, minutesToSeconds(minutes(10)));
    expect(model.snapshot.cnsPercent).toBeCloseTo(5.6, 9);
  });

  it("after a bailout, the diluent at depth", () => {
    // Tx 15/45 at 30 m: 0.15 x 4 = 0.6 bar, 0.14 %/min.
    const base = createInitialDiveState(4, {
      ccr: createCcrState(createGasMix(0.15, 0.45)),
    });
    const model = new DiveModel(
      freezeDiveState({ ...base, ccr: { ...base.ccr!, onBailout: true } }),
    );
    model.advance({ depthM: metres(30) }, minutesToSeconds(minutes(10)));
    expect(model.snapshot.cnsPercent).toBeCloseTo(1.4, 9);
  });

  it("follows the breathing source a caller injects", () => {
    // The parity replays pass an explicit source; CNS reads that source,
    // as the tissues do.
    const model = new DiveModel(
      createInitialDiveState(5, { tanks: [createTankState(createGasMix(0.21, 0))] }),
    );
    model.advance(
      { depthM: metres(30), breathing: closedCircuit(1.4, createGasMix(0.21, 0)) },
      minutesToSeconds(minutes(10)),
    );
    expect(model.snapshot.cnsPercent).toBeCloseTo(8.3, 9);
  });
});
