const test = require('node:test');
const assert = require('node:assert/strict');

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

test('renderer shows a memory suggestion toast and saves approved memories', async (t) => {
  const memoryCalls = { suggest: [], save: [] };
  const candidate = {
    title: 'Preference: tea over coffee',
    lesson_text: 'The user prefers tea over coffee.',
    lesson_kind: 'preference',
    confidence: 0.95,
    source_excerpt: 'I prefer tea over coffee',
    content_fingerprint: 'preference:the-user-prefers-tea-over-coffee',
  };
  const { window, shell } = await loadRendererTestApp(t, {
    shell: {
      memory: {
        async suggestForSession(sessionId) {
          memoryCalls.suggest.push(sessionId);
          return { suggestions: [candidate] };
        },
        async save(sessionId, savedCandidate) {
          memoryCalls.save.push({ sessionId, candidate: savedCandidate });
          return { created: true, memory: { id: 1, session_id: sessionId, ...savedCandidate } };
        },
      },
    },
  });
  const input = window.document.getElementById('chatInput');
  const sendButton = window.document.getElementById('sendButton');
  const toastViewport = window.document.getElementById('toastViewport');

  input.value = 'Remember this';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUi(window, 20);
  await shell.__emitChat({
    type: 'complete',
    sessionId: 'session-1',
    streamId: 'stream-test-1',
    content: 'Sounds good.',
  });
  await waitForUi(window, 20);

  const rememberButton = toastViewport.querySelector('[data-toast-action-id="remember"]');
  assert.ok(rememberButton);
  assert.match(toastViewport.textContent, /Remember this\?/);
  assert.equal(memoryCalls.suggest.length, 1);

  rememberButton.click();
  await waitForUi(window, 20);

  assert.equal(memoryCalls.save.length, 1);
  assert.equal(memoryCalls.save[0].sessionId, 'session-1');
  assert.equal(memoryCalls.save[0].candidate.content_fingerprint, candidate.content_fingerprint);
  assert.match(toastViewport.textContent, /Memory Saved/);
});

test('renderer dismisses memory suggestions without saving when user chooses not now', async (t) => {
  const memoryCalls = { suggest: [], save: [] };
  const candidate = {
    title: 'Preference: tea over coffee',
    lesson_text: 'The user prefers tea over coffee.',
    lesson_kind: 'preference',
    confidence: 0.95,
    source_excerpt: 'I prefer tea over coffee',
    content_fingerprint: 'preference:the-user-prefers-tea-over-coffee',
  };
  const { window, shell } = await loadRendererTestApp(t, {
    shell: {
      memory: {
        async suggestForSession(sessionId) {
          memoryCalls.suggest.push(sessionId);
          return { suggestions: [candidate] };
        },
        async save(sessionId, savedCandidate) {
          memoryCalls.save.push({ sessionId, candidate: savedCandidate });
          return { created: true, memory: { id: 1, session_id: sessionId, ...savedCandidate } };
        },
      },
    },
  });
  const input = window.document.getElementById('chatInput');
  const sendButton = window.document.getElementById('sendButton');
  const toastViewport = window.document.getElementById('toastViewport');

  input.value = 'Remember this';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUi(window, 20);
  await shell.__emitChat({
    type: 'complete',
    sessionId: 'session-1',
    streamId: 'stream-test-1',
    content: 'Sounds good.',
  });
  await waitForUi(window, 20);

  const dismissButton = toastViewport.querySelector('[data-toast-action-id="dismiss"]');
  assert.ok(dismissButton);
  dismissButton.click();
  await waitForUi(window, 20);

  assert.equal(memoryCalls.suggest.length, 1);
  assert.equal(memoryCalls.save.length, 0);
  assert.doesNotMatch(toastViewport.textContent, /Remember this\?/);
});

test('renderer suppresses re-showing dismissed memory suggestions for the same session', async (t) => {
  const memoryCalls = { suggest: [], save: [] };
  const candidate = {
    title: 'Preference: tea over coffee',
    lesson_text: 'The user prefers tea over coffee.',
    lesson_kind: 'preference',
    confidence: 0.95,
    source_excerpt: 'I prefer tea over coffee',
    content_fingerprint: 'preference:the-user-prefers-tea-over-coffee',
  };
  const { window, shell } = await loadRendererTestApp(t, {
    shell: {
      memory: {
        async suggestForSession(sessionId) {
          memoryCalls.suggest.push(sessionId);
          return { suggestions: [candidate] };
        },
        async save(sessionId, savedCandidate) {
          memoryCalls.save.push({ sessionId, candidate: savedCandidate });
          return { created: true, memory: { id: 1, session_id: sessionId, ...savedCandidate } };
        },
      },
    },
  });
  const input = window.document.getElementById('chatInput');
  const sendButton = window.document.getElementById('sendButton');
  const toastViewport = window.document.getElementById('toastViewport');

  input.value = 'Remember this later';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUi(window, 20);
  await shell.__emitChat({
    type: 'complete',
    sessionId: 'session-1',
    streamId: 'stream-test-1',
    content: 'Sounds good.',
  });
  await waitForUi(window, 20);

  const dismissButton = toastViewport.querySelector('[data-toast-action-id="dismiss"]');
  assert.ok(dismissButton);
  dismissButton.click();
  await waitForUi(window, 20);

  await shell.__emitChat({
    type: 'complete',
    sessionId: 'session-1',
    streamId: 'stream-test-2',
    content: 'Anything else?',
  });
  await waitForUi(window, 20);

  assert.equal(memoryCalls.suggest.length, 2);
  assert.equal(memoryCalls.save.length, 0);
  assert.doesNotMatch(toastViewport.textContent, /Remember this\?/);
});

