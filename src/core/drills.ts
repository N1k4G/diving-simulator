// The training drills (#160): legacy's scripted decision drills of #45
// (src/game-loop.js isDrillEligibleNow ... dismissDrillDebrief, the DRILLS
// catalog in src/constants.js).
//
// - Opt-in. At most one per dive, between 3 and 15 dive minutes, deeper than
//   8 m, and only while no alarm is counting.
// - It stops the dive at a decision: the diver picks an option, the option's
//   effect is applied at once, and a debriefing says whether it was right and
//   why, for 5 real seconds or until dismissed. Then the dive runs on, with the
//   effects that outlast it: a free-flow for 45 dive seconds, a held breath
//   for 30.
//
// Legacy's third drill, lightFailure, and its torch flicker fire only in the
// cave (`diveSite === 'cave'`), which this client does not draw yet (#167).
//
// Pure, like the model: the controller rolls, pauses and applies; the
// model reads the effects under way through its DrillEffects.
import { CCR_SETPOINT_STEP_BAR, type DiveState } from "./dive-state";

/** DRILL_MIN_DIVETIME_MIN and DRILL_MAX_DIVETIME_MIN, in dive seconds. */
export const DRILL_MIN_DIVE_TIME_S = 3 * 60;
export const DRILL_MAX_DIVE_TIME_S = 15 * 60;
/** DRILL_MIN_DEPTH_M: no drill in the last few metres. */
export const DRILL_MIN_DEPTH_M = 8;
/**
 * DRILL_TRIGGER_PROB_PER_SEC. Legacy hands it to
 * perSecondToPerFrameProbability(), which reads it as the chance per frame
 * at 60 fps, so a drill fires within a second or two of becoming eligible.
 */
export const DRILL_TRIGGER_CHANCE = 0.03;
/** DRILL_DEBRIEF_DURATION_SEC: the debriefing's real seconds. */
export const DRILL_DEBRIEF_S = 5;
/** DRILL_FREEFLOW_DURATION_SEC and DRILL_BREATHHOLD_DURATION_SEC, dive seconds. */
export const DRILL_FREEFLOW_S = 45;
export const DRILL_BREATH_HOLD_S = 30;

export type DrillId = "freeflow" | "co2";
/** What an option does to the dive the moment it is picked. */
export type DrillEffect = "freeflow" | "switchToBackup" | "holdBreath" | "bailOut" | "raiseSetpoint";

interface DrillOption {
  readonly correct: boolean;
  /** Legacy's requiresMultiTank: offered only with a second cylinder. */
  readonly multiTankOnly: boolean;
  readonly effect: DrillEffect;
}

interface Drill {
  readonly id: DrillId;
  /** Legacy's precondition. */
  readonly applies: (state: DiveState) => boolean;
  /** Legacy's onTrigger: the co2 drill fails the scrubber as it starts. */
  readonly failsScrubber: boolean;
  readonly options: readonly DrillOption[];
}

/** Legacy's DRILLS that the wreck can meet, in its order. */
export const DRILLS: readonly Drill[] = Object.freeze([
  {
    id: "freeflow",
    // OC only: `diveMode !== 'ccr'`.
    applies: (state) => state.ccr === null,
    failsScrubber: false,
    options: [
      { correct: true, multiTankOnly: false, effect: "freeflow" },
      { correct: true, multiTankOnly: true, effect: "switchToBackup" },
      { correct: false, multiTankOnly: false, effect: "holdBreath" },
    ],
  },
  {
    id: "co2",
    applies: (state) => state.ccr !== null && !state.ccr.onBailout && !state.ccr.scrubberFailed,
    failsScrubber: true,
    options: [
      { correct: true, multiTankOnly: false, effect: "bailOut" },
      { correct: false, multiTankOnly: false, effect: "raiseSetpoint" },
    ],
  },
]);

/**
 * Legacy's drillState. `overlay` and `debrief` stop the dive (gameState
 * 'drill'); `effect` is a drill that has run, whose free-flow or held breath
 * may still be under way. The effects' ends are dive seconds, 0 for none.
 */
