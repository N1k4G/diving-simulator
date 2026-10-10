import { Application, Container, Graphics } from "pixi.js";

import type { PresentationState } from "../presentation/presentation-state";
import { LAYERS, type LayerId, type QualityTier } from "../sites/asset-manifest";
import { buildSceneLayers } from "../sites/layer-factory";
import {
  WRECK_DECK_TOP,
  WRECK_ENGINE,
  WRECK_HOLD_EDGE,
  WRECK_HULL_EDGE,
  WRECK_VISOR,
  profileAt,
  type RoutePoint,
} from "../sites/wreck-route";
import { createCameraTransform, type CameraTransform } from "./camera";
import {
  BUBBLE_LAYER,
  RETAINED_LAYER_ASSIGNMENT,
  visibleHalfExtentM,
  type RetainedElement,
} from "./layer-assignment";
import type { SceneRenderer, WreckSceneState } from "./renderer";

const MAX_RESOLUTION = 2;
const BUBBLE_COUNT = 14;
const SITE_ID = "wreck";

// Extra world-space margin beyond the visible window, so content is resident
// before it scrolls in. Resyncs happen only once the camera has travelled
// RESYNC_DISTANCE_M, so the margin has to exceed that or content can enter the
// frame during the gap between syncs.
const CULL_MARGIN_M = 10;

// Issue #128: adaptive quality is not planned, so this never varies.
//
// The tier machinery underneath is real — every asset declares a
// `minimumQualityTier` and `buildSceneLayers` filters on it — but nothing ever
// chose a tier. `setQualityTier()` and `placementCount` were removed rather
// than left in place, because an API that advertises adaptive quality while
// the value is pinned is worse than no API: it reads as a working feature.
//
// Wiring it later means adding something that decides the tier (a frame
// budget, a device-capability probe, or a user setting), putting the setter on
// SceneRenderer, and replacing this constant. The filtering is already there
// and tested.
const QUALITY_TIER: QualityTier = "high";
const RESYNC_DISTANCE_M = 4;

// The water surface (#199), after src/renderer.js drawScene: a band of light
// water under a moving wave line, the sum of two sines, with the sky above
// it. Legacy draws in screen pixels at 0.05 m a pixel; these are the same
// waves in metres. Each sine is its own strip, drawn once and slid sideways
// by its phase every frame, so the animation allocates nothing.
const SURFACE_SPAN_M = { left: -60, right: 180 } as const;
const SKY_TOP_M = -200;
const SURFACE_WAVES = [
  // sin(x * 0.02 + t * 2) * 4 px, then sin(x * 0.035 + t * 1.5) * 2 px.
  { amplitudeM: 0.2, wavelengthM: 15.7, speedMps: 5, alpha: 0.18, highlight: true },
  { amplitudeM: 0.1, wavelengthM: 9, speedMps: 2.14, alpha: 0.18, highlight: false },
] as const;
/** Legacy fills 20 px under the wave line: one metre. */
const SURFACE_BAND_M = 1;

export class PixiWreckRenderer implements SceneRenderer {
  readonly kind = "pixi" as const;

  #app: Application | null = null;
  #host: HTMLElement | null = null;
  #background = new Graphics();
  #world = new Container();
  #torch = new Graphics();
  #diver = new Container();
  #bubbles: Graphics[] = [];
  #waves: Graphics[] = [];
  #viewport = { width: 1, height: 1 };
  #layers = new Map<LayerId, Container>();
  // Placement markers are pooled. Camera movement changes which features are
  // visible many times a dive; allocating a Graphics per feature per resync
  // would churn the heap for a scene whose contents barely change.
  #markerPool: Graphics[] = [];
  #activeMarkers: Graphics[] = [];
  #lastSyncFocus: { x: number; y: number } | null = null;

