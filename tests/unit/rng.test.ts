import { describe, expect, it } from "vitest";

import { nextRandom, normalizeSeed } from "../../src/core/rng";

describe("seeded random generator", () => {
  it("replays the same sequence from the same seed", () => {
    let firstState = normalizeSeed(42);
    let secondState = normalizeSeed(42);
    const firstSequence: number[] = [];
    const secondSequence: number[] = [];

    for (let index = 0; index < 5; index += 1) {
      const first = nextRandom(firstState);
      const second = nextRandom(secondState);
      firstState = first.state;
      secondState = second.state;
      firstSequence.push(first.value);
      secondSequence.push(second.value);
    }

    expect(firstSequence).toEqual(secondSequence);
    expect(new Set(firstSequence).size).toBe(firstSequence.length);
    expect(firstSequence.every((value) => value >= 0 && value < 1)).toBe(true);
  });
});
