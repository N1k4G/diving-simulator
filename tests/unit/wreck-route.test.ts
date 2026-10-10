import { describe, expect, it } from "vitest";

import { selectWreckZone } from "../../src/render/renderer";
import { SITE_GAMEPLAY } from "../../src/sites/site-resources";
import {
  CARGO_HOLD_FROM_M,
  ENGINE_ROOM_FROM_M,
  MAX_SLIDE_SLOPE,
  OPEN_WATER_FLOOR_M,
  ROUTE_MAX_POSITION_M,
  ROUTE_MIN_POSITION_M,
  ROUTE_START_POSITION_M,
  WRECK_BOW_X_M,
  WRECK_DECK_TOP,
  WRECK_DECK_UNDERSIDE,
  WRECK_ENGINE,
  WRECK_HOLD_BOW_X_M,
  WRECK_HOLD_FLOOR_M,
  WRECK_HOLD_STERN_X_M,
  WRECK_STEM_TOP_M,
  WRECK_STERN_X_M,
  WRECK_VISOR,
  engineTopAt,
  holdFloorAt,
  moveAlongRoute,
  profileAt,
  routeSpaceNear,
  routeSpacesAt,
} from "../../src/sites/wreck-route";

// The wreck route's bounds (#199 slice 7). Owner decision A on #199: outside
// the wreck the ceiling is the surface; inside, in the cargo hold and the
// engine room, it is the deck. Owner decision of 2026-10-10 on #222: the bow
// is legacy's stem and visor opening, and the engine block is solid.

/** Fins from `from` towards `to` in 0.1 m strokes until stopped. */
function swim(from: number, to: number, depth: number): number {
  let position = from;
  const stroke = Math.sign(to - from) * 0.1;
  while (Math.abs(to - position) > 1e-9) {
    const next = moveAlongRoute(position, position + stroke, depth);
    if (next === position) {
      return position;
    }
    position = next;
  }
  return position;
}

