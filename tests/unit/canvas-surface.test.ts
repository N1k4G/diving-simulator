import { afterEach, describe, expect, it, vi } from "vitest";

import type { PresentationState } from "../../src/presentation/presentation-state";
import { CanvasReferenceAdapter } from "../../src/render/canvas-reference-adapter";
import type { WreckSceneState } from "../../src/render/renderer";
import { SKY_BANDS, SURFACE_WAVES, skyBandColour, waveSlideM } from "../../src/render/surface-view";

// The development canvas renderer's surface (#222): the sky and the two
// waves the Pixi scene draws (render/surface-view.ts), so the two renderers
// can be compared at the start and the end of a dive.

type Call = readonly [string, ...unknown[]];

/**
 * A Canvas 2D context that records its calls, and the style each fill and
 * stroke was made in. Node has no canvas, so the adapter draws into this.
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
        if (key === "fill" || key === "fillRect") {
          calls.push([key, target.fillStyle, ...args]);
        } else if (key === "stroke") {
          calls.push([key, target.strokeStyle, target.lineWidth]);
        } else {
          calls.push([key, ...args]);
        }
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

// 1160 px across shows 58 m, so 20 px a metre, and 600 px down shows 30 m.
// The diver at the surface, 20 m along the route, faces right: the camera's
// 8 m lead is held at 29 m by the scene's left bound, and its depth at 9 m by
// the six metres of sky above the surface. World (x, d) is on screen at
// ((x - 29) * 20 + 580, (d - 9) * 20 + 300).
const scene = (elapsedRealS: number): WreckSceneState => ({
  routePositionM: 20,
  diverDepthM: 0,
  elapsedRealS,
  facing: 1,
  torchOn: false,
  zone: "exterior",
  shark: null,
});
const presentation = {} as PresentationState;
const screenX = (x: number) => (x - 29) * 20 + 580;
const screenY = (d: number) => (d - 9) * 20 + 300;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the canvas comparison renderer's surface (#222)", () => {
  it("draws legacy's sky above the surface: its high colour, then six one-metre bands to the horizon", async () => {
    const { adapter, calls } = await mountedAdapter();
    adapter.render(presentation, scene(0));
    // The first fillRect is the water's background.
    const sky = calls.filter(([name]) => name === "fillRect").slice(1, 2 + SKY_BANDS);

    // Each reaches half a metre under the next, so no seam shows between
    // them; what is left of each is Pixi's one-metre band.
    expect(sky).toHaveLength(1 + SKY_BANDS);
    expect(sky[0]).toEqual(["fillRect", "rgba(196,230,240,1)", screenX(-60), screenY(-200), 240 * 20, 194.5 * 20]);
    expect(sky[1]).toEqual(["fillRect", "rgba(191,227,238,1)", screenX(-60), screenY(-6), 240 * 20, 1.5 * 20]);
    expect(sky.at(-1)).toEqual(["fillRect", "rgba(136,192,213,1)", screenX(-60), screenY(-1), 240 * 20, 20]);
    expect(screenY(-6)).toBe(0);
  });

  it("ends one sky fill on the surface, and hides every other fill's bottom edge under the next fill", async () => {
    const { adapter, calls } = await mountedAdapter();
    adapter.render(presentation, scene(0));
    const sky = calls
      .filter(([name]) => name === "fillRect")
      .slice(1, 2 + SKY_BANDS)
      .map(([, , , y, , height]) => ({ top: y as number, bottom: (y as number) + (height as number) }));

    // Canvas antialiases each fill's edge on its own: fills that shared the
    // surface's row would stack their coverage there into a bright line.
    expect(sky.filter(({ bottom }) => bottom === screenY(0))).toEqual([sky.at(-1)]);
    for (let index = 0; index + 1 < sky.length; index += 1) {
      const fill = sky[index];
      const next = sky[index + 1];
      expect(fill?.bottom).toBeGreaterThan((next?.top ?? 0) + 1);
      expect(fill?.bottom).toBeLessThan((next?.bottom ?? 0) - 1);
    }
  });

  it("matches the shared sky's legacy endpoints, #c4e6f0 high up and #83bcd2 at the horizon", () => {
    expect(skyBandColour(-0.5)).toEqual({ r: 0xc4, g: 0xe6, b: 0xf0 });
    expect(skyBandColour(SKY_BANDS - 0.5)).toEqual({ r: 0x83, g: 0xbc, b: 0xd2 });
  });

  it("fills both waves' bands of light water and strokes the first one's bright line, behind the wreck", async () => {
    const { adapter, calls } = await mountedAdapter();
    adapter.render(presentation, scene(0));
    const fills = calls.filter(([name]) => name === "fill");

    expect(fills.slice(0, 3).map(([, style]) => style)).toEqual([
      "rgba(135,206,235,0.18)",
      "rgba(135,206,235,0.18)",
      "#30484a",
    ]);
    expect(calls.filter(([name]) => name === "stroke")[0]).toEqual([
      "stroke",
      "rgba(230,248,255,0.35)",
      0.06 * 20,
    ]);
  });

  it("puts the wave line where the Pixi strip slides it, on the scene's real time", async () => {
    const { adapter, calls } = await mountedAdapter();
    const first = SURFACE_WAVES[0];
    // The first wave's line starts at the span's left edge, x = -60 m.
    const lineStart = (elapsedRealS: number) => {
      calls.length = 0;
      adapter.render(presentation, scene(elapsedRealS));
      return calls.find(([name]) => name === "moveTo");
    };
    const height = -first.amplitudeM * Math.sin((2 * Math.PI * -60) / first.wavelengthM);

    const still = lineStart(0);
    expect(still?.[1]).toBe(screenX(-60));
    expect(still?.[2]).toBeCloseTo(screenY(height), 9);

    // 5 m a second towards -x, its shape carried with it.
    const moved = lineStart(1);
    expect(waveSlideM(first, 1)).toBe(5);
    expect(moved?.[1]).toBeCloseTo(screenX(-65), 9);
    expect(moved?.[2]).toBeCloseTo(screenY(height), 9);
  });
});
