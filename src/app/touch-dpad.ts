// The D-pad (#168): ascend, descend, left and right as DOM buttons over the
// Pixi stage, held for as long as a finger or the mouse stays down.
//
// src/touch.js is the behavioural reference: initNavPad() labels the cross
// with arrows on a touch screen and W/A/S/D on a desktop, and bindHold()
// holds a direction from pointerdown to pointerup or pointercancel, with
// pointer capture so a thumb that slides off the button keeps it held.
//
// It drives the same intents as the keyboard, GameController.setControl, and
// never a synthetic key: a key event that is never followed by its keyup is
// how a direction gets stuck (#168, "Do not"). Nothing here touches the model.
//
// A direction is released on every way a press can end without a pointerup:
// pointercancel (the browser took the gesture), lostpointercapture (the
// button let go of the pointer), and the window losing focus or the page
// being hidden, after which no pointerup is ever delivered to the page.

import { translate, type MessageKey, type SupportedLocale } from "./i18n/catalog";
import type { ContinuousControl } from "./game-controller";

/** The one call the D-pad makes into the controller. */
export interface DpadTarget {
  setControl(control: ContinuousControl, active: boolean): void;
}

/**
 * Which pointer holds which direction.
 *
 * A direction is held while at least one pointer is down on its button and
 * released when the last one lets go, so two fingers on one button do not
 * release it when the first lifts, and a pointer's second release does
 * nothing. Kept apart from the DOM so the bookkeeping can be tested on its
 * own.
 */
export class DpadHolds {
  readonly #target: DpadTarget;
  readonly #pointers = new Map<number, ContinuousControl>();

  constructor(target: DpadTarget) {
    this.#target = target;
  }

  /** Whether any pointer holds this direction. */
  holds(control: ContinuousControl): boolean {
    for (const held of this.#pointers.values()) {
      if (held === control) {
        return true;
      }
    }
    return false;
  }

  press(pointerId: number, control: ContinuousControl): void {
    if (this.#pointers.get(pointerId) === control) {
      return;
    }
    this.release(pointerId);
    const alreadyHeld = this.holds(control);
    this.#pointers.set(pointerId, control);
    if (!alreadyHeld) {
      this.#target.setControl(control, true);
    }
  }

  release(pointerId: number): void {
    const control = this.#pointers.get(pointerId);
    if (control === undefined) {
      return;
    }
    this.#pointers.delete(pointerId);
    if (!this.holds(control)) {
      this.#target.setControl(control, false);
    }
  }

  /** Lets go of everything, for a lost focus or a hidden page. */
  releaseAll(): void {
    for (const pointerId of [...this.#pointers.keys()]) {
      this.release(pointerId);
    }
  }
}

/**
 * Legacy's `isTouchDevice` (src/touch.js): a screen that can be touched gets
 * arrows, since a phone has no W key to name.
 */
export function prefersArrowGlyphs(): boolean {
  return "ontouchstart" in window || navigator.maxTouchPoints > 0;
}

const DPAD_ORDER = ["left", "ascend", "descend", "right"] as const;

const DPAD_LABELS: Readonly<
  Record<
    ContinuousControl,
    {
      readonly name: MessageKey;
      readonly arrow: MessageKey;
      readonly key: MessageKey;
      readonly shortcuts: string;
    }
  >
> = {
  ascend: {
    name: "wreck.controls.ascend",
    arrow: "wreck.symbol.dpad.ascend",
    key: "wreck.symbol.dpad.key.ascend",
    shortcuts: "W ArrowUp",
  },
  descend: {
    name: "wreck.controls.descend",
    arrow: "wreck.symbol.dpad.descend",
    key: "wreck.symbol.dpad.key.descend",
    shortcuts: "S ArrowDown",
  },
  left: {
    name: "wreck.controls.left",
    arrow: "wreck.symbol.dpad.left",
    key: "wreck.symbol.dpad.key.left",
    shortcuts: "A ArrowLeft",
  },
  right: {
    name: "wreck.controls.right",
    arrow: "wreck.symbol.dpad.right",
    key: "wreck.symbol.dpad.key.right",
    shortcuts: "D ArrowRight",
  },
};

/**
 * The four buttons, in the order the grid places them. The accessible name
 * is the action in either labelling; only the face changes.
 */
export function createDpadButtons(
  locale: SupportedLocale,
  arrows: boolean,
): HTMLButtonElement[] {
  return DPAD_ORDER.map((control) => {
    const labels = DPAD_LABELS[control];
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.control = control;
    button.setAttribute("aria-label", translate(locale, labels.name));
    button.setAttribute("aria-keyshortcuts", labels.shortcuts);
    button.textContent = translate(locale, arrows ? labels.arrow : labels.key);
    return button;
  });
}

export interface DpadBinding {
  /** Lets go of every held direction, as for a lost focus. */
  releaseAll(): void;
  /** Removes the window and document listeners and lets go of anything still held. */
  dispose(): void;
}

/** Binds the buttons to the target. */
export function bindDpad(
  buttons: readonly HTMLButtonElement[],
  target: DpadTarget,
): DpadBinding {
  const holds = new DpadHolds(target);
  // The held look follows the bookkeeping, not the event, so a button never
  // shows a direction as held that the controller has been told is not.
  const showHeld = () => {
    for (const button of buttons) {
      if (holds.holds(button.dataset.control as ContinuousControl)) {
        button.dataset.held = "true";
      } else {
        delete button.dataset.held;
      }
    }
  };

  for (const button of buttons) {
    const control = button.dataset.control as ContinuousControl;
    button.addEventListener("pointerdown", (event) => {
      // The primary button only: a right click opens the context menu, and
      // its pointerup may never reach the button.
      if (event.pointerType === "mouse" && event.button !== 0) {
        return;
      }
      event.preventDefault();
      button.setPointerCapture(event.pointerId);
      holds.press(event.pointerId, control);
      showHeld();
    });
    const release = (event: PointerEvent) => {
      holds.release(event.pointerId);
      showHeld();
    };
    button.addEventListener("pointerup", release);
    button.addEventListener("pointercancel", release);
    button.addEventListener("lostpointercapture", release);
    // A long press on a phone opens the context menu, which cancels the
    // pointer; a held ascend is exactly a long press.
    button.addEventListener("contextmenu", (event) => event.preventDefault());
  }

  const releaseAll = () => {
    holds.releaseAll();
    showHeld();
  };
  window.addEventListener("blur", releaseAll);
  document.addEventListener("visibilitychange", releaseAll);
  return {
    releaseAll,
    dispose: () => {
      window.removeEventListener("blur", releaseAll);
      document.removeEventListener("visibilitychange", releaseAll);
      releaseAll();
    },
  };
}
