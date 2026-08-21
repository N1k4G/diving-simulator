import { Application, Container, Graphics } from "pixi.js";

import type { PresentationState } from "../presentation/presentation-state";
import { LAYERS, type LayerId, type QualityTier } from "../sites/asset-manifest";
import { buildSceneLayers } from "../sites/layer-factory";
import { createCameraTransform } from "./camera";
import {
  BUBBLE_LAYER,
  RETAINED_LAYER_ASSIGNMENT,
  type RetainedElement,
} from "./layer-assignment";
import type { SceneRenderer, WreckSceneState } from "./renderer";

const MAX_RESOLUTION = 2;
const BUBBLE_COUNT = 14;
const SITE_ID = "wreck";

// Half-width and half-height of the visible world window, in metres. Culling
// uses this rather than the exact viewport so the set only changes when the
// camera has actually travelled, not on every sub-metre movement.
const CULL_HALF_WIDTH_M = 34;
const CULL_HALF_HEIGHT_M = 20;
const RESYNC_DISTANCE_M = 4;

export class PixiWreckRenderer implements SceneRenderer {
  readonly kind = "pixi" as const;

  #app: Application | null = null;
  #host: HTMLElement | null = null;
  #background = new Graphics();
  #world = new Container();
  #torch = new Graphics();
  #diver = new Container();
  #bubbles: Graphics[] = [];
  #viewport = { width: 1, height: 1 };
  #layers = new Map<LayerId, Container>();
  // Placement markers are pooled. Camera movement changes which features are
  // visible many times a dive; allocating a Graphics per feature per resync
  // would churn the heap for a scene whose contents barely change.
  #markerPool: Graphics[] = [];
  #activeMarkers: Graphics[] = [];
  #lastSyncFocus: { x: number; y: number } | null = null;
  #qualityTier: QualityTier = "high";

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
    this.#syncSceneLayers({ x: 0, y: 0 }, true);

    const bounds = host.getBoundingClientRect();
    this.resize(
      Math.max(1, bounds.width || 960),
      Math.max(1, bounds.height || 540),
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
    this.#syncSceneLayers({ x: camera.focus.x, y: camera.focus.y }, false);
    this.#diver.position.set(scene.routePositionM, scene.diverDepthM);
    this.#diver.scale.x = scene.facing;
    this.#torch.visible = scene.torchOn;

    for (let index = 0; index < this.#bubbles.length; index += 1) {
      const bubble = this.#bubbles[index];
      if (!bubble) {
        continue;
      }
      const cycle = (scene.elapsedRealS * (0.45 + index * 0.025) + index) % 8;
      bubble.position.set(
        scene.routePositionM - scene.facing * (0.5 + (index % 3) * 0.18),
        scene.diverDepthM - 0.7 - cycle,
      );
      bubble.alpha = Math.max(0, 1 - cycle / 8) * 0.72;
    }

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
    this.#layers.clear();
    this.#markerPool = [];
    this.#activeMarkers = [];
    this.#lastSyncFocus = null;
  }

  /** Quality tier drops decoration before anything a diver navigates by. */
  setQualityTier(tier: QualityTier): void {
    if (tier === this.#qualityTier) {
      return;
    }
    this.#qualityTier = tier;
    this.#lastSyncFocus = null;
  }

  /** Visible placement count, for tests and the diagnostics overlay. */
  get placementCount(): number {
    return this.#activeMarkers.length;
  }

  #syncSceneLayers(focus: { x: number; y: number }, force: boolean): void {
    if (
      !force &&
      this.#lastSyncFocus &&
      Math.abs(focus.x - this.#lastSyncFocus.x) < RESYNC_DISTANCE_M &&
      Math.abs(focus.y - this.#lastSyncFocus.y) < RESYNC_DISTANCE_M
    ) {
      return;
    }
    this.#lastSyncFocus = { x: focus.x, y: focus.y };

    const layers = buildSceneLayers(SITE_ID, {
      qualityTier: this.#qualityTier,
      camera: {
        leftM: focus.x - CULL_HALF_WIDTH_M,
        rightM: focus.x + CULL_HALF_WIDTH_M,
        topM: focus.y - CULL_HALF_HEIGHT_M,
        bottomM: focus.y + CULL_HALF_HEIGHT_M,
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

    const hull = new Graphics()
      .poly([14, 35, 22, 23, 82, 21, 108, 29, 103, 35])
      .fill({ color: 0x33484a })
      .stroke({ color: 0x76918c, width: 0.35 })
      .poly([21, 33.5, 27, 24.5, 82, 23, 103, 29.5, 99, 33.5])
      .fill({ color: 0x0a1c22 })
      .stroke({ color: 0x567069, width: 0.25 });

    const rooms = new Graphics()
      .rect(43, 24.2, 1, 9.3)
      .rect(73, 23.3, 1, 10.2)
      .rect(97, 28, 1, 5.5)
      .fill({ color: 0x536763 })
      .rect(48, 29, 19, 0.55)
      .rect(79, 27.2, 14, 0.55)
      .fill({ color: 0x435a57 });

    const engine = new Graphics()
      .circle(87, 30.5, 3.1)
      .fill({ color: 0x192c2f })
      .stroke({ color: 0xb26d3f, width: 0.45 })
      .circle(87, 30.5, 1.35)
      .stroke({ color: 0xd18d4f, width: 0.35 })
      .rect(81, 33, 14, 0.65)
      .fill({ color: 0x6e4d39 });

    const route = new Graphics()
      .moveTo(9, 27)
      .bezierCurveTo(28, 25, 34, 29, 50, 28)
      .bezierCurveTo(66, 27, 70, 31, 86, 30)
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
    const retained: Readonly<Record<RetainedElement, Graphics | Container>> = {
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
