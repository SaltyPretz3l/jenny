'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ElectronSessionStore } = require('../../services/backend/electron-session-store');
const { ClientRegistry } = require('../../server/client-registry');
const { CommandReceipts } = require('../../server/command-receipts');
const { ControlLeases } = require('../../server/control-leases');
const { createCommandRouter } = require('../../server/command-router');

const BOOT = 'boot_test';

class BackendHarness extends EventEmitter {
  constructor(root) {
    super();
    this.sessionStore = new ElectronSessionStore(path.join(root, 'sessions.json'));
    this.activeStreams = new Map();
    this.pendingToolApprovals = new Map();
    this.pendingUserQuestions = new Map();
    this.startCalls = [];
    this.failStart = false;
    this.renameGate = null;
    this.renameEntered = null;
    this.nextStream = 0;
  }

  async listSessions() {
    const data = this.sessionStore.listSessions();
    return { object: 'list', data, total: data.length };
  }

  async createSession({ title }) {
    return { object: 'session', data: this.sessionStore.createSession({ title }) };
  }

  async renameSession(sessionId, title) {
    if (this.renameEntered) this.renameEntered();
    if (this.renameGate) await this.renameGate;
    return { object: 'session', data: this.sessionStore.renameSession(sessionId, title) };
  }

  async setSessionPreferences(sessionId, preferences) {
    return { object: 'session', data: this.sessionStore.setSessionPreferences(sessionId, preferences) };
  }

  async deleteSession(sessionId) {
    return { deleted: this.sessionStore.deleteSession(sessionId) };
  }

  async startChatStream({ sessionId, prompt, preferredModel, planMode, approvalMode }) {
    if (this.failStart) throw new Error('provider unavailable');
    this.startCalls.push({ sessionId, prompt, preferredModel, planMode, approvalMode });
    const streamId = `stream_${++this.nextStream}`;
    const message = { id: `message_${this.nextStream}`, role: 'user', content: prompt };
    if (!this.sessionStore.appendMessage(sessionId, message)) throw new Error('append failed');
    let settle;
    const pending = new Promise((resolve) => { settle = resolve; });
    this.activeStreams.set(streamId, { _pendingPromise: pending, settle, sessionId });
    return { sessionId, streamId };
  }

  cancelChatStream(streamId) {
    const controller = this.activeStreams.get(streamId);
    if (!controller) return false;
    this.finish(streamId, 'error');
    return true;
  }

  finish(streamId, type = 'complete') {
    const controller = this.activeStreams.get(streamId);
    if (!controller) return false;
    this.activeStreams.delete(streamId);
    this.emit('chat-stream', { type, sessionId: controller.sessionId, streamId });
    controller.settle();
    return true;
  }

