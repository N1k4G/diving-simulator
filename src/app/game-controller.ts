import {
  createInitialDiveState,
  freezeDiveState,
  type DiveState,
} from "../core/dive-state";
import { DiveModel } from "../core/dive-model";
import { NO_INPUT, type InputIntent } from "../core/inputs";
import { metres, seconds } from "../core/units";
import {
  DEFAULT_PLANNER_SETTINGS,
  type PlannerForecast,
} from "../planner/dive-planner";
import { ForecastScheduler } from "../planner/forecast-scheduler";
import {
  createPresentationState,
  type PresentationState,
} from "../presentation/presentation-state";
import type { SceneRenderer, WreckSceneState } from "../render/renderer";
import { selectWreckZone } from "../render/renderer";
import { PlannerWorkerClient } from "./planner-worker-client";

const START_DEPTH_M = 26;
const START_ROUTE_POSITION_M = 18;
const MIN_DEPTH_M = 18;
const MAX_DEPTH_M = 34;
const MIN_ROUTE_POSITION_M = 8;
const MAX_ROUTE_POSITION_M = 106;
const FIN_SPEED_MPS = 5;
const VERTICAL_SPEED_MPS = 1.6;
const MAX_FRAME_SECONDS = 0.1;

export type ContinuousControl = "ascend" | "descend" | "left" | "right";

export interface GameFrame {
  readonly presentation: Readonly<PresentationState>;
  readonly scene: Readonly<WreckSceneState>;
}

export interface GameControllerOptions {
  readonly renderer: SceneRenderer;
  readonly onFrame: (frame: Readonly<GameFrame>) => void;
  readonly plannerClient?: PlannerWorkerClient;
  readonly initialState?: DiveState;
  readonly onAuthoritativeState?: (state: DiveState) => void;
}

export class GameController {
  readonly #renderer: SceneRenderer;
  readonly #onFrame: (frame: Readonly<GameFrame>) => void;
  readonly #plannerClient: PlannerWorkerClient;
  readonly #onAuthoritativeState: ((state: DiveState) => void) | null;
  readonly #forecastScheduler = new ForecastScheduler();
  readonly #pressed = new Set<ContinuousControl>();
  readonly #model: DiveModel;

  #planner: PlannerForecast | null = null;
  #plannerPending = false;
  #routePositionM = START_ROUTE_POSITION_M;
  #diverDepthM = START_DEPTH_M;
  #elapsedRealS = 0;
  #simulationAccumulatorS = 0;
  #facing: -1 | 1 = 1;
  #torchOn = true;
  #lastFrameMs: number | null = null;
  #animationFrame = 0;
  #resizeObserver: ResizeObserver | null = null;
  #host: HTMLElement | null = null;
  #disposed = false;

