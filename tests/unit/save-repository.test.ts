import { describe, expect, it } from "vitest";
import { createInitialDiveState } from "../../src/core/dive-state";
import { DiveModel } from "../../src/core/dive-model";
import { metres, seconds } from "../../src/core/units";
import {
  CURRENT_SAVE_GAME_VERSION,
  SAVE_GAME_SCHEMA,
} from "../../src/save/save-game";
import {
  LEGACY_SAVE_STORAGE_KEY,
  LocalSaveRepository,
  SAVE_GAME_STORAGE_KEY,
  type KeyValueStore,
} from "../../src/save/save-repository";

describe("LocalSaveRepository", () => {
  it("restores a save after the repository and model process are recreated", () => {
    const store = new MemoryStore();
    const originalState = createInitialDiveState(42);
    new LocalSaveRepository(store).save(originalState, 1_735_689_600_000);

    const recreatedRepository = new LocalSaveRepository(store);
    const result = recreatedRepository.load();

    expect(result.status).toBe("loaded");
    if (result.status !== "loaded") return;
    expect(result.saveGame.state).toEqual(originalState);
    expect(result.migrated).toBe(false);

    const recreatedModel = new DiveModel(result.saveGame.state);
    recreatedModel.advance({ depthM: metres(10) }, seconds(1));
    expect(recreatedModel.snapshot.elapsedTimeS).toBe(1);
    expect(recreatedModel.snapshot.depthM).toBe(10);
  });

  it("clears corrupted data so it cannot poison later starts", () => {
    const store = new MemoryStore([
      [SAVE_GAME_STORAGE_KEY, "{not-json"],
    ]);

    expect(new LocalSaveRepository(store).load()).toEqual({
      status: "rejected",
      reason: "invalid-json",
    });
    expect(store.getItem(SAVE_GAME_STORAGE_KEY)).toBeNull();
  });

  it("preserves a future-version save while rejecting it", () => {
    const future = JSON.stringify({
      schema: SAVE_GAME_SCHEMA,
      version: CURRENT_SAVE_GAME_VERSION + 1,
    });
    const store = new MemoryStore([[SAVE_GAME_STORAGE_KEY, future]]);

    expect(new LocalSaveRepository(store).load()).toEqual({
      status: "rejected",
      reason: "unsupported-version",
    });
    expect(store.getItem(SAVE_GAME_STORAGE_KEY)).toBe(future);
  });

  it("promotes a valid legacy save to the new key and removes the old key", () => {
    const legacy = JSON.stringify(minimalLegacyV2Save());
    const store = new MemoryStore([[LEGACY_SAVE_STORAGE_KEY, legacy]]);

    const result = new LocalSaveRepository(store).load();

    expect(result.status).toBe("loaded");
    if (result.status !== "loaded") return;
    expect(result.migrated).toBe(true);
    expect(store.getItem(LEGACY_SAVE_STORAGE_KEY)).toBeNull();
    expect(store.getItem(SAVE_GAME_STORAGE_KEY)).not.toBeNull();
  });
});

class MemoryStore implements KeyValueStore {
  readonly #values: Map<string, string>;

  constructor(entries: readonly (readonly [string, string])[] = []) {
    this.#values = new Map(entries);
  }

  getItem(key: string): string | null {
    return this.#values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.#values.set(key, value);
  }

  removeItem(key: string): void {
    this.#values.delete(key);
  }
}

function minimalLegacyV2Save(): Record<string, unknown> {
  return {
    saveVersion: 2,
    savedAt: 1_735_689_600_000,
    gameState: "diving",
    depth: 10,
    maxDepth: 12,
    diveTime: 5,
    amvRate: 15,
    po2ViolationTime: 0,
    hypoxiaTime: 0,
    ccrHypoxiaTime: 0,
    ccrHyperoxiaTime: 0,
    tissues: Array(16).fill(0.75),
    tissuesHe: Array(16).fill(0),
    activeTank: 0,
    tankCount: 1,
    diveMode: "rec",
    tanks: [
      {
        fO2: 0.21,
        fHe: 0,
        fN2: 0.79,
        volume: 12,
        gasRemaining: 2_000,
      },
    ],
  };
}
