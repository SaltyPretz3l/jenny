const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');

async function loadRendererTestApp(t, options) {
  const app = await loadRendererApp(options);
  t.after(async () => { await app.dispose(); });
  return app;
}

test('renderer formats python_execute output with inline code, tables, images, and errors', async (t) => {
  const { window, shell } = await loadRendererTestApp(t, {
    shell: {
      chat: {
        async startStream(payload, { state }) {
          const sessionId = 'session-python-tool';
          state.sessions = [{
            id: sessionId,
            title: 'Python Tool Session',
            conversation_mode: payload.conversationMode || 'chat',
            preferred_model: payload.preferredModel || 'gpt-test',
            reasoning_effort: payload.reasoningEffort || 'default',
            interactive_round_count: 0,
            interactive_sequence_state: 'idle',
            pending_question_batch: null,
            updated_at: new Date().toISOString(),
          }];
          state.messagesBySession.set(sessionId, []);
          return { sessionId, streamId: 'stream-python-tool' };
        },
      },
    },
  });
  const input = window.document.getElementById('chatInput');
  const sendButton = window.document.getElementById('sendButton');

  input.value = 'Run python';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUi(window, 20);

  await shell.__emitChat({
    type: 'tool_use',
    sessionId: 'session-python-tool',
    streamId: 'stream-python-tool',
    callId: 'call-python-1',
    toolName: 'python_execute',
    summary: 'Run Python: print(2 + 2)',
    input: { code: 'print(2 + 2)' },
    status: 'running',
  });
  await shell.__emitChat({
    type: 'tool_result',
    sessionId: 'session-python-tool',
    streamId: 'stream-python-tool',
    callId: 'call-python-1',
    toolName: 'python_execute',
    summary: 'Run Python: print(2 + 2)',
    content: JSON.stringify({
      stdout: '4\n',
      stderr: '',
      error: { traceback: 'Traceback (most recent call last):\nZeroDivisionError: division by zero' },
      images: [{ id: 'chart-1', mime_type: 'image/png', byte_length: 4 }],
      tables: [{ name: 'df', html: '<table><tbody><tr><td>1</td></tr></tbody></table>' }],
      last_expr_repr: '4',
      truncated: false,
    }),
    isError: true,
    approvalState: 'auto',
    durationMs: 12,
    trustedAttachments: [{
      id: 'stored-chart-1',
      kind: 'chart',
      mimeType: 'image/png',
      byteLength: 4,
      width: 320,
      height: 200,
      assetPath: 'C:\\attachments\\stored-chart-1.png',
    }],
  });
  await waitForUi(window, 30);

  const header = window.document.querySelector('[data-call-id="call-python-1"] .tool-call-header');
  assert.ok(header);
  const details = window.document.getElementById(header.getAttribute('aria-controls'));
  assert.ok(details);
  // R2-12: a failed row stays collapsed and carries its failure text in the header.
  assert.equal(header.getAttribute('aria-expanded'), 'false');
  assert.equal(details.hidden, true);
  assert.match(header.textContent, /ZeroDivisionError/);

  header.click();
  await waitForUi(window, 260);

  assert.equal(header.getAttribute('aria-expanded'), 'true');
  assert.equal(details.hidden, false);
  assert.equal(window.document.querySelectorAll('.python-output-image').length, 1);
  assert.match(
    window.document.querySelector('.python-output-image').getAttribute('src'),
    /^file:\/\/\/C:\/attachments\/stored-chart-1\.png$/i
  );
  assert.equal(window.document.querySelectorAll('.python-table-output table').length, 1);
  assert.match(window.document.querySelector('.python-output-error').textContent, /ZeroDivisionError/);
  assert.match(details.textContent, /print\(2 \+ 2\)/);

  header.click();
  await waitForUi(window, 260);

  assert.equal(header.getAttribute('aria-expanded'), 'false');
  assert.equal(details.hidden, true);

  header.dispatchEvent(new window.KeyboardEvent('keydown', { key: ' ', bubbles: true }));
  await waitForUi(window, 260);

  assert.equal(header.getAttribute('aria-expanded'), 'true');
  assert.equal(details.hidden, false);
});

test('renderer falls back to plain text when python_execute output is not JSON', async (t) => {
  const { window, shell } = await loadRendererTestApp(t, {
    shell: {
      chat: {
        async startStream(payload, { state }) {
          const sessionId = 'session-python-tool-fallback';
          state.sessions = [{
            id: sessionId,
            title: 'Python Tool Fallback Session',
            conversation_mode: payload.conversationMode || 'chat',
            preferred_model: payload.preferredModel || 'gpt-test',
            reasoning_effort: payload.reasoningEffort || 'default',
            interactive_round_count: 0,
            interactive_sequence_state: 'idle',
            pending_question_batch: null,
            updated_at: new Date().toISOString(),
          }];
          state.messagesBySession.set(sessionId, []);
          return { sessionId, streamId: 'stream-python-tool-fallback' };
        },
      },
    },
  });
  const input = window.document.getElementById('chatInput');
  const sendButton = window.document.getElementById('sendButton');

  input.value = 'Run python';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUi(window, 20);

  await shell.__emitChat({
    type: 'tool_use',
    sessionId: 'session-python-tool-fallback',
    streamId: 'stream-python-tool-fallback',
    callId: 'call-python-2',
    toolName: 'python_execute',
    summary: 'Run Python: import pandas',
    input: { code: 'import pandas' },
    status: 'completed',
  });
  await shell.__emitChat({
    type: 'tool_result',
    sessionId: 'session-python-tool-fallback',
    streamId: 'stream-python-tool-fallback',
    callId: 'call-python-2',
    toolName: 'python_execute',
    summary: 'Run Python: import pandas',
    content: 'pip install failed: wheel download timed out',
    isError: true,
    approvalState: 'auto',
    durationMs: 12,
  });
  await waitForUi(window, 30);

  const header = window.document.querySelector('[data-call-id="call-python-2"] .tool-call-header');
  assert.ok(header);
  header.click();
  await waitForUi(window, 20);

  assert.match(
    window.document.getElementById(header.getAttribute('aria-controls')).textContent,
    /wheel download timed out/
  );
});
