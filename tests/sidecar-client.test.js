const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { Readable, Writable } = require('stream');

const {
  MAX_FRAME_BYTES,
  MAX_HEADER_BYTES,
  SidecarClient,
} = require('../services/backend/sidecar-client');

function buildFrame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf8');
  return Buffer.concat([header, body]);
}

function buildMalformedFrame(bodyText) {
  const body = Buffer.from(bodyText, 'utf8');
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf8');
  return Buffer.concat([header, body]);
}

function createMockProcess() {
  const stdout = new Readable({ read() {} });
  const stdin = new Writable({ write(_chunk, _enc, cb) { cb(); } });
  const proc = new EventEmitter();
  proc.stdout = stdout;
  proc.stdin = stdin;
  return proc;
}

async function withImmediateTimeouts(callback) {
  const previousSetTimeout = global.setTimeout;
  const previousClearTimeout = global.clearTimeout;
  global.setTimeout = (fn) => {
    queueMicrotask(() => fn());
    return { unref() {} };
  };
  global.clearTimeout = () => {};
  try {
    await callback();
  } finally {
    global.setTimeout = previousSetTimeout;
    global.clearTimeout = previousClearTimeout;
  }
}

test('malformed JSON frame does not kill the message loop', async () => {
  const client = new SidecarClient();
  const proc = createMockProcess();
  client.attachProcess(proc);

  const parseErrors = [];
  client.on('parse-error', (err) => parseErrors.push(err));

  const responsePromise = client.request('test.method', { data: 'hello' });

  const malformedFrame = buildMalformedFrame('{not valid json!!!}');
  const validResponse = buildFrame({ jsonrpc: '2.0', id: 1, result: { ok: true } });

  proc.stdout.push(Buffer.concat([malformedFrame, validResponse]));

  const result = await responsePromise;
  assert.deepEqual(result, { ok: true });
  assert.equal(parseErrors.length, 1);
  assert.ok(parseErrors[0] instanceof SyntaxError);
});

test('valid frames process normally after client is created', async () => {
  const client = new SidecarClient();
  const proc = createMockProcess();
  client.attachProcess(proc);

  const promise = client.request('test.ping', {});
  proc.stdout.push(buildFrame({ jsonrpc: '2.0', id: 1, result: { pong: true } }));

  const result = await promise;
  assert.deepEqual(result, { pong: true });
});

test('inbound RPC error surfaces the sidecar semantic code from data.error_code', async () => {
  const client = new SidecarClient();
  const proc = createMockProcess();
  client.attachProcess(proc);

  const promise = client.request('harness.turn_diagnostic', { request_id: 'req-1' });
  proc.stdout.push(buildFrame({
    jsonrpc: '2.0',
    id: 1,
    error: {
      code: -32001,
      message: 'harness.turn_diagnostic: no diagnostics for request_id',
      data: { error_code: 'CMP-HARN-0001', request_id: 'req-1' },
    },
  }));

  await assert.rejects(promise, (error) => {
    // Regression: the handler previously read data.code (absent here) and fell
    // back to CMP-SIDECAR-0005, which defeated the turn-diagnostic WARN
    // suppression keyed on CMP-HARN-0001 and produced spurious WARNs every
    // time a turn errored before producing diagnostics.
    assert.equal(error.error_code, 'CMP-HARN-0001');
    assert.match(String(error.message || ''), /no diagnostics for request_id/);
    return true;
  });
});

test('inbound RPC error still honors the data.code convention when error_code is absent', async () => {
  const client = new SidecarClient();
  const proc = createMockProcess();
  client.attachProcess(proc);

  const promise = client.request('tool.something', {});
  proc.stdout.push(buildFrame({
    jsonrpc: '2.0',
    id: 1,
    error: {
      code: -32000,
      message: 'bridge failure',
      data: { code: 'CMP-TOOL-0008', category: 'electron_tool_bridge' },
    },
  }));

  // The Electron tool-bridge convention puts the CMP code under data.code; the
  // fix must keep reading it as a fallback after preferring data.error_code.
  await assert.rejects(promise, (error) => {
    assert.equal(error.error_code, 'CMP-TOOL-0008');
    return true;
  });
});

