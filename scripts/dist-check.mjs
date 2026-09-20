// Asserts that the production bundle is a product, not a diagnostic shell.
//
// WHY THIS IS A CHECK AND NOT A CONVENTION. The Definition of done requires
// "development renderer selection and diagnostics are absent from production".
// Before #161 exactly one half of that held: the canvas reference adapter is
// behind `import.meta.env.DEV` (src/render/renderer.ts), so `?renderer=canvas`
// never reached a build. The other half — a planner-worker diagnostic on
// `window`, a link to a legacy client that does not exist inside a dist/-only
// package, and a `<title>` reading "Migration Diagnostic" — shipped in every
// build, and nothing said so. A rule nothing enforces is a rule that returns.
//
// So this asserts the artifact, not the intention: it greps the bytes that
// would be packaged, the same principle as scripts/devcontainer-check.mjs.
// It is deliberately a byte check rather than a source check, because the
// source can be correct while a stale build is what gets deployed.
//
// SOURCE MAPS ARE PART OF THE ARTIFACT. An earlier version of this script
// skipped .map files, reasoning that a map legitimately describes source that
// was eliminated from the .js beside it. That reasoning answered the wrong
// question. It is true that a map is not evidence of a runtime leak — and it is
// also true that `sourcesContent` embeds the original TypeScript verbatim, so
// with maps in dist/ every marker below was still sitting in the shipped
// directory, exactly as if nothing had been gated. Measured, not assumed:
// index-*.js.map carried plannerWorkerDiagnostic, the legacy client path and
// CanvasReferenceAdapter through ../../src/app/bootstrap.ts.
//
// The distributable is the directory, not the subset of it a browser happens to
// execute, and WP-09 packages this directory into Capacitor. So nothing is
// skipped, and a map in dist/ is itself a breach: production builds emit none
// (vite.config.mts), and a debug build made with `--sourcemap` is not a
// distributable.
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const distDirectory = path.join(root, "dist");

const FORBIDDEN = [
  {
    id: "planner-worker-diagnostic",
    pattern: /plannerWorkerDiagnostic/,
    why:
      "the dev-only planner worker probe reached the bundle. It spawns a second " +
      "worker on every load. Keep it behind `import.meta.env.DEV` in src/app/bootstrap.ts.",
  },
  {
    id: "legacy-client-link",
    pattern: /diving-simulator\.html/,
    why:
      "a reference to the legacy client reached the bundle. That path does not " +
      "resolve inside a dist/-only package, so it is a dead link in any packaged " +
      "build. Remove the reference — do not copy src/ into dist/ to make it work.",
  },
  {
    id: "diagnostic-title",
    pattern: /Migration Diagnostic|Migrationsdiagnose/,
    why:
      "the diagnostic title reached the bundle. On Android this becomes the " +
      "WebView document title. Use the product name; the localized title comes " +
      "from the catalogue at runtime (wreck-app.ts).",
  },
  {
    id: "canvas-reference-adapter",
    pattern: /CanvasReferenceAdapter/,
    why:
      "the development canvas reference adapter reached the bundle. It must stay " +
      "behind `import.meta.env.DEV` in src/render/renderer.ts (the WP-06 guarantee).",
  },
];

if (!fs.existsSync(distDirectory)) {
  console.error("✗ dist/ does not exist. Run `npm run build` first.");
  process.exit(1);
}

function* walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else {
      yield full;
    }
  }
}

const files = [...walk(distDirectory)];

if (files.length === 0) {
  console.error("✗ dist/ contains no files. Did the build succeed?");
  process.exit(1);
}

// Binary assets (fonts, images) are scanned as text too; a UTF-8 read of a
// binary cannot produce a false positive for these ASCII markers, and skipping
// by extension is what let the maps through in the first place.
const sourceMaps = files.filter((file) => file.endsWith(".map"));

// An entry point has to exist, or an empty-ish dist would pass by vacuum.
const indexHtml = path.join(distDirectory, "index.html");
if (!fs.existsSync(indexHtml)) {
  console.error("✗ dist/index.html is missing. Did the build succeed?");
  process.exit(1);
}

const breaches = [];

if (sourceMaps.length > 0) {
  breaches.push({
    id: "source-map-in-distributable",
    file: path.relative(root, sourceMaps[0]),
    why:
      `${sourceMaps.length} source map(s) are in dist/. sourcesContent embeds the ` +
      "original TypeScript, so a map reintroduces every marker below into the " +
      "shipped directory and would put the client source inside a packaged app. " +
      "Production builds emit none — if this is a local `--sourcemap` debug " +
      "build, it is not a distributable and this failure is correct.",
  });
}

// The title has to survive the build, or the injected placeholder is still
// sitting there and the tab shows "%APP_TITLE%".
const indexContents = fs.readFileSync(indexHtml, "utf8");
if (/<title>\s*%[A-Z_]+%\s*<\/title>/.test(indexContents)) {
  breaches.push({
    id: "untransformed-title-placeholder",
    file: "dist/index.html",
    why:
      "the title placeholder was not replaced. The `inject-app-title` plugin in " +
      "vite.config.mts fills it from the string catalogue; if it did not run, " +
      "the build is not usable.",
  });
}

for (const file of files) {
  const contents = fs.readFileSync(file, "utf8");
  for (const rule of FORBIDDEN) {
    if (rule.pattern.test(contents)) {
      breaches.push({
        id: rule.id,
        file: path.relative(root, file),
        why: rule.why,
      });
    }
  }
}

if (breaches.length > 0) {
  for (const { id, file, why } of breaches) {
    console.error(`✗ ${file} contains ${id}: ${why}`);
  }
  process.exit(1);
}

console.log(
  `production bundle is clean: ${files.length} files scanned, no source maps, ` +
    `${FORBIDDEN.length} diagnostic markers absent.`,
);
