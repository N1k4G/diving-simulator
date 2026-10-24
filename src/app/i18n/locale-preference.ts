// The player's language choice (#169), kept in the page's storage so the next
// load opens in it.
//
// Legacy offers the switch on its gas setup alone (src/ui.js 403-417,
// src/touch.js 176-180) and stores nothing: `currentLang` is 'en' on every
// load (src/constants.js 551). Keeping the choice is #169's scope, a
// departure recorded in docs/decisions.md. A stored choice wins over the
// browser's languages; a value this client does not know, or storage that
// cannot be read, leaves the browser's preference in charge.
import type { KeyValueStore } from "../../save/save-repository";
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

export function createLocalePreference(store: () => KeyValueStore): LocalePreference {
  return {
    stored: () => {
      try {
        return parseStoredLocale(store().getItem(LOCALE_STORAGE_KEY));
      } catch {
        return null;
      }
    },
    save: (locale) => {
      try {
        store().setItem(LOCALE_STORAGE_KEY, locale);
      } catch {
        // Private browsing or a full quota: the switch still holds until reload.
      }
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
