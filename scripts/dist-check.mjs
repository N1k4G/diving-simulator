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
// Source maps are excluded on purpose. They carry the original module text by
// design — a .js.map legitimately contains the dev-only branch that Vite
// eliminated from the .js — so scanning them would report a failure that is not
// one. Only the files a browser executes or fetches are in scope.
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const distDirectory = path.join(root, "dist");

// Extensions a browser loads. `.map` is excluded — see the note above.
const SCANNED_EXTENSIONS = new Set([".html", ".js", ".mjs", ".css", ".json"]);

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
    } else if (SCANNED_EXTENSIONS.has(path.extname(entry.name))) {
      yield full;
    }
  }
}

const files = [...walk(distDirectory)];

if (files.length === 0) {
  console.error("✗ dist/ contains no scannable files. Did the build succeed?");
  process.exit(1);
}

// An entry point has to exist, or an empty-ish dist would pass by vacuum.
const indexHtml = path.join(distDirectory, "index.html");
if (!fs.existsSync(indexHtml)) {
  console.error("✗ dist/index.html is missing. Did the build succeed?");
  process.exit(1);
}

const breaches = [];
for (const file of files) {
  const contents = fs.readFileSync(file, "utf8");
  for (const rule of FORBIDDEN) {
    if (rule.pattern.test(contents)) {
      breaches.push({ rule, file: path.relative(root, file) });
    }
  }
}

if (breaches.length > 0) {
  for (const { rule, file } of breaches) {
    console.error(`✗ ${file} contains ${rule.id}: ${rule.why}`);
  }
  process.exit(1);
}

console.log(
  `production bundle is clean: ${files.length} files scanned, ` +
    `${FORBIDDEN.length} diagnostic markers absent.`,
);
