// WP-01 baseline diagnostics.
//
// The collector is opt-in so ordinary and deployed sessions pay only a few
// boolean checks. Enable it with `?diagnostics=1`. A later Vite entry can omit
// this file entirely from production builds without changing the evidence
// contract.
(function() {
    'use strict';

    var FRAME_BUDGET_MS = 16.67;
    var MAX_SAMPLES = 1200;
    var enabled = new URLSearchParams(window.location.search).get('diagnostics') === '1';
    var context = {};
    var samples = {};
    var overlay = null;
    var lastOverlayUpdate = 0;

    function reset(nextContext) {
        context = nextContext && typeof nextContext === 'object'
            ? JSON.parse(JSON.stringify(nextContext)) : {};
        samples = {
            frame: [],
            update: [],
            planner: [],
            render: []
        };
        renderOverlay(true);
    }

    function start() {
        return enabled ? performance.now() : 0;
    }

    function record(name, startedAt) {
        if (!enabled || !samples[name] || !startedAt) return;
        var duration = performance.now() - startedAt;
        if (!Number.isFinite(duration) || duration < 0) return;
        var series = samples[name];
        series.push(duration);
        if (series.length > MAX_SAMPLES) series.shift();
        renderOverlay(false);
    }

    function percentile(sorted, fraction) {
        if (!sorted.length) return null;
        var index = Math.ceil(fraction * sorted.length) - 1;
        return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
    }

    function summarize(series) {
        if (!series.length) {
            return {
                sampleCount: 0,
                minMs: null,
                medianMs: null,
                p95Ms: null,
                p99Ms: null,
                maxMs: null,
                longFrameCount: 0,
                totalTimeAboveBudgetMsPer1000: 0
            };
        }
        var sorted = series.slice().sort(function(a, b) { return a - b; });
        var longFrameCount = 0;
        var longFrameTime = 0;
        for (var i = 0; i < series.length; i++) {
            if (series[i] > FRAME_BUDGET_MS) {
                longFrameCount++;
                longFrameTime += series[i];
            }
        }
        return {
            sampleCount: series.length,
            minMs: sorted[0],
            medianMs: percentile(sorted, 0.5),
            p95Ms: percentile(sorted, 0.95),
            p99Ms: percentile(sorted, 0.99),
            maxMs: sorted[sorted.length - 1],
            longFrameCount: longFrameCount,
            totalTimeAboveBudgetMsPer1000: longFrameTime * 1000 / series.length
        };
    }

    function snapshot() {
        var metrics = {};
        Object.keys(samples).forEach(function(name) {
            metrics[name] = summarize(samples[name]);
        });
        return {
            schemaVersion: 1,
            kind: 'diving-simulator-performance',
            capturedAt: new Date().toISOString(),
            buildVersion: typeof BUILD_VERSION === 'undefined' ? 'unknown' : BUILD_VERSION,
            frameBudgetMs: FRAME_BUDGET_MS,
            context: JSON.parse(JSON.stringify(context)),
            environment: {
                userAgent: navigator.userAgent,
                viewportCssPx: {
                    width: window.innerWidth,
                    height: window.innerHeight
                },
                devicePixelRatio: window.devicePixelRatio || 1
            },
            metrics: metrics
        };
    }

    function ensureOverlay() {
        if (!enabled || overlay || !document.body) return;
        overlay = document.createElement('pre');
        overlay.id = 'baseline-diagnostics';
        overlay.setAttribute('aria-hidden', 'true');
        overlay.style.cssText =
            'position:fixed;right:8px;bottom:8px;z-index:1000;margin:0;' +
            'padding:8px 10px;background:rgba(0,0,0,.82);color:#8fffd0;' +
            'font:11px/1.35 monospace;pointer-events:none;white-space:pre;';
        document.body.appendChild(overlay);
    }

    function metricLine(name, metric) {
        if (!metric.sampleCount) return name + ': no samples';
        return name + ': n=' + metric.sampleCount +
            ' med=' + metric.medianMs.toFixed(2) +
            ' p95=' + metric.p95Ms.toFixed(2) +
            ' max=' + metric.maxMs.toFixed(2) + ' ms';
    }

    function renderOverlay(force) {
        if (!enabled) return;
        var now = performance.now();
        if (!force && now - lastOverlayUpdate < 500) return;
        lastOverlayUpdate = now;
        ensureOverlay();
        if (!overlay) return;
        var data = snapshot();
        overlay.textContent = [
            'WP-01 DIAGNOSTICS',
            metricLine('frame', data.metrics.frame),
            metricLine('update', data.metrics.update),
            metricLine('planner', data.metrics.planner),
            metricLine('render', data.metrics.render)
        ].join('\n');
    }

    reset({});

    window.baselineDiagnostics = {
        get enabled() { return enabled; },
        start: start,
        record: record,
        reset: reset,
        exportSnapshot: snapshot
    };
})();
