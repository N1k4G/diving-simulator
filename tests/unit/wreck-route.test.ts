import { describe, expect, it } from "vitest";

import { selectWreckZone } from "../../src/render/renderer";
import {
  CARGO_HOLD_FROM_M,
  ENGINE_ROOM_FROM_M,
  MAX_SLIDE_SLOPE,
  OPEN_WATER_FLOOR_M,
  ROUTE_MAX_POSITION_M,
  ROUTE_MIN_POSITION_M,
  ROUTE_START_POSITION_M,
  WRECK_BOW_X_M,
  WRECK_DECK_TOP,
  WRECK_DECK_UNDERSIDE,
  WRECK_HOLD_FLOOR_M,
  WRECK_HOLD_STERN_X_M,
  WRECK_STERN_X_M,
  holdFloorAt,
  moveAlongRoute,
  profileAt,
  routeSpaceNear,
  routeSpacesAt,
} from "../../src/sites/wreck-route";

// The wreck route's bounds (#199 slice 7). Owner decision A on #199: outside
// the wreck the ceiling is the surface; inside, in the cargo hold and the
// engine room, it is the deck.

describe("where the diver can be along the wreck route", () => {
  it("is open to the surface outside the wreck", () => {
    expect(routeSpacesAt(ROUTE_START_POSITION_M)).toEqual([
      { ceilingM: 0, floorM: OPEN_WATER_FLOOR_M, inOverhead: false },
    ]);
    expect(routeSpacesAt(CARGO_HOLD_FROM_M - 0.01)).toHaveLength(1);
  });

  it("starts in open water off the bow, clear of the hull", () => {
    expect(ROUTE_START_POSITION_M).toBeLessThan(WRECK_BOW_X_M);
    expect(selectWreckZone(ROUTE_START_POSITION_M)).toBe("exterior");
  });

  it("has the deck above the diver in the cargo hold and the engine room, and open water above the deck", () => {
    for (const position of [CARGO_HOLD_FROM_M, 60, ENGINE_ROOM_FROM_M, 90, WRECK_HOLD_STERN_X_M]) {
      const [above, under] = routeSpacesAt(position);
      expect(above).toEqual({ ceilingM: 0, floorM: profileAt(WRECK_DECK_TOP, position), inOverhead: false });
      expect(under).toEqual({
        ceilingM: profileAt(WRECK_DECK_UNDERSIDE, position),
        floorM: WRECK_HOLD_FLOOR_M,
        inOverhead: true,
      });
      // The deck has thickness, and the hold has room.
      expect(under!.ceilingM).toBeGreaterThan(above!.floorM);
      expect(under!.floorM - under!.ceilingM).toBeGreaterThan(3);
    }
  });

  it("ends the hold at the stern wall the scene draws, with only open water past it (#223 pre-review)", () => {
    // The wall runs from the floor's end (99, 33.5) up to the underside's end
    // (103, 29.5).
    expect(holdFloorAt(WRECK_HOLD_STERN_X_M)).toBe(WRECK_HOLD_FLOOR_M);
    expect(holdFloorAt(101)).toBeCloseTo(31.5, 12);
    expect(routeSpacesAt(101)[1]).toEqual({
      ceilingM: profileAt(WRECK_DECK_UNDERSIDE, 101),
      floorM: holdFloorAt(101),
      inOverhead: true,
    });
    for (const position of [WRECK_STERN_X_M, 104, ROUTE_MAX_POSITION_M]) {
      expect(routeSpacesAt(position), `at ${position} m`).toEqual([
        { ceilingM: 0, floorM: profileAt(WRECK_DECK_TOP, position), inOverhead: false },
      ]);
    }
    // On the hold's floor, the wall stops a diver finning aft.
    expect(moveAlongRoute(99.4, 99.5, 33.2)).toBe(99.4);
    expect(moveAlongRoute(101, 101.1, 31.45)).toBe(101);
  });

  it("is in the overhead exactly where the zone says cargo hold or engine room, up to the stern wall", () => {
    for (let position = ROUTE_MIN_POSITION_M; position <= WRECK_HOLD_STERN_X_M; position += 0.5) {
      const inside = routeSpaceNear(position, 30).inOverhead;
      expect(inside, `at ${position} m`).toBe(selectWreckZone(position) !== "exterior");
      // Above the deck is never the overhead.
      expect(routeSpaceNear(position, 5).inOverhead, `at ${position} m`).toBe(false);
    }
  });

  it("interpolates the drawn deck, and holds it level past either end", () => {
    expect(profileAt(WRECK_DECK_UNDERSIDE, 27)).toBe(24.5);
    expect(profileAt(WRECK_DECK_UNDERSIDE, 54.5)).toBeCloseTo(23.75, 12);
    expect(profileAt(WRECK_DECK_UNDERSIDE, 0)).toBe(24.5);
    expect(profileAt(WRECK_DECK_UNDERSIDE, 106)).toBe(29.5);
  });
});

describe("swimming along the route", () => {
  it("swims freely in open water, and stops at the route's ends", () => {
    expect(moveAlongRoute(10, 11, 15)).toBe(11);
    expect(moveAlongRoute(9, 6, 15)).toBe(ROUTE_MIN_POSITION_M);
    expect(moveAlongRoute(105, 110, 2)).toBe(ROUTE_MAX_POSITION_M);
  });

  it("enters the hold under the deck, and crosses over it above the deck", () => {
    expect(moveAlongRoute(44.9, 45.1, 28)).toBe(45.1);
    expect(moveAlongRoute(44.9, 45.1, 10)).toBe(45.1);
  });

  it("is stopped by the deck's edge and by the hull's bottom", () => {
    // The deck at the hold's start runs from about 22.2 m to 24.0 m.
    expect(moveAlongRoute(44.9, 45.1, 23)).toBe(44.9);
    // Open water reaches 34 m, the hold's floor 33.5 m.
    expect(moveAlongRoute(44.9, 45.1, 33.9)).toBe(44.9);
  });

  it("always leaves the hold into open water", () => {
    for (const depth of [24.1, 28, 33.5]) {
      expect(moveAlongRoute(45.1, 44.9, depth)).toBe(44.9);
    }
  });

  it("slides along the deck's gentle middle but not up the steep stern", () => {
    // Under the deck at 60 m, swimming aft: the underside rises 0.027 m a
    // metre, so the diver keeps to it.
    const underAt60 = profileAt(WRECK_DECK_UNDERSIDE, 60);
    expect(moveAlongRoute(60, 59.9, underAt60)).toBe(59.9);
    // Under the deck at 90 m, swimming forward: past 82 m it drops 0.31 m a
    // metre, steeper than MAX_SLIDE_SLOPE, and stops the diver.
    const underAt90 = profileAt(WRECK_DECK_UNDERSIDE, 90);
    expect(moveAlongRoute(90, 90.1, underAt90)).toBe(90);
    expect(MAX_SLIDE_SLOPE).toBeLessThan((29.5 - 23) / (103 - 82));
    // A little deeper, the same stroke is free.
    expect(moveAlongRoute(90, 90.1, underAt90 + 0.5)).toBe(90.1);
  });
});
