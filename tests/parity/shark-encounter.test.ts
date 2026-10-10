import { describe, expect, it } from "vitest";

import baselineFixture from "../fixtures/traces/baseline-v1.json";
import {
  diveStateFromLegacyCheckpoint,
  type LegacyTissueCheckpoint,
} from "../../src/app/legacy-dive-adapter";
import {
  SHARK_SPAWN_PROBABILITY,
  advanceDiveStep,
  advanceShark,
  type SharkFrame,
} from "../../src/core/dive-model";
import type { SharkState } from "../../src/core/dive-state";
import { nextRandom } from "../../src/core/rng";
import { metres, seconds } from "../../src/core/units";

// The shark encounter (#219) against the legacy client. Legacy rolls with
// Math.random, which the recording stubs with one value for every draw of
// a tick: 0.004 on the last tick of `spawned` and `second-spawn`, which
// spawns a shark heading right, 9.92 m above the diver; 0.2 through
// `shark-attack`, which attacks at contact; 0.5 everywhere else, which
// spawns nothing and survives contact. advanceShark is replayed tick by
// tick with the same rolls, at the depth legacy read back, and compared at
// every checkpoint: the roll timer's cadence, the spawn, the swim in real
// time, the depth tracking, contact, the exit past the view, and the attack
// on legacy's tick and not before.
//
// The model's own rolls come from its seeded random state, not legacy's
// stream, so only the deterministic parts and the outcome of a given roll
// can be compared with legacy.

interface Checkpoint extends LegacyTissueCheckpoint {
  checkpointId: string;
  state: LegacyTissueCheckpoint["state"] & {
    gameState: string;
    gameOverReason: string | null;
    diverX_m: number;
    shark: NonNullable<LegacyTissueCheckpoint["state"]["shark"]>;
  };
  trajectory: { depth_m: number; dtDive_min: number }[];
}

const SCENARIO = "shark-encounter-5m";
const eps = baselineFixture.tolerances.absoluteEpsilon.default;
// The recording runs updateDiving() at TIME_ACCELERATION (3) on legacy's
// open-water geometry, where floorAt() is MAX_DEPTH, with the diver still
// and the view pinned 1000 px wide.
const FRAME: SharkFrame = {
  timeMultiplier: 3,
  diverVelocityMps: 0,
  viewLeftM: 1000 * 0.5 * 0.05,
  viewRightM: 1000 * (1 - 0.5) * 0.05,
  floorAt: () => 300,
  noShark: false,
};

function checkpoints(): Checkpoint[] {
  const scenario = (baselineFixture.scenarios as unknown as { scenarioId: string; checkpoints: Checkpoint[] }[])
    .find((entry) => entry.scenarioId === SCENARIO);
  if (!scenario) throw new Error(`Missing golden scenario: ${SCENARIO}`);
  return scenario.checkpoints;
}

function at(id: string): Checkpoint {
  return checkpoints().find((entry) => entry.checkpointId === id)!;
}

/** The value legacy's stub gave every draw of this tick. */
function legacyRoll(checkpointId: string, tick: number, ticks: number): number {
  if (checkpointId === "shark-attack") return 0.2;
  if ((checkpointId === "spawned" || checkpointId === "second-spawn") && tick === ticks - 1) return 0.004;
  return 0.5;
}

function expectShark(shark: SharkState, recorded: Checkpoint): void {
  const where = `${SCENARIO}/${recorded.checkpointId}`;
  const legacy = recorded.state.shark;
  expect(Math.abs(shark.timerS - legacy.timer_s), `timer at ${where}`).toBeLessThanOrEqual(eps);
  if (legacy.active === null) {
    expect(shark.encounter, `shark at ${where}`).toBeNull();
    return;
  }
  const encounter = shark.encounter!;
  expect(encounter, `shark at ${where}`).not.toBeNull();
  expect(Math.abs(encounter.offsetM - (legacy.active.x_m - recorded.state.diverX_m)), `offset at ${where}`)
    .toBeLessThanOrEqual(eps);
  expect(Math.abs(encounter.depthM - legacy.active.depth_m), `depth at ${where}`).toBeLessThanOrEqual(eps);
  expect(encounter.direction, `heading at ${where}`).toBe(legacy.active.direction);
  expect(encounter.speedMps, `speed at ${where}`).toBe(legacy.active.speed_mps);
  expect(encounter.passed, `passed at ${where}`).toBe(legacy.active.passed);
}

