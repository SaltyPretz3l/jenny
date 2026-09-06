/* renderer/features/renderer-workspace-presentation-controller.js — renderer
 * policy for model-initiated workspace presentation requests
 * (WORKSPACE_PREVIEW_AND_MAP_PANELS_PLAN.md Phase 7). Subscribes to the
 * one-shot `workspacePresentation.onRequest` push (never transcript metadata,
 * so a request can never replay on reload/rehydrate) and decides between:
 *
 *   apply immediately — only when it is SAFE: the Workspace IDE is the active
 *     view, Monaco has no recent typing, no blocking approval row is pending,
 *     and requests are not oscillating between surfaces; or
 *   a NON-STEALING pending chip — "Jenny wants to show …" with an explicit
 *     Show action (aria-live polite, no focus move, newest request wins,
 *     dismissible). User-initiated activation (the chip's Show button) always
 *     switches immediately.
 *
 * Rapid requests COALESCE to the newest within a short window instead of
 * thrashing the stage. All timings are injectable for tests. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererWorkspacePresentationController = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  function noop() {}

  function resolveActionButton() {
    if (typeof globalRef.inventoryActionButton === 'function') {
      return globalRef.inventoryActionButton;
    }
    if (typeof require === 'function') {
      try {
        return require('../inventory/action-button');
      } catch (_error) {
        /* unavailable */
      }
    }
    return null;
  }

  const COALESCE_MS = 400;
  // "Recent typing" horizon: a model switch within this window of the user's
  // last edit would steal their context mid-thought.
  const TYPING_GUARD_MS = 4000;
  // Oscillation guard: more than this many APPLIED model switches inside the
  // window stops auto-applying (the chip takes over) until the window drains.
  const OSCILLATION_MAX = 3;
  const OSCILLATION_WINDOW_MS = 10_000;
  const PENDING_APPROVAL_SELECTOR = '.approval-gap-row[data-approval-status="pending"]:not([data-approval-resolved="true"])';

  function normalizeRelativePath(value) {
    if (typeof value !== 'string') return '';
    const raw = value.trim().replace(/\\/g, '/');
    if (!raw || raw.includes('\0') || raw.includes(':') || raw.startsWith('/')) return '';
    const parts = raw.split('/').filter((part) => part && part !== '.');
    return parts.length && !parts.includes('..') ? parts.join('/') : '';
  }

  function normalizeOpaqueId(value, maxLength = 160) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    return normalized && normalized.length <= maxLength && /^[A-Za-z0-9._:-]+$/.test(normalized)
      ? normalized
      : '';
  }

  function createWorkspacePresentationController(deps) {
    const d = deps || {};
    const getDom = typeof d.getDom === 'function' ? d.getDom : () => ({});
    const windowRef = d.windowRef || globalRef.window || globalRef;
    const escapeHtml = typeof d.escapeHtml === 'function' ? d.escapeHtml : (v) => String(v == null ? '' : v);
    const appendClientLog = typeof d.appendClientLog === 'function' ? d.appendClientLog : noop;
    const getActiveView = typeof d.getActiveView === 'function' ? d.getActiveView : () => '';
    // Feature routing: preview → the preview stage's open(); file_map → the
    // map controller's openFileMap + revealInMap (bounded not-in-map inside).
    const openPreview = typeof d.openPreview === 'function' ? d.openPreview : noop;
    const openFileMap = typeof d.openFileMap === 'function' ? d.openFileMap : noop;
    const revealInMap = typeof d.revealInMap === 'function' ? d.revealInMap : noop;
    const getSessionId = typeof d.getSessionId === 'function' ? d.getSessionId : () => '';
    const getWorkspaceId = typeof d.getWorkspaceId === 'function' ? d.getWorkspaceId : () => '';
    const getChangeLedger = typeof d.getChangeLedger === 'function' ? d.getChangeLedger : () => ({ changes: [] });
    const openChangeDiff = typeof d.openChangeDiff === 'function' ? d.openChangeDiff : null;
    const openChangesPanel = typeof d.openChangesPanel === 'function' ? d.openChangesPanel : noop;
    const showShellErrorToast = typeof d.showShellErrorToast === 'function' ? d.showShellErrorToast : noop;
    const isSurfaceEnabled = typeof d.isSurfaceEnabled === 'function' ? d.isSurfaceEnabled : () => false;
    // Injectable now()/timers keep the policy deterministic under test.
    const now = typeof d.now === 'function' ? d.now : () => Date.now();
    const isApprovalPending = typeof d.isApprovalPending === 'function'
      ? d.isApprovalPending
      : () => !!windowRef.document?.querySelector?.(PENDING_APPROVAL_SELECTOR);
    const actionButton = resolveActionButton();

    let disposed = false;
    let unsubscribe = null;
    let lastEditAt = 0;
    let coalesceTimer = null;
    let coalescedRequest = null;
    let appliedTimestamps = [];
    let chipEl = null;
    let pendingChipRequest = null;

    // The controller's onModelChange choke point feeds this so "recent
    // typing" needs no Monaco coupling.
    function noteEdit() {
      lastEditAt = now();
    }

    function surfaceLabel(view) {
      return view === 'preview' ? 'Preview' : view === 'change_diff' ? 'change diff' : 'File Map';
    }

    function requestApi() {
      return windowRef.jennyShell?.workspacePresentation || null;
    }

    function isOscillating() {
      const cutoff = now() - OSCILLATION_WINDOW_MS;
      appliedTimestamps = appliedTimestamps.filter((ts) => ts > cutoff);
      return appliedTimestamps.length >= OSCILLATION_MAX;
    }

    function isSafeToSwitch() {
      if (getActiveView() !== 'ide') {
        return false;
      }
      if (now() - lastEditAt < TYPING_GUARD_MS) {
        return false;
      }
      if (isApprovalPending() === true) {
        return false;
      }
      return !isOscillating();
    }

    function matchesCurrentContext(request) {
      return request.view !== 'change_diff' || (
        request.sessionId === String(getSessionId() || '')
        && request.workspaceId === String(getWorkspaceId() || '').toLowerCase()
      );
    }

    function warnMissingChange() {
      openChangesPanel();
      showShellErrorToast('That recorded change is no longer available. Jenny opened the Changes panel instead.', {
        title: "Jenny's Changes",
        dedupeKey: 'workspace-presentation:change-missing',
      });
      appendClientLog('WARN', 'workspace_presentation.change_missing', {});
    }

    function warnUnavailableIntegration() {
      openChangesPanel();
      showShellErrorToast('Change review is unavailable right now. Jenny opened the Changes panel instead.', {
        title: "Jenny's Changes",
        dedupeKey: 'workspace-presentation:change-unavailable',
      });
      appendClientLog('WARN', 'workspace_presentation.change_context_rejected', {
        reason: 'integration_unavailable',
      });
    }

    function applyChangeDiff(request) {
      if (!matchesCurrentContext(request)) {
        appendClientLog('WARN', 'workspace_presentation.change_context_rejected', {
          reason: 'identity_mismatch',
        });
        return;
      }
      if (!openChangeDiff) {
        warnUnavailableIntegration();
        return;
      }
      let ledger;
      try {
        ledger = getChangeLedger() || {};
      } catch (_error) {
        warnMissingChange();
        return;
      }
      const matches = (Array.isArray(ledger.changes) ? ledger.changes : []).filter((change) => (
        String(change?.workspaceId || '').toLowerCase() === request.workspaceId
        && String(change?.path || '') === request.path
        && (!request.changeId || String(change?.changeId || '') === request.changeId)
      ));
      const change = matches[matches.length - 1] || null;
      if (!change) {
        warnMissingChange();
        return;
      }
      Promise.resolve(openChangeDiff(change)).catch((error) => {
        appendClientLog('WARN', 'workspace_presentation.change_open_failed', {
          code: String(error?.code || error?.error_code || 'open_failed').slice(0, 64),
        });
      });
    }

    function apply(request, { userInitiated = false } = {}) {
      if (disposed || !request) {
        return;
      }
      if (!userInitiated) {
        appliedTimestamps.push(now());
      }
      removeChip();
      if (request.view === 'preview') {
        openPreview(request.path || '');
      } else if (request.view === 'change_diff') {
        applyChangeDiff(request);
      } else {
        openFileMap();
        if (request.path) {
          Promise.resolve(revealInMap(request.path)).catch(() => {});
        }
      }
      appendClientLog('INFO', 'workspace_presentation.applied', {
        view: request.view,
        user_initiated: userInitiated === true,
      });
    }

    // ── Non-stealing pending affordance ─────────────────────────────────────
    // A single floating chip inside #ideMain: polite live region, explicit
    // Show action, dismiss ×, no focus moves, newest request replaces older.
    function removeChip() {
      if (chipEl) {
        chipEl.remove();
        chipEl = null;
      }
      pendingChipRequest = null;
    }

    function handleChipClick(event) {
      if (event.target?.closest?.('[data-presentation-show]')) {
        const request = pendingChipRequest;
        removeChip();
        apply(request, { userInitiated: true });
        return;
      }
      if (event.target?.closest?.('[data-presentation-dismiss]')) {
        appendClientLog('INFO', 'workspace_presentation.dismissed', {
          view: pendingChipRequest?.view || '',
        });
        removeChip();
      }
    }

    function showChip(request) {
      const host = getDom().ideMain || null;
      if (!host || !host.ownerDocument || typeof actionButton !== 'function') {
        appendClientLog('WARN', 'workspace_presentation.chip_unavailable', { view: request.view });
        return;
      }
      removeChip();
      pendingChipRequest = request;
      const documentRef = host.ownerDocument;
      chipEl = documentRef.createElement('div');
      chipEl.className = 'ide-presentation-chip';
      chipEl.setAttribute('role', 'status');
      chipEl.setAttribute('aria-live', 'polite');
      const what = request.view === 'preview'
        ? `a preview of ${request.path || 'a file'}`
        : request.view === 'change_diff'
          ? `the change to ${request.path}`
          : `the File Map${request.path ? ` for ${request.path}` : ''}`;
      chipEl.innerHTML = `<span class="ide-presentation-chip-copy">Jenny wants to show ${escapeHtml(what)}</span>`
        + actionButton({
          plain: true,
          className: 'ide-presentation-chip-show',
          label: 'Show',
          title: `Show ${surfaceLabel(request.view)}`,
          dataset: { 'presentation-show': '1' },
        })
        + actionButton({
          plain: true,
          className: 'ide-presentation-chip-dismiss',
          ariaLabel: 'Dismiss',
          title: 'Dismiss',
          dataset: { 'presentation-dismiss': '1' },
          trustedHtml: '<span aria-hidden="true">&#x2715;</span>',
        });
      chipEl.addEventListener('click', handleChipClick);
      host.appendChild(chipEl);
    }

    // ── Request intake: coalesce → policy → apply or chip ───────────────────
    function settle() {
      coalesceTimer = null;
      const request = coalescedRequest;
      coalescedRequest = null;
      if (disposed || !request) {
        return;
      }
      if (!matchesCurrentContext(request)) {
        appendClientLog('INFO', 'workspace_presentation.change_dropped', {
          reason: 'context_changed',
        });
        return;
      }
      if (isSafeToSwitch()) {
        apply(request);
      } else {
        showChip(request);
        appendClientLog('INFO', 'workspace_presentation.deferred', { view: request.view });
      }
    }

    function handleRequest(payload) {
      if (disposed || !payload || typeof payload !== 'object') {
        return;
      }
      const view = payload.view === 'preview'
        ? 'preview'
        : payload.view === 'file_map'
          ? 'file_map'
          : payload.view === 'change_diff' ? 'change_diff' : '';
      if (!view || isSurfaceEnabled(view) !== true) {
        appendClientLog('WARN', 'workspace_presentation.request_rejected', {
          view: String(payload.view || ''),
        });
        return;
      }
      const rawPath = typeof payload.path === 'string' ? payload.path : '';
      const path = rawPath ? normalizeRelativePath(rawPath) : '';
      const sessionId = normalizeOpaqueId(payload.session_id);
      const workspaceId = normalizeOpaqueId(payload.workspace_id, 64).toLowerCase();
      const changeId = payload.change_id ? normalizeOpaqueId(payload.change_id) : '';
      if (view === 'change_diff' && (!path || !sessionId
        || !/^root_[0-9a-f]{24}$/.test(workspaceId)
        || (payload.change_id && !changeId))) {
        appendClientLog('WARN', 'workspace_presentation.request_rejected', {
          view,
          reason: 'invalid_change_diff',
        });
        return;
      }
      // Newest-request-wins coalescing within the window.
      coalescedRequest = { view, path, sessionId, workspaceId, changeId };
      if (!coalesceTimer) {
        coalesceTimer = windowRef.setTimeout(settle, COALESCE_MS);
      }
    }

    function bindEvents() {
      if (disposed || unsubscribe) {
        return;
      }
      const api = requestApi();
      if (typeof api?.onRequest !== 'function') {
        return; // preload surface absent (older shell) — feature degrades off
      }
      unsubscribe = api.onRequest((payload) => handleRequest(payload)) || null;
    }

    function dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      if (coalesceTimer) {
        windowRef.clearTimeout(coalesceTimer);
        coalesceTimer = null;
      }
      if (typeof unsubscribe === 'function') {
        try { unsubscribe(); } catch (_error) { /* already gone */ }
      }
      unsubscribe = null;
      removeChip();
    }

    return {
      COALESCE_MS,
      TYPING_GUARD_MS,
      bindEvents,
      dispose,
      handleRequest,
      noteEdit,
    };
  }

  return { createWorkspacePresentationController };
});
