import { describe, expect, it } from "vitest";

import baselineFixture from "../fixtures/traces/baseline-v1.json";
import {
  diveStateFromLegacyCheckpoint,
  type LegacyTissueCheckpoint,
} from "../../src/app/legacy-dive-adapter";
import {
  NARCOSIS_FAILURE_SECONDS,
  NARCOSIS_KO_INDEX,
  advanceDiveStep,
  closedCircuit,
  openCircuit,
} from "../../src/core/dive-model";
import { createGasMix, type BreathingSource, type DiveState } from "../../src/core/dive-state";
import { metres, seconds } from "../../src/core/units";

// Nitrogen narcosis (#189) against the legacy client. narcosis-air-65m holds
// air at 65 m until the narcosis index passes 0.95 and the KO timer counts,
// climbs to 45 m for 10 s, which takes the index back under 0.95 and resets
// the timer, and returns to 65 m until the timer ends the dive. It is
// replayed tick by tick at the depth legacy read back, and the index and the
// timer are compared at every checkpoint; the dive must end on legacy's
// tick and not before. The index is also compared at every checkpoint of the
// other recordings that breathe one gas throughout, from the surface on.
//
// The index is an explicit Euler step per tick, so it depends on the tick
// length: the replays use legacy's own ticks, as recorded.

interface Checkpoint extends LegacyTissueCheckpoint {
  checkpointId: string;
  state: LegacyTissueCheckpoint["state"] & {
    narcosisIndex: number;
    gameState: string;
    gameOverReason: string | null;
    debrief: { narcosisKO_s: number };
  };
  trajectory: { depth_m: number; dtDive_min: number }[];
}

const LEGACY_REASON = "NITROGEN NARCOSIS — UNCONSCIOUSNESS";
const eps = baselineFixture.tolerances.absoluteEpsilon;
const AIR = openCircuit(createGasMix(0.21, 0));
const TRIMIX = openCircuit(createGasMix(0.21, 0.35));
const NITROX_50 = openCircuit(createGasMix(0.5, 0));

function checkpoints(scenarioId: string): Checkpoint[] {
  const scenario = (baselineFixture.scenarios as unknown as { scenarioId: string; checkpoints: Checkpoint[] }[])
    .find((entry) => entry.scenarioId === scenarioId);
  if (!scenario) throw new Error(`Missing golden scenario: ${scenarioId}`);
  return scenario.checkpoints;
}

/**
 * Replays every checkpoint after `startId` (the first when null) tick by tick, breathing
 * `breathingFor(checkpointId)`, and checks the index at each checkpoint
 * with `atCheckpoint` for anything more.
 */
function replay(
  scenarioId: string,
  startId: string | null,
  breathingFor: (checkpointId: string) => BreathingSource,
  atCheckpoint: (state: DiveState, recorded: Checkpoint, ticksLeft: number) => void = () => {},
): DiveState {
  const all = checkpoints(scenarioId);
  const startIndex = startId === null ? 0 : all.findIndex((entry) => entry.checkpointId === startId);
  let state = diveStateFromLegacyCheckpoint(all[startIndex]!, 37);
  expect(state.narcosisIndex).toBe(all[startIndex]!.state.narcosisIndex);
  for (const recorded of all.slice(startIndex + 1)) {
    const where = `${scenarioId}/${recorded.checkpointId}`;
    const breathing = breathingFor(recorded.checkpointId);
    recorded.trajectory.forEach((tick, index) => {
      if (tick.dtDive_min === 0) return;
      atCheckpoint(state, recorded, recorded.trajectory.length - index);
      state = advanceDiveStep(state, { depthM: metres(tick.depth_m), breathing }, seconds(tick.dtDive_min * 60));
    });
    expect(Math.abs(state.narcosisIndex - recorded.state.narcosisIndex), `narcosis index at ${where}`)
      .toBeLessThanOrEqual(eps.default);
    atCheckpoint(state, recorded, 0);
  }
  return state;
}

