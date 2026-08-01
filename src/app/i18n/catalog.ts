export const SUPPORTED_LOCALES = ["en", "de"] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: SupportedLocale = "en";

const englishMessages = {
  "diagnostic.eyebrow": "Migration diagnostic",
  "diagnostic.heading": "Diving Simulator",
  "diagnostic.milestone": "WP-02 dual-client bootstrap",
  "diagnostic.status.typescript": "TypeScript",
  "diagnostic.status.vite": "Vite",
  "diagnostic.status.pixi": "PixiJS",
  "diagnostic.status.ready": "ready",
  "diagnostic.legacyLink": "Open the legacy simulator",
} as const;

export type MessageKey = keyof typeof englishMessages;

const catalog: Record<SupportedLocale, Record<MessageKey, string>> = {
  en: englishMessages,
  de: {
    "diagnostic.eyebrow": "Migrationsdiagnose",
    "diagnostic.heading": "Tauchsimulator",
    "diagnostic.milestone": "WP-02-Bootstrap für zwei Clients",
    "diagnostic.status.typescript": "TypeScript",
    "diagnostic.status.vite": "Vite",
    "diagnostic.status.pixi": "PixiJS",
    "diagnostic.status.ready": "bereit",
    "diagnostic.legacyLink": "Bestehenden Simulator öffnen",
  },
};

export function translate(locale: SupportedLocale, key: MessageKey): string {
  return catalog[locale][key] ?? englishMessages[key];
}

export function resolveSupportedLocale(
  requestedLocales: readonly string[],
): SupportedLocale {
  for (const requestedLocale of requestedLocales) {
    const language = requestedLocale.toLowerCase().split("-")[0];

    if (language === "en" || language === "de") {
      return language;
    }
  }

  return DEFAULT_LOCALE;
}

export function detectPreferredLocale(): SupportedLocale {
  if (typeof navigator === "undefined") {
    return DEFAULT_LOCALE;
  }

  return resolveSupportedLocale(navigator.languages);
}
