(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./string-utils'));
    return;
  }
  root.logViewUtils = factory(root.stringUtils);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (stringUtils) {
  'use strict';
  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  var jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };
  if (!stringUtils || typeof stringUtils.normalizeString !== 'function') {
    throw new Error('string-utils must load before renderer/shared/log-view-utils.js');
  }
  var normalizeString = stringUtils.normalizeString;
  var SUMMARY_KEYS = ['message', 'error', 'reason', 'type'];

  function mapStructuredLogLevelToken(token, fallback) {
    var normalized = normalizeString(token).toUpperCase();
    if (normalized === 'TRACE' || normalized === 'DEBUG') return 'debug';
    if (normalized === 'INFO') return 'info';
    if (normalized === 'WARN' || normalized === 'WARNING') return 'warn';
    if (normalized === 'ERROR' || normalized === 'FATAL' || normalized === 'PANIC') return 'error';
    return fallback;
  }

  function resolveStructuredLogLevel(line, fallback) {
    var prefix = String(line || '').split(/\smsg=/, 1)[0];
    var match = /(?:^|\s)level="?([A-Za-z]+)"?(?=\s|$)/.exec(prefix);
    return match ? mapStructuredLogLevelToken(match[1], fallback) : fallback;
  }

  function deriveLogSource(entry) {
    var source = normalizeString(entry && (entry.layer || entry.source));
    if (source) return source;
    var event = normalizeString(entry && entry.event);
    return event.split('.').find(function (part) { return normalizeString(part); }) || 'shell';
  }

  function detailsOf(entry) {
    var details = entry && (entry.data || entry.details);
    return details && typeof details === 'object' && !Array.isArray(details) ? details : {};
  }

  function deriveLogSummary(entry) {
    var event = normalizeString(entry && entry.event).toLowerCase();
    var message = normalizeString(entry && entry.message);
    if (message && message.toLowerCase() !== event) return message;
    var details = detailsOf(entry);
    for (var i = 0; i < SUMMARY_KEYS.length; i += 1) {
      var candidate = normalizeString(details[SUMMARY_KEYS[i]]);
      if (candidate && candidate.toLowerCase() !== event) return candidate;
    }
    return jt('app.logs.noAdditionalSummary', 'No additional summary');
  }

  function formatRelativeTime(isoString) {
    var parsed = isoString ? new Date(isoString) : null;
    if (!parsed || Number.isNaN(parsed.valueOf())) return '--';
    var seconds = Math.floor((Date.now() - parsed.getTime()) / 1000);
    if (seconds < 5) return jt('app.logs.justNow', 'just now');
    if (seconds < 60) return jtn('app.logs.secondsAgo', seconds, { count: seconds }, '{count}s ago', '{count}s ago');
    var minutes = Math.floor(seconds / 60);
    if (minutes < 60) return jtn('app.logs.minutesAgo', minutes, { count: minutes }, '{count}m ago', '{count}m ago');
    var hours = Math.floor(minutes / 60);
    if (hours < 24) return jtn('app.logs.hoursAgo', hours, { count: hours }, '{count}h ago', '{count}h ago');
    return jtn('app.logs.daysAgo', Math.floor(hours / 24), { count: Math.floor(hours / 24) }, '{count}d ago', '{count}d ago');
  }

  function buildLogViewModel(entries, filters) {
    var source = Array.isArray(entries) ? entries : [];
    var list = source.map(function (entry, index) {
      return {
        id: normalizeString(entry && (entry.entry_id || entry.id)) || 'log:' + index,
        ts: normalizeString(entry && entry.ts),
        event: normalizeString(entry && entry.event) || 'shell.event',
        levelToken: mapStructuredLogLevelToken(entry && entry.level, 'info'),
        source: deriveLogSource(entry),
        summary: deriveLogSummary(entry),
      };
    });
    return {
      entries: list,
      groups: [],
      total: list.length,
    };
  }

  return Object.freeze({
    buildLogViewModel: buildLogViewModel,
    deriveLogSource: deriveLogSource,
    deriveLogSummary: deriveLogSummary,
    formatRelativeTime: formatRelativeTime,
    mapStructuredLogLevelToken: mapStructuredLogLevelToken,
    resolveStructuredLogLevel: resolveStructuredLogLevel,
  });
});