test('oversized outbound request rejects with a typed error without touching the pipe', async () => {
  const client = new SidecarClient();
  const proc = createMockProcess();
  const writes = [];
  proc.stdin.write = (chunk) => {
    writes.push(Buffer.from(chunk));
    return true;
  };
  client.attachProcess(proc);

  // An oversized Content-Length terminally kills the sidecar's stdin reader
  // (framing.read_message -> BackgroundMessageReader._pump); pre-fix this
  // desynced the pipe and every later request waited out the watchdog.
  const huge = 'x'.repeat(10 * 1024 * 1024 + 16);
  await assert.rejects(
    client.request('chat.send', { prompt: huge }),
    (error) => {
      assert.match(String(error.message || ''), /exceeding the 10485760-byte protocol cap/);
      assert.equal(error.error_type, 'FrameTooLargeError');
      assert.equal(error.retryable, false);
      assert.equal(error.category, 'transport');
      return true;
    }
  );
  assert.equal(writes.length, 0, 'the oversized frame must never reach stdin');
  assert.equal(client.connected, true, 'one oversized request must not tear down the transport');
});

test('oversized non-request frame is dropped with a warning instead of killing the transport', async () => {
  const client = new SidecarClient();
  const logs = [];
  client.logger = (level, event, data) => logs.push({ level, event, data });
  const proc = createMockProcess();
  const writes = [];
  proc.stdin.write = (chunk) => {
    writes.push(Buffer.from(chunk));
    return true;
  };
  client.attachProcess(proc);

  const huge = 'x'.repeat(10 * 1024 * 1024 + 16);
  const handled = client._writeFrame({ jsonrpc: '2.0', id: 7, result: { output: huge } });

  assert.equal(handled, true);
  assert.equal(writes.length, 0, 'the oversized frame must never reach stdin');
  assert.equal(client.connected, true, 'the healthy transport must stay up');
  assert.equal(
    logs.some((entry) => entry.event === 'sidecar.outbound_frame_too_large'),
    true
  );
});

test('hardwareVramUsage sends hardware.vram_usage RPC request', async () => {
  const client = new SidecarClient();
  const proc = createMockProcess();
  const writes = [];
  proc.stdin.write = (chunk) => {
    writes.push(Buffer.from(chunk));
    return true;
  };
  client.attachProcess(proc);

  const promise = client.hardwareVramUsage();
  proc.stdout.push(buildFrame({
    jsonrpc: '2.0',
    id: 1,
    result: {
      available: true,
      used_mb: 2048,
      total_mb: 8192,
    },
  }));
  const payload = await promise;

  const written = Buffer.concat(writes).toString('utf8');
  const [, body] = written.split('\r\n\r\n');
  const request = JSON.parse(body);
  assert.equal(request.method, 'hardware.vram_usage');
  assert.equal(request.params.accept_version, '2026-08-17');
  assert.equal(payload.available, true);
});

test('plugin-only initialize sends the exact envelope and preserves runtime feature flags', async () => {
  const client = new SidecarClient();
  const proc = createMockProcess();
  const writes = [];
  proc.stdin.write = (chunk) => {
    writes.push(Buffer.from(chunk));
    return true;
  };
  client.attachProcess(proc);
  client.sidecarFeatureFlags = { multiplexer: true, chat_cancel: true };
  const pluginRuntime = { snapshot: { kind: 'plugin_runtime_snapshot' }, declarative_content: [] };
  const promise = client.initialize({ mode: 'plugin_runtime', plugin_runtime: pluginRuntime });
  proc.stdout.push(buildFrame({
    jsonrpc: '2.0',
    id: 1,
    result: { attestation_schema_version: 1, feature_flags: { multiplexer: false } },
  }));

  const result = await promise;
  const body = Buffer.concat(writes).toString('utf8').split('\r\n\r\n')[1];
  const request = JSON.parse(body);
  assert.deepEqual(request.params, { mode: 'plugin_runtime', plugin_runtime: pluginRuntime });
  assert.equal('accept_version' in request.params, false);
  assert.equal('secrets' in request.params, false);
  assert.deepEqual(client.sidecarFeatureFlags, { multiplexer: true, chat_cancel: true });
  assert.equal(result.attestation_schema_version, 1);
});

