import { describe, expect, it } from "vitest";

import baselineFixture from "../fixtures/traces/baseline-v1.json";
import { ceilingDepthM, ndlMinutes } from "../../src/core/decompression";
import { DiveModel, advanceDiveStep } from "../../src/core/dive-model";
import {
  createCcrState,
  createGasMix,
  createInitialDiveState,
  createTankState,
  freezeDiveState,
  type DiveState,
} from "../../src/core/dive-state";
import { bars, metres, seconds } from "../../src/core/units";

// The dive log (#199), on dictated depths so every ascent rate is exact. The
// fast-ascent entries are replayed against legacy's own recordings in
// tests/parity/dive-log.test.ts; these pin the windows and latches of
// src/game-loop.js "Issue #44" where no recording reaches them.

const air = createGasMix(0.21, 0);

function diverAt(depthM: number, base: DiveState = createInitialDiveState(3, { tanks: [createTankState(air)] })): DiveState {
  return freezeDiveState({ ...base, depthM: metres(depthM), maxDepthM: metres(Math.max(depthM, base.maxDepthM)) });
}

/** One-second steps through the given depths. */
function stepThrough(model: DiveModel, depthsM: readonly number[]): void {
  for (const depthM of depthsM) model.advance({ depthM: metres(depthM) }, seconds(1));
}

describe("fast ascents", () => {
  it("are logged once the rate has stayed above 9 m/min for 2 s, with its peak", () => {
    const model = new DiveModel(diverAt(30));
    // 0.2 m in a second is 12 m/min, 0.25 m is 15 m/min.
    stepThrough(model, [29.8]);
    expect(model.snapshot.log.ascentRateMpm).toBeCloseTo(12, 9);
    expect(model.snapshot.log.entries).toEqual([]);
    stepThrough(model, [29.55]);
    const entries = model.snapshot.log.entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("fast-ascent");
    expect(entries[0]?.elapsedTimeS).toBe(2);
    expect(entries[0]?.value).toBeCloseTo(15, 9);
  });

  it("are logged only once while the ascent lasts, and again after it lapses", () => {
    const model = new DiveModel(diverAt(30));
    stepThrough(model, [29.8, 29.6, 29.4, 29.2, 29.0]);
    expect(model.snapshot.log.entries).toHaveLength(1);
    // A slower second resets the window: 0.1 m is 6 m/min.
    stepThrough(model, [28.9]);
    expect(model.snapshot.log.fastAscentLatched).toBe(false);
    stepThrough(model, [28.7, 28.5]);
    expect(model.snapshot.log.entries.map((entry) => entry.kind)).toEqual(["fast-ascent", "fast-ascent"]);
  });

  it("do not count a descent, however fast", () => {
    const model = new DiveModel(diverAt(10));
    stepThrough(model, [11, 12, 13, 14]);
    expect(model.snapshot.log.ascentRateMpm).toBeCloseTo(-60, 9);
    expect(model.snapshot.log.entries).toEqual([]);
  });
});

describe("ceiling violations", () => {
  // Legacy's trimix bottom: every compartment loaded with nitrogen and
  // helium, and a 11.5 m ceiling at GF 75.
  const recorded = (baselineFixture.scenarios as unknown as {
    scenarioId: string;
    checkpoints: { checkpointId: string; tissues: { n2_bar: number[]; he_bar: number[] } }[];
  }[])
    .find((scenario) => scenario.scenarioId === "trimix-45m-20min")
    ?.checkpoints.find((checkpoint) => checkpoint.checkpointId === "bottom-20min");
  const loaded = (depthM: number) =>
    freezeDiveState({
      ...diverAt(depthM),
      maxDepthM: metres(45),
      tissues: {
        nitrogenBar: (recorded?.tissues.n2_bar ?? []).map((value) => bars(value)),
        heliumBar: (recorded?.tissues.he_bar ?? []).map((value) => bars(value)),
      },
    });

  it("are logged after 2 s more than 0.3 m above the ceiling, with how far above", () => {
    const model = new DiveModel(loaded(10));
    stepThrough(model, [10]);
    expect(model.snapshot.log.entries.filter((entry) => entry.kind === "ceiling-violation")).toEqual([]);
    stepThrough(model, [10]);
    const violations = model.snapshot.log.entries.filter((entry) => entry.kind === "ceiling-violation");
    expect(violations).toHaveLength(1);
    expect(violations[0]?.elapsedTimeS).toBe(2);
    // Legacy logs the ceiling of the step it fires on, less the depth.
    expect(violations[0]?.value).toBe(ceilingDepthM(model.snapshot.tissues, 0.75) - 10);
    expect(violations[0]?.value).toBeGreaterThan(1);
  });

  it("allow 0.3 m of tolerance", () => {
    const ceilingM = ceilingDepthM(loaded(11.4).tissues, 0.75);
    const model = new DiveModel(loaded(ceilingM - 0.2));
    stepThrough(model, [ceilingM - 0.2, ceilingM - 0.2, ceilingM - 0.2, ceilingM - 0.2]);
    expect(model.snapshot.log.entries).toEqual([]);
    expect(model.snapshot.log.ceilingViolationS).toBe(0);
  });
});

