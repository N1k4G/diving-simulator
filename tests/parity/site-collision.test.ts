import { describe, expect, it } from "vitest";

// The ported site collision (#240 PR 1) against legacy's own functions.
//
// Legacy's real src/constants.js, src/sites.js and the movement functions of
// src/physics.js are loaded into one Function body, as tests/parity/drills
// loads its legacy source (`?raw`, no node:vm), with the diver's globals that
// src/state.js declares. Each function is then called on the same position in
// both clients, on every authored site, over a grid and at every structure's
// edges, where the inclusive and exclusive comparisons differ.
//
// Both sides are computed in the same run on the same engine, so they agree
// to the bit wherever the port keeps legacy's operations; the numbers are
// compared within 1e-12 all the same, as every computed float in this suite is
// (docs/decisions.md; Linux CI's float bits).

import constantsSource from "../../src/constants.js?raw";
import sitesSource from "../../src/sites.js?raw";
import physicsSource from "../../src/physics.js?raw";

import {
  DIVER_HALF_HEIGHT_M,
  DIVER_HALF_WIDTH_M,
  HORIZONTAL_SUBSTEP_M,
  VERTICAL_SUBSTEP_M,
  ceilingAt,
  diverOverlapArea,
  diverOverlapGrew,
  diverSolidAt,
  floorAt,
  moveHorizontally,
  overheadAt,
  resolveDiverOverlap,
  solidAt,
  solidBoxAt,
  solidOverlapArea,
  stepVertically,
  type CollisionSite,
} from "../../src/sites/site-collision";
import { MAX_DEPTH_M, integrateBuoyancy } from "../../src/core/buoyancy";
import { createInitialDiveState, freezeDiveState } from "../../src/core/dive-state";
import { metres } from "../../src/core/units";
import { SITE_GAMEPLAY } from "../../src/sites/site-resources";

function legacyFunction(source: string, name: string): string {
  const match = new RegExp(`^function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}`, "m").exec(source);
  if (!match) throw new Error(`could not read ${name}() from the legacy source`);
  return match[0];
}

interface LegacyApi {
  readonly constants: Readonly<Record<"MAX_DEPTH" | "DIVER_HALF_WIDTH_M" | "DIVER_HALF_HEIGHT_M", number>>;
  readonly siteIds: readonly string[];
  setSite(id: string): void;
  addSite(id: string, site: CollisionSite): void;
  place(x: number, d: number, verticalVelocity: number, horizontalVelocity: number, bcdLitres: number): void;
  diver(): { x: number; d: number; verticalVelocity: number; horizontalVelocity: number };
  floorAt(x: number): number;
  ceilingAt(x: number): number;
  solidAt(x: number, d: number): boolean;
  solidBoxAt(x: number, d: number, halfWidth: number, halfHeight: number): boolean;
  diverSolidAt(x: number, d: number): boolean;
  solidOverlapArea(x: number, d: number, halfWidth: number, halfHeight: number): number;
  diverOverlapArea(x: number, d: number): number;
  diverOverlapGrew(fromX: number, fromD: number, toX: number, toD: number): boolean;
  overheadAt(x: number, d: number): boolean;
  resolveDiverOverlap(): boolean;
  updateBuoyancyPhysics(dtSec: number): void;
  updateHorizontalPhysics(dtSec: number, kickDir: number): void;
}

const legacy = new Function(
  `${constantsSource}
var diveSite = "wreck", diverX = 0, depth = 0, verticalVelocity = 0, horizontalVelocity = 0,
  currentVerticalRate = 0, bcdGasSurfaceLiters = 0, current = { active: false };
${sitesSource}
${["ambientPressure", "updateBuoyancyPhysics", "currentVelAt", "updateHorizontalPhysics"]
  .map((name) => legacyFunction(physicsSource, name))
  .join("\n")}
return {
  constants: { MAX_DEPTH: MAX_DEPTH, DIVER_HALF_WIDTH_M: DIVER_HALF_WIDTH_M, DIVER_HALF_HEIGHT_M: DIVER_HALF_HEIGHT_M },
  siteIds: Object.keys(DIVE_SITES),
  setSite: function (id) { diveSite = id; },
  addSite: function (id, s) { DIVE_SITES[id] = s; },
  place: function (x, d, vv, hv, bcd) {
    diverX = x; depth = d; verticalVelocity = vv; horizontalVelocity = hv; bcdGasSurfaceLiters = bcd;
  },
  diver: function () {
    return { x: diverX, d: depth, verticalVelocity: verticalVelocity, horizontalVelocity: horizontalVelocity };
  },
  floorAt: floorAt, ceilingAt: ceilingAt, solidAt: solidAt, solidBoxAt: solidBoxAt, diverSolidAt: diverSolidAt,
  solidOverlapArea: solidOverlapArea, diverOverlapArea: diverOverlapArea, diverOverlapGrew: diverOverlapGrew,
  overheadAt: overheadAt, resolveDiverOverlap: resolveDiverOverlap,
  updateBuoyancyPhysics: updateBuoyancyPhysics, updateHorizontalPhysics: updateHorizontalPhysics
};`,
)() as LegacyApi;

