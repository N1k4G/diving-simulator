import { describe, expect, it } from "vitest";

import { SHARK_FLOOR_MARGIN_M, advanceShark, type SharkFrame } from "../../src/core/dive-model";
import type { SharkState } from "../../src/core/dive-state";
import { metres, seconds } from "../../src/core/units";
import { floorAt, solidAt } from "../../src/sites/site-collision";
import { sharkWaterAt, sharkWaterIn, waterStretchesAt } from "../../src/sites/shark-water";
import { WRECK_SITE } from "../../src/sites/wreck-site";

// The shark among legacy's wreck structures (#219, #240 PR 3b; owner
// decision of 2026-11-15): 0.5 m above the nearest structure below it,
// never through a deck or a bulkhead, never inside a structure. Legacy's own
// solidAt() is compared with the client's in tests/parity/shark-encounter.

const MARGIN_M = SHARK_FLOOR_MARGIN_M;
const STRUCTURES = WRECK_SITE.structures;

/** Whether an axis-aligned segment touches no structure, edges included. */
function clear(x1: number, d1: number, x2: number, d2: number): boolean {
  return !STRUCTURES.some(
    (w) =>
      Math.max(x1, x2) >= w.x1 && Math.min(x1, x2) <= w.x2 && Math.max(d1, d2) >= w.dTop && Math.min(d1, d2) <= w.dBottom,
  );
}

/** The nearest structure's top below (x, d), or the seabed; and the nearest's bottom above, or the surface. */
function nearestBelow(x: number, d: number): number {
  const tops = STRUCTURES.filter((w) => x >= w.x1 && x <= w.x2 && w.dTop > d).map((w) => w.dTop);
  return Math.min(floorAt(WRECK_SITE, x), ...tops);
}
function nearestAbove(x: number, d: number): number | null {
  const bottoms = STRUCTURES.filter((w) => x >= w.x1 && x <= w.x2 && w.dBottom < d).map((w) => w.dBottom);
  return bottoms.length === 0 ? null : Math.max(...bottoms);
}

interface Swim {
  readonly path: { x: number; d: number }[];
  /** Where its way on closed: the last x it held. */
  readonly goneAtM: number | null;
}

/**
 * A shark swimming from (x, d) with the model's advanceShark, the diver
 * still at x 0 and at diverDepthM, the view wide enough that it never
 * leaves past it; stepM metres a step.
 */
function swim(x: number, d: number, direction: 1 | -1, diverDepthM: number, stepM = 0.125): Swim {
  const frame: SharkFrame = {
    timeMultiplier: 3,
    diverVelocityMps: 0,
    viewLeftM: 1000,
    viewRightM: 1000,
    waterAt: (fromOffsetM, fromDepthM, toOffsetM) => sharkWaterAt(WRECK_SITE, fromOffsetM, fromDepthM, toOffsetM, MARGIN_M),
    noShark: false,
  };
  // 7.5 m a real second, at 3 dive seconds to one.
  const elapsedS = seconds((stepM / 7.5) * 3);
  let shark: SharkState = {
    timerS: seconds(1e9),
    encounter: { offsetM: x, depthM: metres(d), direction, speedMps: 7.5, passed: true },
  };
  const path = [{ x, d }];
  while (shark.encounter && shark.encounter.offsetM >= -45 && shark.encounter.offsetM <= 205) {
    const last = path[path.length - 1]!;
    shark = advanceShark(shark, diverDepthM, frame, elapsedS, () => 0.5).shark;
    if (!shark.encounter) return { path, goneAtM: last.x };
    path.push({ x: shark.encounter.offsetM, d: shark.encounter.depthM });
  }
  return { path, goneAtM: null };
}

/**
 * Every step clear of the structures and 0.5 m from the nearest below and
 * above; with `crossing`, steps short enough to meet one column change at
 * most, each reached without crossing a structure.
 */