  dispose() { this.sessionStore.dispose(); }
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-command-router-'));
  const backend = new BackendHarness(root);
  const clients = new ClientRegistry();
  const leases = new ControlLeases();
  const receipts = new CommandReceipts({ filePath: path.join(root, 'receipts.json') });
  const eventStream = {
    cursor: 0,
    events: [],
    publish(type, payload) { this.events.push({ type, payload }); this.cursor += 1; },
  };
  const router = createCommandRouter({ backend, clients, leases, receipts, bootEpoch: BOOT, eventStream });
  const a = clients.register('device-a');
  const b = clients.register('device-b');
  const context = (auth, deviceId) => ({
    deviceId, clientToken: auth.client_token, isAuthenticated: () => true,
  });
  return {
    root, backend, clients, leases, router, a, b,
    contextA: context(a, 'device-a'), contextB: context(b, 'device-b'), eventStream,
    async close() { router.dispose(); backend.dispose(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

let sequence = 0;
function command(auth, operation, params = {}, extra = {}) {
  return {
    api_version: 1,
    operation,
    request_id: `request_${++sequence}`,
    client_id: auth.client_id,
    boot_epoch: BOOT,
    params,
    ...extra,
  };
}

async function createSession(fixture) {
  const result = await fixture.router.dispatch(
    command(fixture.a, 'sessions.create', { title: 'Router test' }), fixture.contextA,
  );
  assert.equal(result.ok, true);
  return result.session.session_id;
}

async function acquire(fixture, sessionId, auth, context, takeover = false) {
  const result = await fixture.router.dispatch(
    command(auth, 'control.acquire', { takeover }, { session_id: sessionId }), context,
  );
  assert.equal(result.ok, true);
  return result.lease;
}

test('router composes authenticated control, bounded snapshot, and closed history projection', async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.close());
  const sessionId = await createSession(fixture);
  const snapshot = fixture.router.snapshot(sessionId, { max_messages: 40 });
  assert.equal(snapshot.api_version, 1);
  assert.equal(snapshot.boot_epoch, BOOT);
  assert.equal(snapshot.session.session_id, sessionId);
  assert.equal(snapshot.session.revision, `${BOOT}:1`);
  assert.deepEqual(snapshot.messages, []);
  assert.equal(Object.prototype.hasOwnProperty.call(snapshot, 'secrets'), false);
  const listed = await fixture.router.dispatch(
    command(fixture.a, 'sessions.list'), fixture.contextA,
  );
  assert.equal(listed.ok, true);
  assert.equal(listed.sessions[0].session_id, sessionId);
  assert.equal((await acquire(fixture, sessionId, fixture.a, fixture.contextA)).client_id, fixture.a.client_id);
});

test('snapshot paging is exclusive and live projection preserves bounded aggregate fields', async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.close());
  const sessionId = await createSession(fixture);
  for (let index = 1; index <= 3; index += 1) {
    fixture.backend.sessionStore.appendMessage(sessionId, {
      id: `message_page_${index}`, role: 'user', content: `message ${index}`,
    });
  }
  fixture.eventStream.snapshot = () => ({
    stream_id: 'stream_live', content: 'partial answer', status: 'thinking', truncated: true,
    reasoning: [{ id: 'reason_1', text: 'checking', timestamp: 'now', thinking_id: 'think_1' }],
  });
  const page = fixture.router.snapshot(sessionId, { max_messages: 2 });
  assert.equal(page.messages.length, 2);
  assert.equal(page.messages[0].id, 'message_page_2');
  assert.equal(page.has_more, true);
  assert.equal(page.next_before_message_id, 'message_page_2');
  const older = fixture.router.snapshot(sessionId, {
    max_messages: 2, before_message_id: page.next_before_message_id,
  });
  assert.deepEqual(older.messages.map((message) => message.id), ['message_page_1']);
  assert.equal(page.live_projection.assistant_text, 'partial answer');
  assert.equal(page.live_projection.reasoning[0].text, 'checking');
  assert.equal(page.live_projection.truncated, true);
});

test('foreground admission is synchronous, blocks a second device, and duplicate receipts join', async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.close());
  const sessionId = await createSession(fixture);
  const lease = await acquire(fixture, sessionId, fixture.a, fixture.contextA);
  const revision = fixture.router.snapshot(sessionId).session.revision;
  const firstCommand = command(fixture.a, 'chat.send', { prompt: 'first' }, {
    session_id: sessionId, control_generation: lease.generation, expected_revision: revision,
  });
  const first = fixture.router.dispatch(firstCommand, fixture.contextA);
  const duplicate = fixture.router.dispatch(firstCommand, fixture.contextA);
  const [accepted, joined] = await Promise.all([first, duplicate]);
  assert.equal(accepted.ok, true);
  assert.deepEqual(joined, accepted);
  assert.equal(fixture.backend.startCalls.length, 1);
  const takeover = await acquire(fixture, sessionId, fixture.b, fixture.contextB, true);
  const busy = await fixture.router.dispatch(command(fixture.b, 'chat.send', { prompt: 'second' }, {
    session_id: sessionId, control_generation: takeover.generation,
    expected_revision: fixture.router.snapshot(sessionId).session.revision,
  }), fixture.contextB);
  assert.equal(busy.error.reason, 'foreground_busy');
  assert.equal(fixture.backend.startCalls.length, 1);
  assert.equal(fixture.router.snapshot(sessionId).messages.length, 1);
  fixture.backend.finish(accepted.stream_id);
});

