const assert = require('node:assert/strict');
const test = require('node:test');
const { JSDOM } = require('jsdom');

let patchUtils = null;
let patchUtilsLoadError = null;
try {
  patchUtils = require('../renderer/chat/renderer-stream-tool-patch-utils');
} catch (error) {
  patchUtilsLoadError = error;
}

function createFrameHarness() {
  const frames = [];
  return {
    requestAnimationFrame(callback) {
      frames.push(callback);
      return frames.length;
    },
    cancelAnimationFrame(handle) {
      if (handle > 0 && handle <= frames.length) {
        frames[handle - 1] = null;
      }
    },
    drain() {
      const pending = frames.splice(0).filter(Boolean);
      pending.forEach((callback) => callback(Date.now()));
      return pending.length;
    },
    count() {
      return frames.filter(Boolean).length;
    },
  };
}

function createPatchHarness(html, options = {}) {
  assert.ifError(patchUtilsLoadError);
  const dom = new JSDOM(html);
  const frameHarness = createFrameHarness();
  dom.window.requestAnimationFrame = frameHarness.requestAnimationFrame;
  dom.window.cancelAnimationFrame = frameHarness.cancelAnimationFrame;
  const logs = [];
  const fallbacks = [];
  const controller = patchUtils.createLiveToolPatchController({
    windowRef: dom.window,
    chatTimeline: dom.window.document.getElementById('chatTimeline'),
    timelineVirtualizer: options.timelineVirtualizer,
    shouldBlockLivePatch: options.shouldBlockLivePatch,
    appendClientLog(level, event, details) {
      logs.push({ level, event, details });
    },
    isVisibleChatSession(sessionId) {
      if (typeof options.isVisibleChatSession === 'function') {
        return options.isVisibleChatSession(sessionId);
      }
      return sessionId === 'session-1';
    },
    onFallback(sessionId, payload, details) {
      fallbacks.push({ sessionId, payload, details });
    },
  });
  return { dom, frameHarness, controller, logs, fallbacks };
}

test('live tool patch queue coalesces tool updates and preserves existing row nodes', () => {
  const { dom, frameHarness, controller, logs } = createPatchHarness(`
    <div id="chatTimeline">
      <article class="chat-entry assistant" data-message-id="assistant_1">
        <div class="chat-row" data-row-id="turn-1:tool_step:call-1" data-row-kind="tool_step" data-tool-call-id="call-1" data-row-state="running">
          <div class="tool-call-block" data-call-id="call-1" data-tool-status="running">
            <div class="tool-call-header" role="button" aria-expanded="true" data-call-id="call-1">
              <span class="tool-call-name">Read</span>
              <span class="tool-call-summary">Reading</span>
              <span class="tool-call-status tool-call-status-running">
                <span class="status-dot status-dot--pending" aria-hidden="true"></span>
                <span class="tool-call-status-label">Running</span>
              </span>
            </div>
            <div class="tool-call-details expanded" id="tool-details-call-1">
              <pre class="tool-call-output">old output</pre>
            </div>
          </div>
        </div>
        <div class="chat-bubble">Assistant text that should not be replaced.</div>
      </article>
    </div>
  `);
  const articleBefore = dom.window.document.querySelector('[data-message-id="assistant_1"]');
  const rowBefore = dom.window.document.querySelector('.chat-row[data-tool-call-id="call-1"]');

  assert.equal(controller.queueToolPatch({
    type: 'tool_use',
    sessionId: 'session-1',
    callId: 'call-1',
    toolName: 'Read',
    status: 'running',
    summary: 'Reading file',
  }, { eventType: 'tool_use' }), true);
  assert.equal(controller.queueToolPatch({
    type: 'tool_result',
    sessionId: 'session-1',
    callId: 'call-1',
    toolName: 'Read',
    content: 'README contents',
    summary: 'Read README',
    durationMs: 1200,
  }, { eventType: 'tool_result' }), true);
  assert.equal(frameHarness.count(), 1);
  assert.equal(frameHarness.drain(), 1);

  const articleAfter = dom.window.document.querySelector('[data-message-id="assistant_1"]');
  const rowAfter = dom.window.document.querySelector('.chat-row[data-tool-call-id="call-1"]');
  const block = dom.window.document.querySelector('.tool-call-block[data-call-id="call-1"]');
  const details = dom.window.document.querySelector('.tool-call-details');
  assert.equal(articleAfter, articleBefore);
  assert.equal(rowAfter, rowBefore);
  assert.equal(rowAfter.getAttribute('data-row-state'), 'completed');
  assert.equal(block.getAttribute('data-tool-status'), 'completed');
  assert.equal(block.querySelector('.tool-call-summary').textContent, 'Read README');
  assert.equal(block.querySelector('.tool-call-status-label').textContent, 'Success');
  // Quiet grammar: the patched settled-success word goes a11y-only, matching
  // what a fresh render would emit (the dot carries the signal).
  assert.equal(block.querySelector('.tool-call-status-label').classList.contains('sr-only'), true);
  assert.equal(block.querySelector('.tool-call-output').textContent, 'README contents');
  assert.equal(details.classList.contains('expanded'), true);
  assert.equal(details.hidden, false);
  assert.equal(logs.length, 0);
});

