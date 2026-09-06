/* UIUX-029 (W2-C slice): "tool activity" is currently visual-only -- a tool call transitioning to
   completed/errored/denied/timed_out in the live chat timeline patches the DOM status badge text
   directly (renderer-stream-tool-patch-utils.js patchStatus) but never touches any aria-live region,
   so a screen-reader user gets no announcement at all when a background tool finishes or fails.
   This suite drives createLiveToolPatchController with a fake announcer and asserts:
     - genuinely NEW terminal states (completed/errored/denied/timed_out) get exactly one announcement
     - completed is polite ("routine confirmation"); errored/denied/timed_out are assertive (per the
       UIUX-029 fix contract: "errors assertive, routine confirmations polite")
     - non-terminal transitions (running, awaiting_approval -- the latter already has its own
       role="status" region via renderApprovalBlock, see renderer/chat/renderer-approval-block.js)
       do NOT announce, so we don't create a second, nested announcement for the same event
     - a status that is re-patched without actually changing does NOT re-announce (no spam) */
const assert = require('node:assert/strict');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const patchUtils = require('../renderer/chat/renderer-stream-tool-patch-utils');

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
  };
}

function createFakeAnnouncer() {
  const calls = [];
  return {
    calls,
    announce(message, opts) {
      calls.push({ message, ...opts });
      return true;
    },
  };
}

function rowFixture(callId, status) {
  return `
    <div id="chatTimeline">
      <article class="chat-entry assistant" data-message-id="assistant_1">
        <div class="chat-row" data-row-id="turn-1:tool_step:${callId}" data-row-kind="tool_step" data-tool-call-id="${callId}" data-row-state="${status}">
          <div class="tool-call-block" data-call-id="${callId}" data-tool-status="${status}">
            <div class="tool-call-header" role="button" aria-expanded="true" data-call-id="${callId}">
              <span class="tool-call-name">Read</span>
              <span class="tool-call-summary">Reading</span>
              <span class="tool-call-status tool-call-status-${status}">
                <span class="status-dot status-dot--pending" aria-hidden="true"></span>
                <span class="tool-call-status-label">Running</span>
              </span>
            </div>
            <div class="tool-call-details expanded" id="tool-details-${callId}">
              <pre class="tool-call-output">old output</pre>
            </div>
          </div>
        </div>
      </article>
    </div>
  `;
}

function createHarness(html, announcer) {
  const dom = new JSDOM(html);
  const frameHarness = createFrameHarness();
  dom.window.requestAnimationFrame = frameHarness.requestAnimationFrame;
  dom.window.cancelAnimationFrame = frameHarness.cancelAnimationFrame;
  const controller = patchUtils.createLiveToolPatchController({
    windowRef: dom.window,
    chatTimeline: dom.window.document.getElementById('chatTimeline'),
    announcer,
    isVisibleChatSession: () => true,
    appendClientLog() {},
    onFallback() {},
  });
  return { dom, frameHarness, controller };
}

test('tool activity: running -> completed announces exactly once, politely', () => {
  const announcer = createFakeAnnouncer();
  const { controller, frameHarness } = createHarness(rowFixture('call-1', 'running'), announcer);

  controller.queueToolPatch({
    type: 'tool_result', sessionId: 'session-1', callId: 'call-1', toolName: 'Read', content: 'ok', summary: 'Read README',
  }, { eventType: 'tool_result' });
  frameHarness.drain();

  assert.equal(announcer.calls.length, 1);
  assert.equal(announcer.calls[0].politeness, 'polite');
  assert.match(announcer.calls[0].message, /Read/);
});

test('tool activity: running -> errored announces exactly once, assertively', () => {
  const announcer = createFakeAnnouncer();
  const { controller, frameHarness } = createHarness(rowFixture('call-2', 'running'), announcer);

  controller.queueToolPatch({
    type: 'tool_result', sessionId: 'session-1', callId: 'call-2', toolName: 'Bash', isError: true, content: 'boom',
  }, { eventType: 'tool_result' });
  frameHarness.drain();

  assert.equal(announcer.calls.length, 1);
  assert.equal(announcer.calls[0].politeness, 'assertive');
  assert.match(announcer.calls[0].message, /Bash/);
});

test('tool activity: running -> denied announces assertively', () => {
  const announcer = createFakeAnnouncer();
  const { controller, frameHarness } = createHarness(rowFixture('call-3', 'running'), announcer);

  controller.queueToolPatch({
    type: 'tool_result', sessionId: 'session-1', callId: 'call-3', toolName: 'Write', approvalState: 'denied',
  }, { eventType: 'tool_result' });
  frameHarness.drain();

  assert.equal(announcer.calls.length, 1);
  assert.equal(announcer.calls[0].politeness, 'assertive');
});

test('tool activity: running -> timed_out announces assertively', () => {
  const announcer = createFakeAnnouncer();
  const { controller, frameHarness } = createHarness(rowFixture('call-4', 'running'), announcer);

  controller.queueToolPatch({
    type: 'tool_use', sessionId: 'session-1', callId: 'call-4', toolName: 'WebSearch', status: 'timeout',
  }, { eventType: 'tool_use' });
  frameHarness.drain();

  assert.equal(announcer.calls.length, 1);
  assert.equal(announcer.calls[0].politeness, 'assertive');
});

test('tool activity: awaiting_approval does NOT announce here (already covered by the approval block\'s own live region)', () => {
  const announcer = createFakeAnnouncer();
  const { controller, frameHarness } = createHarness(rowFixture('call-5', 'running'), announcer);

  controller.queueToolPatch({
    type: 'tool_approval_needed', sessionId: 'session-1', callId: 'call-5', toolName: 'Bash',
  }, { eventType: 'tool_approval_needed' });
  frameHarness.drain();

  assert.equal(announcer.calls.length, 0);
});

test('tool activity: a redundant patch to the SAME terminal status does not re-announce', () => {
  const announcer = createFakeAnnouncer();
  const { dom, controller, frameHarness } = createHarness(rowFixture('call-6', 'running'), announcer);

  controller.queueToolPatch({
    type: 'tool_result', sessionId: 'session-1', callId: 'call-6', toolName: 'Read', content: 'ok',
  }, { eventType: 'tool_result' });
  frameHarness.drain();
  assert.equal(announcer.calls.length, 1);

  // A second, later frame re-delivers a duplicate "completed" event for the same call (e.g. a
  // replayed stream envelope). The DOM already reads data-tool-status="completed", so this must
  // be recognized as "no real change" and skipped.
  const block = dom.window.document.querySelector('.tool-call-block[data-call-id="call-6"]');
  assert.equal(block.getAttribute('data-tool-status'), 'completed');
  controller.queueToolPatch({
    type: 'tool_result', sessionId: 'session-1', callId: 'call-6', toolName: 'Read', content: 'ok',
  }, { eventType: 'tool_result' });
  frameHarness.drain();

  assert.equal(announcer.calls.length, 1, 'redundant same-status patch must not announce again');
});

test('tool activity: works without an announcer option (backward compatible, no throw)', () => {
  const { controller, frameHarness, dom } = createHarness(rowFixture('call-7', 'running'), undefined);
  controller.queueToolPatch({
    type: 'tool_result', sessionId: 'session-1', callId: 'call-7', toolName: 'Read', content: 'ok',
  }, { eventType: 'tool_result' });
  frameHarness.drain();
  const block = dom.window.document.querySelector('.tool-call-block[data-call-id="call-7"]');
  assert.equal(block.getAttribute('data-tool-status'), 'completed',
    'the in-place status patch must still land when no announcer is wired');
});
