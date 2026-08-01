# WP-01B measured Canvas stabilization

This evidence compares the legacy Canvas renderer at `bcee12e` with the
no-readback renderer at `ee5f5ba7ae789b7163bdb3585e69cc4d62c7b48f`.

## Result

The corrected WP-01B desktop synthetic gate passes in all six targeted runs:

- Wreck render p95 improves by 76.0% to 80.4%; long frames fall from 300/300
  to 0/300 in every run.
- Cave render p95 improves by 77.4% to 81.9%; long frames fall from 137-300
  to 0/300.
- No reported render metric in either targeted scene regresses by more than
  5%.
- Shore and reef were captured as guard scenes. Their absolute render times
  remain below 4 ms p95 in the optimized artifact.

See `desktop-reference/report.md` for the concise table and
`desktop-reference/comparison.json` for every reported metric and gate result.

## Method

Each scene has three independent runs with 30 warmup frames followed by
exactly 300 recorded frames at 759 x 839 CSS pixels and DPR 1 in the same
headless Chromium installation.

The capture yields between direct diagnostic frames, disables the diagnostics
DOM overlay, and pauses the background animation loop. Those measurement-only
adjustments were applied to both source commits. This prevents a synchronous
microbenchmark from filling the browser's deferred raster queue and measuring
periodic queue drains instead of representative per-frame submission cost.

The archived pre-optimization source was served from an ignored `.tmp`
snapshot. The four `before-*.json` files are its directly captured artifacts;
`before.json` combines them without changing run metrics.

## Visual and behavioral guard

`desktop-reference/visual-comparison.json` records a seeded, fixed-state DPR-1
pixel comparison after one direct `dt=0` frame:

- Wreck: 92.29% of pixels byte-identical; mean absolute channel delta
  0.076/255; maximum channel delta 18.
- Cave: 98.13% of pixels byte-identical; mean absolute channel delta
  0.009/255; maximum channel delta 7.

The small differences are consistent with compositing-rounding changes from
replacing snapshot/restore with transparent overlays. The complete Playwright
suite, 347 browser assertions, lint, license check, and generated golden traces
pass. Regenerating the baseline left the authoritative trace file unchanged.

## Scope and rollback

This is diagnostic desktop evidence only. It does not establish Android or
iOS device acceptance, FPS, thermals, or a shipping device budget.

The implementation is isolated in one source commit. Its rollback is a normal
revert of `ee5f5ba7ae789b7163bdb3585e69cc4d62c7b48f`; no numerical model, save
schema, or golden trace changes are coupled to it.
