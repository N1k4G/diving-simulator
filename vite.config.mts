import { defineConfig, type Plugin } from "vitest/config";

import { DEFAULT_LOCALE, translate } from "./src/app/i18n/catalog";

// The pre-hydration document title, injected from the string catalogue at build
// time so there is exactly one source of truth for it.
//
// The app sets a localized title as soon as it knows the locale
// (wreck-app.ts), but these are the bytes a browser tab, an Android WebView and
// a link preview show before the module runs — and #161 removed the milestone
// title that used to sit there. Hard-coding the replacement in index.html would
// have put a second copy of a user-facing string outside the catalogue, free to
// drift from `wreck.brand`. The placeholder keeps index.html declarative and
// makes that impossible.
//
// DEFAULT_LOCALE, not a negotiated one: a static file cannot vary per request,
// and the catalogue already names English as the fallback every locale falls
// back to.
const APP_TITLE_PLACEHOLDER = "%APP_TITLE%";

function injectAppTitle(): Plugin {
  return {
    name: "inject-app-title",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        return html.replaceAll(
          APP_TITLE_PLACEHOLDER,
          translate(DEFAULT_LOCALE, "wreck.brand"),
        );
      },
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [injectAppTitle()],
  build: {
    // Off for the distributable. A source map carries the original TypeScript
    // in `sourcesContent`, including the branches Vite eliminated — so with
    // maps in dist/, `plannerWorkerDiagnostic`, the legacy client path and
    // `CanvasReferenceAdapter` were all still present in the shipped directory
    // after #161 removed them from the executed bytes. dist/ is what WP-09
    // packages into Capacitor, so that would put the full client source inside
    // an APK.
    //
    // Nothing consumes these maps: `npm run dev` has its own, and the only
    // other references in the repository are MIME-type tables in the two
    // static test servers. To debug a production build locally, build once with
    // `npx vite build --sourcemap` — `npm run dist:check` will then correctly
    // refuse that build as a distributable.
    sourcemap: false,
  },
  test: {
    environment: "node",
    include: [
      "src/**/*.test.ts",
      "tests/unit/**/*.test.ts",
      "tests/parity/**/*.test.ts",
    ],
  },
});
