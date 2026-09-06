const test = require('node:test');
const assert = require('node:assert/strict');

const {
  loadRendererApp,
  waitForUi,
} = require('./helpers/renderer-shell-harness');
const { waitForUiState } = require('./helpers/wait-for-ui-state');

test('renderer buffers stream events that arrive before startStream resolves and replays them after handoff', async (t) => {
  const { window, dispose } = await loadRendererApp({
    shell: {
      chat: {
        async startStream(_payload, { state, emitChat }) {
          state.sessions = [{
            id: 'session-race',
            title: 'Race Session',
            conversation_mode: 'chat',
            preferred_model: 'gpt-test',
            reasoning_effort: 'default',
            interactive_round_count: 0,
            interactive_sequence_state: 'idle',
            pending_question_batch: null,
            updated_at: new Date().toISOString(),
          }];
          await emitChat({
            type: 'started',
            sessionId: 'session-race',
            streamId: 'stream-race',
          });
          await emitChat({
            type: 'delta',
            sessionId: 'session-race',
            streamId: 'stream-race',
            content: 'Buffered hello',
            aggregate: 'Buffered hello',
          });
          await new Promise((resolve) => setTimeout(resolve, 40));
          return { sessionId: 'session-race', streamId: 'stream-race' };
        },
      },
    },
  });
  t.after(async () => {
    await dispose();
  });

  const input = window.document.getElementById('chatInput');
  const sendButton = window.document.getElementById('sendButton');

  input.value = 'Race this handoff';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUi(window, 10);

  assert.equal(window.__rendererState.currentSessionId.startsWith('session_local_'), true);
  assert.equal(window.document.querySelectorAll('.chat-entry').length, 1);
  assert.ok(window.document.querySelector('.chat-entry.user.message-shell .turn-row-list[data-turn-row-list="true"]'));
  assert.ok(window.document.querySelector('.chat-entry.user.message-shell .chat-row'));
  assert.doesNotMatch(window.document.body.textContent || '', /Buffered hello/);

  await waitForUi(window, 80);

  assert.equal(window.__rendererState.currentSessionId, 'session-race');
  assert.equal(window.document.querySelectorAll('.chat-entry').length, 2);
  assert.ok(window.document.querySelector(
    '[data-message-id="assistant_stream-race"].message-shell .chat-row[data-source-message-id="assistant_stream-race"]'
  ));
  assert.match(window.document.querySelectorAll('.chat-entry')[1]?.textContent || '', /Buffered hello/);
});

test('renderer shows immediate preflight UI before startStream resolves', async (t) => {
  const { window, shell, dispose } = await loadRendererApp({
    shell: {
      chat: {
        async startStream(payload, { state }) {
          const sessionId = payload.sessionId || 'session-preflight';
          if (!state.sessions.find((session) => session.id === sessionId)) {
            state.sessions = [{
              id: sessionId,
              title: 'New Chat',
              conversation_mode: payload.conversationMode || 'chat',
              preferred_model: payload.preferredModel || 'gpt-test',
              reasoning_effort: payload.reasoningEffort || 'default',
              interactive_round_count: 0,
              interactive_sequence_state: 'idle',
              pending_question_batch: null,
              updated_at: new Date().toISOString(),
            }];
          }
          state.messagesBySession.set(sessionId, []);
          await new Promise((resolve) => setTimeout(resolve, 60));
          return { sessionId, streamId: 'stream-preflight' };
        },
      },
    },
  });
  t.after(async () => {
    await dispose();
  });

  const input = window.document.getElementById('chatInput');
  const sendButton = window.document.getElementById('sendButton');
  const stopButton = window.document.getElementById('stopStreamButton');
  const composerStatusNotice = window.document.getElementById('composerStatusNotice');
  const chatView = window.document.getElementById('chatView');
  const composerWrap = window.document.getElementById('composerWrap');
  const timelineEntries = () => window.document.querySelectorAll('.chat-entry');

  input.value = 'Please respond slowly';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUi(window, 10);

  assert.equal(shell.__state.chatCalls.length, 1);
  assert.equal(input.disabled, true);
  assert.equal(sendButton.disabled, true);
  assert.equal(sendButton.getAttribute('aria-label'), 'Send');
  assert.equal(sendButton.textContent, '\u2191');
  assert.equal(composerStatusNotice.textContent, '');
  assert.equal(composerStatusNotice.classList.contains('hidden'), true);
  assert.equal(chatView.dataset.sendLifecycle, 'preflight');
  assert.equal(composerWrap.dataset.sendLifecycle, 'preflight');
  assert.equal(timelineEntries().length, 1);
  assert.match(window.document.querySelector('.chat-entry')?.textContent || '', /Please respond slowly/);

  await waitForUi(window, 90);

  assert.equal(stopButton.classList.contains('hidden'), false);
  assert.equal(stopButton.disabled, false);
  assert.equal(sendButton.disabled, true);
  assert.equal(sendButton.getAttribute('aria-label'), 'Queue follow-up prompt — runs in Ask');
  assert.equal(chatView.dataset.sendLifecycle, 'streaming');
  assert.equal(composerWrap.dataset.sendLifecycle, 'streaming');
  assert.equal(timelineEntries().length, 1);
});