test('live tool patch writes result output into collapsed details without expanding', () => {
  const { dom, frameHarness, controller } = createPatchHarness(`
    <div id="chatTimeline">
      <article class="chat-entry assistant" data-message-id="assistant_1">
        <div class="chat-row" data-row-id="turn-1:tool_step:call-1" data-row-kind="tool_step" data-tool-call-id="call-1" data-row-state="running">
          <div class="tool-call-block" data-call-id="call-1" data-tool-status="running">
            <button class="tool-call-header" aria-expanded="false" data-call-id="call-1">
              <span class="tool-call-name">Read</span>
              <span class="tool-call-summary">Reading</span>
              <span class="tool-call-status tool-call-status-running">
                <span class="status-dot status-dot--pending" aria-hidden="true"></span>
                <span class="tool-call-status-label">Running</span>
              </span>
            </button>
            <div class="tool-call-details" id="tool-details-call-1" hidden></div>
          </div>
        </div>
      </article>
    </div>
  `);

  assert.equal(controller.queueToolPatch({
    type: 'tool_result',
    sessionId: 'session-1',
    callId: 'call-1',
    toolName: 'Read',
    content: 'README contents',
    summary: 'Read README',
  }, { eventType: 'tool_result' }), true);
  frameHarness.drain();

  const details = dom.window.document.querySelector('.tool-call-details');
  const output = details.querySelector('.tool-call-output');
  assert.equal(output.textContent, 'README contents');
  assert.equal(details.hidden, true);
  assert.equal(details.classList.contains('expanded'), false);
});

test('live tool patch rechecks visibility before flushing a queued DOM update', () => {
  let visibleSessionId = 'session-1';
  const { dom, frameHarness, controller, fallbacks } = createPatchHarness(`
    <div id="chatTimeline">
      <article class="chat-entry assistant" data-message-id="assistant_1">
        <div class="chat-row" data-tool-call-id="call-1" data-row-state="running">
          <div class="tool-call-block" data-call-id="call-1" data-tool-status="running">
            <span class="tool-call-status tool-call-status-running">
              <span class="tool-call-status-label">Running</span>
            </span>
          </div>
        </div>
      </article>
    </div>
  `, {
    isVisibleChatSession(sessionId) {
      return sessionId === visibleSessionId;
    },
  });

  assert.equal(controller.queueToolPatch({
    type: 'tool_result',
    sessionId: 'session-1',
    callId: 'call-1',
    content: 'README contents',
  }, { eventType: 'tool_result' }), true);
  visibleSessionId = 'session-2';
  frameHarness.drain();

  const row = dom.window.document.querySelector('.chat-row[data-tool-call-id="call-1"]');
  assert.equal(row.getAttribute('data-row-state'), 'running');
  assert.equal(row.querySelector('.tool-call-status-label').textContent, 'Running');
  assert.equal(fallbacks.length, 1);
  assert.equal(fallbacks[0].details.reason, 'inactive_session');
});

