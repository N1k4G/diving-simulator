import { describe, expect, it } from "vitest";

import baselineFixture from "../fixtures/traces/baseline-v1.json";
import { diveStateFromLegacyCheckpoint } from "../../src/app/legacy-dive-adapter";
import {
  DivePlanner,
  type PlannerSettings,
} from "../../src/planner/dive-planner";

interface GoldenCheckpoint {
  checkpointId: string;
  state: {
    depth_m: number;
    maxDepth_m: number;
    diveTime_min: number;
    diveMode: string;
    activeTankIndex: number;
    safetyStop: { needed: boolean };
  };
  configuration: {
    gfLow_percent: number;
    gfHigh_percent: number;
    amv_lpm: number;
  };
  planner: {
    ceiling_m: number;
    ndl_min: number;
    tts_min: number;
    schedule: {
      stops: { depth: number; time: number }[];
      tts: number;
      outOfGas?: boolean;
    } | null;
  };
  tissues: { n2_bar: number[]; he_bar: number[] };
  tanks: {
    fO2: number;
    fHe: number;
    volume_l: number;
    pressure_bar: number;
    gasRemaining_l: number;
  }[];
  ccr: {
    targetPO2_bar: number;
    actualPO2_bar: number;
    diluent: { fO2: number; fHe: number };
    o2Pressure_bar: number;
    diluentPressure_bar: number;
    scrubberRemaining_min: number;
    onBailout: boolean;
  };
}

interface GoldenScenario {
  scenarioId: string;
  checkpoints: GoldenCheckpoint[];
}

const scenarios = baselineFixture.scenarios as GoldenScenario[];
const ceilingTolerance =
  baselineFixture.tolerances.absoluteEpsilon["planner.ceiling_m"];

describe("DivePlanner canonical parity", () => {
  for (const scenario of scenarios) {
    for (const checkpoint of scenario.checkpoints) {
      it(`matches ${scenario.scenarioId}/${checkpoint.checkpointId}`, () => {
        const state = diveStateFromLegacyCheckpoint(checkpoint, 200);
        const stateBeforeForecast = JSON.stringify(state);
        const settings: PlannerSettings = {
          gfLowPercent: checkpoint.configuration.gfLow_percent,
          gfHighPercent: checkpoint.configuration.gfHigh_percent,
          ascentRateMpm: 9,
          safetyStopNeeded: checkpoint.state.safetyStop.needed,
          ndlDroppedBelowFiveMinutes: false,
        };

        const forecast = new DivePlanner().forecast(state, settings);

        expect(
          Math.abs(forecast.ceilingM - checkpoint.planner.ceiling_m),
        ).toBeLessThanOrEqual(ceilingTolerance);
        expect(forecast.ndlMin).toBe(checkpoint.planner.ndl_min);
        expect(forecast.ttsMin).toBe(checkpoint.planner.tts_min);
        expect(
          forecast.schedule?.stops.map((stop) => ({
            depth: stop.depthM,
            time: stop.durationMin,
          })) ?? null,
        ).toEqual(checkpoint.planner.schedule?.stops ?? null);
        expect(forecast.schedule?.ttsMin ?? null).toBe(
          checkpoint.planner.schedule?.tts ?? null,
        );
        expect(forecast.schedule?.outOfGas ?? false).toBe(
          checkpoint.planner.schedule?.outOfGas ?? false,
        );
        expect(JSON.stringify(state)).toBe(stateBeforeForecast);
      });
    }
  }
});
