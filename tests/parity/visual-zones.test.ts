import { describe, expect, it } from "vitest";

// The zone map (#240 PR 3) against legacy's own visualZoneAt() (src/sites.js,
// issue #53). Legacy's src/constants.js and src/sites.js are loaded into one
// Function body, as tests/parity/site-collision loads them. On every authored
// site, over a grid and on every zone's edges and just past them, where the
// inclusive comparisons and the priority, area and order tie-breaks decide,
// the client picks the zone legacy picks; on the wreck, the zone the HUD
// names is legacy's.

import constantsSource from "../../src/constants.js?raw";
import sitesSource from "../../src/sites.js?raw";

import { WRECK_ZONE_IDS, selectWreckZone } from "../../src/render/renderer";
import { SITE_PRESENTATION, visualZoneAt, type VisualZone } from "../../src/sites/layer-factory";

interface LegacyZone {
  readonly id: string;
  readonly x1: number;
  readonly x2: number;
  readonly d1: number;
  readonly d2: number;
  readonly priority?: number;
}

interface LegacyApi {
  readonly sites: Readonly<Record<string, { readonly visualZones?: readonly LegacyZone[] }>>;
  visualZoneAt(x: number, d: number, site: { readonly visualZones?: readonly LegacyZone[] }): LegacyZone | null;
}

const legacy = new Function(
  `${constantsSource}
var diveSite = "wreck";
${sitesSource}
return { sites: DIVE_SITES, visualZoneAt: visualZoneAt };`,
)() as LegacyApi;

const SITE_IDS = ["shore", "reef", "wreck", "cave"] as const;

function zonesOf(id: string): readonly VisualZone[] {
  const zones = SITE_PRESENTATION[id]?.visualZones;
  if (!zones?.length) throw new Error(`no visual zones for ${id}`);
  return zones;
}

/** A grid over the zones and 5 m around them, and each zone's edges, 1e-9 inside and outside. */
function probes(zones: readonly VisualZone[]): [number, number][] {
  const minX = Math.min(...zones.map((zone) => zone.x1)) - 5;
  const maxX = Math.max(...zones.map((zone) => zone.x2)) + 5;
  const maxD = Math.max(...zones.map((zone) => zone.d2)) + 5;
  const xs = new Set<number>();
  const ds = new Set<number>([-1]);
  for (let x = minX; x <= maxX; x += 0.5) xs.add(x);
  for (let d = 0; d <= maxD; d += 0.5) ds.add(d);
  for (const zone of zones) {
    for (const x of [zone.x1, zone.x2]) for (const offset of [-1e-9, 0, 1e-9]) xs.add(x + offset);
    for (const d of [zone.d1, zone.d2]) for (const offset of [-1e-9, 0, 1e-9]) ds.add(d + offset);
  }
  const points: [number, number][] = [];
  for (const x of xs) for (const d of ds) points.push([x, d]);
  return points;
}

describe("the zone map against legacy's visualZoneAt", () => {
  it("reads legacy's zones on all four sites", () => {
    expect(Object.keys(SITE_PRESENTATION).sort()).toEqual([...SITE_IDS].sort());
    for (const id of SITE_IDS) {
      const pick = ({ id: zoneId, x1, x2, d1, d2, priority }: LegacyZone) => ({ id: zoneId, x1, x2, d1, d2, priority });
      expect(zonesOf(id).map(pick), id).toEqual((legacy.sites[id]?.visualZones ?? []).map(pick));
    }
  });

  it("picks legacy's zone everywhere on all four sites, on and just past every edge", () => {
    for (const id of SITE_IDS) {
      const zones = zonesOf(id);
      const legacySite = legacy.sites[id]!;
      let named = 0;
      for (const [x, d] of probes(zones)) {
        const expected = legacy.visualZoneAt(x, d, legacySite)?.id ?? null;
        expect(visualZoneAt(zones, x, d)?.id ?? null, `${id} at ${x}, ${d}`).toBe(expected);
        if (expected !== null) named += 1;
      }
      // Every zone is the one picked somewhere, so none is only ever overridden.
      const picked = new Set(probes(zones).map(([x, d]) => visualZoneAt(zones, x, d)?.id));
      expect([...zones.map((zone) => zone.id)].filter((zoneId) => !picked.has(zoneId)), id).toEqual([]);
      expect(named, id).toBeGreaterThan(0);
    }
  });

  it("breaks ties as legacy does: priority, then the smaller zone, then the one declared first", () => {
    const tied: LegacyZone[] = [
      { id: "wide", x1: 0, x2: 10, d1: 0, d2: 10 },
      { id: "first", x1: 2, x2: 6, d1: 2, d2: 6, priority: 1 },
      { id: "second", x1: 4, x2: 8, d1: 4, d2: 8, priority: 1 },
      { id: "small", x1: 5, x2: 6, d1: 5, d2: 6, priority: 1 },
      { id: "high", x1: 9, x2: 10, d1: 9, d2: 10, priority: 2 },
      { id: "zero", x1: 0, x2: 10, d1: 0, d2: 10, priority: 0 },
      // A missing priority counts as 0, under a larger zone's 0.5.
      { id: "unset", x1: 0, x2: 1, d1: 0, d2: 1 },
      { id: "half", x1: 0, x2: 2, d1: 0, d2: 2, priority: 0.5 },
    ];
    const site = { visualZones: tied };
    for (let x = -1; x <= 11; x += 0.25) {
      for (let d = -1; d <= 11; d += 0.25) {
        expect(visualZoneAt(tied, x, d)?.id ?? null, `${x}, ${d}`).toBe(legacy.visualZoneAt(x, d, site)?.id ?? null);
      }
    }
    expect(visualZoneAt(tied, 4.5, 4.5)?.id).toBe("first");
    expect(visualZoneAt(tied, 5.5, 5.5)?.id).toBe("small");
    expect(visualZoneAt(tied, 9.5, 9.5)?.id).toBe("high");
    expect(visualZoneAt(tied, 8.5, 0.5)?.id).toBe("wide");
    expect(visualZoneAt(tied, 0.5, 0.5)?.id).toBe("half");
    expect(visualZoneAt([], 0, 0)).toBeNull();
    expect(visualZoneAt(undefined, 0, 0)).toBeNull();
  });

  it("names legacy's zone on the wreck, and the exterior where legacy has none", () => {
    const zones = zonesOf("wreck");
    expect(Object.keys(WRECK_ZONE_IDS).sort()).toEqual(zones.map((zone) => zone.id).sort());
    for (const [x, d] of probes(zones)) {
      const legacyId = legacy.visualZoneAt(x, d, legacy.sites.wreck!)?.id;
      expect(selectWreckZone(x, d), `${x}, ${d}`).toBe(legacyId ? WRECK_ZONE_IDS[legacyId] : "exterior");
    }
  });
});