describe("the shark encounter against the recorded legacy dive", () => {
  it("rolls, spawns, swims, tracks, passes and attacks as legacy does with the same rolls", () => {
    const all = checkpoints();
    let shark = diveStateFromLegacyCheckpoint(all[0]!, 37).shark;
    expectShark(shark, all[0]!);
    let attackedAt: string | null = null;
    for (const recorded of all.slice(1)) {
      recorded.trajectory.forEach((tick, index) => {
        if (tick.dtDive_min === 0) return;
        expect(attackedAt, `a tick after the attack at ${attackedAt}`).toBeNull();
        const roll = legacyRoll(recorded.checkpointId, index, recorded.trajectory.length);
        const step = advanceShark(shark, tick.depth_m, FRAME, seconds(tick.dtDive_min * 60), () => roll);
        shark = step.shark;
        if (step.attacked) attackedAt = `${recorded.checkpointId}, tick ${index + 1} of ${recorded.trajectory.length}`;
      });
      expectShark(shark, recorded);
      const failed = recorded.state.gameOverReason !== null;
      expect(recorded.state.gameState).toBe(failed ? "gameover" : "diving");
      expect(attackedAt !== null, `attacked by ${recorded.checkpointId}`).toBe(failed);
    }
    const last = all.at(-1)!;
    expect(attackedAt).toBe(`shark-attack, tick ${last.trajectory.length} of ${last.trajectory.length}`);
  });

  it("exercises every branch of legacy's encounter", () => {
    // Guards the replay against a recording that no longer does.
    expect(at("three-rolls").state.shark).toEqual({ timer_s: 39, active: null });
    expect(at("spawned").state.shark.active).toMatchObject({ direction: 1, passed: false, speed_mps: 7.5 });
    // Spawned 9.92 m above a diver at 5 m: clamped to the surface, then tracked down.
    expect(at("spawned").state.shark.active!.depth_m).toBeCloseTo(0.3 * 7, 9);
    expect(at("contact-survived").state.shark.active).toMatchObject({ passed: true, speed_mps: 12 });
    expect(at("gone").state.shark.active).toBeNull();
    expect(at("shark-attack").state.shark.active).toMatchObject({ passed: true, speed_mps: 7.5 });
    expect(at("shark-attack").state.gameOverReason).toBe("SHARK ATTACK");
  });

  it("counts legacy's roll timer in the model, drawing one roll a minute from the random state", () => {
    // Up to three-rolls nothing spawns: legacy's rolls were 0.5, and seed 37's
    // first three are above the 0.005 a spawn needs.
    let state = diveStateFromLegacyCheckpoint(at("surface"), 37);
    let random = state.randomState;
    for (let roll = 0; roll < 3; roll++) {
      const sample = nextRandom(random);
      expect(sample.value).toBeGreaterThanOrEqual(SHARK_SPAWN_PROBABILITY);
      random = sample.state;
    }
    for (const tick of at("three-rolls").trajectory) {
      state = advanceDiveStep(state, { depthM: metres(tick.depth_m), shark: FRAME }, seconds(tick.dtDive_min * 60));
    }
    expect(state.shark.timerS).toBeCloseTo(at("three-rolls").state.shark.timer_s, 9);
    expect(state.shark.encounter).toBeNull();
    expect(state.randomState).toBe(random);
    expect(state.failure.reason).toBeNull();
  });

  it("reads legacy's game over as a shark attack, which goes no further", () => {
    const recorded = at("shark-attack");
    const state = diveStateFromLegacyCheckpoint(recorded, 37);
    expect(state.failure.reason).toBe("shark-attack");
    expectShark(state.shark, recorded);
    expect(state.events.at(-1)).toMatchObject({ type: "failure", failureReason: "shark-attack" });
    expect(advanceDiveStep(state, { depthM: metres(5), shark: FRAME }, seconds(1))).toBe(state);
  });
});
