/* renderer/features/renderer-changes-working-tree.js
 * Controller for the read-only "Working tree" page of the Changes side panel
 * (row 59 checkpoint 2, PO rows "Changes detail" and "Changes panel alignment").
 *
 * Data: window.jennyShell.chatWorkspace.listChanges for the file list and
 * getChangeDiff per EXPANDED file (lazy, one in flight per file, at most
 * MAX_PARALLEL_DIFFS at once). Nothing here stages, commits or discards.
 *
 * The page's session is the panel OWNER (getSessionId, supplied by the caller
 * from the explicit owner passed to open()), never the active session: a focus
 * change in a split view cannot retarget it.
 *
 * It renders into one root: the scope row (branch, tools, Working tree / This
 * chat switch) and the list body. With scope "this_chat" the body is hidden and
 * the host shows the existing ledger view instead; the switch stays.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./renderer-changes-working-tree-render'),
      require('../chat/renderer-unified-diff-parse'),
      require('../inventory/segmented-control')
    );
    return;
  }
  root.rendererChangesWorkingTree = factory(root.rendererChangesWorkingTreeRender, root.rendererUnifiedDiffParse, root.inventorySegmentedControl);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (renderModule, diffParse, segmentedControl) {
  'use strict';

  const MAX_FILES = 500;
  const MAX_PATH_LENGTH = 1024;
  const MAX_EXPAND_ALL = 40;
  const MAX_PARALLEL_DIFFS = 3;
  const REFRESH_DELAY_MS = 250;
  const CHANGE_KINDS = new Set(['modified', 'added', 'deleted', 'renamed', 'copied', 'untracked', 'conflicted', 'type_changed']);

  function toCount(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }

  function sanitizeFiles(rawFiles) {
    const files = [];
    const seen = new Set();
    for (const raw of Array.isArray(rawFiles) ? rawFiles : []) {
      const path = raw && typeof raw.path === 'string' ? raw.path : '';
      if (!path || path.length > MAX_PATH_LENGTH || seen.has(path)) continue;
      seen.add(path);
      files.push({
        path,
        change: CHANGE_KINDS.has(raw.change) ? raw.change : 'modified',
        binary: raw.binary === true,
        additions: toCount(raw.additions),
        deletions: toCount(raw.deletions),
      });
      if (files.length >= MAX_FILES) break;
    }
    return files;
  }

  function createChangesWorkingTree(deps = {}) {
    const getBridge = typeof deps.getBridge === 'function' ? deps.getBridge : () => (globalThis.jennyShell && globalThis.jennyShell.chatWorkspace) || null;
    const getSessionId = typeof deps.getSessionId === 'function' ? deps.getSessionId : () => '';
    const openInWorkspace = typeof deps.openInWorkspace === 'function' ? deps.openInWorkspace : null;
    const openInGit = typeof deps.openInGit === 'function' ? deps.openInGit : null;
    const onScopeChange = typeof deps.onScopeChange === 'function' ? deps.onScopeChange : null;
    const log = typeof deps.log === 'function' ? deps.log : () => {};
    const setTimer = typeof deps.setTimeout === 'function' ? deps.setTimeout : globalThis.setTimeout;
    const clearTimer = typeof deps.clearTimeout === 'function' ? deps.clearTimeout : globalThis.clearTimeout;
    const parse = (deps.parseUnifiedDiff || (diffParse && diffParse.parseUnifiedDiff));
    const render = renderModule.createWorkingTreeRender({
      escapeHtml: deps.escapeHtml, actionButton: deps.actionButton, fileDiffView: deps.fileDiffView, codeHighlight: deps.codeHighlight,
    });
    const segmented = deps.segmentedControl || segmentedControl;

    let rootEl = null;
    let scopeEl = null;
    let bodyEl = null;
    let disposed = false;
    let unsubscribe = null;
    let refreshTimer = null;
    let scope = 'working_tree';
    let sessionKey = '';
    let loadToken = 0;
    let loading = false;
    let loadAgain = false;
    let status = 'checking';
    let data = null;
    let files = [];
    let expanded = new Set();
    let diffs = new Map(); // path -> { state, sig, hunks, truncated }
    let queue = [];
    let inFlight = 0;
    let filterOpen = false;
    let filter = '';
    let lastScopeHtml = '';
    let lastFilterOpen = null;
    let loadedOnce = false;

    const sig = (file) => `${file.change}:${file.additions}:${file.deletions}:${file.binary ? 1 : 0}`;

    function resetForSession(next) {
      sessionKey = next;
      loadToken += 1;
      status = 'checking';
      data = null;
      files = [];
      expanded = new Set();
      diffs = new Map();
      queue = [];
      filterOpen = false;
      filter = '';
      lastFilterOpen = null;
    }

    function visibleFiles() {
      const needle = filter.trim().toLowerCase();
      return needle ? files.filter((file) => file.path.toLowerCase().includes(needle)) : files;
    }

    function buildModel() {
      const visible = visibleFiles();
      return {
        scope,
        status,
        branch: data && typeof data.branch === 'string' ? data.branch : '',
        fileCount: data && Number.isSafeInteger(data.file_count) ? data.file_count : files.length,
        additions: data ? toCount(data.additions) : null,
        deletions: data ? toCount(data.deletions) : null,
        truncated: data ? data.truncated === true : false,
        filterOpen,
        filter,
        allExpanded: visible.length > 0 && visible.every((file) => expanded.has(file.path)),
        files: visible.map((file) => ({ ...file, expanded: expanded.has(file.path), diff: diffs.get(file.path) || null })),
      };
    }

    /* ── Rendering ── */

    function focusKeyOf(element) {
      if (!element || typeof element.closest !== 'function') return null;
      const toggle = element.closest('[data-file-diff-toggle]');
      if (toggle) return { attr: 'data-diff-id', value: toggle.getAttribute('data-diff-id'), within: '[data-file-diff-toggle]' };
      const open = element.closest('[data-changes-wt-open]');
      if (open) return { attr: 'data-changes-wt-open', value: open.getAttribute('data-changes-wt-open') };
      const git = element.closest('[data-changes-wt-open-git]');
      if (git) return { attr: 'data-changes-wt-open-git', value: '' };
      const segmentedOption = element.closest('.inv-segmented-option');
      if (segmentedOption) return { attr: 'data-value', value: segmentedOption.getAttribute('data-value'), within: '.inv-segmented-option' };
      const tool = element.closest('[data-changes-wt-filter-toggle], [data-changes-wt-expand-all]');
      if (tool) return { attr: tool.hasAttribute('data-changes-wt-filter-toggle') ? 'data-changes-wt-filter-toggle' : 'data-changes-wt-expand-all', value: '' };
      return null;
    }

    function restoreFocus(container, key) {
      if (!key || !container) return;
      const candidates = container.querySelectorAll(key.within || `[${key.attr}]`);
      for (const candidate of candidates) {
        if (candidate.getAttribute(key.attr) === key.value && typeof candidate.focus === 'function') {
          candidate.focus({ preventScroll: true });
          return;
        }
      }
    }

    function renderScopeRow(model) {
      if (!scopeEl) return;
      const html = render.buildScopeRowHtml(model);
      if (html === lastScopeHtml) return;
      lastScopeHtml = html;
      const doc = scopeEl.ownerDocument;
      const key = doc && scopeEl.contains(doc.activeElement) ? focusKeyOf(doc.activeElement) : null;
      scopeEl.innerHTML = html;
      restoreFocus(scopeEl, key);
    }

    function renderBody(model) {
      if (!bodyEl) return;
      const working = scope === 'working_tree';
      bodyEl.hidden = !working;
      if (!working) return;
      const doc = bodyEl.ownerDocument;
      const key = doc && bodyEl.contains(doc.activeElement) ? focusKeyOf(doc.activeElement) : null;
      const holder = doc.createElement('div');
      holder.innerHTML = render.buildBodyHtml(model);
      const next = holder.firstElementChild;
      bodyEl.setAttribute('data-changes-wt-status', next.getAttribute('data-changes-wt-status') || '');
      const regions = ['filter', 'content'];
      for (const name of regions) {
        const target = bodyEl.querySelector(`[data-changes-wt-region="${name}"]`);
        const fresh = next.querySelector(`[data-changes-wt-region="${name}"]`);
        if (!fresh) continue;
        if (!target) { bodyEl.appendChild(fresh); continue; }
        if (name === 'filter' && lastFilterOpen === (model.filterOpen && model.status === 'ready') && target.firstElementChild) continue;
        target.replaceChildren(...Array.from(fresh.childNodes));
      }
      lastFilterOpen = model.filterOpen && model.status === 'ready';
      restoreFocus(bodyEl, key);
    }

    function renderAll() {
      if (disposed || !rootEl) return;
      const model = buildModel();
      renderScopeRow(model);
      renderBody(model);
    }

    /* ── Data ── */

    function applyListing(response) {
      if (!response || response.ok !== true) {
        status = 'unavailable';
        data = null;
        files = [];
        return;
      }
      if (response.state === 'not_applicable') { status = 'not_applicable'; data = null; files = []; return; }
      if (response.state !== 'available' || !response.data || typeof response.data !== 'object') {
        status = 'unavailable';
        data = null;
        files = [];
        return;
      }
      const nextData = response.data;
      const firstLoad = status === 'checking' || !data;
      const workspaceChanged = data && nextData.workspace_id !== data.workspace_id;
      data = nextData;
      files = sanitizeFiles(nextData.files);
      status = files.length ? 'ready' : 'empty';
      const present = new Set(files.map((file) => file.path));
      if (firstLoad || workspaceChanged) {
        expanded = new Set(files.length ? [files[0].path] : []);
        diffs = new Map();
      } else {
        expanded = new Set(Array.from(expanded).filter((path) => present.has(path)));
        for (const path of Array.from(diffs.keys())) if (!present.has(path)) diffs.delete(path);
      }
    }

    async function load() {
      if (disposed || !rootEl) return;
      const sessionId = String(getSessionId() || '');
      if (sessionId !== sessionKey) resetForSession(sessionId);
      if (loading) { loadAgain = true; return; }
      const bridge = getBridge();
      if (!sessionId || !bridge || typeof bridge.listChanges !== 'function') {
        status = 'unavailable';
        data = null;
        files = [];
        renderAll();
        return;
      }
      loading = true;
      const token = ++loadToken;
      if (status === 'checking') renderAll();
      let response = null;
      try {
        response = await bridge.listChanges({ schema_version: 1, session_id: sessionId });
      } catch (error) {
        log('WARN', 'changes_working_tree.list_failed', { message: String(error && error.message || error).slice(0, 200) });
      }
      loading = false;
      if (disposed || token !== loadToken) return;
      loadedOnce = true;
      applyListing(response);
      renderAll();
      for (const file of files) if (expanded.has(file.path)) ensureDiff(file.path);
      if (loadAgain) { loadAgain = false; load(); }
    }

    function pump() {
      while (inFlight < MAX_PARALLEL_DIFFS && queue.length && !disposed) {
        const job = queue.shift();
        inFlight += 1;
        fetchDiff(job).finally(() => { inFlight -= 1; pump(); });
      }
    }

    async function fetchDiff(job) {
      const bridge = getBridge();
      let entry;
      try {
        const response = bridge && typeof bridge.getChangeDiff === 'function'
          ? await bridge.getChangeDiff({ schema_version: 1, session_id: job.sessionId, path: job.path })
          : null;
        if (!response || response.ok !== true) entry = { state: 'error', sig: job.sig };
        else if (response.binary === true) entry = { state: 'binary', sig: job.sig };
        else {
          const parsed = parse(typeof response.diff === 'string' ? response.diff : '');
          entry = { state: 'ready', sig: job.sig, hunks: parsed.hunks, truncated: parsed.truncated === true || response.truncated === true };
          if (parsed.binary) entry = { state: 'binary', sig: job.sig };
        }
      } catch (error) {
        log('WARN', 'changes_working_tree.diff_failed', { message: String(error && error.message || error).slice(0, 200) });
        entry = { state: 'error', sig: job.sig };
      }
      if (disposed || job.token !== loadToken || job.sessionId !== sessionKey) return;
      if (diffs.get(job.path) && diffs.get(job.path).pending !== job) return;
      diffs.set(job.path, entry);
      renderAll();
    }

    function ensureDiff(path) {
      const file = files.find((item) => item.path === path);
      if (!file) return;
      const signature = sig(file);
      const current = diffs.get(path);
      if (current && current.sig === signature && (current.state === 'loading' || current.state === 'ready' || current.state === 'binary')) return;
      if (file.binary) { diffs.set(path, { state: 'binary', sig: signature }); return; }
      const job = { path, sig: signature, sessionId: sessionKey, token: loadToken };
      diffs.set(path, { state: 'loading', sig: signature, pending: job, hunks: current && current.hunks, truncated: false });
      queue.push(job);
      pump();
    }

    /* ── Events ── */

    function togglePath(path) {
      if (expanded.has(path)) expanded.delete(path);
      else { expanded.add(path); ensureDiff(path); }
      renderAll();
    }

    function toggleExpandAll() {
      const visible = visibleFiles();
      if (visible.length > 0 && visible.every((file) => expanded.has(file.path))) {
        for (const file of visible) expanded.delete(file.path);
      } else {
        for (const file of visible.slice(0, MAX_EXPAND_ALL)) { expanded.add(file.path); ensureDiff(file.path); }
      }
      renderAll();
    }

    function toggleFilter() {
      filterOpen = !filterOpen;
      if (!filterOpen) filter = '';
      renderAll();
      if (filterOpen) {
        const input = bodyEl && bodyEl.querySelector('[data-changes-wt-filter-input]');
        if (input && typeof input.focus === 'function') input.focus();
      } else {
        const button = bodyEl && bodyEl.querySelector('[data-changes-wt-filter-toggle]');
        if (button && typeof button.focus === 'function') button.focus();
      }
    }

    function pathForDiffId(diffId) {
      const path = String(diffId || '').startsWith('wt:') ? String(diffId).slice(3) : '';
      return files.some((file) => file.path === path) ? path : '';
    }

    function handleClick(event) {
      const target = event.target;
      if (!target || typeof target.closest !== 'function' || !rootEl || !rootEl.contains(target)) return;
      if (target.closest('[data-changes-wt-filter-toggle]')) { toggleFilter(); return; }
      if (target.closest('[data-changes-wt-expand-all]')) { toggleExpandAll(); return; }
      const toggle = target.closest('[data-file-diff-toggle]');
      if (toggle) {
        const path = pathForDiffId(toggle.getAttribute('data-diff-id'));
        if (path) {
          if (typeof event.stopPropagation === 'function') event.stopPropagation();
          togglePath(path);
        }
        return;
      }
      const open = target.closest('[data-changes-wt-open]');
      if (open) {
        const path = String(open.getAttribute('data-changes-wt-open') || '');
        if (openInWorkspace && files.some((file) => file.path === path)) openInWorkspace(path);
        return;
      }
      if (target.closest('[data-changes-wt-open-git]')) {
        if (openInGit) openInGit();
      }
    }

    function handleInput(event) {
      const target = event.target;
      if (!target || typeof target.closest !== 'function' || !target.closest('[data-changes-wt-filter-input]')) return;
      filter = String(target.value || '').slice(0, 200);
      renderAll();
    }

    function handleKeydown(event) {
      if (event.key !== 'Escape' || !filterOpen) return;
      const target = event.target;
      if (!target || typeof target.closest !== 'function' || !target.closest('[data-changes-wt-filter-input]')) return;
      // The filter handles Escape first (clear, then close); only then does the panel close.
      event.preventDefault();
      if (typeof event.stopPropagation === 'function') event.stopPropagation();
      if (filter) {
        filter = '';
        const input = bodyEl && bodyEl.querySelector('[data-changes-wt-filter-input]');
        if (input) input.value = '';
        renderAll();
        return;
      }
      toggleFilter();
    }

    function handleScopeChange(event) {
      const detail = event && event.detail;
      if (!detail || detail.id !== 'changes-scope') return;
      const next = detail.value === 'this_chat' ? 'this_chat' : 'working_tree';
      if (next === scope) return;
      setScope(next);
      if (onScopeChange) onScopeChange(next);
    }

    function scheduleRefresh() {
      if (refreshTimer !== null) return;
      refreshTimer = setTimer(() => {
        refreshTimer = null;
        if (!disposed && scope === 'working_tree') load();
      }, REFRESH_DELAY_MS);
    }

    function subscribe() {
      if (unsubscribe) return;
      const bridge = getBridge();
      if (!bridge || typeof bridge.onChanged !== 'function') return;
      const off = bridge.onChanged((event) => {
        if (scope !== 'working_tree' || !event || String(event.session_id || '') !== String(getSessionId() || '')) return;
        scheduleRefresh();
      });
      unsubscribe = typeof off === 'function' ? off : null;
    }

    /* ── Public ── */

    // A render pass never reloads: only a new root, a scope change to the page, or a new owner does.
    function loadIfNeeded(changed) {
      const owner = String(getSessionId() || '');
      if (scope === 'working_tree' && (changed || !loadedOnce || owner !== sessionKey)) load();
    }

    function setScope(next) {
      const nextScope = next === 'this_chat' ? 'this_chat' : 'working_tree';
      const changed = nextScope !== scope;
      scope = nextScope;
      renderAll();
      loadIfNeeded(changed);
    }

    function mount(element) {
      if (disposed || !element) return;
      if (rootEl === element) { renderAll(); loadIfNeeded(false); return; }
      unmount();
      rootEl = element;
      const doc = element.ownerDocument;
      rootEl.classList.add('changes-wt');
      scopeEl = doc.createElement('div');
      scopeEl.className = 'changes-wt-scope';
      bodyEl = doc.createElement('div');
      bodyEl.className = 'changes-wt-scroll';
      bodyEl.setAttribute('data-changes-wt-body', '');
      rootEl.replaceChildren(scopeEl, bodyEl);
      lastScopeHtml = '';
      lastFilterOpen = null;
      if (segmented && typeof segmented.initSegmentedHandlers === 'function') segmented.initSegmentedHandlers(rootEl);
      rootEl.addEventListener('click', handleClick);
      rootEl.addEventListener('input', handleInput);
      rootEl.addEventListener('keydown', handleKeydown);
      rootEl.addEventListener('inv-segmented-change', handleScopeChange);
      subscribe();
      // The scroller holds the region slots; the first render creates them.
      bodyEl.innerHTML = '<div data-changes-wt-region="filter"></div><div data-changes-wt-region="content"></div>';
      renderAll();
      loadedOnce = false;
      loadIfNeeded(false);
    }

    function unmount() {
      if (!rootEl) return;
      rootEl.removeEventListener('click', handleClick);
      rootEl.removeEventListener('input', handleInput);
      rootEl.removeEventListener('keydown', handleKeydown);
      rootEl.removeEventListener('inv-segmented-change', handleScopeChange);
      if (refreshTimer !== null) { clearTimer(refreshTimer); refreshTimer = null; }
      if (unsubscribe) { unsubscribe(); unsubscribe = null; }
      loadToken += 1;
      queue = [];
      rootEl.classList.remove('changes-wt');
      rootEl.replaceChildren();
      rootEl = null;
      scopeEl = null;
      bodyEl = null;
    }

    function dispose() {
      unmount();
      disposed = true;
    }

    return {
      mount,
      unmount,
      dispose,
      setScope,
      getScope: () => scope,
      refresh: load,
      getState: () => ({ status, scope, files: files.map((file) => file.path), expanded: Array.from(expanded), filter, filterOpen }),
    };
  }

  return { createChangesWorkingTree, sanitizeFiles, MAX_PARALLEL_DIFFS, MAX_EXPAND_ALL };
});
