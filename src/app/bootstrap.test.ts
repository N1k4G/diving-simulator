import { describe, expect, it } from "vitest";

import { createBootstrapDiagnostic } from "./bootstrap";

describe("createBootstrapDiagnostic", () => {
  it("describes the isolated migration client and legacy handoff", () => {
    const diagnostic = createBootstrapDiagnostic("8.0.0-test", "en");

    expect(diagnostic).toEqual({
      heading: "Diving Simulator",
      eyebrow: "Migration diagnostic",
      milestone: "WP-02 dual-client bootstrap",
      pixiVersion: "8.0.0-test",
      legacyClientUrl: "/src/diving-simulator.html",
      statusLabels: {
        typescript: "TypeScript",
        vite: "Vite",
        pixi: "PixiJS",
        ready: "ready",
      },
      legacyLinkLabel: "Open the legacy simulator",
    });
  });
});
