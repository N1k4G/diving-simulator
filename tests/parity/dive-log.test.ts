import { describe, expect, it } from "vitest";

import baselineFixture from "../fixtures/traces/baseline-v1.json";
import {
  diveStateFromLegacyCheckpoint,
  logEntriesFromLegacyEvents,
  type LegacyProfileSample,
  type LegacyTissueCheckpoint,
} from "../../src/app/legacy-dive-adapter";
import { MAX_DEPTH_M, type BuoyancyControls } from "../../src/core/buoyancy";
import { DiveModel, advanceDiveStep, closedCircuit, openCircuit } from "../../src/core/dive-model";
import { createGasMix, type BreathingSource } from "../../src/core/dive-state";
import { metres, seconds } from "../../src/core/units";

// The dive log (#199) against the legacy client.
//
// Fast ascents: only the buoyancy scenarios can prove them. There nothing
// sets the depth, so legacy's ascentRate is the depth change the physics
// made, as the model's is. The scripted scenarios set the depth before every
// tick, so legacy measured their ascents against the target (about 8.8
// m/min on the "12 m/min" air ascent) and a replay of the trajectory would
// log fast ascents legacy never saw; those checkpoints are compared for the
// NDL latch only.

interface Checkpoint extends LegacyTissueCheckpoint {
  checkpointId: string;
  state: LegacyTissueCheckpoint["state"] & {
    ndlDroppedBelow5: boolean;
    safetyStop: {
      needed: boolean;
      remaining_min: number;
      countdownStarted: boolean;
      paused: boolean;
      complete: boolean;
    };
    debrief: {
      ascentRate_mpm: number;
      minNdlSeen_min: number | null;
      fastAscentAccum_s: number | null;
      fastAscentPeak_mpm: number;
      ceilingViolationAccum_s: number | null;
      avgDepthAccum_ms: number;
      avgDepthSamples_s: number;
      profileTimer_s: number;
      frameCeiling_m: number;
    };
  };
  profile: LegacyProfileSample[];
  events: { t: number; kind: string; value: number }[];
  trajectory: { depth_m: number; dtDive_min: number }[];
}

const eps = baselineFixture.tolerances.absoluteEpsilon;
const OPEN_WATER = { ceilingM: 0, floorM: MAX_DEPTH_M };

function checkpoints(scenarioId: string): Checkpoint[] {
  const scenario = (baselineFixture.scenarios as unknown as { scenarioId: string; checkpoints: Checkpoint[] }[])
    .find((entry) => entry.scenarioId === scenarioId);
  if (!scenario) throw new Error(`Missing golden scenario: ${scenarioId}`);
  return scenario.checkpoints;
}

function checkpoint(scenarioId: string, id: string): Checkpoint {
  const found = checkpoints(scenarioId).find((entry) => entry.checkpointId === id);
  if (!found) throw new Error(`Missing golden checkpoint: ${scenarioId}/${id}`);
  return found;
}

/** The model's log against legacy's diveEvents and ndlDroppedBelow5. */
function expectLogToMatch(model: DiveModel, recorded: Checkpoint): void {
  const where = recorded.checkpointId;
  const expected = logEntriesFromLegacyEvents(recorded.events);
  const actual = model.snapshot.log.entries;
  expect(actual.map((entry) => entry.kind), `entry kinds at ${where}`).toEqual(expected.map((entry) => entry.kind));
  actual.forEach((entry, index) => {
    const legacy = expected[index];
    expect(Math.abs(entry.elapsedTimeS / 60 - (legacy?.elapsedTimeS ?? Number.NaN) / 60), `entry ${index} time at ${where}`)
      .toBeLessThanOrEqual(eps.default);
    expect(Math.abs(entry.value - (legacy?.value ?? Number.NaN)), `entry ${index} value at ${where}`)
      .toBeLessThanOrEqual(eps.default);
  });
  expect(model.snapshot.log.ndlDroppedBelowFiveMinutes, `ndlDroppedBelow5 at ${where}`).toBe(recorded.state.ndlDroppedBelow5);
  expectContinuationToMatch(model, recorded);
}

/**
 * The adaptive safety stop against legacy's state.safetyStop (#199), whose
 * remaining_min is in seconds despite its name.
 */
