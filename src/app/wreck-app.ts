import type { PresentationState } from "../presentation/presentation-state";
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
  detectPreferredLocale,
  translate,
  type MessageKey,
  type SupportedLocale,
} from "./i18n/catalog";
import {
  formatDepth,
  formatDuration,
  formatGasFraction,
  formatPressure,
} from "./i18n/formatters";
import { renderSetupScreen } from "./setup/setup-screen";
import {
  toInitialDiveOptions,
  toPlannerSettings,
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
  readonly ndl: HTMLElement;
  readonly zone: HTMLElement;
  readonly status: HTMLElement;
  readonly speed: HTMLElement;
  readonly warning: HTMLElement;
  readonly tanks: HTMLElement;
  readonly torch: HTMLButtonElement;
  readonly fastForward: HTMLButtonElement;
  readonly mute: HTMLButtonElement;
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
// alone, which docs/decisions.md:100 rules out.
type WarningSeverity = "lowGas" | "oxygen" | "failure";

// Full sentence for the role=alert region.
const warningAlertKeys: Record<WarningSeverity, MessageKey> = {
  lowGas: "wreck.warning.lowGas",
  oxygen: "wreck.warning.oxygen",
  failure: "wreck.warning.failure",
};

// Short form for the status chip, which sits in the topbar away from the
// alert text and has to stand on its own.
const warningStatusKeys: Record<WarningSeverity, MessageKey> = {
  lowGas: "wreck.hud.warning.lowGas",
  oxygen: "wreck.hud.warning.oxygen",
  failure: "wreck.hud.warning.failure",
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
function showSetupScreen(root: HTMLElement, locale: SupportedLocale): void {
  const dispose = renderSetupScreen(root, {
    locale,
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
  const hud = createWreckShell(locale);
  root.replaceChildren(hud.shell);
  const audio = new WebAudioService();
  const audioResume = audio.resume();
  const renderer = await createSelectedRenderer();
  const repository = new LocalSaveRepository(window.localStorage);
  const loadResult = repository.load();
  const resumed = loadResult.status === "loaded" ? loadResult.saveGame : null;
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
  let nextSaveAtS = 5;
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
      if (state.elapsedTimeS >= nextSaveAtS) {
        saveState(repository, state, plannerSettings);
        nextSaveAtS = state.elapsedTimeS + 5;
      }
    },
    onFrame: (frame) => {
      updateHud(hud, frame, locale);
      audio.update({
        elapsedRealS: frame.scene.elapsedRealS,
        warningActive: selectWarning(frame.presentation) !== null,
      });
    },
  });

  bindContinuousControl(hud.shell, controller);
  bindTankControls(hud.tanks, controller);
  hud.torch.addEventListener("click", () => controller.toggleTorch());
  hud.fastForward.addEventListener("click", () =>
    controller.toggleFastForward(),
  );
  hud.mute.addEventListener("click", () => {
    audio.setMuted(!audio.muted);
    hud.mute.setAttribute("aria-pressed", String(audio.muted));
  });
  const handleVisibility = () => {
    const action = document.hidden ? audio.suspend() : audio.resume();
    void action.catch((error: unknown) => console.error(error));
  };
  document.addEventListener("visibilitychange", handleVisibility);
  window.addEventListener("pagehide", () => {
    document.removeEventListener("visibilitychange", handleVisibility);
    saveState(repository, controller.authoritativeState, plannerSettings);
    controller.destroy();
    audio.destroy();
  }, {
    once: true,
  });
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
): void {
  try {
    repository.save(state, {
      lowPercent: settings.gfLowPercent,
      highPercent: settings.gfHighPercent,
    });
  } catch (error) {
    console.error(error);
  }
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
  topbarActions.append(speed, status, mute);
  topbar.append(identity, topbarActions);

  const viewport = document.createElement("div");
  viewport.className = "wreck-viewport";
  viewport.setAttribute("data-wreck-viewport", "true");

  const hud = document.createElement("dl");
  hud.className = "wreck-hud";
  const unavailable = translate(locale, "wreck.value.unavailable");
  const depth = appendMetric(hud, "depth", translate(locale, "wreck.hud.depth"), unavailable);
  const time = appendMetric(hud, "time", translate(locale, "wreck.hud.time"), unavailable);
  const gas = appendMetric(hud, "gas", translate(locale, "wreck.hud.gas"), unavailable);
  // Which cylinder is being breathed (#163). Until this row existed the only
  // trace of a switch was the gas pressure changing, so the tests read the
  // save to learn the active index — the HUD half the issue asks for.
  const cylinder = appendMetric(
    hud,
    "cylinder",
    translate(locale, "wreck.hud.cylinder"),
    unavailable,
  );
  const ndl = appendMetric(hud, "ndl", translate(locale, "wreck.hud.ndl"), unavailable);
  const zone = appendMetric(hud, "zone", translate(locale, "wreck.hud.zone"), unavailable);

  const warning = document.createElement("p");
  warning.className = "wreck-warning";
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
  const dock = document.createElement("div");
  dock.className = "wreck-dock";
  dock.append(hint, tanks);

  shell.append(topbar, viewport, hud, warning, dock, controls);
  return {
    shell,
    viewport,
    depth,
    time,
    gas,
    cylinder,
    ndl,
    zone,
    status,
    speed,
    warning,
    tanks,
    torch,
    fastForward,
    mute,
  };
}

function updateHud(
  hud: HudElements,
  frame: Readonly<GameFrame>,
  locale: SupportedLocale,
): void {
  const { presentation, scene, fastForward } = frame;
  const activeTank = presentation.tanks[presentation.activeTankIndex];
  hud.depth.textContent = formatDepth(presentation.depthM, locale);
  hud.time.textContent = formatDuration(presentation.elapsedTimeS, locale);
  hud.gas.textContent = activeTank
    ? formatPressure(activeTank.pressureBar, locale)
    : translate(locale, "wreck.value.unavailable");
  hud.cylinder.textContent = selectCylinderText(presentation, locale);
  // The control appears only while it would do something and reads as
  // pressed while the clock is sped up; the chip says the same in words.
  hud.fastForward.hidden = !fastForward.available;
  hud.fastForward.setAttribute("aria-pressed", String(fastForward.active));
  hud.speed.hidden = !fastForward.active;
  hud.ndl.textContent = presentation.planner
    ? formatDuration(presentation.planner.ndlMin * 60, locale)
    : translate(locale, "wreck.value.unavailable");
  hud.zone.textContent = translate(locale, zoneMessageKeys[scene.zone]);
  hud.torch.setAttribute("aria-pressed", String(scene.torchOn));
  syncTankControls(hud.tanks, presentation, locale);

  const severity = selectWarning(presentation);
  const alertText = severity ? translate(locale, warningAlertKeys[severity]) : "";
  // The glyph makes the warning legible without colour at all — in greyscale,
  // or to a reader who cannot tell the red chip from the green one. Same
  // redundant-encoding approach #39 took in the legacy client.
  const statusText = severity
    ? `${translate(locale, "wreck.symbol.warning")} ${translate(locale, warningStatusKeys[severity])}`
    : translate(locale, "wreck.hud.normal");

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
}

/**
 * The cylinder row's text (#163): which cylinder, and what is in it.
 *
 * A closed-circuit dive breathes the loop, not a cylinder, and `tanks[0]`
 * on such a dive is only the codec's required placeholder — showing it as
 * "1 · 21 % O₂" would name a cylinder nobody is breathing. The loop's own
 * rows (setpoint, loop PO₂, scrubber, bailout) are the CCR slice of #163.
 */
function selectCylinderText(
  presentation: Readonly<PresentationState>,
  locale: SupportedLocale,
): string {
  if (presentation.ccr) {
    return translate(locale, "wreck.hud.cylinder.loop");
  }
  const activeTank = presentation.tanks[presentation.activeTankIndex];
  if (!activeTank) {
    return translate(locale, "wreck.value.unavailable");
  }
  return translate(locale, "wreck.hud.cylinder.value")
    .replace("{n}", String(activeTank.index + 1))
    .replace("{gas}", formatGasFraction(activeTank.gas.oxygenFraction, locale));
}

// Returns the severity rather than a message, so callers cannot pick one
// wording for the chip and a different state for the styling.
function selectWarning(
  presentation: Readonly<PresentationState>,
): WarningSeverity | null {
  if (presentation.failureReason) {
    return "failure";
  }
  if (
    presentation.breathingPo2Bar < 0.16 ||
    presentation.breathingPo2Bar > 1.6
  ) {
    return "oxygen";
  }
  const activeTank = presentation.tanks[presentation.activeTankIndex];
  if (activeTank && activeTank.pressureBar <= 50) {
    return "lowGas";
  }
  return null;
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
): void {
  const { tanks, ccr, status } = presentation;
  // Gone once the dive has failed, as legacy takes its touch UI away outside
  // `gameState === 'diving'`. DiveModel.switchGas refuses a switch on a
  // failed dive, so leaving the buttons enabled offered an action that could
  // not happen (#163 review) — the issue's "controls appear only when the
  // dive state allows them" covers this as much as it covers CCR.
  container.hidden = status === "failed" || ccr !== null || tanks.length <= 1;
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
type HudMetric = "depth" | "time" | "gas" | "cylinder" | "ndl" | "zone";

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
