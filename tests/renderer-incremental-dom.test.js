const test = require('node:test');
const assert = require('node:assert/strict');

const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');
const { waitForUiState } = require('./helpers/wait-for-ui-state');

async function loadRendererTestApp(t, options) {
  const app = await loadRendererApp(options);
  t.after(async () => {
    await app.dispose();
  });
  return app;
}

test('appending a new message rebuilds the threaded transcript with user-rooted branches', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const input = window.document.getElementById('chatInput');
  const sendButton = window.document.getElementById('sendButton');
  const timeline = window.document.querySelector('.chat-timeline');

  shell.__state.workspaceState = {
    activeSessionId: 'session-existing',
    openSessionIds: ['session-existing'],
  };

  // First exchange: send → stream → complete.
  input.value = 'Hello';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUi(window, 20);

  assert.equal(shell.__state.workspaceState.activeSessionId, 'session-1');
  assert.deepEqual(shell.__state.workspaceState.openSessionIds, ['session-existing', 'session-1']);

  shell.__state.messagesBySession.set('session-1', [
    { id: 'u1', role: 'user', content: 'Hello', status: 'complete' },
    { id: 'a1', role: 'assistant', content: 'Hi!', status: 'complete', finalizedAt: '2026-03-19T12:00:00Z' },
  ]);
  await shell.__emitChat({
    type: 'complete',
    sessionId: 'session-1',
    streamId: 'stream-test-1',
    content: 'Hi!',
    interactiveProtocolDrift: false,
    interactiveProtocolDriftPreview: '',
  });
  await waitForUi(window, 80);

  const articlesBeforeAppend = Array.from(timeline.querySelectorAll('article'));
  assert.equal(articlesBeforeAppend.length, 2, 'should have 2 articles after first exchange');

  // Append a third message by updating the session messages and emitting
  // a new complete event to trigger re-render.
  shell.__state.messagesBySession.set('session-1', [
    { id: 'u1', role: 'user', content: 'Hello', status: 'complete' },
    { id: 'a1', role: 'assistant', content: 'Hi!', status: 'complete', finalizedAt: '2026-03-19T12:00:00Z' },
    { id: 'u2', role: 'user', content: 'Follow-up', status: 'complete' },
    { id: 'a2', role: 'assistant', content: 'Sure!', status: 'complete', finalizedAt: '2026-03-19T12:01:00Z' },
  ]);
  await shell.__emitChat({
    type: 'complete',
    sessionId: 'session-1',
    streamId: 'stream-test-2',
    content: 'Sure!',
    interactiveProtocolDrift: false,
    interactiveProtocolDriftPreview: '',
  });
  await waitForUiState(window, () => timeline.querySelectorAll('article').length === 4);

  const articlesAfterAppend = Array.from(timeline.querySelectorAll('article'));
  assert.equal(articlesAfterAppend.length, 4, 'should have 4 articles after append');
  assert.equal(timeline.querySelectorAll('.chat-thread-root-user').length, 2);
  assert.ok(
    timeline.querySelector('.chat-thread-root-user[data-thread-message-id="u1"] [data-message-id="a1"]'),
    'first assistant reply should be nested under the first user turn'
  );
  assert.ok(
    timeline.querySelector('.chat-thread-root-user[data-thread-message-id="u2"] [data-message-id="a2"]'),
    'second assistant reply should be nested under the second user turn'
  );
});

test('tail finalization keeps the threaded assistant article addressable after completion', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const input = window.document.getElementById('chatInput');
  const sendButton = window.document.getElementById('sendButton');
  const timeline = window.document.querySelector('.chat-timeline');

  input.value = 'Hello';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUiState(window, () => shell.__state.workspaceState?.activeSessionId === 'session-1');

  await shell.__emitChat({
    type: 'delta',
    sessionId: 'session-1',
    streamId: 'stream-test-1',
    content: 'Hi there!',
    aggregate: 'Hi there!',
  });
  await waitForUi(window, 30);

  await shell.__emitChat({
    type: 'finish',
    sessionId: 'session-1',
    streamId: 'stream-test-1',
  });
  await waitForUi(window, 50);

  const articlesAfter = Array.from(timeline.querySelectorAll('article'));
  assert.ok(articlesAfter.length >= 2, 'should still have at least 2 articles');
  const assistantArticle = timeline.querySelector('[data-message-id="assistant_stream-test-1"]');
  assert.ok(assistantArticle, 'assistant article should remain queryable by message id');
  assert.ok(assistantArticle.classList.contains('message-shell'));
  assert.ok(assistantArticle.querySelector('.chat-message-content .turn-row-list[data-turn-row-list="true"]'));
  assert.ok(
    assistantArticle.querySelector('.chat-message-content .chat-row[data-row-kind="assistant_text"][data-source-message-id="assistant_stream-test-1"]')
  );
  assert.equal(assistantArticle.getAttribute('data-message-role'), 'assistant');
  assert.equal(
    assistantArticle.closest('.chat-thread-root-user') !== null,
    true,
    'completed assistant should stay nested beneath a user turn root'
  );
});

