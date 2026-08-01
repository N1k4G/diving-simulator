import { VERSION as pixiVersion } from "pixi.js";

import { createInitialDiveState } from "../core/dive-state";
import {
  DEFAULT_PLANNER_SETTINGS,
  type PlannerForecast,
} from "../planner/dive-planner";
import "./diagnostic.css";
import {
  detectPreferredLocale,
  translate,
  type SupportedLocale,
} from "./i18n/catalog";
import { PlannerWorkerClient } from "./planner-worker-client";

declare global {
  interface Window {
    plannerWorkerDiagnostic?: Promise<PlannerForecast>;
  }
}

export interface BootstrapDiagnostic {
  heading: string;
  eyebrow: string;
  milestone: string;
  pixiVersion: string;
  legacyClientUrl: string;
  statusLabels: {
    typescript: string;
    vite: string;
    pixi: string;
    ready: string;
  };
  legacyLinkLabel: string;
}

export function createBootstrapDiagnostic(
  version = pixiVersion,
  locale: SupportedLocale = detectPreferredLocale(),
): BootstrapDiagnostic {
  return {
    heading: translate(locale, "diagnostic.heading"),
    eyebrow: translate(locale, "diagnostic.eyebrow"),
    milestone: translate(locale, "diagnostic.milestone"),
    pixiVersion: version,
    legacyClientUrl: "/src/diving-simulator.html",
    statusLabels: {
      typescript: translate(locale, "diagnostic.status.typescript"),
      vite: translate(locale, "diagnostic.status.vite"),
      pixi: translate(locale, "diagnostic.status.pixi"),
      ready: translate(locale, "diagnostic.status.ready"),
    },
    legacyLinkLabel: translate(locale, "diagnostic.legacyLink"),
  };
}

export function renderBootstrapDiagnostic(
  root: HTMLElement,
  diagnostic = createBootstrapDiagnostic(),
): void {
  const shell = document.createElement("section");
  shell.className = "diagnostic-shell";

  const eyebrow = document.createElement("p");
  eyebrow.className = "diagnostic-eyebrow";
  eyebrow.textContent = diagnostic.eyebrow;

  const heading = document.createElement("h1");
  heading.textContent = diagnostic.heading;

  const milestone = document.createElement("p");
  milestone.className = "diagnostic-milestone";
  milestone.textContent = diagnostic.milestone;

  const status = document.createElement("dl");
  status.className = "diagnostic-status";
  status.append(
    createStatusRow(
      diagnostic.statusLabels.typescript,
      diagnostic.statusLabels.ready,
    ),
    createStatusRow(diagnostic.statusLabels.vite, diagnostic.statusLabels.ready),
    createStatusRow(diagnostic.statusLabels.pixi, `v${diagnostic.pixiVersion}`),
  );

  const legacyLink = document.createElement("a");
  legacyLink.className = "legacy-link";
  legacyLink.href = diagnostic.legacyClientUrl;
  legacyLink.textContent = diagnostic.legacyLinkLabel;

  shell.append(eyebrow, heading, milestone, status, legacyLink);
  root.replaceChildren(shell);
}

export async function verifyPlannerWorker(
  client = new PlannerWorkerClient(),
): Promise<PlannerForecast> {
  try {
    return await client.forecast(
      createInitialDiveState(0),
      DEFAULT_PLANNER_SETTINGS,
    );
  } finally {
    client.dispose();
  }
}

function createStatusRow(label: string, value: string): HTMLDivElement {
  const row = document.createElement("div");
  const term = document.createElement("dt");
  const description = document.createElement("dd");

  term.textContent = label;
  description.textContent = value;
  row.append(term, description);
  return row;
}

if (typeof document !== "undefined") {
  const root = document.querySelector<HTMLElement>("#app");

  if (!root) {
    throw new Error("Bootstrap root #app was not found");
  }

  renderBootstrapDiagnostic(root);
  window.plannerWorkerDiagnostic = verifyPlannerWorker();
  void window.plannerWorkerDiagnostic.catch((error: unknown) => {
    console.error(error);
  });
}
