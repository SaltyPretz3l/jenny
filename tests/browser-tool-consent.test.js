'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');

const { waitForToolApproval } = require('../services/backend/chat-stream-tool-handling');
const { CanonicalTurnEventCollector } = require('../services/backend/canonical-turn-event-collector');
const { SessionExecutionAuthority } = require('../services/backend/session-execution-authority');
const { buildManagedSidecarChatSendOptions, executeElectronToolRequest } = require('../services/backend/electron-tool-bridge');
const { browserApprovalFields } = require('../services/backend/chat-stream-tool-payload-utils');
const { MID_TOOL_CONSENT_TOOLS } = require('../services/tools/mid-tool-consent');
const { ToolExecutor, createDefaultRegistry } = require('../services/tools');

const SESSION = 'session-jenny';
const APPROVAL = Object.freeze({
  schema_version: 1, kind: 'navigate', reason: 'new_site', host: 'news.example', label: 'news.example', url: 'https://news.example/a',
});
const INPUT = Object.freeze({ action: 'navigate', url: 'https://news.example/a' });

// The real authority: a fake binding object once passed while the gate never fired (row 111).
function capture(approvalMode) {
  const project = { project_id: 'p', root_path: os.tmpdir(), root_id: 'r', root_revision: 1, device_id: 'd', inode: 'i' };
  const summary = { id: SESSION, run_mode: 'auto', plan_mode: false };
  const authority = new SessionExecutionAuthority({
    projectAuthority: { captureSession: () => project, requireCurrent: current => current, _sessionStore: { getSessionSummary: () => summary } },
    permissionStore: { getSnapshot: () => ({ version: 1, legacy_policies: {}, rules: [] }) },
    knowledgeService: { getSidecarConfig: () => ({ knowledge_roots: [] }) },
    resolveProjectWorkspaceServices: () => ({}),
  });
  return { authority, binding: authority.captureSession(SESSION, { requestId: 'stream', mode: 'assist', approvalMode }) };
}

function harness({ armed = false, approvalMode = 'prompt', safetyMode = 'normal' } = {}) {
  const emitted = [];
  const appended = [];
  const { authority, binding } = capture(approvalMode);
  const service = {
    sessionStore: {
      appendMessage(_sessionId, message) { appended.push(message); },
      updateMessage() {},
      getActiveTurn: () => ({ stream_id: 'stream', turn_id: 'turn', session_incarnation: 'incarnation' }),
      peekSessionMessages: () => [],
    },
    emit(_event, payload) { emitted.push(payload); },
    pendingToolApprovals: new Map(),
    currentModel: 'test-model',
    primaryFullAuto: { isArmed: sessionId => armed && sessionId === SESSION },
    configService: { getChatUiState: () => ({ safetyMode }) },
    sessionExecutionAuthority: authority,
  };
  const collector = new CanonicalTurnEventCollector({ turnId: 'stream', sessionId: SESSION });
  return { service, emitted, appended, binding, collector };
}

function ask(h, { toolName = 'browser', input = INPUT, messageFields = { browser_approval: APPROVAL }, controller = new AbortController() } = {}) {
  return waitForToolApproval(h.service, 'stream', SESSION, 'request', {
    tool_name: toolName, tool_call_id: 'call-1', tool_input: input, one_off_only: true, messageFields,
  }, controller, h.collector, h.binding);
}

const cardShown = emitted => emitted.some(event => event.type === 'tool_approval_needed');
const settle = () => new Promise(resolve => { setImmediate(resolve); });
const terminalResults = h => h.appended.filter(message => message.kind === 'tool_result')
  .concat(h.collector.capturedEvents.filter(event => event.kind === 'tool_result'));

test('Full auto answers a browser ask with no card and the call goes on', async () => {
  const h = harness({ armed: true, approvalMode: 'auto_run' });
  assert.equal(await ask(h), true);
  assert.equal(cardShown(h.emitted), false);
  assert.equal(h.service.pendingToolApprovals.size, 0);
  assert.equal(h.emitted.find(event => event.type === 'tool_use' && event.status === 'approved').approvalScope, 'full_auto');
});

test('ordinary Auto mode and a person-asked turn still show the card, once-only, with the browser fields', async () => {
  for (const approvalMode of ['auto_run', 'prompt']) {
    const h = harness({ armed: false, approvalMode });
    const pending = ask(h);
    await settle();
    const card = h.emitted.find(event => event.type === 'tool_approval_needed');
    assert.ok(card, `${approvalMode}: a card is shown`);
    assert.equal(card.oneOffOnly, true);
    assert.deepEqual(card.browser_approval, APPROVAL);
    assert.equal(card.toolName, 'browser');
    [...h.service.pendingToolApprovals.values()][0].resolve(true, 'approved');
    assert.equal(await pending, true);
    assert.equal(terminalResults(h).length, 0);
  }
});

