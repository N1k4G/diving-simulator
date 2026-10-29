import {
  createSaveGame,
  decodeSaveGame,
  encodeSaveGame,
  type SaveGame,
  type SaveGameDecodeOptions,
  type SaveGameDecodeResult,
  type SavedDiveMode,
  type SavedGradientFactors,
} from "./save-game";
import type { DiveState } from "../core/dive-state";
import type { DrillState } from "../core/drills";
import type { SessionSnapshot } from "./session-snapshot";

/**
 * Durable string storage, asynchronous because the native store (Capacitor
 * Preferences) is (#137 A4a). A write resolves once the store has taken it
 * and rejects where it is refused (quota, private browsing, storage blocked),
 * so a caller can tell degraded persistence from a saved dive. No call
 * throws: a store that cannot be reached rejects.
 *
 * Taken before it returns: the browser's store (`keyValuePersistentStore`
 * in `src/platform/browser-platform.ts`) performs a `set` or `remove`
 * synchronously, inside the call, and only reports it through the promise.
 * A page's `pagehide` does not wait for a promise, so the save written there
 * is in storage only because of this. A store that writes later, as
 * Capacitor Preferences does, cannot promise that, and what it does instead
 * as the app is reclaimed is #137 A5b's. `PlatformServices.store` is one.
 */
export interface PersistentStore {
  /** The value under `key`, or null when there is none. */
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/**
 * `store`, used one operation at a time, in the order they are made: each
 * waits until every one before it has settled, so none reaches the store
 * while another is pending and none overtakes another, whoever made them
 * (the save, its load's repairs, the hint flags, the language choice). One
 * made while none is pending starts inside the call, so the browser's store
 * still takes a `pagehide` write before the handler returns.
 */
export function serialStore(store: PersistentStore): PersistentStore {
  let pending = 0;
  let settled: Promise<void> = Promise.resolve();
  const run = <T>(operation: () => Promise<T>): Promise<T> => {
    const start = () => {
      try {
        return operation();
      } catch (error) {
        return Promise.reject(error as Error);
      }
    };
    const result = pending === 0 ? start() : settled.then(start);
    pending += 1;
    const done = () => {
      pending -= 1;
    };
    settled = result.then(done, done);
    return result;
  };
  return {
    get: (key) => run(() => store.get(key)),
    set: (key, value) => run(() => store.set(key, value)),
    remove: (key) => run(() => store.remove(key)),
  };
}

export const SAVE_GAME_STORAGE_KEY = "diving-simulator.save-game";
export const LEGACY_SAVE_STORAGE_KEY = "diveSim_savedState";

// True once the store has taken the write, false where it refused it. A save
// is best-effort persistence: losing it must never take down the caller, and
// on the load path a refused migration write must still return the decoded
// save rather than abort the start.
function taken(write: () => Promise<unknown>): Promise<boolean> {
  try {
    return write().then(() => true, () => false);
  } catch {
    // A store that throws, against the contract, refused the write too.
    return Promise.resolve(false);
  }
}

/** What the store is to hold once the write is done. */
type Write =
  | { readonly kind: "save"; readonly encoded: string }
  | { readonly kind: "clear" };

interface QueuedWrite {
  write: Write;
  /** The caller whose write this is, and each whose write it replaced. */
  readonly settle: ((taken: boolean) => void)[];
}

export type SaveRepositoryLoadResult =
  | {
      readonly status: "loaded";
      readonly saveGame: SaveGame;
      readonly migrated: boolean;
    }
  | { readonly status: "empty" }
  | {
      readonly status: "rejected";
      readonly reason: Exclude<
        SaveGameDecodeResult & { readonly ok: false },
        { readonly reason: "empty" }
      >["reason"];
    };

/**
 * The dive's save, in the platform's asynchronous store (#137 A4a). One per
 * app: its writes, the autosave's, the background's, `pagehide`'s and the
 * clearing at a dive's end, reach the store one at a time, in the order they
 * were made. A write made while another is with the store waits for it, and
 * a later one made meanwhile replaces it, so no two writes interleave, the
 * latest state wins, and the last write made is the last one taken. A write
 * made while none is with the store starts inside the call, so where the
 * store takes it synchronously, as the browser's does, a save made on
 * `pagehide` is written before the page goes.
 */
export class LocalSaveRepository {
  readonly #store: PersistentStore;
  readonly #decodeOptions: Readonly<SaveGameDecodeOptions>;
  #writing = false;
  #next: QueuedWrite | null = null;

  /**
   * `options.legacySeed` seeds a dive migrated from a legacy save (#219); the
   * migrated save is written back with it, so it is drawn once.
   */
  constructor(store: PersistentStore, options: Readonly<SaveGameDecodeOptions> = {}) {
    this.#store = store;
    this.#decodeOptions = options;
  }

