// Semantic validation of presentation data — the cross-references and
// uniqueness a JSON Schema structurally cannot express.
//
// A schema can say `zone` is a string. It cannot say the string names a zone
// that exists. Every failure here is silent at runtime: a decoration rule
// pointing at a misspelled zone matches no candidate, so an entire scatter of
// props simply never appears, with nothing logged and no error raised.

import { describe, expect, it } from "vitest";

import {
  SITE_PRESENTATION,
  validateSitePresentation,
  type SitePresentation,
} from "../../src/sites/layer-factory";

const wreck = SITE_PRESENTATION.wreck as SitePresentation;

/** Shallow-clone a site deeply enough to mutate one of its arrays. */
function mutable(site: SitePresentation): SitePresentation {
  return JSON.parse(JSON.stringify(site)) as SitePresentation;
}

describe("shipped presentation data is semantically sound", () => {
  it("has no dangling references, duplicates or inverted extents", () => {
    for (const [id, site] of Object.entries(SITE_PRESENTATION)) {
      expect(validateSitePresentation(site), id).toEqual([]);
    }
  });

  it("resolves every decoration rule to a declared zone", () => {
    for (const [id, site] of Object.entries(SITE_PRESENTATION)) {
      const zones = new Set((site.visualZones ?? []).map((zone) => zone.id));
      for (const rule of site.decorationRules ?? []) {
        expect(zones.has(rule.zone), `${id}/${rule.id} -> ${rule.zone}`).toBe(true);
      }
    }
  });

  it("keys every atmosphere profile by a declared zone", () => {
    for (const [id, site] of Object.entries(SITE_PRESENTATION)) {
      const zones = new Set((site.visualZones ?? []).map((zone) => zone.id));
      for (const key of Object.keys(site.atmosphereProfiles ?? {})) {
        expect(zones.has(key), `${id} atmosphere "${key}"`).toBe(true);
      }
    }
  });
});

describe("the validator catches what the schema cannot", () => {
  it("rejects a decoration rule pointing at a zone that does not exist", () => {
    const site = mutable(wreck);
    (site.decorationRules as unknown as { zone: string }[])[0]!.zone = "typo-zone";
    const problems = validateSitePresentation(site);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("unknown zone");
  });

  it("rejects an atmosphere profile keyed to no zone", () => {
    const site = mutable(wreck);
    (site.atmosphereProfiles as unknown as Record<string, unknown>)["wreck_nowhere"] = {};
    expect(validateSitePresentation(site)).toEqual([
      expect.stringContaining("matches no visual zone"),
    ]);
  });

  it("rejects duplicate zone ids", () => {
    const site = mutable(wreck);
    const zones = site.visualZones as unknown as { id: string }[];
    zones.push({ ...zones[0]! });
    expect(validateSitePresentation(site)).toEqual([
      expect.stringContaining("duplicate visualZone id"),
    ]);
  });

  it("rejects duplicate decoration rule ids", () => {
    const site = mutable(wreck);
    const rules = site.decorationRules as unknown as { id: string }[];
    rules.push({ ...rules[0]! });
    expect(validateSitePresentation(site)).toEqual([
      expect.stringContaining("duplicate decorationRule id"),
    ]);
  });

  it("rejects an inverted zone extent, which can never contain a point", () => {
    const site = mutable(wreck);
    const zone = (site.visualZones as unknown as { x1: number; x2: number }[])[0]!;
    [zone.x1, zone.x2] = [zone.x2, zone.x1];
    expect(validateSitePresentation(site)).toEqual([
      expect.stringContaining("before x1"),
    ]);
  });

  it("rejects an inverted zone depth span", () => {
    const site = mutable(wreck);
    const zone = (site.visualZones as unknown as { d1: number; d2: number }[])[0]!;
    [zone.d1, zone.d2] = [zone.d2, zone.d1];
    expect(validateSitePresentation(site)).toEqual([
      expect.stringContaining("above d1"),
    ]);
  });

  it("reports every problem at once rather than stopping at the first", () => {
    const site = mutable(wreck);
    (site.decorationRules as unknown as { zone: string }[])[0]!.zone = "typo-one";
    (site.decorationRules as unknown as { zone: string }[])[1]!.zone = "typo-two";
    expect(validateSitePresentation(site)).toHaveLength(2);
  });
});
