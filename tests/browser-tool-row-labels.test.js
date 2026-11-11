'use strict';

// Row 117: a browser step's transcript row names what happened in fixed words chosen by the action
// enum alone. Page text is untrusted, so no other input field may ever reach the label.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { JSDOM } = require('jsdom');

const toolCallUtils = require('../renderer/chat/tool-call-utils');
const { createTurnRowToolRenderUtils } = require('../renderer/chat/renderer-turn-row-tool-render-utils');
const { projectTurnRows } = require('../renderer/chat/renderer-turn-row-projector');
const { projectPersistedEventsWithReducer } = require('../renderer/chat/renderer-stream-rehydrate');
const { createLiveToolPatchController } = require('../renderer/chat/renderer-stream-tool-patch-utils');
const { projectRows } = require('./helpers/renderer-turn-row-projector-helpers');
const { handleToolNotification } = require('../services/backend/chat-stream-tool-handling');
const { CanonicalTurnEventCollector } = require('../services/backend/canonical-turn-event-collector');

const WORDS = {
  navigate: 'Opened a page',
  read: 'Read the page',
  find: 'Searched the page',
  click: 'Clicked',
  type: 'Typed',
  select: 'Chose an option',
  scroll: 'Scrolled',
  press: 'Pressed a key',
  screenshot: 'Looked at the page',
};
const HOSTILE = '<img src=x onerror=alert(1)> HOSTILE-7f3a https://evil.example/secret';
const hostileFields = () => ({
  url: HOSTILE, query: HOSTILE, text: HOSTILE, ref: HOSTILE, label: HOSTILE, key: HOSTILE, value: HOSTILE,
  title: HOSTILE, path: HOSTILE, file_path: HOSTILE, file_name: HOSTILE, command: HOSTILE, pattern: HOSTILE,
});

const escapeHtml = (value) => String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function createRenderer() {
  return createTurnRowToolRenderUtils({
    escapeHtml,
    normalizeId: (value) => String(value || '').trim(),
    formatDurationMs: () => '',
    renderArtifactTeaser: () => '',
    buildToolMarkerBannerMarkup: () => '',
    renderApprovalBlock: () => '',
  });
}

function headerOf(html) {
  const document = new JSDOM(html).window.document;
  return {
    name: document.querySelector('.tool-call-name')?.textContent || '',
    summary: document.querySelector('.tool-call-summary')?.textContent || '',
    failure: document.querySelector('.tool-call-failure-summary')?.textContent || '',
  };
}

function browserRow(input, state = 'running') {
  return {
    kind: 'tool_call', row_id: 'row-1', turn_id: 'turn-1', tool_call_id: 'call-1',
    payload: { tool_call_id: 'call-1', tool_name: 'browser', tool_display_name: 'Browser', state, input },
  };
}

test('each action maps to its fixed words', () => {
  for (const [action, words] of Object.entries(WORDS)) {
    assert.equal(toolCallUtils.formatToolCallSummary('browser', { action }), words);
  }
});

test('the words never take anything from the other input fields', () => {
  for (const [action, words] of Object.entries(WORDS)) {
    assert.equal(toolCallUtils.formatToolCallSummary('browser', { action, ...hostileFields() }), words);
  }
});

test('an unknown, malformed or missing action keeps the tool name and no input field reaches it', () => {
  for (const action of [undefined, null, '', 'Navigate', ' read', HOSTILE, 'constructor', '__proto__', 'toString', 7, true, ['read'], { read: 1 }]) {
    assert.equal(toolCallUtils.formatToolCallSummary('browser', { action, ...hostileFields() }), 'Browser', String(action));
  }
  assert.equal(toolCallUtils.formatToolCallSummary('browser', {}), 'Browser');
  assert.equal(toolCallUtils.formatToolCallSummary('browser', null), 'Browser');
});

test('another tool keeps its input-derived summary', () => {
  assert.equal(toolCallUtils.formatToolCallSummary('some_tool', { action: 'read', url: 'https://a.example/' }), 'https://a.example/');
});

