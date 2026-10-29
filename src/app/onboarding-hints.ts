// The onboarding hints (#160): legacy's contextual hint toasts of #38
// (src/game-loop.js updateDiving, src/state.js showHintOnce).
//
// - Each hint fires on the first frame of a dive whose state meets its
//   condition, once per dive (legacy's hintEdges), and once per browser: the
//   store remembers it when it is queued, as showHintOnce() does.
// - One shows at a time, for HINT_DISPLAY_S real seconds; the rest wait in a
//   queue. None starts while the clock is fast-forwarded.
// - "Don't show hints again" stops them all, in this browser, for good.
//
// The trigger conditions are pure functions of the state the frame starts
// from, as legacy reads them before the frame's physics.
import { decoStopDepth } from "../core/decompression";
import { frameNdlMinutes } from "../core/dive-model";
import type { DiveState } from "../core/dive-state";
import type { PersistentStore } from "../platform/platform-services";
import type { MessageKey } from "./i18n/catalog";

/** Legacy's triggers, in the order updateDiving() checks them. */
export const HINT_IDS = ["bcd", "ndl", "safetyStop", "deco", "overhead", "current"] as const;
export type HintId = (typeof HINT_IDS)[number];

/** src/state.js HINT_DISPLAY_SEC: the real seconds a hint shows for. */
export const HINT_DISPLAY_S = 6;
/** src/renderer.js: the toast fades over its last half second. */
export const HINT_FADE_S = 0.5;
/** HINT_NDL_MIN: the NDL hint fires below 10 minutes. */
export const HINT_NDL_MIN = 10;
/** HINT_BCD_MIN_DEPTH: the BCD and NDL hints wait for 2 m. */
export const HINT_MIN_DEPTH_M = 2;
/** Legacy's own keys, so a hint seen or dismissed in either client stays so. */
export const HINT_STORAGE_PREFIX = "diveSim_hint_";
export const HINT_DONE_KEY = "diveSim_hintsDone";

/** Legacy's hintBcd ... hintCurrent. */
export const HINT_MESSAGES: Readonly<Record<HintId, MessageKey>> = Object.freeze({
  bcd: "hint.bcd",
  ndl: "hint.ndl",
  safetyStop: "hint.safetyStop",
  deco: "hint.deco",
  overhead: "hint.overhead",
  current: "hint.current",
});

/** What the triggers read: the state at the end of the previous frame. */
export interface HintConditions {
  readonly depthM: number;
  /** Legacy's frameCalc.ndl. */
  readonly ndlMin: number;
  /** Legacy's decoStop(frameCalc.ceiling). */
  readonly decoStopDepthM: number;
  readonly safetyStopNeeded: boolean;
  readonly inOverhead: boolean;
  /** Legacy's current.active. This client has no currents yet (#165). */
  readonly currentActive: boolean;
}

export function hintConditions(
  state: DiveState,
  gradientFactorHighPercent: number,
  inOverhead: boolean,
  currentActive = false,
): HintConditions {
  return {
    depthM: state.depthM,
    ndlMin: frameNdlMinutes(state, gradientFactorHighPercent),
    decoStopDepthM: decoStopDepth(state.log.lastCeilingM),
    safetyStopNeeded: state.safetyStop.needed,
    inOverhead,
    currentActive,
  };
}

/** Each trigger's condition, as src/game-loop.js updateDiving() writes it. */
export function hintTriggered(id: HintId, conditions: Readonly<HintConditions>): boolean {
  switch (id) {
    case "bcd":
      return conditions.depthM > HINT_MIN_DEPTH_M;
    // At the surface the NDL is 0, which must not read as "dropping".
    case "ndl":
      return conditions.depthM > HINT_MIN_DEPTH_M && conditions.ndlMin > 0 && conditions.ndlMin < HINT_NDL_MIN;
    case "safetyStop":
      return conditions.safetyStopNeeded;
    case "deco":
      return conditions.decoStopDepthM > 0;
    case "overhead":
      return conditions.inOverhead;
    case "current":
      return conditions.currentActive;
  }
}

export interface ShownHint {
  readonly id: HintId;
  /** Counts each hint shown, so the view can tell one from the next. */
  readonly serial: number;
  readonly remainingS: number;
}

export interface HintsState {
  readonly queue: readonly HintId[];
  readonly shown: ShownHint | null;
  /** Legacy's hintEdges: the triggers that have fired this dive. */
  readonly fired: readonly HintId[];
  readonly serial: number;
}

