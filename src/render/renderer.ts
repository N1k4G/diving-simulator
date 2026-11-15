import type { PresentationState } from "../presentation/presentation-state";
import { sitePresentation, visualZoneAt } from "../sites/layer-factory";

export const RENDERER_KINDS = ["pixi", "canvas"] as const;

export type RendererKind = (typeof RENDERER_KINDS)[number];

/** Legacy's wreck zones (src/sites.js visualZones), named without their "wreck_" prefix. */
export type WreckZone =
  | "exterior"
  | "bridge"
  | "accommodation"
  | "vehicle-deck"
  | "crew-deck"
  | "cargo-hold"
  | "engine-room"
  | "bilge";

export interface WreckSceneState {
  readonly routePositionM: number;
  readonly diverDepthM: number;
  readonly elapsedRealS: number;
  readonly facing: -1 | 1;
  readonly torchOn: boolean;
  readonly zone: WreckZone;
  /** Legacy's inOverhead: a structure above the diver (src/sites.js overheadAt). */
  readonly inOverhead: boolean;
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

/** The wreck's zones as legacy declares them, keyed by legacy's id. */
export const WRECK_ZONE_IDS: Readonly<Record<string, WreckZone>> = Object.freeze({
  wreck_exterior: "exterior",
  wreck_bridge: "bridge",
  wreck_accommodation: "accommodation",
  wreck_vehicle_deck: "vehicle-deck",
  wreck_crew_deck: "crew-deck",
  wreck_cargo_hold: "cargo-hold",
  wreck_engine_room: "engine-room",
  wreck_bilge: "bilge",
});

const WRECK_VISUAL_ZONES = sitePresentation("wreck")?.visualZones;

/**
 * The part of the wreck the diver is in (#240): legacy's visualZoneAt() over
 * the wreck's zones, by position and depth alone, as legacy has it. The
 * vehicle deck's zone takes in the bow visor's opening and the stern's, which
 * are open to the surface, so a zone is not the overhead: that is
 * `inOverhead`. Outside every zone, past the site's ends, is the exterior.
 */
export function selectWreckZone(positionM: number, depthM: number): WreckZone {
  const zone = visualZoneAt(WRECK_VISUAL_ZONES, positionM, depthM);
  return (zone && WRECK_ZONE_IDS[zone.id]) ?? "exterior";
}

/**
 * The dive is under way: legacy's 'diving' state, in which it draws the boat's
 * shadow and the fast-ascent flash. Not while the dive waits at the surface
 * (legacy's 'surface'), nor once it has ended or failed.
 */
export function diveUnderway(
  presentation: Readonly<
    Pick<PresentationState, "elapsedTimeS" | "depthM" | "completed" | "failureReason">
  >,
): boolean {
  return (
    (presentation.elapsedTimeS > 0 || presentation.depthM > 0) &&
    !presentation.completed &&
    presentation.failureReason === null
  );
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