test('hardwareVramUsage rejects with timeout classification when sidecar does not respond', async () => {
  await withImmediateTimeouts(async () => {
    const client = new SidecarClient();
    const proc = createMockProcess();
    client.attachProcess(proc);

    const promise = client.hardwareVramUsage();
    await assert.rejects(promise, (error) => {
      assert.match(error.message, /hardware\.vram_usage/i);
      assert.equal(error.error_code, 'CMP-SIDECAR-0001');
      assert.equal(error.category, 'timeout');
      assert.equal(error.retryable, true);
      return true;
    });
  });
});

test('shutdown rejects with timeout when sidecar never responds', async () => {
  await withImmediateTimeouts(async () => {
    const client = new SidecarClient();
    const proc = createMockProcess();
    client.attachProcess(proc);

    const promise = client.shutdown({ timeoutMs: 50 });

    await assert.rejects(promise, (error) => {
      assert.match(error.message, /timed out/i);
      assert.equal(error.error_code, 'CMP-SIDECAR-0001');
      assert.equal(error.category, 'timeout');
      assert.equal(error.retryable, true);
      return true;
    });

    assert.equal(client.pendingRequests.size, 0);
    assert.equal(proc.stdin.writableEnded, true);
  });
});

test('timed out memory requests clean up pending transport state', async () => {
  await withImmediateTimeouts(async () => {
    const client = new SidecarClient();
    const proc = createMockProcess();
    client.attachProcess(proc);

    const promise = client.request('memory.recall', { query: 'style' }, { timeoutMs: 50 });

    await assert.rejects(promise, /timed out/i);
    assert.equal(client.pendingRequests.size, 0);
  });
});

test('stdin stream errors reject pending requests without an unhandled error event', async () => {
  const client = new SidecarClient();
  const proc = createMockProcess();
  client.attachProcess(proc);

  const promise = client.request('test.pipe', {}, { timeoutMs: null });
  const error = new Error('write EPIPE');
  error.code = 'EPIPE';
  proc.stdin.emit('error', error);

  await assert.rejects(promise, (rejection) => {
    assert.match(rejection.message, /EPIPE/i);
    assert.equal(rejection.error_code, 'CMP-SIDECAR-0004');
    assert.equal(rejection.category, 'transport');
    assert.equal(rejection.retryable, true);
    return true;
  });
  assert.equal(client.connected, false);
  assert.equal(client.pendingRequests.size, 0);
});

test('aborted chatSend clears pending request and handler maps', async () => {
  const client = new SidecarClient();
  const proc = createMockProcess();
  const writes = [];
  proc.stdin.write = (chunk) => {
    writes.push(Buffer.from(chunk));
    return true;
  };
  client.attachProcess(proc);

  const controller = new AbortController();
  const promise = client.chatSend(
    {
      request_id: 'req_1',
      trace_id: 'trace_abort_req_1',
      messages: [],
    },
    {
      signal: controller.signal,
      onNotification() {},
      onApprovalRequest() { return false; },
    }
  );

  controller.abort(new Error('chat cancelled'));

  await assert.rejects(promise, (error) => {
    assert.match(error.message, /chat cancelled/i);
    assert.equal(error.error_code, 'CMP-SIDECAR-0002');
    assert.equal(error.category, 'cancelled');
    assert.equal(error.cancel_reason, 'user_cancel');
    assert.equal(error.terminal_subcode, 'user_cancel');
    assert.equal(error.retryable, true);
    return true;
  });
  assert.equal(client.pendingRequests.size, 0);
  assert.equal(client.notificationHandlers.size, 0);
  assert.equal(client.approvalHandlers.size, 0);
  assert.equal(client.electronToolHandlers.size, 0);
  assert.equal(writes.length, 2);
  const cancelBody = Buffer.concat([writes[1]]).toString('utf8').split('\r\n\r\n')[1];
  const cancelRequest = JSON.parse(cancelBody);
  assert.equal(cancelRequest.method, 'chat.cancel');
  assert.equal(cancelRequest.params.request_id, 'req_1');
  assert.equal(cancelRequest.params.trace_id, 'trace_abort_req_1');
  assert.equal(cancelRequest.params.cancel_reason, 'user_cancel');
});

