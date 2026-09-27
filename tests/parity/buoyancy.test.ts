import { describe, expect, it } from "vitest";

import baselineFixture from "../fixtures/traces/baseline-v1.json";
import { diveStateFromLegacyCheckpoint } from "../../src/app/legacy-dive-adapter";
import { DiveModel } from "../../src/core/dive-model";
import { MAX_DEPTH_M, type BuoyancyControls } from "../../src/core/buoyancy";
import { seconds } from "../../src/core/units";

// Buoyancy physics (#192) against the legacy client.
//
// buoyancy-vent-inflate-12m drives S and W through legacy's real
// updateBuoyancyPhysics() in one-second ticks, with nothing setting the
// depth (scripts/baseline-scenarios.cjs). The model replays the same keys,
// one advanceWithBuoyancy() step per tick, and must land on the depth legacy
// recorded after every tick. At each checkpoint the velocity, BCD gas,
// tissues, cylinder gas and CNS are compared as well.
//
// The recording runs on the geometry-free 'open' site, so the only bounds
// are the surface and MAX_DEPTH, legacy's ceilingAt()/floorAt() with no
// active site.

interface Checkpoint {
  checkpointId: string;
  state: {
    depth_m: number;
    maxDepth_m: number;
    diveTime_min: number;
    diveMode?: string;
    activeTankIndex: number;
    cns_percent: number;
    verticalVelocity_mpm: number;
    bcdGasSurface_l: number;
  };
  configuration?: { amv_lpm?: number };
  tissues: { n2_bar: number[]; he_bar: number[] };
  tanks?: { fO2: number; fHe: number; volume_l: number; pressure_bar: number; gasRemaining_l: number }[];
  trajectory: { depth_m: number; dtDive_min: number }[];
}

const scenario = (baselineFixture.scenarios as unknown as { scenarioId: string; checkpoints: Checkpoint[] }[])
  .find((entry) => entry.scenarioId === "buoyancy-vent-inflate-12m");
const eps = baselineFixture.tolerances.absoluteEpsilon;
const OPEN_WATER = { ceilingM: 0, floorM: MAX_DEPTH_M };

/** The keys each segment held, as the scenario script presses them. */
const SEGMENTS: readonly { checkpointId: string; controls: BuoyancyControls }[] = [
  { checkpointId: "vented-4s", controls: { inflate: false, vent: true } },
  { checkpointId: "sinking-20s", controls: { inflate: false, vent: false } },
  { checkpointId: "inflated-11s", controls: { inflate: true, vent: false } },
  { checkpointId: "coasting-30s", controls: { inflate: false, vent: false } },
];

function checkpoint(id: string): Checkpoint {
  const found = scenario?.checkpoints.find((entry) => entry.checkpointId === id);
  if (!found) throw new Error(`Missing golden checkpoint: buoyancy-vent-inflate-12m/${id}`);
  return found;
}

function within(actual: number | undefined, expected: number, tolerance: number, what: string): void {
  expect(actual, what).toBeDefined();
  expect(Math.abs((actual ?? Number.NaN) - expected), what).toBeLessThanOrEqual(tolerance);
}

describe("buoyancy physics against the recorded legacy dive", () => {
  it("reproduces every tick's depth and each checkpoint's motion, gas and tissues", () => {
    const model = new DiveModel(diveStateFromLegacyCheckpoint(checkpoint("neutral-12m"), 501));

    for (const segment of SEGMENTS) {
      const recorded = checkpoint(segment.checkpointId);
      recorded.trajectory.forEach((tick, index) => {
        model.advanceWithBuoyancy(OPEN_WATER, seconds(tick.dtDive_min * 60), segment.controls);
        within(model.snapshot.depthM, tick.depth_m, eps.default, `depth after tick ${index + 1} of ${segment.checkpointId}`);
      });

      const state = model.snapshot;
      expect(state.failure.reason, segment.checkpointId).toBeNull();
      within(state.verticalVelocityMpm, recorded.state.verticalVelocity_mpm, eps.default, `velocity at ${segment.checkpointId}`);
      within(state.bcdGasSurfaceLiters, recorded.state.bcdGasSurface_l, eps.default, `BCD gas at ${segment.checkpointId}`);
      within(state.cnsPercent, recorded.state.cns_percent, eps.default, `CNS at ${segment.checkpointId}`);
      within(state.tanks[0]?.gasRemainingL, recorded.tanks?.[0]?.gasRemaining_l ?? Number.NaN, eps["tanks.*.gasRemaining_l"], `cylinder gas at ${segment.checkpointId}`);
      for (let i = 0; i < 16; i += 1) {
        within(state.tissues.nitrogenBar[i], recorded.tissues.n2_bar[i] ?? Number.NaN, eps["tissues.*_bar"], `N2 compartment ${i + 1} at ${segment.checkpointId}`);
      }
    }
  });

  it("exercises the physics, not only the limits", () => {
    // The recording is chosen so the motion is more than the velocity caps:
    // the diver sinks at the descent limit, is slowed and turned by the
    // inflation, and accelerates upward as the BCD expands.
    const turned = checkpoint("inflated-11s").state.verticalVelocity_mpm;
    expect(turned).toBeGreaterThan(0);
    expect(turned).toBeLessThan(20);
    expect(checkpoint("coasting-30s").state.verticalVelocity_mpm).toBe(-25);
  });
});
