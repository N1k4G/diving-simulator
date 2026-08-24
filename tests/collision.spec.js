// ============================================================
// FILE: tests/collision.spec.js
// PURPOSE: Issue #122 — the diver has a body, not a point.
//
// solidAt() is a point-in-AABB test and both movement call sites passed the
// diver's centre, so movement only stopped once the CENTRE reached a wall and
// the sprite had already penetrated about a metre. Closed issue #101 ("rock
// hitboxes feel off — collision triggers noticeably before/after the diver
// visually touches") is the same defect seen from the player's side.
//
// Three properties are asserted here, and the third is the one that keeps the
// game playable: giving the diver an extent narrows every authored passage, so
// a hull that is too generous silently walls off routes the sites expect to be
// swimmable. That is a worse bug than the one being fixed.
// ============================================================

const { test, expect } = require('@playwright/test');

async function bootGame(page) {
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.dismiss().catch(() => {}));
  await page.goto('/src/diving-simulator.html');
  await page.waitForFunction(() => !!window.gameAPI, { timeout: 15000 });
  return errors;
}

test('the diver blocks on its body, not its centre', async ({ page }) => {
  const errors = await bootGame(page);

  const probes = await page.evaluate(() => {
    const A = window.gameAPI;
    A.diveSite = 'wreck';
    const halfW = A.DIVER_HALF_WIDTH_M;
    // Bow stem AABB is x=14..16, d=28..66. Approaching from the right, the
    // diver's left flank meets x=16 before its centre does.
    const d = 33.8;
    return {
      halfW,
      atCentreContact: A.diverSolidAt(16 + halfW + 0.05, d),
      atBodyContact: A.diverSolidAt(16 + halfW - 0.05, d),
      // The improvement, stated where the two tests disagree: at x=16.2 the
      // centre is past the wall (open water by the point test) while the
      // diver's left flank is still 0.25 m inside it.
      centrePointSaysClear: A.solidAt(16.2, d),
      bodySaysBlocked: A.diverSolidAt(16.2, d),
    };
  });

  expect(probes.halfW).toBeGreaterThan(0);
  // Just outside body contact: free. Just inside: blocked.
  expect(probes.atCentreContact).toBe(false);
  expect(probes.atBodyContact).toBe(true);
  // The regression case: point test and body test must disagree here, which is
  // the whole difference between penetrating a hull and stopping at it.
  expect(probes.centrePointSaysClear).toBe(false);
  expect(probes.bodySaysBlocked).toBe(true);
  expect(errors).toEqual([]);
});

test('a diver already overlapping a structure can swim free', async ({ page }) => {
  // With a point test an overlap was unreachable — the centre could not be
  // inside a wall without the diver being inside it. An extent makes overlap
  // reachable (a restored save, a site switch), so both movement axes need the
  // "only block when crossing from open water INTO solid" escape. The
  // horizontal path never had it.
  const errors = await bootGame(page);

  const escape = await page.evaluate(async () => {
    const A = window.gameAPI;
    A.diveSite = 'wreck';
    // Park the diver overlapping the bow stem (x=14..16, d=28..66).
    const startX = 15.5, startD = 40;
    const overlappingAtStart = A.diverSolidAt(startX, startD);

    const run = kickDir => {
      diverX = startX; depth = startD;
      horizontalVelocity = 0; verticalVelocity = 0;
      for (let i = 0; i < 300; i += 1) updateHorizontalPhysics(1 / 60, kickDir);
      return +diverX.toFixed(2);
    };
    const right = run(1);
    const left = run(-1);

    return { overlappingAtStart, startX, right, left };
  });

  expect(escape.overlappingAtStart, 'probe must actually start inside a structure').toBe(true);
  // Free in at least one horizontal direction — not pinned in place.
  const moved = Math.abs(escape.right - escape.startX) > 0.5 || Math.abs(escape.left - escape.startX) > 0.5;
  expect(moved, `stuck: right=${escape.right} left=${escape.left} from ${escape.startX}`).toBe(true);
  expect(errors).toEqual([]);
});

