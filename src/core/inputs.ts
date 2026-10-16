/**
 * The discrete in-dive acts read in one frame (#202): legacy's cylinder keys
 * 1-6, the setpoint keys [ and ], and B. Legacy's updateDiving() reads each
 * at its own point in the frame, after the frame's tissues and decompression
 * limits (src/game-loop.js TASK-019, the setpoint adjustment, TASK-032F), so
 * the frame an act arrives in still loads the tissues on the old gas.
 * advanceDiveStep applies them at those points.
 */
export interface DiveActs {
  /**
   * The cylinders asked for. Legacy holds one flag per key, so a key pressed
   * twice before the frame reads it is one switch, and its loop reads the
   * keys in cylinder order, not in the order they were pressed.
   */
  switchGasIndices: readonly number[];
  /**
   * The setpoint steps, in bar: legacy reads [ and then ], each at most once
   * per frame.
   */
  setpointStepsBar: readonly number[];
  bailout: boolean;
}

export interface InputIntent extends DiveActs {
  ascend: boolean;
  descend: boolean;
  finLeft: boolean;
  finRight: boolean;
  inflateBcd: boolean;
  ventBcd: boolean;
  toggleTorch: boolean;
}

export const NO_ACTS: Readonly<DiveActs> = Object.freeze({
  switchGasIndices: Object.freeze([]),
  setpointStepsBar: Object.freeze([]),
  bailout: false,
});

export const NO_INPUT: Readonly<InputIntent> = Object.freeze({
  ascend: false,
  descend: false,
  finLeft: false,
  finRight: false,
  inflateBcd: false,
  ventBcd: false,
  toggleTorch: false,
  ...NO_ACTS,
});

/** Whether a frame carries any act. */
export function hasActs(acts: Readonly<DiveActs>): boolean {
  return (
    acts.switchGasIndices.length > 0 ||
    acts.setpointStepsBar.length > 0 ||
    acts.bailout
  );
}
