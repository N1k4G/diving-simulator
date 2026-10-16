import { afterEach, describe, expect, it, vi } from "vitest";

import type { PresentationState } from "../presentation/presentation-state";
import { CanvasReferenceAdapter } from "./canvas-reference-adapter";
import type { SceneShark, WreckSceneState } from "./renderer";
import { SHARK_BOB_M } from "./shark-view";

type Call = readonly [string, ...unknown[]];

/**
 * A Canvas 2D context that records the calls and the fill style each fill
 * was made in. Node has no canvas, so the adapter draws into this.
 */
function recordingContext(): { context: CanvasRenderingContext2D; calls: Call[] } {
  const calls: Call[] = [];
  const state: Record<string, unknown> = {};
  const context = new Proxy(state, {
    get: (target, key) => {
      if (typeof key !== "string") {
        return undefined;
      }
      if (key in target) {
        return target[key];
      }
      if (key === "createLinearGradient") {
        return () => ({ addColorStop: () => undefined });
      }
      return (...args: unknown[]) => {
        calls.push(key === "fill" ? [key, target.fillStyle] : [key, ...args]);
      };
    },
    set: (target, key, value) => {
      target[key as string] = value;
      return true;
    },
  });
  return { context: context as unknown as CanvasRenderingContext2D, calls };
}

async function mountedAdapter(): Promise<{ adapter: CanvasReferenceAdapter; calls: Call[] }> {
  const { context, calls } = recordingContext();
  vi.stubGlobal("window", { devicePixelRatio: 1 });
  vi.stubGlobal("document", {
    createElement: () => ({ getContext: () => context, setAttribute: () => undefined, style: {} }),
  });
  const host = {
    dataset: {},
    replaceChildren: () => undefined,
    getBoundingClientRect: () => ({ width: 1160, height: 600 }),
  } as unknown as HTMLElement;
  const adapter = new CanvasReferenceAdapter();
  await adapter.mount(host);
  return { adapter, calls };
}

// 1160 px across shows 58 m, so 20 px a metre. The diver at 20 m along the
// route faces right; the camera's 8 m lead is held at 29 m by the scene's
// left bound, and it follows the diver's 20 m depth.
const scene = (shark: SceneShark | null, elapsedRealS = 10): WreckSceneState => ({
  routePositionM: 20,
  diverDepthM: 20,
  elapsedRealS,
  facing: 1,
  torchOn: false,
  zone: "exterior",
  shark,
});
const presentation = {} as PresentationState;

/** The calls between the shark's save and restore. */
const sharkCalls = (calls: readonly Call[]): Call[] => {
  const start = calls.findIndex(([name]) => name === "save");
  const end = calls.findIndex(([name]) => name === "restore");
  return start === -1 ? [] : calls.slice(start, end + 1);
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the canvas comparison renderer's shark (#246)", () => {
  it("draws none while no shark swims", async () => {
    const { adapter, calls } = await mountedAdapter();
    adapter.render(presentation, scene(null));
    expect(sharkCalls(calls)).toEqual([]);
  });

  it("draws legacy's shark where the model holds it, turned to its heading", async () => {
    const { adapter, calls } = await mountedAdapter();
    adapter.render(presentation, scene({ positionM: 26, depthM: 18, direction: -1 }));
    const drawn = sharkCalls(calls);

    // 6 m right of the camera's focus at 29 m, 2 m above the diver; no bob
    // on the frame it is first drawn.
    expect(drawn[1]).toEqual(["translate", 520, 260]);
    expect(drawn[2]).toEqual(["scale", -20, 20]);
    // Body, dorsal, tail and pectoral fins, then the eye and its pupil.
    expect(drawn.filter(([name]) => name === "fill").map(([, style]) => style)).toEqual([
      "rgba(40,50,60,0.85)",
      "rgba(40,50,60,0.85)",
      "rgba(40,50,60,0.85)",
      "rgba(40,50,60,0.85)",
      "#111",
      "rgba(200,0,0,0.5)",
    ]);
    expect(drawn.filter(([name]) => name === "stroke")).toHaveLength(1);
    expect(drawn.at(-1)).toEqual(["restore"]);
  });

  it("bobs on a phase of 3 a real second from when it is first drawn, and restarts it", async () => {
    const { adapter, calls } = await mountedAdapter();
    const shark = { positionM: 26, depthM: 18, direction: 1 } as const;
    adapter.render(presentation, scene(shark, 10));
    calls.length = 0;
    adapter.render(presentation, scene(shark, 10.5));
    const [, translate] = sharkCalls(calls);
    expect(translate?.[1]).toBe(520);
    expect(translate?.[2]).toBeCloseTo(260 + Math.sin(1.5) * SHARK_BOB_M * 20, 9);
    expect(sharkCalls(calls)[2]).toEqual(["scale", 20, 20]);

    adapter.render(presentation, scene(null, 11));
    calls.length = 0;
    adapter.render(presentation, scene(shark, 12));
    expect(sharkCalls(calls)[1]).toEqual(["translate", 520, 260]);
  });
});
