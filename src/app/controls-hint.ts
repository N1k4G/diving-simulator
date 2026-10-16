// The keyboard hint gives way to the HUD (#168 pre-review passes 1 to 3).
//
// The hint sits in the bottom-left dock; the HUD and the gas-information
// panel hang from the top of the same side. Once the dive fills a short
// window, the two can meet, and how tall the HUD is depends on the dive: a
// rebreather's rows, a stop row that wraps in German, an open page that
// cannot shrink below the HUD above it. Every height threshold tried for the
// hint (600, 420, 460 px) was beaten by a taller HUD, and the next row the
// HUD gains would beat any other.
//
// So the hint is measured against what is actually on screen. It is shown
// only while it stands at least HINT_CLEARANCE_PX clear of the HUD and the
// panel, and re-measured whenever any of them, or the window, changes size.
// It is keyboard help, not dive information, so it is the one that yields.
// Nothing here changes the layout of anything but the hint.

/** The #121 spacing: two things on screen this close or closer collide. */
export const HINT_CLEARANCE_PX = 8;

export interface Box {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

/**
 * Whether the hint stands clear of every obstacle: apart by at least the
 * clearance along one axis. An obstacle with no area (a hidden panel) is not
 * there.
 */
export function hintClearOf(
  hint: Box,
  obstacles: readonly Box[],
  clearance: number = HINT_CLEARANCE_PX,
): boolean {
  return obstacles.every((box) => {
    if (box.bottom <= box.top || box.right <= box.left) {
      return true;
    }
    return (
      hint.top - box.bottom >= clearance ||
      box.top - hint.bottom >= clearance ||
      hint.left - box.right >= clearance ||
      box.left - hint.right >= clearance
    );
  });
}

export interface HintFit {
  /** Re-measures now, for a change made outside a frame (a click). */
  readonly refit: () => void;
  readonly dispose: () => void;
}

/**
 * Keeps the hint shown only while it is clear of the obstacles.
 *
 * Each fit measures the hint shown, so the decision never depends on the
 * previous one, and leaves the dock at the size the decision gives it: a
 * ResizeObserver that sees the same size again does not call back, so the
 * fit cannot loop. A hint the stylesheet hides (a narrow screen) has no box
 * and is left to the stylesheet.
 */
export function keepHintClear(
  hint: HTMLElement,
  obstacles: readonly HTMLElement[],
  watched: readonly HTMLElement[],
): HintFit {
  const refit = () => {
    hint.hidden = false;
    const box = hint.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) {
      return;
    }
    hint.hidden = !hintClearOf(
      box,
      obstacles.map((element) => element.getBoundingClientRect()),
    );
  };
  const observer = new ResizeObserver(refit);
  for (const element of [...obstacles, ...watched]) {
    observer.observe(element);
  }
  refit();
  return { refit, dispose: () => observer.disconnect() };
}
