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
  // A legacy subagent summary card carries its own Open control, like delegate's.
  assert.equal(runs.isToolRunFoldable({ toolName: 'subagent_run', status: 'completed' }), false);
  assert.equal(runs.isToolRunFoldable({ toolName: 'subagent_batch', status: 'completed' }), false);
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
  // stream-parity: the next call's thinking after the result is still mid-turn;
  // only an answer after the last tool row (or a settled phase) settles it.
  const midTurn = [
    { kind: 'assistant_text', payload: { text: 'I will draw that.' } },
    { kind: 'tool_call', payload: {} }, { kind: 'tool_result', payload: {} }, { kind: 'reasoning', payload: {} },
  ];
  assert.equal(buildMermaidFallbackBlockMarkup(payload, 'tok', { turnRows: midTurn }), '');
  assert.match(buildMermaidFallbackBlockMarkup(payload, 'tok', { turnRows: midTurn, turnPhase: 'done' }), /tool-result-diagram/);
  const finished = [...midTurn, { kind: 'assistant_text', payload: { text: 'Here it is.' } }];
  assert.match(buildMermaidFallbackBlockMarkup(payload, 'tok', { turnRows: finished }), /tool-result-diagram/);
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

// Pin to board (row 150 slice C5): the one entry every chat-side "Pin to board" goes through, and the message's own button.
const pinModule = require('../renderer/chat/renderer-chat-message-action-bindings');

function pinHarness(t, { flag = true, sessions, selection } = {}) {
  const dom = new JSDOM(`<div id="timeline"><article class="chat-entry" data-message-id="m1"><div class="chat-bubble" id="body">Hello big world</div>
    <div class="chat-hover-row" data-hover-row="true" data-message-id="m1"><button id="pin" data-message-action="pin" data-message-id="m1">Pin</button></div></article>
    <p id="elsewhere">Elsewhere text</p></div>`, { url: 'https://jenny.invalid/' });
  t.after(() => dom.window.close());
  const { window } = dom;
  const doc = window.document;
  const state = {
    currentSessionId: 's1',
    features: { featureFlags: { project_boards: flag } },
    sessions: sessions || [{ id: 's1', title: 'Auth\nredesign', project_id: 'project_alpha' }],
    messagesBySession: new Map([['s1', [{ id: 'm0', role: 'user', content: 'other' }, { id: 'm1', role: 'assistant', content: 'Hello   big\n\nworld '.padEnd(600, '!') }]]]),
  };
  const opened = [];
  const loads = [];
  window.rendererBoardPinMenu = undefined;
  window.scriptLoaderUtils = { ensureScript: async ({ src, isReady }) => { loads.push(src); window.rendererBoardPinMenu = { open: async (args) => { opened.push(args); return true; } }; return isReady(); } };
  const bindings = pinModule.createMessageActionBindings({ state, doc, appendClientLog() {}, showComposerActionError() {} });
  const select = (node, from, to, endNode = node) => { const range = doc.createRange(); range.setStart(node, from); range.setEnd(endNode, to); window.getSelection().removeAllRanges(); window.getSelection().addRange(range); };
  const click = () => bindings.handleMessageActionClick({ target: doc.getElementById('pin'), preventDefault() {}, stopPropagation() {} });
  return { window, doc, state, opened, loads, bindings, select, click, flush: async () => { for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve)); } };
}

test('pinEnabled follows the flag on the app state the bindings were made with; openPinMenu does nothing with it off', async (t) => {
  const off = pinHarness(t, { flag: false });
  assert.equal(pinModule.pinEnabled(), false);
  assert.equal(pinModule.openPinMenu({ state: off.state, windowRef: off.window, item: { kind: 'note', text: 'x' } }), false);
  assert.equal(pinModule.pinMenuItem({ state: off.state, windowRef: off.window, item: { kind: 'note', text: 'x' } }), null);
  assert.equal(off.click(), true);
  await off.flush();
  assert.deepEqual([off.loads, off.opened], [[], []], 'nothing loads and nothing opens');
  const on = pinHarness(t);
  assert.equal(pinModule.pinEnabled(), true);
  on.state.features.featureFlags.project_boards = false;
  assert.equal(pinModule.pinEnabled(), false, 'read at use time');
});