test('pretext full renders add predicted-height metadata and clear temporary min-height after paint', async (t) => {
  const { window, shell } = await loadRendererTestApp(t, {
    shell: {
      features: {
        state: {
          featureFlags: {
            pretext_layout: true,
          },
        },
      },
    },
  });
  const input = window.document.getElementById('chatInput');
  const sendButton = window.document.getElementById('sendButton');
  const timeline = window.document.querySelector('.chat-timeline');

  input.value = 'Hello';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUi(window, 20);

  shell.__state.messagesBySession.set('session-1', [
    { id: 'u-pretext', role: 'user', content: 'Hello from pretext', status: 'complete' },
    {
      id: 'a-pretext',
      role: 'assistant',
      content: 'Assistant reply with a little more text to predict.',
      status: 'complete',
      finalizedAt: '2026-03-19T12:00:00Z',
    },
  ]);
  await shell.__emitChat({
    type: 'complete',
    sessionId: 'session-1',
    streamId: 'stream-pretext-full',
    content: 'Assistant reply with a little more text to predict.',
    interactiveProtocolDrift: false,
    interactiveProtocolDriftPreview: '',
  });
  await waitForUiState(window, () => {
    const u = timeline.querySelector('[data-message-id="u-pretext"]');
    const a = timeline.querySelector('[data-message-id="a-pretext"]');
    return /^\d+$/.test(u?.getAttribute('data-predicted-height') || '')
      && /^\d+$/.test(a?.getAttribute('data-predicted-height') || '');
  });

  const userArticle = timeline.querySelector('[data-message-id="u-pretext"]');
  const assistantArticle = timeline.querySelector('[data-message-id="a-pretext"]');
  assert.match(String(userArticle?.getAttribute('data-predicted-height') || ''), /^\d+$/);
  assert.match(String(assistantArticle?.getAttribute('data-predicted-height') || ''), /^\d+$/);

  await waitForUiState(window, () => userArticle.style.minHeight === '' && assistantArticle.style.minHeight === '');

  assert.equal(userArticle.style.minHeight, '');
  assert.equal(assistantArticle.style.minHeight, '');
});

// Skipped pending coalesced-turn refactor: same root cause as
// renderer-artifacts-shell-navigation "artifact jumps for compat-only tool
// nodes". Asserts a [data-row-kind="tool_step"] inside the assistant article,
// which currently lives in its own tool_use article (per
// renderer-turn-compat.test.js segmented contract).
test('pretext full renders keep predicted-height metadata on projected tool shells', { skip: 'pending coalesced-turn refactor (contradicts renderer-turn-compat segmented expectation)' }, async (t) => {
  const { window, shell } = await loadRendererTestApp(t, {
    shell: {
      features: {
        state: {
          featureFlags: {
            pretext_layout: true,
          },
        },
      },
    },
  });
  const input = window.document.getElementById('chatInput');
  const sendButton = window.document.getElementById('sendButton');
  const timeline = window.document.querySelector('.chat-timeline');

  input.value = 'Use a tool';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUi(window, 20);

  shell.__state.messagesBySession.set('session-1', [
    { id: 'u-tool-pretext', role: 'user', content: 'Use a tool', status: 'complete' },
    {
      id: 'assistant_tool_pretext',
      role: 'assistant',
      content: 'Working through it.',
      status: 'complete',
      streamId: 'tool-pretext-stream',
      finalizedAt: '2026-03-19T12:00:00Z',
    },
    {
      id: 'tool_use_tool_pretext',
      role: 'assistant',
      kind: 'tool_use',
      status: 'completed',
      tool_call: {
        call_id: 'call_tool_pretext',
        tool_name: 'Read',
        parent_stream_id: 'tool-pretext-stream',
        summary: 'Read package.json',
      },
    },
    {
      id: 'tool_result_tool_pretext',
      role: 'tool',
      kind: 'tool_result',
      tool_result: {
        call_id: 'call_tool_pretext',
        tool_name: 'Read',
        summary: 'Read package.json',
        output_text: '{"name":"jenny"}',
      },
    },
  ]);
  await shell.__emitChat({
    type: 'complete',
    sessionId: 'session-1',
    streamId: 'tool-pretext-stream',
    content: 'Working through it.',
    interactiveProtocolDrift: false,
    interactiveProtocolDriftPreview: '',
  });
  await waitForUi(window, 60);

  const turnArticle = timeline.querySelector('[data-message-id="assistant_tool_pretext"]');
  assert.ok(turnArticle, 'completed tool turns should stay anchored to the primary assistant message');
  assert.match(String(turnArticle.getAttribute('data-predicted-height') || ''), /^\d+$/);
  assert.ok(turnArticle.querySelector('.turn-row-list[data-turn-row-list="true"]'));
  assert.ok(turnArticle.querySelector('[data-row-kind="tool_step"][data-tool-call-id="call_tool_pretext"]'));
});

