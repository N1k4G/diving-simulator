// ============================================================
// FILE: touch.js
// PURPOSE: Mobile and desktop HTML button controls. Binds touch/click
//          handlers to game actions and updates button visibility each
//          frame based on game state.
//
//          Loaded LAST — monkey-patches gameLoop() from game-loop.js
//          to inject touchUpdateUI() into the render loop.
//
// DEPENDS ON:
//   constants.js — S()
//   state.js     — gameState, diveMode, ccrState, tanks, tankCount, keys
//   game-loop.js — gameLoop (patched here via _realGameLoop)
//   ui.js        — startDiveAction()
//
// KEY FUNCTIONS (grep to find):
//   initTouchControls()             — bind all touch/click button handlers on startup
//   touchUpdateUI()                 — show/hide buttons per current game state (called every frame)
//   updateCcrDiveButtonVisibility() — show CCR-specific buttons (bailout, SP+, SP-)
//   bindTap(el, key)                — wire an element to simulate a keyboard key press
//   bindTapPressRelease(el, key)    — wire with keydown/keyup simulation for held keys
// SECTION: Mobile and desktop touch controls
// SEARCH TERMS: initTouchControls, touchUpdateUI, updateCcrDiveButtonVisibility, bindTap, bindTapPressRelease, isTouchDevice

// ============================================================
// ============================================================
//  WP-014: MOBILE TOUCH CONTROLS
// ============================================================

var isTouchDevice = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);

// BUG-CCR-1/2/7: Shared single-tap binder. Lives outside initTouchControls so
// the CCR in-dive buttons (bailout, SP+, SP-) can be wired on desktop too.
function bindTapPressRelease(btn, keyName) {
    btn.addEventListener('touchstart', function(e) {
        e.preventDefault();
        keys[keyName] = true;
        btn.classList.add('active');
        setTimeout(function() { keys[keyName] = false; btn.classList.remove('active'); }, 100);
    }, { passive: false });
    btn.addEventListener('click', function() {
        keys[keyName] = true;
        btn.classList.add('active');
        setTimeout(function() { keys[keyName] = false; btn.classList.remove('active'); }, 100);
    });
}

// BUG-CCR-1/2/7: Wire CCR in-dive buttons regardless of isTouchDevice so
// desktop users can also click Bailout / SP+ / SP-. Called from the touch-ui
// bootstrap below and again here unconditionally.
(function initCcrDiveButtons() {
    var bailoutBtn = document.getElementById('touch-dive-bailout');
    var spUpBtn = document.getElementById('touch-ccr-sp-up');
    var spDownBtn = document.getElementById('touch-ccr-sp-down');
    if (bailoutBtn) bindTapPressRelease(bailoutBtn, 'b');
    if (spUpBtn) bindTapPressRelease(spUpBtn, ']');
    if (spDownBtn) bindTapPressRelease(spDownBtn, '[');
})();

