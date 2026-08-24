// ============================================================
// FILE: sites.js
// PURPOSE: Phase C dive-site data and pure geometry helpers.
//          Loaded between state.js and physics.js so all scripts
//          can call floorAt/ceilingAt/solidAt/overheadAt/badAirAt.
//
// DEPENDS ON: constants.js (MAX_DEPTH), state.js (diveSite)
//
// USED BY: physics.js, game-loop.js, renderer.js
//
// KEY SYMBOLS:
//   DIVE_SITES              — site descriptor objects (shore/reef/wreck/cave)
//   activeSite()            — returns the active DIVE_SITES entry, or null for 'open'
//   lerpProfile(pts, x)     — piecewise-linear sample of a floor/ceiling profile
//   floorAt(x)              — deepest passable depth at world-x
//   ceilingAt(x)            — shallowest passable depth at world-x (0 = open to surface)
//   solidAt(x, d)           — true if point is inside a solid AABB structure
//   overheadAt(x, d)        — true if the straight-up path to air is blocked
//   badAirAt(x)             — returns a bad-air dome descriptor or null
// ============================================================

// ============================================================
//  DIVE SITE DESCRIPTORS
// ============================================================

// All x in world metres (diverX axis, entry at x=0).
// All d in metres depth (positive down).
// floor/ceiling: piecewise-linear [{x,d}] sorted by x.
// structures: solid AABBs [{x1,x2,dTop,dBottom,kind}].
// features: cosmetic markers [{kind,x,d,...}].
// badAir: unbreathable dome pockets [{x1,x2,d}].
//
// Issue #53 — visualZones: purely declarative visual sub-areas of the map
// (biomes / rooms / decks) used by future atmosphere / decoration / material
// consumers. Format: [{id,x1,x2,d1,d2,priority?,blend?,tags?}]. See
// visualZoneAt() / zoneBlendWeight() at the bottom of this file for the
// deterministic selection rule. The data itself never drives physics,
// collision, decompression, gas, or wildlife-spawn logic.