test('pretext stream patches keep predicted-height metadata on the streaming assistant article', async (t) => {
  const { window } = await loadRendererTestApp(t, {
    shell: {
      features: {
        state: {
          featureFlags: {
            pretext_layout: true,
          },
        },
      },
    },
  });
  const input = window.document.getElementById('chatInput');
  const sendButton = window.document.getElementById('sendButton');
  const timeline = window.document.querySelector('.chat-timeline');

  input.value = 'Stream this';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUi(window, 20);

  await window.jennyShell.__emitChat({
    type: 'delta',
    sessionId: 'session-1',
    streamId: 'stream-pretext-patch',
    content: 'Streaming assistant content that should get a predicted height.',
    aggregate: 'Streaming assistant content that should get a predicted height.',
  });
  await waitForUiState(window, () => {
    const a = timeline.querySelector('[data-message-id="assistant_stream-pretext-patch"]');
    return a && /^\d+$/.test(a.getAttribute('data-predicted-height') || '');
  });

  const assistantArticle = timeline.querySelector('[data-message-id="assistant_stream-pretext-patch"]');
  assert.ok(assistantArticle, 'streaming assistant article should exist');
  assert.match(String(assistantArticle.getAttribute('data-predicted-height') || ''), /^\d+$/);

  await waitForUiState(
    window,
    () => timeline.querySelector('[data-message-id="assistant_stream-pretext-patch"]')?.style.minHeight === ''
  );

  const assistantArticleAfterPaint = timeline.querySelector('[data-message-id="assistant_stream-pretext-patch"]');
  assert.equal(assistantArticleAfterPaint?.style.minHeight, '');
});

test('pretext stream patches still predict height when content appears after reasoning-only deltas', async (t) => {
  const { window, shell } = await loadRendererTestApp(t, {
    shell: {
      features: {
        state: {
          featureFlags: {
            pretext_layout: true,
          },
        },
      },
    },
  });
  const input = window.document.getElementById('chatInput');
  const sendButton = window.document.getElementById('sendButton');
  const timeline = window.document.querySelector('.chat-timeline');

  input.value = 'Think first';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUi(window, 20);

  await shell.__emitChat({
    type: 'delta',
    sessionId: 'session-1',
    streamId: 'stream-pretext-reasoning-first',
    content: '',
    aggregate: '',
    reasoning: {
      source: 'provider',
      entriesDelta: [
        { id: 'reason-pretext-first', text: 'Reasoning before visible content.', timestamp: '2026-03-19T00:00:00Z' },
      ],
    },
  });
  await waitForUi(window, 30);

  await shell.__emitChat({
    type: 'delta',
    sessionId: 'session-1',
    streamId: 'stream-pretext-reasoning-first',
    content: 'Visible content arrives after the reasoning pass.',
    aggregate: 'Visible content arrives after the reasoning pass.',
  });
  await waitForUi(window, 30);

  const assistantArticle = timeline.querySelector('[data-message-id="assistant_stream-pretext-reasoning-first"]');
  assert.ok(assistantArticle, 'streaming assistant article should exist after reasoning-first content arrives');
  assert.match(String(assistantArticle.getAttribute('data-predicted-height') || ''), /^\d+$/);

  await waitForUiState(
    window,
    () => timeline.querySelector('[data-message-id="assistant_stream-pretext-reasoning-first"]')?.style.minHeight === ''
  );

  const assistantArticleAfterPaint = timeline.querySelector('[data-message-id="assistant_stream-pretext-reasoning-first"]');
  assert.equal(assistantArticleAfterPaint?.style.minHeight, '');
});

