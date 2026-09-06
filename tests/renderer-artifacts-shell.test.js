const test = require('node:test');
const assert = require('node:assert/strict');
const {
  loadRendererApp,
  waitForUi,
} = require('./helpers/renderer-shell-harness');

// W1-5: the Artifacts studio view (catalog, filters, artifacts* DOM) is gone.
// These tests assert the same artifact-derivation contracts against the split
// review panel, the only remaining in-app artifact surface.

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

test('queued images are not artifacts until send, then persisted image artifacts render in the review panel', async () => {
  const app = await loadRendererApp({
    artifactReviewPreferences: { enabled: true, collapsed: false, width: 420 },
  });
  const { window } = app;
  const doc = window.document;
  const input = doc.getElementById('chatInput');
  const sendButton = doc.getElementById('sendButton');

  try {
    dispatchPastedImage(window, input);
    await waitForUi(window, 20);

    // A queued-but-unsent image is not an artifact: no session is active yet,
    // so the enabled review panel stays hidden and nothing is selected.
    assert.equal(doc.getElementById('artifactReviewPanel').classList.contains('hidden'), true);

    input.value = 'Describe this screenshot';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    sendButton.click();
    await waitForUi(window, 90);

    assert.equal(doc.getElementById('artifactReviewPanel').classList.contains('hidden'), false);
    assert.match(doc.getElementById('artifactReviewStatus').textContent, /1 artifact/i);

    const preview = doc.querySelector('#artifactReviewPreviewContent .artifact-preview-image');
    assert.ok(preview);
    preview.dispatchEvent(new window.Event('error'));
    await waitForUi(window, 20);

    assert.equal(doc.querySelector('.artifact-preview-image'), null);
    assert.match(doc.querySelector('#artifactReviewPreviewContent .artifacts-empty').textContent, /image unavailable/i);

    // The missing-image state must survive a collapse/reopen round trip, not
    // be forgotten on the next panel render.
    const splitToggle = doc.getElementById('artifactSplitViewToggle');
    doc.getElementById('artifactReviewCollapseButton').click();
    await waitForUi(window, 20);
    assert.equal(splitToggle.getAttribute('aria-pressed'), 'false', 'collapse clears the split-view pressed state');
    assert.equal(splitToggle.classList.contains('active'), false, 'collapse clears the split-view highlight');
    splitToggle.click();
    await waitForUi(window, 30);

    assert.equal(splitToggle.getAttribute('aria-pressed'), 'true', 'reopening restores the split-view pressed state');
    assert.equal(doc.querySelector('.artifact-preview-image'), null);
    assert.match(doc.querySelector('#artifactReviewPreviewContent .artifacts-empty').textContent, /image unavailable/i);
  } finally {
    await app.dispose();
  }
});

test('first panel open renders the selected artifact detail after chat creates an artifact', async () => {
  const app = await loadRendererApp({
    artifactReviewPreferences: { enabled: true, collapsed: false, width: 420 },
  });
  const { window } = app;
  const doc = window.document;
  const input = doc.getElementById('chatInput');
  const sendButton = doc.getElementById('sendButton');

  try {
    dispatchPastedImage(window, input, 'lazy-artifact.png');
    await waitForUi(window, 20);

    input.value = 'Persist this image';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    sendButton.click();
    await waitForUi(window, 120);

    // W1-5: the panel lazily initializes on its first render pass and must
    // auto-select the newly persisted artifact — detail chrome populated, not
    // the empty state.
    assert.equal(doc.getElementById('artifactReviewPanel').classList.contains('hidden'), false);
    assert.match(doc.getElementById('artifactReviewStatus').textContent, /1 artifact/i);
    assert.equal(doc.getElementById('artifactReviewDetailEmpty').classList.contains('hidden'), true);
    assert.ok(doc.getElementById('artifactReviewDetailTitle').textContent.trim().length > 0);
    assert.ok(doc.getElementById('artifactReviewProvenanceTimeline').textContent.trim().length > 0);
  } finally {
    await app.dispose();
  }
});

