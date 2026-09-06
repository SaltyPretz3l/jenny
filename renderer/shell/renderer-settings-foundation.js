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

  return {
    buildBadgeStateModel,
    applyBadgeState,
    applyNote,
  };
});
