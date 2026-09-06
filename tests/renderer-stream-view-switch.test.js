const test = require('node:test');
const assert = require('node:assert/strict');

const {
  loadRendererApp,
} = require('./helpers/renderer-shell-harness');
const { waitForUiState } = require('./helpers/wait-for-ui-state');

async function loadRendererTestApp(t, options) {
  const app = await loadRendererApp(options);
  t.after(async () => {
    await app.dispose();
  });
  return app;
}

// Fixed waitForUi tick sleeps flake under the 12-worker lane: the send pipeline
// and debounced/rAF stream renders can land after any fixed tick count. Wait on
// the observable DOM state each assertion block reads instead (same conversion
// as e9af2ff3 for the other streaming-article suites).
//
// Waits use a generous timeout: under 12-worker contention the render pipeline
// (rAF re-anchor retries included) can exceed the 1.2s helper default, and a
// condition wait returns the moment the state holds, so headroom is free.
const CONTENTION_WAIT_TIMEOUT_MS = 10_000;

async function waitForViewVisible(window, viewId, label) {
  await waitForUiState(
    window,
    () => !window.document.getElementById(viewId).classList.contains('hidden'),
    {
      timeoutMs: CONTENTION_WAIT_TIMEOUT_MS,
      message: `Timed out waiting for the ${label} view to become visible.`,
    }
  );
}

// Top-rail chrome re-renders replace the tab nodes, so a tab reference captured
// at load time goes stale (isConnected=false) after the first view switch and
// clicking it is a silent no-op. Always resolve the tab by id at click time.
function clickTab(window, tabId) {
  window.document.getElementById(tabId).click();
}

test('streaming assistant text survives switching away from chat and back without replacing the row', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const document = window.document;
  const input = document.getElementById('chatInput');
  const sendButton = document.getElementById('sendButton');
  const assistantEntrySelector = 'article[data-message-id="assistant_stream-view-switch"]';

  input.value = 'Keep the stream stable';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUiState(
    window,
    () => Boolean(document.querySelector('.chat-entry.user')),
    {
      timeoutMs: CONTENTION_WAIT_TIMEOUT_MS,
      message: 'Timed out waiting for the sent user turn-article to render.',
    }
  );

  await shell.__emitChat({
    type: 'started',
    sessionId: 'session-1',
    streamId: 'stream-view-switch',
  });
  await shell.__emitChat({
    type: 'delta',
    sessionId: 'session-1',
    streamId: 'stream-view-switch',
    content: 'First visible chunk.',
  });
  await waitForUiState(
    window,
    () => /First visible chunk/.test(document.querySelector(assistantEntrySelector)?.textContent || ''),
    {
      timeoutMs: CONTENTION_WAIT_TIMEOUT_MS,
      message: 'Timed out waiting for the streaming assistant article with the first chunk.',
    }
  );

  const assistantEntryBefore = document.querySelector(assistantEntrySelector);
  assert.ok(assistantEntryBefore);
  assert.match(assistantEntryBefore.textContent, /First visible chunk/);

  clickTab(window, 'homeTopRailTab');
  await waitForViewVisible(window, 'homeView', 'home');

  await shell.__emitChat({
    type: 'delta',
    sessionId: 'session-1',
    streamId: 'stream-view-switch',
    content: ' Hidden chunk while away.',
  });

  clickTab(window, 'chatTopRailTab');
  await waitForViewVisible(window, 'chatView', 'chat');
  await waitForUiState(
    window,
    () => {
      const entry = document.querySelector(assistantEntrySelector);
      return Boolean(entry)
        && /First visible chunk\. Hidden chunk while away\./.test(entry.textContent)
        && document.getElementById('chatSpriteLayer').classList.contains('visible')
        && document.getElementById('chatAssistantSprite').classList.contains('is-streaming');
    },
    {
      timeoutMs: CONTENTION_WAIT_TIMEOUT_MS,
      message: 'Timed out waiting for the resumed streaming article with the away-time chunk.',
    }
  );

  const assistantEntries = document.querySelectorAll(assistantEntrySelector);
  const assistantEntryAfter = assistantEntries[0];

  assert.equal(assistantEntries.length, 1);
  assert.equal(assistantEntryAfter, assistantEntryBefore);
  assert.match(assistantEntryAfter.textContent, /First visible chunk\. Hidden chunk while away\./);
  assert.equal(document.getElementById('chatSpriteLayer').classList.contains('visible'), true);
  assert.equal(document.getElementById('chatAssistantSprite').classList.contains('is-streaming'), true);

  clickTab(window, 'homeTopRailTab');
  await waitForViewVisible(window, 'homeView', 'home');

  await shell.__emitChat({
    type: 'complete',
    sessionId: 'session-1',
    streamId: 'stream-view-switch',
    content: 'First visible chunk. Hidden chunk while away. Finished.',
  });

  clickTab(window, 'chatTopRailTab');
  await waitForViewVisible(window, 'chatView', 'chat');
  await waitForUiState(
    window,
    () => {
      const entry = document.querySelector(assistantEntrySelector);
      // The sprite re-anchor transiently hides the layer before re-showing it
      // over the settled article, so wait for the full end state the assertions
      // read: layer visible again AND streaming affordance dropped.
      return Boolean(entry)
        && /Finished\./.test(entry.textContent)
        && document.getElementById('chatSpriteLayer').classList.contains('visible')
        && !document.getElementById('chatAssistantSprite').classList.contains('is-streaming');
    },
    {
      timeoutMs: CONTENTION_WAIT_TIMEOUT_MS,
      message: 'Timed out waiting for the completed assistant article after switching back.',
    }
  );

  const completedAssistantEntries = document.querySelectorAll(assistantEntrySelector);
  assert.equal(completedAssistantEntries.length, 1);
  assert.match(completedAssistantEntries[0].textContent, /Finished\./);
  assert.equal(document.getElementById('chatSpriteLayer').classList.contains('visible'), true);
  assert.equal(document.getElementById('chatAssistantSprite').classList.contains('is-streaming'), false);
});
