import type {
  PresentationSafetyStop,
  PresentationState,
  RuleOfThirdsPhase,
} from "../presentation/presentation-state";
import { FAST_ASCENT_RATE_MPM } from "../core/dive-model";
import { WebAudioService } from "../audio/audio-service";
import type { DiveState } from "../core/dive-state";
import { LocalSaveRepository } from "../save/save-repository";
import {
  plannerSettingsWithGradientFactors,
  type PlannerSettings,
} from "../planner/dive-planner";
import {
  createSelectedRenderer,
  type WreckZone,
} from "../render/renderer";
import {
  DIVE_COMPUTER_LOCALE,
  detectPreferredLocale,
  diveComputerText,
  translate,
  type DiveComputerKey,
  type MessageKey,
  type SupportedLocale,
} from "./i18n/catalog";
import {
  formatDepth,
  formatDuration,
  formatGasFraction,
  formatPartialPressure,
  formatPercent,
  formatPressure,
  formatVerticalRate,
  formatWholeMinutes,
} from "./i18n/formatters";
import { CCR_SETPOINT_STEP_BAR } from "../core/dive-state";
import { selectLoopRowDanger } from "./loop-danger";
import { renderSetupScreen } from "./setup/setup-screen";
import { renderGameOverScreen } from "./game-over";
import { renderPostDiveScreen } from "./post-dive";
import { createPostDiveSummary } from "../presentation/post-dive-summary";
import { siteGameplay } from "../sites/site-resources";
import { isTurnBeepDue } from "./thirds-turn-beep";
import {
  isWarningBeepActive,
  selectWarning,
  type WarningSeverity,
} from "./hud-warning";

/** src/game-loop.js SAVE_INTERVAL_MS: an autosave at most every 3 real seconds. */
const SAVE_INTERVAL_MS = 3000;
import { createGasInfo, ndlText, syncGasInfo, type GasInfoElements } from "./gas-info";
import {
  gasInfoAvailable,
  gasInfoPageStillValid,
  nextGasInfoPage,
  type GasInfoPage,
} from "./gas-info-pages";
import {
  toInitialDiveOptions,
  toPlannerSettings,
  type DiveMode,
  type DiveSetup,
  type SiteId,
} from "./setup/dive-setup";
import {
  GameController,
  createWreckInitialState,
  type ContinuousControl,
  type GameFrame,
} from "./game-controller";

interface HudElements {
  readonly shell: HTMLElement;
  readonly viewport: HTMLElement;
  readonly depth: HTMLElement;
  readonly time: HTMLElement;
  readonly gas: HTMLElement;
  readonly cylinder: HTMLElement;
  readonly setpoint: HTMLElement;
  readonly loopPo2: HTMLElement;
  readonly oxygenCylinder: HTMLElement;
  readonly diluentCylinder: HTMLElement;
  readonly scrubber: HTMLElement;
  readonly ndl: HTMLElement;
  readonly ascentRate: HTMLElement;
  readonly safetyStop: HTMLElement;
  readonly thirds: HTMLElement;
  readonly zone: HTMLElement;
  readonly status: HTMLElement;
  readonly speed: HTMLElement;
  readonly warning: HTMLElement;
  readonly tanks: HTMLElement;
  readonly ccr: HTMLElement;
  readonly movement: readonly HTMLButtonElement[];
  readonly torch: HTMLButtonElement;
  readonly fastForward: HTMLButtonElement;
  readonly mute: HTMLButtonElement;
  readonly gasInfo: GasInfoElements;
  readonly surfacePrompt: HTMLElement;
}

const zoneMessageKeys: Record<WreckZone, MessageKey> = {
  exterior: "wreck.zone.exterior",
  "cargo-hold": "wreck.zone.cargo-hold",
  "engine-room": "wreck.zone.engine-room",
};

// The chip in the topbar and the alert paragraph describe the same state at
// two lengths, so both are derived from one severity rather than chosen
// separately. #138: `updateHud` used to set `has-warning` from the warning
// selection and then overwrite the chip with the normal string three lines
// later, so a failing dive still read "Simulation running" and the only thing
// saying otherwise was the chip turning red — meaning encoded through colour
// alone, which docs/decisions.md:100 rules out. src/app/hud-warning.ts
// chooses the severity.

// The dive computer reads English in every locale (#232): its labels, its
// warnings and the numbers it shows, which DC formats. Everything else here
// takes the player's locale.
const DC = DIVE_COMPUTER_LOCALE;

// Full sentence for the role=alert region. Both maps are the dive
// computer's (#232), English in every locale.
const warningAlertKeys: Record<WarningSeverity, DiveComputerKey> = {
  lowGas: "diveComputer.alert.lowGas",
  scrubberLow: "diveComputer.alert.scrubberLow",
  oxygen: "diveComputer.alert.oxygen",
  fastAscent: "diveComputer.alert.fastAscent",
  co2: "diveComputer.alert.co2",
  failure: "diveComputer.alert.failure",
  ceiling: "diveComputer.alert.ceiling",
  reserve: "diveComputer.alert.reserve",
  lowNdl: "diveComputer.alert.lowNdl",
  narcosis: "diveComputer.alert.narcosis",
};

// Short form for the status chip, which sits in the topbar away from the
// alert text and has to stand on its own.
const warningStatusKeys: Record<WarningSeverity, DiveComputerKey> = {
  lowGas: "diveComputer.status.lowGas",
  scrubberLow: "diveComputer.status.scrubberLow",
  oxygen: "diveComputer.status.oxygen",
  fastAscent: "diveComputer.status.fastAscent",
  co2: "diveComputer.status.co2",
  failure: "diveComputer.status.failure",
  ceiling: "diveComputer.status.ceiling",
  reserve: "diveComputer.status.reserve",
  lowNdl: "diveComputer.status.lowNdl",
  narcosis: "diveComputer.status.narcosis",
};

const thirdsPhaseKeys: Record<RuleOfThirdsPhase, DiveComputerKey> = {
  outbound: "diveComputer.thirds.outbound",
  turn: "diveComputer.thirds.turn",
  reserve: "diveComputer.thirds.reserve",
};

const safetyStopPhaseKeys: Record<PresentationSafetyStop["phase"], DiveComputerKey> = {
  planned: "diveComputer.safetyStop.planned",
  running: "diveComputer.safetyStop.running",
  paused: "diveComputer.safetyStop.paused",
  complete: "diveComputer.safetyStop.complete",
};

