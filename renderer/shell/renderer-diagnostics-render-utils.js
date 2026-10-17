(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./renderer-diagnostics-page'),
      require('./renderer-diagnostics-format'),
      require('../shared/diagnostics-issue-utils'),
      require('./renderer-log-list-virtualizer'),
      require('../inventory/action-button'),
      require('./renderer-diagnostics-overview'),
      require('./renderer-diagnostics-activity'),
      require('../inventory/empty-note'),
      function () { return require('./renderer-diagnostics-view-state'); }
    );
    return;
  }
  root.rendererDiagnosticsRenderUtils = factory(
    root.rendererDiagnosticsPage,
    root.rendererDiagnosticsFormat,
    root.diagnosticsIssueUtils || {},
    root.rendererLogListVirtualizer || {},
    root.inventoryActionButton,
    root.rendererDiagnosticsOverview,
    root.rendererDiagnosticsActivity,
    root.inventoryEmptyNote,
    // View state loads after this module; its tab list is read at paint time.
    function () { return root.rendererDiagnosticsViewState; }
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (
  page,
  format,
  issueUtils,
  virtualizerUtils,
  actionButton,
  overviewView,
  activityView,
  emptyNote,
  getViewState
) {
  'use strict';
  // The Diagnostics page frame: tabs, the launch picker, the Runs seam and the paint loop. The
  // Overview, runtime facts and Activity markup live in their own modules.
  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  var escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;
  var diagnosticsState = page.diagnosticsState;
  var selectedRunId = page.selectedRunId;
  var scrollLogsToBottom = activityView.scrollLogsToBottom;

  function selectedEntries(state) {
    var runId = selectedRunId(state);
    var entries = Array.isArray(state.logs) ? state.logs : [];
    var activeRunId = page.activeRunId(state);
    return entries.filter(function (entry) {
      var entryRunId = String(entry.run_id || activeRunId);
      return !runId || entryRunId === runId;
    }).sort(issueUtils.compareEntriesChronologically || function () { return 0; });
  }

  // "This launch · since 09:12" and "Previous launch · Oct 13, 18:40": a launch is named by when it
  // started (formatMoment drops the date on the same day). Prior history from before launch ids says so.
  function runLabel(run, isPrior) {
    var time = format.parsedDate(run && run.started_at) ? format.formatMoment(run.started_at) : '';
    if (isPrior) {
      return run.legacy
        ? jt('diagnostics.run.previousLaunchLegacy', 'Previous launch · legacy history')
        : time ? jt('diagnostics.run.previousLaunchAt', 'Previous launch · {time}', { time: time }) : jt('diagnostics.run.previousLaunchShort', 'Previous launch');
    }
    return time ? jt('diagnostics.run.thisLaunchSince', 'This launch · since {time}', { time: time }) : jt('diagnostics.run.thisLaunchShort', 'This launch');
  }

  function runOption(run, isPrior) {
    if (!run) return '';
    return '<option value="' + escapeHtml(run.run_id) + '">' + escapeHtml(runLabel(run, isPrior)) + '</option>';
  }

  // Before the first snapshot the picker keeps its one "This launch" option instead of going empty.
  function renderRunSelector(state) {
    var select = document.getElementById('diagnosticsRunSelect');
    if (!select) return;
    var snapshot = state.diagnosticsSnapshot || {};
    var markup = snapshot.active_run
      ? runOption(snapshot.active_run, false) + runOption(snapshot.prior_run, true)
      : '<option value="">' + escapeHtml(runLabel(null, false)) + '</option>';
    if (select.dataset.optionsSignature !== markup) {
      select.innerHTML = markup;
      select.dataset.optionsSignature = markup;
    }
    select.value = selectedRunId(state);
  }

  function renderTabs(state) {
    var slot = document.getElementById('diagnosticsTabs');
    if (!slot || typeof actionButton !== 'function') return;
    var tabs = getViewState().TABS;
    var active = diagnosticsState(state).activeTab;
    if (slot.dataset.activeTab === active && slot.childElementCount === tabs.length) return;
    var restoreFocus = Boolean(document.activeElement?.closest?.('#diagnosticsTabs [data-tab]'));
    slot.innerHTML = tabs.map(function (tab) {
      var name = tab[0].toUpperCase() + tab.slice(1);
      return actionButton({
        id: 'diagnostics-tab',
        domId: 'diagnostics' + name + 'Tab',
        label: tab === 'runs' ? jt('diagnostics.tabs.runs', 'Runs') : tab === 'activity' ? jt('diagnostics.tabs.activity', 'Activity') : jt('diagnostics.tabs.overview', 'Overview'),
        variant: 'ghost',
        size: 'sm',
        role: 'tab',
        ariaSelected: active === tab,
        ariaControls: 'diagnostics' + name,
        tabIndex: active === tab ? 0 : -1,
        dataset: { tab: tab },
        className: 'diagnostics-tab',
      });
    }).join('');
    slot.dataset.activeTab = active;
    if (restoreFocus) slot.querySelector('[data-tab="' + active + '"]')?.focus?.();
  }

  // Runs (owner, 2026-10-03; moved from Settings). The board belongs to the
  // shared runtime console, which the settings section binders publish (one
  // poller with Settings › Limits & budgets). Each paint of this tab attaches
  // it on first show and wakes it after; the console polls only while
  // Diagnostics shows this tab.
  function showRunsBoard(loadSeam, failed) {
    var host = document.getElementById('diagnosticsRunsMount');
    if (!host) return false;
    var seam = globalThis.rendererRuntimeConsole;
    if (seam && typeof seam.showRuns === 'function') {
      paintRunsState(host, '');
      seam.showRuns(host);
      return true;
    }
    // The seam ships with the Settings page group, which loads on first use
    // (row 32 W2): ask for the page once, and the caller paints again after.
    // Until then the tab says what is happening instead of staying blank.
    paintRunsState(host, failed ? 'failed' : 'loading');
    if (!failed && typeof loadSeam === 'function') loadSeam();
    return false;
  }

  function paintRunsState(mount, runsState) {
    var host = document.getElementById('diagnosticsRunsState');
    mount.hidden = Boolean(runsState);
    if (!host) return;
    // A note that held focus (after Try again) hands it to the Runs tab when the board replaces it.
    var handFocus = !runsState && !host.hidden && host.contains(document.activeElement);
    host.hidden = !runsState;
    if (handFocus) document.querySelector('#diagnosticsTabs [data-tab="runs"]')?.focus?.();
    var markup = runsState === 'loading'
      ? emptyNote({ text: jt('diagnostics.runs.loading', 'Loading runs…'), role: 'status' })
      : runsState === 'failed'
        ? emptyNote({ text: jt('diagnostics.runs.failed', 'Runs couldn’t load.'), role: 'status' })
          + actionButton({ id: 'diagnostics-retry-runs', label: jt('diagnostics.runs.retry', 'Try again'), variant: 'secondary', size: 'sm', dataset: { 'runs-retry': 'true' } })
        : '';
    page.paintMarkup(host, markup);
  }

  function createLogRenderer(options) {
    var state = options.state;
    var list = options.dom && options.dom.logList;
    var virtualizer = virtualizerUtils.createLogListVirtualizer?.({
      logList: list,
      scrollContainer: list,
      document: document,
      window: window,
    });
    var activityCache = {
      signature: '',
      filterAnnouncementSignature: '',
      ids: [],
      selectedEntryId: '',
    };
    var frame = null;

    function paint() {
      frame = null;
      if (state.ui.activeView !== 'logs') return;
      var view = diagnosticsState(state);
      var entries = selectedEntries(state);
      renderTabs(state);
      renderRunSelector(state);
      var overview = document.getElementById('diagnosticsOverview');
      var activity = document.getElementById('diagnosticsActivity');
      var runs = document.getElementById('diagnosticsRuns');
      if (overview) overview.hidden = view.activeTab !== 'overview';
      if (activity) activity.hidden = view.activeTab !== 'activity';
      if (runs) runs.hidden = view.activeTab !== 'runs';
      // The evidence window and report speak of an app run; on the Runs tab
      // ("work runs") they would read as part of the board, so they step away.
      var headerActions = document.querySelector('#logsMasthead .diagnostics-header-actions');
      if (headerActions) headerActions.hidden = view.activeTab === 'runs';
      if (view.activeTab === 'overview') overviewView.renderOverview(state, entries);
      else if (view.activeTab === 'activity') activityView.renderActivity(state, entries, virtualizer, activityCache);
      else if (!showRunsBoard(loadRunsSeam, runsSeamFailed)) return;
      if (view.activeTab !== 'runs') runsSeamFailed = false;
      activityView.renderDetail(state, entries);
    }

    var runsSeamLoad = null;
    var runsSeamFailed = false;
    function loadRunsSeam() {
      var ensureSettingsPage = options.callbacks && options.callbacks.ensureSettingsPage;
      if (runsSeamLoad || runsSeamFailed || typeof ensureSettingsPage !== 'function') return;
      runsSeamLoad = Promise.resolve(ensureSettingsPage()).then(function (page) {
        runsSeamLoad = null;
        var seam = globalThis.rendererRuntimeConsole;
        // A failed load (or a page without the seam) paints its failure once and waits for Try again or
        // the next visit of the tab; the failed paint does not load again, so there is no repaint loop.
        if (!page || !seam || typeof seam.showRuns !== 'function') { runsSeamFailed = true; renderLogs(); return; }
        if (diagnosticsState(state).activeTab === 'runs') renderLogs();
      }, function () { runsSeamLoad = null; runsSeamFailed = true; renderLogs(); });
    }

    // Try again after a failed load: the retry control is replaced by the loading note, so focus moves
    // to the note that replaced it.
    var runsPanel = document.getElementById('diagnosticsRuns');
    function onRunsClick(event) {
      if (!event.target?.closest?.('[data-runs-retry]')) return;
      runsSeamFailed = false;
      var note = document.getElementById('diagnosticsRunsState');
      if (note) { note.tabIndex = -1; note.focus({ preventScroll: true }); }
      renderLogs();
    }
    runsPanel?.addEventListener('click', onRunsClick);

    function renderLogs() {
      if (state.ui.activeView !== 'logs' || frame != null) return;
      frame = (window.requestAnimationFrame || function (callback) { return setTimeout(callback, 0); })(paint);
    }

    function dispose() {
      if (frame != null) (window.cancelAnimationFrame || clearTimeout)(frame);
      frame = null;
      activityCache.ids = [];
      virtualizer?.dispose?.();
      runsPanel?.removeEventListener('click', onRunsClick);
    }

    return {
      renderLogs: renderLogs,
      dispose: dispose,
      ensureLogRowMounted: function (id) { return virtualizer?.ensureMountedForId?.(id) || false; },
    };
  }

  return Object.freeze({
    createLogRenderer: createLogRenderer,
    scrollLogsToBottom: scrollLogsToBottom,
    selectedEntries: selectedEntries,
  });
});