test('live tool patch handles malformed selector characters in call ids', () => {
  const { dom, frameHarness, controller } = createPatchHarness('<div id="chatTimeline"></div>');
  const timeline = dom.window.document.getElementById('chatTimeline');
  const row = dom.window.document.createElement('div');
  row.className = 'chat-row';
  row.setAttribute('data-row-state', 'running');
  row.setAttribute('data-tool-call-id', 'call\n1');
  const toolCallRow = dom.window.document.createElement('div');
  toolCallRow.className = 'tool-call-row';
  toolCallRow.setAttribute('data-tool-status', 'running');
  toolCallRow.setAttribute('data-tool-call-id', 'call\n1');
  const statusLabel = dom.window.document.createElement('span');
  statusLabel.className = 'tool-call-status-label';
  statusLabel.textContent = 'Running';
  toolCallRow.appendChild(statusLabel);
  row.appendChild(toolCallRow);
  timeline.appendChild(row);

  assert.equal(controller.queueToolPatch({
    type: 'tool_result',
    sessionId: 'session-1',
    callId: 'call\n1',
    content: 'done',
  }, { eventType: 'tool_result' }), true);
  frameHarness.drain();

  assert.equal(row.getAttribute('data-row-state'), 'completed');
  assert.equal(statusLabel.textContent, 'Success');
});

test('live tool patch targets the newest matching row when call ids repeat', () => {
  const { dom, frameHarness, controller } = createPatchHarness(`
    <div id="chatTimeline">
      <div class="chat-row" data-tool-call-id="call-1" data-row-state="completed">
        <div class="tool-call-block" data-call-id="call-1" data-tool-status="completed">
          <span class="tool-call-status tool-call-status-completed">
            <span class="tool-call-status-label">Success</span>
          </span>
        </div>
      </div>
      <div class="chat-row" data-tool-call-id="call-1" data-row-state="running">
        <div class="tool-call-block" data-call-id="call-1" data-tool-status="running">
          <span class="tool-call-status tool-call-status-running">
            <span class="tool-call-status-label">Running</span>
          </span>
        </div>
      </div>
    </div>
  `);

  assert.equal(controller.queueToolPatch({
    type: 'tool_result',
    sessionId: 'session-1',
    callId: 'call-1',
    content: 'done',
  }, { eventType: 'tool_result' }), true);
  frameHarness.drain();

  const rows = dom.window.document.querySelectorAll('.chat-row[data-tool-call-id="call-1"]');
  assert.equal(rows[0].querySelector('.tool-call-status-label').textContent, 'Success');
  assert.equal(rows[0].querySelector('.tool-call-output'), null);
  assert.equal(rows[1].getAttribute('data-row-state'), 'completed');
  assert.equal(rows[1].querySelector('.tool-call-output').textContent, 'done');
});

test('live tool patch keeps duplicate-id targets scoped to the newest row markup', () => {
  const { dom, frameHarness, controller } = createPatchHarness(`
    <div id="chatTimeline">
      <div class="chat-row" data-tool-call-id="call-1" data-row-state="completed">
        <div class="tool-call-block" data-call-id="call-1" data-tool-status="completed">
          <span class="tool-call-status tool-call-status-completed">
            <span class="tool-call-status-label">Success</span>
          </span>
        </div>
      </div>
      <div class="chat-row" data-tool-call-id="call-1" data-row-state="running">
        <div class="tool-call-row" data-tool-call-id="call-1" data-tool-status="running">
          <span class="tool-call-status-badge">Running</span>
        </div>
      </div>
    </div>
  `);

  assert.equal(controller.queueToolPatch({
    type: 'tool_result',
    sessionId: 'session-1',
    callId: 'call-1',
    content: 'done',
  }, { eventType: 'tool_result' }), true);
  frameHarness.drain();

  const rows = dom.window.document.querySelectorAll('.chat-row[data-tool-call-id="call-1"]');
  assert.equal(rows[0].getAttribute('data-row-state'), 'completed');
  assert.equal(rows[0].querySelector('.tool-call-output'), null);
  assert.equal(rows[1].getAttribute('data-row-state'), 'completed');
  assert.equal(rows[1].querySelector('.tool-call-status-badge').textContent, 'Success');
  assert.equal(rows[1].querySelector('.tool-call-status-badge').classList.contains('sr-only'), true);
  assert.equal(rows[1].querySelector('.tool-call-output').textContent, 'done');
});

test('live tool patch reports a bounded fallback when no visible target exists', () => {
  const { controller, logs } = createPatchHarness('<div id="chatTimeline"></div>');

  assert.equal(controller.queueToolPatch({
    type: 'tool_result',
    sessionId: 'session-1',
    callId: 'missing-call',
    toolName: 'Read',
    content: 'README contents',
    summary: 'Read README',
  }, { eventType: 'tool_result' }), false);

  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, 'DEBUG');
  assert.equal(logs[0].event, 'stream.live_tool_patch_fallback');
  assert.equal(logs[0].details.reason, 'missing_target');
});

