import { describe, expect, it } from "vitest";

import { createBootstrapDiagnostic } from "./bootstrap";

describe("createBootstrapDiagnostic", () => {
  it("describes the isolated migration client and legacy handoff", () => {
    const diagnostic = createBootstrapDiagnostic("8.0.0-test");

    expect(diagnostic).toEqual({
      heading: "Diving Simulator",
      milestone: "WP-02 dual-client bootstrap",
      pixiVersion: "8.0.0-test",
      legacyClientUrl: "/src/diving-simulator.html",
    });
  });
});
