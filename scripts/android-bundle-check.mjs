// Ties the Android debug build to the web bytes the PR checks verified
// (#137 A3, #293).
//
// WHY. The APK packages the migration client's dist/. If the Android job built
// its own dist/, nothing would connect what ships inside the APK to the build
// that `npm run dist:check`, the unit tests and the browser tests looked at:
// a second Vite build is a second artifact, however similar. So pr.yml builds
// once, records the hash this script computes, and the Android job proves
// three things about the bytes it was handed:
//
//   hash <dir>               prints the tree hash of a directory, so the job
//                            that built dist/ can record it and every later
//                            step can compare against that record.
//   config [<file> ...]      refuses a Capacitor config that points the app at
//                            a dev server (`server.url`) or allows cleartext
//                            traffic (`server.cleartext`, what live reload
//                            sets). Without arguments it checks the
//                            repository's capacitor.config.json and refuses a
//                            capacitor.config.ts or .js beside it: a config
//                            that is code can compute `server.url` from the
//                            environment, which no static check can see.
//   apk <dir> <hash>         <dir> is an unpacked APK. Its assets/public/ must
//                            hash to <hash> once Capacitor's two Cordova stubs
//                            are set aside, and the stubs must be empty; its
//                            assets/capacitor.config.json must pass `config`.
//
// THE TREE HASH. SHA-256 over one line per file, "<sha256 of the file>  <path
// relative to the directory, with forward slashes>\n", sorted by path in byte
// order. It is what `find . -type f -printf '%P\n' | LC_ALL=C sort | xargs
// sha256sum | sha256sum` prints from inside the directory with GNU coreutils
// on Linux, so anyone can reproduce it without this script (`%P` drops the
// leading "./"; Windows' sha256sum marks binary files with "*" and differs). Every file counts, empty and dot files included.
//
// THE CORDOVA STUBS. `cap sync` writes cordova.js and cordova_plugins.js into
// the native project's copy of dist/ (@capacitor/cli, dist/cordova.js). With no
// Cordova plugin installed both are empty. They are the only files the APK's
// web root may carry beyond dist/; anything else, or a stub with content,
// fails, so adding a Cordova plugin has to be a deliberate change here.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

const CAPACITOR_STUBS = ['cordova.js', 'cordova_plugins.js'];

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function* walk(directory, prefix = '') {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full, relative);
    } else if (entry.isFile()) {
      yield relative;
    } else {
      // A symlink or a device has no bytes of its own to hash, and an APK
      // cannot carry one. Refuse rather than silently leave it out.
      fail(`${full} is neither a file nor a directory.`);
    }
  }
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

// Byte order, as `LC_ALL=C sort` orders: compare UTF-8 encodings, not
// localeCompare, which would put "B" after "a".
function byteOrder(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function treeHash(directory, { exclude = [] } = {}) {
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    fail(`${directory} is not a directory.`);
  }
  const files = [...walk(directory)].filter((file) => !exclude.includes(file)).sort(byteOrder);
  if (files.length === 0) {
    fail(`${directory} contains no files; an empty tree proves nothing.`);
  }
  const manifest = files
    .map((file) => `${sha256(fs.readFileSync(path.join(directory, file)))}  ${file}\n`)
    .join('');
  return { hash: sha256(manifest), files: files.length };
}

function configProblems(file) {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return [`${file} cannot be read as JSON: ${error.message}`];
  }
  const problems = [];
  const server = config.server ?? {};
  if (typeof server !== 'object' || Array.isArray(server)) {
    problems.push(`${file} has a \`server\` that is not an object.`);
  } else {
    if (server.url !== undefined) {
      problems.push(
        `${file} sets server.url (${JSON.stringify(server.url)}): the app would load a dev ` +
          'server instead of the bytes packaged into it. Live reload is a local workflow; ' +
          'never commit it.',
      );
    }
    if (server.cleartext !== undefined && server.cleartext !== false) {
      problems.push(
        `${file} sets server.cleartext (${JSON.stringify(server.cleartext)}): that allows ` +
          'plain-HTTP traffic, which only live reload needs.',
      );
    }
  }
  if (config.webDir !== undefined && config.webDir !== 'dist') {
    problems.push(`${file} packages ${JSON.stringify(config.webDir)}, not the verified dist/.`);
  }
  return problems;
}

function checkConfigs(files) {
  const problems = files.flatMap(configProblems);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`✗ ${problem}`);
    process.exit(1);
  }
}

const [mode, ...args] = process.argv.slice(2);

if (mode === 'hash' && args.length === 1) {
  const { hash } = treeHash(path.resolve(args[0]));
  console.log(hash);
} else if (mode === 'config') {
  let files = args.map((file) => path.resolve(file));
  if (files.length === 0) {
    const code = ['capacitor.config.ts', 'capacitor.config.js'].filter((name) =>
      fs.existsSync(path.join(root, name)),
    );
    if (code.length > 0) {
      fail(
        `${code.join(' and ')} found. The Capacitor config is capacitor.config.json, a static ` +
          'file, so that this check sees exactly what `cap sync` will package.',
      );
    }
    files = [path.join(root, 'capacitor.config.json')];
  }
  checkConfigs(files);
  console.log(`Capacitor config is production-safe: ${files.length} file(s), no server.url, no cleartext.`);
} else if (mode === 'apk' && args.length === 2) {
  const [unpacked, expected] = args;
  const publicDirectory = path.resolve(unpacked, 'assets', 'public');
  for (const stub of CAPACITOR_STUBS) {
    const file = path.join(publicDirectory, stub);
    if (fs.existsSync(file) && fs.statSync(file).size !== 0) {
      fail(
        `the APK's ${stub} is not empty. With no Cordova plugin, \`cap sync\` writes it empty; ` +
          'content there is code the verified dist/ never contained.',
      );
    }
  }
  const { hash, files } = treeHash(publicDirectory, { exclude: CAPACITOR_STUBS });
  if (hash !== expected) {
    fail(
      `the APK's web assets hash to ${hash}, the verified dist/ to ${expected}. ` +
        'The APK does not package the bytes the PR checks verified.',
    );
  }
  checkConfigs([path.resolve(unpacked, 'assets', 'capacitor.config.json')]);
  console.log(
    `APK packages the verified dist/: ${files} files, tree hash ${hash}; ` +
      'its Capacitor config is production-safe.',
  );
} else {
  fail(
    'usage: android-bundle-check.mjs hash <dir> | config [<capacitor.config.json> ...] | ' +
      'apk <unpacked-apk-dir> <expected-tree-hash>',
  );
}
