import { describe, expect, it } from "vitest";

import { gradeDive } from "../../src/core/dive-grade";
import { DiveModel } from "../../src/core/dive-model";
import {
  createCcrState,
  createGasMix,
  createInitialDiveState,
  createTankState,
  type DiveState,
} from "../../src/core/dive-state";
import { bars, metres, seconds } from "../../src/core/units";
import { createPostDiveSummary } from "../../src/presentation/post-dive-summary";
import { createPresentationState } from "../../src/presentation/presentation-state";

// The post-dive summary (#159): what legacy's drawPostDive() reads off its
// globals, derived once from the state the dive ended in.

const AIR = createGasMix(0.21, 0);
const EAN50 = createGasMix(0.5, 0);
const OPEN_WATER = { overheadSite: false };

function dive(initial: DiveState, plan: readonly [depthM: number, seconds: number][]): DiveState {
  const model = new DiveModel(initial);
  for (const [depthM, durationS] of plan) model.advance({ depthM: metres(depthM) }, seconds(durationS));
  return model.snapshot;
}

describe("the post-dive summary", () => {
  it("summarises an open-circuit dive that surfaced without its safety stop", () => {
    const state = dive(
      createInitialDiveState(7, { tanks: [createTankState(AIR), createTankState(EAN50, 7, 180)] }),
      [[12, 60], [0, 1]],
    );
    expect(state.completed).toBe(true);
    const summary = createPostDiveSummary(state, OPEN_WATER);

    expect(summary.elapsedTimeS).toBe(state.elapsedTimeS);
    expect(summary.maxDepthM).toBe(state.maxDepthM);
    expect(summary.averageDepthM).toBeCloseTo(state.log.depthTimeMS / state.log.submergedS, 12);
    expect(summary.averageDepthM).toBeGreaterThan(11);
    expect(summary.averageDepthM).toBeLessThanOrEqual(12);
    expect(summary.safetyStop).toBe("skipped");
    expect(summary.violations.map((entry) => entry.kind)).toEqual(["safety-stop-skipped"]);
    expect(summary.violations).toBe(state.log.entries);
    expect(summary.profile).toBe(state.log.profile);
    expect(summary.grade).toEqual(gradeDive(state, OPEN_WATER));

    // Each cylinder: legacy's totalGas - gasRemaining of totalGas.
    expect(summary.rebreather).toBeNull();
    expect(summary.cylinders).toHaveLength(2);
    const [first, second] = summary.cylinders;
    expect(first!.startL).toBe(2400);
    expect(first!.usedL).toBeCloseTo(2400 - state.tanks[0]!.gasRemainingL, 9);
    expect(first!.usedL).toBeGreaterThan(0);
    expect(second).toMatchObject({ index: 1, startL: 1260, usedL: 0 });
    expect(second!.gas.oxygenFraction).toBe(0.5);
  });

  it("says when the stop was done, and when it was not needed", () => {
    const stopped = dive(createInitialDiveState(9), [[12, 60], [5, 200], [0, 1]]);
    expect(stopped.completed).toBe(true);
    expect(createPostDiveSummary(stopped, OPEN_WATER).safetyStop).toBe("done");
    expect(stopped.log.entries).toEqual([]);

    const shallow = dive(createInitialDiveState(11), [[8, 60], [0, 1]]);
    expect(shallow.completed).toBe(true);
    expect(createPostDiveSummary(shallow, OPEN_WATER).safetyStop).toBe("not-needed");
  });

  it("reports a rebreather's own cylinders and scrubber, not its open-circuit list", () => {
    const state = dive(
      createInitialDiveState(13, {
        ccr: createCcrState(AIR, { targetPo2Bar: bars(1.2), diluentCylinderPressureBar: bars(190) }),
      }),
      [[12, 60], [0, 1]],
    );
    const ccr = state.ccr!;
    const summary = createPostDiveSummary(state, OPEN_WATER);
    expect(summary.cylinders).toEqual([]);
    expect(summary.rebreather).toEqual({
      oxygenUsedL: (200 - ccr.oxygenCylinderPressureBar) * ccr.oxygenCylinderVolumeL,
      oxygenLeftBar: ccr.oxygenCylinderPressureBar,
      diluentUsedL: (190 - ccr.diluentCylinderPressureBar) * ccr.diluentCylinderVolumeL,
      diluentLeftBar: ccr.diluentCylinderPressureBar,
      scrubberUsedS: ccr.scrubberTotalS - ccr.scrubberRemainingS,
      onBailout: false,
    });
    expect(summary.rebreather!.oxygenUsedL).toBeGreaterThan(0);
    expect(summary.rebreather!.scrubberUsedS).toBeCloseTo(61, 6);

    const bailed = new DiveModel(createInitialDiveState(13, { ccr: createCcrState(AIR) }));
    bailed.advance({ depthM: metres(12) }, seconds(60));
    bailed.bailOut();
    expect(createPostDiveSummary(bailed.snapshot, OPEN_WATER).rebreather?.onBailout).toBe(true);
  });

  it("reports no average depth before the diver has been under", () => {
    expect(createPostDiveSummary(createInitialDiveState(1), OPEN_WATER).averageDepthM).toBe(0);
  });

  it("is frozen", () => {
    const summary = createPostDiveSummary(dive(createInitialDiveState(3), [[12, 60]]), OPEN_WATER);
    expect(Object.isFrozen(summary)).toBe(true);
    expect(Object.isFrozen(summary.cylinders)).toBe(true);
    expect(Object.isFrozen(summary.cylinders[0])).toBe(true);
    // The grade too, down to each note (#217 pre-review).
    expect(Object.isFrozen(summary.grade)).toBe(true);
    expect(Object.isFrozen(summary.grade.scores)).toBe(true);
    expect(summary.grade.scores.every((entry) => Object.isFrozen(entry) && Object.isFrozen(entry.note))).toBe(true);
  });

  it("is what the presentation snapshot's completion flag announces", () => {
    const surfaced = dive(createInitialDiveState(5), [[12, 60], [0, 1]]);
    expect(createPresentationState(surfaced, null).completed).toBe(true);
    expect(createPresentationState(createInitialDiveState(5), null).completed).toBe(false);
  });
});
