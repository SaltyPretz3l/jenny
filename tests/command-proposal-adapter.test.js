'use strict';

/* The exact-command Run runtime adapter and producer (row 59 checkpoint 3, Batch B2a):
 * SessionRuntimeService.submitCommandProposal -> scheduler -> CommandProposalRuntimeAdapter
 * -> startCommandProposalTurn -> a fake sidecar client answering command.execute_proposal.
 * No model, no real sidecar. Pins: one outcome event per run, the Electron-authored
 * completion line, no model/provider/inference-lease use, no chat.send fallback, capability
 * and digest checks before send, restart-paused work never resumed, queued cancel never starts. */

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createAdapterHarness, waitFor } = require('./helpers/session-runtime-chat-adapter-harness');
const { SessionRuntimeScheduler } = require('../services/session-runtime/scheduler');
const { SessionRuntimeService } = require('../services/session-runtime/service');
const { RuntimeStore } = require('../services/session-runtime/store');
const { ResourceBroker } = require('../services/session-runtime/resource-broker');
const { PhysicalPathResolver } = require('../services/session-runtime/physical-paths');
const { captureRuntimeRoute } = require('../services/session-runtime/lanes');
const { beginRuntimeInferenceInitialization, completeRuntimeInferenceInitialization } = require('../services/session-runtime/inference-protocol');
const { CommandProposalRuntimeAdapter, COMMAND_ROUTE } = require('../services/backend/command-proposal-runtime-adapter');
const { completionLine, readCommandOutcome } = require('../services/backend/command-proposal-turn');
const { normalizeCommandProposal } = require('../services/backend/command-proposal-input');
const { cancelChatStream } = require('../services/backend/backend-chat-stream');

const COMMAND = 'echo hello';
const sha = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
const DECISION_ID = '11111111-1111-4111-8111-111111111111';
const OPERATION_ID = '22222222-2222-4222-8222-222222222222';
const TOOL_CALL_ID = `pcmd_${'b'.repeat(32)}`;

function proposal(overrides = {}) {
  const command = overrides.command ?? COMMAND;
  return {
    schema_version: 1,
    proposal_id: `proposal_${'a'.repeat(64)}`,
    accepted_revision: 2,
    decision_id: DECISION_ID,
    command_operation_id: OPERATION_ID,
    tool_call_id: TOOL_CALL_ID,
    command_sha256: sha(command),
    command_binding: { backend: 'native', shell: '/bin/sh', cwd: '.', root_revision: 0, ...overrides.binding },
    command_input: { command, cwd: '.', timeout_seconds: 30, expected_exit_codes: [0], purpose: 'Show the greeting', ...overrides.input },
    ...overrides.top,
  };
}

function fakeClient(script, { capability = true } = {}) {
  const client = {
    process: {}, connected: true, requests: [], chatSendCalls: 0,
    notificationHandlers: new Map(), approvalHandlers: new Map(),
    electronToolHandlers: new Map(), runtimeOperationHandlers: new Map(),
    suspendRequestTimeout: () => () => {},
    // Cancel-drain surface (sidecar-client-command-proposal.js); batch4 off aborts at once.
    batch4: false, cancels: [], pendingRequests: new Map(),
    _batch4TransportEnabled: () => client.batch4 === true,
    _recordCancelledRequestKey() {},
    _sendBestEffortChatCancel(args) { client.cancels.push(args); },
    _cancelReasonFromSignal: () => 'user_cancel',
    chatSend() { client.chatSendCalls += 1; throw new Error('chat.send must never be used for a Run'); },
    async request(method, params, options) {
      client.requests.push({ method, params, options });
      return script({
        client, params, options,
        notify: (notification) => client.notificationHandlers.get(params.request_id)(notification),
      });
    },
  };
  completeRuntimeInferenceInitialization(client, beginRuntimeInferenceInitialization(client), {
    runtime_inference_admission_version: 1, runtime_tool_resource_admission_version: 1,
    runtime_continuation_version: 1, runtime_inference_budget_version: 1,
    ...(capability ? { command_proposal_version: 1 } : {}),
  });
  return client;
}

function toolNotifications(notify, params, { result = true } = {}) {
  const base = { tool_name: 'run_command', tool_call_id: params.tool_call_id, tool_input: params.input };
  notify({ method: 'tool.requested', params: base });
  notify({ method: 'tool.executing', params: base });
  if (result) notify({ method: 'tool.result', params: { ...base, output: 'hello', success: true } });
}

const reply = (params, outcome, status = 'completed') => ({
  request_id: params.request_id, status, response_text: 'sidecar fallback text', completion_source: 'command_proposal',
  ...(outcome ? { command_outcome: { schema_version: 1, ...outcome } } : {}), api_version: '2026-10-15',
});

