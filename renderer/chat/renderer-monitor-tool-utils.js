(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererMonitorToolUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function fallbackNormalizeString(value) {
    return String(value || '').trim();
  }

  function fallbackEscapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function normalizeMonitorMetadata(value, normalizeStringImpl) {
    const normalizeString = typeof normalizeStringImpl === 'function'
      ? normalizeStringImpl
      : fallbackNormalizeString;
    const monitor = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const events = Array.isArray(monitor.events)
      ? monitor.events
        .filter((event) => event && typeof event === 'object' && !Array.isArray(event))
        .map((event) => ({
          sequence: Number.isFinite(Number(event.sequence)) ? Number(event.sequence) : 0,
          stream: normalizeString(event.stream || 'stdout') || 'stdout',
          text: String(event.text || ''),
          timestamp: normalizeString(event.timestamp),
          elapsedMs: Number.isFinite(Number(event.elapsed_ms)) ? Number(event.elapsed_ms) : 0,
        }))
      : [];
    return {
      monitorId: normalizeString(monitor.monitor_id),
      description: normalizeString(monitor.description),
      state: normalizeString(monitor.state || 'running') || 'running',
      persistent: monitor.persistent === true,
      timeoutMs: Number.isFinite(Number(monitor.timeout_ms)) ? Number(monitor.timeout_ms) : 0,
      eventCount: Number.isFinite(Number(monitor.event_count)) ? Number(monitor.event_count) : events.length,
      droppedEventCount: Number.isFinite(Number(monitor.dropped_event_count)) ? Number(monitor.dropped_event_count) : 0,
      terminalReason: normalizeString(monitor.terminal_reason),
      exitCode: monitor.exit_code != null && Number.isFinite(Number(monitor.exit_code)) ? Number(monitor.exit_code) : null,
      events,
    };
  }

  function renderMonitorPanelHtml(monitor, options) {
    const opts = options && typeof options === 'object' ? options : {};
    const escapeHtml = typeof opts.escapeHtml === 'function'
      ? opts.escapeHtml
      : fallbackEscapeHtml;
    const description = monitor.description || opts.summary || 'Monitor';
    const timeoutLabel = monitor.timeoutMs > 0 ? `${Math.round(monitor.timeoutMs / 1000)}s` : '';
    const metaParts = [
      monitor.state,
      timeoutLabel ? `timeout ${timeoutLabel}` : '',
      monitor.persistent ? 'persistent' : '',
      monitor.eventCount === 1 ? '1 event' : `${monitor.eventCount} events`,
      monitor.droppedEventCount > 0 ? `${monitor.droppedEventCount} dropped` : '',
      monitor.terminalReason,
      monitor.exitCode != null ? `exit ${monitor.exitCode}` : '',
    ].filter(Boolean);
    const eventLines = monitor.events.length
      ? monitor.events.map((event) => `
          <div class="tool-monitor-event" data-monitor-stream="${escapeHtml(event.stream)}">
            <span class="tool-monitor-event-stream">${escapeHtml(event.stream)}</span>
            <span class="tool-monitor-event-text">${escapeHtml(event.text)}</span>
          </div>
        `).join('')
      : `<div class="tool-call-empty">${escapeHtml('No monitor events recorded yet.')}</div>`;
    return `
      <div class="tool-monitor-panel" data-monitor-state="${escapeHtml(monitor.state)}">
        <div class="tool-monitor-heading">
          <div class="tool-monitor-description">${escapeHtml(description)}</div>
          <div class="tool-monitor-meta">${escapeHtml(metaParts.join(' | '))}</div>
        </div>
        <div class="tool-monitor-events">
          ${eventLines}
        </div>
      </div>`;
  }

  return {
    normalizeMonitorMetadata,
    renderMonitorPanelHtml,
  };
});
