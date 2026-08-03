// ============================================================
// FILE: ui.js
// PURPOSE: HTML overlay builders and gas-setup input handler.
//          Builds the responsive touch/mobile gas-setup overlay,
//          processes gas-setup keyboard input, and owns the
//          shared startDiveAction() entry point.
//
// DEPENDS ON:
//   constants.js — S(), gas presets, mode constants, CCR_* limits
//   state.js     — diveMode, ccrState, tanks, tankCount, gameState,
//                  keys, _gsBuilt, _gsNodes
//   physics.js   — calculateMOD() used in overlay gas labels
//
// USED BY:
//   game-loop.js — calls updateGasSetup() each frame during setup phase,
//                  calls buildHtmlGasSetup() on first setup frame
//   touch.js     — startDiveAction() wired to touch start button
//
// KEY FUNCTIONS (grep to find):
//   showHtmlHelp()           — build and show the HTML help overlay
//   updateGasSetup()         — process keyboard input on gas-setup screen
//   buildHtmlGasSetup()      — build full HTML gas-setup overlay (touch/responsive)
//   startDiveAction()        — shared start-dive handler used by keyboard + touch
//   ccrAdjustO2Vol(delta)    — adjust CCR O2 cylinder volume (clamped 2-5 L)
//   ccrAdjustO2Pres(delta)   — adjust CCR O2 cylinder pressure (clamped 50-300 bar)
//   ccrAdjustDilVol(delta)   — adjust CCR diluent cylinder volume
//   ccrAdjustSP(delta)       — adjust CCR setpoint (clamped 0.5-1.6 bar)
// SECTION: Gas setup keyboard input handler
// SEARCH TERMS: updateGasSetup, switchMode, startDiveAction, keys, diveMode toggle

// ============================================================
//  UPDATE LOGIC
// ============================================================

// BUG-CCR-5: Single entry point used by keyboard Enter, the HTML "Start Dive"
// button (OC mode), and the CCR "Start Dive" button. Avoids the fragile
// keys['enter']=true trampoline that used to drive a side-effect from the UI.
function startDiveAction() {
    resetDive();
    gameState = 'surface';
}

