// ============================================================
// FILE: renderer.js
// PURPOSE: All canvas drawing — underwater scene, diver sprite,
//          dive computer HUD, gas-setup screen, dive profile chart,
//          post-dive summary, game-over screen, and surface screen.
//
// DEPENDS ON:
//   constants.js — colours, layout constants, S()
//   state.js     — every game-state variable (depth, tissues, tanks, diver, …)
//   physics.js   — calculateNDL(), calculateCeiling(), calculateDecoSchedule()
//   world.js     — bubble/fish/particle arrays rendered here
//
// USED BY:
//   game-loop.js — gameLoop() calls the appropriate draw* fn each frame
//
// KEY FUNCTIONS (grep to find):
//   drawScene()              — underwater background, diver, particles, fish
//   drawDiveComputer()       — HUD overlay: depth, NDL, tissue bars, PO2, deco
//   drawGasSetup()           — canvas gas-setup screen (keyboard/desktop mode)
//   drawDiveProfileChart()   — post-dive depth/time profile chart
//   drawPostDive()           — post-dive summary screen
//   drawGameOver()           — game-over screen with cause of death
//   drawSurface()            — surface / pre-dive screen
//   showHtmlHelp()           — build and show the HTML help overlay
// SECTION: Rendering helper utilities
// SEARCH TERMS: formatDepth, formatTime, lerpColor, roundRect, wrapText

// ============================================================
// ============================================================
//  RENDERING HELPERS
// ============================================================

function waterColor(d) {
    // Atmospheric deep-ocean palette — eased multi-stop (depth metres -> RGB)
    var stops = [
        [0,   [96, 171, 196]],
        [12,  [58, 140, 173]],
        [30,  [32, 102, 139]],
        [60,  [17, 66, 99]],
        [110, [8, 37, 61]],
        [180, [3, 14, 27]]
    ];
    if (d <= stops[0][0]) return 'rgb(' + stops[0][1].join(',') + ')';
    for (var i = 1; i < stops.length; i++) {
        if (d <= stops[i][0]) {
            var a = stops[i - 1], b = stops[i];
            var t = (d - a[0]) / (b[0] - a[0]);
            t = t * t * (3 - 2 * t); // smoothstep
            var r = Math.round(a[1][0] + (b[1][0] - a[1][0]) * t);
            var g = Math.round(a[1][1] + (b[1][1] - a[1][1]) * t);
            var bl = Math.round(a[1][2] + (b[1][2] - a[1][2]) * t);
            return 'rgb(' + r + ',' + g + ',' + bl + ')';
        }
    }
    var last = stops[stops.length - 1][1];
    return 'rgb(' + last.join(',') + ')';
}

// ── Cenote / cave palette (matches the Cueva del Silencio mockup) ──
// Warm Yucatán limestone above, tannic→turquoise→ink-black water below.
// Used by drawScene/drawTerrain when activeSite().id === 'cave'.
var CAVE_PAL = {
    sky:        '#9ec8b9',
    skyWarm:    '#f3e2c4',
    jungle:     '#3c5a3a',
    jungleDark: '#1f3324',
    earth:      '#2a1c10',
    earthLite:  '#4a3220',
    rockLite:   '#a89072',
    rockMid:    '#6b5a40',
    rockWarm:   '#4e3f2a',
    rockShade:  '#2c2114',
    rockDark:   '#150d06',
    // Cool grey limestone — the deep cave turns to bare grey rock the further
    // (and deeper) you go from the warm, organic, tannin-stained entrance.
    greyBrown:  '#534a3c',   // transition (brown → grey)
    greyLite:   '#74736c',
    greyMid:    '#4a4944',
    greyShade:  '#33322d',
    greyDark:   '#1d1c19',
    halocline:  '#a8d8d0',
    calciteLite:'#e8dcc0',
    calciteMid: '#b89a72',
    calciteDark:'#3a2818',
    sunbeam:    '#fff5d8',
    signYellow: '#f0c038',
    signRed:    '#c8281a',
    signBlack:  '#0a0a0a',
    signWhite:  '#f5efe2',
};

// Cenote water colour ramp. Mimics a Yucatán sinkhole: greenish tannic
// surface, turquoise mid water past the halocline, fading to black in the
// deep tunnels.
function caveWaterColor(d) {
    var stops = [
        [0,   [108, 130, 88]],   // tannic surface
        [4,   [76, 122, 110]],   // greenish
        [8,   [50, 132, 138]],   // turquoise (just below halocline)
        [16,  [28, 88, 116]],    // deeper blue
        [24,  [12, 48, 78]],     // dark blue
        [32,  [4, 18, 32]]       // black
    ];
    if (d <= stops[0][0]) return 'rgb(' + stops[0][1].join(',') + ')';
    for (var i = 1; i < stops.length; i++) {
        if (d <= stops[i][0]) {
            var a = stops[i - 1], b = stops[i];
            var t = (d - a[0]) / (b[0] - a[0]);
            t = t * t * (3 - 2 * t);
            var r = Math.round(a[1][0] + (b[1][0] - a[1][0]) * t);
            var g = Math.round(a[1][1] + (b[1][1] - a[1][1]) * t);
            var bl = Math.round(a[1][2] + (b[1][2] - a[1][2]) * t);
            return 'rgb(' + r + ',' + g + ',' + bl + ')';
        }
    }
    var last = stops[stops.length - 1][1];
    return 'rgb(' + last.join(',') + ')';
}

function formatTime(diveMinutes) {
    var totalSeconds = Math.floor(diveMinutes * 60);
    var mm = Math.floor(totalSeconds / 60);
    var ss = totalSeconds % 60;
    return String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
}

// D1: persistent facing direction — updates when diver fins, holds last value when still
var _diverFacing = 1;
// Torch/overhead darkness ramp — eases in/out so entering a wreck/cave dims gradually
var _torchDark = 0;
// Wreck metal-interior backdrop ramp — fades in only while inside the hull
var _wreckMetal = 0;

// SECTION: Underwater scene
// SEARCH TERMS: drawScene, drawDiver, narcosis, waveTime, background gradient

// ============================================================
//  SCENE RENDERING
// ============================================================

function drawScene() {
    var W = canvas.width;
    var H = canvas.height;
    var cx = ctx;

    // WP-020: Narcosis visual effects — filters
    var narcFilter = '';
    if (narcosisIndex > 0.40) {
        var grayAmt = Math.min(80, (narcosisIndex - 0.40) * 133);
        narcFilter += 'grayscale(' + grayAmt.toFixed(0) + '%) ';
    }
    if (narcosisIndex > 0.50) {
        var blurAmt = Math.min(3, (narcosisIndex - 0.50) * 6);
        narcFilter += 'blur(' + blurAmt.toFixed(1) + 'px) ';
    }
    if (narcFilter) cx.filter = narcFilter.trim();

    // WP-020: Narcosis wobble
    var narcWobble = narcosisIndex > 0.25;
    if (narcWobble) {
        var wobStr = (narcosisIndex - 0.25) * 8;
        cx.save();
        cx.translate(
            Math.sin(Date.now() * 0.002) * wobStr,
            Math.cos(Date.now() * 0.0015) * wobStr * 0.5
        );
    }

    var diverScreenY = H * 0.45;
    var metersPerPixel = 0.05;

    var depthAtTop = depth - (diverScreenY * metersPerPixel);
    var depthAtBottom = depth + ((H - diverScreenY) * metersPerPixel);

    // Background gradient
    var grad = cx.createLinearGradient(0, 0, 0, H);
    var topD = Math.max(0, depthAtTop);
    var botD = Math.min(MAX_DEPTH + 10, depthAtBottom);
    var _site = activeSite();
    var _isCave = _site && _site.id === 'cave';
    var _wc = _isCave ? caveWaterColor : waterColor;
    grad.addColorStop(0, _wc(topD));
    grad.addColorStop(0.5, _wc((topD + botD) / 2));
    grad.addColorStop(1, _wc(botD));
    cx.fillStyle = grad;
    cx.fillRect(0, 0, W, H);

    // Wreck visibility: ease an "inside-ness" factor (0 outside → 1 inside the
    // hull). Drives the hull-skin visibility bubble + the hatch light beam. The
    // steel hull itself is painted later (drawWreckSteelBack / drawWreckHullSkin)
    // so the ocean background stays everywhere that is NOT the wreck.
    var _metalTarget = (_site && _site.id === 'wreck' && inOverhead) ? 1 : 0;
    _wreckMetal += (_metalTarget - _wreckMetal) * 0.08;

    var surfaceScreenY = diverScreenY - (depth / metersPerPixel);
    var _activeSiteD5 = _site;

    // Sky if surface visible. In caves the textured rock ceiling (drawn later in
    // drawTerrain) covers the overhead area, so sky only shows through the open
    // pond shafts — no special-case fill needed here.
    if (surfaceScreenY > 0) {
        var skyGrad = cx.createLinearGradient(0, 0, 0, Math.max(1, surfaceScreenY));
        if (_isCave) {
            // Warm Yucatán cenote sky — jungle haze above the karst.
            skyGrad.addColorStop(0,   CAVE_PAL.skyWarm);
            skyGrad.addColorStop(0.55, CAVE_PAL.sky);
            skyGrad.addColorStop(1,    '#7a9d8d');
        } else {
            skyGrad.addColorStop(0, '#c4e6f0');
            skyGrad.addColorStop(1, '#83bcd2');
        }
        cx.fillStyle = skyGrad;
        cx.fillRect(0, 0, W, surfaceScreenY);

        // Cenote: paint a sun disk and jungle silhouette across the top.
        // Both are drawn BEFORE drawTerrain, so the rock ceiling will mask
        // them out everywhere except through the open pond shafts.
        if (_isCave && surfaceScreenY > 24) {
            // sun disk near the right side, soft halo
            var sunPx = W * 0.22, sunPy = Math.min(surfaceScreenY - 38, 56);
            if (sunPy > 8) {
                cx.save();
                var sg = cx.createRadialGradient(sunPx, sunPy, 0, sunPx, sunPy, 70);
                sg.addColorStop(0, 'rgba(255,233,184,0.85)');
                sg.addColorStop(0.4, 'rgba(255,233,184,0.35)');
                sg.addColorStop(1, 'rgba(255,233,184,0)');
                cx.fillStyle = sg;
                cx.fillRect(sunPx - 80, sunPy - 80, 160, 160);
                cx.fillStyle = '#ffe9b8';
                cx.beginPath(); cx.arc(sunPx, sunPy, 18, 0, Math.PI * 2); cx.fill();
                cx.restore();
            }
            // jungle silhouette band along the karst rim (just above water)
            cx.save();
            cx.fillStyle = CAVE_PAL.jungleDark;
            cx.globalAlpha = 0.5;
            cx.fillRect(0, Math.max(0, surfaceScreenY - 24), W, 24);
            cx.globalAlpha = 1;
            cx.fillStyle = CAVE_PAL.jungle;
            for (var jx = 0; jx < W; jx += 12) {
                var jh = 8 + Math.sin(jx * 0.13) * 5 + Math.sin(jx * 0.31) * 3;
                cx.fillRect(jx, surfaceScreenY - jh, 13, jh);
            }
            // a few palm-frond suggestions
            cx.strokeStyle = CAVE_PAL.jungle;
            cx.lineWidth = 2;
            cx.lineCap = 'round';
            for (var ji = 0; ji < 6; ji++) {
                var jpx = (ji * 173.1 + 47) % W;
                var jpy = surfaceScreenY - 18;
                if (jpy < 10) continue;
                cx.beginPath();
                cx.moveTo(jpx, surfaceScreenY);
                cx.lineTo(jpx, jpy);
                cx.stroke();
                for (var ang = -45; ang <= 45; ang += 30) {
                    var rad = ang * Math.PI / 180;
                    cx.beginPath();
                    cx.moveTo(jpx, jpy);
                    cx.quadraticCurveTo(
                        jpx + Math.sin(rad) * 10, jpy - Math.cos(rad) * 8,
                        jpx + Math.sin(rad) * 16, jpy - Math.cos(rad) * 14);
                    cx.stroke();
                }
            }
            cx.restore();
        }
    }

    // Wave animation at surface line
    if (surfaceScreenY > -50 && surfaceScreenY < H + 50) {
        cx.save();
        cx.beginPath();
        for (var x = 0; x <= W; x += 4) {
            var waveY = surfaceScreenY + Math.sin(x * 0.02 + waveTime * 2) * 4 +
                          Math.sin(x * 0.035 + waveTime * 1.5) * 2;
            if (x === 0) cx.moveTo(x, waveY);
            else cx.lineTo(x, waveY);
        }
        cx.lineTo(W, surfaceScreenY + 20);
        cx.lineTo(0, surfaceScreenY + 20);
        cx.closePath();
        cx.fillStyle = 'rgba(135,206,235,0.3)';
        cx.fill();
        cx.restore();
    }

    // Ship on surface — D4/D9: Boat with Alpha flag; site-aware world anchor
    if (surfaceScreenY > -80 && surfaceScreenY < H) {
        cx.save();
        var _boatWorldX = (_activeSiteD5 && _activeSiteD5.boatX != null) ? _activeSiteD5.boatX : 0;
        var shipX = W * 0.25 + (_boatWorldX - diverX) / metersPerPixel;
        var bob = Math.sin(waveTime * 0.9) * 2.2;
        var rock = Math.sin(waveTime * 0.75) * 0.022;
        cx.translate(shipX, surfaceScreenY + bob);
        cx.rotate(rock);
        // reflection
        cx.save(); cx.globalAlpha = 0.16; cx.scale(1, -1); cx.translate(0, 6);
        paintShip(cx, true); cx.restore();
        // wake ripples
        cx.strokeStyle = 'rgba(225,248,255,0.22)'; cx.lineWidth = 1.4;
        for (var wri = 0; wri < 3; wri++) {
            cx.globalAlpha = 0.5 - wri * 0.14;
            cx.beginPath(); cx.ellipse(0, 2, 70 + wri * 26, 5 + wri * 2, 0, 0, Math.PI * 2); cx.stroke();
        }
        cx.globalAlpha = 1;
        paintShip(cx, false);
        cx.restore();
    }

    // Site-specific atmosphere is cheap gradient/line work behind terrain.
    drawSiteAtmosphere();

    // Phase C: Site terrain (floor + ceiling) drawn before entities
    drawTerrain();
    drawSiteDetailPass();
    // Cenote-only: refractive halocline band at ~7 m
    if (_isCave) drawHalocline(cx, W, H, diverScreenY, metersPerPixel);
    // Wreck: steel hull skin BEHIND the interior objects (so behind cars/decks
    // you see metal, not ocean). Clipped to the ship silhouette only.
    drawWreckSteelBack();
    // Phase C: Solid AABB structures
    drawStructures();
    // Phase C: Cosmetic features (seagrass, signs, thermocline, coral)
    drawFeatures();
    // Wreck: opaque exterior hull skin over the silhouette (can't see inside
    // from outside) with a line-of-sight bubble punched around the diver while
    // inside the hull (makes interior navigation harder).
    drawWreckHullSkin();
    // Decorative-only ship cues sit on top of the exterior skin.
    drawWreckExteriorDetails();
    // Wreck: highlight the three penetration points so they're findable from
    // outside (drawn over the hull skin; fades as the diver enters).
    drawWreckEntryMarkers();

    // ── Depth scale (DiveSim Redesign spec) ─────────────────────
    cx.save();
    cx.textBaseline = 'middle';
    for (var dm = 0; dm <= MAX_DEPTH; dm += 10) {
        var gy = diverScreenY + (dm - depth) / metersPerPixel;
        if (gy < -4 || gy > H + 4) continue;
        // hairline from right edge of tick zone to screen edge
        cx.strokeStyle = 'rgba(225,245,255,0.048)';
        cx.lineWidth = 1; cx.setLineDash([]);
        cx.beginPath(); cx.moveTo(36, gy); cx.lineTo(W, gy); cx.stroke();
        // tick mark (26 px from left edge)
        cx.strokeStyle = 'rgba(225,245,255,0.28)';
        cx.lineWidth = 1;
        cx.beginPath(); cx.moveTo(0, gy); cx.lineTo(22, gy); cx.stroke();
        // depth number
        cx.font = '500 13px "Barlow Semi Condensed", monospace';
        cx.fillStyle = 'rgba(225,245,255,0.52)';
        cx.textAlign = 'left';
        cx.fillText(String(dm), 28, gy);
        // 'm' suffix — smaller, dimmer
        var nmW = cx.measureText(String(dm)).width;
        cx.font = '10px "Barlow Semi Condensed", monospace';
        cx.fillStyle = 'rgba(225,245,255,0.32)';
        cx.fillText('m', 28 + nmW + 2, gy);
    }
    cx.textBaseline = 'alphabetic';
    cx.restore();

    // Particles (plankton)
    for (var j = 0; j < particles.length; j++) {
        var p = particles[j];
        var py = diverScreenY + (p.depth - depth) / metersPerPixel;
        if (py < -10 || py > H + 10) continue;
        var px = ((p.x % W) + W) % W;
        var densityAlpha = Math.min(1, p.depth / 50) * p.alpha;
        cx.fillStyle = 'rgba(200,220,180,' + densityAlpha + ')';
        cx.beginPath();
        cx.arc(px, py, p.size, 0, Math.PI * 2);
        cx.fill();
        // Reef particulate: brighter white dots
        if (_site && _site.id === 'reef') {
            cx.fillStyle = 'rgba(255,255,255,0.3)';
            cx.beginPath();
            cx.arc(px, py + 3, p.size * 0.6, 0, Math.PI * 2);
            cx.fill();
        }
    }

    // TASK-022: Fish — world-space x rendered via camera transform
    for (var fi = 0; fi < fishes.length; fi++) {
        var f = fishes[fi];
        var fy = diverScreenY + (f.depth - depth) / metersPerPixel;
        if (fy < -40 || fy > H + 40) continue;
        var fsx = W * 0.25 + (f.x - diverX) / metersPerPixel;
        if (fsx < -f.type.size * 3 || fsx > W + f.type.size * 3) continue;
        drawFish(cx, fsx, fy, f);
    }

    // Wildlife rendering — world-space x
    for (var wi = 0; wi < wildlife.length; wi++) {
        var w = wildlife[wi];
        var wScreenY = diverScreenY + (w.depth - depth) / metersPerPixel;
        var wsx = W * 0.25 + (w.x - diverX) / metersPerPixel;
        if (wScreenY > -100 && wScreenY < H + 100 && wsx > -w.type.size * 3 && wsx < W + w.type.size * 3) {
            drawWildlife(cx, wsx, wScreenY, w);
        }
    }

    // TASK-044: Shark rendering — world-space x
    if (shark) {
        var sharkScreenY = diverScreenY + (shark.depth - depth) / metersPerPixel;
        var sharkScreenX = W * 0.25 + (shark.x - diverX) / metersPerPixel;
        if (sharkScreenY > -100 && sharkScreenY < H + 100) {
            cx.save();
            cx.translate(sharkScreenX, sharkScreenY + Math.sin(shark.phase) * 4);
            if (shark.direction < 0) cx.scale(-1, 1);
            var ss = shark.size;
            // Body
            cx.fillStyle = 'rgba(40,50,60,0.85)';
            cx.beginPath();
            cx.ellipse(0, 0, ss, ss * 0.35, 0, 0, Math.PI * 2);
            cx.fill();
            // Dorsal fin
            cx.beginPath();
            cx.moveTo(-ss * 0.1, -ss * 0.35);
            cx.lineTo(ss * 0.05, -ss * 0.85);
            cx.lineTo(ss * 0.3, -ss * 0.3);
            cx.closePath();
            cx.fill();
            // Tail fin
            cx.beginPath();
            cx.moveTo(-ss, 0);
            cx.lineTo(-ss * 1.5, -ss * 0.5);
            cx.lineTo(-ss * 1.2, 0);
            cx.lineTo(-ss * 1.5, ss * 0.4);
            cx.closePath();
            cx.fill();
            // Pectoral fin
            cx.beginPath();
            cx.moveTo(ss * 0.1, ss * 0.2);
            cx.lineTo(-ss * 0.2, ss * 0.55);
            cx.lineTo(-ss * 0.3, ss * 0.15);
            cx.closePath();
            cx.fill();
            // Mouth
            cx.strokeStyle = 'rgba(20,25,30,0.9)';
            cx.lineWidth = 1.5;
            cx.beginPath();
            cx.moveTo(ss * 0.7, ss * 0.08);
            cx.lineTo(ss * 0.95, ss * 0.02);
            cx.lineTo(ss * 0.7, -ss * 0.05);
            cx.stroke();
            // Eye
            cx.fillStyle = '#111';
            cx.beginPath();
            cx.arc(ss * 0.6, -ss * 0.1, ss * 0.06, 0, Math.PI * 2);
            cx.fill();
            cx.fillStyle = 'rgba(200,0,0,0.5)';
            cx.beginPath();
            cx.arc(ss * 0.6, -ss * 0.1, ss * 0.03, 0, Math.PI * 2);
            cx.fill();
            cx.restore();
        }
    }

    // Reef redesign: blue-water haze toward the open-water edge (reef only)
    drawBlueHaze();

    // Bubbles
    for (var bi = 0; bi < bubbles.length; bi++) {
        var b = bubbles[bi];
        var by = diverScreenY + (b.depth - depth) / metersPerPixel;
        if (by < -20 || by > H + 20) continue;
        var bx = W * 0.25 + b.x;
        var r = bubbleDisplayRadius(b);
        var alpha = Math.max(0, 1 - b.age / BUBBLE_MAX_AGE) * 0.6;
        cx.beginPath();
        cx.arc(bx, by, r, 0, Math.PI * 2);
        cx.fillStyle = 'rgba(200,230,255,' + alpha + ')';
        cx.fill();
        cx.strokeStyle = 'rgba(255,255,255,' + (alpha * 0.5) + ')';
        cx.lineWidth = 0.5;
        cx.stroke();
    }

    // Phase C: Guideline rope (drawn before diver so diver sits on top)
    drawGuideline();

    // Phase C: Silt-out + torch overlay — dims the environment + guideline.
    // Drawn BEFORE the diver so the diver is never shadowed by its own torch.
    drawSiltAndTorch();

    // Light shafts punch down through the gloom to mark navigable passages.
    drawLightShafts();

    // Diver (Phase B: tilt toward current direction proportional to current.level)
    var diverTilt = 0;
    if (current.active && current.level > 0) {
        diverTilt = current.direction * Math.min(current.level / CURRENT_PARAMS.maxStrength, 1) * 0.25;
    }
    drawDiver(W * 0.25, diverScreenY, diverTilt);
    drawForegroundLayer();

    // Phase C: Bad-air warning banner (cave unbreathable dome)
    if (badAirWarning) {
        cx.save();
        cx.textAlign = 'center';
        cx.font = 'bold 18px monospace';
        cx.fillStyle = 'rgba(255,80,40,0.9)';
        cx.fillText('⚠ BAD AIR — UNBREATHABLE POCKET', W / 2, H * 0.18);
        cx.textAlign = 'left';
        cx.restore();
    }

    // TASK-019: Gas switch notification
    if (gasSwitchNotifyTime > 0) {
        cx.save();
        cx.textAlign = 'center';
        cx.font = 'bold 24px monospace';
        var nAlpha = Math.min(1, gasSwitchNotifyTime / 0.5);
        cx.fillStyle = 'rgba(0,255,200,' + nAlpha + ')';
        cx.fillText(gasSwitchNotifyText, W / 2, H * 0.3);
        cx.textAlign = 'left';
        cx.restore();
    }

    // Red edge flash on dangerous ascent rate
    if (gameState === 'diving' && ascentRate > 9) {
        var flashAlpha = (0.2 + 0.15 * Math.sin(Date.now() * 0.01)) * Math.min(1, (ascentRate - 9) / 9);
        ctx.fillStyle = 'rgba(255,0,0,' + flashAlpha + ')';
        ctx.fillRect(0, 0, W, 20);           // top
        ctx.fillRect(0, H - 20, W, 20);      // bottom
        ctx.fillRect(0, 0, 20, H);           // left
        ctx.fillRect(W - 20, 0, 20, H);      // right
    }

    // WP-020: Narcosis wobble cleanup
    if (narcWobble) cx.restore();
    cx.filter = 'none';

    // WP-020: Narcosis vignette (drawn stable, no wobble/filter)
    if (narcosisIndex > 0.15) {
        var vigAlpha = Math.min(0.7, (narcosisIndex - 0.15) * 0.82);
        var vigGrad = cx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.7);
        vigGrad.addColorStop(0, 'rgba(0,0,0,0)');
        vigGrad.addColorStop(1, 'rgba(0,0,0,' + vigAlpha.toFixed(2) + ')');
        cx.fillStyle = vigGrad;
        cx.fillRect(0, 0, W, H);
    }
}

function drawDiver(x, y, tilt) {
    var cx = ctx;
    var t = waveTime;
    // Sprite spans ~104 local px (fin-tip → fingertip). At the world scale of
    // 20 px/m, scale 0.48 makes the diver ≈ 2.5 m fin-to-hand — realistically
    // smaller than a 3.6 m car/6.5 m lorry instead of dwarfing them.
    var scale = 0.48;

    // Update facing direction only while actively finning; hold last when still
    if (horizontalVelocity > 0.05) _diverFacing = 1;
    else if (horizontalVelocity < -0.05) _diverFacing = -1;

    // Fin-kick style depends on dive mode. Recreational divers FLUTTER kick
    // (legs alternate up/down, continuous). Technical / CCR divers FROG kick
    // (legs sweep symmetrically in phase — recovery, power stroke, then a glide
    // pause) — the standard kick for trim and silt control in overhead/tec
    // diving. Only animated while actually moving horizontally.
    var moving = Math.abs(horizontalVelocity) > 0.05;
    var useFrog = (typeof diveMode !== 'undefined') && diveMode !== 'rec';
    var farKick = 0, nearKick = 0, farSplay = 0, nearSplay = 0;
    if (moving) {
        if (useFrog) {
            // One cycle: recovery (heels drawn up) → power (quick thrust back,
            // fins whip apart) → glide (legs together, momentarily still). The
            // asymmetric timing gives the characteristic pause-and-glide rhythm.
            var fc = (t * 1.6) % (Math.PI * 2);
            var tuck, splay;
            if (fc < Math.PI * 0.55) {                 // recovery — slow draw-up
                var rr = fc / (Math.PI * 0.55);
                tuck = rr; splay = rr * 0.35;
            } else if (fc < Math.PI * 0.85) {          // power — fast thrust + whip
                var pw = (fc - Math.PI * 0.55) / (Math.PI * 0.30);
                tuck = 1 - pw; splay = 0.35 + 0.65 * pw;
            } else {                                   // glide — legs together, still
                tuck = 0; splay = 0;
            }
            farKick = nearKick = -tuck * 9;            // both legs in phase, heels up
            farSplay = -splay * 0.5;                   // fins splay apart on the sweep
            nearSplay = splay * 0.5;
        } else {
            var fk = Math.sin(t * 3.2);
            farKick = -fk * 7;                         // flutter — legs alternate
            nearKick = fk * 7;
        }
    }

    cx.save();
    cx.translate(x, y + Math.sin(t * 0.8) * 3);
    if (tilt) cx.rotate(tilt);
    cx.rotate(-0.12 + Math.sin(t * 0.7) * 0.03);
    cx.scale(scale * _diverFacing, scale);

    // ambient occlusion under diver
    var sh = cx.createRadialGradient(-2, 11, 1, -2, 11, 26);
    sh.addColorStop(0, 'rgba(0,0,0,0.14)'); sh.addColorStop(1, 'rgba(0,0,0,0)');
    cx.fillStyle = sh; cx.beginPath(); cx.ellipse(-2, 12, 26, 6, 0, 0, Math.PI * 2); cx.fill();

    // far leg + fin
    drawDiverLeg(cx, -16, 4, farKick, '#22262a', '#c45c0e', farSplay);

    // tank
    cx.save(); cx.rotate(-0.02);
    cx.fillStyle = '#1d3140';
    cx.beginPath(); cx.roundRect(-22, -17, 26, 11, 5); cx.fill();
    cx.fillStyle = '#0c1a23'; cx.fillRect(-24, -14, 4, 6);
    cx.fillStyle = 'rgba(150,205,225,0.25)'; cx.beginPath(); cx.roundRect(-20, -16, 22, 3, 2); cx.fill();
    cx.restore();

    // reg hose
    cx.strokeStyle = '#2a3038'; cx.lineWidth = 2.4; cx.lineCap = 'round';
    cx.beginPath(); cx.moveTo(-18, -10); cx.quadraticCurveTo(6, -6, 26, 2); cx.stroke();

    // torso — D1: grey wetsuit with gradient shading
    cx.fillStyle = '#2e3338';
    cx.beginPath(); cx.ellipse(0, 0, 23, 9.5, 0, 0, Math.PI * 2); cx.fill();
    var tg = cx.createLinearGradient(0, -10, 0, 10);
    tg.addColorStop(0, 'rgba(255,255,255,0.07)'); tg.addColorStop(1, 'rgba(0,0,0,0.15)');
    cx.fillStyle = tg; cx.beginPath(); cx.ellipse(0, 0, 23, 9.5, 0, 0, Math.PI * 2); cx.fill();
    cx.strokeStyle = 'rgba(206,231,240,0.5)'; cx.lineWidth = 1.5;
    cx.beginPath(); cx.ellipse(0, 0, 22, 8.6, 0, Math.PI * 1.05, Math.PI * 1.95); cx.stroke();

    // forward arm
    cx.strokeStyle = '#2e3338'; cx.lineWidth = 7; cx.lineCap = 'round';
    cx.beginPath(); cx.moveTo(14, -1); cx.quadraticCurveTo(30, 1, 42, 3 + Math.sin(t * 2) * 1.5); cx.stroke();
    cx.strokeStyle = 'rgba(206,231,240,0.5)'; cx.lineWidth = 1.2;
    cx.beginPath(); cx.moveTo(15, -4); cx.lineTo(40, 0); cx.stroke();

    // near leg + fin
    drawDiverLeg(cx, -15, 3, nearKick, '#2e3338', '#ff7a1a', nearSplay);

    // head + hood — D1: grey
    cx.fillStyle = '#2e3338';
    cx.beginPath(); cx.arc(27, -1, 8.6, 0, Math.PI * 2); cx.fill();
    var hg2 = cx.createRadialGradient(24, -3, 2, 27, -1, 9);
    hg2.addColorStop(0, 'rgba(255,255,255,0.08)'); hg2.addColorStop(1, 'rgba(0,0,0,0.18)');
    cx.fillStyle = hg2; cx.beginPath(); cx.arc(27, -1, 8.6, 0, Math.PI * 2); cx.fill();
    cx.strokeStyle = 'rgba(206,231,240,0.5)'; cx.lineWidth = 1.4;
    cx.beginPath(); cx.arc(27, -1, 8, Math.PI * 1.1, Math.PI * 1.9); cx.stroke();

    // mask frame (orange)
    cx.fillStyle = '#ff7a1a';
    cx.beginPath(); cx.roundRect(30.5, -5.5, 8, 10, 3); cx.fill();
    // mask lens (light blue)
    cx.fillStyle = '#bfe8ff';
    cx.beginPath(); cx.roundRect(32, -4, 5.5, 7.5, 2); cx.fill();
    // lens glint
    cx.fillStyle = 'rgba(255,255,255,0.65)';
    cx.beginPath(); cx.roundRect(32.5, -3.5, 2, 2.5, 0.5); cx.fill();

    cx.restore();
}

// D1: leg + fin helper (called for near and far legs).
// `splay` (optional) rotates the fin extra during the frog-kick power sweep.
function drawDiverLeg(cx, hx, hy, kick, col, finCol, splay) {
    splay = splay || 0;
    var kneeY = hy + 3 + kick * 0.4, ankleY = hy + 5 + kick;
    cx.strokeStyle = col; cx.lineCap = 'round';
    cx.lineWidth = 8; cx.beginPath(); cx.moveTo(hx, hy); cx.lineTo(hx - 13, kneeY); cx.stroke();
    cx.lineWidth = 6; cx.beginPath(); cx.moveTo(hx - 13, kneeY); cx.lineTo(hx - 26, ankleY); cx.stroke();
    cx.save(); cx.translate(hx - 26, ankleY); cx.rotate(0.15 + kick * 0.04 + splay);
    cx.fillStyle = finCol;
    cx.beginPath();
    cx.moveTo(0, -5); cx.lineTo(-18, -8); cx.quadraticCurveTo(-23, 0, -18, 8); cx.lineTo(0, 5); cx.closePath(); cx.fill();
    cx.strokeStyle = 'rgba(255,255,255,0.22)'; cx.lineWidth = 1.2;
    cx.beginPath(); cx.moveTo(0, -5); cx.lineTo(-16, -7.5); cx.stroke();
    cx.restore();
}

// D4: Boat A body — painted at (0,0) after caller translates/rotates
function paintShip(cx, isRefl) {
    // hull with gradient shading
    cx.beginPath();
    cx.moveTo(-64, 0); cx.lineTo(64, 0);
    cx.quadraticCurveTo(78, -2, 70, -14);
    cx.lineTo(-50, -16);
    cx.quadraticCurveTo(-66, -15, -64, -2);
    cx.closePath();
    if (!isRefl) {
        var hg = cx.createLinearGradient(0, -16, 0, 0);
        hg.addColorStop(0, '#1e3340'); hg.addColorStop(0.5, '#16252f'); hg.addColorStop(1, '#0f1b23');
        cx.fillStyle = hg;
    } else { cx.fillStyle = '#16252f'; }
    cx.fill();
    cx.fillStyle = 'rgba(52,230,255,0.5)'; cx.fillRect(-60, -5, 128, 2.4);
    if (!isRefl) {
        cx.strokeStyle = 'rgba(206,231,240,0.5)'; cx.lineWidth = 1.4;
        cx.beginPath(); cx.moveTo(-50, -16); cx.lineTo(70, -14); cx.stroke();
    }
    // wheelhouse
    cx.fillStyle = '#0f1b23';
    cx.beginPath(); cx.roundRect(-20, -40, 40, 26, 4); cx.fill();
    cx.fillStyle = isRefl ? 'rgba(150,200,220,0.25)' : 'rgba(180,225,240,0.6)';
    cx.beginPath(); cx.roundRect(-14, -36, 16, 12, 2); cx.fill();
    cx.fillStyle = isRefl ? 'rgba(150,200,220,0.18)' : 'rgba(180,225,240,0.45)';
    cx.beginPath(); cx.roundRect(8, -34, 7, 7, 2); cx.fill();
    // hardtop
    cx.fillStyle = '#16252f';
    cx.beginPath(); cx.roundRect(-26, -50, 52, 8, 3); cx.fill();
    cx.fillStyle = '#0f1b23'; cx.fillRect(-22, -42, 3, 12); cx.fillRect(19, -42, 3, 12);
    if (!isRefl) {
        cx.strokeStyle = 'rgba(206,231,240,0.5)'; cx.lineWidth = 1.2;
        cx.beginPath(); cx.moveTo(-26, -50); cx.lineTo(26, -50); cx.stroke();
    }
    // A-frame stern
    cx.strokeStyle = '#0f1b23'; cx.lineWidth = 3;
    cx.beginPath(); cx.moveTo(-46, -16); cx.lineTo(-40, -44); cx.lineTo(-34, -16); cx.stroke();
    // dive ladder
    if (!isRefl) {
        cx.strokeStyle = 'rgba(180,210,220,0.65)'; cx.lineWidth = 1.5;
        cx.beginPath(); cx.moveTo(-57, -3); cx.lineTo(-57, 15); cx.stroke();
        cx.beginPath(); cx.moveTo(-51, -3); cx.lineTo(-51, 15); cx.stroke();
        for (var ry = 1; ry <= 14; ry += 4.5) {
            cx.beginPath(); cx.moveTo(-57, ry); cx.lineTo(-51, ry); cx.stroke();
        }
    }
    // mast
    cx.strokeStyle = '#cdd5da'; cx.lineWidth = 1.6;
    cx.beginPath(); cx.moveTo(58, -14); cx.lineTo(58, -56); cx.stroke();
    // Alpha flag (swallowtail: white hoist, royal-blue fly)
    cx.save(); cx.translate(58, -56);
    cx.beginPath();
    cx.moveTo(0, 0); cx.lineTo(26, 0); cx.lineTo(18, 8.5); cx.lineTo(26, 17); cx.lineTo(0, 17); cx.closePath();
    cx.save(); cx.clip();
    cx.fillStyle = '#f4f7f8'; cx.fillRect(0, 0, 12, 17);
    cx.fillStyle = '#1555c0'; cx.fillRect(12, 0, 26, 17);
    cx.restore();
    if (!isRefl) { cx.strokeStyle = 'rgba(100,140,200,0.3)'; cx.lineWidth = 0.8; cx.stroke(); }
    cx.restore();
    // diver-down flag below Alpha
    cx.save(); cx.translate(58, -36);
    cx.fillStyle = '#d83a39'; cx.beginPath(); cx.rect(0, 0, 20, 13); cx.fill();
    cx.save(); cx.beginPath(); cx.rect(0, 0, 20, 13); cx.clip();
    cx.strokeStyle = '#f4f7f8'; cx.lineWidth = 3;
    cx.beginPath(); cx.moveTo(0, 13); cx.lineTo(20, 0); cx.stroke();
    cx.restore(); cx.restore();
}

