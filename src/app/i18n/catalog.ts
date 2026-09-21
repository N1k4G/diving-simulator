export const SUPPORTED_LOCALES = ["en", "de"] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: SupportedLocale = "en";

const englishMessages = {
  "setup.eyebrow": "Before the dive",
  "setup.heading": "Plan your gas",
  "setup.keyboardHint": "Keyboard: 1-8 gas presets, arrow keys oxygen, Page Up/Down tank pressure, M mode, Enter to start.",
  "setup.mode.legend": "Dive mode",
  "setup.mode.rec": "Recreational",
  "setup.mode.tec": "Technical",
  "setup.mode.ccr": "Closed-circuit rebreather",
  "setup.mode.unavailable": "Not configurable yet",
  "setup.site.legend": "Dive site",
  "setup.site.shore": "Shore",
  "setup.site.reef": "Reef",
  "setup.site.wreck": "Wreck",
  "setup.site.cave": "Cave",
  "setup.preset.legend": "Gas preset",
  "setup.preset.air": "Air",
  "setup.preset.ean28": "EAN28",
  "setup.preset.ean32": "EAN32",
  "setup.preset.ean36": "EAN36",
  "setup.preset.tx2135": "Tx 21/35",
  "setup.preset.tx1845": "Tx 18/45",
  "setup.preset.tx1555": "Tx 15/55",
  "setup.preset.hx2179": "Hx 21/79",
  "setup.gas.oxygen": "Oxygen",
  "setup.gas.oxygen.decrease": "Decrease oxygen fraction",
  "setup.gas.oxygen.increase": "Increase oxygen fraction",
  "setup.tank.pressure": "Tank pressure",
  "setup.tank.pressure.decrease": "Decrease tank pressure",
  "setup.tank.pressure.increase": "Increase tank pressure",
  "setup.start": "Start dive",
  "setup.unavailableSite.heading": "This dive site is not built yet",
  "setup.unavailableSite.body": "Only the wreck has been rebuilt in the new renderer so far. Choose the wreck to dive, or go back and pick a different site.",
  "setup.unavailableSite.back": "Back to setup",
  "wreck.brand": "Diving Simulator",
  "wreck.preview": "WP-06 wreck preview",
  "wreck.site": "MV Northstar",
  "wreck.safety.eyebrow": "Before entering the water",
  "wreck.safety.heading": "This is a simulation, not a dive planner",
  "wreck.safety.summary":
    "Do not use this experience to plan a real dive, choose gases, or make decompression decisions.",
  "wreck.safety.training":
    "Real diving requires appropriate training, equipment, procedures, and direct professional judgment.",
  "wreck.safety.emergency":
    "If you have symptoms after diving, seek qualified medical help and contact local emergency services.",
  "wreck.safety.methodologyHeading": "Safety and methodology",
  "wreck.safety.methodology":
    "The preview runs a deterministic Bühlmann ZHL-16C simulation for software testing. Visual movement and route position are provisional and are not inputs to a certified dive computer.",
  "wreck.safety.accept": "I understand — start simulation",
  "wreck.hud.depth": "Depth",
  "wreck.hud.time": "Dive time",
  "wreck.hud.gas": "Gas",
  "wreck.hud.ndl": "No-decompression time",
  "wreck.hud.zone": "Location",
  "wreck.hud.normal": "Simulation running",
  "wreck.hud.warning.lowGas": "Low gas",
  "wreck.hud.warning.oxygen": "Oxygen warning",
  "wreck.hud.warning.failure": "Dive failure",
  "wreck.zone.exterior": "Wreck exterior",
  "wreck.zone.cargo-hold": "Cargo hold",
  "wreck.zone.engine-room": "Engine room",
  "wreck.warning.lowGas": "Low gas pressure — begin a controlled exit",
  "wreck.warning.oxygen": "Unsafe simulated oxygen pressure",
  "wreck.warning.failure": "Simulated dive failure — return to the surface",
  "wreck.controls.heading": "Dive controls",
  "wreck.controls.ascend": "Ascend",
  "wreck.controls.descend": "Descend",
  "wreck.controls.left": "Fin left",
  "wreck.controls.right": "Fin right",
  "wreck.controls.torch": "Toggle torch",
  "wreck.controls.mute": "Mute audio",
  "wreck.controls.hint": "Arrow keys or W A S D move the diver. T toggles the torch.",
  "wreck.symbol.torch": "◉",
  "wreck.symbol.audio": "♪",
  "wreck.symbol.warning": "⚠",
  "wreck.value.unavailable": "—",
  "wreck.error.heading": "The wreck preview could not start",
  "wreck.error.retry": "Reload and try again",
} as const;

export type MessageKey = keyof typeof englishMessages;

