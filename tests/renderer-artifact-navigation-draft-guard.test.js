'use strict';

// UIUX-007: navigation must not silently discard an in-progress edit.
// renderer/chat/renderer-artifacts-utils.js:590-607 (discardDirtyArtifactIfNeeded,
// called from selectArtifact AFTER selection had already flipped to the new
// target) used to wipe state.artifacts.dirtyContent unconditionally with no
// Save/Discard/Cancel decision. Per the audit's far-edge-case matrix ("Save
// A, navigate/session-switch, late response: B and its editor remain
// untouched") and the task's explicit allowance ("must prompt or defer, not
// silently discard"), this remediation DEFERS the dirty draft into
// renderer-artifact-draft-store.js instead of prompting: the edit survives
// a select/filter/auto-open navigation and is restored verbatim on return.
//
// RED-FIRST: against pre-remediation HEAD, selecting a different artifact
// while dirty loses the edit outright -- reselecting the original artifact
// re-reads the clean disk copy, not the edit. See the session's captured RED
// output for this exact assertion run against the old code.
//
// W1-5 (studio removal): the Artifacts view and its filter bar are gone; the
// split review panel is the only artifact surface. The select-away round trip
// below now moves selection via the transcript cards' panel buttons. The old
// "filter away then back" variant was deleted with the filter bar -- no
// surviving code path clears selection out from under a dirty draft that way.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  loadRendererApp,
  waitForUi,
} = require('./helpers/renderer-shell-harness');

function codeArtifact(sessionId, key, title) {
  return {
    artifact_id: `artifact_file_${sessionId}_${key}`,
    artifact_kind: 'document',
    title,
    file_name: `${key}.py`,
    display_path: `.jenny/artifacts/${sessionId}/${key}.py`,
    absolute_path: `C:/workspace/.jenny/artifacts/${sessionId}/${key}.py`,
    language: 'python',
    editable: true,
    status: 'available',
  };
}

async function seedTwoArtifacts(shell, sessionId) {
  await shell.__emitChat({
    type: 'tool_use', sessionId, streamId: 'stream-1', callId: 'call-a',
    toolName: 'CreateArtifact', summary: 'Create doc A', input: { artifact_kind: 'document', title: 'Doc A' }, status: 'running',
  });
  await shell.__emitChat({
    type: 'tool_result', sessionId, streamId: 'stream-1', callId: 'call-a', toolName: 'CreateArtifact',
    summary: 'Create doc A', content: 'Created document A', isError: false, approvalState: 'auto', durationMs: 5,
    generatedArtifacts: [codeArtifact(sessionId, 'doc-a', 'Doc A')],
  });
  await shell.__emitChat({
    type: 'tool_use', sessionId, streamId: 'stream-1', callId: 'call-b',
    toolName: 'CreateArtifact', summary: 'Create doc B', input: { artifact_kind: 'document', title: 'Doc B' }, status: 'running',
  });
  await shell.__emitChat({
    type: 'tool_result', sessionId, streamId: 'stream-1', callId: 'call-b', toolName: 'CreateArtifact',
    summary: 'Create doc B', content: 'Created document B', isError: false, approvalState: 'auto', durationMs: 5,
    generatedArtifacts: [codeArtifact(sessionId, 'doc-b', 'Doc B')],
  });
}

function makeApp({ readContentByArtifactId = {}, ...rest } = {}) {
  const sessionId = 'session-artifact-nav-guard';
  const saves = [];
  return loadRendererApp({
    windowInnerWidth: 1600,
    windowInnerHeight: 900,
    artifactReviewPreferences: { enabled: true, collapsed: false, width: 420 },
    shell: {
      artifacts: {
        async read(readSessionId, artifactId) {
          return {
            artifact: { artifact_id: artifactId, editable: true, status: 'available', language: 'python' },
            content: readContentByArtifactId[artifactId] || `# ${artifactId} disk content\n`,
          };
        },
        async save(saveSessionId, artifactId, content) {
          saves.push({ sessionId: saveSessionId, artifactId, content });
          return { artifact: { artifact_id: artifactId, editable: true, status: 'available' } };
        },
      },
      chat: {
        async startStream(payload, { state }) {
          state.sessions = [{
            id: sessionId,
            title: 'Nav Guard Session',
            conversation_mode: payload.conversationMode || 'chat',
            preferred_model: payload.preferredModel || 'gpt-test',
            reasoning_effort: payload.reasoningEffort || 'default',
            interactive_round_count: 0,
            interactive_sequence_state: 'idle',
            pending_question_batch: null,
            updated_at: new Date().toISOString(),
          }];
          state.messagesBySession.set(sessionId, []);
          return { sessionId, streamId: 'stream-1' };
        },
      },
    },
    ...rest,
  }).then((app) => ({ app, sessionId, saves }));
}

