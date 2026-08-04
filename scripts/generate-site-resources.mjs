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

function loadLegacySites() {
  const sandbox = { MAX_DEPTH: 100 };
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

const sites = loadLegacySites();
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
}).trim();

const gameplay = {};
const presentation = {};
for (const [id, site] of Object.entries(sites)) {
  assertPartitioned(site);
  gameplay[id] = pick(site, GAMEPLAY_FIELDS);
  presentation[id] = pick(site, PRESENTATION_FIELDS);
}

fs.mkdirSync(outputDirectory, { recursive: true });
const header = { schemaVersion: 1, sourceCommit, generator: 'npm run sites:generate' };
fs.writeFileSync(
  path.join(outputDirectory, 'gameplay.json'),
  `${JSON.stringify({ ...header, kind: 'diving-simulator-site-gameplay', sites: gameplay }, null, 2)}\n`,
  'utf8',
);
fs.writeFileSync(
  path.join(outputDirectory, 'presentation.json'),
  `${JSON.stringify({ ...header, kind: 'diving-simulator-site-presentation', sites: presentation }, null, 2)}\n`,
  'utf8',
);

console.log(`wrote ${Object.keys(gameplay).length} site resources to src/sites/resources/`);