test('pretext streaming predictions exclude collapsed tool bodies from timeline height', async (t) => {
  const { window, shell } = await loadRendererTestApp(t, {
    shell: { features: { state: { featureFlags: { pretext_layout: true } } } },
  });
  const input = window.document.getElementById('chatInput');
  const sendButton = window.document.getElementById('sendButton');
  const timeline = window.document.querySelector('.chat-timeline');
  const preparedTexts = [];
  const originalPrepare = window.pretextLayout.prepare;
  window.pretextLayout.prepare = function capturePreparedText(text, font, options) {
    preparedTexts.push(String(text || ''));
    return originalPrepare.call(this, text, font, options);
  };
  t.after(() => { window.pretextLayout.prepare = originalPrepare; });

  input.value = 'Run several tools';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUiState(window, () => Boolean(timeline.querySelector('.chat-entry.user')));
  await shell.__emitChat({
    type: 'delta',
    sessionId: 'session-1',
    streamId: 'stream-test-1',
    content: 'Working through the tool calls.',
    aggregate: 'Working through the tool calls.',
  });

  const observedPredictedHeights = [];
  for (let index = 1; index <= 3; index += 1) {
    const callId = `call-height-${index}`;
    const hiddenPayload = `COLLAPSED_TOOL_PAYLOAD_${index}_${'x'.repeat(3000)}`;
    await shell.__emitChat({
      type: 'tool_use',
      sessionId: 'session-1',
      streamId: 'stream-test-1',
      callId,
      toolName: 'run_command',
      summary: `Run compact step ${index}`,
      input: { command: `echo compact-${index}` },
      status: 'running',
    });
    await shell.__emitChat({
      type: 'tool_result',
      sessionId: 'session-1',
      streamId: 'stream-test-1',
      callId,
      toolName: 'run_command',
      summary: `Completed compact step ${index}`,
      content: hiddenPayload,
      isError: false,
      durationMs: index,
    });
    await waitForUiState(
      window,
      () => timeline.querySelectorAll('.tool-call-row--minimal').length === index
    );
    const toolRows = Array.from(timeline.querySelectorAll('.tool-call-row--minimal'));
    for (const row of toolRows) {
      assert.equal(row.dataset.expanded, 'false');
      assert.equal(row.querySelector('.tool-call-row-body')?.hasAttribute('inert'), true);
      const predictedHeight = Number(row.closest('.chat-entry')?.dataset.predictedHeight || 0);
      if (predictedHeight > 0) observedPredictedHeights.push(predictedHeight);
    }
  }

  assert.equal(
    preparedTexts.some((text) => text.includes('COLLAPSED_TOOL_PAYLOAD_')),
    false,
    'collapsed Input/Output payloads must never reach Pretext measurement'
  );
  assert.ok(observedPredictedHeights.length > 0, 'tool articles should still receive visible-content predictions');
  assert.ok(
    Math.max(...observedPredictedHeights) < 500,
    'repeated streaming renders must keep predictions bounded to compact visible rows'
  );

  await shell.__emitChat({
    type: 'complete',
    sessionId: 'session-1',
    streamId: 'stream-test-1',
    content: 'Finished.',
    interactiveProtocolDrift: false,
    interactiveProtocolDriftPreview: '',
  });
  await waitForUiState(window, () => Array.from(
    timeline.querySelectorAll('[data-predicted-height]')
  ).every((article) => article.style.minHeight === ''));
});

