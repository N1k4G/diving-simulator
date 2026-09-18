// Keeps .devcontainer/devcontainer.json honest about what it claims to
// reproduce. The container's whole promise is that a green run inside it
// predicts a green run on the runner, and that promise rests on pins spread
// across files that nothing else compares:
//
//   - the Playwright image tag carries the Chromium build. If it drifts from
//     playwright-core in package-lock.json, every browser check inside the
//     container measures a different renderer than CI does and says nothing
//     about it.
//   - the image's distro suffix carries the OS. -noble and -jammy ship the same
//     Playwright with a different Ubuntu underneath, so the version alone does
//     not pin what the committed linux reference frames were recorded on.
//   - .nvmrc carries Node, and Node carries npm. This has to be an exact
//     version: `22` is a range, and both actions/setup-node and the dev
//     container's node feature resolve it to whatever 22.x they find. Two
//     resolutions a week apart can ship different npm builds, which is the same
//     drift this guard exists to catch, one level down.
//
// post-create.sh asserted the first of those, which only ever protected whoever
// rebuilt the container. Dependabot bumps Playwright on its own schedule, so
// between one rebuild and the next the container rots silently. Running this in
// CI is what turns that into a failing check on the PR that causes it.
//
// Fail closed. A guard that cannot read a pin has to say so rather than skip it:
// the failure mode that matters here is the one where nothing looks wrong.
//
// Modes:
//   (none)        compare the pins in the files against each other.
//   --toolchain   also compare the Node and npm actually running against them.
//                 pr.yml uses this after setup-node, so CI proves it resolved
//                 the pin rather than something merely compatible with it.
//   --container   --toolchain plus the checks only post-create.sh can make,
//                 about the image the container was actually built from.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const mode = {
  toolchain: process.argv.includes('--toolchain') || process.argv.includes('--container'),
  container: process.argv.includes('--container'),
};
const problems = [];

// Which Ubuntu the Playwright image is built on, by runner label. A moving
// label is not a pin: `ubuntu-latest` migrates to Ubuntu 26 between 19 October
// and 19 November 2026, which would swap the OS under the reference frames
// without a commit. Add a row here when a new pair is adopted.
const IMAGE_SUFFIX_BY_RUNNER = {
  'ubuntu-22.04': 'jammy',
  'ubuntu-24.04': 'noble',
};

// The npm each pinned Node ships. Node bundles npm, so pinning Node exactly
// already determines it — recording it here is what lets the guard say so out
// loud, and forces whoever moves .nvmrc to look at which npm comes with the
// version they are moving to. An unlisted Node is an error, not a skip.
const NPM_BY_NODE = {
  '22.23.2': '10.9.8',
};

const EXACT_VERSION = /^v?(\d+\.\d+\.\d+)$/;

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

// --- The Node pin ----------------------------------------------------------

let nodePin;
const nvmrcPath = path.join(root, '.nvmrc');
if (!fs.existsSync(nvmrcPath)) {
  problems.push('.nvmrc is missing. It is the one place the exact Node version is written down.');
} else {
  const raw = fs.readFileSync(nvmrcPath, 'utf8').trim();
  const exact = EXACT_VERSION.exec(raw);
  if (!exact) {
    problems.push(
      `.nvmrc says ${JSON.stringify(raw)}, which is not an exact version. A range lets CI and the ` +
        'dev container resolve different builds of the same major, which is the drift this ' +
        'guard exists to catch — write a full major.minor.patch.',
    );
  } else {
    nodePin = exact[1];
    if (!Object.hasOwn(NPM_BY_NODE, nodePin)) {
      problems.push(
        `.nvmrc pins Node ${nodePin}, which this check has no recorded npm version for. Add it ` +
          'to NPM_BY_NODE in this file — moving Node moves npm, and that is the half of the ' +
          'toolchain the lockfile is resolved by.',
      );
    }
  }
}

// --- Workflows -------------------------------------------------------------

// A line-oriented read rather than a YAML parse, so this stays dependency-free
// like the rest of scripts/. It is only safe because it refuses anything it
// cannot resolve: every setup-node step has to end up at one exact version, and
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

// A version file is only a pin if it exists and holds an exact version, so it
// is resolved here rather than taken on trust.
function resolveVersionFile(reference) {
  const resolved = path.join(root, reference);
  if (!fs.existsSync(resolved)) return { error: `points at ${reference}, which does not exist` };
  const raw = fs.readFileSync(resolved, 'utf8').trim();
  const exact = EXACT_VERSION.exec(raw);
  if (!exact) return { error: `points at ${reference}, which says ${JSON.stringify(raw)}` };
  return { version: exact[1] };
}

