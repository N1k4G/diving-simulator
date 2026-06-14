# Research: Deco Stop Time Acceleration UX

> **Date**: 2026-05-07
> **Requested by**: @architect
> **Depth**: Quick scan — UX/game design pattern analysis
> **Sources**: TV Tropes Fast-Forward Mechanic trope analysis, established simulation game patterns (KSP, Cities: Skylines, RTS time-warp conventions), codebase review

---

## Recommendation: Hold-to-Accelerate (Option C)

### Why not the others?

| Option | Verdict | Reason |
|--------|---------|--------|
| **(A) Toggle multiplier** | ❌ Risky | Player forgets it's on → warps past gas changes, depth transitions, or stop completions. Requires a second action to cancel. |
| **(B) Skip-to-next-event** | ❌ Too abrupt | Skipping frames wholesale risks physics/tissue calculation drift. Also removes player agency — feels like cheating rather than convenience. |
| **(C) Hold-to-accelerate** | ✅ Best | Self-cancelling (release key = normal speed). Player stays engaged. No risk of runaway warp. Standard pattern in KSP (physics warp), flight sims, and RTS games (hold-speed-up). |
| **(D) Hybrid toggle+auto-cancel** | ⚠️ Acceptable fallback | Works but adds complexity. Consider as V2 if players request it. |

### The hold pattern is an **Anti-Frustration Feature** (TV Tropes classification) — it respects simulation fidelity while eliminating tedium. The player maintains continuous consent.

---

## Suggested Key Binding: `F` (Fast-forward)

**Rationale**:
- Unused during diving state (W=ascend, S=descend, 1-6=tank, H=help, I=info, M=mode)
- Left-hand accessible alongside W/S for simultaneous depth control
- Mnemonic: **F**ast-forward
- Not a modifier key, so no accidental OS conflicts
- Touch devices: add a `>>` button in the dive control area (near ascend/descend)

---

## Multiplier: **10x** (effective 30x real time)

The base `TIME_ACCELERATION = 3` means 1 real second = 3 dive seconds. During fast-forward:

| Multiplier | Effective | 26-min stop becomes | Notes |
|------------|-----------|---------------------|-------|
| 5x | 15x | ~104s (1:44) | Too slow, still boring |
| **10x** | **30x** | **~52s (0:52)** | **Sweet spot — visible countdown, no physics jitter** |
| 20x | 60x | ~26s | Risky — large dt jumps could cause depth oscillation |
| 50x | 150x | ~10s | Physics breaks — buoyancy model uses per-frame dt |

**10x is the ceiling for frame-coupled physics.** The buoyancy model (`updateBuoyancyPhysics(dtDiveSeconds)`) applies forces proportional to dt. At 10x, a 60fps frame simulates 0.5s of dive time per frame — still stable. At 20x (1.0s/frame), buoyancy oscillations become visible.

---

## Auto-Disengage Conditions

Fast-forward MUST stop immediately when ANY of these occur:

1. **Player releases `F`** — primary cancel (the whole point of hold-to-accelerate)
2. **Player presses `W` or `S`** — they're adjusting depth; warp would fight their input
3. **Diver leaves stop window** — depth deviates >1.5m from the current stop depth (e.g., current drift or buoyancy pulls them away)
4. **Deco stop depth changes** — current stop clears, next stop is shallower; player needs to ascend
5. **Safety stop completes** — no reason to keep warping
6. **Gas switch occurs** — player pressed a tank key; they need to see the result
7. **Diver surfaces** — depth ≤ 0

---

## Activation Guard

Fast-forward should ONLY be available when ALL of:
- `gameState === 'diving'`
- Diver is in a deco stop (`decoStopDepth > 0`) OR safety stop (`safetyStopCountdownStarted && !safetyStopComplete`)
- Diver is within ±1.5m of the stop depth (actually performing the stop, not just in deco obligation)

This prevents abuse — the player **cannot use fast-forward to skip stops**. They must be at the correct depth, performing the stop, for acceleration to engage.

---

## Implementation Sketch

```javascript
// Add near TIME_ACCELERATION constant
const FAST_FORWARD_MULTIPLIER = 10;
let fastForwardActive = false;

// In updateDiving():
var timeMultiplier = TIME_ACCELERATION;

// Check fast-forward eligibility
var atDecoStop = decoStopDepth > 0 && Math.abs(depth - decoStopDepth) <= 1.5;
var atSafetyStop = safetyStopCountdownStarted && !safetyStopComplete 
                   && Math.abs(depth - 5) <= 1.5;
var canFastForward = (atDecoStop || atSafetyStop);

if (keys['f'] && canFastForward) {
    fastForwardActive = true;
    timeMultiplier = TIME_ACCELERATION * FAST_FORWARD_MULTIPLIER;
} else {
    fastForwardActive = false;
}

// Auto-disengage on W/S press
if (fastForwardActive && (keys['w'] || keys['s'])) {
    fastForwardActive = false;
    timeMultiplier = TIME_ACCELERATION;
}

var dtDiveSeconds = dtReal * timeMultiplier;
```

---

## Visual Indicator

When fast-forward is active, display a `>>` icon or "FF" text on the dive computer. Suggested: flash a `>>` symbol near the TIME readout, with a subtle color (e.g., amber `#ffd24d`). This tells the player the warp is active without being obtrusive.

When fast-forward is available but not active (player is at stop depth, not pressing F), consider showing a subtle hint: `[F] >>` in dim text — but only the first few times (tutorial-style fade).

---

## Edge Cases to Watch

| Edge Case | Handling |
|-----------|----------|
| **Gas consumption during FF** | Already correct — gas calc uses `dtDiveSeconds`, which scales with the multiplier |
| **Tissue off-gassing during FF** | Already correct — Bühlmann compartment updates use `dtDiveMinutes` derived from `dtDiveSeconds` |
| **CNS/OTU accumulation** | Already correct — same dt path |
| **Multiple deco stops** | When stop 1 clears (e.g., 6m done, next is 3m), auto-disengage fires via condition #4. Player ascends to 3m, holds F again. |
| **Tank runs empty during FF** | Gas exhaustion logic already fires per-frame. Player will get the OOG warning at normal priority. Consider also auto-disengaging on OOG. |
| **Narcosis drift during FF** | Narcosis velocity drift scales with `dtReal`, not `dtDiveSeconds`. This is correct — FF should not amplify narcosis effects (the player isn't moving). |
| **CCR PO2 during FF** | CCR loop updates use dive-time dt. Should work, but verify scrubber/O2 consumption scales correctly. |

---

## Summary for Architect

- **Pattern**: Hold `F` to fast-forward (10x multiplier, effective 30x)
- **Guard**: Only works at deco/safety stop depth (±1.5m)
- **Cancel**: Release F, press W/S, drift off depth, stop clears, gas switch, or surface
- **Visual**: `>>` indicator near TIME display when active
- **Risk**: Low — all sim calculations already flow through `dtDiveSeconds`
- **Touch**: Add `>>` button to touch UI, same hold-to-activate behavior

NEXT: @architect
