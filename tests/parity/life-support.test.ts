import { describe, expect, it } from "vitest";

import { DiveModel } from "../../src/core/dive-model";
import {
  createCcrState,
  createGasMix,
  createInitialDiveState,
  createTankState,
} from "../../src/core/dive-state";
import {
  bars,
  litres,
  litresPerMinute,
  metres,
  minutes,
  minutesToSeconds,
} from "../../src/core/units";

// Values in this suite were captured from the equivalent pure calculation
// hooks in the legacy client at reference commit 30c151f.
describe("pure life-support parity", () => {
  it("matches the legacy open-circuit timer and gas-use trace", () => {
    const model = new DiveModel(
      createInitialDiveState(11, {
        tanks: [createTankState(createGasMix(0.21, 0), 12, 200)],
        surfaceAirConsumptionLpm: 15,
      }),
    );

    model.advance(
      { depthM: metres(20) },
      minutesToSeconds(minutes(10)),
    );

    expect(model.snapshot.elapsedTimeS).toBe(600);
    expect(model.snapshot.tanks[0]?.gasRemainingL).toBeCloseTo(1950, 9);
    expect(model.snapshot.activeTankIndex).toBe(0);
    expect(model.snapshot.failure.reason).toBeNull();
  });

  it("matches the legacy CCR descent and 20-minute bottom trace", () => {
    const diluent = createGasMix(0.15, 0.45);
    const ccr = createCcrState(diluent, {
      targetPo2Bar: bars(1.3),
      actualPo2Bar: bars(0.21),
      oxygenCylinderVolumeL: litres(2),
      oxygenCylinderPressureBar: bars(200),
      diluentCylinderVolumeL: litres(3),
      diluentCylinderPressureBar: bars(200),
      loopVolumeL: litres(6),
      scrubberRemainingS: minutesToSeconds(minutes(180)),
      metabolicOxygenLpm: litresPerMinute(0.8),
      po2ResponseBarPerSecond: 0.05,
    });
    const model = new DiveModel(createInitialDiveState(12, { ccr }));

    model.advance(
      { depthM: metres(30) },
      minutesToSeconds(minutes(20)),
    );

    expect(model.snapshot.elapsedTimeS).toBe(1200);
    expect(model.snapshot.ccr?.actualPo2Bar).toBeCloseTo(1.3, 12);
    expect(model.snapshot.ccr?.oxygenCylinderPressureBar).toBeCloseTo(
      190.0800000000072,
      9,
    );
    expect(model.snapshot.ccr?.diluentCylinderPressureBar).toBeCloseTo(194, 12);
    expect(model.snapshot.ccr?.scrubberRemainingS).toBeCloseTo(9600, 9);
    expect(model.snapshot.failure.reason).toBeNull();
  });
});