// ============================================================
//  PHASE C — SITE TERRAIN + OVERHEAD HELPERS
// ============================================================

function drawTerrain() {
    var W = canvas.width, H = canvas.height;
    var diverScreenX = W * 0.25;
    var diverScreenY = H * 0.45;
    var mpp = 0.05;
    var cx = ctx;
    var s = activeSite();

    if (!s) {
        // Open water — original flat seabed at MAX_DEPTH + texture + treasure chest
        var floorY = diverScreenY + (MAX_DEPTH - depth) / mpp;
        if (floorY < H + 100) {
            cx.fillStyle = '#2a1f0e';
            cx.fillRect(0, floorY, W, H - floorY + 100);
            cx.fillStyle = '#3d2f1a';
            for (var sfx = 0; sfx < W; sfx += 12) {
                var sfh = 2 + Math.sin(sfx * 0.3) * 3;
                cx.fillRect(sfx, floorY - sfh, 8, sfh);
            }
            // BYP-007: Treasure chest
            var chestX = W * 0.4;
            var chestW = 40, chestH = 25, lidH = 10;
            var chestY = floorY - chestH - lidH;
            cx.save();
            cx.shadowColor = 'rgba(255,215,0,0.6)';
            cx.shadowBlur = 15 + 5 * Math.sin(Date.now() * 0.003);
            cx.fillStyle = '#5c3a1e';
            cx.fillRect(chestX - chestW / 2, chestY + lidH, chestW, chestH);
            cx.fillStyle = '#7a4e2e';
            cx.beginPath();
            cx.moveTo(chestX - chestW / 2 - 1, chestY + lidH);
            cx.lineTo(chestX + chestW / 2 + 1, chestY + lidH);
            cx.quadraticCurveTo(chestX + chestW / 2 + 1, chestY, chestX, chestY - 2);
            cx.quadraticCurveTo(chestX - chestW / 2 - 1, chestY, chestX - chestW / 2 - 1, chestY + lidH);
            cx.fill();
            cx.restore();
            cx.fillStyle = '#8b7333';
            cx.fillRect(chestX - chestW / 2, chestY + lidH, chestW, 2);
            cx.fillRect(chestX - chestW / 2, chestY + lidH + chestH - 2, chestW, 2);
            cx.fillStyle = '#ffd700';
            cx.fillRect(chestX - 4, chestY + lidH - 2, 8, 8);
            cx.fillStyle = '#b8860b';
            cx.beginPath();
            cx.arc(chestX, chestY + lidH + 2, 2, 0, Math.PI * 2);
            cx.fill();
        }
        return;
    }

    // Site-specific terrain — piecewise-linear floor (and ceiling for cave)
    var xLeftM  = diverX + (0 - diverScreenX) * mpp - 2;   // a bit beyond left edge
    var xRightM = diverX + (W - diverScreenX) * mpp + 2;   // a bit beyond right edge
    var stepM = 4 * mpp;  // sample every 4 pixels

    // Floor polygon — fill from profile down to bottom of screen
    // D3: Shore gets a sandy gradient; reef is warm rock; cave is warm
    // limestone bedrock; others dark brown.
    var reefMesa = (s.id === 'reef');
    var caveSite = (s.id === 'cave');
    if (s.id === 'shore') {
        var sandGrad = cx.createLinearGradient(0, diverScreenY + (3 - depth) / mpp, 0, H);
        sandGrad.addColorStop(0, '#c2a06a');
        sandGrad.addColorStop(0.2, '#9a7840');
        sandGrad.addColorStop(0.6, '#5a3f22');
        sandGrad.addColorStop(1, '#2a1f0e');
        cx.fillStyle = sandGrad;
    } else if (reefMesa) {
        // Warm Red-Sea rock, anchored to absolute depth (surface-relative) so
        // the whole seamount reads as one solid sunlit-to-shadow mass.
        var surfY = diverScreenY - depth / mpp;
        var reefRockGrad = cx.createLinearGradient(0, surfY, 0, surfY + 140 / mpp * 0.05 + 900);
        reefRockGrad.addColorStop(0,    '#7a4a32');
        reefRockGrad.addColorStop(0.12, '#5a3623');
        reefRockGrad.addColorStop(0.45, '#3f2818');
        reefRockGrad.addColorStop(1,    '#241509');
        cx.fillStyle = reefRockGrad;
    } else if (caveSite) {
        // Depth-graded limestone: warm tan/brown at the shallow entrance,
        // cooling to bare grey rock down in the deep cathedral. Anchored to the
        // surface (2000 px ≈ 100 m) so the colour tracks absolute depth all the
        // way to the cathedral floor.
        var caveFloorSurfY = diverScreenY - depth / mpp;
        var caveFloorGrad = cx.createLinearGradient(0, caveFloorSurfY, 0, caveFloorSurfY + 2000);
        caveFloorGrad.addColorStop(0,    CAVE_PAL.rockMid);    // d0  warm brown
        caveFloorGrad.addColorStop(0.06, CAVE_PAL.rockWarm);   // d6  brown
        caveFloorGrad.addColorStop(0.13, CAVE_PAL.greyBrown);  // d13 transition
        caveFloorGrad.addColorStop(0.22, CAVE_PAL.greyMid);    // d22 grey
        caveFloorGrad.addColorStop(0.40, CAVE_PAL.greyShade);  // d40 dark grey
        caveFloorGrad.addColorStop(1,    CAVE_PAL.greyDark);   // d100 near black
        cx.fillStyle = caveFloorGrad;
    } else {
        cx.fillStyle = '#2a1f0e';
    }
    // Build the floor polygon, remembering the silhouette points so the reef
    // can re-clip to them for rock texture.
    var floorPts = [];
    for (var fwx = xLeftM; fwx <= xRightM + stepM; fwx += stepM) {
        var fd = floorAt(fwx);
        var fpx = diverScreenX + (fwx - diverX) / mpp;
        var fpy = diverScreenY + (fd - depth) / mpp;
        floorPts.push([fpx, fpy]);
    }
    var floorRight = diverScreenX + (xRightM + stepM - diverX) / mpp;
    var floorLeft  = diverScreenX + (xLeftM - diverX) / mpp;
    cx.beginPath();
    for (var fpi = 0; fpi < floorPts.length; fpi++) {
        if (fpi === 0) cx.moveTo(floorPts[fpi][0], floorPts[fpi][1]);
        else cx.lineTo(floorPts[fpi][0], floorPts[fpi][1]);
    }
    cx.lineTo(floorRight, H + 10);
    cx.lineTo(floorLeft, H + 10);
    cx.closePath();
    cx.fill();

    // Reef: warm rim along the lit crest + clipped rock texture so the mesa
    // reads as solid coral rock, not a flat silhouette.
    if (reefMesa) {
        cx.save();
        // soft warm rim on the upper silhouette (the sunlit edge)
        cx.strokeStyle = 'rgba(168,115,85,0.5)';
        cx.lineWidth = 2.5;
        cx.beginPath();
        for (var ri = 0; ri < floorPts.length; ri++) {
            if (ri === 0) cx.moveTo(floorPts[ri][0], floorPts[ri][1]);
            else cx.lineTo(floorPts[ri][0], floorPts[ri][1]);
        }
        cx.stroke();
        // clip to the mesa body and stipple lumps + cracks (stable world seed)
        cx.beginPath();
        for (var ci = 0; ci < floorPts.length; ci++) {
            if (ci === 0) cx.moveTo(floorPts[ci][0], floorPts[ci][1]);
            else cx.lineTo(floorPts[ci][0], floorPts[ci][1]);
        }
        cx.lineTo(floorRight, H + 10);
        cx.lineTo(floorLeft, H + 10);
        cx.closePath();
        cx.clip();
        // shading lumps — iterate an ABSOLUTE integer grid index so each cell's
        // seed is identical every frame (no float drift from a camera-relative
        // start → no flicker while scrolling).
        var lumpStepM = 1.6;
        for (var lk = Math.floor(xLeftM / lumpStepM); lk <= Math.ceil(xRightM / lumpStepM); lk++) {
            var lwx = lk * lumpStepM;
            var lseed = lwx * 12.9;
            var lpx = diverScreenX + (lwx - diverX) / mpp;
            var ldepth = floorAt(lwx) + 2 + sRand(lseed) * 60;
            var lpy = diverScreenY + (ldepth - depth) / mpp;
            var lr = 8 + sRand(lseed + 3.1) * 22;
            cx.fillStyle = sRand(lseed + 7.9) > 0.5 ? 'rgba(168,115,85,0.07)' : 'rgba(0,0,0,0.14)';
            cx.beginPath(); cx.arc(lpx, lpy, lr, 0, Math.PI * 2); cx.fill();
        }
        // a few vertical cracks down the flanks
        cx.strokeStyle = 'rgba(0,0,0,0.22)'; cx.lineWidth = 1.4;
        for (var crk = Math.floor(xLeftM / 5); crk <= Math.ceil(xRightM / 5); crk++) {
            var crwx = crk * 5;
            var cseed = crwx * 3.7;
            var ctop = floorAt(crwx);
            var cpx = diverScreenX + (crwx - diverX) / mpp;
            var cpyTop = diverScreenY + (ctop + 2 - depth) / mpp;
            cx.beginPath();
            cx.moveTo(cpx, cpyTop);
            cx.quadraticCurveTo(cpx + (sRand(cseed) - 0.5) * 18, cpyTop + 120,
                                cpx + (sRand(cseed + 2) - 0.5) * 14, cpyTop + 260);
            cx.stroke();
        }
        cx.restore();
    }

    // Ceiling polygon — textured rock, filled from profile up to top of screen (cave only)
    if (s.ceiling) {
        // Build the ceiling outline points (and remember them for texturing)
        var ceilPts = [];
        for (var cwx = xLeftM; cwx <= xRightM + stepM; cwx += stepM) {
            var cd = ceilingAt(cwx);
            if (cd <= 0.01) continue;  // open shaft (pond) — leave sky visible
            ceilPts.push([diverScreenX + (cwx - diverX) / mpp,
                          diverScreenY + (cd - depth) / mpp]);
        }
        if (ceilPts.length > 1) {
            var cLeftX = ceilPts[0][0], cRightX = ceilPts[ceilPts.length - 1][0];
            // Rock body gradient — warm limestone for caves, dark slate otherwise.
            var ceilSurfY = diverScreenY - depth / mpp;
            var rockGrad;
            if (caveSite) {
                // Depth-graded like the floor: soil + warm brown at the rim,
                // cooling to grey bedrock where the ceiling dips deep.
                rockGrad = cx.createLinearGradient(0, ceilSurfY - 20, 0, ceilSurfY + 1000);
                rockGrad.addColorStop(0,    CAVE_PAL.earth);       // soil layer at karst rim
                rockGrad.addColorStop(0.05, CAVE_PAL.earthLite);
                rockGrad.addColorStop(0.12, CAVE_PAL.rockMid);     // bedrock proper (≈d5)
                rockGrad.addColorStop(0.24, CAVE_PAL.rockWarm);    // brown (≈d11)
                rockGrad.addColorStop(0.40, CAVE_PAL.greyBrown);   // transition (≈d19)
                rockGrad.addColorStop(0.58, CAVE_PAL.greyMid);     // grey (≈d28)
                rockGrad.addColorStop(1,    CAVE_PAL.greyDark);
            } else {
                rockGrad = cx.createLinearGradient(0, -10, 0, diverScreenY);
                rockGrad.addColorStop(0, '#15110d');
                rockGrad.addColorStop(1, '#3a2e22');
            }
            cx.fillStyle = rockGrad;
            cx.beginPath();
            cx.moveTo(cLeftX, -10);
            cx.lineTo(ceilPts[0][0], ceilPts[0][1]);
            for (var ci = 1; ci < ceilPts.length; ci++) cx.lineTo(ceilPts[ci][0], ceilPts[ci][1]);
            cx.lineTo(cRightX, -10);
            cx.closePath();
            cx.fill();

            // Clip to the rock and paint strata bands + speckle for texture
            cx.save();
            cx.clip();
            if (caveSite) {
                // Earth band along the karst rim — a thin dark soil layer
                // hanging just under the surface (depth 0–1.5 m).
                var earthTopY = ceilSurfY;
                var earthBotY = ceilSurfY + 1.5 / mpp;
                cx.fillStyle = CAVE_PAL.earth;
                cx.fillRect(0, earthTopY, W, earthBotY - earthTopY);
                // Hanging tree-root strands from the underside of the earth
                // band. Seeded by WORLD-x (not screen-x) so they stay anchored
                // to the karst rim and don't slide along as the camera scrolls.
                cx.strokeStyle = '#1a1208';
                cx.lineWidth = 1.1;
                cx.lineCap = 'round';
                var rootStepM = 1.3;
                for (var rk = Math.floor(xLeftM / rootStepM); rk <= Math.ceil(xRightM / rootStepM); rk++) {
                    var rwx = rk * rootStepM;
                    var rtSeed = rwx * 13.7;
                    var rtH = 12 + sRand(rtSeed) * 32;
                    var rtX = diverScreenX + (rwx - diverX) / mpp + (sRand(rtSeed + 1) - 0.5) * 14;
                    cx.beginPath();
                    cx.moveTo(rtX, earthBotY);
                    cx.quadraticCurveTo(rtX + (sRand(rtSeed + 2) - 0.5) * 8,
                                        earthBotY + rtH * 0.55,
                                        rtX + (sRand(rtSeed + 3) - 0.5) * 6,
                                        earthBotY + rtH);
                    cx.stroke();
                }
                // bedding strata — horizontal layer lines through the limestone
                cx.strokeStyle = 'rgba(20,10,4,0.35)';
                cx.lineWidth = 1.6;
                for (var bbD = 4; bbD < 60; bbD += 4.5) {
                    cx.beginPath();
                    var bf = true;
                    for (var bbX = xLeftM; bbX <= xRightM + stepM; bbX += stepM) {
                        var bbY = ceilSurfY + bbD / mpp + Math.sin(bbX * 0.4 + bbD) * 2;
                        var bbPx = diverScreenX + (bbX - diverX) / mpp;
                        if (bf) { cx.moveTo(bbPx, bbY); bf = false; }
                        else cx.lineTo(bbPx, bbY);
                    }
                    cx.stroke();
                }
                // pocking speckle — dark dots scattered in the bedrock
                var spkStepM = 1.2;
                for (var spk = Math.floor(xLeftM / spkStepM); spk <= Math.ceil(xRightM / spkStepM); spk++) {
                    var spwx = spk * spkStepM;
                    var spSeed = spwx * 41.3;
                    var spDepthOffset = sRand(spSeed) * 12;
                    var spY = ceilSurfY + spDepthOffset / mpp;
                    var spX = diverScreenX + (spwx - diverX) / mpp + (sRand(spSeed + 1) - 0.5) * 16;
                    var spR = 0.6 + sRand(spSeed + 2) * 1.4;
                    cx.fillStyle = sRand(spSeed + 3) > 0.5
                        ? 'rgba(16,14,10,0.5)' : 'rgba(156,152,140,0.3)';
                    cx.beginPath(); cx.arc(spX, spY, spR, 0, Math.PI * 2); cx.fill();
                }
                // Highlight rim just under the ceiling lip
                cx.strokeStyle = 'rgba(216,200,168,0.45)';
                cx.lineWidth = 1.4;
                cx.beginPath();
                for (var hi = 0; hi < ceilPts.length; hi++) {
                    if (hi === 0) cx.moveTo(ceilPts[hi][0], ceilPts[hi][1] - 0.5);
                    else cx.lineTo(ceilPts[hi][0], ceilPts[hi][1] - 0.5);
                }
                cx.stroke();
            } else {
                cx.strokeStyle = 'rgba(0,0,0,0.22)';
                cx.lineWidth = 2;
                for (var bandD = 0; bandD < 40; bandD += 6) {
                    cx.beginPath();
                    var bFirst = true;
                    for (var bx = xLeftM; bx <= xRightM + stepM; bx += stepM) {
                        var by = diverScreenY + (ceilingAt(bx) - bandD - depth) / mpp;
                        var wob = Math.sin(bx * 0.6 + bandD) * 3;
                        var bpx = diverScreenX + (bx - diverX) / mpp;
                        if (bFirst) { cx.moveTo(bpx, by + wob); bFirst = false; }
                        else cx.lineTo(bpx, by + wob);
                    }
                    cx.stroke();
                }
                // Highlight just below the rock lip
                cx.strokeStyle = 'rgba(150,125,95,0.25)';
                cx.lineWidth = 2;
                cx.beginPath();
                for (var hi2 = 0; hi2 < ceilPts.length; hi2++) {
                    if (hi2 === 0) cx.moveTo(ceilPts[hi2][0], ceilPts[hi2][1] - 1);
                    else cx.lineTo(ceilPts[hi2][0], ceilPts[hi2][1] - 1);
                }
                cx.stroke();
            }
            cx.restore();
        }

        // Cave-only: stalactites hanging from the ceiling + stalagmites on
        // the floor, world-anchored (seed by world-x) so they don't shimmer
        // as the camera scrolls.
        if (caveSite) {
            drawCaveSpeleothems(cx, xLeftM, xRightM, diverScreenX, diverScreenY, mpp);
        }
    }
}

// ── Cenote bedding speleothems: stalactites + stalagmites ──
// Procedural calcite formations drawn along the ceiling/floor profiles.
function drawCaveSpeleothems(cx, xLeftM, xRightM, dsx, dsy, mpp) {
    var stepM = 0.9;
    // Iterate an ABSOLUTE integer grid index (not a camera-relative float start)
    // so every formation's seed is identical each frame → no flicker scrolling.
    for (var k = Math.floor(xLeftM / stepM); k <= Math.ceil(xRightM / stepM); k++) {
        var x = k * stepM;
        var seed = x * 11.7 + 3.1;
        // ---- stalactites (hanging from ceiling) ----
        var cd = ceilingAt(x);
        if (cd > 1 && sRand(seed) < 0.55) {
            var px = dsx + (x - diverX) / mpp;
            var py = dsy + (cd - depth) / mpp;
            var sH = (0.4 + sRand(seed + 1.3) * 1.8) / mpp;       // 8–44 px
            var sW = (0.18 + sRand(seed + 2.7) * 0.42) / mpp;      // 4–12 px
            drawStalactite(cx, px, py, sH, sW);
        }
        // ---- stalagmites (rising from floor) ----
        var fd = floorAt(x);
        // Only draw stalagmites where there IS an overhead (so we're inside the
        // cave proper, not in a pond). Skip if floor is shallow (sinkhole bowl).
        if (cd > 1 && fd > 12 && sRand(seed + 5.1) < 0.4) {
            var fpx = dsx + (x - diverX) / mpp;
            var fpy = dsy + (fd - depth) / mpp;
            var gH = (0.4 + sRand(seed + 6.3) * 1.4) / mpp;
            var gW = (0.22 + sRand(seed + 7.1) * 0.46) / mpp;
            drawStalagmite(cx, fpx, fpy, gH, gW);
        }
    }
}

function drawStalactite(cx, x, y, h, w) {
    cx.save();
    // flowstone gradient — pale calcite to dark wall shadow
    var g = cx.createLinearGradient(x, y, x, y + h);
    g.addColorStop(0,   CAVE_PAL.calciteLite);
    g.addColorStop(0.6, CAVE_PAL.calciteMid);
    g.addColorStop(1,   CAVE_PAL.calciteDark);
    cx.fillStyle = g;
    cx.beginPath();
    cx.moveTo(x - w * 0.5, y);
    cx.lineTo(x + w * 0.5, y);
    cx.lineTo(x + w * 0.35, y + h * 0.18);
    cx.lineTo(x + w * 0.45, y + h * 0.32);
    cx.lineTo(x + w * 0.22, y + h * 0.55);
    cx.lineTo(x + w * 0.28, y + h * 0.72);
    cx.lineTo(x,             y + h);
    cx.lineTo(x - w * 0.28, y + h * 0.72);
    cx.lineTo(x - w * 0.22, y + h * 0.55);
    cx.lineTo(x - w * 0.45, y + h * 0.32);
    cx.lineTo(x - w * 0.35, y + h * 0.18);
    cx.closePath();
    cx.fill();
    // central highlight rib
    cx.strokeStyle = 'rgba(232,220,192,0.55)';
    cx.lineWidth = 0.9;
    cx.beginPath();
    cx.moveTo(x, y + 2);
    cx.lineTo(x, y + h - 2);
    cx.stroke();
    // tip drip bead
    cx.fillStyle = CAVE_PAL.calciteLite;
    cx.globalAlpha = 0.8;
    cx.beginPath(); cx.arc(x, y + h + 1, Math.max(1, w * 0.15), 0, Math.PI * 2); cx.fill();
    cx.restore();
}

function drawStalagmite(cx, x, y, h, w) {
    cx.save();
    var g = cx.createLinearGradient(x, y - h, x, y);
    g.addColorStop(0,   CAVE_PAL.calciteLite);
    g.addColorStop(0.6, CAVE_PAL.calciteMid);
    g.addColorStop(1,   CAVE_PAL.calciteDark);
    cx.fillStyle = g;
    cx.beginPath();
    cx.moveTo(x - w * 0.5, y);
    cx.lineTo(x - w * 0.4, y - h * 0.18);
    cx.lineTo(x - w * 0.32, y - h * 0.4);
    cx.lineTo(x - w * 0.22, y - h * 0.62);
    cx.lineTo(x - w * 0.18, y - h * 0.82);
    cx.lineTo(x,             y - h);
    cx.lineTo(x + w * 0.18, y - h * 0.82);
    cx.lineTo(x + w * 0.22, y - h * 0.62);
    cx.lineTo(x + w * 0.32, y - h * 0.4);
    cx.lineTo(x + w * 0.4, y - h * 0.18);
    cx.lineTo(x + w * 0.5, y);
    cx.closePath();
    cx.fill();
    // central highlight rib
    cx.strokeStyle = 'rgba(232,220,192,0.45)';
    cx.lineWidth = 0.8;
    cx.beginPath();
    cx.moveTo(x, y - 2);
    cx.lineTo(x, y - h + 2);
    cx.stroke();
    cx.restore();
}

// ── Seeded deterministic pseudo-random (Task 7-10 structure helpers) ──
function sRand(n) {
    return (Math.abs(Math.sin(n * 127.1 + 311.7) * 43758.5453)) % 1;
}

function drawSiteAtmosphere() {
    var s = activeSite();
    if (!s) return;
    var W = canvas.width, H = canvas.height;
    var dsx = W * 0.25, dsy = H * 0.45, mpp = 0.05;
    var cx = ctx;
    var surfaceY = dsy - depth / mpp;
    cx.save();

    if (s.id === 'shore') {
        // Shallow caustics and a warm surface veil make the sandy descent feel sunlit.
        var causticAlpha = Math.max(0, 1 - depth / 24);
        if (causticAlpha > 0.02) {
            cx.strokeStyle = 'rgba(245,238,188,' + (0.16 * causticAlpha).toFixed(3) + ')';
            cx.lineWidth = 1.2;
            for (var cy = Math.max(surfaceY + 36, -30); cy < H; cy += 44) {
                cx.beginPath();
                for (var x = -20; x <= W + 20; x += 18) {
                    var y = cy + Math.sin(x * 0.03 + waveTime * 1.7 + cy * 0.02) * 5;
                    if (x === -20) cx.moveTo(x, y); else cx.lineTo(x, y);
                }
                cx.stroke();
            }
        }
        var shoreGlow = cx.createLinearGradient(0, Math.max(0, surfaceY), 0, H);
        shoreGlow.addColorStop(0, 'rgba(235,218,160,0.08)');
        shoreGlow.addColorStop(1, 'rgba(75,42,16,0)');
        cx.fillStyle = shoreGlow;
        cx.fillRect(0, Math.max(0, surfaceY), W, H);
    } else if (s.id === 'reef') {
        // Distant reef silhouettes behind the playable wall: a low-cost parallax layer.
        cx.globalAlpha = 0.12;
        cx.fillStyle = '#142a32';
        var baseD = Math.max(18, depth + 8);
        cx.beginPath();
        cx.moveTo(0, H);
        for (var wx = diverX - 80; wx <= diverX + 80; wx += 5) {
            var sx = dsx + (wx - diverX) / mpp * 0.18;
            var ridgeD = baseD + 14 + Math.sin(wx * 0.12) * 7 + Math.sin(wx * 0.29) * 2;
            var sy = dsy + (ridgeD - depth) / mpp;
            if (wx === diverX - 80) cx.lineTo(sx, sy); else cx.lineTo(sx, sy);
        }
        cx.lineTo(W, H);
        cx.closePath();
        cx.fill();
        cx.globalAlpha = 1;
    } else if (s.id === 'wreck') {
        // Slight murk and searchlight falloff around the wreck exterior/interior.
        var murk = cx.createRadialGradient(dsx, dsy, 80, dsx, dsy, Math.max(W, H) * 0.75);
        murk.addColorStop(0, 'rgba(135,185,190,0.03)');
        murk.addColorStop(1, 'rgba(12,22,26,0.18)');
        cx.fillStyle = murk;
        cx.fillRect(0, 0, W, H);
    } else if (s.id === 'cave') {
        // Subtle limestone dust in the water before the torch overlay darkens it.
        cx.fillStyle = 'rgba(188,178,148,0.08)';
        for (var i = 0; i < 80; i++) {
            var seed = i * 19.37;
            var px = (sRand(seed) * W + Math.sin(waveTime * 0.08 + i) * 8) % W;
            var py = sRand(seed + 2.1) * H;
            var pr = 0.7 + sRand(seed + 4.2) * 1.8;
            cx.beginPath(); cx.arc(px, py, pr, 0, Math.PI * 2); cx.fill();
        }
    }
    cx.restore();
}

function drawSiteDetailPass() {
    var s = activeSite();
    if (!s) return;
    drawTerrainEdgeAccents(s);
    if (s.id === 'shore') drawShoreSandDetails();
    else if (s.id === 'reef') drawReefTextureDetails();
    else if (s.id === 'cave') drawCaveMineralDetails();
}

function drawTerrainEdgeAccents(s) {
    var W = canvas.width, H = canvas.height;
    var dsx = W * 0.25, dsy = H * 0.45, mpp = 0.05;
    var xLeftM = diverX + (0 - dsx) * mpp - 2;
    var xRightM = diverX + (W - dsx) * mpp + 2;
    var cx = ctx;
    cx.save();

    if (s.id === 'shore') {
        cx.strokeStyle = 'rgba(236,205,135,0.32)';
        cx.lineWidth = 1.4;
        cx.beginPath();
        var first = true;
        for (var sxm = xLeftM; sxm <= xRightM; sxm += 0.35) {
            var sandY = dsy + (floorAt(sxm) - depth) / mpp;
            var wob = Math.sin(sxm * 2.8 + waveTime * 0.25) * 1.4;
            var spx = dsx + (sxm - diverX) / mpp;
            if (first) { cx.moveTo(spx, sandY + wob); first = false; }
            else cx.lineTo(spx, sandY + wob);
        }
        cx.stroke();
    } else if (s.id === 'reef') {
        // Small shelves and dark notches break the clean wall edge into ledges.
        for (var rk = Math.floor(xLeftM / 2); rk <= Math.ceil(xRightM / 2); rk++) {
            var rwx = rk * 2;
            if (sRand(rwx + 70) > 0.38) continue;
            var rfd = floorAt(rwx);
            if (rfd >= MAX_DEPTH - 1) continue;
            var rpx = dsx + (rwx - diverX) / mpp;
            var rpy = dsy + (rfd - depth) / mpp;
            if (rpx < -30 || rpx > W + 30 || rpy < -40 || rpy > H + 60) continue;
            var shelfW = 10 + sRand(rwx) * 24;
            cx.fillStyle = sRand(rwx + 1) > 0.5 ? 'rgba(30,18,10,0.34)' : 'rgba(158,98,60,0.22)';
            cx.beginPath();
            cx.ellipse(rpx, rpy + 2, shelfW, 4 + sRand(rwx + 3) * 5, 0, 0, Math.PI * 2);
            cx.fill();
        }
    } else if (s.id === 'cave') {
        cx.strokeStyle = 'rgba(202,190,160,0.16)';
        cx.lineWidth = 1.2;
        for (var ck = Math.floor(xLeftM / 3); ck <= Math.ceil(xRightM / 3); ck++) {
            var cwx = ck * 3;
            var cd = ceilingAt(cwx);
            if (cd <= 1 || sRand(cwx + 44) > 0.55) continue;
            var cpx = dsx + (cwx - diverX) / mpp;
            var cpy = dsy + (cd - depth) / mpp;
            if (cpx < -20 || cpx > W + 20 || cpy < -40 || cpy > H + 20) continue;
            var dripH = 18 + sRand(cwx + 2) * 42;
            cx.beginPath();
            cx.moveTo(cpx, cpy + 2);
            cx.lineTo(cpx + (sRand(cwx + 3) - 0.5) * 5, cpy + dripH);
            cx.stroke();
        }
    }
    cx.restore();
}

function drawShoreSandDetails() {
    var W = canvas.width, H = canvas.height;
    var dsx = W * 0.25, dsy = H * 0.45, mpp = 0.05;
    var xLeftM = diverX + (0 - dsx) * mpp - 2;
    var xRightM = diverX + (W - dsx) * mpp + 2;
    var cx = ctx;
    cx.save();
    cx.strokeStyle = 'rgba(255,226,162,0.16)';
    cx.lineWidth = 1;
    for (var r = Math.floor(xLeftM / 3); r <= Math.ceil(xRightM / 3); r++) {
        var wx = r * 3;
        var fd = floorAt(wx);
        var sx = dsx + (wx - diverX) / mpp;
        var sy = dsy + (fd - depth) / mpp;
        if (sy < -20 || sy > H + 40) continue;
        var len = 28 + sRand(wx) * 36;
        var rise = 4 + sRand(wx + 1.2) * 6;
        cx.beginPath();
        cx.moveTo(sx - len * 0.5, sy - 2);
        cx.quadraticCurveTo(sx, sy - rise, sx + len * 0.5, sy - 2);
        cx.stroke();
    }
    cx.fillStyle = 'rgba(45,30,16,0.16)';
    for (var p = Math.floor(xLeftM / 1.8); p <= Math.ceil(xRightM / 1.8); p++) {
        var pwx = p * 1.8;
        if (sRand(pwx + 9.1) > 0.42) continue;
        var pd = floorAt(pwx);
        var psx = dsx + (pwx - diverX) / mpp + (sRand(pwx + 2) - 0.5) * 20;
        var psy = dsy + (pd - depth) / mpp - 1;
        if (psy < -10 || psy > H + 20) continue;
        cx.beginPath(); cx.ellipse(psx, psy, 1.3 + sRand(pwx) * 2.5, 0.8, 0, 0, Math.PI * 2); cx.fill();
    }
    drawShoreAnchoredGrass(cx, xLeftM, xRightM, dsx, dsy, mpp, H);
    cx.restore();
}

function drawShoreAnchoredGrass(cx, xLeftM, xRightM, dsx, dsy, mpp, H) {
    cx.save();
    cx.globalAlpha = 0.34;
    cx.strokeStyle = '#21452b';
    cx.lineCap = 'round';
    for (var k = Math.floor(xLeftM / 3.4); k <= Math.ceil(xRightM / 3.4); k++) {
        var wx = k * 3.4;
        var fd = floorAt(wx);
        if (fd < 6 || fd > 24 || sRand(wx + 80) > 0.52) continue;
        // Do not paint grass through solid structures; those rocks/wrecks should
        // visually own the foreground when they occupy the same world space.
        if (solidAt(wx, fd - 0.25) || solidAt(wx, fd - 1.5)) continue;
        var sx = dsx + (wx - diverX) / mpp;
        var sy = dsy + (fd - depth) / mpp;
        if (sx < -50 || sx > canvas.width + 50 || sy < -20 || sy > H + 30) continue;
        var blades = 4 + Math.floor(sRand(wx + 1) * 4);
        for (var b = 0; b < blades; b++) {
            var ox = (b - blades / 2) * 5;
            var h = 20 + sRand(wx + b * 2.7) * 34;
            cx.lineWidth = 1.4 + sRand(wx + b) * 1.2;
            cx.beginPath();
            cx.moveTo(sx + ox, sy);
            cx.quadraticCurveTo(sx + ox + Math.sin(waveTime + b) * 5, sy - h * 0.55,
                                sx + ox + Math.sin(waveTime * 1.3 + b) * 8, sy - h);
            cx.stroke();
        }
    }
    cx.restore();
}

