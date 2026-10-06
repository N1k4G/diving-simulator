import { describe, expect, it } from "vitest";

import {
  DiveModel,
  advanceDiveStep,
  isDiveOver,
  openCircuit,
} from "../../src/core/dive-model";
import { decoStopDepth } from "../../src/core/decompression";
import {
  createCcrState,
  createGasMix,
  createInitialDiveState,
  createTankState,
  type DiveState,
} from "../../src/core/dive-state";
import { bars, metres, seconds } from "../../src/core/units";

// The end of a dive at the surface (#199), legacy's last check in
// updateDiving(): shallower than 0.3 m after more than half a dive minute,
// the ceiling cleared to 0.1 m, the dive deeper than 2 m. A safety stop that
// was needed and not done is logged as skipped as the dive ends.

const AIR = createGasMix(0.21, 0);

function step(state: DiveState, depthM: number, elapsedS = 1): DiveState {
  return advanceDiveStep(state, { depthM: metres(depthM), gradientFactorHighPercent: 75 }, seconds(elapsedS));
}

function hold(state: DiveState, depthM: number, secondsHeld: number): DiveState {
  let next = state;
  for (let second = 0; second < secondsHeld; second++) next = step(next, depthM);
  return next;
}

/** Ten minutes at 12 m on air: no ceiling, the safety stop needed. Frozen, so built once. */
let twelveMetresState: DiveState | undefined;
function twelveMetres(): DiveState {
  twelveMetresState ??= hold(createInitialDiveState(41, { tanks: [createTankState(AIR)] }), 12, 600);
  return twelveMetresState;
}

describe("the end of a dive at the surface", () => {
  it("starts every dive not completed", () => {
    expect(createInitialDiveState(1).completed).toBe(false);
  });

  it("ends a dive that surfaces without its safety stop, and logs the stop skipped", () => {
    const bottom = twelveMetres();
    expect(bottom.safetyStop.needed).toBe(true);
    expect(bottom.log.lastCeilingM).toBe(0);
    const surfaced = step(bottom, 0);
    expect(surfaced.completed).toBe(true);
    expect(isDiveOver(surfaced)).toBe(true);
    expect(surfaced.failure.reason).toBeNull();
    expect(surfaced.log.entries.at(-1)).toEqual({
      kind: "safety-stop-skipped",
      elapsedTimeS: surfaced.elapsedTimeS,
      value: 0,
    });
  });

  it("ends a dive that did its safety stop without logging one", () => {
    const stopped = hold(step(twelveMetres(), 5), 5, 180);
    expect(stopped.safetyStop.complete).toBe(true);
    const surfaced = step(stopped, 0);
    expect(surfaced.completed).toBe(true);
    expect(surfaced.log.entries.some((entry) => entry.kind === "safety-stop-skipped")).toBe(false);
  });

  it("logs nothing for a dive that never needed a stop", () => {
    const shallow = hold(createInitialDiveState(43), 9, 300);
    expect(shallow.safetyStop.needed).toBe(false);
    const surfaced = step(shallow, 0);
    expect(surfaced.completed).toBe(true);
    expect(surfaced.log.entries).toHaveLength(0);
  });

  it("needs the surface itself: 0.3 m is not shallower than 0.3 m", () => {
    const bottom = twelveMetres();
    expect(step(bottom, 0.3).completed).toBe(false);
    expect(step(bottom, 0.29).completed).toBe(true);
  });

  it("does not end a dive no deeper than 2 m, or one of 30 s or less", () => {
    const paddle = step(hold(createInitialDiveState(45), 2, 120), 0);
    expect(paddle.maxDepthM).toBe(2);
    expect(paddle.completed).toBe(false);
    const bounce = step(hold(createInitialDiveState(47), 5, 29), 0);
    expect(bounce.elapsedTimeS).toBe(30);
    expect(bounce.completed).toBe(false);
    expect(step(bounce, 0).completed).toBe(true);
  });

  it("does not end a dive with a ceiling deeper than 0.1 m", () => {
    // Trimix bottom, then stop by stop until the ceiling is 3 m or less:
    // surfacing then is neither decompression sickness nor the end.
    let state = hold(
      createInitialDiveState(49, { tanks: [createTankState(createGasMix(0.21, 0.35), 24, 200)] }),
      45,
      20 * 60,
    );
    while (state.log.lastCeilingM > 3 && state.failure.reason === null) {
      state = step(state, decoStopDepth(state.log.lastCeilingM));
    }
    const surfaced = step(state, 0);
    expect(surfaced.log.lastCeilingM).toBeGreaterThan(0.1);
    expect(surfaced.failure.reason).toBeNull();
    expect(surfaced.completed).toBe(false);
  });

  it("lets a failure on the same step win: surfacing with a deep ceiling is decompression sickness", () => {
    const deep = hold(
      createInitialDiveState(51, { tanks: [createTankState(createGasMix(0.21, 0.35), 24, 200)] }),
      45,
      20 * 60,
    );
    const surfaced = step(deep, 0);
    expect(surfaced.failure.reason).toBe("decompression-sickness");
    expect(surfaced.completed).toBe(false);
  });

  it("lets a failure win on a step that would otherwise end the dive: hypoxia on the way out", () => {
    // Legacy's hypoxia check returns before the completion check.
    const bottom = twelveMetres();
    const nearlyHypoxic = { ...bottom, failure: { ...bottom.failure, hypoxiaS: seconds(9.5) } };
    const surfaced = advanceDiveStep(
      nearlyHypoxic,
      { depthM: metres(0), breathing: openCircuit(createGasMix(0.05, 0)), gradientFactorHighPercent: 75 },
      seconds(1),
    );
    expect(surfaced.failure.reason).toBe("hypoxia");
    expect(surfaced.completed).toBe(false);
    expect(surfaced.log.entries.some((entry) => entry.kind === "safety-stop-skipped")).toBe(false);
  });

  it("moves no further once completed, whatever is asked of it", () => {
    const model = new DiveModel(step(twelveMetres(), 0));
    const done = model.snapshot;
    expect(done.completed).toBe(true);
    expect(model.advance({ depthM: metres(10) }, seconds(60))).toBe(done);
    expect(model.advanceWithBuoyancy({ ceilingM: 0, floorM: 300 }, seconds(0.3), { inflate: false, vent: true })).toBe(done);
    expect(model.switchGas(0)).toBe(done);

    const loop = new DiveModel(createInitialDiveState(53, {
      ccr: createCcrState(AIR, { targetPo2Bar: bars(1.2) }),
    }));
    loop.advance({ depthM: metres(12) }, seconds(60));
    loop.advance({ depthM: metres(0) }, seconds(1));
    const surfacedLoop = loop.snapshot;
    expect(surfacedLoop.completed).toBe(true);
    expect(loop.adjustSetpoint(0.1)).toBe(surfacedLoop);
    expect(loop.bailOut()).toBe(surfacedLoop);
  });
});