/** The KO timer and the failure at each narcosis-air-65m checkpoint, and the dive going on before its last tick. */
function checkKo(state: DiveState, recorded: Checkpoint, ticksLeft: number): void {
  const where = `narcosis-air-65m/${recorded.checkpointId}`;
  const failed = recorded.state.gameOverReason !== null;
  if (ticksLeft > 0) {
    expect(state.failure.reason, `${ticksLeft} ticks before ${where}`).toBeNull();
    return;
  }
  expect(Math.abs(state.failure.narcosisKoS - recorded.state.debrief.narcosisKO_s), `KO timer at ${where}`)
    .toBeLessThanOrEqual(eps.default);
  expect(state.failure.reason, `failure at ${where}`).toBe(failed ? "nitrogen-narcosis" : null);
  expect(recorded.state.gameState, `legacy's state at ${where}`).toBe(failed ? "gameover" : "diving");
  if (failed) expect(recorded.state.gameOverReason).toBe(LEGACY_REASON);
}

describe("nitrogen narcosis against the recorded legacy dives", () => {
  it("counts the KO timer past 0.95, resets it below, and ends the dive on legacy's tick", () => {
    const state = replay("narcosis-air-65m", "surface", () => AIR, checkKo);
    const failed = checkpoints("narcosis-air-65m").at(-1)!;
    expect(state.failure.narcosisKoS).toBeGreaterThanOrEqual(NARCOSIS_FAILURE_SECONDS);
    expect(state.events.at(-1)).toMatchObject({ type: "failure", failureReason: "nitrogen-narcosis" });
    // The two clocks sum the same ticks in a different unit (minutes against
    // seconds), so they differ in the last bits only.
    expect(state.events.at(-1)?.elapsedTimeS).toBeCloseTo(failed.state.diveTime_min * 60, 9);
  });

  it("exercises every branch of legacy's timer", () => {
    // Guards the replay against a recording that no longer does.
    const at = (id: string) => checkpoints("narcosis-air-65m").find((entry) => entry.checkpointId === id)!.state;
    expect(at("bottom-4min").narcosisIndex).toBeLessThan(NARCOSIS_KO_INDEX);
    expect(at("ko-counting").narcosisIndex).toBeGreaterThanOrEqual(NARCOSIS_KO_INDEX);
    expect(at("ko-counting").debrief.narcosisKO_s).toBeGreaterThan(0);
    expect(at("ascended-45m").narcosisIndex).toBeLessThan(at("ko-counting").narcosisIndex);
    expect(at("ascended-45m").debrief.narcosisKO_s).toBe(0);
    expect(at("narcosis").gameOverReason).toBe(LEGACY_REASON);
  });

  it("continues legacy's index and timer from a checkpoint and fails on the same tick", () => {
    const state = replay("narcosis-air-65m", "ko-counting", () => AIR, checkKo);
    expect(state.failure.reason).toBe("nitrogen-narcosis");
  });

  it("reads legacy's game over as a dive narcosis ended, which goes no further", () => {
    const recorded = checkpoints("narcosis-air-65m").at(-1)!;
    const state = diveStateFromLegacyCheckpoint(recorded, 37);
    expect(state.failure.reason).toBe("nitrogen-narcosis");
    expect(state.narcosisIndex).toBe(recorded.state.narcosisIndex);
    expect(state.failure.narcosisKoS).toBe(recorded.state.debrief.narcosisKO_s);
    expect(state.events.at(-1)).toMatchObject({ type: "failure", failureReason: "nitrogen-narcosis" });
    expect(advanceDiveStep(state, { depthM: metres(65) }, seconds(1))).toBe(state);
  });

  it.each([
    ["air-18m-30min", () => AIR],
    ["trimix-dcs-above-stop", () => TRIMIX],
    ["trimix-dcs-surfaced", () => TRIMIX],
    ["wreck-thirds", () => TRIMIX],
    ["buoyancy-vent-inflate-12m", () => AIR],
    ["barotrauma-runaway-ascent-30m", () => AIR],
    // The cylinder switch is a key read in a zero-length tick; the three
    // minutes after it are on the 50 %.
    ["tec-switch-21m", (id: string) => (id === "deco-gas-3min" ? NITROX_50 : TRIMIX)],
    // The loop held at its 1.3 bar setpoint on Tx 15/45, as the tissue
    // parity replays it.
    ["ccr-30m-30min", () => closedCircuit(1.3, createGasMix(0.15, 0.45))],
  ] as [string, (id: string) => BreathingSource][])("matches legacy's index at every checkpoint of %s", (scenarioId, breathingFor) => {
    replay(scenarioId, null, breathingFor);
  });
});
