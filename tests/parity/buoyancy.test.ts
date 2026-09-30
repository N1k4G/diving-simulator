import { describe, expect, it } from "vitest";

import baselineFixture from "../fixtures/traces/baseline-v1.json";
import { diveStateFromLegacyCheckpoint, type LegacyTissueCheckpoint } from "../../src/app/legacy-dive-adapter";
import { DiveModel } from "../../src/core/dive-model";
import { MAX_DEPTH_M, type BuoyancyControls } from "../../src/core/buoyancy";
import { seconds } from "../../src/core/units";

// Buoyancy physics (#192) against the legacy client.
//
// Both scenarios drive S and W through legacy's real updateBuoyancyPhysics()
// in display frames, as the legacy game loop runs them, with nothing setting
// the depth (scripts/baseline-scenarios.cjs). The model replays the same
// keys and frames, one advanceWithBuoyancy() call per frame, and must land on the
// depth legacy recorded after every frame. At each checkpoint the velocity,
// BCD gas, tissues, cylinder gas and CNS are compared as well.
//
// The recordings run on the geometry-free 'open' site, so the only bounds
// are the surface and MAX_DEPTH, legacy's ceilingAt()/floorAt() with no
// active site.

interface Checkpoint extends LegacyTissueCheckpoint {
  checkpointId: string;
  state: LegacyTissueCheckpoint["state"] & {
    verticalVelocity_mpm: number;
    bcdGasSurface_l: number;
    cns_percent: number;
  };
  trajectory: { depth_m: number; dtDive_min: number }[];
}

interface Segment {
  readonly checkpointId: string;
  readonly controls: BuoyancyControls;
}

const eps = baselineFixture.tolerances.absoluteEpsilon;
const OPEN_WATER = { ceilingM: 0, floorM: MAX_DEPTH_M };

function checkpoints(scenarioId: string): Checkpoint[] {
  const scenario = (baselineFixture.scenarios as unknown as { scenarioId: string; checkpoints: Checkpoint[] }[])
    .find((entry) => entry.scenarioId === scenarioId);
  if (!scenario) throw new Error(`Missing golden scenario: ${scenarioId}`);
  return scenario.checkpoints;
}

function checkpoint(scenarioId: string, id: string): Checkpoint {
  const found = checkpoints(scenarioId).find((entry) => entry.checkpointId === id);
  if (!found) throw new Error(`Missing golden checkpoint: ${scenarioId}/${id}`);
  return found;
}

function within(actual: number | undefined, expected: number, tolerance: number, what: string): void {
  expect(actual, what).toBeDefined();
  expect(Math.abs((actual ?? Number.NaN) - expected), what).toBeLessThanOrEqual(tolerance);
}

/**
 * Replays a scenario from its first checkpoint, frame by frame, comparing the
 * depth after every frame and the motion, CNS and tissues at each checkpoint.
 * `atCheckpoint` compares the gas, which the declared departure changes.
 */
function replay(
  scenarioId: string,
  segments: readonly Segment[],
  atCheckpoint: (model: DiveModel, recorded: Checkpoint) => void,
): void {
  const model = new DiveModel(diveStateFromLegacyCheckpoint(checkpoints(scenarioId)[0]!, 501));
  for (const segment of segments) {
    const recorded = checkpoint(scenarioId, segment.checkpointId);
    recorded.trajectory.forEach((frame, index) => {
      model.advanceWithBuoyancy(OPEN_WATER, seconds(frame.dtDive_min * 60), segment.controls);
      within(model.snapshot.depthM, frame.depth_m, eps.default, `depth after frame ${index + 1} of ${segment.checkpointId}`);
    });

    const state = model.snapshot;
    expect(state.failure.reason, segment.checkpointId).toBeNull();
    within(state.verticalVelocityMpm, recorded.state.verticalVelocity_mpm, eps.default, `velocity at ${segment.checkpointId}`);
    within(state.bcdGasSurfaceLiters, recorded.state.bcdGasSurface_l, eps.default, `BCD gas at ${segment.checkpointId}`);
    within(state.cnsPercent, recorded.state.cns_percent, eps.default, `CNS at ${segment.checkpointId}`);
    for (let i = 0; i < 16; i += 1) {
      within(state.tissues.nitrogenBar[i], recorded.tissues.n2_bar[i] ?? Number.NaN, eps["tissues.*_bar"], `N2 compartment ${i + 1} at ${segment.checkpointId}`);
    }
    atCheckpoint(model, recorded);
  }
}

