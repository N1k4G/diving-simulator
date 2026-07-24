# Diving Simulator

A 2D HTML5 Canvas diving simulator implementing the **Bühlmann ZHL-16C** decompression algorithm with multi-gas support, realistic bubble physics, and a technical wrist dive computer-style HUD. Dive any of four authored sites — Shore, Reef, Wreck and Cave — including overhead (wreck/cave) environments with torch, guideline and current mechanics.

## Quick Start

Open `src/diving-simulator.html` in a browser. No build step or server required.

## Controls

### Diving

| Key | Action |
|-----|--------|
| `↑` / `W` | Inflate BCD (ascend) |
| `↓` / `S` | Vent BCD (descend) |
| `←` / `A` · `→` / `D` | Fin kick left / right (horizontal swim) |
| `T` | Toggle torch (cave / wreck) |
| `F` | Fast-forward at a deco / safety stop (10× *game* time — game time already runs at 3× real time, so this is 30× real time while active) |
| `1`–`6` | Switch tank (during dive) |
| `I` | Gas info overlay (Tec / CCR) |
| `H` / `?` | Toggle help overlay |
| `ESC` | Close overlay |
| `Enter` | Start dive / Reset |

Vertical movement uses asymmetric acceleration: ascent ramps at 2 m/s² and descent at 3.33 m/s², both reaching max velocity in exactly **3 real seconds** of sustained keypress. Releasing the key decelerates at 4 m/s². The fin-kick keys (`←`/`A` and `→`/`D`) drive horizontal swimming, and **currents** (when present) push the diver — hold a kick to swim against them.

The **fin-kick style** depends on the dive mode: recreational dives use a **flutter kick** (legs alternate up and down); technical and CCR dives use a **frog kick** (legs sweep symmetrically with a glide pause), the standard kick for trim and silt control.

Dive **mode** (Rec / Tec / CCR) and dive **site** (Shore / Reef / Wreck / Cave) are chosen on the gas-setup screen before the dive.

### On-screen controls (touch & desktop)

On-screen buttons let you play without a keyboard. The four navigation buttons are laid out as a **WASD cross** in the bottom-left (ascend on top, descend below it, left/right flanking descend). On touch devices they show **arrow glyphs** (▲ ◄ ▼ ►); on a non-touch desktop they show **W / A / S / D** and respond to mouse press-and-hold. Context buttons (Help, Torch, Gas info, Fast-forward, tank switch, and the CCR Bailout / setpoint controls) appear on the right as the dive state requires.

### Gas Setup Screen

| Key | Action | Mode |
|-----|--------|------|
| `←` / `→` | O₂ fraction ±1% | Rec + Tec |
| `PgUp` / `PgDn` | Tank pressure ±10 bar | Rec + Tec |
| `↑` / `↓` | He fraction ±1% | Tec only |
| `[` / `]` | AMV ∓/± 1 L/min (min 8, max 25 L/min) | Tec only |
| `,` / `.` | Tank size ∓/± 1 L | Tec only |
| `TAB` | Cycle selected tank tab | Tec only |
| `+` / `-` | Add / remove tank (up to 6) | Tec only |
| `g` / `Shift+G` | GF Low +5 / −5 (range 30–100%) | Tec only |
| `f` / `Shift+F` | GF High +5 / −5 (range 30–100%) | Tec only |
| `M` | Switch mode (Rec / Tec / CCR) | Any |
| `1`–`4` (Rec) / `1`–`8` (Tec) | Select a gas preset | Rec + Tec |

CCR mode uses `1`–`5` for diluent presets and `[`/`]`/`,`/`.` for setpoint /
diluent volume instead of AMV/tank-size — see CCR Mode Controls below.

### CCR Mode Controls

| Key | Action |
|-----|--------|
| `[` / `]` | Decrease / Increase setpoint (during dive) |
| `B` | Bailout to open circuit (irreversible) |
| `1`–`5` | Select diluent preset (in gas setup) |
| `I` | Gas info overlay (Tec/CCR modes) |
| `ESC` | Close overlay |

## Features

### Decompression Model

- Full Bühlmann ZHL-16C with 16 tissue compartments (N₂ + He)
- **Gradient Factors** — GF Low / GF High support (default 35/75, a typical technical-diving default; 100/100 = pure unmodified Bühlmann). Range 30–100%. Affects ceiling, NDL, and deco schedule via linear interpolation from GF Low → GF High. Displayed on dive computer when not 100/100.
- Real-time NDL, ceiling, TTS, and GTR calculations
- Multi-gas support with up to 6 configurable tanks (Nitrox / Trimix)
- PO₂ monitoring with hypoxia (< 0.16 bar) and hyperoxia warnings
- **Adaptive safety stop** — 5 minutes if `maxDepth > 30m` or NDL dropped below 5 minutes at any point during the dive, otherwise 3 minutes. Active window is 2.4–8.3m (fast-forward is available while holding in that band). Missing safety stop shows a yellow warning on the post-dive screen (not a game over).

