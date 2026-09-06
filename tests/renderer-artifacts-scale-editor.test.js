const test = require('node:test');
const assert = require('node:assert/strict');
const {
  loadRendererApp,
  waitForUi,
} = require('./helpers/renderer-shell-harness');

// UIUX-025: the artifact editor used to trigger a full sibling-surface
// rebuild (catalog innerHTML rebuild in the old studio; preview rebuild,
// editor.setDocument round trip) on EVERY keystroke. Cost grew with artifact
// count and could reset scroll/focus. This scale-sanity test seeds 100+
// artifacts and asserts the fix contract deterministically (DOM-node
// identity + an instrumented innerHTML-write counter), not by timing
// wall-clock cost. W1-5: the studio catalog is gone — the guarded surface is
// now the review panel's preview content.

function findInnerHtmlDescriptor(node) {
  let proto = Object.getPrototypeOf(node);
  while (proto) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'innerHTML');
    if (descriptor) return descriptor;
    proto = Object.getPrototypeOf(proto);
  }
  return null;
}

const ARTIFACT_COUNT = 120;
const TARGET_ARTIFACT_ID = 'artifact_file_session-scale_target-file';

function buildGeneratedArtifacts() {
  const items = [];
  for (let i = 0; i < ARTIFACT_COUNT - 1; i += 1) {
    items.push({
      artifact_id: `artifact_file_session-scale_filler-${i}`,
      artifact_kind: 'document',
      title: `Filler ${i}`,
      file_name: `filler-${i}.txt`,
      display_path: `.jenny/artifacts/session-scale/filler-${i}.txt`,
      absolute_path: `C:/workspace/.jenny/artifacts/session-scale/filler-${i}.txt`,
      language: 'plaintext',
      editable: false,
      status: 'available',
    });
  }
  items.push({
    artifact_id: TARGET_ARTIFACT_ID,
    artifact_kind: 'document',
    title: 'Target File',
    file_name: 'target-file.md',
    display_path: '.jenny/artifacts/session-scale/target-file.md',
    absolute_path: 'C:/workspace/.jenny/artifacts/session-scale/target-file.md',
    language: 'markdown',
    editable: true,
    status: 'available',
  });
  return items;
}

