import { describe, expect, it } from "vitest";

import constantsSource from "../../src/constants.js?raw";
import sitesSource from "../../src/sites.js?raw";
import baselineFixture from "../fixtures/traces/baseline-v1.json";
import {
  diveStateFromLegacyCheckpoint,
  type LegacyTissueCheckpoint,
} from "../../src/app/legacy-dive-adapter";
import { advanceDiveStep } from "../../src/core/dive-model";
import type { DiveState } from "../../src/core/dive-state";
import { metres, seconds } from "../../src/core/units";
import { overheadAt } from "../../src/sites/site-collision";
import { WRECK_SITE } from "../../src/sites/wreck-site";

// The rule of thirds (#199) against the legacy client: wreck-thirds holds
// 32 m under the wreck's main deck on one 12 L cylinder of 21/35 through the
// outbound, turn and reserve thirds, then leaves the overhead. Replayed tick
// by tick, breathing its own cylinder so the model draws the gas legacy
// drew. Since #240 the overhead is not taken from the recording: each tick
// asks the client's overheadAt() at legacy's recorded diverX and the tick's
// depth, as the controller asks it each frame, and legacy's own overheadAt()
// (src/sites.js, loaded as tests/parity/site-collision loads it) and the
// recorded inOverhead must agree with it.

interface Checkpoint extends LegacyTissueCheckpoint {
  checkpointId: string;
  state: LegacyTissueCheckpoint["state"] & {
    diverX_m: number;
    debrief: {
      inOverhead: boolean;
      thirdsStartingGas_l: number;
      thirdsTurnWarned: boolean;
      thirdsReserveHit: boolean;
    };
  };
  trajectory: { depth_m: number; dtDive_min: number }[];
}

const eps = baselineFixture.tolerances.absoluteEpsilon;
const all = (baselineFixture.scenarios as unknown as { scenarioId: string; checkpoints: Checkpoint[] }[])
  .find((entry) => entry.scenarioId === "wreck-thirds")!.checkpoints;

const legacyOverheadAt = new Function(
  `${constantsSource}
var diveSite = "wreck";
${sitesSource}
return overheadAt;`,
)() as (x: number, d: number) => boolean;

/**
 * The overhead at a tick: the client's, checked against legacy's own. The
 * scenario sets diverX before each stretch and holds it still (velocity 0),
 * so the checkpoint that ends a stretch holds the x of every tick in it.
 */
function overheadOf(recorded: Checkpoint, depthM: number): boolean {
  const x = recorded.state.diverX_m;
  const inOverhead = overheadAt(WRECK_SITE, x, depthM);
  expect(inOverhead, `overhead at ${recorded.checkpointId}, x ${x}, ${depthM} m`).toBe(legacyOverheadAt(x, depthM));
  return inOverhead;
}

function expectThirdsToMatch(state: DiveState, recorded: Checkpoint): void {
  const where = recorded.checkpointId;
  const legacy = recorded.state.debrief;
  expect(Math.abs(state.thirds.startingGasL - legacy.thirdsStartingGas_l), `plan at ${where}`)
    .toBeLessThanOrEqual(eps["tanks.*.gasRemaining_l"]);
  expect(state.thirds.turnWarned, `turn latch at ${where}`).toBe(legacy.thirdsTurnWarned);
  expect(state.thirds.reserveHit, `reserve latch at ${where}`).toBe(legacy.thirdsReserveHit);
  expect(Math.abs(state.tanks[0]!.gasRemainingL - recorded.tanks![0]!.gasRemaining_l), `gas at ${where}`)
    .toBeLessThanOrEqual(eps["tanks.*.gasRemaining_l"]);
}

function replay(from: DiveState, checkpoints: readonly Checkpoint[]): DiveState {
  let state = from;
  for (const recorded of checkpoints) {
    for (const tick of recorded.trajectory) {
      if (tick.dtDive_min === 0) continue;
      state = advanceDiveStep(
        state,
        {
          depthM: metres(tick.depth_m),
          gradientFactorHighPercent: 75,
          inOverhead: overheadOf(recorded, tick.depth_m),
        },
        seconds(tick.dtDive_min * 60),
      );
    }
    expect(overheadOf(recorded, recorded.state.depth_m), `recorded overhead at ${recorded.checkpointId}`).toBe(
      recorded.state.debrief.inOverhead,
    );
    expectThirdsToMatch(state, recorded);
  }
  return state;
}

describe("the rule of thirds against the recorded legacy dive", () => {
  it("has the three thirds and the way out recorded to compare against", () => {
    expect(all.map((entry) => entry.checkpointId)).toEqual([
      "surface", "outbound-10min", "turn-20min", "reserve-28min", "outside-29min",
    ]);
    expect(all.map((entry) => [entry.state.debrief.thirdsTurnWarned, entry.state.debrief.thirdsReserveHit])).toEqual([
      [false, false], [false, false], [true, false], [true, true], [false, true],
    ]);
    // Under legacy's main deck at x 50, then off the bow at x -20 (scripts/baseline-scenarios.cjs).
    expect(all.map((entry) => [entry.state.diverX_m, entry.state.depth_m, entry.state.debrief.inOverhead])).toEqual([
      [50, 0, false], [50, 32, true], [50, 32, true], [50, 32, true], [-20, 32, false],
    ]);
  });

  it("plans, turns and reaches the reserve where legacy did, and keeps the reserve once out", () => {
    const state = replay(diveStateFromLegacyCheckpoint(all[0]!, 61), all.slice(1));
    expect(state.thirds).toEqual({ startingGasL: 0, turnWarned: false, reserveHit: true });
  });

  it("continues legacy's plan from a checkpoint inside the overhead", () => {
    const turn = all.find((entry) => entry.checkpointId === "turn-20min")!;
    const resumed = diveStateFromLegacyCheckpoint(turn, 61);
    expect(resumed.thirds.startingGasL).toBe(turn.state.debrief.thirdsStartingGas_l);
    expect(resumed.thirds.turnWarned).toBe(true);
    replay(resumed, all.slice(all.indexOf(turn) + 1));
  });
});
