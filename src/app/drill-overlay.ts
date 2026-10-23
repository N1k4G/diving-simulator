// A training drill's decision and debriefing (#160): legacy's
// drawDrillOverlay() and drawDrillDebrief() (src/renderer.js) as a modal
// dialog over the stage.
//
// - The decision: the drill's title and situation, and its options as
//   buttons numbered by the keys that pick them, 1 / 2 / 3, as legacy's rows.
//   A tap on one picks it, as a tap on legacy's row. Nothing else closes it,
//   Escape and Android's back included.
// - The debriefing: right or not, why, and in the real world. Enter, its
//   Continue or a tap outside it ends it, as legacy's Enter and any tap do;
//   so does its time, which the controller runs down.
// - While open it takes the key presses, as the help does; releases pass, so
//   a key let go here is let go in the dive.
// - Each is announced once, as a dialog named by its heading when focus moves
//   into it, and written only when the drill or its phase changes, never per
//   frame. Nothing in it is a live region (#138).
import { translate, type MessageKey, type SupportedLocale } from "./i18n/catalog";
import { element } from "./game-over";
import type { DrillId } from "../core/drills";
import type { DrillFrame } from "./game-controller";

/** Each drill's words: legacy's STRINGS.*.drills.<id>, its options in catalogue order. */
export const DRILL_MESSAGES: Readonly<
  Record<DrillId, { titleKey: MessageKey; textKey: MessageKey; optionKeys: readonly MessageKey[]; whyKey: MessageKey; realWorldKey: MessageKey }>
> = Object.freeze({
  freeflow: {
    titleKey: "drill.freeflow.title",
    textKey: "drill.freeflow.text",
    optionKeys: ["drill.freeflow.option1", "drill.freeflow.option2", "drill.freeflow.option3"],
    whyKey: "drill.freeflow.why",
    realWorldKey: "drill.freeflow.realWorld",
  },
  co2: {
    titleKey: "drill.co2.title",
    textKey: "drill.co2.text",
    optionKeys: ["drill.co2.option1", "drill.co2.option2"],
    whyKey: "drill.co2.why",
    realWorldKey: "drill.co2.realWorld",
  },
});

export interface DrillOverlayOptions {
  readonly locale: SupportedLocale;
  readonly onChoose: (index: number) => void;
  readonly onContinue: () => void;
  /** As it opens: whatever is held is let go. */
  readonly onOpen?: () => void;
}

export interface DrillOverlay {
  /** The frame's drill; the dialog changes only when its drill or phase does. */
  sync(drill: Readonly<DrillFrame> | null): void;
  destroy(): void;
}

