# WP-01B desktop synthetic comparison

Before: `bcee12e`

After: `ee5f5ba7ae789b7163bdb3585e69cc4d62c7b48f`

This is yielded headless Chromium diagnostic evidence at 759 x 839 CSS px and DPR 1. It is not physical-device acceptance.

| Scene / run | Render median | Render p95 | Long frames | Gate |
| --- | ---: | ---: | ---: | --- |
| shore-meadow-1 | 1.5 -> 1.4 ms (-6.7%) | 2.6 -> 2.2 ms (-15.4%) | 0 -> 0 | guard scene |
| shore-meadow-2 | 1.2 -> 1.2 ms (-0.0%) | 2.2 -> 2.0 ms (-9.1%) | 0 -> 0 | guard scene |
| shore-meadow-3 | 1.4 -> 1.2 ms (-14.3%) | 2.2 -> 2.2 ms (-0.0%) | 0 -> 0 | guard scene |
| reef-plateau-1 | 3.4 -> 1.9 ms (-44.1%) | 7.0 -> 3.5 ms (-50.0%) | 0 -> 0 | guard scene |
| reef-plateau-2 | 2.0 -> 2.1 ms (5.0%) | 3.8 -> 3.6 ms (-5.3%) | 0 -> 0 | guard scene |
| reef-plateau-3 | 1.5 -> 1.9 ms (26.7%) | 2.7 -> 3.6 ms (33.3%) | 0 -> 0 | guard scene |
| wreck-engine-room-1 | 34.4 -> 6.1 ms (-82.3%) | 40.9 -> 9.8 ms (-76.0%) | 300 -> 0 | PASS |
| wreck-engine-room-2 | 34.5 -> 5.9 ms (-82.9%) | 38.4 -> 9.2 ms (-76.0%) | 300 -> 0 | PASS |
| wreck-engine-room-3 | 35.1 -> 5.8 ms (-83.5%) | 39.7 -> 7.8 ms (-80.4%) | 300 -> 0 | PASS |
| cave-upper-tunnel-1 | 19.2 -> 3.1 ms (-83.9%) | 25.4 -> 4.6 ms (-81.9%) | 300 -> 0 | PASS |
| cave-upper-tunnel-2 | 19.3 -> 3.3 ms (-82.9%) | 24.5 -> 4.8 ms (-80.4%) | 299 -> 0 | PASS |
| cave-upper-tunnel-3 | 16.5 -> 2.8 ms (-83.0%) | 19.5 -> 4.4 ms (-77.4%) | 137 -> 0 | PASS |

Corrected WP-01B gate: **PASS**.

The authoritative golden trace file was regenerated and remained byte-for-byte unchanged.