function expectClearSwim({ path }: Swim, where: string, crossing = true): void {
  const faults: string[] = [];
  path.forEach(({ x, d }, index) => {
    if (index === 0) return;
    const at = `${where}, step ${index} at ${x.toFixed(3)}, ${d.toFixed(3)}`;
    if (solidAt(WRECK_SITE, x, d)) faults.push(`${at}: inside a structure`);
    if (d > nearestBelow(x, d) - MARGIN_M + 1e-9) faults.push(`${at}: under 0.5 m above the structure below`);
    const above = nearestAbove(x, d);
    if (d < (above === null ? 0 : above + MARGIN_M - 1e-9)) faults.push(`${at}: under 0.5 m below the structure above`);
    // Up or down where it was, then along: through no structure. A start
    // inside a structure or under the seabed is a spawn, not a swim.
    const before = path[index - 1]!;
    const placed = index === 1 && (solidAt(WRECK_SITE, before.x, before.d) || before.d > floorAt(WRECK_SITE, before.x));
    if (crossing && !placed && !(clear(before.x, before.d, before.x, d) && clear(before.x, d, x, d))) {
      faults.push(`${at}: through a structure from ${before.x.toFixed(3)}, ${before.d.toFixed(3)}`);
    }
  });
  expect(faults).toEqual([]);
}