/** No site at all: legacy's activeSite() is null, so nothing collides and only the global bounds hold. */
const NO_SITE = "no-such-site";

function close(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-12;
}

function site(id: string): CollisionSite {
  const found = SITE_GAMEPLAY[id];
  if (!found) throw new Error(`no gameplay resource for ${id}`);
  return found;
}

interface Position {
  readonly x: number;
  readonly d: number;
}

/**
 * Positions to compare on a site: a grid off the integer metre, so that the
 * grid is not only edges, and, for every structure, positions where the
 * diver's body just touches, just overlaps or just clears each of its edges.
 */
function positions(collision: CollisionSite, gridStepM: number): Position[] {
  const out: Position[] = [];
  for (let x = -40.13; x <= 200; x += gridStepM) {
    for (let d = 0.07; d <= 70; d += gridStepM / 2) out.push({ x, d });
  }
  for (const w of collision.structures) {
    for (const nudge of [-0.01, -1e-9, 0, 1e-9, 0.01]) {
      const xs = [w.x1 - DIVER_HALF_WIDTH_M + nudge, w.x2 + DIVER_HALF_WIDTH_M + nudge, w.x1 + nudge, (w.x1 + w.x2) / 2];
      for (const x of xs) {
        out.push({ x, d: (w.dTop + w.dBottom) / 2 });
        for (const d of [w.dTop - DIVER_HALF_HEIGHT_M + nudge, w.dBottom + DIVER_HALF_HEIGHT_M + nudge, w.dTop + nudge]) {
          out.push({ x, d });
        }
      }
    }
  }
  return out;
}

/** Legacy's geometry questions at a position, asked of both clients; the ones they answer differently. */
function geometryMismatches(collision: CollisionSite, { x, d }: Position): string[] {
  const out: string[] = [];
  const check = (what: string, agree: boolean): void => {
    if (!agree) out.push(`${what} (${x}, ${d})`);
  };
  check("floorAt", floorAt(collision, x) === legacy.floorAt(x));
  check("ceilingAt", ceilingAt(collision, x) === legacy.ceilingAt(x));
  check("solidAt", solidAt(collision, x, d) === legacy.solidAt(x, d));
  check("diverSolidAt", diverSolidAt(collision, x, d) === legacy.diverSolidAt(x, d));
  check("solidBoxAt", solidBoxAt(collision, x, d, 1.2, 0.05) === legacy.solidBoxAt(x, d, 1.2, 0.05));
  check("diverOverlapArea", close(diverOverlapArea(collision, x, d), legacy.diverOverlapArea(x, d)));
  check("solidOverlapArea", close(solidOverlapArea(collision, x, d, 0.2, 1.1), legacy.solidOverlapArea(x, d, 0.2, 1.1)));
  for (const [toX, toD] of [[x + 0.05, d], [x - 0.3, d], [x, d + 0.1], [x, d - 0.04]] as const) {
    check(`diverOverlapGrew to (${toX}, ${toD})`, diverOverlapGrew(collision, x, d, toX, toD) === legacy.diverOverlapGrew(x, d, toX, toD));
  }
  check("overheadAt", overheadAt(collision, x, d) === legacy.overheadAt(x, d));
  return out;
}

interface Tally {
  compared: number;
  stopped: number;
  readonly mismatches: string[];
}

function tally(): Tally {
  return { compared: 0, stopped: 0, mismatches: [] };
}

