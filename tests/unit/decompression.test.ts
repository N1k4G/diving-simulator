import { describe, expect, it } from "vitest";

import baselineFixture from "../fixtures/traces/baseline-v1.json";
import {
  NDL_UNLIMITED_MINUTES,
  ceilingDepthM,
  decoStopDepth,
  ndlMinutes,
} from "../../src/core/decompression";
import { createGasMix, createInitialDiveState } from "../../src/core/dive-state";
import { bars } from "../../src/core/units";

// The decompression limits in the core (#199). The planner's forecast is
// replayed against legacy in tests/parity/dive-planner.test.ts through these
// same functions; these pin them directly, on legacy's recorded numbers.

interface Checkpoint {
  checkpointId: string;
  configuration: { gfHigh_percent: number };
  state: { depth_m: number };
  tissues: { n2_bar: number[]; he_bar: number[] };
  planner: { ceiling_m: number; ndl_min: number };
  tanks: { fO2: number; fHe: number }[];
}

function checkpoint(scenarioId: string, id: string): Checkpoint {
  const found = (baselineFixture.scenarios as unknown as { scenarioId: string; checkpoints: Checkpoint[] }[])
    .find((scenario) => scenario.scenarioId === scenarioId)
    ?.checkpoints.find((entry) => entry.checkpointId === id);
  if (!found) throw new Error(`Missing golden checkpoint: ${scenarioId}/${id}`);
  return found;
}

const tissuesOf = (recorded: Checkpoint) => ({
  nitrogenBar: recorded.tissues.n2_bar.map((value) => bars(value)),
  heliumBar: recorded.tissues.he_bar.map((value) => bars(value)),
});

describe("the decompression limits", () => {
  it("give legacy's NDL at the bottom of the air dive", () => {
    const recorded = checkpoint("air-18m-30min", "bottom-30min");
    const gas = createGasMix(recorded.tanks[0]?.fO2 ?? 0, recorded.tanks[0]?.fHe ?? 0);
    expect(
      ndlMinutes(tissuesOf(recorded), recorded.state.depth_m, gas, recorded.configuration.gfHigh_percent / 100),
    ).toBe(recorded.planner.ndl_min);
  });

  it("give legacy's ceiling at the bottom of the trimix dive, helium loaded", () => {
    // 11.5 m: the deepest ceiling in the fixture, with helium in every
    // compartment, so the combined a and b are exercised.
    const recorded = checkpoint("trimix-45m-20min", "bottom-20min");
    expect(recorded.planner.ceiling_m).toBeGreaterThan(10);
    expect(
      Math.abs(ceilingDepthM(tissuesOf(recorded), recorded.configuration.gfHigh_percent / 100) - recorded.planner.ceiling_m),
    ).toBeLessThanOrEqual(baselineFixture.tolerances.absoluteEpsilon["planner.ceiling_m"]);
  });

  it("have no ceiling and no limit for a diver fresh from the surface", () => {
    const fresh = createInitialDiveState(1);
    expect(ceilingDepthM(fresh.tissues, 0.75)).toBe(0);
    expect(ndlMinutes(fresh.tissues, 0, createGasMix(0.21, 0), 0.75)).toBe(NDL_UNLIMITED_MINUTES);
  });

  it("round a ceiling up to the next 3 m stop, and no ceiling to no stop", () => {
    expect(decoStopDepth(0)).toBe(0);
    expect(decoStopDepth(0.1)).toBe(3);
    expect(decoStopDepth(3)).toBe(3);
    expect(decoStopDepth(7.2)).toBe(9);
  });
});