test('renderer creates and rekeys an optimistic session shell for the first send in a new chat', async (t) => {
  const { window, shell, dispose } = await loadRendererApp({
    shell: {
      sessions: {
        async list({ state }) {
          return { data: state.sessions.slice() };
        },
      },
      chat: {
        async startStream(_payload, { state }) {
          await new Promise((resolve) => setTimeout(resolve, 40));
          state.sessions = [{
            id: 'session-real',
            title: 'Fresh optimistic chat',
            conversation_mode: 'chat',
            preferred_model: 'gpt-test',
            reasoning_effort: 'default',
            interactive_round_count: 0,
            interactive_sequence_state: 'idle',
            pending_question_batch: null,
            updated_at: new Date().toISOString(),
          }];
          state.messagesBySession.set('session-real', []);
          return { sessionId: 'session-real', streamId: 'stream-real' };
        },
      },
    },
  });
  t.after(async () => {
    await dispose();
  });

  const input = window.document.getElementById('chatInput');
  const sendButton = window.document.getElementById('sendButton');
  const stopButton = window.document.getElementById('stopStreamButton');
  const conversationCount = window.document.getElementById('conversationCount');
  const chatView = window.document.getElementById('chatView');

  input.value = 'Fresh optimistic chat';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUi(window, 10);

  assert.equal(window.__rendererState.currentSessionId.startsWith('session_local_'), true);
  assert.match(conversationCount.textContent, /1/);
  assert.match(window.document.querySelector('.conversation-item')?.textContent || '', /Fresh optimistic chat/);
  assert.equal(window.document.querySelectorAll('.chat-entry').length, 1);
  assert.equal(chatView.dataset.sendLifecycle, 'preflight');

  await waitForUi(window, 80);

  assert.equal(window.__rendererState.currentSessionId, 'session-real');
  assert.match(window.document.querySelector('.conversation-item')?.textContent || '', /Fresh optimistic chat/);
  assert.equal(window.document.querySelectorAll('.chat-entry').length, 1);
  assert.equal(chatView.dataset.sendLifecycle, 'streaming');
  assert.equal(shell.__state.chatCalls.length, 1);
  assert.equal(stopButton.classList.contains('hidden'), false);

  await shell.__emitChat({
    type: 'delta',
    sessionId: 'session-real',
    streamId: 'stream-real',
    content: 'Real handoff output',
    aggregate: 'Real handoff output',
  });
  await waitForUiState(window, () => Boolean(window.document.querySelector(
    '[data-message-id="assistant_stream-real"].message-shell .chat-row[data-source-message-id="assistant_stream-real"]'
  )), {
    message: 'assistant handoff output did not render after stream delta',
  });

  assert.equal(window.document.querySelectorAll('.chat-entry').length, 2);
  assert.ok(window.document.querySelector(
    '[data-message-id="assistant_stream-real"].message-shell .chat-row[data-source-message-id="assistant_stream-real"]'
  ));
  assert.match(window.document.querySelectorAll('.chat-entry')[1]?.textContent || '', /Real handoff output/);
});