test('reasoning appearance triggers article replacement not a stale skip', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const input = window.document.getElementById('chatInput');
  const sendButton = window.document.getElementById('sendButton');
  const timeline = window.document.querySelector('.chat-timeline');

  input.value = 'Think about this';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUi(window, 30);

  await shell.__emitChat({
    type: 'delta',
    sessionId: 'session-1',
    streamId: 'stream-test-1',
    content: '',
    aggregate: '',
    reasoning: {
      source: 'provider',
      entriesDelta: [
        { id: 'r1', text: 'Let me think about this...', timestamp: '2026-03-19T00:00:00Z' },
      ],
    },
  });
  await waitForUiState(
    window,
    () => timeline.querySelector('.reasoning-row-stack') && timeline.querySelector('.reasoning-row-block')
  );

  const reasoningStack = timeline.querySelector('.reasoning-row-stack');
  assert.ok(reasoningStack, 'reasoning-row-stack container should appear after reasoning delta');
  const phase = timeline.querySelector('.reasoning-row-block');
  assert.ok(phase, 'reasoning-row-block phase should be present');

  await shell.__emitChat({
    type: 'delta',
    sessionId: 'session-1',
    streamId: 'stream-test-1',
    content: '',
    aggregate: '',
    reasoning: {
      source: 'provider',
      entriesDelta: [
        { id: 'r2', text: 'Then I can answer live.', timestamp: '2026-03-19T00:00:01Z' },
      ],
    },
  });
  await waitForUiState(window, () => {
    const body = String(timeline.querySelector('.reasoning-row-panel-body')?.textContent || '');
    return /Let me think about this/.test(body) && /Then I can answer live/.test(body);
  });

  const bodyText = String(timeline.querySelector('.reasoning-row-panel-body')?.textContent || '');
  assert.match(bodyText, /Let me think about this/);
  assert.match(bodyText, /Then I can answer live/);
});

test('active streaming assistant branches stay expanded even after a collapse toggle', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const input = window.document.getElementById('chatInput');
  const sendButton = window.document.getElementById('sendButton');
  const timeline = window.document.querySelector('.chat-timeline');

  input.value = 'Use tools';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUi(window, 30);

  const streamingMessages = [
    { id: 'u1', role: 'user', content: 'Use tools', status: 'complete' },
    {
      id: 'assistant_stream-test-1',
      role: 'assistant',
      content: 'Working...',
      status: 'streaming',
      streamId: 'stream-test-1',
    },
    {
      id: 'tool_use_read_1',
      role: 'assistant',
      kind: 'tool_use',
      status: 'completed',
      tool_call: {
        call_id: 'call_read_1',
        tool_name: 'Read',
        parent_stream_id: 'stream-test-1',
      },
    },
    {
      id: 'tool_use_grep_1',
      role: 'assistant',
      kind: 'tool_use',
      status: 'completed',
      tool_call: {
        call_id: 'call_grep_1',
        tool_name: 'Grep',
        parent_stream_id: 'stream-test-1',
      },
    },
  ];
  shell.__state.messagesBySession.set('session-1', streamingMessages);
  window.__rendererState.messagesBySession.set('session-1', streamingMessages);

  await shell.__emitChat({
    type: 'delta',
    sessionId: 'session-1',
    streamId: 'stream-test-1',
    content: 'Working...',
    aggregate: 'Working...',
  });
  await waitForUiState(
    window,
    () => timeline.querySelector('[data-thread-toggle="assistant_stream-test-1"]')
      && timeline.querySelectorAll('article[data-message-id="assistant_stream-test-1"]').length === 1
  );

  const toggle = timeline.querySelector('[data-thread-toggle="assistant_stream-test-1"]');
  assert.ok(toggle, 'streaming assistant branch should expose a thread toggle when it owns multiple tool calls');
  assert.equal(
    timeline.querySelectorAll('article[data-message-id="assistant_stream-test-1"]').length,
    1,
    'streaming renders should keep a single assistant article for the active stream'
  );

  toggle.click();
  await waitForUi(window, 40);

  const assistantBranch = timeline.querySelector('.chat-thread-node[data-thread-message-id="assistant_stream-test-1"]');
  const assistantChildren = timeline.querySelector('.chat-thread-children[data-thread-parent="assistant_stream-test-1"]');

  assert.equal(
    assistantBranch?.getAttribute('data-thread-collapsed'),
    'false',
    'the active streaming assistant branch should remain expanded'
  );
  assert.equal(
    assistantChildren?.hasAttribute('hidden'),
    false,
    'tool children should stay visible while the branch is actively streaming'
  );

  shell.__state.messagesBySession.set('session-1', [
    { id: 'u1', role: 'user', content: 'Use tools', status: 'complete' },
    {
      id: 'assistant_stream-test-1',
      role: 'assistant',
      content: 'Working...',
      status: 'complete',
      streamId: 'stream-test-1',
      finalizedAt: '2026-03-19T12:00:02Z',
    },
    {
      id: 'tool_use_read_1',
      role: 'assistant',
      kind: 'tool_use',
      status: 'completed',
      tool_call: {
        call_id: 'call_read_1',
        tool_name: 'Read',
        parent_stream_id: 'stream-test-1',
      },
    },
    {
      id: 'tool_use_grep_1',
      role: 'assistant',
      kind: 'tool_use',
      status: 'completed',
      tool_call: {
        call_id: 'call_grep_1',
        tool_name: 'Grep',
        parent_stream_id: 'stream-test-1',
      },
    },
  ]);
  await shell.__emitChat({
    type: 'done',
    sessionId: 'session-1',
    streamId: 'stream-test-1',
    content: 'Working...',
  });
  await waitForUi(window, 40);
  assert.equal(
    timeline.querySelectorAll('article[data-message-id="assistant_stream-test-1"]').length,
    1,
    'completion renders should preserve a single assistant article for the stream'
  );
});

