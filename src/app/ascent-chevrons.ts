// Legacy's ascent chevrons beside the depth (#222, src/renderer.js
// drawDiveComputer, "Chevron ascent indicator"): six chevrons, one lit for
// every 3 m/min of vertical speed either way, pointing down while
// descending, in a tone for the rate, and blinking past 18 m/min. Pure, so
// the count and the blink are tested without a page; the HUD draws them.

export const ASCENT_CHEVRON_COUNT = 6;

/** Legacy's tones: #555 at rest, white moving, caution past 9, danger past 18. */
export type AscentChevronTier = "idle" | "moving" | "caution" | "danger";

export interface AscentChevrons {
  /** How many of the six are lit: Math.round(|rate| / 3), at most 6. */
  readonly count: number;
  readonly tier: AscentChevronTier;
  readonly direction: "up" | "down";
  /**
   * Legacy's blink past 18 m/min, `Math.floor(Date.now() / 300) % 2 === 0`:
   * every 300 ms all six show unlit. Never with reduced motion: the count and
   * the danger tone stay, without the blinking (docs/decisions.md).
   */
  readonly blinkedOff: boolean;
}

export function ascentChevrons(
  ascentRateMpm: number,
  elapsedRealS: number,
  reducedMotion: boolean,
): AscentChevrons {
  const rate = Math.abs(ascentRateMpm);
  const tier: AscentChevronTier =
    rate > 18 ? "danger" : rate > 9 ? "caution" : rate > 0.5 ? "moving" : "idle";
  return {
    count: Math.min(ASCENT_CHEVRON_COUNT, Math.max(0, Math.round(rate / 3))),
    tier,
    direction: ascentRateMpm < -0.5 ? "down" : "up",
    blinkedOff:
      !reducedMotion && rate > 18 && Math.floor((elapsedRealS * 1000) / 300) % 2 === 0,
  };
}