test('a running row and a finished live row both show the words beside the name', () => {
  const renderer = createRenderer();
  for (const state of ['running', 'completed']) {
    const header = headerOf(renderer.buildToolCallRowMarkup(browserRow({ action: 'click', ref: 'r1' }, state), [], { sessionId: 's' }));
    assert.equal(header.name, 'Browser');
    assert.equal(header.summary, 'Clicked');
  }
});

test('a row whose input only survives as input_json still gets its words', () => {
  const row = browserRow({}, 'completed');
  delete row.payload.input;
  row.payload.input_json = JSON.stringify({ action: 'scroll' });
  assert.equal(headerOf(createRenderer().buildToolCallRowMarkup(row, [], { sessionId: 's' })).summary, 'Scrolled');
});

test('a row with no action shows the tool name alone, as it always has', () => {
  const renderer = createRenderer();
  for (const input of [{}, { action: 'unknown_action' }, { action: HOSTILE, ...hostileFields() }, hostileFields()]) {
    const html = renderer.buildToolCallRowMarkup(browserRow(input, 'completed'), [], { sessionId: 's' });
    assert.deepEqual(headerOf(html), { name: 'Browser', summary: '', failure: '' });
    assert.doesNotMatch(html.split('tool-call-details')[0], /HOSTILE-7f3a/);
  }
});

test('a failed step keeps its failure line beside the words', () => {
  const row = browserRow({ action: 'click', ref: 'r1' }, 'completed');
  const resultRow = {
    kind: 'tool_result',
    payload: {
      tool_call_id: 'call-1', tool_name: 'browser', is_error: true, output_text: 'The browser step failed.',
      metadata: { result_kind: 'browser', status: 'failed' },
    },
  };
  const header = headerOf(createRenderer().buildToolCallRowMarkup(row, [], { sessionId: 's', pairedToolResultRow: resultRow }));
  assert.equal(header.summary, 'Clicked');
  assert.equal(header.failure, 'The browser step failed.');
});

test('rows reloaded from saved events get the words on both projections', () => {
  const turnId = 'turn-saved';
  const callId = 'call-saved';
  const source = ['tool-saved'];
  const events = [
    { event_id: 'e1', turn_id: turnId, kind: 'tool_use', status: 'completed', primary_message_id: 'tool-saved', source_message_ids: source,
      tool_call_id: callId, payload: { tool_call_id: callId, tool_name: 'browser', input: { action: 'find', query: HOSTILE } } },
    { event_id: 'e2', turn_id: turnId, kind: 'tool_result', status: 'completed', primary_message_id: 'tool-saved', source_message_ids: source,
      tool_call_id: callId, payload: { tool_call_id: callId, tool_name: 'browser', output_text: 'Found 2 matches.', metadata: { result_kind: 'browser', status: 'ok' } } },
  ];
  const renderer = createRenderer();
  for (const rows of [projectPersistedEventsWithReducer(events, { turnId, deterministicRowId: true }).rows, projectTurnRows(events, { deterministicRowId: true })]) {
    const header = headerOf(renderer.buildToolCallRowMarkup(rows.find((row) => row.kind === 'tool_call'), [], {
      pairedToolResultRow: rows.find((row) => row.kind === 'tool_result'), turnRows: rows,
    }));
    assert.equal(header.summary, 'Searched the page');
  }
});

// The real save path: what the backend stores for a finished step, reloaded through the message projection.
function savedBrowserMessages(toolInput) {
  const messages = [{ id: 'user_1', role: 'user', content: 'open shop.example' }];
  const service = {
    sessionStore: {
      getSessionMessages: () => messages,
      appendMessage(_sessionId, message) { messages.push(message); },
      updateMessage(_sessionId, messageId, patch) {
        const index = messages.findIndex((message) => message.id === messageId);
        if (index >= 0) messages[index] = { ...messages[index], ...patch };
      },
    },
    emit() {},
    pendingToolApprovals: new Map(),
    currentModel: 'mock-model',
    options: { userDataPath: os.tmpdir() },
  };
  const context = {
    seenToolCalls: new Set(), toolSummaries: new Map(), model: 'mock-model', resolvedSessionId: 'chat', streamId: 'stream',
    eventBase: { sessionId: 'chat', streamId: 'stream', model: 'mock-model' },
    turnEventCollector: new CanonicalTurnEventCollector({ turnId: 'stream', sessionId: 'chat' }),
  };
  const call = { request_id: 'stream', tool_call_id: 'call-1', tool_name: 'browser', tool_input: toolInput };
  handleToolNotification(service, context, { method: 'tool.executing', params: call });
  handleToolNotification(service, context, { method: 'tool.result', params: {
    ...call, success: true, output: 'page text',
    metadata: { result_kind: 'browser', status: 'ok', step_summary: 'Opened shop.example.' },
  } });
  return messages;
}