var DIVE_SITES = {
  shore: {
    id: 'shore',
    name: 'Shore',
    hasOverhead: false,
    maxDepth: 32,
    entry: { x: 0 },
    boatX: 100,   // D9: boat sits offshore in deeper water, not at the beach entry
    floor: [
      {x:-10,d:0},{x:0,d:3},{x:35,d:6},{x:70,d:10},{x:95,d:14},
      {x:115,d:22},{x:140,d:28},{x:185,d:30}
    ],
    ceiling: null,
    // dBottom values run a few metres below the sand profile so the boulders
    // sit buried in the seabed rather than floating above it.
    structures: [
      {x1:100,x2:118,dTop:14,dBottom:26,kind:'rock'},
      {x1:122,x2:132,dTop:18,dBottom:30,kind:'rock'},
      {x1:135,x2:152,dTop:24,dBottom:30,kind:'wreckSmall'},
      // Landmarks right of the wreck: a boulder outcrop on the deeper slope
      {x1:158,x2:171,dTop:25,dBottom:36,kind:'rock'},
      {x1:175,x2:184,dTop:27,dBottom:37,kind:'rock'}
    ],
    badAir: [],
    features: [
      {kind:'buoy',x:0},
      // Beach scene on the dry sand to the left (above the waterline)
      {kind:'towel',x:-17},
      {kind:'umbrella',x:-13},
      // Issue #59 — HERO A (Entry/Beach): a second towel further right so
      // the beach silhouette reads as a lived-in area rather than a single
      // umbrella. Still no new large object, still all above the waterline.
      {kind:'towel',x:-6},
      // D3: denser seagrass beds along the sandy descent
      // Issue #59 — HERO B (Meadow): tightened + extended slightly so the
      // meadow reads as a deliberate band that clearly ends before the
      // Boulder Gate. Adds two anchor tufts at x=82,86 to bridge the
      // seagrass belt to the transitional coral tufts at x=85,90.
      {kind:'seagrass',x:18,d:5},{kind:'seagrass',x:25,d:6},
      {kind:'seagrass',x:32,d:6},{kind:'seagrass',x:45,d:8},
      {kind:'seagrass',x:52,d:8},{kind:'seagrass',x:60,d:9},
      {kind:'seagrass',x:68,d:10},{kind:'seagrass',x:78,d:11},
      {kind:'seagrass',x:82,d:12},{kind:'seagrass',x:86,d:13},
      {kind:'coral',x:85,d:13},{kind:'coral',x:90,d:13},
      // Issue #59 — HERO D (Wreck + Anchor cluster): a small coral tuft
      // nestled against the wreck's stern-end (x=152 sits just past the
      // wreckSmall structure at x=135..152) and one behind the anchor
      // knit the wreck→anchor pair into one destination area.
      {kind:'coral',   x:152,d:28},
      // Landmarks right of the small wreck: an old admiralty anchor half-buried
      // in the sand, with a little life clustered around the outcrop.
      {kind:'anchor',  x:156},
      {kind:'seagrass',x:159,d:29},
      {kind:'seagrass',x:163,d:29},{kind:'seagrass',x:168,d:29},
      {kind:'coral',   x:180,d:30}
    ],
    surfaceMarker: 'buoy',
    noShark: true,
    currentBias: 0.0,
    // Issue #53 — visual zones derived from the shore floor profile and
    // structure list above. The beach/entry sits above the -10→0→3 m sand;
    // the seagrass belt (features x=18..78, d=5..11) drives shore_grass; the
    // slope band tracks the floor descent from d=10 at x=70 to d=22 at x=115;
    // shore_deep covers the rock outcrops + small wreck at x=100..184, d≈14..37.
    visualZones: [
      { id: 'shore_entry',  x1: -20, x2: 25,  d1: 0,  d2: 4,  priority: 10, blend: 1, tags: ['shore','sand','sunlit','shallow'] },
      { id: 'shore_grass',  x1: 10,  x2: 88,  d1: 3,  d2: 13, priority: 10, blend: 2, tags: ['shore','sand','seagrass','shallow'] },
      { id: 'shore_slope',  x1: 55,  x2: 118, d1: 10, d2: 22, priority: 8,  blend: 2, tags: ['shore','sand','slope'] },
      // Issue #59 — HERO C (Boulder Gate): a narrow, higher-priority sub-zone
      // wrapping the two AABB rocks at x=100..118 and x=122..132 so extra
      // edge-stone set-dressing can be scattered ONLY here to visually thicken
      // the transition. Priority 14 wins over the surrounding shore_slope
      // (priority 8) but loses to shore_deep (priority 12? — no, priority 14
      // > 12 wins). We deliberately size the rectangle only wide enough for
      // the two rocks plus a small skirt to either side; shore_deep still
      // owns everything east of x=134 (the wreck cluster).
      { id: 'shore_boulder_gate', x1: 95, x2: 134, d1: 12, d2: 22, priority: 14, blend: 2, tags: ['shore','sand','boulder-gate','transition'] },
      { id: 'shore_deep',   x1: 90,  x2: 190, d1: 18, d2: 32, priority: 12, blend: 2, tags: ['shore','sand','deep','wreck-debris'] }
    ],
    // Issue #54 — local atmosphere profiles keyed by visualZone id.
    // Issue #59 tuning: pushed shore_entry a touch brighter (ambient/visibility)
    // to make the beach silhouette pop as the clearest bright area. Added a
    // very light "warm cast" to shore_boulder_gate so the rock-transition
    // reads slightly warmer than the adjacent slope without changing depth
    // atmospherics.
    atmosphereProfiles: {
      shore_entry:        { visibility: 1.10, tint: [1.00, 1.05, 0.98], particleDensity: 1.10, particleBrightness: 1.15, ambient: 1.15 },
      shore_grass:        { visibility: 0.95, tint: [0.98, 1.02, 0.98], particleDensity: 1.25, particleBrightness: 1.00, ambient: 1.00 },
      shore_slope:        { visibility: 1.00, tint: [1.00, 1.00, 1.00], particleDensity: 1.00, particleBrightness: 1.00, ambient: 0.95 },
      shore_boulder_gate: { visibility: 0.98, tint: [1.02, 0.98, 0.94], particleDensity: 1.05, particleBrightness: 0.95, ambient: 0.92 },
      shore_deep:         { visibility: 0.85, tint: [0.90, 0.95, 1.00], particleDensity: 0.90, particleBrightness: 0.80, ambient: 0.80 }
    },
    // Issue #55 — decorationRules: deterministic micro set-dressing (shells,
    // pebbles, small rocks, grass tufts, sand-ripple accents) scattered
    // within the visualZones above. Purely cosmetic filler between the
    // hand-placed features array; never touches physics/collision/gameplay.
    // Issue #59 tuning:
    //   • shore_entry_shells: slightly denser (0.5→0.6) + tighter spacing so
    //     the shoreline reads a hair more populated with lived-in detail.
    //   • shore_grass_micro: denser (0.6→0.85) and tighter spacing so the
    //     meadow reads as visibly thicker than the surrounding zones.
    //   • shore_boulder_gate_stones (new): scatters smallRocks/pebbles ONLY
    //     inside the new shore_boulder_gate zone so the AABB rocks read as
    //     a grouped "gate" instead of two isolated boulders.
    //   • shore_deep_debris: mild density bump (0.35→0.45) so the deep area
    //     around the small wreck/anchor reads as a cohesive debris field.
    decorationRules: [
      { id: 'shore_entry_shells', zone: 'shore_entry', spacing: 1.9, density: 0.6, seed: 1101, surface: 'floor',
        props: [{kind:'shell',weight:2},{kind:'pebble',weight:3},{kind:'smallRock',weight:1}] },
      { id: 'shore_grass_micro', zone: 'shore_grass', spacing: 1.4, density: 0.85, seed: 1102, surface: 'floor',
        props: [{kind:'grassTuft',weight:3},{kind:'pebble',weight:4},{kind:'sandRippleAccent',weight:2}] },
      { id: 'shore_boulder_gate_stones', zone: 'shore_boulder_gate', spacing: 1.8, density: 0.6, seed: 1104, surface: 'floor',
        props: [{kind:'smallRock',weight:4},{kind:'pebble',weight:3},{kind:'debrisSpeck',weight:1}] },
      { id: 'shore_deep_debris', zone: 'shore_deep', spacing: 2.5, density: 0.45, seed: 1103, surface: 'floor',
        props: [{kind:'smallRock',weight:3},{kind:'pebble',weight:2},{kind:'debrisSpeck',weight:2}] }
    ]
  },
  reef: {
    id: 'reef',
    name: 'Reef',
    hasOverhead: false,
    maxDepth: MAX_DEPTH,
    entry: { x: 0 },
    boatX: 60,

    // Flat-topped seamount (mesa): wide coral plateau at 5 m from x=-8..8,
    // then steep, smooth flanks dropping straight to the abyss on both sides.
    // This single floor profile IS the mesa silhouette — the warm rock fill in
    // drawTerrain() renders it as one solid trapezoid (matches the mockup).
    // Horizontal collision into the wall is handled by `depth > floorAt(x)`
    // (physics.js), so no AABB boulder structures are needed — they only
    // fragmented the clean mesa shape.
    floor: [
      {x:-200,d:MAX_DEPTH},{x:-26,d:MAX_DEPTH},{x:-20,d:90},{x:-12,d:30},
      {x:-9,d:12},{x:-8,d:5},{x:8,d:5},{x:9,d:12},{x:12,d:30},
      {x:20,d:90},{x:26,d:MAX_DEPTH},{x:200,d:MAX_DEPTH}
    ],
    ceiling: null,

    structures: [],
    badAir: [],

    // Every coral sits ON the mesa surface: d ≈ floorAt(x) so the base rests on
    // the seabed/wall and grows up into open water. Gorgonians fan AWAY from the
    // wall (right flank → side:'right', left flank → side:'left'). Clouds hover
    // in open water just off the reef, never inside the rock.
    // Flank depths (right): x9→12, x10→18, x11→24, x12→30, x13→37, x15→52, x16→60.
    features: [
      // ---- PLATEAU (5 m): hard-coral garden + hovering anthias ----
      {kind:'tableCoral', x:-4, d:5},
      {kind:'tableCoral', x:2,  d:5},
      {kind:'brainCoral', x:5,  d:5},
      {kind:'brainCoral', x:6,  d:5},
      {kind:'staghorn',   x:-2, d:5},
      {kind:'staghorn',   x:1,  d:5},
      {kind:'softCoral',  x:-6, d:5, color:'#c84a8a'},
      {kind:'softCoral',  x:7,  d:5, color:'#e8839a'},
      {kind:'anthiasCloud', x:0, d:3, w:240, h:90, count:70, dir:1},
      // ---- UPPER WALLS (12-30 m): soft corals, gorgonians, sponges ----
      {kind:'softCoral',   x:10,  d:18, color:'#e8839a'},
      {kind:'softCoral',   x:-10, d:18, color:'#c84a8a'},
      {kind:'gorgonian',   x:11,  d:24, side:'right', color:'#c83a5a'},
      {kind:'gorgonian',   x:-11, d:24, side:'left',  color:'#a83a4a'},
      {kind:'brainCoral',  x:-10.5, d:21},
      {kind:'barrelSponge',x:12,  d:30, color:'#9c5a3a'},
      {kind:'barrelSponge',x:-12, d:30, color:'#8a4828'},
      // ---- MID WALL (37-52 m): big fans + an off-wall cloud ----
      // Issue #59 — HERO B (Signature Gorgonian): ONE deliberately oversized
      // gorgonian anchored on the right wall at 32 m. `scale:2.15` replaces
      // the coralVariation range (0.80..1.25) entirely — makes this fan
      // clearly bigger than any other individual instance and a natural
      // orientation landmark for the upper/mid wall boundary.
      {kind:'gorgonian',   x:14,  d:32, side:'right', color:'#d84a6a', scale:2.15},
      {kind:'gorgonian',   x:13,  d:37, side:'right', color:'#c83a5a'},
      {kind:'gorgonian',   x:-13, d:37, side:'left',  color:'#882a3a'},
      {kind:'softCoral',   x:15,  d:52, color:'#7a4a8a'},
      {kind:'anthiasCloud',x:-17, d:45, w:200, h:130, count:80, dir:1},
      // ---- DEEP SENTINELS (60+ m): sparse ----
      // Issue #59 — HERO D (Deep Sentinel): ONE additional dark gorgonian
      // at 78 m gives the deep zone a definitive "last landmark" beat
      // beneath the 60 m pair without adding overall density.
      {kind:'gorgonian',   x:16,  d:60, side:'right', color:'#882a3a'},
      {kind:'softCoral',   x:-16, d:60, color:'#7a4a8a'},
      {kind:'gorgonian',   x:-18, d:78, side:'left',  color:'#4a1e2c', scale:1.6}
    ],

    surfaceMarker: 'boat',
    noShark: false,
    currentBias: 0.4,
    // Issue #53 — zones follow the mesa floor profile. Plateau is the flat
    // top at d=5, x=-8..8 (matches the coral-garden feature cluster). Upper
    // wall covers the flanks where the floor drops from d=12 (x=±9) to d=30
    // (x=±12) — softCoral/gorgonian/barrelSponge features live there. Mid
    // wall covers d=30..55 (features at 37 and 52 m). Deep wall covers d=55
    // to abyss (60 m sentinels). Blue water is a wide low-priority fallback
    // for open water off the mesa.
    visualZones: [
      { id: 'reef_plateau',    x1: -8,   x2: 8,   d1: 0,  d2: 8,          priority: 20, blend: 1, tags: ['reef','sunlit','plateau','coral'] },
      { id: 'reef_upper_wall', x1: -16,  x2: 16,  d1: 8,  d2: 30,         priority: 10, blend: 2, tags: ['reef','wall','upper','coral'] },
      // Issue #59 — HERO C (Vertical Crack Cue): a tall thin higher-priority
      // sub-zone along the LEFT flank spanning the upper→mid wall boundary.
      // Data-only, purely visual: gets a darker/cooler atmosphere profile so
      // the strip reads as a shadowed fissure. NOT a collision hole, NOT a
      // new passable cave — the floor profile and structures are unchanged.
      { id: 'reef_crack_cue',  x1: -14.5, x2: -13.5, d1: 15, d2: 40,       priority: 22, blend: 2, tags: ['reef','wall','crack','shadow'] },
      { id: 'reef_mid_wall',   x1: -20,  x2: 20,  d1: 30, d2: 55,         priority: 10, blend: 2, tags: ['reef','wall','mid'] },
      { id: 'reef_deep_wall',  x1: -24,  x2: 24,  d1: 55, d2: 90,         priority: 10, blend: 3, tags: ['reef','wall','deep'] },
      { id: 'reef_blue_water', x1: -100, x2: 100, d1: 0,  d2: MAX_DEPTH,  priority: 0,  blend: 0, tags: ['open-water','blue'] }
    ],
    // Issue #54 — local atmosphere profiles keyed by visualZone id.
    // Issue #59 tuning:
    //   • reef_deep_wall: slightly cooler + darker (0.75→0.68 ambient) to
    //     read as an emptier "sentinel" area rather than "same, just darker".
    //   • reef_crack_cue: dark cool profile so the fissure strip reads as
    //     a shadowed vertical break in the wall (purely visual).
    atmosphereProfiles: {
      reef_plateau:    { visibility: 1.15, tint: [1.02, 1.05, 1.02], particleDensity: 0.75, particleBrightness: 1.15, ambient: 1.10 },
      reef_upper_wall: { visibility: 1.05, tint: [0.98, 1.00, 1.02], particleDensity: 0.85, particleBrightness: 1.05, ambient: 1.00 },
      reef_crack_cue:  { visibility: 0.70, tint: [0.80, 0.88, 1.02], particleDensity: 0.45, particleBrightness: 0.60, ambient: 0.55 },
      reef_mid_wall:   { visibility: 0.95, tint: [0.92, 0.96, 1.02], particleDensity: 0.85, particleBrightness: 0.90, ambient: 0.85 },
      reef_deep_wall:  { visibility: 0.80, tint: [0.78, 0.88, 1.05], particleDensity: 0.45, particleBrightness: 0.70, ambient: 0.68 },
      reef_blue_water: { visibility: 1.20, tint: [0.95, 0.98, 1.05], particleDensity: 0.35, particleBrightness: 0.90, ambient: 1.00 }
    },
    // Issue #55 — decorationRules: deterministic micro set-dressing (reef
    // crust, tiny sponges, small coral branches, loose rock/debris) scattered
    // within the visualZones above. Purely cosmetic filler between the
    // hand-placed features array; never touches physics/collision/gameplay.
    // Issue #59 tuning:
    //   • reef_plateau_crust: slightly denser + tighter so the plateau reads
    //     as the most heavily colonised zone at a glance.
    //   • reef_deep_wall_sparse: pushed even sparser so the sentinel zone
    //     reads as noticeably emptier than the mid wall.
    decorationRules: [
      { id: 'reef_plateau_crust', zone: 'reef_plateau', spacing: 1.3, density: 0.85, seed: 2101, surface: 'floor',
        props: [{kind:'reefCrustBlob',weight:4},{kind:'tinySponge',weight:1},{kind:'pebble',weight:2}] },
      { id: 'reef_upper_wall_micro', zone: 'reef_upper_wall', spacing: 2.5, density: 0.45, seed: 2102, surface: 'floor',
        props: [{kind:'reefCrustBlob',weight:2},{kind:'smallCoralBranch',weight:1},{kind:'debrisSpeck',weight:2}] },
      { id: 'reef_deep_wall_sparse', zone: 'reef_deep_wall', spacing: 5.0, density: 0.2, seed: 2103, surface: 'floor',
        props: [{kind:'smallRock',weight:3},{kind:'debrisSpeck',weight:2}] }
    ]
  },
  wreck: {
    id: 'wreck',
    name: 'Wreck',
    hasOverhead: true,
    // ============================================================
    //  ZENOBIA-inspired Ro-Ro ferry, lying upright on the seabed.
    //  Six internal decks + open bilge.  Recognisable ferry shape
    //  (hull + accommodation block + bridge + funnel + mast).
    //
    //  Depth bands (top → bottom)
    //    Mast cap     …   10 m   (steel pole, visible silhouette)
    //    Funnel       … 14–18 m   (single stack, ship's livery)
    //    Bridge deck  … 18–22 m   (wheelhouse — helm + chart room)
    //    Accom deck   … 22–28 m   (MESS HALL fwd, GUEST CABINS aft)
    //    Main deck      … 28 m    (= vehicle-deck ceiling)
    //    Vehicle deck … 28–40 m   (12 m tall — cars + lorries)
    //    Crew deck    … 40–46 m   (14 cabins; maze of bulkheads)
    //    Cargo hold   … 46–53 m   (8 watertight holds; maze)
    //    Engine room  … 53–62 m   (5 machinery spaces; maze)
    //    Bilge        … 62–66 m   (open below engine deck)
    //
    //  Three deliberate entry penetrations for the diver:
    //    ① Bow visor      x=14..22  d=28..40   (forward vehicle deck)
    //    ② Stern ramp     x=148..168 d=28..40   (aft vehicle deck)
    //    ③ Main hatch     x=78..92  vertical shaft 28→62 m
    //                       (cuts through every deck — light shaft above)
    //
    //  Maze in the lower three decks: every transverse bulkhead has a
    //  1.5 m doorway gap that alternates FLOOR / CEILING along the
    //  length, forcing the diver to swim a zig-zag path.
    //  A few bulkheads are FULL (no gap) — those holds read as dead
    //  ends / jammed-shut watertight doors.
    // ============================================================
    maxDepth: 68,
    entry: { x: 0 },
    boatX: 5,
    floor: [{x:-40,d:66},{x:200,d:66}],
    ceiling: null,
    structures: [
      // ---- HULL SHELL ----------------------------------------
      {x1:14, x2:170, dTop:65, dBottom:66, kind:'hull'},      // keel
      {x1:14, x2:16,  dTop:28, dBottom:66, kind:'hull'},      // bow stem
      {x1:168,x2:170, dTop:28, dBottom:66, kind:'hull'},      // stern transom

      // ---- MAIN DECK (vehicle-deck ceiling) ------------------
      // Bow-visor opening: x=14..22 left as a deliberate gap.
      {x1:22, x2:78,  dTop:27, dBottom:28, kind:'deck'},
      // Main hatch opening: x=78..92 left as a deliberate gap.
      {x1:92, x2:148, dTop:27, dBottom:28, kind:'deck'},
      // Stern-ramp opening: x=148..168 left as a deliberate gap.

      // ---- ACCOMMODATION DECK (22–28 m) ----------------------
      // Outer walls of the superstructure block.
      {x1:40, x2:42,  dTop:22, dBottom:28, kind:'bulkhead'},  // fwd wall
      {x1:138,x2:140, dTop:22, dBottom:28, kind:'bulkhead'},  // aft wall
      // Internal partition between MESS HALL (fwd of midship) and
      // GUEST CABINS (aft of midship). Door gap left at 26..28 m.
      {x1:88, x2:90,  dTop:23, dBottom:26, kind:'bulkhead'},
      // Accommodation roof (= bridge floor)
      {x1:42, x2:78,  dTop:22, dBottom:23, kind:'deck'},
      {x1:92, x2:138, dTop:22, dBottom:23, kind:'deck'},

      // ---- BRIDGE / WHEELHOUSE (18–22 m) ---------------------
      {x1:70, x2:72,  dTop:18, dBottom:23, kind:'bulkhead'},
      {x1:108,x2:110, dTop:18, dBottom:23, kind:'bulkhead'},
      {x1:72, x2:108, dTop:18, dBottom:19, kind:'deck'},      // bridge roof

      // ---- FUNNEL (14–18 m, centred on bridge roof) ----------
      {x1:84, x2:96,  dTop:14, dBottom:19, kind:'funnel'},
      // ---- MAST (10–18 m, forward of funnel) -----------------
      {x1:75, x2:76,  dTop:10, dBottom:18, kind:'mast'},

      // ============================================================
      //  LOWER-DECK FLOORS  (slabs separating the four lower decks)
      // ============================================================
      // Each slab has the central main-hatch gap (x=78..92).
      // Vehicle-deck floor / crew-deck ceiling
      {x1:14, x2:78,  dTop:39, dBottom:40, kind:'deck'},
      {x1:92, x2:168, dTop:39, dBottom:40, kind:'deck'},
      // Crew-deck floor / cargo-hold ceiling
      {x1:14, x2:78,  dTop:45, dBottom:46, kind:'deck'},
      {x1:92, x2:168, dTop:45, dBottom:46, kind:'deck'},
      // Cargo-hold floor / engine-room ceiling
      {x1:14, x2:78,  dTop:52, dBottom:53, kind:'deck'},
      {x1:92, x2:168, dTop:52, dBottom:53, kind:'deck'},
      // Engine-room floor (top of bilge)
      {x1:14, x2:78,  dTop:61, dBottom:62, kind:'deck'},
      {x1:92, x2:168, dTop:61, dBottom:62, kind:'deck'},

      // ============================================================
      //  MAZE — CREW DECK (40–45 m usable; 14 cabins)
      //
      //  Bulkheads 1 m wide every ~10 m along the length.  Each one
      //  has a 1.5 m doorway gap. Adjacent cabins alternate door
      //  height (FLOOR ↔ CEILING) so the swim path zig-zags.
      //    LOW door  → wall spans 40 → 43.5  (gap at 43.5–45)
      //    HIGH door → wall spans 41.5 → 45  (gap at 40–41.5)
      // ============================================================
      // Port-side cabins (between bow and main hatch)
      {x1:22, x2:23,  dTop:40,   dBottom:43.5, kind:'bulkhead'},
      {x1:32, x2:33,  dTop:41.5, dBottom:45,   kind:'bulkhead'},
      {x1:42, x2:43,  dTop:40,   dBottom:43.5, kind:'bulkhead'},
      {x1:52, x2:53,  dTop:41.5, dBottom:45,   kind:'bulkhead'},
      {x1:62, x2:63,  dTop:40,   dBottom:43.5, kind:'bulkhead'},
      {x1:72, x2:73,  dTop:41.5, dBottom:45,   kind:'bulkhead'},
      // Stbd-side cabins (between main hatch and stern)
      {x1:96, x2:97,   dTop:40,   dBottom:43.5, kind:'bulkhead'},
      {x1:106,x2:107,  dTop:41.5, dBottom:45,   kind:'bulkhead'},
      {x1:116,x2:117,  dTop:40,   dBottom:43.5, kind:'bulkhead'},
      {x1:126,x2:127,  dTop:41.5, dBottom:45,   kind:'bulkhead'},
      {x1:136,x2:137,  dTop:40,   dBottom:43.5, kind:'bulkhead'},
      {x1:146,x2:147,  dTop:41.5, dBottom:45,   kind:'bulkhead'},
      {x1:156,x2:157,  dTop:40,   dBottom:43.5, kind:'bulkhead'},

      // ============================================================
      //  MAZE — CARGO HOLD (46–52 m usable; 8 holds, two jammed)
      // ============================================================
      //    LOW door  → wall spans 46 → 50.5  (gap at 50.5–52)
      //    HIGH door → wall spans 47.5 → 52  (gap at 46–47.5)
      //    FULL wall (no gap) marks a jammed watertight door / dead end
      // ============================================================
      {x1:28, x2:29, dTop:46,   dBottom:50.5, kind:'bulkhead'},
      {x1:42, x2:43, dTop:47.5, dBottom:52,   kind:'bulkhead'},
      {x1:56, x2:57, dTop:46,   dBottom:52,   kind:'bulkhead'},   // JAMMED
      {x1:70, x2:71, dTop:47.5, dBottom:52,   kind:'bulkhead'},
      // (main-hatch trunk continues vertically at x=78..92)
      {x1:100,x2:101,dTop:46,   dBottom:50.5, kind:'bulkhead'},
      {x1:114,x2:115,dTop:47.5, dBottom:52,   kind:'bulkhead'},
      {x1:128,x2:129,dTop:46,   dBottom:50.5, kind:'bulkhead'},
      {x1:142,x2:143,dTop:46,   dBottom:52,   kind:'bulkhead'},   // JAMMED
      {x1:156,x2:157,dTop:47.5, dBottom:52,   kind:'bulkhead'},

      // ============================================================
      //  MAZE — ENGINE ROOM (53–61 m usable; 5 machinery spaces)
      //  Wide engineers' walkways: 2 m door at FLOOR everywhere.
      // ============================================================
      {x1:34, x2:35,  dTop:53, dBottom:59, kind:'bulkhead'},
      {x1:56, x2:57,  dTop:53, dBottom:59, kind:'bulkhead'},
      // (main-hatch trunk at x=78..92)
      {x1:112,x2:113, dTop:53, dBottom:59, kind:'bulkhead'},
      {x1:134,x2:135, dTop:53, dBottom:59, kind:'bulkhead'},
      {x1:156,x2:157, dTop:53, dBottom:59, kind:'bulkhead'}
    ],
    badAir: [],
    features: [
      // ---- BRIDGE / WHEELHOUSE (18–22 m) ----
      {kind:'helm',      x:90, d:22},
      // Soft shafts through the three intended entry routes. The renderer fades
      // these in only while the diver is inside the hull so they help navigation
      // without making the exterior look artificially lit.
      {kind:'lightShaft', x:18,  d:34, topHalf:30, botHalf:70, alpha:0.45},
      {kind:'lightShaft', x:85,  d:43, topHalf:38, botHalf:82, alpha:0.42},
      {kind:'lightShaft', x:158, d:34, topHalf:34, botHalf:78, alpha:0.45},

      // ---- ACCOMMODATION DECK (22–28 m) ----
      // Mess hall fwd of midship: row of long tables (rest on the 27 m deck).
      {kind:'messTable', x:50, d:27},
      {kind:'messTable', x:60, d:27},
      {kind:'messTable', x:70, d:27},
      {kind:'messTable', x:80, d:27},
      // (guest cabins aft — partitions render via the deck/bulkhead
      //  structures already; portholes appear automatically.)

      // ---- LIFEBOATS hanging off the accommodation block sides ----
      {kind:'lifeboat',  x:46,  d:23.5},
      {kind:'lifeboat',  x:134, d:23.5},

      // ---- BOW VISOR — hinged-up door over the forward opening ----
      {kind:'bowVisor',  x:18,  d:26},

      // ---- VEHICLE DECK (28–39 m) — lined-up cars + lorries -----
      // Rest on the 39 m deck floor. Spaced to clear the new realistic sizes
      // (car ≈ 3.6 m, lorry ≈ 6.5 m).
      {kind:'lorry', x:24,  d:39},
      {kind:'car',   x:34,  d:39},
      {kind:'car',   x:42,  d:39},
      {kind:'lorry', x:54,  d:39},
      {kind:'car',   x:64,  d:39},
      {kind:'car',   x:72,  d:39},
      // (gap for main hatch x=78..92)
      {kind:'car',   x:98,  d:39},
      {kind:'lorry', x:110, d:39},
      {kind:'car',   x:122, d:39},
      {kind:'lorry', x:134, d:39},
      {kind:'car',   x:146, d:39},
      {kind:'car',   x:160, d:39},

      // ---- CREW QUARTERS (40–45 m) — one bunk per cabin --------
      // Rest on the 45 m crew-deck floor.
      // Port-side cabins
      {kind:'bunk', x:19, d:45},
      {kind:'bunk', x:28, d:45},
      {kind:'bunk', x:38, d:45},
      {kind:'bunk', x:48, d:45},
      {kind:'bunk', x:58, d:45},
      {kind:'bunk', x:68, d:45},
      {kind:'bunk', x:76, d:45},
      // Stbd-side cabins
      {kind:'bunk', x:95,  d:45},
      {kind:'bunk', x:102, d:45},
      {kind:'bunk', x:112, d:45},
      {kind:'bunk', x:122, d:45},
      {kind:'bunk', x:132, d:45},
      {kind:'bunk', x:142, d:45},
      {kind:'bunk', x:152, d:45},
      {kind:'bunk', x:163, d:45},

      // ---- CARGO HOLD (46–52 m) — intermodal containers ------
      // Rest on the 52 m cargo-hold floor.
      {kind:'container', x:22,  d:52, color:'#3a6a4a'},
      {kind:'container', x:36,  d:52, color:'#7a3026'},
      {kind:'container', x:50,  d:52, color:'#5a4828'},
      {kind:'container', x:64,  d:52, color:'#2a4a6a'},
      {kind:'container', x:96,  d:52, color:'#7a6048'},
      {kind:'container', x:108, d:52, color:'#3a4a3a'},
      {kind:'container', x:122, d:52, color:'#7a3026'},
      {kind:'container', x:136, d:52, color:'#3a6a4a'},
      {kind:'container', x:150, d:52, color:'#5a4828'},
      {kind:'container', x:162, d:52, color:'#2a4a6a'},

      // ---- ENGINE ROOM (53–61 m) — main engines + auxiliaries -
      // Rest on the 61 m engine-room floor.
      {kind:'engine', x:25,  d:61},   // port fwd main engine
      {kind:'engine', x:46,  d:61},   // port aft main engine
      {kind:'engine', x:68,  d:61},   // generator / aux
      {kind:'engine', x:102, d:61},   // stbd main engine
      {kind:'engine', x:122, d:61},   // stbd aft engine
      {kind:'engine', x:144, d:61},   // generator
      {kind:'container', x:162, d:61, color:'#1a1a1a'},  // fuel bunker

      // ---- HULL BREACHES — secondary entry points ------------
      {kind:'rustHole', x:82,  d:50},
      {kind:'rustHole', x:152, d:58},
      {kind:'rustHole', x:30,  d:44},

      // ---- ISSUE #33 — Sagging lines + torn net (cosmetic only) ---
      // Hand-placed near existing rustHoles and away from the three
      // deliberate entry markers (BOW x=16..22, HATCH x=78..92,
      // STERN x=148..168). Motion comes exclusively from #57's
      // sampleEnvironmentSway(SWAY_PROFILES.hangingLine / .net) — no
      // rope physics, no collision. Kept sparse (a handful) so they
      // read as atmospheric detail, not a focal prop.
      // Line drifting near the port-side hull breach (rustHole x=30, d=44)
      {kind:'line', x:35,  d:41, length:2.6, sag:1.2},
      // Line near the mid-hatch rust hole (rustHole x=82, d=50)
      {kind:'line', x:76,  d:47, length:1.9, sag:1.1},
      // Line off the stern rust hole (rustHole x=152, d=58)
      {kind:'line', x:145, d:55, length:2.4, sag:1.4},
      // Torn fishing net snagged over the crew-deck ceiling area
      // (near, but not blocking, the aft crew cabins)
      {kind:'net',  x:118, d:41, width:3.2, height:2.6},
      // Small piece of drift net caught inside the vehicle deck
      // between the port lorry and a car (x≈30 is clear of BOW/HATCH)
      {kind:'net',  x:100, d:32, width:2.4, height:2.0},

      // ---- Debris scattered OUTSIDE the hull on the seabed ----
      // Big bower anchor lying on the seabed off the bow (left of the wreck),
      // its chain long since parted from the ship.
      {kind:'anchor', x:2,  d:66, scale:2.4},
      {kind:'lorry', x:-8,  d:66},
      {kind:'car',   x:182, d:66},
      {kind:'car',   x:188, d:66}
    ],
    surfaceMarker: 'boat',
    noShark: false,
    currentBias: 0.2,
    // Issue #53 — deck bands come straight from the site's own comment
    // header (bridge 18-22, accommodation 22-28, vehicle 28-40, crew 40-46,
    // cargo 46-53, engine 53-62, bilge 62-66). Interior x-range = hull span
    // from bow stem (x=14..16) to stern transom (x=168..170). Bridge is
    // narrower (x=70..110) — matches the wheelhouse bulkheads at x=70..72
    // and x=108..110. Accommodation width (x=40..140) matches the outer
    // superstructure walls at x=40..42 and x=138..140. Bridge/interior have
    // priority ≥ 15 so wreck_exterior (priority 0, world-wide fallback)
    // never swallows them despite being defined over the same rectangle.
    visualZones: [
      { id: 'wreck_exterior',      x1: -40, x2: 200, d1: 0,  d2: 66, priority: 0,  blend: 0, tags: ['wreck','open-water','outside-hull'] },
      { id: 'wreck_bridge',        x1: 70,  x2: 110, d1: 18, d2: 22, priority: 20, blend: 1, tags: ['wreck','interior','bridge','confined'] },
      { id: 'wreck_accommodation', x1: 40,  x2: 140, d1: 22, d2: 28, priority: 15, blend: 1, tags: ['wreck','interior','accommodation'] },
      { id: 'wreck_vehicle_deck',  x1: 14,  x2: 170, d1: 28, d2: 40, priority: 15, blend: 1, tags: ['wreck','interior','vehicle-deck','cargo'] },
      { id: 'wreck_crew_deck',     x1: 14,  x2: 170, d1: 40, d2: 46, priority: 15, blend: 1, tags: ['wreck','interior','maze','crew'] },
      { id: 'wreck_cargo_hold',    x1: 14,  x2: 170, d1: 46, d2: 53, priority: 15, blend: 1, tags: ['wreck','interior','maze','cargo'] },
      { id: 'wreck_engine_room',   x1: 14,  x2: 170, d1: 53, d2: 62, priority: 15, blend: 1, tags: ['wreck','interior','deep','engine'] },
      { id: 'wreck_bilge',         x1: 14,  x2: 170, d1: 62, d2: 66, priority: 15, blend: 0, tags: ['wreck','interior','deep','bilge'] }
    ],
    // Issue #54 — local atmosphere profiles keyed by visualZone id.
    // Issue #59 tuning: sharpen the identity gradient so each deck reads
    // distinctly from its neighbours at a glance.
    //   • Bridge: pushed slightly cleaner/brighter (visibility 0.95→1.00,
    //     particleDensity 1.05→0.90) so the wheelhouse feels more open than
    //     the deeper interior spaces.
    //   • Cargo hold: heavier turbidity (particleDensity 1.35→1.55, warmer
    //     tint) so container colours read against a hazier medium.
    //   • Engine room: darker + warmer rust cast (ambient 0.65→0.58, tint R
    //     1.08→1.12) — the most technical and darkest working space.
    //   • Crew deck: same overall level but noticeably more particle-heavy
    //     (1.15→1.30) to feel small-scale/cramped.
    atmosphereProfiles: {
      wreck_exterior:      { visibility: 1.00, tint: [1.00, 1.00, 1.00], particleDensity: 1.00, particleBrightness: 1.00, ambient: 1.00 },
      wreck_bridge:        { visibility: 1.00, tint: [1.02, 1.00, 0.96], particleDensity: 0.90, particleBrightness: 1.00, ambient: 0.98 },
      wreck_accommodation: { visibility: 0.90, tint: [1.02, 0.98, 0.92], particleDensity: 1.15, particleBrightness: 0.90, ambient: 0.90 },
      wreck_vehicle_deck:  { visibility: 0.85, tint: [1.02, 0.96, 0.90], particleDensity: 1.20, particleBrightness: 0.85, ambient: 0.85 },
      wreck_crew_deck:     { visibility: 0.78, tint: [1.00, 0.94, 0.88], particleDensity: 1.30, particleBrightness: 0.78, ambient: 0.72 },
      wreck_cargo_hold:    { visibility: 0.75, tint: [1.05, 0.92, 0.84], particleDensity: 1.55, particleBrightness: 0.80, ambient: 0.72 },
      wreck_engine_room:   { visibility: 0.66, tint: [1.12, 0.90, 0.78], particleDensity: 1.25, particleBrightness: 0.72, ambient: 0.58 },
      wreck_bilge:         { visibility: 0.55, tint: [1.08, 0.88, 0.76], particleDensity: 1.55, particleBrightness: 0.68, ambient: 0.50 }
    },
    // Issue #55 — decorationRules: deterministic micro set-dressing (rust
    // flakes, metal debris, sediment clumps, cable scraps) scattered within
    // the visualZones above. Purely cosmetic filler between the hand-placed
    // features array; never touches physics/collision/gameplay. The exterior
    // rule carries minDepth so scraps only appear near/below the hull rather
    // than floating in open water above the wreck.
    // Issue #59 tuning:
    //   • wreck_vehicle_deck_debris: nudged denser (0.55→0.65) — vehicle deck
    //     is the widest, most horizontal space; extra sediment reinforces the
    //     "open loading hall" feel without changing sightlines.
    //   • wreck_engine_room_debris: heavier rust flake weight so the machinery
    //     space reads as the rustiest area, matching its warmer tint.
    //   • wreck_cargo_hold_sediment (new): subtle sediment scatter tying the
    //     hold to its warmer/hazier atmosphere. Kept sparse — containers stay
    //     the visual identity, sediment is atmospheric backing.
    //   Crew deck deliberately gets NO decoration rule so it stays cramped
    //   and read-through-bulkheads clean, not object-flooded.
    decorationRules: [
      { id: 'wreck_vehicle_deck_debris', zone: 'wreck_vehicle_deck', spacing: 2.0, density: 0.65, seed: 3101, surface: 'floor',
        props: [{kind:'rustFlake',weight:3},{kind:'smallMetalDebris',weight:2},{kind:'sedimentClump',weight:2},{kind:'cableScrap',weight:1}] },
      { id: 'wreck_engine_room_debris', zone: 'wreck_engine_room', spacing: 2.2, density: 0.55, seed: 3102, surface: 'floor',
        props: [{kind:'rustFlake',weight:5},{kind:'smallMetalDebris',weight:3},{kind:'debrisSpeck',weight:1}] },
      { id: 'wreck_cargo_hold_sediment', zone: 'wreck_cargo_hold', spacing: 2.8, density: 0.35, seed: 3104, surface: 'floor',
        props: [{kind:'sedimentClump',weight:4},{kind:'rustFlake',weight:1},{kind:'debrisSpeck',weight:2}] },
      { id: 'wreck_exterior_scraps', zone: 'wreck_exterior', spacing: 4.5, density: 0.25, seed: 3103, surface: 'floor', minDepth: 20,
        props: [{kind:'rustFlake',weight:2},{kind:'smallMetalDebris',weight:1},{kind:'sedimentClump',weight:2}] }
    ]
  },
  cave: {
    id: 'cave',
    name: 'Cave',
    hasOverhead: true,
    maxDepth: 106,
    entry: { x: 0 },
    // A long cenote penetration that FORKS into two genuinely separate routes,
    // divided by a solid wall of bedrock (the 'bedrock' structure below — NOT
    // a pile of boulders):
    //   ◦ UPPER tunnel — a shallow passage hugging the ceiling the whole way
    //     across (past a trapped bad-air pocket), and
    //   ◦ LOWER tunnel — plunges from the fork down a steep shaft to ~100 m,
    //     where it opens out into a vast deep "cathedral" chamber, then climbs
    //     back up the far shaft and rejoins the upper tunnel before the final
    //     ascent to the surface.
    // The envelope ceiling/floor are the OUTER walls of the whole cave; the
    // bedrock mass (d22→52, x70–130) is the solid partition that separates the
    // shallow upper tunnel from the deep cathedral below it. The two routes
    // connect only through the open shafts at x≈56–70 (down) and x≈130–146
    // (up). Deeper = colder grey stone (depth-graded in drawTerrain).
    floor: [
      {x:-10,d:2},{x:0,d:10},{x:15,d:16},{x:30,d:20},{x:50,d:23},
      {x:56,d:42},{x:64,d:74},{x:72,d:96},{x:90,d:103},{x:112,d:103},
      {x:124,d:95},{x:132,d:74},{x:140,d:42},{x:146,d:24},{x:160,d:20},
      {x:185,d:14},{x:200,d:6}
    ],
    ceiling: [
      {x:-10,d:0},{x:14,d:0},{x:18,d:14},{x:30,d:15},{x:50,d:14},
      {x:75,d:13},{x:103,d:12},{x:109,d:12},{x:130,d:14},{x:146,d:16},
      {x:160,d:15},{x:185,d:9},{x:196,d:4},{x:200,d:0}
    ],
    structures: [
      // ── Solid bedrock partition: the floor of the shallow UPPER tunnel and
      //    the roof of the deep CATHEDRAL. A continuous rock mass (not
      //    boulders) so the two routes are truly separated; the diver can only
      //    cross between them via the open shafts at each end. ──
      {x1:70, x2:130, dTop:22, dBottom:52, kind:'bedrock'},
      // Restriction nub hanging into the UPPER tunnel — squeeze past it
      {x1:88, x2:91,  dTop:12, dBottom:16, kind:'pillar'}
    ],
    badAir: [
      {x1:103,x2:109,d:12}
    ],
    features: [
      {kind:'pond',x:0},
      {kind:'warningSign',x:17},
      // Issue #59 — HERO D (Cathedral columns): 1-2 large hand-placed
      // speleothem columns inside the deep chamber. Reuses #32's
      // _drawSpeleothemColumn drawer (no new rendering framework). Both
      // sit within cave_cathedral (x=60..134, d=52..104) but well clear of
      // the bedrock ceiling (dTop≥52) and the cave floor (see floor profile).
      //   Column A: x=88, dTop=56, dBottom=98 — near-central pillar; the
      //     dramatic single-column focal point on the way through.
      //   Column B: x=112, dTop=60, dBottom=95 — slimmer, off-axis, reads
      //     as a distant background pillar giving depth to the chamber.
      // Neither introduces collision — solidAt() only tests the AABB
      // structures list, and neither column is added there.
      {kind:'caveColumn', x:88,  dTop:56, dBottom:98, wTop:9,  wBot:11, seed:5901},
      {kind:'caveColumn', x:112, dTop:60, dBottom:95, wTop:6,  wBot:8,  seed:5902}
    ],
    surfaceMarker: 'pond',
    noShark: true,
    currentBias: 0.05,
    // Issue #53 — anchored on the ceiling/floor profiles and the bedrock
    // partition. The cenote is open to surface where the ceiling is d=0 for
    // x=-10..14, then dives to d=14 at x=18. Upper tunnel runs along the
    // ceiling (d≈12..16) above the bedrock top (d=22, x=70..130). The floor
    // plunges from d=23 (x=50) to d=42 (x=56) to d=74 (x=64) to d=96 (x=72)
    // — that's the down shaft. Cathedral is the deep chamber under the
    // bedrock (d=52..103 for x=70..130); given priority 25 so it wins over
    // any overlapping shaft/tunnel zone and reads as its own dramatic space.
    // Up shaft mirrors the down shaft (x=124..146). Exit tunnel ascends
    // where the ceiling rises again from d=16 (x=146) to d=0 (x=200).
    visualZones: [
      { id: 'cave_entrance',     x1: -10, x2: 18,  d1: 0,  d2: 14,  priority: 10, blend: 1, tags: ['cave','entrance','open-to-surface'] },
      // Issue #59 — HERO B (Warning Threshold): a narrow, higher-priority
      // sub-zone straddling the warningSign at x=17 marks the "open water →
      // overhead" transition with its own subtly darker/cooler atmosphere
      // so the threshold reads without needing a bigger sign.
      { id: 'cave_threshold',    x1: 15,  x2: 22,  d1: 6,  d2: 16,  priority: 20, blend: 1, tags: ['cave','threshold','warning'] },
      { id: 'cave_upper_tunnel', x1: 18,  x2: 146, d1: 10, d2: 22,  priority: 15, blend: 1, tags: ['cave','tunnel','shallow'] },
      // Issue #59 — HERO C (Restriction Nub): a tight sub-zone wrapping the
      // pillar at x=88..91 with a claustrophobic atmosphere (lower visibility,
      // higher particle density) so the squeeze reads more strongly. No
      // collision change — the pillar structure is unchanged.
      { id: 'cave_restriction',  x1: 86,  x2: 93,  d1: 10, d2: 22,  priority: 22, blend: 1, tags: ['cave','tunnel','restriction','squeeze'] },
      { id: 'cave_down_shaft',   x1: 48,  x2: 72,  d1: 20, d2: 90,  priority: 15, blend: 2, tags: ['cave','shaft','descent'] },
      { id: 'cave_cathedral',    x1: 60,  x2: 134, d1: 50, d2: 104, priority: 25, blend: 3, tags: ['cave','cathedral','deep','open-chamber'] },
      { id: 'cave_up_shaft',     x1: 124, x2: 146, d1: 20, d2: 90,  priority: 15, blend: 2, tags: ['cave','shaft','ascent'] },
      { id: 'cave_exit',         x1: 146, x2: 200, d1: 0,  d2: 20,  priority: 10, blend: 1, tags: ['cave','exit','open-to-surface'] }
    ],
    // Issue #54 — local atmosphere profiles keyed by visualZone id.
    // Issue #59 tuning:
    //   • cave_entrance: brightest area — bumped ambient/visibility to
    //     reinforce the "surface light spills in here" reading.
    //   • cave_threshold: darker/cooler than entrance so the warning sign
    //     zone reads as a definite step-down into overhead.
    //   • cave_restriction: tightened visibility + heavier particles to
    //     make the squeeze past the nub feel physically confined.
    //   • cave_cathedral: pushed cooler + slightly more ambient so the
    //     chamber reads as vast/cold rather than merely dark.
    //   • cave_exit: bright as entrance so the exit staging reads unambiguously.
    atmosphereProfiles: {
      cave_entrance:     { visibility: 1.15, tint: [0.98, 1.06, 0.94], particleDensity: 1.00, particleBrightness: 1.10, ambient: 1.20 },
      cave_threshold:    { visibility: 0.85, tint: [0.94, 0.98, 1.00], particleDensity: 1.10, particleBrightness: 0.85, ambient: 0.75 },
      cave_upper_tunnel: { visibility: 0.90, tint: [0.95, 0.98, 1.00], particleDensity: 1.00, particleBrightness: 0.85, ambient: 0.80 },
      cave_restriction:  { visibility: 0.75, tint: [0.94, 0.96, 1.00], particleDensity: 1.30, particleBrightness: 0.80, ambient: 0.68 },
      cave_down_shaft:   { visibility: 0.85, tint: [0.92, 0.96, 1.05], particleDensity: 0.85, particleBrightness: 0.80, ambient: 0.75 },
      cave_cathedral:    { visibility: 1.20, tint: [0.84, 0.92, 1.10], particleDensity: 0.35, particleBrightness: 0.72, ambient: 0.65 },
      cave_up_shaft:     { visibility: 0.85, tint: [0.92, 0.96, 1.05], particleDensity: 0.85, particleBrightness: 0.80, ambient: 0.75 },
      cave_exit:         { visibility: 1.15, tint: [0.98, 1.06, 0.94], particleDensity: 0.95, particleBrightness: 1.05, ambient: 1.15 }
    },
    // Issue #55 — decorationRules: deterministic micro set-dressing (calcite
    // chips, rock fragments, small stalagmites/stalactites) scattered within
    // the visualZones above. Purely cosmetic filler between the hand-placed
    // features array; never touches physics/collision/gameplay. Cathedral
    // gets both a floor rule and a ceiling rule since it is tall and open.
    // Issue #59 tuning:
    //   • cave_cathedral_{floor,ceiling}: lower density so the chamber reads
    //     as more open and the two hand-placed columns dominate as focal
    //     points rather than getting lost in a forest of small speleothems.
    //   • cave_restriction_chips (new): a tight, mineral-heavy scatter right
    //     at the pillar so contact/mineral cues (per brief C) make the
    //     squeeze read as a natural rock-carved constriction.
    decorationRules: [
      { id: 'cave_entrance_chips', zone: 'cave_entrance', spacing: 2.0, density: 0.5, seed: 4101, surface: 'floor',
        props: [{kind:'calciteChip',weight:3},{kind:'rockFragment',weight:2},{kind:'pebble',weight:2}] },
      { id: 'cave_cathedral_floor', zone: 'cave_cathedral', spacing: 4.5, density: 0.28, seed: 4102, surface: 'floor',
        props: [{kind:'smallStalagmite',weight:2},{kind:'rockFragment',weight:3},{kind:'calciteChip',weight:2}] },
      { id: 'cave_cathedral_ceiling', zone: 'cave_cathedral', spacing: 5.0, density: 0.25, seed: 4103, surface: 'ceiling',
        props: [{kind:'smallStalactite',weight:3},{kind:'calciteChip',weight:1}] },
      { id: 'cave_upper_tunnel_sparse', zone: 'cave_upper_tunnel', spacing: 3.5, density: 0.3, seed: 4104, surface: 'floor',
        props: [{kind:'pebble',weight:3},{kind:'rockFragment',weight:2},{kind:'calciteChip',weight:1}] },
      { id: 'cave_restriction_chips', zone: 'cave_restriction', spacing: 1.4, density: 0.7, seed: 4105, surface: 'floor',
        props: [{kind:'calciteChip',weight:4},{kind:'rockFragment',weight:2}] }
    ]
  }
};

