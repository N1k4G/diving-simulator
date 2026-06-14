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
      // D3: denser seagrass beds along the sandy descent
      {kind:'seagrass',x:18,d:5},{kind:'seagrass',x:25,d:6},
      {kind:'seagrass',x:32,d:6},{kind:'seagrass',x:45,d:8},
      {kind:'seagrass',x:52,d:8},{kind:'seagrass',x:60,d:9},
      {kind:'seagrass',x:68,d:10},{kind:'seagrass',x:78,d:11},
      {kind:'coral',x:85,d:13},{kind:'coral',x:90,d:13},
      // Landmarks right of the small wreck: an old admiralty anchor half-buried
      // in the sand, with a little life clustered around the outcrop.
      {kind:'anchor',  x:156},
      {kind:'seagrass',x:163,d:29},{kind:'seagrass',x:168,d:29},
      {kind:'coral',   x:180,d:30}
    ],
    surfaceMarker: 'buoy',
    noShark: true,
    currentBias: 0.0
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
      {kind:'gorgonian',   x:13,  d:37, side:'right', color:'#c83a5a'},
      {kind:'gorgonian',   x:-13, d:37, side:'left',  color:'#882a3a'},
      {kind:'softCoral',   x:15,  d:52, color:'#7a4a8a'},
      {kind:'anthiasCloud',x:-17, d:45, w:200, h:130, count:80, dir:1},
      // ---- DEEP SENTINELS (60+ m): sparse ----
      {kind:'gorgonian',   x:16,  d:60, side:'right', color:'#882a3a'},
      {kind:'softCoral',   x:-16, d:60, color:'#7a4a8a'}
    ],

    surfaceMarker: 'boat',
    noShark: false,
    currentBias: 0.4
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
    currentBias: 0.2
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
      {kind:'warningSign',x:17}
    ],
    surfaceMarker: 'pond',
    noShark: true,
    currentBias: 0.05
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
