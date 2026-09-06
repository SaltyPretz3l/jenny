const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  cleanupTrackedResources,
  trackDirectory,
} = require('./helpers/resource-cleanup');
const {
  createManagedService,
} = require('./helpers/managed-sidecar-runtime-helpers');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

test('managed sidecar runtime persists session context preferences across restart', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-context-prefs-'));
  trackDirectory(userDataPath);

  const service = createManagedService(userDataPath);
  const created = await service.createSession({
    title: 'Context Preferences Session',
    preferences: {
      context_preferences: {
        history_scope: 'recent',
        include_personality: false,
        include_memory: false,
      },
    },
  });

  const listed = await service.listSessions();
  const createdSummary = listed.data.find((session) => session.id === created.data.id);
  assert.ok(createdSummary);
  assert.deepEqual(createdSummary.context_preferences, {
    history_scope: 'recent',
    include_personality: false,
    include_memory: false,
    include_git_context: true,
    include_codebase_context: true,
    include_active_file_context: true,
  });

  await service.stop();

  const restarted = createManagedService(userDataPath);
  const restartedSessions = await restarted.listSessions();
  const restartedSummary = restartedSessions.data.find((session) => session.id === created.data.id);
  assert.ok(restartedSummary);
  assert.deepEqual(restartedSummary.context_preferences, {
    history_scope: 'recent',
    include_personality: false,
    include_memory: false,
    include_git_context: true,
    include_codebase_context: true,
    include_active_file_context: true,
  });
});
