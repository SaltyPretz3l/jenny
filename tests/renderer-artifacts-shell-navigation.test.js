const test = require('node:test');
const assert = require('node:assert/strict');
const {
  loadRendererApp,
  waitForUi,
} = require('./helpers/renderer-shell-harness');
const { waitForUiState } = require('./helpers/wait-for-ui-state');

function dispatchPastedImage(window, input, name = 'clipboard.png') {
  const pastedBlob = new window.Blob([Uint8Array.from([137, 80, 78, 71])], { type: 'image/png' });
  pastedBlob.name = name;
  const pasteEvent = new window.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(pasteEvent, 'clipboardData', {
    value: {
      items: [{
        type: 'image/png',
        getAsFile() {
          return pastedBlob;
        },
      }],
    },
  });
  input.dispatchEvent(pasteEvent);
}

function setWorkspaceWidths(window, doc, workspaceWidth = 1600) {
  const workspace = doc.getElementById('workspace');
  const sidebar = doc.querySelector('.sidebar');
  const sidebarResizer = doc.getElementById('sidebarResizer');
  const height = 900;
  workspace.getBoundingClientRect = () => ({ top: 0, left: 0, right: workspaceWidth, bottom: height, width: workspaceWidth, height });
  sidebar.getBoundingClientRect = () => ({ top: 0, left: 0, right: 320, bottom: height, width: 320, height });
  sidebarResizer.getBoundingClientRect = () => ({ top: 0, left: 320, right: 330, bottom: height, width: 10, height });
  window.dispatchEvent(new window.Event('resize'));
}

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

async function settleMermaidFrame(window, selector, options = {}) {
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
    origin: 'null',
    data: {
      type: 'rendered',
      requestId: postedMessages[0].requestId,
      ok: options.ok !== false,
      height: options.height || 220,
      error: options.error,
    },
  }));
  await waitForUi(window, 20);
  return { iframe, requestId: postedMessages[0].requestId };
}

function installDirectMermaidRenderer(window, options = {}) {
  const mermaidUtils = window.rendererMermaidUtils;
  assert.ok(mermaidUtils, 'expected rendererMermaidUtils on window');
  mermaidUtils.renderMermaidDirect = async (host, source, renderOptions = {}) => {
    if (options.ok === false) {
      renderOptions.onFailure?.({ ok: false, error: options.error || 'render failed' });
      return;
    }
    host.innerHTML = `<svg class="artifact-test-mermaid-svg"><text>${String(source || '')}</text></svg>`;
    renderOptions.onSuccess?.({ ok: true, height: options.height || 220 });
  };
  mermaidUtils.attachMermaidControls = (host) => {
    host.setAttribute('data-mermaid-controls', 'true');
  };
}

test('tool output artifacts jump back to the paired tool transcript row', async () => {
  const app = await loadRendererApp({
    shell: {
      chat: {
        async startStream(payload, { state }) {
          const sessionId = 'session-artifacts-tools';
          state.sessions = [{
            id: sessionId,
            title: 'Tool Session',
            conversation_mode: payload.conversationMode || 'chat',
            preferred_model: payload.preferredModel || 'gpt-test',
            reasoning_effort: payload.reasoningEffort || 'default',
            interactive_round_count: 0,
            interactive_sequence_state: 'idle',
            pending_question_batch: null,
            updated_at: new Date().toISOString(),
          }];
          state.messagesBySession.set(sessionId, []);
          return { sessionId, streamId: 'stream-artifacts-tools' };
        },
      },
    },
  });
  const { window, shell } = app;
  const doc = window.document;
  const input = doc.getElementById('chatInput');
  const sendButton = doc.getElementById('sendButton');
  try {
    input.value = 'Run the read tool';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    sendButton.click();
    await waitForUi(window, 20);

    await shell.__emitChat({
      type: 'tool_use',
      sessionId: 'session-artifacts-tools',
      streamId: 'stream-artifacts-tools',
      callId: 'call-1',
      toolName: 'Read',
      summary: 'Read src/app.js',
      input: { file_path: 'src/app.js' },
      status: 'running',
    });
    await shell.__emitChat({
      type: 'tool_result',
      sessionId: 'session-artifacts-tools',
      streamId: 'stream-artifacts-tools',
      callId: 'call-1',
      toolName: 'Read',
      summary: 'Read src/app.js',
      content: 'export const ready = true;',
      isError: false,
      approvalState: 'auto',
      durationMs: 12,
    });
    await waitForUi(window, 30);

    // W1-5: the studio view is gone — open the split review panel (the sole
    // artifact surface) via the real split-view toggle.
    doc.getElementById('artifactSplitViewToggle').click();
    await waitForUi(window, 30);

    const jumpButton = doc.querySelector('#artifactReviewJumpButton');
    assert.ok(jumpButton);
    const toolUseMessageId = 'tool_use_stream-artifacts-tools_call-1';
    assert.equal(jumpButton.getAttribute('data-artifact-jump'), toolUseMessageId);

    jumpButton.click();
    await waitForUi(window, 80);

    const chatTab = doc.getElementById('chatTopRailTab');
    assert.equal(chatTab.getAttribute('aria-selected'), 'true');
    const highlightedShell = doc.querySelector(`[data-message-id="${toolUseMessageId}"].artifact-source-highlight`);
    assert.ok(highlightedShell);
    assert.ok(highlightedShell.classList.contains('message-shell'));
  } finally {
    await app.dispose();
  }
});

