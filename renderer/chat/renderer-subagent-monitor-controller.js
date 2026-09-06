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

  const WIDE_MIN_WIDTH = 1120;

  function createSubagentMonitorController(options = {}) {
    const state = options.state || {};
    const documentRef = options.documentRef || (typeof document !== 'undefined' ? document : null);
    const windowRef = options.windowRef || documentRef?.defaultView || globalThis;
    const inspector = options.inspector || documentRef?.getElementById?.('subagentInspector');
    const chatView = options.chatView || documentRef?.getElementById?.('chatView');
    const getMessages = typeof options.getMessages === 'function' ? options.getMessages : () => [];
    const appendClientLog = typeof options.appendClientLog === 'function' ? options.appendClientLog : () => {};
    let openKey = '';
    let selectedKey = '';
    let manualSelection = false;
    let compactDetail = false;
    let origin = null;
    let disposed = false;
    let resizeObserver = null;
    let elapsedTimer = null;
    let lastSignature = '';

    function currentMessages() {
      return getMessages(String(state.currentSessionId || '').trim()) || [];
    }

    function isCompact() {
      if (!inspector) return true;
      if (inspector.closest?.('#ideChatDock')) return true;
      const width = Number(chatView?.clientWidth || inspector.parentElement?.clientWidth || 0);
      return width > 0 ? width < WIDE_MIN_WIDTH : true;
    }

    function viewModel(now = Date.now()) {
      return modelUtils.buildMonitorFromMessages?.(
        currentMessages(), openKey, selectedKey, now
      ) || null;
    }

    function signature(model, compact) {
      if (!model) return '';
      return JSON.stringify({
        compact,
        compactDetail,
        selected: model.selectedKey,
        status: model.status,
        tone: model.tone,
        terminal: model.terminal,
        parentState: model.parentState,
        elapsed: Math.floor(Number(model.elapsedMs || 0) / 1000),
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

    function syncLayoutClass(compact) {
      inspector?.classList?.toggle('is-compact', compact);
      inspector?.classList?.toggle('is-wide', !compact);
      chatView?.classList?.toggle('subagent-monitor-open', Boolean(openKey));
      chatView?.classList?.toggle('subagent-monitor-compact', Boolean(openKey) && compact);
      const stage = inspector?.parentElement;
      stage?.classList?.toggle('subagent-monitor-stage-open', Boolean(openKey));
      stage?.classList?.toggle('subagent-monitor-stage-compact', Boolean(openKey) && compact);
    }

    function render(options = {}) {
      if (disposed || !inspector || !openKey) return false;
      const model = viewModel(options.now);
      if (!model?.childCount) {
        appendClientLog('WARN', 'subagent_monitor.details_unavailable', {
          sessionId: String(state.currentSessionId || '').slice(0, 30),
        });
        close();
        return false;
      }
      if (!manualSelection && model.selectedKey) selectedKey = model.selectedKey;
      const compact = isCompact();
      if (!compact) compactDetail = false;
      const nextSignature = signature(model, compact);
      if (!options.force && nextSignature === lastSignature) {
        syncLayoutClass(compact);
        return false;
      }
      lastSignature = nextSignature;
      inspector.innerHTML = viewUtils.renderInspector?.(model, { compact, compactDetail }) || '';
      inspector.hidden = false;
      inspector.setAttribute('aria-hidden', 'false');
      syncLayoutClass(compact);
      syncOriginExpanded(true);
      scheduleElapsedTick();
      return true;
    }

    function open(key, trigger) {
      if (disposed || !inspector) return false;
      const nextKey = String(key || '').trim();
      if (!nextKey) return false;
      openKey = nextKey;
      selectedKey = '';
      manualSelection = false;
      compactDetail = false;
      origin = trigger && typeof trigger.focus === 'function' ? trigger : null;
      inspector.hidden = false;
      inspector.setAttribute('aria-hidden', 'false');
      installResizeObserver();
      render({ force: true });
      const target = inspector.querySelector?.('[data-subagent-select][tabindex="0"]')
        || inspector.querySelector?.('[data-subagent-close]');
      target?.focus?.();
      return true;
    }

    function close(options = {}) {
      if (!inspector) return false;
      const restore = options.restoreFocus !== false ? origin : null;
      openKey = '';
      selectedKey = '';
      manualSelection = false;
      compactDetail = false;
      lastSignature = '';
      inspector.hidden = true;
      inspector.setAttribute('aria-hidden', 'true');
      inspector.innerHTML = '';
      chatView?.classList?.remove('subagent-monitor-open', 'subagent-monitor-compact');
      inspector.parentElement?.classList?.remove('subagent-monitor-stage-open', 'subagent-monitor-stage-compact');
      syncOriginExpanded(false);
      uninstallResizeObserver();
      clearElapsedTick();
      origin = null;
      restore?.focus?.();
      return true;
    }

    function select(key, focusAfter = true) {
      const nextKey = String(key || '').trim();
      if (!nextKey) return false;
      selectedKey = nextKey;
      manualSelection = true;
      compactDetail = isCompact();
      render({ force: true });
      if (focusAfter) {
        const selector = compactDetail ? '[data-subagent-back]' : `[data-subagent-select="${cssEscape(nextKey)}"]`;
        inspector?.querySelector?.(selector)?.focus?.();
      }
      return true;
    }

    function back() {
      if (!isCompact()) return false;
      if (compactDetail) {
        compactDetail = false;
        render({ force: true });
        inspector?.querySelector?.(`[data-subagent-select="${cssEscape(selectedKey)}"]`)?.focus?.();
        return true;
      }
      return close();
    }

    function syncOriginExpanded(expanded) {
      if (origin?.setAttribute) origin.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      for (const trigger of documentRef?.querySelectorAll?.('[data-subagent-open]') || []) {
        const matches = String(trigger.getAttribute('data-subagent-open') || '') === openKey;
        trigger.setAttribute('aria-expanded', expanded && matches ? 'true' : 'false');
      }
    }

    function reconcile() {
      if (disposed) return false;
      syncOriginExpanded(Boolean(openKey));
      const changed = openKey ? render() : false;
      scheduleElapsedTick();
      return changed;
    }

    function handleClick(event) {
      const openTrigger = event.target?.closest?.('[data-subagent-open]');
      if (openTrigger) {
        event.preventDefault();
        open(openTrigger.getAttribute('data-subagent-open'), openTrigger);
        return;
      }
      if (!inspector?.contains?.(event.target)) return;
      const selectTrigger = event.target.closest?.('[data-subagent-select]');
      if (selectTrigger) {
        event.preventDefault();
        select(selectTrigger.getAttribute('data-subagent-select'));
        return;
      }
      if (event.target.closest?.('[data-subagent-close]')) {
        event.preventDefault();
        close();
        return;
      }
      if (event.target.closest?.('[data-subagent-back]')) {
        event.preventDefault();
        back();
      }
    }

    function handleKeydown(event) {
      if (!openKey) return;
      if (event.key === 'Escape' && inspector?.contains?.(event.target)) {
        event.preventDefault();
        close();
        return;
      }
      const item = event.target?.closest?.('[data-subagent-select]');
      if (!item || !inspector?.contains?.(item)) return;
      const items = [...inspector.querySelectorAll('[data-subagent-select]')];
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
      if (event.key === 'ArrowLeft' && isCompact()) {
        event.preventDefault();
        back();
        return;
      }
      if (target) {
        event.preventDefault();
        items.forEach((entry) => entry.setAttribute('tabindex', entry === target ? '0' : '-1'));
        target.focus();
      }
    }

    function refreshElapsed() {
      elapsedTimer = null;
      if (disposed || documentRef?.hidden) return;
      let hasActive = false;
      for (const trigger of documentRef?.querySelectorAll?.('[data-subagent-open]') || []) {
        const key = trigger.getAttribute('data-subagent-open');
        const model = modelUtils.buildMonitorFromMessages?.(currentMessages(), key, '', Date.now());
        if (!model || model.terminal) continue;
        hasActive = true;
        const elapsed = modelUtils.formatElapsed?.(model.elapsedMs) || '';
        trigger.querySelector?.('[data-subagent-elapsed]')?.replaceChildren?.(elapsed);
        if (key === openKey) {
          inspector?.querySelector?.('[data-subagent-live-elapsed]')?.replaceChildren?.(elapsed);
        }
      }
      if (hasActive) scheduleElapsedTick();
    }

    function scheduleElapsedTick() {
      if (disposed || elapsedTimer || documentRef?.hidden) return;
      const hasActive = [...(documentRef?.querySelectorAll?.('[data-subagent-open]') || [])]
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

    function installResizeObserver() {
      if (resizeObserver || typeof windowRef.ResizeObserver !== 'function' || !chatView) return;
      resizeObserver = new windowRef.ResizeObserver(() => render({ force: true }));
      resizeObserver.observe(chatView);
    }

    function uninstallResizeObserver() {
      resizeObserver?.disconnect?.();
      resizeObserver = null;
    }

    function cssEscape(value) {
      if (windowRef.CSS?.escape) return windowRef.CSS.escape(String(value || ''));
      return String(value || '').replace(/["\\]/g, '\\$&');
    }

    function bind() {
      if (!documentRef || disposed) return;
      documentRef.addEventListener('click', handleClick);
      documentRef.addEventListener('keydown', handleKeydown);
      documentRef.addEventListener('visibilitychange', handleVisibilityChange);
      reconcile();
    }

    function dispose() {
      if (disposed) return;
      close({ restoreFocus: false });
      disposed = true;
      documentRef?.removeEventListener?.('click', handleClick);
      documentRef?.removeEventListener?.('keydown', handleKeydown);
      documentRef?.removeEventListener?.('visibilitychange', handleVisibilityChange);
      uninstallResizeObserver();
      clearElapsedTick();
    }

    return { bind, close, dispose, open, reconcile, render, select, _internals: { isCompact } };
  }

  return { WIDE_MIN_WIDTH, createSubagentMonitorController };
});
