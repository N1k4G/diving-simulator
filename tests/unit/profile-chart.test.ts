import { describe, expect, it } from "vitest";

import { profileChartGeometry } from "../../src/app/profile-chart";
import type { DiveProfileSample, DiveViolationEntry, DrillOutcomeEntry } from "../../src/core/dive-state";
import { metres, seconds } from "../../src/core/units";
import type { PostDiveSummary } from "../../src/presentation/post-dive-summary";

// The dive-profile chart's geometry (#159), legacy's drawDiveProfileChart():
// its scales, grid, ceiling runs and markers, as fractions of the plot.

function sample(timeS: number, depthM: number, ceilingM = 0): DiveProfileSample {
  return { elapsedTimeS: seconds(timeS), depthM: metres(depthM), ceilingM: metres(ceilingM) };
}

function summary(
  profile: readonly DiveProfileSample[],
  violations: readonly DiveViolationEntry[] = [],
  elapsedTimeS = profile.at(-1)?.elapsedTimeS ?? 0,
  drillOutcomes: readonly DrillOutcomeEntry[] = [],
): PostDiveSummary {
  return { elapsedTimeS, profile, violations, drillOutcomes } as unknown as PostDiveSummary;
}

describe("the dive-profile chart's geometry", () => {
  it("draws nothing for fewer than two samples, as legacy", () => {
    expect(profileChartGeometry(summary([]))).toBeNull();
    expect(profileChartGeometry(summary([sample(0, 5)]))).toBeNull();
  });

  it("scales depth to the deepest sample and time to the dive's length", () => {
    const geometry = profileChartGeometry(summary([sample(0, 0), sample(600, 24), sample(1200, 0)], [], 1230))!;
    expect(geometry.maxDepthM).toBe(24);
    expect(geometry.maxTimeS).toBe(1230);
    expect(geometry.depth).toEqual([[0, 0], [600 / 1230, 1], [1200 / 1230, 0]]);
    // A line every 10 m above the deepest point.
    expect(geometry.gridDepthsM).toEqual([10, 20]);
  });

  it("keeps legacy's floors of a metre and a minute", () => {
    const geometry = profileChartGeometry(summary([sample(0, 0), sample(20, 0.4)]))!;
    expect(geometry.maxDepthM).toBe(1);
    expect(geometry.maxTimeS).toBe(60);
    expect(geometry.gridDepthsM).toEqual([]);
  });

  it("draws the ceiling only where there was one, one run per stretch", () => {
    const geometry = profileChartGeometry(summary([
      sample(0, 40), sample(100, 40, 3), sample(200, 40, 6), sample(300, 9, 0),
      sample(400, 9, 0), sample(500, 30, 3), sample(600, 0, 0),
    ]))!;
    expect(geometry.ceiling).toEqual([
      [[100 / 600, 3 / 40], [200 / 600, 6 / 40]],
      [[500 / 600, 3 / 40]],
    ]);
    expect(geometry.deepestCeilingM).toBe(6);
  });

  it("puts each entry at the nearest sample's depth, and a skipped stop at the end at 5 m", () => {
    const geometry = profileChartGeometry(summary(
      [sample(0, 0), sample(100, 20), sample(200, 12), sample(300, 0)],
      [
        { kind: "ceiling-violation", elapsedTimeS: seconds(140), value: 1 },
        { kind: "fast-ascent", elapsedTimeS: seconds(260), value: 12 },
        { kind: "safety-stop-skipped", elapsedTimeS: seconds(310), value: 0 },
      ],
      310,
    ))!;
    expect(geometry.markers).toEqual([
      { number: 1, kind: "ceiling-violation", x: 140 / 310, y: 20 / 20 },
      { number: 2, kind: "fast-ascent", x: 260 / 310, y: 0 },
      { number: 3, kind: "safety-stop-skipped", x: 300 / 310, y: 5 / 20 },
    ]);
    expect(geometry.drillMarkers).toEqual([]);
  });

  it("puts a drill's outcome at its time and the nearest sample's depth, unnumbered (#160)", () => {
    const geometry = profileChartGeometry(summary(
      [sample(0, 0), sample(100, 20), sample(200, 12), sample(300, 0)],
      [{ kind: "fast-ascent", elapsedTimeS: seconds(260), value: 12 }],
      300,
      // 150 s is as near 100 s as 200 s: legacy keeps the earlier sample.
      [{ kind: "drill-outcome", elapsedTimeS: seconds(150), drillId: "freeflow", option: 1, correct: false }],
    ))!;
    expect(geometry.drillMarkers).toEqual([
      { drillId: "freeflow", elapsedTimeS: 150, correct: false, x: 150 / 300, y: 20 / 20 },
    ]);
    // The violations keep their numbers: the drill is not one of them.
    expect(geometry.markers).toEqual([{ number: 1, kind: "fast-ascent", x: 260 / 300, y: 0 }]);
  });
});
