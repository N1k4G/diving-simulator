// The pre-dive screen: DOM, keyboard and pointer over the pure configuration
// in dive-setup.ts.
//
// Everything here is presentation and input. It holds one DiveSetup value,
// replaces it through the transforms in that module, and re-renders. No
// clamping, no preset rules and no mode logic live in this file, so the rules
// stay unit-testable without a browser.
//
// DOM rather than canvas because the Definition of done requires interactive
// controls and critical status to have accessible, localizable, non-canvas
// representations — the legacy screen paints itself into a <canvas>, which is
// the thing being replaced.
import {
  DIVE_MODES,
  GAS_PRESETS,
  OXYGEN_FRACTION_STEP,
  SITE_IDS,
  TANK_PRESSURE_STEP_BAR,
  adjustOxygenFraction,
  adjustTankPressure,
  applyPreset,
  createDefaultSetup,
  presetCountFor,
  selectMode,
  selectSite,
  type DiveMode,
  type DiveSetup,
  type SiteId,
} from "./dive-setup";
import {
  translate,
  type MessageKey,
  type SupportedLocale,
} from "../i18n/catalog";
import { formatGasFraction, formatPressure } from "../i18n/formatters";

// CCR needs a loop setpoint and a diluent, and toInitialDiveOptions has no
// way to express either yet, so offering it would start an open-circuit dive
// under a CCR label. Disabled with a reason until its slice lands (#158 PR 3).
const AVAILABLE_MODES: readonly DiveMode[] = ["rec", "tec"];

const MODE_LABEL_KEYS: Record<DiveMode, MessageKey> = {
  rec: "setup.mode.rec",
  tec: "setup.mode.tec",
  ccr: "setup.mode.ccr",
};

const SITE_LABEL_KEYS: Record<SiteId, MessageKey> = {
  shore: "setup.site.shore",
  reef: "setup.site.reef",
  wreck: "setup.site.wreck",
  cave: "setup.site.cave",
};

const PRESET_LABEL_KEYS: readonly MessageKey[] = [
  "setup.preset.air",
  "setup.preset.ean28",
  "setup.preset.ean32",
  "setup.preset.ean36",
  "setup.preset.tx2135",
  "setup.preset.tx1845",
  "setup.preset.tx1555",
  "setup.preset.hx2179",
];

export interface SetupScreenOptions {
  readonly locale: SupportedLocale;
  readonly onStart: (setup: DiveSetup) => void;
  readonly initialSetup?: DiveSetup;
}

/**
 * Mounts the setup screen into `root` and calls `onStart` with the configured
 * setup. Returns a dispose function that detaches the keyboard listener; the
 * caller owns the lifetime, as it does for the dive itself.
 */
