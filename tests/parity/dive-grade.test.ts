import { describe, expect, it } from "vitest";

import baselineFixture from "../fixtures/traces/baseline-v1.json";
import { formatGradeNote } from "../../src/app/debrief-grade";
import {
  diveStateFromLegacyCheckpoint,
  type LegacyProfileSample,
  type LegacyTissueCheckpoint,
} from "../../src/app/legacy-dive-adapter";
import { gradeDive } from "../../src/core/dive-grade";
import { siteGameplay } from "../../src/sites/site-resources";

// gradeDive() (#199 slice 6b) against the legacy client: every checkpoint of
// every recorded dive carries legacy's own grade (state.grade: the five
// scores, their English notes, overall and stars, as the post-dive screen
// would show them at that moment). The model's state at the checkpoint, built
// by the adapter with the profile so far, must grade the same, to the word.

interface Checkpoint extends LegacyTissueCheckpoint {
  checkpointId: string;
  state: LegacyTissueCheckpoint["state"] & {
    diveSite: string;
    grade: { scores: number[]; notes: string[]; overall: number; stars: number };
  };
  profile: LegacyProfileSample[];
}

const scenarios = baselineFixture.scenarios as unknown as { scenarioId: string; checkpoints: Checkpoint[] }[];

const cases = scenarios.flatMap((scenario) =>
  scenario.checkpoints.map((recorded, index) => ({
    name: `${scenario.scenarioId}/${recorded.checkpointId}`,
    recorded,
    earlierProfile: scenario.checkpoints.slice(0, index).flatMap((earlier) => earlier.profile),
  })),
);

describe("gradeDive against the recorded legacy dives", () => {
  it.each(cases)("grades $name as legacy does", ({ recorded, earlierProfile }) => {
    const state = diveStateFromLegacyCheckpoint(recorded, 7, earlierProfile);
    const grade = gradeDive(state, { overheadSite: siteGameplay(recorded.state.diveSite)?.hasOverhead ?? false });
    const legacy = recorded.state.grade;
    expect(grade.scores.map((entry) => entry.score)).toEqual(legacy.scores);
    expect(grade.scores.map((entry) => formatGradeNote(entry.note, "en"))).toEqual(legacy.notes);
    expect(grade.overall).toBe(legacy.overall);
    expect(grade.stars).toBe(legacy.stars);
  });

  it("has recorded grades that exercise more than a clean dive", () => {
    // Guards the comparison against a fixture whose grades are all alike:
    // the recorded dives reach a skipped safety stop, fast ascents, a broken
    // ceiling and the reserve third, and both gas-reserve rules.
    const notes = new Set(cases.flatMap(({ recorded }) => recorded.state.grade.notes.map((note) => note.split(" ")[0])));
    const scores = cases.map(({ recorded }) => recorded.state.grade.scores);
    expect(scores.some((s) => s[0]! < 100)).toBe(true);
    expect(scores.some((s) => s[1]! < 100)).toBe(true);
    expect(scores.some((s) => s[2]! < 100)).toBe(true);
    expect(scores.some((s) => s[3]! < 100)).toBe(true);
    expect([...notes].some((word) => word === "Surfaced")).toBe(true);
    expect([...notes].some((word) => word === "Rule-of-thirds" || word === "Dropped")).toBe(true);
  });
});