function drawReefTextureDetails() {
    var W = canvas.width, H = canvas.height;
    var dsx = W * 0.25, dsy = H * 0.45, mpp = 0.05;
    var xLeftM = diverX + (0 - dsx) * mpp - 2;
    var xRightM = diverX + (W - dsx) * mpp + 2;
    var cx = ctx;
    cx.save();
    for (var k = Math.floor(xLeftM / 1.2); k <= Math.ceil(xRightM / 1.2); k++) {
        var wx = k * 1.2;
        var fd = floorAt(wx);
        if (fd >= MAX_DEPTH - 1 || sRand(wx + 31) > 0.55) continue;
        var sx = dsx + (wx - diverX) / mpp;
        var sy = dsy + (fd - depth) / mpp;
        if (sx < -50 || sx > W + 50 || sy < -50 || sy > H + 60) continue;
        var hue = sRand(wx + 2.4);
        cx.fillStyle = hue < 0.33 ? 'rgba(230,142,70,0.35)' : hue < 0.66 ? 'rgba(198,68,132,0.32)' : 'rgba(236,205,110,0.28)';
        cx.beginPath();
        cx.ellipse(sx, sy - 3, 5 + sRand(wx) * 11, 2 + sRand(wx + 4) * 4, -0.2, 0, Math.PI * 2);
        cx.fill();
    }
    cx.strokeStyle = 'rgba(10,8,6,0.34)';
    cx.lineCap = 'round';
    for (var c = Math.floor(xLeftM / 3.2); c <= Math.ceil(xRightM / 3.2); c++) {
        var cwx = c * 3.2;
        var cfd = floorAt(cwx);
        if (cfd >= MAX_DEPTH - 1 || sRand(cwx + 105) > 0.42) continue;
        var cpx = dsx + (cwx - diverX) / mpp;
        var cpy = dsy + (cfd + 1.4 + sRand(cwx) * 16 - depth) / mpp;
        if (cpx < -40 || cpx > W + 40 || cpy < -50 || cpy > H + 70) continue;
        if (sRand(cwx + 6) > 0.55) {
            cx.fillStyle = 'rgba(8,8,8,0.28)';
            cx.beginPath(); cx.ellipse(cpx, cpy, 5 + sRand(cwx + 1) * 9, 8 + sRand(cwx + 2) * 15, 0.15, 0, Math.PI * 2); cx.fill();
        } else {
            cx.lineWidth = 1.2 + sRand(cwx + 3) * 1.2;
            cx.beginPath();
            cx.moveTo(cpx, cpy - 14);
            cx.quadraticCurveTo(cpx + (sRand(cwx + 4) - 0.5) * 15, cpy + 10,
                                cpx + (sRand(cwx + 5) - 0.5) * 12, cpy + 42);
            cx.stroke();
        }
    }
    cx.restore();
}

function drawWreckExteriorDetails() {
    var s = activeSite();
    if (!s || s.id !== 'wreck') return;
    var W = canvas.width, H = canvas.height, cx = ctx;
    var dsx = W * 0.25, dsy = H * 0.45, mpp = 0.05;
    var exteriorFade = Math.max(0.18, 1 - _wreckMetal * 0.78);

    cx.save();
    cx.globalAlpha = exteriorFade;
    _buildWreckSilhouette(cx, dsx, dsy, mpp);
    cx.clip();
    drawUprightFerryShell(cx, dsx, dsy, mpp, W, H);
    // Long rust tears and old paint scratches, seeded in world-space columns.
    for (var i = 0; i < 34; i++) {
        var wx = 18 + i * 4.5 + sRand(i) * 2;
        var d0 = 19 + sRand(i + 7) * 22;
        var sx = dsx + (wx - diverX) / mpp;
        var sy = dsy + (d0 - depth) / mpp;
        if (sx < -20 || sx > W + 20 || sy > H + 60) continue;
        var len = 26 + sRand(i + 12) * 70;
        var rust = cx.createLinearGradient(sx, sy, sx, sy + len);
        rust.addColorStop(0, 'rgba(190,82,28,0.34)');
        rust.addColorStop(1, 'rgba(80,36,18,0)');
        cx.strokeStyle = rust;
        cx.lineWidth = 1 + sRand(i + 4) * 2.5;
        cx.beginPath();
        cx.moveTo(sx, sy);
        cx.quadraticCurveTo(sx + (sRand(i + 2) - 0.5) * 18, sy + len * 0.45,
                            sx + (sRand(i + 3) - 0.5) * 10, sy + len);
        cx.stroke();
    }
    drawWreckShipCues(cx, dsx, dsy, mpp, W, H, exteriorFade);
    cx.restore();
}

function drawUprightFerryShell(cx, dsx, dsy, mpp, W, H) {
    function SX(wx) { return dsx + (wx - diverX) / mpp; }
    function SY(wd) { return dsy + (wd - depth) / mpp; }
    cx.save();

    // Keel contact shadow and silt mound: the ship feels heavy on the seabed.
    var keelY = SY(66);
    var keelG = cx.createRadialGradient(SX(92), keelY, 20, SX(92), keelY, 680);
    keelG.addColorStop(0, 'rgba(0,0,0,0.34)');
    keelG.addColorStop(1, 'rgba(0,0,0,0)');
    cx.fillStyle = keelG;
    cx.beginPath(); cx.ellipse(SX(92), keelY + 8, 1550, 34, 0, 0, Math.PI * 2); cx.fill();

    // Upright ferry shell: angled bow/stern faces and a dark lower hull band.
    var hullTop = SY(28), hullBot = SY(66);
    var shellG = cx.createLinearGradient(0, hullTop, 0, hullBot);
    shellG.addColorStop(0, 'rgba(54,65,68,0.34)');
    shellG.addColorStop(0.55, 'rgba(34,40,43,0.22)');
    shellG.addColorStop(1, 'rgba(10,12,14,0.38)');
    cx.fillStyle = shellG;
    cx.beginPath();
    cx.moveTo(SX(14), SY(66));
    cx.lineTo(SX(17), SY(34));
    cx.quadraticCurveTo(SX(21), SY(29), SX(29), SY(28));
    cx.lineTo(SX(154), SY(28));
    cx.quadraticCurveTo(SX(166), SY(30), SX(170), SY(39));
    cx.lineTo(SX(170), SY(66));
    cx.closePath();
    cx.fill();
    cx.strokeStyle = 'rgba(125,146,148,0.18)';
    cx.lineWidth = 2;
    cx.stroke();

    // Old antifouling/boot stripe and deck-level seams.
    cx.fillStyle = 'rgba(92,36,28,0.20)';
    cx.fillRect(SX(14), SY(53), SX(170) - SX(14), SY(66) - SY(53));
    cx.strokeStyle = 'rgba(8,10,12,0.55)';
    cx.lineWidth = 2;
    cx.beginPath(); cx.moveTo(SX(18), SY(40)); cx.lineTo(SX(166), SY(40)); cx.stroke();
    cx.beginPath(); cx.moveTo(SX(18), SY(46)); cx.lineTo(SX(166), SY(46)); cx.stroke();
    cx.beginPath(); cx.moveTo(SX(18), SY(53)); cx.lineTo(SX(166), SY(53)); cx.stroke();

    // Vehicle deck shadow slot: long Ro-Ro identity, but still upright.
    cx.fillStyle = 'rgba(0,0,0,0.18)';
    cx.beginPath();
    cx.roundRect(SX(24), SY(31), SX(148) - SX(24), Math.max(8, SY(39) - SY(31)), 2);
    cx.fill();
    cx.strokeStyle = 'rgba(130,150,150,0.14)';
    cx.lineWidth = 1;
    cx.stroke();

    // Superstructure front panels and bridge glazing.
    cx.fillStyle = 'rgba(88,96,88,0.22)';
    cx.fillRect(SX(42), SY(22), SX(138) - SX(42), SY(28) - SY(22));
    cx.fillStyle = 'rgba(18,45,54,0.55)';
    for (var w = 73; w <= 105; w += 8) {
        cx.beginPath();
        cx.roundRect(SX(w), SY(19.4), 5 / mpp, 2.4 / mpp, 1.2);
        cx.fill();
    }
    cx.strokeStyle = 'rgba(160,190,190,0.15)';
    cx.lineWidth = 1;
    cx.beginPath(); cx.moveTo(SX(72), SY(19)); cx.lineTo(SX(108), SY(19)); cx.stroke();

    cx.restore();
}

function drawWreckShipCues(cx, dsx, dsy, mpp, W, H, alpha) {
    function SX(wx) { return dsx + (wx - diverX) / mpp; }
    function SY(wd) { return dsy + (wd - depth) / mpp; }

    // Portholes and a tired livery stripe help the blocky shell read as a ferry.
    cx.save();
    cx.globalAlpha *= alpha;
    cx.strokeStyle = 'rgba(95,130,140,0.34)';
    cx.lineWidth = 1.2;
    for (var x = 46; x <= 134; x += 8) {
        var px = SX(x), py = SY(24.5);
        if (px < -20 || px > W + 20 || py < -20 || py > H + 20) continue;
        cx.fillStyle = 'rgba(18,48,58,0.45)';
        cx.beginPath(); cx.arc(px, py, 3.2, 0, Math.PI * 2); cx.fill(); cx.stroke();
        cx.fillStyle = 'rgba(160,220,220,0.12)';
        cx.beginPath(); cx.arc(px - 0.8, py - 0.8, 1.1, 0, Math.PI * 2); cx.fill();
    }
    cx.strokeStyle = 'rgba(180,70,48,0.28)';
    cx.lineWidth = 4;
    cx.beginPath(); cx.moveTo(SX(18), SY(30)); cx.lineTo(SX(166), SY(30)); cx.stroke();

    // Bow visor and stern ramp outlines: Ro-Ro ferry, upright on the bottom.
    cx.strokeStyle = 'rgba(20,24,26,0.70)';
    cx.lineWidth = 2.2;
    cx.beginPath();
    cx.moveTo(SX(16), SY(29)); cx.lineTo(SX(26), SY(36)); cx.lineTo(SX(22), SY(40));
    cx.stroke();
    cx.beginPath();
    cx.moveTo(SX(148), SY(30)); cx.lineTo(SX(168), SY(35)); cx.lineTo(SX(164), SY(40));
    cx.stroke();

    // Deck railings: decorative only, not collision.
    cx.strokeStyle = 'rgba(18,24,26,0.78)';
    cx.lineWidth = 2;
    var railY = SY(22);
    cx.beginPath(); cx.moveTo(SX(42), railY); cx.lineTo(SX(138), railY); cx.stroke();
    cx.lineWidth = 1;
    for (var r = 42; r <= 138; r += 6) {
        cx.beginPath(); cx.moveTo(SX(r), railY); cx.lineTo(SX(r), railY - 12); cx.stroke();
    }

    // Davit arms near the lifeboat positions.
    cx.strokeStyle = 'rgba(20,24,26,0.62)';
    cx.lineWidth = 1.6;
    var davits = [48, 132];
    for (var d = 0; d < davits.length; d++) {
        cx.beginPath();
        cx.moveTo(SX(davits[d]), SY(22));
        cx.quadraticCurveTo(SX(davits[d] + (d === 0 ? -5 : 5)), SY(21), SX(davits[d] + (d === 0 ? -8 : 8)), SY(24));
        cx.stroke();
    }

    // Torn plating around the three entry mouths and a few hanging cables.
    var entries = [18, 85, 158];
    cx.strokeStyle = 'rgba(10,12,14,0.55)';
    cx.lineWidth = 2.2;
    for (var e = 0; e < entries.length; e++) {
        var ex = SX(entries[e]);
        var ey = SY(e === 1 ? 28 : 27.5);
        if (ex < -80 || ex > W + 80) continue;
        cx.beginPath();
        cx.moveTo(ex - 24, ey + 2);
        cx.lineTo(ex - 12, ey + 12);
        cx.lineTo(ex + 2, ey + 5);
        cx.lineTo(ex + 18, ey + 16);
        cx.stroke();
        cx.lineWidth = 1.2;
        cx.beginPath();
        cx.moveTo(ex + 10, ey + 2);
        cx.quadraticCurveTo(ex + 16, ey + 22, ex + 8, ey + 40);
        cx.stroke();
        cx.lineWidth = 2.2;
    }

    // Marine-growth fringes along exposed rails and deck lips.
    cx.strokeStyle = 'rgba(150,130,72,0.46)';
    cx.lineWidth = 2.2;
    cx.lineCap = 'round';
    for (var g = 0; g < 26; g++) {
        var gx = 30 + g * 5.1;
        if (sRand(gx + 211) > 0.62) continue;
        var gd = 28 + sRand(gx) * 3.5;
        cx.beginPath();
        cx.moveTo(SX(gx), SY(gd));
        cx.quadraticCurveTo(SX(gx + 0.6), SY(gd + 1.2), SX(gx + 0.2), SY(gd + 3.2 + sRand(gx + 3) * 2));
        cx.stroke();
    }

    // Small debris and silt against the upright keel.
    cx.fillStyle = 'rgba(70,56,38,0.34)';
    for (var s = 0; s < 22; s++) {
        var dx = 18 + sRand(s + 301) * 148;
        var dy = 65.4 + sRand(s + 302) * 1.2;
        var px2 = SX(dx), py2 = SY(dy);
        if (px2 < -20 || px2 > W + 20 || py2 < -20 || py2 > H + 20) continue;
        cx.beginPath(); cx.ellipse(px2, py2, 2 + sRand(s) * 5, 0.8 + sRand(s + 2) * 1.4, 0, 0, Math.PI * 2); cx.fill();
    }
    cx.restore();
}

function drawCaveMineralDetails() {
    var W = canvas.width, H = canvas.height;
    var dsx = W * 0.25, dsy = H * 0.45, mpp = 0.05;
    var xLeftM = diverX + (0 - dsx) * mpp - 2;
    var xRightM = diverX + (W - dsx) * mpp + 2;
    var cx = ctx;
    cx.save();
    for (var k = Math.floor(xLeftM / 2.4); k <= Math.ceil(xRightM / 2.4); k++) {
        var wx = k * 2.4;
        if (sRand(wx + 15) > 0.45) continue;
        var cd = ceilingAt(wx);
        if (cd <= 1) continue;
        var sx = dsx + (wx - diverX) / mpp;
        var sy = dsy + (cd - depth) / mpp;
        if (sx < -20 || sx > W + 20 || sy < -30 || sy > H + 30) continue;
        cx.strokeStyle = 'rgba(232,220,192,0.22)';
        cx.lineWidth = 1 + sRand(wx) * 1.5;
        var h = 24 + sRand(wx + 3) * 60;
        cx.beginPath();
        cx.moveTo(sx, sy + 3);
        cx.quadraticCurveTo(sx + (sRand(wx + 4) - 0.5) * 10, sy + h * 0.45,
                            sx + (sRand(wx + 5) - 0.5) * 8, sy + h);
        cx.stroke();
    }
    var s = activeSite();
    if (s && s.badAir && s.badAir.length) {
        cx.save();
        cx.globalCompositeOperation = 'lighter';
        for (var i = 0; i < s.badAir.length; i++) {
            var pocket = s.badAir[i];
            var x1 = dsx + (pocket.x1 - diverX) / mpp;
            var x2 = dsx + (pocket.x2 - diverX) / mpp;
            var y = dsy + (pocket.d - depth) / mpp;
            if (x2 < -30 || x1 > W + 30 || y < -40 || y > H + 40) continue;
            cx.strokeStyle = 'rgba(210,185,110,0.22)';
            cx.lineWidth = 1.4;
            cx.beginPath();
            for (var sx = x1; sx <= x2; sx += 6) {
                var sy = y + Math.sin((sx + waveTime * 36) * 0.08) * 2.2;
                if (sx === x1) cx.moveTo(sx, sy); else cx.lineTo(sx, sy);
            }
            cx.stroke();
        }
        cx.restore();
    }
    cx.restore();
}

function drawForegroundLayer() {
    var s = activeSite();
    if (!s) return;
    var W = canvas.width, H = canvas.height;
    var dsx = W * 0.25, dsy = H * 0.45, mpp = 0.05;
    var cx = ctx;
    cx.save();
    if (s.id === 'shore') {
        // Shore grass is drawn world-anchored in the sand detail pass so rocks
        // and wreckage can occlude it correctly.
    } else if (s.id === 'reef') {
        drawForegroundReefFans(cx, W, H, dsx, dsy, mpp);
    } else if (s.id === 'wreck') {
        drawForegroundWreckDebris(cx, W, H, dsx, dsy, mpp);
    } else if (s.id === 'cave') {
        drawForegroundCaveColumns(cx, W, H, dsx, dsy, mpp);
    }
    cx.restore();
}

function drawForegroundReefFans(cx, W, H, dsx, dsy, mpp) {
    var side = diverX > 0 ? -1 : 1;
    var baseX = side < 0 ? -15 : W + 15;
    cx.globalAlpha = 0.24;
    cx.strokeStyle = '#5a1730';
    cx.lineCap = 'round';
    for (var i = 0; i < 5; i++) {
        var seed = i * 17.3 + Math.floor(diverX / 5);
        var y = H * (0.25 + i * 0.14) + Math.sin(seed) * 22;
        var h = 95 + sRand(seed) * 90;
        var sign = side;
        cx.lineWidth = 3;
        cx.beginPath();
        cx.moveTo(baseX, y + h * 0.45);
        cx.quadraticCurveTo(baseX + sign * 28, y - h * 0.15, baseX + sign * 46, y - h * 0.42);
        cx.stroke();
        cx.lineWidth = 1.5;
        for (var r = 0; r < 12; r++) {
            var t = r / 11;
            var len = h * (0.42 + Math.sin(t * Math.PI) * 0.35);
            cx.beginPath();
            cx.moveTo(baseX, y + h * 0.45);
            cx.quadraticCurveTo(baseX + sign * len * 0.34, y + h * 0.2 - len * t,
                                baseX + sign * len, y + h * 0.35 - len);
            cx.stroke();
        }
    }
    cx.globalAlpha = 1;
}

function drawForegroundWreckDebris(cx, W, H, dsx, dsy, mpp) {
    var floorY = dsy + (66 - depth) / mpp;
    if (floorY < H * 0.45 || floorY > H + 220) return;
    cx.globalAlpha = 0.26;
    cx.strokeStyle = '#0b0d0f';
    cx.lineWidth = 5;
    cx.lineCap = 'round';
    for (var i = 0; i < 9; i++) {
        var wx = -20 + i * 28 + sRand(i) * 10;
        var sx = dsx + (wx - diverX) / (mpp * 0.82);
        var sy = floorY + 18 + sRand(i + 2) * 110;
        if (sx < -120 || sx > W + 120) continue;
        cx.beginPath();
        cx.moveTo(sx - 42, sy);
        cx.lineTo(sx + 36, sy - 10 - sRand(i + 5) * 35);
        cx.stroke();
        cx.lineWidth = 2;
        cx.beginPath();
        cx.moveTo(sx - 20, sy - 4);
        cx.lineTo(sx - 14, sy - 36);
        cx.moveTo(sx + 12, sy - 7);
        cx.lineTo(sx + 18, sy - 42);
        cx.stroke();
        cx.lineWidth = 5;
    }
    cx.globalAlpha = 1;
}

function drawForegroundCaveColumns(cx, W, H, dsx, dsy, mpp) {
    var xLeftM = diverX + (0 - dsx) * mpp * 0.7 - 8;
    var xRightM = diverX + (W - dsx) * mpp * 0.7 + 8;
    cx.globalAlpha = 0.18;
    for (var k = Math.floor(xLeftM / 12); k <= Math.ceil(xRightM / 12); k++) {
        var wx = k * 12;
        if (sRand(wx + 99) > 0.42) continue;
        var cd = ceilingAt(wx);
        var fd = floorAt(wx);
        if (cd <= 1 || fd - cd < 12) continue;
        var sx = dsx + (wx - diverX) / (mpp * 0.7);
        var y1 = dsy + (cd - depth) / mpp;
        var y2 = dsy + (fd - depth) / mpp;
        if (sx < -120 || sx > W + 120 || y2 < -80 || y1 > H + 80) continue;
        if (sx > W * 0.18 && sx < W * 0.82) continue;
        var w = 12 + sRand(wx + 2) * 18;
        var g = cx.createLinearGradient(sx, y1, sx, y2);
        g.addColorStop(0, 'rgba(6,5,4,0.58)');
        g.addColorStop(0.5, 'rgba(22,20,17,0.36)');
        g.addColorStop(1, 'rgba(5,4,3,0.60)');
        cx.fillStyle = g;
        cx.beginPath();
        cx.moveTo(sx - w * 0.45, y1);
        cx.quadraticCurveTo(sx - w, (y1 + y2) * 0.5, sx - w * 0.35, y2);
        cx.lineTo(sx + w * 0.35, y2);
        cx.quadraticCurveTo(sx + w, (y1 + y2) * 0.5, sx + w * 0.45, y1);
        cx.closePath();
        cx.fill();
        cx.strokeStyle = 'rgba(180,170,140,0.10)';
        cx.lineWidth = 1.2;
        cx.beginPath();
        cx.moveTo(sx - w * 0.12, y1 + 20);
        cx.lineTo(sx - w * 0.28, y2 - 20);
        cx.stroke();
    }
    cx.globalAlpha = 1;
}

// ── Wreck interior backdrop — riveted steel plating + windows ──
// Replaces open-ocean background for the wreck site. Tiles in world space
// (via the camera transform) so the wall scrolls with the diver.
function drawWreckBackdrop(cx, W, H, dsx, dsy, mpp) {
    // Base dark steel gradient
    var g = cx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#3b424a'); g.addColorStop(0.5, '#2a3036'); g.addColorStop(1, '#171b1f');
    cx.fillStyle = g;
    cx.fillRect(0, 0, W, H);

    // ── Depth-layered hull livery ──────────────────────────────────────────
    // The wreck's hull reads as distinct bands split at the old waterline /
    // main-deck line ("bowline", ≈28 m): cooler bare topside steel ABOVE it,
    // a dark boot-top stripe ON it, and rust-red antifouling + marine growth
    // BELOW it that deepens toward the keel.
    var bootD = 28;
    var yOf = function (d) { return dsy + (d - depth) / mpp; };
    var bootY = yOf(bootD);
    // topside band (above the line): faint cool sheen
    var topG = cx.createLinearGradient(0, yOf(bootD - 20), 0, bootY);
    topG.addColorStop(0, 'rgba(126,146,156,0.16)');
    topG.addColorStop(1, 'rgba(126,146,156,0)');
    cx.fillStyle = topG;
    cx.fillRect(0, 0, W, Math.max(0, Math.min(bootY, H)));
    // antifouling band (below the line): rust-red fading into shadow
    var antiBot = yOf(bootD + 32);
    var aG = cx.createLinearGradient(0, bootY, 0, antiBot);
    aG.addColorStop(0,    'rgba(104,46,32,0.34)');   // boot-top edge
    aG.addColorStop(0.4,  'rgba(78,38,28,0.22)');
    aG.addColorStop(1,    'rgba(34,20,16,0.06)');
    cx.fillStyle = aG;
    cx.fillRect(0, bootY, W, Math.max(0, antiBot - bootY));
    // dark boot-top stripe sitting on the line
    cx.fillStyle = 'rgba(18,12,10,0.55)';
    cx.fillRect(0, bootY - 2, W, 4.5);

    var panelW = 6, panelH = 4;  // metres per steel plate
    var xLeftM  = diverX + (0 - dsx) * mpp;
    var xRightM = diverX + (W - dsx) * mpp;
    var dTopM   = depth + (0 - dsy) * mpp;
    var dBotM   = depth + (H - dsy) * mpp;
    var c0 = Math.floor(xLeftM / panelW), c1 = Math.ceil(xRightM / panelW);
    var r0 = Math.floor(dTopM / panelH), r1 = Math.ceil(dBotM / panelH);

    // Plate shading (alternating subtle tone per panel) + windows
    for (var c = c0; c <= c1; c++) {
        for (var r = r0; r <= r1; r++) {
            var px = dsx + (c * panelW - diverX) / mpp;
            var py = dsy + (r * panelH - depth) / mpp;
            var pw = panelW / mpp, ph = panelH / mpp;
            // faint per-plate tone variation
            if (((c + r) & 1) === 0) {
                cx.fillStyle = 'rgba(255,255,255,0.018)';
                cx.fillRect(px, py, pw, ph);
            }
            // sparse windows / portholes letting dim outside light in
            var wseed = ((c * 73 + r * 149) % 100 + 100) % 100;
            if (wseed < 12) {
                var wx = px + pw * 0.5, wy = py + ph * 0.5;
                var wr = Math.min(pw, ph) * 0.28;
                var wg = cx.createRadialGradient(wx, wy, 1, wx, wy, wr * 1.4);
                wg.addColorStop(0, 'rgba(120,190,200,0.55)');
                wg.addColorStop(1, 'rgba(120,190,200,0)');
                cx.fillStyle = wg;
                cx.beginPath(); cx.arc(wx, wy, wr * 1.4, 0, Math.PI * 2); cx.fill();
                cx.fillStyle = 'rgba(70,120,135,0.5)';
                cx.beginPath(); cx.arc(wx, wy, wr, 0, Math.PI * 2); cx.fill();
                cx.strokeStyle = 'rgba(150,170,180,0.4)'; cx.lineWidth = 2;
                cx.beginPath(); cx.arc(wx, wy, wr, 0, Math.PI * 2); cx.stroke();
            }
        }
    }

    // Plate seams (vertical + horizontal) with rivets at intersections
    cx.strokeStyle = 'rgba(0,0,0,0.30)'; cx.lineWidth = 1.5;
    for (var cv = c0; cv <= c1; cv++) {
        var sx = dsx + (cv * panelW - diverX) / mpp;
        cx.beginPath(); cx.moveTo(sx, 0); cx.lineTo(sx, H); cx.stroke();
    }
    for (var rh = r0; rh <= r1; rh++) {
        var sy = dsy + (rh * panelH - depth) / mpp;
        cx.beginPath(); cx.moveTo(0, sy); cx.lineTo(W, sy); cx.stroke();
    }
    cx.fillStyle = 'rgba(180,190,200,0.22)';
    for (var cc = c0; cc <= c1; cc++) {
        for (var rr = r0; rr <= r1; rr++) {
            var ix = dsx + (cc * panelW - diverX) / mpp;
            var iy = dsy + (rr * panelH - depth) / mpp;
            cx.beginPath(); cx.arc(ix, iy, 1.5, 0, Math.PI * 2); cx.fill();
        }
    }

    // Marine growth clinging to the lower hull (below the boot-top line) —
    // olive/rust tufts seeded per plate cell so they stay put while scrolling.
    for (var gc = c0; gc <= c1; gc++) {
        for (var gr = r0; gr <= r1; gr++) {
            if (gr * panelH < bootD) continue;          // only below the line
            var gsd = ((gc * 131 + gr * 197) % 100 + 100) % 100;
            if (gsd >= 24) continue;
            var gx = dsx + (gc * panelW - diverX) / mpp + (gsd % 5) * (panelW / mpp / 6);
            var gy = dsy + (gr * panelH - depth) / mpp + (gsd % 4) * (panelH / mpp / 5);
            cx.fillStyle = gsd < 12 ? 'rgba(58,86,48,0.45)' : 'rgba(96,82,42,0.40)';
            cx.beginPath(); cx.arc(gx, gy, 1.6 + (gsd % 3), 0, Math.PI * 2); cx.fill();
        }
    }
}

// Ship silhouette = union of the regions that ENCLOSE interior decks. Funnel
// and mast are left out so their detailed sprites stay visible from outside.
// Rects are kept NON-overlapping (they only touch edge-to-edge) so an even-odd
// hole can be punched cleanly. Each entry: [x1, x2, dTop, dBottom] world units.
function _wreckSilhouetteRects() {
    return [
        [14, 170, 28, 66],   // multi-deck hull body (main deck → keel)
        [40, 140, 22, 28],   // accommodation block
        [70, 110, 18, 22]    // bridge / wheelhouse
    ];
}

function _buildWreckSilhouette(cx, dsx, dsy, mpp) {
    var R = _wreckSilhouetteRects();
    cx.beginPath();
    for (var i = 0; i < R.length; i++) {
        var x1 = dsx + (R[i][0] - diverX) / mpp;
        var x2 = dsx + (R[i][1] - diverX) / mpp;
        var y1 = dsy + (R[i][2] - depth) / mpp;
        var y2 = dsy + (R[i][3] - depth) / mpp;
        cx.rect(x1, y1, x2 - x1, y2 - y1);
    }
}

// Steel hull painted BEHIND the interior objects so gaps read as metal, not
// open ocean. Clipped to the ship silhouette → ocean stays everywhere else.
function drawWreckSteelBack() {
    var s = activeSite();
    if (!s || s.id !== 'wreck') return;
    var W = canvas.width, H = canvas.height, cx = ctx;
    var dsx = W * 0.25, dsy = H * 0.45, mpp = 0.05;
    cx.save();
    _buildWreckSilhouette(cx, dsx, dsy, mpp);
    cx.clip();
    drawWreckBackdrop(cx, W, H, dsx, dsy, mpp);
    cx.restore();
}

// Opaque steel hull skin painted OVER the interior (so you cannot see inside
// from open water). While the diver is inside (overhead), a round line-of-sight
// hole in the skin lets only the nearby interior show through — beyond it the
// hull is solid steel, so navigation is limited in every direction. The hole
// grows in as the diver enters (eased via _wreckMetal) and is bigger with the
// torch on.
function drawWreckHullSkin() {
    var s = activeSite();
    if (!s || s.id !== 'wreck') return;
    var W = canvas.width, H = canvas.height, cx = ctx;
    var dsx = W * 0.25, dsy = H * 0.45, mpp = 0.05;
    var rad = (torchOn ? 165 : 100) * Math.max(0.55, visibility) * _wreckMetal;

    // Skin pass: fill the silhouette MINUS the line-of-sight hole with steel.
    cx.save();
    _buildWreckSilhouette(cx, dsx, dsy, mpp);
    cx.clip();                                   // restrict to the ship
    if (rad > 1) {
        cx.beginPath();
        cx.rect(0, 0, W, H);
        cx.arc(dsx, dsy, rad, 0, Math.PI * 2);   // screen minus the hole…
        cx.clip('evenodd');                      // …intersected with the hull
    }
    drawWreckBackdrop(cx, W, H, dsx, dsy, mpp);
    cx.restore();

    // Feather the rim so the hole blends into the steel instead of a hard disc.
    if (rad > 1) {
        cx.save();
        _buildWreckSilhouette(cx, dsx, dsy, mpp);
        cx.clip();
        var ring = cx.createRadialGradient(dsx, dsy, rad * 0.72, dsx, dsy, rad * 1.16);
        ring.addColorStop(0, 'rgba(28,33,38,0)');
        ring.addColorStop(1, 'rgba(28,33,38,' + (0.9 * _wreckMetal).toFixed(3) + ')');
        cx.fillStyle = ring;
        cx.fillRect(0, 0, W, H);
        cx.restore();
    }
}

// The three deliberate penetrations into the hull, marked so a diver can spot
// them from OUTSIDE (the opaque hull skin otherwise hides every opening). Each
// gets a dark recessed mouth, a pulsing cyan glow, a down-pointing chevron and
// a label. They fade out as the diver enters (1 − _wreckMetal) since the hull
// skin's line-of-sight bubble takes over for navigation once inside.
function drawWreckEntryMarkers() {
    var s = activeSite();
    if (!s || s.id !== 'wreck') return;
    var vis = 1 - _wreckMetal;
    if (vis < 0.05) return;
    var W = canvas.width, H = canvas.height, cx = ctx;
    var dsx = W * 0.25, dsy = H * 0.45, mpp = 0.05;
    var deckD = 27.5;                       // main-deck line (top of the openings)
    var entries = [
        { x1: 16,  x2: 22,  label: 'BOW' },
        { x1: 78,  x2: 92,  label: 'HATCH' },
        { x1: 148, x2: 168, label: 'STERN' }
    ];
    var pulse = 0.5 + 0.5 * Math.sin(waveTime * 1.6);
    cx.save();
    cx.globalAlpha = vis * 0.62;            // understated overall
    cx.textAlign = 'center';
    for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        var cxm = dsx + ((e.x1 + e.x2) / 2 - diverX) / mpp;
        var ow = (e.x2 - e.x1) / mpp;       // opening width in px
        var oy = dsy + (deckD - depth) / mpp;
        if (cxm < -ow || cxm > W + ow) continue;
        var halfW = ow / 2;
        // faint glow halo hinting at the opening
        var glow = cx.createRadialGradient(cxm, oy, 2, cxm, oy, halfW + 14);
        glow.addColorStop(0, 'rgba(120,205,220,' + (0.12 + 0.07 * pulse).toFixed(3) + ')');
        glow.addColorStop(1, 'rgba(120,205,220,0)');
        cx.fillStyle = glow;
        cx.fillRect(cxm - halfW - 18, oy - 22, ow + 36, 48);
        // thin rim outlining the dark mouth (no opaque fill — keep it subtle)
        cx.strokeStyle = 'rgba(140,215,225,' + (0.34 + 0.14 * pulse).toFixed(3) + ')';
        cx.lineWidth = 1.2;
        cx.beginPath();
        cx.roundRect(cxm - halfW, oy - 2, ow, 12, 3);
        cx.stroke();
        // small down-pointing chevron above the opening
        cx.strokeStyle = 'rgba(150,220,230,' + (0.34 + 0.16 * pulse).toFixed(3) + ')';
        cx.lineWidth = 1.5;
        cx.lineCap = 'round'; cx.lineJoin = 'round';
        var chevW = 6, chevY = oy - 12 - pulse * 1.5;
        cx.beginPath();
        cx.moveTo(cxm - chevW, chevY);
        cx.lineTo(cxm, chevY + 5);
        cx.lineTo(cxm + chevW, chevY);
        cx.stroke();
        // small label
        cx.fillStyle = 'rgba(175,220,228,0.6)';
        cx.font = '7px "Barlow Semi Condensed", monospace';
        cx.fillText('ENTRY', cxm, oy - 18);
    }
    cx.textAlign = 'left';
    cx.restore();
}

// ── Task 7: Rock — organic overlapping boulders (stable world seed) ──
// tone: optional palette override.
//   'reef'     — warm coralline cliff face
//   'caveGrey' — cool grey limestone (deep cave)
//   'caveBrown'— warm tan limestone (cave entrance)
//   'shore'    — mottled grey-tan beach boulder
// Boulders get a rounded multi-lobe crown, a soft top rim-light, internal
// shading lumps, cracks, and a contact-shadow skirt so they read as sitting
// IN the seabed rather than floating on it.
var ROCK_PALETTES = {
    reef:      ['#7a4a32', '#5a3623', '#3a2415'],
    caveGrey:  ['#787770', '#4c4b45', '#23221d'],
    caveBrown: ['#6e5d44', '#4a3a28', '#241a10'],
    shore:     ['#6a6256', '#494238', '#221e18'],
    'default': ['#5b4d40', '#3d3228', '#1e1a16']
};
// Boulders are static vector art that only TRANSLATES as the camera pans, but
// re-rasterising their fine detail (cracks, speckle, rim) every frame makes the
// thin 1px features shimmer/crawl under sub-pixel motion — worst on the widest
// rocks because they carry the most detail (more lobes, cracks and lumps), which
// reads as the rock "jittering". Fix: rasterise each boulder to an offscreen
// canvas ONCE (keyed by size + seed + tone) and blit it thereafter. The blit
// interpolates smoothly at sub-pixel positions, so the detail no longer shimmers
// (and it's far cheaper per frame). Size/seed are constant per rock, so each rock
// occupies exactly one cache entry that is reused every frame.
var _rockCache = {};
function drawRockStruct(cx, sx1, sy1, sw, sh, seed, tone) {
    var w = Math.max(1, Math.round(sw));
    var h = Math.max(1, Math.round(sh));
    var padX = Math.ceil(w * 0.13) + 16;   // covers the contact-shadow ellipse + overhang
    var padT = 18, padB = 18;              // crown rim above, shadow below
    var key = (tone || 'default') + '|' + w + '|' + h + '|' + seed.toFixed(2);
    var entry = _rockCache[key];
    if (!entry) {
        var oc = document.createElement('canvas');
        oc.width = w + padX * 2;
        oc.height = h + padT + padB;
        _paintRockStruct(oc.getContext('2d'), padX, padT, w, h, seed, tone);
        entry = _rockCache[key] = { canvas: oc, padX: padX, padT: padT };
    }
    cx.drawImage(entry.canvas, sx1 - entry.padX, sy1 - entry.padT);
}

