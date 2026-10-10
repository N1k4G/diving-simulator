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
    // The hold starts with the deck, behind the bow visor's opening (#222).
    expect(selectWreckZone(21.9)).toBe("exterior");
    expect(selectWreckZone(22)).toBe("cargo-hold");
    expect(selectWreckZone(45)).toBe("cargo-hold");
    expect(selectWreckZone(76)).toBe("engine-room");
  });
});
