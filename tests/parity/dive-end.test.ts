import { describe, expect, it } from "vitest";

import baselineFixture from "../fixtures/traces/baseline-v1.json";
import {
  diveStateFromLegacyCheckpoint,
  logEntriesFromLegacyEvents,
  type LegacyTissueCheckpoint,
} from "../../src/app/legacy-dive-adapter";
import { advanceDiveStep } from "../../src/core/dive-model";
import type { DiveState } from "../../src/core/dive-state";
import { metres, seconds } from "../../src/core/units";

// The end of a dive at the surface (#199) against the legacy client: the air
// dive's ascent surfaces it on its last tick, where legacy switches to its
// post-dive screen and logs the safety stop it skipped. Replayed tick by tick
// from the surface, breathing its own cylinder, as the dive-log replay does.
// The scripted ascent's fast-ascent entries are not legacy's (see
// tests/parity/dive-log.test.ts), so only the skipped stop is compared.

interface Checkpoint extends LegacyTissueCheckpoint {
  checkpointId: string;
  state: LegacyTissueCheckpoint["state"] & { gameState: string };
  events: { t: number; kind: string; value: number }[];
  trajectory: { depth_m: number; dtDive_min: number }[];
}

const eps = baselineFixture.tolerances.absoluteEpsilon;

function checkpoints(scenarioId: string): Checkpoint[] {
  const scenario = (baselineFixture.scenarios as unknown as { scenarioId: string; checkpoints: Checkpoint[] }[])
    .find((entry) => entry.scenarioId === scenarioId);
  if (!scenario) throw new Error(`Missing golden scenario: ${scenarioId}`);
  return scenario.checkpoints;
}

const skippedStops = (entries: readonly { kind: string; elapsedTimeS: number; value: number }[]) =>
  entries.filter((entry) => entry.kind === "safety-stop-skipped");

describe("the end of a dive against the recorded legacy dives", () => {
  it("ends the air dive at the surface on legacy's tick, logging the skipped safety stop", () => {
    const all = checkpoints("air-18m-30min");
    let state: DiveState = diveStateFromLegacyCheckpoint(all[0]!, 17);
    for (const recorded of all.slice(1)) {
      const ticks = recorded.trajectory.filter((tick) => tick.dtDive_min > 0);
      ticks.forEach((tick, index) => {
        expect(state.completed, `completed before tick ${index} of ${recorded.checkpointId}`).toBe(false);
        state = advanceDiveStep(
          state,
          { depthM: metres(tick.depth_m), gradientFactorHighPercent: 75 },
          seconds(tick.dtDive_min * 60),
        );
      });
      const where = recorded.checkpointId;
      expect(state.completed, `completed at ${where}`).toBe(recorded.state.gameState === "post-dive");
      const expected = skippedStops(logEntriesFromLegacyEvents(recorded.events));
      const actual = skippedStops(state.log.entries);
      expect(actual.length, `skipped stops at ${where}`).toBe(expected.length);
      actual.forEach((entry, index) => {
        expect(Math.abs(entry.elapsedTimeS - expected[index]!.elapsedTimeS) / 60).toBeLessThanOrEqual(eps.default);
        expect(entry.value).toBe(expected[index]!.value);
      });
    }
    // Guards the comparison against a fixture that no longer ends this way.
    expect(all.at(-1)!.state.gameState).toBe("post-dive");
    expect(state.completed).toBe(true);
    expect(skippedStops(state.log.entries)).toHaveLength(1);
    expect(state.log.entries.at(-1)?.kind).toBe("safety-stop-skipped");
    expect(state.failure.reason).toBeNull();
  });

  it("reads legacy's post-dive state as a completed dive", () => {
    const surfaced = checkpoints("air-18m-30min").at(-1)!;
    const state = diveStateFromLegacyCheckpoint(surfaced, 17);
    expect(state.completed).toBe(true);
    expect(state.log.entries.at(-1)).toMatchObject({ kind: "safety-stop-skipped", value: 0 });
    expect(advanceDiveStep(state, { depthM: metres(5) }, seconds(1))).toBe(state);
  });
});
