const test = require('node:test');
const assert = require('node:assert/strict');
const {
  loadRendererApp,
  waitForUi,
} = require('./helpers/renderer-shell-harness');

// W1-5: the Artifacts studio view is gone — every test here boots with the
// split review panel enabled and asserts against the artifactReview* surface.

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

test('mermaid tool artifacts render source fallback when preview rendering fails', async () => {
  const app = await loadRendererApp({
    artifactReviewPreferences: { enabled: true, collapsed: false, width: 420 },
    shell: {
      chat: {
        async startStream(payload, { state }) {
          const sessionId = 'session-artifacts-mermaid';
          state.sessions = [{
            id: sessionId,
            title: 'Mermaid Artifact Session',
            conversation_mode: payload.conversationMode || 'chat',
            preferred_model: payload.preferredModel || 'gpt-test',
            reasoning_effort: payload.reasoningEffort || 'default',
            interactive_round_count: 0,
            interactive_sequence_state: 'idle',
            pending_question_batch: null,
            updated_at: new Date().toISOString(),
          }];
          state.messagesBySession.set(sessionId, []);
          return { sessionId, streamId: 'stream-artifacts-mermaid' };
        },
      },
    },
  });
  const { window, shell } = app;
  const doc = window.document;
  const input = doc.getElementById('chatInput');
  const sendButton = doc.getElementById('sendButton');

  try {
    installDirectMermaidRenderer(window, {
      ok: false,
      error: 'render failed',
    });
    input.value = 'Create a mermaid artifact';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    sendButton.click();
    await waitForUi(window, 20);

    await shell.__emitChat({
      type: 'tool_use',
      sessionId: 'session-artifacts-mermaid',
      streamId: 'stream-artifacts-mermaid',
      callId: 'call-mermaid-1',
      toolName: 'mermaid_generate',
      summary: 'Mermaid scaffold',
      input: { prompt: 'butterfly effect flow', diagram_type: 'flowchart' },
      status: 'running',
    });
    await shell.__emitChat({
      type: 'tool_result',
      sessionId: 'session-artifacts-mermaid',
      streamId: 'stream-artifacts-mermaid',
      callId: 'call-mermaid-1',
      toolName: 'mermaid_generate',
      summary: 'Mermaid scaffold',
      content: JSON.stringify({
        diagram_type: 'flowchart',
        mermaid: 'flowchart TD\nA[Butterfly] --> B[Storm]',
      }),
      isError: false,
      approvalState: 'auto',
      durationMs: 10,
    });
    await waitForUi(window, 40);

    // W1-5: the review panel is open (boot prefs) and auto-selects the newest
    // artifact for the session — no navigation needed.
    await waitForUi(window, 50);

    assert.ok(doc.querySelector('#artifactReviewPreviewContent .artifact-preview-mermaid-host'));
    await waitForUi(window, 20);
    await settleMermaidFrame(window, '#artifactReviewPreviewContent .artifact-preview-mermaid-host iframe', {
      ok: false,
      error: 'render failed',
    });
    assert.match(doc.getElementById('artifactReviewPreviewContent').textContent, /preview (failed|unavailable)/i);
    const source = doc.querySelector('.artifact-preview-mermaid-source');
    assert.ok(source);
    assert.match(source.textContent, /flowchart TD/);
  } finally {
    await app.dispose();
  }
});