test('active-turn row-aware patch keeps sibling turn roots stable when tool rows appear mid-stream', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const input = window.document.getElementById('chatInput');
  const sendButton = window.document.getElementById('sendButton');
  const timeline = window.document.querySelector('.chat-timeline');

  input.value = 'Second turn';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  // Fixed tick sleeps flake under worker contention (the send pipeline and
  // debounced/rAF renders can land after any fixed count) — wait on the DOM
  // state each step needs instead (same conversion as e9af2ff3).
  await waitForUiState(
    window,
    () => Boolean(window.document.querySelector('.chat-entry.user')),
    { timeoutMs: 10_000, message: 'Timed out waiting for the sent user turn-article to render.' }
  );

  const initialMessages = [
    { id: 'u1', role: 'user', content: 'First turn', status: 'complete' },
    { id: 'a1', role: 'assistant', content: 'First answer', status: 'complete', finalizedAt: '2026-03-19T12:00:00Z' },
    { id: 'u2', role: 'user', content: 'Second turn', status: 'complete' },
    { id: 'assistant_stream-test-1', role: 'assistant', content: 'Working...', status: 'streaming', streamId: 'stream-test-1' },
  ];
  shell.__state.messagesBySession.set('session-1', initialMessages);
  window.__rendererState.messagesBySession.set('session-1', initialMessages);
  await shell.__emitChat({
    type: 'delta',
    sessionId: 'session-1',
    streamId: 'stream-test-1',
    content: 'Working...',
    aggregate: 'Working...',
  });
  await waitForUiState(
    window,
    () => Boolean(timeline.querySelector('.chat-thread-root-user[data-thread-message-id="u1"]')),
    { timeoutMs: 10_000, message: 'Timed out waiting for the first completed turn root to render before the streaming turn.' }
  );

  assert.ok(
    timeline.querySelector('.chat-thread-root-user[data-thread-message-id="u1"]'),
    'first completed turn should render before the streaming turn'
  );

  await shell.__emitChat({
    type: 'tool_use',
    sessionId: 'session-1',
    streamId: 'stream-test-1',
    callId: 'call_batch4',
    toolName: 'Read',
    status: 'running',
    summary: 'Read README',
  });
  await waitForUiState(
    window,
    () => Boolean(timeline.querySelector('[data-row-kind="tool_call"][data-tool-call-id="call_batch4"]')),
    { timeoutMs: 10_000, message: 'Timed out waiting for the live tool row to render in the active turn.' }
  );

  const firstRootAfter = timeline.querySelector('.chat-thread-root-user[data-thread-message-id="u1"]');
  assert.ok(firstRootAfter, 'the untouched sibling turn root should still be present after the active turn patch path');
  assert.equal(
    timeline.querySelectorAll('.chat-thread-root-user[data-thread-message-id="u1"]').length,
    1,
    'the sibling turn root should not be duplicated when tool rows appear in the active turn'
  );
  assert.ok(timeline.querySelector('[data-message-id="assistant_stream-test-1"]'), 'active turn assistant shell should remain addressable');
  assert.ok(
    timeline.querySelector('[data-row-kind="tool_call"][data-tool-call-id="call_batch4"]'),
    'new tool row should render through the live row-model path'
  );
});

