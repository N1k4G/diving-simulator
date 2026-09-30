import {
  CCR_SETPOINT_STEP_BAR,
  createInitialDiveState,
  type InitialDiveOptions,
  freezeDiveState,
  type DiveState,
} from "../core/dive-state";
import { DiveModel } from "../core/dive-model";
import {
  neutralBcdSurfaceLitres,
  type BuoyancyControls,
  type VerticalBounds,
} from "../core/buoyancy";
import { metres, seconds } from "../core/units";
import {
  DEFAULT_PLANNER_SETTINGS,
  calculateCeiling,
  isAtDecoStop,
  type PlannerForecast,
  type PlannerSettings,
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
/**
 * The wreck route's vertical bounds, legacy's ceilingAt() and floorAt() for
 * this slice (#192). The buoyancy physics stops the diver at them, as legacy
 * stops it at a site's ceiling and floor.
 */
const ROUTE_BOUNDS: Readonly<VerticalBounds> = Object.freeze({
  ceilingM: 18,
  floorM: 34,
});
const MIN_ROUTE_POSITION_M = 8;
const MAX_ROUTE_POSITION_M = 106;
const FIN_SPEED_MPS = 5;
/** src/game-loop.js gameLoop(): `dtReal = Math.min(dtReal, 0.1)`. */
const MAX_FRAME_SECONDS = 0.1;
/**
 * Dive seconds per real second: src/constants.js TIME_ACCELERATION, applied
 * in src/game-loop.js updateDiving() as `dtDiveSeconds = dtReal *
 * timeMultiplier` (#195). Only the dive clock runs faster; the view's own
 * motion and the scene's animation stay in real time.
 */
const TIME_ACCELERATION = 3;
/**
 * How much faster still the dive clock runs while fast-forwarding at a stop:
 * src/constants.js FAST_FORWARD_MULTIPLIER, on top of TIME_ACCELERATION as
 * legacy's `timeMultiplier = TIME_ACCELERATION * FAST_FORWARD_MULTIPLIER`.
 */
const FAST_FORWARD_MULTIPLIER = 10;

export type ContinuousControl = "ascend" | "descend" | "left" | "right";

/**
 * The fast-forward control's state, for the HUD (#163).
 *
 * `available` is legacy's `canFastForward && no vertical key held`: the
 * control is shown only then, as src/touch.js shows its button only at a
 * stop while stationary. `active` is the toggle itself.
 */
export interface FastForwardState {
  readonly available: boolean;
  readonly active: boolean;
}

export interface GameFrame {
  readonly presentation: Readonly<PresentationState>;
  readonly scene: Readonly<WreckSceneState>;
  readonly fastForward: Readonly<FastForwardState>;
}

export interface GameControllerOptions {
  readonly renderer: SceneRenderer;
  readonly onFrame: (frame: Readonly<GameFrame>) => void;
  readonly plannerClient?: PlannerWorkerClient;
  readonly initialState?: DiveState;
  /**
   * Gradient factors and ascent rate for the forecast. Configured on the
   * setup screen (#158); without this the planner ran on
   * DEFAULT_PLANNER_SETTINGS whatever the player chose, so the GF controls
   * changed a stored number and nothing else.
   */
  readonly plannerSettings?: Readonly<PlannerSettings>;
  readonly onAuthoritativeState?: (state: DiveState) => void;
}

export class GameController {
  readonly #renderer: SceneRenderer;
  readonly #onFrame: (frame: Readonly<GameFrame>) => void;
  readonly #plannerClient: PlannerWorkerClient;
  readonly #onAuthoritativeState: ((state: DiveState) => void) | null;
  readonly #plannerSettings: Readonly<PlannerSettings>;
  readonly #forecastScheduler = new ForecastScheduler();
  readonly #pressed = new Set<ContinuousControl>();
  readonly #model: DiveModel;

  #planner: PlannerForecast | null = null;
  #plannerPending = false;
  /**
   * A forced refresh arrived while a request was in flight (#163 review
   * round 1 on PR #182). The in-flight answer describes a breathing gas the
   * diver has since left — a gas switch, a setpoint, a bailout — so it is
   * dropped when it lands, and a fresh request goes out then with the
   * latest state instead of waiting for the next whole-second step.
   */
  #forcedForecastQueued = false;
  #routePositionM = START_ROUTE_POSITION_M;
  #elapsedRealS = 0;
  #facing: -1 | 1 = 1;
  #torchOn = true;
  #fastForwardActive = false;
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
    this.#plannerSettings = options.plannerSettings ?? DEFAULT_PLANNER_SETTINGS;
    this.#model = new DiveModel(
      withinRoute(options.initialState ?? createWreckInitialState()),
    );
  }

  /** What the forecast is actually requested with, as opposed to configured. */
  get plannerSettings(): Readonly<PlannerSettings> {
    return this.#plannerSettings;
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
      // Legacy drops out of fast-forward on the tick a vertical key is read
      // (src/game-loop.js updateDiving). Done here as well as in #tick so
      // that no frame ever reports the clock as sped up while the control
      // that would stop it is already held.
      if (control === "ascend" || control === "descend") {
        this.#fastForwardActive = false;
      }
    } else {
      this.#pressed.delete(control);
    }
  }

  toggleTorch(): void {
    this.#torchOn = !this.#torchOn;
    this.#publishFrame();
  }

  /**
   * Runs the dive clock ten times faster while a stop is held (#163).
   *
   * Legacy toggles `fastForwardActive` on an edge of F, but only while the
   * diver is at a stop with no vertical key down, and clears it the moment
   * either condition lapses (src/game-loop.js updateDiving). The same rule
   * lives in #fastForwardAvailable and is applied every frame in #tick, so a
   * press that arrives when the control is not on offer does nothing rather
   * than arming a fast-forward that starts the next time a stop is reached.
   *
   * Only the clock changes: each frame hands the model ten times the dive
   * time, as legacy's frame does, so nothing about the simulation is skipped
   * or approximated.
   */
  toggleFastForward(): void {
    if (!this.#fastForwardAvailable()) {
      return;
    }
    this.#fastForwardActive = !this.#fastForwardActive;
    this.#publishFrame();
  }

  /**
   * Breathes a different cylinder (#163).
   *
   * Applied at once, as legacy does in the frame it reads the key
   * (game-loop.js TASK-019). An earlier revision queued it for the next
   * whole-second step in a single slot, which lost a valid switch whenever a
   * second press arrived first — 2 then an out-of-range 6 left nothing at all
   * (#163 review). A discrete act does not belong in a latest-value slot
   * beside the continuous controls.
   *
   * Whether the switch is allowed stays the model's call:
   * src/core/dive-model.ts refuses the active cylinder, an empty one, any
   * switch while CCR is set, and a dive that has already failed.
   */
  requestTankSwitch(index: number): void {
    if (!Number.isInteger(index) || index < 0) {
      return;
    }
    const before = this.#model.snapshot;
    const after = this.#model.switchGas(index);
    if (after === before) {
      return;
    }
    // A gas switch ends a fast-forward (src/game-loop.js TASK-019 sets
    // fastForwardActive = false alongside activeTank). The new gas changes
    // the schedule the diver was waiting out, so the sped-up clock stops and
    // they see the new plan at normal speed before choosing to skip again.
    this.#fastForwardActive = false;
    // The save and the forecast both describe the breathed gas, so neither
    // may wait for the next step to hear about it.
    this.#onAuthoritativeState?.(after);
    this.#invalidateForecast();
    this.#publishFrame();
  }

  /**
   * Moves the loop setpoint by a signed number of bar (#163).
   *
   * Whether it is allowed is the model's call — no rebreather, on bailout,
   * failed, or already at the bound all leave the state as it was, and then
   * nothing is published. The forecast is re-requested because the planner
   * breathes the loop at the *target* PO₂ (currentForecastGas), so a new
   * setpoint is a new forecast gas.
   */
  adjustSetpoint(deltaBar: number): void {
    const before = this.#model.snapshot;
    const after = this.#model.adjustSetpoint(deltaBar);
    if (after === before) {
      return;
    }
    this.#onAuthoritativeState?.(after);
    this.#invalidateForecast();
    this.#publishFrame();
  }

  /**
   * Bails out to open circuit (#163). Irreversible, and confirmed by the
   * state rather than a dialog (#67): once onBailout is set the controls
   * that could be pressed again are gone, and DiveModel.bailOut refuses a
   * second one anyway. The forecast changes with the breathed gas.
   */
  bailOut(): void {
    const before = this.#model.snapshot;
    const after = this.#model.bailOut();
    if (after === before) {
      return;
    }
    this.#onAuthoritativeState?.(after);
    this.#invalidateForecast();
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
    // Re-checked every frame, not only on the press, because the conditions
    // are the diver's to break: leave the band, or hold a vertical key, and
    // legacy drops out of fast-forward on that same tick.
    if (this.#fastForwardActive && !this.#fastForwardAvailable()) {
      this.#fastForwardActive = false;
    }
    // One display frame is one model frame (#192): legacy applies the BCD
    // controls once per frame and moves the diver in its sub-steps, so the
    // frame boundaries are part of the behaviour (docs/decisions.md,
    // Architecture). The frame's dive time is legacy's dtReal * timeMultiplier.
    const frameDiveS =
      elapsedS *
      TIME_ACCELERATION *
      (this.#fastForwardActive ? FAST_FORWARD_MULTIPLIER : 1);
    if (frameDiveS > 0) {
      this.#model.advanceWithBuoyancy(
        ROUTE_BOUNDS,
        seconds(frameDiveS),
        this.#buoyancyControls(),
      );
      this.#onAuthoritativeState?.(this.#model.snapshot);
      this.#requestForecast();
    }

    this.#publishFrame();
    this.#animationFrame = requestAnimationFrame(this.#tick);
  };

  #advanceView(elapsedS: number): void {
    const horizontal =
      (this.#pressed.has("right") ? 1 : 0) -
      (this.#pressed.has("left") ? 1 : 0);

    if (horizontal !== 0) {
      this.#facing = horizontal < 0 ? -1 : 1;
    }
    this.#routePositionM = clamp(
      this.#routePositionM + horizontal * FIN_SPEED_MPS * elapsedS,
      MIN_ROUTE_POSITION_M,
      MAX_ROUTE_POSITION_M,
    );
    this.#elapsedRealS += elapsedS;
  }

  /**
   * Legacy's `canFastForward && !keys[w|up|s|down]`, on this client's state.
   *
   * The ceiling is computed here, synchronously, from the model's tissues —
   * as legacy reads frameCalc.ceiling, refreshed on the same tick. It is not
   * taken from the worker's forecast (#163 review round 1): that arrives
   * asynchronously, is refreshed at most every two simulated seconds, and
   * can stay pending for the worker's whole timeout, so while the clock ran
   * at 10x a stop that had already cleared to 15 m would have kept the 18 m
   * answer and the fast-forward with it. calculateCeiling is sixteen
   * compartments of arithmetic and is what the worker itself calls first.
   *
   * The depth is the model's — the one the tissues were last integrated at —
   * rather than the view's, so the decision is a function of authoritative
   * state plus the held controls and not of where the sprite happens to be
   * between steps. A failed dive has nothing left to wait out.
   */
  #fastForwardAvailable(): boolean {
    const state = this.#model.snapshot;
    if (state.failure.reason !== null) {
      return false;
    }
    if (this.#pressed.has("ascend") || this.#pressed.has("descend")) {
      return false;
    }
    return isAtDecoStop(
      state.depthM,
      calculateCeiling(state.tissues, this.#plannerSettings),
    );
  }

  /**
   * W or up inflates the BCD, S or down vents it: src/game-loop.js
   * `wActive` / `sActive` before inflateBCD() and ventBCD().
   */
  #buoyancyControls(): Readonly<BuoyancyControls> {
    return {
      inflate: this.#pressed.has("ascend"),
      vent: this.#pressed.has("descend"),
    };
  }

  #publishFrame(): void {
    const presentation = createPresentationState(
      this.#model.snapshot,
      this.#planner,
    );
    const scene: WreckSceneState = Object.freeze({
      routePositionM: this.#routePositionM,
      diverDepthM: this.#model.snapshot.depthM,
      elapsedRealS: this.#elapsedRealS,
      facing: this.#facing,
      torchOn: this.#torchOn,
      zone: selectWreckZone(this.#routePositionM),
    });
    const fastForward: FastForwardState = Object.freeze({
      available: this.#fastForwardAvailable(),
      active: this.#fastForwardActive,
    });
    this.#renderer.render(presentation, scene);
    this.#onFrame(Object.freeze({ presentation, scene, fastForward }));
  }

  /**
   * Drops the forecast on screen and asks for a new one (#163 review round
   * 2 on PR #182). Called by the acts that change the breathed gas — a
   * cylinder switch, a setpoint, a bailout — because the forecast already
   * shown was computed for the gas the diver has just left: keeping it
   * until the worker answers paired the new breathing state with the old
   * NDL for as long as the worker took, up to its timeout. The HUD shows
   * its unavailable mark instead until the new forecast lands, which is
   * the same thing it shows before the first one.
   */
  #invalidateForecast(): void {
    this.#planner = null;
    this.#requestForecast(true);
  }

  #requestForecast(force = false): void {
    if (this.#disposed) {
      return;
    }
    if (this.#plannerPending) {
      if (force) {
        this.#forcedForecastQueued = true;
      }
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
      .forecast(snapshot, this.#plannerSettings)
      .then((forecast) => {
        // Superseded while in flight: the state it was computed from no
        // longer describes the breathed gas, so it must not become the
        // forecast on screen even for the moment until the replacement
        // lands.
        if (!this.#disposed && !this.#forcedForecastQueued) {
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
        if (this.#forcedForecastQueued && !this.#disposed) {
          this.#forcedForecastQueued = false;
          this.#requestForecast(true);
        }
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
      return;
    }
    // F fast-forwards, as in src/game-loop.js (T took the torch because F was
    // already taken). Claimed only while the control is on offer, for the
    // same reason the digit keys are: preventDefault() on a key that does
    // nothing takes it from whatever else wanted it (#163 review).
    if (
      event.key.toLowerCase() === "f" &&
      !event.repeat &&
      this.#fastForwardAvailable()
    ) {
      event.preventDefault();
      this.toggleFastForward();
      return;
    }
    // [ and ] move the setpoint and B bails out, as src/game-loop.js binds
    // them during a CCR dive, claimed only while the loop is being
    // breathed: on open circuit or after a bailout these keys do nothing,
    // so they are left to whoever else wants them.
    //
    // The setpoint keys repeat while held, as legacy's do: its keydown
    // listener sets keys[k] on every event, autorepeat included, and
    // updateDiving consumes one step per set (#163 review round 3 on
    // PR #182). The bound stops the climb, not the key. B stays
    // edge-triggered — after the first press there is nothing left to bail
    // out of, and the model refuses a second one either way.
    if (this.#loopControlsOffered()) {
      const setpointStep = setpointStepForKey(event.key);
      if (setpointStep !== null) {
        event.preventDefault();
        this.adjustSetpoint(setpointStep);
        return;
      }
      if (event.key.toLowerCase() === "b" && !event.repeat) {
        event.preventDefault();
        this.bailOut();
        return;
      }
    }
    // 1-6 pick a cylinder, as game-loop.js does during the dive. Held keys
    // are ignored: a switch is a discrete act, and autorepeat would re-issue
    // it every few milliseconds.
    // Only as many digits as there are cylinders, because legacy iterates to
    // tankCount rather than to six. With one cylinder, `2` is not a dive key
    // at all and should reach whatever else might want it.
    const tankIndex = tankIndexForKey(event.key);
    if (tankIndex !== null && !event.repeat && this.#canSwitchTank(tankIndex)) {
      event.preventDefault();
      this.requestTankSwitch(tankIndex);
    }
  };

  /**
   * Whether this digit is a cylinder key right now.
   *
   * Claiming a key means calling preventDefault() on it, so it has to be a
   * key that does something. It is not one past the cylinder count — legacy
   * iterates to tankCount — and it is not one on a dive that has already
   * failed, where switchGas refuses anyway (#163 review).
   */
  #canSwitchTank(tankIndex: number): boolean {
    const state = this.#model.snapshot;
    return state.failure.reason === null && tankIndex < state.tanks.length;
  }

  /**
   * Legacy's `diveMode === 'ccr' && !ccrState.onBailout` gate for the
   * setpoint keys and B, plus the failed-dive rule every in-dive control
   * follows. The DOM row in wreck-app.ts hides itself on the same condition.
   */
  #loopControlsOffered(): boolean {
    const state = this.#model.snapshot;
    return (
      state.failure.reason === null &&
      state.ccr !== null &&
      !state.ccr.onBailout
    );
  }

  readonly #handleKeyUp = (event: KeyboardEvent): void => {
    const control = controlForKey(event.key);
    if (control) {
      event.preventDefault();
      this.setControl(control, false);
    }
  };
}

