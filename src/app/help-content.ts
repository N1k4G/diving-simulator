// What the help overlay lists (#160): the controls this client has, each as
// its key, the on-screen button that does the same, and what both do. Legacy's
// overlay (src/state.js showHtmlHelp) opens with its controlsText; its dive
// computer guide after that is not ported. A row is left out where the HUD
// hides the control itself on this dive.
import type { MessageKey } from "./i18n/catalog";

/** Legacy shows the overlay in 'surface', 'diving' and 'post-dive', never on its game over. */
export type HelpState = "surface" | "diving" | "post-dive";

export interface HelpContext {
  readonly state: HelpState;
  /** I opens the gas information: technical and rebreather dives. */
  readonly gasInfo: boolean;
  /** Cylinders the digit keys switch between; one or none offers no keys. */
  readonly switchableCylinders: number;
  /** The loop's setpoint and bailout: a rebreather, not bailed out. */
  readonly loopControls: boolean;
  /** The D-pad shows arrows (a touch screen) rather than W, S, A and D (#255). */
  readonly arrowGlyphs: boolean;
}

export interface HelpRow {
  readonly keys: MessageKey;
  /** The on-screen button's face, by the key the button shows; a pair is joined. */
  readonly touch: MessageKey | readonly [MessageKey, MessageKey];
  readonly action: MessageKey;
  /** Replaces `{n}` in the keys and the touch text. */
  readonly count?: number;
}

export interface HelpSection {
  readonly headingKey: MessageKey;
  readonly rows: readonly HelpRow[];
}

const row = (keys: MessageKey, touch: HelpRow["touch"], action: MessageKey): HelpRow => ({ keys, touch, action });

const HELP_ROWS = [
  row("help.keys.help", "help.symbol", "help.action.help"),
  row("help.keys.close", "help.touch.close", "help.action.close"),
];
/** A D-pad direction, named by the face the pad shows (createDpadButtons). */
function padRow(direction: "ascend" | "descend" | "left" | "right", arrows: boolean): HelpRow {
  return row(
    `help.keys.${direction}`,
    arrows ? `wreck.symbol.dpad.${direction}` : `wreck.symbol.dpad.key.${direction}`,
    `wreck.controls.${direction}`,
  );
}

function diveRows(context: Readonly<HelpContext>): HelpRow[] {
  const rows = [
    padRow("ascend", context.arrowGlyphs),
    padRow("descend", context.arrowGlyphs),
    padRow("left", context.arrowGlyphs),
    padRow("right", context.arrowGlyphs),
    row("help.keys.torch", "wreck.symbol.torch", "wreck.controls.torch"),
    row("help.keys.fastForward", "wreck.symbol.fastForward", "wreck.controls.fastForward"),
  ];
  if (context.switchableCylinders > 1) {
    rows.push({
      ...row("help.keys.cylinders", "help.keys.cylinders", "help.action.cylinder"),
      count: context.switchableCylinders,
    });
  }
  if (context.gasInfo) {
    rows.push(row("help.keys.gasInfo", "wreck.symbol.gasInfo", "wreck.gasInfo.open"));
  }
  if (context.loopControls) {
    rows.push(
      row("help.keys.setpoint", ["wreck.symbol.setpointDown", "wreck.symbol.setpointUp"], "help.action.setpoint"),
      row("help.keys.bailout", "wreck.controls.bailout.label", "wreck.controls.bailout"),
    );
  }
  // L, legacy's Learn button: the instructor panel (#46), while diving.
  rows.push(row("instructor.symbol", "instructor.symbol", "instructor.open"));
  // The audio button has no key, here or in legacy.
  rows.push(row("wreck.value.unavailable", "wreck.symbol.audio", "wreck.controls.mute"));
  return rows;
}

/**
 * The sections for a state, in order. The dive's controls are listed in
 * every state: at the surface what is coming, after the dive what was used.
 */
export function helpSections(context: Readonly<HelpContext>): HelpSection[] {
  const dive = diveRows(context);
  switch (context.state) {
    case "surface":
      // Legacy's updateSurface() reads S, and nothing else, to begin.
      return [
        { headingKey: "help.section.surface", rows: [padRow("descend", context.arrowGlyphs), ...HELP_ROWS] },
        { headingKey: "help.section.dive", rows: dive },
      ];
    case "diving":
      return [{ headingKey: "help.section.dive", rows: [...dive, ...HELP_ROWS] }];
    case "post-dive":
      return [
        {
          headingKey: "help.section.postDive",
          rows: [row("help.keys.diveAgain", "postDive.diveAgain", "postDive.diveAgain"), ...HELP_ROWS],
        },
        { headingKey: "help.section.dive", rows: dive },
      ];
  }
}

/** Legacy's gameLoop() skips updateDiving() while showHelp, in 'diving' only. */
export function helpPausesDive(state: HelpState): boolean {
  return state === "diving";
}
