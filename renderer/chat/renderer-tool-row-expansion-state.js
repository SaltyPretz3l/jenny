/* renderer/chat/renderer-tool-row-expansion-state.js holds the minimal tool
 * rows' user expand/collapse overrides and their lazy detail-body contexts.
 * renderer-turn-row-tool-render-utils.js creates one store when it loads and
 * re-exports its functions (setToolRowExpansion, materializeToolRowDetails,
 * ...), so the transcript bindings keep reaching them through
 * rendererTurnRowToolRenderUtils. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererToolRowExpansionState = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function fallbackNormalizeId(value) {
    return String(value || '').trim();
  }

  // Resolved per call: tests install a global after this module loads; in the
  // app tool-call-utils is always loaded first (index.html order).
  function sharedToolCallUtils() {
    return (typeof globalThis !== 'undefined' && globalThis.toolCallUtils) || require('./tool-call-utils');
  }

  function createToolRowExpansionState() {
    // User expand/collapse overrides per composite tool-row key, module-scoped so they
    // survive the per-delta full re-renders of the streaming pipeline (same
    // pattern as the legacy transcript tool-call store). Bounded FIFO so a
    // long session cannot grow it without bound.
    const TOOL_ROW_EXPANSION_CAP = 500;
    const _toolRowExpansionOverrides = new Map();
    const _toolDetailContexts = new Map();

    function registerToolDetailContext(rowKey, detailBodyBuilder, detailModel) {
      const key = fallbackNormalizeId(rowKey);
      if (!key || !detailBodyBuilder || typeof detailBodyBuilder.buildDetailBodyMarkup !== 'function') return;
      if (_toolDetailContexts.has(key)) _toolDetailContexts.delete(key);
      _toolDetailContexts.set(key, { detailBodyBuilder, detailModel });
      while (_toolDetailContexts.size > TOOL_ROW_EXPANSION_CAP) {
        _toolDetailContexts.delete(_toolDetailContexts.keys().next().value);
      }
    }

    function materializeToolRowDetails(rowKey) {
      const key = fallbackNormalizeId(rowKey);
      const context = _toolDetailContexts.get(key);
      if (!context) return { ok: false, reason: 'missing_render_context', markup: '' };
      try {
        const markup = context.detailBodyBuilder.buildDetailBodyMarkup({
          ...context.detailModel,
          expandFileDiffsByDefault: getToolRowExpansion(key) === true,
        });
        _toolDetailContexts.delete(key);
        return {
          ok: true,
          reason: '',
          markup,
        };
      } catch (_error) {
        return { ok: false, reason: 'detail_build_failed', markup: '' };
      }
    }

    function setToolRowExpansion(rowKey, expanded) {
      const key = fallbackNormalizeId(rowKey);
      if (!key) {
        return;
      }
      if (_toolRowExpansionOverrides.has(key)) {
        _toolRowExpansionOverrides.delete(key);
      }
      _toolRowExpansionOverrides.set(key, expanded === true);
      while (_toolRowExpansionOverrides.size > TOOL_ROW_EXPANSION_CAP) {
        const oldestKey = _toolRowExpansionOverrides.keys().next().value;
        _toolRowExpansionOverrides.delete(oldestKey);
      }
    }

    function getToolRowExpansion(rowKey) {
      const key = fallbackNormalizeId(rowKey);
      return _toolRowExpansionOverrides.has(key)
        ? _toolRowExpansionOverrides.get(key)
        : undefined;
    }

    function clearToolRowExpansionOverrides() {
      _toolRowExpansionOverrides.clear();
      _toolDetailContexts.clear();
    }

    // Transcript view switch: drop one session's overrides (row keys start with
    // `session=<enc>|`, tool-call-utils buildToolRowKey) and keep the lazy detail
    // contexts, which another pane may still materialize from.
    function clearToolRowExpansionOverridesForSession(sessionId) {
      const normalized = fallbackNormalizeId(sessionId);
      if (!normalized) return;
      const prefix = sharedToolCallUtils().toolRowKeySessionPrefix(normalized);
      for (const key of Array.from(_toolRowExpansionOverrides.keys())) {
        if (key.startsWith(prefix)) _toolRowExpansionOverrides.delete(key);
      }
    }

    return {
      registerToolDetailContext,
      materializeToolRowDetails,
      setToolRowExpansion,
      getToolRowExpansion,
      clearToolRowExpansionOverrides,
      clearToolRowExpansionOverridesForSession,
    };
  }

  return { createToolRowExpansionState };
});
