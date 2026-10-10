// The resume banner (#191): legacy's #resume-dive-banner (#67), shown on the
// setup screen while a saved dive waits for a choice.
//
// Legacy (src/game-loop.js _updateResumeBanner, resumeSavedDive,
// discardSavedDive; src/diving-simulator.html; src/style.css) shows a strip
// at the top of its gas setup with one line and two buttons, Resume and
// Discard. It blocks nothing: the setup stays usable beneath it, and Enter
// there starts a new dive. Resume restores the save and goes on diving;
// Discard clears the save and hides the strip.
//
// Here it is the first thing in the setup panel rather than a fixed overlay,
// so it is the first stop in the tab order and covers none of the controls,
// which is what legacy's placement note asks of it. A named region, so a
// screen reader lists it with the page's landmarks.
import { translate, type SupportedLocale } from "../i18n/catalog";

export interface ResumeOffer {
  readonly onContinue: () => void;
  readonly onDiscard: () => void;
}

export function createResumeBanner(
  locale: SupportedLocale,
  offer: Readonly<ResumeOffer>,
): HTMLElement {
  const banner = document.createElement("section");
  banner.className = "resume-banner";
  banner.dataset.resumeBanner = "true";
  banner.setAttribute("aria-labelledby", "resume-banner-text");

  const text = document.createElement("p");
  text.id = "resume-banner-text";
  text.className = "resume-banner-text";
  text.textContent = translate(locale, "setup.resume.text");

  const actions = document.createElement("div");
  actions.className = "resume-banner-actions";
  actions.append(
    bannerButton(locale, "setup.resume.continue", "resumeContinue", offer.onContinue),
    bannerButton(locale, "setup.resume.discard", "resumeDiscard", offer.onDiscard),
  );

  banner.append(text, actions);
  return banner;
}

function bannerButton(
  locale: SupportedLocale,
  key: "setup.resume.continue" | "setup.resume.discard",
  dataKey: "resumeContinue" | "resumeDiscard",
  onClick: () => void,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className =
    dataKey === "resumeContinue" ? "primary-action" : "resume-banner-discard";
  button.dataset[dataKey] = "true";
  button.textContent = translate(locale, key);
  button.addEventListener("click", onClick);
  return button;
}
