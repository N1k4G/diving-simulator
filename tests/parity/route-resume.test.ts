import { describe, expect, it } from "vitest";

// A dive resumed at its saved route position (#222), against legacy's save
// and restore (docs/decisions.md, deliberate departures). Legacy's own lines
// are written out here and checked against src/game-loop.js, so the test
// reads what legacy does rather than what the migration does. Legacy's
// src/sites.js is loaded as tests/parity/wreck-route.test.ts loads it, to
// show why a legacy diverX is not placed on the route (#261 pre-review).
import gameLoopSource from "../../src/game-loop.js?raw";
import sitesSource from "../../src/sites.js?raw";
import constantsSource from "../../src/constants.js?raw";
import baselineFixture from "../fixtures/traces/baseline-v1.json";

import {
  diveStateFromLegacyCheckpoint,
  type LegacyTissueCheckpoint,
} from "../../src/app/legacy-dive-adapter";
import { advanceDiveStep } from "../../src/core/dive-model";
import { metres, seconds } from "../../src/core/units";
import { createSaveGame, decodeSaveGame, encodeSaveGame } from "../../src/save/save-game";
import { routeSpaceNear } from "../../src/sites/wreck-route";

interface Checkpoint extends LegacyTissueCheckpoint {
  scenarioId: string;
  checkpointId: string;
  state: LegacyTissueCheckpoint["state"] & {
    gameState: string;
    diveSite: string;
    diverX_m: number;
    debrief: {
      inOverhead: boolean;
      thirdsStartingGas_l: number;
      thirdsTurnWarned: boolean;
      thirdsReserveHit: boolean;
    };
  };
  tanks: NonNullable<LegacyTissueCheckpoint["tanks"]>;
}

/** The route's start, where the migration resumes a dive it cannot place: written out, not imported. */
const ROUTE_START_M = 10;

const MAX_DEPTH = (() => {
  const match = /^\s*(?:const|let|var)\s+MAX_DEPTH\s*=\s*(-?\d+(?:\.\d+)?)\s*;/m.exec(constantsSource);
  if (!match) {
    throw new Error("could not read MAX_DEPTH from src/constants.js");
  }
  return Number(match[1]);
})();

const legacySites = new Function(
  "MAX_DEPTH",
  `var diveSite = "wreck";
${sitesSource}
return { overheadAt: overheadAt };`,
)(MAX_DEPTH) as { overheadAt(x: number, d: number): boolean };

/**
 * Legacy's save and restore of the diver's place and of the rule of thirds
 * (src/game-loop.js saveDiveState, restoreDiveState): diverX is saved and
 * restored unchecked; of the thirds only the reserve latch is saved, so a
 * reloaded page restores the dive with state.js's thirdsStartingGas = 0 and
 * thirdsTurnWarned = false.
 */
const LEGACY_SAVES_DIVER_X = "diverX: diverX,";
const LEGACY_RESTORES_DIVER_X = "diverX = state.diverX || 0;";
const LEGACY_SAVES_RESERVE = "thirdsReserveHitThisDive: thirdsReserveHitThisDive,";

function legacyFunction(name: string): string {
  const start = gameLoopSource.indexOf(`function ${name}(`);
  const end = gameLoopSource.indexOf("\nfunction ", start + 1);
  if (start < 0 || end < 0) {
    throw new Error(`could not find ${name} in src/game-loop.js`);
  }
  return gameLoopSource.slice(start, end);
}

const wreckCheckpoints = (
  baselineFixture.scenarios as unknown as { scenarioId: string; checkpoints: Checkpoint[] }[]
).flatMap((scenario) =>
  scenario.checkpoints
    .filter((checkpoint) => checkpoint.state.diveSite === "wreck")
    .map((checkpoint) => ({ ...checkpoint, scenarioId: scenario.scenarioId })),
);
/** Legacy saves only while 'diving', 'surface' or 'drill'; a game over is cleared. */
const savable = wreckCheckpoints.filter((checkpoint) => checkpoint.state.gameState === "diving");
const name = (checkpoint: Checkpoint) => `${checkpoint.scenarioId}/${checkpoint.checkpointId}`;

