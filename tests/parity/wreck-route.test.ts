import { describe, expect, it } from "vitest";

// The migration's wreck route against legacy's wreck (#222, Codex round 1 on
// #241). Legacy's real src/sites.js is loaded, as tests/parity/site-geometry
// does: `?raw` and a Function body, so the project stays browser-shaped (no
// node:vm, no @types/node).
import legacySource from "../../src/sites.js?raw";
import constantsSource from "../../src/constants.js?raw";
import baselineFixture from "../fixtures/traces/baseline-v1.json";

import {
  WRECK_DECK_TOP,
  WRECK_DECK_UNDERSIDE,
  WRECK_HOLD_FLOOR_M,
  profileAt,
  routeSpaceNear,
  routeSpacesAt,
} from "../../src/sites/wreck-route";

interface LegacyFeature {
  readonly kind: string;
  readonly x: number;
  readonly d: number;
}

interface LegacyApi {
  readonly DIVE_SITES: Record<string, { readonly features: readonly LegacyFeature[] }>;
  setSite(id: string): void;
  solidAt(x: number, d: number): boolean;
  overheadAt(x: number, d: number): boolean;
}

const MAX_DEPTH = (() => {
  const match = /^\s*(?:const|let|var)\s+MAX_DEPTH\s*=\s*(-?\d+(?:\.\d+)?)\s*;/m.exec(constantsSource);
  if (!match) {
    throw new Error("could not read MAX_DEPTH from src/constants.js");
  }
  return Number(match[1]);
})();

const legacy = new Function(
  "MAX_DEPTH",
  `var diveSite = "wreck";
${legacySource}
return {
  DIVE_SITES: DIVE_SITES,
  setSite: function (id) { diveSite = id; },
  solidAt: solidAt,
  overheadAt: overheadAt
};`,
)(MAX_DEPTH) as LegacyApi;
legacy.setSite("wreck");

// ---------------------------------------------------------------------------
// The two declared departures (docs/decisions.md, Deliberate departures),
// written here as numbers, not read from src/sites/wreck-route.ts, so that
// the route is checked against them rather than against itself.
// ---------------------------------------------------------------------------

/**
 * The raised bow visor (#222, owner decision of 2026-10-10). Legacy draws it
 * as a feature its collision never reads (src/sites.js line 449, bowVisor;
 * src/renderer.js drawBowVisor, line 5806): a 72 by 20 px slab at 0.05 m/px,
 * 3.6 m by 1 m. The migration stands it on the deck's forward edge, which is
 * legacy's main deck's x1 (src/sites.js line 327, x 22), 1 m thick, from
 * 3.6 m above the provisional deck's top there (23 m) down to it.
 */
const VISOR = { x1: 22, x2: 23, topM: 23 - 3.6 } as const;

/**
 * The engine block (#222, owner decision of 2026-10-10). Legacy's engines are
 * features its collision never reads (src/sites.js lines 503..508, drawn by
 * src/renderer.js drawEngine, line 5644, as an 88 by 64 px block). The
 * migration's provisional drawing has one engine of its own, neither at
 * legacy's engine positions nor of their size: a cylinder of 3.1 m radius
 * about (87, 30.5) on a bed from x 81 to 95 whose top is at 33 m.
 */
const ENGINE = { centreX: 87, centreD: 30.5, radiusM: 3.1, bedX1: 81, bedX2: 95, bedTopM: 33 } as const;

type Band = "above" | "deck" | "hold";

/** The visor stands on the deck: it is above the deck's top, nowhere else. */
function inVisor(x: number, band: Band, d: number): boolean {
  return band === "above" && x >= VISOR.x1 && x <= VISOR.x2 && d > VISOR.topM;
}

/** The engine block stands in the hold, under the deck. */
function inEngine(x: number, band: Band, d: number): boolean {
  if (band !== "hold") return false;
  const inCylinder = Math.hypot(x - ENGINE.centreX, d - ENGINE.centreD) < ENGINE.radiusM;
  const onOrUnderCylinderTop =
    Math.abs(x - ENGINE.centreX) < ENGINE.radiusM &&
    d > ENGINE.centreD - Math.sqrt(ENGINE.radiusM ** 2 - (x - ENGINE.centreX) ** 2);
  const inBed = x >= ENGINE.bedX1 && x <= ENGINE.bedX2 && d > ENGINE.bedTopM;
  return inCylinder || onOrUnderCylinderTop || inBed;
}

// ---------------------------------------------------------------------------
// The common frame. The provisional drawing has legacy's layout along x but
// not its depths: legacy's main deck is at 27..28 m over a vehicle deck down
// to 39 m (src/sites.js lines 327 and 358), the drawing's deck at about
// 21..24.5 m over a hold down to 33.5 m. Each column is compared band by
// band, a migration depth mapped linearly onto legacy's:
//   above  surface .. the deck's top        -> 0 .. 27 m
//   deck   the deck's top .. its underside  -> 27 .. 28 m
//   hold   the underside .. the hold's floor -> 28 .. 39 m
// Ahead of the deck the drawing's band edges are those at its forward edge
// (23, 24.5), as profileAt holds them level. Samples sit at cell centres, so
// no sample lands on a band edge, where legacy's edges are inclusive.
// ---------------------------------------------------------------------------