test('artifacts tab renders redacted generated images through artifact read data URLs', async () => {
  const imageDataUrl = 'data:image/png;base64,iVBORw0KGgo=';
  const sessionId = 'session-redacted-generated-image';
  const app = await loadRendererApp({
    artifactReviewPreferences: { enabled: true, collapsed: false, width: 420 },
    shell: {
      chat: {
        async startStream(payload, { state }) {
          state.sessions = [{
            id: sessionId,
            title: 'Redacted Generated Image',
            conversation_mode: payload.conversationMode || 'chat',
            preferred_model: payload.preferredModel || 'gpt-test',
            reasoning_effort: payload.reasoningEffort || 'default',
            interactive_round_count: 0,
            interactive_sequence_state: 'idle',
            pending_question_batch: null,
            updated_at: new Date().toISOString(),
          }];
          state.messagesBySession.set(sessionId, []);
          return { sessionId, streamId: 'stream-redacted-generated-image' };
        },
      },
      artifacts: {
        async read(readSessionId, artifactId) {
          assert.equal(readSessionId, sessionId);
          assert.equal(artifactId, 'artifact_image_redacted_preview');
          return {
            artifact: {
              artifact_id: artifactId,
              artifact_kind: 'image',
              title: 'Redacted preview',
              editable: false,
              status: 'available',
              mime_type: 'image/png',
            },
            content: '',
            asset_data_url: imageDataUrl,
          };
        },
      },
    },
  });
  const { window, shell } = app;
  const doc = window.document;

  try {
    doc.getElementById('chatInput').value = 'Capture a local screenshot';
    doc.getElementById('chatInput').dispatchEvent(new window.Event('input', { bubbles: true }));
    doc.getElementById('sendButton').click();
    await waitForUi(window, 30);

    await shell.__emitChat({
      type: 'tool_result',
      sessionId,
      streamId: 'stream-redacted-generated-image',
      callId: 'call-redacted-generated-image',
      toolName: 'mermaid_generate',
      summary: 'Captured local screenshot',
      content: 'Created image preview',
      isError: false,
      approvalState: 'auto',
      durationMs: 15,
      generatedArtifacts: [{
        artifact_id: 'artifact_image_redacted_preview',
        artifact_kind: 'image',
        title: 'Redacted preview',
        file_name: 'preview.png',
        display_path: `.jenny/artifacts/${sessionId}/preview.png`,
        absolute_path: '[redacted:path]',
        mime_type: 'image/png',
        width: 320,
        height: 180,
        source_kind: 'capture',
        editable: false,
        status: 'available',
        local_trusted: true,
      }],
    });
    // W1-5: the panel auto-opens on the generated artifact; the redacted
    // image must render through the artifact-read data URL, never file://.
    await waitForUi(window, 120);

    const preview = doc.querySelector('#artifactReviewPreviewContent .artifact-preview-image');
    assert.ok(preview);
    assert.equal(preview.getAttribute('src'), imageDataUrl);
    assert.equal(preview.getAttribute('src').startsWith('file://'), false);
  } finally {
    await app.dispose();
  }
});

// The "artifacts filters clear/restore selection" test was deleted in W1-5:
// the filter bar was studio-only chrome and has no panel equivalent.

test('leaving chat for the IDE view hides split review chrome even when split review is enabled', async () => {
  const app = await loadRendererApp({
    artifactReviewPreferences: { enabled: true, collapsed: false, width: 420 },
  });
  const { window } = app;
  const doc = window.document;
  const input = doc.getElementById('chatInput');
  const sendButton = doc.getElementById('sendButton');
  const splitPanel = doc.getElementById('artifactReviewPanel');
  const splitResizer = doc.getElementById('artifactReviewResizer');
  const chatView = doc.getElementById('chatView');

  try {
    setWorkspaceWidths(window, doc, 1600);
    await waitForUi(window, 30);

    dispatchPastedImage(window, input, 'split-artifacts-view.png');
    await waitForUi(window, 20);

    input.value = 'Describe this screenshot beside chat';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    sendButton.click();
    await waitForUi(window, 120);

    assert.equal(splitPanel.classList.contains('hidden'), false);
    assert.equal(chatView.classList.contains('artifact-review-open'), true);

    // W1-5: the studio view is gone — the IDE view is the non-chat surface
    // that must park the split review chrome (eligibility is chat-only).
    doc.getElementById('ideTopRailTab').click();
    await waitForUi(window, 40);

    assert.equal(splitPanel.classList.contains('hidden'), true);
    assert.equal(splitResizer.classList.contains('hidden'), true);
    assert.equal(chatView.classList.contains('artifact-review-open'), false);
    assert.equal(chatView.classList.contains('artifact-review-mode'), false);
  } finally {
    await app.dispose();
  }
});