function happyScript(outcome = { status: 'succeeded', exit_code: 0, cleanup: 'confirmed' }, status = 'completed') {
  return async ({ params, notify }) => {
    toolNotifications(notify, params);
    return reply(params, outcome, status);
  };
}

function harness(t, { script = happyScript(), capability = true } = {}) {
  const h = createAdapterHarness(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-command-proposal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const events = [];
  const logs = [];
  const { service } = h;
  service.emit = (name, payload) => { events.push({ name, payload }); };
  service._emitServiceLog = (level, event, details) => { logs.push({ level, event, details }); };
  service.pendingToolApprovals = new Map();
  // A Run touches no model, engine or provider: every such seam is a trap.
  service._resolveModel = () => { throw new Error('a Run resolves no model'); };
  service._startManagedSidecarChatStream = () => { throw new Error('a Run never uses the chat stream starter'); };
  service.sidecarClient = fakeClient(script, { capability });
  const store = new RuntimeStore(root);
  const commandAdapter = new CommandProposalRuntimeAdapter(service, { lanes: h.lanes,
    resourceBroker: new ResourceBroker(), pathResolver: new PhysicalPathResolver() });
  const chat = h.adapter;
  const forWork = (work) => (commandAdapter.isCommandWork(work) ? commandAdapter : chat);
  const scheduler = new SessionRuntimeScheduler({ store, lanes: h.lanes,
    resolveRoute: (work) => forWork(work).resolveRoute(work),
    validateWork: (work, route) => forWork(work).validateWork(work, route),
    prepareCanonical: (work, route) => forWork(work).prepareCanonical(work, route),
    claimCanonical: (work, route) => forWork(work).claimCanonical(work, route),
    startProducer: (context) => forWork(context.work).startProducer(context),
    pauseProducer: (work) => forWork(work).pauseProducer?.(work) ?? false,
    cancelProducer: (work, reason, options) => forWork(work).cancelProducer(work, reason, options),
    discardPending: (work) => forWork(work).discardPending(work),
    provePausedCleanup: (work, options) => forWork(work).provePausedCleanup(work, options) });
  h.lanes.onChange = () => scheduler.notifyLaneAvailability();
  const runtime = new SessionRuntimeService({ store, scheduler, chatAdapter: chat, commandAdapter });
  service.sessionRuntime = runtime;
  service.cancelChatStream = (streamId, reason) => cancelChatStream(service, streamId, reason);
  const outcomes = () => events.filter((event) => event.name === 'command-proposal-outcome').map((event) => event.payload);
  const progress = () => events.filter((event) => event.name === 'command-proposal-progress').map((event) => event.payload);
  const submit = (overrides = {}, key = 'pdk_run_one') => runtime.submitCommandProposal({
    idempotencyKey: key, sessionId: h.sessionId, commandProposal: proposal(overrides) });
  const messages = () => service.sessionStore.getSessionMessages(h.sessionId);
  return { ...h, root, events, logs, store, scheduler, runtime, commandAdapter, outcomes, progress, submit, messages,
    client: service.sidecarClient };
}

async function settled(h, workId) {
  await waitFor(() => ['completed', 'failed', 'cancelled'].includes(h.store.get(workId).status), 'the Run never settled');
  await waitFor(() => h.outcomes().length >= 1, 'no outcome event');
  return h.store.get(workId);
}

test('E1: a Run is admitted as durable command_proposal work on the synthetic route, never chat', async (t) => {
  const h = harness(t);
  const result = await h.submit();
  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  const work = h.store.get(result.work_id);
  assert.equal(work.input.kind, 'command_proposal');
  assert.equal(work.input.schema_version, 1);
  assert.deepEqual(work.input.route, { ...COMMAND_ROUTE });
  assert.equal(work.input.route.resource_class, 'cloud');
  assert.equal(work.input.route.requires_gpu, false);
  assert.equal(work.input.command_input.command, COMMAND);
  assert.equal(work.input.tool_call_id, TOOL_CALL_ID);
  assert.equal(work.input.request, undefined, 'no chat request rides the durable input');
  await settled(h, result.work_id);
});

test('happy path: one sidecar call, one outcome event, the Electron-authored completion line persisted', async (t) => {
  const h = harness(t);
  const lanesSeen = [];
  h.client.request = async function request(method, params, options) {
    lanesSeen.push(h.lanes.snapshot().lanes.map((lane) => ({ ...lane })));
    h.client.requests.push({ method, params, options });
    return happyScript()({ params, notify: (n) => h.client.notificationHandlers.get(params.request_id)(n) });
  };
  const result = await h.submit();
  const work = await settled(h, result.work_id);
  assert.equal(work.status, 'completed');
  assert.equal(h.client.requests.length, 1);
  assert.equal(h.client.chatSendCalls, 0, 'never chat.send');
  const { method, params } = h.client.requests[0];
  assert.equal(method, 'command.execute_proposal');
  assert.deepEqual(Object.keys(params).sort(), ['accept_version', 'approval_mode', 'binding', 'command_sha256', 'decision_id',
    'execution_context', 'generation', 'input', 'operation_id', 'plan_mode', 'proposal_id', 'request_id', 'schema_version',
    'accepted_revision', 'session_id', 'tool_call_id', 'trace_id', 'turn_id'].sort());
  assert.equal(params.accept_version, '2026-10-15');
  assert.equal(params.schema_version, 1);
  assert.equal(params.turn_id, result.turn_id);
  assert.equal(params.session_id, h.sessionId);
  assert.equal(params.operation_id, OPERATION_ID);
  assert.equal(params.decision_id, DECISION_ID);
  assert.equal(params.tool_call_id, TOOL_CALL_ID);
  assert.equal(params.command_sha256, sha(COMMAND));
  assert.equal(params.plan_mode, false);
  assert.equal(params.approval_mode, 'prompt');
  assert.deepEqual(params.binding, { backend: 'native', shell: '/bin/sh', cwd: '.', root_revision: 0 });
  assert.deepEqual(params.input, { command: COMMAND, cwd: '.', timeout_seconds: 30, expected_exit_codes: [0], purpose: 'Show the greeting' });
  assert.equal(params.execution_context.root_revision, 0);
  assert.equal(h.client.requests[0].options.signal.aborted, false);
  // The turn's working-time budget plus settle grace and the cancel drain, as chat.send does,
  // so a Docker approval wait is bounded by the watchdog rather than the 360 s method default.
  assert.equal(Number.isSafeInteger(h.client.requests[0].options.timeoutMs) && h.client.requests[0].options.timeoutMs > 360_000, true);
  // The synthetic cloud-class lane held the session; no local lane, no inference lease.
  assert.deepEqual(lanesSeen[0].map((lane) => [lane.lane, lane.turns, lane.inference_requests]), [['cloud:jenny-command', 1, 0]]);
  assert.deepEqual(h.outcomes(), [{ schema_version: 1, session_id: h.sessionId, proposal_id: proposal().proposal_id,
    decision_id: DECISION_ID, work_id: result.work_id, turn_id: result.turn_id, status: 'succeeded', exit_code: 0, cleanup: 'confirmed' }]);
  assert.equal(h.progress().some((event) => event.status === 'running'), true);
  assert.equal(h.progress().every((event) => event.work_id === result.work_id && event.decision_id === DECISION_ID), true);
  const rows = h.messages();
  assert.equal(rows.find((row) => row.role === 'user').content, 'Run: Show the greeting');
  const assistant = rows.filter((row) => row.role === 'assistant' && !row.kind);
  assert.equal(assistant.length, 1);
  assert.equal(assistant[0].content, 'Command finished (exit 0).', 'Electron authors the line, not the sidecar fallback');
  assert.equal(rows.some((row) => String(row.content).includes('sidecar fallback')), false);
  assert.equal(rows.some((row) => row.kind === 'tool_use'), true, 'the run_command tool row is in the transcript');
  assert.equal(JSON.stringify(h.logs).includes(COMMAND), false, 'no log line carries the command text');
  assert.equal(JSON.stringify(h.events.filter((e) => e.name.startsWith('command-proposal'))).includes(COMMAND), false);
  assert.equal(h.commandAdapter.contexts.size, 0);
});

test('failed exit code, denied and cancelled outcomes each get their own completion line and one event', async (t) => {
  const cases = [
    [{ status: 'failed', exit_code: 2, cleanup: 'confirmed' }, 'completed', 'Command failed (exit 2).', 'failed'],
    [{ status: 'denied', exit_code: null, cleanup: null }, 'denied', 'Command was denied. Nothing ran.', 'denied'],
    [{ status: 'cancelled', exit_code: null, cleanup: 'confirmed' }, 'cancelled', 'Command was cancelled.', 'cancelled'],
    [{ status: 'interrupted_unknown', exit_code: null, cleanup: 'uncertain' }, 'runtime_error', 'Command outcome unknown.', 'interrupted_unknown'],
  ];
  for (const [outcome, turnStatus, line, expected] of cases) {
    const h = harness(t, { script: happyScript(outcome, turnStatus) });
    const result = await h.submit();
    await settled(h, result.work_id);
    assert.equal(h.outcomes().length, 1, expected);
    assert.equal(h.outcomes()[0].status, expected);
    assert.equal(h.outcomes()[0].exit_code, outcome.exit_code);
    assert.equal(h.outcomes()[0].cleanup, outcome.cleanup);
    assert.equal(h.messages().some((row) => row.role === 'assistant' && String(row.content).includes(line)), true, `${expected}: ${line}`);
  }
});

test('an approval the user denies emits pending_approval then a denied outcome, and nothing ran', async (t) => {
  const h = harness(t, { script: async ({ params, notify }) => {
    const base = { tool_name: 'run_command', tool_call_id: params.tool_call_id, tool_input: params.input };
    notify({ method: 'tool.requested', params: base });
    const approved = await h.client.approvalHandlers.get(params.request_id)({ ...base, reason: 'Needs approval' });
    return reply(params, approved ? { status: 'succeeded', exit_code: 0, cleanup: 'confirmed' }
      : { status: 'denied', exit_code: null, cleanup: null }, approved ? 'completed' : 'denied');
  } });
  const result = await h.submit();
  const pending = await waitFor(() => [...h.service.pendingToolApprovals.values()][0], 'no approval was requested');
  assert.deepEqual(h.progress().map((event) => event.status), ['pending_approval']);
  pending.resolve(false, 'denied');
  await settled(h, result.work_id);
  assert.equal(h.outcomes().length, 1);
  assert.equal(h.outcomes()[0].status, 'denied');
  assert.equal(h.messages().some((row) => row.role === 'assistant' && row.content === 'Command was denied. Nothing ran.'), true);
});

test('cancel mid-run aborts the client request and reports interrupted_unknown when cleanup is unproven', async (t) => {
  let seenSignal;
  const h = harness(t, { script: ({ params, options, notify }) => {
    seenSignal = options.signal;
    toolNotifications(notify, params, { result: false });
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason || new Error('aborted')), { once: true });
    });
  } });
  const result = await h.submit();
  await waitFor(() => h.progress().some((event) => event.status === 'running'), 'the Run never started');
  const report = h.runtime.cancel(result.work_id, { reason: 'user' });
  assert.equal(report.status === 'requested' || report.status === 'cancelled', true);
  const work = await settled(h, result.work_id);
  assert.equal(seenSignal.aborted, true, 'the transport signal carries the abort that becomes chat.cancel');
  assert.equal(work.status, 'cancelled');
  assert.equal(h.outcomes().length, 1);
  assert.deepEqual([h.outcomes()[0].status, h.outcomes()[0].cleanup], ['interrupted_unknown', 'uncertain']);
});