// ============================================================
//  GEOMETRY HELPERS
// ============================================================

function activeSite() {
  return DIVE_SITES[diveSite] || null;
}

// Piecewise-linear interpolation of a [{x,d}] profile at world-x.
// Clamped to the first/last value outside the defined range.
function lerpProfile(points, x) {
  if (!points || !points.length) return null;
  if (x <= points[0].x) return points[0].d;
  var last = points[points.length - 1];
  if (x >= last.x) return last.d;
  for (var i = 1; i < points.length; i++) {
    if (x <= points[i].x) {
      var a = points[i - 1], b = points[i];
      var t = (x - a.x) / (b.x - a.x);
      return a.d + (b.d - a.d) * t;
    }
  }
  return last.d;
}

// Deepest depth the diver can legally reach at world-x.
// Open site (or site with no floor) returns MAX_DEPTH.
function floorAt(x) {
  var s = activeSite();
  if (!s || !s.floor) return MAX_DEPTH;
  return Math.min(MAX_DEPTH, lerpProfile(s.floor, x));
}

// Shallowest depth the diver can reach at world-x.
// 0 = open to the surface.  >0 = hard overhead rock/hull.
function ceilingAt(x) {
  var s = activeSite();
  if (!s || !s.ceiling) return 0;
  return Math.max(0, lerpProfile(s.ceiling, x));
}

