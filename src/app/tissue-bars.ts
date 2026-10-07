// The tissue-loading bars (#221), legacy's bar graph under the profile chart
// in drawPostDive(): one bar per compartment for the load the dive ended
// with, nitrogen at the bottom and helium on top, against a line for the
// compartment's M-value at the surface.
//
// Legacy paints them onto the canvas; here they are HTML boxes sized in
// percent, so they share out the screen's width however narrow the phone.
// To assistive technology the bars are one image, named by a sentence that
// says what they measure and which compartment leads.
import type { PostDiveSummary, PostDiveTissue } from "../presentation/post-dive-summary";
import { element, section } from "./game-over";
import { translate, type MessageKey, type SupportedLocale } from "./i18n/catalog";
import { formatPercent } from "./i18n/formatters";

/** Legacy's colours: danger above 90% of the M-value, caution above 70%. */
export type TissueTier = "ok" | "caution" | "danger";

export interface TissueBar {
  /** The compartment's number, from 1, as legacy labels it under the bar. */
  readonly compartment: number;
  readonly loading: number;
  readonly tier: TissueTier;
  /** The nitrogen and helium parts of the bar, as fractions of its full height. */
  readonly nitrogenHeight: number;
  readonly heliumHeight: number;
}

/**
 * Legacy's helium part is drawn only when it is over half a pixel of the
 * 100 px bar.
 */
const MIN_HELIUM_HEIGHT = 0.5 / 100;

/** Legacy's bars: full height at the M-value, and no taller past it. */
export function tissueBars(tissues: readonly PostDiveTissue[]): readonly TissueBar[] {
  return tissues.map((tissue, index) => {
    const height = Math.min(1, tissue.loading);
    const heliumHeight = height * (1 - tissue.nitrogenFraction);
    return {
      compartment: index + 1,
      loading: tissue.loading,
      tier: tissue.loading > 0.9 ? "danger" : tissue.loading > 0.7 ? "caution" : "ok",
      nitrogenHeight: height * tissue.nitrogenFraction,
      heliumHeight: heliumHeight > MIN_HELIUM_HEIGHT ? heliumHeight : 0,
    };
  });
}

/** The bars' section of the post-dive screen. */
export function renderTissueBars(summary: PostDiveSummary, locale: SupportedLocale): HTMLElement {
  const t = (key: MessageKey) => translate(locale, key);
  const bars = tissueBars(summary.tissues);
  const percent = (fraction: number) => `${(fraction * 100).toFixed(2)}%`;

  const plot = document.createElement("div");
  plot.className = "tissue-plot";
  plot.dataset.tissueChart = "true";
  plot.setAttribute("role", "img");
  plot.setAttribute("aria-label", altText(bars, locale));
  for (const bar of bars) {
    const column = document.createElement("div");
    column.className = "tissue-bar";
    column.dataset.compartment = String(bar.compartment);
    column.dataset.tier = bar.tier;
    // The track's top edge is legacy's M-value line.
    const track = document.createElement("span");
    track.className = "tissue-track";
    const helium = document.createElement("span");
    helium.className = "tissue-he";
    helium.style.height = percent(bar.heliumHeight);
    const nitrogen = document.createElement("span");
    nitrogen.className = "tissue-n2";
    nitrogen.style.height = percent(bar.nitrogenHeight);
    track.append(helium, nitrogen);
    column.append(track, element("span", "tissue-label", String(bar.compartment)));
    plot.append(column);
  }

  // Legacy's legend names the two gases; the M-value line is named too, as
  // nothing else on the screen says what it is.
  const legend = document.createElement("ul");
  legend.className = "tissue-legend";
  legend.setAttribute("aria-hidden", "true");
  for (const [className, key] of [
    ["tissue-key-n2", "postDive.tissues.key.nitrogen"],
    ["tissue-key-he", "postDive.tissues.key.helium"],
    ["tissue-key-m-value", "postDive.tissues.key.mValue"],
  ] as const) {
    legend.append(element("li", className, t(key)));
  }

  const wrapper = section(t("postDive.tissues"), plot);
  wrapper.classList.add("post-dive-tissues");
  wrapper.append(legend);
  return wrapper;
}

/** What the bars show, in a sentence: the measure and the leading compartment. */
function altText(bars: readonly TissueBar[], locale: SupportedLocale): string {
  let leading = bars[0];
  for (const bar of bars) {
    if (leading === undefined || bar.loading > leading.loading) leading = bar;
  }
  return translate(locale, "postDive.tissues.alt")
    .replace("{count}", String(bars.length))
    .replace("{n}", String(leading?.compartment ?? 0))
    .replace("{percent}", formatPercent(Math.max(0, leading?.loading ?? 0), locale));
}
