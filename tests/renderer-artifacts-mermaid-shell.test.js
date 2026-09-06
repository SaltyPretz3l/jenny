const test = require('node:test');
const assert = require('node:assert/strict');
const {
  loadRendererApp,
  waitForUi,
} = require('./helpers/renderer-shell-harness');

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

function installDirectMermaidRenderer(window, options = {}) {
  const mermaidUtils = window.rendererMermaidUtils;
  assert.ok(mermaidUtils, 'expected rendererMermaidUtils on window');
  mermaidUtils.renderMermaidDirect = async (host, source, renderOptions = {}) => {
    if (options.ok === false) {
      renderOptions.onFailure?.({ ok: false, error: options.error || 'render failed' });
      return;
    }
    host.innerHTML = `<svg class="artifact-test-mermaid-svg" data-source="${String(source || '').replace(/"/g, '&quot;')}"><text>${String(source || '')}</text></svg>`;
    renderOptions.onSuccess?.({ ok: true, height: options.height || 220 });
  };
  mermaidUtils.attachMermaidControls = (host) => {
    host.setAttribute('data-mermaid-controls', 'true');
  };
}

test('generated Mermaid artifacts render preview-first and support editing and saving in the split review rail', async () => {
  const saves = [];
  const app = await loadRendererApp({
    artifactReviewPreferences: { enabled: true, collapsed: false, width: 420 },
    shell: {
      artifacts: {
        async read(sessionId, artifactId) {
          return {
            artifact: {
              artifact_id: artifactId,
              title: 'Butterfly Effect Diagram',
              editable: true,
              status: 'available',
              language: 'mermaid',
              display_path: `.jenny/artifacts/${sessionId}/butterfly-effect.mermaid`,
              absolute_path: `C:/workspace/.jenny/artifacts/${sessionId}/butterfly-effect.mermaid`,
            },
            content: 'flowchart TD\nA[Butterfly] --> B[Storm]',
          };
        },
        async save(sessionId, artifactId, content) {
          saves.push({ sessionId, artifactId, content });
          return { artifact: { artifact_id: artifactId, editable: true, status: 'available' } };
        },
      },
      chat: {
        async startStream(payload, { state }) {
          const sessionId = 'session-artifacts-mermaid-file';
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
          return { sessionId, streamId: 'stream-artifacts-mermaid-file' };
        },
      },
    },
  });
  const { window, shell } = app;
  const doc = window.document;
  const input = doc.getElementById('chatInput');
  const sendButton = doc.getElementById('sendButton');

  try {
    installDirectMermaidRenderer(window);
    setWorkspaceWidths(window, doc, 1600);
    await waitForUi(window, 30);

    input.value = 'Create a butterfly diagram artifact';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    sendButton.click();
    await waitForUi(window, 20);

    await shell.__emitChat({
      type: 'tool_use',
      sessionId: 'session-artifacts-mermaid-file',
      streamId: 'stream-artifacts-mermaid-file',
      callId: 'call-mermaid-file-1',
      toolName: 'CreateArtifact',
      summary: 'Create butterfly diagram',
      input: { artifact_kind: 'document', title: 'Butterfly Effect Diagram' },
      status: 'running',
    });
    await shell.__emitChat({
      type: 'tool_result',
      sessionId: 'session-artifacts-mermaid-file',
      streamId: 'stream-artifacts-mermaid-file',
      callId: 'call-mermaid-file-1',
      toolName: 'CreateArtifact',
      summary: 'Create butterfly diagram',
      content: 'Created document "Butterfly Effect Diagram" at .jenny/artifacts/session-artifacts-mermaid-file/butterfly-effect.mmd',
      isError: false,
      approvalState: 'auto',
      durationMs: 12,
        generatedArtifacts: [{
          artifact_id: 'artifact_file_session-artifacts-mermaid-file_butterfly-effect',
          artifact_kind: 'document',
          title: 'Butterfly Effect Diagram',
          file_name: 'butterfly-effect.mermaid',
          display_path: '.jenny/artifacts/session-artifacts-mermaid-file/butterfly-effect.mermaid',
          absolute_path: 'C:/workspace/.jenny/artifacts/session-artifacts-mermaid-file/butterfly-effect.mermaid',
          language: '',
          editable: true,
          status: 'available',
      }],
    });
    await waitForUi(window, 40);

    // W1-5: the studio view is gone — auto-open selects the generated artifact
    // in the split review rail; no navigation needed.
    await waitForUi(window, 60);

    assert.equal(doc.getElementById('artifactReviewPanel').classList.contains('hidden'), false);
    assert.ok(doc.querySelector('#artifactReviewPreviewContent .artifact-preview-mermaid-host'));
    await waitForUi(window, 20);
    assert.ok(doc.querySelector('#artifactReviewPreviewContent .artifact-preview-mermaid-host svg'));
    assert.equal(doc.querySelector('#artifactReviewPreviewContent .artifact-preview-mermaid-host').getAttribute('data-mermaid-controls'), 'true');
    assert.match(doc.getElementById('artifactReviewPreviewContent').textContent, /Butterfly/);
    assert.equal(doc.getElementById('artifactReviewEditorShell').classList.contains('hidden'), true);

    doc.querySelector('#artifactReviewPanel [data-inv-segmented="artifact-view"] [data-value="code"]').click();
    await waitForUi(window, 30);

    const editor = doc.getElementById('artifactReviewEditorFallback');
    assert.equal(doc.getElementById('artifactReviewEditorShell').classList.contains('hidden'), false);
    assert.match(editor.value, /flowchart TD/);

    editor.value = 'flowchart TD\nA[Butterfly] --> B[Storm]\nB --> C[Chaos]';
    editor.dispatchEvent(new window.Event('input', { bubbles: true }));
    await waitForUi(window, 20);

    doc.getElementById('artifactReviewSaveButton').click();
    await waitForUi(window, 30);

    assert.equal(saves.length, 1);
    assert.equal(saves[0].artifactId, 'artifact_file_session-artifacts-mermaid-file_butterfly-effect');
    assert.match(saves[0].content, /Chaos/);
  } finally {
    await app.dispose();
  }
});

