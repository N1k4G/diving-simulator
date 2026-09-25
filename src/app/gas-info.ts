// The gas-information overlay (#163): legacy's `I` pages, as DOM.
//
// src/renderer.js drawDiveComputer replaces the dive computer's boxes with a
// page while infoPageMode > 0. Here the page is a panel beside the HUD, so
// the depth, time and NDL stay visible while it is open. The panel is a
// labelled region, not a dialog: the dive keeps running, nothing is modal,
// and focus stays where it was.
import type { PlannerSettings } from "../planner/dive-planner";
import type {
  PresentationState,
  PresentationTank,
} from "../presentation/presentation-state";
import { translate, type MessageKey, type SupportedLocale } from "./i18n/catalog";
import {
  formatDepth,
  formatGasFraction,
  formatPartialPressure,
  formatPercent,
  formatPressure,
  formatVolume,
  formatWholeMinutes,
} from "./i18n/formatters";
import {
  cylinderIndicesForPage,
  cylinderSeverity,
  displayedNdlMinutes,
  gradientFactorSeverity,
  mValueRatioSeverity,
  ndlSeverity,
  po2Severity,
  scrubberSeverity,
  type GasInfoPage,
  type Severity,
} from "./gas-info-pages";
import { selectLoopRowDanger } from "./loop-danger";

export interface GasInfoElements {
  readonly panel: HTMLElement;
  readonly heading: HTMLElement;
  readonly body: HTMLElement;
  readonly toggle: HTMLButtonElement;
}

const PANEL_ID = "wreck-gas-info";

export function createGasInfo(locale: SupportedLocale): GasInfoElements {
  const panel = document.createElement("section");
  panel.className = "gas-info";
  panel.id = PANEL_ID;
  panel.dataset.gasInfo = "true";
  panel.hidden = true;
  panel.setAttribute("aria-labelledby", `${PANEL_ID}-heading`);
  const heading = document.createElement("h2");
  heading.id = `${PANEL_ID}-heading`;
  heading.className = "gas-info-heading";
  const body = document.createElement("div");
  body.className = "gas-info-body";
  panel.append(heading, body);

  // The I key's button. Hidden where I means nothing (a recreational or a
  // failed dive), as legacy hides touch-gas-info outside tec and CCR.
  const toggle = document.createElement("button");
  toggle.type = "button";
  // Its own class: the mute button is located by .audio-control, and the
  // two share only the size rule in the stylesheet.
  toggle.className = "gas-info-control";
  toggle.dataset.gasInfoToggle = "true";
  toggle.hidden = true;
  toggle.setAttribute("aria-label", translate(locale, "wreck.gasInfo.open"));
  toggle.setAttribute("aria-keyshortcuts", "I");
  toggle.setAttribute("aria-controls", PANEL_ID);
  toggle.setAttribute("aria-expanded", "false");
  toggle.textContent = translate(locale, "wreck.symbol.gasInfo");
  return { panel, heading, body, toggle };
}

interface Row {
  readonly label: string;
  readonly value: string;
  readonly severity?: Severity;
}

type Block =
  | { readonly kind: "rows"; readonly title?: string; readonly active?: boolean; readonly rows: readonly Row[] }
  | { readonly kind: "tissues"; readonly caption: string; readonly bars: readonly TissueBar[] };

interface TissueBar {
  readonly ratio: number;
  readonly label: string;
  readonly severity: Severity;
  readonly marker: string;
}

/**
 * Brings the panel in line with the page and the dive state. Rebuilds the
 * body only when what it would show has changed: the tissues move every
 * step, so that is about once a second, and the body holds nothing
 * focusable that a rebuild could throw away.
 */