test('takeover during an awaited mutation fences the receipt as indeterminate', async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.close());
  const sessionId = await createSession(fixture);
  const lease = await acquire(fixture, sessionId, fixture.a, fixture.contextA);
  const revision = fixture.router.snapshot(sessionId).session.revision;
  let releaseRename;
  fixture.backend.renameGate = new Promise((resolve) => { releaseRename = resolve; });
  let entered;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  fixture.backend.renameEntered = entered;
  const pending = fixture.router.dispatch(command(fixture.a, 'sessions.rename', { title: 'changed' }, {
    session_id: sessionId, control_generation: lease.generation, expected_revision: revision,
  }), fixture.contextA);
  await enteredPromise;
  const takeover = await acquire(fixture, sessionId, fixture.b, fixture.contextB, true);
  assert.ok(takeover.generation > lease.generation);
  releaseRename();
  const result = await pending;
  assert.equal(result.error.reason, 'operation_indeterminate');
  assert.equal(fixture.router.snapshot(sessionId).session.title, 'changed');
  assert.notEqual(fixture.router.snapshot(sessionId).session.revision, revision);
});

test('same-revision mutations serialize and only the first backend write commits', async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.close());
  const sessionId = await createSession(fixture);
  const lease = await acquire(fixture, sessionId, fixture.a, fixture.contextA);
  const revision = fixture.router.snapshot(sessionId).session.revision;
  let releaseRename;
  fixture.backend.renameGate = new Promise((resolve) => { releaseRename = resolve; });
  let entered;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  fixture.backend.renameEntered = entered;
  let writes = 0;
  const rename = fixture.backend.renameSession.bind(fixture.backend);
  fixture.backend.renameSession = async (...args) => { writes++; return rename(...args); };
  const first = fixture.router.dispatch(command(fixture.a, 'sessions.rename', { title: 'First' }, {
    session_id: sessionId, control_generation: lease.generation, expected_revision: revision,
  }), fixture.contextA);
  await enteredPromise;
  const second = fixture.router.dispatch(command(fixture.a, 'sessions.rename', { title: 'Second' }, {
    session_id: sessionId, control_generation: lease.generation, expected_revision: revision,
  }), fixture.contextA);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes, 1);
  releaseRename();
  assert.equal((await first).ok, true);
  assert.equal((await second).error.reason, 'revision_conflict');
  assert.equal(writes, 1);
  assert.equal(fixture.router.snapshot(sessionId).session.title, 'First');
});

test('backend admission failure releases foreground while existing history remains readable', async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.close());
  const sessionId = await createSession(fixture);
  const lease = await acquire(fixture, sessionId, fixture.a, fixture.contextA);
  const revision = fixture.router.snapshot(sessionId).session.revision;
  fixture.backend.failStart = true;
  const failed = await fixture.router.dispatch(command(fixture.a, 'chat.send', { prompt: 'fails' }, {
    session_id: sessionId, control_generation: lease.generation, expected_revision: revision,
  }), fixture.contextA);
  assert.equal(failed.ok, false);
  assert.equal(failed.error.reason, 'backend_unavailable');
  const snapshot = fixture.router.snapshot(sessionId);
  assert.equal(snapshot.ok, undefined);
  assert.deepEqual(snapshot.messages, []);
  fixture.backend.failStart = false;
  const next = await fixture.router.dispatch(command(fixture.a, 'chat.send', { prompt: 'works' }, {
    session_id: sessionId, control_generation: lease.generation,
    expected_revision: snapshot.session.revision,
  }), fixture.contextA);
  assert.equal(next.ok, true);
  fixture.backend.finish(next.stream_id);
});

