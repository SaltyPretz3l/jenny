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

   Motion (renderer-session-rail-motion.js): the toggle glides the rail's column through the shared side-panel
   motion; a side panel's open that leaves the pane under the dock width takes the rail out inside its own
   motion (side-panel-measuring); every other change (first paint, session switch, a width-driven dock
   change, disposal) is instant. A separator on the docked rail's start edge resizes it, 240 to 420 px.

   Data: getSummary on mount and on a session/input change, a refetch on onChanged for this pane's
   session (debounced, one request in flight), and an optional visible-rail freshness timer. A summary for another session is
   never painted: a session change clears to "checking" first. Every listener, observer, timer
   and the bridge subscription is released by dispose(). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-session-rail-model'), require('./renderer-session-rail-render'), require('./renderer-session-rail-performance'), require('./renderer-context-preview'), require('./renderer-session-rail-jobs'), require('./renderer-session-rail-motion'));
    return;
  }
  root.rendererSessionRail = factory(root.rendererSessionRailModel, root.rendererSessionRailRender, root.rendererSessionRailPerformance, root.rendererContextPreview, root.rendererSessionRailJobs, root.rendererSessionRailMotion);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (model, render, performanceRail, contextPreview, railJobs, railMotion) {
  'use strict';

  const REFETCH_DELAY_MS = 120;
  const REFLOW_EVENT = railMotion.REFLOW_EVENT;
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
  const mountedByPane = new WeakMap(); // pane -> its live rail's api; a remount retires it
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
    mountedByPane.get(pane)?.dispose(); // retire the previous controller (timer, listeners, nodes)
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
    // Row 115 slice 3: the toggle's glide and the drag-to-resize separator (renderer-session-rail-motion.js).
    const layout = railMotion.createRailLayout({ pane, rail, stage, chatView, win, getPaneWidth: o.getPaneWidth, motionOptions: o.motion });
    const resizer = railMotion.createRailResizer({ pane, rail, stage, chatTimeline: o.chatTimeline, doc, win, jt, notify: layout.notify });
    const jobs = railJobs?.createRailJobs({ tray, toggle, win, jt, getSessionId: () => sessionId, trayShown: () => visible(), getBackgroundJobs: () => win.jennyShell?.backgroundJobs, getJobWaiters: o.getJobWaiters }); if (jobs) disposers.push(jobs.dispose); // background-job rows + toggle readout
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

    /* Applies the mode to the pane and its parts. `how` names who asked: 'glide' (the person's toggle) moves
       the rail's column through the shared side-panel motion, 'measuring' (a side panel's open is being
       measured) lets the rail leave inside that motion, anything else is instant. Instant layout changes
       (docked <-> not) are bracketed by the reflow notice so the pane's scroll coordinator keeps the reader's
       place; the glide's anchors replace that bracket, never add to it. */
    function applyMode(how) {
      const mode = currentMode();
      if (!how && layout.target() === mode) return syncToggle(mode); // the glide already carries this mode
      const layoutChange = (mode === 'docked') !== (lastMode === 'docked');
      if (mode !== 'undocked' && sheetOpen) closeSheet({ restoreFocus: false, silent: true });
      if (!how && layout.target()) layout.cancel(); // a different mode while a glide runs: it snaps
      syncToggle(mode); // the pressed state flips with the click, not with the glide
      const run = () => {
        pane.dataset.sessionRail = mode;
        rail.hidden = mode !== 'docked';
        sheet.hidden = !(mode === 'undocked' && sheetOpen);
        attachTray(mode);
        resizer.setShown(mode === 'docked');
      };
      const changed = layoutChange && Boolean(lastMode);
      lastMode = mode; // before the commit: a measuring step inside it must see this mode, not the old one
      layout.commit({ how, mode, changed, run });
      if (visible()) {
        paint();
        if (needsFetch) { needsFetch = false; void fetchSummary(); }
      }
    }

    // ── Docking ──────────────────────────────────────────────────────────
    /* `measuring`: a side panel's open is being measured (side-panel-measuring), so the decision is made
       with the panel's final state now and the rail leaves inside that motion. */
    function evaluateDock(options) {
      if (disposed) return;
      const measuring = Boolean(options && options.measuring === true);
      // Never re-evaluate mid-motion: the motion's end (the attribute leaving) re-runs this.
      if (!measuring && chatView && chatView.hasAttribute('data-panel-motion')) return;
      const width = layout.paneWidth(docked);
      if (perf) perf.setPaneWidth(width);
      const next = model.resolveDocked({ paneWidth: width, panelActive: layout.panelActive(), wasDocked: docked });
      if (next !== docked) docked = next;
      if (currentMode() !== lastMode) applyMode(measuring ? 'measuring' : undefined);
    }

    // ── Data ─────────────────────────────────────────────────────────────
    async function fetchSummary() {
      const sid = sessionId;
      if (disposed || !sid || !bridgeOk) return;
      if (fetching) { refetchQueued = true; return; }
      fetching = true;
      const requestGeneration = generation, requestedAt = Date.now();
      const response = await Promise.resolve()
        .then(() => bridge.getSummary({ schema_version: SCHEMA_VERSION, session_id: sid }))
        .catch(() => null);
      fetching = false;
      if (disposed) return;
      if (sid === sessionId && requestGeneration === generation) {
        if (response && response.ok === true && isObject(response.summary) && response.summary.session_id === sid) {
          const incoming = response.summary;
          if (incoming.context?.state === 'available' && incoming.context.data?.scope === 'next_send') contextPreview.remember(sid, incoming.context.data, requestedAt);
          if (incoming.context && incoming.context.state !== 'available'
            && summary?.context?.data?.scope === 'next_send' && summary.context.data.breakdown) {
            incoming.context = { ...summary.context, state: 'stale' };
          }
          summary = incoming; status = 'ready';
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
      layout.cancel(); // a switch snaps any glide
      applyMode();
      paint({ instant: true });
      void fetchSummary();
      return true;
    }

    // ── Painting ─────────────────────────────────────────────────────────
    function summaryWithDraft() {
      const own = summary?.context?.data, shared = summary?.context?.state === 'available' && own?.scope === 'next_send' && contextPreview.latest(sessionId)?.data;
      if (!(shared || own)?.breakdown) return summary;
      const data = contextPreview.withDraft(shared || own, pane.querySelector('[data-chat-node="chatInput"], #chatInput')?.value, o.getAttachments?.());
      return { ...summary, context: { ...summary.context, data } };
    }

    function paint(paintOptions) {
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
      const settling = Boolean(paintOptions && paintOptions.instant) || vm.sections.some((section) => (cache.get(section.key) || {}).state === 'checking' && section.state !== 'checking');
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

    function toggleSection(key) { // a section head, or Background tasks' finished divider
      if (!model.DISCLOSURE_KEYS.includes(key)) return;
      const vm = model.buildRailViewModel({ summary: summaryWithDraft(), status, sessionId, workspaceView: view, overrides, jt });
      const next = !model.isDisclosureOpen(vm, key);
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
      applyMode('glide');
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
      if (!target || jobs?.handleClick(event)) return;
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
      if (row.getAttribute('data-rail-resource')) request.resourceRef = row.getAttribute('data-rail-resource');
      if (sheetOpen) closeSheet({ restoreFocus: false });
      detail.open(request);
    });

    listen(win, 'jenny:focused-chat-changed', () => { syncSession(); });
    disposers.push(contextPreview.bindRefresh({ pane, win, listen, syncSession, scheduleFetch, paint, visible, options: o, getSessionId: () => sessionId }));
    if (o.chatTimeline) listen(o.chatTimeline, 'transcript-view-rendered', () => { syncSession(); });

    disposers.push(layout.watch({ onResize: () => { syncSession(); evaluateDock(); }, onChange: () => { evaluateDock(); } }));
    // A side panel's open is being measured: decide the dock with its final state, so a rail it forces out
    // leaves inside that motion rather than in a second reflow after it.
    disposers.push(layout.onMeasuring(() => { evaluateDock({ measuring: true }); }));

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
      if (mountedByPane.get(pane) === api) mountedByPane.delete(pane);
      layout.dispose();
      resizer.dispose();
      if (perf) perf.dispose();
      if (fetchTimer) win.clearTimeout(fetchTimer);
      fetchTimer = 0;
      while (disposers.length) {
        const release = disposers.pop();
        try { release(); } catch (_error) { /* best-effort teardown, as the registry does */ }
      }
      doc.removeEventListener('pointerdown', onOutsidePointer, true);
      if (stage && lastMode === 'docked') layout.notify('before');
      delete pane.dataset.sessionRail;
      rail.remove(); sheet.remove(); toggle.remove();
      if (stage && lastMode === 'docked') {
        void stage.offsetWidth;
        layout.notify('after');
      }
    }
    if (o.signal && typeof o.signal.addEventListener === 'function') {
      o.signal.addEventListener('abort', dispose, { once: true });
      disposers.push(() => o.signal.removeEventListener('abort', dispose));
    }

    const api = {
      dispose,
      syncSession,
      evaluateDock,
      refresh: () => { if (sessionId) void fetchSummary(); },
      getMode: currentMode,
      isSheetOpen: () => sheetOpen,
      // Ctrl+\: hides the docked rail through the toggle's own path (glide, rail_visible write); false when not docked.
      hideDocked: () => { if (currentMode() !== 'docked') return false; toggleRailVisible(); return true; },
      elements: { rail, sheet, tray, toggle, resizer: resizer.element },
    };
    mountedByPane.set(pane, api);
    evaluateDock(); applyMode();
    if (sessionId && bridgeOk) void fetchSummary();
    return api;
  }

  // Ctrl+\ (renderer-global-shortcuts.js): hides the focused pane's docked rail. True when it did.
  function hideFocusedRail(doc) {
    const pane = doc && (doc.querySelector('.chat-pane[data-pane-focused="true"]') || (doc.activeElement && doc.activeElement.closest && doc.activeElement.closest('.chat-pane')));
    const rail = pane ? mountedByPane.get(pane) : null;
    return Boolean(rail && rail.hideDocked());
  }

  return { mountSessionRail, configure, hideFocusedRail, REFLOW_EVENT };
});
