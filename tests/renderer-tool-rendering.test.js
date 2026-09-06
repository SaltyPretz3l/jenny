const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');
const toolShellUtils = require('../renderer/chat/renderer-tool-shell-utils');
const transcriptUtils = require('../renderer/chat/renderer-transcript-utils');
const toolCallUtils = require('../renderer/chat/tool-call-utils');
const { escapeHtml } = require('../renderer/shared/string-utils');
const { createTranscriptToolCallRenderer } = require('../renderer/chat/renderer-transcript-tool-calls');
const { createTurnRowToolRenderUtils } = require('../renderer/chat/renderer-turn-row-tool-render-utils');
const turnElapsedClockUtils = require('../renderer/chat/renderer-turn-elapsed-clock');
const badge = require('../renderer/inventory/badge');
const spinner = require('../renderer/inventory/spinner');
const Collapsible = require('../renderer/inventory/collapsible');
const CodeBlock = require('../renderer/inventory/codeblock');

async function loadRendererTestApp(t, options) {
  const app = await loadRendererApp(options);
  t.after(async () => {
    await app.dispose();
  });
  return app;
}

function createToolSessionStartStream(sessionId, title) {
  return async function startStream(payload, { state }) {
    state.sessions = [{
      id: sessionId,
      title,
      conversation_mode: payload.conversationMode || 'chat',
      preferred_model: payload.preferredModel || 'gpt-test',
      reasoning_effort: payload.reasoningEffort || 'default',
      interactive_round_count: 0,
      interactive_sequence_state: 'idle',
      pending_question_batch: null,
      updated_at: new Date().toISOString(),
    }];
    state.messagesBySession.set(sessionId, []);
    return { sessionId, streamId: `stream-${sessionId}` };
  };
}

async function submitPrompt(window, promptText) {
  const input = window.document.getElementById('chatInput');
  const sendButton = window.document.getElementById('sendButton');
  input.value = promptText;
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUi(window, 20);
}

function renderToolCall(message, messages = [message]) {
  return createTranscriptToolCallRenderer({ escapeHtml, toolCallUtils })
    .renderToolCallBlock(message, messages, {});
}

test('running write row names its target, shows elapsed time, and flips to settled', () => {
  const toolUse = {
    id: 'tool-use-write-composing',
    role: 'assistant',
    kind: 'tool_use',
    tool_call: {
      call_id: 'call-write-composing',
      tool_name: 'write_file',
      input: { path: 'docs/releases/notes.md', content: '# Notes' },
      status: 'running',
      running_started_at_ms: Date.now() - 7000,
    },
  };
  const runningMarkup = renderToolCall(toolUse);

  assert.match(runningMarkup, /class="tool-call-block tool-call-file-operation tool-call-file-composing"/);
  assert.doesNotMatch(runningMarkup, /tool-call-file-settled/);
  assert.match(runningMarkup, /class="tool-call-file-icon"[^>]*><svg/);
  assert.match(runningMarkup, /class="tool-call-summary tool-call-file-target" title="docs\/releases\/notes\.md">notes\.md<\/span>/);
  assert.match(runningMarkup, /data-turn-elapsed="true"/);
  assert.match(runningMarkup, /data-elapsed-started-at="\d+"/);
  assert.match(runningMarkup, />0:0[67]<\/span>/);

  const toolResult = {
    id: 'tool-result-write-composing',
    role: 'tool',
    kind: 'tool_result',
    tool_result: {
      call_id: 'call-write-composing',
      tool_name: 'write_file',
      output_text: 'Successfully wrote to "docs/releases/notes.md".',
      duration_ms: 1200,
      is_error: false,
    },
  };
  const settledMarkup = renderToolCall(toolUse, [toolUse, toolResult]);
  assert.match(settledMarkup, /class="tool-call-block tool-call-file-operation tool-call-file-settled"/);
  assert.doesNotMatch(settledMarkup, /tool-call-file-composing/);
  assert.doesNotMatch(settledMarkup, /data-turn-elapsed/);
});

test('cancelled edit row leaves no composing elapsed ticker target', () => {
  const toolUse = {
    id: 'tool-use-edit-cancelled',
    role: 'assistant',
    kind: 'tool_use',
    tool_call: {
      call_id: 'call-edit-cancelled',
      tool_name: 'edit_file',
      input: { file_path: 'docs/releases/notes.md', old_string: 'old', new_string: 'new' },
      status: 'running',
      running_started_at_ms: Date.now() - 7000,
    },
  };
  const runningMarkup = renderToolCall(toolUse);
  assert.match(runningMarkup, /tool-call-file-composing/);
  assert.match(runningMarkup, /data-turn-elapsed="true"/);

  toolUse.tool_call.status = 'cancelled';
  const cancelledMarkup = renderToolCall(toolUse);
  assert.match(cancelledMarkup, /tool-call-file-settled/);
  assert.doesNotMatch(cancelledMarkup, /tool-call-file-composing/);
  assert.doesNotMatch(cancelledMarkup, /data-turn-elapsed/);
});

