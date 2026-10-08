/* renderer/shell/renderer-diagnostics-issue-card.js - Diagnostics "Recent issues"
 * entries: a plain title, a cause, one action and the evidence folded (UX-007).
 * Pure markup: render-utils reads the open folds from the DOM and paints. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('../shared/diagnostics-issue-explanations'),
      require('../inventory/action-button')
    );
    return;
  }
  root.rendererDiagnosticsIssueCard = factory(root.rendererDiagnosticsIssueExplanations || {}, root.inventoryActionButton);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (explanations, actionButton) {
  'use strict';
  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  var jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };
  var escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;
  var MAX_ISSUES = 20;
  var INSPECT_ACTION = 'inspect-diagnostic-issue';

  function text(value) { return typeof value === 'string' ? value.trim() : ''; }
  function pad(value) { return String(value).padStart(2, '0'); }
  function identity(value) { return String(value == null ? '' : value); }
  function formatNumber(value) {
    var number = Number(value);
    return Number.isFinite(number) ? number.toLocaleString(globalThis.jennyI18n && globalThis.jennyI18n.tag && globalThis.jennyI18n.tag()) : identity(value);
  }
  function dataOf(entry) {
    if (entry && entry.data && typeof entry.data === 'object') return entry.data;
    return entry && entry.details && typeof entry.details === 'object' ? entry.details : null;
  }

  function clockTime(ts) {
    var date = new Date(ts);
    if (!Number.isFinite(date.getTime())) return '';
    return pad(date.getHours()) + ':' + pad(date.getMinutes());
  }

  function unique(values) {
    return values.filter(function (value, index) { return value && values.indexOf(value) === index; });
  }

  // The latest WARN/ERROR record behind a group, for data groupIssues drops (durationMs, channel). The match
  // is the group key (event, component, code) at the group's timestamp, so same-event groups never borrow data.
  function latestData(group, entries) {
    var match = (Array.isArray(entries) ? entries : []).find(function (entry) {
      return entry && entry.event === group.event && identity(entry.ts) === identity(group.ts)
        && text(entry.component) === text(group.component) && text(entry.error_code) === text(group.error_code)
        && dataOf(entry);
    });
    return match ? dataOf(match) : null;
  }

  function countPhrase(merged) {
    var count = { count: formatNumber(merged.count) };
    if (merged.members.length > 1) return jtn('diagnostics.issues.countEvents', merged.count, count, '{count} event', '{count} events');
    if (merged.count === 1) return jt('diagnostics.issues.countOnce', 'once');
    return jtn('diagnostics.issues.countTimes', merged.count, count, '{count} time', '{count} times');
  }

  function inspectLink(member) {
    return actionButton({
      id: INSPECT_ACTION, label: jt('diagnostics.inspectActivity', 'Inspect activity'),
      plain: true, className: 'diagnostics-issue-link', dataset: { issue: encodeURIComponent(member.key) },
    });
  }

  function correlationMarkup(members, options) {
    var seen = {};
    var pairs = [];
    members.forEach(function (member) {
      Object.entries(member.correlations || {}).forEach(function (pair) {
        if (seen[pair[0]] || !text(identity(pair[1]))) return;
        seen[pair[0]] = true;
        pairs.push(pair);
      });
    });
    if (!pairs.length) return '';
    var label = function (key) { return options.statusLabel ? options.statusLabel(key.replace('_id', '')) : key; };
    var safe = options.safeCorrelationValue || identity;
    return '<div class="diagnostics-issue-correlations" aria-label="' + escapeHtml(jt('diagnostics.issues.correlationIdentifiers', 'Correlation identifiers')) + '">'
      + pairs.map(function (pair) {
        var value = safe(pair[1]);
        return '<span><span>' + escapeHtml(label(pair[0])) + '</span><code title="' + escapeHtml(value) + '">' + escapeHtml(value) + '</code></span>';
      }).join('') + '</div>';
  }

  function row(label, body) {
    return body ? '<dt>' + escapeHtml(label) + '</dt><dd>' + body + '</dd>' : '';
  }

  // The fold links every member the button does not cover: all of them behind a mapped action, the members
  // after the first behind the Inspect fallback (the button already scopes Activity to the first).
  function techBody(merged, options, buttonIsInspect) {
    var members = merged.members;
    var events = members.map(function (member, index) {
      return '<span class="diagnostics-issue-event"><code>' + escapeHtml(member.event) + '</code> ×' + escapeHtml(formatNumber(member.count))
        + (!buttonIsInspect || index > 0 ? ' ' + inspectLink(member) : '') + '</span>';
    }).join(' · ');
    var components = unique(members.map(function (member) { return text(member.component); }));
    var codes = unique(members.map(function (member) { return text(member.error_code); }));
    var message = members.map(function (member) { return text(member.message) !== member.event ? text(member.message) : ''; }).find(Boolean);
    var advice = members.map(function (member) { return text(member.remediation); }).find(Boolean);
    var data = members[0].data && typeof members[0].data === 'object' ? members[0].data : null;
    var channel = data && text(data.channel);
    var detailTime = options.formatDetailTime || identity;
    return '<dl class="diagnostics-issue-tech-body">'
      + row(jtn('diagnostics.issues.tech.events', members.length, {}, 'Event', 'Events'), events)
      + row(jt('diagnostics.issues.tech.area', 'Area'), components.map(function (component) { return '<code>' + escapeHtml(component) + '</code>'; }).join(' · ') + ' · ' + escapeHtml(merged.explanation.area))
      + row(jt('diagnostics.issues.tech.code', 'Code'), codes.map(function (code) { return '<code>' + escapeHtml(code) + '</code>'; }).join(' · '))
      + row(jt('diagnostics.issues.request', 'Request'), channel ? '<code>' + escapeHtml(channel) + '</code>' : '')
      + row(jt('diagnostics.source.lastSeen', 'Last seen'), merged.ts ? '<span class="diagnostics-issue-mono">' + escapeHtml(detailTime(merged.ts)) + '</span>' : '')
      + row(jt('diagnostics.issues.recordedMessage', 'Recorded message'), message
        ? '<span class="diagnostics-issue-raw">' + escapeHtml(message) + '</span>'
        : '<span class="diagnostics-muted">' + escapeHtml(jt('diagnostics.issues.none', 'None')) + '</span>')
      + row(jt('diagnostics.issues.recordedAdvice', 'Recorded advice'), advice ? escapeHtml(advice) : '')
      + row(jt('diagnostics.issues.tech.correlation', 'Correlation'), correlationMarkup(members, options))
      + '</dl>';
  }

  function renderEntry(merged, options) {
    var explanation = merged.explanation;
    var first = merged.members[0];
    var action = explanation.action;
    var available = options.availableActions && typeof options.availableActions === 'object' ? options.availableActions : {};
    var mapped = Boolean(action && available[action.id] === true);
    var button = actionButton({
      id: mapped ? action.id : INSPECT_ACTION,
      label: mapped ? action.label : jt('diagnostics.inspectActivity', 'Inspect activity'),
      size: 'sm', className: 'diagnostics-issue-action-button', dataset: { issue: encodeURIComponent(first.key) },
    });
    var isError = merged.severity === 'ERROR';
    var when = merged.ts
      ? '<time datetime="' + escapeHtml(merged.ts) + '" title="' + escapeHtml((options.formatDetailTime || identity)(merged.ts)) + '">' + escapeHtml(clockTime(merged.ts) || merged.ts) + '</time> · '
      : '';
    return '<article class="diagnostics-issue" role="listitem" data-severity="' + escapeHtml(merged.severity) + '" data-issue-group="' + escapeHtml(explanation.id) + '">'
      + '<div class="diagnostics-issue-title">'
      + '<span class="diagnostics-issue-badge" data-tone="' + (isError ? 'danger' : 'warning') + '">' + escapeHtml(isError ? jt('diagnostics.issues.severity.error', 'Error') : jt('diagnostics.issues.severity.warning', 'Warning')) + '</span>'
      + '<strong>' + escapeHtml(explanation.title) + '</strong>'
      + '<span class="diagnostics-issue-when">' + when + escapeHtml(countPhrase(merged)) + '</span></div>'
      + '<p class="diagnostics-issue-cause">' + escapeHtml(explanation.cause) + '</p>'
      + '<div class="diagnostics-issue-actions">' + button
      + '<details class="diagnostics-issue-tech" data-issue-group="' + escapeHtml(explanation.id) + '">'
      + '<summary>' + escapeHtml(jt('diagnostics.issues.technicalDetails', 'Technical details')) + '</summary>'
      + techBody(merged, options, !mapped) + '</details></div></article>';
  }

  // groups: groupIssues output. options: {availableActions: {[actionId]: true}, entries, formatDetailTime,
  // safeCorrelationValue, statusLabel}. The markup carries content only (no fold state), so the painter's memo
  // changes only when the content does; open folds are restored on the painted DOM by restoreOpenGroups.
  function renderIssueList(groups, options) {
    var settings = options || {};
    // Explanations read the latest record's data (durationMs), which groupIssues leaves out.
    var decorated = (Array.isArray(groups) ? groups : []).map(function (group) {
      var data = group && latestData(group, settings.entries);
      return data ? Object.assign({}, group, { data: data }) : group;
    });
    var merged = typeof explanations.mergeByExplanation === 'function' ? explanations.mergeByExplanation(decorated) : [];
    return merged.slice(0, MAX_ISSUES).map(function (entry) { return renderEntry(entry, settings); }).join('');
  }

  function openGroupsIn(host) {
    var open = new Set();
    if (!host || typeof host.querySelectorAll !== 'function') return open;
    host.querySelectorAll('details.diagnostics-issue-tech[open]').forEach(function (node) {
      var id = node.getAttribute('data-issue-group');
      if (id) open.add(id);
    });
    return open;
  }

  // The control inside the list that holds focus, as a selector that survives a repaint of the same content:
  // the fold summary, or an action/inspect control by its action and issue key.
  function focusedControlIn(host) {
    var active = host && host.ownerDocument && host.ownerDocument.activeElement;
    if (!active || typeof host.contains !== 'function' || !host.contains(active)) return '';
    var entry = typeof active.closest === 'function' ? active.closest('[data-issue-group]') : null;
    var group = entry && entry.getAttribute('data-issue-group');
    if (!group) return '';
    var scope = '[data-issue-group="' + cssString(group) + '"] ';
    if (active.tagName === 'SUMMARY') return scope + 'summary';
    var action = active.getAttribute('data-action');
    var issue = active.getAttribute('data-issue');
    return action ? scope + '[data-action="' + cssString(action) + '"]' + (issue ? '[data-issue="' + cssString(issue) + '"]' : '') : '';
  }

  function cssString(value) {
    return String(value).replace(/["\\]/g, '\\$&');
  }

  function restoreFocus(host, selector) {
    if (!host || !selector || typeof host.querySelector !== 'function') return;
    var node = host.querySelector(selector);
    if (node && typeof node.focus === 'function') node.focus({ preventScroll: true });
  }

  // Re-opens the folds of the given explanation ids after a repaint.
  function restoreOpenGroups(host, openGroups) {
    if (!host || typeof host.querySelectorAll !== 'function' || !openGroups || typeof openGroups.has !== 'function') return;
    host.querySelectorAll('details.diagnostics-issue-tech').forEach(function (node) {
      if (openGroups.has(node.getAttribute('data-issue-group'))) node.open = true;
    });
  }

  return Object.freeze({
    renderIssueList: renderIssueList, openGroupsIn: openGroupsIn, restoreOpenGroups: restoreOpenGroups,
    focusedControlIn: focusedControlIn, restoreFocus: restoreFocus,
  });
});