export function syncGasInfo(
  elements: GasInfoElements,
  page: GasInfoPage | null,
  available: boolean,
  presentation: Readonly<PresentationState>,
  settings: Readonly<PlannerSettings>,
  locale: SupportedLocale,
): void {
  elements.toggle.hidden = !available;
  elements.toggle.setAttribute("aria-expanded", String(page !== null));
  elements.panel.hidden = page === null;
  if (page === null) {
    return;
  }

  const heading = `${translate(locale, "wreck.gasInfo.heading")} · ${pageTitle(page, presentation, locale)}`;
  if (elements.heading.textContent !== heading) {
    elements.heading.textContent = heading;
  }
  elements.panel.dataset.page = page;

  const blocks = buildBlocks(page, presentation, settings, locale);
  const key = JSON.stringify(blocks);
  if (elements.body.dataset.renderKey === key) {
    return;
  }
  elements.body.dataset.renderKey = key;
  elements.body.replaceChildren(...blocks.map((block) => renderBlock(block, locale)));
}

function pageTitle(
  page: GasInfoPage,
  presentation: Readonly<PresentationState>,
  locale: SupportedLocale,
): string {
  switch (page) {
    case "cylinders-1":
    case "cylinders-2": {
      const indices = cylinderIndicesForPage(page, presentation.tanks.length);
      return translate(locale, "wreck.gasInfo.page.cylinders")
        .replace("{from}", String((indices[0] ?? 0) + 1))
        .replace("{to}", String((indices.at(-1) ?? 0) + 1));
    }
    case "tissues":
      return translate(locale, "wreck.gasInfo.page.tissues");
    case "deco":
      return translate(locale, "wreck.gasInfo.page.deco");
    case "loop":
      return translate(locale, "wreck.gasInfo.page.loop");
  }
}

