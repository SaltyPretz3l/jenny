const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');

async function loadRendererTestApp(t, options) {
  const app = await loadRendererApp(options);
  t.after(async () => {
    await app.dispose();
  });
  return app;
}

test('renderer routes turn approval status to the titlebar pill', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const input = window.document.getElementById('chatInput');
  const sendButton = window.document.getElementById('sendButton');
  const composerStatusNotice = window.document.getElementById('composerStatusNotice');
  const turnStatusPill = window.document.getElementById('turnStatusPill');

  input.value = 'Create a session first';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUi(window, 30);

  const activeSessionId = String(window.__rendererState.currentSessionId || '');
  assert.ok(activeSessionId, 'expected an active session after the initial send');

  await shell.__emitChat({
    type: 'tool_approval_needed',
    sessionId: activeSessionId,
    streamId: 'stream-status-row',
    callId: 'call-status-row',
    toolName: 'Read',
    input: { file_path: 'src/app.js' },
  });
  await waitForUi(window, 30);

  assert.equal(composerStatusNotice.classList.contains('hidden'), true);
  assert.equal(turnStatusPill.classList.contains('hidden'), false);
  assert.equal(turnStatusPill.getAttribute('data-source'), 'turn.needs_approval');
  assert.match(turnStatusPill.textContent, /approval needed/i);
  assert.ok(turnStatusPill.querySelector('.turn-status-pill__message'));
});
