import {
  createCcrState,
  createEmptyDiveLog,
  createGasMix,
  createInitialDiveState,
  freezeDiveState,
  type DiveLog,
  type DiveLogEntry,
  type DiveState,
  type TissueState,
} from "../core/dive-state";
import {
  CEILING_VIOLATION_WINDOW_S,
  FAST_ASCENT_WINDOW_S,
} from "../core/dive-model";
import { normalizeSeed } from "../core/rng";
import {
  bars,
  litres,
  litresPerMinute,
  metres,
  minutes,
  minutesToSeconds,
  seconds,
} from "../core/units";

export interface LegacyTissueCheckpoint {
  state: {
    depth_m: number;
    maxDepth_m: number;
    diveTime_min: number;
    diveMode?: string;
    activeTankIndex?: number;
    cns_percent?: number;
    verticalVelocity_mpm?: number;
    bcdGasSurface_l?: number;
    ndlDroppedBelow5?: boolean;
    /**
     * The adaptive safety stop (#199). remaining_min is legacy's
     * safetyStopRemaining, which is in seconds despite the recorded name.
     */
    safetyStop?: {
      needed: boolean;
      remaining_min: number | null;
      countdownStarted: boolean;
      paused: boolean;
      complete: boolean;
    };
    /**
     * The debriefing capture's continuation state (#199): legacy's
     * ascentRate, minNdlSeen, and the two windows' accumulators and the fast
     * ascent's peak. A fired window's -Infinity and an Infinity minNdlSeen
     * are recorded as null.
     */
    debrief?: {
      ascentRate_mpm: number | null;
      minNdlSeen_min: number | null;
      fastAscentAccum_s: number | null;
      fastAscentPeak_mpm: number | null;
      ceilingViolationAccum_s: number | null;
      avgDepthAccum_ms?: number | null;
      avgDepthSamples_s?: number | null;
      profileTimer_s?: number | null;
      frameCeiling_m?: number | null;
      dcsViolation_s?: number | null;
    };
    /** Legacy's gameOverReason once the dive has failed, else null. */
    gameOverReason?: string | null;
  };
  /**
   * Legacy's diveProfile samples taken since the previous checkpoint (#199),
   * time in minutes. A dive continued from a checkpoint needs the earlier
   * checkpoints' samples too; see diveStateFromLegacyCheckpoint.
   */
  profile?: readonly LegacyProfileSample[];
  /** Legacy's diveEvents: time in minutes, legacy's kind names. */
  events?: readonly { t: number; kind: string; value: unknown }[];
  configuration?: {
    amv_lpm?: number;
  };
  tissues: {
    n2_bar: readonly number[];
    he_bar: readonly number[];
  };
  tanks?: readonly {
    fO2: number;
    fHe: number;
    volume_l: number;
    pressure_bar: number;
    gasRemaining_l: number;
    /** Legacy's totalGas (#199); volume times pressure when absent. */
    totalGas_l?: number | null;
  }[];
  ccr?: {
    targetPO2_bar: number;
    actualPO2_bar: number;
    diluent: {
      fO2: number;
      fHe: number;
    };
    o2Pressure_bar: number;
    diluentPressure_bar: number;
    scrubberRemaining_min: number;
    o2PressureStart_bar?: number | null;
    diluentPressureStart_bar?: number | null;
    scrubberTotal_min?: number | null;
    onBailout: boolean;
  };
}

export interface LegacyProfileSample {
  t_min: number;
  depth_m: number;
  ceiling_m: number;
}

/**
 * The model state a legacy checkpoint describes. `earlierProfile` is the
 * profile samples of the checkpoints before this one, in order: a checkpoint
 * records only the samples since the previous checkpoint, as it does its
 * trajectory, so a dive continued from mid-dive passes the rest.
 */