test('generated Mermaid artifacts render preview-first in the split review rail when language metadata is blank', async () => {
  const app = await loadRendererApp({
    artifactReviewPreferences: { enabled: true, collapsed: false, width: 420 },
    shell: {
      artifacts: {
        async read(sessionId, artifactId) {
          return {
            artifact: {
              artifact_id: artifactId,
              title: 'Split Butterfly Diagram',
              editable: true,
              status: 'available',
              language: 'mermaid',
              display_path: `.jenny/artifacts/${sessionId}/split-butterfly.mermaid`,
              absolute_path: `C:/workspace/.jenny/artifacts/${sessionId}/split-butterfly.mermaid`,
            },
            content: 'flowchart TD\nA[Butterfly] --> B[Storm]',
          };
        },
      },
      chat: {
        async startStream(payload, { state }) {
          const sessionId = 'session-artifacts-mermaid-split';
          state.sessions = [{
            id: sessionId,
            title: 'Split Mermaid Artifact Session',
            conversation_mode: payload.conversationMode || 'chat',
            preferred_model: payload.preferredModel || 'gpt-test',
            reasoning_effort: payload.reasoningEffort || 'default',
            interactive_round_count: 0,
            interactive_sequence_state: 'idle',
            pending_question_batch: null,
            updated_at: new Date().toISOString(),
          }];
          state.messagesBySession.set(sessionId, []);
          return { sessionId, streamId: 'stream-artifacts-mermaid-split' };
        },
      },
    },
  });
  const { window, shell } = app;
  const doc = window.document;
  const input = doc.getElementById('chatInput');
  const sendButton = doc.getElementById('sendButton');

  try {
    installDirectMermaidRenderer(window);
    setWorkspaceWidths(window, doc, 1600);
    await waitForUi(window, 30);

    input.value = 'Create split butterfly diagram';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    sendButton.click();
    await waitForUi(window, 20);

    await shell.__emitChat({
      type: 'tool_use',
      sessionId: 'session-artifacts-mermaid-split',
      streamId: 'stream-artifacts-mermaid-split',
      callId: 'call-mermaid-split-1',
      toolName: 'CreateArtifact',
      summary: 'Create split butterfly diagram',
      input: { artifact_kind: 'document', title: 'Split Butterfly Diagram' },
      status: 'running',
    });
    await shell.__emitChat({
      type: 'tool_result',
      sessionId: 'session-artifacts-mermaid-split',
      streamId: 'stream-artifacts-mermaid-split',
      callId: 'call-mermaid-split-1',
      toolName: 'CreateArtifact',
      summary: 'Create split butterfly diagram',
      content: 'Created document "Split Butterfly Diagram" at .jenny/artifacts/session-artifacts-mermaid-split/split-butterfly.mermaid',
      isError: false,
      approvalState: 'auto',
      durationMs: 12,
        generatedArtifacts: [{
          artifact_id: 'artifact_file_session-artifacts-mermaid-split_split-butterfly',
          artifact_kind: 'document',
          title: 'Split Butterfly Diagram',
          file_name: 'split-butterfly.mermaid',
          display_path: '.jenny/artifacts/session-artifacts-mermaid-split/split-butterfly.mermaid',
          absolute_path: 'C:/workspace/.jenny/artifacts/session-artifacts-mermaid-split/split-butterfly.mermaid',
          language: '',
          editable: true,
          status: 'available',
      }],
    });
    await waitForUi(window, 40);

    // W1-5: the studio view is gone — the panel auto-opens on the chat view.
    await waitForUi(window, 60);

    assert.equal(doc.getElementById('artifactReviewPanel').classList.contains('hidden'), false);
    assert.ok(doc.querySelector('#artifactReviewDetailMeta .artifact-detail-meta-item'));
    assert.ok(doc.querySelector('#artifactReviewPreviewContent .artifact-preview-mermaid-host'));
    await waitForUi(window, 20);
    assert.ok(doc.querySelector('#artifactReviewPreviewContent .artifact-preview-mermaid-host svg'));
    assert.equal(doc.querySelector('#artifactReviewPreviewContent .artifact-preview-mermaid-host').getAttribute('data-mermaid-controls'), 'true');
    assert.match(doc.getElementById('artifactReviewDetailPath').textContent, /split-butterfly\.mermaid/i);
  } finally {
    await app.dispose();
  }
});

