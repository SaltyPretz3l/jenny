/* renderer/chat/renderer-session-rail.js - one session rail per chat pane (UMD).

   Row 59 checkpoint 2 (chat workspace parity spec, "Session rail"). The controller
   owns, for ONE pane: the data (window.jennyShell.chatWorkspace, contract C2), the responsive
   docking decision, the Session toggle in the pane's utility cluster, the sheet below the dock
   threshold, the five disclosure sections and their persistence, and focus. Markup lives in
   renderer-session-rail-render.js, words and rules in renderer-session-rail-model.js, layout in
   styles/chat-session-rail.css (which keys off the attribute this controller writes).

   The pane element carries data-session-rail="docked|undocked|hidden":
     docked    >= 920px of pane (>= 640px while a side panel is open or moving and the rail was
               already docked): the rail shows at the pane's end edge and the stage and composer
               give it room. The toggle (aria-pressed) hides and shows it and writes rail_visible.
     hidden    docked-capable but hidden by the person (rail_visible false), or not available here
               (no bridge, no session, a pane hosted in the Workspace dock).
     undocked  below the threshold: the toggle (aria-expanded) opens a non-modal sheet anchored to
               the pane. The sheet never writes rail_visible; responsive collapse never does.

   Data: getSummary on mount and on a session/input change, a refetch on onChanged for this pane's
   session (debounced, one request in flight), and an optional visible-rail freshness timer. A summary for another session is
   never painted: a session change clears to "checking" first. Every listener, observer, timer
   and the bridge subscription is released by dispose(). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-session-rail-model'), require('./renderer-session-rail-render'), require('./renderer-session-rail-performance'), require('./renderer-context-preview'));
    return;
  }
  root.rendererSessionRail = factory(root.rendererSessionRailModel, root.rendererSessionRailRender, root.rendererSessionRailPerformance, root.rendererContextPreview);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (model, render, performanceRail, contextPreview) {
  'use strict';

  const REFETCH_DELAY_MS = 120;
  const REFLOW_EVENT = 'session-rail-reflow';
  const SHEET_TOP_PROPERTY = '--session-rail-sheet-top';
  const SCHEMA_VERSION = 1;
  let railSequence = 0;

  function isObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function normalizeView(value) {
    const view = isObject(value) ? value : {};
    return {
      rail_visible: typeof view.rail_visible === 'boolean' ? view.rail_visible : null,
      disclosures: isObject(view.disclosures) ? { ...view.disclosures } : {},
      children_expanded: typeof view.children_expanded === 'boolean' ? view.children_expanded : null,
    };
  }

  const configured = { openSession: null }; // Row 59 cp5a: a linked Background tasks row opens its chat (app-level port)
  const configure = (options) => { if (typeof options?.openSession === 'function') configured.openSession = options.openSession; };

  function mountSessionRail(options) {
    const o = options || {};
    const pane = o.pane;
    const cluster = o.cluster;
    const getSessionId = o.getSessionId;
    if (!pane || !cluster || typeof getSessionId !== 'function') return null;
    if (o.signal && o.signal.aborted) return null;
    const doc = pane.ownerDocument;
    const win = o.windowRef || (doc && doc.defaultView);
    if (!doc || !win) return null;
    const jt = typeof o.jt === 'function' ? o.jt : model.defaultJt();
    const stage = o.stage || Array.from(pane.children).find((child) => child.classList.contains('chat-thread-stage')) || null;
    const chatView = pane.closest ? pane.closest('.chat-view') : null;
    const bridge = o.bridge || (win.jennyShell && win.jennyShell.chatWorkspace) || null;
    const bridgeOk = Boolean(bridge && typeof bridge.getSummary === 'function' && typeof bridge.setView === 'function');
    const idPrefix = `session-rail-${(pane.dataset && pane.dataset.paneId) || 'p'}-${railSequence += 1}`;

    // ── State ────────────────────────────────────────────────────────────
    let disposed = false;
    let sessionId = String(getSessionId() || '').trim();
    let summary = null;
    let status = 'checking';
    let view = normalizeView(null);
    let revision = 0;
    let overrides = {};
    let docked = false;
    let sheetOpen = false;
    let fetching = false;
    let generation = 0;
    let refetchQueued = false;
    let needsFetch = false;
    let fetchTimer = 0;
    let writeChain = Promise.resolve();
    let lastMode = '';
    let tray = null;
    let painted = false;
    const cache = new Map();
    const disposers = [];

    function listen(target, type, handler, listenerOptions) {
      if (!target || typeof target.addEventListener !== 'function') return;
      target.addEventListener(type, handler, listenerOptions);
      disposers.push(() => target.removeEventListener(type, handler, listenerOptions));
    }

    // ── Elements ─────────────────────────────────────────────────────────
    cluster.querySelectorAll('[data-session-rail-toggle]').forEach((node) => node.remove());
    pane.querySelectorAll(':scope > [data-session-rail-root], :scope > [data-session-rail-sheet]').forEach((node) => node.remove());
    const title = jt('chat.sessionRail.title', 'Session');
    const rail = doc.createElement('aside');
    rail.className = 'session-rail';
    rail.setAttribute('data-session-rail-root', 'true');
    rail.setAttribute('aria-label', title);
    rail.hidden = true;
    const sheet = doc.createElement('div');
    sheet.className = 'session-rail-sheet';
    sheet.setAttribute('data-session-rail-sheet', 'true');
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'false');
    sheet.setAttribute('aria-label', title);
    sheet.hidden = true;
    tray = doc.createElement('div');
    tray.className = 'session-rail-tray';
    pane.append(rail, sheet);
    cluster.insertAdjacentHTML('afterbegin', win.inventoryActionButton
      ? win.inventoryActionButton({
        plain: true, className: 'chat-timeline-utility-button session-rail-toggle', ariaPressed: false,
        dataset: { 'session-rail-toggle': 'true' }, trustedHtml: render.toggleContent(title),
      })
      : '');
    const toggle = cluster.querySelector('[data-session-rail-toggle]');
    if (!toggle) {
      rail.remove();
      sheet.remove();
      return null;
    }
    // Row 59 cp6: the Performance section and the toggle readout (own bridge; absent = nothing renders).
    const perf = performanceRail ? performanceRail.createRailPerformance({ win, doc, jt, getSessionId, idPrefix, bridge: o.performance, onChange: () => syncToggle(currentMode()) }) : null;

    // ── Mode ─────────────────────────────────────────────────────────────
    function hostedElsewhere() {
      return pane.classList.contains('ide-chat-dock-body') || pane.hasAttribute('data-pane-hosted')
        || (stage ? !pane.contains(stage) : true);
    }

    function available() {
      return !disposed && bridgeOk && Boolean(sessionId) && !hostedElsewhere();
    }

    function currentMode() {
      if (!available()) return 'hidden';
      return model.resolveRailMode({ docked, railVisible: view.rail_visible });
    }

    function visible() {
      const mode = currentMode();
      return mode === 'docked' || (mode === 'undocked' && sheetOpen);
    }

    function reflowEvent(phase) {
      const EventCtor = win.CustomEvent;
      if (typeof EventCtor === 'function') pane.dispatchEvent(new EventCtor(REFLOW_EVENT, { detail: { phase } }));
    }

    function toggleLabel(mode) {
      if (mode === 'docked') return jt('chat.sessionRail.toggleHide', 'Hide session summary');
      if (mode === 'hidden') return jt('chat.sessionRail.toggleShow', 'Show session summary');
      return jt('chat.sessionRail.toggleOpen', 'Session summary');
    }

    function syncToggle(mode) {
      toggle.hidden = !available();
      toggle.title = toggleLabel(mode);
      // Docked, the toggle is the panel glyph alone (the word stays for assistive tech): the cluster's
      // reach comes out of the reading gutters, so it keeps to one glyph; the sheet's toggle names itself.
      toggle.classList.add('session-rail-toggle--icon');
      if (mode === 'undocked') {
        toggle.removeAttribute('aria-pressed');
        toggle.setAttribute('aria-haspopup', 'dialog');
        toggle.setAttribute('aria-expanded', sheetOpen ? 'true' : 'false');
      } else {
        toggle.removeAttribute('aria-haspopup');
        toggle.removeAttribute('aria-expanded');
        toggle.setAttribute('aria-pressed', mode === 'docked' ? 'true' : 'false');
      }
      if (perf) perf.syncReadout(toggle, mode, toggleLabel(mode));
    }

    function attachTray(mode) {
      const target = mode === 'docked' ? rail : (mode === 'undocked' && sheetOpen ? sheet : null);
      if (!target) {
        if (tray.parentNode) {
          const hadFocus = tray.contains(doc.activeElement);
          tray.remove();
          if (hadFocus && !toggle.hidden) toggle.focus();
        }
        return;
      }
      if (tray.parentNode !== target) {
        const hadFocus = tray.contains(doc.activeElement);
        target.appendChild(tray);
        if (hadFocus) toggle.focus();
      }
    }

    /* Applies the mode to the pane and its parts. Layout-changing modes (docked <-> not) are
       bracketed by the reflow notice so the pane's scroll coordinator keeps the reader's place. */
    function applyMode() {
      const mode = currentMode();
      const layoutChange = (mode === 'docked') !== (lastMode === 'docked');
      if (mode !== 'undocked' && sheetOpen) closeSheet({ restoreFocus: false, silent: true });
      const run = () => {
        pane.dataset.sessionRail = mode;
        rail.hidden = mode !== 'docked';
        sheet.hidden = !(mode === 'undocked' && sheetOpen);
        attachTray(mode);
        syncToggle(mode);
      };
      if (layoutChange && lastMode) {
        reflowEvent('before');
        run();
        if (stage) void stage.offsetWidth;
        reflowEvent('after');
      } else {
        run();
      }
      lastMode = mode;
      if (visible()) {
        paint();
        if (needsFetch) { needsFetch = false; void fetchSummary(); }
      }
    }

    // ── Docking ──────────────────────────────────────────────────────────
    function panelActive() {
      if (!chatView) return false;
      if (chatView.classList.contains('artifact-review-open') || chatView.hasAttribute('data-panel-motion')) return true;
      const context = chatView.querySelector('.chat-context-panel');
      return Boolean(context && !context.classList.contains('collapsed'));
    }

    /* The pane's inline size. The stage gives up the rail's room (a margin) while docked, so the
       pane is the stage plus that margin: measuring it this way cannot feed back on its own answer. */
    function paneWidth() {
      if (typeof o.getPaneWidth === 'function') return Number(o.getPaneWidth());
      if (!stage) return 0;
      const width = stage.getBoundingClientRect().width;
      if (!(width > 0)) return 0;
      let margin = 0;
      if (docked && typeof win.getComputedStyle === 'function') margin = Number.parseFloat(win.getComputedStyle(stage).marginInlineEnd) || 0;
      return width + margin;
    }

    function evaluateDock() {
      if (disposed) return;
      // Never re-evaluate mid-motion: the motion's end (the attribute leaving) re-runs this.
      if (chatView && chatView.hasAttribute('data-panel-motion')) return;
      const width = paneWidth();
      if (perf) perf.setPaneWidth(width);
      const next = model.resolveDocked({ paneWidth: width, panelActive: panelActive(), wasDocked: docked });
      if (next !== docked) docked = next;
      if (currentMode() !== lastMode) applyMode();
    }

    // ── Data ─────────────────────────────────────────────────────────────
    async function fetchSummary() {
      const sid = sessionId;
      if (disposed || !sid || !bridgeOk) return;
      if (fetching) { refetchQueued = true; return; }
      fetching = true;
      const requestGeneration = generation;
      const response = await Promise.resolve()
        .then(() => bridge.getSummary({ schema_version: SCHEMA_VERSION, session_id: sid }))
        .catch(() => null);
      fetching = false;
      if (disposed) return;
      if (sid === sessionId && requestGeneration === generation) {
        if (response && response.ok === true && isObject(response.summary) && response.summary.session_id === sid) {
          const incoming = response.summary;
          if (incoming.context && incoming.context.state !== 'available'
            && summary?.context?.data?.scope === 'next_send' && summary.context.data.breakdown) {
            incoming.context = { ...summary.context, state: 'stale' };
          }
          summary = incoming;
          status = 'ready';
          const rev = Number.isSafeInteger(response.coordination_revision) ? response.coordination_revision : response.summary.revision;
          // A summary read before a later setView landed carries an older view: keep the newer one.
          if (Number.isSafeInteger(rev) && rev >= revision) {
            view = normalizeView(response.workspace_view);
            revision = rev;
          }
        } else if (summary) {
          summary = contextPreview.markStale(summary, model.SECTION_KEYS);
        } else {
          status = 'unavailable';
        }
        applyMode();
        paint();
      }
      if (refetchQueued) {
        refetchQueued = false;
        void fetchSummary();
      }
    }

    function scheduleFetch() {
      if (disposed) return;
      generation += 1;
      if (fetchTimer) win.clearTimeout(fetchTimer);
      fetchTimer = win.setTimeout(() => {
        fetchTimer = 0;
        if (disposed) return;
        if (visible()) void fetchSummary();
        else needsFetch = true;
      }, REFETCH_DELAY_MS);
    }

    function syncSession() {
      if (disposed) return false;
      const next = String(getSessionId() || '').trim();
      if (next === sessionId) return false;
      sessionId = next;
      if (perf) perf.setSession(next);
      summary = null;
      status = 'checking';
      view = normalizeView(null);
      revision = 0;
      overrides = {};
      refetchQueued = false;
      needsFetch = false;
      if (fetchTimer) { win.clearTimeout(fetchTimer); fetchTimer = 0; }
      closeSheet({ restoreFocus: false, silent: true });
      applyMode();
      paint();
      void fetchSummary();
      return true;
    }

    // ── Painting ─────────────────────────────────────────────────────────
    function summaryWithDraft() {
      if (!summary?.context?.data?.breakdown) return summary;
      const input = pane.querySelector('[data-chat-node="chatInput"], #chatInput');
      const data = contextPreview.withDraft(summary.context.data, input?.value, o.getAttachments?.());
      return { ...summary, context: { ...summary.context, data } };
    }

    function paint() {
      if (disposed || !visible()) return;
      const vm = model.buildRailViewModel({ summary: summaryWithDraft(), status, sessionId, workspaceView: view, overrides, jt });
      if (!painted) {
        tray.innerHTML = vm.sections.map((section) => render.sectionHtml(section, idPrefix)).join('');
        cache.clear();
        for (const section of vm.sections) {
          cache.set(section.key, { value: render.valueHtml(section), body: render.bodyHtml(section), state: section.state, open: section.open });
        }
        painted = true;
        if (perf) perf.attach(tray);
        return;
      }
      const active = doc.activeElement;
      const focusKey = active && tray.contains(active) ? (active.closest('[data-row-key]') || {}).dataset : null;
      const focusSection = active && tray.contains(active) ? active.closest('[data-section]') : null;
      // Nothing animates on load or on a session switch: data arriving after "checking" settles at once.
      const settling = vm.sections.some((section) => (cache.get(section.key) || {}).state === 'checking' && section.state !== 'checking');
      if (settling) tray.setAttribute('data-no-motion', '');
      for (const section of vm.sections) {
        const node = tray.querySelector(`[data-section="${section.key}"]`);
        if (!node) continue;
        const prev = cache.get(section.key) || {};
        const value = render.valueHtml(section);
        const body = render.bodyHtml(section);
        if (prev.state !== section.state) node.setAttribute('data-state', section.state);
        if (prev.open !== section.open) node.querySelector('[data-rail-section]').setAttribute('aria-expanded', section.open ? 'true' : 'false');
        if (prev.value !== value) node.querySelector('[data-rail-value]').innerHTML = value;
        if (prev.body !== body) node.querySelector('[data-rail-body]').innerHTML = body;
        cache.set(section.key, { value, body, state: section.state, open: section.open });
      }
      if (settling) {
        void tray.offsetHeight;
        tray.removeAttribute('data-no-motion');
      }
      if (active && focusSection && !tray.contains(doc.activeElement)) {
        const section = focusSection.getAttribute('data-section');
        const rowKey = focusKey && focusKey.rowKey;
        const sectionNode = tray.querySelector(`[data-section="${section}"]`);
        const target = (rowKey && Array.from(sectionNode.querySelectorAll('[data-row-key]')).find((node) => node.getAttribute('data-row-key') === rowKey))
          || sectionNode.querySelector('[data-rail-section]');
        if (target && typeof target.focus === 'function') target.focus();
      }
    }

    // ── Writes (optimistic, serialized, reverted after one refetch) ──────
    function writeView(patch, rollback) {
      const sid = sessionId;
      writeChain = writeChain.then(async () => {
        if (disposed || sid !== sessionId) return;
        const send = () => Promise.resolve()
          .then(() => bridge.setView({ schema_version: SCHEMA_VERSION, session_id: sid, expected_revision: revision, patch }))
          .catch(() => null);
        let response = await send();
        // Proposal writes bump the shared coordination revision too; the disclosure patch is
        // idempotent, so one re-send at the current revision keeps the user's toggle.
        if (!disposed && sid === sessionId && response && response.reason === 'revision_conflict'
          && Number.isSafeInteger(response.current_revision)) {
          revision = response.current_revision;
          response = await send();
        }
        if (disposed || sid !== sessionId) return;
        if (response && response.ok === true) {
          view = normalizeView(response.workspace_view);
          if (Number.isSafeInteger(response.coordination_revision)) revision = response.coordination_revision;
          rollback.confirm();
        } else {
          rollback.revert();
          await fetchSummary();
        }
        applyMode();
        paint();
      }).catch(() => {});
      return writeChain;
    }

    function toggleSection(key) {
      if (!model.SECTION_KEYS.includes(key)) return;
      const vm = model.buildRailViewModel({ summary: summaryWithDraft(), status, sessionId, workspaceView: view, overrides, jt });
      const section = vm.sections.find((entry) => entry.key === key);
      const next = !(section && section.open);
      overrides = { ...overrides, [key]: next };
      paint();
      void writeView({ disclosures: { [key]: next } }, {
        confirm: () => { delete overrides[key]; },
        revert: () => { delete overrides[key]; },
      });
    }

    function toggleRailVisible() {
      const previous = view;
      const shown = view.rail_visible !== false;
      const next = !shown;
      view = { ...view, rail_visible: next };
      applyMode();
      void writeView({ rail_visible: next }, {
        confirm: () => {},
        revert: () => { if (view.rail_visible === next) view = previous; },
      });
    }

    // ── Sheet ────────────────────────────────────────────────────────────
    function onOutsidePointer(event) {
      if (!sheetOpen) return;
      const target = event.target;
      if (sheet.contains(target) || toggle.contains(target)) return;
      closeSheet({ restoreFocus: sheet.contains(doc.activeElement) });
    }

    function openSheet() {
      if (sheetOpen || currentMode() !== 'undocked') return;
      const stageTop = stage ? stage.getBoundingClientRect().top : 0;
      const gap = 4;
      const top = Math.max(0, Math.round(toggle.getBoundingClientRect().bottom - stageTop + gap));
      sheet.style.setProperty(SHEET_TOP_PROPERTY, `${top}px`);
      sheetOpen = true;
      doc.addEventListener('pointerdown', onOutsidePointer, true);
      applyMode();
      const first = sheet.querySelector('[data-rail-section]');
      if (first) first.focus();
    }

    function closeSheet({ restoreFocus = false, silent = false } = {}) {
      if (!sheetOpen) return;
      sheetOpen = false;
      doc.removeEventListener('pointerdown', onOutsidePointer, true);
      sheet.style.removeProperty(SHEET_TOP_PROPERTY);
      if (silent) return;
      applyMode();
      if (restoreFocus && !toggle.hidden) toggle.focus();
    }

    // ── Events ───────────────────────────────────────────────────────────
    listen(toggle, 'click', (event) => {
      event.preventDefault();
      const mode = currentMode();
      if (mode === 'undocked') {
        if (sheetOpen) closeSheet({ restoreFocus: true });
        else openSheet();
      } else {
        toggleRailVisible();
      }
    });

    listen(toggle, 'keydown', (event) => {
      if (event.key === 'Escape' && sheetOpen) {
        event.preventDefault();
        event.stopPropagation();
        closeSheet({ restoreFocus: true });
      }
    });

    listen(sheet, 'keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      closeSheet({ restoreFocus: true });
    });

    listen(tray, 'click', (event) => {
      const target = event.target && event.target.closest ? event.target : null;
      if (!target) return;
      const header = target.closest('[data-rail-section]');
      if (header && tray.contains(header)) {
        event.preventDefault();
        toggleSection(header.getAttribute('data-rail-section'));
        return;
      }
      const sessionRow = configured.openSession && target.closest('[data-rail-session]');
      if (sessionRow && tray.contains(sessionRow)) {
        event.preventDefault();
        if (sheetOpen) closeSheet({ restoreFocus: false });
        return void configured.openSession(sessionRow.getAttribute('data-rail-session'));
      }
      const row = target.closest('[data-rail-surface]');
      if (!row || !tray.contains(row)) return;
      event.preventDefault();
      const detail = o.detail || win.rendererChatWorkspaceDetail;
      if (!detail || typeof detail.open !== 'function') return;
      const request = { surface: row.getAttribute('data-rail-surface'), ownerSessionId: sessionId, opener: row };
      const resource = row.getAttribute('data-rail-resource');
      if (resource) request.resourceRef = resource;
      if (sheetOpen) closeSheet({ restoreFocus: false });
      detail.open(request);
    });

    listen(win, 'jenny:focused-chat-changed', () => { syncSession(); });
    disposers.push(contextPreview.bindRefresh({ pane, win, listen, syncSession, scheduleFetch, paint, visible, options: o }));
    if (o.chatTimeline) listen(o.chatTimeline, 'transcript-view-rendered', () => { syncSession(); });

    if (typeof win.ResizeObserver === 'function' && stage) {
      const resizeObserver = new win.ResizeObserver(() => { syncSession(); evaluateDock(); });
      resizeObserver.observe(stage);
      disposers.push(() => resizeObserver.disconnect());
    }
    if (typeof win.MutationObserver === 'function') {
      const watch = (node, attributeFilter) => {
        if (!node) return;
        const observer = new win.MutationObserver(() => { evaluateDock(); });
        observer.observe(node, { attributes: true, attributeFilter });
        disposers.push(() => observer.disconnect());
      };
      watch(chatView, ['class', 'data-panel-motion']);
      watch(chatView && chatView.querySelector('.chat-context-panel'), ['class']);
      watch(pane, ['class', 'data-pane-hosted']);
    }

    if (bridgeOk && typeof bridge.onChanged === 'function') {
      const unsubscribe = bridge.onChanged((event) => {
        if (disposed || !isObject(event) || event.session_id !== sessionId) return;
        scheduleFetch();
      });
      if (typeof unsubscribe === 'function') disposers.push(unsubscribe);
    }

    // ── Teardown ─────────────────────────────────────────────────────────
    function dispose() {
      if (disposed) return;
      closeSheet({ restoreFocus: false, silent: true });
      disposed = true;
      if (perf) perf.dispose();
      if (fetchTimer) win.clearTimeout(fetchTimer);
      fetchTimer = 0;
      while (disposers.length) {
        const release = disposers.pop();
        try { release(); } catch (_error) { /* best-effort teardown, as the registry does */ }
      }
      doc.removeEventListener('pointerdown', onOutsidePointer, true);
      if (stage && lastMode === 'docked') reflowEvent('before');
      delete pane.dataset.sessionRail;
      rail.remove();
      sheet.remove();
      toggle.remove();
      if (stage && lastMode === 'docked') {
        void stage.offsetWidth;
        reflowEvent('after');
      }
    }
    if (o.signal && typeof o.signal.addEventListener === 'function') {
      o.signal.addEventListener('abort', dispose, { once: true });
      disposers.push(() => o.signal.removeEventListener('abort', dispose));
    }

    evaluateDock();
    applyMode();
    if (sessionId && bridgeOk) void fetchSummary();

    return {
      dispose,
      syncSession,
      evaluateDock,
      refresh: () => { if (sessionId) void fetchSummary(); },
      getMode: currentMode,
      isSheetOpen: () => sheetOpen,
      elements: { rail, sheet, tray, toggle },
    };
  }

  return { mountSessionRail, configure, REFLOW_EVENT };
});