describe("the step a dive ends on", () => {
  // Legacy returns from updateDiving() on a rebreather failure before the
  // debriefing capture, and fails for everything else after it (#201 Codex
  // round 1). Both steps below complete a fast-ascent window.
  const halfwayUp = (base: DiveState) =>
    freezeDiveState({
      ...diverAt(30, base),
      log: { ...base.log, fastAscentS: seconds(1.5), fastAscentPeakMpm: 12 },
    });

  it("is not logged when the rebreather fails on it, but the ascent rate moves", () => {
    const loop = createCcrState(air);
    const failing = halfwayUp(
      freezeDiveState({
        ...createInitialDiveState(4, { ccr: { ...loop, scrubberFailed: true, co2BuildupS: seconds(179.5) } }),
      }),
    );
    const model = new DiveModel(failing);
    stepThrough(model, [29.8]);
    expect(model.snapshot.failure.reason).toBe("ccr-co2");
    expect(model.snapshot.log.entries).toEqual([]);
    expect(model.snapshot.log.fastAscentS).toBe(1.5);
    expect(model.snapshot.log.ascentRateMpm).toBeCloseTo(12, 9);
    // What legacy records with the physics moves too: the average depth.
    expect(model.snapshot.log.submergedS).toBe(1);
  });

  it("is logged when an open-circuit failure ends the dive on it", () => {
    // 3% oxygen at 30 m is hypoxic, and the timer is half a second short.
    const hypoxic = createInitialDiveState(5, { tanks: [createTankState(createGasMix(0.03, 0))] });
    const failing = halfwayUp(
      freezeDiveState({ ...hypoxic, failure: { ...hypoxic.failure, hypoxiaS: seconds(9.5) } }),
    );
    const model = new DiveModel(failing);
    stepThrough(model, [29.8]);
    expect(model.snapshot.failure.reason).toBe("hypoxia");
    expect(model.snapshot.log.entries.map((entry) => entry.kind)).toEqual(["fast-ascent"]);
  });
});