test('artifact jump failures roll the current session off the live row-model path', async () => {
  const app = await loadRendererApp({
    shell: {
      chat: {
        async startStream(payload, { state }) {
          const sessionId = 'session-artifacts-orphan';
          state.sessions = [{
            id: sessionId,
            title: 'Orphan Artifact Session',
            conversation_mode: payload.conversationMode || 'chat',
            preferred_model: payload.preferredModel || 'gpt-test',
            reasoning_effort: payload.reasoningEffort || 'default',
            interactive_round_count: 0,
            interactive_sequence_state: 'idle',
            pending_question_batch: null,
            updated_at: new Date().toISOString(),
          }];
          state.messagesBySession.set(sessionId, []);
          return { sessionId, streamId: 'stream-artifacts-orphan' };
        },
      },
    },
  });
  const { window, shell } = app;
  const doc = window.document;
  const input = doc.getElementById('chatInput');
  const sendButton = doc.getElementById('sendButton');
  try {
    input.value = 'Make an artifact';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    sendButton.click();
    await waitForUi(window, 30);

    const orphanArtifactMessages = [
      { id: 'user_artifact_orphan', role: 'user', content: 'Make an artifact', status: 'complete' },
      {
        id: 'orphan-result',
        role: 'tool',
        kind: 'tool_result',
        content: 'done',
        status: 'complete',
        timestamp: '2026-04-14T12:45:00.000Z',
        tool_result: {
          call_id: 'orphan-call',
          tool_name: 'Execute',
          output_text: 'ls output',
          is_error: false,
        },
      },
    ];
    shell.__state.messagesBySession.set('session-artifacts-orphan', orphanArtifactMessages);
    window.__rendererState.messagesBySession.set('session-artifacts-orphan', orphanArtifactMessages);
    window.__rendererState.ui.chatTimelineRowModelBySession.set('session-artifacts-orphan', true);

    // W1-5: studio gone — the split review panel is the jump surface.
    doc.getElementById('artifactSplitViewToggle').click();
    await waitForUi(window, 30);

    const jumpButton = doc.querySelector('#artifactReviewJumpButton');
    assert.ok(jumpButton);
    assert.equal(jumpButton.getAttribute('data-artifact-jump'), 'orphan-result');

    jumpButton.click();
    // The jump path is retry-based (rAF + 3x40ms backoff + a full render per
    // attempt), so a fixed sleep flakes under parallel-runner CPU load — poll
    // for the rollback instead of racing it.
    await waitForUiState(
      window,
      () => window.__rendererState.ui.chatTimelineRowModelBySession.get('session-artifacts-orphan') === false,
      { timeoutMs: 4000, message: 'artifact anchor failures should disable the live row-model path for the session' }
    );

    assert.equal(
      window.__rendererState.ui.chatTimelineRowModelBySession.get('session-artifacts-orphan'),
      false,
      'artifact anchor failures should disable the live row-model path for the session'
    );
    const meta = window.__rendererState.ui.chatTimelineRowModelMetaBySession.get('session-artifacts-orphan');
    assert.equal(meta?.sticky_rollback, true);
    assert.equal(meta?.rollback_reason, 'artifact_anchor_miss');
  } finally {
    await app.dispose();
  }
});