  async mount(host: HTMLElement): Promise<void> {
    if (this.#app) {
      throw new Error("renderer is already mounted");
    }

    const app = new Application();
    await app.init({
      antialias: true,
      autoDensity: true,
      autoStart: false,
      backgroundAlpha: 0,
      preference: "webgl",
      resolution: Math.min(window.devicePixelRatio || 1, MAX_RESOLUTION),
    });

    this.#app = app;
    this.#host = host;
    app.canvas.className = "wreck-canvas";
    app.canvas.setAttribute("aria-hidden", "true");
    host.dataset.renderer = this.kind;
    host.replaceChildren(app.canvas);
    app.stage.addChild(this.#background, this.#world);
    this.#buildRetainedScene();

    // Size first, then sync: the cull window is derived from the camera, so
    // syncing against the placeholder 1x1 viewport would populate the scene for
    // a window that does not exist.
    const bounds = host.getBoundingClientRect();
    this.resize(
      Math.max(1, bounds.width || 960),
      Math.max(1, bounds.height || 540),
    );
    this.#syncSceneLayers(
      createCameraTransform(this.#viewport, { x: 0, y: 0 }),
      true,
    );
  }

  resize(width: number, height: number, resolution?: number): void {
    const app = this.#requireApp();
    this.#viewport = {
      width: Math.max(1, width),
      height: Math.max(1, height),
    };
    if (resolution !== undefined) {
      app.renderer.resolution = Math.min(MAX_RESOLUTION, resolution);
    }
    app.renderer.resize(this.#viewport.width, this.#viewport.height);
    this.#drawBackground();
    // The cull window is a function of the viewport, so a resize or an
    // orientation change invalidates it even when the camera has not moved.
    // Without this, rotating to portrait keeps the landscape window and the
    // newly visible depth band stays empty until the diver travels 4 m.
    this.#lastSyncFocus = null;
  }

  render(
    _presentation: Readonly<PresentationState>,
    scene: Readonly<WreckSceneState>,
  ): void {
    const app = this.#requireApp();
    const camera = createCameraTransform(this.#viewport, {
      x: scene.routePositionM + scene.facing * 8,
      y: scene.diverDepthM,
    });

    this.#world.position.set(
      this.#viewport.width / 2,
      this.#viewport.height / 2,
    );
    this.#world.pivot.set(camera.focus.x, camera.focus.y);
    this.#world.scale.set(camera.scale);
    this.#syncSceneLayers(camera, false);
    this.#diver.position.set(scene.routePositionM, scene.diverDepthM);
    this.#diver.scale.x = scene.facing;
    this.#torch.visible = scene.torchOn;

    for (let index = 0; index < this.#bubbles.length; index += 1) {
      const bubble = this.#bubbles[index];
      if (!bubble) {
        continue;
      }
      const cycle = (scene.elapsedRealS * (0.45 + index * 0.025) + index) % 8;
      const bubbleDepthM = scene.diverDepthM - 0.7 - cycle;
      bubble.position.set(
        scene.routePositionM - scene.facing * (0.5 + (index % 3) * 0.18),
        bubbleDepthM,
      );
      bubble.alpha = Math.max(0, 1 - cycle / 8) * 0.72;
      // A bubble breaks at the surface; none rises into the sky.
      bubble.visible = bubbleDepthM > 0;
    }

    SURFACE_WAVES.forEach((wave, index) => {
      const strip = this.#waves[index];
      if (strip) {
        // sin(kx + wt) travels towards -x.
        strip.position.x =
          -((scene.elapsedRealS * wave.speedMps) % wave.wavelengthM);
      }
    });