test('aborted chatSend preserves timeout cancellation metadata from abort reasons', async () => {
  const client = new SidecarClient();
  const proc = createMockProcess();
  const writes = [];
  proc.stdin.write = (chunk) => {
    writes.push(Buffer.from(chunk));
    return true;
  };
  client.attachProcess(proc);

  const controller = new AbortController();
  const promise = client.chatSend(
    {
      request_id: 'req_timeout_abort',
      trace_id: 'trace_timeout_abort',
      messages: [],
    },
    {
      signal: controller.signal,
      onNotification() {},
      onApprovalRequest() { return false; },
    }
  );

  const timeoutError = new Error('timeout from outer controller');
  timeoutError.cancel_reason = 'timeout';
  controller.abort(timeoutError);

  await assert.rejects(promise, (error) => {
    assert.match(error.message, /timeout from outer controller/i);
    assert.equal(error.error_code, 'CMP-SIDECAR-0002');
    assert.equal(error.category, 'timeout');
    assert.equal(error.cancel_reason, 'timeout');
    assert.equal(error.terminal_subcode, 'timeout');
    assert.equal(error.retryable, true);
    return true;
  });
  assert.equal(writes.length, 2);
  const cancelBody = Buffer.concat([writes[1]]).toString('utf8').split('\r\n\r\n')[1];
  const cancelRequest = JSON.parse(cancelBody);
  assert.equal(cancelRequest.method, 'chat.cancel');
  assert.equal(cancelRequest.params.request_id, 'req_timeout_abort');
  assert.equal(cancelRequest.params.trace_id, 'trace_timeout_abort');
  assert.equal(cancelRequest.params.cancel_reason, 'timeout');
});

test('aborted chatSend skips chat.cancel when Batch 4 transport flags are disabled', async () => {
  const client = new SidecarClient();
  client.sidecarFeatureFlags = {
    multiplexer: false,
    chat_cancel: false,
  };
  const proc = createMockProcess();
  const writes = [];
  proc.stdin.write = (chunk) => {
    writes.push(Buffer.from(chunk));
    return true;
  };
  client.attachProcess(proc);
  client.sidecarFeatureFlags = {
    multiplexer: false,
    chat_cancel: false,
  };

  const controller = new AbortController();
  const promise = client.chatSend(
    {
      request_id: 'req_no_cancel',
      messages: [],
    },
    {
      signal: controller.signal,
    }
  );

  controller.abort(new Error('chat cancelled'));
  await assert.rejects(promise, /chat cancelled/i);
  assert.equal(writes.length, 1);
});

test('aborted initialize clears pending request state', async () => {
  const client = new SidecarClient();
  const proc = createMockProcess();
  client.attachProcess(proc);

  const controller = new AbortController();
  const promise = client.initialize({}, {
    signal: controller.signal,
    timeoutMs: null,
  });

  controller.abort(new Error('initialize cancelled'));

  await assert.rejects(promise, (error) => {
    assert.match(error.message, /initialize cancelled/i);
    assert.equal(error.error_code, 'CMP-SIDECAR-0002');
    assert.equal(error.category, 'cancelled');
    assert.equal(error.retryable, true);
    return true;
  });
  assert.equal(client.pendingRequests.size, 0);
});

test('late chatSend responses are ignored after abort cleanup', async () => {
  const client = new SidecarClient();
  const proc = createMockProcess();
  client.attachProcess(proc);

  const controller = new AbortController();
  const promise = client.chatSend(
    {
      request_id: 'req_ignored',
      messages: [],
    },
    {
      signal: controller.signal,
      onNotification() {},
      onApprovalRequest() { return false; },
    }
  );

  controller.abort(new Error('stop stream'));
  await assert.rejects(promise, /stop stream/i);

  assert.doesNotThrow(() => {
    proc.stdout.push(buildFrame({ jsonrpc: '2.0', id: 1, result: { ok: true } }));
  });
  assert.equal(client.pendingRequests.size, 0);
  assert.equal(client.notificationHandlers.size, 0);
  assert.equal(client.approvalHandlers.size, 0);
  assert.equal(client.electronToolHandlers.size, 0);
});