export function renderWreckApplication(
  root: HTMLElement,
  locale: SupportedLocale = detectPreferredLocale(),
): void {
  document.documentElement.lang = locale;
  document.title = translate(locale, "wreck.brand");

  const gate = createSafetyGate(locale);
  root.replaceChildren(gate);
  const accept = gate.querySelector<HTMLButtonElement>("[data-accept-safety]");
  if (!accept) {
    throw new Error("safety acceptance control was not created");
  }

  accept.addEventListener("click", () => {
    accept.disabled = true;
    showSetupScreen(root, locale);
  });
}

// Gate -> setup -> dive. The setup screen owns a keyboard listener, so its
// disposer runs before anything else is mounted; leaving it attached would
// let `1`-`8` keep reconfiguring a dive that had already started.
function showSetupScreen(
  root: HTMLElement,
  locale: SupportedLocale,
  initialSetup?: DiveSetup,
): void {
  const dispose = renderSetupScreen(root, {
    locale,
    ...(initialSetup ? { initialSetup } : {}),
    onStart: (setup) => {
      dispose();
      if (!isRenderableSite(setup.siteId)) {
        renderUnavailableSite(root, locale);
        return;
      }
      void startWreckSimulation(root, locale, setup).catch(
        (error: unknown) => {
          console.error(error);
          renderStartError(root, locale);
        },
      );
    },
  });
}

// Which sites the renderer can draw is a composition-root fact, not the setup
// screen's: dive-setup.ts offers all four authored sites and this decides what
// to do with one that has no scene yet (#158). The list grows as #164-#167
// land, and the screen needs no edit for it.
const RENDERABLE_SITES: readonly SiteId[] = ["wreck"];

function isRenderableSite(siteId: SiteId): boolean {
  return RENDERABLE_SITES.includes(siteId);
}

function renderUnavailableSite(
  root: HTMLElement,
  locale: SupportedLocale,
): void {
  const panel = document.createElement("section");
  panel.className = "start-error";
  panel.dataset.unavailableSite = "true";
  const heading = createElement(
    "h1",
    "",
    translate(locale, "setup.unavailableSite.heading"),
  );
  const body = createElement(
    "p",
    "",
    translate(locale, "setup.unavailableSite.body"),
  );
  const back = document.createElement("button");
  back.type = "button";
  back.className = "primary-action";
  back.dataset.backToSetup = "true";
  back.textContent = translate(locale, "setup.unavailableSite.back");
  back.addEventListener("click", () => showSetupScreen(root, locale));

  panel.append(heading, body, back);
  root.replaceChildren(panel);
}

function createSafetyGate(locale: SupportedLocale): HTMLElement {
  const gate = document.createElement("section");
  gate.className = "safety-gate";
  gate.setAttribute("aria-labelledby", "safety-heading");

  const eyebrow = createElement(
    "p",
    "safety-eyebrow",
    translate(locale, "wreck.safety.eyebrow"),
  );
  const heading = createElement(
    "h1",
    "safety-heading",
    translate(locale, "wreck.safety.heading"),
  );
  heading.id = "safety-heading";
  const summary = createElement(
    "p",
    "safety-summary",
    translate(locale, "wreck.safety.summary"),
  );
  const notices = document.createElement("ul");
  notices.className = "safety-notices";
  for (const key of [
    "wreck.safety.training",
    "wreck.safety.emergency",
  ] as const) {
    const item = document.createElement("li");
    item.textContent = translate(locale, key);
    notices.append(item);
  }

  const methodology = document.createElement("details");
  methodology.id = "safety-methodology";
  methodology.className = "methodology";
  const methodologyHeading = document.createElement("summary");
  methodologyHeading.textContent = translate(
    locale,
    "wreck.safety.methodologyHeading",
  );
  const methodologyCopy = document.createElement("p");
  methodologyCopy.textContent = translate(locale, "wreck.safety.methodology");
  methodology.append(methodologyHeading, methodologyCopy);

  const actions = document.createElement("div");
  actions.className = "safety-actions";
  const accept = document.createElement("button");
  accept.type = "button";
  accept.dataset.acceptSafety = "true";
  accept.className = "primary-action";
  accept.textContent = translate(locale, "wreck.safety.accept");
  // No second action beside it. This used to link to
  // /src/diving-simulator.html, which only resolves when the legacy client is
  // served from the same origin — in a dist/-only package, and so in any
  // Capacitor build, it is a dead link on the first screen a player sees
  // (#161, #137 §4.8). The legacy client stays reachable at its own URL for as
  // long as it is deployed; it is not this shell's job to advertise it.
  actions.append(accept);

  gate.append(eyebrow, heading, summary, notices, methodology, actions);
  return gate;
}

