'use strict';

// Timeline row alignment pass (2026-10-20): behaviour pins for the rail
// toggle's first-line centring and the tool row's duplicate-name summary.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createThreadDomPipeline } = require('../renderer/chat/renderer-render-pipeline-thread-dom');
const { createTurnRowToolRenderUtils } = require('../renderer/chat/renderer-turn-row-tool-render-utils');
const toolCallUtils = require('../renderer/chat/tool-call-utils');

// Timeline row alignment (2026-10-20): a response toggle centres on its first
// visible text line, the axis the per-row dots use, instead of top-aligning
// to the landmark box (which sat it 4-5px above prose and card first lines).
test('response toggle dots centre on the first visible text line', () => {
  const textNode = { nodeValue: 'Hello', parentElement: { closest: () => null } };
  const ownerDocument = {
    createTreeWalker() {
      let done = false;
      return { nextNode() { if (done) return null; done = true; return textNode; } };
    },
    createRange() {
      return { selectNodeContents() {}, getClientRects: () => [{ top: 130, height: 20, width: 40 }] };
    },
  };
  const landmark = {
    ownerDocument,
    offsetParent: {},
    getBoundingClientRect: () => ({ top: 120, left: 0, right: 100, bottom: 160, width: 100, height: 40 }),
  };
  const row = {
    getBoundingClientRect: () => ({ top: 100, left: 0, right: 100, bottom: 200, width: 100, height: 100 }),
    querySelector: (selector) => (selector === '.chat-thread-node-article' ? { querySelector: () => landmark } : null),
  };
  const dot = {
    offsetParent: {},
    offsetHeight: 24,
    style: { top: '' },
    closest(selector) {
      if (selector === '.chat-thread-node-row') return row;
      if (selector === '.chat-thread-node') return { dataset: { threadNodeKind: 'response' } };
      return null;
    },
  };
  const rootStyle = { _props: new Map(), setProperty(n, v) { this._props.set(n, v); }, removeProperty(n) { this._props.delete(n); } };
  const root = {
    style: rootStyle,
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 100, bottom: 400, width: 100, height: 400 }),
    querySelectorAll: (selector) => (selector === '.chat-thread-toggle' ? [dot] : []),
  };
  const chatTimeline = { querySelectorAll: (selector) => (selector === '.chat-thread-root' ? [root] : []) };

  createThreadDomPipeline({ dom: { chatTimeline } }).updateThreadRailExtents();

  // Line centre 140 (viewport) - row top 100 - half the 24px hit box = 28.
  assert.equal(dot.style.top, '28px');
});

test('a file row whose summary is only the tool name plus its path drops the duplicate word', () => {
  const renderer = createTurnRowToolRenderUtils({ toolCallUtils });
  const html = renderer.buildToolCallRowMarkup({
    turn_id: 'turn-dup', row_id: 'row-dup',
    payload: { tool_call_id: 'call-dup', tool_name: 'Edit', state: 'completed', input: { file_path: 'test.py', old_string: 'a', new_string: 'b' } },
  }, [], { sessionId: 'session-a' });
  assert.match(html, /class="tool-call-name">Edit</);
  assert.match(html, /class="tool-path-chip"[^>]*>test\.py</);
  // The leftover "Edit" once the path moves into its chip used to render as
  // a second, muted "Edit" beside the name.
  assert.doesNotMatch(html, /tool-call-row-summary">Edit</);
});