describe("buoyancy physics against the recorded legacy dive", () => {
  const SCENARIO = "buoyancy-vent-inflate-12m";

  it("reproduces every frame's depth and each checkpoint's motion, gas and tissues", () => {
    replay(
      SCENARIO,
      [
        { checkpointId: "vented-4s", controls: { inflate: false, vent: true } },
        { checkpointId: "sinking-20s", controls: { inflate: false, vent: false } },
        { checkpointId: "inflated-11s", controls: { inflate: true, vent: false } },
        { checkpointId: "coasting-30s", controls: { inflate: false, vent: false } },
        { checkpointId: "vented-3s-10fps", controls: { inflate: false, vent: true } },
      ],
      (model, recorded) => {
        within(model.snapshot.tanks[0]?.gasRemainingL, recorded.tanks?.[0]?.gasRemaining_l ?? Number.NaN, eps["tanks.*.gasRemaining_l"], `cylinder gas at ${recorded.checkpointId}`);
      },
    );
  });

  it("exercises the physics, not only the limits", () => {
    // The recording is chosen so the motion is more than the velocity caps:
    // the diver sinks at the descent limit, is slowed and turned by the
    // inflation, and accelerates upward as the BCD expands.
    const turned = checkpoint(SCENARIO, "inflated-11s").state.verticalVelocity_mpm;
    expect(turned).toBeGreaterThan(0);
    expect(turned).toBeLessThan(20);
    expect(checkpoint(SCENARIO, "coasting-30s").state.verticalVelocity_mpm).toBe(-25);
  });

  it("is recorded in display frames, the cadence legacy applies the controls at", () => {
    // At TIME_ACCELERATION 3, a 60 Hz frame is 0.05 s of dive time. The last
    // segment runs at 10 fps, 0.3 s per frame, the longest frame legacy
    // allows with a control held: the controls go in once, the physics in
    // three sub-steps.
    for (const recorded of checkpoints(SCENARIO).slice(1)) {
      const frameS = recorded.checkpointId === "vented-3s-10fps" ? 0.3 : 0.05;
      for (const frame of recorded.trajectory) expect(frame.dtDive_min * 60, recorded.checkpointId).toBeCloseTo(frameS, 12);
    }
  });
});

// The recorded departure (docs/decisions.md, #192): on a rebreather the BCD
// inflates from the diluent cylinder. Legacy's inflateBCD() draws from
// tanks[activeTank], the setup placeholder on a CCR dive, and the fixture
// keeps that. Affected, at every checkpoint after the inflation: the
// placeholder's gas and the diluent pressure. Everything else is compared
// with legacy.
describe("inflating on a rebreather, a declared departure from legacy", () => {
  const SCENARIO = "buoyancy-ccr-inflate-12m";
  const neutral = checkpoint(SCENARIO, "neutral-12m");
  const AFFECTED = ["inflated-2s", "rising-8s"];

  it("moves and breathes as legacy, and draws the inflation from the diluent", () => {
    const visited: string[] = [];
    replay(
      SCENARIO,
      [
        { checkpointId: "inflated-2s", controls: { inflate: true, vent: false } },
        { checkpointId: "rising-8s", controls: { inflate: false, vent: false } },
      ],
      (model, recorded) => {
        visited.push(recorded.checkpointId);
        const state = model.snapshot;
        const ccr = state.ccr;
        const legacyCcr = recorded.ccr;
        expect(ccr, recorded.checkpointId).toBeDefined();
        expect(legacyCcr, recorded.checkpointId).toBeTruthy();
        if (!ccr || !legacyCcr) return;

        // Unaffected: the loop, the oxygen cylinder and the scrubber.
        within(ccr.actualPo2Bar, legacyCcr.actualPO2_bar, eps.default, `loop pO2 at ${recorded.checkpointId}`);
        within(ccr.oxygenCylinderPressureBar, legacyCcr.o2Pressure_bar, eps["ccr.*Pressure_bar"], `O2 cylinder at ${recorded.checkpointId}`);
        within(ccr.scrubberRemainingS, legacyCcr.scrubberRemaining_min * 60, eps.default * 60, `scrubber at ${recorded.checkpointId}`);

        // The independent reference is conservation of gas: what the BCD
        // gained since the neutral checkpoint left a cylinder.
        const inflatedL = recorded.state.bcdGasSurface_l - neutral.state.bcdGasSurface_l;
        expect(inflatedL, recorded.checkpointId).toBeGreaterThan(1);
        const placeholderStartL = neutral.tanks?.[0]?.gasRemaining_l ?? Number.NaN;
        const legacyPlaceholderL = recorded.tanks?.[0]?.gasRemaining_l ?? Number.NaN;

        // Legacy drew it from the placeholder, and left the diluent to the
        // loop alone.
        within(placeholderStartL - legacyPlaceholderL, inflatedL, eps["tanks.*.gasRemaining_l"], `legacy placeholder draw at ${recorded.checkpointId}`);
        // The migration leaves the placeholder alone ...
        expect(state.tanks[0]?.gasRemainingL, recorded.checkpointId).toBe(placeholderStartL);
        expect(Math.abs((state.tanks[0]?.gasRemainingL ?? 0) - legacyPlaceholderL)).toBeGreaterThan(1);
        // ... and takes the same gas from the diluent cylinder.
        const expectedDiluentBar = legacyCcr.diluentPressure_bar - inflatedL / ccr.diluentCylinderVolumeL;
        within(ccr.diluentCylinderPressureBar, expectedDiluentBar, eps["ccr.*Pressure_bar"], `diluent at ${recorded.checkpointId}`);
        expect(legacyCcr.diluentPressure_bar - ccr.diluentCylinderPressureBar).toBeGreaterThan(0.3);
      },
    );
    expect(visited).toEqual(AFFECTED);
  });
});