async function startWreckSimulation(
  root: HTMLElement,
  locale: SupportedLocale,
  setup: DiveSetup,
): Promise<void> {
  const repository = new LocalSaveRepository(window.localStorage);
  const loadResult = repository.load();
  const resumed = loadResult.status === "loaded" ? loadResult.saveGame : null;
  // A save of a dive that has already ended at the surface is not resumed
  // into a dive the model would move no further: it shows its debriefing, as
  // the dive would have on that tick. No client writes one now, since a
  // completed dive clears its save on that tick (#223), but the codec accepts
  // one from v12 on.
  if (resumed?.state.completed) {
    endInPostDive(root, locale, setup, repository, resumed.state);
    return;
  }
  const hud = createWreckShell(locale);
  root.replaceChildren(hud.shell);
  const audio = new WebAudioService();
  const audioResume = audio.resume();
  const renderer = await createSelectedRenderer();
  // The dive and the factors it is planned with have to come from the same
  // place. Taking the state from the save and the factors from the setup
  // screen the reload had just drawn continued a 50/80 dive on 35/75: same
  // tissues, same gas, same clock, different ceiling (#158 review).
  const plannerSettings = resumed
    ? plannerSettingsWithGradientFactors(
        resumed.gradientFactors.lowPercent,
        resumed.gradientFactors.highPercent,
      )
    : toPlannerSettings(setup);
  // The mode travels like the gradient factors: from the save when the dive
  // is resumed, from the setup screen when it is new (#185 review).
  const diveMode: DiveMode = resumed ? resumed.diveMode : setup.mode;
  // Legacy saves every 3 real seconds (src/game-loop.js SAVE_INTERVAL_MS).
  // Counting dive seconds instead saved every 0.17 real seconds under
  // fast-forward, and the save now carries the depth profile (#204
  // pre-review).
  let lastSaveMs = performance.now();
  let gasInfoPage: GasInfoPage | null = null;
  let lastPresentation: PresentationState | null = null;
  // Set when the dive ends, in a failure or at the surface. From then on
  // nothing is saved: legacy clears the save once it has left 'diving'
  // (game-loop.js maybeSaveDiveState() saves only in 'diving', 'surface' and
  // 'drill'; clearSavedDive()), because an ended dive is not one to resume.
  let ended = false;
  let thirdsTurnWarned: boolean | null = null;
  const controller = new GameController({
    renderer,
    // A restored save still wins over the setup, which is existing resume
    // behaviour and not this slice's to change: the configuration applies to a
    // fresh dive. The two meeting — configure a gas, get a resumed dive — is a
    // real gap, and it belongs with the resume UX (#67 class), not here.
    initialState:
      resumed?.state ?? createWreckInitialState(toInitialDiveOptions(setup)),
    // The configured gradient factors, or the planner keeps using its
    // defaults and the GF controls change a number nobody reads (#158 review).
    plannerSettings,
    onAuthoritativeState: (state) => {
      if (ended) {
        return;
      }
      // Completion (#159): legacy switches to its post-dive screen on the
      // tick the diver surfaces. The save is cleared on that first completed
      // state, before anything could write it again, as legacy's
      // clearSavedDive() (#223 pre-review). The teardown waits for a
      // microtask, as the game over's does, so the controller is not
      // destroyed from inside its own frame callback; the debriefing reads
      // this state, which the model no longer moves.
      if (state.completed) {
        ended = true;
        clearSave(repository);
        queueMicrotask(() => {
          teardown();
          endInPostDive(root, locale, setup, repository, state);
        });
        return;
      }
      const nowMs = performance.now();
      if (nowMs - lastSaveMs > SAVE_INTERVAL_MS) {
        saveState(repository, state, plannerSettings, diveMode);
        lastSaveMs = nowMs;
      }
    },
    onFrame: (frame) => {
      // Game over (#159): legacy switches to its game-over screen on the tick
      // the dive fails. The teardown waits for a microtask so the controller
      // is not destroyed from inside its own frame callback.
      if (frame.presentation.status === "failed" && !ended) {
        ended = true;
        const failed = frame.presentation;
        queueMicrotask(() => endInGameOver(failed));
        return;
      }
      if (ended) {
        return;
      }
      updateHud(hud, frame, locale);
      lastPresentation = frame.presentation;
      // A page the dive no longer has closes: legacy leaves infoPageMode
      // behind the game-over screen, where it is not drawn.
      if (!gasInfoPageStillValid(gasInfoPage, frame.presentation, diveMode)) {
        gasInfoPage = null;
      }
      syncGasInfo(
        hud.gasInfo,
        gasInfoPage,
        gasInfoAvailable(frame.presentation, diveMode),
        frame.presentation,
        plannerSettings,
      );
      audio.update({
        elapsedRealS: frame.scene.elapsedRealS,
        warningActive: isWarningBeepActive(frame.presentation),
      });
      // Legacy's playAlertBeep() as the turn of the rule of thirds latches
      // (src/game-loop.js, Issue #27): once, on the frame it latches. A dive
      // resumed past its turn has latched already, so the first frame only
      // takes the value.
      const turnWarned = frame.presentation.ruleOfThirds?.turnWarned ?? false;
      if (isTurnBeepDue(thirdsTurnWarned, turnWarned)) {
        audio.play("alert.warning");
      }
      thirdsTurnWarned = turnWarned;
    },
  });

  bindContinuousControl(hud.shell, controller);
  bindTankControls(hud.tanks, controller);
  bindLoopControls(hud.ccr, controller);
  hud.torch.addEventListener("click", () => controller.toggleTorch());
  hud.fastForward.addEventListener("click", () =>
    controller.toggleFastForward(),
  );
  // Gas information (#163). UI state only — which page is open changes
  // nothing the model or the save knows about, so it lives here and not in
  // the controller. The key and the button both walk the same cycle.
  const cycleGasInfo = () => {
    if (!lastPresentation) {
      return;
    }
    gasInfoPage = nextGasInfoPage(gasInfoPage, lastPresentation, diveMode);
    syncGasInfo(
      hud.gasInfo,
      gasInfoPage,
      gasInfoAvailable(lastPresentation, diveMode),
      lastPresentation,
      plannerSettings,
    );
  };
  hud.gasInfo.toggle.addEventListener("click", cycleGasInfo);
  // I walks the pages and Escape closes them, as src/state.js binds both.
  // Each is claimed only when it does something, like every dive key here;
  // a modified I (Ctrl+I and the like) is the browser's.
  const handleGasInfoKey = (event: KeyboardEvent) => {
    if (!lastPresentation || event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }
    if (
      event.key.toLowerCase() === "i" &&
      !event.repeat &&
      gasInfoAvailable(lastPresentation, diveMode)
    ) {
      event.preventDefault();
      cycleGasInfo();
    } else if (event.key === "Escape" && gasInfoPage !== null) {
      event.preventDefault();
      gasInfoPage = null;
      syncGasInfo(
        hud.gasInfo,
        null,
        gasInfoAvailable(lastPresentation, diveMode),
        lastPresentation,
        plannerSettings,
      );
    }
  };
  window.addEventListener("keydown", handleGasInfoKey);
  hud.mute.addEventListener("click", () => {
    audio.setMuted(!audio.muted);
    hud.mute.setAttribute("aria-pressed", String(audio.muted));
  });
  const handleVisibility = () => {
    const action = document.hidden ? audio.suspend() : audio.resume();
    void action.catch((error: unknown) => console.error(error));
  };
  document.addEventListener("visibilitychange", handleVisibility);
  // Legacy is silent after the dive: its only beep is drawn with the dive
  // computer, which neither its post-dive nor its game-over state draws. The
  // teardown destroys the sound with the dive, so a dive surfaced on low gas
  // does not go on sounding its alarm (#223 pre-review).
  const teardown = () => {
    document.removeEventListener("visibilitychange", handleVisibility);
    window.removeEventListener("keydown", handleGasInfoKey);
    // Removed here too, not only by its own `once`: after a game over the
    // page stays open, and each ended dive would otherwise keep its
    // destroyed controller, renderer and HUD reachable (#190 pre-review).
    window.removeEventListener("pagehide", handlePageHide);
    controller.destroy();
    audio.destroy();
  };
  const endInGameOver = (failed: Readonly<PresentationState>) => {
    teardown();
    clearSave(repository);
    const disposeGameOver = renderGameOverScreen(root, {
      locale,
      content: {
        // status "failed" means failureReason is set.
        reason: failed.failureReason!,
        elapsedTimeS: failed.elapsedTimeS,
        maxDepthM: failed.maxDepthM,
        // The only site that renders is the wreck (RENDERABLE_SITES).
        overhead: siteGameplay("wreck")?.hasOverhead ?? false,
      },
      // Back to the setup, keeping what was configured, as legacy's Enter
      // returns to its gas setup with the same settings. For a resumed dive
      // this is the setup screen that preceded the resume, not the save's
      // settings; that gap belongs to the resume flow (#191).
      onRetry: () => {
        disposeGameOver();
        showSetupScreen(root, locale, setup);
      },
    });
  };
  function handlePageHide(): void {
    if (ended) {
      return;
    }
    if (!controller.authoritativeState.completed) {
      saveState(repository, controller.authoritativeState, plannerSettings, diveMode);
    }
    teardown();
  }
  window.addEventListener("pagehide", handlePageHide, { once: true });
  try {
    await audioResume;
    await controller.start(hud.viewport);
  } catch (error) {
    controller.destroy();
    audio.destroy();
    throw error;
  }
}