describe("where the diver can be along the wreck route", () => {
  it("is open to the surface outside the wreck", () => {
    expect(routeSpacesAt(ROUTE_START_POSITION_M)).toEqual([
      { ceilingM: 0, floorM: OPEN_WATER_FLOOR_M, inOverhead: false },
    ]);
    expect(routeSpacesAt(CARGO_HOLD_FROM_M - 0.01)).toHaveLength(1);
  });

  it("starts in open water off the bow, clear of the hull", () => {
    expect(ROUTE_START_POSITION_M).toBeLessThan(WRECK_BOW_X_M);
    expect(selectWreckZone(ROUTE_START_POSITION_M)).toBe("exterior");
  });

  it("has the deck above the diver in the cargo hold and the engine room, and open water above the deck", () => {
    // Clear of the bow visor and the engine block, which the tests below take.
    for (const position of [24, 35, 45, 60, ENGINE_ROOM_FROM_M, 96, WRECK_HOLD_STERN_X_M]) {
      const [above, under] = routeSpacesAt(position);
      expect(above).toEqual({ ceilingM: 0, floorM: profileAt(WRECK_DECK_TOP, position), inOverhead: false });
      expect(under).toEqual({
        ceilingM: profileAt(WRECK_DECK_UNDERSIDE, position),
        floorM: WRECK_HOLD_FLOOR_M,
        inOverhead: true,
      });
      // The deck has thickness, and the hold has room.
      expect(under!.ceilingM).toBeGreaterThan(above!.floorM);
      expect(under!.floorM - under!.ceilingM).toBeGreaterThan(3);
    }
  });

  it("has the overhead start under the deck's forward edge, at x 22 as legacy's main deck (#222)", () => {
    // Legacy: any diver with a structure above is in the overhead
    // (src/sites.js overheadAt), and its main deck covers the hull from x 22.
    // #238 had it at 27, under the old drawing's hold; before that at 45.
    expect(CARGO_HOLD_FROM_M).toBe(22);
    expect(WRECK_DECK_TOP[0]!.x).toBe(CARGO_HOLD_FROM_M);
    expect(WRECK_DECK_UNDERSIDE[0]!.x).toBe(CARGO_HOLD_FROM_M);
    for (const position of [22, 25, 27, 30, 35, 40, 44.5]) {
      expect(routeSpaceNear(position, 28), `at ${position} m`).toEqual({
        ceilingM: profileAt(WRECK_DECK_UNDERSIDE, position),
        floorM: WRECK_HOLD_FLOOR_M,
        inOverhead: true,
      });
      expect(selectWreckZone(position), `at ${position} m`).toBe("cargo-hold");
    }
    // Ahead of the deck is the bow visor's opening, open to the surface.
    expect(routeSpacesAt(21.9)).toEqual([
      { ceilingM: 0, floorM: WRECK_HOLD_FLOOR_M, inOverhead: false },
    ]);
  });

  it("has legacy's bow: a solid stem, and the visor's opening behind it, open from above (#222)", () => {
    // src/sites.js: the bow stem at x 14..16, the main deck from x 22, and the
    // bow-visor opening between them.
    expect(WRECK_BOW_X_M).toBe(14);
    expect(WRECK_HOLD_BOW_X_M).toBe(16);
    expect(routeSpacesAt(13.9)).toEqual([{ ceilingM: 0, floorM: OPEN_WATER_FLOOR_M, inOverhead: false }]);
    for (const position of [14, 15, 16]) {
      expect(routeSpacesAt(position), `at ${position} m`).toEqual([
        { ceilingM: 0, floorM: WRECK_STEM_TOP_M, inOverhead: false },
      ]);
    }
    // The stem's top is level with the deck's underside, as legacy's is.
    expect(WRECK_STEM_TOP_M).toBe(WRECK_DECK_UNDERSIDE[0]!.d);
    for (const position of [16.1, 19, 21.9]) {
      expect(routeSpacesAt(position), `at ${position} m`).toEqual([
        { ceilingM: 0, floorM: WRECK_HOLD_FLOOR_M, inOverhead: false },
      ]);
      expect(selectWreckZone(position), `at ${position} m`).toBe("exterior");
    }
    // The visor stands on the deck's forward edge, and the diver goes over it.
    expect(routeSpacesAt(22.5)[0]).toEqual({ ceilingM: 0, floorM: WRECK_VISOR.topM, inOverhead: false });
    expect(routeSpacesAt(23.1)[0]!.floorM).toBeCloseTo(profileAt(WRECK_DECK_TOP, 23.1), 12);
  });

  it("is in the overhead where legacy's overheadAt is, at the hold's depth up to the main hatch (#222)", () => {
    // Legacy's wreck at its vehicle-deck depth (30 m, under its main deck at
    // 27..28 m) against the route at the hold's 28 m. Legacy's main hatch
    // opens its deck from 78 m on; the provisional drawing has no hatch.
    const wreck = SITE_GAMEPLAY.wreck!;
    const legacyOverheadAt = (x: number, d: number) =>
      wreck.structures.some((s) => x >= s.x1 && x <= s.x2 && s.dBottom < d);
    for (let position = ROUTE_MIN_POSITION_M; position <= 78; position += 0.25) {
      expect(routeSpaceNear(position, 28).inOverhead, `at ${position} m`).toBe(legacyOverheadAt(position, 30));
    }
  });

  it("ends the hold at the stern wall the scene draws, with only open water past it (#223 pre-review)", () => {
    // The wall runs from the floor's end (99, 33.5) up to the underside's end
    // (103, 29.5).
    expect(holdFloorAt(WRECK_HOLD_STERN_X_M)).toBe(WRECK_HOLD_FLOOR_M);
    expect(holdFloorAt(101)).toBeCloseTo(31.5, 12);
    expect(routeSpacesAt(101)[1]).toEqual({
      ceilingM: profileAt(WRECK_DECK_UNDERSIDE, 101),
      floorM: holdFloorAt(101),
      inOverhead: true,
    });
    for (const position of [WRECK_STERN_X_M, 104, ROUTE_MAX_POSITION_M]) {
      expect(routeSpacesAt(position), `at ${position} m`).toEqual([
        { ceilingM: 0, floorM: profileAt(WRECK_DECK_TOP, position), inOverhead: false },
      ]);
    }
    // On the hold's floor, the wall stops a diver finning aft.
    expect(moveAlongRoute(99.4, 99.5, 33.2)).toBe(99.4);
    expect(moveAlongRoute(101, 101.1, 31.45)).toBe(101);
  });

  it("is in the overhead exactly where the zone says cargo hold or engine room, up to the stern wall", () => {
    for (let position = ROUTE_MIN_POSITION_M; position <= WRECK_HOLD_STERN_X_M; position += 0.5) {
      const inside = routeSpaceNear(position, 30).inOverhead;
      expect(inside, `at ${position} m`).toBe(selectWreckZone(position) !== "exterior");
      // Above the deck is never the overhead.
      expect(routeSpaceNear(position, 5).inOverhead, `at ${position} m`).toBe(false);
    }
  });

  it("interpolates the drawn deck, and holds it level past either end", () => {
    expect(profileAt(WRECK_DECK_UNDERSIDE, 22)).toBe(24.5);
    expect(profileAt(WRECK_DECK_UNDERSIDE, 52)).toBeCloseTo(23.75, 12);
    expect(profileAt(WRECK_DECK_UNDERSIDE, 0)).toBe(24.5);
    expect(profileAt(WRECK_DECK_UNDERSIDE, 106)).toBe(29.5);
  });
});