test('vertical extent blocks where the centre is clear', async ({ page }) => {
  // Every other probe here approaches a VERTICAL wall, so it exercises
  // DIVER_HALF_WIDTH_M only. Setting DIVER_HALF_HEIGHT_M to 0 used to pass the
  // whole file: the passability assertion only requires the height to be
  // SMALLER than a doorway, and zero is smaller.
  const errors = await bootGame(page);

  const probe = await page.evaluate(() => {
    const A = window.gameAPI;
    A.diveSite = 'wreck';
    const halfH = A.DIVER_HALF_HEIGHT_M;
    // Vehicle-deck floor is a horizontal slab at d=39..40, x=14..78. Just above
    // it the centre is in open water while the diver's underside is not.
    const x = 50, d = 39 - halfH / 2;
    return {
      halfH,
      centreClear: A.solidAt(x, d),
      bodyBlocked: A.diverSolidAt(x, d),
      // Well clear of the slab, both must agree it is open water.
      farAboveCentre: A.solidAt(x, 39 - halfH - 1),
      farAboveBody: A.diverSolidAt(x, 39 - halfH - 1),
    };
  });

  expect(probe.halfH, 'the diver must have a vertical extent at all').toBeGreaterThan(0);
  expect(probe.centreClear, 'centre should be above the deck').toBe(false);
  expect(probe.bodyBlocked, 'underside should be inside the deck').toBe(true);
  expect(probe.farAboveCentre).toBe(false);
  expect(probe.farAboveBody).toBe(false);
  expect(errors).toEqual([]);
});

test('an overlapping diver can escape but cannot travel through', async ({ page }) => {
  // The escape clause has to permit only overlap-REDUCING movement. Permitting
  // any movement while overlapping let the diver cross the whole bow stem from
  // x=16.2 out to x=11, and sink through the 39..40 m deck from d=38.8 to
  // d=43.7 — turning a stuck-diver guard into a noclip.
  const errors = await bootGame(page);

  const result = await page.evaluate(() => {
    const A = window.gameAPI;
    A.diveSite = 'wreck';

    // Horizontal: start with the body overlapping the bow stem (x=14..16).
    const startX = 16.2, startD = 33.8;
    const runH = dir => {
      diverX = startX; depth = startD;
      horizontalVelocity = 0; verticalVelocity = 0;
      for (let i = 0; i < 600; i += 1) updateHorizontalPhysics(1 / 60, dir);
      return +diverX.toFixed(3);
    };
    const outward = runH(1);
    const inward = runH(-1);

    // Vertical: rest the body 0.1 m inside the deck slab and let go.
    diverX = 50; depth = 38.8;
    verticalVelocity = 0; horizontalVelocity = 0;
    const sank = (() => {
      for (let i = 0; i < 900; i += 1) updateBuoyancyPhysics(1 / 60);
      return +depth.toFixed(3);
    })();

    return {
      startX, startOverlapping: A.diverSolidAt(startX, startD),
      outward, inward,
      stemFarSide: 14,
      deckStartOverlapping: A.diverSolidAt(50, 38.8),
      sank, deckBottom: 40,
    };
  });

  expect(result.startOverlapping, 'probe must start overlapping').toBe(true);
  // Escape outward still works.
  expect(result.outward).toBeGreaterThan(result.startX + 0.5);
  // But the far side of the structure is unreachable.
  expect(
    result.inward,
    `travelled through the stem to x=${result.inward}`
  ).toBeGreaterThan(result.stemFarSide);

  expect(result.deckStartOverlapping, 'deck probe must start overlapping').toBe(true);
  expect(
    result.sank,
    `sank through the deck to d=${result.sank}`
  ).toBeLessThan(result.deckBottom);
  expect(errors).toEqual([]);
});

