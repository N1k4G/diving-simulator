import { describe, expect, it } from "vitest";

import { DEFAULT_GF_HIGH_PERCENT, decoStopDepth } from "../core/decompression";
import { DiveModel, frameNdlMinutes } from "../core/dive-model";
import {
  createGasMix,
  createInitialDiveState,
  createTankState,
  freezeDiveState,
  type DiveState,
} from "../core/dive-state";
import { metres, seconds } from "../core/units";
import { translate } from "./i18n/catalog";
import {
  HINT_DISPLAY_S,
  HINT_DONE_KEY,
  HINT_IDS,
  HINT_MESSAGES,
  HINT_STORAGE_PREFIX,
  NO_HINTS,
  clearHints,
  createHintStore,
  hintConditions,
  hintTriggered,
  stepHints,
  visibleHint,
  type HintConditions,
  type HintId,
  type HintsState,
} from "./onboarding-hints";

// The onboarding hints (#160): ports of legacy's #38 harness cases
// (src/diving-simulator-tests.html TC-38-*), on the pure triggers and pump.

const FRAME_S = 0.033;
const QUIET: HintConditions = {
  depthM: 0,
  ndlMin: 999,
  decoStopDepthM: 0,
  safetyStopNeeded: false,
  inOverhead: false,
  currentActive: false,
};

function storage(): Map<string, string> & { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void } {
  const map = new Map<string, string>();
  return Object.assign(map, {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  });
}

/** Pending or shown, as the legacy cases count them. */
const pending = (state: HintsState) => state.queue.length + (state.shown ? 1 : 0);

function frame(state: HintsState, conditions: Partial<HintConditions>, admit: (id: HintId) => boolean = () => true, fastForward = false): HintsState {
  return stepHints(state, { elapsedRealS: FRAME_S, fastForward, conditions: { ...QUIET, ...conditions } }, admit);
}

const air = createGasMix(0.21, 0);
function diver(depthM: number): DiveModel {
  const base = createInitialDiveState(9, { tanks: [createTankState(air, 12, 200)] });
  return new DiveModel(freezeDiveState({ ...base, depthM: metres(depthM), maxDepthM: metres(depthM) }));
}

/** Holds the depth one dive second at a time until `id` fires, or `limitS` passes. */
function holdUntilFired(model: DiveModel, depthM: number, id: HintId, limitS: number): { state: DiveState; before: DiveState; hints: HintsState } | null {
  let hints = NO_HINTS;
  let before = model.snapshot;
  for (let second = 0; second < limitS; second += 1) {
    const state = model.snapshot;
    hints = stepHints(hints, { elapsedRealS: FRAME_S, fastForward: false, conditions: hintConditions(state, DEFAULT_GF_HIGH_PERCENT, false) }, () => true);
    if (hints.fired.includes(id)) return { state, before, hints };
    before = state;
    model.advance({ depthM: metres(depthM) }, seconds(1));
  }
  return null;
}

