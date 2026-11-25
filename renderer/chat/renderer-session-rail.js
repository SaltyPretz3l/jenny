/* renderer/chat/renderer-session-rail.js - one session rail per chat pane (UMD).

   Row 59 checkpoint 2 (chat workspace parity spec, "Session rail"). The controller owns, for ONE pane:
   the data (window.jennyShell.chatWorkspace, contract C2), the rail's place in the Chat workbench's
   Session view, the disclosure sections and their persistence, and focus. Markup lives in
   renderer-session-rail-render.js, words and rules in renderer-session-rail-model.js, styling in
   styles/chat-session-rail.css (which keys off the attribute this controller writes).

   The pane element carries data-session-rail="hosted|hidden":
     hosted    row 190: the focused pane's rail lives in the Chat workbench's Session view
               (configure({ getHost })). No room in the pane, no toggle, no resizer: the workbench
               owns the width.
     hidden    another pane's rail is hosted, or the rail is not available here (no bridge, no
               session, a pane hosted in the Workspace dock). It waits, unpainted, inside the pane.

   Data: getSummary on mount and on a session/input change, a refetch on onChanged for this pane's
   session (debounced, one request in flight), and an optional visible-rail freshness timer. A summary for another session is
   never painted: a session change clears to "checking" first. Every listener, observer, timer
   and the bridge subscription is released by dispose().

   Row 195: a rail nobody can see (the stack is folded, another tab or another room is in front) fetches nothing
   and runs no timer; it notes that it is behind and refreshes once when it shows again (isShown + syncHosts).
   Running now and Jenny's checklist take their rows from injected readers (getRunningRows, getChecklist), a
   run opens through openRun / openRuns, and isFullAuto names the run mode; each is a mount option or a
   configure() port. A detail open names this rail's own pane, so the action lands in the pane the rail shows. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-session-rail-model'), require('./renderer-session-rail-render'), require('./renderer-session-rail-performance'), require('./renderer-context-preview'), require('./renderer-session-rail-jobs'));
    return;
  }
  root.rendererSessionRail = factory(root.rendererSessionRailModel, root.rendererSessionRailRender, root.rendererSessionRailPerformance, root.rendererContextPreview, root.rendererSessionRailJobs);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (model, render, performanceRail, contextPreview, railJobs) {
  'use strict';

  const REFETCH_DELAY_MS = 120;
  const SCHEMA_VERSION = 1;
  let railSequence = 0;

  function isObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function normalizeView(value) {
    const view = isObject(value) ? value : {};
    return {
      disclosures: isObject(view.disclosures) ? { ...view.disclosures } : {},
      children_expanded: typeof view.children_expanded === 'boolean' ? view.children_expanded : null,
    };
  }

  const PORTS = ['openSession', 'getRunningRows', 'openRun', 'openRuns', 'getChecklist', 'isFullAuto']; // app-level function ports
  const configured = { openSession: null, getHost: null, isShown: null, getRunningRows: null, openRun: null, openRuns: null, getChecklist: null, isFullAuto: null }; // Row 59 cp5a: a linked Background tasks row opens its chat (app-level port)
  const mountedByPane = new WeakMap(); // pane -> its live rail's api; a remount retires it
  const liveRails = new Set(); // every mounted rail, for syncHosts()
  const configure = (options) => { // row 190: getHost(pane) -> the host element, or null (hidden: another pane's rail is hosted)
    for (const name of PORTS) if (options && name in options) configured[name] = typeof options[name] === 'function' ? options[name] : null;
    if (options && 'getHost' in options) configured.getHost = typeof options.getHost === 'function' ? options.getHost : null;
    // isShown() -> false while the host is off screen (another room, another tab, a folded stack): no paint, no fetch.
    if (options && 'isShown' in options) configured.isShown = typeof options.isShown === 'function' ? options.isShown : null;
  };
  const syncHosts = () => { liveRails.forEach((api) => api.syncHost()); }; // row 190: after the host or the focused pane changed

  function mountSessionRail(options) {
    const o = options || {};
    const pane = o.pane;
    const getSessionId = o.getSessionId;
    if (!pane || typeof getSessionId !== 'function') return null;
    if (o.signal && o.signal.aborted) return null;
    const doc = pane.ownerDocument;
    const win = o.windowRef || (doc && doc.defaultView);
    if (!doc || !win) return null;
    const jt = typeof o.jt === 'function' ? o.jt : model.defaultJt();
    const stage = o.stage || Array.from(pane.children).find((child) => child.classList.contains('chat-thread-stage')) || null;
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
    let fetching = false;
    let generation = 0;
    let refetchQueued = false;
    let needsFetch = false;
    let fetchTimer = 0;
    let writeChain = Promise.resolve();
    let lastMode = '';
    let painted = false;
    const cache = new Map();
    let paintedKeys = '';
    let wasVisible = false; // the last answer of visible(): a change to true refreshes once
    let fetchedOnce = false;
    const port = (name) => (typeof o[name] === 'function' ? o[name] : configured[name]); // a mount option wins over the app-level port
    const disposers = [];

    function listen(target, type, handler, listenerOptions) {
      if (!target || typeof target.addEventListener !== 'function') return;
      target.addEventListener(type, handler, listenerOptions);
      disposers.push(() => target.removeEventListener(type, handler, listenerOptions));
    }

    // ── Elements ─────────────────────────────────────────────────────────
    mountedByPane.get(pane)?.dispose(); // retire the previous controller (timer, listeners, nodes)
    pane.querySelectorAll(':scope > [data-session-rail-root]').forEach((node) => node.remove());
    const title = jt('chat.sessionRail.title', 'Session');
    const rail = doc.createElement('aside');
    rail.className = 'session-rail';
    rail.setAttribute('data-session-rail-root', 'true');
    rail.setAttribute('aria-label', title);
    rail.hidden = true;
    const tray = doc.createElement('div');
    tray.className = 'session-rail-tray';
    rail.append(tray);
    pane.append(rail);
    const jobs = railJobs?.createRailJobs({ tray, win, jt, getSessionId: () => sessionId, trayShown: () => visible(), getBackgroundJobs: () => win.jennyShell?.backgroundJobs, getJobWaiters: o.getJobWaiters, getBrowserUse: o.getBrowserUse, onBrowserChange: () => paint() }); if (jobs) disposers.push(jobs.dispose); // background-job rows
    // Row 59 cp6: the Performance section (own bridge; absent = nothing renders).
    const perf = performanceRail ? performanceRail.createRailPerformance({ win, doc, jt, getSessionId, idPrefix, bridge: o.performance, shown: false }) : null;

    // ── Mode ─────────────────────────────────────────────────────────────
    function hostedElsewhere() {
      return pane.classList.contains('ide-chat-dock-body')
        || (stage ? !pane.contains(stage) : true);
    }

    function available() {
      return !disposed && bridgeOk && Boolean(sessionId) && !hostedElsewhere();
    }

    function hostEl() { // row 190: the host element the workbench gave this pane, or null (another pane is hosted)
      return (typeof configured.getHost === 'function' ? configured.getHost(pane) : null) || null;
    }

    function currentMode() {
      return available() && hostEl() ? 'hosted' : 'hidden';
    }

    function visible() {
      return currentMode() === 'hosted' && (typeof configured.isShown !== 'function' || configured.isShown() !== false);
    }

    /* Visible now? A change to shown refreshes once (the summary, the chat's browser page, the performance reading);
       a change to hidden stops the performance timer. A rail that was never fetched leaves that to its caller. */
    function noteVisibility() {
      const now = visible();
      if (perf) perf.setVisible(now);
      if (now !== wasVisible) jobs?.sync?.(); // the running rows' clock ticks only while the rail shows
      if (now && !wasVisible) {
        jobs?.syncBrowser();
        if (fetchedOnce || needsFetch) { needsFetch = false; void fetchSummary(); }
      }
      wasVisible = now;
      return now;
    }

    // A fetch now when the rail is on screen, else one owed for when it shows.
    function requestFetch() {
      if (visible()) void fetchSummary();
      else needsFetch = true;
    }

    // Applies the mode to the pane and its parts: hosted, the rail sits in the workbench's host; hidden, it waits in the pane.
    function applyMode() {
      const mode = currentMode();
      lastMode = mode;
      pane.dataset.sessionRail = mode;
      const host = mode === 'hosted' ? hostEl() : null;
      if (host) {
        if (rail.parentNode !== host) host.appendChild(rail);
      } else if (rail.parentNode !== pane) {
        pane.appendChild(rail);
      }
      rail.hidden = mode !== 'hosted';
      if (noteVisibility()) {
        paint();
        if (needsFetch) { needsFetch = false; void fetchSummary(); }
      }
    }

    // ── Data ─────────────────────────────────────────────────────────────
    async function fetchSummary() {
      const sid = sessionId;
      if (disposed || !sid || !bridgeOk) return;
      if (fetching) { refetchQueued = true; return; }
      fetching = true;
      fetchedOnce = true;
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
          summary = contextPreview.markStale(summary, model.SUMMARY_KEYS);
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
      if (!visible()) { needsFetch = true; return; } // a rail nobody sees sets no timer and asks for nothing
      fetchTimer = win.setTimeout(() => {
        fetchTimer = 0;
        if (disposed) return;
        requestFetch();
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
      const wasShown = wasVisible;
      applyMode();
      if (wasShown && visible()) jobs?.syncBrowser(); // the new chat's browser page (a rail coming into view reads it itself)
      paint({ instant: true });
      requestFetch();
      return true;
    }

    // ── Painting ─────────────────────────────────────────────────────────
    function summaryWithDraft() {
      const own = summary?.context?.data, shared = summary?.context?.state === 'available' && own?.scope === 'next_send' && contextPreview.latest(sessionId)?.data;
      if (!(shared || own)?.breakdown) return summary;
      const data = contextPreview.withDraft(shared || own, pane.querySelector('[data-chat-node="chatInput"], #chatInput')?.value, o.getAttachments?.());
      return { ...summary, context: { ...summary.context, data } };
    }

    function buildVm() {
      return model.buildRailViewModel({
        summary: summaryWithDraft(), status, sessionId, workspaceView: view, overrides, jt, browser: jobs?.getBrowser(),
        fullAuto: port('isFullAuto')?.(sessionId) === true, getRunningRows: port('getRunningRows'), getChecklist: port('getChecklist'),
      });
    }

    function paint(paintOptions) {
      if (disposed || !visible()) return;
      const vm = buildVm();
      const keys = vm.sections.map((section) => section.key).join(',');
      if (!painted || keys !== paintedKeys) { // first paint, or Running now or the checklist came or went
        paintedKeys = keys;
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

    function toggleSection(key) { // a section head
      if (!model.DISCLOSURE_KEYS.includes(key)) return;
      const vm = buildVm();
      const next = !model.isDisclosureOpen(vm, key);
      overrides = { ...overrides, [key]: next };
      paint();
      const persistKey = model.PERSIST_KEY[key];
      if (!persistKey) return; // the checklist's fold lasts for this pane only
      void writeView({ disclosures: { [persistKey]: next } }, {
        confirm: () => { delete overrides[key]; },
        revert: () => { delete overrides[key]; },
      });
    }

    // ── Events ───────────────────────────────────────────────────────────
    listen(tray, 'click', (event) => {
      const target = event.target && event.target.closest ? event.target : null;
      if (!target || jobs?.handleClick(event)) return;
      const header = target.closest('[data-rail-section]');
      if (header && tray.contains(header)) {
        event.preventDefault();
        toggleSection(header.getAttribute('data-rail-section'));
        return;
      }
      const runsLink = port('openRuns') && target.closest('[data-rail-runs]');
      if (runsLink && tray.contains(runsLink)) {
        event.preventDefault();
        return void port('openRuns')({ ownerSessionId: sessionId, pane });
      }
      const runRow = port('openRun') && target.closest('[data-rail-run]');
      if (runRow && tray.contains(runRow)) {
        event.preventDefault();
        return void port('openRun')(runRow.getAttribute('data-rail-run'), { ownerSessionId: sessionId, pane });
      }
      const sessionRow = configured.openSession && target.closest('[data-rail-session]');
      if (sessionRow && tray.contains(sessionRow)) {
        event.preventDefault();
        return void configured.openSession(sessionRow.getAttribute('data-rail-session'));
      }
      const row = target.closest('[data-rail-surface]');
      if (!row || !tray.contains(row)) return;
      event.preventDefault();
      const detail = o.detail || win.rendererChatWorkspaceDetail;
      if (!detail || typeof detail.open !== 'function') return;
      const request = { surface: row.getAttribute('data-rail-surface'), ownerSessionId: sessionId, opener: row, pane }; // the pane this rail shows, not the one on the left
      if (row.getAttribute('data-rail-resource')) request.resourceRef = row.getAttribute('data-rail-resource');
      detail.open(request);
    });

    listen(win, 'jenny:focused-chat-changed', () => { syncSession(); });
    disposers.push(contextPreview.bindRefresh({ pane, win, listen, syncSession, scheduleFetch, paint, visible, options: o, getSessionId: () => sessionId }));
    if (o.chatTimeline) listen(o.chatTimeline, 'transcript-view-rendered', () => { syncSession(); });
    if (typeof win.MutationObserver === 'function') { // the pane moving into or out of the Workspace dock (ide-chat-dock-body)
      const paneClass = new win.MutationObserver(() => { if (currentMode() !== lastMode) applyMode(); });
      paneClass.observe(pane, { attributes: true, attributeFilter: ['class'] });
      disposers.push(() => paneClass.disconnect());
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
      disposed = true;
      if (mountedByPane.get(pane) === api) mountedByPane.delete(pane);
      liveRails.delete(api);
      if (perf) perf.dispose();
      if (fetchTimer) win.clearTimeout(fetchTimer);
      fetchTimer = 0;
      while (disposers.length) {
        const release = disposers.pop();
        try { release(); } catch (_error) { /* best-effort teardown, as the registry does */ }
      }
      delete pane.dataset.sessionRail;
      rail.remove();
    }
    if (o.signal && typeof o.signal.addEventListener === 'function') {
      o.signal.addEventListener('abort', dispose, { once: true });
      disposers.push(() => o.signal.removeEventListener('abort', dispose));
    }

    const api = {
      dispose,
      syncSession,
      refresh: () => { if (sessionId) void fetchSummary(); },
      getMode: currentMode,
      syncHost: () => {
        if (disposed) return;
        if (currentMode() !== lastMode || (lastMode === 'hosted' && rail.parentNode !== hostEl())) applyMode();
        else if (noteVisibility()) { paint(); if (needsFetch) { needsFetch = false; void fetchSummary(); } } // back on screen: catch up (once)
      },
    };
    mountedByPane.set(pane, api);
    liveRails.add(api);
    applyMode();
    if (sessionId && bridgeOk) requestFetch();
    return api;
  }

  return { mountSessionRail, configure, syncHosts };
});