test('a fully engulfed diver is not pinned by floating-point noise', async ({ page }) => {
  // The flat-gradient allowance only works if "no change" is recognised as no
  // change. A fully engulfed diver has a mathematically CONSTANT buried area
  // whichever way it moves, but constant does not mean bitwise equal: at wreck
  // (15.5, 63.7) adjacent depths sample as 0.539999999999994 and
  // 0.5400000000000005, so an exact `>` reads flat as "deeper" and pins the
  // diver at d=63.706328 with zero velocity, still inside the hull.
  //
  // Coordinate-dependent, so it cannot be caught by testing one spot with a
  // strict comparison and calling it fine.
  const errors = await bootGame(page);

  const result = await page.evaluate(() => {
    const A = window.gameAPI;
    A.diveSite = 'wreck';
    const X = 15.5, D = 63.7;   // deep inside the bow stem, x=14..16, d=28..66

    const areas = [D - 0.001, D, D + 0.001].map(d => A.diverOverlapArea(X, d));

    const run = fn => {
      diverX = X; depth = D; verticalVelocity = 0; horizontalVelocity = 0;
      for (let i = 0; i < 900; i += 1) fn();
      return { x: diverX, d: depth };
    };
    const vertical = run(() => updateBuoyancyPhysics(1 / 60));
    const right = run(() => updateHorizontalPhysics(1 / 60, 1));
    const left = run(() => updateHorizontalPhysics(1 / 60, -1));

    return {
      X, D, areas, engulfed: A.diverSolidAt(X, D),
      verticalTravel: Math.abs(vertical.d - D),
      rightTravel: Math.abs(right.x - X),
      leftTravel: Math.abs(left.x - X),
    };
  });

  expect(result.engulfed, 'probe must start fully engulfed').toBe(true);

  // The premise: mathematically equal, not bitwise equal. If these ever become
  // bitwise identical the test still passes, but it stops proving anything —
  // so assert the premise rather than assume it.
  const spread = Math.max(...result.areas) - Math.min(...result.areas);
  expect(spread, 'adjacent samples should differ only by float noise').toBeLessThan(1e-9);

  // Movement, not paralysis. Without the tolerance the vertical case travels
  // 0.006 m in 900 ticks; with it, about a metre.
  expect(
    result.verticalTravel,
    `pinned vertically: moved ${result.verticalTravel} m in 900 ticks`
  ).toBeGreaterThan(0.1);
  expect(Math.max(result.rightTravel, result.leftTravel)).toBeGreaterThan(0.5);
  expect(errors).toEqual([]);
});

test('an engulfed diver is pushed out before physics runs', async ({ page }) => {
  // Issue #131. Escaping during movement requires equal-area steps to be legal,
  // because a fully engulfed diver has no strictly reducing step available —
  // and that allowance also let it slide the length of a slab at constant
  // depth. Resolving the overlap up front makes the engulfed state transient,
  // so there is nowhere to slide from.
  const errors = await bootGame(page);

  const result = await page.evaluate(() => {
    const A = window.gameAPI;
    A.diveSite = 'wreck';

    // Deep inside the vehicle-deck floor slab (x=14..78, d=39..40). The nearest
    // way out is vertical: 0.2 m up beats 44 m sideways.
    const startX = 46, startD = 39.5;
    diverX = startX; depth = startD;
    horizontalVelocity = 0; verticalVelocity = 0;
    const engulfedBefore = A.diverSolidAt(diverX, depth);

    // Drive the REAL dive tick, not resolveDiverOverlap() directly — otherwise
    // this passes just as happily with the call removed from the loop, which is
    // the wiring the fix actually depends on.
    gameState = 'diving';
    updateDiving(1 / 60);
    const after = { x: +diverX.toFixed(3), d: +depth.toFixed(3) };
    const movedOut = after.x !== startX || after.d !== startD;

    return {
      startX, startD, engulfedBefore, movedOut, after,
      stillOverlapping: A.diverSolidAt(diverX, depth),
      overlapArea: A.diverOverlapArea(diverX, depth),
      // Pushed out the near side (up), not dragged the length of the slab.
      horizontalDrift: Math.abs(after.x - startX),
    };
  });

  expect(result.engulfedBefore, 'probe must start engulfed').toBe(true);
  expect(result.movedOut).toBe(true);
  expect(result.stillOverlapping, `still inside at ${JSON.stringify(result.after)}`).toBe(false);
  expect(result.overlapArea).toBe(0);
  // Minimal translation: out through the nearest face, not along the slab.
  expect(result.horizontalDrift, 'should exit vertically, not slide 30m').toBeLessThan(0.01);
  expect(errors).toEqual([]);
});

test('resolving an overlap is a no-op in open water', async ({ page }) => {
  // It runs every dive tick, so it must not nudge a diver who is fine.
  const errors = await bootGame(page);
  const result = await page.evaluate(() => {
    const A = window.gameAPI;
    A.diveSite = 'wreck';
    diverX = 100; depth = 33;   // clear of the wreck structures
    horizontalVelocity = 1.2; verticalVelocity = -0.4;
    const moved = A.resolveDiverOverlap();
    return { moved, x: diverX, d: depth, hv: horizontalVelocity, vv: verticalVelocity };
  });
  expect(result.moved).toBe(false);
  expect(result.x).toBe(100);
  expect(result.d).toBe(33);
  // Velocities untouched, so a normal tick is unaffected.
  expect(result.hv).toBeCloseTo(1.2, 5);
  expect(result.vv).toBeCloseTo(-0.4, 5);
  expect(errors).toEqual([]);
});