describe("the onboarding hints' triggers (#38)", () => {
  it("fires the BCD hint once, the first frame deeper than 2 m (TC-38-BCD-FIRST-DEPTH-QUEUES-HINT)", () => {
    let state = frame(NO_HINTS, { depthM: 0 });
    state = frame(state, { depthM: 2 });
    expect(state.fired).toEqual([]);
    state = frame(state, { depthM: 3 });
    expect(state.fired).toEqual(["bcd"]);
    expect(pending(state)).toBe(1);
    state = frame(state, { depthM: 3 });
    state = frame(state, { depthM: 1 });
    state = frame(state, { depthM: 3 });
    expect(pending(state)).toBe(1);
  });

  it("fires the NDL hint below 10 minutes deeper than 2 m, never at an NDL of 0", () => {
    const ndl = (depthM: number, ndlMin: number) => hintTriggered("ndl", { ...QUIET, depthM, ndlMin });
    expect([ndl(30, 10), ndl(30, 9.99), ndl(30, 1), ndl(30, 0), ndl(2, 5), ndl(2.1, 5)]).toEqual([false, true, true, false, false, true]);
  });

  it("fires the NDL hint as the model's own NDL drops below 10 min at 30 m (TC-38-NDL-TRIGGER-FIRES-ONCE)", () => {
    const fired = holdUntilFired(diver(30), 30, "ndl", 60 * 60);
    expect(fired).not.toBeNull();
    // On the state the frame starts from: legacy's frameCalc.ndl of the previous tick.
    expect(frameNdlMinutes(fired!.state, DEFAULT_GF_HIGH_PERCENT)).toBeLessThan(10);
    expect(frameNdlMinutes(fired!.before, DEFAULT_GF_HIGH_PERCENT)).toBeGreaterThanOrEqual(10);
    expect(fired!.hints.fired.filter((id) => id === "ndl")).toHaveLength(1);
  });

  it("fires the safety-stop hint once the stop is needed, after 11 m (TC-38-SAFETY-STOP-EDGE-FIRES)", () => {
    const shallow = diver(8);
    shallow.advance({ depthM: metres(8) }, seconds(1));
    expect(hintTriggered("safetyStop", hintConditions(shallow.snapshot, DEFAULT_GF_HIGH_PERCENT, false))).toBe(false);
    const fired = holdUntilFired(diver(15), 15, "safetyStop", 5);
    expect(fired?.state.safetyStop.needed).toBe(true);
  });

  it("fires the deco hint with the first mandatory stop at 40 m (TC-38-DECO-CEILING-EDGE-FIRES)", () => {
    const fired = holdUntilFired(diver(40), 40, "deco", 60 * 60);
    expect(fired).not.toBeNull();
    expect(decoStopDepth(fired!.state.log.lastCeilingM)).toBeGreaterThan(0);
    expect(decoStopDepth(fired!.before.log.lastCeilingM)).toBe(0);
  });

  it("fires the overhead and current hints on their rising edges (TC-38-OVERHEAD-EDGE-FIRES, TC-38-CURRENT-EDGE-FIRES)", () => {
    let state = frame(NO_HINTS, { depthM: 1 });
    expect(state.fired).toEqual([]);
    state = frame(state, { depthM: 1, inOverhead: true });
    expect(state.fired).toEqual(["overhead"]);
    state = frame(state, { depthM: 1, currentActive: true });
    expect(state.fired).toEqual(["overhead", "current"]);
  });

  it("queues the hints that fire on one frame in legacy's order", () => {
    const all: HintConditions = { depthM: 30, ndlMin: 5, decoStopDepthM: 3, safetyStopNeeded: true, inOverhead: true, currentActive: true };
    const state = frame(NO_HINTS, all);
    expect(state.queue).toEqual(HINT_IDS);
    expect(state.shown).toBeNull();
    expect(frame(state, all).shown?.id).toBe("bcd");
  });
});

