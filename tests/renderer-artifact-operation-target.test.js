'use strict';

// UIUX-007: unit tests for the immutable-target/generation primitive that
// every artifact read/save/delete/editor-setup operation is supposed to
// carry through its async completion. This module did not exist before the
// remediation -- these tests document and lock the contract described in
// UI_UX_COMPREHENSIVE_AUDIT_2026-07-12.md's UIUX-007 fix contract: "every
// read/save/delete/editor-setup operation carries an immutable {sessionId,
// artifactId, generation} captured at initiation; post-await completions are
// rejected when stale... Disposal invalidates all tokens."

const test = require('node:test');
const assert = require('node:assert/strict');
const { createArtifactOperationTarget } = require('../renderer/features/renderer-artifact-operation-target');

function makeState(overrides = {}) {
  return { artifacts: { selectedSessionId: '', selectedArtifactId: '', ...overrides } };
}

test('capture() reflects the identity and generation at the moment it is called', () => {
  const state = makeState({ selectedSessionId: 's1', selectedArtifactId: 'a1' });
  const target = createArtifactOperationTarget({ state });
  const token = target.capture('s1', 'a1');
  assert.equal(token.sessionId, 's1');
  assert.equal(token.id, 'a1');
  assert.equal(token.generation, 0);
  assert.ok(Object.isFrozen(token), 'captured tokens must be immutable');
});

test('setSelection bumps the generation even when reselecting the identical target', () => {
  const state = makeState();
  const target = createArtifactOperationTarget({ state });
  target.setSelection('s1', 'a1');
  const g1 = target.currentGeneration();
  target.setSelection('s1', 'a1');
  const g2 = target.currentGeneration();
  assert.ok(g2 > g1, 'every setSelection call must bump generation, even a no-op reselect');
});

test('isCurrent: true immediately after capture, false after ANY later selection change', () => {
  const state = makeState();
  const target = createArtifactOperationTarget({ state });
  target.setSelection('s1', 'a1');
  const token = target.capture('s1', 'a1');
  assert.equal(target.isCurrent(token), true);
  target.setSelection('s1', 'b1'); // selection moves to a different artifact
  assert.equal(target.isCurrent(token), false, 'a stale token must be rejected after selection changes');
});

test('isCurrent: false even if the SAME target is reselected after an intervening change', () => {
  const state = makeState();
  const target = createArtifactOperationTarget({ state });
  target.setSelection('s1', 'a1');
  const token = target.capture('s1', 'a1');
  target.setSelection('s1', 'b1');
  target.setSelection('s1', 'a1'); // back to A, but this is a NEW operation generation
  assert.equal(target.isCurrent(token), false, 'reselecting the same artifact still invalidates an earlier token');
});

test('matchesSelection: identity-only check, independent of generation bumps', () => {
  const state = makeState();
  const target = createArtifactOperationTarget({ state });
  target.setSelection('s1', 'a1');
  const token = target.capture('s1', 'a1');
  // An unrelated generation bump (e.g. a clearSelection/reselect cycle that
  // lands back on the same target) must not break "is this still selected".
  target.setSelection('s1', 'z9');
  target.setSelection('s1', 'a1');
  assert.equal(target.matchesSelection(token), true, 'matchesSelection compares identity, not generation');
  target.setSelection('s1', 'b1');
  assert.equal(target.matchesSelection(token), false);
});

test('captureSelected() captures whatever is currently selected in state', () => {
  const state = makeState({ selectedSessionId: 's9', selectedArtifactId: 'a9' });
  const target = createArtifactOperationTarget({ state });
  const token = target.captureSelected();
  assert.equal(token.sessionId, 's9');
  assert.equal(token.id, 'a9');
});

test('dispose() invalidates every outstanding token forever, even ones captured after dispose', () => {
  const state = makeState();
  const target = createArtifactOperationTarget({ state });
  target.setSelection('s1', 'a1');
  const beforeDisposeToken = target.capture('s1', 'a1');
  assert.equal(target.isCurrent(beforeDisposeToken), true);
  target.dispose();
  assert.equal(target.isCurrent(beforeDisposeToken), false, 'disposal must invalidate a token captured before it');
  assert.equal(target.isDisposed(), true);
  const afterDisposeToken = target.capture('s1', 'a1');
  assert.equal(target.isCurrent(afterDisposeToken), false, 'a token captured AFTER disposal must never read as current');
  assert.equal(target.matchesSelection(afterDisposeToken), false, 'matchesSelection must also refuse once disposed');
});

test('clearSelection() is equivalent to setSelection("", "") and bumps generation', () => {
  const state = makeState();
  const target = createArtifactOperationTarget({ state });
  target.setSelection('s1', 'a1');
  const token = target.capture('s1', 'a1');
  target.clearSelection();
  assert.equal(state.artifacts.selectedSessionId, '');
  assert.equal(state.artifacts.selectedArtifactId, '');
  assert.equal(target.isCurrent(token), false);
});
