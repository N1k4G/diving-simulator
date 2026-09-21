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
  MAX_TANKS,
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
import {
  AMV_STEP_LPM,
  GRADIENT_FACTOR_STEP,
  HELIUM_FRACTION_STEP,
  TANK_VOLUME_STEP_L,
  addTank,
  adjustGradientFactorHigh,
  adjustGradientFactorLow,
  adjustHeliumFraction,
  adjustSurfaceAirConsumption,
  adjustTankVolume,
  removeTank,
  selectTankTab,
} from "./tec-controls";
import {
  CCR_DILUENT_PRESETS,
  CCR_PRESSURE_STEP_BAR,
  CCR_VOLUME_STEP_L,
  SETPOINT_STEP_BAR,
  adjustDiluentVolume,
  adjustOxygenPressure,
  adjustOxygenVolume,
  adjustSetpoint,
  applyDiluentPreset,
  matchingDiluentPreset,
} from "./ccr-controls";

// Decorative glyphs. The accessible name for each control comes from its
// aria-label, so these carry no meaning a translator would need; naming
// them also keeps them out of the no-literal-strings rule, which cannot
// tell a minus sign from a sentence.
const GLYPH_PLUS = "+";
const GLYPH_MINUS = "−";

// All three now that toInitialDiveOptions can express a loop setpoint and a
// diluent. CCR was offered and disabled with a stated reason through the
// first two slices rather than hidden, so enabling it changes one list.
const AVAILABLE_MODES: readonly DiveMode[] = DIVE_MODES;

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

