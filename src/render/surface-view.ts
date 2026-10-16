// The water surface (#199), after src/renderer.js drawScene: a band of light
// water under a moving wave line, the sum of two sines, with the sky above
// it. Legacy draws in screen pixels at 0.05 m a pixel; these are the same
// waves in metres. Shared by the Pixi scene and the development canvas
// renderer (#222), so the two draw the same surface.

export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export const SURFACE_SPAN_M = { left: -60, right: 180 } as const;
export const SKY_TOP_M = -200;
export const SURFACE_WAVES = [
  // sin(x * 0.02 + t * 2) * 4 px, then sin(x * 0.035 + t * 1.5) * 2 px.
  { amplitudeM: 0.2, wavelengthM: 15.7, speedMps: 5, alpha: 0.18, highlight: true },
  { amplitudeM: 0.1, wavelengthM: 9, speedMps: 2.14, alpha: 0.18, highlight: false },
] as const;
export type SurfaceWave = (typeof SURFACE_WAVES)[number];
/** Legacy fills 20 px under the wave line: one metre. */
export const SURFACE_BAND_M = 1;
/** The band's water, rgba(135,206,235) as legacy fills it. */
export const SURFACE_WATER = 0x87ceeb;
/** The wave line is sampled this often along a strip. */
export const SURFACE_STEP_M = 0.5;
/**
 * Legacy's bright line just under the surface (_drawSurfaceUnderside), on
 * the first wave, this far below its line.
 */
export const SURFACE_HIGHLIGHT = {
  color: 0xe6f8ff,
  offsetM: 0.1,
  widthM: 0.06,
  alpha: 0.35,
} as const;

/** Legacy's sky, #c4e6f0 high up to #83bcd2 at the horizon. */
export const SKY_HIGH: Rgb = { r: 0xc4, g: 0xe6, b: 0xf0 };
export const SKY_HORIZON: Rgb = { r: 0x83, g: 0xbc, b: 0xd2 };
/** One-metre bands over the six metres the camera shows above the surface. */
export const SKY_BANDS = 6;

/** The colour of sky band `band`, counted down from the top of the bands. */
export function skyBandColour(band: number): Rgb {
  const t = (band + 0.5) / SKY_BANDS;
  return {
    r: Math.round(SKY_HIGH.r + (SKY_HORIZON.r - SKY_HIGH.r) * t),
    g: Math.round(SKY_HIGH.g + (SKY_HORIZON.g - SKY_HIGH.g) * t),
    b: Math.round(SKY_HIGH.b + (SKY_HORIZON.b - SKY_HIGH.b) * t),
  };
}

/**
 * The wave's line along its strip: from the span's left edge to one
 * wavelength past its right, so that sliding it by up to a wavelength never
 * shows an edge, as flat [x, d, x, d, ...] pairs with the strip unslid.
 */
export function waveLineM(wave: SurfaceWave): number[] {
  const left = SURFACE_SPAN_M.left;
  const right = SURFACE_SPAN_M.right + wave.wavelengthM;
  const line: number[] = [];
  for (let x = left; x <= right; x += SURFACE_STEP_M) {
    line.push(x, -wave.amplitudeM * Math.sin((2 * Math.PI * x) / wave.wavelengthM));
  }
  return line;
}

/**
 * How far the wave's strip slides towards -x at a real time: sin(kx + wt)
 * travels that way, and the strip repeats every wavelength.
 */
export function waveSlideM(wave: SurfaceWave, elapsedRealS: number): number {
  return (elapsedRealS * wave.speedMps) % wave.wavelengthM;
}
