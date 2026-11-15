import { describe, expect, it } from "vitest";

// The wreck's engines and its bow visor (#240 PR 4), drawn only. Legacy's
// src/constants.js and src/sites.js are loaded into one Function body, as
// tests/parity/visual-zones loads them, and its drawEngine() and
// drawBowVisor() are read from src/renderer.js, as tests/parity/site-collision
// reads legacy functions, and run on a canvas that records what they draw.
// The scene places both where legacy's site does, in the parts of legacy's
// shapes it draws, and collision reads neither, so the diver passes through
// them where legacy's does.

import constantsSource from "../../src/constants.js?raw";
import rendererSource from "../../src/renderer.js?raw";
import sitesSource from "../../src/sites.js?raw";

import {
  BOW_VISOR_ASSET_ID,
  BOW_VISOR_SHAPE,
  ENGINE_ASSET_ID,
  ENGINE_SHAPE,
  type FeaturePoint,
  type FeatureRect,
} from "../../src/render/wreck-features";
import { LEGACY_M_PER_PX } from "../../src/render/surface-boat";
import { ASSET_MANIFEST } from "../../src/sites/asset-manifest";
import { buildSceneLayers, type Placement } from "../../src/sites/layer-factory";
import { solidAt } from "../../src/sites/site-collision";
import { WRECK_SITE } from "../../src/sites/wreck-site";

interface LegacyFeature {
  readonly kind: string;
  readonly x: number;
  readonly d?: number;
}

interface LegacyApi {
  readonly features: readonly LegacyFeature[];
  solidAt(x: number, d: number): boolean;
}

const legacy = new Function(
  `${constantsSource}
var diveSite = "wreck";
${sitesSource}
return { features: DIVE_SITES.wreck.features, solidAt: solidAt };`,
)() as LegacyApi;

function legacyFunction(source: string, name: string): string {
  const match = new RegExp(`^function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}`, "m").exec(source);
  if (!match) throw new Error(`could not read ${name}() from the legacy source`);
  return match[0];
}

type Call = readonly [name: string, ...args: number[]];

/** Runs a legacy drawing function at (0, 0) on a canvas that records its calls, in pixels. */
function legacyDrawing(name: string): Call[] {
  const calls: Call[] = [];
  const record =
    (call: string) =>
    (...args: number[]): void => {
      calls.push([call, ...args]);
    };
  const context = new Proxy(
    { createLinearGradient: () => ({ addColorStop: () => undefined }) },
    {
      get: (target, key) =>
        key in target ? target[key as keyof typeof target] : record(String(key)),
      set: (_target, key, value) => {
        if (key === "lineWidth") calls.push(["lineWidth", value as number]);
        return true;
      },
    },
  );
  const draw = new Function(`${legacyFunction(rendererSource, name)}\nreturn ${name};`)() as (
    cx: unknown,
    x: number,
    y: number,
  ) => void;
  draw(context, 0, 0);
  return calls;
}

function inPixels(rect: FeatureRect): number[] {
  return [rect.x, rect.y, rect.width, rect.height].map((value) => value / LEGACY_M_PER_PX);
}

function expectCalls(actual: readonly number[], expected: readonly number[], label: string): void {
  expect(actual.length, label).toBe(expected.length);
  actual.forEach((value, index) => expect(value, `${label} [${index}]`).toBeCloseTo(expected[index] ?? NaN, 9));
}

function placementsOf(assetId: string): Placement[] {
  return buildSceneLayers("wreck", {
    qualityTier: "low",
    cullMarginM: 0,
    camera: { leftM: -100, rightM: 300, topM: -100, bottomM: 200 },
  }).flatMap((layer) => layer.placements.filter((placement) => placement.assetId === assetId));
}

