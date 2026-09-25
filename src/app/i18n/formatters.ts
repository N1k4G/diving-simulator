import type { SupportedLocale } from "./catalog";

const localeTags: Record<SupportedLocale, string> = {
  en: "en-US",
  de: "de-DE",
};

export function formatDepth(depthM: number, locale: SupportedLocale): string {
  return formatUnit(assertNonNegative(depthM, "depthM"), locale, "meter", 1);
}

export function formatPressure(
  pressureBar: number,
  locale: SupportedLocale,
): string {
  const value = assertNonNegative(pressureBar, "pressureBar");
  const formattedValue = new Intl.NumberFormat(localeTags[locale], {
    maximumFractionDigits: 1,
  }).format(value);

  return `${formattedValue}\u00a0bar`;
}

/**
 * A partial pressure, to two decimals — a loop PO₂ of 1.28 bar and one of
 * 1.32 bar are different readings to a rebreather diver, where a cylinder
 * pressure to the tenth of a bar is already more than anyone reads.
 */
export function formatPartialPressure(
  pressureBar: number,
  locale: SupportedLocale,
): string {
  const value = assertNonNegative(pressureBar, "pressureBar");
  const formattedValue = new Intl.NumberFormat(localeTags[locale], {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);

  return `${formattedValue} bar`;
}

/**
 * A duration in whole minutes, for the scrubber row: src/renderer.js draws
 * `Math.round(ccrState.scrubberRemaining) + ' min'`. formatDuration's
 * "2 hr, 59 min, 58 sec" wrapped onto two lines in the HUD and, with the
 * loop's other rows, pushed it into the controls on a short screen (#163
 * review round 2 on PR #182).
 */
export function formatWholeMinutes(
  durationS: number,
  locale: SupportedLocale,
): string {
  const minutes = Math.round(assertNonNegative(durationS, "durationS") / 60);
  return formatUnit(minutes, locale, "minute");
}

/**
 * A whole-number percentage that may exceed 100 — a gradient factor, or a
 * compartment past its M-value. formatGasFraction refuses anything over 1,
 * which is right for a gas and wrong for these.
 */
export function formatPercent(
  fraction: number,
  locale: SupportedLocale,
): string {
  const value = assertNonNegative(fraction, "fraction");
  return new Intl.NumberFormat(localeTags[locale], {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(value);
}

/** A cylinder's water volume in litres, as legacy's "O2 V" and "DIL V" rows. */
export function formatVolume(
  volumeL: number,
  locale: SupportedLocale,
): string {
  return formatUnit(assertNonNegative(volumeL, "volumeL"), locale, "liter", 1);
}

export function formatGasFraction(
  fraction: number,
  locale: SupportedLocale,
): string {
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
    throw new RangeError("fraction must be a finite number between 0 and 1");
  }

  return new Intl.NumberFormat(localeTags[locale], {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(fraction);
}

export function formatDuration(
  durationS: number,
  locale: SupportedLocale,
): string {
  const roundedSeconds = Math.round(assertNonNegative(durationS, "durationS"));
  const hours = Math.floor(roundedSeconds / 3_600);
  const minutes = Math.floor((roundedSeconds % 3_600) / 60);
  const seconds = roundedSeconds % 60;
  const parts: string[] = [];

  if (hours > 0) {
    parts.push(formatUnit(hours, locale, "hour"));
  }

  if (minutes > 0 || hours > 0) {
    parts.push(formatUnit(minutes, locale, "minute"));
  }

  parts.push(formatUnit(seconds, locale, "second"));

  return new Intl.ListFormat(localeTags[locale], {
    style: "narrow",
    type: "unit",
  }).format(parts);
}

function formatUnit(
  value: number,
  locale: SupportedLocale,
  unit: Intl.NumberFormatOptions["unit"],
  maximumFractionDigits = 0,
): string {
  return new Intl.NumberFormat(localeTags[locale], {
    style: "unit",
    unit,
    unitDisplay: "short",
    maximumFractionDigits,
  }).format(value);
}

function assertNonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite non-negative number`);
  }

  return value;
}