test('the message\'s Pin button pins the chat card: its chat, its message and the start of its text', async (t) => {
  const h = pinHarness(t);
  h.select(h.doc.getElementById('elsewhere').firstChild, 0, 4); // a selection outside the message
  assert.equal(h.click(), true);
  await h.flush();
  assert.deepEqual(h.loads, ['renderer/features/board/board-pin-menu.js']);
  assert.equal(h.opened.length, 1);
  const call = h.opened[0];
  assert.equal(call.projectId, 'project_alpha');
  assert.equal(call.sessionId, 's1');
  assert.equal(call.messageId, 'm1');
  assert.equal(call.heading, undefined);
  assert.equal(call.anchorEl, h.doc.getElementById('pin'));
  assert.equal(call.deps.state, h.state);
  assert.deepEqual(Object.keys(call.item).sort(), ['excerpt', 'kind', 'messageId', 'sessionId', 'title']);
  assert.deepEqual([call.item.kind, call.item.sessionId, call.item.messageId, call.item.title], ['chat', 's1', 'm1', 'Auth redesign']);
  assert.ok(call.item.excerpt.startsWith('Hello big world !'), call.item.excerpt.slice(0, 30));
  assert.ok(call.item.excerpt.length <= 400);
  assert.equal(call.item.excerpt.includes('\n'), false);
  // The menu is loaded once; the second click opens at once.
  h.window.getSelection().removeAllRanges();
  h.click();
  await h.flush();
  assert.equal(h.loads.length, 1);
  assert.equal(h.opened.length, 2);
});

test('a selection that lies inside the message pins that text as a note; one that reaches outside pins the chat card', async (t) => {
  const h = pinHarness(t);
  const text = h.doc.getElementById('body').firstChild;
  h.select(text, 6, 9); // "big"
  h.click();
  await h.flush();
  assert.deepEqual(h.opened[0].item, { kind: 'note', text: 'big' });
  assert.equal(h.opened[0].heading, 'Pin selection to board');
  assert.equal(h.opened[0].projectId, 'project_alpha');
  // From inside the message to the paragraph after it: not "inside this message".
  h.select(text, 6, 3, h.doc.getElementById('elsewhere').firstChild);
  h.click();
  await h.flush();
  assert.equal(h.opened[1].item.kind, 'chat');
  assert.equal(h.opened[1].heading, undefined);
  // A selection in the hover row's own button is not the message's text either.
  h.select(h.doc.getElementById('pin').firstChild, 0, 3);
  h.click();
  await h.flush();
  assert.equal(h.opened[2].item.kind, 'chat');
});

test('a chat with no project is pinned from General, and a message that is gone pins nothing', async (t) => {
  const h = pinHarness(t, { sessions: [{ id: 's1', title: 'Loose chat' }] });
  h.click();
  await h.flush();
  assert.equal(h.opened[0].projectId, 'project_general');
  h.state.messagesBySession.get('s1').length = 0;
  h.click();
  await h.flush();
  assert.equal(h.opened.length, 1);
});

test('pinMenuItem is a menu item that opens the picker for its item, from the flag\'s own state', async (t) => {
  const h = pinHarness(t);
  const anchor = h.doc.getElementById('pin');
  const item = pinModule.pinMenuItem({ windowRef: h.window, anchorEl: anchor, label: 'Pin selection to board', heading: 'Pin selection to board', item: { kind: 'note', text: 'abc' } });
  assert.equal(item.label, 'Pin selection to board');
  item.action();
  await h.flush();
  assert.deepEqual([h.opened[0].item, h.opened[0].heading, h.opened[0].projectId], [{ kind: 'note', text: 'abc' }, 'Pin selection to board', 'project_alpha']);
  assert.equal(pinModule.pinMenuItem({ windowRef: h.window, item: { kind: 'file', path: 'a.js' } }).label, 'Pin to board');
});

test('the named board under a sent prompt opens that board in the chat\'s project; off with the flag, ignored without an id', async (t) => {
  const h = pinHarness(t);
  const boards = [];
  h.window.scriptLoaderUtils = { ensureScript: async ({ src, isReady }) => { h.loads.push(src); h.window.rendererBoardPinMenu = { openBoard: async (id, deps) => { boards.push([id, deps.projectId]); return true; } }; return isReady(); } };
  h.doc.getElementById('timeline').insertAdjacentHTML('beforeend', '<div class="message-marks"><button type="button" id="named" class="message-mark message-mark--link" data-message-mark="board" data-board-id="board_a"><span id="named-label">Plan board</span></button><span id="unnamed" class="message-mark" data-message-mark="board">From a board</span></div>');
  const clickOn = (id) => h.bindings.handleMessageActionClick({ target: h.doc.getElementById(id), preventDefault() {}, stopPropagation() {} });
  assert.equal(clickOn('unnamed'), false, 'an unnamed board is not a control');
  assert.equal(clickOn('named-label'), true);
  await h.flush();
  assert.deepEqual([h.loads, boards], [['renderer/features/board/board-pin-menu.js'], [['board_a', 'project_alpha']]]);
  assert.equal(pinModule.openBoardFromMark({ state: h.state, windowRef: h.window, boardId: '' }), false);
  h.state.features.featureFlags.project_boards = false;
  assert.equal(clickOn('named'), false, 'with the flag off the click is not claimed');
  await h.flush();
  assert.equal(boards.length, 1, 'and nothing opens');
});
