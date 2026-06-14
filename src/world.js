// ============================================================
// FILE: world.js
// PURPOSE: Animated world entities — exhale bubbles, fish, wildlife,
//          and plankton particles. Handles spawn, movement, and draw.
//
// DEPENDS ON:
//   constants.js — timing constants, canvas dimensions
//   state.js     — depth, bubbles, fishes, wildlife, particles,
//                  breathPhase, breathTimer, exhaleEmitted,
//                  fishSpawnTimer, wildlifeSpawnTimer, diver
//
// USED BY:
//   game-loop.js — updateDiving() calls update functions each tick
//   renderer.js  — drawScene() calls draw functions each frame
//
// KEY FUNCTIONS (grep to find):
//   emitBubbles()            — emit exhale bubble cluster at diver position
//   updateBubbles(dt)        — move and expire active bubbles
//   spawnFish()              — create a new fish entity with random params
//   updateFish(dt)           — move fish, handle lifespan and school behaviour
//   spawnWildlife()          — create turtle/ray/whale wildlife entity
//   updateWildlife(dt)       — move wildlife entities
//   initParticles()          — seed plankton particle array
//   updateParticles(dt)      — move plankton particles (wrap at edges)
// SECTION: Bubble system
// SEARCH TERMS: emitBubbles, updateBubbles, bubbles, breathPhase, breathTimer, exhaleEmitted

// ============================================================
// ============================================================
//  BUBBLES
// ============================================================

function emitBubbles(count) {
    if (depth < 0.3) return;
    if (count === undefined) count = 2 + Math.floor(Math.random() * 2);
    for (var i = 0; i < count; i++) {
        var r = BUBBLE_RADIUS_MIN + Math.random() * (BUBBLE_RADIUS_MAX - BUBBLE_RADIUS_MIN);
        bubbles.push({
            x: 0,
            depth: depth,
            emissionPressure: ambientPressure(depth),
            emissionRadius: r,
            riseSpeed: BUBBLE_RISE_MIN + Math.random() * (BUBBLE_RISE_MAX - BUBBLE_RISE_MIN),
            wobblePhase: Math.random() * Math.PI * 2,
            wobbleFreq: 2 + Math.random() * 2,
            age: 0,
            baseX: -20 + Math.random() * 15
        });
    }
}

function updateBreathCycle(dt) {
    if (depth < 0.3) return;
    breathTimer -= dt;
    if (breathTimer <= 0) {
        if (breathPhase === 'inhale') {
            breathPhase = 'exhale';
            breathTimer = BREATH_CYCLE_EXHALE;
            exhaleEmitted = false;
        } else if (breathPhase === 'exhale') {
            breathPhase = 'pause';
            breathTimer = BREATH_CYCLE_PAUSE;
        } else {
            breathPhase = 'inhale';
            breathTimer = BREATH_CYCLE_INHALE;
        }
    }
    // Emit bubbles only during exhale phase
    if (breathPhase === 'exhale') {
        if (!exhaleEmitted) {
            // Initial burst at start of exhale: 2-3 bubbles
            emitBubbles(2 + Math.floor(Math.random() * 2));
            exhaleEmitted = true;
        } else if (Math.random() < 0.15) {
            // Trickle: ~15% chance per frame for 1 more bubble during exhale
            emitBubbles(1);
        }
    }
}

function emitBCDBubbles() {
    if (depth < 0.3) return;
    var count = 1 + Math.floor(Math.random() * 2); // 1-2 tiny bubbles
    for (var i = 0; i < count; i++) {
        var r = 1 + Math.random() * 2; // smaller radius: 1-3px vs 2-6px breathing
        bubbles.push({
            x: 0,
            depth: depth,
            emissionPressure: ambientPressure(depth),
            emissionRadius: r,
            riseSpeed: (BUBBLE_RISE_MIN + Math.random() * (BUBBLE_RISE_MAX - BUBBLE_RISE_MIN)) * 1.5,
            wobblePhase: Math.random() * Math.PI * 2,
            wobbleFreq: 3 + Math.random() * 3,
            age: 0,
            baseX: 10 + Math.random() * 20  // right of diver (BCD exhaust position)
        });
    }
}

