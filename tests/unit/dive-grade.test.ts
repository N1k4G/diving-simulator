import { describe, expect, it } from "vitest";

import { formatGradeNote, gradeLabel } from "../../src/app/debrief-grade";
import { gradeDive } from "../../src/core/dive-grade";
import {
  createCcrState,
  createGasMix,
  createInitialDiveState,
  createTankState,
  freezeDiveState,
  type DiveLogEntry,
  type DiveProfileSample,
  type DiveState,
} from "../../src/core/dive-state";
import { bars, litres, metres, seconds } from "../../src/core/units";

// gradeDive() (#199 slice 6b): the cases the recorded dives do not reach.
// The parity test compares every recorded checkpoint with legacy.

const OPEN = { overheadSite: false };

function dive(change: Partial<DiveState> = {}): DiveState {
  return freezeDiveState({ ...createInitialDiveState(5), ...change });
}

function withLog(entries: DiveLogEntry[], minNdlMin: number | null = null, profile: DiveProfileSample[] = []): DiveState {
  const base = createInitialDiveState(5);
  return freezeDiveState({ ...base, log: { ...base.log, entries, minNdlMin, profile } });
}

const entry = (kind: DiveLogEntry["kind"], value: number, at = 60): DiveLogEntry => ({ kind, elapsedTimeS: seconds(at), value });

/** A profile sampled every 2 s at the given depths. */
const profileOf = (depths: number[]): DiveProfileSample[] =>
  depths.map((depthM, i) => ({ elapsedTimeS: seconds(2 * (i + 1)), depthM: metres(depthM), ceilingM: metres(0) }));

