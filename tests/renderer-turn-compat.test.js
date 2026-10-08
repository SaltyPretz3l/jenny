const assert = require('node:assert/strict');
const test = require('node:test');

const {
  loadRendererApp,
  waitForUi,
} = require('./helpers/renderer-shell-harness');

async function loadRendererTestApp(t, options) {
  const app = await loadRendererApp(options);
  t.after(async () => {
    await app.dispose();
  });
  return app;
}

test('completed segmented turns coalesce into one turn article while rowless siblings keep compat anchors', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const input = window.document.getElementById('chatInput');
  const sendButton = window.document.getElementById('sendButton');
  const timeline = window.document.querySelector('.chat-timeline');

  input.value = 'Use one tool';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUi(window, 30);

  shell.__state.messagesBySession.set('session-1', [
    {
      id: 'user_turn_compat',
      role: 'user',
      content: 'Use one tool',
      status: 'complete',
    },
    {
      id: 'assistant_turn_compat',
      role: 'assistant',
      content: 'I am checking that now.',
      status: 'complete',
      streamId: 'stream-turn-compat',
      finalizedAt: '2026-04-15T12:00:00.000Z',
    },
    {
      id: 'tool_use_turn_compat',
      role: 'assistant',
      kind: 'tool_use',
      status: 'completed',
      finalizedAt: '2026-04-15T12:00:01.000Z',
      tool_call: {
        call_id: 'call_turn_compat',
        tool_name: 'Read',
        parent_stream_id: 'stream-turn-compat',
        summary: 'Read README',
      },
    },
    {
      id: 'tool_result_turn_compat',
      role: 'assistant',
      kind: 'tool_result',
      status: 'complete',
      tool_result: {
        call_id: 'call_turn_compat',
        tool_name: 'Read',
        parent_stream_id: 'stream-turn-compat',
        output_text: 'README contents',
      },
    },
    {
      id: 'assistant_turn_compat_seg1',
      role: 'assistant',
      content: 'The README looks good.',
      status: 'complete',
      streamId: 'stream-turn-compat',
      finalizedAt: '2026-04-15T12:00:05.000Z',
    },
  ]);

  await shell.__emitChat({
    type: 'complete',
    sessionId: 'session-1',
    streamId: 'stream-turn-compat',
    content: 'The README looks good.',
    interactiveProtocolDrift: false,
    interactiveProtocolDriftPreview: '',
  });
  await waitForUi(window, 80);

  // The turn activity envelope coalesces the whole turn into the first
  // assistant article: pre-tool text, the tool row, then post-tool text.
  const turnArticle = timeline.querySelector('article[data-message-id="assistant_turn_compat"]');
  assert.ok(turnArticle, 'the turn should render on the first assistant article');
  assert.equal(
    timeline.querySelectorAll('article').length,
    2,
    'the user turn plus one coalesced assistant turn article should be visible'
  );
  assert.match(String(turnArticle.getAttribute('data-turn-id') || ''), /turn_compat|stream-turn-compat/);
  const rowOrder = Array.from(turnArticle.querySelectorAll('[data-row-kind]'))
    .map((row) => `${row.getAttribute('data-row-kind')}:${row.getAttribute('data-source-message-id')}`);
  assert.deepEqual(rowOrder, [
    'assistant_text:assistant_turn_compat',
    'tool_call:tool_use_turn_compat',
    'assistant_text:assistant_turn_compat_seg1',
  ]);
  const toolArticle = turnArticle;

  // Trace parity (B6/D1): the completed tool renders as a `tool_call` row that
  // is anchored to the tool_use source message. The tool_result is a SEPARATE
  // trace row owned by the rowless `tool_result_turn_compat` sibling, so it is
  // no longer coalesced onto the visible tool row. The visible tool surface
  // must therefore carry the tool_use anchor and NOT the result's source id.
  const toolCallRow = toolArticle.querySelector('[data-row-kind="tool_call"]');
  assert.match(
    String(toolCallRow?.getAttribute('data-source-message-ids') || ''),
    /tool_use_turn_compat/,
    'the visible tool call row should keep the tool-use source anchor'
  );
  assert.doesNotMatch(
    String(toolCallRow?.getAttribute('data-source-message-ids') || ''),
    /tool_result_turn_compat/,
    'the trace tool call row should not coalesce the rowless tool result sibling'
  );
  assert.ok(
    timeline.querySelector('.chat-thread-node[data-thread-message-id="tool_use_turn_compat"]'),
    'the visible tool thread node should remain in the tree'
  );
});