test('every authored passage stays navigable with the diver extent applied', async ({ page }) => {
  // The guard against over-correcting. Measured openings before this change:
  // wreck bulkhead doorways 1.5m in depth, mess/cabin door 2.0m in x; cave
  // 5.9m / 6.0m. A hull wider than an opening makes that route impossible.
  const errors = await bootGame(page);

  const result = await page.evaluate(() => {
    const A = window.gameAPI;
    const halfW = A.DIVER_HALF_WIDTH_M;
    const halfH = A.DIVER_HALF_HEIGHT_M;
    const blocked = [];
    const openings = { vertical: [], horizontal: [] };

    for (const site of ['wreck', 'cave']) {
      A.diveSite = site;
      const s = A.activeSite();
      const maxD = s.maxDepth;

      // Vertical openings: open depth runs bounded by solid on both sides.
      for (let x = 10; x <= 175; x += 1) {
        const top = Math.max(0, A.ceilingAt(x));
        const bottom = Math.min(A.floorAt(x), maxD);
        let solidSeen = false, run = 0, runStart = null;
        const runs = [];
        for (let d = top; d <= bottom; d += 0.1) {
          if (A.solidAt(x, d)) { solidSeen = true; if (run > 0) { runs.push([runStart, d - 0.1, run]); run = 0; } }
          else { if (run === 0) runStart = d; run += 0.1; }
        }
        if (!solidSeen) continue;
        for (const [from, to, len] of runs) {
          if (from > top + 0.05 && to < bottom - 0.05 && len < 6) {
            openings.vertical.push(+len.toFixed(2));
            // The diver must fit through the middle of the opening.
            const mid = (from + to) / 2;
            if (A.diverSolidAt(x, mid)) {
              blocked.push(`${site}: ${len.toFixed(2)}m vertical opening at x=${x} (d ${from.toFixed(1)}…${to.toFixed(1)}) no longer admits the diver`);
            }
          }
        }
      }

      // Horizontal openings: open x runs bounded by solid on both sides.
      for (let d = 1; d <= Math.min(maxD, 105); d += 1) {
        let solidSeen = false, run = 0, runStart = null;
        const runs = [];
        for (let x = 0; x <= 200; x += 0.1) {
          const inBounds = d >= A.ceilingAt(x) && d <= A.floorAt(x);
          if (!inBounds || A.solidAt(x, d)) { if (A.solidAt(x, d)) solidSeen = true; if (run > 0) { runs.push([runStart, x - 0.1, run]); run = 0; } }
          else { if (run === 0) runStart = x; run += 0.1; }
        }
        if (!solidSeen) continue;
        for (const [from, to, len] of runs) {
          if (len < 6) {
            openings.horizontal.push(+len.toFixed(2));
            const mid = (from + to) / 2;
            if (A.diverSolidAt(mid, d)) {
              blocked.push(`${site}: ${len.toFixed(2)}m horizontal opening at d=${d} (x ${from.toFixed(1)}…${to.toFixed(1)}) no longer admits the diver`);
            }
          }
        }
      }
    }

    return {
      blocked,
      halfW, halfH,
      tightestVertical: Math.min(...openings.vertical),
      tightestHorizontal: Math.min(...openings.horizontal),
      verticalCount: openings.vertical.length,
      horizontalCount: openings.horizontal.length,
    };
  });

  // Guard the sweep itself: if it stopped finding openings, it would pass
  // vacuously however wide the hull got.
  expect(result.verticalCount, 'sweep must find the bulkhead doorways').toBeGreaterThan(100);
  expect(result.horizontalCount, 'sweep must find the horizontal door gaps').toBeGreaterThan(0);

  // The hull must be strictly smaller than the tightest opening on each axis,
  // stated against the measured geometry rather than against a copied number.
  expect(result.halfH * 2).toBeLessThan(result.tightestVertical);
  expect(result.halfW * 2).toBeLessThan(result.tightestHorizontal);

  expect(result.blocked, result.blocked.join('\n')).toEqual([]);
  expect(errors).toEqual([]);
});
