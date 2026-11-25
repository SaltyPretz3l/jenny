(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSettingsFoundation = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Shared design-system helpers for the Settings page. These are the
  // jsdom-testable core of the Phase 0 foundation: pure string/DOM functions
  // with no module dependencies so every section can drive badges and notes
  // the same way. See styles/settings-foundation.css for the matching CSS.

  // ── T5 — badge loading -> live state model ───────────────────────────
  // Drives a badge from render instead of stale hardcoded HTML. Class-agnostic:
  // it sets data-state (tone) + data-badge-state (loading|ready) + text, so it
  // works for both .settings-badge and .inv-badge.
  const BADGE_STATES = new Set([
    'loading', 'info', 'live', 'success', 'busy', 'pending',
    'warn', 'warning', 'error', 'danger', 'muted',
  ]);

  function buildBadgeStateModel(options) {
    const source = options && typeof options === 'object' ? options : {};
    const rawState = String(source.state || '').trim().toLowerCase();
    const state = BADGE_STATES.has(rawState) ? rawState : 'muted';
    const loading = state === 'loading';
    const text = loading ? '' : String(source.text == null ? '' : source.text).trim();
    const ariaLabel = String(source.srLabel || source.ariaLabel || text || '').trim();
    // badgeState carries the loading flag (data-badge-state="loading"|"ready");
    // a separate `loading` boolean would be redundant derivable state.
    return { state, text, ariaLabel, badgeState: loading ? 'loading' : 'ready' };
  }

  function applyBadgeState(el, model) {
    if (!el || typeof el !== 'object') {
      return null;
    }
    const resolved = model && typeof model.badgeState === 'string'
      ? model
      : buildBadgeStateModel(model);
    el.textContent = resolved.text;
    if (typeof el.setAttribute === 'function') {
      el.setAttribute('data-state', resolved.state);
      el.setAttribute('data-badge-state', resolved.badgeState);
      if (resolved.ariaLabel) {
        el.setAttribute('aria-label', resolved.ariaLabel);
      } else if (typeof el.removeAttribute === 'function') {
        el.removeAttribute('aria-label');
      }
    }
    return resolved;
  }

  // T7 / T10 — drive a status / "requires X" note from a condition: set its
  // text and collapse it (hidden) when empty. Reused across sections.
  function applyNote(el, text) {
    if (!el) {
      return '';
    }
    const value = String(text == null ? '' : text).trim();
    el.textContent = value;
    el.hidden = value.length === 0;
    return value;
  }

  // ── Row 193 C2: settings that wait for a restart, and the one bar that says so ──
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };
  const inv = (global, file) => globalThis[global] || (typeof require === 'function' ? require('../inventory/' + file) : null);

  function createRestartList() {
    const items = new Map();
    const starts = new Map(); // id -> the value at app start
    const listeners = new Set();
    const list = () => Array.from(items, ([id, label]) => ({ id, label }));
    const emit = () => listeners.forEach((fn) => fn(list()));
    const api = {
      list,
      has: (id) => items.has(id),
      add(id, label) { if (items.get(id) !== label) { items.set(id, label); emit(); } },
      remove(id) { if (items.delete(id)) emit(); },
      // A saved change waits for a restart only while it differs from the value at app start.
      track(id, label, before, now) {
        if (!starts.has(id)) starts.set(id, before);
        if (starts.get(id) === now) api.remove(id); else api.add(id, label);
      },
      clear() { starts.clear(); if (items.size) { items.clear(); emit(); } },
      onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      onRestart: null, // set by whoever can restart Jenny; the bar shows "Restart now" only then
    };
    return api;
  }

  function paintRestartBar(doc, items, opts) {
    const frame = doc && doc.querySelector('.settings-content-frame');
    if (!frame) return;
    let bar = frame.querySelector(':scope > .settings-restart-bar');
    if (!items.length) { if (bar) bar.remove(); return; }
    if (!bar) {
      bar = doc.createElement('div');
      bar.className = 'settings-restart-bar';
      bar.setAttribute('role', 'status');
      frame.insertBefore(bar, frame.firstChild);
    }
    const onRestart = opts && opts.onRestart;
    const names = items.map((item) => item.label).join(', ');
    const message = jtn('settings.restartBar.waiting', items.length, { count: items.length, names }, '1 setting takes effect after a restart: {names}.', '{count} settings take effect after a restart: {names}.');
    bar.innerHTML = inv('inventoryStatusRow', 'status-row')({ tone: 'pending', message })
      + (typeof onRestart === 'function' ? inv('inventoryActionButton', 'action-button')({ id: 'settingsRestartNow', label: jt('settings.restartBar.restartNow', 'Restart now'), size: 'sm' }) : '');
    const button = bar.querySelector('button');
    if (button) button.addEventListener('click', onRestart);
  }

  const restartList = createRestartList();
  restartList.onChange((items) => { if (typeof document !== 'undefined') paintRestartBar(document, items, { onRestart: restartList.onRestart }); });

  return {
    buildBadgeStateModel,
    applyBadgeState,
    applyNote,
    createRestartList,
    paintRestartBar,
    restartList,
  };
});
