import { VERSION as pixiVersion } from "pixi.js";

import "./diagnostic.css";

export interface BootstrapDiagnostic {
  heading: string;
  milestone: string;
  pixiVersion: string;
  legacyClientUrl: string;
}

export function createBootstrapDiagnostic(
  version = pixiVersion,
): BootstrapDiagnostic {
  return {
    heading: "Diving Simulator",
    milestone: "WP-02 dual-client bootstrap",
    pixiVersion: version,
    legacyClientUrl: "/src/diving-simulator.html",
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
  eyebrow.textContent = "Migration diagnostic";

  const heading = document.createElement("h1");
  heading.textContent = diagnostic.heading;

  const milestone = document.createElement("p");
  milestone.className = "diagnostic-milestone";
  milestone.textContent = diagnostic.milestone;

  const status = document.createElement("dl");
  status.className = "diagnostic-status";
  status.append(
    createStatusRow("TypeScript", "ready"),
    createStatusRow("Vite", "ready"),
    createStatusRow("PixiJS", `v${diagnostic.pixiVersion}`),
  );

  const legacyLink = document.createElement("a");
  legacyLink.className = "legacy-link";
  legacyLink.href = diagnostic.legacyClientUrl;
  legacyLink.textContent = "Open the legacy simulator";

  shell.append(eyebrow, heading, milestone, status, legacyLink);
  root.replaceChildren(shell);
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
}