function updateBubbles(dtDiveSeconds) {
    for (var i = bubbles.length - 1; i >= 0; i--) {
        var b = bubbles[i];
        b.age += dtDiveSeconds;
        b.depth -= b.riseSpeed * dtDiveSeconds;
        b.x = b.baseX + Math.sin(b.wobblePhase + b.age * b.wobbleFreq) * 8;
        if (b.depth <= 0 || b.age > BUBBLE_MAX_AGE) {
            bubbles.splice(i, 1);
        }
    }
}

function bubbleDisplayRadius(b) {
    var currentPressure = ambientPressure(b.depth);
    return b.emissionRadius * Math.pow(b.emissionPressure / currentPressure, 1 / 3);
}

// SECTION: Fish and wildlife system
// SEARCH TERMS: spawnFish, updateFish, fishes, fishSpawnTimer, spawnWildlife, updateWildlife, wildlife, shark

// ============================================================
//  FISH SYSTEM (TASK-022)
// ============================================================

var WORLD_MPS = 0.05 * 60; // metersPerPixel × 60fps — converts old speed unit to m/s

// D10: Build site-eligible candidate list — types with no sites[] pass anywhere;
//      types with sites[] only pass when diveSite matches. Falls back to all types.
function _eligibleTypes(typeArr) {
    var site = diveSite;
    var eligible = typeArr.filter(function(t) {
        return !t.sites || t.sites.indexOf(site) !== -1;
    });
    return eligible.length ? eligible : typeArr;
}

function spawnFish() {
    if (fishes.length >= MAX_FISH) return;
    var pool = _eligibleTypes(FISH_TYPES);
    var ft = pool[Math.floor(Math.random() * pool.length)];
    var fishDepth = ft.depthMin + Math.random() * (ft.depthMax - ft.depthMin);
    var direction = Math.random() < 0.5 ? 1 : -1;
    var speed = (ft.speedMin + Math.random() * (ft.speedMax - ft.speedMin)) * WORLD_MPS; // m/s
    // Spawn just off the visible screen edge in world metres
    var W = canvas.width;
    var startX = direction > 0
        ? diverX - (W * 0.25 + ft.size * 2) * 0.05
        : diverX + (W * 0.75 + ft.size * 2) * 0.05;
    fishes.push({
        type: ft,
        depth: fishDepth,
        x: startX,   // world metres
        direction: direction,
        speed: speed  // m/s
    });
}

function updateFish(dtReal) {
    fishSpawnTimer -= dtReal;
    if (fishSpawnTimer <= 0) {
        spawnFish();
        fishSpawnTimer = randomFishInterval();
    }
    var W = canvas.width;
    for (var i = fishes.length - 1; i >= 0; i--) {
        var f = fishes[i];
        f.x += f.direction * f.speed * dtReal; // world metres
        var rightEdge = diverX + (W * 0.75 + f.type.size * 2) * 0.05;
        var leftEdge  = diverX - (W * 0.25 + f.type.size * 2) * 0.05;
        if (f.direction > 0 && f.x > rightEdge) {
            fishes.splice(i, 1);
        } else if (f.direction < 0 && f.x < leftEdge) {
            fishes.splice(i, 1);
        }
    }
}