test('live tool patch remounts a virtualized tool entry before falling back to full render', () => {
  let ensureCalls = 0;
  const { dom, frameHarness, controller, fallbacks } = createPatchHarness(`
    <div id="chatTimeline">
      <article class="chat-entry assistant" data-message-id="assistant_1" data-virtualized="true">
        <div class="chat-entry-virtualized" aria-hidden="true"></div>
      </article>
    </div>
  `, {
    timelineVirtualizer: {
      ensureMountedForToolCallId(callId) {
        ensureCalls += 1;
        assert.equal(callId, 'call-virtual');
        const article = dom.window.document.querySelector('[data-message-id="assistant_1"]');
        article.removeAttribute('data-virtualized');
        article.innerHTML = `
          <div class="chat-row" data-tool-call-id="call-virtual" data-row-state="running">
            <div class="tool-call-block" data-call-id="call-virtual" data-tool-status="running">
              <span class="tool-call-status-label">Running</span>
            </div>
          </div>
        `;
        return true;
      },
    },
  });

  assert.equal(controller.queueToolPatch({
    type: 'tool_result',
    sessionId: 'session-1',
    callId: 'call-virtual',
    content: 'done',
  }, { eventType: 'tool_result' }), true);
  frameHarness.drain();

  const row = dom.window.document.querySelector('.chat-row[data-tool-call-id="call-virtual"]');
  assert.equal(ensureCalls, 1);
  assert.equal(row.getAttribute('data-row-state'), 'completed');
  assert.equal(row.querySelector('.tool-call-output').textContent, 'done');
  assert.equal(fallbacks.length, 0);
});

test('live tool patch rejects malformed tool targets with a bounded diagnostic', () => {
  const { controller, logs } = createPatchHarness('<div id="chatTimeline"></div>');

  assert.equal(controller.queueToolPatch({
    type: 'tool_result',
    sessionId: 'session-1',
    callId: '',
    toolName: 'Read',
    content: 'README contents',
  }, { eventType: 'tool_result' }), false);

  assert.equal(logs.length, 1);
  assert.equal(logs[0].event, 'stream.live_tool_patch_fallback');
  assert.equal(logs[0].details.reason, 'missing_call_id');
});

test('live tool patch refuses direct patches while structural transactions are active', () => {
  const { controller, frameHarness, logs } = createPatchHarness(`
    <div id="chatTimeline">
      <div class="chat-row" data-tool-call-id="call-1" data-row-state="running">
        <div class="tool-call-block" data-call-id="call-1" data-tool-status="running">
          <span class="tool-call-status-label">Running</span>
        </div>
      </div>
    </div>
  `, {
    shouldBlockLivePatch: () => true,
  });

  assert.equal(controller.queueToolPatch({
    type: 'tool_result',
    sessionId: 'session-1',
    callId: 'call-1',
    content: 'done',
  }, { eventType: 'tool_result' }), false);

  assert.equal(frameHarness.count(), 0);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].event, 'stream.live_tool_patch_fallback');
  assert.equal(logs[0].details.reason, 'direct_patch_blocked');
});

test('live tool patch rechecks structural transaction gate before frame flush', () => {
  let blocked = false;
  const { dom, controller, frameHarness, fallbacks } = createPatchHarness(`
    <div id="chatTimeline">
      <div class="chat-row" data-tool-call-id="call-1" data-row-state="running">
        <div class="tool-call-block" data-call-id="call-1" data-tool-status="running">
          <span class="tool-call-status-label">Running</span>
        </div>
      </div>
    </div>
  `, {
    shouldBlockLivePatch: () => blocked,
  });

  assert.equal(controller.queueToolPatch({
    type: 'tool_result',
    sessionId: 'session-1',
    callId: 'call-1',
    content: 'done',
  }, { eventType: 'tool_result' }), true);

  blocked = true;
  frameHarness.drain();

  const row = dom.window.document.querySelector('.chat-row[data-tool-call-id="call-1"]');
  assert.equal(row.getAttribute('data-row-state'), 'running');
  assert.equal(row.querySelector('.tool-call-status-label').textContent, 'Running');
  assert.equal(fallbacks.length, 1);
  assert.equal(fallbacks[0].details.reason, 'direct_patch_blocked');
});