test('an armed chat in a prompt turn still asks a person', async () => {
  const h = harness({ armed: true, approvalMode: 'prompt' });
  const pending = ask(h);
  await settle();
  assert.equal(cardShown(h.emitted), true);
  [...h.service.pendingToolApprovals.values()][0].resolve(false, 'denied');
  assert.equal(await pending, false);
});

test('a denial returns to the tool and writes no terminal tool result', async () => {
  const h = harness();
  const pending = ask(h);
  await settle();
  [...h.service.pendingToolApprovals.values()][0].resolve(false, 'denied');
  assert.equal(await pending, false);
  assert.equal(terminalResults(h).length, 0, 'the call is still open for the tool to report the refusal');

  // The same denial for an ordinary tool does write one, so the check above can fail.
  const other = harness();
  const otherPending = ask(other, { toolName: 'python_execute', input: { code: 'print(1)' }, messageFields: undefined });
  await settle();
  [...other.service.pendingToolApprovals.values()][0].resolve(false, 'denied');
  assert.equal(await otherPending, false);
  assert.ok(terminalResults(other).length > 0);
});

test('only an explicit approved decision is consent for a browser step', async () => {
  for (const decision of ['approved_auto', 'accepted', 'rejected']) {
    const h = harness();
    const pending = ask(h);
    await settle();
    [...h.service.pendingToolApprovals.values()][0].resolve(true, decision);
    assert.equal(await pending, false, decision);
  }
  const other = harness();
  const pending = ask(other, { toolName: 'python_execute', input: { code: 'print(1)' }, messageFields: undefined });
  await settle();
  [...other.service.pendingToolApprovals.values()][0].resolve(true, 'approved_auto');
  assert.equal(await pending, true, 'another tool still accepts approved_auto');
});

test('a malformed browser_approval is refused before any card', async () => {
  const bad = [
    undefined, null, 'x', [],
    { ...APPROVAL, schema_version: 2 },
    { ...APPROVAL, kind: 'delete' },
    { ...APPROVAL, reason: 'because' },
    { ...APPROVAL, host: 'h'.repeat(301) },
    { ...APPROVAL, host: 7 },
    { ...APPROVAL, label: 'l'.repeat(201) },
    { ...APPROVAL, url: 'u'.repeat(513) },
    { ...APPROVAL, url: null },
  ];
  for (const browser_approval of bad) {
    const h = harness({ armed: true, approvalMode: 'auto_run' });
    assert.equal(await ask(h, { messageFields: browser_approval === undefined ? {} : { browser_approval } }), false);
    assert.equal(cardShown(h.emitted), false);
    assert.equal(h.service.pendingToolApprovals.size, 0);
  }
  assert.equal(await ask(harness(), { messageFields: null }), false);
});

test('browserApprovalFields keeps only the validated fields and is empty for other tools', () => {
  const extra = { ...APPROVAL, body: 'ignored', secret: 'x' };
  assert.deepEqual(browserApprovalFields({ tool_name: 'browser', messageFields: { browser_approval: extra } }), { browser_approval: APPROVAL });
  for (const kind of ['navigate', 'click', 'submit']) {
    assert.deepEqual(browserApprovalFields({ tool_name: 'browser', messageFields: { browser_approval: { ...APPROVAL, kind } } }).browser_approval.kind, kind);
  }
  for (const reason of ['new_site', 'risky_words', 'form_post']) {
    assert.equal(browserApprovalFields({ tool_name: 'browser', messageFields: { browser_approval: { ...APPROVAL, reason } } }).browser_approval.reason, reason);
  }
  assert.deepEqual(browserApprovalFields({ tool_name: 'session_message', messageFields: { browser_approval: APPROVAL } }), {});
  assert.deepEqual(browserApprovalFields({ tool_name: 'browser' }), {});
  assert.deepEqual(browserApprovalFields(null), {});
});

test('only session_message and browser consent from inside their own execution', () => {
  assert.deepEqual([...MID_TOOL_CONSENT_TOOLS].sort(), ['browser', 'session_message']);
});

// The bridge: the tool's own approver, the per-call signal, and the closed paths.
function bridge(h, browserUse, overrides = {}) {
  h.service.toolExecutor = new ToolExecutor({
    registry: createDefaultRegistry({ toolsBrowserUseEnabled: true }),
    permissionStore: { getSnapshot: () => ({ version: 1, legacy_policies: {}, rules: [] }) },
    pathPolicy: {}, logger: () => {}, browserUse,
  });
  const controller = new AbortController();
  const options = buildManagedSidecarChatSendOptions({
    service: h.service, controller, streamId: 'stream', resolvedSessionId: SESSION, requestId: 'request',
    runtime: { persistToolBoundarySegment() {} }, executionAuthority: h.binding,
    turnIdentity: { turnId: 'turn', sessionIncarnation: 'incarnation' },
    pauseStreamIdleTimer: () => () => {},
    waitForToolApproval: (service, streamId, sessionId, requestId, params, approvalController) => waitForToolApproval(
      service, streamId, sessionId, requestId, params, approvalController, h.collector, h.binding),
    ...overrides,
  });
  return { options, controller };
}

