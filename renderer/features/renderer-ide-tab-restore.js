/* Workspace editor restart memory: bounded tabs, view lines, and missing files. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeTabRestore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn)
    || function (key, count, params, one, other) { return jt.call(null, key, count === 1 ? one : other, params); };
  const MAX_RESTORED_TABS = 30;

  function createIdeTabRestore(deps = {}) {
    const { editorHost, getDom = () => ({}), getWorkspaceFsApi = () => null, registerCleanup = () => {} } = deps;
    const escapeHtml = deps.escapeHtml || (globalThis.stringUtils || (typeof require === 'function' ? require('../shared/string-utils') : {})).escapeHtml;
    const actionButton = globalThis.inventoryActionButton || (typeof require === 'function' ? require('../inventory/action-button') : null);
    const activatedAt = new Map();
    const missing = new Set();
    let clock = 0;
    let restoring = false;
    let strip = null;
    let previousTabs = null;
    let previousActive = '';

    function recordActivation(path) {
      if (path) activatedAt.set(path, ++clock);
    }

    function capture(snapshot, ide) {
      const tabs = snapshot.openTabs || [];
      const ranked = tabs.map((tab, index) => ({ tab, index }))
        .sort((a, b) => Number(b.tab.pinned === true) - Number(a.tab.pinned === true)
          || (activatedAt.get(b.tab.path) || 0) - (activatedAt.get(a.tab.path) || 0) || b.index - a.index)
        .slice(0, MAX_RESTORED_TABS)
        // Survivors go back in strip order so the restored strip reads as it did.
        .sort((a, b) => a.index - b.index);
      const openTabs = ranked.map(({ tab }) => {
        const saved = ide?.openTabs?.find((entry) => entry.path === tab.path)?.restore;
        const lines = editorHost?.getViewLines?.(tab.path) || saved;
        const entry = { ...tab };
        for (const key of ['line', 'top']) {
          if (Number.isInteger(lines?.[key]) && lines[key] >= 1) entry[key] = lines[key];
        }
        return entry;
      });
      return { ...snapshot, openTabs, activeTabPath: openTabs.some((tab) => tab.path === snapshot.activeTabPath) ? snapshot.activeTabPath : '' };
    }

    // Probe only known absence (`exists: false`); permission, transport and
    // stale-root failures keep the tab so the open path reports their real cause.
    async function probe(snapshot) {
      const api = getWorkspaceFsApi();
      if (typeof api?.stat !== 'function') return { snapshot, missing: [] };
      const gone = await Promise.all((snapshot.openTabs || []).slice(0, MAX_RESTORED_TABS).map(async (entry) => {
        const path = typeof entry === 'string' ? entry : entry.path;
        try {
          const result = await api.stat({ path });
          return result?.ok !== false && result?.exists === false ? path : null;
        } catch (_error) {
          return null;
        }
      }));
      const paths = gone.filter(Boolean);
      const dropped = new Set(paths);
      return {
        snapshot: { ...snapshot, openTabs: (snapshot.openTabs || []).filter((entry) => !dropped.has(typeof entry === 'string' ? entry : entry.path)) },
        missing: paths,
      };
    }

    function hydrate(snapshot, paths = []) {
      activatedAt.clear();
      clock = 0;
      for (const entry of [...(snapshot.openTabs || [])].reverse()) recordActivation(typeof entry === 'string' ? entry : entry.path);
      recordActivation(snapshot.activeTabPath);
      missing.clear();
      for (const path of paths) missing.add(path);
      previousTabs = null;
      previousActive = '';
    }

    function clear() {
      missing.clear();
      if (strip) strip.hidden = true;
    }

    function tabAction() {
      if (!restoring) clear();
    }

    function recordMissing(path) {
      missing.add(path);
      previousTabs = null;
    }

    function applyPosition(tab) {
      if (!tab?.restore) return;
      const { top = 1, line = 1 } = tab.restore;
      const apply = () => {
        if (editorHost?.revealTopLine?.(tab.path, top, line) === true) delete tab.restore;
      };
      const model = editorHost?.getModel?.(tab.path);
      if (model && editorHost?.showsPath?.(tab.path) === false) {
        // The group attaches its model in the caller's open-completion handler.
        const saved = tab.restore;
        setTimeout(() => {
          if (tab.restore === saved && editorHost.getModel(tab.path) === model) apply();
        }, 0);
      } else apply();
    }

    function render(ide) {
      if (ide) {
        const tabs = (ide.openTabs || []).map((tab) => tab.path).join('\n');
        const active = [ide.activeTabPath, ...Object.values(ide.groupActive || {})].filter(Boolean).join('\n');
        if (previousTabs !== null && (tabs !== previousTabs || active !== previousActive)) tabAction();
        const before = new Set(previousActive.split('\n'));
        for (const path of active.split('\n')) if (!before.has(path)) recordActivation(path);
        previousTabs = tabs;
        previousActive = active;
        for (const path of [...activatedAt.keys()]) if (!ide.openTabs.some((tab) => tab.path === path)) activatedAt.delete(path);
      }
      const host = getDom().ideTabStrip;
      if (!host?.parentElement || !actionButton) return;
      if (!strip) {
        strip = host.ownerDocument.createElement('div');
        strip.className = 'ide-restore-strip';
        (host.closest('.ide-tabbar') || host).insertAdjacentElement('afterend', strip);
        strip.addEventListener('click', (event) => {
          if (event.target.closest('[data-ide-restore-dismiss]')) clear();
        });
        // Secondary group tabs use their own controller; observe the same user
        // intents here without changing its replace/promote or activation rules.
        const view = host.closest('#ideView') || host.ownerDocument;
        const onTabAction = (event) => {
          const label = event.target.closest('[data-ide-tab-path]');
          if (label || event.target.closest('[data-ide-tab-close]')) tabAction();
          if (label) recordActivation(label.getAttribute('data-ide-tab-path'));
        };
        view.addEventListener('click', onTabAction);
        registerCleanup(() => view.removeEventListener('click', onTabAction));
      }
      strip.hidden = missing.size === 0;
      if (strip.hidden) return;
      const names = [...missing].slice(0, 5).map((path) => path.split(/[\\/]/).pop());
      if (missing.size > 5) names.push('…');
      const message = jtn('ide.restore.missingFiles', missing.size, { count: missing.size, names: names.join(', ') },
        'One file from last time is gone: {names}', '{count} files from last time are gone: {names}');
      const label = jt('ide.restore.dismiss', 'Dismiss');
      strip.innerHTML = `<span>${escapeHtml(message)}</span>` + actionButton({
        plain: true, className: 'ide-restore-strip-dismiss', label, title: label, ariaLabel: label,
        dataset: { 'ide-restore-dismiss': '' },
      });
    }

    return {
      applyPosition, capture, clear, hydrate, probe, recordActivation, recordMissing, render, tabAction,
      async runRestore(action) {
        restoring = true;
        try { return await action(); } finally { restoring = false; }
      },
      isRestoring: (tab) => restoring || Boolean(tab?.restore),
    };
  }

  return { createIdeTabRestore };
});