test('editing artifact A then selecting artifact B defers A\'s draft instead of discarding it; reselecting A restores it', async () => {
  const { app, sessionId } = await makeApp();
  const { window, shell } = app;
  const doc = window.document;
  try {
    doc.getElementById('chatInput').value = 'start';
    doc.getElementById('chatInput').dispatchEvent(new window.Event('input', { bubbles: true }));
    doc.getElementById('sendButton').click();
    await waitForUi(window, 20);
    await seedTwoArtifacts(shell, sessionId);
    await waitForUi(window, 40);

    const idA = `artifact_file_${sessionId}_doc-a`;
    const idB = `artifact_file_${sessionId}_doc-b`;

    // W1-5: selection moves via the transcript cards' panel buttons (the V2
    // stepper does not render in this harness state).
    doc.querySelector(`[data-inv-artifact-action="panel"][data-artifact-id="${idA}"]`).click();
    await waitForUi(window, 30);

    const editor = doc.getElementById('artifactReviewEditorFallback');
    assert.ok(editor, 'expected the code editor fallback for a non-markdown generated file');
    assert.match(editor.value, new RegExp(idA));

    editor.value = '# EDITED DRAFT FOR A';
    editor.dispatchEvent(new window.Event('input', { bubbles: true }));
    await waitForUi(window, 20);

    const saveButton = doc.getElementById('artifactReviewSaveButton');
    assert.equal(saveButton.disabled, false, 'A must be dirty after the edit');

    // Navigate away to B WITHOUT saving or discarding.
    doc.querySelector(`[data-inv-artifact-action="panel"][data-artifact-id="${idB}"]`).click();
    await waitForUi(window, 30);

    assert.match(doc.getElementById('artifactReviewDetailTitle').textContent, /Doc B/);
    assert.match(editor.value, new RegExp(idB), 'B must show its own clean content, not A\'s edit');
    assert.equal(saveButton.disabled, true, 'B is clean -- Save must be disabled');

    // Return to A: the deferred draft, not a freshly-loaded clean copy, must
    // be what's shown.
    doc.querySelector(`[data-inv-artifact-action="panel"][data-artifact-id="${idA}"]`).click();
    await waitForUi(window, 30);

    assert.equal(editor.value, '# EDITED DRAFT FOR A', 'A\'s unsaved edit must survive the round trip through B, not be silently discarded');
    assert.equal(saveButton.disabled, false, 'A must still read as dirty after its draft is restored');
  } finally {
    await app.dispose();
  }
});

// Session review 2026-11-17 (A1/A2): every streamed event replaces the session messages. The open
// artifact must not be re-read (no per-step "Loading artifact…" blink), and an unsaved edit must
// survive, unless the selected artifact itself was rewritten.
async function emitUnrelatedToolRow(shell, sessionId, callId) {
  await shell.__emitChat({
    type: 'tool_use', sessionId, streamId: 'stream-1', callId,
    toolName: 'list_dir', summary: 'list_dir .', input: { path: '.' }, status: 'running',
  });
  await shell.__emitChat({
    type: 'tool_result', sessionId, streamId: 'stream-1', callId, toolName: 'list_dir',
    summary: 'list_dir .', content: 'entries: 0', isError: false, approvalState: 'auto', durationMs: 1,
  });
}

async function openArtifactA(t) {
  const reads = [];
  const { app, sessionId } = await makeApp();
  t.after(() => app.dispose());
  const { window, shell } = app;
  const read = shell.artifacts.read.bind(shell.artifacts);
  shell.artifacts.read = async (readSessionId, artifactId) => { reads.push(artifactId); return read(readSessionId, artifactId); };
  const doc = window.document;
  doc.getElementById('chatInput').value = 'start';
  doc.getElementById('chatInput').dispatchEvent(new window.Event('input', { bubbles: true }));
  doc.getElementById('sendButton').click();
  await waitForUi(window, 20);
  await seedTwoArtifacts(shell, sessionId);
  await waitForUi(window, 40);
  const idA = `artifact_file_${sessionId}_doc-a`;
  doc.querySelector(`[data-inv-artifact-action="panel"][data-artifact-id="${idA}"]`).click();
  await waitForUi(window, 30);
  return { app, window, shell, doc, sessionId, idA, reads };
}

test('an unrelated streamed tool row neither re-reads the open artifact nor drops an unsaved edit', async (t) => {
  const { window, shell, doc, sessionId, idA, reads } = await openArtifactA(t);
  const editor = doc.getElementById('artifactReviewEditorFallback');
  assert.match(editor.value, new RegExp(idA));
  const readsBefore = reads.length;
  assert.ok(readsBefore >= 1, 'opening A reads it once');

  editor.value = '# EDIT DURING A LIVE TURN';
  editor.dispatchEvent(new window.Event('input', { bubbles: true }));
  await waitForUi(window, 20);

  await emitUnrelatedToolRow(shell, sessionId, 'call-unrelated-1');
  await emitUnrelatedToolRow(shell, sessionId, 'call-unrelated-2');
  await waitForUi(window, 40);

  assert.equal(reads.length, readsBefore, 'unrelated rows must not re-read the selected artifact');
  assert.equal(editor.value, '# EDIT DURING A LIVE TURN', 'the unsaved edit must survive streamed rows');
  assert.equal(doc.getElementById('artifactReviewSaveButton').disabled, false, 'A must still read as dirty');
});

test('a new write of the selected artifact still reloads it', async (t) => {
  const { window, shell, sessionId, idA, reads } = await openArtifactA(t);
  const readsBefore = reads.length;
  await shell.__emitChat({
    type: 'tool_use', sessionId, streamId: 'stream-1', callId: 'call-a-again',
    toolName: 'CreateArtifact', summary: 'Update doc A', input: { artifact_kind: 'document', title: 'Doc A' }, status: 'running',
  });
  await shell.__emitChat({
    type: 'tool_result', sessionId, streamId: 'stream-1', callId: 'call-a-again', toolName: 'CreateArtifact',
    summary: 'Update doc A', content: 'Updated document A', isError: false, approvalState: 'auto', durationMs: 5,
    generatedArtifacts: [codeArtifact(sessionId, 'doc-a', 'Doc A')],
  });
  await waitForUi(window, 40);
  assert.ok(reads.length > readsBefore, 'a rewrite of the selected artifact must re-read it');
  assert.ok(reads.slice(readsBefore).includes(idA));
});