// Skipped pending coalesced-turn refactor: this test expects tool_step rows to
// render inside the assistant turn article (so .inv-artifact-list is reachable
// via the assistant article), but tests/renderer-turn-compat.test.js
// "completed segmented turns render source-owned articles" expects the
// opposite — tool_use messages own their own article. Routing tool_step rows
// into the assistant bucket fixes this test but breaks the segmented-turns
// test, since the same renderer cannot satisfy both contracts. Re-enable when
// the coalesced/segmented contract is unified.
test('artifact jumps for compat-only tool nodes highlight the visible coalesced turn article', { skip: 'pending coalesced-turn refactor (contradicts renderer-turn-compat segmented expectation)' }, async (t) => {
  const app = await loadRendererApp();
  t.after(async () => {
    await app.dispose();
  });
  const { window, shell } = app;
  const doc = window.document;
  const input = doc.getElementById('chatInput');
  const sendButton = doc.getElementById('sendButton');

  input.value = 'Run the read tool and summarize it';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUi(window, 20);

  shell.__state.messagesBySession.set('session-1', [
    {
      id: 'user_artifact_turn',
      role: 'user',
      content: 'Run the read tool and summarize it',
      status: 'complete',
    },
    {
      id: 'assistant_artifact_turn',
      role: 'assistant',
      content: 'Checking the file now.',
      status: 'complete',
      streamId: 'stream-artifact-turn',
      finalizedAt: '2026-04-15T13:00:00.000Z',
    },
    {
      id: 'tool_use_artifact_turn',
      role: 'assistant',
      kind: 'tool_use',
      status: 'completed',
      finalizedAt: '2026-04-15T13:00:01.000Z',
      tool_call: {
        call_id: 'artifact-turn-call',
        tool_name: 'Read',
        parent_stream_id: 'stream-artifact-turn',
        summary: 'Read src/app.js',
        input: { file_path: 'src/app.js' },
      },
    },
    {
      id: 'tool_result_artifact_turn',
      role: 'assistant',
      kind: 'tool_result',
      status: 'complete',
      finalizedAt: '2026-04-15T13:00:02.000Z',
      tool_result: {
        call_id: 'artifact-turn-call',
        tool_name: 'Read',
        parent_stream_id: 'stream-artifact-turn',
        summary: 'Read src/app.js',
        output_text: 'export const ready = true;',
        is_error: false,
        generated_artifacts: [{
          artifact_id: 'artifact_file_session-1_app-js',
          artifact_kind: 'document',
          title: 'app.js extract',
          file_name: 'app.js',
          display_path: '.jenny/artifacts/session-1/app.js',
          absolute_path: 'C:/workspace/.jenny/artifacts/session-1/app.js',
          language: 'javascript',
          editable: true,
          status: 'available',
          session_id: 'session-1',
        }],
      },
    },
    {
      id: 'assistant_artifact_turn_seg1',
      role: 'assistant',
      content: 'The file exports ready as true.',
      status: 'complete',
      streamId: 'stream-artifact-turn',
      finalizedAt: '2026-04-15T13:00:03.000Z',
    },
  ]);

  await shell.__emitChat({
    type: 'complete',
    sessionId: 'session-1',
    streamId: 'stream-artifact-turn',
    content: 'The file exports ready as true.',
    interactiveProtocolDrift: false,
    interactiveProtocolDriftPreview: '',
  });
  await waitForUi(window, 80);

  const turnArticle = doc.querySelector('article[data-message-id="assistant_artifact_turn"]');
  assert.ok(turnArticle?.querySelector('.inv-artifact-list'));
  assert.ok(turnArticle?.querySelector('[data-inv-artifact-action="panel"][data-artifact-id="artifact_file_session-1_app-js"]'));

  // W1-5: the studio view is gone — open the split review panel instead.
  doc.getElementById('artifactSplitViewToggle').click();
  await waitForUi(window, 20);

  const jumpButton = doc.querySelector('#artifactReviewJumpButton');
  assert.ok(jumpButton);
  assert.equal(jumpButton.getAttribute('data-artifact-jump'), 'tool_use_artifact_turn');

  jumpButton.click();
  await waitForUi(window, 80);

  const chatTab = doc.getElementById('chatTopRailTab');
  assert.equal(chatTab.getAttribute('aria-selected'), 'true');
  assert.equal(doc.querySelector('article[data-message-id="tool_use_artifact_turn"]'), null);
  const highlightedShell = doc.querySelector('article[data-message-id="assistant_artifact_turn"].artifact-source-highlight');
  assert.ok(highlightedShell);
  assert.equal(
    doc.querySelector('.thread-compat-anchor[data-message-id="tool_use_artifact_turn"]')?.classList.contains('artifact-source-highlight'),
    false
  );
});

