// What narcosis does to the view (#220, owner decision of 2026-10-07):
// legacy's tunnel vision and wobble (src/renderer.js drawScene, WP-020), as
// numbers the renderer applies to one overlay sprite and to the world's
// offset. Legacy's blur (index > 0.5) and grayscale (index > 0.4) are not
// ported: they were canvas filters over the whole scene every frame
// (docs/decisions.md, "Deliberate departures from the legacy client").

/** Above this index the edges of the view darken. */
export const NARCOSIS_VIGNETTE_INDEX = 0.15;
export const NARCOSIS_VIGNETTE_MAX_ALPHA = 0.7;
/** Above this index the view wobbles. */
export const NARCOSIS_WOBBLE_INDEX = 0.25;

/**
 * Legacy's vignette alpha, `min(0.7, (index - 0.15) * 0.82)`: the outer
 * colour stop of a radial gradient from clear at 0.3 of the shorter side to
 * black at 0.7 of the longer one. 0 at 0.15 or below, where legacy draws none.
 */
export function narcosisVignetteAlpha(narcosisIndex: number): number {
  return narcosisIndex > NARCOSIS_VIGNETTE_INDEX
    ? Math.min(NARCOSIS_VIGNETTE_MAX_ALPHA, (narcosisIndex - NARCOSIS_VIGNETTE_INDEX) * 0.82)
    : 0;
}

/**
 * Legacy's wobble in screen pixels: a translate of `sin(t * 0.002) * str`
 * across and `cos(t * 0.0015) * str * 0.5` down, t in milliseconds and `str =
 * (index - 0.25) * 8`. Legacy reads Date.now(); this reads the scene's real
 * time, so a pinned clock pins it. None at 0.25 or below.
 */
export function narcosisWobblePx(
  narcosisIndex: number,
  elapsedRealS: number,
): { readonly x: number; readonly y: number } {
  if (!(narcosisIndex > NARCOSIS_WOBBLE_INDEX)) {
    return { x: 0, y: 0 };
  }
  const strength = (narcosisIndex - NARCOSIS_WOBBLE_INDEX) * 8;
  const ms = elapsedRealS * 1000;
  return {
    x: Math.sin(ms * 0.002) * strength,
    y: Math.cos(ms * 0.0015) * strength * 0.5,
  };
}
