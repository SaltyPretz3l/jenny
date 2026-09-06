const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  createCitationJumpController,
} = require('../renderer/chat/renderer-chat-citation-jump-utils');

// Scroll-program W0 red suite (fixed in W1a): row and tool-row citation jumps
// today go through a raw scrollIntoView with no follow-latest release, so a jump
// taken between turns leaves follow latched and the next assistant reply yanks
// the reader back to the bottom. W1a routes every jump through the shared
// viewport reveal helper (dep `viewportReveal`), which releases follow and
// reports the navigation (with its reason) to the scroll coordinator.
//
// Sibling file to renderer-chat-citation-jump-utils.test.js: appending there
// would push it past the 600-line test-file ratchet.

// Controllers arm referenced highlight timers; dispose after each test so the
// file does not hold the event loop (same rule as the sibling test file).
const liveCitationControllers = [];
test.afterEach(() => {
  while (liveCitationControllers.length) {
    try { liveCitationControllers.pop().dispose(); } catch { /* already disposed */ }
  }
});

function buildDom(bodyHtml) {
  const dom = new JSDOM(
    '<!doctype html><html><body>'
      + '<div id="chatView">'
      + '<div id="chatTimeline" role="feed">'
      + bodyHtml
      + '</div>'
      + '</div>'
      + '</body></html>',
    { url: 'https://jenny.local/chat' }
  );
  dom.window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};
  return dom;
}

function click(win, target) {
  const event = new win.MouseEvent('click', { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

function createFollowHarness(dom) {
  // Stands in for renderer state + the W1a reveal helper: revealElement must be
  // invoked with followLatest === false (releasing follow) and a non-empty
  // navigation reason for the coordinator's attribution marker and telemetry.
  const uiState = { ui: { followLatest: true } };
  const revealCalls = [];
  const viewportReveal = {
    revealElement(element, options) {
      revealCalls.push({
        target: element.getAttribute('data-row-id')
          || element.getAttribute('data-tool-call-id')
          || element.getAttribute('data-message-id')
          || '',
        followLatest: options ? options.followLatest : undefined,
        reason: options ? options.reason : undefined,
      });
      if (options && options.followLatest === false) {
        uiState.ui.followLatest = false;
      }
      return true;
    },
  };
  return { uiState, revealCalls, viewportReveal, dom };
}

test('row citation jumps release follow-latest through the reveal path', () => {
  const dom = buildDom(
    '<article class="chat-entry" data-message-id="m1" tabindex="-1">'
      + '<div class="chat-bubble-markdown"><a id="citeRow" href="#row:turn-row-1">row</a></div>'
      + '</article>'
      + '<article class="chat-entry" data-message-id="m2" tabindex="-1">'
      + '<div class="chat-row" data-row-id="turn-row-1" tabindex="-1">row target</div>'
      + '</article>'
  );
  const harness = createFollowHarness(dom);
  const controller = createCitationJumpController({
    document: dom.window.document,
    window: dom.window,
    chatTimeline: dom.window.document.getElementById('chatTimeline'),
    viewportReveal: harness.viewportReveal,
  });
  liveCitationControllers.push(controller);
  controller.attach();

  click(dom.window, dom.window.document.getElementById('citeRow'));

  assert.equal(
    harness.uiState.ui.followLatest,
    false,
    'a row jump taken while follow is latched must release follow, or the next '
      + 'stream sync yanks the reader back to the bottom'
  );
  assert.equal(harness.revealCalls.length, 1, 'the jump must route through the reveal helper');
  assert.equal(harness.revealCalls[0].target, 'turn-row-1');
  assert.equal(harness.revealCalls[0].followLatest, false);
  assert.ok(
    typeof harness.revealCalls[0].reason === 'string' && harness.revealCalls[0].reason.length > 0,
    'the reveal call must carry a navigation reason for attribution + telemetry'
  );
});

test('tool-row citation jumps release follow-latest through the reveal path', () => {
  const dom = buildDom(
    '<article class="chat-entry" data-message-id="m1" tabindex="-1">'
      + '<div class="chat-bubble-markdown"><a id="citeTool" href="#tool:call-9">tool</a></div>'
      + '</article>'
      + '<article class="chat-entry" data-message-id="m2" tabindex="-1">'
      + '<div class="chat-row" data-tool-call-id="call-9" tabindex="-1">tool row</div>'
      + '</article>'
  );
  const harness = createFollowHarness(dom);
  const controller = createCitationJumpController({
    document: dom.window.document,
    window: dom.window,
    chatTimeline: dom.window.document.getElementById('chatTimeline'),
    viewportReveal: harness.viewportReveal,
  });
  liveCitationControllers.push(controller);
  controller.attach();

  click(dom.window, dom.window.document.getElementById('citeTool'));

  assert.equal(
    harness.uiState.ui.followLatest,
    false,
    'a tool-row jump taken while follow is latched must release follow'
  );
  assert.equal(harness.revealCalls.length, 1, 'the jump must route through the reveal helper');
  assert.equal(harness.revealCalls[0].target, 'call-9');
  assert.equal(harness.revealCalls[0].followLatest, false);
  assert.ok(
    typeof harness.revealCalls[0].reason === 'string' && harness.revealCalls[0].reason.length > 0,
    'the reveal call must carry a navigation reason for attribution + telemetry'
  );
});
