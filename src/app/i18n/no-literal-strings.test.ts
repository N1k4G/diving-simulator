import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// The no-literal-strings rule (#169) run through ESLint's API on snippets, so
// a selector that over- or under-matches fails here, not in a review.
// No node typings in this project: the repo root comes from the file URL.
const root = decodeURIComponent(new URL("../../../", import.meta.url).pathname).replace(/^\/(?=[A-Za-z]:)/, "");
const eslint = new ESLint({ cwd: root, overrideConfigFile: `${root}eslint.config.mjs` });

async function messages(code: string, filePath = "src/app/fixture-169.ts"): Promise<string[]> {
  const results = await eslint.lintText(code, { filePath: `${root}${filePath}` });
  return (results[0]?.messages ?? [])
    .filter((message) => message.ruleId === "no-restricted-syntax")
    .map((message) => message.message);
}

describe("no-literal-strings rule", () => {
  const mustFail = [
    'el.textContent = "Hi";',
    "el.textContent = `Hi`;",
    'el.innerHTML = "<b>Hi</b>";',
    'el.title = "Hi";',
    "el.ariaLabel = `Hi`;",
    'el.setAttribute("aria-label", "Hi");',
    'el.setAttribute("aria-valuetext", `Hi`);',
    'el.setAttribute("alt", \'Hi\');',
    'el.append(document.createTextNode("Hi"));',
    'const o = { label: "Hi" };',
    "const o = { hint: `Hi` };",
    'const o = { caption: "Hi", alt: "x" };',
  ];

  const mustPass = [
    "el.textContent = `${t('a')} ${x}`;",
    "el.textContent = `${x}`;",
    "el.textContent = ``;",
    'el.textContent = "";',
    "el.textContent = t('a');",
    'el.setAttribute("aria-label", `${t("a")} ${x}`);',
    'el.setAttribute("aria-label", `${x}`);',
    'el.setAttribute("aria-label", ``);',
    'el.setAttribute("aria-label", "");',
    'el.setAttribute("aria-label", t("a"));',
    'el.setAttribute("data-id", "plain");',
    'el.setAttribute("class", "wreck-hud");',
    'el.className = "wreck-hud";',
    'el.id = "wreck-hud";',
    'el.append(document.createTextNode(""));',
    "const o = { hint: null, summary: null, label: 0, title: true, text: undefined };",
    "const o = { hint: `${x}`, label: t('a'), caption: `` };",
    'const o = { id: "plain", className: "plain", type: "button" };',
  ];

  it.each(mustFail)("flags %s", async (code) => {
    expect((await messages(code)).length).toBeGreaterThan(0);
  });

  it.each(mustPass)("allows %s", async (code) => {
    expect(await messages(code)).toEqual([]);
  });

  it("covers src/render, and leaves the catalogue and tests alone", async () => {
    expect((await messages('el.textContent = "Hi";', "src/render/fixture-169.ts")).length).toBeGreaterThan(0);
    expect(await messages('el.textContent = "Hi";', "src/app/i18n/catalog.ts")).toEqual([]);
    expect(await messages('el.textContent = "Hi";', "src/app/fixture-169.test.ts")).toEqual([]);
  });
});