const request = (input = INPUT) => ({ tool_name: 'browser', tool_call_id: 'call-1', arguments: input, plan_mode: false, read_only: false });

test('through the real bridge the tool asks, a person approves, and the step runs', async () => {
  const h = harness();
  const seen = [];
  const { options } = bridge(h, { get: () => ({ async execute(input, opts) {
    const decision = await opts.authorize({ tool_name: 'browser', tool_call_id: opts.callId, tool_input: input, one_off_only: true,
      messageFields: { browser_approval: APPROVAL } }, opts.abortSignal);
    seen.push(decision);
    return decision === true ? { ok: true, status: 'ok', message: 'Opened.' } : { ok: false, status: 'declined', message: 'No.' };
  } }) });
  const pending = options.onElectronToolRequest(request());
  for (let attempt = 0; !h.service.pendingToolApprovals.size && attempt < 50; attempt += 1) await settle();
  assert.equal(h.service.pendingToolApprovals.size, 1);
  [...h.service.pendingToolApprovals.values()][0].resolve(true, 'approved');
  const result = await pending;
  assert.equal(result.success, true, result.output);
  assert.deepEqual(seen, [true]);
  assert.equal(result.metadata.status, 'ok');
});

test('through the real bridge a wait on the user stops the idle watchdog and the chat.send deadline', async () => {
  const h = harness();
  const clocks = [];
  h.service.sidecarClient = { suspendRequestTimeout: (id) => { clocks.push(`transport:${id}`); return () => clocks.push('transport:resumed'); } };
  const { options } = bridge(h, { get: () => ({ async execute(_input, opts) {
    opts.suspendTurnClocks()();
    return { ok: true, status: 'ok', message: 'Waited.' };
  } }) }, { pauseStreamIdleTimer: () => { clocks.push('idle'); return () => clocks.push('idle:resumed'); } });
  const result = await options.onElectronToolRequest(request());
  assert.equal(result.success, true, result.output);
  assert.deepEqual(clocks, ['idle', 'transport:request', 'transport:resumed', 'idle:resumed']);
});

test('a per-call signal (Stop, or the user taking over) settles a pending card', async () => {
  const h = harness();
  const callSignal = new AbortController();
  const seen = [];
  const { options } = bridge(h, { get: () => ({ async execute(input, opts) {
    const decision = await opts.authorize({ tool_name: 'browser', tool_call_id: opts.callId, tool_input: input, one_off_only: true,
      messageFields: { browser_approval: APPROVAL } }, callSignal.signal);
    seen.push(decision);
    return { ok: false, status: 'cancelled', message: 'The user stopped this.' };
  } }) });
  const pending = options.onElectronToolRequest(request());
  for (let attempt = 0; !h.service.pendingToolApprovals.size && attempt < 50; attempt += 1) await settle();
  assert.equal(h.service.pendingToolApprovals.size, 1);
  callSignal.abort();
  const result = await pending;
  assert.deepEqual(seen, [false]);
  assert.equal(h.service.pendingToolApprovals.size, 0, 'the waiter is gone');
  assert.equal(result.metadata.status, 'cancelled');
});

test('the executor hands the approver only to the tools that consent mid-call', async () => {
  const h = harness();
  const authorize = async () => true;
  let received;
  const executor = new ToolExecutor({
    registry: createDefaultRegistry({ toolsBrowserUseEnabled: true }),
    permissionStore: { getSnapshot: () => ({ version: 1, legacy_policies: {}, rules: [] }) },
    pathPolicy: {}, logger: () => {},
    browserUse: { get: () => ({ async execute(_input, opts) { received = opts.authorize; return { ok: true, status: 'ok', message: 'ok' }; } }) },
  });
  assert.equal(typeof executor.browserUse.get, 'function');
  const context = { sessionId: SESSION, streamId: 'stream', logicalTurnId: 'turn', sessionIncarnation: 'incarnation',
    callId: 'call-1', backendService: h.service, executionAuthority: h.binding, abortSignal: new AbortController().signal };
  const result = await executor.executePreApproved({ callId: 'call-1', toolName: 'browser', input: { action: 'read' } }, context, { authorize });
  assert.equal(result.isError, false, result.content);
  assert.equal(received, authorize);
});

test('the hosted bridge refuses browser', async () => {
  const result = await executeElectronToolRequest({ hostMode: 'server' }, { params: { tool_name: 'browser', tool_call_id: 'c', arguments: { action: 'read' } } });
  assert.equal(result.success, false);
  assert.match(result.output, /hosted/i);
});