function buildBlocks(
  page: GasInfoPage,
  presentation: Readonly<PresentationState>,
  settings: Readonly<PlannerSettings>,
  locale: SupportedLocale,
): readonly Block[] {
  const t = (key: MessageKey) => translate(locale, key);
  const unavailable = t("wreck.value.unavailable");
  switch (page) {
    case "cylinders-1":
    case "cylinders-2":
      return cylinderIndicesForPage(page, presentation.tanks.length)
        .map((index) => presentation.tanks[index])
        .filter((tank): tank is PresentationTank => tank !== undefined)
        .map((tank) => cylinderBlock(tank, locale));
    case "tissues":
      return [
        {
          kind: "tissues",
          caption: t("wreck.gasInfo.tissues.caption"),
          bars: presentation.saturation.mValueRatios.map((ratio, index) => ({
            // Legacy clamps the bar to 0..1.2 and colours it danger at 1.0.
            ratio: Math.max(0, Math.min(1.2, ratio)),
            severity: mValueRatioSeverity(ratio),
            label: t("wreck.gasInfo.tissues.compartment")
              .replace("{n}", String(index + 1))
              .replace("{ratio}", formatPercent(Math.max(0, ratio), locale)),
            // Legacy labels compartments 1, 4, 8, 12 and 16 under the bars.
            marker: [0, 3, 7, 11, 15].includes(index) ? String(index + 1) : "",
          })),
        },
      ];
    case "deco": {
      // PARTIAL. Legacy's page 4 also shows CNS %, rounded, caution at 50,
      // danger at 80. The migration model does not track CNS yet, so there
      // is no authoritative value to show. The row is left out rather than
      // filled with a placeholder, and lands with #186.
      const { planner, saturation } = presentation;
      const po2 = presentation.breathingPo2Bar;
      return [
        {
          kind: "rows",
          rows: [
            {
              label: t("wreck.gasInfo.deco.gf99"),
              value: formatPercent(saturation.gf99Percent / 100, locale),
              severity: gradientFactorSeverity(saturation.gf99Percent),
            },
            {
              label: t("wreck.gasInfo.deco.surfaceGf"),
              value: formatPercent(saturation.surfaceGfPercent / 100, locale),
              severity: gradientFactorSeverity(saturation.surfaceGfPercent),
            },
            {
              label: t("wreck.gasInfo.deco.ceiling"),
              value: planner ? formatDepth(planner.ceilingM, locale) : unavailable,
              // Legacy draws a ceiling above the surface in its warn tone.
              severity: planner && planner.ceilingM > 0 ? "warning" : "normal",
            },
            {
              label: t("wreck.gasInfo.deco.gfLow"),
              value: formatPercent(settings.gfLowPercent / 100, locale),
            },
            {
              label: t("wreck.gasInfo.deco.gfHigh"),
              value: formatPercent(settings.gfHighPercent / 100, locale),
            },
            {
              label: t("wreck.gasInfo.deco.tts"),
              value: planner ? formatWholeMinutes(planner.ttsMin * 60, locale) : unavailable,
              severity: planner && planner.ttsMin > 0 ? "warning" : "normal",
            },
            {
              label: t("wreck.gasInfo.deco.ndl"),
              value: ndlText(planner?.ndlMin ?? null, locale, unavailable),
              severity:
                planner && displayedNdlMinutes(planner.ndlMin) !== null
                  ? ndlSeverity(planner.ndlMin)
                  : "normal",
            },
            {
              label: t("wreck.gasInfo.deco.po2"),
              value: formatPartialPressure(po2, locale),
              severity: po2Severity(po2),
            },
          ],
        },
      ];
    }
    case "loop": {
      const { ccr } = presentation;
      if (!ccr) {
        return [];
      }
      const danger = selectLoopRowDanger(ccr);
      return [
        {
          kind: "rows",
          rows: [
            { label: t("wreck.hud.setpoint"), value: formatPartialPressure(ccr.targetPo2Bar, locale) },
            {
              label: t("wreck.hud.loopPo2"),
              value: formatPartialPressure(ccr.actualPo2Bar, locale),
              // Legacy's page uses po2Color's bands for this row, danger
              // outside 0.16..1.6, not the HUD row's 0.18.
              severity: po2Severity(ccr.actualPo2Bar),
            },
            {
              label: t("wreck.gasInfo.loop.mode"),
              value: t(ccr.onBailout ? "wreck.gasInfo.loop.onBailout" : "wreck.gasInfo.loop.onLoop"),
              // Legacy draws BAIL in its danger tone.
              severity: ccr.onBailout ? "danger" : "normal",
            },
            {
              label: t("wreck.hud.oxygenCylinder"),
              value: formatPressure(Math.round(ccr.oxygenCylinderPressureBar), locale),
              severity: danger.oxygenCylinder ? "danger" : "normal",
            },
            {
              label: t("wreck.gasInfo.loop.oxygenVolume"),
              value: formatVolume(ccr.oxygenCylinderVolumeL, locale),
            },
            {
              label: t("wreck.hud.diluentCylinder"),
              value: formatPressure(Math.round(ccr.diluentCylinderPressureBar), locale),
              severity: danger.diluentCylinder ? "danger" : "normal",
            },
            {
              label: t("wreck.gasInfo.loop.diluentVolume"),
              value: formatVolume(ccr.diluentCylinderVolumeL, locale),
            },
            { label: t("wreck.gasInfo.loop.diluentMix"), value: mixText(ccr.diluent, locale) },
            {
              label: t("wreck.hud.scrubber"),
              value: formatWholeMinutes(ccr.scrubberRemainingS, locale),
              severity: scrubberSeverity(Math.round(ccr.scrubberRemainingS / 60)),
            },
          ],
        },
      ];
    }
  }
}

function cylinderBlock(tank: PresentationTank, locale: SupportedLocale): Block {
  const t = (key: MessageKey) => translate(locale, key);
  const pressureBar = Math.round(tank.pressureBar);
  return {
    kind: "rows",
    title: t("wreck.gasInfo.cylinder.title").replace("{n}", String(tank.index + 1)),
    active: tank.active,
    rows: [
      { label: t("wreck.gasInfo.cylinder.mix"), value: mixText(tank.gas, locale) },
      {
        label: t("wreck.gasInfo.cylinder.pressure"),
        value: formatPressure(pressureBar, locale),
        severity: cylinderSeverity(pressureBar),
      },
      {
        label: t("wreck.gasInfo.cylinder.mod"),
        value:
          tank.modM === null
            ? t("wreck.value.unavailable")
            : formatDepth(tank.modM, locale),
      },
    ],
  };
}

