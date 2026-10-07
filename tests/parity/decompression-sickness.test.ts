import { describe, expect, it } from "vitest";

import baselineFixture from "../fixtures/traces/baseline-v1.json";
import {
  diveStateFromLegacyCheckpoint,
  logEntriesFromLegacyEvents,
  type LegacyTissueCheckpoint,
} from "../../src/app/legacy-dive-adapter";
import { DCS_VIOLATION_FAILURE_SECONDS, advanceDiveStep } from "../../src/core/dive-model";
import type { DiveState } from "../../src/core/dive-state";
import { metres, seconds } from "../../src/core/units";

// Decompression sickness (#199) against the legacy client: its DCS timer,
// which ends a dive held shallower than the first stop for 60 dive seconds,
// and the instant DCS of surfacing with a ceiling deeper than 3 m. Both
// scenarios start from the trimix dive's bottom and are replayed tick by
// tick at the depth legacy read back, each breathing its own cylinder. The
// straight jump up is one tick, too short for a fast ascent, so the log's
// entries are compared as well: legacy logs the broken ceiling above the stop.

interface Checkpoint extends LegacyTissueCheckpoint {
  checkpointId: string;
  state: LegacyTissueCheckpoint["state"] & {
    gameState: string;
    gameOverReason: string | null;
    debrief: { dcsViolation_s: number };
  };
  planner: { ceiling_m: number };
  events: { t: number; kind: string; value: number }[];
  trajectory: { depth_m: number; dtDive_min: number }[];
}

function checkpoints(scenarioId: string): Checkpoint[] {
  const scenario = (baselineFixture.scenarios as unknown as { scenarioId: string; checkpoints: Checkpoint[] }[])
    .find((entry) => entry.scenarioId === scenarioId);
  if (!scenario) throw new Error(`Missing golden scenario: ${scenarioId}`);
  return scenario.checkpoints;
}

const LEGACY_REASON = "DECOMPRESSION SICKNESS";
const eps = baselineFixture.tolerances.absoluteEpsilon;

/** Replays every checkpoint after `startId`, checking each against legacy. */
function replayFrom(scenarioId: string, startId: string): DiveState {
  const all = checkpoints(scenarioId);
  const startIndex = all.findIndex((entry) => entry.checkpointId === startId);
  let state = diveStateFromLegacyCheckpoint(all[startIndex]!, 23);
  expect(state.failure.dcsViolationS).toBe(all[startIndex]!.state.debrief.dcsViolation_s);
  for (const recorded of all.slice(startIndex + 1)) {
    for (const tick of recorded.trajectory) {
      if (tick.dtDive_min === 0) continue;
      state = advanceDiveStep(
        state,
        { depthM: metres(tick.depth_m), gradientFactorHighPercent: 75 },
        seconds(tick.dtDive_min * 60),
      );
    }
    const where = `${scenarioId}/${recorded.checkpointId}`;
    expect(state.failure.dcsViolationS, `DCS timer at ${where}`).toBeCloseTo(recorded.state.debrief.dcsViolation_s, 9);
    expect(state.failure.reason, `failure at ${where}`).toBe(
      recorded.state.gameOverReason === LEGACY_REASON ? "decompression-sickness" : null,
    );
    const expected = logEntriesFromLegacyEvents(recorded.events);
    expect(state.log.entries.map((entry) => entry.kind), `entry kinds at ${where}`).toEqual(
      expected.map((entry) => entry.kind),
    );
    state.log.entries.forEach((entry, index) => {
      expect(Math.abs(entry.elapsedTimeS - expected[index]!.elapsedTimeS) / 60, `entry ${index} time at ${where}`)
        .toBeLessThanOrEqual(eps.default);
      expect(Math.abs(entry.value - expected[index]!.value), `entry ${index} value at ${where}`)
        .toBeLessThanOrEqual(eps.default);
    });
    expect(recorded.state.gameState, `legacy's state at ${where}`).toBe(
      recorded.state.gameOverReason === null ? "diving" : "gameover",
    );
  }
  return state;
}

describe("decompression sickness against the recorded legacy dives", () => {
  it("ends a dive held above the stop when the timer reaches 60 dive seconds, on legacy's tick", () => {
    const state = replayFrom("trimix-dcs-above-stop", "bottom-20min");
    const failed = checkpoints("trimix-dcs-above-stop").at(-1)!;
    expect(failed.state.gameOverReason).toBe(LEGACY_REASON);
    // Guards the log comparison against a fixture that no longer has one.
    expect(state.log.entries.map((entry) => entry.kind)).toEqual(["ceiling-violation"]);
    expect(state.failure.dcsViolationS).toBe(DCS_VIOLATION_FAILURE_SECONDS);
    expect(state.events.at(-1)).toMatchObject({ type: "failure", failureReason: "decompression-sickness" });
    // The two clocks sum the same ticks in a different unit (minutes against
    // seconds), so they differ in the last bits only.
    expect(state.events.at(-1)?.elapsedTimeS).toBeCloseTo(failed.state.diveTime_min * 60, 9);
  });

  it("continues legacy's timer from a checkpoint above the stop, and fails on the same tick", () => {
    const resumed = checkpoints("trimix-dcs-above-stop").find((entry) => entry.checkpointId === "above-stop-30s")!;
    expect(resumed.state.debrief.dcsViolation_s).toBe(30);
    const state = replayFrom("trimix-dcs-above-stop", "above-stop-30s");
    expect(state.failure.reason).toBe("decompression-sickness");
  });

  it("reads legacy's two game overs as dives decompression sickness ended, which go no further", () => {
    for (const scenarioId of ["trimix-dcs-above-stop", "trimix-dcs-surfaced"]) {
      const recorded = checkpoints(scenarioId).at(-1)!;
      expect(recorded.state.gameOverReason).toBe(LEGACY_REASON);
      const state = diveStateFromLegacyCheckpoint(recorded, 23);
      expect(state.failure.reason, scenarioId).toBe("decompression-sickness");
      expect(state.events.at(-1), scenarioId).toMatchObject({ type: "failure", failureReason: "decompression-sickness" });
      expect(advanceDiveStep(state, { depthM: metres(6) }, seconds(1)), scenarioId).toBe(state);
    }
  });

  it("refuses a recorded game over it has no failure for, rather than read it as a dive going on", () => {
    const recorded = checkpoints("trimix-dcs-surfaced").at(-1)!;
    // No recording runs out of gas, so the adapter has no reading of it.
    const unknown = { ...recorded, state: { ...recorded.state, gameOverReason: "OUT OF GAS" } };
    expect(() => diveStateFromLegacyCheckpoint(unknown, 23)).toThrow(/OUT OF GAS/);
  });

  it("ends a dive that surfaces with a ceiling deeper than 3 m on that tick", () => {
    const state = replayFrom("trimix-dcs-surfaced", "bottom-20min");
    const surfaced = checkpoints("trimix-dcs-surfaced").at(-1)!;
    expect(surfaced.planner.ceiling_m).toBeGreaterThan(3);
    // One second above the stop: nowhere near the timer's 60.
    expect(state.failure.dcsViolationS).toBe(1);
    expect(state.failure.reason).toBe("decompression-sickness");
  });
});
