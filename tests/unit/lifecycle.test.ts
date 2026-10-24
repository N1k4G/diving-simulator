import { describe, expect, it } from "vitest";

import {
  ScreenWakeLock,
  watchPageLifecycle,
  type LifecycleDocument,
  type WakeLockLike,
  type WakeLockSentinelLike,
} from "../../src/app/lifecycle";

// The browser's half of the platform seam (#137 A5, A9): the page going to
// the background and back, and the screen wake lock held meanwhile.

class FakeDocument {
  visibilityState: DocumentVisibilityState = "visible";
  readonly #listeners = new Map<string, Set<() => void>>();

  addEventListener(type: string, listener: () => void): void {
    const set = this.#listeners.get(type) ?? new Set();
    set.add(listener);
    this.#listeners.set(type, set);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.#listeners.get(type)?.delete(listener);
  }

  dispatch(type: string): void {
    for (const listener of this.#listeners.get(type) ?? []) listener();
  }

  hide(): void {
    this.visibilityState = "hidden";
    this.dispatch("visibilitychange");
  }

  show(): void {
    this.visibilityState = "visible";
    this.dispatch("visibilitychange");
  }

  get listenerCount(): number {
    return [...this.#listeners.values()].reduce((n, set) => n + set.size, 0);
  }
}

function watch(doc: FakeDocument) {
  const events: string[] = [];
  const stop = watchPageLifecycle(
    { background: () => events.push("background"), foreground: () => events.push("foreground") },
    doc as unknown as LifecycleDocument,
  );
  return { events, stop };
}

describe("watchPageLifecycle (#137 A5)", () => {
  it("reports hidden as background and visible as foreground, once per change", () => {
    const doc = new FakeDocument();
    const { events } = watch(doc);
    doc.show();
    expect(events).toEqual([]);
    doc.hide();
    doc.hide();
    doc.show();
    doc.show();
    expect(events).toEqual(["background", "foreground"]);
  });

  it("takes freeze as background, and resume back to the foreground only when visible", () => {
    const doc = new FakeDocument();
    const { events } = watch(doc);
    doc.dispatch("freeze");
    // A frozen page is hidden first in practice; the hide after freeze is not a second background.
    doc.hide();
    doc.dispatch("resume");
    expect(events).toEqual(["background"]);
    doc.show();
    expect(events).toEqual(["background", "foreground"]);
    doc.dispatch("freeze");
    doc.dispatch("resume");
    expect(events).toEqual(["background", "foreground", "background", "foreground"]);
  });

  it("starting hidden, reports the background at once, a freeze then adds nothing, and the first visible is a foreground (#276 Codex round 1)", () => {
    const doc = new FakeDocument();
    doc.visibilityState = "hidden";
    const { events } = watch(doc);
    expect(events).toEqual(["background"]);
    doc.hide();
    doc.dispatch("freeze");
    doc.dispatch("resume");
    expect(events).toEqual(["background"]);
    doc.show();
    expect(events).toEqual(["background", "foreground"]);
  });

  it("starting visible, reports nothing until the page changes", () => {
    const doc = new FakeDocument();
    const { events } = watch(doc);
    doc.dispatch("resume");
    expect(events).toEqual([]);
    doc.dispatch("freeze");
    expect(events).toEqual(["background"]);
  });

  it("stops watching", () => {
    const doc = new FakeDocument();
    const { events, stop } = watch(doc);
    stop();
    doc.hide();
    doc.dispatch("freeze");
    expect(events).toEqual([]);
    expect(doc.listenerCount).toBe(0);
  });
});

class FakeSentinel implements WakeLockSentinelLike {
  released = false;
  readonly #onRelease: (() => void)[] = [];

  release(): Promise<void> {
    if (!this.released) {
      this.released = true;
      for (const listener of this.#onRelease) listener();
    }
    return Promise.resolve();
  }

  addEventListener(_type: "release", listener: () => void): void {
    this.#onRelease.push(listener);
  }
}

class FakeWakeLock implements WakeLockLike {
  readonly requests: { resolve: (s: FakeSentinel) => void; reject: (e: Error) => void }[] = [];
  readonly sentinels: FakeSentinel[] = [];

  request(type: "screen"): Promise<WakeLockSentinelLike> {
    expect(type).toBe("screen");
    return new Promise((resolve, reject) => {
      this.requests.push({
        resolve: (sentinel) => {
          this.sentinels.push(sentinel);
          resolve(sentinel);
        },
        reject,
      });
    });
  }

  grant(index = this.requests.length - 1): FakeSentinel {
    const sentinel = new FakeSentinel();
    this.requests[index]!.resolve(sentinel);
    return sentinel;
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("ScreenWakeLock (#137 A9)", () => {
  it("acquires on hold, releases on release, and acquires again on the next hold", async () => {
    const api = new FakeWakeLock();
    const lock = new ScreenWakeLock(api);
    lock.hold();
    const first = api.grant();
    await settle();
    expect(lock.held).toBe(true);
    // A second hold while it is held asks for nothing more.
    lock.hold();
    expect(api.requests).toHaveLength(1);

    lock.release();
    expect(first.released).toBe(true);
    expect(lock.held).toBe(false);

    lock.hold();
    expect(api.requests).toHaveLength(2);
    api.grant();
    await settle();
    expect(lock.held).toBe(true);
  });

  it("asks again after the user agent let it go, as it does on a hidden page", async () => {
    const api = new FakeWakeLock();
    const lock = new ScreenWakeLock(api);
    lock.hold();
    const sentinel = api.grant();
    await settle();
    await sentinel.release();
    expect(lock.held).toBe(false);
    lock.hold();
    expect(api.requests).toHaveLength(2);
  });

  it("lets go of a lock granted after it was released", async () => {
    const api = new FakeWakeLock();
    const lock = new ScreenWakeLock(api);
    lock.hold();
    // One request at a time.
    lock.hold();
    expect(api.requests).toHaveLength(1);
    lock.release();
    const late = api.grant();
    await settle();
    expect(late.released).toBe(true);
    expect(lock.held).toBe(false);
  });

  it("keeps a lock granted after a release and a second hold while the request was out", async () => {
    const api = new FakeWakeLock();
    const lock = new ScreenWakeLock(api);
    lock.hold();
    lock.release();
    lock.hold();
    const sentinel = api.grant(0);
    await settle();
    expect(sentinel.released).toBe(false);
    expect(lock.held).toBe(true);
  });

  it("does nothing when the request is refused, and asks again on the next hold", async () => {
    const api = new FakeWakeLock();
    const lock = new ScreenWakeLock(api);
    lock.hold();
    api.requests[0]!.reject(new DOMException("hidden", "NotAllowedError") as unknown as Error);
    await settle();
    expect(lock.held).toBe(false);
    lock.release();
    lock.hold();
    expect(api.requests).toHaveLength(2);
  });

  it("does nothing when the request throws", () => {
    const lock = new ScreenWakeLock({
      request: () => {
        throw new Error("not supported");
      },
    });
    expect(() => lock.hold()).not.toThrow();
    expect(lock.held).toBe(false);
    expect(() => lock.release()).not.toThrow();
  });

  it("does nothing where the API is missing", () => {
    const lock = new ScreenWakeLock(null);
    lock.hold();
    expect(lock.held).toBe(false);
    lock.release();
    expect(lock.held).toBe(false);
  });
});
