import type { PresentationState } from "../presentation/presentation-state";
import { WRECK_HOLD_EDGE, WRECK_HULL_EDGE, type RoutePoint } from "../sites/wreck-route";
import {
  createCameraTransform,
  worldToScreen,
  wreckCameraFocusX,
  type CameraTransform,
} from "./camera";
import type { SceneRenderer, WreckSceneState } from "./renderer";
import { SHARK_MOUTH_WIDTH_M, SHARK_SIZE_M, sharkBobM } from "./shark-view";

export class CanvasReferenceAdapter implements SceneRenderer {
  readonly kind = "canvas" as const;

  #canvas: HTMLCanvasElement | null = null;
  #context: CanvasRenderingContext2D | null = null;
  #host: HTMLElement | null = null;
  #viewport = { width: 1, height: 1 };
  #resolution = 1;
  /** The real time the shark on screen was first drawn at, for its phase. */
  #sharkSinceRealS: number | null = null;

  async mount(host: HTMLElement): Promise<void> {
    if (this.#canvas) {
      throw new Error("renderer is already mounted");
    }
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Canvas 2D is unavailable");
    }

    this.#canvas = canvas;
    this.#context = context;
    this.#host = host;
    canvas.className = "wreck-canvas";
    canvas.setAttribute("aria-hidden", "true");
    host.dataset.renderer = this.kind;
    host.replaceChildren(canvas);