function _paintRockStruct(cx, sx1, sy1, sw, sh, seed, tone) {
    cx.save();
    // Lobed organic silhouette: the top edge is only mildly irregular — the dip
    // is a small bounded amount (NOT a fraction of height) so tall reef columns
    // still fill their footprint instead of leaving big empty gaps.
    // Rounder boulders everywhere EXCEPT reef cliff faces: the top is a smooth
    // dome (apex at the box top, shoulders sinking toward the sides) with only
    // gentle bumps, so each rock reads as a water-worn round boulder. Reef
    // walls keep the old near-flat cliff profile. The dome apex stays at the
    // box top (never bulges past the collision AABB).
    var rounded = (tone !== 'reef');
    var lobes = Math.max(rounded ? 6 : 3, Math.round(sw / (rounded ? 16 : 26)));
    var jitter = rounded ? Math.min(sw * 0.05, sh * 0.12, 7)
                         : Math.min(sh * 0.3, sw * 0.45, 20);
    if (tone === 'reef') jitter = Math.min(jitter, 5);
    var dome = rounded ? Math.min(sh * 0.5, sw * 0.4) : 0;
    var crown = rounded ? Math.min(dome * 0.18, 10) : Math.min(jitter * 0.7, 12);
    var top = [];
    for (var i = 0; i <= lobes; i++) {
        var t = i / lobes;
        var px = sx1 + sw * t;
        // dome shoulders: 0 px at the centre, `dome` px lower at each edge
        var shoulder = dome * (1 - Math.sin(Math.PI * t));
        var bump = sRand(seed + i * 4.1) * jitter;
        top.push([px, sy1 + shoulder + bump]);
    }
    function traceTop() {
        cx.moveTo(sx1 - sw * 0.04, sy1 + sh);      // bottom-left (slight overhang)
        cx.lineTo(top[0][0], top[0][1]);
        for (var j = 1; j < top.length; j++) {
            var mx = (top[j - 1][0] + top[j][0]) / 2;
            var my = Math.min(top[j - 1][1], top[j][1]) - crown;
            cx.quadraticCurveTo(mx, my, top[j][0], top[j][1]);   // rounded crowns
        }
        cx.lineTo(sx1 + sw * 1.04, sy1 + sh);      // bottom-right
        cx.closePath();
    }

    // Contact-shadow skirt: a soft dark ellipse where the boulder meets the
    // seabed, so it looks grounded (drawn before the body, outside the clip).
    cx.fillStyle = 'rgba(0,0,0,0.22)';
    cx.beginPath();
    cx.ellipse(sx1 + sw / 2, sy1 + sh, sw * 0.62, Math.min(10, sh * 0.18), 0, 0, Math.PI * 2);
    cx.fill();

    cx.beginPath();
    traceTop();
    var pal = ROCK_PALETTES[tone] || ROCK_PALETTES['default'];
    var rg = cx.createLinearGradient(sx1, sy1, sx1, sy1 + sh);
    rg.addColorStop(0, pal[0]); rg.addColorStop(0.5, pal[1]); rg.addColorStop(1, pal[2]);
    cx.fillStyle = rg;
    cx.fill();
    if (tone === 'reef') {
        cx.strokeStyle = '#a87355'; cx.lineWidth = 2;
        cx.stroke();
    }

    // Clip to the boulder body and stipple shading lumps + cracks.
    cx.save();
    cx.clip();
    var lumps = Math.max(2, Math.round(sw * sh / 4200));
    for (var l = 0; l < lumps; l++) {
        var lx = sx1 + sRand(seed + l * 9.7) * sw;
        var ly = sy1 + (0.2 + sRand(seed + l * 5.1) * 0.8) * sh;
        var lr = (6 + sRand(seed + l * 3.3) * 14);
        var shade = sRand(seed + l * 7.9);
        cx.fillStyle = shade > 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.16)';
        cx.beginPath(); cx.arc(lx, ly, lr, 0, Math.PI * 2); cx.fill();
    }
    // A couple of cracks
    cx.strokeStyle = 'rgba(0,0,0,0.30)'; cx.lineWidth = 1;
    var nc = Math.max(1, Math.floor(sw / 45));
    for (var c = 1; c <= nc; c++) {
        var crx = sx1 + sw * (c / (nc + 1)) + (sRand(seed + c * 5.3) - 0.5) * 14;
        cx.beginPath();
        cx.moveTo(crx, sy1 + sh * (0.1 + sRand(seed + c * 7.1) * 0.2));
        cx.quadraticCurveTo(crx + (sRand(seed + c * 9.3) - 0.5) * 14, sy1 + sh * 0.55,
                            crx + (sRand(seed + c * 2.7) - 0.5) * 10, sy1 + sh * 0.92);
        cx.stroke();
    }
    cx.restore();

    // Soft rim light along the lit crown (re-trace, stroke only the top arc).
    cx.save();
    cx.beginPath();
    cx.moveTo(top[0][0], top[0][1]);
    for (var k = 1; k < top.length; k++) {
        var mx2 = (top[k - 1][0] + top[k][0]) / 2;
        var my2 = Math.min(top[k - 1][1], top[k][1]) - crown;
        cx.quadraticCurveTo(mx2, my2, top[k][0], top[k][1]);
    }
    cx.strokeStyle = tone === 'caveGrey' ? 'rgba(190,192,188,0.28)'
                   : tone === 'reef'     ? 'rgba(190,140,110,0.0)'   // reef has its own stroke
                                         : 'rgba(200,186,150,0.22)';
    cx.lineWidth = 1.6;
    cx.stroke();
    cx.restore();

    cx.restore();
}

// ── Cave bedrock partition — a solid limestone mass (NOT boulders) used to
//    genuinely separate the upper tunnel from the deep cathedral. Filled with
//    the same depth-graded limestone gradient as the floor/ceiling so it tiles
//    seamlessly with the surrounding walls; strata + speckle are world-anchored
//    so they don't shimmer while the camera scrolls. ──
function drawBedrockStruct(cx, wx1, wx2, wdTop, wdBottom) {
    var W = canvas.width, H = canvas.height;
    var dsx = W * 0.25, dsy = H * 0.45, mpp = 0.05;
    var sy1 = dsy + (wdTop - depth) / mpp, sy2 = dsy + (wdBottom - depth) / mpp;
    var sx1 = dsx + (wx1 - diverX) / mpp, sx2 = dsx + (wx2 - diverX) / mpp;
    if (sx2 < -60 || sx1 > W + 60 || sy2 < -60 || sy1 > H + 60) return;
    var surfY = dsy - depth / mpp;
    function SX(wx) { return dsx + (wx - diverX) / mpp; }
    function SY(wd) { return dsy + (wd - depth) / mpp; }
    // smooth world-anchored 1D noise (stable while scrolling)
    function nz(a) { return Math.sin(a * 0.7) * 0.6 + Math.sin(a * 1.9 + 2.1) * 0.3 + Math.sin(a * 3.3 + 4.7) * 0.1; }

    // Build organic top + bottom edges so the mass reads as natural rock rather
    // than a box: a gently rolling upper surface (the upper-tunnel floor) and a
    // lumpy cathedral ceiling. Both hug the collision AABB to within ~2 m.
    var step = 1.5, topPts = [], botPts = [];
    for (var wx = wx1; wx <= wx2 + 0.01; wx += step) {
        topPts.push([SX(wx), SY(wdTop + 1.1 + nz(wx * 1.0) * 1.4)]);
        botPts.push([SX(wx), SY(wdBottom + 0.4 + nz(wx * 0.9 + 31.0) * 2.0)]);
    }

    cx.save();
    // closed organic outline (top L→R, down the right face, bottom R→L)
    cx.beginPath();
    cx.moveTo(topPts[0][0], topPts[0][1]);
    for (var i = 1; i < topPts.length; i++) cx.lineTo(topPts[i][0], topPts[i][1]);
    for (var j = botPts.length - 1; j >= 0; j--) cx.lineTo(botPts[j][0], botPts[j][1]);
    cx.closePath();

    // depth-graded limestone fill (same stops as the cave floor in drawTerrain)
    var g = cx.createLinearGradient(0, surfY, 0, surfY + 2000);
    g.addColorStop(0,     CAVE_PAL.rockMid);
    g.addColorStop(0.06,  CAVE_PAL.rockWarm);
    g.addColorStop(0.13,  CAVE_PAL.greyBrown);
    g.addColorStop(0.22,  CAVE_PAL.greyMid);
    g.addColorStop(0.40,  CAVE_PAL.greyShade);
    g.addColorStop(1,     CAVE_PAL.greyDark);
    cx.fillStyle = g;
    cx.fill();

    // texture clipped to the organic mass (strata + speckle, world-anchored)
    cx.save();
    cx.clip();
    cx.strokeStyle = 'rgba(14,10,6,0.30)'; cx.lineWidth = 1.4;
    for (var wd = Math.ceil(wdTop / 4.5) * 4.5; wd < wdBottom; wd += 4.5) {
        var yy = SY(wd);
        cx.beginPath();
        var first = true;
        for (var bx = wx1; bx <= wx2; bx += 0.6) {
            var wob = Math.sin(bx * 0.4 + wd * 0.5) * 2;
            if (first) { cx.moveTo(SX(bx), yy + wob); first = false; }
            else cx.lineTo(SX(bx), yy + wob);
        }
        cx.stroke();
    }
    var stepM = 1.2;
    for (var swx = Math.floor(wx1 / stepM) * stepM; swx <= wx2; swx += stepM) {
        for (var swd = Math.floor(wdTop); swd < wdBottom; swd += 1.2) {
            var sd = swx * 31.7 + swd * 7.3;
            if (sRand(sd) >= 0.4) continue;
            var spx = SX(swx) + (sRand(sd + 1) - 0.5) * 16;
            var spy = SY(swd) + (sRand(sd + 2) - 0.5) * 16;
            var spr = 0.6 + sRand(sd + 3) * 1.4;
            cx.fillStyle = sRand(sd + 4) > 0.5 ? 'rgba(14,12,8,0.5)' : 'rgba(150,148,140,0.26)';
            cx.beginPath(); cx.arc(spx, spy, spr, 0, Math.PI * 2); cx.fill();
        }
    }
    cx.restore();

    // lit rim along the rolling top + soft shadow along the lumpy underside
    cx.strokeStyle = 'rgba(156,154,146,0.30)'; cx.lineWidth = 1.6;
    cx.beginPath();
    cx.moveTo(topPts[0][0], topPts[0][1]);
    for (var k = 1; k < topPts.length; k++) cx.lineTo(topPts[k][0], topPts[k][1]);
    cx.stroke();
    cx.strokeStyle = 'rgba(0,0,0,0.28)'; cx.lineWidth = 3;
    cx.beginPath();
    cx.moveTo(botPts[0][0], botPts[0][1]);
    for (var m = 1; m < botPts.length; m++) cx.lineTo(botPts[m][0], botPts[m][1]);
    cx.stroke();

    // a few rock pendants hanging from the cathedral ceiling (drama + detail)
    for (var p = 1; p < botPts.length - 1; p += 3) {
        var pseed = (wx1 * 5.3 + p * 9.7);
        if (sRand(pseed) >= 0.4) continue;
        var bxp = botPts[p][0], byp = botPts[p][1];
        var ph = 10 + sRand(pseed + 1) * 26;
        var pw = 4 + sRand(pseed + 2) * 5;
        cx.fillStyle = g;
        cx.beginPath();
        cx.moveTo(bxp - pw, byp - 2);
        cx.quadraticCurveTo(bxp - pw * 0.35, byp + ph * 0.55, bxp, byp + ph);
        cx.quadraticCurveTo(bxp + pw * 0.35, byp + ph * 0.55, bxp + pw, byp - 2);
        cx.closePath(); cx.fill();
    }
    cx.restore();
}

// ── Shore landmark: an old half-buried admiralty anchor in the sand ──
function drawAnchor(cx, x, yFloor, worldSeed, scale) {
    cx.save();
    var seed = (worldSeed || 0) * 3.7 + 1.3;
    // Lie the anchor back at a jaunty angle, flukes dug into the sand.
    cx.translate(x, yFloor);
    cx.rotate(-0.32 + (sRand(seed) - 0.5) * 0.1);
    var sc = scale || 1.0;
    cx.scale(sc, sc);

    // Contact shadow on the sand
    cx.fillStyle = 'rgba(0,0,0,0.20)';
    cx.beginPath(); cx.ellipse(0, 4, 30, 6, 0, 0, Math.PI * 2); cx.fill();

    // Rusty iron gradient used for all members
    var ironG = cx.createLinearGradient(-4, -46, 6, 6);
    ironG.addColorStop(0, '#5a4332');
    ironG.addColorStop(0.5, '#3d2c20');
    ironG.addColorStop(1, '#241912');
    cx.strokeStyle = ironG;
    cx.fillStyle = ironG;
    cx.lineCap = 'round';
    cx.lineJoin = 'round';

    // Shank (main vertical bar)
    cx.lineWidth = 5;
    cx.beginPath(); cx.moveTo(0, -44); cx.lineTo(0, 4); cx.stroke();
    // Ring at the top
    cx.lineWidth = 3;
    cx.beginPath(); cx.arc(0, -49, 5.5, 0, Math.PI * 2); cx.stroke();
    // Stock (cross-bar near the top)
    cx.lineWidth = 4;
    cx.beginPath(); cx.moveTo(-15, -38); cx.lineTo(15, -34); cx.stroke();
    // Arms sweeping down to the flukes (curved crown at the base)
    cx.lineWidth = 5;
    cx.beginPath();
    cx.moveTo(-18, 6);
    cx.quadraticCurveTo(0, -6, 18, 6);     // crown arc
    cx.stroke();
    // Flukes (arrowhead pads on each arm)
    cx.beginPath();
    cx.moveTo(-18, 6); cx.lineTo(-24, 0); cx.lineTo(-21, 9); cx.closePath(); cx.fill();
    cx.beginPath();
    cx.moveTo(18, 6); cx.lineTo(24, 0); cx.lineTo(21, 9); cx.closePath(); cx.fill();

    // A few rust speckles + algae tuft
    cx.fillStyle = 'rgba(150,70,10,0.25)';
    cx.beginPath(); cx.ellipse(0, -20, 2.4, 5, 0, 0, Math.PI * 2); cx.fill();
    cx.strokeStyle = 'rgba(60,120,60,0.7)'; cx.lineWidth = 1.6;
    for (var a = -1; a <= 1; a++) {
        cx.beginPath();
        cx.moveTo(a * 6, -34);
        cx.quadraticCurveTo(a * 6 + 3, -42, a * 6 - 1, -48);
        cx.stroke();
    }
    cx.restore();
}

// ── Shore: small sunken rowing/sailing boat (no interior) ──
function drawSmallWreck(cx, sx1, sy1, sw, sh) {
    cx.save();
    var cxm = sx1 + sw / 2, by = sy1 + sh;
    // Hull — open shell, tilted slightly, planked
    cx.translate(cxm, by);
    cx.rotate(-0.12);
    var hw = sw * 0.62, hh = sh * 0.85;
    var hg = cx.createLinearGradient(0, -hh, 0, 0);
    hg.addColorStop(0, '#6b5436'); hg.addColorStop(1, '#3a2c1a');
    cx.fillStyle = hg;
    cx.beginPath();
    cx.moveTo(-hw, -hh);                                   // gunwale port (open top)
    cx.quadraticCurveTo(-hw * 1.05, -hh * 0.2, -hw * 0.7, 0);
    cx.quadraticCurveTo(0, hh * 0.5, hw * 0.7, 0);
    cx.quadraticCurveTo(hw * 1.05, -hh * 0.2, hw, -hh);    // gunwale starboard
    cx.quadraticCurveTo(0, -hh * 0.55, -hw, -hh);          // open deck rim
    cx.closePath();
    cx.fill();
    // Plank lines
    cx.strokeStyle = 'rgba(0,0,0,0.3)'; cx.lineWidth = 1;
    for (var p = 1; p <= 3; p++) {
        var yy = -hh + (hh * 0.9) * p / 4;
        cx.beginPath();
        cx.moveTo(-hw * (1 - p * 0.06), yy);
        cx.quadraticCurveTo(0, yy + hh * 0.35, hw * (1 - p * 0.06), yy);
        cx.stroke();
    }
    // Interior shadow (hollow shell)
    cx.fillStyle = 'rgba(0,0,0,0.35)';
    cx.beginPath();
    cx.moveTo(-hw * 0.86, -hh * 0.95);
    cx.quadraticCurveTo(0, -hh * 0.5, hw * 0.86, -hh * 0.95);
    cx.quadraticCurveTo(0, hh * 0.2, -hw * 0.86, -hh * 0.95);
    cx.closePath();
    cx.fill();
    // Broken mast stub leaning out
    cx.strokeStyle = '#4a3a22'; cx.lineWidth = 3; cx.lineCap = 'round';
    cx.beginPath(); cx.moveTo(hw * 0.1, -hh * 0.7); cx.lineTo(hw * 0.55, -hh * 1.9); cx.stroke();
    // Algae tufts on the rim
    cx.strokeStyle = 'rgba(60,120,60,0.7)'; cx.lineWidth = 2;
    for (var a = -2; a <= 2; a++) {
        var ax = a * hw * 0.32;
        cx.beginPath(); cx.moveTo(ax, -hh); cx.quadraticCurveTo(ax + 3, -hh - 8, ax - 2, -hh - 14); cx.stroke();
    }
    cx.restore();
}

// ── Task 8: Hull — steel gradient, rust patches, rivets, drip streaks ──
function drawHullStruct(cx, sx1, sy1, sw, sh, seed) {
    var g = cx.createLinearGradient(sx1, sy1, sx1, sy1 + sh);
    g.addColorStop(0, '#687888'); g.addColorStop(0.5, '#556677'); g.addColorStop(1, '#2e3c48');
    cx.fillStyle = g;
    cx.fillRect(sx1, sy1, sw, sh);
    cx.fillStyle = 'rgba(140,70,20,0.18)';
    var rp = Math.max(2, Math.floor(sw / 30));
    for (var r = 0; r < rp; r++) {
        cx.beginPath();
        cx.ellipse(sx1 + sRand(seed + r * 7.1) * sw, sy1 + sRand(seed + r * 11.3) * sh,
            8 + sRand(seed + r * 3.7) * 24, 4 + sRand(seed + r * 5.1) * 12,
            sRand(seed + r * 13) * Math.PI, 0, Math.PI * 2);
        cx.fill();
    }
    cx.fillStyle = 'rgba(180,200,210,0.3)';
    var rows = Math.max(1, Math.floor(sh / 20));
    for (var row = 1; row <= rows; row++) {
        var ry2 = sy1 + sh * row / (rows + 1);
        for (var rx2 = sx1 + 8; rx2 < sx1 + sw - 4; rx2 += 16) {
            cx.beginPath(); cx.arc(rx2, ry2, 1.5, 0, Math.PI * 2); cx.fill();
        }
    }
    cx.strokeStyle = 'rgba(140,60,10,0.22)'; cx.lineWidth = 1;
    var drips = Math.max(1, Math.floor(sw / 40));
    for (var d = 0; d < drips; d++) {
        var dx = sx1 + 8 + d * (sw - 16) / Math.max(1, drips - 1 || 1);
        var dy = sy1 + sh * 0.2;
        cx.beginPath();
        cx.moveTo(dx, dy);
        cx.lineTo(dx + (sRand(seed + d * 3) - 0.5) * 4, dy + sh * (0.2 + sRand(seed + d * 9) * 0.3));
        cx.stroke();
    }
    cx.strokeStyle = 'rgba(255,255,255,0.07)'; cx.lineWidth = 1;
    cx.strokeRect(sx1, sy1, sw, sh);
}

// ── Task 8: Deck — plank lines across top face ──────────────────
function drawDeckStruct(cx, sx1, sy1, sw, sh, seed) {
    var g = cx.createLinearGradient(sx1, sy1, sx1, sy1 + sh);
    g.addColorStop(0, '#506070'); g.addColorStop(1, '#2a3845');
    cx.fillStyle = g; cx.fillRect(sx1, sy1, sw, sh);
    cx.strokeStyle = 'rgba(0,0,0,0.3)'; cx.lineWidth = 1;
    var ps = Math.max(6, Math.floor(sh / 4));
    for (var py = sy1 + ps; py < sy1 + sh; py += ps) {
        cx.beginPath(); cx.moveTo(sx1, py); cx.lineTo(sx1 + sw, py); cx.stroke();
    }
    cx.fillStyle = 'rgba(120,60,10,0.12)';
    cx.beginPath();
    cx.ellipse(sx1 + sw * (0.3 + sRand(seed) * 0.4), sy1 + sh * 0.5,
        sw * 0.15 + 10, sh * 0.35, 0, 0, Math.PI * 2);
    cx.fill();
    cx.strokeStyle = 'rgba(255,255,255,0.06)'; cx.lineWidth = 1;
    cx.strokeRect(sx1, sy1, sw, sh);
}

// ── Task 8: Bulkhead — panel frame + portholes on wide sections ──
function drawBulkheadStruct(cx, sx1, sy1, sw, sh, seed) {
    var g = cx.createLinearGradient(sx1, sy1, sx1, sy1 + sh);
    g.addColorStop(0, '#5a6878'); g.addColorStop(1, '#2e3c4e');
    cx.fillStyle = g; cx.fillRect(sx1, sy1, sw, sh);
    var inset = Math.min(6, sw * 0.08, sh * 0.12);
    cx.strokeStyle = 'rgba(255,255,255,0.12)'; cx.lineWidth = 1.5;
    cx.strokeRect(sx1 + inset, sy1 + inset, sw - inset * 2, sh - inset * 2);
    if (sw > 60) {
        var pc = Math.floor(sw / 60);
        for (var p = 0; p < pc; p++) {
            var phx = sx1 + (p + 0.5) * (sw / pc);
            var phy = sy1 + sh * 0.4;
            var pr  = Math.min(sh * 0.18, 10);
            cx.fillStyle = 'rgba(10,30,50,0.85)';
            cx.beginPath(); cx.arc(phx, phy, pr, 0, Math.PI * 2); cx.fill();
            cx.strokeStyle = 'rgba(180,200,215,0.3)'; cx.lineWidth = 2;
            cx.stroke();
            cx.fillStyle = 'rgba(100,180,220,0.18)';
            cx.beginPath(); cx.arc(phx - pr * 0.3, phy - pr * 0.3, pr * 0.4, 0, Math.PI * 2); cx.fill();
        }
    }
    cx.fillStyle = 'rgba(130,65,15,0.15)';
    cx.beginPath();
    cx.ellipse(sx1 + sw * (0.6 + sRand(seed) * 0.2), sy1 + sh * 0.75,
        sw * 0.12, sh * 0.18, 0, 0, Math.PI * 2);
    cx.fill();
    cx.strokeStyle = 'rgba(255,255,255,0.06)'; cx.lineWidth = 1;
    cx.strokeRect(sx1, sy1, sw, sh);
}

// ============================================================
//  ZENOBIA-style ferry wreck — detail sprites
//  Each takes (cx, x, y) where y is the BOTTOM baseline of the
//  sprite (rests on the floor of its deck). Sizes are tuned to
//  the standard wreck mpp = 0.05 (1 m = 20 px) so 1 sprite-meter
//  matches 1 world-meter.
// ============================================================

// Crew bunk — stacked bed (upper + lower) with pillows + ladder
function drawBunk(cx, x, y) {
    cx.save();
    var w = 30, h = 24;
    var bx = x - w / 2, by = y - h;
    // posts
    cx.fillStyle = '#2a3038';
    cx.fillRect(bx - 1, by, 2, h);
    cx.fillRect(bx + w - 1, by, 2, h);
    // upper bunk
    cx.fillStyle = '#3a3528';
    cx.fillRect(bx, by + 2, w, 8);
    cx.fillStyle = 'rgba(180,170,140,0.55)';
    cx.fillRect(bx + 2, by + 3, 8, 5);
    cx.fillStyle = 'rgba(255,255,255,0.15)';
    cx.fillRect(bx, by + 2, w, 1);
    // lower bunk
    cx.fillStyle = '#3a3528';
    cx.fillRect(bx, by + h - 10, w, 8);
    cx.fillStyle = 'rgba(180,170,140,0.55)';
    cx.fillRect(bx + 2, by + h - 9, 8, 5);
    cx.fillStyle = 'rgba(255,255,255,0.15)';
    cx.fillRect(bx, by + h - 10, w, 1);
    // ladder rungs on the right post
    cx.strokeStyle = 'rgba(120,130,150,0.7)';
    cx.lineWidth = 0.7;
    for (var r = 0; r < 4; r++) {
        cx.beginPath();
        cx.moveTo(bx + w - 4, by + 4 + r * 4);
        cx.lineTo(bx + w + 1, by + 4 + r * 4);
        cx.stroke();
    }
    cx.restore();
}

// Intermodal shipping container — corrugated, end-door, rust streaks
function drawContainer(cx, x, y, color) {
    cx.save();
    var w = 88, h = 36;
    var bx = x - w / 2, by = y - h;
    var c = color || '#3a6a4a';
    cx.fillStyle = c;
    cx.fillRect(bx, by, w, h);
    // corrugation lines
    cx.strokeStyle = 'rgba(0,0,0,0.35)';
    cx.lineWidth = 0.7;
    for (var i = 1; i < 16; i++) {
        cx.beginPath();
        cx.moveTo(bx + i * (w / 16), by + 2);
        cx.lineTo(bx + i * (w / 16), by + h - 2);
        cx.stroke();
    }
    // corner castings
    cx.fillStyle = '#1a1a1a';
    cx.fillRect(bx, by, 5, 5);
    cx.fillRect(bx + w - 5, by, 5, 5);
    cx.fillRect(bx, by + h - 5, 5, 5);
    cx.fillRect(bx + w - 5, by + h - 5, 5, 5);
    // door panel + handle
    cx.strokeStyle = 'rgba(0,0,0,0.55)';
    cx.lineWidth = 0.8;
    cx.strokeRect(bx + w - 16, by + 2, 14, h - 4);
    cx.fillStyle = '#1a1a1a';
    cx.fillRect(bx + w - 4, by + h / 2 - 4, 2, 8);
    // rust streaks
    cx.fillStyle = 'rgba(110,40,15,0.5)';
    cx.fillRect(bx + w * 0.18, by, 2, h);
    cx.fillRect(bx + w * 0.58, by, 2, h);
    // algae top
    cx.fillStyle = 'rgba(80,100,50,0.65)';
    cx.fillRect(bx, by - 1, w, 2);
    cx.restore();
}

// Twin-cylinder diesel engine block — 6 cylinder heads, gauges, pipes
function drawEngine(cx, x, y) {
    cx.save();
    var w = 88, h = 64;
    var bx = x - w / 2, by = y - h;
    // base block
    cx.fillStyle = '#3a3a3a';
    cx.fillRect(bx, by + h * 0.45, w, h * 0.55);
    // brass top trim of block
    cx.fillStyle = 'rgba(160,120,60,0.7)';
    cx.fillRect(bx, by + h * 0.45, w, 2);
    // row of 6 cylinder heads + exhaust risers
    var cylW = (w * 0.84) / 6;
    for (var c = 0; c < 6; c++) {
        var cxl = bx + w * 0.08 + c * cylW;
        cx.fillStyle = '#1a1a1a';
        cx.fillRect(cxl, by + h * 0.25, cylW - 3, h * 0.22);
        // exhaust riser
        cx.fillRect(cxl + (cylW - 3) / 2 - 2, by, 4, h * 0.25);
        // brass valve cap
        cx.fillStyle = 'rgba(160,120,60,0.7)';
        cx.beginPath();
        cx.ellipse(cxl + (cylW - 3) / 2, by + 1, 3, 1.4, 0, 0, Math.PI * 2);
        cx.fill();
    }
    // gauges left + right
    cx.fillStyle = '#1a1a1a';
    cx.beginPath(); cx.arc(bx + 8, by + h * 0.72, 4, 0, Math.PI * 2); cx.fill();
    cx.beginPath(); cx.arc(bx + w - 8, by + h * 0.72, 4, 0, Math.PI * 2); cx.fill();
    cx.strokeStyle = 'rgba(160,120,60,0.7)';
    cx.lineWidth = 0.8;
    cx.beginPath(); cx.arc(bx + 8, by + h * 0.72, 4, 0, Math.PI * 2); cx.stroke();
    cx.beginPath(); cx.arc(bx + w - 8, by + h * 0.72, 4, 0, Math.PI * 2); cx.stroke();
    // side pipes
    cx.strokeStyle = 'rgba(160,120,60,0.6)';
    cx.lineWidth = 2;
    cx.beginPath();
    cx.moveTo(bx, by + h * 0.6); cx.lineTo(bx - 10, by + h * 0.6); cx.lineTo(bx - 10, by + h);
    cx.stroke();
    cx.beginPath();
    cx.moveTo(bx + w, by + h * 0.6); cx.lineTo(bx + w + 10, by + h * 0.6); cx.lineTo(bx + w + 10, by + h);
    cx.stroke();
    // brass nameplate
    cx.fillStyle = 'rgba(160,120,60,0.55)';
    cx.fillRect(bx + w * 0.35, by + h * 0.62, w * 0.3, h * 0.12);
    // algae top + rust below
    cx.fillStyle = 'rgba(80,100,50,0.6)';
    cx.fillRect(bx, by - 1, w, 2);
    cx.fillStyle = 'rgba(120,50,20,0.45)';
    cx.fillRect(bx + w * 0.2, by + h - 2, w * 0.6, 2);
    cx.restore();
}

// Mess hall table — long bench with cups + plates drifting on top
function drawMessTable(cx, x, y) {
    cx.save();
    var w = 56, h = 14;
    var bx = x - w / 2, by = y - h;
    // benches above + below the table
    cx.fillStyle = '#3a3528';
    cx.fillRect(bx - 3, by + 1, w + 6, 2.5);
    cx.fillRect(bx - 3, by + h - 3.5, w + 6, 2.5);
    // table top
    cx.fillStyle = '#7e7762';
    cx.fillRect(bx, by + 5, w, 4);
    cx.fillStyle = 'rgba(220,210,180,0.5)';
    cx.fillRect(bx, by + 5, w, 1);
    // cups + plates drifting on the table
    cx.fillStyle = 'rgba(200,190,160,0.65)';
    cx.beginPath(); cx.arc(bx + 10, by + 7, 1.8, 0, Math.PI * 2); cx.fill();
    cx.beginPath(); cx.arc(bx + 22, by + 7, 1.4, 0, Math.PI * 2); cx.fill();
    cx.beginPath(); cx.arc(bx + 34, by + 7, 1.6, 0, Math.PI * 2); cx.fill();
    cx.beginPath(); cx.arc(bx + 46, by + 7, 1.3, 0, Math.PI * 2); cx.fill();
    cx.restore();
}

// Bridge helm — ship's wheel + curved console + gauges
function drawHelm(cx, x, y) {
    cx.save();
    var w = 56, h = 40;
    var bx = x - w / 2, by = y - h;
    // curved console
    cx.fillStyle = '#7e7762';
    cx.beginPath();
    cx.moveTo(bx, by + h * 0.55);
    cx.quadraticCurveTo(x, by + h * 0.3, bx + w, by + h * 0.55);
    cx.lineTo(bx + w, by + h);
    cx.lineTo(bx, by + h);
    cx.closePath(); cx.fill();
    // brass trim line
    cx.strokeStyle = 'rgba(160,120,60,0.85)';
    cx.lineWidth = 1.4;
    cx.beginPath();
    cx.moveTo(bx, by + h * 0.55);
    cx.quadraticCurveTo(x, by + h * 0.3, bx + w, by + h * 0.55);
    cx.stroke();
    // helm wheel
    var wcy = by + h * 0.55;
    cx.lineWidth = 1.8;
    cx.beginPath(); cx.arc(x, wcy, 10, 0, Math.PI * 2); cx.stroke();
    // spokes
    for (var s = 0; s < 6; s++) {
        var a = s * Math.PI / 3;
        cx.beginPath();
        cx.moveTo(x, wcy);
        cx.lineTo(x + Math.cos(a) * 11, wcy + Math.sin(a) * 11);
        cx.stroke();
    }
    cx.fillStyle = 'rgba(160,120,60,0.95)';
    cx.beginPath(); cx.arc(x, wcy, 3.5, 0, Math.PI * 2); cx.fill();
    // gauges
    cx.fillStyle = '#1a1a1a';
    cx.beginPath(); cx.arc(bx + 9, by + h * 0.8, 3.5, 0, Math.PI * 2); cx.fill();
    cx.beginPath(); cx.arc(bx + w - 9, by + h * 0.8, 3.5, 0, Math.PI * 2); cx.fill();
    cx.strokeStyle = 'rgba(160,120,60,0.7)';
    cx.lineWidth = 0.7;
    cx.beginPath(); cx.arc(bx + 9, by + h * 0.8, 3.5, 0, Math.PI * 2); cx.stroke();
    cx.beginPath(); cx.arc(bx + w - 9, by + h * 0.8, 3.5, 0, Math.PI * 2); cx.stroke();
    cx.restore();
}

// Lifeboat in davits — orange covered capsule with portholes
function drawLifeboat(cx, x, y) {
    cx.save();
    var w = 56, h = 20;
    var bx = x - w / 2, by = y - h;
    // davit arms (cradle holding the boat)
    cx.strokeStyle = '#7e7762';
    cx.lineWidth = 1.5;
    cx.beginPath();
    cx.moveTo(bx + 4, by + h); cx.lineTo(bx, by - 10); cx.lineTo(bx + 10, by - 14);
    cx.stroke();
    cx.beginPath();
    cx.moveTo(bx + w - 4, by + h); cx.lineTo(bx + w, by - 10); cx.lineTo(bx + w - 10, by - 14);
    cx.stroke();
    // covered orange capsule
    cx.fillStyle = '#d97a1a';
    cx.beginPath();
    cx.moveTo(bx + 4, by + h);
    cx.quadraticCurveTo(bx - 2, by, bx + 10, by);
    cx.lineTo(bx + w - 10, by);
    cx.quadraticCurveTo(bx + w + 2, by, bx + w - 4, by + h);
    cx.closePath(); cx.fill();
    // hatch / topline
    cx.fillStyle = 'rgba(255,255,255,0.5)';
    cx.fillRect(bx + 8, by + 4, w - 16, 2);
    // portholes
    cx.fillStyle = '#0a141a';
    for (var p = 0; p < 4; p++) {
        cx.beginPath();
        cx.arc(bx + 10 + p * (w - 20) / 3, by + h * 0.55, 1.8, 0, Math.PI * 2);
        cx.fill();
    }
    // hull number
    cx.fillStyle = 'rgba(255,255,255,0.45)';
    cx.font = 'bold 5px monospace';
    cx.textAlign = 'center';
    cx.fillText('1', bx + w * 0.18, by + h * 0.95);
    cx.textAlign = 'left';
    cx.restore();
}

