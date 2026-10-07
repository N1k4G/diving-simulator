// Walks the migration client's pre-dive flow: safety gate, then setup screen.
//
// Centralised because the flow gained a step in #158 and will gain more as the
// remaining screens land (#159, #160). Ten call sites spelled the gate click
// out by hand before that, and every one of them would have had to change
// again; now the specs say what they want — a started dive — and this owns how
// many screens stand between the player and it.
//
// The assertion on the setup screen is deliberate. Without it, a regression
// that skipped straight to the dive would make every caller silently pass
// while testing a flow that no longer exists.

const SAFETY_ACCEPT = 'I understand — start simulation';

/** Clicks through the safety gate and leaves the setup screen on screen. */
async function acceptSafetyGate(page) {
  await page.getByRole('button', { name: SAFETY_ACCEPT }).click();
  await page.locator('.setup-screen').waitFor();
}

/**
 * Accepts the gate, optionally configures the setup, and starts the dive.
 *
 * `configure` receives the page after the setup screen is visible, so a spec
 * that cares about a specific gas or site can set one without knowing how the
 * flow is ordered.
 */
async function startDive(page, configure) {
  await acceptSafetyGate(page);
  if (configure) {
    await configure(page);
  }
  await page.locator('[data-start-dive]').click();
}

/** Starts the dive and waits for the Pixi canvas, which most specs want. */
async function startDiveAndWaitForCanvas(page, configure) {
  await startDive(page, configure);
  await page.locator('[data-renderer=pixi] canvas').waitFor();
}

// The dive starts at the surface and waits for S (#199), as legacy's
// 'surface' state does: no clock, no gas, no autosave of a dive under way.
// A spec that needs the dive running begins it the way a player does.

/** Presses S until the dive has begun, then lets go. */
async function beginDescent(page) {
  await page.keyboard.down('s');
  await page.locator('[data-surface-prompt]').waitFor({ state: 'hidden' });
  await page.keyboard.up('s');
}

/**
 * Holds S, venting the BCD, until the HUD reads at least `depthM`, then lets
 * go. Below 0.5 m the dive counts as under water (presentation status
 * "diving"), which is what gates the gas-information pages.
 */
async function descendTo(page, depthM) {
  await page.keyboard.down('s');
  try {
    await page.waitForFunction((target) => {
      const value = document.querySelector('.wreck-hud [data-hud-metric="depth"] dd');
      const depth = Number.parseFloat(String(value?.textContent ?? '').replace(',', '.'));
      return depth >= target;
    }, depthM, { timeout: 60_000 });
  } finally {
    await page.keyboard.up('s');
  }
}

// The same flow driven by a single input modality, end to end.
//
// #158's acceptance is that keyboard-only and touch-only both reach the dive
// with an identical model configuration. The helpers above cannot show that:
// they click, so a "touch" test that tapped one preset still passed through
// the gate and the start button with a mouse, and the claim was never tested
// (caught in review of PR #179). These take the whole flow, so a control that
// only responds to a mouse fails here rather than hiding behind a click.
//
// .tap() requires hasTouch on the browser context, so the touch pair only
// works in a spec that sets it.

async function acceptSafetyGateByTouch(page) {
  await page.getByRole('button', { name: SAFETY_ACCEPT }).tap();
  await page.locator('.setup-screen').waitFor();
}

async function startDiveByTouch(page, configure) {
  await acceptSafetyGateByTouch(page);
  if (configure) {
    await configure(page);
  }
  await page.locator('[data-start-dive]').tap();
}

async function acceptSafetyGateByKeyboard(page) {
  // Focus and Enter rather than a synthetic click: Enter on a focused button
  // is what a keyboard user actually does, and the screen's document-level
  // handler deliberately yields it to the button.
  await page.getByRole('button', { name: SAFETY_ACCEPT }).focus();
  await page.keyboard.press('Enter');
  await page.locator('.setup-screen').waitFor();
}

async function startDiveByKeyboard(page, configure) {
  await acceptSafetyGateByKeyboard(page);
  if (configure) {
    await configure(page);
  }
  await page.locator('[data-start-dive]').focus();
  await page.keyboard.press('Enter');
}

module.exports = {
  SAFETY_ACCEPT,
  acceptSafetyGate,
  acceptSafetyGateByKeyboard,
  acceptSafetyGateByTouch,
  beginDescent,
  descendTo,
  startDive,
  startDiveAndWaitForCanvas,
  startDiveByKeyboard,
  startDiveByTouch,
};
