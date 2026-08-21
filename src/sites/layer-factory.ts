// WP-07: renderer-neutral scene assembly.
//
// Produces an ordered, culled list of placements from presentation data. It
// builds no Pixi objects, so it is testable without a GPU and a second renderer
// could consume the same output. The Pixi scene becomes a consumer of this
// rather than a hand-written pile of Graphics calls.

import presentationDocument from "./resources/presentation.json";
import { deepFreeze } from "./deep-freeze";
import {
  assetFor,
  atlasesFor,
  LAYERS,
  tierAllows,
  type AssetEntry,
  type LayerId,
  type QualityTier,
} from "./asset-manifest";

/**
 * Authored features are not uniform. Some are points with a `d`; others span a
 * depth range with `dTop`/`dBottom`, and kinds carry their own extra fields.
 * Model that rather than assuming a shape the data does not have.
 */
export interface SiteFeature {
  readonly kind: string;
  readonly x: number;
  readonly d?: number;
  readonly dTop?: number;
  readonly dBottom?: number;
  readonly [extra: string]: unknown;
}

/** Depth a feature is anchored at: its point, or the top of its span. */
export function featureDepth(feature: SiteFeature): number {
  return feature.d ?? feature.dTop ?? 0;
}

/**
 * Vertical extent a feature actually occupies. Culling has to use this rather
 * than the anchor: a cave column spans 42 m from `dTop` to `dBottom`, so a diver
 * swimming near its base is well outside the anchor's cull window while the
 * column still fills the screen. Anchoring and culling are different questions.
 */
export function featureDepthRange(feature: SiteFeature): {
  readonly top: number;
  readonly bottom: number;
} {
  const anchor = featureDepth(feature);
  const top = feature.dTop ?? anchor;
  const bottom = feature.dBottom ?? anchor;
  return top <= bottom ? { top, bottom } : { top: bottom, bottom: top };
}

export interface SitePresentation {
  readonly id: string;
  readonly name?: string;
  readonly features?: readonly SiteFeature[];
}

export interface CameraBounds {
  readonly leftM: number;
  readonly rightM: number;
  readonly topM: number;
  readonly bottomM: number;
}

export interface Placement {
  readonly assetId: string;
  readonly atlas: string;
  readonly frame: string;
  readonly x: number;
  readonly d: number;
}

export interface SceneLayer {
  readonly id: LayerId;
  readonly placements: readonly Placement[];
}

const presentation = (
  presentationDocument as { sites: Record<string, SitePresentation> }
).sites;

export const SITE_PRESENTATION: Readonly<Record<string, SitePresentation>> =
  deepFreeze(presentation);

export function sitePresentation(id: string): SitePresentation | null {
  return SITE_PRESENTATION[id] ?? null;
}

/** Every feature kind the authored data uses, across all sites. */
export function authoredFeatureKinds(): string[] {
  const kinds = new Set<string>();
  for (const site of Object.values(SITE_PRESENTATION)) {
    for (const feature of site.features ?? []) {
      kinds.add(feature.kind);
    }
  }
  return [...kinds].sort();
}

/** Atlases a site needs loaded before its first frame. */
export function requiredAtlases(siteId: string): string[] {
  const site = sitePresentation(siteId);
  if (!site) {
    return [];
  }
  return atlasesFor((site.features ?? []).map((feature) => feature.kind));
}

export interface BuildOptions {
  readonly camera: CameraBounds;
  readonly qualityTier: QualityTier;
  /** Expand the cull window so content is ready before it scrolls in. */
  readonly cullMarginM?: number;
}

export function buildSceneLayers(
  siteId: string,
  options: BuildOptions,
): SceneLayer[] {
  const site = sitePresentation(siteId);
  const byLayer = new Map<LayerId, Placement[]>(
    LAYERS.map((layer) => [layer, [] as Placement[]]),
  );
  if (!site) {
    return LAYERS.map((id) => ({ id, placements: [] }));
  }

  const margin = options.cullMarginM ?? 10;
  const { camera } = options;

  for (const feature of site.features ?? []) {
    const asset: AssetEntry | null = assetFor(feature.kind);
    if (!asset) {
      // Unmapped kinds are dropped rather than thrown here; the completeness
      // test is what fails the build, so a data typo cannot blank a live scene.
      continue;
    }
    if (!tierAllows(options.qualityTier, asset.minimumQualityTier)) {
      continue;
    }
    const depth = featureDepth(feature);
    // Overlap test against the feature's whole extent, so a tall feature stays
    // in the scene for as long as any part of it is on screen.
    const span = featureDepthRange(feature);
    if (
      feature.x < camera.leftM - margin ||
      feature.x > camera.rightM + margin ||
      span.bottom < camera.topM - margin ||
      span.top > camera.bottomM + margin
    ) {
      continue;
    }

    byLayer.get(asset.layer)?.push({
      assetId: asset.id,
      atlas: asset.atlas,
      frame: asset.frame,
      x: feature.x,
      d: depth,
    });
  }

  // Stable draw order within a layer: nearer the surface first, then by x, so
  // the same data always produces the same scene regardless of authoring order.
  for (const placements of byLayer.values()) {
    placements.sort((a, b) => a.d - b.d || a.x - b.x || a.assetId.localeCompare(b.assetId));
  }

  return LAYERS.map((id) => ({
    id,
    placements: Object.freeze(byLayer.get(id) ?? []),
  }));
}
