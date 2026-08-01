# WP-06 acceptance record

Status: `IN_PROGRESS`

Last updated: 2026-08-01

## Implemented slice

- Renderer-independent `SceneRenderer` contract consuming immutable `PresentationState` plus explicitly provisional route/camera state.
- Production WebGL-first PixiJS renderer with a retained wreck cutaway, exterior-to-engine route, camera, diver, torch, bubbles, and silt.
- Development-only `?renderer=canvas` comparison adapter. The production build ignores the query and does not emit the adapter as a JavaScript chunk.
- Fixed-step `DiveModel` updates and copied-state planner forecasts through the existing same-origin module Worker.
- EN/DE semantic DOM HUD, keyboard and pointer controls, visually explicit/`role=alert` warnings, and a simulation-use boundary shown before renderer startup.
- Renderer-independent Web Audio service with the legacy 800 Hz warning and 600 Hz information tone definitions, an eight-voice cap, warning throttling, mute/suspend lifecycle, and a provisional breathing/bubbles/ambience mix.
- WP-05 local save restore and periodic/page-hide persistence wired into the new composition root.
- The legacy simulator remains available at `src/diving-simulator.html` and is unchanged by this slice.

## Automated evidence

| Gate | Evidence | Result |
| --- | --- | --- |
| Type safety | `npm run typecheck` | Pass |
| Lint and dependency boundaries | `npm run lint` | Pass |
| Unit contracts | `npm run test:unit` | Pass, including camera and development renderer selection |
| Production bundle | `npm run build` | Pass |
| Browser and legacy regression | `npm run test:e2e` | Pass |
| Use boundary | Browser test asserts no canvas exists before acceptance | Pass |
| Production renderer lock | Browser test loads `?renderer=canvas` and asserts `data-renderer="pixi"` | Pass |
| CSP compatibility | Production Worker uses a same-origin module URL permitted by `src/_headers` `worker-src 'self'` | Pass in browser automation; deployed-header verification remains a release check |
| Audio policy | Unit tests assert legacy tone definitions, warning throttle, and voice cap; browser test exercises mute | Pass locally |
| Save restore | Browser test changes authoritative depth, reloads, re-accepts the boundary, and observes the restored depth | Pass locally |

## Remaining WP-06 gates

- Extract or adapt enough legacy route input to run an automated same-input Canvas/Pixi trace comparison.
- Exercise low-gas, oxygen, and failure warning variants in browser accessibility tests.
- Validate Web Audio interruption/output behavior and memory on physical devices.
- Record sustained route performance, startup, resume, memory, and audio budgets on the supported physical-device matrix.

## External device evidence

No physical-device result is claimed from the desktop browser run.

| Platform | Device / OS | Owner | Status | Missing evidence |
| --- | --- | --- | --- | --- |
| Android 10+ | Not assigned | Not assigned | `BLOCKED_EXTERNAL` | Model, OS, chipset/RAM, 15-minute frame/memory trace, startup, audio, background/resume |
| iOS 16+ | Not assigned | Not assigned | `BLOCKED_EXTERNAL` | Model, OS, 15-minute frame/memory trace, startup, audio, interruption, background/resume |

WP-06 must remain `IN_PROGRESS` until these rows and the remaining gates are complete.