test('Monaco failures fall back once per window without repeated renderer global errors', async () => {
  const app = await loadRendererApp({
    artifactReviewPreferences: { enabled: true, collapsed: false, width: 420 },
    shell: {
      artifacts: {
        async read(sessionId, artifactId) {
          return {
            artifact: {
              artifact_id: artifactId,
              title: 'Scratch Script',
              editable: true,
              status: 'available',
              language: 'javascript',
              display_path: `.jenny/artifacts/${sessionId}/scratch-script.js`,
              absolute_path: `C:/workspace/.jenny/artifacts/${sessionId}/scratch-script.js`,
            },
            content: 'console.log("first draft");',
          };
        },
      },
      chat: {
        async startStream(payload, { state }) {
          const sessionId = 'session-artifacts-monaco-fallback';
          state.sessions = [{
            id: sessionId,
            title: 'Monaco Fallback Session',
            conversation_mode: payload.conversationMode || 'chat',
            preferred_model: payload.preferredModel || 'gpt-test',
            reasoning_effort: payload.reasoningEffort || 'default',
            interactive_round_count: 0,
            interactive_sequence_state: 'idle',
            pending_question_batch: null,
            updated_at: new Date().toISOString(),
          }];
          state.messagesBySession.set(sessionId, []);
          return { sessionId, streamId: 'stream-artifacts-monaco-fallback' };
        },
      },
    },
  });
  const { window, shell } = app;
  const doc = window.document;
  const input = doc.getElementById('chatInput');
  const sendButton = doc.getElementById('sendButton');
  let requireCalls = 0;

  try {
    window.require = function failingRequire(modules, _success, failure) {
      // Only intercept AMD-style Monaco loader calls (vs/editor/editor.main).
      // Other consumers (e.g. renderer-turn-row-projector's CommonJS-style
      // require('./renderer-turn-view-model')) must pass through silently.
      const moduleList = Array.isArray(modules) ? modules : [];
      const isMonacoCall = moduleList.some((m) => String(m || '').startsWith('vs/'));
      if (!isMonacoCall) return undefined;
      requireCalls += 1;
      if (typeof failure === 'function') {
        failure(new Error('editor.main load failed'));
      }
      return undefined;
    };
    window.require.config = function configure() {};

    setWorkspaceWidths(window, doc, 1600);
    await waitForUi(window, 30);

    input.value = 'Make a scratch script';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    sendButton.click();
    await waitForUi(window, 20);

    await shell.__emitChat({
      type: 'tool_use',
      sessionId: 'session-artifacts-monaco-fallback',
      streamId: 'stream-artifacts-monaco-fallback',
      callId: 'call-monaco-fallback-1',
      toolName: 'CreateArtifact',
      summary: 'Create scratch script',
      input: { artifact_kind: 'script', title: 'Scratch Script' },
      status: 'running',
    });
    await shell.__emitChat({
      type: 'tool_result',
      sessionId: 'session-artifacts-monaco-fallback',
      streamId: 'stream-artifacts-monaco-fallback',
      callId: 'call-monaco-fallback-1',
      toolName: 'CreateArtifact',
      summary: 'Create scratch script',
      content: 'Created script "Scratch Script" at .jenny/artifacts/session-artifacts-monaco-fallback/scratch-script.js',
      isError: false,
      approvalState: 'auto',
      durationMs: 12,
      generatedArtifacts: [{
        artifact_id: 'artifact_file_session-artifacts-monaco-fallback_scratch-script',
        artifact_kind: 'script',
        title: 'Scratch Script',
        file_name: 'scratch-script.js',
        display_path: '.jenny/artifacts/session-artifacts-monaco-fallback/scratch-script.js',
        absolute_path: 'C:/workspace/.jenny/artifacts/session-artifacts-monaco-fallback/scratch-script.js',
        language: 'javascript',
        editable: true,
        status: 'available',
      }],
    });
    await waitForUi(window, 40);

    // W1-5: the studio view is gone — the panel auto-opens with the script
    // artifact, attempting Monaco once. Collapse and reopen the panel to force
    // a second editor render; the once-per-window latch must not retry.
    await waitForUi(window, 60);
    doc.getElementById('artifactReviewCollapseButton').click();
    await waitForUi(window, 30);
    doc.getElementById('artifactSplitViewToggle').click();
    await waitForUi(window, 60);

    // The AMD require is no longer the observable proxy for "attempted once":
    // this harness stubs scriptLoaderUtils.ensureScript to resolve false, so
    // ensureMonacoEditorApi short-circuits at 'loader_unavailable' and never
    // reaches amdRequire('vs/editor/editor.main'). Assert the once-per-window
    // latch itself, which is what this test is actually named for.
    assert.equal(requireCalls, 0, 'the loader stub short-circuits before the AMD require');
    const monacoState = window.__jennyMonacoSharedState;
    assert.ok(monacoState, 'the shared Monaco state is installed on the window');
    assert.equal(monacoState.failed, true, 'the failure latches on the shared per-window state');
    assert.equal(monacoState.readyPromise, null, 'the failed attempt clears its in-flight promise');
    assert.equal(
      window.__rendererState.logs.filter((entry) => entry.event === 'renderer.monaco_fallback').length,
      1,
      'the fallback is reported exactly once per window despite the second editor render'
    );
    assert.match(doc.getElementById('artifactReviewEditorFallback').value, /first draft/);
    assert.equal(window.__rendererState.logs.filter((entry) => entry.event === 'renderer.global_error').length, 0);
    assert.doesNotMatch(String(doc.getElementById('toastViewport').textContent || ''), /runtime error occurred/i);
  } finally {
    await app.dispose();
  }
});

