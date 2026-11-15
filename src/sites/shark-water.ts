// The water the shark swims in among a site's structures (#219, #240 PR 3b;
// owner decision of 2026-11-15). Legacy's floor guard reads floorAt(shark.x),
// on the wreck its seabed at 66 m, and its shark swims through the decks and
// bulkheads (src/game-loop.js). The client keeps its #219 departure on
// legacy's structures: the shark holds 0.5 m above the nearest structure
// below it, and never swims through a deck or a bulkhead.
//
// Each column of the site, at an x, is split by the structures standing in
// it into stretches of water, from the surface (or the site's ceiling) to the
// floor. The shark swims on at its depth, from stretch to stretch, only
// through water: where a structure stands in its way at its depth (the hull's
// side, a bulkhead, a deck's end), its way on is closed, and it is never
// lifted or sunk past one. Its depth changes only as it tracks the diver, and
// by at most the margin as it keeps clear of the structures above and below.
//
// Pure and renderer-neutral, on the structure model of
// src/sites/site-collision.ts: structures are solid with their edges, as
// solidAt() has them.

import { ceilingAt, floorAt, type CollisionSite } from "./site-collision";

/** A stretch of water in a column: deeper than topM, shallower than bottomM. */
export interface WaterStretch {
  readonly topM: number;
  readonly bottomM: number;
  /** Whether a structure or the site's ceiling closes it above; otherwise it is open to the surface. */
  readonly roofed: boolean;
}

/** The depths the shark may hold in a stretch of water. */
export interface SharkWater {
  readonly shallowestM: number;
  readonly deepestM: number;
}

/**
 * The stretches of water at x, shallowest first. A structure touching x
 * closes the column from its top to its bottom, its edges included, and
 * structures that meet or overlap close it as one.
 */
export function waterStretchesAt(site: CollisionSite, x: number): readonly WaterStretch[] {
  const ceilingM = ceilingAt(site, x);
  const floorM = floorAt(site, x);
  const closed = site.structures
    .filter((w) => x >= w.x1 && x <= w.x2 && w.dBottom > ceilingM && w.dTop < floorM)
    .map((w) => [w.dTop, w.dBottom] as const)
    .sort((a, b) => a[0] - b[0]);
  const stretches: WaterStretch[] = [];
  let topM = ceilingM;
  let roofed = ceilingM > 0;
  for (const [dTop, dBottom] of closed) {
    if (dTop > topM) {
      stretches.push({ topM, bottomM: dTop, roofed });
    }
    topM = Math.max(topM, dBottom);
    roofed = true;
  }
  if (floorM > topM) {
    stretches.push({ topM, bottomM: floorM, roofed });
  }
  return stretches;
}

/** Whether depth d is water in the stretch: open at the surface, closed at a structure. */
function holds(stretch: WaterStretch, d: number): boolean {
  return (stretch.roofed ? d > stretch.topM : d >= stretch.topM) && d < stretch.bottomM;
}

function distance(stretch: WaterStretch, d: number): number {
  if (holds(stretch, d)) return 0;
  return d < stretch.bottomM ? stretch.topM - d : d - stretch.bottomM;
}

/** The stretch nearest d, to place a shark in; the shallower of two as near, as legacy's guard only ever lifts. */
function nearest(stretches: readonly WaterStretch[], d: number): WaterStretch | null {
  let best: WaterStretch | null = null;
  for (const stretch of stretches) {
    if (best === null || distance(stretch, d) < distance(best, d)) best = stretch;
  }
  return best;
}

/**
 * The depths the shark holds in a stretch: marginM above its floor, and
 * marginM below a structure closing it above. A stretch too thin for both
 * holds it at its middle, so it is never inside a structure.
 */
export function sharkWaterIn(stretch: WaterStretch, marginM: number): SharkWater {
  const shallowestM = stretch.roofed ? stretch.topM + marginM : stretch.topM;
  const deepestM = stretch.bottomM - marginM;
  if (shallowestM <= deepestM) return { shallowestM, deepestM };
  const middleM = (stretch.topM + stretch.bottomM) / 2;
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

/**
 * The depths the shark may hold once it has swum from (fromX, fromD) to toX,
 * keeping marginM clear of the structures above and below it; null where a
 * structure stands in its way at its depth. Its own water is the stretch at
 * fromX that holds fromD, or the nearest to it where fromD is in none (a
 * shark spawned, or resumed, inside a structure or under the floor), where
 * it is placed. Column by column it keeps to the stretch that holds that
 * depth.
 */
export function sharkWaterAt(
  site: CollisionSite,
  fromX: number,
  fromD: number,
  toX: number,
  marginM: number,
): SharkWater | null {
  let stretch = nearest(waterStretchesAt(site, fromX), fromD);
  if (stretch === null) return null;
  const d = holds(stretch, fromD) ? fromD : clampInto(sharkWaterIn(stretch, marginM), fromD);
  for (const x of columnsBetween(site, fromX, toX)) {
    const here = waterStretchesAt(site, x).find((candidate) => holds(candidate, d));
    if (!here) return null;
    stretch = here;
  }
  return sharkWaterIn(stretch, marginM);
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

function clampInto(water: SharkWater, d: number): number {
  return Math.min(Math.max(d, water.shallowestM), water.deepestM);
}
