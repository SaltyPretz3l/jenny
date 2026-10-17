(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/log-contract-utils'));
    return;
  }
  root.rendererDiagnosticsFormat = factory(root.logContractUtils || {});
})(typeof globalThis !== 'undefined' ? globalThis : this, function (logContractUtils) {
  'use strict';
  // One set of formatters for every Diagnostics surface (overview, performance, activity, the inspector):
  // an unknown value reads as an em dash, never 0, "TBD" or a raw ISO string.
  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  var EMPTY = '—';
  var MAX_CORRELATION_CHARS = 160;

  function localeTag() {
    return globalThis.jennyI18n?.tag?.() || undefined;
  }

  function isBlank(value) {
    return value == null || String(value).trim() === '';
  }

  function pad(value, width) {
    return String(value).padStart(width || 2, '0');
  }

  function parsedDate(value) {
    if (isBlank(value)) return null;
    var date = new Date(typeof value === 'number' ? value : String(value));
    return Number.isFinite(date.getTime()) ? date : null;
  }

  function formatNumber(value) {
    if (isBlank(value)) return EMPTY;
    var number = Number(value);
    return Number.isFinite(number) ? number.toLocaleString(localeTag()) : EMPTY;
  }

  function formatMs(value) {
    if (isBlank(value)) return EMPTY;
    var number = Number(value);
    if (!Number.isFinite(number) || number < 0) return EMPTY;
    return number >= 1000
      ? jt('diagnostics.format.seconds', '{value} s', { value: (number / 1000).toLocaleString(localeTag(), { minimumFractionDigits: 1, maximumFractionDigits: 2 }) })
      : jt('diagnostics.format.milliseconds', '{value} ms', { value: Math.round(number).toLocaleString(localeTag()) });
  }

  function formatBytes(bytes) {
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return null;
    // Rounded megabytes switch to gigabytes at 1,024 so a value just under 1 GiB never reads "1,024 MB".
    return Math.round(bytes / (1024 * 1024)) < 1024
      ? jt('diagnostics.resources.megabytes', '{value} MB', { value: formatNumber(Math.round(bytes / (1024 * 1024))) })
      : jt('diagnostics.resources.gigabytes', '{value} GB', { value: (bytes / (1024 * 1024 * 1024)).toLocaleString(localeTag(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }) });
  }

  // "10:07": the clock time of a status stamp or "since" clause, in the app locale.
  // "18:40", or "18:40:05" with { seconds: true }.
  function formatClock(value, options) {
    var date = parsedDate(value);
    var parts = { hour: '2-digit', minute: '2-digit' };
    if (options && options.seconds) parts.second = '2-digit';
    return date ? date.toLocaleTimeString(localeTag(), parts) : EMPTY;
  }

  // "Oct 13, 18:40": a moment on another day (the previous launch, a failed load's last attempt).
  function formatMoment(value) {
    var date = parsedDate(value);
    if (!date) return EMPTY;
    var now = new Date();
    var sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
    return sameDay
      ? formatClock(date)
      : date.toLocaleString(localeTag(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  // Activity row time: seconds and milliseconds matter when reading a burst of records.
  function formatCompactTime(value) {
    var date = parsedDate(value);
    if (!date) return isBlank(value) ? jt('diagnostics.common.unknown', 'Unknown') : String(value);
    return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds()) + '.' + pad(date.getMilliseconds(), 3);
  }

  function formatDetailTime(value) {
    var date = parsedDate(value);
    if (!date) return isBlank(value) ? jt('diagnostics.common.unknown', 'Unknown') : String(value);
    return date.toLocaleDateString(localeTag(), { year: 'numeric', month: 'short', day: 'numeric' })
      + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds()) + '.' + pad(date.getMilliseconds(), 3);
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

  // The three record sources in product words; the raw layer stays in titles and the inspector.
  function sourceLabel(layer) {
    var key = String(layer || '').trim().toLowerCase();
    if (key === 'sidecar') return jt('diagnostics.issues.area.localEngine', 'Local engine');
    if (key === 'renderer') return jt('diagnostics.issues.area.appWindow', 'App window');
    if (key === 'electron' || !key) return jt('diagnostics.issues.area.app', 'App');
    return humanize(key);
  }

  function displayMessage(message, eventName) {
    var text = String(message || '').trim();
    return text && text !== String(eventName || '').trim() ? text : '';
  }

  function safeCorrelationValue(value) {
    var text = String(value == null ? '' : value).trim();
    if (typeof logContractUtils.redactLogText === 'function') text = logContractUtils.redactLogText(text);
    return text.length > MAX_CORRELATION_CHARS ? text.slice(0, MAX_CORRELATION_CHARS - 1) + '…' : text;
  }

  return Object.freeze({
    EMPTY: EMPTY,
    displayMessage: displayMessage,
    formatBytes: formatBytes,
    formatClock: formatClock,
    formatCompactTime: formatCompactTime,
    formatDetailTime: formatDetailTime,
    formatMoment: formatMoment,
    formatMs: formatMs,
    formatNumber: formatNumber,
    humanize: humanize,
    parsedDate: parsedDate,
    safeCorrelationValue: safeCorrelationValue,
    sourceLabel: sourceLabel,
    statusLabel: statusLabel,
  });
});
