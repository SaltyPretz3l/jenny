/* Live tool-patch targeting around approvals and labels: the approval_gap row
   shares its call's data-tool-call-id but is never the patch target, a settling
   approval must reach a structural render (the Allow/Deny card retracts only
   there), and a patch never writes the raw tool id over the display name. */
const assert = require('node:assert/strict');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const patchUtils = require('../renderer/chat/renderer-stream-tool-patch-utils');

function createPatchHarness(html) {
  const dom = new JSDOM(html);
  const frames = [];
  dom.window.requestAnimationFrame = (callback) => frames.push(callback);
  dom.window.cancelAnimationFrame = () => {};
  const logs = [];
  const controller = patchUtils.createLiveToolPatchController({
    windowRef: dom.window,
    chatTimeline: dom.window.document.getElementById('chatTimeline'),
    appendClientLog(level, event, details) {
      logs.push({ level, event, details });
    },
    isVisibleChatSession: (sessionId) => sessionId === 'session-1',
  });
  const frameHarness = {
    count: () => frames.length,
    drain: () => frames.splice(0).forEach((callback) => callback(Date.now())),
  };
  return { dom, frameHarness, controller, logs };
}

const APPROVAL_GAP_HTML = (gapState) => `
  <div id="chatTimeline">
    <div class="chat-row" data-row-kind="tool_call" data-tool-call-id="call-gap" data-row-state="awaiting_approval">
      <div class="tool-call-row tool-call-row--minimal" data-tool-call-id="call-gap" data-tool-status="awaiting_approval">
        <span class="tool-call-name">Read</span>
        <span class="tool-call-status-badge">Awaiting approval</span>
      </div>
    </div>
    <div class="chat-row" data-row-kind="approval_gap" data-tool-call-id="call-gap" data-row-state="${gapState}">
      <div class="approval-gap-row" data-approval-status="pending">
        <span class="tool-call-status-badge">Awaiting approval</span>
      </div>
    </div>
  </div>
`;

test('live tool patch never targets the approval_gap row that shares the call id', () => {
  const { dom, frameHarness, controller } = createPatchHarness(APPROVAL_GAP_HTML('resolved'));
  assert.equal(controller.queueToolPatch({
    type: 'tool_use', sessionId: 'session-1', callId: 'call-gap', toolName: 'read_file', status: 'running',
  }, { eventType: 'tool_use' }), true);
  frameHarness.drain();

  const [callRow, gapRow] = dom.window.document.querySelectorAll('.chat-row[data-tool-call-id="call-gap"]');
  assert.equal(callRow.getAttribute('data-row-state'), 'running');
  assert.equal(callRow.querySelector('.tool-call-row').getAttribute('data-tool-status'), 'running');
  assert.equal(callRow.querySelector('.tool-call-status-badge').textContent, 'Running');
  assert.equal(gapRow.getAttribute('data-row-state'), 'resolved');
  assert.equal(gapRow.querySelector('.tool-call-status-badge').textContent, 'Awaiting approval');
});

test('a settling approval or an unresolved approval_gap row refuses the field patch so a render retracts the card', () => {
  const { dom, frameHarness, controller, logs } = createPatchHarness(APPROVAL_GAP_HTML('awaiting_approval'));
  for (const status of ['approved', 'denied', 'timed_out', 'cancelled']) {
    assert.equal(controller.queueToolPatch({
      type: 'tool_use', sessionId: 'session-1', callId: 'call-gap', status,
    }, { eventType: 'tool_use' }), false, status);
  }
  // Any event while the Allow/Deny card is still up needs the render too.
  assert.equal(controller.queueToolPatch({
    type: 'tool_use', sessionId: 'session-1', callId: 'call-gap', status: 'running',
  }, { eventType: 'tool_use' }), false);
  assert.equal(frameHarness.count(), 0);
  assert.ok(logs.some((entry) => entry.details.reason === 'approval_gap_render'));
  const callRow = dom.window.document.querySelector('.chat-row[data-row-kind="tool_call"]');
  assert.equal(callRow.getAttribute('data-row-state'), 'awaiting_approval');
});

test('a settling approval refuses the field patch even with no approval_gap row mounted', () => {
  const { controller } = createPatchHarness(`
    <div id="chatTimeline">
      <div class="chat-row" data-tool-call-id="call-ap" data-row-state="awaiting_approval">
        <div class="tool-call-row" data-tool-call-id="call-ap" data-tool-status="awaiting_approval"></div>
      </div>
    </div>
  `);
  assert.equal(controller.queueToolPatch({
    type: 'tool_use', sessionId: 'session-1', callId: 'call-ap', status: 'approved',
  }, { eventType: 'tool_use' }), false);
});

test('live tool patch keeps the rendered display name instead of writing the raw tool id', () => {
  const { dom, frameHarness, controller } = createPatchHarness(`
    <div id="chatTimeline">
      <div class="chat-row" data-tool-call-id="call-name" data-row-state="running">
        <div class="tool-call-block" data-call-id="call-name" data-tool-status="running">
          <span class="tool-call-name">Read</span>
          <span class="tool-call-status tool-call-status-running"><span class="tool-call-status-label">Running</span></span>
        </div>
        <div class="tool-result-row" data-tool-call-id="call-name"><span class="tool-result-label">Read</span></div>
      </div>
    </div>
  `);
  assert.equal(controller.queueToolPatch({
    type: 'tool_result', sessionId: 'session-1', callId: 'call-name', toolName: 'read_file', content: 'ok',
  }, { eventType: 'tool_result' }), true);
  frameHarness.drain();
  assert.equal(dom.window.document.querySelector('.tool-call-name').textContent, 'Read');
  assert.equal(dom.window.document.querySelector('.tool-result-label').textContent, 'Read');
  assert.equal(dom.window.document.querySelector('.tool-call-status-label').textContent, 'Success');
});

test('a timed-out result patches as timed_out from its metadata', () => {
  const { dom, frameHarness, controller } = createPatchHarness(`
    <div id="chatTimeline">
      <div class="chat-row" data-tool-call-id="call-to" data-row-state="running">
        <div class="tool-call-row" data-tool-call-id="call-to" data-tool-status="running">
          <span class="tool-call-status-badge">Running</span>
        </div>
      </div>
    </div>
  `);
  assert.equal(controller.queueToolPatch({
    type: 'tool_result', sessionId: 'session-1', callId: 'call-to', isError: true, metadata: { timed_out: true },
  }, { eventType: 'tool_result' }), true);
  frameHarness.drain();
  assert.equal(dom.window.document.querySelector('.tool-call-row').getAttribute('data-tool-status'), 'timed_out');
  assert.equal(dom.window.document.querySelector('.tool-call-status-badge').textContent, 'Timed out');
});
