import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  GameController,
  createWreckInitialState,
  type GameFrame,
} from "../../src/app/game-controller";
import { HINT_DONE_KEY, hintOpacity, loadHintStore, type HintId } from "../../src/app/onboarding-hints";
import { keyValuePersistentStore } from "../../src/platform/browser-platform";
import { freezeDiveState, type DiveState } from "../../src/core/dive-state";
import { metres, seconds } from "../../src/core/units";

// The onboarding hints in the controller (#160): legacy's pump and triggers
// at the top of updateDiving(), on the state the previous frame left, in
// real time, stopped with the dive under the help overlay.

const FRAME_MS = 20;
let queue: FrameRequestCallback[] = [];
let nowMs = 0;

beforeEach(() => {
  queue = [];
  nowMs = 0;
  vi.stubGlobal("window", { addEventListener: () => undefined, removeEventListener: () => undefined });
  vi.stubGlobal("ResizeObserver", class {
    observe(): void {}
    disconnect(): void {}
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => queue.push(callback));
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function step(frames: number): void {
  for (let i = 0; i < frames; i += 1) {
    nowMs += FRAME_MS;
    const due = queue;
    queue = [];
    for (const callback of due) callback(nowMs);
  }
}

async function startController(initialState: DiveState, flags: Record<string, string> = {}) {
  const frames: GameFrame[] = [];
  const store = new Map<string, string>(Object.entries(flags));
  const admitted: HintId[] = [];
  const hints = await loadHintStore(keyValuePersistentStore(() => ({
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  })));
  const controller = new GameController({
    renderer: {
      kind: "pixi",
      mount: () => Promise.resolve(),
      render: () => undefined,
      resize: () => undefined,
      destroy: () => undefined,
    },
    onFrame: (frame) => {
      frames.push(frame);
    },
    initialState,
    hintStore: { ...hints, admit: (id) => (admitted.push(id), hints.admit(id)) },
    plannerClient: {
      forecast: () => new Promise(() => undefined),
      dispose: () => undefined,
    } as unknown as ConstructorParameters<typeof GameController>[0]["plannerClient"],
  });
  await controller.start({} as HTMLElement);
  step(1);
  return { controller, frames, store, admitted };
}

/** A dive under way at 3 m, past the BCD hint's 2 m. */
function underWay(): DiveState {
  const state = createWreckInitialState({}, 0x57524543);
  return freezeDiveState({ ...state, depthM: metres(3), maxDepthM: metres(3), elapsedTimeS: seconds(60) });
}

describe("the onboarding hints in the controller (#160)", () => {
  it("shows the BCD hint on the frame after the one that read 3 m, for 6 real seconds, fading over the last half, stopped under the help", async () => {
    const { controller, frames, store, admitted } = await startController(underWay());
    step(1);
    // Queued on this frame, as legacy's triggers run after its pump.
    expect(admitted).toEqual(["bcd"]);
    expect(store.get("diveSim_hint_bcd")).toBe("1");
    expect(frames.at(-1)?.hint).toBeNull();
    step(1);
    // Started by this frame's pump with its 6 s, as legacy draws it at full alpha then.
    expect(frames.at(-1)?.hint).toEqual({ id: "bcd", serial: 1, remainingS: 6 });
    step(1);
    expect(frames.at(-1)?.hint?.remainingS).toBeCloseTo(5.98, 10);

    // The paused dive hands on its last frame, so the hint's time and fade stand still.
    controller.setPaused("help", true);
    step(500);
    expect(frames.at(-1)?.hint?.remainingS).toBeCloseTo(5.98, 10);
    controller.setPaused("help", false);
    // The first frame after the pause runs no time; 288 more of 20 ms leave 0.22 s.
    step(289);
    const fading = frames.at(-1)?.hint;
    expect(fading?.id).toBe("bcd");
    expect(fading?.remainingS).toBeCloseTo(0.22, 10);
    expect(hintOpacity(fading?.remainingS ?? 0)).toBeCloseTo(0.44, 10);
    step(20);
    expect(frames.at(-1)?.hint).toBeNull();
    expect(admitted).toEqual(["bcd"]);
    controller.destroy();
  });

  it("drops the hint showing and every later one once dismissed", async () => {
    const { controller, frames, store } = await startController(underWay());
    step(2);
    expect(frames.at(-1)?.hint?.id).toBe("bcd");
    controller.dismissHints();
    expect(frames.at(-1)?.hint).toBeNull();
    expect(store.get(HINT_DONE_KEY)).toBe("1");
    controller.destroy();

    // The next dive reads the flags as it starts (#137 A4a).
    const next = await startController(underWay(), { [HINT_DONE_KEY]: "1" });
    step(400);
    expect(next.frames.every((frame) => frame.hint === null)).toBe(true);
    next.controller.destroy();
  });

  it("reads nothing while the dive waits at the surface, as legacy's 'surface' state runs no updateDiving()", async () => {
    const { controller, frames, admitted } = await startController(createWreckInitialState({}, 0x57524543));
    step(100);
    expect(admitted).toEqual([]);
    expect(frames.every((frame) => frame.hint === null)).toBe(true);
    controller.destroy();
  });
});