test('split view opens generated artifacts in the chat rail and transcript studio actions reuse it', async () => {
  const saves = [];
  const app = await loadRendererApp({
    artifactReviewPreferences: { enabled: true, collapsed: false, width: 420 },
    shell: {
      artifacts: {
        async read(sessionId, artifactId) {
          return {
            artifact: {
              artifact_id: artifactId,
              title: 'Split Scratch Plan',
              editable: true,
              status: 'available',
              language: 'markdown',
              display_path: `.jenny/artifacts/${sessionId}/split-scratch-plan.md`,
              absolute_path: `C:/workspace/.jenny/artifacts/${sessionId}/split-scratch-plan.md`,
            },
            content: [
              '# Split Scratch Plan',
              '',
              '## Goal',
              '',
              '- first draft',
              '',
              '## Context',
              '',
              '## Steps',
              '',
              '## Decision Points',
              '',
              '## Troubleshooting',
            ].join('\n'),
          };
        },
        async save(sessionId, artifactId, content) {
          saves.push({ sessionId, artifactId, content });
          return { artifact: { artifact_id: artifactId, editable: true, status: 'available' } };
        },
      },
      chat: {
        async startStream(payload, { state }) {
          const sessionId = 'session-artifacts-split';
          state.sessions = [{
            id: sessionId,
            title: 'Split Artifact Session',
            conversation_mode: payload.conversationMode || 'chat',
            preferred_model: payload.preferredModel || 'gpt-test',
            reasoning_effort: payload.reasoningEffort || 'default',
            interactive_round_count: 0,
            interactive_sequence_state: 'idle',
            pending_question_batch: null,
            updated_at: new Date().toISOString(),
          }];
          state.messagesBySession.set(sessionId, []);
          return { sessionId, streamId: 'stream-artifacts-split' };
        },
      },
    },
  });
  const { window, shell } = app;
  const doc = window.document;
  const input = doc.getElementById('chatInput');
  const sendButton = doc.getElementById('sendButton');

  try {
    setWorkspaceWidths(window, doc, 1600);
    await waitForUi(window, 30);

    input.value = 'Make a split scratch plan';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    sendButton.click();
    await waitForUi(window, 20);

    await shell.__emitChat({
      type: 'tool_use',
      sessionId: 'session-artifacts-split',
      streamId: 'stream-artifacts-split',
      callId: 'call-split-1',
      toolName: 'CreateArtifact',
      summary: 'Create split scratch plan',
      input: { artifact_kind: 'document', title: 'Split Scratch Plan' },
      status: 'running',
    });
    await shell.__emitChat({
      type: 'tool_result',
      sessionId: 'session-artifacts-split',
      streamId: 'stream-artifacts-split',
      callId: 'call-split-1',
      toolName: 'CreateArtifact',
      summary: 'Create split scratch plan',
      content: 'Created document "Split Scratch Plan" at .jenny/artifacts/session-artifacts-split/split-scratch-plan.md',
      isError: false,
      approvalState: 'auto',
      durationMs: 12,
      generatedArtifacts: [{
        artifact_id: 'artifact_file_session-artifacts-split_split-scratch-plan',
        artifact_kind: 'document',
        title: 'Split Scratch Plan',
        file_name: 'split-scratch-plan.md',
        display_path: '.jenny/artifacts/session-artifacts-split/split-scratch-plan.md',
        absolute_path: 'C:/workspace/.jenny/artifacts/session-artifacts-split/split-scratch-plan.md',
        language: 'markdown',
        editable: true,
        status: 'available',
      }],
    });
    await waitForUi(window, 80);

    const splitToggle = doc.getElementById('artifactSplitViewToggle');
    const splitPanel = doc.getElementById('artifactReviewPanel');
    const splitEditor = doc.getElementById('artifactReviewEditorFallback');

    assert.equal(splitToggle.getAttribute('aria-pressed'), 'true');
    assert.equal(splitPanel.classList.contains('hidden'), false);
    assert.match(doc.getElementById('artifactReviewDetailTitle').textContent, /Split Scratch Plan/);
    const splitDocument = doc.querySelector('#artifactReviewPreviewContent .artifact-document');
    assert.ok(splitDocument);
    assert.equal(splitDocument.dataset.artifactDocumentHint, 'walkthrough');
    assert.match(splitDocument.textContent, /first draft/);
    assert.ok(splitDocument.querySelector('.artifact-document-outline-compact'));
    assert.ok(splitDocument.querySelector('[data-artifact-document-progress]'));
    assert.equal(doc.getElementById('artifactReviewEditorShell').classList.contains('hidden'), true);

    const splitScroller = doc.querySelector('#artifactReviewPanel .artifact-review-scroll');
    Object.defineProperty(splitScroller, 'scrollHeight', { configurable: true, value: 1100 });
    Object.defineProperty(splitScroller, 'clientHeight', { configurable: true, value: 360 });
    const stepsHeading = doc.getElementById('steps');
    Object.defineProperty(stepsHeading, 'offsetTop', { configurable: true, value: 420 });
    const stepsButton = splitDocument.querySelector('[data-artifact-document-outline-target="steps"]');
    stepsButton.click();
    await waitForUi(window, 20);
    assert.ok(splitScroller.scrollTop > 0);
    assert.equal(stepsButton.getAttribute('aria-current'), 'true');

    splitScroller.scrollTop = 620;
    splitDocument.querySelector('[data-artifact-document-back-to-top]').click();
    await waitForUi(window, 20);
    assert.equal(splitScroller.scrollTop, 0);

    doc.querySelector('#artifactReviewPreviewContent [data-artifact-document-view="source"]').click();
    await waitForUi(window, 20);

    const splitSourceDocument = doc.querySelector('#artifactReviewPreviewContent .artifact-document');
    assert.equal(splitSourceDocument.dataset.artifactDocumentMode, 'source');
    assert.equal(splitSourceDocument.querySelector('[data-artifact-document-reader-chrome]').hidden, true);
    assert.equal(splitSourceDocument.querySelector('[data-artifact-document-back-to-top]').hidden, true);
    assert.match(splitEditor.value, /first draft/);
    assert.equal(doc.getElementById('chatTopRailTab').getAttribute('aria-selected'), 'true');

    doc.getElementById('artifactReviewCollapseButton').click();
    await waitForUi(window, 30);
    assert.equal(splitPanel.classList.contains('hidden'), true);
    assert.equal(splitToggle.getAttribute('aria-pressed'), 'false');
    assert.equal(splitToggle.classList.contains('active'), false);

    doc.getElementById('artifactSplitViewToggle').click();
    await waitForUi(window, 30);
    assert.equal(splitPanel.classList.contains('hidden'), false);

    doc.querySelector('[data-inv-artifact-action="panel"]').click();
    await waitForUi(window, 40);
    assert.equal(doc.getElementById('chatTopRailTab').getAttribute('aria-selected'), 'true');
    assert.equal(splitPanel.classList.contains('hidden'), false);
    doc.querySelector('#artifactReviewPreviewContent [data-artifact-document-view="source"]').click();
    await waitForUi(window, 20);

    splitEditor.value = '# Split Scratch Plan\n\n- updated';
    splitEditor.dispatchEvent(new window.Event('input', { bubbles: true }));
    await waitForUi(window, 20);

    const splitSaveButton = doc.getElementById('artifactReviewSaveButton');
    assert.equal(splitSaveButton.disabled, false);
    splitSaveButton.click();
    await waitForUi(window, 30);

    assert.equal(saves.length, 1);
    assert.equal(saves[0].sessionId, 'session-artifacts-split');
    assert.equal(saves[0].artifactId, 'artifact_file_session-artifacts-split_split-scratch-plan');
    assert.match(saves[0].content, /updated/);
  } finally {
    await app.dispose();
  }
});