function saveState(
  repository: LocalSaveRepository,
  state: DiveState,
  settings: Readonly<PlannerSettings>,
  diveMode: DiveMode,
): void {
  try {
    repository.save(
      state,
      {
        lowPercent: settings.gfLowPercent,
        highPercent: settings.gfHighPercent,
      },
      Date.now(),
      diveMode,
    );
  } catch (error) {
    console.error(error);
  }
}

/** Clearing can throw where storage is blocked; the dive ends regardless. */
function clearSave(repository: LocalSaveRepository): void {
  try {
    repository.clear();
  } catch (error) {
    console.error(error);
  }
}

/**
 * The end of a dive at the surface (#159): the save is cleared, as legacy
 * clears it once the dive has left 'diving', and the debriefing is shown.
 * Diving again returns to the setup as it was, as legacy's Enter returns to
 * its gas setup with the same settings.
 */
function endInPostDive(
  root: HTMLElement,
  locale: SupportedLocale,
  setup: DiveSetup,
  repository: LocalSaveRepository,
  state: DiveState,
): void {
  clearSave(repository);
  const dispose = renderPostDiveScreen(root, {
    locale,
    summary: createPostDiveSummary(state, {
      // The only site that renders is the wreck (RENDERABLE_SITES).
      overheadSite: siteGameplay("wreck")?.hasOverhead ?? false,
    }),
    onDiveAgain: () => {
      dispose();
      showSetupScreen(root, locale, setup);
    },
  });
}