function drawFish(cx, x, y, fish) {
    cx.save();
    cx.translate(x, y);
    if (fish.direction < 0) cx.scale(-1, 1);
    var s = fish.type.size;
    // Reef redesign: dedicated drawers for anthias / bannerfish
    if (fish.type.name === 'anthias') {
        cx.fillStyle = '#ffe1bd';
        cx.beginPath(); cx.ellipse(0, 0, s*0.5, s*0.3, 0, 0, Math.PI*2); cx.fill();
        cx.fillStyle = '#ff7a3a';
        cx.beginPath(); cx.ellipse(s*0.15, 0, s*0.7, s*0.45, 0, 0, Math.PI*2); cx.fill();
        cx.fillStyle = '#c63a1a';
        cx.beginPath(); cx.ellipse(-s*0.2, 0, s*0.35, s*0.25, 0, 0, Math.PI*2); cx.fill();
        cx.fillStyle = '#ff7a3a';
        cx.beginPath(); cx.moveTo(-s, 0); cx.lineTo(-s*1.7, -s*0.5); cx.lineTo(-s*1.7, s*0.5); cx.closePath(); cx.fill();
        cx.fillStyle = '#0a0a0a';
        cx.beginPath(); cx.arc(s*0.55, -s*0.15, s*0.18, 0, Math.PI*2); cx.fill();
        cx.restore();
        return;
    }
    if (fish.type.name === 'bannerfish') {
        // cream body
        cx.fillStyle = '#f5f5e8';
        cx.beginPath(); cx.ellipse(0, 0, s*0.7, s*0.5, 0, 0, Math.PI*2); cx.fill();
        // two black bands
        cx.fillStyle = '#1a1a1a';
        cx.beginPath();
        cx.moveTo(-s*0.3, -s*0.45); cx.lineTo(-s*0.2, -s*0.45);
        cx.lineTo(-s*0.35, s*0.45); cx.lineTo(-s*0.45, s*0.45); cx.closePath(); cx.fill();
        cx.beginPath();
        cx.moveTo(s*0.15, -s*0.45); cx.lineTo(s*0.25, -s*0.45);
        cx.lineTo(s*0.2, s*0.45); cx.lineTo(s*0.1, s*0.45); cx.closePath(); cx.fill();
        // yellow tail and pelvic fin
        cx.fillStyle = '#e8c44b';
        cx.beginPath(); cx.moveTo(s*0.55, -s*0.1); cx.lineTo(s*0.8, -s*0.15); cx.lineTo(s*0.7, s*0.2); cx.closePath(); cx.fill();
        cx.beginPath(); cx.moveTo(-s*0.65, 0); cx.lineTo(-s, -s*0.25); cx.lineTo(-s, s*0.25); cx.closePath(); cx.fill();
        // trailing dorsal banner
        cx.strokeStyle = '#f5f5e8'; cx.lineWidth = 2; cx.lineCap = 'round';
        cx.beginPath(); cx.moveTo(-s*0.05, -s*0.48);
        cx.quadraticCurveTo(s*0.05, -s*1.28, s*0.3, -s*1.68); cx.stroke();
        // eye
        cx.fillStyle = '#0a0a0a';
        cx.beginPath(); cx.arc(s*0.4, -s*0.08, s*0.07, 0, Math.PI*2); cx.fill();
        cx.restore();
        return;
    }
    // Body gradient shading
    var bg = cx.createRadialGradient(s * 0.1, -s * 0.1, s * 0.1, 0, 0, s);
    bg.addColorStop(0, fish.type.color);
    bg.addColorStop(1, 'rgba(0,0,0,0.35)');
    cx.fillStyle = bg;
    cx.beginPath();
    cx.ellipse(0, 0, s, s * 0.5, 0, 0, Math.PI * 2);
    cx.fill();
    // Stripe
    cx.fillStyle = fish.type.stripe;
    cx.globalAlpha = 0.7;
    cx.fillRect(-s * 0.1, -s * 0.38, s * 0.15, s * 0.76);
    cx.globalAlpha = 1;
    // Dorsal fin
    cx.fillStyle = fish.type.color;
    cx.beginPath();
    cx.moveTo(-s * 0.1, -s * 0.5);
    cx.quadraticCurveTo(s * 0.15, -s * 0.95, s * 0.4, -s * 0.5);
    cx.closePath();
    cx.fill();
    // Forked tail
    cx.beginPath();
    cx.moveTo(-s * 0.9, 0);
    cx.lineTo(-s * 1.45, -s * 0.45);
    cx.lineTo(-s * 1.15, -s * 0.05);
    cx.lineTo(-s * 1.45, s * 0.45);
    cx.lineTo(-s * 0.9, 0);
    cx.closePath();
    cx.fill();
    // Eye
    cx.fillStyle = '#fff';
    cx.beginPath();
    cx.arc(s * 0.5, -s * 0.1, s * 0.15, 0, Math.PI * 2);
    cx.fill();
    cx.fillStyle = '#000';
    cx.beginPath();
    cx.arc(s * 0.55, -s * 0.1, s * 0.08, 0, Math.PI * 2);
    cx.fill();
    cx.restore();
}

