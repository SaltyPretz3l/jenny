(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./renderer-diagnostics-page'),
      require('./renderer-diagnostics-format'),
      require('../shared/diagnostics-issue-utils'),
      require('../inventory/action-button'),
      require('../inventory/codeblock'),
      require('../shared/log-contract-utils'),
      require('../inventory/state-icon'),
      require('../inventory/empty-note'),
      require('../shared/diagnostics-issue-explanations')
    );
    return;
  }
  root.rendererDiagnosticsActivity = factory(
    root.rendererDiagnosticsPage,
    root.rendererDiagnosticsFormat,
    root.diagnosticsIssueUtils || {},
    root.inventoryActionButton,
    root.inventoryCodeBlock || {},
    root.logContractUtils || {},
    root.inventoryStateIcon,
    root.inventoryEmptyNote,
    root.rendererDiagnosticsIssueExplanations || {}
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (
  page,
  format,
  issueUtils,
  actionButton,
  codeBlock,
  logContractUtils,
  stateIcon,
  emptyNote,
  explanations
) {
  'use strict';
  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  var jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };
  var escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;
  var formatNumber = format.formatNumber;
  var formatCompactTime = format.formatCompactTime;
  var statusLabel = format.statusLabel;
  var sourceLabel = format.sourceLabel;
  var displayMessage = format.displayMessage;
  var safeCorrelationValue = format.safeCorrelationValue;
  var paintMarkup = page.paintMarkup;
  var announce = page.announce;
  var diagnosticsState = page.diagnosticsState;
  var selectedRunId = page.selectedRunId;

  function entryId(entry) {
    return String(entry.entry_id || entry.origin_entry_id || entry.sequence || '');
  }

  // The scope is the issue group the owner opened, found again on every paint from the entries on
  // screen: new members appear, and a group that left the launch matches nothing.
  function groupForScope(scope, entries) {
    if (!scope || !scope.key || typeof issueUtils.groupIssues !== 'function') return null;
    return issueUtils.groupIssues(entries).find(function (group) { return group.key === scope.key; }) || null;
  }

  // The explanation title when the map serves the group, else the event.
  function scopeTitle(group) {
    var explained = typeof explanations.explainIssue === 'function' ? explanations.explainIssue(group) : null;
    return explained && String(explained.id).indexOf('fallback:') !== 0 ? explained.title : group.event;
  }

  function issueScopeFor(group, key) {
    return { key: String(key || ''), title: group ? scopeTitle(group) : '', count: group ? group.count : 0 };
  }

  function levelWord(level) {
    var key = String(level || 'INFO').toUpperCase();
    if (key === 'ERROR') return statusLabel('error');
    if (key === 'WARN') return statusLabel('warn');
    if (key === 'DEBUG') return jt('shell.bootstrap.diagnostics.debug', 'Debug');
    return jt('shell.bootstrap.diagnostics.info', 'Info');
  }

  function filterEntries(state, entries, scopeGroup) {
    var view = diagnosticsState(state);
    var query = String(view.query || '').trim().toLowerCase();
    var scoped = Boolean(view.issueScope);
    var group = scopeGroup === undefined ? groupForScope(view.issueScope, entries) : scopeGroup;
    return entries.filter(function (entry) {
      var level = String(entry.level || '').toLowerCase();
      var source = String(entry.layer || entry.source || '').toLowerCase();
      if (view.levelFilter !== 'all' && level !== view.levelFilter) return false;
      if (view.sourceFilter !== 'all' && source !== view.sourceFilter) return false;
      if (scoped && !(group && issueUtils.issueEntryMatches(group, entry))) return false;
      if (!query) return true;
      return [entry.event, entry.component, entry.message, entry.details?.message, issueUtils.errorCode ? issueUtils.errorCode(entry) : '',
        source, entry.trace_id, entry.request_id, entry.session_id, entry.stream_id, entry.data?.streamId, entry.data?.stream_id]
        .filter(function (value) { return typeof value === 'string'; })
        .some(function (value) { return value.toLowerCase().includes(query); });
    });
  }

  function activityRowAriaLabel(entry, timestamp, eventName, message) {
    var boundedMessage = String(message || jt('diagnostics.activity.noAdditionalMessage', 'No additional message'));
    if (boundedMessage.length > 320) boundedMessage = boundedMessage.slice(0, 319) + '…';
    return [
      jt('diagnostics.activity.timeLabel', 'Time {time}', { time: timestamp || jt('diagnostics.common.unknown', 'Unknown') }),
      jt('diagnostics.activity.levelLabel', 'Level {level}', { level: String(entry.level || 'INFO') }),
      jt('diagnostics.activity.sourceLabel', 'Source {source}', { source: sourceLabel(entry.layer || entry.source) }),
      jt('diagnostics.activity.eventLabel', 'Event {event}', { event: eventName }),
      jt('diagnostics.activity.messageLabel', 'Message {message}', { message: boundedMessage }),
    ].join(', ');
  }

  // The 16 px level cell: a stroke icon for errors and warnings, muted "dbg" for debug, nothing for info.
  function levelCell(level) {
    var key = String(level || '').toUpperCase();
    var icon = typeof stateIcon === 'function' && typeof stateIcon.forLevel === 'function' ? stateIcon.forLevel(key, { size: 'sm' }) : '';
    if (icon) return icon;
    return key === 'DEBUG' ? escapeHtml(jt('diagnostics.activity.debugShort', 'dbg')) : '';
  }

  function renderActivityRow(entry, selectedEntryId, focusable) {
    var id = entryId(entry);
    var selected = id === selectedEntryId;
    var timestamp = String(entry.ts || '');
    var eventName = String(entry.event || 'event');
    var message = displayMessage(entry.message || entry.details?.message, eventName);
    return '<article class="log-entry" role="option" aria-controls="logDetailPanel"'
      + ' aria-label="' + escapeHtml(activityRowAriaLabel(entry, timestamp, eventName, message)) + '"'
      + ' title="' + escapeHtml(levelWord(entry.level)) + '"'
      + ' data-log-index="' + escapeHtml(id) + '" data-entry-id="' + escapeHtml(id) + '"'
      + ' data-level="' + escapeHtml(String(entry.level || 'INFO').toLowerCase()) + '"'
      + ' tabindex="' + (focusable || selected ? '0' : '-1') + '" aria-selected="' + selected + '">'
      + '<time datetime="' + escapeHtml(timestamp) + '" title="' + escapeHtml(timestamp || jt('diagnostics.common.unknownTime', 'Unknown time')) + '">'
      + escapeHtml(formatCompactTime(timestamp)) + '</time>'
      + '<span class="log-entry-level" aria-hidden="true">' + levelCell(entry.level) + '</span>'
      + '<span class="log-entry-message' + (message ? '' : ' diagnostics-muted') + '">'
      + (message ? escapeHtml(message) : '<span class="log-entry-no-message" aria-hidden="true">—</span>'
        // Below 900 px the Event column drops, so a message-less row names its event instead of a bare dash.
        + '<code class="log-entry-message-event" aria-hidden="true"><bdi>' + escapeHtml(eventName) + '</bdi></code>'
        + '<span class="sr-only">' + escapeHtml(jt('diagnostics.activity.noAdditionalMessage', 'No additional message')) + '</span>') + '</span>'
      + '<code class="log-entry-event"><bdi>' + escapeHtml(eventName) + '</bdi></code>'
      + '<span class="log-entry-source">' + escapeHtml(sourceLabel(entry.layer || entry.source)) + '</span>'
      + '</article>';
  }

  function findRow(list, id) {
    return Array.from(list?.querySelectorAll?.('[data-entry-id]') || []).find(function (row) {
      return row.dataset.entryId === id;
    }) || null;
  }

  // One pass keeps aria-selected true on the selected row only and exactly one roving tab stop:
  // the focused row, else the selected row, else the first.
  function settleRows(list, selectedId, virtualizer) {
    if (!list) return;
    var rows = Array.from(list.querySelectorAll('[data-entry-id]'));
    var selected = selectedId ? rows.find(function (row) { return row.dataset.entryId === selectedId; }) : null;
    if (selected) virtualizer?.ensureMountedForId?.(selectedId);
    var focused = list.contains(document.activeElement) ? document.activeElement.closest('[data-entry-id]') : null;
    var stop = focused || selected || rows[0] || null;
    rows.forEach(function (row) {
      var isSelected = row === selected;
      if (row.getAttribute('aria-selected') !== String(isSelected)) row.setAttribute('aria-selected', String(isSelected));
      var tabIndex = row === stop ? 0 : -1;
      if (row.tabIndex !== tabIndex) row.tabIndex = tabIndex;
    });
  }

  function renderScope(view) {
    var scope = document.getElementById('diagnosticsActivityScope');
    if (!scope) return;
    scope.hidden = !view.issueScope;
    if (!view.issueScope) {
      paintMarkup(scope, '');
      return;
    }
    var title = view.issueScope.title || jt('diagnostics.activity.thisIssue', 'this issue');
    var count = view.issueScope.count;
    var clear = typeof actionButton === 'function'
      ? actionButton({ id: 'clear-diagnostics-scope', domId: 'diagnosticsClearScope', label: jt('diagnostics.activity.showAllRecords', 'Show all records'), plain: true, className: 'diagnostics-text-button' })
      : '';
    paintMarkup(scope,
      '<span class="diagnostics-scope-label">' + escapeHtml(jt('diagnostics.activity.showingRecordsFor', 'Showing records for {title}', { title: title })) + '</span>'
      + '<span class="diagnostics-scope-count">' + escapeHtml(jtn('diagnostics.activity.scopeCount', count, { count: formatNumber(count) }, '{count} record', '{count} records')) + '</span>'
      + clear);
  }

  function emptyListMarkup(entries, view, group) {
    if (!entries.length) {
      return emptyNote({ text: jt('diagnostics.activity.noRecordsYet', 'No records yet.'), hint: jt('diagnostics.activity.noRecordsYetHint', 'Records appear as Jenny works.') });
    }
    if (view.issueScope && !group) {
      return emptyNote({ text: jt('diagnostics.activity.noRecordsForIssue', 'No records for this issue in this launch.') });
    }
    return emptyNote({ text: jt('diagnostics.activity.noRecordsMatch', 'No records match.'), hint: jt('diagnostics.activity.noRecordsMatchHint', 'Clear the search or filters.') });
  }

  function renderActivity(state, entries, virtualizer, cache) {
    var view = diagnosticsState(state);
    var group = groupForScope(view.issueScope, entries);
    if (view.issueScope) {
      var refreshed = issueScopeFor(group, view.issueScope.key);
      view.issueScope.count = refreshed.count;
      if (refreshed.title) view.issueScope.title = refreshed.title;
    }
    var filtered = filterEntries(state, entries, group);
    var list = document.getElementById('logList');
    var label = document.getElementById('logResultsLabel');
    if (label) {
      label.textContent = filtered.length === entries.length
        ? jtn('diagnostics.activity.recordCount', entries.length, { count: formatNumber(entries.length) }, '{count} record', '{count} records')
        : jt('diagnostics.activity.recordsShown', '{shown} of {total} records', { shown: formatNumber(filtered.length), total: formatNumber(entries.length) });
    }
    renderScope(view);
    var activityRoot = document.getElementById('diagnosticsActivity');
    if (activityRoot) activityRoot.dataset.scoped = String(Boolean(view.issueScope));

    var activeRunId = String(state.diagnosticsSnapshot?.active_run?.run_id || '');
    var currentRunSelected = !activeRunId || selectedRunId(state) === activeRunId;
    var follow = document.getElementById('logAutoScrollToggle');
    if (follow) {
      var following = currentRunSelected && view.autoScroll;
      follow.disabled = !currentRunSelected;
      follow.setAttribute('aria-pressed', String(following));
      follow.classList.toggle('active', following);
    }
    if (!list) return;

    var ids = filtered.map(entryId);
    if (view.selectedEntryId && !ids.includes(view.selectedEntryId)) view.selectedEntryId = '';
    var filterSignature = [
      selectedRunId(state),
      view.query,
      view.levelFilter,
      view.sourceFilter,
      view.issueScope && view.issueScope.key,
    ].join('|');
    if (cache.filterAnnouncementSignature !== filterSignature) {
      cache.filterAnnouncementSignature = filterSignature;
      announce(jtn('diagnostics.activity.matchingEventCount', filtered.length, { count: filtered.length }, '{count} matching event.', '{count} matching events.'), 'activity|' + filterSignature + '|' + filtered.length);
    }

    if (!filtered.length) {
      var emptyMarkup = emptyListMarkup(entries, view, group);
      if (cache.signature !== filterSignature || cache.ids.length || cache.emptyMarkup !== emptyMarkup) {
        paintMarkup(list, emptyMarkup);
      }
      cache.emptyMarkup = emptyMarkup;
      cache.signature = filterSignature;
      cache.ids = [];
      cache.selectedEntryId = '';
      virtualizer?.rebuild?.();
      return;
    }
    cache.emptyMarkup = '';

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
      page.forgetMarkup(list);
      settleRows(list, view.selectedEntryId, virtualizer);
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
      page.forgetMarkup(list);
      if (focusId) {
        var rows = Array.from(list.querySelectorAll('[data-entry-id]'));
        var focusTarget = rows.find(function (row) { return row.dataset.entryId === focusId; });
        rows.forEach(function (row) { row.tabIndex = row === focusTarget ? 0 : -1; });
        focusTarget?.focus({ preventScroll: true });
      }
      mutated = true;
    } else {
      settleRows(list, view.selectedEntryId, virtualizer);
    }

    cache.signature = filterSignature;
    cache.ids = ids;
    cache.selectedEntryId = view.selectedEntryId;
    if (mutated) virtualizer?.rebuild?.();
    if (mutated && view.autoScroll && !view.selectedEntryId) scrollLogsToBottom(list);
  }

  function fact(label, value, code) {
    if (value == null || String(value).trim() === '') return '';
    return '<dt>' + escapeHtml(label) + '</dt><dd>' + (code ? '<code>' + escapeHtml(value) + '</code>' : escapeHtml(value)) + '</dd>';
  }

  function launchFact(state, entry) {
    var activeRunId = page.activeRunId(state);
    var current = !entry.run_id || !activeRunId || String(entry.run_id) === activeRunId;
    var sequence = Number(entry.sequence) > 0 ? entry.sequence : '';
    var value = sequence
      ? (current
        ? jt('diagnostics.detail.thisLaunchRecord', 'This launch · record {sequence}', { sequence: sequence })
        : jt('diagnostics.detail.previousLaunchRecord', 'Previous launch · record {sequence}', { sequence: sequence }))
      : (current ? jt('diagnostics.detail.thisLaunch', 'This launch') : jt('diagnostics.detail.previousLaunch', 'Previous launch'));
    return fact(jt('diagnostics.detail.launch', 'Launch'), value, false);
  }

  function detailClose() {
    if (typeof actionButton !== 'function') return '';
    var icon = typeof stateIcon === 'function' ? stateIcon : function () { return ''; };
    var closeLabel = jt('inventory.drawer.closeDetails', 'Close details');
    // No aria-label: the name is the text shown at each width (wide: an icon with hidden text; narrow: "Back to records").
    return actionButton({
      id: 'close-log-detail',
      domId: 'diagnosticsCloseDetail',
      plain: true,
      className: 'diagnostics-icon-button',
      title: closeLabel,
      trustedHtml: '<span class="diagnostics-detail-close-wide">' + icon('close', { size: 'sm' }) + '<span class="sr-only">' + escapeHtml(closeLabel) + '</span></span>'
        + '<span class="diagnostics-detail-close-narrow">' + icon('back', { size: 'sm' }) + escapeHtml(jt('diagnostics.activity.backToRecords', 'Back to records')) + '</span>',
    });
  }

  function renderDetail(state, entries) {
    var panel = document.getElementById('logDetailPanel');
    if (!panel) return;
    var id = diagnosticsState(state).selectedEntryId;
    var entry = entries.find(function (item) { return entryId(item) === id; });
    panel.hidden = !entry;
    var layout = document.getElementById('diagnosticsActivityLayout');
    if (layout) layout.dataset.detail = entry ? 'open' : 'closed';
    if (!entry) {
      paintMarkup(panel, '');
      return;
    }

    var details = typeof logContractUtils.redactLogReportValue === 'function'
      ? logContractUtils.redactLogReportValue(entry.data || entry.details || {})
      : (entry.data || entry.details || {});
    var title = displayMessage(entry.message || entry.details?.message, entry.event) || entry.event || 'event';
    var levelIcon = typeof stateIcon === 'function' && typeof stateIcon.forLevel === 'function' ? stateIcon.forLevel(entry.level, { size: 'sm' }) : '';
    var meta = [levelWord(entry.level), formatCompactTime(entry.ts), sourceLabel(entry.layer || entry.source)].join(' · ');
    var correlations = issueUtils.correlations ? issueUtils.correlations(entry) : {};
    var facts = fact(jt('diagnostics.labels.event', 'Event'), entry.event || 'event', true)
      + fact(jt('diagnostics.labels.component', 'Component'), entry.component || 'unknown', true)
      + Object.entries(correlations).map(function (pair) {
        return fact(statusLabel(pair[0].replace('_id', '')), safeCorrelationValue(pair[1]), true);
      }).join('')
      + launchFact(state, entry);
    var hasData = details && typeof details === 'object' ? Object.keys(details).length > 0 : Boolean(details);
    var codeMarkup = !hasData ? '' : typeof codeBlock.codeblockTruncated === 'function'
      ? codeBlock.codeblockTruncated({
        code: JSON.stringify(details, null, 2),
        language: 'json',
        label: jt('diagnostics.detail.recordedData', 'Recorded data'),
        copyable: true,
        copyIcon: true,
        copyId: 'diagnostics-detail-' + id.replace(/[^a-zA-Z0-9_-]/g, '-'),
        ariaLabel: jt('diagnostics.redactedStructuredAttributes', 'Redacted structured event attributes'),
        className: 'diagnostics-detail-code',
        maxChars: 16384,
      })
      : emptyNote({ text: jt('diagnostics.detail.structuredAttributesUnavailable', 'Structured attributes unavailable.') });
    paintMarkup(panel,
      '<div class="diagnostics-detail-head"><span class="diagnostics-detail-icon">' + levelIcon + '</span>'
      + '<div><h3>' + escapeHtml(title) + '</h3><p class="diagnostics-detail-meta">' + escapeHtml(meta) + '</p></div>' + detailClose() + '</div>'
      + '<dl class="diagnostics-facts">' + facts + '</dl>' + codeMarkup);
  }

  function scrollLogsToBottom(list) {
    var node = list || document.getElementById('logList');
    if (node) node.scrollTop = node.scrollHeight;
  }

  return Object.freeze({
    entryId: entryId,
    findRow: findRow,
    issueScopeFor: issueScopeFor,
    renderActivity: renderActivity,
    renderDetail: renderDetail,
    scrollLogsToBottom: scrollLogsToBottom,
  });
});
