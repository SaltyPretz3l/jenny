const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');
async function loadRendererTestApp(t, options) { const app = await loadRendererApp(options); t.after(async () => { await app.dispose(); }); return app; }
function buildSidebarSession(id, title, updatedAt) {
  return {
    id,
    title,
    conversation_mode: 'chat',
    preferred_model: 'gpt-test',
    reasoning_effort: 'default',
    context_preferences: {
      history_scope: 'session',
      include_personality: true,
      include_memory: true,
    },
    interactive_round_count: 0,
    interactive_sequence_state: 'idle',
    pending_question_batch: null,
    linked_session_ids: [],
    message_count: 1,
    last_message_preview: `${title} preview`,
    updated_at: updatedAt,
    created_at: updatedAt,
  };
}
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
test('renderer shell boots and submits a basic send flow', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const input = window.document.getElementById('chatInput');
  const sendButton = window.document.getElementById('sendButton');
  const chatSurface = window.document.getElementById('chatSurface');
  const chatTimeline = window.document.getElementById('chatTimeline');
  const attachmentTray = window.document.getElementById('attachmentTray');
  const composerStatusNotice = window.document.getElementById('composerStatusNotice');
  assert.ok(input);
  assert.ok(sendButton);
  assert.equal(chatSurface.getAttribute('aria-live'), null);
  [
    [chatTimeline, 'role', 'log'],
    [chatTimeline, 'aria-live', 'off'],
    [attachmentTray, 'aria-live', 'polite'],
    [composerStatusNotice, 'role', 'status'],
    [composerStatusNotice, 'aria-live', 'polite'],
  ].forEach(([node, name, value]) => assert.equal(node.getAttribute(name), value));
  input.value = 'Hello from smoke test';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUi(window);
  assert.equal(shell.__state.chatCalls.length, 1);
  assert.equal(shell.__state.chatCalls[0].prompt, 'Hello from smoke test');
});
test('renderer queues pasted image attachments and renders them in the transcript', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const input = window.document.getElementById('chatInput');
  const sendButton = window.document.getElementById('sendButton');
  dispatchPastedImage(window, input);
  await waitForUi(window);

  assert.equal(shell.__state.attachmentSaveCalls.length, 1);
  assert.equal(window.document.querySelectorAll('.attachment-chip-image').length, 1);

  input.value = 'Describe this screenshot';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUi(window, 30);

  assert.equal(shell.__state.chatCalls.length, 1);
  assert.equal(shell.__state.chatCalls[0].attachments[0].kind, 'image');
  assert.equal(Object.prototype.hasOwnProperty.call(shell.__state.chatCalls[0].attachments[0], 'bytes'), false);
  assert.equal(window.document.querySelectorAll('.message-attachment-image-preview').length, 1);
});

test('renderer surfaces composer context menu paste failures', async (t) => {
  const { window } = await loadRendererTestApp(t);
  const input = window.document.getElementById('chatInput');
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: {
      async readText() {
        throw new Error('Clipboard denied');
      },
    },
  });

  input.dispatchEvent(new window.MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    clientX: 12,
    clientY: 16,
  }));
  await waitForUi(window, 20);

  const pasteButton = Array.from(window.document.querySelectorAll('.inv-context-menu-item'))
    .find((button) => /Paste/.test(button.textContent));
  assert.ok(pasteButton);
  pasteButton.click();
  await waitForUi(window, 40);

  const toastText = window.document.getElementById('toastViewport').textContent;
  assert.match(toastText, /Clipboard Paste Failed/);
  assert.match(toastText, /Clipboard denied/);
});

