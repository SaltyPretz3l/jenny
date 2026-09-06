const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  cleanupTrackedResources,
  trackDirectory,
} = require('../helpers/resource-cleanup');
const { createManagedService } = require('../helpers/managed-sidecar-runtime-helpers');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

test('managed sidecar status and session preferences normalize reasoning effort by supported engine', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-reasoning-support-'));
  trackDirectory(userDataPath);

  const service = createManagedService(userDataPath);
  await service.start();

  let status = await service.refreshStatusSnapshot();
  assert.equal(status.reasoning_effort_support, 'unsupported');

  const created = await service.createSession({
    title: 'Reasoning Support Session',
    preferences: {
      // qwen3.8 is the Ollama family that accepts a graded level (CMP-AI-0005 self-heals others).
      preferred_model: 'qwen3.8:9b',
      reasoning_effort: 'high',
    },
  });
  assert.equal(created.data.reasoning_effort, 'high');

  await service.setSessionPreferences(created.data.id, {
    preferred_model: 'llama3.2',
    reasoning_effort: 'high',
  });

  const sessions = await service.listSessions();
  const managedSession = sessions.data.find((session) => session.id === created.data.id);
  assert.ok(managedSession);
  assert.equal(managedSession.reasoning_effort, 'default');

  await service.loadModel('qwen3.8:9b');
  status = await service.refreshStatusSnapshot();
  assert.equal(status.reasoning_effort_support, 'supported');
  assert.equal(status.active_model_capabilities.thinking, true);
  assert.equal(status.active_model_reasoning_support, 'supported');

  await service.setSessionPreferences(created.data.id, {
    preferred_model: 'qwen3.8:9b',
    reasoning_effort: 'xhigh',
  });
  const sessionsAfterXhigh = await service.listSessions();
  const xhighSession = sessionsAfterXhigh.data.find((session) => session.id === created.data.id);
  assert.ok(xhighSession);
  assert.equal(xhighSession.reasoning_effort, 'xhigh');

  await service.loadModel('llama3.2');
  status = await service.refreshStatusSnapshot();
  assert.equal(status.reasoning_effort_support, 'unsupported');
  assert.equal(Boolean(status.active_model_capabilities.thinking), false);

  await service.stop();
});