function expectSafetyStopToMatch(model: DiveModel, recorded: Checkpoint): void {
  const where = recorded.checkpointId;
  const stop = model.snapshot.safetyStop;
  const legacy = recorded.state.safetyStop;
  expect(
    { needed: stop.needed, countdownStarted: stop.countdownStarted, paused: stop.paused, complete: stop.complete },
    `safety stop at ${where}`,
  ).toEqual({ needed: legacy.needed, countdownStarted: legacy.countdownStarted, paused: legacy.paused, complete: legacy.complete });
  expect(Math.abs(stop.remainingS - legacy.remaining_min), `safety stop remaining at ${where}`)
    .toBeLessThanOrEqual(eps["state.safetyStop.remaining_min"]);
}

/**
 * The start of the dive and gas used (#199), against legacy's totalGas and
 * the rebreather's start values: drawPostDive() shows gas used as these less
 * the current contents.
 */
function expectStartGasToMatch(model: DiveModel, recorded: Checkpoint): void {
  const where = recorded.checkpointId;
  const state = model.snapshot;
  // On a rebreather, cylinder 0 is the setup placeholder legacy draws the
  // BCD from, the recorded #192 departure its own test covers.
  const tanks = state.ccr ? [] : (recorded.tanks ?? []);
  tanks.forEach((legacy, index) => {
    const tank = state.tanks[index];
    expect(tank?.startGasL, `cylinder ${index} fill at ${where}`).toBe(legacy.totalGas_l ?? Number.NaN);
    expect(
      Math.abs((tank?.startGasL ?? 0) - (tank?.gasRemainingL ?? 0) - ((legacy.totalGas_l ?? 0) - legacy.gasRemaining_l)),
      `cylinder ${index} gas used at ${where}`,
    ).toBeLessThanOrEqual(eps["tanks.*.gasRemaining_l"]);
  });
  const legacyCcr = recorded.ccr;
  if (state.ccr && legacyCcr) {
    expect(state.ccr.oxygenCylinderStartPressureBar, `O2 start at ${where}`).toBe(legacyCcr.o2PressureStart_bar ?? Number.NaN);
    expect(state.ccr.diluentCylinderStartPressureBar, `diluent start at ${where}`).toBe(legacyCcr.diluentPressureStart_bar ?? Number.NaN);
    expect(state.ccr.scrubberTotalS, `scrubber total at ${where}`).toBe((legacyCcr.scrubberTotal_min ?? Number.NaN) * 60);
  }
}

/** Legacy's profile up to and including a checkpoint. */
function profileUpTo(scenarioId: string, id: string): LegacyProfileSample[] {
  const all = checkpoints(scenarioId);
  const last = all.findIndex((entry) => entry.checkpointId === id);
  return all.slice(0, last + 1).flatMap((entry) => entry.profile);
}

/**
 * The average depth's sums, the profile sampler and its samples, against
 * legacy's (#199 slice 2b): what legacy records with the physics, on every
 * scenario, scripted or not.
 */
function expectMotionToMatch(model: DiveModel, scenarioId: string, recorded: Checkpoint): void {
  const where = recorded.checkpointId;
  const log = model.snapshot.log;
  const legacy = recorded.state.debrief;
  expect(Math.abs(log.depthTimeMS - legacy.avgDepthAccum_ms), `depth-time sum at ${where}`).toBeLessThanOrEqual(eps.default);
  expect(Math.abs(log.submergedS - legacy.avgDepthSamples_s), `submerged time at ${where}`).toBeLessThanOrEqual(eps.default);
  expect(Math.abs(log.profileTimerS - legacy.profileTimer_s), `profile timer at ${where}`).toBeLessThanOrEqual(eps.default);
  expect(Math.abs(log.lastCeilingM - legacy.frameCeiling_m), `last ceiling at ${where}`).toBeLessThanOrEqual(eps["planner.ceiling_m"]);
  const expected = profileUpTo(scenarioId, where);
  expect(log.profile.length, `profile samples at ${where}`).toBe(expected.length);
  log.profile.forEach((sample, index) => {
    const legacySample = expected[index]!;
    expect(Math.abs(sample.elapsedTimeS / 60 - legacySample.t_min), `sample ${index} time at ${where}`).toBeLessThanOrEqual(eps.default);
    expect(Math.abs(sample.depthM - legacySample.depth_m), `sample ${index} depth at ${where}`).toBeLessThanOrEqual(eps.default);
    expect(Math.abs(sample.ceilingM - legacySample.ceiling_m), `sample ${index} ceiling at ${where}`).toBeLessThanOrEqual(eps["planner.ceiling_m"]);
  });
}