export function createDrillOverlay(options: Readonly<DrillOverlayOptions>): DrillOverlay {
  const t = (key: MessageKey) => translate(options.locale, key);
  const dialog = document.createElement("dialog");
  dialog.className = "help-overlay drill-overlay";
  dialog.dataset.drillOverlay = "true";
  dialog.tabIndex = -1;
  dialog.setAttribute("aria-labelledby", "drill-eyebrow drill-heading");
  dialog.setAttribute("aria-describedby", "drill-text");
  document.body.append(dialog);

  let current: Readonly<DrillFrame> | null = null;
  let shown: string | null = null;
  let returnFocus: HTMLElement | null = null;

  // Legacy reads 1, 2 and 3 for the decision and Enter for the debriefing.
  // stopPropagation() keeps every press from the dive and the screens; Tab,
  // and Enter or Space on a focused option, keep their default.
  function takeKey(event: KeyboardEvent): void {
    if (event.type === "keyup") {
      return;
    }
    event.stopPropagation();
    // Escape's default is the dialog's close request: none is made.
    if (event.key === "Escape") {
      event.preventDefault();
      return;
    }
    if (!current || event.repeat || event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }
    if (current.phase === "overlay" && /^[1-3]$/.test(event.key)) {
      event.preventDefault();
      options.onChoose(Number(event.key) - 1);
    } else if (current.phase === "debrief" && event.key === "Enter") {
      event.preventDefault();
      options.onContinue();
    }
  }

  const close = () => {
    window.removeEventListener("keydown", takeKey, true);
    window.removeEventListener("keyup", takeKey, true);
    if (dialog.open) {
      dialog.close();
    }
  };

  // A tap outside the debriefing ends it, as any tap on legacy's canvas does.
  dialog.addEventListener("click", (event) => {
    const box = dialog.getBoundingClientRect();
    const outside =
      event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
    if (event.target === dialog && outside && current?.phase === "debrief") {
      options.onContinue();
    }
  });
  // Escape, or Android's back gesture, closes neither: a drill is answered.
  // closedby="none" asks the browser for no close request at all; a cancelled
  // cancel holds only with recent user activation, and Chromium closes the
  // dialog on the next request without one. If it is closed by anything but
  // close() while the drill is still up, it opens again at once, so the
  // dialog, its keys and the stopped dive cannot part.
  dialog.setAttribute("closedby", "none");
  dialog.addEventListener("cancel", (event) => event.preventDefault());
  dialog.addEventListener("close", () => {
    if (current && !dialog.open && dialog.isConnected) {
      dialog.showModal();
      (dialog.querySelector<HTMLElement>("[data-drill-continue]") ?? dialog).focus();
    }
  });

  return {
    sync(drill) {
      current = drill;
      const key = drill ? `${drill.id}:${drill.phase}` : null;
      if (key === shown) {
        return;
      }
      shown = key;
      if (!drill) {
        close();
        if (returnFocus?.isConnected) {
          returnFocus.focus();
        }
        returnFocus = null;
        return;
      }
      if (!dialog.open) {
        returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        options.onOpen?.();
      }
      // Closed and opened again, so the debriefing is announced as the
      // decision was.
      close();
      dialog.dataset.phase = drill.phase;
      dialog.toggleAttribute("data-correct", drill.phase === "debrief" && drill.correct);
      dialog.replaceChildren(...(drill.phase === "overlay" ? decision(drill, t, options.onChoose) : debriefing(drill, t, options.onContinue)));
      window.addEventListener("keydown", takeKey, true);
      window.addEventListener("keyup", takeKey, true);
      dialog.showModal();
      dialog.scrollTop = 0;
      // The decision takes focus itself, so Enter picks nothing by accident.
      (dialog.querySelector<HTMLElement>("[data-drill-continue]") ?? dialog).focus();
    },
    destroy() {
      current = null;
      close();
      dialog.remove();
    },
  };
}

function decision(
  drill: Readonly<DrillFrame>,
  t: (key: MessageKey) => string,
  onChoose: (index: number) => void,
): HTMLElement[] {
  const messages = DRILL_MESSAGES[drill.id];
  const eyebrow = element("p", "drill-eyebrow", `${t("wreck.symbol.warning")} ${t("drill.header")}`);
  eyebrow.id = "drill-eyebrow";
  const heading = element("h2", "", t(messages.titleKey));
  heading.id = "drill-heading";
  const text = element("p", "", t(messages.textKey));
  text.id = "drill-text";
  const list = element("div", "drill-options", "");
  drill.options.forEach((option, index) => {
    const key = messages.optionKeys[option];
    if (!key) {
      return;
    }
    // Each row reads its own option. Legacy reads the catalogue at the row's
    // place among those offered (docs/decisions.md, departures), so with one
    // cylinder its second row read "Switch to your backup tank" and held the
    // diver's breath.
    const button = element("button", "help-close drill-option", `${index + 1}. ${t(key)}`);
    button.type = "button";
    button.dataset.drillOption = String(index);
    button.setAttribute("aria-keyshortcuts", String(index + 1));
    button.addEventListener("click", () => onChoose(index));
    list.append(button);
  });
  return [eyebrow, heading, text, list, element("p", "help-hint", t("drill.prompt"))];
}

function debriefing(
  drill: Readonly<DrillFrame>,
  t: (key: MessageKey) => string,
  onContinue: () => void,
): HTMLElement[] {
  const messages = DRILL_MESSAGES[drill.id];
  const eyebrow = element("p", "drill-eyebrow", `${t("drill.debrief.header")} — ${t(messages.titleKey)}`);
  eyebrow.id = "drill-eyebrow";
  const heading = element("h2", "", t(drill.correct ? "drill.debrief.correct" : "drill.debrief.wrong"));
  heading.id = "drill-heading";
  const why = element("p", "", t(messages.whyKey));
  why.id = "drill-text";
  const proceed = element("button", "help-close", t("drill.continue"));
  proceed.type = "button";
  proceed.dataset.drillContinue = "true";
  proceed.setAttribute("aria-keyshortcuts", "Enter");
  proceed.addEventListener("click", onContinue);
  return [
    eyebrow,
    heading,
    element("h3", "", t("drill.debrief.why")),
    why,
    element("h3", "", t("drill.debrief.realWorld")),
    element("p", "", t(messages.realWorldKey)),
    proceed,
    element("p", "help-hint", t("drill.debrief.dismiss")),
  ];
}
