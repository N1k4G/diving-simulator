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
