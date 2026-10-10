import { describe, expect, it } from "vitest";

import baselineFixture from "../fixtures/traces/baseline-v1.json";
import {
  diveStateFromLegacyCheckpoint,
  type LegacyTissueCheckpoint,
} from "../../src/app/legacy-dive-adapter";
import {
  NARCOSIS_FAILURE_SECONDS,
  NARCOSIS_KO_INDEX,
  advanceDiveStep,
  closedCircuit,
  openCircuit,
} from "../../src/core/dive-model";
import { createGasMix, type BreathingSource, type DiveState } from "../../src/core/dive-state";
import {
  NARCOSIS_INPUT_DROP_INDEX,
  narcosisDriftStep,
  swallowInputs,
} from "../../src/core/narcosis-effects";
import { metres, seconds } from "../../src/core/units";
import * as narcosisView from "../../src/render/narcosis-view";
import pixiRendererSource from "../../src/render/pixi-renderer.ts?raw";
import legacyRendererSource from "../../src/renderer.js?raw";

// Nitrogen narcosis (#189) against the legacy client. narcosis-air-65m holds
// air at 65 m until the narcosis index passes 0.95 and the KO timer counts,
// climbs to 45 m for 10 s, which takes the index back under 0.95 and resets
// the timer, and returns to 65 m until the timer ends the dive. It is
// replayed tick by tick at the depth legacy read back, and the index and the
// timer are compared at every checkpoint; the dive must end on legacy's
// tick and not before. The index is also compared at every checkpoint of the
// other recordings that breathe one gas throughout, from the surface on.
//
// The index is an explicit Euler step per tick, so it depends on the tick
// length: the replays use legacy's own ticks, as recorded.

interface Checkpoint extends LegacyTissueCheckpoint {
  checkpointId: string;
  state: LegacyTissueCheckpoint["state"] & {
    narcosisIndex: number;
    gameState: string;
    gameOverReason: string | null;
    debrief: { narcosisKO_s: number };
  };
  trajectory: { depth_m: number; dtDive_min: number }[];
}

const LEGACY_REASON = "NITROGEN NARCOSIS — UNCONSCIOUSNESS";
const eps = baselineFixture.tolerances.absoluteEpsilon;
const AIR = openCircuit(createGasMix(0.21, 0));
const TRIMIX = openCircuit(createGasMix(0.21, 0.35));
const NITROX_50 = openCircuit(createGasMix(0.5, 0));

function checkpoints(scenarioId: string): Checkpoint[] {
  const scenario = (baselineFixture.scenarios as unknown as { scenarioId: string; checkpoints: Checkpoint[] }[])
    .find((entry) => entry.scenarioId === scenarioId);
  if (!scenario) throw new Error(`Missing golden scenario: ${scenarioId}`);
  return scenario.checkpoints;
}

/**
 * Replays every checkpoint after `startId` (the first when null) tick by tick, breathing
 * `breathingFor(checkpointId)`, and checks the index at each checkpoint
 * with `atCheckpoint` for anything more.
 */
function replay(
  scenarioId: string,
  startId: string | null,
  breathingFor: (checkpointId: string) => BreathingSource,
  atCheckpoint: (state: DiveState, recorded: Checkpoint, ticksLeft: number) => void = () => {},
): DiveState {
  const all = checkpoints(scenarioId);
  const startIndex = startId === null ? 0 : all.findIndex((entry) => entry.checkpointId === startId);
  let state = diveStateFromLegacyCheckpoint(all[startIndex]!, 37);
  expect(state.narcosisIndex).toBe(all[startIndex]!.state.narcosisIndex);
  for (const recorded of all.slice(startIndex + 1)) {
    const where = `${scenarioId}/${recorded.checkpointId}`;
    const breathing = breathingFor(recorded.checkpointId);
    recorded.trajectory.forEach((tick, index) => {
      if (tick.dtDive_min === 0) return;
      atCheckpoint(state, recorded, recorded.trajectory.length - index);
      state = advanceDiveStep(state, { depthM: metres(tick.depth_m), breathing }, seconds(tick.dtDive_min * 60));
    });
    expect(Math.abs(state.narcosisIndex - recorded.state.narcosisIndex), `narcosis index at ${where}`)
      .toBeLessThanOrEqual(eps.default);
    atCheckpoint(state, recorded, 0);
  }
  return state;
}

