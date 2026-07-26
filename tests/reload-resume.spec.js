// ============================================================
// FILE: tests/reload-resume.spec.js
// PURPOSE: Real-browser save/reload/resume coverage for the drill
//          persistence fixes (issue #45/#66, PR #102 review follow-up).
//
// Why a separate file from game.spec.js / smoke.spec.js: the existing
// drill-persistence regression tests in diving-simulator-tests.html call
// resetDive() in the same page to simulate "a reload" — that never
// exercises the actual browser bootstrap path (loadSavedDive() running at
// script-load time, performance.now() genuinely resetting to 0, the
// pending-resume banner, or a real localStorage read after a fresh
// navigation). These tests use an actual page.reload() so the real
// resume path is what's under test, not a same-page simulation of it.
// ============================================================

const { test, expect } = require('@playwright/test');

async function bootGame(page) {
  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', err => consoleErrors.push(err.message));
  page.on('dialog', d => d.dismiss().catch(() => {}));

  await page.goto('/src/diving-simulator.html');
  await page.waitForFunction(() => !!window.gameAPI, { timeout: 15000 });
  return consoleErrors;
}

async function reachDivingUnderwater(page, targetDepth = 20) {
  await page.evaluate(() => window.gameAPI.startDiveAction());
  await page.waitForFunction(() => window.gameAPI.gameState === 'surface', { timeout: 5000 });
  await page.keyboard.down('s');
  await page.waitForFunction(() => window.gameAPI.gameState === 'diving', { timeout: 5000 });
  await page.keyboard.up('s');
  await page.evaluate(d => window.gameAPI.setDepth(d), targetDepth);
  await page.waitForFunction(d => window.gameAPI.depth >= d - 0.1, targetDepth, { timeout: 3000 });
}

// Reload, then wait for the fresh page's own bootstrap to finish reading
// localStorage (loadSavedDive() runs synchronously at script-load time, so
// by the time window.gameAPI exists the pending-resume state is already
// settled — no extra wait needed beyond the standard gameAPI-ready check).
async function reload(page) {
  await page.reload();
  await page.waitForFunction(() => !!window.gameAPI, { timeout: 15000 });
}

test.setTimeout(30000);

// -----------------------------------------------------------------
// 1. Free-flow decision overlay: save mid-overlay, real reload, resume,
//    the option must still be resolvable (the original #45/#66 blocker
//    repro, now verified across an actual browser navigation).
// -----------------------------------------------------------------
test('reload: free-flow overlay save survives a real reload and stays resolvable', async ({ page }) => {
  const consoleErrors = await bootGame(page);
  await reachDivingUnderwater(page, 20);

  await page.evaluate(() => {
    window.gameAPI.drillsEnabled = true;
    window.gameAPI.forceDrill('freeflow');
    window.gameAPI.drillState.phase = 'overlay';
    window.gameAPI.gameState = 'drill';
    window.saveDiveState();
  });

  await reload(page);

  const pending = await page.evaluate(() => window.gameAPI.pendingResumeDive !== null);
  expect(pending, 'a genuine mid-overlay save must not be discarded on reload').toBe(true);

  await page.evaluate(() => window.gameAPI.resumeSavedDive());

  const state = await page.evaluate(() => ({
    gameState: window.gameAPI.gameState,
    phase: window.gameAPI.drillState.phase,
    id: window.gameAPI.drillState.id,
  }));
  expect(state.gameState).toBe('drill');
  expect(state.phase).toBe('overlay');
  expect(state.id).toBe('freeflow');

  const resolved = await page.evaluate(() => window.gameAPI.resolveDrillOption(0));
  expect(resolved, 'resolveDrillOption() must succeed after a real reload — false is the stuck-forever bug').toBe(true);

  expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
});

// -----------------------------------------------------------------
// 2. lightFailure flicker pre-roll: save mid-flicker, real reload, resume.
//    Tolerates the legitimate flicker->overlay auto-transition if the
//    remaining pre-roll elapses before the assertion runs — the important
//    invariant is that the save survives and the drill stays actionable,
//    not the exact phase at the moment of the check.
// -----------------------------------------------------------------
test('reload: lightFailure flicker save survives a real reload and remains actionable', async ({ page }) => {
  const consoleErrors = await bootGame(page);
  await reachDivingUnderwater(page, 15);

  await page.evaluate(() => {
    window.gameAPI.drillsEnabled = true;
    window.gameAPI.diveSite = 'cave';
    window.gameAPI.inOverhead = true;
    window.gameAPI.torchOn = true;
    window.gameAPI.forceDrill('lightFailure');
    // sanity: forceDrill('lightFailure') always starts in 'flicker'.
    if (window.gameAPI.drillState.phase !== 'flicker') throw new Error('expected flicker phase before saving');
    window.saveDiveState();
  });

  await reload(page);

  const pending = await page.evaluate(() => window.gameAPI.pendingResumeDive !== null);
  expect(pending, 'a genuine mid-flicker save must not be discarded on reload').toBe(true);

  await page.evaluate(() => window.gameAPI.resumeSavedDive());

  const afterResume = await page.evaluate(() => ({
    gameState: window.gameAPI.gameState,
    phase: window.gameAPI.drillState.phase,
    id: window.gameAPI.drillState.id,
  }));
  expect(afterResume.id).toBe('lightFailure');
  expect(['flicker', 'overlay']).toContain(afterResume.phase);
  if (afterResume.phase === 'flicker') {
    expect(afterResume.gameState).toBe('diving');
  } else {
    expect(afterResume.gameState).toBe('drill');
  }

  // Whichever phase it resumed into, the flicker window (max
  // DRILL_LIGHT_FLICKER_SEC, 2s) must elapse into 'overlay' on its own —
  // physics keeps ticking during flicker in the real 'diving' gameState,
  // so no extra input is needed to advance it.
  await page.waitForFunction(() => window.gameAPI.drillState.phase === 'overlay', { timeout: 5000 });
  expect(await page.evaluate(() => window.gameAPI.gameState)).toBe('drill');

  const resolved = await page.evaluate(() => window.gameAPI.resolveDrillOption(0));
  expect(resolved, 'the drill must remain actionable once the overlay opens').toBe(true);

  expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
});

