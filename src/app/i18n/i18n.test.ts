import { describe, expect, it } from "vitest";

import { resolveSupportedLocale, translate } from "./catalog";
import {
  formatDepth,
  formatDuration,
  formatGasFraction,
  formatPressure,
} from "./formatters";

describe("string catalogue", () => {
  it("negotiates supported locales with an English fallback", () => {
    expect(resolveSupportedLocale(["fr-FR", "de-DE"])).toBe("de");
    expect(resolveSupportedLocale(["fr-FR"])).toBe("en");
  });

  it("provides the diagnostic copy through typed keys", () => {
    expect(translate("en", "diagnostic.status.ready")).toBe("ready");
    expect(translate("de", "diagnostic.status.ready")).toBe("bereit");
  });
});

describe("locale-aware formatters", () => {
  it("formats diving units and gas fractions for English and German", () => {
    expect(formatDepth(12.5, "en")).toContain("12.5");
    expect(formatDepth(12.5, "de")).toContain("12,5");
    expect(formatPressure(200, "en")).toMatch(/200\s*bar/);
    expect(formatGasFraction(0.215, "en")).toContain("21.5");
    expect(formatGasFraction(0.215, "de")).toContain("21,5");
  });

  it("formats elapsed time and rejects invalid domain values", () => {
    expect(formatDuration(3_665, "en")).toMatch(/1.*1.*5/);
    expect(formatDuration(3_665, "de")).toMatch(/1.*1.*5/);
    expect(() => formatDepth(-1, "en")).toThrow(RangeError);
    expect(() => formatGasFraction(1.01, "de")).toThrow(RangeError);
  });
});
