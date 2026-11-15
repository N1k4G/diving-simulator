// The wreck the diver swims through (#240 PR 2): legacy's structures
// (src/sites/resources/gameplay.json, generated from src/sites.js) under the
// ported collision (src/sites/site-collision.ts), the x range the diver may
// swim, and where a resumed dive can be.
//
// Renderer-neutral: the controller and the save read it, the renderer draws
// from the same structures, and it imports neither.

import { ceilingAt, diverOverlapArea, floorAt } from "./site-collision";
import { siteGameplay, type ProfilePoint, type SiteGameplay } from "./site-resources";
import { ROUTE_START_POSITION_M } from "./wreck-route";

function requireWreck(): SiteGameplay {
  const wreck = siteGameplay("wreck");
  if (!wreck) throw new Error("the wreck's gameplay resource is missing");
  return wreck;
}

export const WRECK_SITE: SiteGameplay = requireWreck();

/**
 * How far along x the diver may swim: the reach of the site's floor, as far
 * as legacy authored its seabed (x -40 to 200). Legacy sets no bound; past
 * the floor's ends its seabed runs on level and nothing is there to see.
 */
export const WRECK_MIN_X_M = (WRECK_SITE.floor[0] as ProfilePoint).x;
export const WRECK_MAX_X_M = (WRECK_SITE.floor[WRECK_SITE.floor.length - 1] as ProfilePoint).x;

/** Whether the diver's body fits at (x, d): inside the site's bounds, touching no more than a structure's edge. */
export function diverFitsAt(xM: number, depthM: number): boolean {
  return (
    xM >= WRECK_MIN_X_M &&
    xM <= WRECK_MAX_X_M &&
    depthM >= ceilingAt(WRECK_SITE, xM) &&
    depthM <= floorAt(WRECK_SITE, xM) &&
    diverOverlapArea(WRECK_SITE, xM, depthM) === 0
  );
}

/**
 * The grid the reachable water is found on. A step is shorter than the
 * diver's half extents, so two places a step apart where the diver fits
 * have no structure between them that the diver would not touch.
 */
const GRID_M = 0.25;
const COLUMNS = Math.round((WRECK_MAX_X_M - WRECK_MIN_X_M) / GRID_M) + 1;
const ROWS = Math.round(WRECK_SITE.maxDepth / GRID_M) + 1;

let reached: Uint8Array | null = null;

/**
 * Every place on the grid the diver can swim to from the surface at the
 * route's start, found once, when first asked. Legacy's wreck has places the
 * diver fits but cannot reach: the cargo holds sealed behind the full
 * bulkheads at x 56 and 142, between whole decks (tests/unit/wreck-structure).
 */
function reachedCells(): Uint8Array {
  if (reached) return reached;
  const cells = new Uint8Array(COLUMNS * ROWS);
  const fits = (column: number, row: number): boolean =>
    diverFitsAt(WRECK_MIN_X_M + column * GRID_M, row * GRID_M);
  const start = Math.round((ROUTE_START_POSITION_M - WRECK_MIN_X_M) / GRID_M) * ROWS;
  cells[start] = 1;
  const queue = [start];
  while (queue.length > 0) {
    const cell = queue.pop() as number;
    const column = Math.floor(cell / ROWS);
    const row = cell % ROWS;
    for (const [nextColumn, nextRow] of [
      [column + 1, row],
      [column - 1, row],
      [column, row + 1],
      [column, row - 1],
    ] as const) {
      if (nextColumn < 0 || nextColumn >= COLUMNS || nextRow < 0 || nextRow >= ROWS) continue;
      const next = nextColumn * ROWS + nextRow;
      if (cells[next] || !fits(nextColumn, nextRow)) continue;
      cells[next] = 1;
      queue.push(next);
    }
  }
  reached = cells;
  return cells;
}

/** Whether the diver fits at (x, d) and can swim there from the surface. */
export function reachableAt(xM: number, depthM: number): boolean {
  if (!diverFitsAt(xM, depthM)) return false;
  const cells = reachedCells();
  const column = Math.floor((xM - WRECK_MIN_X_M) / GRID_M);
  const row = Math.floor(depthM / GRID_M);
  for (const [c, r] of [
    [column, row],
    [column + 1, row],
    [column, row + 1],
    [column + 1, row + 1],
  ] as const) {
    if (c < COLUMNS && r < ROWS && cells[c * ROWS + r]) return true;
  }
  return false;
}

/**
 * Whether a saved position resumes (#222, #240): the diver fits there at the
 * saved depth and can have swum there. Every position the controller saves
 * passes, as the physics never leaves the diver anywhere else; one inside a
 * structure, in a sealed hold, off the site or not a number at all does not.
 */
export function resumesAt(positionM: unknown, depthM: number): positionM is number {
  return typeof positionM === "number" && Number.isFinite(depthM) && reachableAt(positionM, depthM);
}

/** Where a resumed dive picks up: the saved position where it resumes, and otherwise the route's start. */
export function resumedPosition(positionM: unknown, depthM: number): number {
  return resumesAt(positionM, depthM) ? positionM : ROUTE_START_POSITION_M;
}
