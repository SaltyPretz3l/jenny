const os = require('os');
const path = require('path');
const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert/strict');

const { SessionShadowStore } = require('../services/backend/session-shadow-store');
const {
  cleanupTrackedResources,
  trackDirectory,
} = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

test('shadow store setSessionPreferences with sparse input preserves unmentioned fields', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-userdata-shadow-sparse-'));
  trackDirectory(userDataPath);

  const store = new SessionShadowStore(path.join(userDataPath, 'shadow.json'));
  store.upsertSession('sess_shadow_sparse', { title: 'Sparse preferences' });

  store.setSessionPreferences('sess_shadow_sparse', {
    preferred_model: 'gemma12b',
    reasoning_effort: 'high',
    conversation_mode: 'interactive',
  });

  store.setSessionPreferences('sess_shadow_sparse', {
    conversation_mode: 'interactive',
    pending_question_batch: null,
    interactive_sequence_state: 'idle',
    interactive_round_count: 0,
  });

  const session = store.getSession('sess_shadow_sparse');
  assert.equal(session.preferred_model, 'gemma12b');
  assert.equal(session.reasoning_effort, 'high');
});
