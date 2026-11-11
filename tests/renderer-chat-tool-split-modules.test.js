'use strict';

// Focused contracts for the modules split out of the chat tool renderers
// (row 104 S7): each factory is exercised directly here; the parents'
// suites (tool-call-utils, turn-row tool render utils, chat-event utils and
// transcript bindings) keep covering them end to end through the re-exports.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const toolCallUtils = require('../renderer/chat/tool-call-utils');
const { escapeHtml, normalizeString } = require('../renderer/shared/string-utils');
const { createToolCallStatus } = require('../renderer/chat/tool-call-status');
const { createToolRunUtils } = require('../renderer/chat/tool-run-utils');
const { createToolRowExpansionState } = require('../renderer/chat/renderer-tool-row-expansion-state');
const { createMermaidFallbackRenderer } = require('../renderer/chat/renderer-turn-row-mermaid-fallback');
const { createApprovalGapMarkup } = require('../renderer/chat/renderer-turn-row-approval-gap-markup');
const { createMinimalToolRowToggles } = require('../renderer/chat/renderer-chat-tool-row-toggles');
const { createChatShellSubscriptions } = require('../renderer/chat/renderer-chat-shell-subscriptions');
const { createApprovalCardBindings } = require('../renderer/chat/renderer-chat-approval-card-bindings');
const { createMessageActionBindings } = require('../renderer/chat/renderer-chat-message-action-bindings');

const normalizeId = (value) => String(value || '').trim();
const echoJt = (key, fallback, params) => `${key}|${params ? fallback.replace(/\{(\w+)\}/g, (m, n) => String(params[n])) : fallback}`;

test('tool-call-status binds the injected i18n reader and backs the toolCallUtils re-exports', () => {
  assert.throws(() => createToolCallStatus({}), TypeError);
  const status = createToolCallStatus({ normalizeString, jt: echoJt, clipLabel: (text) => text });
  assert.equal(status.normalizeToolStatus('timeout'), 'timed_out');
  assert.equal(status.statusForToolResult({ is_error: true, error_code: 'CMP-TOOL-0007' }), 'blocked');
  assert.equal(status.getResultStatusLabel('errored', { metadata: { exit_code: 3 } }), 'chat.toolShell.exitCode|exit 3');
  assert.equal(status.statusToneFor('timed_out'), 'warn');
  assert.equal(toolCallUtils.getStatusLabel('abandoned'), 'No result');
  assert.equal(toolCallUtils.statusForToolResult({ is_error: true, metadata: { timed_out: true } }), 'timed_out');
});

test('tool-run-utils folds, groups and summarizes runs with the injected vocabulary', () => {
  assert.throws(() => createToolRunUtils({}), TypeError);
  const runs = createToolRunUtils({
    normalizeString,
    normalizeToolKind: toolCallUtils.normalizeToolKind,
    normalizeToolStatus: toolCallUtils.normalizeToolStatus,
    getToolDisplayName: toolCallUtils.getToolDisplayName,
    statusToneFor: toolCallUtils.statusToneFor,
    formatToolDurationMs: toolCallUtils.formatToolDurationMs,
    escapeHtml,
    jt: (key, fallback) => fallback,
    jtn: (key, count, params, one, other) => (count === 1 ? one : other).replace('{count}', String(count)),
  });
  assert.equal(runs.isToolRunFoldable({ toolName: 'ask_user' }), false);
  assert.deepEqual(runs.groupToolRuns([{ role: 'member' }, { role: 'transparent' }, { role: 'member' }, { role: 'break' }]),
    [{ members: [0, 2], interior: [1] }]);
  const summary = runs.summarizeToolRun([{ tool: 'read_file', status: 'completed' }, { tool: 'read_file', status: 'errored' }]);
  assert.equal(summary.sentence, 'Read 2 files');
  assert.equal(runs.toolRunState(summary), 'failed');
  assert.match(runs.buildToolRunMemberAttributes({ tool: 'a"b', durationMs: 5 }), /data-run-tool="a&quot;b"/);
});

