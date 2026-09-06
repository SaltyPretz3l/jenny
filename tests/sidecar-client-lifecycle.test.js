const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { Readable, Writable } = require('stream');

const { SidecarClient } = require('../services/backend/sidecar-client');

// ---------------------------------------------------------------------------
// Shared fakes — mirror the framing/fake-child setup from sidecar-client.test.js.
// We intentionally only target the UNCOVERED RPC wrappers, lifecycle, and error
// branches; the framing/timeout/abort/late-notification paths are already
// covered by tests/sidecar-client.test.js and are NOT duplicated here.
// ---------------------------------------------------------------------------

function buildFrame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
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

// A child whose stdin records every framed write and invokes the callback.
function createRecordingProcess() {
  const writes = [];
  const proc = createMockProcess();
  proc.stdin.write = (chunk, _enc, cb) => {
    writes.push(Buffer.from(chunk));
    if (typeof cb === 'function') cb();
    return true;
  };
  return { proc, writes };
}

function decodeRequest(chunk) {
  return JSON.parse(chunk.toString('utf8').split('\r\n\r\n')[1]);
}

async function nextTick() {
  await new Promise((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------
// attachProcess input validation (lines 84-86)
// ---------------------------------------------------------------------------

test('attachProcess throws when given a non-object child process', () => {
  const client = new SidecarClient();
  assert.throws(
    () => client.attachProcess(null),
    /child process is required/i
  );
  assert.throws(
    () => client.attachProcess('not-a-process'),
    /child process is required/i
  );
  // The bad attach must not leave the client in a connected state.
  assert.equal(client.connected, false);
  assert.equal(client.process, null);
});

// ---------------------------------------------------------------------------
// backgroundRun (lines 132-141)
// ---------------------------------------------------------------------------

test('backgroundRun throws on an empty task before touching the transport', async () => {
  const client = new SidecarClient();
  const { proc, writes } = createRecordingProcess();
  client.attachProcess(proc);

  await assert.rejects(
    client.backgroundRun('   '),
    /background\.run requires a non-empty task/i
  );
  // No frame should be written for the rejected pre-flight validation.
  assert.equal(writes.length, 0);
});

test('backgroundRun normalizes the task and forwards extra params over RPC', async () => {
  const client = new SidecarClient();
  const { proc, writes } = createRecordingProcess();
  client.attachProcess(proc);

  const promise = client.backgroundRun('  Summarize-Thread  ', { thread_id: 'thread_42' });
  proc.stdout.push(buildFrame({ jsonrpc: '2.0', id: 1, result: { accepted: true } }));
  const result = await promise;

  assert.equal(writes.length, 1);
  const request = decodeRequest(writes[0]);
  assert.equal(request.method, 'background.run');
  assert.equal(request.params.task, 'summarize-thread');
  assert.equal(request.params.accept_version, '2026-08-17');
  assert.equal(request.params.thread_id, 'thread_42');
  assert.equal(result.accepted, true);
});

// ---------------------------------------------------------------------------
// hardwareProfile (lines 144-148)
// ---------------------------------------------------------------------------

test('hardwareProfile sends hardware.profile RPC and merges params', async () => {
  const client = new SidecarClient();
  const { proc, writes } = createRecordingProcess();
  client.attachProcess(proc);

  const promise = client.hardwareProfile({ refresh: true });
  proc.stdout.push(buildFrame({ jsonrpc: '2.0', id: 1, result: { gpu: 'sample-gpu' } }));
  const result = await promise;

  const request = decodeRequest(writes[0]);
  assert.equal(request.method, 'hardware.profile');
  assert.equal(request.params.accept_version, '2026-08-17');
  assert.equal(request.params.refresh, true);
  assert.equal(result.gpu, 'sample-gpu');
});

// ---------------------------------------------------------------------------
// harnessInspect (lines 157-161)
// ---------------------------------------------------------------------------

test('harnessInspect sends harness.inspect RPC and merges params', async () => {
  const client = new SidecarClient();
  const { proc, writes } = createRecordingProcess();
  client.attachProcess(proc);

  const promise = client.harnessInspect({ session_id: 'session_inspect' });
  proc.stdout.push(buildFrame({ jsonrpc: '2.0', id: 1, result: { turns: 3 } }));
  const result = await promise;

  const request = decodeRequest(writes[0]);
  assert.equal(request.method, 'harness.inspect');
  assert.equal(request.params.accept_version, '2026-08-17');
  assert.equal(request.params.session_id, 'session_inspect');
  assert.equal(result.turns, 3);
});

// ---------------------------------------------------------------------------
// chatSend empty request_id (lines 179-180)
// ---------------------------------------------------------------------------

test('chatSend throws and registers no handlers when request_id is blank', async () => {
  const client = new SidecarClient();
  const { proc } = createRecordingProcess();
  client.attachProcess(proc);

  await assert.rejects(
    client.chatSend({ request_id: '   ', messages: [] }, { onNotification() {} }),
    /chat\.send requires a non-empty request_id/i
  );
  // The throw happens before any handler registration.
  assert.equal(client.notificationHandlers.size, 0);
  assert.equal(client.approvalHandlers.size, 0);
  assert.equal(client.electronToolHandlers.size, 0);
});

// ---------------------------------------------------------------------------
// request() not-connected guard (lines 220-221, 404-405, 299-300)
// ---------------------------------------------------------------------------

test('request rejects immediately when the process is not connected', async () => {
  const client = new SidecarClient();
  // Never attach a process.
  await assert.rejects(
    client.request('models.list', { accept_version: '2026-08-17' }),
    /Sidecar process is not connected/i
  );
});

test('request rejects with a stdin-write error when the pipe vanishes between the guard and the write', async () => {
  const client = new SidecarClient();
  const proc = createMockProcess();
  client.attachProcess(proc);

  // The request() guard (line 219) reads this.process.stdin once and passes;
  // then _writeFrame() reads it again (line 403). Flip stdin to null on the
  // SECOND read so _writeFrame returns false and request takes the onWriteError
  // "not connected" path (lines 298-300, 404-405).
  const realStdin = proc.stdin;
  let reads = 0;
  Object.defineProperty(proc, 'stdin', {
    configurable: true,
    get() {
      reads += 1;
      return reads <= 1 ? realStdin : null;
    },
  });

  await assert.rejects(
    client.request('test.disconnected', {}, { timeoutMs: null }),
    (error) => {
      assert.match(error.message, /not connected/i);
      assert.equal(error.error_code, 'CMP-SIDECAR-0004');
      assert.equal(error.category, 'transport');
      return true;
    }
  );
  assert.equal(client.pendingRequests.size, 0);
});

test('_writeFrame returns false directly when the client is not connected', () => {
  const client = new SidecarClient();
  const proc = createMockProcess();
  client.attachProcess(proc);
  client.connected = false; // force the guard at lines 403-405

  const handled = client._writeFrame({ jsonrpc: '2.0', id: 99, result: {} });
  assert.equal(handled, false, '_writeFrame must report it did not handle the frame');
});

// ---------------------------------------------------------------------------
// already-aborted signal short-circuit (lines 271-273)
// ---------------------------------------------------------------------------

test('request with an already-aborted signal rejects synchronously via handleAbort', async () => {
  const client = new SidecarClient();
  const { proc, writes } = createRecordingProcess();
  client.attachProcess(proc);

  const controller = new AbortController();
  controller.abort(new Error('pre-aborted'));

  await assert.rejects(
    client.request('test.preabort', {}, { signal: controller.signal, timeoutMs: null }),
    (error) => {
      assert.match(error.message, /pre-aborted/i);
      assert.equal(error.error_code, 'CMP-SIDECAR-0002');
      return true;
    }
  );
  // The early-return path means the request frame is never written.
  assert.equal(writes.length, 0);
  assert.equal(client.pendingRequests.size, 0);
});

// ---------------------------------------------------------------------------
// _cancelReasonFromSignal string reason + _createAbortError string reason
// (lines 332-334, 355-371)
// ---------------------------------------------------------------------------

test('aborted chat.send with a string reason preserves that reason text and metadata', async () => {
  const client = new SidecarClient();
  const { proc, writes } = createRecordingProcess();
  client.attachProcess(proc);

  const controller = new AbortController();
  const promise = client.chatSend(
    { request_id: 'req_string_reason', trace_id: 'trace_string_reason', messages: [] },
    { signal: controller.signal, onNotification() {}, onApprovalRequest() { return false; } }
  );

  // A non-empty string abort reason that is NOT a recognized cancel token.
  controller.abort('user pressed stop button');

  await assert.rejects(promise, (error) => {
    assert.match(error.message, /user pressed stop button/i);
    assert.equal(error.error_code, 'CMP-SIDECAR-0002');
    assert.equal(error.category, 'cancelled');
    assert.equal(error.retryable, true);
    return true;
  });
  // chat.cancel best-effort frame is the second write.
  assert.equal(writes.length, 2);
  const cancelRequest = decodeRequest(writes[1]);
  assert.equal(cancelRequest.method, 'chat.cancel');
});

test('aborted non-chat request with a null reason yields a named AbortError (default branch)', async () => {
  const client = new SidecarClient();
  const { proc, writes } = createRecordingProcess();
  client.attachProcess(proc);

  // A minimal abort-signal whose reason is null (not an Error, not a string) so
  // _createAbortError falls through to the default AbortError branch (363-371).
  const listeners = [];
  const signal = {
    aborted: false,
    reason: null,
    addEventListener(_event, fn) { listeners.push(fn); },
    removeEventListener() {},
  };

  const promise = client.request('models.list', {}, { signal, timeoutMs: null });

  signal.aborted = true;
  for (const fn of listeners) fn();

  await assert.rejects(promise, (error) => {
    assert.equal(error.name, 'AbortError');
    assert.match(error.message, /models\.list aborted/i);
    assert.equal(error.error_code, 'CMP-SIDECAR-0002');
    assert.equal(error.category, 'cancelled');
    return true;
  });
  // Non-chat requests do not emit a chat.cancel frame.
  assert.equal(writes.length, 1);
});

// ---------------------------------------------------------------------------
// _writeFrame synchronous throw path (lines 434-435, 439-441)
// ---------------------------------------------------------------------------

test('request rejects when stdin.write throws synchronously (onThrow path)', async () => {
  const client = new SidecarClient();
  const proc = createMockProcess();
  proc.stdin.write = () => {
    throw new Error('synchronous stdin failure');
  };
  client.attachProcess(proc);

  await assert.rejects(
    client.request('test.sync_throw', {}, { timeoutMs: null }),
    (error) => {
      assert.match(error.message, /synchronous stdin failure/i);
      assert.equal(error.error_code, 'CMP-SIDECAR-0004');
      assert.equal(error.category, 'transport');
      return true;
    }
  );
});

test('request rejects when stdin.write reports an async error to its callback', async () => {
  const client = new SidecarClient();
  const proc = createMockProcess();
  proc.stdin.write = (_chunk, _enc, cb) => {
    const callback = typeof _enc === 'function' ? _enc : cb;
    if (typeof callback === 'function') {
      callback(new Error('async write callback error'));
    }
    return true;
  };
  client.attachProcess(proc);

  await assert.rejects(
    client.request('test.async_cb_error', {}, { timeoutMs: null }),
    (error) => {
      assert.match(error.message, /async write callback error/i);
      assert.equal(error.error_code, 'CMP-SIDECAR-0004');
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// _finalizePendingRequest unknown id + onCleanup throw (lines 447-448, 469-470)
// ---------------------------------------------------------------------------

test('_finalizePendingRequest returns false for an unknown request id', () => {
  const client = new SidecarClient();
  const result = client._finalizePendingRequest(99999, { type: 'resolve', value: {} });
  assert.equal(result, false);
});

test('onCleanup exceptions during finalize are surfaced via the error event', async () => {
  const client = new SidecarClient();
  const { proc } = createRecordingProcess();
  client.attachProcess(proc);

  const emittedErrors = [];
  client.on('error', (error) => emittedErrors.push(error));

  // chatSend installs an onCleanup that deletes handler maps; we override it
  // with our own request that throws inside onCleanup to drive lines 466-470.
  const promise = client.request(
    'test.cleanup_throw',
    {},
    {
      timeoutMs: null,
      requestKey: 'req_cleanup_throw',
      onCleanup() {
        throw new Error('cleanup blew up');
      },
    }
  );

  proc.stdout.push(buildFrame({ jsonrpc: '2.0', id: 1, result: { ok: true } }));
  const result = await promise;

  assert.deepEqual(result, { ok: true });
  await nextTick();
  assert.equal(emittedErrors.length, 1);
  assert.match(emittedErrors[0].message, /cleanup blew up/i);
});

// ---------------------------------------------------------------------------
// detachProcess removeListener fallbacks (lines 489-491, 494-496, 500-502)
// ---------------------------------------------------------------------------

test('detachProcess uses removeListener fallbacks when off() is unavailable', () => {
  const client = new SidecarClient();

  // Build a child whose stdout/stdin/process expose removeListener but NOT off,
  // forcing the else-if fallback branches in detachProcess.
  const stdoutCalls = [];
  const stdinCalls = [];
  const procCalls = [];
  const stdout = {
    on() {},
    removeListener(event, fn) { stdoutCalls.push({ event, fn }); },
  };
  const stdin = {
    on() {},
    removeListener(event, fn) { stdinCalls.push({ event, fn }); },
  };
  const proc = {
    stdout,
    stdin,
    once() {},
    removeListener(event, fn) { procCalls.push({ event, fn }); },
  };

  client.attachProcess(proc);
  client.detachProcess();

  assert.equal(stdoutCalls.length, 1);
  assert.equal(stdoutCalls[0].event, 'data');
  assert.equal(stdoutCalls[0].fn, client._handleStdoutData);
  assert.equal(stdinCalls.length, 1);
  assert.equal(stdinCalls[0].event, 'error');
  assert.equal(stdinCalls[0].fn, client._handleStdinError);
  assert.equal(procCalls.length, 1);
  assert.equal(procCalls[0].event, 'exit');
  assert.equal(procCalls[0].fn, client._handleProcessExit);
  assert.equal(client.process, null);
  assert.equal(client.connected, false);
});

// ---------------------------------------------------------------------------
// _handleStdinError logger branch + error re-emit (lines 543-549, 551-553)
// ---------------------------------------------------------------------------

test('stdin errors log a warning and re-emit when an error listener is present', async () => {
  const logs = [];
  const client = new SidecarClient({
    logger(level, event, fields) {
      logs.push({ level, event, fields });
    },
  });
  const proc = createMockProcess();
  client.attachProcess(proc);

  const emitted = [];
  client.on('error', (error) => emitted.push(error));

  const pending = client.request('test.stdin_log', {}, { timeoutMs: null });
  const streamError = new Error('broken pipe');
  streamError.code = 'EPIPE';
  proc.stdin.emit('error', streamError);

  await assert.rejects(pending, /broken pipe/i);

  const warn = logs.find((entry) => entry.event === 'sidecar.stdin_error');
  assert.ok(warn, 'a sidecar.stdin_error warning must be logged');
  assert.equal(warn.level, 'WARN');
  assert.equal(warn.fields.code, 'EPIPE');
  assert.equal(warn.fields.pendingRequests, 1);
  // The error must also be re-emitted because we attached an 'error' listener.
  assert.equal(emitted.length, 1);
  assert.match(emitted[0].message, /broken pipe/i);
  assert.equal(client.connected, false);
});

// ---------------------------------------------------------------------------
// _handleProcessExit removeListener fallbacks + logger (lines 561-562, 566-567,
// 581-586)
// ---------------------------------------------------------------------------

test('process exit logs a warning and uses removeListener fallbacks', async () => {
  const logs = [];
  const client = new SidecarClient({
    logger(level, event, fields) {
      logs.push({ level, event, fields });
    },
  });

  const stdoutCalls = [];
  const stdinCalls = [];
  let exitHandler = null;
  const stdout = {
    on() {},
    removeListener(event, fn) { stdoutCalls.push({ event, fn }); },
  };
  const stdin = {
    on() {},
    write(_chunk, _enc, cb) { if (typeof cb === 'function') cb(); return true; },
    removeListener(event, fn) { stdinCalls.push({ event, fn }); },
  };
  const proc = {
    stdout,
    stdin,
    once(event, fn) { if (event === 'exit') exitHandler = fn; },
  };

  client.attachProcess(proc);
  const pending = client.request('test.exit_log', {}, { timeoutMs: null });

  // Drive the exit handler directly (the fake child has no EventEmitter emit).
  exitHandler(143, 'SIGTERM');

  await assert.rejects(pending, (error) => {
    assert.match(error.message, /process exited \(code=143 signal=SIGTERM\)/i);
    assert.equal(error.error_code, 'CMP-SIDECAR-0003');
    assert.equal(error.category, 'process_exit');
    return true;
  });

  assert.equal(stdoutCalls.length, 1);
  assert.equal(stdoutCalls[0].event, 'data');
  assert.equal(stdinCalls.length, 1);
  assert.equal(stdinCalls[0].event, 'error');

  const warn = logs.find((entry) => entry.event === 'sidecar.process_exit');
  assert.ok(warn, 'a sidecar.process_exit warning must be logged');
  assert.equal(warn.fields.code, 143);
  assert.equal(warn.fields.signal, 'SIGTERM');
  assert.equal(warn.fields.pendingRequests, 1);
  assert.equal(client.process, null);
});

// ---------------------------------------------------------------------------
// invalid (non-object / array) message dropped with logging (lines 640-646)
// + parse error logging (lines 631-635)
// ---------------------------------------------------------------------------

test('a JSON array frame is dropped with an invalid-message-type warning', async () => {
  const logs = [];
  const client = new SidecarClient({
    logger(level, event, fields) {
      logs.push({ level, event, fields });
    },
  });
  const proc = createMockProcess();
  client.attachProcess(proc);

  // A pending request that must survive the malformed frame.
  const pending = client.request('test.survives', {}, { timeoutMs: null });

  // An array body parses as JSON but is not a valid message object.
  proc.stdout.push(buildFrame([1, 2, 3]));
  // Then a real response that should still resolve the pending request.
  proc.stdout.push(buildFrame({ jsonrpc: '2.0', id: 1, result: { ok: true } }));

  const result = await pending;
  assert.deepEqual(result, { ok: true });

  const warn = logs.find((entry) => entry.event === 'sidecar.invalid_message_type');
  assert.ok(warn, 'invalid array message must be logged');
  assert.equal(warn.level, 'WARN');
  assert.equal(warn.fields.type, 'object');
});

test('a parse error logs sidecar.frame_parse_error and emits parse-error', async () => {
  const logs = [];
  const client = new SidecarClient({
    logger(level, event, fields) {
      logs.push({ level, event, fields });
    },
  });
  const proc = createMockProcess();
  client.attachProcess(proc);

  const parseErrors = [];
  client.on('parse-error', (error) => parseErrors.push(error));

  const malformedBody = Buffer.from('{ broken json', 'utf8');
  const frame = Buffer.concat([
    Buffer.from(`Content-Length: ${malformedBody.length}\r\n\r\n`, 'utf8'),
    malformedBody,
  ]);
  proc.stdout.push(frame);

  await nextTick();
  const errLog = logs.find((entry) => entry.event === 'sidecar.frame_parse_error');
  assert.ok(errLog, 'parse error must be logged');
  assert.equal(errLog.level, 'ERROR');
  assert.equal(errLog.fields.byteLength, malformedBody.length);
  assert.equal(parseErrors.length, 1);
  assert.ok(parseErrors[0] instanceof SyntaxError);
});

// ---------------------------------------------------------------------------
// nodejs.rejection symbol handler (lines 673-678) + _handleMessage non-object
// (lines 683-684)
// ---------------------------------------------------------------------------

test('rejection handler logs event_listener_rejection for a non-notification event', () => {
  const logs = [];
  const client = new SidecarClient({
    logger(level, event, fields) {
      logs.push({ level, event, fields });
    },
  });

  const rejectionHandler = client[Symbol.for('nodejs.rejection')].bind(client);
  rejectionHandler(new Error('listener blew up'), 'exit', { jsonrpc: '2.0' });

  const warn = logs.find((entry) => entry.event === 'sidecar.event_listener_rejection');
  assert.ok(warn, 'non-notification rejection must be logged');
  assert.equal(warn.level, 'WARN');
  assert.equal(warn.fields.event_name, 'exit');
  assert.match(warn.fields.message, /listener blew up/i);
});

test('_handleMessage ignores a non-object message and leaves real pending requests untouched', () => {
  const client = new SidecarClient();
  const proc = createMockProcess();
  client.attachProcess(proc);

  // A genuine in-flight request the guard must not disturb.
  let settled = false;
  const pending = client.request('test.untouched', {}, { timeoutMs: null });
  pending.then(() => { settled = true; }, () => { settled = true; });

  const notifications = [];
  client.on('notification', (message) => notifications.push(message));

  // The early-return guard at lines 682-684 must consume null/string frames
  // WITHOUT touching the pending map and WITHOUT emitting a notification event.
  client._handleMessage(null);
  client._handleMessage('not an object');

  // The real request is still pending (not spuriously resolved/rejected) and no
  // notification fan-out happened for the malformed frames.
  assert.equal(client.pendingRequests.size, 1, 'the real request must remain pending');
  assert.equal(settled, false, 'a malformed frame must not settle a live request');
  assert.equal(notifications.length, 0, 'non-object frames must not emit a notification');

  // Avoid leaking the unresolved promise: tear it down deterministically.
  client.dispose();
  return pending.catch(() => {});
});

// ---------------------------------------------------------------------------
// rpc error data.detail/data.code fallback message (line 705)
// ---------------------------------------------------------------------------

test('an rpc error with only data.detail builds the rejection message from data.detail', async () => {
  const client = new SidecarClient();
  const proc = createMockProcess();
  client.attachProcess(proc);

  const pending = client.request('test.rpc_detail', {}, { timeoutMs: null });
  proc.stdout.push(buildFrame({
    jsonrpc: '2.0',
    id: 1,
    error: {
      data: {
        detail: 'engine refused the request',
        code: 'CMP-AI-0002',
        category: 'engine',
        retryable: false,
      },
    },
  }));

  await assert.rejects(pending, (error) => {
    assert.match(error.message, /engine refused the request/i);
    assert.equal(error.error_code, 'CMP-AI-0002');
    assert.equal(error.category, 'engine');
    assert.equal(error.retryable, false);
    assert.equal(error.rpc.data.detail, 'engine refused the request');
    return true;
  });
});

// ---------------------------------------------------------------------------
// request-handler synchronous throw is logged (lines 752-754)
// ---------------------------------------------------------------------------

test('a synchronous notification handler throw is logged via request_handler source', async () => {
  const logs = [];
  const client = new SidecarClient({
    logger(level, event, fields) {
      logs.push({ level, event, fields });
    },
  });
  const proc = createMockProcess();
  client.attachProcess(proc);

  const promise = client.chatSend(
    { request_id: 'req_handler_throw', messages: [] },
    {
      onNotification() {
        throw new Error('sync handler exploded');
      },
      onApprovalRequest() { return false; },
    }
  );

  proc.stdout.push(buildFrame({
    jsonrpc: '2.0',
    method: 'chat.token',
    params: { request_id: 'req_handler_throw', delta: 'hi' },
  }));
  proc.stdout.push(buildFrame({ jsonrpc: '2.0', id: 1, result: { ok: true } }));

  await promise;
  const failure = logs.find((entry) => (
    entry.event === 'sidecar.notification_listener_failed'
    && entry.fields.source === 'request_handler'
    && entry.fields.request_id === 'req_handler_throw'
  ));
  assert.ok(failure, 'a request_handler failure must be logged');
  assert.match(failure.fields.message, /sync handler exploded/i);
});

// ---------------------------------------------------------------------------
// late-notification log with no handler (lines 761-768) — cancelled key but no
// registered handler
// ---------------------------------------------------------------------------

test('a correlated notification for a cancelled key with no handler logs late_notification', async () => {
  const logs = [];
  const client = new SidecarClient({
    logger(level, event, fields) {
      logs.push({ level, event, fields });
    },
  });
  const proc = createMockProcess();
  client.attachProcess(proc);

  const lateNotifications = [];
  client.on('late-notification', (message) => lateNotifications.push(message));

  // Mark the request key cancelled WITHOUT registering a notification handler.
  client._recordCancelledRequestKey('req_late_no_handler');

  proc.stdout.push(buildFrame({
    jsonrpc: '2.0',
    method: 'chat.token',
    params: { request_id: 'req_late_no_handler', trace_id: 'trace_late', delta: 'late' },
  }));

  await nextTick();
  const warn = logs.find((entry) => entry.event === 'sidecar.late_notification');
  assert.ok(warn, 'late_notification warning must be logged');
  assert.equal(warn.fields.request_id, 'req_late_no_handler');
  assert.equal(warn.fields.trace_id, 'trace_late');
  assert.equal(warn.fields.late_event, true);
  assert.equal(warn.fields.incoming_method, 'chat.token');
  assert.equal(lateNotifications.length, 1);
});

// ---------------------------------------------------------------------------
// unmatched correlated notification warns once (lines 770-782 — context for the
// unmatched path; the warn-once branch)
// ---------------------------------------------------------------------------

test('an uncorrelated-handler notification warns once and keeps counting', async () => {
  const logs = [];
  const client = new SidecarClient({
    logger(level, event, fields) {
      logs.push({ level, event, fields });
    },
  });
  const proc = createMockProcess();
  client.attachProcess(proc);

  // No handler and not cancelled: falls into the unmatched-notification branch.
  const frame = buildFrame({
    jsonrpc: '2.0',
    method: 'chat.token',
    params: { request_id: 'req_unmatched', delta: 'x' },
  });
  proc.stdout.push(frame);
  proc.stdout.push(Buffer.from(frame)); // second identical notification
  await nextTick();

  const warnings = logs.filter((entry) => entry.event === 'sidecar.unmatched_notification');
  // Warn ONCE per request_id even though two notifications arrived.
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].fields.request_id, 'req_unmatched');
  // The counter must reflect both notifications.
  assert.equal(client.unmatchedNotificationCounts.get('req_unmatched'), 2);
});

// ---------------------------------------------------------------------------
// approval handler throw => emit error, respond denied (lines 847-849)
// ---------------------------------------------------------------------------

test('an approval handler that throws denies the request and emits an error', async () => {
  const client = new SidecarClient();
  const { proc, writes } = createRecordingProcess();
  client.attachProcess(proc);

  const emitted = [];
  client.on('error', (error) => emitted.push(error));

  const promise = client.chatSend(
    { request_id: 'req_approval_throw', messages: [] },
    {
      onNotification() {},
      onApprovalRequest() {
        throw new Error('approval handler crashed');
      },
    }
  );

  proc.stdout.push(buildFrame({
    jsonrpc: '2.0',
    id: 10000010,
    method: 'tool.request_approval',
    params: { request_id: 'req_approval_throw', tool_call_id: 'call_x', tool_name: 'Write' },
  }));

  await nextTick();
  assert.equal(emitted.length, 1);
  assert.match(emitted[0].message, /approval handler crashed/i);

  const responses = writes
    .map(decodeRequest)
    .filter((message) => message.id === 10000010);
  assert.equal(responses.length, 1);
  assert.deepEqual(responses[0].result, { approved: false });

  // Resolve the outer chatSend so no pending request leaks.
  proc.stdout.push(buildFrame({ jsonrpc: '2.0', id: 1, result: { ok: true } }));
  await promise;
});

// ---------------------------------------------------------------------------
// electron tool bridge unavailable handler (lines 893-894) + error response
// (lines 902-907)
// ---------------------------------------------------------------------------

test('an electron tool request with no handler responds with an execution-failed error', async () => {
  const client = new SidecarClient();
  const { proc, writes } = createRecordingProcess();
  client.attachProcess(proc);

  // Register a chat.send WITHOUT an onElectronToolRequest handler so the bridge
  // is unavailable and the throw->error-response path runs.
  const promise = client.chatSend(
    { request_id: 'req_no_bridge', messages: [] },
    { onNotification() {}, onApprovalRequest() { return false; } }
  );

  proc.stdout.push(buildFrame({
    jsonrpc: '2.0',
    id: 10000011,
    method: 'tool.execute_electron',
    params: { request_id: 'req_no_bridge', tool_name: 'jenny_status', tool_call_id: 'call_y' },
  }));

  await nextTick();
  const responses = writes
    .map(decodeRequest)
    .filter((message) => message.id === 10000011);
  assert.equal(responses.length, 1);
  assert.equal(responses[0].error.code, -32000);
  assert.match(responses[0].error.message, /Electron tool bridge is unavailable/i);
  assert.equal(responses[0].error.data.code, 'CMP-TOOL-0008');
  assert.equal(responses[0].error.data.category, 'electron_tool_bridge');
  assert.equal(responses[0].error.data.retryable, false);

  proc.stdout.push(buildFrame({ jsonrpc: '2.0', id: 1, result: { ok: true } }));
  await promise;
});

test('an electron tool handler that rejects emits an error and responds with the failure text', async () => {
  const client = new SidecarClient();
  const { proc, writes } = createRecordingProcess();
  client.attachProcess(proc);

  const emitted = [];
  client.on('error', (error) => emitted.push(error));

  const promise = client.chatSend(
    { request_id: 'req_bridge_reject', messages: [] },
    {
      onNotification() {},
      onApprovalRequest() { return false; },
      onElectronToolRequest() {
        return Promise.reject(new Error('bridge ran but failed'));
      },
    }
  );

  proc.stdout.push(buildFrame({
    jsonrpc: '2.0',
    id: 10000012,
    method: 'tool.execute_electron',
    params: { request_id: 'req_bridge_reject', tool_name: 'jenny_status', tool_call_id: 'call_z' },
  }));

  await nextTick();
  const responses = writes
    .map(decodeRequest)
    .filter((message) => message.id === 10000012);
  assert.equal(responses.length, 1);
  assert.match(responses[0].error.message, /bridge ran but failed/i);
  assert.equal(emitted.length, 1);
  assert.match(emitted[0].message, /bridge ran but failed/i);

  proc.stdout.push(buildFrame({ jsonrpc: '2.0', id: 1, result: { ok: true } }));
  await promise;
});

// ---------------------------------------------------------------------------
// cancelled-request-key helpers: empty key (lines 929-930, 938-939), prune
// expired (lines 948-949)
// ---------------------------------------------------------------------------

test('_recordCancelledRequestKey ignores blank keys and _isCancelledRequestKey returns false', () => {
  const client = new SidecarClient();
  client._recordCancelledRequestKey('   ');
  assert.equal(client.cancelledRequestKeys.size, 0);
  assert.equal(client._isCancelledRequestKey(''), false);
  assert.equal(client._isCancelledRequestKey('   '), false);
});

test('_pruneCancelledRequestKeys drops expired tombstones', () => {
  const client = new SidecarClient();
  // Insert an already-expired tombstone directly.
  client.cancelledRequestKeys.set('req_expired', Date.now() - 1000);
  client.cancelledRequestKeys.set('req_invalid', Number.NaN);
  client._recordCancelledRequestKey('req_fresh');

  // _isCancelledRequestKey runs a prune as a side effect.
  assert.equal(client._isCancelledRequestKey('req_expired'), false);
  assert.equal(client.cancelledRequestKeys.has('req_expired'), false);
  assert.equal(client.cancelledRequestKeys.has('req_invalid'), false);
  // The fresh key survives the prune.
  assert.equal(client._isCancelledRequestKey('req_fresh'), true);
});

// ---------------------------------------------------------------------------
// _setSidecarFeatureFlags non-boolean skip (lines 958-959) via initialize
// ---------------------------------------------------------------------------

test('initialize applies only boolean feature flags from the result and lowercases keys', async () => {
  const client = new SidecarClient();
  const proc = createMockProcess();
  client.attachProcess(proc);

  const promise = client.initialize({}, { timeoutMs: null });
  proc.stdout.push(buildFrame({
    jsonrpc: '2.0',
    id: 1,
    result: {
      feature_flags: {
        Multiplexer: true,
        chat_cancel: false,
        bogus: 'not-a-boolean', // must be skipped
        another: 3, // must be skipped
      },
    },
  }));
  await promise;

  // Boolean flags applied (key lowercased); non-boolean entries skipped, so the
  // skipped keys never appear.
  assert.equal(client.sidecarFeatureFlags.multiplexer, true);
  assert.equal(client.sidecarFeatureFlags.chat_cancel, false);
  assert.equal('bogus' in client.sidecarFeatureFlags, false);
  assert.equal('another' in client.sidecarFeatureFlags, false);
});

// ---------------------------------------------------------------------------
// _sendBestEffortChatCancel early-return when not connected (lines 977-978)
// ---------------------------------------------------------------------------

test('_sendBestEffortChatCancel writes nothing when the transport is disconnected', () => {
  const client = new SidecarClient();
  const { proc, writes } = createRecordingProcess();
  client.attachProcess(proc);
  client.connected = false; // force the guard at lines 976-978

  client._sendBestEffortChatCancel({
    requestId: 'req_disconnected_cancel',
    traceId: 'trace_disc',
    sessionId: 'session_disc',
    cancelReason: 'user_cancel',
  });

  assert.equal(writes.length, 0);
});

// ---------------------------------------------------------------------------
// _sendBestEffortChatCancel onThrow logger branch (lines 994-999)
// ---------------------------------------------------------------------------

test('_sendBestEffortChatCancel logs chat_cancel_send_failed when the write throws', () => {
  const logs = [];
  const client = new SidecarClient({
    logger(level, event, fields) {
      logs.push({ level, event, fields });
    },
  });
  const proc = createMockProcess();
  proc.stdin.write = () => {
    throw new Error('cancel write blew up');
  };
  client.attachProcess(proc);

  client._sendBestEffortChatCancel({
    requestId: 'req_cancel_throw',
    traceId: 'trace_cancel_throw',
    sessionId: 'session_cancel_throw',
    cancelReason: 'user_cancel',
  });

  const warn = logs.find((entry) => entry.event === 'sidecar.chat_cancel_send_failed');
  assert.ok(warn, 'a chat_cancel_send_failed warning must be logged');
  assert.equal(warn.level, 'WARN');
  assert.equal(warn.fields.request_id, 'req_cancel_throw');
  assert.match(warn.fields.message, /cancel write blew up/i);
});
