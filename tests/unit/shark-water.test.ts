import { describe, expect, it } from "vitest";

import { SHARK_DRAWN_REACH_M, SHARK_FLOOR_MARGIN_M, advanceShark, type SharkFrame } from "../../src/core/dive-model";
import type { SharkState } from "../../src/core/dive-state";
import { metres, seconds } from "../../src/core/units";
import { wreckViewAround } from "../../src/render/camera";
import { floorAt, solidAt } from "../../src/sites/site-collision";
import { openBetween, openWaterAt, sharkWaterAt, sharkWaterIn, sharkWayThroughAt } from "../../src/sites/shark-water";
import { WRECK_SITE, reachableAt } from "../../src/sites/wreck-site";

// The shark among legacy's wreck structures (#219, #240 PR 3b; owner
// decision of 2026-11-15): in the open water above them, 0.5 m above the
// nearest structure below it, never through a deck or a bulkhead, never
// inside a structure. Legacy's own solidAt() is compared with the client's
// in tests/parity/shark-encounter.

const MARGIN_M = SHARK_FLOOR_MARGIN_M;
const STRUCTURES = WRECK_SITE.structures;

/** Whether an axis-aligned segment touches no structure, edges included. */
function clear(x1: number, d1: number, x2: number, d2: number): boolean {
  return !STRUCTURES.some(
    (w) =>
      Math.max(x1, x2) >= w.x1 && Math.min(x1, x2) <= w.x2 && Math.max(d1, d2) >= w.dTop && Math.min(d1, d2) <= w.dBottom,
  );
}

/** The first structure's top below the surface at x, or the seabed. */
function firstBelowSurface(x: number): number {
  const tops = STRUCTURES.filter((w) => x >= w.x1 && x <= w.x2).map((w) => w.dTop);
  return Math.min(floorAt(WRECK_SITE, x), ...tops);
}

/** The shark's world, with the diver at diverX; the view as given, or wide enough that it never leaves. */
function world(diverX: number, view = { leftM: 1000, rightM: 1000 }, meets = false): SharkFrame {
  return {
    timeMultiplier: 3,
    diverVelocityMps: 0,
    viewLeftM: view.leftM,
    viewRightM: view.rightM,
    waterAt: (fromOffsetM, fromDepthM, toOffsetM) =>
      sharkWaterAt(WRECK_SITE, diverX + fromOffsetM, fromDepthM, diverX + toOffsetM, MARGIN_M),
    wayThroughAt: (fromOffsetM, fromDepthM, toOffsetM) =>
      sharkWayThroughAt(WRECK_SITE, diverX + fromOffsetM, fromDepthM, diverX + toOffsetM, MARGIN_M),
    openTo: meets ? (offsetM, depthM, diverDepthM) => openBetween(WRECK_SITE, diverX + offsetM, depthM, diverX, diverDepthM) : () => false,
    noShark: false,
  };
}

interface Swim {
  readonly path: { x: number; d: number }[];
  /** Where it first turned away: the x it held. */
  readonly turnedAtM: number | null;
}

/**
 * A shark swimming from (x, d), passed or not, with the model's
 * advanceShark, tracking diverDepthM, with no diver in its reach and a view
 * wide enough that it never leaves; stepM metres a step. It swims until it
 * leaves the site's x range, or after 4,000 steps.
 */
function swim(x: number, d: number, direction: 1 | -1, diverDepthM: number, passed: boolean, stepM = 0.25): Swim {
  const frame = world(0);
  // 7.5 m a real second, at 3 dive seconds to one.
  const elapsedS = seconds((stepM / 7.5) * 3);
  let shark: SharkState = {
    timerS: seconds(1e9),
    encounter: { offsetM: x, depthM: metres(d), direction, speedMps: 7.5, passed },
  };
  const path = [{ x, d }];
  let turnedAtM: number | null = null;
  for (let step = 0; step < 4000 && shark.encounter && Math.abs(shark.encounter.offsetM - 80) <= 125; step += 1) {
    const heading = shark.encounter.direction;
    shark = advanceShark(shark, diverDepthM, frame, elapsedS, () => 0.5).shark;
    if (!shark.encounter) break;
    path.push({ x: shark.encounter.offsetM, d: shark.encounter.depthM });
    if (shark.encounter.direction !== heading && turnedAtM === null) turnedAtM = shark.encounter.offsetM;
  }
  return { path, turnedAtM };
}

/**
 * Every step clear of the structures, in the open water 0.5 m above the
 * first structure below the surface, and reached without crossing one:
 * along at the depth it held, then up or down where it arrived, by no more
 * than the margin in a step.
 */
