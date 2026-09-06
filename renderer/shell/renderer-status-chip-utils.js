/* renderer/shell/renderer-status-chip-utils.js — shared loading -> live status-chip
 * convention (UMD). Small and injectable on purpose: this is the single place
 * that defines what "loading / live / error" means for a status chip so the
 * two v1 surfaces (offline readiness, settings tools badges) stop diverging
 * on ad-hoc optimistic-permissive rendering that flashes a stale verdict
 * before the first real payload lands. Mirrors the pending|success|error
 * convention already established by renderer-activity-prefs-utils.js
 * (resolveActivityTone/applyActivityAttributes) rather than inventing a
 * second vocabulary — this module is scoped to the narrower
 * "have we heard from the backend yet" resolution question, not general
 * activity/mutation lifecycle.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererStatusChipUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const STATUS_CHIP_CLASS = 'settings-status-chip';
  const VALID_STATES = new Set(['loading', 'live', 'error']);

  function normalizeChipState(value) {
    const token = String(value || '').trim().toLowerCase();
    return VALID_STATES.has(token) ? token : 'loading';
  }

  // Applies the shared chip convention to a live DOM element: adds the
  // settings-status-chip class hook if missing, sets data-state (the only
  // attribute CSS should key off — this module intentionally ships no CSS),
  // and writes the visible label as textContent. `title` is optional and is
  // removed when not supplied so stale tooltips don't linger across state
  // transitions.
  //
  // Only call this on elements that are meant to carry visible text. A
  // purely decorative indicator (e.g. a colored dot with no label) should
  // set data-state directly instead — routing it through here would
  // overwrite its (intentionally empty) textContent contract.
  function applyStatusChip(el, options) {
    if (!el || typeof el.setAttribute !== 'function') {
      return el;
    }
    const opts = options && typeof options === 'object' ? options : {};
    const state = normalizeChipState(opts.state);
    if (el.classList && typeof el.classList.contains === 'function' && !el.classList.contains(STATUS_CHIP_CLASS)) {
      el.classList.add(STATUS_CHIP_CLASS);
    }
    el.setAttribute('data-state', state);
    el.textContent = opts.label != null ? String(opts.label) : '';
    const title = opts.title != null ? String(opts.title).trim() : '';
    if (title) {
      el.setAttribute('title', title);
    } else {
      el.removeAttribute('title');
    }
    return el;
  }

  // Maps a "has a real payload landed yet" flag plus an "is it healthy"
  // verdict onto the loading -> live -> error convention. While `resolved`
  // is not `true`, the result is always 'loading' regardless of `ok` —
  // `ok` is still describing an optimistic seed at that point, not a real
  // reading, so it must not leak into the displayed state.
  function resolveAvailabilityChipState(options) {
    const opts = options && typeof options === 'object' ? options : {};
    if (opts.resolved !== true) {
      return 'loading';
    }
    return opts.ok === true ? 'live' : 'error';
  }

  return {
    STATUS_CHIP_CLASS,
    applyStatusChip,
    resolveAvailabilityChipState,
  };
});