function createWreckShell(locale: SupportedLocale): HudElements {
  const shell = document.createElement("section");
  shell.className = "wreck-shell";

  const topbar = document.createElement("header");
  topbar.className = "wreck-topbar";
  const identity = document.createElement("div");
  identity.append(
    createElement("p", "wreck-eyebrow", translate(locale, "wreck.preview")),
    createElement("h1", "wreck-title", translate(locale, "wreck.site")),
  );
  const status = createElement(
    "p",
    "status-chip",
    translate(locale, "wreck.hud.normal"),
  );
  // Deliberately NOT a live region, and deliberately unnamed.
  //
  // The chip carried aria-label="Simulation status", which ARIA prohibits on
  // role=paragraph — conforming AT already discarded it, so it never named
  // anything. The obvious repair is role=status, and that is wrong here: it
  // would make this a second live region fed by the same severity as the
  // role=alert paragraph below, so every warning would be announced twice —
  // once assertively, then again from the queued polite update.
  //
  // The alert region owns announcement. This chip exists for the sighted
  // reader who cannot rely on the colour, and its own text says which state
  // it is in ("Simulation running", "⚠ Dive failure"), so it reads correctly
  // in document order without a name.
  const topbarActions = document.createElement("div");
  topbarActions.className = "topbar-actions";
  // Says in words that the dive clock is running ten times faster (#163).
  // Hidden rather than empty when it is not, so the topbar does not reserve
  // a blank pill; and not a live region — a change of clock speed is the
  // diver's own doing, not a warning to announce over their action.
  const speed = createElement(
    "p",
    "speed-chip",
    translate(locale, "wreck.hud.fastForward"),
  );
  speed.dataset.fastForwardIndicator = "true";
  speed.hidden = true;
  const mute = document.createElement("button");
  mute.type = "button";
  mute.className = "audio-control";
  mute.setAttribute("aria-label", translate(locale, "wreck.controls.mute"));
  mute.setAttribute("aria-pressed", "false");
  mute.textContent = translate(locale, "wreck.symbol.audio");
  const gasInfo = createGasInfo(locale);
  topbarActions.append(speed, status, gasInfo.toggle, mute);
  topbar.append(identity, topbarActions);

  const viewport = document.createElement("div");
  viewport.className = "wreck-viewport";
  viewport.setAttribute("data-wreck-viewport", "true");

  const hud = document.createElement("dl");
  hud.className = "wreck-hud";
  // The dive computer's language (#232), so a German screen reader reads its
  // English as English: the visible text is each row's only name, and lang
  // makes what is heard agree with what is shown. The location row is not
  // the dive computer's and keeps the page's language.
  hud.lang = DC;
  const unavailable = translate(DC, "wreck.value.unavailable");
  const depth = appendMetric(hud, "depth", diveComputerText("diveComputer.depth"), unavailable);
  // Legacy's ascent chevrons and rate beside the depth (#197), with the
  // direction as an arrow and the number in words' place.
  const ascentRate = appendMetric(
    hud,
    "ascentRate",
    diveComputerText("diveComputer.ascentRate"),
    unavailable,
  );
  const time = appendMetric(hud, "time", diveComputerText("diveComputer.time"), unavailable);
  const gas = appendMetric(hud, "gas", diveComputerText("diveComputer.gas"), unavailable);
  // Which cylinder is being breathed (#163). Until this row existed the only
  // trace of a switch was the gas pressure changing, so the tests read the
  // save to learn the active index — the HUD half the issue asks for.
  const cylinder = appendMetric(
    hud,
    "cylinder",
    diveComputerText("diveComputer.cylinder"),
    unavailable,
  );
  // The rebreather's rows (#163): what src/renderer.js draws in the CCR gas
  // box in place of the open-circuit one — SP, PO2, O2, DIL, SCR. Hidden
  // until updateHud sees a loop, and the open-circuit gas row hides in
  // exchange, because on a CCR dive that row would show tanks[0], the
  // codec's placeholder cylinder, at a pressure nobody is drawing down.
  const setpoint = appendMetric(hud, "setpoint", diveComputerText("diveComputer.setpoint"), unavailable);
  const loopPo2 = appendMetric(hud, "loopPo2", diveComputerText("diveComputer.loopPo2"), unavailable);
  const oxygenCylinder = appendMetric(hud, "oxygenCylinder", diveComputerText("diveComputer.oxygenCylinder"), unavailable);
  const diluentCylinder = appendMetric(hud, "diluentCylinder", diveComputerText("diveComputer.diluentCylinder"), unavailable);
  const scrubber = appendMetric(hud, "scrubber", diveComputerText("diveComputer.scrubber"), unavailable);
  for (const value of [setpoint, loopPo2, oxygenCylinder, diluentCylinder, scrubber]) {
    setMetricHidden(value, true);
  }
  const ndl = appendMetric(hud, "ndl", diveComputerText("diveComputer.ndl"), unavailable);
  // Legacy's stop box, safety-stop half, and its hud-thirds gauge (#199):
  // shown only while there is a stop to make or a plan to keep.
  const safetyStop = appendMetric(
    hud,
    "safetyStop",
    diveComputerText("diveComputer.safetyStop"),
    unavailable,
  );
  const thirds = appendMetric(hud, "thirds", diveComputerText("diveComputer.thirds"), unavailable);
  setMetricHidden(safetyStop, true);
  setMetricHidden(thirds, true);
  const zone = appendMetric(hud, "zone", translate(locale, "wreck.hud.zone"), unavailable);
  if (zone.parentElement) {
    zone.parentElement.lang = locale;
  }

  const warning = document.createElement("p");
  warning.className = "wreck-warning";
  // Only ever the dive computer's warning text (#232).
  warning.lang = DC;
  warning.hidden = true;
  warning.setAttribute("role", "alert");
  warning.setAttribute("aria-live", "assertive");

  // Filled by updateHud from the dive state, because the number of
  // cylinders is not known here and the shell is built once. Empty and
  // hidden until there is something to switch between.
  const tanks = document.createElement("div");
  tanks.className = "wreck-tanks";
  tanks.dataset.wreckTanks = "true";
  tanks.hidden = true;
  tanks.setAttribute("aria-label", translate(locale, "wreck.tanks.heading"));

  const controls = document.createElement("div");
  controls.className = "wreck-controls";
  controls.setAttribute("aria-label", translate(locale, "wreck.controls.heading"));
  const movement: HTMLButtonElement[] = [];
  for (const [control, key, glyph] of [
    ["left", "wreck.controls.left", "←"],
    ["ascend", "wreck.controls.ascend", "↑"],
    ["descend", "wreck.controls.descend", "↓"],
    ["right", "wreck.controls.right", "→"],
  ] as const) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.control = control;
    button.setAttribute("aria-label", translate(locale, key));
    button.textContent = glyph;
    controls.append(button);
    movement.push(button);
  }
  const torch = document.createElement("button");
  torch.type = "button";
  torch.className = "torch-control";
  torch.dataset.torch = "true";
  torch.setAttribute("aria-label", translate(locale, "wreck.controls.torch"));
  torch.setAttribute("aria-pressed", "true");
  torch.textContent = translate(locale, "wreck.symbol.torch");
  controls.append(torch);
  // The F key's button. Offered only while a stop is held, as legacy shows
  // its touch-fast-forward button only then; updateHud keeps that in step.
  const fastForward = document.createElement("button");
  fastForward.type = "button";
  fastForward.className = "fast-forward-control";
  fastForward.dataset.fastForward = "true";
  fastForward.hidden = true;
  fastForward.setAttribute(
    "aria-label",
    translate(locale, "wreck.controls.fastForward"),
  );
  fastForward.setAttribute("aria-keyshortcuts", "F");
  fastForward.setAttribute("aria-pressed", "false");
  fastForward.textContent = translate(locale, "wreck.symbol.fastForward");
  controls.append(fastForward);

  const hint = createElement(
    "p",
    "controls-hint",
    translate(locale, "wreck.controls.hint"),
  );

  // The cylinder row and the hint share the bottom-left corner, so they are
  // stacked in one dock rather than both anchored there absolutely — which
  // is how the hint ended up drawn across the row at desktop widths (#163
  // review). A column cannot overlap itself; the dock's own width cap is
  // what keeps the pair clear of the D-pad on the right.
  // The rebreather row (#163): setpoint down and up, and bailout. Built
  // once — the count never changes — and shown by updateHud only while the
  // loop is breathed, which is legacy's `diveMode === 'ccr' &&
  // !ccrState.onBailout` for all three (src/touch.js
  // updateCcrDiveButtonVisibility). After a bailout there is no setpoint to
  // move and nothing left to bail out of, so the whole row goes.
  const ccr = document.createElement("div");
  ccr.className = "wreck-ccr";
  ccr.dataset.wreckCcr = "true";
  ccr.hidden = true;
  ccr.setAttribute("aria-label", translate(locale, "wreck.controls.ccr.heading"));
  for (const [direction, labelKey, symbolKey, shortcut] of [
    ["decrease", "wreck.controls.setpoint.decrease", "wreck.symbol.setpointDown", "["],
    ["increase", "wreck.controls.setpoint.increase", "wreck.symbol.setpointUp", "]"],
  ] as const) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.setpoint = direction;
    button.setAttribute("aria-label", translate(locale, labelKey));
    button.setAttribute("aria-keyshortcuts", shortcut);
    button.textContent = translate(locale, symbolKey);
    ccr.append(button);
  }
  const bailout = document.createElement("button");
  bailout.type = "button";
  bailout.dataset.bailout = "true";
  // The name carries the consequence, because the button cannot ask for a
  // confirmation (#67) and its irreversibility has to be knowable before
  // the press rather than discovered after it.
  bailout.setAttribute("aria-label", translate(locale, "wreck.controls.bailout"));
  bailout.setAttribute("aria-keyshortcuts", "B");
  bailout.textContent = translate(locale, "wreck.controls.bailout.label");
  ccr.append(bailout);

  // Legacy's surface screen (src/renderer.js drawSurface, src/touch.js): the
  // dive waits at the surface for S, and says so (#199). Shown on every
  // layout, unlike the keyboard hint, because on a phone it is the only thing
  // that says the dive has not begun; the ↓ button is the touch S.
  const surfacePrompt = createElement(
    "p",
    "surface-prompt",
    translate(locale, "wreck.controls.surfaceDescend"),
  );
  surfacePrompt.dataset.surfacePrompt = "true";
  surfacePrompt.hidden = true;

  const dock = document.createElement("div");
  dock.className = "wreck-dock";
  dock.append(surfacePrompt, hint, tanks, ccr);

  // The HUD and the gas-information panel share one column, so an open
  // page sits below the readouts rather than over them (#163).
  const column = document.createElement("div");
  column.className = "wreck-column";
  column.append(hud, gasInfo.panel);

  shell.append(topbar, viewport, column, warning, dock, controls);
  return {
    shell,
    viewport,
    depth,
    time,
    gas,
    cylinder,
    setpoint,
    loopPo2,
    oxygenCylinder,
    diluentCylinder,
    scrubber,
    ndl,
    ascentRate,
    safetyStop,
    thirds,
    zone,
    status,
    speed,
    warning,
    tanks,
    ccr,
    movement,
    torch,
    fastForward,
    mute,
    gasInfo,
    surfacePrompt,
  };
}

