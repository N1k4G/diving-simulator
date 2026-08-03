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
