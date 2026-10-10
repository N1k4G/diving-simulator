/**
 * A seed for a new dive (#219, owner decision of 2026-10-07).
 *
 * Each dive draws its own at its start, and the model keeps it as
 * DiveState.randomState, which the save carries, so a resumed dive draws the
 * rolls it would have drawn. The client seeded every dive with the same
 * constant before, on which the shark's first spawn roll came on the 193rd
 * roll, so none ever swam. Drawn here, in the app, so the core stays
 * deterministic: it only ever sees the seed.
 */
export function drawDiveSeed(
  source: Pick<Crypto, "getRandomValues"> = globalThis.crypto,
): number {
  return source.getRandomValues(new Uint32Array(1))[0] ?? 0;
}
