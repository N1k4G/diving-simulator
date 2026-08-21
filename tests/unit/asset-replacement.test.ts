// WP-07 acceptance criterion: "one asset can be replaced without changing
// simulation or collision data."
//
// Proving that needs the replacement to actually reach the layer factory. The
// earlier version of this test built a `swapped` object and then asserted only
// that it differed from the original — `buildSceneLayers` still resolved the
// unmodified manifest, so the test would have passed even if replacement had
// stopped working entirely.
//
// Mocking the manifest module is what a real art swap does: re-point a kind at
// a different atlas and frame. It lives in its own file because `vi.mock` is
// hoisted to the whole module, and the other suites need the real table.

import { beforeEach, describe, expect, it, vi } from "vitest";

const REPLACED_ATLAS = "reef-v2";
const REPLACED_FRAME = "tableCoralRedesigned";

vi.mock("../../src/sites/asset-manifest", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/sites/asset-manifest")>();
  const original = actual.ASSET_MANIFEST.tableCoral;
  const swapped = { ...original!, atlas: REPLACED_ATLAS, frame: REPLACED_FRAME };
  return {
    ...actual,
    assetFor: (kind: string) => (kind === "tableCoral" ? swapped : actual.assetFor(kind)),
  };
});

const { buildSceneLayers } = await import("../../src/sites/layer-factory");
const { SITE_GAMEPLAY, validateSiteGameplay } = await import(
  "../../src/sites/site-resources"
);
const { ASSET_MANIFEST } = await import("../../src/sites/asset-manifest");

const WHOLE_MAP = {
  leftM: -1_000,
  rightM: 1_000,
  topM: -1_000,
  bottomM: 1_000,
} as const;

const reefPlacements = () =>
  buildSceneLayers("reef", { camera: WHOLE_MAP, qualityTier: "high" }).flatMap(
    (layer) => layer.placements,
  );

describe("replacing an asset", () => {
  let gameplayBefore: string;

  beforeEach(() => {
    gameplayBefore = JSON.stringify(SITE_GAMEPLAY);
  });

  it("actually reaches the rendered scene", () => {
    // Guards the mock itself: if this stops resolving the swap, the assertions
    // below would pass vacuously exactly as the original test did.
    const tableCorals = reefPlacements().filter((p) => p.assetId === "reef/tableCoral");
    expect(tableCorals.length).toBeGreaterThan(0);
    for (const placement of tableCorals) {
      expect(placement.atlas).toBe(REPLACED_ATLAS);
      expect(placement.frame).toBe(REPLACED_FRAME);
    }
    // And the real table is genuinely different, so this is a replacement.
    expect(ASSET_MANIFEST.tableCoral?.atlas).not.toBe(REPLACED_ATLAS);
  });

  it("leaves every gameplay value byte-identical", () => {
    const placements = reefPlacements();
    expect(placements.length).toBeGreaterThan(0);
    expect(JSON.stringify(SITE_GAMEPLAY)).toBe(gameplayBefore);
  });

  it("leaves collision geometry valid and unchanged", () => {
    reefPlacements();
    for (const site of Object.values(SITE_GAMEPLAY)) {
      expect(validateSiteGameplay(site)).toEqual([]);
    }
    const reef = SITE_GAMEPLAY.reef;
    expect(reef?.floor).toBeDefined();
    expect(reef?.maxDepth).toBe(300);
    expect(reef?.structures).toEqual([]);
  });

  it("does not change which other kinds resolve", () => {
    // A swap must be local: re-pointing tableCoral cannot disturb its neighbours.
    const others = reefPlacements().filter((p) => p.assetId !== "reef/tableCoral");
    expect(others.length).toBeGreaterThan(0);
    for (const placement of others) {
      expect(placement.atlas).not.toBe(REPLACED_ATLAS);
    }
  });
});
