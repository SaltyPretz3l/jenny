/* renderer/shell/renderer-pane-model.js -- the split-view pane layout (UMD) */
/**
 * Which conversation sits in which pane, as a value.
 *
 * The shape is N-pane from day one even though Wave 0 only ever seeds one
 * pane: `panes` is an array of `{ paneId, sessionId }` whose ids are
 * re-numbered 0..N-1 on every normalize, so a pane id is always an INDEX into
 * that array and never a durable handle a caller can hold across a normalize.
 *
 * Invariants `normalizePaneLayout` establishes, so no consumer has to:
 *   - there is always at least one pane, whatever the input was;
 *   - a session sits in at most ONE pane -- a later duplicate loses its
 *     session, not its pane, because a split view keeps both panes on screen;
 *   - a session id the caller does not recognize (`validSessionIds`) becomes
 *     '' rather than pointing a pane at a conversation that no longer exists;
 *   - `focusedPaneId` names a pane that exists, or is 0;
 *   - `splitRatio` is a finite number inside [0.2, 0.8] (default 0.5), so no
 *     stored or dragged value can collapse a pane to nothing;
 *   - everything handed back is frozen, top to bottom.
 *
 * Pure value logic: no DOM, no state mutation, no global beyond the export.
 * Persistence is deliberately NOT here (a later slice owns shell-config), and
 * neither is any notion of what a pane renders.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererPaneModel = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DEFAULT_SPLIT_RATIO = 0.5;
  var MIN_SPLIT_RATIO = 0.2;
  var MAX_SPLIT_RATIO = 0.8;

  // The same normalization the renderer has always applied to a session id
  // (renderer/shared/string-utils.js normalizeId), inlined so this module
  // carries no load-order dependency of its own.
  function normalizeId(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  // A pane entry may be written as a bare session id or as `{ sessionId }`.
  // Anything else is a pane that holds nothing -- never a pane that vanishes.
  function readPaneSessionId(entry) {
    if (typeof entry === 'string') return normalizeId(entry);
    if (entry && typeof entry === 'object') return normalizeId(entry.sessionId);
    return '';
  }

  function readPanes(layout) {
    var panes = layout && typeof layout === 'object' ? layout.panes : null;
    return Array.isArray(panes) ? panes : [];
  }

  /**
   * The ids the caller vouches for, or null when the caller did not say.
   * An EMPTY collection is a real answer ("no session is valid"), which is why
   * this distinguishes "omitted" (null) from "empty" (an empty Set).
   */
  function readValidSessionIds(raw) {
    if (raw == null) return null;
    var isSet = typeof Set !== 'undefined' && raw instanceof Set;
    var isMap = typeof Map !== 'undefined' && raw instanceof Map;
    if (!Array.isArray(raw) && !isSet && !isMap) return null;
    var source = isMap ? Array.from(raw.keys()) : Array.from(raw);
    var valid = new Set();
    source.forEach(function addValidId(value) {
      var id = normalizeId(value);
      if (id) valid.add(id);
    });
    return valid;
  }

  // Only a finite number, or a non-blank numeric string, is a ratio worth
  // clamping; '' / false / [] / true would otherwise coerce to 0 or 1 and land
  // on a clamp edge instead of the default (a blank stored value must never
  // silently become a 20/80 split).
  function normalizeSplitRatio(raw) {
    var ratio = typeof raw === 'number'
      ? raw
      : (typeof raw === 'string' && raw.trim() ? Number(raw) : NaN);
    if (!Number.isFinite(ratio)) return DEFAULT_SPLIT_RATIO;
    return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio));
  }

  function normalizeFocusedPaneId(raw, paneCount) {
    var focused = Number(raw);
    return Number.isInteger(focused) && focused >= 0 && focused < paneCount ? focused : 0;
  }

  /**
   * Normalize any stored, restored or hand-written layout into the frozen
   * value the rest of the renderer reads.
   *
   * @param {*} raw - `{ panes, focusedPaneId, splitRatio }`, or anything else.
   * @param {Object} [options]
   * @param {Array|Set|Map} [options.validSessionIds] - the sessions that exist.
   * @returns {{panes: Array<{paneId: number, sessionId: string}>, focusedPaneId: number, splitRatio: number}} frozen
   */
  function normalizePaneLayout(raw, options) {
    var source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    var validSessionIds = readValidSessionIds(options ? options.validSessionIds : null);
    var entries = readPanes(source);
    if (!entries.length) entries = [''];

    var claimed = new Set();
    var panes = entries.map(function normalizePane(entry, index) {
      var sessionId = readPaneSessionId(entry);
      if (sessionId && validSessionIds && !validSessionIds.has(sessionId)) sessionId = '';
      if (sessionId && claimed.has(sessionId)) sessionId = '';
      if (sessionId) claimed.add(sessionId);
      return Object.freeze({ paneId: index, sessionId: sessionId });
    });

    return Object.freeze({
      panes: Object.freeze(panes),
      focusedPaneId: normalizeFocusedPaneId(source.focusedPaneId, panes.length),
      splitRatio: normalizeSplitRatio(source.splitRatio),
    });
  }

  /** The pane the person is acting in, falling back to the first pane. */
  function resolveFocusedPane(layout) {
    var panes = readPanes(layout);
    if (!panes.length) return null;
    var focusedPaneId = normalizeFocusedPaneId(layout.focusedPaneId, panes.length);
    return panes[focusedPaneId] || panes[0] || null;
  }

  /** The pane holding `sessionId`, or null. A blank id is in no pane. */
  function resolvePaneForSession(layout, sessionId) {
    var wanted = normalizeId(sessionId);
    if (!wanted) return null;
    var panes = readPanes(layout);
    for (var index = 0; index < panes.length; index += 1) {
      if (readPaneSessionId(panes[index]) === wanted) return panes[index];
    }
    return null;
  }

  /** The sessions on screen, in pane order: no blanks, no duplicates. */
  function listPaneSessionIds(layout) {
    var seen = new Set();
    var sessionIds = [];
    readPanes(layout).forEach(function collect(entry) {
      var sessionId = readPaneSessionId(entry);
      if (!sessionId || seen.has(sessionId)) return;
      seen.add(sessionId);
      sessionIds.push(sessionId);
    });
    return sessionIds;
  }

  /**
   * The value `state.currentSessionId` carries: the focused pane's session.
   * Every existing reader of that field keeps its meaning through this.
   */
  function deriveCurrentSessionId(layout) {
    return readPaneSessionId(resolveFocusedPane(layout));
  }

  return {
    normalizePaneLayout: normalizePaneLayout,
    resolveFocusedPane: resolveFocusedPane,
    resolvePaneForSession: resolvePaneForSession,
    listPaneSessionIds: listPaneSessionIds,
    deriveCurrentSessionId: deriveCurrentSessionId,
    DEFAULT_SPLIT_RATIO: DEFAULT_SPLIT_RATIO,
    MIN_SPLIT_RATIO: MIN_SPLIT_RATIO,
    MAX_SPLIT_RATIO: MAX_SPLIT_RATIO,
  };
});