### CCR Mode (Closed Circuit Rebreather)

A full CCR dive mode simulating closed-circuit rebreather operations:

**Gas System:**
- O₂ cylinder and diluent cylinder with independent pressure tracking
- PO₂ control loop: metabolic O₂ consumption with solenoid injection toward setpoint
- Diluent auto-add on descent to maintain loop volume
- CO₂ scrubber with countdown timer

**Diluent Presets:**

| Slot | Mix | Use Case |
|------|-----|----------|
| 1 | Air (21/0) | Shallow recreational |
| 2 | Trimix 21/35 | Moderate technical |
| 3 | Trimix 15/45 | Deep technical |
| 4 | Trimix 10/70 | Ultra-deep technical |
| 5 | Heliox 10/90 | Extreme-depth / narcosis-critical |

**Decompression Integration:**
- Bühlmann deco uses dynamic loop gas fractions: fO₂ = PO₂ / P_ambient
- GTR reports O₂ cylinder endurance (not diluent)

**HUD Elements:**
- Setpoint and actual PO₂ display
- O₂ bar and diluent bar pressure indicators
- Scrubber remaining time

**Failure Modes:**

| Failure | Trigger | Delay |
|---------|---------|-------|
| Hypoxia | PO₂ < 0.16 bar | 30 dive-seconds |
| Hyperoxia | PO₂ > 1.6 bar | 30 dive-seconds |
| CO₂ breakthrough | Scrubber depleted | 180 dive-seconds |

**Bailout:**
Press `B` to bail out to open circuit. This is **irreversible** — the diver switches to breathing the diluent gas as an OC supply.

### Breathing Cycle & Bubbles

Bubble emission follows a physiological breathing cycle state machine:

```
Inhale (2s) → Exhale (1.5s) → Pause (0.5s) → repeat
```

- **Breathing bubbles** emit only during the exhale phase, rising from the diver's mouth
- **BCD exhaust bubbles** emit during fast ascent (>5 m/min), appearing from the BCD position with smaller radius and faster rise speed

### AMV (Actual Minute Volume)

Gas consumption is driven by a configurable AMV rate (default 15 L/min, range 8–25). AMV directly affects:

- **Gas consumption**: `consumption = AMV × ambient_pressure`
- **GTR (Gas Time Remaining)**: recalculated each frame using current AMV

Adjust AMV with `[` and `]` in the advanced gas setup screen. Higher AMV simulates heavier breathing (e.g., exertion, stress); lower AMV simulates relaxed, efficient breathing.

### Dive Computer Display

The HUD is styled after a modern technical wrist dive computer:

- Titanium-gray bezel with inner shadow
- 6 horizontal data zones with alternating dark backgrounds
- Depth as the dominant centered element (42px)
- Ascent rate bar indicator (6px, color-coded)
- 3-column data grid: MAX / AVG / ASC rate + AMV / GTR / TTS
- Red-tinted zone background when decompression obligation exists
- Compact 9px labels for minimal visual clutter

### Physics

- Time acceleration: 3× (1 real second = 3 dive seconds)
- Max ascent rate: 25 m/min (a runaway over-inflated BCD can exceed the barotrauma threshold below)
- Max descent rate: 20 m/min
- Barotrauma threshold: 18 m/min sustained for 10 dive-seconds
- Maximum depth: 300 m
- Hypoxia threshold (open circuit): PO₂ < 0.16 bar for 10+ dive-seconds → game over. CCR uses a separate 30-second threshold — see the CCR Failure Modes table above.

### Dive Sites

Four authored sites, each playable with any dive mode, selected on the gas-setup screen:

| Site | Character | Max depth | Overhead? |
|------|-----------|-----------|-----------|
| **Shore** | Gentle sandy slope from a beach entry, seagrass, boulders, a small sunken boat + anchor landmark | ~32 m | No |
| **Reef** | Flat-topped seamount (mesa) with coral gardens, gorgonians, sponges and fish; steep flanks to the abyss | open | No |
| **Wreck** | ZENOBIA-inspired Ro-Ro ferry on its side: multi-deck hull with cars/lorries, cargo, engine room; three marked penetration points (bow / hatch / stern); a large bower anchor lies on the seabed off the bow | ~68 m | **Yes** |
| **Cave** | Cenote: a brown-limestone entrance that forks into a shallow **upper tunnel** and a deep **lower tunnel** descending to a ~100 m grey-rock **cathedral**, rejoining before the surface shaft | ~106 m | **Yes** |