/** The KO timer and the failure at each narcosis-air-65m checkpoint, and the dive going on before its last tick. */
function checkKo(state: DiveState, recorded: Checkpoint, ticksLeft: number): void {
  const where = `narcosis-air-65m/${recorded.checkpointId}`;
  const failed = recorded.state.gameOverReason !== null;
  if (ticksLeft > 0) {
    expect(state.failure.reason, `${ticksLeft} ticks before ${where}`).toBeNull();
    return;
  }
  expect(Math.abs(state.failure.narcosisKoS - recorded.state.debrief.narcosisKO_s), `KO timer at ${where}`)
    .toBeLessThanOrEqual(eps.default);
  expect(state.failure.reason, `failure at ${where}`).toBe(failed ? "nitrogen-narcosis" : null);
  expect(recorded.state.gameState, `legacy's state at ${where}`).toBe(failed ? "gameover" : "diving");
  if (failed) expect(recorded.state.gameOverReason).toBe(LEGACY_REASON);
}

describe("nitrogen narcosis against the recorded legacy dives", () => {
  it("counts the KO timer past 0.95, resets it below, and ends the dive on legacy's tick", () => {
    const state = replay("narcosis-air-65m", "surface", () => AIR, checkKo);
    const failed = checkpoints("narcosis-air-65m").at(-1)!;
    expect(state.failure.narcosisKoS).toBeGreaterThanOrEqual(NARCOSIS_FAILURE_SECONDS);
    expect(state.events.at(-1)).toMatchObject({ type: "failure", failureReason: "nitrogen-narcosis" });
    // The two clocks sum the same ticks in a different unit (minutes against
    // seconds), so they differ in the last bits only.
    expect(state.events.at(-1)?.elapsedTimeS).toBeCloseTo(failed.state.diveTime_min * 60, 9);
  });

  it("exercises every branch of legacy's timer", () => {
    // Guards the replay against a recording that no longer does.
    const at = (id: string) => checkpoints("narcosis-air-65m").find((entry) => entry.checkpointId === id)!.state;
    expect(at("bottom-4min").narcosisIndex).toBeLessThan(NARCOSIS_KO_INDEX);
    expect(at("ko-counting").narcosisIndex).toBeGreaterThanOrEqual(NARCOSIS_KO_INDEX);
    expect(at("ko-counting").debrief.narcosisKO_s).toBeGreaterThan(0);
    expect(at("ascended-45m").narcosisIndex).toBeLessThan(at("ko-counting").narcosisIndex);
    expect(at("ascended-45m").debrief.narcosisKO_s).toBe(0);
    expect(at("narcosis").gameOverReason).toBe(LEGACY_REASON);
  });

  it("continues legacy's index and timer from a checkpoint and fails on the same tick", () => {
    const state = replay("narcosis-air-65m", "ko-counting", () => AIR, checkKo);
    expect(state.failure.reason).toBe("nitrogen-narcosis");
  });

  it("reads legacy's game over as a dive narcosis ended, which goes no further", () => {
    const recorded = checkpoints("narcosis-air-65m").at(-1)!;
    const state = diveStateFromLegacyCheckpoint(recorded, 37);
    expect(state.failure.reason).toBe("nitrogen-narcosis");
    expect(state.narcosisIndex).toBe(recorded.state.narcosisIndex);
    expect(state.failure.narcosisKoS).toBe(recorded.state.debrief.narcosisKO_s);
    expect(state.events.at(-1)).toMatchObject({ type: "failure", failureReason: "nitrogen-narcosis" });
    expect(advanceDiveStep(state, { depthM: metres(65) }, seconds(1))).toBe(state);
  });

  it.each([
    ["air-18m-30min", () => AIR],
    ["trimix-dcs-above-stop", () => TRIMIX],
    ["trimix-dcs-surfaced", () => TRIMIX],
    ["wreck-thirds", () => TRIMIX],
    ["buoyancy-vent-inflate-12m", () => AIR],
    ["barotrauma-runaway-ascent-30m", () => AIR],
    // The cylinder switch is a key read in a zero-length tick; the three
    // minutes after it are on the 50 %.
    ["tec-switch-21m", (id: string) => (id === "deco-gas-3min" ? NITROX_50 : TRIMIX)],
    // The loop held at its 1.3 bar setpoint on Tx 15/45, as the tissue
    // parity replays it.
    ["ccr-30m-30min", () => closedCircuit(1.3, createGasMix(0.15, 0.45))],
  ] as [string, (id: string) => BreathingSource][])("matches legacy's index at every checkpoint of %s", (scenarioId, breathingFor) => {
    replay(scenarioId, null, breathingFor);
  });
});

