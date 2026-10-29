// Legacy's instructor panel (#46, src/renderer.js drawInstructorOverlay), the
// "PHYSICS LIVE" overlay on L, as DOM beside the stage (#160).
//
// - L or its button toggles it, only while diving, legacy's `gameState ===
//   'diving'` (src/state.js keydown, src/touch.js touch-dive-learn): not at the
//   surface before the dive, nor while a drill's decision or debriefing stops
//   it (legacy's 'drill' state), nor once it has ended. Off by default, and a new
//   dive keeps the choice, as legacy's resetDive() keeps instructorMode.
// - Hidden under the help and the gas information, as legacy's drawScene()
//   skips it under showHelp and infoPageMode.
// - Its values change every frame and are no live region: the toggle alone
//   is announced, once, through a status region of its own (#138).
// - It stands where the camera never draws the diver mid-route: at the
//   stage's right on a wide screen, below the diver's deepest line on a phone
//   in portrait. No readout and no onboarding hint is ever under it
//   (diagnostic.css).
import type { GameFrame } from "./game-controller";
import { translate, type MessageKey, type SupportedLocale } from "./i18n/catalog";
import { formatDepth, formatFixed, formatPartialPressure, formatPercent } from "./i18n/formatters";
import { element } from "./game-over";
import type { InstructorPhysics } from "../presentation/instructor-physics";

const PANEL_ID = "wreck-instructor";
const ROWS = ["pressure", "bcd", "tissue", "consumption", "gas"] as const;
type RowId = (typeof ROWS)[number];

export interface InstructorPanelElements {
  readonly panel: HTMLElement;
  readonly toggle: HTMLButtonElement;
  /** Written only when the panel is toggled. */
  readonly status: HTMLElement;
  readonly rows: Readonly<Record<RowId, { label: HTMLElement; value: HTMLElement; formula: HTMLElement }>>;
  readonly bar: { readonly surface: HTMLElement; readonly effective: HTMLElement };
}

/** L, either case, unmodified but for Shift. */
export function isInstructorKey(event: KeyboardEvent): boolean {
  return !event.ctrlKey && !event.metaKey && !event.altKey && (event.key === "l" || event.key === "L");
}

/** Legacy's `gameState === 'diving'`: begun, not failed, not surfaced at the end. */
export function instructorAvailable(frame: Pick<GameFrame, "awaitingDescent" | "presentation" | "drill">): boolean {
  const { status, completed } = frame.presentation;
  // A drill's decision and debriefing are legacy's 'drill' state, not
  // 'diving' (src/game-loop.js _openDrillOverlay, dismissDrillDebrief).
  return !frame.awaitingDescent && frame.drill === null && status !== "failed" && !completed;
}

/** Legacy's guard in drawScene(): on, diving, and no help or gas page over it. */
export function instructorPanelShown(
  on: boolean,
  available: boolean,
  covered: { readonly help: boolean; readonly gasInfo: boolean },
): boolean {
  return on && available && !covered.help && !covered.gasInfo;
}

