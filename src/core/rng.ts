export interface RandomSample {
  state: number;
  value: number;
}

export function normalizeSeed(seed: number): number {
  if (!Number.isSafeInteger(seed)) {
    throw new RangeError("seed must be a safe integer");
  }

  return seed >>> 0;
}

export function nextRandom(state: number): RandomSample {
  const nextState = (state + 0x6d2b79f5) >>> 0;
  let mixed = nextState;
  mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
  mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);

  return {
    state: nextState,
    value: ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296,
  };
}