// True if the point (x, d) falls inside any solid AABB structure.
function solidAt(x, d) {
  var s = activeSite();
  if (!s) return false;
  for (var i = 0; i < s.structures.length; i++) {
    var w = s.structures[i];
    if (x >= w.x1 && x <= w.x2 && d >= w.dTop && d <= w.dBottom) return true;
  }
  return false;
}

// True if an axis-aligned box centred on (x, d) overlaps any solid structure.
//
// Issue #122: solidAt() is a point test, so the diver only stopped once its
// CENTRE reached a wall and the sprite had already penetrated about a metre.
// This is the same AABB comparison widened by the diver's extent — still exact,
// not sampled, so a box can never slip between two probe points.
//
// solidAt() is kept as-is rather than reimplemented in terms of this: it is the
// site-geometry predicate the parity suite replays and other callers (fauna
// steering, visual zones) genuinely want a point test.
function solidBoxAt(x, d, halfWidth, halfHeight) {
  var s = activeSite();
  if (!s) return false;
  for (var i = 0; i < s.structures.length; i++) {
    var w = s.structures[i];
    if (x + halfWidth >= w.x1 && x - halfWidth <= w.x2 &&
        d + halfHeight >= w.dTop && d - halfHeight <= w.dBottom) return true;
  }
  return false;
}

