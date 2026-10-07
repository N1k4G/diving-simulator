// The game-over screen (#159), legacy's drawGameOver() as DOM.
//
// Legacy paints it onto the canvas and needed a hand-made scroll offset to be
// usable on a phone (#120, src/state.js). Here it is an ordinary document
// section: it scrolls like any page, its text wraps, and every line is real
// text a screen reader can reach. It is not a live region (#138). Focus
// moves to the heading instead, which is how a screen reader learns that the
// screen changed without the whole screen being read out at once.
import type { DiveFailureReason } from "../core/dive-state";
import { translate, type MessageKey, type SupportedLocale } from "./i18n/catalog";
import { formatDepth, formatDuration } from "./i18n/formatters";

export interface GameOverContent {
  readonly reason: DiveFailureReason;
  readonly elapsedTimeS: number;
  readonly maxDepthM: number;
  /** The site has no direct route to the surface (legacy `hasOverhead`). */
  readonly overhead: boolean;
}

export interface GameOverOptions {
  readonly locale: SupportedLocale;
  readonly content: GameOverContent;
  readonly onRetry: () => void;
}

/**
 * Legacy's cause label for each failure the model can produce. The three
 * rebreather causes are the labels game-loop.js assigns (S('ccrHypoxia') and
 * so on).
 */
const REASON_KEYS: Readonly<Record<DiveFailureReason, MessageKey>> = {
  "out-of-gas": "gameOver.reason.outOfGas",
  "oxygen-toxicity": "gameOver.reason.oxygenToxicity",
  hypoxia: "gameOver.reason.hypoxia",
  "decompression-sickness": "gameOver.reason.decompressionSickness",
  "pulmonary-barotrauma": "gameOver.reason.pulmonaryBarotrauma",
  "nitrogen-narcosis": "gameOver.reason.nitrogenNarcosis",
  "shark-attack": "gameOver.reason.sharkAttack",
  "ccr-hypoxia": "gameOver.reason.ccrHypoxia",
  "ccr-hyperoxia": "gameOver.reason.ccrHyperoxia",
  "ccr-co2": "gameOver.reason.ccrCo2",
};

interface ExplanationKeys {
  readonly cause: MessageKey;
  readonly medical: MessageKey;
  readonly prevention: readonly MessageKey[];
}

/**
 * Legacy's GAME_OVER_INFO, for the causes it has an entry for. The rebreather
 * causes have none in legacy either: their screen shows the label and the
 * dive summary, without the three explanation sections.
 */
const EXPLANATIONS: Partial<Record<DiveFailureReason, ExplanationKeys>> = {
  "out-of-gas": {
    cause: "gameOver.info.outOfGas.cause",
    medical: "gameOver.info.outOfGas.medical",
    prevention: [
      "gameOver.info.outOfGas.prevention1",
      "gameOver.info.outOfGas.prevention2",
      "gameOver.info.outOfGas.prevention3",
      "gameOver.info.outOfGas.prevention4",
    ],
  },
  "oxygen-toxicity": {
    cause: "gameOver.info.oxygenToxicity.cause",
    medical: "gameOver.info.oxygenToxicity.medical",
    prevention: [
      "gameOver.info.oxygenToxicity.prevention1",
      "gameOver.info.oxygenToxicity.prevention2",
      "gameOver.info.oxygenToxicity.prevention3",
      "gameOver.info.oxygenToxicity.prevention4",
    ],
  },
  hypoxia: {
    cause: "gameOver.info.hypoxia.cause",
    medical: "gameOver.info.hypoxia.medical",
    prevention: [
      "gameOver.info.hypoxia.prevention1",
      "gameOver.info.hypoxia.prevention2",
      "gameOver.info.hypoxia.prevention3",
      "gameOver.info.hypoxia.prevention4",
    ],
  },
  "decompression-sickness": {
    cause: "gameOver.info.decompressionSickness.cause",
    medical: "gameOver.info.decompressionSickness.medical",
    prevention: [
      "gameOver.info.decompressionSickness.prevention1",
      "gameOver.info.decompressionSickness.prevention2",
      "gameOver.info.decompressionSickness.prevention3",
      "gameOver.info.decompressionSickness.prevention4",
      "gameOver.info.decompressionSickness.prevention5",
    ],
  },
  "pulmonary-barotrauma": {
    cause: "gameOver.info.pulmonaryBarotrauma.cause",
    medical: "gameOver.info.pulmonaryBarotrauma.medical",
    prevention: [
      "gameOver.info.pulmonaryBarotrauma.prevention1",
      "gameOver.info.pulmonaryBarotrauma.prevention2",
      "gameOver.info.pulmonaryBarotrauma.prevention3",
      "gameOver.info.pulmonaryBarotrauma.prevention4",
    ],
  },
  "nitrogen-narcosis": {
    cause: "gameOver.info.nitrogenNarcosis.cause",
    medical: "gameOver.info.nitrogenNarcosis.medical",
    prevention: [
      "gameOver.info.nitrogenNarcosis.prevention1",
      "gameOver.info.nitrogenNarcosis.prevention2",
      "gameOver.info.nitrogenNarcosis.prevention3",
      "gameOver.info.nitrogenNarcosis.prevention4",
      "gameOver.info.nitrogenNarcosis.prevention5",
      "gameOver.info.nitrogenNarcosis.prevention6",
    ],
  },
  "shark-attack": {
    cause: "gameOver.info.sharkAttack.cause",
    medical: "gameOver.info.sharkAttack.medical",
    prevention: [
      "gameOver.info.sharkAttack.prevention1",
      "gameOver.info.sharkAttack.prevention2",
      "gameOver.info.sharkAttack.prevention3",
    ],
  },
};