/**
 * The checkpoints where the migration's own save resumes at the recorded
 * diverX: all in wreck-thirds, at x 50, where legacy's hold and the route's
 * agree.
 */
const RESUMED_IN_PLACE = [
  "wreck-thirds/surface",
  "wreck-thirds/outbound-10min",
  "wreck-thirds/turn-20min",
  "wreck-thirds/reserve-28min",
];
/** Under the deck, with a plan legacy's reload would drop. */
const RESUMED_UNDER_THE_OVERHEAD = RESUMED_IN_PLACE.slice(1);
/**
 * The checkpoints whose diverX is no place on the route (8..106 m): legacy's
 * entry, x 0, and wreck-thirds' way out, x -20.
 */
const RESUMED_AT_THE_START = [
  "trimix-45m-20min/surface",
  "trimix-45m-20min/bottom-20min",
  "trimix-45m-20min/ascent-21m",
  "trimix-45m-20min/deco-gas-21m",
  "tec-switch-21m/surface",
  "tec-switch-21m/bottom-15min",
  "tec-switch-21m/ascent-21m",
  "tec-switch-21m/switched",
  "tec-switch-21m/deco-gas-3min",
  "trimix-dcs-above-stop/surface",
  "trimix-dcs-above-stop/bottom-20min",
  "trimix-dcs-above-stop/above-stop-30s",
  "trimix-dcs-surfaced/surface",
  "trimix-dcs-surfaced/bottom-20min",
  "wreck-thirds/outside-29min",
];

/** The migration's save at a checkpoint, decoded as a reload reads it. */
function resumedSave(checkpoint: Checkpoint) {
  const state = diveStateFromLegacyCheckpoint(checkpoint, 61);
  const encoded = encodeSaveGame(
    createSaveGame(state, { lowPercent: 35, highPercent: 75 }, 1_735_689_600_000, undefined, {
      routePositionM: checkpoint.state.diverX_m,
    }),
  );
  const decoded = decodeSaveGame(encoded);
  if (!decoded.ok) {
    throw new Error(`the save at ${name(checkpoint)} did not decode: ${decoded.reason}`);
  }
  return decoded.saveGame;
}

/** A legacy save at a checkpoint, as saveDiveState() writes the fields the import reads. */
function legacySave(checkpoint: Checkpoint): Record<string, unknown> {
  return {
    saveVersion: 2,
    savedAt: 1_735_689_600_000,
    gameState: checkpoint.state.gameState,
    diveSite: checkpoint.state.diveSite,
    diverX: checkpoint.state.diverX_m,
    depth: checkpoint.state.depth_m,
    maxDepth: checkpoint.state.maxDepth_m,
    diveTime: checkpoint.state.diveTime_min,
    amvRate: 15,
    po2ViolationTime: 0,
    hypoxiaTime: 0,
    ccrHypoxiaTime: 0,
    ccrHyperoxiaTime: 0,
    tissues: Array.from({ length: 16 }, () => 0.745),
    tissuesHe: Array.from({ length: 16 }, () => 0),
    activeTank: 0,
    tankCount: 1,
    diveMode: "rec",
    tanks: [{ fO2: 0.21, fHe: 0, fN2: 0.79, volume: 12, totalGas: 2_400, gasRemaining: 2_400 }],
  };
}

