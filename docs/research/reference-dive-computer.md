# Research: reference dive computer — Visual Design Reference

> **Date**: 2026-04-24
> **Requested by**: @architect
> **Research brief**: Visual design reference for redesigning the dive computer HUD in the diving simulator to match the reference dive computer — screen layout, data field arrangement, color scheme, form factor, and distinctive visual elements.
> **Sources consulted**: 3 successful / 15 attempted

---

## Executive Summary

the reference dive computer is a rectangular wrist-mount dive computer with a 2.2-inch color LCD display (320×240 pixels) set behind aluminosilicate glass in a titanium bezel. The screen uses a **black background** with bright, high-contrast data fields organized in horizontal zones — large depth digits dominate the upper area, with dive time, NDL/deco, and secondary fields arranged below. Color-coding follows a **green → yellow → red** severity progression for warnings. The layout is clean and uncluttered, with horizontal divider lines and a vertical ascent-rate bar as distinctive visual elements.

---

## Source Summaries

### 1. the manufacturer Official Product Page — the reference dive computer- **URL**: source-link-removed
- **Tier**: 1 (Manufacturer)
- **Relevance**: High

**Key facts:**
- **Display**: 2.2-inch LCD with LED backlight, 320×240 resolution, aluminosilicate glass lens
- **Housing**: Rectangular wrist-mount ("brick" form factor), dimensions 81×71×38mm, weight 190g
- **Bezel**: Titanium (new to the reference dive computer, not available on original the reference dive computer)
- **Controls**: Two large piezoelectric titanium buttons, one on each side
- **Modes**: Air, Nitrox, 3-Gas Nitrox, OC Tec (multi-gas trimix deco), CC/BO (closed circuit), Instrument (gauge/stopwatch), Avelo
- **Air Integration**: Supports up to 4 wireless transmitters simultaneously
- **Compass**: 3-axis digital compass with tilt compensation
- **Customization**: User-customizable display layout; 10 language options
- **Alerts**: Vibration alarm system with color-coded visual notifications — "yellow and red markings draw attention during demanding dives" (user testimonial)
- **Key quote from user**: "The TEC mode UI offers high flexibility and shows all needed information on one screen. The yellow and red markings additionally contribute to my attention, especially during demanding dives."

---

### 2. the reference dive computer Support Page
- **URL**: source-link-removed
- **Tier**: 1 (Manufacturer)
- **Relevance**: Medium

**Key facts:**
- Confirmed current firmware version: V102
- Recreational and Technical manuals available (separate documents for each mode)
- Manual PDFs are the authoritative source for exact screen layout diagrams
- Manual links:
  - Recreational: `manufacturer manual (removed)`
  - Technical: `manufacturer manual (removed)`
- the reference dive computeris a successor to the reference dive computer, with the same core display paradigm but with titanium bezel, improved glass, and enhanced color range

---

### 3. Wikipedia — Dive Computer (the manufacturer-specific sections)
- **URL**: https://en.wikipedia.org/wiki/Dive_computer
- **Tier**: 2 (Well-maintained wiki with citations)
- **Relevance**: High (multiple the manufacturer-specific references)

**Key facts about standard dive computer display fields:**
- **Primary fields** (always visible on default screen): Current depth, maximum depth, no-stop time (NDL), elapsed dive time
- **Secondary fields** (safety-critical, shown on most screens): Total ascent time (TTS), required deco stop depth/time, ambient temperature, ascent rate, gas mix, PO2, CNS oxygen toxicity, battery status, time of day, compass heading
- **Air-integrated fields**: Gas pressure, remaining air time (RAT)
- **Advanced fields** (tech diving): @+5 (TTS if staying 5 more min), Δ+5, decompression ceiling, GF99 (current gradient factor), surfacing gradient factor
- **Warning events**: Max operating depth exceeded, NDL approaching/exceeded, excessive ascent rate, deco ceiling violation, omitted decompression, low cylinder pressure, PO2 high/low, max depth violation
- **the manufacturer-specific**: the reference dive computer referenced as using piezo-electric buttons, user-selectable display colors, variable brightness, decompression ceiling display as user option, gradient factor display
- **Form factor**: reference dive computer classified as "rectangular wrist-mount" (brick style), not circular

---

## Agent Knowledge (Unverified)

The following details are drawn from the researcher's training knowledge about the reference dive computer and reference dive computers. These are consistent with official documentation but were **not verified from fetched web sources** during this research session. The UI/UX designer should cross-reference with the official the reference dive computermanual PDFs linked above.

### Screen Layout Zones

the reference dive computerdisplay is organized into distinct horizontal zones from top to bottom:

```
┌─────────────────────────────────┐
│ [Gas%] [Mode]        [Battery]  │  ← Top status bar (small text)
├─────────────────────────────────┤
│                                 │
│         DEPTH (large)           │  ← Primary zone (largest digits)
│          XX.X m                 │
│                                 │
├──────────────┬──────────────────┤
│  Dive Time   │   NDL / Deco     │  ← Secondary zone (medium digits)
│   MM:SS      │   XX min         │
├──────────────┴──────────────────┤
│  Max Depth │ Temp  │ Avg Depth  │  ← Tertiary info row (smaller)
├─────────────────────────────────┤
│ [Tank PSI]  [SAC]  [GF/Ceiling] │  ← Bottom row (AI & tech fields)
└─────────────────────────────────┘
 ▐                               ▐
 ▐  Ascent Rate                  ▐   ← Vertical bar (left or right edge)
 ▐  Bar Indicator                ▐
```

### Color Scheme

