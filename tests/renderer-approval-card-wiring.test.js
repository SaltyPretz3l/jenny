'use strict';

// A4 (1.2.0 gate, owner-approved design 2B, 2026-09-22): the renderers read
// each pending approval's card state, a refused answer folds the card, the
// card's Resume resumes the paused reply, and a reply pausing repaints the
// transcript even when no queued message changed.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const toolCallUtils = require('../renderer/chat/tool-call-utils');
const { escapeHtml } = require('../renderer/shared/string-utils');
const { renderApprovalBlock } = require('../renderer/chat/renderer-approval-block');
const { createTurnRowToolRenderUtils } = require('../renderer/chat/renderer-turn-row-tool-render-utils');
const { createTranscriptToolCallRenderer } = require('../renderer/chat/renderer-transcript-tool-calls');
const { createTranscriptEventBindings } = require('../renderer/chat/renderer-chat-event-transcript-bindings');
const { summary, running, queueHarness } = require('./helpers/durable-send-queue-harness');

function parse(html) {
  const dom = new JSDOM(`<!doctype html><body><div id="root">${html}</div></body>`);
  return dom.window.document.getElementById('root');
}

function cardReader(byState) {
  const refs = [];
  const read = (ref) => { refs.push(ref); return byState; };
  return { refs, read };
}

function turnRowRenderer(getApprovalCardState) {
  return createTurnRowToolRenderUtils({
    escapeHtml,
    normalizeId: (value) => String(value || '').trim(),
    formatDurationMs: () => '',
    renderArtifactTeaser: () => '',
    buildToolMarkerBannerMarkup: () => '',
    renderApprovalBlock,
    getApprovalCardState,
  });
}

const AWAITING_ROW = {
  kind: 'tool_step',
  row_id: 'row_1',
  turn_id: 'turn_1',
  primary_message_id: 'tool_use_1',
  payload: { tool_call_id: 'call_1', tool_name: 'todo_write', state: 'awaiting_approval', input: { todos: [] } },
};

test('the inline approval row reads its card state by session, turn and call', () => {
  const reader = cardReader({ state: 'paused', resumeKey: 'detached:work_1' });
  const html = turnRowRenderer(reader.read).buildApprovalGapMarkup(
    { ...AWAITING_ROW, kind: 'approval_gap' }, [], { sessionId: 'sess_1' });
  assert.deepEqual(reader.refs, [{ sessionId: 'sess_1', turnId: 'turn_1', callId: 'call_1', rowState: 'awaiting_approval' }]);
  const row = parse(html).querySelector('.approval-gap-row');
  assert.equal(row.getAttribute('data-approval-status'), 'paused');
  assert.ok(row.querySelector('[data-action="resume-paused-approval"][data-resume-key="detached:work_1"]'));
});

test('the tool row header says Paused or Withdrawn only while the runtime no longer waits', () => {
  const header = (cardState) => parse(turnRowRenderer(() => cardState)
    .buildToolCallRowMarkup(AWAITING_ROW, [], { sessionId: 'sess_1' }));
  assert.match(header({ state: 'paused', resumeKey: 'k' }).textContent, /Paused/);
  assert.match(header({ state: 'inactive' }).textContent, /Withdrawn/);
  const live = header({ state: 'live' }).textContent;
  assert.match(live, /Awaiting approval/);
  assert.doesNotMatch(live, /Paused|Withdrawn/);
});

test('the tool details card reads the same state, and its header drops "Action needed"', () => {
  const reader = cardReader({ state: 'paused', resumeKey: 'detached:work_1' });
  const renderer = createTranscriptToolCallRenderer({ escapeHtml, toolCallUtils, getApprovalCardState: reader.read });
  const message = { id: 'tool_use_1', role: 'assistant', kind: 'tool_use',
    tool_call: { call_id: 'call_1', tool_name: 'todo_write', input: { todos: [] }, status: 'awaiting_approval' } };
  const options = { sessionId: 'sess_1', turnId: 'turn_1', projectedToolRow: AWAITING_ROW,
    messageById: new Map([['tool_use_1', message]]) };
  const viewModel = renderer.buildToolCallViewModel(message, [message], options);
  assert.equal(viewModel.statusLabel, 'Paused');
  assert.equal(viewModel.secondaryMeta, '');
  assert.deepEqual(reader.refs.at(-1), { sessionId: 'sess_1', turnId: 'turn_1', callId: 'call_1' });
  const block = parse(renderer.renderToolCallBlock(message, [message], options)).querySelector('.tool-approval-block');
  assert.equal(block.getAttribute('data-approval-status'), 'paused');
  assert.equal(block.querySelector('.tool-approve-btn, .tool-deny-btn'), null);
});

