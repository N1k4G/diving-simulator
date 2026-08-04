import type { PresentationState } from "../presentation/presentation-state";
import { createCameraTransform, worldToScreen } from "./camera";
import type { SceneRenderer, WreckSceneState } from "./renderer";

export class CanvasReferenceAdapter implements SceneRenderer {
  readonly kind = "canvas" as const;

  #canvas: HTMLCanvasElement | null = null;
  #context: CanvasRenderingContext2D | null = null;
  #host: HTMLElement | null = null;
  #viewport = { width: 1, height: 1 };
  #resolution = 1;

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
      x: scene.routePositionM + scene.facing * 8,
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

    const hull = [
      point(14, 35),
      point(22, 23),
      point(82, 21),
      point(108, 29),
      point(103, 35),
    ];
    context.beginPath();
    context.moveTo(hull[0]!.x, hull[0]!.y);
    for (const hullPoint of hull.slice(1)) {
      context.lineTo(hullPoint.x, hullPoint.y);
    }
    context.closePath();
    context.fillStyle = "#30484a";
    context.fill();
    context.strokeStyle = "#78918d";
    context.lineWidth = Math.max(1, camera.scale * 0.3);
    context.stroke();

    const interiorTopLeft = point(27, 24.5);
    const interiorBottomRight = point(99, 33.5);
    context.fillStyle = "#091c22";
    context.fillRect(
      interiorTopLeft.x,
      interiorTopLeft.y,
      interiorBottomRight.x - interiorTopLeft.x,
      interiorBottomRight.y - interiorTopLeft.y,
    );

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