test('renderer interactive skip-question selector marks one question skipped and submits when all are resolved', async (t) => {
  const { window, shell } = await loadRendererTestApp(t);
  const input = window.document.getElementById('chatInput');
  const sendButton = window.document.getElementById('sendButton');

  input.value = 'Start interactive flow';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUi(window, 20);
  await shell.__emitChat({
    type: 'question_batch',
    sessionId: 'session-1',
    streamId: 'stream-test-1',
    batch: {
      batch_id: 'batch-1',
      round_index: 1,
      intro_text: 'Answer two questions',
      questions: [
        { id: 'q1', prompt: 'Pick one', options: [{ id: 'a', label: 'A' }] },
        { id: 'q2', prompt: 'Pick two', options: [{ id: 'b', label: 'B' }] },
      ],
    },
  });
  await waitForUi(window, 30);

  const skipQuestionButton = window.document.querySelector('[data-interactive-skip-question]');
  assert.ok(skipQuestionButton);
  skipQuestionButton.click();
  await waitForUi(window, 20);

  const submitAfterSkip = window.document.querySelector('[data-interactive-submit]');
  assert.equal(submitAfterSkip.disabled, true);

  const optionButton = window.document.querySelector('[data-interactive-option][data-question-id="q2"]');
  assert.ok(optionButton);
  optionButton.click();
  await waitForUi(window, 20);

  const submitButton = window.document.querySelector('[data-interactive-submit]');
  assert.equal(submitButton.disabled, false);
  submitButton.click();
  await waitForUi(window, 20);

  assert.equal(shell.__state.chatCalls.length, 2);
  assert.equal(shell.__state.chatCalls[1].interactiveResponse?.disposition, 'answered');
  assert.equal(shell.__state.chatCalls[1].interactiveResponse?.answers?.length, 1);
});

test('renderer interactive skip-all selector resolves unanswered questions and allows submit', async (t) => {
  const { window } = await loadRendererTestApp(t);
  const input = window.document.getElementById('chatInput');
  const sendButton = window.document.getElementById('sendButton');

  input.value = 'Start skip-all flow';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUi(window, 20);
  await window.jennyShell.__emitChat({
    type: 'question_batch',
    sessionId: 'session-1',
    streamId: 'stream-test-1',
    batch: {
      batch_id: 'batch-2',
      round_index: 1,
      intro_text: 'Skip-all test',
      questions: [
        { id: 'q1', prompt: 'Q1', options: [{ id: 'one', label: 'One' }] },
        { id: 'q2', prompt: 'Q2', options: [{ id: 'two', label: 'Two' }] },
      ],
    },
  });
  await waitForUi(window, 30);

  const skipAllButton = window.document.querySelector('[data-interactive-skip-all]');
  assert.ok(skipAllButton);
  skipAllButton.click();
  await waitForUi(window, 20);

  const submitButton = window.document.querySelector('[data-interactive-submit]');
  assert.equal(submitButton.disabled, false);
});

