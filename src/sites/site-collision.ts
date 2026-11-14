// Legacy's site collision, ported (#240 PR 1): src/sites.js floorAt …
// resolveDiverOverlap and the collision sub-steps of src/physics.js, which
// read the active site and the diver's globals and write them back. Here each
// is a pure function of a site's gameplay resources and the position given,
// returning what legacy would write, in legacy's order of operations
// (tests/parity/site-collision.test.ts). Renderer-neutral. Collision reads the
// structures only: features (the wreck's engines, its bow visor) are drawn,
// never collided with, as in legacy.

import { MAX_DEPTH_M } from "../core/buoyancy";
import type { ProfilePoint, SiteGameplay } from "./site-resources";

/** What collision reads of a site. */
export type CollisionSite = Pick<SiteGameplay, "hasOverhead" | "floor" | "ceiling" | "structures">;

/** The diver's half extents, along x and along depth: src/constants.js (#122). */
export const DIVER_HALF_WIDTH_M = 0.45;
export const DIVER_HALF_HEIGHT_M = 0.3;

/** Legacy's longest sub-steps through structures, so the diver cannot tunnel through a slab (src/physics.js). */
export const VERTICAL_SUBSTEP_M = 0.1;
export const HORIZONTAL_SUBSTEP_M = 0.3;

/** src/sites.js resolveDiverOverlap: the clearance an exit leaves, and its pass limit. */
const OVERLAP_CLEARANCE_M = 1e-6;
const OVERLAP_PASSES = 10;

/** Legacy's lerpProfile(): the interpolant first, as folding it into the product moves the result an ULP. */
function lerpProfile(points: readonly ProfilePoint[] | null, x: number): number | null {
  if (!points || points.length === 0) {
    return null;
  }
  const first = points[0] as ProfilePoint;
  if (x <= first.x) {
    return first.d;
  }
  const last = points[points.length - 1] as ProfilePoint;
  if (x >= last.x) {
    return last.d;
  }
  for (let index = 1; index < points.length; index += 1) {
    const b = points[index] as ProfilePoint;
    if (x <= b.x) {
      const a = points[index - 1] as ProfilePoint;
      const t = (x - a.x) / (b.x - a.x);
      return a.d + (b.d - a.d) * t;
    }
  }
  return last.d;
}

/** The deepest the diver can be at x: the site's floor, at most MAX_DEPTH. */
export function floorAt(site: CollisionSite, x: number): number {
  const floor = lerpProfile(site.floor, x);
  return floor === null ? MAX_DEPTH_M : Math.min(MAX_DEPTH_M, floor);
}

/** The shallowest the diver can be at x: 0 where open to the surface. */
export function ceilingAt(site: CollisionSite, x: number): number {
  const ceiling = lerpProfile(site.ceiling, x);
  return ceiling === null ? 0 : Math.max(0, ceiling);
}

/** Whether the point (x, d) is inside a structure, its edges included. */
export function solidAt(site: CollisionSite, x: number, d: number): boolean {
  for (const w of site.structures) {
    if (x >= w.x1 && x <= w.x2 && d >= w.dTop && d <= w.dBottom) return true;
  }
  return false;
}

/** Whether a box centred on (x, d) touches or overlaps a structure (#122). */
export function solidBoxAt(
  site: CollisionSite,
  x: number,
  d: number,
  halfWidthM: number,
  halfHeightM: number,
): boolean {
  for (const w of site.structures) {
    if (x + halfWidthM >= w.x1 && x - halfWidthM <= w.x2 && d + halfHeightM >= w.dTop && d - halfHeightM <= w.dBottom) {
      return true;
    }
  }
  return false;
}

/** Whether the diver's body at (x, d) touches or overlaps a structure. */
export function diverSolidAt(site: CollisionSite, x: number, d: number): boolean {
  return solidBoxAt(site, x, d, DIVER_HALF_WIDTH_M, DIVER_HALF_HEIGHT_M);
}

