// Narcosis below the KO (#220, owner decision of 2026-10-07): legacy's
// swallowed inputs and vertical drift (src/game-loop.js WP-020), ported with
// their draws from the dive's seeded random state instead of Math.random.
// Pure: no DOM, no renderer. The tunnel vision and the wobble are the
// renderer's, from the index alone.

/** Above this index held movement keys are swallowed for single frames. */
export const NARCOSIS_INPUT_DROP_INDEX = 0.3;
/** Above this index the vertical velocity drifts. */
export const NARCOSIS_DRIFT_INDEX = 0.45;
/** Legacy's `narcDelay * 0.6`: the drop chance per 60 Hz frame at index 1. */
export const NARCOSIS_DROP_PER_FRAME_AT_60 = 0.6;
/** Legacy's `* 0.3 * driftStrength * dtReal`, and its decay per frame. */
export const NARCOSIS_DRIFT_STEP = 0.3;
export const NARCOSIS_DRIFT_DECAY = 0.98;

/**
 * Legacy's perSecondToPerFrameProbability (src/game-loop.js, issue #69): a
 * chance calibrated per 60 Hz frame, made the same per real second at any
 * frame length.
 */
export function perSecondToPerFrameProbability(p60: number, realS: number): number {
  if (!(realS > 0)) return 0;
  if (p60 <= 0) return 0;
  if (p60 >= 1) return 1;
  return 1 - Math.pow(1 - p60, realS * 60);
}

/** The four held movement keys legacy reads: W, S, A and D, or the arrows. */
export interface MovementControls {
  readonly inflate: boolean;
  readonly vent: boolean;
  readonly left: boolean;
  readonly right: boolean;
}

/**
 * Legacy's swallowed inputs: `narcDelay = (index - 0.3) / 0.7` and each held
 * key kept only when a draw beats `perSecondToPerFrameProbability(narcDelay *
 * 0.6, dtReal)`, drawn in legacy's order, W, S, A, D.
 *
 * Legacy draws for every held key, also at a drop chance of 0, where the
 * draw keeps the key whatever it is. Those draws are skipped here: they
 * cannot change anything, and a dive without narcosis keeps the stream the
 * shark rolls from (#219): a departure recorded in docs/decisions.md.
 */
export function swallowInputs(
  held: Readonly<MovementControls>,
  narcosisIndex: number,
  realS: number,
  draw: () => number,
): MovementControls {
  const delay =
    narcosisIndex > NARCOSIS_INPUT_DROP_INDEX
      ? (narcosisIndex - NARCOSIS_INPUT_DROP_INDEX) / (1 - NARCOSIS_INPUT_DROP_INDEX)
      : 0;
  const dropP = perSecondToPerFrameProbability(delay * NARCOSIS_DROP_PER_FRAME_AT_60, realS);
  if (dropP <= 0) {
    return held;
  }
  const keep = (pressed: boolean): boolean => pressed && draw() > dropP;
  const inflate = keep(held.inflate);
  const vent = keep(held.vent);
  const left = keep(held.left);
  const right = keep(held.right);
  return { inflate, vent, left, right };
}

export interface NarcosisDrift {
  /** Legacy's narcDrift; each frame adds 60 times it to the velocity. */
  readonly drift: number;
  readonly verticalVelocityMpm: number;
}

/**
 * Legacy's drift, after the frame's physics: deeper than the surface and
 * above index 0.45, a random walk `narcDrift += (rand - 0.5) * 0.3 *
 * strength * dtReal`, decayed by 0.98 and added to the velocity, m/min, as
 * `narcDrift * 60`. At 0.45 or below it is 0. The index is the one the frame
 * began with, as legacy updates it later in the frame.
 */
export function narcosisDriftStep(
  drift: number,
  verticalVelocityMpm: number,
  narcosisIndex: number,
  depthM: number,
  realS: number,
  draw: () => number,
): NarcosisDrift {
  if (narcosisIndex <= NARCOSIS_DRIFT_INDEX) {
    return { drift: 0, verticalVelocityMpm };
  }
  if (!(depthM > 0)) {
    return { drift, verticalVelocityMpm };
  }
  const strength = (narcosisIndex - NARCOSIS_DRIFT_INDEX) / (1 - NARCOSIS_DRIFT_INDEX);
  const next = (drift + (draw() - 0.5) * NARCOSIS_DRIFT_STEP * strength * realS) * NARCOSIS_DRIFT_DECAY;
  return { drift: next, verticalVelocityMpm: verticalVelocityMpm + next * 60 };
}
