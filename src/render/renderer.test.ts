import { describe, expect, it } from "vitest";

import { resolveRendererKind, selectWreckZone } from "./renderer";

describe("renderer selection", () => {
  it("allows the Canvas comparison renderer only in development", () => {
    expect(resolveRendererKind("?renderer=canvas", true)).toBe("canvas");
    expect(resolveRendererKind("?renderer=pixi", true)).toBe("pixi");
    expect(resolveRendererKind("?renderer=canvas", false)).toBe("pixi");
  });

  it("maps the representative route to stable wreck zones", () => {
    expect(selectWreckZone(20)).toBe("exterior");
    expect(selectWreckZone(45)).toBe("cargo-hold");
    expect(selectWreckZone(76)).toBe("engine-room");
  });
});