test('settling patch detaches the live elapsed node from the transcript clock scan', () => {
  const { dom, frameHarness, controller } = createPatchHarness(`
    <div id="chatTimeline">
      <article class="chat-entry assistant" data-message-id="assistant_1">
        <div class="chat-row" data-row-id="turn-1:tool_step:call-el" data-row-kind="tool_step" data-tool-call-id="call-el" data-row-state="running">
          <div class="tool-call-row tool-call-row--minimal" data-tool-call-id="call-el" data-tool-status="running">
            <span class="tool-call-status-badge">Running</span>
            <span class="tool-result-duration" data-turn-elapsed="true" data-elapsed-started-at="1000" data-elapsed-running="true">0:07</span>
          </div>
        </div>
      </article>
    </div>
  `);

  assert.equal(controller.queueToolPatch({
    type: 'tool_result',
    sessionId: 'session-1',
    callId: 'call-el',
    toolName: 'run_command',
    content: 'done',
    durationMs: 7200,
  }, { eventType: 'tool_result' }), true);
  frameHarness.drain();

  const durationNode = dom.window.document.querySelector('.tool-result-duration');
  assert.equal(durationNode.hasAttribute('data-turn-elapsed'), false);
  assert.equal(durationNode.hasAttribute('data-elapsed-started-at'), false);
  assert.equal(durationNode.getAttribute('data-elapsed-running'), 'false');
  // The settled duration replaces the last live tick and can no longer be
  // overwritten (the clock scan no longer matches the node).
  assert.equal(durationNode.textContent, '7.2s');
});

test('running patch keeps the live elapsed node attached', () => {
  const { dom, frameHarness, controller } = createPatchHarness(`
    <div id="chatTimeline">
      <article class="chat-entry assistant" data-message-id="assistant_1">
        <div class="chat-row" data-row-id="turn-1:tool_step:call-el2" data-row-kind="tool_step" data-tool-call-id="call-el2" data-row-state="requested">
          <div class="tool-call-row tool-call-row--minimal" data-tool-call-id="call-el2" data-tool-status="requested">
            <span class="tool-call-status-badge">Requested</span>
            <span class="tool-result-duration" data-turn-elapsed="true" data-elapsed-started-at="1000" data-elapsed-running="true">0:02</span>
          </div>
        </div>
      </article>
    </div>
  `);

  assert.equal(controller.queueToolPatch({
    type: 'tool_use',
    sessionId: 'session-1',
    callId: 'call-el2',
    toolName: 'run_command',
    status: 'running',
  }, { eventType: 'tool_use' }), true);
  frameHarness.drain();

  const durationNode = dom.window.document.querySelector('.tool-result-duration');
  assert.equal(durationNode.getAttribute('data-turn-elapsed'), 'true');
  assert.equal(durationNode.getAttribute('data-elapsed-started-at'), '1000');
  assert.equal(durationNode.getAttribute('data-elapsed-running'), 'true');
});

test('live file-operation patches mirror fresh-render composing and settled classes', () => {
  const { dom, frameHarness, controller } = createPatchHarness(`
    <div id="chatTimeline">
      <div class="chat-row" data-tool-call-id="call-file" data-row-state="running">
        <div class="tool-call-block tool-call-file-operation tool-call-file-composing"
          data-call-id="call-file" data-tool-status="running">
          <span class="tool-call-status tool-call-status-running">
            <span class="tool-call-status-label">Running</span>
          </span>
        </div>
      </div>
    </div>
  `);
  const block = dom.window.document.querySelector('.tool-call-file-operation');
  const patchStatus = (status, eventType = 'tool_use') => {
    assert.equal(controller.queueToolPatch({
      type: eventType,
      sessionId: 'session-1',
      callId: 'call-file',
      toolName: 'edit_file',
      status,
    }, { eventType }), true);
    frameHarness.drain();
  };

  patchStatus('pending_approval');
  assert.equal(block.classList.contains('tool-call-file-composing'), false);
  assert.equal(block.classList.contains('tool-call-file-settled'), false);

  patchStatus('executing');
  assert.equal(block.classList.contains('tool-call-file-composing'), true);
  assert.equal(block.classList.contains('tool-call-file-settled'), false);

  for (const [status, eventType] of [
    ['completed', 'tool_result'], ['errored'], ['denied'], ['timed_out'], ['cancelled'],
    ['interrupted'],
  ]) {
    patchStatus(status, eventType);
    assert.equal(block.classList.contains('tool-call-file-composing'), false, status);
    assert.equal(block.classList.contains('tool-call-file-settled'), true, status);
  }
});
