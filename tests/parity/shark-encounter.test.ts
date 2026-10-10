import { describe, expect, it } from "vitest";

// Legacy's real src/sites.js, loaded as tests/parity/wreck-route.test.ts
// loads it, for the wreck's floorAt() and solidAt().
import legacySitesSource from "../../src/sites.js?raw";
import baselineFixture from "../fixtures/traces/baseline-v1.json";
import { floorUnder } from "../../src/sites/wreck-route";
import { wreckViewAround } from "../../src/render/camera";
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
    diveSite: string;
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

/** The checkpoints of shark-encounter-5m at which a shark swims in legacy. */
const SHARK_CHECKPOINTS = ["spawned", "contact-survived", "second-spawn", "shark-attack"];

/**
 * advanceShark over the recorded ticks with legacy's rolls, on `frame`: the
 * shark at each checkpoint, and the tick it attacked on. No tick runs after
 * an attack, as legacy's dive ends there.
 */
function replay(frame: SharkFrame): { sharks: Map<string, SharkState>; attackedAt: string | null } {
  const all = checkpoints();
  let shark = diveStateFromLegacyCheckpoint(all[0]!, 37).shark;
  const sharks = new Map([[all[0]!.checkpointId, shark]]);
  let attackedAt: string | null = null;
  for (const recorded of all.slice(1)) {
    recorded.trajectory.forEach((tick, index) => {
      if (tick.dtDive_min === 0 || attackedAt !== null) return;
      const roll = legacyRoll(recorded.checkpointId, index, recorded.trajectory.length);
      const step = advanceShark(shark, tick.depth_m, frame, seconds(tick.dtDive_min * 60), () => roll);
      shark = step.shark;
      if (step.attacked) attackedAt = `${recorded.checkpointId}, tick ${index + 1} of ${recorded.trajectory.length}`;
    });
    sharks.set(recorded.checkpointId, shark);
  }
  return { sharks, attackedAt };
}