test('UIUX-025: editing a generated artifact does not rebuild the review panel preview on every keystroke (100+ artifacts)', async () => {
  const app = await loadRendererApp({
    artifactReviewPreferences: { enabled: true, collapsed: false, width: 420 },
    shell: {
      artifacts: {
        async read(sessionId, artifactId) {
          return {
            artifact: {
              artifact_id: artifactId,
              title: 'Target File',
              editable: true,
              status: 'available',
              language: 'markdown',
              display_path: '.jenny/artifacts/session-scale/target-file.md',
              absolute_path: 'C:/workspace/.jenny/artifacts/session-scale/target-file.md',
            },
            content: '# Target File\n\nOriginal body.',
          };
        },
        async save(sessionId, artifactId) {
          return { artifact: { artifact_id: artifactId, editable: true, status: 'available' } };
        },
      },
      chat: {
        async startStream(payload, { state }) {
          const sessionId = 'session-scale';
          state.sessions = [{
            id: sessionId,
            title: 'Scale Session',
            conversation_mode: payload.conversationMode || 'chat',
            preferred_model: payload.preferredModel || 'gpt-test',
            reasoning_effort: payload.reasoningEffort || 'default',
            interactive_round_count: 0,
            interactive_sequence_state: 'idle',
            pending_question_batch: null,
            updated_at: new Date().toISOString(),
          }];
          state.messagesBySession.set(sessionId, []);
          return { sessionId, streamId: 'stream-scale' };
        },
      },
    },
  });
  const { window, shell } = app;
  const doc = window.document;
  const input = doc.getElementById('chatInput');
  const sendButton = doc.getElementById('sendButton');

  try {
    input.value = 'Generate a large batch of artifacts';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    sendButton.click();
    await waitForUi(window, 20);

    await shell.__emitChat({
      type: 'tool_use',
      sessionId: 'session-scale',
      streamId: 'stream-scale',
      callId: 'call-scale-1',
      toolName: 'CreateArtifact',
      summary: 'Create a batch of files',
      input: { artifact_kind: 'document', title: 'Batch' },
      status: 'running',
    });
    await shell.__emitChat({
      type: 'tool_result',
      sessionId: 'session-scale',
      streamId: 'stream-scale',
      callId: 'call-scale-1',
      toolName: 'CreateArtifact',
      summary: 'Create a batch of files',
      content: `Created ${ARTIFACT_COUNT} files.`,
      isError: false,
      approvalState: 'auto',
      durationMs: 12,
      generatedArtifacts: buildGeneratedArtifacts(),
    });
    await waitForUi(window, 60);

    // W1-5: the review panel is open (boot prefs); every generated artifact
    // gets a transcript card — select the target through its panel button.
    await waitForUi(window, 60);

    assert.equal(doc.querySelectorAll('[data-inv-artifact-action="panel"]').length, ARTIFACT_COUNT, 'expected a transcript card per generated artifact');

    doc.querySelector(`[data-inv-artifact-action="panel"][data-artifact-id="${TARGET_ARTIFACT_ID}"]`).click();
    await waitForUi(window, 40);

    const sourceViewButton = doc.querySelector('[data-artifact-document-view="source"]');
    assert.ok(sourceViewButton, 'expected the markdown source-view toggle');
    sourceViewButton.click();
    await waitForUi(window, 20);

    const editor = doc.getElementById('artifactReviewEditorFallback');
    assert.ok(editor);
    assert.match(editor.value, /Original body/);

    // Instrument the preview content's innerHTML setter: a rebuild reassigns
    // the whole preview's markup, which shows up as an innerHTML write here.
    const previewContent = doc.getElementById('artifactReviewPreviewContent');
    let innerHtmlWrites = 0;
    const descriptor = findInnerHtmlDescriptor(previewContent);
    assert.ok(descriptor, 'expected an innerHTML accessor descriptor on the preview content element');
    Object.defineProperty(previewContent, 'innerHTML', {
      configurable: true,
      get() { return descriptor.get.call(this); },
      set(value) {
        innerHtmlWrites += 1;
        descriptor.set.call(this, value);
      },
    });
    const documentBeforeTyping = previewContent.querySelector('.artifact-document');
    assert.ok(documentBeforeTyping);

    const keystrokes = Array.from('\n\nEdited body text.');
    let value = editor.value;
    for (const ch of keystrokes) {
      value += ch;
      editor.value = value;
      editor.dispatchEvent(new window.Event('input', { bubbles: true }));
    }
    await waitForUi(window, 10);

    assert.equal(innerHtmlWrites, 0, `preview innerHTML must not be reassigned while typing (saw ${innerHtmlWrites} writes)`);
    assert.equal(previewContent.querySelector('.artifact-document'), documentBeforeTyping, 'preview DOM nodes must be reused, not rebuilt, on keystroke');

    // Dirty/save/revert chrome must still track state in place, even though
    // the heavier preview rebuild did not run synchronously.
    const saveButton = doc.getElementById('artifactReviewSaveButton');
    assert.equal(saveButton.disabled, false, 'save button should reflect dirty state immediately on keystroke');
    const dirtyBadge = doc.getElementById('artifactReviewDirtyBadge');
    if (dirtyBadge) {
      assert.equal(dirtyBadge.classList.contains('hidden'), false, 'dirty badge should show immediately on keystroke');
    }

    // The debounced preview refresh still lands afterwards (editor content
    // itself is authoritative and always current; this just confirms the
    // debounce settles instead of getting dropped). W1-5 regression guard:
    // the refresh renders full-then-split, and the removed studio
    // surface must not throw before the split preview refreshes — assert the
    // refresh actually reached the preview and no global error fired.
    await waitForUi(window, 400);
    assert.match(editor.value, /Edited body text/);
    assert.ok(innerHtmlWrites >= 1, 'the debounced preview refresh must land on the split surface');
    assert.equal(window.__rendererState.logs.filter((entry) => entry.event === 'renderer.global_error').length, 0);
  } finally {
    await app.dispose();
  }
});