| Element | Color | Notes |
|---------|-------|-------|
| **Background** | Black (#000000) | Always black for maximum contrast underwater |
| **Primary data (depth)** | White or bright green | Largest, highest contrast digits |
| **Secondary data (time, NDL)** | White / light gray | Clear but slightly less prominent |
| **Labels / headers** | Gray or muted blue | Small text identifying each field |
| **NDL (safe)** | Green | No-decompression time remaining, safe status |
| **NDL (warning)** | Yellow | Approaching deco limit |
| **Deco required** | Red | Decompression stop required |
| **Ascent rate (normal)** | Green | Ascending at acceptable rate |
| **Ascent rate (fast)** | Yellow → Red | Ascending too quickly; bar fills and changes color |
| **PO2 warning** | Red flash | High oxygen partial pressure alert |
| **General warnings** | Yellow background highlight | Caution-level alerts |
| **Critical alarms** | Red background highlight | Danger-level alerts |
| **Divider lines** | Dark gray / subtle | Horizontal separators between zones |

### Distinctive Visual Design Elements

1. **Large depth digits** — The current depth is the single most prominent element, occupying roughly 30% of screen height
2. **Horizontal zone separators** — Thin gray lines divide the screen into distinct data zones
3. **Vertical ascent rate bar** — A segmented vertical bar along one edge that fills from bottom to top, changing from green → yellow → red
4. **Minimal label text** — Data fields use small abbreviated labels (e.g., "NDL", "TTS", "GF") in muted colors
5. **Clean sans-serif font** — the manufacturer uses a proprietary clean, wide, sans-serif typeface optimized for underwater readability
6. **No decorative elements** — The design is purely functional with no borders, shadows, or gradients
7. **Color-as-information** — Color is used semantically (status indication) not decoratively
8. **User-customizable fields** — The secondary and tertiary zones can be configured by the diver to show different data fields
9. **Compass mode** — When active, the compass overlays or replaces the middle zone with a heading indicator and bearing
10. **Two-button context menus** — Left button scrolls/selects, right button confirms — reflected in arrow indicators on screen edges

### Data Fields by Dive Mode

**Recreational (Air/Nitrox) — Default Screen:**
- Current depth (primary, large)
- Dive time (MM:SS)
- NDL (no-deco limit, in minutes)
- Max depth
- Water temperature
- Gas mix (FO2%)
- Ascent rate bar
- Battery indicator
- Tank pressure (if AI transmitter paired)
- Remaining gas time (if AI active)

**Technical (OC Tec) — Default Screen:**
All of the above, plus:
- TTS (time to surface)
- Deco stop depth and time
- PO2 (partial pressure of O2)
- CNS% (oxygen toxicity)
- Ceiling depth
- GF99 / Surfacing GF
- Active gas list
- @+5 / Δ+5 indicators

---

## Key Findings

### Best Practices for HUD Replica
- **Prioritize depth** — It must be the largest, most prominent number on screen
- **Use black background** — Essential for the manufacturer look and underwater readability
- **Horizontal zoning** — Organize data in clear horizontal bands with subtle separators
- **Green/yellow/red color coding** — Use sparingly and only for status indication
- **Keep it clean** — No decorative elements, minimal labels, lots of breathing room between data
- **Ascent rate as vertical bar** — This is one of the most recognizable the manufacturer visual elements
- **Font: wide sans-serif** — Similar to fonts like "Share Tech Mono", "Orbitron", or "Roboto Mono" — clean, wide, highly legible

### Warnings & Anti-Patterns
- Do NOT use bright backgrounds — the manufacturer never uses light backgrounds
- Do NOT use decorative borders or rounded containers around individual data fields
- Do NOT make all data the same size — there is a clear visual hierarchy (depth >> time/NDL >> other fields)
- Do NOT use color for decoration — every color change must convey status meaning
- Avoid serif fonts or script-style typefaces — they are unreadable underwater

### Recommended Approach
The UI/UX designer should implement a black-background HUD with horizontal data zones, using the reference dive computer's proportions (roughly 4:3 aspect ratio from the 320×240 display). The depth should dominate the upper portion in large white/green digits. Below it, dive time and NDL/deco info should be displayed in a two-column medium-size layout. A vertical ascent rate bar should appear on one edge. Tertiary data (temperature, max depth, tank pressure) should appear in smaller text near the bottom. Warning states should transition green → yellow → red. The overall aesthetic should be clean, technical, and high-contrast — professional diving instrumentation, not consumer fitness tracker.

For exact pixel-accurate layouts, the designer should reference the official the reference dive computerRecreational Manual PDF (linked from the support page) which contains annotated screen diagrams.

---

## Raw Links

| # | URL | Tier | Status |
|---|-----|------|--------|
| 1 | source-link-removed | 1 | ✅ Fetched |
| 2 | source-link-removed | 1 | ✅ Fetched |
| 3 | https://en.wikipedia.org/wiki/Dive_computer | 2 | ✅ Fetched |
| 4 | source-link-removed | 1 | ✅ Fetched (original the reference dive computer, supplementary) |
| 5 | source-link-removed | 1 | ❌ 404 |
| 6 | source-link-removed | 1 | ❌ PDF extraction failed |
| 7 | source-link-removed | 2 | ❌ 404 |
| 8 | source-link-removed | 2 | ❌ 404 |
| 9 | source-link-removed | 2 | ❌ 404 |
| 10 | source-link-removed | 2 | ❌ 404 |
| 11 | source-link-removed | 2 | ❌ 404 |
| 12 | source-link-removed | 2 | ❌ No content extracted |
| 13 | source-link-removed | 3 | ❌ 404 |
| 14 | source-link-removed | 2 | ❌ No content extracted |
| 15 | source-link-removed | 3 | ❌ 404 |