test('a Docker Run cancelled with a confirmed sandbox drain reports cancelled with confirmed cleanup', async (t) => {
  for (const [drain, expected] of [[async () => {}, ['cancelled', 'confirmed']], [async () => { throw new Error('drain failed'); }, ['interrupted_unknown', 'uncertain']]]) {
    const h = harness(t, { script: ({ params, options, notify }) => {
      toolNotifications(notify, params, { result: false });
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason || new Error('aborted')), { once: true });
      });
    } });
    h.service.commandSandbox = { enabled: true, drainStream: drain };
    const result = await h.submit({ binding: { backend: 'docker' } });
    await waitFor(() => h.progress().some((event) => event.status === 'running'), 'the Run never started');
    h.runtime.cancel(result.work_id, { reason: 'user' });
    await settled(h, result.work_id);
    assert.deepEqual([h.outcomes()[0].status, h.outcomes()[0].cleanup], expected);
    assert.equal(h.outcomes().length, 1);
  }
});

test('a missing capability refuses before anything is sent and never falls back to chat.send', async (t) => {
  const h = harness(t, { capability: false });
  const result = await h.submit();
  const work = await settled(h, result.work_id);
  assert.equal(h.client.requests.length, 0);
  assert.equal(h.client.chatSendCalls, 0);
  assert.equal(work.status, 'completed');
  assert.deepEqual([h.outcomes()[0].status, h.outcomes()[0].exit_code, h.outcomes()[0].cleanup], ['failed', null, null]);
  assert.equal(h.outcomes().length, 1);
  assert.equal(h.messages().some((row) => String(row.content).includes('Command could not be started. Nothing ran.')), true);
});