test('live cancellation patch settles an edit row and stops its shared elapsed clock', async (t) => {
  const sessionId = 'session-edit-result-live';
  const streamId = `stream-${sessionId}`;
  let timelineClock = null;
  const app = await loadRendererTestApp(t, {
    windowGlobals: {
      rendererTurnElapsedClock: {
        ...turnElapsedClockUtils,
        createTurnElapsedClock(options) {
          const clock = turnElapsedClockUtils.createTurnElapsedClock(options);
          if (options.getRoot()?.id === 'chatTimeline') timelineClock = clock;
          return clock;
        },
      },
    },
    shell: { chat: { startStream: createToolSessionStartStream(sessionId, 'Live Edit Result') } },
  });
  const { window, shell } = app;
  await submitPrompt(window, 'Edit then settle');
  await shell.__emitChat({ type: 'started', sessionId, streamId });
  const payload = {
    type: 'tool_use', sessionId, streamId, callId: 'call-edit-result-live',
    toolName: 'edit_file', summary: 'edit_file src/chat/editor.js',
    input: { file_path: 'src/chat/editor.js', old_string: 'old', new_string: 'new' },
  };

  await shell.__emitChat({ ...payload, status: 'running' });
  await waitForUi(window, 30);
  const hostRow = window.document.querySelector('.chat-row[data-tool-call-id="call-edit-result-live"]');
  hostRow.innerHTML = renderToolCall({
    id: 'tool-use-edit-result-live', role: 'assistant', kind: 'tool_use',
    tool_call: {
      call_id: 'call-edit-result-live', tool_name: 'edit_file', input: payload.input,
      status: 'running', running_started_at_ms: Date.now() - 7000,
    },
  });
  timelineClock.sync();
  const runningBlock = hostRow.querySelector('.tool-call-block[data-call-id="call-edit-result-live"]');
  assert.equal(runningBlock.classList.contains('tool-call-file-composing'), true);
  assert.equal(runningBlock.querySelector('[data-turn-elapsed]') !== null, true);
  assert.equal(timelineClock.isRunning(), true);

  await shell.__emitChat({ ...payload, status: 'cancelled' });
  await waitForUi(window, 30);
  const settledBlock = window.document.querySelector('.tool-call-block[data-call-id="call-edit-result-live"]');
  assert.equal(settledBlock, runningBlock, 'live patch preserves the rendered row node');
  assert.equal(settledBlock.querySelector('[data-turn-elapsed]'), null);
  assert.equal(settledBlock.classList.contains('tool-call-file-composing'), false);
  assert.equal(settledBlock.classList.contains('tool-call-file-settled'), true);
  assert.equal(timelineClock.isRunning(), false);

  hostRow.innerHTML = renderToolCall({
    id: 'tool-use-edit-dispose', role: 'assistant', kind: 'tool_use',
    tool_call: { call_id: 'call-edit-dispose', tool_name: 'edit_file', input: payload.input,
      status: 'running', running_started_at_ms: Date.now() - 1000 },
  });
  timelineClock.sync();
  assert.equal(timelineClock.isRunning(), true);
  await app.dispose();
  assert.equal(timelineClock.isRunning(), false);
});

test('edit and move running rows use file-operation target and icon treatment', () => {
  const cases = [
    {
      callId: 'call-edit-composing',
      toolName: 'edit_file',
      input: { file_path: 'src/chat/editor.js', old_string: 'old', new_string: 'new' },
      target: 'src/chat/editor.js',
      basename: 'editor.js',
    },
    {
      callId: 'call-move-composing',
      toolName: 'move_file',
      input: { source: 'drafts/notes.md', destination: 'docs/releases/notes.md' },
      target: 'docs/releases/notes.md',
      basename: 'notes.md',
    },
  ];

  for (const entry of cases) {
    const markup = renderToolCall({
      id: `tool-use-${entry.callId}`,
      role: 'assistant',
      kind: 'tool_use',
      tool_call: {
        call_id: entry.callId,
        tool_name: entry.toolName,
        input: entry.input,
        status: 'running',
        running_started_at_ms: Date.now() - 1000,
      },
    });
    assert.match(markup, /tool-call-file-composing/);
    assert.match(markup, /class="tool-call-file-icon"[^>]*><svg/);
    assert.match(markup, new RegExp(`title="${entry.target.replaceAll('.', '\\.')}"[^>]*>${entry.basename.replaceAll('.', '\\.')}<\\/span>`));
  }
});