const BANDS: readonly { band: Band; cells: number; legacyTop: number; legacyBottom: number }[] = [
  { band: "above", cells: 40, legacyTop: 0, legacyBottom: 27 },
  { band: "deck", cells: 6, legacyTop: 27, legacyBottom: 28 },
  { band: "hold", cells: 44, legacyTop: 28, legacyBottom: 39 },
];

function migrationBand(x: number, band: Band): [number, number] {
  const top = profileAt(WRECK_DECK_TOP, x);
  const underside = profileAt(WRECK_DECK_UNDERSIDE, x);
  if (band === "above") return [0, top];
  if (band === "deck") return [top, underside];
  return [underside, WRECK_HOLD_FLOOR_M];
}

/**
 * Where the provisional drawing does not model legacy's wreck (#240), and the
 * comparison stops, by band:
 *  - the range is x 8..99: the route's start to the drawn hold's floor, before
 *    the drawing's stern wall (99..103), which legacy's hull has at 168;
 *  - above the deck, only x < 40: legacy's superstructure starts there (the
 *    accommodation wall, src/sites.js line 334), which is not drawn;
 *  - the deck's band, not over legacy's main hatch (78 < x < 92), where
 *    legacy's deck is open and the drawing's is not;
 *  - the overhead in the hold, only x <= 78, for the same hatch.
 * Solid in the hold is compared over the whole range, the hatch included.
 */
function comparesSolid(x: number, band: Band): boolean {
  if (band === "above") return x < 40;
  if (band === "deck") return !(x > 78 && x < 92);
  return true;
}

function comparesOverhead(x: number, band: Band): boolean {
  if (band === "above") return x < 40;
  if (band === "deck") return x <= 78;
  return x <= 78;
}

function migrationSolid(x: number, d: number): boolean {
  return !routeSpacesAt(x).some((space) => space.ceilingM <= d && d <= space.floorM);
}

interface Sample {
  readonly x: number;
  readonly band: Band;
  readonly migrationD: number;
  readonly legacyD: number;
}

function* samples(): Generator<Sample> {
  for (let column = 0; column <= (99 - 8) * 4; column += 1) {
    const x = 8 + column / 4;
    for (const { band, cells, legacyTop, legacyBottom } of BANDS) {
      const [top, bottom] = migrationBand(x, band);
      for (let cell = 0; cell < cells; cell += 1) {
        const fraction = (cell + 0.5) / cells;
        yield {
          x,
          band,
          migrationD: top + (bottom - top) * fraction,
          legacyD: legacyTop + (legacyBottom - legacyTop) * fraction,
        };
      }
    }
  }
}

/** A legacy depth's band and the migration depth it maps to at x, or null past 39 m. */
function toMigration(x: number, legacyD: number): { band: Band; migrationD: number } | null {
  for (const { band, legacyTop, legacyBottom } of BANDS) {
    if (legacyD >= legacyTop && legacyD < legacyBottom) {
      const [top, bottom] = migrationBand(x, band);
      return { band, migrationD: top + ((bottom - top) * (legacyD - legacyTop)) / (legacyBottom - legacyTop) };
    }
  }
  return null;
}

interface WreckCheckpoint {
  readonly checkpointId: string;
  readonly state: { readonly diveSite: string; readonly diverX_m: number; readonly depth_m: number };
}

/** The recorded checkpoints on the wreck (tests/fixtures/traces/baseline-v1.json). */
const WRECK_CHECKPOINTS = (
  baselineFixture.scenarios as unknown as { scenarioId: string; checkpoints: WreckCheckpoint[] }[]
).flatMap((scenario) =>
  scenario.checkpoints
    .filter((checkpoint) => checkpoint.state.diveSite === "wreck")
    .map((checkpoint) => ({ id: `${scenario.scenarioId}/${checkpoint.checkpointId}`, ...checkpoint.state })),
);