export interface DrillState {
  readonly phase: "inactive" | "overlay" | "debrief" | "effect";
  readonly id: DrillId | null;
  /** Legacy's drillHasRunThisDive. */
  readonly ranThisDive: boolean;
  /** The option picked, by its place among those offered; -1 before. */
  readonly selectedOption: number;
  readonly correct: boolean;
  readonly debriefRemainingS: number;
  readonly freeflowUntilS: number;
  /** The cylinder whose regulator free-flows; -1 for none. */
  readonly freeflowTankIndex: number;
  readonly breathHoldUntilS: number;
}

export const NO_DRILL: DrillState = Object.freeze({
  phase: "inactive",
  id: null,
  ranThisDive: false,
  selectedOption: -1,
  correct: false,
  debriefRemainingS: 0,
  freeflowUntilS: 0,
  freeflowTankIndex: -1,
  breathHoldUntilS: 0,
});

function drillById(id: unknown): Drill | null {
  return DRILLS.find((drill) => drill.id === id) ?? null;
}

/** The drill stops the dive: its decision or its debriefing is up. */
export function drillPausesDive(drill: Readonly<DrillState>): boolean {
  return drill.phase === "overlay" || drill.phase === "debrief";
}

/**
 * Legacy's _drillIsAlarmActive(): any violation timer counting, or a loop
 * already failing. Its bad-air lens is the cave's; the wreck has none.
 */
export function drillAlarmActive(state: DiveState): boolean {
  const { failure } = state;
  if (failure.oxygenToxicityS > 0 || failure.dcsViolationS > 0 || failure.barotraumaS > 0 || failure.hypoxiaS > 0) {
    return true;
  }
  return state.ccr !== null && (failure.ccrHypoxiaS > 0 || failure.ccrHyperoxiaS > 0);
}

/**
 * Legacy's isDrillEligibleNow(), on the state the frame starts from and the
 * dive time the frame has reached, as legacy reads diveTime after advancing it.
 */
export function isDrillEligible(
  drill: Readonly<DrillState>,
  enabled: boolean,
  state: DiveState,
  diveTimeS: number,
): boolean {
  return (
    enabled &&
    !drill.ranThisDive &&
    drill.phase === "inactive" &&
    diveTimeS >= DRILL_MIN_DIVE_TIME_S &&
    diveTimeS <= DRILL_MAX_DIVE_TIME_S &&
    state.depthM > DRILL_MIN_DEPTH_M &&
    !drillAlarmActive(state)
  );
}

/** Legacy's perSecondToPerFrameProbability(DRILL_TRIGGER_PROB_PER_SEC, dtReal). */
export function drillTriggerChance(realS: number): number {
  return realS > 0 ? 1 - Math.pow(1 - DRILL_TRIGGER_CHANCE, realS * 60) : 0;
}

/** Legacy's _pickEligibleDrill(): one of the drills that apply, at random. */
export function pickDrill(state: DiveState, random: () => number): DrillId | null {
  const candidates = DRILLS.filter((drill) => drill.applies(state));
  return candidates[Math.floor(random() * candidates.length)]?.id ?? null;
}

/** Whether the drill fails the loop's scrubber as it starts (the co2 drill's onTrigger). */
export function drillFailsScrubber(id: DrillId): boolean {
  return drillById(id)?.failsScrubber ?? false;
}

/** Legacy's startDrill() and _openDrillOverlay(): the decision goes up. */
export function startDrill(drill: Readonly<DrillState>, id: DrillId): DrillState {
  return Object.freeze({ ...drill, phase: "overlay", id, ranThisDive: true, selectedOption: -1, correct: false });
}

/**
 * The options offered, by their place in the catalogue: legacy's
 * _visibleDrillOptions(), which drops the backup cylinder on a dive with one.
 */
export function visibleDrillOptions(id: DrillId, tankCount: number): readonly number[] {
  const options = drillById(id)?.options ?? [];
  return options.flatMap((option, index) => (option.multiTankOnly && tankCount <= 1 ? [] : [index]));
}