export function renderSetupScreen(
  root: HTMLElement,
  options: Readonly<SetupScreenOptions>,
): () => void {
  const { locale, onStart } = options;
  let setup = options.initialSetup ?? createDefaultSetup();

  const shell = document.createElement("section");
  shell.className = "setup-screen";
  shell.setAttribute("aria-labelledby", "setup-heading");
  root.replaceChildren(shell);

  const update = (next: DiveSetup): void => {
    if (next === setup) return;
    setup = next;
    draw();
  };

  // Keyboard bindings mirror the legacy screen so muscle memory carries over,
  // and every one of them has a control on screen doing the same thing — the
  // Definition of done requires keyboard and touch intents to produce
  // equivalent authoritative actions, not merely comparable ones.
  const handleKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey) return;
    // Do not take a key the focused control already owns. A radio group's
    // arrow-key traversal is the reason mode and site are radios at all, and
    // a document-level ArrowLeft that calls preventDefault() cancels it and
    // silently changes the gas instead. Same for Enter on a focused button,
    // which would otherwise both press the button and start the dive.
    if (nativelyHandles(event.target, event.key)) return;

    const presetIndex = Number.parseInt(event.key, 10) - 1;
    if (
      !Number.isNaN(presetIndex) &&
      presetIndex >= 0 &&
      presetIndex < presetCountFor(setup.mode)
    ) {
      event.preventDefault();
      update(applyPreset(setup, presetIndex));
      return;
    }

    switch (event.key) {
      case "ArrowLeft":
        event.preventDefault();
        update(adjustOxygenFraction(setup, -OXYGEN_FRACTION_STEP));
        break;
      case "ArrowRight":
        event.preventDefault();
        update(adjustOxygenFraction(setup, OXYGEN_FRACTION_STEP));
        break;
      case "PageUp":
        event.preventDefault();
        update(adjustTankPressure(setup, TANK_PRESSURE_STEP_BAR));
        break;
      case "PageDown":
        event.preventDefault();
        update(adjustTankPressure(setup, -TANK_PRESSURE_STEP_BAR));
        break;
      case "m":
      case "M": {
        event.preventDefault();
        const at = AVAILABLE_MODES.indexOf(setup.mode);
        const next = AVAILABLE_MODES[(at + 1) % AVAILABLE_MODES.length];
        if (next) update(selectMode(setup, next));
        break;
      }
      case "Enter":
        event.preventDefault();
        onStart(setup);
        break;
      default:
        break;
    }
  };

  function draw(): void {
    const tank = setup.tanks[setup.activeTankIndex];
    if (!tank) throw new Error("setup has no active tank");

    // A full re-render replaces every control, including the focused one, so
    // keyboard operation would end after a single change: press the stepper's
    // + once and focus falls to <body>. Restore it by the data attribute the
    // control already carries.
    const focused = focusKeyOf(document.activeElement);

    shell.replaceChildren(
      heading(locale),
      choiceGroup({
        legendKey: "setup.mode.legend",
        name: "mode",
        options: DIVE_MODES.map((mode) => ({
          value: mode,
          labelKey: MODE_LABEL_KEYS[mode],
          selected: setup.mode === mode,
          disabled: !AVAILABLE_MODES.includes(mode),
          disabledReasonKey: "setup.mode.unavailable" as MessageKey,
        })),
        onSelect: (value) => update(selectMode(setup, value as DiveMode)),
        locale,
      }),
      choiceGroup({
        legendKey: "setup.site.legend",
        name: "site",
        options: SITE_IDS.map((siteId) => ({
          value: siteId,
          labelKey: SITE_LABEL_KEYS[siteId],
          selected: setup.siteId === siteId,
          disabled: false,
        })),
        onSelect: (value) => update(selectSite(setup, value as SiteId)),
        locale,
      }),
      presetGroup(locale, setup, (index) => update(applyPreset(setup, index))),
      stepper({
        labelKey: "setup.gas.oxygen",
        value: formatGasFraction(tank.gas.oxygenFraction, locale),
        decreaseKey: "setup.gas.oxygen.decrease",
        increaseKey: "setup.gas.oxygen.increase",
        onDecrease: () =>
          update(adjustOxygenFraction(setup, -OXYGEN_FRACTION_STEP)),
        onIncrease: () =>
          update(adjustOxygenFraction(setup, OXYGEN_FRACTION_STEP)),
        locale,
        testId: "oxygen",
      }),
      stepper({
        labelKey: "setup.tank.pressure",
        value: formatPressure(tank.pressureBar, locale),
        decreaseKey: "setup.tank.pressure.decrease",
        increaseKey: "setup.tank.pressure.increase",
        onDecrease: () =>
          update(adjustTankPressure(setup, -TANK_PRESSURE_STEP_BAR)),
        onIncrease: () =>
          update(adjustTankPressure(setup, TANK_PRESSURE_STEP_BAR)),
        locale,
        testId: "pressure",
      }),
      startAction(locale, () => onStart(setup)),
    );

    if (focused) {
      shell.querySelector<HTMLElement>(focused)?.focus();
    }
  }

  draw();
  document.addEventListener("keydown", handleKeyDown);
  return () => document.removeEventListener("keydown", handleKeyDown);
}

function heading(locale: SupportedLocale): HTMLElement {
  const group = document.createElement("div");
  const eyebrow = element("p", "setup-eyebrow", translate(locale, "setup.eyebrow"));
  const title = element("h1", "setup-heading", translate(locale, "setup.heading"));
  title.id = "setup-heading";
  const hint = element("p", "setup-hint", translate(locale, "setup.keyboardHint"));
  group.append(eyebrow, title, hint);
  return group;
}

interface ChoiceOption {
  readonly value: string;
  readonly labelKey: MessageKey;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly disabledReasonKey?: MessageKey;
}

// A radio group rather than a row of buttons: the browser gives arrow-key
// traversal, a single tab stop and the right role for free, and a screen
// reader announces "2 of 3" without any authoring.
function choiceGroup(spec: {
  legendKey: MessageKey;
  name: string;
  options: readonly ChoiceOption[];
  onSelect: (value: string) => void;
  locale: SupportedLocale;
}): HTMLElement {
  const fieldset = document.createElement("fieldset");
  fieldset.className = "setup-group";
  fieldset.dataset.setupGroup = spec.name;
  const legend = document.createElement("legend");
  legend.textContent = translate(spec.locale, spec.legendKey);
  fieldset.append(legend);

  const list = document.createElement("div");
  list.className = "setup-choices";

  for (const option of spec.options) {
    const label = document.createElement("label");
    label.className = "setup-choice";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = spec.name;
    input.value = option.value;
    input.checked = option.selected;
    input.disabled = option.disabled;
    input.dataset.setupOption = option.value;
    input.addEventListener("change", () => spec.onSelect(option.value));

    const text = document.createElement("span");
    text.textContent = translate(spec.locale, option.labelKey);
    label.append(input, text);

    if (option.disabled && option.disabledReasonKey) {
      // Say why, rather than greying it out and leaving the player guessing.
      const reason = element(
        "small",
        "setup-choice-reason",
        translate(spec.locale, option.disabledReasonKey),
      );
      label.append(reason);
    }

    list.append(label);
  }

  fieldset.append(list);
  return fieldset;
}