function spawnWildlife() {
    if (wildlife.length >= MAX_WILDLIFE) return;
    var pool = _eligibleTypes(WILDLIFE_TYPES);
    var wt = pool[Math.floor(Math.random() * pool.length)];
    // Whale and ray are rare — 20% chance when selected
    if ((wt.name === 'whale' || wt.name === 'ray') && Math.random() > 0.2) {
        wt = pool[0];
    }
    var wDepth = wt.depthMin + Math.random() * (wt.depthMax - wt.depthMin);
    var direction = Math.random() < 0.5 ? 1 : -1;
    var speed = (wt.speedMin + Math.random() * (wt.speedMax - wt.speedMin)) * WORLD_MPS; // m/s
    var W = canvas.width;
    var startX = direction > 0
        ? diverX - (W * 0.25 + wt.size * 2) * 0.05
        : diverX + (W * 0.75 + wt.size * 2) * 0.05;
    wildlife.push({
        type: wt,
        depth: wDepth,
        x: startX,   // world metres
        direction: direction,
        speed: speed, // m/s
        phase: Math.random() * Math.PI * 2
    });
}

function updateWildlife(dtReal) {
    wildlifeSpawnTimer -= dtReal;
    if (wildlifeSpawnTimer <= 0) {
        spawnWildlife();
        wildlifeSpawnTimer = 8 + Math.random() * 15;
    }
    var W = canvas.width;
    for (var i = wildlife.length - 1; i >= 0; i--) {
        var w = wildlife[i];
        w.x += w.direction * w.speed * dtReal; // world metres
        w.phase += dtReal * 2;
        var rightEdge = diverX + (W * 0.75 + w.type.size * 3) * 0.05;
        var leftEdge  = diverX - (W * 0.25 + w.type.size * 3) * 0.05;
        if (w.direction > 0 && w.x > rightEdge) {
            wildlife.splice(i, 1);
        } else if (w.direction < 0 && w.x < leftEdge) {
            wildlife.splice(i, 1);
        }
    }
}

