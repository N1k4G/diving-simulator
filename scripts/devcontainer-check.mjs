// Keeps .devcontainer/devcontainer.json honest about what it claims to
// reproduce. The container's whole promise is that a green run inside it
// predicts a green run on the runner, and that promise rests on three pins
// spread across files that nothing else compares:
//
//   - the Playwright image tag carries the Chromium build. If it drifts from
//     playwright-core in package-lock.json, every browser check inside the
//     container measures a different renderer than CI does and says nothing
//     about it.
//   - the image's distro suffix carries the OS. -noble and -jammy ship the same
//     Playwright with a different Ubuntu underneath, so the version alone does
//     not pin what the committed linux reference frames were recorded on.
//   - the node feature carries npm. Node 22 ships npm 10 and Node 24 ships
//     npm 11, so a container on the wrong major resolves the lockfile
//     differently than the workflows do.
//
// post-create.sh asserted the first of those, which only ever protected whoever
// rebuilt the container. Dependabot bumps Playwright on its own schedule, so
// between one rebuild and the next the container rots silently. Running this in
// CI is what turns that into a failing check on the PR that causes it.
//
// Fail closed. A guard that cannot read a pin has to say so rather than skip it:
// the failure mode that matters here is the one where nothing looks wrong.
//
// With --runtime it also checks the interpreter it is running under, which is
// the half only post-create.sh can do: the pins can agree with each other on
// disk while the container that was actually built is a rebuild behind them.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const runtime = process.argv.includes('--runtime');
const problems = [];

// Which Ubuntu the Playwright image is built on, by runner label. A moving
// label is not a pin: `ubuntu-latest` migrates to Ubuntu 26 from 19 October
// 2026, which would swap the OS under the reference frames without a commit.
// Add a row here when a new pair is adopted.
const IMAGE_SUFFIX_BY_RUNNER = {
  'ubuntu-22.04': 'jammy',
  'ubuntu-24.04': 'noble',
};

// devcontainer.json is JSONC. Strip comments with a scanner rather than a
// regex, so a // or /* inside a string value can never be mistaken for one.
function parseJsonc(source) {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    const next = source[i + 1];
    if (inLine) {
      if (c === '\n') {
        inLine = false;
        out += c;
      }
    } else if (inBlock) {
      if (c === '*' && next === '/') {
        inBlock = false;
        i += 1;
      } else if (c === '\n') {
        out += c;
      }
    } else if (inString) {
      out += c;
      if (c === '\\') {
        out += next ?? '';
        i += 1;
      } else if (c === '"') {
        inString = false;
      }
    } else if (c === '/' && next === '/') {
      inLine = true;
      i += 1;
    } else if (c === '/' && next === '*') {
      inBlock = true;
      i += 1;
    } else {
      if (c === '"') inString = true;
      out += c;
    }
  }
  return JSON.parse(out);
}

const devcontainer = parseJsonc(
  fs.readFileSync(path.join(root, '.devcontainer', 'devcontainer.json'), 'utf8'),
);

// --- Workflows -------------------------------------------------------------

