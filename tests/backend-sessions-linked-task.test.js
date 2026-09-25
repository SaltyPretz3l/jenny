const test = require('node:test');
const assert = require('node:assert/strict');

const { createSession } = require('../services/backend/backend-sessions');
const {
  initializeApplicationProjects,
} = require('../services/projects/application-project-scope');
const {
  cleanupTrackedResources,
  createTrackedTempDir,
} = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function buildService(calls) {
  const service = {
    _emitServiceLog() {},
    sessionStore: {
      createSession(args) {
        calls.push(args);
        return { id: `session-${calls.length}` };
      },
    },
  };
  initializeApplicationProjects(service, {
    userDataPath: createTrackedTempDir('jenny-session-linked-task-'),
  });
  return service;
}

test('backend session creation forwards a normalized linked task id', async () => {
  const calls = [];
  const result = await createSession(buildService(calls), {
    title: 'Linked task',
    linkedTaskId: ' task.WO-10c:1 ',
  });

  assert.equal(result.data.id, 'session-1');
  assert.equal(calls[0].linkedTaskId, 'task.WO-10c:1');
});

test('backend session creation drops a non-string linked task id without throwing', async () => {
  const calls = [];

  await createSession(buildService(calls), { linkedTaskId: 123 });

  assert.equal(Object.hasOwn(calls[0], 'linkedTaskId'), false);
});