function ndlText(
  ndlMin: number | null,
  locale: SupportedLocale,
  unavailable: string,
): string {
  const shown = ndlMin === null ? null : displayedNdlMinutes(ndlMin);
  return shown === null ? unavailable : formatWholeMinutes(shown * 60, locale);
}

/**
 * The value as displayed: the ⚠ prefix for danger, as legacy's
 * hudDangerPrefix(); for caution and warning a hidden word, so assistive
 * technology hears what the tint shows.
 */
function appendValue(
  target: HTMLElement,
  text: string,
  severity: Severity,
  locale: SupportedLocale,
): void {
  if (severity === "normal") {
    target.textContent = text;
    return;
  }
  target.dataset.severity = severity;
  if (severity === "danger") {
    target.textContent = `${translate(locale, "wreck.symbol.warning")} ${text}`;
    return;
  }
  const word = document.createElement("span");
  word.className = "visually-hidden";
  word.textContent = translate(
    locale,
    severity === "warning"
      ? "wreck.gasInfo.severity.warning"
      : "wreck.gasInfo.severity.caution",
  );
  target.append(document.createTextNode(text), word);
}

function mixText(
  gas: { readonly oxygenFraction: number; readonly heliumFraction: number },
  locale: SupportedLocale,
): string {
  return translate(locale, "wreck.gasInfo.cylinder.mixValue")
    .replace("{o2}", formatGasFraction(gas.oxygenFraction, locale))
    .replace("{he}", formatGasFraction(gas.heliumFraction, locale));
}

function renderBlock(block: Block, locale: SupportedLocale): HTMLElement {
  const warning = translate(locale, "wreck.symbol.warning");
  if (block.kind === "tissues") {
    const wrapper = document.createElement("div");
    wrapper.className = "gas-info-tissues";
    const caption = document.createElement("p");
    caption.className = "gas-info-caption";
    caption.textContent = block.caption;
    const list = document.createElement("ol");
    list.className = "gas-info-bars";
    for (const bar of block.bars) {
      const item = document.createElement("li");
      if (bar.severity !== "normal") {
        item.dataset.severity = bar.severity;
      }
      item.style.setProperty("--ratio", String(bar.ratio / 1.2));
      const fill = document.createElement("span");
      fill.className = "gas-info-bar";
      fill.setAttribute("aria-hidden", "true");
      const marker = document.createElement("span");
      marker.className = "gas-info-bar-marker";
      marker.setAttribute("aria-hidden", "true");
      marker.textContent = bar.marker;
      // The bar's meaning in words, for AT and for anyone who cannot read
      // the colour; ⚠ on a compartment past its M-value.
      const text = document.createElement("span");
      text.className = "visually-hidden";
      text.textContent =
        bar.severity === "danger" ? `${warning} ${bar.label}` : bar.label;
      item.append(fill, marker, text);
      list.append(item);
    }
    wrapper.append(caption, list);
    return wrapper;
  }

  const wrapper = document.createElement("div");
  wrapper.className = "gas-info-block";
  if (block.active) {
    wrapper.dataset.active = "true";
  }
  if (block.title) {
    const title = document.createElement("h3");
    title.className = "gas-info-block-title";
    title.textContent = block.active
      ? `${block.title} · ${translate(locale, "wreck.gasInfo.cylinder.active")}`
      : block.title;
    wrapper.append(title);
  }
  const list = document.createElement("dl");
  for (const row of block.rows) {
    const group = document.createElement("div");
    const term = document.createElement("dt");
    term.textContent = row.label;
    const value = document.createElement("dd");
    appendValue(value, row.value, row.severity ?? "normal", locale);
    group.append(term, value);
    list.append(group);
  }
  wrapper.append(list);
  return wrapper;
}