test('split view opens as an overlay drawer when the chat stage is too narrow (W1-5, studio removed)', async () => {
  const app = await loadRendererApp({
    artifactReviewPreferences: { enabled: true, collapsed: false, width: 420 },
    shell: {
      chat: {
        async startStream(payload, { state }) {
          const sessionId = 'session-artifacts-narrow';
          state.sessions = [{
            id: sessionId,
            title: 'Narrow Artifact Session',
            conversation_mode: payload.conversationMode || 'chat',
            preferred_model: payload.preferredModel || 'gpt-test',
            reasoning_effort: payload.reasoningEffort || 'default',
            interactive_round_count: 0,
            interactive_sequence_state: 'idle',
            pending_question_batch: null,
            updated_at: new Date().toISOString(),
          }];
          state.messagesBySession.set(sessionId, []);
          return { sessionId, streamId: 'stream-artifacts-narrow' };
        },
      },
    },
  });
  const { window, shell } = app;
  const doc = window.document;
  const input = doc.getElementById('chatInput');
  const sendButton = doc.getElementById('sendButton');

  try {
    setWorkspaceWidths(window, doc, 1000);
    await waitForUi(window, 30);

    input.value = 'Create a narrow split artifact';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    sendButton.click();
    await waitForUi(window, 20);

    await shell.__emitChat({
      type: 'tool_use',
      sessionId: 'session-artifacts-narrow',
      streamId: 'stream-artifacts-narrow',
      callId: 'call-narrow-1',
      toolName: 'CreateArtifact',
      summary: 'Create narrow artifact',
      input: { artifact_kind: 'document', title: 'Narrow Artifact' },
      status: 'running',
    });
    await shell.__emitChat({
      type: 'tool_result',
      sessionId: 'session-artifacts-narrow',
      streamId: 'stream-artifacts-narrow',
      callId: 'call-narrow-1',
      toolName: 'CreateArtifact',
      summary: 'Create narrow artifact',
      content: 'Created document "Narrow Artifact"',
      isError: false,
      approvalState: 'auto',
      durationMs: 12,
      generatedArtifacts: [{
        artifact_id: 'artifact_file_session-artifacts-narrow_narrow-artifact',
        artifact_kind: 'document',
        title: 'Narrow Artifact',
        file_name: 'narrow-artifact.md',
        display_path: '.jenny/artifacts/session-artifacts-narrow/narrow-artifact.md',
        absolute_path: 'C:/workspace/.jenny/artifacts/session-artifacts-narrow/narrow-artifact.md',
        language: 'markdown',
        editable: true,
        status: 'available',
      }],
    });
    await waitForUi(window, 60);

    doc.querySelector('[data-inv-artifact-action="panel"]').click();
    await waitForUi(window, 40);

    // W1-5: no studio fallback — on a narrow stage the panel opens as an
    // overlay drawer over chat (same DOM, .artifact-review-overlay modifier),
    // and chat keeps its full width (no artifact-review-open layout shift).
    assert.equal(window.__rendererState.ui.activeView, 'chat');
    const panel = doc.getElementById('artifactReviewPanel');
    assert.equal(panel.classList.contains('hidden'), false);
    assert.equal(panel.classList.contains('artifact-review-overlay'), true);
    assert.equal(doc.getElementById('chatView').classList.contains('artifact-review-open'), false);
  } finally {
    await app.dispose();
  }
});