// The diver's own body, for the movement code. Everything that asks "can the
// diver be here" goes through this rather than solidAt().
function diverSolidAt(x, d) {
  return solidBoxAt(x, d, DIVER_HALF_WIDTH_M, DIVER_HALF_HEIGHT_M);
}

// How much of a box centred on (x, d) is buried in solid structure, as summed
// overlap area in m².
//
// A boolean "am I inside something" is not enough to move safely out of an
// overlap. Permitting *any* movement while overlapping lets the diver keep
// going straight through and out the far side — from x=16.2 the diver crossed
// the entire bow stem to x=11, and one resting 0.1 m into the 39..40 m deck
// fell through it to d=43.7. Comparing buried area before and after a step
// distinguishes "getting out" from "going further in", which a boolean cannot.
function solidOverlapArea(x, d, halfWidth, halfHeight) {
  var s = activeSite();
  if (!s) return 0;
  var total = 0;
  for (var i = 0; i < s.structures.length; i++) {
    var w = s.structures[i];
    var dx = Math.min(x + halfWidth, w.x2) - Math.max(x - halfWidth, w.x1);
    if (dx <= 0) continue;
    var dd = Math.min(d + halfHeight, w.dBottom) - Math.max(d - halfHeight, w.dTop);
    if (dd <= 0) continue;
    total += dx * dd;
  }
  return total;
}