test('Docker Stop reconciles an unproven sidecar failure with the actual drain proof', async t => {
  for (const [exitCode, drainFails, expected] of [
    [null, false, ['cancelled', null, 'confirmed']],
    [null, true, ['interrupted_unknown', null, 'uncertain']],
    [7, false, ['failed', 7, 'confirmed']],
  ]) {
    const h = harness(t, { script: ({ params, notify }) => {
      toolNotifications(notify, params, { result: false });
      return new Promise(resolve => {
        h.client.onCancel = () => setTimeout(() => resolve(reply(params, {
          status: 'failed', exit_code: exitCode, cleanup: exitCode === null ? null : 'confirmed',
        }, 'cancelled')), 20);
      });
    } });
    h.client.batch4 = true;
    const send = h.client._sendBestEffortChatCancel;
    h.client._sendBestEffortChatCancel = args => { send(args); h.client.onCancel?.(); };
    h.service.commandSandbox = { enabled: true, drainStream: async () => {
      if (drainFails) throw new Error('drain failed');
    } };
    const result = await h.submit({ binding: { backend: 'docker' } });
    await waitFor(() => h.progress().some(event => event.status === 'running'), 'the Run never started');
    h.runtime.cancel(result.work_id, { reason: 'user' });
    await settled(h, result.work_id);
    assert.equal(h.outcomes().length, 1);
    assert.deepEqual([h.outcomes()[0].status, h.outcomes()[0].exit_code, h.outcomes()[0].cleanup], expected);
  }
});