// Bow visor — hinged-up door at the forward vehicle-deck opening
function drawBowVisor(cx, x, y) {
    cx.save();
    cx.translate(x, y);
    cx.rotate(-Math.PI * 0.35);
    // door slab
    var g = cx.createLinearGradient(0, -10, 0, 10);
    g.addColorStop(0, '#7a8898');
    g.addColorStop(1, '#3a4858');
    cx.fillStyle = g;
    cx.fillRect(-36, -10, 72, 20);
    // plate seam
    cx.strokeStyle = 'rgba(0,0,0,0.45)';
    cx.lineWidth = 0.8;
    cx.beginPath();
    cx.moveTo(-36, 0); cx.lineTo(36, 0);
    cx.stroke();
    // rivets
    cx.fillStyle = 'rgba(15,15,15,0.65)';
    for (var rv = -30; rv <= 30; rv += 8) {
        cx.beginPath(); cx.arc(rv, -6, 0.8, 0, Math.PI * 2); cx.fill();
        cx.beginPath(); cx.arc(rv, 6, 0.8, 0, Math.PI * 2); cx.fill();
    }
    // anchor recess
    cx.fillStyle = '#0a0a0a';
    cx.beginPath(); cx.arc(-14, 0, 3.5, 0, Math.PI * 2); cx.fill();
    cx.fillRect(-18, -2, 8, 3);
    // hinge spindle
    cx.fillStyle = '#1a1a1a';
    cx.beginPath(); cx.arc(36, 0, 2.5, 0, Math.PI * 2); cx.fill();
    cx.restore();
}

// Rust hole — jagged dark opening in a hull plate with rust bleed below
function drawRustHole(cx, x, y) {
    cx.save();
    var w = 22, h = 16;
    // opening fill
    cx.fillStyle = '#0a0a0a';
    cx.beginPath();
    cx.moveTo(x - w / 2, y);
    cx.quadraticCurveTo(x - w * 0.35, y - h, x, y - h * 0.45);
    cx.quadraticCurveTo(x + w * 0.4, y - h * 0.3, x + w / 2, y);
    cx.quadraticCurveTo(x + w * 0.3, y + h * 0.9, x, y + h * 0.45);
    cx.quadraticCurveTo(x - w * 0.4, y + h, x - w / 2, y);
    cx.closePath(); cx.fill();
    // rust ring
    cx.strokeStyle = 'rgba(140,55,20,0.9)';
    cx.lineWidth = 1.6;
    cx.stroke();
    // rust streak below
    var grad = cx.createLinearGradient(x, y, x, y + 36);
    grad.addColorStop(0, 'rgba(90,30,12,0.7)');
    grad.addColorStop(1, 'rgba(90,30,12,0)');
    cx.fillStyle = grad;
    cx.fillRect(x - w * 0.4, y + h * 0.35, w * 0.8, 36);
    cx.restore();
}

// ---- Structure-kind drawers (replace plain hull for ferry chrome) ----

// Funnel — trapezoid stack, ship's-livery red band, cap.
function drawFunnelStruct(cx, sx1, sy1, sw, sh) {
    cx.save();
    // stack body
    cx.fillStyle = '#b8b09a';
    cx.beginPath();
    cx.moveTo(sx1 + sw * 0.05, sy1);
    cx.lineTo(sx1 + sw * 0.95, sy1);
    cx.lineTo(sx1 + sw, sy1 + sh);
    cx.lineTo(sx1, sy1 + sh);
    cx.closePath(); cx.fill();
    // shade right
    cx.fillStyle = 'rgba(0,0,0,0.18)';
    cx.beginPath();
    cx.moveTo(sx1 + sw * 0.6, sy1);
    cx.lineTo(sx1 + sw * 0.95, sy1);
    cx.lineTo(sx1 + sw, sy1 + sh);
    cx.lineTo(sx1 + sw * 0.7, sy1 + sh);
    cx.closePath(); cx.fill();
    // red livery band
    var bandTop = sy1 + sh * 0.25;
    var bandBot = sy1 + sh * 0.6;
    cx.fillStyle = '#a04030';
    cx.fillRect(sx1 + sw * 0.05, bandTop, sw * 0.9, bandBot - bandTop);
    cx.fillStyle = 'rgba(255,255,255,0.5)';
    cx.fillRect(sx1 + sw * 0.05, bandTop, sw * 0.9, 1.5);
    cx.fillStyle = 'rgba(0,0,0,0.45)';
    cx.fillRect(sx1 + sw * 0.05, bandBot - 1.5, sw * 0.9, 1.5);
    // livery logo — white disc with letter
    var lx = sx1 + sw / 2, ly = (bandTop + bandBot) / 2;
    var lr = Math.min(sw, sh) * 0.13;
    cx.fillStyle = 'rgba(255,255,255,0.7)';
    cx.beginPath(); cx.arc(lx, ly, lr, 0, Math.PI * 2); cx.fill();
    cx.fillStyle = '#a04030';
    cx.font = 'bold ' + Math.floor(lr * 1.4) + 'px monospace';
    cx.textAlign = 'center'; cx.textBaseline = 'middle';
    cx.fillText('Z', lx, ly + 0.5);
    cx.textBaseline = 'alphabetic'; cx.textAlign = 'left';
    // cap rim + black exhaust opening
    cx.fillStyle = '#3a3528';
    cx.fillRect(sx1, sy1, sw, 4);
    cx.fillStyle = '#0a0a0a';
    cx.fillRect(sx1 + 4, sy1 + 1, sw - 8, 2.5);
    // algae bleed at the base
    cx.fillStyle = 'rgba(80,100,50,0.55)';
    cx.fillRect(sx1 + sw * 0.08, sy1 + sh * 0.7, 3, sh * 0.3);
    cx.fillRect(sx1 + sw * 0.78, sy1 + sh * 0.65, 3, sh * 0.35);
    cx.restore();
}

// Mast — pole + yard arm + crow's nest + radar
function drawMastStruct(cx, sx1, sy1, sw, sh) {
    cx.save();
    var midX = sx1 + sw / 2;
    // pole
    cx.strokeStyle = '#3a3528';
    cx.lineWidth = Math.max(2, sw);
    cx.beginPath(); cx.moveTo(midX, sy1); cx.lineTo(midX, sy1 + sh); cx.stroke();
    cx.strokeStyle = 'rgba(255,255,255,0.25)';
    cx.lineWidth = 0.7;
    cx.beginPath(); cx.moveTo(midX - 0.5, sy1); cx.lineTo(midX - 0.5, sy1 + sh); cx.stroke();
    // yard
    cx.strokeStyle = '#3a3528';
    cx.lineWidth = 2;
    var yardY = sy1 + sh * 0.42;
    cx.beginPath(); cx.moveTo(midX - 24, yardY); cx.lineTo(midX + 24, yardY); cx.stroke();
    // navigation lights at yard tips
    cx.fillStyle = '#3a6a3a';
    cx.beginPath(); cx.arc(midX + 24, yardY, 2, 0, Math.PI * 2); cx.fill();
    cx.fillStyle = '#6a3a3a';
    cx.beginPath(); cx.arc(midX - 24, yardY, 2, 0, Math.PI * 2); cx.fill();
    // crow's nest
    var nestY = sy1 + sh * 0.3;
    cx.fillStyle = '#7e7762';
    cx.fillRect(midX - 9, nestY, 18, 11);
    cx.fillStyle = '#b8b09a';
    cx.fillRect(midX - 9, nestY, 18, 2);
    cx.fillStyle = '#0a141a';
    cx.fillRect(midX - 6, nestY + 4, 12, 5);
    // radar dish at top
    cx.fillStyle = '#3a3528';
    cx.fillRect(midX - 1.5, sy1 - 8, 3, 8);
    cx.beginPath();
    cx.ellipse(midX, sy1 - 8, 14, 3, 0, 0, Math.PI * 2);
    cx.fill();
    cx.fillStyle = 'rgba(255,255,255,0.2)';
    cx.beginPath();
    cx.ellipse(midX, sy1 - 9, 12, 1.5, 0, 0, Math.PI);
    cx.fill();
    cx.restore();
}

// Cenote halocline — the soft, blurry shimmer where fresh water floats on
// salt. Rendered as a wide, very faint mixing band at ~7 m with a couple of
// gentle drifting shimmer lines, rather than a hard silver seam.
function drawHalocline(cx, W, H, dsy, mpp) {
    var hd = 7;  // halocline depth in metres
    var hy = dsy + (hd - depth) / mpp;
    if (hy < -24 || hy > H + 24) return;
    cx.save();
    // Wide, low-opacity mixing haze — the out-of-focus blur of two fluids.
    var band = 20;
    var hg = cx.createLinearGradient(0, hy - band, 0, hy + band);
    hg.addColorStop(0,    'rgba(196,226,220,0)');
    hg.addColorStop(0.5,  'rgba(220,238,232,0.12)');
    hg.addColorStop(1,    'rgba(196,226,220,0)');
    cx.fillStyle = hg;
    cx.fillRect(0, hy - band, W, band * 2);
    // A couple of faint shimmer lines drifting through the band.
    cx.lineWidth = 1;
    for (var k = 0; k < 2; k++) {
        cx.strokeStyle = 'rgba(228,242,238,' + (0.10 - k * 0.04).toFixed(3) + ')';
        cx.beginPath();
        for (var x = 0; x <= W; x += 8) {
            var wob = Math.sin(x * 0.035 + waveTime * 0.5 + k * 1.7) * 2.4
                    + Math.sin(x * 0.11 + waveTime * 0.22) * 1.2
                    + (k - 0.5) * 5;
            if (x === 0) cx.moveTo(x, hy + wob);
            else cx.lineTo(x, hy + wob);
        }
        cx.stroke();
    }
    cx.restore();
}

function drawStructures() {
    var s = activeSite();
    if (!s || !s.structures.length) return;
    var W = canvas.width, H = canvas.height;
    var diverScreenX = W * 0.25, diverScreenY = H * 0.45, mpp = 0.05;
    var cx = ctx;
    for (var i = 0; i < s.structures.length; i++) {
        var w = s.structures[i];
        var sx1 = diverScreenX + (w.x1 - diverX) / mpp;
        var sx2 = diverScreenX + (w.x2 - diverX) / mpp;
        var sy1 = diverScreenY + (w.dTop - depth) / mpp;
        var sy2 = diverScreenY + (w.dBottom - depth) / mpp;
        if (sx2 < -10 || sx1 > W + 10 || sy2 < -10 || sy1 > H + 10) continue;
        var sw = sx2 - sx1, sh = sy2 - sy1;
        var seed = w.x1 * 17.3 + w.dTop * 31.7;
        var rockTone = null;
        if (s.id === 'reef') rockTone = 'reef';
        else if (s.id === 'shore') rockTone = 'shore';
        else if (s.id === 'cave') rockTone = (w.dTop >= 16) ? 'caveGrey' : 'caveBrown';
        switch (w.kind) {
            case 'rock': case 'pillar':
                drawRockStruct(cx, sx1, sy1, sw, sh, seed, rockTone); break;
            case 'bedrock':
                drawBedrockStruct(cx, w.x1, w.x2, w.dTop, w.dBottom); break;
            case 'wreckSmall':
                drawSmallWreck(cx, sx1, sy1, sw, sh); break;
            case 'hull':
                drawHullStruct(cx, sx1, sy1, sw, sh, seed); break;
            case 'deck':
                drawDeckStruct(cx, sx1, sy1, sw, sh, seed); break;
            case 'bulkhead':
                drawBulkheadStruct(cx, sx1, sy1, sw, sh, seed); break;
            case 'funnel':
                drawFunnelStruct(cx, sx1, sy1, sw, sh); break;
            case 'mast':
                drawMastStruct(cx, sx1, sy1, sw, sh); break;
            default:
                cx.fillStyle = '#445566';
                cx.fillRect(sx1, sy1, sw, sh);
                cx.strokeStyle = 'rgba(255,255,255,0.08)';
                cx.lineWidth = 1;
                cx.strokeRect(sx1, sy1, sw, sh);
        }
    }
}

function drawFeatures() {
    var s = activeSite();
    if (!s || !s.features.length) return;
    var W = canvas.width, H = canvas.height;
    var diverScreenX = W * 0.25, diverScreenY = H * 0.45, mpp = 0.05;
    var cx = ctx;
    for (var i = 0; i < s.features.length; i++) {
        var f = s.features[i];
        var ffx = diverScreenX + ((f.x || 0) - diverX) / mpp;
        if (ffx < -200 || ffx > W + 200) continue;
        if (f.kind === 'seagrass') {
            var fgy = diverScreenY + ((f.d || 0) - depth) / mpp;
            if (fgy > -20 && fgy < H + 20) drawSeagrass(cx, ffx, fgy);
        } else if (f.kind === 'warningSign') {
            // Anchor the sign's base to the cave floor so it stands on the rock
            // instead of floating in the water column.
            var fwy = diverScreenY + (floorAt(f.x || 0) - depth) / mpp;
            if (fwy > -20 && fwy < H + 20) drawWarningSign(cx, ffx, fwy);
        } else if (f.kind === 'thermocline') {
            drawThermocline(cx, f.d || 0);
        } else if (f.kind === 'coral') {
            var fcy = diverScreenY + ((f.d || 0) - depth) / mpp;
            if (fcy > -20 && fcy < H + 20) { drawContactShadow(cx, ffx, fcy, 34, 8, 0.18); drawCoral(cx, ffx, fcy, (f.x || 0)); }
        } else if (f.kind === 'lorry') {
            var flY = diverScreenY + ((f.d || 0) - depth) / mpp;
            if (flY > -20 && flY < H + 20) { drawContactShadow(cx, ffx, flY, 138, 14, 0.26); drawVehicle(cx, ffx, flY, 'lorry', (f.x || 0)); }
        } else if (f.kind === 'car') {
            var fcaY = diverScreenY + ((f.d || 0) - depth) / mpp;
            if (fcaY > -20 && fcaY < H + 20) { drawContactShadow(cx, ffx, fcaY, 82, 10, 0.24); drawVehicle(cx, ffx, fcaY, 'car', (f.x || 0)); }
        } else if (f.kind === 'umbrella') {
            var fuy = diverScreenY + (floorAt(f.x || 0) - depth) / mpp;  // sand line
            if (fuy > -120 && fuy < H + 40) drawUmbrella(cx, ffx, fuy);
        } else if (f.kind === 'towel') {
            var fty = diverScreenY + (floorAt(f.x || 0) - depth) / mpp;  // sand line
            if (fty > -40 && fty < H + 40) drawTowel(cx, ffx, fty);
        } else if (f.kind === 'buoy') {
            var fbuoyY = diverScreenY - depth / mpp;  // surface line
            if (fbuoyY > -60 && fbuoyY < H + 20) drawBuoy(cx, ffx, fbuoyY);
        } else if (f.kind === 'anchor') {
            var faY = diverScreenY + (floorAt(f.x || 0) - depth) / mpp;  // sand line
            // Larger anchors (e.g. the wreck's bow anchor) cull from higher up.
            var aMargin = 40 + (f.scale ? f.scale * 60 : 0);
            if (faY > -aMargin && faY < H + 40) { drawContactShadow(cx, ffx, faY, 46 * (f.scale || 1), 8 * (f.scale || 1), 0.22); drawAnchor(cx, ffx, faY, (f.x || 0), f.scale); }
        } else if (f.kind === 'pond') {
            var fpY = diverScreenY - depth / mpp;
            if (fpY > -60 && fpY < H + 20) drawPond(cx, ffx, fpY);
        } else if (f.kind === 'tableCoral') {
            var ty = diverScreenY + ((f.d || 0) - depth) / mpp;
            if (ty > -40 && ty < H + 40) { drawContactShadow(cx, ffx, ty, 72, 9, 0.18); drawTableCoral(cx, ffx, ty); }
        } else if (f.kind === 'brainCoral') {
            var by2 = diverScreenY + ((f.d || 0) - depth) / mpp;
            if (by2 > -40 && by2 < H + 40) { drawContactShadow(cx, ffx, by2, 56, 8, 0.18); drawBrainCoral(cx, ffx, by2, (f.x || 0)); }
        } else if (f.kind === 'staghorn') {
            var sy = diverScreenY + ((f.d || 0) - depth) / mpp;
            if (sy > -40 && sy < H + 40) { drawContactShadow(cx, ffx, sy, 48, 7, 0.16); drawStaghorn(cx, ffx, sy, (f.x || 0)); }
        } else if (f.kind === 'softCoral') {
            var scy = diverScreenY + ((f.d || 0) - depth) / mpp;
            if (scy > -90 && scy < H + 40) { drawContactShadow(cx, ffx, scy, 42, 8, 0.14); drawSoftCoral(cx, ffx, scy, f.color); }
        } else if (f.kind === 'gorgonian') {
            var gy = diverScreenY + ((f.d || 0) - depth) / mpp;
            if (gy > -160 && gy < H + 160) { drawContactShadow(cx, ffx, gy, 44, 9, 0.15); drawGorgonian(cx, ffx, gy, f.side, f.color); }
        } else if (f.kind === 'barrelSponge') {
            var bsy = diverScreenY + ((f.d || 0) - depth) / mpp;
            if (bsy > -80 && bsy < H + 40) { drawContactShadow(cx, ffx, bsy, 42, 9, 0.17); drawBarrelSponge(cx, ffx, bsy, f.color); }
        } else if (f.kind === 'anthiasCloud') {
            var acy = diverScreenY + ((f.d || 0) - depth) / mpp;
            if (acy > -200 && acy < H + 200) drawAnthiasCloud(cx, ffx, acy, f);
        } else if (f.kind === 'bunk') {
            var fby = diverScreenY + ((f.d || 0) - depth) / mpp;
            if (fby > -40 && fby < H + 40) { drawContactShadow(cx, ffx, fby, 48, 7, 0.18); drawBunk(cx, ffx, fby); }
        } else if (f.kind === 'container') {
            var fcoy = diverScreenY + ((f.d || 0) - depth) / mpp;
            if (fcoy > -60 && fcoy < H + 60) { drawContactShadow(cx, ffx, fcoy, 96, 10, 0.22); drawContainer(cx, ffx, fcoy, f.color); }
        } else if (f.kind === 'engine') {
            var fegy = diverScreenY + ((f.d || 0) - depth) / mpp;
            if (fegy > -80 && fegy < H + 80) { drawContactShadow(cx, ffx, fegy, 78, 10, 0.24); drawEngine(cx, ffx, fegy); }
        } else if (f.kind === 'messTable') {
            var fmy = diverScreenY + ((f.d || 0) - depth) / mpp;
            if (fmy > -30 && fmy < H + 30) drawMessTable(cx, ffx, fmy);
        } else if (f.kind === 'helm') {
            var fhy = diverScreenY + ((f.d || 0) - depth) / mpp;
            if (fhy > -60 && fhy < H + 60) drawHelm(cx, ffx, fhy);
        } else if (f.kind === 'lifeboat') {
            var flby = diverScreenY + ((f.d || 0) - depth) / mpp;
            if (flby > -40 && flby < H + 40) drawLifeboat(cx, ffx, flby);
        } else if (f.kind === 'bowVisor') {
            var fbvy = diverScreenY + ((f.d || 0) - depth) / mpp;
            if (fbvy > -60 && fbvy < H + 60) drawBowVisor(cx, ffx, fbvy);
        } else if (f.kind === 'rustHole') {
            var fry = diverScreenY + ((f.d || 0) - depth) / mpp;
            if (fry > -30 && fry < H + 30) drawRustHole(cx, ffx, fry);
        }
    }
}

function drawContactShadow(cx, x, y, w, h, alpha) {
    cx.save();
    var grad = cx.createRadialGradient(x, y, 1, x, y, Math.max(w * 0.55, h));
    grad.addColorStop(0, 'rgba(0,0,0,' + (alpha || 0.18).toFixed(3) + ')');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    cx.fillStyle = grad;
    cx.beginPath();
    cx.ellipse(x, y + 1, w * 0.55, h, 0, 0, Math.PI * 2);
    cx.fill();
    cx.restore();
}

// Beach towel — striped mat lying flat on the sand.
function drawTowel(cx, x, y) {
    cx.save();
    var w = 26, h = 7;
    cx.translate(x, y - 1);
    cx.rotate(-0.05);
    // mat base
    cx.fillStyle = '#e8e2d0';
    cx.fillRect(-w / 2, -h, w, h);
    // stripes
    var stripes = ['#e44', '#49c', '#fc3', '#4a4'];
    for (var i = 0; i < 5; i++) {
        cx.fillStyle = stripes[i % stripes.length];
        cx.fillRect(-w / 2 + 2 + i * (w - 4) / 5, -h + 1, (w - 4) / 5 - 1, h - 2);
    }
    cx.strokeStyle = 'rgba(0,0,0,0.2)'; cx.lineWidth = 1;
    cx.strokeRect(-w / 2, -h, w, h);
    cx.restore();
}

// Beach parasol — pole with a scalloped red/white canopy.
function drawUmbrella(cx, x, y) {
    cx.save();
    cx.translate(x, y);
    // pole
    cx.strokeStyle = '#8a6a3a'; cx.lineWidth = 2.5; cx.lineCap = 'round';
    cx.beginPath(); cx.moveTo(0, 0); cx.lineTo(-6, -46); cx.stroke();
    // canopy — scalloped dome, alternating red / white wedges
    var cxn = -6, cyn = -46, rad = 26, segs = 6;
    for (var i = 0; i < segs; i++) {
        var a0 = Math.PI + i * (Math.PI / segs);
        var a1 = Math.PI + (i + 1) * (Math.PI / segs);
        cx.fillStyle = (i % 2 === 0) ? '#e23b3b' : '#f4f4f4';
        cx.beginPath();
        cx.moveTo(cxn, cyn);
        cx.arc(cxn, cyn, rad, a0, a1);
        cx.closePath();
        cx.fill();
    }
    // scalloped lower rim
    cx.fillStyle = 'rgba(0,0,0,0.12)';
    for (var s = 0; s < segs; s++) {
        var mx = cxn + Math.cos(Math.PI + (s + 0.5) * (Math.PI / segs)) * rad;
        cx.beginPath(); cx.arc(mx, cyn, 3, 0, Math.PI); cx.fill();
    }
    // finial
    cx.fillStyle = '#8a6a3a';
    cx.beginPath(); cx.arc(cxn, cyn - 2, 2.5, 0, Math.PI * 2); cx.fill();
    cx.restore();
}

function drawSeagrass(cx, x, y) {
    cx.save();
    cx.strokeStyle = '#2d6a2d';
    cx.lineWidth = 2;
    for (var i = -2; i <= 2; i++) {
        var bx = x + i * 6;
        cx.beginPath();
        cx.moveTo(bx, y);
        cx.quadraticCurveTo(bx + 3, y - 12, bx + (i % 2 === 0 ? 2 : -2), y - 22);
        cx.stroke();
    }
    cx.restore();
}

// Set a centred font that is guaranteed to fit `maxW`, shrinking the size
// only if the natural width would overflow. Keeps sign text legible AND
// inside its plaque at any zoom.
function setFittedFont(cx, text, maxW, px, weight) {
    var suffix = 'px "Barlow Semi Condensed", sans-serif';
    cx.font = (weight ? weight + ' ' : '') + px + suffix;
    var w = cx.measureText(text).width;
    if (w > maxW) {
        px = px * maxW / w;
        cx.font = (weight ? weight + ' ' : '') + px.toFixed(2) + suffix;
    }
}

// Cave warning sign — the classic "Grim Reaper" cave-diving sign: a yellow
// caution triangle with a skull, a red STOP banner, and a white plaque, all
// mounted on a post planted in a rock cairn at the cave mouth. Plaque text is
// auto-fitted so it never overflows the sign.
function drawWarningSign(cx, x, y) {
    cx.save();
    cx.textAlign = 'center';
    cx.lineJoin = 'round';

    // ── rock cairn base ──
    cx.fillStyle = CAVE_PAL.rockShade;
    cx.beginPath(); cx.ellipse(x, y, 22, 4, 0, 0, Math.PI * 2); cx.fill();
    cx.fillStyle = CAVE_PAL.rockWarm;
    cx.beginPath();
    cx.moveTo(x - 18, y);
    cx.quadraticCurveTo(x - 14, y - 9, x - 6, y - 10);
    cx.quadraticCurveTo(x + 8, y - 11, x + 16, y - 6);
    cx.quadraticCurveTo(x + 20, y - 1, x + 14, y);
    cx.closePath(); cx.fill();

    // ── metal post (behind the sign plates) ──
    cx.fillStyle = '#2a2620';
    cx.fillRect(x - 1.4, y - 52, 2.8, 52);
    cx.fillStyle = 'rgba(58,74,40,0.55)';   // algae on lower post
    cx.fillRect(x - 1.4, y - 16, 2.8, 12);

    // ── white plaque (bottom plate) ──
    var plX = x - 30, plW = 60, plY = y - 38, plH = 20;
    cx.fillStyle = CAVE_PAL.signWhite;
    cx.fillRect(plX, plY, plW, plH);
    cx.strokeStyle = CAVE_PAL.signBlack; cx.lineWidth = 0.9;
    cx.strokeRect(plX, plY, plW, plH);
    var pad = plW - 8;                       // usable text width
    cx.fillStyle = CAVE_PAL.signBlack;
    setFittedFont(cx, 'DIVERS HAVE DIED HERE', pad, 6, 'bold');
    cx.fillText('DIVERS HAVE DIED HERE', x, plY + 8.5);
    setFittedFont(cx, 'GO NO FARTHER', pad, 6, 'bold');
    cx.fillText('GO NO FARTHER', x, plY + 16);

    // ── red STOP banner (above the plaque) ──
    var sbX = x - 24, sbW = 48, sbY = y - 50, sbH = 11;
    cx.fillStyle = CAVE_PAL.signRed;
    cx.fillRect(sbX, sbY, sbW, sbH);
    cx.strokeStyle = CAVE_PAL.signBlack; cx.lineWidth = 1;
    cx.strokeRect(sbX, sbY, sbW, sbH);
    cx.fillStyle = CAVE_PAL.signWhite;
    setFittedFont(cx, 'STOP', sbW - 8, 8.5, 'bold');
    cx.fillText('STOP', x, sbY + 8.5);

    // ── yellow caution triangle with skull (top plate) ──
    var apexY = y - 90, baseY = y - 52, half = 24;
    cx.fillStyle = CAVE_PAL.signYellow;
    cx.strokeStyle = CAVE_PAL.signBlack; cx.lineWidth = 2.4;
    cx.beginPath();
    cx.moveTo(x, apexY);
    cx.lineTo(x + half, baseY);
    cx.lineTo(x - half, baseY);
    cx.closePath(); cx.fill(); cx.stroke();
    // inner rim
    cx.strokeStyle = 'rgba(10,10,10,0.5)'; cx.lineWidth = 0.9;
    cx.beginPath();
    cx.moveTo(x, apexY + 5);
    cx.lineTo(x + half - 5, baseY - 3);
    cx.lineTo(x - half + 5, baseY - 3);
    cx.closePath(); cx.stroke();

    // ── skull glyph centred in the triangle ──
    var sx = x, sy = y - 64;
    cx.fillStyle = CAVE_PAL.signBlack;
    cx.beginPath();
    cx.moveTo(sx - 6.4, sy - 1);
    cx.quadraticCurveTo(sx - 6.4, sy - 8.4, sx, sy - 8.4);
    cx.quadraticCurveTo(sx + 6.4, sy - 8.4, sx + 6.4, sy - 1);
    cx.lineTo(sx + 6.4, sy + 3.4);
    cx.quadraticCurveTo(sx + 6.2, sy + 5.8, sx + 4, sy + 6.2);
    cx.lineTo(sx - 4, sy + 6.2);
    cx.quadraticCurveTo(sx - 6.2, sy + 5.8, sx - 6.4, sy + 3.4);
    cx.closePath(); cx.fill();
    // eye sockets (cut the yellow back through)
    cx.fillStyle = CAVE_PAL.signYellow;
    cx.beginPath(); cx.ellipse(sx - 2.7, sy - 2, 1.5, 1.9, 0, 0, Math.PI * 2); cx.fill();
    cx.beginPath(); cx.ellipse(sx + 2.7, sy - 2, 1.5, 1.9, 0, 0, Math.PI * 2); cx.fill();
    // nasal triangle
    cx.beginPath();
    cx.moveTo(sx - 0.9, sy + 1.7); cx.lineTo(sx + 0.9, sy + 1.7); cx.lineTo(sx, sy + 3.4);
    cx.closePath(); cx.fill();
    // jaw teeth bar
    cx.fillStyle = CAVE_PAL.signBlack;
    cx.fillRect(sx - 4, sy + 6.8, 8, 1.9);
    cx.fillStyle = CAVE_PAL.signYellow;
    cx.fillRect(sx - 2.5, sy + 6.8, 0.6, 1.9);
    cx.fillRect(sx - 0.7, sy + 6.8, 0.6, 1.9);
    cx.fillRect(sx + 1.1, sy + 6.8, 0.6, 1.9);

    cx.textAlign = 'left';
    cx.restore();
}

function drawThermocline(cx, thd) {
    var W = canvas.width, H = canvas.height;
    var diverScreenY = H * 0.45, mpp = 0.05;
    var thy = diverScreenY + (thd - depth) / mpp;
    if (thy < -5 || thy > H + 5) return;
    cx.save();
    cx.strokeStyle = 'rgba(100,180,255,0.3)';
    cx.lineWidth = 3;
    cx.setLineDash([8, 4]);
    cx.beginPath();
    cx.moveTo(0, thy);
    cx.lineTo(W, thy);
    cx.stroke();
    cx.setLineDash([]);
    cx.restore();
}

// ── Reef redesign: dedicated coral / sponge / cloud drawers ──
// All read REEF_PAL (constants.js) and waveTime (state.js) from outer scope.

function drawTableCoral(cx, x, y) {
    cx.save();
    cx.translate(x, y);
    cx.lineCap = 'round';
    var w = 90, h = 22;
    // flat cap ellipse
    cx.fillStyle = REEF_PAL.tableCoral;
    cx.beginPath(); cx.ellipse(0, -h, w/2, h/2.2, 0, 0, Math.PI*2); cx.fill();
    // highlight
    cx.fillStyle = REEF_PAL.tableHi; cx.globalAlpha = 0.6;
    cx.beginPath(); cx.ellipse(0, -h-3, w/2-3, h/2.6, 0, 0, Math.PI*2); cx.fill();
    cx.globalAlpha = 1;
    // stalk
    cx.fillStyle = '#6a4a26';
    cx.fillRect(-5, -h, 10, h);
    // foot
    cx.globalAlpha = 0.7;
    cx.fillRect(-12, -h*0.4, 24, h*0.3);
    cx.globalAlpha = 1;
    cx.restore();
}

function drawBrainCoral(cx, x, y, seed) {
    cx.save();
    cx.translate(x, y);
    var w = 60;
    // outer ellipse
    cx.fillStyle = REEF_PAL.brainCoral;
    cx.beginPath(); cx.ellipse(0, 0, w/2, w/3.5, 0, 0, Math.PI*2); cx.fill();
    // highlight
    cx.fillStyle = REEF_PAL.brainHi; cx.globalAlpha = 0.6;
    cx.beginPath(); cx.ellipse(0, -4, w/2-4, w/4, 0, 0, Math.PI*2); cx.fill();
    cx.globalAlpha = 1;
    // gyri lines
    cx.strokeStyle = '#6a4a26'; cx.lineWidth = 0.9; cx.globalAlpha = 0.6;
    for (var i = 0; i < 7; i++) {
        var yo = -8 + i * 2.5;
        cx.beginPath();
        cx.moveTo(-w/2+5, yo);
        cx.quadraticCurveTo(-w/6, yo-3, 0, yo);
        cx.quadraticCurveTo(w/6, yo+3, w/3, yo);
        cx.stroke();
    }
    cx.globalAlpha = 1;
    cx.restore();
}

function drawStaghorn(cx, x, y, seed) {
    cx.save();
    cx.translate(x, y);
    cx.lineCap = 'round';
    var offsets = [-18, -8, 4, 14, 22];
    for (var i = 0; i < offsets.length; i++) {
        var ox = offsets[i];
        var curl = (i % 2 === 0) ? -4 : 4;
        var tipX = ox + (i % 2 === 0 ? -2 : 2);
        // antler branch
        cx.strokeStyle = REEF_PAL.staghorn; cx.lineWidth = 3;
        cx.beginPath(); cx.moveTo(ox, 0);
        cx.quadraticCurveTo(ox + curl, -22, tipX, -34);
        cx.stroke();
        // tip circle
        cx.fillStyle = REEF_PAL.staghorn;
        cx.beginPath(); cx.arc(tipX, -34, 3, 0, Math.PI*2); cx.fill();
        cx.fillStyle = '#fff'; cx.globalAlpha = 0.6;
        cx.beginPath(); cx.arc(tipX, -34, 1.4, 0, Math.PI*2); cx.fill();
        cx.globalAlpha = 1;
    }
    cx.restore();
}

function drawSoftCoral(cx, x, y, color) {
    cx.save();
    cx.translate(x, y);
    cx.lineCap = 'round';
    var col = color || REEF_PAL.softPink;
    var h = 70;
    var stalks = [-12, -2, 8, 16];
    for (var i = 0; i < stalks.length; i++) {
        var ox = stalks[i];
        cx.strokeStyle = col; cx.lineWidth = 5; cx.globalAlpha = 0.85;
        cx.beginPath(); cx.moveTo(ox, 0);
        cx.quadraticCurveTo(ox - 2, -h*0.5, ox, -h);
        cx.stroke();
        cx.globalAlpha = 1;
        // polyps
        var polyps = [0.3, 0.55, 0.8];
        for (var j = 0; j < polyps.length; j++) {
            var t = polyps[j];
            var py = -h * t;
            var pr = 2.2 + (1 - t) * 1.2;
            cx.fillStyle = col;
            cx.beginPath(); cx.arc(ox - 1, py, pr, 0, Math.PI*2); cx.fill();
            cx.strokeStyle = '#fff'; cx.lineWidth = 0.4; cx.globalAlpha = 0.6;
            cx.stroke();
            cx.globalAlpha = 1;
        }
    }
    cx.restore();
}

function drawGorgonian(cx, x, y, side, color) {
    cx.save();
    cx.translate(x, y);
    cx.lineCap = 'round';
    var col = color || REEF_PAL.gorgBright;
    var sign = (side === 'right') ? 1 : -1;
    var h = 140;
    // trunk — rises from wall anchor and curves outward
    cx.strokeStyle = col; cx.lineWidth = 4; cx.globalAlpha = 0.7;
    cx.beginPath(); cx.moveTo(0, 0);
    cx.quadraticCurveTo(sign * 18, -h * 0.35, sign * 28, -h * 0.65);
    cx.stroke();
    cx.globalAlpha = 1;
    // branches — fan from straight-up (t=0) to horizontal outward (t=1).
    // All branches point into open water (away from the wall) so they never
    // cross the rock face and appear to change shape as the camera scrolls.
    for (var i = 0; i < 14; i++) {
        var t = i / 13;
        // ang: 0 = vertical up, PI/2 = horizontal outward
        var ang = t * Math.PI * 0.5;
        var len = h * (0.55 + Math.sin(t * Math.PI) * 0.3);
        var x2 = sign * Math.sin(ang) * len * 0.75;
        var y2 = -Math.cos(ang) * len;
        cx.strokeStyle = col; cx.lineWidth = 2.2; cx.globalAlpha = 0.92;
        cx.beginPath(); cx.moveTo(0, 0);
        cx.quadraticCurveTo(sign * Math.sin(ang) * len * 0.25, -len * 0.5, x2, y2);
        cx.stroke();
        // twig
        cx.lineWidth = 1.1; cx.globalAlpha = 0.8;
        cx.beginPath(); cx.moveTo(x2 * 0.7, y2 * 0.7);
        cx.quadraticCurveTo(x2 * 0.7 + sign * 6, y2 * 0.7 - 4, x2 * 0.7 + sign * 14, y2 * 0.7 - 8);
        cx.stroke();
        cx.globalAlpha = 1;
    }
    cx.restore();
}

