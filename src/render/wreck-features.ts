// The wreck's engines and its bow visor (#240 PR 4), after legacy's
// src/renderer.js drawEngine and drawBowVisor. They stand where legacy's site
// puts them (src/sites.js features, carried into the presentation resource),
// and the scene receives them as placements like any other feature. This is
// their flat placeholder shape in metres, at legacy's 0.05 m a pixel,
// relative to the feature's anchor, depth downward. Looks stay placeholder
// until #157. Drawn only: collision reads the structures alone
// (src/sites/site-collision.ts), so the diver passes through both, as in
// legacy.

import { assetFor } from "../sites/asset-manifest";
import { LEGACY_M_PER_PX } from "./surface-boat";

export interface FeatureRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type FeaturePoint = readonly [x: number, y: number];

function px(value: number): number {
  return value * LEGACY_M_PER_PX;
}

function rect(x: number, y: number, width: number, height: number): FeatureRect {
  return Object.freeze({ x: px(x), y: px(y), width: px(width), height: px(height) });
}

function polyline(...points: FeaturePoint[]): readonly FeaturePoint[] {
  return Object.freeze(points.map(([x, y]) => Object.freeze([px(x), px(y)] as const)));
}

export interface EngineShape {
  /** The base block, the lower 55 % of the engine. */
  readonly block: FeatureRect;
  /** The row of six cylinder heads above it. */
  readonly heads: readonly FeatureRect[];
  /** An exhaust riser up from each head to the engine's top. */
  readonly risers: readonly FeatureRect[];
  /** The side pipes, out from the block and down to the deck, port then starboard. */
  readonly pipes: readonly (readonly FeaturePoint[])[];
  readonly pipeWidth: number;
}

/**
 * drawEngine's block, 88 by 64 px, standing on its anchor and centred on it:
 * the base block, the six cylinder heads and their exhaust risers, and the
 * two side pipes, as legacy computes them. Its trim, gauges, nameplate,
 * algae and rust are left to #157.
 */
export const ENGINE_SHAPE: EngineShape = (() => {
  const w = 88;
  const h = 64;
  const bx = -w / 2;
  const by = -h;
  const cylW = (w * 0.84) / 6;
  const heads: FeatureRect[] = [];
  const risers: FeatureRect[] = [];
  for (let c = 0; c < 6; c += 1) {
    const cxl = bx + w * 0.08 + c * cylW;
    heads.push(rect(cxl, by + h * 0.25, cylW - 3, h * 0.22));
    risers.push(rect(cxl + (cylW - 3) / 2 - 2, by, 4, h * 0.25));
  }
  return Object.freeze({
    block: rect(bx, by + h * 0.45, w, h * 0.55),
    heads: Object.freeze(heads),
    risers: Object.freeze(risers),
    pipes: Object.freeze([
      polyline([bx, by + h * 0.6], [bx - 10, by + h * 0.6], [bx - 10, by + h]),
      polyline([bx + w, by + h * 0.6], [bx + w + 10, by + h * 0.6], [bx + w + 10, by + h]),
    ]),
    pipeWidth: px(2),
  });
})();

export interface BowVisorShape {
  /** Turned about its anchor, as legacy's canvas is: negative lifts its +x end. */
  readonly rotationRad: number;
  /** The door slab, 72 by 20 px, centred on the anchor before the turn. */
  readonly slab: FeatureRect;
  /** The plate seam along its middle. */
  readonly seam: readonly FeaturePoint[];
  readonly seamWidth: number;
  /** The hinge spindle at its +x end. */
  readonly hinge: { readonly x: number; readonly y: number; readonly radius: number };
}

/**
 * drawBowVisor's door, hinged up over the bow opening: the slab turned
 * 0.35 pi up, its seam and its hinge spindle. Legacy's gradient is one flat
 * colour here, and its rivets and anchor recess are left to #157.
 */
export const BOW_VISOR_SHAPE: BowVisorShape = Object.freeze({
  rotationRad: -Math.PI * 0.35,
  slab: rect(-36, -10, 72, 20),
  seam: polyline([-36, 0], [36, 0]),
  seamWidth: px(0.8),
  hinge: Object.freeze({ x: px(36), y: 0, radius: px(2.5) }),
});

/** The asset ids the scene draws in these shapes, every other placement a provisional marker. */
export const ENGINE_ASSET_ID = assetId("engine");
export const BOW_VISOR_ASSET_ID = assetId("bowVisor");

function assetId(kind: string): string {
  const asset = assetFor(kind);
  if (!asset) throw new Error(`no asset for the wreck's ${kind}`);
  return asset.id;
}
