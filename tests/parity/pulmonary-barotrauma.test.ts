import { describe, expect, it } from "vitest";

import baselineFixture from "../fixtures/traces/baseline-v1.json";
import {
  diveStateFromLegacyCheckpoint,
  logEntriesFromLegacyEvents,
  type LegacyTissueCheckpoint,
} from "../../src/app/legacy-dive-adapter";
import { MAX_DEPTH_M, type BuoyancyControls } from "../../src/core/buoyancy";
import {
  BAROTRAUMA_FAILURE_SECONDS,
  DiveModel,
  advanceDiveStep,
} from "../../src/core/dive-model";
import { metres, seconds } from "../../src/core/units";

// Pulmonary barotrauma (#189) against the legacy client: its timer counts
// each dive second of an ascent at 18 m/min or faster, counts down twice as
// fast otherwise, and ends the dive at 10 s. The recording drives W and S
// through legacy's buoyancy physics in 60 Hz frames from neutral at 30 m on
// air; the model replays the same controls and frames through
// advanceWithBuoyancy(), the client's own path, so the ascent rate it times
// is the one its physics produced, frame by frame. Each segment is a
// checkpoint: the timer counting, still counting while S is held, counting
// down, and counting again until it ends the dive.

interface Checkpoint extends LegacyTissueCheckpoint {
  checkpointId: string;
  state: LegacyTissueCheckpoint["state"] & {
    gameState: string;
    gameOverReason: string | null;
    debrief: { barotrauma_s: number; ascentRate_mpm: number };
  };
  events: { t: number; kind: string; value: number }[];
  trajectory: { depth_m: number; dtDive_min: number }[];
}

const SCENARIO = "barotrauma-runaway-ascent-30m";
const LEGACY_REASON = "PULMONARY BAROTRAUMA — PNEUMOTHORAX";
const OPEN_WATER = { ceilingM: 0, floorM: MAX_DEPTH_M };
const eps = baselineFixture.tolerances.absoluteEpsilon;
const W: BuoyancyControls = { inflate: true, vent: false };
const S: BuoyancyControls = { inflate: false, vent: true };
const SEGMENTS: readonly [string, BuoyancyControls][] = [
  ["inflated-5.5s", W],
  ["vented-3s", S],
  ["vented-5s", S],
  ["reinflated-10s", W],
  ["barotrauma", W],
];

function checkpoints(): Checkpoint[] {
  const scenario = (baselineFixture.scenarios as unknown as { scenarioId: string; checkpoints: Checkpoint[] }[])
    .find((entry) => entry.scenarioId === SCENARIO);
  if (!scenario) throw new Error(`Missing golden scenario: ${SCENARIO}`);
  return scenario.checkpoints;
}

function checkpoint(id: string): Checkpoint {
  const found = checkpoints().find((entry) => entry.checkpointId === id);
  if (!found) throw new Error(`Missing golden checkpoint: ${SCENARIO}/${id}`);
  return found;
}

/**
 * Replays the segments after `startId` frame by frame from legacy's state
 * there, checking the depth after every frame, that the dive goes on until
 * legacy's last frame and ends on it, and the timer, the failure and the
 * log at each checkpoint.
 */