function updateHud(
  hud: HudElements,
  frame: Readonly<GameFrame>,
  locale: SupportedLocale,
): void {
  const { presentation, scene, fastForward } = frame;
  const activeTank = presentation.tanks[presentation.activeTankIndex];
  hud.depth.textContent = formatDepth(presentation.depthM, DC);
  hud.time.textContent = formatDuration(presentation.elapsedTimeS, DC);
  hud.gas.textContent = activeTank
    ? formatPressure(activeTank.pressureBar, DC)
    : translate(DC, "wreck.value.unavailable");
  hud.cylinder.textContent = selectCylinderText(presentation);
  // The control appears only while it would do something and reads as
  // pressed while the clock is sped up; the chip says the same in words.
  hud.fastForward.hidden = !fastForward.available;
  hud.fastForward.setAttribute("aria-pressed", String(fastForward.active));
  hud.speed.hidden = !fastForward.active;
  hud.surfacePrompt.hidden = !frame.awaitingDescent;
  syncLoopRows(hud, presentation, frame.awaitingDescent);
  // Legacy's "---" for the 999 "no limit" sentinel, and at most 99 (#223
  // pre-review): reachable since the dive starts at the surface.
  hud.ndl.textContent = ndlText(
    presentation.planner?.ndlMin ?? null,
    DC,
    translate(DC, "wreck.value.unavailable"),
  );
  syncDiveReadouts(hud, presentation);
  hud.zone.textContent = translate(locale, zoneMessageKeys[scene.zone]);
  hud.torch.setAttribute("aria-pressed", String(scene.torchOn));
  // Legacy shows its nav pad and torch button, and reads their keys, only in
  // 'diving' (touch.js touchUpdateUI, game-loop.js D6). At the surface its
  // one button is the descent, S; after the dive there are none (#223 Codex
  // round 1 and pre-review). Each button keeps its grid cell, so hiding one
  // moves no other under a thumb.
  const ended = presentation.completed || presentation.status === "failed";
  for (const button of hud.movement) {
    button.hidden =
      ended || (frame.awaitingDescent && button.dataset.control !== "descend");
  }
  hud.torch.hidden = frame.awaitingDescent || ended;
  syncTankControls(hud.tanks, presentation, locale, frame.awaitingDescent);

  const severity = selectWarning(presentation);
  const alertText = severity ? diveComputerText(warningAlertKeys[severity]) : "";
  // The glyph makes the warning legible without colour at all — in greyscale,
  // or to a reader who cannot tell the red chip from the green one. Same
  // redundant-encoding approach #39 took in the legacy client.
  // A warning in the chip is the dive computer's, in its English (#232);
  // "Simulation running" is the page's, in its language, so the chip's lang
  // follows whichever of the two it shows.
  const statusText = severity
    ? `${translate(DC, "wreck.symbol.warning")} ${diveComputerText(warningStatusKeys[severity])}`
    : translate(locale, "wreck.hud.normal");
  const statusLang = severity ? DC : locale;

  hud.warning.hidden = severity === null;
  hud.shell.classList.toggle("has-warning", severity !== null);
  // Assign only on an actual change. This runs every frame and `textContent =`
  // replaces the child nodes even when the string is identical. For the alert
  // that matters for correctness: a live region watching those mutations can
  // re-announce on every frame, so writing only real transitions keeps each
  // state change announced exactly once. For the chip it is just avoided churn.
  if (hud.warning.textContent !== alertText) {
    hud.warning.textContent = alertText;
  }
  if (hud.status.textContent !== statusText) {
    hud.status.textContent = statusText;
  }
  if (hud.status.lang !== statusLang) {
    hud.status.lang = statusLang;
  }
}

/**
 * The cylinder row's text (#163): which cylinder, and what is in it.
 *
 * A closed-circuit dive breathes the loop, not a cylinder, and `tanks[0]`
 * on such a dive is only the codec's required placeholder — showing it as
 * "1 · 21 % O₂" would name a cylinder nobody is breathing. After a bailout
 * the model breathes the diluent cylinder open-circuit
 * (breathingSourceForState), and a save can resume in that state, so the
 * row says so rather than still naming the loop (#163 review round 1). The
 * loop's own rows (setpoint, loop PO₂, scrubber) are the CCR slice of #163.
 */
function selectCylinderText(presentation: Readonly<PresentationState>): string {
  if (presentation.ccr) {
    return diveComputerText(
      presentation.ccr.onBailout
        ? "diveComputer.cylinder.bailout"
        : "diveComputer.cylinder.loop",
    );
  }
  const activeTank = presentation.tanks[presentation.activeTankIndex];
  if (!activeTank) {
    return translate(DC, "wreck.value.unavailable");
  }
  return diveComputerText("diveComputer.cylinder.value")
    .replace("{n}", String(activeTank.index + 1))
    .replace("{gas}", formatGasFraction(activeTank.gas.oxygenFraction, DC));
}

/**
 * The rebreather's HUD rows and its control row, kept in step with the dive
 * state (#163).
 *
 * On a closed-circuit dive the five loop rows show and the open-circuit gas
 * row hides; on open circuit it is the other way round. The control row
 * follows legacy's `diveMode === 'ccr' && !ccrState.onBailout`, plus the
 * failed-dive rule every in-dive control here follows: a setpoint on a
 * failed dive moves nothing, and DiveModel refuses it anyway.
 */