test('late notifications after aborted chatSend emit a late-notification anomaly', async () => {
  const client = new SidecarClient();
  const proc = createMockProcess();
  client.attachProcess(proc);

  const controller = new AbortController();
  const lateNotifications = [];
  client.on('late-notification', (message) => lateNotifications.push(message));

  const promise = client.chatSend(
    {
      request_id: 'req_late_notification',
      messages: [],
    },
    {
      signal: controller.signal,
      onNotification() {},
      onApprovalRequest() { return false; },
    }
  );

  controller.abort(new Error('stop stream'));
  await assert.rejects(promise, /stop stream/i);

  proc.stdout.push(buildFrame({
    jsonrpc: '2.0',
    method: 'chat.token',
    params: {
      request_id: 'req_late_notification',
      delta: 'late token',
    },
  }));

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lateNotifications.length, 1);
  assert.equal(lateNotifications[0].method, 'chat.token');
});

test('late Electron tool bridge requests after aborted chatSend emit a late-notification anomaly', async () => {
  const logEntries = [];
  const client = new SidecarClient({
    logger(level, event, fields) {
      logEntries.push({ level, event, fields });
    },
  });
  const proc = createMockProcess();
  const writes = [];
  proc.stdin.write = (chunk, _enc, cb) => {
    writes.push(Buffer.from(chunk));
    if (typeof cb === 'function') cb();
    return true;
  };
  client.attachProcess(proc);

  const controller = new AbortController();
  const lateNotifications = [];
  let bridgeHandlerCalled = false;
  client.on('late-notification', (message) => lateNotifications.push(message));

  const promise = client.chatSend(
    {
      request_id: 'req_late_bridge',
      session_id: 'session_late_bridge',
      trace_id: 'trace_late_bridge',
      messages: [],
    },
    {
      signal: controller.signal,
      onNotification() {},
      onApprovalRequest() { return false; },
      onElectronToolRequest() {
        bridgeHandlerCalled = true;
        return { success: true };
      },
    }
  );

  controller.abort(new Error('stop stream'));
  await assert.rejects(promise, /stop stream/i);

  proc.stdout.push(buildFrame({
    jsonrpc: '2.0',
    id: 10000002,
    method: 'tool.execute_electron',
    params: {
      request_id: 'req_late_bridge',
      session_id: 'session_late_bridge',
      trace_id: 'trace_late_bridge',
      tool_name: 'jenny_status',
      tool_call_id: 'call_status_late',
      arguments: {},
    },
  }));

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(bridgeHandlerCalled, false);
  assert.equal(lateNotifications.length, 1);
  assert.equal(lateNotifications[0].method, 'tool.execute_electron');
  assert.equal(logEntries.length, 1);
  assert.equal(logEntries[0].level, 'WARN');
  assert.equal(logEntries[0].event, 'sidecar.late_electron_tool_request');
  assert.deepEqual(logEntries[0].fields, {
    request_id: 'req_late_bridge',
    trace_id: 'trace_late_bridge',
    late_event: true,
    incoming_method: 'tool.execute_electron',
    incoming_id: 10000002,
    tool_call_id: 'call_status_late',
    tool_name: 'jenny_status',
  });

  const responses = writes
    .map((chunk) => JSON.parse(chunk.toString('utf8').split('\r\n\r\n')[1]))
    .filter((message) => message.id === 10000002);
  assert.equal(responses.length, 1);
  assert.equal(responses[0].error.data.code, 'CMP-TOOL-0008');
  assert.equal(responses[0].error.data.category, 'electron_tool_bridge');
  assert.equal(responses[0].error.data.retryable, false);
});

