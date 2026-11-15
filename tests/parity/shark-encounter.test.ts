import { describe, expect, it } from "vitest";

// Legacy's real src/sites.js, loaded from its source, for the wreck's
// floorAt() and solidAt().
import legacySitesSource from "../../src/sites.js?raw";
import baselineFixture from "../fixtures/traces/baseline-v1.json";
import { openBetween, sharkWaterAt } from "../../src/sites/shark-water";
import { WRECK_SITE } from "../../src/sites/wreck-site";
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
  waterAt: () => ({ shallowestM: 0, deepestM: 300 - 0.5 }),
  openTo: () => true,
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
// #219), the camera's written here as numbers, not read from
// src/render/camera.ts, and the shark's water checked against legacy's own
// solidAt(), so the client is checked against them rather than against
// itself.
// ---------------------------------------------------------------------------

/**
 * The wreck camera (#219, owner decision of 2026-10-07): it shows 58 m
 * across and looks 8 m ahead of the diver in the direction they face, held
 * inside the site's -40..200 m and 10 m past either end (#240). Facing
 * right, that is 29 - 8 m behind and 29 + 8 m ahead, at the route's start,
 * x 10, as well; near x -40 the bound at x -50 holds it, 15 m behind at
 * x -35 facing left and 58 - 15 m ahead. Legacy's recorded view is
 * 1000 px at 0.05 m a pixel with the diver centred: 25 m either way.
 */
const LED_VIEW = { leftM: 29 - 8, rightM: 29 + 8 };
const BOUND_VIEW = { leftM: 15, rightM: 58 - 15 };
const LED_FRAME: SharkFrame = { ...FRAME, viewLeftM: LED_VIEW.leftM, viewRightM: LED_VIEW.rightM };

/**
 * The shark's water among legacy's structures (#219, #240 PR 3b; owner
 * decision of 2026-11-15): it holds 0.5 m above the nearest structure below
 * it and below the nearest above it. Legacy's shark reads floorAt(), the
 * wreck's seabed at 66 m from x -40 to 200 (src/sites.js), and swims through
 * its structures. Named places, with the depths the client holds there,
 * from legacy's structures: off the bow; in the vehicle deck under the main
 * deck at x 50; in the crew deck there; in the main hatch, x 78 to 92, under
 * the superstructure's deck at 19 m and over the hull's bottom at 65 m; met
 * by the bow's side, x 14 to 16, at 30 m.
 */
const STRUCTURE_WATER: readonly { x: number; depthM: number; shallowestM: number; deepestM: number; where: string }[] = [
  { x: 0, depthM: 30, shallowestM: 0, deepestM: 65.5, where: "off the bow" },
  { x: 50, depthM: 33, shallowestM: 28.5, deepestM: 38.5, where: "in the vehicle deck" },
  { x: 50, depthM: 42, shallowestM: 40.5, deepestM: 44.5, where: "in the crew deck" },
  { x: 85, depthM: 50, shallowestM: 19.5, deepestM: 64.5, where: "in the main hatch" },
  { x: 15, depthM: 30, shallowestM: 0, deepestM: 27.5, where: "over the bow's side" },
];
/** The shallowest structure of legacy's wreck: its mast's top, 10 m at x 75 to 76. */
const SHALLOWEST_STRUCTURE_M = 10;
const FLOOR_MARGIN_M = 0.5;

// MAX_DEPTH is src/constants.js's 300; the wreck's 66 m floor is under it.
const legacySites = new Function(
  "MAX_DEPTH",
  `var diveSite = "wreck";
${legacySitesSource}
return { floorAt: floorAt, solidAt: solidAt };`,
)(300) as { floorAt(x: number): number; solidAt(x: number, d: number): boolean };

/** The shark's water and its reach to the diver among legacy's structures, for a diver at diverX. */
function amongTheStructures(diverX: number): Pick<SharkFrame, "waterAt" | "openTo"> {
  return {
    waterAt: (fromOffsetM, fromDepthM, toOffsetM) =>
      sharkWaterAt(WRECK_SITE, diverX + fromOffsetM, fromDepthM, diverX + toOffsetM, FLOOR_MARGIN_M),
    openTo: (offsetM, depthM, diverDepthM) => openBetween(WRECK_SITE, diverX + offsetM, depthM, diverX, diverDepthM),
  };
}

/** Legacy's: its floor guard over its floorAt(shark.x), and contact on distance alone. */
function overTheSeabed(diverX: number): Pick<SharkFrame, "waterAt" | "openTo"> {
  return {
    waterAt: (_fromOffsetM, _fromDepthM, toOffsetM) => ({
      shallowestM: 0,
      deepestM: legacySites.floorAt(diverX + toOffsetM) - FLOOR_MARGIN_M,
    }),
    openTo: () => true,
  };
}

