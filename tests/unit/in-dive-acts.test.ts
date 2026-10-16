import { describe, expect, it } from "vitest";

import { ndlMinutes } from "../../src/core/decompression";
import { DiveModel, advanceDiveStep, decompressionGas, frameNdlMinutes } from "../../src/core/dive-model";
import {
  CCR_SETPOINT_STEP_BAR,
  createCcrState,
  createGasMix,
  createInitialDiveState,
  createTankState,
  freezeDiveState,
  type DiveState,
} from "../../src/core/dive-state";
import { NO_ACTS, NO_INPUT } from "../../src/core/inputs";
import { bars, metres, seconds } from "../../src/core/units";

// The in-dive acts inside a frame (#202). Legacy's updateDiving() reads the
// cylinder keys after updateCNS() and before the gas use, [ and ] after the
// loop update, and B last (src/game-loop.js TASK-019, TASK-032F), so the
// frame a key arrives in loads the tissues and evaluates the ceiling and the
// NDL on the old gas. Each test steps the same state with and without the act.

const GF_HIGH_PERCENT = 85;
const AIR = createGasMix(0.21, 0);
const EAN50 = createGasMix(0.5, 0);
const FRAME_S = seconds(0.3);

function at(depthM: number, state: DiveState): DiveState {
  return freezeDiveState({ ...state, depthM: metres(depthM), maxDepthM: metres(depthM) });
}

function openCircuit(): DiveState {
  return at(21, createInitialDiveState(71, {
    tanks: [createTankState(AIR), createTankState(EAN50), createTankState(createGasMix(0.32, 0))],
  }));
}

function loop(targetPo2Bar: number): DiveState {
  const ccr = createCcrState(AIR, { targetPo2Bar: bars(targetPo2Bar), actualPo2Bar: bars(1.2) });
  return at(30, createInitialDiveState(72, { ccr }));
}

const env = (depthM: number) => ({ depthM: metres(depthM), gradientFactorHighPercent: GF_HIGH_PERCENT });

