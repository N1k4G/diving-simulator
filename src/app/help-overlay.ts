// The help overlay (#160): legacy's H / ? overlay (src/state.js
// showHtmlHelp, #html-help-overlay) as a modal dialog over the stage.
//
// - H, ? and Escape close it, as legacy's keydown handler does; so do its
//   Close button and a tap outside it.
// - It takes the keyboard while open. Legacy's keys went on reaching its
//   game loop behind the overlay (keys[] is set whatever is shown), so S at
//   the surface began the dive behind it and Enter on the debriefing waited
//   for it to close; here no key reaches the dive or the screen until it is
//   closed (docs/decisions.md, deliberate departures). Escape still reaches
//   the gas information, which legacy's Escape closes in the same press.
// - It scrolls on its own and never the screen behind it, the case #120
//   fixed in legacy, where the window's wheel handler scrolled the result
//   screen under the open overlay.
// - It is announced once, as a dialog named by its heading when focus moves
//   into it, and built once per opening; nothing in it is a live region
//   (#138).
import { translate, type SupportedLocale } from "./i18n/catalog";
import { helpSections, type HelpContext, type HelpRow } from "./help-content";

export interface HelpOverlayOptions {
  readonly locale: SupportedLocale;
  /** What the overlay describes, read when it opens. */
  readonly context: () => HelpContext;
  readonly onOpen?: (context: Readonly<HelpContext>) => void;
  readonly onClose?: () => void;
}

export interface HelpOverlay {
  readonly dialog: HTMLDialogElement;
  readonly isOpen: boolean;
  open(): void;
  close(): void;
  /** Closes the overlay without its onClose, and removes it and its key. */
  destroy(): void;
}

/** H or ?, unmodified but for Shift, which ? takes on most layouts. */
export function isHelpKey(event: KeyboardEvent): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey) {
    return false;
  }
  return event.key === "h" || event.key === "H" || event.key === "?";
}

/**
 * The button that opens the overlay, with H as its key: legacy's
 * touch-dive-help. `compact` shows the ? alone and names it in its label,
 * for the round buttons of the dive's topbar.
 */
export function createHelpButton(
  locale: SupportedLocale,
  className: string,
  compact: boolean,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.dataset.helpOpen = "true";
  button.setAttribute("aria-haspopup", "dialog");
  button.setAttribute("aria-keyshortcuts", "H");
  if (compact) {
    button.setAttribute("aria-label", translate(locale, "help.open"));
    button.textContent = translate(locale, "help.symbol");
  } else {
    button.textContent = translate(locale, "help.open");
  }
  return button;
}

/**
 * Builds the overlay, appends it to the document, and binds H and ? to open
 * it. It is not open until H, ? or `open()`.
 */
export function createHelpOverlay(options: Readonly<HelpOverlayOptions>): HelpOverlay {
  const { locale } = options;
  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);

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
  body.className = "help-body";
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

  // In the capture phase on the window, so it runs before every other key
  // handler of the page. stopPropagation() keeps a key from the dive and the
  // screens; the key's default action, which moves focus with Tab, presses
  // the focused button with Enter and scrolls the dialog with the arrows,
  // Page Up/Down and Space, is left alone.
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
    body.replaceChildren(...buildBody(context, locale));
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
    if (event.target !== dialog) {
      return;
    }
    const box = dialog.getBoundingClientRect();
    const inside =
      event.clientX >= box.left &&
      event.clientX <= box.right &&
      event.clientY >= box.top &&
      event.clientY <= box.bottom;
    if (!inside) {
      close(true);
    }
  });
  // A close request the page did not see as a key, such as Android's back
  // gesture, closes it the same way.
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
    dialog,
    get isOpen() {
      return open;
    },
    open: show,
    close: () => close(true),
    destroy: () => {
      close(false);
      window.removeEventListener("keydown", openOnKey);
      dialog.remove();
    },
  };
}

function buildBody(context: Readonly<HelpContext>, locale: SupportedLocale): HTMLElement[] {
  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);
  const nodes: HTMLElement[] = [paragraph("help-hint", t("help.closeHint"))];
  if (context.state === "diving") {
    nodes.push(paragraph("help-paused", t("help.paused")));
  }
  for (const section of helpSections(context)) {
    const wrapper = document.createElement("section");
    wrapper.className = "help-section";
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
      keys.textContent = rowText(row, row.keys, locale);
      line.append(keys);
      line.insertCell().textContent = rowText(row, row.touch, locale);
      line.insertCell().textContent = t(row.action);
    }
    wrapper.append(title, table);
    nodes.push(wrapper);
  }
  // Legacy's warning from its controls paragraph, under the controls it is about.
  nodes.push(paragraph("help-safety", `${t("wreck.symbol.warning")} ${t("help.buoyancy")}`));
  return nodes;
}

function rowText(row: HelpRow, key: HelpRow["keys"], locale: SupportedLocale): string {
  const text = translate(locale, key);
  return row.count === undefined ? text : text.replace("{n}", String(row.count));
}

function paragraph(className: string, text: string): HTMLParagraphElement {
  const node = document.createElement("p");
  node.className = className;
  node.textContent = text;
  return node;
}
