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
  LocalSaveRepository as AsyncSaveRepository,
  SAVE_GAME_STORAGE_KEY,
  serialStore,
} from "../../src/save/save-repository";
import {
  keyValuePersistentStore,
  type KeyValueStore,
} from "../../src/platform/browser-platform";
import type { PersistentStore } from "../../src/platform/platform-services";
import { PersistenceStatus } from "../../src/app/persistence-status";

/** The repository over the browser's store, on a synchronous one (#137 A4a). */
class LocalSaveRepository extends AsyncSaveRepository {
  constructor(store: KeyValueStore, options?: ConstructorParameters<typeof AsyncSaveRepository>[1]) {
    super(keyValuePersistentStore(() => store), options);
  }
}

describe("LocalSaveRepository", () => {
  it("restores a save after the repository and model process are recreated", async () => {
    const store = new MemoryStore();
    const originalState = createInitialDiveState(42);
    await new LocalSaveRepository(store).save(
      originalState,
      { lowPercent: 45, highPercent: 85 },
      1_735_689_600_000,
    );

    const recreatedRepository = new LocalSaveRepository(store);
    const result = await recreatedRepository.load();

    expect(result.status).toBe("loaded");
    if (result.status !== "loaded") return;
    expect(result.saveGame.state).toEqual(originalState);
    expect(result.migrated).toBe(false);

    const recreatedModel = new DiveModel(result.saveGame.state);
    recreatedModel.advance({ depthM: metres(10) }, seconds(1));
    expect(recreatedModel.snapshot.elapsedTimeS).toBe(1);
    expect(recreatedModel.snapshot.depthM).toBe(10);
  });

  it("clears corrupted data so it cannot poison later starts", async () => {
    const store = new MemoryStore([
      [SAVE_GAME_STORAGE_KEY, "{not-json"],
    ]);

    expect(await new LocalSaveRepository(store).load()).toEqual({
      status: "rejected",
      reason: "invalid-json",
    });
    expect(store.getItem(SAVE_GAME_STORAGE_KEY)).toBeNull();
  });

  it("preserves a future-version save while rejecting it", async () => {
    const future = JSON.stringify({
      schema: SAVE_GAME_SCHEMA,
      version: CURRENT_SAVE_GAME_VERSION + 1,
    });
    const store = new MemoryStore([[SAVE_GAME_STORAGE_KEY, future]]);

    expect(await new LocalSaveRepository(store).load()).toEqual({
      status: "rejected",
      reason: "unsupported-version",
    });
    expect(store.getItem(SAVE_GAME_STORAGE_KEY)).toBe(future);
  });

  it("promotes a valid legacy save to the new key and removes the old key", async () => {
    const legacy = JSON.stringify(minimalLegacyV2Save());
    const store = new MemoryStore([[LEGACY_SAVE_STORAGE_KEY, legacy]]);

    const result = await new LocalSaveRepository(store).load();

    expect(result.status).toBe("loaded");
    if (result.status !== "loaded") return;
    expect(result.migrated).toBe(true);
    expect(store.getItem(LEGACY_SAVE_STORAGE_KEY)).toBeNull();
    expect(store.getItem(SAVE_GAME_STORAGE_KEY)).not.toBeNull();
  });

  // Each dive on its own seed (#219, owner decision of 2026-10-07): legacy
  // saves none, so a dive migrated from one draws its seed once, at the
  // migration, from the source the app passes in.
  it("seeds a dive migrated from a legacy save from the source it is given, once", async () => {
    const seeded = async (seed: number) => {
      const store = new MemoryStore([[LEGACY_SAVE_STORAGE_KEY, JSON.stringify(minimalLegacyV2Save())]]);
      let draws = 0;
      const repository = new LocalSaveRepository(store, { legacySeed: () => (draws += 1, seed) });
      const first = await repository.load();
      // Resumed again: from the migrated save written back, on the same seed,
      // with no second draw.
      const second = await new LocalSaveRepository(store, { legacySeed: () => (draws += 1, seed + 1) }).load();
      if (first.status !== "loaded" || second.status !== "loaded") throw new Error("not loaded");
      expect(second.migrated).toBe(false);
      expect(second.saveGame.state.randomState).toBe(first.saveGame.state.randomState);
      expect(draws).toBe(1);
      return first.saveGame.state.randomState;
    };
    expect(await seeded(0x1234)).toBe(0x1234);
    expect(await seeded(0xbeef)).toBe(0xbeef);
  });

  it("does not re-seed a current save", async () => {
    const store = new MemoryStore();
    await new LocalSaveRepository(store).save(createInitialDiveState(77), DEFAULT_SAVED_GRADIENT_FACTORS);
    const loaded = await new LocalSaveRepository(store, {
      legacySeed: () => {
        throw new Error("a current save drew a seed");
      },
    }).load();
    if (loaded.status !== "loaded") throw new Error("not loaded");
    expect(loaded.migrated).toBe(false);
    expect(loaded.saveGame.state.randomState).toBe(createInitialDiveState(77).randomState);
  });

  it("carries the gradient factors back out of the store", async () => {
    // #158 review: the repository persisted the DiveState alone, so a resumed
    // dive was re-planned on whatever the setup screen happened to show.
    const store = new MemoryStore();
    await new LocalSaveRepository(store).save(createInitialDiveState(7), {
      lowPercent: 50,
      highPercent: 80,
    });

    const result = await new LocalSaveRepository(store).load();

    expect(result.status).toBe("loaded");
    if (result.status !== "loaded") return;
    expect(result.saveGame.gradientFactors).toEqual({
      lowPercent: 50,
      highPercent: 80,
    });
  });

  it("upgrades a v1 save in place instead of discarding the dive", async () => {
    const v1 = JSON.stringify({
      schema: SAVE_GAME_SCHEMA,
      version: FIRST_SAVE_GAME_VERSION,
      savedAtEpochMs: 1_735_689_600_000,
      state: createInitialDiveState(7),
    });
    const store = new MemoryStore([[SAVE_GAME_STORAGE_KEY, v1]]);

    const result = await new LocalSaveRepository(store).load();

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

  it("reports a refused save instead of throwing", async () => {
    const repository = new LocalSaveRepository(new RefusingStore());

    const result = await repository.save(createInitialDiveState(1), {
      lowPercent: 45,
      highPercent: 85,
    });

    expect(result.persisted).toBe(false);
    expect(result.saveGame.version).toBe(CURRENT_SAVE_GAME_VERSION);
  });

  it("still returns a migrated legacy save when the rewrite is refused", async () => {
    const legacy = JSON.stringify(minimalLegacyV2Save());
    const store = new RefusingStore({ [LEGACY_SAVE_STORAGE_KEY]: legacy });
    const repository = new LocalSaveRepository(store);

    const result = await repository.load();

    expect(result.status).toBe("loaded");
    // The legacy key is the only surviving copy, so it must not be retired
    // until its replacement is durably stored.
    expect(store.removals).not.toContain(LEGACY_SAVE_STORAGE_KEY);
    expect(store.getItem(LEGACY_SAVE_STORAGE_KEY)).toBe(legacy);
  });
});

// #137 A4a: the store is asynchronous, as Capacitor Preferences is, and the
// autosave, the background's save, pagehide's and a dive's clearing may
// all be made while a write is still with it.
class ControlledStore implements PersistentStore {
  readonly values = new Map<string, string>();
  /** Each write as the store was handed it. */
  readonly writes: string[] = [];
  #pending: { label: string; settle: (ok: boolean) => void }[] = [];
  inFlight = 0;
  maxInFlight = 0;

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.values.get(key) ?? null);
  }
  set(key: string, value: string): Promise<void> {
    let label = value;
    try {
      label = String((JSON.parse(value) as { savedAtEpochMs?: number }).savedAtEpochMs ?? value);
    } catch {
      // Not a save: its value names it.
    }
    return this.#write(`set ${label}`, () => void this.values.set(key, value));
  }
  remove(key: string): Promise<void> {
    return this.#write(`remove ${key}`, () => void this.values.delete(key));
  }
  /** Settles every write with the store, then lets the queue move on. */
  async settle(ok = true): Promise<void> {
    for (const { settle } of this.#pending.splice(0)) settle(ok);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  /** Settles the write named `label` alone, in the order the test chooses. */
  async settleOne(label: string, ok = true): Promise<void> {
    const at = this.#pending.findIndex((write) => write.label === label);
    if (at < 0) throw new Error(`no pending ${label}`);
    this.#pending.splice(at, 1)[0]!.settle(ok);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  #write(label: string, apply: () => void): Promise<void> {
    this.writes.push(label);
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    return new Promise((resolve, reject) => {
      this.#pending.push({ label, settle: (ok) => {
        this.inFlight -= 1;
        if (ok) {
          apply();
          resolve();
        } else {
          reject(new DOMException("quota exceeded", "QuotaExceededError"));
        }
      } });
    });
  }
}