test('activity-lane write_file row carries the shared file-operation element and icon', () => {
  const renderer = createTurnRowToolRenderUtils({ escapeHtml, getNow: () => 10_000 });
  const markup = renderer.buildToolCallRowMarkup({
    row_id: 'row-write-activity',
    turn_id: 'turn-write-activity',
    primary_message_id: 'message-write-activity',
    payload: {
      tool_call_id: 'call-write-activity',
      tool_name: 'write_file',
      input: { path: 'docs/activity.md', content: 'hello' },
      state: 'running',
      running_started_at_ms: 5_000,
    },
  }, [], { sessionId: 'session-write-activity' });

  assert.match(markup, /class="tool-call-row tool-call-row--minimal tool-call-file-operation tool-call-file-composing"/);
  assert.match(markup, /class="tool-call-file-icon"[^>]*><svg/);
});

function ensureFrameWindow(iframe) {
  if (iframe.contentWindow) {
    return iframe.contentWindow;
  }
  const stubWindow = { postMessage() {} };
  Object.defineProperty(iframe, 'contentWindow', {
    configurable: true,
    value: stubWindow,
  });
  return stubWindow;
}

async function resolveMermaidFrame(window, selector, options = {}) {
  const iframe = typeof selector === 'string' ? window.document.querySelector(selector) : selector;
  assert.ok(iframe, 'expected Mermaid preview iframe');
  const frameWindow = ensureFrameWindow(iframe);
  const postedMessages = [];
  frameWindow.postMessage = (payload) => {
    postedMessages.push(payload);
  };

  iframe.dispatchEvent(new window.Event('load'));
  await waitForUi(window, 10);

  assert.equal(postedMessages.length, 1, 'expected a render request to be posted into the frame');
  window.dispatchEvent(new window.MessageEvent('message', {
    source: frameWindow,
    origin: window.location.origin,
    data: {
      type: 'rendered',
      requestId: postedMessages[0].requestId,
      ok: options.ok !== false,
      height: options.height || 180,
      error: options.error,
    },
  }));
  await waitForUi(window, 20);
  return { iframe, requestId: postedMessages[0].requestId };
}

test('renderer renders sidecar write_file diffs with alias display, enriched summary, and escaped diff content', async (t) => {
  const sessionId = 'session-write-diff';
  const streamId = `stream-${sessionId}`;
  const { window, shell } = await loadRendererTestApp(t, {
    shell: {
      chat: {
        startStream: createToolSessionStartStream(sessionId, 'Write Diff Session'),
      },
    },
  });

  await submitPrompt(window, 'Write a note');

  await shell.__emitChat({
    type: 'tool_use',
    sessionId,
    streamId,
    callId: 'call-write-1',
    toolName: 'write_file',
    summary: 'write_file notes.md',
    input: { path: 'notes.md', content: 'const value = "safe"' },
    status: 'running',
  });
  await shell.__emitChat({
    type: 'tool_result',
    sessionId,
    streamId,
    callId: 'call-write-1',
    toolName: 'write_file',
    input: { path: 'notes.md', content: 'const value = "safe"' },
    summary: 'write_file notes.md',
    content: 'Successfully wrote to "notes.md".',
    isError: false,
    approvalState: 'auto',
    durationMs: 8,
    metadata: {
      diff: {
        additions: 1,
        deletions: 1,
        truncated: false,
        hunks: [{
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: [
            '-const value = "<script>alert(1)</script>"',
            '\\ No newline at end of file',
            '+const value = "safe"',
          ],
        }],
      },
    },
  });
  await waitForUi(window, 30);

  const block = window.document.querySelector('[data-call-id="call-write-1"]');
  const header = block.querySelector('.tool-call-header');
  const name = block.querySelector('.tool-call-name');
  const summary = block.querySelector('.tool-call-summary');
  const details = block.querySelector('.tool-call-details');

  assert.equal(name.textContent.trim(), 'Write');
  assert.match(summary.textContent, /Write notes\.md \+1 \/ -1/);
  assert.equal(header.getAttribute('aria-expanded'), 'false');
  assert.equal(details.hidden, true);

  header.click();
  await waitForUi(window, 20);

  const expandedDetails = window.document.getElementById(header.getAttribute('aria-controls'));

  // A user-expanded file tool materializes its nested diff before the outer
  // disclosure measures its final height, avoiding a second layout jump.
  const fileDiff = expandedDetails.querySelector('.file-diff');
  assert.ok(fileDiff, 'the write_file diff renders a per-file diff shell');
  assert.equal(fileDiff.getAttribute('data-expanded'), 'true', 'the diff opens with its parent tool row');
  assert.ok(fileDiff.querySelector('[data-file-diff-materialized] .diff-line'));
  assert.equal(fileDiff.querySelector('[data-file-diff-pending]'), null);

  // The nested control remains independent once the user has made a choice.
  fileDiff.querySelector('[data-file-diff-toggle]').click();
  await waitForUi(window, 20);
  assert.equal(fileDiff.getAttribute('data-expanded'), 'false', 'the per-file toggle collapses the diff');
  header.click();
  await waitForUi(window, 20);
  header.click();
  await waitForUi(window, 20);
  assert.equal(fileDiff.getAttribute('data-expanded'), 'false', 'the explicit nested choice survives parent toggles');

  fileDiff.querySelector('[data-file-diff-toggle]').click();
  await waitForUi(window, 20);

  assert.match(expandedDetails.textContent, /\\ No newline at end of file/);
  assert.match(expandedDetails.textContent, /<script>alert\(1\)<\/script>/);
  assert.equal(expandedDetails.querySelector('script'), null);
  assert.equal(expandedDetails.querySelector('.diff-line-remove .diff-gutter').textContent.trim(), '1');
  assert.equal(expandedDetails.querySelector('.diff-line-add .diff-gutter').textContent.trim(), '1');
});

