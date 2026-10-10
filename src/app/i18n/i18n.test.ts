import { describe, expect, it } from "vitest";

import {
  DIVE_COMPUTER_LOCALE,
  diveComputerText,
  resolveSupportedLocale,
  translate,
} from "./catalog";
import {
  formatDepth,
  formatDuration,
  formatGasFraction,
  formatPressure,
  formatVerticalRate,
} from "./formatters";

describe("string catalogue", () => {
  it("negotiates supported locales with an English fallback", () => {
    expect(resolveSupportedLocale(["fr-FR", "de-DE"])).toBe("de");
    expect(resolveSupportedLocale(["fr-FR"])).toBe("en");
  });

  it("provides shipped copy through typed keys in both locales", () => {
    expect(translate("en", "wreck.brand")).toBe("Diving Simulator");
    expect(translate("de", "wreck.brand")).toBe("Tauchsimulator");
  });

  it("gives the dive computer one language, English, with no locale to translate it into (#232)", () => {
    expect(DIVE_COMPUTER_LOCALE).toBe("en");
    // Legacy's own words: its stop box's "Complete", "DECO STOP" and the
    // SLOW DOWN of its banner, in both languages.
    expect(diveComputerText("diveComputer.safetyStop.complete")).toBe("Complete");
    expect(diveComputerText("diveComputer.decoStop")).toBe("Deco stop");
    expect(diveComputerText("diveComputer.alert.fastAscent")).toBe("Ascending too fast — slow down");
    // The per-locale tables have no dive-computer keys, so a German entry
    // cannot be added for one by accident.
    // @ts-expect-error -- not a MessageKey
    expect(translate("de", "diveComputer.safetyStop.complete")).toBeUndefined();
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

  it("formats a vertical rate in whole metres a minute, without its sign (#197)", () => {
    expect(formatVerticalRate(12.4, "en")).toBe("12 m/min");
    expect(formatVerticalRate(-9.6, "en")).toBe("10 m/min");
    expect(formatVerticalRate(12.4, "de")).toBe("12 m/min");
    expect(() => formatVerticalRate(Number.NaN, "en")).toThrow(RangeError);
  });

  it("formats elapsed time and rejects invalid domain values", () => {
    expect(formatDuration(3_665, "en")).toMatch(/1.*1.*5/);
    expect(formatDuration(3_665, "de")).toMatch(/1.*1.*5/);
    expect(() => formatDepth(-1, "en")).toThrow(RangeError);
    expect(() => formatGasFraction(1.01, "de")).toThrow(RangeError);
  });
});
