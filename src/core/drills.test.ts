import { describe, expect, it } from "vitest";

import { DRILL_FREEFLOW_MULTIPLIER, DiveModel, type DrillEffects } from "./dive-model";
import {
  createCcrState,
  createGasMix,
  createInitialDiveState,
  createTankState,
  freezeDiveState,
  type DiveState,
} from "./dive-state";
import { metres, seconds } from "./units";
import {
  DRILL_DEBRIEF_S,
  DRILL_FREEFLOW_S,
  NO_DRILL,
  dismissDrillDebrief,
  drillPausesDive,
  expireDrillEffects,
  resolveDrillOption,
  startDrill,
  tickDrillDebrief,
  visibleDrillOptions,
} from "./drills";

// The training drills (#160): legacy's #45 harness cases (src/diving-simulator-
// tests.html TC-45-*) that legacy's own functions cannot be run for: the
// phases, the debriefing's time, the free-flow's end, and the effects in the
// model. The gates, the roll, the pick and every option's resolution
// (TC-45-TOGGLE-GATES-TRIGGER, -MIN-DIVETIME-GATE, -MAX-ONE-PER-DIVE,
// -NO-DRILL-DURING-ALARM, -FREEFLOW-BACKUP-DRAIN, -CO2-BAILOUT-CORRECT,
// -CO2-WRONG-KEEPS-COUNTING) are run against legacy's own in
// tests/parity/drills.test.ts.

const AIR = createGasMix(0.21, 0);
const EAN32 = createGasMix(0.32, 0);

function at(depthM: number, elapsedS: number, options: Parameters<typeof createInitialDiveState>[1] = {}): DiveState {
  const state = createInitialDiveState(1, options);
  return freezeDiveState({ ...state, depthM: metres(depthM), maxDepthM: metres(depthM), elapsedTimeS: seconds(elapsedS) });
}

const twoTanks = () => at(20, 300, { tanks: [createTankState(AIR), createTankState(EAN32)] });
const rebreather = () => at(20, 300, { ccr: createCcrState(AIR) });

describe("a drill's decision and debriefing", () => {
  it("offers the backup cylinder only with a second one, and co2's two options", () => {
    expect(visibleDrillOptions("freeflow", 1)).toEqual([0, 2]);
    expect(visibleDrillOptions("freeflow", 2)).toEqual([0, 1, 2]);
    expect(visibleDrillOptions("co2", 1)).toEqual([0, 1]);
  });

  it("stops the dive from the decision to the end of the debriefing (TC-45-DEBRIEF-DISMISS)", () => {
    const started = startDrill(NO_DRILL, "freeflow");
    expect(started).toMatchObject({ phase: "overlay", id: "freeflow", ranThisDive: true, selectedOption: -1 });
    expect(drillPausesDive(started)).toBe(true);
    expect(resolveDrillOption(NO_DRILL, 0, at(20, 300))).toBeNull();
    expect(resolveDrillOption(started, 2, at(20, 300))).toBeNull();
    const debrief = resolveDrillOption(started, 0, at(20, 300))!.drill;
    expect(debrief).toMatchObject({ phase: "debrief", selectedOption: 0, correct: true, debriefRemainingS: DRILL_DEBRIEF_S });
    expect(resolveDrillOption(debrief, 1, at(20, 300))).toBeNull();
    const ticked = tickDrillDebrief(debrief, 4.9);
    expect(ticked.phase).toBe("debrief");
    expect(tickDrillDebrief(ticked, 0.1)).toMatchObject({ phase: "effect", debriefRemainingS: 0 });
    expect(dismissDrillDebrief(debrief).phase).toBe("effect");
    expect(drillPausesDive(dismissDrillDebrief(debrief))).toBe(false);
  });

  it("TC-45-FREEFLOW-CORRECT-MULTIPLIER: breathing through it free-flows the cylinder breathed for 45 dive seconds", () => {
    const resolved = resolveDrillOption(startDrill(NO_DRILL, "freeflow"), 0, at(20, 300))!;
    expect(resolved.effect).toBe("freeflow");
    expect(resolved.drill).toMatchObject({ correct: true, freeflowUntilS: 300 + DRILL_FREEFLOW_S, freeflowTankIndex: 0 });
    expect(expireDrillEffects(resolved.drill, 344.9)).toBe(resolved.drill);
    expect(expireDrillEffects(resolved.drill, 345)).toMatchObject({ freeflowUntilS: 0, freeflowTankIndex: -1 });
  });
});