test('renderer renders the first handoff delta when animation frames are throttled', async (t) => {
  const queuedRafs = [];
  const { window, shell, dispose } = await loadRendererApp({
    requestAnimationFrame(callback) {
      queuedRafs.push(callback);
      return queuedRafs.length;
    },
    cancelAnimationFrame() {},
    shell: {
      sessions: {
        async list({ state }) {
          return { data: state.sessions.slice() };
        },
      },
      chat: {
        async startStream(_payload, { state }) {
          await new Promise((resolve) => setTimeout(resolve, 40));
          state.sessions = [{
            id: 'session-throttled',
            title: 'Throttled first prompt',
            conversation_mode: 'chat',
            preferred_model: 'gpt-test',
            reasoning_effort: 'default',
            interactive_round_count: 0,
            interactive_sequence_state: 'idle',
            pending_question_batch: null,
            updated_at: new Date().toISOString(),
          }];
          state.messagesBySession.set('session-throttled', []);
          return { sessionId: 'session-throttled', streamId: 'stream-throttled' };
        },
      },
    },
  });
  t.after(async () => {
    await dispose();
  });

  const input = window.document.getElementById('chatInput');
  const sendButton = window.document.getElementById('sendButton');

  input.value = 'Throttled first prompt';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUi(window, 90);

  assert.equal(window.__rendererState.currentSessionId, 'session-throttled');
  assert.equal(window.document.querySelectorAll('.chat-entry').length, 1);

  await shell.__emitChat({
    type: 'delta',
    sessionId: 'session-throttled',
    streamId: 'stream-throttled',
    content: 'First prompt live text',
    aggregate: 'First prompt live text',
  });

  await waitForUiState(window, () => Boolean(window.document.querySelector(
    '[data-message-id="assistant_stream-throttled"].message-shell .chat-row[data-source-message-id="assistant_stream-throttled"]'
  )), {
    timeoutMs: 500,
    message: 'assistant first-prompt output did not render while animation frames were throttled',
  });

  assert.ok(queuedRafs.length > 0);
  assert.equal(window.document.querySelectorAll('.chat-entry').length, 2);
  assert.match(window.document.querySelectorAll('.chat-entry')[1]?.textContent || '', /First prompt live text/);
});

test('renderer keeps a durable failed thread when the first-send handoff fails', async (t) => {
  const { window, dispose } = await loadRendererApp({
    shell: {
      chat: {
        async startStream() {
          await new Promise((resolve) => setTimeout(resolve, 30));
          throw new Error('backend unavailable');
        },
      },
    },
  });
  t.after(async () => {
    await dispose();
  });

  const input = window.document.getElementById('chatInput');
  const sendButton = window.document.getElementById('sendButton');
  const composerStatusNotice = window.document.getElementById('composerStatusNotice');

  input.value = 'Keep this prompt on failure';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUi(window, 10);

  assert.equal(input.disabled, true);
  assert.equal(sendButton.disabled, true);
  assert.equal(composerStatusNotice.textContent, '');
  assert.equal(composerStatusNotice.classList.contains('hidden'), true);
  assert.equal(window.document.querySelectorAll('.chat-entry').length, 1);

  await waitForUi(window, 60);

  assert.equal(input.disabled, false);
  assert.equal(input.value, 'Keep this prompt on failure');
  assert.equal(sendButton.disabled, false);
  assert.equal(sendButton.getAttribute('aria-label'), 'Send');
  assert.equal(sendButton.textContent, '\u2191');
  assert.equal(composerStatusNotice.classList.contains('hidden'), true);
  assert.equal(window.__rendererState.currentSessionId.startsWith('session_local_'), true);
  assert.equal(window.document.querySelectorAll('.chat-entry').length, 2);
  assert.match(window.document.querySelectorAll('.chat-entry')[0]?.textContent || '', /Keep this prompt on failure/);
  const latestEntry = window.document.querySelectorAll('.chat-entry')[1];
  assert.match(latestEntry?.textContent || '', /backend unavailable/i);
  assert.match(latestEntry?.textContent || '', /CMP-CHAT-0002/i);
});

