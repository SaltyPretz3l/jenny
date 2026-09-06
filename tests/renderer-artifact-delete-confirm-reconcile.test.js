'use strict';

// Wave-R remediation (queue #18 item 3, QUEUE_DRIVE_REPORT_2026-07-05.md
// #18): the Artifact Panel toolbar's "Delete artifact" deleted the artifact
// IMMEDIATELY on click (no confirm), and the panel/catalog were left stale
// afterward -- the panel stuck on "Loading <kind> artifact..." and the
// catalog entry for the just-deleted artifact still listed. RED-FIRST: full
// shell boot on the real path, real toolbar click, real confirm dialog,
// real reconciliation.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  loadRendererApp,
  waitForUi,
} = require('./helpers/renderer-shell-harness');

// W1-5: the Artifacts studio view is removed — every flow below drives the
// split review panel (the only artifact surface), booted visible via
// persisted prefs + the V2 chrome, mirroring the original V2 panel test.

function stubWorkspaceLayout(doc, width) {
  const workspaceEl = doc.getElementById('workspace');
  assert.ok(workspaceEl, 'expected #workspace to exist');
  workspaceEl.getBoundingClientRect = () => ({
    width, height: 900, top: 0, left: 0, right: width, bottom: 900, x: 0, y: 0,
  });
}

function docArtifact(sessionId, key, title) {
  return {
    artifact_id: `artifact_file_${sessionId}_${key}`,
    artifact_kind: 'document',
    title,
    file_name: `${key}.md`,
    display_path: `.jenny/artifacts/${sessionId}/${key}.md`,
    absolute_path: `C:/workspace/.jenny/artifacts/${sessionId}/${key}.md`,
    language: 'markdown',
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
    generatedArtifacts: [docArtifact(sessionId, 'doc-a', 'Doc A')],
  });
  await shell.__emitChat({
    type: 'tool_use', sessionId, streamId: 'stream-1', callId: 'call-b',
    toolName: 'CreateArtifact', summary: 'Create doc B', input: { artifact_kind: 'document', title: 'Doc B' }, status: 'running',
  });
  await shell.__emitChat({
    type: 'tool_result', sessionId, streamId: 'stream-1', callId: 'call-b', toolName: 'CreateArtifact',
    summary: 'Create doc B', content: 'Created document B', isError: false, approvalState: 'auto', durationMs: 5,
    generatedArtifacts: [docArtifact(sessionId, 'doc-b', 'Doc B')],
  });
}

