import { describe, expect, it } from "vitest";

import { narcosisVignetteAlpha, narcosisWobblePx } from "../../src/render/narcosis-view";

// Narcosis on the view (#220): legacy's tunnel vision and wobble
// (src/renderer.js drawScene, WP-020) as numbers for the renderer, legacy's
// formulas written out here. Legacy's blur and grayscale are not ported
// (docs/decisions.md, "Deliberate departures from the legacy client").

describe("narcosis on the view", () => {
  it("darkens the edges above 0.15 by min(0.7, (index - 0.15) * 0.82)", () => {
    expect(narcosisVignetteAlpha(0)).toBe(0);
    expect(narcosisVignetteAlpha(0.15)).toBe(0);
    expect(narcosisVignetteAlpha(0.4)).toBeCloseTo(0.205, 12);
    // Legacy's cap is out of reach: index 1 gives 0.85 * 0.82.
    expect(narcosisVignetteAlpha(1)).toBeCloseTo(0.697, 12);
  });

  it("wobbles above 0.25 by (index - 0.25) * 8 px, on the scene's real time", () => {
    expect(narcosisWobblePx(0.25, 1.234)).toEqual({ x: 0, y: 0 });
    const wobble = narcosisWobblePx(0.75, 1.5);
    // Legacy's Date.now() * 0.002 and * 0.0015, at 1500 ms.
    expect(wobble.x).toBeCloseTo(Math.sin(3) * 4, 12);
    expect(wobble.y).toBeCloseTo(Math.cos(2.25) * 4 * 0.5, 12);
  });
});