describe("the shark encounter against the recorded legacy dive", () => {
  it("rolls, spawns, swims, tracks, passes and attacks as legacy does with the same rolls", () => {
    const all = checkpoints();
    const { sharks, attackedAt } = replay(FRAME);
    for (const recorded of all) {
      expectShark(sharks.get(recorded.checkpointId)!, recorded);
      const failed = recorded.state.gameOverReason !== null;
      expect(recorded.state.gameState).toBe(failed ? "gameover" : "diving");
    }
    // Only the last checkpoint is a game over, and the attack lands on its
    // last tick: not before, and no tick runs after it.
    expect(all.filter((recorded) => recorded.state.gameOverReason !== null).map((recorded) => recorded.checkpointId))
      .toEqual(["shark-attack"]);
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

  it("names every recorded checkpoint a shark swims at: shark-encounter-5m's four, on the reef", () => {
    const swimming = (baselineFixture.scenarios as unknown as { scenarioId: string; checkpoints: Checkpoint[] }[])
      .flatMap((scenario) =>
        scenario.checkpoints
          .filter((checkpoint) => checkpoint.state.shark.active !== null)
          .map((checkpoint) => `${scenario.scenarioId}/${checkpoint.checkpointId} ${checkpoint.state.diveSite}`),
      );
    expect(swimming).toEqual(SHARK_CHECKPOINTS.map((id) => `${SCENARIO}/${id} reef`));
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

// ---------------------------------------------------------------------------
// The two declared departures (docs/decisions.md, Deliberate departures,
// #219), written here as numbers, not read from src/render/camera.ts or
// src/sites/wreck-route.ts, so the client is checked against them rather
// than against itself.
// ---------------------------------------------------------------------------

/**
 * The wreck camera (#219, owner decision of 2026-10-07): it shows 58 m
 * across and looks 8 m ahead of the diver in the direction they face, held
 * inside the scene's 0..116 m. Mid-route, facing right, that is 29 - 8 m
 * behind and 29 + 8 m ahead; at the route's start, x 10, the bound at x 0
 * holds it 10 m behind and 58 - 10 m ahead. Legacy's recorded view is
 * 1000 px at 0.05 m a pixel with the diver centred: 25 m either way.
 */
const LED_VIEW = { leftM: 29 - 8, rightM: 29 + 8 };
const START_VIEW = { leftM: 10, rightM: 58 - 10 };
const LED_FRAME: SharkFrame = { ...FRAME, viewLeftM: LED_VIEW.leftM, viewRightM: LED_VIEW.rightM };

/**
 * The route's floors (#219), from the wreck the client draws (#199, #222):
 * the open water beside the wreck at 34 m; the bow stem's top at 24.5 m over
 * x 14..16; the hold's floor at 33.5 m, under the deck and in the bow
 * visor's opening behind the stem; the deck's top from 23 m at x 22 to 21 m
 * at x 82; the engine block's cylinder, 3.1 m about (87, 30.5). Legacy's
 * shark reads floorAt(), the wreck's seabed at 66 m from x -40 to 200
 * (src/sites.js), and swims through its structures.
 */
const ROUTE_FLOORS: readonly { x: number; depthM: number; floorM: number; where: string }[] = [
  { x: 10, depthM: 20, floorM: 34, where: "open water off the bow" },
  { x: 15, depthM: 30, floorM: 24.5, where: "over the bow stem" },
  { x: 19, depthM: 30, floorM: 33.5, where: "in the bow visor's opening" },
  { x: 50, depthM: 10, floorM: 23 + ((21 - 23) * (50 - 22)) / (82 - 22), where: "above the deck" },
  { x: 50, depthM: 28, floorM: 33.5, where: "in the hold, under the deck" },
  { x: 87, depthM: 26, floorM: 30.5 - 3.1, where: "on the engine block" },
  { x: 120, depthM: 30, floorM: 34, where: "open water past the stern" },
];
/** The shallowest floor of the route: the bow visor's top, 3.6 m above the deck's 23 m. */
const SHALLOWEST_ROUTE_FLOOR_M = 23 - 3.6;
const FLOOR_MARGIN_M = 0.5;

// MAX_DEPTH is src/constants.js's 300; the wreck's 66 m floor is under it.
const legacySites = new Function(
  "MAX_DEPTH",
  `var diveSite = "wreck";
${legacySitesSource}
return { floorAt: floorAt, solidAt: solidAt };`,
)(300) as { floorAt(x: number): number; solidAt(x: number, d: number): boolean };

describe("the client's departures from legacy's shark (#219 part 2)", () => {
  it("leads the view by the wreck camera's 8 m, where legacy centres it", () => {
    expect(wreckViewAround(50, 1).leftM).toBeCloseTo(LED_VIEW.leftM, 12);
    expect(wreckViewAround(50, 1).rightM).toBeCloseTo(LED_VIEW.rightM, 12);
    expect(wreckViewAround(10, 1)).toEqual(START_VIEW);
    expect(FRAME.viewLeftM).toBe(25);
    expect(FRAME.viewRightM).toBe(25);
  });

  it("with the camera's lead, the named checkpoints keep legacy's values but where the shark spawns 4 m nearer", () => {
    const legacyView = replay(FRAME);
    const led = replay(LED_FRAME);
    // Before a shark, nothing changes.
    for (const id of ["surface", "three-rolls"]) expectShark(led.sharks.get(id)!, at(id));
    // A shark heading right spawns 5 m beyond the left edge: 21 m behind the
    // diver, not 25, so 4 m nearer, and swims the same; its timer, depth,
    // heading, speed and passed are legacy's.
    for (const id of ["spawned", "second-spawn"]) {
      const shark = led.sharks.get(id)!;
      expect(shark.encounter!.offsetM, id).toBeCloseTo(-12.5 + (25 - 21), 9);
      expectShark({ ...shark, encounter: { ...shark.encounter!, offsetM: -12.5 } }, at(id));
    }
    // contact-survived runs five 1 s ticks, a third of a real second each:
    // 2.5 m at 7.5 m/s. From -8.5 the third tick is within 2 m (-1), the roll
    // of 0.5 spares the diver, and two ticks at 12 m/s (4 m) leave it at 7.
    const passed = led.sharks.get("contact-survived")!;
    expect(passed.encounter!.offsetM).toBeCloseTo(-8.5 + 3 * 2.5 + 2 * 4, 9);
    expectShark({ ...passed, encounter: { ...passed.encounter!, offsetM: 0 } }, at("contact-survived"));
    // gone runs nine more: legacy's leaves past 25 + 7.5 m; with the view
    // reaching 37 m ahead, the shark at 7 + 9 * 4 = 43 m is short of 44.5 m
    // and still swims, tracked down to the diver's 5 m (0.3 m a second).
    expect(at("gone").state.shark.active).toBeNull();
    const lingering = led.sharks.get("gone")!;
    expect(lingering.timerS).toBe(at("gone").state.shark.timer_s);
    expect(lingering.encounter!.offsetM).toBeCloseTo(7 + 9 * 4, 9);
    expect(lingering.encounter!.offsetM).toBeLessThan(LED_VIEW.rightM + 7.5);
    expect(lingering.encounter).toMatchObject({ depthM: 5, direction: 1, speedMps: 12, passed: true });
    // shark-attack: the third tick reaches contact, two ticks before legacy's
    // fifth, with 3 dive seconds off the timer and the shark tracked 3 * 0.3 m
    // down from 2.1 m.
    expect(legacyView.attackedAt).toBe("shark-attack, tick 5 of 5");
    expect(led.attackedAt).toBe("shark-attack, tick 3 of 5");
    const struck = led.sharks.get("shark-attack")!;
    expect(struck.timerS).toBeCloseTo(60 - 3, 9);
    expect(struck.encounter!.offsetM).toBeCloseTo(-8.5 + 3 * 2.5, 9);
    expect(struck.encounter!.depthM).toBeCloseTo(2.1 + 3 * 0.3, 9);
    expect(struck.encounter).toMatchObject({ direction: 1, speedMps: 7.5, passed: true });
  });

  it("keeps the shark above the route's floors, where legacy's swims over its 66 m seabed", () => {
    for (const { x, depthM, floorM, where } of ROUTE_FLOORS) {
      expect(floorUnder(x, depthM), where).toBeCloseTo(floorM, 9);
      expect(legacySites.floorAt(x), where).toBe(66);
    }
    // Legacy's stem is solid, and its shark's floor guard does not read it.
    expect(legacySites.solidAt(15, 30)).toBe(true);
    // Where it changes the depth: over the stem a shark tracking a diver at
    // 30 m is held at 24 m; off the bow one at 40 m is held at 33.5 m.
    // Legacy's floor guard holds neither.
    const deep = (offsetM: number, depthM: number, diverDepthM: number, floorAt: SharkFrame["floorAt"]) =>
      advanceShark(
        { timerS: seconds(60), encounter: { offsetM, depthM: metres(depthM), direction: 1, speedMps: 0.001, passed: true } },
        diverDepthM,
        { ...LED_FRAME, floorAt },
        seconds(0.001),
        () => 0.5,
      ).shark.encounter!.depthM;
    const fromRoute: SharkFrame["floorAt"] = (offsetM, depthM) => floorUnder(10 + offsetM, depthM);
    expect(deep(5, 30, 30, fromRoute)).toBeCloseTo(24.5 - FLOOR_MARGIN_M, 9);
    expect(deep(5, 30, 30, (offsetM) => legacySites.floorAt(10 + offsetM))).toBeCloseTo(30, 9);
    expect(deep(-5, 40, 34, fromRoute)).toBeCloseTo(34 - FLOOR_MARGIN_M, 9);
    // Above the deck, clear of it, nothing changes.
    expect(deep(40, 10, 10, fromRoute)).toBeCloseTo(10, 9);
  });

  it("reaches no recorded checkpoint with the route's floors: every recorded shark is shallower than all of them", () => {
    const depths = checkpoints().flatMap((recorded) =>
      recorded.state.shark.active ? [recorded.state.shark.active.depth_m] : [],
    );
    expect(depths).toHaveLength(SHARK_CHECKPOINTS.length);
    expect(Math.max(...depths) + FLOOR_MARGIN_M).toBeLessThan(SHALLOWEST_ROUTE_FLOOR_M);
    // Replayed over the route's floors, from the middle of the route, the
    // shark is legacy's at every checkpoint.
    const overRoute = replay({ ...FRAME, floorAt: (offsetM, depthM) => floorUnder(50 + offsetM, depthM) });
    for (const recorded of checkpoints()) expectShark(overRoute.sharks.get(recorded.checkpointId)!, recorded);
  });
});
