import { describe, expect, it } from "vitest";

// The legacy descriptors are the authority this extraction must reproduce, so
// load the real source rather than a snapshot of it. `?raw` keeps this a
// browser-shaped project: no node APIs, no @types/node.
import legacySource from "../../src/sites.js?raw";
import constantsSource from "../../src/constants.js?raw";

import {
  SITE_GAMEPLAY,
  validateSiteGameplay,
  type SiteGameplay,
} from "../../src/sites/site-resources";

interface LegacyApi {
  DIVE_SITES: Record<string, SiteGameplay>;
  setSite(id: string): void;
  floorAt(x: number): number;
  ceilingAt(x: number): number;
  solidAt(x: number, d: number): boolean;
  overheadAt(x: number, d: number): boolean;
  badAirAt(x: number): unknown;
}

// Read the real constant rather than restating it. A literal here is injected
// into the legacy source *and* used by the reimplementation below, so a wrong
// value agrees with itself and every parity assertion passes against data that
// does not match the running game. The reef descriptor is what depends on it.
const MAX_DEPTH = (() => {
  const match = /^\s*(?:const|let|var)\s+MAX_DEPTH\s*=\s*(-?\d+(?:\.\d+)?)\s*;/m.exec(
    constantsSource,
  );
  if (!match) {
    throw new Error("could not read MAX_DEPTH from src/constants.js");
  }
  return Number(match[1]);
})();

// `diveSite` lives in state.js, which sites.js reads but does not declare.
const legacy = new Function(
  "MAX_DEPTH",
  `var diveSite = "shore";
${legacySource}
return {
  DIVE_SITES: DIVE_SITES,
  setSite: function (id) { diveSite = id; },
  floorAt: floorAt,
  ceilingAt: ceilingAt,
  solidAt: solidAt,
  overheadAt: overheadAt,
  badAirAt: badAirAt
};`,
)(MAX_DEPTH) as LegacyApi;

// Reimplemented against the extracted resource. If these drift from the legacy
// helpers the parity assertions below fail, which is the whole point.
function floorAt(site: SiteGameplay, x: number): number {
  return Math.min(MAX_DEPTH, lerp(site.floor, x) ?? MAX_DEPTH);
}

function ceilingAt(site: SiteGameplay, x: number): number {
  const value = lerp(site.ceiling, x);
  return value === null ? 0 : Math.max(0, value);
}

function solidAt(site: SiteGameplay, x: number, d: number): boolean {
  return site.structures.some(
    (s) => x >= s.x1 && x <= s.x2 && d >= s.dTop && d <= s.dBottom,
  );
}

function overheadAt(site: SiteGameplay, x: number, d: number): boolean {
  if (!site.hasOverhead) {
    return false;
  }
  const ceiling = ceilingAt(site, x);
  if (ceiling > 0.5 && d >= ceiling - 0.01) {
    return true;
  }
  return site.structures.some((s) => x >= s.x1 && x <= s.x2 && s.dBottom < d);
}

function lerp(
  points: readonly { x: number; d: number }[] | null,
  x: number,
): number | null {
  if (!points?.length) {
    return null;
  }
  const first = points[0] as { x: number; d: number };
  const last = points[points.length - 1] as { x: number; d: number };
  if (x <= first.x) return first.d;
  if (x >= last.x) return last.d;
  for (let i = 1; i < points.length; i += 1) {
    const b = points[i] as { x: number; d: number };
    if (x <= b.x) {
      const a = points[i - 1] as { x: number; d: number };
      // Compute the interpolant first, exactly as lerpProfile does. Folding the
      // division into the multiplication is algebraically identical and
      // numerically is not: it moved results by one ULP and broke parity on two
      // sites. Preserve the operation order, not just the formula.
      const t = (x - a.x) / (b.x - a.x);
      return a.d + (b.d - a.d) * t;
    }
  }
  return last.d;
}

describe("extracted site gameplay matches the legacy descriptors", () => {
  for (const id of Object.keys(legacy.DIVE_SITES)) {
    it(`reproduces ${id} collision, ceiling and air across a sampled grid`, () => {
      const site = SITE_GAMEPLAY[id];
      expect(site, `no extracted resource for ${id}`).toBeDefined();
      if (!site) return;

      legacy.setSite(id);
      const mismatches: string[] = [];

      // Half-metre horizontal steps across the authored extent plus margin, and
      // metre depth steps. Sampling beyond the profile ends exercises the
      // clamping branches, which is where an off-by-one in extraction hides.
      for (let x = -20; x <= 260; x += 0.5) {
        if (floorAt(site, x) !== legacy.floorAt(x)) {
          mismatches.push(`floorAt(${x})`);
        }
        if (ceilingAt(site, x) !== legacy.ceilingAt(x)) {
          mismatches.push(`ceilingAt(${x})`);
        }
        if (Boolean(legacy.badAirAt(x)) !== site.badAir.some((p) => x >= p.x1 && x <= p.x2)) {
          mismatches.push(`badAirAt(${x})`);
        }
        for (let d = 0; d <= 110; d += 1) {
          if (solidAt(site, x, d) !== legacy.solidAt(x, d)) {
            mismatches.push(`solidAt(${x},${d})`);
          }
          if (overheadAt(site, x, d) !== legacy.overheadAt(x, d)) {
            mismatches.push(`overheadAt(${x},${d})`);
          }
        }
      }

      expect(mismatches.slice(0, 5), `${mismatches.length} mismatches`).toEqual([]);
    });
  }

  it("declares every authored site", () => {
    expect(Object.keys(SITE_GAMEPLAY).sort()).toEqual(
      Object.keys(legacy.DIVE_SITES).sort(),
    );
  });

  it("carries no presentation field into gameplay data", () => {
    // The separation is the deliverable. If art leaks back in, an asset change
    // becomes a collision change again and this suite stops meaning anything.
    const forbidden = [
      "features",
      "visualZones",
      "atmosphereProfiles",
      "decorationRules",
      "surfaceMarker",
      "name",
    ];
    for (const [id, site] of Object.entries(SITE_GAMEPLAY)) {
      for (const field of forbidden) {
        expect(Object.hasOwn(site, field), `${id} leaked ${field}`).toBe(false);
      }
    }
  });

  it("accepts the shipped data and rejects geometry that silently corrupts", () => {
    for (const site of Object.values(SITE_GAMEPLAY)) {
      expect(validateSiteGameplay(site)).toEqual([]);
    }

    const base = SITE_GAMEPLAY.wreck as SiteGameplay;
    // Unsorted profile points do not throw in lerpProfile; they interpolate
    // against the wrong segment and return a plausible depth for the wrong x.
    expect(
      validateSiteGameplay({
        ...base,
        id: "unsorted",
        floor: [
          { x: 10, d: 5 },
          { x: 0, d: 6 },
        ],
      }),
    ).not.toEqual([]);

    // An inverted box can never be hit by solidAt, so the wall stops existing.
    expect(
      validateSiteGameplay({
        ...base,
        id: "inverted",
        structures: [{ x1: 20, x2: 10, dTop: 5, dBottom: 6 }],
      }),
    ).not.toEqual([]);
  });
});
