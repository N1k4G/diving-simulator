// Keeps .devcontainer/devcontainer.json honest about what it claims to
// reproduce. The container's whole promise is that a green run inside it
// predicts a green run on ubuntu-latest, and that promise rests on two pins
// that live in three different files:
//
//   - the Playwright image tag carries the Chromium build. If it drifts from
//     playwright-core in package-lock.json, every browser check inside the
//     container measures a different renderer than CI does and says nothing
//     about it.
//   - the node feature carries npm. Node 22 ships npm 10 and Node 24 ships
//     npm 11, so a container on the wrong major resolves the lockfile
//     differently than the workflows do.
//
// post-create.sh asserted both, which only ever protected whoever rebuilt the
// container. Dependabot bumps Playwright on its own schedule, so between one
// rebuild and the next the container rots silently. Running this in CI is what
// turns that into a failing check on the PR that causes it.
//
// With --runtime it also checks the interpreter it is running under, which is
// the half only post-create.sh can do: the pins can agree with each other on
// disk while the container that was actually built is a rebuild behind them.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const runtime = process.argv.includes('--runtime');
const problems = [];

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

// --- Playwright: image tag vs containerEnv vs lockfile ---------------------

const locked =
  JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'))
    .packages['node_modules/playwright-core']?.version;

const imageTag = /^mcr\.microsoft\.com\/playwright:v([^-]+)-/.exec(devcontainer.image ?? '')?.[1];
const declared = devcontainer.containerEnv?.PLAYWRIGHT_IMAGE_VERSION;

if (!locked) {
  problems.push('package-lock.json has no playwright-core entry to pin the image against.');
} else if (!imageTag) {
  problems.push(
    `devcontainer.json "image" is ${JSON.stringify(devcontainer.image)}, which carries no ` +
      'recognisable Playwright version. Expected mcr.microsoft.com/playwright:v<version>-noble.',
  );
} else if (imageTag !== locked || declared !== locked) {
  problems.push(
    `playwright-core is pinned to ${locked} in package-lock.json, but devcontainer.json builds ` +
      `on the v${imageTag} image with PLAYWRIGHT_IMAGE_VERSION=${declared}. Set "image" to ` +
      `mcr.microsoft.com/playwright:v${locked}-noble and PLAYWRIGHT_IMAGE_VERSION to ${locked}.`,
  );
}

// --- Node: the workflows against each other, then against the feature ------

const workflowDirectory = path.join(root, '.github', 'workflows');
const workflowNodes = new Map();
for (const file of fs.readdirSync(workflowDirectory)) {
  if (!/\.ya?ml$/.test(file)) continue;
  const text = fs.readFileSync(path.join(workflowDirectory, file), 'utf8');
  for (const match of text.matchAll(/node-version:\s*'?"?(\d+)/g)) {
    const versions = workflowNodes.get(match[1]) ?? new Set();
    versions.add(file);
    workflowNodes.set(match[1], versions);
  }
}

const nodeFeature = Object.entries(devcontainer.features ?? {}).find(([key]) =>
  key.startsWith('ghcr.io/devcontainers/features/node'),
)?.[1]?.version;

if (workflowNodes.size > 1) {
  const detail = [...workflowNodes]
    .map(([version, files]) => `${version} (${[...files].sort().join(', ')})`)
    .join(' vs ');
  problems.push(
    `the workflows do not agree on a Node major: ${detail}. Settle that first — the dev ` +
      'container can only match one of them.',
  );
} else if (workflowNodes.size === 1) {
  const [ciNode] = [...workflowNodes.keys()];
  if (String(nodeFeature) !== ciNode) {
    problems.push(
      `.github/workflows installs Node ${ciNode}, but the node feature in devcontainer.json is ` +
        `pinned to ${JSON.stringify(nodeFeature)}. Move both together — a container on a ` +
        'different major than CI cannot vouch for a CI run.',
    );
  }
}

// --- Runtime: is the container that was built the one the files describe? ---

if (runtime) {
  const hereNode = process.versions.node.split('.')[0];
  const [ciNode] = [...workflowNodes.keys()];
  if (workflowNodes.size === 1 && hereNode !== ciNode) {
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
  `dev container pins agree with CI: Playwright ${locked}, Node ${[...workflowNodes.keys()][0]}.`,
);
