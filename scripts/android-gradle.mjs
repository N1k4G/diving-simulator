// Runs the Android project's Gradle wrapper from npm scripts on any OS:
// gradlew.bat on Windows, gradlew elsewhere, inside android/. The arguments are
// passed through, e.g. `node scripts/android-gradle.mjs assembleDebug`. Needs a
// JDK 21 and an Android SDK (ANDROID_HOME, or sdk.dir in
// android/local.properties); see the README.
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const androidDirectory = path.resolve(import.meta.dirname, '..', 'android');
const windows = process.platform === 'win32';

// By absolute path: cmd.exe does not look in the current directory when
// NoDefaultCurrentDirectoryInExePath is set. A .bat file only runs through a
// shell (Node refuses to spawn one directly since CVE-2024-27980), so its path
// is quoted; the arguments are Gradle task names from package.json.
const wrapper = windows
  ? `"${path.join(androidDirectory, 'gradlew.bat')}"`
  : path.join(androidDirectory, 'gradlew');

const result = spawnSync(wrapper, process.argv.slice(2), {
  cwd: androidDirectory,
  stdio: 'inherit',
  shell: windows,
});

if (result.error) {
  console.error(`✗ could not run the Gradle wrapper: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
