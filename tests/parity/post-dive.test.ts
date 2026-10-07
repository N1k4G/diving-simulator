import { describe, expect, it } from "vitest";

import baselineFixture from "../fixtures/traces/baseline-v1.json";
import {
  diveStateFromLegacyCheckpoint,
  type LegacyProfileSample,
  type LegacyTissueCheckpoint,
} from "../../src/app/legacy-dive-adapter";
import { createPostDiveSummary } from "../../src/presentation/post-dive-summary";
import { siteGameplay } from "../../src/sites/site-resources";

// The post-dive summary (#159) against the legacy client: at every checkpoint
// of every recorded dive, the values legacy's drawPostDive() would draw from
// its globals at that moment, computed with its own expressions, against the
// summary of the model's state there. The grade itself is compared in
// tests/parity/dive-grade.test.ts, and the model's log against legacy's
// diveEvents in dive-log.test.ts and dive-end.test.ts.
//
// The violation list is legacy's diveEvents, which drawDiveProfileChart()
// marks: a fast ascent with its peak, a broken ceiling with how far above it
// the diver was, and a safety stop skipped at the surface.

interface Checkpoint extends LegacyTissueCheckpoint {
  checkpointId: string;
  state: LegacyTissueCheckpoint["state"] & {
    gameState: string;
    diveMode: string;
    diveSite: string;
    diveTime_min: number;
    maxDepth_m: number;
    safetyStop: { needed: boolean; complete: boolean };
    debrief: { avgDepthAccum_ms: number; avgDepthSamples_s: number };
    grade: { scores: number[] };
  };
  tanks: (NonNullable<LegacyTissueCheckpoint["tanks"]>[number] & { totalGas_l: number })[];
  ccr?: NonNullable<LegacyTissueCheckpoint["ccr"]> & {
    o2PressureStart_bar: number;
    diluentPressureStart_bar: number;
    scrubberTotal_min: number;
  };
  events: { t: number; kind: string; value: number }[];
  profile: LegacyProfileSample[];
}

/** src/state.js CCR_DEFAULTS: no recorded dive changes the rebreather's cylinders. */
const LEGACY_O2_CYLINDER_L = 2;
const LEGACY_DILUENT_CYLINDER_L = 3;
const LEGACY_EVENT_KINDS: Record<string, string> = {
  fastAscent: "fast-ascent",
  ceilingViolation: "ceiling-violation",
  safetyStopSkipped: "safety-stop-skipped",
};

const eps = baselineFixture.tolerances.absoluteEpsilon.default;
const scenarios = baselineFixture.scenarios as unknown as { scenarioId: string; checkpoints: Checkpoint[] }[];

const cases = scenarios.flatMap((scenario) =>
  scenario.checkpoints.map((recorded, index) => ({
    name: `${scenario.scenarioId}/${recorded.checkpointId}`,
    recorded,
    earlierProfile: scenario.checkpoints.slice(0, index).flatMap((earlier) => earlier.profile),
  })),
);

function summaryAt(recorded: Checkpoint, earlierProfile: readonly LegacyProfileSample[]) {
  const state = diveStateFromLegacyCheckpoint(recorded, 7, earlierProfile);
  return createPostDiveSummary(state, {
    overheadSite: siteGameplay(recorded.state.diveSite)?.hasOverhead ?? false,
  });
}

