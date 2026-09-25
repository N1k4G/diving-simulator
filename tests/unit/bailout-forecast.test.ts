import { describe, expect, it } from "vitest";

import {
  createCcrState,
  createGasMix,
  createInitialDiveState,
  createTankState,
  freezeDiveState,
  type DiveState,
} from "../../src/core/dive-state";
import { bars, metres } from "../../src/core/units";
import {
  DEFAULT_PLANNER_SETTINGS,
  DivePlanner,
} from "../../src/planner/dive-planner";

// #183: after a bailout the forecast breathes the diluent, and only the
// diluent. A deliberate departure from the legacy client, which plans the
// ascent on the setup cylinder (docs/decisions.md, "Deliberate departures
// from the legacy client"). tests/parity/dive-planner.test.ts pins the
// difference on the recorded dive; these cover what the recording cannot.

/** Bailed out at 18 m with a decompression obligation (3.0 bar N2 in every compartment). */
function bailedOut(diluentPressureBar: number): DiveState {
  const base = createInitialDiveState(91, {
    // The save's placeholder cylinder: EAN50, a far better deco gas than the
    // Tx 15/45 diluent. If the forecast looked at tanks[], it would pick this.
    tanks: [createTankState(createGasMix(0.5, 0))],
    ccr: createCcrState(createGasMix(0.15, 0.45), {
      diluentCylinderPressureBar: bars(diluentPressureBar),
    }),
  });
  return freezeDiveState({
    ...base,
    ccr: { ...base.ccr!, onBailout: true },
    depthM: metres(18),
    maxDepthM: metres(30),
    tissues: {
      nitrogenBar: base.tissues.nitrogenBar.map(() => bars(3)),
      heliumBar: base.tissues.heliumBar,
    },
  });
}

describe("the bailout forecast", () => {
  it("plans the ascent on the diluent, not the placeholder cylinder", () => {
    const planner = new DivePlanner();
    const forecast = planner.forecast(bailedOut(150), DEFAULT_PLANNER_SETTINGS);

    // The same dive as open circuit on the placeholder: what legacy plans.
    const onPlaceholder = freezeDiveState({ ...bailedOut(150), ccr: null });
    const legacyLike = planner.forecast(onPlaceholder, DEFAULT_PLANNER_SETTINGS);

    expect(forecast.schedule?.outOfGas).toBe(false);
    expect(forecast.schedule?.stops.length).toBeGreaterThan(0);
    // EAN50 would clear the stops sooner than Tx 15/45 does.
    expect(forecast.ttsMin).toBeGreaterThan(legacyLike.ttsMin);
  });

  it("runs out of gas when the diluent cylinder is empty, placeholder or not", () => {
    const forecast = new DivePlanner().forecast(bailedOut(0), DEFAULT_PLANNER_SETTINGS);
    expect(forecast.schedule?.outOfGas).toBe(true);
  });
});