test('a digest or root-revision change after admission is refused before send', async (t) => {
  for (const tamper of [
    (context) => { context.proposal = { ...context.proposal, command_sha256: 'f'.repeat(64) }; },
    (context) => { context.proposal = { ...context.proposal, command_binding: { ...context.proposal.command_binding, root_revision: 9 } }; },
  ]) {
    const h = harness(t);
    // Hold the lane so the context can be altered while the work is still queued.
    const holder = h.lanes.tryAcquireTurn({ sessionId: h.sessionId, route: COMMAND_ROUTE }).lease;
    const result = await h.submit();
    tamper(h.commandAdapter.contexts.get(result.work_id));
    h.lanes.release(holder, { producerSettled: true });
    await settled(h, result.work_id);
    assert.equal(h.client.requests.length, 0);
    assert.equal(h.outcomes().length, 1);
    assert.equal(h.outcomes()[0].status, 'failed');
  }
});

test('a result without a structured outcome is interrupted_unknown, never a guessed success', async (t) => {
  const h = harness(t, { script: async ({ params }) => ({ request_id: params.request_id, status: 'completed', response_text: 'Command finished (exit 0).' }) });
  const result = await h.submit();
  await settled(h, result.work_id);
  assert.deepEqual([h.outcomes()[0].status, h.outcomes()[0].cleanup], ['interrupted_unknown', 'uncertain']);
  assert.equal(h.messages().some((row) => row.role === 'assistant' && row.content === 'Command outcome unknown.'), true);
});

test('a lost transport after send is interrupted_unknown with the deterministic failure copy', async (t) => {
  const h = harness(t, { script: async () => { throw new Error('Sidecar process exited'); } });
  const result = await h.submit();
  const work = await settled(h, result.work_id);
  assert.equal(work.status, 'completed', 'the transcript turn ends in the deterministic line, not a model-style failure');
  assert.equal(h.outcomes().length, 1);
  assert.equal(h.outcomes()[0].status, 'interrupted_unknown');
  assert.equal(h.messages().some((row) => String(row.content).includes('Command outcome unknown.')), true);
});

test('queued command work is discarded without ever starting', async (t) => {
  const h = harness(t);
  const holder = h.lanes.tryAcquireTurn({ sessionId: h.sessionId, route: COMMAND_ROUTE }).lease;
  const result = await h.submit();
  assert.equal(h.store.get(result.work_id).status, 'pending');
  const bindingsBefore = h.commandAdapter.contexts.size;
  assert.equal(bindingsBefore, 1);
  h.runtime.cancel(result.work_id, { reason: 'user' });
  assert.equal(h.store.get(result.work_id).status, 'cancelled');
  assert.equal(h.commandAdapter.contexts.size, 0, 'the prepared context and its binding are released');
  h.lanes.release(holder, { producerSettled: true });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.client.requests.length, 0);
  assert.deepEqual(h.outcomes().map((event) => [event.status, event.exit_code, event.cleanup]), [['cancelled', null, null]],
    'the card settles from the stored cancellation');
  assert.equal(h.messages().length, 0, 'no user row was written for a Run that never started');
});

