/* The live tool-row patch lane and a fresh full render must agree on a result's
   classification, and a minimal row (the production family) must ask for the
   authoritative render because a field-level patch cannot build its result
   presentation. Rows here are production markup from buildToolCallRowMarkup. */
const assert = require('node:assert/strict');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const patchUtils = require('../renderer/chat/renderer-stream-tool-patch-utils');
const toolRowUtils = require('../renderer/chat/renderer-turn-row-tool-render-utils');
const { createHarness: createStreamHarness, flushMicrotasks } = require('./helpers/renderer-stream-handler-harness');

const SESSION_ID = 'session-1';
const CALL_ID = 'call-parity-1';
const TURN_ID = 'turn-parity';
const ROW_ID = 'row-parity';
const UNIQUE_OUTPUT = 'unique-result-output-7f3a9c';

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function createRenderer() {
  return toolRowUtils.createTurnRowToolRenderUtils({
    escapeHtml,
    normalizeId: (value) => String(value || '').trim(),
  });
}

function callRow() {
  return {
    turn_id: TURN_ID,
    row_id: ROW_ID,
    payload: {
      tool_call_id: CALL_ID,
      tool_name: 'read_file',
      state: 'running',
      input: { path: 'README.md' },
    },
  };
}

function rowKey() {
  return `session=${SESSION_ID}|turn=${TURN_ID}|row=${ROW_ID}|call=${CALL_ID}`;
}

function renderRow(renderer, transcriptView, resultPayload) {
  const options = { sessionId: SESSION_ID, transcriptView };
  if (resultPayload) {
    options.pairedToolResultRow = {
      payload: { tool_call_id: CALL_ID, tool_name: 'read_file', ...resultPayload },
    };
  }
  return renderer.buildToolCallRowMarkup(callRow(), [], options);
}

function timelineHtml(rowMarkup) {
  return `<div id="chatTimeline"><div class="chat-row" data-row-id="${TURN_ID}:tool_step:${CALL_ID}" data-row-kind="tool_step" data-tool-call-id="${CALL_ID}" data-row-state="running">${rowMarkup}</div></div>`;
}

function createFrameHarness() {
  const frames = [];
  return {
    requestAnimationFrame(callback) {
      frames.push(callback);
      return frames.length;
    },
    cancelAnimationFrame(handle) {
      if (handle > 0 && handle <= frames.length) frames[handle - 1] = null;
    },
    drain() {
      const pending = frames.splice(0).filter(Boolean);
      pending.forEach((callback) => callback(Date.now()));
      return pending.length;
    },
  };
}

function createPatchHarness(html) {
  const dom = new JSDOM(html);
  const frameHarness = createFrameHarness();
  dom.window.requestAnimationFrame = frameHarness.requestAnimationFrame;
  dom.window.cancelAnimationFrame = frameHarness.cancelAnimationFrame;
  const fallbacks = [];
  const patched = [];
  const controller = patchUtils.createLiveToolPatchController({
    windowRef: dom.window,
    chatTimeline: dom.window.document.getElementById('chatTimeline'),
    isVisibleChatSession: (sessionId) => sessionId === SESSION_ID,
    appendClientLog() {},
    onFallback(sessionId, payload, details) {
      fallbacks.push({ sessionId, payload, details });
    },
    onPatched(sessionId, payload, details) {
      patched.push({ sessionId, payload, details });
    },
  });
  return { dom, frameHarness, controller, fallbacks, patched };
}

function readRowAttributes(markup) {
  const dom = new JSDOM(`<body>${markup}</body>`);
  const row = dom.window.document.querySelector('.tool-call-row');
  return {
    status: row.getAttribute('data-tool-status'),
    isError: row.getAttribute('data-is-error'),
  };
}

// `canonical` is the projected result row payload the reducer builds for the
// same wire result: the verdict rides in `state`, never in approval_state.
const RESULT_CASES = [
  {
    name: 'success',
    wire: {},
    canonical: { state: 'completed' },
    expected: 'completed',
  },
  {
    name: 'denied',
    wire: { approvalState: 'denied' },
    canonical: { state: 'denied' },
    expected: 'denied',
  },
  {
    name: 'cancelled',
    wire: { approvalState: 'cancelled', isError: true },
    canonical: { state: 'cancelled', is_error: true },
    expected: 'cancelled',
  },
  {
    name: 'timed out',
    wire: { approvalState: 'timed_out', isError: true },
    canonical: { state: 'timed_out', is_error: true },
    expected: 'timed_out',
  },
  {
    name: 'blocked by the command guard',
    wire: { isError: true, errorCode: 'CMP-TOOL-0007' },
    canonical: { state: 'errored', is_error: true, error_code: 'CMP-TOOL-0007' },
    expected: 'blocked',
  },
  {
    name: 'genuine failure',
    wire: { isError: true },
    canonical: { state: 'errored', is_error: true },
    expected: 'errored',
  },
];

