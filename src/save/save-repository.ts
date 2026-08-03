import {
  createSaveGame,
  decodeSaveGame,
  encodeSaveGame,
  type SaveGame,
  type SaveGameDecodeResult,
} from "./save-game";
import type { DiveState } from "../core/dive-state";

export const SAVE_GAME_STORAGE_KEY = "diving-simulator.save-game";
export const LEGACY_SAVE_STORAGE_KEY = "diveSim_savedState";

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

// localStorage.setItem throws on quota exhaustion, and throws on every write
// in Safari private browsing. A save is best-effort persistence: losing it must
// never take down the caller, and on the load path a failed migration write must
// still return the successfully decoded save rather than aborting startup.
function tryWrite(store: KeyValueStore, key: string, value: string): boolean {
  try {
    store.setItem(key, value);
    return true;
  } catch {
    return false;
  }
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

export class LocalSaveRepository {
  readonly #store: KeyValueStore;

  constructor(store: KeyValueStore) {
    this.#store = store;
  }

  /**
   * Returns the save that was built. `persisted` is false when the store
   * refused the write, so a caller can surface degraded persistence instead of
   * assuming the dive is recoverable.
   */
  save(
    state: DiveState,
    savedAtEpochMs = Date.now(),
  ): { readonly saveGame: SaveGame; readonly persisted: boolean } {
    const saveGame = createSaveGame(state, savedAtEpochMs);
    const persisted = tryWrite(
      this.#store,
      SAVE_GAME_STORAGE_KEY,
      encodeSaveGame(saveGame),
    );
    return { saveGame, persisted };
  }

  load(): SaveRepositoryLoadResult {
    const currentRaw = this.#store.getItem(SAVE_GAME_STORAGE_KEY);
    if (currentRaw !== null) {
      return this.#loadFromKey(SAVE_GAME_STORAGE_KEY, currentRaw, false);
    }

    const legacyRaw = this.#store.getItem(LEGACY_SAVE_STORAGE_KEY);
    if (legacyRaw === null) {
      return { status: "empty" };
    }
    return this.#loadFromKey(LEGACY_SAVE_STORAGE_KEY, legacyRaw, true);
  }

  clear(): void {
    this.#store.removeItem(SAVE_GAME_STORAGE_KEY);
    this.#store.removeItem(LEGACY_SAVE_STORAGE_KEY);
  }

  #loadFromKey(
    sourceKey: string,
    raw: string,
    legacySource: boolean,
  ): SaveRepositoryLoadResult {
    const result = decodeSaveGame(raw);
    if (!result.ok) {
      if (result.reason !== "unsupported-version") {
        this.#store.removeItem(sourceKey);
      }
      return result.reason === "empty"
        ? { status: "empty" }
        : { status: "rejected", reason: result.reason };
    }

    const migrated = result.migratedFrom !== null;
    if (migrated) {
      const rewritten = tryWrite(
        this.#store,
        SAVE_GAME_STORAGE_KEY,
        encodeSaveGame(result.saveGame),
      );
      // Only retire the legacy key once its replacement is durably stored,
      // otherwise a refused write would discard the only copy of the save.
      if (legacySource && rewritten) {
        this.#store.removeItem(sourceKey);
      }
    }

    return { status: "loaded", saveGame: result.saveGame, migrated };
  }
}
