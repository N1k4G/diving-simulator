// The help overlay (#160): legacy's H / ? overlay (src/state.js showHtmlHelp)
// as a modal dialog over the stage.
//
// - H, ? and Escape close it, as legacy's keydown handler; so do its Close
//   button and a tap outside it.
// - While open it takes the keyboard: no key but Escape reaches the dive or
//   the screen behind it (docs/decisions.md, deliberate departures). Escape
//   still reaches the gas information, which legacy's Escape closes too.
// - It scrolls on its own and never the screen behind it, the case #120
//   fixed in legacy (overscroll-behavior in the stylesheet).
// - It is announced once, as a dialog named by its heading when focus moves
//   into it; nothing in it is a live region (#138).
import { translate, type MessageKey, type SupportedLocale } from "./i18n/catalog";
import { helpSections, type HelpContext, type HelpRow } from "./help-content";

export interface HelpOverlayOptions {
  readonly locale: SupportedLocale;
  /** What the overlay describes, read when it opens. */
  readonly context: () => HelpContext;
  readonly onOpen?: (context: Readonly<HelpContext>) => void;
  readonly onClose?: () => void;
}

export interface HelpOverlay {
  open(): void;
  /** Closes it without onClose, and removes it and its key. */
  destroy(): void;
}

/** H or ?, unmodified but for Shift, which ? takes on most layouts. */
function isHelpKey(event: KeyboardEvent): boolean {
  return !event.ctrlKey && !event.metaKey && !event.altKey && ["h", "H", "?"].includes(event.key);
}

/** Legacy's touch-dive-help. `compact` shows the ? alone and names it in its label. */
export function createHelpButton(locale: SupportedLocale, className: string, compact: boolean): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.dataset.helpOpen = "true";
  button.setAttribute("aria-haspopup", "dialog");
  button.setAttribute("aria-keyshortcuts", "H");
  button.textContent = translate(locale, compact ? "help.symbol" : "help.open");
  if (compact) {
    button.setAttribute("aria-label", translate(locale, "help.open"));
  }
  return button;
}

/** Builds the overlay into the document and binds H and ? to open it. */
export function createHelpOverlay(options: Readonly<HelpOverlayOptions>): HelpOverlay {
  const t = (key: MessageKey) => translate(options.locale, key);
  const dialog = document.createElement("dialog");
  dialog.className = "help-overlay";
  dialog.dataset.helpOverlay = "true";
  dialog.setAttribute("aria-labelledby", "help-heading");
  const header = document.createElement("div");
  header.className = "help-header";
  const heading = document.createElement("h2");
  heading.id = "help-heading";
  heading.textContent = t("help.heading");
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "help-close";
  closeButton.dataset.helpClose = "true";
  closeButton.textContent = t("help.close");
  header.append(heading, closeButton);
  const body = document.createElement("div");
  dialog.append(header, body);
  document.body.append(dialog);

  let open = false;
  let returnFocus: HTMLElement | null = null;

  const close = (notify: boolean) => {
    if (!open) {
      return;
    }
    open = false;
    window.removeEventListener("keydown", takeKey, true);
    window.removeEventListener("keyup", takeKey, true);
    dialog.close();
    if (notify) {
      options.onClose?.();
    }
    if (returnFocus?.isConnected) {
      returnFocus.focus();
    }
    returnFocus = null;
  };

  // In the window's capture phase, before every other key handler of the
  // page. stopPropagation() keeps the key from the dive and the screens; its
  // default action is left alone, so Tab moves focus, Enter presses the
  // focused button and the arrows, Page Up/Down and Space scroll the dialog.
  function takeKey(event: KeyboardEvent): void {
    if (event.type === "keydown" && event.key === "Escape") {
      event.preventDefault();
      close(true);
      return;
    }
    event.stopPropagation();
    if (event.type === "keydown" && isHelpKey(event) && !event.repeat) {
      event.preventDefault();
      close(true);
    }
  }

  const show = () => {
    if (open || !dialog.isConnected) {
      return;
    }
    const context = options.context();
    body.replaceChildren(...buildBody(context, t));
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    open = true;
    window.addEventListener("keydown", takeKey, true);
    window.addEventListener("keyup", takeKey, true);
    options.onOpen?.(context);
    dialog.showModal();
    dialog.scrollTop = 0;
    closeButton.focus();
  };

  closeButton.addEventListener("click", () => close(true));
  // A press on the backdrop is a click on the dialog itself, outside its box.
  dialog.addEventListener("click", (event) => {
    const box = dialog.getBoundingClientRect();
    const outside =
      event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
    if (event.target === dialog && outside) {
      close(true);
    }
  });
  // A close request that is not a key, such as Android's back gesture.
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close(true);
  });
  const openOnKey = (event: KeyboardEvent) => {
    if (!open && !event.repeat && isHelpKey(event)) {
      event.preventDefault();
      show();
    }
  };
  window.addEventListener("keydown", openOnKey);

  return {
    open: show,
    destroy: () => {
      close(false);
      window.removeEventListener("keydown", openOnKey);
      dialog.remove();
    },
  };
}

function buildBody(context: Readonly<HelpContext>, t: (key: MessageKey) => string): HTMLElement[] {
  const nodes = [paragraph("help-hint", t("help.closeHint"))];
  if (context.state === "diving") {
    nodes.push(paragraph("help-hint help-paused", t("help.paused")));
  }
  const text = (row: HelpRow, key: MessageKey) =>
    row.count === undefined ? t(key) : t(key).replace("{n}", String(row.count));
  for (const section of helpSections(context)) {
    const title = document.createElement("h3");
    title.textContent = t(section.headingKey);
    const table = document.createElement("table");
    table.className = "help-table";
    const head = table.createTHead().insertRow();
    for (const key of ["help.column.keys", "help.column.touch", "help.column.action"] as const) {
      const cell = document.createElement("th");
      cell.scope = "col";
      cell.textContent = t(key);
      head.append(cell);
    }
    const rows = table.createTBody();
    for (const row of section.rows) {
      const line = rows.insertRow();
      line.dataset.helpRow = row.action;
      const keys = document.createElement("th");
      keys.scope = "row";
      keys.textContent = text(row, row.keys);
      line.append(keys);
      line.insertCell().textContent = text(row, row.touch);
      line.insertCell().textContent = t(row.action);
    }
    nodes.push(title, table);
  }
  // Legacy's warning from its controls paragraph, under the controls it is about.
  nodes.push(paragraph("help-safety", `${t("wreck.symbol.warning")} ${t("help.buoyancy")}`));
  return nodes;
}

function paragraph(className: string, text: string): HTMLElement {
  const node = document.createElement("p");
  node.className = className;
  node.textContent = text;
  return node;
}