for (const resultCase of RESULT_CASES) {
  test(`live patch status matches a fresh render: ${resultCase.name}`, () => {
    toolRowUtils.clearToolRowExpansionOverrides();
    const renderer = createRenderer();
    const { dom, frameHarness, controller } = createPatchHarness(timelineHtml(renderRow(renderer, 'answers')));

    assert.equal(controller.queueToolPatch({
      type: 'tool_result',
      sessionId: SESSION_ID,
      callId: CALL_ID,
      toolName: 'read_file',
      content: UNIQUE_OUTPUT,
      // The merged payload may carry the call's own status; it must not win.
      status: 'running',
      ...resultCase.wire,
    }, { eventType: 'tool_result' }), true);
    frameHarness.drain();

    const patchedRow = dom.window.document.querySelector('.tool-call-row');
    const fresh = readRowAttributes(renderRow(renderer, 'answers', {
      output_text: UNIQUE_OUTPUT,
      is_error: false,
      ...resultCase.canonical,
    }));
    assert.equal(fresh.status, resultCase.expected, 'the canonical render defines the expectation');
    assert.equal(patchedRow.getAttribute('data-tool-status'), fresh.status);
    assert.equal(patchedRow.getAttribute('data-is-error'), fresh.isError);
    assert.equal(dom.window.document.querySelector('.chat-row').getAttribute('data-row-state'), fresh.status);
    dom.window.close();
  });
}

for (const transcriptView of ['answers', 'thinking', 'everything']) {
  test(`${transcriptView}: a result on a minimal row patches status and asks for the authoritative render`, () => {
    toolRowUtils.clearToolRowExpansionOverrides();
    const renderer = createRenderer();
    const { dom, frameHarness, controller, fallbacks, patched } = createPatchHarness(
      timelineHtml(renderRow(renderer, transcriptView)),
    );

    controller.queueToolPatch({
      type: 'tool_result',
      sessionId: SESSION_ID,
      callId: CALL_ID,
      toolName: 'read_file',
      content: UNIQUE_OUTPUT,
      isError: false,
    }, { eventType: 'tool_result' });
    frameHarness.drain();

    const patchedRow = dom.window.document.querySelector('.tool-call-row');
    assert.equal(patchedRow.getAttribute('data-tool-status'), 'completed');
    assert.equal(patchedRow.getAttribute('data-is-error'), 'false');
    assert.equal(patched.length, 1);
    assert.equal(fallbacks.length, 1);
    assert.equal(fallbacks[0].details.reason, 'result_needs_render');
    assert.equal(fallbacks[0].details.eventType, 'tool_result');
    assert.equal(fallbacks[0].sessionId, SESSION_ID);

    // The render the fallback queues carries the presentation the patch cannot.
    const repaired = renderRow(renderer, transcriptView, { output_text: UNIQUE_OUTPUT, is_error: false });
    if (transcriptView === 'everything') {
      assert.ok(repaired.includes(UNIQUE_OUTPUT), 'everything renders expanded details directly');
    } else {
      assert.equal(repaired.includes(UNIQUE_OUTPUT), false, 'collapsed rows defer their details');
      const materialized = toolRowUtils.materializeToolRowDetails(rowKey());
      assert.equal(materialized.ok, true);
      assert.ok(materialized.markup.includes(UNIQUE_OUTPUT));
    }
    dom.window.close();
  });
}

