import { describe, expect, it } from "vitest";

// A dive resumed at its saved route position (#222), against legacy's save
// and restore (docs/decisions.md, deliberate departures). Legacy's own lines
// are written out here and checked against src/game-loop.js, so the test
// reads what legacy does rather than what the migration does. Legacy's
// src/sites.js is loaded from its source for its own overheadAt(), and
// legacy's diverX resumes on the structures the client ports from it
// (#240 PR 3b).
import gameLoopSource from "../../src/game-loop.js?raw";
import sitesSource from "../../src/sites.js?raw";
import constantsSource from "../../src/constants.js?raw";
import stateSource from "../../src/state.js?raw";
import baselineFixture from "../fixtures/traces/baseline-v1.json";

import {
  diveStateFromLegacyCheckpoint,
  type LegacyTissueCheckpoint,
} from "../../src/app/legacy-dive-adapter";
import { advanceDiveStep } from "../../src/core/dive-model";
import { metres, seconds } from "../../src/core/units";
import { createSaveGame, decodeSaveGame, encodeSaveGame } from "../../src/save/save-game";
import { START_SESSION } from "../../src/save/session-snapshot";
import { overheadAt } from "../../src/sites/site-collision";
import { WRECK_SITE, reachableAt } from "../../src/sites/wreck-site";

interface Checkpoint extends LegacyTissueCheckpoint {
  scenarioId: string;
  checkpointId: string;
  state: LegacyTissueCheckpoint["state"] & {
    gameState: string;
    diveSite: string;
    diverX_m: number;
    verticalVelocity_mpm: number;
    horizontalVelocity_mps: number;
    bcdGasSurface_l: number;
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

const recordedCheckpoints = (
  baselineFixture.scenarios as unknown as { scenarioId: string; checkpoints: Checkpoint[] }[]
).flatMap((scenario) => scenario.checkpoints.map((checkpoint) => ({ ...checkpoint, scenarioId: scenario.scenarioId })));
/** Legacy saves only while 'diving', 'surface' or 'drill'; a game over is cleared. */
const savableAnywhere = recordedCheckpoints.filter((checkpoint) => checkpoint.state.gameState === "diving");
const savable = savableAnywhere.filter((checkpoint) => checkpoint.state.diveSite === "wreck");
/** The recorded checkpoints a save can be taken at on another site: the shore, the cave and the reef. */
const savableOffTheWreck = savableAnywhere.filter((checkpoint) => checkpoint.state.diveSite !== "wreck");
const name = (checkpoint: Checkpoint) => `${checkpoint.scenarioId}/${checkpoint.checkpointId}`;

/** Under the deck, with a plan legacy's reload would drop. */
const RESUMED_UNDER_THE_OVERHEAD = [
  "wreck-thirds/outbound-10min",
  "wreck-thirds/turn-20min",
  "wreck-thirds/reserve-28min",
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
    verticalVelocity: checkpoint.state.verticalVelocity_mpm,
    horizontalVelocity: checkpoint.state.horizontalVelocity_mps,
    bcdGasSurfaceLiters: checkpoint.state.bcdGasSurface_l,
    depth: checkpoint.state.depth_m,
    // A recording put straight at its depth, with no dive before, holds a
    // maxDepth of 0; one legacy saves in a dive holds at least the depth.
    maxDepth: Math.max(checkpoint.state.maxDepth_m, checkpoint.state.depth_m),
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
    // Legacy's entry, x 0, wreck-thirds' x 50 in the vehicle deck under the
    // main deck, and its way out, x -20.
    expect(savable).toHaveLength(19);
    expect([...new Set(savable.map((checkpoint) => checkpoint.state.diverX_m || 0))].sort((a, b) => a - b)).toEqual([
      -20, 0, 50,
    ]);
  });

  it("resumes the migration's own save at legacy's diverX, among legacy's structures, in the overhead where legacy was (#240)", () => {
    for (const checkpoint of savable) {
      const where = name(checkpoint);
      const legacyX = checkpoint.state.diverX_m || 0;
      expect(resumedSave(checkpoint).session.routePositionM, where).toBe(legacyX);
      expect(overheadAt(WRECK_SITE, legacyX, checkpoint.state.depth_m), where).toBe(checkpoint.state.debrief.inOverhead);
    }
    expect(savable.filter((checkpoint) => checkpoint.state.debrief.inOverhead).map(name)).toEqual(
      RESUMED_UNDER_THE_OVERHEAD,
    );
  });

  it("resumes every legacy save at its diverX, as legacy restores it, with the motion it saved (#240 PR 3b)", () => {
    for (const checkpoint of savable) {
      const where = name(checkpoint);
      const legacyX = checkpoint.state.diverX_m || 0;
      const imported = decodeSaveGame(JSON.stringify(legacySave(checkpoint)));
      expect(imported.ok, where).toBe(true);
      if (!imported.ok) return;
      const { session, state } = imported.saveGame;
      expect(session.routePositionM, where).toBe(legacyX);
      // Under the overhead exactly where legacy's own overheadAt has it, and recorded it.
      expect(legacySites.overheadAt(legacyX, checkpoint.state.depth_m), where).toBe(checkpoint.state.debrief.inOverhead);
      expect(overheadAt(WRECK_SITE, session.routePositionM, state.depthM), where).toBe(
        legacySites.overheadAt(legacyX, checkpoint.state.depth_m),
      );
      expect(state.verticalVelocityMpm, where).toBe(checkpoint.state.verticalVelocity_mpm);
      expect(state.bcdGasSurfaceLiters, where).toBe(checkpoint.state.bcdGasSurface_l);
    }
    // x 10, the route's start, is none of them: every place is legacy's own.
    expect(savable.some((checkpoint) => (checkpoint.state.diverX_m || 0) === ROUTE_START_M)).toBe(false);
  });

