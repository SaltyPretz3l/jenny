'use strict';

const { normalizeString } = require('../shared/normalize');

const MAX_MONITOR_EVENTS = 100;
const MAX_MONITOR_EVENT_TEXT_CHARS = 2000;
const MAX_PENDING_MONITOR_KEYS = 100;
const MAX_PENDING_MONITOR_EVENTS = 50;
const pendingMonitorEvents = new Map();

function clipText(value, limit = MAX_MONITOR_EVENT_TEXT_CHARS) {
  const text = String(value || '').replace(/\r?\n$/u, '');
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 14))}...[truncated]`;
}

function asPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function logMonitorWarning(service, event, details = {}) {
  if (service && typeof service._emitServiceLog === 'function') {
    service._emitServiceLog('WARN', event, {
      monitorId: normalizeString(details.monitorId),
      sessionId: normalizeString(details.sessionId),
      requestId: normalizeString(details.requestId),
      toolCallId: normalizeString(details.toolCallId),
      reason: normalizeString(details.reason),
    });
  }
}

function getSessionMessages(service, sessionId) {
  const store = service && service.sessionStore;
  if (!store || typeof store.getSessionMessages !== 'function') return [];
  try {
    const messages = store.getSessionMessages(sessionId);
    return Array.isArray(messages) ? messages : [];
  } catch (_error) {
    return [];
  }
}

function matchesMonitorMessage(message, { requestId, toolCallId, monitorId }) {
  if (!message || message.kind !== 'tool_result') return false;
  const toolResult = asPlainObject(message.tool_result);
  if (normalizeString(toolResult.tool_name) !== 'monitor') return false;
  const metadata = asPlainObject(toolResult.metadata);
  const monitor = asPlainObject(metadata.monitor);
  const fallbackId = requestId && toolCallId ? `tool_result_${requestId}_${toolCallId}` : '';
  const fallbackMatches = Boolean(fallbackId && normalizeString(message.id) === fallbackId);
  const parentStreamId = normalizeString(toolResult.parent_stream_id);
  const toolCallMatches = Boolean(toolCallId && normalizeString(toolResult.call_id) === toolCallId);
  const monitorMatches = Boolean(monitorId && normalizeString(monitor.monitor_id) === monitorId);
  if (fallbackMatches) return true;
  if (requestId) {
    if (parentStreamId && parentStreamId !== requestId) return false;
    if (parentStreamId === requestId && toolCallMatches) return true;
    return monitorMatches;
  }
  if (toolCallMatches) return true;
  return monitorMatches;
}

function findMonitorMessage(messages, match) {
  const list = Array.isArray(messages) ? messages : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (matchesMonitorMessage(list[index], match)) {
      return list[index];
    }
  }
  return null;
}

function pendingKey({ sessionId, requestId, toolCallId, monitorId }) {
  return [
    normalizeString(sessionId),
    normalizeString(requestId),
    normalizeString(toolCallId),
    normalizeString(monitorId),
  ].join('|');
}

function stashPendingMonitorEvent(match, message) {
  const key = pendingKey(match);
  if (!key.replace(/\|/gu, '')) return;
  if (!pendingMonitorEvents.has(key) && pendingMonitorEvents.size >= MAX_PENDING_MONITOR_KEYS) {
    const oldest = pendingMonitorEvents.keys().next().value;
    if (oldest) pendingMonitorEvents.delete(oldest);
  }
  const events = pendingMonitorEvents.get(key) || [];
  events.push(message);
  if (events.length > MAX_PENDING_MONITOR_EVENTS) {
    events.splice(0, events.length - MAX_PENDING_MONITOR_EVENTS);
  }
  pendingMonitorEvents.set(key, events);
}

function normalizeMonitor(currentMonitor, params) {
  const monitor = {
    ...currentMonitor,
    version: 1,
    monitor_id: normalizeString(params.monitor_id || currentMonitor.monitor_id),
    description: normalizeString(currentMonitor.description),
    state: normalizeString(params.state || currentMonitor.state || 'running'),
    persistent: currentMonitor.persistent === true,
    timeout_ms: Number.isFinite(Number(currentMonitor.timeout_ms))
      ? Number(currentMonitor.timeout_ms)
      : 180000,
    event_count: Number.isFinite(Number(currentMonitor.event_count))
      ? Number(currentMonitor.event_count)
      : 0,
    dropped_event_count: Number.isFinite(Number(currentMonitor.dropped_event_count))
      ? Number(currentMonitor.dropped_event_count)
      : 0,
    events: Array.isArray(currentMonitor.events)
      ? currentMonitor.events
        .filter((event) => event && typeof event === 'object' && !Array.isArray(event))
        .map((event) => ({ ...event }))
      : [],
  };
  monitor.monitor_id = normalizeString(params.monitor_id || monitor.monitor_id);
  monitor.state = normalizeString(params.state || monitor.state || 'running');
  return monitor;
}

function appendNormalizedOutputEvents(monitor, normalizedEvents) {
  if (!normalizedEvents.length) {
    return monitor;
  }
  monitor.events = monitor.events.concat(normalizedEvents);
  monitor.event_count += normalizedEvents.length;
  if (monitor.events.length > MAX_MONITOR_EVENTS) {
    const dropped = monitor.events.length - MAX_MONITOR_EVENTS;
    monitor.events = monitor.events.slice(dropped);
    monitor.dropped_event_count += dropped;
  }
  return monitor;
}

function appendOutputEvent(monitor, params) {
  const event = normalizeOutputEvent(params, monitor.event_count + 1);
  return event ? appendNormalizedOutputEvents(monitor, [event]) : monitor;
}

function normalizeOutputEvent(params, fallbackSequence) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return null;
  }
  const text = clipText(params.text);
  if (!text) {
    return null;
  }
  return {
    sequence: Number.isFinite(Number(params.sequence)) ? Number(params.sequence) : fallbackSequence,
    kind: normalizeString(params.kind || 'output') || 'output',
    stream: normalizeString(params.stream || 'stdout') || 'stdout',
    text,
    timestamp: normalizeString(params.timestamp) || new Date().toISOString(),
    elapsed_ms: Number.isFinite(Number(params.elapsed_ms)) ? Number(params.elapsed_ms) : 0,
  };
}

function appendOutputEvents(monitor, events) {
  const list = Array.isArray(events) ? events : [];
  const normalizedEvents = [];
  for (const entry of list) {
    const event = normalizeOutputEvent(entry, monitor.event_count + normalizedEvents.length + 1);
    if (event) {
      normalizedEvents.push(event);
    }
  }
  if (!normalizedEvents.length) {
    return monitor;
  }
  return appendNormalizedOutputEvents(monitor, normalizedEvents);
}

function applyTerminalFields(monitor, params) {
  if (params.terminal === true || normalizeString(params.kind) === 'terminal') {
    monitor.terminal = true;
    monitor.terminal_reason = normalizeString(params.terminal_reason || monitor.terminal_reason);
    if (Object.prototype.hasOwnProperty.call(params, 'success')) {
      monitor.success = params.success === true;
    }
    if (Object.prototype.hasOwnProperty.call(params, 'exit_code')) {
      const exitCode = Number(params.exit_code);
      monitor.exit_code = Number.isFinite(exitCode) ? exitCode : null;
    }
    monitor.completed_at = normalizeString(params.timestamp) || new Date().toISOString();
  }
  return monitor;
}

function updateMonitorFromEvent(currentMonitor, params) {
  const monitor = normalizeMonitor(currentMonitor, params);
  const isTerminal = params.terminal === true || normalizeString(params.kind) === 'terminal';
  if (!isTerminal) {
    if (normalizeString(params.kind) === 'output_batch') {
      appendOutputEvents(monitor, params.events);
    } else {
      appendOutputEvent(monitor, params);
    }
  }
  applyTerminalFields(monitor, params);
  return monitor;
}

function updateSessionMessage(service, sessionId, message, patch) {
  const store = service && service.sessionStore;
  if (!store || typeof store.updateMessage !== 'function') return false;
  const messageId = normalizeString(message && message.id);
  if (!messageId) return false;
  store.updateMessage(sessionId, messageId, patch);
  return true;
}

function emitMessageUpdated(service, { sessionId, requestId, messageId, patch }) {
  if (!service || typeof service.emit !== 'function') return;
  service.emit('chat-stream', {
    type: 'message_updated',
    streamId: requestId,
    sessionId,
    model: normalizeString(service.currentModel),
    messageId,
    patch,
  });
}

function handleMonitorNotification(service, message) {
  if (!message || message.method !== 'monitor.event') return false;
  const params = asPlainObject(message.params);
  const sessionId = normalizeString(params.session_id);
  const requestId = normalizeString(params.request_id);
  const toolCallId = normalizeString(params.tool_call_id);
  const monitorId = normalizeString(params.monitor_id);
  if (!sessionId || (!toolCallId && !monitorId)) {
    logMonitorWarning(service, 'monitor.event_orphaned', {
      monitorId,
      sessionId,
      requestId,
      toolCallId,
      reason: 'missing identity',
    });
    return false;
  }

  const messages = getSessionMessages(service, sessionId);
  const target = findMonitorMessage(messages, { requestId, toolCallId, monitorId });
  if (!target) {
    stashPendingMonitorEvent({
      sessionId,
      requestId,
      toolCallId,
      monitorId,
    }, message);
    logMonitorWarning(service, 'monitor.event_orphaned', {
      monitorId,
      sessionId,
      requestId,
      toolCallId,
      reason: 'tool result not found',
    });
    return false;
  }

  const toolResult = asPlainObject(target.tool_result);
  const metadata = asPlainObject(toolResult.metadata);
  const currentMonitor = asPlainObject(metadata.monitor);
  const monitor = updateMonitorFromEvent(currentMonitor, params);
  const nextToolResult = {
    ...toolResult,
    metadata: {
      ...metadata,
      monitor,
    },
  };
  const patch = {
    tool_result: nextToolResult,
    finalizedAt: target.finalizedAt || new Date().toISOString(),
  };
  const messageId = normalizeString(target.id);
  if (!updateSessionMessage(service, sessionId, target, patch)) {
    return false;
  }
  emitMessageUpdated(service, {
    sessionId,
    requestId,
    messageId,
    patch,
  });
  return true;
}

function drainPendingMonitorNotificationsForToolResult(service, match) {
  const normalizedMatch = {
    sessionId: normalizeString(match && match.sessionId),
    requestId: normalizeString(match && match.requestId),
    toolCallId: normalizeString(match && match.toolCallId),
    monitorId: normalizeString(match && match.monitorId),
  };
  const keys = [];
  for (const key of pendingMonitorEvents.keys()) {
    const [sessionId, requestId, toolCallId, monitorId] = key.split('|');
    const sameSession = sessionId === normalizedMatch.sessionId;
    const sameRequest = !normalizedMatch.requestId || requestId === normalizedMatch.requestId;
    const sameCall = !normalizedMatch.toolCallId || toolCallId === normalizedMatch.toolCallId;
    const sameMonitor = !normalizedMatch.monitorId || monitorId === normalizedMatch.monitorId;
    if (sameSession && sameRequest && sameCall && sameMonitor) {
      keys.push(key);
    }
  }
  let drained = 0;
  for (const key of keys) {
    const events = pendingMonitorEvents.get(key) || [];
    pendingMonitorEvents.delete(key);
    for (const event of events) {
      if (handleMonitorNotification(service, event)) {
        drained += 1;
      }
    }
  }
  return drained;
}

module.exports = {
  drainPendingMonitorNotificationsForToolResult,
  handleMonitorNotification,
};