test('renderer delegates error action clicks through chat timeline handlers', async (t) => {
  const recoveryCalls = { retryStart: 0 };
  const { window } = await loadRendererTestApp(t, {
    shell: {
      backend: {
        async retryStart() {
          recoveryCalls.retryStart += 1;
          return { phase: 'ready' };
        },
      },
    },
  });
  const input = window.document.getElementById('chatInput');
  const sendButton = window.document.getElementById('sendButton');
  const settingsView = window.document.getElementById('settingsView');
  const logsView = window.document.getElementById('logsView');

  input.value = 'Generate response for error actions';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUi(window, 20);
  assert.equal(settingsView.classList.contains('view-offscreen'), true);

  const timeline = window.document.getElementById('chatTimeline');
  timeline.insertAdjacentHTML('beforeend', '<button type="button" data-inv-error-action="settings" data-error-class="provider">Settings</button>');
  timeline.querySelector('[data-inv-error-action="settings"]').click();
  await waitForUi(window, 25);

  assert.equal(settingsView.classList.contains('view-offscreen'), false);

  timeline.insertAdjacentHTML('beforeend', '<button type="button" data-inv-error-action="restart_sidecar">Restart sidecar</button>');
  timeline.querySelector('[data-inv-error-action="restart_sidecar"]').click();
  await waitForUi(window, 25);
  assert.equal(recoveryCalls.retryStart, 1);

  timeline.insertAdjacentHTML('beforeend', '<button type="button" data-inv-error-action="open_diagnostics">Open diagnostics</button>');
  timeline.querySelector('[data-inv-error-action="open_diagnostics"]').click();
  await waitForUi(window, 25);
  assert.equal(logsView.getAttribute('aria-hidden'), 'false');
  assert.equal(settingsView.getAttribute('aria-hidden'), 'true');
});

test('renderer delegates artifact action clicks and invokes artifact APIs by artifact id', async (t) => {
  const artifactCalls = { open: [], reveal: [] };
  const { window } = await loadRendererTestApp(t, {
    shell: {
      artifacts: {
        async openExternal(sessionId, artifactId) {
          artifactCalls.open.push({ sessionId, artifactId });
          return { ok: true };
        },
        async reveal(sessionId, artifactId) {
          artifactCalls.reveal.push({ sessionId, artifactId });
          return { ok: true };
        },
      },
    },
  });
  const input = window.document.getElementById('chatInput');
  const sendButton = window.document.getElementById('sendButton');

  input.value = 'Create session for artifact actions';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUi(window, 20);

  const timeline = window.document.getElementById('chatTimeline');
  timeline.insertAdjacentHTML(
    'beforeend',
    '<button type="button" data-inv-artifact-action="open" data-artifact-id="artifact-1">Open</button>'
      + '<button type="button" data-inv-artifact-action="reveal" data-artifact-id="artifact-1">Reveal</button>'
  );
  timeline.querySelector('[data-inv-artifact-action="open"]').click();
  timeline.querySelector('[data-inv-artifact-action="reveal"]').click();
  await waitForUi(window, 20);

  assert.deepEqual(artifactCalls.open, [{ sessionId: 'session-1', artifactId: 'artifact-1' }]);
  assert.deepEqual(artifactCalls.reveal, [{ sessionId: 'session-1', artifactId: 'artifact-1' }]);
});

test('renderer surfaces resolved artifact open failures from transcript actions', async (t) => {
  const { window } = await loadRendererTestApp(t, {
    shell: {
      artifacts: {
        async openExternal() {
          return { ok: false, result: 'No application is associated with this file.' };
        },
      },
    },
  });
  const input = window.document.getElementById('chatInput');
  const sendButton = window.document.getElementById('sendButton');
  input.value = 'Create session for artifact failure';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUi(window, 20);

  const timeline = window.document.getElementById('chatTimeline');
  timeline.insertAdjacentHTML(
    'beforeend',
    '<button type="button" data-inv-artifact-action="open" data-artifact-id="artifact-fail">Open</button>'
  );
  timeline.querySelector('[data-inv-artifact-action="open"]').click();
  await waitForUi(window, 30);

  assert.match(
    window.document.getElementById('toastViewport').textContent,
    /Open External Failed|No application is associated/
  );
});

test('renderer renders composer tool toggles, updates state, and includes toolPreferences in startStream payload', async (t) => {
  const { window, shell } = await loadRendererTestApp(t, {
    shell: {
      tools: {
        async list() {
          return [
            { name: 'web_search', description: 'Web search' },
            { name: 'Bash', description: 'Terminal' },
            { name: 'list_dir', description: 'List directory' },
          ];
        },
      },
    },
  });
  const input = window.document.getElementById('chatInput');
  const sendButton = window.document.getElementById('sendButton');
  const contextUsageSlot = window.document.getElementById('composerContextUsageSlot');

  await waitForUi(window, 40);
  const webToggle = window.document.querySelector('[data-inv-toggle="tool-toggle-web_search"]');
  assert.ok(webToggle);
  assert.equal(
    webToggle.getAttribute('aria-checked'),
    'false',
    'web starts off — hydrated from the stub persisted config (tools.web=false)'
  );
  const bashToggle = window.document.querySelector('[data-inv-toggle="tool-toggle-Bash"]');
  assert.ok(bashToggle);
  bashToggle.click();

  input.value = 'Check tool preferences';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUi(window, 25);

  assert.equal(shell.__state.chatCalls.length, 1);
  assert.equal(
    shell.__state.chatCalls[0].toolPreferences?.web_search,
    false,
    'hydrated-off web reaches the send payload'
  );
  assert.equal(
    shell.__state.chatCalls[0].toolPreferences?.Bash,
    false,
    'user-disabled Bash reaches the send payload'
  );
  assert.equal(shell.__state.chatCalls[0].toolPreferences?.file_tools, true);

  await shell.__emitChat({
    type: 'complete',
    sessionId: 'session-1',
    streamId: 'stream-test-1',
    content: 'Done',
    usage: { total_tokens: 5000 },
    context_tokens_estimate: 4000,
    model: 'claude-4.6',
  });
  await waitForUi(window, 30);

  const contextRing = contextUsageSlot.querySelector('#composerContextRing');
  assert.ok(contextRing, 'ambient context ring renders after chat.done usage arrives');
  assert.match(contextRing.getAttribute('aria-label'), /context/i);
});