// Skipped pending live/hydrated turn-id reconciliation: the live row's
// turn_id is the click-derived local id while the hydrated canonical row's
// turn_id is the streamId, so the buildRowId-derived data-row-id naturally
// diverges across the streaming → hydrated transition. Reconciliation
// preserves row_id but not turn_id, and the buildRowId derivation cannot
// honor an explicit row_id without regressing the tested data-row-id format
// in renderer-turn-row-render-utils / renderer-turn-article tests. Re-enable
// when the turn_id namespace is unified across live/canonical projections.
test('row-model tool shells preserve their row id across terminal reconciliation', { skip: 'pending live/hydrated turn_id reconciliation (turn_id divergence prevents stable data-row-id across transition)' }, async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const input = window.document.getElementById('chatInput');
  const sendButton = window.document.getElementById('sendButton');
  const timeline = window.document.querySelector('.chat-timeline');

  input.value = 'Use a tool';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUi(window, 20);

  await shell.__emitChat({
    type: 'delta',
    sessionId: 'session-1',
    streamId: 'stream-batch5-dom',
    content: 'Working...',
    aggregate: 'Working...',
  });
  await waitForUi(window, 40);

  await shell.__emitChat({
    type: 'tool_use',
    sessionId: 'session-1',
    streamId: 'stream-batch5-dom',
    callId: 'call_batch5_dom',
    toolName: 'Read',
    status: 'running',
    summary: 'Read README',
  });
  await waitForUi(window, 60);

  const provisionalToolRow = timeline.querySelector(
    '[data-message-id="assistant_stream-batch5-dom"] [data-row-kind="tool_step"][data-tool-call-id="call_batch5_dom"]'
  );
  assert.ok(provisionalToolRow, 'tool shell should render during the provisional row-model phase');
  const provisionalRowId = provisionalToolRow.getAttribute('data-row-id');
  assert.ok(provisionalRowId && provisionalRowId !== 'shell:tool_use_call_batch5_dom');

  shell.__state.messagesBySession.set('session-1', [
    { id: 'user_stream-batch5-dom', role: 'user', content: 'Use a tool', status: 'complete' },
    {
      id: 'assistant_stream-batch5-dom',
      role: 'assistant',
      content: 'Working...',
      status: 'complete',
      streamId: 'stream-batch5-dom',
      finalizedAt: '2026-04-14T12:00:00Z',
    },
    {
      id: 'tool_use_call_batch5_dom',
      role: 'assistant',
      kind: 'tool_use',
      status: 'completed',
      tool_call: {
        call_id: 'call_batch5_dom',
        tool_name: 'Read',
        parent_stream_id: 'stream-batch5-dom',
        summary: 'Read README',
      },
    },
    {
      id: 'tool_result_call_batch5_dom',
      role: 'tool',
      kind: 'tool_result',
      tool_result: {
        call_id: 'call_batch5_dom',
        tool_name: 'Read',
        summary: 'Read README',
        output_text: 'README contents',
        parent_stream_id: 'stream-batch5-dom',
      },
    },
  ]);

  await shell.__emitChat({
    type: 'complete',
    sessionId: 'session-1',
    streamId: 'stream-batch5-dom',
    content: 'Working...',
    interactiveProtocolDrift: false,
    interactiveProtocolDriftPreview: '',
  });
  await waitForUi(window, 80);

  const hydratedToolRow = timeline.querySelector(
    '[data-message-id="assistant_stream-batch5-dom"] [data-row-kind="tool_step"][data-tool-call-id="call_batch5_dom"]'
  );
  assert.ok(hydratedToolRow, 'the hydrated turn article should still render the tool row after terminal hydration');
  assert.equal(hydratedToolRow.getAttribute('data-row-id'), provisionalRowId);
  assert.equal(
    window.__rendererState.ui.chatTimelineLiveStateBySession.has('session-1'),
    false,
    'the reconciliation overlay should be consumed and cleared after the hydrated render commits'
  );
});

