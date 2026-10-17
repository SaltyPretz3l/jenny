/* renderer/shell/renderer-diagnostics-issue-card.js - Diagnostics "Needs attention" entries: a
 * severity icon, a plain title, a cause, one action and the evidence folded in Details (UX-007).
 * Pure markup: the Overview reads the open folds from the DOM and paints. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('../shared/diagnostics-issue-explanations'),
      require('../inventory/action-button'),
      require('../inventory/state-icon')
    );
    return;
  }
  root.rendererDiagnosticsIssueCard = factory(root.rendererDiagnosticsIssueExplanations || {}, root.inventoryActionButton, root.inventoryStateIcon);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (explanations, actionButton, stateIcon) {
  'use strict';
  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  var jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };
  var escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;
  var MAX_ISSUES = 20;
  var INSPECT_ACTION = 'inspect-diagnostic-issue';
  var EMPTY = '\u2014';

  function text(value) { return typeof value === 'string' ? value.trim() : ''; }
  function pad(value) { return String(value).padStart(2, '0'); }
  function identity(value) { return String(value == null ? '' : value); }
  function formatNumber(value) {
    var number = Number(value);
    return Number.isFinite(number) ? number.toLocaleString(globalThis.jennyI18n && globalThis.jennyI18n.tag && globalThis.jennyI18n.tag()) : identity(value);
  }

  function validTime(ts) {
    return Number.isFinite(new Date(ts).getTime());
  }

  // The default stamp: the clock time, or an em dash for a time that cannot be read (never the raw string).
  function clockTime(ts) {
    var date = new Date(ts);
    return Number.isFinite(date.getTime()) ? pad(date.getHours()) + ':' + pad(date.getMinutes()) : EMPTY;
  }

  function unique(values) {
    return values.filter(function (value, index) { return value && values.indexOf(value) === index; });
  }

  function countPhrase(merged) {
    var count = { count: formatNumber(merged.count) };
    if (merged.members.length > 1) return jtn('diagnostics.issues.countEvents', merged.count, count, '{count} event', '{count} events');
    if (merged.count === 1) return jt('diagnostics.issues.countOnce', 'once');
    return jtn('diagnostics.issues.countTimes', merged.count, count, '{count} time', '{count} times');
  }

  function showInActivityLabel() {
    return jt('diagnostics.issues.showInActivity', 'Show in Activity');
  }

  // data-issue carries the group key (the one groupIssues emits); Activity decodes it and scopes the
  // records with issueEntryMatches.
  function inspectLink(member) {
    return actionButton({
      id: INSPECT_ACTION, label: showInActivityLabel(),
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
  // after the first behind the Show in Activity fallback (the button already scopes Activity to the first).
  function techBody(merged, options, buttonIsInspect) {
    var members = merged.members;
    var events = members.map(function (member, index) {
      return '<span class="diagnostics-issue-event"><code>' + escapeHtml(member.event) + '</code> \u00d7' + escapeHtml(formatNumber(member.count))
        + (!buttonIsInspect || index > 0 ? ' ' + inspectLink(member) : '') + '</span>';
    }).join(' \u00b7 ');
    var components = unique(members.map(function (member) { return text(member.component); }));
    var codes = unique(members.map(function (member) { return text(member.error_code); }));
    var message = members.map(function (member) { return text(member.message) !== member.event ? text(member.message) : ''; }).find(Boolean);
    var advice = members.map(function (member) { return text(member.remediation); }).find(Boolean);
    var channel = members.map(function (member) { return member.data && text(member.data.channel); }).find(Boolean);
    return '<dl class="diagnostics-issue-tech-body">'
      + row(jtn('diagnostics.issues.tech.events', members.length, {}, 'Event', 'Events'), events)
      + row(jt('diagnostics.issues.tech.area', 'Area'), escapeHtml(merged.explanation.area)
        + components.map(function (component) { return ' \u00b7 <code>' + escapeHtml(component) + '</code>'; }).join(''))
      + row(jt('diagnostics.issues.tech.code', 'Code'), codes.map(function (code) { return '<code>' + escapeHtml(code) + '</code>'; }).join(' \u00b7 '))
      + row(jt('diagnostics.issues.request', 'Request'), channel ? '<code>' + escapeHtml(channel) + '</code>' : '')
      + row(jt('diagnostics.issues.tech.message', 'Message'), message ? '<span class="diagnostics-issue-raw">' + escapeHtml(message) + '</span>' : '')
      + row(jt('diagnostics.issues.tech.advice', 'Advice'), advice ? escapeHtml(advice) : '')
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
      label: mapped ? action.label : showInActivityLabel(),
      size: 'sm', className: 'diagnostics-issue-action-button', dataset: { issue: encodeURIComponent(first.key) },
    });
    var when = validTime(merged.ts)
      ? '<time datetime="' + escapeHtml(new Date(merged.ts).toISOString()) + '" title="' + escapeHtml((options.formatDetailTime || identity)(merged.ts)) + '">'
        + escapeHtml((options.formatWhen || clockTime)(merged.ts)) + '</time>'
      : '<span>' + EMPTY + '</span>';
    return '<li class="diagnostics-issue" data-severity="' + escapeHtml(merged.severity) + '" data-issue-group="' + escapeHtml(explanation.id) + '">'
      + '<span class="diagnostics-issue-mark">' + (stateIcon ? stateIcon.forLevel(merged.severity) : '') + '</span>'
      + '<div class="diagnostics-issue-body">'
      + '<div class="diagnostics-issue-top"><span class="diagnostics-issue-title">' + escapeHtml(explanation.title) + '</span>'
      + '<span class="diagnostics-issue-when">' + when + ' \u00b7 ' + escapeHtml(countPhrase(merged)) + '</span></div>'
      + '<p class="diagnostics-issue-cause">' + escapeHtml(explanation.cause) + '</p>'
      + '<div class="diagnostics-issue-actions">' + button
      + '<details class="diagnostics-issue-tech" data-issue-group="' + escapeHtml(explanation.id) + '">'
      + '<summary>' + escapeHtml(jt('diagnostics.issues.details', 'Details')) + '</summary>'
      + techBody(merged, options, !mapped) + '</details></div></div></li>';
  }

  // groups: groupIssues output (each carries its latest member's data). options: {availableActions:
  // {[actionId]: true}, formatWhen, formatDetailTime, safeCorrelationValue, statusLabel}. The markup carries
  // content only (no fold state), so the painter's memo changes only when the content does; open folds are
  // restored on the painted DOM by restoreOpenGroups.
  function renderIssueList(groups, options) {
    var settings = options || {};
    var merged = typeof explanations.mergeByExplanation === 'function' ? explanations.mergeByExplanation(groups) : [];
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
