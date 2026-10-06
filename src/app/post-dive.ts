// The post-dive screen (#159), legacy's drawPostDive() as DOM.
//
// Built like the game-over screen: an ordinary document section that scrolls
// like any page (legacy needed a hand-made offset for that, #120), with focus
// moved to its heading rather than the whole screen read out from a live
// region (#138). Every value comes from the summary the presentation layer
// derives from the final dive state; this module only lays it out.
//
// A dive resumed from a save older than the grade's inputs (v1-v12) is graded
// on defaults for the history that save never held (#159 note on #215). The
// screen does not mark those categories: no shipped writer produces such a
// save, since the migration client is unreachable until #170.
import type { GradeScore } from "../core/dive-grade";
import type { DiveLogEntry, GasMix } from "../core/dive-state";
import type { PostDiveSummary } from "../presentation/post-dive-summary";
import { formatGradeNote, gradeLabel } from "./debrief-grade";
import { element, section } from "./game-over";
import { translate, type MessageKey, type SupportedLocale } from "./i18n/catalog";
import {
  formatAscentRate,
  formatDepth,
  formatDuration,
  formatPressure,
  formatVolume,
  formatWholeMinutes,
} from "./i18n/formatters";

export interface PostDiveOptions {
  readonly locale: SupportedLocale;
  readonly summary: PostDiveSummary;
  readonly onDiveAgain: () => void;
}

/**
 * Mounts the screen into `root`, replacing what was there, and returns a
 * dispose function that detaches its keyboard listener.
 */
export function renderPostDiveScreen(
  root: HTMLElement,
  options: Readonly<PostDiveOptions>,
): () => void {
  const { locale, summary, onDiveAgain } = options;
  const t = (key: MessageKey) => translate(locale, key);

  const screen = document.createElement("section");
  screen.className = "result-screen post-dive";
  screen.dataset.postDive = "true";
  screen.dataset.safetyStop = summary.safetyStop;
  screen.setAttribute("aria-labelledby", "post-dive-heading");

  const eyebrow = element("p", "result-eyebrow", t("postDive.eyebrow"));
  const heading = element("h1", "result-heading", t("postDive.heading"));
  heading.id = "post-dive-heading";
  heading.tabIndex = -1;
  screen.append(eyebrow, heading);

  // Legacy's stats card: dive time, max and average depth.
  const stats = document.createElement("dl");
  stats.className = "result-stats";
  for (const [label, value] of [
    [t("result.diveTime"), formatDuration(summary.elapsedTimeS, locale)],
    [t("result.maxDepth"), formatDepth(summary.maxDepthM, locale)],
    [t("result.avgDepth"), formatDepth(summary.averageDepthM, locale)],
  ] as const) {
    const row = document.createElement("div");
    row.append(element("dt", "", label), element("dd", "", value));
    stats.append(row);
  }
  screen.append(stats, gradeSection(summary, locale));

  screen.append(section(t("postDive.gas"), gasList(summary, locale)));

  // Legacy warns only for a stop that was needed and not done. The grade's
  // safety-stop row already says when it was done or not needed.
  if (summary.safetyStop === "skipped") {
    const box = section(
      `${t("wreck.symbol.warning")} ${t("postDive.safetySkipped.heading")}`,
      element("p", "", t("postDive.safetySkipped.body")),
    );
    box.classList.add("post-dive-safety-skipped");
    screen.append(box);
  }

  screen.append(violationSection(summary.violations, locale));

  const again = document.createElement("button");
  again.type = "button";
  again.className = "primary-action";
  again.dataset.diveAgain = "true";
  again.textContent = t("postDive.diveAgain");
  again.setAttribute("aria-keyshortcuts", "Enter");
  const hint = element("p", "result-hint", t("postDive.diveAgainHint"));
  screen.append(again, hint);

  root.replaceChildren(screen);
  heading.focus();

  let done = false;
  const finish = () => {
    if (done) {
      return;
    }
    done = true;
    onDiveAgain();
  };
  again.addEventListener("click", finish);
  // Enter anywhere dives again, as legacy's `keys['enter']` on its post-dive
  // screen; a focused button already turns Enter into a click.
  const handleKey = (event: KeyboardEvent) => {
    if (event.key !== "Enter" || event.repeat || event.target === again) {
      return;
    }
    event.preventDefault();
    finish();
  };
  document.addEventListener("keydown", handleKey);
  return () => document.removeEventListener("keydown", handleKey);
}

/** Legacy's debriefing card: stars, the overall score, five rows with notes. */
function gradeSection(summary: PostDiveSummary, locale: SupportedLocale): HTMLElement {
  const t = (key: MessageKey) => translate(locale, key);
  const { grade } = summary;

  const rating = document.createElement("p");
  rating.className = "post-dive-rating";
  const stars = element(
    "span",
    "post-dive-stars",
    [0, 1, 2].map((star) => t(star < grade.stars ? "postDive.star.filled" : "postDive.star.empty")).join(""),
  );
  stars.setAttribute("role", "img");
  stars.setAttribute("aria-label", t("postDive.stars").replace("{stars}", String(grade.stars)));
  stars.dataset.stars = String(grade.stars);
  const overall = element("span", "post-dive-overall", `${t("debrief.grade.rating")} `);
  const value = element("strong", "", String(grade.overall));
  value.dataset.overall = "true";
  overall.append(value);
  rating.append(stars, overall);

  const rows = document.createElement("ol");
  rows.className = "post-dive-scores";
  for (const score of grade.scores) {
    rows.append(scoreRow(score, locale));
  }

  const wrapper = section(t("postDive.debrief"), rating);
  wrapper.classList.add("post-dive-grade");
  wrapper.append(rows);
  return wrapper;
}