  constructor(options: Readonly<GameControllerOptions>) {
    this.#renderer = options.renderer;
    this.#onFrame = options.onFrame;
    this.#onAuthoritativeState = options.onAuthoritativeState ?? null;
    this.#plannerClient = options.plannerClient ?? new PlannerWorkerClient();
    const initial = options.initialState ?? createWreckInitialState();
    this.#model = new DiveModel(initial);
    this.#diverDepthM = clamp(
      initial.depthM,
      MIN_DEPTH_M,
      MAX_DEPTH_M,
    );
  }

  get authoritativeState(): DiveState {
    return this.#model.snapshot;
  }

  async start(host: HTMLElement): Promise<void> {
    if (this.#host) {
      throw new Error("game controller is already started");
    }
    this.#host = host;
    await this.#renderer.mount(host);
    if (this.#disposed) {
      this.#renderer.destroy();
      return;
    }

    this.#resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        this.#renderer.resize(
          Math.max(1, entry.contentRect.width),
          Math.max(1, entry.contentRect.height),
        );
      }
    });
    this.#resizeObserver.observe(host);
    window.addEventListener("keydown", this.#handleKeyDown);
    window.addEventListener("keyup", this.#handleKeyUp);
    this.#publishFrame();
    this.#requestForecast(true);
    this.#animationFrame = requestAnimationFrame(this.#tick);
  }

  setControl(control: ContinuousControl, active: boolean): void {
    if (active) {
      this.#pressed.add(control);
    } else {
      this.#pressed.delete(control);
    }
  }

  toggleTorch(): void {
    this.#torchOn = !this.#torchOn;
    this.#publishFrame();
  }

  destroy(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    cancelAnimationFrame(this.#animationFrame);
    this.#resizeObserver?.disconnect();
    window.removeEventListener("keydown", this.#handleKeyDown);
    window.removeEventListener("keyup", this.#handleKeyUp);
    this.#plannerClient.dispose();
    this.#renderer.destroy();
    this.#pressed.clear();
  }

  readonly #tick = (nowMs: number): void => {
    if (this.#disposed) {
      return;
    }
    const elapsedS =
      this.#lastFrameMs === null
        ? 0
        : Math.min(MAX_FRAME_SECONDS, (nowMs - this.#lastFrameMs) / 1000);
    this.#lastFrameMs = nowMs;
    this.#advanceView(elapsedS);
    this.#simulationAccumulatorS += elapsedS;

    while (this.#simulationAccumulatorS >= 1) {
      this.#model.advance(
        { depthM: metres(this.#diverDepthM) },
        seconds(1),
        this.#createInputIntent(),
      );
      this.#onAuthoritativeState?.(this.#model.snapshot);
      this.#simulationAccumulatorS -= 1;
      this.#requestForecast();
    }

    this.#publishFrame();
    this.#animationFrame = requestAnimationFrame(this.#tick);
  };

  #advanceView(elapsedS: number): void {
    const horizontal =
      (this.#pressed.has("right") ? 1 : 0) -
      (this.#pressed.has("left") ? 1 : 0);
    const vertical =
      (this.#pressed.has("descend") ? 1 : 0) -
      (this.#pressed.has("ascend") ? 1 : 0);

    if (horizontal !== 0) {
      this.#facing = horizontal < 0 ? -1 : 1;
    }
    this.#routePositionM = clamp(
      this.#routePositionM + horizontal * FIN_SPEED_MPS * elapsedS,
      MIN_ROUTE_POSITION_M,
      MAX_ROUTE_POSITION_M,
    );
    this.#diverDepthM = clamp(
      this.#diverDepthM + vertical * VERTICAL_SPEED_MPS * elapsedS,
      MIN_DEPTH_M,
      MAX_DEPTH_M,
    );
    this.#elapsedRealS += elapsedS;
  }

  #createInputIntent(): Readonly<InputIntent> {
    return {
      ...NO_INPUT,
      ascend: this.#pressed.has("ascend"),
      descend: this.#pressed.has("descend"),
      finLeft: this.#pressed.has("left"),
      finRight: this.#pressed.has("right"),
    };
  }

  #publishFrame(): void {
    const presentation = createPresentationState(
      this.#model.snapshot,
      this.#planner,
    );
    const scene: WreckSceneState = Object.freeze({
      routePositionM: this.#routePositionM,
      diverDepthM: this.#diverDepthM,
      elapsedRealS: this.#elapsedRealS,
      facing: this.#facing,
      torchOn: this.#torchOn,
      zone: selectWreckZone(this.#routePositionM),
    });
    this.#renderer.render(presentation, scene);
    this.#onFrame(Object.freeze({ presentation, scene }));
  }

  #requestForecast(force = false): void {
    if (this.#plannerPending || this.#disposed) {
      return;
    }
    const snapshot = this.#forecastScheduler.takeSnapshotIfDue(
      this.#model.snapshot,
      this.#model.snapshot.elapsedTimeS,
      force,
    );
    if (!snapshot) {
      return;
    }

    this.#plannerPending = true;
    void this.#plannerClient
      .forecast(snapshot, DEFAULT_PLANNER_SETTINGS)
      .then((forecast) => {
        if (!this.#disposed) {
          this.#planner = forecast;
          this.#publishFrame();
        }
      })
      .catch((error: unknown) => {
        if (!this.#disposed) {
          console.error(error);
        }
      })
      .finally(() => {
        this.#plannerPending = false;
      });
  }

  readonly #handleKeyDown = (event: KeyboardEvent): void => {
    const control = controlForKey(event.key);
    if (control) {
      event.preventDefault();
      this.setControl(control, true);
      return;
    }
    if (event.key.toLowerCase() === "t" && !event.repeat) {
      event.preventDefault();
      this.toggleTorch();
    }
  };

  readonly #handleKeyUp = (event: KeyboardEvent): void => {
    const control = controlForKey(event.key);
    if (control) {
      event.preventDefault();
      this.setControl(control, false);
    }
  };
}

function controlForKey(key: string): ContinuousControl | null {
  switch (key.toLowerCase()) {
    case "arrowup":
    case "w":
      return "ascend";
    case "arrowdown":
    case "s":
      return "descend";
    case "arrowleft":
    case "a":
      return "left";
    case "arrowright":
    case "d":
      return "right";
    default:
      return null;
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function createWreckInitialState(): DiveState {
  const initial = createInitialDiveState(0x57524543);
  return freezeDiveState({
    ...initial,
    depthM: metres(START_DEPTH_M),
    maxDepthM: metres(START_DEPTH_M),
  });
}
