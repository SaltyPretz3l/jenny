(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./renderer-subagent-monitor-model'),
      require('./renderer-subagent-monitor-view')
    );
    return;
  }
  root.rendererSubagentMonitorController = factory(
    root.rendererSubagentMonitorModel || {},
    root.rendererSubagentMonitorView || {}
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (modelUtils, viewUtils) {
  'use strict';

  const REHOST_EVENT = 'subagent-monitor:rehost';
  const DEFAULT_PANEL_ID = 'artifactReviewPanel';
  const FOCUS_ATTRIBUTES = ['data-subagent-select', 'data-subagent-back', 'data-subagent-close'];

  // One monitor controller per chat pane. Two pages, at every width: the tree
  // (a delegation's children) and one child's drill-in. In Chat the monitor
  // is rail mode `subagents` of the artifact review panel: this controller
  // never writes into the panel, it hands its markup to the panel rail
  // (renderer-subagent-rail.js) when the panel asks (a pull). In the Workspace
  // IDE dock there is no artifact panel, so the pane's in-stage aside hosts
  // the same markup.
  function createSubagentMonitorController(options = {}) {
    const state = options.state || {};
    const documentRef = options.documentRef || (typeof document !== 'undefined' ? document : null);
    const windowRef = options.windowRef || documentRef?.defaultView || globalThis;
    // Split view W3-2: one monitor per chat pane. The pane hands its own
    // in-stage aside (never looked up by id here: a pane without one must not
    // take pane 0's), its session accessor, and `ownsTrigger`, which keeps the
    // document-level listeners to its own [data-subagent-open] triggers.
    // Omitted, the monitor reads the focused session and owns every trigger.
    const inspector = options.inspector || null;
    // `idSuffix` keeps a second pane's ids (its title's, the disclosures') unique.
    const idSuffix = String(options.idSuffix || '');
    if (inspector && idSuffix) {
      const titleId = 'subagentInspectorTitle' + idSuffix;
      if (!inspector.id) inspector.id = 'subagentInspector' + idSuffix;
      inspector.setAttribute('aria-labelledby', titleId);
    }
    const getMessages = typeof options.getMessages === 'function' ? options.getMessages : () => [];
    const readSessionId = typeof options.getSessionId === 'function'
      ? () => String(options.getSessionId() || '')
      : () => String(state.currentSessionId || '');
    const ownsTrigger = typeof options.ownsTrigger === 'function' ? options.ownsTrigger : () => true;
    const appendClientLog = typeof options.appendClientLog === 'function' ? options.appendClientLog : () => {};
    // ensure builds the rail through the bridge hook when no surface exists yet;
    // the built rail is kept so later lookups never depend on it being published.
    let ensuredRail = null;
    const resolveRail = (ensure = false) => {
      const known = options.rail || windowRef.rendererSubagentRailHost || ensuredRail;
      if (known || !ensure || typeof windowRef.rendererEnsureSubagentRail !== 'function') return known || null;
      ensuredRail = windowRef.rendererEnsureSubagentRail() || null;
      return ensuredRail;
    };
    let openKey = '';
    let openSessionId = '';
    let selectedKey = '';
    let manualSelection = false;
    let page = 'tree';
    let hosted = ''; // '' (closed) | 'panel' | 'dock' (the pane's own aside)
    let origin = null;
    let disposed = false;
    let elapsedTimer = null;
    let lastSignature = '';
    let cachedParts = null;
    let lastAsideHtml = '';
    let lastDockStage = null;

    function currentMessages() {
      return getMessages(readSessionId().trim()) || [];
    }

    function ownTriggers() {
      return [...(documentRef?.querySelectorAll?.('[data-subagent-open]') || [])].filter(ownsTrigger);
    }

    // The IDE dock moves the whole thread stage (and this aside) into
    // #ideChatDock, where no artifact panel exists.
    function isDockStage() {
      return Boolean(inspector?.closest?.('#ideChatDock'));
    }

    // The artifact panel shows only in the Chat view: opening its rail from
    // another view would force a view switch (openArtifactRail).
    function chatViewActive() {
      const view = state.ui?.activeView;
      return view == null || view === 'chat';
    }

    function wantsPanel() {
      return !isDockStage() && chatViewActive() && Boolean(resolveRail());
    }

    // The host the inline cards control: the one in use, else the one an open would pick.
    function hostId() {
      const panel = hosted ? hosted === 'panel' : wantsPanel();
      return panel ? (resolveRail()?.PANEL_ID || DEFAULT_PANEL_ID) : (inspector?.id || 'subagentInspector');
    }

    function panelShell() {
      const panel = documentRef?.getElementById?.(resolveRail()?.PANEL_ID || DEFAULT_PANEL_ID);
      return panel?.querySelector?.('.subagent-monitor-shell') || null;
    }

    function contentRoot() {
      if (hosted === 'panel') return panelShell();
      return hosted === 'dock' ? inspector : null;
    }

    function viewModel(now = Date.now()) {
      return modelUtils.buildMonitorFromMessages?.(
        currentMessages(), openKey, selectedKey, now
      ) || null;
    }

    // Elapsed seconds are left out on purpose: the tick updates the live
    // elapsed text in place, and a repaint per second would drop focus and
    // scroll position.
    function signature(model) {
      if (!model) return '';
      return JSON.stringify({
        page,
        hosted,
        selected: model.selectedKey,
        status: model.status,
        tone: model.tone,
        terminal: model.terminal,
        parentState: model.parentState,
        usage: model.usage,
        children: model.children.map((child) => ({
          key: child.key,
          label: child.label,
          status: child.status,
          tone: child.tone,
          terminal: child.terminal,
          terminalReason: child.terminalReason,
          terminalCopy: child.terminalCopy,
          summary: child.summary,
          answer: child.answer,
          steps: child.steps,
          stepCount: child.stepCount,
          model: child.model,
          provider: child.provider,
          evidence: child.evidence,
          tools: child.tools,
          uncertainties: child.uncertainties,
          usage: child.usage,
          budget: child.budget,
          error: child.error,
        })),
      });
    }

    // The markup for the current state; unchanged state returns the SAME
    // strings, which lets the panel rail skip the write entirely.
    function compute(now) {
      const model = viewModel(now);
      if (!model?.childCount) return null;
      if (!manualSelection && model.selectedKey) selectedKey = model.selectedKey;
      const nextSignature = signature(model);
      if (cachedParts && nextSignature === lastSignature) return { model, parts: cachedParts, changed: false };
      lastSignature = nextSignature;
      cachedParts = viewUtils.renderMonitor?.(model, { page, idSuffix }) || { header: '', body: '', footer: '' };
      return { model, parts: cachedParts, changed: true };
    }

    function withFocusKept(rootEl, write) {
      const active = rootEl?.ownerDocument?.activeElement;
      let kept = null;
      if (active && rootEl.contains(active)) {
        const attribute = FOCUS_ATTRIBUTES.find((name) => active.hasAttribute?.(name));
        if (attribute) kept = { attribute, value: active.getAttribute(attribute) };
      }
      write();
      if (kept) rootEl.querySelector?.(`[${kept.attribute}="${cssEscape(kept.value)}"]`)?.focus?.({ preventScroll: true });
    }

    function paintAside(parts) {
      if (!inspector) return false;
      const html = `<div class="subagent-monitor-shell" data-subagent-page="${page}">${parts.header}${parts.body}${parts.footer}</div>`;
      inspector.hidden = false;
      inspector.setAttribute('aria-hidden', 'false');
      if (html === lastAsideHtml && inspector.firstElementChild) return false;
      lastAsideHtml = html;
      withFocusKept(inspector, () => { inspector.innerHTML = html; });
      return true;
    }

    function clearAside() {
      lastAsideHtml = '';
      if (!inspector) return;
      inspector.hidden = true;
      inspector.setAttribute('aria-hidden', 'true');
      inspector.innerHTML = '';
    }

    function render(renderOptions = {}) {
      if (disposed || !openKey || !hosted) return false;
      if (renderOptions.force) { lastSignature = ''; cachedParts = null; lastAsideHtml = ''; }
      const computed = compute(renderOptions.now);
      if (!computed) {
        // The pane now shows another chat: the delegation is simply gone, not broken.
        const sessionChanged = readSessionId().trim() !== openSessionId;
        if (!sessionChanged) {
          appendClientLog('WARN', 'subagent_monitor.details_unavailable', {
            sessionId: readSessionId().slice(0, 30),
          });
        }
        close({ restoreFocus: !sessionChanged });
        return false;
      }
      if (computed.changed || renderOptions.force) {
        if (hosted === 'panel') {
          const rail = resolveRail();
          rail?.setPage?.(page);
          rail?.repaint?.();
        } else {
          paintAside(computed.parts);
        }
      } else if (hosted === 'dock') {
        paintAside(computed.parts);
      }
      syncOriginExpanded(true);
      scheduleElapsedTick();
      return computed.changed || renderOptions.force === true;
    }

    // Puts the monitor on the host this pane's stage calls for. A refused
    // panel open (the panel could not show) degrades to the in-stage aside.
    function attachHost() {
      const snapshot = { key: openKey, page, selectedKey, manualSelection, origin };
      hosted = '';
      if (!isDockStage()) resolveRail(true);
      if (wantsPanel()) {
        hosted = 'panel';
        const opened = resolveRail().open({ handle, sessionId: readSessionId().trim(), key: snapshot.key, page });
        if (opened) return 'panel';
        // A refused open may have released this controller mid-way.
        openKey = snapshot.key; page = snapshot.page; selectedKey = snapshot.selectedKey;
        manualSelection = snapshot.manualSelection; origin = snapshot.origin;
      }
      hosted = inspector ? 'dock' : '';
      lastSignature = '';
      cachedParts = null;
      render({ force: true });
      return hosted;
    }

    function focusLanding() {
      const rootEl = contentRoot();
      if (!rootEl) return;
      const target = (page === 'detail' ? rootEl.querySelector?.('[data-subagent-back]') : rootEl.querySelector?.('[data-subagent-select][tabindex="0"]'))
        || rootEl.querySelector?.('[data-subagent-close]');
      target?.focus?.();
    }

    function open(key, trigger) {
      if (disposed) return false;
      const nextKey = String(key || '').trim();
      if (!nextKey) return false;
      const previousKey = openKey;
      openKey = nextKey;
      selectedKey = '';
      manualSelection = false;
      const model = viewModel();
      if (!model?.childCount) {
        appendClientLog('WARN', 'subagent_monitor.details_unavailable', {
          sessionId: readSessionId().slice(0, 30),
        });
        openKey = previousKey;
        return false;
      }
      openSessionId = readSessionId().trim();
      selectedKey = model.selectedKey;
      // One child: straight to its drill-in. Several: the tree lands first.
      page = model.childCount === 1 ? 'detail' : 'tree';
      origin = trigger && typeof trigger.focus === 'function' ? trigger : null;
      lastSignature = '';
      cachedParts = null;
      if (hosted === 'dock') clearAside();
      attachHost();
      if (!openKey || !hosted) {
        resetState();
        return false;
      }
      syncOriginExpanded(true);
      scheduleElapsedTick();
      focusLanding();
      return true;
    }

    function resetState() {
      openKey = '';
      openSessionId = '';
      selectedKey = '';
      manualSelection = false;
      page = 'tree';
      hosted = '';
      lastSignature = '';
      cachedParts = null;
    }

    function close(closeOptions = {}) {
      const wasOpen = Boolean(openKey);
      const wasKey = openKey;
      const wasPanel = hosted === 'panel';
      const restoreFocus = closeOptions.restoreFocus !== false && origin !== null;
      const openedFrom = origin;
      resetState();
      clearAside();
      syncOriginExpanded(false);
      clearElapsedTick();
      origin = null;
      if (wasPanel) resolveRail()?.close?.({ handle });
      if (restoreFocus) {
        // The panel restore may have re-rendered the timeline: focus the card's live node.
        const card = ownTriggers().find((trigger) => trigger.getAttribute('data-subagent-open') === wasKey) || openedFrom;
        card?.focus?.();
      }
      return wasOpen || Boolean(inspector);
    }

    // The panel rail ended the record (another mode, a hidden panel, another
    // pane's open, a session switch): reset, restore nothing, focus nothing.
    function released() {
      resetState();
      clearAside();
      syncOriginExpanded(false);
      clearElapsedTick();
      origin = null;
    }

    // The stage moved between Chat and the IDE dock (explicit call from the
    // dock move / view switch, or the `subagent-monitor:rehost` window event).
    function rehost() {
      if (disposed || !openKey || !hosted) return false;
      lastDockStage = isDockStage();
      if (!lastDockStage && !chatViewActive()) {
        // The stage left the dock while another view is up (the dock closed
        // in the IDE): no host can show the monitor, and opening the panel's
        // rail would force the Chat view. Close and put the prefs back.
        close({ restoreFocus: false });
        return true;
      }
      const wantPanel = wantsPanel();
      if ((hosted === 'panel') === wantPanel) return render({ force: true });
      if (hosted === 'panel') {
        const rail = resolveRail();
        hosted = '';
        rail?.close?.({ handle }); // an explicit close: the rail never releases this handle for it
      } else {
        clearAside();
      }
      attachHost();
      syncOriginExpanded(Boolean(openKey));
      return true;
    }

    function select(key, focusAfter = true) {
      const nextKey = String(key || '').trim();
      if (!nextKey || !openKey) return false;
      selectedKey = nextKey;
      manualSelection = true;
      page = 'detail';
      render({ force: true });
      if (focusAfter) contentRoot()?.querySelector?.('[data-subagent-back]')?.focus?.();
      return true;
    }

    // Back to the tree, at any width.
    function back() {
      if (!openKey || page !== 'detail') return false;
      page = 'tree';
      render({ force: true });
      contentRoot()?.querySelector?.(`[data-subagent-select="${cssEscape(selectedKey)}"]`)?.focus?.();
      return true;
    }

    function syncOriginExpanded(expanded) {
      const controls = hostId();
      if (origin?.setAttribute) origin.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      for (const trigger of ownTriggers()) {
        const matches = String(trigger.getAttribute('data-subagent-open') || '') === openKey;
        trigger.setAttribute('aria-expanded', expanded && matches ? 'true' : 'false');
        // The inline cards control the host that shows the monitor: the artifact panel in Chat, the pane's aside in the dock.
        if (trigger.getAttribute('aria-controls') !== controls) trigger.setAttribute('aria-controls', controls);
      }
    }

    function reconcile() {
      if (disposed) return false;
      const dockStage = isDockStage();
      if (openKey && lastDockStage !== null && lastDockStage !== dockStage) rehost();
      lastDockStage = dockStage;
      syncOriginExpanded(Boolean(openKey));
      const changed = openKey ? render() : false;
      scheduleElapsedTick();
      return changed;
    }

    // Clicks and keys on the monitor's own content (the panel rail forwards
    // the panel's; the dock aside's arrive through the document listeners).
    function handleClick(event) {
      const selectTrigger = event.target?.closest?.('[data-subagent-select]');
      if (selectTrigger) {
        event.preventDefault();
        select(selectTrigger.getAttribute('data-subagent-select'));
        return;
      }
      if (event.target?.closest?.('[data-subagent-close]')) {
        event.preventDefault();
        close();
        return;
      }
      if (event.target?.closest?.('[data-subagent-back]')) {
        event.preventDefault();
        back();
      }
    }

    function isEditable(target) {
      const tag = String(target?.tagName || '').toLowerCase();
      return tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable === true;
    }

    function handleKeydown(event) {
      if (!openKey) return;
      const rootEl = contentRoot();
      if (!rootEl) return;
      // In the panel the rail forwards only the panel's own keys.
      const inside = hosted === 'panel' || rootEl.contains?.(event.target);
      if (!inside) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }
      if (event.ctrlKey || event.metaKey || isEditable(event.target)) return;
      // Backspace, ArrowLeft (with or without Alt) go back from the drill-in.
      const goBack = event.key === 'Backspace' || event.key === 'ArrowLeft';
      if (page === 'detail' && goBack) {
        event.preventDefault();
        back();
        return;
      }
      const item = event.target?.closest?.('[data-subagent-select]');
      if (!item || !rootEl.contains?.(item)) return;
      const items = [...rootEl.querySelectorAll('[data-subagent-select]')];
      const index = items.indexOf(item);
      let target = null;
      if (event.key === 'ArrowDown') target = items[Math.min(items.length - 1, index + 1)];
      if (event.key === 'ArrowUp') target = items[Math.max(0, index - 1)];
      if (event.key === 'Home') target = items[0];
      if (event.key === 'End') target = items[items.length - 1];
      if (event.key === 'ArrowRight' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        select(item.getAttribute('data-subagent-select'));
        return;
      }
      if (target) {
        event.preventDefault();
        items.forEach((entry) => entry.setAttribute('tabindex', entry === target ? '0' : '-1'));
        target.focus();
      }
    }

    function handleDocumentClick(event) {
      const openTrigger = event.target?.closest?.('[data-subagent-open]');
      if (openTrigger && !ownsTrigger(openTrigger)) return;
      if (openTrigger) {
        event.preventDefault();
        open(openTrigger.getAttribute('data-subagent-open'), openTrigger);
        return;
      }
      if (hosted === 'dock' && inspector?.contains?.(event.target)) handleClick(event);
    }

    function handleDocumentKeydown(event) {
      if (hosted === 'dock') handleKeydown(event);
    }

    function applyLiveElapsed(model) {
      const rootEl = contentRoot();
      if (!rootEl || !model) return;
      for (const node of rootEl.querySelectorAll?.('[data-subagent-live-elapsed]') || []) {
        const id = String(node.getAttribute('data-subagent-live-elapsed') || '');
        const ms = id === 'parent' ? model.elapsedMs : model.children.find((child) => `child:${child.key}` === id)?.elapsedMs;
        const text = modelUtils.formatElapsed?.(ms) || '';
        if (text && node.textContent !== text) node.textContent = text;
      }
    }

    function refreshElapsed() {
      elapsedTimer = null;
      if (disposed || documentRef?.hidden) return;
      const now = Date.now();
      let hasActive = false;
      for (const trigger of ownTriggers()) {
        const key = trigger.getAttribute('data-subagent-open');
        const model = modelUtils.buildMonitorFromMessages?.(currentMessages(), key, '', now);
        if (!model || model.terminal) continue;
        hasActive = true;
        trigger.querySelector?.('[data-subagent-elapsed]')?.replaceChildren?.(modelUtils.formatElapsed?.(model.elapsedMs) || '');
      }
      if (openKey) {
        const model = viewModel(now);
        applyLiveElapsed(model);
        if (model && !model.terminal) hasActive = true;
      }
      if (hasActive) scheduleElapsedTick();
    }

    function scheduleElapsedTick() {
      if (disposed || elapsedTimer || documentRef?.hidden) return;
      const hasActive = ownTriggers()
        .some((trigger) => {
          const key = trigger.getAttribute('data-subagent-open');
          return modelUtils.buildMonitorFromMessages?.(currentMessages(), key)?.terminal === false;
        });
      if (hasActive) elapsedTimer = windowRef.setTimeout(refreshElapsed, 1000);
    }

    function clearElapsedTick() {
      if (elapsedTimer != null) windowRef.clearTimeout?.(elapsedTimer);
      elapsedTimer = null;
    }

    function handleVisibilityChange() {
      if (documentRef?.hidden) clearElapsedTick();
      else scheduleElapsedTick();
    }

    function cssEscape(value) {
      if (windowRef.CSS?.escape) return windowRef.CSS.escape(String(value || ''));
      return String(value || '').replace(/["\\]/g, '\\$&');
    }

    // What the panel rail sees of this controller.
    const handle = {
      isBoundTo: (record) => Boolean(openKey) && hosted === 'panel'
        && record?.key === openKey && record?.sessionId === readSessionId().trim(),
      panelMarkup: () => (openKey && hosted === 'panel' && !disposed ? (compute()?.parts || null) : null),
      handleClick,
      handleKeydown,
      close: () => close(),
      released,
    };

    function bind() {
      if (!documentRef || disposed) return;
      documentRef.addEventListener('click', handleDocumentClick);
      documentRef.addEventListener('keydown', handleDocumentKeydown);
      documentRef.addEventListener('visibilitychange', handleVisibilityChange);
      windowRef.addEventListener?.(REHOST_EVENT, rehost);
      lastDockStage = isDockStage();
      reconcile();
    }

    function dispose() {
      if (disposed) return;
      close({ restoreFocus: false });
      disposed = true;
      documentRef?.removeEventListener?.('click', handleDocumentClick);
      documentRef?.removeEventListener?.('keydown', handleDocumentKeydown);
      documentRef?.removeEventListener?.('visibilitychange', handleVisibilityChange);
      windowRef.removeEventListener?.(REHOST_EVENT, rehost);
      clearElapsedTick();
    }

    return { REHOST_EVENT, bind, close, dispose, handle, open, reconcile, rehost, render, select, back };
  }

  return { REHOST_EVENT, createSubagentMonitorController };
});