// -----------------------------------------------------------------
// 3. Ongoing free-flow effect: deadline + drain target + the actual
//    consumption multiplier must survive a real reload.
// -----------------------------------------------------------------
test('reload: an ongoing free-flow effect (deadline, drain target, consumption multiplier) survives a real reload', async ({ page }) => {
  const consoleErrors = await bootGame(page);
  await reachDivingUnderwater(page, 20);

  await page.evaluate(() => {
    window.gameAPI.drillsEnabled = true;
    window.gameAPI.forceDrill('freeflow');
    window.gameAPI.drillState.phase = 'overlay';
    window.gameAPI.gameState = 'drill';
    window.gameAPI.resolveDrillOption(0); // correct "breathe through it" -> starts the multiplier
    window.gameAPI.dismissDrillDebrief();
    window.saveDiveState();
  });

  const savedDeadline = await page.evaluate(() => window.gameAPI.drillState.freeflowUntilDiveSec);
  const savedDrainIdx = await page.evaluate(() => window.gameAPI.drillState.freeflowDrainTankIdx);
  expect(savedDeadline).toBeGreaterThan(0);

  await reload(page);
  await page.evaluate(() => window.gameAPI.resumeSavedDive());

  const restored = await page.evaluate(() => ({
    deadline: window.gameAPI.drillState.freeflowUntilDiveSec,
    drainIdx: window.gameAPI.drillState.freeflowDrainTankIdx,
    gameState: window.gameAPI.gameState,
    phase: window.gameAPI.drillState.phase,
  }));
  expect(restored.gameState).toBe('diving');
  expect(restored.phase).toBe('effect');
  expect(Math.abs(restored.deadline - savedDeadline)).toBeLessThan(1e-6);
  expect(restored.drainIdx).toBe(savedDrainIdx);

  // The multiplier must still actually apply post-resume, not just the
  // bookkeeping fields.
  const consumed = await page.evaluate(() => {
    const tank = window.gameAPI.tanks[0];
    const before = tank.gasRemaining;
    window.gameAPI.updateDiving(0.5);
    return before - tank.gasRemaining;
  });
  expect(consumed, `expected elevated free-flow consumption, got ${consumed}L`).toBeGreaterThan(1.0);

  expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
});

// -----------------------------------------------------------------
// 4. An unknown/malformed active drill ID must be rejected outright — it
//    must never be able to recreate the stuck-paused state.
// -----------------------------------------------------------------
test('reload: a payload with an unknown active drill ID is rejected, not resumed', async ({ page }) => {
  const consoleErrors = await bootGame(page);
  await reachDivingUnderwater(page, 20);

  await page.evaluate(() => {
    // Produce a genuine, fully-valid payload first (so every OTHER field
    // is correct), then corrupt just the one field under test.
    window.saveDiveState();
    const raw = localStorage.getItem(window.SAVE_KEY);
    const payload = JSON.parse(raw);
    payload.gameState = 'drill';
    payload.drillState.phase = 'overlay';
    payload.drillState.id = 'not-a-real-drill';
    localStorage.setItem(window.SAVE_KEY, JSON.stringify(payload));
  });

  await reload(page);

  const pending = await page.evaluate(() => window.gameAPI.pendingResumeDive);
  expect(pending, 'a payload with an unrecognized drill id must be rejected, not offered for resume').toBeNull();

  const stillInStorage = await page.evaluate(() => localStorage.getItem(window.SAVE_KEY));
  expect(stillInStorage, 'a rejected save must also be cleared from localStorage').toBeNull();

  // Nothing to resume — game lands cleanly on gas-setup, not stuck anywhere.
  expect(await page.evaluate(() => window.gameAPI.gameState)).toBe('gas-setup');

  expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
});

// -----------------------------------------------------------------
// 5. Save-version policy: a v1-shaped payload (predates the mandatory
//    drillState/drillHasRunThisDive fields) is rejected outright, not
//    silently accepted with missing drill data.
// -----------------------------------------------------------------
test('reload: an old save-version (v1) payload is rejected under the current schema', async ({ page }) => {
  const consoleErrors = await bootGame(page);
  await reachDivingUnderwater(page, 20);

  await page.evaluate(() => {
    window.saveDiveState();
    const raw = localStorage.getItem(window.SAVE_KEY);
    const payload = JSON.parse(raw);
    // Reconstruct a genuine v1 shape: old version tag, no drill fields at
    // all (exactly what a pre-#45/#66-fix save() would have produced).
    payload.saveVersion = 1;
    delete payload.drillState;
    delete payload.drillHasRunThisDive;
    localStorage.setItem(window.SAVE_KEY, JSON.stringify(payload));
  });

  await reload(page);

  const pending = await page.evaluate(() => window.gameAPI.pendingResumeDive);
  expect(pending, 'a v1 payload must be rejected under the v2 schema (explicit-rejection policy)').toBeNull();
  expect(await page.evaluate(() => localStorage.getItem(window.SAVE_KEY))).toBeNull();
  expect(await page.evaluate(() => window.gameAPI.gameState)).toBe('gas-setup');

  expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
});
