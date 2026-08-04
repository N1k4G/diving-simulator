import { describe, expect, it } from "vitest";

import { createCameraTransform, worldToScreen } from "./camera";

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

  it("clamps the focus so the camera does not reveal outside the route", () => {
    const camera = createCameraTransform(
      { width: 580, height: 300 },
      { x: -100, y: 100 },
    );

    expect(camera.focus).toEqual({ x: 29, y: 25 });
  });

  it("rejects invalid viewport dimensions", () => {
    expect(() =>
      createCameraTransform({ width: 0, height: 300 }, { x: 20, y: 20 }),
    ).toThrow(RangeError);
  });
});