// A line-oriented read rather than a YAML parse, so this stays dependency-free
// like the rest of scripts/. It is only safe because it refuses anything it
// cannot resolve: every setup-node step has to hand over a bare major, and
// every runner label has to be one this file knows the image suffix for.
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function unquote(value) {
  const trimmed = value.trim();
  return /^(['"]).*\1$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
}

function scanWorkflow(text) {
  const found = { runners: [], nodeMajors: [], setupNodeSteps: 0, unresolved: [] };
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine);

    const runsOn = /^\s*runs-on:\s*(\S.*)$/.exec(line);
    if (runsOn) found.runners.push(unquote(runsOn[1]));

    if (/^\s*-?\s*uses:\s*['"]?actions\/setup-node@/.test(line)) found.setupNodeSteps += 1;

    const nodeVersion = /^\s*node-version:\s*(\S.*)$/.exec(line);
    if (nodeVersion) {
      const value = unquote(nodeVersion[1]);
      if (/^\d+$/.test(value)) found.nodeMajors.push(value);
      else found.unresolved.push(`node-version: ${value}`);
    }

    const versionFile = /^\s*node-version-file:\s*(\S.*)$/.exec(line);
    if (versionFile) found.unresolved.push(`node-version-file: ${unquote(versionFile[1])}`);
  }
  return found;
}

const workflowDirectory = path.join(root, '.github', 'workflows');
const nodeMajors = new Map();
const runnerLabels = new Map();

for (const file of fs.readdirSync(workflowDirectory).sort()) {
  if (!/\.ya?ml$/.test(file)) continue;
  const found = scanWorkflow(fs.readFileSync(path.join(workflowDirectory, file), 'utf8'));

  // A workflow that never installs Node runs none of the toolchain this
  // container mirrors, so neither its runner nor its absent Node pin is this
  // check's business. release-label.yml only applies a label.
  if (found.setupNodeSteps === 0) continue;

  for (const value of found.unresolved) {
    problems.push(
      `${file} sets ${value}, which this check cannot resolve to a Node major. The dev ` +
        'container has to name one exact version, so CI has to as well — use ' +
        "`node-version: '<major>'`.",
    );
  }

  if (found.nodeMajors.length !== found.setupNodeSteps) {
    problems.push(
      `${file} has ${found.setupNodeSteps} actions/setup-node step(s) but ` +
        `${found.nodeMajors.length} resolvable node-version value(s). A step that picks its own ` +
        'version cannot be matched by a pinned container.',
    );
  }

  for (const major of found.nodeMajors) {
    nodeMajors.set(major, (nodeMajors.get(major) ?? new Set()).add(file));
  }

  for (const label of found.runners) {
    if (!Object.hasOwn(IMAGE_SUFFIX_BY_RUNNER, label)) {
      problems.push(
        `${file} runs on "${label}", which is not a pinned Ubuntu release this check knows an ` +
          `image for. Pin it to one of ${Object.keys(IMAGE_SUFFIX_BY_RUNNER).join(', ')} — a ` +
          'moving label can change the OS under the committed reference frames without a commit.',
      );
      continue;
    }
    runnerLabels.set(label, (runnerLabels.get(label) ?? new Set()).add(file));
  }
}

function describe(entries) {
  return [...entries]
    .map(([value, files]) => `${value} (${[...files].sort().join(', ')})`)
    .join(' vs ');
}

if (nodeMajors.size === 0) {
  problems.push(
    'no workflow installs a pinned Node major, so the container\'s node feature vouches for ' +
      'nothing. Either pin one in CI or drop the claim from the dev container.',
  );
} else if (nodeMajors.size > 1) {
  problems.push(
    `the workflows do not agree on a Node major: ${describe(nodeMajors)}. Settle that first — ` +
      'the dev container can only match one of them.',
  );
}

if (runnerLabels.size > 1) {
  problems.push(
    `the toolchain workflows do not agree on a runner: ${describe(runnerLabels)}. Settle that ` +
      'first — the dev container can only be built on one Ubuntu release.',
  );
}

const [ciNode] = nodeMajors.size === 1 ? [...nodeMajors.keys()] : [undefined];
const [ciRunner] = runnerLabels.size === 1 ? [...runnerLabels.keys()] : [undefined];

// --- Playwright: image tag vs containerEnv vs lockfile ---------------------

const locked =
  JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'))
    .packages['node_modules/playwright-core']?.version;

const image = devcontainer.image ?? '';
const parsedImage = /^mcr\.microsoft\.com\/playwright:v(\d[^-]*)-([a-z0-9.]+)$/.exec(image);
const declared = devcontainer.containerEnv?.PLAYWRIGHT_IMAGE_VERSION;

if (!locked) {
  problems.push('package-lock.json has no playwright-core entry to pin the image against.');
} else if (!parsedImage) {
  problems.push(
    `devcontainer.json "image" is ${JSON.stringify(image)}, which this check cannot read as a ` +
      'pinned Playwright image. Expected mcr.microsoft.com/playwright:v<version>-<distro>.',
  );
} else {
  const [, imageVersion, imageSuffix] = parsedImage;

  if (imageVersion !== locked || declared !== locked) {
    problems.push(
      `playwright-core is pinned to ${locked} in package-lock.json, but devcontainer.json builds ` +
        `on the v${imageVersion} image with PLAYWRIGHT_IMAGE_VERSION=${declared}. Set "image" to ` +
        `mcr.microsoft.com/playwright:v${locked}-${imageSuffix} and PLAYWRIGHT_IMAGE_VERSION to ` +
        `${locked}.`,
    );
  }

  // The half the version check cannot see: -jammy and -noble carry the same
  // Playwright on different Ubuntu releases, and the reference frames were
  // recorded on one of them.
  if (ciRunner !== undefined) {
    const expected = IMAGE_SUFFIX_BY_RUNNER[ciRunner];
    if (imageSuffix !== expected) {
      problems.push(
        `CI runs on ${ciRunner}, but devcontainer.json builds on the -${imageSuffix} image. Use ` +
          `-${expected} — the OS is what the committed linux reference frames were recorded on, ` +
          'and the version alone does not pin it.',
      );
    }
  }
}

// --- Node feature ----------------------------------------------------------

const nodeFeature = Object.entries(devcontainer.features ?? {}).find(([key]) =>
  key.startsWith('ghcr.io/devcontainers/features/node'),
)?.[1]?.version;

if (ciNode !== undefined && String(nodeFeature) !== ciNode) {
  problems.push(
    `.github/workflows installs Node ${ciNode}, but the node feature in devcontainer.json is ` +
      `pinned to ${JSON.stringify(nodeFeature)}. Move both together — a container on a ` +
      'different major than CI cannot vouch for a CI run.',
  );
}

// --- Runtime: is the container that was built the one the files describe? ---

if (runtime) {
  const hereNode = process.versions.node.split('.')[0];
  if (ciNode !== undefined && hereNode !== ciNode) {
    problems.push(
      `this container runs Node ${hereNode} but .github/workflows installs Node ${ciNode}. ` +
        'Rebuild the container — a container on a different major than CI cannot vouch for ' +
        'a CI run.',
    );
  }

  // Set beside the image tag in devcontainer.json, so it is the built image
  // speaking rather than the file: if they disagree, the container predates the
  // pin it is being checked against. Absent is its own failure — post-create.sh
  // runs under `set -u` and reports it in the banner, so an unset value would
  // otherwise surface as an unbound-variable abort with nothing to act on.
  const inContainer = process.env.PLAYWRIGHT_IMAGE_VERSION;
  if (inContainer === undefined) {
    problems.push(
      'PLAYWRIGHT_IMAGE_VERSION is not set in this container. It is declared in ' +
        'devcontainer.json "containerEnv" beside the image tag; restore it and rebuild.',
    );
  } else if (inContainer !== declared) {
    problems.push(
      `this container was built with PLAYWRIGHT_IMAGE_VERSION=${inContainer}, but ` +
        `devcontainer.json now declares ${declared}. Rebuild it, or the browser checks here ` +
        'measure a renderer nobody has pinned.',
    );
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`✗ ${problem}`);
  process.exit(1);
}

console.log(
  `dev container pins agree with CI: Playwright ${locked} on ${ciRunner}, Node ${ciNode}.`,
);
