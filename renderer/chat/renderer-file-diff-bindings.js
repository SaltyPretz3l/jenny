(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererFileDiffBindings = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_ENTRIES = 256;
  const entries = new Map();

  function normalize(value) { return String(value || '').trim(); }

  function touch(diffId, patch) {
    const key = normalize(diffId);
    if (!key) return null;
    const current = entries.get(key) || {
      expanded: false,
      hasExpansionOverride: false,
      sessionId: '',
      materialize: null,
      warned: false,
    };
    if (entries.has(key)) entries.delete(key);
    const next = { ...current, ...(patch || {}) };
    entries.set(key, next);
    while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value);
    return next;
  }

  function registerFileDiffContext(options) {
    const settings = options || {};
    if (typeof settings.materialize !== 'function') return false;
    const patch = {
      sessionId: normalize(settings.sessionId),
      materialize: settings.materialize,
    };
    if (typeof settings.expanded === 'boolean') patch.expanded = settings.expanded;
    return Boolean(touch(settings.diffId, patch));
  }

  function getFileDiffExpanded(diffId) {
    return entries.get(normalize(diffId))?.expanded === true;
  }

  // Unlike getFileDiffExpanded, this preserves the distinction between the
  // parent's default and a choice the user made on the nested disclosure.
  function getFileDiffExpansionOverride(diffId) {
    const entry = entries.get(normalize(diffId));
    return entry?.hasExpansionOverride === true ? entry.expanded === true : undefined;
  }

  function setFileDiffExpanded(diffId, expanded) {
    return Boolean(touch(diffId, {
      expanded: expanded === true,
      hasExpansionOverride: true,
    }));
  }

  function toggleFileDiff(toggleNode, options) {
    if (!toggleNode || typeof toggleNode.closest !== 'function') return false;
    const row = toggleNode.closest('.file-diff');
    const body = row?.querySelector?.('.file-diff-body');
    const diffId = normalize(toggleNode.dataset?.diffId || row?.dataset?.diffId);
    if (!row || !body || !diffId) return false;
    const nextExpanded = row.dataset?.expanded !== 'true';
    const entry = entries.get(diffId);
    if (nextExpanded && body.hasAttribute('data-file-diff-pending')) {
      if (!entry || typeof entry.materialize !== 'function') {
        if (entry?.warned !== true) {
          options?.appendClientLog?.('WARN', 'chat.file_diff_materialization_skipped', {
            diffId: diffId.slice(0, 160), reason: 'missing_render_context',
          });
          touch(diffId, { warned: true });
        }
        return false;
      }
      try {
        body.innerHTML = String(entry.materialize() || '');
        body.removeAttribute('data-file-diff-pending');
        body.setAttribute('data-file-diff-materialized', '');
        entry.materialize = null;
      } catch (_error) {
        options?.appendClientLog?.('WARN', 'chat.file_diff_materialization_skipped', {
          diffId: diffId.slice(0, 160), reason: 'body_build_failed',
        });
        return false;
      }
    }
    setFileDiffExpanded(diffId, nextExpanded);
    row.dataset.expanded = nextExpanded ? 'true' : 'false';
    toggleNode.setAttribute('aria-expanded', nextExpanded ? 'true' : 'false');
    body.hidden = !nextExpanded;
    return nextExpanded;
  }

  function clearFileDiffSession(sessionId) {
    const normalized = normalize(sessionId);
    if (!normalized) return 0;
    let removed = 0;
    for (const [key, entry] of entries) {
      if (entry.sessionId === normalized) { entries.delete(key); removed += 1; }
    }
    return removed;
  }

  function disposeFileDiffBindings() { entries.clear(); }

  return {
    MAX_ENTRIES,
    registerFileDiffContext,
    getFileDiffExpanded,
    getFileDiffExpansionOverride,
    setFileDiffExpanded,
    toggleFileDiff,
    clearFileDiffSession,
    disposeFileDiffBindings,
  };
});