// Narcosis below the KO (#220). Legacy draws its swallowed inputs and its
// drift from Math.random, which the recordings stub at 0.5 for every draw
// outside the shark's scripted ticks (scripts/baseline-scenarios.cjs). A
// 0.5 drift draw adds (0.5 - 0.5) * ..., nothing, so legacy's drift stayed at
// rest through every recording, and its swallowed inputs drop a key only
// above index 0.3 on a tick that holds one. So no recorded checkpoint is
// affected by either, which this asserts with the model's own steps on
// legacy's draws. Legacy's blur and grayscale, which the owner decided not
// to port (2026-10-07), are canvas filters drawScene() sets from the index:
// render-only, so no model value departs, and the index they read matches
// legacy at every checkpoint above.
describe("narcosis below the KO against the recorded legacy dives", () => {
  const LEGACY_DRAW = () => 0.5;
  const scenarios = baselineFixture.scenarios as unknown as { scenarioId: string; checkpoints: Checkpoint[] }[];

  it("leaves legacy's drift at rest through narcosis-air-65m, deep past 0.45", () => {
    const recorded = checkpoints("narcosis-air-65m");
    expect(Math.max(...recorded.map((entry) => entry.state.narcosisIndex))).toBeGreaterThan(0.9);
    let drift = 0;
    let state = diveStateFromLegacyCheckpoint(recorded[0]!, 37);
    let drawn = 0;
    for (const checkpoint of recorded.slice(1)) {
      for (const tick of checkpoint.trajectory) {
        if (tick.dtDive_min === 0) continue;
        const step = narcosisDriftStep(drift, 7, state.narcosisIndex, tick.depth_m, tick.dtDive_min * 20, () => {
          drawn += 1;
          return LEGACY_DRAW();
        });
        drift = step.drift;
        expect(step.verticalVelocityMpm).toBe(7);
        state = advanceDiveStep(state, { depthM: metres(tick.depth_m), breathing: AIR }, seconds(tick.dtDive_min * 60));
      }
    }
    expect(drawn).toBeGreaterThan(100);
    expect(drift).toBe(0);
  });

  it("swallows no key in any recording that holds one: those stay at index 0.3 or below", () => {
    // physicsTick() is the only recorded tick with keys held; the scenarios
    // that use it are the ones that let the physics move the diver.
    const withKeys = scenarios.filter((scenario) =>
      scenario.scenarioId.startsWith("buoyancy-") || scenario.scenarioId.startsWith("barotrauma-"));
    expect(withKeys.length).toBeGreaterThan(0);
    // Legacy's `narcosisIndex > 0.3 ? ... : 0`, written out.
    const legacyDropIndex = 0.3;
    for (const scenario of withKeys) {
      for (const checkpoint of scenario.checkpoints) {
        expect(checkpoint.state.narcosisIndex, `${scenario.scenarioId}/${checkpoint.checkpointId}`)
          .toBeLessThanOrEqual(legacyDropIndex);
      }
    }
    // Up to legacy's 0.3 no draw, not even the lowest, swallows a key.
    const held = { inflate: true, vent: true, left: true, right: true };
    expect(NARCOSIS_INPUT_DROP_INDEX).toBe(legacyDropIndex);
    expect(swallowInputs(held, legacyDropIndex, 1 / 60, () => 0)).toEqual(held);
    expect(swallowInputs(held, legacyDropIndex, 1 / 60, LEGACY_DRAW)).toEqual(held);
  });

  // The departure recorded in docs/decisions.md (#220, 2026-10-10): legacy
  // draws for every held key, also at a drop chance of 0, where the draw
  // keeps the key; the model draws only where a key can be swallowed. It
  // departs in the number of draws and nothing else. No recorded checkpoint
  // holds a random state: buoyancy-vent-inflate-12m, buoyancy-ccr-inflate-12m
  // and barotrauma-runaway-ascent-30m, the recordings that hold keys, stub
  // Math.random, and their kept keys match legacy at every checkpoint.
  it("departs from legacy only in the draws it makes at a drop chance of 0", () => {
    // src/game-loop.js 389-397, written out: `(keys[k]) && Math.random() >
    // narcDropP`, W, S, A, D.
    const legacyKeys = (held: Record<"inflate" | "vent" | "left" | "right", boolean>, index: number, dtReal: number, random: () => number) => {
      const narcDelay = index > 0.3 ? (index - 0.3) / 0.7 : 0;
      const narcDropP = 1 - Math.pow(1 - narcDelay * 0.6, dtReal * 60);
      const keep = (pressed: boolean) => pressed && random() > narcDropP;
      const inflate = keep(held.inflate);
      const vent = keep(held.vent);
      const left = keep(held.left);
      const right = keep(held.right);
      return { inflate, vent, left, right };
    };
    const counting = (values: number[]) => {
      let i = 0;
      return { draw: () => values[i++ % values.length]!, drawn: () => i };
    };
    const held = { inflate: true, vent: false, left: true, right: true };
    const ids = ["buoyancy-vent-inflate-12m", "buoyancy-ccr-inflate-12m", "barotrauma-runaway-ascent-30m"];
    const named = scenarios.filter((scenario) => ids.includes(scenario.scenarioId));
    expect(named.map((scenario) => scenario.scenarioId)).toEqual(ids);
    for (const scenario of named) {
      for (const checkpoint of scenario.checkpoints) {
        const index = checkpoint.state.narcosisIndex;
        for (const values of [[0.5], [Number.MIN_VALUE], [0.9, 0.01, 0.3]]) {
          const legacy = counting(values);
          const model = counting(values);
          const label = `${scenario.scenarioId}/${checkpoint.checkpointId}`;
          expect(swallowInputs(held, index, 1 / 60, model.draw), label)
            .toEqual(legacyKeys(held, index, 1 / 60, legacy.draw));
          // The departing value: legacy draws once per held key, the model
          // not at all.
          expect(legacy.drawn(), label).toBe(3);
          expect(model.drawn(), label).toBe(0);
        }
      }
    }
    // Where a key can be swallowed the two draw alike, key for key.
    for (const index of [0.31, 0.6, 0.95]) {
      for (const dtReal of [1 / 144, 1 / 60, 0.05]) {
        const values = [0.2, 0.7, 0.45, 0.99];
        const legacy = counting(values);
        const model = counting(values);
        expect(swallowInputs(held, index, dtReal, model.draw)).toEqual(legacyKeys(held, index, dtReal, legacy.draw));
        expect(model.drawn()).toBe(legacy.drawn());
      }
    }
  });
});