function replayFrom(startId: string): DiveModel {
  const model = new DiveModel(diveStateFromLegacyCheckpoint(checkpoint(startId), 31));
  expect(model.snapshot.failure.barotraumaS).toBe(checkpoint(startId).state.debrief.barotrauma_s);
  const startIndex = SEGMENTS.findIndex(([id]) => id === startId) + 1;
  for (const [id, controls] of SEGMENTS.slice(startIndex)) {
    const recorded = checkpoint(id);
    const failed = recorded.state.gameOverReason !== null;
    recorded.trajectory.forEach((frame, index) => {
      const where = `frame ${index + 1} of ${id}`;
      expect(model.snapshot.failure.reason, `before ${where}`).toBeNull();
      model.advanceWithBuoyancy(OPEN_WATER, seconds(frame.dtDive_min * 60), controls);
      expect(Math.abs(model.snapshot.depthM - frame.depth_m), `depth after ${where}`).toBeLessThanOrEqual(eps.default);
    });
    const state = model.snapshot;
    expect(Math.abs(state.failure.barotraumaS - recorded.state.debrief.barotrauma_s), `timer at ${id}`)
      .toBeLessThanOrEqual(eps.default);
    expect(Math.abs(state.log.ascentRateMpm - recorded.state.debrief.ascentRate_mpm), `ascent rate at ${id}`)
      .toBeLessThanOrEqual(eps.default);
    expect(state.failure.reason, `failure at ${id}`).toBe(failed ? "pulmonary-barotrauma" : null);
    expect(recorded.state.gameState, `legacy's state at ${id}`).toBe(failed ? "gameover" : "diving");
    if (failed) expect(recorded.state.gameOverReason).toBe(LEGACY_REASON);
    // Legacy logs the fast ascent before its dive-ending checks, so the
    // failing frame's capture runs too.
    const expected = logEntriesFromLegacyEvents(recorded.events);
    expect(state.log.entries.map((entry) => entry.kind), `entry kinds at ${id}`).toEqual(
      expected.map((entry) => entry.kind),
    );
    state.log.entries.forEach((entry, index) => {
      expect(Math.abs(entry.elapsedTimeS - expected[index]!.elapsedTimeS) / 60, `entry ${index} time at ${id}`)
        .toBeLessThanOrEqual(eps.default);
      expect(Math.abs(entry.value - expected[index]!.value), `entry ${index} value at ${id}`)
        .toBeLessThanOrEqual(eps.default);
    });
  }
  return model;
}

describe("pulmonary barotrauma against the recorded legacy dive", () => {
  it("counts the timer up, holds it through a slowing vent, lets it decay, and ends the dive on legacy's frame", () => {
    const model = replayFrom("neutral-30m");
    const state = model.snapshot;
    expect(state.failure.barotraumaS).toBeGreaterThanOrEqual(BAROTRAUMA_FAILURE_SECONDS);
    expect(state.events.at(-1)).toMatchObject({ type: "failure", failureReason: "pulmonary-barotrauma" });
    // The two clocks sum the same frames in a different unit (minutes
    // against seconds), so they differ in the last bits only.
    expect(state.events.at(-1)?.elapsedTimeS).toBeCloseTo(checkpoint("barotrauma").state.diveTime_min * 60, 9);
  });

  it("exercises every branch of legacy's timer", () => {
    // Guards the replay against a recording that no longer does: counting
    // with W, still counting with S held above 18 m/min, counting down below
    // it, and counting again to the end.
    const timer = (id: string) => checkpoint(id).state.debrief.barotrauma_s;
    expect(timer("inflated-5.5s")).toBeGreaterThan(0);
    expect(timer("vented-3s")).toBeGreaterThan(timer("inflated-5.5s"));
    expect(checkpoint("vented-3s").state.debrief.ascentRate_mpm).toBeGreaterThanOrEqual(18);
    expect(timer("vented-5s")).toBeLessThan(timer("vented-3s"));
    expect(checkpoint("vented-5s").state.debrief.ascentRate_mpm).toBeLessThan(18);
    expect(timer("reinflated-10s")).toBeLessThan(BAROTRAUMA_FAILURE_SECONDS);
    expect(checkpoint("barotrauma").state.gameOverReason).toBe(LEGACY_REASON);
  });

  it("continues legacy's timer from a checkpoint and fails on the same frame", () => {
    expect(checkpoint("reinflated-10s").state.debrief.barotrauma_s).toBeGreaterThan(2);
    const model = replayFrom("reinflated-10s");
    expect(model.snapshot.failure.reason).toBe("pulmonary-barotrauma");
  });

  it("reads legacy's game over as a dive barotrauma ended, which goes no further", () => {
    const state = diveStateFromLegacyCheckpoint(checkpoint("barotrauma"), 31);
    expect(state.failure.reason).toBe("pulmonary-barotrauma");
    expect(state.failure.barotraumaS).toBe(checkpoint("barotrauma").state.debrief.barotrauma_s);
    expect(state.events.at(-1)).toMatchObject({ type: "failure", failureReason: "pulmonary-barotrauma" });
    expect(advanceDiveStep(state, { depthM: metres(20) }, seconds(1))).toBe(state);
  });
});
