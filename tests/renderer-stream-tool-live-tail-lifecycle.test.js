'use strict';

// Live tool-output tail lifecycle: production row markup, remount, identity,
// stream end, visibility and handler disposal.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createToolLiveTail } = require('../renderer/chat/renderer-stream-tool-live-tail');
const { createTurnRowToolRenderUtils } = require('../renderer/chat/renderer-turn-row-tool-render-utils');
const { createHarness, flushMicrotasks } = require('./helpers/renderer-stream-handler-harness');

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const toolRenderer = createTurnRowToolRenderUtils({
  escapeHtml,
  normalizeId(value) { return String(value || '').trim(); },
  formatDurationMs(ms) { return Number(ms) > 0 ? `${ms}ms` : ''; },
  renderArtifactTeaser() { return ''; },
  buildToolMarkerBannerMarkup() { return ''; },
  renderApprovalBlock() { return ''; },
});

function minimalRowHtml(callId, { state = 'running', view = 'answers', sessionId = 'session-1' } = {}) {
  const markup = toolRenderer.buildToolCallRowMarkup({
    payload: { tool_call_id: callId, tool_name: 'run_command', state, input: { command: 'npm test' } },
  }, [], { sessionId, transcriptView: view });
  return `<div class="chat-row" data-tool-call-id="${callId}">${markup}</div>`;
}

function classicRowHtml(callId, status = 'running') {
  return `<div class="chat-row" data-tool-call-id="${callId}"><div class="tool-call-block" data-call-id="${callId}" data-tool-status="${status}"></div></div>`;
}

function makeTimeline(html = '') {
  const dom = new JSDOM(`<div id="timeline">${html}</div>`);
  return { dom, timeline: dom.window.document.getElementById('timeline') };
}

function macrotask(dom) {
  return new Promise((resolve) => dom.window.setTimeout(resolve, 0));
}

function chunk(callId, text, extra = {}) {
  return { sessionId: 'session-1', streamId: 'a', callId, lines: [{ text }], ...extra };
}

function paneTexts(root) {
  return Array.from(root.querySelectorAll('[data-tool-live-output]'))
    .map((pane) => pane.querySelector('.tool-live-output-text').textContent);
}

for (const view of ['answers', 'thinking', 'everything']) {
  test(`production minimal row mounts one pane inside the row body (${view} view)`, (t) => {
    const { dom, timeline } = makeTimeline(minimalRowHtml('call-prod', { view }));
    const tail = createToolLiveTail({ getChatTimeline: () => timeline });
    t.after(() => { tail.dispose(); dom.window.close(); });

    assert.equal(tail.appendChunk(chunk('call-prod', 'compiling')), true);

    const row = timeline.querySelector('.tool-call-row--minimal');
    assert.equal(row.querySelectorAll('[data-tool-live-output]').length, 1);
    const pane = row.querySelector('.tool-call-row-body > [data-tool-live-output]');
    assert.ok(pane, 'pane is a direct child of the row body');
    assert.equal(pane.querySelector('.tool-live-output-text').textContent, 'compiling');
    assert.equal(row.querySelector('.tool-call-row-body').lastElementChild, pane);
  });
}

for (const [label, rowHtml] of [
  ['production minimal row', () => minimalRowHtml('call-r')],
  ['classic block', () => classicRowHtml('call-r')],
]) {
  test(`a replaced ${label} gets its retained output back without a new chunk`, async (t) => {
    const { dom, timeline } = makeTimeline(rowHtml());
    const tail = createToolLiveTail({ getChatTimeline: () => timeline });
    t.after(() => { tail.dispose(); dom.window.close(); });
    const identity = { sessionId: 'session-1', streamId: 'a', callId: 'call-r' };

    tail.appendChunk(chunk('call-r', 'retained output'));
    assert.deepEqual(paneTexts(timeline), ['retained output']);

    timeline.innerHTML = rowHtml();
    assert.deepEqual(paneTexts(timeline), []);
    await macrotask(dom);
    assert.deepEqual(paneTexts(timeline), ['retained output']);

    tail.settle(identity);
    assert.deepEqual(paneTexts(timeline), []);
    timeline.innerHTML = rowHtml();
    await macrotask(dom);
    assert.deepEqual(paneTexts(timeline), []);
  });
}