function drawBarrelSponge(cx, x, y, color) {
    cx.save();
    cx.translate(x, y);
    var col = color || REEF_PAL.barrel1;
    var w = 36, h = 60;
    // tapered barrel body
    cx.fillStyle = col;
    cx.beginPath();
    cx.moveTo(-w/2, 0);
    cx.quadraticCurveTo(-w/2, -h, w*0.1-w/2, -h);
    cx.lineTo(w/2 - w*0.1, -h);
    cx.quadraticCurveTo(w/2, -h, w/2, 0);
    cx.closePath();
    cx.fill();
    // dark mouth
    cx.fillStyle = '#1a0a04'; cx.globalAlpha = 0.7;
    cx.beginPath(); cx.ellipse(0, -h, w/2-2, 6, 0, 0, Math.PI*2); cx.fill();
    cx.globalAlpha = 1;
    cx.fillStyle = '#3a1a0c';
    cx.beginPath(); cx.ellipse(0, -h+1, w/2-5, 4, 0, 0, Math.PI*2); cx.fill();
    // ridges
    cx.strokeStyle = '#5a2818'; cx.lineWidth = 0.8;
    var ridges = [0.2, 0.45, 0.7];
    for (var i = 0; i < ridges.length; i++) {
        var ry = -h * ridges[i];
        cx.globalAlpha = 0.7;
        cx.beginPath(); cx.moveTo(-w/2+2, ry);
        cx.quadraticCurveTo(0, ry - 3, w-4-w/2+2, ry);
        cx.stroke();
    }
    cx.globalAlpha = 1;
    cx.restore();
}

function drawAnthiasCloud(cx, x, y, f) {
    cx.save();
    cx.translate(x, y);
    var count = f.count || 90;
    var w = f.w || 260;
    var h = f.h || 140;
    var dir = f.dir || 1;
    for (var i = 0; i < count; i++) {
        var u = Math.abs(Math.sin(i * 91.3) * 43758.5453) % 1;
        var v = Math.abs(Math.cos(i * 47.7) * 43758.5453) % 1;
        var fx = Math.pow(u, 1.3) * w * dir - w * dir * 0.5;
        var fy = (v - 0.5) * h + Math.sin(waveTime * 1.5 + i) * 1.5;
        var sz = 4 + (Math.sin(i * 13.1) * 0.5 + 0.5) * 4;
        var fishDir = Math.cos(i) > 0 ? 1 : -1;
        var alpha = sz < 5 ? 0.55 : 1.0;
        cx.save();
        cx.translate(fx, fy);
        cx.scale(fishDir, 1);
        cx.globalAlpha = alpha;
        // body — 3 stacked solid ellipses (cheaper than radial gradient)
        cx.fillStyle = REEF_PAL.anthiasCore;
        cx.beginPath(); cx.ellipse(0, 0, sz * 0.5, sz * 0.3, 0, 0, Math.PI*2); cx.fill();
        cx.fillStyle = REEF_PAL.anthias;
        cx.beginPath(); cx.ellipse(sz * 0.15, 0, sz * 0.7, sz * 0.45, 0, 0, Math.PI*2); cx.fill();
        cx.fillStyle = REEF_PAL.anthiasDeep;
        cx.beginPath(); cx.ellipse(-sz * 0.2, 0, sz * 0.35, sz * 0.25, 0, 0, Math.PI*2); cx.fill();
        // tail
        cx.fillStyle = REEF_PAL.anthias;
        cx.beginPath();
        cx.moveTo(-sz, 0); cx.lineTo(-sz*1.7, -sz*0.5); cx.lineTo(-sz*1.7, sz*0.5); cx.closePath(); cx.fill();
        // eye
        cx.fillStyle = '#0a0a0a';
        cx.beginPath(); cx.arc(sz * 0.55, -sz * 0.15, sz * 0.18, 0, Math.PI*2); cx.fill();
        // dorsal highlight
        cx.strokeStyle = REEF_PAL.anthiasLt; cx.lineWidth = 0.6;
        cx.beginPath(); cx.moveTo(-sz * 0.2, -sz * 0.55);
        cx.quadraticCurveTo(sz * 0.4, -sz * 0.5, sz * 0.7, -sz * 0.1); cx.stroke();
        cx.restore();
    }
    cx.restore();
}

// ── Task 9: Coral — varied species (branching / brain / fan / table / tube) ──
// worldSeed = stable world-x so the shape doesn't re-randomise while scrolling.
function drawCoral(cx, x, y, worldSeed) {
    cx.save();
    var seed = ((Math.floor((worldSeed || 0) * 7.3) % 100) + 100) % 100;
    var cols = ['#cc4433', '#cc6644', '#bb5588', '#dd7733', '#c84060',
                '#d98a2b', '#7a9b3c', '#b15fb0', '#e0a050'];
    var col = cols[seed % cols.length];
    var col2 = cols[(seed + 3) % cols.length];
    var species = seed % 5;
    cx.lineCap = 'round';

    if (species === 0) {
        // Branching (staghorn) — recursive forks with polyp tips
        cx.strokeStyle = col; cx.fillStyle = col;
        var branch = function(bx, by, angle, len, d) {
            if (d === 0 || len < 2) return;
            var ex = bx + Math.cos(angle) * len, ey = by + Math.sin(angle) * len;
            cx.lineWidth = d * 0.9;
            cx.beginPath(); cx.moveTo(bx, by); cx.lineTo(ex, ey); cx.stroke();
            if (d === 1) { cx.beginPath(); cx.arc(ex, ey, 2, 0, Math.PI * 2); cx.fill(); }
            var spread = 0.42 + sRand(seed + d * 7.3) * 0.2;
            branch(ex, ey, angle - spread, len * 0.62, d - 1);
            branch(ex, ey, angle + spread, len * 0.62, d - 1);
        };
        branch(x, y, -Math.PI / 2, 18 + sRand(seed) * 8, 4);
        branch(x + (sRand(seed + 1) * 16 - 8), y, -Math.PI / 2 + (sRand(seed + 2) * 0.6 - 0.3),
               12 + sRand(seed + 3) * 6, 3);
    } else if (species === 1) {
        // Brain coral — domed mound with winding grooves
        var br = 9 + sRand(seed) * 6;
        var bgr = cx.createRadialGradient(x - br * 0.3, y - br * 0.8, 1, x, y - br * 0.4, br * 1.4);
        bgr.addColorStop(0, col); bgr.addColorStop(1, col2);
        cx.fillStyle = bgr;
        cx.beginPath(); cx.arc(x, y, br, Math.PI, 0); cx.fill();
        cx.fillRect(x - br, y - 1, br * 2, 2);
        cx.strokeStyle = 'rgba(0,0,0,0.28)'; cx.lineWidth = 1;
        for (var g = -2; g <= 2; g++) {
            cx.beginPath();
            cx.arc(x + g * br * 0.32, y, br * (0.7 - Math.abs(g) * 0.12), Math.PI, 0);
            cx.stroke();
        }
    } else if (species === 2) {
        // Sea fan / gorgonian — flat fan of curved ribs
        cx.strokeStyle = col; cx.lineWidth = 1.6;
        var fh = 16 + sRand(seed) * 10, ribs = 7;
        for (var f = 0; f < ribs; f++) {
            var a = -Math.PI / 2 + (f - (ribs - 1) / 2) * 0.16;
            var ex2 = x + Math.cos(a) * fh, ey2 = y + Math.sin(a) * fh;
            cx.beginPath(); cx.moveTo(x, y);
            cx.quadraticCurveTo(x + Math.cos(a) * fh * 0.5 - 3, y + Math.sin(a) * fh * 0.5, ex2, ey2);
            cx.stroke();
        }
        // cross-weave
        cx.lineWidth = 0.8;
        for (var w2 = 0.4; w2 < 1; w2 += 0.3) {
            cx.beginPath(); cx.arc(x, y, fh * w2, -Math.PI * 0.78, -Math.PI * 0.22); cx.stroke();
        }
    } else if (species === 3) {
        // Table / plate coral — flat top on a short stalk
        cx.fillStyle = col;
        cx.fillRect(x - 2, y - 8, 4, 8);                 // stalk
        var tw = 13 + sRand(seed) * 7;
        cx.beginPath();
        cx.ellipse(x, y - 8, tw, 3.5, 0, 0, Math.PI * 2);
        cx.fill();
        cx.fillStyle = col2;
        cx.beginPath(); cx.ellipse(x, y - 9, tw * 0.8, 2, 0, 0, Math.PI * 2); cx.fill();
    } else {
        // Tube / barrel sponges — cluster of upright tubes
        var tubes = 3 + (seed % 3);
        for (var tb = 0; tb < tubes; tb++) {
            var tx = x + (tb - (tubes - 1) / 2) * 6;
            var th = 10 + sRand(seed + tb * 3.1) * 10;
            var tw2 = 3 + sRand(seed + tb) * 2;
            cx.fillStyle = tb % 2 ? col2 : col;
            cx.beginPath(); cx.roundRect(tx - tw2, y - th, tw2 * 2, th, [tw2, tw2, 0, 0]); cx.fill();
            cx.fillStyle = 'rgba(0,0,0,0.35)';
            cx.beginPath(); cx.ellipse(tx, y - th, tw2 * 0.7, 1.4, 0, 0, Math.PI * 2); cx.fill();
        }
    }
    cx.restore();
}

// ── Task 10: Vehicles — gradient body, windows, wheel arches, rust ──
// worldSeed = stable world-x so rust patches don't shimmer while scrolling.
function drawVehicle(cx, x, y, kind, worldSeed) {
    cx.save();
    var isLorry = kind === 'lorry';
    // Realistic footprints at mpp=0.05 (20 px/m): car ≈ 3.6 m long / 1.4 m body,
    // lorry ≈ 6.5 m long / 1.7 m box. y is the GROUND line — wheels rest on it.
    var bw = isLorry ? 130 : 72, bh = isLorry ? 34 : 22;
    var wheelR = isLorry ? 9 : 7;
    y = y - wheelR;                          // lift so the tyres sit on the floor
    var bx = x - bw / 2, by = y - bh;
    var seed = ((Math.floor((worldSeed || 0) * 5.1) % 80) + 80) % 80;
    // body
    var bg = cx.createLinearGradient(bx, by, bx, by + bh);
    bg.addColorStop(0, isLorry ? '#3e4a38' : '#3a3840');
    bg.addColorStop(0.5, isLorry ? '#2e3828' : '#2c2a32');
    bg.addColorStop(1, isLorry ? '#1e2418' : '#1c1a20');
    cx.fillStyle = bg;
    cx.beginPath(); cx.roundRect(bx, by, bw, bh, 2); cx.fill();
    if (isLorry) {
        var cabW = 36, cabH = 26;
        // load-bay ribs (box behind the cab)
        cx.strokeStyle = 'rgba(0,0,0,0.4)'; cx.lineWidth = 1.5;
        for (var r = 1; r < 7; r++) {
            var rx = bx + cabW + (bw - cabW) * r / 7;
            cx.beginPath(); cx.moveTo(rx, by + 1); cx.lineTo(rx, by + bh - 1); cx.stroke();
        }
        // cab
        var cabG = cx.createLinearGradient(bx, by - cabH, bx, by);
        cabG.addColorStop(0, '#353f2e'); cabG.addColorStop(1, '#232a1e');
        cx.fillStyle = cabG;
        cx.beginPath(); cx.roundRect(bx, by - cabH, cabW, cabH, [3, 3, 0, 0]); cx.fill();
        // cab window
        cx.fillStyle = 'rgba(20,50,70,0.88)';
        cx.beginPath(); cx.roundRect(bx + 3, by - cabH + 3, cabW - 9, cabH * 0.5, 1.5); cx.fill();
        cx.fillStyle = 'rgba(180,240,255,0.12)';
        cx.beginPath(); cx.roundRect(bx + 4, by - cabH + 4, 9, 4, 0.5); cx.fill();
        // headlight
        cx.fillStyle = 'rgba(120,140,90,0.8)';
        cx.beginPath(); cx.ellipse(bx + 4, by - 5, 3, 2.4, 0, 0, Math.PI * 2); cx.fill();
    } else {
        // car roof / greenhouse
        var roofW = bw * 0.62, roofX = x - roofW / 2, roofH = bh * 0.85;
        var roofG = cx.createLinearGradient(roofX, by - roofH, roofX, by);
        roofG.addColorStop(0, '#302e38'); roofG.addColorStop(1, '#222028');
        cx.fillStyle = roofG;
        cx.beginPath(); cx.roundRect(roofX, by - roofH, roofW, roofH, [4, 4, 0, 0]); cx.fill();
        // side windows
        cx.fillStyle = 'rgba(20,50,70,0.9)';
        cx.beginPath(); cx.roundRect(roofX + 2, by - roofH + 2, roofW / 2 - 3, roofH - 4, 1); cx.fill();
        cx.beginPath(); cx.roundRect(roofX + roofW / 2 + 1, by - roofH + 2, roofW / 2 - 3, roofH - 4, 1); cx.fill();
        cx.fillStyle = 'rgba(180,240,255,0.10)';
        cx.fillRect(roofX + 3, by - roofH + 3, 4, 2);
    }
    // rust patches
    cx.fillStyle = 'rgba(150,70,10,0.2)';
    cx.beginPath(); cx.ellipse(bx + bw * 0.3, by + bh * 0.6, bw * 0.1, bh * 0.3, 0, 0, Math.PI * 2); cx.fill();
    cx.beginPath(); cx.ellipse(bx + bw * 0.75, by + bh * 0.4, bw * 0.07 + sRand(seed) * 5, bh * 0.25, 0, 0, Math.PI * 2); cx.fill();
    // wheels (lorry gets a rear bogie)
    var wheels = isLorry ? [bx + 26, bx + bw * 0.6, bx + bw - 20] : [bx + 16, bx + bw - 16];
    for (var wi = 0; wi < wheels.length; wi++) {
        cx.fillStyle = 'rgba(0,0,0,0.65)';
        cx.beginPath(); cx.arc(wheels[wi], y, wheelR + 1, Math.PI, 0); cx.fill();
        cx.fillStyle = '#1a1a1a';
        cx.beginPath(); cx.arc(wheels[wi], y, wheelR, 0, Math.PI * 2); cx.fill();
        cx.strokeStyle = 'rgba(160,170,180,0.35)'; cx.lineWidth = 1.5;
        cx.beginPath(); cx.arc(wheels[wi], y, wheelR, 0, Math.PI * 2); cx.stroke();
        cx.fillStyle = 'rgba(160,170,180,0.4)';
        cx.beginPath(); cx.arc(wheels[wi], y, wheelR * 0.35, 0, Math.PI * 2); cx.fill();
    }
    cx.restore();
}

function drawBuoy(cx, x, y) {
    // SMB buoy + mooring line
    cx.save();
    cx.strokeStyle = 'rgba(255,200,100,0.5)';
    cx.lineWidth = 1;
    cx.setLineDash([3, 3]);
    cx.beginPath();
    cx.moveTo(x, y);
    cx.lineTo(x, y + 30);
    cx.stroke();
    cx.setLineDash([]);
    cx.fillStyle = '#ff6600';
    cx.beginPath();
    cx.ellipse(x, y - 8, 7, 10, 0, 0, Math.PI * 2);
    cx.fill();
    cx.fillStyle = '#ffaa44';
    cx.beginPath();
    cx.ellipse(x, y - 11, 3, 4, 0, 0, Math.PI * 2);
    cx.fill();
    cx.restore();
}

function drawPond(cx, x, y) {
    // Cenote pond entrance — a sunlit shaft of warm light pouring through
    // the open sinkhole, with a rimmed water surface and root strands.
    cx.save();
    var W = canvas.width, H = canvas.height;
    var mpp = 0.05;
    var diverScreenY = H * 0.45;
    var floorD = floorAt(x ? (diverX + (x - W * 0.25) * mpp) : diverX);
    // sunbeam cone — narrows at surface, fans out as it descends
    var beamTop = y - 6;
    var beamBot = diverScreenY + (Math.min(floorD, depth + 22) - depth) / mpp;
    if (beamBot < H + 20 && beamBot > beamTop + 6) {
        var bg = cx.createLinearGradient(0, beamTop, 0, beamBot);
        bg.addColorStop(0,   'rgba(255,245,216,0.75)');
        bg.addColorStop(0.5, 'rgba(188,229,216,0.30)');
        bg.addColorStop(1,   'rgba(168,208,200,0)');
        cx.fillStyle = bg;
        cx.globalCompositeOperation = 'lighter';
        cx.beginPath();
        cx.moveTo(x - 30, beamTop);
        cx.lineTo(x + 30, beamTop);
        cx.lineTo(x + 80, beamBot);
        cx.lineTo(x - 80, beamBot);
        cx.closePath();
        cx.fill();
        // a few thin god-rays inside the cone
        cx.strokeStyle = 'rgba(255,245,216,0.32)';
        cx.lineWidth = 1.4;
        for (var ri = -2; ri <= 2; ri++) {
            cx.beginPath();
            cx.moveTo(x + ri * 10, beamTop);
            cx.lineTo(x + ri * 30, beamBot);
            cx.stroke();
        }
        cx.globalCompositeOperation = 'source-over';
    }
    // dark earth lip on either side of the pond opening (the karst rim)
    cx.fillStyle = CAVE_PAL.earth;
    cx.fillRect(x - 80, y - 2, 30, 6);
    cx.fillRect(x + 50, y - 2, 30, 6);
    // root strands dangling from the rim into the water
    cx.strokeStyle = '#1a1208';
    cx.lineWidth = 1.1;
    cx.lineCap = 'round';
    for (var ri2 = 0; ri2 < 5; ri2++) {
        var rsX = x + (ri2 - 2) * 16 + (ri2 % 2 ? 4 : -4);
        if (rsX > x - 28 && rsX < x + 28) continue;  // skip the open shaft
        cx.beginPath();
        cx.moveTo(rsX, y - 1);
        cx.quadraticCurveTo(rsX + 2, y + 14, rsX - 1, y + 28);
        cx.stroke();
    }
    // water-line ripples across the open part
    cx.strokeStyle = 'rgba(232,244,232,0.65)';
    cx.lineWidth = 1.4;
    cx.beginPath();
    cx.ellipse(x, y, 36, 4, 0, 0, Math.PI * 2);
    cx.stroke();
    cx.strokeStyle = 'rgba(232,244,232,0.3)';
    cx.beginPath();
    cx.ellipse(x, y + 2, 30, 3, 0, 0, Math.PI * 2);
    cx.stroke();
    // "SURFACE" label
    cx.font = 'bold 10px "Barlow Semi Condensed", sans-serif';
    cx.fillStyle = 'rgba(232,244,232,0.85)';
    cx.textAlign = 'center';
    cx.fillText('◆ SURFACE', x, y - 10);
    cx.textAlign = 'left';
    cx.restore();
}

function drawGuideline() {
    if (guidelineNodes.length < 2) return;
    var W = canvas.width, H = canvas.height;
    var diverScreenX = W * 0.25, diverScreenY = H * 0.45, mpp = 0.05;
    var cx = ctx;
    cx.save();
    cx.strokeStyle = 'rgba(255,230,130,0.75)';
    cx.lineWidth = 2;
    cx.beginPath();
    for (var gi = 0; gi < guidelineNodes.length; gi++) {
        var gn = guidelineNodes[gi];
        var gpx = diverScreenX + (gn.x - diverX) / mpp;
        var gpy = diverScreenY + (gn.d - depth) / mpp;
        if (gi === 0) cx.moveTo(gpx, gpy); else cx.lineTo(gpx, gpy);
    }
    cx.stroke();
    cx.restore();
}

function drawSiltAndTorch() {
    // Ease the darkness level toward its target so entering/leaving an
    // overhead environment fades gradually instead of snapping.
    var target = inOverhead ? 1 : 0;
    _torchDark += (target - _torchDark) * 0.06;
    if (_torchDark < 0.012 && target === 0) { _torchDark = 0; return; }

    // On the WRECK the solid steel hull skin already limits line-of-sight, so
    // no full-screen gloom overlay there.
    var s = activeSite();
    if (s && s.id === 'wreck') return;

    var W = canvas.width, H = canvas.height;
    var diverScreenX = W * 0.25, diverScreenY = H * 0.45, mpp = 0.05;
    var cx = ctx;

    // Cave gloom is a FLAT, uniform darkness — never a diver-centred vignette
    // (that read as an ugly dark "cloud" stuck to the diver). Torch OFF: the
    // cave is nearly pitch black. Torch ON: cut a bright cone of light around
    // the diver so the torch genuinely illuminates the passage.
    var baseDark = (torchOn ? 0.80 : 0.93) * _torchDark;
    cx.fillStyle = 'rgba(2,5,9,' + baseDark.toFixed(3) + ')';
    cx.fillRect(0, 0, W, H);

    if (torchOn) {
        var torchPx = TORCH_RADIUS_M / mpp;
        var effectiveR = torchPx * 1.7 * Math.max(0.3, visibility);
        var grad = cx.createRadialGradient(diverScreenX, diverScreenY, 0,
                                            diverScreenX, diverScreenY, effectiveR);
        grad.addColorStop(0,    'rgba(0,0,0,1)');     // fully clear at the diver
        grad.addColorStop(0.5,  'rgba(0,0,0,0.92)');
        grad.addColorStop(0.82, 'rgba(0,0,0,0.45)');
        grad.addColorStop(1,    'rgba(0,0,0,0)');     // back to full dark at the rim
        cx.globalCompositeOperation = 'destination-out';
        cx.fillStyle = grad;
        cx.fillRect(0, 0, W, H);
        cx.globalCompositeOperation = 'source-over';
        drawTorchGlowAndSparkles(cx, W, H, diverScreenX, diverScreenY, effectiveR);
    }
}

function drawTorchGlowAndSparkles(cx, W, H, diverScreenX, diverScreenY, effectiveR) {
    var s = activeSite();
    if (!s || s.id !== 'cave') return;
    cx.save();
    cx.globalCompositeOperation = 'lighter';
    var warm = cx.createRadialGradient(diverScreenX, diverScreenY, 0,
                                       diverScreenX, diverScreenY, effectiveR * 0.72);
    warm.addColorStop(0, 'rgba(255,220,150,0.10)');
    warm.addColorStop(0.45, 'rgba(120,180,190,0.045)');
    warm.addColorStop(1, 'rgba(80,130,170,0)');
    cx.fillStyle = warm;
    cx.fillRect(0, 0, W, H);

    cx.fillStyle = 'rgba(238,226,184,0.32)';
    for (var i = 0; i < 36; i++) {
        var seed = i * 23.7;
        var ang = sRand(seed) * Math.PI * 2;
        var rr = Math.pow(sRand(seed + 1), 0.65) * effectiveR * 0.85;
        var x = diverScreenX + Math.cos(ang) * rr + Math.sin(waveTime * 0.8 + i) * 2;
        var y = diverScreenY + Math.sin(ang) * rr;
        if (x < 0 || x > W || y < 0 || y > H) continue;
        var a = Math.max(0, 1 - rr / effectiveR);
        cx.globalAlpha = a * 0.85;
        cx.beginPath(); cx.arc(x, y, 0.7 + sRand(seed + 2) * 1.3, 0, Math.PI * 2); cx.fill();
    }
    cx.globalAlpha = 1;
    cx.restore();
}

// Reef ambient: blue-water haze fading toward the open-water screen edge.
function drawBlueHaze() {
    var s = activeSite();
    if (!s || s.id !== 'reef') return;
    var W = canvas.width, H = canvas.height;
    var cx = ctx;
    // open water is on the side away from the wall (wall at x=0)
    var hazeOnLeft = diverX > 0;
    var hazeW = 180;
    var grad = cx.createLinearGradient(hazeOnLeft ? 0 : W, 0, hazeOnLeft ? hazeW : W - hazeW, 0);
    grad.addColorStop(0, 'rgba(6,40,66,0.5)');
    grad.addColorStop(1, 'rgba(6,40,66,0)');
    cx.fillStyle = grad;
    cx.fillRect(0, 0, W, H);
}

// Light shafts — additive beams from above marking deck-switch passages.
// On the wreck the beam only appears once the diver is inside the hull
// (faded in via the same "inside-ness" factor as the hull skin) — from open
// water it looked unnatural hanging in the blue.
function drawLightShafts() {
    var s = activeSite();
    if (!s || !s.features.length) return;
    var beamFade = (s.id === 'wreck') ? _wreckMetal : 1;
    if (beamFade < 0.02) return;
    var W = canvas.width, H = canvas.height;
    var diverScreenX = W * 0.25, diverScreenY = H * 0.45, mpp = 0.05;
    var cx = ctx;
    for (var i = 0; i < s.features.length; i++) {
        var f = s.features[i];
        if (f.kind !== 'lightShaft') continue;
        var sx = diverScreenX + ((f.x || 0) - diverX) / mpp;
        if (sx < -200 || sx > W + 200) continue;
        var topD = (f.d || 0) - 16;
        var botD = (f.d || 0) + 26;
        var topY = diverScreenY + (topD - depth) / mpp;
        var botY = diverScreenY + (botD - depth) / mpp;
        var topHalf = f.topHalf || 44, botHalf = f.botHalf || 92;   // beam widens as it falls
        var shaftAlpha = f.alpha || 0.72;
        cx.save();
        cx.globalCompositeOperation = 'lighter';
        cx.globalAlpha = beamFade * shaftAlpha;
        var beam = cx.createLinearGradient(0, topY, 0, botY);
        beam.addColorStop(0,   'rgba(150,210,255,0.22)');
        beam.addColorStop(0.5, 'rgba(140,200,250,0.10)');
        beam.addColorStop(1,   'rgba(130,190,245,0)');
        cx.fillStyle = beam;
        cx.beginPath();
        cx.moveTo(sx - topHalf, topY);
        cx.lineTo(sx + topHalf, topY);
        cx.lineTo(sx + botHalf, botY);
        cx.lineTo(sx - botHalf, botY);
        cx.closePath();
        cx.fill();
        // Soft floating motes drifting in the beam
        cx.fillStyle = 'rgba(210,235,255,0.35)';
        for (var m = 0; m < 5; m++) {
            var mt = ((waveTime * 0.15 + m * 0.21) % 1);
            var my = topY + (botY - topY) * mt;
            var mx = sx + Math.sin(waveTime * 0.6 + m * 2) * (topHalf * 0.5);
            cx.beginPath(); cx.arc(mx, my, 1.6, 0, Math.PI * 2); cx.fill();
        }
        cx.restore();
    }
}

// SECTION: Dive computer HUD overlay
// SEARCH TERMS: drawDiveComputer, NDL, ceiling, tissue bars, PO2, deco schedule, infoPageMode

// ============================================================
//  DIVE COMPUTER OVERLAY — WP-007: Dive computer UI redesign
// ============================================================