test('restart-paused command work is never resumed, re-dispatched or re-run', async (t) => {
  const h = harness(t);
  const holder = h.lanes.tryAcquireTurn({ sessionId: h.sessionId, route: COMMAND_ROUTE }).lease;
  const result = await h.submit();
  assert.equal(h.store.get(result.work_id).status, 'pending');
  // A backend restart: the ledger reloads pending work as paused / restart_paused.
  const reopened = new RuntimeStore(h.root);
  const paused = reopened.get(result.work_id);
  assert.equal(paused.status, 'paused');
  assert.equal(paused.recovery.kind, 'restart_paused');
  const commandAdapter = new CommandProposalRuntimeAdapter(h.service, { lanes: h.lanes,
    resourceBroker: new ResourceBroker(), pathResolver: new PhysicalPathResolver() });
  const scheduler = new SessionRuntimeScheduler({ store: reopened, lanes: h.lanes,
    resolveRoute: (work) => commandAdapter.resolveRoute(work), validateWork: (work, route) => commandAdapter.validateWork(work, route),
    claimCanonical: (work, route) => commandAdapter.claimCanonical(work, route),
    startProducer: (context) => commandAdapter.startProducer(context) });
  const runtime = new SessionRuntimeService({ store: reopened, scheduler, chatAdapter: h.adapter, commandAdapter });
  h.lanes.release(holder, { producerSettled: true });
  scheduler.pump();
  scheduler.notifyLaneAvailability();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reopened.get(result.work_id).status, 'paused', 'the scheduler never dispatches paused command work');
  const refusal = runtime.resume(result.work_id, paused.revision);
  assert.deepEqual([refusal.status, refusal.reason], ['rejected', 'command_proposal_not_resumable']);
  assert.throws(() => scheduler.resume(result.work_id, paused.revision), (error) => error.code === 'command_proposal_not_resumable');
  assert.equal(reopened.get(result.work_id).status, 'paused');
  assert.equal(h.client.requests.length, 0);
  assert.equal(h.outcomes().length, 0);
  // Discard stays possible once the lifecycle is idle: a restart-paused attempt-less item is simply cancelled.
  const cancelled = runtime.cancel(result.work_id, { reason: 'user' });
  assert.equal(['cancelled', 'requested'].includes(cancelled.status), true);
});

test('a replayed key returns the existing work; refusals come back as data and leave no work', async (t) => {
  const h = harness(t);
  const holder = h.lanes.tryAcquireTurn({ sessionId: h.sessionId, route: COMMAND_ROUTE }).lease;
  const first = await h.submit();
  const again = await h.submit();
  assert.deepEqual([again.ok, again.created, again.work_id], [true, false, first.work_id]);
  assert.equal(h.commandAdapter.contexts.size, 1, 'a replay prepares nothing');
  const other = await h.runtime.submitCommandProposal({ idempotencyKey: 'pdk_run_one', sessionId: 'sess_other', commandProposal: proposal() });
  assert.deepEqual([other.ok, other.reason], [false, 'idempotency_conflict']);
  const tampered = await h.runtime.submitCommandProposal({ idempotencyKey: 'pdk_tampered', sessionId: h.sessionId,
    commandProposal: proposal({ top: { command_sha256: 'e'.repeat(64) } }) });
  assert.deepEqual([tampered.ok, tampered.reason, tampered.acceptance], [false, 'command_proposal_invalid', 'rejected']);
  const extra = await h.runtime.submitCommandProposal({ idempotencyKey: 'pdk_extra', sessionId: h.sessionId,
    commandProposal: { ...proposal(), extra_key: true } });
  assert.deepEqual([extra.ok, extra.reason], [false, 'command_proposal_invalid']);
  const drifted = await h.runtime.submitCommandProposal({ idempotencyKey: 'pdk_drift', sessionId: h.sessionId,
    commandProposal: proposal({ binding: { root_revision: 4 } }) });
  assert.deepEqual([drifted.ok, drifted.reason], [false, 'command_proposal_authority_changed']);
  const badKey = await h.runtime.submitCommandProposal({ idempotencyKey: 'bad key', sessionId: h.sessionId, commandProposal: proposal() });
  assert.equal(badKey.ok, false);
  assert.equal(h.store.findSubmission('pdk_tampered'), null);
  assert.equal(h.store.findSubmission('pdk_extra'), null);
  assert.equal(h.store.findSubmission('pdk_drift'), null);
  assert.equal(h.commandAdapter.contexts.size, 1);
  h.scheduler.setEnabled(false);
  const disabled = await h.submit({}, 'pdk_off');
  assert.deepEqual([disabled.ok, disabled.reason], [false, 'runtime_disabled']);
  h.scheduler.setEnabled(true);
  h.scheduler.beginClosing();
  const closing = await h.submit({}, 'pdk_closing');
  assert.deepEqual([closing.ok, closing.reason], [false, 'runtime_closing']);
  assert.equal(h.client.requests.length, 0);
  h.lanes.release(holder, { producerSettled: true });
});