export const NO_HINTS: HintsState = Object.freeze({ queue: [], shown: null, fired: [], serial: 0 });

export interface HintFrame {
  /** Real seconds, not dive seconds: the toast does not speed up with the clock. */
  readonly elapsedRealS: number;
  readonly fastForward: boolean;
  readonly conditions: Readonly<HintConditions>;
}

/**
 * One frame of legacy's hint pump and triggers, in its order: the shown hint
 * counts down and the next one starts, unless the clock is fast-forwarded;
 * then each trigger that has not fired this dive and whose condition holds
 * fires, and is queued if `admit` lets it (showHintOnce's storage check).
 */
export function stepHints(
  state: Readonly<HintsState>,
  frame: Readonly<HintFrame>,
  admit: (id: HintId) => boolean,
): HintsState {
  let { queue, shown, fired, serial } = state;
  if (shown) {
    const remainingS = shown.remainingS - frame.elapsedRealS;
    shown = remainingS > 0 ? { ...shown, remainingS } : null;
  }
  if (shown === null && queue.length > 0 && !frame.fastForward) {
    serial += 1;
    shown = { id: queue[0] as HintId, serial, remainingS: HINT_DISPLAY_S };
    queue = queue.slice(1);
  }
  for (const id of HINT_IDS) {
    if (!fired.includes(id) && hintTriggered(id, frame.conditions)) {
      if (admit(id)) {
        queue = [...queue, id];
      }
      fired = [...fired, id];
    }
  }
  return { queue, shown, fired, serial };
}

/**
 * The hint on screen: legacy's renderer draws none under the help, the gas
 * information or a fast-forward, though its time runs on under the last two.
 */
export function visibleHint<T>(
  hint: T | null,
  covered: Readonly<{ help: boolean; gasInfo: boolean; fastForward: boolean }>,
): T | null {
  return covered.help || covered.gasInfo || covered.fastForward ? null : hint;
}

/**
 * The toast's opacity: legacy draws it at `min(1, hintNotifyTime / 0.5)`
 * (src/renderer.js drawScene, Issue #38), on the time left after the frame.
 */
export function hintOpacity(remainingS: number): number {
  return Math.min(1, Math.max(0, remainingS) / HINT_FADE_S);
}

/** Legacy's dismissAllHints(): the queued and the shown hint go at once. */
export function clearHints(state: Readonly<HintsState>): HintsState {
  return { ...state, queue: [], shown: null };
}

export interface HintStore {
  /** showHintOnce's check: false once dismissed or seen, else marks it seen. */
  admit(id: HintId): boolean;
  dismissed(): boolean;
  dismiss(): void;
}

/**
 * Legacy's flags in storage, read once as a dive starts and written through
 * (#137 A4a), so a frame asks nothing of the asynchronous store. Storage that
 * cannot be read admits every hint and keeps no flag, which the dive's own
 * record of fired triggers still shows only once per dive, as legacy's does;
 * a flag the store refuses to write is taken back, as legacy's write that
 * throws leaves none.
 */
export async function loadHintStore(store: PersistentStore): Promise<HintStore> {
  const keys = [HINT_DONE_KEY, ...HINT_IDS.map((id) => HINT_STORAGE_PREFIX + id)];
  let flags: Set<string> | null;
  try {
    const values = await Promise.all(keys.map((key) => store.get(key)));
    flags = new Set(keys.filter((_, index) => values[index] === "1"));
  } catch {
    flags = null;
  }
  const raise = (key: string) => {
    if (!flags) {
      // As legacy's: without storage, seen for this dive only, and only the
      // hints queued now go.
      return;
    }
    flags.add(key);
    void store.set(key, "1").catch(() => flags?.delete(key));
  };
  const dismissed = () => flags?.has(HINT_DONE_KEY) ?? false;
  return {
    admit: (id) => {
      const key = HINT_STORAGE_PREFIX + id;
      if (dismissed() || flags?.has(key)) {
        return false;
      }
      raise(key);
      return true;
    },
    dismissed,
    dismiss: () => raise(HINT_DONE_KEY),
  };
}

/** For a controller with no store: no hint is ever shown. */
export const NO_HINT_STORE: HintStore = Object.freeze({
  admit: () => false,
  dismissed: () => true,
  dismiss: () => undefined,
});
