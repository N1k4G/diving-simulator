import { describe, expect, it } from "vitest";

import { resolveRendererKind, selectWreckZone } from "./renderer";

describe("renderer selection", () => {
  it("allows the Canvas comparison renderer only in development", () => {
    expect(resolveRendererKind("?renderer=canvas", true)).toBe("canvas");
    expect(resolveRendererKind("?renderer=pixi", true)).toBe("pixi");
    expect(resolveRendererKind("?renderer=canvas", false)).toBe("pixi");
  });

  it("names legacy's wreck zones by position and depth (#240)", () => {
    // Off the bow, over the hull and past the stern: the exterior.
    expect(selectWreckZone(10, 5)).toBe("exterior");
    expect(selectWreckZone(30, 26)).toBe("exterior");
    expect(selectWreckZone(185, 40)).toBe("exterior");
    // Legacy's decks, top to bottom (src/sites.js visualZones).
    expect(selectWreckZone(90, 20)).toBe("bridge");
    expect(selectWreckZone(50, 25)).toBe("accommodation");
    expect(selectWreckZone(50, 32)).toBe("vehicle-deck");
    expect(selectWreckZone(50, 43)).toBe("crew-deck");
    expect(selectWreckZone(100, 50)).toBe("cargo-hold");
    expect(selectWreckZone(100, 57)).toBe("engine-room");
    expect(selectWreckZone(100, 64)).toBe("bilge");
    // The bow visor's opening is the vehicle deck's, open to the surface.
    expect(selectWreckZone(19, 30)).toBe("vehicle-deck");
    // Where two decks meet, the smaller wins: the crew deck at 40 m.
    expect(selectWreckZone(50, 40)).toBe("crew-deck");
    // Below every zone, under the seabed's 66 m: the exterior.
    expect(selectWreckZone(50, 67)).toBe("exterior");
  });
});