test('a mutation elsewhere in the timeline does not repaint an existing pane', async (t) => {
  const { dom, timeline } = makeTimeline(minimalRowHtml('call-loop'));
  const tail = createToolLiveTail({ getChatTimeline: () => timeline });
  t.after(() => { tail.dispose(); dom.window.close(); });

  tail.appendChunk(chunk('call-loop', 'steady'));
  const pane = timeline.querySelector('[data-tool-live-output]');
  await macrotask(dom);

  const other = dom.window.document.createElement('div');
  other.className = 'chat-row';
  timeline.appendChild(other);
  await macrotask(dom);
  other.appendChild(dom.window.document.createElement('span'));
  await macrotask(dom);

  assert.equal(timeline.querySelectorAll('[data-tool-live-output]').length, 1);
  assert.equal(timeline.querySelector('[data-tool-live-output]'), pane, 'same pane node');
});

test('the same call id on two streams of one session targets only the live row', async (t) => {
  const { dom, timeline } = makeTimeline(
    classicRowHtml('call_0', 'completed') + classicRowHtml('call_0', 'running')
  );
  const tail = createToolLiveTail({ getChatTimeline: () => timeline });
  t.after(() => { tail.dispose(); dom.window.close(); });
  const blocks = timeline.querySelectorAll('.tool-call-block');

  assert.equal(tail.appendChunk(chunk('call_0', 'turn two', { streamId: 'b' })), true);
  assert.equal(blocks[0].querySelector('[data-tool-live-output]'), null);
  assert.equal(blocks[1].querySelectorAll('[data-tool-live-output]').length, 1);

  // Turn one's late result names its own stream: turn two's pane is not its to remove.
  tail.settle({ sessionId: 'session-1', streamId: 'a', callId: 'call_0' });
  assert.deepEqual(paneTexts(timeline), ['turn two']);
  tail.settle({ sessionId: 'session-1', streamId: 'b', callId: 'call_0' });
  assert.deepEqual(paneTexts(timeline), []);
});

test('a newer stream supersedes the older tail of the same session and call id', (t) => {
  const { dom, timeline } = makeTimeline(classicRowHtml('call_0'));
  const tail = createToolLiveTail({ getChatTimeline: () => timeline });
  t.after(() => { tail.dispose(); dom.window.close(); });

  tail.appendChunk(chunk('call_0', 'old turn', { streamId: 'a' }));
  tail.appendChunk(chunk('call_0', 'new turn', { streamId: 'b' }));

  assert.deepEqual(paneTexts(timeline), ['new turn']);
});

test('settleStream removes that stream only and disconnects when no tail remains', async (t) => {
  const { dom, timeline } = makeTimeline(classicRowHtml('call-x') + classicRowHtml('call-y'));
  const tail = createToolLiveTail({ getChatTimeline: () => timeline });
  t.after(() => { tail.dispose(); dom.window.close(); });

  tail.appendChunk(chunk('call-x', 'from a', { streamId: 'a' }));
  tail.appendChunk(chunk('call-y', 'from b', { sessionId: 'session-2', streamId: 'b' }));
  assert.equal(timeline.querySelectorAll('[data-tool-live-output]').length, 2);

  tail.settleStream('a');
  assert.deepEqual(paneTexts(timeline), ['from b']);

  tail.settleStream('b');
  assert.deepEqual(paneTexts(timeline), []);

  timeline.innerHTML = classicRowHtml('call-x') + classicRowHtml('call-y');
  await macrotask(dom);
  assert.deepEqual(paneTexts(timeline), []);
});

test('a hidden session is not painted until it is visible and the row remounts', async (t) => {
  const { dom, timeline } = makeTimeline(classicRowHtml('call-h'));
  let visible = false;
  const seen = [];
  const tail = createToolLiveTail({
    getChatTimeline: () => timeline,
    isSessionVisible: (sessionId) => { seen.push(sessionId); return visible; },
  });
  t.after(() => { tail.dispose(); dom.window.close(); });

  assert.equal(tail.appendChunk(chunk('call-h', 'quiet')), false);
  timeline.innerHTML = classicRowHtml('call-h');
  await macrotask(dom);
  assert.deepEqual(paneTexts(timeline), []);
  assert.ok(seen.includes('session-1'));

  visible = true;
  timeline.innerHTML = classicRowHtml('call-h');
  await macrotask(dom);
  assert.deepEqual(paneTexts(timeline), ['quiet']);
});

test('settle with a bare call id removes only that call', (t) => {
  const { dom, timeline } = makeTimeline(classicRowHtml('call-p') + classicRowHtml('call-q'));
  const tail = createToolLiveTail({ getChatTimeline: () => timeline });
  t.after(() => { tail.dispose(); dom.window.close(); });

  tail.appendChunk({ callId: 'call-p', lines: [{ text: 'p' }] });
  tail.appendChunk({ callId: 'call-q', lines: [{ text: 'q' }] });
  tail.settle('call-p');

  assert.deepEqual(paneTexts(timeline), ['q']);
});