test('a failed result stamps data-is-error on the minimal row before the run summary reads it', () => {
  toolRowUtils.clearToolRowExpansionOverrides();
  const renderer = createRenderer();
  const { dom, frameHarness, controller } = createPatchHarness(timelineHtml(renderRow(renderer, 'answers')));

  controller.queueToolPatch({
    type: 'tool_result',
    sessionId: SESSION_ID,
    callId: CALL_ID,
    toolName: 'read_file',
    is_error: true,
    content: 'boom',
  }, { eventType: 'tool_result' });
  frameHarness.drain();

  const patchedRow = dom.window.document.querySelector('.tool-call-row');
  assert.equal(patchedRow.getAttribute('data-tool-status'), 'errored');
  assert.equal(patchedRow.getAttribute('data-is-error'), 'true');
  dom.window.close();
});

test('control: a non-result event on a minimal row does not request a render', () => {
  toolRowUtils.clearToolRowExpansionOverrides();
  const renderer = createRenderer();
  const { dom, frameHarness, controller, fallbacks, patched } = createPatchHarness(
    timelineHtml(renderRow(renderer, 'answers')),
  );

  controller.queueToolPatch({
    type: 'tool_use',
    sessionId: SESSION_ID,
    callId: CALL_ID,
    toolName: 'read_file',
    status: 'running',
  }, { eventType: 'tool_use' });
  frameHarness.drain();

  assert.equal(patched.length, 1);
  assert.equal(fallbacks.length, 0);
  dom.window.close();
});

test('control: a classic tool-call-block target is patched in place without a render request', () => {
  const { dom, frameHarness, controller, fallbacks, patched } = createPatchHarness(`
    <div id="chatTimeline">
      <div class="chat-row" data-tool-call-id="${CALL_ID}" data-row-state="running">
        <div class="tool-call-block" data-call-id="${CALL_ID}" data-tool-status="running">
          <div class="tool-call-header" role="button" data-call-id="${CALL_ID}">
            <span class="tool-call-name">Read</span>
            <span class="tool-call-status tool-call-status-running">
              <span class="status-dot status-dot--pending" aria-hidden="true"></span>
              <span class="tool-call-status-label">Running</span>
            </span>
          </div>
          <div class="tool-call-details expanded"><pre class="tool-call-output">old output</pre></div>
        </div>
      </div>
    </div>
  `);

  controller.queueToolPatch({
    type: 'tool_result',
    sessionId: SESSION_ID,
    callId: CALL_ID,
    toolName: 'Read',
    content: UNIQUE_OUTPUT,
  }, { eventType: 'tool_result' });
  frameHarness.drain();

  const block = dom.window.document.querySelector('.tool-call-block');
  assert.equal(block.getAttribute('data-tool-status'), 'completed');
  assert.equal(block.querySelector('.tool-call-output').textContent, UNIQUE_OUTPUT);
  assert.equal(patched.length, 1);
  assert.equal(fallbacks.length, 0);
  dom.window.close();
});

test('real createStreamHandler wiring: a result on a production minimal row queues the messages render', async (t) => {
  toolRowUtils.clearToolRowExpansionOverrides();
  const renderer = createRenderer();
  const dom = new JSDOM(timelineHtml(renderRow(renderer, 'answers')));
  dom.window.requestAnimationFrame = (callback) => { callback(Date.now()); return 1; };
  dom.window.cancelAnimationFrame = () => {};
  dom.window.jennyShell = { sessions: { async getMessages() { return { data: [] }; } } };
  const chatTimeline = dom.window.document.getElementById('chatTimeline');

  const harness = createStreamHarness({
    domOverrides: { chatTimeline },
    stateOverrides: { window: dom.window },
  });
  t.after(() => {
    harness.restore();
    dom.window.close();
  });

  await harness.emit({ type: 'started', sessionId: SESSION_ID, streamId: 'stream-parity' });
  await harness.emit({
    type: 'tool_use',
    sessionId: SESSION_ID,
    streamId: 'stream-parity',
    callId: CALL_ID,
    toolName: 'read_file',
    status: 'running',
  });
  await flushMicrotasks(5);
  const renderMessagesBefore = harness.calls.renderMessages;
  await harness.emit({
    type: 'tool_result',
    sessionId: SESSION_ID,
    streamId: 'stream-parity',
    callId: CALL_ID,
    toolName: 'read_file',
    content: UNIQUE_OUTPUT,
    isError: false,
  });
  await flushMicrotasks(5);

  const row = chatTimeline.querySelector('.tool-call-row');
  assert.equal(row.getAttribute('data-tool-status'), 'completed', 'the status flips first');
  assert.ok(harness.calls.renderMessages - renderMessagesBefore >= 1, 'the authoritative render follows');
});