/**
 * One frame of legacy's buoyancy physics from a position, on the site and
 * with no site: the velocity is the buoyancy's and the same in both, so the
 * free run gives the velocity the port is handed. Skipped where the free run
 * itself was held at the surface.
 */
function compareVertical(id: string, collision: CollisionSite, { x, d }: Position, startMpm: number, dtS: number, into: Tally): void {
  legacy.setSite(NO_SITE);
  legacy.place(x, d, startMpm, 0, 4);
  legacy.updateBuoyancyPhysics(dtS);
  const free = legacy.diver();
  if (free.d !== d + free.verticalVelocity * (dtS / 60)) return;
  legacy.setSite(id);
  legacy.place(x, d, startMpm, 0, 4);
  legacy.updateBuoyancyPhysics(dtS);
  const theirs = legacy.diver();
  const ours = stepVertically(collision, x, d, free.verticalVelocity, dtS);
  into.compared += 1;
  if (theirs.verticalVelocity === 0 && free.verticalVelocity !== 0) into.stopped += 1;
  if (!close(ours.depthM, theirs.d) || !close(ours.verticalVelocityMpm, theirs.verticalVelocity)) {
    into.mismatches.push(`vertical (${x}, ${d}) at ${free.verticalVelocity} m/min for ${dtS} s: ${ours.depthM} vs ${theirs.d}`);
  }
}

/** One call of legacy's fin-kick physics, on the site and with no site, whose displacement the port is handed. */
function compareHorizontal(id: string, collision: CollisionSite, { x, d }: Position, startMps: number, kick: number, dtS: number, into: Tally): void {
  legacy.setSite(NO_SITE);
  legacy.place(x, d, 0, startMps, 0);
  legacy.updateHorizontalPhysics(dtS, kick);
  // Legacy's displacement, (v + current) * dt, with no current.
  const displacementM = legacy.diver().horizontalVelocity * dtS;
  legacy.setSite(id);
  legacy.place(x, d, 0, startMps, 0);
  legacy.updateHorizontalPhysics(dtS, kick);
  const theirs = legacy.diver();
  const theirsBlocked = theirs.horizontalVelocity === 0 && displacementM !== 0;
  const ours = moveHorizontally(collision, x, d, displacementM);
  into.compared += 1;
  if (theirsBlocked) into.stopped += 1;
  if (!close(ours.xM, theirs.x) || (displacementM !== 0 && ours.blocked !== theirsBlocked)) {
    into.mismatches.push(`horizontal (${x}, ${d}) by ${displacementM} m: ${ours.xM}/${ours.blocked} vs ${theirs.x}/${theirsBlocked}`);
  }
}

/** Legacy's overlap resolution from a position, which zeroes the velocity along each axis it pushes the diver. */
function compareResolution(id: string, collision: CollisionSite, { x, d }: Position, into: Tally): void {
  legacy.setSite(id);
  legacy.place(x, d, 1, 1, 0);
  const moved = legacy.resolveDiverOverlap();
  const theirs = legacy.diver();
  const ours = resolveDiverOverlap(collision, x, d);
  into.compared += 1;
  if (moved) into.stopped += 1;
  if (
    !close(ours.xM, theirs.x) ||
    !close(ours.depthM, theirs.d) ||
    ours.movedHorizontally !== (theirs.horizontalVelocity === 0) ||
    ours.movedVertically !== (theirs.verticalVelocity === 0) ||
    (ours.movedHorizontally || ours.movedVertically) !== moved
  ) {
    into.mismatches.push(`resolve (${x}, ${d}): ${JSON.stringify(ours)} vs ${JSON.stringify(theirs)}`);
  }
}

const SITE_IDS = Object.keys(SITE_GAMEPLAY).sort();

