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
 * It renders into one root: the scope row (branch, Working tree / This chat /
 * Whole branch switch), the summary line with the list tools, and the list body.
 * Working tree and Whole branch each keep their own listing, expanded files and
 * diffs (renderer-changes-scope-data.js); Whole branch appears only while a
 * `scope: 'branch'` listing answers (a not_applicable answer removes it). With
 * scope "this_chat" the body is hidden and the host shows the existing ledger
 * view instead; the switch stays.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./renderer-changes-working-tree-render'),
      require('../chat/renderer-unified-diff-parse'),
      require('../inventory/segmented-control'),
      require('./renderer-changes-scope-data')
    );
    return;
  }
  root.rendererChangesWorkingTree = factory(root.rendererChangesWorkingTreeRender, root.rendererUnifiedDiffParse, root.inventorySegmentedControl, root.rendererChangesScopeData);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (renderModule, diffParse, segmentedControl, scopeData) {
  'use strict';

  const MAX_EXPAND_ALL = 40;
  const MAX_PARALLEL_DIFFS = 3;
  const REFRESH_DELAY_MS = 250;
  const BRANCH_PROBE_MIN_MS = 15000;
  const { sanitizeFiles, toCount } = scopeData;

  function createChangesWorkingTree(deps = {}) {
    const getBridge = typeof deps.getBridge === 'function' ? deps.getBridge : () => (globalThis.jennyShell && globalThis.jennyShell.chatWorkspace) || null;
    const getSessionId = typeof deps.getSessionId === 'function' ? deps.getSessionId : () => '';
    const openInWorkspace = typeof deps.openInWorkspace === 'function' ? deps.openInWorkspace : null;
    const openInGit = typeof deps.openInGit === 'function' ? deps.openInGit : null;
    const onScopeChange = typeof deps.onScopeChange === 'function' ? deps.onScopeChange : null;
    // The paths this chat changed (a Set), or null while they are not known; with the subscription for when they load.
    const getChatChangedPaths = typeof deps.getChatChangedPaths === 'function' ? deps.getChatChangedPaths : null;
    const subscribeChatChanges = typeof deps.subscribeChatChanges === 'function' ? deps.subscribeChatChanges : null;
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
    let unsubscribeChat = null;
    let refreshTimer = null;
    // Counts the working tree listings applied; the pictures slot carries it.
    let listingCount = 0;
    let lastBranchProbe = 0;
    let scope = 'working_tree';
    let sessionKey = '';
    // One slice per git page: the listing, expanded files and diffs never cross between Working tree and Whole branch.
    let slices = freshSlices();
    let filterOpen = false;
    let filter = '';
    let lastScopeHtml = '';
    let lastFilterOpen = null;
    // Row 64: a chat findings list's Show in diff. { sessionId, toolCallId, focusIndex, focusPath, byPath, scrollPending }
    let review = null;
    const loader = scopeData.createDiffLoader({
      getBridge, parse, maxParallel: MAX_PARALLEL_DIFFS, log,
      isLive: (slice) => slices[slice.scope] === slice,
      onSettled: () => renderAll(),
    });

    function freshSlices() {
      return { working_tree: scopeData.createSlice('working_tree'), branch: scopeData.createSlice('branch') };
    }

    // The slice the page shows; This chat keeps the Working tree's for the branch name.
    const cur = () => slices[scope] || slices.working_tree;

    function resetForSession(next) {
      if (review && review.sessionId !== next) review = null;
      sessionKey = next;
      for (const slice of Object.values(slices)) slice.token += 1;
      loader.dropQueued();
      slices = freshSlices();
      filterOpen = false;
      filter = '';
      lastFilterOpen = null;
    }

    // Whole branch shows once a branch listing answered, and stays while it is the selected page.
    function branchTabShown() {
      const status = slices.branch.status;
      return status === 'ready' || status === 'empty' || (scope === 'branch' && status !== 'not_applicable');
    }

    function visibleFiles() {
      const needle = filter.trim().toLowerCase();
      const files = cur().files;
      return needle ? files.filter((file) => file.path.toLowerCase().includes(needle)) : files;
    }

    function buildModel() {
      const slice = cur();
      const data = slice.data;
      const visible = visibleFiles();
      const working = scope === 'working_tree';
      return {
        scope,
        status: slice.status,
        branch: data && typeof data.branch === 'string' ? data.branch : '',
        branchAvailable: branchTabShown(),
        baseRef: scope === 'branch' && data && typeof data.base_ref === 'string' ? data.base_ref : '',
        commitCount: scope === 'branch' && data ? toCount(data.commit_count) : null,
        notFromChat: working ? scopeData.countNotFromChat(slice.files, slice.chatPaths) : null,
        fileCount: data && Number.isSafeInteger(data.file_count) ? data.file_count : slice.files.length,
        additions: data ? toCount(data.additions) : null,
        deletions: data ? toCount(data.deletions) : null,
        truncated: data ? data.truncated === true : false,
        filterOpen,
        filter,
        allExpanded: visible.length > 0 && visible.every((file) => slice.expanded.has(file.path)),
        files: visible.map((file) => ({
          ...file, expanded: slice.expanded.has(file.path), diff: slice.diffs.get(file.path) || null,
          reviewFindings: review && working ? review.byPath.get(file.path) || null : null,
        })),
        review: review && working ? { sessionId: review.sessionId, toolCallId: review.toolCallId, focusIndex: review.focusIndex } : null,
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
      const listed = scope !== 'this_chat';
      bodyEl.hidden = !listed;
      // The hidden page keeps no diff rows for the panel's text actions and find to reach.
      syncPictures(scope === 'working_tree' && model.status === 'ready');
      if (!listed) { bodyEl.querySelector('[data-changes-wt-region="content"]')?.replaceChildren(); return; }
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

    // Row 122: before and after pictures of the working tree's pages. The slot sits outside the
    // content region so a list refresh never redraws them; each new listing renames the slot,
    // which is what asks for the pictures again.
    function syncPictures(show) {
      const region = bodyEl.querySelector('[data-changes-wt-region="pictures"]');
      if (!region) return;
      const slot = region.firstElementChild;
      if (!show) { if (slot) region.replaceChildren(); return; }
      if (!slot) region.innerHTML = render.buildPicturesSlotHtml(listingCount);
      else if (slot.getAttribute('data-cp-working-tree') !== String(listingCount)) slot.setAttribute('data-cp-working-tree', String(listingCount));
    }

    function renderAll() {
      if (disposed || !rootEl) return;
      const model = buildModel();
      renderScopeRow(model);
      renderBody(model);
      scrollToReviewFocus();
    }

    // Once the focused finding's comment is in the page, bring it into view (one time per Show in diff).
    function scrollToReviewFocus() {
      if (!review || !review.scrollPending || !bodyEl) return;
      const comment = bodyEl.querySelector('[data-review-focus="true"]');
      if (!comment) return;
      review.scrollPending = false;
      if (typeof comment.scrollIntoView === 'function') comment.scrollIntoView({ block: 'center' });
    }

    // Until its comment is shown, the focused finding's file opens with its diff, even when a reload reset
    // the expanded set; after that the user's collapse sticks. A listing without that file ends the pending
    // scroll, so renders stop looking for a comment that cannot appear.
    function expandReviewFocus() {
      if (!review || !review.focusPath || !review.scrollPending) return;
      const slice = slices.working_tree;
      if (!slice.files.some((file) => file.path === review.focusPath)) {
        if (slice.status !== 'checking') review.scrollPending = false;
        return;
      }
      slice.expanded.add(review.focusPath);
      loader.ensure(slice, sessionKey, review.focusPath);
    }

    function setReviewFindings(payload) {
      // Findings arrive bounded by the chat block (parseReviewFindings caps them); only located ones show here.
      const located = (Array.isArray(payload?.findings) ? payload.findings : [])
        .filter((finding) => finding && typeof finding.file === 'string' && finding.file);
      const byPath = new Map();
      for (const finding of located) {
        if (!byPath.has(finding.file)) byPath.set(finding.file, []);
        byPath.get(finding.file).push(finding);
      }
      if (!byPath.size && !review) return;
      const focus = located.find((finding) => finding.index === Number(payload.focusIndex)) || null;
      review = byPath.size ? {
        sessionId: String(payload.sessionId || sessionKey || ''),
        toolCallId: String(payload.toolCallId || ''),
        focusIndex: focus ? focus.index : 0,
        focusPath: focus ? focus.file : '',
        byPath,
        scrollPending: Boolean(focus),
      } : null;
      expandReviewFocus();
      renderAll();
    }

    /* ── Data ── */

    // The paths this chat changed, for the Working tree's "not changed by this chat" line; unknown stays null.
    function refreshChatPaths() {
      const slice = slices.working_tree;
      slice.chatPaths = null;
      if (!getChatChangedPaths || !slice.files.length) return;
      try {
        const paths = getChatChangedPaths();
        if (paths instanceof Set) slice.chatPaths = paths;
      } catch (error) {
        log('WARN', 'changes_working_tree.chat_paths_failed', { message: String(error && error.message || error).slice(0, 200) });
      }
    }

    function ensureOpenDiffs(slice) {
      for (const file of slice.files) if (slice.expanded.has(file.path)) loader.ensure(slice, sessionKey, file.path);
    }

    async function load(which = scope === 'branch' ? 'branch' : 'working_tree') {
      if (disposed || !rootEl) return;
      const sessionId = String(getSessionId() || '');
      if (sessionId !== sessionKey) resetForSession(sessionId);
      const slice = slices[which];
      if (slice.loading) { slice.loadAgain = true; return; }
      const bridge = getBridge();
      if (!sessionId || !bridge || typeof bridge.listChanges !== 'function') {
        slice.status = 'unavailable';
        slice.data = null;
        slice.files = [];
        renderAll();
        return;
      }
      slice.loading = true;
      const token = ++slice.token;
      if (slice.status === 'checking' && which === scope) renderAll();
      let response = null;
      try {
        response = await bridge.listChanges(scopeData.listRequest(sessionId, which));
      } catch (error) {
        log('WARN', 'changes_working_tree.list_failed', { message: String(error && error.message || error).slice(0, 200) });
      }
      slice.loading = false;
      if (disposed) return;
      // A superseded listing (owner switch or remount) is dropped but still runs the load queued behind it.
      if (token === slice.token && slices[which] === slice) {
        slice.loadedOnce = true;
        scopeData.applyListing(slice, response);
        if (which === 'working_tree') {
          listingCount += 1;
          refreshChatPaths();
          expandReviewFocus();
        }
        renderAll();
        // A probed page that is not shown loads no diffs; switching to it asks for its open files.
        if (which === scope) ensureOpenDiffs(slice);
        // No branch comparison for this chat any more: leave the removed page.
        if (which === 'branch' && slice.status === 'not_applicable' && scope === 'branch') changeScope('working_tree');
      }
      if (slice.loadAgain) { slice.loadAgain = false; load(which); }
    }

    /* ── Events ── */

    function togglePath(path) {
      const slice = cur();
      if (slice.expanded.has(path)) slice.expanded.delete(path);
      else { slice.expanded.add(path); loader.ensure(slice, sessionKey, path); }
      renderAll();
    }

    function toggleExpandAll() {
      const slice = cur();
      const visible = visibleFiles();
      if (visible.length > 0 && visible.every((file) => slice.expanded.has(file.path))) {
        for (const file of visible) slice.expanded.delete(file.path);
      } else {
        for (const file of visible.slice(0, MAX_EXPAND_ALL)) { slice.expanded.add(file.path); loader.ensure(slice, sessionKey, file.path); }
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
        const button = rootEl && rootEl.querySelector('[data-changes-wt-filter-toggle]');
        if (button && typeof button.focus === 'function') button.focus();
      }
    }

    function pathForDiffId(diffId) {
      const path = String(diffId || '').startsWith('wt:') ? String(diffId).slice(3) : '';
      return cur().files.some((file) => file.path === path) ? path : '';
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
        if (openInWorkspace && cur().files.some((file) => file.path === path)) openInWorkspace(path);
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
      const next = scopeData.normalizeScope(detail.value);
      if (next !== scope) changeScope(next);
    }

    // A switch the person made, or a fall back from a removed page: the host follows the page.
    function changeScope(next) {
      setScope(next);
      if (onScopeChange) onScopeChange(next);
    }

    // The shown git page reloads; the Whole branch listing is probed again, at most every 15 seconds, so its tab
    // follows the repository without a full comparison on every file event.
    function scheduleRefresh() {
      if (refreshTimer !== null) return;
      refreshTimer = setTimer(() => {
        refreshTimer = null;
        if (disposed) return;
        if (scope !== 'this_chat') load(scope);
        if (scope !== 'branch' && Date.now() - lastBranchProbe >= BRANCH_PROBE_MIN_MS) {
          lastBranchProbe = Date.now();
          load('branch');
        }
      }, REFRESH_DELAY_MS);
    }

    function subscribe() {
      if (unsubscribe) return;
      const bridge = getBridge();
      if (!bridge || typeof bridge.onChanged !== 'function') return;
      const off = bridge.onChanged((event) => {
        if (!event || String(event.session_id || '') !== String(getSessionId() || '')) return;
        scheduleRefresh();
      });
      unsubscribe = typeof off === 'function' ? off : null;
    }

    // The chat's own change list finished loading: the Working tree's note may now apply.
    function subscribeChat() {
      if (unsubscribeChat || !subscribeChatChanges) return;
      const off = subscribeChatChanges(() => {
        if (disposed || !rootEl) return;
        refreshChatPaths();
        if (scope === 'working_tree') renderAll();
      });
      unsubscribeChat = typeof off === 'function' ? off : null;
    }

    /* ── Public ── */

    function ensureLoaded(which, force) {
      const slice = slices[which];
      if (force || !slice.loadedOnce || String(getSessionId() || '') !== sessionKey) load(which);
    }

    // A render pass never reloads: only a new root, a scope change to the page, or a new owner does.
    function loadIfNeeded(changed) {
      if (scope !== 'this_chat') ensureLoaded(scope, changed);
      if (scope !== 'branch') ensureLoaded('branch', false);
    }

    function setScope(next) {
      const nextScope = scopeData.normalizeScope(next);
      const changed = nextScope !== scope;
      if (changed) loader.dropQueued();
      scope = nextScope;
      renderAll();
      if (nextScope !== 'this_chat') ensureOpenDiffs(cur());
      loadIfNeeded(changed);
    }

    function mount(element) {
      if (disposed || !element) return;
      if (rootEl === element) { if (!slices.working_tree.chatPaths) refreshChatPaths(); renderAll(); loadIfNeeded(false); return; }
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
      subscribeChat();
      // The scroller holds the region slots; the first render creates them.
      bodyEl.innerHTML = '<div data-changes-wt-region="filter"></div><div data-changes-wt-region="pictures"></div><div data-changes-wt-region="content"></div>';
      renderAll();
      for (const slice of Object.values(slices)) slice.loadedOnce = false;
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
      if (unsubscribeChat) { unsubscribeChat(); unsubscribeChat = null; }
      for (const slice of Object.values(slices)) slice.token += 1;
      loader.dropQueued();
      rootEl.classList.remove('changes-wt');
      rootEl.replaceChildren();
      rootEl = null;
      scopeEl = null;
      bodyEl = null;
    }

    function dispose() {
      unmount();
      loader.stop();
      disposed = true;
    }

    return {
      mount,
      unmount,
      dispose,
      setScope,
      setReviewFindings,
      getScope: () => scope,
      getFileHunks: (path) => (cur().diffs.get(path)?.state === 'ready' ? cur().diffs.get(path).hunks : null),
      refresh: () => load(),
      getState: () => {
        const slice = cur();
        return { status: slice.status, scope, files: slice.files.map((file) => file.path), expanded: Array.from(slice.expanded), filter, filterOpen, branchAvailable: branchTabShown() };
      },
    };
  }

  return { createChangesWorkingTree, sanitizeFiles, MAX_PARALLEL_DIFFS, MAX_EXPAND_ALL };
});
