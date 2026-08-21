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
  featureDepthRange,
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
  // The replacement half of this criterion needs the swap to actually reach the
  // layer factory, which needs the manifest module mocked — see
  // tests/unit/asset-replacement.test.ts. What stays here is the weaker but
  // still useful property: simply building a scene touches no gameplay data.
  it("leaves every gameplay value untouched when a scene is built", () => {
    const before = JSON.stringify(SITE_GAMEPLAY);

    const rebuilt = buildSceneLayers("reef", {
      camera: WHOLE_MAP,
      qualityTier: "high",
    });
    expect(rebuilt.some((layer) => layer.placements.length > 0)).toBe(true);

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

describe("culling accounts for a feature's full vertical extent", () => {
  // The cave columns span dTop=56..dBottom=98 and dTop=60..dBottom=95. Culling
  // on the anchor alone dropped them once the diver swam past their top, so
  // both 40 m columns vanished while the diver was still beside them.
  const columnsVisibleAt = (depth: number): number =>
    buildSceneLayers("cave", {
      qualityTier: "high",
      camera: { leftM: 88 - 34, rightM: 88 + 34, topM: depth - 20, bottomM: depth + 20 },
    })
      .flatMap((layer) => layer.placements)
      .filter((placement) => placement.assetId === "cave/caveColumn").length;

  it("keeps a tall feature while any part of it is on screen", () => {
    // Anchors are at 56 and 60; without span-aware culling these read 1 and 0.
    expect(columnsVisibleAt(90)).toBe(2);
    expect(columnsVisibleAt(95)).toBe(2);
  });

  it("still culls once the feature is genuinely out of range", () => {
    expect(columnsVisibleAt(10)).toBe(0);
    expect(columnsVisibleAt(160)).toBe(0);
  });

  it("reports the extent of point features and spans alike", () => {
    expect(featureDepthRange({ kind: "car", x: 34, d: 39 })).toEqual({ top: 39, bottom: 39 });
    expect(featureDepthRange({ kind: "caveColumn", x: 88, dTop: 56, dBottom: 98 })).toEqual({
      top: 56,
      bottom: 98,
    });
    // Inverted authoring should not silently disable the feature.
    expect(featureDepthRange({ kind: "x", x: 0, dTop: 98, dBottom: 56 })).toEqual({
      top: 56,
      bottom: 98,
    });
  });
});

describe("resource documents are deeply immutable", () => {
  // Object.freeze is shallow, so the nested arrays stayed writable and the
  // immutability these modules advertise was nominal. Collision geometry that
  // any consumer can mutate in place is the failure this guards.
  it("refuses in-place mutation of nested gameplay geometry", () => {
    const wreck = SITE_GAMEPLAY.wreck;
    expect(wreck).toBeDefined();
    if (!wreck) return;
    expect(Object.isFrozen(wreck.structures)).toBe(true);
    expect(Object.isFrozen(wreck.structures[0])).toBe(true);
    expect(() => {
      (wreck.structures as unknown as { x1: number }[])[0]!.x1 = -999;
    }).toThrow();
    expect(wreck.structures[0]?.x1).not.toBe(-999);
  });

  it("refuses in-place mutation of nested presentation features", () => {
    const cave = SITE_PRESENTATION.cave;
    expect(cave).toBeDefined();
    if (!cave?.features) return;
    expect(Object.isFrozen(cave.features)).toBe(true);
    expect(() => {
      (cave.features as unknown as { x: number }[])[0]!.x = -999;
    }).toThrow();
  });
});