test('renderer reconciles backend readiness after startup bindings when the initial snapshot is stale', async (t) => {
  let getStatusCalls = 0;
  const { window } = await loadRendererTestApp(t, {
    shell: {
      backend: {
        async getStatus() {
          getStatusCalls += 1;
          if (getStatusCalls === 1) {
            return {
              phase: 'starting',
              detail: 'Connecting to backend...',
              mode: 'managed-dev',
            };
          }
          return {
            phase: 'ready',
            detail: 'Managed sidecar process is ready.',
            mode: 'managed-dev',
            startupStage: 'spawned',
            startupMs: 250,
          };
        },
      },
    },
  });

  await waitForUi(window, 40);

  assert.ok(getStatusCalls >= 2);
  assert.equal(window.__rendererState.backend.phase, 'ready');
  assert.equal(window.document.getElementById('authOverlay'), null);
  assert.equal(window.document.getElementById('startupOverlay')?.classList.contains('hidden') ?? true, true);
});

test('renderer keeps the composer usable at model_unavailable and sends the retry prompt', async (t) => {
  const { window, shell } = await loadRendererTestApp(t, {
    shell: {
      backend: {
        async getStatus() {
          return {
            phase: 'model_unavailable',
            detail: '',
            mode: 'managed-dev',
            model_state: 'unavailable',
          };
        },
      },
    },
  });

  await waitForUi(window, 40);
  assert.equal(window.__rendererState.backend.phase, 'model_unavailable');

  const input = window.document.getElementById('chatInput');
  const sendButton = window.document.getElementById('sendButton');
  // Sending IS the retry: the backend re-attempts the configured default on
  // the next turn, so a failed lazy load must not lock the composer.
  assert.equal(input.disabled, false, 'composer input stays enabled at model_unavailable');

  const curtain = window.document.getElementById('startupOverlay');
  assert.match(curtain.textContent, /configured model is unavailable/i);
  // The curtain owns the failure message while it is up; no second surface
  // restates it underneath.
  assert.equal(window.document.getElementById('backendBanner'), null);

  const newChatButton = window.document.getElementById('newChatButton');
  if (newChatButton) {
    assert.equal(newChatButton.disabled, false, 'New Chat stays enabled at model_unavailable');
  }

  input.value = 'try that again';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  await waitForUi(window, 10);
  assert.equal(sendButton.disabled, false, 'send button enables with a draft at model_unavailable');

  sendButton.click();
  await waitForUi(window, 20);
  assert.equal(shell.__state.chatCalls.length, 1, 'the retry send reaches the backend instead of being dropped');
});

test('renderer preserves backend-ready state when bootstrap resolves with a stale starting snapshot', async (t) => {
  const { window } = await loadRendererTestApp(t, {
    shell: {
      backend: {
        async getStatus({ emitBackendStatus }) {
          setTimeout(() => {
            void emitBackendStatus({
              phase: 'ready',
              detail: 'Managed sidecar process is ready.',
              mode: 'managed-dev',
              startupStage: 'spawned',
              startupMs: 400,
            });
          }, 5);
          await new Promise((resolve) => setTimeout(resolve, 60));
          return {
            phase: 'starting',
            detail: 'Connecting to backend...',
            mode: 'managed-dev',
          };
        },
      },
    },
  });

  // The curtain drops only after backend-ready AND boot-view-ready, and the
  // boot-view half fires once hydration has landed (startup-reveal F1), so
  // wait for the dismissal itself rather than a fixed slice of time.
  let overlayHidden = false;
  for (let attempt = 0; attempt < 150 && !overlayHidden; attempt += 1) {
    await waitForUi(window, 20);
    const overlay = window.document.getElementById('startupOverlay');
    overlayHidden = !overlay || overlay.classList.contains('hidden');
  }

  assert.equal(window.__rendererState.backend.phase, 'ready');
  assert.equal(window.document.getElementById('authOverlay'), null);
  assert.equal(overlayHidden, true, 'startup overlay dismissed after a stale starting snapshot');
});