describe("the post-dive summary against the recorded legacy dives", () => {
  it.each(cases)("summarises $name as legacy's post-dive screen", ({ recorded, earlierProfile }) => {
    const summary = summaryAt(recorded, earlierProfile);
    const legacy = recorded.state;

    // The stats card: formatTime(diveTime), maxDepth.toFixed(1), avgD.
    expect(Math.abs(summary.elapsedTimeS / 60 - legacy.diveTime_min)).toBeLessThanOrEqual(eps);
    expect(summary.maxDepthM.toFixed(1)).toBe(legacy.maxDepth_m.toFixed(1));
    const legacyAverage = legacy.debrief.avgDepthSamples_s > 0
      ? (legacy.debrief.avgDepthAccum_ms / legacy.debrief.avgDepthSamples_s).toFixed(1)
      : "0.0";
    expect(summary.averageDepthM.toFixed(1)).toBe(legacyAverage);

    // The violation list: every diveEvents entry, in order, with its time and value.
    const legacyEvents = recorded.events.filter((event) => event.kind in LEGACY_EVENT_KINDS);
    expect(summary.violations.map((entry) => entry.kind)).toEqual(
      legacyEvents.map((event) => LEGACY_EVENT_KINDS[event.kind]),
    );
    summary.violations.forEach((entry, index) => {
      expect(Math.abs(entry.elapsedTimeS / 60 - legacyEvents[index]!.t)).toBeLessThanOrEqual(eps);
      expect(Math.abs(entry.value - legacyEvents[index]!.value)).toBeLessThanOrEqual(eps);
    });

    // The safety-stop warning: `safetyStopNeeded && !safetyStopComplete`.
    expect(summary.safetyStop === "skipped").toBe(legacy.safetyStop.needed && !legacy.safetyStop.complete);

    // The gas lines, to the whole litre, bar and minute legacy draws.
    if (legacy.diveMode === "ccr") {
      const ccr = recorded.ccr!;
      expect(summary.cylinders).toEqual([]);
      const rebreather = summary.rebreather!;
      expect(rebreather.oxygenUsedL.toFixed(0)).toBe(
        ((ccr.o2PressureStart_bar - ccr.o2Pressure_bar) * LEGACY_O2_CYLINDER_L).toFixed(0),
      );
      expect(rebreather.oxygenLeftBar.toFixed(0)).toBe(ccr.o2Pressure_bar.toFixed(0));
      expect(rebreather.diluentUsedL.toFixed(0)).toBe(
        ((ccr.diluentPressureStart_bar - ccr.diluentPressure_bar) * LEGACY_DILUENT_CYLINDER_L).toFixed(0),
      );
      expect(rebreather.diluentLeftBar.toFixed(0)).toBe(ccr.diluentPressure_bar.toFixed(0));
      expect((rebreather.scrubberUsedS / 60).toFixed(0)).toBe(
        (ccr.scrubberTotal_min - ccr.scrubberRemaining_min).toFixed(0),
      );
      expect(rebreather.onBailout).toBe(ccr.onBailout);
    } else {
      expect(summary.rebreather).toBeNull();
      expect(summary.cylinders.map((cylinder) => cylinder.usedL.toFixed(0))).toEqual(
        recorded.tanks.map((tank) => (tank.totalGas_l - tank.gasRemaining_l).toFixed(0)),
      );
      expect(summary.cylinders.map((cylinder) => cylinder.startL)).toEqual(
        recorded.tanks.map((tank) => tank.totalGas_l),
      );
    }
  });

  it("matches legacy's post-dive screen for the dives that end on it or log a violation", () => {
    // The acceptance traces (#159): the air dive that surfaces onto legacy's
    // post-dive screen with its stop skipped, the buoyancy dive's fast
    // ascent, and the trimix dive's broken ceiling.
    const named = (name: string) => cases.find((entry) => entry.name === name)!;
    const surfaced = named("air-18m-30min/surfaced");
    expect(surfaced.recorded.state.gameState).toBe("post-dive");
    const surfacedSummary = summaryAt(surfaced.recorded, surfaced.earlierProfile);
    expect(surfacedSummary.safetyStop).toBe("skipped");
    expect(surfacedSummary.violations.map((entry) => entry.kind)).toEqual(["safety-stop-skipped"]);
    expect(surfacedSummary.grade.scores.map((score) => score.score)).toEqual(surfaced.recorded.state.grade.scores);

    const ascent = named("buoyancy-vent-inflate-12m/coasting-30s");
    expect(summaryAt(ascent.recorded, ascent.earlierProfile).violations.map((entry) => entry.kind)).toEqual(["fast-ascent"]);
    const ceiling = named("trimix-dcs-above-stop/above-stop-30s");
    expect(summaryAt(ceiling.recorded, ceiling.earlierProfile).violations.map((entry) => entry.kind)).toEqual(["ceiling-violation"]);

    // Guards the comparison against a fixture that no longer exercises both
    // gas summaries or a dive that ended on bailout.
    expect(cases.some(({ recorded }) => recorded.state.diveMode === "ccr" && recorded.ccr?.onBailout)).toBe(true);
    expect(cases.some(({ recorded }) => recorded.state.diveMode !== "ccr" && recorded.tanks.length > 1)).toBe(true);
  });
});
