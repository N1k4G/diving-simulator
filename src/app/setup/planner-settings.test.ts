import { describe, expect, it } from "vitest";

import { DiveModel, openCircuit } from "../../core/dive-model";
import { createGasMix, createInitialDiveState } from "../../core/dive-state";
import { DEFAULT_PLANNER_SETTINGS, DivePlanner } from "../../planner/dive-planner";
import { metres, minutes, minutesToSeconds } from "../../core/units";
import { GameController } from "../game-controller";
import {
  createDefaultSetup,
  selectMode,
  toPlannerSettings,
} from "./dive-setup";
import {
  adjustGradientFactorHigh,
  adjustGradientFactorLow,
} from "./tec-controls";

// #158 review: the setup screen stored gradient factors and the controller
// asked the planner with DEFAULT_PLANNER_SETTINGS regardless, so the controls
// changed a number nobody read. These cover the two halves of that: the
// factors reach the controller, and they make a difference when they get
// there.

describe("gradient factors reach the planner", () => {
  it("converts the setup into planner settings", () => {
    const setup = adjustGradientFactorHigh(
      adjustGradientFactorLow(selectMode(createDefaultSetup(), "tec"), 15),
      5,
    );
    expect(setup.gradientFactorLow).toBe(50);
    expect(setup.gradientFactorHigh).toBe(80);

    const settings = toPlannerSettings(setup);
    expect(settings.gfLowPercent).toBe(50);
    expect(settings.gfHighPercent).toBe(80);
    // The rest of the planner contract is untouched by the setup screen.
    expect(settings.ascentRateMpm).toBe(DEFAULT_PLANNER_SETTINGS.ascentRateMpm);
  });

  it("is what the controller will ask the planner with", () => {
    // The controller used to hold no settings at all. Asserting the value it
    // carries is the closest a DOM-free test gets to the forecast call; the
    // e2e in tests/setup-screen.spec.js covers the rest of the chain.
    const setup = adjustGradientFactorLow(
      selectMode(createDefaultSetup(), "tec"),
      15,
    );
    const controller = new GameController({
      renderer: {
        kind: "pixi",
        mount: () => Promise.resolve(),
        render: () => undefined,
        resize: () => undefined,
        destroy: () => undefined,
      },
      onFrame: () => undefined,
      plannerSettings: toPlannerSettings(setup),
      plannerClient: {
        forecast: () => new Promise(() => undefined),
        dispose: () => undefined,
      } as unknown as ConstructorParameters<
        typeof GameController
      >[0]["plannerClient"],
    });

    expect(controller.plannerSettings.gfLowPercent).toBe(50);
    expect(controller.plannerSettings.gfHighPercent).toBe(75);
    // No destroy(): the controller was never started, so there is nothing to
    // tear down, and destroy() reaches for cancelAnimationFrame which the
    // node test environment does not provide.
  });

  it("defaults to the planner's own settings when nothing is configured", () => {
    const controller = new GameController({
      renderer: {
        kind: "pixi",
        mount: () => Promise.resolve(),
        render: () => undefined,
        resize: () => undefined,
        destroy: () => undefined,
      },
      onFrame: () => undefined,
      plannerClient: {
        forecast: () => new Promise(() => undefined),
        dispose: () => undefined,
      } as unknown as ConstructorParameters<
        typeof GameController
      >[0]["plannerClient"],
    });

    expect(controller.plannerSettings).toEqual(DEFAULT_PLANNER_SETTINGS);
  });
});

describe("the gradient factors actually move the forecast", () => {
  // Without this the tests above could pass while the numbers were inert.
  it("gives a conservative pair less no-decompression time than a liberal one", () => {
    const model = new DiveModel(createInitialDiveState(1));
    model.advance(
      { depthM: metres(26), breathing: openCircuit(createGasMix(0.21, 0)) },
      minutesToSeconds(minutes(15)),
    );
    const state = model.snapshot;
    const planner = new DivePlanner();
    const ndlAt = (low: number, high: number) =>
      planner.forecast(state, {
        ...DEFAULT_PLANNER_SETTINGS,
        gfLowPercent: low,
        gfHighPercent: high,
      }).ndlMin;

    const conservative = ndlAt(30, 30);
    const liberal = ndlAt(100, 100);

    expect(conservative).toBeLessThan(liberal);
  });
});