describe("the in-dive acts inside a frame (#202)", () => {
  it("loads a switch frame's tissues, CNS and limits on the old gas, and bills the new cylinder", () => {
    const start = openCircuit();
    const plain = advanceDiveStep(start, env(21), FRAME_S);
    const switched = advanceDiveStep(start, env(21), FRAME_S, { ...NO_ACTS, switchGasIndices: [1] });

    expect(switched.activeTankIndex).toBe(1);
    expect(switched.tissues).toEqual(plain.tissues);
    expect(switched.cnsPercent).toBe(plain.cnsPercent);
    expect(switched.narcosisIndex).toBe(plain.narcosisIndex);
    expect(switched.log.lastCeilingM).toBe(plain.log.lastCeilingM);
    expect(frameNdlMinutes(switched, GF_HIGH_PERCENT)).toBe(frameNdlMinutes(plain, GF_HIGH_PERCENT));
    // The NDL legacy's frame draws is not the new gas's.
    expect(frameNdlMinutes(switched, GF_HIGH_PERCENT)).not.toBe(
      ndlMinutes(switched.tissues, switched.depthM, EAN50, GF_HIGH_PERCENT / 100),
    );
    // The new cylinder pays for the frame, the old one nothing.
    expect(switched.tanks[0]?.gasRemainingL).toBe(start.tanks[0]?.gasRemainingL);
    expect(switched.tanks[1]?.gasRemainingL).toBe(plain.tanks[0]?.gasRemainingL);
    expect(switched.tanks[1]?.gasRemainingL).toBeLessThan(start.tanks[1]?.gasRemainingL ?? 0);

    // From the next frame on, the new gas.
    const next = advanceDiveStep(switched, env(21), FRAME_S);
    expect(next.tissues).not.toEqual(advanceDiveStep(plain, env(21), FRAME_S).tissues);
    expect(frameNdlMinutes(next, GF_HIGH_PERCENT)).toBe(
      ndlMinutes(next.tissues, next.depthM, EAN50, GF_HIGH_PERCENT / 100),
    );
  });

  it("reads the cylinder keys of one frame in cylinder order, each once", () => {
    // Legacy's loop runs i = 0..tankCount-1 over one flag per key: 3 and 2
    // in one frame switch to 2 and then to 3, whatever the order pressed.
    const switched = advanceDiveStep(openCircuit(), env(21), FRAME_S, {
      ...NO_ACTS,
      switchGasIndices: [2, 1, 2],
    });
    expect(switched.activeTankIndex).toBe(2);
    expect(switched.events.map((event) => event.tankIndex)).toEqual([1, 2]);
  });

  it("moves the setpoint after the frame's loop update, [ before ]", () => {
    const start = loop(1.2);
    const plain = advanceDiveStep(start, env(30), FRAME_S);
    const raised = advanceDiveStep(start, env(30), FRAME_S, {
      ...NO_ACTS,
      setpointStepsBar: [CCR_SETPOINT_STEP_BAR],
    });
    expect(raised.ccr?.targetPo2Bar).toBe(1.3);
    // The loop climbed toward the old setpoint in this frame.
    expect(raised.ccr?.actualPo2Bar).toBe(plain.ccr?.actualPo2Bar);
    expect(raised.ccr?.oxygenCylinderPressureBar).toBe(plain.ccr?.oxygenCylinderPressureBar);
    expect(raised.tissues).toEqual(plain.tissues);
    expect(frameNdlMinutes(raised, GF_HIGH_PERCENT)).toBe(frameNdlMinutes(plain, GF_HIGH_PERCENT));

    // At the upper bound, [ then ] lowers and raises back.
    const both = advanceDiveStep(loop(1.6), env(30), FRAME_S, {
      ...NO_ACTS,
      setpointStepsBar: [-CCR_SETPOINT_STEP_BAR, CCR_SETPOINT_STEP_BAR],
    });
    expect(both.ccr?.targetPo2Bar).toBe(1.6);
  });

  it("bails out after the frame's loop update", () => {
    const start = loop(1.2);
    const plain = advanceDiveStep(start, env(30), FRAME_S);
    const bailed = advanceDiveStep(start, env(30), FRAME_S, { ...NO_ACTS, bailout: true });
    expect(bailed.ccr?.onBailout).toBe(true);
    expect(bailed.tissues).toEqual(plain.tissues);
    expect(bailed.ccr?.oxygenCylinderPressureBar).toBe(plain.ccr?.oxygenCylinderPressureBar);
    expect(bailed.ccr?.diluentCylinderPressureBar).toBe(start.ccr?.diluentCylinderPressureBar);
    expect(frameNdlMinutes(bailed, GF_HIGH_PERCENT)).toBe(frameNdlMinutes(plain, GF_HIGH_PERCENT));
  });

  it("applies a zero-length frame's acts and moves nothing", () => {
    // Legacy's updateDiving(0), as the recorded #163 dives read their keys.
    const start = openCircuit();
    const model = new DiveModel(start, { gradientFactorHighPercent: GF_HIGH_PERCENT });
    const switched = model.advance(env(21), seconds(0), { ...NO_INPUT, switchGasIndices: [1] });
    expect(switched.activeTankIndex).toBe(1);
    expect(switched.elapsedTimeS).toBe(start.elapsedTimeS);
    expect(switched.tissues).toEqual(start.tissues);
    expect(switched.tanks).toEqual(start.tanks);
    // Its frameCalc was refreshed before the key, on the old gas.
    expect(frameNdlMinutes(switched, GF_HIGH_PERCENT)).toBe(
      ndlMinutes(start.tissues, start.depthM, AIR, GF_HIGH_PERCENT / 100),
    );
    // Without an act, a zero-length frame is no frame.
    expect(model.advance(env(21), seconds(0))).toBe(switched);
  });

  it("refreshes the NDL in every zero-length frame, before its act, refused or not", () => {
    // Codex round 1 on #253. Each updateDiving(0) refreshes frameCalc on the
    // gas breathed when the frame starts, then reads the key. The second of
    // two such frames must not carry the first one's NDL.
    const ndlOn = (state: DiveState, gas: typeof AIR) =>
      ndlMinutes(state.tissues, state.depthM, gas, GF_HIGH_PERCENT / 100);
    const EAN32 = createGasMix(0.32, 0);
    const start = openCircuit();
    expect(ndlOn(start, EAN32)).not.toBe(ndlOn(start, AIR));

    const model = new DiveModel(start, { gradientFactorHighPercent: GF_HIGH_PERCENT });
    expect(frameNdlMinutes(model.switchGas(2), GF_HIGH_PERCENT)).toBe(ndlOn(start, AIR));
    // Air → EAN32, then EAN32 → EAN50: the second frame started on EAN32.
    const second = model.switchGas(1);
    expect(second.activeTankIndex).toBe(1);
    expect(frameNdlMinutes(second, GF_HIGH_PERCENT)).toBe(ndlOn(start, EAN32));

    // A refused key: the frame still refreshes, on the gas it started on.
    const onEan32 = new DiveModel(start, { gradientFactorHighPercent: GF_HIGH_PERCENT });
    onEan32.switchGas(2);
    const refused = onEan32.switchGas(2);
    expect(refused.activeTankIndex).toBe(2);
    expect(frameNdlMinutes(refused, GF_HIGH_PERCENT)).toBe(ndlOn(start, EAN32));

    // Two setpoint steps: the second frame started on the loop at 1.3 bar.
    const ccr = new DiveModel(loop(1.2), { gradientFactorHighPercent: GF_HIGH_PERCENT });
    const at13 = ccr.adjustSetpoint(CCR_SETPOINT_STEP_BAR);
    const loopAt13 = decompressionGas(at13);
    const at14 = ccr.adjustSetpoint(CCR_SETPOINT_STEP_BAR);
    expect(at14.ccr?.targetPo2Bar).toBe(1.4);
    expect(ndlOn(at14, loopAt13)).not.toBe(ndlOn(at14, decompressionGas(loop(1.2))));
    expect(frameNdlMinutes(at14, GF_HIGH_PERCENT)).toBe(ndlOn(at14, loopAt13));
  });
});