test('artifact cache resets across auth logout/login so stale missing-image state is not retained', async () => {
  const app = await loadRendererApp({
    artifactReviewPreferences: { enabled: true, collapsed: false, width: 420 },
    shell: {
      chat: {
        async startStream(payload, { state }) {
          const sessionId = 'session-artifacts-reset';
          state.sessions = [{
            id: sessionId,
            title: 'Artifact Reset Session',
            conversation_mode: payload.conversationMode || 'chat',
            preferred_model: payload.preferredModel || 'gpt-test',
            reasoning_effort: payload.reasoningEffort || 'default',
            interactive_round_count: 0,
            interactive_sequence_state: 'idle',
            pending_question_batch: null,
            updated_at: new Date().toISOString(),
          }];
          state.messagesBySession.set(sessionId, []);
          return { sessionId, streamId: 'stream-artifacts-reset' };
        },
      },
    },
  });
  const { dom, window, shell } = app;
  const doc = window.document;
  const input = doc.getElementById('chatInput');
  const sendButton = doc.getElementById('sendButton');

  try {
    dispatchPastedImage(window, input, 'reset-cache.png');
    await waitForUi(window, 20);
    input.value = 'Describe this screenshot';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    sendButton.click();
    await waitForUi(window, 90);

    // W1-5: the review panel renders on chat (boot prefs) — no navigation.
    await waitForUi(window, 30);

    const firstPreview = doc.querySelector('.artifact-preview-image');
    assert.ok(firstPreview);
    firstPreview.dispatchEvent(new window.Event('error'));
    await waitForUi(window, 20);
    assert.equal(doc.querySelector('.artifact-preview-image'), null);

    await shell.__emitAuthState({ authenticated: false, user: null });
    await waitForUi(window, 40);
    await shell.__emitAuthState({ authenticated: true, user: { email: 'dev@example.com' } });
    await waitForUi(window, 40);

    dispatchPastedImage(window, input, 'reset-cache.png');
    await waitForUi(window, 20);
    input.value = 'Describe this screenshot again';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    sendButton.click();
    await waitForUi(window, 90);

    const secondPreview = doc.querySelector('.artifact-preview-image');
    assert.ok(secondPreview);
    assert.equal(doc.getElementById('artifactReviewDetailEmpty').classList.contains('hidden'), true);
  } finally {
    await app.dispose();
  }
});