test('tool-call utils humanize create_artifact and expose success status wording', () => {
  assert.equal(toolCallUtils.getToolDisplayName('create_artifact'), 'Create Artifact');
  assert.equal(toolCallUtils.getStatusLabel('completed'), 'Success');
});

test('renderer renders run_command with empty output fallback and exit badge', async (t) => {
  const sessionId = 'session-bash-empty';
  const streamId = `stream-${sessionId}`;
  const { window, shell } = await loadRendererTestApp(t, {
    shell: {
      chat: {
        startStream: createToolSessionStartStream(sessionId, 'Bash Empty Session'),
      },
    },
  });

  await submitPrompt(window, 'Run a command');

  await shell.__emitChat({
    type: 'tool_use',
    sessionId,
    streamId,
    callId: 'call-bash-empty',
    toolName: 'run_command',
    summary: 'run_command node -e ""',
    input: { command: 'node -e ""' },
    status: 'running',
  });
  await shell.__emitChat({
    type: 'tool_result',
    sessionId,
    streamId,
    callId: 'call-bash-empty',
    toolName: 'run_command',
    input: { command: 'node -e ""' },
    summary: 'run_command node -e ""',
    content: '(no output)',
    isError: false,
    approvalState: 'auto',
    durationMs: 5,
    metadata: { exitCode: 0 },
  });
  await waitForUi(window, 20);

  const block = window.document.querySelector('[data-call-id="call-bash-empty"]');
  const header = block.querySelector('.tool-call-header');
  const details = block.querySelector('.tool-call-details');
  assert.equal(block.querySelector('.tool-call-name').textContent.trim(), 'Bash');
  assert.match(block.querySelector('.tool-call-summary').textContent, /exit 0/);
  assert.equal(header.getAttribute('aria-expanded'), 'false');
  assert.equal(details.hidden, true);

  header.click();
  await waitForUi(window, 20);

  const expandedDetails = window.document.getElementById(header.getAttribute('aria-controls'));
  assert.match(expandedDetails.textContent, /\(no output\)/);
  assert.match(expandedDetails.textContent, /exit 0/);
});

test('renderer auto-expands pending approval and denied tool rows', async (t) => {
  const sessionId = 'session-tool-auto-expand';
  const streamId = `stream-${sessionId}`;
  // chat_tool_trace_rows_fix (Ht-E): the settled/unsettled per-call partition
  // this test codifies is flag-gated while it soaks; the OFF path is pinned
  // by the sibling "keeps the legacy block ... when the trace-rows fix is
  // off" test below.
  const { window, shell } = await loadRendererTestApp(t, {
    shell: {
      chat: {
        startStream: createToolSessionStartStream(sessionId, 'Tool Auto Expand Session'),
      },
      features: {
        state: {
          featureFlags: {
            chat_tool_trace_rows_fix: true,
          },
        },
      },
    },
  });

  await submitPrompt(window, 'Use a gated tool');

  await shell.__emitChat({
    type: 'tool_use',
    sessionId,
    streamId,
    callId: 'call-pending-1',
    toolName: 'run_command',
    summary: 'run_command dangerous-op',
    input: { command: 'dangerous-op' },
    status: 'pending_approval',
  });
  await shell.__emitChat({
    type: 'tool_use',
    sessionId,
    streamId,
    callId: 'call-denied-1',
    toolName: 'run_command',
    summary: 'run_command denied-op',
    input: { command: 'denied-op' },
    status: 'completed',
  });
  await shell.__emitChat({
    type: 'tool_result',
    sessionId,
    streamId,
    callId: 'call-denied-1',
    toolName: 'run_command',
    input: { command: 'denied-op' },
    summary: 'run_command denied-op',
    content: 'Denied by user.',
    isError: false,
    approvalState: 'denied',
    durationMs: 2,
    metadata: {},
  });
  await waitForUi(window, 30);

  // The still-pending (unsettled, mid-stream) approval row is owned by the live
  // reducer, which keeps rendering the classic auto-expanded tool-call-block with
  // its inline approval affordance.
  const pendingHeader = window.document.querySelector('[data-call-id="call-pending-1"] .tool-call-header');
  const pendingBlock = window.document.querySelector('[data-call-id="call-pending-1"]');
  const pendingDetails = pendingBlock.querySelector('.tool-call-details');

  assert.equal(pendingBlock.getAttribute('data-tool-status'), 'awaiting_approval');
  assert.equal(pendingHeader.getAttribute('aria-expanded'), 'true');
  assert.equal(pendingDetails.hidden, false);
  assert.match(pendingBlock.textContent, /Allow|Always allow/);

  // The denied call has settled, so trace re-projection owns it: a single
  // tool-call-row whose canonical visible state is denied, surfaced via the
  // status badge. Trace coalesces a denied call into the call row alone (no
  // tool_result row, no aria-expanded disclosure), so the denied state itself
  // is the visible distinction rather than the old "Denied by user" result text.
  const deniedRow = window.document.querySelector('.tool-call-row[data-tool-call-id="call-denied-1"]');
  assert.ok(deniedRow, 'denied tool should render as a trace tool-call-row');
  assert.equal(deniedRow.getAttribute('data-tool-status'), 'denied');
  assert.match(deniedRow.querySelector('.tool-call-status-label').textContent, /Denied/);
  assert.equal(window.document.querySelectorAll('.tool-call-row[data-tool-call-id="call-denied-1"]').length, 1);
});