describe("the wreck route against legacy's wreck (#222)", () => {
  it("names the recorded wreck checkpoints: none reaches a departure, and those in range match legacy", () => {
    // The scenarios that dive the wreck. Four stay at legacy's entry, x 0, off
    // the bow; wreck-thirds swims to x 50, inside the hold, and out to x -20.
    expect([...new Set(WRECK_CHECKPOINTS.map((checkpoint) => checkpoint.id.split("/")[0]))]).toEqual([
      "trimix-45m-20min",
      "tec-switch-21m",
      "trimix-dcs-above-stop",
      "trimix-dcs-surfaced",
      "wreck-thirds",
    ]);
    const compared: string[] = [];
    const outside: string[] = [];
    for (const { id, diverX_m: x, depth_m: legacyD } of WRECK_CHECKPOINTS) {
      // No checkpoint is anywhere along x where a departure lies, at any depth.
      expect(x >= VISOR.x1 && x <= VISOR.x2, `${id} at the visor`).toBe(false);
      expect(x >= ENGINE.bedX1 && x <= ENGINE.bedX2, `${id} at the engine block`).toBe(false);
      const mapped = x >= 8 && x <= 99 ? toMigration(x, legacyD) : null;
      if (!mapped || !comparesSolid(x, mapped.band) || !comparesOverhead(x, mapped.band)) {
        outside.push(id);
        continue;
      }
      compared.push(id);
      expect(migrationSolid(x, mapped.migrationD), `${id} solid`).toBe(legacy.solidAt(x, legacyD));
      expect(routeSpaceNear(x, mapped.migrationD).inOverhead, `${id} overhead`).toBe(legacy.overheadAt(x, legacyD));
    }
    // In range: wreck-thirds in the hold at x 50, 32 m, which maps to about
    // 27.33 m under the drawn deck: open water and the overhead, as in legacy.
    expect(compared).toEqual([
      "wreck-thirds/outbound-10min",
      "wreck-thirds/turn-20min",
      "wreck-thirds/reserve-28min",
    ]);
    expect(toMigration(50, 32)!.migrationD).toBeCloseTo(23.8 + (9.7 * 4) / 11, 9);
    expect(legacy.overheadAt(50, 32)).toBe(true);
    // Outside: x 0 and -20, before the route's start at 8; and wreck-thirds'
    // surface at x 50, above the deck where legacy's superstructure begins.
    expect(outside).toHaveLength(WRECK_CHECKPOINTS.length - 3);
    expect(outside).toContain("wreck-thirds/surface");
    expect(outside).toContain("wreck-thirds/outside-29min");
  });


  it("is solid where legacy is, except in the visor and the engine block, where only the migration is", () => {
    const mismatches: string[] = [];
    const departures = { visor: 0, engine: 0 };
    for (const { x, band, migrationD, legacyD } of samples()) {
      if (!comparesSolid(x, band)) continue;
      const ours = migrationSolid(x, migrationD);
      const theirs = legacy.solidAt(x, legacyD);
      const where = `x ${x}, ${band}, ${migrationD.toFixed(3)} m (legacy ${legacyD.toFixed(3)} m)`;
      const visor = inVisor(x, band, migrationD);
      if (visor || inEngine(x, band, migrationD)) {
        // The departure: solid in the migration, open water in legacy.
        if (!(ours && !theirs)) mismatches.push(`departure ${where}: ours ${ours}, legacy ${theirs}`);
        departures[visor ? "visor" : "engine"] += 1;
      } else if (ours !== theirs) {
        mismatches.push(`${where}: ours ${ours}, legacy ${theirs}`);
      }
    }
    expect(mismatches.slice(0, 8), `${mismatches.length} mismatches`).toEqual([]);
    // Both departures are sampled, not just declared.
    expect(departures.visor).toBeGreaterThan(20);
    expect(departures.engine).toBeGreaterThan(200);
  });

  it("is in the overhead where legacy's overheadAt is, wherever both are in open water", () => {
    const mismatches: string[] = [];
    let compared = 0;
    for (const { x, band, migrationD, legacyD } of samples()) {
      if (!comparesOverhead(x, band) || migrationSolid(x, migrationD) || legacy.solidAt(x, legacyD)) continue;
      compared += 1;
      const ours = routeSpaceNear(x, migrationD).inOverhead;
      const theirs = legacy.overheadAt(x, legacyD);
      if (ours !== theirs) {
        mismatches.push(`x ${x}, ${band}, ${migrationD.toFixed(3)} m (legacy ${legacyD.toFixed(3)} m): ours ${ours}, legacy ${theirs}`);
      }
    }
    expect(mismatches.slice(0, 8), `${mismatches.length} mismatches`).toEqual([]);
    expect(compared).toBeGreaterThan(10_000);
  });

  it("departs from legacy only where legacy draws a feature its collision never reads", () => {
    const features = legacy.DIVE_SITES.wreck!.features;
    const visor = features.filter((feature) => feature.kind === "bowVisor");
    const engines = features.filter((feature) => feature.kind === "engine");
    expect(visor).toEqual([expect.objectContaining({ x: 18, d: 26 })]);
    expect(engines.map((engine) => engine.x)).toEqual([25, 46, 68, 102, 122, 144]);
    // Legacy's diver is free at the very place each is drawn.
    for (const feature of [...visor, ...engines]) {
      expect(legacy.solidAt(feature.x, feature.d - 0.5), `${feature.kind} at ${feature.x}`).toBe(false);
    }
  });
});