function expectClearSwim({ path }: Swim, where: string): void {
  const faults: string[] = [];
  path.forEach(({ x, d }, index) => {
    if (index === 0) return;
    const at = `${where}, step ${index} at ${x.toFixed(3)}, ${d.toFixed(3)}`;
    if (solidAt(WRECK_SITE, x, d)) faults.push(`${at}: inside a structure`);
    if (d > firstBelowSurface(x) - MARGIN_M + 1e-9) faults.push(`${at}: under 0.5 m above the structure below`);
    // A start under a structure or the seabed is a spawn, placed, not a swim.
    const before = path[index - 1]!;
    if (index === 1 && before.d > firstBelowSurface(before.x) - MARGIN_M) return;
    if (!(clear(before.x, before.d, x, before.d) && clear(x, before.d, x, d))) {
      faults.push(`${at}: through a structure from ${before.x.toFixed(3)}, ${before.d.toFixed(3)}`);
    }
    if (Math.abs(d - before.d) > MARGIN_M + 0.01) faults.push(`${at}: moved ${Math.abs(d - before.d)} m in a step`);
  });
  expect(faults).toEqual([]);
}

describe("the water the shark swims in among the wreck's structures (#219, #240 PR 3b)", () => {
  it("finds the open water down to the first structure in a column, or the seabed", () => {
    expect(openWaterAt(WRECK_SITE, 0)).toEqual({ topM: 0, bottomM: 66 });
    // Over the hull's side, the main deck, the superstructure's roof, the mast and the funnel.
    expect(openWaterAt(WRECK_SITE, 15)).toEqual({ topM: 0, bottomM: 28 });
    expect(openWaterAt(WRECK_SITE, 30)).toEqual({ topM: 0, bottomM: 27 });
    expect(openWaterAt(WRECK_SITE, 50)).toEqual({ topM: 0, bottomM: 22 });
    expect(openWaterAt(WRECK_SITE, 75.5)).toEqual({ topM: 0, bottomM: 10 });
    expect(openWaterAt(WRECK_SITE, 85)).toEqual({ topM: 0, bottomM: 14 });
    // The bow visor's opening, down to the vehicle deck.
    expect(openWaterAt(WRECK_SITE, 19)).toEqual({ topM: 0, bottomM: 39 });
  });

  it("holds the shark 0.5 m above the first structure below the surface, and puts one under it there", () => {
    const held = (x: number, d: number) => sharkWaterAt(WRECK_SITE, x, d, x, MARGIN_M);
    expect(held(0, 30)).toEqual({ shallowestM: 0, deepestM: 65.5 });
    expect(held(50, 10)).toEqual({ shallowestM: 0, deepestM: 21.5 });
    expect(held(85, 10)).toEqual({ shallowestM: 0, deepestM: 13.5 });
    // Spawned under the main deck, in a structure or under the seabed: placed in the open water above.
    expect(held(50, 33)).toEqual({ shallowestM: 0, deepestM: 21.5 });
    expect(held(50, 39.5)).toEqual({ shallowestM: 0, deepestM: 21.5 });
    expect(held(0, 70)).toEqual({ shallowestM: 0, deepestM: 65.5 });
    const { path } = swim(50, 33, 1, 33, false);
    expect(path[1]!.d).toBeCloseTo(21.5, 12);
  });

  it("holds water too thin for the margins at its middle", () => {
    expect(sharkWaterIn({ topM: 0, bottomM: 0.4 }, MARGIN_M)).toEqual({ shallowestM: 0.2, deepestM: 0.2 });
    expect(sharkWaterIn({ topM: 40, bottomM: 40.6 }, MARGIN_M)).toEqual({ shallowestM: 40.3, deepestM: 40.3 });
  });

  it("finds the way on over what stands in the shark's way: the deepest it may hold on the way", () => {
    // Met by the bow's side at 30 m: over its top at 28 m.
    expect(sharkWaterAt(WRECK_SITE, 13.9, 30, 14.1, MARGIN_M)).toBeNull();
    expect(sharkWayThroughAt(WRECK_SITE, 13.9, 30, 14.1, MARGIN_M)).toBe(27.5);
    // Over the main deck at 26 m, the superstructure's wall to 22 m and the mast's top at 10 m in one step.
    expect(sharkWayThroughAt(WRECK_SITE, 35, 26, 76, MARGIN_M)).toBe(9.5);
    // Nothing in its way.
    expect(sharkWayThroughAt(WRECK_SITE, 0, 30, 5, MARGIN_M)).toBeNull();
  });

  it("swims over the whole wreck above it; one yet to pass turns at the bow's side, a passed one rises over it", () => {
    for (const d of [2, 9]) {
      const run = swim(-40, d, 1, d, false);
      expect(run.turnedAtM).toBeNull();
      expect(run.path.at(-1)!.x).toBeGreaterThan(200);
      for (const point of run.path) expect(point.d).toBe(d);
    }
    const approaching = swim(-40, 30, 1, 30, false);
    expectClearSwim(approaching, "off the bow at 30 m");
    expect(approaching.turnedAtM!).toBeGreaterThan(14 - 0.25 - 1e-9);
    expect(approaching.turnedAtM!).toBeLessThan(14);
    expect(approaching.path.at(-1)!.x).toBeLessThan(-40);
    for (const { d } of approaching.path) expect(d).toBe(30);
    // Passed, it rises where it is, at 0.3 m a dive second, and swims on over the wreck.
    const leaving = swim(-40, 30, 1, 30, true);
    expectClearSwim(leaving, "passed, off the bow at 30 m");
    expect(leaving.turnedAtM).toBeNull();
    expect(leaving.path.at(-1)!.x).toBeGreaterThan(200);
    const atTheSide = leaving.path.filter(({ x }) => x > 13.5 && x < 14);
    expect(atTheSide.length).toBeGreaterThan(10);
  });

  it("finds open water between the shark and the diver only where no structure stands between them", () => {
    // Over the main deck (27 to 28 m) and a diver under it.
    expect(openBetween(WRECK_SITE, 31.5, 26.5, 30, 29)).toBe(false);
    // Both over the deck, and beside the hull.
    expect(openBetween(WRECK_SITE, 31.5, 26.5, 30, 26.7)).toBe(true);
    expect(openBetween(WRECK_SITE, 0, 30, 1.5, 27)).toBe(true);
    // Across the bow's side; touching its edge counts as through it.
    expect(openBetween(WRECK_SITE, 13.5, 30, 16.5, 30)).toBe(false);
    expect(openBetween(WRECK_SITE, 13, 28, 15, 28)).toBe(false);
  });

  it("never ends inside a structure, crosses one or jumps, swimming the site's x range at any depth", { timeout: 60_000 }, () => {
    const depths = [2, 9, 15, 20, 24, 27.5, 30, 33, 39.5, 44, 49, 57, 63.5, 65.8, 70];
    let turned = 0;
    for (const d of depths) {
      for (const [x, direction] of [
        [-40, 1],
        [200, -1],
        [50, 1],
        [50, -1],
        [100, 1],
        [100, -1],
      ] as const) {
        for (const passed of [false, true]) {
          const where = `from ${x}, ${d} m, heading ${direction}${passed ? ", passed" : ""}`;
          const run = swim(x, d, direction, d, passed);
          expectClearSwim(run, where);
          // Steps longer than a bulkhead is wide turn where the short ones do: none tunnels through.
          const long = swim(x, d, direction, d, passed, 1.3);
          expectClearSwim(long, `${where}, 1.3 m a step`);
          expect(long.turnedAtM === null, where).toBe(run.turnedAtM === null);
          if (run.turnedAtM !== null) expect(Math.abs(long.turnedAtM! - run.turnedAtM), where).toBeLessThan(1.3);
          // A passed shark never turns: it always rises over what stands in its way.
          if (passed) expect(run.turnedAtM, where).toBeNull();
          if (run.turnedAtM !== null) turned += 1;
        }
      }
    }
    expect(turned).toBeGreaterThan(0);
  });

  it("ends every encounter within a bound, wherever the diver can be, and never where any of the shark can be seen", { timeout: 60_000 }, () => {
    // A shark spawned 5 m beyond either edge of the camera's view, at the
    // diver's depth and 10 m above and below it, around a still diver at
    // every place it can reach on an 8 m by 4 m grid, facing either way:
    // 0.3 dive seconds a frame at 3 to one, 0.75 m a frame.
    const BOUND = 600;
    let encounters = 0;
    let longest = 0;
    const faults: string[] = [];
    for (let diverX = -40; diverX <= 200; diverX += 8) {
      for (const facing of [-1, 1] as const) {
        const view = wreckViewAround(diverX, facing);
        const frame = world(diverX, view, true);
        for (let diverDepthM = 2; diverDepthM <= 64; diverDepthM += 4) {
          if (!reachableAt(diverX, diverDepthM)) continue;
          for (const direction of [-1, 1] as const) {
            for (const spreadM of [-10, 0, 10]) {
              encounters += 1;
              let shark: SharkState = {
                timerS: seconds(1e9),
                encounter: {
                  offsetM: direction > 0 ? -(view.leftM + 5) : view.rightM + 5,
                  depthM: metres(Math.max(0, diverDepthM + spreadM)),
                  direction,
                  speedMps: 7.5,
                  passed: false,
                },
              };
              let steps = 0;
              while (shark.encounter && steps < BOUND) {
                const before = shark.encounter;
                shark = advanceShark(shark, diverDepthM, frame, seconds(0.3), () => 0.9).shark;
                steps += 1;
                const seen =
                  before.offsetM > -(view.leftM + SHARK_DRAWN_REACH_M) && before.offsetM < view.rightM + SHARK_DRAWN_REACH_M;
                if (!shark.encounter && seen) faults.push(`diver ${diverX}, ${diverDepthM} m: gone in sight at ${before.offsetM}`);
              }
              if (shark.encounter) faults.push(`diver ${diverX}, ${diverDepthM} m, facing ${facing}: still swimming`);
              longest = Math.max(longest, steps);
            }
          }
        }
      }
    }
    expect(faults).toEqual([]);
    expect(encounters).toBeGreaterThan(1000);
    expect(longest).toBeLessThan(BOUND);
  });
});