function diverOverlapArea(x, d) {
  return solidOverlapArea(x, d, DIVER_HALF_WIDTH_M, DIVER_HALF_HEIGHT_M);
}

// True if moving from (fromX, fromD) to (toX, toD) would bury the diver deeper.
//
// The comparison needs a tolerance, and the tolerance is the whole point. A
// fully engulfed diver sits on a mathematically FLAT gradient — the buried area
// is a constant 0.54 m² whichever way it moves — and that allowance is what
// lets it work its way out instead of being pinned. But a flat gradient does
// not produce bitwise-equal doubles: at wreck (15.5, 63.7) adjacent depths
// sample as 0.539999999999994 and 0.5400000000000005, so an exact `>` reads
// "no change" as "deeper" and re-traps the diver — at d=63.706328 with zero
// velocity, still inside the hull. Whether it happened depended on the
// coordinate, which is the worst kind of intermittent.
//
// Scaled to the diver's own box so it stays correct if the extents change, and
// ~1e-9 of it: far above double noise (~1e-16 at this magnitude), far below any
// overlap change a movement step could actually produce.
// Push the diver out of any structure it is overlapping, along whichever axis
// needs the least movement, and report whether it moved.
//
// Issue #131: escaping an overlap during movement requires allowing equal-area
// steps, because a fully engulfed diver sits on a flat gradient and has no
// strictly-reducing step available. That allowance also lets it slide along
// inside a slab. Resolving the overlap before physics runs makes the engulfed
// state transient instead of somewhere the diver can travel.
//
// An overlap is only reachable anomalously — a restored save, a site switch,
// edited geometry — so a discontinuous nudge is the right shape of fix. It is
// also less strange to watch than a diver swimming out through solid steel.
function resolveDiverOverlap() {
  var s = activeSite();
  if (!s) return false;
  var moved = false;

  // Bounded: each pass strictly reduces buried area, so it terminates. Ten is
  // far more than the authored geometry stacks.
  for (var pass = 0; pass < 10; pass++) {
    var here = diverOverlapArea(diverX, depth);
    if (here <= 0) return moved;

    // Candidate exits from EVERY structure the diver is inside, not just the
    // deepest one. Exiting one box at a time ping-pongs through stacked
    // geometry: at the wreck mast (x=75..76, d=10..18) sitting on the bridge
    // deck (x=72..108, d=18..19) the two form one continuous column, and
    // leaving the mast downward lands in the deck, whose own cheapest exit is
    // straight back up into the mast. The diver oscillated 17.7 <-> 18.3 until
    // the pass limit gave up.
    var CLEAR = 1e-6;
    var candidates = [];
    for (var i = 0; i < s.structures.length; i++) {
      var w = s.structures[i];
      var dx = Math.min(diverX + DIVER_HALF_WIDTH_M, w.x2) - Math.max(diverX - DIVER_HALF_WIDTH_M, w.x1);
      if (dx <= 0) continue;
      var dd = Math.min(depth + DIVER_HALF_HEIGHT_M, w.dBottom) - Math.max(depth - DIVER_HALF_HEIGHT_M, w.dTop);
      if (dd <= 0) continue;
      candidates.push({ x: w.x1 - DIVER_HALF_WIDTH_M - CLEAR,  d: depth, vertical: false });
      candidates.push({ x: w.x2 + DIVER_HALF_WIDTH_M + CLEAR,  d: depth, vertical: false });
      candidates.push({ x: diverX, d: w.dTop - DIVER_HALF_HEIGHT_M - CLEAR,    vertical: true });
      candidates.push({ x: diverX, d: w.dBottom + DIVER_HALF_HEIGHT_M + CLEAR, vertical: true });
    }

    // The NEAREST candidate that makes progress, not the one that clears the
    // most. Ranking residual area first made the resolver jump straight to
    // whatever fully freed it, however far away: at the wreck bulkhead/deck
    // corner (56.1, 51.9) that was a 22.35 m horizontal teleport to the main
    // hatch, when stepping 0.55 m left and then 0.2 m up clears it in two
    // passes for about 0.75 m total.
    //
    // Requiring a strict reduction is what guarantees termination — each pass
    // leaves the diver less buried than it found it, and zero is the floor.
    //
    // Legality is checked against the site clamp, because an exit the clamp
    // undoes is not an exit. On the wreck keel (x=14..170, d=65..66, floor 66)
    // at (100, 65.5), up and down tie on distance; "down" reached d=66.300001
    // and the buoyancy clamp put it straight back to d=66, still inside, where
    // it stayed for as long as anything cared to tick.
    var best = null;
    for (var c = 0; c < candidates.length; c++) {
      var cand = candidates[c];
      var legal = cand.vertical
        ? (cand.d >= ceilingAt(diverX) && cand.d <= floorAt(diverX) &&
           cand.d >= 0 && cand.d <= MAX_DEPTH)
        : (depth >= ceilingAt(cand.x) && depth <= floorAt(cand.x));
      if (!legal) continue;
      var after = diverOverlapArea(cand.x, cand.d);
      if (after >= here - 1e-12) continue;   // no progress: cannot terminate on it
      var move = Math.abs(cand.vertical ? cand.d - depth : cand.x - diverX);
      if (best === null || move < best.move) {
        best = { cand: cand, after: after, move: move };
      }
    }

    // Nothing legal, or nothing that improves matters: the diver is buried in
    // geometry with no way out the site clamp will allow. Shoving it somewhere
    // illegal would trade one stuck state for another, so leave it to the
    // movement rule, which still permits overlap-reducing steps.
    if (best === null) return moved;

    if (best.cand.vertical) {
      depth = best.cand.d;
      verticalVelocity = 0;
    } else {
      diverX = best.cand.x;
      horizontalVelocity = 0;
    }
    moved = true;
  }
  return moved;
}

