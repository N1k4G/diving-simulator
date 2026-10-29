import {
  ScreenWakeLock,
  watchPageLifecycle,
  type LifecycleDocument,
  type WakeLockLike,
} from "../app/lifecycle";
import type {
  AppLifecycle,
  BackNavigation,
  PersistentStore,
  PlatformServices,
} from "./platform-services";

/** The page's synchronous storage, `window.localStorage`'s shape. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * What the browser's services read, for tests to stand in for. Each defaults
 * to the page's own: `window.localStorage`, `document` and
 * `navigator.wakeLock`; a `wakeLock` of null is a browser without one.
 */
export interface BrowserEnvironment {
  /** Read on every use, as reading `window.localStorage` can throw. */
  readonly storage?: () => KeyValueStore;
  readonly document?: LifecycleDocument;
  readonly wakeLock?: WakeLockLike | null;
}

/** The browser's platform services (#137 A0), assembled once by bootstrap.ts. */
export function createBrowserPlatformServices(
  environment: BrowserEnvironment = {},
): PlatformServices {
  const storage = environment.storage ?? (() => window.localStorage);
  const doc = environment.document ?? document;
  return {
    store: keyValuePersistentStore(storage),
    lifecycle: pageLifecycle(doc),
    backNavigation: BROWSER_BACK_NAVIGATION,
    // Left out, `navigator.wakeLock` where there is one.
    wakeLock: new ScreenWakeLock(environment.wakeLock),
  };
}

/**
 * `PersistentStore` over a synchronous store such as `localStorage`. Each
 * call does its work before it returns, so a `set` made on `pagehide` is
 * written though nothing awaits it (the contract's "taken before it
 * returns"), and reports it through a promise settled at once; a store that
 * throws, on a blocked page or a full quota, rejects instead.
 */
export function keyValuePersistentStore(
  storage: () => KeyValueStore,
): PersistentStore {
  return {
    get: async (key) => storage().getItem(key),
    set: async (key, value) => storage().setItem(key, value),
    remove: async (key) => storage().removeItem(key),
  };
}

/** `AppLifecycle` over the page's visibility, `freeze` and `resume`. */
export function pageLifecycle(doc: LifecycleDocument): AppLifecycle {
  return {
    get inForeground() {
      return doc.visibilityState !== "hidden";
    },
    watch: (listener) => watchPageLifecycle(listener, doc),
  };
}

/**
 * A browser has no back action of the app's own: its back button walks the
 * tab's history, which the app leaves alone, and no handler is ever asked.
 * What back does in the app is #137 A6's, on the native shell.
 */
export const BROWSER_BACK_NAVIGATION: BackNavigation = Object.freeze({
  onBack: () => () => undefined,
});