    const bounds = host.getBoundingClientRect();
    this.resize(
      Math.max(1, bounds.width || 960),
      Math.max(1, bounds.height || 540),
    );
  }

  resize(width: number, height: number, resolution = window.devicePixelRatio || 1): void {
    const canvas = this.#requireCanvas();
    this.#viewport = {
      width: Math.max(1, width),
      height: Math.max(1, height),
    };
    this.#resolution = Math.min(2, Math.max(1, resolution));
    canvas.width = Math.round(this.#viewport.width * this.#resolution);
    canvas.height = Math.round(this.#viewport.height * this.#resolution);
    canvas.style.width = `${this.#viewport.width}px`;
    canvas.style.height = `${this.#viewport.height}px`;
  }

  render(
    _presentation: Readonly<PresentationState>,
    scene: Readonly<WreckSceneState>,
  ): void {
    const context = this.#requireContext();
    const camera = createCameraTransform(this.#viewport, {
      x: wreckCameraFocusX(scene.routePositionM, scene.facing),
      y: scene.diverDepthM,
    });
    const point = (x: number, y: number) =>
      worldToScreen({ x, y }, camera);

    context.setTransform(
      this.#resolution,
      0,
      0,
      this.#resolution,
      0,
      0,
    );
    context.clearRect(0, 0, this.#viewport.width, this.#viewport.height);
    const gradient = context.createLinearGradient(0, 0, 0, this.#viewport.height);
    gradient.addColorStop(0, "#0b3541");
    gradient.addColorStop(1, "#06141c");
    context.fillStyle = gradient;
    context.fillRect(0, 0, this.#viewport.width, this.#viewport.height);

    // The hull and the hold the route holds the diver to, open at the bow
    // visor as the Pixi scene draws them (#222).
    const outline = (points: readonly RoutePoint[]) => {
      context.beginPath();
      for (const [index, { x, d }] of points.entries()) {
        const screen = point(x, d);
        if (index === 0) {
          context.moveTo(screen.x, screen.y);
        } else {
          context.lineTo(screen.x, screen.y);
        }
      }
    };
    outline(WRECK_HULL_EDGE);
    context.fillStyle = "#30484a";
    context.fill();
    outline(WRECK_HOLD_EDGE);
    context.fillStyle = "#091c22";
    context.fill();
    outline(WRECK_HULL_EDGE);
    context.strokeStyle = "#78918d";
    context.lineWidth = Math.max(1, camera.scale * 0.3);
    context.stroke();

    // In front of the wreck and behind the diver and the torch, as the Pixi
    // scene layers it (#246).
    this.#drawShark(context, camera, scene);

    if (scene.torchOn) {
      const origin = point(scene.routePositionM, scene.diverDepthM);
      const farTop = point(
        scene.routePositionM + scene.facing * 22,
        scene.diverDepthM - 5.5,
      );
      const farBottom = point(
        scene.routePositionM + scene.facing * 22,
        scene.diverDepthM + 5.5,
      );
      context.beginPath();
      context.moveTo(origin.x, origin.y);
      context.lineTo(farTop.x, farTop.y);
      context.lineTo(farBottom.x, farBottom.y);
      context.closePath();
      context.fillStyle = "rgb(169 234 255 / 12%)";
      context.fill();
    }

    const diver = point(scene.routePositionM, scene.diverDepthM);
    context.beginPath();
    context.ellipse(
      diver.x,
      diver.y,
      camera.scale,
      camera.scale * 0.38,
      0,
      0,
      Math.PI * 2,
    );
    context.fillStyle = "#111c22";
    context.fill();
    context.strokeStyle = "#8ccddd";
    context.lineWidth = Math.max(1, camera.scale * 0.1);
    context.stroke();
  }

  destroy(): void {
    this.#canvas?.remove();
    if (this.#host) {
      delete this.#host.dataset.renderer;
    }
    this.#canvas = null;
    this.#context = null;
    this.#host = null;
    this.#sharkSinceRealS = null;
  }

  /**
   * Legacy's shark (src/renderer.js drawScene, TASK-044) while one swims, as
   * the Pixi scene draws it: turned to its heading and bobbing on its phase
   * from when it is first drawn. Drawn in metres under the camera's scale,
   * each part filled on its own as legacy fills them.
   */
  #drawShark(
    context: CanvasRenderingContext2D,
    camera: CameraTransform,
    scene: Readonly<WreckSceneState>,
  ): void {
    const shark = scene.shark;
    if (!shark) {
      this.#sharkSinceRealS = null;
      return;
    }
    this.#sharkSinceRealS ??= scene.elapsedRealS;
    const at = worldToScreen(
      {
        x: shark.positionM,
        y: shark.depthM + sharkBobM(scene.elapsedRealS - this.#sharkSinceRealS),
      },
      camera,
    );
    const s = SHARK_SIZE_M;
    const fill = (points: readonly (readonly [number, number])[]) => {
      context.beginPath();
      for (const [index, [x, y]] of points.entries()) {
        if (index === 0) {
          context.moveTo(x, y);
        } else {
          context.lineTo(x, y);
        }
      }
      context.closePath();
      context.fill();
    };

    context.save();
    context.translate(at.x, at.y);
    context.scale(camera.scale * shark.direction, camera.scale);
    context.fillStyle = "rgba(40,50,60,0.85)";
    context.beginPath();
    context.ellipse(0, 0, s, s * 0.35, 0, 0, Math.PI * 2);
    context.fill();
    // Dorsal, tail and pectoral fins.
    fill([[-s * 0.1, -s * 0.35], [s * 0.05, -s * 0.85], [s * 0.3, -s * 0.3]]);
    fill([[-s, 0], [-s * 1.5, -s * 0.5], [-s * 1.2, 0], [-s * 1.5, s * 0.4]]);
    fill([[s * 0.1, s * 0.2], [-s * 0.2, s * 0.55], [-s * 0.3, s * 0.15]]);
    context.strokeStyle = "rgba(20,25,30,0.9)";
    context.lineWidth = SHARK_MOUTH_WIDTH_M;
    context.beginPath();
    context.moveTo(s * 0.7, s * 0.08);
    context.lineTo(s * 0.95, s * 0.02);
    context.lineTo(s * 0.7, -s * 0.05);
    context.stroke();
    context.fillStyle = "#111";
    context.beginPath();
    context.arc(s * 0.6, -s * 0.1, s * 0.06, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = "rgba(200,0,0,0.5)";
    context.beginPath();
    context.arc(s * 0.6, -s * 0.1, s * 0.03, 0, Math.PI * 2);
    context.fill();
    context.restore();
  }

  #requireCanvas(): HTMLCanvasElement {
    if (!this.#canvas) {
      throw new Error("renderer must be mounted before use");
    }
    return this.#canvas;
  }

  #requireContext(): CanvasRenderingContext2D {
    if (!this.#context) {
      throw new Error("renderer must be mounted before use");
    }
    return this.#context;
  }
}