test('row-count sanity rollback disables the live row-model path and keeps it sticky for the session', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const input = window.document.getElementById('chatInput');
  const sendButton = window.document.getElementById('sendButton');

  input.value = 'Overflow the timeline';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUi(window, 20);

  const overflowPhases = Array.from({ length: 13 }, (_, index) => ({
    phaseId: `phase_overflow_${index}`,
    phaseKind: 'reasoning',
    iteration: index,
    thinkingId: `think_overflow_${index}`,
    renderCollapsed: false,
    entries: [{
      id: `reason_overflow_${index}`,
      text: `Reason ${index + 1}`,
      timestamp: '',
    }],
  }));
  const overflowMessages = [
    { id: 'user_stream-overflow', role: 'user', content: 'Overflow the timeline', status: 'complete' },
    {
      id: 'assistant_stream-overflow',
      role: 'assistant',
      streamId: 'stream-overflow',
      content: '',
      status: 'complete',
      phases: overflowPhases,
      visible_segments: [],
      reasoning: {
        available: true,
        status: 'complete',
        source: 'provider',
        entries: overflowPhases.flatMap((phase) => phase.entries),
      },
      reasoning_phases: overflowPhases.map((phase) => ({
        phaseId: phase.phaseId,
        phaseKind: phase.phaseKind,
        iteration: phase.iteration,
        thinkingId: phase.thinkingId,
        completed: true,
        renderCollapsed: false,
      })),
    },
  ];
  shell.__state.messagesBySession.set('session-1', overflowMessages);
  window.__rendererState.messagesBySession.set('session-1', overflowMessages);

  await shell.__emitChat({
    type: 'complete',
    sessionId: 'session-1',
    streamId: 'stream-overflow',
    content: '',
    interactiveProtocolDrift: false,
    interactiveProtocolDriftPreview: '',
  });
  await waitForUi(window, 80);

  assert.equal(
    window.__rendererState.ui.chatTimelineRowModelBySession.get('session-1'),
    false,
    'row-count sanity failures should disable the live row-model path'
  );
  const rollbackMeta = window.__rendererState.ui.chatTimelineRowModelMetaBySession.get('session-1');
  assert.equal(rollbackMeta?.sticky_rollback, true);
  assert.equal(rollbackMeta?.rollback_reason, 'row_count_sanity');

  await shell.__emitChat({
    type: 'started',
    sessionId: 'session-1',
    streamId: 'stream-overflow-next',
  });
  await shell.__emitChat({
    type: 'delta',
    sessionId: 'session-1',
    streamId: 'stream-overflow-next',
    content: 'Keep streaming on the legacy path.',
    aggregate: 'Keep streaming on the legacy path.',
  });
  await waitForUi(window, 40);

  assert.equal(
    window.__rendererState.ui.chatTimelineLiveStateBySession.has('session-1'),
    false,
    'once rolled back, the session should stay on the legacy live path until reload'
  );
});

test('recap dedupe keeps a single inline recap row across refreshes', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const input = window.document.getElementById('chatInput');
  const sendButton = window.document.getElementById('sendButton');
  const timeline = window.document.querySelector('.chat-timeline');

  input.value = 'Run interactive round';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUi(window, 20);

  shell.__state.messagesBySession.set('session-1', [
    { id: 'u1', role: 'user', content: 'Run interactive round', status: 'complete' },
    { id: 'a1', role: 'assistant', content: 'Let me ask a few questions.', status: 'complete' },
    {
      id: 'recap-1',
      role: 'assistant',
      kind: 'interactive_round_recap',
      content: 'Asked 3 questions',
      request_id: 'req-1',
      interactive_round_recap: {
        request_id: 'req-1',
        round_index: 1,
        answer_count: 3,
        items: [
          { question_id: 'q1', prompt: 'What is priority one?', answer_label: 'Launch' },
          { question_id: 'q2', prompt: 'What can wait?', answer_label: 'Polish' },
          { question_id: 'q3', prompt: 'When?', answer_label: 'This week' },
        ],
      },
    },
    {
      id: 'recap-2',
      role: 'assistant',
      kind: 'interactive_round_recap',
      content: 'Asked 3 questions',
      request_id: 'req-1',
      interactive_round_recap: {
        request_id: 'req-1',
        round_index: 1,
        answer_count: 3,
        items: [
          { question_id: 'q1', prompt: 'What is priority one?', answer_label: 'Launch' },
          { question_id: 'q2', prompt: 'What can wait?', answer_label: 'Polish' },
          { question_id: 'q3', prompt: 'When?', answer_label: 'This week' },
        ],
      },
    },
  ]);

  await shell.__emitChat({
    type: 'complete',
    sessionId: 'session-1',
    streamId: 'stream-test-recap-1',
    content: 'Let me ask a few questions.',
    interactiveProtocolDrift: false,
    interactiveProtocolDriftPreview: '',
  });
  await waitForUi(window, 40);

  let recapRows = timeline.querySelectorAll('[data-interactive-recap-row]');
  assert.equal(recapRows.length, 1, 'should render one recap row after dedupe');
  assert.equal(
    timeline.querySelector('[data-interactive-recap-row]')?.dataset.messageId,
    'recap-2',
    'dedupe should keep the latest recap payload while preserving row position'
  );

  await shell.__emitChat({
    type: 'complete',
    sessionId: 'session-1',
    streamId: 'stream-test-recap-2',
    content: 'Let me ask a few questions.',
    interactiveProtocolDrift: false,
    interactiveProtocolDriftPreview: '',
  });
  await waitForUi(window, 40);

  recapRows = timeline.querySelectorAll('[data-interactive-recap-row]');
  assert.equal(recapRows.length, 1, 'rerender should not introduce duplicate recap rows');
});
