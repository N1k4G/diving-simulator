# Research: Nitrogen Narcosis

> **Date**: 2026-04-25
> **Requested by**: @architect
> **Research brief**: Physiology, onset thresholds, symptom progression, gas mixture mitigation, END formulas, recovery dynamics, individual variation, and game implementation ideas for nitrogen narcosis in a diving simulator.
> **Sources consulted**: 3 successful / 11 attempted

---

## Executive Summary

Nitrogen narcosis is a reversible alteration of consciousness caused by breathing nitrogen (and potentially oxygen) at elevated partial pressures during diving. Effects follow a well-documented depth-severity progression starting with subtle impairment around 10m, becoming significant at 30m, severe at 50–70m, and potentially fatal beyond 90m. The condition is commonly described via the "Martini Rule" (one martini per 10m below 20m). Helium replacement in breathing gas eliminates narcotic effects, and the Equivalent Narcotic Depth (END) formula provides a standard calculation for trimix planning. Recovery on ascent is rapid but not instantaneous — recent research shows cognitive impairment persists for at least 30 minutes post-dive. For game implementation, narcosis offers rich visual, audio, and control-impairment mechanics that can be driven by a continuous narcosis index derived from PN2 (and optionally PO2).

---

## Source Summaries

### 1. Wikipedia — Nitrogen Narcosis
- **URL**: https://en.wikipedia.org/wiki/Nitrogen_narcosis
- **Tier**: 2 (well-referenced encyclopedia article citing Tier 1 medical sources)
- **Relevance**: High

