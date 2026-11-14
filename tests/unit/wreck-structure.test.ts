import { describe, expect, it } from "vitest";

import {
  DIVER_HALF_HEIGHT_M,
  DIVER_HALF_WIDTH_M,
  ceilingAt,
  diverOverlapArea,
  floorAt,
  overheadAt,
  solidAt,
} from "../../src/sites/site-collision";
import { SITE_GAMEPLAY, type SiteStructure } from "../../src/sites/site-resources";

// The wreck's structure as ported from legacy (#240 PR 1;
// src/sites/resources/gameplay.json, generated from src/sites.js), checked
// against the owner's description of it on #240, and where the diver's body
// can swim in it under the ported collision.

const wreck = SITE_GAMEPLAY.wreck!;

function structuresWhere(test: (w: SiteStructure) => boolean): SiteStructure[] {
  return wreck.structures.filter(test);
}

/** The transverse bulkheads standing between two depths, bow to stern. */
function bulkheadsWithin(topM: number, bottomM: number): SiteStructure[] {
  return structuresWhere((w) => w.kind === "bulkhead" && w.dTop >= topM && w.dBottom <= bottomM).sort(
    (a, b) => a.x1 - b.x1,
  );
}

const GRID_M = 0.25;
const X_FROM = -10;
const X_TO = 180;
const D_TO = 66;

/**
 * Where the diver's body can get to from open water off the bow, swimming in
 * steps of a quarter metre, shorter than the diver and than any slab: every
 * place on the grid joined to the start by places where the diver touches no
 * more than the edge of a structure and is inside the site's bounds.
 */
function reachable(): (x: number, d: number) => boolean {
  const columns = Math.round((X_TO - X_FROM) / GRID_M) + 1;
  const rows = Math.round(D_TO / GRID_M) + 1;
  const free = (column: number, row: number): boolean => {
    const x = X_FROM + column * GRID_M;
    const d = row * GRID_M;
    return d >= ceilingAt(wreck, x) && d <= floorAt(wreck, x) && diverOverlapArea(wreck, x, d) === 0;
  };
  const seen = new Uint8Array(columns * rows);
  const start = { column: Math.round((0 - X_FROM) / GRID_M), row: Math.round(10 / GRID_M) };
  const queue = [start.column * rows + start.row];
  seen[queue[0]!] = 1;
  while (queue.length > 0) {
    const cell = queue.pop()!;
    const column = Math.floor(cell / rows);
    const row = cell % rows;
    for (const [nextColumn, nextRow] of [
      [column + 1, row],
      [column - 1, row],
      [column, row + 1],
      [column, row - 1],
    ] as const) {
      if (nextColumn < 0 || nextColumn >= columns || nextRow < 0 || nextRow >= rows) continue;
      const next = nextColumn * rows + nextRow;
      if (seen[next] || !free(nextColumn, nextRow)) continue;
      seen[next] = 1;
      queue.push(next);
    }
  }
  return (x, d) => seen[Math.round((x - X_FROM) / GRID_M) * rows + Math.round(d / GRID_M)] === 1;
}