    app.render();
  }

  destroy(): void {
    if (!this.#app) {
      return;
    }
    this.#app.destroy({ removeView: true }, { children: true });
    if (this.#host) {
      delete this.#host.dataset.renderer;
    }
    this.#app = null;
    this.#host = null;
    this.#bubbles = [];
    this.#waves = [];
    this.#layers.clear();
    this.#markerPool = [];
    this.#activeMarkers = [];
    this.#lastSyncFocus = null;
  }

  #syncSceneLayers(camera: CameraTransform, force: boolean): void {
    const focus = camera.focus;
    if (
      !force &&
      this.#lastSyncFocus &&
      Math.abs(focus.x - this.#lastSyncFocus.x) < RESYNC_DISTANCE_M &&
      Math.abs(focus.y - this.#lastSyncFocus.y) < RESYNC_DISTANCE_M
    ) {
      return;
    }
    this.#lastSyncFocus = { x: focus.x, y: focus.y };

    // Derive the window from the camera rather than from constants. A fixed
    // half-height cannot describe the visible world: the camera fits a constant
    // 58 m of WIDTH, so visible height is viewport.height / scale and grows with
    // aspect ratio. At 390x844 that is ~125 m of depth on screen against a
    // 20 m half-height, which culled four on-screen placements — the engine row
    // at d=61 and the anchor at d=66 — while the diver was looking straight at
    // them. Desktop and landscape hid this because their windows are shorter
    // than the constant.
    const { halfWidthM, halfHeightM } = visibleHalfExtentM(camera);

    const layers = buildSceneLayers(SITE_ID, {
      qualityTier: QUALITY_TIER,
      cullMarginM: CULL_MARGIN_M,
      camera: {
        leftM: focus.x - halfWidthM,
        rightM: focus.x + halfWidthM,
        topM: focus.y - halfHeightM,
        bottomM: focus.y + halfHeightM,
      },
    });

    for (const marker of this.#activeMarkers) {
      marker.visible = false;
      this.#markerPool.push(marker);
    }
    this.#activeMarkers = [];

    for (const layer of layers) {
      const container = this.#layers.get(layer.id);
      if (!container) {
        continue;
      }
      for (const placement of layer.placements) {
        const marker = this.#takeMarker();
        marker.visible = true;
        marker.position.set(placement.x, placement.d);
        // Unconditional, not `if (marker.parent !== container)`. buildSceneLayers
        // sorts placements within a layer (shallowest first, then x) so the same
        // data always yields the same scene — but a pooled marker reused in the
        // container it already sits in keeps its stale child index, so that sort
        // stopped being reflected in the display list after the first resync.
        // Pixi's addChild splices an existing child out and pushes it to the
        // end, so calling it every time is what applies the ordering. Invisible
        // today because every marker is the same provisional circle; it would
        // surface as soon as real atlas frames overlap.
        container.addChild(marker);
        this.#activeMarkers.push(marker);
      }
    }
  }

  #takeMarker(): Graphics {
    const pooled = this.#markerPool.pop();
    if (pooled) {
      return pooled;
    }
    // Provisional marker geometry. Production atlases are BLOCKED_EXTERNAL, so
    // placements are drawn as a deliberately plain shape rather than as art
    // guessed at here; the manifest already fixes the atlas/frame contract they
    // will be loaded through.
    return new Graphics()
      .circle(0, 0, 0.32)
      .fill({ color: 0x4f7f7a, alpha: 0.34 })
      .stroke({ color: 0x8fd4c8, width: 0.06, alpha: 0.5 });
  }

  #buildRetainedScene(): void {
    const distantHull = new Graphics()
      .poly([8, 36, 18, 23, 83, 20, 111, 29, 106, 36])
      .fill({ color: 0x07151b, alpha: 0.88 });

    const seabed = new Graphics()
      .poly([0, 38, 22, 36, 48, 38, 72, 36.5, 95, 38, 116, 35.5, 116, 42, 0, 42])
      .fill({ color: 0x132a2b })
      .stroke({ color: 0x315b52, width: 0.2, alpha: 0.8 });

    // The deck and the floor the diver is held to (src/sites/wreck-route.ts),
    // so the hull on screen is the one in the physics. The edges are open
    // paths, so no line closes the bow visor's opening (#222).
    const hullEdge = flatten(WRECK_HULL_EDGE);
    const holdEdge = flatten(WRECK_HOLD_EDGE);
    const visorHeightM = profileAt(WRECK_DECK_TOP, WRECK_VISOR.x1) - WRECK_VISOR.topM;
    const hull = new Graphics()
      .poly(hullEdge)
      .fill({ color: 0x33484a })
      .poly(holdEdge)
      .fill({ color: 0x0a1c22 })
      .poly(hullEdge, false)
      .stroke({ color: 0x76918c, width: 0.35 })
      .poly(holdEdge, false)
      .stroke({ color: 0x567069, width: 0.25 })
      // The bow visor, hinged up on the deck's forward edge: legacy's slab,
      // its plate seam and its hinge spindle (src/renderer.js drawBowVisor).
      .rect(WRECK_VISOR.x1, WRECK_VISOR.topM, WRECK_VISOR.x2 - WRECK_VISOR.x1, visorHeightM)
      .fill({ color: 0x55636f })
      .stroke({ color: 0x76918c, width: 0.12 })
      .moveTo((WRECK_VISOR.x1 + WRECK_VISOR.x2) / 2, WRECK_VISOR.topM + 0.2)
      .lineTo((WRECK_VISOR.x1 + WRECK_VISOR.x2) / 2, WRECK_VISOR.topM + visorHeightM - 0.2)
      .stroke({ color: 0x1b2429, width: 0.06, alpha: 0.6 })
      .circle((WRECK_VISOR.x1 + WRECK_VISOR.x2) / 2, WRECK_VISOR.topM + visorHeightM - 0.15, 0.14)
      .fill({ color: 0x1a1a1a });

    const rooms = new Graphics()
      .rect(43, 24.2, 1, 9.3)
      .rect(73, 23.3, 1, 10.2)
      .rect(97, 28, 1, 5.5)
      .fill({ color: 0x536763 })
      .rect(48, 29, 19, 0.55)
      .rect(79, 27.2, 14, 0.55)
      .fill({ color: 0x435a57 });

    // Solid, from the same numbers the route reads (#222).
    const { centreX, centreD, radiusM, bedX1, bedX2, bedTopM } = WRECK_ENGINE;
    const engine = new Graphics()
      .circle(centreX, centreD, radiusM)
      .fill({ color: 0x192c2f })
      .stroke({ color: 0xb26d3f, width: 0.45 })
      .circle(centreX, centreD, 1.35)
      .stroke({ color: 0xd18d4f, width: 0.35 })
      .rect(bedX1, bedTopM, bedX2 - bedX1, 0.65)
      .fill({ color: 0x6e4d39 });

    // The guideline the diver can follow: over the stem, down through the bow
    // visor's opening, under the deck and over the engine block (#222).
    const route = new Graphics()
      .moveTo(9, 21)
      .bezierCurveTo(15, 21, 19, 21.5, 19, 25)
      .bezierCurveTo(19, 28, 24, 28.5, 34, 28.5)
      .bezierCurveTo(42, 28.5, 46, 28, 50, 28)
      .bezierCurveTo(64, 27.5, 72, 26, 87, 26)
      .lineTo(101, 31)
      .stroke({ color: 0xe5d071, width: 0.16, alpha: 0.72 });

    const silt = new Graphics();
    for (let index = 0; index < 48; index += 1) {
      const x = 18 + ((index * 23) % 91);
      const y = 34.2 + ((index * 17) % 25) / 20;
      const radius = 0.05 + (index % 4) * 0.025;
      silt.circle(x, y, radius).fill({
        color: 0xb9aa83,
        alpha: 0.16 + (index % 3) * 0.05,
      });
    }

    this.#torch = new Graphics()
      .poly([0.4, -0.22, 22, -5.8, 22, 5.8, 0.4, 0.22])
      .fill({ color: 0xa9eaff, alpha: 0.11 });

    const diverBody = new Graphics()
      .ellipse(0, 0, 1.05, 0.38)
      .fill({ color: 0x111c22 })
      .stroke({ color: 0x8ccddd, width: 0.12 })
      .circle(0.92, -0.08, 0.28)
      .fill({ color: 0xe7c49b })
      .rect(-0.75, -0.53, 0.9, 0.3)
      .fill({ color: 0xd8b34d })
      .moveTo(-0.78, 0.12)
      .lineTo(-1.65, 0.62)
      .lineTo(-2.15, 0.58)
      .stroke({ color: 0x17252a, width: 0.25 });

    this.#diver.addChild(this.#torch, diverBody);

    // Explicit, named layers replace a flat addChild list. Draw order is now a
    // declared property of the scene rather than an accident of call order, and
    // data-driven placements have somewhere to go.
    for (const id of LAYERS) {
      const container = new Container();
      container.label = id;
      this.#layers.set(id, container);
    }

    // Draw order is only "declared" if something can read the declaration.
    // Expressed as addChild calls it was still an accident of call order, and
    // nothing could assert it — which is how silt ended up in `terrain`, below
    // the hull, hiding 31 of its 48 particles. RETAINED_LAYER_ASSIGNMENT is the
    // declaration; see render/layer-assignment.ts for why each element sits
    // where it does, and site-layers.test.ts for the invariants it must hold.
    const sky = buildSky();
    const surface = new Container();
    this.#waves = SURFACE_WAVES.map((wave) => buildWaveStrip(wave));
    surface.addChild(...this.#waves);

    const retained: Readonly<Record<RetainedElement, Graphics | Container>> = {
      sky,
      surface,
      distantHull,
      seabed,
      hull,
      rooms,
      engine,
      route,
      silt,
      diver: this.#diver,
    };
    for (const [element, layerId] of Object.entries(RETAINED_LAYER_ASSIGNMENT)) {
      this.#layers.get(layerId)?.addChild(retained[element as RetainedElement]);
    }

    for (const id of LAYERS) {
      const container = this.#layers.get(id);
      if (container) {
        this.#world.addChild(container);
      }
    }

    for (let index = 0; index < BUBBLE_COUNT; index += 1) {
      const bubble = new Graphics()
        .circle(0, 0, 0.08 + (index % 4) * 0.025)
        .stroke({ color: 0xbdefff, width: 0.045, alpha: 0.88 });
      this.#bubbles.push(bubble);
      this.#layers.get(BUBBLE_LAYER)?.addChild(bubble);
    }
  }

  #drawBackground(): void {
    this.#background
      .clear()
      .rect(0, 0, this.#viewport.width, this.#viewport.height)
      .fill({ color: 0x061a24 })
      .rect(0, 0, this.#viewport.width, this.#viewport.height * 0.58)
      .fill({ color: 0x0b3541, alpha: 0.72 });
  }

  #requireApp(): Application {
    if (!this.#app) {
      throw new Error("renderer must be mounted before use");
    }
    return this.#app;
  }
}