test('split review rail routes Mermaid previews through the layout-deferred direct renderer', async () => {
  const app = await loadRendererApp({
    artifactReviewPreferences: { enabled: true, collapsed: false, width: 420 },
    shell: {
      artifacts: {
        async read(sessionId, artifactId) {
          return {
            artifact: {
              artifact_id: artifactId,
              title: 'Deferred Butterfly Diagram',
              editable: true,
              status: 'available',
              language: 'mermaid',
              display_path: `.jenny/artifacts/${sessionId}/deferred-butterfly.mermaid`,
              absolute_path: `C:/workspace/.jenny/artifacts/${sessionId}/deferred-butterfly.mermaid`,
            },
            content: 'flowchart TD\nA[Butterfly] --> B[Storm]',
          };
        },
      },
      chat: {
        async startStream(payload, { state }) {
          const sessionId = 'session-artifacts-mermaid-deferred';
          state.sessions = [{
            id: sessionId,
            title: 'Deferred Mermaid Artifact Session',
            conversation_mode: payload.conversationMode || 'chat',
            preferred_model: payload.preferredModel || 'gpt-test',
            reasoning_effort: payload.reasoningEffort || 'default',
            interactive_round_count: 0,
            interactive_sequence_state: 'idle',
            pending_question_batch: null,
            updated_at: new Date().toISOString(),
          }];
          state.messagesBySession.set(sessionId, []);
          return { sessionId, streamId: 'stream-artifacts-mermaid-deferred' };
        },
      },
    },
  });
  const { window, shell } = app;
  const doc = window.document;
  const input = doc.getElementById('chatInput');
  const sendButton = doc.getElementById('sendButton');

  try {
    // The panel bug: syncArtifactReviewLayout lifts .hidden and the selected
    // artifact renders in the same synchronous tick, so a direct
    // renderMermaidDirect call measures a not-yet-reflowed DOM and fails.
    // The panel path must call the layout-deferred entry instead.
    const mermaidUtils = window.rendererMermaidUtils;
    assert.ok(mermaidUtils, 'expected rendererMermaidUtils on window');
    const deferredCalls = [];
    mermaidUtils.renderMermaidDirectWhenLaidOut = async (host, source, renderOptions = {}) => {
      deferredCalls.push(String(source || ''));
      host.innerHTML = '<svg class="artifact-test-mermaid-svg"><text>deferred</text></svg>';
      renderOptions.onSuccess?.({ ok: true });
    };
    mermaidUtils.renderMermaidDirect = async (_host, _source, renderOptions = {}) => {
      renderOptions.onFailure?.({ ok: false, error: 'direct render must not be called synchronously by the panel path' });
    };
    mermaidUtils.attachMermaidControls = () => {};

    setWorkspaceWidths(window, doc, 1600);
    await waitForUi(window, 30);

    input.value = 'Create deferred butterfly diagram';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    sendButton.click();
    await waitForUi(window, 20);

    await shell.__emitChat({
      type: 'tool_use',
      sessionId: 'session-artifacts-mermaid-deferred',
      streamId: 'stream-artifacts-mermaid-deferred',
      callId: 'call-mermaid-deferred-1',
      toolName: 'CreateArtifact',
      summary: 'Create deferred butterfly diagram',
      input: { artifact_kind: 'document', title: 'Deferred Butterfly Diagram' },
      status: 'running',
    });
    await shell.__emitChat({
      type: 'tool_result',
      sessionId: 'session-artifacts-mermaid-deferred',
      streamId: 'stream-artifacts-mermaid-deferred',
      callId: 'call-mermaid-deferred-1',
      toolName: 'CreateArtifact',
      summary: 'Create deferred butterfly diagram',
      content: 'Created document "Deferred Butterfly Diagram" at .jenny/artifacts/session-artifacts-mermaid-deferred/deferred-butterfly.mermaid',
      isError: false,
      approvalState: 'auto',
      durationMs: 12,
      generatedArtifacts: [{
        artifact_id: 'artifact_file_session-artifacts-mermaid-deferred_deferred-butterfly',
        artifact_kind: 'document',
        title: 'Deferred Butterfly Diagram',
        file_name: 'deferred-butterfly.mermaid',
        display_path: '.jenny/artifacts/session-artifacts-mermaid-deferred/deferred-butterfly.mermaid',
        absolute_path: 'C:/workspace/.jenny/artifacts/session-artifacts-mermaid-deferred/deferred-butterfly.mermaid',
        language: '',
        editable: true,
        status: 'available',
      }],
    });
    await waitForUi(window, 60);

    assert.equal(doc.getElementById('artifactReviewPanel').classList.contains('hidden'), false);
    const host = doc.querySelector('#artifactReviewPreviewContent .artifact-preview-mermaid-host');
    assert.ok(host);
    await waitForUi(window, 40);
    assert.ok(deferredCalls.length >= 1, 'panel preview must route through renderMermaidDirectWhenLaidOut');
    assert.ok(doc.querySelector('#artifactReviewPreviewContent .artifact-preview-mermaid-host svg'));
    assert.doesNotMatch(
      String(doc.getElementById('artifactReviewPreviewContent').textContent || ''),
      /Preview unavailable/i
    );
  } finally {
    await app.dispose();
  }
});