test('renderer keeps the legacy block for a settled denied tool when the trace-rows fix is off', async (t) => {
  // OFF-path pin for chat_tool_trace_rows_fix (rollback path — flag is
  // default-ON since 2026-07-01, so this test forces it off explicitly):
  // the EXACT mixed-turn input the flag-ON test above drives (pending
  // approval + settled denied) must stay on the legacy .tool-call-block
  // path for BOTH calls whenever the flag is rolled back via env.
  const sessionId = 'session-tool-trace-fix-off';
  const streamId = `stream-${sessionId}`;
  const { window, shell } = await loadRendererTestApp(t, {
    shell: {
      chat: {
        startStream: createToolSessionStartStream(sessionId, 'Trace Fix Off Session'),
      },
      features: {
        state: {
          featureFlags: {
            chat_tool_trace_rows_fix: false,
          },
        },
      },
    },
  });

  await submitPrompt(window, 'Use a gated tool');

  await shell.__emitChat({
    type: 'tool_use',
    sessionId,
    streamId,
    callId: 'call-pending-off',
    toolName: 'run_command',
    summary: 'run_command dangerous-op',
    input: { command: 'dangerous-op' },
    status: 'pending_approval',
  });
  await shell.__emitChat({
    type: 'tool_use',
    sessionId,
    streamId,
    callId: 'call-denied-off',
    toolName: 'run_command',
    summary: 'run_command denied-op',
    input: { command: 'denied-op' },
    status: 'completed',
  });
  await shell.__emitChat({
    type: 'tool_result',
    sessionId,
    streamId,
    callId: 'call-denied-off',
    toolName: 'run_command',
    input: { command: 'denied-op' },
    summary: 'run_command denied-op',
    content: 'Denied by user.',
    isError: false,
    approvalState: 'denied',
    durationMs: 2,
    metadata: {},
  });
  await waitForUi(window, 30);

  const pendingBlock = window.document.querySelector('[data-call-id="call-pending-off"]');
  assert.ok(pendingBlock, 'flag off: the pending call keeps its classic approval block');
  assert.equal(pendingBlock.getAttribute('data-tool-status'), 'awaiting_approval');
  assert.match(pendingBlock.textContent, /Allow|Always allow/);

  const legacyBlock = window.document.querySelector('[data-call-id="call-denied-off"]');
  assert.ok(legacyBlock, 'flag off: the settled denied call stays on the legacy block path');
  assert.equal(legacyBlock.getAttribute('data-tool-status'), 'denied');
  assert.equal(
    window.document.querySelector('.tool-call-row[data-tool-call-id="call-denied-off"]'),
    null,
    'flag off: no trace tool-call-row is emitted for the settled call'
  );
  assert.equal(
    window.document.querySelector('.tool-call-row[data-tool-call-id="call-pending-off"]'),
    null,
    'flag off: no trace tool-call-row is emitted for the pending call'
  );
});

