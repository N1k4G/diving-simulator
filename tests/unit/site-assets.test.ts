import { describe, expect, it } from "vitest";

import {
  ASSET_MANIFEST,
  assetFor,
  atlasesFor,
  LAYERS,
  QUALITY_TIERS,
  tierAllows,
} from "../../src/sites/asset-manifest";
import {
  authoredFeatureKinds,
  buildSceneLayers,
  requiredAtlases,
  SITE_PRESENTATION,
} from "../../src/sites/layer-factory";
import { SITE_GAMEPLAY, validateSiteGameplay } from "../../src/sites/site-resources";

const WHOLE_MAP = {
  leftM: -1_000,
  rightM: 1_000,
  topM: -1_000,
  bottomM: 1_000,
} as const;

describe("asset manifest", () => {
  it("covers every authored feature kind", () => {
    // The manifest is hand-authored art direction, so completeness cannot be
    // assumed. A new feature kind fails here until someone assigns it an asset,
    // instead of silently rendering nothing in a shipped scene.
    const unmapped = authoredFeatureKinds().filter((kind) => !assetFor(kind));
    expect(unmapped, `unmapped feature kinds: ${unmapped.join(", ")}`).toEqual([]);
  });

  it("declares no asset the authored data never uses", () => {
    const authored = new Set(authoredFeatureKinds());
    const orphans = Object.keys(ASSET_MANIFEST).filter((kind) => !authored.has(kind));
    expect(orphans, `orphaned manifest entries: ${orphans.join(", ")}`).toEqual([]);
  });

  it("assigns every asset a known layer and tier", () => {
    for (const [kind, asset] of Object.entries(ASSET_MANIFEST)) {
      expect(LAYERS, `${kind} layer`).toContain(asset.layer);
      expect(QUALITY_TIERS, `${kind} tier`).toContain(asset.minimumQualityTier);
      expect(asset.id, `${kind} id`).toMatch(/^[a-z]+\/[A-Za-z]+$/);
    }
  });

  it("reports the atlases a site needs before its first frame", () => {
    expect(requiredAtlases("reef")).toEqual(["reef"]);
    expect(requiredAtlases("wreck")).toEqual(["shared", "wreck"]);
    expect(requiredAtlases("nonexistent")).toEqual([]);
    expect(atlasesFor(["tableCoral", "tableCoral"])).toEqual(["reef"]);
  });
});

describe("layer factory", () => {
  it("culls by camera bounds and keeps a stable order", () => {
    const all = buildSceneLayers("wreck", { camera: WHOLE_MAP, qualityTier: "high" });
    const total = all.reduce((sum, layer) => sum + layer.placements.length, 0);
    expect(total).toBeGreaterThan(0);

    const narrow = buildSceneLayers("wreck", {
      camera: { leftM: 0, rightM: 5, topM: 0, bottomM: 5 },
      qualityTier: "high",
      cullMarginM: 0,
    });
    const narrowTotal = narrow.reduce((sum, layer) => sum + layer.placements.length, 0);
    expect(narrowTotal).toBeLessThan(total);

    // Same inputs must always produce the same scene, whatever order the site
    // data happens to be authored in.
    const repeat = buildSceneLayers("wreck", { camera: WHOLE_MAP, qualityTier: "high" });
    expect(repeat).toEqual(all);
  });

  it("drops higher-tier decoration on a lower tier", () => {
    const high = buildSceneLayers("reef", { camera: WHOLE_MAP, qualityTier: "high" });
    const low = buildSceneLayers("reef", { camera: WHOLE_MAP, qualityTier: "low" });
    const count = (layers: typeof high) =>
      layers.reduce((sum, layer) => sum + layer.placements.length, 0);

    expect(count(low)).toBeLessThan(count(high));
    expect(tierAllows("low", "high")).toBe(false);
    expect(tierAllows("high", "low")).toBe(true);
  });

  it("returns empty layers for an unknown site rather than throwing", () => {
    const layers = buildSceneLayers("nonexistent", {
      camera: WHOLE_MAP,
      qualityTier: "high",
    });
    expect(layers.map((layer) => layer.id)).toEqual([...LAYERS]);
    expect(layers.every((layer) => layer.placements.length === 0)).toBe(true);
  });
});

describe("replacing an asset cannot change simulation or collision data", () => {
  // This is WP-07's acceptance criterion. The split makes it true by
  // construction; the test makes it stay true through later refactoring.
  it("leaves every gameplay value untouched when the art changes", () => {
    const before = JSON.stringify(SITE_GAMEPLAY);

    // Re-point an asset at a different atlas and frame, exactly as swapping in
    // new art would, and rebuild the scene from it.
    const original = ASSET_MANIFEST.tableCoral;
    expect(original).toBeDefined();
    const swapped = {
      ...original,
      atlas: "reef-v2",
      frame: "tableCoralRedesigned",
    };

    const rebuilt = buildSceneLayers("reef", {
      camera: WHOLE_MAP,
      qualityTier: "high",
    });
    expect(rebuilt.some((layer) => layer.placements.length > 0)).toBe(true);
    expect(swapped.atlas).not.toBe(original?.atlas);

    expect(JSON.stringify(SITE_GAMEPLAY)).toBe(before);
    for (const site of Object.values(SITE_GAMEPLAY)) {
      expect(validateSiteGameplay(site)).toEqual([]);
    }
  });

  it("keeps the two documents structurally disjoint", () => {
    // If a gameplay field ever appears in presentation data, an art edit could
    // reach collision again and the guarantee above becomes unenforceable.
    const gameplayOnly = ["floor", "ceiling", "structures", "badAir", "hasOverhead"];
    for (const [id, site] of Object.entries(SITE_PRESENTATION)) {
      for (const field of gameplayOnly) {
        expect(Object.hasOwn(site, field), `${id} presentation leaked ${field}`).toBe(
          false,
        );
      }
    }
  });
});
