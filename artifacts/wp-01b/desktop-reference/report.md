# WP-01B desktop relative-hotspot comparison

Before: `8382e6135604d86b4f78ecf44f7bcab384ee004c`

After: `3159eee808c0fe39f5ad193ae2d6ad95fe0bbb88`

Comparison session: `wp01b-20260802-guarded-tip`

Captures started at 2026-08-02T16:21:57.327Z and 2026-08-02T16:23:46.320Z.

This is back-to-back, yielded headless Chromium relative-hotspot evidence at 759 x 839 CSS px and DPR 1. It is not physical-device acceptance.

| Scene / run | Render median | Render p95 | Long frames | Gate |
| --- | ---: | ---: | ---: | --- |
| shore-meadow-1 | 1.2 -> 0.9 ms (-25.0%) | 1.9 -> 1.8 ms (-5.3%) | 0 -> 0 | guard scene |
| shore-meadow-2 | 1.0 -> 0.9 ms (-10.0%) | 1.8 -> 1.6 ms (-11.1%) | 0 -> 0 | guard scene |
| shore-meadow-3 | 1.0 -> 1.3 ms (30.0%) | 2.0 -> 2.2 ms (10.0%) | 0 -> 0 | guard scene |
| reef-plateau-1 | 1.6 -> 1.9 ms (18.7%) | 3.0 -> 3.4 ms (13.3%) | 0 -> 0 | guard scene |
| reef-plateau-2 | 1.6 -> 2.1 ms (31.2%) | 3.1 -> 3.3 ms (6.5%) | 0 -> 0 | guard scene |
| reef-plateau-3 | 1.6 -> 1.7 ms (6.3%) | 2.9 -> 3.1 ms (6.9%) | 0 -> 0 | guard scene |
| wreck-engine-room-1 | 38.0 -> 5.6 ms (-85.3%) | 48.8 -> 8.8 ms (-82.0%) | 300 -> 0 | PASS |
| wreck-engine-room-2 | 38.4 -> 5.3 ms (-86.2%) | 52.9 -> 8.3 ms (-84.3%) | 300 -> 0 | PASS |
| wreck-engine-room-3 | 37.1 -> 5.5 ms (-85.2%) | 50.6 -> 8.7 ms (-82.8%) | 300 -> 0 | PASS |
| cave-upper-tunnel-1 | 16.7 -> 3.5 ms (-79.0%) | 24.8 -> 5.6 ms (-77.4%) | 151 -> 0 | PASS |
| cave-upper-tunnel-2 | 17.5 -> 3.6 ms (-79.4%) | 29.8 -> 5.9 ms (-80.2%) | 174 -> 0 | PASS |
| cave-upper-tunnel-3 | 16.3 -> 3.8 ms (-76.7%) | 24.8 -> 6.1 ms (-75.4%) | 134 -> 0 | PASS |

Corrected WP-01B gate: **PASS**.

The authoritative golden trace was regenerated; its numerical scenario payload remained unchanged.
