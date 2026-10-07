// The dive-profile chart (#159), legacy's drawDiveProfileChart(): depth over
// time, the decompression ceiling where there was one, and a marker for each
// entry of the dive log.
//
// Legacy paints all of it onto the canvas. Here the lines are an SVG that
// stretches to the screen's width, and the text — the axis labels and the
// marker numbers — is HTML laid over it, so it stays legible however narrow
// the phone. The plot is one image to assistive technology, named by a
// sentence that says what it shows; the markers carry the numbers of the
// violations list beside it, so the list is the chart's text equivalent.
import type { DiveLogEntry } from "../core/dive-state";
import type { PostDiveSummary } from "../presentation/post-dive-summary";
import { element, section } from "./game-over";
import { translate, type MessageKey, type SupportedLocale } from "./i18n/catalog";
import { formatDepth, formatDuration } from "./i18n/formatters";

/** Legacy's grid: a line every 10 m. */
const GRID_STEP_M = 10;
/** Legacy draws a skipped safety stop at the end of the dive, at 5 m. */
const SKIPPED_STOP_MARKER_DEPTH_M = 5;
/** The SVG's own coordinates; it is stretched to the plot's box. */
const VIEW_W = 1000;
const VIEW_H = 400;

export interface ProfileMarker {
  /** The entry's place in the violations list, from 1. */
  readonly number: number;
  readonly kind: DiveLogEntry["kind"];
  /** Position in the plot, as fractions of its width and height. */
  readonly x: number;
  readonly y: number;
}

export interface ProfileChartGeometry {
  /** Legacy's scales: the deepest sample (at least 1 m) and the dive time (at least a minute). */
  readonly maxDepthM: number;
  readonly maxTimeS: number;
  readonly gridDepthsM: readonly number[];
  /** The depth line, as fractions of the plot. */
  readonly depth: readonly (readonly [number, number])[];
  /** The ceiling, one run per stretch of the dive that had one. */
  readonly ceiling: readonly (readonly (readonly [number, number])[])[];
  readonly deepestCeilingM: number;
  readonly markers: readonly ProfileMarker[];
}

/**
 * Legacy's scales and marks for the profile, or null when there are fewer
 * than two samples, where legacy draws no chart.
 */
export function profileChartGeometry(summary: PostDiveSummary): ProfileChartGeometry | null {
  const { profile, violations } = summary;
  if (profile.length < 2) {
    return null;
  }
  let maxDepthM = 0;
  for (const sample of profile) {
    if (sample.depthM > maxDepthM) maxDepthM = sample.depthM;
  }
  maxDepthM = Math.max(1, maxDepthM);
  const maxTimeS = Math.max(60, summary.elapsedTimeS);
  const at = (timeS: number, depthM: number) => [timeS / maxTimeS, depthM / maxDepthM] as const;

  const gridDepthsM: number[] = [];
  for (let depthM = GRID_STEP_M; depthM < maxDepthM; depthM += GRID_STEP_M) gridDepthsM.push(depthM);

  const ceiling: (readonly [number, number])[][] = [];
  let run: (readonly [number, number])[] | null = null;
  let deepestCeilingM = 0;
  for (const sample of profile) {
    if (sample.ceilingM > 0) {
      if (!run) ceiling.push((run = []));
      run.push(at(sample.elapsedTimeS, sample.ceilingM));
      deepestCeilingM = Math.max(deepestCeilingM, sample.ceilingM);
    } else {
      run = null;
    }
  }

  // Each entry sits on the profile at the sample nearest its time; the
  // skipped stop has no "where", so legacy puts it at the end, at 5 m.
  const last = profile[profile.length - 1]!;
  const markers = violations.map((entry, index) => {
    if (entry.kind === "safety-stop-skipped") {
      const [x, y] = at(last.elapsedTimeS, SKIPPED_STOP_MARKER_DEPTH_M);
      return { number: index + 1, kind: entry.kind, x, y };
    }
    let nearest = profile[0]!;
    for (const sample of profile) {
      if (Math.abs(sample.elapsedTimeS - entry.elapsedTimeS) < Math.abs(nearest.elapsedTimeS - entry.elapsedTimeS)) {
        nearest = sample;
      }
    }
    const [x, y] = at(entry.elapsedTimeS, nearest.depthM);
    return { number: index + 1, kind: entry.kind, x, y };
  });

  return {
    maxDepthM,
    maxTimeS,
    gridDepthsM,
    depth: profile.map((sample) => at(sample.elapsedTimeS, sample.depthM)),
    ceiling,
    deepestCeilingM,
    markers,
  };
}

