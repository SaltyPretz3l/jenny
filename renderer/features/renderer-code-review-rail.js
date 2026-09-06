/* renderer/features/renderer-code-review-rail.js
 * Phase 3B code-review rail controller.
 *
 * Owns `state.ui.codeReview` (renderer-local, never persisted), coordinates
 * mode switching on `state.ui.artifactReview.mode`, and bridges three sites:
 *
 *  1. Transcript click handlers (handleCodeReviewAction) call
 *     openCodeReviewTarget({ scope, changeId, turnId, fileKey }) to open the
 *     rail in code_review mode scoped to the requested change/turn/file/session.
 *  2. The artifact manager calls renderRailContent(surface) when the rail
 *     renders and mode === 'code_review'. The controller composes the
 *     scope payload and delegates to the pure code-review renderer.
 *  3. The rail's own click delegation (bound here) handles selection
 *     row clicks (data-jenny-code-review-select), in-rail jump-to-chat
 *     (data-jenny-jump-to-chat), and the close affordance
 *     (data-jenny-code-review-close).
 *
 * Mode flip rule: when the user opens an artifact while in code_review mode,
 * the artifact manager's openArtifactTarget resets mode back to 'artifact'.
 * codeReviewState is kept in memory so the user can re-open code review
 * later. The controller does not duplicate split-rail width/collapse
 * lifecycle — it reuses the artifact rail shell entirely.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/string-utils'));
    return;
  }
  root.rendererCodeReviewRail = factory(root.stringUtils || {});
})(typeof globalThis !== 'undefined' ? globalThis : this, function (stringUtils) {
  'use strict';

  const normalizeId = typeof stringUtils.normalizeId === 'function'
    ? stringUtils.normalizeId
    : function fallbackNormalizeId(value) { return String(value || '').trim(); };

  function normalizeScopeType(value) {
    const raw = normalizeId(value).toLowerCase();
    if (raw === 'change' || raw === 'turn' || raw === 'file' || raw === 'session') return raw;
    return '';
  }

  function sameScopeRequest(a, b) {
    if (!a || !b) return false;
    return a.type === b.type
      && a.sessionId === b.sessionId
      && a.changeId === b.changeId
      && a.turnId === b.turnId
      && a.fileKey === b.fileKey;
  }

  function ensureCodeReviewSlot(state) {
    if (!state.ui || typeof state.ui !== 'object') {
      state.ui = {};
    }
    if (!state.ui.codeReview || typeof state.ui.codeReview !== 'object') {
      state.ui.codeReview = {
        sessionId: '',
        scope: null,
        sessionModel: null,
        scopeResult: null,
        selectedChangeId: '',
        selectedFileKey: '',
        selectedTurnId: '',
      };
    }
    return state.ui.codeReview;
  }

  function resetCodeReviewSlotForSession(slot, sessionId) {
    slot.sessionId = normalizeId(sessionId);
    slot.scope = null;
    slot.sessionModel = null;
    slot.scopeResult = null;
    slot.selectedChangeId = '';
    slot.selectedFileKey = '';
    slot.selectedTurnId = '';
  }

  function deriveInitialSelection(scopeResult, payload) {
    if (!scopeResult || !Array.isArray(scopeResult.changes) || scopeResult.changes.length === 0) {
      return { changeId: '', fileKey: '', turnId: '' };
    }
    const scopeType = normalizeScopeType(scopeResult?.scope?.type || scopeResult?.type || 'session');
    if (scopeType === 'change') {
      const requestedChangeId = normalizeId(payload?.changeId);
      const exact = scopeResult.changes.find((change) => normalizeId(change?.changeId) === requestedChangeId);
      const fallback = exact || scopeResult.changes[0];
      return {
        changeId: normalizeId(fallback?.changeId),
        fileKey: normalizeId(fallback?.fileKey),
        turnId: normalizeId(fallback?.turnId),
      };
    }
    const first = scopeResult.changes[0];
    return {
      changeId: normalizeId(first?.changeId),
      fileKey: normalizeId(first?.fileKey),
      turnId: normalizeId(first?.turnId),
    };
  }

  function createCodeReviewRail(deps) {
    const {
      state,
      dom = {},
      codeReviewRenderer,
      buildJennyChangeLedgerFromTurnViewModels,
      buildSessionDiffReviewModel,
      resolveReviewScope,
      getTurnViewModelsForActiveSession = function noopGetTurnViewModels() { return []; },
      getActiveSessionId = function noopGetActiveSessionId() { return ''; },
      getWorkspaceId = function noopGetWorkspaceId() { return 'default'; },
      setArtifactRailMode = function noopSetArtifactRailMode() {},
      renderArtifactReviewPanel = function noopRenderArtifactReviewPanel() {},
      syncArtifactReviewLayout = function noopSyncArtifactReviewLayout() {},
      jumpToArtifactSource = function noopJumpToArtifactSource() {},
      appendClientLog = function noopAppendClientLog() {},
      showComposerActionError = function noopShowComposerActionError() {},
    } = deps || {};

    if (!state) {
      throw new Error('renderer-code-review-rail: state dep is required');
    }
    if (!codeReviewRenderer || typeof codeReviewRenderer.renderInto !== 'function') {
      throw new Error('renderer-code-review-rail: codeReviewRenderer dep is required');
    }
    if (typeof buildSessionDiffReviewModel !== 'function' || typeof resolveReviewScope !== 'function') {
      throw new Error('renderer-code-review-rail: session model dep is required');
    }

    const { artifactReviewPanel } = dom;
    let bound = false;
    // Closure-scope so the originating opener (tool-row affordance or
    // assistant-turn summary button) cannot leak into serializable UI state.
    // Captured on a fresh open and restored on close.
    let previousFocusEl = null;

    function buildSessionModelForActiveSession() {
      const sessionId = normalizeId(getActiveSessionId());
      const workspaceId = normalizeId(getWorkspaceId()) || 'default';
      const turnViewModels = getTurnViewModelsForActiveSession() || [];
      const ledgerInput = typeof buildJennyChangeLedgerFromTurnViewModels === 'function'
        ? buildJennyChangeLedgerFromTurnViewModels(turnViewModels, { sessionId, workspaceId })
        : { sessionId, workspaceId, changes: [], skipped: [] };
      return buildSessionDiffReviewModel(ledgerInput, { sessionId });
    }

    function setMode(modeFlag) {
      try {
        setArtifactRailMode(modeFlag);
      } catch (_error) {
        /* artifact manager not bound yet — sync on next render */
      }
    }

    function getRailDocument() {
      if (artifactReviewPanel && artifactReviewPanel.ownerDocument) return artifactReviewPanel.ownerDocument;
      if (typeof document !== 'undefined') return document;
      return null;
    }

    function capturePreviousFocus() {
      const doc = getRailDocument();
      if (!doc) return;
      const candidate = doc.activeElement;
      if (!candidate || typeof candidate.focus !== 'function') return;
      // Re-opens (user re-clicks an affordance while the rail is already
      // focused) must not clobber the original opener.
      if (artifactReviewPanel && typeof artifactReviewPanel.contains === 'function'
          && artifactReviewPanel.contains(candidate)) return;
      previousFocusEl = candidate;
    }

    function focusInitialRow() {
      if (!artifactReviewPanel || typeof artifactReviewPanel.querySelector !== 'function') return;
      const root = artifactReviewPanel.querySelector('.jenny-code-review-root');
      if (!root) return;
      const target = root.querySelector('[role="option"][tabindex="0"]')
        || root.querySelector('[role="option"][aria-selected="true"]')
        || root.querySelector('[role="option"]');
      if (target && typeof target.focus === 'function') {
        try { target.focus({ preventScroll: false }); } catch (_) { /* best-effort */ }
      }
    }

    function restorePreviousFocus() {
      const doc = getRailDocument();
      const previous = previousFocusEl;
      previousFocusEl = null;
      if (previous && previous.isConnected && typeof previous.focus === 'function') {
        try { previous.focus({ preventScroll: false }); return; } catch (_) { /* fall through */ }
      }
      if (!doc) return;
      const fallback = doc.querySelector('.chat-entry[tabindex="0"]') || doc.querySelector('.chat-entry');
      if (fallback && typeof fallback.focus === 'function') {
        try { fallback.focus({ preventScroll: false }); return; } catch (_) { /* fall through */ }
      }
      if (doc.body && typeof doc.body.focus === 'function') {
        try { doc.body.focus(); } catch (_) { /* best-effort */ }
      }
    }

    function openCodeReviewTarget(payload) {
      const scopeType = normalizeScopeType(payload?.scope);
      if (!scopeType) {
        appendClientLog('WARN', 'code_review.open_invalid_scope', { scope: String(payload?.scope || '') });
        return false;
      }
      const activeSessionId = normalizeId(getActiveSessionId());
      const scopeRequest = {
        type: scopeType,
        sessionId: activeSessionId,
        changeId: normalizeId(payload?.changeId),
        turnId: normalizeId(payload?.turnId),
        fileKey: normalizeId(payload?.fileKey),
      };
      const slot = ensureCodeReviewSlot(state);
      if (slot.sessionId !== activeSessionId) resetCodeReviewSlotForSession(slot, activeSessionId);
      const alreadyOpen = slot.scopeResult && slot.scopeResult.found === true && sameScopeRequest(slot.scope, scopeRequest);
      if (alreadyOpen) {
        setMode('code_review');
        syncArtifactReviewLayout();
        renderArtifactReviewPanel();
        focusInitialRow();
        return true;
      }
      const sessionModel = buildSessionModelForActiveSession();
      const scopeResult = resolveReviewScope(sessionModel, scopeRequest);
      if (!scopeResult || scopeResult.found !== true) {
        appendClientLog('WARN', 'code_review.scope_not_found', {
          scope: scopeType,
          reason: String(scopeResult?.reason || 'unknown'),
        });
        showComposerActionError(
          new Error('Could not find that change in the current session.'),
          'Code Review Unavailable'
        );
        return false;
      }
      // Capture the opener before flipping mode so we save the originating
      // affordance, not the rail itself once focus moves into it.
      capturePreviousFocus();
      slot.sessionModel = sessionModel;
      slot.scopeResult = scopeResult;
      slot.scope = scopeRequest;
      const initial = deriveInitialSelection(scopeResult, payload);
      slot.selectedChangeId = initial.changeId;
      slot.selectedFileKey = initial.fileKey;
      slot.selectedTurnId = initial.turnId;
      setMode('code_review');
      syncArtifactReviewLayout();
      renderArtifactReviewPanel();
      focusInitialRow();
      return true;
    }

    function setCodeReviewSelection(selection) {
      const slot = ensureCodeReviewSlot(state);
      const nextChangeId = normalizeId(selection?.changeId);
      const nextFileKey = normalizeId(selection?.fileKey);
      const nextTurnId = normalizeId(selection?.turnId);
      let changed = false;
      if (!nextChangeId && nextFileKey) {
        if (slot.selectedChangeId) {
          slot.selectedChangeId = '';
          changed = true;
        }
        if (slot.selectedTurnId) {
          slot.selectedTurnId = '';
          changed = true;
        }
      }
      if (nextChangeId && nextChangeId !== slot.selectedChangeId) {
        slot.selectedChangeId = nextChangeId;
        changed = true;
      }
      if (nextFileKey && nextFileKey !== slot.selectedFileKey) {
        slot.selectedFileKey = nextFileKey;
        changed = true;
      }
      if (nextTurnId && nextTurnId !== slot.selectedTurnId) {
        slot.selectedTurnId = nextTurnId;
        changed = true;
      }
      if (changed) {
        renderArtifactReviewPanel();
      }
    }

    function closeCodeReview() {
      setMode('artifact');
      syncArtifactReviewLayout();
      renderArtifactReviewPanel();
      restorePreviousFocus();
    }

    function renderRailContent(surface) {
      const slot = ensureCodeReviewSlot(state);
      const activeSessionId = normalizeId(getActiveSessionId());
      if (slot.sessionId !== activeSessionId) resetCodeReviewSlotForSession(slot, activeSessionId);
      if (slot.scopeResult) {
        codeReviewRenderer.renderInto(surface, {
          sessionModel: slot.sessionModel,
          scopeResult: slot.scopeResult,
          selectedChangeId: slot.selectedChangeId,
          selectedFileKey: slot.selectedFileKey,
          selectedTurnId: slot.selectedTurnId,
        });
        return;
      }
      const sessionModel = buildSessionModelForActiveSession();
      codeReviewRenderer.renderInto(surface, {
        sessionModel,
        scopeResult: resolveReviewScope(sessionModel, { type: 'session' }),
        selectedChangeId: '',
        selectedFileKey: '',
        selectedTurnId: '',
      });
    }

    function handleRailClick(event) {
      const target = event && event.target && typeof event.target.closest === 'function' ? event.target : null;
      if (!target) return;
      const selectButton = target.closest('[data-jenny-code-review-select]');
      if (selectButton) {
        event.preventDefault();
        setCodeReviewSelection({
          changeId: selectButton.dataset.changeId,
          fileKey: selectButton.dataset.fileKey,
          turnId: selectButton.dataset.turnId,
        });
        return;
      }
      const jumpButton = target.closest('[data-jenny-jump-to-chat]');
      if (jumpButton) {
        event.preventDefault();
        const messageId = String(jumpButton.dataset.jennyJumpToChat || '').trim();
        if (messageId) jumpToArtifactSource(messageId);
        return;
      }
      const closeButton = target.closest('[data-jenny-code-review-close]');
      if (closeButton) {
        event.preventDefault();
        closeCodeReview();
      }
    }

    function refocusByDataAttrs(prev) {
      if (!artifactReviewPanel || !prev) return;
      const root = artifactReviewPanel.querySelector('.jenny-code-review-root');
      if (!root) return;
      const options = Array.from(root.querySelectorAll('[role="option"]'));
      const changeId = String(prev.dataset?.changeId || '');
      const fileKey = String(prev.dataset?.fileKey || '');
      const select = String(prev.dataset?.jennyCodeReviewSelect || '');
      let target = null;
      if (select === 'change' && changeId) {
        target = options.find((opt) => opt.dataset?.changeId === changeId && opt.dataset?.jennyCodeReviewSelect === 'change') || null;
      }
      if (!target && select === 'file' && fileKey) {
        target = options.find((opt) => opt.dataset?.fileKey === fileKey && opt.dataset?.jennyCodeReviewSelect === 'file') || null;
      }
      if (!target) {
        target = options.find((opt) => opt.getAttribute('tabindex') === '0') || options[0] || null;
      }
      if (target && typeof target.focus === 'function') {
        try { target.focus({ preventScroll: false }); } catch (_) { /* best-effort */ }
      }
    }

    function handleRailKeydown(event) {
      if (state.ui?.artifactReview?.mode !== 'code_review') return;
      if (!artifactReviewPanel) return;
      const key = String(event?.key || '');
      if (key === 'Escape') {
        event.preventDefault();
        if (typeof event.stopPropagation === 'function') event.stopPropagation();
        closeCodeReview();
        return;
      }
      if (key !== 'ArrowDown' && key !== 'ArrowUp'
          && key !== 'Home' && key !== 'End'
          && key !== 'Enter' && key !== ' ') {
        return;
      }
      const root = artifactReviewPanel.querySelector('.jenny-code-review-root');
      if (!root) return;
      const options = Array.from(root.querySelectorAll('[role="option"]'));
      if (options.length === 0) return;
      const doc = getRailDocument();
      const activeEl = doc ? doc.activeElement : null;
      const currentIdx = activeEl ? options.indexOf(activeEl) : -1;
      if (key === 'Enter' || key === ' ') {
        if (currentIdx < 0) return;
        event.preventDefault();
        const btn = options[currentIdx];
        const selectKind = String(btn.dataset?.jennyCodeReviewSelect || '');
        const selection = {
          changeId: selectKind === 'change' ? String(btn.dataset?.changeId || '') : '',
          fileKey: String(btn.dataset?.fileKey || ''),
          turnId: String(btn.dataset?.turnId || ''),
        };
        setCodeReviewSelection(selection);
        refocusByDataAttrs(btn);
        return;
      }
      let nextIdx;
      if (key === 'ArrowDown') {
        nextIdx = currentIdx < 0 ? 0 : Math.min(currentIdx + 1, options.length - 1);
      } else if (key === 'ArrowUp') {
        nextIdx = currentIdx < 0 ? 0 : Math.max(currentIdx - 1, 0);
      } else if (key === 'Home') {
        nextIdx = 0;
      } else { // End
        nextIdx = options.length - 1;
      }
      event.preventDefault();
      const next = options[nextIdx];
      if (next && typeof next.focus === 'function') {
        try { next.focus({ preventScroll: false }); } catch (_) { /* best-effort */ }
      }
    }

    function bind() {
      if (bound || !artifactReviewPanel) return;
      bound = true;
      artifactReviewPanel.addEventListener('click', handleRailClick);
      artifactReviewPanel.addEventListener('keydown', handleRailKeydown);
    }

    function dispose() {
      if (!bound || !artifactReviewPanel) return;
      bound = false;
      artifactReviewPanel.removeEventListener('click', handleRailClick);
      artifactReviewPanel.removeEventListener('keydown', handleRailKeydown);
    }

    return {
      bind,
      dispose,
      openCodeReviewTarget,
      setCodeReviewSelection,
      closeCodeReview,
      renderRailContent,
      handleRailClick,
      handleRailKeydown,
      buildSessionModelForActiveSession,
    };
  }

  return { createCodeReviewRail };
});