function flatten(points: readonly RoutePoint[]): number[] {
  return points.flatMap((point) => [point.x, point.d]);
}

/**
 * Legacy's sky gradient, #c4e6f0 high up to #83bcd2 at the horizon
 * (src/renderer.js drawScene), in one-metre bands over the six metres the
 * camera shows above the surface.
 */
function buildSky(): Graphics {
  const high = { r: 0xc4, g: 0xe6, b: 0xf0 };
  const horizon = { r: 0x83, g: 0xbc, b: 0xd2 };
  const bands = 6;
  const sky = new Graphics()
    .rect(SURFACE_SPAN_M.left, SKY_TOP_M, SURFACE_SPAN_M.right - SURFACE_SPAN_M.left, -SKY_TOP_M - bands)
    .fill({ color: rgb(high) });
  for (let band = 0; band < bands; band += 1) {
    const t = (band + 0.5) / bands;
    sky
      .rect(SURFACE_SPAN_M.left, -bands + band, SURFACE_SPAN_M.right - SURFACE_SPAN_M.left, 1)
      .fill({
        color: rgb({
          r: high.r + (horizon.r - high.r) * t,
          g: high.g + (horizon.g - high.g) * t,
          b: high.b + (horizon.b - high.b) * t,
        }),
      });
  }
  return sky;
}