describe("swimming along the route", () => {
  it("swims freely in open water, and stops at the route's ends", () => {
    expect(moveAlongRoute(10, 11, 15)).toBe(11);
    expect(moveAlongRoute(9, 6, 15)).toBe(ROUTE_MIN_POSITION_M);
    expect(moveAlongRoute(105, 110, 2)).toBe(ROUTE_MAX_POSITION_M);
  });

  it("enters the hold under the deck from the visor's opening, and crosses over it above the deck", () => {
    expect(moveAlongRoute(21.9, 22.1, 28)).toBe(22.1);
    expect(moveAlongRoute(21.9, 22.1, 10)).toBe(22.1);
  });

  it("is stopped by the stem below its top, by the deck's edge and by the visor (#222)", () => {
    // Off the bow, and inside the opening, the stem stops a diver below its top.
    for (const depth of [24.6, 28, 33.9]) {
      expect(moveAlongRoute(13.9, 14.1, depth), `at ${depth} m`).toBe(13.9);
    }
    for (const depth of [24.6, 28, 33.5]) {
      expect(moveAlongRoute(16.1, 15.9, depth), `at ${depth} m`).toBe(16.1);
    }
    expect(moveAlongRoute(13.9, 14.1, 24.4)).toBe(14.1);
    // The deck's forward edge runs from 23 m to 24.5 m.
    expect(moveAlongRoute(21.9, 22.1, 23.75)).toBe(21.9);
    // The visor stands from 19.4 m down to the deck; the diver goes over it.
    expect(moveAlongRoute(21.9, 22.1, 21)).toBe(21.9);
    expect(moveAlongRoute(23.1, 22.9, 21)).toBe(23.1);
    expect(moveAlongRoute(21.9, 22.1, 19)).toBe(22.1);
  });

  it("enters the hold from above through the visor's opening, and leaves the same way (#222)", () => {
    // Level at 28 m, the stem stops the diver off the bow.
    expect(swim(ROUTE_START_POSITION_M, 30, 28)).toBeLessThan(WRECK_BOW_X_M);
    // Over the stem at 20 m into the opening, down it, and aft under the deck.
    expect(swim(ROUTE_START_POSITION_M, 19, 20)).toBeCloseTo(19, 9);
    expect(routeSpaceNear(19, 28)).toEqual({ ceilingM: 0, floorM: WRECK_HOLD_FLOOR_M, inOverhead: false });
    expect(swim(19, 30, 28)).toBeCloseTo(30, 9);
    expect(routeSpaceNear(30, 28).inOverhead).toBe(true);
    // Back forward under the deck into the opening, which is open to the
    // surface; below its top the stem holds the diver in it.
    expect(swim(30, ROUTE_START_POSITION_M, 28)).toBeCloseTo(WRECK_HOLD_BOW_X_M + 0.1, 9);
    expect(routeSpaceNear(19, 28).ceilingM).toBe(0);
    expect(swim(19, ROUTE_START_POSITION_M, 20)).toBeCloseTo(ROUTE_START_POSITION_M, 9);
  });

  it("always leaves the hold into the visor's opening", () => {
    for (const depth of [24.6, 28, 33.5]) {
      expect(moveAlongRoute(22.1, 21.9, depth)).toBe(21.9);
      expect(routeSpaceNear(21.9, depth).inOverhead).toBe(false);
    }
  });

  it("is stopped by the engine block the scene draws, and goes over it (#222, a departure from legacy)", () => {
    // The owner's decision of 2026-10-10 on #222: the drawn engine is solid.
    // Legacy's engines are site features its collision never reads.
    const { centreX, bedX1, bedX2 } = WRECK_ENGINE;
    for (const depth of [28, 30.5, 33.3]) {
      for (const [from, to] of [[80, 96], [96, 80]] as const) {
        const position = swim(from, to, depth);
        expect(Math.abs(position - centreX), `from ${from} m, ${depth} m deep`).toBeGreaterThan(1);
        expect(position, `from ${from} m, ${depth} m deep`).toBeGreaterThan(bedX1 - 0.2);
        expect(position, `from ${from} m, ${depth} m deep`).toBeLessThan(bedX2 + 0.2);
        expect(engineTopAt(position + Math.sign(to - from) * 0.1)).toBeLessThan(depth);
      }
    }
    // Over the cylinder's top, at 27.4 m, the diver passes, both ways.
    expect(engineTopAt(centreX)).toBeCloseTo(27.4, 12);
    expect(routeSpacesAt(centreX)[1]!.floorM).toBeCloseTo(27.4, 12);
    expect(swim(80, 95, 27.2)).toBeCloseTo(95, 9);
    expect(swim(95, 80, 27.2)).toBeCloseTo(80, 9);
    expect(engineTopAt(bedX1 - 0.1)).toBe(Number.POSITIVE_INFINITY);
  });

  it("slides along the deck's gentle middle but not up the steep stern", () => {
    // Under the deck at 60 m, swimming aft: the underside rises 0.025 m a
    // metre, so the diver keeps to it.
    const underAt60 = profileAt(WRECK_DECK_UNDERSIDE, 60);
    expect(moveAlongRoute(60, 59.9, underAt60)).toBe(59.9);
    // Under the deck at 90 m, swimming forward: past 82 m it drops 0.31 m a
    // metre, steeper than MAX_SLIDE_SLOPE, and stops the diver.
    const underAt90 = profileAt(WRECK_DECK_UNDERSIDE, 90);
    expect(moveAlongRoute(90, 90.1, underAt90)).toBe(90);
    expect(MAX_SLIDE_SLOPE).toBeLessThan((29.5 - 23) / (103 - 82));
    // A little deeper, the same stroke is free.
    expect(moveAlongRoute(90, 90.1, underAt90 + 0.5)).toBe(90.1);
  });
});

