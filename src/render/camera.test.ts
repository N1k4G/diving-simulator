import { describe, expect, it } from "vitest";

import { createCameraTransform, worldToScreen, wreckCameraFocusX, wreckViewAround } from "./camera";

describe("wreck camera", () => {
  it("centres its focus and keeps world coordinates stable", () => {
    const camera = createCameraTransform(
      { width: 1160, height: 600 },
      { x: 58, y: 25 },
    );

    expect(camera.scale).toBe(20);
    expect(worldToScreen({ x: 58, y: 25 }, camera)).toEqual({
      x: 580,
      y: 300,
    });
    expect(worldToScreen({ x: 59, y: 26 }, camera)).toEqual({
      x: 600,
      y: 320,
    });
  });

  it("clamps the focus so the camera does not reveal outside the site (#240)", () => {
    const camera = createCameraTransform(
      { width: 580, height: 300 },
      { x: -100, y: 100 },
    );

    // 58 m across and 30 m down: half of each inside x -40 and 68 m.
    expect(camera.focus).toEqual({ x: -40 + 29, y: 68 - 15 });
  });

  it("shows the surface, with sky above it, to a diver floating there (#199)", () => {
    const viewport = { width: 960, height: 540 };
    const camera = createCameraTransform(viewport, { x: 18, y: 0 });
    const surface = worldToScreen({ x: 18, y: 0 }, camera);
    expect(surface.y).toBeGreaterThan(0);
    expect(surface.y).toBeLessThan(viewport.height / 2);
  });

  it("follows the diver down from the sky in a view taller than the site (#240)", () => {
    // 390x844 shows 58 m across and about 125 m down, more than the site's 74.
    const viewport = { width: 390, height: 844 };
    const halfHeightM = 844 / (390 / 58) / 2;
    expect(createCameraTransform(viewport, { x: 50, y: 10 }).focus.y).toBeCloseTo(-6 + halfHeightM, 12);
    expect(createCameraTransform(viewport, { x: 50, y: 66 }).focus.y).toBe(66);
  });

  it("rejects invalid viewport dimensions", () => {
    expect(() =>
      createCameraTransform({ width: 0, height: 300 }, { x: 20, y: 20 }),
    ).toThrow(RangeError);
  });
});

// The view to either side of the diver, for the shark's spawn and exit (#219
// part 2, owner decision of 2026-10-07): the camera's edges, lead and clamp
// included, whatever the viewport.
describe("the wreck camera's view around the diver", () => {
  it.each([
    [10, 1],
    [10, -1],
    [50, 1],
    [50, -1],
    [100, 1],
    [100, -1],
  ] as const)("reaches the screen's edges from route position %d facing %d", (positionM, facing) => {
    for (const viewport of [{ width: 1160, height: 600 }, { width: 390, height: 844 }]) {
      const camera = createCameraTransform(viewport, { x: wreckCameraFocusX(positionM, facing), y: 20 });
      const view = wreckViewAround(positionM, facing);
      expect(worldToScreen({ x: positionM - view.leftM, y: 20 }, camera).x).toBeCloseTo(0, 9);
      expect(worldToScreen({ x: positionM + view.rightM, y: 20 }, camera).x).toBeCloseTo(viewport.width, 9);
    }
  });

  it("leads the diver by 8 m where the scene's bounds allow", () => {
    expect(wreckViewAround(50, 1)).toEqual({ leftM: 21, rightM: 37 });
    expect(wreckViewAround(50, -1)).toEqual({ leftM: 37, rightM: 21 });
    // At the route's start too, now the site reaches past it (#240); held
    // only at the site's own bound, x -40.
    expect(wreckViewAround(10, 1)).toEqual({ leftM: 21, rightM: 37 });
    expect(wreckViewAround(-35, -1)).toEqual({ leftM: 5, rightM: 53 });
  });
});
