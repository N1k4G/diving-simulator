import type { PresentationState } from "../presentation/presentation-state";
import { CARGO_HOLD_FROM_M, ENGINE_ROOM_FROM_M } from "../sites/wreck-route";

export const RENDERER_KINDS = ["pixi", "canvas"] as const;

export type RendererKind = (typeof RENDERER_KINDS)[number];

export type WreckZone = "exterior" | "cargo-hold" | "engine-room";

export interface WreckSceneState {
  readonly routePositionM: number;
  readonly diverDepthM: number;
  readonly elapsedRealS: number;
  readonly facing: -1 | 1;
  readonly torchOn: boolean;
  readonly zone: WreckZone;
  /**
   * The shark while one swims (#219), DiveState.shark.encounter: its world
   * position along the route, its depth, and its heading. Null otherwise.
   */
  readonly shark: Readonly<SceneShark> | null;
}

export interface SceneShark {
  readonly positionM: number;
  readonly depthM: number;
  readonly direction: -1 | 1;
}

export interface SceneRenderer {
  readonly kind: RendererKind;
  mount(host: HTMLElement): Promise<void>;
  resize(width: number, height: number, resolution?: number): void;
  render(
    presentation: Readonly<PresentationState>,
    scene: Readonly<WreckSceneState>,
  ): void;
  destroy(): void;
}

export function resolveRendererKind(
  search: string,
  isDevelopment: boolean,
): RendererKind {
  if (!isDevelopment) {
    return "pixi";
  }

  const requested = new URLSearchParams(search).get("renderer");
  return requested === "canvas" ? "canvas" : "pixi";
}

/**
 * The part of the wreck a route position lies in. The overhead is only under
 * the deck: the controller reports open water above it as the exterior.
 */
export function selectWreckZone(routePositionM: number): WreckZone {
  if (routePositionM >= ENGINE_ROOM_FROM_M) {
    return "engine-room";
  }
  if (routePositionM >= CARGO_HOLD_FROM_M) {
    return "cargo-hold";
  }
  return "exterior";
}

export async function createSelectedRenderer(
  search = typeof location === "undefined" ? "" : location.search,
): Promise<SceneRenderer> {
  if (
    import.meta.env.DEV &&
    resolveRendererKind(search, true) === "canvas"
  ) {
    const { CanvasReferenceAdapter } = await import(
      "./canvas-reference-adapter"
    );
    return new CanvasReferenceAdapter();
  }

  const { PixiWreckRenderer } = await import("./pixi-renderer");
  return new PixiWreckRenderer();
}