**Overhead environments (wreck & cave)** add confined-space mechanics:

- **Limited line-of-sight** — the wreck hides everything outside a bubble around the diver behind its solid steel hull; the cave is near-black without a torch.
- **Torch** (`T`) — lights a cone in the cave and widens the visibility bubble in the wreck.
- **Guideline** — a breadcrumb line is laid automatically while overhead, marking the way back to open water.
- **Bad-air pockets** — unbreathable gas traps (e.g. the cave's upper tunnel) where you cannot surface.
- **Overhead game-over notice** — dying in an overhead environment shows a safety callout about the dangers of wreck/cave diving (training, continuous guideline, rule of thirds).

### Environment

- Boat / buoy / pond surface markers per site; warm cenote sky and jungle rim above the cave
- **Currents** — many dives feature a horizontal current that pushes the diver; counter it with `A`/`D` fin kicks
- Site-aware marine life (reef fish, turtles, rays, sharks; no sharks at shore/cave)
- Depth-graded water and rock: warm shallows cooling to dark grey/black with depth

## Testing

Open `src/diving-simulator-tests.html` in a browser to run the automated test suite. Tests cover decompression math, gas consumption, PO₂ calculations, breathing cycle, AMV bounds, and gameAPI integration.

The same suite runs headless under Playwright via `npm test` (it loads the test harness and asserts `window.testResults`).

## Development & CI

The game is plain HTML/CSS/JS with no build step. Install dev tooling with `npm install`, then:

| Command | What it does |
|---------|--------------|
| `npm run lint` | ESLint over `src/*.js` (a `husky` pre-commit hook also lints staged files with `--max-warnings=0`) |
| `npm test` | Runs the in-browser test suite headless via Playwright |
| `npm run screenshots` | Captures review screenshots (phone + desktop, setup + in-dive) to `screenshots/` via `scripts/screenshots.mjs` |

**CI pipelines** (GitHub Actions):

- **`.github/workflows/pr.yml`** — runs on every pull request to `main`: lint → tests → review screenshots (uploaded as artifacts). It **does not deploy**.
- **`.github/workflows/deploy.yml`** — runs on push to `main` (i.e. after a PR is merged): lint → tests, then deploys to Cloudflare Pages.

So a PR is fully checked (and produces screenshots for review) before merge, and deployment only happens once the change lands on `main`.

## gameAPI

The simulator exposes `window.gameAPI` for programmatic access and testing:

```js
// Read-only
gameAPI.depth           // current depth (m)
gameAPI.maxDepth        // max depth reached
gameAPI.diveTime        // elapsed dive time (dive-seconds)
gameAPI.ascentRate      // current ascent rate (m/min)
gameAPI.breathPhase     // 'inhale' | 'exhale' | 'pause'
gameAPI.breathTimer     // time remaining in current breath phase
gameAPI.hypoxiaTime     // accumulated hypoxia exposure (dive-seconds)
gameAPI.safetyStopNeeded     // whether a safety stop is required
gameAPI.safetyStopRemaining  // seconds remaining on safety stop
gameAPI.safetyStopCountdownStarted // whether the countdown has been locked in
gameAPI.safetyStopComplete   // whether safety stop was completed

// Read-write
gameAPI.amvRate         // AMV rate (clamped 8–25 L/min)
gameAPI.gfLow           // GF Low (clamped 30–100%)
gameAPI.gfHigh          // GF High (clamped 30–100%)
gameAPI.gameState       // 'gas-setup' | 'surface' | 'diving' | 'gameover' | 'post-dive'
gameAPI.activeTank      // active tank index

// Functions
gameAPI.calculateSafetyStopDuration()  // returns adaptive stop duration in seconds
```

## License

The code in this repository is licensed under the [MIT License](LICENSE).

The deployed game (`src/`, what `pages deploy src/` ships) bundles no
third-party code — every npm package in `package.json` is dev/CI tooling
(ESLint, Playwright, husky) and is never shipped. The **only** third-party
asset shipped is the **Barlow Semi Condensed** typeface
(`src/fonts/*.woff2`), self-hosted for GDPR reasons (see issue #29) and
licensed under the [SIL Open Font License 1.1](src/fonts/OFL.txt).

The Bühlmann ZHL-16C decompression coefficients (`ZHL16C_N2`/`ZHL16C_HE` in
`src/constants.js`) are published scientific data, independently transcribed
from standard reference tables — see the source comment above those tables
for the specific reference.