/** How much of a box centred on (x, d) is buried in structure, in m², summed over structures. */
export function solidOverlapArea(
  site: CollisionSite,
  x: number,
  d: number,
  halfWidthM: number,
  halfHeightM: number,
): number {
  let total = 0;
  for (const w of site.structures) {
    const dx = Math.min(x + halfWidthM, w.x2) - Math.max(x - halfWidthM, w.x1);
    if (dx <= 0) continue;
    const dd = Math.min(d + halfHeightM, w.dBottom) - Math.max(d - halfHeightM, w.dTop);
    if (dd <= 0) continue;
    total += dx * dd;
  }
  return total;
}

export function diverOverlapArea(site: CollisionSite, x: number, d: number): number {
  return solidOverlapArea(site, x, d, DIVER_HALF_WIDTH_M, DIVER_HALF_HEIGHT_M);
}

/**
 * Whether a move would bury the diver deeper. An equal area is allowed, with
 * a tolerance scaled to the diver's box, so that a fully engulfed diver, on a
 * flat gradient, can work its way out (#131).
 */
export function diverOverlapGrew(site: CollisionSite, fromX: number, fromD: number, toX: number, toD: number): boolean {
  const tolerance = 2 * DIVER_HALF_WIDTH_M * (2 * DIVER_HALF_HEIGHT_M) * 1e-9;
  return diverOverlapArea(site, toX, toD) > diverOverlapArea(site, fromX, fromD) + tolerance;
}

/**
 * Whether the way straight up from (x, d) to the surface is blocked: a hard
 * ceiling, or a structure whose bottom is above the diver. On a site with an
 * overhead this is legacy's inOverhead, which runs the torch, the silt, the
 * guideline and the rule of thirds.
 */
export function overheadAt(site: CollisionSite, x: number, d: number): boolean {
  if (!site.hasOverhead) return false;
  const ceiling = ceilingAt(site, x);
  if (ceiling > 0.5 && d >= ceiling - 0.01) return true;
  for (const w of site.structures) {
    if (x >= w.x1 && x <= w.x2 && w.dBottom < d) return true;
  }
  return false;
}

/** Whether legacy's physics sub-steps through structures on this site. */
function hasSolidStructures(site: CollisionSite): boolean {
  return site.hasOverhead || site.structures.length > 0;
}

export interface VerticalStep {
  readonly depthM: number;
  readonly verticalVelocityMpm: number;
}

/**
 * One physics sub-step of vertical motion at x: legacy's updateBuoyancyPhysics()
 * from the depth integration on, with the velocity it has just computed. The
 * diver moves in sub-steps of at most 0.1 m and stops, its velocity zeroed,
 * before the step that would bury it deeper; then the site's ceiling and floor
 * and the global bounds hold it.
 */
export function stepVertically(
  site: CollisionSite,
  x: number,
  depthM: number,
  verticalVelocityMpm: number,
  dtS: number,
): VerticalStep {
  let depth = depthM;
  let velocity = verticalVelocityMpm;
  const dz = velocity * (dtS / 60);
  if (hasSolidStructures(site) && dz !== 0) {
    const steps = Math.max(1, Math.ceil(Math.abs(dz) / VERTICAL_SUBSTEP_M));
    const step = dz / steps;
    for (let k = 0; k < steps; k += 1) {
      const next = depth + step;
      if (diverOverlapGrew(site, x, depth, x, next)) {
        velocity = 0;
        break;
      }
      depth = next;
    }
  } else {
    depth += dz;
  }

  const ceiling = ceilingAt(site, x);
  const floor = floorAt(site, x);
  if (depth < ceiling) {
    depth = ceiling;
    if (velocity < 0) velocity = 0;
  }
  if (depth > floor) {
    depth = floor;
    if (velocity > 0) velocity = 0;
  }
  if (depth < 0) {
    depth = 0;
    velocity = 0;
  }
  if (depth > MAX_DEPTH_M) {
    depth = MAX_DEPTH_M;
    velocity = 0;
  }
  return { depthM: depth, verticalVelocityMpm: velocity };
}

export interface HorizontalStep {
  readonly xM: number;
  /** Legacy zeroes the diver's horizontal velocity when a step is refused. */
  readonly blocked: boolean;
}

/**
 * A horizontal displacement at depth d: legacy's updateHorizontalPhysics()
 * from the displacement on. The diver moves in sub-steps of at most 0.3 m and
 * stops before one that would put it under the site's floor or above its
 * ceiling, or bury it deeper in structure.
 */
