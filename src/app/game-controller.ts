import {
  createSafetyStopState,
  CCR_SETPOINT_STEP_BAR,
  createInitialDiveState,
  type InitialDiveOptions,
  freezeDiveState,
  type DiveState,
} from "../core/dive-state";
import {
  DiveModel,
  SAFETY_STOP_NEEDED_BELOW_M,
  isAtSafetyStop,
  isDiveOver,
} from "../core/dive-model";
import {
  neutralBcdSurfaceLitres,
  type BuoyancyControls,
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
import {
  OPEN_WATER_FLOOR_M,
  ROUTE_START_POSITION_M,
  moveAlongRoute,
  routeSpaceNear,
} from "../sites/wreck-route";

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
  /**
   * The diver floats at the surface and the dive has not begun: legacy's
   * 'surface' state, which waits for S (#199). The HUD says how to begin.
   */
  readonly awaitingDescent: boolean;
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
  #routePositionM = ROUTE_START_POSITION_M;
  /**
   * Legacy's 'surface' state (src/game-loop.js updateSurface): the diver
   * floats at the entry, the dive clock does not run, and nothing but S
   * starts anything. Set for a dive that has not begun, fresh or saved
   * before its first second.
   */
  #awaitingDescent: boolean;
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
      // The log's ceiling and NDL at the dive's GF high, as the forecast.
      { gradientFactorHighPercent: this.#plannerSettings.gfHighPercent },
    );
    this.#awaitingDescent = hasNotBegun(this.#model.snapshot);
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
      // S at the surface begins the dive (src/game-loop.js updateSurface:
      // `keys['s'] || keys['arrowdown']` sets gameState = 'diving'), with
      // legacy's 2 L in the BCD, at rest, and the loop's PO2 there. A fresh
      // dive already holds those; a legacy save written at the surface holds
      // 0 L (#223 pre-review). The key stays held, so the next frame vents,
      // as legacy's next updateDiving() does.
      if (control === "descend" && this.#awaitingDescent) {
        this.#awaitingDescent = false;
        this.#model.leaveSurface();
      }
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

  /**
   * Legacy reads T inside updateDiving() (src/game-loop.js D6), so the torch
   * works only while diving: not while the dive waits at the surface, nor
   * once it has ended (#223 Codex round 1).
   */
  toggleTorch(): void {
    if (!this.#torchAvailable()) {
      return;
    }
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
    // Legacy reads the digit keys only in updateDiving(), never at the
    // surface (#223 pre-review).
    if (!Number.isInteger(index) || index < 0 || this.#awaitingDescent) {
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
    // Only in updateDiving(), as the cylinder keys (#223 pre-review).
    if (this.#awaitingDescent) {
      return;
    }
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
    // Only in updateDiving(): at the surface an irreversible bailout would
    // otherwise begin the dive on open circuit (#223 pre-review).
    if (this.#awaitingDescent) {
      return;
    }
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
    if (frameDiveS > 0 && !this.#awaitingDescent) {
      // The bounds where the diver is (#199): the surface outside the wreck,
      // the deck inside it. Under the deck is legacy's inOverhead, which
      // runs the rule of thirds.
      const space = routeSpaceNear(
        this.#routePositionM,
        this.#model.snapshot.depthM,
      );
      this.#model.advanceWithBuoyancy(
        space,
        seconds(frameDiveS),
        this.#buoyancyControls(),
        space.inOverhead,
      );
      this.#onAuthoritativeState?.(this.#model.snapshot);
      this.#requestForecast();
    } else if (frameDiveS > 0) {
      // Waiting at the surface the state does not change, but legacy's
      // autosave runs in its 'surface' state as in 'diving' (gameLoop), so a
      // dive left before its descent resumes there too.
      this.#onAuthoritativeState?.(this.#model.snapshot);
    }

    this.#publishFrame();
    this.#animationFrame = requestAnimationFrame(this.#tick);
  };

  #advanceView(elapsedS: number): void {
    const horizontal =
      (this.#pressed.has("right") ? 1 : 0) -
      (this.#pressed.has("left") ? 1 : 0);

    // A dive that has ended moves no more, its waves included: legacy's
    // post-dive state draws no scene (#223 Codex round 1).
    if (isDiveOver(this.#model.snapshot)) {
      return;
    }
    // At the surface before the dive the waves move, but legacy's
    // updateSurface reads S and nothing else.
    this.#elapsedRealS += elapsedS;
    if (this.#awaitingDescent) {
      return;
    }
    if (horizontal !== 0) {
      this.#facing = horizontal < 0 ? -1 : 1;
    }
    // The hull stops the diver as legacy's structures do (#199).
    this.#routePositionM = moveAlongRoute(
      this.#routePositionM,
      this.#routePositionM + horizontal * FIN_SPEED_MPS * elapsedS,
      this.#model.snapshot.depthM,
    );
  }

  #torchAvailable(): boolean {
    return !this.#awaitingDescent && !isDiveOver(this.#model.snapshot);
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
   * between steps. A dive that has ended, or not begun, has nothing to wait
   * out.
   *
   * The other half of canFastForward is the safety stop (#199): its
   * countdown under way and the diver in its band, legacy's atSafetyStop.
   * It waited for #206 until the route could reach the band.
   */
  #fastForwardAvailable(): boolean {
    const state = this.#model.snapshot;
    if (isDiveOver(state) || this.#awaitingDescent) {
      return false;
    }
    if (this.#pressed.has("ascend") || this.#pressed.has("descend")) {
      return false;
    }
    return (
      isAtDecoStop(
        state.depthM,
        calculateCeiling(state.tissues, this.#plannerSettings),
      ) || isAtSafetyStop(state)
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
    const depthM = this.#model.snapshot.depthM;
    const scene: WreckSceneState = Object.freeze({
      routePositionM: this.#routePositionM,
      diverDepthM: depthM,
      elapsedRealS: this.#elapsedRealS,
      facing: this.#facing,
      torchOn: this.#torchOn,
      // Over the hold but above its deck is open water, not the hold.
      zone: routeSpaceNear(this.#routePositionM, depthM).inOverhead
        ? selectWreckZone(this.#routePositionM)
        : "exterior",
    });
    const fastForward: FastForwardState = Object.freeze({
      available: this.#fastForwardAvailable(),
      active: this.#fastForwardActive,
    });
    this.#renderer.render(presentation, scene);
    this.#onFrame(
      Object.freeze({
        presentation,
        scene,
        fastForward,
        awaitingDescent: this.#awaitingDescent,
      }),
    );
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
      .forecast(snapshot, {
        ...this.#plannerSettings,
        // The two flags legacy's calculateTTS() reads from the dive: the
        // stop is needed, and the NDL fell below 5 (the long stop). They
        // were always false here until the dive kept them (#199).
        safetyStopNeeded: snapshot.safetyStop.needed,
        ndlDroppedBelowFiveMinutes: snapshot.log.ndlDroppedBelowFiveMinutes,
      })
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
    // A dive that has ended moves no more and has no torch to work, so its
    // movement keys and T are left to whatever else wants them, as every
    // other dive key is (#223 pre-review).
    if (isDiveOver(this.#model.snapshot)) {
      return;
    }
    const control = controlForKey(event.key);
    if (control) {
      event.preventDefault();
      this.setControl(control, true);
      return;
    }
    if (
      event.key.toLowerCase() === "t" &&
      !event.repeat &&
      this.#torchAvailable()
    ) {
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
    return (
      !isDiveOver(state) &&
      !this.#awaitingDescent &&
      tankIndex < state.tanks.length
    );
  }

  /**
   * Legacy's `diveMode === 'ccr' && !ccrState.onBailout` gate for the
   * setpoint keys and B, plus the failed-dive rule every in-dive control
   * follows, and not while the dive waits at the surface, where legacy reads
   * them nowhere. The DOM row in wreck-app.ts hides itself on the same
   * condition.
   */
  #loopControlsOffered(): boolean {
    const state = this.#model.snapshot;
    return (
      !isDiveOver(state) &&
      !this.#awaitingDescent &&
      state.ccr !== null &&
      !state.ccr.onBailout
    );
  }

  readonly #handleKeyUp = (event: KeyboardEvent): void => {
    const control = controlForKey(event.key);
    if (control) {
      // Released whatever the dive's state, so no control stays held; only
      // claimed while the dive still takes it.
      if (!isDiveOver(this.#model.snapshot)) {
        event.preventDefault();
      }
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

/**
 * A dive that has not begun: at the surface with no time on the clock, which
 * is what legacy's 'surface' state saves as. Anything that has run a frame
 * has a clock.
 */
function hasNotBegun(state: DiveState): boolean {
  return state.elapsedTimeS === 0 && state.depthM === 0 && !isDiveOver(state);
}

/**
 * A resumed dive picks up at the route's start, in open water beside the
 * wreck, because the save does not record the route position (nor does
 * legacy's diverX). There the water runs from the surface to the floor, so
 * only a dive saved below the floor, such as a legacy save at 40 m, has to
 * move: to the floor, at rest and neutral there (#198 pre-review). The physics
 * would clamp the depth on the first frame but keep the saved BCD gas, so a
 * diver moved up from 40 m would arrive light and rise on its own. At rest and
 * neutral is how a save without live motion resumes (src/save/save-game.ts,
 * v6).
 */
function withinRoute(state: DiveState): DiveState {
  const depthM = Math.min(state.depthM, OPEN_WATER_FLOOR_M);
  if (depthM === state.depthM) {
    return state;
  }
  const maxDepthM = Math.max(state.maxDepthM, depthM);
  return freezeDiveState({
    ...state,
    depthM: metres(depthM),
    maxDepthM: metres(maxDepthM),
    verticalVelocityMpm: 0,
    bcdGasSurfaceLiters: neutralBcdSurfaceLitres(depthM),
    // Moved below 11 m, where the model resets the safety stop on every
    // step: reset it now, as the first step would, so the moved state is one
    // the model could have left and saves before that step (#206 pre-review).
    safetyStop:
      depthM > SAFETY_STOP_NEEDED_BELOW_M
        ? {
            ...createSafetyStopState(),
            needed: maxDepthM > SAFETY_STOP_NEEDED_BELOW_M,
          }
        : state.safetyStop,
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
  // At the surface, as legacy's dives start (owner decision on #199,
  // 2026-09-30): 2 L in the BCD, at rest, until S begins the descent.
  return createInitialDiveState(0x57524543, options);
}