function scoreRow(score: GradeScore, locale: SupportedLocale): HTMLElement {
  const item = document.createElement("li");
  item.dataset.gradeCategory = score.category;
  // Legacy's colour tiers. The number beside the bar carries the same
  // meaning, so it never rests on the colour alone.
  item.dataset.tier = score.score >= 75 ? "ok" : score.score >= 50 ? "caution" : "danger";
  const head = document.createElement("div");
  head.className = "post-dive-score-head";
  head.append(
    element("span", "post-dive-score-label", gradeLabel(score.category, locale)),
    element("span", "post-dive-score-value", String(score.score)),
  );
  const bar = document.createElement("div");
  bar.className = "post-dive-score-bar";
  bar.setAttribute("aria-hidden", "true");
  const fill = document.createElement("span");
  fill.style.width = `${score.score}%`;
  bar.append(fill);
  item.append(head, bar, element("p", "post-dive-score-note", formatGradeNote(score.note, locale)));
  return item;
}

/**
 * The gas summary. Open circuit: each cylinder's gas used of its fill, as
 * legacy's "Tank n (mix): used / total". A rebreather: the oxygen and
 * diluent cylinders and the scrubber, and whether the dive ended on bailout.
 */
function gasList(summary: PostDiveSummary, locale: SupportedLocale): HTMLElement {
  const t = (key: MessageKey) => translate(locale, key);
  const litres = (value: number) => formatVolume(Math.max(0, Math.round(value)), locale);
  const list = document.createElement("dl");
  list.className = "post-dive-gas";
  const row = (label: string, value: string, key: string) => {
    const entry = document.createElement("div");
    entry.dataset.gas = key;
    entry.append(element("dt", "", label), element("dd", "", value));
    list.append(entry);
  };
  const { rebreather } = summary;
  if (rebreather) {
    const usedLeft = (usedL: number, leftBar: number) =>
      t("postDive.gas.usedLeft")
        .replace("{used}", litres(usedL))
        .replace("{left}", formatPressure(Math.max(0, Math.round(leftBar)), locale));
    row(t("postDive.gas.oxygen"), usedLeft(rebreather.oxygenUsedL, rebreather.oxygenLeftBar), "oxygen");
    row(t("postDive.gas.diluent"), usedLeft(rebreather.diluentUsedL, rebreather.diluentLeftBar), "diluent");
    row(
      t("postDive.gas.scrubber"),
      t("postDive.gas.scrubberUsed").replace("{time}", formatWholeMinutes(Math.max(0, rebreather.scrubberUsedS), locale)),
      "scrubber",
    );
  } else {
    for (const cylinder of summary.cylinders) {
      row(
        t("postDive.gas.cylinder")
          .replace("{n}", String(cylinder.index + 1))
          .replace("{gas}", mixLabel(cylinder.gas, locale)),
        t("postDive.gas.usedOf")
          .replace("{used}", litres(cylinder.usedL))
          .replace("{start}", litres(cylinder.startL)),
        `cylinder-${cylinder.index}`,
      );
    }
  }
  if (!rebreather?.onBailout) {
    return list;
  }
  const wrapper = document.createElement("div");
  const bailout = element(
    "p",
    "post-dive-bailout",
    `${t("wreck.symbol.warning")} ${t("postDive.gas.bailout")}`,
  );
  wrapper.append(list, bailout);
  return wrapper;
}

/** Legacy's gasLabel(): Air, EANxx, or Tx oxygen/helium in whole percent. */
function mixLabel(gas: Readonly<GasMix>, locale: SupportedLocale): string {
  const o2 = String(Math.round(gas.oxygenFraction * 100));
  if (gas.heliumFraction < 0.005) {
    return Math.abs(gas.oxygenFraction - 0.21) < 0.005
      ? translate(locale, "postDive.mix.air")
      : translate(locale, "postDive.mix.nitrox").replace("{o2}", o2);
  }
  return translate(locale, "postDive.mix.trimix")
    .replace("{o2}", o2)
    .replace("{he}", String(Math.round(gas.heliumFraction * 100)));
}

/**
 * The dive log's entries with their dive time. Legacy marks them only as
 * dots on its profile chart; as text they are reachable without the chart,
 * and they say what each dot is.
 */
function violationSection(
  violations: readonly Readonly<DiveLogEntry>[],
  locale: SupportedLocale,
): HTMLElement {
  const t = (key: MessageKey) => translate(locale, key);
  if (violations.length === 0) {
    const wrapper = section(
      t("postDive.violations"),
      element("p", "", t("postDive.violations.none")),
    );
    wrapper.classList.add("post-dive-violations");
    return wrapper;
  }
  const list = document.createElement("ol");
  list.className = "post-dive-violation-list";
  for (const entry of violations) {
    const item = document.createElement("li");
    item.dataset.violation = entry.kind;
    item.append(
      element("span", "post-dive-violation-time", formatDuration(entry.elapsedTimeS, locale)),
      " ",
      element("span", "", violationText(entry, locale)),
    );
    list.append(item);
  }
  const wrapper = section(t("postDive.violations"), list);
  wrapper.classList.add("post-dive-violations");
  return wrapper;
}

function violationText(entry: Readonly<DiveLogEntry>, locale: SupportedLocale): string {
  switch (entry.kind) {
    case "fast-ascent":
      return translate(locale, "postDive.violation.fastAscent")
        .replace("{rate}", formatAscentRate(entry.value, locale));
    case "ceiling-violation":
      return translate(locale, "postDive.violation.ceiling")
        .replace("{depth}", formatDepth(entry.value, locale));
    case "safety-stop-skipped":
      return translate(locale, "postDive.violation.safetyStopSkipped");
  }
}