test('late approval requests after aborted chatSend are denied without invoking handlers', async () => {
  const logEntries = [];
  const client = new SidecarClient({
    logger(level, event, fields) {
      logEntries.push({ level, event, fields });
    },
  });
  const proc = createMockProcess();
  const writes = [];
  proc.stdin.write = (chunk, _enc, cb) => {
    writes.push(Buffer.from(chunk));
    if (typeof cb === 'function') cb();
    return true;
  };
  client.attachProcess(proc);

  const controller = new AbortController();
  const lateNotifications = [];
  let approvalHandlerCalled = false;
  client.on('late-notification', (message) => lateNotifications.push(message));

  const promise = client.chatSend(
    {
      request_id: 'req_late_approval',
      session_id: 'session_late_approval',
      trace_id: 'trace_late_approval',
      messages: [],
    },
    {
      signal: controller.signal,
      onNotification() {},
      onApprovalRequest() {
        approvalHandlerCalled = true;
        return true;
      },
    }
  );

  controller.abort(new Error('stop stream'));
  await assert.rejects(promise, /stop stream/i);

  proc.stdout.push(buildFrame({
    jsonrpc: '2.0',
    id: 10000003,
    method: 'tool.request_approval',
    params: {
      request_id: 'req_late_approval',
      session_id: 'session_late_approval',
      trace_id: 'trace_late_approval',
      tool_call_id: 'call_late_approval',
      tool_name: 'Write',
    },
  }));

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(approvalHandlerCalled, false);
  assert.equal(lateNotifications.length, 1);
  assert.equal(lateNotifications[0].method, 'tool.request_approval');
  assert.equal(logEntries.length, 1);
  assert.equal(logEntries[0].level, 'WARN');
  assert.equal(logEntries[0].event, 'sidecar.late_approval_request');

  const responses = writes
    .map((chunk) => JSON.parse(chunk.toString('utf8').split('\r\n\r\n')[1]))
    .filter((message) => message.id === 10000003);
  assert.equal(responses.length, 1);
  assert.deepEqual(responses[0].result, { approved: false });
});

test('late approval tombstones deny stale handlers that remain registered', async () => {
  const client = new SidecarClient();
  const proc = createMockProcess();
  const writes = [];
  proc.stdin.write = (chunk, _enc, cb) => {
    writes.push(Buffer.from(chunk));
    if (typeof cb === 'function') cb();
    return true;
  };
  client.attachProcess(proc);

  const lateNotifications = [];
  let approvalHandlerCalled = false;
  client.on('late-notification', (message) => lateNotifications.push(message));
  client.approvalHandlers.set('req_stale_approval', () => {
    approvalHandlerCalled = true;
    return true;
  });
  client._recordCancelledRequestKey('req_stale_approval');

  proc.stdout.push(buildFrame({
    jsonrpc: '2.0',
    id: 10000004,
    method: 'tool.request_approval',
    params: {
      request_id: 'req_stale_approval',
      trace_id: 'trace_stale_approval',
      tool_call_id: 'call_stale_approval',
      tool_name: 'Write',
    },
  }));

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(approvalHandlerCalled, false);
  assert.equal(lateNotifications.length, 1);
  const responses = writes
    .map((chunk) => JSON.parse(chunk.toString('utf8').split('\r\n\r\n')[1]))
    .filter((message) => message.id === 10000004);
  assert.equal(responses.length, 1);
  assert.deepEqual(responses[0].result, { approved: false });
});

test('notification listener exceptions are logged without failing the transport', async () => {
  const logs = [];
  const client = new SidecarClient({
    logger(level, event, fields) {
      logs.push({ level, event, fields });
    },
  });
  const proc = createMockProcess();
  client.attachProcess(proc);
  client.on('notification', () => {
    throw new Error('renderer listener failed');
  });

  const promise = client.chatSend(
    {
      request_id: 'req_listener_throw',
      messages: [],
    },
    {
      onNotification() {},
      onApprovalRequest() { return false; },
    }
  );

  proc.stdout.push(buildFrame({
    jsonrpc: '2.0',
    method: 'chat.token',
    params: {
      request_id: 'req_listener_throw',
      delta: 'hello',
    },
  }));
  proc.stdout.push(buildFrame({
    jsonrpc: '2.0',
    id: 1,
    result: { ok: true },
  }));

  await assert.doesNotReject(promise);
  assert.ok(logs.some((entry) => (
    entry.level === 'WARN'
    && entry.event === 'sidecar.notification_listener_failed'
    && entry.fields.request_id === 'req_listener_throw'
  )));
  assert.equal(client.pendingRequests.size, 0);
});

