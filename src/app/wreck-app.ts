import type { PresentationState } from "../presentation/presentation-state";
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
  formatPressure,
} from "./i18n/formatters";
import {
  GameController,
  type ContinuousControl,
  type GameFrame,
} from "./game-controller";

interface HudElements {
  readonly shell: HTMLElement;
  readonly viewport: HTMLElement;
  readonly depth: HTMLElement;
  readonly time: HTMLElement;
  readonly gas: HTMLElement;
  readonly ndl: HTMLElement;
  readonly zone: HTMLElement;
  readonly status: HTMLElement;
  readonly warning: HTMLElement;
  readonly torch: HTMLButtonElement;
}

const zoneMessageKeys: Record<WreckZone, MessageKey> = {
  exterior: "wreck.zone.exterior",
  "cargo-hold": "wreck.zone.cargo-hold",
  "engine-room": "wreck.zone.engine-room",
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
    void startWreckSimulation(root, locale).catch((error: unknown) => {
      console.error(error);
      renderStartError(root, locale);
    });
  });
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
  const legacy = document.createElement("a");
  legacy.href = "/src/diving-simulator.html";
  legacy.className = "secondary-action";
  legacy.textContent = translate(locale, "diagnostic.legacyLink");
  actions.append(accept, legacy);

  gate.append(eyebrow, heading, summary, notices, methodology, actions);
  return gate;
}

async function startWreckSimulation(
  root: HTMLElement,
  locale: SupportedLocale,
): Promise<void> {
  const hud = createWreckShell(locale);
  root.replaceChildren(hud.shell);
  const renderer = await createSelectedRenderer();
  const controller = new GameController({
    renderer,
    onFrame: (frame) => updateHud(hud, frame, locale),
  });

  bindContinuousControl(hud.shell, controller);
  hud.torch.addEventListener("click", () => controller.toggleTorch());
  window.addEventListener("pagehide", () => controller.destroy(), {
    once: true,
  });
  try {
    await controller.start(hud.viewport);
  } catch (error) {
    controller.destroy();
    throw error;
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
  const normalStatus = createElement(
    "p",
    "status-chip",
    translate(locale, "wreck.hud.normal"),
  );
  normalStatus.setAttribute("aria-label", translate(locale, "wreck.hud.status"));
  topbar.append(identity, normalStatus);

  const viewport = document.createElement("div");
  viewport.className = "wreck-viewport";
  viewport.setAttribute("data-wreck-viewport", "true");

  const hud = document.createElement("dl");
  hud.className = "wreck-hud";
  const unavailable = translate(locale, "wreck.value.unavailable");
  const depth = appendMetric(hud, translate(locale, "wreck.hud.depth"), unavailable);
  const time = appendMetric(hud, translate(locale, "wreck.hud.time"), unavailable);
  const gas = appendMetric(hud, translate(locale, "wreck.hud.gas"), unavailable);
  const ndl = appendMetric(hud, translate(locale, "wreck.hud.ndl"), unavailable);
  const zone = appendMetric(hud, translate(locale, "wreck.hud.zone"), unavailable);

  const warning = document.createElement("p");
  warning.className = "wreck-warning";
  warning.hidden = true;
  warning.setAttribute("role", "alert");
  warning.setAttribute("aria-live", "assertive");

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

  const hint = createElement(
    "p",
    "controls-hint",
    translate(locale, "wreck.controls.hint"),
  );

  shell.append(topbar, viewport, hud, warning, controls, hint);
  return {
    shell,
    viewport,
    depth,
    time,
    gas,
    ndl,
    zone,
    status: normalStatus,
    warning,
    torch,
  };
}

function updateHud(
  hud: HudElements,
  frame: Readonly<GameFrame>,
  locale: SupportedLocale,
): void {
  const { presentation, scene } = frame;
  const activeTank = presentation.tanks[presentation.activeTankIndex];
  hud.depth.textContent = formatDepth(presentation.depthM, locale);
  hud.time.textContent = formatDuration(presentation.elapsedTimeS, locale);
  hud.gas.textContent = activeTank
    ? formatPressure(activeTank.pressureBar, locale)
    : translate(locale, "wreck.value.unavailable");
  hud.ndl.textContent = presentation.planner
    ? formatDuration(presentation.planner.ndlMin * 60, locale)
    : translate(locale, "wreck.value.unavailable");
  hud.zone.textContent = translate(locale, zoneMessageKeys[scene.zone]);
  hud.torch.setAttribute("aria-pressed", String(scene.torchOn));

  const warningKey = selectWarning(presentation);
  hud.warning.hidden = warningKey === null;
  hud.warning.textContent = warningKey ? translate(locale, warningKey) : "";
  hud.shell.classList.toggle("has-warning", warningKey !== null);
  hud.status.textContent = translate(locale, "wreck.hud.normal");
}

function selectWarning(
  presentation: Readonly<PresentationState>,
): MessageKey | null {
  if (presentation.failureReason) {
    return "wreck.warning.failure";
  }
  if (
    presentation.breathingPo2Bar < 0.16 ||
    presentation.breathingPo2Bar > 1.6
  ) {
    return "wreck.warning.oxygen";
  }
  const activeTank = presentation.tanks[presentation.activeTankIndex];
  if (activeTank && activeTank.pressureBar <= 50) {
    return "wreck.warning.lowGas";
  }
  return null;
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

function appendMetric(
  list: HTMLDListElement,
  label: string,
  unavailable: string,
): HTMLElement {
  const group = document.createElement("div");
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
