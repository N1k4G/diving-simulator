import { describe, expect, it } from "vitest";

import type { KeyValueStore } from "../../save/save-repository";
import {
  LOCALE_STORAGE_KEY,
  createLocalePreference,
  initialLocale,
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

  it("saves the choice under its key and reads it back", () => {
    const store = memoryStore();
    const preference = createLocalePreference(() => store);
    expect(preference.stored()).toBeNull();
    preference.save("de");
    expect(store.entries).toEqual({ [LOCALE_STORAGE_KEY]: "de" });
    expect(preference.stored()).toBe("de");
    preference.save("en");
    expect(preference.stored()).toBe("en");
  });

  it("a stored choice wins over the browser's preference", () => {
    const preference = createLocalePreference(() => memoryStore({ [LOCALE_STORAGE_KEY]: "en" }));
    expect(initialLocale(preference, () => "de")).toBe("en");
    const german = createLocalePreference(() => memoryStore({ [LOCALE_STORAGE_KEY]: "de" }));
    expect(initialLocale(german, () => "en")).toBe("de");
  });

  it("no choice, or one this client does not know, leaves the browser's preference", () => {
    expect(initialLocale(createLocalePreference(() => memoryStore()), () => "de")).toBe("de");
    for (const value of ["fr", "", "de-DE", "{}"]) {
      const preference = createLocalePreference(() => memoryStore({ [LOCALE_STORAGE_KEY]: value }));
      expect(initialLocale(preference, () => "de"), value).toBe("de");
      expect(initialLocale(preference, () => "en"), value).toBe("en");
    }
  });

  it("storage that throws falls back to the browser and never throws itself", () => {
    const preference = createLocalePreference(() => failingStore);
    expect(preference.stored()).toBeNull();
    expect(() => preference.save("de")).not.toThrow();
    expect(initialLocale(preference, () => "de")).toBe("de");
    const unreachable = createLocalePreference(() => {
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