const SVG = "http://www.w3.org/2000/svg";

/** The chart's section of the post-dive screen, or null when legacy draws none. */
export function renderProfileChart(summary: PostDiveSummary, locale: SupportedLocale): HTMLElement | null {
  const geometry = profileChartGeometry(summary);
  if (!geometry) {
    return null;
  }
  const t = (key: MessageKey) => translate(locale, key);
  const points = (line: readonly (readonly [number, number])[]) =>
    line.map(([x, y]) => `${(x * VIEW_W).toFixed(1)},${(y * VIEW_H).toFixed(1)}`).join(" ");

  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", `0 0 ${VIEW_W} ${VIEW_H}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const depthM of geometry.gridDepthsM) {
    const y = ((depthM / geometry.maxDepthM) * VIEW_H).toFixed(1);
    svg.append(svgElement("path", "profile-grid", { d: `M0 ${y}H${VIEW_W}` }));
  }
  svg.append(svgElement("polyline", "profile-depth", { points: points(geometry.depth) }));
  for (const run of geometry.ceiling) {
    svg.append(svgElement("polyline", "profile-ceiling", { points: points(run) }));
  }

  const plot = document.createElement("div");
  plot.className = "profile-plot";
  plot.dataset.profileChart = "true";
  plot.setAttribute("role", "img");
  plot.setAttribute("aria-label", altText(geometry, summary, locale));
  // Lines and markers inside the frame, as legacy's 4 px padding keeps them.
  const area = document.createElement("div");
  area.className = "profile-area";
  area.append(svg);
  plot.append(area);
  for (const [className, text] of [
    ["profile-axis profile-axis-top", formatDepth(0, locale)],
    ["profile-axis profile-axis-depth", formatDepth(Math.round(geometry.maxDepthM), locale)],
    ["profile-axis profile-axis-time", formatDuration(geometry.maxTimeS, locale)],
  ] as const) {
    plot.append(element("span", className, text));
  }
  for (const marker of geometry.markers) {
    const dot = element("span", "profile-marker", String(marker.number));
    dot.dataset.marker = marker.kind;
    dot.style.left = `${(marker.x * 100).toFixed(2)}%`;
    dot.style.top = `${(marker.y * 100).toFixed(2)}%`;
    area.append(dot);
  }

  const legend = document.createElement("ul");
  legend.className = "profile-legend";
  legend.setAttribute("aria-hidden", "true");
  for (const [className, key] of [
    ["profile-key-depth", "postDive.profile.key.depth"],
    ["profile-key-ceiling", "postDive.profile.key.ceiling"],
    ["profile-key-marker", "postDive.profile.key.marker"],
  ] as const) {
    legend.append(element("li", className, t(key)));
  }

  const wrapper = section(t("postDive.profile"), plot);
  wrapper.classList.add("post-dive-profile");
  wrapper.append(legend);
  return wrapper;
}

/** What the chart shows, in a sentence, for assistive technology. */
function altText(geometry: ProfileChartGeometry, summary: PostDiveSummary, locale: SupportedLocale): string {
  const text = translate(locale, "postDive.profile.alt")
    .replace("{time}", formatDuration(summary.elapsedTimeS, locale))
    .replace("{depth}", formatDepth(geometry.maxDepthM, locale));
  const ceiling = geometry.deepestCeilingM > 0
    ? translate(locale, "postDive.profile.alt.ceiling").replace("{depth}", formatDepth(geometry.deepestCeilingM, locale))
    : translate(locale, "postDive.profile.alt.noCeiling");
  const count = geometry.markers.length;
  const markers = count === 0
    ? ""
    : count === 1
      ? translate(locale, "postDive.profile.alt.marker")
      : translate(locale, "postDive.profile.alt.markers").replace("{count}", String(count));
  return [text, ceiling, markers].filter(Boolean).join(" ");
}

function svgElement(
  tag: "path" | "polyline",
  className: string,
  attributes: Readonly<Record<string, string>>,
): SVGElement {
  const node = document.createElementNS(SVG, tag);
  node.setAttribute("class", className);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
}