// Keyed by preset id rather than by position, because the diluent list and the
// open-circuit list share two ids at different indices and a positional array
// would silently label Tx 15/45 as EAN32 if either list ever moved.
const DILUENT_LABEL_KEYS: Record<string, MessageKey> = {
  air: "setup.ccr.diluent.air",
  "tx21-35": "setup.ccr.diluent.tx2135",
  "tx15-45": "setup.ccr.diluent.tx1545",
  "tx10-70": "setup.ccr.diluent.tx1070",
  "hx10-90": "setup.ccr.diluent.hx1090",
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

    // The digits mean different things per mode: 1-8 pick an open-circuit gas,
    // 1-5 pick a diluent. Legacy splits them the same way — updateGasSetup
    // handles the CCR digits and returns before reaching the preset loop — and
    // sharing one branch would have bound key 3 to EAN32 as a diluent.
    const digitIndex = Number.parseInt(event.key, 10) - 1;
    if (!Number.isNaN(digitIndex) && digitIndex >= 0) {
      if (setup.mode === "ccr") {
        if (digitIndex < CCR_DILUENT_PRESETS.length) {
          event.preventDefault();
          update(applyDiluentPreset(setup, digitIndex));
          return;
        }
      } else if (digitIndex < presetCountFor(setup.mode)) {
        event.preventDefault();
        update(applyPreset(setup, digitIndex));
        return;
      }
    }

    switch (event.key) {
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
        // Mode and start are the only bindings every mode shares. Everything
        // else belongs to one surface, and CCR must not fall through to the
        // open-circuit keys: its screen shows no oxygen or pressure control,
        // so ArrowRight would silently edit a cylinder the player cannot see.
        // Legacy returns out of updateGasSetup for the same reason.
        if (setup.mode === "ccr") handleCcrKey(event);
        else handleOpenCircuitKey(event);
        break;
    }
  }

  function handleOpenCircuitKey(event: KeyboardEvent): void {
    const take = (next: DiveSetup): void => {
      event.preventDefault();
      update(next);
    };

    switch (event.key) {
      case "ArrowLeft":
        return take(adjustOxygenFraction(setup, -OXYGEN_FRACTION_STEP));
      case "ArrowRight":
        return take(adjustOxygenFraction(setup, OXYGEN_FRACTION_STEP));
      case "PageUp":
        return take(adjustTankPressure(setup, TANK_PRESSURE_STEP_BAR));
      case "PageDown":
        return take(adjustTankPressure(setup, -TANK_PRESSURE_STEP_BAR));
      default:
        if (setup.mode === "tec") handleTecKey(event);
        return;
    }
  }

  /**
   * CCR bindings, mirroring the legacy screen (src/ui.js updateGasSetup):
   * 1-5 diluent presets, [ and ] the setpoint, comma and period the diluent
   * cylinder.
   *
   * The oxygen cylinder's volume and pressure get no shortcut, because legacy
   * gives them none — they are button-only there too. They are reachable by
   * Tab and Enter like every other control on this screen, which is the point
   * of having given Tab back to the browser in the previous slice.
   */
  function handleCcrKey(event: KeyboardEvent): void {
    const take = (next: DiveSetup): void => {
      event.preventDefault();
      update(next);
    };

    switch (event.key) {
      case "[":
        return take(adjustSetpoint(setup, -SETPOINT_STEP_BAR));
      case "]":
        return take(adjustSetpoint(setup, SETPOINT_STEP_BAR));
      case ",":
        return take(adjustDiluentVolume(setup, -CCR_VOLUME_STEP_L));
      case ".":
        return take(adjustDiluentVolume(setup, CCR_VOLUME_STEP_L));
      default:
        return;
    }
  };

  // Tec-only bindings, mirroring the legacy screen (README, Gas Setup
  // Screen): up/down helium, [ ] consumption, comma/period tank size, + and -
  // add and remove a cylinder, g/G and f/F the gradient factors. Gated on the
  // mode so rec does not silently carry controls it does not show. Legacy's
  // TAB binding is not carried over — see the note in the switch.
  function handleTecKey(event: KeyboardEvent): void {
    const take = (next: DiveSetup): void => {
      event.preventDefault();
      update(next);
    };

    switch (event.key) {
      case "ArrowUp":
        return take(adjustHeliumFraction(setup, HELIUM_FRACTION_STEP));
      case "ArrowDown":
        return take(adjustHeliumFraction(setup, -HELIUM_FRACTION_STEP));
      case "[":
        return take(adjustSurfaceAirConsumption(setup, -AMV_STEP_LPM));
      case "]":
        return take(adjustSurfaceAirConsumption(setup, AMV_STEP_LPM));
      case ",":
        return take(adjustTankVolume(setup, -TANK_VOLUME_STEP_L));
      case ".":
        return take(adjustTankVolume(setup, TANK_VOLUME_STEP_L));
      // Tab is deliberately absent. The legacy screen used it to cycle
      // cylinders because a canvas has no focus order to protect; this one
      // does, and taking Tab would strand a keyboard user on whatever control
      // they were on — in a surface that is DOM precisely so it can be
      // navigated. The visible tank buttons are focusable and do the same job.
      case "+":
        return take(addTank(setup));
      case "-":
        return take(removeTank(setup));
      case "g":
        return take(adjustGradientFactorLow(setup, GRADIENT_FACTOR_STEP));
      case "G":
        return take(adjustGradientFactorLow(setup, -GRADIENT_FACTOR_STEP));
      case "f":
        return take(adjustGradientFactorHigh(setup, GRADIENT_FACTOR_STEP));
      case "F":
        return take(adjustGradientFactorHigh(setup, -GRADIENT_FACTOR_STEP));
      default:
        return;
    }
  }

  function draw(): void {
    // The SELECTED tab, not the active tank: the tab is the editing
    // cursor, and showing the active tank while editing another is how a
    // player changes a cylinder they cannot see (caught by the e2e tab test).
    const tank = setup.tanks[setup.selectedTabIndex];
    if (!tank) throw new Error("setup has no active tank");
    const isCcr = setup.mode === "ccr";

    // A full re-render replaces every control, including the focused one, so
    // keyboard operation would end after a single change: press the stepper's
    // + once and focus falls to <body>. Restore it by the data attribute the
    // control already carries.
    const focused = focusKeyOf(document.activeElement);

    shell.replaceChildren(
      heading(locale, setup.mode),
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
      // In CCR the legacy screen hides every open-circuit control — presets,
      // oxygen, pressure, tabs, helium, consumption, tank size and the
      // gradient factors (src/ui.js, the isCcr display switches). The dive
      // still carries the cylinder; the screen simply stops offering it.
      ...(isCcr
        ? ccrSection(locale, setup, update)
        : [
            presetGroup(locale, setup, (index) =>
              update(applyPreset(setup, index)),
            ),
            ...(setup.mode === "tec" ? [tankTabs(locale, setup, update)] : []),
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
          ]),
      ...(setup.mode === "tec"
        ? [
            stepper({
              labelKey: "setup.gas.helium",
              value: formatGasFraction(tank.gas.heliumFraction, locale),
              decreaseKey: "setup.gas.helium.decrease",
              increaseKey: "setup.gas.helium.increase",
              onDecrease: () => update(adjustHeliumFraction(setup, -HELIUM_FRACTION_STEP)),
              onIncrease: () => update(adjustHeliumFraction(setup, HELIUM_FRACTION_STEP)),
              locale,
              testId: "helium",
            }),
            stepper({
              labelKey: "setup.tank.volume",
              value: formatLitres(tank.volumeL, locale),
              decreaseKey: "setup.tank.volume.decrease",
              increaseKey: "setup.tank.volume.increase",
              onDecrease: () => update(adjustTankVolume(setup, -TANK_VOLUME_STEP_L)),
              onIncrease: () => update(adjustTankVolume(setup, TANK_VOLUME_STEP_L)),
              locale,
              testId: "volume",
            }),
            stepper({
              labelKey: "setup.amv",
              value: formatLitresPerMinute(setup.surfaceAirConsumptionLpm, locale),
              decreaseKey: "setup.amv.decrease",
              increaseKey: "setup.amv.increase",
              onDecrease: () => update(adjustSurfaceAirConsumption(setup, -AMV_STEP_LPM)),
              onIncrease: () => update(adjustSurfaceAirConsumption(setup, AMV_STEP_LPM)),
              locale,
              testId: "amv",
            }),
            stepper({
              labelKey: "setup.gf.low",
              value: formatPercent(setup.gradientFactorLow, locale),
              decreaseKey: "setup.gf.low.decrease",
              increaseKey: "setup.gf.low.increase",
              onDecrease: () => update(adjustGradientFactorLow(setup, -GRADIENT_FACTOR_STEP)),
              onIncrease: () => update(adjustGradientFactorLow(setup, GRADIENT_FACTOR_STEP)),
              locale,
              testId: "gf-low",
            }),
            stepper({
              labelKey: "setup.gf.high",
              value: formatPercent(setup.gradientFactorHigh, locale),
              decreaseKey: "setup.gf.high.decrease",
              increaseKey: "setup.gf.high.increase",
              onDecrease: () => update(adjustGradientFactorHigh(setup, -GRADIENT_FACTOR_STEP)),
              onIncrease: () => update(adjustGradientFactorHigh(setup, GRADIENT_FACTOR_STEP)),
              locale,
              testId: "gf-high",
            }),
          ]
        : []),
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

function heading(locale: SupportedLocale, mode: DiveMode): HTMLElement {
  const group = document.createElement("div");
  const eyebrow = element("p", "setup-eyebrow", translate(locale, "setup.eyebrow"));
  const title = element("h1", "setup-heading", translate(locale, "setup.heading"));
  title.id = "setup-heading";
  group.append(eyebrow, title);

  // CCR replaces the base hint rather than adding to it: that line promises
  // 1-8 gas presets, arrow-key oxygen and Page Up/Down pressure, and CCR
  // shows none of those controls. A hint is the one place a wrong key is
  // invisible to every test that only presses the right ones — the tec hint
  // went on promising Tab for a whole slice after Tab was given back to the
  // browser.
  if (mode === "ccr") {
    group.append(
      element("p", "setup-hint", translate(locale, "setup.keyboardHintCcr")),
    );
    return group;
  }

  group.append(
    element("p", "setup-hint", translate(locale, "setup.keyboardHint")),
  );
  if (mode === "tec") {
    group.append(
      element("p", "setup-hint", translate(locale, "setup.keyboardHintTec")),
    );
  }
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
  button.textContent = direction === "increase" ? GLYPH_PLUS : GLYPH_MINUS;
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
  if (node.dataset.setupDiluent !== undefined) {
    return `[data-setup-diluent="${CSS.escape(node.dataset.setupDiluent)}"]`;
  }
  if (node.dataset.setupTankAdd !== undefined) return "[data-setup-tank-add]";
  if (node.dataset.setupTankRemove !== undefined) {
    return "[data-setup-tank-remove]";
  }
  if (node.dataset.setupTab !== undefined) {
    return `[data-setup-tab="${CSS.escape(node.dataset.setupTab)}"]`;
  }
  if (setupStep !== undefined) {
    const stepper = node.closest<HTMLElement>("[data-setup-stepper]")?.dataset
      .setupStepper;
    if (!stepper) return null;
    return `[data-setup-stepper="${CSS.escape(stepper)}"] [data-setup-step="${CSS.escape(setupStep)}"]`;
  }
  return null;
}

/**
 * The tank tabs and the add/remove pair. Tec only: rec has one cylinder,
 * and the legacy screen shows no tabs for it either.
 */
function tankTabs(
  locale: SupportedLocale,
  setup: DiveSetup,
  update: (next: DiveSetup) => void,
): HTMLElement {
  const fieldset = document.createElement("fieldset");
  fieldset.className = "setup-group";
  fieldset.dataset.setupGroup = "tanks";
  const legend = document.createElement("legend");
  legend.textContent = translate(locale, "setup.tanks.legend");
  fieldset.append(legend);

  const list = document.createElement("div");
  list.className = "setup-choices";

  setup.tanks.forEach((_, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "setup-preset";
    button.dataset.setupTab = String(index);
    // aria-pressed rather than a radio: the tab is a view cursor, not a
    // value the dive is configured with, and a toggle reads that way.
    button.setAttribute("aria-pressed", String(index === setup.selectedTabIndex));
    button.textContent = translate(locale, "setup.tanks.tab").replace(
      "{n}",
      String(index + 1),
    );
    button.addEventListener("click", () => update(selectTankTab(setup, index)));
    list.append(button);
  });

  const add = document.createElement("button");
  add.type = "button";
  add.className = "setup-preset";
  add.dataset.setupTankAdd = "true";
  add.textContent = GLYPH_PLUS;
  add.setAttribute("aria-label", translate(locale, "setup.tanks.add"));
  add.disabled = setup.tanks.length >= MAX_TANKS;
  add.addEventListener("click", () => update(addTank(setup)));

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "setup-preset";
  remove.dataset.setupTankRemove = "true";
  remove.textContent = GLYPH_MINUS;
  remove.setAttribute("aria-label", translate(locale, "setup.tanks.remove"));
  remove.disabled = setup.tanks.length <= 1;
  remove.addEventListener("click", () => update(removeTank(setup)));

  list.append(add, remove);
  fieldset.append(list);
  return fieldset;
}

/**
 * The closed-circuit cards: diluent, setpoint and the two cylinders.
 *
 * Returns a list rather than one wrapper so the controls sit at the same
 * level as the open-circuit ones they replace — the stepper layout and the
 * 44 px touch-target check both work off that structure.
 */
function ccrSection(
  locale: SupportedLocale,
  setup: DiveSetup,
  update: (next: DiveSetup) => void,
): readonly HTMLElement[] {
  const { ccr } = setup;
  return [
    diluentGroup(locale, ccr, (index) =>
      update(applyDiluentPreset(setup, index)),
    ),
    stepper({
      labelKey: "setup.ccr.setpoint",
      value: formatBar(ccr.setpointBar, locale),
      decreaseKey: "setup.ccr.setpoint.decrease",
      increaseKey: "setup.ccr.setpoint.increase",
      onDecrease: () => update(adjustSetpoint(setup, -SETPOINT_STEP_BAR)),
      onIncrease: () => update(adjustSetpoint(setup, SETPOINT_STEP_BAR)),
      locale,
      testId: "setpoint",
    }),
    stepper({
      labelKey: "setup.ccr.diluentVolume",
      value: formatLitres(ccr.diluentCylinderVolumeL, locale),
      decreaseKey: "setup.ccr.diluentVolume.decrease",
      increaseKey: "setup.ccr.diluentVolume.increase",
      onDecrease: () => update(adjustDiluentVolume(setup, -CCR_VOLUME_STEP_L)),
      onIncrease: () => update(adjustDiluentVolume(setup, CCR_VOLUME_STEP_L)),
      locale,
      testId: "diluent-volume",
    }),
    stepper({
      labelKey: "setup.ccr.oxygenVolume",
      value: formatLitres(ccr.oxygenCylinderVolumeL, locale),
      decreaseKey: "setup.ccr.oxygenVolume.decrease",
      increaseKey: "setup.ccr.oxygenVolume.increase",
      onDecrease: () => update(adjustOxygenVolume(setup, -CCR_VOLUME_STEP_L)),
      onIncrease: () => update(adjustOxygenVolume(setup, CCR_VOLUME_STEP_L)),
      locale,
      testId: "oxygen-volume",
    }),
    stepper({
      labelKey: "setup.ccr.oxygenPressure",
      value: formatPressure(ccr.oxygenCylinderPressureBar, locale),
      decreaseKey: "setup.ccr.oxygenPressure.decrease",
      increaseKey: "setup.ccr.oxygenPressure.increase",
      onDecrease: () =>
        update(adjustOxygenPressure(setup, -CCR_PRESSURE_STEP_BAR)),
      onIncrease: () =>
        update(adjustOxygenPressure(setup, CCR_PRESSURE_STEP_BAR)),
      locale,
      testId: "oxygen-pressure",
    }),
  ];
}

function diluentGroup(
  locale: SupportedLocale,
  ccr: DiveSetup["ccr"],
  onSelect: (index: number) => void,
): HTMLElement {
  const fieldset = document.createElement("fieldset");
  fieldset.className = "setup-group";
  fieldset.dataset.setupGroup = "diluent";
  const legend = document.createElement("legend");
  legend.textContent = translate(locale, "setup.ccr.diluent.legend");
  fieldset.append(legend);

  const list = document.createElement("div");
  list.className = "setup-presets";
  const selected = matchingDiluentPreset(ccr);

  CCR_DILUENT_PRESETS.forEach((preset, index) => {
    const labelKey = DILUENT_LABEL_KEYS[preset.id];
    if (!labelKey) return;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "setup-preset";
    button.dataset.setupDiluent = preset.id;
    button.textContent = translate(locale, labelKey);
    // Which mix the loop is actually on. Legacy prints the matching preset's
    // name, or 'Custom'; a pressed state says the same thing to a screen
    // reader without a second line of text.
    button.setAttribute("aria-pressed", String(selected?.id === preset.id));
    button.setAttribute("aria-keyshortcuts", String(index + 1));
    button.addEventListener("click", () => onSelect(index));
    list.append(button);
  });

  // The mix can be none of the five: a diluent configured in another mode and
  // restored here, for instance. Saying so beats five unpressed buttons.
  if (!selected) {
    list.append(
      element(
        "small",
        "setup-choice-reason",
        translate(locale, "setup.ccr.diluent.custom"),
      ),
    );
  }

  fieldset.append(list);
  return fieldset;
}

function formatBar(value: number, locale: SupportedLocale): string {
  return `${new Intl.NumberFormat(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value)} bar`;
}

function formatLitres(value: number, locale: SupportedLocale): string {
  return `${new Intl.NumberFormat(locale).format(value)} L`;
}

function formatLitresPerMinute(value: number, locale: SupportedLocale): string {
  return `${new Intl.NumberFormat(locale).format(value)} L/min`;
}

function formatPercent(value: number, locale: SupportedLocale): string {
  return new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(value / 100);
}