test('an admitted turn stays globally busy after takeover during preflight', async (t) => {
  const f = createFixture(); t.after(() => f.close());
  const sessionId = await createSession(f);
  const lease = await acquire(f, sessionId, f.a, f.contextA);
  let entered, resume;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { resume = resolve; });
  const start = f.backend.startChatStream.bind(f.backend);
  f.backend.startChatStream = async (options) => { const result = await start(options); entered(); await gate; return result; };
  const pending = f.router.dispatch(command(f.a, 'chat.send', { prompt: 'admitted' }, {
    session_id: sessionId, control_generation: lease.generation,
    expected_revision: f.router.snapshot(sessionId).session.revision,
  }), f.contextA);
  await enteredPromise;
  await acquire(f, sessionId, f.b, f.contextB, true);
  resume();
  assert.equal((await pending).error.reason, 'operation_indeterminate');
  const other = await createSession(f);
  const otherLease = await acquire(f, other, f.b, f.contextB);
  const blocked = await f.router.dispatch(command(f.b, 'chat.send', { prompt: 'second' }, {
    session_id: other, control_generation: otherLease.generation,
    expected_revision: f.router.snapshot(other).session.revision,
  }), f.contextB);
  assert.equal(blocked.error.reason, 'foreground_busy');
  assert.equal(f.backend.startCalls.length, 1);
  f.backend.finish('stream_1');
});

test('exact committed retries use receipts after revisions advance', async (t) => {
  const f = createFixture(); t.after(() => f.close());
  const sessionId = await createSession(f);
  const lease = await acquire(f, sessionId, f.a, f.contextA);
  const rename = command(f.a, 'sessions.rename', { title: 'Renamed' }, { session_id: sessionId,
    control_generation: lease.generation, expected_revision: f.router.snapshot(sessionId).session.revision });
  const renamed = await f.router.dispatch(rename, f.contextA);
  assert.equal(renamed.ok, true);
  assert.deepEqual(await f.router.dispatch(rename, f.contextA), renamed);
  assert.equal((await f.router.dispatch({ ...rename, params: { title: 'Changed payload' } }, f.contextA)).error.reason,
    'request_payload_changed');
  const send = command(f.a, 'chat.send', { prompt: 'One prompt' }, { session_id: sessionId,
    control_generation: lease.generation, expected_revision: f.router.snapshot(sessionId).session.revision });
  const sent = await f.router.dispatch(send, f.contextA);
  f.backend.finish(sent.stream_id);
  assert.deepEqual(await f.router.dispatch(send, f.contextA), sent);
  assert.equal(f.backend.startCalls.length, 1);
});

test('cancellation binds session and stream, and synchronous settlement cannot invalidate itself', async (t) => {
  const f = createFixture(); t.after(() => f.close());
  const sessionId = await createSession(f);
  const other = await createSession(f);
  const lease = await acquire(f, sessionId, f.a, f.contextA);
  const otherLease = await acquire(f, other, f.b, f.contextB);
  const sent = await f.router.dispatch(command(f.b, 'chat.send', { prompt: 'Other conversation' }, {
    session_id: other, control_generation: otherLease.generation,
    expected_revision: f.router.snapshot(other).session.revision,
  }), f.contextB);
  const denied = await f.router.dispatch(command(f.a, 'chat.cancel', { stream_id: sent.stream_id }, {
    session_id: sessionId, control_generation: lease.generation,
    expected_revision: f.router.snapshot(sessionId).session.revision,
  }), f.contextA);
  assert.equal(denied.error.reason, 'stream_session_mismatch');
  assert.equal(f.backend.activeStreams.has(sent.stream_id), true);
  const { approveToolCall, denyToolCall } = require('../../services/backend/backend-chat-stream');
  f.backend.approveToolCall = (id, options) => approveToolCall(f.backend, id, options);
  f.backend.denyToolCall = (id) => denyToolCall(f.backend, id);
  let decisions = 0;
  for (const approved of [true, false]) {
    const approvalId = `approval_${approved}`;
    f.backend.pendingToolApprovals.set(approvalId, { approvalId, sessionId: other,
      streamId: sent.stream_id, callId: 'call', toolName: 'write_file', resolve: () => {
        decisions++;
        f.backend.emit('chat-stream', { sessionId: other, streamId: sent.stream_id, type: 'tool_use' });
      } });
    const snapshot = f.router.snapshot(other);
    const resolve = command(f.b, 'approval.resolve', { stream_id: sent.stream_id, approval_id: approvalId,
      decision_revision: snapshot.pending_approvals[0].decision_revision, approved }, {
      session_id: other, control_generation: otherLease.generation, expected_revision: snapshot.session.revision,
    });
    const settled = await f.router.dispatch(resolve, f.contextB);
    assert.equal(settled.ok, true, JSON.stringify(settled));
    assert.deepEqual(await f.router.dispatch(resolve, f.contextB), settled);
  }
  assert.equal(decisions, 2);
  const stopped = await f.router.dispatch(command(f.b, 'chat.cancel', { stream_id: sent.stream_id }, {
    session_id: other, control_generation: otherLease.generation,
    expected_revision: f.router.snapshot(other).session.revision,
  }), f.contextB);
  assert.equal(stopped.ok, true);
  assert.equal(stopped.awaiting_settlement, false);
  const retried = await f.router.dispatch(command(f.b, 'chat.cancel', { stream_id: sent.stream_id }, {
    session_id: other, control_generation: otherLease.generation,
    expected_revision: stopped.revision || f.router.snapshot(other).session.revision,
  }), f.contextB);
  assert.deepEqual(retried, { ok: true, accepted: true, cancelled: true,
    stream_id: sent.stream_id, awaiting_settlement: false });
});