export interface DrillResolution {
  readonly drill: DrillState;
  readonly effect: DrillEffect;
  /** For switchToBackup, the cylinder breathed from now; null when none has gas. */
  readonly switchTo: number | null;
}

/**
 * Legacy's resolveDrillOption(idx), `idx` by place among the options offered:
 * the option's effect, dated by the dive time the dive stopped at, and the
 * debriefing. Null when no decision is up or there is no such option.
 */
export function resolveDrillOption(
  drill: Readonly<DrillState>,
  index: number,
  state: DiveState,
): DrillResolution | null {
  const entry = drillById(drill.id);
  if (drill.phase !== "overlay" || !entry) {
    return null;
  }
  const option = entry.options[visibleDrillOptions(entry.id, state.tanks.length)[index] ?? -1];
  if (!option) {
    return null;
  }
  const nowS = state.elapsedTimeS;
  let next: DrillState = { ...drill, phase: "debrief", selectedOption: index, correct: option.correct, debriefRemainingS: DRILL_DEBRIEF_S };
  let switchTo: number | null = null;
  if (option.effect === "freeflow") {
    next = { ...next, freeflowUntilS: nowS + DRILL_FREEFLOW_S, freeflowTankIndex: state.activeTankIndex };
  } else if (option.effect === "switchToBackup") {
    // The first other cylinder with gas; the old one goes on free-flowing.
    const found = state.tanks.findIndex((tank, i) => i !== state.activeTankIndex && tank.gasRemainingL > 0);
    switchTo = found >= 0 ? found : null;
    next = { ...next, freeflowUntilS: nowS + DRILL_FREEFLOW_S, freeflowTankIndex: state.activeTankIndex };
  } else if (option.effect === "holdBreath") {
    next = { ...next, breathHoldUntilS: nowS + DRILL_BREATH_HOLD_S };
  }
  return { drill: Object.freeze(next), effect: option.effect, switchTo };
}

/** The model's acts an option's effect takes, and its log of the outcome. */
export interface DrillActs {
  switchGas(index: number): DiveState;
  bailOut(): DiveState;
  adjustSetpoint(deltaBar: number): DiveState;
  recordDrillOutcome(drillId: DrillId, option: number, correct: boolean): DiveState;
}

/**
 * The option's effect on the dive, through the model's own acts, refused
 * where it refuses them: the cylinder of legacy's switch to the backup, the
 * co2 drill's bailout (`onBailout = true; co2BuildupTime = 0`) and its
 * `ccrAdjustSP(0.1)`. The free-flow and the held breath are the drill's own.
 * Then the outcome goes to the dive log, as legacy pushes its drillOutcome
 * event after the effect, whether or not the model took the act.
 */
export function applyDrillEffect(model: DrillActs, resolution: Readonly<DrillResolution>): void {
  if (resolution.effect === "switchToBackup" && resolution.switchTo !== null) {
    model.switchGas(resolution.switchTo);
  } else if (resolution.effect === "bailOut") {
    model.bailOut();
  } else if (resolution.effect === "raiseSetpoint") {
    model.adjustSetpoint(CCR_SETPOINT_STEP_BAR);
  }
  const { id, selectedOption, correct } = resolution.drill;
  if (id !== null) {
    model.recordDrillOutcome(id, selectedOption, correct);
  }
}

/**
 * A drill outcome the model could have logged on this dive (#160): a drill
 * of the dive's breathing (the free-flow on open circuit, the co2 drill on a
 * loop), an option offered with the dive's cylinders, and that option's
 * verdict. A save's log is checked against it.
 */
export function isLoggableDrillOutcome(
  drillId: unknown,
  option: unknown,
  correct: unknown,
  state: Pick<DiveState, "ccr" | "tanks">,
): boolean {
  const drill = drillById(drillId);
  if (!drill || drill.id !== (state.ccr === null ? "freeflow" : "co2") || !Number.isInteger(option)) {
    return false;
  }
  const offered = visibleDrillOptions(drill.id, state.tanks.length)[option as number];
  return offered !== undefined && drill.options[offered]?.correct === correct;
}