test('notification listener promise rejections are logged without failing the transport', async () => {
  const logs = [];
  const client = new SidecarClient({
    logger(level, event, fields) {
      logs.push({ level, event, fields });
    },
  });
  const proc = createMockProcess();
  client.attachProcess(proc);
  client.on('notification', async () => {
    throw new Error('async event listener failed');
  });

  const promise = client.chatSend(
    {
      request_id: 'req_listener_reject',
      messages: [],
    },
    {
      onNotification() {
        return Promise.reject(new Error('async request handler failed'));
      },
      onApprovalRequest() { return false; },
    }
  );

  proc.stdout.push(buildFrame({
    jsonrpc: '2.0',
    method: 'chat.token',
    params: {
      request_id: 'req_listener_reject',
      delta: 'hello',
    },
  }));
  proc.stdout.push(buildFrame({
    jsonrpc: '2.0',
    id: 1,
    result: { ok: true },
  }));

  await assert.doesNotReject(promise);
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.ok(logs.some((entry) => (
    entry.level === 'WARN'
    && entry.event === 'sidecar.notification_listener_failed'
    && entry.fields.request_id === 'req_listener_reject'
    && entry.fields.source === 'request_handler'
  )));
  assert.ok(logs.some((entry) => (
    entry.level === 'WARN'
    && entry.event === 'sidecar.notification_listener_failed'
    && entry.fields.request_id === 'req_listener_reject'
    && entry.fields.source === 'notification'
  )));
  assert.equal(client.pendingRequests.size, 0);
});

test('chatSend handles Electron tool bridge requests for the active request', async () => {
  const client = new SidecarClient();
  const proc = createMockProcess();
  const writes = [];
  proc.stdin.write = (chunk, _enc, cb) => {
    writes.push(Buffer.from(chunk));
    if (typeof cb === 'function') cb();
    return true;
  };
  client.attachProcess(proc);

  const promise = client.chatSend(
    {
      request_id: 'req_browser_bridge',
      messages: [],
    },
    {
      onElectronToolRequest(params) {
        assert.equal(params.tool_name, 'jenny_status');
        return {
          tool_name: 'jenny_status',
          output: 'Jenny is ready.',
          success: true,
          metadata: { result_kind: 'jenny_status' },
        };
      },
    }
  );

  proc.stdout.push(buildFrame({
    jsonrpc: '2.0',
    id: 10000001,
    method: 'tool.execute_electron',
    params: {
      request_id: 'req_browser_bridge',
      tool_name: 'jenny_status',
      tool_call_id: 'call_jenny_status',
      arguments: {},
    },
  }));

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes.length, 2);
  const bridgeResponse = JSON.parse(writes[1].toString('utf8').split('\r\n\r\n')[1]);
  assert.equal(bridgeResponse.id, 10000001);
  assert.equal(bridgeResponse.result.tool_name, 'jenny_status');
  assert.equal(bridgeResponse.result.success, true);

  proc.stdout.push(buildFrame({ jsonrpc: '2.0', id: 1, result: { status: 'completed' } }));
  await promise;
  assert.equal(client.electronToolHandlers.size, 0);
});

test('shutdown resolves normally when sidecar responds before timeout', async () => {
  const client = new SidecarClient();
  const proc = createMockProcess();
  client.attachProcess(proc);

  const promise = client.shutdown();
  // Respond to the shutdown request (id=1)
  proc.stdout.push(buildFrame({ jsonrpc: '2.0', id: 1, result: { ok: true } }));

  const result = await promise;
  assert.deepEqual(result, { ok: true });
  assert.equal(proc.stdin.writableEnded, true);
});