test('each tool-row expansion store keeps its own bounded overrides and lazy contexts', () => {
  const first = createToolRowExpansionState();
  const second = createToolRowExpansionState();
  const key = toolCallUtils.buildToolRowKey({ sessionId: 's1', callId: 'c1' });
  first.setToolRowExpansion(key, true);
  assert.equal(first.getToolRowExpansion(key), true);
  assert.equal(second.getToolRowExpansion(key), undefined);
  assert.deepEqual(first.materializeToolRowDetails(key), { ok: false, reason: 'missing_render_context', markup: '' });
  first.registerToolDetailContext(key, { buildDetailBodyMarkup: (model) => `body:${model.expandFileDiffsByDefault}` }, {});
  assert.deepEqual(first.materializeToolRowDetails(key), { ok: true, reason: '', markup: 'body:true' });
  assert.equal(first.materializeToolRowDetails(key).reason, 'missing_render_context', 'a context materializes once');
  first.clearToolRowExpansionOverridesForSession('s1');
  assert.equal(first.getToolRowExpansion(key), undefined);
});

test('the mermaid fallback renders only for a settled turn whose answer lacks the fence', () => {
  assert.throws(() => createMermaidFallbackRenderer({}), TypeError);
  const { buildMermaidFallbackBlockMarkup } = createMermaidFallbackRenderer({ escapeHtml, normalizeId });
  const source = 'graph TD\n  A-->B';
  const payload = { tool_name: 'mermaid_generate', tool_call_id: 'c1', output_text: JSON.stringify({ mermaid: source }) };
  assert.match(buildMermaidFallbackBlockMarkup(payload, 'tok', {}), /class="tool-result-body tool-result-diagram" data-tool-call-id="c1"/);
  assert.equal(buildMermaidFallbackBlockMarkup(payload, 'tok', { isStreaming: true }), '');
  assert.equal(buildMermaidFallbackBlockMarkup({ ...payload, tool_name: 'read_file' }, 'tok', {}), '');
  const answered = [{ kind: 'assistant_text', payload: { text: '```mermaid\n' + source + '\n```' } }];
  assert.equal(buildMermaidFallbackBlockMarkup(payload, 'tok', { turnRows: answered }), '');
});

test('the approval gap row hands the block the exact command and the live card state', () => {
  const calls = [];
  const build = (renderApprovalBlock, getApprovalCardState) => createApprovalGapMarkup({
    settings: { getApprovalCardState }, toolCallUtils, normalizeId, escapeHtml, renderApprovalBlock,
    resolveProjectedRowCallId: toolCallUtils.resolveProjectedRowCallId,
  });
  const row = { turn_id: 't1', payload: { tool_call_id: 'c1', tool_name: 'run_command', approval_id: 'a1', state: 'awaiting_approval', input: { command: 'npm test' } } };
  assert.equal(build(null).buildApprovalGapMarkup(row, [], {}), '');
  const gap = build((model) => { calls.push(model); return '<card>'; }, (query) => ({ state: 'live', query }));
  assert.equal(gap.buildApprovalGapMarkup(row, [], { sessionId: 's1' }), '<card>');
  assert.equal(calls[0].toolCallId, 'c1');
  assert.equal(calls[0].displayToolName, 'Bash');
  assert.equal(calls[0].commandText, 'npm test');
  assert.equal(calls[0].cardState, 'live');
  assert.deepEqual(gap.readApprovalCardState(row, 'c1', { sessionId: 's1' }).query,
    { sessionId: 's1', turnId: 't1', callId: 'c1', rowState: 'awaiting_approval' });
});

test('a minimal tool row toggle flips its expansion and the inert body without motion', (t) => {
  const dom = new JSDOM(`<div id="timeline"><div class="tool-call-row tool-call-row--minimal" data-tool-row-key="k1" data-expanded="false">
    <div class="tool-call-row-toggle" data-tool-row-toggle="true" data-tool-row-key="k1" aria-expanded="false"></div>
    <div class="tool-call-row-body" inert></div></div></div>`);
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  const expansions = [];
  doc.getElementById('timeline').addEventListener('tool-row-user-expansion', (event) => expansions.push(event.detail));
  const { toggleMinimalToolRow } = createMinimalToolRowToggles({
    chatTimeline: doc.getElementById('timeline'), doc, getToolDetailsTransitionMs: () => 0,
  });
  const toggle = doc.querySelector('[data-tool-row-toggle]');
  toggleMinimalToolRow(toggle);
  assert.equal(doc.querySelector('.tool-call-row').getAttribute('data-expanded'), 'true');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(doc.querySelector('.tool-call-row-body').hasAttribute('inert'), false);
  toggleMinimalToolRow(toggle, false);
  assert.equal(doc.querySelector('.tool-call-row-body').hasAttribute('inert'), true);
  assert.deepEqual(expansions.map((detail) => ({ ...detail })), [{ rowKey: 'k1', expanded: true }, { rowKey: 'k1', expanded: false }]);
});