function drawDiveComputer() {
    var cx = ctx;
    var W = canvas.width;
    var dcScale = W < 400 ? 0.6 : W < 600 ? 0.75 : 1;
    var s = function(v) { return Math.round(v * dcScale); };
    var DCF = "'Barlow Semi Condensed', monospace";
    var dcW = s(380);
    var dcH = s(244); // Taller to fit the mode + battery top bar (dive-computer style)
    var dcX = W - dcW - 15;
    var dcY = 15;

    // --- Titanium bezel + LCD screen ---
    cx.save();
    var bezGrad = cx.createLinearGradient(dcX, dcY, dcX + dcW * 0.55, dcY + dcH);
    bezGrad.addColorStop(0, '#474c53');
    bezGrad.addColorStop(0.32, '#2b2f34');
    bezGrad.addColorStop(0.62, '#23262b');
    bezGrad.addColorStop(1, '#141619');
    cx.beginPath();
    cx.roundRect(dcX, dcY, dcW, dcH, s(14));
    cx.fillStyle = bezGrad;
    cx.fill();
    // side piezo buttons
    cx.fillStyle = '#363b41';
    var pbH2 = s(42), pbW2 = s(5), pbY2 = dcY + dcH / 2 - pbH2 / 2;
    cx.beginPath(); cx.roundRect(dcX - pbW2 + s(1), pbY2, pbW2, pbH2, s(2)); cx.fill();
    cx.beginPath(); cx.roundRect(dcX + dcW - s(1), pbY2, pbW2, pbH2, s(2)); cx.fill();
    // bevel highlight + outer shadow
    cx.lineWidth = 1;
    cx.strokeStyle = 'rgba(255,255,255,0.16)';
    cx.beginPath(); cx.roundRect(dcX + 0.5, dcY + 0.5, dcW - 1, dcH - 1, s(14)); cx.stroke();
    cx.strokeStyle = 'rgba(0,0,0,0.55)';
    cx.beginPath(); cx.roundRect(dcX, dcY, dcW, dcH, s(14)); cx.stroke();
    // LCD screen
    var scrX = dcX + s(5), scrY = dcY + s(5), scrW = dcW - s(10), scrH = dcH - s(10);
    var scrGrad = cx.createRadialGradient(scrX + scrW / 2, scrY - s(8), s(8), scrX + scrW / 2, scrY + scrH * 0.4, scrH);
    scrGrad.addColorStop(0, '#0d141a');
    scrGrad.addColorStop(0.65, '#06090d');
    scrGrad.addColorStop(1, '#040609');
    cx.beginPath(); cx.roundRect(scrX, scrY, scrW, scrH, s(9));
    cx.fillStyle = scrGrad; cx.fill();
    cx.strokeStyle = 'rgba(120,150,170,0.10)'; cx.lineWidth = 1; cx.stroke();
    // subtle top glass glare
    cx.save();
    cx.beginPath(); cx.roundRect(scrX, scrY, scrW, scrH, s(9)); cx.clip();
    var glare = cx.createLinearGradient(0, scrY, 0, scrY + scrH * 0.18);
    glare.addColorStop(0, 'rgba(255,255,255,0.05)');
    glare.addColorStop(1, 'rgba(255,255,255,0)');
    cx.fillStyle = glare; cx.fillRect(scrX, scrY, scrW, scrH * 0.18);
    cx.restore();

    // --- Layout constants ---
    var innerX = dcX + s(5);
    var innerY = dcY + s(5);
    var innerW = dcW - s(10);
    var innerH = dcH - s(10);
    var contentX = innerX;
    var contentW = innerW;

    // --- Data values ---
    var po2 = calculatePO2();
    var ndl = calculateNDL();
    var ceilDepth = calculateCeiling();
    var decoStopDepth = decoStop(ceilDepth);
    var avgDepthVal = avgDepthSamples > 0 ? avgDepthAccum / avgDepthSamples : 0;
    var tank = getActiveTank();
    var gtr = calculateGTR();
    var tBar = tankBar();
    var arRate = Math.abs(ascentRate);
    var inDeco = decoStopDepth > 0;
    var schedule = inDeco ? calculateDecoSchedule() : null;

    // --- Region Y positions ---
    var statusTop = innerY;
    var mainTop = statusTop + s(18);
    var mainH = s(90); // Further reduced height for more compact layout
    var warnBannerH = s(22);
    var bottomH = s(68);
    var bottomTop = innerY + innerH - bottomH;
    var warnBannerTop = bottomTop - warnBannerH - s(2);

    // Region widths
    var regionAW = Math.round(contentW * 0.50);
    var regionBW = contentW - regionAW - s(18);

    // ================================================================
    //  TOP BAR — mode chip (left) + battery (right)
    // ================================================================
    {
        var tbY = innerY + s(2);
        var chipH = s(15);
        var modeLabel = diveMode === 'ccr' ? (ccrState.onBailout ? 'BAIL' : 'CC\u00B7BO') : diveMode === 'tec' ? 'OC TEC' : 'REC';
        var modeTone = diveMode === 'ccr' ? (ccrState.onBailout ? '#ff4b4b' : '#34e6ff') : diveMode === 'tec' ? '#34e6ff' : '#46f08f';
        cx.font = 'bold ' + s(11) + "px " + DCF;
        cx.textAlign = 'left';
        var mlW = cx.measureText(modeLabel).width;
        var chipPadX = s(7);
        cx.strokeStyle = modeTone; cx.lineWidth = 1;
        cx.beginPath(); cx.roundRect(contentX + s(2), tbY, mlW + chipPadX * 2, chipH, s(4)); cx.stroke();
        cx.fillStyle = modeTone;
        cx.textBaseline = 'middle';
        cx.fillText(modeLabel, contentX + s(2) + chipPadX, tbY + chipH / 2 + s(1));
        cx.textBaseline = 'alphabetic';
        // Battery (cosmetic, ~full) — shown in the top bar
        var batW = s(22), batH = s(11);
        var batX = contentX + contentW - batW - s(7), batY = tbY + (chipH - batH) / 2;
        cx.strokeStyle = '#8694a1'; cx.lineWidth = 1;
        cx.beginPath(); cx.roundRect(batX, batY, batW, batH, s(2)); cx.stroke();
        cx.fillStyle = '#8694a1';
        cx.fillRect(batX + batW + s(1), batY + batH * 0.28, s(2), batH * 0.44);
        cx.fillStyle = '#46f08f';
        cx.fillRect(batX + s(1.5), batY + s(1.5), (batW - s(3)) * 0.82, batH - s(3));
        cx.textAlign = 'left';
    }

    // ================================================================
    //  REGION A — Basic Dive Info (left column)
    // ================================================================
    var rAX = contentX + s(6);
    var rATop = mainTop + s(4);

    // DEPTH (hero) — left-aligned with micro label (matches redesign mockup)
    cx.font = s(10) + "px " + DCF;
    cx.fillStyle = '#8694a1';
    cx.textAlign = 'left';
    cx.fillText('DEPTH', rAX, rATop + s(6));
    cx.font = 'bold ' + s(48) + "px " + DCF;
    cx.fillStyle = '#fff';
    var depthStr = depth.toFixed(1);
    cx.fillText(depthStr, rAX, rATop + s(46));
    var depthTextW = cx.measureText(depthStr).width;
    cx.font = s(18) + "px " + DCF;
    cx.fillStyle = '#a8b6cc';
    cx.fillText('m', rAX + depthTextW + s(3), rATop + s(46));

    // Chevron ascent indicator (right of Block 1.1)
    var chevX = contentX + regionAW - s(20);
    var chevTop = rATop + s(2);
    var chevW = s(10);
    var chevH = s(8);
    var chevGap = s(3);
    var numChevrons = Math.min(6, Math.max(0, Math.round(arRate / 3)));
    var chevColor = '#555';
    if (arRate > 18) chevColor = '#ff3333';
    else if (arRate > 9) chevColor = '#ffd24d';
    else if (arRate > 0.5) chevColor = '#fff';
    var flashChev = arRate > 18 && Math.floor(Date.now() / 300) % 2 === 0;

    var chevDescending = ascentRate < -0.5;
    for (var ci = 0; ci < 6; ci++) {
        var cy2 = chevTop + (5 - ci) * (chevH + chevGap);
        var isLit = ci < numChevrons;
        cx.beginPath();
        if (chevDescending) {
            // Point down when descending
            cx.moveTo(chevX, cy2);
            cx.lineTo(chevX + chevW / 2, cy2 + chevH);
            cx.lineTo(chevX + chevW, cy2);
        } else {
            // Point up when ascending
            cx.moveTo(chevX, cy2 + chevH);
            cx.lineTo(chevX + chevW / 2, cy2);
            cx.lineTo(chevX + chevW, cy2 + chevH);
        }
        cx.closePath();
        if (isLit && !flashChev) {
            cx.fillStyle = chevColor;
            cx.globalAlpha = 0.95;
        } else {
            cx.fillStyle = '#333';
            cx.globalAlpha = 0.25;
        }
        cx.fill();
        cx.globalAlpha = 1;
    }

    // Ascent rate text below chevrons
    if (arRate > 0.5) {
        cx.font = s(10) + "px " + DCF;
        cx.fillStyle = '#a8b6cc';
        cx.textAlign = 'center';
        var chevCenterX = chevX + chevW / 2;
        var chevBottomY = chevTop + 6 * (chevH + chevGap);
        cx.fillText(Math.round(arRate), chevCenterX, chevBottomY + s(10));
        cx.fillText('m/m', chevCenterX, chevBottomY + s(20));
        cx.textAlign = 'left';
    }

    // TIME (below depth) — left-aligned in Region A
    var timeTop = rATop + s(60);
    cx.font = s(14) + "px " + DCF;
    cx.fillStyle = '#8694a1';
    cx.textAlign = 'left';
    cx.fillText('TIME', rAX, timeTop);
    cx.font = 'bold ' + s(28) + "px " + DCF;
    cx.fillStyle = '#fff';
    cx.fillText(formatTime(diveTime), rAX, timeTop + s(26));

    // Vertical divider between Region A and Region B
    cx.strokeStyle = '#8694a1';
    cx.lineWidth = 1;
    cx.beginPath();
    cx.moveTo(contentX + regionAW, mainTop);
    cx.lineTo(contentX + regionAW, bottomTop - s(1));
    cx.stroke();

    // ================================================================
    //  REGION B — Decompression Info (right of Region A)
    // ================================================================
    var rBX = contentX + regionAW + s(4);
    var rBTop = mainTop + s(4);
    var rBW = regionBW;

    // --- Stop Box ---
    var stopBoxH = s(48);
    var showStopBox = inDeco || (safetyStopNeeded && !safetyStopComplete);

    if (showStopBox) {

        if (inDeco) {
            // DECO STOP title
            cx.font = s(14) + "px " + DCF;
            cx.fillStyle = '#ff4b4b';
            cx.textAlign = 'left';
            cx.fillText('DECO STOP', rBX + s(6), rBTop + s(12));
            // Stop depth + time
            cx.font = 'bold ' + s(28) + "px " + DCF;
            cx.fillStyle = '#fff';
            if (schedule && schedule.stops.length > 0) {
                // depth value + small 'm'
                cx.textAlign = 'left';
                var dsStr = String(schedule.stops[0].depth);
                cx.fillText(dsStr, rBX + s(6), rBTop + s(38));
                var dsW = cx.measureText(dsStr).width;
                cx.font = s(18) + "px " + DCF;
                cx.fillStyle = '#a8b6cc';
                cx.fillText('m', rBX + s(6) + dsW + s(2), rBTop + s(38));
                // time value + small 'min' — centered in right half of box
                cx.font = 'bold ' + s(28) + "px " + DCF;
                cx.fillStyle = '#fff';
                cx.font = s(18) + "px " + DCF;
                var dMinW = cx.measureText('min').width;
                cx.font = 'bold ' + s(28) + "px " + DCF;
                var dNumW = cx.measureText(String(schedule.stops[0].time)).width;
                var dGroupW = dNumW + s(3) + dMinW;
                var dGroupX = rBX + rBW * 0.60 - dGroupW / 2;
                cx.textAlign = 'left';
                cx.fillText(String(schedule.stops[0].time), dGroupX, rBTop + s(38));
                cx.font = s(18) + "px " + DCF;
                cx.fillStyle = '#a8b6cc';
                cx.fillText('min', dGroupX + dNumW + s(3), rBTop + s(38));
            }
        } else {
            // SAFETY STOP title
            cx.font = s(14) + "px " + DCF;
            cx.fillStyle = '#34e6ff';
            cx.textAlign = 'left';
            cx.fillText('SAFETY STOP', rBX + s(6), rBTop + s(12));
            cx.font = 'bold ' + s(28) + "px " + DCF;
            cx.fillStyle = '#fff';
            if (safetyStopCountdownStarted && !safetyStopComplete && !safetyStopPaused) {
                var ssMin = Math.floor(safetyStopRemaining / 60);
                var ssSec = Math.floor(safetyStopRemaining % 60);
                cx.fillStyle = '#46f08f';
                cx.fillText('5', rBX + s(6), rBTop + s(38));
                var ss5W = cx.measureText('5').width;
                cx.font = s(18) + "px " + DCF;
                cx.fillStyle = '#a8b6cc';
                cx.fillText('m', rBX + s(6) + ss5W + s(2), rBTop + s(38));
                cx.font = 'bold ' + s(28) + "px " + DCF;
                cx.textAlign = 'right';
                cx.fillText(ssMin + ':' + String(ssSec).padStart(2, '0'), rBX + rBW - s(6), rBTop + s(38));
                cx.textAlign = 'left';
            } else if (safetyStopCountdownStarted && !safetyStopComplete && safetyStopPaused) {
                var ssMin2 = Math.floor(safetyStopRemaining / 60);
                var ssSec2 = Math.floor(safetyStopRemaining % 60);
                cx.fillStyle = '#ffd24d';
                cx.fillText('5', rBX + s(6), rBTop + s(38));
                var ss5W2 = cx.measureText('5').width;
                cx.font = s(18) + "px " + DCF;
                cx.fillStyle = '#a8b6cc';
                cx.fillText('m', rBX + s(6) + ss5W2 + s(2), rBTop + s(38));
                cx.font = 'bold ' + s(28) + "px " + DCF;
                cx.textAlign = 'right';
                cx.fillText(ssMin2 + ':' + String(ssSec2).padStart(2, '0'), rBX + rBW - s(6), rBTop + s(38));
                cx.textAlign = 'left';
            } else {
                var ssDur = calculateSafetyStopDuration();
                var ssMinPlan = Math.floor(ssDur / 60);
                cx.fillStyle = '#ffd24d';
                cx.fillText('5', rBX + s(6), rBTop + s(38));
                var ss5W3 = cx.measureText('5').width;
                cx.font = s(18) + "px " + DCF;
                cx.fillStyle = '#a8b6cc';
                cx.fillText('m', rBX + s(6) + ss5W3 + s(2), rBTop + s(38));
                cx.font = 'bold ' + s(28) + "px " + DCF;
                cx.fillStyle = '#ffd24d';
                cx.font = s(18) + "px " + DCF;
                var spUnitW = cx.measureText('min').width;
                cx.font = 'bold ' + s(28) + "px " + DCF;
                var spNumW = cx.measureText(String(ssMinPlan)).width;
                var spGroupW = spNumW + s(3) + spUnitW;
                var spGroupX = rBX + rBW * 0.60 - spGroupW / 2;
                cx.fillStyle = '#ffd24d';
                cx.textAlign = 'left';
                cx.fillText(String(ssMinPlan), spGroupX, rBTop + s(38));
                cx.font = s(18) + "px " + DCF;
                cx.fillStyle = '#a8b6cc';
                cx.fillText('min', spGroupX + spNumW + s(3), rBTop + s(38));
            }
        }
    } else if (safetyStopComplete) {
        cx.font = s(14) + "px " + DCF;
        cx.fillStyle = '#46f08f';
        cx.textAlign = 'left';
        cx.fillText('SAFETY STOP', rBX + s(6), rBTop + s(12));
        cx.font = 'bold ' + s(28) + "px " + DCF;
        cx.fillText('Complete', rBX + s(6), rBTop + s(38));
    }

    // --- NDL — top-right hero; drops to a smaller readout when a stop is shown ---
    var ndlHero = !showStopBox;
    var ndlLabelTop = ndlHero ? (rBTop + s(8)) : (rBTop + stopBoxH + s(16));
    {
        var ndlRightX = rBX + rBW - s(6);
        cx.font = s(12) + "px " + DCF;
        cx.fillStyle = '#8694a1';
        cx.textAlign = 'right';
        cx.fillText('NDL', ndlRightX, ndlLabelTop);
        cx.font = 'bold ' + s(ndlHero ? 46 : 34) + "px " + DCF;
        cx.fillStyle = ndl < 5 ? '#ff3333' : ndl < 15 ? '#ffd24d' : '#46f08f';
        cx.fillText(ndl >= 999 ? '---' : ndl > 99 ? '99' : String(ndl), ndlRightX, ndlLabelTop + s(ndlHero ? 44 : 30));
        if (ndlHero && ndl < 999) {
            cx.font = s(11) + "px " + DCF;
            cx.fillStyle = '#8694a1';
            cx.fillText('min', ndlRightX, ndlLabelTop + s(58));
        }
        cx.textAlign = 'left';
    }

    // Vertical N2 loading bar (right column)
    var n2BarX = contentX + contentW - s(10);
    var n2BarW = s(6);
    var n2BarTop = mainTop + s(4);
    var n2BarBot = mainTop + mainH - s(4);
    var n2BarFullH = n2BarBot - n2BarTop;
    cx.fillStyle = 'rgba(255,255,255,0.06)';
    cx.beginPath();
    cx.roundRect(n2BarX, n2BarTop, n2BarW, n2BarFullH, s(3));
    cx.fill();
    cx.strokeStyle = 'rgba(255,255,255,0.14)';
    cx.lineWidth = 1;
    cx.stroke();
    var n2LoadFill = Math.min(1, Math.max(0, 1 - ndl / 120));
    if (n2LoadFill > 0) {
        var n2FillH = n2LoadFill * n2BarFullH;
        var n2FillTop = n2BarBot - n2FillH;
        cx.save();
        cx.beginPath();
        cx.roundRect(n2BarX, n2BarTop, n2BarW, n2BarFullH, s(3));
        cx.clip();
        var n2VGrad = cx.createLinearGradient(0, n2BarBot, 0, n2FillTop);
        n2VGrad.addColorStop(0, '#46f08f');
        n2VGrad.addColorStop(1, n2LoadFill > 0.7 ? '#ff4b4b' : n2LoadFill > 0.4 ? '#ffd24d' : '#46f08f');
        cx.fillStyle = n2VGrad;
        cx.fillRect(n2BarX, n2FillTop, n2BarW, n2FillH);
        cx.restore();
    }
    cx.font = s(8) + "px " + DCF;
    cx.fillStyle = '#8694a1';
    cx.textAlign = 'center';
    cx.fillText('N\u2082', n2BarX + n2BarW / 2, n2BarBot + s(10));

    // Divider above bottom
    cx.strokeStyle = '#8694a1';
    cx.lineWidth = 1;
    cx.beginPath();
    cx.moveTo(contentX, bottomTop - s(1));
    cx.lineTo(contentX + contentW, bottomTop - s(1));
    cx.stroke();

    // ================================================================
    //  WARNING BANNER (above info row)
    // ================================================================
    var highestWarn = '';
    var warnCritical = false;

    if (inDeco && depth < decoStopDepth) {
        highestWarn = S('warnCeiling'); warnCritical = true;
    } else if (po2 > PO2_HIGH) {
        highestWarn = S('warnO2'); warnCritical = true;
    } else if (narcosisIndex > 0.70) {
        highestWarn = S('warnNarc'); warnCritical = true;
    } else if (ascentRate > 9) {
        highestWarn = S('warnSlow'); warnCritical = true;
    } else if (tBar < 30) {
        highestWarn = S('warnLowGas'); warnCritical = true;
    } else if (tBar < 50) {
        highestWarn = S('warnReserve'); warnCritical = false;
    } else if (!inDeco && ndl > 0 && ndl < 5) {
        highestWarn = S('warnLowNDL'); warnCritical = true;
    } else if (narcosisIndex > 0.20) {
        highestWarn = S('warnNarc'); warnCritical = false;
    }

    if (highestWarn) {
        var wBlink = warnCritical && Math.floor(Date.now() / 380) % 2 === 0;
        var wCol   = warnCritical ? '#ff4b4b' : '#ffd24d';
        var wbx = contentX + s(4), wbw = contentW - s(8);
        var wby = warnBannerTop,   wbh = warnBannerH;
        // dark pill background
        cx.fillStyle = warnCritical ? 'rgba(45,6,6,0.90)' : 'rgba(38,26,0,0.88)';
        cx.beginPath(); cx.roundRect(wbx, wby, wbw, wbh, s(5)); cx.fill();
        // coloured border (blinks on critical)
        cx.strokeStyle = warnCritical
            ? (wBlink ? 'rgba(255,75,75,0.88)' : 'rgba(255,75,75,0.40)')
            : 'rgba(255,210,77,0.44)';
        cx.lineWidth = 1;
        cx.beginPath(); cx.roundRect(wbx, wby, wbw, wbh, s(5)); cx.stroke();
        // left accent strip
        cx.fillStyle = warnCritical
            ? (wBlink ? 'rgba(255,75,75,0.88)' : 'rgba(255,75,75,0.50)')
            : 'rgba(255,210,77,0.65)';
        cx.beginPath(); cx.roundRect(wbx, wby, s(3), wbh, [s(5), 0, 0, s(5)]); cx.fill();
        // glow ring (only when not blinking out)
        if (!wBlink) {
            cx.save();
            cx.shadowColor = wCol; cx.shadowBlur = s(10);
            cx.strokeStyle = warnCritical ? 'rgba(255,75,75,0.18)' : 'rgba(255,210,77,0.15)';
            cx.lineWidth = 1;
            cx.beginPath(); cx.roundRect(wbx, wby, wbw, wbh, s(5)); cx.stroke();
            cx.restore();
        }
        // icon + text
        cx.font = 'bold ' + s(11) + 'px ' + DCF;
        cx.fillStyle = wBlink ? 'rgba(255,75,75,0.16)' : wCol;
        cx.textAlign = 'center';
        cx.fillText(highestWarn,
            contentX + contentW / 2, warnBannerTop + s(15));
        cx.textAlign = 'left';
    }

    // ================================================================
    //  REGION C — Info Row (bottom, 3 boxes: Gas | MAX/AVG/AMV | GTR/TTS/CEIL)
    // ================================================================
    var slotGap = s(6);
    var slotW = Math.floor((contentW - slotGap * 2 - s(4)) / 3);
    var slotH = bottomH - s(4);
    var slotY = bottomTop + s(2);

    function drawSlot(sx, sw) {
        // WP-037: Background boxes removed
    }

    var rowH = Math.floor(slotH / 3);
    var labelFont = s(10) + "px " + DCF;
    var valueFont = 'bold ' + s(11) + "px " + DCF;
    var labelColor = '#8694a1';
    var valueColor = '#eaf2ff';
    var padL = s(6);


    // --- Box 0: GAS (Classic 5-row style) / CCR HUD ---
    var box0X = contentX + s(2);
    var box0W = slotW;

    // Row heights for 5 rows (shared)
    var rowH5 = slotH / 5;
    var bY1 = slotY + rowH5 * 0 + s(13);
    var bY2 = slotY + rowH5 * 1 + s(13);
    var bY3 = slotY + rowH5 * 2 + s(13);
    var bY4 = slotY + rowH5 * 3 + s(13);
    var bY5 = slotY + rowH5 * 4 + s(13);
    var padR = padL;

    // Box positions (shared by both modes)
    var box1X = box0X + box0W + slotGap;
    var box1W = slotW;
    var box2X = box1X + box1W + slotGap;
    var box2W = contentX + contentW - box2X - s(2);

    if (infoPageMode === 0) {

    if (diveMode === 'ccr') {
      // TASK-032D: CCR HUD Display
      var po2Val = ccrState.actualPO2;
      var ccrPO2Color = po2Val < 0.18 ? '#ff3333' : po2Val > 1.6 ? '#ff3333' : po2Val > 1.4 ? '#ff8800' : po2Val > 1.0 ? '#ffcc00' : '#33ff99';
      var o2Bar = Math.round(ccrState.o2CylPressure);
      var dilBar = Math.round(ccrState.dilCylPressure);
      var scrMin = Math.round(ccrState.scrubberRemaining);
      var scrColor = scrMin < 10 ? '#ff3333' : scrMin < 30 ? '#ffcc00' : '#33ff99';
      var modeText = ccrState.onBailout ? 'BAIL' : 'CCR';
      var modeColor = ccrState.onBailout ? '#ff3333' : '#33ff99';

      // Row 1: Mode + SP
      cx.font = valueFont; cx.textAlign = 'left';
      cx.fillStyle = modeColor;
      cx.fillText(modeText, box0X + padL, bY1);
      cx.fillStyle = '#fff'; cx.textAlign = 'right';
      cx.fillText('SP:' + ccrState.targetSP.toFixed(1), box0X + box0W - padR, bY1);

      // Row 2: PO2
      cx.font = labelFont; cx.fillStyle = labelColor; cx.textAlign = 'left';
      cx.fillText('PO2', box0X + padL, bY2);
      cx.font = valueFont; cx.fillStyle = ccrPO2Color; cx.textAlign = 'right';
      cx.fillText(po2Val.toFixed(2), box0X + box0W - padR, bY2);

      // Row 3: O2 cylinder
      var o2Color = o2Bar < 30 ? '#ff3333' : '#eaf2ff';
      cx.font = labelFont; cx.fillStyle = labelColor; cx.textAlign = 'left';
      cx.fillText('O2', box0X + padL, bY3);
      cx.font = valueFont; cx.fillStyle = o2Color; cx.textAlign = 'right';
      cx.fillText(o2Bar + ' bar', box0X + box0W - padR, bY3);

      // Row 4: Diluent cylinder
      var dilColor = dilBar < 30 ? '#ff3333' : '#eaf2ff';
      cx.font = labelFont; cx.fillStyle = labelColor; cx.textAlign = 'left';
      cx.fillText('DIL', box0X + padL, bY4);
      cx.font = valueFont; cx.fillStyle = dilColor; cx.textAlign = 'right';
      cx.fillText(dilBar + ' bar', box0X + box0W - padR, bY4);

      // Row 5: Scrubber
      cx.font = labelFont; cx.fillStyle = labelColor; cx.textAlign = 'left';
      cx.fillText('SCR', box0X + padL, bY5);
      cx.font = valueFont; cx.fillStyle = scrColor; cx.textAlign = 'right';
      cx.fillText(scrMin + ' min', box0X + box0W - padR, bY5);

    } else {
    // OC Gas Box (original)
    var tank = getActiveTank();
    var bestIdx = recommendBestGas();
    var isBest = (activeTank === bestIdx);
    var tBar = tankBar();
    var barColor = tBar > 100 ? '#33ff33' : (tBar >= 50 ? '#ffff33' : '#ff3333');

    // Row 1: "Gas" label (left-aligned, consistent font)
    cx.font = labelFont; cx.fillStyle = labelColor; cx.textAlign = 'left';
    cx.fillText('Gas', box0X + padL, bY1);

    // Row 2: tank.label (left-aligned, bold, white)
    cx.font = valueFont; cx.textAlign = 'left';
    cx.fillStyle = '#fff';
    cx.fillText(tank.label, box0X + padL, bY2);

    // Row 3: Bar indicator (horizontal, color-coded, numeric value right-aligned, aligned with bar)
    var barX = box0X + padL;
    var barY = bY3 - s(7);
    var barW = box0W - padL * 2 - s(54); // Make pressure bar a bit shorter
    var barH = s(8);
    // Bar background (rounded rect, subtle like N2 bar)
    cx.fillStyle = 'rgba(255,255,255,0.06)';
    cx.beginPath();
    cx.roundRect(barX, barY, barW, barH, s(3));
    cx.fill();
    cx.strokeStyle = 'rgba(255,255,255,0.14)';
    cx.lineWidth = 1;
    cx.stroke();
    // Bar fill (solid color, not gradient)
    var barFrac = Math.max(0, Math.min(1, tBar / 200));
    if (barFrac > 0) {
        cx.save();
        cx.beginPath();
        cx.roundRect(barX, barY, barW, barH, s(3));
        cx.clip();
        cx.fillStyle = barColor;
        cx.fillRect(barX, barY, barW * barFrac, barH);
        cx.restore();
    }
    // Numeric value (vertically centered with bar, right-aligned)
    cx.font = valueFont; cx.fillStyle = barColor; cx.textAlign = 'right';
    cx.fillText(Math.round(tBar) + ' bar', box0X + box0W - padR, barY + barH - s(1));

    // Row 4: Tank dots (smaller, subtle, active/best highlighted)
    var dotCount = tankCount;
    var dotR = s(4.5);
    var dotGap = s(11);
    var dotsStartX = barX + s(4); // Move tank dots slightly left for better centering
    var dotsY = bY4;
    for (var i = 0; i < dotCount; i++) {
        var tk = tanks[i];
        var hasGas = tk.gasRemaining > 0;
        var isActive = (i === activeTank);
        var isBestDot = (i === bestIdx);
        var dotColor = hasGas ? (isActive ? '#33ffcc' : (isBestDot ? '#33ff99' : '#aaa')) : '#444';
        cx.beginPath();
        cx.arc(dotsStartX + i * dotGap, dotsY, dotR, 0, Math.PI * 2);
        cx.fillStyle = dotColor;
        cx.globalAlpha = isActive ? 1.0 : 0.6;
        cx.fill();
        cx.globalAlpha = 1.0;
        if (!hasGas) {
            cx.font = 'bold ' + s(11) + "px " + DCF;
            cx.fillStyle = '#fff';
            cx.textAlign = 'center';
            cx.fillText('\u25CB', dotsStartX + i * dotGap, dotsY + s(4));
        }
    }

    // Row 5: Best gas indicator (label color, right-aligned)
    cx.font = labelFont; cx.textAlign = 'right';
    var bestText = isBest ? 'Best: \u2713' : ('Best: T' + (bestIdx + 1));
    if (!isBest && bestIdx !== null && bestIdx !== activeTank) {
        // Blink green/grey every 500ms if a better tank is available
        var blink = Math.floor(Date.now() / 500) % 2 === 0;
        cx.fillStyle = blink ? '#33ff99' : '#888';
    } else {
        cx.fillStyle = isBest ? '#33ff99' : labelColor;
    }
    cx.fillText(bestText, box0X + box0W - padR, bY5);
    } // end OC/CCR gas box

    // --- Box 1: MAX / AVG / AMV ---
    drawSlot(box1X, box1W);

    // Box 1 Row 1: MAX
    var bR1Y = slotY + rowH * 0 + s(14);
    cx.font = labelFont; cx.fillStyle = labelColor; cx.textAlign = 'left';
    cx.fillText('MAX', box1X + padL, bR1Y);
    cx.font = valueFont; cx.fillStyle = valueColor; cx.textAlign = 'right';
    cx.fillText(maxDepth.toFixed(1) + ' m', box1X + box1W - padL, bR1Y);

    // Box 1 Row 2: AVG
    var bR2Y = slotY + rowH * 1 + s(14);
    cx.font = labelFont; cx.fillStyle = labelColor; cx.textAlign = 'left';
    cx.fillText('AVG', box1X + padL, bR2Y);
    cx.font = valueFont; cx.fillStyle = valueColor; cx.textAlign = 'right';
    cx.fillText(avgDepthVal.toFixed(1) + ' m', box1X + box1W - padL, bR2Y);

    // Box 1 Row 3: AMV
    var bR3Y = slotY + rowH * 2 + s(14);
    cx.font = labelFont; cx.fillStyle = labelColor; cx.textAlign = 'left';
    cx.fillText('AMV', box1X + padL, bR3Y);
    cx.font = valueFont; cx.fillStyle = '#ffcc00'; cx.textAlign = 'right';
    cx.fillText(amvRate + ' L/min', box1X + box1W - padL, bR3Y);

    // --- Box 2: GTR / TTS / CEIL ---
    drawSlot(box2X, box2W);

    // Box 2 Row 1: GTR
    bR1Y = slotY + rowH * 0 + s(14);
    cx.font = labelFont; cx.fillStyle = labelColor; cx.textAlign = 'left';
    cx.fillText('GTR', box2X + padL, bR1Y);
    var gtrColor2 = '#46f08f';
    if (gtr < 10) gtrColor2 = '#ff3333';
    else if (gtr < 30) gtrColor2 = '#ffd24d';
    cx.font = valueFont; cx.fillStyle = gtrColor2; cx.textAlign = 'right';
    cx.fillText(gtr >= 999 ? '---' : Math.floor(gtr) + ' min', box2X + box2W - padL, bR1Y);

    // Box 2 Row 2: TTS
    bR2Y = slotY + rowH * 1 + s(14);
    cx.font = labelFont; cx.fillStyle = labelColor; cx.textAlign = 'left';
    cx.fillText('TTS', box2X + padL, bR2Y);
    var ttsVal = calculateTTS();
    cx.font = valueFont;
    cx.fillStyle = ttsVal > 0 ? (inDeco ? '#ff9933' : '#eaf2ff') : '#555';
    cx.textAlign = 'right';
    cx.fillText(ttsVal > 0 ? ttsVal + ' min' : '--', box2X + box2W - padL, bR2Y);

    // Box 2 Row 3: PO2
    bR3Y = slotY + rowH * 2 + s(14);
    cx.font = labelFont; cx.fillStyle = labelColor; cx.textAlign = 'left';
    cx.fillText('PO2', box2X + padL, bR3Y);
    cx.font = valueFont;
    cx.fillStyle = po2Color(po2);
    cx.textAlign = 'right';
    cx.fillText(po2.toFixed(2), box2X + box2W - padL, bR3Y);
    cx.textAlign = 'left';

    // Vertical dividers between bottom info boxes
    cx.strokeStyle = '#8694a1';
    cx.lineWidth = 1;
    cx.beginPath();
    cx.moveTo(box0X + box0W + Math.floor(slotGap / 2), slotY);
    cx.lineTo(box0X + box0W + Math.floor(slotGap / 2), slotY + slotH);
    cx.stroke();
    cx.beginPath();
    cx.moveTo(box1X + box1W + Math.floor(slotGap / 2), slotY);
    cx.lineTo(box1X + box1W + Math.floor(slotGap / 2), slotY + slotH);
    cx.stroke();

    } else if (infoPageMode === 1 || infoPageMode === 2) {
        // WP-037/038: Tank inventory pages
        var startTank = (infoPageMode - 1) * 3;
        for (var ti = 0; ti < 3; ti++) {
            var tankIdx = startTank + ti;
            var bX = (ti === 0) ? box0X : (ti === 1) ? box1X : box2X;
            var bW = (ti === 0) ? box0W : (ti === 1) ? box1W : box2W;
            if (tankIdx < tankCount) {
                var tk = tanks[tankIdx];
                var tkBar = Math.round(tk.gasRemaining / tk.volume);
                var tkBarColor = tkBar > 100 ? '#33ff33' : tkBar >= 50 ? '#ffff33' : '#ff3333';
                var tkMOD = Math.floor(((PO2_HIGH / tk.fO2) - 1) * 10);
                // Row 1: Tank label
                cx.font = valueFont; cx.fillStyle = (tankIdx === activeTank) ? '#33ffcc' : '#fff';
                cx.textAlign = 'left';
                cx.fillText('T' + (tankIdx + 1), bX + padL, bY1);
                // Row 2: Gas mix
                cx.font = labelFont; cx.fillStyle = '#a8b6cc'; cx.textAlign = 'left';
                cx.fillText(tk.label, bX + padL, bY2);
                // Row 3: Pressure bar + value
                var tBarX = bX + padL;
                var tBarY = bY3 - s(7);
                var tBarW2 = bW - padL * 2 - s(40);
                var tBarH2 = s(8);
                cx.fillStyle = 'rgba(255,255,255,0.06)';
                cx.beginPath(); cx.roundRect(tBarX, tBarY, tBarW2, tBarH2, s(3)); cx.fill();
                var tBarFrac = Math.max(0, Math.min(1, tkBar / 200));
                if (tBarFrac > 0) {
                    cx.save(); cx.beginPath(); cx.roundRect(tBarX, tBarY, tBarW2, tBarH2, s(3)); cx.clip();
                    cx.fillStyle = tkBarColor; cx.fillRect(tBarX, tBarY, tBarW2 * tBarFrac, tBarH2);
                    cx.restore();
                }
                cx.font = valueFont; cx.fillStyle = tkBarColor; cx.textAlign = 'right';
                cx.fillText(tkBar + 'b', bX + bW - padL, tBarY + tBarH2 - s(1));
                // Row 4: MOD
                cx.font = labelFont; cx.fillStyle = labelColor; cx.textAlign = 'left';
                cx.fillText('MOD', bX + padL, bY4);
                cx.font = valueFont; cx.fillStyle = valueColor; cx.textAlign = 'right';
                cx.fillText(tkMOD + 'm', bX + bW - padL, bY4);
                // Row 5: Active indicator
                if (tankIdx === activeTank) {
                    cx.font = labelFont; cx.fillStyle = '#33ffcc'; cx.textAlign = 'center';
                    cx.fillText('ACTIVE', bX + bW / 2, bY5);
                }
            } else {
                cx.font = labelFont; cx.fillStyle = '#444'; cx.textAlign = 'center';
                cx.fillText('---', bX + bW / 2, bY3);
            }
        }
        // Vertical dividers between tank slots
        cx.strokeStyle = '#8694a1';
        cx.lineWidth = 1;
        cx.beginPath();
        cx.moveTo(box0X + box0W + Math.floor(slotGap / 2), slotY);
        cx.lineTo(box0X + box0W + Math.floor(slotGap / 2), slotY + slotH);
        cx.stroke();
        cx.beginPath();
        cx.moveTo(box1X + box1W + Math.floor(slotGap / 2), slotY);
        cx.lineTo(box1X + box1W + Math.floor(slotGap / 2), slotY + slotH);
        cx.stroke();

    } else if (infoPageMode === 3) {
        // WP-038: Tissue bar graph page
        cx.font = s(10) + "px " + DCF; cx.fillStyle = '#8694a1'; cx.textAlign = 'left';
        cx.fillText('TISSUES', contentX + s(4), slotY + s(10));

        var barAreaX = contentX + s(4);
        var barAreaW = contentW - s(8);
        var barAreaTop = slotY + s(14);
        var barAreaH = slotH - s(20);
        var barGap = s(2);
        var barW = Math.floor((barAreaW - barGap * 15) / 16);
        var pAmb = ambientPressure(depth);

        for (var i = 0; i < 16; i++) {
            var ab = combinedAB(i);
            var ptTotal = tissues[i] + tissuesHe[i];
            var mVal = ab.a + pAmb / ab.b;
            var ratio = ptTotal / mVal;
            ratio = Math.max(0, Math.min(1.2, ratio));
            var bx = barAreaX + i * (barW + barGap);
            var bh = Math.round(ratio * barAreaH / 1.2);
            var by = barAreaTop + barAreaH - bh;

            // Background (unfilled portion)
            cx.fillStyle = 'rgba(255,255,255,0.06)';
            cx.fillRect(bx, barAreaTop, barW, barAreaH);

            // Bar color based on ratio
            var bColor = ratio >= 1.0 ? '#ff3333' : ratio >= 0.8 ? '#ffd24d' : '#46f08f';
            cx.fillStyle = bColor;
            cx.fillRect(bx, by, barW, bh);
        }

        // Compartment labels
        cx.font = s(7) + "px " + DCF; cx.fillStyle = '#555'; cx.textAlign = 'center';
        var labelIdxs = [0, 3, 7, 11, 15];
        for (var li = 0; li < labelIdxs.length; li++) {
            var idx = labelIdxs[li];
            var lx = barAreaX + idx * (barW + barGap) + barW / 2;
            cx.fillText(String(idx + 1), lx, barAreaTop + barAreaH + s(8));
        }

    } else if (infoPageMode === 4) {
        // WP-039: Deco metrics page — 3-row layout matching Box 3.2/3.3
        var pAmb = ambientPressure(depth);

        // GF99 calculation
        var gf99 = 0;
        for (var i = 0; i < 16; i++) {
            var ab = combinedAB(i);
            var ptTotal = tissues[i] + tissuesHe[i];
            var mVal = ab.a + pAmb / ab.b;
            var gfi = (mVal - pAmb) > 0.0001 ? (ptTotal - pAmb) / (mVal - pAmb) * 100 : 0;
            if (gfi > gf99) gf99 = gfi;
        }
        gf99 = Math.max(0, Math.round(gf99));

        // SurfGF calculation
        var surfGF = 0;
        var pSurf = 1.0;
        for (var i = 0; i < 16; i++) {
            var ab = combinedAB(i);
            var ptTotal = tissues[i] + tissuesHe[i];
            var mVal = ab.a + pSurf / ab.b;
            var gfi = (mVal - pSurf) > 0.0001 ? (ptTotal - pSurf) / (mVal - pSurf) * 100 : 0;
            if (gfi > surfGF) surfGF = gfi;
        }
        surfGF = Math.max(0, Math.round(surfGF));

        // Use 3-row Y positions (same as Box 3.2/3.3)
        var gR1Y = slotY + rowH * 0 + s(14);
        var gR2Y = slotY + rowH * 1 + s(14);
        var gR3Y = slotY + rowH * 2 + s(14);

        // Box 0: GF99 / SurfGF / CNS
        cx.font = labelFont; cx.fillStyle = labelColor; cx.textAlign = 'left';
        cx.fillText('GF99', box0X + padL, gR1Y);
        var gf99Color = gf99 >= 100 ? '#ff3333' : gf99 >= 80 ? '#ffd24d' : '#46f08f';
        cx.font = valueFont; cx.fillStyle = gf99Color; cx.textAlign = 'right';
        cx.fillText(gf99 + '%', box0X + box0W - padL, gR1Y);

        cx.font = labelFont; cx.fillStyle = labelColor; cx.textAlign = 'left';
        cx.fillText('SrfGF', box0X + padL, gR2Y);
        var surfGFColor = surfGF >= 100 ? '#ff3333' : surfGF >= 80 ? '#ffd24d' : '#46f08f';
        cx.font = valueFont; cx.fillStyle = surfGFColor; cx.textAlign = 'right';
        cx.fillText(surfGF + '%', box0X + box0W - padL, gR2Y);

        var cnsVal = Math.round(cnsPercent);
        var cnsColor = cnsVal >= 80 ? '#ff3333' : cnsVal >= 50 ? '#ffd24d' : '#46f08f';
        cx.font = labelFont; cx.fillStyle = labelColor; cx.textAlign = 'left';
        cx.fillText('CNS', box0X + padL, gR3Y);
        cx.font = valueFont; cx.fillStyle = cnsColor; cx.textAlign = 'right';
        cx.fillText(cnsVal + '%', box0X + box0W - padL, gR3Y);

        // Box 1: CEIL / GF Lo / GF Hi
        var ceilVal = calculateCeiling();
        cx.font = labelFont; cx.fillStyle = labelColor; cx.textAlign = 'left';
        cx.fillText('CEIL', box1X + padL, gR1Y);
        cx.font = valueFont; cx.fillStyle = ceilVal > 0 ? '#ff9933' : '#46f08f'; cx.textAlign = 'right';
        cx.fillText(ceilVal > 0 ? ceilVal.toFixed(1) + 'm' : '0m', box1X + box1W - padL, gR1Y);

        cx.font = labelFont; cx.fillStyle = labelColor; cx.textAlign = 'left';
        cx.fillText('GF Lo', box1X + padL, gR2Y);
        cx.font = valueFont; cx.fillStyle = valueColor; cx.textAlign = 'right';
        cx.fillText(gfLow + '%', box1X + box1W - padL, gR2Y);

        cx.font = labelFont; cx.fillStyle = labelColor; cx.textAlign = 'left';
        cx.fillText('GF Hi', box1X + padL, gR3Y);
        cx.font = valueFont; cx.fillStyle = valueColor; cx.textAlign = 'right';
        cx.fillText(gfHigh + '%', box1X + box1W - padL, gR3Y);

        // Box 2: TTS / NDL / PO2 (additional useful metrics)
        var ttsVal2 = calculateTTS();
        cx.font = labelFont; cx.fillStyle = labelColor; cx.textAlign = 'left';
        cx.fillText('TTS', box2X + padL, gR1Y);
        cx.font = valueFont;
        cx.fillStyle = ttsVal2 > 0 ? '#ff9933' : '#555';
        cx.textAlign = 'right';
        cx.fillText(ttsVal2 > 0 ? ttsVal2 + ' min' : '--', box2X + box2W - padL, gR1Y);

        cx.font = labelFont; cx.fillStyle = labelColor; cx.textAlign = 'left';
        cx.fillText('NDL', box2X + padL, gR2Y);
        cx.font = valueFont;
        var ndlColor2 = ndl < 5 ? '#ff3333' : ndl < 15 ? '#ffd24d' : '#46f08f';
        cx.fillStyle = ndlColor2; cx.textAlign = 'right';
        cx.fillText(ndl >= 999 ? '---' : (ndl > 99 ? '99' : ndl) + ' min', box2X + box2W - padL, gR2Y);

        cx.font = labelFont; cx.fillStyle = labelColor; cx.textAlign = 'left';
        cx.fillText('PO2', box2X + padL, gR3Y);
        cx.font = valueFont; cx.fillStyle = po2Color(po2); cx.textAlign = 'right';
        cx.fillText(po2.toFixed(2), box2X + box2W - padL, gR3Y);

        // Vertical dividers
        cx.strokeStyle = '#8694a1';
        cx.lineWidth = 1;
        cx.beginPath();
        cx.moveTo(box0X + box0W + Math.floor(slotGap / 2), slotY);
        cx.lineTo(box0X + box0W + Math.floor(slotGap / 2), slotY + slotH);
        cx.stroke();
        cx.beginPath();
        cx.moveTo(box1X + box1W + Math.floor(slotGap / 2), slotY);
        cx.lineTo(box1X + box1W + Math.floor(slotGap / 2), slotY + slotH);
        cx.stroke();
    } else if (infoPageMode === 5 && diveMode === 'ccr') {
        // BUG-CCR-3: CCR-specific gas-info page. Shows actual PO2, target SP,
        // O2 cylinder, diluent cylinder + mix, scrubber minutes remaining.
        var ccrInfoR1Y = slotY + rowH * 0 + s(14);
        var ccrInfoR2Y = slotY + rowH * 1 + s(14);
        var ccrInfoR3Y = slotY + rowH * 2 + s(14);

        var po2Actual = ccrState.actualPO2;
        var po2ActualColor = po2Actual < PO2_HYPOXIA ? '#ff3333'
            : po2Actual > PO2_HIGH ? '#ff3333'
            : po2Actual > PO2_ELEVATED ? '#ff8800'
            : po2Actual > PO2_SAFE ? '#ffcc00' : '#33ff99';
        var o2Bar5 = Math.round(ccrState.o2CylPressure);
        var dilBar5 = Math.round(ccrState.dilCylPressure);
        var scrMin5 = Math.round(ccrState.scrubberRemaining);
        var scrColor5 = scrMin5 < 10 ? '#ff3333' : scrMin5 < 30 ? '#ffcc00' : '#33ff99';
        var o2Color5 = o2Bar5 < 30 ? '#ff3333' : '#eaf2ff';
        var dilColor5 = dilBar5 < 30 ? '#ff3333' : '#eaf2ff';

        // Box 0: PO2 actual / SP target / mode (CCR or BAIL)
        cx.font = labelFont; cx.fillStyle = labelColor; cx.textAlign = 'left';
        cx.fillText('PO2', box0X + padL, ccrInfoR1Y);
        cx.font = valueFont; cx.fillStyle = po2ActualColor; cx.textAlign = 'right';
        cx.fillText(po2Actual.toFixed(2), box0X + box0W - padL, ccrInfoR1Y);

        cx.font = labelFont; cx.fillStyle = labelColor; cx.textAlign = 'left';
        cx.fillText('SP', box0X + padL, ccrInfoR2Y);
        cx.font = valueFont; cx.fillStyle = '#ffcc00'; cx.textAlign = 'right';
        cx.fillText(ccrState.targetSP.toFixed(1), box0X + box0W - padL, ccrInfoR2Y);

        cx.font = labelFont; cx.fillStyle = labelColor; cx.textAlign = 'left';
        cx.fillText('MODE', box0X + padL, ccrInfoR3Y);
        cx.font = valueFont;
        cx.fillStyle = ccrState.onBailout ? '#ff3333' : '#33ff99';
        cx.textAlign = 'right';
        cx.fillText(ccrState.onBailout ? 'BAIL' : 'CCR', box0X + box0W - padL, ccrInfoR3Y);

        // Box 1: O2 cyl pressure / O2 cyl volume / scrubber
        cx.font = labelFont; cx.fillStyle = labelColor; cx.textAlign = 'left';
        cx.fillText('O2 P', box1X + padL, ccrInfoR1Y);
        cx.font = valueFont; cx.fillStyle = o2Color5; cx.textAlign = 'right';
        cx.fillText(o2Bar5 + 'b', box1X + box1W - padL, ccrInfoR1Y);

        cx.font = labelFont; cx.fillStyle = labelColor; cx.textAlign = 'left';
        cx.fillText('O2 V', box1X + padL, ccrInfoR2Y);
        cx.font = valueFont; cx.fillStyle = '#eaf2ff'; cx.textAlign = 'right';
        cx.fillText(ccrState.o2CylVolume + 'L', box1X + box1W - padL, ccrInfoR2Y);

        cx.font = labelFont; cx.fillStyle = labelColor; cx.textAlign = 'left';
        cx.fillText('SCR', box1X + padL, ccrInfoR3Y);
        cx.font = valueFont; cx.fillStyle = scrColor5; cx.textAlign = 'right';
        cx.fillText(scrMin5 + 'm', box1X + box1W - padL, ccrInfoR3Y);

        // Box 2: diluent pressure / diluent volume / diluent mix label
        cx.font = labelFont; cx.fillStyle = labelColor; cx.textAlign = 'left';
        cx.fillText('DIL P', box2X + padL, ccrInfoR1Y);
        cx.font = valueFont; cx.fillStyle = dilColor5; cx.textAlign = 'right';
        cx.fillText(dilBar5 + 'b', box2X + box2W - padL, ccrInfoR1Y);

        cx.font = labelFont; cx.fillStyle = labelColor; cx.textAlign = 'left';
        cx.fillText('DIL V', box2X + padL, ccrInfoR2Y);
        cx.font = valueFont; cx.fillStyle = '#eaf2ff'; cx.textAlign = 'right';
        cx.fillText(ccrState.dilCylVolume + 'L', box2X + box2W - padL, ccrInfoR2Y);

        cx.font = labelFont; cx.fillStyle = labelColor; cx.textAlign = 'left';
        cx.fillText('MIX', box2X + padL, ccrInfoR3Y);
        cx.font = valueFont; cx.fillStyle = '#66ccff'; cx.textAlign = 'right';
        cx.fillText(ccrDilPresetName(), box2X + box2W - padL, ccrInfoR3Y);

        // Vertical dividers (matches other info pages)
        cx.strokeStyle = '#8694a1';
        cx.lineWidth = 1;
        cx.beginPath();
        cx.moveTo(box0X + box0W + Math.floor(slotGap / 2), slotY);
        cx.lineTo(box0X + box0W + Math.floor(slotGap / 2), slotY + slotH);
        cx.stroke();
        cx.beginPath();
        cx.moveTo(box1X + box1W + Math.floor(slotGap / 2), slotY);
        cx.lineTo(box1X + box1W + Math.floor(slotGap / 2), slotY + slotH);
        cx.stroke();
    }

    // ================================================================
    //  TASK-032E: CCR Warning Banner (flashing)
    // ================================================================
    if (diveMode === 'ccr') {
      var ccrWarnText = '';
      var ccrWarnColor = '#ff3333';
      if (ccrState.actualPO2 < 0.18 && !ccrState.onBailout) ccrWarnText = 'LOW PO2';
      else if (ccrState.actualPO2 > 1.5 && !ccrState.onBailout) ccrWarnText = 'HIGH PO2';
      if (ccrState.scrubberFailed && !ccrState.onBailout) ccrWarnText = 'CO2!';
      if (!ccrState.scrubberFailed && ccrState.scrubberRemaining < 10 && ccrState.scrubberRemaining > 0 && !ccrState.onBailout) {
        ccrWarnText = 'SCR LOW'; ccrWarnColor = '#ffcc00';
      }
      if (ccrWarnText && Math.floor(Date.now() / 500) % 2 === 0) {
        cx.font = 'bold ' + s(14) + "px " + DCF;
        cx.fillStyle = ccrWarnColor;
        cx.textAlign = 'center';
        cx.fillText(ccrWarnText, dcX + dcW / 2, warnBannerTop + s(14));
      }
      if (ccrWarnText) {
        if (!ccrWarningBeepTriggered) { playAlertBeep(); ccrWarningBeepTriggered = true; }
      } else {
        ccrWarningBeepTriggered = false;
      }
    }

    // ================================================================
    //  Alert beep (preserved)
    // ================================================================
    var hasWarning = (tBar < 50) || (po2 > PO2_HIGH) || (ascentRate > 9) || (inDeco && depth < decoStopDepth) || (narcosisIndex > 0.20);
    if (hasWarning) playAlertBeep();

    cx.restore();
}