// Navigation D-pad (ascend / descend / left / right). Bound with POINTER events
// so the same four buttons work with a finger (touch) and a mouse (desktop).
// Held while pressed, released on up/leave/cancel. Pointer capture keeps the
// key held even if the finger/cursor slides slightly off the button.
function bindHold(btn, keyName) {
    function press(e) {
        if (e.cancelable) e.preventDefault();
        keys[keyName] = true;
        btn.classList.add('active');
        if (e.pointerId != null && btn.setPointerCapture) {
            try { btn.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        }
    }
    function release() {
        keys[keyName] = false;
        btn.classList.remove('active');
    }
    btn.addEventListener('pointerdown', press);
    btn.addEventListener('pointerup', release);
    btn.addEventListener('pointercancel', release);
    btn.addEventListener('pointerleave', release);
}

// Wire the four nav buttons + set their labels: arrow glyphs on touch devices,
// W/A/S/D on desktop (matching the keyboard controls).
(function initNavPad() {
    var keyOf = { 'touch-dive-ascend': 'w', 'touch-dive-left': 'a', 'touch-dive-descend': 's', 'touch-dive-right': 'd' };
    var glyph = isTouchDevice
        ? { 'touch-dive-ascend': '▲', 'touch-dive-left': '◄', 'touch-dive-descend': '▼', 'touch-dive-right': '►' }
        : { 'touch-dive-ascend': 'W', 'touch-dive-left': 'A', 'touch-dive-descend': 'S', 'touch-dive-right': 'D' };
    Object.keys(keyOf).forEach(function(id) {
        var b = document.getElementById(id);
        if (!b) return;
        b.textContent = glyph[id];
        bindHold(b, keyOf[id]);
    });
})();

(function initTouchControls() {
    var touchUI = document.getElementById('touch-ui');
    if (!isTouchDevice) return;
    touchUI.style.display = 'block';

    // --- Helper: bind touch to key ---
    function bindKey(btn, keyName) {
        btn.addEventListener('touchstart', function(e) {
            e.preventDefault();
            keys[keyName] = true;
            btn.classList.add('active');
        }, { passive: false });
        btn.addEventListener('touchend', function(e) {
            e.preventDefault();
            keys[keyName] = false;
            btn.classList.remove('active');
        }, { passive: false });
        btn.addEventListener('touchcancel', function(e) {
            keys[keyName] = false;
            btn.classList.remove('active');
        });
    }

    // --- Helper: single tap (press + release) ---
    function bindTap(btn, keyName) {
        btn.addEventListener('touchstart', function(e) {
            e.preventDefault();
            keys[keyName] = true;
            btn.classList.add('active');
            setTimeout(function() { keys[keyName] = false; btn.classList.remove('active'); }, 100);
        }, { passive: false });
    }

    // --- Diving controls ---
    // (ascend/descend/left/right live in #touch-dpad and are bound unconditionally
    //  via pointer events in initNavPad() below, so they work on desktop too.)
    document.getElementById('touch-dive-help').addEventListener('touchstart', function(e) {
        e.preventDefault();
        if (gameState !== 'gas-setup') { showHelp = !showHelp; if (showHelp) showGasInfo = false; }
    }, { passive: false });
    // TASK-031D: Gas info touch button
    document.getElementById('touch-gas-info').addEventListener('touchstart', function(e) {
        e.preventDefault();
        // BUG-CCR-3: gas-info touch button now also functions in CCR mode,
        // using the same CCR-aware cycling logic as the I key handler.
        if ((isAdvanced() || diveMode === 'ccr') && gameState === 'diving') {
            if (diveMode === 'ccr') {
                infoPageMode = (infoPageMode === 5) ? 0 : 5;
            } else {
                infoPageMode++;
                if (infoPageMode === 2 && tankCount <= 3) infoPageMode++;
                if (infoPageMode > (tankCount > 3 ? 4 : 3)) infoPageMode = 0;
            }
        }
    }, { passive: false });
    document.getElementById('touch-fast-forward').addEventListener('touchstart', function(e) {
        e.preventDefault();
        keys['f'] = true;
        setTimeout(function() { keys['f'] = false; }, 100);
    });
    // D6: Torch toggle button — single tap sends 't' key
    document.getElementById('touch-torch').addEventListener('touchstart', function(e) {
        e.preventDefault();
        keys['t'] = true;
        setTimeout(function() { keys['t'] = false; }, 100);
    });

    // --- Gas setup O2/He/Pressure ---
    var adjBtns = document.querySelectorAll('.t-setup-adj .t-btn[data-key]');
    for (var i = 0; i < adjBtns.length; i++) {
        (function(btn) {
            var k = btn.getAttribute('data-key');
            bindTap(btn, k);
        })(adjBtns[i]);
    }

    // Language toggle
    document.getElementById('touch-setup-lang').addEventListener('touchstart', function(e) {
        e.preventDefault();
        if (gameState === 'gas-setup') currentLang = currentLang === 'en' ? 'de' : 'en';
        this.textContent = currentLang === 'en' ? 'Sprache' : 'Language';
    }, { passive: false });

    // Start dive
    bindTap(document.getElementById('touch-setup-start'), 'enter');

    // Surface descend
    bindKey(document.getElementById('touch-surface-btn'), 's');

    // Game over restart
    bindTap(document.getElementById('touch-gameover-btn'), 'enter');

    // Post-dive restart
    bindTap(document.getElementById('touch-postdive-btn'), 'enter');
})();

// BUG-CCR-1/2/7: visibility for the CCR-only in-dive buttons. Runs on every
// frame regardless of isTouchDevice so desktop users see them too. The buttons
// themselves live inside #touch-ui which uses pointer-events:none with the
// individual .t-btn elements re-enabling pointer-events, so this never blocks
// non-CCR clicks.
function updateCcrDiveButtonVisibility() {
    var bailoutBtn = document.getElementById('touch-dive-bailout');
    var spUpBtn = document.getElementById('touch-ccr-sp-up');
    var spDownBtn = document.getElementById('touch-ccr-sp-down');
    if (!bailoutBtn || !spUpBtn || !spDownBtn) return;
    var touchUI = document.getElementById('touch-ui');
    var showCcr = gameState === 'diving'
        && diveMode === 'ccr'
        && !ccrState.onBailout
        && !showHelp
        && !showGasInfo;
    // SP buttons hide on bailout; bailout button hides once already on bailout.
    bailoutBtn.style.display = showCcr ? 'flex' : 'none';
    spUpBtn.style.display = showCcr ? 'flex' : 'none';
    spDownBtn.style.display = showCcr ? 'flex' : 'none';
    // On desktop the parent #touch-ui is hidden by default, and the
    // #touch-dive .t-group has display:none in CSS, so both need to be
    // explicitly shown for our CCR buttons to be visible/clickable. The
    // #touch-ui container is pointer-events:none so it doesn't intercept
    // other input. The touch-device branch of touchUpdateUI manages these
    // containers itself, so only override them here on desktop.
    if (!isTouchDevice && touchUI) {
        touchUI.style.display = showCcr ? 'block' : 'none';
        var diveGroup = document.getElementById('touch-dive');
        if (diveGroup) diveGroup.style.display = showCcr ? 'block' : 'none';
    }
}

// Show/hide the navigation D-pad each frame. Runs on desktop + touch: the pad
// is visible whenever the diver is actually diving (and no overlay covers the
// screen). On desktop the parent #touch-ui is hidden by default, so reveal it
// here when the pad should show. Called AFTER updateCcrDiveButtonVisibility()
// so the pad has the final say on the desktop #touch-ui container.
function updateNavPadVisibility() {
    var pad = document.getElementById('touch-dpad');
    if (!pad) return;
    var show = gameState === 'diving' && !showHelp && !showGasInfo;
    pad.style.display = show ? 'block' : 'none';
    if (!isTouchDevice && show) {
        var touchUI = document.getElementById('touch-ui');
        if (touchUI) touchUI.style.display = 'block';
    }
}

// Update touch UI visibility each frame
function touchUpdateUI() {
    // Always evaluate CCR-button + nav-pad visibility (desktop + touch).
    updateCcrDiveButtonVisibility();
    updateNavPadVisibility();
    if (!isTouchDevice) return;
    var groups = ['touch-dive', 'touch-setup', 'touch-surface', 'touch-gameover', 'touch-postdive'];
    for (var g = 0; g < groups.length; g++) {
        document.getElementById(groups[g]).style.display = 'none';
    }
    if (showHelp || showGasInfo) return; // hide all when help or gas info is shown

    switch (gameState) {
        case 'diving':
            document.getElementById('touch-dive').style.display = 'block';
            // Update tank buttons
            var tankDiv = document.getElementById('touch-dive-tanks');
            var needed = tankCount > 1 ? tankCount : 0;
            while (tankDiv.children.length < needed) {
                var idx = tankDiv.children.length + 1;
                var btn = document.createElement('button');
                btn.className = 't-btn';
                btn.textContent = 'T' + idx;
                (function(k) {
                    btn.addEventListener('touchstart', function(e) {
                        e.preventDefault();
                        keys[k] = true;
                        setTimeout(function() { keys[k] = false; }, 100);
                    }, { passive: false });
                })(String(idx));
                tankDiv.appendChild(btn);
            }
            while (tankDiv.children.length > needed) {
                tankDiv.removeChild(tankDiv.lastChild);
            }
            for (var ti = 0; ti < tankDiv.children.length; ti++) {
                tankDiv.children[ti].style.borderColor = (ti === activeTank) ? '#33ff99' : 'rgba(255,255,255,0.25)';
            }
            // TASK-031D: Show gas info button only in Tec mode
            // BUG-CCR-3: gas-info button is visible in CCR as well as Tec.
            document.getElementById('touch-gas-info').style.display = (isAdvanced() || diveMode === 'ccr') ? 'flex' : 'none';
            var decoStopFF = decoStop(calculateCeiling());
            var atDecoFF = decoStopFF > 0 && Math.abs(depth - decoStopFF) <= 1.5;
            var atSafetyFF = safetyStopCountdownStarted && !safetyStopComplete && Math.abs(depth - 5) <= 1.5;
            var isStationary = Math.abs(ascentRate) < 0.5;
            var ffBtn = document.getElementById('touch-fast-forward');
            ffBtn.style.display = ((atDecoFF || atSafetyFF) && isStationary) ? 'flex' : 'none';
            ffBtn.style.borderColor = fastForwardActive ? '#33ff99' : 'rgba(255,255,255,0.25)';
            ffBtn.style.background = fastForwardActive ? 'rgba(51,255,153,0.2)' : 'rgba(255,255,255,0.12)';
            // D6: Torch button — visible inside overhead sites; reflects torchOn state
            var torchBtn = document.getElementById('touch-torch');
            var _siteHasOverhead = activeSite() && activeSite().hasOverhead;
            torchBtn.style.display = _siteHasOverhead ? 'flex' : 'none';
            torchBtn.classList.toggle('torch-on',  !!torchOn);
            torchBtn.classList.toggle('torch-off', !torchOn);
            var _torchSub = torchBtn.querySelector('.t-btn-sub');
            if (_torchSub && _torchSub.textContent !== S('torchLabel')) _torchSub.textContent = S('torchLabel');
            break;
        case 'gas-setup':
            // WP-016: HTML gas-setup overlay replaces old touch-setup buttons
            // touch-setup is hidden (already set to none above)
            // html-gas-setup is managed by the game loop
            break;
        case 'surface':
            document.getElementById('touch-surface').style.display = 'block';
            document.getElementById('touch-surface-btn').textContent = S('surfaceDescend');
            break;
        case 'gameover':
            document.getElementById('touch-gameover').style.display = 'block';
            document.getElementById('touch-gameover-btn').textContent = S('tryAgain');
            break;
        case 'post-dive':
            document.getElementById('touch-postdive').style.display = 'block';
            document.getElementById('touch-postdive-btn').textContent = S('diveAgain');
            break;
    }
}

// Inject touch update into game loop
var _realGameLoop = gameLoop;
gameLoop = function(timestamp) {
    _realGameLoop(timestamp);
    touchUpdateUI();
};
// Re-register with rAF since bootstrap already called it
// (the first frame will call the old ref, but subsequent frames use the new one)