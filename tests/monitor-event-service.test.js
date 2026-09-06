'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  drainPendingMonitorNotificationsForToolResult,
  handleMonitorNotification,
} = require('../services/backend/monitor-event-service');

function createFakeService() {
  const messages = [
    {
      id: 'tool_result_stream_1_call_1',
      kind: 'tool_result',
      role: 'tool',
      content: 'Monitor started.',
      tool_result: {
        call_id: 'call_1',
        tool_name: 'monitor',
        output_text: 'Monitor started.',
        summary: 'Watch progress',
        is_error: false,
        parent_stream_id: 'stream_1',
        generated_artifacts: [],
        metadata: {
          monitor: {
            version: 1,
            monitor_id: 'mon_1',
            description: 'Watch progress',
            state: 'running',
            persistent: false,
            timeout_ms: 180000,
            events: [],
            event_count: 0,
            dropped_event_count: 0,
          },
        },
      },
    },
  ];
  const updates = [];
  const emitted = [];
  const logs = [];
  return {
    messages,
    updates,
    emitted,
    logs,
    currentModel: 'mock-v1',
    sessionStore: {
      getSessionMessages(sessionId) {
        assert.equal(sessionId, 'session_1');
        return messages;
      },
      updateMessage(sessionId, messageId, patch) {
        assert.equal(sessionId, 'session_1');
        updates.push({ sessionId, messageId, patch });
        const index = messages.findIndex((message) => message.id === messageId);
        assert.notEqual(index, -1);
        messages[index] = {
          ...messages[index],
          ...patch,
        };
      },
    },
    emit(eventName, payload) {
      emitted.push({ eventName, payload });
    },
    _emitServiceLog(level, event, details = {}) {
      logs.push({ level, event, details });
    },
  };
}

function monitorEvent(overrides = {}) {
  return {
    method: 'monitor.event',
    params: {
      session_id: 'session_1',
      request_id: 'stream_1',
      trace_id: 'trace_1',
      tool_call_id: 'call_1',
      monitor_id: 'mon_1',
      sequence: 1,
      kind: 'output',
      stream: 'stdout',
      text: 'Downloading item 1 of 20',
      state: 'running',
      terminal: false,
      timestamp: '2026-05-16T00:00:00.000Z',
      elapsed_ms: 100,
      ...overrides,
    },
  };
}

test('monitor event updates the original tool result and emits message_updated', () => {
  const service = createFakeService();

  const handled = handleMonitorNotification(service, monitorEvent());

  assert.equal(handled, true);
  assert.equal(service.updates.length, 1);
  const patch = service.updates[0].patch;
  const monitor = patch.tool_result.metadata.monitor;
  assert.equal(monitor.state, 'running');
  assert.equal(monitor.events.length, 1);
  assert.equal(monitor.events[0].text, 'Downloading item 1 of 20');
  assert.equal(monitor.event_count, 1);
  assert.equal(service.emitted.length, 1);
  assert.equal(service.emitted[0].eventName, 'chat-stream');
  assert.equal(service.emitted[0].payload.type, 'message_updated');
  assert.equal(service.emitted[0].payload.messageId, 'tool_result_stream_1_call_1');
});

test('monitor terminal event updates state without appending an output line', () => {
  const service = createFakeService();

  handleMonitorNotification(service, monitorEvent({
    kind: 'terminal',
    state: 'completed',
    terminal: true,
    success: true,
    exit_code: 0,
    terminal_reason: 'exit',
    text: '',
  }));

  const monitor = service.updates[0].patch.tool_result.metadata.monitor;
  assert.equal(monitor.state, 'completed');
  assert.equal(monitor.terminal_reason, 'exit');
  assert.equal(monitor.exit_code, 0);
  assert.equal(monitor.events.length, 0);
});

test('monitor output_batch applies valid events in one message update', () => {
  const service = createFakeService();

  const handled = handleMonitorNotification(service, monitorEvent({
    kind: 'output_batch',
    text: '',
    events: [
      {
        sequence: 2,
        kind: 'output',
        stream: 'stdout',
        text: 'batched line 1',
        timestamp: '2026-05-16T00:00:00.100Z',
        elapsed_ms: 100,
      },
      'bad event',
      {
        sequence: 3,
        kind: 'output',
        stream: 'stderr',
        text: 'batched line 2',
        timestamp: '2026-05-16T00:00:00.200Z',
        elapsed_ms: 200,
      },
    ],
  }));

  assert.equal(handled, true);
  assert.equal(service.updates.length, 1);
  assert.equal(service.emitted.length, 1);
  const monitor = service.updates[0].patch.tool_result.metadata.monitor;
  assert.equal(monitor.events.length, 2);
  assert.equal(monitor.events[0].text, 'batched line 1');
  assert.equal(monitor.events[1].stream, 'stderr');
  assert.equal(monitor.event_count, 2);
});

