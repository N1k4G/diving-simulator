# WP-01B measured Canvas stabilization

This evidence compares the rebased WP-01 Canvas renderer at `8382e61` with the
bounded-overlay renderer at `3159eee`.

## Result

The corrected WP-01B relative-hotspot gate passes in all six targeted runs:

- Wreck render p95 improves by 82.0% to 84.3% (48.8-52.9 ms to 8.3-8.8 ms);
  long frames fall from 300/300 to 0/300.
- Cave render p95 improves by 75.4% to 80.2% (24.8-29.8 ms to 5.6-6.1 ms);
  long frames fall from 134-174/300 to 0/300.
- No reported render metric in either targeted scene regresses by more than
  5%.
- Shore and reef were captured as guard scenes. Their optimized render p95
  remains at or below 2.2 ms and 3.4 ms respectively in this session.

See `desktop-reference/report.md` for the concise table and
`desktop-reference/comparison.json` for every reported metric and gate result.

## How much of this percentage is real

Read the improvement as a magnitude, not as a precise percentage. The gate
compares each run against its own session, and this harness is only stable
within a session. The same unoptimized wreck renderer at `8382e61` has measured
medians of 37.1-38.4 ms, 46.4-50.4 ms, and 224.6 ms across three separate
sessions on the same machine, and one of those sessions varied 5.5x internally.
The percentage therefore depends on the denominator this session happened to
produce.

What survives that noise is the shape of the change: the wreck engine room went
from missing the 16.67 ms budget on every single frame to missing it on none,
in three consecutive runs, at roughly a 7x median reduction. That conclusion is
robust; `-82.0%` is not.

## Method

The before and after captures started 109 seconds apart under comparison
session `wp01b-20260802-guarded-tip`. Each scene has three independent runs with
30 warmup frames followed by exactly 300 recorded frames at 759 x 839 CSS pixels
and DPR 1 in the same headless Chromium installation.

The capture yields between direct diagnostic frames, disables the diagnostics
DOM overlay, and pauses the background animation loop. Those measurement-only
adjustments were applied to both source commits. This prevents a synchronous
microbenchmark from filling the browser's deferred raster queue and measuring
periodic queue drains instead of representative per-frame submission cost.

The rebased parent was served from an ignored detached worktree. `before.json`
and `after.json` retain the shared comparison ID, capture start times, browser,
viewport, and DPR. The comparison script rejects mismatched acceptance classes,
sessions, environments, run coverage, sample counts, or capture windows longer
than 30 minutes.

## Visual and behavioral guard

`desktop-reference/visual-comparison.json` records a seeded, fixed-state DPR-1
pixel comparison after one direct `dt=0` frame:

- Wreck: 92.29% of pixels byte-identical; mean absolute channel delta
  0.076/255; maximum channel delta 18.
- Cave: 98.13% of pixels byte-identical; mean absolute channel delta
  0.009/255; maximum channel delta 7.

The small differences are consistent with compositing-rounding changes from
replacing snapshot/restore with transparent overlays. No pixel differs by more
than 64 on any channel in either scene. The comparison is deterministic: it
reproduced these figures exactly across two independent sessions.

Reproduce with `npm run baseline:visual-compare`. Note that this records
evidence and does not assert a threshold, so it is a review aid rather than a
CI gate. The complete Playwright suite, 347 browser assertions, lint, license
check, and generated golden traces pass. Regenerating the baseline changed only
its reference commit; the numerical scenario payload remained unchanged.

## Open follow-ups

- Reef render medians rose in all three guard runs (+6.3% to +31.2%) while the
  absolute delta stayed at or below 0.5 ms, on a path that strictly removed a
  `save`/`clip`/`restore`. Treated as harness noise; recheck if reef ever
  becomes a gated scene rather than a guard scene.
- The pixel comparison has no threshold and no failing exit code. It must gain
  a per-scene delta budget before the renderer slice can cite an automated
  Canvas-versus-PixiJS visual gate.

## Scope and rollback

This is diagnostic desktop evidence only. It does not establish Android or
iOS device acceptance, FPS, thermals, or a shipping device budget.

The optimization is isolated in `3df8550002670e0f0e31b52e8a790c3a6ea3c7dc` and
its rollback is a normal revert of that commit; no numerical model, save schema,
or golden trace changes are coupled to it.

`3159eee808c0fe39f5ad193ae2d6ad95fe0bbb88` is a separate correctness fix, not
part of the optimization. It routes the render sub-pass probes through the same
optional-observer guard `game-loop.js` uses, because calling
`window.baselineDiagnostics` directly from `renderer.js` froze the client
whenever `diagnostics.js` was omitted. Do not revert it together with the
optimization.
