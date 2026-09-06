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

test('renderer splits tool-first completed turns into tool and assistant articles', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const input = window.document.getElementById('chatInput');
  const sendButton = window.document.getElementById('sendButton');

  input.value = 'Use a tool';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUi(window, 30);

  shell.__state.messagesBySession.set('session-1', [
    {
      id: 'user_stream-test-1',
      role: 'user',
      content: 'Use a tool',
      status: 'complete',
    },
    {
      id: 'tool_call_1',
      role: 'assistant',
      kind: 'tool_use',
      status: 'completed',
      finalizedAt: '2026-03-20T12:00:01.000Z',
      tool_call: {
        call_id: 'call_1',
        tool_name: 'Read',
        parent_stream_id: 'stream-test-1',
        summary: 'Read renderer/chat/renderer-render-pipeline-utils.js',
        input: {
          file_path: 'renderer/chat/renderer-render-pipeline-utils.js',
        },
      },
    },
    {
      id: 'assistant_stream-test-1',
      role: 'assistant',
      content: 'I checked the file.',
      status: 'complete',
      streamId: 'stream-test-1',
      finalizedAt: '2026-03-20T12:00:05.000Z',
    },
  ]);
  await shell.__emitChat({
    type: 'complete',
    sessionId: 'session-1',
    streamId: 'stream-test-1',
    content: 'I checked the file.',
    interactiveProtocolDrift: false,
    interactiveProtocolDriftPreview: '',
  });
  await waitForUi(window, 30);

  const toolEntry = window.document.querySelector('article[data-message-id="tool_call_1"]');
  const assistantEntry = window.document.querySelector('article[data-message-id="assistant_stream-test-1"]');
  const assistantNode = window.document.querySelector('.chat-thread-node[data-thread-message-id="assistant_stream-test-1"]');
  assert.ok(toolEntry);
  assert.ok(toolEntry.classList.contains('message-shell'));
  assert.equal(toolEntry.querySelector('.chat-avatar'), null, 'the legacy per-message avatar was removed by scroll-W4c — the sprite layer owns assistant identity');
  assert.ok(assistantEntry, 'the post-tool assistant segment should own its visible final article');
  assert.ok(toolEntry.querySelector('.chat-message-content'));
  assert.ok(toolEntry.querySelector('.chat-message-content .turn-row-list[data-turn-row-list="true"]'));
  // Trace parity (D1/B6): the tool cluster no longer coalesces into a single
  // compact tool_step row. A completed call renders as a tool_call row owned by
  // the tool_use message; its matching tool_result is a separate row.
  assert.ok(toolEntry.querySelector('.chat-message-content .chat-row[data-row-kind="tool_call"][data-source-message-id="tool_call_1"]'));
  assert.ok(toolEntry.querySelector('.chat-message-content .tool-call-row'));
  assert.equal(toolEntry.querySelector('.chat-message-content .chat-row[data-row-kind="assistant_text"]'), null);
  assert.ok(assistantEntry.querySelector('.chat-message-content .chat-row[data-row-kind="assistant_text"][data-source-message-id="assistant_stream-test-1"]'));
  assert.ok(assistantEntry.querySelector('.chat-message-content .chat-hover-row[data-message-id="assistant_stream-test-1"]'));
  assert.ok(assistantNode);
  assert.equal(
    assistantNode.querySelector('.thread-compat-anchor[data-message-id="assistant_stream-test-1"]'),
    null,
    'assistant nodes with owned visible rows should not be hidden compat anchors'
  );
  assert.equal(
    toolEntry.closest('.chat-thread-node')?.getAttribute('data-thread-parent'),
    'user_stream-test-1',
    'tool-first turns should keep the tool article attached to the user turn'
  );
  assert.equal(
    assistantEntry.closest('.chat-thread-node')?.getAttribute('data-thread-parent'),
    'user_stream-test-1',
    'flattened thread tree: assistant iterations are siblings under the turn anchor, not chained under tools'
  );
  assert.equal(
    Array.from(
      window.document
        .querySelector('.chat-thread-root-user[data-thread-message-id="user_stream-test-1"]')
        ?.children || []
    ).some((element) => element.classList.contains('chat-thread-node-row')),
    false,
    'user roots should stay dotless in the three-rail layout'
  );
});