// Narcosis on the view (#220) against legacy's drawScene (src/renderer.js,
// WP-020). Legacy grays the scene above index 0.4 and blurs it above 0.5
// with ctx.filter; the migration draws neither, a deliberate departure
// (docs/decisions.md, "Deliberate departures from the legacy client"). The
// recorded checkpoints that reach it are named here, with the filter legacy
// sets there written out from its formulas; what else the view does with the
// index, the vignette and the wobble, is compared with legacy there.
describe("narcosis on the view against the recorded legacy dives", () => {
  /** Legacy's ctx.filter at each named checkpoint's recorded index. */
  const DEPARTING: Record<string, string> = {
    "bottom-4min": "grayscale(71%) blur(2.6px)",
    "ko-counting": "grayscale(74%) blur(2.7px)",
    "ascended-45m": "grayscale(65%) blur(2.3px)",
    "back-60s": "grayscale(72%) blur(2.6px)",
    narcosis: "grayscale(74%) blur(2.8px)",
  };
  /** src/renderer.js 773-783, written out. */
  const legacyFilter = (index: number): string => {
    let filter = "";
    if (index > 0.4) filter += `grayscale(${Math.min(80, (index - 0.4) * 133).toFixed(0)}%) `;
    if (index > 0.5) filter += `blur(${Math.min(3, (index - 0.5) * 6).toFixed(1)}px) `;
    return filter.trim();
  };
  const scenarios = baselineFixture.scenarios as unknown as { scenarioId: string; checkpoints: Checkpoint[] }[];
  const indexAt = (id: string) =>
    checkpoints("narcosis-air-65m").find((entry) => entry.checkpointId === id)!.state.narcosisIndex;

  it("writes out legacy's filter as drawScene sets it", () => {
    for (const line of [
      "if (narcosisIndex > 0.40) {",
      "var grayAmt = Math.min(80, (narcosisIndex - 0.40) * 133);",
      "narcFilter += 'grayscale(' + grayAmt.toFixed(0) + '%) ';",
      "if (narcosisIndex > 0.50) {",
      "var blurAmt = Math.min(3, (narcosisIndex - 0.50) * 6);",
      "narcFilter += 'blur(' + blurAmt.toFixed(1) + 'px) ';",
    ]) {
      expect(legacyRendererSource).toContain(line);
    }
  });

  it("departs at the named checkpoints of narcosis-air-65m: legacy grays and blurs, the migration does neither", () => {
    for (const [id, filter] of Object.entries(DEPARTING)) {
      expect(legacyFilter(indexAt(id)), id).toBe(filter);
    }
    // The migration's view of narcosis is the vignette and the wobble only,
    // and its renderer sets no filter anywhere.
    const functions = Object.entries(narcosisView)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name)
      .sort();
    expect(functions).toEqual(["narcosisVignetteAlpha", "narcosisWobblePx"]);
    expect(pixiRendererSource).not.toMatch(/\.filters\b|filters:|Filter\b/);
  });

  it("matches legacy's vignette and wobble at those checkpoints", () => {
    for (const id of Object.keys(DEPARTING)) {
      const index = indexAt(id);
      // Legacy's outer colour stop, before its toFixed(2).
      expect(Math.abs(narcosisView.narcosisVignetteAlpha(index) - Math.min(0.7, (index - 0.15) * 0.82)), id)
        .toBeLessThanOrEqual(eps.default);
      // Legacy's str = (index - 0.25) * 8 px: sin(t * 0.002) peaks at
      // t = 250 pi ms, and cos(t * 0.0015) is 1 at 0.
      const strength = (index - 0.25) * 8;
      expect(narcosisView.narcosisWobblePx(index, (250 * Math.PI) / 1000).x, id).toBeCloseTo(strength, 9);
      expect(narcosisView.narcosisWobblePx(index, 0).y, id).toBeCloseTo(strength * 0.5, 9);
    }
  });

  it("names every recorded checkpoint that reaches legacy's filters: all others stay at index 0.4 or below", () => {
    let others = 0;
    for (const scenario of scenarios) {
      for (const checkpoint of scenario.checkpoints) {
        if (scenario.scenarioId === "narcosis-air-65m" && checkpoint.checkpointId in DEPARTING) continue;
        others += 1;
        expect(legacyFilter(checkpoint.state.narcosisIndex), `${scenario.scenarioId}/${checkpoint.checkpointId}`).toBe("");
      }
    }
    expect(others).toBeGreaterThan(40);
  });
});
