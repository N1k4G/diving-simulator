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
  type RetainedElement,
} from "../../src/render/layer-assignment";
import { ASSET_MANIFEST } from "../../src/sites/asset-manifest";

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