test('renderer keeps cancel unavailable during preflight and enables it after stream handoff', async (t) => {
  const { window, shell, dispose } = await loadRendererApp({
    shell: {
      chat: {
        async startStream(payload, { state }) {
          const sessionId = payload.sessionId || `session-${state.sessionCounter++}`;
          state.sessions = [{
            id: sessionId,
            title: 'New Chat',
            conversation_mode: payload.conversationMode || 'chat',
            preferred_model: payload.preferredModel || 'gpt-test',
            reasoning_effort: payload.reasoningEffort || 'default',
            interactive_round_count: 0,
            interactive_sequence_state: 'idle',
            pending_question_batch: null,
            updated_at: new Date().toISOString(),
          }];
          state.messagesBySession.set(sessionId, []);
          await new Promise((resolve) => setTimeout(resolve, 60));
          return { sessionId, streamId: 'stream-handoff' };
        },
      },
    },
  });
  t.after(async () => {
    await dispose();
  });

  const input = window.document.getElementById('chatInput');
  const sendButton = window.document.getElementById('sendButton');
  const stopButton = window.document.getElementById('stopStreamButton');

  input.value = 'Transition to streaming';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUi(window, 10);

  assert.deepEqual(shell.__state.cancelCalls, []);
  assert.equal(sendButton.disabled, true);
  assert.equal(sendButton.getAttribute('aria-label'), 'Send');
  assert.equal(stopButton.classList.contains('hidden'), false);
  assert.equal(stopButton.disabled, true);

  await waitForUi(window, 90);

  assert.equal(stopButton.classList.contains('hidden'), false);
  assert.equal(stopButton.disabled, false);
  assert.equal(sendButton.disabled, true);
  assert.equal(sendButton.getAttribute('aria-label'), 'Queue follow-up prompt — runs in Ask');

  stopButton.click();
  await waitForUi(window, 10);

  assert.deepEqual(shell.__state.cancelCalls, ['stream-handoff']);

  await shell.__emitChat({
    type: 'error',
    streamId: 'stream-handoff',
    sessionId: shell.__state.sessions[0].id,
    message: 'Cancelled',
  });
});

test('renderer creates a local draft session during a background stream and completion does not steal focus', async (t) => {
  const { window, shell, dispose } = await loadRendererApp({
    shell: {
      sessions: {
        async create() {
          throw new Error('sessions.create should not be called while another session streams');
        },
      },
      chat: {
        async startStream(payload, { state }) {
          const sessionId = payload.sessionId || 'session-streaming';
          if (!state.sessions.find((session) => session.id === sessionId)) {
            state.sessions = [{
              id: sessionId,
              title: 'Streaming Session',
              conversation_mode: payload.conversationMode || 'chat',
              preferred_model: payload.preferredModel || 'gpt-test',
              reasoning_effort: payload.reasoningEffort || 'default',
              interactive_round_count: 0,
              interactive_sequence_state: 'idle',
              pending_question_batch: null,
              updated_at: new Date().toISOString(),
            }];
          }
          state.messagesBySession.set(sessionId, []);
          return { sessionId, streamId: 'stream-background' };
        },
      },
    },
  });
  t.after(async () => {
    await dispose();
  });

  const input = window.document.getElementById('chatInput');
  const sendButton = window.document.getElementById('sendButton');
  const newChatButton = window.document.getElementById('newChatButton');

  input.value = 'Keep streaming in the background';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUi(window, 40);

  const streamingSessionId = window.__rendererState.currentSessionId;
  assert.equal(streamingSessionId, 'session-streaming');

  newChatButton.click();
  await waitForUi(window, 30);

  const localDraftSessionId = window.__rendererState.currentSessionId;
  assert.notEqual(localDraftSessionId, streamingSessionId);
  assert.equal(localDraftSessionId.startsWith('session_local_'), true);
  assert.equal(
    window.__rendererState.sessions.some((session) => session.id === localDraftSessionId && session.local_draft === true),
    true
  );

  await shell.__emitChat({
    type: 'complete',
    sessionId: streamingSessionId,
    streamId: 'stream-background',
    content: 'Background stream finished.',
    interactiveProtocolDrift: false,
    interactiveProtocolDriftPreview: '',
  });
  await waitForUi(window, 40);

  assert.equal(window.__rendererState.currentSessionId, localDraftSessionId);
});