export function createInstructorPanel(locale: SupportedLocale): InstructorPanelElements {
  const t = (key: MessageKey) => translate(locale, key);
  const panel = document.createElement("section");
  panel.className = "instructor-panel";
  panel.id = PANEL_ID;
  panel.dataset.instructorPanel = "true";
  panel.hidden = true;
  panel.setAttribute("aria-labelledby", `${PANEL_ID}-heading`);
  // It scrolls where the column is short, so a keyboard can reach it.
  panel.tabIndex = 0;
  const heading = element("h2", "instructor-heading", t("instructor.title"));
  heading.id = `${PANEL_ID}-heading`;
  const list = document.createElement("dl");
  const rows = {} as Record<RowId, { label: HTMLElement; value: HTMLElement; formula: HTMLElement }>;
  for (const id of ROWS) {
    const group = document.createElement("div");
    group.dataset.instructorRow = id;
    const row = {
      label: element("dt", "", t(`instructor.${id}.label`)),
      value: element("dd", "instructor-value", ""),
      formula: element("dd", "instructor-formula", t(`instructor.${id}.formula`)),
    };
    group.append(row.label, row.value, row.formula);
    list.append(group);
    rows[id] = row;
  }
  // Legacy's bar under the BCD's value: the gas at depth over a faint bar of
  // the same gas at the surface, both against the BCD's capacity. The
  // numbers say it; the bar repeats it for the eye.
  const barTrack = element("dd", "instructor-bar", "");
  barTrack.setAttribute("aria-hidden", "true");
  const bar = { surface: element("span", "instructor-bar-surface", ""), effective: element("span", "instructor-bar-effective", "") };
  barTrack.append(bar.surface, bar.effective);
  rows.bcd.value.after(barTrack);
  panel.append(heading, element("p", "instructor-toggle-hint", t("instructor.toggleHint")), list);

  // Legacy's touch-dive-learn, the L key's button, shown while diving.
  const toggle = element("button", "instructor-control", t("instructor.symbol"));
  toggle.type = "button";
  toggle.hidden = true;
  toggle.dataset.instructorToggle = "true";
  toggle.setAttribute("aria-label", t("instructor.open"));
  toggle.setAttribute("aria-keyshortcuts", "L");
  toggle.setAttribute("aria-controls", PANEL_ID);
  toggle.setAttribute("aria-pressed", "false");

  const status = element("p", "visually-hidden", "");
  status.dataset.instructorStatus = "true";
  status.setAttribute("role", "status");
  return { panel, toggle, status, rows, bar };
}

/**
 * Keeps the HUD's height on the side as `--wreck-hud-height`, so on a phone
 * the panel stands below the HUD as well as below the diver (diagnostic.css).
 * `under` stands under the HUD in the column (the notice that the dive is
 * not being saved, #282) and counts with it while it stands in the
 * column's flow: empty, or while an open panel takes its place, it is out of
 * it. Written only when either's size changes; returns the disconnect.
 */
export function trackHudHeight(hud: HTMLElement, side: HTMLElement, under?: HTMLElement): () => void {
  if (typeof ResizeObserver === "undefined") {
    return () => {};
  }
  const observer = new ResizeObserver(() => {
    const height =
      under !== undefined && getComputedStyle(under).position !== "absolute"
        ? under.offsetTop + under.offsetHeight - hud.offsetTop
        : hud.offsetHeight;
    side.style.setProperty("--wreck-hud-height", `${height}px`);
  });
  observer.observe(hud);
  if (under !== undefined) observer.observe(under);
  return () => observer.disconnect();
}

/** Says, once, which way the panel was toggled (#138). */
export function announceInstructor(elements: InstructorPanelElements, on: boolean, locale: SupportedLocale): void {
  elements.status.textContent = translate(locale, on ? "instructor.shown" : "instructor.hidden");
}

/**
 * Brings the panel in line with the frame: the toggle's state, whether the
 * panel shows, and its values, each written only when it changes.
 */
