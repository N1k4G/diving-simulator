import { describe, expect, it } from "vitest";

import baselineFixture from "../fixtures/traces/baseline-v1.json";
import {
  diveStateFromLegacyCheckpoint,
  logEntriesFromLegacyEvents,
  type LegacyTissueCheckpoint,
} from "../../src/app/legacy-dive-adapter";
import { MAX_DEPTH_M, type BuoyancyControls } from "../../src/core/buoyancy";
import { DiveModel, closedCircuit, openCircuit } from "../../src/core/dive-model";
import { createGasMix, type BreathingSource } from "../../src/core/dive-state";
import { metres, seconds } from "../../src/core/units";

// The dive log (#199) against the legacy client.
//
// Fast ascents: only the buoyancy scenarios can prove them. There nothing
// sets the depth, so legacy's ascentRate is the depth change the physics
// made, as the model's is. The scripted scenarios set the depth before every
// tick, so legacy measured their ascents against the target (about 8.8
// m/min on the "12 m/min" air ascent) and a replay of the trajectory would
// log fast ascents legacy never saw; those checkpoints are compared for the
// NDL latch only.

interface Checkpoint extends LegacyTissueCheckpoint {
  checkpointId: string;
  state: LegacyTissueCheckpoint["state"] & { ndlDroppedBelow5: boolean };
  events: { t: number; kind: string; value: number }[];
  trajectory: { depth_m: number; dtDive_min: number }[];
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

/** The model's log against legacy's diveEvents and ndlDroppedBelow5. */
function expectLogToMatch(model: DiveModel, recorded: Checkpoint): void {
  const where = recorded.checkpointId;
  const expected = logEntriesFromLegacyEvents(recorded.events);
  const actual = model.snapshot.log.entries;
  expect(actual.map((entry) => entry.kind), `entry kinds at ${where}`).toEqual(expected.map((entry) => entry.kind));
  actual.forEach((entry, index) => {
    const legacy = expected[index];
    expect(Math.abs(entry.elapsedTimeS / 60 - (legacy?.elapsedTimeS ?? Number.NaN) / 60), `entry ${index} time at ${where}`)
      .toBeLessThanOrEqual(eps.default);
    expect(Math.abs(entry.value - (legacy?.value ?? Number.NaN)), `entry ${index} value at ${where}`)
      .toBeLessThanOrEqual(eps.default);
  });
  expect(model.snapshot.log.ndlDroppedBelowFiveMinutes, `ndlDroppedBelow5 at ${where}`).toBe(recorded.state.ndlDroppedBelow5);
}

function replayBuoyancy(
  scenarioId: string,
  segments: readonly { checkpointId: string; controls: BuoyancyControls }[],
): number {
  const model = new DiveModel(diveStateFromLegacyCheckpoint(checkpoints(scenarioId)[0]!, 501));
  let logged = 0;
  for (const segment of segments) {
    const recorded = checkpoint(scenarioId, segment.checkpointId);
    for (const frame of recorded.trajectory) {
      model.advanceWithBuoyancy(OPEN_WATER, seconds(frame.dtDive_min * 60), segment.controls);
    }
    expectLogToMatch(model, recorded);
    logged = model.snapshot.log.entries.length;
  }
  return logged;
}

const VENT = { inflate: false, vent: true };
const INFLATE = { inflate: true, vent: false };
const NONE = { inflate: false, vent: false };

describe("the dive log against the recorded legacy dives", () => {
  it("logs the fast ascent of the buoyancy dive where legacy did, with its peak", () => {
    const logged = replayBuoyancy("buoyancy-vent-inflate-12m", [
      { checkpointId: "vented-4s", controls: VENT },
      { checkpointId: "sinking-20s", controls: NONE },
      { checkpointId: "inflated-11s", controls: INFLATE },
      { checkpointId: "coasting-30s", controls: NONE },
      { checkpointId: "vented-3s-10fps", controls: VENT },
    ]);
    // The recording holds one: the coast up past 9 m/min.
    expect(logged).toBe(1);
  });

  it("logs the fast ascent of the rebreather dive where legacy did", () => {
    const logged = replayBuoyancy("buoyancy-ccr-inflate-12m", [
      { checkpointId: "inflated-2s", controls: INFLATE },
      { checkpointId: "rising-8s", controls: NONE },
    ]);
    expect(logged).toBe(1);
  });

  // The breathed gas is given, as tests/parity/tissue-model.test.ts gives it
  // for the same bottoms: the scripted scenarios hold the loop at its
  // setpoint, where the model's own loop, dropped from the surface to 30 m in
  // one step, would settle elsewhere and load different tissues.
  it.each<[string, number, BreathingSource]>([
    ["air-18m-30min", 18, openCircuit(createGasMix(0.21, 0))],
    ["trimix-45m-20min", 45, openCircuit(createGasMix(0.21, 0.35))],
    ["ccr-30m-30min", 30, closedCircuit(1.3, createGasMix(0.15, 0.45))],
  ])("latches the NDL below 5 minutes on the %s bottom, and logs nothing there", (scenarioId, depthM, breathing) => {
    const start = checkpoint(scenarioId, "surface");
    const bottom = checkpoints(scenarioId)[1]!;
    const model = new DiveModel(diveStateFromLegacyCheckpoint(start, 17));
    model.advance(
      { depthM: metres(depthM), breathing },
      seconds((bottom.state.diveTime_min - start.state.diveTime_min) * 60),
    );
    expect(bottom.state.ndlDroppedBelow5).toBe(true);
    expectLogToMatch(model, bottom);
  });
});