test('renderer keeps attachment notice inert and omits obsolete workbench header chrome', async (t) => {
  const { window } = await loadRendererTestApp(t);
  const doc = window.document;
  const input = doc.getElementById('chatInput');
  const sendButton = doc.getElementById('sendButton');
  const attachmentTray = doc.getElementById('attachmentTray');
  const attachmentNotice = doc.getElementById('attachmentNotice');

  dispatchPastedImage(window, input, 'header-check.png');
  await waitForUi(window, 20);

  assert.equal(attachmentTray.classList.contains('hidden'), false);
  assert.equal(attachmentNotice.classList.contains('hidden'), true);
  assert.equal(attachmentNotice.textContent, '');

  input.value = 'Quiet the chat header';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUi(window, 40);

  for (const obsoleteId of ['workbenchHeader', 'workbenchSessionTitle', 'workbenchModeLabel', 'workbenchModelLabel']) {
    assert.equal(doc.getElementById(obsoleteId), null, `${obsoleteId} should not render`);
  }
});

test('renderer sidebar uses recent-chat copy for empty and filtered history states', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const doc = window.document;
  const searchInput = doc.getElementById('conversationSearch');
  const conversationGroups = doc.getElementById('conversationGroups');
  const conversationCount = doc.getElementById('conversationCount');

  await waitForUi(window, 30);
  assert.equal(conversationCount.textContent.trim(), '0');
  assert.equal(conversationCount.getAttribute('aria-label'), '0 total chats');
  assert.match(conversationGroups.textContent, /No chats yet\./i);

  await shell.sessions.create({ title: 'Planning Thread', preferences: {} });
  await waitForUi(window, 40);

  searchInput.value = 'missing term';
  searchInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  await waitForUi(window, 20);

  assert.match(conversationGroups.textContent, /No chats match/i);
  assert.match(conversationGroups.textContent, /Try a different title or preview term\./i);
});

test('renderer chat buttons support roving focus, native activation, and search escape', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const doc = window.document;
  const searchInput = doc.getElementById('conversationSearch');

  shell.__state.sessions = [
    buildSidebarSession('session-alpha', 'Alpha Plan', '2026-05-08T14:00:00.000Z'),
    buildSidebarSession('session-beta', 'Beta Notes', '2026-05-08T13:00:00.000Z'),
  ];
  await shell.__emitAuthState({ authenticated: true, user: { email: 'dev@example.com' } });
  await waitForUi(window, 40);

  let cards = [...doc.querySelectorAll('.conversation-item')];
  let openButtons = [...doc.querySelectorAll('[data-session-open]')];
  assert.equal(cards.length, 2);
  assert.equal(cards[0].tagName, 'LI');
  assert.equal(cards[0].parentElement.tagName, 'UL');
  assert.equal(openButtons[0].tagName, 'BUTTON', 'Enter and Space use native button activation');
  openButtons[0].focus();
  openButtons[0].dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  assert.equal(doc.activeElement, openButtons[1]);
  openButtons[1].dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
  assert.equal(doc.activeElement, openButtons[0]);
  openButtons[0].dispatchEvent(new window.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
  assert.equal(doc.activeElement, openButtons[1]);

  openButtons[1].click();
  await waitForUi(window, 40);
  assert.equal(window.__rendererState.currentSessionId, 'session-beta');

  searchInput.value = 'Alpha';
  searchInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  await waitForUi(window, 20);
  assert.equal(doc.querySelectorAll('.conversation-item').length, 1);

  searchInput.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await waitForUi(window, 20);
  assert.equal(searchInput.value, '');
  cards = [...doc.querySelectorAll('.conversation-item')];
  assert.equal(cards.length, 2);
});