  /**
   * Resolves with the save that was built; a refused write does not reject.
   * `persisted` is false when the store refused the write, or the later one
   * that replaced it, so a caller can surface degraded persistence instead
   * of assuming the dive is recoverable. `routePositionM` is where on the wreck's route the
   * diver is (#222), in `session` with the facing and torch (#137 A4b);
   * without it the dive resumes at the route's start, facing right, torch on.
   * `drill` is the training drill under way (#160).
   */
  async save(
    state: DiveState,
    gradientFactors: SavedGradientFactors,
    savedAtEpochMs = Date.now(),
    diveMode?: SavedDiveMode,
    session?: Readonly<Partial<SessionSnapshot>>,
    drill?: Readonly<DrillState>,
  ): Promise<{ readonly saveGame: SaveGame; readonly persisted: boolean }> {
    const saveGame = createSaveGame(
      state,
      gradientFactors,
      savedAtEpochMs,
      diveMode,
      session,
      drill,
    );
    const persisted = await this.#enqueue({
      kind: "save",
      encoded: encodeSaveGame(saveGame),
    });
    return { saveGame, persisted };
  }

  /**
   * Reads the save, once, before any is written: the app awaits it before it
   * builds a dive. Its repairs (a corrupt save removed, a migrated one
   * written back) are each awaited, so none is pending once it resolves, and
   * over a `serialStore`, as the app's is, no write made meanwhile could
   * reach the store before them. Rejects where the store cannot be read.
   */
  async load(): Promise<SaveRepositoryLoadResult> {
    const currentRaw = await this.#store.get(SAVE_GAME_STORAGE_KEY);
    if (currentRaw !== null) {
      return this.#loadFromKey(SAVE_GAME_STORAGE_KEY, currentRaw, false);
    }

    const legacyRaw = await this.#store.get(LEGACY_SAVE_STORAGE_KEY);
    if (legacyRaw === null) {
      return { status: "empty" };
    }
    return this.#loadFromKey(LEGACY_SAVE_STORAGE_KEY, legacyRaw, true);
  }

  /**
   * Removes the save, after the writes made before, and in place of one made
   * since that has not started. Resolves false where the store refused.
   */
  clear(): Promise<boolean> {
    return this.#enqueue({ kind: "clear" });
  }

  #enqueue(write: Write): Promise<boolean> {
    return new Promise((resolve) => {
      if (this.#next) {
        // Replaced before it started: the latest state wins.
        this.#next.write = write;
        this.#next.settle.push(resolve);
      } else if (this.#writing) {
        this.#next = { write, settle: [resolve] };
      } else {
        this.#run({ write, settle: [resolve] });
      }
    });
  }

  /** Hands `queued` to the store now, then the write queued behind it. */
  #run(queued: QueuedWrite): void {
    this.#writing = true;
    const { write } = queued;
    const done =
      write.kind === "save"
        ? taken(() => this.#store.set(SAVE_GAME_STORAGE_KEY, write.encoded))
        : taken(async () => {
            // Both settle before the queue moves on, refused or not, so a
            // removal still pending cannot land on a later save.
            const removed = await Promise.allSettled([
              this.#store.remove(SAVE_GAME_STORAGE_KEY),
              this.#store.remove(LEGACY_SAVE_STORAGE_KEY),
            ]);
            if (removed.some(({ status }) => status === "rejected")) {
              throw new Error("the store refused a removal");
            }
          });
    void done.then((ok) => {
      for (const settle of queued.settle) settle(ok);
      this.#writing = false;
      const next = this.#next;
      this.#next = null;
      if (next) this.#run(next);
    });
  }

  async #loadFromKey(
    sourceKey: string,
    raw: string,
    legacySource: boolean,
  ): Promise<SaveRepositoryLoadResult> {
    const result = decodeSaveGame(raw, this.#decodeOptions);
    if (!result.ok) {
      if (result.reason !== "unsupported-version") {
        await this.#store.remove(sourceKey);
      }
      return result.reason === "empty"
        ? { status: "empty" }
        : { status: "rejected", reason: result.reason };
    }

    const migrated = result.migratedFrom !== null;
    if (migrated) {
      const rewritten = await taken(() =>
        this.#store.set(SAVE_GAME_STORAGE_KEY, encodeSaveGame(result.saveGame)),
      );
      // Only retire the legacy key once its replacement is durably stored,
      // otherwise a refused write would discard the only copy of the save.
      if (legacySource && rewritten) {
        await this.#store.remove(sourceKey);
      }
    }

    return { status: "loaded", saveGame: result.saveGame, migrated };
  }
}