describe("the route as a whole (#222)", () => {
  const STEP_M = 0.25;
  const columns = Math.round((ROUTE_MAX_POSITION_M - ROUTE_MIN_POSITION_M) / STEP_M);
  const rows = Math.round(OPEN_WATER_FLOOR_M / STEP_M);
  const xAt = (column: number) => ROUTE_MIN_POSITION_M + column * STEP_M;
  const spaceIndexAt = (column: number, row: number) =>
    routeSpacesAt(xAt(column)).findIndex(
      (space) => space.ceilingM <= row * STEP_M && row * STEP_M <= space.floorM,
    );
  const key = (column: number, row: number) => column * (rows + 1) + row;

  /**
   * The places on a 0.25 m grid next to one: a vertical stroke within one
   * stretch of water, and a horizontal one that moveAlongRoute makes in full.
   */
  function neighbours(column: number, row: number): [number, number][] {
    const result: [number, number][] = [];
    const here = spaceIndexAt(column, row);
    for (const nextRow of [row - 1, row + 1]) {
      if (nextRow >= 0 && nextRow <= rows && spaceIndexAt(column, nextRow) === here) {
        result.push([column, nextRow]);
      }
    }
    for (const nextColumn of [column - 1, column + 1]) {
      if (
        nextColumn >= 0 &&
        nextColumn <= columns &&
        spaceIndexAt(nextColumn, row) >= 0 &&
        moveAlongRoute(xAt(column), xAt(nextColumn), row * STEP_M) === xAt(nextColumn)
      ) {
        result.push([nextColumn, row]);
      }
    }
    return result;
  }

  /** Every place reached from `starts`, or, `backwards`, every place that reaches them. */
  function reach(starts: readonly [number, number][], backwards: boolean): Set<number> {
    const seen = new Set(starts.map(([column, row]) => key(column, row)));
    const queue = [...starts];
    while (queue.length > 0) {
      const [column, row] = queue.pop()!;
      for (const [nextColumn, nextRow] of neighbours(column, row)) {
        // Backwards, a stroke counts only if it is also made the other way.
        if (backwards && !neighbours(nextColumn, nextRow).some(([c, r]) => c === column && r === row)) {
          continue;
        }
        if (!seen.has(key(nextColumn, nextRow))) {
          seen.add(key(nextColumn, nextRow));
          queue.push([nextColumn, nextRow]);
        }
      }
    }
    return seen;
  }

  it("traps the diver nowhere: every place in the water is reached from the surface and reaches it", () => {
    const surface: [number, number][] = [];
    const water: [number, number][] = [];
    for (let column = 0; column <= columns; column += 1) {
      surface.push([column, 0]);
      for (let row = 0; row <= rows; row += 1) {
        if (spaceIndexAt(column, row) >= 0) {
          water.push([column, row]);
        }
      }
    }
    const fromSurface = reach(surface, false);
    const toSurface = reach(surface, true);
    const place = ([column, row]: [number, number]) => `${xAt(column)} m, ${row * STEP_M} m deep`;
    expect(water.filter(([column, row]) => !fromSurface.has(key(column, row))).map(place)).toEqual([]);
    expect(water.filter(([column, row]) => !toSurface.has(key(column, row))).map(place)).toEqual([]);
    // The hold is in it, and so is the water over the engine block.
    expect(fromSurface.has(key((30 - ROUTE_MIN_POSITION_M) / STEP_M, 28 / STEP_M))).toBe(true);
    expect(fromSurface.has(key((WRECK_ENGINE.centreX - ROUTE_MIN_POSITION_M) / STEP_M, 26 / STEP_M))).toBe(true);
  });

  it("crosses every boundary at every depth without a jump in depth, and enters the overhead only under the deck", () => {
    const { bedX1, bedX2, centreX, radiusM } = WRECK_ENGINE;
    const boundaries = [
      WRECK_BOW_X_M, WRECK_HOLD_BOW_X_M, CARGO_HOLD_FROM_M, WRECK_VISOR.x2,
      bedX1, centreX - radiusM, centreX + radiusM, bedX2,
      WRECK_HOLD_STERN_X_M, WRECK_STERN_X_M,
    ];
    const strokeM = 0.02;
    const slackM = MAX_SLIDE_SLOPE * strokeM;
    let crossings = 0;
    for (const boundary of boundaries) {
      const sides = [boundary - strokeM / 2, boundary + strokeM / 2] as const;
      for (const [from, to] of [sides, [sides[1], sides[0]] as const]) {
        for (let index = 0; index <= OPEN_WATER_FLOOR_M * 20; index += 1) {
          const depth = index / 20;
          const before = routeSpacesAt(from).find((space) => space.ceilingM <= depth && depth <= space.floorM);
          if (!before || moveAlongRoute(from, to, depth) !== to) {
            continue;
          }
          crossings += 1;
          const after = routeSpaceNear(to, depth);
          const held = Math.min(after.floorM, Math.max(after.ceilingM, depth));
          expect(Math.abs(held - depth), `${from} -> ${to} m at ${depth} m`).toBeLessThanOrEqual(slackM);
          if (after.inOverhead !== before.inOverhead) {
            expect(boundary, `${from} -> ${to} m at ${depth} m`).toBe(CARGO_HOLD_FROM_M);
            expect(depth).toBeGreaterThanOrEqual(WRECK_STEM_TOP_M - slackM);
          }
        }
      }
    }
    expect(crossings).toBeGreaterThan(1000);
  });
});