test('the action survives the save path and a reloaded chat shows the words', () => {
  const longText = 'typed '.repeat(2000);
  for (const [input, words] of [[{ action: 'navigate', url: 'https://shop.example/' }, 'Opened a page'], [{ action: 'type', ref: 'r2', text: longText }, 'Typed']]) {
    const messages = savedBrowserMessages(input);
    assert.equal(messages.find((message) => message.kind === 'tool_use').tool_call.input.action, input.action);
    const { rows } = projectRows(JSON.parse(JSON.stringify(messages)), { deterministicRowId: true });
    const callRow = rows.find((row) => row.kind === 'tool_call' || row.kind === 'tool_step');
    assert.equal(headerOf(createRenderer().buildToolCallRowMarkup(callRow, [], { turnRows: rows })).summary, words);
  }
});

function patchedSummary(toolName, initialSummary) {
  const dom = new JSDOM(`<div id="chatTimeline"><article class="chat-entry assistant" data-message-id="a1">
    <div class="chat-row" data-row-id="t:tool_step:call-1" data-row-kind="tool_step" data-tool-call-id="call-1" data-row-state="running">
      <div class="tool-call-block" data-call-id="call-1" data-tool-status="running"><div class="tool-call-header" data-call-id="call-1">
        <span class="tool-call-name">Name</span><span class="tool-call-summary">${initialSummary}</span>
        <span class="tool-call-status tool-call-status-running"><span class="tool-call-status-label">Running</span></span>
      </div></div></div></article></div>`);
  const frames = [];
  dom.window.requestAnimationFrame = (callback) => frames.push(callback);
  dom.window.cancelAnimationFrame = () => {};
  const controller = createLiveToolPatchController({
    windowRef: dom.window, chatTimeline: dom.window.document.getElementById('chatTimeline'),
    isVisibleChatSession: () => true, appendClientLog() {}, onFallback() {},
  });
  for (const [type, summary] of [['tool_use', 'Browser: navigate shop.example'], ['tool_result', 'Browser: ok']]) {
    assert.equal(controller.queueToolPatch({ type, sessionId: 'session-1', callId: 'call-1', toolName, status: 'running', summary, content: 'x', durationMs: 5 }, { eventType: type }), true);
  }
  frames.splice(0).forEach((callback) => callback(0));
  return dom.window.document.querySelector('.tool-call-summary').textContent;
}

test('a live patch never writes the backend summary over the words', () => {
  assert.equal(patchedSummary('browser', 'Opened a page'), 'Opened a page');
  assert.equal(patchedSummary('read_file', 'Reading'), 'Browser: ok', 'other tools still take the patched summary');
});

test('a run of browser steps reads as browser steps, and other tools are unchanged', () => {
  const browser = (status = 'completed') => ({ tool: 'browser', toolLabel: 'Browser', status, label: 'Clicked' });
  assert.equal(toolCallUtils.summarizeToolRun([browser(), browser(), browser()]).sentence, 'Took 3 browser steps');
  assert.equal(
    toolCallUtils.summarizeToolRun([{ tool: 'read_file', toolLabel: 'Read', status: 'completed' }, browser()]).sentence,
    'Read a file, took a browser step',
  );
  assert.equal(toolCallUtils.summarizeToolRun([browser('running')]).liveLabel, 'Clicked');
  assert.equal(toolCallUtils.toolRunVerb('lsp'), '');
  assert.equal(toolCallUtils.isToolRunFoldable({ toolName: 'browser', status: 'completed' }), true);
});
