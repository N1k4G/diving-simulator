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

  save(state: DiveState, savedAtEpochMs = Date.now()): SaveGame {
    const saveGame = createSaveGame(state, savedAtEpochMs);
    this.#store.setItem(SAVE_GAME_STORAGE_KEY, encodeSaveGame(saveGame));
    return saveGame;
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
      this.#store.setItem(
        SAVE_GAME_STORAGE_KEY,
        encodeSaveGame(result.saveGame),
      );
      if (legacySource) {
        this.#store.removeItem(sourceKey);
      }
    }

    return { status: "loaded", saveGame: result.saveGame, migrated };
  }
}
