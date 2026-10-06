// What the post-dive screen shows (#159), derived from the state the dive
// ended in: legacy's drawPostDive() reads these off its globals, here they
// are computed once from the model's state, so the view only formats them.
import { gradeDive, type DiveGrade, type GradeContext } from "../core/dive-grade";
import type {
  DiveLogEntry,
  DiveProfileSample,
  DiveState,
  GasMix,
} from "../core/dive-state";

/** One open-circuit cylinder: legacy's `totalGas - gasRemaining` of `totalGas`. */
export interface PostDiveCylinder {
  readonly index: number;
  readonly gas: Readonly<GasMix>;
  readonly usedL: number;
  readonly startL: number;
}

/**
 * The rebreather's own supplies (legacy BUG-24): what the oxygen and
 * diluent cylinders gave, what is left in them, and the scrubber time used.
 * A rebreather dive does not breathe from its open-circuit cylinder list,
 * so that list is not reported for it.
 */
export interface PostDiveRebreather {
  readonly oxygenUsedL: number;
  readonly oxygenLeftBar: number;
  readonly diluentUsedL: number;
  readonly diluentLeftBar: number;
  readonly scrubberUsedS: number;
  readonly onBailout: boolean;
}

/**
 * The adaptive safety stop at the end of the dive. Legacy warns only for a
 * stop that was needed and not done; the grade's safety-stop row says the
 * other two.
 */
export type SafetyStopOutcome = "done" | "not-needed" | "skipped";

export interface PostDiveSummary {
  readonly elapsedTimeS: number;
  readonly maxDepthM: number;
  /** Legacy's avgDepthAccum / avgDepthSamples: time-weighted, deeper than 0.5 m. */
  readonly averageDepthM: number;
  readonly grade: DiveGrade;
  /** Legacy's diveEvents, in the order they happened. */
  readonly violations: readonly Readonly<DiveLogEntry>[];
  /** Empty on a rebreather dive. */
  readonly cylinders: readonly PostDiveCylinder[];
  readonly rebreather: PostDiveRebreather | null;
  readonly safetyStop: SafetyStopOutcome;
  readonly profile: readonly Readonly<DiveProfileSample>[];
}

export function createPostDiveSummary(
  state: DiveState,
  context: Readonly<GradeContext>,
): PostDiveSummary {
  const { log, ccr, safetyStop } = state;
  const rebreather: PostDiveRebreather | null = ccr
    ? Object.freeze({
        oxygenUsedL:
          (ccr.oxygenCylinderStartPressureBar - ccr.oxygenCylinderPressureBar) *
          ccr.oxygenCylinderVolumeL,
        oxygenLeftBar: ccr.oxygenCylinderPressureBar,
        diluentUsedL:
          (ccr.diluentCylinderStartPressureBar - ccr.diluentCylinderPressureBar) *
          ccr.diluentCylinderVolumeL,
        diluentLeftBar: ccr.diluentCylinderPressureBar,
        scrubberUsedS: ccr.scrubberTotalS - ccr.scrubberRemainingS,
        onBailout: ccr.onBailout,
      })
    : null;
  const cylinders = ccr
    ? []
    : state.tanks.map((tank, index) =>
        Object.freeze({
          index,
          gas: Object.freeze({ ...tank.gas }),
          usedL: tank.startGasL - tank.gasRemainingL,
          startL: tank.startGasL,
        }),
      );
  return Object.freeze({
    elapsedTimeS: state.elapsedTimeS,
    maxDepthM: state.maxDepthM,
    averageDepthM: log.submergedS > 0 ? log.depthTimeMS / log.submergedS : 0,
    grade: gradeDive(state, context),
    violations: log.entries,
    cylinders: Object.freeze(cylinders),
    rebreather,
    safetyStop: !safetyStop.needed
      ? "not-needed"
      : safetyStop.complete
        ? "done"
        : "skipped",
    profile: log.profile,
  });
}