test('monitor sequential output notifications preserve arrival order', () => {
  const service = createFakeService();

  for (const sequence of [1, 2, 3]) {
    handleMonitorNotification(service, monitorEvent({
      sequence,
      text: `line ${sequence}`,
    }));
  }

  const monitor = service.messages[0].tool_result.metadata.monitor;
  assert.deepEqual(monitor.events.map((event) => event.sequence), [1, 2, 3]);
  assert.deepEqual(monitor.events.map((event) => event.text), ['line 1', 'line 2', 'line 3']);
  assert.equal(monitor.event_count, 3);
  assert.equal(service.updates.length, 3);
});

test('monitor event retention is bounded and records dropped events', () => {
  const service = createFakeService();

  for (let index = 1; index <= 105; index += 1) {
    handleMonitorNotification(service, monitorEvent({
      sequence: index,
      text: `line ${index}`,
    }));
  }

  const monitor = service.messages[0].tool_result.metadata.monitor;
  assert.equal(monitor.events.length, 100);
  assert.equal(monitor.events[0].text, 'line 6');
  assert.equal(monitor.event_count, 105);
  assert.equal(monitor.dropped_event_count, 5);
});

test('monitor event routing scopes same call id by stream', () => {
  const service = createFakeService();
  service.messages.unshift({
    id: 'tool_result_old_call_1',
    kind: 'tool_result',
    role: 'tool',
    content: 'Old monitor started.',
    tool_result: {
      call_id: 'call_1',
      tool_name: 'monitor',
      output_text: 'Old monitor started.',
      summary: 'Old progress',
      is_error: false,
      parent_stream_id: 'stream_old',
      generated_artifacts: [],
      metadata: {
        monitor: {
          version: 1,
          monitor_id: 'mon_old',
          description: 'Old progress',
          state: 'running',
          events: [],
          event_count: 0,
          dropped_event_count: 0,
        },
      },
    },
  });

  const handled = handleMonitorNotification(service, monitorEvent());

  assert.equal(handled, true);
  assert.equal(service.updates[0].messageId, 'tool_result_stream_1_call_1');
});

test('monitor event routing ignores legacy same-call rows without stream identity', () => {
  const service = createFakeService();
  service.messages.unshift({
    id: 'tool_result_legacy_call_1',
    kind: 'tool_result',
    role: 'tool',
    content: 'Legacy monitor started.',
    tool_result: {
      call_id: 'call_1',
      tool_name: 'monitor',
      output_text: 'Legacy monitor started.',
      summary: 'Legacy progress',
      is_error: false,
      generated_artifacts: [],
      metadata: {
        monitor: {
          version: 1,
          monitor_id: 'mon_legacy',
          description: 'Legacy progress',
          state: 'running',
          events: [],
          event_count: 0,
          dropped_event_count: 0,
        },
      },
    },
  });

  const handled = handleMonitorNotification(service, monitorEvent({
    monitor_id: 'mon_1',
  }));

  assert.equal(handled, true);
  assert.equal(service.updates[0].messageId, 'tool_result_stream_1_call_1');
});

test('monitor update normalizes malformed retained event metadata', () => {
  const service = createFakeService();
  service.messages[0].tool_result.metadata.monitor.events = [
    'bad row',
    { sequence: 1, stream: 'stdout', text: 'old line' },
  ];
  service.messages[0].tool_result.metadata.monitor.event_count = 1;

  handleMonitorNotification(service, monitorEvent({
    sequence: 2,
    text: 'new line',
  }));

  const monitor = service.messages[0].tool_result.metadata.monitor;
  assert.equal(monitor.events.length, 2);
  assert.equal(monitor.events[0].text, 'old line');
  assert.equal(monitor.events[1].text, 'new line');
});

test('orphan monitor event logs a bounded warning and does not throw', () => {
  const service = createFakeService();
  service.messages.length = 0;

  const handled = handleMonitorNotification(service, monitorEvent({
    tool_call_id: 'orphan_call',
    monitor_id: 'orphan_mon',
  }));

  assert.equal(handled, false);
  assert.equal(service.updates.length, 0);
  assert.equal(service.logs.length, 1);
  assert.equal(service.logs[0].level, 'WARN');
  assert.equal(service.logs[0].event, 'monitor.event_orphaned');
});

test('pending monitor events drain once the tool result message exists', () => {
  const service = createFakeService();
  const [toolResultMessage] = service.messages.splice(0, 1);

  const handled = handleMonitorNotification(service, monitorEvent({
    sequence: 7,
    text: 'early line',
  }));

  assert.equal(handled, false);
  service.messages.push(toolResultMessage);

  const drained = drainPendingMonitorNotificationsForToolResult(service, {
    sessionId: 'session_1',
    requestId: 'stream_1',
    toolCallId: 'call_1',
    monitorId: 'mon_1',
  });

  assert.equal(drained, 1);
  const monitor = service.messages[0].tool_result.metadata.monitor;
  assert.equal(monitor.events.length, 1);
  assert.equal(monitor.events[0].text, 'early line');
});
