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

  // A record with no layer or source is the App (electron), as sourceLabel names it.
  function entrySource(entry) {
    return String(entry.layer || entry.source || 'electron').toLowerCase();
  }

  function filterEntries(state, entries, scopeGroup) {
    var view = diagnosticsState(state);
    var query = String(view.query || '').trim().toLowerCase();
    var scoped = Boolean(view.issueScope);
    var group = scopeGroup === undefined ? groupForScope(view.issueScope, entries) : scopeGroup;
    return entries.filter(function (entry) {
      var level = String(entry.level || '').toLowerCase();
      var source = entrySource(entry);
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

  function levelIcon(level) {
    var key = String(level || '').toUpperCase();
    return typeof stateIcon === 'function' && typeof stateIcon.forLevel === 'function' ? stateIcon.forLevel(key, { size: 'sm' }) : '';
  }

  // The 16 px level cell: a stroke icon for errors and warnings, muted "dbg" for debug, nothing for info.
  function levelCell(level, icon) {
    if (icon) return icon;
    return String(level || '').toUpperCase() === 'DEBUG' ? escapeHtml(jt('diagnostics.activity.debugShort', 'dbg')) : '';
  }

  function renderActivityRow(entry, selectedEntryId, focusable) {
    var id = entryId(entry);
    var selected = id === selectedEntryId;
    var timestamp = String(entry.ts || '');
    var eventName = String(entry.event || 'event');
    var message = displayMessage(entry.message || entry.details?.message, eventName);
    var icon = levelIcon(entry.level);
    return '<article class="log-entry" role="option" aria-controls="logDetailPanel"'
      + ' aria-label="' + escapeHtml(activityRowAriaLabel(entry, timestamp, eventName, message)) + '"'
      + ' data-log-index="' + escapeHtml(id) + '" data-entry-id="' + escapeHtml(id) + '"'
      + ' data-level="' + escapeHtml(String(entry.level || 'INFO').toLowerCase()) + '"'
      + ' tabindex="' + (focusable || selected ? '0' : '-1') + '" aria-selected="' + selected + '">'
      + '<time datetime="' + escapeHtml(timestamp) + '" title="' + escapeHtml(timestamp || jt('diagnostics.common.unknownTime', 'Unknown time')) + '">'
      + escapeHtml(formatCompactTime(timestamp)) + '</time>'
      + '<span class="log-entry-level" aria-hidden="true"' + (icon ? ' title="' + escapeHtml(levelWord(entry.level)) + '"' : '') + '>' + levelCell(entry.level, icon) + '</span>'
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
    // A virtualized row is a blank placeholder, and mounting it later would restore its stashed tabindex:
    // mount the tab stop first so the stop is a real row and keeps tabindex 0.
    if (stop && stop !== selected) virtualizer?.ensureMountedForId?.(stop.dataset.entryId);
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
      + (count > 0 ? '<span class="diagnostics-scope-count">' + escapeHtml(jtn('diagnostics.activity.scopeCount', count, { count: formatNumber(count) }, '{count} record', '{count} records')) + '</span>' : '')
      + clear);
  }

  // A launch with no records says why: not loaded yet, failed to load, a finished launch, or still starting.
  function noRecordsMarkup(state) {
    // The logs refresher sets the snapshot; a failed refresh sets it too, with refresh_logs_failed.
    if (!state.diagnosticsSnapshot) return emptyNote({ text: jt('diagnostics.activity.loadingRecords', 'Loading records…'), role: 'status' });
    var reasons = state.diagnosticsSnapshot?.integrity?.partial_reasons;
    if (Array.isArray(reasons) && reasons.includes('refresh_logs_failed')) {
      return emptyNote({ text: jt('diagnostics.activity.recordsUnavailable', 'Records couldn’t load.'), hint: jt('diagnostics.activity.recordsUnavailableHint', 'Refresh on Overview to try again.') });
    }
    var activeRunId = page.activeRunId(state);
    if (activeRunId && selectedRunId(state) !== activeRunId) {
      return emptyNote({ text: jt('diagnostics.activity.previousLaunchEmpty', 'The previous launch left no records.'), hint: jt('diagnostics.activity.previousLaunchEmptyHint', 'Choose This launch to see what Jenny is doing now.') });
    }
    return emptyNote({ text: jt('diagnostics.activity.noRecordsYet', 'No records yet.'), hint: jt('diagnostics.activity.noRecordsYetHint', 'Records appear as Jenny works.') });
  }

  function emptyListMarkup(state, entries, view, group) {
    if (!entries.length) return noRecordsMarkup(state);
    if (view.issueScope && !group) {
      return emptyNote({ text: jt('diagnostics.activity.noRecordsForIssue', 'No records for this issue in this launch.') });
    }
    var clear = typeof actionButton === 'function'
      ? actionButton({ id: 'clear-diagnostics-filters', label: jt('diagnostics.activity.clearFilters', 'Clear search and filters'), plain: true, className: 'diagnostics-issue-link diagnostics-empty-action' })
      : '';
    return emptyNote({ text: jt('diagnostics.activity.noRecordsMatch', 'No records match.') }) + clear;
  }

  // The match count is announced once the filters stop changing, not on every keystroke.
  var ANNOUNCE_DELAY_MS = 600;

  function scheduleAnnouncement(cache, signature, filteredCount) {
    if (cache.filterAnnouncementSignature !== signature) {
      cache.filterAnnouncementSignature = signature;
      clearTimeout(cache.announceTimer);
      cache.announceTimer = setTimeout(function () {
        cache.announceTimer = null;
        announce(cache.announceMessage, cache.announceKey);
      }, ANNOUNCE_DELAY_MS);
    }
    if (!cache.announceTimer) return;
    cache.announceMessage = jtn('diagnostics.activity.matchingEventCount', filteredCount, { count: filteredCount }, '{count} matching event.', '{count} matching events.');
    cache.announceKey = 'activity|' + signature + '|' + filteredCount;
  }

  // The focused row keeps focus; when it leaves, the next surviving row takes it, else the previous, else the first.
  function focusedRow(list) {
    return list.contains(document.activeElement) ? document.activeElement.closest('[data-entry-id]') : null;
  }

  function focusToKeep(list, previousIds, ids) {
    var focusId = focusedRow(list)?.dataset.entryId || '';
    if (focusId && !ids.includes(focusId)) {
      var focusIndex = previousIds.indexOf(focusId);
      focusId = previousIds.slice(focusIndex + 1).find(function (id) { return ids.includes(id); })
        || previousIds.slice(0, focusIndex).reverse().find(function (id) { return ids.includes(id); })
        || ids[0];
    }
    return focusId;
  }

  function moveFocusTo(list, focusId) {
    if (!focusId) return;
    var focusTarget = findRow(list, focusId);
    list.querySelectorAll('[data-entry-id]').forEach(function (row) {
      var tabIndex = row === focusTarget ? 0 : -1;
      if (row.tabIndex !== tabIndex) row.tabIndex = tabIndex;
    });
    focusTarget?.focus({ preventScroll: true });
  }

  // Retention drops old rows from anywhere in the list and adds new ones at the end. When the rows
  // that stay keep their order and only new ids follow, the list can be edited in place instead of rebuilt.
  function trimPlan(previousIds, ids) {
    var kept = new Set(ids);
    var survivors = previousIds.filter(function (id) { return kept.has(id); });
    if (!survivors.length || survivors.length === previousIds.length) return null;
    var known = new Set(previousIds);
    var inOrder = survivors.every(function (id, index) { return ids[index] === id; })
      && ids.slice(survivors.length).every(function (id) { return !known.has(id); });
    return inOrder ? { dropped: new Set(previousIds.filter(function (id) { return !kept.has(id); })), keep: survivors.length } : null;
  }

  // The first surviving row still in view and where it sits, so the reader's rows do not move when rows
  // above leave. A row about to be dropped cannot anchor: once removed its rect is all zeros.
  function scrollAnchor(list, dropped) {
    var top = list.getBoundingClientRect().top;
    var row = Array.from(list.querySelectorAll('[data-entry-id]')).find(function (candidate) {
      return !dropped.has(candidate.dataset.entryId) && candidate.getBoundingClientRect().bottom > top;
    });
    return row ? { row: row, offset: row.getBoundingClientRect().top - top } : null;
  }

  function restoreAnchor(list, anchor) {
    if (!anchor) return;
    list.scrollTop += (anchor.row.getBoundingClientRect().top - list.getBoundingClientRect().top) - anchor.offset;
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
    var emptyHost = document.getElementById('logEmpty');
    var label = document.getElementById('logResultsLabel');
    if (label) {
      label.textContent = filtered.length === entries.length
        ? jtn('diagnostics.activity.recordCount', entries.length, { count: formatNumber(entries.length) }, '{count} record', '{count} records')
        : jt('diagnostics.activity.recordsShown', '{shown} of {total} records', { shown: formatNumber(filtered.length), total: formatNumber(entries.length) });
    }
    renderScope(view);
    var activityRoot = document.getElementById('diagnosticsActivity');
    if (activityRoot) {
      activityRoot.dataset.scoped = String(Boolean(view.issueScope));
      // Two facts the stylesheet reads: whether the launch has records at all, and whether the filtered list has rows.
      activityRoot.dataset.records = entries.length ? 'some' : 'none';
      activityRoot.dataset.list = filtered.length ? 'rows' : 'empty';
    }

    var activeRunId = String(state.diagnosticsSnapshot?.active_run?.run_id || '');
    var currentRunSelected = !activeRunId || selectedRunId(state) === activeRunId;
    var follow = document.getElementById('logAutoScrollToggle');
    if (follow) {
      var following = currentRunSelected && view.autoScroll;
      follow.disabled = !currentRunSelected || !entries.length;
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
    if (entries.length) scheduleAnnouncement(cache, filterSignature, filtered.length);
    else {
      // A launch with no records has its own note (a status while loading); a "0 matching events" would talk over it.
      clearTimeout(cache.announceTimer);
      cache.announceTimer = null;
      cache.filterAnnouncementSignature = filterSignature;
    }

    // The note lives beside the listbox, never inside it: a button may not be a child of role="listbox".
    if (!filtered.length) {
      var emptyMarkup = emptyListMarkup(state, entries, view, group);
      if (emptyHost) {
        paintMarkup(emptyHost, emptyMarkup);
        emptyHost.hidden = false;
      }
      paintMarkup(list, '');
      list.hidden = true;
      cache.signature = filterSignature;
      cache.ids = [];
      cache.selectedEntryId = '';
      virtualizer?.rebuild?.();
      return;
    }
    // Rows came back while focus sat on Clear search and filters: the search field takes it, not the page body.
    var emptyHadFocus = Boolean(emptyHost && emptyHost.contains(document.activeElement));
    if (emptyHost) {
      paintMarkup(emptyHost, '');
      emptyHost.hidden = true;
    }
    list.hidden = false;
    if (emptyHadFocus) document.getElementById('logSearchInput')?.focus?.();

    var idsMatch = cache.ids.length === ids.length && cache.ids.every(function (id, index) { return id === ids[index]; });
    var canAppend = cache.ids.length > 0
      && cache.signature === filterSignature
      && cache.ids.length < ids.length
      && cache.ids.every(function (id, index) { return id === ids[index]; });
    var trim = !canAppend && !idsMatch && cache.signature === filterSignature ? trimPlan(cache.ids, ids) : null;
    var mutated = false;
    if (canAppend) {
      list.insertAdjacentHTML('beforeend', filtered.slice(cache.ids.length).map(function (entry) {
        return renderActivityRow(entry, view.selectedEntryId, false);
      }).join(''));
      page.forgetMarkup(list);
      settleRows(list, view.selectedEntryId, virtualizer);
      mutated = true;
    } else if (trim) {
      var anchor = view.autoScroll && !view.selectedEntryId ? null : scrollAnchor(list, trim.dropped);
      // Surviving nodes keep their focus; only a dropped focused row hands it on.
      var focused = focusedRow(list);
      var keepFocus = focused && trim.dropped.has(focused.dataset.entryId) ? focusToKeep(list, cache.ids, ids) : '';
      Array.from(list.querySelectorAll('[data-entry-id]')).forEach(function (row) {
        if (trim.dropped.has(row.dataset.entryId)) row.remove();
      });
      list.insertAdjacentHTML('beforeend', filtered.slice(trim.keep).map(function (entry) {
        return renderActivityRow(entry, view.selectedEntryId, false);
      }).join(''));
      page.forgetMarkup(list);
      moveFocusTo(list, keepFocus);
      settleRows(list, view.selectedEntryId, virtualizer);
      restoreAnchor(list, anchor);
      mutated = true;
    } else if (cache.signature !== filterSignature || !idsMatch) {
      var focusId = focusToKeep(list, cache.ids, ids);
      list.innerHTML = filtered.map(function (entry, index) {
        return renderActivityRow(entry, view.selectedEntryId, !view.selectedEntryId && index === 0);
      }).join('');
      page.forgetMarkup(list);
      moveFocusTo(list, focusId);
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
    var icon = levelIcon(entry.level);
    var meta = [levelWord(entry.level), format.formatDetailTime(entry.ts), sourceLabel(entry.layer || entry.source)].join(' · ');
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
      '<div class="diagnostics-detail-head"><span class="diagnostics-detail-icon">' + icon + '</span>'
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
