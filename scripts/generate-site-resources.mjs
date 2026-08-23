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
import crypto from 'node:crypto';

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
function readMaxDepth(source) {
  const match = /^\s*(?:const|let|var)\s+MAX_DEPTH\s*=\s*(-?\d+(?:\.\d+)?)\s*;/m.exec(source);
  if (!match) {
    throw new Error(
      'could not read MAX_DEPTH from src/constants.js. If its declaration moved ' +
      'or became computed, update this pattern rather than hardcoding a value.',
    );
  }
  return Number(match[1]);
}

function loadLegacySites(sitesSource, maxDepth) {
  const sandbox = { MAX_DEPTH: maxDepth };
  vm.createContext(sandbox);
  vm.runInContext(sitesSource, sandbox);
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

// Provenance is a digest of the exact inputs this output was derived from, not
// a commit id. `git rev-parse HEAD` at generation time always names the commit
// *before* the one that carries the generated file, so a commit id here is
// wrong by construction: the resources would claim to come from a tree whose
// sites.js produced different data. A digest is checkable, and `--check`
// verifies it, so stale provenance fails CI like stale data does.
//
// Hash normalised line endings, not raw bytes. With core.autocrlf a Windows
// working tree holds CRLF where Linux CI holds LF — identical content, different
// bytes — so a byte digest disagrees across platforms and fails CI for a machine
// difference rather than a data one. The generated resources are unaffected by
// line endings, so the digest must be too.
const readNormalised = (file) =>
  fs.readFileSync(path.join(root, 'src', file), 'utf8').replace(/\r\n?/g, '\n');

const sitesSource = readNormalised('sites.js');
const constantsSource = readNormalised('constants.js');
const maxDepth = readMaxDepth(constantsSource);
const sourceDigest = `sha256:${crypto
  .createHash('sha256')
  .update(sitesSource)
  .update(`|MAX_DEPTH=${maxDepth}`)
  .digest('hex')}`;

const sites = loadLegacySites(sitesSource, maxDepth);

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

const header = { schemaVersion: 1, sourceDigest, generator: 'npm run sites:generate' };

// `--check` verifies the committed resources still match what the legacy
// descriptors would generate, without rewriting them. CI runs this so an edit
// to sites.js that skips regeneration fails the build instead of leaving the
// resources quietly stale.
//
// `sourceDigest` is checked alongside the payload. It is derived from the input
// bytes rather than from git, so unlike a commit id it is a claim that can be
// true, and a stale one is caught here rather than shipping as false provenance.
if (process.argv.includes('--check')) {
  const stale = [];
  for (const { file, sites: expected } of DOCUMENTS) {
    const target = path.join(outputDirectory, file);
    if (!fs.existsSync(target)) {
      stale.push(`${file} is missing`);
      continue;
    }
    const committed = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (JSON.stringify(committed.sites) !== JSON.stringify(expected)) {
      stale.push(`${file} does not match src/sites.js`);
    }
    if (committed.sourceDigest !== sourceDigest) {
      stale.push(
        `${file} claims sourceDigest ${committed.sourceDigest ?? '(absent)'}, ` +
        `inputs hash to ${sourceDigest}`,
      );
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
  fs.mkdirSync(outputDirectory, { recursive: true });
  for (const { file, kind, sites: payload } of DOCUMENTS) {
    fs.writeFileSync(
      path.join(outputDirectory, file),
      `${JSON.stringify({ ...header, kind, sites: payload }, null, 2)}\n`,
      'utf8',
    );
  }
  console.log(`wrote ${Object.keys(gameplay).length} site resources to src/sites/resources/`);
}
