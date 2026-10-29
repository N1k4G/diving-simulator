import { describe, expect, it } from "vitest";

import {
  keyValuePersistentStore,
  type KeyValueStore,
} from "../../platform/browser-platform";
import {
  LOCALE_STORAGE_KEY,
  initialLocale,
  loadLocalePreference,
  nextLocale,
  parseStoredLocale,
} from "./locale-preference";

function memoryStore(entries: Record<string, string> = {}): KeyValueStore & { entries: Record<string, string> } {
  return {
    entries,
    getItem: (key) => entries[key] ?? null,
    setItem: (key, value) => {
      entries[key] = value;
    },
    removeItem: (key) => {
      delete entries[key];
    },
  };
}

/** Read once, through the browser's store over `store` (#137 A4a). */
const createLocalePreference = (store: () => KeyValueStore) =>
  loadLocalePreference(keyValuePersistentStore(store));

const failingStore: KeyValueStore = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
  removeItem: () => {
    throw new Error("SecurityError");
  },
};

describe("locale preference (#169)", () => {
  it("accepts exactly the locales this client writes", () => {
    expect(parseStoredLocale("en")).toBe("en");
    expect(parseStoredLocale("de")).toBe("de");
    for (const value of [null, "", "fr", "EN", "de-DE", " de", "\"de\"", "undefined"]) {
      expect(parseStoredLocale(value), String(value)).toBeNull();
    }
  });

  it("saves the choice under its key and reads it back", async () => {
    const store = memoryStore();
    const preference = await createLocalePreference(() => store);
    expect(preference.stored()).toBeNull();
    preference.save("de");
    expect(store.entries).toEqual({ [LOCALE_STORAGE_KEY]: "de" });
    expect(preference.stored()).toBe("de");
    preference.save("en");
    expect(preference.stored()).toBe("en");
    expect(store.entries).toEqual({ [LOCALE_STORAGE_KEY]: "en" });
    // Read once: a value written behind it is not this page's choice.
    store.entries[LOCALE_STORAGE_KEY] = "de";
    expect(preference.stored()).toBe("en");
  });

  it("a stored choice wins over the browser's preference", async () => {
    const preference = await createLocalePreference(() => memoryStore({ [LOCALE_STORAGE_KEY]: "en" }));
    expect(initialLocale(preference, () => "de")).toBe("en");
    const german = await createLocalePreference(() => memoryStore({ [LOCALE_STORAGE_KEY]: "de" }));
    expect(initialLocale(german, () => "en")).toBe("de");
  });

  it("no choice, or one this client does not know, leaves the browser's preference", async () => {
    expect(initialLocale(await createLocalePreference(() => memoryStore()), () => "de")).toBe("de");
    for (const value of ["fr", "", "de-DE", "{}"]) {
      const preference = await createLocalePreference(() => memoryStore({ [LOCALE_STORAGE_KEY]: value }));
      expect(initialLocale(preference, () => "de"), value).toBe("de");
      expect(initialLocale(preference, () => "en"), value).toBe("en");
    }
  });

  it("storage that throws falls back to the browser and never throws itself", async () => {
    const preference = await createLocalePreference(() => failingStore);
    expect(preference.stored()).toBeNull();
    expect(() => preference.save("de")).not.toThrow();
    expect(initialLocale(preference, () => "de")).toBe("de");
    const unreachable = await createLocalePreference(() => {
      throw new Error("SecurityError: localStorage is not available");
    });
    expect(unreachable.stored()).toBeNull();
    expect(() => unreachable.save("en")).not.toThrow();
  });

  it("the switch flips English and German, as legacy's toggle", () => {
    expect(nextLocale("en")).toBe("de");
    expect(nextLocale("de")).toBe("en");
  });
});
