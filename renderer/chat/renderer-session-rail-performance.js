/* renderer/chat/renderer-session-rail-performance.js - the rail's Performance section and the
   Session toggle's compact readout (UMD).

   Row 59 checkpoint 6 (chat workspace parity spec, "Performance section" and "Counter
   when undocked"). One controller per pane rail. Data: window.jennyShell.performance.getSnapshot
   (frozen W4 shape {ok, settings, inference, gpu}) fetched on mount, on a session change and on
   performance.onChanged for this session (or a host-wide event), coalesced to one request in flight.
   An absent bridge means nothing renders.

   - The section is NOT one of the five summary sections (not in SECTION_KEYS, never persisted): it is
     appended after them while settings.show_counter is on, expanded; a click folds it for this pane only.
   - Every metric reads its own state. Warming is "Measuring...", stale keeps its value labelled
     "stale" (a number past its freshness window is never painted as live, even if no refetch has
     arrived: the renderer ages it locally and a safety refetch is scheduled), a finished turn shows the
     terminal averages labelled as averages, unavailable names the engine, not_applicable is a dash.
   - The toggle readout ("Session · 182 tok/s") exists only undocked, with the counter on and a live
     decode rate in the "available" state. The value is part of the toggle's accessible name, not a
     live region.
   Pure builders (buildPerformanceView, bodyHtml) take the snapshot and a clock; the controller owns the
   bridge, the timers and the DOM. Every dynamic string goes through escapeHtml. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/string-utils'), require('../inventory/action-button'), require('./renderer-session-rail-render'));
    return;
  }
  root.rendererSessionRailPerformance = factory(root.stringUtils, root.inventoryActionButton, root.rendererSessionRailRender);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (stringUtils, defaultActionButton, railRender) {
  'use strict';

  const escapeHtml = stringUtils.escapeHtml;
  const SCHEMA_VERSION = 1;
  const LOCAL_STALE_MS = 3000; // a live reading older than this (renderer clock) is aged to stale
  const SAFETY_REFETCH_MS = 2600; // the service marks a rate stale 2.5 s after its last measurement
  const NARROW_PANE_PX = 520; // below this the toggle readout keeps icon + rate and drops the word
  const TERMINAL_PHASES = Object.freeze(['finished', 'failed', 'cancelled']);
  const ENGINE_NAMES = Object.freeze({ ninfer: 'NInfer', 'llama-server': 'llama-server', ollama: 'Ollama' });
  const GB = 1024 ** 3;

  function fallbackJt(key, fallback, params) {
    return params
      ? String(fallback).replace(/\{(\w+)\}/g, (match, name) => (Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match))
      : String(fallback);
  }

  const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  const finite = (value) => typeof value === 'number' && Number.isFinite(value);

  // ── Formatting ───────────────────────────────────────────────────────────
  function formatRate(value, jt = fallbackJt) {
    if (!finite(value) || value < 0) return '';
    const shown = value >= 1000 ? `${(value / 1000).toFixed(1)}k` : (value >= 10 ? String(Math.round(value)) : value.toFixed(1));
    return jt('chat.sessionRail.performance.rate', '{value} tok/s', { value: shown });
  }

  function formatDuration(ms, jt = fallbackJt) {
    if (!finite(ms) || ms < 0) return '';
    return ms < 1000
      ? jt('chat.sessionRail.performance.milliseconds', '{value} ms', { value: Math.round(ms) })
      : jt('chat.sessionRail.performance.seconds', '{value} s', { value: (ms / 1000).toFixed(1) });
  }

  const formatPercent = (fraction) => (finite(fraction) && fraction >= 0 ? `${Math.round(Math.min(fraction, 1) * 100)}%` : '');

  function formatGigabytes(bytes, jt = fallbackJt) {
    return finite(bytes) && bytes >= 0 ? jt('chat.sessionRail.performance.gigabytes', '{value} GB', { value: (bytes / GB).toFixed(1) }) : '';
  }

  // ── Metric states ────────────────────────────────────────────────────────
  function engineName(inference, jt) {
    const kind = isObject(inference) && isObject(inference.observation) ? inference.observation.provider_kind : '';
    return ENGINE_NAMES[kind] || jt('chat.sessionRail.performance.thisEngine', 'this engine');
  }

  /* One measured value as {text, meta, state, tone}. `terminalValue` (a finished turn's average)
     wins when present and is labelled as an average; `ageSensitive` ages a live reading to stale. */
  function describeMetric(metric, options) {
    const { jt, format, terminalValue = null, ageMs = 0, ageSensitive = false, inference = null } = options;
    if (finite(terminalValue)) {
      return { text: format(terminalValue), meta: jt('chat.sessionRail.performance.average', 'average'), state: 'average', tone: 'value' };
    }
    const source = isObject(metric) ? metric : { state: 'unavailable', value: null };
    let state = source.state;
    if (state === 'available' && (!finite(source.value) || (ageSensitive && ageMs > LOCAL_STALE_MS))) state = finite(source.value) ? 'stale' : 'unavailable';
    switch (state) {
      case 'available': return { text: format(source.value), meta: '', state: 'available', tone: 'value' };
      case 'warming': return { text: jt('chat.sessionRail.performance.measuring', 'Measuring…'), meta: '', state: 'warming', tone: 'muted' };
      case 'stale': return { text: finite(source.value) ? format(source.value) : '', meta: jt('chat.sessionRail.performance.stale', 'stale'), state: 'stale', tone: 'muted' };
      case 'not_applicable': return { text: '—', meta: '', state: 'not_applicable', tone: 'muted' };
      case 'available_next_request': return { text: jt('chat.sessionRail.performance.nextRequest', 'from the next request'), meta: '', state: 'available_next_request', tone: 'muted' };
      default: return { text: jt('chat.sessionRail.performance.notReported', 'not reported by {engine}', { engine: engineName(inference, jt) }), meta: '', state: 'unavailable', tone: 'muted' };
    }
  }

  function describeFirstToken(inference, jt) {
    const observation = isObject(inference) && isObject(inference.observation) ? inference.observation : null;
    if (observation && finite(observation.time_to_first_generated_token_ms)) {
      return { text: formatDuration(observation.time_to_first_generated_token_ms, jt), meta: '', state: 'available', tone: 'value' };
    }
    if (!isObject(inference)) return { text: '—', meta: '', state: 'idle', tone: 'muted' };
    const waiting = observation ? ['waiting', 'loading', 'prefill'].includes(observation.phase) : isObject(inference.live_decode) && inference.live_decode.state === 'warming';
    if (waiting) return { text: jt('chat.sessionRail.performance.measuring', 'Measuring…'), meta: '', state: 'warming', tone: 'muted' };
    return describeMetric(null, { jt, format: String, inference });
  }

  /* The host-scope line: free/total on the adapter and, when known, the managed process's dedicated and
     shared use. Never summed across processes; unknown stays unknown. */
  function describeScope(gpu, jt = fallbackJt) {
    const adapter = isObject(gpu) && isObject(gpu.adapter) ? gpu.adapter : null;
    if (!adapter || gpu.state === 'unavailable') {
      return { headline: jt('chat.sessionRail.performance.scopeUnavailable', 'This PC · GPU not reported'), detail: '' };
    }
    const free = formatGigabytes(adapter.dedicated_free_bytes, jt);
    const total = formatGigabytes(adapter.dedicated_total_bytes, jt);
    let headline = jt('chat.sessionRail.performance.scopeUnavailable', 'This PC · GPU not reported');
    if (free && total) headline = jt('chat.sessionRail.performance.scope', 'This PC · GPU {free} of {total} free', { free, total });
    else if (free) headline = jt('chat.sessionRail.performance.scopeFree', 'This PC · GPU {free} free', { free });
    if (gpu.state === 'stale' && free) headline += ` · ${jt('chat.sessionRail.performance.stale', 'stale')}`;
    const managed = isObject(gpu.managed_process) ? gpu.managed_process : null;
    const dedicated = managed ? formatGigabytes(managed.dedicated_bytes, jt) : '';
    const shared = managed ? formatGigabytes(managed.shared_bytes, jt) : '';
    const parts = [];
    if (dedicated) parts.push(jt('chat.sessionRail.performance.dedicated', '{value} dedicated', { value: dedicated }));
    if (shared) parts.push(jt('chat.sessionRail.performance.shared', '{value} shared', { value: shared }));
    const detail = parts.length ? [jt('chat.sessionRail.performance.engine', 'Engine')].concat(parts).join(' · ') : '';
    return { headline, detail };
  }

  /* snapshot: {settings, inference, gpu} from performance.getSnapshot (or null before the first answer).
     ageMs: how long ago it was fetched, on the renderer clock. */
  function buildPerformanceView({ snapshot = null, ageMs = 0, jt = fallbackJt } = {}) {
    const settings = isObject(snapshot) && isObject(snapshot.settings) ? snapshot.settings : null;
    const enabled = Boolean(settings && settings.show_counter === true);
    const inference = isObject(snapshot) && isObject(snapshot.inference) ? snapshot.inference : null;
    const observation = inference && isObject(inference.observation) ? inference.observation : null;
    const terminal = Boolean(observation && TERMINAL_PHASES.includes(observation.phase));
    const live = inference || {};
    const writing = inference
      ? describeMetric(live.live_decode, { jt, format: (value) => formatRate(value, jt), terminalValue: terminal ? observation.terminal_decode_tps : null, ageMs, ageSensitive: true, inference })
      : { text: '—', meta: '', state: 'idle', tone: 'muted' };
    const reading = inference
      ? describeMetric(live.live_prefill, { jt, format: (value) => formatRate(value, jt), terminalValue: terminal ? observation.terminal_prefill_tps : null, ageMs, ageSensitive: true, inference })
      : { text: '—', meta: '', state: 'idle', tone: 'muted' };
    const cache = inference
      ? describeMetric(live.cache_fraction, { jt, format: formatPercent, inference })
      : { text: '—', meta: '', state: 'idle', tone: 'muted' };
    const rows = [
      { key: 'writing', label: jt('chat.sessionRail.performance.writing', 'Writing'), ...writing },
      { key: 'prompt_reading', label: jt('chat.sessionRail.performance.promptReading', 'Prompt reading'), ...reading },
      { key: 'first_token', label: jt('chat.sessionRail.performance.firstToken', 'First token'), ...describeFirstToken(inference, jt) },
      { key: 'cache', label: jt('chat.sessionRail.performance.reusedFromCache', 'Reused from cache'), ...cache },
    ];
    const header = writing.state === 'available' || writing.state === 'warming'
      ? writing.text
      : (writing.state === 'stale' ? writing.meta : '');
    const decode = inference ? live.live_decode : null;
    const readoutRate = enabled && !terminal && isObject(decode) && decode.state === 'available' && finite(decode.value) && ageMs <= LOCAL_STALE_MS
      ? formatRate(decode.value, jt) : '';
    return {
      enabled,
      title: jt('chat.sessionRail.performance.title', 'Performance'),
      header,
      rows,
      scope: describeScope(isObject(snapshot) ? snapshot.gpu : null, jt),
      readout: readoutRate,
      live: enabled && !terminal && isObject(decode) && (decode.state === 'available' || decode.state === 'warming'),
    };
  }

  // ── Markup ───────────────────────────────────────────────────────────────
  function rowHtml(row) {
    const meta = row.meta ? `<span class="session-rail-perf-meta">${escapeHtml(row.meta)}</span>` : '';
    return `<div class="session-rail-perf-row" data-row-key="${escapeHtml(row.key)}" data-state="${escapeHtml(row.state)}" data-tone="${escapeHtml(row.tone)}">`
      + `<span class="session-rail-perf-label">${escapeHtml(row.label)}</span>`
      + `<span class="session-rail-perf-value">${row.text ? `<span class="session-rail-perf-number">${escapeHtml(row.text)}</span>` : ''}${meta}</span></div>`;
  }

  function bodyHtml(view) {
    const detail = view.scope.detail ? `<span class="session-rail-perf-scope-detail">${escapeHtml(view.scope.detail)}</span>` : '';
    return view.rows.map(rowHtml).join('')
      + `<div class="session-rail-perf-scope" data-row-key="scope"><span>${escapeHtml(view.scope.headline)}</span>${detail}</div>`;
  }

  // ── Controller ───────────────────────────────────────────────────────────
  function createRailPerformance(options) {
    const o = options || {};
    const win = o.win;
    const doc = o.doc;
    if (!win || !doc) return null;
    const jt = typeof o.jt === 'function' ? o.jt : fallbackJt;
    const bridge = o.bridge || (win.jennyShell && win.jennyShell.performance) || null;
    const bridgeOk = Boolean(bridge && typeof bridge.getSnapshot === 'function');
    const makeButton = o.actionButton || win.inventoryActionButton || defaultActionButton;
    const idPrefix = `${o.idPrefix || 'session-rail'}-performance`;
    const getSessionId = typeof o.getSessionId === 'function' ? o.getSessionId : () => '';
    const now = typeof o.now === 'function' ? o.now : () => Date.now();
    const onChange = typeof o.onChange === 'function' ? o.onChange : () => {};

    let disposed = false;
    let sessionId = String(getSessionId() || '').trim();
    let snapshot = null;
    let fetchedAt = 0;
    let fetching = false;
    let queued = false;
    let timer = 0;
    let open = true;
    let built = false;
    let lastBody = '';
    let lastValue = '';
    let lastReadout = '';
    let paneNarrow = false;
    let tray = null;
    let toggle = null;
    let lastMode = '';
    let lastLabel = '';
    let unsubscribe = null;
    let view = buildPerformanceView({ jt });

    const host = doc.createElement('section');
    host.className = 'session-rail-section session-rail-performance';
    host.setAttribute('data-section', 'performance');
    host.setAttribute('data-state', 'idle');
    host.hidden = true;

    function build() {
      if (built) return;
      built = true;
      const head = makeButton({
        plain: true, className: 'session-rail-section-head', domId: `${idPrefix}-head`, ariaExpanded: open, ariaControls: `${idPrefix}-body`,
        dataset: { 'rail-performance-head': 'true' },
        trustedHtml: `${railRender.CHEVRON}<span class="session-rail-section-title">${escapeHtml(view.title)}</span><span class="session-rail-section-value" data-rail-perf-value></span>`,
      });
      host.innerHTML = `${head}<div class="session-rail-section-body" id="${idPrefix}-body" role="group" aria-labelledby="${idPrefix}-head" data-rail-perf-body></div>`;
    }

    function render() {
      if (disposed) return;
      view = buildPerformanceView({ snapshot, ageMs: fetchedAt ? Math.max(0, now() - fetchedAt) : 0, jt });
      host.hidden = !view.enabled;
      placeHost();
      if (view.enabled) {
        build();
        const valueNode = host.querySelector('[data-rail-perf-value]');
        const bodyNode = host.querySelector('[data-rail-perf-body]');
        const body = bodyHtml(view);
        if (valueNode && lastValue !== view.header) { valueNode.textContent = view.header; lastValue = view.header; }
        if (bodyNode && lastBody !== body) { bodyNode.innerHTML = body; lastBody = body; }
        host.setAttribute('data-state', view.rows[0].state);
      }
      if (lastReadout !== view.readout) {
        lastReadout = view.readout;
        onChange();
      }
    }

    function scheduleSafetyRefetch() {
      if (timer) win.clearTimeout(timer);
      timer = 0;
      if (disposed || !view.live) return;
      timer = win.setTimeout(() => { timer = 0; void fetchSnapshot(); }, SAFETY_REFETCH_MS);
    }

    async function fetchSnapshot() {
      const sid = sessionId;
      if (disposed || !bridgeOk || !sid) return;
      if (fetching) { queued = true; return; }
      fetching = true;
      const response = await Promise.resolve()
        .then(() => bridge.getSnapshot({ schema_version: SCHEMA_VERSION, session_id: sid }))
        .catch(() => null);
      fetching = false;
      if (disposed) return;
      if (sid === sessionId) {
        if (isObject(response) && response.ok === true) {
          snapshot = { settings: response.settings, inference: response.inference, gpu: response.gpu };
          fetchedAt = now();
        } else if (snapshot) {
          // A failed refresh keeps the last reading, every live rate demoted to stale.
          snapshot = { ...snapshot, inference: staleInference(snapshot.inference) };
        }
        render();
        scheduleSafetyRefetch();
      }
      if (queued) { queued = false; void fetchSnapshot(); }
    }

    // A refresh that failed turns every live reading into a stale one (value kept, never live).
    function staleInference(inference) {
      if (!isObject(inference)) return inference;
      const age = (metric) => (isObject(metric) && metric.state === 'available' ? { ...metric, state: 'stale' } : metric);
      return { ...inference, live_decode: age(inference.live_decode), live_prefill: age(inference.live_prefill) };
    }

    function setSession(next) {
      const id = String(next || '').trim();
      if (disposed || id === sessionId) return;
      sessionId = id;
      snapshot = null;
      fetchedAt = 0;
      queued = false;
      render();
      if (timer) { win.clearTimeout(timer); timer = 0; }
      void fetchSnapshot();
    }

    // The host joins the tray (as its last section) only while the counter is on: off, it is not in the DOM.
    function placeHost() {
      if (!tray) return;
      if (!view.enabled) { host.remove(); return; }
      if (host.parentNode !== tray || tray.lastElementChild !== host) tray.appendChild(host);
    }

    function attach(target) {
      if (disposed || !target) return;
      tray = target;
      placeHost();
    }

    /* The Session toggle's readout. Only undocked, only with a live "available" decode rate. */
    function syncReadout(button, mode, label) {
      toggle = button || toggle;
      lastMode = mode;
      lastLabel = label;
      if (!toggle || disposed) return;
      const slot = toggle.querySelector('[data-session-rail-readout]');
      const shown = mode === 'undocked' && view.readout !== '';
      if (slot) {
        slot.hidden = !shown;
        const value = slot.querySelector('[data-session-rail-readout-value]');
        if (value) value.textContent = shown ? view.readout : '';
      }
      toggle.toggleAttribute('data-readout-compact', shown && paneNarrow);
      if (shown) toggle.setAttribute('aria-label', jt('chat.sessionRail.performance.toggleName', '{label} · {rate}', { label, rate: view.readout }));
      else toggle.removeAttribute('aria-label');
    }

    function setPaneWidth(width) {
      const narrow = finite(width) && width > 0 && width < NARROW_PANE_PX;
      if (narrow === paneNarrow) return;
      paneNarrow = narrow;
      if (toggle) syncReadout(toggle, lastMode, lastLabel);
    }

    host.addEventListener('click', (event) => {
      const head = event.target && event.target.closest ? event.target.closest('[data-rail-performance-head]') : null;
      if (!head || !host.contains(head)) return;
      event.preventDefault();
      open = !open;
      head.setAttribute('aria-expanded', open ? 'true' : 'false');
    });

    if (bridgeOk && typeof bridge.onChanged === 'function') {
      const release = bridge.onChanged((event) => {
        if (disposed || !isObject(event)) return;
        if (event.session_id !== null && event.session_id !== undefined && event.session_id !== sessionId) return;
        // Settings changes always refetch; everything else only while the counter is on.
        if (event.scope === 'settings' || !snapshot || (snapshot.settings && snapshot.settings.show_counter === true)) void fetchSnapshot();
      });
      if (typeof release === 'function') unsubscribe = release;
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      if (timer) win.clearTimeout(timer);
      timer = 0;
      try { if (unsubscribe) unsubscribe(); } catch (_error) { /* best-effort teardown */ }
      unsubscribe = null;
      host.remove();
      if (toggle) toggle.removeAttribute('aria-label');
    }

    if (bridgeOk && sessionId) void fetchSnapshot();

    return {
      attach, syncReadout, setPaneWidth, setSession, dispose,
      refresh: () => { void fetchSnapshot(); },
      getView: () => view,
      isAvailable: () => bridgeOk,
      elements: { host },
    };
  }

  return {
    LOCAL_STALE_MS, SAFETY_REFETCH_MS, NARROW_PANE_PX,
    formatRate, formatDuration, formatPercent, formatGigabytes,
    describeMetric, describeFirstToken, describeScope, buildPerformanceView, bodyHtml, createRailPerformance,
  };
});
