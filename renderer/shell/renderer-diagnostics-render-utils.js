(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('../shared/diagnostics-issue-utils'),
      require('../shared/diagnostics-report-utils'),
      require('./renderer-log-list-virtualizer'),
      require('../inventory/action-button'),
      require('../inventory/codeblock'),
      require('../shared/log-contract-utils'),
      require('./renderer-phase-percentiles-utils'),
      require('./renderer-runtime-health-utils'),
      require('./renderer-diagnostics-performance-utils'),
      require('./renderer-diagnostics-issue-card')
    );
    return;
  }
  root.rendererDiagnosticsRenderUtils = factory(
    root.diagnosticsIssueUtils || {},
    root.diagnosticsReportUtils || {},
    root.rendererLogListVirtualizer || {},
    root.inventoryActionButton,
    root.inventoryCodeBlock || {},
    root.logContractUtils || {},
    root.rendererPhasePercentilesUtils || {},
    root.rendererRuntimeHealthUtils || {},
    root.rendererDiagnosticsPerformanceUtils || {},
    root.rendererDiagnosticsIssueCard || {}
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (
  issueUtils,
  reportUtils,
  virtualizerUtils,
  actionButton,
  codeBlock,
  logContractUtils,
  phaseUtils,
  runtimeHealthUtils,
  performanceUtils,
  issueCard
) {
  'use strict';
  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  var jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };
  var markupCache = new WeakMap();
  var SOURCE_NAMES = ['electron', 'renderer', 'sidecar'];
  var MAX_CORRELATION_CHARS = 160;
  var MAX_INVENTORY_VALUE_CHARS = 160;

  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;

  function paintMarkup(node, markup) {
    if (!node || markupCache.get(node) === markup) return false;
    node.innerHTML = markup;
    markupCache.set(node, markup);
    return true;
  }

  function diagnosticsState(state) {
    return globalThis.rendererDiagnosticsViewState?.ensureDiagnosticsViewState?.(state) || state.ui.logs;
  }

  function selectedRunId(state) {
    var view = diagnosticsState(state);
    var snapshot = state.diagnosticsSnapshot || {};
    return view.selectedRunId || snapshot.active_run?.run_id || '';
  }

  function selectedEntries(state) {
    var runId = selectedRunId(state);
    var entries = Array.isArray(state.logs) ? state.logs : [];
    var activeRunId = String(state.diagnosticsSnapshot?.active_run?.run_id || '');
    return entries.filter(function (entry) {
      var entryRunId = String(entry.run_id || activeRunId);
      return !runId || entryRunId === runId;
    }).sort(issueUtils.compareEntriesChronologically || function () { return 0; });
  }

  function filterEntries(state, entries) {
    var view = diagnosticsState(state);
    var query = String(view.query || '').trim().toLowerCase();
    return entries.filter(function (entry) {
      var level = String(entry.level || '').toLowerCase();
      var source = String(entry.layer || entry.source || '').toLowerCase();
      if (view.levelFilter !== 'all' && level !== view.levelFilter) return false;
      if (view.sourceFilter !== 'all' && source !== view.sourceFilter) return false;
      if (view.issueScope) {
        var code = issueUtils.errorCode ? issueUtils.errorCode(entry) : '';
        if (String(entry.component || '') !== view.issueScope.component
          || String(entry.event || '') !== view.issueScope.event
          || code !== view.issueScope.error_code) return false;
      }
      if (!query) return true;
      return [entry.event, entry.component, entry.message, source, entry.trace_id, entry.request_id, entry.session_id]
        .concat([entry.stream_id, entry.data?.streamId, entry.data?.stream_id].filter(function (value) { return typeof value === 'string'; }))
        .some(function (value) { return String(value || '').toLowerCase().includes(query); });
    });
  }

  function pad(value, width) {
    return String(value).padStart(width || 2, '0');
  }

  function parsedDate(value) {
    var date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  }

  function formatCompactTime(value, includeDate) {
    var date = parsedDate(value);
    if (!date) return String(value || jt('diagnostics.common.unknown', 'Unknown'));
    var time = pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
    if (!includeDate) return time + '.' + pad(date.getMilliseconds(), 3);
    return pad(date.getMonth() + 1) + '/' + pad(date.getDate()) + ' ' + time;
  }

  function formatDetailTime(value) {
    var date = parsedDate(value);
    if (!date) return String(value || jt('diagnostics.common.unknown', 'Unknown'));
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
      + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
      + '.' + pad(date.getMilliseconds(), 3);
  }

  function humanize(value, fallback) {
    var text = String(value || '').trim();
    if (!text) return fallback || jt('diagnostics.common.unknown', 'Unknown');
    return text.replace(/[._-]+/g, ' ').replace(/\b\w/g, function (letter) { return letter.toUpperCase(); });
  }

  function statusLabel(value) {
    var labels = {
      planner: jt('diagnostics.inventory.planner', 'Planner'),
      chat: jt('diagnostics.inventory.chat', 'Chat'),
      disabled: jt('diagnostics.inventory.off', 'Off'),
      enabled: jt('diagnostics.inventory.on', 'On'),
      idle: jt('diagnostics.inventory.idle', 'Idle'),
      running: jt('diagnostics.inventory.running', 'Running'),
      stopped: jt('diagnostics.inventory.stopped', 'Stopped'),
      failed: jt('diagnostics.inventory.failed', 'Failed'),
      ready: jt('diagnostics.overall.ready', 'Ready'),
      starting: jt('diagnostics.overall.starting', 'Starting'),
      acquiring: jt('diagnostics.overall.acquiring', 'Acquiring model'),
      loading: jt('diagnostics.overall.loading', 'Loading model'),
      unknown: jt('diagnostics.common.unknown', 'Unknown'),
      ok: jt('diagnostics.overall.ok', 'Healthy'),
      warn: jt('diagnostics.overall.warn', 'Warning'),
      error: jt('diagnostics.overall.error', 'Error'),
      pending: jt('diagnostics.overall.pending', 'Pending'),
      observed: jt('diagnostics.source.observed', 'Observed'),
      capturing: jt('diagnostics.source.capturing', 'Capturing'),
      waiting: jt('diagnostics.source.waiting', 'Waiting'),
      stream: jt('diagnostics.correlations.stream', 'Stream'),
      session: jt('diagnostics.correlations.session', 'Session'),
      trace: jt('diagnostics.correlations.trace', 'Trace'),
      request: jt('diagnostics.correlations.request', 'Request'),
      turn: jt('diagnostics.correlations.turn', 'Turn'),
    };
    return Object.prototype.hasOwnProperty.call(labels, value) ? labels[value] : humanize(value);
  }

  function displayMessage(message, eventName) {
    var text = String(message || '').trim();
    return text && text !== String(eventName || '').trim() ? text : '';
  }

  var formatNumber = performanceUtils.formatNumber;

  function safeCorrelationValue(value) {
    var text = String(value == null ? '' : value).trim();
    if (typeof logContractUtils.redactLogText === 'function') {
      text = logContractUtils.redactLogText(text);
    }
    return text.length > MAX_CORRELATION_CHARS
      ? text.slice(0, MAX_CORRELATION_CHARS - 1) + '…'
      : text;
  }

  function announce(message, signature) {
    var node = document.getElementById('diagnosticsStatusAnnouncer');
    if (!node || node.dataset.signature === signature) return;
    node.dataset.signature = signature;
    node.textContent = message;
  }

  function runOption(run, label, isPrior) {
    if (!run) return '';
    var suffix = run.legacy
      ? jt('diagnostics.run.legacyHistory', ' · legacy history')
      : isPrior && run.started_at
        ? ' · ' + formatCompactTime(run.started_at, true)
        : '';
    return '<option value="' + escapeHtml(run.run_id) + '">' + escapeHtml(label + suffix) + '</option>';
  }

  function renderRunSelector(state) {
    var select = document.getElementById('diagnosticsRunSelect');
    if (!select) return;
    var snapshot = state.diagnosticsSnapshot || {};
    var markup = runOption(snapshot.active_run, jt('diagnostics.run.thisLaunch', 'This app launch')) + runOption(snapshot.prior_run, jt('diagnostics.run.previousLaunch', 'Previous app launch'), true);
    if (select.dataset.optionsSignature !== markup) {
      select.innerHTML = markup;
      select.dataset.optionsSignature = markup;
    }
    select.value = selectedRunId(state);
  }

  function renderTabs(state) {
    var slot = document.getElementById('diagnosticsTabs');
    if (!slot || typeof actionButton !== 'function') return;
    var active = diagnosticsState(state).activeTab;
    if (slot.dataset.activeTab === active && slot.childElementCount === 3) return;
    var restoreFocus = Boolean(document.activeElement?.closest?.('#diagnosticsTabs [data-tab]'));
    slot.innerHTML = ['overview', 'activity', 'runs'].map(function (tab) {
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

  // Live shell state wins over the diagnostics status fetched when the view opened, so the
  // headline, health pane and performance summary never disagree about the backend.
  function liveBackend(state) {
    var status = state.diagnosticsStatus || {};
    return state.backend?.phase ? state.backend : (status.backend || state.backend || {});
  }

  function overallState(state, issues, sourceEvidence, integrity) {
    var phase = phaseUtils.classifyBackendPhase(liveBackend(state).phase);
    var unavailable = phase === 'unavailable' || phase === 'model_unavailable';
    var sourceGap = phase === 'ready' && SOURCE_NAMES.some(function (name) {
      return sourceEvidence[name]?.state !== 'observed';
    });
    var tone = unavailable || issues.some(function (issue) { return issue.severity === 'ERROR'; })
      ? 'error'
      : issues.length || integrity.complete === false || sourceGap
        ? 'warn'
        : phase === 'ready'
          ? 'ok'
          : 'pending';
    var headline = phase === 'model_unavailable'
      ? jt('diagnostics.phases.modelUnavailable', 'Model unavailable')
      : unavailable
      ? jt('diagnostics.overall.runtimeUnavailable', 'Runtime unavailable')
      : tone === 'ok'
        ? jt('diagnostics.overall.ready', 'Ready')
        : tone === 'error'
          ? jt('diagnostics.overall.actionRequired', 'Action required')
          : tone === 'warn'
            ? integrity.complete === false
              ? jt('diagnostics.overall.partialEvidence', 'Partial evidence')
              : sourceGap
                ? jt('diagnostics.overall.degradedSourceCoverage', 'Degraded source coverage')
                : jt('diagnostics.overall.warningsDetected', 'Warnings detected')
            : phase === 'starting'
              ? jt('diagnostics.overall.starting', 'Starting')
              : statusLabel(phase);
    var summary = integrity.complete === false
      ? jt('diagnostics.partialEvidenceSummary', 'Some evidence is partial. Review Source integrity before drawing conclusions.')
      : sourceGap
        ? jt('diagnostics.missingExpectedSources', 'One or more expected sources have not been observed in this ready runtime.')
        : issues.length
          ? jtn('diagnostics.groupedIssuesNeedReview', issues.length, { count: issues.length }, '{count} grouped issue need review.', '{count} grouped issues need review.')
          : unavailable
            ? jt('diagnostics.runtimeUnavailableSummary', 'The runtime is not available. Inspect recent issues and Activity for the failure path.')
            : jt('diagnostics.noWarnOrErrorEventsLaunch', 'No warnings or errors in this app launch.');
    return { tone: tone, headline: headline, summary: summary };
  }

  function renderOverall(state, issues, sourceEvidence, integrity) {
    var overall = document.getElementById('diagnosticsOverall');
    if (!overall) return;
    var result = overallState(state, issues, sourceEvidence, integrity);
    overall.dataset.tone = result.tone;
    paintMarkup(overall,
      '<div class="diagnostics-overall-copy">'
      + '<span class="diagnostics-overall-state">' + escapeHtml(statusLabel(result.tone)) + '</span>'
      + '<div><strong>' + escapeHtml(result.headline) + '</strong><p>' + escapeHtml(result.summary) + '</p></div>'
      + '</div>'
      + '<span class="diagnostics-overall-count">' + escapeHtml(jtn('diagnostics.overall.issueCount', issues.length, { count: formatNumber(issues.length) }, '{count} issue', '{count} issues')) + '</span>');
    announce(result.headline + '. ' + result.summary, ['overview', result.tone, result.headline, issues.length].join('|'));
  }

  function sourceState(source) {
    return String(source.capture_state || source.state || 'waiting').toLowerCase();
  }

  function renderSources(sourceEvidence, integrity) {
    var sources = document.getElementById('diagnosticsSourceCoverage');
    if (!sources) return;
    var rows = SOURCE_NAMES.map(function (name) {
      var source = sourceEvidence[name] || {};
      var state = sourceState(source);
      var dropped = Number(source.dropped || 0);
      return '<tr data-state="' + escapeHtml(state) + '">'
        + '<th scope="row"><code>' + escapeHtml(name) + '</code></th>'
        + '<td>' + formatNumber(source.count) + '</td>'
        + '<td><span class="diagnostics-source-state">' + escapeHtml(statusLabel(state)) + '</span>'
        + (dropped ? '<span class="diagnostics-source-drop">' + escapeHtml(jt('diagnostics.source.droppedCount', '{count} dropped', { count: formatNumber(dropped) })) + '</span>' : '') + '</td>'
        + '<td><time datetime="' + escapeHtml(source.last_seen || '') + '" title="' + escapeHtml(source.last_seen || jt('diagnostics.source.noEventObserved', 'No event observed')) + '">'
        + escapeHtml(source.last_seen ? formatCompactTime(source.last_seen) : jt('diagnostics.source.notObserved', 'Not observed')) + '</time></td>'
        + '</tr>';
    }).join('');
    var reasons = Array.isArray(integrity.partial_reasons) ? integrity.partial_reasons : [];
    var integrityTone = integrity.complete === true ? 'complete' : 'partial';
    var integrityCopy = reasons.length
      ? reasons.map(function (reason) { return humanize(reason); }).join(' · ')
      : integrity.complete === true
        ? jt('diagnostics.source.noKnownGaps', 'No known gaps')
        : jt('diagnostics.source.completenessUnconfirmed', 'Evidence completeness has not been confirmed');
    paintMarkup(sources,
      '<div class="diagnostics-source-table-shell"><table class="diagnostics-source-table">'
      + '<caption class="sr-only">' + escapeHtml(jt('diagnostics.source.integrityCaption', 'Diagnostic source integrity')) + '</caption>'
      + '<thead><tr><th scope="col">' + escapeHtml(jt('diagnostics.source.source', 'Source')) + '</th><th scope="col">' + escapeHtml(jt('diagnostics.source.events', 'Events')) + '</th><th scope="col">' + escapeHtml(jt('diagnostics.source.capture', 'Capture')) + '</th><th scope="col">' + escapeHtml(jt('diagnostics.source.lastSeen', 'Last seen')) + '</th></tr></thead>'
      + '<tbody>' + rows + '</tbody></table></div>'
      + '<div class="diagnostics-integrity-summary" data-tone="' + integrityTone + '">'
      + '<div><span>' + escapeHtml(jt('diagnostics.source.integrity', 'Integrity')) + '</span><strong>' + escapeHtml(integrity.complete === true ? jt('diagnostics.source.complete', 'Complete') : jt('diagnostics.source.partial', 'Partial')) + '</strong></div>'
      + '<p>' + escapeHtml(integrityCopy) + '</p></div>');
  }

  function renderIssues(issues, entries) {
    var issueList = document.getElementById('diagnosticsIssueList');
    if (!issueList) return;
    if (!issues.length) {
      paintMarkup(issueList, '<div class="diagnostics-empty"><strong>' + escapeHtml(jt('diagnostics.issues.noneActionable', 'No actionable issues')) + '</strong><p>' + escapeHtml(jt('diagnostics.issues.noWarnOrErrorLaunch', 'This app launch has no warnings or errors.')) + '</p></div>');
      return;
    }
    // The card module owns the entry markup; folds open in the live DOM stay open across a repaint, the
    // markup memo holds content only (toggling a fold never forces one), and a repaint for new content
    // gives focus back to the control that had it.
    var openGroups = issueCard.openGroupsIn(issueList);
    var focused = issueCard.focusedControlIn(issueList);
    var painted = paintMarkup(issueList, issueCard.renderIssueList(issues, {
      availableActions: globalThis.rendererDiagnosticsActions,
      entries: entries,
      formatDetailTime: formatDetailTime,
      safeCorrelationValue: safeCorrelationValue,
      statusLabel: statusLabel,
    }));
    if (painted) {
      issueCard.restoreOpenGroups(issueList, openGroups);
      issueCard.restoreFocus(issueList, focused);
    }
  }

  function renderHealth(state) {
    var status = state.diagnosticsStatus || {};
    var runtimeHealthState = {
      // The diagnostics snapshot only fills runtime fields the live state lacks.
      backend: liveBackend(state),
      status: Object.assign({}, status.runtime, state.status),
      modelList: state.modelList,
      offline: state.offline || {},
    };
    phaseUtils.renderPhasePercentilesPane?.({
      phasePercentilesState: state.phasePercentiles,
      runtimeHealthState: runtimeHealthState,
      harnessSnapshot: state.harness?.snapshot || null,
      deriveRuntimeHealthState: runtimeHealthUtils.deriveRuntimeHealthState,
      dom: {
        diagnosticsBadge: document.getElementById('diagnosticsBadge'),
        diagnosticsSummary: document.getElementById('diagnosticsSummary'),
        diagnosticsStatus: document.getElementById('diagnosticsStatus'),
        phasePercentilesTable: document.getElementById('phasePercentilesTable'),
        phasePercentilesResetButton: document.getElementById('phasePercentilesResetButton'),
      },
      escapeHtml: escapeHtml,
    });
    var summary = document.getElementById('diagnosticsSummary');
    if (summary && selectedRunId(state) && selectedRunId(state) !== String(state.diagnosticsSnapshot?.active_run?.run_id || '')) {
      summary.insertAdjacentHTML('beforeend', '<p class="settings-note diagnostics-muted">'
        + escapeHtml(jt('diagnostics.health.currentLaunchScope', 'Health shows the current app launch, not the one picked above.')) + '</p>');
    }
    performanceUtils.renderPerformanceSummary(status, runtimeHealthState, paintMarkup);
  }

  function isAvailableFacet(value) {
    return Boolean(value)
      && typeof value === 'object'
      && !Array.isArray(value)
      && !String(value.error || '').trim();
  }

  function unavailableFacet(label) {
    return [label, jt('diagnostics.common.unavailable', 'Unavailable'), 'warn'];
  }

  // isAvailableFacet reads a top-level `error` key as "this harness section
  // failed to build". Electron-side payloads carry `error` as real data
  // (scheduler lifecycle), so they get a plain-record check instead.
  function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function clampInventoryValue(value) {
    var text = String(value == null ? '' : value).trim();
    return text.length > MAX_INVENTORY_VALUE_CHARS
      ? text.slice(0, MAX_INVENTORY_VALUE_CHARS - 1) + '…'
      : text;
  }

  // Rows are [label, value, tone, mono?, title?]. Tone is carried by the value colour
  // only (see .diagnostics-inventory-list [data-tone] in diagnostics-health.css);
  // titles retain full values or technical identifiers behind product labels.
  function inventoryRow(item, groupStart) {
    var value = String(item[1] == null ? '' : item[1]).trim() || jt('diagnostics.common.unavailable', 'Unavailable');
    return '<div data-tone="' + escapeHtml(item[2] || 'warn') + '"'
      + (groupStart ? ' data-group-start="true"' : '')
      + (item[3] ? ' data-mono="true"' : '') + '>'
      + '<dt>' + escapeHtml(item[0]) + '</dt>'
      + '<dd title="' + escapeHtml(item[4] || value) + '">' + escapeHtml(clampInventoryValue(value)) + '</dd></div>';
  }

  function toolsFacetRow(facet) {
    if (!facet) return unavailableFacet(jt('diagnostics.inventory.tools', 'Tools'));
    var counts = isAvailableFacet(facet.counts) ? facet.counts : null;
    var items = Array.isArray(facet.items) ? facet.items : null;
    var enabled = counts && Number.isFinite(Number(counts.enabled))
      ? Number(counts.enabled)
      : items
        ? items.filter(function (tool) { return tool && tool.enabled !== false; }).length
        : null;
    if (enabled == null) return unavailableFacet(jt('diagnostics.inventory.tools', 'Tools'));
    var disabled = counts && Number.isFinite(Number(counts.disabled))
      ? Number(counts.disabled)
      : items ? Math.max(items.length - enabled, 0) : 0;
    return [
      jt('diagnostics.inventory.tools', 'Tools'),
      jt('diagnostics.inventory.enabledCount', '{count} enabled', { count: formatNumber(enabled) }) + (disabled > 0 ? ' \u00b7 ' + jt('diagnostics.inventory.disabledCount', '{count} disabled', { count: formatNumber(disabled) }) : ''),
      enabled > 0 ? 'ok' : 'warn',
    ];
  }

  function memoryFacetRow(facet) {
    if (!facet) return unavailableFacet(jt('diagnostics.inventory.memory', 'Memory'));
    var counts = isAvailableFacet(facet.counts) ? facet.counts : null;
    var approved = counts && Number.isFinite(Number(counts.approved))
      ? Number(counts.approved)
      : Array.isArray(facet.approved) ? facet.approved.length : null;
    var pending = counts && Number.isFinite(Number(counts.pending))
      ? Number(counts.pending)
      : Array.isArray(facet.pending) ? facet.pending.length : null;
    if (approved == null || pending == null || facet.status?.available === false) {
      return unavailableFacet(jt('diagnostics.inventory.memory', 'Memory'));
    }
    return [jt('diagnostics.inventory.memory', 'Memory'), jt('diagnostics.inventory.memoryCounts', '{approved} approved \u00b7 {pending} pending', { approved: formatNumber(approved), pending: formatNumber(pending) }), 'ok'];
  }

  function skillsFacetRow(facet) {
    if (!facet || !Array.isArray(facet.scopes)) return unavailableFacet(jt('diagnostics.inventory.skills', 'Skills'));
    var scopes = facet.scopes.slice(0, 6);
    var counts = isAvailableFacet(facet.counts) ? facet.counts : null;
    var total = counts && Number.isFinite(Number(counts.total))
      ? Number(counts.total)
      : Array.isArray(facet.items) ? facet.items.length : 0;
    var blocked = scopes.filter(function (scope) { return scope && scope.status === 'blocked'; }).length;
    var clauses = [];
    if (total > 0) clauses.push(jt('diagnostics.inventory.loadedCount', '{count} loaded', { count: formatNumber(total) }));
    clauses.push(jtn('diagnostics.inventory.scopeCount', scopes.length, { count: formatNumber(scopes.length) }, '{count} scope', '{count} scopes'));
    if (blocked) clauses.push(jt('diagnostics.inventory.blockedCount', '{count} blocked', { count: formatNumber(blocked) }));
    return [jt('diagnostics.inventory.skills', 'Skills'), clauses.join(' \u00b7 '), blocked ? 'warn' : 'ok'];
  }

  function workspaceFacetRow(facet) {
    if (!facet) return unavailableFacet(jt('diagnostics.inventory.workspace', 'Workspace'));
    var blockers = Array.isArray(facet.blockers) ? facet.blockers : [];
    if (!String(facet.root || '').trim()) return [jt('diagnostics.inventory.workspace', 'Workspace'), jt('diagnostics.inventory.notConfigured', 'Not configured'), 'warn'];
    if (facet.exists !== true) return [jt('diagnostics.inventory.workspace', 'Workspace'), jt('diagnostics.inventory.configuredRootUnavailable', 'Configured root unavailable'), 'warn'];
    if (blockers.length) {
      return [jt('diagnostics.inventory.workspace', 'Workspace'), jtn('diagnostics.inventory.availableWithBlockers', blockers.length, { count: blockers.length }, 'Available with {count} blocker', 'Available with {count} blockers'), 'warn'];
    }
    return [jt('diagnostics.inventory.workspace', 'Workspace'), jt('diagnostics.inventory.available', 'Available'), 'ok'];
  }

  // The shell facet is a tree of settings groups. Read values out of it -- never
  // fall back to listing its keys, which reads as configuration but names
  // nothing the owner actually set.
  function shellFacetRow(facet) {
    if (!facet) return unavailableFacet(jt('diagnostics.inventory.shell', 'Shell'));
    var clauses = [];
    var companion = String(facet.companion?.mode || '').trim();
    if (companion) clauses.push(statusLabel(companion));
    var offline = String(facet.offline?.mode || '').trim();
    if (offline) clauses.push(jt('diagnostics.inventory.offlineMode', 'Offline: {mode}', { mode: statusLabel(offline) }));
    var preferences = isAvailableFacet(facet.tools_preferences) ? facet.tools_preferences : null;
    var keys = preferences ? Object.keys(preferences) : [];
    if (keys.length) {
      var on = keys.filter(function (key) { return preferences[key] === true; }).length;
      clauses.push(jt('diagnostics.inventory.toolPreferencesOn', '{enabled} of {total} tool preferences on', { enabled: on, total: keys.length }));
    }
    return [jt('diagnostics.inventory.shell', 'Shell'), clauses.join(' \u00b7 ') || jt('diagnostics.inventory.configured', 'Configured'), 'ok', false, [companion && 'companion ' + companion, offline && 'offline ' + offline].filter(Boolean).join(' \u00b7 ')];
  }

  var loadFailureUtils = (typeof globalThis !== 'undefined' && globalThis.jennyModelLoadFailure)
    || (typeof require === 'function' ? require('../shared/model-load-failure') : null);

  // Row 38 item 1 (B): the Engine row says "failed to load" with the reason and
  // the last attempt while Electron's lifecycle carries a classified failure.
  function loadFailureRows(failure) {
    if (!failure || !loadFailureUtils) return [];
    var at = Date.parse(failure.at);
    var time = Number.isFinite(at) ? formatCompactTime(at, true) : '';
    var attempt = failure.context
      ? jt('diagnostics.inventory.attemptAt', '{time} · {context} context', { time: time, context: formatContextShort(failure.context) })
      : time;
    // causeSentence already quotes the message for `other`; the other causes add it.
    var reason = loadFailureUtils.causeSentence(failure)
      + (failure.message && failure.cause !== 'other' ? ' \u00b7 ' + failure.message : '');
    return [
      [jt('diagnostics.inventory.reason', 'Reason'), reason, 'danger', false, reason],
      [jt('diagnostics.inventory.lastAttempt', 'Last attempt'), attempt, 'muted', false, attempt],
    ];
  }

  function formatContextShort(value) {
    return value >= 1024 ? Math.round(value / 1024) + 'K' : String(value);
  }

  function inventoryActionsMarkup(failure) {
    if (!failure || typeof actionButton !== 'function') return '';
    var label = jt('diagnostics.inventory.retryLoad', 'Retry load');
    return '<div class="diagnostics-inventory-actions">' + actionButton({
      id: 'diagnostics-retry-load', label: label, title: label, variant: 'secondary', size: 'sm',
      dataset: { 'retry-model': failure.model, 'retry-engine': failure.engine || '' },
    }) + '</div>';
  }

  function boundedFacetItems(snapshot, failure) {
    var runtime = isAvailableFacet(snapshot?.runtime) ? snapshot.runtime : null;
    var failed = failure
      ? loadFailureUtils.engineLabel(failure.engine) + ' \u00b7 ' + failure.model + ' \u00b7 ' + jt('diagnostics.inventory.failedToLoad', 'failed to load') : '';
    return [
      failure
        ? [jt('diagnostics.inventory.engine', 'Engine'), failed, 'danger', true, failed]
        : runtime && runtime.active_engine && runtime.active_model
        ? [jt('diagnostics.inventory.engine', 'Engine'), runtime.active_engine + ' \u00b7 ' + runtime.active_model + ' \u00b7 '
          + statusLabel(runtime.active_mode || 'chat'), 'ok', true,
          runtime.active_engine + ' \u00b7 ' + runtime.active_model + ' \u00b7 ' + (runtime.active_mode || 'chat')]
        : unavailableFacet(jt('diagnostics.inventory.engine', 'Engine')),
    ].concat(loadFailureRows(failure), [
      toolsFacetRow(isAvailableFacet(snapshot?.tools) ? snapshot.tools : null),
      memoryFacetRow(isAvailableFacet(snapshot?.memories) ? snapshot.memories : null),
      skillsFacetRow(isAvailableFacet(snapshot?.skills) ? snapshot.skills : null),
      workspaceFacetRow(isAvailableFacet(snapshot?.workspace) ? snapshot.workspace : null),
      shellFacetRow(isAvailableFacet(snapshot?.shell) ? snapshot.shell : null),
    ]);
  }

  function schedulerRow(scheduler) {
    if (!isRecord(scheduler)) return unavailableFacet(jt('diagnostics.inventory.scheduler', 'Scheduler'));
    var lifecycle = isRecord(scheduler.lifecycle) ? scheduler.lifecycle : {};
    var phase = String(lifecycle.phase || 'unknown');
    var count = Number(lifecycle.qualifyingTaskCount || 0);
    var clauses = [statusLabel(phase), jtn('diagnostics.inventory.enabledTaskCount', count, { count: formatNumber(count) }, '{count} enabled task', '{count} enabled tasks')];
    if (lifecycle.reason) clauses.push(String(lifecycle.reason));
    if (lifecycle.error) clauses.push(String(lifecycle.error));
    return [jt('diagnostics.inventory.scheduler', 'Scheduler'), clauses.join(' \u00b7 '), phase === 'failed' ? 'warn' : 'ok', false, phase + ' \u00b7 ' + clauses.join(' \u00b7 ')];
  }

  // Electron's own runtime facet (jenny_status.runtime.chromium_sandbox) says
  // whether the Chromium OS sandbox is on. Absent facet -> no row.
  function chromiumSandboxRow(status) {
    var facet = status && status.runtime ? status.runtime.chromium_sandbox : null;
    if (!facet || typeof facet !== 'object') return null;
    var label = jt('diagnostics.runtime.chromiumSandbox', 'Chromium sandbox');
    if (facet.sandboxed === true) return [label, jt('diagnostics.runtime.sandboxOn', 'On'), 'ok'];
    if (facet.sandboxed !== false) {
      return [label, jt('diagnostics.runtime.sandboxUnknown', 'Unknown · Electron did not report its command line'), 'warn'];
    }
    return [label, facet.package_kind === 'appimage'
      ? jt('diagnostics.runtime.sandboxOffAppImage', 'Off · this system restricts unprivileged user namespaces; install the .deb for full sandboxing')
      : jt('diagnostics.runtime.sandboxOffFlag', 'Off · launched with --no-sandbox'), 'warn'];
  }

  // The host is aria-live; a stamp that changes on every refresh would force the
  // whole list to be re-announced even when nothing else moved, so it stays out
  // of the accessibility tree. Run status already goes through the announcer.
  function inventoryStampMarkup(state) {
    var loadedAt = Number(state.harness?.loadedAt || 0);
    if (!Number.isFinite(loadedAt) || loadedAt <= 0) return '';
    return '<p class="diagnostics-inventory-stamp" aria-hidden="true" title="'
      + escapeHtml(formatDetailTime(loadedAt)) + '">'
      + escapeHtml(jt('diagnostics.inventory.capturedAt', 'Captured {time}', { time: formatCompactTime(loadedAt, true) })) + '</p>';
  }

  function renderRuntimeInventory(state) {
    var host = document.getElementById('diagnosticsRuntimeInventory');
    if (!host) return;
    var error = String(state.harness?.error || '').trim();
    var snapshot = state.harness?.snapshot;
    if (error || !snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      paintMarkup(host, '<div class="diagnostics-compact-empty" data-tone="warn"><strong>' + escapeHtml(jt('diagnostics.inventory.runtimeUnavailable', 'Runtime inventory unavailable')) + '</strong><p>'
        + escapeHtml(error || jt('diagnostics.inventory.noneCollected', 'No runtime inventory has been collected yet.')) + '</p></div>');
      return;
    }
    var sandbox = chromiumSandboxRow(state.diagnosticsStatus);
    var platform = [schedulerRow(state.schedulerDiagnostics)].concat(sandbox ? [sandbox] : []);
    var failure = loadFailureUtils ? loadFailureUtils.readModelLoadFailure(liveBackend(state)) : null;
    var rows = boundedFacetItems(snapshot, failure).map(function (item) { return inventoryRow(item, false); }).join('')
      + platform.map(function (item, index) { return inventoryRow(item, index === 0); }).join('');
    paintMarkup(host, '<dl class="diagnostics-inventory-list">' + rows + '</dl>' + inventoryActionsMarkup(failure) + inventoryStampMarkup(state));
  }

  function renderOverview(state, entries) {
    var issues = issueUtils.groupIssues ? issueUtils.groupIssues(entries) : [];
    var snapshot = state.diagnosticsSnapshot || {};
    var evidence = reportUtils.selectRunEvidence
      ? reportUtils.selectRunEvidence(snapshot, selectedRunId(state), entries)
      : { sources: snapshot.sources || {}, integrity: snapshot.integrity || {} };
    var integrity = evidence.integrity || {};
    var sourceEvidence = evidence.sources || {};
    renderOverall(state, issues, sourceEvidence, integrity);
    renderIssues(issues, entries);
    renderSources(sourceEvidence, integrity);
    renderHealth(state);
    renderRuntimeInventory(state);
  }

  function entryId(entry) {
    return String(entry.entry_id || entry.origin_entry_id || entry.sequence || '');
  }

  function activityRowAriaLabel(entry, timestamp, eventName, message) {
    var boundedMessage = String(message || jt('diagnostics.activity.noAdditionalMessage', 'No additional message'));
    if (boundedMessage.length > 320) boundedMessage = boundedMessage.slice(0, 319) + '…';
    return [
      jt('diagnostics.activity.timeLabel', 'Time {time}', { time: timestamp || jt('diagnostics.common.unknown', 'Unknown') }),
      jt('diagnostics.activity.levelLabel', 'Level {level}', { level: String(entry.level || 'INFO') }),
      jt('diagnostics.activity.sourceLabel', 'Source {source}', { source: String(entry.layer || entry.source || 'electron') }),
      jt('diagnostics.activity.eventLabel', 'Event {event}', { event: eventName }),
      jt('diagnostics.activity.messageLabel', 'Message {message}', { message: boundedMessage }),
    ].join(', ');
  }

  function renderActivityRow(entry, selectedEntryId, focusable) {
    var id = entryId(entry);
    var selected = id === selectedEntryId;
    var timestamp = String(entry.ts || '');
    var eventName = String(entry.event || 'event');
    var message = displayMessage(entry.message || entry.details?.message, eventName);
    return '<article class="log-entry" role="option" aria-controls="logDetailPanel"'
      + ' aria-label="' + escapeHtml(activityRowAriaLabel(entry, timestamp, eventName, message)) + '"'
      + ' data-log-index="' + escapeHtml(id) + '" data-entry-id="' + escapeHtml(id) + '"'
      + ' data-level="' + escapeHtml(String(entry.level || 'INFO').toLowerCase()) + '"'
      + ' tabindex="' + (focusable || selected ? '0' : '-1') + '" aria-selected="' + selected + '">'
      + '<time data-label="' + escapeHtml(jt('diagnostics.labels.time', 'Time')) + '" datetime="' + escapeHtml(timestamp) + '" title="' + escapeHtml(timestamp || jt('diagnostics.common.unknownTime', 'Unknown time')) + '">'
      + escapeHtml(formatCompactTime(timestamp)) + '</time>'
      + '<span class="log-entry-level" data-label="' + escapeHtml(jt('diagnostics.labels.level', 'Level')) + '">' + escapeHtml(entry.level || 'INFO') + '</span>'
      + '<span class="log-entry-source" data-label="' + escapeHtml(jt('diagnostics.labels.source', 'Source')) + '">' + escapeHtml(entry.layer || entry.source || 'electron') + '</span>'
      + '<code class="log-entry-event" data-label="' + escapeHtml(jt('diagnostics.labels.event', 'Event')) + '">' + escapeHtml(eventName) + '</code>'
      + '<span class="log-entry-message' + (message ? '' : ' diagnostics-muted') + '" data-label="' + escapeHtml(jt('diagnostics.labels.message', 'Message')) + '">'
      + (message ? escapeHtml(message) : '<span aria-hidden="true">—</span><span class="sr-only">' + escapeHtml(jt('diagnostics.activity.noAdditionalMessage', 'No additional message')) + '</span>') + '</span>'
      + '</article>';
  }

  function findRow(list, id) {
    return Array.from(list?.querySelectorAll?.('[data-entry-id]') || []).find(function (row) {
      return row.dataset.entryId === id;
    }) || null;
  }

  function updateSelection(list, previousId, nextId) {
    if (!list || previousId === nextId) return;
    var previous = findRow(list, previousId);
    var next = findRow(list, nextId);
    if (previous) {
      previous.setAttribute('aria-selected', 'false');
      previous.tabIndex = -1;
    }
    if (next) {
      next.setAttribute('aria-selected', 'true');
      next.tabIndex = 0;
    } else if (!nextId) {
      var first = list.querySelector('[data-entry-id]');
      if (first) first.tabIndex = 0;
    }
  }

  function renderScope(view) {
    var scope = document.getElementById('diagnosticsActivityScope');
    if (!scope) return;
    scope.hidden = !view.issueScope;
    if (!view.issueScope) {
      paintMarkup(scope, '');
      return;
    }
    var clear = typeof actionButton === 'function'
      ? actionButton({ id: 'clear-diagnostics-scope', domId: 'diagnosticsClearScope', label: jt('diagnostics.clearScope', 'Clear scope'), variant: 'ghost', size: 'sm' })
      : '';
    paintMarkup(scope,
      '<div><span>' + escapeHtml(jt('diagnostics.activity.issueScope', 'Issue scope')) + '</span><strong>' + escapeHtml(view.issueScope.event) + '</strong><small>'
      + escapeHtml(view.issueScope.component + (view.issueScope.error_code ? ' · ' + view.issueScope.error_code : ''))
      + '</small></div>' + clear);
  }

  function renderActivity(state, entries, virtualizer, cache) {
    var view = diagnosticsState(state);
    var filtered = filterEntries(state, entries);
    var list = document.getElementById('logList');
    var label = document.getElementById('logResultsLabel');
    if (label) label.textContent = jt('diagnostics.eventCount', '{filtered} of {total} events', { filtered: filtered.length, total: entries.length });
    renderScope(view);

    var activeRunId = String(state.diagnosticsSnapshot?.active_run?.run_id || '');
    var currentRunSelected = !activeRunId || selectedRunId(state) === activeRunId;
    var follow = document.getElementById('logAutoScrollToggle');
    if (follow) {
      follow.disabled = !currentRunSelected;
      follow.setAttribute('aria-pressed', String(currentRunSelected && view.autoScroll));
      follow.classList.toggle('active', currentRunSelected && view.autoScroll);
    }
    if (!list) return;

    var ids = filtered.map(entryId);
    if (view.selectedEntryId && !ids.includes(view.selectedEntryId)) view.selectedEntryId = '';
    var filterSignature = [
      selectedRunId(state),
      view.query,
      view.levelFilter,
      view.sourceFilter,
      view.issueScope && JSON.stringify(view.issueScope),
    ].join('|');
    if (cache.filterAnnouncementSignature !== filterSignature) {
      cache.filterAnnouncementSignature = filterSignature;
      announce(jtn('diagnostics.activity.matchingEventCount', filtered.length, { count: filtered.length }, '{count} matching event.', '{count} matching events.'), 'activity|' + filterSignature + '|' + filtered.length);
    }

    if (!filtered.length) {
      if (cache.signature !== filterSignature || cache.ids.length) {
        paintMarkup(list, '<div class="diagnostics-empty"><strong>' + escapeHtml(jt('diagnostics.activity.noMatches', 'No matching activity')) + '</strong><p>' + escapeHtml(jt('diagnostics.activity.adjustFiltersHint', 'Adjust the run or filters, or clear the active issue scope.')) + '</p></div>');
      }
      cache.signature = filterSignature;
      cache.ids = [];
      cache.selectedEntryId = '';
      virtualizer?.rebuild?.();
      return;
    }

    var previousSelectedId = cache.selectedEntryId;
    var idsMatch = cache.ids.length === ids.length && cache.ids.every(function (id, index) { return id === ids[index]; });
    var canAppend = cache.ids.length > 0
      && cache.signature === filterSignature
      && cache.ids.length < ids.length
      && cache.ids.every(function (id, index) { return id === ids[index]; });
    var mutated = false;
    if (canAppend) {
      list.insertAdjacentHTML('beforeend', filtered.slice(cache.ids.length).map(function (entry) {
        return renderActivityRow(entry, view.selectedEntryId, false);
      }).join(''));
      markupCache.delete(list);
      mutated = true;
    } else if (cache.signature !== filterSignature || !idsMatch) {
      var focusedRow = list.contains(document.activeElement) ? document.activeElement.closest('[data-entry-id]') : null;
      var focusId = focusedRow?.dataset.entryId || '';
      if (focusId && !ids.includes(focusId)) {
        var focusIndex = cache.ids.indexOf(focusId);
        focusId = cache.ids.slice(focusIndex + 1).find(function (id) { return ids.includes(id); })
          || cache.ids.slice(0, focusIndex).reverse().find(function (id) { return ids.includes(id); })
          || ids[0];
      }
      list.innerHTML = filtered.map(function (entry, index) {
        return renderActivityRow(entry, view.selectedEntryId, !view.selectedEntryId && index === 0);
      }).join('');
      markupCache.delete(list);
      if (focusId) {
        var rows = Array.from(list.querySelectorAll('[data-entry-id]'));
        var focusTarget = rows.find(function (row) { return row.dataset.entryId === focusId; });
        rows.forEach(function (row) { row.tabIndex = row === focusTarget ? 0 : -1; });
        focusTarget?.focus({ preventScroll: true });
      }
      mutated = true;
    } else {
      updateSelection(list, previousSelectedId, view.selectedEntryId);
    }

    cache.signature = filterSignature;
    cache.ids = ids;
    cache.selectedEntryId = view.selectedEntryId;
    if (mutated) virtualizer?.rebuild?.();
    if (mutated && view.autoScroll && !view.selectedEntryId) scrollLogsToBottom(list);
  }

  function detailField(label, value, code) {
    if (value == null || String(value).trim() === '') return '';
    return '<div><dt>' + escapeHtml(label) + '</dt><dd>' + (code ? '<code>' + escapeHtml(value) + '</code>' : escapeHtml(value)) + '</dd></div>';
  }

  function renderDetail(state, entries) {
    var panel = document.getElementById('logDetailPanel');
    if (!panel) return;
    var id = diagnosticsState(state).selectedEntryId;
    var entry = entries.find(function (item) { return entryId(item) === id; });
    panel.hidden = !entry;
    if (!entry) {
      paintMarkup(panel, '');
      return;
    }

    var details = typeof logContractUtils.redactLogReportValue === 'function'
      ? logContractUtils.redactLogReportValue(entry.data || entry.details || {})
      : (entry.data || entry.details || {});
    var close = typeof actionButton === 'function'
      ? actionButton({
        id: 'close-log-detail',
        domId: 'diagnosticsCloseDetail',
        label: jt('diagnostics.closeInspector', 'Close inspector'),
        ariaLabel: jt('diagnostics.closeInspectorAndReturn', 'Close inspector and return to activity'),
        title: jt('diagnostics.closeInspectorAndReturn', 'Close inspector and return to activity'),
        trustedHtml: '<span class="diagnostics-detail-close-wide">' + escapeHtml(jt('diagnostics.closeInspector', 'Close inspector')) + '</span><span class="diagnostics-detail-close-narrow">' + escapeHtml(jt('diagnostics.backToActivity', 'Back to activity')) + '</span>',
        variant: 'ghost',
        size: 'sm',
      })
      : '';
    var message = displayMessage(entry.message || entry.details?.message, entry.event);
    var correlations = issueUtils.correlations ? issueUtils.correlations(entry) : {};
    var correlationMarkup = Object.entries(correlations).map(function (pair) {
      return detailField(statusLabel(pair[0].replace('_id', '')), safeCorrelationValue(pair[1]), true);
    }).join('');
    var codeMarkup = typeof codeBlock.codeblockTruncated === 'function'
      ? codeBlock.codeblockTruncated({
        code: JSON.stringify(details, null, 2),
        language: 'json',
        label: jt('diagnostics.redactedAttributes', 'Redacted attributes'),
        copyable: true,
        copyIcon: true,
        copyId: 'diagnostics-detail-' + id.replace(/[^a-zA-Z0-9_-]/g, '-'),
        ariaLabel: jt('diagnostics.redactedStructuredAttributes', 'Redacted structured event attributes'),
        className: 'diagnostics-detail-code',
        maxChars: 16384,
      })
      : '<div class="diagnostics-compact-empty"><p>' + escapeHtml(jt('diagnostics.detail.structuredAttributesUnavailable', 'Structured attributes unavailable.')) + '</p></div>';
    paintMarkup(panel,
      '<header class="diagnostics-detail-header"><div><span class="diagnostics-detail-header-level" data-level="'
      + escapeHtml(String(entry.level || 'INFO').toLowerCase()) + '">' + escapeHtml(entry.level || 'INFO') + '</span><h3><code>'
      + escapeHtml(entry.event || 'event') + '</code></h3></div>' + close + '</header>'
      + '<section class="diagnostics-detail-section"><h4>' + escapeHtml(jt('diagnostics.detail.summary', 'Summary')) + '</h4><dl class="diagnostics-detail-list">'
      + detailField(jt('diagnostics.labels.message', 'Message'), message || jt('diagnostics.issues.noAdditionalMessageRecorded', 'No additional message recorded.'))
      + detailField(jt('diagnostics.labels.time', 'Time'), formatDetailTime(entry.ts))
      + detailField(jt('diagnostics.labels.component', 'Component'), entry.component || 'unknown', true)
      + detailField(jt('diagnostics.detail.run', 'Run'), entry.run_id, true)
      + detailField(jt('diagnostics.detail.sequence', 'Sequence'), entry.sequence, true)
      + '</dl></section>'
      + '<section class="diagnostics-detail-section"><h4>' + escapeHtml(jt('diagnostics.detail.identity', 'Identity')) + '</h4><dl class="diagnostics-detail-list">'
      + detailField(jt('diagnostics.labels.source', 'Source'), entry.layer || entry.source || 'electron', true)
      + detailField(jt('diagnostics.labels.event', 'Event'), entry.event || 'event', true)
      + detailField(jt('diagnostics.labels.level', 'Level'), entry.level || 'INFO')
      + '</dl></section>'
      + (correlationMarkup ? '<section class="diagnostics-detail-section"><h4>' + escapeHtml(jt('diagnostics.detail.correlation', 'Correlation')) + '</h4><dl class="diagnostics-detail-list">' + correlationMarkup + '</dl></section>' : '')
      + '<section class="diagnostics-detail-section"><h4>' + escapeHtml(jt('diagnostics.detail.structuredData', 'Structured data')) + '</h4>' + codeMarkup + '</section>');
  }

  // Runs (owner, 2026-10-03; moved from Settings). The board belongs to the
  // shared runtime console, which the settings section binders publish (one
  // poller with Settings › Limits & budgets). Each paint of this tab attaches
  // it on first show and wakes it after; the console polls only while
  // Diagnostics shows this tab.
  function showRunsBoard(loadSeam) {
    var host = document.getElementById('diagnosticsRunsMount');
    if (!host) return false;
    var seam = globalThis.rendererRuntimeConsole;
    if (seam && typeof seam.showRuns === 'function') { seam.showRuns(host); return true; }
    // The seam ships with the Settings page group, which loads on first use
    // (row 32 W2): ask for the page once, and the caller paints again after.
    if (typeof loadSeam === 'function') loadSeam();
    return false;
  }

  function scrollLogsToBottom(list) {
    var node = list || document.getElementById('logList');
    if (node) node.scrollTop = node.scrollHeight;
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
      if (view.activeTab === 'overview') renderOverview(state, entries);
      else if (view.activeTab === 'activity') renderActivity(state, entries, virtualizer, activityCache);
      else if (!showRunsBoard(loadRunsSeam)) return;
      if (view.activeTab !== 'runs') runsSeamFailed = false;
      renderDetail(state, entries);
    }

    var runsSeamLoad = null;
    var runsSeamFailed = false;
    function loadRunsSeam() {
      var ensureSettingsPage = options.callbacks && options.callbacks.ensureSettingsPage;
      if (runsSeamLoad || runsSeamFailed || typeof ensureSettingsPage !== 'function') return;
      runsSeamLoad = Promise.resolve(ensureSettingsPage()).then(function (page) {
        runsSeamLoad = null;
        var seam = globalThis.rendererRuntimeConsole;
        // A failed load (or a page without the seam) waits for the next visit of the tab; no repaint loop.
        if (!page || !seam || typeof seam.showRuns !== 'function') { runsSeamFailed = true; return; }
        if (diagnosticsState(state).activeTab === 'runs') renderLogs();
      }, function () { runsSeamLoad = null; runsSeamFailed = true; });
    }

    function renderLogs() {
      if (state.ui.activeView !== 'logs' || frame != null) return;
      frame = (window.requestAnimationFrame || function (callback) { return setTimeout(callback, 0); })(paint);
    }

    function dispose() {
      if (frame != null) (window.cancelAnimationFrame || clearTimeout)(frame);
      frame = null;
      activityCache.ids = [];
      virtualizer?.dispose?.();
    }

    function getLogEntryById(id) {
      return selectedEntries(state).find(function (entry) { return entryId(entry) === String(id); }) || null;
    }

    return {
      renderLogs: renderLogs,
      dispose: dispose,
      getLogEntryById: getLogEntryById,
      ensureLogRowMounted: function (id) { return virtualizer?.ensureMountedForId?.(id) || false; },
    };
  }

  return Object.freeze({
    createLogRenderer: createLogRenderer,
    scrollLogsToBottom: scrollLogsToBottom,
    selectedEntries: selectedEntries,
  });
});
