(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); return; }
  root.diagnosticsIssueUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var RANK = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
  function text(value) { return String(value == null ? '' : value).trim(); }
  function dataOf(entry) {
    return entry && entry.data && typeof entry.data === 'object' ? entry.data
      : entry && entry.details && typeof entry.details === 'object' ? entry.details : {};
  }
  function errorCode(entry) {
    var data = dataOf(entry);
    return text(data.error_code || data.errorCode || data.code || entry && entry.error_code);
  }
  function correlations(entry) {
    var data = dataOf(entry); var out = {};
    ['trace_id', 'request_id', 'session_id', 'tool_call_id', 'rpc_id', 'stream_id'].forEach(function (key) {
      var value = text(entry && entry[key] || data[key]); if (value) out[key] = value;
    });
    /* The stream id names the turn a chat error card deep-links from. Renderer
     * records carry it camelCased; fold both spellings onto the one snake_case
     * key so the Correlation section shows a single "Stream" row. */
    if (!out.stream_id) {
      var streamId = text(entry && entry.streamId || data.streamId);
      if (streamId) out.stream_id = streamId;
    }
    return out;
  }
  function compareEntriesChronologically(a, b) {
    var aSequence = Number(a && a.sequence); var bSequence = Number(b && b.sequence);
    var aRun = text(a && a.run_id); var bRun = text(b && b.run_id);
    if (aSequence > 0 && bSequence > 0 && aRun && aRun === bRun) return aSequence - bSequence;
    var aTime = Date.parse(a && a.ts || ''); var bTime = Date.parse(b && b.ts || '');
    if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) return aTime - bTime;
    return (aSequence || 0) - (bSequence || 0);
  }
  function groupIssues(entries) {
    var groups = new Map();
    (Array.isArray(entries) ? entries : []).forEach(function (entry) {
      var level = text(entry && entry.level).toUpperCase();
      if (level !== 'WARN' && level !== 'ERROR') return;
      var component = text(entry.component) || text(entry.layer || entry.source) || 'unknown';
      var event = text(entry.event) || 'unknown.event';
      var code = errorCode(entry);
      var key = [component, event, code].join('\u0000');
      var current = groups.get(key);
      if (!current) current = { key: key, component: component, event: event, error_code: code, count: 0, severity: level, latest: entry, remediation: '', remediationEntry: null };
      current.count += 1;
      if ((RANK[level] || 0) > (RANK[current.severity] || 0)) current.severity = level;
      if (compareEntriesChronologically(entry, current.latest) >= 0) current.latest = entry;
      var remediation = text(dataOf(entry).remediation);
      if (remediation && (!current.remediationEntry || compareEntriesChronologically(entry, current.remediationEntry) >= 0)) {
        current.remediation = remediation; current.remediationEntry = entry;
      }
      groups.set(key, current);
    });
    return Array.from(groups.values()).map(function (group) {
      var data = dataOf(group.latest);
      return {
        key: group.key,
        component: group.component,
        event: group.event,
        error_code: group.error_code,
        count: group.count,
        severity: group.severity,
        message: text(group.latest.message || data.message || group.event),
        ts: text(group.latest.ts),
        remediation: group.remediation,
        correlations: correlations(group.latest),
      };
    }).sort(function (a, b) {
      return (RANK[b.severity] - RANK[a.severity]) || String(b.ts).localeCompare(String(a.ts));
    });
  }
  return Object.freeze({ groupIssues: groupIssues, errorCode: errorCode, correlations: correlations, compareEntriesChronologically: compareEntriesChronologically });
});