describe("the onboarding hints' pump and store (#38)", () => {
  it("shows a hint for 6 real seconds, then the next (TC-38-HINT-TIMER-COUNTDOWN)", () => {
    let state: HintsState = { ...NO_HINTS, queue: ["bcd", "deco"] };
    state = frame(state, {});
    expect(state.shown).toEqual({ id: "bcd", serial: 1, remainingS: HINT_DISPLAY_S });
    state = stepHints(state, { elapsedRealS: HINT_DISPLAY_S - 0.5, fastForward: false, conditions: QUIET }, () => true);
    expect(state.shown?.id).toBe("bcd");
    state = stepHints(state, { elapsedRealS: 0.5, fastForward: false, conditions: QUIET }, () => true);
    expect(state.shown).toEqual({ id: "deco", serial: 2, remainingS: HINT_DISPLAY_S });
    for (let i = 0; i < 50; i += 1) state = stepHints(state, { elapsedRealS: 0.5, fastForward: false, conditions: QUIET }, () => true);
    expect(state.shown).toBeNull();
  });

  it("starts none while fast-forwarding, and keeps it queued (TC-38-NO-HINT-DURING-FAST-FORWARD)", () => {
    let state: HintsState = { ...NO_HINTS, queue: ["bcd"] };
    state = frame(state, {}, undefined, true);
    expect(state.shown).toBeNull();
    expect(state.queue).toEqual(["bcd"]);
    state = frame(state, {});
    expect(state.shown?.id).toBe("bcd");
    expect(state.queue).toEqual([]);
    // One already showing runs on under a fast-forward.
    expect(frame(state, {}, undefined, true).shown?.id).toBe("bcd");
  });

  it("draws none under the help, the gas information or a fast-forward (TC-38-HINT-HIDDEN-DURING-FAST-FORWARD-AND-INFOPAGE)", () => {
    const none = { help: false, gasInfo: false, fastForward: false };
    expect(visibleHint("bcd", none)).toBe("bcd");
    expect(visibleHint("bcd", { ...none, help: true })).toBeNull();
    expect(visibleHint("bcd", { ...none, gasInfo: true })).toBeNull();
    expect(visibleHint("bcd", { ...none, fastForward: true })).toBeNull();
  });

  it("remembers a hint in legacy's key once queued, so the next dive does not show it (TC-38-LOCALSTORAGE-SUPPRESSES-REPEAT)", () => {
    const store = storage();
    const hints = createHintStore(() => store);
    let state = frame(NO_HINTS, { depthM: 3 }, hints.admit);
    expect(store.get(`${HINT_STORAGE_PREFIX}bcd`)).toBe("1");
    expect(pending(state)).toBe(1);
    // The next dive: its triggers fire again, and are not queued.
    state = frame(NO_HINTS, { depthM: 3 }, hints.admit);
    expect(state.fired).toEqual(["bcd"]);
    expect(pending(state)).toBe(0);
  });

  it("shows none once dismissed, in this dive and the next (TC-38-DISMISS-SURVIVES-RESETDIVE)", () => {
    const store = storage();
    const hints = createHintStore(() => store);
    const shown = frame(frame(NO_HINTS, { depthM: 30, ndlMin: 5 }, hints.admit), { depthM: 30 }, hints.admit);
    expect(pending(shown)).toBe(2);
    hints.dismiss();
    const cleared = clearHints(shown);
    expect(pending(cleared)).toBe(0);
    expect(cleared.fired).toEqual(shown.fired);
    expect(store.get(HINT_DONE_KEY)).toBe("1");
    expect(hints.dismissed()).toBe(true);
    expect(pending(frame(NO_HINTS, { depthM: 3, inOverhead: true }, hints.admit))).toBe(0);
  });

  it("shows each hint once per dive when storage fails", () => {
    const hints = createHintStore(() => {
      throw new Error("SecurityError");
    });
    expect(hints.dismissed()).toBe(false);
    expect(() => hints.dismiss()).not.toThrow();
    let state = frame(NO_HINTS, { depthM: 3 }, hints.admit);
    state = frame(state, { depthM: 3 }, hints.admit);
    expect(pending(state)).toBe(1);
  });

  it("words every hint as legacy does, in both languages", () => {
    expect(translate("en", HINT_MESSAGES.bcd)).toBe("W/S control BCD buoyancy — short bursts, then trim out");
    expect(translate("de", HINT_MESSAGES.bcd)).toBe("W/S steuern die Tarierweste — kurze Stöße, dann austrimmen");
    expect(translate("en", HINT_MESSAGES.safetyStop)).toBe("Safety stop: hold 3–5 min between 2.4–8.3m, F = fast-forward");
    expect(translate("de", HINT_MESSAGES.deco)).toBe("Deko-Ceiling: nicht über die CEIL-Tiefe aufsteigen!");
    expect(translate("de", "hint.dismiss")).toBe("Hinweise nicht mehr anzeigen");
  });
});