const liveChunk = {
  type: 'tool_output_chunk', sessionId: 'session-1', streamId: 'a', callId: 'c', lines: [{ text: 'retained output' }],
};
const liveBlock = classicRowHtml('c');

async function withHandler(html, run) {
  const dom = new JSDOM(`<div id="timeline">${html}</div>`);
  dom.window.jennyShell = { sessions: { async getMessages() { return { data: [] }; } } };
  const timeline = dom.window.document.getElementById('timeline');
  const harness = createHarness({ stateOverrides: { window: dom.window }, domOverrides: { chatTimeline: timeline } });
  try {
    await run({ dom, timeline, harness });
  } finally {
    harness.handler.dispose();
    harness.restore();
    dom.window.close();
  }
}

test('handler disposal tears the tail down: no pane paints after dispose', async () => {
  await withHandler('', async ({ dom, timeline, harness }) => {
    await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'a' });
    await harness.emit(liveChunk);
    await flushMicrotasks(5);
    harness.handler.dispose();
    assert.doesNotThrow(() => harness.handler.dispose());
    timeline.innerHTML = liveBlock;
    await macrotask(dom);
    assert.equal(timeline.querySelector('[data-tool-live-output]'), null);
  });

  await withHandler(liveBlock, async ({ timeline, harness }) => {
    await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'a' });
    await harness.emit(liveChunk);
    await flushMicrotasks(5);
    assert.deepEqual(paneTexts(timeline), ['retained output']);
  });
});

test('a background session result with a colliding call id leaves the foreground pane; its own result removes it', async () => {
  await withHandler(liveBlock, async ({ timeline, harness }) => {
    await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'a' });
    await harness.emit(liveChunk);
    await flushMicrotasks(5);
    assert.deepEqual(paneTexts(timeline), ['retained output']);

    await harness.emit({ type: 'started', sessionId: 'session-2', streamId: 'b' });
    await harness.emit({
      type: 'tool_result', sessionId: 'session-2', streamId: 'b', callId: 'c',
      toolName: 'read_file', content: 'background result', isError: false,
    });
    await flushMicrotasks(5);
    assert.deepEqual(paneTexts(timeline), ['retained output']);

    await harness.emit({
      type: 'tool_result', sessionId: 'session-1', streamId: 'a', callId: 'c',
      toolName: 'run_command', content: 'done', isError: false,
    });
    await flushMicrotasks(5);
    assert.deepEqual(paneTexts(timeline), []);
  });
});

test('a stream that ends without a result drops its tail: a later mount is not painted', async () => {
  await withHandler('', async ({ dom, timeline, harness }) => {
    await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'a' });
    await harness.emit(liveChunk);
    await flushMicrotasks(5);
    await harness.emit({ type: 'complete', sessionId: 'session-1', streamId: 'a', content: 'done' });
    await flushMicrotasks(5);
    timeline.innerHTML = liveBlock;
    await macrotask(dom);
    assert.equal(timeline.querySelector('[data-tool-live-output]'), null);
  });
});

test('split view: only the pane-0 session paints; a focused session in another pane never writes into its rows', async (t) => {
  const previous = globalThis.rendererPaneVisibilityUtils;
  globalThis.rendererPaneVisibilityUtils = {
    isSessionVisibleInPane: (_state, sessionId, pane) => pane === 0 && sessionId === 'session-pane-0',
    isSessionVisibleInAnyPane: () => true,
  };
  t.after(() => { globalThis.rendererPaneVisibilityUtils = previous; });
  // The harness's current (focused) session is session-1; pane 0 shows session-pane-0.
  await withHandler(liveBlock, async ({ timeline, harness }) => {
    await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'a' });
    await harness.emit(liveChunk);
    await flushMicrotasks(5);
    assert.deepEqual(paneTexts(timeline), [], 'the focused pane-1 session does not paint into pane 0');

    await harness.emit({ type: 'started', sessionId: 'session-pane-0', streamId: 'p' });
    await harness.emit({ ...liveChunk, sessionId: 'session-pane-0', streamId: 'p', lines: [{ text: 'pane zero output' }] });
    await flushMicrotasks(5);
    assert.deepEqual(paneTexts(timeline), ['pane zero output']);
  });
});
