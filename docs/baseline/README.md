# WP-01 baseline

The baseline freezes observable behavior before core or renderer extraction.

## Generate fixtures

```bash
npm run baseline:generate
```

The generator runs the current browser client, records deterministic model
checkpoints, and inventories the legacy in-browser tests. Do not hand-edit
calculated values in `tests/fixtures/traces/baseline-v1.json`. Change the
generator, review the behavior difference, and regenerate.

The scenarios drive the real `updateDiving()` lifecycle, including tissue and
gas consumption, CNS tracking, safety-stop state, event capture, CCR cylinder
use, a technical ascent and gas switch, and CCR bailout. Playwright replays
every checkpoint with the exact/epsilon/glob policy stored in the fixture; JSON
Schema validation is enforced with Ajv Draft 2020-12.

## Collect performance evidence

Open:

```text
src/diving-simulator.html?diagnostics=1
```

The overlay reports frame, update, planner, and render timing. The same data is
available through:

```js
window.gameAPI.resetDiagnostics({
  runId: 'wreck-engine-01',
  sceneId: 'wreck-engine',
  deviceId: 'recorded-device-id'
});

// Warm and capture at least 300 frames, then:
window.gameAPI.exportDiagnostics();
```

For deterministic direct CPU sampling with event-loop yielding between frames:

```js
window.gameAPI.runBaselineDiagnosticFrames(300, 0);
```

Direct sampling is useful for same-machine comparisons but does not measure
presented FPS or GPU pacing. The canonical harness disables the diagnostics
overlay, pauses the page's RAF loop, and yields after every warm-up and capture
frame so long synchronous tasks do not inflate the measurements. It passes
`dtReal=0` to isolate update/render CPU cost; the update metric therefore does
not represent the cost of a live simulation tick. A run containing a frame of
one second or more is treated as host/browser suspension and retried (up to
three attempts); repeated threshold failures abort the capture instead of
publishing misleading evidence.

Record at least 300 warmed samples per scene and device for each of three
independent runs. A device record must include model, OS, browser/WebView,
chipset and RAM where available, viewport, DPR, quality tier, source commit,
build identifier, and capture command. Desktop results do not satisfy a
physical-device acceptance gate.

The reproducible headless desktop reference can be captured after committing
the code under measurement:

```bash
npm run baseline:perf
```

It writes `artifacts/wp-01/desktop-reference/performance.json`. The artifact is
diagnostic evidence only and labels itself accordingly.

## Coverage boundaries

The generated fixture and test inventory record the full current Git commit as
their `referenceCommit`; tests require those values to agree. The legacy
harness remains the behavioral oracle until WP-12. Its current cases are
generated into `docs/baseline/test-inventory.json`; assertions migrate
incrementally rather than disappearing during extraction.

Controlled hypoxia/hyperoxia and injected failure traces remain in WP-03, where
the extracted model owns those transitions. Save/resume continuity remains in
WP-05 alongside schema migration. These are explicit deferrals, not claims of
current baseline coverage. Physical Android/iOS evidence, domain review, and
legal review remain `BLOCKED_EXTERNAL`.