function rgb(color: { r: number; g: number; b: number }): number {
  return (Math.round(color.r) << 16) | (Math.round(color.g) << 8) | Math.round(color.b);
}

/**
 * One of the surface's two sines: a band of light water from the wave line
 * down a metre, rgba(135,206,235) as legacy fills it, one wavelength wider
 * than the span so that sliding it by up to a wavelength never shows an edge.
 * The first carries legacy's bright line just under the surface
 * (_drawSurfaceUnderside).
 */
function buildWaveStrip(wave: (typeof SURFACE_WAVES)[number]): Graphics {
  const left = SURFACE_SPAN_M.left;
  const right = SURFACE_SPAN_M.right + wave.wavelengthM;
  const step = 0.5;
  const line: number[] = [];
  for (let x = left; x <= right; x += step) {
    line.push(x, -wave.amplitudeM * Math.sin((2 * Math.PI * x) / wave.wavelengthM));
  }
  const strip = new Graphics()
    .poly([...line, right, SURFACE_BAND_M, left, SURFACE_BAND_M])
    .fill({ color: 0x87ceeb, alpha: wave.alpha });
  if (wave.highlight) {
    strip.moveTo(line[0] as number, (line[1] as number) + 0.1);
    for (let index = 2; index < line.length; index += 2) {
      strip.lineTo(line[index] as number, (line[index + 1] as number) + 0.1);
    }
    strip.stroke({ color: 0xe6f8ff, width: 0.06, alpha: 0.35 });
  }
  return strip;
}
