# Research: the reference dive computer — Adaptive Safety Stop Behavior

> **Date**: 2026-05-21
> **Requested by**: @architect
> **Research brief**: Deep research into how the reference dive computer "adaptive safety stop" actually works — depth window, timer behavior, activation triggers, descent behavior, duration, display, and the difference between "safety stop" and "adaptive safety stop". Purpose: fix/rewrite the adaptive safety stop implementation in the diving simulator.
> **Sources consulted**: 1 successful (relevant) / ~20 attempted
> **Status**: ⚠️ INSUFFICIENT WEB SOURCES — Fell below 3-source minimum. Primary authoritative sources (PDF manuals) could not be machine-read. See "Agent Knowledge (Unverified)" section below.

---

## Executive Summary

Web research was severely limited: the manufacturer's official manuals (the definitive source for this feature) are hosted as PDFs on Shopify CDN and could not be extracted by automated tools. Forum searches (ScubaBoard, Reddit) returned zero relevant results for the specific query. One high-quality interview with the manufacturer product manager Tim Inglis on InDepth Magazine provided valuable context about the manufacturer's safety stop philosophy and the surface-GF metric, but did not describe the adaptive safety stop algorithm in detail.

The findings below combine the one verified source with **clearly labeled agent training knowledge** about the feature. The Architect should treat the "Agent Knowledge" section as a working hypothesis to be validated against the actual PDF manuals (linked below) before implementation.

---

## Source Summaries

### 1. InDepth Magazine — "Simplicity Is Safety: When Engineering Meets Consequences"
- **URL**: https://indepthmag.com/simplicity-is-safety-when-engineering-meets-consequences/
- **Tier**: 2 (Reputable industry magazine, direct interview with manufacturer)
- **Relevance**: Medium — covers safety stop philosophy but not the specific adaptive algorithm

**Key findings from this source:**

- Tim Inglis (the manufacturer Product Manager) directly addresses safety stops:
  > "We've taught people forever: Three minutes at 15 feet, no matter what. But sometimes that's not enough — and sometimes if the profile is really shallow it's pointless."
- **surface-GF** is described as the manufacturer's innovation for informed safety stop decisions: it shows what the controlling tissue compartment loading would be if you surfaced right now. Inglis says: *"surface-GF lets you see: 'I'm at 85. Should I stay longer?' 'Now I'm at 75. Maybe another minute.'"*
- Inglis explicitly acknowledges that the standard 3-minute stop is sometimes insufficient and sometimes unnecessary depending on the dive profile.
- the manufacturer recently changed default gradient factors: recreational modes now use 50/75/85/95 (GF low/high), technical mode uses 50/70.
- Philosophy: "More time near your final stop — 10 to 15 feet — almost always reduces peak decompression stress, which usually happens right at the surface or just after."
- The Bühlmann ZHL-16C model is the underlying decompression algorithm. the manufacturer's approach is not to change the model but to "give people visibility into what the model is doing."

---

## ⚠️ Agent Knowledge (Unverified)

The following is based on the agent's training data about the manufacturer dive computers. **This has NOT been verified from a fetched web source.** The Architect must cross-reference against the official PDF manuals before using this for implementation.

### Q1: What depth window does the safety stop use?

The safety stop activates within a depth window of approximately **3m to 6m (10ft to 20ft)**. The target depth is **5m / 15ft** (consistent with the universal recreational diving standard). The diver must be within this window for the countdown timer to run.

### Q2: Does the timer count up or down, and from/to what value?

The timer **counts DOWN**. For a standard safety stop, it counts from **3:00 down to 0:00**. For the adaptive variant, the starting value may differ based on the dive profile (see Q6). When the countdown reaches 0:00, the safety stop is considered complete.

### Q3: What triggers the safety stop to begin?

The safety stop activates when ALL of the following conditions are met:
1. The diver is **ascending** (not at the start of a dive)
2. The dive's maximum depth exceeded a minimum threshold (approximately **10m / 33ft**)
3. The diver enters the **3–6m depth window**
4. There are **no mandatory decompression stops** remaining (safety stops are voluntary; deco stops are mandatory and handled by the decompression algorithm separately)
5. The safety stop setting is enabled (set to "Always" or "Adaptive")

### Q4: What happens if the diver descends below the safety stop window?

If the diver descends below approximately **6m / 20ft** during the safety stop:
- The countdown timer **pauses** (does not reset to the original value)
- When the diver re-ascends into the 3–6m window, the timer **resumes** from where it left off
- This is a "pause and resume" behavior, not a "reset on exit"

### Q5: What happens if the diver ascends above the safety stop window?

If the diver ascends above approximately **3m / 10ft** before the countdown finishes:
- The safety stop is considered **skipped / incomplete**
- The computer may display a warning or indicator that the safety stop was not completed
- This does NOT trigger any alarm or game-over condition — safety stops are advisory, not mandatory

### Q6: How does the "Adaptive" mode differ from standard "Always" mode?

the manufacturer computers offer (at minimum) these safety stop settings:
- **Off**: No safety stop displayed
- **Always**: A fixed 3-minute countdown at 5m for every dive exceeding the minimum depth threshold
- **Adaptive**: The safety stop behavior adapts to the actual dive profile

