(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererCalendarChatBindings = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };


  const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
  const boundContainers = new Set();
  let liveJournalIds = null;
  let journalUnsubscribe = null;
  let firstBindComplete = false;
  let journalGeneration = 0;

  function hasLiveJournalEntry(id) {
    return liveJournalIds === null || liveJournalIds.has(String(id));
  }

  function syncUndoVisibility(container) {
    container?.querySelectorAll?.('[data-cal-undo-journal]').forEach((element) => {
      element.hidden = !hasLiveJournalEntry(element.dataset.calUndoJournal);
      delete element.dataset.calUndoEvicted;
    });
  }

  function applyJournal(journal) {
    if (!Array.isArray(journal?.entries)) return;
    journalGeneration += 1;
    liveJournalIds = new Set(journal.entries
      .filter((entry) => typeof entry?.id === 'string'
        && entry.id.length > 0
        && !entry.undoneAt
        && !entry.supersededAt)
      .map((entry) => entry.id));
    boundContainers.forEach(syncUndoVisibility);
  }

  function markUndone(trigger) {
    const span = trigger.ownerDocument.createElement('span');
    span.className = 'cal-chat__undone';
    span.textContent = jt("ide.changes.undone", "Undone");
    liveJournalIds?.delete(String(trigger.dataset.calUndoJournal));
    trigger.replaceWith(span);
  }

  function resolveRuntime() {
    return globalThis.rendererDashboardCalendarRuntime
      || (typeof require === 'function'
        ? require('../features/renderer-dashboard-calendar-runtime')
        : {});
  }

  function initializeJournal(shell) {
    if (firstBindComplete) return;
    firstBindComplete = true;
    const home = shell?.home;
    const initialGeneration = journalGeneration;
    Promise.resolve(typeof home?.getAiJournal === 'function' ? home.getAiJournal() : null)
      .then((journal) => {
        if (journalGeneration === initialGeneration) applyJournal(journal);
      })
      .catch(() => {});
    if (typeof home?.onAiChanged === 'function') {
      const unsubscribe = home.onAiChanged((payload) => applyJournal(payload && payload.journal));
      journalUnsubscribe = typeof unsubscribe === 'function' ? unsubscribe : null;
    }
  }

  function bindCalendarChatInteractions(container, deps) {
    if (!container || typeof container.addEventListener !== 'function') return () => {};
    if (container.dataset.calendarChatBound === '1') return () => {};
    container.dataset.calendarChatBound = '1';
    const options = deps || {};
    const setActiveView = typeof options.setActiveView === 'function' ? options.setActiveView : () => {};
    const setHomeCalendarFocusDay = typeof options.setHomeCalendarFocusDay === 'function'
      ? options.setHomeCalendarFocusDay
      : () => {};
    const appendClientLog = typeof options.appendClientLog === 'function'
      ? options.appendClientLog
      : () => {};
    boundContainers.add(container);
    if (liveJournalIds !== null) syncUndoVisibility(container);
    initializeJournal(options.shell);
    const handleClick = (event) => {
      const undoTrigger = event.target?.closest?.('[data-cal-undo-journal]');
      if (undoTrigger) {
        const runtime = resolveRuntime();
        runtime.handleUndoJournalClick?.(event, {
          shell: options.shell,
          appendClientLog,
          setTimeoutImpl: options.setTimeoutImpl,
          onAiPayload: (payload) => applyJournal(payload && payload.journal),
          onApplied: () => markUndone(undoTrigger),
        });
        return;
      }
      const openDayTrigger = event.target?.closest?.('[data-cal-open-day]');
      if (openDayTrigger) {
        const key = openDayTrigger.dataset.calOpenDay;
        if (DATE_PATTERN.test(key)) {
          setHomeCalendarFocusDay(key);
          setActiveView('home');
        }
        return;
      }
    };
    container.addEventListener('click', handleClick);
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      container.removeEventListener('click', handleClick);
      delete container.dataset.calendarChatBound;
      boundContainers.delete(container);
      if (boundContainers.size === 0) {
        journalUnsubscribe?.();
        journalUnsubscribe = null;
        firstBindComplete = false;
      }
    };
  }

  function _resetForTests() {
    liveJournalIds = null;
    boundContainers.clear();
    journalUnsubscribe?.();
    journalUnsubscribe = null;
    firstBindComplete = false;
    journalGeneration = 0;
  }

  return {
    bindCalendarChatInteractions,
    hasLiveJournalEntry,
    syncUndoVisibility,
    applyJournal,
    _resetForTests,
  };
});
