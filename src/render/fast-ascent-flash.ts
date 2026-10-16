// The red edge flash of a fast ascent (#222), after legacy's src/renderer.js
// drawScene ("Red edge flash on dangerous ascent rate"): four strips 20 px
// deep along the edges of the view, red at an alpha that pulses and grows
// with the rate past 9 m/min. The renderer draws the strips once per
// viewport size and sets this alpha every frame.

/** Legacy flashes above 9 m/min up, and at full strength from 18 m/min. */
export const FAST_ASCENT_FLASH_FROM_MPM = 9;
/** The strips are 20 px deep, in screen pixels. */
export const FAST_ASCENT_FLASH_EDGE_PX = 20;

/**
 * Legacy's `(0.2 + 0.15 * sin(Date.now() * 0.01)) * min(1, (rate - 9) / 9)`
 * while diving with the rate past 9 m/min up, else 0. It reads the scene's
 * real time for Date.now(), so a pinned clock pins it. With reduced motion
 * the alpha holds at its middle, 0.2 * min(1, (rate - 9) / 9), and does not
 * pulse: the strips stay as a cue, without the flashing (docs/decisions.md,
 * reduced-motion support).
 */
export function fastAscentFlashAlpha(
  diving: boolean,
  ascentRateMpm: number,
  elapsedRealS: number,
  reducedMotion: boolean,
): number {
  if (!diving || !(ascentRateMpm > FAST_ASCENT_FLASH_FROM_MPM)) {
    return 0;
  }
  const strength = Math.min(
    1,
    (ascentRateMpm - FAST_ASCENT_FLASH_FROM_MPM) / FAST_ASCENT_FLASH_FROM_MPM,
  );
  const pulse = reducedMotion ? 0 : 0.15 * Math.sin(elapsedRealS * 1000 * 0.01);
  return (0.2 + pulse) * strength;
}