describe("the water the shark swims in among the wreck's structures (#219, #240 PR 3b)", () => {
  it("splits a column into the stretches of water between the structures in it", () => {
    // Off the bow: the surface to the seabed.
    expect(waterStretchesAt(WRECK_SITE, 0)).toEqual([{ topM: 0, bottomM: 66, roofed: false }]);
    // At x 50: over the superstructure's roof, in the accommodation, the
    // vehicle deck, the crew deck, the lower decks, over the hull's bottom.
    expect(waterStretchesAt(WRECK_SITE, 50)).toEqual([
      { topM: 0, bottomM: 22, roofed: false },
      { topM: 23, bottomM: 27, roofed: true },
      { topM: 28, bottomM: 39, roofed: true },
      { topM: 40, bottomM: 45, roofed: true },
      { topM: 46, bottomM: 52, roofed: true },
      { topM: 53, bottomM: 61, roofed: true },
      { topM: 62, bottomM: 65, roofed: true },
    ]);
    // The main hatch at x 85: under the funnel and the superstructure's
    // deck, down the shaft to the hull's bottom.
    expect(waterStretchesAt(WRECK_SITE, 85)).toEqual([
      { topM: 0, bottomM: 14, roofed: false },
      { topM: 19, bottomM: 65, roofed: true },
    ]);
  });

  it("holds the shark 0.5 m from the structures below and above it: in a hold, under a deck, in the main hatch", () => {
    const held = (x: number, d: number) => sharkWaterAt(WRECK_SITE, x, d, x, MARGIN_M);
    expect(held(0, 30)).toEqual({ shallowestM: 0, deepestM: 65.5 });
    expect(held(50, 10)).toEqual({ shallowestM: 0, deepestM: 21.5 });
    // Under the main deck, over the vehicle deck's floor.
    expect(held(50, 33)).toEqual({ shallowestM: 28.5, deepestM: 38.5 });
    // A hold under the crew deck, between whole decks.
    expect(held(60, 58)).toEqual({ shallowestM: 53.5, deepestM: 60.5 });
    // In the shaft the nearest structure below is the hull's bottom.
    expect(held(85, 50)).toEqual({ shallowestM: 19.5, deepestM: 64.5 });
  });

  it("puts a shark spawned inside a structure or under the seabed into the nearest water, the shallower of two", () => {
    // In the vehicle deck's floor, 39 to 40 m, as near the vehicle deck as the crew deck.
    expect(sharkWaterAt(WRECK_SITE, 50, 39.5, 50, MARGIN_M)).toEqual({ shallowestM: 28.5, deepestM: 38.5 });
    expect(sharkWaterAt(WRECK_SITE, 50, 39.8, 50, MARGIN_M)).toEqual({ shallowestM: 40.5, deepestM: 44.5 });
    // Under the seabed off the bow: legacy's 0.5 m over it.
    expect(sharkWaterAt(WRECK_SITE, 0, 70, 0, MARGIN_M)).toEqual({ shallowestM: 0, deepestM: 65.5 });
    // Spawned in the floor and stepped once: clear of it.
    const { path } = swim(50, 39.5, 1, 39.5);
    expect(solidAt(WRECK_SITE, path[1]!.x, path[1]!.d)).toBe(false);
    expect(path[1]!.d).toBeCloseTo(38.5, 12);
  });

  it("holds a stretch too thin for both margins at its middle", () => {
    expect(sharkWaterIn({ topM: 40, bottomM: 40.6, roofed: true }, MARGIN_M)).toEqual({ shallowestM: 40.3, deepestM: 40.3 });
    expect(sharkWaterIn({ topM: 0, bottomM: 0.4, roofed: false }, MARGIN_M)).toEqual({ shallowestM: 0.2, deepestM: 0.2 });
  });

  it("swims over the hull from outside it, rising at the bow's side and the stern's", () => {
    const outside = swim(-40, 30, 1, 30);
    expect(outside.goneAtM).toBeNull();
    expectClearSwim(outside, "off the bow at 30 m");
    const overTheSide = outside.path.filter(({ x }) => x >= 14 && x <= 16);
    expect(overTheSide.length).toBeGreaterThan(0);
    for (const { d } of overTheSide) expect(d).toBeLessThanOrEqual(28 - MARGIN_M);
    const overTheStern = outside.path.filter(({ x }) => x >= 168 && x <= 170);
    expect(overTheStern.length).toBeGreaterThan(0);
    for (const { d } of overTheStern) expect(d).toBeLessThanOrEqual(28 - MARGIN_M);
  });

  it("goes through the crew deck's doors, and turns away at the hull's side where its deck ends", () => {
    const forward = swim(20, 42, -1, 42);
    expect(forward.goneAtM).not.toBeNull();
    expect(forward.goneAtM!).toBeGreaterThan(16);
    expect(forward.goneAtM!).toBeLessThan(16 + 0.125 + 1e-9);
    expectClearSwim(forward, "the crew deck, forward");

    const aft = swim(20, 42, 1, 42);
    expectClearSwim(aft, "the crew deck, aft");
    expect(aft.goneAtM!).toBeGreaterThan(168 - 0.125 - 1e-9);
    expect(aft.goneAtM!).toBeLessThan(168);
    // Under the bulkhead at x 22 to 23, from the deckhead to 43.5 m; over the
    // one at x 32 to 33, from 41.5 m to the deck.
    for (const { x, d } of aft.path) {
      if (x >= 22 && x <= 23) expect(d).toBeGreaterThanOrEqual(43.5 + MARGIN_M - 1e-9);
      if (x >= 32 && x <= 33) expect(d).toBeLessThanOrEqual(41.5 - MARGIN_M + 1e-9);
    }
    // Across the main hatch it stays at the crew deck's depth.
    for (const { x, d } of aft.path.filter(({ x }) => x > 78 && x < 92)) expect(d, `${x}`).toBeCloseTo(42, 0);
  });

  it("turns away at a full bulkhead, the hold behind it sealed", () => {
    const hold = swim(50, 49, 1, 49);
    expectClearSwim(hold, "the lower deck at x 50");
    expect(hold.goneAtM!).toBeGreaterThan(56 - 0.125 - 1e-9);
    expect(hold.goneAtM!).toBeLessThan(56);
  });

  it("never ends inside a structure or crosses one, swimming the site's x range at any depth", { timeout: 30_000 }, () => {
    const depths = [2, 9, 15, 20, 24, 27.5, 30, 33, 36, 39.5, 42, 44, 47, 49, 51, 55, 57, 60, 63.5, 65.8, 70];
    let swims = 0;
    let closed = 0;
    for (const d of depths) {
      for (const [x, direction] of [
        [-40, 1],
        [200, -1],
        [20, 1],
        [20, -1],
        [50, 1],
        [50, -1],
        [85, 1],
        [85, -1],
        [100, 1],
        [100, -1],
        [150, 1],
        [150, -1],
      ] as const) {
        const where = `from ${x}, ${d} m, heading ${direction}`;
        // A frame's swim at 30 frames a second, shorter than any structure is wide.
        const run = swim(x, d, direction, d, 0.25);
        expectClearSwim(run, where);
        // Steps longer than a bulkhead is wide pass the same structures as
        // the short ones and turn away where they do: none tunnels through.
        const long = swim(x, d, direction, d, 1.3);
        expectClearSwim(long, `${where}, 1.3 m a step`, false);
        expect(long.goneAtM === null, where).toBe(run.goneAtM === null);
        if (run.goneAtM !== null) expect(Math.abs(long.goneAtM! - run.goneAtM), where).toBeLessThan(1.3);
        swims += 1;
        if (run.goneAtM !== null) closed += 1;
      }
    }
    expect(swims).toBe(depths.length * 12);
    expect(closed).toBeGreaterThan(0);
    // Above every structure, over the mast's top at 10 m, the shark crosses the whole site at its depth.
    for (const d of [2, 9]) {
      const run = swim(-40, d, 1, d);
      expect(run.goneAtM).toBeNull();
      for (const point of run.path) expect(point.d).toBe(d);
    }
  });
});
