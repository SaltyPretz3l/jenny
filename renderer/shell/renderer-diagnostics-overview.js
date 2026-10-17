(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./renderer-diagnostics-page'),
      require('./renderer-diagnostics-format'),
      require('../shared/diagnostics-issue-utils'),
      require('../shared/diagnostics-issue-explanations'),
      require('../shared/diagnostics-report-utils'),
      require('./renderer-phase-percentiles-utils'),
      require('./renderer-diagnostics-performance-utils'),
      require('./renderer-diagnostics-issue-card'),
      require('./renderer-diagnostics-runtime-facts'),
      require('../inventory/action-button'),
      require('../inventory/state-icon'),
      require('../shared/model-load-failure')
    );
    return;
  }
  root.rendererDiagnosticsOverview = factory(
    root.rendererDiagnosticsPage,
    root.rendererDiagnosticsFormat,
    root.diagnosticsIssueUtils || {},
    root.rendererDiagnosticsIssueExplanations || {},
    root.diagnosticsReportUtils || {},
    root.rendererPhasePercentilesUtils || {},
    root.rendererDiagnosticsPerformanceUtils || {},
    root.rendererDiagnosticsIssueCard || {},
    root.rendererDiagnosticsRuntimeFacts || {},
    root.inventoryActionButton,
    root.inventoryStateIcon,
    root.jennyModelLoadFailure
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (
  page,
  format,
  issueUtils,
  explanations,
  reportUtils,
  phaseUtils,
  performanceUtils,
  issueCard,
  runtimeFacts,
  actionButton,
  stateIcon,
  loadFailureUtils
) {
  'use strict';
  // Overview > status line and Needs attention. The status line answers "is Jenny working?" in one sentence;
  // the runtime facts and the Performance section paint into their own hosts.
  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  var jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };
  var escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;
  var formatNumber = format.formatNumber;
  var paintMarkup = page.paintMarkup;
  var announce = page.announce;
  var selectedRunId = page.selectedRunId;
  var liveBackend = page.liveBackend;
  var STARTING_PHASES = ['starting', 'acquiring', 'loading'];

  function errorCountPhrase(count) {
    return jtn('diagnostics.status.errorCount', count, { count: formatNumber(count) }, '{count} error', '{count} errors');
  }

  function warningCountPhrase(count) {
    return jtn('diagnostics.status.warningCount', count, { count: formatNumber(count) }, '{count} warning', '{count} warnings');
  }

  // Counts of merged explanations by severity: the same entries Needs attention lists.
  function countBySeverity(merged) {
    var errors = merged.filter(function (item) { return item.severity === 'ERROR'; }).length;
    return { errors: errors, warnings: merged.length - errors };
  }

  function selectedRun(snapshot, runId) {
    if (!snapshot) return null;
    if (snapshot.active_run && runId === String(snapshot.active_run.run_id || '')) return snapshot.active_run;
    return snapshot.prior_run && runId === String(snapshot.prior_run.run_id || '') ? snapshot.prior_run : null;
  }

  function momentOf(value) {
    return format.parsedDate(value) ? format.formatMoment(value) : '';
  }

  function contextShort(value) {
    return value >= 1024 ? Math.round(value / 1024) + 'K' : String(value);
  }

  function reasonOf(backend) {
    var reason = String(backend.detail || backend.error || backend.message || '').trim();
    return reason ? format.safeCorrelationValue(reason) : '';
  }

  function engineReadyText(state) {
    var runtime = runtimeFacts.activeRuntime(state);
    if (!runtime.engine) return '';
    var name = runtimeFacts.engineName(runtime.engine, state);
    return runtime.model
      ? jt('diagnostics.status.engineReady', '{engine} · {model} is ready.', { engine: name, model: runtime.model })
      : jt('diagnostics.status.engineReadyNoModel', '{engine} is ready.', { engine: name });
  }

  function loadFailureStatus(failure) {
    var time = failure.at && momentOf(failure.at);
    var tried = time && failure.context
      ? jt('diagnostics.status.lastTriedContext', 'Last tried at {time} with {context} context.', { time: time, context: contextShort(failure.context) })
      : time
        ? jt('diagnostics.status.lastTried', 'Last tried at {time}.', { time: time })
        : failure.context ? jt('diagnostics.status.triedContext', 'Tried with {context} context.', { context: contextShort(failure.context) }) : '';
    var retryLabel = jt('diagnostics.inventory.retryLoad', 'Retry load');
    return {
      tone: 'error',
      title: jt('diagnostics.status.modelDidntLoad', '{model} didn’t load', { model: failure.model }),
      text: [loadFailureUtils.causeSentence(failure), tried].filter(Boolean).join(' '),
      actions: actionButton({
        id: 'diagnostics-retry-load', label: retryLabel, title: retryLabel, variant: 'secondary', size: 'sm',
        dataset: { 'retry-model': failure.model, 'retry-engine': failure.engine || '' },
      }) + actionButton({ id: 'diagnostics-open-models', label: jt('diagnostics.status.openModels', 'Open Models'), variant: 'ghost', size: 'sm' }),
    };
  }

  // A launch other than the live one reads from its own records only; live engine state is not its state.
  function previousLaunchStatus(snapshot, counts, runId, evidence) {
    if (evidence.available === false) {
      return { tone: 'pending', title: jt('diagnostics.status.previousUnavailable', 'Records for that launch aren’t available'), text: '' };
    }
    var time = momentOf(selectedRun(snapshot, runId)?.started_at);
    var parts = [];
    if (counts.errors) parts.push(errorCountPhrase(counts.errors));
    if (counts.warnings) parts.push(warningCountPhrase(counts.warnings));
    return {
      tone: counts.errors ? 'error' : counts.warnings ? 'warn' : 'ok',
      title: parts.length
        ? jt('diagnostics.status.previousHad', 'The previous launch had {summary}', { summary: parts.length > 1 ? jt('diagnostics.status.pairAnd', '{first} and {second}', { first: parts[0], second: parts[1] }) : parts[0] })
        : jt('diagnostics.status.previousNone', 'The previous launch had no warnings or errors'),
      text: time
        ? jt('diagnostics.status.previousRecords', 'Records from the launch that began {time}.', { time: time })
        : jt('diagnostics.status.previousRecordsNoTime', 'Records from an earlier launch.'),
    };
  }

  function issuesStatus(state, counts, phase, since) {
    var ready = phase === 'ready' ? engineReadyText(state) : '';
    if (counts.errors) {
      return {
        tone: 'error',
        title: counts.warnings
          ? jt('diagnostics.status.errorsAndWarnings', '{errors} and {warnings} need attention', { errors: errorCountPhrase(counts.errors), warnings: warningCountPhrase(counts.warnings) })
          : jtn('diagnostics.status.errorsNeedAttention', counts.errors, { count: formatNumber(counts.errors) }, '{count} error needs attention', '{count} errors need attention'),
        text: ready,
      };
    }
    if (counts.warnings) {
      // "Working" is a claim about the engine: only a ready phase earns it.
      return {
        tone: 'warn',
        title: phase === 'ready'
          ? jtn('diagnostics.status.workingWithWarnings', counts.warnings, { count: formatNumber(counts.warnings) }, 'Jenny is working, with {count} warning', 'Jenny is working, with {count} warnings')
          : jtn('diagnostics.status.warningsNeedAttention', counts.warnings, { count: formatNumber(counts.warnings) }, '{count} warning needs attention', '{count} warnings need attention'),
        text: [ready, since
          ? jt('diagnostics.status.warningsSince', 'The warnings below are since {time}.', { time: since })
          : jt('diagnostics.status.warningsThisLaunch', 'The warnings below are from this launch.')].filter(Boolean).join(' '),
      };
    }
    return {
      tone: 'ok',
      title: jt('diagnostics.status.working', 'Jenny is working'),
      text: [ready, since
        ? jt('diagnostics.status.noneSince', 'No warnings or errors since {time}.', { time: since })
        : jt('diagnostics.status.noneThisLaunch', 'No warnings or errors in this launch.')].filter(Boolean).join(' '),
    };
  }

  function liveStatus(state, counts, snapshot) {
    var backend = liveBackend(state);
    var phase = phaseUtils.classifyBackendPhase ? phaseUtils.classifyBackendPhase(backend.phase) : 'unknown';
    var failure = loadFailureUtils.readModelLoadFailure(backend);
    if (failure) return loadFailureStatus(failure);
    var runtime = runtimeFacts.activeRuntime(state);
    var engine = runtimeFacts.engineName(runtime.engine, state);
    if (STARTING_PHASES.indexOf(phase) !== -1) {
      var model = runtimeFacts.requestedModel(state);
      return {
        tone: 'pending',
        title: jt('diagnostics.status.starting', 'Starting'),
        text: (model
          ? jt('diagnostics.status.startingModel', '{engine} is starting {model}.', { engine: engine, model: model })
          : jt('diagnostics.status.startingEngine', '{engine} is starting.', { engine: engine }))
          + ' ' + jt('diagnostics.status.fillsIn', 'This page fills in as Jenny reports.'),
      };
    }
    if (phase === 'unavailable') {
      return { tone: 'error', title: jt('diagnostics.status.engineNotRunning', '{engine} isn’t running', { engine: engine }), text: reasonOf(backend) };
    }
    if (phase === 'model_unavailable') {
      var missing = runtimeFacts.requestedModel(state) || jt('diagnostics.status.theModel', 'The model');
      return { tone: 'error', title: jt('diagnostics.status.modelNotAvailable', '{model} isn’t available', { model: missing }), text: reasonOf(backend) };
    }
    var since = momentOf(snapshot.active_run && snapshot.active_run.started_at);
    if (!counts.errors && !counts.warnings && phase !== 'ready') {
      return { tone: 'pending', title: jt('diagnostics.status.checking', 'Checking…'), text: jt('diagnostics.status.waitingToReport', 'Waiting for Jenny to report its state.') };
    }
    return issuesStatus(state, counts, phase, since);
  }

  // The one muted note under the status line when the picture may be incomplete.
  function evidenceNote(evidence) {
    var integrity = evidence.integrity || {};
    if (integrity.complete !== false) return '';
    var reasons = Array.isArray(integrity.partial_reasons) ? integrity.partial_reasons : [];
    if (reasons.length && reasons.every(function (reason) { return /^refresh_.+_failed$/.test(String(reason)); })) {
      return jt('diagnostics.status.refreshIncomplete', 'Some of this page couldn’t be refreshed.');
    }
    var dropped = Number((evidence.sources && evidence.sources.sidecar && evidence.sources.sidecar.dropped) || (integrity.dropped_by_source && integrity.dropped_by_source.sidecar)) || 0;
    return dropped > 0
      ? jtn('diagnostics.status.droppedRecords', dropped, { count: formatNumber(dropped) },
        '{count} record from the local engine was dropped under load, so this picture may be incomplete.',
        '{count} records from the local engine were dropped under load, so this picture may be incomplete.')
      : jt('diagnostics.status.recordsMissing', 'Some records are missing, so this picture may be incomplete.');
  }

  function statusMarkup(status, note) {
    var iconName = status.tone === 'pending' ? 'pending' : status.tone;
    return '<span class="diagnostics-status-mark">' + stateIcon(iconName, { tone: status.tone === 'pending' ? 'muted' : status.tone, size: 'md' }) + '</span>'
      + '<div class="diagnostics-status-copy"><h3>' + escapeHtml(status.title) + '</h3>'
      + (status.text ? '<p class="diagnostics-status-context">' + escapeHtml(status.text) + '</p>' : '')
      + (note ? '<p class="diagnostics-status-note">' + stateIcon('warn', { tone: 'warn', size: 'sm' }) + '<span>' + escapeHtml(note) + '</span></p>' : '')
      + (status.actions ? '<div class="diagnostics-status-actions">' + status.actions + '</div>' : '') + '</div>';
  }

  function renderStatus(state, merged, evidence) {
    var overall = document.getElementById('diagnosticsOverall');
    var updated = document.getElementById('diagnosticsUpdatedAt');
    if (updated) {
      updated.textContent = Number.isFinite(state.diagnosticsRefreshedAt)
        ? jt('diagnostics.status.updated', 'Updated {time}', { time: format.formatClock(state.diagnosticsRefreshedAt) })
        : jt('diagnostics.status.updatedPending', 'Checking');
    }
    if (!overall) return;
    var snapshot = state.diagnosticsSnapshot;
    var status;
    var note = '';
    if (!snapshot) {
      status = { tone: 'pending', title: jt('diagnostics.status.checking', 'Checking…'), text: jt('diagnostics.status.readingRecords', 'Reading the records for this launch.') };
    } else {
      var counts = countBySeverity(merged);
      status = runtimeFacts.isPriorLaunch(state)
        ? previousLaunchStatus(snapshot, counts, selectedRunId(state), evidence)
        : liveStatus(state, counts, snapshot);
      note = evidenceNote(evidence);
    }
    overall.dataset.tone = status.tone;
    // An action (Retry load) that repaints the status away from under focus hands focus to the status heading.
    var focused = overall.contains(document.activeElement) ? document.activeElement : null;
    paintMarkup(overall, statusMarkup(status, note));
    if (focused && !overall.contains(focused)) {
      var heading = overall.querySelector('h3');
      if (heading) {
        heading.tabIndex = -1;
        heading.focus({ preventScroll: true });
      }
    }
    announce(status.title + (status.text ? '. ' + status.text : ''), ['overview', status.tone, status.title, status.text, note].join('|'));
  }

  function renderAttention(issues, merged, prior) {
    var section = document.getElementById('diagnosticsAttention');
    var list = document.getElementById('diagnosticsIssueList');
    if (!section || !list) return;
    section.hidden = merged.length === 0;
    var meta = section.querySelector('.diagnostics-section-meta');
    if (meta) {
      // The list sorts errors above warnings, so a mixed list says so; one severity is simply newest first.
      var mixed = merged.some(function (item) { return item.severity === 'ERROR'; })
        && merged.some(function (item) { return item.severity !== 'ERROR'; });
      meta.textContent = mixed
        ? (prior
          ? jt('diagnostics.attention.orderSeverityPrevious', 'Errors first, then newest · in the previous launch')
          : jt('diagnostics.attention.orderSeverity', 'Errors first, then newest'))
        : (prior
          ? jt('diagnostics.attention.orderPrevious', 'Newest first · in the previous launch')
          : jt('diagnostics.attention.order', 'Newest first'));
    }
    if (!merged.length) {
      paintMarkup(list, '');
      return;
    }
    // The card module owns the entry markup; folds open in the live DOM stay open across a repaint, the
    // markup memo holds content only (toggling a fold never forces one), and a repaint for new content
    // gives focus back to the control that had it.
    var openGroups = issueCard.openGroupsIn(list);
    var focused = issueCard.focusedControlIn(list);
    var overview = document.getElementById('diagnosticsOverview');
    var scroller = overview?.dataset.stacked === 'true' ? overview : list;
    var scrollTop = scroller.scrollTop;
    var anchor = scrollTop > 0 ? Array.from(list.children).find(function (row) {
      return row.getBoundingClientRect().bottom > scroller.getBoundingClientRect().top;
    }) : null;
    var anchorGroup = anchor?.dataset.issueGroup;
    var anchorTop = anchor?.getBoundingClientRect().top;
    var painted = paintMarkup(list, issueCard.renderIssueList(issues, {
      availableActions: globalThis.rendererDiagnosticsActions,
      formatWhen: prior ? format.formatMoment : format.formatClock,
      formatDetailTime: format.formatDetailTime,
      safeCorrelationValue: format.safeCorrelationValue,
      statusLabel: format.statusLabel,
    }));
    if (painted) {
      issueCard.restoreOpenGroups(list, openGroups);
      issueCard.restoreFocus(list, focused);
      var restored = anchorGroup && Array.from(list.children).find(function (row) { return row.dataset.issueGroup === anchorGroup; });
      scroller.scrollTop = scrollTop;
      if (restored) scroller.scrollTop += restored.getBoundingClientRect().top - anchorTop;
    }
  }

  // Performance owns its section (row 57): the Overview hands it the live backend once per paint.
  function renderPerformance(state) {
    var prior = Boolean(state.diagnosticsSnapshot) && runtimeFacts.isPriorLaunch(state);
    performanceUtils.renderPerformanceSection?.(state, { backend: liveBackend(state), paintMarkup: paintMarkup, prior: prior });
  }

  function renderOverview(state, entries) {
    var issues = issueUtils.groupIssues ? issueUtils.groupIssues(entries) : [];
    var merged = explanations.mergeByExplanation ? explanations.mergeByExplanation(issues) : [];
    var evidence = reportUtils.selectRunEvidence
      ? reportUtils.selectRunEvidence(state.diagnosticsSnapshot, selectedRunId(state))
      : { sources: {}, integrity: {} };
    renderStatus(state, merged, evidence);
    renderAttention(issues, merged, Boolean(state.diagnosticsSnapshot) && runtimeFacts.isPriorLaunch(state));
    runtimeFacts.renderRuntimeInventory(state);
    renderPerformance(state);
  }

  return Object.freeze({
    renderOverview: renderOverview,
  });
});