test('dispose detaches process listeners before re-attaching', () => {
  const client = new SidecarClient();
  const proc = createMockProcess();

  client.attachProcess(proc);
  assert.equal(proc.stdout.listenerCount('data'), 1);
  assert.equal(proc.listenerCount('exit'), 1);

  client.dispose();
  assert.equal(proc.stdout.listenerCount('data'), 0);
  assert.equal(proc.listenerCount('exit'), 0);

  client.attachProcess(proc);
  assert.equal(proc.stdout.listenerCount('data'), 1);
  assert.equal(proc.listenerCount('exit'), 1);
});

test('process exit rejects pending requests with classified retryable error', async () => {
  const client = new SidecarClient();
  const proc = createMockProcess();
  client.attachProcess(proc);

  const pending = client.request('test.exit', {});
  proc.emit('exit', 7, 'SIGTERM');

  await assert.rejects(pending, (error) => {
    assert.match(error.message, /process exited/i);
    assert.equal(error.error_code, 'CMP-SIDECAR-0003');
    assert.equal(error.category, 'process_exit');
    assert.equal(error.retryable, true);
    return true;
  });
});

test('oversized sidecar header fatally tears down the transport', async () => {
  const client = new SidecarClient();
  const proc = createMockProcess();
  const errors = [];
  client.on('error', (error) => errors.push(error));
  client.attachProcess(proc);

  const pending = client.request('test.header', {});
  const oversizedHeader = Buffer.concat([
    Buffer.from(`X-Test: ${'x'.repeat(MAX_HEADER_BYTES)}\r\n`, 'utf8'),
    Buffer.from('Content-Length: 2', 'utf8'),
  ]);
  proc.stdout.push(oversizedHeader);

  await assert.rejects(pending, (error) => {
    assert.match(error.message, /maximum allowed size/i);
    assert.equal(error.error_code, 'CMP-SIDECAR-0004');
    assert.equal(error.category, 'transport');
    assert.equal(error.retryable, true);
    return true;
  });
  assert.equal(client.connected, false);
  assert.equal(proc.stdout.listenerCount('data'), 0);
  assert.equal(errors.length, 1, 'exactly one fatal transport error is emitted (no duplicate error events)');
});

test('oversized content length fatally tears down the transport', async () => {
  const client = new SidecarClient();
  const proc = createMockProcess();
  const errors = [];
  client.on('error', (error) => errors.push(error));
  client.attachProcess(proc);

  const pending = client.request('test.frame', {});
  proc.stdout.push(
    Buffer.from(`Content-Length: ${MAX_FRAME_BYTES + 1}\r\n\r\n`, 'utf8')
  );

  await assert.rejects(pending, (error) => {
    assert.match(error.message, /invalid frame size/i);
    assert.equal(error.error_code, 'CMP-SIDECAR-0004');
    assert.equal(error.category, 'transport');
    assert.equal(error.retryable, true);
    return true;
  });
  assert.equal(client.connected, false);
  assert.equal(errors.length, 1, 'exactly one fatal transport error is emitted (no duplicate error events)');
});

test('oversized partial frame buffer fatally tears down the transport', async () => {
  const client = new SidecarClient();
  const proc = createMockProcess();
  const errors = [];
  client.on('error', (error) => errors.push(error));
  client.attachProcess(proc);

  const pending = client.request('test.partial', {});
  proc.stdout.push(Buffer.from(`Content-Length: ${MAX_FRAME_BYTES}\r\n\r\n`, 'utf8'));
  proc.stdout.push(Buffer.alloc(MAX_FRAME_BYTES + 1, 97));

  await assert.rejects(pending, (error) => {
    assert.match(error.message, /maximum buffered frame size/i);
    assert.equal(error.error_code, 'CMP-SIDECAR-0004');
    assert.equal(error.category, 'transport');
    assert.equal(error.retryable, true);
    return true;
  });
  assert.equal(client.connected, false);
  assert.equal(errors.length, 1, 'exactly one fatal transport error is emitted (no duplicate error events)');
});
