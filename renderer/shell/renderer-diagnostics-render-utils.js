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
      require('./renderer-runtime-health-utils')
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
    root.rendererRuntimeHealthUtils || {}
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (
  issueUtils,
  reportUtils,
  virtualizerUtils,
  actionButton,
  codeBlock,
  logContractUtils,
  phaseUtils,
  runtimeHealthUtils
) {
  'use strict';

  var markupCache = new WeakMap();
  var SOURCE_NAMES = ['electron', 'renderer', 'sidecar'];
  var MAX_CORRELATION_CHARS = 160;
  var MAX_INVENTORY_VALUE_CHARS = 160;

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

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
    if (!date) return String(value || 'Unknown');
    var time = pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
    if (!includeDate) return time + '.' + pad(date.getMilliseconds(), 3);
    return pad(date.getMonth() + 1) + '/' + pad(date.getDate()) + ' ' + time;
  }

  function formatDetailTime(value) {
    var date = parsedDate(value);
    if (!date) return String(value || 'Unknown');
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
      + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
      + '.' + pad(date.getMilliseconds(), 3);
  }

  function humanize(value, fallback) {
    var text = String(value || '').trim();
    if (!text) return fallback || 'Unknown';
    return text.replace(/[._-]+/g, ' ').replace(/\b\w/g, function (letter) { return letter.toUpperCase(); });
  }

  function displayMessage(message, eventName) {
    var text = String(message || '').trim();
    return text && text !== String(eventName || '').trim() ? text : '';
  }

  function formatNumber(value) {
    var number = Number(value);
    return Number.isFinite(number) ? number.toLocaleString('en-US') : '0';
  }

  function formatMetricMs(value) {
    if (value == null || String(value).trim() === '') return '—';
    var number = Number(value);
    if (!Number.isFinite(number)) return '—';
    return number >= 1000 ? (number / 1000).toFixed(2) + 's' : Math.round(number) + 'ms';
  }

  function hasPositiveCounts(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    return Object.values(value).some(function (item) {
      var count = Number(item?.count);
      return Number.isFinite(count) && count > 0;
    });
  }

  function hasPerformanceSamples(status) {
    return hasPositiveCounts(status.phase_percentiles?.phases)
      || hasPositiveCounts(status.tool_observability?.tools);
  }

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

  function runOption(run, label) {
    if (!run) return '';
    var suffix = run.legacy
      ? ' · legacy history'
      : label === 'Prior run' && run.started_at
        ? ' · ' + formatCompactTime(run.started_at, true)
        : '';
    return '<option value="' + escapeHtml(run.run_id) + '">' + escapeHtml(label + suffix) + '</option>';
  }

  function renderRunSelector(state) {
    var select = document.getElementById('diagnosticsRunSelect');
    if (!select) return;
    var snapshot = state.diagnosticsSnapshot || {};
    var markup = runOption(snapshot.active_run, 'Current run') + runOption(snapshot.prior_run, 'Prior run');
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
    if (slot.dataset.activeTab === active && slot.childElementCount === 2) return;
    var restoreFocus = Boolean(document.activeElement?.closest?.('#diagnosticsTabs [data-tab]'));
    slot.innerHTML = ['overview', 'activity'].map(function (tab) {
      return actionButton({
        id: 'diagnostics-tab',
        domId: tab === 'overview' ? 'diagnosticsOverviewTab' : 'diagnosticsActivityTab',
        label: tab[0].toUpperCase() + tab.slice(1),
        variant: 'ghost',
        size: 'sm',
        role: 'tab',
        ariaSelected: active === tab,
        ariaControls: tab === 'overview' ? 'diagnosticsOverview' : 'diagnosticsActivity',
        tabIndex: active === tab ? 0 : -1,
        dataset: { tab: tab },
        className: 'diagnostics-tab',
      });
    }).join('');
    slot.dataset.activeTab = active;
    if (restoreFocus) slot.querySelector('[data-tab="' + active + '"]')?.focus?.();
  }

  function overallState(state, issues, sourceEvidence, integrity) {
    var status = state.diagnosticsStatus || {};
    var phase = String(status.backend?.phase || state.backend?.phase || 'unknown').toLowerCase();
    var unavailable = ['failed', 'unavailable', 'stopped'].includes(phase);
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
    var headline = unavailable
      ? 'Runtime unavailable'
      : tone === 'ok'
        ? 'Ready'
        : tone === 'error'
          ? 'Action required'
          : tone === 'warn'
            ? integrity.complete === false
              ? 'Partial evidence'
              : sourceGap
                ? 'Degraded source coverage'
                : 'Warnings detected'
            : phase === 'starting'
              ? 'Starting'
              : humanize(phase);
    var summary = integrity.complete === false
      ? 'Some evidence is partial. Review Source integrity before drawing conclusions.'
      : sourceGap
        ? 'One or more expected sources have not been observed in this ready runtime.'
        : issues.length
          ? issues.length + ' grouped issue' + (issues.length === 1 ? '' : 's') + ' need review.'
          : unavailable
            ? 'The runtime is not available. Inspect recent issues and Activity for the failure path.'
            : 'No WARN or ERROR events in the selected run.';
    return { tone: tone, headline: headline, summary: summary };
  }

  function renderOverall(state, issues, sourceEvidence, integrity) {
    var overall = document.getElementById('diagnosticsOverall');
    if (!overall) return;
    var result = overallState(state, issues, sourceEvidence, integrity);
    overall.dataset.tone = result.tone;
    paintMarkup(overall,
      '<div class="diagnostics-overall-copy">'
      + '<span class="diagnostics-overall-state">' + escapeHtml(humanize(result.tone)) + '</span>'
      + '<div><strong>' + escapeHtml(result.headline) + '</strong><p>' + escapeHtml(result.summary) + '</p></div>'
      + '</div>'
      + '<span class="diagnostics-overall-count">' + issues.length + ' issue' + (issues.length === 1 ? '' : 's') + '</span>');
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
        + '<td>' + formatNumber(source.count || 0) + '</td>'
        + '<td><span class="diagnostics-source-state">' + escapeHtml(humanize(state)) + '</span>'
        + (dropped ? '<span class="diagnostics-source-drop">' + dropped + ' dropped</span>' : '') + '</td>'
        + '<td><time datetime="' + escapeHtml(source.last_seen || '') + '" title="' + escapeHtml(source.last_seen || 'No event observed') + '">'
        + escapeHtml(source.last_seen ? formatCompactTime(source.last_seen) : 'Not observed') + '</time></td>'
        + '</tr>';
    }).join('');
    var reasons = Array.isArray(integrity.partial_reasons) ? integrity.partial_reasons : [];
    var integrityTone = integrity.complete === true ? 'complete' : 'partial';
    var integrityCopy = reasons.length
      ? reasons.map(function (reason) { return humanize(reason); }).join(' · ')
      : integrity.complete === true
        ? 'No known gaps'
        : 'Evidence completeness has not been confirmed';
    paintMarkup(sources,
      '<div class="diagnostics-source-table-shell"><table class="diagnostics-source-table">'
      + '<caption class="sr-only">Diagnostic source integrity</caption>'
      + '<thead><tr><th scope="col">Source</th><th scope="col">Events</th><th scope="col">Capture</th><th scope="col">Last seen</th></tr></thead>'
      + '<tbody>' + rows + '</tbody></table></div>'
      + '<div class="diagnostics-integrity-summary" data-tone="' + integrityTone + '">'
      + '<div><span>Integrity</span><strong>' + (integrity.complete === true ? 'Complete' : 'Partial') + '</strong></div>'
      + '<p>' + escapeHtml(integrityCopy) + '</p></div>');
  }

  function renderIssues(issues) {
    var issueList = document.getElementById('diagnosticsIssueList');
    if (!issueList) return;
    if (!issues.length) {
      paintMarkup(issueList, '<div class="diagnostics-empty"><strong>No actionable issues</strong><p>The selected run has no WARN or ERROR events.</p></div>');
      return;
    }
    var rows = issues.slice(0, 20).map(function (issue) {
      var message = displayMessage(issue.message, issue.event);
      var correlationPairs = Object.entries(issue.correlations || {}).filter(function (pair) {
        return String(pair[1] || '').trim();
      });
      var correlations = correlationPairs.length
        ? '<div class="diagnostics-issue-correlations" aria-label="Correlation identifiers">'
          + correlationPairs.map(function (pair) {
            var safeValue = safeCorrelationValue(pair[1]);
            return '<span><span>' + escapeHtml(humanize(pair[0].replace('_id', ''))) + '</span><code title="'
              + escapeHtml(safeValue) + '">' + escapeHtml(safeValue) + '</code></span>';
          }).join('') + '</div>'
        : '';
      var remediation = issue.remediation
        ? '<p class="diagnostics-remediation"><span>Recorded remediation</span>' + escapeHtml(issue.remediation) + '</p>'
        : '';
      var inspect = typeof actionButton === 'function'
        ? actionButton({
          id: 'inspect-diagnostic-issue',
          label: 'Inspect activity',
          variant: 'ghost',
          size: 'sm',
          dataset: { issue: encodeURIComponent(issue.key) },
          className: 'diagnostics-inspect-action',
        })
        : '';
      return '<article class="diagnostics-issue" role="listitem" data-severity="' + escapeHtml(issue.severity) + '">'
        + '<span class="diagnostics-issue-level" data-label="Level">' + escapeHtml(issue.severity) + '</span>'
        + '<div class="diagnostics-issue-copy" data-label="Issue"><strong><code>' + escapeHtml(issue.event) + '</code></strong>'
        + (message ? '<p>' + escapeHtml(message) + '</p>' : '<p class="diagnostics-muted">No additional message recorded.</p>')
        + correlations + remediation + '</div>'
        + '<div class="diagnostics-issue-meta" data-label="Component"><code>' + escapeHtml(issue.component) + '</code>'
        + (issue.error_code ? '<span>' + escapeHtml(issue.error_code) + '</span>' : '') + '</div>'
        + '<time data-label="Last seen" datetime="' + escapeHtml(issue.ts || '') + '" title="' + escapeHtml(issue.ts || 'Unknown time') + '">'
        + escapeHtml(issue.ts ? formatCompactTime(issue.ts) : 'Unknown') + '</time>'
        + '<span class="diagnostics-issue-count" data-label="Count">' + formatNumber(issue.count) + '×</span>'
        + '<div class="diagnostics-issue-action">' + inspect + '</div></article>';
    }).join('');
    paintMarkup(issueList,
      '<div class="diagnostics-issue-header" aria-hidden="true"><span>Level</span><span>Issue</span><span>Component</span><span>Last seen</span><span>Count</span><span></span></div>'
      + rows);
  }

  function renderPerformanceSummary(status) {
    var anomalies = document.getElementById('performanceAnomaliesContainer');
    var slow = status.slow_operations || null;
    var items = Array.isArray(slow?.items) ? slow.items : [];
    var hasSamples = hasPerformanceSamples(status);
    var backendPhase = String(status.backend?.phase || '').toLowerCase();
    var backendUnavailable = ['failed', 'unavailable', 'stopped', 'error', 'crashed'].includes(backendPhase);
    var unavailableFacets = [];
    if (status.phase_percentiles?.available === false) unavailableFacets.push('phase latency');
    if (status.tool_observability?.available === false) unavailableFacets.push('tool latency');
    if (anomalies) {
      var anomalyMarkup;
      if (items.length) {
        anomalyMarkup = '<div class="diagnostics-performance-summary" data-tone="warn"><strong>' + items.length + ' operation' + (items.length === 1 ? '' : 's') + ' over target</strong>'
          + '<ul>' + items.slice(0, 4).map(function (item) {
            return '<li><code>' + escapeHtml(item.id || item.kind || 'operation') + '</code><span>'
              + escapeHtml(formatMetricMs(item.observed_ms)) + ' observed · ' + escapeHtml(formatMetricMs(item.threshold_ms)) + ' target</span></li>';
          }).join('') + '</ul></div>';
      } else if (backendUnavailable) {
        anomalyMarkup = '<div class="diagnostics-performance-summary"><strong>Performance evidence unavailable</strong>'
          + '<p>Latency sampling is unavailable until the backend recovers.</p></div>';
      } else if (!slow || slow.available === false) {
        anomalyMarkup = '<div class="diagnostics-performance-summary"><strong>Performance evidence unavailable</strong>'
          + '<p>Slow-operation evidence could not be loaded for this run.</p></div>';
      } else if (unavailableFacets.length) {
        var allUnavailable = unavailableFacets.length === 2;
        anomalyMarkup = '<div class="diagnostics-performance-summary"><strong>Performance evidence '
          + (allUnavailable ? 'unavailable' : 'partial') + '</strong><p>'
          + escapeHtml(humanize(unavailableFacets.join(' and '))) + ' evidence could not be loaded for this run.</p></div>';
      } else if (!hasSamples) {
        anomalyMarkup = '<div class="diagnostics-performance-summary"><strong>No performance samples yet</strong>'
          + '<p>Run a local chat or tool to collect latency evidence.</p></div>';
      } else {
        anomalyMarkup = '<div class="diagnostics-performance-summary" data-tone="ok"><strong>No performance anomalies</strong>'
          + '<p>No recorded phase or tool sample exceeded its latency target.</p></div>';
      }
      paintMarkup(anomalies, anomalyMarkup);
    }
    var budgetHost = document.getElementById('resourceBudgetsContainer');
    if (!budgetHost) return;
    var budgets = status.budgets || null;
    var budgetRows = [];
    if (budgets?.token_headroom != null) budgetRows.push(['Token headroom', formatNumber(budgets.token_headroom), Number(budgets.token_headroom) > 0 ? 'ok' : 'warn']);
    if (budgets?.tool_quota_remaining != null) budgetRows.push(['Tool quota remaining', formatNumber(budgets.tool_quota_remaining), Number(budgets.tool_quota_remaining) > 0 ? 'ok' : 'warn']);
    if (Number.isFinite(Number(budgets?.cost_remaining_usd))) budgetRows.push(['Budget remaining', '$' + Number(budgets.cost_remaining_usd).toFixed(2), Number(budgets.cost_remaining_usd) > 0 ? 'ok' : 'warn']);
    var budgetMarkup = budgetRows.length
      ? '<dl class="diagnostics-budget-list">' + budgetRows.map(function (row) {
        return '<div data-tone="' + row[2] + '"><dt>' + escapeHtml(row[0]) + '</dt><dd>' + escapeHtml(row[1]) + '</dd></div>';
      }).join('') + '</dl>'
      : '<div class="diagnostics-compact-empty"><strong>Resource budgets</strong><p>'
        + escapeHtml(budgets?.available === false ? 'Budget evidence is unavailable.' : 'No resource budget counters are available for this run.')
        + '</p></div>';
    paintMarkup(budgetHost, budgetMarkup);
  }

  function renderHealth(state) {
    phaseUtils.renderPhasePercentilesPane?.({
      phasePercentilesState: state.phasePercentiles,
      runtimeHealthState: {
        backend: state.backend,
        status: state.status,
        modelList: state.modelList,
        offline: state.offline || {},
      },
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
    renderPerformanceSummary(state.diagnosticsStatus || {});
  }

  function isAvailableFacet(value) {
    return Boolean(value)
      && typeof value === 'object'
      && !Array.isArray(value)
      && !String(value.error || '').trim();
  }

  function unavailableFacet(label) {
    return [label, 'Unavailable', 'warn'];
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

  // Rows are [label, value, tone, mono?]. Tone is carried by the value colour
  // only (see .diagnostics-inventory-list [data-tone] in diagnostics-health.css);
  // the full value always rides the title so the two-line clamp never hides it.
  function inventoryRow(item, groupStart) {
    var value = String(item[1] == null ? '' : item[1]).trim() || 'Unavailable';
    return '<div data-tone="' + escapeHtml(item[2] || 'warn') + '"'
      + (groupStart ? ' data-group-start="true"' : '')
      + (item[3] ? ' data-mono="true"' : '') + '>'
      + '<dt>' + escapeHtml(item[0]) + '</dt>'
      + '<dd title="' + escapeHtml(value) + '">' + escapeHtml(clampInventoryValue(value)) + '</dd></div>';
  }

  function toolsFacetRow(facet) {
    if (!facet) return unavailableFacet('Tools');
    var counts = isAvailableFacet(facet.counts) ? facet.counts : null;
    var items = Array.isArray(facet.items) ? facet.items : null;
    var enabled = counts && Number.isFinite(Number(counts.enabled))
      ? Number(counts.enabled)
      : items
        ? items.filter(function (tool) { return tool && tool.enabled !== false; }).length
        : null;
    if (enabled == null) return unavailableFacet('Tools');
    var disabled = counts && Number.isFinite(Number(counts.disabled))
      ? Number(counts.disabled)
      : items ? Math.max(items.length - enabled, 0) : 0;
    return [
      'Tools',
      formatNumber(enabled) + ' enabled' + (disabled > 0 ? ' · ' + formatNumber(disabled) + ' disabled' : ''),
      enabled > 0 ? 'ok' : 'warn',
    ];
  }

  function memoryFacetRow(facet) {
    if (!facet) return unavailableFacet('Memory');
    var counts = isAvailableFacet(facet.counts) ? facet.counts : null;
    var approved = counts && Number.isFinite(Number(counts.approved))
      ? Number(counts.approved)
      : Array.isArray(facet.approved) ? facet.approved.length : null;
    var pending = counts && Number.isFinite(Number(counts.pending))
      ? Number(counts.pending)
      : Array.isArray(facet.pending) ? facet.pending.length : null;
    if (approved == null || pending == null || facet.status?.available === false) {
      return unavailableFacet('Memory');
    }
    return ['Memory', formatNumber(approved) + ' approved · ' + formatNumber(pending) + ' pending', 'ok'];
  }

  function skillsFacetRow(facet) {
    if (!facet || !Array.isArray(facet.scopes)) return unavailableFacet('Skills');
    var scopes = facet.scopes.slice(0, 6);
    var counts = isAvailableFacet(facet.counts) ? facet.counts : null;
    var total = counts && Number.isFinite(Number(counts.total))
      ? Number(counts.total)
      : Array.isArray(facet.items) ? facet.items.length : 0;
    var blocked = scopes.filter(function (scope) { return scope && scope.status === 'blocked'; }).length;
    var clauses = [];
    if (total > 0) clauses.push(formatNumber(total) + ' loaded');
    clauses.push(scopes.length + ' scope' + (scopes.length === 1 ? '' : 's'));
    if (blocked) clauses.push(blocked + ' blocked');
    return ['Skills', clauses.join(' · '), blocked ? 'warn' : 'ok'];
  }

  function workspaceFacetRow(facet) {
    if (!facet) return unavailableFacet('Workspace');
    var blockers = Array.isArray(facet.blockers) ? facet.blockers : [];
    if (!String(facet.root || '').trim()) return ['Workspace', 'Not configured', 'warn'];
    if (facet.exists !== true) return ['Workspace', 'Configured root unavailable', 'warn'];
    if (blockers.length) {
      return ['Workspace', 'Available with ' + blockers.length + ' blocker' + (blockers.length === 1 ? '' : 's'), 'warn'];
    }
    return ['Workspace', 'Available', 'ok'];
  }

  // The shell facet is a tree of settings groups. Read values out of it -- never
  // fall back to listing its keys, which reads as configuration but names
  // nothing the owner actually set.
  function shellFacetRow(facet) {
    if (!facet) return unavailableFacet('Shell');
    var clauses = [];
    var companion = String(facet.companion?.mode || '').trim();
    if (companion) clauses.push('Companion ' + companion);
    var offline = String(facet.offline?.mode || '').trim();
    if (offline) clauses.push('offline ' + offline);
    var preferences = isAvailableFacet(facet.tools_preferences) ? facet.tools_preferences : null;
    var keys = preferences ? Object.keys(preferences) : [];
    if (keys.length) {
      var on = keys.filter(function (key) { return preferences[key] === true; }).length;
      clauses.push(on + ' of ' + keys.length + ' tool prefs on');
    }
    return ['Shell', clauses.join(' · ') || 'Configured', 'ok'];
  }

  function boundedFacetItems(snapshot) {
    var runtime = isAvailableFacet(snapshot?.runtime) ? snapshot.runtime : null;
    return [
      runtime && runtime.active_engine && runtime.active_model
        ? ['Engine', runtime.active_engine + ' · ' + runtime.active_model + ' · '
          + (runtime.active_mode || 'chat'), 'ok', true]
        : unavailableFacet('Engine'),
      toolsFacetRow(isAvailableFacet(snapshot?.tools) ? snapshot.tools : null),
      memoryFacetRow(isAvailableFacet(snapshot?.memories) ? snapshot.memories : null),
      skillsFacetRow(isAvailableFacet(snapshot?.skills) ? snapshot.skills : null),
      workspaceFacetRow(isAvailableFacet(snapshot?.workspace) ? snapshot.workspace : null),
      shellFacetRow(isAvailableFacet(snapshot?.shell) ? snapshot.shell : null),
    ];
  }

  function schedulerRow(scheduler) {
    if (!isRecord(scheduler)) return unavailableFacet('Scheduler');
    var lifecycle = isRecord(scheduler.lifecycle) ? scheduler.lifecycle : {};
    var phase = String(lifecycle.phase || 'unknown');
    var count = Number(lifecycle.qualifyingTaskCount || 0);
    var clauses = [humanize(phase), count + ' enabled task' + (count === 1 ? '' : 's')];
    if (lifecycle.reason) clauses.push(String(lifecycle.reason));
    if (lifecycle.error) clauses.push(String(lifecycle.error));
    return ['Scheduler', clauses.join(' · '), phase === 'failed' ? 'warn' : 'ok'];
  }

  function pluginRows(state) {
    if (state.features?.featureFlags?.plugins !== true) return [];
    var plugins = state.pluginPlatformDiagnostics;
    var platform = isRecord(plugins) && isRecord(plugins.platform) ? plugins.platform : null;
    if (!platform) return [unavailableFacet('Plugins')];
    var distribution = isRecord(plugins.distribution?.state)
      ? plugins.distribution.state
      : isRecord(plugins.distribution) ? plugins.distribution : {};
    var catalog = isRecord(plugins.catalog) ? plugins.catalog : {};
    var sources = Array.isArray(catalog.sources) ? catalog.sources.length : 0;
    var installed = Number(platform.installed_count);
    var clauses = Number.isFinite(installed) ? [formatNumber(installed) + ' installed'] : [];
    clauses.push('stage ' + String(platform.stage ?? 'unknown'), 'rev ' + String(platform.revision ?? 'unknown'));
    var recovery = String(platform.recovery?.classification || '').trim();
    return [
      ['Plugins', clauses.join(' · '), platform.read_only ? 'warn' : 'ok'],
      ['Recovery', humanize(recovery || 'not required'), recovery === 'recovery_failed' ? 'warn' : 'ok'],
      sources
        ? ['Distribution', 'rev ' + String(distribution.revision ?? 'not persisted') + ' · '
          + sources + ' catalog source' + (sources === 1 ? '' : 's'), 'ok']
        : ['Distribution', 'No catalog sources', 'muted'],
    ];
  }

  // The host is aria-live; a stamp that changes on every refresh would force the
  // whole list to be re-announced even when nothing else moved, so it stays out
  // of the accessibility tree. Run status already goes through the announcer.
  function inventoryStampMarkup(state) {
    var loadedAt = Number(state.harness?.loadedAt || 0);
    if (!Number.isFinite(loadedAt) || loadedAt <= 0) return '';
    return '<p class="diagnostics-inventory-stamp" aria-hidden="true" title="'
      + escapeHtml(formatDetailTime(loadedAt)) + '">Captured '
      + escapeHtml(formatCompactTime(loadedAt, true)) + '</p>';
  }

  function renderRuntimeInventory(state) {
    var host = document.getElementById('diagnosticsRuntimeInventory');
    if (!host) return;
    var error = String(state.harness?.error || '').trim();
    var snapshot = state.harness?.snapshot;
    if (error || !snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      paintMarkup(host, '<div class="diagnostics-compact-empty" data-tone="warn"><strong>Runtime inventory unavailable</strong><p>'
        + escapeHtml(error || 'No runtime inventory has been collected yet.') + '</p></div>');
      return;
    }
    var platform = [schedulerRow(state.schedulerDiagnostics)].concat(pluginRows(state));
    var rows = boundedFacetItems(snapshot).map(function (item) { return inventoryRow(item, false); }).join('')
      + platform.map(function (item, index) { return inventoryRow(item, index === 0); }).join('');
    paintMarkup(host, '<dl class="diagnostics-inventory-list">' + rows + '</dl>' + inventoryStampMarkup(state));
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
    renderIssues(issues);
    renderSources(sourceEvidence, integrity);
    renderHealth(state);
    renderRuntimeInventory(state);
  }

  function entryId(entry) {
    return String(entry.entry_id || entry.origin_entry_id || entry.sequence || '');
  }

  function activityRowAriaLabel(entry, timestamp, eventName, message) {
    var boundedMessage = String(message || 'No additional message');
    if (boundedMessage.length > 320) boundedMessage = boundedMessage.slice(0, 319) + '…';
    return [
      'Time ' + (timestamp || 'unknown'),
      'Level ' + String(entry.level || 'INFO'),
      'Source ' + String(entry.layer || entry.source || 'electron'),
      'Event ' + eventName,
      'Message ' + boundedMessage,
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
      + '<time data-label="Time" datetime="' + escapeHtml(timestamp) + '" title="' + escapeHtml(timestamp || 'Unknown time') + '">'
      + escapeHtml(formatCompactTime(timestamp)) + '</time>'
      + '<span class="log-entry-level" data-label="Level">' + escapeHtml(entry.level || 'INFO') + '</span>'
      + '<span class="log-entry-source" data-label="Source">' + escapeHtml(entry.layer || entry.source || 'electron') + '</span>'
      + '<code class="log-entry-event" data-label="Event">' + escapeHtml(eventName) + '</code>'
      + '<span class="log-entry-message' + (message ? '' : ' diagnostics-muted') + '" data-label="Message">'
      + (message ? escapeHtml(message) : '<span aria-hidden="true">—</span><span class="sr-only">No additional message</span>') + '</span>'
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
      ? actionButton({ id: 'clear-diagnostics-scope', domId: 'diagnosticsClearScope', label: 'Clear scope', variant: 'ghost', size: 'sm' })
      : '';
    paintMarkup(scope,
      '<div><span>Issue scope</span><strong>' + escapeHtml(view.issueScope.event) + '</strong><small>'
      + escapeHtml(view.issueScope.component + (view.issueScope.error_code ? ' · ' + view.issueScope.error_code : ''))
      + '</small></div>' + clear);
  }

  function renderActivity(state, entries, virtualizer, cache) {
    var view = diagnosticsState(state);
    var filtered = filterEntries(state, entries);
    var list = document.getElementById('logList');
    var label = document.getElementById('logResultsLabel');
    if (label) label.textContent = filtered.length + ' of ' + entries.length + ' events';
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
      announce(filtered.length + ' matching event' + (filtered.length === 1 ? '' : 's') + '.', 'activity|' + filterSignature + '|' + filtered.length);
    }

    if (!filtered.length) {
      if (cache.signature !== filterSignature || cache.ids.length) {
        paintMarkup(list, '<div class="diagnostics-empty"><strong>No matching activity</strong><p>Adjust the run or filters, or clear the active issue scope.</p></div>');
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
      list.innerHTML = filtered.map(function (entry, index) {
        return renderActivityRow(entry, view.selectedEntryId, !view.selectedEntryId && index === 0);
      }).join('');
      markupCache.delete(list);
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
        label: 'Close inspector',
        ariaLabel: 'Close inspector and return to activity',
        title: 'Close inspector and return to activity',
        trustedHtml: '<span class="diagnostics-detail-close-wide">Close inspector</span><span class="diagnostics-detail-close-narrow">Back to activity</span>',
        variant: 'ghost',
        size: 'sm',
      })
      : '';
    var message = displayMessage(entry.message || entry.details?.message, entry.event);
    var correlations = issueUtils.correlations ? issueUtils.correlations(entry) : {};
    var correlationMarkup = Object.entries(correlations).map(function (pair) {
      return detailField(humanize(pair[0].replace('_id', '')), safeCorrelationValue(pair[1]), true);
    }).join('');
    var codeMarkup = typeof codeBlock.codeblockTruncated === 'function'
      ? codeBlock.codeblockTruncated({
        code: JSON.stringify(details, null, 2),
        language: 'json',
        label: 'Redacted attributes',
        copyable: true,
        copyIcon: true,
        copyId: 'diagnostics-detail-' + id.replace(/[^a-zA-Z0-9_-]/g, '-'),
        ariaLabel: 'Redacted structured event attributes',
        className: 'diagnostics-detail-code',
        maxChars: 16384,
      })
      : '<div class="diagnostics-compact-empty"><p>Structured attributes unavailable.</p></div>';
    paintMarkup(panel,
      '<header class="diagnostics-detail-header"><div><span class="diagnostics-detail-header-level" data-level="'
      + escapeHtml(String(entry.level || 'INFO').toLowerCase()) + '">' + escapeHtml(entry.level || 'INFO') + '</span><h3><code>'
      + escapeHtml(entry.event || 'event') + '</code></h3></div>' + close + '</header>'
      + '<section class="diagnostics-detail-section"><h4>Summary</h4><dl class="diagnostics-detail-list">'
      + detailField('Message', message || 'No additional message recorded.')
      + detailField('Time', formatDetailTime(entry.ts))
      + detailField('Component', entry.component || 'unknown', true)
      + detailField('Run', entry.run_id, true)
      + detailField('Sequence', entry.sequence, true)
      + '</dl></section>'
      + '<section class="diagnostics-detail-section"><h4>Identity</h4><dl class="diagnostics-detail-list">'
      + detailField('Source', entry.layer || entry.source || 'electron', true)
      + detailField('Event', entry.event || 'event', true)
      + detailField('Level', entry.level || 'INFO')
      + '</dl></section>'
      + (correlationMarkup ? '<section class="diagnostics-detail-section"><h4>Correlation</h4><dl class="diagnostics-detail-list">' + correlationMarkup + '</dl></section>' : '')
      + '<section class="diagnostics-detail-section"><h4>Structured data</h4>' + codeMarkup + '</section>');
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
      if (overview) overview.hidden = view.activeTab !== 'overview';
      if (activity) activity.hidden = view.activeTab !== 'activity';
      if (view.activeTab === 'overview') renderOverview(state, entries);
      else renderActivity(state, entries, virtualizer, activityCache);
      renderDetail(state, entries);
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
      stopRelativeTimeRefresh: dispose,
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