export function moveHorizontally(site: CollisionSite, x: number, depthM: number, displacementM: number): HorizontalStep {
  let position = x;
  const steps = Math.max(1, Math.ceil(Math.abs(displacementM) / HORIZONTAL_SUBSTEP_M));
  const step = displacementM / steps;
  for (let k = 0; k < steps; k += 1) {
    const next = position + step;
    const pinched = depthM > floorAt(site, next) || depthM < ceilingAt(site, next);
    if (pinched || diverOverlapGrew(site, position, depthM, next, depthM)) {
      return { xM: position, blocked: true };
    }
    position = next;
  }
  return { xM: position, blocked: false };
}

export interface OverlapResolution {
  readonly xM: number;
  readonly depthM: number;
  /** Legacy zeroes the velocity along each axis the diver was pushed along. */
  readonly movedHorizontally: boolean;
  readonly movedVertically: boolean;
}

interface ExitCandidate {
  readonly x: number;
  readonly d: number;
  readonly vertical: boolean;
}

/**
 * Pushes a diver who overlaps a structure out of it (#131): legacy's
 * resolveDiverOverlap(), run before each frame's physics. Each pass takes the
 * nearest exit, past any edge of any structure the diver is in, that the
 * site's bounds allow and that leaves the diver strictly less buried; it stops
 * when the diver is clear, when no exit makes progress, or after ten passes.
 */
export function resolveDiverOverlap(site: CollisionSite, x: number, depthM: number): OverlapResolution {
  let diverX = x;
  let depth = depthM;
  let movedHorizontally = false;
  let movedVertically = false;
  const result = (): OverlapResolution => ({ xM: diverX, depthM: depth, movedHorizontally, movedVertically });

  for (let pass = 0; pass < OVERLAP_PASSES; pass += 1) {
    const here = diverOverlapArea(site, diverX, depth);
    if (here <= 0) return result();

    const candidates: ExitCandidate[] = [];
    for (const w of site.structures) {
      const dx = Math.min(diverX + DIVER_HALF_WIDTH_M, w.x2) - Math.max(diverX - DIVER_HALF_WIDTH_M, w.x1);
      if (dx <= 0) continue;
      const dd = Math.min(depth + DIVER_HALF_HEIGHT_M, w.dBottom) - Math.max(depth - DIVER_HALF_HEIGHT_M, w.dTop);
      if (dd <= 0) continue;
      candidates.push({ x: w.x1 - DIVER_HALF_WIDTH_M - OVERLAP_CLEARANCE_M, d: depth, vertical: false });
      candidates.push({ x: w.x2 + DIVER_HALF_WIDTH_M + OVERLAP_CLEARANCE_M, d: depth, vertical: false });
      candidates.push({ x: diverX, d: w.dTop - DIVER_HALF_HEIGHT_M - OVERLAP_CLEARANCE_M, vertical: true });
      candidates.push({ x: diverX, d: w.dBottom + DIVER_HALF_HEIGHT_M + OVERLAP_CLEARANCE_M, vertical: true });
    }

    let best: { readonly candidate: ExitCandidate; readonly move: number } | null = null;
    for (const candidate of candidates) {
      const legal = candidate.vertical
        ? candidate.d >= ceilingAt(site, diverX) &&
          candidate.d <= floorAt(site, diverX) &&
          candidate.d >= 0 &&
          candidate.d <= MAX_DEPTH_M
        : depth >= ceilingAt(site, candidate.x) && depth <= floorAt(site, candidate.x);
      if (!legal) continue;
      const after = diverOverlapArea(site, candidate.x, candidate.d);
      if (after >= here - 1e-12) continue;
      const move = Math.abs(candidate.vertical ? candidate.d - depth : candidate.x - diverX);
      if (best === null || move < best.move) {
        best = { candidate, move };
      }
    }
    if (best === null) return result();

    if (best.candidate.vertical) {
      depth = best.candidate.d;
      movedVertically = true;
    } else {
      diverX = best.candidate.x;
      movedHorizontally = true;
    }
  }
  return result();
}