/**
 * What the next step continues from, against legacy's state.debrief (#201
 * Codex round 1): the ascent rate, the lowest NDL, and each window's length,
 * latch and peak. A fired window is null in the fixture (legacy's -Infinity)
 * and latched in the log, where its length no longer counts.
 */
function expectContinuationToMatch(model: DiveModel, recorded: Checkpoint): void {
  const where = recorded.checkpointId;
  const log = model.snapshot.log;
  const legacy = recorded.state.debrief;
  expect(Math.abs(log.ascentRateMpm - legacy.ascentRate_mpm), `ascent rate at ${where}`).toBeLessThanOrEqual(eps.default);
  expect(log.minNdlMin, `lowest NDL at ${where}`).toBe(legacy.minNdlSeen_min);
  expect(log.fastAscentLatched, `fast-ascent latch at ${where}`).toBe(legacy.fastAscentAccum_s === null);
  if (legacy.fastAscentAccum_s !== null) {
    expect(Math.abs(log.fastAscentS - legacy.fastAscentAccum_s), `fast-ascent window at ${where}`).toBeLessThanOrEqual(eps.default);
  }
  expect(Math.abs(log.fastAscentPeakMpm - legacy.fastAscentPeak_mpm), `fast-ascent peak at ${where}`).toBeLessThanOrEqual(eps.default);
  expect(log.ceilingViolationLatched, `ceiling latch at ${where}`).toBe(legacy.ceilingViolationAccum_s === null);
  if (legacy.ceilingViolationAccum_s !== null) {
    expect(Math.abs(log.ceilingViolationS - legacy.ceilingViolationAccum_s), `ceiling window at ${where}`).toBeLessThanOrEqual(eps.default);
  }
}

function replayBuoyancy(
  scenarioId: string,
  segments: readonly { checkpointId: string; controls: BuoyancyControls }[],
): number {
  const model = new DiveModel(diveStateFromLegacyCheckpoint(checkpoints(scenarioId)[0]!, 501));
  let logged = 0;
  for (const segment of segments) {
    const recorded = checkpoint(scenarioId, segment.checkpointId);
    for (const frame of recorded.trajectory) {
      model.advanceWithBuoyancy(OPEN_WATER, seconds(frame.dtDive_min * 60), segment.controls);
    }
    expectLogToMatch(model, recorded);
    expectMotionToMatch(model, scenarioId, recorded);
    expectSafetyStopToMatch(model, recorded);
    expectStartGasToMatch(model, recorded);
    logged = model.snapshot.log.entries.length;
  }
  return logged;
}

const VENT = { inflate: false, vent: true };
const INFLATE = { inflate: true, vent: false };
const NONE = { inflate: false, vent: false };