/** Legacy's dismissDrillDebrief(): Enter, a tap, or the debriefing's time. */
export function dismissDrillDebrief(drill: Readonly<DrillState>): DrillState {
  return drill.phase === "debrief" ? Object.freeze({ ...drill, phase: "effect", debriefRemainingS: 0 }) : drill;
}

/** The debriefing's real seconds run down, and it goes when they are spent. */
export function tickDrillDebrief(drill: Readonly<DrillState>, realS: number): DrillState {
  if (drill.phase !== "debrief") {
    return drill;
  }
  const remainingS = drill.debriefRemainingS - realS;
  return remainingS <= 0 ? dismissDrillDebrief(drill) : Object.freeze({ ...drill, debriefRemainingS: remainingS });
}

const DRILL_PHASES: readonly unknown[] = ["inactive", "overlay", "debrief", "effect"];

function isNonNegativeFinite(candidate: unknown): candidate is number {
  return typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0;
}

/**
 * The drill a resumed dive picks up (#160): legacy's restoreDiveState() of
 * drillState and drillHasRunThisDive, checked as its _isValidSaveState()
 * checks them. A phase and its drill, an id only once one has started, and
 * a free-flowing cylinder exactly while the free-flow lasts, one the dive
 * has. Legacy's 'surface' holds no drill; here a drill under way needs the
 * dive time one can start at. The debriefing's real seconds are saved as
 * those left, as legacy's debriefRemainingSec.
 *
 * Where legacy refuses the whole save, a record the controller could not have
 * written drops only the drill: the dive resumes with none under way, and
 * with the drill run if the record says so (docs/decisions.md).
 */
export function resumedDrill(candidate: unknown, state: DiveState): DrillState {
  if (typeof candidate !== "object" || candidate === null) {
    return NO_DRILL;
  }
  const record = candidate as Record<keyof DrillState, unknown>;
  const { phase, id, ranThisDive, selectedOption, correct, debriefRemainingS } = record;
  const { freeflowUntilS, freeflowTankIndex, breathHoldUntilS } = record;
  const valid =
    typeof ranThisDive === "boolean" &&
    DRILL_PHASES.includes(phase) &&
    (phase === "inactive"
      ? id === null
      : drillById(id) !== null && state.elapsedTimeS >= DRILL_MIN_DIVE_TIME_S) &&
    Number.isInteger(selectedOption) &&
    (selectedOption as number) >= -1 &&
    typeof correct === "boolean" &&
    isNonNegativeFinite(debriefRemainingS) &&
    debriefRemainingS <= DRILL_DEBRIEF_S &&
    isNonNegativeFinite(breathHoldUntilS) &&
    isNonNegativeFinite(freeflowUntilS) &&
    Number.isInteger(freeflowTankIndex) &&
    (freeflowUntilS > 0
      ? (freeflowTankIndex as number) >= 0 && (freeflowTankIndex as number) < state.tanks.length
      : freeflowTankIndex === -1);
  if (!valid) {
    return ranThisDive === true ? Object.freeze({ ...NO_DRILL, ranThisDive: true }) : NO_DRILL;
  }
  return Object.freeze({
    phase: phase as DrillState["phase"],
    id: id as DrillId | null,
    ranThisDive: ranThisDive as boolean,
    selectedOption: selectedOption as number,
    correct: correct as boolean,
    debriefRemainingS: debriefRemainingS as number,
    freeflowUntilS: freeflowUntilS as number,
    freeflowTankIndex: freeflowTankIndex as number,
    breathHoldUntilS: breathHoldUntilS as number,
  });
}

/** Legacy's updateDiving(): a free-flow past its end stops, on the frame's dive time. */
export function expireDrillEffects(drill: Readonly<DrillState>, diveTimeS: number): DrillState {
  return drill.freeflowUntilS > 0 && diveTimeS >= drill.freeflowUntilS
    ? Object.freeze({ ...drill, freeflowUntilS: 0, freeflowTankIndex: -1 })
    : drill;
}