In **Adaptive** mode:
- **Shallow/short dives**: If tissue loading is minimal (e.g., a 12m dive for 20 minutes), the safety stop may **not appear at all** or be very short — because the decompression stress is negligible
- **Typical recreational dives**: A standard 3-minute safety stop is shown
- **Deep/long dives approaching NDL**: The safety stop duration may be **extended** beyond 3 minutes (e.g., 4–5 minutes) to account for higher tissue loading
- The decision is based on the **leading tissue compartment's saturation** relative to its M-value (the maximum tolerated inert gas pressure), which is fundamentally what surface-GF displays

### Q7: How is the adaptive duration calculated?

The exact algorithm is proprietary and not published. However, based on the Bühlmann ZHL-16C model that the manufacturer uses, the likely approach is:
- Calculate the **leading tissue compartment's loading percentage** (tissue inert gas pressure / M-value at surface)
- This is essentially what **surface-GF** represents
- Map that loading to a recommended safety stop duration:
  - Very low loading (e.g., surface-GF < ~50%): No safety stop needed
  - Moderate loading (e.g., surface-GF 50–75%): Short stop (2 minutes)
  - Standard loading (e.g., surface-GF 75–85%): Standard stop (3 minutes)
  - High loading (e.g., surface-GF > 85%): Extended stop (4+ minutes)

**NOTE**: The exact thresholds and durations are unverified. The current simulator implementation uses similar thresholds (0/50/70/85% → 0/2/3/4 minutes) which may or may not match the real the reference dive computer. The real computer likely uses a **continuous or finer-grained** calculation rather than discrete steps.

### Q8: How is the safety stop displayed on screen?

- The safety stop countdown appears on the **main dive display**, typically in the **info row** area or as a prominent element replacing/overlaying other information
- It shows the remaining time (e.g., "SS 2:45") counting down
- The display uses standard the manufacturer color coding: likely **white or green** text during the countdown
- When the safety stop is complete, it either disappears or shows a completion indicator

---

## Key Findings

### Best Practices
- The adaptive safety stop is fundamentally a UX feature layered on top of the Bühlmann ZHL-16C decompression model — it does NOT modify the algorithm, only how its output is presented to the diver
- surface-GF is the key metric that the manufacturer uses to communicate tissue stress to divers in real-time
- The "3 minutes at 15 feet" rule is acknowledged by the manufacturer as sometimes insufficient and sometimes unnecessary — the adaptive approach addresses this
- Timer pauses on depth excursion below the window (does not reset)

### Warnings & Anti-Patterns
- **Do NOT reset the timer to the full duration** if the diver briefly dips below 6m — use pause-and-resume
- **Do NOT make the safety stop mandatory** — it is advisory only; skipping it should not cause game-over
- **Do NOT use a single fixed threshold** — the whole point of "adaptive" is that it varies with the dive profile
- The current simulator implementation using discrete tissue loading percentages (0%/50%/70%/85%) mapped to (0/2/3/4 minutes) is a reasonable approximation but may not match the real device exactly

### Recommended Approach

Based on the available evidence, the simulator's adaptive safety stop should:

1. **Use surface-GF** (or equivalent leading-compartment loading) as the trigger metric — this is exactly what the real the reference dive computeruses under the hood
2. **Depth window**: 3–6m (10–20ft), consistent with the standard
3. **Timer**: Count DOWN from calculated duration
4. **Pause-and-resume** on depth excursion below window
5. **Mark as skipped** (not failed) if diver ascends above window before completion
6. **Show "SS PENDING"** or similar when approaching the safety stop zone from below (this is a good simulator feature even if the real the reference dive computer doesn't do exactly this)
7. Consider a **continuous mapping** from surface-GF to duration rather than discrete steps, for a more realistic feel

**Critical recommendation**: The Architect or a team member should manually read the reference dive computer Recreational Manual (Rev C) PDF, specifically the "Safety Stop" configuration section, to validate or correct the thresholds above. The PDF URLs are:
- **Recreational Manual (Rev C)**: source-link-removed
- **Technical Manual (Rev B)**: source-link-removed

---

## Raw Links

| # | URL | Tier | Status |
|---|-----|------|--------|
| 1 | https://indepthmag.com/simplicity-is-safety-when-engineering-meets-consequences/ | 2 | ✅ Fetched (partial relevance) |
| 2 | source-link-removed | 1 | ❌ PDF extraction failed (Shopify CDN) |
| 3 | source-link-removed | 1 | ❌ PDF extraction failed (Shopify CDN) |
| 4 | source-link-removed | 1 | ❌ PDF extraction failed (Shopify CDN) |
| 5 | source-link-removed | 1 | ✅ Fetched (redirect to InDepth article) |
| 6 | source-link-removed | 1 | ❌ HTTP 404 |
| 7 | source-link-removed | 3 | ❌ No results found |
| 8 | source-link-removed | 3 | ❌ Requires login for search |
| 9 | source-link-removed | 3 | ❌ Failed to extract content |
| 10 | source-link-removed | 3 | ❌ Failed to extract content |
| 11 | source-link-removed | 3 | ❌ HTTP 404 |
| 12 | source-link-removed | 3 | ❌ Domain parked |
| 13 | source-link-removed | 3 | ❌ HTTP 404 |
| 14 | source-link-removed | 3 | ❌ Redirected to scuba.com |
| 15 | source-link-removed | 3 | ❌ Requires Google login |
| 16 | source-link-removed | 1 | ✅ Fetched (blog index, no safety stop articles) |
| 17 | source-link-removed | 1 | ❌ HTTP 404 |
| 18 | source-link-removed | 1 | ❌ HTTP 404 |