test('markdown generated artifacts open in the reader and can edit source through artifact IPC', async () => {
  const saves = [];
  const app = await loadRendererApp({
    artifactReviewPreferences: { enabled: true, collapsed: false, width: 420 },
    shell: {
      artifacts: {
        async read(sessionId, artifactId) {
          return {
            artifact: {
              artifact_id: artifactId,
              title: 'Scratch Plan',
              editable: true,
              status: 'available',
              language: 'markdown',
              display_path: `.jenny/artifacts/${sessionId}/scratch-plan.md`,
              absolute_path: `C:/workspace/.jenny/artifacts/${sessionId}/scratch-plan.md`,
            },
            content: [
              '# Scratch Plan',
              '',
              '## User Review Required',
              '',
              '- first draft',
              '',
              '## Proposed Changes',
              '',
              '### Renderer',
              '',
              '- Add the reader outline.',
              '',
              '## Verification Plan',
              '',
              '```js',
              'console.log("copy me");',
              '```',
            ].join('\n'),
          };
        },
        async save(sessionId, artifactId, content) {
          saves.push({ sessionId, artifactId, content });
          return {
            artifact: {
              artifact_id: artifactId,
              editable: true,
              status: 'available',
            },
          };
        },
      },
      chat: {
        async startStream(payload, { state }) {
          const sessionId = 'session-artifacts-generated';
          state.sessions = [{
            id: sessionId,
            title: 'Generated Artifact Session',
            conversation_mode: payload.conversationMode || 'chat',
            preferred_model: payload.preferredModel || 'gpt-test',
            reasoning_effort: payload.reasoningEffort || 'default',
            interactive_round_count: 0,
            interactive_sequence_state: 'idle',
            pending_question_batch: null,
            updated_at: new Date().toISOString(),
          }];
          state.messagesBySession.set(sessionId, []);
          return { sessionId, streamId: 'stream-artifacts-generated' };
        },
      },
    },
  });
  const { window, shell } = app;
  const doc = window.document;
  const input = doc.getElementById('chatInput');
  const sendButton = doc.getElementById('sendButton');

  try {
    input.value = 'Make a scratch plan';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    sendButton.click();
    await waitForUi(window, 20);

    await shell.__emitChat({
      type: 'tool_use',
      sessionId: 'session-artifacts-generated',
      streamId: 'stream-artifacts-generated',
      callId: 'call-generated-1',
      toolName: 'CreateArtifact',
      summary: 'Create scratch plan',
      input: { artifact_kind: 'document', title: 'Scratch Plan' },
      status: 'running',
    });
    await shell.__emitChat({
      type: 'tool_result',
      sessionId: 'session-artifacts-generated',
      streamId: 'stream-artifacts-generated',
      callId: 'call-generated-1',
      toolName: 'CreateArtifact',
      summary: 'Create scratch plan',
      content: 'Created document "Scratch Plan" at .jenny/artifacts/session-artifacts-generated/scratch-plan.md',
      isError: false,
      approvalState: 'auto',
      durationMs: 12,
      generatedArtifacts: [{
        artifact_id: 'artifact_file_session-artifacts-generated_scratch-plan',
        artifact_kind: 'document',
        title: 'Scratch Plan',
        file_name: 'scratch-plan.md',
        display_path: '.jenny/artifacts/session-artifacts-generated/scratch-plan.md',
        absolute_path: 'C:/workspace/.jenny/artifacts/session-artifacts-generated/scratch-plan.md',
        language: 'markdown',
        editable: true,
        status: 'available',
      }],
    });
    await waitForUi(window, 40);

    // W1-5: the review panel is open (boot prefs) and auto-selects the newest
    // artifact; the split surface renders the compact outline shell.
    await waitForUi(window, 60);

    const editor = doc.getElementById('artifactReviewEditorFallback');
    const saveButton = doc.getElementById('artifactReviewSaveButton');

    assert.match(doc.getElementById('artifactReviewDetailTitle').textContent, /Scratch Plan/);
    const fullDocument = doc.querySelector('#artifactReviewPreviewContent .artifact-document');
    assert.ok(fullDocument);
    assert.equal(fullDocument.dataset.artifactDocumentHint, 'plan');
    assert.match(fullDocument.textContent, /first draft/);
    assert.ok(fullDocument.querySelector('.artifact-document-outline-compact'));
    assert.ok(fullDocument.querySelector('[data-artifact-document-progress]'));
    assert.ok(fullDocument.querySelector('[data-artifact-document-back-to-top]'));
    assert.equal(fullDocument.querySelectorAll('[data-artifact-document-outline-target]').length, 5);
    assert.equal(doc.getElementById('artifactReviewEditorShell').classList.contains('hidden'), true);

    const scroller = doc.querySelector('#artifactReviewPanel .artifact-review-scroll');
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1200 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 400 });
    const proposedHeading = doc.getElementById('proposed-changes');
    Object.defineProperty(proposedHeading, 'offsetTop', { configurable: true, value: 360 });
    const proposedButton = fullDocument.querySelector('[data-artifact-document-outline-target="proposed-changes"]');
    proposedButton.click();
    await waitForUi(window, 20);

    assert.ok(scroller.scrollTop > 0);
    assert.equal(proposedButton.getAttribute('aria-current'), 'true');
    assert.match(fullDocument.querySelector('[data-artifact-document-progress-bar]').style.width, /%/);

    const rendererHeading = doc.getElementById('renderer');
    Object.defineProperty(rendererHeading, 'offsetTop', { configurable: true, value: 540 });
    const rendererButton = fullDocument.querySelector('[data-artifact-document-outline-target="renderer"]');
    rendererButton.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await waitForUi(window, 20);
    assert.equal(rendererButton.getAttribute('aria-current'), 'true');

    const verificationHeading = doc.getElementById('verification-plan');
    Object.defineProperty(verificationHeading, 'offsetTop', { configurable: true, value: 760 });
    const verificationButton = fullDocument.querySelector('[data-artifact-document-outline-target="verification-plan"]');
    verificationButton.dispatchEvent(new window.KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    await waitForUi(window, 20);
    assert.equal(verificationButton.getAttribute('aria-current'), 'true');

    const copied = [];
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: {
        async writeText(text) {
          copied.push(text);
        },
      },
    });
    fullDocument.querySelector('[data-artifact-document-copy-code]').click();
    await waitForUi(window, 20);
    assert.equal(copied.length, 1);
    assert.match(copied[0], /copy me/);

    scroller.scrollTop = 640;
    fullDocument.querySelector('[data-artifact-document-back-to-top]').click();
    await waitForUi(window, 20);
    assert.equal(scroller.scrollTop, 0);
    assert.equal(fullDocument.querySelector('[data-artifact-document-outline-target="scratch-plan"]').getAttribute('aria-current'), 'true');

    doc.querySelector('[data-artifact-document-view="source"]').click();
    await waitForUi(window, 20);

    const sourceDocument = doc.querySelector('#artifactReviewPreviewContent .artifact-document');
    assert.equal(sourceDocument.dataset.artifactDocumentMode, 'source');
    assert.equal(sourceDocument.querySelector('[data-artifact-document-reader-chrome]').hidden, true);
    assert.equal(sourceDocument.querySelector('[data-artifact-document-back-to-top]').hidden, true);
    assert.ok(editor);
    assert.match(editor.value, /first draft/);
    const monacoWorkerUrl = window.MonacoEnvironment?.getWorkerUrl?.(
      'vs/base/worker/workerMain',
      'editorWorkerService'
    );
    if (typeof monacoWorkerUrl === 'string' && monacoWorkerUrl.length > 0) {
      assert.doesNotMatch(monacoWorkerUrl, /^data:/);
    }

    editor.value = '# Scratch Plan\n\n- updated';
    editor.dispatchEvent(new window.Event('input', { bubbles: true }));
    await waitForUi(window, 20);

    assert.equal(saveButton.disabled, false);
    saveButton.click();
    await waitForUi(window, 30);

    assert.equal(saves.length, 1);
    assert.equal(saves[0].sessionId, 'session-artifacts-generated');
    assert.equal(saves[0].artifactId, 'artifact_file_session-artifacts-generated_scratch-plan');
    assert.match(saves[0].content, /updated/);
  } finally {
    await app.dispose();
  }
});

