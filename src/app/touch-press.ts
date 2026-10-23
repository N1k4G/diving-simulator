// The presses of the dive's context controls (#168 PR 2): the cylinders,
// the gas information, fast-forward, the torch, the setpoint and bailout,
// help and mute.
//
// A button's click is how a mouse and a keyboard press it, and how a phone
// presses it with one finger. It is not how a phone presses it with a second
// finger: a browser sends a click only for a lone tap, so with a thumb held
// on the D-pad a tap on a cylinder, the torch or bailout did nothing (#168,
// measured on Chromium: pointerdown, pointerup, no click). Legacy binds these
// buttons to touchstart (src/touch.js bindTap, bindTapPressRelease), which
// every finger sends.
//
// So a touch is taken from the touch events themselves: a finger that went
// down on the button and is lifted over it presses it once, whichever finger
// it is. Its touchend is cancelled, which keeps the browser from sending the
// click of a lone tap as well, so no press counts twice. A finger lifted
// elsewhere, or a touch the browser cancels, presses nothing, as a click is
// not sent for a tap that slid off the button.
//
// Like the D-pad, it drives the controller's intents through `act` and never
// a synthetic key event.

/**
 * Which touch went down on which button, by the touch's identifier. Kept
 * apart from the DOM so the bookkeeping can be tested on its own.
 */
export class TouchPresses<Button> {
  readonly #started = new Map<number, Button>();

  start(identifier: number, button: Button): void {
    this.#started.set(identifier, button);
  }

  /** Whether the touch went down on a button. */
  has(identifier: number): boolean {
    return this.#started.has(identifier);
  }

  /** The button a touch lifted over its own button presses, or null. */
  end(identifier: number, overButton: (button: Button) => boolean): Button | null {
    const button = this.#started.get(identifier);
    this.#started.delete(identifier);
    return button !== undefined && overButton(button) ? button : null;
  }

  cancel(identifier: number): void {
    this.#started.delete(identifier);
  }
}

/**
 * Presses the buttons in `container` that match `selector`, by click and by
 * touch, calling `act` once per press. A disabled button is not pressed.
 * Delegated, so buttons added later are bound too.
 */
export function bindPress(
  container: HTMLElement,
  selector: string,
  act: (button: HTMLButtonElement) => void,
): void {
  const presses = new TouchPresses<HTMLButtonElement>();
  const pressable = (target: EventTarget | null): HTMLButtonElement | null => {
    const button = target instanceof Element ? target.closest<HTMLButtonElement>(selector) : null;
    return button !== null && container.contains(button) && !button.disabled ? button : null;
  };
  container.addEventListener("click", (event) => {
    const button = pressable(event.target);
    if (button) {
      act(button);
    }
  });
  container.addEventListener(
    "touchstart",
    (event) => {
      const button = pressable(event.target);
      if (!button) {
        return;
      }
      for (const touch of event.changedTouches) {
        presses.start(touch.identifier, button);
      }
    },
    { passive: true },
  );
  container.addEventListener(
    "touchend",
    (event) => {
      for (const touch of event.changedTouches) {
        if (!presses.has(touch.identifier)) {
          continue;
        }
        // The click a lone tap would send as well.
        if (event.cancelable) {
          event.preventDefault();
        }
        const button = presses.end(touch.identifier, (candidate) => {
          const box = candidate.getBoundingClientRect();
          return (
            touch.clientX >= box.left &&
            touch.clientX <= box.right &&
            touch.clientY >= box.top &&
            touch.clientY <= box.bottom
          );
        });
        if (button && !button.disabled) {
          act(button);
        }
      }
    },
    { passive: false },
  );
  container.addEventListener("touchcancel", (event) => {
    for (const touch of event.changedTouches) {
      presses.cancel(touch.identifier);
    }
  });
}