export function diveStateFromLegacyCheckpoint(
  checkpoint: LegacyTissueCheckpoint,
  seed = 0,
  earlierProfile: readonly LegacyProfileSample[] = [],
): DiveState {
  const tanks = checkpoint.tanks?.map((tank) => ({
    gas: createGasMix(tank.fO2, tank.fHe),
    volumeL: litres(tank.volume_l),
    gasRemainingL: litres(tank.gasRemaining_l),
    startGasL: litres(tank.totalGas_l ?? tank.volume_l * tank.pressure_bar),
  }));
  const legacyCcr = checkpoint.ccr;
  const ccr =
    checkpoint.state.diveMode === "ccr" && legacyCcr
      ? {
          ...createCcrState(
            createGasMix(legacyCcr.diluent.fO2, legacyCcr.diluent.fHe),
            {
              targetPo2Bar: bars(legacyCcr.targetPO2_bar),
              actualPo2Bar: bars(legacyCcr.actualPO2_bar),
              oxygenCylinderPressureBar: bars(legacyCcr.o2Pressure_bar),
              diluentCylinderPressureBar: bars(
                legacyCcr.diluentPressure_bar,
              ),
              scrubberRemainingS: minutesToSeconds(
                minutes(legacyCcr.scrubberRemaining_min),
              ),
              // #199: the dive's start values, or the current ones for a
              // checkpoint recorded before they were.
              oxygenCylinderStartPressureBar: bars(
                legacyCcr.o2PressureStart_bar ?? legacyCcr.o2Pressure_bar,
              ),
              diluentCylinderStartPressureBar: bars(
                legacyCcr.diluentPressureStart_bar ?? legacyCcr.diluentPressure_bar,
              ),
              scrubberTotalS: minutesToSeconds(
                minutes(legacyCcr.scrubberTotal_min ?? legacyCcr.scrubberRemaining_min),
              ),
            },
          ),
          onBailout: legacyCcr.onBailout,
        }
      : null;
  const initialState = createInitialDiveState(seed, {
    tanks,
    activeTankIndex: checkpoint.state.activeTankIndex,
    surfaceAirConsumptionLpm: checkpoint.configuration?.amv_lpm,
    ccr,
  });
  const tissues: TissueState = {
    nitrogenBar: checkpoint.tissues.n2_bar.map(bars),
    heliumBar: checkpoint.tissues.he_bar.map(bars),
  };

  return freezeDiveState({
    ...initialState,
    elapsedTimeS: minutesToSeconds(minutes(checkpoint.state.diveTime_min)),
    depthM: metres(checkpoint.state.depth_m),
    maxDepthM: metres(checkpoint.state.maxDepth_m),
    tissues,
    randomState: normalizeSeed(seed),
    surfaceAirConsumptionLpm: litresPerMinute(
      checkpoint.configuration?.amv_lpm ??
        initialState.surfaceAirConsumptionLpm,
    ),
    cnsPercent: checkpoint.state.cns_percent ?? 0,
    verticalVelocityMpm: checkpoint.state.verticalVelocity_mpm ?? 0,
    bcdGasSurfaceLiters:
      checkpoint.state.bcdGasSurface_l ?? initialState.bcdGasSurfaceLiters,
    failure: {
      ...initialState.failure,
      dcsViolationS: seconds(checkpoint.state.debrief?.dcsViolation_s ?? 0),
    },
    log: logFromLegacyCheckpoint(checkpoint, earlierProfile),
    safetyStop: checkpoint.state.safetyStop
      ? {
          needed: checkpoint.state.safetyStop.needed,
          countdownStarted: checkpoint.state.safetyStop.countdownStarted,
          remainingS: seconds(checkpoint.state.safetyStop.remaining_min ?? 0),
          paused: checkpoint.state.safetyStop.paused,
          complete: checkpoint.state.safetyStop.complete,
        }
      : initialState.safetyStop,
  });
}

/**
 * The dive log (#199) a legacy checkpoint continues from. A window legacy
 * has fired (accumulator -Infinity, recorded as null) is latched; the log
 * holds it at its full length, as the model does once it has fired.
 */
function logFromLegacyCheckpoint(
  checkpoint: LegacyTissueCheckpoint,
  earlierProfile: readonly LegacyProfileSample[],
): DiveLog {
  const debrief = checkpoint.state.debrief;
  const empty = createEmptyDiveLog();
  const profile = [...earlierProfile, ...(checkpoint.profile ?? [])].map((sample) => ({
    elapsedTimeS: minutesToSeconds(minutes(sample.t_min)),
    depthM: metres(sample.depth_m),
    ceilingM: metres(sample.ceiling_m),
  }));
  if (!debrief) {
    return {
      ...empty,
      entries: logEntriesFromLegacyEvents(checkpoint.events ?? []),
      ndlDroppedBelowFiveMinutes: checkpoint.state.ndlDroppedBelow5 ?? false,
      profile,
    };
  }
  const fastAscentLatched = debrief.fastAscentAccum_s === null;
  const ceilingViolationLatched = debrief.ceilingViolationAccum_s === null;
  return {
    entries: logEntriesFromLegacyEvents(checkpoint.events ?? []),
    ascentRateMpm: debrief.ascentRate_mpm ?? 0,
    fastAscentS: fastAscentLatched
      ? FAST_ASCENT_WINDOW_S
      : seconds(debrief.fastAscentAccum_s ?? 0),
    fastAscentPeakMpm: debrief.fastAscentPeak_mpm ?? 0,
    fastAscentLatched,
    ceilingViolationS: ceilingViolationLatched
      ? CEILING_VIOLATION_WINDOW_S
      : seconds(debrief.ceilingViolationAccum_s ?? 0),
    ceilingViolationLatched,
    minNdlMin: debrief.minNdlSeen_min,
    ndlDroppedBelowFiveMinutes: checkpoint.state.ndlDroppedBelow5 ?? false,
    depthTimeMS: debrief.avgDepthAccum_ms ?? 0,
    submergedS: seconds(debrief.avgDepthSamples_s ?? 0),
    profile,
    profileTimerS: seconds(debrief.profileTimer_s ?? 0),
    lastCeilingM: metres(debrief.frameCeiling_m ?? 0),
  };
}

/**
 * The entries of the dive log (#199) among legacy's recorded diveEvents: the
 * kinds the log keeps, renamed, with the time in seconds.
 */
export function logEntriesFromLegacyEvents(
  events: readonly { t: number; kind: string; value: unknown }[],
): DiveLogEntry[] {
  const entries: DiveLogEntry[] = [];
  for (const event of events) {
    if (event.kind !== "fastAscent" && event.kind !== "ceilingViolation") {
      continue;
    }
    entries.push({
      kind: event.kind === "fastAscent" ? "fast-ascent" : "ceiling-violation",
      elapsedTimeS: minutesToSeconds(minutes(event.t)),
      value: Number(event.value),
    });
  }
  return entries;
}