describe("the wreck's engines and bow visor, at legacy's places", () => {
  it("places the six engines on the 61 m deck and the visor over the bow opening, where legacy's site does", () => {
    for (const [kind, assetId] of [
      ["engine", ENGINE_ASSET_ID],
      ["bowVisor", BOW_VISOR_ASSET_ID],
    ] as const) {
      expect(ASSET_MANIFEST[kind]?.id).toBe(assetId);
      const expected = legacy.features
        .filter((feature) => feature.kind === kind)
        .map(({ x, d }) => ({ x, d: d ?? 0 }))
        .sort((a, b) => a.d - b.d || a.x - b.x);
      expect(placementsOf(assetId).map(({ x, d }) => ({ x, d })), kind).toEqual(expected);
    }
    expect(placementsOf(ENGINE_ASSET_ID).map(({ x, d }) => [x, d])).toEqual([
      [25, 61], [46, 61], [68, 61], [102, 61], [122, 61], [144, 61],
    ]);
    expect(placementsOf(BOW_VISOR_ASSET_ID).map(({ x, d }) => [x, d])).toEqual([[18, 26]]);
  });

  it("draws legacy's engine block, cylinder heads, risers and side pipes", () => {
    const calls = legacyDrawing("drawEngine");
    const rects = calls.filter(([name]) => name === "fillRect").map(([, ...args]) => args);
    // fillRect order in drawEngine: the block, its trim, then a head and a riser for each cylinder.
    expectCalls(inPixels(ENGINE_SHAPE.block), rects[0] ?? [], "block");
    ENGINE_SHAPE.heads.forEach((head, c) => expectCalls(inPixels(head), rects[2 + 2 * c] ?? [], `head ${c}`));
    ENGINE_SHAPE.risers.forEach((riser, c) => expectCalls(inPixels(riser), rects[3 + 2 * c] ?? [], `riser ${c}`));
    expect(ENGINE_SHAPE.heads).toHaveLength(6);

    // The pipes are the strokes of three points, after the gauges' arcs.
    const paths = calls.filter(([name]) => name === "moveTo" || name === "lineTo").flatMap(([, ...args]) => args);
    const pipes = ENGINE_SHAPE.pipes.flatMap((pipe) => pipe.map(([x, y]) => [x / LEGACY_M_PER_PX, y / LEGACY_M_PER_PX]));
    expectCalls(pipes.flat(), paths, "pipes");
    const widths = calls.filter(([name]) => name === "lineWidth");
    expect(ENGINE_SHAPE.pipeWidth / LEGACY_M_PER_PX).toBeCloseTo(widths[widths.length - 1]?.[1] ?? NaN, 9);

    // 4.4 m wide on the deck it stands on, 3.2 m tall.
    expect(ENGINE_SHAPE.block.y + ENGINE_SHAPE.block.height).toBeCloseTo(0, 12);
    expect(ENGINE_SHAPE.block.width).toBeCloseTo(4.4, 12);
    expect(Math.min(...ENGINE_SHAPE.risers.map((riser) => riser.y))).toBeCloseTo(-3.2, 12);
  });

  it("draws legacy's visor slab, seam and hinge, turned 0.35 pi up about its place", () => {
    const calls = legacyDrawing("drawBowVisor");
    // Turned about the place it is drawn at, before anything is drawn.
    expect(calls.slice(0, 3)).toEqual([["save"], ["translate", 0, 0], ["rotate", BOW_VISOR_SHAPE.rotationRad]]);
    const rects = calls.filter(([name]) => name === "fillRect").map(([, ...args]) => args);
    expectCalls(inPixels(BOW_VISOR_SHAPE.slab), rects[0] ?? [], "slab");
    const seam = calls.filter(([name]) => name === "moveTo" || name === "lineTo").flatMap(([, ...args]) => args);
    const ours = BOW_VISOR_SHAPE.seam.map(([x, y]: FeaturePoint) => [x / LEGACY_M_PER_PX, y / LEGACY_M_PER_PX]);
    expectCalls(ours.flat(), seam, "seam");
    expect(calls.find(([name]) => name === "lineWidth")?.[1]).toBeCloseTo(BOW_VISOR_SHAPE.seamWidth / LEGACY_M_PER_PX, 9);
    const arcs = calls.filter(([name]) => name === "arc");
    const hinge = arcs[arcs.length - 1] ?? [];
    expectCalls(
      [BOW_VISOR_SHAPE.hinge.x, BOW_VISOR_SHAPE.hinge.y, BOW_VISOR_SHAPE.hinge.radius].map((v) => v / LEGACY_M_PER_PX),
      hinge.slice(1, 4) as number[],
      "hinge",
    );
  });
});

describe("drawn only", () => {
  it("leaves where the engines and the visor are drawn open, as legacy's collision does", () => {
    const { block, risers } = ENGINE_SHAPE;
    const top = Math.min(...risers.map((riser) => riser.y));
    const points: [number, number][] = [];
    for (const { x, d } of placementsOf(ENGINE_ASSET_ID)) {
      // Inside the drawn engine, short of the deck it stands on.
      for (let dx = block.x + 0.05; dx < block.x + block.width; dx += 0.25) {
        for (let dy = top + 0.05; dy < -0.01; dy += 0.25) points.push([x + dx, d + dy]);
      }
    }
    const visor = placementsOf(BOW_VISOR_ASSET_ID)[0];
    expect(visor).toBeDefined();
    const { slab, rotationRad } = BOW_VISOR_SHAPE;
    for (let u = slab.x; u <= slab.x + slab.width; u += 0.2) {
      for (let v = slab.y; v <= slab.y + slab.height; v += 0.2) {
        points.push([
          (visor?.x ?? 0) + u * Math.cos(rotationRad) - v * Math.sin(rotationRad),
          (visor?.d ?? 0) + u * Math.sin(rotationRad) + v * Math.cos(rotationRad),
        ]);
      }
    }
    expect(points.length).toBeGreaterThan(1000);
    for (const [x, d] of points) {
      expect(legacy.solidAt(x, d), `legacy at ${x}, ${d}`).toBe(false);
      expect(solidAt(WRECK_SITE, x, d), `${x}, ${d}`).toBe(false);
    }
  });
});