describe("the dive log against the recorded legacy dives", () => {
  it("logs the fast ascent of the buoyancy dive where legacy did, with its peak", () => {
    const logged = replayBuoyancy("buoyancy-vent-inflate-12m", [
      { checkpointId: "vented-4s", controls: VENT },
      { checkpointId: "sinking-20s", controls: NONE },
      { checkpointId: "inflated-11s", controls: INFLATE },
      { checkpointId: "coasting-30s", controls: NONE },
      { checkpointId: "vented-3s-10fps", controls: VENT },
    ]);
    // The recording holds one: the coast up past 9 m/min.
    expect(logged).toBe(1);
  });

  it("logs the fast ascent of the rebreather dive where legacy did", () => {
    const logged = replayBuoyancy("buoyancy-ccr-inflate-12m", [
      { checkpointId: "inflated-2s", controls: INFLATE },
      { checkpointId: "rising-8s", controls: NONE },
    ]);
    expect(logged).toBe(1);
  });

  // The breathed gas is given, as tests/parity/tissue-model.test.ts gives it
  // for the same bottoms: the scripted scenarios hold the loop at its
  // setpoint, where the model's own loop, dropped from the surface to 30 m in
  // one step, would settle elsewhere and load different tissues.
  it("continues a latched fast ascent from a mid-dive checkpoint without logging it again", () => {
    // coasting-30s already holds legacy's entry and a fired window, and the
    // 10 fps vent that follows stays above 9 m/min throughout. Started from
    // that checkpoint, the log must know the window has fired.
    const start = checkpoint("buoyancy-vent-inflate-12m", "coasting-30s");
    expect(start.state.debrief.fastAscentAccum_s).toBeNull();
    const model = new DiveModel(diveStateFromLegacyCheckpoint(start, 501));
    const next = checkpoint("buoyancy-vent-inflate-12m", "vented-3s-10fps");
    for (const frame of next.trajectory) {
      model.advanceWithBuoyancy(OPEN_WATER, seconds(frame.dtDive_min * 60), VENT);
    }
    expectLogToMatch(model, next);
    expect(model.snapshot.log.entries).toHaveLength(1);
  });

  // The scripted scenarios are replayed tick by tick through advanceDiveStep,
  // one step per legacy tick at the depth it read back, so each tick's
  // profile samples carry the ceiling from before it, as legacy's do. Their
  // entries are not compared (see the note above); their motion is.
  // Air breathes its own cylinder, so the model's life support runs and its
  // gas used is compared too. The rebreather is held at its setpoint, as the
  // tissue replays hold it; given a breathing source, the model draws no gas.
  it.each<[string, BreathingSource | undefined]>([
    ["air-18m-30min", undefined],
    ["ccr-30m-30min", closedCircuit(1.3, createGasMix(0.15, 0.45))],
  ])("samples the %s profile and averages its depth as legacy does", (scenarioId, breathing) => {
    const all = checkpoints(scenarioId);
    let state = diveStateFromLegacyCheckpoint(all[0]!, 17);
    for (const recorded of all.slice(1)) {
      for (const tick of recorded.trajectory) {
        if (tick.dtDive_min === 0) continue;
        state = advanceDiveStep(
          state,
          { depthM: metres(tick.depth_m), breathing, gradientFactorHighPercent: 75 },
          seconds(tick.dtDive_min * 60),
        );
      }
      expectMotionToMatch(new DiveModel(state), scenarioId, recorded);
      expectSafetyStopToMatch(new DiveModel(state), recorded);
      expectStartGasToMatch(new DiveModel(state), recorded);
    }
  });

  it("has a recorded countdown for the air replay above to compare against", () => {
    // The only recorded countdown, which the air replay above matches: 300 s
    // (the NDL fell below 5 at the bottom), 18 s of it ticked in the band on
    // the ascent, then paused at the surface. Guards the comparison against
    // a fixture that no longer holds one.
    const surfaced = checkpoint("air-18m-30min", "surfaced");
    expect(surfaced.state.safetyStop).toMatchObject({ countdownStarted: true, paused: true, remaining_min: 282 });
  });

  it("continues the profile from a mid-dive checkpoint", () => {
    const start = checkpoint("buoyancy-vent-inflate-12m", "inflated-11s");
    const earlier = profileUpTo("buoyancy-vent-inflate-12m", "sinking-20s");
    const model = new DiveModel(diveStateFromLegacyCheckpoint(start, 501, earlier));
    expectMotionToMatch(model, "buoyancy-vent-inflate-12m", start);
    const next = checkpoint("buoyancy-vent-inflate-12m", "coasting-30s");
    for (const frame of next.trajectory) {
      model.advanceWithBuoyancy(OPEN_WATER, seconds(frame.dtDive_min * 60), NONE);
    }
    expectMotionToMatch(model, "buoyancy-vent-inflate-12m", next);
  });

  it("carries the lowest NDL across a checkpoint", () => {
    // Legacy's air bottom has seen 3 minutes; a dive continued from it keeps
    // that minimum while the NDL recovers on the way up.
    const bottom = checkpoint("air-18m-30min", "bottom-30min");
    const model = new DiveModel(diveStateFromLegacyCheckpoint(bottom, 17));
    expect(model.snapshot.log.minNdlMin).toBe(3);
    model.advance({ depthM: metres(9), breathing: openCircuit(createGasMix(0.21, 0)) }, seconds(60));
    expect(model.snapshot.log.minNdlMin).toBe(3);
  });

  it.each<[string, number, BreathingSource]>([
    ["air-18m-30min", 18, openCircuit(createGasMix(0.21, 0))],
    ["trimix-45m-20min", 45, openCircuit(createGasMix(0.21, 0.35))],
    ["ccr-30m-30min", 30, closedCircuit(1.3, createGasMix(0.15, 0.45))],
  ])("latches the NDL below 5 minutes on the %s bottom, and logs nothing there", (scenarioId, depthM, breathing) => {
    const start = checkpoint(scenarioId, "surface");
    const bottom = checkpoints(scenarioId)[1]!;
    const model = new DiveModel(diveStateFromLegacyCheckpoint(start, 17));
    model.advance(
      { depthM: metres(depthM), breathing },
      seconds((bottom.state.diveTime_min - start.state.diveTime_min) * 60),
    );
    expect(bottom.state.ndlDroppedBelow5).toBe(true);
    expectLogToMatch(model, bottom);
  });
});
