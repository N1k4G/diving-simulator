import { describe, expect, it } from "vitest";

import { diveUnderway } from "../../src/render/renderer";
import {
  BOAT_SHADOW_DEPTH_M,
  BOAT_X_M,
  boatBobM,
  boatRockRad,
  boatShadowStrength,
  boatShadowSwayM,
  nearSurfaceLightFactor,
} from "../../src/render/surface-boat";
import { ROUTE_START_POSITION_M } from "../../src/sites/wreck-route";

// The dive boat and its shadow (#222), after legacy's src/renderer.js:
// drawScene's "Ship on surface", nearSurfaceLightFactor,
// _nearSurfaceSiteMultiplier and _drawBoatShadow, their numbers written out
// here at legacy's 0.05 m a pixel.

describe("the boat at the surface", () => {
  it("is moored 5 m from where the dive starts, as legacy's wreck has it (entry.x 0, boatX 5)", () => {
    expect(ROUTE_START_POSITION_M).toBe(10);
    expect(BOAT_X_M).toBe(15);
  });

  it("bobs 2.2 px and rocks 0.022 rad on the waves' real time", () => {
    expect(boatBobM(0)).toBe(0);
    expect(boatBobM(2)).toBeCloseTo(Math.sin(1.8) * 2.2 * 0.05, 12);
    expect(boatRockRad(2)).toBeCloseTo(Math.sin(1.5) * 0.022, 12);
  });

  it("casts its shadow 6 px under the surface, swaying 1.4 px", () => {
    expect(BOAT_SHADOW_DEPTH_M).toBeCloseTo(0.3, 12);
    expect(boatShadowSwayM(2)).toBeCloseTo(Math.sin(1.8) * 1.4 * 0.05, 12);
  });
});

describe("the boat's shadow", () => {
  it("follows legacy's near-surface light: full to 5 m, 0.15 at 12 m, none from 20 m", () => {
    expect(nearSurfaceLightFactor(0)).toBe(1);
    expect(nearSurfaceLightFactor(5)).toBe(1);
    // Halfway down each smoothstep: 0.5 * 0.85 + 0.15, then 0.5 * 0.15.
    expect(nearSurfaceLightFactor(8.5)).toBeCloseTo(0.575, 12);
    expect(nearSurfaceLightFactor(12)).toBeCloseTo(0.15, 12);
    expect(nearSurfaceLightFactor(16)).toBeCloseTo(0.075, 12);
    expect(nearSurfaceLightFactor(20)).toBe(0);
  });

  it("is the light at the wreck's 0.4, and none at or below 0.02, which is from about 17 m", () => {
    expect(boatShadowStrength(true, false, 3)).toBeCloseTo(0.4, 12);
    expect(boatShadowStrength(true, false, 16)).toBeCloseTo(0.03, 12);
    // At 17 m legacy's eff is 0.019 and it draws none.
    expect(boatShadowStrength(true, false, 17)).toBe(0);
  });

  it("shows only while the dive is under way, and never in the overhead", () => {
    expect(boatShadowStrength(false, false, 3)).toBe(0);
    expect(boatShadowStrength(true, true, 3)).toBe(0);
  });
});

describe("a dive under way, legacy's 'diving' state", () => {
  const dive = {
    elapsedTimeS: 60,
    depthM: 4,
    completed: false,
    failureReason: null,
  } as const;

  it("is neither the wait at the surface nor a dive that has ended", () => {
    expect(diveUnderway(dive)).toBe(true);
    expect(diveUnderway({ ...dive, elapsedTimeS: 0, depthM: 0 })).toBe(false);
    expect(diveUnderway({ ...dive, depthM: 0, completed: true })).toBe(false);
    expect(diveUnderway({ ...dive, failureReason: "out-of-gas" })).toBe(false);
  });
});
