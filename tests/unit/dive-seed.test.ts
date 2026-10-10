import { describe, expect, it } from "vitest";

import { drawDiveSeed } from "../../src/app/dive-seed";
import { createWreckInitialState } from "../../src/app/game-controller";
import { createInitialDiveState } from "../../src/core/dive-state";

// Each dive draws its own seed at its start (#219, owner decision of
// 2026-10-07), and keeps it as the random state the save carries.

/** A source that hands out these 32-bit values, one a draw. */
function source(...values: number[]) {
  return {
    getRandomValues<T extends ArrayBufferView | null>(array: T): T {
      const next = values.shift();
      if (next === undefined || !(array instanceof Uint32Array)) throw new Error("an unexpected draw");
      array.fill(next);
      return array;
    },
  };
}

describe("the dive's seed", () => {
  it("is one 32-bit value from the source", () => {
    expect(drawDiveSeed(source(0xdeadbeef))).toBe(0xdeadbeef);
    expect(drawDiveSeed(source(0))).toBe(0);
  });

  it("differs between dives drawn from the platform's source", () => {
    const seeds = new Set(Array.from({ length: 8 }, () => createWreckInitialState().randomState));
    expect(seeds.size).toBeGreaterThan(1);
  });

  it("is the random state a new wreck dive starts on, unless one is given", () => {
    expect(createWreckInitialState({}, 0x1234).randomState).toBe(createInitialDiveState(0x1234).randomState);
    expect(createWreckInitialState({}, 0x1234)).toEqual(createWreckInitialState({}, 0x1234));
  });
});
