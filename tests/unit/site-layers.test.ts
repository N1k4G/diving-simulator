// Structural guard for scene draw order.
//
// The silt regression — assigned to `terrain`, below `structure`, which put 31
// of its 48 particles behind the hull's opaque fill — passed lint, typecheck,
// unit, parity and e2e. The only thing that would have caught it is a
// screenshot gate, and that covers the legacy client, not the Pixi one.
//
// These assertions cost milliseconds and need no GPU. They cannot see that a
// scene *looks* right, but they can see that something which must occlude
// another thing is still painted after it, which is the class of mistake that
// actually happened.

import { describe, expect, it } from "vitest";

import { LAYERS, type LayerId } from "../../src/sites/asset-manifest";
import {
  BUBBLE_LAYER,
  drawsAfter,
  layerDepth,
  RETAINED_LAYER_ASSIGNMENT,
  visibleHalfExtentM,
  type RetainedElement,
} from "../../src/render/layer-assignment";
import { SITE_PRESENTATION } from "../../src/sites/layer-factory";
import { ASSET_MANIFEST } from "../../src/sites/asset-manifest";
import { buildSceneLayers } from "../../src/sites/layer-factory";
import { createCameraTransform } from "../../src/render/camera";

const layerOf = (element: RetainedElement): LayerId =>
  RETAINED_LAYER_ASSIGNMENT[element];

describe("layer ordering is painter's-algorithm sane", () => {
  it("orders the layer list from furthest to nearest", () => {
    expect(LAYERS).toEqual([
      "backdrop",
      "terrain",
      "structure",
      "decoration",
      "fauna",
      "foreground",
    ]);
  });

  it("assigns every retained element to a real layer", () => {
    for (const [element, id] of Object.entries(RETAINED_LAYER_ASSIGNMENT)) {
      expect(LAYERS, `${element} -> ${id}`).toContain(id);
    }
  });

  it("gives every asset a real layer too", () => {
    for (const entry of Object.values(ASSET_MANIFEST)) {
      expect(LAYERS, `${entry.id} -> ${entry.layer}`).toContain(entry.layer);
    }
  });
});

describe("elements between the camera and the wreck are not painted behind it", () => {
  // This is the assertion that would have caught the silt regression.
  it.each(["silt", "route", "diver"] as const)(
    "paints %s after the opaque hull",
    (element) => {
      expect(drawsAfter(layerOf(element), layerOf("hull"))).toBe(true);
    },
  );

  it("paints bubbles after the hull", () => {
    expect(drawsAfter(BUBBLE_LAYER, layerOf("hull"))).toBe(true);
  });

  it("keeps silt above every opaque structural element", () => {
    for (const element of ["hull", "rooms", "engine"] as const) {
      expect(
        drawsAfter(layerOf("silt"), layerOf(element)),
        `silt must draw after ${element}`,
      ).toBe(true);
    }
  });
});

describe("the wreck occludes what is behind it", () => {
  it("paints the hull after the seabed it rests on", () => {
    expect(drawsAfter(layerOf("hull"), layerOf("seabed"))).toBe(true);
  });

  it("paints the seabed after the parallax silhouette", () => {
    expect(drawsAfter(layerOf("seabed"), layerOf("distantHull"))).toBe(true);
  });

  it("keeps the distant hull furthest back of anything retained", () => {
    const distant = layerDepth(layerOf("distantHull"));
    for (const element of Object.keys(RETAINED_LAYER_ASSIGNMENT) as RetainedElement[]) {
      if (element === "distantHull") continue;
      expect(layerDepth(layerOf(element)), element).toBeGreaterThanOrEqual(distant);
    }
  });
});