test('renderer keeps approved tool rows visibly distinguished when a later assistant continuation shows no result was recorded', async (t) => {
  const sessionId = 'session-tool-approved-gap';
  const streamId = `stream-${sessionId}`;
  const { window, shell } = await loadRendererTestApp(t, {
    shell: {
      chat: {
        startStream: createToolSessionStartStream(sessionId, 'Approved Gap Session'),
      },
    },
  });

  await submitPrompt(window, 'Try that again');

  shell.__state.messagesBySession.set(sessionId, [
    {
      id: 'user_approved_gap',
      role: 'user',
      content: 'Try that again',
      status: 'complete',
    },
    {
      id: 'tool_use_approved_gap',
      role: 'assistant',
      kind: 'tool_use',
      status: 'complete',
      tool_call: {
        call_id: 'call-approved-gap',
        tool_name: 'Write',
        parent_stream_id: streamId,
        summary: 'Write todo-list.md',
        input: { path: 'todo-list.md' },
        input_json: '{"path":"todo-list.md"}',
        status: 'approved',
        approval_state: 'approved',
      },
    },
    {
      id: 'assistant_after_approved_gap',
      role: 'assistant',
      streamId,
      content: 'That path did not finish, so I am continuing another way.',
      status: 'complete',
    },
  ]);

  await shell.__emitChat({
    type: 'complete',
    sessionId,
    streamId,
    content: 'That path did not finish, so I am continuing another way.',
    interactiveProtocolDrift: false,
    interactiveProtocolDriftPreview: '',
  });
  await waitForUi(window, 30);

  // Trace has no 'abandoned' state. An approved tool whose result never arrived
  // settles to the canonical 'approved' visible state on its trace tool-call-row,
  // so it stays visibly distinguished (a definite "Approved" badge) rather than
  // stuck on the live "Queued to run" placeholder. The later assistant
  // continuation renders as its own sibling row, not inside this tool block.
  const row = window.document.querySelector('.tool-call-row[data-tool-call-id="call-approved-gap"]');
  assert.ok(row, 'approved tool should render as a trace tool-call-row');
  assert.equal(row.getAttribute('data-tool-status'), 'approved');
  assert.match(row.querySelector('.tool-call-status-label').textContent, /Approved/);
  assert.equal(window.document.querySelectorAll('.tool-call-row[data-tool-call-id="call-approved-gap"]').length, 1);
  assert.doesNotMatch(row.textContent || '', /Queued to run/);
});

test('renderer hydrates interrupted and timed out tool rows with canonical statuses', async (t) => {
  const sessionId = 'session-tool-row-statuses';
  const streamId = `stream-${sessionId}`;
  const { window, shell } = await loadRendererTestApp(t, {
    shell: {
      chat: {
        startStream: createToolSessionStartStream(sessionId, 'Tool Row Status Session'),
      },
    },
  });

  await submitPrompt(window, 'Inspect tool row states');

  shell.__state.messagesBySession.set(sessionId, [
    {
      id: 'user_status_row',
      role: 'user',
      content: 'Inspect tool row states',
      status: 'complete',
    },
    {
      id: 'tool_use_interrupted',
      role: 'assistant',
      kind: 'tool_use',
      status: 'complete',
      tool_call: {
        call_id: 'call-interrupted',
        tool_name: 'Read',
        parent_stream_id: streamId,
        summary: 'Read notes.md',
        input: { path: 'notes.md' },
        input_json: '{"path":"notes.md"}',
        status: 'running',
        approval_state: 'approved',
      },
    },
    {
      id: 'tool_use_timed_out',
      role: 'assistant',
      kind: 'tool_use',
      status: 'complete',
      tool_call: {
        call_id: 'call-timed-out',
        tool_name: 'run_command',
        parent_stream_id: streamId,
        summary: 'run_command npm test',
        input: { command: 'npm test' },
        input_json: '{"command":"npm test"}',
        status: 'timed_out',
        approval_state: 'timed_out',
      },
    },
    {
      id: 'tool_use_invalid_args',
      role: 'assistant',
      kind: 'tool_use',
      status: 'complete',
      tool_call: {
        call_id: 'call-invalid-args',
        tool_name: 'Write',
        parent_stream_id: streamId,
        summary: 'Write notes.md',
        input: { path: 'notes.md' },
        input_json: '{"path":"notes.md"}',
        status: 'completed',
      },
    },
    {
      id: 'tool_result_invalid_args',
      role: 'assistant',
      kind: 'tool_result',
      status: 'complete',
      tool_result: {
        call_id: 'call-invalid-args',
        tool_name: 'Write',
        output_text: 'Invalid arguments.',
        summary: 'Invalid arguments.',
        is_error: true,
        error_code: 'CMP-TOOLS-0001',
        parent_stream_id: streamId,
        metadata: {},
      },
    },
  ]);

  await shell.__emitChat({
    type: 'complete',
    sessionId,
    streamId,
    content: '',
    interactiveProtocolDrift: false,
    interactiveProtocolDriftPreview: '',
  });
  await waitForUi(window, 30);

  // Trace renders each hydrated tool as its own tool-call-row. The result event
  // is threaded into the call row for state derivation, so a tool that errored
  // reconciles to the canonical 'errored' status on the call row itself — this
  // hydration shape emits no standalone tool_result row / error banner.
  const interruptedRow = window.document.querySelector('.tool-call-row[data-tool-call-id="call-interrupted"]');
  const timedOutRow = window.document.querySelector('.tool-call-row[data-tool-call-id="call-timed-out"]');
  const erroredRow = window.document.querySelector('.tool-call-row[data-tool-call-id="call-invalid-args"]');

  assert.ok(interruptedRow, 'interrupted tool should render a trace tool-call-row');
  assert.ok(timedOutRow, 'timed out tool should render a trace tool-call-row');
  assert.ok(erroredRow, 'errored tool should render a trace tool-call-row');

  assert.equal(interruptedRow.getAttribute('data-tool-status'), 'interrupted');
  assert.equal(timedOutRow.getAttribute('data-tool-status'), 'timed_out');
  assert.equal(erroredRow.getAttribute('data-tool-status'), 'errored');
  // The errored tool is visibly distinguished via its status badge (canonical
  // label set: 'Error', never the retired 'Errored').
  assert.match(erroredRow.querySelector('.tool-call-status-label').textContent, /^Error$/);
  // Hydrated interrupted/timed_out/errored tools must not duplicate the
  // tool-call-row markup for the same call_id when a reload lands mid-turn.
  assert.equal(window.document.querySelectorAll('.tool-call-row[data-tool-call-id="call-interrupted"]').length, 1);
  assert.equal(window.document.querySelectorAll('.tool-call-row[data-tool-call-id="call-timed-out"]').length, 1);
  assert.equal(window.document.querySelectorAll('.tool-call-row[data-tool-call-id="call-invalid-args"]').length, 1);
});

