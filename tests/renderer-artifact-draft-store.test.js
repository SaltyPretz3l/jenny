'use strict';

// UIUX-007: unit tests for the per-artifact dirty-draft preservation store.
// This is the "defer, don't discard" half of the fix contract: navigating
// away from a dirty artifact must not silently lose the edit (my task
// instructions explicitly allow "prompt OR defer" for the navigation gate).
// This module did not exist before the remediation.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createArtifactDraftStore } = require('../renderer/features/renderer-artifact-draft-store');

test('stash then take restores the exact value once, then it is gone', () => {
  const store = createArtifactDraftStore();
  assert.equal(store.has('s1', 'a1'), false);
  store.stash('s1', 'a1', 'edited content');
  assert.equal(store.has('s1', 'a1'), true);
  assert.equal(store.take('s1', 'a1'), 'edited content');
  assert.equal(store.has('s1', 'a1'), false, 'take() is single-use');
  assert.equal(store.take('s1', 'a1'), null, 'a second take on an empty slot returns null, not the stale value');
});

test('drafts are keyed by BOTH sessionId and artifactId -- no cross-session bleed', () => {
  const store = createArtifactDraftStore();
  store.stash('s1', 'a1', 'session-1 draft');
  store.stash('s2', 'a1', 'session-2 draft');
  assert.equal(store.take('s1', 'a1'), 'session-1 draft');
  assert.equal(store.take('s2', 'a1'), 'session-2 draft', 'same artifact id in a different session must not collide');
});

test('discard() removes a draft without returning it (used by explicit Revert)', () => {
  const store = createArtifactDraftStore();
  store.stash('s1', 'a1', 'edited content');
  assert.equal(store.discard('s1', 'a1'), true);
  assert.equal(store.has('s1', 'a1'), false);
});

test('pruneToAllowedSessions drops drafts for sessions no longer allowed', () => {
  const store = createArtifactDraftStore();
  store.stash('s1', 'a1', 'x');
  store.stash('s2', 'a1', 'y');
  store.stash('s3', 'a1', 'z');
  store.pruneToAllowedSessions(['s1', 's3']);
  assert.equal(store.has('s1', 'a1'), true);
  assert.equal(store.has('s2', 'a1'), false);
  assert.equal(store.has('s3', 'a1'), true);
});

test('stashing an empty/missing sessionId or artifactId is a safe no-op', () => {
  const store = createArtifactDraftStore();
  assert.equal(store.stash('', 'a1', 'x'), false);
  assert.equal(store.stash('s1', '', 'x'), false);
  assert.equal(store.size(), 0);
});

test('re-stashing the same target overwrites the previous draft (no stale accumulation)', () => {
  const store = createArtifactDraftStore();
  store.stash('s1', 'a1', 'first edit');
  store.stash('s1', 'a1', 'second edit');
  assert.equal(store.size(), 1);
  assert.equal(store.take('s1', 'a1'), 'second edit');
});