describe("a resumed dive's place against legacy's save and restore", () => {
  it("reads legacy's lines from src/game-loop.js", () => {
    const save = legacyFunction("saveDiveState");
    const restore = legacyFunction("restoreDiveState");
    expect(save).toContain(LEGACY_SAVES_DIVER_X);
    expect(restore).toContain(LEGACY_RESTORES_DIVER_X);
    expect(save).toContain(LEGACY_SAVES_RESERVE);
    for (const unsaved of ["thirdsStartingGas", "thirdsTurnWarned"]) {
      expect(save, unsaved).not.toContain(unsaved);
      expect(restore, unsaved).not.toContain(unsaved);
    }
  });

  it("names every recorded wreck checkpoint a save can be taken at", () => {
    expect(savable.map(name).sort()).toEqual([...RESUMED_IN_PLACE, ...RESUMED_AT_THE_START].sort());
  });

  it("resumes the migration's own save at its position where it is on the route, in the overhead where legacy was", () => {
    for (const checkpoint of savable.filter((entry) => RESUMED_IN_PLACE.includes(name(entry)))) {
      const where = name(checkpoint);
      const legacyX = checkpoint.state.diverX_m || 0;
      expect(resumedSave(checkpoint).session.routePositionM, where).toBe(legacyX);
      expect(routeSpaceNear(legacyX, checkpoint.state.depth_m).inOverhead, where).toBe(
        checkpoint.state.debrief.inOverhead,
      );
    }
  });

  it("departs where the recorded diverX is off the route: the migration's own save resumes at x 10", () => {
    for (const checkpoint of savable.filter((entry) => RESUMED_AT_THE_START.includes(name(entry)))) {
      const where = name(checkpoint);
      const legacyX = checkpoint.state.diverX_m || 0;
      expect(legacyX, where).not.toBe(ROUTE_START_M);
      expect(resumedSave(checkpoint).session.routePositionM, where).toBe(ROUTE_START_M);
    }
  });

  it("departs for every legacy save: it resumes at x 10, where legacy restores its diverX", () => {
    for (const checkpoint of savable) {
      const where = name(checkpoint);
      const legacyX = checkpoint.state.diverX_m || 0;
      expect(legacyX, where).not.toBe(ROUTE_START_M);
      const imported = decodeSaveGame(JSON.stringify(legacySave(checkpoint)));
      expect(imported.ok, where).toBe(true);
      expect(imported.ok && imported.saveGame.session.routePositionM, where).toBe(ROUTE_START_M);
    }
  });

  it("has legacy's hull and the route's simplified slice disagree on the overhead, which is why", () => {
    // Over legacy's main deck at 27 m the water is open; the route's deck
    // underside is at 24.3 m there. In legacy's accommodation at x 100 the
    // diver is under its roof; the route is above its own deck there.
    for (const [x, d] of [[30, 25], [100, 25]] as const) {
      expect(routeSpaceNear(x, d).inOverhead, `${x}, ${d}`).not.toBe(legacySites.overheadAt(x, d));
    }
    expect(legacySites.overheadAt(30, 25)).toBe(false);
    expect(legacySites.overheadAt(100, 25)).toBe(true);
  });

  it("departs under the overhead: keeps the plan made on entering, which legacy's reload drops", () => {
    for (const checkpoint of savable.filter((entry) => RESUMED_UNDER_THE_OVERHEAD.includes(name(entry)))) {
      const where = name(checkpoint);
      const save = resumedSave(checkpoint);
      const space = routeSpaceNear(save.session.routePositionM, save.state.depthM);
      expect(space.inOverhead, where).toBe(true);
      const next = advanceDiveStep(
        save.state,
        { depthM: metres(checkpoint.state.depth_m), gradientFactorHighPercent: 75, inOverhead: space.inOverhead },
        seconds(1),
      );
      // The independent reference: the plan legacy made on entering, as
      // recorded at the checkpoint, 2,400 L, and its turn latch.
      expect(next.thirds.startingGasL, where).toBe(checkpoint.state.debrief.thirdsStartingGas_l);
      expect(next.thirds.turnWarned, where).toBe(checkpoint.state.debrief.thirdsTurnWarned);
      // Legacy's reload plans afresh from the gas left on its next tick.
      const legacyPlanL = checkpoint.tanks[0]!.gasRemaining_l;
      expect(legacyPlanL, where).toBeLessThan(checkpoint.state.debrief.thirdsStartingGas_l);
      expect(next.thirds.startingGasL, where).not.toBe(legacyPlanL);
    }
  });
});
