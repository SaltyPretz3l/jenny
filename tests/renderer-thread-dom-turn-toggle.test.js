const test = require('node:test');
const assert = require('node:assert/strict');

const { createThreadDomPipeline } = require('../renderer/chat/renderer-render-pipeline-thread-dom');

// Split from renderer-render-pipeline-thread-dom.test.js, which sits at the
// file-size ceiling.

test('the turn article drops its toggle when every child is an envelope compat anchor', () => {
  // A step that issues several tool calls at once nests them all under the
  // turn article's own node; its row list already shows them, so a toggle
  // there collapsed nothing and left a ringed dot on the sprite's rail axis.
  const enveloped = (id) => '<div class="chat-row chat-row-thread-compat" data-row-kind="thread_compat"'
    + ' data-thread-compat-enveloped="true" data-source-message-id="' + id + '">'
    + '<span class="thread-compat-anchor" data-message-id="' + id + '" data-thread-compat-anchor="true" aria-hidden="true"></span></div>';
  const articles = {
    batch_turn: '<article class="chat-entry" data-message-id="batch_turn"></article>',
    tool_a: enveloped('tool_a'),
    tool_b: enveloped('tool_b'),
    legacy_turn: '<article class="chat-entry" data-message-id="legacy_turn"></article>',
    legacy_tool_a: '<article class="chat-entry" data-message-id="legacy_tool_a"></article>',
    legacy_tool_b: '<article class="chat-entry" data-message-id="legacy_tool_b"></article>',
    collapsed_turn: '<article class="chat-entry" data-message-id="collapsed_turn"></article>',
    tool_c: enveloped('tool_c'),
  };
  const node = (id, children) => ({ id, role: 'assistant', kind: '', parentId: 'p', message: { id }, children });
  const pipeline = createThreadDomPipeline({
    callbacks: {
      escapeHtml: (value) => String(value || ''),
      shouldShowThreadToggle: (candidate) => candidate.children.length > 0,
      isThreadBranchOpen: (candidate) => candidate.id !== 'collapsed_turn',
    },
  });
  const html = pipeline.renderThreadTree({
    roots: [
      node('batch_turn', [node('tool_a', []), node('tool_b', [])]),
      node('legacy_turn', [node('legacy_tool_a', []), node('legacy_tool_b', [])]),
      node('collapsed_turn', [node('tool_c', [])]),
    ],
  }, 's1', new Set(), (message) => articles[message.id] || '', {});

  assert.doesNotMatch(html, /data-thread-toggle="batch_turn"/);
  // The turn article itself still renders and is not taken out of layout.
  assert.match(html, /data-message-id="batch_turn"/);
  assert.doesNotMatch(html, /data-thread-message-id="batch_turn"[^>]*data-thread-compat-only="true"/);
  // Children with real articles keep the toggle (non-envelope transcripts).
  assert.match(html, /data-thread-toggle="legacy_turn"/);
  // A collapsed branch keeps its expand control.
  assert.match(html, /data-thread-toggle="collapsed_turn"/);
});