describe("LocalSaveRepository over an asynchronous store (#137 A4a)", () => {
  const save = (repository: AsyncSaveRepository, savedAtEpochMs: number) =>
    repository.save(createInitialDiveState(1), DEFAULT_SAVED_GRADIENT_FACTORS, savedAtEpochMs);
  const savedAt = (store: ControlledStore) =>
    (JSON.parse(store.values.get(SAVE_GAME_STORAGE_KEY) ?? "null") as { savedAtEpochMs: number } | null)
      ?.savedAtEpochMs ?? null;

  it("writes one save at a time, and of those made meanwhile only the latest", async () => {
    const store = new ControlledStore();
    const repository = new AsyncSaveRepository(store);
    const first = save(repository, 1);
    // Handed to the store inside the call, not on a later tick.
    expect(store.writes).toEqual(["set 1"]);
    const second = save(repository, 2);
    const third = save(repository, 3);
    expect(store.writes).toEqual(["set 1"]);

    await store.settle();
    expect(store.writes).toEqual(["set 1", "set 3"]);
    expect(savedAt(store)).toBe(1);
    await store.settle();
    expect(savedAt(store)).toBe(3);
    expect(store.maxInFlight).toBe(1);
    // The replaced save reports the write that replaced it.
    for (const result of await Promise.all([first, second, third])) {
      expect(result.persisted).toBe(true);
    }
  });

  it("a clearing made behind a save is the last word, and a save after it replaces it", async () => {
    const store = new ControlledStore();
    const repository = new AsyncSaveRepository(store);
    void save(repository, 1);
    const cleared = repository.clear();
    await store.settle();
    expect(store.writes).toEqual([
      "set 1",
      `remove ${SAVE_GAME_STORAGE_KEY}`,
      `remove ${LEGACY_SAVE_STORAGE_KEY}`,
    ]);
    await store.settle();
    expect(await cleared).toBe(true);
    expect(store.values.size).toBe(0);

    void save(repository, 2);
    void repository.clear();
    const last = save(repository, 3);
    await store.settle();
    await store.settle();
    expect(store.writes.slice(3)).toEqual(["set 2", "set 3"]);
    expect(savedAt(store)).toBe(3);
    expect((await last).persisted).toBe(true);
  });

  it("reports a refused write to its save, and the next save taken as persisted", async () => {
    const store = new ControlledStore();
    const repository = new AsyncSaveRepository(store);
    const refused = save(repository, 1);
    await store.settle(false);
    expect((await refused).persisted).toBe(false);
    expect(savedAt(store)).toBeNull();

    const taken = save(repository, 2);
    await store.settle();
    expect((await taken).persisted).toBe(true);
    expect(savedAt(store)).toBe(2);
  });

  it("reads a store that cannot be reached as a rejected load, and a store that throws as a refused save", async () => {
    const unreachable: PersistentStore = {
      get: () => Promise.reject(new DOMException("The operation is insecure.", "SecurityError")),
      set: () => {
        throw new Error("a store that throws");
      },
      remove: () => Promise.reject(new Error("refused")),
    };
    const repository = new AsyncSaveRepository(unreachable);
    await expect(repository.load()).rejects.toThrow("insecure");
    expect((await save(repository, 1)).persisted).toBe(false);
    expect(await repository.clear()).toBe(false);
  });

  // pagehide does not wait for a promise: the browser's store takes the write
  // inside the call, and the repository hands it over inside save().
  it("leaves the save in the browser's storage before save() returns", async () => {
    const memory = new MemoryStore();
    const repository = new AsyncSaveRepository(keyValuePersistentStore(() => memory));
    const stored = () =>
      (JSON.parse(memory.getItem(SAVE_GAME_STORAGE_KEY) ?? "null") as { savedAtEpochMs: number } | null)
        ?.savedAtEpochMs;
    void save(repository, 1);
    expect(stored()).toBe(1);
    // pagehide comes in a later task than the autosave before it, when the
    // queue is idle again, so its save is written inside the call too.
    await new Promise((resolve) => setTimeout(resolve, 0));
    void save(repository, 2);
    expect(stored()).toBe(2);
  });

  // #284 Codex round 1: the clearing's two removals ran under Promise.all, so
  // a refused one moved the queue on while the other was still with the
  // store, and that one then deleted the next dive's save.
  it("waits for both removals of a clearing, one refused, before the next save, which survives", async () => {
    const store = new ControlledStore();
    const repository = new AsyncSaveRepository(store);
    void save(repository, 1);
    await store.settle();
    const cleared = repository.clear();
    const next = save(repository, 2);
    await store.settleOne(`remove ${LEGACY_SAVE_STORAGE_KEY}`, false);
    // The save waits for the removal still pending.
    expect(store.writes).toEqual([
      "set 1",
      `remove ${SAVE_GAME_STORAGE_KEY}`,
      `remove ${LEGACY_SAVE_STORAGE_KEY}`,
    ]);
    await store.settleOne(`remove ${SAVE_GAME_STORAGE_KEY}`);
    expect(await cleared).toBe(false);
    await store.settleOne("set 2");
    expect((await next).persisted).toBe(true);
    expect(savedAt(store)).toBe(2);
  });

  it("reports a clearing with a refused removal as not taken, and moves on", async () => {
    const store = new ControlledStore();
    const repository = new AsyncSaveRepository(store);
    const cleared = repository.clear();
    await store.settleOne(`remove ${SAVE_GAME_STORAGE_KEY}`, false);
    await store.settleOne(`remove ${LEGACY_SAVE_STORAGE_KEY}`);
    expect(await cleared).toBe(false);
    const next = save(repository, 3);
    await store.settle();
    expect((await next).persisted).toBe(true);
  });
});

