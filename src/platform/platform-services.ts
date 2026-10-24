import type { KeyValueStore } from "../save/save-repository";

/**
 * The platform contracts (#137 A0): what the app asks of the browser or of a
 * native shell, and nothing more. `bootstrap.ts` assembles one
 * `PlatformServices` and hands it down; nothing below it reads
 * `window.localStorage`, `navigator.wakeLock` or `document.visibilityState`,
 * and nothing below it asks which platform it runs on. The browser's
 * implementations are DOM-based (`browser-platform.ts`); a native shell's
 * will be Capacitor-based, and only they may import Capacitor.
 * `GameController`, the model, the planner and the save codec import none of
 * this (docs/decisions.md, "Architecture").
 */
export interface PlatformServices {
  /** The durable key-value store saves and settings are kept in. */
  readonly store: PersistentStore;
  /**
   * The same store, read and written synchronously, for the save repository,
   * the hint flags and the locale choice, synchronous until #137 A4a makes them
   * await `store` (docs/decisions.md, the #137 A0 row). Throws where the
   * store cannot be reached at all, as reading `window.localStorage` does
   * where the page's storage is blocked, so each caller meets that where it
   * did before.
   */
  readonly syncStorage: () => KeyValueStore;
  readonly lifecycle: AppLifecycle;
  readonly backNavigation: BackNavigation;
  readonly wakeLock: WakeLockService;
}

/**
 * Durable string storage, asynchronous because the native store (Capacitor
 * Preferences) is: the shape #137 A4a converts the save path to. A write
 * resolves once the store has taken it and rejects where it is refused
 * (quota, private browsing), so a caller can tell degraded persistence from
 * a saved dive.
 */
export interface PersistentStore {
  /** The value under `key`, or null when there is none. */
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** What the dive screen does as the app leaves and comes back to the foreground. */
export interface LifecycleListener {
  /** The app is hidden or frozen: it may be reclaimed without another event. */
  background(): void;
  /** The app is visible again. */
  foreground(): void;
}

/** The app going to the background and coming back (#137 A5). */
export interface AppLifecycle {
  /** The app is in the foreground now. */
  readonly inForeground: boolean;
  /**
   * Calls `background` and `foreground` once per change. An app already in
   * the background when the watch starts is reported so at once. Returns
   * the function that stops watching.
   */
  watch(listener: LifecycleListener): () => void;
}

/**
 * Handles the platform's back action and returns true, or returns false to
 * leave it to the handler registered before it.
 */
export type BackHandler = () => boolean;

/**
 * The platform's back action: Android's system and gesture back (#137 A6).
 * Handlers are asked newest first, so the topmost screen or overlay answers
 * before what is under it; when none handles it, the platform does what it
 * does without the app (a native app exits). A6 decides what the app
 * registers; nothing does yet.
 */
export interface BackNavigation {
  /** Registers `handler`; returns the function that removes it. */
  onBack(handler: BackHandler): () => void;
}

/**
 * Keeps the screen on while held (#137 A9). `hold()` while the dive is on
 * screen and the app in the foreground, `release()` when it leaves either.
 * Where the platform has no wake lock or refuses one, both do nothing.
 */
export interface WakeLockService {
  /** The platform holds the lock right now. */
  readonly held: boolean;
  hold(): void;
  release(): void;
}