function updateGasSetup() {
    // Mode cycling: M key (works in all modes)
    if (keys['m']) {
        keys['m'] = false;
        var modes = ['rec', 'tec', 'ccr'];
        var nextIdx = (modes.indexOf(diveMode) + 1) % modes.length;
        switchMode(modes[nextIdx]);
    }

    // TASK-032A: CCR mode key handling
    if (diveMode === 'ccr') {
        // Diluent presets 1-5
        for (var dp = 1; dp <= 5; dp++) {
            if (keys[String(dp)]) { keys[String(dp)] = false; ccrApplyDilPreset(dp - 1); }
        }
        // Setpoint adjust [ / ]
        if (keys['[']) { keys['['] = false; ccrAdjustSP(-0.1); }
        if (keys[']']) { keys[']'] = false; ccrAdjustSP(0.1); }
        // Diluent cylinder volume , / .
        if (keys[',']) { keys[','] = false; ccrAdjustDilVol(-1); }
        if (keys['.']) { keys['.'] = false; ccrAdjustDilVol(1); }
        // Enter/Space to start dive
        if (keys['enter'] || keys[' ']) {
            keys['enter'] = false; keys[' '] = false;
            startDiveAction();
        }
        return;
    }

    // Preset keys 1-8
    for (var p = 0; p < 8; p++) {
        if (p >= 4 && !isAdvanced()) continue;
        var pk = String(p + 1);
        if (keys[pk]) {
            keys[pk] = false;
            gsApplyPreset(p);
        }
    }

    // Issue #6: documented-but-previously-missing keyboard controls for the
    // gas-setup screen. All handlers here are OC-only by placement — the CCR
    // early-return above already claimed `[` `]` for setpoint and `,` `.` for
    // diluent volume, so nothing here can leak into CCR mode.
    //
    // Touch users get the equivalent controls through the HTML gas-setup
    // overlay (buildHtmlGasSetup()), not through keys[] — the old canvas-era
    // #touch-setup adjust buttons that used to set these same keys[] entries
    // were permanently hidden dead code (touchUpdateUI() never shows
    // #touch-setup during 'gas-setup') and were removed in issue #13.

    // Arrow keys — O2 fraction (available in rec and tec; UI shows O2 always)
    if (keys['arrowleft'])  { keys['arrowleft']  = false; gsAdjustO2(-GAS_SETUP_O2_STEP); }
    if (keys['arrowright']) { keys['arrowright'] = false; gsAdjustO2( GAS_SETUP_O2_STEP); }

    // PgUp / PgDn — tank pressure (available in rec and tec)
    if (keys['pageup'])   { keys['pageup']   = false; gsAdjustPressure( GAS_SETUP_PRESSURE_STEP); }
    if (keys['pagedown']) { keys['pagedown'] = false; gsAdjustPressure(-GAS_SETUP_PRESSURE_STEP); }

    // Advanced-only controls: He, AMV, tank size, tank cycle/add/remove,
    // and GF Low/High. Gated on isAdvanced() so rec-mode key mashing can't
    // silently mutate hidden state (matches how the touch UI hides these
    // sections in rec mode via buildHtmlGasSetup()).
    if (isAdvanced()) {
        // Arrow up/down — He fraction
        if (keys['arrowup'])   { keys['arrowup']   = false; gsAdjustHe( GAS_SETUP_HE_STEP); }
        if (keys['arrowdown']) { keys['arrowdown'] = false; gsAdjustHe(-GAS_SETUP_HE_STEP); }

        // [ / ] — AMV (matches CCR's setpoint direction: [ is negative, ] positive)
        if (keys['[']) { keys['['] = false; gsAdjustAMV(-GAS_SETUP_AMV_STEP); }
        if (keys[']']) { keys[']'] = false; gsAdjustAMV( GAS_SETUP_AMV_STEP); }

        // , / . — tank size (matches CCR's diluent-volume direction: , negative, . positive)
        if (keys[',']) { keys[','] = false; gsAdjustTankVol(-GAS_SETUP_TANK_VOL_STEP); }
        if (keys['.']) { keys['.'] = false; gsAdjustTankVol( GAS_SETUP_TANK_VOL_STEP); }

        // TAB — cycle to the next tank tab (wraps at tankCount). state.js's
        // keydown handler already preventDefault()s Tab so browser focus
        // never leaves the page. Clear both case variants because keydown
        // stored both keys['tab'] (from toLowerCase) and keys['Tab'] (raw
        // e.key) and the corresponding keyup may only see one.
        if (keys['tab'] || keys['Tab']) {
            keys['tab'] = false;
            keys['Tab'] = false;
            if (tankCount > 0) {
                selectedTankTab = (selectedTankTab + 1) % tankCount;
                _gsBuilt = false;
            }
        }

        // + / − — add / remove tank
        if (keys['+']) { keys['+'] = false; gsAddTank(); }
        if (keys['-']) { keys['-'] = false; gsRemoveTank(); }

        // G / Shift+G — GF Low ±5. Both keys['g'] and keys['G'] end up true
        // when Shift+G is pressed (state.js stores both e.key.toLowerCase()
        // and raw e.key). Test the uppercase branch FIRST and clear both,
        // otherwise the else-if below would immediately fire the plain-G
        // handler on the same press.
        if (keys['G']) {
            keys['G'] = false;
            keys['g'] = false;
            gsAdjustGFLow(-GAS_SETUP_GF_STEP);
        } else if (keys['g']) {
            keys['g'] = false;
            gsAdjustGFLow(GAS_SETUP_GF_STEP);
        }

        // F / Shift+F — GF High ±5 (same case-disambiguation as G above).
        if (keys['F']) {
            keys['F'] = false;
            keys['f'] = false;
            gsAdjustGFHigh(-GAS_SETUP_GF_STEP);
        } else if (keys['f']) {
            keys['f'] = false;
            gsAdjustGFHigh(GAS_SETUP_GF_STEP);
        }
    }

    // Enter
    if (keys['enter']) {
        keys['enter'] = false;
        startDiveAction();
    }
}

// SECTION: HTML gas setup overlay (touch/responsive)
// SEARCH TERMS: buildHtmlGasSetup, _gsBuilt, _gsNodes, mkEl, mkActionBtn, ccrAdjustO2Vol, ccrAdjustSP

// ============================================================
//  WP-016: HTML GAS SETUP OVERLAY (touch devices)
// ============================================================

