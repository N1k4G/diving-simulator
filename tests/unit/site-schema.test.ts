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
