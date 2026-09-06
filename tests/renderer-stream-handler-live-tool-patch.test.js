// Live tool-patch wiring regression (UIUX-029 discovery, 2026-07-12).
//
// The in-place tool-row patch path (renderer-stream-tool-patch-utils
// queueToolPatch) was fully covered at the createLiveToolPatchController unit
// level but dead in the packaged app: the shell controller's createStreamHandler
// call never threaded dom.chatTimeline, so every tool event hit the
// missing_timeline fallback and forced a full session re-render.
//
// These tests drive the REAL createStreamHandler (tests/helpers/
// renderer-stream-handler-harness.js) end-to-end over a mounted tool row:
//  - with chatTimeline wired, a tool event must patch the existing DOM nodes in
//    place and must NOT queue a messages re-render;
//  - without chatTimeline (the old broken wiring), the same event must fall
//    back to a messages re-render and leave the DOM untouched — proving the
//    first test's assertions actually discriminate the two branches.
//
// The controller-side half of the pin (chat shell forwards dom.chatTimeline +
// timelineVirtualizer into createStreamHandler) lives in
// tests/renderer-chat-shell-controller.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createHarness, flushMicrotasks } = require('./helpers/renderer-stream-handler-harness');

const TOOL_ROW_HTML = `<!doctype html><body>
  <div class="sr-only" id="srAnnouncePolite" role="status" aria-live="polite" aria-atomic="true"></div>
  <div class="sr-only" id="srAnnounceAssertive" role="alert" aria-live="assertive" aria-atomic="true"></div>
  <div id="chatTimeline">
    <article class="chat-entry assistant" data-message-id="assistant_1">
      <div class="chat-row" data-row-id="turn-1:tool_step:call-live-1" data-row-kind="tool_step" data-tool-call-id="call-live-1" data-row-state="running">
        <div class="tool-call-block" data-call-id="call-live-1" data-tool-status="running">
          <div class="tool-call-header" role="button" aria-expanded="true" data-call-id="call-live-1">
            <span class="tool-call-name">Read</span>
            <span class="tool-call-summary">Reading</span>
            <span class="tool-call-status tool-call-status-running">
              <span class="status-dot status-dot--pending" aria-hidden="true"></span>
              <span class="tool-call-status-label">Running</span>
            </span>
          </div>
          <div class="tool-call-details expanded" id="tool-details-call-live-1">
            <pre class="tool-call-output">old output</pre>
          </div>
        </div>
      </div>
    </article>
  </div>
</body>`;

function createTimelineWindow() {
  const dom = new JSDOM(TOOL_ROW_HTML);
  // createLiveToolPatchController schedules its flush off windowRef
  // (globalThis.window), not the global rAF the harness stubs — make it
  // synchronous so patches land before the emit() await returns.
  dom.window.requestAnimationFrame = (callback) => { callback(Date.now()); return 1; };
  dom.window.cancelAnimationFrame = () => {};
  dom.window.jennyShell = {
    sessions: {
      async getMessages() { return { data: [] }; },
    },
  };
  return dom;
}

async function emitToolLifecycle(harness, streamId) {
  await harness.emit({ type: 'started', sessionId: 'session-1', streamId });
  await harness.emit({
    type: 'tool_use',
    sessionId: 'session-1',
    streamId,
    callId: 'call-live-1',
    toolName: 'Read',
    summary: 'Reading file',
    status: 'running',
  });
  await flushMicrotasks(5);
  const renderMessagesBefore = harness.calls.renderMessages;
  await harness.emit({
    type: 'tool_result',
    sessionId: 'session-1',
    streamId,
    callId: 'call-live-1',
    toolName: 'Read',
    summary: 'Read README',
    content: 'README contents',
    isError: false,
    durationMs: 1200,
  });
  await flushMicrotasks(5);
  return harness.calls.renderMessages - renderMessagesBefore;
}

test('real createStreamHandler wiring: tool events reach the live in-place patch branch, not the full-render fallback', async (t) => {
  const dom = createTimelineWindow();
  const chatTimeline = dom.window.document.getElementById('chatTimeline');
  const rowBefore = chatTimeline.querySelector('.chat-row[data-tool-call-id="call-live-1"]');
  const blockBefore = chatTimeline.querySelector('.tool-call-block[data-call-id="call-live-1"]');

  const harness = createHarness({
    domOverrides: { chatTimeline },
    stateOverrides: { window: dom.window },
  });
  t.after(() => harness.restore());

  const renderMessagesDelta = await emitToolLifecycle(harness, 'stream-live-patch');

  // Live branch taken: the pre-existing nodes were patched in place…
  const rowAfter = chatTimeline.querySelector('.chat-row[data-tool-call-id="call-live-1"]');
  const blockAfter = chatTimeline.querySelector('.tool-call-block[data-call-id="call-live-1"]');
  assert.equal(rowAfter, rowBefore);
  assert.equal(blockAfter, blockBefore);
  assert.equal(rowAfter.getAttribute('data-row-state'), 'completed');
  assert.equal(blockAfter.getAttribute('data-tool-status'), 'completed');
  assert.equal(blockAfter.querySelector('.tool-call-summary').textContent, 'Read README');
  // …and the tool_result did not queue a full messages re-render.
  assert.equal(renderMessagesDelta, 0);
});

test('real createStreamHandler wiring: a terminal tool status announces through the shared live-announcer regions', async (t) => {
  const dom = createTimelineWindow();
  const chatTimeline = dom.window.document.getElementById('chatTimeline');
  const politeRegion = dom.window.document.getElementById('srAnnouncePolite');

  const harness = createHarness({
    domOverrides: { chatTimeline },
    stateOverrides: { window: dom.window },
  });
  t.after(() => harness.restore());

  await emitToolLifecycle(harness, 'stream-announce');
  // The shared announcer throttles (150ms) before flushing into the region.
  await new Promise((resolve) => setTimeout(resolve, 250));

  assert.equal(politeRegion.textContent, 'Read finished');
});

test('control: without chatTimeline the same tool events take the full-render fallback and never touch the DOM', async (t) => {
  const dom = createTimelineWindow();
  const chatTimeline = dom.window.document.getElementById('chatTimeline');
  const block = chatTimeline.querySelector('.tool-call-block[data-call-id="call-live-1"]');

  // No chatTimeline in dom deps — the exact shape of the pre-fix wiring.
  const harness = createHarness({
    stateOverrides: { window: dom.window },
  });
  t.after(() => harness.restore());

  const renderMessagesDelta = await emitToolLifecycle(harness, 'stream-fallback');

  assert.ok(renderMessagesDelta >= 1, 'fallback must queue a messages re-render');
  assert.equal(block.getAttribute('data-tool-status'), 'running');
  assert.equal(block.querySelector('.tool-call-summary').textContent, 'Reading');
});