test('shell subscriptions bind in order and a signed-out auth push resets the renderer', async (t) => {
  const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const previousWindow = globalThis.window;
  t.after(() => { if (hadWindow) globalThis.window = previousWindow; else delete globalThis.window; });
  const order = [];
  const handlers = {};
  const subscribe = (name) => (handler) => { order.push(name); handlers[name] = handler; return () => order.push(`${name}.off`); };
  globalThis.window = { jennyShell: {
    diagnostics: { logs: { onEntry: subscribe('logs') } }, backend: { onStatus: subscribe('backend') },
    lifecycle: { onProgress: subscribe('lifecycle') }, auth: { onState: subscribe('auth') },
  } };
  const map = () => new Map([['x', 1]]);
  const state = {
    sessions: [{ id: 's1' }], currentSessionId: 's1', messagesBySession: map(), pendingStreams: map(),
    streamThinkingStatusByStream: map(), toolCallsByStream: map(), pendingToolApprovals: map(), interactiveDraftsBySession: map(),
    memoryManager: { memories: [1], draftsById: map(), pendingActionById: map() }, ui: {},
  };
  const calls = [];
  const callback = (name) => () => { calls.push(name); };
  const subscriptions = createChatShellSubscriptions({
    state,
    callbacks: new Proxy({}, { get: (target, key) => (key === 'reportError' ? null : callback(String(key))) }),
    TOAST_SOURCE: {},
    thinkingController: { prune: callback('prune'), resumeAutoScroll: callback('resumeAutoScroll') },
    backendRecoveryUtils: { recoverInflightSendsForUnusableBackend() {} },
    asyncFence: require('../renderer/shared/async-fence'),
    clearThreadBranchCollapseState: callback('clearThreadBranchCollapseState'),
  });
  const cleanups = [];
  subscriptions.bind((cleanup) => cleanups.push(cleanup));
  assert.deepEqual(order, ['logs', 'backend', 'lifecycle', 'auth']);
  await handlers.auth({ authenticated: false });
  assert.equal(state.currentSessionId, '');
  assert.equal(state.messagesBySession.size, 0);
  assert.deepEqual(state.memoryManager.memories, []);
  assert.ok(calls.includes('resetPanes') && calls.includes('clearThreadBranchCollapseState') && calls.includes('prune'));
  assert.equal(calls[calls.length - 1], 'renderAll');
  subscriptions.dispose();
  cleanups.forEach((cleanup) => cleanup());
  assert.ok(order.includes('auth.off'));
});

test('approval card and message action bindings claim only their own clicks', (t) => {
  const dom = new JSDOM(`<div id="timeline"><button data-message-action="copy" data-message-id="m1"></button>
    <button data-action="resume-paused-approval" data-resume-key="r1"></button><span id="other"></span></div>`);
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  const copied = [];
  const resumed = [];
  const state = { runtimeSendController: { resume: (key) => { resumed.push(key); return Promise.resolve(true); } } };
  const messageActions = createMessageActionBindings({
    state, doc, handleCopyMessage: (id) => { copied.push(id); return Promise.resolve(); },
    appendClientLog() {}, showComposerActionError() {},
  });
  const approvalCards = createApprovalCardBindings({
    chatTimeline: doc.getElementById('timeline'), doc, windowRef: dom.window, state, getSessionId: () => 's1',
    appendClientLog() {}, showComposerActionError() {}, renderAll() {}, refreshRecoveredSession: () => Promise.resolve(),
    resolveToolCallId: () => '',
  });
  t.after(() => approvalCards.dispose());
  const click = (selector) => ({ target: doc.querySelector(selector), preventDefault() {}, stopPropagation() {} });
  assert.equal(messageActions.handleMessageActionClick(click('#other')), false);
  assert.equal(approvalCards.handleApprovalClick(click('#other')), false);
  assert.equal(messageActions.handleMessageActionClick(click('[data-message-action]')), true);
  assert.deepEqual(copied, ['m1']);
  assert.equal(approvalCards.handleApprovalClick(click('[data-action="resume-paused-approval"]')), true);
  assert.deepEqual(resumed, ['r1']);
});