**Key facts and recommendations:**
- Narcosis is caused by increased gas solubility in body tissues at depth (Henry's Law), leading to gas dissolving in nerve cell lipid bilayers and disrupting neural transmission
- The Meyer-Overton hypothesis links narcotic potency to lipid solubility; more recent research points to NMDA receptor antagonism and GABAA receptor potentiation
- Partial pressure of nitrogen in the brain equilibrates with ambient pressure within 1–2 minutes after depth change
- All divers are affected; no tolerance can be developed, though coping can be learned
- Rapid compression worsens narcosis due to CO2 retention

**Severity table (from Lippmann & Mitchell, adapted):**

| Pressure (bar) | Depth (m) | Depth (ft) | Effects |
|---|---|---|---|
| 1–2 | 0–10 | 0–33 | Unnoticeable or no symptoms |
| 2–4 | 10–30 | 33–100 | Mild impairment of unpracticed tasks, mildly impaired reasoning, mild euphoria possible |
| 4–6 | 30–50 | 100–165 | Delayed response to stimuli, reasoning/memory affected, calculation errors, wrong choices, idea fixation, overconfidence, laughter, anxiety (cold/murky water) |
| 6–8 | 50–70 | 165–230 | Sleepiness, impaired judgment, confusion, hallucinations, severe response delays, uncontrolled laughter, terror in some |
| 8–10 | 70–90 | 230–300 | Poor concentration, mental confusion, stupefaction, decreased dexterity, loss of memory, increased excitability |
| 10+ | 90+ | 300+ | Intense hallucinations, auditory hallucinations ("wah-wahs"), sense of impending blackout or levitation, dizziness, euphoria/mania/depression, disorganization of time sense, unconsciousness, death |

**Relative narcotic potency of gases:**

| Gas | Relative Narcotic Potency (vs N2 = 1.0) |
|---|---|
| He | 0.045 |
| Ne | 0.3 |
| H₂ | 0.6 |
| N₂ | 1.0 |
| O₂ | 1.7 |
| Ar | 2.3 |
| CO₂ | 20.0 |

**Aggravating factors:** Cold water, stress, heavy work, fatigue, CO2 retention, alcohol, sedative drugs, anxiety, rapid descent
**Recovery:** Effects are "entirely removed on ascent" — narcosis is fully reversible with no long-term effects from repeated exposure. However, recent research (Lafère et al., 2016) shows some effects persist for at least 30 minutes after surfacing.
**Prevention:** Limit depth, use helium-based mixes (trimix, heliox). Helium has no narcotic effect. Most recreational agencies limit air diving to 40m.

---

### 2. Wikipedia — Equivalent Narcotic Depth
- **URL**: https://en.wikipedia.org/wiki/Equivalent_narcotic_depth
- **Tier**: 2 (well-referenced, citing NOAA Diving Manual and peer-reviewed research)
- **Relevance**: High

**Key facts:**

**END Formula — Oxygen Considered Narcotic (NOAA/GUE/CMAS/PADI method):**
```
END = (depth + 10) × (1 − fHe) − 10      [metres]
END = (depth + 33) × (1 − fHe) − 33      [feet]
```
Where `fHe` = fraction of helium in the mix.

This treats all non-helium gas (O2 + N2) as equally narcotic. Since air is 100% non-helium, the narcotic fraction of air is 1.0.

**Example:** 40% helium trimix at 60m:
```
END = (60 + 10) × (1 − 0.4) − 10 = 70 × 0.6 − 10 = 32m
```

**END Formula — Oxygen NOT Considered Narcotic (TDI/IANTD/NAUI/BSAC method):**
```
END = (depth + 10) × fN2 / 0.79 − 10     [metres]
```
Where `fN2` = fraction of nitrogen, and 0.79 is the nitrogen fraction in air.

**The oxygen narcosis debate:**
- NOAA Diving Manual (2002) recommends treating O2 as equally narcotic to N2
- Oxygen has higher lipid solubility than nitrogen (narcotic potency ratio ~1.7x)
- However, some oxygen is metabolized, potentially reducing effective narcotic contribution
- Recent EEG/CFFF studies (Vrijdag et al., 2022) found NO evidence of oxygen narcosis matching nitrogen's mechanism
- Training agency split: GUE, CMAS, PADI count O2 as narcotic; TDI, IANTD, NAUI, BSAC do not
- The "oxygen narcotic" model is more conservative (higher END values)

**Carbon dioxide:** CO2 has narcotic potency 20× that of nitrogen but is NOT included in END calculations because breathing gas CO2 is normally negligible — the risk comes from diver physiology (exertion, work of breathing)

---

### 3. DAN Europe Alert Diver — Measuring Inert Gas Narcosis
- **URL**: https://alertdiver.eu/en_US/articles/measuring-inert-gas-narcosis
- **Tier**: 1 (DAN Europe, authoritative diving medicine organization)
- **Relevance**: High

**Key findings from CFFF research:**

- **Initial arousal then decline:** Upon arriving at depth, divers show INCREASED cognitive function (CFFF values rise), followed 15 minutes later by a pronounced DECREASE — narcosis onset is not immediate but follows a brief period of heightened alertness
- **Persistence post-dive:** Cognitive impairment measured by CFFF persists on surfacing AND 30 minutes post-dive — contradicts the traditional advice that "just ascending a few meters" fully resolves narcosis
- **Environment doesn't matter much:** When objectively measured, pressure and gas composition appear to be the ONLY significant external factors influencing narcosis — dry chamber, pool, and ocean dives at 30m showed remarkably consistent CFFF patterns
- **EANx vs Air:** Enriched Air Nitrox (EANx 40) showed greater brain activation and less late-dive/post-dive impairment compared to air — higher PO2 had a beneficial effect on arousal and cognitive performance, while lower PN2 reduced narcosis
- **Mechanism:** The proteinic theory of narcosis (interaction with GABA receptors and neurotransmitters) is gaining favor over the older Meyer-Overton lipid solubility theory. Oxygen exhibits activating effects on neurotransmitters (glutamate, dopamine, GABA) while nitrogen exhibits inhibitory effects
- **Self-assessment unreliable:** Divers are unreliable at self-assessing narcosis symptoms, and narcosis itself impairs the ability to recognize impairment

---

## Key Findings

### 1. Physiology & Cause

- **Mechanism:** Nitrogen dissolves into nerve cell lipid bilayers at elevated partial pressures, disrupting neural signal transmission. More specifically, nitrogen acts as an NMDA receptor antagonist and GABAA receptor potentiator — similar to alcohol and benzodiazepine mechanisms
- **"Martini Rule":** Informally, narcosis produces the feeling of one martini for every 10m below 20m depth (i.e., at 30m ≈ 1 drink, 40m ≈ 2 drinks, etc.)
- **PN2 relationship:** Narcotic effect correlates directly with partial pressure of nitrogen. PN2 = fN2 × ambient_pressure_bar. On air (79% N2) at 30m: PN2 = 0.79 × 4 = 3.16 bar
- **Speed of onset:** Brain PN2 equilibrates with ambient pressure within 1–2 minutes of depth change. Rapid descent potentiates narcosis due to CO2 retention

### 2. Onset Thresholds (for air diving)

| Depth Range | PN2 Range (bar) | Severity | Game Narcosis Index |
|---|---|---|---|
| 0–10m | 0.79–1.58 | None/negligible | 0% |
| 10–30m | 1.58–3.16 | Mild — subtle impairment | 0–15% |
| 30–40m | 3.16–3.95 | Moderate — noticeable impairment | 15–35% |
| 40–50m | 3.95–4.74 | Significant — delayed responses, errors | 35–55% |
| 50–70m | 4.74–6.32 | Severe — confusion, hallucinations | 55–80% |
| 70–90m | 6.32–7.90 | Critical — stupefaction, memory loss | 80–95% |
| 90m+ | 7.90+ | Extreme — unconsciousness, death | 95–100% |

### 3. Symptom Progression (mapped for game use)

**Mild (10–30m on air):**
- Slightly slowed reaction time
- Mild euphoria or anxiety
- Minor impairment on complex tasks

**Moderate (30–50m on air):**
- Delayed response to visual and auditory stimuli
- Impaired reasoning and memory
- Calculation errors, wrong choices
- Overconfidence / idea fixation
- Laughter or anxiety depending on personality

**Severe (50–70m on air):**
- Sleepiness, confusion
- Hallucinations (visual and auditory)
- Severely delayed responses
- Impaired judgment
- Uncontrolled laughter OR terror

**Critical (70–90m on air):**
- Poor concentration, mental confusion
- Stupefaction
- Loss of memory
- Decreased dexterity and coordination

**Extreme (90m+ on air):**
- Intense hallucinations
- Auditory hallucinations ("wah-wahs")
- Sense of impending blackout or levitation
- Complete disorganization of time sense
- Unconsciousness → death

### 4. Gas Mixture Mitigation & END

**Helium effect:** Helium has narcotic potency of only 0.045 relative to nitrogen (essentially zero). Replacing nitrogen with helium in the breathing mix directly reduces narcosis.

**END Formulas:**

**Model A — O2 equally narcotic to N2 (NOAA/conservative):**
```
END_m = (depth_m + 10) × (1 − fHe) − 10
END_ft = (depth_ft + 33) × (1 − fHe) − 33
```

**Model B — Only N2 narcotic (traditional):**
```
END_m = (depth_m + 10) × (fN2 / 0.79) − 10
END_ft = (depth_ft + 33) × (fN2 / 0.79) − 33
```

**For the game:** Recommend implementing Model A (conservative, simpler) as the default, with Model B as an option. The game already models trimix with known gas fractions, making END calculation straightforward.

**Example END values for common mixes at 60m:**

| Mix | fO2 | fHe | fN2 | END (Model A) | END (Model B) |
|---|---|---|---|---|---|
| Air | 0.21 | 0.00 | 0.79 | 60m | 60m |
| EAN32 | 0.32 | 0.00 | 0.68 | 60m | 50m |
| Trimix 21/35 | 0.21 | 0.35 | 0.44 | 35.5m | 28.9m |
| Trimix 18/45 | 0.18 | 0.45 | 0.37 | 28.5m | 22.7m |
| Trimix 10/70 | 0.10 | 0.70 | 0.20 | 11m | 5.2m |

### 5. Recovery

- **Primary recovery:** Ascending to shallower depth reverses most noticeable effects within minutes
- **Residual impairment:** CFFF research (Balestra et al., 2012; Lafère et al., 2016) shows measurable cognitive impairment persisting at least 30 minutes after surfacing
- **No long-term damage:** No permanent effects from repeated narcosis exposure
- **For the game:** Model rapid primary recovery on ascent (e.g., narcosis index drops following depth with ~30-60 second lag), but consider a "residual haze" effect that lingers slightly after rapid ascent

### 6. Individual Variation

- **High variability:** Susceptibility varies widely between individuals AND between dives for the same individual on the same day
- **No prediction:** There is no reliable method to predict when narcosis will become noticeable for a given diver
- **No adaptation:** Scientific evidence shows divers CANNOT develop resistance or tolerance to narcosis at a given depth — they can only learn to cope with subjective effects; underlying behavioral impairment remains
- **Aggravating factors:**
  - Cold water (reduces thermal comfort awareness, may increase cerebral nitrogen load)
  - Fatigue / sleep deprivation
  - CO2 buildup (heavy exertion, skip breathing, poor ventilation)
  - Anxiety / stress / task loading
  - Alcohol (additive effect — 12+ hours abstinence recommended)
  - Sedative medications (benzodiazepines, opiates)
  - Rapid descent rate
- **For the game:** Could implement a hidden "susceptibility modifier" (0.8–1.2×) that varies per dive session, and stack multipliers for cold water, high exertion, rapid descent

### 7. Narcosis Index Formula (Game Implementation)

**Proposed narcosis index (0–100%) based on narcotic partial pressure:**

```
// Calculate narcotic partial pressure
// Model A (O2 narcotic): pNarc = (fO2 + fN2) × ambient_bar = (1 - fHe) × ambient_bar  
// Model B (N2 only):     pNarc = fN2 × ambient_bar

// Narcosis index using sigmoid-like curve
// Onset threshold: ~1.5 bar pNarc (barely noticeable)
// Midpoint: ~4.5 bar pNarc (~45m on air, moderate narcosis)
// Saturation: ~8.0 bar pNarc (near-total incapacitation)

narcosisIndex = clamp(0, 1, (pNarc - 1.5) / (8.0 - 1.5))

// Or for more realistic non-linear progression:
narcosisIndex = clamp(0, 1, smoothstep(1.5, 8.0, pNarc))

// Apply individual variation multiplier (0.8–1.2, randomized per dive)
narcosisIndex = clamp(0, 1, narcosisIndex × susceptibilityMultiplier)

// Apply aggravating factors
if (coldWater) narcosisIndex *= 1.15
if (highExertion) narcosisIndex *= 1.10  
if (rapidDescent) narcosisIndex *= 1.10
```

**Temporal dynamics:**
- Onset: 60–120 second ramp-up when arriving at new depth (brain equilibration time)
- Recovery: 30–60 second ramp-down on ascent to shallower depth
- Residual: Small persistent effect (~5–10% of peak) lasting several minutes after significant ascent

### 8. Game Implementation Ideas

**Visual Effects (Canvas 2D):**
- **Blur:** Apply Gaussian blur filter increasing with narcosis index. At mild levels, only edge blur (vignette). At severe, full-frame blur
- **Vignette:** Progressive darkening of screen edges (tunnel vision) — starts subtle at 20%, heavy at 60%+
- **Color shift:** Warm tint (slightly golden/amber) at mild narcosis; color desaturation at severe levels
- **Screen wobble:** Gentle sinusoidal oscillation of camera/viewport. Amplitude and frequency increase with narcosis. At severe levels, add random drift
- **Double vision:** At 60%+, render a semi-transparent offset duplicate of the scene
- **Particle effects:** At 70%+, floating phantom particles or light spots (mild hallucinations)

**Audio Effects:**
- **Muffled audio:** Low-pass filter on all sounds, increasing with narcosis
- **Distortion:** Slight pitch warble on ambient sounds at moderate levels
- **Auditory hallucinations:** At 70%+, occasional phantom sounds (the "wah-wahs" from real narcosis reports)
- **Heartbeat amplification:** Diver's heartbeat becomes louder and more prominent

**Control Impairment:**
- **Input delay:** Add 50–500ms latency to controls proportional to narcosis index
- **Drift:** Random slow drift on movement controls (diver doesn't hold perfect position)
- **Reduced precision:** Increase dead zone / decrease sensitivity on controls
- **Wrong button confusion:** At severe levels (70%+), occasional chance of input being misinterpreted (e.g., pressing ascend briefly registers as descend)

**UI/HUD Effects:**
- **Blurred readings:** Dive computer numbers become progressively harder to read (blur/distort the text)
- **Delayed updates:** HUD values update less frequently or with lag
- **Misread gauges:** At 70%+, depth/pressure readings occasionally show wrong values briefly
- **Flickering displays:** Gauges flicker or ghost at severe narcosis

**Game Consequences:**
- **NOT an instant game-over:** Narcosis should be progressive impairment, not a kill condition — matching real-world behavior where it's dangerous due to impaired judgment, not directly lethal
- **Indirect danger:** Narcosis-impaired diver makes mistakes → can lead to other fatal conditions (DCS from blown deco, O2 toxicity from wrong gas switch, drowning from disorientation)
- **Unconsciousness threshold:** At narcosis index ≈ 95–100% (very deep on air, ~90m+), trigger unconsciousness → drowning, making it effectively fatal at extreme depths
- **Warning system:** Dive computer should display narcosis indicator (e.g., "NARC" warning when END > 30m or narcosis > 20%)

### Warnings & Anti-Patterns

- **Don't model narcosis as binary** — it's a continuous spectrum, not on/off
- **Don't allow "adaptation"** — repeated exposure does not build tolerance in reality
- **Don't ignore gas composition** — narcosis should be dramatically reduced on trimix and eliminated on heliox
- **Don't make recovery instant** — there should be a lag, and recent research supports post-dive residual effects
- **Don't forget CO2 synergy** — if the game models exertion/breathing, CO2 buildup should amplify narcosis
- **Don't treat oxygen definitively** — the debate is unresolved; implementing both END models (selectable) is most accurate

### Recommended Approach

For the diving simulator, implement narcosis as a **continuous effect driven by narcotic partial pressure** using the conservative Model A (O2 + N2 narcotic) as default, with Model B as an advanced option. The narcosis index should follow a smooth sigmoid curve from onset (~1.5 bar pNarc) to saturation (~8.0 bar pNarc), with temporal dynamics modeling the 1–2 minute brain equilibration time.

Effects should be **layered progressively**: subtle visual changes first (vignette, slight blur), then audio distortion and control impairment, then severe hallucination-like effects and UI corruption. This creates a satisfying gameplay curve where experienced players learn to recognize early narcosis signs and manage their depth/gas accordingly — mirroring real diver training.

The narcosis system should **interact with existing mechanics**: impaired judgment makes gas switching harder (blurred PO2 readings), delayed controls make emergency ascents slower, and confusion increases the risk of missing decompression obligations. This creates emergent gameplay danger without narcosis being a standalone kill condition.

---

## Raw Links

| # | URL | Tier | Status |
|---|-----|------|--------|
| 1 | https://en.wikipedia.org/wiki/Nitrogen_narcosis | 2 | ✅ Fetched |
| 2 | https://en.wikipedia.org/wiki/Equivalent_narcotic_depth | 2 | ✅ Fetched |
| 3 | https://alertdiver.eu/en_US/articles/measuring-inert-gas-narcosis | 1 | ✅ Fetched |
| 4 | https://dan.org/health-medicine/health-resources/diseases-conditions/nitrogen-narcosis/ | 1 | ❌ Failed (no content extracted) |
| 5 | https://www.diversalertnetwork.org/medical/articles/Nitrogen_Narcosis | 1 | ❌ Failed (no content extracted) |
| 6 | source-link-removed | 1 | ❌ Failed (no content extracted) |
| 7 | https://gue.com/blog/nitrogen-narcosis/ | 1 | ❌ Redirected to InDepth (404) |
| 8 | https://gue.com/blog/is-oxygen-narcosis-a-thing/ | 1 | ❌ Redirected to InDepth |
| 9 | https://gue.com/blog/calculated-confusion-can-o2-get-you-high/ | 1 | ❌ Redirected to InDepth |
| 10 | https://www.tdisdi.com/tdi-diver-news/understanding-nitrogen-narcosis/ | 1 | ❌ Failed (no content extracted) |
| 11 | https://www.scubadivermag.com/nitrogen-narcosis/ | 2 | ❌ HTTP 404 |

---

## References (from source material)

- Bennett, P. & Rostain, J.C. (2003). "Inert Gas Narcosis" in *Bennett and Elliott's Physiology and Medicine of Diving*, 5th ed.
- Lippmann, J. & Mitchell, S.J. (2005). "Nitrogen Narcosis" in *Deeper into Diving*, 2nd ed.
- U.S. Navy Diving Manual (2008), Revision 6.
- NOAA Diving Manual (2002), 4th ed., "Mixed-Gas & Oxygen" §16.3.1.2.4.
- Lafère, P. et al. (2016). "Do Environmental Conditions Contribute to Narcosis Onset and Symptom Severity?" *Int J Sports Med* 37, 1124-1128.
- Lafère, P. et al. (2019). "Early detection of diving-related cognitive impairment of different nitrogen-oxygen gas mixtures using critical flicker fusion frequency." *Diving Hyperb Med* 49, 119-126.
- Vrijdag, X.C.E. et al. (2022). "Does hyperbaric oxygen cause narcosis or hyperexcitability? A quantitative EEG analysis." *Physiological Reports* 10(14), e15386.
- Balestra, C. et al. (2012). "Persistence of critical flicker fusion frequency impairment after a 33 mfw SCUBA dive." *Eur J Appl Physiol* 112, 4063-4068.
- Hesser, C.M. et al. (1978). "Roles of nitrogen, oxygen, and carbon dioxide in compressed-air narcosis." *Undersea Biomed Res* 5(4), 391-400.
- Lambertsen, C.J. et al. (1977, 1978). University of Pennsylvania Institute for Environmental Medicine reports.
