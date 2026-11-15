import { describe, expect, it } from "vitest";

import { DIVER_HALF_WIDTH_M, ceilingAt, floorAt, overheadAt } from "../../src/sites/site-collision";
import { ROUTE_START_POSITION_M, WRECK_SITE, diverFitsAt, reachableAt } from "../../src/sites/wreck-site";

// Where a dive on the wreck starts (#199, #240 PR 3c): the route's start,
// moved here from the provisional route model when #240 retired it.

describe("the route's start", () => {
  it("starts a dive in open water off the bow, clear of the hull", () => {
    expect(ROUTE_START_POSITION_M).toBe(10);
    const bowXM = Math.min(...WRECK_SITE.structures.map((structure) => structure.x1));
    expect(ROUTE_START_POSITION_M + DIVER_HALF_WIDTH_M).toBeLessThan(bowXM);
    // Open to the surface, down to the seabed, with nothing overhead.
    expect(ceilingAt(WRECK_SITE, ROUTE_START_POSITION_M)).toBe(0);
    expect(floorAt(WRECK_SITE, ROUTE_START_POSITION_M)).toBe(66);
    for (let depthM = 0; depthM <= 66; depthM += 0.25) {
      expect(diverFitsAt(ROUTE_START_POSITION_M, depthM), `fits at ${depthM} m`).toBe(true);
      expect(overheadAt(WRECK_SITE, ROUTE_START_POSITION_M, depthM), `overhead at ${depthM} m`).toBe(false);
      expect(reachableAt(ROUTE_START_POSITION_M, depthM), `reached at ${depthM} m`).toBe(true);
    }
  });
});