function makeApp({ shellOverrides = {}, ...rest } = {}) {
  const deleteCalls = [];
  const sessionId = 'session-artifact-delete-confirm';
  return loadRendererApp({
    windowInnerWidth: 1600,
    windowInnerHeight: 900,
    shell: {
      artifacts: {
        async delete(delSessionId, artifactId) {
          deleteCalls.push({ sessionId: delSessionId, artifactId });
          return { status: 'deleted' };
        },
      },
      chat: {
        async startStream(payload, { state }) {
          state.sessions = [{
            id: sessionId,
            title: 'Delete Confirm Session',
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
      ...shellOverrides,
    },
    ...rest,
  }).then((app) => ({ app, deleteCalls, sessionId }));
}

test('Delete toolbar button requires confirm; Cancel leaves the artifact intact and untouched on disk', async () => {
  const { app, deleteCalls, sessionId } = await makeApp({
    artifactReviewPreferences: { enabled: true, collapsed: false, width: 460 },
    shellOverrides: {
      features: { state: { featureFlags: { artifact_panel_v2: true } } },
    },
  });
  const { window, shell } = app;
  const doc = window.document;
  try {
    stubWorkspaceLayout(doc, 1600);
    doc.getElementById('chatInput').value = 'start';
    doc.getElementById('chatInput').dispatchEvent(new window.Event('input', { bubbles: true }));
    doc.getElementById('sendButton').click();
    await waitForUi(window, 20);
    await seedTwoArtifacts(shell, sessionId);
    await waitForUi(window, 40);

    const panel = doc.getElementById('artifactReviewPanel');
    assert.equal(panel.classList.contains('hidden'), false, 'split panel visible (persisted enabled prefs)');
    const titleBefore = doc.getElementById('artifactReviewDetailTitle').textContent.trim();
    assert.ok(['Doc A', 'Doc B'].includes(titleBefore), 'a real artifact should be selected before delete');

    panel.querySelector('[data-artifact-panel-overflow]').click();
    const overflowDelete = [...doc.querySelectorAll('.inv-context-menu-item')]
      .find((node) => node.textContent === 'Delete artifact');
    assert.ok(overflowDelete, 'V3 overflow exposes Delete artifact');
    overflowDelete.click();
    await waitForUi(window, 10);

    const modal = doc.querySelector('[data-step-modal="artifact-panel-confirm-delete"]');
    assert.ok(modal, 'Delete must open a confirm dialog, not delete immediately');
    assert.match(modal.textContent, /This cannot be undone/i);

    modal.querySelector('[data-step-modal-action="cancel"]').click();
    await waitForUi(window, 10);

    assert.equal(doc.querySelector('[data-step-modal="artifact-panel-confirm-delete"]'), null, 'modal closes on cancel');
    assert.equal(deleteCalls.length, 0, 'cancel must not call the delete IPC');
    assert.equal(doc.getElementById('artifactReviewDetailTitle').textContent.trim(), titleBefore, 'selection untouched after cancel');
  } finally {
    await app.dispose();
  }
});

test('Confirming Delete removes the artifact, updates the catalog, and moves selection to the remaining artifact', async () => {
  const { app, deleteCalls, sessionId } = await makeApp({
    artifactReviewPreferences: { enabled: true, collapsed: false, width: 460 },
    shellOverrides: {
      features: { state: { featureFlags: { artifact_panel_v2: true } } },
    },
  });
  const { window, shell } = app;
  const doc = window.document;
  try {
    stubWorkspaceLayout(doc, 1600);
    doc.getElementById('chatInput').value = 'start';
    doc.getElementById('chatInput').dispatchEvent(new window.Event('input', { bubbles: true }));
    doc.getElementById('sendButton').click();
    await waitForUi(window, 20);
    await seedTwoArtifacts(shell, sessionId);
    await waitForUi(window, 40);

    const selectedTitleBefore = doc.getElementById('artifactReviewDetailTitle').textContent.trim();
    assert.ok(['Doc A', 'Doc B'].includes(selectedTitleBefore), 'a real artifact should be selected before delete');
    const deletedKey = selectedTitleBefore === 'Doc A' ? 'doc-a' : 'doc-b';
    const survivorTitle = selectedTitleBefore === 'Doc A' ? 'Doc B' : 'Doc A';

    doc.getElementById('artifactReviewDeleteButton').click();
    await waitForUi(window, 10);
    doc.querySelector('[data-step-modal="artifact-panel-confirm-delete"] [data-step-modal-action="confirm"]').click();
    await waitForUi(window, 40);

    assert.equal(deleteCalls.length, 1, 'confirm must call the delete IPC exactly once');
    assert.equal(deleteCalls[0].sessionId, sessionId);
    assert.equal(deleteCalls[0].artifactId, `artifact_file_${sessionId}_${deletedKey}`);

    // Selection reconciles to the remaining artifact -- not stuck on the
    // deleted one, and not stuck showing a perpetual loading body.
    assert.equal(doc.getElementById('artifactReviewDetailTitle').textContent.trim(), survivorTitle);
    assert.doesNotMatch(doc.getElementById('artifactReviewDetailNote')?.textContent || '', /Loading/);

    // Delete the survivor too -- the panel reconciles to its empty state.
    doc.getElementById('artifactReviewDeleteButton').click();
    await waitForUi(window, 10);
    doc.querySelector('[data-step-modal="artifact-panel-confirm-delete"] [data-step-modal-action="confirm"]').click();
    await waitForUi(window, 40);

    assert.equal(deleteCalls.length, 2);
    assert.equal(doc.getElementById('artifactReviewDetailPanel').classList.contains('hidden'), true);
    assert.equal(doc.getElementById('artifactReviewDetailEmpty').classList.contains('hidden'), false);
  } finally {
    await app.dispose();
  }
});

test('Split review panel (Artifact Panel V2): confirming Delete on the only artifact reconciles to the empty state, not a stuck loading body', async () => {
  const { app, sessionId } = await makeApp({
    artifactReviewPreferences: { enabled: true, collapsed: false, width: 460 },
    shellOverrides: {
      features: { state: { featureFlags: { artifact_panel_v2: true, workspace_artifact_panel: true } } },
    },
  });
  const { window, shell } = app;
  const doc = window.document;
  try {
    stubWorkspaceLayout(doc, 1600);
    doc.getElementById('chatInput').value = 'start';
    doc.getElementById('chatInput').dispatchEvent(new window.Event('input', { bubbles: true }));
    doc.getElementById('sendButton').click();
    await waitForUi(window, 20);

    await shell.__emitChat({
      type: 'tool_use', sessionId, streamId: 'stream-1', callId: 'call-a',
      toolName: 'CreateArtifact', summary: 'Create doc A', input: { artifact_kind: 'document', title: 'Doc A' }, status: 'running',
    });
    await shell.__emitChat({
      type: 'tool_result', sessionId, streamId: 'stream-1', callId: 'call-a', toolName: 'CreateArtifact',
      summary: 'Create doc A', content: 'Created document A', isError: false, approvalState: 'auto', durationMs: 5,
      generatedArtifacts: [docArtifact(sessionId, 'doc-a', 'Doc A')],
    });
    await waitForUi(window, 40);

    const panel = doc.getElementById('artifactReviewPanel');
    assert.equal(panel.classList.contains('hidden'), false, 'split panel should be visible (persisted enabled prefs)');
    assert.ok(panel.querySelector('.artifact-panel-header'), 'V3 chrome installed');

    doc.getElementById('artifactReviewDeleteButton').click();
    await waitForUi(window, 10);
    const modal = doc.querySelector('[data-step-modal="artifact-panel-confirm-delete"]');
    assert.ok(modal, 'split toolbar Delete must also gate on confirm');
    modal.querySelector('[data-step-modal-action="confirm"]').click();
    await waitForUi(window, 40);

    const emptyEl = doc.getElementById('artifactReviewDetailEmpty');
    assert.equal(emptyEl.classList.contains('hidden'), false, 'artifact empty state ("Select an artifact") must show once the only artifact is deleted');
    assert.match(emptyEl.textContent, /Select an artifact/);
    assert.equal(doc.getElementById('artifactReviewDetailPanel').classList.contains('hidden'), true, 'detail body must not stay stuck rendering the deleted artifact');
  } finally {
    await app.dispose();
  }
});

// UIUX-007: the delete-confirm dialog used to name the artifact selected at
// OPEN time but the manager wiring called deleteSelectedArtifact() with no
// argument -- it deleted whatever was selected at CONFIRM time. If the
// selection moved between open() and the Confirm click, the modal named A
// but deleted B. renderer-artifact-delete-confirm.js:84-101 now captures an
// immutable {id, sessionId, generation} token at open() and threads it
// through performDelete -> deleteSelectedArtifact(token), so the confirmed
// target is always what gets deleted, and a since-selected different
// artifact is left alone (renderer-artifacts-utils.js:301-305 wiring).
test('Confirm delete names A; if selection moves to B before Confirm is clicked, A is deleted and B is left untouched', async () => {
  const { app, deleteCalls, sessionId } = await makeApp({
    artifactReviewPreferences: { enabled: true, collapsed: false, width: 460 },
    shellOverrides: {
      features: { state: { featureFlags: { artifact_panel_v2: true } } },
    },
  });
  const { window, shell } = app;
  const doc = window.document;
  try {
    stubWorkspaceLayout(doc, 1600);
    doc.getElementById('chatInput').value = 'start';
    doc.getElementById('chatInput').dispatchEvent(new window.Event('input', { bubbles: true }));
    doc.getElementById('sendButton').click();
    await waitForUi(window, 20);
    await seedTwoArtifacts(shell, sessionId);
    await waitForUi(window, 40);

    const idA = `artifact_file_${sessionId}_doc-a`;
    const idB = `artifact_file_${sessionId}_doc-b`;

    // Selection moves through the transcript artifact cards' primary 'panel'
    // action (W1-5: the panel is the sole surface, so this is the real
    // user-facing selection path).
    const clickCardPanelAction = (artifactId) => {
      const btn = doc.querySelector(`[data-inv-artifact-action="panel"][data-artifact-id="${artifactId}"]`);
      assert.ok(btn, `expected the transcript panel action for ${artifactId}`);
      btn.click();
    };
    if (doc.getElementById('artifactReviewDetailTitle').textContent.trim() !== 'Doc A') {
      clickCardPanelAction(idA);
      await waitForUi(window, 20);
    }
    assert.equal(doc.getElementById('artifactReviewDetailTitle').textContent.trim(), 'Doc A');

    doc.getElementById('artifactReviewDeleteButton').click();
    await waitForUi(window, 10);
    const modal = doc.querySelector('[data-step-modal="artifact-panel-confirm-delete"]');
    assert.ok(modal, 'expected the confirm dialog to open naming A');
    assert.match(modal.textContent, /doc-a\.md/);

    // Selection moves to B while the dialog for A is still open (the audit's
    // exact race -- see UI_UX_COMPREHENSIVE_AUDIT_2026-07-12.md UIUX-007 and
    // the far-edge-case matrix row "Confirm delete A, select/auto-open B,
    // then confirm").
    clickCardPanelAction(idB);
    await waitForUi(window, 20);
    assert.equal(doc.getElementById('artifactReviewDetailTitle').textContent.trim(), 'Doc B', 'B must now be the live selection');

    modal.querySelector('[data-step-modal-action="confirm"]').click();
    await waitForUi(window, 40);

    assert.equal(deleteCalls.length, 1, 'exactly one delete IPC call');
    assert.equal(deleteCalls[0].artifactId, idA, 'the CONFIRMED target (A) must be deleted, never the since-selected B');

    // B must still be the live, untouched selection -- not cleared, not
    // reloaded, not replaced by A's now-deleted state.
    assert.equal(doc.getElementById('artifactReviewDetailTitle').textContent.trim(), 'Doc B', 'deleting A must not disturb B\'s live selection');
    assert.equal(doc.getElementById('artifactReviewDetailPanel').classList.contains('hidden'), false, 'B\'s detail body must remain visible');
  } finally {
    await app.dispose();
  }
});