/**
 * A shark swum from `encounter` in steps of 0.3 dive seconds at 3 to one
 * (0.75 m at 7.5 m/s), the diver still at diverDepthM, in `world`, with the
 * camera's led view: every step's shark, and how many contact rolls it drew.
 */
function swimBy(
  diverDepthM: number,
  encounter: NonNullable<SharkState["encounter"]>,
  world: Pick<SharkFrame, "waterAt" | "openTo">,
  steps: number,
): { sharks: (SharkState["encounter"])[]; draws: number } {
  let shark: SharkState = { timerS: seconds(1e6), encounter };
  const sharks: SharkState["encounter"][] = [];
  let draws = 0;
  for (let step = 0; step < steps && shark.encounter; step += 1) {
    shark = advanceShark(shark, diverDepthM, { ...LED_FRAME, ...world }, seconds(0.3), () => {
      draws += 1;
      return 0.5;
    }).shark;
    sharks.push(shark.encounter);
  }
  return { sharks, draws };
}

describe("the client's departures from legacy's shark (#219 part 2)", () => {
  it("leads the view by the wreck camera's 8 m, where legacy centres it", () => {
    expect(wreckViewAround(50, 1).leftM).toBeCloseTo(LED_VIEW.leftM, 12);
    expect(wreckViewAround(50, 1).rightM).toBeCloseTo(LED_VIEW.rightM, 12);
    expect(wreckViewAround(10, 1)).toEqual(LED_VIEW);
    expect(wreckViewAround(-35, -1)).toEqual(BOUND_VIEW);
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

  it("keeps the shark between the structures above and below it, where legacy's swims over its 66 m seabed", () => {
    const water = (x: number, depthM: number) => sharkWaterAt(WRECK_SITE, x, depthM, x, FLOOR_MARGIN_M);
    for (const { x, depthM, shallowestM, deepestM, where } of STRUCTURE_WATER) {
      expect(water(x, depthM), where).toEqual({ shallowestM, deepestM });
      expect(legacySites.floorAt(x), where).toBe(66);
      // Legacy has a structure 0.5 m below the deepest depth, or its seabed,
      // and one 0.5 m above the shallowest where that is not the surface.
      const onTheSeabed = deepestM + FLOOR_MARGIN_M === legacySites.floorAt(x);
      expect(onTheSeabed || legacySites.solidAt(x, deepestM + FLOOR_MARGIN_M), where).toBe(true);
      if (shallowestM > 0) expect(legacySites.solidAt(x, shallowestM - FLOOR_MARGIN_M), where).toBe(true);
    }
    // Legacy's bow is solid at 30 m, and its shark's floor guard does not read it.
    expect(legacySites.solidAt(15, 30)).toBe(true);
    // Where it changes the depth: a shark at 27.9 m crossing the bow's side
    // is held 0.5 m above its top at 28 m; one in the vehicle deck is held
    // under the main deck tracking a diver above it, and over the vehicle
    // deck's floor tracking one below it. Legacy's floor guard holds none.
    const deep = (fromX: number, toX: number, depthM: number, diverDepthM: number, waterAt: SharkFrame["waterAt"]) =>
      advanceShark(
        {
          timerS: seconds(60),
          encounter: {
            offsetM: fromX - 10,
            depthM: metres(depthM),
            direction: toX < fromX ? -1 : 1,
            speedMps: 3 * Math.abs(toX - fromX),
            passed: true,
          },
        },
        diverDepthM,
        { ...LED_FRAME, waterAt },
        seconds(1),
        () => 0.5,
      ).shark.encounter!.depthM;
    const fromStructures: SharkFrame["waterAt"] = (fromOffsetM, fromDepthM, toOffsetM) =>
      sharkWaterAt(WRECK_SITE, 10 + fromOffsetM, fromDepthM, 10 + toOffsetM, FLOOR_MARGIN_M);
    const fromSeabed: SharkFrame["waterAt"] = (_fromOffsetM, _fromDepthM, toOffsetM) => ({
      shallowestM: 0,
      deepestM: legacySites.floorAt(10 + toOffsetM) - FLOOR_MARGIN_M,
    });
    expect(deep(13.9, 14.1, 27.9, 27.9, fromStructures)).toBeCloseTo(28 - FLOOR_MARGIN_M, 9);
    expect(deep(13.9, 14.1, 27.9, 27.9, fromSeabed)).toBeCloseTo(27.9, 9);
    expect(deep(50, 50, 28.6, 20, fromStructures)).toBeCloseTo(28 + FLOOR_MARGIN_M, 9);
    expect(deep(50, 50, 28.6, 20, fromSeabed)).toBeCloseTo(28.3, 9);
    expect(deep(50, 50, 38.4, 42, fromStructures)).toBeCloseTo(39 - FLOOR_MARGIN_M, 9);
    expect(deep(50, 50, 38.4, 42, fromSeabed)).toBeCloseTo(38.7, 9);
    // Off the bow, over the seabed alone, it is legacy's.
    expect(deep(0, 0, 65.4, 66, fromStructures)).toBeCloseTo(deep(0, 0, 65.4, 66, fromSeabed), 12);
  });

  it("holds the shark 0.5 m from the first depths legacy's solidAt finds solid below and above it", () => {
    // Over a grid of the wreck's water in legacy's solidAt, the deepest a
    // shark staying in its column holds is 0.5 m above the first solid depth
    // below it, or legacy's floorAt; the shallowest 0.5 m below the first
    // above it, or the surface.
    const firstSolid = (x: number, fromM: number, toM: number): number | null => {
      const steps = Math.ceil(Math.abs(toM - fromM) / 0.05);
      if (steps === 0) return null;
      let clear = fromM;
      for (let k = 1; k <= steps; k += 1) {
        const d = fromM + ((toM - fromM) * k) / steps;
        if (legacySites.solidAt(x, d)) {
          let solid = d;
          for (let i = 0; i < 60; i += 1) {
            const middle = (clear + solid) / 2;
            if (legacySites.solidAt(x, middle)) solid = middle;
            else clear = middle;
          }
          return solid;
        }
        clear = d;
      }
      return null;
    };
    let checked = 0;
    for (let x = -40; x <= 200; x += 5.5) {
      for (let d = 0.25; d < 66; d += 1.5) {
        if (legacySites.solidAt(x, d)) continue;
        const floorM = legacySites.floorAt(x);
        const below = firstSolid(x, d, floorM) ?? floorM;
        const above = firstSolid(x, d, 0);
        const held = sharkWaterAt(WRECK_SITE, x, d, x, FLOOR_MARGIN_M)!;
        expect(held.deepestM, `${x}, ${d}`).toBeCloseTo(below - FLOOR_MARGIN_M, 6);
        expect(held.shallowestM, `${x}, ${d}`).toBeCloseTo(above === null ? 0 : above + FLOOR_MARGIN_M, 6);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(1500);
  });

  it("turns away where a structure stands in its way at its depth, where legacy's swims on through it", () => {
    // Legacy's full bulkhead at x 56 is solid from the crew deck's floor to
    // the lower deck's, and its bow's side at x 15 from 28 m to the seabed.
    for (let d = 45; d <= 59; d += 0.1) expect(legacySites.solidAt(56.5, d), `56.5, ${d}`).toBe(true);
    for (let d = 28; d <= 66; d += 0.1) expect(legacySites.solidAt(15, d), `15, ${d}`).toBe(true);
    const at49 = { depthM: metres(49), direction: 1 as const, speedMps: 7.5, passed: false };
    // In view, 1 m past a diver in the lower deck at x 54.5: legacy's swims
    // on to 1.75 m past and rolls contact; the client's turns where it is,
    // passed, and rolls none as it swims back past the diver.
    const legacy = swimBy(49, { ...at49, offsetM: 1 }, overTheSeabed(54.5), 12);
    const client = swimBy(49, { ...at49, offsetM: 1 }, amongTheStructures(54.5), 12);
    expect(legacy.sharks[0]).toMatchObject({ offsetM: 1.75, depthM: 49, direction: 1, passed: true });
    expect(client.sharks[0]).toMatchObject({ offsetM: 1, depthM: 49, direction: -1, passed: true, speedMps: 7.5 });
    expect(legacy.draws).toBe(1);
    expect(client.draws).toBe(0);
    for (const shark of client.sharks) expect(legacySites.solidAt(54.5 + shark!.offsetM, shark!.depthM)).toBe(false);
    expect(client.sharks.at(-1)!.offsetM).toBeCloseTo(1 - 11 * 0.75, 9);
    // Heading back at 45.5 m ahead of a diver at x 12, beyond the 44.5 m
    // where a shark leaves the view, it is gone there, unseen; legacy's,
    // heading left, swims on.
    const back = { ...at49, offsetM: 45.5, direction: -1 as const };
    expect(swimBy(49, back, amongTheStructures(12), 1).sharks).toEqual([null]);
    expect(swimBy(49, back, overTheSeabed(12), 1).sharks[0]!.offsetM).toBeCloseTo(44.75, 9);
    // Forward in the crew deck at 42 m, at the bow's side.
    const forward = { offsetM: -3.6, depthM: metres(42), direction: -1 as const, speedMps: 7.5, passed: false };
    expect(swimBy(42, forward, amongTheStructures(20), 1).sharks[0]).toMatchObject({ offsetM: -3.6, direction: 1 });
    expect(swimBy(42, forward, overTheSeabed(20), 1).sharks[0]!.offsetM).toBeCloseTo(-4.35, 9);
  });

  it("rolls no contact through a deck, where legacy's rolls on distance alone", () => {
    // A diver resting on the main deck at x 30, 26.7 m; a shark under it at
    // 28.5 m, 2.25 m aft, heading forward. Legacy's deck is solid between them.
    expect(legacySites.solidAt(30.75, 27.5)).toBe(true);
    const under = { offsetM: 2.25, depthM: metres(28.5), direction: -1 as const, speedMps: 7.5, passed: false };
    const legacy = swimBy(26.7, under, overTheSeabed(30), 8);
    const client = swimBy(26.7, under, amongTheStructures(30), 8);
    // At 1.5 m across and 1.71 m in depth legacy rolls; the client, held
    // under the deck at 28.5 m, does not, and swims on unpassed.
    expect(legacy.sharks[0]!.offsetM).toBeCloseTo(1.5, 9);
    expect(legacy.sharks[0]!.depthM).toBeCloseTo(28.5 - 0.09, 9);
    expect(legacy.draws).toBe(1);
    expect(client.sharks[0]).toMatchObject({ depthM: 28.5, passed: false });
    expect(client.draws).toBe(0);
  });

  it("draws no contact by the bow where legacy's draws none: the shark is never lifted over the bow's side", () => {
    // A diver at the bow, x 15, 27.5 m, over its side; a shark spawned
    // heading right 26 m behind at 36 m, tracking up 0.09 m a step. Legacy's
    // passes 5.4 m under the diver; the client's meets the side at x 14, at
    // 33 m, and turns away there.
    const spawned = { offsetM: -26, depthM: metres(36), direction: 1 as const, speedMps: 7.5, passed: false };
    const legacy = swimBy(27.5, spawned, overTheSeabed(15), 80);
    const client = swimBy(27.5, spawned, amongTheStructures(15), 80);
    expect(legacy.draws).toBe(0);
    expect(client.draws).toBe(0);
    const nearest = legacy.sharks.filter((shark) => Math.abs(shark!.offsetM) < 2);
    expect(nearest.length).toBeGreaterThan(0);
    for (const shark of nearest) expect(Math.abs(shark!.depthM - 27.5)).toBeGreaterThan(5);
    const turned = client.sharks.findIndex((shark) => shark!.direction === -1);
    expect(15 + client.sharks[turned]!.offsetM).toBeGreaterThan(14 - 0.75);
    expect(15 + client.sharks[turned]!.offsetM).toBeLessThan(14);
    expect(client.sharks[turned]!.depthM).toBeCloseTo(33, 0);
    // It never jumps: at most its tracking, 0.09 m a step, until it leaves past the view.
    const swum = client.sharks.filter((shark) => shark !== null);
    expect(swum.length).toBeLessThan(client.sharks.length);
    for (let step = 1; step < swum.length; step += 1) {
      expect(Math.abs(swum[step]!.depthM - swum[step - 1]!.depthM)).toBeLessThanOrEqual(0.09 + 1e-9);
    }
  });

  it("reaches no recorded checkpoint with the structures: every recorded shark is above all of them", () => {
    const depths = checkpoints().flatMap((recorded) =>
      recorded.state.shark.active ? [recorded.state.shark.active.depth_m] : [],
    );
    expect(depths).toHaveLength(SHARK_CHECKPOINTS.length);
    expect(Math.max(...depths) + FLOOR_MARGIN_M).toBeLessThan(SHALLOWEST_STRUCTURE_M);
    expect(Math.min(...WRECK_SITE.structures.map((w) => w.dTop))).toBe(SHALLOWEST_STRUCTURE_M);
    // Replayed among the structures, from the middle of the wreck, the shark
    // is legacy's at every checkpoint.
    const amongStructures = replay({ ...FRAME, ...amongTheStructures(50) });
    for (const recorded of checkpoints()) expectShark(amongStructures.sharks.get(recorded.checkpointId)!, recorded);
  });
});
