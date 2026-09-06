const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');
const toolShellUtils = require('../renderer/chat/renderer-tool-shell-utils');
const transcriptUtils = require('../renderer/chat/renderer-transcript-utils');
const toolCallUtils = require('../renderer/chat/tool-call-utils');
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

test('renderer shows inline recap row collapsed by default and toggles by click and keyboard', async (t) => {
  const sessionId = 'session-inline-recap';
  const streamId = `stream-${sessionId}`;
  const { window, shell } = await loadRendererTestApp(t, {
    shell: {
      chat: {
        startStream: createToolSessionStartStream(sessionId, 'Inline Recap Session'),
      },
    },
  });

  await submitPrompt(window, 'Interactive follow-up');

  shell.__state.messagesBySession.set(sessionId, [
    { id: 'u1', role: 'user', content: 'Interactive follow-up', status: 'complete' },
    { id: 'a1', role: 'assistant', content: 'Let me ask a few quick questions.', status: 'complete' },
    {
      id: 'recap-1',
      role: 'assistant',
      kind: 'interactive_round_recap',
      content: 'Asked 3 questions',
      interactive_round_recap: {
        round_index: 1,
        answer_count: 3,
        collapsed: false,
        items: [
          { question_id: 'q1', prompt: 'What matters most?', answer_label: 'Delivery speed' },
          { question_id: 'q2', prompt: 'What can wait?', answer_label: 'Polish' },
          { question_id: 'q3', prompt: 'Deadline?', answer_label: 'Friday' },
        ],
      },
    },
    { id: 'a2', role: 'assistant', content: 'Thanks, I can proceed.', status: 'complete' },
  ]);
  await shell.__emitChat({
    type: 'complete',
    sessionId,
    streamId,
    content: 'Thanks, I can proceed.',
    interactiveProtocolDrift: false,
    interactiveProtocolDriftPreview: '',
  });
  await waitForUi(window, 40);

  const timeline = window.document.querySelector('.chat-timeline');
  const articleIds = Array.from(timeline.querySelectorAll('article')).map((entry) => entry.dataset.messageId);
  assert.deepEqual(articleIds, ['u1', 'a1', 'recap-1', 'a2']);

  const recapArticle = timeline.querySelector('[data-message-id="recap-1"]');
  const recapRow = recapArticle.querySelector('[data-interactive-recap-row]');
  const recapPanel = recapArticle.querySelector('.interactive-recap-panel');

  assert.ok(recapRow, 'recap row should be focusable in transcript timeline');
  assert.equal(recapRow.getAttribute('aria-expanded'), 'false', 'recap row should default to collapsed');
  assert.match(recapRow.textContent, /Asked 3 questions/);

  recapRow.click();
  await waitForUi(window, 20);
  assert.equal(recapRow.getAttribute('aria-expanded'), 'true', 'click should expand recap row');
  assert.equal(recapPanel.hidden, false, 'expanded recap panel should be visible');

  recapRow.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await waitForUi(window, 20);
  assert.equal(recapRow.getAttribute('aria-expanded'), 'false', 'Enter should collapse recap row');

  recapRow.dispatchEvent(new window.KeyboardEvent('keydown', { key: ' ', bubbles: true }));
  await waitForUi(window, 20);
  assert.equal(recapRow.getAttribute('aria-expanded'), 'true', 'Space should expand recap row');
});

test('renderer skips recap rows that do not contain questions or asked count', async (t) => {
  const sessionId = 'session-empty-recap';
  const streamId = `stream-${sessionId}`;
  const { window, shell } = await loadRendererTestApp(t, {
    shell: {
      chat: {
        startStream: createToolSessionStartStream(sessionId, 'Empty Recap Session'),
      },
    },
  });

  await submitPrompt(window, 'Interactive follow-up');

  shell.__state.messagesBySession.set(sessionId, [
    { id: 'u1', role: 'user', content: 'Interactive follow-up', status: 'complete' },
    {
      id: 'recap-empty',
      role: 'assistant',
      kind: 'interactive_round_recap',
      content: 'Asked 0 questions',
      interactive_round_recap: {
        round_index: 1,
        answer_count: 0,
        items: [],
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
  await waitForUi(window, 40);

  const timeline = window.document.querySelector('.chat-timeline');
  assert.equal(
    timeline.querySelector('[data-message-id="recap-empty"]'),
    null,
    'empty recap payload should not render as a transcript row'
  );
});

test('renderer keeps partial recap row stable during streaming', async (t) => {
  const sessionId = 'session-partial-recap';
  const streamId = `stream-${sessionId}`;
  const { window, shell } = await loadRendererTestApp(t, {
    shell: {
      chat: {
        startStream: createToolSessionStartStream(sessionId, 'Partial Recap Session'),
      },
    },
  });

  await submitPrompt(window, 'Interactive follow-up');

  shell.__state.messagesBySession.set(sessionId, [
    { id: 'u1', role: 'user', content: 'Interactive follow-up', status: 'complete' },
    {
      id: 'recap-partial',
      role: 'assistant',
      kind: 'interactive_round_recap',
      status: 'streaming',
      content: 'Asked 3 questions',
      interactive_round_recap: {
        round_index: 1,
        answer_count: 3,
        items: [
          { question_id: 'q1', prompt: 'What matters most?', answer_label: 'Delivery speed' },
        ],
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
  await waitForUi(window, 40);

  const recapArticle = window.document.querySelector('[data-message-id="recap-partial"]');
  assert.ok(recapArticle, 'partial recap row should render without crashing');
  assert.ok(
    recapArticle.querySelector('.interactive-recap-block.is-partial'),
    'partial recap row should include active partial styling'
  );
  assert.match(recapArticle.textContent, /Asked 3 questions/);
  assert.match(recapArticle.textContent, /Updating/);
});