describe("gradeDive", () => {
  it("gives a clean dive full marks and three stars", () => {
    const grade = gradeDive(dive(), OPEN);
    expect(grade.scores.map((s) => s.score)).toEqual([100, 100, 100, 100, 100]);
    expect(grade.overall).toBe(100);
    expect(grade.stars).toBe(3);
  });

  it("takes 15 points per fast ascent and reports the peak", () => {
    const grade = gradeDive(withLog([entry("fast-ascent", 10.04), entry("fast-ascent", 12.36, 90)]), OPEN);
    expect(grade.scores[0]).toMatchObject({ score: 70, note: { key: "ascentBad", count: 2, peakMpm: 12.36 } });
    expect(formatGradeNote(grade.scores[0]!.note, "en")).toMatch(/^Fast ascent 2x \(peak 12\.4 m\/min\)/);
  });

  it("takes 30 points per broken ceiling, never below zero", () => {
    const four = [1, 2, 3, 4].map((i) => entry("ceiling-violation", 1, i * 60));
    expect(gradeDive(withLog(four), OPEN).scores[3]).toMatchObject({ score: 0, note: { key: "decoBad", count: 4 } });
  });

  it("hints at a close NDL below 3 minutes, and not at 3", () => {
    expect(gradeDive(withLog([], 2), OPEN).scores[3]!.note).toEqual({ key: "decoNdlClose", ndlMin: 2 });
    expect(gradeDive(withLog([], 3), OPEN).scores[3]!.note).toEqual({ key: "decoClean" });
    expect(gradeDive(withLog([], null), OPEN).scores[3]!.note).toEqual({ key: "decoClean" });
  });

  it("grades the safety stop: done, not needed, skipped", () => {
    const stop = (needed: boolean, complete: boolean) =>
      gradeDive(dive({ safetyStop: { ...createInitialDiveState(5).safetyStop, needed, complete } }), OPEN).scores[1];
    expect(stop(true, true)).toMatchObject({ score: 100, note: { key: "safetyDone" } });
    expect(stop(false, false)).toMatchObject({ score: 100, note: { key: "safetyNotNeeded" } });
    expect(stop(true, false)).toMatchObject({ score: 30, note: { key: "safetySkipped" } });
  });

  it("grades the gas left on the emptiest cylinder, full at 50 bar", () => {
    const base = createInitialDiveState(5, {
      tanks: [createTankState(createGasMix(0.21, 0), 12, 200), createTankState(createGasMix(0.5, 0), 7, 200)],
    });
    // 12 L at 100 bar and 7 L at 20 bar: graded on the 20 bar.
    const tanks = [
      { ...base.tanks[0]!, gasRemainingL: litres(1200) },
      { ...base.tanks[1]!, gasRemainingL: litres(140) },
    ];
    const grade = gradeDive(freezeDiveState({ ...base, elapsedTimeS: seconds(1800), tanks }), OPEN);
    expect(grade.scores[2]).toMatchObject({ score: 40, note: { key: "gasEnd", bar: 20 } });
    expect(formatGradeNote(grade.scores[2]!.note, "en")).toMatch(/^Surfaced with 20 bar\./);
  });

  it("grades a rebreather dive on its diluent cylinder", () => {
    const base = createInitialDiveState(5, { ccr: createCcrState(createGasMix(0.21, 0)) });
    const ccr = { ...base.ccr!, diluentCylinderPressureBar: bars(35) };
    const grade = gradeDive(freezeDiveState({ ...base, elapsedTimeS: seconds(1800), ccr }), OPEN);
    expect(grade.scores[2]).toMatchObject({ score: 70, note: { key: "gasEnd", bar: 35 } });
  });

  it("grades an overhead site by the rule of thirds instead", () => {
    const reserve = dive({ thirds: { startingGasL: litres(0), turnWarned: false, reserveHit: true } });
    expect(gradeDive(reserve, { overheadSite: true }).scores[2]).toMatchObject({ score: 40, note: { key: "gasReserveHit" } });
    expect(gradeDive(dive(), { overheadSite: true }).scores[2]).toMatchObject({ score: 100, note: { key: "gasThirdsClean" } });
  });

  it("grades trim from a held depth's spread, 100 at 0.5 m and 0 at 3 m", () => {
    // Held near 10 m, swinging 0.4 m either way around the window's mean.
    const steady = profileOf(Array.from({ length: 40 }, (_, i) => 10 + (i % 2 === 0 ? 0.4 : -0.4)));
    const held = gradeDive(withLog([], null, steady), OPEN).scores[4]!;
    expect(held.note.key).toBe("trimReport");
    expect(held.score).toBeGreaterThan(90);
    // Never within 1 m over a window: no hold to grade, full marks.
    const bounce = profileOf(Array.from({ length: 40 }, (_, i) => i * 2));
    expect(gradeDive(withLog([], null, bounce), OPEN).scores[4]).toMatchObject({ score: 100, note: { key: "trimNoHold" } });
  });

  it("gives stars from 50, 75 and 92", () => {
    // Ascent 100 - 15k and deco 100 - 30m set the overall.
    const overall = (fast: number, broken: number) => {
      const entries = [
        ...Array.from({ length: fast }, (_, i) => entry("fast-ascent", 10, 10 + i)),
        ...Array.from({ length: broken }, (_, i) => entry("ceiling-violation", 1, 100 + i)),
      ];
      return gradeDive(withLog(entries), OPEN);
    };
    expect(overall(0, 1)).toMatchObject({ overall: 94, stars: 3 });
    expect(overall(2, 1)).toMatchObject({ overall: 88, stars: 2 });
    expect(overall(5, 3)).toMatchObject({ overall: 67, stars: 1 });
    expect(overall(7, 4)).toMatchObject({ overall: 60, stars: 1 });
  });

  it("rounds the overall score, as legacy does", () => {
    // 12 L at 21 bar: a gas score of 42, so the five add up to 442.
    const base = createInitialDiveState(5);
    const tanks = [{ ...base.tanks[0]!, gasRemainingL: litres(252) }];
    const grade = gradeDive(freezeDiveState({ ...base, elapsedTimeS: seconds(1800), tanks }), OPEN);
    expect(grade.scores[2]!.score).toBe(42);
    expect(grade.overall).toBe(88);
  });

  it("reads in German as legacy does, numbers included", () => {
    expect(gradeLabel("trim", "de")).toBe("Trimm & Tarierung");
    expect(formatGradeNote({ key: "trimReport", stddevM: 0.034 }, "de"))
      .toBe("Tiefe auf ±0.03 m Streuung gehalten. Ziel: ±0,5 m — Auf-und-ab verbraucht Gas und wirbelt Silt auf.");
    expect(formatGradeNote({ key: "decoBad", count: 2 }, "de")).toMatch(/^2x die Deko-Decke gerissen\./);
  });
});