describe("the ported site collision against legacy's (#240)", { timeout: 30_000 }, () => {
  it("covers every authored site, with legacy's diver extents, depth limit and sub-steps", () => {
    expect([...legacy.siteIds].sort()).toEqual(SITE_IDS);
    expect(DIVER_HALF_WIDTH_M).toBe(legacy.constants.DIVER_HALF_WIDTH_M);
    expect(DIVER_HALF_HEIGHT_M).toBe(legacy.constants.DIVER_HALF_HEIGHT_M);
    expect(MAX_DEPTH_M).toBe(legacy.constants.MAX_DEPTH);
    expect(physicsSource).toContain("Math.ceil(Math.abs(_dz) / 0.1)");
    expect(physicsSource).toContain("Math.ceil(Math.abs(dispX) / 0.3)");
    expect([VERTICAL_SUBSTEP_M, HORIZONTAL_SUBSTEP_M]).toEqual([0.1, 0.3]);
  });

  for (const id of SITE_IDS) {
    it(`answers legacy's geometry questions on the ${id}`, () => {
      const collision = site(id);
      legacy.setSite(id);
      const all = positions(collision, 1);
      expect(all.length).toBeGreaterThan(30_000);
      const mismatches = all.flatMap((position) => geometryMismatches(collision, position));
      expect(mismatches.slice(0, 5), `${mismatches.length} mismatches`).toEqual([]);
    });

    it(`moves the diver through the ${id} as legacy's physics does, and frees it as legacy does`, () => {
      const collision = site(id);
      const [vertical, horizontal, resolution] = [tally(), tally(), tally()];
      for (const position of positions(collision, 2)) {
        for (const startMpm of [-25, -6, -0.4, 0, 0.4, 6, 20]) {
          for (const dtS of [0.1, 1]) compareVertical(id, collision, position, startMpm, dtS, vertical);
        }
        for (const startMps of [-0.6, 0, 0.6]) {
          for (const kick of [-1, 1]) {
            for (const dtS of [0.1, 3]) compareHorizontal(id, collision, position, startMps, kick, dtS, horizontal);
          }
        }
      }
      for (const position of positions(collision, 1)) compareResolution(id, collision, position, resolution);
      expect(vertical.compared).toBeGreaterThan(20_000);
      expect(horizontal.compared).toBeGreaterThan(30_000);
      if (collision.structures.length > 0) {
        expect(Math.min(vertical.stopped, horizontal.stopped)).toBeGreaterThan(100);
        expect(resolution.stopped).toBeGreaterThan(500);
      }
      const mismatches = [...vertical.mismatches, ...horizontal.mismatches, ...resolution.mismatches];
      expect(mismatches.slice(0, 5), `${mismatches.length} mismatches`).toEqual([]);
    });
  }

  it("collides with structures only: the diver swims through the wreck's engines and bow visor", () => {
    // Legacy draws them as features (src/sites.js, the bowVisor at x 18 and
    // the six engines on the 61 m deck, 4.4 by 3.2 m: src/renderer.js
    // drawEngine, 88 by 64 px at 0.05 m/px); its collision never reads them.
    const wreck = site("wreck");
    legacy.setSite("wreck");
    for (const [x, d] of [[18, 26], [25, 59.5], [46, 59.5], [68, 59.5], [102, 59.5], [122, 59.5], [144, 59.5]] as const) {
      expect(diverOverlapArea(wreck, x, d), `(${x}, ${d})`).toBe(0);
      expect(legacy.diverOverlapArea(x, d), `legacy (${x}, ${d})`).toBe(0);
    }
  });

  it("frees the diver where legacy's comments name its traps", () => {
    // src/sites.js resolveDiverOverlap and diverOverlapGrew: the mast standing
    // on the bridge roof, which with it is one column; the jammed bulkhead's
    // corner with the cargo hold's floor; the keel on the seabed; the stem.
    const wreck = site("wreck");
    legacy.setSite("wreck");
    for (const [x, d] of [[75.5, 17.7], [75.5, 18.3], [56.1, 51.9], [100, 65.5], [15.5, 63.7], [16.2, 40]] as const) {
      legacy.place(x, d, 1, 1, 0);
      expect(legacy.resolveDiverOverlap(), `legacy moves the diver at (${x}, ${d})`).toBe(true);
      const theirs = legacy.diver();
      const ours = resolveDiverOverlap(wreck, x, d);
      expect(ours.xM, `x from (${x}, ${d})`).toBeCloseTo(theirs.x, 12);
      expect(ours.depthM, `depth from (${x}, ${d})`).toBeCloseTo(theirs.d, 12);
    }
    // Out of the mast and the bridge roof both, not back and forth between them.
    const outOfTheMast = resolveDiverOverlap(wreck, 75.5, 17.7);
    expect(diverOverlapArea(wreck, outOfTheMast.xM, outOfTheMast.depthM)).toBe(0);
  });

  it("agrees with legacy on cluttered sites no one authored", () => {
    // The authored sites never stack more than two structures on the diver,
    // so the resolver's later passes and its pass limit are reached only on
    // sites like these: seeded clutter of small overlapping boxes under a
    // sloping floor, some with a ceiling, given to legacy as sites of its own.
    let seed = 240;
    const random = (): number => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const [movement, resolution] = [tally(), tally()];
    for (let index = 0; index < 12; index += 1) {
      const structures = Array.from({ length: 40 }, () => {
        const x1 = random() * 12;
        const dTop = 2 + random() * 12;
        return { x1, x2: x1 + 0.05 + random() * 1.2, dTop, dBottom: dTop + 0.05 + random() * 0.9 };
      });
      const level = (from: number, spread: number): { x: number; d: number }[] => [
        { x: -2, d: from + random() * spread },
        { x: 14, d: from + random() * spread },
      ];
      const cluttered: CollisionSite = {
        hasOverhead: index % 2 === 0,
        floor: level(15, 3),
        ceiling: index % 3 === 0 ? level(0, 2) : null,
        structures,
      };
      const id = `cluttered-${index}`;
      legacy.addSite(id, cluttered);
      for (let sample = 0; sample < 400; sample += 1) {
        const position = { x: -1 + random() * 14, d: 1 + random() * 15 };
        compareResolution(id, cluttered, position, resolution);
        for (const startMpm of [-20, 15]) compareVertical(id, cluttered, position, startMpm, 1, movement);
        for (const kick of [-1, 1]) compareHorizontal(id, cluttered, position, 0.6 * kick, kick, 3, movement);
      }
    }
    expect(resolution.stopped).toBeGreaterThan(1000);
    const mismatches = [...movement.mismatches, ...resolution.mismatches];
    expect(mismatches.slice(0, 5), `${mismatches.length} mismatches`).toEqual([]);
  });

  it("runs the model's frame through the wreck as legacy's updateDiving() runs it, for a diver not finning (#240 PR 2)", () => {
    // src/game-loop.js 427-434: resolveDiverOverlap(), then in sub-steps of
    // at most 0.1 s updateBuoyancyPhysics() and updateHorizontalPhysics().
    // Legacy's fins have a velocity of their own that the client's do not
    // (docs/decisions.md), so the frame is compared where the diver does not
    // fin: everything else of it, the overlap, the depth's sub-steps and
    // their stops, is legacy's.
    const wreck = site("wreck");
    const frames = tally();
    const base = createInitialDiveState(240);
    for (const position of positions(wreck, 4)) {
      for (const [velocity, bcd] of [[-20, 12], [0, 6], [15, 0]] as const) {
        for (const frameS of [0.3, 3]) {
          legacy.setSite("wreck");
          legacy.place(position.x, position.d, velocity, 0, bcd);
          const freed = legacy.resolveDiverOverlap();
          for (let remaining = frameS; remaining > 1e-9; remaining -= Math.min(0.1, remaining)) {
            legacy.updateBuoyancyPhysics(Math.min(0.1, remaining));
            legacy.updateHorizontalPhysics(Math.min(0.1, remaining), 0);
          }
          const theirs = legacy.diver();
          const state = freezeDiveState({
            ...base,
            depthM: metres(position.d),
            maxDepthM: metres(position.d),
            verticalVelocityMpm: velocity,
            bcdGasSurfaceLiters: bcd,
          });
          const ours = integrateBuoyancy(state, { site: wreck, xM: position.x, displacementM: 0 }, frameS);
          frames.compared += 1;
          if (freed) frames.stopped += 1;
          if (!close(ours.depthM, theirs.d) || !close(ours.verticalVelocityMpm, theirs.verticalVelocity) || !close(ours.xM ?? Number.NaN, theirs.x)) {
            frames.mismatches.push(`(${position.x}, ${position.d}) at ${velocity} m/min for ${frameS} s: ${ours.depthM}/${ours.xM} vs ${theirs.d}/${theirs.x}`);
          }
        }
      }
    }
    expect(frames.compared).toBeGreaterThan(20_000);
    expect(frames.stopped).toBeGreaterThan(500);
    expect(frames.mismatches.slice(0, 5), `${frames.mismatches.length} mismatches`).toEqual([]);
  });
});
