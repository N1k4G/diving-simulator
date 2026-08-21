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
  | "distantHull"
  | "seabed"
  | "hull"
  | "rooms"
  | "engine"
  | "route"
  | "silt"
  | "diver";

/**
 * Insertion order within a layer is preserved, so `route` before `silt` before
 * `diver` is meaningful: it reproduces the pre-refactor draw order exactly.
 *
 * Why each sits where it does:
 * - `distantHull` — parallax silhouette behind everything.
 * - `seabed` — ground the wreck rests on.
 * - `hull`, `rooms`, `engine` — the wreck itself, opaque, occludes the seabed.
 * - `route`, `silt`, `diver` — everything between the camera and the wreck.
 *   Silt is suspended particulate, not ground cover; below `structure` the hull
 *   eats it.
 */
export const RETAINED_LAYER_ASSIGNMENT: Readonly<Record<RetainedElement, LayerId>> =
  Object.freeze({
    distantHull: "backdrop",
    seabed: "terrain",
    hull: "structure",
    rooms: "structure",
    engine: "structure",
    route: "foreground",
    silt: "foreground",
    diver: "foreground",
  });

/** Bubbles are pooled separately from the retained elements but share a layer. */
export const BUBBLE_LAYER: LayerId = "foreground";

/** Painter's-algorithm index: higher draws later, so higher occludes lower. */
export function layerDepth(id: LayerId): number {
  return LAYERS.indexOf(id);
}

/** True if `a` is painted after `b`, and so can occlude it. */
export function drawsAfter(a: LayerId, b: LayerId): boolean {
  return layerDepth(a) > layerDepth(b);
}