function syncLoopRows(
  hud: HudElements,
  presentation: Readonly<PresentationState>,
  awaitingDescent: boolean,
): void {
  const { ccr, status } = presentation;
  const loopRows = [
    hud.setpoint,
    hud.loopPo2,
    hud.oxygenCylinder,
    hud.diluentCylinder,
    hud.scrubber,
  ];
  setMetricHidden(hud.gas, ccr !== null);
  for (const row of loopRows) {
    setMetricHidden(row, ccr === null);
  }
  // Legacy shows the loop's buttons only in 'diving' (touch.js
  // updateCcrDiveButtonVisibility): not while the dive waits at the
  // surface, nor once it has ended (#223 pre-review).
  hud.ccr.hidden =
    ccr === null ||
    ccr.onBailout ||
    status === "failed" ||
    presentation.completed ||
    awaitingDescent;
  if (!ccr) {
    return;
  }
  hud.setpoint.textContent = formatPartialPressure(ccr.targetPo2Bar, DC);
  // The rows legacy draws in its danger tone with the ⚠ prefix
  // (src/renderer.js drawDiveComputer, CCR branch — hudDangerPrefix()), so a
  // reading past its limit says so in the glyph and not only in colour
  // (#163 review round 2 on PR #182).
  // The two cylinder rows show whole bar, as legacy draws them
  // (`Math.round(ccrState.o2CylPressure) + ' bar'`), because the danger
  // rule reads the rounded value: showing 29.6 bar beside a rule that
  // counts it as 30 put an unmarked reading under the threshold on screen
  // (#163 review round 4 on PR #182).
  const danger = selectLoopRowDanger(ccr);
  writeLoopRow(
    hud.loopPo2,
    formatPartialPressure(ccr.actualPo2Bar, DC),
    danger.loopPo2,
  );
  writeLoopRow(
    hud.oxygenCylinder,
    formatPressure(Math.round(ccr.oxygenCylinderPressureBar), DC),
    danger.oxygenCylinder,
  );
  writeLoopRow(
    hud.diluentCylinder,
    formatPressure(Math.round(ccr.diluentCylinderPressureBar), DC),
    danger.diluentCylinder,
  );
  writeLoopRow(
    hud.scrubber,
    formatWholeMinutes(ccr.scrubberRemainingS, DC),
    danger.scrubber,
  );
}

function writeLoopRow(
  value: HTMLElement,
  text: string,
  danger: boolean,
): void {
  const next = danger
    ? `${translate(DC, "wreck.symbol.warning")} ${text}`
    : text;
  if (value.textContent !== next) {
    value.textContent = next;
  }
  const row = value.parentElement;
  if (row) {
    row.toggleAttribute("data-danger", danger);
  }
}

/**
 * The ascent rate, the safety stop and the rule of thirds (#197, #199).
 *
 * - The rate: legacy's chevrons point up or down past 0.5 m/min and carry
 *   `Math.round(|ascentRate|)` beside them (src/renderer.js
 *   drawDiveComputer); here the arrow is the chevron. Past 9 m/min up, the
 *   row carries the ⚠ as the fast-ascent warning speaks.
 * - The safety stop: legacy's stop box while a stop is owed and not done,
 *   the nominal 5 m with the planned minutes, then the countdown, paused
 *   outside the band, then Complete. While there is a ceiling the row is
 *   legacy's DECO STOP instead, with the first stop of the schedule when
 *   there is one.
 * - The rule of thirds: legacy's hud-thirds, the phase and the gas left
 *   against the plan, while under an overhead. The reserve third carries the
 *   ⚠, as legacy draws it in its danger tone.
 */
function syncDiveReadouts(
  hud: HudElements,
  presentation: Readonly<PresentationState>,
): void {
  const rate = presentation.ascentRateMpm;
  const rateText =
    rate > 0.5
      ? diveComputerText("diveComputer.ascentRate.up").replace("{rate}", formatVerticalRate(rate, DC))
      : rate < -0.5
        ? diveComputerText("diveComputer.ascentRate.down").replace("{rate}", formatVerticalRate(rate, DC))
        : formatVerticalRate(0, DC);
  writeLoopRow(hud.ascentRate, rateText, rate > FAST_ASCENT_RATE_MPM);

  // One row, legacy's stop box: the decompression stop while there is a
  // ceiling on this tick, else the safety stop (selectDecoStop and
  // selectSafetyStop decide which, from the model's own ceiling).
  const deco = presentation.decoStop;
  const stop = presentation.safetyStop;
  const stopRow = hud.safetyStop.parentElement;
  const stopTerm = stopRow?.querySelector("dt");
  const stopLabel = diveComputerText(
    deco !== null ? "diveComputer.decoStop" : "diveComputer.safetyStop",
  );
  if (stopTerm && stopTerm.textContent !== stopLabel) {
    stopTerm.textContent = stopLabel;
  }
  setMetricHidden(hud.safetyStop, deco === null && stop === null);
  if (deco !== null) {
    // The title alone without a schedule, as legacy draws it.
    const first = deco.firstStop;
    writeLoopRow(
      hud.safetyStop,
      first === null
        ? ""
        : diveComputerText("diveComputer.decoStop.value")
            .replace("{depth}", formatDepth(first.depthM, DC))
            .replace("{duration}", formatWholeMinutes(first.durationMin * 60, DC)),
      false,
    );
    stopRow?.setAttribute("data-phase", "deco");
  } else if (stop !== null) {
    // Legacy floors the countdown's minutes and seconds.
    const duration =
      stop.phase === "complete"
        ? ""
        : stop.phase === "planned"
          ? formatWholeMinutes(stop.remainingS, DC)
          : formatDuration(Math.floor(stop.remainingS), DC);
    writeLoopRow(
      hud.safetyStop,
      diveComputerText(safetyStopPhaseKeys[stop.phase])
        .replace("{depth}", formatDepth(stop.targetDepthM, DC))
        .replace("{duration}", duration),
      false,
    );
    hud.safetyStop.parentElement?.setAttribute("data-phase", stop.phase);
  }

  const thirds = presentation.ruleOfThirds;
  setMetricHidden(hud.thirds, thirds === null);
  if (thirds !== null) {
    writeLoopRow(
      hud.thirds,
      diveComputerText(thirdsPhaseKeys[thirds.phase]).replace(
        "{percent}",
        formatPercent(thirds.percent / 100, DC),
      ),
      thirds.phase === "reserve",
    );
    hud.thirds.parentElement?.setAttribute("data-phase", thirds.phase);
  }
}