test('a runtime without the command adapter reports runtime_unavailable and the service never sends', async (t) => {
  const h = harness(t);
  const bare = new SessionRuntimeService({ store: h.store, scheduler: h.scheduler, chatAdapter: h.adapter });
  const result = await bare.submitCommandProposal({ idempotencyKey: 'pdk_bare', sessionId: h.sessionId, commandProposal: proposal() });
  assert.deepEqual([result.ok, result.reason, result.acceptance], [false, 'runtime_unavailable', 'rejected']);
  assert.equal(h.store.findSubmission('pdk_bare'), null);
});

test('the synthetic route is trusted only when the stored route equals it', async (t) => {
  const h = harness(t);
  assert.equal(h.commandAdapter.resolveRoute({ input: { route: { ...COMMAND_ROUTE } } }), COMMAND_ROUTE);
  assert.throws(() => h.commandAdapter.resolveRoute({ input: { route: { ...COMMAND_ROUTE, provider_id: 'ollama' } } }),
    (error) => error.code === 'runtime_provider_route_untrusted');
  assert.throws(() => h.commandAdapter.resolveRoute({ input: {} }), (error) => error.code === 'runtime_provider_route_untrusted');
  assert.notEqual(captureRuntimeRoute({ ...COMMAND_ROUTE }), COMMAND_ROUTE, 'a copy is not the branded route');
});

test('the closed record validator mirrors the sidecar decoder', () => {
  const ok = normalizeCommandProposal(proposal());
  assert.equal(Object.isFrozen(ok), true);
  assert.equal(Object.isFrozen(ok.command_input.expected_exit_codes), true);
  const bad = (overrides) => assert.throws(() => normalizeCommandProposal(overrides), (error) => error.code === 'command_proposal_invalid');
  bad(null);
  bad(proposal({ top: { schema_version: 2 } }));
  bad(proposal({ top: { proposal_id: 'has space' } }));
  bad(proposal({ top: { decision_id: 'not-a-uuid' } }));
  bad(proposal({ top: { accepted_revision: 0 } }));
  bad(proposal({ binding: { backend: 'remote' } }));
  bad(proposal({ binding: { shell: 'bash' } }));
  bad(proposal({ binding: { cwd: 'other' } }));
  bad(proposal({ input: { timeout_seconds: 301 } }));
  bad(proposal({ input: { timeout_seconds: 0 } }));
  bad(proposal({ input: { expected_exit_codes: [] } }));
  bad(proposal({ input: { expected_exit_codes: [0, 0] } }));
  bad(proposal({ input: { expected_exit_codes: [256] } }));
  bad(proposal({ input: { purpose: '   ' } }));
  bad({ ...proposal(), command_input: { ...proposal().command_input, extra: 1 } });
  bad(proposal({ command: 'a\0b' }));
  bad(proposal({ command: ' '.repeat(3) }));
  assert.doesNotThrow(() => normalizeCommandProposal(proposal({ command: 'x'.repeat(8 * 1024) })));
  bad(proposal({ command: 'x'.repeat(8 * 1024 + 1) }));
  assert.doesNotThrow(() => normalizeCommandProposal(proposal({ input: { timeout_seconds: 120 }, binding: { backend: 'docker', shell: '/bin/sh' } })));
  bad(proposal({ input: { timeout_seconds: 121 }, binding: { backend: 'docker', shell: '/bin/sh' } }));
  bad(proposal({ binding: { backend: 'docker', shell: 'cmd.exe' } }));
});

test('completion copy and outcome reading are closed', () => {
  assert.equal(completionLine({ status: 'succeeded', exit_code: 0 }), 'Command finished (exit 0).');
  assert.equal(completionLine({ status: 'succeeded', exit_code: null }), 'Command finished.');
  assert.equal(completionLine({ status: 'failed', exit_code: 2 }), 'Command failed (exit 2).');
  assert.equal(completionLine({ status: 'failed', exit_code: null }), 'Command failed.');
  assert.equal(completionLine({ status: 'denied' }), 'Command was denied. Nothing ran.');
  assert.equal(completionLine({ status: 'cancelled' }), 'Command was cancelled.');
  assert.equal(completionLine({ status: 'interrupted_unknown' }), 'Command outcome unknown.');
  assert.equal(completionLine({ status: 'failed' }, { notStarted: true }), 'Command could not be started. Nothing ran.');
  assert.equal(readCommandOutcome(null), null);
  assert.equal(readCommandOutcome({ command_outcome: { schema_version: 2, status: 'succeeded' } }), null);
  assert.equal(readCommandOutcome({ command_outcome: { schema_version: 1, status: 'done' } }), null);
  assert.deepEqual({ ...readCommandOutcome({ command_outcome: { schema_version: 1, status: 'failed', exit_code: '3', cleanup: 'maybe' } }) },
    { status: 'failed', exit_code: null, cleanup: null });
});

