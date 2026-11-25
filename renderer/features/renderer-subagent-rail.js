/**
 * renderer/features/renderer-subagent-rail.js
 *
 * The Helper monitor (once the Subagent Monitor) as the `subagents` mode of the artifact review panel
 * (Subagent monitor v2 plan, section 3). Row 195: it is reached from a row of the Runs tab and shows with one back
 * control, "Runs", in place of its own header and Close; the back control (and Escape) return to the Runs list. Built like the `tasks` rail:
 * the shell artifact bridge creates one, wires it to the surface controller and
 * lets `renderSplitDetail` PULL its markup through `renderSubagentsSurface`.
 *
 * This module owns:
 *  - the ONE record `state.ui.subagentMonitor = { sessionId, key, page, prior }`
 *    (opening from any pane replaces it; `prior` is the four artifact-review
 *    prefs the open displaced, restored on an explicit close);
 *  - the pull surface (`renderSubagentsSurface`): the owning pane's monitor
 *    controller hands over `{ header, body, footer }` and nothing else ever
 *    writes into the panel, and only while the mode is `subagents` and the
 *    record's session is the controller's own;
 *  - the mode-change clearing (`handleLayoutSync`): any other mode or a
 *    session switch ends the record, so the inline card resets (a hidden
 *    panel keeps it, like the other rails);
 *  - the collapse-button routing and the panel-level click/keydown forwarding.
 *
 * The pane monitor controller (renderer/chat/renderer-subagent-monitor-controller.js)
 * is the "handle": { isBoundTo(record), panelMarkup(), handleClick(event),
 * handleKeydown(event), close(), released(reason) }.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSubagentRail = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  const MODE = 'subagents';
  const RUNS_MODE = 'background_tasks';
  const RUNS_BACK = '[data-subagent-runs-back]';
  const PANEL_ID = 'artifactReviewPanel';
  const OPEN_FILE_EVENT = 'ide:open-file-at-line';
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};

  function noop() {}

  function normalizePage(value) {
    return value === 'detail' ? 'detail' : 'tree';
  }


  function createSubagentRail(deps) {
    const d = deps || {};
    const state = d.state;
    if (!state || typeof state !== 'object') throw new Error('renderer-subagent-rail: state dep is required');
    const windowRef = d.windowRef || globalRef.window || globalRef;
    // Injected by the artifact bridge, which owns the panel lookup (no document fallback: the pane-DOM ledger).
    const panelEl = d.dom?.artifactReviewPanel || null;
    const openArtifactRail = typeof d.openArtifactRail === 'function' ? d.openArtifactRail : noop;
    const renderArtifactReviewPanel = typeof d.renderArtifactReviewPanel === 'function' ? d.renderArtifactReviewPanel : noop;
    const restoreArtifactReviewPrefs = typeof d.restoreArtifactReviewPrefs === 'function' ? d.restoreArtifactReviewPrefs : noop;
    const getPrefs = typeof d.getPrefs === 'function' ? d.getPrefs : () => state.ui?.artifactReview || {};
    const getPanelSessionId = typeof d.getPanelSessionId === 'function'
      ? () => String(d.getPanelSessionId() || '').trim()
      : () => String(state.currentSessionId || '').trim();
    const listenerToken = `subagent-rail-${Math.random().toString(36).slice(2)}`;
    let activeHandle = null;
    let lastSurface = null;
    let lastMarkup = '';
    let originalLabel = null;
    let bound = false;
    let disposed = false;
    // Bumped by open/close so a deferred session restore never lands on a newer selection.
    let generation = 0;

    function getRecord() {
      const record = state.ui?.subagentMonitor;
      return record && typeof record === 'object' ? record : null;
    }

    function isSubagentsMode() {
      return state.ui?.artifactReview?.mode === MODE;
    }

    function setRecord(record) {
      if (!state.ui || typeof state.ui !== 'object') state.ui = {};
      state.ui.subagentMonitor = record;
    }

    // The rail mode and open state openArtifactRail displaces, read before the
    // open, and the chat the panel showed then (a takeover changes the record's
    // session, not this one).
    function snapshotPrior() {
      const review = getPrefs() || {};
      return {
        mode: review.mode && review.mode !== MODE ? String(review.mode) : 'artifact',
        enabled: review.enabled === true,
        sessionId: getPanelSessionId(),
      };
    }

    function applyLabel() {
      if (!panelEl?.setAttribute) return;
      if (originalLabel === null) originalLabel = panelEl.getAttribute('aria-label') || '';
      panelEl.setAttribute('aria-label', jt('chat.subagentMonitor.panelLabel', 'Helper monitor'));
    }

    function restoreLabel() {
      if (originalLabel === null || !panelEl?.setAttribute) return;
      if (originalLabel) panelEl.setAttribute('aria-label', originalLabel);
      else panelEl.removeAttribute('aria-label');
      originalLabel = null;
    }

    function emptySurface() {
      const host = lastSurface?.previewContent;
      if (host?.querySelector?.(':scope > .subagent-monitor-shell')) host.innerHTML = '';
    }

    // Ends the record without touching the prefs; returns the controller that held it.
    function clearRecord() {
      const handle = activeHandle;
      activeHandle = null;
      setRecord(null);
      lastMarkup = '';
      emptySurface();
      restoreLabel();
      return handle;
    }

    function drop(reason) {
      const handle = clearRecord();
      handle?.released?.(reason);
    }

    // Puts back what the open displaced. A file preview belongs to its chat:
    // if the panel now shows another session, fall back to the artifact list.
    function restore(record) {
      const prior = record.prior || {};
      let mode = !prior.mode || prior.mode === MODE ? 'artifact' : prior.mode;
      const priorSession = typeof prior.sessionId === 'string' ? prior.sessionId : record.sessionId;
      if (mode === 'file_preview' && getPanelSessionId() !== priorSession) mode = 'artifact';
      restoreArtifactReviewPrefs({ mode, enabled: prior.enabled === true });
    }

    function open(args) {
      const handle = args?.handle;
      if (disposed || !handle) return false;
      generation += 1;
      const existing = getRecord();
      const live = Boolean(existing) && isSubagentsMode();
      // A second open while the monitor shows keeps the ORIGINAL prior: the
      // snapshot of the monitor's own mode would restore into itself.
      const prior = live && existing.prior ? existing.prior : snapshotPrior();
      if (live && activeHandle && activeHandle !== handle) {
        const previous = activeHandle;
        activeHandle = null;
        previous.released?.('replaced');
      }
      activeHandle = handle;
      lastMarkup = '';
      setRecord({
        sessionId: String(args.sessionId || '').trim(),
        key: String(args.key || '').trim(),
        page: normalizePage(args.page),
        prior,
      });
      const mode = openArtifactRail(MODE);
      if (mode !== MODE) {
        clearRecord();
        return false;
      }
      renderArtifactReviewPanel();
      return getRecord() !== null && activeHandle === handle;
    }

    function setPage(page) {
      const record = getRecord();
      if (record) record.page = normalizePage(page);
    }

    // Explicit close (the X, Escape, the collapse button, a disposed pane).
    function close(args) {
      const record = getRecord();
      if (!record) return false;
      if (args?.handle && activeHandle && args.handle !== activeHandle) return false;
      generation += 1;
      clearRecord();
      restore(record);
      return true;
    }

    function repaint(options = {}) {
      if (options.force) lastMarkup = '';
      if (!lastSurface || !getRecord() || !isSubagentsMode()) return false;
      return renderSubagentsSurface(lastSurface) === true;
    }

    function prepareSurface(surface) {
      surface.detailEmpty?.classList?.add('hidden');
      surface.detailPanel?.classList?.remove('hidden');
      surface.metaPane?.classList?.add('hidden');
      for (const button of [surface.saveButton, surface.revertButton, surface.revealButton,
        surface.openExternalButton, surface.deleteButton, surface.jumpButton]) button?.classList?.add('hidden');
      surface.editorShell?.classList?.add('hidden');
      surface.dirtyBadge?.classList?.add('hidden');
      if (surface.detailNote) surface.detailNote.textContent = '';
      surface.previewContent?.classList?.remove?.('hidden');
    }

    function paint(surface, parts, record) {
      prepareSurface(surface);
      const host = surface.previewContent;
      if (!host) return;
      const page = normalizePage(record.page);
      const html = `<div class="subagent-monitor-shell" data-subagent-page="${page}">${parts.runsHeader || parts.header || ''}${parts.body || ''}${parts.footer || ''}</div>`;
      const shell = host.querySelector(':scope > .subagent-monitor-shell');
      if (html === lastMarkup && shell) return;
      const enteredDetail = page === 'detail' && shell?.getAttribute('data-subagent-page') !== 'detail';
      if (activeHandle?.preserveLiveState) activeHandle.preserveLiveState(host, () => {
        if (activeHandle.updateMarkup) activeHandle.updateMarkup(host, html);
        else host.innerHTML = html;
      });
      else host.innerHTML = html;
      lastMarkup = html;
      if (enteredDetail) host.querySelector(RUNS_BACK)?.focus?.({ preventScroll: true }); // the row that was clicked is gone: land on Back

    }

    // The pull: called by renderSplitDetail for mode `subagents`. False (no
    // record, another session, no controller) resets the mode to `artifact`.
    function renderSubagentsSurface(surface) {
      const record = getRecord();
      if (disposed || !surface || !record || !isSubagentsMode()) return false;
      const handle = activeHandle;
      if (!handle || handle.isBoundTo?.(record) !== true) return false;
      const parts = handle.panelMarkup?.();
      if (!parts) return false;
      lastSurface = surface;
      paint(surface, parts, record);
      return true;
    }

    // Called by the bridge on every artifact-panel layout sync (`syncOwnerLine`).
    function handleLayoutSync(mode, visible) {
      const record = getRecord();
      if (!record) {
        restoreLabel();
        return;
      }
      if (mode !== MODE) {
        drop('mode');
        return;
      }
      if (getPanelSessionId() !== record.sessionId) {
        // A session switch closes like an explicit close, deferred: the
        // restore re-enters the layout sync this call is part of.
        // It stands down if anything opened or closed since, or another rail
        // mode took the panel (the safety net's own reset to artifact is fine).
        drop('session');
        const dropGeneration = ++generation;
        Promise.resolve().then(() => {
          if (disposed || generation !== dropGeneration || getRecord()) return;
          const current = state.ui?.artifactReview?.mode;
          if (current && current !== MODE && current !== 'artifact') return;
          restore(record);
        });
        return;
      }
      // A hidden panel (another view is up, or the panel is closed) keeps
      // the record, like the tasks and file-preview rails keep theirs: the
      // pull repaints when the panel shows again, and an explicit close
      // still restores the prior prefs.
      if (visible === true) applyLabel();
    }

    function openPath(link) {
      const path = String(link.getAttribute('data-chat-path-open') || '').trim();
      if (!path || typeof windowRef.CustomEvent !== 'function') return;
      const line = Number.parseInt(link.getAttribute('data-chat-path-line') || '', 10);
      windowRef.dispatchEvent?.(new windowRef.CustomEvent(OPEN_FILE_EVENT, {
        detail: { path, line: Number.isSafeInteger(line) && line > 0 ? line : null, column: null },
        bubbles: true,
        cancelable: true,
      }));
    }

    function isActive() {
      return !disposed && Boolean(getRecord()) && isSubagentsMode() && Boolean(activeHandle);
    }

    // The artifact collapse button is the sticky-dismiss collapse; in this mode
    // it closes the monitor (and restores the panel) instead.
    function handleCollapseCapture(event) {
      if (!isActive() || !event.target?.closest?.('#artifactReviewCollapseButton')) return;
      event.preventDefault();
      event.stopPropagation();
      activeHandle.close();
    }

    // Back to the Runs list, focused on the helper's row. The list owner closes this record through the layout sync.
    function backToRuns(helperId) {
      const record = getRecord();
      if (!record) return;
      const runs = windowRef.rendererBackgroundTasksPanel;
      if (typeof runs?.open === 'function') { void runs.open({ sessionId: record.sessionId, focusTaskId: helperId }); return; }
      if (openArtifactRail(RUNS_MODE) === RUNS_MODE) renderArtifactReviewPanel();
    }

    function handlePanelClick(event) {
      if (!isActive() || !panelEl?.querySelector?.('.subagent-monitor-shell')?.contains?.(event.target)) return;
      const back = event.target.closest?.(RUNS_BACK);
      if (back) {
        event.preventDefault();
        backToRuns(back.getAttribute('data-subagent-runs-back'));
        return;
      }
      const link = event.target.closest?.('[data-chat-path-open]');
      if (link) {
        event.preventDefault();
        openPath(link);
        return;
      }
      activeHandle.handleClick?.(event);
    }

    // Capture phase: the monitor answers (and preventDefaults) before the
    // artifact panel's own Escape handler could collapse or un-maximize.
    function handlePanelKeydown(event) {
      if (!isActive()) return;
      const link = event.target?.closest?.('[data-chat-path-open]');
      if (link && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault();
        openPath(link);
        return;
      }
      activeHandle.handleKeydown?.(event);
    }

    function bind() {
      if (disposed || !panelEl?.addEventListener) return;
      if (panelEl.dataset && !panelEl.dataset.subagentRailBound) {
        panelEl.dataset.subagentRailBound = listenerToken;
        panelEl.addEventListener('click', handleCollapseCapture, true);
        panelEl.addEventListener('click', handlePanelClick);
        panelEl.addEventListener('keydown', handlePanelKeydown, true);
        bound = true;
      }
      windowRef.rendererSubagentRailHost = api;
    }

    function dispose() {
      if (disposed) return;
      const handle = clearRecord();
      handle?.released?.('dispose');
      disposed = true;
      if (bound) {
        panelEl.removeEventListener('click', handleCollapseCapture, true);
        panelEl.removeEventListener('click', handlePanelClick);
        panelEl.removeEventListener('keydown', handlePanelKeydown, true);
        if (panelEl.dataset.subagentRailBound === listenerToken) delete panelEl.dataset.subagentRailBound;
        bound = false;
      }
      if (windowRef.rendererSubagentRailHost === api) delete windowRef.rendererSubagentRailHost;
    }

    const api = {
      PANEL_ID,
      bind,
      close,
      dispose,
      getRecord,
      handleLayoutSync,
      open,
      renderSubagentsSurface,
      repaint,
      setPage,
    };
    return api;
  }

  // Row 195: a helper's row in Runs opens that helper's page. The pane's own monitor owns the open, so this presses
  // the helper's card in the chat that runs it (its controller listens for exactly that), then picks the helper.
  function openHelperRun({ doc, panes, panel, sessionId, key, childKey }) {
    const paneId = String(Math.max(0, (Array.isArray(panes) ? panes : []).findIndex((entry) => entry?.sessionId === sessionId)));
    const cards = [...(doc?.querySelectorAll?.('[data-subagent-open]') || [])].filter((card) => card.getAttribute('data-subagent-open') === String(key));
    const card = cards.find((entry) => String(entry.closest?.('.chat-pane[data-pane-id]')?.dataset?.paneId || '0') === paneId) || cards[0];
    if (!card) return false;
    card.click();
    const row = childKey ? [...(panel()?.querySelectorAll?.('[data-subagent-select]') || [])].find((entry) => entry.getAttribute('data-subagent-select') === String(childKey)) : null;
    row?.click?.();
    return true;
  }

  return { MODE, PANEL_ID, createSubagentRail, openHelperRun };
});
