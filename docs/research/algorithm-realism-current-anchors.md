# Algorithm realism audit: current source anchors

This index re-anchors the 2026-05-01
`algorithm-realism-audit.md` verdicts after the application was split from one
HTML file into JavaScript modules. It does **not** repeat or upgrade the
original review: verdicts remain historical until a qualified reviewer checks
the cited implementation at a release commit.

Anchors are recorded against reference commit `30c151f`. Line numbers are
navigation aids; the named symbol is the durable anchor.

| Audit item | Historical verdict | Current implementation anchor |
| ---: | --- | --- |
| 1. ZHL-16C N2 half-times | Correct | `src/constants.js:328`, `ZHL16C_N2` |
| 2. ZHL-16C N2 a/b coefficients | Correct | `src/constants.js:328`, `ZHL16C_N2` |
| 3. ZHL-16C He half-times | Correct | `src/constants.js:348`, `ZHL16C_HE` |
| 4. ZHL-16C He a/b coefficients | Correct | `src/constants.js:348`, `ZHL16C_HE` |
| 5. Tissue loading | Correct | `src/physics.js:208`, `updateTissues` |
| 6. Combined a/b | Correct | `src/physics.js:244`, `combinedAB`; `src/physics.js:255`, `combinedABSim` |
| 7. M-value / ceiling | Correct | `src/physics.js:305`, `calculateCeiling` |
| 8. GF interpolation | Correct | `src/physics.js:349`, inner `gfAtDepth` in `calculateDecoSchedule` |
| 9. NDL | Correct | `src/physics.js:266`, `calculateNDL` |
| 10. Deco schedule | Correct | `src/physics.js:330`, `calculateDecoSchedule` |
| 11. BCD inflate/vent rates | Acceptable | `src/constants.js:58`, `BUOYANCY_PARAMS`; `src/physics.js:41`, `inflateBCD`; `src/physics.js:62`, `ventBCD` |
| 12. Boyle's law / BCD relief | Correct | `src/physics.js:69`, `updateBuoyancyPhysics` |
| 13. Wetsuit compression | Acceptable | `src/constants.js:58`, `BUOYANCY_PARAMS`; `src/physics.js:69`, `updateBuoyancyPhysics` |
| 14. Drag coefficient | Acceptable | `src/constants.js:58`, `BUOYANCY_PARAMS`; `src/physics.js:69`, `updateBuoyancyPhysics` |
| 15. Buoyant force | Correct | `src/physics.js:69`, `updateBuoyancyPhysics` |
| 16. Surface dead zone | Correct | `src/constants.js:58`, `BUOYANCY_PARAMS`; `src/physics.js:69`, `updateBuoyancyPhysics` |
| 17. SAC/RMV depth scaling | Correct | `src/game-loop.js:29`, `effectiveAMV`; `src/game-loop.js:637`, open-circuit consumption |
| 18. MOD | Correct | `src/physics.js:481`, `calculateMOD` |
| 19. Minimum hypoxic depth | Correct | `src/physics.js:490`, `calculateMinDepth` |
| 20. END | Correct | `src/physics.js:557`, `calculateEND` |
| 21. Tank gas consumption | Correct | `src/game-loop.js:620-665`, gas-consumption update |
| 22. CCR metabolic O2 | Correct | `src/state.js:393`, `CCR_DEFAULTS`; `src/state.js:461`, `updateCCRLoop` |
| 23. CCR PO2 solenoid response | Acceptable | `src/state.js:393`, `CCR_DEFAULTS`; `src/state.js:461`, `updateCCRLoop` |
| 24. CCR scrubber duration | Correct | `src/state.js:393`, `CCR_DEFAULTS`; `src/state.js:461`, `updateCCRLoop` |
| 25. CCR diluent consumption | Minor bug | `src/state.js:534`, `updateCCRDiluent` |
| 26. CCR loop gas fractions | Correct | `src/physics.js:587`, `getCCRInspiredGas` |
| 27. N2 narcosis weighting | Correct | `src/physics.js:551`, `calculateNarcoticPP` |
| 28. O2 narcosis contribution | Correct | `src/physics.js:551`, `calculateNarcoticPP` |
| 29. He non-narcotic treatment | Correct | `src/physics.js:551`, `calculateNarcoticPP` |
| 30. Depth-to-pressure | Acceptable | `src/physics.js:37`, `ambientPressure` |
| 31. Water-vapor pressure | Correct | `src/constants.js:145`, `P_H2O`; `src/physics.js:208`, `updateTissues` |
| 32. Initial N2 loading | Correct | `src/constants.js:147`, `INITIAL_N2_LOADING`; `src/state.js:931`, `initTissues` |
| 33. Ascent/descent limits | Correct | `src/constants.js:58`, `BUOYANCY_PARAMS`; `src/constants.js:118`, `BAROTRAUMA_RATE`; `src/game-loop.js:772`, injury timer |
| 34. Safety-stop logic | Correct | `src/constants.js:115-116`, active depth band; `src/game-loop.js:820-851`, state machine |
| 35. BCD inflation from tank | Correct | `src/physics.js:41`, `inflateBCD` |

Before any row is accepted as release evidence, the reviewer must record the
reviewed commit, sources, locales/territories, disposition, and exceptions in
`docs/baseline/claims-register.json` or its successor.
