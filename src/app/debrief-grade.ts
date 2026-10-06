// The grade's text (#199 slice 6b, for #159): legacy's gradeLabels and
// gradeNotes, filled in as legacy's gradeDive() fills them. The numbers keep
// legacy's own formatting (toFixed), so a note reads exactly as legacy's
// does, in either language.
import type { GradeCategory, GradeNote } from "../core/dive-grade";
import { translate, type MessageKey, type SupportedLocale } from "./i18n/catalog";

const LABEL_KEYS: Readonly<Record<GradeCategory, MessageKey>> = {
  ascent: "debrief.grade.label.ascent",
  safetyStop: "debrief.grade.label.safetyStop",
  gasReserve: "debrief.grade.label.gasReserve",
  deco: "debrief.grade.label.deco",
  trim: "debrief.grade.label.trim",
};

export function gradeLabel(category: GradeCategory, locale: SupportedLocale): string {
  return translate(locale, LABEL_KEYS[category]);
}

export function formatGradeNote(note: GradeNote, locale: SupportedLocale): string {
  const text = translate(locale, `debrief.grade.note.${note.key}` as MessageKey);
  switch (note.key) {
    case "ascentBad":
      return text.replace("{count}", String(note.count)).replace("{peak}", note.peakMpm.toFixed(1));
    case "gasEnd":
      return text.replace("{bar}", note.bar.toFixed(0));
    case "decoNdlClose":
      return text.replace("{ndl}", note.ndlMin.toFixed(0));
    case "decoBad":
      return text.replace("{count}", String(note.count));
    case "trimReport":
      return text.replace("{stddev}", note.stddevM.toFixed(2));
    default:
      return text;
  }
}