test('renderer regenerate action resends the source prompt and replayable image attachments', async (t) => {
  const { window, shell } = await loadRendererTestApp(t, {
    shell: {
      chat: {
        async startStream(payload, { state }) {
          const sessionId = payload.sessionId || 'session-1';
          if (!state.sessions.find((session) => session.id === sessionId)) {
            state.sessions = [{
              id: sessionId,
              title: 'New Chat',
              conversation_mode: payload.conversationMode || 'chat',
              preferred_model: payload.preferredModel || 'gpt-test',
              reasoning_effort: payload.reasoningEffort || 'default',
              context_preferences: {
                history_scope: payload?.contextPreferences?.historyScope || 'session',
                include_personality: payload?.contextPreferences?.includePersonality !== false,
                include_memory: payload?.contextPreferences?.includeMemory !== false,
              },
              interactive_round_count: 0,
              interactive_sequence_state: 'idle',
              pending_question_batch: null,
              updated_at: new Date().toISOString(),
            }];
          }
          state.messagesBySession.set(sessionId, [
            {
              id: `user_stream-test-${state.chatCalls.length}`,
              role: 'user',
              content: payload.visiblePrompt || payload.prompt,
              attachments: payload.attachments || [],
              status: 'complete',
            },
            {
              id: `assistant_stream-test-${state.chatCalls.length}`,
              role: 'assistant',
              content: '',
              status: 'streaming',
              streamId: `stream-test-${state.chatCalls.length}`,
              finalizedAt: null,
            },
          ]);
          return {
            sessionId,
            streamId: `stream-test-${state.chatCalls.length}`,
          };
        },
      },
    },
  });
  const input = window.document.getElementById('chatInput');
  const sendButton = window.document.getElementById('sendButton');

  const pastedBlob = new window.Blob([Uint8Array.from([137, 80, 78, 71])], { type: 'image/png' });
  pastedBlob.name = 'clipboard.png';
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
  await waitForUi(window, 20);

  input.value = 'Describe this screenshot';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUi(window, 20);

  shell.__state.messagesBySession.set('session-1', [
    {
      id: 'user_stream-test-1',
      role: 'user',
      content: 'Describe this screenshot',
      attachments: [shell.__state.chatCalls[0].attachments[0]],
      status: 'complete',
    },
    {
      id: 'assistant_stream-test-1',
      role: 'assistant',
      content: 'It looks like a terminal window.',
      status: 'complete',
      streamId: 'stream-test-1',
      finalizedAt: new Date().toISOString(),
    },
  ]);
  await shell.__emitChat({
    type: 'complete',
    sessionId: 'session-1',
    streamId: 'stream-test-1',
    content: 'It looks like a terminal window.',
    interactiveProtocolDrift: false,
    interactiveProtocolDriftPreview: '',
  });
  await waitForUi(window, 20);

  input.value = 'keep my draft';
  const regenerateButton = window.document.querySelector(
    '[data-message-action="regenerate"][data-message-id="assistant_stream-test-1"]'
  );

  assert.ok(regenerateButton);
  regenerateButton.click();
  await waitForUi(window, 20);

  assert.equal(shell.__state.chatCalls.length, 2);
  assert.equal(shell.__state.chatCalls[1].prompt, 'Describe this screenshot');
  assert.equal(shell.__state.chatCalls[1].visiblePrompt, 'Describe this screenshot');
  assert.equal(shell.__state.chatCalls[1].attachments.length, 1);
  assert.equal(shell.__state.chatCalls[1].attachments[0].kind, 'image');
  assert.equal(shell.__state.chatCalls[1].attachments[0].assetPath, 'C:/attachments/image-1.png');
  assert.equal(Object.prototype.hasOwnProperty.call(shell.__state.chatCalls[1].attachments[0], 'bytes'), false);
  assert.equal(input.value, 'keep my draft');
});

test('renderer capture action saves a staged screen attachment and releases it when removed', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const composerSettingsButton = window.document.getElementById('composerSettingsButton');
  const captureScreenButton = window.document.getElementById('captureScreenButton');

  composerSettingsButton.click();
  captureScreenButton.click();
  await waitForUi(window, 30);

  assert.equal(shell.__state.attachmentSaveCalls.length, 1);
  assert.equal(shell.__state.attachmentSaveCalls[0].sourceKind, 'capture');

  const removeButton = window.document.querySelector('[data-attachment-remove]');
  assert.ok(removeButton);
  removeButton.click();
  await waitForUi(window, 20);

  assert.equal(shell.__state.attachmentReleaseCalls.length, 1);
  assert.equal(shell.__state.attachmentReleaseCalls[0][0], 'C:/attachments/image-1.png');
});