test('renderer keeps segmented assistant continuations as source-owned articles in one stream branch', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const input = window.document.getElementById('chatInput');
  const sendButton = window.document.getElementById('sendButton');

  input.value = 'Use a tool and continue';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUi(window, 30);

  shell.__state.messagesBySession.set('session-1', [
    {
      id: 'user_stream-test-1',
      role: 'user',
      content: 'Use a tool and continue',
      status: 'complete',
    },
    {
      id: 'assistant_stream-test-1',
      role: 'assistant',
      streamId: 'stream-test-1',
      content: 'I am checking that now.',
      status: 'complete',
      finalizedAt: '2026-03-20T12:00:00.000Z',
    },
    {
      id: 'tool_call_1',
      role: 'assistant',
      kind: 'tool_use',
      status: 'completed',
      finalizedAt: '2026-03-20T12:00:01.000Z',
      tool_call: {
        call_id: 'call_1',
        tool_name: 'Read',
        parent_stream_id: 'stream-test-1',
        summary: 'Read renderer/chat/renderer-render-pipeline-utils.js',
        input: {
          file_path: 'renderer/chat/renderer-render-pipeline-utils.js',
        },
      },
    },
    {
      id: 'assistant_stream-test-1_seg1',
      role: 'assistant',
      streamId: 'stream-test-1',
      content: 'I found the issue in the thread tree.',
      status: 'complete',
      finalizedAt: '2026-03-20T12:00:05.000Z',
    },
  ]);
  await shell.__emitChat({
    type: 'complete',
    sessionId: 'session-1',
    streamId: 'stream-test-1',
    content: 'I found the issue in the thread tree.',
    interactiveProtocolDrift: false,
    interactiveProtocolDriftPreview: '',
  });
  await waitForUi(window, 30);

  const turnEntry = window.document.querySelector('article[data-message-id="assistant_stream-test-1"]');
  const toolEntry = window.document.querySelector('article[data-message-id="tool_call_1"]');
  const assistantContinuationEntry = window.document.querySelector('article[data-message-id="assistant_stream-test-1_seg1"]');
  const toolNode = window.document.querySelector('.chat-thread-node[data-thread-message-id="tool_call_1"]');
  const assistantContinuationNode = window.document.querySelector('.chat-thread-node[data-thread-message-id="assistant_stream-test-1_seg1"]');

  assert.ok(turnEntry);
  assert.ok(toolEntry);
  assert.ok(assistantContinuationEntry);
  assert.ok(turnEntry.querySelector('.chat-message-content .chat-row[data-row-kind="assistant_text"][data-source-message-id="assistant_stream-test-1"]'));
  assert.ok(toolEntry.querySelector('.chat-message-content .chat-row[data-row-kind="tool_call"][data-source-message-id="tool_call_1"]'));
  assert.ok(assistantContinuationEntry.querySelector('.chat-message-content .chat-row[data-row-kind="assistant_text"][data-source-message-id="assistant_stream-test-1_seg1"]'));
  assert.equal(
    toolNode?.getAttribute('data-thread-parent'),
    'assistant_stream-test-1',
    'tool nodes should stay attached to the original assistant owner for the stream'
  );
  assert.equal(
    assistantContinuationNode?.getAttribute('data-thread-parent'),
    'user_stream-test-1',
    'flattened thread tree: assistant continuations are siblings under the turn anchor (max depth 2)'
  );
  assert.equal(
    window.document.querySelector('[data-thread-toggle="tool_call_1"]'),
    null,
    'tool-parent branches should not render a nested toggle chip for a single assistant continuation'
  );
  assert.ok(
    toolNode?.querySelector('.chat-thread-node-article .chat-row .chat-row-node-dot'),
    'tool rows should render per-row node dots so the vertical rail remains continuous'
  );
  assert.equal(
    toolNode?.classList.contains('chat-thread-node-tool-parent'),
    false,
    'flattened thread tree: childless tool nodes are not tool-parent branches'
  );
});

test('renderer splits assistant metadata notices and awaiting-approval tool rows by source owner', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const input = window.document.getElementById('chatInput');
  const sendButton = window.document.getElementById('sendButton');

  input.value = 'Show me the status and wait for approval';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUi(window, 30);

  shell.__state.messagesBySession.set('session-1', [
    {
      id: 'user_notice_turn',
      role: 'user',
      content: 'Show me the status and wait for approval',
      status: 'complete',
    },
    {
      id: 'assistant_notice_turn',
      role: 'assistant',
      content: 'I am preparing the action.',
      status: 'complete',
      streamId: 'stream-notice-turn',
      finalizedAt: '2026-03-20T12:00:00.000Z',
      context_compacted: {
        strategy: 'micro',
        tokensBefore: 1200,
        tokensAfter: 400,
      },
      agent_status: {
        taskId: 'task_notice_turn',
        status: 'running',
        summary: 'Preparing the next action',
      },
    },
    {
      id: 'tool_use_notice_turn',
      role: 'assistant',
      kind: 'tool_use',
      status: 'pending_approval',
      tool_call: {
        call_id: 'call_notice_turn',
        tool_name: 'Write',
        parent_stream_id: 'stream-notice-turn',
        status: 'pending_approval',
        approval_state: 'pending',
        summary: 'Write plan.md',
        input: {
          file_path: 'plan.md',
        },
      },
    },
  ]);
  await shell.__emitChat({
    type: 'complete',
    sessionId: 'session-1',
    streamId: 'stream-notice-turn',
    content: 'I am preparing the action.',
    interactiveProtocolDrift: false,
    interactiveProtocolDriftPreview: '',
  });
  await waitForUi(window, 30);

  const turnEntry = window.document.querySelector('article[data-message-id="assistant_notice_turn"]');
  const toolEntry = window.document.querySelector('article[data-message-id="tool_use_notice_turn"]');

  assert.ok(turnEntry);
  assert.ok(toolEntry);
  assert.ok(turnEntry.querySelector('.chat-row[data-row-kind="system_notice"] .context-compacted-notice'));
  assert.ok(turnEntry.querySelector('.chat-row[data-row-kind="system_notice"] .agent-status-note'));
  assert.ok(
    toolEntry.querySelector('.chat-row[data-row-kind="tool_call"][data-tool-call-id="call_notice_turn"][data-row-state="awaiting_approval"]')
  );
  assert.equal(
    window.document.querySelector(
      '.chat-thread-node[data-thread-message-id="tool_use_notice_turn"] .thread-compat-anchor[data-message-id="tool_use_notice_turn"]'
    ),
    null
  );
});

// NOTE (B6 trace-parity migration): the test "renderer refreshes projected
// tool shells when tool_result content changes across rerenders" was removed.
// Its sole subject was the compact projector coalescing a tool_result's
// output_text into the single tool_step row inside the tool_use article, then
// asserting that inlined output refreshes (alpha -> beta) across rerenders.
// Under trace parity the result is a SEPARATE tool_result row keyed by a
// synthetic tool_result_<callId> id (not the tool_use article), so the tool
// article never inlines output_text and there is no compact shell to refresh.
// That behavior no longer exists, so the test is retired per the migration
// rule (delete tests whose sole subject is compact-only coalescing).