describe("serialStore (#137 A4a, #284 Codex round 1)", () => {
  const save = (repository: AsyncSaveRepository, savedAtEpochMs: number) =>
    repository.save(createInitialDiveState(1), DEFAULT_SAVED_GRADIENT_FACTORS, savedAtEpochMs);
  const savedAt = (store: ControlledStore) =>
    (JSON.parse(store.values.get(SAVE_GAME_STORAGE_KEY) ?? "null") as { savedAtEpochMs: number } | null)
      ?.savedAtEpochMs ?? null;
  it("hands the store one operation at a time, in order, whoever makes them, and goes on past a refusal", async () => {
    const store = new ControlledStore();
    const serial = serialStore(store);
    // Started inside the call while none is pending.
    const flag = serial.set("diveSim_hint_bcd", "1");
    expect(store.writes).toEqual(["set 1"]);
    const locale = serial.set("diving-simulator.locale", "de");
    const removal = serial.remove(SAVE_GAME_STORAGE_KEY);
    expect(store.writes).toEqual(["set 1"]);
    await store.settle(false);
    await expect(flag).rejects.toThrow("quota");
    expect(store.writes).toEqual(["set 1", "set de"]);
    await store.settle();
    expect(store.writes).toEqual(["set 1", "set de", `remove ${SAVE_GAME_STORAGE_KEY}`]);
    await store.settle();
    await locale;
    await removal;
    expect(store.maxInFlight).toBe(1);
    // Idle again: the next starts inside the call.
    void serial.set("diving-simulator.locale", "en");
    expect(store.writes.at(-1)).toBe("set en");
  });

  it("keeps a save made during the load behind the load's own repair", async () => {
    const store = new ControlledStore();
    store.values.set(LEGACY_SAVE_STORAGE_KEY, JSON.stringify(minimalLegacyV2Save()));
    const repository = new AsyncSaveRepository(serialStore(store));
    const loaded = repository.load();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The migrated save is being written back; a save made now waits for it.
    expect(store.writes).toHaveLength(1);
    const next = save(repository, 9);
    await store.settle();
    await store.settle();
    await store.settle();
    expect((await loaded).status).toBe("loaded");
    expect((await next).persisted).toBe(true);
    // The rewrite first, then the save; the legacy key's retirement, on
    // another key, after both.
    expect(store.writes).toEqual([
      "set 1735689600000",
      "set 9",
      `remove ${LEGACY_SAVE_STORAGE_KEY}`,
    ]);
    expect(savedAt(store)).toBe(9);
    expect(store.maxInFlight).toBe(1);
  });
});