function presetGroup(
  locale: SupportedLocale,
  setup: DiveSetup,
  onSelect: (index: number) => void,
): HTMLElement {
  const fieldset = document.createElement("fieldset");
  fieldset.className = "setup-group";
  fieldset.dataset.setupGroup = "preset";
  const legend = document.createElement("legend");
  legend.textContent = translate(locale, "setup.preset.legend");
  fieldset.append(legend);

  const list = document.createElement("div");
  list.className = "setup-presets";
  const available = presetCountFor(setup.mode);

  for (let index = 0; index < available; index += 1) {
    const preset = GAS_PRESETS[index];
    const labelKey = PRESET_LABEL_KEYS[index];
    if (!preset || !labelKey) continue;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "setup-preset";
    button.dataset.setupPreset = preset.id;
    button.textContent = translate(locale, labelKey);
    // The number the keyboard binding uses, so the two are visibly one
    // control rather than two ways in that happen to agree.
    button.setAttribute("aria-keyshortcuts", String(index + 1));
    button.addEventListener("click", () => onSelect(index));
    list.append(button);
  }

  fieldset.append(list);
  return fieldset;
}

function stepper(spec: {
  labelKey: MessageKey;
  value: string;
  decreaseKey: MessageKey;
  increaseKey: MessageKey;
  onDecrease: () => void;
  onIncrease: () => void;
  locale: SupportedLocale;
  testId: string;
}): HTMLElement {
  const row = document.createElement("div");
  row.className = "setup-stepper";
  row.dataset.setupStepper = spec.testId;

  const label = element("span", "setup-stepper-label", translate(spec.locale, spec.labelKey));
  const value = element("output", "setup-stepper-value", spec.value);
  value.dataset.setupValue = spec.testId;

  row.append(label, stepButton(spec.decreaseKey, spec.locale, spec.onDecrease, "decrease"), value, stepButton(spec.increaseKey, spec.locale, spec.onIncrease, "increase"));
  return row;
}

function stepButton(
  labelKey: MessageKey,
  locale: SupportedLocale,
  onClick: () => void,
  direction: "decrease" | "increase",
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "setup-step";
  button.dataset.setupStep = direction;
  // The glyph is decorative; the accessible name carries the meaning.
  button.textContent = direction === "increase" ? "+" : "−";
  button.setAttribute("aria-label", translate(locale, labelKey));
  button.addEventListener("click", onClick);
  return button;
}

function startAction(locale: SupportedLocale, onStart: () => void): HTMLElement {
  const actions = document.createElement("div");
  actions.className = "setup-actions";
  const start = document.createElement("button");
  start.type = "button";
  start.className = "primary-action";
  start.dataset.startDive = "true";
  start.textContent = translate(locale, "setup.start");
  start.addEventListener("click", onStart);
  actions.append(start);
  return actions;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

/**
 * Whether the focused control already handles this key itself.
 *
 * Radios own the arrow keys — that traversal is why mode and site are radio
 * groups — and buttons own Enter and Space. Taking either at the document
 * level breaks the control and, worse, does something else instead.
 */
function nativelyHandles(target: EventTarget | null, key: string): boolean {
  if (!(target instanceof HTMLElement)) return false;

  if (target instanceof HTMLInputElement && target.type === "radio") {
    return key.startsWith("Arrow");
  }
  if (target instanceof HTMLButtonElement || target instanceof HTMLAnchorElement) {
    return key === "Enter" || key === " " || key === "Spacebar";
  }
  return false;
}

/**
 * A selector that finds the same control again after a re-render, built from
 * the data attributes the controls already carry for testing.
 */
function focusKeyOf(node: Element | null): string | null {
  if (!(node instanceof HTMLElement)) return null;

  const { setupOption, setupPreset, setupStep, startDive, backToSetup } =
    node.dataset;
  if (startDive !== undefined) return "[data-start-dive]";
  if (backToSetup !== undefined) return "[data-back-to-setup]";
  if (setupOption !== undefined) {
    return `[data-setup-option="${CSS.escape(setupOption)}"]`;
  }
  if (setupPreset !== undefined) {
    return `[data-setup-preset="${CSS.escape(setupPreset)}"]`;
  }
  if (setupStep !== undefined) {
    const stepper = node.closest<HTMLElement>("[data-setup-stepper]")?.dataset
      .setupStepper;
    if (!stepper) return null;
    return `[data-setup-stepper="${CSS.escape(stepper)}"] [data-setup-step="${CSS.escape(setupStep)}"]`;
  }
  return null;
}