test('renderer keeps the active draft stable while a hidden background stream updates badges and chrome', async (t) => {
  const { window, shell, dispose } = await loadRendererApp({
    shell: {
      sessions: {
        async create() {
          throw new Error('sessions.create should not be called while another session streams');
        },
      },
      chat: {
        async startStream(payload, { state }) {
          const sessionId = payload.sessionId || 'session-streaming';
          if (!state.sessions.find((session) => session.id === sessionId)) {
            state.sessions = [{
              id: sessionId,
              title: 'Streaming Session',
              conversation_mode: payload.conversationMode || 'chat',
              preferred_model: payload.preferredModel || 'gpt-test',
              reasoning_effort: payload.reasoningEffort || 'default',
              interactive_round_count: 0,
              interactive_sequence_state: 'idle',
              pending_question_batch: null,
              updated_at: new Date().toISOString(),
            }];
          }
          state.messagesBySession.set(sessionId, []);
          return { sessionId, streamId: 'stream-background' };
        },
      },
    },
  });
  t.after(async () => {
    await dispose();
  });

  const doc = window.document;
  const input = doc.getElementById('chatInput');
  const sendButton = doc.getElementById('sendButton');
  const newChatButton = doc.getElementById('newChatButton');

  input.value = 'Keep this stream running';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUi(window, 40);

  const streamingSessionId = window.__rendererState.currentSessionId;
  newChatButton.click();
  await waitForUi(window, 30);

  const localDraftSessionId = window.__rendererState.currentSessionId;
  assert.notEqual(localDraftSessionId, streamingSessionId);

  await shell.__emitChat({
    type: 'delta',
    sessionId: streamingSessionId,
    streamId: 'stream-background',
    content: 'Background partial reply',
    aggregate: 'Background partial reply',
  });
  await waitForUi(window, 40);

  const streamingRow = doc.querySelector(
    '.conversation-item[data-session-id="session-streaming"]'
  );
  assert.equal(window.__rendererState.currentSessionId, localDraftSessionId);
  assert.equal(doc.querySelectorAll('#chatTimeline .chat-entry').length, 0);
  assert.doesNotMatch(doc.getElementById('chatTimeline').textContent || '', /Background partial reply/);
  assert.ok(streamingRow);
  assert.equal(streamingRow.dataset.sessionDominantState, 'streaming');
  assert.equal(streamingRow.querySelector('.conversation-state-badge'), null);
  assert.match(streamingRow.querySelector('[data-session-open]').getAttribute('aria-label') || '', /Status: Streaming/i);
});

