import { describe, expect, it } from "vitest";

import { createInitialDiveState } from "../../src/core/dive-state";
import { loadHintStore } from "../../src/app/onboarding-hints";
import type {
  LifecycleDocument,
  WakeLockLike,
  WakeLockSentinelLike,
} from "../../src/app/lifecycle";
import {
  BROWSER_BACK_NAVIGATION,
  createBrowserPlatformServices,
  keyValuePersistentStore,
  type KeyValueStore,
} from "../../src/platform/browser-platform";
import {
  LocalSaveRepository,
  SAVE_GAME_STORAGE_KEY,
} from "../../src/save/save-repository";

// The platform contracts (#137 A0): bootstrap.ts assembles the browser's
// services once, and the app reads storage, the page's lifecycle and the
// wake lock through them alone.

class MemoryStore implements KeyValueStore {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
}

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
  set(state: DocumentVisibilityState): void {
    this.visibilityState = state;
    for (const listener of this.#listeners.get("visibilitychange") ?? []) listener();
  }
  get listenerCount(): number {
    return [...this.#listeners.values()].reduce((n, set) => n + set.size, 0);
  }
}

function recordingWakeLock() {
  const log: string[] = [];
  const wakeLock: WakeLockLike = {
    request: (type) => {
      log.push(`request:${type}`);
      const sentinel: WakeLockSentinelLike = {
        released: false,
        release: () => {
          log.push("release");
          return Promise.resolve();
        },
        addEventListener: () => undefined,
      };
      return Promise.resolve(sentinel);
    },
  };
  return { log, wakeLock };
}

const blocked = (): KeyValueStore => {
  throw new DOMException("The operation is insecure.", "SecurityError");
};

function services(overrides: { storage?: () => KeyValueStore } = {}) {
  const memory = new MemoryStore();
  const doc = new FakeDocument();
  const { log, wakeLock } = recordingWakeLock();
  const platform = createBrowserPlatformServices({
    storage: overrides.storage ?? (() => memory),
    document: doc as unknown as LifecycleDocument,
    wakeLock,
  });
  return { platform, memory, doc, log };
}

describe("the persistent store over a synchronous one (#137 A0)", () => {
  it("gets, sets and removes", async () => {
    const memory = new MemoryStore();
    const store = keyValuePersistentStore(() => memory);
    expect(await store.get("k")).toBeNull();
    await store.set("k", "v");
    expect(memory.getItem("k")).toBe("v");
    expect(await store.get("k")).toBe("v");
    await store.remove("k");
    expect(await store.get("k")).toBeNull();
  });

  it("rejects, never throws, where storage is blocked or a write refused", async () => {
    const store = keyValuePersistentStore(blocked);
    let calls: Promise<unknown>[] = [];
    expect(() => {
      calls = [store.get("k"), store.set("k", "v"), store.remove("k")];
    }).not.toThrow();
    for (const call of calls) await expect(call).rejects.toThrow("insecure");

    const full = new MemoryStore();
    full.setItem = () => {
      throw new DOMException("quota", "QuotaExceededError");
    };
    await expect(keyValuePersistentStore(() => full).set("k", "v")).rejects.toThrow("quota");
  });

  // The contract's "taken before it returns" (#137 A4a): a page's pagehide
  // does not wait for a promise, so the browser's store writes inside the
  // call. A native store need not; that is A5b's.
  it("writes and removes inside the call, before its promise settles", () => {
    const memory = new MemoryStore();
    const store = keyValuePersistentStore(() => memory);
    void store.set("k", "v");
    expect(memory.getItem("k")).toBe("v");
    void store.remove("k");
    expect(memory.getItem("k")).toBeNull();
  });
});

describe("createBrowserPlatformServices (#137 A0)", () => {
  it("does not touch storage until it is used, and a blocked page rejects", async () => {
    let reads = 0;
    const { platform } = services({
      storage: () => {
        reads += 1;
        return blocked();
      },
    });
    expect(reads).toBe(0);
    // The save cannot be read; the hint flags admit every hint, as before (#160).
    await expect(new LocalSaveRepository(platform.store).load()).rejects.toThrow("insecure");
    expect((await loadHintStore(platform.store)).admit("bcd")).toBe(true);
  });

  it("keeps the save in the page's storage, through the store alone (#137 A4a)", async () => {
    const { platform, memory } = services();
    expect(platform).not.toHaveProperty("syncStorage");
    const repository = new LocalSaveRepository(platform.store);
    const { saveGame, persisted } = await repository.save(
      createInitialDiveState(7),
      { lowPercent: 40, highPercent: 85 },
      1_735_689_600_000,
    );
    expect(persisted).toBe(true);
    const raw = memory.getItem(SAVE_GAME_STORAGE_KEY);
    expect(await platform.store.get(SAVE_GAME_STORAGE_KEY)).toBe(raw);

    expect(await repository.clear()).toBe(true);
    expect(await new LocalSaveRepository(platform.store).load()).toEqual({ status: "empty" });
    memory.setItem(SAVE_GAME_STORAGE_KEY, raw!);
    const loaded = await new LocalSaveRepository(platform.store).load();
    expect(loaded.status === "loaded" && loaded.saveGame).toEqual(saveGame);
  });

  it("reports the page's visibility as the app's lifecycle", () => {
    const { platform, doc } = services();
    expect(platform.lifecycle.inForeground).toBe(true);
    const events: string[] = [];
    const stop = platform.lifecycle.watch({
      background: () => events.push("background"),
      foreground: () => events.push("foreground"),
    });
    doc.set("hidden");
    expect(platform.lifecycle.inForeground).toBe(false);
    doc.set("visible");
    expect(events).toEqual(["background", "foreground"]);
    stop();
    expect(doc.listenerCount).toBe(0);
  });

  it("holds and releases the screen through the page's wake lock", async () => {
    const { platform, log } = services();
    platform.wakeLock.hold();
    await Promise.resolve();
    expect(platform.wakeLock.held).toBe(true);
    platform.wakeLock.release();
    expect(platform.wakeLock.held).toBe(false);
    expect(log).toEqual(["request:screen", "release"]);
  });

  it("does nothing for a wake lock where the browser has none", () => {
    const platform = createBrowserPlatformServices({
      storage: () => new MemoryStore(),
      document: new FakeDocument() as unknown as LifecycleDocument,
      wakeLock: null,
    });
    platform.wakeLock.hold();
    expect(platform.wakeLock.held).toBe(false);
    expect(() => platform.wakeLock.release()).not.toThrow();
  });

  it("asks no back handler: the browser's back stays the tab's history", () => {
    const { platform } = services();
    expect(platform.backNavigation).toBe(BROWSER_BACK_NAVIGATION);
    let asked = false;
    const remove = platform.backNavigation.onBack(() => (asked = true));
    expect(() => remove()).not.toThrow();
    expect(asked).toBe(false);
  });
});

// Only the platform's implementations reach the page's storage, lifecycle
// and wake lock, and only they may import Capacitor.
const SOURCES = import.meta.glob("../../src/**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const PLATFORM_IMPLEMENTATIONS = /^\.\.\/\.\.\/src\/(platform\/|app\/lifecycle\.ts$)/;
const DIRECT_ACCESS = [
  /(?:window|globalThis|self)\.localStorage\b/,
  /[^.\w]localStorage\.\w+\(/,
  /\bnavigator\b[^;\n]*\bwakeLock\b/,
  /\bdocument\.visibilityState\b/,
  /from\s+["']@capacitor\//,
  /\bCapacitor\.\w+/,
];

describe("the platform seam (#137 A0)", () => {
  it("is the only code that reads storage, visibility and the wake lock directly", () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(50);
    const offenders = Object.entries(SOURCES)
      .filter(([file]) => !PLATFORM_IMPLEMENTATIONS.test(file) && !file.endsWith(".test.ts"))
      .flatMap(([file, source]) =>
        DIRECT_ACCESS.filter((pattern) => pattern.test(source)).map((pattern) => `${file} ${pattern}`),
      );
    expect(offenders).toEqual([]);
  });
});