/**
 * Mounts the screen into `root`, replacing what was there, and returns a
 * dispose function that detaches its keyboard listener.
 */
export function renderGameOverScreen(
  root: HTMLElement,
  options: Readonly<GameOverOptions>,
): () => void {
  const { locale, content, onRetry } = options;
  const t = (key: MessageKey) => translate(locale, key);

  const screen = document.createElement("section");
  screen.className = "result-screen game-over";
  screen.dataset.gameOver = content.reason;
  screen.setAttribute("aria-labelledby", "game-over-heading");

  const eyebrow = element("p", "result-eyebrow", t("gameOver.eyebrow"));
  const heading = element("h1", "result-heading", t("gameOver.heading"));
  heading.id = "game-over-heading";
  heading.tabIndex = -1;
  const reason = element("p", "game-over-reason", t(REASON_KEYS[content.reason]));
  reason.dataset.gameOverReason = "true";
  screen.append(eyebrow, heading, reason);

  const explanation = EXPLANATIONS[content.reason];
  if (explanation) {
    screen.append(
      section(t("gameOver.whatHappened"), element("p", "", t(explanation.cause))),
      section(t("gameOver.medical"), element("p", "", t(explanation.medical))),
    );
    const tips = document.createElement("ol");
    tips.className = "game-over-prevention";
    for (const key of explanation.prevention) {
      tips.append(element("li", "", t(key)));
    }
    screen.append(section(t("gameOver.howToAvoid"), tips));
  }

  if (content.overhead) {
    // Legacy draws this box for any overhead site, whatever the cause.
    const box = section(
      `${t("wreck.symbol.warning")} ${t("gameOver.overhead.heading")}`,
      element("p", "", t("gameOver.overhead.body")),
    );
    box.classList.add("game-over-overhead");
    screen.append(box);
  }

  const stats = document.createElement("dl");
  stats.className = "result-stats";
  for (const [label, value] of [
    [t("result.diveTime"), formatDuration(content.elapsedTimeS, locale)],
    [t("result.maxDepth"), formatDepth(content.maxDepthM, locale)],
  ] as const) {
    const row = document.createElement("div");
    row.append(element("dt", "", label), element("dd", "", value));
    stats.append(row);
  }
  screen.append(stats);

  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "primary-action";
  retry.dataset.retry = "true";
  retry.textContent = t("gameOver.retry");
  retry.setAttribute("aria-keyshortcuts", "Enter");
  const hint = element("p", "result-hint", t("gameOver.retryHint"));
  screen.append(retry, hint);

  root.replaceChildren(screen);
  heading.focus();

  let done = false;
  const finish = () => {
    if (done) {
      return;
    }
    done = true;
    onRetry();
  };
  retry.addEventListener("click", finish);
  // Enter anywhere starts again, as legacy's `keys['enter']` does on its
  // game-over screen. A focused button already turns Enter into a click, so
  // the key is left to it there rather than handled twice.
  const handleKey = (event: KeyboardEvent) => {
    if (event.key !== "Enter" || event.repeat || event.target === retry) {
      return;
    }
    event.preventDefault();
    finish();
  };
  document.addEventListener("keydown", handleKey);
  return () => document.removeEventListener("keydown", handleKey);
}

function section(title: string, body: HTMLElement): HTMLElement {
  const wrapper = document.createElement("section");
  wrapper.className = "result-section";
  wrapper.append(element("h2", "result-section-heading", title), body);
  return wrapper;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  node.textContent = text;
  return node;
}
