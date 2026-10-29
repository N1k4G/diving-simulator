// The player's language choice (#169), kept in the page's storage so the next
// load opens in it.
//
// Legacy offers the switch on its gas setup alone (src/ui.js 403-417,
// src/touch.js 176-180) and stores nothing: `currentLang` is 'en' on every
// load (src/constants.js 551). Keeping the choice is #169's scope, a
// departure recorded in docs/decisions.md. A stored choice wins over the
// browser's languages; a value this client does not know, or storage that
// cannot be read, leaves the browser's preference in charge.
import type { PersistentStore } from "../../platform/platform-services";
import {
  SUPPORTED_LOCALES,
  detectPreferredLocale,
  type SupportedLocale,
} from "./catalog";

export const LOCALE_STORAGE_KEY = "diving-simulator.locale";

export interface LocalePreference {
  /** The stored choice, or null when there is none this client knows. */
  stored(): SupportedLocale | null;
  /** Keeps the choice; storage that cannot be written keeps it for this page only. */
  save(locale: SupportedLocale): void;
}

/** A supported locale written exactly as this client writes it, else null. */
export function parseStoredLocale(value: string | null): SupportedLocale | null {
  return SUPPORTED_LOCALES.find((locale) => locale === value) ?? null;
}

/**
 * Reads the choice once, as the page loads, and writes each change through
 * (#137 A4a), so the screens ask nothing of the asynchronous store. Storage
 * that cannot be read or written never rejects here.
 */
export async function loadLocalePreference(store: PersistentStore): Promise<LocalePreference> {
  let stored: SupportedLocale | null;
  try {
    stored = parseStoredLocale(await store.get(LOCALE_STORAGE_KEY));
  } catch {
    stored = null;
  }
  return {
    stored: () => stored,
    save: (locale) => {
      stored = locale;
      // Private browsing or a full quota: the switch still holds until reload.
      void store.set(LOCALE_STORAGE_KEY, locale).catch(() => undefined);
    },
  };
}

/** The locale a page opens in: the stored choice, else the browser's. */
export function initialLocale(
  preference: LocalePreference,
  detect: () => SupportedLocale = detectPreferredLocale,
): SupportedLocale {
  return preference.stored() ?? detect();
}

/** The locale the switch goes to, as legacy's toggle flips en and de. */
export function nextLocale(locale: SupportedLocale): SupportedLocale {
  const at = SUPPORTED_LOCALES.indexOf(locale);
  return SUPPORTED_LOCALES[(at + 1) % SUPPORTED_LOCALES.length] ?? locale;
}
