// What the help overlay lists (#160), by state and by what the dive offers.
// Pure, so the rules can be tested without a DOM.
//
// Legacy's H / ? overlay (src/state.js showHtmlHelp) opens with its
// controlsText, one paragraph naming every key, then explains its dive
// computer's readouts. This lists the controls only, and only those this
// client has: each row is a key, the on-screen button that does the same,
// and what both do. A row is left out where the control is not on offer on
// this dive, as the HUD hides the control itself: the cylinder keys with one
// cylinder or on a rebreather, I on a recreational dive, the setpoint and
// bailout off the loop.
import type { MessageKey } from "./i18n/catalog";

/**
 * Where the overlay is opened: legacy's 'surface' and 'diving' states, and
 * its 'post-dive' screen. Legacy sets showHelp in every state but the gas
 * setup and shows the overlay in these three; its game-over state draws none.
 */
export type HelpState = "surface" | "diving" | "post-dive";

export interface HelpContext {
  readonly state: HelpState;
  /** I opens the gas information: technical and rebreather dives. */
  readonly gasInfo: boolean;
  /** Cylinders the digit keys switch between; one or none offers no keys. */
  readonly switchableCylinders: number;
  /** The loop's setpoint and bailout are on offer: a rebreather, not bailed out. */
  readonly loopControls: boolean;
}

export interface HelpRow {
  readonly keys: MessageKey;
  /** The on-screen control that does the same. */
  readonly touch: MessageKey;
  readonly action: MessageKey;
  /** Replaces `{n}` in the keys and the touch text: the cylinder count. */
  readonly count?: number;
}

export interface HelpSection {
  readonly headingKey: MessageKey;
  readonly rows: readonly HelpRow[];
}

const HELP_ROWS: readonly HelpRow[] = [
  { keys: "help.keys.help", touch: "help.symbol", action: "help.action.help" },
  { keys: "help.keys.close", touch: "help.touch.close", action: "help.action.close" },
];

/** The controls of the dive itself, as wreck-app.ts and the controller bind them. */
function diveRows(context: Readonly<HelpContext>): HelpRow[] {
  const rows: HelpRow[] = [
    { keys: "help.keys.ascend", touch: "help.touch.ascend", action: "wreck.controls.ascend" },
    { keys: "help.keys.descend", touch: "help.touch.descend", action: "wreck.controls.descend" },
    { keys: "help.keys.left", touch: "help.touch.left", action: "wreck.controls.left" },
    { keys: "help.keys.right", touch: "help.touch.right", action: "wreck.controls.right" },
    { keys: "help.keys.torch", touch: "wreck.symbol.torch", action: "wreck.controls.torch" },
    {
      keys: "help.keys.fastForward",
      touch: "wreck.symbol.fastForward",
      action: "wreck.controls.fastForward",
    },
  ];
  if (context.switchableCylinders > 1) {
    rows.push({
      keys: "help.keys.cylinders",
      touch: "help.keys.cylinders",
      action: "help.action.cylinder",
      count: context.switchableCylinders,
    });
  }
  if (context.gasInfo) {
    rows.push({ keys: "help.keys.gasInfo", touch: "wreck.symbol.gasInfo", action: "wreck.gasInfo.open" });
  }
  if (context.loopControls) {
    rows.push(
      { keys: "help.keys.setpoint", touch: "help.touch.setpoint", action: "help.action.setpoint" },
      { keys: "help.keys.bailout", touch: "wreck.controls.bailout.label", action: "wreck.controls.bailout" },
    );
  }
  // The audio button has no key, here or in legacy.
  rows.push({ keys: "wreck.value.unavailable", touch: "wreck.symbol.audio", action: "wreck.controls.mute" });
  return rows;
}

/**
 * The sections for a state, in the order shown. The dive's own controls are
 * listed in every state: at the surface they are what is coming, after the
 * dive what was used.
 */
export function helpSections(context: Readonly<HelpContext>): HelpSection[] {
  const dive: HelpSection = { headingKey: "help.section.dive", rows: diveRows(context) };
  switch (context.state) {
    case "surface":
      return [
        {
          headingKey: "help.section.surface",
          // Legacy's updateSurface() reads S, and nothing else, to begin.
          rows: [
            { keys: "help.keys.descend", touch: "help.touch.descend", action: "wreck.controls.descend" },
            ...HELP_ROWS,
          ],
        },
        dive,
      ];
    case "diving":
      return [{ ...dive, rows: [...dive.rows, ...HELP_ROWS] }];
    case "post-dive":
      return [
        {
          headingKey: "help.section.postDive",
          rows: [
            { keys: "help.keys.diveAgain", touch: "postDive.diveAgain", action: "postDive.diveAgain" },
            ...HELP_ROWS,
          ],
        },
        dive,
      ];
  }
}

/**
 * Whether the dive stands still while the overlay is open. Legacy's
 * gameLoop() skips updateDiving() while showHelp is set, in 'diving' only:
 * at the surface updateSurface() runs on, and there is no dive clock yet.
 */
export function helpPausesDive(state: HelpState): boolean {
  return state === "diving";
}