test('successful deletion settles its receipt and exact retries do not repeat deletion', async (t) => {
  const f = createFixture(); t.after(() => f.close());
  const sessionId = await createSession(f);
  const lease = await acquire(f, sessionId, f.a, f.contextA);
  const request = command(f.a, 'sessions.delete', {}, { session_id: sessionId,
    control_generation: lease.generation, expected_revision: f.router.snapshot(sessionId).session.revision });
  let calls = 0;
  const remove = f.backend.deleteSession.bind(f.backend);
  f.backend.deleteSession = (id) => { calls++; return remove(id); };
  const result = await f.router.dispatch(request, f.contextA);
  assert.deepEqual(result, { ok: true, session_id: sessionId, deleted: true });
  assert.equal(f.router.snapshot(sessionId), null);
  assert.deepEqual(await f.router.dispatch(request, f.contextA), result);
  assert.equal(calls, 1);
  assert.equal(f.eventStream.events.filter((event) => event.payload.state === 'deleted').length, 1);
  const receipt = await f.router.dispatch(command(f.a, 'requests.status', { request_id: request.request_id }), f.contextA);
  assert.equal(receipt.state, 'settled');
  assert.deepEqual(receipt.result, result);
});

test('cancel retries with new request ids are accepted without repeating backend cancellation', async (t) => {
  const f = createFixture(); t.after(() => f.close());
  const sessionId = await createSession(f);
  const lease = await acquire(f, sessionId, f.a, f.contextA);
  const sent = await f.router.dispatch(command(f.a, 'chat.send', { prompt: 'Cancel once' }, {
    session_id: sessionId, control_generation: lease.generation,
    expected_revision: f.router.snapshot(sessionId).session.revision,
  }), f.contextA);
  let cancelCalls = 0;
  f.backend.cancelChatStream = () => { cancelCalls++; return true; };
  const expectedRevision = f.router.snapshot(sessionId).session.revision;
  const cancel = () => f.router.dispatch(command(f.a, 'chat.cancel', { stream_id: sent.stream_id }, {
    session_id: sessionId, control_generation: lease.generation, expected_revision: expectedRevision,
  }), f.contextA);
  const first = await cancel();
  const retry = await cancel();
  assert.deepEqual(first, { ok: true, accepted: true, cancelled: true,
    stream_id: sent.stream_id, awaiting_settlement: true });
  assert.deepEqual(retry, first);
  assert.equal(cancelCalls, 1);
  f.backend.finish(sent.stream_id, 'cancelled');
  const settledRetry = await cancel();
  assert.equal(settledRetry.ok, true);
  assert.equal(settledRetry.awaiting_settlement, false);
  assert.equal(cancelCalls, 1);
});