test('renderer cancelled and preempted tool rows share visible cancelled status while preserving raw substatus', async (t) => {
  // Phase 5A recovery audit: backend persists 'cancelled' on user-driven aborts
  // and 'preempted' when a follow-up turn supersedes an in-flight tool. The
  // Phase 2 terminology lock requires both to render with the cancelled visible
  // status while the raw substatus stays inspectable in canonical data.
  const sessionId = 'session-tool-cancelled-preempted';
  const streamId = `stream-${sessionId}`;
  const { window, shell } = await loadRendererTestApp(t, {
    shell: {
      chat: {
        startStream: createToolSessionStartStream(sessionId, 'Cancelled Tool Session'),
      },
    },
  });

  await submitPrompt(window, 'Cancel and preempt tools mid-flight');

  shell.__state.messagesBySession.set(sessionId, [
    {
      id: 'user_cancel_row',
      role: 'user',
      content: 'Cancel and preempt tools mid-flight',
      status: 'complete',
    },
    {
      id: 'tool_use_cancelled',
      role: 'assistant',
      kind: 'tool_use',
      status: 'complete',
      tool_call: {
        call_id: 'call-cancelled',
        tool_name: 'run_command',
        parent_stream_id: streamId,
        summary: 'run_command sleep 30',
        input: { command: 'sleep 30' },
        input_json: '{"command":"sleep 30"}',
        status: 'cancelled',
        approval_state: 'cancelled',
      },
    },
    {
      id: 'tool_use_preempted',
      role: 'assistant',
      kind: 'tool_use',
      status: 'complete',
      tool_call: {
        call_id: 'call-preempted',
        tool_name: 'Read',
        parent_stream_id: streamId,
        summary: 'Read notes.md',
        input: { path: 'notes.md' },
        input_json: '{"path":"notes.md"}',
        status: 'preempted',
        approval_state: 'preempted',
      },
    },
  ]);

  await shell.__emitChat({
    type: 'complete',
    sessionId,
    streamId,
    content: '',
    interactiveProtocolDrift: false,
    interactiveProtocolDriftPreview: '',
  });
  await waitForUi(window, 30);

  // Trace renders both as tool-call-rows. The Phase 2 terminology lock + canonical
  // view-model enrichment collapse the raw 'preempted' substatus into the
  // 'cancelled' visible status, so both rows expose data-tool-status="cancelled".
  const cancelledRow = window.document.querySelector('.tool-call-row[data-tool-call-id="call-cancelled"]');
  const preemptedRow = window.document.querySelector('.tool-call-row[data-tool-call-id="call-preempted"]');
  assert.ok(cancelledRow, 'cancelled tool row should render');
  assert.ok(preemptedRow, 'preempted tool row should render');
  assert.equal(cancelledRow.getAttribute('data-tool-status'), 'cancelled');
  assert.equal(preemptedRow.getAttribute('data-tool-status'), 'cancelled');
  // No duplicate tool rows per call_id even though both rows hydrate without
  // a matching tool_result message.
  assert.equal(window.document.querySelectorAll('.tool-call-row[data-tool-call-id="call-cancelled"]').length, 1);
  assert.equal(window.document.querySelectorAll('.tool-call-row[data-tool-call-id="call-preempted"]').length, 1);
});

