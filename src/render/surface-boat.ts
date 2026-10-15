// The dive boat at the surface and its shadow under it (#222), after legacy's
// src/renderer.js: drawScene draws the boat ("Ship on surface", paintShip) and
// drawNearSurfaceAtmosphere its shadow (_drawBoatShadow). Renderer-neutral:
// where the boat is, how it moves and how strong its shadow is. The Pixi
// renderer draws it.

import { siteGameplay } from "../sites/site-resources";

/** Legacy draws its scene at 0.05 m a pixel, and the boat in those pixels. */
export const LEGACY_M_PER_PX = 0.05;

/**
 * Where legacy's wreck moors its boat, src/sites.js boatX 5. The route is
 * drawn in legacy's x (its bow stem at 14 to 16), so this is legacy's place:
 * the hull, about 1.8 to 8.9, lies clear of the wreck's bow (#254
 * pre-review pass 1).
 */
export const BOAT_X_M = siteGameplay("wreck")?.boatX ?? 0;

/** The boat rides the waves: sin(waveTime * 0.9) * 2.2 px, downward positive. */
export function boatBobM(elapsedRealS: number): number {
  return Math.sin(elapsedRealS * 0.9) * 2.2 * LEGACY_M_PER_PX;
}

/** And rocks on them: sin(waveTime * 0.75) * 0.022 rad. */
export function boatRockRad(elapsedRealS: number): number {
  return Math.sin(elapsedRealS * 0.75) * 0.022;
}

/** Its shadow sways sideways instead: sin(waveTime * 0.9) * 1.4 px. */
export function boatShadowSwayM(elapsedRealS: number): number {
  return Math.sin(elapsedRealS * 0.9) * 1.4 * LEGACY_M_PER_PX;
}

/** The shadow hangs 6 px under the surface line. */
export const BOAT_SHADOW_DEPTH_M = 6 * LEGACY_M_PER_PX;

/**
 * Legacy's near-surface light (nearSurfaceLightFactor): full down to 5 m,
 * then 85% of it gone by 12 m and the rest by 20 m, as two smoothsteps.
 */
export function nearSurfaceLightFactor(depthM: number): number {
  if (!(depthM > 0)) {
    return 1;
  }
  if (depthM >= 20) {
    return 0;
  }
  const knee = 1 - smoothstep(5, 12, depthM);
  const tail = 1 - smoothstep(12, 20, depthM);
  return Math.min(1, Math.max(0, knee * 0.85 + tail * 0.15));
}

/** Legacy keeps the wreck's near-surface light subtle (_nearSurfaceSiteMultiplier). */
export const WRECK_NEAR_SURFACE_MULTIPLIER = 0.4;

/**
 * How strong the boat's shadow is, as a multiple of legacy's full shadow (a
 * core of 0.22 alpha), or 0 where legacy draws none (drawNearSurfaceAtmosphere,
 * _drawBoatShadow):
 * - only while the dive is under way, legacy's 'diving' state, which the
 *   caller decides;
 * - not in the overhead;
 * - fading with the diver's depth, since it is the diver who looks up at it;
 * - none at or below a strength of 0.02, from about 17 m down.
 *
 * Legacy also scales the light by the local atmosphere. Wherever the shadow
 * shows, above 17 m, that is the wreck's exterior profile, ambient and
 * visibility 1, which leaves the light unscaled.
 */
export function boatShadowStrength(
  diving: boolean,
  inOverhead: boolean,
  diverDepthM: number,
): number {
  if (!diving || inOverhead) {
    return 0;
  }
  const strength = nearSurfaceLightFactor(diverDepthM) * WRECK_NEAR_SURFACE_MULTIPLIER;
  return strength > 0.02 ? strength : 0;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