function scanWorkflow(text) {
  const found = { runners: [], nodeVersions: [], setupNodeSteps: 0, unresolved: [] };
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine);

    const runsOn = /^\s*runs-on:\s*(\S.*)$/.exec(line);
    if (runsOn) found.runners.push(unquote(runsOn[1]));

    if (/^\s*-?\s*uses:\s*['"]?actions\/setup-node@/.test(line)) found.setupNodeSteps += 1;

    const inline = /^\s*node-version:\s*(\S.*)$/.exec(line);
    if (inline) {
      const value = unquote(inline[1]);
      const exact = EXACT_VERSION.exec(value);
      if (exact) found.nodeVersions.push(exact[1]);
      else found.unresolved.push(`node-version: ${value} is a range, not an exact version`);
    }

    const versionFile = /^\s*node-version-file:\s*(\S.*)$/.exec(line);
    if (versionFile) {
      const resolved = resolveVersionFile(unquote(versionFile[1]));
      if (resolved.version) found.nodeVersions.push(resolved.version);
      else found.unresolved.push(`node-version-file ${resolved.error}`);
    }
  }
  return found;
}

const workflowDirectory = path.join(root, '.github', 'workflows');
const nodeVersions = new Map();
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
      `${file} has a setup-node step whose ${value}. The dev container is pinned to one exact ` +
        'build, so CI has to name one too — point it at .nvmrc.',
    );
  }

  if (found.nodeVersions.length !== found.setupNodeSteps) {
    problems.push(
      `${file} has ${found.setupNodeSteps} actions/setup-node step(s) but ` +
        `${found.nodeVersions.length} resolvable version(s). A step that picks its own version ` +
        'cannot be matched by a pinned container.',
    );
  }

  for (const version of found.nodeVersions) {
    nodeVersions.set(version, (nodeVersions.get(version) ?? new Set()).add(file));
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

if (nodeVersions.size === 0) {
  problems.push(
    "no workflow installs a pinned Node version, so the container's node feature vouches for " +
      'nothing. Either pin one in CI or drop the claim from the dev container.',
  );
} else if (nodeVersions.size > 1) {
  problems.push(
    `the workflows do not agree on a Node version: ${describe(nodeVersions)}. Settle that first ` +
      '— the dev container can only match one of them.',
  );
} else if (nodePin !== undefined && [...nodeVersions.keys()][0] !== nodePin) {
  problems.push(
    `.nvmrc pins Node ${nodePin} but the workflows resolve to ` +
      `${[...nodeVersions.keys()][0]}. They have to be the same build.`,
  );
}

if (runnerLabels.size > 1) {
  problems.push(
    `the toolchain workflows do not agree on a runner: ${describe(runnerLabels)}. Settle that ` +
      'first — the dev container can only be built on one Ubuntu release.',
  );
}

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

if (nodePin !== undefined && String(nodeFeature) !== nodePin) {
  problems.push(
    `.nvmrc pins Node ${nodePin}, but the node feature in devcontainer.json is set to ` +
      `${JSON.stringify(nodeFeature)}. The feature resolves a bare major through nvm, so only an ` +
      'exact version here builds the same toolchain CI installs.',
  );
}

// --- The running toolchain -------------------------------------------------

function runningNpmVersion() {
  // Set when this runs under `npm run`, which is how CI calls it; spawning npm
  // is the fallback for post-create.sh, which calls node directly.
  const agent = /\bnpm\/(\d+\.\d+\.\d+)/.exec(process.env.npm_config_user_agent ?? '');
  if (agent) return agent[1];
  try {
    // shell on win32 because npm is a .cmd there. --toolchain is not meant to
    // run on a developer's host, but it should report the real reason if it does.
    return execFileSync('npm', ['--version'], {
      encoding: 'utf8',
      shell: process.platform === 'win32',
    }).trim();
  } catch {
    return undefined;
  }
}

if (mode.toolchain && nodePin !== undefined) {
  const hereNode = process.versions.node;
  if (hereNode !== nodePin) {
    problems.push(
      `this is running on Node ${hereNode} but .nvmrc pins ${nodePin}. A matching major is not ` +
        'enough: the point of the exact pin is that CI and the container run the same build.',
    );
  }

  const expectedNpm = NPM_BY_NODE[nodePin];
  const hereNpm = runningNpmVersion();
  if (expectedNpm === undefined) {
    // Already reported against .nvmrc; nothing to compare to.
  } else if (hereNpm === undefined) {
    problems.push('could not determine the running npm version to check it against the pin.');
  } else if (hereNpm !== expectedNpm) {
    problems.push(
      `Node ${nodePin} ships npm ${expectedNpm}, but npm ${hereNpm} is running. Something has ` +
        'replaced the bundled npm, and the lockfile is resolved by whichever one is in front.',
    );
  }
}

// --- The built container ---------------------------------------------------

if (mode.container) {
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
  `dev container pins agree with CI: Playwright ${locked} on ${ciRunner}, ` +
    `Node ${nodePin} with npm ${NPM_BY_NODE[nodePin]}.`,
);