test('read-only markdown generated artifacts degrade to a bounded note instead of a blank reader', async () => {
  const app = await loadRendererApp({
    artifactReviewPreferences: { enabled: true, collapsed: false, width: 420 },
    shell: {
      artifacts: {
        async read(sessionId, artifactId) {
          return {
            artifact: {
              artifact_id: artifactId,
              title: 'Large Plan',
              editable: false,
              status: 'available',
              language: 'markdown',
              display_path: `.jenny/artifacts/${sessionId}/large-plan.md`,
              absolute_path: `C:/workspace/.jenny/artifacts/${sessionId}/large-plan.md`,
            },
            content: '',
          };
        },
      },
      chat: {
        async startStream(payload, { state }) {
          const sessionId = 'session-artifacts-readonly-markdown';
          state.sessions = [{
            id: sessionId,
            title: 'Read-only Markdown Artifact Session',
            conversation_mode: payload.conversationMode || 'chat',
            preferred_model: payload.preferredModel || 'gpt-test',
            reasoning_effort: payload.reasoningEffort || 'default',
            interactive_round_count: 0,
            interactive_sequence_state: 'idle',
            pending_question_batch: null,
            updated_at: new Date().toISOString(),
          }];
          state.messagesBySession.set(sessionId, []);
          return { sessionId, streamId: 'stream-artifacts-readonly-markdown' };
        },
      },
    },
  });
  const { window, shell } = app;
  const doc = window.document;
  const input = doc.getElementById('chatInput');
  const sendButton = doc.getElementById('sendButton');

  try {
    input.value = 'Make a large plan';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    sendButton.click();
    await waitForUi(window, 20);

    await shell.__emitChat({
      type: 'tool_use',
      sessionId: 'session-artifacts-readonly-markdown',
      streamId: 'stream-artifacts-readonly-markdown',
      callId: 'call-readonly-markdown-1',
      toolName: 'CreateArtifact',
      summary: 'Create large plan',
      input: { artifact_kind: 'document', title: 'Large Plan' },
      status: 'running',
    });
    await shell.__emitChat({
      type: 'tool_result',
      sessionId: 'session-artifacts-readonly-markdown',
      streamId: 'stream-artifacts-readonly-markdown',
      callId: 'call-readonly-markdown-1',
      toolName: 'CreateArtifact',
      summary: 'Create large plan',
      content: 'Created document "Large Plan" at .jenny/artifacts/session-artifacts-readonly-markdown/large-plan.md',
      isError: false,
      approvalState: 'auto',
      durationMs: 12,
      generatedArtifacts: [{
        artifact_id: 'artifact_file_session-artifacts-readonly-markdown_large-plan',
        artifact_kind: 'document',
        title: 'Large Plan',
        file_name: 'large-plan.md',
        display_path: '.jenny/artifacts/session-artifacts-readonly-markdown/large-plan.md',
        absolute_path: 'C:/workspace/.jenny/artifacts/session-artifacts-readonly-markdown/large-plan.md',
        language: 'markdown',
        editable: false,
        status: 'available',
      }],
    });
    await waitForUi(window, 40);

    // W1-5: the review panel is open (boot prefs) and auto-selects the newest
    // artifact — no navigation needed.
    await waitForUi(window, 60);

    assert.equal(doc.querySelector('.artifact-document'), null);
    assert.match(doc.getElementById('artifactReviewDetailNote').textContent, /read-only|large|open externally/i);
    assert.match(doc.getElementById('artifactReviewPreviewContent').textContent, /open externally|reveal/i);
    assert.equal(doc.getElementById('artifactReviewEditorShell').classList.contains('hidden'), true);
    assert.equal(doc.getElementById('artifactReviewSaveButton').disabled, true);
  } finally {
    await app.dispose();
  }
});