describe("a drill's effects in the model", () => {
  const effects = (overrides: Partial<DrillEffects>): DrillEffects => ({
    freeflowUntilS: 0,
    freeflowTankIndex: -1,
    breathHoldUntilS: 0,
    ...overrides,
  });
  const used = (before: DiveState, after: DiveState, index: number) =>
    before.tanks[index]!.gasRemainingL - after.tanks[index]!.gasRemainingL;

  it("drains the free-flowing cylinder breathed six times as fast, until its end", () => {
    const start = twoTanks();
    const plain = new DiveModel(start).advance({ depthM: metres(20) }, seconds(1));
    const freeflow = new DiveModel(start).advance({ depthM: metres(20), drill: effects({ freeflowUntilS: 330, freeflowTankIndex: 0 }) }, seconds(1));
    // 15 L/min at 3 bar for a second, as legacy's 15 * (20 / 10 + 1) * dt.
    expect(used(start, plain, 0)).toBeCloseTo(0.75, 10);
    expect(used(start, freeflow, 0)).toBeCloseTo(0.75 * DRILL_FREEFLOW_MULTIPLIER, 10);
    expect(used(start, freeflow, 1)).toBe(0);
    const over = new DiveModel(start).advance({ depthM: metres(20), drill: effects({ freeflowUntilS: 300.5, freeflowTankIndex: 0 }) }, seconds(1));
    expect(used(start, over, 0)).toBeCloseTo(0.75, 10);
  });

  it("drains the cylinder left for the backup alongside the one breathed", () => {
    const start = freezeDiveState({ ...twoTanks(), activeTankIndex: 1 });
    const after = new DiveModel(start).advance({ depthM: metres(20), drill: effects({ freeflowUntilS: 330, freeflowTankIndex: 0 }) }, seconds(1));
    expect(used(start, after, 1)).toBeCloseTo(0.75, 10);
    expect(used(start, after, 0)).toBeCloseTo(0.75 * DRILL_FREEFLOW_MULTIPLIER, 10);
  });

  it("TC-45-FREEFLOW-WRONG-BREATHHOLD-RISKS-BAROTRAUMA: a slow ascent counts toward barotrauma while the breath is held", () => {
    const ascend = (drill?: DrillEffects) => {
      const model = new DiveModel(at(20, 300));
      for (let i = 1; i <= 5; i += 1) {
        // 0.1 m a second, 6 m/min: a third of legacy's 18 m/min.
        model.advance({ depthM: metres(20 - i * 0.1), ...(drill ? { drill } : {}) }, seconds(1));
      }
      return model.snapshot.failure.barotraumaS;
    };
    expect(ascend()).toBe(0);
    expect(ascend(effects({ breathHoldUntilS: 330 }))).toBeCloseTo(5, 10);
    expect(ascend(effects({ breathHoldUntilS: 302 }))).toBe(0);
  });

  it("fails the scrubber as the co2 drill starts, on a loop still breathed", () => {
    const model = new DiveModel(freezeDiveState({ ...rebreather(), ccr: { ...rebreather().ccr!, co2BuildupS: seconds(12) } }));
    expect(model.failScrubber().ccr).toMatchObject({ scrubberFailed: true, co2BuildupS: 0 });
    const bailedOut = new DiveModel(rebreather());
    bailedOut.bailOut();
    expect(bailedOut.failScrubber().ccr?.scrubberFailed).toBe(false);
    expect(new DiveModel(at(20, 300)).failScrubber().ccr).toBeNull();
  });
});