describe("data-driven placements sit where their role implies", () => {
  // Structural props (cars, columns, the helm) are solid-looking and must not
  // be painted behind the terrain they stand on.
  it("paints structural assets after terrain", () => {
    const structural = Object.values(ASSET_MANIFEST).filter(
      (entry) => entry.layer === "structure",
    );
    expect(structural.length).toBeGreaterThan(0);
    expect(drawsAfter("structure", "terrain")).toBe(true);
  });

  it("paints decoration after the structures it dresses", () => {
    expect(drawsAfter("decoration", "structure")).toBe(true);
  });

  it("paints fauna after decoration, and foreground after everything", () => {
    expect(drawsAfter("fauna", "decoration")).toBe(true);
    for (const id of LAYERS) {
      if (id === "foreground") continue;
      expect(drawsAfter("foreground", id), `foreground vs ${id}`).toBe(true);
    }
  });
});

describe("the cull window follows the viewport, not a constant", () => {
  // The camera fits a constant 58 m of WIDTH, so visible HEIGHT is
  // viewport.height / scale and grows with aspect ratio. A fixed 20 m
  // half-height described the desktop window and nothing else: at 390x844 the
  // screen shows ~125 m of depth, and four on-screen placements — the engine
  // row at d=61 and the anchor at d=66 — were culled while in frame.
  // The cull window comes from the renderer's own helper. What is on screen is
  // computed here from viewport arithmetic instead, so the two are not the same
  // number wearing different hats — pinning the helper back to a constant has
  // to fail this, not agree with it.
  const windowFor = (width: number, height: number) => {
    const camera = createCameraTransform({ width, height }, { x: 58, y: 25 });
    const cull = visibleHalfExtentM(camera);
    const screenHalfW = width / camera.scale / 2;
    const screenHalfH = height / camera.scale / 2;
    return { camera, cull, screenHalfW, screenHalfH };
  };

  it.each([
    [390, 844],
    [320, 568],
    [1280, 800],
    [844, 390],
  ])("covers everything on screen at %ix%i", (width, height) => {
    const { camera, cull, screenHalfW, screenHalfH } = windowFor(width, height);
    const layers = buildSceneLayers("wreck", {
      qualityTier: "high",
      cullMarginM: 10,
      camera: {
        leftM: camera.focus.x - cull.halfWidthM,
        rightM: camera.focus.x + cull.halfWidthM,
        topM: camera.focus.y - cull.halfHeightM,
        bottomM: camera.focus.y + cull.halfHeightM,
      },
    });
    const kept = new Set(
      layers.flatMap((l) => l.placements).map((p) => `${p.x},${p.d}`),
    );

    // Anything inside the visible rectangle must survive culling.
    const site = SITE_PRESENTATION.wreck;
    for (const feature of site?.features ?? []) {
      if (!ASSET_MANIFEST[feature.kind]) continue;
      const d = feature.d ?? feature.dTop ?? 0;
      const onScreen =
        feature.x >= camera.focus.x - screenHalfW &&
        feature.x <= camera.focus.x + screenHalfW &&
        d >= camera.focus.y - screenHalfH &&
        d <= camera.focus.y + screenHalfH;
      if (onScreen) {
        expect(kept.has(`${feature.x},${d}`), `${feature.kind} (${feature.x},${d})`).toBe(
          true,
        );
      }
    }
  });

  it("never culls inside the visible rectangle, at any aspect ratio", () => {
    for (const [w, h] of [[390, 844], [320, 568], [1280, 800], [844, 390], [412, 915]]) {
      const { cull, screenHalfW, screenHalfH } = windowFor(w!, h!);
      expect(cull.halfWidthM, `${w}x${h} width`).toBeGreaterThanOrEqual(screenHalfW);
      expect(cull.halfHeightM, `${w}x${h} height`).toBeGreaterThanOrEqual(screenHalfH);
    }
  });

  it("grows the window as a portrait viewport gets taller", () => {
    expect(windowFor(390, 844).cull.halfHeightM).toBeGreaterThan(
      windowFor(1280, 800).cull.halfHeightM,
    );
    expect(windowFor(390, 844).cull.halfHeightM).toBeGreaterThan(20);
  });
});