function diverOverlapGrew(fromX, fromD, toX, toD) {
  var tolerance = (2 * DIVER_HALF_WIDTH_M) * (2 * DIVER_HALF_HEIGHT_M) * 1e-9;
  return diverOverlapArea(toX, toD) > diverOverlapArea(fromX, fromD) + tolerance;
}

// True if the straight-up path from (x, d) to the surface is blocked.
// Drives torch / silt / guideline / rule-of-thirds for overhead environments.
function overheadAt(x, d) {
  var s = activeSite();
  if (!s || !s.hasOverhead) return false;
  // Hard ceiling profile blocks the path
  if (ceilingAt(x) > 0.5 && d >= ceilingAt(x) - 0.01) return true;
  // Any solid structure with its bottom above the diver = overhead slab
  for (var i = 0; i < s.structures.length; i++) {
    var w = s.structures[i];
    if (x >= w.x1 && x <= w.x2 && w.dBottom < d) return true;
  }
  return false;
}

// Returns the bad-air dome descriptor {x1,x2,d} if (x) falls within one, else null.
function badAirAt(x) {
  var s = activeSite();
  if (!s) return null;
  for (var i = 0; i < s.badAir.length; i++) {
    var p = s.badAir[i];
    if (x >= p.x1 && x <= p.x2) return p;
  }
  return null;
}

