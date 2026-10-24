/**
 * The page's lifecycle and the screen wake lock (#137 A5, A9), the browser's
 * half of the platform seam. The dive screen asks these two things of the
 * platform and nothing else here, so the Capacitor lifecycle service of A0
 * can stand in for `watchPageLifecycle` and a native wake lock for
 * `ScreenWakeLock` without the dive screen changing.
 */

/** What the dive screen does as the app leaves and comes back to the foreground. */
export interface LifecycleListener {
  /** The app is hidden or frozen: it may be reclaimed without another event. */
  background(): void;
  /** The app is visible again. */
  foreground(): void;
}

/** The part of `document` the browser lifecycle reads, for tests to stand in for. */
export type LifecycleDocument = Pick<
  Document,
  "visibilityState" | "addEventListener" | "removeEventListener"
>;

/**
 * Calls `background` when the page is hidden, or frozen where the browser
 * sends `freeze`, and `foreground` when it is visible again, each once per
 * change. On a phone a page in the background may be discarded with no
 * `pagehide`, so this is the last moment the dive is sure to be saved.
 * A page already hidden when the watch starts is reported as in the
 * background at once (#276 Codex round 1): a dive can finish loading behind
 * another tab, and it is saved, paused and silenced as if it had gone there
 * after. Returns the function that stops watching.
 */
export function watchPageLifecycle(
  listener: LifecycleListener,
  doc: LifecycleDocument = document,
): () => void {
  let inForeground = true;
  const toBackground = () => {
    if (inForeground) {
      inForeground = false;
      listener.background();
    }
  };
  const update = () => {
    if (doc.visibilityState === "hidden") {
      toBackground();
    } else if (!inForeground) {
      inForeground = true;
      listener.foreground();
    }
  };
  doc.addEventListener("visibilitychange", update);
  // Page Lifecycle API (Chromium): a frozen page runs nothing until `resume`.
  doc.addEventListener("freeze", toBackground);
  doc.addEventListener("resume", update);
  if (doc.visibilityState === "hidden") {
    toBackground();
  }
  return () => {
    doc.removeEventListener("visibilitychange", update);
    doc.removeEventListener("freeze", toBackground);
    doc.removeEventListener("resume", update);
  };
}

/** The part of the Screen Wake Lock API this uses. */
export interface WakeLockSentinelLike {
  readonly released: boolean;
  release(): Promise<void>;
  addEventListener(type: "release", listener: () => void): void;
}

export interface WakeLockLike {
  request(type: "screen"): Promise<WakeLockSentinelLike>;
}

/**
 * Keeps the screen on while it is held (#137 A9): a safety stop is five
 * minutes of watching the dive computer with no input, long enough for the
 * screen to sleep. `hold()` while the dive is under way and the page is
 * visible, `release()` when it goes to the background or the dive ends.
 *
 * The browser releases the lock itself when the page is hidden, so it is
 * asked for again on every `hold()`. Where the API is missing, or the
 * request is refused (no secure context, a hidden page, a user agent's
 * policy), nothing happens and nothing is logged: the dive does not need the
 * lock, and a refusal is not an error of the client's.
 */
export class ScreenWakeLock {
  readonly #wakeLock: WakeLockLike | null;
  #wanted = false;
  #sentinel: WakeLockSentinelLike | null = null;
  #requesting = false;

  constructor(wakeLock: WakeLockLike | null | undefined = browserWakeLock()) {
    this.#wakeLock = wakeLock ?? null;
  }

  /** The lock is held by the user agent right now. */
  get held(): boolean {
    return this.#sentinel !== null && !this.#sentinel.released;
  }

  hold(): void {
    this.#wanted = true;
    if (!this.#wakeLock || this.held || this.#requesting) {
      return;
    }
    this.#requesting = true;
    let request: Promise<WakeLockSentinelLike>;
    try {
      request = this.#wakeLock.request("screen");
    } catch {
      this.#requesting = false;
      return;
    }
    request.then(
      (sentinel) => {
        this.#requesting = false;
        if (!this.#wanted) {
          // Released while the request was out: let it go at once.
          void sentinel.release().catch(() => undefined);
          return;
        }
        this.#sentinel = sentinel;
        sentinel.addEventListener("release", () => {
          if (this.#sentinel === sentinel) {
            this.#sentinel = null;
          }
        });
      },
      () => {
        this.#requesting = false;
      },
    );
  }

  release(): void {
    this.#wanted = false;
    const sentinel = this.#sentinel;
    this.#sentinel = null;
    if (sentinel && !sentinel.released) {
      void sentinel.release().catch(() => undefined);
    }
  }
}

function browserWakeLock(): WakeLockLike | null {
  if (typeof navigator === "undefined") {
    return null;
  }
  return (navigator as { wakeLock?: WakeLockLike }).wakeLock ?? null;
}