describe("the wreck's structure, ported from legacy (#240)", () => {
  it("has legacy's fifty structures, solid on structures alone", () => {
    expect(wreck.structures).toHaveLength(50);
    expect(wreck.hasOverhead).toBe(true);
    expect(wreck.ceiling).toBeNull();
    expect(new Set(wreck.structures.map((w) => w.kind))).toEqual(
      new Set(["hull", "deck", "bulkhead", "funnel", "mast"]),
    );
  });

  it("has the vehicle deck under the main deck, the crew deck at 40 to 46 m and lower decks down to 62 m", () => {
    const slabsAt = (topM: number): SiteStructure[] =>
      structuresWhere((w) => w.kind === "deck" && w.dTop === topM && w.dBottom === topM + 1);
    // The main deck, the vehicle deck's ceiling, from the bow visor's opening
    // (x 22) to the stern ramp's (x 148), open over the main hatch.
    expect(slabsAt(27).map((w) => [w.x1, w.x2])).toEqual([
      [22, 78],
      [92, 148],
    ]);
    // The vehicle deck's floor and the crew deck's ceiling at 39 to 40 m, the
    // crew deck's floor at 45 to 46 m, then 52 to 53 m and 61 to 62 m: each
    // slab from the bow stem to the stern transom, open over the main hatch.
    for (const topM of [39, 45, 52, 61]) {
      expect(slabsAt(topM).map((w) => [w.x1, w.x2]), `the deck at ${topM} m`).toEqual([
        [14, 78],
        [92, 168],
      ]);
    }
    expect(Math.max(...structuresWhere((w) => w.kind === "deck").map((w) => w.dBottom))).toBe(62);
  });

  it("divides the crew deck into fourteen cabins with doors alternately low and high", () => {
    const bulkheads = bulkheadsWithin(40, 45);
    expect(bulkheads).toHaveLength(13);
    // Between the bow stem (x 16) and the stern transom (x 168), thirteen
    // bulkheads make fourteen spaces.
    const edges = [16, ...bulkheads.flatMap((w) => [w.x1, w.x2]), 168];
    expect(edges.length / 2).toBe(14);
    for (const w of bulkheads) {
      // A low door leaves 43.5 to 45 m open, a high door 40 to 41.5 m.
      expect([
        [40, 43.5],
        [41.5, 45],
      ]).toContainEqual([w.dTop, w.dBottom]);
    }
    bulkheads.slice(1).forEach((w, index) => expect(w.dTop, `after x ${w.x1}`).not.toBe(bulkheads[index]!.dTop));
  });

  it("has full bulkheads in the cargo hold, and doors at the floor in the engine room", () => {
    const cargo = bulkheadsWithin(46, 52);
    expect(cargo.filter((w) => w.dTop === 46 && w.dBottom === 52).map((w) => w.x1)).toEqual([56, 142]);
    const engineRoom = bulkheadsWithin(53, 61);
    expect(engineRoom.map((w) => w.x1)).toEqual([34, 56, 112, 134, 156]);
    for (const w of engineRoom) expect([w.dTop, w.dBottom]).toEqual([53, 59]);
  });

  it("leaves the main hatch open at x 78 to 92 from 28 to 62 m, under the superstructure's walls", () => {
    for (let d = 27; d <= 62; d += 0.25) {
      for (let x = 78.25; x <= 91.75; x += 0.25) expect(solidAt(wreck, x, d), `(${x}, ${d})`).toBe(false);
    }
    expect([solidAt(wreck, 78, 39.5), solidAt(wreck, 92, 39.5)]).toEqual([true, true]);
    const walls = structuresWhere((w) => w.kind === "bulkhead" && w.dTop === 22 && w.dBottom === 28);
    expect(walls.map((w) => [w.x1, w.x2])).toEqual([
      [40, 42],
      [138, 140],
    ]);
  });

  it("is navigable with the diver's body through every authored entry, deck and door, and not into the sealed holds", () => {
    expect([DIVER_HALF_WIDTH_M, DIVER_HALF_HEIGHT_M]).toEqual([0.45, 0.3]);
    const can = reachable();
    const reached = {
      // The three entries: the bow visor's opening, the stern ramp's, and
      // from the vehicle deck up and down the main hatch.
      "the bow visor's opening": can(19, 30),
      "the stern ramp's opening": can(158, 30),
      "the vehicle deck, forward and aft": can(30, 34) && can(120, 34),
      "the main hatch, top to bottom": can(85, 29) && can(85, 44) && can(85, 60),
      "the accommodation and the bridge, from the hatch": can(60, 25) && can(120, 25) && can(90, 20.5),
      "the bilge, from the hatch": can(30, 63.5) && can(160, 63.5),
      "every engine room space": [25, 45, 67, 100, 123, 145, 162].every((x) => can(x, 60)),
      "every crew cabin": [19, 27.5, 37.5, 47.5, 57.5, 67.5, 85, 101.5, 111.5, 121.5, 131.5, 141.5, 151.5, 162].every(
        (x) => can(x, 44),
      ),
      "the cargo holds between the jammed bulkheads": [63.5, 74.5, 96, 107.5, 121.5, 135.5].every((x) => can(x, 49)),
    };
    expect(Object.entries(reached).filter(([, ok]) => !ok).map(([where]) => where)).toEqual([]);

    // Behind the two jammed bulkheads (x 56 and 142) the cargo holds are
    // sealed: the decks above and below them are whole there, so the holds
    // at 57 to 70 and 129 to 142 are dead ends.
    for (const x of [22, 35.5, 49.5, 149.5, 162.5]) {
      expect(can(x, 49), `the sealed hold at x ${x}`).toBe(false);
    }
    // Inside the hull a diver is under the overhead, all the way down.
    for (const [x, d] of [
      [30, 34],
      [60, 44],
      [85, 60],
      [60, 25],
    ] as const) {
      expect(overheadAt(wreck, x, d), `(${x}, ${d})`).toBe(true);
    }
    expect(overheadAt(wreck, 19, 30)).toBe(false);
  });
});
