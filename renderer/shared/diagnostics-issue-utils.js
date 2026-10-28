(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(function () { return require('./diagnostics-issue-explanations'); }); return; }
  root.diagnosticsIssueUtils = factory(function () { return root.rendererDiagnosticsIssueExplanations || {}; });
})(typeof globalThis !== 'undefined' ? globalThis : this, function (getExplanations) {
  'use strict';
  var RANK = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
  function severityRank(level) { return RANK[level] || 0; }
  function text(value) { return String(value == null ? '' : value).trim(); }
  function dataOf(entry) {
    return entry && entry.data && typeof entry.data === 'object' ? entry.data
      : entry && entry.details && typeof entry.details === 'object' ? entry.details : {};
  }
  function errorCode(entry) {
    var data = dataOf(entry);
    var code = typeof data.code === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{1,63}$/.test(data.code) ? data.code : '';
    return text(data.error_code || data.errorCode || code || entry && entry.error_code);
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
  function issueIdentity(entry) {
    var component = text(entry.component) || text(entry.layer || entry.source) || 'unknown';
    var event = text(entry.event) || 'unknown.event';
    var code = errorCode(entry); var level = text(entry.level).toUpperCase();
    var data = dataOf(entry); var layer = text(entry.layer || entry.source);
    var dedupeKey = layer === 'renderer' || component.startsWith('renderer.') ? text(data.dedupe_key) : '';
    var matches = getExplanations().matchIssueVariant;
    var variant = matches ? matches({ event: event, severity: level, error_code: code, data: data,
      message: text(entry.message || data.message || event) }) : false;
    return { component: component, event: event, error_code: code, severity: level,
      key: [component, event, code, level, dedupeKey, variant].join('\u0000') };
  }
  function issueEntryMatches(group, entry) {
    if (!group || !entry) return false;
    var identity = issueIdentity(entry);
    return (identity.severity === 'WARN' || identity.severity === 'ERROR') && group.key === identity.key;
  }
  function groupIssues(entries) {
    var groups = new Map();
    (Array.isArray(entries) ? entries : []).forEach(function (entry) {
      var level = text(entry && entry.level).toUpperCase();
      if (level !== 'WARN' && level !== 'ERROR') return;
      var identity = issueIdentity(entry); var key = identity.key;
      var current = groups.get(key);
      if (!current) current = Object.assign({}, identity, { count: 0, latest: entry, entry_ids: [], remediation: '', remediationEntry: null });
      current.count += 1;
      current.entry_ids.push(entry.entry_id || entry.origin_entry_id || entry.sequence);
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
        entry_ids: group.entry_ids,
        data: data,
        layer: text(group.latest.layer || group.latest.source),
        message: text(group.latest.message || data.message || group.event),
        ts: text(group.latest.ts),
        remediation: group.remediation,
        correlations: correlations(group.latest),
      };
    }).sort(function (a, b) {
      return severityRank(b.severity) - severityRank(a.severity)
        || compareEntriesChronologically(b, a) || String(b.ts).localeCompare(String(a.ts));
    });
  }
  return Object.freeze({ groupIssues: groupIssues, issueEntryMatches: issueEntryMatches, severityRank: severityRank, errorCode: errorCode, correlations: correlations, compareEntriesChronologically: compareEntriesChronologically });
});
