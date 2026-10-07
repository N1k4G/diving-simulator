import { describe, expect, it } from "vitest";

import { tissueBars } from "../../src/app/tissue-bars";

// The tissue bars (#221), legacy's bar graph in drawPostDive(): each bar's
// height, its nitrogen and helium parts, and its colour tier.

const bar = (loading: number, nitrogenFraction = 1) => tissueBars([{ loading, nitrogenFraction }])[0]!;

describe("the post-dive tissue bars", () => {
  it("numbers one bar per compartment from 1, as legacy's labels", () => {
    const bars = tissueBars(Array.from({ length: 16 }, () => ({ loading: 0.3, nitrogenFraction: 1 })));
    expect(bars.map((entry) => entry.compartment)).toEqual(Array.from({ length: 16 }, (_, index) => index + 1));
  });

  it("is as tall as the load's share of the M-value, and no taller than the line", () => {
    expect(bar(0.5)).toMatchObject({ loading: 0.5, nitrogenHeight: 0.5, heliumHeight: 0 });
    // Past the M-value the bar stops at the line; the loading itself is kept.
    const over = bar(1.3, 0.6);
    expect(over.loading).toBe(1.3);
    expect(over.nitrogenHeight).toBeCloseTo(0.6, 12);
    expect(over.heliumHeight).toBeCloseTo(0.4, 12);
  });

  it("stacks helium on nitrogen in their shares of the load", () => {
    const mixed = bar(0.8, 0.25);
    expect(mixed.nitrogenHeight).toBeCloseTo(0.2, 12);
    expect(mixed.heliumHeight).toBeCloseTo(0.6, 12);
  });

  it("leaves out a helium part under legacy's half pixel of the 100 px bar", () => {
    // 0.5 * 0.004 = 0.002 of the bar, 0.2 px: not drawn.
    const trace = bar(0.5, 0.996);
    expect(trace.heliumHeight).toBe(0);
    expect(trace.nitrogenHeight).toBeCloseTo(0.498, 12);
    // 0.5 * 0.02 = 0.01 of the bar, 1 px: drawn.
    expect(bar(0.5, 0.98).heliumHeight).toBeCloseTo(0.01, 12);
  });

  it("colours a bar danger above 90% of the M-value and caution above 70%", () => {
    expect([0, 0.7, 0.7001, 0.9, 0.9001, 1.2].map((loading) => bar(loading).tier)).toEqual([
      "ok",
      "ok",
      "caution",
      "caution",
      "danger",
      "danger",
    ]);
  });
});