// ============================================================
//  ISSUE #53 — VISUAL ZONE LOOKUP
//
//  visualZoneAt(x, d, site?)
//    Returns the single best-matching zone object at (x, d), or null.
//    Selection is DETERMINISTIC:
//      1. Only zones whose rectangle contains (x, d) are candidates.
//         Rectangle test is INCLUSIVE on both edges of x1/x2/d1/d2,
//         matching the convention used by solidAt()/badAirAt().
//      2. Highest `priority` wins (missing priority defaults to 0).
//      3. Priority tie → smaller-area zone wins, so specific sub-zones
//         always override broader wrappers.
//      4. Deterministic zero-area tie-break: the zone declared earlier
//         in the visualZones array wins (only reachable if two zones
//         have identical priority AND identical area — otherwise the
//         first two rules already picked a winner).
//      5. No candidate → null.
//    `site` is optional; defaults to the active site so most callers
//    can just pass (x, d).
//
//  zoneBlendWeight(zone, x, d)
//    Returns a scalar in [0, 1] describing how deep inside its OWN
//    rectangle the point (x, d) is:
//      • 0 if the point is outside the zone
//      • 1 if the point is inside the core (further from every edge
//        than the zone's `blend` margin, or if blend is 0/absent)
//      • smoothstep-interpolated between 0 and 1 within `blend` metres
//        of the nearest edge.
//    Consumers that want soft transitions should call visualZoneAt() to
//    pick the zone, then this helper to get an interior/edge factor.
//    (We deliberately expose the single-value form instead of a
//    multi-zone weights array — the array form is documented as
//    optional in issue #53 and no consumer needs it yet.)
// ============================================================

const VISUAL_ZONE_DEFAULT_PRIORITY = 0;
const VISUAL_ZONE_DEFAULT_BLEND    = 0;

function visualZoneAt(x, d, site) {
  var s = site || activeSite();
  if (!s || !s.visualZones) return null;
  var zones = s.visualZones;
  var best = null;
  var bestPrio = -Infinity;
  var bestArea = Infinity;
  var bestIdx  = Infinity;
  for (var i = 0; i < zones.length; i++) {
    var z = zones[i];
    if (x < z.x1 || x > z.x2 || d < z.d1 || d > z.d2) continue;
    var prio = (z.priority != null) ? z.priority : VISUAL_ZONE_DEFAULT_PRIORITY;
    var area = (z.x2 - z.x1) * (z.d2 - z.d1);
    var better = false;
    if (prio > bestPrio) better = true;
    else if (prio === bestPrio) {
      if (area < bestArea) better = true;
      else if (area === bestArea && i < bestIdx) better = true;
    }
    if (better) {
      best = z;
      bestPrio = prio;
      bestArea = area;
      bestIdx  = i;
    }
  }
  return best;
}

function zoneBlendWeight(zone, x, d) {
  if (!zone) return 0;
  if (x < zone.x1 || x > zone.x2 || d < zone.d1 || d > zone.d2) return 0;
  var blend = (zone.blend != null) ? zone.blend : VISUAL_ZONE_DEFAULT_BLEND;
  if (blend <= 0) return 1;
  var distEdge = Math.min(
    x - zone.x1,
    zone.x2 - x,
    d - zone.d1,
    zone.d2 - d
  );
  if (distEdge <= 0) return 0;
  if (distEdge >= blend) return 1;
  // smoothstep(0, blend, distEdge)
  var t = distEdge / blend;
  return t * t * (3 - 2 * t);
}

// ============================================================
//  ISSUE #54 — LOCAL ATMOSPHERE PROFILES + SAMPLER
//
//  Per-visualZone modulation of visibility (distance fog),
//  local color tint, particle density/brightness, ambient.
//  Purely visual; never touches physics, gameplay visibility
//  (silt), gas, deco, or wildlife spawn.
//
//  sampleLocalAtmosphere(site, x, d)
//    1. Resolve zone via visualZoneAt(x, d, site).
//    2. Look up site.atmosphereProfiles[zone.id]; missing profile
//       or missing site.atmosphereProfiles → all defaults (1.0).
//    3. Missing individual fields fall back to their default
//       independently (a profile can specify only visibility).
//    4. Blend profile values against defaults using
//       zoneBlendWeight(zone, x, d) so crossing a zone boundary
//       is smooth (weight 1 inside core → profile; weight 0 at
//       edge → defaults).
//    5. Clamp every returned scalar so bad data can't produce
//       black/blown-out frames.
// ============================================================
const LOCAL_ATMO_DEFAULT = Object.freeze({
  visibility: 1,
  tintR: 1, tintG: 1, tintB: 1,
  particleDensity: 1,
  particleBrightness: 1,
  ambient: 1
});
const LOCAL_ATMO_CLAMP = Object.freeze({
  visibility:        { min: 0.35, max: 1.25 },
  tint:              { min: 0.5,  max: 1.25 },
  particleDensity:   { min: 0,    max: 2.0  },
  particleBrightness:{ min: 0.25, max: 1.75 },
  ambient:           { min: 0.4,  max: 1.3  }
});

function _clampAtmo(v, range) {
  if (v < range.min) return range.min;
  if (v > range.max) return range.max;
  return v;
}

function sampleLocalAtmosphere(site, x, d) {
  var s = site || activeSite();
  var out = {
    visibility: LOCAL_ATMO_DEFAULT.visibility,
    tintR: LOCAL_ATMO_DEFAULT.tintR,
    tintG: LOCAL_ATMO_DEFAULT.tintG,
    tintB: LOCAL_ATMO_DEFAULT.tintB,
    particleDensity: LOCAL_ATMO_DEFAULT.particleDensity,
    particleBrightness: LOCAL_ATMO_DEFAULT.particleBrightness,
    ambient: LOCAL_ATMO_DEFAULT.ambient
  };
  if (!s || !s.atmosphereProfiles) return out;
  var zone = visualZoneAt(x, d, s);
  if (!zone) return out;
  var profile = s.atmosphereProfiles[zone.id];
  if (!profile) return out;
  var w = zoneBlendWeight(zone, x, d);
  // Field-by-field: profile value blended with default by w.
  function pick(defVal, profVal) {
    if (profVal == null) return defVal;
    return defVal + (profVal - defVal) * w;
  }
  var tint = profile.tint;
  var pR = (tint && tint[0] != null) ? tint[0] : null;
  var pG = (tint && tint[1] != null) ? tint[1] : null;
  var pB = (tint && tint[2] != null) ? tint[2] : null;
  out.visibility         = _clampAtmo(pick(1, profile.visibility),         LOCAL_ATMO_CLAMP.visibility);
  out.tintR              = _clampAtmo(pick(1, pR),                          LOCAL_ATMO_CLAMP.tint);
  out.tintG              = _clampAtmo(pick(1, pG),                          LOCAL_ATMO_CLAMP.tint);
  out.tintB              = _clampAtmo(pick(1, pB),                          LOCAL_ATMO_CLAMP.tint);
  out.particleDensity    = _clampAtmo(pick(1, profile.particleDensity),    LOCAL_ATMO_CLAMP.particleDensity);
  out.particleBrightness = _clampAtmo(pick(1, profile.particleBrightness), LOCAL_ATMO_CLAMP.particleBrightness);
  out.ambient            = _clampAtmo(pick(1, profile.ambient),            LOCAL_ATMO_CLAMP.ambient);
  return out;
}