/**
 * The digit keys that can name a cylinder. MAX_TANKS is six, so seven and up
 * are never cylinder keys; the caller narrows this further to the cylinders
 * the dive actually has, which is what legacy's
 * `for (var i = 0; i < tankCount; i++)` does.
 */
function tankIndexForKey(key: string): number | null {
  if (!/^[1-6]$/.test(key)) {
    return null;
  }
  return Number.parseInt(key, 10) - 1;
}

/**
 * `[` lowers and `]` raises, by one CCR_SP_STEP — src/game-loop.js, and the
 * same pair the setup screen binds so the two screens agree.
 */
function setpointStepForKey(key: string): number | null {
  switch (key) {
    case "[":
      return -CCR_SETPOINT_STEP_BAR;
    case "]":
      return CCR_SETPOINT_STEP_BAR;
    default:
      return null;
  }
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

/**
 * A resumed dive saved outside the route's bounds, such as a legacy save at
 * 12 m, starts at the nearest bound, at rest and neutral there (#198
 * pre-review). The physics would clamp the depth on the first frame but keep
 * the saved BCD gas, so a diver moved from 12 m to 18 m would arrive heavy and
 * sink to the floor on its own. At rest and neutral is how a save without
 * live motion resumes (src/save/save-game.ts, v6).
 */
function withinRoute(state: DiveState): DiveState {
  const depthM = clamp(state.depthM, ROUTE_BOUNDS.ceilingM, ROUTE_BOUNDS.floorM);
  if (depthM === state.depthM) {
    return state;
  }
  return freezeDiveState({
    ...state,
    depthM: metres(depthM),
    maxDepthM: metres(Math.max(state.maxDepthM, depthM)),
    verticalVelocityMpm: 0,
    bcdGasSurfaceLiters: neutralBcdSurfaceLitres(depthM),
  });
}

/**
 * The wreck slice's starting state, optionally configured by the setup screen.
 *
 * Exported so the composition root can build a state from a DiveSetup without
 * duplicating the route's start depth, which is a controller constant and not
 * the setup screen's business (#158).
 */
export function createWreckInitialState(
  options: InitialDiveOptions = {},
): DiveState {
  // The slice starts mid-water at START_DEPTH_M, where legacy's dives start
  // at the surface with 2 L in the BCD and descend. That much gas at 26 m
  // would sink the diver to the floor at once, so the dive starts neutral
  // there, as legacy's neutralizeAt() sets it (#192).
  const initial = createInitialDiveState(0x57524543, {
    ...options,
    bcdGasSurfaceLiters:
      options.bcdGasSurfaceLiters ?? neutralBcdSurfaceLitres(START_DEPTH_M),
  });
  return freezeDiveState({
    ...initial,
    depthM: metres(START_DEPTH_M),
    maxDepthM: metres(START_DEPTH_M),
  });
}