function drawWildlife(cx, x, y, w) {
    cx.save();
    cx.translate(x, y + Math.sin(w.phase) * 3);
    var sz = w.type.size;
    
    if (w.type.name === 'jellyfish') {
        // Bell
        cx.fillStyle = w.type.color;
        cx.beginPath();
        cx.arc(0, 0, sz * 0.5, Math.PI, 0);
        cx.fill();
        // Tentacles
        cx.strokeStyle = w.type.color;
        cx.lineWidth = 1.5;
        for (var t = -3; t <= 3; t++) {
            cx.beginPath();
            cx.moveTo(t * sz * 0.12, 0);
            var wiggle = Math.sin(w.phase + t) * sz * 0.15;
            cx.quadraticCurveTo(t * sz * 0.12 + wiggle, sz * 0.4, t * sz * 0.1, sz * 0.8);
            cx.stroke();
        }
    } else if (w.type.name === 'octopus') {
        if (w.direction < 0) cx.scale(-1, 1);
        // Head
        cx.fillStyle = w.type.color;
        cx.beginPath();
        cx.ellipse(0, -sz * 0.2, sz * 0.4, sz * 0.35, 0, 0, Math.PI * 2);
        cx.fill();
        // Tentacles
        cx.strokeStyle = w.type.color;
        cx.lineWidth = 2.5;
        for (var t = 0; t < 8; t++) {
            var angle = (t / 8) * Math.PI - Math.PI * 0.5;
            var tx = Math.cos(angle) * sz * 0.3;
            var ty = sz * 0.1;
            cx.beginPath();
            cx.moveTo(tx, ty);
            var wiggle2 = Math.sin(w.phase + t * 0.8) * sz * 0.2;
            cx.quadraticCurveTo(tx + wiggle2, ty + sz * 0.4, tx + wiggle2 * 0.5, ty + sz * 0.7);
            cx.stroke();
        }
        // Eye
        cx.fillStyle = '#fff';
        cx.beginPath();
        cx.arc(sz * 0.12, -sz * 0.25, sz * 0.08, 0, Math.PI * 2);
        cx.fill();
        cx.fillStyle = '#000';
        cx.beginPath();
        cx.arc(sz * 0.14, -sz * 0.25, sz * 0.04, 0, Math.PI * 2);
        cx.fill();
    } else if (w.type.name === 'whale') {
        if (w.direction < 0) cx.scale(-1, 1);
        // Body
        cx.fillStyle = w.type.color;
        cx.beginPath();
        cx.ellipse(0, 0, sz, sz * 0.35, 0, 0, Math.PI * 2);
        cx.fill();
        // Belly (lighter)
        cx.fillStyle = '#556677';
        cx.beginPath();
        cx.ellipse(0, sz * 0.12, sz * 0.8, sz * 0.18, 0, 0, Math.PI);
        cx.fill();
        // Tail
        cx.fillStyle = w.type.color;
        cx.beginPath();
        cx.moveTo(-sz, 0);
        cx.lineTo(-sz * 1.4, -sz * 0.3);
        cx.lineTo(-sz * 1.3, 0);
        cx.lineTo(-sz * 1.4, sz * 0.3);
        cx.closePath();
        cx.fill();
        // Eye
        cx.fillStyle = '#fff';
        cx.beginPath();
        cx.arc(sz * 0.6, -sz * 0.08, sz * 0.05, 0, Math.PI * 2);
        cx.fill();
    } else if (w.type.name === 'turtle') {
        if (w.direction < 0) cx.scale(-1, 1);
        // Shell
        cx.fillStyle = '#3a6030';
        cx.beginPath(); cx.ellipse(0, 0, sz * 0.7, sz * 0.5, 0, 0, Math.PI * 2); cx.fill();
        // Shell pattern
        cx.strokeStyle = '#2a4820'; cx.lineWidth = 1.2;
        cx.beginPath(); cx.ellipse(0, 0, sz * 0.4, sz * 0.28, 0, 0, Math.PI * 2); cx.stroke();
        cx.beginPath(); cx.moveTo(0, -sz * 0.5); cx.lineTo(0, sz * 0.5); cx.stroke();
        cx.beginPath(); cx.moveTo(-sz * 0.5, 0); cx.lineTo(sz * 0.5, 0); cx.stroke();
        // Head
        cx.fillStyle = '#5a8040';
        cx.beginPath(); cx.ellipse(sz * 0.75, 0, sz * 0.22, sz * 0.18, 0, 0, Math.PI * 2); cx.fill();
        // Flippers — bob with phase
        cx.fillStyle = '#4a7030';
        var fp = Math.sin(w.phase) * sz * 0.15;
        cx.beginPath(); cx.ellipse(-sz * 0.2, -sz * 0.55 + fp, sz * 0.35, sz * 0.12, 0.4, 0, Math.PI * 2); cx.fill();
        cx.beginPath(); cx.ellipse(-sz * 0.2,  sz * 0.55 - fp, sz * 0.35, sz * 0.12, -0.4, 0, Math.PI * 2); cx.fill();
        // Eye
        cx.fillStyle = '#000'; cx.beginPath(); cx.arc(sz * 0.88, -sz * 0.06, sz * 0.05, 0, Math.PI * 2); cx.fill();
    } else if (w.type.name === 'ray') {
        if (w.direction < 0) cx.scale(-1, 1);
        // Body — flat diamond shape
        cx.fillStyle = w.type.color;
        cx.beginPath();
        var rp = Math.sin(w.phase * 0.7) * sz * 0.08;  // gentle wing flap
        cx.moveTo(sz, 0);
        cx.quadraticCurveTo(sz * 0.3, -sz * 0.65 - rp, -sz * 0.8, 0);
        cx.quadraticCurveTo(sz * 0.3,  sz * 0.65 + rp, sz, 0);
        cx.fill();
        // Spots
        cx.fillStyle = 'rgba(255,255,255,0.18)';
        for (var ri = 0; ri < 5; ri++) {
            cx.beginPath(); cx.arc((ri - 2) * sz * 0.25, 0, sz * 0.07, 0, Math.PI * 2); cx.fill();
        }
        // Long tail
        cx.strokeStyle = w.type.color; cx.lineWidth = sz * 0.08; cx.lineCap = 'round';
        cx.beginPath(); cx.moveTo(-sz * 0.8, 0); cx.lineTo(-sz * 2.2, sz * 0.25); cx.stroke();
        // Eye
        cx.fillStyle = '#fff'; cx.beginPath(); cx.arc(sz * 0.5, -sz * 0.05, sz * 0.07, 0, Math.PI * 2); cx.fill();
        cx.fillStyle = '#000'; cx.beginPath(); cx.arc(sz * 0.52, -sz * 0.05, sz * 0.04, 0, Math.PI * 2); cx.fill();
    } else if (w.type.name === 'greyReefShark') {
        if (w.direction < 0) cx.scale(-1, 1);
        var L = sz * 2; // total length ~ 2*sz
        // body gradient
        var sharkG = cx.createLinearGradient(0, -L*0.18, 0, L*0.18);
        sharkG.addColorStop(0, '#2a3543');
        sharkG.addColorStop(0.55, '#4a5664');
        sharkG.addColorStop(0.7, '#7d8c9b');
        sharkG.addColorStop(1, '#bcc7d0');
        cx.fillStyle = sharkG;
        cx.beginPath();
        cx.moveTo(-L*0.5, 0);
        cx.bezierCurveTo(-L*0.3, -L*0.13, L*0.1, -L*0.18, L*0.42, -L*0.05);
        cx.lineTo(L*0.5, -L*0.03);
        cx.lineTo(L*0.42, L*0.06);
        cx.bezierCurveTo(L*0.1, L*0.18, -L*0.3, L*0.14, -L*0.5, 0);
        cx.closePath(); cx.fill();
        // dorsal fin
        cx.fillStyle = '#2a3543';
        cx.beginPath(); cx.moveTo(-L*0.05, -L*0.14); cx.quadraticCurveTo(L*0.02, -L*0.35, L*0.12, -L*0.16); cx.closePath(); cx.fill();
        // tail
        cx.beginPath(); cx.moveTo(-L*0.45, 0); cx.lineTo(-L*0.62, -L*0.22); cx.lineTo(-L*0.55, 0); cx.lineTo(-L*0.62, L*0.22); cx.closePath(); cx.fill();
        // pectoral fin
        cx.beginPath(); cx.moveTo(L*0.05, L*0.08); cx.quadraticCurveTo(-L*0.05, L*0.28, -L*0.18, L*0.16); cx.closePath(); cx.fill();
        // dark tip
        cx.fillStyle = '#0e1620';
        cx.beginPath(); cx.ellipse(-L*0.13, L*0.2, L*0.05, L*0.025, 0, 0, Math.PI*2); cx.fill();
        // eye
        cx.fillStyle = '#0e1620';
        cx.beginPath(); cx.arc(L*0.36, -L*0.04, L*0.012, 0, Math.PI*2); cx.fill();
        // gills
        cx.strokeStyle = '#1a232e'; cx.lineWidth = 1;
        var gillTs = [0.18, 0.22, 0.26];
        for (var gi = 0; gi < gillTs.length; gi++) {
            cx.globalAlpha = 0.65;
            cx.beginPath(); cx.moveTo(L*gillTs[gi], -L*0.08); cx.quadraticCurveTo(L*gillTs[gi]-2, 0, L*gillTs[gi], L*0.14); cx.stroke();
        }
        cx.globalAlpha = 1;
    } else if (w.type.name === 'hammerhead') {
        if (w.direction < 0) cx.scale(-1, 1);
        var Lh = sz * 2;
        var hG = cx.createLinearGradient(0, -Lh*0.12, 0, Lh*0.12);
        hG.addColorStop(0, '#2a3543'); hG.addColorStop(0.55, '#4a5664');
        hG.addColorStop(0.7, '#7d8c9b'); hG.addColorStop(1, '#bcc7d0');
        cx.fillStyle = hG;
        cx.beginPath();
        cx.moveTo(-Lh*0.5, 0);
        cx.bezierCurveTo(-Lh*0.3, -Lh*0.1, Lh*0.18, -Lh*0.12, Lh*0.38, -Lh*0.04);
        cx.lineTo(Lh*0.42, 0); cx.lineTo(Lh*0.38, Lh*0.04);
        cx.bezierCurveTo(Lh*0.18, Lh*0.12, -Lh*0.3, Lh*0.1, -Lh*0.5, 0);
        cx.closePath(); cx.fill();
        // cephalofoil
        cx.fillStyle = '#2a3543';
        cx.beginPath(); cx.ellipse(Lh*0.4, 0, Lh*0.05, Lh*0.13, 0, 0, Math.PI*2); cx.fill();
        cx.fillStyle = '#e8e0c8';
        cx.beginPath(); cx.arc(Lh*0.4, -Lh*0.1, Lh*0.015, 0, Math.PI*2); cx.fill();
        cx.beginPath(); cx.arc(Lh*0.4, Lh*0.1, Lh*0.015, 0, Math.PI*2); cx.fill();
        // dorsal
        cx.fillStyle = '#2a3543';
        cx.beginPath(); cx.moveTo(-Lh*0.02, -Lh*0.1); cx.quadraticCurveTo(Lh*0.04, -Lh*0.38, Lh*0.16, -Lh*0.12); cx.closePath(); cx.fill();
        // tail
        cx.beginPath(); cx.moveTo(-Lh*0.45, 0); cx.lineTo(-Lh*0.62, -Lh*0.26); cx.lineTo(-Lh*0.5, 0); cx.lineTo(-Lh*0.62, Lh*0.18); cx.closePath(); cx.fill();
        // pectoral
        cx.beginPath(); cx.moveTo(Lh*0.06, Lh*0.06); cx.quadraticCurveTo(-Lh*0.05, Lh*0.24, -Lh*0.16, Lh*0.12); cx.closePath(); cx.fill();
    } else if (w.type.name === 'dolphin') {
        if (w.direction < 0) cx.scale(-1, 1);
        var Ld = sz * 2;
        var bob = Math.sin(w.phase) * sz * 0.1;
        // body
        cx.fillStyle = '#465260';
        cx.beginPath();
        cx.moveTo(-Ld*0.5, 0);
        cx.quadraticCurveTo(-Ld*0.4, -Ld*0.18+bob, -Ld*0.1, -Ld*0.18+bob);
        cx.quadraticCurveTo(Ld*0.25, -Ld*0.15, Ld*0.42, -Ld*0.04);
        cx.quadraticCurveTo(Ld*0.5, -Ld*0.01, Ld*0.45, Ld*0.05);
        cx.quadraticCurveTo(Ld*0.18, Ld*0.14, -Ld*0.1, Ld*0.14-bob);
        cx.quadraticCurveTo(-Ld*0.4, Ld*0.12, -Ld*0.5, 0);
        cx.closePath(); cx.fill();
        // belly
        cx.fillStyle = '#9aa7b3'; cx.globalAlpha = 0.7;
        cx.beginPath();
        cx.moveTo(-Ld*0.5, 0);
        cx.quadraticCurveTo(-Ld*0.4, Ld*0.08, -Ld*0.1, Ld*0.12);
        cx.quadraticCurveTo(Ld*0.18, Ld*0.14, Ld*0.42, Ld*0.04);
        cx.lineTo(Ld*0.45, Ld*0.05);
        cx.quadraticCurveTo(Ld*0.18, Ld*0.14, -Ld*0.1, Ld*0.14);
        cx.quadraticCurveTo(-Ld*0.4, Ld*0.12, -Ld*0.5, 0);
        cx.closePath(); cx.fill();
        cx.globalAlpha = 1;
        // dorsal
        cx.fillStyle = '#2c3744';
        cx.beginPath(); cx.moveTo(-Ld*0.05, -Ld*0.16+bob); cx.quadraticCurveTo(Ld*0.02, -Ld*0.32+bob, Ld*0.1, -Ld*0.14+bob); cx.closePath(); cx.fill();
        // tail flukes
        cx.beginPath(); cx.moveTo(-Ld*0.45, 0); cx.lineTo(-Ld*0.6, -Ld*0.16); cx.quadraticCurveTo(-Ld*0.52, 0, -Ld*0.6, Ld*0.16); cx.closePath(); cx.fill();
        // beak
        cx.beginPath(); cx.moveTo(Ld*0.42, -Ld*0.02); cx.lineTo(Ld*0.52, -Ld*0.01); cx.lineTo(Ld*0.48, Ld*0.02); cx.closePath(); cx.fill();
        // eye
        cx.fillStyle = '#0a0e14';
        cx.beginPath(); cx.arc(Ld*0.3, -Ld*0.05, Ld*0.015, 0, Math.PI*2); cx.fill();
    }

    cx.restore();
}

// SECTION: Plankton particles
// SEARCH TERMS: initParticles, updateParticles, particles

// ============================================================
//  PARTICLES (PLANKTON)
// ============================================================

function updateParticles(dtDiveSeconds) {
    for (var j = 0; j < particles.length; j++) {
        var p = particles[j];
        p.phase += p.speed * dtDiveSeconds * 60;
        p.x += Math.sin(p.phase) * 0.3;
        // Phase A: Parallax — particles drift opposite to diver movement (sells motion)
        p.x -= horizontalVelocity * dtDiveSeconds / 0.05;
        // Phase B: Drift plankton with current inside the depth band
        var cv = currentVelAt(p.depth != null ? p.depth : depth);
        if (cv !== 0) {
            p.x += cv * dtDiveSeconds / 0.05;
        }
    }
}