// SECTION: Gas selection setup screen
// SEARCH TERMS: drawGasSetup, diveMode, tank tabs, preset gases, mode selector

// ============================================================
//  GAS SELECTION SCREEN — TASK-018
// ============================================================

function drawGasSetup() {
    var cx = ctx;
    var W = canvas.width;
    var H = canvas.height;

    cx.fillStyle = 'rgba(0,0,0,0.95)';
    cx.fillRect(0, 0, W, H);

    var centerX = W / 2;
    var y = H * 0.08;

    // Title
    cx.textAlign = 'center';
    cx.font = 'bold 28px monospace';
    cx.fillStyle = '#fff';
    cx.fillText(S('gasSetupTitle'), centerX, y);
    y += 40;

    // BUG-CCR-10: Removed canvas-drawn mode tabs (they looked clickable but
    // weren't). The HTML gas-setup overlay's mode buttons (modeBtnRec/Tec/Ccr)
    // and the keyboard M hint are the only entry points now.
    cx.font = 'bold 14px monospace';
    cx.fillStyle = '#33ff99';
    cx.textAlign = 'center';
    cx.fillText(S('modeLabel') + ': ' + diveMode.toUpperCase(), centerX, y);
    y += 18;
    cx.font = '11px monospace';
    cx.fillStyle = '#555';
    cx.fillText('M = ' + S('modeLabel') + ' (gas setup only)', centerX, y);
    y += 16;

    // TASK-032A: CCR gas setup (canvas)
    if (diveMode === 'ccr') {
        cx.font = '16px monospace';
        cx.fillStyle = '#33ff99';
        cx.textAlign = 'center';
        cx.fillText(S('ccrO2Cyl') + ': ' + ccrState.o2CylPressure + 'bar \u00D7 ' + ccrState.o2CylVolume + 'L', centerX, y + 20);
        cx.fillStyle = '#66ccff';
        cx.fillText(S('ccrDiluent') + ': ' + ccrDilPresetName(), centerX, y + 44);
        cx.fillText(S('ccrDilCyl') + ': ' + ccrState.dilCylPressure + 'bar \u00D7 ' + ccrState.dilCylVolume + 'L', centerX, y + 66);
        cx.fillStyle = '#ffcc00';
        cx.fillText(S('ccrSetpoint') + ': ' + ccrState.targetSP.toFixed(1) + ' bar', centerX, y + 90);
        cx.fillStyle = '#aaa';
        cx.fillText(S('ccrScrubber') + ': ' + ccrState.scrubberRemaining + ' min', centerX, y + 112);
        cx.font = '11px monospace';
        cx.fillStyle = '#555';
        cx.fillText('[1-5] Diluent  [/] SP  [,/.] Cyl  [Enter] Start', centerX, y + 140);
        cx.textAlign = 'left';
        return;
    }

    if (isAdvanced()) {
        // Tank tabs
        cx.font = 'bold 14px monospace';
        var tabW = 80;
        var totalTabW = tankCount * (tabW + 8) + 60;
        var tabX = centerX - totalTabW / 2;
        for (var i = 0; i < tankCount; i++) {
            var isSelected = (i === selectedTankTab);
            cx.fillStyle = isSelected ? '#33ff99' : '#555';
            cx.fillRect(tabX, y - 14, tabW, 22);
            cx.fillStyle = isSelected ? '#000' : '#ccc';
            cx.textAlign = 'center';
            cx.fillText('Tank ' + (i + 1), tabX + tabW / 2, y + 2);
            tabX += tabW + 8;
        }
        cx.fillStyle = '#888';
        cx.font = 'bold 18px monospace';
        cx.fillText('[+]', tabX + 10, y + 2);
        cx.fillText('[-]', tabX + 45, y + 2);
        y += 40;
    }

    var t = tanks[selectedTankTab];
    cx.textAlign = 'center';

    // O2
    cx.font = 'bold 40px monospace';
    cx.fillStyle = '#33ff33';
    cx.fillText('O\u2082 ' + Math.round(t.fO2 * 100) + '%', centerX, y);
    y += 25;

    if (isAdvanced()) {
        // He
        cx.font = 'bold 32px monospace';
        cx.fillStyle = '#44ccff';
        cx.fillText('He ' + Math.round(t.fHe * 100) + '%', centerX, y);
        y += 25;
    }

    // N2
    cx.font = '20px monospace';
    cx.fillStyle = '#ccc';
    cx.fillText('N\u2082: ' + Math.round(t.fN2 * 100) + '%', centerX, y);
    y += 35;

    // Pressure
    cx.font = 'bold 18px monospace';
    cx.fillStyle = '#fff';
    cx.fillText(S('pressure') + ': ' + t.pressure + ' bar', centerX, y);
    y += 25;

    // MOD + Label
    var mod = calculateMOD(t.fO2);
    cx.font = '16px monospace';
    cx.fillStyle = '#aaa';
    cx.fillText('MOD (PO2 1.4): ' + mod.toFixed(0) + 'm    Label: ' + t.label, centerX, y);
    y += 35;

    // AMV setting (advanced only)
    if (isAdvanced()) {
        cx.font = 'bold 18px monospace';
        cx.fillStyle = '#ffcc00';
        cx.fillText(S('amvLabel') + ': ' + amvRate + ' L/min', centerX, y);
        y += 25;

        // Tank size setting
        cx.font = 'bold 18px monospace';
        cx.fillStyle = '#66ccff';
        cx.fillText(S('tankSizeLabel') + ': ' + tanks[selectedTankTab].volume + ' L', centerX, y);
        y += 25;

        // GF setting
        cx.font = 'bold 18px monospace';
        cx.fillStyle = '#ff9966';
        cx.fillText(S('gfLowLabel') + ': ' + gfLow + '%  /  ' + S('gfHighLabel') + ': ' + gfHigh + '%', centerX, y);
        y += 25;
    }

    // Presets
    cx.font = '13px monospace';
    cx.fillStyle = '#aaa';
    if (isAdvanced()) {
        cx.fillText(S('presetsAdv1'), centerX, y);
        y += 18;
        cx.fillText(S('presetsAdv2'), centerX, y);
        y += 25;
    } else {
        cx.fillText(S('presetsBasic'), centerX, y);
        y += 25;
    }

    y += 10;

    cx.font = 'bold 20px monospace';
    cx.fillStyle = '#fff';
    cx.fillText(S('startDive'), centerX, y);

    cx.textAlign = 'left';
}

// SECTION: Dive profile chart
// SEARCH TERMS: drawDiveProfileChart, diveProfile, depth-time chart

// ============================================================
//  WP-034: DIVE PROFILE CHART
// ============================================================

function drawDiveProfileChart(cx, x, y, w, h) {
    if (diveProfile.length < 2) return;

    // Chart frame
    cx.fillStyle = '#000';
    cx.fillRect(x, y, w, h);
    cx.strokeStyle = '#fff';
    cx.lineWidth = 1;
    cx.strokeRect(x, y, w, h);

    // Determine scales
    var maxD = 0;
    var maxT = diveTime;
    for (var i = 0; i < diveProfile.length; i++) {
        if (diveProfile[i].depth > maxD) maxD = diveProfile[i].depth;
    }
    if (maxD < 1) maxD = 1;
    if (maxT < 1) maxT = 1;

    var pad = 4;
    var chartX = x + pad;
    var chartY = y + pad;
    var chartW = w - pad * 2;
    var chartH = h - pad * 2;

    // Horizontal grid lines every 10m
    cx.strokeStyle = 'rgba(255,255,255,0.25)';
    cx.lineWidth = 0.5;
    var gridStep = 10;
    for (var gd = gridStep; gd < maxD; gd += gridStep) {
        var gy = chartY + (gd / maxD) * chartH;
        cx.beginPath();
        cx.moveTo(chartX, gy);
        cx.lineTo(chartX + chartW, gy);
        cx.stroke();
    }

    // Draw depth polyline (blue)
    cx.beginPath();
    cx.strokeStyle = '#17a8ff';
    cx.lineWidth = 2;
    for (var i = 0; i < diveProfile.length; i++) {
        var px = chartX + (diveProfile[i].t / maxT) * chartW;
        var py = chartY + (diveProfile[i].depth / maxD) * chartH;
        if (i === 0) cx.moveTo(px, py);
        else cx.lineTo(px, py);
    }
    cx.stroke();

    // Draw ceiling polyline (red, only where ceiling > 0)
    cx.beginPath();
    cx.strokeStyle = '#ff3333';
    cx.lineWidth = 1.5;
    var inCeiling = false;
    for (var i = 0; i < diveProfile.length; i++) {
        var ceil = diveProfile[i].ceiling;
        if (ceil > 0) {
            var px = chartX + (diveProfile[i].t / maxT) * chartW;
            var py = chartY + (ceil / maxD) * chartH;
            if (!inCeiling) { cx.moveTo(px, py); inCeiling = true; }
            else cx.lineTo(px, py);
        } else {
            if (inCeiling) { cx.stroke(); cx.beginPath(); inCeiling = false; }
        }
    }
    if (inCeiling) cx.stroke();

    // Labels
    cx.font = '11px monospace';
    cx.fillStyle = '#ccc';
    cx.textAlign = 'left';
    cx.fillText('0m', x + 3, y + 13);
    cx.fillText(maxD.toFixed(0) + 'm', x + 3, y + h - 4);
    cx.textAlign = 'right';
    cx.fillText(formatTime(maxT), x + w - 3, y + h - 4);
    cx.textAlign = 'center';
}

// SECTION: Post-dive summary screen
// SEARCH TERMS: drawPostDive, maxDepth, avgDepth, diveTime, CNS, tissue saturation

// ============================================================
//  POST-DIVE SUMMARY
// ============================================================

// Shared backdrop + panel helpers for the result screens
function gsBackdrop(cx, W, H) {
    var g = cx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#0b1418');
    g.addColorStop(0.7, '#06090c');
    g.addColorStop(1, '#04070a');
    cx.fillStyle = g;
    cx.fillRect(0, 0, W, H);
    var rg = cx.createRadialGradient(W / 2, -H * 0.1, 40, W / 2, H * 0.2, H * 0.75);
    rg.addColorStop(0, 'rgba(40,120,140,0.16)');
    rg.addColorStop(1, 'rgba(40,120,140,0)');
    cx.fillStyle = rg;
    cx.fillRect(0, 0, W, H);
}

function gsPanel(cx, x, y, w, h, r) {
    cx.beginPath();
    cx.roundRect(x, y, w, h, r || 16);
    cx.fillStyle = '#0d161b';
    cx.fill();
    cx.strokeStyle = '#18242a';
    cx.lineWidth = 1;
    cx.stroke();
}

function drawPostDive() {
    var cx = ctx;
    var W = canvas.width;
    var H = canvas.height;
    var DCF = "'Barlow Semi Condensed', monospace";

    gsBackdrop(cx, W, H);

    var centerX = W / 2;
    var y = H * 0.07;

    cx.textAlign = 'center';
    cx.font = 'bold 12px monospace';
    cx.fillStyle = '#34e6ff';
    cx.fillText('DIVE LOG', centerX, y);
    y += 30;
    cx.font = 'bold 38px ' + DCF;
    cx.fillStyle = '#46f08f';
    cx.fillText(S('diveComplete'), centerX, y);
    y += 30;

    // Stats card: Dive Time / Max / Avg
    var avgD = avgDepthSamples > 0 ? (avgDepthAccum / avgDepthSamples).toFixed(1) : '0.0';
    var cardW = Math.min(560, W - 80);
    var cardX = centerX - cardW / 2;
    var cardH = 84;
    gsPanel(cx, cardX, y, cardW, cardH, 16);
    var statCells = [
        [S('diveTimeLbl'), formatTime(diveTime)],
        [S('maxDepthLbl'), maxDepth.toFixed(1) + 'm'],
        [S('avgDepthLbl'), avgD + 'm']
    ];
    for (var sc = 0; sc < 3; sc++) {
        var sccx = cardX + cardW * (sc + 0.5) / 3;
        if (sc > 0) {
            cx.strokeStyle = 'rgba(130,160,180,0.16)';
            cx.lineWidth = 1;
            cx.beginPath();
            cx.moveTo(cardX + cardW * sc / 3, y + 16);
            cx.lineTo(cardX + cardW * sc / 3, y + cardH - 16);
            cx.stroke();
        }
        cx.textAlign = 'center';
        cx.font = '11px monospace';
        cx.fillStyle = '#8694a1';
        cx.fillText(String(statCells[sc][0]).toUpperCase(), sccx, y + 31);
        cx.font = 'bold 30px ' + DCF;
        cx.fillStyle = '#eaf2ff';
        cx.fillText(statCells[sc][1], sccx, y + 63);
    }
    y += cardH + 26;
    cx.textAlign = 'center';
    cx.font = '15px monospace';
    cx.fillStyle = '#a8b6cc';

    // Gas usage per tank
    for (var ti = 0; ti < tankCount; ti++) {
        var tk = tanks[ti];
        var used = tk.totalGas - tk.gasRemaining;
        cx.fillText('Tank ' + (ti + 1) + ' (' + tk.label + '): ' + used.toFixed(0) + 'L ' + S('gasUsed') + ' / ' + tk.totalGas + 'L', centerX, y);
        y += 24;
    }
    y += 15;

    // Safety stop skipped warning
    if (safetyStopNeeded && !safetyStopComplete) {
        cx.font = 'bold 16px monospace';
        cx.fillStyle = '#ffd24d';
        cx.fillText(S('safetySkipped'), centerX, y);
        y += 22;
        cx.font = '12px monospace';
        cx.fillStyle = '#8694a1';
        var safetyLines = S('safetyExpl');
        for (var si = 0; si < safetyLines.length; si++) {
            cx.fillText(safetyLines[si], centerX, y); y += 16;
        }
        y += 24;
    }

    // WP-034: Dive Profile Chart (same width as tissue bars)
    var barW = 16;
    var barMaxH = 100;
    var totalBarW = 16 * (barW + 4);
    var profileW = totalBarW;
    drawDiveProfileChart(cx, centerX - profileW / 2, y, profileW, H * 0.25);
    y += H * 0.25 + 20;

    // Tissue loading bar graph — N2 + He
    cx.font = 'bold 14px monospace';
    cx.fillStyle = '#8694a1';
    cx.fillText(S('tissueLoading'), centerX, y);
    y += 20;

    var startX = centerX - totalBarW / 2;

    for (var i = 0; i < 16; i++) {
        var bx = startX + i * (barW + 4);
        var ab = combinedAB(i);
        var m0 = ab.a + 1.0 / ab.b;
        var totalLoad = tissues[i] + tissuesHe[i];
        var loading = totalLoad / m0;
        var h = Math.min(barMaxH, loading * barMaxH);

        var n2Frac = totalLoad > 0.0001 ? tissues[i] / totalLoad : 1;
        var heFrac = 1 - n2Frac;
        var n2H = h * n2Frac;
        var heH = h * heFrac;

        // Background
        cx.fillStyle = 'rgba(130,160,180,0.14)';
        cx.fillRect(bx, y, barW, barMaxH);

        // N2 fill
        var color = '#46f08f';
        if (loading > 0.9) color = '#ff4b4b';
        else if (loading > 0.7) color = '#ffd24d';
        cx.fillStyle = color;
        cx.fillRect(bx, y + barMaxH - n2H, barW, n2H);

        // He fill
        if (heH > 0.5) {
            cx.fillStyle = '#34e6ff';
            cx.fillRect(bx, y + barMaxH - n2H - heH, barW, heH);
        }

        // M-value line
        cx.strokeStyle = 'rgba(255,75,75,0.65)';
        cx.lineWidth = 1;
        cx.beginPath();
        cx.moveTo(bx, y);
        cx.lineTo(bx + barW, y);
        cx.stroke();

        cx.font = '8px monospace';
        cx.fillStyle = '#5b6773';
        cx.textAlign = 'center';
        cx.fillText(String(i + 1), bx + barW / 2, y + barMaxH + 12);
    }

    // Legend
    y += barMaxH + 25;
    cx.font = '10px monospace';
    cx.textAlign = 'center';
    cx.fillStyle = '#46f08f';
    cx.fillText('\u25A0', centerX - 40, y);
    cx.fillStyle = '#8694a1';
    cx.fillText('N\u2082', centerX - 28, y);
    cx.fillStyle = '#34e6ff';
    cx.fillText('\u25A0', centerX + 10, y);
    cx.fillStyle = '#8694a1';
    cx.fillText('He', centerX + 22, y);

    y += 30;
    if (!isTouchDevice) {
        cx.textAlign = 'center';
        cx.font = 'bold 13px monospace';
        var pTxt = S('diveAgain');
        var pW = cx.measureText(pTxt).width + 36;
        cx.beginPath();
        cx.roundRect(centerX - pW / 2, y - 16, pW, 30, 8);
        cx.fillStyle = 'rgba(70,240,143,0.12)';
        cx.fill();
        cx.strokeStyle = 'rgba(70,240,143,0.5)';
        cx.lineWidth = 1;
        cx.stroke();
        cx.fillStyle = '#7df0b0';
        cx.fillText(pTxt, centerX, y + 4);
    }

    cx.textAlign = 'left';
}

// SECTION: Game over screen
// SEARCH TERMS: drawGameOver, gameOverReason, cause of death

// ============================================================
//  GAME OVER SCREEN
// ============================================================

function drawWrappedText(cx, text, x, y, maxWidth, lineHeight, measureOnly) {
    var words = text.split(' ');
    var line = '';
    for (var i = 0; i < words.length; i++) {
        var test = line + words[i] + ' ';
        if (cx.measureText(test).width > maxWidth && line.length > 0) {
            if (!measureOnly) cx.fillText(line.trim(), x, y);
            y += lineHeight;
            line = words[i] + ' ';
        } else {
            line = test;
        }
    }
    if (line.trim().length > 0) {
        if (!measureOnly) cx.fillText(line.trim(), x, y);
        y += lineHeight;
    }
    return y;
}

function drawGameOver() {
    var cx = ctx;
    var W = canvas.width;
    var H = canvas.height;

    var DCF = "'Barlow Semi Condensed', monospace";
    var g = cx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#1a0c0e');
    g.addColorStop(0.6, '#0a0608');
    g.addColorStop(1, '#070405');
    cx.fillStyle = g;
    cx.fillRect(0, 0, W, H);
    var rg = cx.createRadialGradient(W / 2, -H * 0.1, 40, W / 2, H * 0.18, H * 0.7);
    rg.addColorStop(0, 'rgba(200,50,50,0.16)');
    rg.addColorStop(1, 'rgba(200,50,50,0)');
    cx.fillStyle = rg;
    cx.fillRect(0, 0, W, H);

    var margin = 40;
    var maxTextW = Math.min(700, W - margin * 2);
    var centerX = W / 2;
    var y = H * 0.07;

    cx.textAlign = 'center';

    // Header
    cx.font = 'bold 12px monospace';
    cx.fillStyle = '#8694a1';
    cx.fillText('— DIVE TERMINATED —', centerX, y);
    y += 30;
    cx.font = 'bold 46px ' + DCF;
    cx.fillStyle = '#ff4b4b';
    cx.fillText(S('gameOver'), centerX, y);
    y += 40;

    // Failure reason
    cx.font = 'bold 24px ' + DCF;
    cx.fillStyle = '#ffb060';
    cx.fillText(S('gameOverReasons')[gameOverReason] || gameOverReason, centerX, y);
    y += 35;

    cx.textAlign = 'left';
    var textX = centerX - maxTextW / 2;

    var info = S('gameOverInfo')[gameOverReason];
    if (info) {
        // WHAT HAPPENED
        cx.font = 'bold 14px monospace';
        cx.fillStyle = '#fff';
        cx.fillText(S('whatHappened'), textX, y);
        y += 18;
        cx.font = '12px monospace';
        cx.fillStyle = '#aab6c1';
        y = drawWrappedText(cx, info.cause, textX, y, maxTextW, 15);
        y += 12;

        // MEDICAL
        cx.font = 'bold 14px monospace';
        cx.fillStyle = '#ff8a8a';
        cx.fillText(S('medicalLabel'), textX, y);
        y += 18;
        cx.font = '12px monospace';
        cx.fillStyle = '#9aa7b3';
        y = drawWrappedText(cx, info.medical, textX, y, maxTextW, 15);
        y += 12;

        // HOW TO AVOID
        cx.font = 'bold 14px monospace';
        cx.fillStyle = '#46f08f';
        cx.fillText(S('howToAvoid'), textX, y);
        y += 20;
        cx.font = '12px monospace';
        cx.fillStyle = '#9fd8ff';
        for (var i = 0; i < info.prevention.length; i++) {
            var tipText = (i + 1) + '. ' + info.prevention[i];
            y = drawWrappedText(cx, tipText, textX + 10, y, maxTextW - 10, 15);
            y += 4;
        }
        y += 10;
    }

    // Overhead-environment warning — only when the fatal dive was inside a
    // wreck or cave (both flagged hasOverhead). Drawn as a bordered amber box
    // so it reads as a distinct safety callout, not just another tip.
    var ovSite = activeSite();
    if (ovSite && ovSite.hasOverhead) {
        cx.textAlign = 'left';
        var boxX = textX - 12, boxW = maxTextW + 24, boxTop = y - 4;
        // Measure wrapped body height first (measure-only, no draw) so the box
        // can be sized and painted BEFORE the text goes on top of it.
        cx.font = '12px monospace';
        var bodyY = drawWrappedText(cx, S('overheadDanger'), textX, y + 32, maxTextW, 15, true);
        var boxH = (bodyY - boxTop) + 8;
        cx.fillStyle = 'rgba(255,160,40,0.08)';
        cx.strokeStyle = 'rgba(255,160,40,0.55)';
        cx.lineWidth = 1;
        cx.beginPath(); cx.roundRect(boxX, boxTop, boxW, boxH, 8); cx.fill(); cx.stroke();
        // ⚠ title
        cx.font = 'bold 14px monospace';
        cx.fillStyle = '#ffb84d';
        cx.fillText('⚠ ' + S('overheadDangerTitle'), textX, y + 14);
        // body (re-draw over the box)
        cx.font = '12px monospace';
        cx.fillStyle = '#ffd9a0';
        y = drawWrappedText(cx, S('overheadDanger'), textX, y + 32, maxTextW, 15);
        y += 22;
    }

    // Dive stats
    cx.font = '14px monospace';
    cx.fillStyle = '#8694a1';
    cx.textAlign = 'center';
    cx.fillText(S('diveTimeLbl') + ': ' + formatTime(diveTime) + '    ' + S('maxDepthLbl') + ': ' + maxDepth.toFixed(1) + 'm', centerX, y);
    y += 35;

    if (!isTouchDevice) {
        cx.textAlign = 'center';
        cx.font = 'bold 13px monospace';
        var gTxt = S('tryAgain');
        var gW = cx.measureText(gTxt).width + 36;
        cx.beginPath();
        cx.roundRect(centerX - gW / 2, y - 16, gW, 30, 8);
        cx.fillStyle = 'rgba(255,75,75,0.12)';
        cx.fill();
        cx.strokeStyle = 'rgba(255,75,75,0.5)';
        cx.lineWidth = 1;
        cx.stroke();
        cx.fillStyle = '#ff9a9a';
        cx.fillText(gTxt, centerX, y + 4);
    }

    cx.textAlign = 'left';
}

// SECTION: Surface / pre-dive screen
// SEARCH TERMS: drawSurface, surface state

// ============================================================
//  SURFACE SCREEN
// ============================================================

function drawSurface() {
    drawScene();
    drawDiveComputer();

    var cx2 = ctx;
    if (!isTouchDevice) {
        cx2.textAlign = 'center';
        cx2.font = 'bold 20px monospace';
        cx2.fillStyle = 'rgba(255,255,255,0.8)';
        cx2.fillText(S('surfaceDescend'), canvas.width / 2, canvas.height * 0.75);
        cx2.font = '14px monospace';
        cx2.fillStyle = 'rgba(255,255,255,0.5)';
        var tLabel = getActiveTank().label;
        var hintParts = tLabel + ' ' + S('surfaceLoaded') + '  |  ' + S('surfaceHints') + '  |  1-' + tankCount + ' ' + S('surfaceTankHint') + '  |  ' + S('surfaceHelp');
        if (isAdvanced()) hintParts += '  |  ' + S('surfaceGasInfo');
        cx2.fillText(hintParts, canvas.width / 2, canvas.height * 0.80);
    }
    cx2.font = '11px monospace';
    cx2.fillStyle = 'rgba(255,255,255,0.25)';
    cx2.fillText('build ' + (typeof BUILD_VERSION !== 'undefined' ? BUILD_VERSION : 'dev'), canvas.width / 2, canvas.height * 0.85);
    cx2.textAlign = 'left';
}