describe("the average depth and the profile", () => {
  it("averages the depth by time, and only deeper than 0.5 m", () => {
    // Legacy TC-26-AVG-DEPTH-TIME-WEIGHTED: weighted by dive seconds, so a
    // long step counts for its length, not as one sample.
    const model = new DiveModel(diverAt(20));
    model.advance({ depthM: metres(20) }, seconds(10));
    model.advance({ depthM: metres(0.4) }, seconds(5));
    model.advance({ depthM: metres(30) }, seconds(10));
    expect(model.snapshot.log.submergedS).toBe(20);
    expect(model.snapshot.log.depthTimeMS).toBeCloseTo(20 * 10 + 30 * 10, 9);
  });

  it("samples every 2 dive seconds, catching up across a long step", () => {
    // Legacy TC-71-PROFILE-SAMPLE-CATCH-UP: after 1 s, a 7 s step crosses
    // four sample times, each logged 2 s apart with the step's depth and the
    // ceiling of the step before it.
    const start = diverAt(18);
    const before = advanceDiveStep(start, { depthM: metres(18) }, seconds(1));
    const after = advanceDiveStep(before, { depthM: metres(20) }, seconds(7));
    const samples = after.log.profile;
    expect(samples.map((sample) => sample.elapsedTimeS)).toEqual([2, 4, 6, 8]);
    expect(samples.every((sample) => sample.depthM === 20)).toBe(true);
    expect(samples.every((sample) => sample.ceilingM === before.log.lastCeilingM)).toBe(true);
    expect(after.log.profileTimerS).toBe(0);
  });

  it("reuses the profile on a step that takes no sample", () => {
    // The profile grows for the whole dive; copying it every frame made a
    // frame's cost grow with the dive's length (#204 pre-review).
    const sampled = advanceDiveStep(diverAt(18), { depthM: metres(18) }, seconds(2));
    expect(sampled.log.profile).toHaveLength(1);
    const next = advanceDiveStep(sampled, { depthM: metres(18) }, seconds(0.05));
    expect(next.log.profile).toBe(sampled.log.profile);
    expect(freezeDiveState(next).log.profile).toBe(next.log.profile);
    expect(Object.isFrozen(next.log.profile[0])).toBe(true);
  });

  it("copies a frozen list whose samples are not frozen (#204 Codex round 1)", () => {
    const base = diverAt(18);
    const sample = { elapsedTimeS: seconds(2), depthM: metres(18), ceilingM: metres(0) };
    const frozenOutside = Object.freeze([sample]);
    const state = freezeDiveState({ ...base, log: { ...base.log, profile: frozenOutside } });
    expect(state.log.profile).not.toBe(frozenOutside);
    expect(Object.isFrozen(state.log.profile[0])).toBe(true);
    sample.depthM = metres(40);
    expect(state.log.profile[0]?.depthM).toBe(18);
  });

  it("records the ceiling of the step before each sample", () => {
    // Loaded tissues, so the ceiling moves from step to step.
    const base = diverAt(20);
    const loaded = freezeDiveState({
      ...base,
      tissues: { nitrogenBar: base.tissues.nitrogenBar.map(() => bars(3)), heliumBar: base.tissues.heliumBar },
    });
    const first = advanceDiveStep(loaded, { depthM: metres(20) }, seconds(1));
    const second = advanceDiveStep(first, { depthM: metres(20) }, seconds(1));
    expect(second.log.profile).toHaveLength(1);
    expect(second.log.profile[0]?.ceilingM).toBe(first.log.lastCeilingM);
    expect(second.log.lastCeilingM).toBe(ceilingDepthM(second.tissues, 0.75));
    expect(second.log.lastCeilingM).not.toBe(first.log.lastCeilingM);
  });
});

describe("the NDL", () => {
  it("records the lowest NDL seen and whether it went below 5 minutes", () => {
    const model = new DiveModel(diverAt(18));
    model.advance({ depthM: metres(18) }, seconds(30 * 60));
    // Legacy's air-18m-30min/bottom-30min: 3 minutes left.
    expect(model.snapshot.log.minNdlMin).toBe(3);
    expect(model.snapshot.log.ndlDroppedBelowFiveMinutes).toBe(true);
  });

  it("stays below 5 once it has been, after the NDL recovers", () => {
    // Legacy's ndlDroppedBelow5 is latched for the dive: it picks the long
    // safety stop even after a shallower depth gives the NDL back.
    const model = new DiveModel(diverAt(30));
    for (let second = 0; second < 30 * 60 && (model.snapshot.log.minNdlMin ?? 999) > 4; second += 1) {
      model.advance({ depthM: metres(30) }, seconds(1));
    }
    expect(model.snapshot.log.minNdlMin).toBe(4);
    model.advance({ depthM: metres(6) }, seconds(5 * 60));
    expect(ndlMinutes(model.snapshot.tissues, 6, air, 0.75)).toBeGreaterThanOrEqual(5);
    expect(model.snapshot.log.ndlDroppedBelowFiveMinutes).toBe(true);
    expect(model.snapshot.log.minNdlMin).toBe(4);
  });

  it("is not tracked at the surface", () => {
    const model = new DiveModel(diverAt(0.4));
    stepThrough(model, [0.4, 0.4]);
    expect(model.snapshot.log.minNdlMin).toBeNull();
    expect(model.snapshot.log.ndlDroppedBelowFiveMinutes).toBe(false);
  });

  it("is evaluated at the dive's GF high", () => {
    const at75 = new DiveModel(diverAt(18));
    const at100 = new DiveModel(diverAt(18), { gradientFactorHighPercent: 100 });
    at75.advance({ depthM: metres(18) }, seconds(20 * 60));
    at100.advance({ depthM: metres(18) }, seconds(20 * 60));
    expect(at100.snapshot.log.minNdlMin ?? 0).toBeGreaterThan(at75.snapshot.log.minNdlMin ?? 0);
  });
});
