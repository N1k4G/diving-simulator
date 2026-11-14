// The language switch (#169), one button for every screen that offers it, so
// its words, its lang and its accessible name are the same on each.
//
// Legacy's Language button (src/ui.js 403-417 and 568-569) names the other
// language in that language, "Sprache" on an English screen and "Language"
// on a German one, so a player who cannot read the screen finds it. The
// words are in that language, and lang says so; no aria-label, the visible
// word is the name. Legacy offers it on its gas setup alone; the safety gate
// offers it too, the owner's departure of 2026-11-14 (docs/decisions.md).
import { translate, type SupportedLocale } from "./i18n/catalog";
import { nextLocale } from "./i18n/locale-preference";

/**
 * The switch for a screen in `locale`. A click, which a tap, Enter and Space
 * all give a button, calls `onSwitch`; the screen redraws itself in the next
 * locale and keeps the focus on its new switch.
 */
export function createLanguageSwitch(
  locale: SupportedLocale,
  onSwitch: () => void,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "setup-preset";
  button.textContent = translate(locale, "setup.language.switch");
  button.lang = nextLocale(locale);
  button.addEventListener("click", onSwitch);
  return button;
}
