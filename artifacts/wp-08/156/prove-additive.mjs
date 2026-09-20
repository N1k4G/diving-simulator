// Additivity proof for #156. Strips every field this change adds from the
// regenerated fixture and asserts the remainder is byte-identical to the
// fixture as it stood before. Anything else that moved is a numerical change
// smuggled in with a schema change, which docs/decisions.md forbids.
import fs from "node:fs";
import crypto from "node:crypto";

const [beforePath, afterPath] = process.argv.slice(2);
const beforeText = fs.readFileSync(beforePath, "utf8");
const afterText = fs.readFileSync(afterPath, "utf8");
const before = JSON.parse(beforeText);
const after = JSON.parse(afterText);

const report = { strippedFields: 0, trajectorySteps: 0 };

// 1. Remove the added per-checkpoint trajectory.
for (const scenario of after.scenarios) {
  for (const checkpoint of scenario.checkpoints) {
    if (!("trajectory" in checkpoint)) throw new Error(`no trajectory on ${checkpoint.checkpointId}`);
    report.trajectorySteps += checkpoint.trajectory.length;
    delete checkpoint.trajectory;
    report.strippedFields += 1;
  }
}

// 2. Remove the added tolerance entry.
const exactIndex = after.tolerances.exact.indexOf("trajectory.length");
if (exactIndex === -1) throw new Error("tolerances.exact is missing trajectory.length");
after.tolerances.exact.splice(exactIndex, 1);
report.strippedFields += 1;

// 3. referenceCommit legitimately differs: it records the HEAD the fixture was
//    generated at. Report it rather than hiding it, then normalise it away.
report.referenceCommitBefore = before.referenceCommit;
report.referenceCommitAfter = after.referenceCommit;
report.referenceCommitChanged = before.referenceCommit !== after.referenceCommit;
after.referenceCommit = before.referenceCommit;

// 4. Byte comparison, in the generator's own serialisation.
const serialise = (value) => `${JSON.stringify(value, null, 2)}\n`;
const beforeSerialised = serialise(before);
const afterSerialised = serialise(after);

report.sha256Before = crypto.createHash("sha256").update(beforeSerialised).digest("hex");
report.sha256AfterStripped = crypto.createHash("sha256").update(afterSerialised).digest("hex");
report.byteIdentical = beforeSerialised === afterSerialised;

if (!report.byteIdentical) {
  const b = beforeSerialised.split("\n");
  const a = afterSerialised.split("\n");
  const diffs = [];
  for (let i = 0; i < Math.max(b.length, a.length) && diffs.length < 20; i += 1) {
    if (b[i] !== a[i]) diffs.push({ line: i + 1, before: b[i], after: a[i] });
  }
  report.firstDifferences = diffs;
  report.totalLinesBefore = b.length;
  report.totalLinesAfter = a.length;
}

console.log(JSON.stringify(report, null, 2));
process.exit(report.byteIdentical ? 0 : 1);