const catalog: Record<SupportedLocale, Record<MessageKey, string>> = {
  en: englishMessages,
  de: {
    "setup.eyebrow": "Vor dem Tauchgang",
    "setup.heading": "Gas planen",
    "setup.keyboardHint": "Tastatur: 1-8 Gas-Presets, Pfeiltasten Sauerstoff, Bild auf/ab Flaschendruck, M Modus, Enter zum Starten.",
    "setup.mode.legend": "Tauchmodus",
    "setup.mode.rec": "Sporttauchen",
    "setup.mode.tec": "Technisch",
    "setup.mode.ccr": "Kreislaufgerät",
    "setup.mode.unavailable": "Noch nicht einstellbar",
    "setup.site.legend": "Tauchplatz",
    "setup.site.shore": "Ufer",
    "setup.site.reef": "Riff",
    "setup.site.wreck": "Wrack",
    "setup.site.cave": "Höhle",
    "setup.preset.legend": "Gas-Preset",
    "setup.preset.air": "Luft",
    "setup.preset.ean28": "EAN28",
    "setup.preset.ean32": "EAN32",
    "setup.preset.ean36": "EAN36",
    "setup.preset.tx2135": "Tx 21/35",
    "setup.preset.tx1845": "Tx 18/45",
    "setup.preset.tx1555": "Tx 15/55",
    "setup.preset.hx2179": "Hx 21/79",
    "setup.gas.oxygen": "Sauerstoff",
    "setup.gas.oxygen.decrease": "Sauerstoffanteil verringern",
    "setup.gas.oxygen.increase": "Sauerstoffanteil erhöhen",
    "setup.tank.pressure": "Flaschendruck",
    "setup.tank.pressure.decrease": "Flaschendruck verringern",
    "setup.tank.pressure.increase": "Flaschendruck erhöhen",
    "setup.start": "Tauchgang starten",
    "setup.unavailableSite.heading": "Dieser Tauchplatz ist noch nicht gebaut",
    "setup.unavailableSite.body": "Bisher wurde nur das Wrack im neuen Renderer neu aufgebaut. Wähle das Wrack, um zu tauchen, oder geh zurück und nimm einen anderen Platz.",
    "setup.unavailableSite.back": "Zurück zur Auswahl",
    "wreck.brand": "Tauchsimulator",
    "wreck.preview": "WP-06-Wrackvorschau",
    "wreck.site": "MV Northstar",
    "wreck.safety.eyebrow": "Vor dem Abtauchen",
    "wreck.safety.heading": "Dies ist eine Simulation, kein Tauchplaner",
    "wreck.safety.summary":
      "Verwende diese Anwendung nicht, um einen echten Tauchgang zu planen, Gase auszuwählen oder Dekompressionsentscheidungen zu treffen.",
    "wreck.safety.training":
      "Echtes Tauchen erfordert geeignete Ausbildung, Ausrüstung, Verfahren und unmittelbare professionelle Beurteilung.",
    "wreck.safety.emergency":
      "Suche bei Beschwerden nach dem Tauchen qualifizierte medizinische Hilfe und kontaktiere den örtlichen Rettungsdienst.",
    "wreck.safety.methodologyHeading": "Sicherheit und Methodik",
    "wreck.safety.methodology":
      "Die Vorschau nutzt eine deterministische Bühlmann-ZHL-16C-Simulation für Softwaretests. Visuelle Bewegung und Routenposition sind vorläufig und keine Eingaben für einen zertifizierten Tauchcomputer.",
    "wreck.safety.accept": "Verstanden — Simulation starten",
    "wreck.hud.depth": "Tiefe",
    "wreck.hud.time": "Tauchzeit",
    "wreck.hud.gas": "Gas",
    "wreck.hud.ndl": "Nullzeit",
    "wreck.hud.zone": "Ort",
    "wreck.hud.normal": "Simulation läuft",
    "wreck.hud.warning.lowGas": "Niedriger Gasdruck",
    "wreck.hud.warning.oxygen": "Sauerstoffwarnung",
    "wreck.hud.warning.failure": "Tauchausfall",
    "wreck.zone.exterior": "Wrackaußenseite",
    "wreck.zone.cargo-hold": "Laderaum",
    "wreck.zone.engine-room": "Maschinenraum",
    "wreck.warning.lowGas": "Niedriger Gasdruck — kontrollierten Rückweg beginnen",
    "wreck.warning.oxygen": "Unsicherer simulierter Sauerstoffpartialdruck",
    "wreck.warning.failure": "Simulierter Tauchausfall — zur Oberfläche zurückkehren",
    "wreck.controls.heading": "Tauchsteuerung",
    "wreck.controls.ascend": "Aufsteigen",
    "wreck.controls.descend": "Absteigen",
    "wreck.controls.left": "Nach links flossen",
    "wreck.controls.right": "Nach rechts flossen",
    "wreck.controls.torch": "Lampe umschalten",
    "wreck.controls.mute": "Audio stummschalten",
    "wreck.controls.hint": "Pfeiltasten oder W A S D bewegen die Figur. T schaltet die Lampe um.",
    "wreck.symbol.torch": "◉",
    "wreck.symbol.audio": "♪",
    "wreck.symbol.warning": "⚠",
    "wreck.value.unavailable": "—",
    "wreck.error.heading": "Die Wrackvorschau konnte nicht gestartet werden",
    "wreck.error.retry": "Neu laden und erneut versuchen",
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
