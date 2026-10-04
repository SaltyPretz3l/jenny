(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); return; }
  root.rendererDiagnosticsEventBindings = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  // Tab order; Runs joined on 2026-10-03 (moved from Settings).
  var TABS = ['overview', 'activity', 'runs'];

  function createLogsEventBindings(options) {
    var state = options.state;
    var viewStateUtils = globalThis.rendererDiagnosticsViewState
      || (typeof require === 'function' ? require('./renderer-diagnostics-view-state') : null);
    var asyncFenceUtils = globalThis.rendererAsyncFence
      || (typeof require === 'function' ? require('../shared/async-fence') : null);
    var disposalFence = asyncFenceUtils.createDisposalFence();
    var cleanups = [];
    var focusFrame = null;
    var narrowActivityQuery = typeof window.matchMedia === 'function'
      ? window.matchMedia('(max-width: 620px)')
      : null;

    function listen(node, type, listener, listenerOptions) {
      if (!node?.addEventListener) return;
      node.addEventListener(type, listener, listenerOptions);
      cleanups.push(function () { node.removeEventListener(type, listener, listenerOptions); });
    }

    function view() {
      return viewStateUtils.ensureDiagnosticsViewState(state);
    }

    function renderLogs() {
      var current = view();
      [['logSearchInput', current.query], ['logLevelFilter', current.levelFilter], ['logSourceFilter', current.sourceFilter]].forEach(function (pair) {
        var control = document.getElementById(pair[0]);
        if (control) control.value = pair[1];
      });
      options.callbacks.renderLogs();
    }

    function cancelScheduledFocus() {
      if (focusFrame == null) return;
      if (typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(focusFrame);
      else clearTimeout(focusFrame);
      focusFrame = null;
    }

    function afterRender(callback) {
      cancelScheduledFocus();
      var schedule = typeof window.requestAnimationFrame === 'function'
        ? window.requestAnimationFrame.bind(window)
        : function (fn) { return setTimeout(fn, 0); };
      focusFrame = schedule(function () {
        focusFrame = null;
        callback();
      });
    }

    function findRow(id) {
      return Array.from(options.dom.logList?.querySelectorAll?.('[data-entry-id]') || []).find(function (row) {
        return row.dataset.entryId === id;
      }) || null;
    }

    function focusRow(id) {
      if (!id) return false;
      options.callbacks.ensureLogRowMounted?.(id);
      var row = findRow(id);
      if (!row) return false;
      Array.from(options.dom.logList.querySelectorAll('[data-entry-id][tabindex="0"]')).forEach(function (candidate) {
        if (candidate !== row) candidate.tabIndex = -1;
      });
      row.tabIndex = 0;
      row.focus?.();
      return true;
    }

    function closeDetail() {
      var selectedId = view().selectedEntryId;
      if (!selectedId) return;
      view().selectedEntryId = '';
      renderLogs();
      afterRender(function () { focusRow(selectedId); });
    }

    function focusActivityStart() {
      var first = options.dom.logList?.querySelector?.('[data-entry-id]');
      if (first) {
        focusRow(first.dataset.entryId || '');
        return;
      }
      document.getElementById('logSearchInput')?.focus?.();
    }

    function isNarrowActivity() {
      return narrowActivityQuery?.matches === true;
    }

    function bind(listenerOptions) {
      var tabs = document.getElementById('diagnosticsTabs');
      listen(tabs, 'click', function (event) {
        var button = event.target.closest('[data-tab]');
        if (!button) return;
        view().activeTab = TABS.includes(button.dataset.tab) ? button.dataset.tab : 'overview';
        renderLogs();
      }, listenerOptions);
      // Arrows move through the tabs and wrap at the ends; Home and End jump.
      listen(tabs, 'keydown', function (event) {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        var index = Math.max(0, TABS.indexOf(view().activeTab));
        view().activeTab = event.key === 'Home'
          ? TABS[0]
          : event.key === 'End'
            ? TABS[TABS.length - 1]
            : TABS[(index + (event.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length];
        renderLogs();
      }, listenerOptions);

      var run = document.getElementById('diagnosticsRunSelect');
      listen(run, 'change', function () {
        view().selectedRunId = String(run.value || '');
        view().selectedEntryId = '';
        view().issueScope = null;
        // A remembered focus origin belongs to the old run; never switch back to it.
        view().returnState = null;
        renderLogs();
      }, listenerOptions);

      var root = document.getElementById('logsView');
      listen(root, 'click', function (event) {
        var close = event.target.closest('[data-action="close-log-detail"]');
        if (close) { closeDetail(); return; }

        var clearScope = event.target.closest('[data-action="clear-diagnostics-scope"]');
        if (clearScope) {
          var current = view();
          // Restore the filters the focus link replaced, but stay in Activity where Clear scope lives.
          if (current.returnState) Object.assign(current, current.returnState, { returnState: null, activeTab: current.activeTab });
          else current.issueScope = null;
          renderLogs();
          afterRender(function () { document.getElementById('logSearchInput')?.focus?.(); });
          return;
        }

        var inspect = event.target.closest('[data-action="inspect-diagnostic-issue"]');
        if (inspect) {
          var decoded;
          try { decoded = decodeURIComponent(inspect.dataset.issue || ''); } catch (_error) { return; }
          var parts = decoded.split('\u0000');
          viewStateUtils.focusDiagnosticsTarget(state, { tab: 'activity', issueScope: {
            component: parts[0] || '',
            event: parts[1] || '',
            error_code: parts[2] || '',
          } });
          renderLogs();
          afterRender(focusActivityStart);
          return;
        }

        var row = event.target.closest('[data-entry-id]');
        if (row) {
          view().selectedEntryId = row.dataset.entryId || '';
          view().autoScroll = false;
          renderLogs();
          if (isNarrowActivity()) {
            afterRender(function () { document.getElementById('diagnosticsCloseDetail')?.focus?.(); });
          }
          return;
        }

        var reset = event.target.closest('#phasePercentilesResetButton');
        if (!reset) return;
        reset.disabled = true;
        Promise.resolve(options.callbacks.resetPhasePercentiles?.({ render: false }))
          .then(disposalFence.guard(function () {
            return options.callbacks.refreshPhasePercentiles?.({ render: false });
          }))
          .then(disposalFence.guard(renderLogs))
          .catch(disposalFence.guard(function () { renderLogs(); return null; }))
          .finally(disposalFence.guard(function () { reset.disabled = false; }));
      }, listenerOptions);

      listen(root, 'keydown', function (event) {
        if (event.key !== 'Escape' || !view().selectedEntryId) return;
        event.preventDefault();
        closeDetail();
      }, listenerOptions);

      listen(narrowActivityQuery, 'change', function (event) {
        if (!event.matches || !view().selectedEntryId) return;
        if (!document.activeElement?.closest?.('[data-entry-id]')) return;
        afterRender(function () { document.getElementById('diagnosticsCloseDetail')?.focus?.(); });
      }, listenerOptions);

      listen(options.dom.logList, 'scroll', function () {
        var list = options.dom.logList;
        var distance = list.scrollHeight - list.clientHeight - list.scrollTop;
        if (distance > 48 && view().autoScroll) {
          view().autoScroll = false;
          document.getElementById('logAutoScrollToggle')?.setAttribute('aria-pressed', 'false');
        }
      }, { passive: true });

      listen(options.dom.logList, 'keydown', function (event) {
        var row = event.target.closest?.('[data-entry-id]');
        if (!row) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          row.click();
          return;
        }
        if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
        var rows = Array.from(options.dom.logList.querySelectorAll('[data-entry-id]'));
        var index = rows.indexOf(row);
        var next = event.key === 'Home'
          ? rows[0]
          : event.key === 'End'
            ? rows[rows.length - 1]
            : rows[index + (event.key === 'ArrowDown' ? 1 : -1)];
        if (!next) return;
        event.preventDefault();
        focusRow(next.dataset.entryId || '');
      }, listenerOptions);

      /* A manual filter edit supersedes the state a focus link remembered. */
      var search = document.getElementById('logSearchInput');
      listen(search, 'input', function () {
        view().query = String(search.value || '');
        view().returnState = null;
        renderLogs();
      }, listenerOptions);
      var level = document.getElementById('logLevelFilter');
      listen(level, 'change', function () {
        view().levelFilter = String(level.value || 'all');
        view().returnState = null;
        renderLogs();
      }, listenerOptions);
      var source = document.getElementById('logSourceFilter');
      listen(source, 'change', function () {
        view().sourceFilter = String(source.value || 'all');
        view().returnState = null;
        renderLogs();
      }, listenerOptions);

      /* Cross-view deep link (chat error-code chip -> this Activity tab).
       * The shell runtime controller owns the navigation state (tab, run,
       * filters, selection) because it resolves the entry from state.logs;
       * row focus lives here, where focusRow/ensureLogRowMounted already do.
       * A window event keeps that seam free of new composition plumbing. */
      listen(window, 'diagnostics:focus-log-entry', function (event) {
        if (!event || !event.detail) return;
        var entryId = String(event.detail.entryId || '').trim();
        var current = view();
        current.activeTab = 'activity';
        if (entryId) {
          current.selectedEntryId = entryId;
          current.autoScroll = false;
        }
        /* Repaint even without a target: the view may already have been on
         * Logs, in which case the tab flip alone paints nothing. */
        renderLogs();
        if (entryId) afterRender(function () { focusRow(entryId); });
      }, listenerOptions);

      var follow = document.getElementById('logAutoScrollToggle');
      listen(follow, 'click', function () {
        view().autoScroll = !view().autoScroll;
        view().selectedEntryId = '';
        follow.setAttribute('aria-pressed', String(view().autoScroll));
        follow.classList.toggle('active', view().autoScroll);
        renderLogs();
        if (view().autoScroll) {
          afterRender(function () { options.callbacks.scrollLogsToBottom?.(options.dom.logList); });
        }
      }, listenerOptions);
    }

    function dispose() {
      if (!disposalFence.dispose()) return;
      cancelScheduledFocus();
      while (cleanups.length) {
        try { cleanups.pop()(); } catch (_error) { /* best-effort cleanup */ }
      }
    }

    return { bind: bind, dispose: dispose };
  }

  return Object.freeze({ createLogsEventBindings: createLogsEventBindings });
});