test('review #4: a native Stop keeps the sidecar answer that arrives during the cancel drain', async (t) => {
  const h = harness(t, { script: ({ params, options, notify }) => {
    toolNotifications(notify, params, { result: false });
    return new Promise((resolve) => {
      options.signal.addEventListener('abort', () => resolve(reply(params, { status: 'never', exit_code: null }, 'cancelled')), { once: true });
      // The sidecar proves cleanup and answers shortly after chat.cancel; the inner signal is not aborted yet.
      h.client.onCancel = () => setTimeout(() => resolve(reply(params, { status: 'cancelled', exit_code: null, cleanup: 'confirmed' }, 'cancelled')), 20);
    });
  } });
  h.client.batch4 = true;
  const send = h.client._sendBestEffortChatCancel;
  h.client._sendBestEffortChatCancel = (args) => { send(args); h.client.onCancel?.(); };
  const result = await h.submit();
  await waitFor(() => h.progress().some((event) => event.status === 'running'), 'the Run never started');
  h.runtime.cancel(result.work_id, { reason: 'user' });
  await settled(h, result.work_id);
  assert.equal(h.client.cancels.length, 1, 'chat.cancel went out once, at Stop');
  assert.equal(h.client.requests[0].options.signal.aborted, false, 'the request stayed open for the drain');
  assert.equal(h.outcomes().length, 1);
  assert.deepEqual([h.outcomes()[0].status, h.outcomes()[0].cleanup], ['cancelled', 'confirmed']);
});

test('review #1: offline lockdown refuses a Run at submission and at admission', async (t) => {
  const h = harness(t);
  h.service.featureFlags.session_offline_lockdown = true;
  h.service.sessionStore.updateSession(h.sessionId, { lockdown: true });
  const refused = await h.submit();
  assert.deepEqual([refused.ok, refused.reason], [false, 'command_proposal_lockdown']);
  assert.equal(h.client.requests.length, 0);
  // Lockdown switched on while the Run is queued: admission refuses and the card settles as failed.
  h.service.sessionStore.updateSession(h.sessionId, { lockdown: false });
  const holder = h.lanes.tryAcquireTurn({ sessionId: h.sessionId, route: COMMAND_ROUTE }).lease;
  const queued = await h.submit({}, 'pdk_lockdown_queued');
  assert.equal(queued.ok, true);
  h.service.sessionStore.updateSession(h.sessionId, { lockdown: true });
  h.lanes.release(holder, { producerSettled: true });
  await waitFor(() => h.outcomes().length >= 1, 'no outcome event');
  assert.equal(h.store.get(queued.work_id).status, 'paused');
  assert.deepEqual([h.outcomes()[0].status, h.outcomes()[0].exit_code], ['failed', null]);
  assert.equal(h.client.requests.length, 0);
});

test('review #6: the captured approval mode rides the wire and a run-mode flip while queued fails visibly', async (t) => {
  const h = harness(t);
  h.service.projectAuthority._sessionStore = h.service.sessionStore;
  h.service.sessionStore.updateSession(h.sessionId, { run_mode: 'auto' });
  const holder = h.lanes.tryAcquireTurn({ sessionId: h.sessionId, route: COMMAND_ROUTE }).lease;
  const result = await h.submit();
  assert.equal(result.ok, true);
  h.service.sessionStore.updateSession(h.sessionId, { run_mode: 'ask' });
  h.lanes.release(holder, { producerSettled: true });
  await waitFor(() => h.outcomes().length >= 1, 'a run-mode flip left the Run queued');
  assert.notEqual(h.store.get(result.work_id).status, 'pending');
  assert.deepEqual([h.outcomes()[0].status, h.outcomes()[0].exit_code], ['failed', null]);
  assert.equal(h.client.requests.length, 0);
  // Without a flip, the wire carries the mode captured at submit even if the session reads differently later.
  // (This harness has no run-state reader, so the flip below is not detected as run_mode_changed.)
  const again = harness(t);
  again.service.sessionStore.updateSession(again.sessionId, { run_mode: 'auto' });
  const lane = again.lanes.tryAcquireTurn({ sessionId: again.sessionId, route: COMMAND_ROUTE }).lease;
  const sent = await again.submit({}, 'pdk_mode_wire');
  again.service.sessionStore.updateSession(again.sessionId, { run_mode: 'ask' });
  again.lanes.release(lane, { producerSettled: true });
  await settled(again, sent.work_id);
  assert.equal(again.client.requests[0].params.approval_mode, 'auto_run');
});
