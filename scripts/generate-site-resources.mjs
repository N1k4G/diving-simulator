// WP-07: extract the legacy DIVE_SITES descriptors into renderer-neutral
// resources, split by whether a field can affect the simulation.
//
// The split is the point of the package. Gameplay data feeds collision, air,
// spawning and currents; presentation data feeds art only. Keeping them in one
// object is what made "change the look of a site" indistinguishable from
// "change where the diver can swim".
//
// Do not hand-edit the generated files. Change the legacy descriptor or this
// script and regenerate, so the parity test keeps its meaning.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const outputDirectory = path.join(root, 'src', 'sites', 'resources');

// Fields that reach physics, collision, air, spawning or currents. Anything
// here must round-trip exactly; the parity test proves it does.
const GAMEPLAY_FIELDS = [
  'id',
  'maxDepth',
  'hasOverhead',
  'entry',
  'boatX',
  'floor',
  'ceiling',
  'structures',
  'badAir',
  'currentBias',
  'noShark',
];

// Fields that only affect what is drawn. The legacy file already documents
// visualZones as never driving physics; this makes that structural.
const PRESENTATION_FIELDS = [
  'id',
  'name',
  'surfaceMarker',
  'features',
  'visualZones',
  'atmosphereProfiles',
  'decorationRules',
];

// `sites.js` reads MAX_DEPTH from constants.js — the reef descriptor uses it for
// its maxDepth, both floor abyss endpoints and the blue-water zone. Hardcoding a
// value here bakes it into the generated resources, and the parity test cannot
// notice because it injects the same constant into both sides of its comparison.
// Read the real one instead, and fail loudly if it moves out of reach.
//
// It cannot simply be evaluated into the sandbox: constants.js declares it with
// `const`, which never becomes a property of the context object.
function readMaxDepth() {
  const source = fs.readFileSync(path.join(root, 'src', 'constants.js'), 'utf8');
  const match = /^\s*(?:const|let|var)\s+MAX_DEPTH\s*=\s*(-?\d+(?:\.\d+)?)\s*;/m.exec(source);
  if (!match) {
    throw new Error(
      'could not read MAX_DEPTH from src/constants.js. If its declaration moved ' +
      'or became computed, update this pattern rather than hardcoding a value.',
    );
  }
  return Number(match[1]);
}

function loadLegacySites(maxDepth) {
  const sandbox = { MAX_DEPTH: maxDepth };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, 'src', 'sites.js'), 'utf8'), sandbox);
  if (!sandbox.DIVE_SITES) {
    throw new Error('DIVE_SITES was not defined by src/sites.js');
  }
  return sandbox.DIVE_SITES;
}

function pick(source, fields) {
  const result = {};
  for (const field of fields) {
    if (source[field] !== undefined) {
      result[field] = source[field];
    }
  }
  return result;
}

function assertPartitioned(site) {
  const known = new Set([...GAMEPLAY_FIELDS, ...PRESENTATION_FIELDS]);
  const unclassified = Object.keys(site).filter((key) => !known.has(key));
  if (unclassified.length) {
    // Failing here is the safety property: a new descriptor field must be
    // deliberately classified as gameplay or art, never silently dropped.
    throw new Error(
      `site "${site.id}" has unclassified field(s): ${unclassified.join(', ')}. ` +
      'Add each to GAMEPLAY_FIELDS or PRESENTATION_FIELDS in this script.',
    );
  }
}

const sites = loadLegacySites(readMaxDepth());

const gameplay = {};
const presentation = {};
for (const [id, site] of Object.entries(sites)) {
  assertPartitioned(site);
  gameplay[id] = pick(site, GAMEPLAY_FIELDS);
  presentation[id] = pick(site, PRESENTATION_FIELDS);
}

const DOCUMENTS = [
  { file: 'gameplay.json', kind: 'diving-simulator-site-gameplay', sites: gameplay },
  { file: 'presentation.json', kind: 'diving-simulator-site-presentation', sites: presentation },
];

// `--check` verifies the committed resources still match what the legacy
// descriptors would generate, without rewriting them. CI runs this so an edit
// to sites.js that skips regeneration fails the build instead of leaving the
// resources quietly stale.
//
// Only the `sites` payload is compared. `sourceCommit` is provenance and moves
// with every commit, so including it would make the check fail on every run.
if (process.argv.includes('--check')) {
  const stale = [];
  for (const { file, sites: expected } of DOCUMENTS) {
    const target = path.join(outputDirectory, file);
    if (!fs.existsSync(target)) {
      stale.push(`${file} is missing`);
      continue;
    }
    const actual = JSON.parse(fs.readFileSync(target, 'utf8')).sites;
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      stale.push(`${file} does not match src/sites.js`);
    }
  }
  if (stale.length) {
    console.error(
      `site resources are out of date:\n  ${stale.join('\n  ')}\n` +
      'Run `npm run sites:generate` and commit the result.',
    );
    process.exit(1);
  }
  console.log(`site resources match src/sites.js (${Object.keys(gameplay).length} sites)`);
} else {
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();

  fs.mkdirSync(outputDirectory, { recursive: true });
  const header = { schemaVersion: 1, sourceCommit, generator: 'npm run sites:generate' };
  for (const { file, kind, sites: payload } of DOCUMENTS) {
    fs.writeFileSync(
      path.join(outputDirectory, file),
      `${JSON.stringify({ ...header, kind, sites: payload }, null, 2)}\n`,
      'utf8',
    );
  }
  console.log(`wrote ${Object.keys(gameplay).length} site resources to src/sites/resources/`);
}