  it("departs for every legacy save of another site: it resumes at x 10, where legacy's own restore gives its diverX", () => {
    // Legacy restores the site with the x (src/game-loop.js 1674, 1677); the
    // client plays the wreck alone, where another site's x is no place.
    // Legacy's own restore line, checked above, run on each save.
    const legacyRestoredX = new Function("state", `var diverX; ${LEGACY_RESTORES_DIVER_X} return diverX;`) as (
      state: Record<string, unknown>,
    ) => number;
    const bySite = new Map<string, number>();
    for (const checkpoint of savableOffTheWreck) {
      bySite.set(checkpoint.state.diveSite, (bySite.get(checkpoint.state.diveSite) ?? 0) + 1);
    }
    expect(Object.fromEntries(bySite)).toEqual({ shore: 31, cave: 3, reef: 6 });
    expect([...new Set(savableOffTheWreck.map((checkpoint) => checkpoint.scenarioId))].sort()).toEqual([
      "air-18m-30min",
      "barotrauma-runaway-ascent-30m",
      "buoyancy-ccr-inflate-12m",
      "buoyancy-vent-inflate-12m",
      "ccr-30m-30min",
      "ccr-bailout-30m",
      "ccr-setpoint-bailout-30m",
      "narcosis-air-65m",
      "shark-encounter-5m",
    ]);
    for (const checkpoint of savableOffTheWreck) {
      const where = `${name(checkpoint)} (${checkpoint.state.diveSite})`;
      const save = legacySave(checkpoint);
      expect(legacyRestoredX(save), where).toBe(0);
      const imported = decodeSaveGame(JSON.stringify(save));
      expect(imported.ok, where).toBe(true);
      if (!imported.ok) return;
      expect(imported.saveGame.session.routePositionM, where).toBe(ROUTE_START_M);
      expect(imported.saveGame.session.routePositionM, where).not.toBe(legacyRestoredX(save));
    }
  });

  it("departs under the overhead: keeps the plan made on entering, which legacy's reload drops", () => {
    for (const checkpoint of savable.filter((entry) => RESUMED_UNDER_THE_OVERHEAD.includes(name(entry)))) {
      const where = name(checkpoint);
      const save = resumedSave(checkpoint);
      const inOverhead = overheadAt(WRECK_SITE, save.session.routePositionM, save.state.depthM);
      expect(inOverhead, where).toBe(true);
      const next = advanceDiveStep(
        save.state,
        { depthM: metres(checkpoint.state.depth_m), gradientFactorHighPercent: 75, inOverhead },
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

/**
 * Where legacy starts a dive: resetDive() puts the diver at x 0 (src/state.js
 * 1108), its entry, whatever the site; no legacy code reads the site's
 * entry.x.
 */
const LEGACY_RESETS_DIVER_X = "diverX = 0;";

/** The recorded wreck checkpoints at the start of a dive at legacy's x 0. */
const FRESH_AT_LEGACY_START = [
  "trimix-45m-20min/surface",
  "tec-switch-21m/surface",
  "trimix-dcs-above-stop/surface",
  "trimix-dcs-surfaced/surface",
];

describe("where a fresh dive starts against legacy's resetDive()", () => {
  it("departs: the client starts a fresh dive at x 10, where legacy's starts at x 0 (#199)", () => {
    const start = stateSource.indexOf("function resetDive(");
    const end = stateSource.indexOf("\nfunction ", start + 1);
    expect(start, "resetDive in src/state.js").toBeGreaterThanOrEqual(0);
    expect(stateSource.slice(start, end < 0 ? undefined : end)).toContain(LEGACY_RESETS_DIVER_X);
    const fresh = recordedCheckpoints.filter(
      (checkpoint) =>
        checkpoint.state.diveSite === "wreck" && checkpoint.state.diveTime_min === 0 && checkpoint.state.diverX_m === 0,
    );
    expect(fresh.map(name)).toEqual(FRESH_AT_LEGACY_START);
    for (const checkpoint of fresh) {
      expect(checkpoint.state.depth_m, name(checkpoint)).toBe(0);
    }
    // The departure: the client's fresh session starts at x 10, not legacy's 0.
    expect(START_SESSION.routePositionM).toBe(ROUTE_START_M);
    expect(START_SESSION.routePositionM).not.toBe(fresh[0]!.state.diverX_m);
    // In place only: both are open water off the bow, clear of the stem at
    // x 14, reached from the surface down to the seabed, with nothing overhead.
    for (const x of [0, ROUTE_START_M]) {
      for (const depthM of [0, 20, 40, 66]) {
        expect(reachableAt(x, depthM), `reachable at x ${x}, ${depthM} m`).toBe(true);
        expect(overheadAt(WRECK_SITE, x, depthM), `overhead at x ${x}, ${depthM} m`).toBe(false);
        expect(legacySites.overheadAt(x, depthM), `legacy's overhead at x ${x}, ${depthM} m`).toBe(false);
      }
    }
  });
});
