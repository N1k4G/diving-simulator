// WP-07: execute the committed schemas.
//
// `validateSiteGameplay` checks geometry *relationships* — profile ordering,
// inverted boxes, structures below maxDepth. It says nothing about types, so a
// descriptor typo that produces `hasOverhead: "false"` or `maxDepth: "300"`
// passes generation, parity, typecheck and CI while changing runtime behaviour:
// the string "false" is truthy, and an overhead site silently becomes one the
// diver can surface from.
//
// The schemas existed but had no caller, which made the "invalid site data
// fails at build/test time" criterion untrue for the whole class of type
// errors. These tests are that caller.

import Ajv2020 from "ajv/dist/2020";
import { describe, expect, it } from "vitest";

import gameplayDocument from "../../src/sites/resources/gameplay.json";
import presentationDocument from "../../src/sites/resources/presentation.json";
import gameplaySchema from "../../docs/baseline/schemas/site.schema.json";
import presentationSchema from "../../docs/baseline/schemas/site-presentation.schema.json";

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateGameplay = ajv.compile(gameplaySchema);
const validatePresentation = ajv.compile(presentationSchema);

/** Deep clone so a mutation probe cannot leak into another test. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("shipped site resources satisfy their schemas", () => {
  it("validates the gameplay document", () => {
    expect(
      validateGameplay(gameplayDocument),
      ajv.errorsText(validateGameplay.errors),
    ).toBe(true);
  });

  it("validates the presentation document", () => {
    expect(
      validatePresentation(presentationDocument),
      ajv.errorsText(validatePresentation.errors),
    ).toBe(true);
  });
});

describe("the schemas reject the type errors relationship checks cannot see", () => {
  it("rejects a stringly-typed hasOverhead", () => {
    // The motivating case: "false" is truthy, so overheadAt() would treat an
    // open-water site as an overhead environment.
    const document = clone(gameplayDocument);
    (document as never as { sites: Record<string, { hasOverhead: unknown }> }).sites.reef!
      .hasOverhead = "false";
    expect(validateGameplay(document)).toBe(false);
  });

  it("rejects a stringly-typed maxDepth", () => {
    const document = clone(gameplayDocument);
    (document as never as { sites: Record<string, { maxDepth: unknown }> }).sites.reef!
      .maxDepth = "300";
    expect(validateGameplay(document)).toBe(false);
  });

  it("rejects a negative structure depth", () => {
    const document = clone(gameplayDocument);
    (
      document as never as { sites: Record<string, { structures: { dTop: number }[] }> }
    ).sites.wreck!.structures[0]!.dTop = -5;
    expect(validateGameplay(document)).toBe(false);
  });

  it("rejects an unknown top-level site field", () => {
    // `additionalProperties: false` is what stops presentation data drifting
    // into the gameplay document unnoticed.
    const document = clone(gameplayDocument);
    (document as never as { sites: Record<string, Record<string, unknown>> }).sites.reef!
      .features = [];
    expect(validateGameplay(document)).toBe(false);
  });

  it("rejects a feature whose x is not a number", () => {
    const document = clone(presentationDocument);
    (
      document as never as { sites: Record<string, { features: { x: unknown }[] }> }
    ).sites.wreck!.features[0]!.x = "34";
    expect(validatePresentation(document)).toBe(false);
  });

  it("rejects provenance that is not an input digest", () => {
    const document = clone(gameplayDocument);
    (document as never as { sourceDigest: string }).sourceDigest = "4046bdac";
    expect(validateGameplay(document)).toBe(false);
  });
});

describe("the entry point is typed gameplay data, not an open object", () => {
  // `entry` is spawn data in the gameplay document, but it was declared as a
  // bare `{ "type": "object" }` and left out of SiteGameplay entirely, so a
  // string coordinate passed Ajv, typecheck and CI. The parity suite compares
  // floor, ceiling, solid, overhead and bad air — never entry — so nothing else
  // would have caught it either.
  const withEntry = (entry: unknown) => {
    const document = clone(gameplayDocument);
    (document as never as { sites: Record<string, { entry: unknown }> }).sites.reef!.entry =
      entry;
    return document;
  };

  it("rejects a stringly-typed entry x", () => {
    expect(validateGameplay(withEntry({ x: "not-a-number" }))).toBe(false);
  });

  it("rejects an entry with no x at all", () => {
    expect(validateGameplay(withEntry({ totallyBogus: true }))).toBe(false);
  });

  it("requires every site to declare one", () => {
    const document = clone(gameplayDocument);
    delete (document as never as { sites: Record<string, { entry?: unknown }> }).sites.reef!
      .entry;
    expect(validateGameplay(document)).toBe(false);
  });

  it("accepts a well-formed entry", () => {
    expect(validateGameplay(withEntry({ x: -12.5 }))).toBe(true);
  });
});

describe("decoration rules are closed over what the renderer actually reads", () => {
  // renderer.js guards decoration placement with `rule.f != null && x < rule.f`.
  // A string makes that comparison NaN-false, so the guard stops guarding and
  // props render at every depth. Undeclared numeric fields are therefore worse
  // than absent ones, and every field the renderer reads has to be pinned —
  // not only the ones the shipped data happens to author today.
  const rule = (patch: Record<string, unknown>) => {
    const document = clone(presentationDocument);
    const rules = (
      document as never as {
        sites: Record<string, { decorationRules: Record<string, unknown>[] }>;
      }
    ).sites.wreck!.decorationRules;
    Object.assign(rules[0]!, patch);
    return document;
  };

  it.each([
    ["minDepth", "not-a-number"],
    ["maxDepth", "60"],
    ["minScale", "0.5"],
    ["maxScale", "2"],
    ["rotationJitter", "1"],
    ["alpha", "0.5"],
    ["maxPerScreen", "12"],
  ])("rejects a stringly-typed %s", (field, value) => {
    expect(validatePresentation(rule({ [field]: value }))).toBe(false);
  });

  it("rejects a non-integer maxPerScreen", () => {
    expect(validatePresentation(rule({ maxPerScreen: 12.5 }))).toBe(false);
  });

  it("rejects an alpha outside 0..1", () => {
    expect(validatePresentation(rule({ alpha: 4 }))).toBe(false);
  });

  it("rejects an unknown field, which the renderer would read as undefined", () => {
    // A typo like `minDepht` would otherwise validate and then be defaulted
    // away silently, which is how a guard goes missing without anyone noticing.
    expect(validatePresentation(rule({ minDepht: 20 }))).toBe(false);
  });

  it("still accepts every field the renderer legitimately reads", () => {
    expect(
      validatePresentation(
        rule({
          minDepth: 20,
          maxDepth: 60,
          minScale: 0.5,
          maxScale: 2,
          rotationJitter: 1,
          alpha: 0.5,
          maxPerScreen: 12,
        }),
      ),
    ).toBe(true);
  });

  it("closes visual zones and atmosphere profiles too", () => {
    const zones = clone(presentationDocument);
    (
      zones as never as {
        sites: Record<string, { visualZones: Record<string, unknown>[] }>;
      }
    ).sites.cave!.visualZones[0]!.bogus = 1;
    expect(validatePresentation(zones)).toBe(false);

    const atmos = clone(presentationDocument);
    const profiles = (
      atmos as never as {
        sites: Record<string, { atmosphereProfiles: Record<string, Record<string, unknown>> }>;
      }
    ).sites.cave!.atmosphereProfiles;
    Object.values(profiles)[0]!.bogus = 1;
    expect(validatePresentation(atmos)).toBe(false);
  });
});

describe("ceiling must be present, with null spelled out", () => {
  // An absent `ceiling` makes ceilingAt() fall through to 0, turning the cave
  // roof into open water — 14 m becomes 0 m at x=50 — so the diver can swim up
  // through it. Parity cannot catch it: legacy and generated data lose the
  // field together and agree on 0.
  it("rejects a site with no ceiling field", () => {
    const document = clone(gameplayDocument);
    delete (document as never as { sites: Record<string, { ceiling?: unknown }> }).sites
      .cave!.ceiling;
    expect(validateGameplay(document)).toBe(false);
  });

  it("accepts explicit null for an open-water site", () => {
    const document = clone(gameplayDocument);
    (document as never as { sites: Record<string, { ceiling: unknown }> }).sites.reef!
      .ceiling = null;
    expect(validateGameplay(document)).toBe(true);
  });

  it("still ships a ceiling on every site", () => {
    for (const [id, site] of Object.entries(
      (gameplayDocument as { sites: Record<string, object> }).sites,
    )) {
      expect(Object.hasOwn(site, "ceiling"), `${id} must declare ceiling`).toBe(true);
    }
  });
});
