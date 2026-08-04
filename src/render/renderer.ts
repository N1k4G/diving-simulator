import type { PresentationState } from "../presentation/presentation-state";

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

export function selectWreckZone(routePositionM: number): WreckZone {
  if (routePositionM >= 76) {
    return "engine-room";
  }
  if (routePositionM >= 45) {
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