// #282: the notice shows the state the outcomes leave, read once a frame.
// The outcomes arrive in the order the writes reached the store, so the last
// one recorded is the latest. A save a clearing replaced reports the
// clearing's outcome, which says nothing about saving and moves nothing.
describe("the degraded-persistence state over the repository's outcomes (#282)", () => {
  /** A repository whose saves are recorded as wreck-app's saveState() records them. */
  function tracked(store: ControlledStore) {
    const repository = new AsyncSaveRepository(store);
    const status = new PersistenceStatus();
    /** The state after each outcome, in the order they arrived. */
    const seen: boolean[] = [];
    const save = (savedAtEpochMs: number) =>
      repository
        .save(createInitialDiveState(1), DEFAULT_SAVED_GRADIENT_FACTORS, savedAtEpochMs)
        .then((outcome) => {
          status.saveSettled(outcome);
          seen.push(status.degraded);
          return outcome;
        });
    return { repository, status, seen, save };
  }

  it("follows a refused save with a taken one and the other way round, the latest outcome last", async () => {
    const store = new ControlledStore();
    const { status, seen, save } = tracked(store);
    // The save could not be read; the first save taken clears it.
    status.unreadable();
    expect(status.degraded).toBe(true);
    const first = save(1);
    await store.settle();
    await first;
    expect(seen).toEqual([false]);

    // Refused, then taken: shown once, then gone.
    const refused = save(2);
    const taken = save(3);
    await store.settle(false);
    expect(seen).toEqual([false, true]);
    await store.settle();
    await Promise.all([refused, taken]);
    expect(seen).toEqual([false, true, false]);

    // Taken, then refused, the refused one replacing a save made between:
    // both report the refusal, and nothing taken arrives after it.
    const before = save(4);
    const replaced = save(5);
    const latest = save(6);
    await store.settle();
    await store.settle(false);
    await Promise.all([before, replaced, latest]);
    expect(seen).toEqual([false, true, false, false, true, true]);
    expect(status.degraded).toBe(true);
  });

  it("is not moved by a save a clearing replaced, taken where saves are refused or refused where they are taken", async () => {
    // A full quota: the save refused, the clearing that replaced the next one taken.
    const full = new ControlledStore();
    const quota = tracked(full);
    const refused = quota.save(1);
    const replaced = quota.save(2);
    const cleared = quota.repository.clear();
    await full.settle(false);
    await full.settle();
    expect(await cleared).toBe(true);
    expect(await refused).toMatchObject({ persisted: false, cleared: false });
    expect(await replaced).toMatchObject({ persisted: true, cleared: true });
    expect(quota.seen).toEqual([true, true]);

    // The other way round: the save taken, the clearing refused.
    const refusing = new ControlledStore();
    const removals = tracked(refusing);
    const taken = removals.save(1);
    const replacedToo = removals.save(2);
    const notCleared = removals.repository.clear();
    await refusing.settle();
    await refusing.settle(false);
    expect(await notCleared).toBe(false);
    expect(await taken).toMatchObject({ persisted: true, cleared: false });
    expect(await replacedToo).toMatchObject({ persisted: false, cleared: true });
    expect(removals.seen).toEqual([false, false]);
  });
});
