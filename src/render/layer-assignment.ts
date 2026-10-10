// WP-07: which retained scene element belongs to which layer, as data.
//
// The layer refactor claimed draw order was "a declared property of the scene
// rather than an accident of call order", but it was expressed as a sequence of
// addChild calls — so nothing could read it, and nothing could assert it. Silt
// was assigned to `terrain`, below `structure`, which put 31 of its 48
// particles behind the hull's opaque fill. That shipped through lint,
// typecheck, unit, parity and e2e because the only thing that would have caught
// it is a screenshot gate covering the legacy client, not this one.
//
// Keeping the assignment here makes the ordering testable without a GPU.

import { LAYERS, type LayerId } from "../sites/asset-manifest";

/** Retained (hand-authored) elements of the wreck scene. */
export type RetainedElement =
  | "sky"
  | "surface"
  | "distantHull"
  | "seabed"
  | "hull"
  | "rooms"
  | "engine"
  | "route"
  | "silt"
  | "diver"
  | "shark";

/**
 * Insertion order within a layer is preserved, so `route` before `silt` before
 * `diver` is meaningful: it reproduces the pre-refactor draw order exactly.
 *
 * Why each sits where it does:
 * - `sky`, `surface` — the air above the water and the water's surface
 *   (#199). Behind everything, and first in their layer: nothing in the
 *   scene reaches above the surface, and the diver floats in front of it.
 * - `distantHull` — parallax silhouette behind everything below the surface.
 * - `seabed` — ground the wreck rests on.
 * - `hull`, `rooms`, `engine` — the wreck itself, opaque, occludes the seabed.
 * - `route`, `silt`, `diver` — everything between the camera and the wreck.
 *   Silt is suspended particulate, not ground cover; below `structure` the hull
 *   eats it.
 * - `shark` — the shark encounter (#219). In front of the wreck, behind the
 *   diver and the bubbles: legacy draws it after its wildlife and before the
 *   diver (src/renderer.js drawScene).
 */
export const RETAINED_LAYER_ASSIGNMENT: Readonly<Record<RetainedElement, LayerId>> =
  Object.freeze({
    sky: "backdrop",
    surface: "backdrop",
    distantHull: "backdrop",
    seabed: "terrain",
    hull: "structure",
    rooms: "structure",
    engine: "structure",
    route: "foreground",
    silt: "foreground",
    diver: "foreground",
    shark: "fauna",
  });

/** Bubbles are pooled separately from the retained elements but share a layer. */
export const BUBBLE_LAYER: LayerId = "foreground";

/** Painter's-algorithm index: higher draws later, so higher occludes lower. */
export function layerDepth(id: LayerId): number {
  return LAYERS.indexOf(id);
}

/**
 * World-space half-extents of what the camera can actually show.
 *
 * Shared with the renderer rather than restated there, so a test can compare it
 * against the viewport arithmetic independently. The camera fits a constant
 * width in metres, so visible HEIGHT is a function of aspect ratio: at 390x844
 * it is ~125 m against the 20 m constant this replaced, which culled four
 * on-screen placements — the engine row at d=61 and the anchor at d=66.
 */
export function visibleHalfExtentM(camera: {
  readonly scale: number;
  readonly viewport: { readonly width: number; readonly height: number };
}): { readonly halfWidthM: number; readonly halfHeightM: number } {
  return {
    halfWidthM: camera.viewport.width / camera.scale / 2,
    halfHeightM: camera.viewport.height / camera.scale / 2,
  };
}

/** True if `a` is painted after `b`, and so can occlude it. */
export function drawsAfter(a: LayerId, b: LayerId): boolean {
  return layerDepth(a) > layerDepth(b);
}