function bindLoopControls(
  container: HTMLElement,
  controller: GameController,
): void {
  container.addEventListener("click", (event) => {
    const target = event.target as Element | null;
    const setpoint = target?.closest<HTMLElement>("[data-setpoint]");
    if (setpoint) {
      controller.adjustSetpoint(
        setpoint.dataset.setpoint === "increase"
          ? CCR_SETPOINT_STEP_BAR
          : -CCR_SETPOINT_STEP_BAR,
      );
      return;
    }
    if (target?.closest("[data-bailout]")) {
      controller.bailOut();
    }
  });
}

/**
 * The cylinder buttons, kept in step with the dive state (#163).
 *
 * Shown only when a switch is something the model would accept, which is what
 * the issue means by "controls appear only when the dive state allows them,
 * as in legacy": CCR breathes a loop and src/core/dive-model.ts refuses a gas
 * switch outright, and a single-cylinder dive has nothing to switch to.
 *
 * The buttons are created once and thereafter only have their attributes
 * updated. Rebuilding them every frame would throw away focus sixty times a
 * second, which is the same defect the setup screen's focusKeyOf exists to
 * avoid — and here there would be no re-render to restore it from.
 */
function syncTankControls(
  container: HTMLElement,
  presentation: Readonly<PresentationState>,
  locale: SupportedLocale,
  awaitingDescent: boolean,
): void {
  const { tanks, ccr, status } = presentation;
  // Gone once the dive has failed, as legacy takes its touch UI away outside
  // `gameState === 'diving'`. DiveModel.switchGas refuses a switch on a
  // failed dive, so leaving the buttons enabled offered an action that could
  // not happen (#163 review) — the issue's "controls appear only when the
  // dive state allows them" covers this as much as it covers CCR.
  // Nor at the surface before the dive, nor once it has ended: legacy's
  // cylinder buttons sit in touch-dive, shown only in 'diving' (#223
  // pre-review).
  container.hidden =
    status === "failed" ||
    presentation.completed ||
    awaitingDescent ||
    ccr !== null ||
    tanks.length <= 1;
  if (container.hidden) {
    return;
  }

  if (container.childElementCount !== tanks.length) {
    container.replaceChildren(
      ...tanks.map((tank) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "wreck-tank";
        button.dataset.tank = String(tank.index);
        // The digit is the key that does the same thing, so the two read as
        // one control rather than two ways in that happen to agree.
        button.textContent = String(tank.index + 1);
        button.setAttribute("aria-keyshortcuts", String(tank.index + 1));
        return button;
      }),
    );
  }

  tanks.forEach((tank, position) => {
    const button = container.children[position];
    if (!(button instanceof HTMLButtonElement)) {
      return;
    }
    button.setAttribute("aria-pressed", String(tank.active));
    // Empty cylinders only. The active one stays enabled: the model treats a
    // switch to it as a no-op, and disabling it would read as "broken"
    // rather than "already breathing this".
    button.disabled = tank.gasRemainingL <= 0;
    button.setAttribute(
      "aria-label",
      translate(locale, "wreck.tanks.select")
        .replace("{n}", String(tank.index + 1))
        .replace("{gas}", formatGasFraction(tank.gas.oxygenFraction, locale))
        .replace("{pressure}", formatPressure(tank.pressureBar, locale)),
    );
  });
}

function bindTankControls(
  container: HTMLElement,
  controller: GameController,
): void {
  // Delegated, because the buttons do not exist when this runs — the first
  // frame builds them. A listener per button would have to be rebound.
  container.addEventListener("click", (event) => {
    const button = (event.target as Element | null)?.closest<HTMLElement>(
      "[data-tank]",
    );
    const index = button?.dataset.tank;
    if (index === undefined) {
      return;
    }
    controller.requestTankSwitch(Number.parseInt(index, 10));
  });
}

function bindContinuousControl(
  shell: HTMLElement,
  controller: GameController,
): void {
  for (const button of shell.querySelectorAll<HTMLButtonElement>(
    "[data-control]",
  )) {
    const control = button.dataset.control as ContinuousControl;
    const release = () => controller.setControl(control, false);
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      button.setPointerCapture(event.pointerId);
      controller.setControl(control, true);
    });
    button.addEventListener("pointerup", release);
    button.addEventListener("pointercancel", release);
    button.addEventListener("lostpointercapture", release);
  }
}

// Stable identity for each HUD metric, independent of render order.
//
// #137 §4.4.1 was that the narrow layout hid NDL, a safety-relevant readout,
// via `.wreck-hud div:nth-child(4)`. Moving that rule to nth-child(5) fixes
// today's order but keeps the fragility: reorder the metrics and the media
// query silently hides whichever one now sits fifth. The CSS names the metric
// it means instead, so the rule cannot drift away from its intent.
type HudMetric =
  | "depth"
  | "time"
  | "gas"
  | "cylinder"
  | "setpoint"
  | "loopPo2"
  | "oxygenCylinder"
  | "diluentCylinder"
  | "scrubber"
  | "ndl"
  | "ascentRate"
  | "safetyStop"
  | "thirds"
  | "zone";

// Hides the whole row — term and value — of a metric, given the value
// element appendMetric returned. `.wreck-hud div[hidden]` in the stylesheet
// makes the attribute win over the row's display: flex.
function setMetricHidden(value: HTMLElement, hidden: boolean): void {
  const row = value.parentElement;
  if (row) {
    row.hidden = hidden;
  }
}

function appendMetric(
  list: HTMLDListElement,
  metric: HudMetric,
  label: string,
  unavailable: string,
): HTMLElement {
  const group = document.createElement("div");
  group.dataset.hudMetric = metric;
  const term = document.createElement("dt");
  const value = document.createElement("dd");
  term.textContent = label;
  value.textContent = unavailable;
  group.append(term, value);
  list.append(group);
  return value;
}

function renderStartError(root: HTMLElement, locale: SupportedLocale): void {
  const error = document.createElement("section");
  error.className = "start-error";
  error.setAttribute("role", "alert");
  const heading = document.createElement("h1");
  heading.textContent = translate(locale, "wreck.error.heading");
  const reload = document.createElement("button");
  reload.type = "button";
  reload.textContent = translate(locale, "wreck.error.retry");
  reload.addEventListener("click", () => location.reload());
  error.append(heading, reload);
  root.replaceChildren(error);
}

function createElement<K extends keyof HTMLElementTagNameMap>(
  tagName: K,
  className: string,
  text: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tagName);
  element.className = className;
  element.textContent = text;
  return element;
}
