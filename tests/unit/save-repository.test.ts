import { describe, expect, it } from "vitest";
import { createInitialDiveState } from "../../src/core/dive-state";
import { DiveModel } from "../../src/core/dive-model";
import { metres, seconds } from "../../src/core/units";
import {
  CURRENT_SAVE_GAME_VERSION,
  DEFAULT_SAVED_GRADIENT_FACTORS,
  FIRST_SAVE_GAME_VERSION,
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
    new LocalSaveRepository(store).save(
      originalState,
      { lowPercent: 45, highPercent: 85 },
      1_735_689_600_000,
    );

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

  it("carries the gradient factors back out of the store", () => {
    // #158 review: the repository persisted the DiveState alone, so a resumed
    // dive was re-planned on whatever the setup screen happened to show.
    const store = new MemoryStore();
    new LocalSaveRepository(store).save(createInitialDiveState(7), {
      lowPercent: 50,
      highPercent: 80,
    });

    const result = new LocalSaveRepository(store).load();

    expect(result.status).toBe("loaded");
    if (result.status !== "loaded") return;
    expect(result.saveGame.gradientFactors).toEqual({
      lowPercent: 50,
      highPercent: 80,
    });
  });

  it("upgrades a v1 save in place instead of discarding the dive", () => {
    const v1 = JSON.stringify({
      schema: SAVE_GAME_SCHEMA,
      version: FIRST_SAVE_GAME_VERSION,
      savedAtEpochMs: 1_735_689_600_000,
      state: createInitialDiveState(7),
    });
    const store = new MemoryStore([[SAVE_GAME_STORAGE_KEY, v1]]);

    const result = new LocalSaveRepository(store).load();

    expect(result.status).toBe("loaded");
    if (result.status !== "loaded") return;
    expect(result.migrated).toBe(true);
    expect(result.saveGame.gradientFactors).toEqual(
      DEFAULT_SAVED_GRADIENT_FACTORS,
    );
    // Rewritten at the current version, so the next load needs no migration.
    const rewritten = JSON.parse(
      store.getItem(SAVE_GAME_STORAGE_KEY) ?? "null",
    ) as { version: number };
    expect(rewritten.version).toBe(CURRENT_SAVE_GAME_VERSION);
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

describe("LocalSaveRepository under a refusing store", () => {
  // Safari private browsing throws on every write, and any browser throws once
  // the origin quota is exhausted. Persistence is best-effort: it must never
  // take down the caller, and it must never discard the only copy of a save.
  class RefusingStore implements KeyValueStore {
    readonly #items = new Map<string, string>();
    removals: string[] = [];

    constructor(seed: Record<string, string> = {}) {
      for (const [key, value] of Object.entries(seed)) {
        this.#items.set(key, value);
      }
    }

    getItem(key: string): string | null {
      return this.#items.get(key) ?? null;
    }

    setItem(): never {
      throw new DOMException("quota exceeded", "QuotaExceededError");
    }

    removeItem(key: string): void {
      this.removals.push(key);
      this.#items.delete(key);
    }
  }

  it("reports a refused save instead of throwing", () => {
    const repository = new LocalSaveRepository(new RefusingStore());

    const result = repository.save(createInitialDiveState(1), {
      lowPercent: 45,
      highPercent: 85,
    });

    expect(result.persisted).toBe(false);
    expect(result.saveGame.version).toBe(CURRENT_SAVE_GAME_VERSION);
  });

  it("still returns a migrated legacy save when the rewrite is refused", () => {
    const legacy = JSON.stringify(minimalLegacyV2Save());
    const store = new RefusingStore({ [LEGACY_SAVE_STORAGE_KEY]: legacy });
    const repository = new LocalSaveRepository(store);

    const result = repository.load();

    expect(result.status).toBe("loaded");
    // The legacy key is the only surviving copy, so it must not be retired
    // until its replacement is durably stored.
    expect(store.removals).not.toContain(LEGACY_SAVE_STORAGE_KEY);
    expect(store.getItem(LEGACY_SAVE_STORAGE_KEY)).toBe(legacy);
  });
});
