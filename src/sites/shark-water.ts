// The water the shark swims in among a site's structures (#219, #240 PR 3b;
// owner decision of 2026-11-15). Legacy's floor guard reads floorAt(shark.x),
// on the wreck its seabed at 66 m, and its shark swims through the decks and
// bulkheads (src/game-loop.js). The client keeps its #219 departure on
// legacy's structures: the shark holds 0.5 m above the nearest structure
// below it, and never swims through a deck or a bulkhead.
//
// The shark keeps to the open water: in each column, from the surface (or
// the site's ceiling) down to the first structure, or to the floor. It is
// never under a structure, so never in the wreck's overhead, and can always
// rise to its way on: where a structure stands in its way at its depth, the
// way on is over it, which the shark rises to where it is. It is never
// lifted or sunk past a structure.
//
// Pure and renderer-neutral, on the structure model of
// src/sites/site-collision.ts: structures are solid with their edges, as
// solidAt() has them.

import { ceilingAt, floorAt, type CollisionSite } from "./site-collision";

/** The open water in a column: deeper than topM, the surface's included, and shallower than bottomM. */
export interface OpenWater {
  readonly topM: number;
  readonly bottomM: number;
}

/** The depths the shark may hold. */
export interface SharkWater {
  readonly shallowestM: number;
  readonly deepestM: number;
}

/**
 * The open water at x: from the surface, or the site's ceiling, down to the
 * top of the first structure touching x, its edges included, or to the
 * floor; null where a structure closes the column at its top.
 */
export function openWaterAt(site: CollisionSite, x: number): OpenWater | null {
  const topM = ceilingAt(site, x);
  let bottomM = floorAt(site, x);
  for (const w of site.structures) {
    if (x >= w.x1 && x <= w.x2 && w.dBottom > topM) bottomM = Math.min(bottomM, w.dTop);
  }
  return bottomM > topM ? { topM, bottomM } : null;
}

/**
 * The depths the shark holds in a column's open water: marginM above the
 * structure or floor below, and marginM below a ceiling. Where the water is
 * too thin for both, it holds at its middle, so it is never inside a
 * structure.
 */
export function sharkWaterIn(water: OpenWater, marginM: number): SharkWater {
  const shallowestM = water.topM > 0 ? water.topM + marginM : water.topM;
  const deepestM = water.bottomM - marginM;
  if (shallowestM <= deepestM) return { shallowestM, deepestM };
  const middleM = (water.topM + water.bottomM) / 2;
  return { shallowestM: middleM, deepestM: middleM };
}

/**
 * Where the columns between fromX and toX change: at every structure's edge
 * between them and between each two edges, in the order the shark passes
 * them, toX last. The columns between two edges are alike, so these are all
 * the columns the shark can meet on its way.
 */
function columnsBetween(site: CollisionSite, fromX: number, toX: number): number[] {
  const low = Math.min(fromX, toX);
  const high = Math.max(fromX, toX);
  const edges = [
    ...new Set(site.structures.flatMap((w) => [w.x1, w.x2]).filter((edge) => edge > low && edge < high)),
  ].sort((a, b) => (toX >= fromX ? a - b : b - a));
  const columns: number[] = [];
  let previous = fromX;
  for (const edge of [...edges, toX]) {
    columns.push((previous + edge) / 2, edge);
    previous = edge;
  }
  return columns;
}

/** Whether depth d is in the open water: at the surface, but not at a ceiling or a structure. */
function holds(water: OpenWater, d: number): boolean {
  return (water.topM === 0 ? d >= 0 : d > water.topM) && d < water.bottomM;
}

interface Way {
  /** The depth it swims at: fromD, or where it is placed at fromX. */
  readonly d: number;
  /** The deepest it could hold in every column from fromX to toX, toX's band last. */
  readonly deepestM: number;
  readonly arrival: SharkWater;
  readonly blocked: boolean;
}

/**
 * The shark's way from (fromX, fromD) to toX at its depth. A shark not in
 * the open water at fromX (spawned, or resumed, inside a structure or under
 * one, or under the floor) is placed at the nearest depth it may hold there.
 */
function wayFrom(site: CollisionSite, fromX: number, fromD: number, toX: number, marginM: number): Way | null {
  const start = openWaterAt(site, fromX);
  if (start === null) return null;
  const startBand = sharkWaterIn(start, marginM);
  const d = holds(start, fromD)
    ? fromD : Math.min(Math.max(fromD, startBand.shallowestM), startBand.deepestM);
  let deepestM = startBand.deepestM;
  let arrival = startBand;
  let blocked = false;
  for (const x of columnsBetween(site, fromX, toX)) {
    const water = openWaterAt(site, x);
    if (water === null) return null;
    arrival = sharkWaterIn(water, marginM);
    deepestM = Math.min(deepestM, arrival.deepestM);
    if (!holds(water, d)) blocked = true;
  }
  return { d, deepestM, arrival, blocked };
}

/**
 * The depths the shark may hold once it has swum from (fromX, fromD) to toX,
 * keeping marginM clear of the structures below it; null where a structure
 * stands in its way at its depth.
 */
export function sharkWaterAt(
  site: CollisionSite,
  fromX: number,
  fromD: number,
  toX: number,
  marginM: number,
): SharkWater | null {
  const way = wayFrom(site, fromX, fromD, toX, marginM);
  return way !== null && !way.blocked ? way.arrival : null;
}

/**
 * Where a structure stands in the shark's way from (fromX, fromD) to toX:
 * the depth at fromX from which it swims on over it, the deepest it may hold
 * in every column on the way; null where nothing stands in its way.
 */
export function sharkWayThroughAt(
  site: CollisionSite,
  fromX: number,
  fromD: number,
  toX: number,
  marginM: number,
): number | null {
  const way = wayFrom(site, fromX, fromD, toX, marginM);
  return way !== null && way.blocked ? way.deepestM : null;
}

/**
 * Whether open water joins (x1, d1) and (x2, d2): the straight line between
 * them touches no structure, edges included. The shark reaches the diver
 * only so, never through a deck or a bulkhead.
 */
export function openBetween(site: CollisionSite, x1: number, d1: number, x2: number, d2: number): boolean {
  return !site.structures.some((w) => {
    let enter = 0;
    let leave = 1;
    for (const [from, along, low, high] of [
      [x1, x2 - x1, w.x1, w.x2],
      [d1, d2 - d1, w.dTop, w.dBottom],
    ] as const) {
      if (along === 0) {
        if (from < low || from > high) return false;
        continue;
      }
      const a = (low - from) / along;
      const b = (high - from) / along;
      enter = Math.max(enter, Math.min(a, b));
      leave = Math.min(leave, Math.max(a, b));
      if (enter > leave) return false;
    }
    return true;
  });
}
