import type { PersistentStore } from "../save/save-repository";

// The store's contract is the save repository's port, as the synchronous
// one was before #137 A4a: the save depends on no platform code.
export type { PersistentStore };

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
  /**
   * The durable key-value store the save, the hint flags and the language
   * choice are kept in, and the only way the app reaches it (#137 A4a).
   */
  readonly store: PersistentStore;
  readonly lifecycle: AppLifecycle;
  readonly backNavigation: BackNavigation;
  readonly wakeLock: WakeLockService;
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