var _gsBuilt = false;
var _gsNodes = {};

function buildHtmlGasSetup() {
    var container = document.querySelector('#html-gas-setup .gs-content');
    if (!_gsBuilt) {
        _gsBuilt = true;
        container.innerHTML = '';

        function mkEl(tag, cls, parent) {
            var el = document.createElement(tag);
            if (cls) el.className = cls;
            (parent || container).appendChild(el);
            return el;
        }

        function mkActionBtn(label, action, parent, cls) {
            var btn = mkEl('button', 'gs-btn' + (cls ? ' ' + cls : ''), parent);
            btn.textContent = label;
            btn.addEventListener('touchstart', function(e) { e.preventDefault(); action(); }, { passive: false });
            btn.addEventListener('click', function() { action(); });
            return btn;
        }

        // Pre-dive kicker + Title
        _gsNodes.kicker = mkEl('div', 'gs-kicker');
        _gsNodes.kicker.textContent = 'PRE-DIVE';
        _gsNodes.title = mkEl('div', 'gs-title');
        _gsNodes.simulationBoundary = mkEl('p', 'gs-simulation-boundary');
        _gsNodes.simulationBoundary.setAttribute('role', 'note');
        _gsNodes.simulationBoundary.textContent = S('simulationBoundary');

        // WP-029: Mode selector row
        var modeRow = mkEl('div', 'gs-row gs-modes');
        modeRow.style.marginBottom = '16px';

        function mkModeBtn(mode, label) {
            var btn = mkEl('button', 'gs-btn', modeRow);
            btn.textContent = label;
            btn.style.minWidth = '70px';
            btn.style.fontSize = '16px';
            btn.dataset.mode = mode;
            btn.addEventListener('touchstart', function(e) {
                e.preventDefault();
                switchMode(mode);
            }, { passive: false });
            btn.addEventListener('click', function() { switchMode(mode); });
            return btn;
        }

        _gsNodes.modeBtnRec = mkModeBtn('rec', S('modeRec'));
        _gsNodes.modeBtnTec = mkModeBtn('tec', S('modeTec'));
        _gsNodes.modeBtnCcr = mkModeBtn('ccr', S('modeCcr'));

        // Phase C: Site selector row (orthogonal to dive mode)
        var siteRow = mkEl('div', 'gs-row gs-modes');
        siteRow.style.marginBottom = '8px';
        function mkSiteBtn(site, label) {
            var btn = mkEl('button', 'gs-btn', siteRow);
            btn.textContent = label;
            btn.style.minWidth = '60px';
            btn.style.fontSize = '14px';
            btn.dataset.site = site;
            function setSite() { diveSite = site; _gsBuilt = false; }
            btn.addEventListener('touchstart', function(e) { e.preventDefault(); setSite(); }, { passive: false });
            btn.addEventListener('click', setSite);
            return btn;
        }
        _gsNodes.siteBtnShore = mkSiteBtn('shore', S('siteShore'));
        _gsNodes.siteBtnReef  = mkSiteBtn('reef',  S('siteReef'));
        _gsNodes.siteBtnWreck = mkSiteBtn('wreck', S('siteWreck'));
        _gsNodes.siteBtnCave  = mkSiteBtn('cave',  S('siteCave'));

        // TASK-032A: CCR setup section
        _gsNodes.ccrSection = mkEl('div', 'gs-section');

        // --- O2 cylinder card ---
        var ccrO2Card = mkEl('div', 'gs-card gs-card-stack', _gsNodes.ccrSection);
        _gsNodes.ccrO2CylValue = mkEl('div', 'gs-value gs-card-head', ccrO2Card);
        _gsNodes.ccrO2CylValue.style.color = '#46f08f';
        _gsNodes.ccrO2CylValue.style.fontSize = '18px';

        var ccrO2BtnWrap = mkEl('div', 'gs-card-btns', ccrO2Card);
        var ccrO2VolRow = mkEl('div', 'gs-row', ccrO2BtnWrap);
        mkActionBtn('− L', function() { ccrAdjustO2Vol(-1); }, ccrO2VolRow);
        mkActionBtn('+ L', function() { ccrAdjustO2Vol(1); }, ccrO2VolRow);

        var ccrO2PresRow = mkEl('div', 'gs-row', ccrO2BtnWrap);
        mkActionBtn('P −', function() { ccrAdjustO2Pres(-CCR_O2_PRES_STEP); }, ccrO2PresRow);
        mkActionBtn('P +', function() { ccrAdjustO2Pres(CCR_O2_PRES_STEP); }, ccrO2PresRow);

        // --- Diluent card ---
        var ccrDilCard = mkEl('div', 'gs-card gs-card-stack', _gsNodes.ccrSection);
        _gsNodes.ccrDilLabel = mkEl('div', 'gs-value gs-card-head', ccrDilCard);
        _gsNodes.ccrDilLabel.style.color = '#67d4ff';
        _gsNodes.ccrDilLabel.style.fontSize = '18px';
        var ccrDilRow = mkEl('div', 'gs-row gs-chiprow', ccrDilCard);
        mkActionBtn(S('ccrDilAir'), function() { ccrApplyDilPreset(0); }, ccrDilRow);
        mkActionBtn(S('ccrDilTmx2135'), function() { ccrApplyDilPreset(1); }, ccrDilRow);
        mkActionBtn(S('ccrDilTmx1545'), function() { ccrApplyDilPreset(2); }, ccrDilRow);
        mkActionBtn(S('ccrDilTmx1070'), function() { ccrApplyDilPreset(3); }, ccrDilRow);
        mkActionBtn(S('ccrDilHeliox'), function() { ccrApplyDilPreset(4); }, ccrDilRow);

        var ccrDilCylWrap = mkEl('div', 'gs-card-sub', ccrDilCard);
        _gsNodes.ccrDilCylValue = mkEl('div', 'gs-label', ccrDilCylWrap);
        _gsNodes.ccrDilCylValue.style.color = '#8694a1';
        _gsNodes.ccrDilCylValue.style.fontSize = '13px';
        var ccrDilCylRow = mkEl('div', 'gs-row', ccrDilCylWrap);
        mkActionBtn('\u2212 L', function() { ccrAdjustDilVol(-1); }, ccrDilCylRow);
        mkActionBtn('+ L', function() { ccrAdjustDilVol(1); }, ccrDilCylRow);

        // --- Setpoint card ---
        var ccrSPCard = mkEl('div', 'gs-card gs-card-stack', _gsNodes.ccrSection);
        var ccrSPTop = mkEl('div', 'gs-card-sub', ccrSPCard);
        _gsNodes.ccrSPValue = mkEl('div', 'gs-value gs-card-head', ccrSPTop);
        _gsNodes.ccrSPValue.style.color = '#ffcc00';
        _gsNodes.ccrSPValue.style.fontSize = '18px';
        var ccrSPRow = mkEl('div', 'gs-row', ccrSPTop);
        mkActionBtn('SP \u2212', function() { ccrAdjustSP(-0.1); }, ccrSPRow);
        mkActionBtn('SP +', function() { ccrAdjustSP(0.1); }, ccrSPRow);

        _gsNodes.ccrScrubberValue = mkEl('div', 'gs-label', ccrSPCard);
        _gsNodes.ccrScrubberValue.style.color = '#8694a1';
        _gsNodes.ccrScrubberValue.style.fontSize = '13px';

        // CCR start button — BUG-CCR-5: centred via a gs-row wrapper instead
        // of relying on `margin: auto` (which doesn't apply inside the column
        // flex layout). BUG-CCR-5 also: call startDiveAction() directly.
        var ccrStartRow = mkEl('div', 'gs-row gs-ccr-start', _gsNodes.ccrSection);
        ccrStartRow.style.marginTop = '4px';
        _gsNodes.ccrStartRow = ccrStartRow;
        _gsNodes.ccrStartBtn = mkEl('button', 'gs-btn gs-accent', ccrStartRow);
        _gsNodes.ccrStartBtn.addEventListener('touchstart', function(e) {
            e.preventDefault();
            startDiveAction();
        }, { passive: false });
        _gsNodes.ccrStartBtn.addEventListener('click', function() {
            startDiveAction();
        });

        // Tank tabs (advanced only)
        _gsNodes.tankTabsSection = mkEl('div', 'gs-section');
        _gsNodes.tankTabsRow = mkEl('div', 'gs-row', _gsNodes.tankTabsSection);

        // O2 section
        _gsNodes.o2Section = mkEl('div', 'gs-section gs-card');
        _gsNodes.o2Value = mkEl('div', 'gs-value', _gsNodes.o2Section);
        _gsNodes.o2Value.style.color = '#46f08f';
        var o2Row = mkEl('div', 'gs-row', _gsNodes.o2Section);
        mkActionBtn('O\u2082 \u2212', function() { gsAdjustO2(-0.01); }, o2Row);
        mkActionBtn('O\u2082 +', function() { gsAdjustO2(0.01); }, o2Row);

        // He section (advanced only)
        _gsNodes.heSection = mkEl('div', 'gs-section gs-card');
        _gsNodes.heValue = mkEl('div', 'gs-value', _gsNodes.heSection);
        _gsNodes.heValue.style.color = '#44ccff';
        _gsNodes.heValue.style.fontSize = '26px';
        var heRow = mkEl('div', 'gs-row', _gsNodes.heSection);
        mkActionBtn('He \u2212', function() { gsAdjustHe(-0.01); }, heRow);
        mkActionBtn('He +', function() { gsAdjustHe(0.01); }, heRow);

        // N2 (read-only) — BUG-CCR-6: parent under o2Section so it sits with
        // the rest of the OC gas controls instead of floating at container root.
        _gsNodes.n2Value = mkEl('div', 'gs-label', _gsNodes.o2Section);
        _gsNodes.n2Value.style.fontSize = '13px';
        _gsNodes.n2Value.style.color = '#8694a1';
        _gsNodes.n2Value.style.margin = '0';
        // Mix bar (O2 vs N2) — matches redesign mockup
        _gsNodes.o2MixBar = mkEl('div', 'gs-mixbar', _gsNodes.o2Section);
        _gsNodes.o2MixO2 = mkEl('i', 'o2', _gsNodes.o2MixBar);
        _gsNodes.o2MixHe = mkEl('i', 'he', _gsNodes.o2MixBar);
        _gsNodes.o2MixN2 = mkEl('i', 'n2', _gsNodes.o2MixBar);

        // Pressure section
        _gsNodes.presSection = mkEl('div', 'gs-section gs-card');
        _gsNodes.presValue = mkEl('div', 'gs-value', _gsNodes.presSection);
        _gsNodes.presValue.style.fontSize = '20px';
        var presRow = mkEl('div', 'gs-row', _gsNodes.presSection);
        mkActionBtn('P \u2212', function() { gsAdjustPressure(-10); }, presRow);
        mkActionBtn('P +', function() { gsAdjustPressure(10); }, presRow);

        // MOD + Label
        _gsNodes.modLabel = mkEl('div', 'gs-label gs-mod');
        _gsNodes.modLabel.style.margin = '0 0 16px';

        // AMV section (advanced only)
        _gsNodes.amvSection = mkEl('div', 'gs-section gs-card');
        _gsNodes.amvValue = mkEl('div', 'gs-value', _gsNodes.amvSection);
        _gsNodes.amvValue.style.fontSize = '20px';
        _gsNodes.amvValue.style.color = '#ffcc00';
        var amvRow = mkEl('div', 'gs-row', _gsNodes.amvSection);
        mkActionBtn('AMV \u2212', function() { gsAdjustAMV(-1); }, amvRow);
        mkActionBtn('AMV +', function() { gsAdjustAMV(1); }, amvRow);

        // Tank size section (advanced only)
        _gsNodes.tankSizeSection = mkEl('div', 'gs-section gs-card');
        _gsNodes.tankSizeValue = mkEl('div', 'gs-value', _gsNodes.tankSizeSection);
        _gsNodes.tankSizeValue.style.fontSize = '20px';
        _gsNodes.tankSizeValue.style.color = '#66ccff';
        var tankSizeRow = mkEl('div', 'gs-row', _gsNodes.tankSizeSection);
        mkActionBtn('\u2212 L', function() { gsAdjustTankVol(-1); }, tankSizeRow);
        mkActionBtn('+ L', function() { gsAdjustTankVol(1); }, tankSizeRow);

        // Switch depth section (Tec mode, tanks 2-4 only)
        _gsNodes.switchDepthSection = mkEl('div', 'gs-section');
        _gsNodes.switchDepthLabel = mkEl('div', 'gs-value', _gsNodes.switchDepthSection);
        _gsNodes.switchDepthLabel.style.fontSize = '18px';
        _gsNodes.switchDepthLabel.style.color = '#99ddff';
        var switchDepthRow = mkEl('div', 'gs-switch-depth-row', _gsNodes.switchDepthSection);
        mkActionBtn('\u2212 3m', function() { gsAdjustSwitchDepth(-3); }, switchDepthRow);
        mkActionBtn('+ 3m', function() { gsAdjustSwitchDepth(3); }, switchDepthRow);

        // GF display (advanced only)
        _gsNodes.gfSection = mkEl('div', 'gs-section');
        _gsNodes.gfValue = mkEl('div', 'gs-value', _gsNodes.gfSection);
        _gsNodes.gfValue.style.fontSize = '18px';
        _gsNodes.gfValue.style.color = '#ff9966';
        var gfRow = mkEl('div', 'gs-row', _gsNodes.gfSection);
        mkActionBtn('GFL\u2212', function() { gsAdjustGFLow(-5); }, gfRow);
        mkActionBtn('GFL+', function() { gsAdjustGFLow(5); }, gfRow);
        mkActionBtn('GFH\u2212', function() { gsAdjustGFHigh(-5); }, gfRow);
        mkActionBtn('GFH+', function() { gsAdjustGFHigh(5); }, gfRow);

        // Presets
        _gsNodes.presetsDiv = mkEl('div', 'gs-presets');

        // Extras row
        var extrasRow = mkEl('div', 'gs-extras gs-footer');
        var langBtn = mkEl('button', 'gs-btn', extrasRow);
        langBtn.textContent = 'Language';
        langBtn.style.fontSize = '13px';
        langBtn.style.flexDirection = 'column';
        langBtn.style.minHeight = '56px';
        _gsNodes.langBtn = langBtn;
        langBtn.addEventListener('touchstart', function(e) {
            e.preventDefault();
            currentLang = currentLang === 'en' ? 'de' : 'en';
            _gsBuilt = false;
        }, { passive: false });
        langBtn.addEventListener('click', function() {
            currentLang = currentLang === 'en' ? 'de' : 'en';
            _gsBuilt = false;
        });

        // Issue #39: HUD palette toggle — sits next to the language button
        // in every mode (rec / tec / ccr). Persists via localStorage inside
        // setHudColorMode(). id lets tests locate the button without a
        // language-dependent text query.
        var colorsBtn = mkEl('button', 'gs-btn', extrasRow);
        colorsBtn.id = 'gs-colors-toggle';
        colorsBtn.style.fontSize = '13px';
        colorsBtn.style.flexDirection = 'column';
        colorsBtn.style.minHeight = '56px';
        _gsNodes.colorsBtn = colorsBtn;
        colorsBtn.addEventListener('touchstart', function(e) {
            e.preventDefault();
            toggleHudColorMode();
            _gsBuilt = false;
        }, { passive: false });
        colorsBtn.addEventListener('click', function() {
            toggleHudColorMode();
            _gsBuilt = false;
        });

        // Issue #45: Training Drills opt-in toggle. Placed in the extras
        // footer next to Language so it's visible in every mode/site and
        // does not shift the primary Start Dive affordance. Matches the
        // gs-btn styling used by every other row here — border-color +
        // background change track the on/off state (updated below on each
        // frame the way the mode buttons do via `_mc`).
        _gsNodes.drillsBtn = mkEl('button', 'gs-btn', extrasRow);
        _gsNodes.drillsBtn.style.fontSize = '13px';
        _gsNodes.drillsBtn.style.flexDirection = 'column';
        _gsNodes.drillsBtn.style.minHeight = '56px';
        function _toggleDrills() { drillsEnabled = !drillsEnabled; _gsBuilt = false; }
        _gsNodes.drillsBtn.addEventListener('touchstart', function(e) {
            e.preventDefault(); _toggleDrills();
        }, { passive: false });
        _gsNodes.drillsBtn.addEventListener('click', _toggleDrills);

        // Start dive button — BUG-CCR-5: call startDiveAction() directly.
        _gsNodes.startBtn = mkEl('button', 'gs-btn gs-accent', extrasRow);
        _gsNodes.startBtn.addEventListener('touchstart', function(e) {
            e.preventDefault();
            startDiveAction();
        }, { passive: false });
        _gsNodes.startBtn.addEventListener('click', function() {
            startDiveAction();
        });

        // Build preset buttons
        var presetCount = isAdvanced() ? 8 : 4;
        _gsNodes.presetsDiv.innerHTML = '';
        for (var pi = 0; pi < presetCount; pi++) {
            (function(idx) {
                mkActionBtn(GAS_PRESETS[idx].name, function() { gsApplyPreset(idx); }, _gsNodes.presetsDiv);
            })(pi);
        }

        // Build tank tab buttons (advanced)
        _gsNodes.tankTabsRow.innerHTML = '';
        if (isAdvanced()) {
            for (var ti = 0; ti < tankCount; ti++) {
                (function(idx) {
                    var tb = mkEl('button', 'gs-btn', _gsNodes.tankTabsRow);
                    tb.textContent = 'Tank ' + (idx + 1);
                    tb.style.borderColor = (idx === selectedTankTab) ? '#33ff99' : 'rgba(255,255,255,0.25)';
                    tb.addEventListener('touchstart', function(e) {
                        e.preventDefault();
                        selectedTankTab = idx;
                        _gsBuilt = false;
                    }, { passive: false });
                    tb.addEventListener('click', function() {
                        selectedTankTab = idx;
                        _gsBuilt = false;
                    });
                })(ti);
            }
            mkActionBtn('+', gsAddTank, _gsNodes.tankTabsRow);
            mkActionBtn('\u2212', gsRemoveTank, _gsNodes.tankTabsRow);
        }

        // Visibility for advanced sections
        var isCcr = (diveMode === 'ccr');
        _gsNodes.tankTabsSection.style.display = isAdvanced() && !isCcr ? '' : 'none';
        _gsNodes.heSection.style.display = isAdvanced() && !isCcr ? '' : 'none';
        _gsNodes.amvSection.style.display = isAdvanced() && !isCcr ? '' : 'none';
        _gsNodes.tankSizeSection.style.display = isAdvanced() && !isCcr ? '' : 'none';
        _gsNodes.switchDepthSection.style.display = 'none'; // DISABLED: Staging of bottles
        _gsNodes.gfSection.style.display = isAdvanced() && !isCcr ? '' : 'none';

        // CCR vs normal gas config visibility
        _gsNodes.ccrSection.style.display = isCcr ? 'block' : 'none';
        _gsNodes.o2Section.style.display = isCcr ? 'none' : '';
        _gsNodes.n2Value.style.display = isCcr ? 'none' : '';
        _gsNodes.presSection.style.display = isCcr ? 'none' : '';
        _gsNodes.modLabel.style.display = isCcr ? 'none' : '';
        _gsNodes.presetsDiv.style.display = isCcr ? 'none' : '';
        // Sprache + Start Dive share the same footer in every mode; the
        // CCR-only in-section start button is retired so the footer is consistent.
        _gsNodes.startBtn.style.display = '';
        _gsNodes.ccrStartRow.style.display = 'none';
    }

    // Update text values each frame
    var t = tanks[selectedTankTab];
    _gsNodes.title.textContent = S('gasSetupTitle');
    _gsNodes.simulationBoundary.textContent = S('simulationBoundary');

    // WP-029: Mode button highlighting
    var _mc = function(btn, on) {
        btn.style.borderColor = on ? 'rgba(70,240,143,0.52)' : 'transparent';
        btn.style.color = on ? '#46f08f' : 'rgba(155,180,195,0.55)';
        btn.style.background = on ? 'rgba(70,240,143,0.15)' : 'transparent';
        btn.style.boxShadow = on ? '0 0 14px rgba(70,240,143,0.10)' : '';
    };
    _mc(_gsNodes.modeBtnRec, diveMode === 'rec');
    _mc(_gsNodes.modeBtnTec, diveMode === 'tec');
    _mc(_gsNodes.modeBtnCcr, diveMode === 'ccr');
    _mc(_gsNodes.siteBtnShore, diveSite === 'shore');
    _mc(_gsNodes.siteBtnReef,  diveSite === 'reef');
    _mc(_gsNodes.siteBtnWreck, diveSite === 'wreck');
    _mc(_gsNodes.siteBtnCave,  diveSite === 'cave');

    // TASK-032A: CCR section values
    _gsNodes.ccrO2CylValue.textContent = S('ccrO2Cyl') + ': ' + ccrState.o2CylPressure + 'bar \u00D7 ' + ccrState.o2CylVolume + 'L';
    _gsNodes.ccrDilLabel.textContent = S('ccrDiluent') + ': ' + ccrDilPresetName();
    _gsNodes.ccrDilCylValue.textContent = S('ccrDilCyl') + ': ' + ccrState.dilCylPressure + 'bar \u00D7 ' + ccrState.dilCylVolume + 'L';
    _gsNodes.ccrSPValue.textContent = S('ccrSetpoint') + ': ' + ccrState.targetSP.toFixed(1) + ' bar';
    _gsNodes.ccrScrubberValue.textContent = S('ccrScrubber') + ': ' + ccrState.scrubberRemaining + ' min';
    _gsNodes.ccrStartBtn.textContent = S('startDive');

    _gsNodes.o2Value.textContent = 'O\u2082 ' + Math.round(t.fO2 * 100) + '%';
    _gsNodes.heValue.textContent = 'He ' + Math.round(t.fHe * 100) + '%';
    _gsNodes.n2Value.textContent = 'N\u2082 ' + Math.round(t.fN2 * 100) + '%';
    if (_gsNodes.o2MixO2) {
        var _o2pct = Math.round(t.fO2 * 100);
        var _hepct = Math.round((t.fHe || 0) * 100);
        _gsNodes.o2MixO2.style.width = _o2pct + '%';
        if (_gsNodes.o2MixHe) _gsNodes.o2MixHe.style.width = _hepct + '%';
        _gsNodes.o2MixN2.style.width = Math.max(0, 100 - _o2pct - _hepct) + '%';
    }
    _gsNodes.presValue.textContent = S('pressure') + ': ' + t.pressure + ' bar';
    var mod = calculateMOD(t.fO2);
    _gsNodes.modLabel.textContent = 'MOD (PO2 1.4): ' + mod.toFixed(0) + 'm  |  ' + t.label;
    _gsNodes.amvValue.textContent = S('amvLabel') + ': ' + amvRate + ' L/min';
    _gsNodes.tankSizeValue.textContent = S('tankSizeLabel') + ': ' + tanks[selectedTankTab].volume + ' L';
    // DISABLED: Staging of bottles — switch depth UI hidden
    if (_gsNodes.switchDepthSection) {
        _gsNodes.switchDepthSection.style.display = 'none';
    }
    _gsNodes.gfValue.textContent = S('gfLowLabel') + ': ' + gfLow + '%  /  ' + S('gfHighLabel') + ': ' + gfHigh + '%';
    _gsNodes.startBtn.textContent = S('startDive');
    _gsNodes.langBtn.textContent = currentLang === 'en' ? 'Sprache' : 'Language';
    document.getElementById('touch-setup-lang').textContent = currentLang === 'en' ? 'Sprache' : 'Language';
    // Issue #39: colour-mode label follows the same two-string EN/DE pattern.
    // Text shows the mode you would SWITCH TO on tap (mirrors langBtn's UX).
    if (_gsNodes.colorsBtn) {
        var _isDefault = hudColorMode === 'default';
        _gsNodes.colorsBtn.textContent = currentLang === 'en'
            ? (_isDefault ? 'Colors: Standard' : 'Colors: Colorblind')
            : (_isDefault ? 'Farben: Standard' : 'Farben: Farbenblind');
    }
    // Issue #45: Training Drills toggle — label + on/off tint.
    if (_gsNodes.drillsBtn) {
        _gsNodes.drillsBtn.textContent = S('drillsToggleLabel') + ': ' + (drillsEnabled ? 'ON' : 'OFF');
        _gsNodes.drillsBtn.style.borderColor = drillsEnabled ? 'rgba(70,240,143,0.55)' : 'rgba(255,255,255,0.25)';
        _gsNodes.drillsBtn.style.background = drillsEnabled ? 'rgba(70,240,143,0.14)' : 'rgba(255,255,255,0.05)';
        _gsNodes.drillsBtn.style.color = drillsEnabled ? '#46f08f' : '#c9d3df';
    }
}