function bindTimeline(t, html, { state, approve, renderAll }) {
  const dom = new JSDOM(`<!doctype html><body><div id="chatTimeline">${html}</div></body>`);
  const { window } = dom;
  const previous = { window: global.window, document: global.document };
  global.window = window;
  global.document = window.document;
  window.jennyShell = { tools: { approve, deny: approve } };
  t.after(() => { global.window = previous.window; global.document = previous.document; });
  const chatTimeline = window.document.getElementById('chatTimeline');
  const bindings = createTranscriptEventBindings({
    chatTimeline, state, renderAll,
    appendClientLog: () => {}, showComposerActionError: () => {}, thinkingController: {},
    resolveToolCallId: (target) => target?.closest?.('[data-call-id]')?.dataset.callId || '',
    toggleToolDetails: () => {}, syncThinkingBlockNode: () => {},
  });
  bindings.bindTranscriptEvents((target, name, handler, opts) => target.addEventListener(name, handler, opts));
  t.after(() => bindings.dispose());
  const click = (selector) => chatTimeline.querySelector(selector)
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  return { chatTimeline, click };
}

const flush = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };

test('a refused answer marks the call inactive and repaints the transcript', async (t) => {
  const state = { currentSessionId: 'sess_1' };
  const renders = [];
  const { click } = bindTimeline(t, renderApprovalBlock({ toolCallId: 'call_1', toolName: 'todo_write', mode: 'inline' }), {
    state, approve: () => Promise.resolve(false), renderAll: (opts) => renders.push(opts),
  });
  click('.tool-approve-btn');
  await flush();
  assert.ok(state.inactiveApprovalCallIds instanceof Set);
  assert.deepEqual([...state.inactiveApprovalCallIds], ['call_1']);
  assert.equal(renders.length, 1);
});

test('the paused card\'s Resume resumes that reply once, busy while in flight', async (t) => {
  let finish;
  const resumed = [];
  const state = { currentSessionId: 'sess_1', runtimeSendController: {
    resume: (key) => { resumed.push(key); return new Promise((resolve) => { finish = resolve; }); },
  } };
  const html = renderApprovalBlock({ toolCallId: 'call_1', toolName: 'todo_write', mode: 'inline',
    cardState: 'paused', resumeKey: 'detached:work_1' });
  const { chatTimeline, click } = bindTimeline(t, html, { state, approve: () => Promise.resolve(true), renderAll: () => {} });
  const button = chatTimeline.querySelector('[data-action="resume-paused-approval"]');
  click('[data-action="resume-paused-approval"]');
  assert.equal(button.disabled, true);
  click('[data-action="resume-paused-approval"]');
  assert.deepEqual(resumed, ['detached:work_1']);
  finish(true);
  await flush();
  assert.equal(button.disabled, false);
});

test('a paused reply found on reading the conversation repaints it; an unchanged read does not', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  let status = 'running';
  const { h } = queueHarness(t, {
    snapshot: () => ({ ok: true, next_cursor: null, work: [status === 'running' ? running(1) : summary(1, { status })] }),
  });
  const controller = h.state.runtimeSendController;
  await controller.refreshSessionRows('session-1');
  const before = h.calls.renderComposerState;
  status = 'paused';
  t.mock.timers.tick(11_000);
  await controller.refreshSessionRows('session-1');
  assert.equal(controller.listPending('session-1')[0]?.status, 'paused', 'a detached row: no queued message behind it');
  assert.ok(h.calls.renderComposerState > before, 'the paused turn\'s card must repaint');
  const settled = h.calls.renderComposerState;
  t.mock.timers.tick(11_000);
  await controller.refreshSessionRows('session-1');
  assert.equal(h.calls.renderComposerState, settled, 'an unchanged snapshot does not repaint');
});