test('completed coalesced assistant turns keep branch toggles working through compat-only child nodes', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const input = window.document.getElementById('chatInput');
  const sendButton = window.document.getElementById('sendButton');
  const timeline = window.document.querySelector('.chat-timeline');

  input.value = 'Check both items';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUi(window, 30);

  shell.__state.messagesBySession.set('session-1', [
    {
      id: 'user_turn_toggle',
      role: 'user',
      content: 'Check both items',
      status: 'complete',
    },
    {
      id: 'assistant_turn_toggle',
      role: 'assistant',
      content: 'I will inspect both items.',
      status: 'complete',
      streamId: 'stream-turn-toggle',
      finalizedAt: '2026-04-15T12:10:00.000Z',
    },
    {
      id: 'tool_use_turn_toggle_a',
      role: 'assistant',
      kind: 'tool_use',
      status: 'completed',
      tool_call: {
        call_id: 'call_turn_toggle_a',
        tool_name: 'Read',
        parent_stream_id: 'stream-turn-toggle',
      },
    },
    {
      id: 'tool_result_turn_toggle_a',
      role: 'assistant',
      kind: 'tool_result',
      status: 'complete',
      tool_result: {
        call_id: 'call_turn_toggle_a',
        tool_name: 'Read',
        parent_stream_id: 'stream-turn-toggle',
        output_text: 'Item A checked',
      },
    },
    {
      id: 'tool_use_turn_toggle_b',
      role: 'assistant',
      kind: 'tool_use',
      status: 'completed',
      tool_call: {
        call_id: 'call_turn_toggle_b',
        tool_name: 'Search',
        parent_stream_id: 'stream-turn-toggle',
      },
    },
    {
      id: 'tool_result_turn_toggle_b',
      role: 'assistant',
      kind: 'tool_result',
      status: 'complete',
      tool_result: {
        call_id: 'call_turn_toggle_b',
        tool_name: 'Search',
        parent_stream_id: 'stream-turn-toggle',
        output_text: 'Item B checked',
      },
    },
  ]);

  await shell.__emitChat({
    type: 'complete',
    sessionId: 'session-1',
    streamId: 'stream-turn-toggle',
    content: 'I will inspect both items.',
    interactiveProtocolDrift: false,
    interactiveProtocolDriftPreview: '',
  });
  await waitForUi(window, 80);

  let toggle = timeline.querySelector('[data-thread-toggle="assistant_turn_toggle"]');
  let childContainer = timeline.querySelector('.chat-thread-children[data-thread-parent="assistant_turn_toggle"]');
  assert.ok(toggle, 'assistant turns with multiple tool children should still expose a branch toggle');
  assert.ok(childContainer, 'the compat-only child container should remain in the thread tree');
  const initialExpanded = String(toggle.getAttribute('aria-expanded') || '');
  const initialHidden = childContainer.hasAttribute('hidden');

  toggle.click();
  await waitForUi(window, 40);
  toggle = timeline.querySelector('[data-thread-toggle="assistant_turn_toggle"]');
  childContainer = timeline.querySelector('.chat-thread-children[data-thread-parent="assistant_turn_toggle"]');
  assert.notEqual(
    String(toggle?.getAttribute('aria-expanded') || ''),
    initialExpanded,
    'the branch toggle should still flip its expanded state when compat-only children are present'
  );
  assert.notEqual(
    childContainer?.hasAttribute('hidden'),
    initialHidden,
    'the compat-only child container visibility should change when the toggle is used'
  );

  toggle.click();
  await waitForUi(window, 40);
  toggle = timeline.querySelector('[data-thread-toggle="assistant_turn_toggle"]');
  childContainer = timeline.querySelector('.chat-thread-children[data-thread-parent="assistant_turn_toggle"]');
  assert.equal(String(toggle?.getAttribute('aria-expanded') || ''), initialExpanded);
  assert.equal(childContainer?.hasAttribute('hidden'), initialHidden);
});