test('renderer uses pretext to expand hidden tool details when DOM height is zero', async (t) => {
  const sessionId = 'session-bash-pretext';
  const streamId = `stream-${sessionId}`;
  const { window, shell } = await loadRendererTestApp(t, {
    shell: {
      chat: {
        startStream: createToolSessionStartStream(sessionId, 'Bash Pretext Session'),
      },
      features: {
        state: {
          featureFlags: {
            pretext_layout: true,
          },
        },
      },
    },
  });

  await submitPrompt(window, 'Run a command with pretext');

  await shell.__emitChat({
    type: 'tool_use',
    sessionId,
    streamId,
    callId: 'call-bash-pretext',
    toolName: 'run_command',
    summary: 'run_command node -e "console.log(1)"',
    input: { command: 'node -e "console.log(1)"' },
    status: 'running',
  });
  await shell.__emitChat({
    type: 'tool_result',
    sessionId,
    streamId,
    callId: 'call-bash-pretext',
    toolName: 'run_command',
    input: { command: 'node -e "console.log(1)"' },
    summary: 'run_command node -e "console.log(1)"',
    content: 'first line\nsecond line\nthird line',
    isError: false,
    approvalState: 'auto',
    durationMs: 12,
    metadata: { exitCode: 0 },
  });
  await waitForUi(window, 20);

  const header = window.document.querySelector('[data-call-id="call-bash-pretext"] .tool-call-header');
  const details = window.document.getElementById(header.getAttribute('aria-controls'));
  assert.ok(header);
  assert.ok(details);
  Object.defineProperty(details, 'scrollHeight', { configurable: true, get() { return 0; } });
  Object.defineProperty(details, 'offsetHeight', { configurable: true, get() { return 0; } });

  header.click();
  await waitForUi(window, 20);

  const expandedDetails = window.document.getElementById(header.getAttribute('aria-controls'));
  assert.equal(expandedDetails.hidden, false);
  assert.match(String(expandedDetails.style.maxHeight || ''), /^[1-9]\d*px$/);
});

test('renderer tool details fallback uses the default pretext font and avoids DOM timer expandos', async (t) => {
  const sessionId = 'session-bash-pretext-fallback';
  const streamId = `stream-${sessionId}`;
  const { window, shell } = await loadRendererTestApp(t, {
    shell: {
      chat: {
        startStream: createToolSessionStartStream(sessionId, 'Bash Pretext Fallback Session'),
      },
      features: {
        state: {
          featureFlags: {
            pretext_layout: true,
          },
        },
      },
    },
  });

  await submitPrompt(window, 'Run a command with pretext fallback');

  await shell.__emitChat({
    type: 'tool_use',
    sessionId,
    streamId,
    callId: 'call-bash-pretext-fallback',
    toolName: 'run_command',
    summary: 'run_command node -e "console.log(1)"',
    input: { command: 'node -e "console.log(1)"' },
    status: 'running',
  });
  await shell.__emitChat({
    type: 'tool_result',
    sessionId,
    streamId,
    callId: 'call-bash-pretext-fallback',
    toolName: 'run_command',
    input: { command: 'node -e "console.log(1)"' },
    summary: 'run_command node -e "console.log(1)"',
    content: 'first line\nsecond line\nthird line',
    isError: false,
    approvalState: 'auto',
    durationMs: 12,
    metadata: { exitCode: 0 },
  });
  await waitForUi(window, 20);

  const pretextUtils = window.rendererPretextUtils;
  const previousResolveFontString = pretextUtils.resolveFontString;
  const previousResolveDefaultFontString = pretextUtils.resolveDefaultFontString;
  const previousPredictTextHeight = pretextUtils.predictTextHeight;
  let capturedFont = null;
  t.after(() => {
    pretextUtils.resolveFontString = previousResolveFontString;
    pretextUtils.resolveDefaultFontString = previousResolveDefaultFontString;
    pretextUtils.predictTextHeight = previousPredictTextHeight;
  });
  pretextUtils.resolveFontString = () => null;
  pretextUtils.resolveDefaultFontString = () => 'normal normal 400 15px Fallback Sans';
  pretextUtils.predictTextHeight = (cacheKey, text, font, maxWidth, lineHeight) => {
    capturedFont = font;
    return previousPredictTextHeight.call(pretextUtils, cacheKey, text, font, maxWidth, lineHeight) || { height: 84 };
  };

  const header = window.document.querySelector('[data-call-id="call-bash-pretext-fallback"] .tool-call-header');
  const details = window.document.getElementById(header.getAttribute('aria-controls'));
  assert.ok(header);
  assert.ok(details);
  Object.defineProperty(details, 'scrollHeight', { configurable: true, get() { return 0; } });
  Object.defineProperty(details, 'offsetHeight', { configurable: true, get() { return 0; } });

  header.click();
  await waitForUi(window, 20);

  const expandedDetails = window.document.getElementById(header.getAttribute('aria-controls'));
  assert.equal(capturedFont, 'normal normal 400 15px Fallback Sans');
  assert.equal(Object.prototype.hasOwnProperty.call(expandedDetails, '__toolDetailsTimer'), false);
  assert.equal(expandedDetails.hidden, false);
  assert.match(String(expandedDetails.style.maxHeight || ''), /^[1-9]\d*px$/);
});