export function syncInstructorPanel(
  elements: InstructorPanelElements,
  state: { readonly on: boolean; readonly available: boolean; readonly physics: InstructorPhysics | null },
  locale: SupportedLocale,
): void {
  const t = (key: MessageKey) => translate(locale, key);
  elements.toggle.hidden = !state.available;
  setAttribute(elements.toggle, "aria-pressed", String(state.on));
  elements.panel.hidden = state.physics === null;
  const physics = state.physics;
  if (physics === null) {
    return;
  }
  const { rows } = elements;
  const fixed = (value: number, digits: number) => formatFixed(value, digits, locale);
  setText(rows.pressure.value, formatPartialPressure(physics.ambientPressureBar, locale));

  const surface = fixed(physics.bcdSurfaceLitres, 1);
  const effective = fixed(physics.bcdEffectiveLitres, 1);
  const shown = t("instructor.bcd.value").replace("{surface}", surface).replace("{effective}", effective);
  if (rows.bcd.value.dataset.shown !== shown) {
    rows.bcd.value.dataset.shown = shown;
    const visible = element("span", "", shown);
    visible.setAttribute("aria-hidden", "true");
    const spoken = t("instructor.bcd.spoken").replace("{surface}", surface).replace("{effective}", effective);
    rows.bcd.value.replaceChildren(visible, element("span", "visually-hidden", spoken));
  }
  elements.bar.surface.style.setProperty("--share", String(physics.bcdSurfaceShare));
  elements.bar.effective.style.setProperty("--share", String(physics.bcdEffectiveShare));

  const lead = physics.leadingTissue;
  setText(
    rows.tissue.label,
    lead === null
      ? t("instructor.tissue.label")
      : `${t("instructor.tissue.label")} ${t("instructor.tissue.compartment")
          .replace("{n}", String(lead.compartment))
          .replace("{halfTime}", fixed(lead.halfTimeMin, 0))}`,
  );
  const tissue = leadingTissueValue(lead, locale);
  setValue(rows.tissue.value, tissue.text, tissue.hiddenWord);
  setText(rows.tissue.formula, t(lead === null ? "instructor.tissue.none" : "instructor.tissue.formula"));
  setSeverity(rows.tissue.value, lead?.severity ?? "none");

  // On an active loop there is no open circuit to bill (#183, #192).
  setText(
    rows.consumption.value,
    physics.consumptionLpm === null
      ? translate(locale, "wreck.value.unavailable")
      : t("instructor.consumption.value")
          .replace("{rate}", fixed(physics.consumptionLpm, 1))
          .replace("{factor}", fixed(physics.ambientPressureBar, 1)),
  );

  const mod = physics.modM === null ? translate(locale, "wreck.value.unavailable") : formatDepth(physics.modM, locale);
  setText(
    rows.gas.value,
    warned(
      t("instructor.gas.value")
        .replace("{mod}", mod)
        .replace("{end}", formatDepth(physics.endM, locale))
        .replace("{narcosis}", formatPercent(physics.narcosisPercent / 100, locale)),
      physics.beyondMod,
      locale,
    ),
  );
  setSeverity(rows.gas.value, physics.beyondMod ? "warning" : "none");
}

/**
 * The leading tissue's value, and the word assistive technology hears after
 * it: its caution tier is a tint and a hidden word, as the gas page's
 * (src/app/gas-info.ts), its danger tier carries the ⚠, so colour is never
 * alone.
 */
export function leadingTissueValue(
  lead: InstructorPhysics["leadingTissue"],
  locale: SupportedLocale,
): { readonly text: string; readonly hiddenWord: string | null } {
  if (lead === null) {
    return { text: translate(locale, "wreck.value.unavailable"), hiddenWord: null };
  }
  const text = translate(locale, "instructor.tissue.value").replace("{percent}", formatPercent(lead.percent / 100, locale));
  return {
    text: warned(text, lead.severity === "danger", locale),
    hiddenWord: lead.severity === "caution" ? translate(locale, "instructor.severity.caution") : null,
  };
}

/** Legacy's danger and warn tones carry the ⚠ too, so colour is not alone (#39). */
function warned(text: string, warning: boolean, locale: SupportedLocale): string {
  return warning ? `${translate(locale, "wreck.symbol.warning")} ${text}` : text;
}

/** The text, and a hidden word after it when there is one, rebuilt only on a change. */
function setValue(target: HTMLElement, text: string, hiddenWord: string | null): void {
  const shown = hiddenWord === null ? text : `${text} ${hiddenWord}`;
  if (target.dataset.shown === shown) {
    return;
  }
  target.dataset.shown = shown;
  target.textContent = text;
  if (hiddenWord !== null) {
    target.append(element("span", "visually-hidden", ` ${hiddenWord}`));
  }
}

function setText(target: HTMLElement, text: string): void {
  if (target.textContent !== text) {
    target.textContent = text;
  }
}

function setAttribute(target: HTMLElement, name: string, value: string): void {
  if (target.getAttribute(name) !== value) {
    target.setAttribute(name, value);
  }
}

function setSeverity(target: HTMLElement, severity: string): void {
  if ((target.dataset.severity ?? "none") !== severity) {
    if (severity === "none") {
      delete target.dataset.severity;
    } else {
      target.dataset.severity = severity;
    }
  }
}