test('renderer shows approval indicators for a background session after switching away mid-stream', async (t) => {
  const { window, shell, dispose } = await loadRendererApp({
    shell: {
      sessions: {
        async create() {
          throw new Error('sessions.create should not be called while another session streams');
        },
      },
      chat: {
        async startStream(payload, { state }) {
          const sessionId = payload.sessionId || 'session-approval';
          if (!state.sessions.find((session) => session.id === sessionId)) {
            state.sessions = [{
              id: sessionId,
              title: 'Approval Session',
              conversation_mode: payload.conversationMode || 'chat',
              preferred_model: payload.preferredModel || 'gpt-test',
              reasoning_effort: payload.reasoningEffort || 'default',
              interactive_round_count: 0,
              interactive_sequence_state: 'idle',
              pending_question_batch: null,
              updated_at: new Date().toISOString(),
            }];
          }
          state.messagesBySession.set(sessionId, []);
          return { sessionId, streamId: 'stream-approval' };
        },
      },
    },
  });
  t.after(async () => {
    await dispose();
  });

  const input = window.document.getElementById('chatInput');
  const sendButton = window.document.getElementById('sendButton');
  const newChatButton = window.document.getElementById('newChatButton');
  const toastViewport = window.document.getElementById('toastViewport');

  input.value = 'Trigger approval in the background';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUi(window, 40);

  newChatButton.click();
  await waitForUi(window, 30);

  await shell.__emitChat({
    type: 'tool_use',
    sessionId: 'session-approval',
    streamId: 'stream-approval',
    callId: 'call-approval',
    toolName: 'Read',
    summary: 'Read src/app.js',
    input: { file_path: 'src/app.js' },
    status: 'pending_approval',
  });
  await shell.__emitChat({
    type: 'tool_approval_needed',
    sessionId: 'session-approval',
    streamId: 'stream-approval',
    callId: 'call-approval',
    toolName: 'Read',
    input: { file_path: 'src/app.js' },
  });
  await waitForUi(window, 40);

  const approvalRow = window.document.querySelector(
    '.conversation-item[data-session-id="session-approval"]'
  );
  assert.ok(approvalRow);
  assert.equal(approvalRow.dataset.sessionDominantState, 'approval');
  assert.equal(approvalRow.querySelector('.conversation-state-badge'), null);
  assert.match(approvalRow.querySelector('[data-session-open]').getAttribute('aria-label') || '', /Status: Approval/i);
  assert.match(toastViewport.textContent || '', /waiting for tool approval/i);
});

test('renderer keeps settings navigation stable while streaming deltas continue', async (t) => {
  const { window, shell, dispose } = await loadRendererApp();
  t.after(async () => {
    await dispose();
  });

  const input = window.document.getElementById('chatInput');
  const sendButton = window.document.getElementById('sendButton');

  input.value = 'Keep the shell interactive';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUi(window, 30);

  const settingsTabBefore = window.document.getElementById('settingsTopRailTab');
  assert.ok(settingsTabBefore);

  await shell.__emitChat({
    type: 'delta',
    sessionId: 'session-1',
    streamId: 'stream-test-1',
    content: 'Partial answer',
    aggregate: 'Partial answer',
  });
  await waitForUi(window, 30);

  const settingsTabAfter = window.document.getElementById('settingsTopRailTab');
  assert.equal(settingsTabAfter, settingsTabBefore);

  settingsTabAfter.click();
  await waitForUi(window, 30);

  assert.equal(window.__rendererState.ui.activeView, 'settings');
  assert.equal(window.document.getElementById('settingsView').classList.contains('hidden'), false);
  const settingsTabActive = window.document.getElementById('settingsTopRailTab');

  await shell.__emitChat({
    type: 'delta',
    sessionId: 'session-1',
    streamId: 'stream-test-1',
    content: 'More partial answer',
    aggregate: 'Partial answer More partial answer',
  });
  await waitForUi(window, 30);

  assert.equal(window.__rendererState.ui.activeView, 'settings');
  assert.equal(window.document.getElementById('settingsView').classList.contains('hidden'), false);
  assert.equal(window.document.getElementById('settingsTopRailTab'), settingsTabActive);
});
